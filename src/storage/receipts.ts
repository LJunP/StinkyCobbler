import { mkdir, readdir, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { SchemaRegistry } from "../contracts/schema-registry.js";
import { ExitCode, StinkyCobblerError } from "../errors.js";
import { appendLedgerEntry, listLedgerEntries } from "./ledger.js";
import { assertSafeTaskId, getTask } from "./tasks.js";
import type { LocalWorkspace } from "./workspace.js";
import { workspaceFile, writeWorkspaceJson } from "./workspace.js";
import { withWorkspaceLock } from "./workspace-lock.js";

export const RECEIPTS_DIRECTORY = "receipts";
const RECEIPT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
export type AgentReceipt = Record<string, unknown> & { id: string; taskId: string; changedPaths?: string[] };

export async function validateReceipt(workspace: LocalWorkspace, schemas: SchemaRegistry, receipt: Record<string, unknown>): Promise<AgentReceipt> {
  const candidate = { ...receipt, id: receipt.id ?? `receipt-${randomUUID()}` } as AgentReceipt;
  if (!RECEIPT_ID.test(candidate.id)) throw invalid("Receipt ID is invalid.", { id: candidate.id });
  if (typeof candidate.taskId !== "string") throw invalid("Receipt taskId is required.", {});
  assertSafeTaskId(candidate.taskId);
  await getTask(workspace, candidate.taskId);
  if (candidate.changedPaths !== undefined && (!Array.isArray(candidate.changedPaths) || candidate.changedPaths.length > 0)) {
    throw invalid("v0.1 receipts must omit changedPaths or provide an empty array; business writes are not supported.", { changedPaths: candidate.changedPaths });
  }
  schemas.validate("receipt", candidate);
  return candidate;
}

export async function recordReceipt(workspace: LocalWorkspace, schemas: SchemaRegistry, receipt: Record<string, unknown>): Promise<AgentReceipt> {
  return withWorkspaceLock(workspace, async () => {
    const valid = await validateReceipt(workspace, schemas, receipt);
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
    await ensureReceiptLedgerEntry(workspace, existing);
    return existing;
  });
}

export async function getReceipt(workspace: LocalWorkspace, id: string): Promise<AgentReceipt> {
  assertReceiptId(id);
  const target = await receiptFile(workspace, id);
  try { return JSON.parse(await readFile(target, "utf8")) as AgentReceipt; }
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
    await validateReceipt(workspace, schemas, receipt);
    return { valid: true, receipt, taskExists: true };
  } catch (error: unknown) {
    if (error instanceof StinkyCobblerError && error.code === "TASK_NOT_FOUND") return { valid: false, receipt, taskExists: false };
    throw error;
  }
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
function invalid(message: string, details: Record<string, unknown>): StinkyCobblerError { return new StinkyCobblerError("RECEIPT_INVALID", ExitCode.VALIDATION, message, details); }
function isNotFound(error: unknown): boolean { return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"; }
