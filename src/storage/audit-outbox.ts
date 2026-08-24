import { createHash } from "node:crypto";
import { lstat, readFile, readdir, unlink } from "node:fs/promises";
import { defaultSchemaRegistry } from "../contracts/default-schema-registry.js";
import { ExitCode, StinkyCobblerError } from "../errors.js";
import type { LocalWorkspace } from "./workspace.js";
import { createWorkspaceDirectory, createWorkspaceJson, workspaceFile, writeWorkspaceJson } from "./workspace.js";
import { withWorkspaceLock } from "./workspace-lock.js";

/** Legacy v1 aggregate path; v2 replaces its array with a small layout manifest. */
export const AUDIT_OUTBOX_FILE = "audit-outbox.json";
/** @deprecated Retained for callers of the initial API; v2 stores bounded records below it. */
export const AUDIT_OUTBOX_DIRECTORY = "audit-outbox";
export const MAX_AUDIT_OUTBOX_PENDING = 256;
export const MAX_AUDIT_OUTBOX_LIST_BATCH = 256;
export const MAX_AUDIT_OUTBOX_RECORD_BYTES = 16 * 1024;
export const MAX_AUDIT_OUTBOX_LEGACY_RECORDS = 1024;
export const MAX_AUDIT_OUTBOX_LEGACY_BYTES = MAX_AUDIT_OUTBOX_LEGACY_RECORDS * MAX_AUDIT_OUTBOX_RECORD_BYTES;

const RECORDS_DIRECTORY = `${AUDIT_OUTBOX_DIRECTORY}/records`;
const CALLS_DIRECTORY = `${AUDIT_OUTBOX_DIRECTORY}/calls`;
const RECEIPTS_DIRECTORY = `${AUDIT_OUTBOX_DIRECTORY}/receipts`;
const PENDING_DIRECTORY = `${AUDIT_OUTBOX_DIRECTORY}/pending`;
const LAYOUT_VERSION = 2;

export type AuditOutcome = "unknown" | "completed" | "rejected" | "failed";
export type AuditStage = "prepared" | "recovery-required" | "committed";

export interface AuditOutboxRecord {
  id: string;
  callId: string;
  taskId: string;
  role: string;
  tool: string;
  /** Persisted authority provenance; absent only on readable legacy records. */
  leaseId?: string;
  taskAuthorityHash?: string;
  capability?: string;
  operation?: string;
  reservationId?: string;
  reservationOrdinal?: number;
  outcome: AuditOutcome;
  receiptId: string;
  stage: AuditStage;
  createdAt: string;
  attempts: number;
  errorCode?: string;
  /** @deprecated Use `errorCode`; accepted for compatibility with the first API draft. */
  lastErrorCode?: string;
}

export type CreateAuditOutboxInput = Pick<AuditOutboxRecord,
  "callId" | "taskId" | "role" | "tool" | "leaseId" | "taskAuthorityHash" | "capability" | "operation" |
  "reservationId" | "reservationOrdinal" | "outcome" | "receiptId"
>;
export interface UpdateAuditOutboxInput {
  stage: AuditStage;
  attempts?: number;
  errorCode?: string;
  /** @deprecated Use `errorCode`. */
  lastErrorCode?: string;
}

interface AuditOutboxManifest {
  version: 2;
  recordsDirectory: typeof RECORDS_DIRECTORY;
  callsDirectory: typeof CALLS_DIRECTORY;
  receiptsDirectory: typeof RECEIPTS_DIRECTORY;
  pendingDirectory: typeof PENDING_DIRECTORY;
}
interface CallIndex { version: 1; callId: string; recordId: string; receiptId: string; requestHash: string; }
interface ReceiptIndex { version: 1; receiptId: string; recordId: string; }
interface LegacyPendingMarker { version: 1; recordId: string; }
interface RecoverablePendingMarker {
  version: 2;
  recordId: string;
  requestHash: string;
  record: AuditOutboxRecord;
}
type PendingMarker = LegacyPendingMarker | RecoverablePendingMarker;
type Layout = { kind: "absent" } | { kind: "legacy"; records: AuditOutboxRecord[] } | { kind: "v2" };

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const STABLE_ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/;
const OUTCOMES: readonly AuditOutcome[] = ["unknown", "completed", "rejected", "failed"];
const STAGES: readonly AuditStage[] = ["prepared", "recovery-required", "committed"];
const queues = new Map<string, Promise<unknown>>();
const createFaults = new Map<string, "after-marker" | "after-call-index" | "after-receipt-index">();

/**
 * V2 stores each record and lookup index in a bounded file. The normal
 * create/find/update paths therefore never read all historical audit records.
 * The v1 array is replaced only after every v2 record and index is durable.
 */
