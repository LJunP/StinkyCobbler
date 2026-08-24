import { describe, expect, it, afterEach } from "vitest";
import { mkdtemp, readdir, readFile, rm, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { initWorkspace, workspaceFile } from "../src/storage/workspace.js";
import { createAuditOutbox, findAuditByCallId, getAuditOutbox, injectAuditOutboxCreateFaultForTesting, listAuditOutbox, listPendingAuditOutbox, MAX_AUDIT_OUTBOX_LEGACY_BYTES, MAX_AUDIT_OUTBOX_LEGACY_RECORDS, MAX_AUDIT_OUTBOX_LIST_BATCH, MAX_AUDIT_OUTBOX_PENDING, updateAuditOutbox } from "../src/storage/audit-outbox.js";

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
const authorityInput = {
  ...input,
  tool: "repository-list",
  leaseId: "lease-1",
  taskAuthorityHash: `sha256:${"a".repeat(64)}`,
  capability: "repository-read",
  operation: "repository-list",
  reservationId: "reservation-1",
  reservationOrdinal: 1
};

describe("audit outbox", () => {
  it("stores only workspace metadata and assigns an id", async () => {
    const { workspace } = await setup();
    const record = await createAuditOutbox(workspace, input);

    expect(record.id).toMatch(/^audit-[0-9a-f]{48}$/i);
    expect(record.stage).toBe("prepared");
    expect(record.attempts).toBe(0);
    expect(await workspaceFile(workspace, "audit-outbox.json")).toBe(path.join(workspace.root, ".stinky-cobbler", "audit-outbox.json"));
    expect(await readdir(workspace.root)).toEqual([".stinky-cobbler"]);
    expect(await readdir(workspace.directory)).toEqual(["audit-outbox", "audit-outbox.json"]);
    expect(JSON.parse(await readFile(path.join(workspace.directory, "audit-outbox.json"), "utf8"))).toEqual({
      version: 2,
      recordsDirectory: "audit-outbox/records",
      callsDirectory: "audit-outbox/calls",
      receiptsDirectory: "audit-outbox/receipts",
      pendingDirectory: "audit-outbox/pending"
    });
    expect(JSON.parse(await readFile(path.join(workspace.directory, "audit-outbox", "records", `${record.id}.json`), "utf8"))).toEqual(record);
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
  it("binds Lease authority, concrete operation, and reservation provenance into idempotency", async () => {
    const { workspace } = await setup();
    const record = await createAuditOutbox(workspace, authorityInput);
    expect(record).toMatchObject(authorityInput);
    await expect(createAuditOutbox(workspace, { ...authorityInput, reservationOrdinal: 2 }))
      .rejects.toMatchObject({ code: "AUDIT_IDEMPOTENCY_CONFLICT" });
    await expect(createAuditOutbox(workspace, { ...authorityInput, operation: "repository-read" }))
      .rejects.toMatchObject({ code: "AUDIT_OUTBOX_INVALID" });
  });
  it("returns stable not-found and empty-list behavior", async () => {
    const { workspace } = await setup();

    await expect(listAuditOutbox(workspace)).resolves.toEqual([]);
    await expect(findAuditByCallId(workspace, "unknown-call")).resolves.toBeUndefined();
    await expect(getAuditOutbox(workspace, "audit-missing")).rejects.toMatchObject({ code: "AUDIT_OUTBOX_NOT_FOUND" });
  });

  it("rejects schema-invalid aggregates and every ambiguous lookup key", async () => {
    const { workspace } = await setup();
    const first = await createAuditOutbox(workspace, input);
    const second = await createAuditOutbox(workspace, { ...input, callId: "call-2", receiptId: "mcp-receipt-2" });
    const target = await workspaceFile(workspace, "audit-outbox.json");

    await writeFile(target, JSON.stringify([{ ...first, callerInjected: true }]), "utf8");
    await expect(listAuditOutbox(workspace)).rejects.toMatchObject({ code: "SCHEMA_INVALID", details: { kind: "audit-outbox" } });
    for (const field of ["id", "callId", "receiptId"] as const) {
      await writeFile(target, JSON.stringify([first, { ...second, [field]: first[field] }]), "utf8");
      await expect(listAuditOutbox(workspace)).rejects.toMatchObject({ code: "AUDIT_OUTBOX_INVALID" });
    }
  });

  it("migrates the v1 array without dropping pending records or idempotency lookup", async () => {
    const { workspace } = await setup();
    const record = await createAuditOutbox(workspace, input);
    const target = await workspaceFile(workspace, "audit-outbox.json");
    await writeFile(target, JSON.stringify([record]), "utf8");

    const next = await updateAuditOutbox(workspace, record.id, { stage: "recovery-required", attempts: 1, errorCode: "AUDIT_PERSISTENCE_FAILED" });
    await expect(findAuditByCallId(workspace, record.callId)).resolves.toEqual(next);
    await expect(listPendingAuditOutbox(workspace)).resolves.toEqual([next]);
    expect(JSON.parse(await readFile(target, "utf8"))).toMatchObject({ version: 2 });
  });

  it("rejects oversized legacy aggregates before unbounded migration work", async () => {
    const { workspace } = await setup();
    const record = await createAuditOutbox(workspace, input);
    const target = await workspaceFile(workspace, "audit-outbox.json");
    await writeFile(target, JSON.stringify(Array.from({ length: MAX_AUDIT_OUTBOX_LEGACY_RECORDS + 1 }, (_, index) => ({
      ...record,
      id: `audit-legacy-${index}`,
      callId: `call-legacy-${index}`,
      receiptId: `receipt-legacy-${index}`,
      stage: "committed"
    }))), "utf8");
    await expect(listAuditOutbox(workspace)).rejects.toMatchObject({ code: "SCHEMA_INVALID" });

    await writeFile(target, "[]", "utf8");
    await truncate(target, MAX_AUDIT_OUTBOX_LEGACY_BYTES + 1);
    await expect(listAuditOutbox(workspace)).rejects.toMatchObject({ code: "AUDIT_OUTBOX_INVALID" });
  });

  it("rebuilds an exact pending request after an index-before-record crash window", async () => {
    const { workspace } = await setup();
    const first = await createAuditOutbox(workspace, input);
    await rm(path.join(workspace.directory, "audit-outbox", "records", `${first.id}.json`));

    await expect(findAuditByCallId(workspace, input.callId)).resolves.toBeUndefined();
    const recovered = await createAuditOutbox(workspace, input);
    expect(recovered).toMatchObject({ id: first.id, callId: input.callId, receiptId: input.receiptId, stage: "prepared" });
    await expect(listPendingAuditOutbox(workspace)).resolves.toEqual([recovered]);
  });

  for (const point of ["after-marker", "after-call-index", "after-receipt-index"] as const) {
    it(`keeps ${point} create crashes visible and exactly recoverable`, async () => {
      const { workspace } = await setup();
      injectAuditOutboxCreateFaultForTesting(workspace, point);
      await expect(createAuditOutbox(workspace, input))
        .rejects.toMatchObject({ code: "AUDIT_OUTBOX_CREATE_FAULT", details: { point } });
      const [materialized] = await listPendingAuditOutbox(workspace);
      expect(materialized).toMatchObject({ callId: input.callId, receiptId: input.receiptId, stage: "prepared" });

      const recovered = await createAuditOutbox(workspace, input);
      expect(recovered).toEqual(materialized);
      await expect(listPendingAuditOutbox(workspace)).resolves.toEqual([recovered]);
      await expect(findAuditByCallId(workspace, input.callId)).resolves.toEqual(recovered);
    });
  }

  it("keeps normal direct lookups and pending checks bounded after historical growth", async () => {
    const { workspace } = await setup();
    const record = await createAuditOutbox(workspace, input);
    await updateAuditOutbox(workspace, record.id, { stage: "committed", attempts: 1 });
    const recordsDirectory = path.join(workspace.directory, "audit-outbox", "records");
    await Promise.all(Array.from({ length: MAX_AUDIT_OUTBOX_LIST_BATCH }, async (_, index) => {
      const copy = {
        ...record,
        id: `audit-history-${String(index).padStart(3, "0")}`,
        callId: `history-call-${String(index).padStart(3, "0")}`,
        receiptId: `history-receipt-${String(index).padStart(3, "0")}`
      };
      await writeFile(path.join(recordsDirectory, `${copy.id}.json`), JSON.stringify(copy), "utf8");
    }));

    await expect(findAuditByCallId(workspace, input.callId)).resolves.toEqual(expect.objectContaining({ id: record.id, stage: "committed" }));
    await expect(listPendingAuditOutbox(workspace)).resolves.toEqual([]);
    await expect(listAuditOutbox(workspace)).rejects.toMatchObject({ code: "AUDIT_OUTBOX_BATCH_LIMIT" });
  });

  it("fails closed at the pending hard limit and cleans only a verified stale committed marker", async () => {
    const { workspace } = await setup();
    const record = await createAuditOutbox(workspace, input);
    await updateAuditOutbox(workspace, record.id, { stage: "committed", attempts: 1 });
    const pendingDirectory = path.join(workspace.directory, "audit-outbox", "pending");
    await Promise.all(Array.from({ length: MAX_AUDIT_OUTBOX_PENDING }, async (_, index) => {
      const id = `audit-pending-${String(index).padStart(3, "0")}`;
      await writeFile(path.join(pendingDirectory, `${id}.json`), JSON.stringify({ version: 1, recordId: id }), "utf8");
    }));
    await expect(createAuditOutbox(workspace, { ...input, callId: "capacity-call", receiptId: "capacity-receipt" })).rejects.toMatchObject({ code: "AUDIT_OUTBOX_PENDING_LIMIT" });

    await rm(pendingDirectory, { recursive: true, force: true });
    await writeFile(path.join(pendingDirectory, `${record.id}.json`), JSON.stringify({ version: 1, recordId: record.id }), "utf8").catch(async () => {
      await (await import("node:fs/promises")).mkdir(pendingDirectory, { recursive: true });
      await writeFile(path.join(pendingDirectory, `${record.id}.json`), JSON.stringify({ version: 1, recordId: record.id }), "utf8");
    });
    await expect(listPendingAuditOutbox(workspace)).resolves.toEqual([]);
    await expect(readdir(pendingDirectory)).resolves.toEqual([]);
  });
});
