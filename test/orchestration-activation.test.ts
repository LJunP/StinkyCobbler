import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SchemaRegistry } from "../src/contracts/schema-registry.js";
import { createTask } from "../src/storage/tasks.js";
import { initWorkspace } from "../src/storage/workspace.js";
import {
  addSubtask, beginSubtask, cancelRun, createContract, createRun, dispatchSubtask, escalateRun,
  getRun, getSubtask, injectOrchestrationActivationFaultForTesting,
  injectCancellationFaultForTesting, injectSubtaskCreationFaultForTesting, listRuns, recordReview, resumeRun
} from "../src/storage/orchestration.js";
import { getRunCancellationFence } from "../src/storage/orchestration-fence.js";
import { admitAndReserveLeaseCall } from "../src/storage/lease-usage.js";
import { listLeases } from "../src/storage/leases.js";
import { appendLedgerEntry, listLedgerEntries } from "../src/storage/ledger.js";
import {
  escalationTransactionId, getOrchestrationTransaction, injectOrchestrationTransactionFaultForTesting,
  reconcileOrchestrationTransaction
} from "../src/storage/orchestration-transactions.js";

const roots: string[] = [];
const projectRoot = path.resolve(import.meta.dirname, "..");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setupContract() {
  const root = await mkdtemp(path.join(os.tmpdir(), "stinky-orch-activation-"));
  roots.push(root);
  await mkdir(path.join(root, "docs"));
  const workspace = await initWorkspace(root);
  const schemas = await SchemaRegistry.create(projectRoot);
  const task = {
    id: "activation-task",
    workspaceId: "activation-workspace",
    goal: "Exercise activation recovery",
    requestedOutputs: ["document"],
    riskLevel: "L0" as const,
    state: "RUNNING" as const,
    scope: ["docs"]
  };
  await createTask(workspace, task);
  const contract = await createContract(workspace, schemas, {
    taskId: task.id,
    domain: "compliance",
    goal: "Create one bounded document",
    globalAcceptanceCriteria: ["document exists"],
    scope: ["docs"]
  });
  return { workspace, schemas, task, contract };
}

async function setupRun() {
  const fixture = await setupContract();
  const run = await createRun(fixture.workspace, fixture.schemas, { contractRef: fixture.contract.contractId });
  return { ...fixture, run };
}

