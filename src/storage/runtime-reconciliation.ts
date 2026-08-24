import type { SchemaRegistry } from "../contracts/schema-registry.js";
import type { AgentRun, AgentRunStatus } from "../contracts/types.js";
import { assertRuntimeReceiptMatchesRun, listReceipts, type AgentReceipt as StoredReceipt } from "./receipts.js";
import {
  assertRuntimeFinalizationSnapshot, findRuntimeFinalization, reconcileRuntimeFinalization,
  recordRuntimeReceipt, runtimeReceiptId, type RuntimeFinalizationStatus
} from "./runtime-finalization.js";
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
  | "RECEIPT_INVALID"
  | "RUNTIME_FINALIZATION_MISSING"
  | "RUNTIME_FINALIZATION_PREPARED"
  | "RUNTIME_FINALIZATION_INVALID"
  | "RUNTIME_FINALIZATION_MISMATCH";

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
  finalizationStatus?: RuntimeFinalizationStatus;
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
  const report = buildReport(run, receipts, schemas, false);
  let finalization: Awaited<ReturnType<typeof findRuntimeFinalization>>;
  try {
    finalization = await findRuntimeFinalization(workspace, runId);
  } catch (error: unknown) {
    report.issues.push({
      code: "RUNTIME_FINALIZATION_INVALID",
      message: "Runtime finalization journal could not be validated.",
      details: { runId, error: error instanceof Error ? error.message : String(error) }
    });
    report.repairable = false;
    return report;
  }
  if (report.terminal) {
    if (finalization === undefined) {
      report.issues.push({
        code: "RUNTIME_FINALIZATION_MISSING",
        message: "Terminal Agent run has no Runtime finalization journal.",
        details: { runId }
      });
    } else {
      report.finalizationStatus = finalization.status;
      if (finalization.status === "PREPARED") {
        report.issues.push({
          code: "RUNTIME_FINALIZATION_PREPARED",
          message: "Runtime finalization is prepared but has not committed its exact Receipt and audit effect.",
          details: { runId, finalizationId: finalization.finalizationId }
        });
      } else if (receipts.length === 1) {
        try {
          await assertRuntimeFinalizationSnapshot(workspace, schemas, run, receipts[0]!);
        } catch (error: unknown) {
          report.issues.push({
            code: "RUNTIME_FINALIZATION_MISMATCH",
            message: "Committed Runtime finalization does not exactly match its Run, Receipt, or audit target.",
            receiptId: receipts[0]!.id,
            details: { runId, error: error instanceof Error ? error.message : String(error) }
          });
        }
      } else {
        report.issues.push({
          code: "RUNTIME_FINALIZATION_MISMATCH",
          message: "Committed Runtime finalization does not have exactly one associated Receipt target.",
          details: { runId, receiptIds: receipts.map((receipt) => receipt.id) }
        });
      }
    }
  }
  const allowedRepairIssues = new Set<RuntimeReconciliationIssueCode>([
    "TERMINAL_RUN_MISSING_RECEIPT",
    "RUNTIME_FINALIZATION_MISSING",
    "RUNTIME_FINALIZATION_PREPARED"
  ]);
  report.repairable = report.terminal && report.issues.every((issue) => allowedRepairIssues.has(issue.code)) &&
    (finalization?.status === "PREPARED" || receipts.length === 0);
  return report;
}

export async function reconcileRuntimeRun(
  workspace: LocalWorkspace,
  schemas: SchemaRegistry,
  runId: string,
  options: RuntimeReconciliationOptions = {}
): Promise<RuntimeReconciliationReport> {
  const initial = await inspectRuntimeRun(workspace, schemas, runId);
  if (!options.repair) return initial;

  const prepared = await findRuntimeFinalization(workspace, runId);
  if (prepared !== undefined) {
    await reconcileRuntimeFinalization(workspace, schemas, runId);
    const reconciled = await inspectRuntimeRun(workspace, schemas, runId);
    return { ...reconciled, repaired: prepared.status !== "COMMITTED" };
  }
  if (!initial.repairable) return initial;

  // Repair is limited to an authoritative terminal Run with no Receipt. A
  // COMPLETED recovery records only Run-owned metadata and a generic recovery
  // fact; it never reconstructs lost narrative or claims additional work.
  await getTask(workspace, initial.run.taskId);
  await recordRuntimeReceipt(workspace, schemas, recoveryReceipt(initial.run));
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
    const expectedBindings: Record<string, unknown> = {
      runId: run.runId,
      taskId: run.taskId,
      capsuleId: run.capsuleId,
      leaseId: run.leaseId,
      agentId: run.agentId,
      role: run.role,
      executor: run.executor,
      policyVersion: run.policyVersion,
      executionRequestHash: run.executionRequestHash,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      budgetUsage: run.budgetUsage,
      toolCalls: run.toolCalls,
      errorCode: run.errorCode,
      blockedReason: run.blockedReason,
      createdAt: run.finishedAt ?? run.createdAt
    };
    const mismatches = Object.entries(expectedBindings)
      .filter(([field, expected]) => !sameValue(receipt[field], expected))
      .map(([field]) => field);
    if (run.status !== "COMPLETED" && !sameValue(receipt.facts, [])) mismatches.push("facts");
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
    if (!sameValue(receipt.outputHash, run.outputHash)) {
      issues.push({ code: "RECEIPT_OUTPUT_HASH_MISMATCH", message: "Receipt outputHash does not match the Agent run.", receiptId: receipt.id, details: { expected: run.outputHash, actual: receipt.outputHash } });
    }
    try {
      assertRuntimeReceiptMatchesRun(receipt, run);
    } catch {
      if (!issues.some((issue) => issue.receiptId === receipt.id && issue.code === "RECEIPT_RUN_BINDING_MISMATCH")) {
        issues.push({ code: "RECEIPT_RUN_BINDING_MISMATCH", message: "Receipt does not exactly match the authoritative terminal Agent run.", receiptId: receipt.id });
      }
    }
  }

  const repairable = false;
  return { run, terminal, staleness, receipts, issues, repairable, repaired };
}

function recoveryReceipt(run: AgentRun): Record<string, unknown> {
  const status = run.status === "COMPLETED" ? "COMPLETED" : run.status === "FAILED" ? "FAILED" : "BLOCKED";
  const reason = run.blockedReason ?? run.errorCode ?? `Run ended in ${run.status} without a Receipt.`;
  return {
    id: runtimeReceiptId(run.runId),
    taskId: run.taskId,
    role: run.role,
    status,
    facts: run.status === "COMPLETED"
      ? [{ statement: "Receipt reconstructed from the authoritative terminal Run after interrupted finalization.", evidenceRefs: run.evidenceRefs ?? [] }]
      : [],
    proposals: [],
    unknowns: run.status === "COMPLETED"
      ? ["The original in-memory Receipt narrative was unavailable; only persisted Run metadata was recovered."]
      : [`Recovery recorded from terminal Run ${run.runId}: ${reason}`],
    evidenceRefs: run.evidenceRefs ?? [],
    changedPaths: [],
    policyVersion: run.policyVersion,
    executionRequestHash: run.executionRequestHash,
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

function sameValue(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }
