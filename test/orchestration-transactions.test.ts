import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SchemaRegistry } from "../src/contracts/schema-registry.js";
import { createTask, getTask, saveTask } from "../src/storage/tasks.js";
import { decideApproval } from "../src/storage/approvals.js";
import { initWorkspace, writeWorkspaceJson, type LocalWorkspace } from "../src/storage/workspace.js";
import {
  addSubtask, beginSubtask, completeRound, createContract, createRun, dispatchSubtask,
  cancelRun, getContract, getRun, getSubtask, injectCancellationFaultForTesting, recordReview, reportArtifact
} from "../src/storage/orchestration.js";
import { getRunCancellationFence } from "../src/storage/orchestration-fence.js";
import {
  completionTransactionId, getOrchestrationTransaction,
  injectOrchestrationTransactionFaultForTesting, listOrchestrationTransactions,
  reviewTransactionId, type ReviewTransaction
} from "../src/storage/orchestration-transactions.js";
import { listLedgerEntries } from "../src/storage/ledger.js";
import { approveTaskCapability } from "./helpers/authority.js";

const roots: string[] = [];
const projectRoot = path.resolve(import.meta.dirname, "..");

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setupReviewFixture(options: { approvalRequired?: boolean } = {}): Promise<{
  root: string;
  workspace: LocalWorkspace;
  schemas: SchemaRegistry;
  contractId: string;
  runId: string;
  subtaskId: string;
  attempt: number;
  approvalId?: string;
  reviewInput: Parameters<typeof recordReview>[4];
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "stinky-orch-txn-"));
  roots.push(root);
  const workspace = await initWorkspace(root);
  await mkdir(path.join(root, "docs"));
  const schemas = await SchemaRegistry.create(projectRoot);
  await createTask(workspace, {
    id: "txn-task",
    workspaceId: "txn-workspace",
    goal: "Produce a transaction-safe artifact",
    requestedOutputs: ["document"],
    riskLevel: options.approvalRequired === true ? "L2" : "L0",
    state: "RUNNING",
    scope: ["docs"],
    writeSet: ["docs"]
  });
  const task = await getTask(workspace, "txn-task");
  const approval = options.approvalRequired === true
    ? await approveTaskCapability(workspace, schemas, task, "orchestration-control", ["docs"])
    : undefined;
  if (options.approvalRequired === true) {
    await approveTaskCapability(workspace, schemas, task, "repository-read", ["docs"]);
  }
  const contract = await createContract(workspace, schemas, {
    taskId: "txn-task",
    domain: "compliance",
    goal: "Produce one reviewed document",
    globalAcceptanceCriteria: ["document verified"],
    scope: ["docs"],
    ...(approval === undefined ? {} : { approvalRefs: [approval.id] })
  });
  const run = await createRun(workspace, schemas, { contractRef: contract.contractId });
  const subtask = await addSubtask(workspace, schemas, run.runId, {
    goal: "Produce docs/result.md",
    inputArtifactIds: [],
    acceptanceCriteria: ["document verified"],
    scope: ["docs"],
    capabilities: ["repository-read"]
  });
  const dispatched = await dispatchSubtask(workspace, schemas, run.runId, subtask.subtaskId, "worker-agent", 0);
  await beginSubtask(workspace, run.runId, subtask.subtaskId, dispatched.activeAttempt);
  await writeFile(path.join(root, "docs", "result.md"), "verified bytes\n", "utf8");
  await reportArtifact(workspace, schemas, run.runId, subtask.subtaskId, {
    path: "docs/result.md",
    kind: "file",
    expectedAttempt: dispatched.activeAttempt
  });
  return {
    root,
    workspace,
    schemas,
    contractId: contract.contractId,
    runId: run.runId,
    subtaskId: subtask.subtaskId,
    attempt: dispatched.activeAttempt,
    ...(approval === undefined ? {} : { approvalId: approval.id }),
    reviewInput: {
      decision: "ACCEPTED",
      criteriaResults: [{ criterion: "document verified", passed: true, note: "bytes verified" }],
      defects: [],
      score: 95,
      reason: "independent review passed",
      reviewedBy: "reviewer-agent",
      tokensUsed: 0,
      expectedAttempt: dispatched.activeAttempt
    }
  };
}

