import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentRun, TaskCharter } from "../src/contracts/types.js";
import { SchemaRegistry } from "../src/contracts/schema-registry.js";
import { initWorkspace } from "../src/storage/workspace.js";
import { createTask } from "../src/storage/tasks.js";
import { createRun, listRuns } from "../src/storage/runs.js";
import { recordReceipt } from "../src/storage/receipts.js";
import { listLedgerEntries } from "../src/storage/ledger.js";
import { inspectRuntimeRun, reconcileRuntimeRun } from "../src/storage/runtime-reconciliation.js";

const roots: string[] = [];
const projectRoot = path.resolve(import.meta.dirname, "..");
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function setup(status: AgentRun["status"] = "FAILED") {
  const root = await mkdtemp(path.join(os.tmpdir(), "stinky-reconcile-"));
  roots.push(root);
  const workspace = await initWorkspace(root);
  const schemas = await SchemaRegistry.create(projectRoot);
  const task: TaskCharter = { id: "task-1", workspaceId: "workspace-1", goal: "read", requestedOutputs: ["report"], riskLevel: "L0", state: "SCOPED" };
  await createTask(workspace, task);
  const run: AgentRun = {
    version: 1, runId: "run-1", capsuleId: "capsule-1", taskId: task.id, agentId: "agent-1", role: "scout", workspaceId: task.workspaceId, leaseId: "lease-1", policyVersion: "1", status, executor: "scripted-readonly", budget: { maxToolCalls: 2 }, budgetUsage: { toolCalls: 1 }, toolCalls: [], evidenceRefs: [], createdAt: "2026-01-01T00:00:00.000Z", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:01:00.000Z", ...(status === "COMPLETED" ? {} : { errorCode: "RUNTIME_FAILED", blockedReason: "failed" })
  };
  await createRun(workspace, run);
  return { workspace, schemas, run, task };
}

function receipt(run: AgentRun, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: "receipt-1", taskId: run.taskId, role: run.role, status: run.status === "COMPLETED" ? "COMPLETED" : run.status === "FAILED" ? "FAILED" : "BLOCKED", facts: [], proposals: [], unknowns: [], evidenceRefs: run.evidenceRefs ?? [], changedPaths: [], createdAt: run.finishedAt, runId: run.runId, capsuleId: run.capsuleId, leaseId: run.leaseId, agentId: run.agentId, executor: run.executor, ...overrides };
}

describe("runtime Run/Receipt reconciliation", () => {
  it("lists validated runs and filters by task/status", async () => {
    const value = await setup();
    expect(await listRuns(value.workspace)).toHaveLength(1);
    expect(await listRuns(value.workspace, { taskId: "task-1", status: "FAILED" })).toHaveLength(1);
    expect(await listRuns(value.workspace, { status: "COMPLETED" })).toEqual([]);
  });

  it("reports a terminal run without receipt and repairs non-success runs explicitly", async () => {
    const value = await setup("FAILED");
    const before = await inspectRuntimeRun(value.workspace, value.schemas, value.run.runId);
    expect(before.issues.map((issue) => issue.code)).toContain("TERMINAL_RUN_MISSING_RECEIPT");
    expect(before.repairable).toBe(true);
    const after = await reconcileRuntimeRun(value.workspace, value.schemas, value.run.runId, { repair: true });
    expect(after.repaired).toBe(true);
    expect(after.receipts).toHaveLength(1);
    expect(after.receipts[0]).toMatchObject({ status: "FAILED", runId: value.run.runId, facts: [] });
    const lifecycleEntries = (await listLedgerEntries(value.workspace)).filter((entry) => entry.runId === value.run.runId);
    expect(lifecycleEntries.map((entry) => entry.event)).toEqual(["run-created"]);
    await expect(reconcileRuntimeRun(value.workspace, value.schemas, value.run.runId, { repair: true })).resolves.toMatchObject({ repaired: false, receipts: [expect.objectContaining({ id: after.receipts[0].id })] });
  });

  it("does not fabricate a success receipt for a completed run", async () => {
    const value = await setup("COMPLETED");
    const result = await reconcileRuntimeRun(value.workspace, value.schemas, value.run.runId, { repair: true });
    expect(result.repairable).toBe(false);
    expect(result.repaired).toBe(false);
    expect(result.receipts).toEqual([]);
  });

  it("detects binding, status, evidence, hash, multiple, and nonterminal mismatches", async () => {
    const value = await setup("FAILED");
    await recordReceipt(value.workspace, value.schemas, receipt(value.run, { role: "wrong", status: "COMPLETED", evidenceRefs: ["evidence-x"], outputHash: "sha256:wrong" }));
    const report = await inspectRuntimeRun(value.workspace, value.schemas, value.run.runId);
    expect(report.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining(["RECEIPT_RUN_BINDING_MISMATCH", "RECEIPT_STATUS_MISMATCH", "RECEIPT_EVIDENCE_MISMATCH"]));
    const nonterminal = await setup("RUNNING");
    await recordReceipt(nonterminal.workspace, nonterminal.schemas, receipt({ ...nonterminal.run, status: "FAILED" }, { id: "receipt-2" }));
    expect((await inspectRuntimeRun(nonterminal.workspace, nonterminal.schemas, nonterminal.run.runId)).issues.map((issue) => issue.code)).toContain("NONTERMINAL_RUN_WITH_RECEIPT");
  });
});
