import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { ExitCode, StinkyCobblerError } from "../errors.js";
import type { LocalWorkspace } from "./workspace.js";
import { createWorkspaceJson, workspaceFile, writeWorkspaceJson } from "./workspace.js";
import { withWorkspaceLock } from "./workspace-lock.js";

/**
 * Audit outbox data lives in one workspace metadata file. Keeping the outbox as
 * a single JSON document means this module never needs to create a directory or
 * write anywhere outside `.stinky-cobbler`.
 */
export const AUDIT_OUTBOX_FILE = "audit-outbox.json";
/** @deprecated Use `AUDIT_OUTBOX_FILE`; retained for callers of the initial API. */
export const AUDIT_OUTBOX_DIRECTORY = "audit-outbox";

export type AuditOutcome = "completed" | "rejected" | "failed";
export type AuditStage = "prepared" | "recovery-required" | "committed";

export interface AuditOutboxRecord {
  id: string;
  callId: string;
  taskId: string;
  role: string;
  tool: string;
  outcome: AuditOutcome;
  receiptId: string;
  stage: AuditStage;
  createdAt: string;
  attempts: number;
  /** Stable machine-readable code for the most recent recovery failure. */
  errorCode?: string;
  /** @deprecated Use `errorCode`; accepted for compatibility with the first API draft. */
  lastErrorCode?: string;
}

export type CreateAuditOutboxInput = Pick<
  AuditOutboxRecord,
  "callId" | "taskId" | "role" | "tool" | "outcome" | "receiptId"
>;

export interface UpdateAuditOutboxInput {
  stage: AuditStage;
  attempts?: number;
  errorCode?: string;
  /** @deprecated Use `errorCode`. */
  lastErrorCode?: string;
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const STABLE_ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/;
const OUTCOMES: readonly AuditOutcome[] = ["completed", "rejected", "failed"];
const STAGES: readonly AuditStage[] = ["prepared", "recovery-required", "committed"];
const queues = new Map<string, Promise<unknown>>();

/**
 * Creates an outbox record, or returns the existing record for the same callId.
 * The callId lookup and create are serialized per workspace so retries in one
 * process cannot produce duplicate records.
 */
export async function createAuditOutbox(
  workspace: LocalWorkspace,
  input: CreateAuditOutboxInput
): Promise<AuditOutboxRecord> {
  return serialize(workspace.directory, () => withWorkspaceLock(workspace, async () => {
    validateCreateInput(input);
    const records = await readOutbox(workspace);
    const existing = records.find((record) => record.callId === input.callId);
    if (existing) {
      if (existing.taskId !== input.taskId || existing.role !== input.role || existing.tool !== input.tool || existing.outcome !== input.outcome || existing.receiptId !== input.receiptId) {
        throw new StinkyCobblerError("AUDIT_IDEMPOTENCY_CONFLICT", ExitCode.POLICY_DENIED, "Audit callId was reused with different request data.", { callId: input.callId });
      }
      return existing;
    }
    const receiptOwner = records.find((record) => record.receiptId === input.receiptId);
    if (receiptOwner !== undefined && receiptOwner.callId !== input.callId) {
      throw new StinkyCobblerError(
        "AUDIT_RECEIPT_ID_CONFLICT",
        ExitCode.POLICY_DENIED,
        "Audit receiptId is already associated with a different callId.",
        { receiptId: input.receiptId, callId: input.callId, existingCallId: receiptOwner.callId }
      );
    }

    const record: AuditOutboxRecord = {
      id: `audit-${randomUUID()}`,
      ...input,
      stage: "prepared",
      createdAt: new Date().toISOString(),
      attempts: 0
    };
    const next = [...records, record];
    await saveOutbox(workspace, next, records.length === 0);
    return record;
  }));
}

export async function getAuditOutbox(workspace: LocalWorkspace, id: string): Promise<AuditOutboxRecord> {
  return withWorkspaceLock(workspace, async () => {
    assertId(id, "Audit outbox ID is invalid.", { id });
    const record = (await readOutbox(workspace)).find((candidate) => candidate.id === id);
    if (!record) {
      throw new StinkyCobblerError("AUDIT_OUTBOX_NOT_FOUND", ExitCode.VALIDATION, "Audit outbox record does not exist.", { id });
    }
    return record;
  });
}

/** Returns the idempotency record for callId, or undefined when it is unknown. */
export async function findAuditByCallId(workspace: LocalWorkspace, callId: string): Promise<AuditOutboxRecord | undefined> {
  return withWorkspaceLock(workspace, async () => {
    assertId(callId, "Audit call ID is invalid.", { callId });
    return (await readOutbox(workspace)).find((record) => record.callId === callId);
  });
}

export async function listAuditOutbox(workspace: LocalWorkspace): Promise<AuditOutboxRecord[]> {
  return withWorkspaceLock(workspace, () => readOutbox(workspace));
}

export async function updateAuditOutbox(
  workspace: LocalWorkspace,
  id: string,
  patch: UpdateAuditOutboxInput
): Promise<AuditOutboxRecord> {
  return serialize(workspace.directory, () => withWorkspaceLock(workspace, async () => {
    assertId(id, "Audit outbox ID is invalid.", { id });
    validateUpdateInput(patch, id);
    const records = await readOutbox(workspace);
    const index = records.findIndex((record) => record.id === id);
    if (index < 0) {
      throw new StinkyCobblerError("AUDIT_OUTBOX_NOT_FOUND", ExitCode.VALIDATION, "Audit outbox record does not exist.", { id });
    }

    const current = records[index]!;
    const suppliedErrorCode = patch.errorCode ?? patch.lastErrorCode;
    if (STAGES.indexOf(patch.stage) < STAGES.indexOf(current.stage) || (patch.attempts !== undefined && patch.attempts < current.attempts)) {
      throw new StinkyCobblerError("AUDIT_OUTBOX_STATE_REGRESSION", ExitCode.POLICY_DENIED, "Audit outbox state cannot move backwards.", { id });
    }
    const next: AuditOutboxRecord = {
      ...current,
      stage: patch.stage,
      attempts: patch.attempts ?? current.attempts,
      ...(suppliedErrorCode === undefined ? {} : { errorCode: suppliedErrorCode, lastErrorCode: suppliedErrorCode })
    };
    const nextRecords = records.slice();
    nextRecords[index] = next;
    await saveOutbox(workspace, nextRecords, false);
    return next;
  }));
}

async function readOutbox(workspace: LocalWorkspace): Promise<AuditOutboxRecord[]> {
  const target = await workspaceFile(workspace, AUDIT_OUTBOX_FILE);
  let serialized: string;
  try {
    serialized = await readFile(target, "utf8");
  } catch (error: unknown) {
    if (isNotFound(error)) return [];
    throw error;
  }

  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw invalid("Audit outbox contains invalid JSON.", {});
  }
  if (!Array.isArray(value)) throw invalid("Audit outbox must contain an array.", {});
  return value.map((record, index) => validateRecord(record, index));
}

