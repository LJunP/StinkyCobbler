import { readFile, readdir } from "node:fs/promises";
import type { AgentReceipt, AgentRun } from "../contracts/types.js";
import type { SchemaRegistry } from "../contracts/schema-registry.js";
import { verifyLedger, listLedgerEntries, type LedgerEntry } from "./ledger.js";
import { TERMINAL_RUN_STATUSES, classifyRunStaleness } from "./runs.js";
import type { LocalWorkspace } from "./workspace.js";
import { workspaceFile } from "./workspace.js";

export type RuntimeDiagnosticCategory = "MISSING" | "ORPHAN" | "SEMANTIC_CONFLICT" | "INTEGRITY" | "UNVERIFIABLE";
export type RuntimeDiagnosticSeverity = "INFO" | "WARNING" | "ERROR";

export interface RuntimeDiagnosticIssue {
  category: RuntimeDiagnosticCategory;
  code: string;
  severity: RuntimeDiagnosticSeverity;
  subject: "run" | "receipt" | "ledger" | "workspace";
  runId?: string;
  receiptId?: string;
  ledgerSequence?: number;
  ledgerEntryId?: string;
  message: string;
  expected?: unknown;
  observed?: unknown;
  repairable: false;
}

export interface RuntimeDiagnosticReport {
  version: "1";
  generatedAt: string;
  observedAt: string;
  readOnly: true;
  scope: "workspace" | "run";
  runId?: string;
  snapshot: {
    consistent: "unknown";
    concurrentMutationPossible: true;
    sourcesRead: string[];
    sourceErrors: string[];
  };
  ledger: {
    path: ".stinky-cobbler/ledger.jsonl";
    verification: Awaited<ReturnType<typeof verifyLedger>> | { valid: false; entries: 0; lastHash: string; error: { code: string; message: string } };
    trustedEntries: Array<Pick<LedgerEntry, "sequence" | "id" | "event" | "runId" | "fromStatus" | "toStatus" | "receiptRef">>;
    lifecycleEventCount: number;
  };
  runs: RuntimeDiagnosticRun[];
  receipts: RuntimeDiagnosticReceipt[];
  summary: {
    status: "CONSISTENT" | "ISSUES_FOUND" | "INDETERMINATE";
    runCount: number;
    terminalRunCount: number;
    receiptCount: number;
    lifecycleEventCount: number;
    issueCount: number;
    byCategory: Record<RuntimeDiagnosticCategory, number>;
    byCode: Record<string, number>;
  };
  issues: RuntimeDiagnosticIssue[];
  boundaries: {
    repairPerformed: false;
    historyInferred: false;
    authorization: false;
    sourceContentVerified: false;
  };
}

export interface RuntimeDiagnosticRun {
  runId: string;
  taskId: string;
  status: AgentRun["status"];
  terminal: boolean;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  staleness?: ReturnType<typeof classifyRunStaleness>;
  hasOwnerToken: boolean;
  fenceEpoch?: number;
  lifecycleEvents: Array<Pick<LedgerEntry, "sequence" | "id" | "event" | "fromStatus" | "toStatus">>;
  associatedReceiptIds: string[];
}

export interface RuntimeDiagnosticReceipt {
  receiptId: string;
  taskId: string;
  runId?: string;
  status: AgentReceipt["status"];
  createdAt: string;
  finishedAt?: string;
  schemaValid: boolean;
  ledgerSequence?: number;
}

interface LoadedRun { run: AgentRun; file: string; }
interface LoadedReceipt { receipt: AgentReceipt; file: string; }

const RUN_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$/;
const RECEIPT_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$/;
const LIFECYCLE_EVENTS = new Set(["run-created", "run-transitioned", "run-recovered"]);
const STATUS_VALUES = new Set(["CREATED", "ADMITTED", "RUNNING", ...TERMINAL_RUN_STATUSES]);

