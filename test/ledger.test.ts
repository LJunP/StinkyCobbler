import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultSchemaRegistry } from "../src/contracts/default-schema-registry.js";
import {
  appendLedgerEntry,
  listLedgerEntries,
  verifyLedger
} from "../src/storage/ledger.js";
import { initWorkspace, workspaceFile } from "../src/storage/workspace.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "stinky-ledger-schema-"));
  roots.push(root);
  return initWorkspace(root);
}

function hashEntry(entry: Record<string, unknown>): string {
  const canonical = JSON.stringify(Object.fromEntries(Object.entries(entry).sort(([left], [right]) => left.localeCompare(right))));
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

async function replaceEntry(workspace: Awaited<ReturnType<typeof setup>>, mutate: (entry: Record<string, unknown>) => void): Promise<Record<string, unknown>> {
  const ledgerPath = await workspaceFile(workspace, "ledger.jsonl");
  const entry = JSON.parse((await readFile(ledgerPath, "utf8")).trim()) as Record<string, unknown>;
  mutate(entry);
  delete entry.hash;
  entry.hash = hashEntry(entry);
  await writeFile(ledgerPath, `${JSON.stringify(entry)}\n`, "utf8");
  return entry;
}

describe("canonical audit ledger schema", () => {
  it("covers current orchestration events and every LedgerEntry optional field", async () => {
    const entry = {
      sequence: 1,
      id: "123e4567-e89b-42d3-a456-426614174000",
      at: "2026-08-24T00:00:00.000Z",
      event: "orchestration-completed",
      summary: "Orchestration completed.",
      prevHash: "sha256:genesis",
      hash: `sha256:${"a".repeat(64)}`,
      taskId: "task-1",
      role: "worker",
      policyVersion: "1",
      tool: "repository-read",
      capability: "repository-read",
      authorityHash: `sha256:${"b".repeat(64)}`,
      reservationId: "reservation-1",
      reservationOrdinal: 1,
      receiptRef: "receipt-1",
      approvalRef: "approval-1",
      evidenceRef: "evidence-1",
      runId: "run-1",
      fromStatus: "RUNNING",
      toStatus: "COMPLETED",
      leaseRef: "lease-1",
      planRef: "plan-1",
      stepId: "step-1",
      writeIntentRef: "write-1",
      contractRef: "contract-1",
      runRef: "orchestration-run-1",
      subtaskRef: "subtask-1",
      artifactRef: "artifact-1",
      reviewRef: "review-1",
      round: 2,
      attempt: 1
    };

    await expect((async () => (await defaultSchemaRegistry()).validate("audit", entry))()).resolves.toBeUndefined();
  });

  it("appends a current orchestration event with a numeric round", async () => {
    const workspace = await setup();
    const entry = await appendLedgerEntry(workspace, {
      event: "round-completed",
      summary: "Round completed.",
      taskId: "task-1",
      contractRef: "contract-1",
      runRef: "run-1",
      round: 2
    });

    expect(entry).toMatchObject({ event: "round-completed", round: 2 });
    await expect(verifyLedger(workspace)).resolves.toMatchObject({ valid: true, entries: 1 });
  });

  it("rejects oversized or control-bearing optional audit fields before append", async () => {
    const workspace = await setup();
    await expect(appendLedgerEntry(workspace, {
      event: "task-created",
      summary: "Bound optional fields.",
      taskId: "x".repeat(257)
    })).rejects.toMatchObject({ code: "LEDGER_INVALID" });
    await expect(appendLedgerEntry(workspace, {
      event: "task-created",
      summary: "Bound optional fields.",
      taskId: "task-1\nforged"
    })).rejects.toMatchObject({ code: "LEDGER_INVALID" });
  });

  it("fails closed when a main-ledger entry violates the canonical audit schema", async () => {
    const workspace = await setup();
    await appendLedgerEntry(workspace, { event: "run-created", summary: "Run created.", runId: "run-1" });
    await replaceEntry(workspace, (entry) => { entry.runId = ""; });

    await expect(verifyLedger(workspace)).resolves.toMatchObject({ valid: false, error: { index: 0, code: "INVALID_ENTRY" } });
    await expect(listLedgerEntries(workspace)).rejects.toMatchObject({ code: "LEDGER_INVALID" });
    await expect(appendLedgerEntry(workspace, { event: "test-run", summary: "Must not append." })).rejects.toMatchObject({ code: "LEDGER_INVALID" });
  });

  it("fails closed when an archived entry violates the canonical audit schema", async () => {
    const workspace = await setup();
    await appendLedgerEntry(workspace, { event: "run-created", summary: "Run created.", runId: "run-1" });
    const invalidEntry = await replaceEntry(workspace, (entry) => { entry.runId = ""; });
    const archiveDirectory = await workspaceFile(workspace, "ledger-archives");
    await mkdir(archiveDirectory, { recursive: true });
    await writeFile(path.join(archiveDirectory, "ledger-archive-2026-08-24T00-00-00-000Z.jsonl"), `${JSON.stringify(invalidEntry)}\n`, "utf8");
    await writeFile(await workspaceFile(workspace, "ledger.jsonl"), "", "utf8");

    await expect(verifyLedger(workspace)).resolves.toMatchObject({ valid: false, error: { index: 0, code: "INVALID_ENTRY" } });
    await expect(listLedgerEntries(workspace)).rejects.toMatchObject({ code: "LEDGER_INVALID" });
    await expect(appendLedgerEntry(workspace, { event: "test-run", summary: "Must not append." })).rejects.toMatchObject({ code: "LEDGER_INVALID" });
  });
});
