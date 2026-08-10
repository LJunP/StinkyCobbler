import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentRun } from "../src/contracts/types.js";
import { createRun, getRun, getRunStaleness, recoverStaleRun } from "../src/storage/runs.js";
import { listLedgerEntries } from "../src/storage/ledger.js";
import { initWorkspace } from "../src/storage/workspace.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "stinky-run-recovery-"));
  roots.push(root);
  return initWorkspace(root);
}

function run(status: AgentRun["status"], startedAt: string): AgentRun {
  return {
    version: 1,
    runId: "run-recovery-1",
    capsuleId: "capsule-1",
    taskId: "task-1",
    agentId: "agent-1",
    role: "scout",
    workspaceId: "workspace-1",
    leaseId: "lease-1",
    policyVersion: "1",
    status,
    executor: "scripted-readonly",
    budget: { maxToolCalls: 3 },
    budgetUsage: { toolCalls: 1 },
    toolCalls: [],
    evidenceRefs: ["evidence-1"],
    createdAt: "2026-01-01T00:00:00.000Z",
    startedAt,
  };
}

describe("stale Agent run recovery", () => {
  it("classifies only an old non-terminal run as stale", async () => {
    const workspace = await setup();
    const startedAt = "2026-01-01T00:00:00.000Z";
    await createRun(workspace, run("RUNNING", startedAt));

    await expect(getRunStaleness(workspace, "run-recovery-1", {
      staleMs: 60_000,
      now: new Date("2026-01-01T00:02:00.000Z")
    })).resolves.toMatchObject({ stale: true, status: "RUNNING", ageMs: 120_000 });

    await createRun(workspace, { ...run("COMPLETED", startedAt), runId: "run-terminal", finishedAt: "2026-01-01T00:01:00.000Z" });
    await expect(getRunStaleness(workspace, "run-terminal", {
      staleMs: 60_000,
      now: new Date("2026-01-01T00:02:00.000Z")
    })).resolves.toMatchObject({ stale: false, status: "COMPLETED" });
  });

  it("requires an explicit stale recovery and preserves execution evidence", async () => {
    const workspace = await setup();
    await createRun(workspace, run("RUNNING", "2026-01-01T00:00:00.000Z"));

    await expect(recoverStaleRun(workspace, "run-recovery-1", {
      staleMs: 60_000,
      now: new Date("2026-01-01T00:00:30.000Z")
    })).rejects.toMatchObject({ code: "RUNTIME_RUN_NOT_STALE" });

    const recovered = await recoverStaleRun(workspace, "run-recovery-1", {
      staleMs: 60_000,
      now: new Date("2026-01-01T00:02:00.000Z")
    });
    expect(recovered).toMatchObject({
      status: "FAILED",
      fenceEpoch: 1,
      errorCode: "RUNTIME_STALE_RECOVERY",
      blockedReason: "Run was explicitly recovered after exceeding the stale threshold.",
      evidenceRefs: ["evidence-1"],
      budgetUsage: { toolCalls: 1 }
    });
    await expect(getRun(workspace, "run-recovery-1")).resolves.toEqual(recovered);
    const entries = await listLedgerEntries(workspace);
    expect(entries.filter((entry) => entry.runId === "run-recovery-1").map((entry) => entry.event)).toEqual(["run-created", "run-recovered"]);
    await expect(recoverStaleRun(workspace, "run-recovery-1", {
      staleMs: 60_000,
      now: new Date("2026-01-01T00:03:00.000Z")
    })).resolves.toEqual(recovered);
  });

  it("treats a fresh heartbeat as alive even when startedAt is far in the past", async () => {
    const workspace = await setup();
    await createRun(workspace, { ...run("RUNNING", "2026-01-01T00:00:00.000Z"), heartbeatAt: "2026-01-01T00:01:30.000Z" });
    await expect(getRunStaleness(workspace, "run-recovery-1", {
      staleMs: 60_000,
      now: new Date("2026-01-01T00:02:00.000Z")
    })).resolves.toMatchObject({ stale: false, ageMs: 30_000, referenceAt: "2026-01-01T00:01:30.000Z" });
    await expect(recoverStaleRun(workspace, "run-recovery-1", {
      staleMs: 60_000,
      now: new Date("2026-01-01T00:02:00.000Z")
    })).rejects.toMatchObject({ code: "RUNTIME_RUN_NOT_STALE" });
  });

  it("still recovers a run whose heartbeat has also gone stale", async () => {
    const workspace = await setup();
    await createRun(workspace, { ...run("RUNNING", "2026-01-01T00:00:00.000Z"), heartbeatAt: "2026-01-01T00:00:30.000Z" });
    const recovered = await recoverStaleRun(workspace, "run-recovery-1", {
      staleMs: 60_000,
      now: new Date("2026-01-01T00:02:00.000Z")
    });
    expect(recovered).toMatchObject({ status: "FAILED", errorCode: "RUNTIME_STALE_RECOVERY" });
  });
});
