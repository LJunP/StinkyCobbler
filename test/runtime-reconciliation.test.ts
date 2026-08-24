import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentRun, TaskCharter } from "../src/contracts/types.js";
import { SchemaRegistry } from "../src/contracts/schema-registry.js";
import { initWorkspace } from "../src/storage/workspace.js";
import { createTask } from "../src/storage/tasks.js";
import { createRun, injectRunLifecycleFaultForTesting, listRuns, transitionRun } from "../src/storage/runs.js";
import { listLedgerEntries } from "../src/storage/ledger.js";
import { inspectRuntimeRun, reconcileRuntimeRun } from "../src/storage/runtime-reconciliation.js";
import {
  getRuntimeFinalization,
  injectRuntimeFinalizationFaultOnceForTest,
  runtimeFinalizationId,
  runtimeReceiptId
} from "../src/storage/runtime-finalization.js";

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
    version: 1, runId: "run-1", capsuleId: "capsule-1", taskId: task.id, agentId: "agent-1", role: "scout", workspaceId: task.workspaceId, leaseId: "lease-1", policyVersion: "1", executionRequestHash: `sha256:${"a".repeat(64)}`, status, executor: "scripted-readonly", budget: { maxToolCalls: 2 }, budgetUsage: { toolCalls: 1 }, toolCalls: [], evidenceRefs: [], createdAt: "2026-01-01T00:00:00.000Z", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:01:00.000Z", ...(status === "COMPLETED" ? {} : { errorCode: "RUNTIME_FAILED", blockedReason: "failed" })
  };
  await createRun(workspace, run);
  return { workspace, schemas, run, task };
}

