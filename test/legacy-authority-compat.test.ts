import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SchemaRegistry } from "../src/contracts/schema-registry.js";
import { addSubtask, cancelRun, createRun, getContract, updateContractStatus } from "../src/storage/orchestration.js";
import { admitAndReserveLeaseCall } from "../src/storage/lease-usage.js";
import { getLease, revokeLease } from "../src/storage/leases.js";
import { cancelPlan, executePlan, getPlan } from "../src/storage/plans.js";
import { createTask, getTask } from "../src/storage/tasks.js";
import { listLedgerEntries } from "../src/storage/ledger.js";
import { transitionTask } from "../src/storage/task-transitions.js";
import { confirmWrites, getWriteIntent } from "../src/storage/write-intents.js";
import { initWorkspace, workspaceFile, writeWorkspaceJson } from "../src/storage/workspace.js";

const roots: string[] = [];
const projectRoot = path.resolve(import.meta.dirname, "..");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "stinky-legacy-authority-"));
  roots.push(root);
  const workspace = await initWorkspace(root);
  await createTask(workspace, {
    id: "legacy-task", workspaceId: "workspace", goal: "Inspect legacy records", requestedOutputs: ["report"],
    riskLevel: "L0", state: "RUNNING", scope: ["docs"], writeSet: ["docs"]
  });
  return { workspace, schemas: await SchemaRegistry.create(projectRoot) };
}

