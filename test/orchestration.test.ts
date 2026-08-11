import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SchemaRegistry } from "../src/contracts/schema-registry.js";
import { createTask } from "../src/storage/tasks.js";
import { initWorkspace } from "../src/storage/workspace.js";
import {
  createContract, getContract, recommendExecutionMode, createRun, getRun,
  addSubtask, getSubtask, dispatchSubtask, beginSubtask, reportArtifact, getArtifact,
  recordReview, getReview, completeRound, cancelRun, estimateRunCost
} from "../src/storage/orchestration.js";
import { listLedgerEntries } from "../src/storage/ledger.js";

const roots: string[] = [];
const projectRoot = path.resolve(import.meta.dirname, "..");
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "stinky-orch-"));
  roots.push(root);
  const workspace = await initWorkspace(root);
  await mkdir(path.join(root, "docs"), { recursive: true });
  await createTask(workspace, { id: "orch-task", workspaceId: "workspace-1", goal: "Build docs", requestedOutputs: ["document"], riskLevel: "L0", state: "SCOPED" });
  const schemas = await SchemaRegistry.create(projectRoot);
  const contract = await createContract(workspace, schemas, {
    taskId: "orch-task",
    goal: "Produce project documentation",
    globalAcceptanceCriteria: ["docs exist", "no sensitive data", "structure correct", "consistency with code"],
    scope: ["docs"]
  });
  const run = await createRun(workspace, schemas, { contractRef: contract.contractId });
  return { workspace, schemas, contract, run, root };
}

function reviewInput(decision: "ACCEPTED" | "REJECTED", score: number, defects: { location: string; problem: string; suggestion: string }[] = [], reason = "reviewed") {
  return {
    decision,
    criteriaResults: [{ criterion: "docs exist", passed: decision === "ACCEPTED", note: "checked" }],
    defects,
    score,
    reason,
    validatorEvidence: [{ validator: "contentHash", passed: true, detail: "hash ok" }],
    reviewedBy: "host"
  };
}

