import { mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { defaultSchemaRegistry } from "../contracts/default-schema-registry.js";
import type { AgentRun, RuntimeBudgetUsage } from "../contracts/types.js";
import { ExitCode, StinkyCobblerError } from "../errors.js";
import type { LocalWorkspace } from "./workspace.js";
import { createWorkspaceJson, workspaceFile, writeWorkspaceJson } from "./workspace.js";
import { appendLedgerEntry, listLedgerEntries, prepareLedgerEntry, type AppendLedgerEntry, type LedgerEntry } from "./ledger.js";
import { withWorkspaceLock } from "./workspace-lock.js";

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DIRECTORY = "runs";
const DEFAULT_STALE_RUN_MS = 60 * 60 * 1000;
export const TERMINAL_RUN_STATUSES = ["COMPLETED", "BLOCKED", "FAILED", "TIMED_OUT", "CANCELLED"] as const;
const TERMINAL_STATUSES = new Set<AgentRun["status"]>(TERMINAL_RUN_STATUSES);
const RUN_STATUSES: readonly AgentRun["status"][] = ["CREATED", "ADMITTED", "RUNNING", ...TERMINAL_RUN_STATUSES];
const ALLOWED_TRANSITIONS: Record<AgentRun["status"], readonly AgentRun["status"][]> = {
  CREATED: ["CREATED", "ADMITTED", "RUNNING", "BLOCKED", "FAILED", "TIMED_OUT", "CANCELLED"],
  ADMITTED: ["ADMITTED", "RUNNING", "BLOCKED", "FAILED", "TIMED_OUT", "CANCELLED"],
  RUNNING: ["RUNNING", "COMPLETED", "BLOCKED", "FAILED", "TIMED_OUT", "CANCELLED"],
  COMPLETED: ["COMPLETED"],
  BLOCKED: ["BLOCKED"],
  FAILED: ["FAILED"],
  TIMED_OUT: ["TIMED_OUT"],
  CANCELLED: ["CANCELLED"]
};
export type RunLifecycleFaultPoint = "after-run" | "after-ledger";
const runLifecycleFaults = new Map<string, RunLifecycleFaultPoint>();

export interface RunStaleness {
  stale: boolean;
  status: AgentRun["status"];
  observedAt: string;
  referenceAt?: string;
  ageMs?: number;
  staleMs: number;
}

export interface RecoverStaleRunOptions {
  staleMs?: number;
  now?: Date;
}

export async function createRun(workspace: LocalWorkspace, run: AgentRun): Promise<void> {
  assertValidRun(run);
  await withWorkspaceLock(workspace, async () => {
    await ensureDirectory(workspace);
    const effect = runCreatedEffect(run);
    try {
      await createWorkspaceJson(workspace, fileName(run.runId), run);
    } catch (error: unknown) {
      if (!isCode(error, "EEXIST")) throw error;
      const existing = await readStoredRun(workspace, run.runId);
      if (JSON.stringify(existing) !== JSON.stringify(run)) {
        throw runtimeError("RUNTIME_RUN_EXISTS", "Agent run already exists with different content.", { runId: run.runId });
      }
      await ensureRunLifecycleCommitted(workspace, existing);
      return;
    }
    maybeInjectRunLifecycleFault(workspace, "after-run", run.runId);
    await ensureRunLifecycleEvent(workspace, effect);
    maybeInjectRunLifecycleFault(workspace, "after-ledger", run.runId);
  });
}

export async function saveRun(workspace: LocalWorkspace, run: AgentRun): Promise<void> {
  assertValidRun(run);
  await withWorkspaceLock(workspace, async () => {
    await ensureDirectory(workspace);
    let current: AgentRun | undefined;
    try {
      current = await readStoredRun(workspace, run.runId);
    } catch (error: unknown) {
      if (!isCode(error, "RUNTIME_RUN_NOT_FOUND")) throw error;
    }
    if (current === undefined) {
      throw runtimeError("RUNTIME_RUN_NOT_FOUND", "Agent run does not exist; use createRun for new runs.", { runId: run.runId });
    }
    await ensureRunLifecycleCommitted(workspace, current);
    assertImmutableBindings(current, run);
    if (current.status !== run.status) {
      throw runtimeError("RUNTIME_RUN_TRANSITION_REQUIRED", "Agent run status changes must use transitionRun.", { runId: run.runId, from: current.status, requested: run.status });
    }
    if (TERMINAL_STATUSES.has(current.status) && JSON.stringify(current) !== JSON.stringify(run)) {
      throw runtimeError("RUNTIME_RUN_TERMINAL", "Terminal Agent runs cannot be overwritten.", { runId: run.runId, status: current.status });
    }
    await writeWorkspaceJson(workspace, fileName(run.runId), run);
  });
}

export interface RunTransitionOptions {
  ownerToken?: string;
  expectedStatus?: AgentRun["status"];
  expectedEpoch?: number;
}

export async function assertRunOwner(workspace: LocalWorkspace, runId: string, ownerToken: string, expectedEpoch?: number): Promise<AgentRun> {
  const run = await getRun(workspace, runId);
  assertOwner(run, ownerToken, expectedEpoch);
  if (TERMINAL_STATUSES.has(run.status)) throw runtimeError("RUNTIME_RUN_FENCED", "Agent run is terminal and no longer owned by the executor.", { runId, status: run.status });
  return run;
}
export async function transitionRun(workspace: LocalWorkspace, runId: string, to: AgentRun["status"], patch: Partial<Pick<AgentRun, "errorCode" | "blockedReason" | "finishedAt" | "budgetUsage" | "toolCalls" | "evidenceRefs" | "outputHash">> = {}, options: RunTransitionOptions = {}): Promise<AgentRun> {
  return withWorkspaceLock(workspace, async () => {
    assertRunId(runId);
    if (!RUN_STATUSES.includes(to)) throw runtimeError("RUNTIME_RUN_STATUS_INVALID", "Agent run status is invalid.", { runId, status: to });
    const current = await getRun(workspace, runId);
    await ensureRunLifecycleCommitted(workspace, current);
    if (options.expectedStatus !== undefined && current.status !== options.expectedStatus) {
      throw runtimeError("RUNTIME_RUN_CONFLICT", "Agent run status changed before transition.", { runId, expectedStatus: options.expectedStatus, actualStatus: current.status });
    }
    if (options.ownerToken !== undefined) assertOwner(current, options.ownerToken, options.expectedEpoch);
    else if (options.expectedEpoch !== undefined && current.fenceEpoch !== options.expectedEpoch) {
      throw runtimeError("RUNTIME_RUN_CONFLICT", "Agent run fence epoch changed before transition.", { runId, expectedEpoch: options.expectedEpoch, actualEpoch: current.fenceEpoch });
    }
    if (TERMINAL_STATUSES.has(current.status)) {
      if (current.status === to) return current;
      throw runtimeError("RUNTIME_RUN_TERMINAL", "Terminal Agent runs cannot be overwritten.", { runId, status: current.status, requested: to });
    }
    if (!ALLOWED_TRANSITIONS[current.status].includes(to)) {
      throw runtimeError("RUNTIME_RUN_TRANSITION_INVALID", "Agent run transition is not allowed.", { runId, from: current.status, requested: to });
    }
    const next = { ...current, ...patch, status: to };
    assertImmutableBindings(current, next);
    assertValidRun(next);
    const effect = runTransitionEffect(current.status, to, runId);
    await writeWorkspaceJson(workspace, fileName(runId), next);
    maybeInjectRunLifecycleFault(workspace, "after-run", runId);
    await ensureRunLifecycleEvent(workspace, effect);
    maybeInjectRunLifecycleFault(workspace, "after-ledger", runId);
    return next;
  });
}
export async function getRunStaleness(workspace: LocalWorkspace, runId: string, options: RecoverStaleRunOptions = {}): Promise<RunStaleness> {
  const run = await getRun(workspace, runId);
  return classifyRunStaleness(run, options);
}

export function classifyRunStaleness(run: AgentRun, options: RecoverStaleRunOptions = {}): RunStaleness {
  const staleMs = options.staleMs ?? DEFAULT_STALE_RUN_MS;
  if (!Number.isSafeInteger(staleMs) || staleMs <= 0) {
    throw runtimeError("RUNTIME_RUN_STALE_THRESHOLD_INVALID", "Run stale threshold must be a positive integer.", { staleMs });
  }
  const now = options.now ?? new Date();
  const observedAt = now.toISOString();
  if (TERMINAL_STATUSES.has(run.status)) return { stale: false, status: run.status, observedAt, staleMs };
  const reference = run.heartbeatAt ?? run.startedAt ?? run.createdAt;
  const parsed = Date.parse(reference);
  if (!Number.isFinite(parsed)) throw runtimeError("RUNTIME_RUN_INVALID", "Run timestamp is invalid.", { runId: run.runId, reference });
  const ageMs = now.getTime() - parsed;
  return { stale: ageMs >= staleMs && ageMs >= 0, status: run.status, observedAt, referenceAt: reference, ageMs, staleMs };
}

export interface HeartbeatRunOptions {
  ownerToken: string;
  expectedEpoch?: number;
  heartbeatAt?: string;
}

export interface CheckpointRunProgressOptions {
  ownerToken: string;
  expectedEpoch?: number;
}

/**
 * Persists append-only progress for an owned RUNNING Runtime execution.
 * This is not a lifecycle transition and emits no status ledger event.
 */
export async function checkpointRunProgress(
  workspace: LocalWorkspace,
  runId: string,
  progress: {
    toolCalls: NonNullable<AgentRun["toolCalls"]>;
    evidenceRefs: string[];
    budgetUsage: RuntimeBudgetUsage;
  },
  options: CheckpointRunProgressOptions
): Promise<AgentRun> {
  return withWorkspaceLock(workspace, async () => {
    const current = await getRun(workspace, runId);
    await ensureRunLifecycleCommitted(workspace, current);
    assertOwner(current, options.ownerToken, options.expectedEpoch);
    if (current.status !== "RUNNING") {
      throw runtimeError("RUNTIME_RUN_CHECKPOINT_INVALID", "Only a RUNNING Agent run may accept a progress checkpoint.", { runId, status: current.status });
    }
    const nextToolCalls = progress.toolCalls;
    const nextEvidenceRefs = progress.evidenceRefs;
    assertArrayPrefix(current.toolCalls ?? [], nextToolCalls, "toolCalls", runId);
    assertArrayPrefix(current.evidenceRefs ?? [], nextEvidenceRefs, "evidenceRefs", runId);
    assertBudgetProgress(current.budgetUsage ?? {}, progress.budgetUsage, runId);
    const next: AgentRun = {
      ...current,
      toolCalls: JSON.parse(JSON.stringify(nextToolCalls)) as NonNullable<AgentRun["toolCalls"]>,
      evidenceRefs: [...nextEvidenceRefs],
      budgetUsage: { ...progress.budgetUsage },
      heartbeatAt: new Date().toISOString()
    };
    assertValidRun(next);
    await writeWorkspaceJson(workspace, fileName(runId), next);
    return next;
  });
}

/**
 * Refreshes the liveness declaration of a RUNNING run inside the workspace
 * lock. Owner fencing still applies so a recovered run cannot be revived by
 * its old owner. Terminal runs are returned unchanged (idempotent). This
 * intentionally writes no ledger event: heartbeats are not lifecycle facts.
 */
export async function heartbeatRun(workspace: LocalWorkspace, runId: string, options: HeartbeatRunOptions): Promise<AgentRun> {
  return withWorkspaceLock(workspace, async () => {
    const current = await getRun(workspace, runId);
    await ensureRunLifecycleCommitted(workspace, current);
    if (TERMINAL_STATUSES.has(current.status)) return current;
    assertOwner(current, options.ownerToken, options.expectedEpoch);
    const next = { ...current, heartbeatAt: options.heartbeatAt ?? new Date().toISOString() };
    assertValidRun(next);
    await writeWorkspaceJson(workspace, fileName(runId), next);
    return next;
  });
}

export async function recoverStaleRun(workspace: LocalWorkspace, runId: string, options: RecoverStaleRunOptions = {}): Promise<AgentRun> {
  return withWorkspaceLock(workspace, async () => {
    const current = await getRun(workspace, runId);
    await ensureRunLifecycleCommitted(workspace, current);
    if (TERMINAL_STATUSES.has(current.status)) return current;
    if (current.status !== "RUNNING") {
      throw runtimeError("RUNTIME_RUN_RECOVERY_INVALID_STATUS", "Only RUNNING Agent runs may be recovered.", { runId, status: current.status });
    }
    const now = options.now ?? new Date();
    const stale = classifyRunStaleness(current, { ...options, now });
    if (!stale.stale) throw runtimeError("RUNTIME_RUN_NOT_STALE", "Agent run has not exceeded the stale threshold.", { runId, staleMs: stale.staleMs, ageMs: stale.ageMs ?? 0 });
    const recovered = { ...current, status: "FAILED" as const, fenceEpoch: (current.fenceEpoch ?? 0) + 1, errorCode: "RUNTIME_STALE_RECOVERY", blockedReason: "Run was explicitly recovered after exceeding the stale threshold.", finishedAt: now.toISOString() };
    const effect = runRecoveredEffect(current.status, recovered.status, runId);
    await writeWorkspaceJson(workspace, fileName(runId), recovered);
    maybeInjectRunLifecycleFault(workspace, "after-run", runId);
    await ensureRunLifecycleEvent(workspace, effect);
    maybeInjectRunLifecycleFault(workspace, "after-ledger", runId);
    return recovered;
  });
}
export async function getRun(workspace: LocalWorkspace, runId: string): Promise<AgentRun> {
  assertRunId(runId);
  return readStoredRun(workspace, runId);
}

export interface RunListOptions {
  taskId?: string;
  status?: AgentRun["status"];
}

export async function listRuns(workspace: LocalWorkspace, options: RunListOptions = {}): Promise<AgentRun[]> {
  const directory = await workspaceFile(workspace, DIRECTORY);
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error: unknown) {
    if (isCode(error, "ENOENT")) return [];
    throw error;
  }
  const runNames = names.filter((name) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$/.test(name)).sort();
  const runs = await Promise.all(runNames.map((name) => getRun(workspace, name.slice(0, -5))));
  return runs
    .filter((run) => options.taskId === undefined || run.taskId === options.taskId)
    .filter((run) => options.status === undefined || run.status === options.status)
    .sort((left, right) => left.runId.localeCompare(right.runId));
}