async function saveOutbox(workspace: LocalWorkspace, records: AuditOutboxRecord[], create: boolean): Promise<void> {
  if (!create) {
    await writeWorkspaceJson(workspace, AUDIT_OUTBOX_FILE, records);
    return;
  }
  try {
    await createWorkspaceJson(workspace, AUDIT_OUTBOX_FILE, records);
  } catch (error: unknown) {
    // An existing empty outbox is valid metadata; update it rather than trying
    // to create the same file again.
    if (!isAlreadyExists(error)) throw error;
    await writeWorkspaceJson(workspace, AUDIT_OUTBOX_FILE, records);
  }
}

function validateCreateInput(input: CreateAuditOutboxInput): void {
  if (!isPlainObject(input)) throw invalid("Audit outbox input must be an object.", {});
  const supplied = Object.keys(input);
  const allowed = new Set(["callId", "taskId", "role", "tool", "outcome", "receiptId"]);
  const forbidden = supplied.filter((key) => !allowed.has(key));
  if (forbidden.length > 0) throw invalid("Audit outbox assigns id, stage, timestamp, and attempts.", { forbidden });
  assertId(input.callId, "Audit call ID is invalid.", { callId: input.callId });
  assertId(input.taskId, "Audit task ID is invalid.", { taskId: input.taskId });
  assertId(input.receiptId, "Audit receipt ID is invalid.", { receiptId: input.receiptId });
  assertText(input.role, "Audit role is invalid.", { role: input.role });
  assertText(input.tool, "Audit tool is invalid.", { tool: input.tool });
  if (!OUTCOMES.includes(input.outcome)) throw invalid("Audit outcome is invalid.", { outcome: input.outcome });
}

