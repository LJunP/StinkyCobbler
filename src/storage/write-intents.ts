import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type { EvidenceRef, WriteIntent } from "../contracts/types.js";
import type { TaskContract } from "../contracts/orchestration.js";
import { SchemaRegistry } from "../contracts/schema-registry.js";
import { defaultSchemaRegistry } from "../contracts/default-schema-registry.js";
import { ExitCode, StinkyCobblerError } from "../errors.js";
import { appendLedgerEntry, auditTextFingerprint, listLedgerEntries, prepareLedgerEntry } from "./ledger.js";
import type { LocalWorkspace } from "./workspace.js";
import { createWorkspaceJson, workspaceFile, writeWorkspaceJson } from "./workspace.js";
import { withWorkspaceLock } from "./workspace-lock.js";
import { assertCurrentPlanExecutionAuthority, assertCurrentPlanGeneration, getPlan } from "./plans.js";
import { consumeApproval, listApprovals } from "./approvals.js";
import { isApprovalExpired } from "../policy/approval.js";
import { isSensitivePath, isForbiddenWriteTarget } from "../policy/path-policy.js";
import { loadOrchestrationConfig } from "../config/tiered.js";
import { recordEvidence } from "./evidence.js";
import { assertWorkspacePathPolicy, resolveWorkspacePath } from "../security/workspace-path.js";
import { admitTaskCapability, TASK_AUTHORITY_POLICY_VERSION } from "./task-authority.js";

const DIRECTORY = "write-intents";
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const WRITE_CONFIRM_ACTION = "write-confirm";
const writeConfirmationFaults = new Map<string, "after-consume" | "after-intent">();
const writeRequestFaults = new Map<string, "after-authority-consume" | "after-intent">();
const MAX_TARGET_LENGTH = 512;
const PROJECT_ROOT = path.resolve(import.meta.dirname, "../..");

export interface WriteIntentRecord {
  version: 1;
  writeIntentId: string;
  planId: string;
  stepId: string;
  taskId: string;
  /** 2.0 orchestration mode: bound to a run/subtask instead of a plan step. */
  runRef?: string;
  subtaskRef?: string;
  /** Orchestration retry generation that created this intent. */
  attempt?: number;
  status: "PENDING" | "CONFIRMED" | "REJECTED" | "APPLIED" | "FAILED" | "RECOVERY_REQUIRED" | "ROLLED_BACK";
  writes: WriteIntent[];
  confirmedTargets?: string[];
  createdAt: string;
  confirmedAt?: string;
  approvalRef?: string;
  /** Hash of the immutable write subject; precise Approvals bind this value. */
  intentHash: string;
  /** Null means the target was absent when a create intent was requested. */
  expectedPreimageHash: string | null;
  proposedContentHash?: string;
  authorityApprovalRefs: string[];
  /** Exact capability Approval consumed by this intent, when a root/child Approval was required. */
  authorityApprovalRef: string;
  /** New 2.0.1 intents own their capability admission independently of the execution Lease. */
  authorityConsumptionOwner: string;
  parentGrantRef: string;
  taskAuthorityHash: string;
  policyVersion: string;
  hostSessionId: string;
  /** True when this intent was auto-allowed (no human write-confirm Approval); only create/modify intents qualify. */
  autoAllowed?: boolean;
  /** Storage-owned execution journal for safe rollback (one target per intent). */
  appliedTarget?: string;
  postImageHash?: string | null;
  preImageMissing?: boolean;
  /**
   * Durable pre-mutation fence. Its presence means the business target may
   * already differ from the last fully recorded control-plane state.
   */
  recoveryJournal?: {
    state: "UNCERTAIN";
    operation: "create" | "modify" | "delete";
    target: string;
    expectedPreimageHash: string | null;
    preImageMissing: boolean;
    postImageHash: string | null;
    backupPath: string | null;
    startedAt: string;
  };
  /** Durable fence written before an APPLIED intent mutates its target during rollback. */
  rollbackRecoveryJournal?: {
    state: "UNCERTAIN";
    operation: "remove-created" | "restore-backup";
    target: string;
    expectedCurrentHash: string | null;
    restoredHash: string | null;
    evidenceContentHash: string;
    backupPath: string | null;
    reason: string;
    evidenceObservedAt: string;
    startedAt: string;
  };
  cancelledAt?: string;
  cancellationReason?: string;
}

/**
 * Requests write confirmation for one plan step — or, in 2.0 orchestration mode,
 * for one subtask (pass `runRef` + `subtaskRef` instead of `planId`/`stepId`).
 * Never writes content. With `autoAllow`, regular create/modify intents are
 * created already CONFIRMED (no write-confirm Approval required) — the write is
 * audited via a `write-auto-allowed` ledger event and remains fully backed up
 * and rollback-able. Delete intents can never be auto-allowed.
 */