describe("2.0.0 authority record compatibility", () => {
  it("keeps a legacy Task fail-closed for execution but permits one journaled cancellation", async () => {
    const { workspace, schemas } = await setup();
    const legacy = await getTask(workspace, "legacy-task");
    delete legacy.authorityGeneration;
    await writeWorkspaceJson(workspace, "task-legacy-task.json", legacy);

    await expect(transitionTask(workspace, schemas, legacy.id, "REVIEWING"))
      .rejects.toMatchObject({ code: "TASK_AUTHORITY_REISSUE_REQUIRED" });
    await expect(transitionTask(workspace, schemas, legacy.id, "CANCELLED", { reason: "Retire pre-2.0.1 Task authority." }))
      .resolves.toMatchObject({ state: "CANCELLED", authorityGeneration: 0 });
    await expect(transitionTask(workspace, schemas, legacy.id, "CANCELLED", { reason: "Retire pre-2.0.1 Task authority." }))
      .resolves.toMatchObject({ state: "CANCELLED", authorityGeneration: 0 });
    const cancellations = (await listLedgerEntries(workspace)).filter((entry) =>
      entry.event === "task-cancelled" && entry.taskId === legacy.id
    );
    expect(cancellations).toHaveLength(1);
  });

  it("keeps a legacy Lease readable and revocable while denying execution", async () => {
    const { workspace } = await setup();
    const legacy = {
      id: "lease-legacy", taskId: "legacy-task", agentId: "legacy-agent", role: "scout",
      capability: "repository-read", level: "L0", workspace: workspace.root, readScope: ["docs"], writeSet: [],
      issuedAt: "2026-08-11T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z", maxToolCalls: 20,
      status: "active"
    };
    await mkdir(await workspaceFile(workspace, "leases"), { recursive: true });
    await writeWorkspaceJson(workspace, "leases/lease-legacy.json", legacy);

    await expect(getLease(workspace, legacy.id)).resolves.toMatchObject(legacy);
    await expect(admitAndReserveLeaseCall(workspace, legacy.id, {
      taskId: "legacy-task", role: "scout", capability: "repository-read"
    })).resolves.toMatchObject({ allowed: false, decision: { code: "LEASE_REISSUE_REQUIRED" } });
    await expect(revokeLease(workspace, legacy.id, "Retire pre-2.0.1 authority."))
      .resolves.toMatchObject({ status: "revoked" });
  });

  it("keeps a legacy Contract readable and cancellable while denying a new Run", async () => {
    const { workspace, schemas } = await setup();
    const legacy = {
      version: 1, contractId: "contract-legacy", taskId: "legacy-task", domain: "general",
      goal: "Legacy orchestration", globalAcceptanceCriteria: ["inspected"], scope: ["docs"],
      createdAt: "2026-08-11T00:00:00.000Z", status: "ACTIVE"
    };
    await mkdir(await workspaceFile(workspace, "orchestration"), { recursive: true });
    await writeWorkspaceJson(workspace, "orchestration/contract-legacy.json", legacy);

    await expect(getContract(workspace, legacy.contractId)).resolves.toMatchObject(legacy);
    await expect(createRun(workspace, schemas, { contractRef: legacy.contractId }))
      .rejects.toMatchObject({ code: "CONTRACT_REISSUE_REQUIRED" });
    await writeWorkspaceJson(workspace, "orchestration/run-legacy.json", {
      version: 1,
      runId: "run-legacy",
      contractRef: legacy.contractId,
      status: "RUNNING",
      round: 0,
      budget: { maxRounds: 5, maxRetriesPerSubtask: 2, maxSubtaskTokens: 200000, usedTokens: 0 },
      subtasks: [],
      artifacts: [],
      reviews: [],
      goalConsistency: [],
      createdAt: "2026-08-11T00:00:00.000Z"
    });
    const legacyIntent = {
      version: 1,
      writeIntentId: "write-legacy",
      planId: "-",
      stepId: "-",
      runRef: "run-legacy",
      subtaskRef: "subtask-legacy",
      status: "PENDING",
      writes: [
        { target: "docs/one.md", action: "create", purpose: "Legacy first target." },
        { target: "docs/two.md", action: "create", purpose: "Legacy second target." }
      ],
      createdAt: "2026-08-11T00:01:00.000Z"
    };
    await mkdir(await workspaceFile(workspace, "write-intents"), { recursive: true });
    await writeWorkspaceJson(workspace, "write-intents/write-legacy.json", legacyIntent);
    await expect(getWriteIntent(workspace, legacyIntent.writeIntentId)).resolves.toMatchObject(legacyIntent);
    await expect(confirmWrites(workspace, "-", "-", legacyIntent.writeIntentId))
      .rejects.toMatchObject({ code: "WRITE_REISSUE_REQUIRED" });
    await expect(addSubtask(workspace, schemas, "run-legacy", {
      goal: "Must not execute", inputArtifactIds: [], acceptanceCriteria: ["blocked"], scope: ["docs"], capabilities: ["repository-read"]
    })).rejects.toMatchObject({ code: "CONTRACT_REISSUE_REQUIRED" });
    await expect(cancelRun(workspace, "run-legacy")).resolves.toMatchObject({ status: "CANCELLED" });
    await expect(getWriteIntent(workspace, legacyIntent.writeIntentId)).resolves.toMatchObject({
      status: "REJECTED",
      cancellationReason: "Orchestration run run-legacy cancelled."
    });
    await expect(updateContractStatus(workspace, schemas, legacy.contractId, "CANCELLED"))
      .resolves.toMatchObject({ status: "CANCELLED" });
  });

  it("keeps a legacy Plan readable and cancellable while denying execution", async () => {
    const { workspace } = await setup();
    const legacy = {
      version: 1, planId: "plan-legacy", taskId: "legacy-task", status: "APPROVED",
      goal: "Legacy direct plan", createdAt: "2026-08-11T00:00:00.000Z",
      steps: [{
        stepId: "step-1", role: "builder", goal: "Inspect docs", tools: ["repository-read"],
        readScope: ["docs"], writes: [], status: "PENDING"
      }]
    };
    await mkdir(await workspaceFile(workspace, "plans"), { recursive: true });
    await writeWorkspaceJson(workspace, "plans/plan-legacy.json", legacy);

    await expect(getPlan(workspace, legacy.planId)).resolves.toMatchObject(legacy);
    await expect(executePlan(workspace, legacy.planId)).rejects.toMatchObject({ code: "PLAN_REISSUE_REQUIRED" });
    await expect(cancelPlan(workspace, legacy.planId, "Retire pre-2.0.1 plan."))
      .resolves.toMatchObject({ status: "CANCELLED" });
  });
});