function validateUpdateInput(patch: UpdateAuditOutboxInput, id: string): void {
  if (!isPlainObject(patch)) throw invalid("Audit outbox update must be an object.", { id });
  const allowed = new Set(["stage", "attempts", "errorCode", "lastErrorCode"]);
  const forbidden = Object.keys(patch).filter((key) => !allowed.has(key));
  if (forbidden.length > 0) throw invalid("Audit outbox update contains unsupported fields.", { id, forbidden });
  if (!STAGES.includes(patch.stage)) throw invalid("Audit outbox stage is invalid.", { id, stage: patch.stage });
  if (patch.attempts !== undefined && (!Number.isSafeInteger(patch.attempts) || patch.attempts < 0)) {
    throw invalid("Audit outbox attempts must be a non-negative integer.", { id, attempts: patch.attempts });
  }
  if (patch.errorCode !== undefined) assertErrorCode(patch.errorCode, id);
  if (patch.lastErrorCode !== undefined) assertErrorCode(patch.lastErrorCode, id);
  if (patch.errorCode !== undefined && patch.lastErrorCode !== undefined && patch.errorCode !== patch.lastErrorCode) {
    throw invalid("Audit outbox errorCode and lastErrorCode must match.", { id });
  }
}

function validateRecord(value: unknown, index: number): AuditOutboxRecord {
  if (!isPlainObject(value)) throw invalid("Audit outbox record is invalid.", { index });
  const record = value as Partial<AuditOutboxRecord>;
  const allowed = new Set([
    "id", "callId", "taskId", "role", "tool", "outcome", "receiptId", "stage", "createdAt", "attempts", "errorCode", "lastErrorCode"
  ]);
  const forbidden = Object.keys(record).filter((key) => !allowed.has(key));
  if (forbidden.length > 0) throw invalid("Audit outbox record contains unsupported fields.", { index, forbidden });
  assertId(record.id, "Audit outbox ID is invalid.", { index, id: record.id });
  assertId(record.callId, "Audit call ID is invalid.", { index, callId: record.callId });
  assertId(record.taskId, "Audit task ID is invalid.", { index, taskId: record.taskId });
  assertId(record.receiptId, "Audit receipt ID is invalid.", { index, receiptId: record.receiptId });
  assertText(record.role, "Audit role is invalid.", { index });
  assertText(record.tool, "Audit tool is invalid.", { index });
  if (!OUTCOMES.includes(record.outcome as AuditOutcome)) throw invalid("Audit outcome is invalid.", { index, outcome: record.outcome });
  if (!STAGES.includes(record.stage as AuditStage)) throw invalid("Audit outbox stage is invalid.", { index, stage: record.stage });
  if (typeof record.createdAt !== "string" || !isCanonicalIsoDate(record.createdAt)) throw invalid("Audit createdAt must be a canonical ISO timestamp.", { index });
  if (typeof record.attempts !== "number" || !Number.isSafeInteger(record.attempts) || record.attempts < 0) throw invalid("Audit outbox attempts must be a non-negative integer.", { index });
  if (record.errorCode !== undefined) assertErrorCode(record.errorCode, String(index));
  if (record.lastErrorCode !== undefined) assertErrorCode(record.lastErrorCode, String(index));
  if (record.errorCode !== undefined && record.lastErrorCode !== undefined && record.errorCode !== record.lastErrorCode) {
    throw invalid("Audit outbox errorCode and lastErrorCode must match.", { index });
  }
  return record as AuditOutboxRecord;
}

function assertId(value: unknown, message: string, details: Record<string, unknown>): asserts value is string {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) throw invalid(message, details);
}

function assertText(value: unknown, message: string, details: Record<string, unknown>): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) throw invalid(message, details);
}

function assertErrorCode(value: unknown, id: string): asserts value is string {
  if (typeof value !== "string" || !STABLE_ERROR_CODE_PATTERN.test(value)) throw invalid("Audit error code is invalid.", { id, errorCode: value });
}

function isCanonicalIsoDate(value: string): boolean {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

function invalid(message: string, details: Record<string, unknown>): StinkyCobblerError {
  return new StinkyCobblerError("AUDIT_OUTBOX_INVALID", ExitCode.VALIDATION, message, details);
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function serialize<T>(directory: string, operation: () => Promise<T>): Promise<T> {
  const preceding = queues.get(directory) ?? Promise.resolve();
  const current = preceding.catch(() => undefined).then(operation);
  queues.set(directory, current);
  void current.finally(() => {
    if (queues.get(directory) === current) queues.delete(directory);
  }).catch(() => undefined);
  return current;
}