describe("orchestration loop (storage)", () => {
  it("runs the full loop: contract → run → subtask → dispatch → begin → artifact → accept → complete", async () => {
    const { workspace, schemas, contract, run, root } = await setup();
    expect(recommendExecutionMode(contract).mode).toBe("orchestrate");

    const subtask = await addSubtask(workspace, schemas, run.runId, {
      goal: "Write docs/guide.md",
      inputArtifactIds: [],
      acceptanceCriteria: ["guide.md exists"],
      scope: ["docs"],
      capabilities: ["repository-read"]
    });
    expect(subtask.status).toBe("PENDING");

    const dispatched = await dispatchSubtask(workspace, schemas, run.runId, subtask.subtaskId, "worker-agent");
    expect(dispatched.subtask.status).toBe("DISPATCHED");
    expect(dispatched.leases.length).toBe(1);
    // lease is bound to the subtask
    const leases = await import("../src/storage/leases.js").then((m) => m.listLeases(workspace));
    expect(leases[0].subtaskRef).toBe(subtask.subtaskId);

    await beginSubtask(workspace, run.runId, subtask.subtaskId);
    await writeFile(path.join(root, "docs", "guide.md"), "# Guide\n", "utf8");
    const artifact = await reportArtifact(workspace, schemas, run.runId, subtask.subtaskId, { path: "docs/guide.md", kind: "file" });
    expect(artifact.status).toBe("VERIFIED");
    expect(artifact.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);

    const result = await recordReview(workspace, schemas, run.runId, subtask.subtaskId, reviewInput("ACCEPTED", 90));
    expect(result.review.decision).toBe("ACCEPTED");
    expect(result.subtask.status).toBe("ACCEPTED");
    expect(result.run.status).toBe("COMPLETED"); // all subtasks accepted → auto complete
    expect((await getContract(workspace, contract.contractId)).status).toBe("COMPLETED");
    const events = (await listLedgerEntries(workspace)).map((entry) => entry.event);
    expect(events).toContain("contract-created");
    expect(events).toContain("run-created");
    expect(events).toContain("subtask-dispatched");
    expect(events).toContain("artifact-recorded");
    expect(events).toContain("review-recorded");
    expect(events).toContain("subtask-accepted");
    expect(events).toContain("orchestration-completed");
  });

  it("rejects with defects, redispatch retries, and fails in isolation after exhaustion", async () => {
    const { workspace, schemas, run } = await setup();
    const subtask = await addSubtask(workspace, schemas, run.runId, {
      goal: "Write docs/guide.md", inputArtifactIds: [], acceptanceCriteria: ["good"], scope: ["docs"], capabilities: ["repository-read"]
    });
    await dispatchSubtask(workspace, schemas, run.runId, subtask.subtaskId, "worker-agent");
    await beginSubtask(workspace, run.runId, subtask.subtaskId);
    await writeFile(path.join(workspace.root, "docs", "guide.md"), "v1\n", "utf8");
    await reportArtifact(workspace, schemas, run.runId, subtask.subtaskId, { path: "docs/guide.md", kind: "file" });
    const rejected = await recordReview(workspace, schemas, run.runId, subtask.subtaskId, reviewInput("REJECTED", 40, [{ location: "docs/guide.md", problem: "too short", suggestion: "expand" }]));
    expect(rejected.subtask.status).toBe("REJECTED");
    expect(rejected.subtask.retriesUsed).toBe(1);
    expect(rejected.run.status).toBe("RUNNING"); // failure isolation: run continues

    // redispatch the rejected subtask (retry)
    await dispatchSubtask(workspace, schemas, run.runId, subtask.subtaskId, "worker-agent");
    await beginSubtask(workspace, run.runId, subtask.subtaskId);
    await writeFile(path.join(workspace.root, "docs", "guide.md"), "v2\n", "utf8");
    await reportArtifact(workspace, schemas, run.runId, subtask.subtaskId, { path: "docs/guide.md", kind: "file" });
    const rejectedAgain = await recordReview(workspace, schemas, run.runId, subtask.subtaskId, reviewInput("REJECTED", 40, [{ location: "docs/guide.md", problem: "still too short", suggestion: "expand more" }]));
    expect(rejectedAgain.subtask.status).toBe("REJECTED");
    expect(rejectedAgain.subtask.retriesUsed).toBe(2); // exhausted → run fails (isolation: only this run)
    expect(rejectedAgain.run.status).toBe("FAILED");
  });

  it("escalates the run on oscillation (same defect fingerprint twice)", async () => {
    const { workspace, schemas, run } = await setup();
    const subtask = await addSubtask(workspace, schemas, run.runId, {
      goal: "Write docs/guide.md", inputArtifactIds: [], acceptanceCriteria: ["good"], scope: ["docs"], capabilities: ["repository-read"], maxRetries: 5
    });
    await dispatchSubtask(workspace, schemas, run.runId, subtask.subtaskId, "worker-agent");
    await beginSubtask(workspace, run.runId, subtask.subtaskId);
    await writeFile(path.join(workspace.root, "docs", "guide.md"), "v1\n", "utf8");
    await reportArtifact(workspace, schemas, run.runId, subtask.subtaskId, { path: "docs/guide.md", kind: "file" });
    await recordReview(workspace, schemas, run.runId, subtask.subtaskId, reviewInput("REJECTED", 40, [{ location: "docs/guide.md", problem: "same bug", suggestion: "fix it" }]));
    // round 2: same defect again → oscillation
    await dispatchSubtask(workspace, schemas, run.runId, subtask.subtaskId, "worker-agent");
    await beginSubtask(workspace, run.runId, subtask.subtaskId);
    await writeFile(path.join(workspace.root, "docs", "guide.md"), "v2\n", "utf8");
    await reportArtifact(workspace, schemas, run.runId, subtask.subtaskId, { path: "docs/guide.md", kind: "file" });
    const escalated = await recordReview(workspace, schemas, run.runId, subtask.subtaskId, reviewInput("REJECTED", 40, [{ location: "docs/guide.md", problem: "same bug", suggestion: "fix it" }]));
    expect(escalated.run.status).toBe("ESCALATED");
    expect(escalated.run.escalationReason).toContain("OSCILLATION");
    const events = (await listLedgerEntries(workspace)).map((entry) => entry.event);
    expect(events).toContain("orchestration-escalated");
  });

  it("rejects artifacts outside the subtask scope", async () => {
    const { workspace, schemas, run } = await setup();
    const subtask = await addSubtask(workspace, schemas, run.runId, {
      goal: "Write docs", inputArtifactIds: [], acceptanceCriteria: ["ok"], scope: ["docs"], capabilities: ["repository-read"]
    });
    await dispatchSubtask(workspace, schemas, run.runId, subtask.subtaskId, "worker-agent");
    await beginSubtask(workspace, run.runId, subtask.subtaskId);
    await writeFile(path.join(workspace.root, "src.js"), "bad\n", "utf8");
    const artifact = await reportArtifact(workspace, schemas, run.runId, subtask.subtaskId, { path: "src.js", kind: "file" });
    expect(artifact.status).toBe("REJECTED"); // scope violation
  });

  it("records round completion and supports cancel", async () => {
    const { workspace, schemas, run } = await setup();
    const completed = await completeRound(workspace, run.runId, { passed: true, note: "consistent with contract" });
    expect(completed.round).toBe(1);
    expect(completed.goalConsistency).toHaveLength(1);
    const cancelled = await cancelRun(workspace, run.runId);
    expect(cancelled.status).toBe("CANCELLED");
  });
});