export async function createAuditOutbox(workspace: LocalWorkspace, input: CreateAuditOutboxInput): Promise<AuditOutboxRecord> {
  return serialize(workspace.directory, () => withWorkspaceLock(workspace, async () => {
    validateCreateInput(input);
    await ensureV2Layout(workspace);
    const requestHash = hashCreateInput(input);
    const recordId = recordIdForCall(input.callId);
    const existingIndex = await readCallIndex(workspace, input.callId);
    if (existingIndex !== undefined) {
      if (existingIndex.recordId !== recordId || existingIndex.receiptId !== input.receiptId || existingIndex.requestHash !== requestHash) {
        throw conflict("AUDIT_IDEMPOTENCY_CONFLICT", "Audit callId was reused with different request data.", { callId: input.callId });
      }
      const existing = await readRecord(workspace, existingIndex.recordId);
      if (existing !== undefined) return existing;
      // A crash may persist indexes before the record. Only an exact retry may rebuild it.
    }
    const receiptOwner = await readReceiptIndex(workspace, input.receiptId);
    if (receiptOwner !== undefined && receiptOwner.recordId !== recordId) {
      throw conflict("AUDIT_RECEIPT_ID_CONFLICT", "Audit receiptId is already associated with a different callId.", { receiptId: input.receiptId, callId: input.callId, existingRecordId: receiptOwner.recordId });
    }
    await assertPendingCapacity(workspace, recordId);
    const marker = await readPendingMarker(workspace, recordId);
    if (marker?.version === 2 && marker.requestHash !== requestHash) {
      throw conflict("AUDIT_IDEMPOTENCY_CONFLICT", "Audit pending marker is bound to different request data.", { callId: input.callId, recordId });
    }
    const record: AuditOutboxRecord = marker?.version === 2
      ? marker.record
      : { id: recordId, ...input, stage: "prepared", createdAt: new Date().toISOString(), attempts: 0 };
    // The fail-closed marker is the first durable create effect. Any later
    // index/record split is visible to the next MCP preflight instead of
    // becoming a silently missing audit.
    await ensurePendingMarker(workspace, record);
    maybeInjectCreateFault(workspace, "after-marker");
    await ensureCallIndex(workspace, { version: 1, callId: input.callId, recordId, receiptId: input.receiptId, requestHash });
    maybeInjectCreateFault(workspace, "after-call-index");
    await ensureReceiptIndex(workspace, { version: 1, receiptId: input.receiptId, recordId });
    maybeInjectCreateFault(workspace, "after-receipt-index");
    await ensureRecord(workspace, record);
    return record;
  }));
}

/** Test-only, single-use audit create crash point. */
export function injectAuditOutboxCreateFaultForTesting(
  workspace: LocalWorkspace,
  point: "after-marker" | "after-call-index" | "after-receipt-index"
): void {
  if (process.env.NODE_ENV !== "test") throw invalid("Audit outbox create fault injection is available only under the test runner.", { point });
  createFaults.set(workspace.directory, point);
}

function maybeInjectCreateFault(workspace: LocalWorkspace, point: "after-marker" | "after-call-index" | "after-receipt-index"): void {
  if (createFaults.get(workspace.directory) !== point) return;
  createFaults.delete(workspace.directory);
  throw new StinkyCobblerError("AUDIT_OUTBOX_CREATE_FAULT", ExitCode.POLICY_DENIED, `Injected audit outbox create fault at ${point}.`, { point });
}

export async function getAuditOutbox(workspace: LocalWorkspace, id: string): Promise<AuditOutboxRecord> {
  return withWorkspaceLock(workspace, async () => {
    assertId(id, "Audit outbox ID is invalid.", { id });
    const layout = await readLayout(workspace);
    const record = layout.kind === "legacy" ? layout.records.find((candidate) => candidate.id === id) : layout.kind === "v2" ? await readRecord(workspace, id) : undefined;
    if (record === undefined) throw new StinkyCobblerError("AUDIT_OUTBOX_NOT_FOUND", ExitCode.VALIDATION, "Audit outbox record does not exist.", { id });
    return record;
  });
}

/** Returns an idempotency record by direct call index in v2. */
export async function findAuditByCallId(workspace: LocalWorkspace, callId: string): Promise<AuditOutboxRecord | undefined> {
  return withWorkspaceLock(workspace, async () => {
    assertId(callId, "Audit call ID is invalid.", { callId });
    const layout = await readLayout(workspace);
    if (layout.kind === "legacy") return layout.records.find((record) => record.callId === callId);
    if (layout.kind === "absent") return undefined;
    const index = await readCallIndex(workspace, callId);
    if (index === undefined) return undefined;
    const record = await readRecord(workspace, index.recordId);
    // A create may crash after its call index is durable but before its record.
    // Returning undefined lets createAuditOutbox re-admit only an exact request;
    // pending-marker reads remain fail-closed if that incomplete record blocks work.
    if (record === undefined) return undefined;
    if (record.callId !== callId || record.receiptId !== index.receiptId) throw invalid("Audit call index conflicts with its record.", { callId, recordId: record.id });
    return record;
  });
}