async function readStoredRun(workspace: LocalWorkspace, runId: string): Promise<AgentRun> {
  try {
    const value = JSON.parse(await readFile(await workspaceFile(workspace, fileName(runId)), "utf8")) as unknown;
    (await defaultSchemaRegistry()).validate("agent-run", value);
    assertValidRun(value);
    const run = value as AgentRun;
    if (run.runId !== runId) throw runtimeError("RUNTIME_RUN_INVALID", "Stored Agent run ID does not match its filename.", { runId, storedRunId: run.runId });
    return run;
  } catch (error: unknown) {
    if (isCode(error, "RUNTIME_RUN_NOT_FOUND")) throw error;
    if (isCode(error, "ENOENT")) throw runtimeError("RUNTIME_RUN_NOT_FOUND", "Agent run does not exist.", { runId });
    if (error instanceof SyntaxError) throw runtimeError("RUNTIME_RUN_INVALID", "Stored Agent run contains invalid JSON.", { runId });
    if (error instanceof StinkyCobblerError && error.code === "RUNTIME_RUN_INVALID") throw error;
    throw error;
  }
}
function assertValidRun(value: unknown): asserts value is AgentRun {
  if (!value || typeof value !== "object") throw runtimeError("RUNTIME_RUN_INVALID", "Agent run must be an object.", {});
  const run = value as Partial<AgentRun>;
  if (typeof run.runId !== "string") throw runtimeError("RUNTIME_RUN_INVALID", "Agent run runId is invalid.", {});
  assertRunId(run.runId);
  if (run.ownerToken !== undefined && (typeof run.ownerToken !== "string" || run.ownerToken.length < 32 || run.ownerToken.length > 256)) throw runtimeError("RUNTIME_RUN_INVALID", "Agent run ownerToken is invalid.", { runId: run.runId });
  if (run.fenceEpoch !== undefined && (!Number.isSafeInteger(run.fenceEpoch) || run.fenceEpoch < 0)) throw runtimeError("RUNTIME_RUN_INVALID", "Agent run fenceEpoch is invalid.", { runId: run.runId });
  for (const field of ["version", "capsuleId", "taskId", "agentId", "role", "workspaceId", "leaseId", "policyVersion", "executor", "createdAt"] as const) {
    if (run[field] === undefined || (typeof run[field] !== "string" && field !== "version")) throw runtimeError("RUNTIME_RUN_INVALID", `Agent run ${field} is invalid.`, { field, runId: run.runId });
  }
  if (typeof run.version !== "string" && !(typeof run.version === "number" && Number.isInteger(run.version) && run.version >= 1)) throw runtimeError("RUNTIME_RUN_INVALID", "Agent run version is invalid.", { runId: run.runId });
  if (!RUN_STATUSES.includes(run.status as AgentRun["status"])) throw runtimeError("RUNTIME_RUN_INVALID", "Agent run status is invalid.", { runId: run.runId, status: run.status });
  if (!run.budget || typeof run.budget !== "object" || Array.isArray(run.budget)) throw runtimeError("RUNTIME_RUN_INVALID", "Agent run budget is invalid.", { runId: run.runId });
  if (!isCanonicalIsoDate(run.createdAt as string) || (run.startedAt !== undefined && !isCanonicalIsoDate(run.startedAt)) || (run.heartbeatAt !== undefined && !isCanonicalIsoDate(run.heartbeatAt)) || (run.finishedAt !== undefined && !isCanonicalIsoDate(run.finishedAt))) {
    throw runtimeError("RUNTIME_RUN_INVALID", "Agent run timestamp is invalid.", { runId: run.runId });
  }
  if (run.status === "RUNNING" && run.startedAt === undefined) throw runtimeError("RUNTIME_RUN_INVALID", "Running Agent runs require startedAt.", { runId: run.runId });
  if (TERMINAL_STATUSES.has(run.status as AgentRun["status"]) && run.finishedAt === undefined) throw runtimeError("RUNTIME_RUN_INVALID", "Terminal Agent runs require finishedAt.", { runId: run.runId, status: run.status });
}

