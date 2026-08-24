import { lstat, mkdir, readdir, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { defaultSchemaRegistry } from "../contracts/default-schema-registry.js";
import type { SchemaRegistry } from "../contracts/schema-registry.js";
import type { AgentRun } from "../contracts/types.js";
import { ExitCode, StinkyCobblerError } from "../errors.js";
import { appendLedgerEntry, listLedgerEntries } from "./ledger.js";
import { getRun, TERMINAL_RUN_STATUSES } from "./runs.js";
import { assertSafeTaskId, getTask } from "./tasks.js";
import type { LocalWorkspace } from "./workspace.js";
import { workspaceFile, writeWorkspaceJson } from "./workspace.js";
import { withWorkspaceLock } from "./workspace-lock.js";

export const RECEIPTS_DIRECTORY = "receipts";
export const MAX_RECEIPT_BYTES = 1024 * 1024;
const RECEIPT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const RUNTIME_RECEIPT_RESERVED_FIELDS = [
  "runId",
  "capsuleId",
  "leaseId",
  "agentId",
  "startedAt",
  "finishedAt",
  "executor",
  "budgetUsage",
  "toolCalls",
  "outputHash",
  "errorCode",
  "blockedReason",
  "executionRequestHash"
] as const;
export type AgentReceipt = Record<string, unknown> & { id: string; taskId: string; changedPaths?: string[] };

export async function validateReceipt(workspace: LocalWorkspace, schemas: SchemaRegistry, receipt: Record<string, unknown>): Promise<AgentReceipt> {
  const candidate = await validateRuntimeReceiptCandidate(workspace, schemas, receipt);
  const reservedFields = RUNTIME_RECEIPT_RESERVED_FIELDS.filter((field) => candidate[field] !== undefined);
  if (reservedFields.length > 0) {
    throw invalid("Runtime Receipt fields are reserved for the runtime finalizer and cannot be supplied through the general Receipt entry point.", { reservedFields });
  }
  return candidate;
}

export async function validateRuntimeReceiptCandidate(workspace: LocalWorkspace, schemas: SchemaRegistry, receipt: Record<string, unknown>): Promise<AgentReceipt> {
  const candidate = { ...receipt, id: receipt.id ?? `receipt-${randomUUID()}` } as AgentReceipt;
  assertReceiptByteBound(candidate);
  if (!RECEIPT_ID.test(candidate.id)) throw invalid("Receipt ID is invalid.", { id: candidate.id });
  if (typeof candidate.taskId !== "string") throw invalid("Receipt taskId is required.", {});
  assertSafeTaskId(candidate.taskId);
  await getTask(workspace, candidate.taskId);
  if (candidate.changedPaths !== undefined && (!Array.isArray(candidate.changedPaths) || candidate.changedPaths.length > 0)) {
    throw invalid("This Receipt contract is read-only and must omit changedPaths or provide an empty array; controlled business writes use WriteIntent Evidence instead.", { changedPaths: candidate.changedPaths });
  }
  schemas.validate("receipt", candidate);
  return candidate;
}

export async function recordReceipt(workspace: LocalWorkspace, schemas: SchemaRegistry, receipt: Record<string, unknown>): Promise<AgentReceipt> {
  return withWorkspaceLock(workspace, async () => {
    const valid = await validateReceipt(workspace, schemas, receipt);
    return persistReceipt(workspace, valid);
  });
}

/** Fail closed unless every Run-derived Receipt field matches the authority. */
export function assertRuntimeReceiptMatchesRun(receipt: AgentReceipt, run: AgentRun): void {
  if (!TERMINAL_RUN_STATUSES.includes(run.status as (typeof TERMINAL_RUN_STATUSES)[number])) {
    throw runtimeConflict("Runtime Receipts may only bind to terminal Agent runs.", { runId: run.runId, status: run.status, receiptId: receipt.id });
  }
  if (typeof run.executionRequestHash !== "string") {
    throw runtimeConflict("Legacy Runtime Runs without an executionRequestHash cannot mint or validate a success proof; reissue the Run.", {
      runId: run.runId,
      receiptId: receipt.id
    });
  }
  const expected: Record<string, unknown> = {
    runId: run.runId,
    taskId: run.taskId,
    capsuleId: run.capsuleId,
    leaseId: run.leaseId,
    agentId: run.agentId,
    role: run.role,
    executor: run.executor,
    policyVersion: run.policyVersion,
    executionRequestHash: run.executionRequestHash,
    status: receiptStatusForRun(run),
    evidenceRefs: run.evidenceRefs ?? [],
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    budgetUsage: run.budgetUsage,
    toolCalls: run.toolCalls,
    outputHash: run.outputHash,
    errorCode: run.errorCode,
    blockedReason: run.blockedReason,
    createdAt: run.finishedAt ?? run.createdAt
  };
  const fields = Object.entries(expected)
    .filter(([field, value]) => !sameValue(receipt[field], value))
    .map(([field]) => field);
  if (run.status !== "COMPLETED" && !sameValue(receipt.facts, [])) fields.push("facts");
  if (fields.length > 0) {
    throw runtimeConflict("Runtime Receipt does not match the authoritative terminal Agent run.", {
      runId: run.runId,
      receiptId: receipt.id,
      fields
    });
  }
}

export async function getReceipt(workspace: LocalWorkspace, id: string): Promise<AgentReceipt> {
  assertReceiptId(id);
  const target = await receiptFile(workspace, id);
  try {
    const stat = await lstat(target);
    if (!stat.isFile() || stat.size > MAX_RECEIPT_BYTES) throw invalid("Stored receipt exceeds the durable byte limit.", { receiptId: id, bytes: stat.size, limit: MAX_RECEIPT_BYTES });
    const value: unknown = JSON.parse(await readFile(target, "utf8"));
    (await defaultSchemaRegistry()).validate("receipt", value);
    const receipt = value as AgentReceipt;
    if (receipt.id !== id) throw invalid("Stored receipt ID does not match its canonical lookup ID.", { receiptId: id, storedReceiptId: receipt.id });
    return receipt;
  }
  catch (error: unknown) {
    if (isNotFound(error)) throw invalid("Receipt does not exist.", { receiptId: id });
    if (error instanceof SyntaxError) throw invalid("Stored receipt contains invalid JSON.", { receiptId: id });
    throw error;
  }
}

export async function listReceipts(workspace: LocalWorkspace, taskId?: string): Promise<AgentReceipt[]> {
  if (taskId !== undefined) assertSafeTaskId(taskId);
  const directory = await receiptsDirectory(workspace);
  let names: string[];
  try { names = await readdir(directory); } catch (error: unknown) { if (isNotFound(error)) return []; throw error; }
  const receipts = await Promise.all(names.filter((name) => /^([A-Za-z0-9][A-Za-z0-9_-]{0,127})\.json$/.test(name)).sort().map(async (name) => getReceipt(workspace, name.slice(0, -5))));
  return taskId === undefined ? receipts : receipts.filter((receipt) => receipt.taskId === taskId);
}

export async function inspectReceipt(workspace: LocalWorkspace, schemas: SchemaRegistry, id: string): Promise<{ valid: boolean; receipt: AgentReceipt; taskExists: boolean }> {
  const receipt = await getReceipt(workspace, id);
  try {
    if (RUNTIME_RECEIPT_RESERVED_FIELDS.some((field) => receipt[field] !== undefined)) {
      const valid = await validateRuntimeReceiptCandidate(workspace, schemas, receipt);
      if (typeof valid.runId !== "string") throw runtimeConflict("Stored Receipt contains Runtime fields without a runId.", { receiptId: valid.id });
      assertRuntimeReceiptMatchesRun(valid, await getRun(workspace, valid.runId));
    } else {
      await validateReceipt(workspace, schemas, receipt);
    }
    return { valid: true, receipt, taskExists: true };
  } catch (error: unknown) {
    if (error instanceof StinkyCobblerError && error.code === "TASK_NOT_FOUND") return { valid: false, receipt, taskExists: false };
    throw error;
  }
}

async function persistReceipt(workspace: LocalWorkspace, valid: AgentReceipt): Promise<AgentReceipt> {
  const stored = await persistReceiptFile(workspace, valid);
  await ensureReceiptLedgerEntry(workspace, stored);
  return stored;
}

/** Writes only the immutable Receipt target; Runtime finalization owns its audit commit. */
export async function persistReceiptFile(workspace: LocalWorkspace, valid: AgentReceipt): Promise<AgentReceipt> {
  await ensureReceiptsDirectory(workspace);
  const target = await receiptFile(workspace, valid.id);
  let existing: AgentReceipt | undefined;
  try {
    existing = JSON.parse(await readFile(target, "utf8")) as AgentReceipt;
    if (JSON.stringify(existing) !== JSON.stringify(valid)) throw invalid("A receipt with this ID already exists with different content.", { receiptId: valid.id });
  } catch (error: unknown) {
    if (!isNotFound(error)) throw error;
  }
  if (existing === undefined) {
    await writeWorkspaceJson(workspace, `${RECEIPTS_DIRECTORY}/${valid.id}.json`, valid);
    existing = valid;
  }
  return existing;
}

async function ensureReceiptLedgerEntry(workspace: LocalWorkspace, receipt: AgentReceipt): Promise<void> {
  const entries = await listLedgerEntries(workspace);
  if (entries.some((entry) => entry.event === "receipt-recorded" && entry.receiptRef === receipt.id && entry.taskId === receipt.taskId)) return;
  await appendLedgerEntry(workspace, { event: "receipt-recorded", taskId: receipt.taskId, receiptRef: receipt.id, summary: `Receipt ${receipt.id} recorded.` });
}

async function ensureReceiptsDirectory(workspace: LocalWorkspace): Promise<void> {
  const directory = await receiptsDirectory(workspace);
  await mkdir(directory, { recursive: true, mode: 0o700 });
}
async function receiptsDirectory(workspace: LocalWorkspace): Promise<string> { return workspaceFile(workspace, RECEIPTS_DIRECTORY); }
async function receiptFile(workspace: LocalWorkspace, id: string): Promise<string> { assertReceiptId(id); return workspaceFile(workspace, path.join(RECEIPTS_DIRECTORY, `${id}.json`)); }
function assertReceiptId(id: string): void { if (!RECEIPT_ID.test(id)) throw invalid("Receipt ID is invalid.", { id }); }
function assertReceiptByteBound(receipt: AgentReceipt): void {
  let bytes: number;
  try { bytes = Buffer.byteLength(JSON.stringify(receipt), "utf8"); }
  catch { throw invalid("Receipt must be finite JSON data.", {}); }
  if (bytes > MAX_RECEIPT_BYTES) throw invalid("Receipt exceeds the durable byte limit.", { receiptId: receipt.id, bytes, limit: MAX_RECEIPT_BYTES });
}
function invalid(message: string, details: Record<string, unknown>): StinkyCobblerError { return new StinkyCobblerError("RECEIPT_INVALID", ExitCode.VALIDATION, message, details); }
function runtimeConflict(message: string, details: Record<string, unknown>): StinkyCobblerError { return new StinkyCobblerError("RUNTIME_RECEIPT_CONFLICT", ExitCode.POLICY_DENIED, message, details); }
function receiptStatusForRun(run: AgentRun): AgentReceipt["status"] {
  if (run.status === "COMPLETED") return "COMPLETED";
  if (run.status === "FAILED") return "FAILED";
  return "BLOCKED";
}
function sameValue(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }
function isNotFound(error: unknown): boolean { return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"; }