/** Compatibility listing API. Deliberately bounded; runtime uses listPendingAuditOutbox. */
export async function listAuditOutbox(workspace: LocalWorkspace): Promise<AuditOutboxRecord[]> {
  return withWorkspaceLock(workspace, async () => {
    const layout = await readLayout(workspace);
    if (layout.kind === "absent") return [];
    if (layout.kind === "legacy") return assertListBatch(layout.records);
    const names = await listDirectory(workspace, RECORDS_DIRECTORY);
    const recordNames = names.filter((name) => /^audit-[A-Za-z0-9_-]{1,127}\.json$/.test(name)).sort();
    if (recordNames.length !== names.length) throw invalid("Audit outbox records directory contains an unexpected entry.", { names });
    if (recordNames.length > MAX_AUDIT_OUTBOX_LIST_BATCH) throw batchLimit(recordNames.length);
    const records = await Promise.all(recordNames.map((name) => readRecord(workspace, name.slice(0, -5))));
    return validateAggregate(records.map((record, index) => {
      if (record === undefined) throw recoveryRequired("Audit record disappeared during listing.", { index });
      return record;
    }));
  });
}

/** Scans only bounded pending markers; this is the gate used before MCP execution. */
export async function listPendingAuditOutbox(workspace: LocalWorkspace): Promise<AuditOutboxRecord[]> {
  return withWorkspaceLock(workspace, async () => {
    const layout = await readLayout(workspace);
    if (layout.kind === "absent") return [];
    if (layout.kind === "legacy") return layout.records.filter((record) => record.stage !== "committed");
    const names = await listDirectory(workspace, PENDING_DIRECTORY);
    if (names.length > MAX_AUDIT_OUTBOX_PENDING) throw pendingLimit(names.length);
    const markers = names.filter((name) => /^audit-[A-Za-z0-9_-]{1,127}\.json$/.test(name)).sort();
    if (markers.length !== names.length) throw invalid("Audit pending directory contains an unexpected entry.", { names });
    const pending: AuditOutboxRecord[] = [];
    for (const name of markers) {
      const marker = await readPendingMarker(workspace, name.slice(0, -5));
      if (marker === undefined) throw recoveryRequired("Audit pending marker disappeared during listing.", { name });
      let record = await readRecord(workspace, marker.recordId);
      if (record === undefined) {
        if (marker.version !== 2) throw recoveryRequired("A legacy Audit pending marker lacks the bounded request needed for automatic recovery.", { recordId: marker.recordId });
        record = await materializePendingMarker(workspace, marker);
      }
      if (record.stage === "committed") await removePendingMarker(workspace, marker.recordId);
      else pending.push(record);
    }
    return validateAggregate(pending);
  });
}

export async function updateAuditOutbox(workspace: LocalWorkspace, id: string, patch: UpdateAuditOutboxInput): Promise<AuditOutboxRecord> {
  return serialize(workspace.directory, () => withWorkspaceLock(workspace, async () => {
    assertId(id, "Audit outbox ID is invalid.", { id });
    validateUpdateInput(patch, id);
    await ensureV2Layout(workspace);
    const current = await readRecord(workspace, id);
    if (current === undefined) throw new StinkyCobblerError("AUDIT_OUTBOX_NOT_FOUND", ExitCode.VALIDATION, "Audit outbox record does not exist.", { id });
    const suppliedErrorCode = patch.errorCode ?? patch.lastErrorCode;
    if (STAGES.indexOf(patch.stage) < STAGES.indexOf(current.stage) || (patch.attempts !== undefined && patch.attempts < current.attempts)) {
      throw new StinkyCobblerError("AUDIT_OUTBOX_STATE_REGRESSION", ExitCode.POLICY_DENIED, "Audit outbox state cannot move backwards.", { id });
    }
    const next: AuditOutboxRecord = { ...current, stage: patch.stage, attempts: patch.attempts ?? current.attempts, ...(suppliedErrorCode === undefined ? {} : { errorCode: suppliedErrorCode, lastErrorCode: suppliedErrorCode }) };
    await saveRecord(workspace, next);
    if (next.stage === "committed") await removePendingMarker(workspace, id);
    else await savePendingMarker(workspace, next);
    return next;
  }));
}

/**
 * Commits the observed outcome of an execution-prepared record. `unknown` is
 * inert and recoverable; it may move exactly once to a terminal outcome, but
 * one terminal outcome can never be rewritten as another.
 */
export async function finalizeAuditOutboxOutcome(
  workspace: LocalWorkspace,
  id: string,
  outcome: Exclude<AuditOutcome, "unknown">
): Promise<AuditOutboxRecord> {
  return serialize(workspace.directory, () => withWorkspaceLock(workspace, async () => {
    assertId(id, "Audit outbox ID is invalid.", { id });
    await ensureV2Layout(workspace);
    const current = await readRecord(workspace, id);
    if (current === undefined) throw new StinkyCobblerError("AUDIT_OUTBOX_NOT_FOUND", ExitCode.VALIDATION, "Audit outbox record does not exist.", { id });
    if (current.outcome === outcome) return current;
    if (current.outcome !== "unknown") {
      throw conflict("AUDIT_IDEMPOTENCY_CONFLICT", "Audit outcome is already bound to a different terminal result.", { id, currentOutcome: current.outcome, requestedOutcome: outcome });
    }
    const next: AuditOutboxRecord = { ...current, outcome };
    validateRecord(next, 0);
    assertRecordByteBound(next);
    // The full record is the outcome commit point. Marker/index repair follows;
    // a crash can leave stale lookup metadata but never a terminal result only
    // in memory.
    await saveRecord(workspace, next);
    if (next.stage !== "committed") await savePendingMarker(workspace, next);
    await replaceOwnedCallIndex(workspace, next);
    return next;
  }));
}

