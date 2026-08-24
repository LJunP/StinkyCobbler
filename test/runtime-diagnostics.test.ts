import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentRun } from "../src/contracts/types.js";
import { SchemaRegistry } from "../src/contracts/schema-registry.js";
import { initWorkspace } from "../src/storage/workspace.js";
import { createRun, transitionRun } from "../src/storage/runs.js";
import { createTask } from "../src/storage/tasks.js";
import { recordRuntimeReceipt, runtimeReceiptId } from "../src/storage/runtime-finalization.js";
import { appendLedgerEntry } from "../src/storage/ledger.js";
import { diagnoseRuntime } from "../src/storage/runtime-diagnostics.js";

const roots: string[] = [];
const projectRoot = path.resolve(import.meta.dirname, "..");
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "stinky-diagnostics-"));
  roots.push(root);
  const workspace = await initWorkspace(root);
  const schemas = await SchemaRegistry.create(projectRoot);
  await createTask(workspace, { id: "task", workspaceId: "ws", goal: "diagnose", requestedOutputs: ["report"], riskLevel: "L0", state: "SCOPED" });
  const run: AgentRun = {
    version: 1,
    runId: "run",
    capsuleId: "capsule",
    taskId: "task",
    agentId: "agent",
    role: "scout",
    workspaceId: "ws",
    leaseId: "lease",
    policyVersion: "1",
    executionRequestHash: `sha256:${"a".repeat(64)}`,
    status: "RUNNING",
    executor: "scripted-readonly",
    ownerToken: "x".repeat(64),
    fenceEpoch: 0,
    budget: { maxToolCalls: 1 },
    createdAt: "2026-01-01T00:00:00.000Z",
    startedAt: "2026-01-01T00:00:00.000Z",
    toolCalls: [],
    evidenceRefs: []
  };
  await createRun(workspace, run);
  const completed = await transitionRun(workspace, run.runId, "COMPLETED", { finishedAt: "2026-01-01T00:01:00.000Z" });
  await recordRuntimeReceipt(workspace, schemas, {
    id: runtimeReceiptId("run"),
    taskId: "task",
    role: "scout",
    status: "COMPLETED",
    facts: [],
    proposals: [],
    unknowns: [],
    evidenceRefs: [],
    changedPaths: [],
    policyVersion: "1",
    executionRequestHash: completed.executionRequestHash,
    toolSummary: "diagnostic test",
    runId: "run",
    capsuleId: "capsule",
    leaseId: "lease",
    agentId: "agent",
    executor: "scripted-readonly",
    startedAt: completed.startedAt,
    finishedAt: completed.finishedAt,
    toolCalls: completed.toolCalls,
    createdAt: completed.finishedAt
  });
  return { root, workspace, schemas };
}

describe("runtime diagnostics", () => {
  it("reports a read-only consistent projection without exposing owner tokens", async () => {
    const value = await setup();
    const report = await diagnoseRuntime(value.workspace, value.schemas);
    expect(report).toMatchObject({ readOnly: true, scope: "workspace", boundaries: { repairPerformed: false, historyInferred: false, authorization: false, sourceContentVerified: false }, summary: { status: "CONSISTENT" } });
    expect(report.runs[0]).toMatchObject({ runId: "run", hasOwnerToken: true });
    expect(JSON.stringify(report)).not.toContain("x".repeat(64));
    await expect(readdir(path.join(value.workspace.directory, "workspace.lock"))).rejects.toBeTruthy();
  });

  it("reports missing lifecycle and receipt ledger links without changing files", async () => {
    const value = await setup();
    await rm(path.join(value.workspace.directory, "ledger.jsonl"));
    await writeFile(path.join(value.workspace.directory, "ledger.jsonl"), "", "utf8");
    const before = await readFile(path.join(value.workspace.directory, "runs", "run.json"), "utf8");
    const report = await diagnoseRuntime(value.workspace, value.schemas, "run");
    expect(report.scope).toBe("run");
    expect(report.summary.status).toBe("ISSUES_FOUND");
    expect(report.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining(["RUN_CREATED_EVENT_MISSING", "RECEIPT_LEDGER_EVENT_MISSING"]));
    expect(await readFile(path.join(value.workspace.directory, "runs", "run.json"), "utf8")).toBe(before);
  });

  it("reports orphan lifecycle events and invalid ledger state as indeterminate", async () => {
    const value = await setup();
    await appendLedgerEntry(value.workspace, { event: "run-created", runId: "missing-run", toStatus: "RUNNING", summary: "orphan diagnostic event" });
    const healthy = await diagnoseRuntime(value.workspace, value.schemas);
    expect(healthy.issues.map((issue) => issue.code)).toContain("RUN_LIFECYCLE_EVENT_ORPHAN");
    await writeFile(path.join(value.workspace.directory, "ledger.jsonl"), "not-json\n", "utf8");
    const invalid = await diagnoseRuntime(value.workspace, value.schemas);
    expect(invalid.summary.status).toBe("INDETERMINATE");
    expect(invalid.issues.map((issue) => issue.category)).toContain("INTEGRITY");
  });
});