export async function requestWrites(
  workspace: LocalWorkspace,
  schemas: SchemaRegistry,
  planId: string,
  stepId: string,
  writes: WriteIntent[],
  options: {
    autoAllow?: boolean;
    runRef?: string;
    subtaskRef?: string;
    approvalRefs?: string[];
    parentGrantRef?: string;
    hostSessionId?: string;
  } = {}
): Promise<WriteIntentRecord> {
  return withWorkspaceLock(workspace, async () => {
    const isSubtaskMode = options.subtaskRef !== undefined || options.runRef !== undefined;
    let taskId: string;
    let attempt: number | undefined;
    let subtaskContract: TaskContract | undefined;
    let bindingTaskAuthorityHash: string;
    let bindingHostSessionId: string;
    if (isSubtaskMode) {
      const runRef = options.runRef;
      const subtaskRef = options.subtaskRef;
      if (runRef === undefined || subtaskRef === undefined) throw writeError("WRITE_SUBTASK_REF_REQUIRED", "Subtask-mode writes require runRef and subtaskRef.");
      const { getRun, getSubtask, getActiveContractForRun } = await import("./orchestration.js");
      const run = await getRun(workspace, runRef);
      subtaskContract = await getActiveContractForRun(workspace, run);
      if (run.status !== "RUNNING" && run.status !== "DEGRADED") throw writeError("WRITE_RUN_STATE", "Writes can only be requested for executable RUNNING/DEGRADED orchestration runs.", { runId: runRef, status: run.status });
      const { getRunCancellationFence } = await import("./orchestration-fence.js");
      if (await getRunCancellationFence(workspace, runRef)) throw writeError("WRITE_RUN_STATE", "Writes cannot be requested for a cancelling or cancelled orchestration run.", { runId: runRef });
      const subtask = await getSubtask(workspace, subtaskRef);
      if (subtask.status !== "RUNNING") throw writeError("WRITE_SUBTASK_STATE", "Writes can only be requested for RUNNING subtasks.", { subtaskId: subtaskRef, status: subtask.status });
      if (!Number.isSafeInteger(subtask.activeAttempt) || subtask.activeAttempt !== subtask.retriesUsed) {
        throw writeError("WRITE_ATTEMPT_INVALID", "Writes require the subtask's current persisted retry generation.", { subtaskId: subtaskRef, activeAttempt: subtask.activeAttempt, retriesUsed: subtask.retriesUsed });
      }
      attempt = subtask.activeAttempt;
      if (subtask.runRef !== run.runId || subtask.contractRef !== run.contractRef) {
        throw writeError("WRITE_BINDING_MISMATCH", "The requested run and subtask are not bound to the same contract.", { runRef, subtaskRef });
      }
      if (options.parentGrantRef !== undefined && options.parentGrantRef !== subtaskContract.contractId) {
        throw writeError("WRITE_PARENT_GRANT_MISMATCH", "Subtask writes must derive from the Run's current active Contract.", {
          runRef,
          expected: subtaskContract.contractId,
          observed: options.parentGrantRef
        });
      }
      if (options.hostSessionId !== undefined && options.hostSessionId !== subtaskContract.hostSessionId) {
        throw writeError("WRITE_SESSION_MISMATCH", "Subtask writes must remain in the active Contract host session.", { runRef });
      }
      taskId = subtaskContract.taskId;
      bindingTaskAuthorityHash = subtaskContract.taskAuthorityHash;
      bindingHostSessionId = subtaskContract.hostSessionId;
    } else {
      const plan = await getPlan(workspace, planId);
      assertCurrentPlanGeneration(plan);
      await assertCurrentPlanExecutionAuthority(workspace, plan);
      if (plan.status !== "EXECUTING") throw writeError("WRITE_PLAN_STATE", "Writes can only be requested for EXECUTING plans.", { planId, status: plan.status });
      const step = plan.steps.find((candidate) => candidate.stepId === stepId);
      if (!step) throw writeError("WRITE_STEP_NOT_FOUND", "Plan step does not exist.", { planId, stepId });
      if (step.status !== "RUNNING") throw writeError("WRITE_STEP_STATE", "Writes can only be requested for RUNNING steps.", { planId, stepId, status: step.status });
      taskId = plan.taskId;
      bindingTaskAuthorityHash = plan.taskAuthorityHash!;
      bindingHostSessionId = plan.hostSessionId!;
    }
    const cfg = await loadOrchestrationConfig(workspace);
    assertWrites(writes, cfg.sensitiveExtraPaths);
    const autoAllow = options.autoAllow === true;
    if (autoAllow && writes.some((write) => write.action === "delete")) {
      throw writeError("WRITE_AUTO_ALLOW_DELETE_DENIED", "Delete intents can never be auto-allowed; use the explicit write-confirm flow.", { planId, stepId });
    }
    const expectedPreimageHash = await captureExpectedPreimage(workspace, writes[0]!, cfg.sensitiveExtraPaths);
    const writeIntentId = writeIntentIdForRequest({
      planId,
      stepId,
      taskId,
      ...(isSubtaskMode ? { runRef: options.runRef!, subtaskRef: options.subtaskRef!, attempt: attempt! } : {}),
      writes,
      expectedPreimageHash,
      taskAuthorityHash: bindingTaskAuthorityHash,
      hostSessionId: bindingHostSessionId,
      approvalRefs: options.approvalRefs ?? [],
      parentGrantRef: subtaskContract?.contractId ?? options.parentGrantRef ?? null,
      autoAllow
    });
    const existing = await getWriteIntent(workspace, writeIntentId).catch((error: unknown) => {
      if (error instanceof StinkyCobblerError && error.code === "WRITE_INTENT_NOT_FOUND") return undefined;
      throw error;
    });
    const authority = await admitTaskCapability(workspace, {
      taskId,
      capability: "repository-write",
      readScope: writes.map((write) => write.target),
      writeSet: writes.map((write) => write.target),
      approvalRefs: options.approvalRefs ?? [],
      ...((subtaskContract?.contractId ?? options.parentGrantRef) === undefined ? {} : { parentGrantRef: subtaskContract?.contractId ?? options.parentGrantRef }),
      ...(subtaskContract?.taskAuthorityHash === undefined ? {} : { expectedTaskAuthorityHash: subtaskContract.taskAuthorityHash }),
      ...(subtaskContract?.policyVersion === undefined ? {} : { policyVersion: subtaskContract.policyVersion }),
      maxToolCalls: 1,
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      hostSessionId: subtaskContract?.hostSessionId ?? options.hostSessionId ?? "local-cli",
      ...(subtaskContract === undefined ? {} : { allowApprovalScopeSuperset: true }),
      approvalConsumptionOwner: writeIntentId
    });
    if (authority.matchedApprovalRef === undefined) {
      throw writeError(
        "WRITE_APPROVAL_REQUIRED",
        "Each WriteIntent requires its own current precise repository-write Approval; a reusable parent grant alone cannot mint write authority.",
        { writeIntentId }
      );
    }
    await consumeApproval(workspace, schemas, authority.matchedApprovalRef, writeIntentId);
    maybeInjectWriteRequestFault(workspace, "after-authority-consume");
    await mkdir(await workspaceFile(workspace, DIRECTORY), { recursive: true, mode: 0o700 });
    const createdAt = existing?.createdAt ?? new Date().toISOString();
    const immutable = {
      version: 1 as const,
      writeIntentId,
      planId,
      stepId,
      taskId,
      ...(isSubtaskMode ? { runRef: options.runRef!, subtaskRef: options.subtaskRef!, attempt: attempt! } : {}),
      writes,
      expectedPreimageHash,
      authorityApprovalRefs: authority.approvalRefs,
      authorityApprovalRef: authority.matchedApprovalRef,
      authorityConsumptionOwner: writeIntentId,
      parentGrantRef: authority.parentGrantRef,
      taskAuthorityHash: authority.taskAuthorityHash,
      policyVersion: authority.policyVersion,
      hostSessionId: authority.hostSessionId,
      createdAt
    };
    const intentHash = hashWriteIntentSubject(immutable);
    if (existing !== undefined) {
      if (
        existing.intentHash !== intentHash || existing.authorityConsumptionOwner !== writeIntentId ||
        existing.authorityApprovalRef !== authority.matchedApprovalRef
      ) {
        throw writeError("WRITE_REQUEST_IDEMPOTENCY_CONFLICT", "The deterministic WriteIntent ID already stores a different authority subject.", { writeIntentId });
      }
      await ensureWriteRequestLedgerEntries(workspace, existing);
      return existing;
    }
    const record: WriteIntentRecord = {
      ...immutable,
      status: autoAllow ? "CONFIRMED" : "PENDING",
      intentHash,
      ...(autoAllow ? { confirmedTargets: writes.map((write) => write.target), confirmedAt: new Date().toISOString(), autoAllowed: true } : {}),
    };
    schemas.validate("write-intent", record);
    await createWorkspaceJson(workspace, fileName(record.writeIntentId), record);
    maybeInjectWriteRequestFault(workspace, "after-intent");
    await ensureWriteRequestLedgerEntries(workspace, record);
    return record;
  });
}

