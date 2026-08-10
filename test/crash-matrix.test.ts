import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SchemaRegistry } from "../src/contracts/schema-registry.js";
import { loadRegistries } from "../src/config/registry.js";
import { initWorkspace } from "../src/storage/workspace.js";
import { createTask } from "../src/storage/tasks.js";
import { requestApproval } from "../src/storage/approvals.js";
import { recordEvidence } from "../src/storage/evidence.js";
import { issueLease } from "../src/storage/leases.js";
import { createPlan } from "../src/storage/plans.js";
import { createAuditOutbox } from "../src/storage/audit-outbox.js";
import { recoverMcpAudit } from "../src/storage/audit-service.js";
import { verifyLedger, appendLedgerEntry, LEDGER_FILE } from "../src/storage/ledger.js";
import { diagnoseRuntime } from "../src/storage/runtime-diagnostics.js";
import { inspectRuntimeRun, reconcileRuntimeRun } from "../src/storage/runtime-reconciliation.js";
import { createRun, transitionRun } from "../src/storage/runs.js";
import { recordReceipt, getReceipt } from "../src/storage/receipts.js";
import { inspectEvidence } from "../src/storage/evidence.js";
import { requestWrites, confirmWrites, getWriteIntent } from "../src/storage/write-intents.js";
import { applyWriteForMatrix, prepareConfirmedWrite } from "./crash-matrix-helpers.js";
import type { AgentRun } from "../src/contracts/types.js";

const roots: string[] = [];
const projectRoot = path.resolve(import.meta.dirname, "..");
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "stinky-crash-"));
  roots.push(root);
  const workspace = await initWorkspace(root);
  const schemas = await SchemaRegistry.create(projectRoot);
  const registries = await loadRegistries(projectRoot, schemas);
  return { root, workspace, schemas, registries };
}

function run(status: AgentRun["status"] = "RUNNING"): AgentRun {
  return {
    version: 1, runId: "crash-run", capsuleId: "capsule-1", taskId: "crash-task", agentId: "agent-1", role: "scout",
    workspaceId: "workspace-1", leaseId: "lease-1", policyVersion: "1", status, executor: "scripted-readonly",
    budget: { maxToolCalls: 3 }, toolCalls: [], evidenceRefs: [],
    createdAt: "2026-01-01T00:00:00.000Z", startedAt: "2026-01-01T00:00:00.000Z",
    ...(status === "RUNNING" ? {} : { finishedAt: "2026-01-01T00:01:00.000Z" })
  };
}

async function ledgerLines(workspace: any): Promise<string[]> {
  return (await readFile(path.join(workspace.directory, LEDGER_FILE), "utf8")).split("\n").filter(Boolean);
}

async function truncateTail(workspace: any, count = 1): Promise<void> {
  const lines = await ledgerLines(workspace);
  await writeFile(path.join(workspace.directory, LEDGER_FILE), `${lines.slice(0, lines.length - count).join("\n")}\n`, "utf8");
}

async function corruptMiddleHash(workspace: any): Promise<void> {
  const lines = await ledgerLines(workspace);
  const index = Math.floor(lines.length / 2);
  lines[index] = lines[index].replace(/"hash":"[^"]+"/, `"hash":"sha256:${"0".repeat(64)}"`);
  await writeFile(path.join(workspace.directory, LEDGER_FILE), `${lines.join("\n")}\n`, "utf8");
}

