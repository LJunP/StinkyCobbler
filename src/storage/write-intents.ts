import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type { EvidenceRef, WriteIntent } from "../contracts/types.js";
import type { SchemaRegistry } from "../contracts/schema-registry.js";
import { ExitCode, StinkyCobblerError } from "../errors.js";
import { appendLedgerEntry } from "./ledger.js";
import type { LocalWorkspace } from "./workspace.js";
import { createWorkspaceJson, workspaceFile, writeWorkspaceJson } from "./workspace.js";
import { withWorkspaceLock } from "./workspace-lock.js";
import { getPlan } from "./plans.js";
import { listApprovals } from "./approvals.js";
import { isApprovalExpired } from "../policy/approval.js";
import { isSensitivePath, isForbiddenWriteTarget } from "../policy/path-policy.js";
import { recordEvidence } from "./evidence.js";

const DIRECTORY = "write-intents";
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const WRITE_CONFIRM_ACTION = "write-confirm";
const MAX_WRITES = 20;
const MAX_TARGET_LENGTH = 512;

export interface WriteIntentRecord {
  version: 1;
  writeIntentId: string;
  planId: string;
  stepId: string;
  /** 2.0 orchestration mode: bound to a run/subtask instead of a plan step. */
  runRef?: string;
  subtaskRef?: string;
  status: "PENDING" | "CONFIRMED" | "REJECTED" | "APPLIED" | "FAILED" | "ROLLED_BACK";
  writes: WriteIntent[];
  confirmedTargets?: string[];
  createdAt: string;
  confirmedAt?: string;
  approvalRef?: string;
  /** True when this intent was auto-allowed (no human write-confirm Approval); only create/modify intents qualify. */
  autoAllowed?: boolean;
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
  options: { autoAllow?: boolean; runRef?: string; subtaskRef?: string } = {}
): Promise<WriteIntentRecord> {
  return withWorkspaceLock(workspace, async () => {
    const isSubtaskMode = options.subtaskRef !== undefined;
    let taskId: string;
    if (isSubtaskMode) {
      const runRef = options.runRef;
      const subtaskRef = options.subtaskRef;
      if (runRef === undefined || subtaskRef === undefined) throw writeError("WRITE_SUBTASK_REF_REQUIRED", "Subtask-mode writes require runRef and subtaskRef.");
      const { getRun, getSubtask } = await import("./orchestration.js");
      const run = await getRun(workspace, runRef);
      if (run.status !== "RUNNING") throw writeError("WRITE_RUN_STATE", "Writes can only be requested for RUNNING orchestration runs.", { runId: runRef, status: run.status });
      const subtask = await getSubtask(workspace, subtaskRef);
      if (subtask.status !== "RUNNING") throw writeError("WRITE_SUBTASK_STATE", "Writes can only be requested for RUNNING subtasks.", { subtaskId: subtaskRef, status: subtask.status });
      const { getContract } = await import("./orchestration.js");
      taskId = (await getContract(workspace, run.contractRef)).taskId;
    } else {
      const plan = await getPlan(workspace, planId);
      if (plan.status !== "EXECUTING") throw writeError("WRITE_PLAN_STATE", "Writes can only be requested for EXECUTING plans.", { planId, status: plan.status });
      const step = plan.steps.find((candidate) => candidate.stepId === stepId);
      if (!step) throw writeError("WRITE_STEP_NOT_FOUND", "Plan step does not exist.", { planId, stepId });
      if (step.status !== "RUNNING") throw writeError("WRITE_STEP_STATE", "Writes can only be requested for RUNNING steps.", { planId, stepId, status: step.status });
      taskId = plan.taskId;
    }
    assertWrites(writes);
    const autoAllow = options.autoAllow === true;
    if (autoAllow && writes.some((write) => write.action === "delete")) {
      throw writeError("WRITE_AUTO_ALLOW_DELETE_DENIED", "Delete intents can never be auto-allowed; use the explicit write-confirm flow.", { planId, stepId });
    }
    await mkdir(await workspaceFile(workspace, DIRECTORY), { recursive: true, mode: 0o700 });
    const record: WriteIntentRecord = {
      version: 1,
      writeIntentId: `write-${randomUUID()}`,
      planId,
      stepId,
      ...(isSubtaskMode ? { runRef: options.runRef, subtaskRef: options.subtaskRef } : {}),
      status: autoAllow ? "CONFIRMED" : "PENDING",
      writes,
      ...(autoAllow ? { confirmedTargets: writes.map((write) => write.target), confirmedAt: new Date().toISOString(), autoAllowed: true } : {}),
      createdAt: new Date().toISOString()
    };
    await createWorkspaceJson(workspace, fileName(record.writeIntentId), record);
    await appendLedgerEntry(workspace, {
      event: "write-requested",
      taskId,
      planRef: planId,
      ...(isSubtaskMode ? { runRef: options.runRef, subtaskRef: options.subtaskRef } : {}),
      writeIntentRef: record.writeIntentId,
      summary: `Write request ${record.writeIntentId} for ${writes.length} target(s).`
    });
    if (autoAllow) {
      await appendLedgerEntry(workspace, {
        event: "write-auto-allowed",
        taskId,
        planRef: planId,
        ...(isSubtaskMode ? { runRef: options.runRef, subtaskRef: options.subtaskRef } : {}),
        writeIntentRef: record.writeIntentId,
        summary: `Write request ${record.writeIntentId} auto-allowed (${writes.length} target(s)); no human write-confirm Approval.`
      });
    }
    return record;
  });
}

