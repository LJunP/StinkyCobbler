import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import process from "node:process";
import path from "node:path";
import { ExitCode, StinkyCobblerError } from "../errors.js";
import type { LocalWorkspace } from "./workspace.js";
import { workspaceFile } from "./workspace.js";

const LOCK_DIRECTORY = "workspace.lock";
const OWNER_FILE = "owner.json";
const LOCK_VERSION = 1;
const DEFAULT_WAIT_MS = 10_000;
const DEFAULT_POLL_MS = 25;
const COMPATIBILITY_STALE_MS = 60_000;

interface LockOwner {
  version: 1;
  token: string;
  pid: number;
  createdAt: string;
  heartbeatAt: string;
}

interface LockHolder {
  readonly token: string;
  readonly generation: number;
  readonly inFlight: Set<Promise<unknown>>;
}

interface LockBinding {
  readonly token: string;
  readonly generation: number;
  readonly holder: LockHolder;
}

interface LockOwnershipFrame {
  readonly bindings: ReadonlyMap<string, LockBinding>;
  open: boolean;
  activeChild: Promise<unknown> | undefined;
  childFailed: boolean;
  childFailure: unknown;
}

export interface WorkspaceLockOptions {
  waitMs?: number;
  pollMs?: number;
  /** Reserved for API compatibility; 2.0.1 never automatically reclaims an existing lock. */
  staleMs?: number;
}

const contexts = new Map<string, LockHolder>();
const queues = new Map<string, Promise<void>>();
const ownership = new AsyncLocalStorage<LockOwnershipFrame>();
let generationCounter = 0;

export function withWorkspaceLock<T>(workspace: LocalWorkspace, operation: () => Promise<T>, options: WorkspaceLockOptions = {}): Promise<T> {
  const key = workspace.directory;
  const frame = ownership.getStore();
  if (frame !== undefined) {
    try {
      assertFrameCurrent(frame, workspace);
      if (frame.activeChild !== undefined) throw concurrentReentry(workspace);
      if (frame.bindings.has(key)) {
        return startChild(frame, () => runInFrame(frame.bindings, operation));
      }
      assertLockOrder(frame, key, workspace);
      return startChild(frame, () => enqueueAndAcquire(workspace, key, operation, options, frame.bindings));
    } catch (error: unknown) {
      return Promise.reject(error);
    }
  }

  return enqueueAndAcquire(workspace, key, operation, options, new Map());
}

async function enqueueAndAcquire<T>(workspace: LocalWorkspace, key: string, operation: () => Promise<T>, options: WorkspaceLockOptions, inheritedBindings: ReadonlyMap<string, LockBinding>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  let releaseQueue!: () => void;
  const queued = new Promise<void>((resolve) => { releaseQueue = resolve; });
  const current = previous.then(() => queued);
  queues.set(key, current);
  await previous.catch(() => undefined);
  try {
    return await acquireAndRun(workspace, key, operation, options, inheritedBindings);
  } finally {
    releaseQueue();
    if (queues.get(key) === current) queues.delete(key);
  }
}

async function acquireAndRun<T>(workspace: LocalWorkspace, key: string, operation: () => Promise<T>, options: WorkspaceLockOptions, inheritedBindings: ReadonlyMap<string, LockBinding>): Promise<T> {
  const lockPath = await workspaceFile(workspace, LOCK_DIRECTORY);
  const ownerPath = path.join(lockPath, OWNER_FILE);
  const waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const staleMs = options.staleMs ?? COMPATIBILITY_STALE_MS;
  assertPositiveInteger(waitMs, "waitMs");
  assertPositiveInteger(pollMs, "pollMs");
  assertPositiveInteger(staleMs, "staleMs");
  const started = Date.now();
  let holder: LockHolder | undefined;

  while (holder === undefined) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      const token = randomUUID();
      const now = new Date().toISOString();
      const owner: LockOwner = { version: LOCK_VERSION, token, pid: process.pid, createdAt: now, heartbeatAt: now };
      // Publishing an ownerless directory is intentionally fail-closed. If
      // owner creation fails, leave the directory in place for explicit
      // diagnosis instead of risking deletion of a newer holder at the same
      // path after a concurrent rename/replacement.
      await writeOwner(ownerPath, owner);
      const generation = allocateGeneration();
      holder = { token, generation, inFlight: new Set() };
      contexts.set(key, holder);
    } catch (error: unknown) {
      if (!isCode(error, "EEXIST")) throw error;
      if (Date.now() - started >= waitMs) throw lockBusy(workspace, waitMs);
      await delay(pollMs);
    }
  }

  try {
    assertBindingsCurrent(inheritedBindings, workspace);
    const bindings = new Map(inheritedBindings);
    bindings.set(key, { token: holder.token, generation: holder.generation, holder });
    return await runInFrame(bindings, operation);
  } finally {
    await drainHolder(holder);
    const current = contexts.get(key);
    if (current === holder && current.token === holder.token && current.generation === holder.generation) {
      contexts.delete(key);
      const owner = await readOwner(ownerPath).catch(() => undefined);
      if (owner?.token === holder.token) await rm(lockPath, { recursive: true, force: true });
    }
  }
}