function assertOwner(run: AgentRun, ownerToken: string, expectedEpoch?: number): void {
  if (run.ownerToken !== ownerToken) throw runtimeError("RUNTIME_RUN_FENCED", "Agent run owner token is no longer valid.", { runId: run.runId });
  if (expectedEpoch !== undefined && run.fenceEpoch !== expectedEpoch) throw runtimeError("RUNTIME_RUN_FENCED", "Agent run fence epoch is no longer valid.", { runId: run.runId, expectedEpoch, actualEpoch: run.fenceEpoch });
}
function assertImmutableBindings(current: AgentRun, next: AgentRun): void {
  for (const field of ["runId", "capsuleId", "taskId", "agentId", "role", "workspaceId", "leaseId", "policyVersion", "executionRequestHash", "executor"] as const) {
    if (current[field] !== next[field]) throw runtimeError("RUNTIME_RUN_BINDING_CONFLICT", "Agent run bindings cannot change after creation.", { runId: current.runId, field });
  }
}

function assertArrayPrefix(current: unknown[], next: unknown[], field: string, runId: string): void {
  if (next.length < current.length || current.some((value, index) => JSON.stringify(value) !== JSON.stringify(next[index]))) {
    throw runtimeError("RUNTIME_RUN_CHECKPOINT_CONFLICT", "Runtime progress checkpoints must extend the persisted append-only prefix.", {
      runId, field, currentLength: current.length, nextLength: next.length
    });
  }
}