describe("2.0 gap coverage", () => {
  async function runOneSubtaskFlow(workspace: any, schemas: any, run: any, goal: string, content: string, maxRetries?: number) {
    const subtask = await addSubtask(workspace, schemas, run.runId, {
      goal, inputArtifactIds: [], acceptanceCriteria: ["good"], scope: ["docs"], capabilities: ["repository-read", "repository-write"], ...(maxRetries === undefined ? {} : { maxRetries })
    });
    await dispatchSubtask(workspace, schemas, run.runId, subtask.subtaskId, "worker-agent");
    await beginSubtask(workspace, run.runId, subtask.subtaskId);
    return subtask;
  }

  it("completes a positive rework loop: reject → redispatch → corrected → accept", async () => {
    const { workspace, schemas, run } = await setup();
    const subtask = await runOneSubtaskFlow(workspace, schemas, run, "Write docs/guide.md", "");
    await writeFile(path.join(workspace.root, "docs", "guide.md"), "v1\n", "utf8");
    await reportArtifact(workspace, schemas, run.runId, subtask.subtaskId, { path: "docs/guide.md", kind: "file" });
    await recordReview(workspace, schemas, run.runId, subtask.subtaskId, reviewInput("REJECTED", 50, [{ location: "docs/guide.md", problem: "missing sections", suggestion: "add all sections" }]));
    // redispatch the rejected subtask
    await dispatchSubtask(workspace, schemas, run.runId, subtask.subtaskId, "worker-agent");
    await beginSubtask(workspace, run.runId, subtask.subtaskId);
    await writeFile(path.join(workspace.root, "docs", "guide.md"), "# Guide\n\n## Overview\n...\n\n## Usage\n...\n\n## Install\n...\n", "utf8");
    await reportArtifact(workspace, schemas, run.runId, subtask.subtaskId, { path: "docs/guide.md", kind: "file" });
    const accepted = await recordReview(workspace, schemas, run.runId, subtask.subtaskId, reviewInput("ACCEPTED", 90));
    expect(accepted.subtask.status).toBe("ACCEPTED");
    expect(accepted.run.status).toBe("COMPLETED");
  });

  it("rolls back a rejected worker artifact via write rollback (subtask-mode intent)", async () => {
    const { workspace, schemas, run, root } = await setup();
    await writeFile(path.join(root, "docs", "existing.md"), "original\n", "utf8");
    const subtask = await runOneSubtaskFlow(workspace, schemas, run, "Modify docs/existing.md", "");
    // worker applies a controlled write (subtask-mode intent + write lease)
    const { requestWrites, rollbackWrite } = await import("../src/storage/write-intents.js");
    const { applyWrite } = await import("../src/storage/writes.js");
    const { getLease } = await import("../src/storage/leases.js");
    const intent = await requestWrites(workspace, schemas, "-", "-", [{ target: "docs/existing.md", action: "modify", purpose: "worker change" }], { autoAllow: true, runRef: run.runId, subtaskRef: subtask.subtaskId });
    const leases = await import("../src/storage/leases.js").then((m) => m.listLeases(workspace));
    const writeLease = leases.find((l: any) => l.capability === "repository-write" && l.subtaskRef === subtask.subtaskId);
    expect(writeLease).toBeDefined();
    await applyWrite(workspace, schemas, writeLease, intent, "docs/existing.md", "worker changed it\n");
    await reportArtifact(workspace, schemas, run.runId, subtask.subtaskId, { path: "docs/existing.md", kind: "file" });
    await recordReview(workspace, schemas, run.runId, subtask.subtaskId, reviewInput("REJECTED", 30, [{ location: "docs/existing.md", problem: "regressed", suggestion: "revert" }]));
    // rollback restores the pre-write content (subtask-mode intent rollback)
    await rollbackWrite(workspace, schemas, "-", "-", intent.writeIntentId, "Worker output rejected; revert.");
    expect(await readFile(path.join(root, "docs", "existing.md"), "utf8")).toBe("original\n");
  });

  it("enforces dependency batches: B cannot dispatch before A is accepted", async () => {
    const { workspace, schemas, run } = await setup();
    const a = await runOneSubtaskFlow(workspace, schemas, run, "Write docs/a.md", "");
    const b = await addSubtask(workspace, schemas, run.runId, {
      goal: "Write docs/b.md based on a.md", inputArtifactIds: [], acceptanceCriteria: ["good"], scope: ["docs"], capabilities: ["repository-read"], dependsOn: [a.subtaskId]
    });
    // B dispatch while A is RUNNING → dependency pending
    await expect(dispatchSubtask(workspace, schemas, run.runId, b.subtaskId, "worker-agent")).rejects.toMatchObject({ code: "SUBTASK_DEPENDENCY_PENDING" });
    // complete A, then B dispatches fine
    await writeFile(path.join(workspace.root, "docs", "a.md"), "A\n", "utf8");
    await reportArtifact(workspace, schemas, run.runId, a.subtaskId, { path: "docs/a.md", kind: "file" });
    await recordReview(workspace, schemas, run.runId, a.subtaskId, reviewInput("ACCEPTED", 90));
    const dispatchedB = await dispatchSubtask(workspace, schemas, run.runId, b.subtaskId, "worker-agent");
    expect(dispatchedB.subtask.status).toBe("DISPATCHED");
  });

  it("fails the run when the round budget is exhausted", async () => {
    const { workspace, schemas, run } = await setup();
    const subtask = await runOneSubtaskFlow(workspace, schemas, run, "Write docs/guide.md", "");
    await writeFile(path.join(workspace.root, "docs", "guide.md"), "v1\n", "utf8");
    await reportArtifact(workspace, schemas, run.runId, subtask.subtaskId, { path: "docs/guide.md", kind: "file" });
    await recordReview(workspace, schemas, run.runId, subtask.subtaskId, reviewInput("REJECTED", 40, [{ location: "x", problem: "p1", suggestion: "s1" }]));
    // advance rounds beyond budget (maxRounds default 5)
    for (let i = 0; i < 5; i++) await completeRound(workspace, run.runId, { passed: true, note: "advance" });
    // next review sees run.round=5 > maxRounds=5 → ROUND_BUDGET fails the run
    await dispatchSubtask(workspace, schemas, run.runId, subtask.subtaskId, "worker-agent");
    await beginSubtask(workspace, run.runId, subtask.subtaskId);
    await writeFile(path.join(workspace.root, "docs", "guide.md"), "v2\n", "utf8");
    await reportArtifact(workspace, schemas, run.runId, subtask.subtaskId, { path: "docs/guide.md", kind: "file" });
    const result = await recordReview(workspace, schemas, run.runId, subtask.subtaskId, reviewInput("REJECTED", 40, [{ location: "x", problem: "p2", suggestion: "s2" }]));
    expect(result.run.status).toBe("FAILED");
    expect(result.run.escalationReason ?? result.run.completedAt).toBeDefined();
  });
});

describe("cost estimation", () => {
  it("estimates tokens and mode from the contract", async () => {
    const { workspace, schemas } = await setup();
    const simple = await createContract(workspace, schemas, { taskId: "orch-task", goal: "g", globalAcceptanceCriteria: ["a"], scope: ["docs/guide.md"] });
    const simpleEstimate = estimateRunCost(simple);
    expect(simpleEstimate.mode).toBe("direct");
    expect(simpleEstimate.estimatedSubtasks).toBe(1);
    expect(simpleEstimate.estimatedTokens).toBeLessThan(50000);
    const complex = await createContract(workspace, schemas, { taskId: "orch-task", goal: "g", globalAcceptanceCriteria: ["a", "b", "c", "d", "e", "f", "g", "h"], scope: ["docs", "src"] });
    const complexEstimate = estimateRunCost(complex);
    expect(complexEstimate.estimatedSubtasks).toBe(4);
    expect(complexEstimate.estimatedTokens).toBeGreaterThanOrEqual(50000);
    expect(complexEstimate.mode).toBe("orchestrate");
  });
});