describe("journaled orchestration review", () => {
  for (const point of ["after-review", "after-run", "after-ledger-effect"] as const) {
    it(`recovers idempotently after ${point} without duplicate receipts, reviews, state, or ledger`, async () => {
      const fixture = await setupReviewFixture();
      const transactionId = reviewTransactionId(fixture.runId, fixture.subtaskId, fixture.attempt);
      injectOrchestrationTransactionFaultForTesting(fixture.workspace, point);
      await expect(recordReview(
        fixture.workspace, fixture.schemas, fixture.runId, fixture.subtaskId, fixture.reviewInput
      )).rejects.toMatchObject({ code: "ORCHESTRATION_TRANSACTION_TEST_FAULT" });

      const prepared = await getOrchestrationTransaction(fixture.workspace, transactionId) as ReviewTransaction;
      expect(prepared.status).toBe("PREPARED");
      const recovered = await recordReview(
        fixture.workspace, fixture.schemas, fixture.runId, fixture.subtaskId, fixture.reviewInput
      );
      expect(recovered.review.reviewId).toBe(prepared.reviewRef);
      expect(recovered.review.validatorReceiptIds).toEqual(prepared.validatorReceipts.map((receipt) => receipt.receiptId));
      expect(recovered.subtask.status).toBe("ACCEPTED");
      expect((await getOrchestrationTransaction(fixture.workspace, transactionId)).status).toBe("COMMITTED");

      const repeated = await recordReview(
        fixture.workspace, fixture.schemas, fixture.runId, fixture.subtaskId, fixture.reviewInput
      );
      expect(repeated.review.reviewId).toBe(recovered.review.reviewId);
      expect(repeated.review.validatorReceiptIds).toEqual(recovered.review.validatorReceiptIds);
      const ledger = await listLedgerEntries(fixture.workspace);
      expect(ledger.filter((entry) => entry.event === "review-recorded" && entry.reviewRef === recovered.review.reviewId)).toHaveLength(1);
      expect(ledger.filter((entry) => entry.event === "subtask-accepted" && entry.subtaskRef === fixture.subtaskId)).toHaveLength(1);
    });
  }

  it("rejects a conflicting retry for the same run/subtask/attempt generation", async () => {
    const fixture = await setupReviewFixture();
    injectOrchestrationTransactionFaultForTesting(fixture.workspace, "after-prepared");
    await expect(recordReview(
      fixture.workspace, fixture.schemas, fixture.runId, fixture.subtaskId, fixture.reviewInput
    )).rejects.toMatchObject({ code: "ORCHESTRATION_TRANSACTION_TEST_FAULT" });
    await expect(recordReview(fixture.workspace, fixture.schemas, fixture.runId, fixture.subtaskId, {
      ...fixture.reviewInput,
      reason: "different immutable review request"
    })).rejects.toMatchObject({ code: "ORCHESTRATION_TRANSACTION_CONFLICT" });
  });

  it("keeps a PREPARED review fail-closed when artifact bytes change before recovery", async () => {
    const fixture = await setupReviewFixture();
    const transactionId = reviewTransactionId(fixture.runId, fixture.subtaskId, fixture.attempt);
    injectOrchestrationTransactionFaultForTesting(fixture.workspace, "after-prepared");
    await expect(recordReview(
      fixture.workspace, fixture.schemas, fixture.runId, fixture.subtaskId, fixture.reviewInput
    )).rejects.toMatchObject({ code: "ORCHESTRATION_TRANSACTION_TEST_FAULT" });
    await writeFile(path.join(fixture.root, "docs", "result.md"), "changed after prepare\n", "utf8");
    await expect(recordReview(
      fixture.workspace, fixture.schemas, fixture.runId, fixture.subtaskId, fixture.reviewInput
    )).rejects.toMatchObject({ code: "ORCHESTRATION_TRANSACTION_ARTIFACT_STALE" });
    expect((await getOrchestrationTransaction(fixture.workspace, transactionId)).status).toBe("PREPARED");
    expect((await getRun(fixture.workspace, fixture.runId)).reviews).toEqual([]);

    await writeFile(path.join(fixture.root, "docs", "result.md"), "verified bytes\n", "utf8");
    await expect(recordReview(
      fixture.workspace, fixture.schemas, fixture.runId, fixture.subtaskId, fixture.reviewInput
    )).resolves.toMatchObject({ subtask: { status: "ACCEPTED" } });
  });

  it("aborts a PREPARED review before cancelling the Run", async () => {
    const fixture = await setupReviewFixture();
    const transactionId = reviewTransactionId(fixture.runId, fixture.subtaskId, fixture.attempt);
    injectOrchestrationTransactionFaultForTesting(fixture.workspace, "after-prepared");
    await expect(recordReview(
      fixture.workspace, fixture.schemas, fixture.runId, fixture.subtaskId, fixture.reviewInput
    )).rejects.toMatchObject({ code: "ORCHESTRATION_TRANSACTION_TEST_FAULT" });

    await expect(cancelRun(fixture.workspace, fixture.runId)).resolves.toMatchObject({ status: "CANCELLED" });
    expect((await getOrchestrationTransaction(fixture.workspace, transactionId)).status).toBe("ABORTED");
    expect((await getSubtask(fixture.workspace, fixture.subtaskId)).status).toBe("REVIEWING");
  });

  it("commits an already-published review audit before cancellation even when Artifact bytes later drift", async () => {
    const fixture = await setupReviewFixture();
    const transactionId = reviewTransactionId(fixture.runId, fixture.subtaskId, fixture.attempt);
    injectOrchestrationTransactionFaultForTesting(fixture.workspace, "after-run");
    await expect(recordReview(
      fixture.workspace, fixture.schemas, fixture.runId, fixture.subtaskId, fixture.reviewInput
    )).rejects.toMatchObject({ code: "ORCHESTRATION_TRANSACTION_TEST_FAULT" });
    await writeFile(path.join(fixture.root, "docs", "result.md"), "bytes drifted after every mutable target was published\n", "utf8");

    await expect(cancelRun(fixture.workspace, fixture.runId)).resolves.toMatchObject({ status: "CANCELLED" });
    expect((await getOrchestrationTransaction(fixture.workspace, transactionId)).status).toBe("COMMITTED");
    const ledger = await listLedgerEntries(fixture.workspace);
    expect(ledger.filter((entry) => entry.event === "orchestration-cancelled" && entry.runRef === fixture.runId)).toHaveLength(1);
    expect(ledger.filter((entry) => entry.event === "orchestration-transaction-aborted" && entry.runRef === fixture.runId)).toHaveLength(0);
  });

  it("emits one canonical Run cancellation plus one distinct abort event per unfinished transaction", async () => {
    const fixture = await setupReviewFixture();
    injectOrchestrationTransactionFaultForTesting(fixture.workspace, "after-prepared");
    await expect(recordReview(
      fixture.workspace, fixture.schemas, fixture.runId, fixture.subtaskId, fixture.reviewInput
    )).rejects.toMatchObject({ code: "ORCHESTRATION_TRANSACTION_TEST_FAULT" });

    const second = await addSubtask(fixture.workspace, fixture.schemas, fixture.runId, {
      goal: "Produce docs/second.md", inputArtifactIds: [], acceptanceCriteria: ["second verified"],
      scope: ["docs"], capabilities: ["repository-read"]
    });
    const secondDispatch = await dispatchSubtask(fixture.workspace, fixture.schemas, fixture.runId, second.subtaskId, "second-worker", 0);
    await beginSubtask(fixture.workspace, fixture.runId, second.subtaskId, secondDispatch.activeAttempt);
    await writeFile(path.join(fixture.root, "docs", "second.md"), "second bytes\n", "utf8");
    await reportArtifact(fixture.workspace, fixture.schemas, fixture.runId, second.subtaskId, {
      path: "docs/second.md", kind: "file", expectedAttempt: secondDispatch.activeAttempt
    });
    injectOrchestrationTransactionFaultForTesting(fixture.workspace, "after-prepared");
    await expect(recordReview(fixture.workspace, fixture.schemas, fixture.runId, second.subtaskId, {
      decision: "ACCEPTED",
      criteriaResults: [{ criterion: "second verified", passed: true, note: "checked" }],
      defects: [], score: 95, reason: "second review", reviewedBy: "second-reviewer", tokensUsed: 0,
      expectedAttempt: secondDispatch.activeAttempt
    })).rejects.toMatchObject({ code: "ORCHESTRATION_TRANSACTION_TEST_FAULT" });

    await expect(cancelRun(fixture.workspace, fixture.runId)).resolves.toMatchObject({ status: "CANCELLED" });
    const pending = (await listOrchestrationTransactions(fixture.workspace)).filter((transaction) => transaction.runRef === fixture.runId);
    expect(pending).toHaveLength(2);
    expect(pending.every((transaction) => transaction.status === "ABORTED")).toBe(true);
    const ledger = await listLedgerEntries(fixture.workspace);
    expect(ledger.filter((entry) => entry.event === "orchestration-cancelled" && entry.runRef === fixture.runId)).toHaveLength(1);
    expect(ledger.filter((entry) => entry.event === "orchestration-transaction-aborted" && entry.runRef === fixture.runId)).toHaveLength(2);
  });

  it("does not recover a PREPARED review after Task authority drift, but cancellation remains available", async () => {
    const fixture = await setupReviewFixture();
    const transactionId = reviewTransactionId(fixture.runId, fixture.subtaskId, fixture.attempt);
    injectOrchestrationTransactionFaultForTesting(fixture.workspace, "after-prepared");
    await expect(recordReview(
      fixture.workspace, fixture.schemas, fixture.runId, fixture.subtaskId, fixture.reviewInput
    )).rejects.toMatchObject({ code: "ORCHESTRATION_TRANSACTION_TEST_FAULT" });

    const task = await getTask(fixture.workspace, "txn-task");
    await saveTask(fixture.workspace, { ...task, goal: "Changed after transaction prepare" });
    await expect(recordReview(
      fixture.workspace, fixture.schemas, fixture.runId, fixture.subtaskId, fixture.reviewInput
    )).rejects.toMatchObject({ code: "TASK_AUTHORITY_STALE" });
    expect((await getOrchestrationTransaction(fixture.workspace, transactionId)).status).toBe("PREPARED");

    await expect(cancelRun(fixture.workspace, fixture.runId)).resolves.toMatchObject({ status: "CANCELLED" });
    expect((await getOrchestrationTransaction(fixture.workspace, transactionId)).status).toBe("ABORTED");
  });

  it("does not recover a PREPARED review after its precise Contract Approval is revoked", async () => {
    const fixture = await setupReviewFixture({ approvalRequired: true });
    const transactionId = reviewTransactionId(fixture.runId, fixture.subtaskId, fixture.attempt);
    injectOrchestrationTransactionFaultForTesting(fixture.workspace, "after-prepared");
    await expect(recordReview(
      fixture.workspace, fixture.schemas, fixture.runId, fixture.subtaskId, fixture.reviewInput
    )).rejects.toMatchObject({ code: "ORCHESTRATION_TRANSACTION_TEST_FAULT" });

    await decideApproval(fixture.workspace, fixture.schemas, fixture.approvalId!, {
      status: "revoked",
      decidedBy: "security-reviewer",
      reason: "Authority withdrawn before recovery."
    });
    await expect(recordReview(
      fixture.workspace, fixture.schemas, fixture.runId, fixture.subtaskId, fixture.reviewInput
    )).rejects.toMatchObject({ code: "TASK_APPROVAL_INVALID" });
    expect((await getOrchestrationTransaction(fixture.workspace, transactionId)).status).toBe("PREPARED");

    await expect(cancelRun(fixture.workspace, fixture.runId)).resolves.toMatchObject({ status: "CANCELLED" });
    expect((await getOrchestrationTransaction(fixture.workspace, transactionId)).status).toBe("ABORTED");
  });

  it("does not recover a PREPARED review after the Contract delegation budget expires", async () => {
    const fixture = await setupReviewFixture();
    const transactionId = reviewTransactionId(fixture.runId, fixture.subtaskId, fixture.attempt);
    injectOrchestrationTransactionFaultForTesting(fixture.workspace, "after-prepared");
    await expect(recordReview(
      fixture.workspace, fixture.schemas, fixture.runId, fixture.subtaskId, fixture.reviewInput
    )).rejects.toMatchObject({ code: "ORCHESTRATION_TRANSACTION_TEST_FAULT" });

    const expiresAt = (await getContract(fixture.workspace, fixture.contractId)).delegationBudget!.expiresAt;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse(expiresAt) + 1);
    await expect(recordReview(
      fixture.workspace, fixture.schemas, fixture.runId, fixture.subtaskId, fixture.reviewInput
    )).rejects.toMatchObject({ code: "CONTRACT_BUDGET_EXPIRED" });
    expect((await getOrchestrationTransaction(fixture.workspace, transactionId)).status).toBe("PREPARED");

    await expect(cancelRun(fixture.workspace, fixture.runId)).resolves.toMatchObject({ status: "CANCELLED" });
    expect((await getOrchestrationTransaction(fixture.workspace, transactionId)).status).toBe("ABORTED");
  });

  it("recovers a manually staged PREPARED journal whose immutable proof files are absent", async () => {
    const fixture = await setupReviewFixture();
    const completed = await recordReview(
      fixture.workspace, fixture.schemas, fixture.runId, fixture.subtaskId, fixture.reviewInput
    );
    const transactionId = reviewTransactionId(fixture.runId, fixture.subtaskId, fixture.attempt);
    const committed = await getOrchestrationTransaction(fixture.workspace, transactionId) as ReviewTransaction;
    const journalPath = path.join(fixture.workspace.directory, "orchestration", `transaction-${transactionId}.json`);
    const { committedAt: _committedAt, ...withoutCommit } = committed;
    await writeFile(journalPath, `${JSON.stringify({ ...withoutCommit, status: "PREPARED", updatedAt: committed.preparedAt }, null, 2)}\n`, "utf8");
    await unlink(path.join(fixture.workspace.directory, "orchestration", `${committed.reviewRef}.json`));
    for (const receipt of committed.validatorReceipts) {
      await unlink(path.join(fixture.workspace.directory, "orchestration", `${receipt.receiptId}.json`));
    }

    const recovered = await recordReview(
      fixture.workspace, fixture.schemas, fixture.runId, fixture.subtaskId, fixture.reviewInput
    );
    expect(recovered.review.reviewId).toBe(completed.review.reviewId);
    expect((await getOrchestrationTransaction(fixture.workspace, transactionId)).status).toBe("COMMITTED");
    await expect(readFile(path.join(fixture.workspace.directory, "orchestration", `${committed.reviewRef}.json`), "utf8")).resolves.toContain(committed.reviewRef);
  });

  it("schema-validates journals and binds the embedded transaction ID on get and list", async () => {
    const fixture = await setupReviewFixture();
    await recordReview(fixture.workspace, fixture.schemas, fixture.runId, fixture.subtaskId, fixture.reviewInput);
    const transactionId = reviewTransactionId(fixture.runId, fixture.subtaskId, fixture.attempt);
    const journalPath = path.join(fixture.workspace.directory, "orchestration", `transaction-${transactionId}.json`);
    const stored = JSON.parse(await readFile(journalPath, "utf8")) as Record<string, unknown>;

    await writeFile(journalPath, `${JSON.stringify({ ...stored, callerInjected: true })}\n`, "utf8");
    await expect(getOrchestrationTransaction(fixture.workspace, transactionId))
      .rejects.toMatchObject({ code: "SCHEMA_INVALID", details: { kind: "orchestration-transaction" } });
    await expect(listOrchestrationTransactions(fixture.workspace))
      .rejects.toMatchObject({ code: "SCHEMA_INVALID", details: { kind: "orchestration-transaction" } });

    await writeFile(journalPath, `${JSON.stringify({ ...stored, transactionId: `${transactionId}-other` })}\n`, "utf8");
    await expect(getOrchestrationTransaction(fixture.workspace, transactionId))
      .rejects.toMatchObject({ code: "ORCHESTRATION_TRANSACTION_ID_MISMATCH" });
    await expect(listOrchestrationTransactions(fixture.workspace))
      .rejects.toMatchObject({ code: "ORCHESTRATION_TRANSACTION_ID_MISMATCH" });
  });
});