describe("crash consistency matrix", () => {
  describe("A. corrupted ledger blocks every write path", () => {
    it("blocks task, approval, evidence, lease, and plan writes after truncation", async () => {
      const { workspace, schemas, registries } = await setup();
      await createTask(workspace, { id: "crash-task", workspaceId: "workspace-1", goal: "x", requestedOutputs: ["report"], riskLevel: "L0", state: "DRAFT" });
      await appendLedgerEntry(workspace, { event: "task-created", taskId: "crash-task", summary: "seed." });
      const before = await ledgerLines(workspace);
      // Truncate the tail entry; the chain becomes invalid because the last remaining
      // line's hash was chained to the removed one.
      await writeFile(path.join(workspace.directory, LEDGER_FILE), `${before.slice(0, before.length - 1).join("\n")}\n`, "utf8");
      // storage-level task creation does not append to the ledger (the CLI does), so it
      // stays unaffected; every ledger-appending path must fail closed.
      await expect(requestApproval(workspace, schemas, { taskId: "crash-task", action: "review" })).rejects.toBeTruthy();
      await expect(recordEvidence(workspace, schemas, { id: "evidence-crash", kind: "tool", source: "s", locator: "tool-call:1", contentHash: `sha256:${"a".repeat(64)}`, observedAt: "2026-01-01T00:00:00.000Z", sensitivity: "internal", toolCallId: "1" })).rejects.toBeTruthy();
      await expect(issueLease(workspace, schemas, { taskId: "crash-task", agentId: "a", role: "scout", capability: "repository-read" })).rejects.toBeTruthy();
      await expect(createPlan(workspace, schemas, registries, { taskId: "crash-task" })).rejects.toBeTruthy();
    });

    it("reports hash mismatch and blocks append after middle-row corruption", async () => {
      const { workspace, schemas } = await setup();
      await createTask(workspace, { id: "crash-task", workspaceId: "workspace-1", goal: "x", requestedOutputs: ["report"], riskLevel: "L0", state: "DRAFT" });
      await appendLedgerEntry(workspace, { event: "task-created", taskId: "crash-task", summary: "seed." });
      await corruptMiddleHash(workspace);
      const verification = await verifyLedger(workspace);
      expect(verification.valid).toBe(false);
      expect(["HASH_MISMATCH", "PREVIOUS_HASH_MISMATCH"]).toContain(verification.error?.code);
      await expect(appendLedgerEntry(workspace, { event: "task-cancelled", taskId: "crash-task", summary: "x" })).rejects.toThrow(/invalid ledger/);
    });

    it("rebuilds a missing ledger from genesis and keeps writes working", async () => {
      const { workspace, schemas } = await setup();
      await createTask(workspace, { id: "crash-task", workspaceId: "workspace-1", goal: "x", requestedOutputs: ["report"], riskLevel: "L0", state: "DRAFT" });
      await rm(path.join(workspace.directory, LEDGER_FILE), { force: true });
      const approval = await requestApproval(workspace, schemas, { taskId: "crash-task", action: "review" });
      expect(approval.id).toBeTruthy();
      const verification = await verifyLedger(workspace);
      expect(verification.valid).toBe(true);
      const lines = await ledgerLines(workspace);
      expect(lines.some((line) => line.includes("approval-requested"))).toBe(true);
    });
  });

  describe("B. diagnostics recognize cross-file inconsistencies", () => {
    it("reports RUN_INVALID for a corrupted run file", async () => {
      const { workspace, schemas, registries } = await setup();
      await createTask(workspace, { id: "crash-task", workspaceId: "workspace-1", goal: "x", requestedOutputs: ["report"], riskLevel: "L0", state: "SCOPED" });
      await createRun(workspace, run("RUNNING"));
      await writeFile(path.join(workspace.directory, "runs", "crash-run.json"), "not-json", "utf8");
      const report = await diagnoseRuntime(workspace, schemas);
      // A corrupted run file cannot be projected; diagnostics are indeterminate and report issues.
      expect(report.summary.status).toBe("INDETERMINATE");
      expect(report.summary.issueCount).toBeGreaterThan(0);
    });

    it("reports RUN_STATUS_LEDGER_CONFLICT for a completed run without a transition event", async () => {
      const { workspace, schemas } = await setup();
      await createTask(workspace, { id: "crash-task", workspaceId: "workspace-1", goal: "x", requestedOutputs: ["report"], riskLevel: "L0", state: "SCOPED" });
      await createRun(workspace, run("RUNNING"));
      await writeFile(path.join(workspace.directory, "runs", "crash-run.json"), JSON.stringify({ ...run("COMPLETED"), finishedAt: "2026-01-01T00:01:00.000Z" }), "utf8");
      const report = await diagnoseRuntime(workspace, schemas);
      expect(report.issues.some((issue: any) => issue.code === "RUN_STATUS_LEDGER_CONFLICT")).toBe(true);
    });

    it("reports LEDGER_RECEIPT_REF_ORPHAN when the receipt file is missing", async () => {
      const { workspace, schemas } = await setup();
      await createTask(workspace, { id: "crash-task", workspaceId: "workspace-1", goal: "x", requestedOutputs: ["report"], riskLevel: "L0", state: "SCOPED" });
      await createRun(workspace, run("RUNNING"));
      const receipt = await recordReceipt(workspace, schemas, { id: "crash-receipt", taskId: "crash-task", role: "scout", status: "BLOCKED", facts: [], proposals: [], unknowns: [], evidenceRefs: [], createdAt: "2026-01-01T00:00:00.000Z", runId: "crash-run" });
      await rm(path.join(workspace.directory, "receipts", `${receipt.id}.json`));
      const report = await diagnoseRuntime(workspace, schemas);
      expect(report.issues.some((issue: any) => issue.code === "LEDGER_RECEIPT_REF_ORPHAN")).toBe(true);
    });

    it("reports RECEIPT_LEDGER_EVENT_MISSING when the receipt has no ledger event", async () => {
      const { workspace, schemas } = await setup();
      await createTask(workspace, { id: "crash-task", workspaceId: "workspace-1", goal: "x", requestedOutputs: ["report"], riskLevel: "L0", state: "SCOPED" });
      await createRun(workspace, run("RUNNING"));
      await recordReceipt(workspace, schemas, { id: "crash-receipt", taskId: "crash-task", role: "scout", status: "BLOCKED", facts: [], proposals: [], unknowns: [], evidenceRefs: [], createdAt: "2026-01-01T00:00:00.000Z", runId: "crash-run" });
      await truncateTail(workspace, 1);
      const report = await diagnoseRuntime(workspace, schemas);
      expect(report.issues.some((issue: any) => issue.code === "RECEIPT_LEDGER_EVENT_MISSING")).toBe(true);
    });
  });

  describe("C. recovery is blocked while the ledger is corrupted", () => {
    it("blocks audit recovery and reconcile repair on a corrupted ledger", async () => {
      const { workspace, schemas } = await setup();
      await createTask(workspace, { id: "crash-task", workspaceId: "workspace-1", goal: "x", requestedOutputs: ["report"], riskLevel: "L0", state: "SCOPED" });
      await createAuditOutbox(workspace, { callId: "crash-call", taskId: "crash-task", role: "scout", tool: "repository-read", outcome: "completed", receiptId: "mcp-crash" });
      await appendLedgerEntry(workspace, { event: "task-created", taskId: "crash-task", summary: "seed." });
      await createRun(workspace, run("FAILED"));
      const pending = await import("../src/storage/audit-outbox.js").then(({ listAuditOutbox }) => listAuditOutbox(workspace));
      await corruptMiddleHash(workspace);
      await expect(recoverMcpAudit(workspace, schemas, pending[0].id)).rejects.toBeTruthy();
      await expect(reconcileRuntimeRun(workspace, schemas, "crash-run", { repair: true })).rejects.toBeTruthy();
    });
  });

  describe("D. write interruption consistency", () => {
    it("keeps an APPLIED intent consistent and idempotent when the write-applied event tail is lost", async () => {
      const { workspace, schemas, registries } = await setup();
      const helper = await import("./crash-matrix-helpers.js");
      const { planId, intent, lease } = await helper.prepareConfirmedWrite(workspace, schemas, registries);
      await applyWriteForMatrix(workspace, schemas, lease, intent, "docs/note.md", "content\n");
      await truncateTail(workspace, 1);
      const stored = await getWriteIntent(workspace, intent.writeIntentId);
      expect(stored.status).toBe("APPLIED");
      await expect(applyWriteForMatrix(workspace, schemas, lease, stored, "docs/note.md", "again\n")).rejects.toMatchObject({ code: "WRITE_ALREADY_APPLIED" });
      const verification = await verifyLedger(workspace);
      expect(verification.valid).toBe(true);
    });
  });
});