async function ensureV2Layout(workspace: LocalWorkspace): Promise<void> {
  const layout = await readLayout(workspace);
  if (layout.kind === "v2") { await ensureDirectories(workspace); return; }
  await ensureDirectories(workspace);
  if (layout.kind === "legacy") for (const record of layout.records) await materializeLegacyRecord(workspace, record);
  const manifest: AuditOutboxManifest = { version: LAYOUT_VERSION, recordsDirectory: RECORDS_DIRECTORY, callsDirectory: CALLS_DIRECTORY, receiptsDirectory: RECEIPTS_DIRECTORY, pendingDirectory: PENDING_DIRECTORY };
  await writeWorkspaceJson(workspace, AUDIT_OUTBOX_FILE, manifest);
}

async function materializeLegacyRecord(workspace: LocalWorkspace, record: AuditOutboxRecord): Promise<void> {
  await ensureCallIndex(workspace, { version: 1, callId: record.callId, recordId: record.id, receiptId: record.receiptId, requestHash: hashPersistedRecord(record) });
  await ensureReceiptIndex(workspace, { version: 1, receiptId: record.receiptId, recordId: record.id });
  if (record.stage !== "committed") await ensurePendingMarker(workspace, record);
  await ensureRecord(workspace, record);
}

async function ensureDirectories(workspace: LocalWorkspace): Promise<void> {
  await createWorkspaceDirectory(workspace, AUDIT_OUTBOX_DIRECTORY);
  await createWorkspaceDirectory(workspace, RECORDS_DIRECTORY);
  await createWorkspaceDirectory(workspace, CALLS_DIRECTORY);
  await createWorkspaceDirectory(workspace, RECEIPTS_DIRECTORY);
  await createWorkspaceDirectory(workspace, PENDING_DIRECTORY);
}

async function readLayout(workspace: LocalWorkspace): Promise<Layout> {
  const value = await readJsonOptional(workspace, AUDIT_OUTBOX_FILE, MAX_AUDIT_OUTBOX_LEGACY_BYTES);
  if (value === undefined) return { kind: "absent" };
  (await defaultSchemaRegistry()).validate("audit-outbox", value);
  if (Array.isArray(value)) return { kind: "legacy", records: validateAggregate(value.map((record, index) => validateRecord(record, index))) };
  if (!isManifest(value)) throw invalid("Audit outbox manifest is invalid.", {});
  return { kind: "v2" };
}

async function readRecord(workspace: LocalWorkspace, id: string): Promise<AuditOutboxRecord | undefined> {
  const value = await readJsonOptional(workspace, recordFile(id));
  if (value === undefined) return undefined;
  (await defaultSchemaRegistry()).validate("audit-outbox", [value]);
  const record = validateRecord(value, 0);
  if (record.id !== id) throw invalid("Audit record ID differs from its canonical file name.", { id, storedId: record.id });
  return record;
}

async function ensureRecord(workspace: LocalWorkspace, record: AuditOutboxRecord): Promise<void> {
  validateRecord(record, 0); assertRecordByteBound(record);
  try { await createWorkspaceJson(workspace, recordFile(record.id), record); }
  catch (error: unknown) {
    if (!isAlreadyExists(error)) throw error;
    const existing = await readRecord(workspace, record.id);
    if (existing === undefined || JSON.stringify(existing) !== JSON.stringify(record)) throw conflict("AUDIT_IDEMPOTENCY_CONFLICT", "Audit record ID already stores different data.", { id: record.id });
  }
}
async function saveRecord(workspace: LocalWorkspace, record: AuditOutboxRecord): Promise<void> { validateRecord(record, 0); assertRecordByteBound(record); await writeWorkspaceJson(workspace, recordFile(record.id), record); }