/** Confirms a write request only when a matching approved write-confirm Approval exists. */
export async function confirmWrites(workspace: LocalWorkspace, planId: string, stepId: string, writeIntentId: string): Promise<WriteIntentRecord> {
  return withWorkspaceLock(workspace, async () => {
    const current = await getWriteIntent(workspace, writeIntentId);
    if (current.status === "CONFIRMED") return current;
    if (current.status !== "PENDING") throw writeError("WRITE_STATE_CONFLICT", "Only PENDING write requests can be confirmed.", { writeIntentId, status: current.status });
    const plan = await getPlan(workspace, planId);
    const approvals = await listApprovals(workspace, plan.taskId);
    const requestedTargets = new Set(current.writes.map((write) => write.target));
    const matches = approvals.filter((approval) =>
      approval.action === WRITE_CONFIRM_ACTION &&
      approval.status === "approved" &&
      !isApprovalExpired(approval) &&
      (approval.scope ?? []).length > 0 &&
      (approval.scope ?? []).every((target) => requestedTargets.has(target))
    ).sort((left, right) => left.requestedAt.localeCompare(right.requestedAt));
    const match = matches[0];
    if (!match) throw writeError("WRITE_CONFIRMATION_REQUIRED", "An approved write-confirm Approval matching the requested targets is required.", { writeIntentId });
    const next: WriteIntentRecord = { ...current, status: "CONFIRMED", ...(match.scope === undefined ? {} : { confirmedTargets: match.scope }), confirmedAt: new Date().toISOString(), approvalRef: match.id };
    await writeWorkspaceJson(workspace, fileName(writeIntentId), next);
    await appendLedgerEntry(workspace, { event: "write-confirmed", taskId: plan.taskId, planRef: planId, writeIntentRef: writeIntentId, approvalRef: match.id, summary: `Write request ${writeIntentId} confirmed for ${(match.scope ?? []).length} target(s).` });
    return next;
  });
}

/** Rejects a pending write request. Idempotent for already-rejected requests. */
export async function rejectWrites(workspace: LocalWorkspace, planId: string, stepId: string, writeIntentId: string, reason: string): Promise<WriteIntentRecord> {
  return withWorkspaceLock(workspace, async () => {
    if (!reason || reason.length > 512) throw writeError("WRITE_REJECT_REASON_INVALID", "Rejection reason must be 1-512 characters.");
    const current = await getWriteIntent(workspace, writeIntentId);
    if (current.status === "REJECTED") return current;
    if (current.status !== "PENDING") throw writeError("WRITE_STATE_CONFLICT", "Only PENDING write requests can be rejected.", { writeIntentId, status: current.status });
    const next: WriteIntentRecord = { ...current, status: "REJECTED" };
    await writeWorkspaceJson(workspace, fileName(writeIntentId), next);
    await appendLedgerEntry(workspace, { event: "write-rejected", writeIntentRef: writeIntentId, summary: `Write request ${writeIntentId} rejected: ${reason}` });
    return next;
  });
}