/** Test-only, single-use WriteIntent request split-write crash point. */
export function injectWriteRequestFaultForTesting(
  workspace: LocalWorkspace,
  point: "after-authority-consume" | "after-intent"
): void {
  if (process.env.NODE_ENV !== "test") throw writeError("WRITE_REQUEST_TEST_FAULT_DENIED", "Write request fault injection is available only under the test runner.");
  writeRequestFaults.set(workspace.directory, point);
}

function maybeInjectWriteRequestFault(workspace: LocalWorkspace, point: "after-authority-consume" | "after-intent"): void {
  if (writeRequestFaults.get(workspace.directory) !== point) return;
  writeRequestFaults.delete(workspace.directory);
  throw writeError("WRITE_REQUEST_TEST_FAULT", `Injected WriteIntent request fault at ${point}.`, { point });
}

/** Confirms a write request only when a matching approved write-confirm Approval exists. */
export async function confirmWrites(workspace: LocalWorkspace, planId: string, stepId: string, writeIntentId: string, schemas?: SchemaRegistry): Promise<WriteIntentRecord> {
  return withWorkspaceLock(workspace, async () => {
    const current = await getWriteIntent(workspace, writeIntentId);
    assertIntentCoordinates(current, planId, stepId);
    if (
      current.authorityConsumptionOwner !== current.writeIntentId ||
      typeof current.authorityApprovalRef !== "string" ||
      !Array.isArray(current.authorityApprovalRefs) ||
      !current.authorityApprovalRefs.includes(current.authorityApprovalRef)
    ) {
      throw writeError("WRITE_REISSUE_REQUIRED", "This pre-2.0.1 WriteIntent remains readable/cancellable but cannot be confirmed; request a new WriteIntent.", {
        writeIntentId: current.writeIntentId
      });
    }
    if (current.status === "CONFIRMED") {
      if (current.autoAllowed !== true) await ensureWriteConfirmedLedgerEntry(workspace, current);
      return current;
    }
    if (current.status !== "PENDING") throw writeError("WRITE_STATE_CONFLICT", "Only PENDING write requests can be confirmed.", { writeIntentId, status: current.status });
    const taskId = await getIntentTaskId(workspace, current);
    const authority = await admitTaskCapability(workspace, {
      taskId,
      capability: "repository-write",
      readScope: current.writes.map((write) => write.target),
      writeSet: current.writes.map((write) => write.target),
      approvalRefs: [current.authorityApprovalRef],
      parentGrantRef: current.parentGrantRef,
      expectedTaskAuthorityHash: current.taskAuthorityHash,
      policyVersion: current.policyVersion,
      maxToolCalls: 1,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      hostSessionId: current.hostSessionId,
      allowApprovalScopeSuperset: true,
      approvalConsumptionOwner: current.authorityConsumptionOwner
    });
    if (authority.matchedApprovalRef !== current.authorityApprovalRef) {
      throw writeError("WRITE_REISSUE_REQUIRED", "WriteIntent capability Approval no longer resolves to its exact persisted authority binding.", {
        writeIntentId: current.writeIntentId,
        authorityApprovalRef: current.authorityApprovalRef
      });
    }
    await assertIntentTargetsNotHardlinked(workspace, current);
    const approvals = await listApprovals(workspace, taskId);
    const requestedTargets = [...current.writes.map((write) => write.target)].sort();
    const matches = approvals.filter((approval) =>
      approval.action === WRITE_CONFIRM_ACTION &&
      approval.status === "approved" &&
      !isApprovalExpired(approval) &&
      ((approval.consumedAt === undefined && approval.consumedBy === undefined) ||
        (approval.consumedAt !== undefined && approval.consumedBy === current.writeIntentId)) &&
      approval.subjectKind === "write-intent" &&
      approval.subjectId === current.writeIntentId &&
      approval.subjectVersion === current.version &&
      approval.subjectHash === current.intentHash &&
      approval.capability === "repository-write" &&
      approval.policyVersion === TASK_AUTHORITY_POLICY_VERSION &&
      approval.hostSessionId === current.hostSessionId &&
      approval.expectedPreimageHash === current.expectedPreimageHash &&
      approval.requestedBy !== undefined &&
      approval.decidedBy !== undefined &&
      approval.expiresAt !== undefined &&
      approval.nonce !== undefined &&
      approval.budget?.maxToolCalls !== undefined &&
      approval.budget.expiresAt !== undefined &&
      Date.parse(approval.budget.expiresAt) > Date.now() &&
      JSON.stringify([...(approval.scope ?? [])].sort()) === JSON.stringify(requestedTargets)
    ).sort((left, right) => {
      const leftRecovery = left.consumedBy === current.writeIntentId ? 1 : 0;
      const rightRecovery = right.consumedBy === current.writeIntentId ? 1 : 0;
      return rightRecovery - leftRecovery || left.requestedAt.localeCompare(right.requestedAt);
    });
    const match = matches[0];
    if (!match) throw writeError("WRITE_CONFIRMATION_REQUIRED", "An approved write-confirm Approval matching the requested targets is required.", { writeIntentId });
    await consumeApproval(workspace, schemas ?? await SchemaRegistry.create(PROJECT_ROOT), match.id, current.writeIntentId);
    maybeInjectWriteConfirmationFault(workspace, "after-consume");
    const next: WriteIntentRecord = {
      ...current,
      status: "CONFIRMED",
      ...(match.scope === undefined ? {} : { confirmedTargets: match.scope }),
      confirmedAt: new Date().toISOString(),
      approvalRef: match.id,
      ...(match.proposedContentHash === undefined ? {} : { proposedContentHash: match.proposedContentHash })
    };
    await writeWorkspaceJson(workspace, fileName(writeIntentId), next);
    maybeInjectWriteConfirmationFault(workspace, "after-intent");
    await ensureWriteConfirmedLedgerEntry(workspace, next);
    return next;
  });
}