describe("orchestration executable activation recovery", () => {
  for (const point of ["after-subtask", "after-run"] as const) {
    it(`recovers one exact Subtask creation after ${point}`, async () => {
      const { workspace, schemas, run } = await setupRun();
      const input = {
        goal: "Create one crash-safe Subtask",
        inputArtifactIds: [],
        acceptanceCriteria: ["subtask is attached exactly once"],
        scope: ["docs"],
        capabilities: ["repository-read"]
      };
      injectSubtaskCreationFaultForTesting(workspace, point);
      await expect(addSubtask(workspace, schemas, run.runId, input))
        .rejects.toMatchObject({ code: "SUBTASK_CREATION_TEST_FAULT", details: { point } });

      const recovered = await addSubtask(workspace, schemas, run.runId, input);
      const repeated = await addSubtask(workspace, schemas, run.runId, input);
      expect(repeated.subtaskId).toBe(recovered.subtaskId);
      expect(recovered.creationRequestHash).toMatch(/^sha256:/);
      expect((await getRun(workspace, run.runId)).subtasks).toEqual([recovered.subtaskId]);
      await dispatchSubtask(workspace, schemas, run.runId, recovered.subtaskId, "creation-worker", 0);
      await expect(addSubtask(workspace, schemas, run.runId, input))
        .resolves.toMatchObject({ subtaskId: recovered.subtaskId, status: "DISPATCHED" });

      const distinct = await addSubtask(workspace, schemas, run.runId, {
        ...input,
        goal: "Create a distinct Subtask"
      });
      expect(distinct.subtaskId).not.toBe(recovered.subtaskId);
      expect((await getRun(workspace, run.runId)).subtasks).toEqual([recovered.subtaskId, distinct.subtaskId]);
    });
  }

  for (const point of ["after-run", "after-ledger"] as const) {
    it(`keeps Run creation single-valued and exactly audited after ${point}`, async () => {
      const { workspace, schemas, contract } = await setupContract();
      const input = { contractRef: contract.contractId, maxRounds: 7 };
      injectOrchestrationActivationFaultForTesting(workspace, point);
      await expect(createRun(workspace, schemas, input))
        .rejects.toMatchObject({ code: "ORCHESTRATION_ACTIVATION_TEST_FAULT", details: { point } });

      const [persisted] = await listRuns(workspace, contract.contractId);
      expect(persisted).toMatchObject({ status: "RUNNING", creationRequestHash: expect.stringMatching(/^sha256:/) });
      await expect(createRun(workspace, schemas, input)).resolves.toMatchObject({ runId: persisted!.runId });
      const effects = (await listLedgerEntries(workspace)).filter((entry) => entry.event === "run-created" && entry.runRef === persisted!.runId);
      expect(effects).toHaveLength(1);
    });
  }

  for (const point of ["after-run", "after-ledger-effect"] as const) {
    it(`repairs one exact manual escalation transaction after ${point}`, async () => {
      const { workspace, run } = await setupRun();
      const reason = "A human decision is required before continuing.";
      injectOrchestrationTransactionFaultForTesting(workspace, point);
      await expect(escalateRun(workspace, run.runId, reason))
        .rejects.toMatchObject({ code: "ORCHESTRATION_TRANSACTION_TEST_FAULT", details: { point } });

      await expect(escalateRun(workspace, run.runId, "A different decision request."))
        .rejects.toMatchObject({ code: "RUN_ESCALATION_IDEMPOTENCY_CONFLICT" });
      await expect(escalateRun(workspace, run.runId, reason))
        .resolves.toMatchObject({ status: "ESCALATED", escalationReason: reason });
      await expect(escalateRun(workspace, run.runId, reason))
        .resolves.toMatchObject({ status: "ESCALATED", escalationReason: reason });

      const transaction = await getOrchestrationTransaction(workspace, escalationTransactionId(run.runId, 1));
      expect(transaction).toMatchObject({ kind: "ESCALATION", status: "COMMITTED", escalationGeneration: 1 });
      expect((await listLedgerEntries(workspace)).filter((entry) =>
        entry.event === "orchestration-escalated" && entry.runRef === run.runId
      )).toHaveLength(1);
    });
  }

  it("reconciles a prepared manual escalation before a human resume decision", async () => {
    const { workspace, run } = await setupRun();
    injectOrchestrationTransactionFaultForTesting(workspace, "after-prepared");
    await expect(escalateRun(workspace, run.runId, "Pause for a human decision."))
      .rejects.toMatchObject({ code: "ORCHESTRATION_TRANSACTION_TEST_FAULT", details: { point: "after-prepared" } });
    expect(await getRun(workspace, run.runId)).toMatchObject({ status: "RUNNING" });

    await expect(resumeRun(workspace, run.runId, { expectedResumeGeneration: 1 }))
      .resolves.toMatchObject({ status: "RUNNING", resumeGeneration: 1 });
    expect(await getOrchestrationTransaction(workspace, escalationTransactionId(run.runId, 1)))
      .toMatchObject({ kind: "ESCALATION", status: "COMMITTED" });
    expect((await listLedgerEntries(workspace)).filter((entry) =>
      entry.event === "orchestration-escalated" && entry.runRef === run.runId
    )).toHaveLength(1);
  });

  it("lets durable cancellation abort an unpublished manual escalation after a fence crash", async () => {
    const { workspace, schemas, run } = await setupRun();
    const reason = "Pause for a human decision before cancellation.";
    injectOrchestrationTransactionFaultForTesting(workspace, "after-prepared");
    await expect(escalateRun(workspace, run.runId, reason))
      .rejects.toMatchObject({ code: "ORCHESTRATION_TRANSACTION_TEST_FAULT", details: { point: "after-prepared" } });

    injectCancellationFaultForTesting(workspace, "after-fence");
    await expect(cancelRun(workspace, run.runId))
      .rejects.toMatchObject({ code: "ORCHESTRATION_CANCELLATION_TEST_FAULT", details: { point: "after-fence" } });
    expect(await getRunCancellationFence(workspace, run.runId)).toMatchObject({ status: "CANCELLING" });

    await expect(resumeRun(workspace, run.runId, { expectedResumeGeneration: 1 }))
      .rejects.toMatchObject({ code: "RUN_CANCELLED" });
    await expect(escalateRun(workspace, run.runId, reason))
      .rejects.toMatchObject({ code: "RUN_CANCELLED" });
    await expect(reconcileOrchestrationTransaction(
      workspace,
      schemas,
      escalationTransactionId(run.runId, 1)
    )).rejects.toMatchObject({ code: "ORCHESTRATION_TRANSACTION_CANCELLED" });
    expect(await getOrchestrationTransaction(workspace, escalationTransactionId(run.runId, 1)))
      .toMatchObject({ kind: "ESCALATION", status: "PREPARED" });
    expect((await listLedgerEntries(workspace)).filter((entry) =>
      entry.event === "orchestration-escalated" && entry.runRef === run.runId
    )).toHaveLength(0);

    await expect(cancelRun(workspace, run.runId)).resolves.toMatchObject({ status: "CANCELLED" });
    expect(await getRunCancellationFence(workspace, run.runId)).toMatchObject({ status: "CANCELLED" });
    expect(await getOrchestrationTransaction(workspace, escalationTransactionId(run.runId, 1)))
      .toMatchObject({ kind: "ESCALATION", status: "ABORTED" });
    expect((await listLedgerEntries(workspace)).filter((entry) =>
      entry.event === "orchestration-escalated" && entry.runRef === run.runId
    )).toHaveLength(0);
  });

  it("rejects a non-canonical activation effect instead of accepting or duplicating it", async () => {
    const { workspace, schemas, task, contract } = await setupContract();
    injectOrchestrationActivationFaultForTesting(workspace, "after-run");
    await expect(createRun(workspace, schemas, { contractRef: contract.contractId }))
      .rejects.toMatchObject({ code: "ORCHESTRATION_ACTIVATION_TEST_FAULT" });
    const [persisted] = await listRuns(workspace, contract.contractId);
    await appendLedgerEntry(workspace, {
      event: "run-created",
      taskId: task.id,
      contractRef: contract.contractId,
      runRef: persisted!.runId,
      attempt: 0,
      summary: `Orchestration run ${persisted!.runId} created.`
    });

    await expect(createRun(workspace, schemas, { contractRef: contract.contractId }))
      .rejects.toMatchObject({ code: "ORCHESTRATION_ACTIVATION_AUDIT_CONFLICT" });
    expect((await listLedgerEntries(workspace)).filter((entry) =>
      entry.event === "run-created" && entry.runRef === persisted!.runId
    )).toHaveLength(1);
  });

  it("rejects non-finite create input before exact split recovery", async () => {
    const { workspace, schemas, contract } = await setupContract();
    injectOrchestrationActivationFaultForTesting(workspace, "after-run");
    await expect(createRun(workspace, schemas, { contractRef: contract.contractId }))
      .rejects.toMatchObject({ code: "ORCHESTRATION_ACTIVATION_TEST_FAULT" });

    await expect(createRun(workspace, schemas, { contractRef: contract.contractId, maxRounds: Number.NaN }))
      .rejects.toMatchObject({ code: "RUN_BUDGET_INVALID" });
    await expect(createRun(workspace, schemas, { contractRef: contract.contractId }))
      .resolves.toMatchObject({ status: "RUNNING" });
  });

  for (const point of ["after-subtask", "after-ledger"] as const) {
    it(`recovers one exact dispatch attempt after ${point}`, async () => {
      const { workspace, schemas, run } = await setupRun();
      const subtask = await addSubtask(workspace, schemas, run.runId, {
        goal: "Read bounded docs",
        inputArtifactIds: [],
        acceptanceCriteria: ["read completed"],
        scope: ["docs"],
        capabilities: ["repository-read"]
      });
      injectOrchestrationActivationFaultForTesting(workspace, point);
      await expect(dispatchSubtask(workspace, schemas, run.runId, subtask.subtaskId, "activation-worker", 0))
        .rejects.toMatchObject({ code: "ORCHESTRATION_ACTIVATION_TEST_FAULT", details: { point } });

      const persisted = await getSubtask(workspace, subtask.subtaskId);
      expect(persisted).toMatchObject({ status: "DISPATCHED", activeAttempt: 0, dispatchedAgentId: "activation-worker" });
      await expect(dispatchSubtask(workspace, schemas, run.runId, subtask.subtaskId, "different-worker", 0))
        .rejects.toMatchObject({ code: "SUBTASK_DISPATCH_IDEMPOTENCY_CONFLICT" });
      const recovered = await dispatchSubtask(workspace, schemas, run.runId, subtask.subtaskId, "activation-worker", 0);
      expect(recovered).toMatchObject({ activeAttempt: 0, subtask: { status: "DISPATCHED" } });
      expect(recovered.leases).toHaveLength(1);
      const effects = (await listLedgerEntries(workspace)).filter((entry) =>
        entry.event === "subtask-dispatched" && entry.subtaskRef === subtask.subtaskId && entry.attempt === 0
      );
      expect(effects).toHaveLength(1);
    });
  }

  for (const point of ["after-subtask", "after-ledger"] as const) {
    it(`repairs current-attempt start before Lease use after ${point}`, async () => {
      const { workspace, schemas, task, run } = await setupRun();
      const subtask = await addSubtask(workspace, schemas, run.runId, {
        goal: "Use a bounded read Lease",
        inputArtifactIds: [],
        acceptanceCriteria: ["read completed"],
        scope: ["docs"],
        capabilities: ["repository-read"]
      });
      const dispatched = await dispatchSubtask(workspace, schemas, run.runId, subtask.subtaskId, "activation-worker", 0);
      injectOrchestrationActivationFaultForTesting(workspace, point);
      await expect(beginSubtask(workspace, run.runId, subtask.subtaskId, dispatched.activeAttempt))
        .rejects.toMatchObject({ code: "ORCHESTRATION_ACTIVATION_TEST_FAULT", details: { point } });

      const persisted = await getSubtask(workspace, subtask.subtaskId);
      expect(persisted.status).toBe("RUNNING");
      const lease = (await listLeases(workspace)).find((candidate) => candidate.id === dispatched.leases[0])!;
      await expect(admitAndReserveLeaseCall(workspace, lease.id, {
        taskId: task.id,
        role: lease.role,
        capability: lease.capability
      })).resolves.toMatchObject({ allowed: true });
      await expect(beginSubtask(workspace, run.runId, subtask.subtaskId, dispatched.activeAttempt))
        .resolves.toMatchObject({ status: "RUNNING", activeAttempt: dispatched.activeAttempt });

      const entries = await listLedgerEntries(workspace);
      expect(entries.filter((entry) => entry.event === "subtask-dispatched" && entry.subtaskRef === subtask.subtaskId && entry.attempt === 0)).toHaveLength(1);
      expect(entries.filter((entry) => entry.event === "subtask-started" && entry.subtaskRef === subtask.subtaskId && entry.attempt === 0)).toHaveLength(1);
    });
  }

  for (const point of ["after-run", "after-ledger"] as const) {
    it(`repairs one exact resume generation before further work after ${point}`, async () => {
      const { workspace, schemas, run } = await setupRun();
      await escalateRun(workspace, run.runId, "Human decision required.");
      injectOrchestrationActivationFaultForTesting(workspace, point);
      await expect(resumeRun(workspace, run.runId, { expectedResumeGeneration: 1, maxRounds: 8 }))
        .rejects.toMatchObject({ code: "ORCHESTRATION_ACTIVATION_TEST_FAULT", details: { point } });

      const persisted = await getRun(workspace, run.runId);
      expect(persisted).toMatchObject({ status: "RUNNING", resumeGeneration: 1, resumedBudgetAdjusted: true });
      await addSubtask(workspace, schemas, run.runId, {
        goal: "Continue only after resume audit",
        inputArtifactIds: [],
        acceptanceCriteria: ["continued"],
        scope: ["docs"],
        capabilities: ["repository-read"]
      });
      await expect(resumeRun(workspace, run.runId, { expectedResumeGeneration: 1, maxRounds: 9 }))
        .rejects.toMatchObject({ code: "RUN_RESUME_IDEMPOTENCY_CONFLICT" });
      await expect(resumeRun(workspace, run.runId, { expectedResumeGeneration: 1, maxRounds: 8 }))
        .resolves.toMatchObject({ status: "RUNNING", resumeGeneration: 1 });
      const effects = (await listLedgerEntries(workspace)).filter((entry) =>
        entry.event === "orchestration-resumed" && entry.runRef === run.runId && entry.attempt === 1
      );
      expect(effects).toHaveLength(1);
    });
  }

  it("rejects a delayed dispatch from an older retry generation", async () => {
    const { workspace, schemas, run } = await setupRun();
    const subtask = await addSubtask(workspace, schemas, run.runId, {
      goal: "Retry one bounded document",
      inputArtifactIds: [],
      acceptanceCriteria: ["document is complete"],
      scope: ["docs"],
      capabilities: ["repository-read"]
    });
    const first = await dispatchSubtask(workspace, schemas, run.runId, subtask.subtaskId, "old-worker", 0);
    await beginSubtask(workspace, run.runId, subtask.subtaskId, first.activeAttempt);
    await recordReview(workspace, schemas, run.runId, subtask.subtaskId, {
      decision: "REJECTED",
      criteriaResults: [{ criterion: "document is complete", passed: false, note: "retry" }],
      defects: [{ location: "docs", problem: "incomplete", suggestion: "finish it" }],
      score: 20,
      reason: "Retry required.",
      reviewedBy: "independent-reviewer",
      tokensUsed: 0,
      expectedAttempt: 0
    });
    expect((await listLeases(workspace)).find((lease) => lease.id === first.leases[0])?.status).toBe("revoked");

    await expect(dispatchSubtask(workspace, schemas, run.runId, subtask.subtaskId, "old-worker", 0))
      .rejects.toMatchObject({ code: "SUBTASK_GENERATION_STALE" });
    await expect(dispatchSubtask(workspace, schemas, run.runId, subtask.subtaskId, "new-worker", 1))
      .resolves.toMatchObject({ activeAttempt: 1, subtask: { dispatchedAgentId: "new-worker" } });
  });

  it("repairs a split start before a rejecting review terminates the attempt", async () => {
    const { workspace, schemas, run } = await setupRun();
    const subtask = await addSubtask(workspace, schemas, run.runId, {
      goal: "Review one bounded attempt",
      inputArtifactIds: [],
      acceptanceCriteria: ["attempt is acceptable"],
      scope: ["docs"],
      capabilities: ["repository-read"]
    });
    const dispatched = await dispatchSubtask(workspace, schemas, run.runId, subtask.subtaskId, "activation-worker", 0);
    injectOrchestrationActivationFaultForTesting(workspace, "after-subtask");
    await expect(beginSubtask(workspace, run.runId, subtask.subtaskId, dispatched.activeAttempt))
      .rejects.toMatchObject({ code: "ORCHESTRATION_ACTIVATION_TEST_FAULT" });

    await recordReview(workspace, schemas, run.runId, subtask.subtaskId, {
      decision: "REJECTED",
      criteriaResults: [{ criterion: "attempt is acceptable", passed: false, note: "retry" }],
      defects: [{ location: "docs", problem: "incomplete", suggestion: "retry" }],
      score: 10,
      reason: "Retry required.",
      reviewedBy: "independent-reviewer",
      tokensUsed: 0,
      expectedAttempt: 0
    });
    expect(await getSubtask(workspace, subtask.subtaskId)).toMatchObject({ status: "REJECTED", retriesUsed: 1 });
    const effects = (await listLedgerEntries(workspace)).filter((entry) =>
      entry.event === "subtask-started" && entry.subtaskRef === subtask.subtaskId && entry.attempt === 0
    );
    expect(effects).toHaveLength(1);
  });

  it("repairs Run creation before cancellation records its terminal effect", async () => {
    const { workspace, schemas, contract } = await setupContract();
    injectOrchestrationActivationFaultForTesting(workspace, "after-run");
    await expect(createRun(workspace, schemas, { contractRef: contract.contractId }))
      .rejects.toMatchObject({ code: "ORCHESTRATION_ACTIVATION_TEST_FAULT" });
    const [persisted] = await listRuns(workspace, contract.contractId);
    await cancelRun(workspace, persisted!.runId);
    const effects = (await listLedgerEntries(workspace)).filter((entry) => entry.runRef === persisted!.runId);
    expect(effects.map((entry) => entry.event)).toEqual(["run-created", "orchestration-cancelled"]);
    await expect(createRun(workspace, schemas, { contractRef: contract.contractId }))
      .resolves.toMatchObject({ runId: persisted!.runId, status: "CANCELLED" });
    await expect(createRun(workspace, schemas, {
      contractRef: contract.contractId,
      supersedesRunRef: persisted!.runId
    })).resolves.toMatchObject({ status: "RUNNING", supersedesRunRef: persisted!.runId });
  });

  it("rejects a delayed human resume decision after a later escalation", async () => {
    const { workspace, run } = await setupRun();
    await escalateRun(workspace, run.runId, "First decision required.");
    await resumeRun(workspace, run.runId, { expectedResumeGeneration: 1 });
    await escalateRun(workspace, run.runId, "A distinct second decision is required.");

    await expect(resumeRun(workspace, run.runId, { expectedResumeGeneration: 1 }))
      .rejects.toMatchObject({ code: "RUN_RESUME_GENERATION_STALE" });
    await expect(resumeRun(workspace, run.runId, { expectedResumeGeneration: 2 }))
      .resolves.toMatchObject({ status: "RUNNING", resumeGeneration: 2 });
  });
});