export async function getWriteIntent(workspace: LocalWorkspace, writeIntentId: string): Promise<WriteIntentRecord> {
  assertWriteIntentId(writeIntentId);
  try {
    return JSON.parse(await readFile(await workspaceFile(workspace, fileName(writeIntentId)), "utf8")) as WriteIntentRecord;
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
 * pre-write backup, records restoration Evidence, appends a `write-rolled-back`
 * ledger event, and marks the intent ROLLED_BACK. Targets without a backup
 * (created files) are reported and skipped rather than deleted.
 */
export async function rollbackWrite(workspace: LocalWorkspace, schemas: SchemaRegistry, planId: string, stepId: string, writeIntentId: string, reason: string): Promise<WriteIntentRecord> {
  return withWorkspaceLock(workspace, async () => {
    if (!reason || reason.length > 512) throw writeError("WRITE_ROLLBACK_REASON_INVALID", "Rollback reason must be 1-512 characters.");
    const current = await getWriteIntent(workspace, writeIntentId);
    if (current.status === "ROLLED_BACK") throw writeError("WRITE_ALREADY_ROLLED_BACK", "This write request has already been rolled back.", { writeIntentId });
    if (current.status !== "APPLIED") throw writeError("WRITE_NOT_APPLIED", "Only APPLIED write requests can be rolled back.", { writeIntentId, status: current.status });
    const backupDirectory = path.join(workspace.directory, "backups", `write-${writeIntentId}`);
    const restored: string[] = [];
    const skipped: string[] = [];
    for (const target of current.confirmedTargets ?? []) {
      const backupFile = path.join(backupDirectory, target);
      let backup: Buffer;
      try {
        backup = await readFile(backupFile);
      } catch (error: unknown) {
        if (isCode(error, "ENOENT")) { skipped.push(target); continue; }
        throw error;
      }
      const content = backup.toString("utf8");
      const absoluteTarget = path.resolve(workspace.root, target);
      await mkdir(path.dirname(absoluteTarget), { recursive: true });
      const temporary = path.join(path.dirname(absoluteTarget), `.${path.basename(absoluteTarget)}.${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
        await rename(temporary, absoluteTarget);
      } finally {
        await rm(temporary, { force: true }).catch(() => undefined);
      }
      const evidence: EvidenceRef = {
        id: `evidence-${randomUUID()}`,
        kind: "file",
        source: "write-rollback",
        locator: target,
        contentHash: `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`,
        observedAt: new Date().toISOString(),
        sensitivity: "internal",
        toolCallId: `rollback-${writeIntentId}`
      };
      await recordEvidence(workspace, schemas, evidence);
      restored.push(target);
    }
    let taskId: string;
    let runRef: string | undefined;
    let subtaskRef: string | undefined;
    if (current.runRef !== undefined && current.subtaskRef !== undefined) {
      const { getRun, getContract } = await import("./orchestration.js");
      const run = await getRun(workspace, current.runRef);
      taskId = (await getContract(workspace, run.contractRef)).taskId;
      runRef = current.runRef;
      subtaskRef = current.subtaskRef;
    } else {
      taskId = (await getPlan(workspace, planId)).taskId;
    }
    await appendLedgerEntry(workspace, {
      event: "write-rolled-back",
      taskId,
      ...(runRef === undefined ? {} : { runRef }),
      ...(subtaskRef === undefined ? {} : { subtaskRef }),
      planRef: planId,
      writeIntentRef: writeIntentId,
      summary: `Write request ${writeIntentId} rolled back (${restored.length} restored, ${skipped.length} skipped): ${reason}`
    });
    const next: WriteIntentRecord = { ...current, status: "ROLLED_BACK" };
    await writeWorkspaceJson(workspace, fileName(writeIntentId), next);
    return next;
  });
}

export function assertWrites(writes: WriteIntent[]): void {
  if (writes.length === 0 || writes.length > MAX_WRITES) throw writeError("WRITE_LIST_INVALID", `A write request must contain 1-${MAX_WRITES} intents.`, { count: writes.length });
  const seen = new Set<string>();
  for (const write of writes) {
    if (!write || typeof write !== "object" || !["create", "modify", "delete"].includes(write.action)) throw writeError("WRITE_INTENT_INVALID", "Write intent action must be create, modify, or delete.");
    const target = write.target;
    if (typeof target !== "string" || target.length === 0 || target.length > MAX_TARGET_LENGTH || target.includes("\0") || target.startsWith("/") || target.split(/[\\/]/).includes("..")) {
      throw writeError("WRITE_TARGET_INVALID", "Write targets must be workspace-relative paths.", { target });
    }
    if (target === ".stinky-cobbler" || target.startsWith(".stinky-cobbler/") || target === ".git" || target.startsWith(".git/")) {
      throw writeError("WRITE_TARGET_FORBIDDEN", "Control-plane and git metadata paths are never writable.", { target });
    }
    if (isSensitivePath(target)) throw writeError("WRITE_TARGET_FORBIDDEN", "Sensitive paths are never writable.", { target });
    if (isForbiddenWriteTarget(target)) throw writeError("WRITE_TARGET_FORBIDDEN", "Executable and binary-derived targets are never writable.", { target });
    if (typeof write.purpose !== "string" || write.purpose.length === 0 || write.purpose.length > 512) throw writeError("WRITE_PURPOSE_INVALID", "Write intent purpose must be 1-512 characters.");
    if (seen.has(target)) throw writeError("WRITE_TARGET_DUPLICATE", "Write targets must be unique.", { target });
    seen.add(target);
  }
}

function assertWriteIntentId(id: string): void { if (!ID_PATTERN.test(id)) throw writeError("WRITE_INTENT_INVALID", "Write request ID is invalid.", { writeIntentId: id }); }
function fileName(id: string): string { return path.join(DIRECTORY, `${id}.json`); }
function writeError(code: string, message: string, details: Record<string, unknown> = {}): StinkyCobblerError { return new StinkyCobblerError(code, ExitCode.VALIDATION, message, details); }
function isCode(error: unknown, code: string): boolean { return typeof error === "object" && error !== null && "code" in error && error.code === code; }
