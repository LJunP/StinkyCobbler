import { createHash } from "node:crypto";
import type { SchemaRegistry } from "../contracts/schema-registry.js";
import type { AgentRun, AgentRunStatus } from "../contracts/types.js";
import { recordReceipt, listReceipts, type AgentReceipt as StoredReceipt } from "./receipts.js";
import { getTask } from "./tasks.js";
import { classifyRunStaleness, getRun, TERMINAL_RUN_STATUSES } from "./runs.js";
import type { LocalWorkspace } from "./workspace.js";

export type RuntimeReconciliationIssueCode =
  | "TERMINAL_RUN_MISSING_RECEIPT"
  | "MULTIPLE_RECEIPTS_FOR_RUN"
  | "RECEIPT_RUN_BINDING_MISMATCH"
  | "RECEIPT_STATUS_MISMATCH"
  | "RECEIPT_EVIDENCE_MISMATCH"
  | "RECEIPT_OUTPUT_HASH_MISMATCH"
  | "NONTERMINAL_RUN_WITH_RECEIPT"
  | "RECEIPT_INVALID";

export interface RuntimeReconciliationIssue {
  code: RuntimeReconciliationIssueCode;
  message: string;
  receiptId?: string;
  details?: Record<string, unknown>;
}

export interface RuntimeReconciliationReport {
  run: AgentRun;
  terminal: boolean;
  staleness: ReturnType<typeof classifyRunStaleness>;
  receipts: StoredReceipt[];
  issues: RuntimeReconciliationIssue[];
  repairable: boolean;
  repaired: boolean;
}

export interface RuntimeReconciliationOptions { repair?: boolean; }

export async function inspectRuntimeRun(
  workspace: LocalWorkspace,
  schemas: SchemaRegistry,
  runId: string
): Promise<RuntimeReconciliationReport> {
  const run = await getRun(workspace, runId);
  const receipts = (await listReceipts(workspace)).filter((receipt) => receipt.runId === run.runId);
  return buildReport(run, receipts, schemas, false);
}

export async function reconcileRuntimeRun(
  workspace: LocalWorkspace,
  schemas: SchemaRegistry,
  runId: string,
  options: RuntimeReconciliationOptions = {}
): Promise<RuntimeReconciliationReport> {
  const initial = await inspectRuntimeRun(workspace, schemas, runId);
  if (!options.repair || !initial.repairable) return initial;

  // Repair is deliberately limited to a non-success terminal Run with no Receipt.
  // It records only a control-plane recovery fact and never changes the Run itself.
  await getTask(workspace, initial.run.taskId);
  await recordReceipt(workspace, schemas, recoveryReceipt(initial.run));
  const repaired = await inspectRuntimeRun(workspace, schemas, runId);
  return { ...repaired, repaired: true };
}