function assertBudgetProgress(current: RuntimeBudgetUsage, next: RuntimeBudgetUsage, runId: string): void {
  for (const field of ["turns", "minutes", "toolCalls", "files", "bytes", "outputBytes"] as const) {
    const before = current[field] ?? 0;
    const after = next[field] ?? 0;
    if (!Number.isSafeInteger(after) || after < before) {
      throw runtimeError("RUNTIME_RUN_CHECKPOINT_CONFLICT", "Runtime budget checkpoints must be monotonic safe integers.", { runId, field, before, after });
    }
  }
}

function isCanonicalIsoDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}


function fileName(runId: string): string { return path.join(DIRECTORY, `${runId}.json`); }

/**
 * Reconciles only an unambiguous persisted status advance. This closes the
 * crash window where the Run target was durable but its lifecycle effect was
 * not. Conflicting or branching histories remain fail-closed.
 */
export async function ensureRunLifecycleCommitted(workspace: LocalWorkspace, run: AgentRun): Promise<void> {
  await withWorkspaceLock(workspace, async () => {
    assertValidRun(run);
    const lifecycle = (await listLedgerEntries(workspace)).filter((entry) =>
      entry.runId === run.runId && (entry.event === "run-created" || entry.event === "run-transitioned" || entry.event === "run-recovered")
    );
    if (lifecycle.length === 0) {
      await ensureRunLifecycleEvent(workspace, runCreatedEffect(run));
      return;
    }
    const creations = lifecycle.filter((entry) => entry.event === "run-created");
    if (creations.length !== 1 || lifecycle[0]?.event !== "run-created") {
      throw runtimeError("RUNTIME_RUN_LIFECYCLE_CONFLICT", "Run lifecycle requires exactly one leading run-created event.", {
        runId: run.runId, creationEvents: creations.length
      });
    }
    let observed = statusFromEntry(creations[0]!, "toStatus");
    for (const entry of lifecycle.slice(1)) {
      if (entry.event === "run-created") {
        throw runtimeError("RUNTIME_RUN_LIFECYCLE_CONFLICT", "Run lifecycle contains a duplicate creation event.", { runId: run.runId });
      }
      const from = statusFromEntry(entry, "fromStatus");
      const to = statusFromEntry(entry, "toStatus");
      if (from !== observed || !ALLOWED_TRANSITIONS[from].includes(to)) {
        throw runtimeError("RUNTIME_RUN_LIFECYCLE_CONFLICT", "Run lifecycle ledger events do not form one valid status chain.", {
          runId: run.runId, observed, from, to, sequence: entry.sequence
        });
      }
      observed = to;
    }
    if (observed === run.status) return;
    if (!ALLOWED_TRANSITIONS[observed].includes(run.status)) {
      throw runtimeError("RUNTIME_RUN_LIFECYCLE_CONFLICT", "Persisted Run status cannot be reconciled from its last audited status.", {
        runId: run.runId, observed, persisted: run.status
      });
    }
    const effect = run.errorCode === "RUNTIME_STALE_RECOVERY"
      ? runRecoveredEffect(observed, run.status, run.runId)
      : runTransitionEffect(observed, run.status, run.runId);
    await ensureRunLifecycleEvent(workspace, effect);
  });
}

