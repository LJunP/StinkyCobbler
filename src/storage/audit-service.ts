import { createHash } from "node:crypto";
import type { SchemaRegistry } from "../contracts/schema-registry.js";
import { ExitCode, StinkyCobblerError } from "../errors.js";
import { appendLedgerEntry, listLedgerEntries } from "./ledger.js";
import { createAuditOutbox, finalizeAuditOutboxOutcome, findAuditByCallId, getAuditOutbox, listPendingAuditOutbox, updateAuditOutbox, type AuditOutcome, type AuditOutboxRecord } from "./audit-outbox.js";
import { recordReceipt } from "./receipts.js";
import { withWorkspaceLock } from "./workspace-lock.js";
import type { LocalWorkspace } from "./workspace.js";

export interface McpAuditRequest {
  callId: string;
  taskId: string;
  role: string;
  tool: string;
  leaseId: string;
  taskAuthorityHash: string;
  capability: string;
  operation: string;
  reservationId?: string;
  reservationOrdinal?: number;
  outcome: Exclude<AuditOutcome, "unknown">;
}

export type McpAuditPrepareRequest = Omit<McpAuditRequest, "outcome">;

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
    if (existing !== undefined) assertRequestIdentityMatchesOutbox(request, existing);
    const initial = existing ?? await createAuditOutbox(workspace, {
      callId: request.callId,
      taskId: request.taskId,
      role: request.role,
      tool: request.tool,
      leaseId: request.leaseId,
      taskAuthorityHash: request.taskAuthorityHash,
      capability: request.capability,
      operation: request.operation,
      ...(request.reservationId === undefined ? {} : { reservationId: request.reservationId }),
      ...(request.reservationOrdinal === undefined ? {} : { reservationOrdinal: request.reservationOrdinal }),
      outcome: request.outcome,
      receiptId: receiptIdForCall(request.callId)
    });
    const outbox = initial.outcome === "unknown"
      ? await finalizeAuditOutboxOutcome(workspace, initial.id, request.outcome)
      : initial;
    if (outbox.outcome !== request.outcome) {
      throw new StinkyCobblerError("AUDIT_IDEMPOTENCY_CONFLICT", ExitCode.POLICY_DENIED, "Audit callId is already bound to a different terminal outcome.", { callId: request.callId });
    }
    return completeAudit(workspace, schemas, outbox, "AUDIT_PERSISTENCE_FAILED", "Audit persistence failed and requires explicit recovery.");
  });
}

/** Persists an inert, outcome-unknown invocation marker before capability work. */
export async function prepareMcpAudit(workspace: LocalWorkspace, request: McpAuditPrepareRequest): Promise<AuditOutboxRecord> {
  return withWorkspaceLock(workspace, async () => {
    const existing = await findAuditByCallId(workspace, request.callId);
    if (existing !== undefined) {
      assertRequestIdentityMatchesOutbox(request, existing);
      return existing;
    }
    return createAuditOutbox(workspace, {
      ...request,
      outcome: "unknown",
      receiptId: receiptIdForCall(request.callId)
    });
  });
}

export async function listPendingAudits(workspace: LocalWorkspace): Promise<AuditOutboxRecord[]> {
  return listPendingAuditOutbox(workspace);
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
  const status = outbox.outcome === "completed" ? "COMPLETED" : outbox.outcome === "rejected" || outbox.outcome === "unknown" ? "BLOCKED" : "FAILED";
  const toolSummary = outbox.outcome === "completed"
    ? "MCP workspace capability completed."
    : outbox.outcome === "rejected"
      ? "MCP workspace capability denied."
      : outbox.outcome === "unknown"
        ? "MCP workspace capability outcome is unknown after interruption."
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
    ...(outbox.leaseId === undefined ? {} : { authorityLeaseId: outbox.leaseId }),
    ...(outbox.taskAuthorityHash === undefined ? {} : { authorityHash: outbox.taskAuthorityHash }),
    ...(outbox.capability === undefined ? {} : { capability: outbox.capability }),
    ...(outbox.operation === undefined ? {} : { operation: outbox.operation }),
    ...(outbox.reservationId === undefined ? {} : { reservationId: outbox.reservationId }),
    ...(outbox.reservationOrdinal === undefined ? {} : { reservationOrdinal: outbox.reservationOrdinal }),
    createdAt: outbox.createdAt
  };
}

function assertRequestIdentityMatchesOutbox(request: McpAuditPrepareRequest, outbox: AuditOutboxRecord): void {
  if (
    outbox.taskId !== request.taskId || outbox.role !== request.role || outbox.tool !== request.tool ||
    outbox.leaseId !== request.leaseId || outbox.taskAuthorityHash !== request.taskAuthorityHash ||
    outbox.capability !== request.capability || outbox.operation !== request.operation ||
    outbox.reservationId !== request.reservationId || outbox.reservationOrdinal !== request.reservationOrdinal
  ) {
    throw new StinkyCobblerError("AUDIT_IDEMPOTENCY_CONFLICT", ExitCode.POLICY_DENIED, "Audit callId was reused with different request data.", { callId: request.callId });
  }
}

async function appendMcpLedgerIfMissing(workspace: LocalWorkspace, outbox: AuditOutboxRecord): Promise<void> {
  const entries = await listLedgerEntries(workspace);
  const effect = {
    event: "mcp-call", taskId: outbox.taskId, role: outbox.role, policyVersion: "1", tool: outbox.tool,
    ...(outbox.capability === undefined ? {} : { capability: outbox.capability }),
    ...(outbox.taskAuthorityHash === undefined ? {} : { authorityHash: outbox.taskAuthorityHash }),
    ...(outbox.reservationId === undefined ? {} : { reservationId: outbox.reservationId }),
    ...(outbox.reservationOrdinal === undefined ? {} : { reservationOrdinal: outbox.reservationOrdinal }),
    ...(outbox.leaseId === undefined ? {} : { leaseRef: outbox.leaseId }),
    receiptRef: outbox.receiptId,
    summary: outbox.outcome === "completed"
      ? "MCP workspace capability completed."
      : outbox.outcome === "rejected"
        ? "MCP workspace capability denied."
        : outbox.outcome === "unknown"
          ? "MCP workspace capability outcome is unknown after interruption."
          : "MCP workspace capability failed."
  } as const;
  const matches = entries.filter((entry) => entry.event === "mcp-call" && entry.receiptRef === outbox.receiptId);
  if (matches.length === 0) {
    await appendLedgerEntry(workspace, effect);
    return;
  }
  const exact = matches.length === 1 && Object.entries(effect).every(([field, expected]) => matches[0]?.[field as keyof typeof matches[0]] === expected);
  if (!exact) {
    throw new StinkyCobblerError("AUDIT_IDEMPOTENCY_CONFLICT", ExitCode.POLICY_DENIED, "The MCP ledger effect conflicts with its exact outbox authority provenance.", {
      outboxId: outbox.id,
      receiptId: outbox.receiptId,
      entries: matches.length
    });
  }
}

function committed(record: AuditOutboxRecord): McpAuditResult { return { callId: record.callId, receiptId: record.receiptId, outboxId: record.id, stage: "committed" }; }
function receiptIdForCall(callId: string): string {
  const digest = createHash("sha256").update(callId, "utf8").digest("hex").slice(0, 48);
  return `mcp-${digest.match(/.{1,12}/g)?.join("-") ?? digest}`;
}