/** Test-only, single-use explicit Write confirmation crash point. */
export function injectWriteConfirmationFaultForTesting(workspace: LocalWorkspace, point: "after-consume" | "after-intent"): void {
  if (process.env.NODE_ENV !== "test") throw writeError("WRITE_CONFIRMATION_TEST_FAULT_DENIED", "Write confirmation fault injection is available only under the test runner.");
  writeConfirmationFaults.set(workspace.directory, point);
}

function maybeInjectWriteConfirmationFault(workspace: LocalWorkspace, point: "after-consume" | "after-intent"): void {
  if (writeConfirmationFaults.get(workspace.directory) !== point) return;
  writeConfirmationFaults.delete(workspace.directory);
  throw writeError("WRITE_CONFIRMATION_TEST_FAULT", `Injected Write confirmation fault at ${point}.`, { point });
}

async function ensureWriteConfirmedLedgerEntry(workspace: LocalWorkspace, intent: WriteIntentRecord): Promise<void> {
  if (intent.status !== "CONFIRMED" || intent.autoAllowed === true || intent.approvalRef === undefined) {
    throw writeError("WRITE_CONFIRMATION_AUDIT_INVALID", "Explicitly confirmed writes require their bound Approval before audit recovery.", { writeIntentId: intent.writeIntentId });
  }
  const entries = await listLedgerEntries(workspace);
  if (entries.some((entry) => entry.event === "write-confirmed" && entry.writeIntentRef === intent.writeIntentId && entry.approvalRef === intent.approvalRef)) return;
  await appendLedgerEntry(workspace, {
    event: "write-confirmed",
    taskId: intent.taskId,
    planRef: intent.planId,
    ...(intent.runRef === undefined ? {} : { runRef: intent.runRef }),
    ...(intent.subtaskRef === undefined ? {} : { subtaskRef: intent.subtaskRef }),
    writeIntentRef: intent.writeIntentId,
    approvalRef: intent.approvalRef,
    summary: `Write request ${intent.writeIntentId} confirmed for ${intent.confirmedTargets?.length ?? 0} target(s).`
  });
}

/** Rejects a pending write request. Idempotent for already-rejected requests. */
export async function rejectWrites(workspace: LocalWorkspace, planId: string, stepId: string, writeIntentId: string, reason: string): Promise<WriteIntentRecord> {
  return withWorkspaceLock(workspace, async () => {
    if (!reason || reason.length > 512) throw writeError("WRITE_REJECT_REASON_INVALID", "Rejection reason must be 1-512 characters.");
    const current = await getWriteIntent(workspace, writeIntentId);
    assertIntentCoordinates(current, planId, stepId);
    if (current.status === "REJECTED") return current;
    if (current.status !== "PENDING" && current.status !== "CONFIRMED") throw writeError("WRITE_STATE_CONFLICT", "Only unapplied PENDING or CONFIRMED write requests can be rejected.", { writeIntentId, status: current.status });
    const audit = prepareLedgerEntry({ event: "write-rejected", writeIntentRef: writeIntentId, summary: `Write request ${writeIntentId} rejected; reason ${auditTextFingerprint(reason)}.` });
    const next: WriteIntentRecord = { ...current, status: "REJECTED" };
    await writeWorkspaceJson(workspace, fileName(writeIntentId), next);
    await appendLedgerEntry(workspace, audit);
    return next;
  });
}

export async function getWriteIntent(workspace: LocalWorkspace, writeIntentId: string): Promise<WriteIntentRecord> {
  assertWriteIntentId(writeIntentId);
  try {
    const raw: unknown = JSON.parse(await readFile(await workspaceFile(workspace, fileName(writeIntentId)), "utf8"));
    (await defaultSchemaRegistry()).validate("write-intent", raw);
    const value = raw as WriteIntentRecord;
    if (value.writeIntentId !== writeIntentId) throw writeError("WRITE_INTENT_INVALID", "Stored write request ID does not match its canonical lookup ID.", { writeIntentId, storedWriteIntentId: value.writeIntentId });
    return value;
  } catch (error: unknown) {
    if (isCode(error, "ENOENT")) throw writeError("WRITE_INTENT_NOT_FOUND", "Write request does not exist.", { writeIntentId });
    if (error instanceof SyntaxError) throw writeError("WRITE_INTENT_INVALID", "Stored write request contains invalid JSON.", { writeIntentId });
    throw error;
  }
}

export async function listWriteIntents(workspace: LocalWorkspace, planId?: string): Promise<WriteIntentRecord[]> {
  let names: string[];
  try { names = await readdir(await workspaceFile(workspace, DIRECTORY)); } catch (error: unknown) { if (isCode(error, "ENOENT")) return []; throw error; }
  const values = await Promise.all(names.filter((name) => /^write-[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$/.test(name)).sort().map((name) => getWriteIntent(workspace, name.slice(0, -5))));
  return planId === undefined ? values : values.filter((record) => record.planId === planId);
}

/**
 * Explicit, user-initiated rollback: restores each applied target from the
 * pre-write state, records restoration Evidence, appends a `write-rolled-back`
 * ledger event, and marks the intent ROLLED_BACK. A created file is removed
 * only while its content still matches the stored post-image hash.
 */
export async function rollbackWrite(workspace: LocalWorkspace, schemas: SchemaRegistry, planId: string, stepId: string, writeIntentId: string, reason: string): Promise<WriteIntentRecord> {
  return withWorkspaceLock(workspace, async () => {
    if (!reason || reason.length > 512) throw writeError("WRITE_ROLLBACK_REASON_INVALID", "Rollback reason must be 1-512 characters.");
    const current = await getWriteIntent(workspace, writeIntentId);
    if (current.status === "ROLLED_BACK") throw writeError("WRITE_ALREADY_ROLLED_BACK", "This write request has already been rolled back.", { writeIntentId });
    if (current.status === "RECOVERY_REQUIRED") throw writeError("WRITE_RECOVERY_REQUIRED", "Rollback has uncertain durable state; use write rollback-recover after inspecting the target and journal.", { writeIntentId, rollbackRecoveryJournal: current.rollbackRecoveryJournal });
    if (current.status !== "APPLIED") throw writeError("WRITE_NOT_APPLIED", "Only APPLIED write requests can be rolled back.", { writeIntentId, status: current.status });
    assertIntentCoordinates(current, planId, stepId);
    const appliedWrite = current.writes.length === 1 ? current.writes[0] : undefined;
    if (current.appliedTarget === undefined || current.confirmedTargets?.length !== 1 || current.confirmedTargets[0] !== current.appliedTarget || appliedWrite?.target !== current.appliedTarget) {
      throw writeError("WRITE_ROLLBACK_JOURNAL_INVALID", "Applied write lacks a complete single-target rollback journal.", { writeIntentId });
    }
    if (
      (appliedWrite.action === "create" && (current.preImageMissing !== true || typeof current.postImageHash !== "string")) ||
      (appliedWrite.action === "modify" && (current.preImageMissing !== false || typeof current.postImageHash !== "string")) ||
      (appliedWrite.action === "delete" && (current.preImageMissing !== false || current.postImageHash !== null))
    ) {
      throw writeError("WRITE_ROLLBACK_JOURNAL_INVALID", "Applied write has inconsistent rollback state.", { writeIntentId, action: appliedWrite.action });
    }
    const journal = await prepareRollbackRecoveryJournal(workspace, current, appliedWrite.action, current.appliedTarget, reason);
    const recovery: WriteIntentRecord = { ...current, status: "RECOVERY_REQUIRED", rollbackRecoveryJournal: journal };
    await writeWorkspaceJson(workspace, fileName(writeIntentId), recovery);
    return completeRollbackRecovery(workspace, schemas, recovery);
  });
}

/** Idempotently completes a rollback that was fenced as RECOVERY_REQUIRED. */
export async function reconcileRollbackWrite(workspace: LocalWorkspace, schemas: SchemaRegistry, writeIntentId: string): Promise<WriteIntentRecord> {
  return withWorkspaceLock(workspace, async () => {
    const current = await getWriteIntent(workspace, writeIntentId);
    if (current.status === "ROLLED_BACK") return current;
    if (current.status !== "RECOVERY_REQUIRED" || current.rollbackRecoveryJournal === undefined) {
      throw writeError("WRITE_ROLLBACK_RECOVERY_NOT_FOUND", "WriteIntent has no rollback recovery journal.", { writeIntentId, status: current.status });
    }
    return completeRollbackRecovery(workspace, schemas, current);
  });
}

async function prepareRollbackRecoveryJournal(
  workspace: LocalWorkspace,
  intent: WriteIntentRecord,
  action: WriteIntent["action"],
  target: string,
  reason: string
): Promise<NonNullable<WriteIntentRecord["rollbackRecoveryJournal"]>> {
  const cfg = await loadOrchestrationConfig(workspace);
  const sensitiveExtraPaths = cfg.sensitiveExtraPaths;
  const now = new Date().toISOString();
  if (action === "create") {
    const targetPath = await safeRollbackTarget(workspace, target, false, sensitiveExtraPaths);
    const observed = await hashFile(targetPath, target);
    if (observed !== intent.postImageHash) throw writeError("WRITE_ROLLBACK_CONFLICT", "Target changed after apply; refusing to remove it during rollback.", { target });
    return {
      state: "UNCERTAIN",
      operation: "remove-created",
      target,
      expectedCurrentHash: observed,
      restoredHash: null,
      evidenceContentHash: observed,
      backupPath: null,
      reason,
      evidenceObservedAt: now,
      startedAt: now
    };
  }

  const backupName = backupFileName(intent.writeIntentId, target);
  const backup = await readRollbackBackup(await workspaceFile(workspace, backupName), target);
  const restoredHash = `sha256:${createHash("sha256").update(backup).digest("hex")}`;
  let expectedCurrentHash: string | null;
  if (action === "modify") {
    const targetPath = await safeRollbackTarget(workspace, target, false, sensitiveExtraPaths);
    expectedCurrentHash = await hashFile(targetPath, target);
    if (expectedCurrentHash !== intent.postImageHash) throw writeError("WRITE_ROLLBACK_CONFLICT", "Target changed after apply; refusing to overwrite it during rollback.", { target });
  } else {
    const deletionPath = await resolveRollbackTarget(workspace, target, true, sensitiveExtraPaths);
    if (deletionPath.exists) assertPrivateBusinessFile(deletionPath.stat, target);
    if (deletionPath.exists) throw writeError("WRITE_ROLLBACK_CONFLICT", "Deleted target was recreated after apply; refusing to overwrite it during rollback.", { target });
    expectedCurrentHash = null;
  }
  return {
    state: "UNCERTAIN",
    operation: "restore-backup",
    target,
    expectedCurrentHash,
    restoredHash,
    evidenceContentHash: restoredHash,
    backupPath: backupName,
    reason,
    evidenceObservedAt: now,
    startedAt: now
  };
}

async function completeRollbackRecovery(workspace: LocalWorkspace, schemas: SchemaRegistry, intent: WriteIntentRecord): Promise<WriteIntentRecord> {
  const journal = intent.rollbackRecoveryJournal;
  if (intent.status !== "RECOVERY_REQUIRED" || journal === undefined) {
    throw writeError("WRITE_ROLLBACK_RECOVERY_NOT_FOUND", "WriteIntent has no rollback recovery journal.", { writeIntentId: intent.writeIntentId });
  }
  const taskId = intent.runRef !== undefined && intent.subtaskRef !== undefined
    ? await import("./orchestration.js").then(async ({ getRun, getContract }) => getContract(workspace, (await getRun(workspace, intent.runRef!)).contractRef)).then((contract) => contract.taskId)
    : (await getPlan(workspace, intent.planId)).taskId;
  const rollbackAudit = prepareLedgerEntry({
    event: "write-rolled-back",
    taskId,
    ...(intent.runRef === undefined ? {} : { runRef: intent.runRef }),
    ...(intent.subtaskRef === undefined ? {} : { subtaskRef: intent.subtaskRef }),
    planRef: intent.planId,
    writeIntentRef: intent.writeIntentId,
    summary: `Write request ${intent.writeIntentId} rolled back (1 restored); reason ${auditTextFingerprint(journal.reason)}.`
  });
  const cfg = await loadOrchestrationConfig(workspace);
  const resolved = await resolveRollbackTarget(workspace, journal.target, true, cfg.sensitiveExtraPaths);
  const observed = resolved.exists ? await hashFile(resolved.absolutePath, journal.target) : null;
  if (observed !== journal.restoredHash) {
    if (observed !== journal.expectedCurrentHash) {
      throw writeError("WRITE_ROLLBACK_CONFLICT", "Rollback target matches neither the pre-rollback nor restored bytes; manual diagnosis is required.", {
        target: journal.target,
        expectedCurrentHash: journal.expectedCurrentHash,
        restoredHash: journal.restoredHash,
        observedHash: observed
      });
    }
    if (journal.operation === "remove-created") {
      if (!resolved.exists) throw writeError("WRITE_ROLLBACK_CONFLICT", "Rollback target disappeared before the fenced removal.", { target: journal.target });
      await rm(resolved.absolutePath);
    } else {
      if (journal.backupPath === null || journal.restoredHash === null) throw writeError("WRITE_ROLLBACK_JOURNAL_INVALID", "Rollback restore journal lacks a verified backup.", { writeIntentId: intent.writeIntentId });
      const backup = await readRollbackBackup(await workspaceFile(workspace, journal.backupPath), journal.target);
      const backupHash = `sha256:${createHash("sha256").update(backup).digest("hex")}`;
      if (backupHash !== journal.restoredHash) throw writeError("WRITE_ROLLBACK_JOURNAL_INVALID", "Rollback backup no longer matches the fenced restoration hash.", { writeIntentId: intent.writeIntentId });
      const absoluteTarget = await safeRollbackTarget(workspace, journal.target, true, cfg.sensitiveExtraPaths);
      await mkdir(path.dirname(absoluteTarget), { recursive: true });
      const temporary = path.join(path.dirname(absoluteTarget), `.${path.basename(absoluteTarget)}.${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, backup, { mode: 0o600 });
        await rename(temporary, absoluteTarget);
      } finally {
        await rm(temporary, { force: true }).catch(() => undefined);
      }
    }
  }

  await recordRollbackEvidence(workspace, schemas, intent.writeIntentId, journal.target, journal.evidenceContentHash, journal.evidenceObservedAt);
  const alreadyRecorded = (await listLedgerEntries(workspace)).some((entry) => entry.event === "write-rolled-back" && entry.writeIntentRef === intent.writeIntentId);
  if (!alreadyRecorded) {
    await appendLedgerEntry(workspace, rollbackAudit);
  }
  const { rollbackRecoveryJournal: _completedJournal, ...base } = intent;
  const next: WriteIntentRecord = { ...base, status: "ROLLED_BACK" };
  await writeWorkspaceJson(workspace, fileName(intent.writeIntentId), next);
  return next;
}

function backupFileName(writeIntentId: string, target: string): string {
  return ["backups", `write-${writeIntentId}`, ...target.split(/[\\/]/)].join("/");
}

function writeIntentIdForRequest(input: {
  planId: string;
  stepId: string;
  taskId: string;
  runRef?: string;
  subtaskRef?: string;
  attempt?: number;
  writes: WriteIntent[];
  expectedPreimageHash: string | null;
  taskAuthorityHash: string;
  hostSessionId: string;
  approvalRefs: string[];
  parentGrantRef: string | null;
  autoAllow: boolean;
}): string {
  const digestValue = createHash("sha256").update(JSON.stringify({
    version: 1,
    ...input,
    approvalRefs: [...input.approvalRefs].sort()
  }), "utf8").digest("hex").slice(0, 48);
  return `write-${digestValue.match(/.{1,12}/g)?.join("-") ?? digestValue}`;
}

async function ensureWriteRequestLedgerEntries(workspace: LocalWorkspace, intent: WriteIntentRecord): Promise<void> {
  const expected = [prepareLedgerEntry({
    event: "write-requested",
    taskId: intent.taskId,
    planRef: intent.planId,
    ...(intent.runRef === undefined ? {} : { runRef: intent.runRef }),
    ...(intent.subtaskRef === undefined ? {} : { subtaskRef: intent.subtaskRef }),
    writeIntentRef: intent.writeIntentId,
    summary: `Write request ${intent.writeIntentId} for ${intent.writes.length} target(s).`
  })];
  if (intent.autoAllowed === true) {
    expected.push(prepareLedgerEntry({
      event: "write-auto-allowed",
      taskId: intent.taskId,
      planRef: intent.planId,
      ...(intent.runRef === undefined ? {} : { runRef: intent.runRef }),
      ...(intent.subtaskRef === undefined ? {} : { subtaskRef: intent.subtaskRef }),
      writeIntentRef: intent.writeIntentId,
      summary: `Write request ${intent.writeIntentId} auto-allowed (${intent.writes.length} target(s)); no human write-confirm Approval.`
    }));
  }
  const existing = (await listLedgerEntries(workspace)).filter((entry) =>
    entry.writeIntentRef === intent.writeIntentId &&
    (entry.event === "write-requested" || entry.event === "write-auto-allowed")
  );
  for (const effect of expected) {
    const matches = existing.filter((entry) => entry.event === effect.event);
    if (matches.length === 1) {
      const entry = matches[0]!;
      if (
        entry.taskId === effect.taskId && entry.planRef === effect.planRef && entry.runRef === effect.runRef &&
        entry.subtaskRef === effect.subtaskRef && entry.summary === effect.summary
      ) continue;
    }
    if (matches.length > 0) {
      throw writeError("WRITE_REQUEST_AUDIT_CONFLICT", "WriteIntent request audit is duplicated or bound to different canonical content.", {
        writeIntentId: intent.writeIntentId,
        event: effect.event,
        count: matches.length
      });
    }
    await appendLedgerEntry(workspace, effect);
  }
  const unexpected = existing.filter((entry) => !expected.some((effect) => effect.event === entry.event));
  if (unexpected.length > 0) {
    throw writeError("WRITE_REQUEST_AUDIT_CONFLICT", "WriteIntent has an unexpected auto-allow audit event.", { writeIntentId: intent.writeIntentId });
  }
}

/** Hashes only immutable authority/subject fields; status and confirmation metadata are excluded. */
export function hashWriteIntentSubject(value: Pick<WriteIntentRecord,
  "version" | "writeIntentId" | "planId" | "stepId" | "taskId" | "writes" | "expectedPreimageHash" |
  "authorityApprovalRefs" | "authorityApprovalRef" | "authorityConsumptionOwner" | "parentGrantRef" |
  "taskAuthorityHash" | "policyVersion" | "hostSessionId" | "createdAt"
> & { runRef?: string; subtaskRef?: string; attempt?: number }): string {
  const canonical = {
    version: value.version,
    writeIntentId: value.writeIntentId,
    taskId: value.taskId,
    planId: value.planId,
    stepId: value.stepId,
    runRef: value.runRef ?? null,
    subtaskRef: value.subtaskRef ?? null,
    attempt: value.attempt ?? null,
    writes: value.writes.map((write) => ({ target: write.target, action: write.action, purpose: write.purpose })),
    expectedPreimageHash: value.expectedPreimageHash,
    authorityApprovalRefs: [...value.authorityApprovalRefs].sort(),
    authorityApprovalRef: value.authorityApprovalRef,
    authorityConsumptionOwner: value.authorityConsumptionOwner,
    parentGrantRef: value.parentGrantRef,
    taskAuthorityHash: value.taskAuthorityHash,
    policyVersion: value.policyVersion,
    hostSessionId: value.hostSessionId,
    createdAt: value.createdAt
  };
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex")}`;
}

async function captureExpectedPreimage(workspace: LocalWorkspace, write: WriteIntent, sensitiveExtraPaths?: string[]): Promise<string | null> {
  let resolved;
  try {
    resolved = await resolveWorkspacePath(workspace.root, write.target, {
      allowMissing: true,
      ...(sensitiveExtraPaths === undefined ? {} : { sensitiveExtraPaths })
    });
  } catch (error: unknown) {
    throw writeError("WRITE_TARGET_INVALID", error instanceof Error ? error.message : "Write target is invalid.", { target: write.target });
  }
  if (write.action === "create") {
    if (resolved.exists) throw writeError("WRITE_TARGET_EXISTS", "Create target already exists when the intent is requested.", { target: write.target });
    return null;
  }
  if (!resolved.exists) throw writeError("WRITE_TARGET_MISSING", "Modify/delete target must exist when the intent is requested.", { target: write.target });
  if (resolved.stat?.isFile() !== true) throw writeError("WRITE_TARGET_INVALID", "Write target must be a regular file.", { target: write.target });
  assertPrivateBusinessFile(resolved.stat, write.target);
  return `sha256:${createHash("sha256").update(await readFile(resolved.absolutePath)).digest("hex")}`;
}

export function assertWrites(writes: WriteIntent[], extraSensitivePaths?: string[]): void {
  if (writes.length !== 1) throw writeError("WRITE_LIST_INVALID", "A write request must contain exactly one target.", { count: writes.length });
  const seen = new Set<string>();
  for (const write of writes) {
    if (!write || typeof write !== "object" || !["create", "modify", "delete"].includes(write.action)) throw writeError("WRITE_INTENT_INVALID", "Write intent action must be create, modify, or delete.");
    const target = write.target;
    if (typeof target !== "string" || target.length === 0 || target.length > MAX_TARGET_LENGTH || target.includes("\0") || target.startsWith("/") || target.split(/[\\/]/).includes("..")) {
      throw writeError("WRITE_TARGET_INVALID", "Write targets must be workspace-relative paths.", { target });
    }
    try {
      assertWorkspacePathPolicy(target, { ...(extraSensitivePaths === undefined ? {} : { sensitiveExtraPaths: extraSensitivePaths }) });
    } catch (error: unknown) {
      throw writeError("WRITE_TARGET_FORBIDDEN", error instanceof Error ? error.message : "Write target is forbidden.", { target });
    }
    const lower = target.toLocaleLowerCase("en-US");
    if (lower === ".stinky-cobbler" || lower.startsWith(".stinky-cobbler/") || lower === ".git" || lower.startsWith(".git/")) {
      throw writeError("WRITE_TARGET_FORBIDDEN", "Control-plane and git metadata paths are never writable.", { target });
    }
    if (isSensitivePath(target, extraSensitivePaths)) throw writeError("WRITE_TARGET_FORBIDDEN", "Sensitive paths are never writable.", { target });
    if (isForbiddenWriteTarget(target)) throw writeError("WRITE_TARGET_FORBIDDEN", "Executable and binary-derived targets are never writable.", { target });
    if (typeof write.purpose !== "string" || write.purpose.length === 0 || write.purpose.length > 512) throw writeError("WRITE_PURPOSE_INVALID", "Write intent purpose must be 1-512 characters.");
    if (seen.has(target)) throw writeError("WRITE_TARGET_DUPLICATE", "Write targets must be unique.", { target });
    seen.add(target);
  }
}

/** Cancels only un-applied intents for one orchestration run. Caller owns the workspace lock. */
export async function cancelWriteIntentsForRun(workspace: LocalWorkspace, runRef: string, reason: string): Promise<WriteIntentRecord[]> {
  const affected: WriteIntentRecord[] = [];
  for (const current of await listWriteIntents(workspace)) {
    if (current.runRef !== runRef || (current.status !== "PENDING" && current.status !== "CONFIRMED")) continue;
    const next: WriteIntentRecord = { ...current, status: "REJECTED", cancelledAt: new Date().toISOString(), cancellationReason: reason };
    await writeWorkspaceJson(workspace, fileName(current.writeIntentId), next);
    affected.push(next);
  }
  return affected;
}

async function safeRollbackTarget(workspace: LocalWorkspace, target: string, allowMissing: boolean, sensitiveExtraPaths?: string[]): Promise<string> {
  const resolved = await resolveRollbackTarget(workspace, target, allowMissing, sensitiveExtraPaths);
  if (resolved.exists) assertPrivateBusinessFile(resolved.stat, target);
  return resolved.absolutePath;
}

async function resolveRollbackTarget(workspace: LocalWorkspace, target: string, allowMissing: boolean, sensitiveExtraPaths?: string[]) {
  try {
    return await resolveWorkspacePath(workspace.root, target, {
      allowMissing,
      ...(sensitiveExtraPaths === undefined ? {} : { sensitiveExtraPaths })
    });
  } catch (error: unknown) {
    throw writeError("WRITE_ROLLBACK_TARGET_INVALID", error instanceof Error ? error.message : "Rollback target is invalid.", { target });
  }
}

async function readRollbackBackup(backupFile: string, target: string): Promise<Buffer> {
  try {
    const info = await lstat(backupFile);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
      throw writeError("WRITE_ROLLBACK_JOURNAL_INVALID", "Rollback backup must be one private regular file.", { target });
    }
    return await readFile(backupFile);
  }
  catch (error: unknown) {
    if (isCode(error, "ENOENT")) throw writeError("WRITE_ROLLBACK_JOURNAL_INVALID", "Rollback backup is missing.", { target });
    throw error;
  }
}

async function hashFile(targetPath: string, target: string): Promise<string> {
  try {
    assertPrivateBusinessFile(await lstat(targetPath), target);
    return `sha256:${createHash("sha256").update(await readFile(targetPath)).digest("hex")}`;
  }
  catch (error: unknown) {
    if (isCode(error, "ENOENT")) throw writeError("WRITE_ROLLBACK_CONFLICT", "Target changed after apply; refusing rollback.", { target });
    throw error;
  }
}

async function assertIntentTargetsNotHardlinked(workspace: LocalWorkspace, intent: WriteIntentRecord): Promise<void> {
  const cfg = await loadOrchestrationConfig(workspace);
  for (const write of intent.writes) {
    const resolved = await resolveWorkspacePath(workspace.root, write.target, {
      allowMissing: true,
      ...(cfg.sensitiveExtraPaths === undefined ? {} : { sensitiveExtraPaths: cfg.sensitiveExtraPaths })
    });
    if (resolved.exists) assertPrivateBusinessFile(resolved.stat, write.target);
  }
}

function assertPrivateBusinessFile(info: { isFile(): boolean; isSymbolicLink(): boolean; nlink: number } | undefined, target: string): void {
  if (info === undefined || !info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
    throw writeError("WRITE_TARGET_HARDLINK_DENIED", "Business write targets must be private regular files with exactly one hard link.", { target, nlink: info?.nlink });
  }
}

async function recordRollbackEvidence(workspace: LocalWorkspace, schemas: SchemaRegistry, writeIntentId: string, target: string, contentHash: string, observedAt: string): Promise<void> {
  const evidence: EvidenceRef = {
    id: `evidence-rollback-${writeIntentId}`,
    kind: "file",
    source: "write-rollback",
    locator: target,
    contentHash,
    observedAt,
    sensitivity: "internal",
    toolCallId: `rollback-${writeIntentId}`
  };
  await recordEvidence(workspace, schemas, evidence);
}

function assertIntentCoordinates(intent: WriteIntentRecord, planId: string, stepId: string): void {
  if (intent.planId !== planId || intent.stepId !== stepId) {
    throw writeError("WRITE_BINDING_MISMATCH", "Write intent is not bound to the requested plan step.", { writeIntentId: intent.writeIntentId, planId, stepId });
  }
}

async function getIntentTaskId(workspace: LocalWorkspace, intent: WriteIntentRecord): Promise<string> {
  if (intent.runRef === undefined && intent.subtaskRef === undefined) {
    const plan = await getPlan(workspace, intent.planId);
    assertCurrentPlanGeneration(plan);
    await assertCurrentPlanExecutionAuthority(workspace, plan);
    const step = plan.steps.find((candidate) => candidate.stepId === intent.stepId);
    if (plan.status !== "EXECUTING" || step?.status !== "RUNNING") {
      throw writeError("WRITE_BINDING_MISMATCH", "Write intent requires its bound plan step to remain RUNNING.", { planId: intent.planId, stepId: intent.stepId });
    }
    return plan.taskId;
  }
  if (intent.runRef === undefined || intent.subtaskRef === undefined) {
    throw writeError("WRITE_BINDING_MISMATCH", "Write intent has incomplete run/subtask coordinates.", { writeIntentId: intent.writeIntentId });
  }
  const { getRun, getSubtask, getActiveContractForRun } = await import("./orchestration.js");
  const run = await getRun(workspace, intent.runRef);
  const contract = await getActiveContractForRun(workspace, run);
  const subtask = await getSubtask(workspace, intent.subtaskRef);
  if ((run.status !== "RUNNING" && run.status !== "DEGRADED") || subtask.status !== "RUNNING" || subtask.runRef !== run.runId || subtask.contractRef !== run.contractRef) {
    throw writeError("WRITE_BINDING_MISMATCH", "Write intent requires its bound run to remain executable and its subtask to remain RUNNING.", { runRef: intent.runRef, subtaskRef: intent.subtaskRef });
  }
  if (intent.parentGrantRef !== contract.contractId || intent.taskId !== contract.taskId || intent.hostSessionId !== contract.hostSessionId) {
    throw writeError("WRITE_REISSUE_REQUIRED", "This subtask WriteIntent was not derived from the Run's current Contract and cannot be confirmed.", {
      writeIntentId: intent.writeIntentId,
      contractId: contract.contractId
    });
  }
  return contract.taskId;
}

function assertWriteIntentId(id: string): void { if (!ID_PATTERN.test(id)) throw writeError("WRITE_INTENT_INVALID", "Write request ID is invalid.", { writeIntentId: id }); }
function fileName(id: string): string { return path.join(DIRECTORY, `${id}.json`); }
function writeError(code: string, message: string, details: Record<string, unknown> = {}): StinkyCobblerError { return new StinkyCobblerError(code, ExitCode.VALIDATION, message, details); }
function isCode(error: unknown, code: string): boolean { return typeof error === "object" && error !== null && "code" in error && error.code === code; }
