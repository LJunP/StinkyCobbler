import { describe, expect, it, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SchemaRegistry } from "../src/contracts/schema-registry.js";
import { createAuditOutbox, injectAuditOutboxCreateFaultForTesting, updateAuditOutbox } from "../src/storage/audit-outbox.js";
import { persistMcpAudit, prepareMcpAudit, recoverMcpAudit, listPendingAudits } from "../src/storage/audit-service.js";
import { initWorkspace } from "../src/storage/workspace.js";
import { createTask } from "../src/storage/tasks.js";
import { listLedgerEntries, verifyLedger } from "../src/storage/ledger.js";
import { listReceipts } from "../src/storage/receipts.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const projectRoot = path.resolve(import.meta.dirname, "..");
async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "stinky-audit-service-")); roots.push(root);
  const workspace = await initWorkspace(root);
  await createTask(workspace, { id: "task", workspaceId: "ws", goal: "audit", requestedOutputs: ["document"], riskLevel: "L0", state: "DRAFT" });
  return { workspace, schemas: await SchemaRegistry.create(projectRoot) };
}
const provenance = {
  leaseId: "lease-1",
  taskAuthorityHash: `sha256:${"a".repeat(64)}`,
  capability: "repository-read",
  operation: "repository-read"
};
function auditRequest(callId: string, outcome: "completed" | "rejected" | "failed", patch: Record<string, unknown> = {}) {
  return { callId, taskId: "task", role: "scout", tool: "repository-read", ...provenance, outcome, ...patch };
}
function auditPrepare(callId: string, patch: Record<string, unknown> = {}) {
  return { callId, taskId: "task", role: "scout", tool: "repository-read", ...provenance, ...patch };
}

describe("audit service", () => {
  it("commits a receipt and mcp-call ledger idempotently", async () => {
    const { workspace, schemas } = await setup();
    const request = { ...auditRequest("call-1", "completed"), reservationId: "reservation-1", reservationOrdinal: 1 };
    const first = await persistMcpAudit(workspace, schemas, request);
    const second = await persistMcpAudit(workspace, schemas, request);
    expect(second).toEqual(first);
    await expect(verifyLedger(workspace)).resolves.toMatchObject({ valid: true, entries: 2 });
    await expect(listReceipts(workspace)).resolves.toEqual([
      expect.objectContaining({ authorityLeaseId: "lease-1", authorityHash: provenance.taskAuthorityHash, capability: "repository-read", operation: "repository-read", reservationId: "reservation-1", reservationOrdinal: 1 })
    ]);
    await expect(listLedgerEntries(workspace)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ event: "mcp-call", leaseRef: "lease-1", authorityHash: provenance.taskAuthorityHash, capability: "repository-read", tool: "repository-read", reservationId: "reservation-1", reservationOrdinal: 1 })
    ]));
  });

  it("prepares an outcome-unknown marker and finalizes only one observed outcome", async () => {
    const { workspace, schemas } = await setup();
    const prepared = await prepareMcpAudit(workspace, auditPrepare("call-prepared"));
    expect(prepared).toMatchObject({ outcome: "unknown", stage: "prepared" });
    await expect(listPendingAudits(workspace)).resolves.toEqual([prepared]);
    await expect(persistMcpAudit(workspace, schemas, auditRequest("call-prepared", "completed")))
      .resolves.toMatchObject({ stage: "committed" });
    await expect(persistMcpAudit(workspace, schemas, auditRequest("call-prepared", "failed")))
      .rejects.toMatchObject({ code: "AUDIT_IDEMPOTENCY_CONFLICT" });
    await expect(listPendingAudits(workspace)).resolves.toEqual([]);
  });

  it("recovers an interrupted unknown outcome explicitly without inventing success", async () => {
    const { workspace, schemas } = await setup();
    const prepared = await prepareMcpAudit(workspace, auditPrepare("call-unknown"));
    await expect(recoverMcpAudit(workspace, schemas, prepared.id)).resolves.toMatchObject({ stage: "committed" });
    await expect(listPendingAudits(workspace)).resolves.toEqual([]);
    await expect(verifyLedger(workspace)).resolves.toMatchObject({ valid: true, entries: 2 });
  });

  it("recovers a prepared outbox by creating its deterministic receipt", async () => {
    const { workspace, schemas } = await setup();
    const outbox = await createAuditOutbox(workspace, { callId: "call-2", taskId: "task", role: "scout", tool: "repository-read", outcome: "completed", receiptId: "mcp-receipt-2" });
    await expect(listPendingAudits(workspace)).resolves.toHaveLength(1);
    await expect(recoverMcpAudit(workspace, schemas, outbox.id)).resolves.toMatchObject({ callId: "call-2", receiptId: "mcp-receipt-2", stage: "committed" });
    await expect(listPendingAudits(workspace)).resolves.toHaveLength(0);
    await expect(verifyLedger(workspace)).resolves.toMatchObject({ valid: true, entries: 2 });
  });

  it("retries a high-level index split with the same deterministic receipt identity", async () => {
    const { workspace, schemas } = await setup();
    const request = auditRequest("call-index-split", "completed");
    injectAuditOutboxCreateFaultForTesting(workspace, "after-call-index");
    await expect(persistMcpAudit(workspace, schemas, request)).rejects.toMatchObject({ code: "AUDIT_OUTBOX_CREATE_FAULT" });
    await expect(listPendingAudits(workspace)).resolves.toEqual([
      expect.objectContaining({ callId: request.callId, stage: "prepared" })
    ]);

    const recovered = await persistMcpAudit(workspace, schemas, request);
    await expect(persistMcpAudit(workspace, schemas, request)).resolves.toEqual(recovered);
    await expect(listPendingAudits(workspace)).resolves.toEqual([]);
    await expect(verifyLedger(workspace)).resolves.toMatchObject({ valid: true, entries: 2 });
  });

  it("rejects conflicting payloads through the high-level audit API", async () => {
    const { workspace, schemas } = await setup();
    await persistMcpAudit(workspace, schemas, auditRequest("call-conflict", "completed"));
    await expect(persistMcpAudit(workspace, schemas, auditRequest("call-conflict", "completed", { role: "other" }))).rejects.toMatchObject({ code: "AUDIT_IDEMPOTENCY_CONFLICT" });
  });

  it("resumes a recovery-required outbox without regressing its stage", async () => {
    const { workspace, schemas } = await setup();
    const outbox = await createAuditOutbox(workspace, { callId: "call-3", taskId: "task", role: "scout", tool: "repository-read", outcome: "failed", receiptId: "mcp-receipt-3" });
    await updateAuditOutbox(workspace, outbox.id, { stage: "recovery-required", attempts: 1, errorCode: "AUDIT_PERSISTENCE_FAILED" });
    await expect(recoverMcpAudit(workspace, schemas, outbox.id)).resolves.toMatchObject({ stage: "committed" });
    await expect(recoverMcpAudit(workspace, schemas, outbox.id)).resolves.toMatchObject({ stage: "committed" });
    await expect(verifyLedger(workspace)).resolves.toMatchObject({ valid: true, entries: 2 });
  });
});