function buildReport(run: AgentRun, receipts: StoredReceipt[], schemas: SchemaRegistry, repaired: boolean): RuntimeReconciliationReport {
  const issues: RuntimeReconciliationIssue[] = [];
  const terminal = TERMINAL_RUN_STATUSES.includes(run.status as (typeof TERMINAL_RUN_STATUSES)[number]);
  const staleness = classifyRunStaleness(run);

  if (terminal && receipts.length === 0) {
    issues.push({
      code: "TERMINAL_RUN_MISSING_RECEIPT",
      message: "Terminal Agent run has no associated Receipt.",
      details: { runId: run.runId, status: run.status }
    });
  }
  if (!terminal && receipts.length > 0) {
    issues.push({
      code: "NONTERMINAL_RUN_WITH_RECEIPT",
      message: "Non-terminal Agent run has an associated Receipt.",
      details: { runId: run.runId, status: run.status }
    });
  }
  if (receipts.length > 1) {
    issues.push({
      code: "MULTIPLE_RECEIPTS_FOR_RUN",
      message: "Multiple Receipts are associated with one Agent run.",
      details: { runId: run.runId, receiptIds: receipts.map((receipt) => receipt.id) }
    });
  }

  for (const receipt of receipts) {
    try {
      schemas.validate("receipt", receipt);
    } catch (error: unknown) {
      issues.push({ code: "RECEIPT_INVALID", message: "Associated Receipt does not satisfy the Receipt schema.", receiptId: receipt.id, details: { error: error instanceof Error ? error.message : String(error) } });
      continue;
    }
    const bindingFields = ["runId", "taskId", "capsuleId", "leaseId", "agentId", "role", "executor"] as const;
    const mismatches = bindingFields.filter((field) => {
      const value = receipt[field];
      return value !== undefined && value !== run[field as keyof AgentRun];
    });
    if (mismatches.length > 0) {
      issues.push({ code: "RECEIPT_RUN_BINDING_MISMATCH", message: "Receipt runtime bindings do not match the Agent run.", receiptId: receipt.id, details: { fields: mismatches } });
    }

    const expectedStatus = receiptStatusForRun(run.status);
    if (expectedStatus !== undefined && receipt.status !== expectedStatus) {
      issues.push({ code: "RECEIPT_STATUS_MISMATCH", message: "Receipt status does not match the terminal Agent run status.", receiptId: receipt.id, details: { expected: expectedStatus, actual: receipt.status } });
    }
    if (!sameStringArray(asStringArray(receipt.evidenceRefs), run.evidenceRefs ?? [])) {
      issues.push({ code: "RECEIPT_EVIDENCE_MISMATCH", message: "Receipt evidenceRefs do not match the Agent run.", receiptId: receipt.id, details: { expected: run.evidenceRefs ?? [], actual: receipt.evidenceRefs } });
    }
    if (run.outputHash !== undefined && receipt.outputHash !== run.outputHash) {
      issues.push({ code: "RECEIPT_OUTPUT_HASH_MISMATCH", message: "Receipt outputHash does not match the Agent run.", receiptId: receipt.id, details: { expected: run.outputHash, actual: receipt.outputHash } });
    }
  }

  const repairable = terminal && run.status !== "COMPLETED" && receipts.length === 0 && !issues.some((issue) => issue.code !== "TERMINAL_RUN_MISSING_RECEIPT");
  return { run, terminal, staleness, receipts, issues, repairable, repaired };
}

function recoveryReceipt(run: AgentRun): Record<string, unknown> {
  const status = run.status === "FAILED" ? "FAILED" : "BLOCKED";
  const reason = run.blockedReason ?? run.errorCode ?? `Run ended in ${run.status} without a Receipt.`;
  return {
    id: recoveryReceiptId(run.runId),
    taskId: run.taskId,
    role: run.role,
    status,
    facts: [],
    proposals: [],
    unknowns: [`Recovery recorded from terminal Run ${run.runId}: ${reason}`],
    evidenceRefs: run.evidenceRefs ?? [],
    changedPaths: [],
    policyVersion: run.policyVersion,
    toolSummary: "Runtime reconciliation recovery; no execution was performed.",
    createdAt: run.finishedAt ?? run.createdAt,
    runId: run.runId,
    capsuleId: run.capsuleId,
    leaseId: run.leaseId,
    agentId: run.agentId,
    executor: run.executor,
    ...(run.startedAt === undefined ? {} : { startedAt: run.startedAt }),
    ...(run.finishedAt === undefined ? {} : { finishedAt: run.finishedAt }),
    ...(run.budgetUsage === undefined ? {} : { budgetUsage: run.budgetUsage }),
    ...(run.toolCalls === undefined ? {} : { toolCalls: run.toolCalls }),
    ...(run.outputHash === undefined ? {} : { outputHash: run.outputHash }),
    ...(run.errorCode === undefined ? {} : { errorCode: run.errorCode }),
    ...(run.blockedReason === undefined ? {} : { blockedReason: run.blockedReason })
  };
}

function recoveryReceiptId(runId: string): string {
  return `runtime-recovery-${createHash("sha256").update(runId, "utf8").digest("hex").slice(0, 12)}`;
}

function receiptStatusForRun(status: AgentRunStatus): StoredReceipt["status"] | undefined {
  if (status === "COMPLETED") return "COMPLETED";
  if (status === "FAILED") return "FAILED";
  if (status === "BLOCKED" || status === "TIMED_OUT" || status === "CANCELLED") return "BLOCKED";
  return undefined;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) && value.every((item): item is string => typeof item === "string") ? value : [];
}

function sameStringArray(left: string[] | undefined, right: string[]): boolean {
  return JSON.stringify(left ?? []) === JSON.stringify(right);
}