async function runInFrame<T>(bindings: ReadonlyMap<string, LockBinding>, operation: () => Promise<T>): Promise<T> {
  const frame: LockOwnershipFrame = { bindings, open: true, activeChild: undefined, childFailed: false, childFailure: undefined };
  let operationSucceeded = false;
  let result: T | undefined;
  let operationFailure: unknown;
  try {
    result = await ownership.run(frame, operation);
    operationSucceeded = true;
  } catch (error: unknown) {
    operationFailure = error;
  } finally {
    frame.open = false;
    const activeChild = frame.activeChild;
    if (activeChild !== undefined) await Promise.allSettled([activeChild]);
  }
  if (!operationSucceeded) throw operationFailure;
  if (frame.childFailed) throw frame.childFailure;
  return result as T;
}

function startChild<T>(parent: LockOwnershipFrame, operation: () => Promise<T>): Promise<T> {
  const child = operation();
  parent.activeChild = child;
  void child.then(
    () => { if (parent.activeChild === child) parent.activeChild = undefined; },
    (error: unknown) => {
      if (!parent.childFailed) {
        parent.childFailed = true;
        parent.childFailure = error;
      }
      if (parent.activeChild === child) parent.activeChild = undefined;
    }
  );
  trackInFlight(parent.bindings, child);
  return child;
}

function trackInFlight(bindings: ReadonlyMap<string, LockBinding>, operation: Promise<unknown>): void {
  const holders = new Set(Array.from(bindings.values(), (binding) => binding.holder));
  for (const holder of holders) holder.inFlight.add(operation);
  void operation.then(
    () => { for (const holder of holders) holder.inFlight.delete(operation); },
    () => { for (const holder of holders) holder.inFlight.delete(operation); }
  );
}

async function drainHolder(holder: LockHolder): Promise<void> {
  while (holder.inFlight.size > 0) {
    await Promise.allSettled([...holder.inFlight]);
  }
}

function assertFrameCurrent(frame: LockOwnershipFrame, workspace: LocalWorkspace): void {
  if (!frame.open) throw staleContext(workspace, "frame_closed");
  assertBindingsCurrent(frame.bindings, workspace);
  if (frame.childFailed) throw frame.childFailure;
}

function assertBindingsCurrent(bindings: ReadonlyMap<string, LockBinding>, workspace: LocalWorkspace): void {
  for (const [key, binding] of bindings) {
    const current = contexts.get(key);
    if (current !== binding.holder || current.token !== binding.token || current.generation !== binding.generation) {
      throw staleContext(workspace, "holder_generation_changed", key);
    }
  }
}

function assertLockOrder(frame: LockOwnershipFrame, key: string, workspace: LocalWorkspace): void {
  const highestHeldKey = [...frame.bindings.keys()].sort(compareLockKeys).at(-1);
  if (highestHeldKey !== undefined && compareLockKeys(key, highestHeldKey) < 0) {
    throw lockOrderViolation(workspace, highestHeldKey);
  }
}

function compareLockKeys(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function allocateGeneration(): number {
  generationCounter = generationCounter === Number.MAX_SAFE_INTEGER ? 1 : generationCounter + 1;
  return generationCounter;
}

async function writeOwner(file: string, owner: LockOwner): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}
async function readOwner(ownerPath: string): Promise<LockOwner | undefined> {
  try {
    const value = JSON.parse(await readFile(ownerPath, "utf8")) as Partial<LockOwner>;
    const allowed = new Set(["version", "token", "pid", "createdAt", "heartbeatAt"]);
    if (Object.keys(value).some((key) => !allowed.has(key))) return undefined;
    if (value.version !== LOCK_VERSION || typeof value.token !== "string" || value.token.length === 0 || typeof value.pid !== "number" || !Number.isSafeInteger(value.pid) || value.pid <= 0 || !isCanonicalIso(value.heartbeatAt) || !isCanonicalIso(value.createdAt)) return undefined;
    return value as LockOwner;
  } catch { return undefined; }
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new StinkyCobblerError("WORKSPACE_LOCK_OPTION_INVALID", ExitCode.VALIDATION, `${name} must be a positive integer.`, { name, value });
}

function isCanonicalIso(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function lockBusy(workspace: LocalWorkspace, waitMs: number): StinkyCobblerError {
  return new StinkyCobblerError("WORKSPACE_LOCK_BUSY", ExitCode.POLICY_DENIED, "Workspace control-plane lock is busy.", { waitMs, directory: path.basename(workspace.directory) });
}
function concurrentReentry(workspace: LocalWorkspace): StinkyCobblerError {
  return new StinkyCobblerError("WORKSPACE_LOCK_CONCURRENT_REENTRY", ExitCode.POLICY_DENIED, "Concurrent sibling reentry into the same workspace lock is forbidden.", { directory: path.basename(workspace.directory) });
}
function staleContext(workspace: LocalWorkspace, reason: string, boundKey?: string): StinkyCobblerError {
  const details: Record<string, unknown> = { directory: path.basename(workspace.directory), reason };
  if (boundKey !== undefined) details.boundWorkspace = path.basename(path.dirname(boundKey));
  return new StinkyCobblerError("WORKSPACE_LOCK_STALE_CONTEXT", ExitCode.POLICY_DENIED, "Workspace lock ownership context is closed or no longer owns the current lock generation.", details);
}
function lockOrderViolation(workspace: LocalWorkspace, highestHeldKey: string): StinkyCobblerError {
  return new StinkyCobblerError("WORKSPACE_LOCK_ORDER_VIOLATION", ExitCode.POLICY_DENIED, "Nested workspace locks must be acquired in stable ascending workspace order.", {
    requestedWorkspace: path.basename(workspace.root),
    highestHeldWorkspace: path.basename(path.dirname(highestHeldKey))
  });
}
function isCode(error: unknown, code: string): boolean { return typeof error === "object" && error !== null && "code" in error && error.code === code; }
function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
