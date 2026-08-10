import { describe, expect, it, afterEach } from "vitest";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { initWorkspace, workspaceFile } from "../src/storage/workspace.js";
import { createAuditOutbox, findAuditByCallId, getAuditOutbox, listAuditOutbox, updateAuditOutbox } from "../src/storage/audit-outbox.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "stinky-outbox-"));
  roots.push(root);
  return { root, workspace: await initWorkspace(root) };
}

const input = {
  callId: "call-1",
  taskId: "task-1",
  role: "scout",
  tool: "repo-read",
  outcome: "completed" as const,
  receiptId: "mcp-receipt-1"
};

describe("audit outbox", () => {
  it("stores only workspace metadata and assigns an id", async () => {
    const { workspace } = await setup();
    const record = await createAuditOutbox(workspace, input);

    expect(record.id).toMatch(/^audit-[0-9a-f-]{36}$/i);
    expect(record.stage).toBe("prepared");
    expect(record.attempts).toBe(0);
    expect(await workspaceFile(workspace, "audit-outbox.json")).toBe(path.join(workspace.root, ".stinky-cobbler", "audit-outbox.json"));
    expect(await readdir(workspace.root)).toEqual([".stinky-cobbler"]);
    expect(await readdir(workspace.directory)).toEqual(["audit-outbox.json"]);
    expect(JSON.parse(await readFile(path.join(workspace.directory, "audit-outbox.json"), "utf8"))).toEqual([record]);
  });

  it("makes create idempotent by callId, including concurrent retries", async () => {
    const { workspace } = await setup();
    const records = await Promise.all(Array.from({ length: 20 }, () => createAuditOutbox(workspace, input)));

    expect(new Set(records.map((record) => record.id)).size).toBe(1);
    await expect(findAuditByCallId(workspace, input.callId)).resolves.toEqual(records[0]);
    await expect(listAuditOutbox(workspace)).resolves.toHaveLength(1);
  });

  it("supports prepared, recovery-required, and committed stages with stable error codes", async () => {
    const { workspace } = await setup();
    const record = await createAuditOutbox(workspace, input);

    const recovery = await updateAuditOutbox(workspace, record.id, {
      stage: "recovery-required",
      attempts: 1,
      errorCode: "AUDIT_PERSISTENCE_FAILED"
    });
    expect(recovery).toMatchObject({ stage: "recovery-required", attempts: 1, errorCode: "AUDIT_PERSISTENCE_FAILED" });

    const committed = await updateAuditOutbox(workspace, record.id, { stage: "committed", attempts: 2 });
    expect(committed).toMatchObject({ stage: "committed", attempts: 2, errorCode: "AUDIT_PERSISTENCE_FAILED" });
    await expect(getAuditOutbox(workspace, record.id)).resolves.toEqual(committed);
  });

  it("rejects unsafe input, invalid stages, and unstable error codes", async () => {
    const { workspace } = await setup();

    await expect(createAuditOutbox(workspace, { ...input, callId: "../escape" })).rejects.toMatchObject({ code: "AUDIT_OUTBOX_INVALID" });
    await expect(createAuditOutbox(workspace, { ...input, id: "caller-owned" } as never)).rejects.toMatchObject({ code: "AUDIT_OUTBOX_INVALID" });
    const record = await createAuditOutbox(workspace, input);
    await expect(updateAuditOutbox(workspace, record.id, { stage: "ledger-recorded" as never })).rejects.toMatchObject({ code: "AUDIT_OUTBOX_INVALID" });
    await expect(updateAuditOutbox(workspace, record.id, { stage: "recovery-required", errorCode: "not-stable" })).rejects.toMatchObject({ code: "AUDIT_OUTBOX_INVALID" });
  });

  it("rejects conflicting idempotency payloads and state regression", async () => {
    const { workspace } = await setup();
    const record = await createAuditOutbox(workspace, input);
    await expect(createAuditOutbox(workspace, { ...input, tool: "different-tool" })).rejects.toMatchObject({ code: "AUDIT_IDEMPOTENCY_CONFLICT" });
    await expect(updateAuditOutbox(workspace, record.id, { stage: "committed", attempts: 2 })).resolves.toMatchObject({ stage: "committed" });
    await expect(updateAuditOutbox(workspace, record.id, { stage: "prepared", attempts: 1 })).rejects.toMatchObject({ code: "AUDIT_OUTBOX_STATE_REGRESSION" });
  });
  it("returns stable not-found and empty-list behavior", async () => {
    const { workspace } = await setup();

    await expect(listAuditOutbox(workspace)).resolves.toEqual([]);
    await expect(findAuditByCallId(workspace, "unknown-call")).resolves.toBeUndefined();
    await expect(getAuditOutbox(workspace, "audit-missing")).rejects.toMatchObject({ code: "AUDIT_OUTBOX_NOT_FOUND" });
  });
});
