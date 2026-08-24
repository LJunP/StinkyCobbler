import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentRun } from "../src/contracts/types.js";
import { checkpointRunProgress, createRun, getRun, injectRunLifecycleFaultForTesting, listRuns, saveRun, transitionRun } from "../src/storage/runs.js";
import { listLedgerEntries } from "../src/storage/ledger.js";
import { initWorkspace } from "../src/storage/workspace.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "stinky-run-lifecycle-"));
  roots.push(root);
  return initWorkspace(root);
}

function run(status: AgentRun["status"] = "RUNNING"): AgentRun {
  return {
    version: 1, runId: "run-1", capsuleId: "capsule-1", taskId: "task-1", agentId: "agent-1", role: "scout",
    workspaceId: "workspace-1", leaseId: "lease-1", policyVersion: "1", status, executor: "scripted-readonly",
    budget: { maxToolCalls: 3 }, budgetUsage: { toolCalls: 0 }, toolCalls: [], evidenceRefs: [],
    createdAt: "2026-01-01T00:00:00.000Z", startedAt: "2026-01-01T00:00:00.000Z",
    ...(status === "RUNNING" ? {} : { finishedAt: "2026-01-01T00:01:00.000Z", errorCode: status === "COMPLETED" ? undefined : "RUNTIME_FAILED", blockedReason: status === "COMPLETED" ? undefined : "not completed" })
  };
}

