import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir, open, readFile, rename, rm, lstat } from "node:fs/promises";
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
const DEFAULT_STALE_MS = 60_000;

interface LockOwner {
  version: 1;
  token: string;
  pid: number;
  createdAt: string;
  heartbeatAt: string;
}

export interface WorkspaceLockOptions {
  waitMs?: number;
  pollMs?: number;
  staleMs?: number;
}

const contexts = new Map<string, { token: string; depth: number }>();
const queues = new Map<string, Promise<void>>();
const ownership = new AsyncLocalStorage<Set<string>>();

export async function withWorkspaceLock<T>(workspace: LocalWorkspace, operation: () => Promise<T>, options: WorkspaceLockOptions = {}): Promise<T> {
  const key = workspace.directory;
  const owned = ownership.getStore();
  const existing = contexts.get(key);
  if (existing && owned?.has(key)) {
    existing.depth += 1;
    try { return await operation(); }
    finally { existing.depth -= 1; }
  }

  const previous = queues.get(key) ?? Promise.resolve();
  let releaseQueue!: () => void;
  const queued = new Promise<void>((resolve) => { releaseQueue = resolve; });
  const current = previous.then(() => queued);
  queues.set(key, current);
  await previous.catch(() => undefined);
  try {
    return await acquireAndRun(workspace, key, operation, options);
  } finally {
    releaseQueue();
    if (queues.get(key) === current) queues.delete(key);
  }
}

async function acquireAndRun<T>(workspace: LocalWorkspace, key: string, operation: () => Promise<T>, options: WorkspaceLockOptions): Promise<T> {
  const lockPath = await workspaceFile(workspace, LOCK_DIRECTORY);
  const ownerPath = path.join(lockPath, OWNER_FILE);
  const waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  assertPositiveInteger(waitMs, "waitMs");
  assertPositiveInteger(pollMs, "pollMs");
  assertPositiveInteger(staleMs, "staleMs");
  const started = Date.now();
  let token: string | undefined;

  while (token === undefined) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      token = randomUUID();
      const now = new Date().toISOString();
      const owner: LockOwner = { version: LOCK_VERSION, token, pid: process.pid, createdAt: now, heartbeatAt: now };
      try {
        await writeOwner(ownerPath, owner);
      } catch (error: unknown) {
        await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
      contexts.set(key, { token, depth: 1 });
    } catch (error: unknown) {
      if (!isCode(error, "EEXIST")) throw error;
      if (Date.now() - started >= waitMs) {
        if (await reclaimStaleLock(workspace, lockPath, ownerPath, staleMs)) {
          continue;
        }
        throw lockBusy(workspace, waitMs);
      }
      await delay(pollMs);
    }
  }

  try {
    return await ownership.run(new Set([key]), operation);
  } finally {
    const current = contexts.get(key);
    contexts.delete(key);
    if (current?.token === token) {
      const owner = await readOwner(ownerPath).catch(() => undefined);
      if (owner?.token === token) await rm(lockPath, { recursive: true, force: true });
    }
  }
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
async function reclaimStaleLock(workspace: LocalWorkspace, lockPath: string, ownerPath: string, staleMs: number): Promise<boolean> {
  const owner = await readOwner(ownerPath);
  if (owner !== undefined) {
    if (!isStaleOwner(owner, staleMs)) return false;
  } else if (!(await isOwnerlessLockStale(lockPath, ownerPath, staleMs))) {
    return false;
  }
  const quarantine = await workspaceFile(workspace, `${LOCK_DIRECTORY}.reclaim-${randomUUID()}`);
  try {
    await rename(lockPath, quarantine);
  } catch (error: unknown) {
    return false;
  }
  const quarantinedOwner = await readOwner(path.join(quarantine, OWNER_FILE));
  if (owner !== undefined && quarantinedOwner?.token !== owner.token) {
    await rm(quarantine, { recursive: true, force: true }).catch(() => undefined);
    return false;
  }
  if (owner === undefined && quarantinedOwner !== undefined) {
    await rm(quarantine, { recursive: true, force: true }).catch(() => undefined);
    return false;
  }
  await rm(quarantine, { recursive: true, force: true });
  return true;
}

async function isOwnerlessLockStale(lockPath: string, ownerPath: string, staleMs: number): Promise<boolean> {
  try {
    await lstat(ownerPath);
    return false;
  } catch (error: unknown) {
    if (!isCode(error, "ENOENT")) return false;
  }
  try {
    const stat = await lstat(lockPath);
    return stat.isDirectory() && Date.now() - stat.mtimeMs >= staleMs;
  } catch {
    return false;
  }
}

function isStaleOwner(owner: LockOwner, staleMs: number): boolean {
  if (owner.pid === process.pid) return false;
  const heartbeat = Date.parse(owner.heartbeatAt);
  if (!Number.isFinite(heartbeat) || Date.now() - heartbeat < staleMs) return false;
  try { process.kill(owner.pid, 0); return false; }
  catch (error: unknown) { return isCode(error, "ESRCH"); }
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
function isCode(error: unknown, code: string): boolean { return typeof error === "object" && error !== null && "code" in error && error.code === code; }
function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