/** Test-only, single-use crash point for Run target/audit ordering. */
export function injectRunLifecycleFaultForTesting(workspace: LocalWorkspace, point: RunLifecycleFaultPoint): void {
  if (process.env.NODE_ENV !== "test") throw runtimeError("RUNTIME_RUN_TEST_FAULT_DENIED", "Run lifecycle fault injection is available only under the test runner.", {});
  runLifecycleFaults.set(workspace.directory, point);
}

async function ensureRunLifecycleEvent(workspace: LocalWorkspace, entry: AppendLedgerEntry): Promise<void> {
  const entries = await listLedgerEntries(workspace);
  const matching = entries.filter((existing) =>
    existing.event === entry.event &&
    existing.runId === entry.runId &&
    existing.fromStatus === entry.fromStatus &&
    existing.toStatus === entry.toStatus
  );
  if (matching.length > 1) {
    throw runtimeError("RUNTIME_RUN_LIFECYCLE_CONFLICT", "Run lifecycle contains duplicate audit effects.", {
      runId: entry.runId, event: entry.event, fromStatus: entry.fromStatus, toStatus: entry.toStatus, entries: matching.length
    });
  }
  if (matching.length === 0) await appendLedgerEntry(workspace, entry);
}
function runCreatedEffect(run: AgentRun): AppendLedgerEntry {
  return prepareLedgerEntry({ event: "run-created", summary: `Run created with status ${run.status}.`, runId: run.runId, toStatus: run.status });
}
function runTransitionEffect(from: AgentRun["status"], to: AgentRun["status"], runId: string): AppendLedgerEntry {
  return prepareLedgerEntry({ event: "run-transitioned", summary: `Run status changed from ${from} to ${to}.`, runId, fromStatus: from, toStatus: to });
}
function runRecoveredEffect(from: AgentRun["status"], to: AgentRun["status"], runId: string): AppendLedgerEntry {
  return prepareLedgerEntry({ event: "run-recovered", summary: `Stale Run recovered from ${from} to ${to}.`, runId, fromStatus: from, toStatus: to });
}
function statusFromEntry(entry: LedgerEntry, field: "fromStatus" | "toStatus"): AgentRun["status"] {
  const status = entry[field];
  if (status === undefined || !RUN_STATUSES.includes(status as AgentRun["status"])) {
    throw runtimeError("RUNTIME_RUN_LIFECYCLE_CONFLICT", "Run lifecycle event contains an invalid status.", {
      runId: entry.runId, event: entry.event, field, status, sequence: entry.sequence
    });
  }
  return status as AgentRun["status"];
}
function maybeInjectRunLifecycleFault(workspace: LocalWorkspace, point: RunLifecycleFaultPoint, runId: string): void {
  if (runLifecycleFaults.get(workspace.directory) !== point) return;
  runLifecycleFaults.delete(workspace.directory);
  throw runtimeError("RUNTIME_RUN_LIFECYCLE_FAULT_INJECTED", `Injected Run lifecycle fault at ${point}.`, { runId, point });
}
async function ensureDirectory(workspace: LocalWorkspace): Promise<void> {
  const directory = await workspaceFile(workspace, DIRECTORY);
  await mkdir(directory, { recursive: true, mode: 0o700 });
}
function assertRunId(value: string): void { if (!RUN_ID.test(value)) throw runtimeError("RUNTIME_RUN_ID_INVALID", "Agent run ID is invalid.", { runId: value }); }
function runtimeError(code: string, message: string, details: Record<string, unknown>): StinkyCobblerError { return new StinkyCobblerError(code, ExitCode.VALIDATION, message, details); }
function isCode(error: unknown, code: string): boolean { return typeof error === "object" && error !== null && "code" in error && error.code === code; }
