import { describe, expect, it, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SchemaRegistry } from "../src/contracts/schema-registry.js";
import { createAuditOutbox, updateAuditOutbox } from "../src/storage/audit-outbox.js";
import { persistMcpAudit, recoverMcpAudit, listPendingAudits } from "../src/storage/audit-service.js";
import { initWorkspace } from "../src/storage/workspace.js";
import { createTask } from "../src/storage/tasks.js";
import { verifyLedger } from "../src/storage/ledger.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const projectRoot = path.resolve(import.meta.dirname, "..");
async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "stinky-audit-service-")); roots.push(root);
  const workspace = await initWorkspace(root);
  await createTask(workspace, { id: "task", workspaceId: "ws", goal: "audit", requestedOutputs: ["document"], riskLevel: "L0", state: "DRAFT" });
  return { workspace, schemas: await SchemaRegistry.create(projectRoot) };
}

describe("audit service", () => {
  it("commits a receipt and mcp-call ledger idempotently", async () => {
    const { workspace, schemas } = await setup();
    const first = await persistMcpAudit(workspace, schemas, { callId: "call-1", taskId: "task", role: "scout", tool: "repository-read", outcome: "completed" });
    const second = await persistMcpAudit(workspace, schemas, { callId: "call-1", taskId: "task", role: "scout", tool: "repository-read", outcome: "completed" });
    expect(second).toEqual(first);
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

  it("rejects conflicting payloads through the high-level audit API", async () => {
    const { workspace, schemas } = await setup();
    await persistMcpAudit(workspace, schemas, { callId: "call-conflict", taskId: "task", role: "scout", tool: "repository-read", outcome: "completed" });
    await expect(persistMcpAudit(workspace, schemas, { callId: "call-conflict", taskId: "task", role: "other", tool: "repository-read", outcome: "completed" })).rejects.toMatchObject({ code: "AUDIT_IDEMPOTENCY_CONFLICT" });
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
