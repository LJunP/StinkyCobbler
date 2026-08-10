import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentRun } from "../src/contracts/types.js";
import { createRun, getRun, heartbeatRun, transitionRun } from "../src/storage/runs.js";
import { listLedgerEntries } from "../src/storage/ledger.js";
import { initWorkspace } from "../src/storage/workspace.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "stinky-run-heartbeat-"));
  roots.push(root);
  return initWorkspace(root);
}

function run(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    version: 1,
    runId: "run-heartbeat-1",
    capsuleId: "capsule-1",
    taskId: "task-1",
    agentId: "agent-1",
    role: "scout",
    workspaceId: "workspace-1",
    leaseId: "lease-1",
    policyVersion: "1",
    status: "RUNNING",
    executor: "scripted-readonly",
    ownerToken: "a".repeat(64),
    fenceEpoch: 0,
    budget: { maxToolCalls: 3 },
    budgetUsage: { toolCalls: 0 },
    toolCalls: [],
    evidenceRefs: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    startedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

describe("run heartbeat", () => {
  it("refreshes heartbeatAt for the owning executor and reads it back", async () => {
    const workspace = await setup();
    await createRun(workspace, run());
    const beat = await heartbeatRun(workspace, "run-heartbeat-1", { ownerToken: "a".repeat(64), expectedEpoch: 0, heartbeatAt: "2026-01-01T00:05:00.000Z" });
    expect(beat.heartbeatAt).toBe("2026-01-01T00:05:00.000Z");
    await expect(getRun(workspace, "run-heartbeat-1")).resolves.toMatchObject({ heartbeatAt: "2026-01-01T00:05:00.000Z" });
    const entries = await listLedgerEntries(workspace);
    expect(entries.filter((entry) => entry.runId === "run-heartbeat-1").map((entry) => entry.event)).toEqual(["run-created"]);
  });

  it("fences a stale owner and an epoch mismatch", async () => {
    const workspace = await setup();
    await createRun(workspace, run());
    await expect(heartbeatRun(workspace, "run-heartbeat-1", { ownerToken: "b".repeat(64), expectedEpoch: 0 })).rejects.toMatchObject({ code: "RUNTIME_RUN_FENCED" });
    await expect(heartbeatRun(workspace, "run-heartbeat-1", { ownerToken: "a".repeat(64), expectedEpoch: 1 })).rejects.toMatchObject({ code: "RUNTIME_RUN_FENCED" });
  });

  it("returns terminal runs unchanged and does not revive them", async () => {
    const workspace = await setup();
    await createRun(workspace, run());
    await transitionRun(workspace, "run-heartbeat-1", "CANCELLED", {
      errorCode: "RUNTIME_CANCELLED",
      blockedReason: "Cancelled.",
      finishedAt: "2026-01-01T00:01:00.000Z"
    });
    const beat = await heartbeatRun(workspace, "run-heartbeat-1", { ownerToken: "a".repeat(64), expectedEpoch: 0 });
    expect(beat.status).toBe("CANCELLED");
    expect(beat.heartbeatAt).toBeUndefined();
    await expect(getRun(workspace, "run-heartbeat-1")).resolves.toMatchObject({ status: "CANCELLED" });
  });

  it("rejects an invalid heartbeatAt at the storage boundary", async () => {
    const workspace = await setup();
    await expect(createRun(workspace, { ...run(), heartbeatAt: "not-a-date" })).rejects.toMatchObject({ code: "RUNTIME_RUN_INVALID" });
  });
});