async function readCallIndex(workspace: LocalWorkspace, callId: string): Promise<CallIndex | undefined> {
  const value = await readJsonOptional(workspace, callIndexFile(callId));
  if (value === undefined) return undefined;
  if (!isPlainObject(value) || Object.keys(value).length !== 5 || value.version !== 1 || value.callId !== callId || typeof value.recordId !== "string" || typeof value.receiptId !== "string" || typeof value.requestHash !== "string") throw invalid("Audit call index is invalid.", { callId });
  assertId(value.recordId, "Audit call index recordId is invalid.", { callId }); assertId(value.receiptId, "Audit call index receiptId is invalid.", { callId });
  if (!/^sha256:[a-f0-9]{64}$/.test(value.requestHash)) throw invalid("Audit call index requestHash is invalid.", { callId });
  return value as unknown as CallIndex;
}
async function ensureCallIndex(workspace: LocalWorkspace, index: CallIndex): Promise<void> {
  try { await createWorkspaceJson(workspace, callIndexFile(index.callId), index); }
  catch (error: unknown) { if (!isAlreadyExists(error)) throw error; const existing = await readCallIndex(workspace, index.callId); if (existing === undefined || JSON.stringify(existing) !== JSON.stringify(index)) throw conflict("AUDIT_IDEMPOTENCY_CONFLICT", "Audit callId index conflicts with prior data.", { callId: index.callId }); }
}
async function readReceiptIndex(workspace: LocalWorkspace, receiptId: string): Promise<ReceiptIndex | undefined> {
  const value = await readJsonOptional(workspace, receiptIndexFile(receiptId));
  if (value === undefined) return undefined;
  if (!isPlainObject(value) || Object.keys(value).length !== 3 || value.version !== 1 || value.receiptId !== receiptId || typeof value.recordId !== "string") throw invalid("Audit receipt index is invalid.", { receiptId });
  assertId(value.recordId, "Audit receipt index recordId is invalid.", { receiptId }); return value as unknown as ReceiptIndex;
}
async function ensureReceiptIndex(workspace: LocalWorkspace, index: ReceiptIndex): Promise<void> {
  try { await createWorkspaceJson(workspace, receiptIndexFile(index.receiptId), index); }
  catch (error: unknown) { if (!isAlreadyExists(error)) throw error; const existing = await readReceiptIndex(workspace, index.receiptId); if (existing === undefined || existing.recordId !== index.recordId) throw conflict("AUDIT_RECEIPT_ID_CONFLICT", "Audit receiptId is already associated with a different callId.", { receiptId: index.receiptId }); }
}
async function readPendingMarker(workspace: LocalWorkspace, id: string): Promise<PendingMarker | undefined> {
  const value = await readJsonOptional(workspace, pendingFile(id));
  if (value === undefined) return undefined;
  if (!isPlainObject(value) || value.recordId !== id) throw invalid("Audit pending marker is invalid.", { id });
  assertId(value.recordId, "Audit pending marker recordId is invalid.", { id });
  if (value.version === 1 && Object.keys(value).length === 2) return value as unknown as LegacyPendingMarker;
  if (
    value.version !== 2 || Object.keys(value).length !== 4 ||
    typeof value.requestHash !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value.requestHash)
  ) throw invalid("Audit recoverable pending marker is invalid.", { id });
  const record = validateRecord(value.record, 0);
  assertRecordByteBound(record);
  if (
    record.id !== id || recordIdForCall(record.callId) !== id ||
    hashPersistedRecord(record) !== value.requestHash || record.stage === "committed"
  ) throw invalid("Audit recoverable pending marker is not bound to its canonical non-committed record.", { id });
  return { version: 2, recordId: id, requestHash: value.requestHash, record };
}
async function ensurePendingMarker(workspace: LocalWorkspace, record: AuditOutboxRecord): Promise<void> {
  const existing = await readPendingMarker(workspace, record.id);
  const requestHash = hashPersistedRecord(record);
  if (existing !== undefined) {
    if (existing.version === 2 && existing.requestHash !== requestHash) {
      throw conflict("AUDIT_IDEMPOTENCY_CONFLICT", "Audit pending marker conflicts with the exact request.", { id: record.id });
    }
    if (existing.version === 1) await savePendingMarker(workspace, record);
    return;
  }
  await assertPendingCapacity(workspace, record.id);
  const marker: RecoverablePendingMarker = { version: 2, recordId: record.id, requestHash, record };
  try { await createWorkspaceJson(workspace, pendingFile(record.id), marker); }
  catch (error: unknown) {
    if (!isAlreadyExists(error)) throw error;
    const reloaded = await readPendingMarker(workspace, record.id);
    if (reloaded === undefined || (reloaded.version === 2 && reloaded.requestHash !== requestHash)) {
      throw recoveryRequired("Audit pending marker could not be reloaded with the exact request.", { id: record.id });
    }
  }
}
async function savePendingMarker(workspace: LocalWorkspace, record: AuditOutboxRecord): Promise<void> {
  if (record.stage === "committed") throw invalid("A committed Audit record cannot be persisted as pending.", { id: record.id });
  validateRecord(record, 0); assertRecordByteBound(record);
  const marker: RecoverablePendingMarker = {
    version: 2,
    recordId: record.id,
    requestHash: hashPersistedRecord(record),
    record
  };
  await writeWorkspaceJson(workspace, pendingFile(record.id), marker);
}
async function materializePendingMarker(workspace: LocalWorkspace, marker: RecoverablePendingMarker): Promise<AuditOutboxRecord> {
  const record = marker.record;
  await replaceOwnedCallIndex(workspace, record);
  await ensureReceiptIndex(workspace, { version: 1, receiptId: record.receiptId, recordId: record.id });
  await ensureRecord(workspace, record);
  return record;
}
async function replaceOwnedCallIndex(workspace: LocalWorkspace, record: AuditOutboxRecord): Promise<void> {
  const next: CallIndex = {
    version: 1,
    callId: record.callId,
    recordId: record.id,
    receiptId: record.receiptId,
    requestHash: hashPersistedRecord(record)
  };
  const existing = await readCallIndex(workspace, record.callId);
  if (existing === undefined) {
    await ensureCallIndex(workspace, next);
    return;
  }
  if (existing.recordId !== next.recordId || existing.receiptId !== next.receiptId) {
    throw conflict("AUDIT_IDEMPOTENCY_CONFLICT", "Audit callId index is owned by different immutable identities.", { callId: record.callId });
  }
  if (existing.requestHash !== next.requestHash) await writeWorkspaceJson(workspace, callIndexFile(record.callId), next);
}
async function removePendingMarker(workspace: LocalWorkspace, id: string): Promise<void> { const target = await workspaceFile(workspace, pendingFile(id)); await unlink(target).catch((error: unknown) => { if (!isNotFound(error)) throw error; }); }
async function assertPendingCapacity(workspace: LocalWorkspace, expectedId: string): Promise<void> { const names = await listDirectory(workspace, PENDING_DIRECTORY); if (names.some((name) => name === `${expectedId}.json`)) return; if (names.length >= MAX_AUDIT_OUTBOX_PENDING) throw pendingLimit(names.length); }
async function listDirectory(workspace: LocalWorkspace, directory: string): Promise<string[]> { try { return await readdir(await workspaceFile(workspace, directory)); } catch (error: unknown) { if (isNotFound(error)) return []; throw error; } }
async function readJsonOptional(workspace: LocalWorkspace, name: string, maxBytes?: number): Promise<unknown | undefined> {
  let serialized: string;
  const target = await workspaceFile(workspace, name);
  try {
    if (maxBytes !== undefined) {
      const stat = await lstat(target);
      if (!stat.isFile() || stat.size > maxBytes) throw invalid("Audit outbox aggregate exceeds the bounded migration byte limit.", { name, bytes: stat.size, limit: maxBytes });
    }
    serialized = await readFile(target, "utf8");
  } catch (error: unknown) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
  try { return JSON.parse(serialized); }
  catch { throw invalid("Audit outbox contains invalid JSON.", { name }); }
}