describe("journaled orchestration cancellation", () => {
  for (const point of ["after-run", "after-ledger"] as const) {
    it(`repairs cancellation exactly once after ${point}`, async () => {
      const fixture = await setupReviewFixture();
      injectCancellationFaultForTesting(fixture.workspace, point);
      await expect(cancelRun(fixture.workspace, fixture.runId))
        .rejects.toMatchObject({ code: "ORCHESTRATION_CANCELLATION_TEST_FAULT" });

      expect((await getRun(fixture.workspace, fixture.runId)).status).toBe("CANCELLED");
      expect((await getRunCancellationFence(fixture.workspace, fixture.runId))?.status).toBe("CANCELLING");
      await expect(cancelRun(fixture.workspace, fixture.runId)).resolves.toMatchObject({ status: "CANCELLED" });
      expect((await getRunCancellationFence(fixture.workspace, fixture.runId))?.status).toBe("CANCELLED");

      const ledger = await listLedgerEntries(fixture.workspace);
      expect(ledger.filter((entry) => entry.event === "orchestration-cancelled" && entry.runRef === fixture.runId)).toHaveLength(1);
    });
  }
});

describe("journaled orchestration completion", () => {
  it("does not replay a COMMITTED historical round over a later cancelled Run", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "stinky-orch-successor-"));
    roots.push(root);
    const workspace = await initWorkspace(root);
    await mkdir(path.join(root, "docs"));
    const schemas = await SchemaRegistry.create(projectRoot);
    await createTask(workspace, {
      id: "successor-task", workspaceId: "successor-workspace", goal: "Run multiple rounds",
      requestedOutputs: ["document"], riskLevel: "L0", state: "RUNNING", scope: ["docs"], writeSet: ["docs"]
    });
    const contract = await createContract(workspace, schemas, {
      taskId: "successor-task", domain: "compliance", goal: "Eventually cover one criterion",
      globalAcceptanceCriteria: ["future artifact accepted"], scope: ["docs"]
    });
    const first = await createRun(workspace, schemas, { contractRef: contract.contractId });
    await expect(completeRound(workspace, first.runId, { passed: true, note: "No accepted output yet" }))
      .resolves.toMatchObject({ status: "RUNNING", round: 1 });
    expect((await getOrchestrationTransaction(workspace, completionTransactionId(first.runId, 0))).status).toBe("COMMITTED");
    await expect(cancelRun(workspace, first.runId)).resolves.toMatchObject({ status: "CANCELLED" });

    const successor = await createRun(workspace, schemas, { contractRef: contract.contractId, supersedesRunRef: first.runId });
    expect(successor.runId).not.toBe(first.runId);
    expect(successor.status).toBe("RUNNING");
    expect((await getRun(workspace, first.runId)).status).toBe("CANCELLED");
  });

  it("recovers a Contract-first split and appends each completion ledger effect once", async () => {
    const fixture = await setupReviewFixture();
    await recordReview(fixture.workspace, fixture.schemas, fixture.runId, fixture.subtaskId, fixture.reviewInput);
    injectOrchestrationTransactionFaultForTesting(fixture.workspace, "after-contract");
    await expect(completeRound(fixture.workspace, fixture.runId, { passed: true, note: "final consistency" }))
      .rejects.toMatchObject({ code: "ORCHESTRATION_TRANSACTION_TEST_FAULT" });
    expect((await getContract(fixture.workspace, fixture.contractId)).status).toBe("COMPLETED");
    expect((await getRun(fixture.workspace, fixture.runId)).status).toBe("RUNNING");

    const recovered = await completeRound(fixture.workspace, fixture.runId, { passed: true, note: "final consistency" });
    expect(recovered.status).toBe("COMPLETED");
    expect((await getContract(fixture.workspace, fixture.contractId)).status).toBe("COMPLETED");
    const transaction = await getOrchestrationTransaction(fixture.workspace, completionTransactionId(fixture.runId, 0));
    expect(transaction.status).toBe("COMMITTED");
    const ledger = await listLedgerEntries(fixture.workspace);
    expect(ledger.filter((entry) => entry.event === "round-completed" && entry.runRef === fixture.runId)).toHaveLength(1);
    expect(ledger.filter((entry) => entry.event === "orchestration-completed" && entry.runRef === fixture.runId)).toHaveLength(1);
  });

  it("finishes audit repair after all terminal targets were written even if Task authority later drifts", async () => {
    const fixture = await setupReviewFixture();
    await recordReview(fixture.workspace, fixture.schemas, fixture.runId, fixture.subtaskId, fixture.reviewInput);
    const transactionId = completionTransactionId(fixture.runId, 0);
    injectOrchestrationTransactionFaultForTesting(fixture.workspace, "after-run");
    await expect(completeRound(fixture.workspace, fixture.runId, { passed: true, note: "final consistency" }))
      .rejects.toMatchObject({ code: "ORCHESTRATION_TRANSACTION_TEST_FAULT" });
    expect((await getRun(fixture.workspace, fixture.runId)).status).toBe("COMPLETED");
    expect((await getContract(fixture.workspace, fixture.contractId)).status).toBe("COMPLETED");
    expect((await getOrchestrationTransaction(fixture.workspace, transactionId)).status).toBe("PREPARED");

    const task = await getTask(fixture.workspace, "txn-task");
    await saveTask(fixture.workspace, { ...task, goal: "Changed after terminal targets were published" });
    await writeFile(path.join(fixture.root, "docs", "result.md"), "changed after terminal targets were published\n", "utf8");
    await expect(cancelRun(fixture.workspace, fixture.runId)).resolves.toMatchObject({ status: "COMPLETED" });
    expect((await getOrchestrationTransaction(fixture.workspace, transactionId)).status).toBe("COMMITTED");
    const ledger = await listLedgerEntries(fixture.workspace);
    expect(ledger.filter((entry) => entry.event === "orchestration-completed" && entry.runRef === fixture.runId)).toHaveLength(1);
  });

  it("lets createRun reconcile an unfinished completion, then fails closed on the completed Contract", async () => {
    const fixture = await setupReviewFixture();
    await recordReview(fixture.workspace, fixture.schemas, fixture.runId, fixture.subtaskId, fixture.reviewInput);
    injectOrchestrationTransactionFaultForTesting(fixture.workspace, "after-prepared");
    await expect(completeRound(fixture.workspace, fixture.runId, { passed: true, note: "final consistency" }))
      .rejects.toMatchObject({ code: "ORCHESTRATION_TRANSACTION_TEST_FAULT" });
    expect((await getRun(fixture.workspace, fixture.runId)).status).toBe("RUNNING");
    expect((await getContract(fixture.workspace, fixture.contractId)).status).toBe("ACTIVE");

    await expect(createRun(fixture.workspace, fixture.schemas, { contractRef: fixture.contractId, supersedesRunRef: fixture.runId }))
      .rejects.toMatchObject({ code: "CONTRACT_NOT_ACTIVE" });
    expect((await getRun(fixture.workspace, fixture.runId)).status).toBe("COMPLETED");
    expect((await getContract(fixture.workspace, fixture.contractId)).status).toBe("COMPLETED");
    expect((await getOrchestrationTransaction(fixture.workspace, completionTransactionId(fixture.runId, 0))).status).toBe("COMMITTED");
  });

  it("does not reconcile a prepared terminal completion after accepted artifact bytes drift", async () => {
    const fixture = await setupReviewFixture();
    await recordReview(fixture.workspace, fixture.schemas, fixture.runId, fixture.subtaskId, fixture.reviewInput);
    injectOrchestrationTransactionFaultForTesting(fixture.workspace, "after-prepared");
    await expect(completeRound(fixture.workspace, fixture.runId, { passed: true, note: "final consistency" }))
      .rejects.toMatchObject({ code: "ORCHESTRATION_TRANSACTION_TEST_FAULT" });
    await writeFile(path.join(fixture.root, "docs", "result.md"), "drift after completion prepare\n", "utf8");
    await expect(createRun(fixture.workspace, fixture.schemas, { contractRef: fixture.contractId, supersedesRunRef: fixture.runId }))
      .rejects.toMatchObject({ code: "ORCHESTRATION_TRANSACTION_ARTIFACT_STALE" });
    expect((await getRun(fixture.workspace, fixture.runId)).status).toBe("RUNNING");
    expect((await getContract(fixture.workspace, fixture.contractId)).status).toBe("ACTIVE");

    await writeFile(path.join(fixture.root, "docs", "result.md"), "verified bytes\n", "utf8");
    await expect(createRun(fixture.workspace, fixture.schemas, { contractRef: fixture.contractId, supersedesRunRef: fixture.runId }))
      .rejects.toMatchObject({ code: "CONTRACT_NOT_ACTIVE" });
    expect((await getRun(fixture.workspace, fixture.runId)).status).toBe("COMPLETED");
  });

  it("refuses completion recovery when a bound validator receipt disappears", async () => {
    const fixture = await setupReviewFixture();
    await recordReview(fixture.workspace, fixture.schemas, fixture.runId, fixture.subtaskId, fixture.reviewInput);
    const reviewTransaction = await getOrchestrationTransaction(
      fixture.workspace,
      reviewTransactionId(fixture.runId, fixture.subtaskId, fixture.attempt)
    ) as ReviewTransaction;
    injectOrchestrationTransactionFaultForTesting(fixture.workspace, "after-prepared");
    await expect(completeRound(fixture.workspace, fixture.runId, { passed: true, note: "final consistency" }))
      .rejects.toMatchObject({ code: "ORCHESTRATION_TRANSACTION_TEST_FAULT" });

    const receipt = reviewTransaction.validatorReceipts[0]!;
    const receiptPath = path.join(fixture.workspace.directory, "orchestration", `${receipt.receiptId}.json`);
    await unlink(receiptPath);
    await expect(completeRound(fixture.workspace, fixture.runId, { passed: true, note: "final consistency" }))
      .rejects.toMatchObject({ code: "VALIDATOR_RECEIPT_NOT_FOUND" });
    expect((await getRun(fixture.workspace, fixture.runId)).status).toBe("RUNNING");
    expect((await getContract(fixture.workspace, fixture.contractId)).status).toBe("ACTIVE");

    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    await expect(completeRound(fixture.workspace, fixture.runId, { passed: true, note: "final consistency" }))
      .resolves.toMatchObject({ status: "COMPLETED" });
  });

  it("refuses completion recovery when a bound validator receipt is corrupted", async () => {
    const fixture = await setupReviewFixture();
    await recordReview(fixture.workspace, fixture.schemas, fixture.runId, fixture.subtaskId, fixture.reviewInput);
    const reviewTransaction = await getOrchestrationTransaction(
      fixture.workspace,
      reviewTransactionId(fixture.runId, fixture.subtaskId, fixture.attempt)
    ) as ReviewTransaction;
    injectOrchestrationTransactionFaultForTesting(fixture.workspace, "after-prepared");
    await expect(completeRound(fixture.workspace, fixture.runId, { passed: true, note: "final consistency" }))
      .rejects.toMatchObject({ code: "ORCHESTRATION_TRANSACTION_TEST_FAULT" });

    const receipt = reviewTransaction.validatorReceipts[0]!;
    const receiptPath = path.join(fixture.workspace.directory, "orchestration", `${receipt.receiptId}.json`);
    await writeFile(receiptPath, `${JSON.stringify({ ...receipt, status: "FAILED" }, null, 2)}\n`, "utf8");
    await expect(completeRound(fixture.workspace, fixture.runId, { passed: true, note: "final consistency" }))
      .rejects.toMatchObject({ code: "ORCHESTRATION_TRANSACTION_RECEIPT_CONFLICT" });
    expect((await getRun(fixture.workspace, fixture.runId)).status).toBe("RUNNING");
    expect((await getContract(fixture.workspace, fixture.contractId)).status).toBe("ACTIVE");
  });

  it("fails closed when a legacy/manual COMPLETED Run has no recoverable completion transaction", async () => {
    const fixture = await setupReviewFixture();
    const run = await getRun(fixture.workspace, fixture.runId);
    await writeWorkspaceJson(fixture.workspace, path.join("orchestration", `${fixture.runId}.json`), {
      ...run,
      status: "COMPLETED",
      completedAt: new Date().toISOString()
    });
    await expect(createRun(fixture.workspace, fixture.schemas, { contractRef: fixture.contractId, supersedesRunRef: fixture.runId }))
      .rejects.toMatchObject({ code: "ORCHESTRATION_COMPLETION_SPLIT" });
    expect((await getContract(fixture.workspace, fixture.contractId)).status).toBe("ACTIVE");
  });
});