describe("Agent Run persistence lifecycle", () => {
  it("rejects malformed runs at the storage boundary", async () => {
    const workspace = await setup();
    await expect(createRun(workspace, { ...run(), runId: "../escape" } as AgentRun)).rejects.toMatchObject({ code: "RUNTIME_RUN_ID_INVALID" });
    await expect(createRun(workspace, { ...run(), status: "RUNNING", startedAt: undefined } as never)).rejects.toMatchObject({ code: "RUNTIME_RUN_INVALID" });
  });

  it("rejects schema-tampered and filename-mismatched persisted runs through get and list", async () => {
    const workspace = await setup();
    const stored = run();
    await createRun(workspace, stored);
    const target = path.join(workspace.directory, "runs", `${stored.runId}.json`);

    await writeFile(target, JSON.stringify({ ...stored, unexpected: true }), "utf8");
    await expect(getRun(workspace, stored.runId)).rejects.toMatchObject({ code: "SCHEMA_INVALID" });
    await expect(listRuns(workspace)).rejects.toMatchObject({ code: "SCHEMA_INVALID" });

    await writeFile(target, JSON.stringify({ ...stored, runId: "run-other" }), "utf8");
    await expect(getRun(workspace, stored.runId)).rejects.toMatchObject({ code: "RUNTIME_RUN_INVALID" });
    await expect(listRuns(workspace)).rejects.toMatchObject({ code: "RUNTIME_RUN_INVALID" });
  });

  it("protects immutable bindings and terminal records", async () => {
    const workspace = await setup();
    await createRun(workspace, run());
    await expect(transitionRun(workspace, "run-1", "COMPLETED", { finishedAt: "2026-01-01T00:01:00.000Z" })).resolves.toMatchObject({ status: "COMPLETED" });
    await expect(transitionRun(workspace, "run-1", "COMPLETED", { blockedReason: "attempted overwrite" })).resolves.toMatchObject({ status: "COMPLETED" });
    await expect(saveRun(workspace, { ...run("COMPLETED"), role: "different" })).rejects.toMatchObject({ code: "RUNTIME_RUN_BINDING_CONFLICT" });
    await expect(saveRun(workspace, { ...run("COMPLETED"), finishedAt: "2026-01-01T00:02:00.000Z" })).rejects.toMatchObject({ code: "RUNTIME_RUN_TERMINAL" });
    await expect(getRun(workspace, "run-1")).resolves.toMatchObject({ status: "COMPLETED" });
    const entries = await listLedgerEntries(workspace);
    expect(entries.filter((entry) => entry.runId === "run-1").map((entry) => [entry.event, entry.fromStatus, entry.toStatus])).toEqual([
      ["run-created", undefined, "RUNNING"],
      ["run-transitioned", "RUNNING", "COMPLETED"]
    ]);
  });

  for (const point of ["after-run", "after-ledger"] as const) {
    it(`repairs Run creation exactly once after ${point}`, async () => {
      const workspace = await setup();
      const target = run();
      injectRunLifecycleFaultForTesting(workspace, point);
      await expect(createRun(workspace, target)).rejects.toMatchObject({
        code: "RUNTIME_RUN_LIFECYCLE_FAULT_INJECTED",
        details: { point }
      });
      await expect(createRun(workspace, target)).resolves.toBeUndefined();
      const created = (await listLedgerEntries(workspace)).filter((entry) => entry.event === "run-created" && entry.runId === target.runId);
      expect(created).toHaveLength(1);
    });
  }

  for (const point of ["after-run", "after-ledger"] as const) {
    it(`repairs a terminal Run transition exactly once after ${point}`, async () => {
      const workspace = await setup();
      await createRun(workspace, run());
      injectRunLifecycleFaultForTesting(workspace, point);
      await expect(transitionRun(workspace, "run-1", "COMPLETED", { finishedAt: "2026-01-01T00:01:00.000Z" }))
        .rejects.toMatchObject({ code: "RUNTIME_RUN_LIFECYCLE_FAULT_INJECTED", details: { point } });
      await expect(transitionRun(workspace, "run-1", "COMPLETED", { finishedAt: "2026-01-01T00:01:00.000Z" }))
        .resolves.toMatchObject({ status: "COMPLETED" });
      const transitioned = (await listLedgerEntries(workspace)).filter((entry) => entry.event === "run-transitioned" && entry.runId === "run-1");
      expect(transitioned).toHaveLength(1);
      expect(transitioned[0]).toMatchObject({ fromStatus: "RUNNING", toStatus: "COMPLETED" });
    });
  }

  it("does not let saveRun create or change lifecycle state", async () => {
    const workspace = await setup();
    await expect(saveRun(workspace, run())).rejects.toMatchObject({ code: "RUNTIME_RUN_NOT_FOUND" });
    await createRun(workspace, run());
    await expect(saveRun(workspace, { ...run("ADMITTED") })).rejects.toMatchObject({ code: "RUNTIME_RUN_TRANSITION_REQUIRED" });
  });
  it("stores and checks owner fencing metadata", async () => {
    const workspace = await setup();
    const owned = { ...run(), ownerToken: "a".repeat(64), fenceEpoch: 0 };
    await createRun(workspace, owned);
    const { assertRunOwner } = await import("../src/storage/runs.js");
    await expect(assertRunOwner(workspace, owned.runId, owned.ownerToken, 0)).resolves.toMatchObject({ ownerToken: owned.ownerToken, fenceEpoch: 0 });
    await expect(assertRunOwner(workspace, owned.runId, "b".repeat(64), 0)).rejects.toMatchObject({ code: "RUNTIME_RUN_FENCED" });
  });

  it("persists only owner-authorized append-only Runtime progress checkpoints", async () => {
    const workspace = await setup();
    const owned = { ...run(), ownerToken: "a".repeat(64), fenceEpoch: 0 };
    await createRun(workspace, owned);
    await expect(checkpointRunProgress(workspace, owned.runId, {
      toolCalls: ["tool-1"], evidenceRefs: ["evidence-1"], budgetUsage: { toolCalls: 1, files: 1, bytes: 10 }
    }, { ownerToken: owned.ownerToken, expectedEpoch: 0 })).resolves.toMatchObject({
      status: "RUNNING", toolCalls: ["tool-1"], evidenceRefs: ["evidence-1"], budgetUsage: { toolCalls: 1 }
    });
    await expect(checkpointRunProgress(workspace, owned.runId, {
      toolCalls: [], evidenceRefs: ["evidence-1"], budgetUsage: { toolCalls: 1, files: 1, bytes: 10 }
    }, { ownerToken: owned.ownerToken, expectedEpoch: 0 })).rejects.toMatchObject({ code: "RUNTIME_RUN_CHECKPOINT_CONFLICT" });
    await expect(checkpointRunProgress(workspace, owned.runId, {
      toolCalls: ["tool-1"], evidenceRefs: ["evidence-1"], budgetUsage: { toolCalls: 0, files: 1, bytes: 10 }
    }, { ownerToken: owned.ownerToken, expectedEpoch: 0 })).rejects.toMatchObject({ code: "RUNTIME_RUN_CHECKPOINT_CONFLICT" });
    await expect(checkpointRunProgress(workspace, owned.runId, {
      toolCalls: ["tool-1", "tool-2"], evidenceRefs: ["evidence-1"], budgetUsage: { toolCalls: 2, files: 1, bytes: 10 }
    }, { ownerToken: "b".repeat(64), expectedEpoch: 0 })).rejects.toMatchObject({ code: "RUNTIME_RUN_FENCED" });
  });

  it("rejects backward lifecycle transitions", async () => {
    const workspace = await setup();
    await createRun(workspace, run());
    await expect(transitionRun(workspace, "run-1", "CREATED")).rejects.toMatchObject({ code: "RUNTIME_RUN_TRANSITION_INVALID" });
  });
});
