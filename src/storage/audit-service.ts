import { randomUUID } from "node:crypto";
import type { SchemaRegistry } from "../contracts/schema-registry.js";
import { ExitCode, StinkyCobblerError } from "../errors.js";
import { appendLedgerEntry, listLedgerEntries } from "./ledger.js";
import { createAuditOutbox, findAuditByCallId, getAuditOutbox, updateAuditOutbox, type AuditOutcome, type AuditOutboxRecord } from "./audit-outbox.js";
import { recordReceipt } from "./receipts.js";
import { withWorkspaceLock } from "./workspace-lock.js";
import type { LocalWorkspace } from "./workspace.js";

export interface McpAuditRequest {
  callId: string;
  taskId: string;
  role: string;
  tool: string;
  outcome: AuditOutcome;
}

export interface McpAuditResult {
  callId: string;
  receiptId: string;
  outboxId: string;
  stage: "committed";
}

/**
 * Persists the minimum audit facts for a workspace-bound MCP invocation.
 * The outbox makes the multi-file sequence explicit; it is not a database
 * transaction and therefore recovery remains an explicit operation.
 */
export async function persistMcpAudit(workspace: LocalWorkspace, schemas: SchemaRegistry, request: McpAuditRequest): Promise<McpAuditResult> {
  return withWorkspaceLock(workspace, async () => {
    const existing = await findAuditByCallId(workspace, request.callId);
    if (existing !== undefined) assertRequestMatchesOutbox(request, existing);

    const outbox = existing ?? await createAuditOutbox(workspace, {
      callId: request.callId,
      taskId: request.taskId,
      role: request.role,
      tool: request.tool,
      outcome: request.outcome,
      receiptId: `mcp-${randomUUID()}`
    });
    return completeAudit(workspace, schemas, outbox, "AUDIT_PERSISTENCE_FAILED", "Audit persistence failed and requires explicit recovery.");
  });
}

export async function listPendingAudits(workspace: LocalWorkspace): Promise<AuditOutboxRecord[]> {
  const { listAuditOutbox } = await import("./audit-outbox.js");
  return (await listAuditOutbox(workspace)).filter((record) => record.stage !== "committed");
}

export async function recoverMcpAudit(workspace: LocalWorkspace, schemas: SchemaRegistry, outboxId: string): Promise<McpAuditResult> {
  return withWorkspaceLock(workspace, async () => {
    const current = await getAuditOutbox(workspace, outboxId);
    if (current.stage === "committed") return committed(current);
    return completeAudit(workspace, schemas, current, "AUDIT_RECOVERY_FAILED", "Audit recovery could not complete.");
  });
}

/** Completes the deterministic outbox sequence without moving a recovery-required record backwards. */
async function completeAudit(
  workspace: LocalWorkspace,
  schemas: SchemaRegistry,
  initial: AuditOutboxRecord,
  failureCode: "AUDIT_PERSISTENCE_FAILED" | "AUDIT_RECOVERY_FAILED",
  failureMessage: string
): Promise<McpAuditResult> {
  let current = initial;
  try {
    await recordReceipt(workspace, schemas, receiptFor(current));
    if (current.stage === "prepared") {
      current = await updateAuditOutbox(workspace, current.id, { stage: "prepared", attempts: current.attempts + 1 });
    }
    await appendMcpLedgerIfMissing(workspace, current);
    current = await updateAuditOutbox(workspace, current.id, { stage: "committed", attempts: current.attempts + 1 });
    return committed(current);
  } catch {
    await updateAuditOutbox(workspace, current.id, {
      stage: "recovery-required",
      attempts: current.attempts + 1,
      lastErrorCode: failureCode
    }).catch(() => undefined);
    throw new StinkyCobblerError(failureCode, ExitCode.POLICY_DENIED, failureMessage);
  }
}

function receiptFor(outbox: AuditOutboxRecord): Record<string, unknown> {
  const status = outbox.outcome === "completed" ? "COMPLETED" : outbox.outcome === "rejected" ? "BLOCKED" : "FAILED";
  const toolSummary = outbox.outcome === "completed"
    ? "MCP workspace capability completed."
    : outbox.outcome === "rejected"
      ? "MCP workspace capability denied."
      : "MCP workspace capability failed.";
  return {
    id: outbox.receiptId,
    taskId: outbox.taskId,
    role: outbox.role,
    status,
    facts: [],
    proposals: [],
    unknowns: [],
    evidenceRefs: [],
    policyVersion: "1",
    toolSummary,
    createdAt: outbox.createdAt
  };
}

function assertRequestMatchesOutbox(request: McpAuditRequest, outbox: AuditOutboxRecord): void {
  if (outbox.taskId !== request.taskId || outbox.role !== request.role || outbox.tool !== request.tool || outbox.outcome !== request.outcome) {
    throw new StinkyCobblerError("AUDIT_IDEMPOTENCY_CONFLICT", ExitCode.POLICY_DENIED, "Audit callId was reused with different request data.", { callId: request.callId });
  }
}

async function appendMcpLedgerIfMissing(workspace: LocalWorkspace, outbox: AuditOutboxRecord): Promise<void> {
  const entries = await listLedgerEntries(workspace);
  const alreadyRecorded = entries.some((entry) => entry.event === "mcp-call" && entry.receiptRef === outbox.receiptId && entry.taskId === outbox.taskId);
  if (alreadyRecorded) return;
  await appendLedgerEntry(workspace, {
    event: "mcp-call", taskId: outbox.taskId, role: outbox.role, policyVersion: "1", tool: outbox.tool,
    receiptRef: outbox.receiptId,
    summary: outbox.outcome === "completed" ? "MCP workspace capability completed." : outbox.outcome === "rejected" ? "MCP workspace capability denied." : "MCP workspace capability failed."
  });
}

function committed(record: AuditOutboxRecord): McpAuditResult { return { callId: record.callId, receiptId: record.receiptId, outboxId: record.id, stage: "committed" }; }