export async function diagnoseRuntime(
  workspace: LocalWorkspace,
  schemas: SchemaRegistry,
  requestedRunId?: string
): Promise<RuntimeDiagnosticReport> {
  const observedAt = new Date().toISOString();
  const issues: RuntimeDiagnosticIssue[] = [];
  const sourceErrors: string[] = [];
  const loadedRuns = await loadRuns(workspace, schemas, issues, sourceErrors);
  const loadedReceipts = await loadReceipts(workspace, schemas, issues, sourceErrors);
  const runMap = new Map(loadedRuns.map((item) => [item.run.runId, item.run]));

  let verification: RuntimeDiagnosticReport["ledger"]["verification"];
  let trustedEntries: LedgerEntry[] = [];
  try {
    verification = await verifyLedger(workspace);
    if (verification.valid) trustedEntries = await listLedgerEntries(workspace);
    else issues.push({ category: "INTEGRITY", code: "LEDGER_INVALID", severity: "ERROR", subject: "ledger", message: "Ledger verification failed; entries after the reported error are not used for lifecycle inference.", observed: verification.error, repairable: false });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    sourceErrors.push(`ledger: ${message}`);
    verification = { valid: false, entries: 0, lastHash: "sha256:genesis", error: { code: "READ_FAILED", message } };
    issues.push({ category: "INTEGRITY", code: "LEDGER_READ_FAILED", severity: "ERROR", subject: "ledger", message: "Ledger could not be read or verified.", observed: message, repairable: false });
  }

  const lifecycle = trustedEntries.filter((entry) => LIFECYCLE_EVENTS.has(entry.event));
  const lifecycleByRun = new Map<string, LedgerEntry[]>();
  const receiptLedger = new Map<string, LedgerEntry>();
  for (const entry of trustedEntries) {
    if (entry.event === "receipt-recorded" && entry.receiptRef !== undefined) receiptLedger.set(entry.receiptRef, entry);
    if (!LIFECYCLE_EVENTS.has(entry.event)) continue;
    if (entry.runId === undefined) {
      issues.push({ category: "INTEGRITY", code: "LIFECYCLE_RUN_ID_MISSING", severity: "ERROR", subject: "ledger", ledgerSequence: entry.sequence, ledgerEntryId: entry.id, message: "Lifecycle ledger entry has no runId.", repairable: false });
      continue;
    }
    const events = lifecycleByRun.get(entry.runId) ?? [];
    events.push(entry);
    lifecycleByRun.set(entry.runId, events);
    if (!runMap.has(entry.runId)) issues.push({ category: "ORPHAN", code: "RUN_LIFECYCLE_EVENT_ORPHAN", severity: "ERROR", subject: "ledger", runId: entry.runId, ledgerSequence: entry.sequence, ledgerEntryId: entry.id, message: "Lifecycle ledger entry references a Run file that is not currently readable.", repairable: false });
    if (entry.fromStatus !== undefined && !STATUS_VALUES.has(entry.fromStatus)) issues.push({ category: "SEMANTIC_CONFLICT", code: "RUN_LIFECYCLE_STATUS_INVALID", severity: "ERROR", subject: "ledger", runId: entry.runId, ledgerSequence: entry.sequence, ledgerEntryId: entry.id, message: "Lifecycle fromStatus is not a known Run status.", observed: entry.fromStatus, repairable: false });
    if (entry.toStatus !== undefined && !STATUS_VALUES.has(entry.toStatus)) issues.push({ category: "SEMANTIC_CONFLICT", code: "RUN_LIFECYCLE_STATUS_INVALID", severity: "ERROR", subject: "ledger", runId: entry.runId, ledgerSequence: entry.sequence, ledgerEntryId: entry.id, message: "Lifecycle toStatus is not a known Run status.", observed: entry.toStatus, repairable: false });
    if (entry.event === "run-recovered" && (entry.fromStatus !== "RUNNING" || entry.toStatus !== "FAILED")) issues.push({ category: "SEMANTIC_CONFLICT", code: "RUN_RECOVERY_TRANSITION_INVALID", severity: "ERROR", subject: "ledger", runId: entry.runId, ledgerSequence: entry.sequence, ledgerEntryId: entry.id, message: "run-recovered is not observed as RUNNING to FAILED.", expected: { fromStatus: "RUNNING", toStatus: "FAILED" }, observed: { fromStatus: entry.fromStatus, toStatus: entry.toStatus }, repairable: false });
  }

  for (const item of loadedRuns) {
    if (requestedRunId !== undefined && item.run.runId !== requestedRunId) continue;
    const events = lifecycleByRun.get(item.run.runId) ?? [];
    if (!events.some((entry) => entry.event === "run-created")) issues.push({ category: verification.valid ? "MISSING" : "UNVERIFIABLE", code: "RUN_CREATED_EVENT_MISSING", severity: "WARNING", subject: "run", runId: item.run.runId, message: verification.valid ? "No run-created event is observed for this Run in the valid ledger." : "Ledger integrity prevents confirming whether run-created was recorded.", repairable: false });
    const latest = [...events].sort((left, right) => left.sequence - right.sequence).at(-1);
    if (latest?.toStatus !== undefined && latest.toStatus !== item.run.status) issues.push({ category: "SEMANTIC_CONFLICT", code: "RUN_STATUS_LEDGER_CONFLICT", severity: "ERROR", subject: "run", runId: item.run.runId, ledgerSequence: latest.sequence, ledgerEntryId: latest.id, message: "Run status differs from the latest observable lifecycle toStatus.", expected: item.run.status, observed: latest.toStatus, repairable: false });
    if (item.run.errorCode === "RUNTIME_STALE_RECOVERY" && !events.some((entry) => entry.event === "run-recovered")) issues.push({ category: verification.valid ? "MISSING" : "UNVERIFIABLE", code: "RUN_RECOVERY_EVENT_MISSING", severity: "WARNING", subject: "run", runId: item.run.runId, message: "A stale-recovered Run has no observable run-recovered event.", repairable: false });
  }

  for (const item of loadedReceipts) {
    const receipt = item.receipt;
    const ledgerEntry = receiptLedger.get(receipt.id);
    if (receipt.runId !== undefined && !runMap.has(receipt.runId)) issues.push({ category: "ORPHAN", code: "RECEIPT_RUN_ORPHAN", severity: "ERROR", subject: "receipt", receiptId: receipt.id, runId: receipt.runId, message: "Receipt references a Run file that is not currently readable.", repairable: false });
    if (ledgerEntry === undefined) issues.push({ category: verification.valid ? "MISSING" : "UNVERIFIABLE", code: "RECEIPT_LEDGER_EVENT_MISSING", severity: "WARNING", subject: "receipt", receiptId: receipt.id, message: verification.valid ? "No receipt-recorded ledger entry is observed for this Receipt." : "Ledger integrity prevents confirming receipt-recorded linkage.", repairable: false });
  }
  for (const [receiptId, entry] of receiptLedger) if (!loadedReceipts.some((item) => item.receipt.id === receiptId)) issues.push({ category: "ORPHAN", code: "LEDGER_RECEIPT_REF_ORPHAN", severity: "ERROR", subject: "ledger", receiptId, ledgerSequence: entry.sequence, ledgerEntryId: entry.id, message: "receipt-recorded ledger entry references a Receipt file that is not currently readable.", repairable: false });

  const selectedRuns = loadedRuns.filter((item) => requestedRunId === undefined || item.run.runId === requestedRunId);
  const selectedRunIds = new Set(selectedRuns.map((item) => item.run.runId));
  const selectedReceipts = loadedReceipts.filter((item) => requestedRunId === undefined || item.receipt.runId === requestedRunId);
  const selectedLifecycle = lifecycle.filter((entry) => requestedRunId === undefined || selectedRunIds.has(entry.runId ?? ""));
  const runs = selectedRuns.map(({ run }) => toDiagnosticRun(run, lifecycleByRun.get(run.runId) ?? [], loadedReceipts));
  const receipts = selectedReceipts.map(({ receipt }) => ({ receiptId: receipt.id, taskId: receipt.taskId, ...(receipt.runId === undefined ? {} : { runId: receipt.runId }), status: receipt.status, createdAt: receipt.createdAt, ...(receipt.finishedAt === undefined ? {} : { finishedAt: receipt.finishedAt }), schemaValid: true, ...(receiptLedger.get(receipt.id) === undefined ? {} : { ledgerSequence: receiptLedger.get(receipt.id)!.sequence }) }));
  const byCategory = { MISSING: 0, ORPHAN: 0, SEMANTIC_CONFLICT: 0, INTEGRITY: 0, UNVERIFIABLE: 0 } satisfies Record<RuntimeDiagnosticCategory, number>;
  const byCode: Record<string, number> = {};
  for (const issue of issues) { byCategory[issue.category] += 1; byCode[issue.code] = (byCode[issue.code] ?? 0) + 1; }
  const indeterminate = issues.some((issue) => issue.category === "INTEGRITY" || issue.category === "UNVERIFIABLE");
  return {
    version: "1",
    generatedAt: observedAt,
    observedAt,
    readOnly: true,
    scope: requestedRunId === undefined ? "workspace" : "run",
    ...(requestedRunId === undefined ? {} : { runId: requestedRunId }),
    snapshot: { consistent: "unknown", concurrentMutationPossible: true, sourcesRead: ["runs", "receipts", "ledger"], sourceErrors },
    ledger: { path: ".stinky-cobbler/ledger.jsonl", verification, trustedEntries: selectedLifecycle.map((entry) => ({ sequence: entry.sequence, id: entry.id, event: entry.event, ...(entry.runId === undefined ? {} : { runId: entry.runId }), ...(entry.fromStatus === undefined ? {} : { fromStatus: entry.fromStatus }), ...(entry.toStatus === undefined ? {} : { toStatus: entry.toStatus }), ...(entry.receiptRef === undefined ? {} : { receiptRef: entry.receiptRef }) })), lifecycleEventCount: selectedLifecycle.length },
    runs,
    receipts,
    summary: { status: indeterminate ? "INDETERMINATE" : issues.length === 0 ? "CONSISTENT" : "ISSUES_FOUND", runCount: runs.length, terminalRunCount: runs.filter((run) => run.terminal).length, receiptCount: receipts.length, lifecycleEventCount: selectedLifecycle.length, issueCount: issues.length, byCategory, byCode },
    issues,
    boundaries: { repairPerformed: false, historyInferred: false, authorization: false, sourceContentVerified: false }
  };
}

async function loadRuns(workspace: LocalWorkspace, schemas: SchemaRegistry, issues: RuntimeDiagnosticIssue[], sourceErrors: string[]): Promise<LoadedRun[]> {
  let names: string[];
  try { names = await readdir(await workspaceFile(workspace, "runs")); } catch (error: unknown) { if (isCode(error, "ENOENT")) return []; throw error; }
  const values: LoadedRun[] = [];
  for (const name of names.filter((item) => RUN_FILE.test(item)).sort()) {
    const file = `runs/${name}`;
    try {
      const value = JSON.parse(await readFile(await workspaceFile(workspace, file), "utf8")) as AgentRun;
      schemas.validate("agent-run", value);
      if (value.runId !== name.slice(0, -5)) throw new Error("Run ID does not match filename.");
      values.push({ run: value, file });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      sourceErrors.push(`${file}: ${message}`);
      issues.push({ category: "INTEGRITY", code: "RUN_INVALID", severity: "ERROR", subject: "run", message: "Run file is not currently readable and valid.", observed: message, repairable: false });
    }
  }
  return values;
}

async function loadReceipts(workspace: LocalWorkspace, schemas: SchemaRegistry, issues: RuntimeDiagnosticIssue[], sourceErrors: string[]): Promise<LoadedReceipt[]> {
  let names: string[];
  try { names = await readdir(await workspaceFile(workspace, "receipts")); } catch (error: unknown) { if (isCode(error, "ENOENT")) return []; throw error; }
  const values: LoadedReceipt[] = [];
  for (const name of names.filter((item) => RECEIPT_FILE.test(item)).sort()) {
    const file = `receipts/${name}`;
    try {
      const value = JSON.parse(await readFile(await workspaceFile(workspace, file), "utf8")) as AgentReceipt;
      schemas.validate("receipt", value);
      if (value.id !== name.slice(0, -5)) throw new Error("Receipt ID does not match filename.");
      values.push({ receipt: value, file });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      sourceErrors.push(`${file}: ${message}`);
      issues.push({ category: "INTEGRITY", code: "RECEIPT_INVALID", severity: "ERROR", subject: "receipt", receiptId: name.slice(0, -5), message: "Receipt file is not currently readable and valid.", observed: message, repairable: false });
    }
  }
  return values;
}

function toDiagnosticRun(run: AgentRun, events: LedgerEntry[], receipts: LoadedReceipt[]): RuntimeDiagnosticRun {
  const staleness = safeStaleness(run);
  return {
    runId: run.runId,
    taskId: run.taskId,
    status: run.status,
    terminal: TERMINAL_RUN_STATUSES.includes(run.status as (typeof TERMINAL_RUN_STATUSES)[number]),
    createdAt: run.createdAt,
    ...(run.startedAt === undefined ? {} : { startedAt: run.startedAt }),
    ...(run.finishedAt === undefined ? {} : { finishedAt: run.finishedAt }),
    ...(staleness === undefined ? {} : { staleness }),
    hasOwnerToken: run.ownerToken !== undefined,
    ...(run.fenceEpoch === undefined ? {} : { fenceEpoch: run.fenceEpoch }),
    lifecycleEvents: events.map((entry) => ({ sequence: entry.sequence, id: entry.id, event: entry.event, ...(entry.fromStatus === undefined ? {} : { fromStatus: entry.fromStatus }), ...(entry.toStatus === undefined ? {} : { toStatus: entry.toStatus }) })),
    associatedReceiptIds: receipts.filter((item) => item.receipt.runId === run.runId).map((item) => item.receipt.id).sort()
  };
}

function safeStaleness(run: AgentRun): ReturnType<typeof classifyRunStaleness> | undefined { try { return classifyRunStaleness(run); } catch { return undefined; } }
function isCode(error: unknown, code: string): boolean { return typeof error === "object" && error !== null && "code" in error && error.code === code; }
