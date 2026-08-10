import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SchemaRegistry } from "../src/contracts/schema-registry.js";
import { createTask } from "../src/storage/tasks.js";
import { initWorkspace } from "../src/storage/workspace.js";
import {
  createContract, getContract, recommendExecutionMode, createRun, getRun,
  addSubtask, getSubtask, dispatchSubtask, beginSubtask, reportArtifact, getArtifact,
  recordReview, getReview, completeRound, cancelRun
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