function receipt(run: AgentRun, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: "receipt-1", taskId: run.taskId, role: run.role, status: run.status === "COMPLETED" ? "COMPLETED" : run.status === "FAILED" ? "FAILED" : "BLOCKED", facts: [], proposals: [], unknowns: [], evidenceRefs: run.evidenceRefs ?? [], changedPaths: [], createdAt: run.finishedAt, runId: run.runId, capsuleId: run.capsuleId, leaseId: run.leaseId, agentId: run.agentId, executor: run.executor, executionRequestHash: run.executionRequestHash, ...overrides };
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
    expect(lifecycleEntries.map((entry) => entry.event)).toEqual(["run-created", "receipt-recorded"]);
    await expect(reconcileRuntimeRun(value.workspace, value.schemas, value.run.runId, { repair: true })).resolves.toMatchObject({ repaired: false, receipts: [expect.objectContaining({ id: after.receipts[0].id })] });
  });

  it("recovers a completed Run without inventing the lost narrative", async () => {
    const value = await setup("COMPLETED");
    const result = await reconcileRuntimeRun(value.workspace, value.schemas, value.run.runId, { repair: true });
    expect(result.repaired).toBe(true);
    expect(result.receipts).toHaveLength(1);
    expect(result.receipts[0]).toMatchObject({
      status: "COMPLETED",
      facts: [{ statement: "Receipt reconstructed from the authoritative terminal Run after interrupted finalization." }],
      unknowns: ["The original in-memory Receipt narrative was unavailable; only persisted Run metadata was recovered."]
    });
  });

  it("does not synthesize a Receipt for a legacy terminal Run without an execution request hash", async () => {
    const value = await setup("COMPLETED");
    const { executionRequestHash: _legacyMissing, ...legacy } = value.run;
    await writeFile(path.join(value.workspace.directory, "runs", `${value.run.runId}.json`), JSON.stringify(legacy), "utf8");

    await expect(reconcileRuntimeRun(value.workspace, value.schemas, value.run.runId, { repair: true }))
      .rejects.toMatchObject({ code: "RUNTIME_RUN_REISSUE_REQUIRED" });
  });

  it("replays the exact prepared Receipt after a receipt-before-ledger crash", async () => {
    const value = await setup("COMPLETED");
    injectRuntimeFinalizationFaultOnceForTest(value.workspace, "after-receipt");
    await expect(reconcileRuntimeRun(value.workspace, value.schemas, value.run.runId, { repair: true }))
      .rejects.toMatchObject({ code: "RUNTIME_FINALIZATION_FAULT_INJECTED", details: { point: "after-receipt" } });
    await expect(getRuntimeFinalization(value.workspace, value.run.runId)).resolves.toMatchObject({ status: "PREPARED" });
    expect((await listLedgerEntries(value.workspace)).filter((entry) => entry.event === "receipt-recorded")).toHaveLength(0);

    const recovered = await reconcileRuntimeRun(value.workspace, value.schemas, value.run.runId, { repair: true });
    expect(recovered).toMatchObject({ repaired: true, issues: [] });
    await expect(getRuntimeFinalization(value.workspace, value.run.runId)).resolves.toMatchObject({ status: "COMMITTED" });
    expect((await listLedgerEntries(value.workspace)).filter((entry) => entry.event === "receipt-recorded")).toHaveLength(1);
  });

  it("reports and repairs a PREPARED finalization that has not written its Receipt", async () => {
    const value = await setup("FAILED");
    injectRuntimeFinalizationFaultOnceForTest(value.workspace, "after-prepare");
    await expect(reconcileRuntimeRun(value.workspace, value.schemas, value.run.runId, { repair: true }))
      .rejects.toMatchObject({ code: "RUNTIME_FINALIZATION_FAULT_INJECTED", details: { point: "after-prepare" } });

    const interrupted = await inspectRuntimeRun(value.workspace, value.schemas, value.run.runId);
    expect(interrupted.finalizationStatus).toBe("PREPARED");
    expect(interrupted.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "TERMINAL_RUN_MISSING_RECEIPT",
      "RUNTIME_FINALIZATION_PREPARED"
    ]));
    expect(interrupted.repairable).toBe(true);

    await expect(reconcileRuntimeRun(value.workspace, value.schemas, value.run.runId, { repair: true }))
      .resolves.toMatchObject({ repaired: true, issues: [], finalizationStatus: "COMMITTED" });
  });

  it("does not silently bless a legacy Receipt whose committed finalization journal is missing", async () => {
    const value = await setup("FAILED");
    const committed = await reconcileRuntimeRun(value.workspace, value.schemas, value.run.runId, { repair: true });
    expect(committed.issues).toEqual([]);
    await rm(path.join(
      value.workspace.directory,
      "runtime-finalizations",
      `${runtimeFinalizationId(value.run.runId)}.json`
    ));

    const report = await inspectRuntimeRun(value.workspace, value.schemas, value.run.runId);
    expect(report.issues.map((issue) => issue.code)).toContain("RUNTIME_FINALIZATION_MISSING");
    expect(report.repairable).toBe(false);
    await expect(reconcileRuntimeRun(value.workspace, value.schemas, value.run.runId, { repair: true }))
      .resolves.toMatchObject({ repaired: false, repairable: false });
    await expect(getRuntimeFinalization(value.workspace, value.run.runId))
      .rejects.toMatchObject({ code: "RUNTIME_FINALIZATION_NOT_FOUND" });
  });

  it("reports a committed finalization whose immutable Receipt target disappeared", async () => {
    const value = await setup("FAILED");
    await reconcileRuntimeRun(value.workspace, value.schemas, value.run.runId, { repair: true });
    await rm(path.join(value.workspace.directory, "receipts", `${runtimeReceiptId(value.run.runId)}.json`));

    const report = await inspectRuntimeRun(value.workspace, value.schemas, value.run.runId);
    expect(report.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "TERMINAL_RUN_MISSING_RECEIPT",
      "RUNTIME_FINALIZATION_MISMATCH"
    ]));
    expect(report.repairable).toBe(false);
  });

  it("repairs the terminal Run lifecycle before committing Runtime finalization", async () => {
    const value = await setup("RUNNING");
    injectRunLifecycleFaultForTesting(value.workspace, "after-run");
    await expect(transitionRun(value.workspace, value.run.runId, "COMPLETED", {
      finishedAt: "2026-01-01T00:02:00.000Z",
      outputHash: `sha256:${"a".repeat(64)}`
    })).rejects.toMatchObject({ code: "RUNTIME_RUN_LIFECYCLE_FAULT_INJECTED", details: { point: "after-run" } });
    expect((await listLedgerEntries(value.workspace)).filter((entry) => entry.event === "run-transitioned")).toHaveLength(0);

    const recovered = await reconcileRuntimeRun(value.workspace, value.schemas, value.run.runId, { repair: true });
    expect(recovered).toMatchObject({ repaired: true, issues: [] });
    const transitions = (await listLedgerEntries(value.workspace)).filter((entry) => entry.event === "run-transitioned");
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({ fromStatus: "RUNNING", toStatus: "COMPLETED" });
    await expect(getRuntimeFinalization(value.workspace, value.run.runId)).resolves.toMatchObject({ status: "COMMITTED" });
  });

  it("detects binding, status, evidence, hash, multiple, and nonterminal mismatches", async () => {
    const value = await setup("FAILED");
    await mkdir(path.join(value.workspace.directory, "receipts"), { recursive: true });
    await writeFile(path.join(value.workspace.directory, "receipts", "receipt-1.json"), JSON.stringify(receipt(value.run, { role: "wrong", status: "COMPLETED", evidenceRefs: ["evidence-x"], outputHash: "sha256:wrong" })), "utf8");
    const report = await inspectRuntimeRun(value.workspace, value.schemas, value.run.runId);
    expect(report.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining(["RECEIPT_RUN_BINDING_MISMATCH", "RECEIPT_STATUS_MISMATCH", "RECEIPT_EVIDENCE_MISMATCH"]));
    const nonterminal = await setup("RUNNING");
    await mkdir(path.join(nonterminal.workspace.directory, "receipts"), { recursive: true });
    await writeFile(path.join(nonterminal.workspace.directory, "receipts", "receipt-2.json"), JSON.stringify(receipt({ ...nonterminal.run, status: "FAILED" }, { id: "receipt-2" })), "utf8");
    expect((await inspectRuntimeRun(nonterminal.workspace, nonterminal.schemas, nonterminal.run.runId)).issues.map((issue) => issue.code)).toContain("NONTERMINAL_RUN_WITH_RECEIPT");
  });

  it("treats missing Runtime binding fields as mismatches", async () => {
    const value = await setup("FAILED");
    await mkdir(path.join(value.workspace.directory, "receipts"), { recursive: true });
    await writeFile(
      path.join(value.workspace.directory, "receipts", "receipt-1.json"),
      JSON.stringify(receipt(value.run, { executionRequestHash: undefined })),
      "utf8"
    );

    const report = await inspectRuntimeRun(value.workspace, value.schemas, value.run.runId);
    const binding = report.issues.find((issue) => issue.code === "RECEIPT_RUN_BINDING_MISMATCH");
    expect(binding?.details?.fields).toEqual(expect.arrayContaining([
      "policyVersion",
      "executionRequestHash",
      "startedAt",
      "finishedAt",
      "budgetUsage",
      "toolCalls"
    ]));
    expect(report.repairable).toBe(false);
  });

  it("detects two real Receipt files bound to one Runtime Run", async () => {
    const value = await setup("FAILED");
    await mkdir(path.join(value.workspace.directory, "receipts"), { recursive: true });
    const exactBindings = {
      policyVersion: value.run.policyVersion,
      executionRequestHash: value.run.executionRequestHash,
      startedAt: value.run.startedAt,
      finishedAt: value.run.finishedAt,
      budgetUsage: value.run.budgetUsage,
      toolCalls: value.run.toolCalls
    };
    await writeFile(
      path.join(value.workspace.directory, "receipts", "receipt-1.json"),
      JSON.stringify(receipt(value.run, exactBindings)),
      "utf8"
    );
    await writeFile(
      path.join(value.workspace.directory, "receipts", "receipt-2.json"),
      JSON.stringify(receipt(value.run, { ...exactBindings, id: "receipt-2" })),
      "utf8"
    );

    const report = await inspectRuntimeRun(value.workspace, value.schemas, value.run.runId);
    expect(report.issues.map((issue) => issue.code)).toContain("MULTIPLE_RECEIPTS_FOR_RUN");
    expect(report.receipts.map((candidate) => candidate.id).sort()).toEqual(["receipt-1", "receipt-2"]);
    expect(report.repairable).toBe(false);
  });
});