function recordIdForCall(callId: string): string { return `audit-${digest(callId).slice(0, 48)}`; }
function callIndexFile(callId: string): string { return `${CALLS_DIRECTORY}/call-${digest(callId).slice(0, 48)}.json`; }
function receiptIndexFile(receiptId: string): string { return `${RECEIPTS_DIRECTORY}/receipt-${digest(receiptId).slice(0, 48)}.json`; }
function recordFile(id: string): string { return `${RECORDS_DIRECTORY}/${id}.json`; }
function pendingFile(id: string): string { return `${PENDING_DIRECTORY}/${id}.json`; }
function digest(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function hashCreateInput(input: CreateAuditOutboxInput): string { return `sha256:${digest(JSON.stringify(input))}`; }
function hashPersistedRecord(record: AuditOutboxRecord): string {
  return hashCreateInput({
    callId: record.callId,
    taskId: record.taskId,
    role: record.role,
    tool: record.tool,
    ...(record.leaseId === undefined ? {} : { leaseId: record.leaseId }),
    ...(record.taskAuthorityHash === undefined ? {} : { taskAuthorityHash: record.taskAuthorityHash }),
    ...(record.capability === undefined ? {} : { capability: record.capability }),
    ...(record.operation === undefined ? {} : { operation: record.operation }),
    ...(record.reservationId === undefined ? {} : { reservationId: record.reservationId }),
    ...(record.reservationOrdinal === undefined ? {} : { reservationOrdinal: record.reservationOrdinal }),
    outcome: record.outcome,
    receiptId: record.receiptId
  });
}

function validateCreateInput(input: CreateAuditOutboxInput): void {
  if (!isPlainObject(input)) throw invalid("Audit outbox input must be an object.", {});
  const allowed = new Set(["callId", "taskId", "role", "tool", "leaseId", "taskAuthorityHash", "capability", "operation", "reservationId", "reservationOrdinal", "outcome", "receiptId"]); const forbidden = Object.keys(input).filter((key) => !allowed.has(key));
  if (forbidden.length > 0) throw invalid("Audit outbox assigns id, stage, timestamp, and attempts.", { forbidden });
  assertId(input.callId, "Audit call ID is invalid.", { callId: input.callId }); assertId(input.taskId, "Audit task ID is invalid.", { taskId: input.taskId }); assertId(input.receiptId, "Audit receipt ID is invalid.", { receiptId: input.receiptId }); assertText(input.role, "Audit role is invalid.", { role: input.role }); assertText(input.tool, "Audit tool is invalid.", { tool: input.tool });
  assertOptionalAuthorityProvenance(input, "create");
  if (!OUTCOMES.includes(input.outcome)) throw invalid("Audit outcome is invalid.", { outcome: input.outcome });
}
function validateUpdateInput(patch: UpdateAuditOutboxInput, id: string): void {
  if (!isPlainObject(patch)) throw invalid("Audit outbox update must be an object.", { id }); const allowed = new Set(["stage", "attempts", "errorCode", "lastErrorCode"]); const forbidden = Object.keys(patch).filter((key) => !allowed.has(key));
  if (forbidden.length > 0) throw invalid("Audit outbox update contains unsupported fields.", { id, forbidden }); if (!STAGES.includes(patch.stage)) throw invalid("Audit outbox stage is invalid.", { id, stage: patch.stage }); if (patch.attempts !== undefined && (!Number.isSafeInteger(patch.attempts) || patch.attempts < 0)) throw invalid("Audit outbox attempts must be a non-negative integer.", { id, attempts: patch.attempts }); if (patch.errorCode !== undefined) assertErrorCode(patch.errorCode, id); if (patch.lastErrorCode !== undefined) assertErrorCode(patch.lastErrorCode, id); if (patch.errorCode !== undefined && patch.lastErrorCode !== undefined && patch.errorCode !== patch.lastErrorCode) throw invalid("Audit outbox errorCode and lastErrorCode must match.", { id });
}
function validateRecord(value: unknown, index: number): AuditOutboxRecord {
  if (!isPlainObject(value)) throw invalid("Audit outbox record is invalid.", { index }); const record = value as Partial<AuditOutboxRecord>; const allowed = new Set(["id", "callId", "taskId", "role", "tool", "leaseId", "taskAuthorityHash", "capability", "operation", "reservationId", "reservationOrdinal", "outcome", "receiptId", "stage", "createdAt", "attempts", "errorCode", "lastErrorCode"]); const forbidden = Object.keys(record).filter((key) => !allowed.has(key));
  if (forbidden.length > 0) throw invalid("Audit outbox record contains unsupported fields.", { index, forbidden }); assertId(record.id, "Audit outbox ID is invalid.", { index, id: record.id }); assertId(record.callId, "Audit call ID is invalid.", { index, callId: record.callId }); assertId(record.taskId, "Audit task ID is invalid.", { index, taskId: record.taskId }); assertId(record.receiptId, "Audit receipt ID is invalid.", { index, receiptId: record.receiptId }); assertText(record.role, "Audit role is invalid.", { index }); assertText(record.tool, "Audit tool is invalid.", { index });
  assertOptionalAuthorityProvenance(record, index);
  if (!OUTCOMES.includes(record.outcome as AuditOutcome)) throw invalid("Audit outcome is invalid.", { index, outcome: record.outcome }); if (!STAGES.includes(record.stage as AuditStage)) throw invalid("Audit outbox stage is invalid.", { index, stage: record.stage }); if (typeof record.createdAt !== "string" || !isCanonicalIsoDate(record.createdAt)) throw invalid("Audit createdAt must be a canonical ISO timestamp.", { index }); if (typeof record.attempts !== "number" || !Number.isSafeInteger(record.attempts) || record.attempts < 0) throw invalid("Audit outbox attempts must be a non-negative integer.", { index }); if (record.errorCode !== undefined) assertErrorCode(record.errorCode, String(index)); if (record.lastErrorCode !== undefined) assertErrorCode(record.lastErrorCode, String(index)); if (record.errorCode !== undefined && record.lastErrorCode !== undefined && record.errorCode !== record.lastErrorCode) throw invalid("Audit outbox errorCode and lastErrorCode must match.", { index }); return record as AuditOutboxRecord;
}

function assertOptionalAuthorityProvenance(
  value: Partial<Pick<AuditOutboxRecord, "tool" | "leaseId" | "taskAuthorityHash" | "capability" | "operation" | "reservationId" | "reservationOrdinal">>,
  context: string | number
): void {
  const core = [value.leaseId, value.taskAuthorityHash, value.capability, value.operation];
  const coreCount = core.filter((item) => item !== undefined).length;
  if (coreCount !== 0 && coreCount !== core.length) throw invalid("Audit authority provenance must be complete when present.", { context });
  if (coreCount === core.length) {
    assertId(value.leaseId, "Audit leaseId is invalid.", { context });
    if (typeof value.taskAuthorityHash !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value.taskAuthorityHash)) throw invalid("Audit taskAuthorityHash is invalid.", { context });
    assertText(value.capability, "Audit capability is invalid.", { context });
    assertText(value.operation, "Audit operation is invalid.", { context });
    if (value.tool !== value.operation) throw invalid("Audit tool must identify the exact persisted operation.", { context });
  }
  if ((value.reservationId === undefined) !== (value.reservationOrdinal === undefined)) {
    throw invalid("Audit reservation provenance requires both ID and ordinal.", { context });
  }
  if (value.reservationId !== undefined) assertId(value.reservationId, "Audit reservationId is invalid.", { context });
  if (value.reservationOrdinal !== undefined && (!Number.isSafeInteger(value.reservationOrdinal) || value.reservationOrdinal < 1)) {
    throw invalid("Audit reservationOrdinal must be a positive safe integer.", { context });
  }
  if (value.reservationId !== undefined && coreCount !== core.length) throw invalid("Audit reservation provenance requires authority provenance.", { context });
}
function validateAggregate(records: AuditOutboxRecord[]): AuditOutboxRecord[] {
  if (records.length > MAX_AUDIT_OUTBOX_LEGACY_RECORDS) throw invalid("Audit outbox aggregate exceeds the bounded migration record limit.", { records: records.length, limit: MAX_AUDIT_OUTBOX_LEGACY_RECORDS });
  for (const record of records) assertRecordByteBound(record);
  const pending = records.filter((record) => record.stage !== "committed").length;
  if (pending > MAX_AUDIT_OUTBOX_PENDING) throw pendingLimit(pending);
  assertUnique(records, "id");
  assertUnique(records, "callId");
  assertUnique(records, "receiptId");
  return records;
}
function assertUnique(records: AuditOutboxRecord[], field: "id" | "callId" | "receiptId"): void { const seen = new Set<string>(); for (let index = 0; index < records.length; index += 1) { const value = records[index]![field]; if (seen.has(value)) throw invalid(`Audit outbox ${field} values must be globally unique.`, { field, value, index }); seen.add(value); } }
function assertRecordByteBound(record: AuditOutboxRecord): void { if (Buffer.byteLength(JSON.stringify(record), "utf8") > MAX_AUDIT_OUTBOX_RECORD_BYTES) throw invalid("Audit outbox record exceeds the durable byte limit.", { id: record.id, limit: MAX_AUDIT_OUTBOX_RECORD_BYTES }); }
function assertListBatch(records: AuditOutboxRecord[]): AuditOutboxRecord[] { if (records.length > MAX_AUDIT_OUTBOX_LIST_BATCH) throw batchLimit(records.length); return records; }
function isManifest(value: unknown): value is AuditOutboxManifest { return isPlainObject(value) && Object.keys(value).length === 5 && value.version === LAYOUT_VERSION && value.recordsDirectory === RECORDS_DIRECTORY && value.callsDirectory === CALLS_DIRECTORY && value.receiptsDirectory === RECEIPTS_DIRECTORY && value.pendingDirectory === PENDING_DIRECTORY; }
function assertId(value: unknown, message: string, details: Record<string, unknown>): asserts value is string { if (typeof value !== "string" || !ID_PATTERN.test(value)) throw invalid(message, details); }
function assertText(value: unknown, message: string, details: Record<string, unknown>): asserts value is string { if (typeof value !== "string" || value.length === 0 || value.length > 256 || /[\0\r\n]/.test(value)) throw invalid(message, details); }
function assertErrorCode(value: unknown, id: string): asserts value is string { if (typeof value !== "string" || !STABLE_ERROR_CODE_PATTERN.test(value)) throw invalid("Audit error code is invalid.", { id, errorCode: value }); }
function isCanonicalIsoDate(value: string): boolean { const parsed = new Date(value); return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value; }
function isPlainObject(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype; }
function invalid(message: string, details: Record<string, unknown>): StinkyCobblerError { return new StinkyCobblerError("AUDIT_OUTBOX_INVALID", ExitCode.VALIDATION, message, details); }
function conflict(code: "AUDIT_IDEMPOTENCY_CONFLICT" | "AUDIT_RECEIPT_ID_CONFLICT", message: string, details: Record<string, unknown>): StinkyCobblerError { return new StinkyCobblerError(code, ExitCode.POLICY_DENIED, message, details); }
function recoveryRequired(message: string, details: Record<string, unknown>): StinkyCobblerError { return new StinkyCobblerError("AUDIT_OUTBOX_RECOVERY_REQUIRED", ExitCode.POLICY_DENIED, message, details); }
function pendingLimit(pending: number): StinkyCobblerError { return new StinkyCobblerError("AUDIT_OUTBOX_PENDING_LIMIT", ExitCode.POLICY_DENIED, "Audit pending record limit reached; recover or commit pending audits before accepting more calls.", { pending, limit: MAX_AUDIT_OUTBOX_PENDING }); }
function batchLimit(records: number): StinkyCobblerError { return new StinkyCobblerError("AUDIT_OUTBOX_BATCH_LIMIT", ExitCode.POLICY_DENIED, "Audit outbox history exceeds the bounded compatibility listing batch.", { records, limit: MAX_AUDIT_OUTBOX_LIST_BATCH }); }
function isNotFound(error: unknown): boolean { return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"; }
function isAlreadyExists(error: unknown): boolean { return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST"; }
function serialize<T>(directory: string, operation: () => Promise<T>): Promise<T> { const preceding = queues.get(directory) ?? Promise.resolve(); const current = preceding.catch(() => undefined).then(operation); queues.set(directory, current); void current.finally(() => { if (queues.get(directory) === current) queues.delete(directory); }).catch(() => undefined); return current; }
