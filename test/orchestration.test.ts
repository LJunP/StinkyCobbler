import { afterEach, describe, expect, it } from "vitest";
import { link, mkdir, mkdtemp, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { SchemaRegistry } from "../src/contracts/schema-registry.js";
import { MAX_SUBTASK_ARTIFACTS } from "../src/contracts/orchestration.js";
import { createTask, saveTask } from "../src/storage/tasks.js";
import { decideApproval, getApproval, requestApproval } from "../src/storage/approvals.js";
import { hashTaskAuthority, TASK_AUTHORITY_POLICY_VERSION } from "../src/storage/task-authority.js";
import { initWorkspace } from "../src/storage/workspace.js";
import {
  createContract, getContract, injectContractCreationFaultForTesting, injectContractStatusFaultForTesting, listContracts, recommendExecutionMode, createRun, getRun, listRuns,
  addSubtask, getSubtask, dispatchSubtask as dispatchSubtaskStorage, beginSubtask as beginSubtaskStorage,
  reportArtifact as reportArtifactStorage, getArtifact, injectArtifactReportingFaultForTesting,
  recordReview as recordReviewStorage, getReview, completeRound, escalateRun, resumeRun, cancelRun, updateContractStatus, estimateRunCost
} from "../src/storage/orchestration.js";
import { getValidatorReceipt } from "../src/storage/orchestration-validator-receipts.js";
import { getRunCancellationFence } from "../src/storage/orchestration-fence.js";
import { listLedgerEntries } from "../src/storage/ledger.js";
import { injectLeaseIssuanceFaultForTesting, listLeases } from "../src/storage/leases.js";
import { transitionTask } from "../src/storage/task-transitions.js";
import { approveTaskCapability, approveWriteIntent } from "./helpers/authority.js";

const roots: string[] = [];
const projectRoot = path.resolve(import.meta.dirname, "..");
const GLOBAL_CRITERIA = ["docs exist", "no sensitive data", "structure correct", "consistency with code"];
const execFileAsync = promisify(execFile);
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function setup(profile?: "individual" | "team" | "organization" | "regulated") {
  const root = await mkdtemp(path.join(os.tmpdir(), "stinky-orch-"));
  roots.push(root);
  const workspace = await initWorkspace(root);
  await mkdir(path.join(root, "docs"), { recursive: true });
  const task = {
    id: "orch-task", workspaceId: "workspace-1", goal: "Build docs", requestedOutputs: ["document"],
    riskLevel: "L0" as const, state: "RUNNING" as const, scope: ["docs"], writeSet: ["docs"]
  };
  await createTask(workspace, task);
  const schemas = await SchemaRegistry.create(projectRoot);
  if (profile !== undefined) {
    await writeFile(path.join(workspace.directory, "workspace.json"), JSON.stringify({
      version: 2,
      workspaceId: `workspace-${profile}`,
      root: workspace.root,
      profile,
      packs: [profile === "regulated" ? "regulated-work" : "software-engineering"],
      mode: "reviewed-workflow",
      roles: {},
      plugins: {}
    }), "utf8");
  }
  const expiresAt = "2099-01-01T00:00:00.000Z";
  for (const [index, scope] of [
    // Exact repository-write grants are intentionally one-shot. Rework tests
    // exercise multiple dispatch generations, so each generation receives a
    // distinct human grant instead of reusing a consumed Approval.
    ["docs"], ["docs"], ["docs"], ["docs"],
    ["docs/a"], ["docs/a/nested"], ["docs/b"],
    ["docs/existing.md"], ["docs/pending.md"], ["docs/cancelled.md"], ["docs/after-cancel.md"]
  ].entries()) {
    const requested = await requestApproval(workspace, schemas, {
      taskId: task.id,
      action: "delegate-capability",
      scope,
      subjectKind: "task-authority",
      subjectId: task.id,
      subjectVersion: 1,
      subjectHash: hashTaskAuthority(task),
      capability: "repository-write",
      budget: { maxToolCalls: 1000, expiresAt },
      policyVersion: TASK_AUTHORITY_POLICY_VERSION,
      requestedBy: "orchestration-test-host",
      nonce: `orchestration-test-grant-${index}`,
      expiresAt,
      reason: "Authorize the exact orchestration test write scope."
    });
    await decideApproval(workspace, schemas, requested.id, { status: "approved", decidedBy: "orchestration-test-host", reason: "Approved for test." });
  }
  const contract = await createContract(workspace, schemas, {
    taskId: "orch-task",
    domain: "compliance",
    goal: "Produce project documentation",
    globalAcceptanceCriteria: GLOBAL_CRITERIA,
    scope: ["docs"]
  });
  const run = await createRun(workspace, schemas, { contractRef: contract.contractId });
  return { workspace, schemas, contract, run, root, task };
}

function reviewInput(decision: "ACCEPTED" | "REJECTED", score: number, defects: { location: string; problem: string; suggestion: string }[] = [], reason = "reviewed", criteria: string[] = ["guide.md exists"]) {
  return {
    decision,
    criteriaResults: criteria.map((criterion) => ({ criterion, passed: decision === "ACCEPTED", note: "checked" })),
    defects,
    score,
    reason,
    validatorEvidence: [{ validator: "contentHash", passed: true, detail: "hash ok" }],
    reviewedBy: "host",
    tokensUsed: 0
  };
}

async function dispatchSubtask(
  workspace: Parameters<typeof dispatchSubtaskStorage>[0],
  schemas: Parameters<typeof dispatchSubtaskStorage>[1],
  runId: string,
  subtaskId: string,
  agentId: string,
  expectedAttempt = 0
) {
  return dispatchSubtaskStorage(workspace, schemas, runId, subtaskId, agentId, expectedAttempt);
}

async function currentAttempt(
  workspace: Parameters<typeof getSubtask>[0],
  subtaskId: string
): Promise<number> {
  const attempt = (await getSubtask(workspace, subtaskId)).activeAttempt;
  if (!Number.isSafeInteger(attempt)) throw new Error(`Subtask ${subtaskId} has no active attempt token.`);
  return attempt!;
}

async function beginCurrentAttemptForTest(
  workspace: Parameters<typeof beginSubtaskStorage>[0],
  runId: string,
  subtaskId: string,
  expectedAttempt?: number
) {
  return beginSubtaskStorage(workspace, runId, subtaskId, expectedAttempt ?? await currentAttempt(workspace, subtaskId));
}

type TestReportArtifactInput = Omit<Parameters<typeof reportArtifactStorage>[4], "expectedAttempt"> & { expectedAttempt?: number };
async function reportCurrentArtifactForTest(
  workspace: Parameters<typeof reportArtifactStorage>[0],
  schemas: Parameters<typeof reportArtifactStorage>[1],
  runId: string,
  subtaskId: string,
  input: TestReportArtifactInput
) {
  const expectedAttempt = input.expectedAttempt ?? await currentAttempt(workspace, subtaskId);
  return reportArtifactStorage(workspace, schemas, runId, subtaskId, { ...input, expectedAttempt });
}

type TestRecordReviewInput = Omit<Parameters<typeof recordReviewStorage>[4], "expectedAttempt"> & { expectedAttempt?: number };
async function recordCurrentReviewForTest(
  workspace: Parameters<typeof recordReviewStorage>[0],
  schemas: Parameters<typeof recordReviewStorage>[1],
  runId: string,
  subtaskId: string,
  input: TestRecordReviewInput
) {
  const expectedAttempt = input.expectedAttempt ?? await currentAttempt(workspace, subtaskId);
  return recordReviewStorage(workspace, schemas, runId, subtaskId, { ...input, expectedAttempt });
}

interface CanonicalReadCase {
  kind: string;
  id: string;
  idField: string;
  mismatchCode: string;
  get: () => Promise<unknown>;
  list?: () => Promise<unknown>;
}

async function createCanonicalReadCases(): Promise<{ workspace: Awaited<ReturnType<typeof initWorkspace>>; cases: CanonicalReadCase[] }> {
  const { workspace, schemas, contract, run } = await setup();
  const subtask = await addSubtask(workspace, schemas, run.runId, {
    goal: "Create canonical read fixture", inputArtifactIds: [], acceptanceCriteria: ["checked"],
    scope: ["docs"], capabilities: ["repository-read"]
  });
  await dispatchSubtask(workspace, schemas, run.runId, subtask.subtaskId, "fixture-worker");
  await beginCurrentAttemptForTest(workspace, run.runId, subtask.subtaskId);
  await writeFile(path.join(workspace.root, "docs", "canonical-read.md"), "canonical bytes\n", "utf8");
  const artifact = await reportCurrentArtifactForTest(workspace, schemas, run.runId, subtask.subtaskId, {
    path: "docs/canonical-read.md", kind: "file"
  });
  const reviewed = await recordCurrentReviewForTest(workspace, schemas, run.runId, subtask.subtaskId,
    reviewInput("ACCEPTED", 90, [], "canonical fixture accepted", ["checked"]));
  const receiptId = reviewed.review.validatorReceiptIds[0]!;
  return {
    workspace,
    cases: [
      {
        kind: "orchestration-contract", id: contract.contractId, idField: "contractId", mismatchCode: "CONTRACT_ID_MISMATCH",
        get: () => getContract(workspace, contract.contractId), list: () => listContracts(workspace)
      },
      {
        kind: "orchestration-run", id: run.runId, idField: "runId", mismatchCode: "RUN_ID_MISMATCH",
        get: () => getRun(workspace, run.runId), list: () => listRuns(workspace)
      },
      {
        kind: "orchestration-subtask", id: subtask.subtaskId, idField: "subtaskId", mismatchCode: "SUBTASK_ID_MISMATCH",
        get: () => getSubtask(workspace, subtask.subtaskId)
      },
      {
        kind: "orchestration-artifact", id: artifact.artifactId, idField: "artifactId", mismatchCode: "ARTIFACT_ID_MISMATCH",
        get: () => getArtifact(workspace, artifact.artifactId)
      },
      {
        kind: "orchestration-review", id: reviewed.review.reviewId, idField: "reviewId", mismatchCode: "REVIEW_ID_MISMATCH",
        get: () => getReview(workspace, reviewed.review.reviewId)
      },
      {
        kind: "orchestration-validator-receipt", id: receiptId, idField: "receiptId", mismatchCode: "VALIDATOR_RECEIPT_ID_MISMATCH",
        get: () => getValidatorReceipt(workspace, receiptId)
      }
    ]
  };
}

describe("canonical orchestration read boundary", () => {
  it("schema-validates every ordinary getter and every available list path", async () => {
    const { workspace, cases } = await createCanonicalReadCases();
    for (const readCase of cases) {
      const storedPath = path.join(workspace.directory, "orchestration", `${readCase.id}.json`);
      const stored = JSON.parse(await readFile(storedPath, "utf8")) as Record<string, unknown>;
      await writeFile(storedPath, `${JSON.stringify({ ...stored, callerInjectedPassingState: true }, null, 2)}\n`, "utf8");
      await expect(readCase.get()).rejects.toMatchObject({ code: "SCHEMA_INVALID", details: { kind: readCase.kind } });
      if (readCase.list !== undefined) {
        await expect(readCase.list()).rejects.toMatchObject({ code: "SCHEMA_INVALID", details: { kind: readCase.kind } });
      }
      await writeFile(storedPath, `${JSON.stringify(stored, null, 2)}\n`, "utf8");
    }
  });

  it("rejects records whose embedded ID differs from the canonical lookup ID", async () => {
    const { workspace, cases } = await createCanonicalReadCases();
    for (const readCase of cases) {
      const storedPath = path.join(workspace.directory, "orchestration", `${readCase.id}.json`);
      const stored = JSON.parse(await readFile(storedPath, "utf8")) as Record<string, unknown>;
      await writeFile(storedPath, `${JSON.stringify({ ...stored, [readCase.idField]: `${readCase.id}-tampered` }, null, 2)}\n`, "utf8");
      await expect(readCase.get()).rejects.toMatchObject({ code: readCase.mismatchCode });
      if (readCase.list !== undefined) {
        await expect(readCase.list()).rejects.toMatchObject({ code: readCase.mismatchCode });
      }
      await writeFile(storedPath, `${JSON.stringify(stored, null, 2)}\n`, "utf8");
    }
  });
});

describe("canonical cancellation-fence read boundary", () => {
  it("schema-validates status timestamps and binds the embedded runId to the filename", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "stinky-fence-read-"));
    roots.push(root);
    const workspace = await initWorkspace(root);
    const runId = "run-fence-1";
    const directory = path.join(workspace.directory, "orchestration-cancellations");
    const target = path.join(directory, `${runId}.cancellation.json`);
    await mkdir(directory);
    const requestedAt = "2026-01-01T00:00:00.000Z";

    for (const invalid of [
      { version: 1, runId, status: "CANCELLED", requestedAt },
      { version: 1, runId, status: "CANCELLING", requestedAt, completedAt: requestedAt },
      { version: 1, runId, status: "CANCELLING", requestedAt, callerInjected: true }
    ]) {
      await writeFile(target, JSON.stringify(invalid), "utf8");
      await expect(getRunCancellationFence(workspace, runId))
        .rejects.toMatchObject({ code: "SCHEMA_INVALID", details: { kind: "cancellation-fence" } });
    }

    await writeFile(target, JSON.stringify({ version: 1, runId: "run-other", status: "CANCELLING", requestedAt }), "utf8");
    await expect(getRunCancellationFence(workspace, runId)).rejects.toThrow(/filename run ID/);
  });
});

describe("orchestration loop (storage)", () => {
  it("persists a central Task-authority snapshot on every new Contract", async () => {
    const { contract, task } = await setup();
    expect(contract).toMatchObject({
      taskAuthorityHash: hashTaskAuthority(task),
      approvalRefs: [],
      policyVersion: TASK_AUTHORITY_POLICY_VERSION,
      hostSessionId: "local-cli"
    });
  });

  for (const point of ["after-consume", "after-contract", "after-ledger"] as const) {
    it(`repairs precise Approval-backed Contract creation exactly once after ${point}`, async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "stinky-contract-recovery-"));
      roots.push(root);
      const workspace = await initWorkspace(root);
      await mkdir(path.join(root, "docs"));
      const schemas = await SchemaRegistry.create(projectRoot);
      const task = {
        id: "contract-recovery-task", workspaceId: "workspace-1", goal: "Create one durable Contract",
        requestedOutputs: ["document"], riskLevel: "L2" as const, state: "RUNNING" as const,
        scope: ["docs"], writeSet: ["docs"]
      };
      await createTask(workspace, task);
      const approval = await approveTaskCapability(workspace, schemas, task, "orchestration-control", ["docs"]);
      const input = {
        taskId: task.id, domain: "compliance", goal: "Produce controlled documentation",
        globalAcceptanceCriteria: ["document verified"], scope: ["docs"], approvalRefs: [approval.id]
      };
      injectContractCreationFaultForTesting(workspace, point);
      await expect(createContract(workspace, schemas, input)).rejects.toMatchObject({ code: "CONTRACT_CREATION_TEST_FAULT" });

      const recovered = await createContract(workspace, schemas, input);
      expect(await createContract(workspace, schemas, input)).toEqual(recovered);
      await expect(getApproval(workspace, approval.id)).resolves.toMatchObject({ consumedBy: recovered.contractId });
      expect(await listContracts(workspace)).toEqual([recovered]);
      const entries = (await listLedgerEntries(workspace)).filter((entry) => entry.event === "contract-created" && entry.contractRef === recovered.contractId);
      expect(entries).toHaveLength(1);
    });
  }

  it("repairs only Contract creation audit after the Contract write even when Task authority and Approval later drift", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "stinky-contract-audit-only-"));
    roots.push(root);
    const workspace = await initWorkspace(root);
    await mkdir(path.join(root, "docs"));
    const schemas = await SchemaRegistry.create(projectRoot);
    const task = {
      id: "contract-audit-task", workspaceId: "workspace-1", goal: "Create one durable Contract",
      requestedOutputs: ["document"], riskLevel: "L2" as const, state: "RUNNING" as const,
      scope: ["docs"], writeSet: ["docs"]
    };
    await createTask(workspace, task);
    const approval = await approveTaskCapability(workspace, schemas, task, "orchestration-control", ["docs"]);
    const input = {
      taskId: task.id, domain: "compliance", goal: "Produce controlled documentation",
      globalAcceptanceCriteria: ["document verified"], scope: ["docs"], approvalRefs: [approval.id]
    };
    injectContractCreationFaultForTesting(workspace, "after-contract");
    await expect(createContract(workspace, schemas, input)).rejects.toMatchObject({ code: "CONTRACT_CREATION_TEST_FAULT" });
    await decideApproval(workspace, schemas, approval.id, { status: "revoked", decidedBy: "security-reviewer", reason: "Revoked after Contract commit." });
    await saveTask(workspace, { ...task, goal: "Authority changed after Contract commit" });

    const recovered = await createContract(workspace, schemas, input);
    expect(recovered.status).toBe("ACTIVE");
    const entries = (await listLedgerEntries(workspace)).filter((entry) => entry.event === "contract-created" && entry.contractRef === recovered.contractId);
    expect(entries).toHaveLength(1);
  });

  it("repairs a direct Contract terminal ledger split exactly once", async () => {
    const { workspace, schemas, contract, run } = await setup();
    await cancelRun(workspace, run.runId);
    injectContractStatusFaultForTesting(workspace, "after-contract");
    await expect(updateContractStatus(workspace, schemas, contract.contractId, "CANCELLED"))
      .rejects.toMatchObject({ code: "CONTRACT_STATUS_TEST_FAULT" });
    await expect(updateContractStatus(workspace, schemas, contract.contractId, "CANCELLED"))
      .resolves.toMatchObject({ status: "CANCELLED" });
    await expect(updateContractStatus(workspace, schemas, contract.contractId, "CANCELLED"))
      .resolves.toMatchObject({ status: "CANCELLED" });
    const entries = (await listLedgerEntries(workspace)).filter((entry) =>
      entry.event === "orchestration-cancelled" && entry.contractRef === contract.contractId && entry.runRef === undefined
    );
    expect(entries).toHaveLength(1);
  });

  it("denies Contract creation for a DRAFT Task", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "stinky-orch-draft-"));
    roots.push(root);
    const workspace = await initWorkspace(root);
    await createTask(workspace, {
      id: "draft-task", workspaceId: "workspace-1", goal: "Draft only", requestedOutputs: ["document"],
      riskLevel: "L0", state: "DRAFT", scope: ["docs"]
    });
    const schemas = await SchemaRegistry.create(projectRoot);

    await expect(createContract(workspace, schemas, {
      taskId: "draft-task", domain: "general", goal: "must not execute",
      globalAcceptanceCriteria: ["bounded"], scope: ["docs"]
    })).rejects.toMatchObject({ code: "TASK_STATE_DENIED" });
  });

  it("blocks Run creation when the Contract Task-authority snapshot is stale", async () => {
    const { workspace, schemas, task } = await setup();
    const contract = await createContract(workspace, schemas, {
      taskId: task.id, domain: "general", goal: "stale run",
      globalAcceptanceCriteria: ["bounded"], scope: ["docs"]
    });
    await saveTask(workspace, { ...task, constraints: ["new persisted constraint"] });

    await expect(createRun(workspace, schemas, { contractRef: contract.contractId }))
      .rejects.toMatchObject({ code: "TASK_AUTHORITY_STALE" });
  });

  it("blocks dispatch when Task authority changes after Run creation", async () => {
    const { workspace, schemas, run, task } = await setup();
    const subtask = await addSubtask(workspace, schemas, run.runId, {
      goal: "read docs", inputArtifactIds: [], acceptanceCriteria: ["bounded"],
      scope: ["docs"], capabilities: ["repository-read"]
    });
    await saveTask(workspace, { ...task, constraints: ["new persisted constraint"] });

    await expect(dispatchSubtask(workspace, schemas, run.runId, subtask.subtaskId, "worker"))
      .rejects.toMatchObject({ code: "TASK_AUTHORITY_STALE" });
  });

  it("revokes a same-generation partial Lease when redispatch changes the intended agent", async () => {
    const { workspace, schemas, run } = await setup();
    const subtask = await addSubtask(workspace, schemas, run.runId, {
      goal: "read docs", inputArtifactIds: [], acceptanceCriteria: ["bounded"],
      scope: ["docs"], capabilities: ["repository-read"]
    });
    injectLeaseIssuanceFaultForTesting(workspace, "after-lease");
    await expect(dispatchSubtask(workspace, schemas, run.runId, subtask.subtaskId, "worker-old"))
      .rejects.toMatchObject({ code: "LEASE_ISSUANCE_TEST_FAULT" });
    const [orphan] = (await listLeases(workspace)).filter((lease) => lease.subtaskRef === subtask.subtaskId);
    expect(orphan).toMatchObject({ status: "active", agentId: "worker-old", subtaskAttempt: 0 });

    const dispatched = await dispatchSubtask(workspace, schemas, run.runId, subtask.subtaskId, "worker-new");
    expect(dispatched.leases).toHaveLength(1);
    expect(dispatched.leases[0]).not.toBe(orphan!.id);
    const all = await listLeases(workspace);
    expect(all.find((lease) => lease.id === orphan!.id)?.status).toBe("revoked");
    expect(all.find((lease) => lease.id === dispatched.leases[0])?.agentId).toBe("worker-new");
  });

  it("fences every non-cancel Run mutation after Task authority drift without changing Run or subtask state", async () => {
    const { workspace, schemas, run, task } = await setup();
    const beginTarget = await addSubtask(workspace, schemas, run.runId, {
      goal: "begin target", inputArtifactIds: [], acceptanceCriteria: ["begin checked"],
      scope: ["docs"], capabilities: ["repository-read"]
    });
    const reportTarget = await addSubtask(workspace, schemas, run.runId, {
      goal: "report target", inputArtifactIds: [], acceptanceCriteria: ["report checked"],
      scope: ["docs"], capabilities: ["repository-read"]
    });
    const reviewTarget = await addSubtask(workspace, schemas, run.runId, {
      goal: "review target", inputArtifactIds: [], acceptanceCriteria: ["review checked"],
      scope: ["docs"], capabilities: ["repository-read"]
    });
    const beginDispatch = await dispatchSubtask(workspace, schemas, run.runId, beginTarget.subtaskId, "begin-worker");
    const reportDispatch = await dispatchSubtask(workspace, schemas, run.runId, reportTarget.subtaskId, "report-worker");
    const reviewDispatch = await dispatchSubtask(workspace, schemas, run.runId, reviewTarget.subtaskId, "review-worker");
    await beginSubtaskStorage(workspace, run.runId, reportTarget.subtaskId, reportDispatch.activeAttempt);
    await beginSubtaskStorage(workspace, run.runId, reviewTarget.subtaskId, reviewDispatch.activeAttempt);
    await writeFile(path.join(workspace.root, "docs", "review-before-drift.md"), "review bytes\n", "utf8");
    await reportArtifactStorage(workspace, schemas, run.runId, reviewTarget.subtaskId, {
      path: "docs/review-before-drift.md", kind: "file", expectedAttempt: reviewDispatch.activeAttempt
    });
    await writeFile(path.join(workspace.root, "docs", "report-after-drift.md"), "report bytes\n", "utf8");

    await saveTask(workspace, { ...task, constraints: ["authority changed after attempts began"] });
    const runBefore = await getRun(workspace, run.runId);
    const subtasksBefore = await Promise.all(runBefore.subtasks.map((id) => getSubtask(workspace, id)));
    const expectStale = async (operation: Promise<unknown>) => {
      await expect(operation).rejects.toMatchObject({ code: "TASK_AUTHORITY_STALE" });
    };

    await expectStale(addSubtask(workspace, schemas, run.runId, {
      goal: "must not add", inputArtifactIds: [], acceptanceCriteria: ["denied"],
      scope: ["docs"], capabilities: ["repository-read"]
    }));
    await expectStale(beginSubtaskStorage(workspace, run.runId, beginTarget.subtaskId, beginDispatch.activeAttempt));
    await expectStale(reportArtifactStorage(workspace, schemas, run.runId, reportTarget.subtaskId, {
      path: "docs/report-after-drift.md", kind: "file", expectedAttempt: reportDispatch.activeAttempt
    }));
    await expectStale(recordReviewStorage(workspace, schemas, run.runId, reviewTarget.subtaskId, {
      ...reviewInput("ACCEPTED", 90, [], "must not review", reviewTarget.acceptanceCriteria),
      expectedAttempt: reviewDispatch.activeAttempt
    }));
    await expectStale(completeRound(workspace, run.runId, { passed: false, note: "must not complete" }));
    await expectStale(escalateRun(workspace, run.runId, "must not escalate"));

    expect(await getRun(workspace, run.runId)).toEqual(runBefore);
    expect(await Promise.all(runBefore.subtasks.map((id) => getSubtask(workspace, id)))).toEqual(subtasksBefore);
    await expect(cancelRun(workspace, run.runId)).resolves.toMatchObject({ status: "CANCELLED" });
  });

  for (const point of ["after-artifact", "after-run", "after-ledger"] as const) {
    it(`repairs Artifact reporting exactly once after ${point}`, async () => {
      const { workspace, schemas, run } = await setup();
      const subtask = await addSubtask(workspace, schemas, run.runId, {
        goal: "report one artifact", inputArtifactIds: [], acceptanceCriteria: ["artifact recorded"],
        scope: ["docs"], capabilities: ["repository-read"]
      });
      const dispatched = await dispatchSubtask(workspace, schemas, run.runId, subtask.subtaskId, "artifact-worker");
      await beginSubtaskStorage(workspace, run.runId, subtask.subtaskId, dispatched.activeAttempt);
      await writeFile(path.join(workspace.root, "docs", "split-report.md"), "stable artifact bytes\n", "utf8");
      const input = { path: "docs/split-report.md", kind: "file" as const, expectedAttempt: dispatched.activeAttempt };
      injectArtifactReportingFaultForTesting(workspace, point);
      await expect(reportArtifactStorage(workspace, schemas, run.runId, subtask.subtaskId, input))
        .rejects.toMatchObject({ code: "ARTIFACT_REPORTING_TEST_FAULT", details: { point } });

      const recovered = await reportArtifactStorage(workspace, schemas, run.runId, subtask.subtaskId, input);
      const repeated = await reportArtifactStorage(workspace, schemas, run.runId, subtask.subtaskId, input);
      expect(repeated.artifactId).toBe(recovered.artifactId);
      expect((await getRun(workspace, run.runId)).artifacts).toEqual([recovered.artifactId]);
      await expect(getSubtask(workspace, subtask.subtaskId)).resolves.toMatchObject({
        status: "REVIEWING",
        artifactRefs: [recovered.artifactId]
      });
      const entries = (await listLedgerEntries(workspace)).filter((entry) => entry.event === "artifact-recorded" && entry.artifactRef === recovered.artifactId);
      expect(entries).toHaveLength(1);
    });
  }

  it("fences resume after Task authority drift while leaving cancellation available", async () => {
    const { workspace, run, task } = await setup();
    await escalateRun(workspace, run.runId, "pause before authority change");
    await saveTask(workspace, { ...task, constraints: ["authority changed while escalated"] });
    const before = await getRun(workspace, run.runId);
    await expect(resumeRun(workspace, run.runId, { expectedResumeGeneration: 1 })).rejects.toMatchObject({ code: "TASK_AUTHORITY_STALE" });
    expect(await getRun(workspace, run.runId)).toEqual(before);
    await expect(cancelRun(workspace, run.runId)).resolves.toMatchObject({ status: "CANCELLED" });
  });

  it("fences Run mutation after the owning Task is cancelled while leaving Run cancellation available", async () => {
    const { workspace, schemas, run, task } = await setup();
    await transitionTask(workspace, schemas, task.id, "CANCELLED", { reason: "User cancelled the owning Task." });
    const before = await getRun(workspace, run.runId);
    await expect(addSubtask(workspace, schemas, run.runId, {
      goal: "must not add", inputArtifactIds: [], acceptanceCriteria: ["denied"],
      scope: ["docs"], capabilities: ["repository-read"]
    })).rejects.toMatchObject({ code: "TASK_AUTHORITY_STALE" });
    expect(await getRun(workspace, run.runId)).toEqual(before);
    await expect(cancelRun(workspace, run.runId)).resolves.toMatchObject({ status: "CANCELLED" });
  });

  it("validates explicit run budgets at the same hard boundaries as config and resume", async () => {
    const { workspace, schemas, contract, run } = await setup();
    for (const input of [
      { maxRounds: 0 }, { maxRounds: 101 },
      { maxRetriesPerSubtask: -1 }, { maxRetriesPerSubtask: 11 },
      { maxSubtaskTokens: 999 }, { maxSubtaskTokens: 10_000_001 }
    ]) {
      await expect(createRun(workspace, schemas, { contractRef: contract.contractId, ...input }))
        .rejects.toMatchObject({ code: "RUN_BUDGET_INVALID" });
    }
    await cancelRun(workspace, run.runId);
    await expect(createRun(workspace, schemas, {
      contractRef: contract.contractId,
      supersedesRunRef: run.runId,
      maxRounds: 1,
      maxRetriesPerSubtask: 0,
      maxSubtaskTokens: 1000
    })).resolves.toMatchObject({ budget: { maxRounds: 1, maxRetriesPerSubtask: 0, maxSubtaskTokens: 1000 } });
  });

  it("does not allow a subtask retry override to exceed its run budget", async () => {
    const { workspace, schemas, run } = await setup();
    await expect(addSubtask(workspace, schemas, run.runId, {
      goal: "write",
      inputArtifactIds: [],
      acceptanceCriteria: ["x"],
      scope: ["docs"],
      capabilities: ["repository-read"],
      maxRetries: run.budget.maxRetriesPerSubtask + 1
    })).rejects.toMatchObject({ code: "SUBTASK_RETRY_BUDGET_INVALID" });
  });

  it("revalidates persisted retry caps and exhaustion at dispatch and begin", async () => {
    const { workspace, schemas, run } = await setup();
    const subtask = await addSubtask(workspace, schemas, run.runId, {
      goal: "write", inputArtifactIds: [], acceptanceCriteria: ["x"], scope: ["docs"], capabilities: ["repository-read"]
    });
    const file = path.join(workspace.directory, "orchestration", `${subtask.subtaskId}.json`);

    await writeFile(file, `${JSON.stringify({ ...subtask, status: "REJECTED", maxRetries: 5, retriesUsed: 2 }, null, 2)}\n`, "utf8");
    await expect(dispatchSubtask(workspace, schemas, run.runId, subtask.subtaskId, "agent", 2))
      .rejects.toMatchObject({ code: "SUBTASK_RETRY_BUDGET_INVALID" });
    await writeFile(file, `${JSON.stringify({ ...subtask, status: "REJECTED", maxRetries: 2, retriesUsed: 2 }, null, 2)}\n`, "utf8");
    await expect(dispatchSubtask(workspace, schemas, run.runId, subtask.subtaskId, "agent", 2))
      .resolves.toMatchObject({ subtask: { status: "DISPATCHED", retriesUsed: 2 } });
    await writeFile(file, `${JSON.stringify({ ...subtask, status: "REJECTED", maxRetries: 2, retriesUsed: 3 }, null, 2)}\n`, "utf8");
    await expect(dispatchSubtask(workspace, schemas, run.runId, subtask.subtaskId, "agent", 3))
      .rejects.toMatchObject({ code: "SUBTASK_RETRIES_EXHAUSTED" });

    await writeFile(file, `${JSON.stringify({ ...subtask, status: "DISPATCHED", maxRetries: 5, retriesUsed: 2, activeAttempt: 2 }, null, 2)}\n`, "utf8");
    await expect(beginCurrentAttemptForTest(workspace, run.runId, subtask.subtaskId))
      .rejects.toMatchObject({ code: "SUBTASK_RETRY_BUDGET_INVALID" });
    await writeFile(file, `${JSON.stringify({ ...subtask, status: "DISPATCHED", maxRetries: 2, retriesUsed: 2, activeAttempt: 2 }, null, 2)}\n`, "utf8");
    await expect(beginCurrentAttemptForTest(workspace, run.runId, subtask.subtaskId))
      .resolves.toMatchObject({ status: "RUNNING", retriesUsed: 2 });
    await writeFile(file, `${JSON.stringify({ ...subtask, status: "DISPATCHED", maxRetries: 2, retriesUsed: 3, activeAttempt: 3 }, null, 2)}\n`, "utf8");
    await expect(beginCurrentAttemptForTest(workspace, run.runId, subtask.subtaskId))
      .rejects.toMatchObject({ code: "SUBTASK_RETRIES_EXHAUSTED" });
  });

  it("runs the full loop: contract → run → subtask → dispatch → begin → artifact → accept → complete", async () => {
    const { workspace, schemas, contract, run, root } = await setup();
    expect(recommendExecutionMode(contract).mode).toBe("orchestrate");

    const subtask = await addSubtask(workspace, schemas, run.runId, {
      goal: "Write docs/guide.md",
      inputArtifactIds: [],
      acceptanceCriteria: GLOBAL_CRITERIA,
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

    await beginCurrentAttemptForTest(workspace, run.runId, subtask.subtaskId);
    await writeFile(path.join(root, "docs", "guide.md"), "# Guide\n", "utf8");
    const artifact = await reportCurrentArtifactForTest(workspace, schemas, run.runId, subtask.subtaskId, { path: "docs/guide.md", kind: "file" });
    expect(artifact.status).toBe("VERIFIED");
    expect(artifact.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    const result = await recordCurrentReviewForTest(workspace, schemas, run.runId, subtask.subtaskId, reviewInput("ACCEPTED", 90, [], "reviewed", GLOBAL_CRITERIA));
    expect(result.review.decision).toBe("ACCEPTED");
    expect(result.subtask.status).toBe("ACCEPTED");
    expect(result.run.status).toBe("RUNNING"); // explicit post-review consistency gate still owns completion
    const completed = await completeRound(workspace, run.runId, { passed: true, note: "current outputs remain consistent with the contract" });
    expect(completed.status).toBe("COMPLETED");
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
    const independent = await addSubtask(workspace, schemas, run.runId, {
      goal: "Independent branch", inputArtifactIds: [], acceptanceCriteria: ["independent good"], scope: ["docs/independent"], capabilities: ["repository-read"]
    });
    await dispatchSubtask(workspace, schemas, run.runId, subtask.subtaskId, "worker-agent", 0);
    await beginCurrentAttemptForTest(workspace, run.runId, subtask.subtaskId);
    await writeFile(path.join(workspace.root, "docs", "guide.md"), "v1\n", "utf8");
    await reportCurrentArtifactForTest(workspace, schemas, run.runId, subtask.subtaskId, { path: "docs/guide.md", kind: "file" });
    const rejected = await recordCurrentReviewForTest(workspace, schemas, run.runId, subtask.subtaskId, reviewInput("REJECTED", 40, [{ location: "docs/guide.md", problem: "too short", suggestion: "expand" }], "reviewed", ["good"]));
    expect(rejected.subtask.status).toBe("REJECTED");
    expect(rejected.subtask.retriesUsed).toBe(1);
    expect(rejected.run.status).toBe("RUNNING"); // failure isolation: run continues

    // redispatch the rejected subtask (retry)
    await dispatchSubtask(workspace, schemas, run.runId, subtask.subtaskId, "worker-agent", 1);
    await beginCurrentAttemptForTest(workspace, run.runId, subtask.subtaskId);
    await writeFile(path.join(workspace.root, "docs", "guide.md"), "v2\n", "utf8");
    await reportCurrentArtifactForTest(workspace, schemas, run.runId, subtask.subtaskId, { path: "docs/guide.md", kind: "file" });
    const rejectedAgain = await recordCurrentReviewForTest(workspace, schemas, run.runId, subtask.subtaskId, reviewInput("REJECTED", 40, [{ location: "docs/guide.md", problem: "still too short", suggestion: "expand more" }], "reviewed", ["good"]));
    expect(rejectedAgain.subtask.status).toBe("REJECTED");
    expect(rejectedAgain.subtask.retriesUsed).toBe(2);
    expect(rejectedAgain.run.status).toBe("RUNNING");

    // maxRetries=2 means two rework executions after the initial rejection.
    await dispatchSubtask(workspace, schemas, run.runId, subtask.subtaskId, "worker-agent", 2);
    await beginCurrentAttemptForTest(workspace, run.runId, subtask.subtaskId);
    await writeFile(path.join(workspace.root, "docs", "guide.md"), "v3\n", "utf8");
    await reportCurrentArtifactForTest(workspace, schemas, run.runId, subtask.subtaskId, { path: "docs/guide.md", kind: "file" });
    const exhausted = await recordCurrentReviewForTest(workspace, schemas, run.runId, subtask.subtaskId, reviewInput("REJECTED", 40, [{ location: "docs/guide.md", problem: "still incomplete", suggestion: "finish it" }], "reviewed", ["good"]));
    expect(exhausted.subtask.retriesUsed).toBe(3);
    expect(exhausted.subtask.status).toBe("FAILED");
    expect(exhausted.run.status).toBe("DEGRADED");
    expect(exhausted.run.escalationReason).toContain("RETRIES_EXHAUSTED");

    await mkdir(path.join(workspace.root, "docs", "independent"), { recursive: true });
    await expect(dispatchSubtask(workspace, schemas, run.runId, independent.subtaskId, "independent-worker"))
      .resolves.toMatchObject({ subtask: { status: "DISPATCHED" } });
    await beginCurrentAttemptForTest(workspace, run.runId, independent.subtaskId);
    await writeFile(path.join(workspace.root, "docs", "independent", "result.md"), "independent branch continued\n", "utf8");
    await reportCurrentArtifactForTest(workspace, schemas, run.runId, independent.subtaskId, { path: "docs/independent/result.md", kind: "file" });
    const continued = await recordCurrentReviewForTest(workspace, schemas, run.runId, independent.subtaskId,
      reviewInput("ACCEPTED", 90, [], "independent branch accepted", ["independent good"]));
    expect(continued).toMatchObject({ run: { status: "DEGRADED" }, subtask: { status: "ACCEPTED" } });
  });

  it("treats maxRetries as the exact number of rework executions", async () => {
    const { workspace, schemas, contract, run: initialRun } = await setup();
    await cancelRun(workspace, initialRun.runId);

    const zeroRun = await createRun(workspace, schemas, { contractRef: contract.contractId, supersedesRunRef: initialRun.runId, maxRetriesPerSubtask: 0 });
    const zero = await addSubtask(workspace, schemas, zeroRun.runId, { goal: "zero", inputArtifactIds: [], acceptanceCriteria: ["good"], scope: ["docs"], capabilities: ["repository-read"], maxRetries: 0 });
    await dispatchSubtask(workspace, schemas, zeroRun.runId, zero.subtaskId, "worker-agent");
    await beginCurrentAttemptForTest(workspace, zeroRun.runId, zero.subtaskId);
    const zeroRejected = await recordCurrentReviewForTest(workspace, schemas, zeroRun.runId, zero.subtaskId, reviewInput("REJECTED", 40, [{ location: "zero", problem: "bad", suggestion: "fix" }], "reviewed", ["good"]));
    expect(zeroRejected).toMatchObject({ run: { status: "DEGRADED" }, subtask: { status: "FAILED", retriesUsed: 1 } });
    await cancelRun(workspace, zeroRun.runId);

    const oneRun = await createRun(workspace, schemas, { contractRef: contract.contractId, supersedesRunRef: zeroRun.runId, maxRetriesPerSubtask: 1 });
    const one = await addSubtask(workspace, schemas, oneRun.runId, { goal: "one", inputArtifactIds: [], acceptanceCriteria: ["good"], scope: ["docs"], capabilities: ["repository-read"], maxRetries: 1 });
    await dispatchSubtask(workspace, schemas, oneRun.runId, one.subtaskId, "worker-agent", 0);
    await beginCurrentAttemptForTest(workspace, oneRun.runId, one.subtaskId);
    const first = await recordCurrentReviewForTest(workspace, schemas, oneRun.runId, one.subtaskId, reviewInput("REJECTED", 40, [{ location: "one", problem: "first", suggestion: "fix" }], "reviewed", ["good"]));
    expect(first).toMatchObject({ run: { status: "RUNNING" }, subtask: { retriesUsed: 1 } });
    await dispatchSubtask(workspace, schemas, oneRun.runId, one.subtaskId, "worker-agent", 1);
    await beginCurrentAttemptForTest(workspace, oneRun.runId, one.subtaskId);
    const second = await recordCurrentReviewForTest(workspace, schemas, oneRun.runId, one.subtaskId, reviewInput("REJECTED", 40, [{ location: "one", problem: "second", suggestion: "fix" }], "reviewed", ["good"]));
    expect(second).toMatchObject({ run: { status: "DEGRADED" }, subtask: { status: "FAILED", retriesUsed: 2 } });
  });

  it("fails the whole run on retry exhaustion for critical or fail-fast work", async () => {
    const { workspace, schemas, contract, run } = await setup();
    await cancelRun(workspace, run.runId);
    const criticalRun = await createRun(workspace, schemas, { contractRef: contract.contractId, supersedesRunRef: run.runId });
    const critical = await addSubtask(workspace, schemas, criticalRun.runId, {
      goal: "Critical", inputArtifactIds: [], acceptanceCriteria: ["good"], scope: ["docs"], capabilities: ["repository-read"], maxRetries: 0, critical: true
    });
    await dispatchSubtask(workspace, schemas, criticalRun.runId, critical.subtaskId, "worker");
    await beginCurrentAttemptForTest(workspace, criticalRun.runId, critical.subtaskId);
    const criticalResult = await recordCurrentReviewForTest(workspace, schemas, criticalRun.runId, critical.subtaskId,
      reviewInput("REJECTED", 20, [{ location: "docs", problem: "critical failure", suggestion: "stop" }], "critical", ["good"]));
    expect(criticalResult).toMatchObject({ run: { status: "FAILED" }, subtask: { status: "FAILED" } });

    const failFastRun = await createRun(workspace, schemas, { contractRef: contract.contractId, supersedesRunRef: criticalRun.runId, failFast: true, maxRetriesPerSubtask: 0 });
    const ordinary = await addSubtask(workspace, schemas, failFastRun.runId, {
      goal: "Fail fast", inputArtifactIds: [], acceptanceCriteria: ["good"], scope: ["docs"], capabilities: ["repository-read"], maxRetries: 0
    });
    await dispatchSubtask(workspace, schemas, failFastRun.runId, ordinary.subtaskId, "worker");
    await beginCurrentAttemptForTest(workspace, failFastRun.runId, ordinary.subtaskId);
    const failFastResult = await recordCurrentReviewForTest(workspace, schemas, failFastRun.runId, ordinary.subtaskId,
      reviewInput("REJECTED", 20, [{ location: "docs", problem: "failure", suggestion: "stop" }], "fail fast", ["good"]));
    expect(failFastResult).toMatchObject({ run: { status: "FAILED" }, subtask: { status: "FAILED" } });
  });

  it("escalates the run on oscillation (same defect fingerprint twice)", async () => {
    const { workspace, schemas, contract, run: initialRun } = await setup();
    await cancelRun(workspace, initialRun.runId);
    const run = await createRun(workspace, schemas, { contractRef: contract.contractId, supersedesRunRef: initialRun.runId, maxRetriesPerSubtask: 3 });
    const subtask = await addSubtask(workspace, schemas, run.runId, {
      goal: "Write docs/guide.md", inputArtifactIds: [], acceptanceCriteria: ["good"], scope: ["docs"], capabilities: ["repository-read"]
    });
    await dispatchSubtask(workspace, schemas, run.runId, subtask.subtaskId, "worker-agent", 0);
    await beginCurrentAttemptForTest(workspace, run.runId, subtask.subtaskId);
    await writeFile(path.join(workspace.root, "docs", "guide.md"), "v1\n", "utf8");
    await reportCurrentArtifactForTest(workspace, schemas, run.runId, subtask.subtaskId, { path: "docs/guide.md", kind: "file" });
    await recordCurrentReviewForTest(workspace, schemas, run.runId, subtask.subtaskId, reviewInput("REJECTED", 40, [{ location: "docs/guide.md", problem: "same bug", suggestion: "fix it" }], "reviewed", ["good"]));
    // round 2: same defect again → oscillation
    await dispatchSubtask(workspace, schemas, run.runId, subtask.subtaskId, "worker-agent", 1);
    await beginCurrentAttemptForTest(workspace, run.runId, subtask.subtaskId);
    await writeFile(path.join(workspace.root, "docs", "guide.md"), "v2\n", "utf8");
    await reportCurrentArtifactForTest(workspace, schemas, run.runId, subtask.subtaskId, { path: "docs/guide.md", kind: "file" });
    const escalated = await recordCurrentReviewForTest(workspace, schemas, run.runId, subtask.subtaskId, reviewInput("REJECTED", 40, [{ location: "docs/guide.md", problem: "same bug", suggestion: "fix it" }], "reviewed", ["good"]));
    expect(escalated.run.status).toBe("ESCALATED");
    expect(escalated.run.escalationReason).toContain("OSCILLATION");
    await resumeRun(workspace, run.runId, { expectedResumeGeneration: 1 });
    await expect(dispatchSubtask(workspace, schemas, run.runId, subtask.subtaskId, "worker-agent", 2))
      .resolves.toMatchObject({ subtask: { status: "DISPATCHED" } });
    const events = (await listLedgerEntries(workspace)).map((entry) => entry.event);
    expect(events).toContain("orchestration-escalated");
  });

  it("rejects artifacts outside the subtask scope", async () => {
    const { workspace, schemas, run } = await setup();
    const subtask = await addSubtask(workspace, schemas, run.runId, {
      goal: "Write docs", inputArtifactIds: [], acceptanceCriteria: ["ok"], scope: ["docs"], capabilities: ["repository-read"]
    });
    await dispatchSubtask(workspace, schemas, run.runId, subtask.subtaskId, "worker-agent");
    await beginCurrentAttemptForTest(workspace, run.runId, subtask.subtaskId);
    await writeFile(path.join(workspace.root, "src.js"), "bad\n", "utf8");
    const before = await getRun(workspace, run.runId);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(reportCurrentArtifactForTest(workspace, schemas, run.runId, subtask.subtaskId, { path: "src.js", kind: "file" }))
        .rejects.toMatchObject({ code: "ARTIFACT_SCOPE_VIOLATION" });
    }
    expect((await getRun(workspace, run.runId)).artifacts).toEqual(before.artifacts);
    expect((await getSubtask(workspace, subtask.subtaskId)).artifactRefs).toBeUndefined();
    expect((await listLedgerEntries(workspace)).filter((entry) => entry.event === "artifact-mismatch")).toHaveLength(0);
  });

  it("enforces a bounded per-subtask Artifact cardinality before reading or persisting another file", async () => {
    const { workspace, schemas, run } = await setup();
    const subtask = await addSubtask(workspace, schemas, run.runId, {
      goal: "Bound artifact reports", inputArtifactIds: [], acceptanceCriteria: ["bounded"], scope: ["docs"], capabilities: ["repository-read"]
    });
    await dispatchSubtask(workspace, schemas, run.runId, subtask.subtaskId, "worker-agent");
    await beginCurrentAttemptForTest(workspace, run.runId, subtask.subtaskId);
    const current = await getSubtask(workspace, subtask.subtaskId);
    await writeFile(
      path.join(workspace.directory, "orchestration", `${subtask.subtaskId}.json`),
      `${JSON.stringify({ ...current, artifactRefs: Array.from({ length: MAX_SUBTASK_ARTIFACTS }, (_, index) => `artifact-existing-${index}`) }, null, 2)}\n`,
      "utf8"
    );
    await writeFile(path.join(workspace.root, "docs", "bounded.md"), "must not be read\n", "utf8");
    const before = await getRun(workspace, run.runId);
    await expect(reportCurrentArtifactForTest(workspace, schemas, run.runId, subtask.subtaskId, { path: "docs/bounded.md", kind: "file" }))
      .rejects.toMatchObject({ code: "ARTIFACT_LIMIT_REACHED" });
    expect((await getRun(workspace, run.runId)).artifacts).toEqual(before.artifacts);
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
    await beginCurrentAttemptForTest(workspace, run.runId, subtask.subtaskId);
    return subtask;
  }

  it("completes a positive rework loop: reject → redispatch → corrected → accept", async () => {
    const { workspace, schemas, run } = await setup();
    const subtask = await addSubtask(workspace, schemas, run.runId, {
      goal: "Write docs/guide.md", inputArtifactIds: [], acceptanceCriteria: GLOBAL_CRITERIA,
      scope: ["docs"], capabilities: ["repository-read", "repository-write"]
    });
    await dispatchSubtask(workspace, schemas, run.runId, subtask.subtaskId, "worker-agent");
    await beginCurrentAttemptForTest(workspace, run.runId, subtask.subtaskId);
    await writeFile(path.join(workspace.root, "docs", "guide.md"), "v1\n", "utf8");
    await reportCurrentArtifactForTest(workspace, schemas, run.runId, subtask.subtaskId, { path: "docs/guide.md", kind: "file" });
    await recordCurrentReviewForTest(workspace, schemas, run.runId, subtask.subtaskId, reviewInput("REJECTED", 50, [{ location: "docs/guide.md", problem: "missing sections", suggestion: "add all sections" }], "reviewed", GLOBAL_CRITERIA));
    // redispatch the rejected subtask
    await dispatchSubtask(workspace, schemas, run.runId, subtask.subtaskId, "worker-agent", 1);
    await beginCurrentAttemptForTest(workspace, run.runId, subtask.subtaskId);
    await writeFile(path.join(workspace.root, "docs", "guide.md"), "# Guide\n\n## Overview\n...\n\n## Usage\n...\n\n## Install\n...\n", "utf8");
    await reportCurrentArtifactForTest(workspace, schemas, run.runId, subtask.subtaskId, { path: "docs/guide.md", kind: "file" });
    const accepted = await recordCurrentReviewForTest(workspace, schemas, run.runId, subtask.subtaskId, reviewInput("ACCEPTED", 90, [], "reviewed", GLOBAL_CRITERIA));
    expect(accepted.subtask.status).toBe("ACCEPTED");
    expect(accepted.run.status).toBe("RUNNING");
    expect((await completeRound(workspace, run.runId, { passed: true, note: "corrected output remains contract-consistent" })).status).toBe("COMPLETED");
  });

  it("rolls back a rejected worker artifact via write rollback (subtask-mode intent)", async () => {
    const { workspace, schemas, run, root } = await setup();
    await writeFile(path.join(root, "docs", "existing.md"), "original\n", "utf8");
    const subtask = await runOneSubtaskFlow(workspace, schemas, run, "Modify docs/existing.md", "");
    // worker applies a controlled write (subtask-mode intent + write lease)
    const { requestWrites, rollbackWrite } = await import("../src/storage/write-intents.js");
    const { applyWrite } = await import("../src/storage/writes.js");
    const { getLease } = await import("../src/storage/leases.js");
    const leases = await import("../src/storage/leases.js").then((m) => m.listLeases(workspace));
    const writeLease = leases.find((l: any) => l.capability === "repository-write" && l.subtaskRef === subtask.subtaskId);
    expect(writeLease).toBeDefined();
    const intent = await requestWrites(workspace, schemas, "-", "-", [{ target: "docs/existing.md", action: "modify", purpose: "worker change" }], {
      autoAllow: true, runRef: run.runId, subtaskRef: subtask.subtaskId
    });
    await applyWrite(workspace, schemas, writeLease, intent, "docs/existing.md", "worker changed it\n");
    await reportCurrentArtifactForTest(workspace, schemas, run.runId, subtask.subtaskId, { path: "docs/existing.md", kind: "file" });
    await recordCurrentReviewForTest(workspace, schemas, run.runId, subtask.subtaskId, reviewInput("REJECTED", 30, [{ location: "docs/existing.md", problem: "regressed", suggestion: "revert" }], "reviewed", ["good"]));
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
    await reportCurrentArtifactForTest(workspace, schemas, run.runId, a.subtaskId, { path: "docs/a.md", kind: "file" });
    await recordCurrentReviewForTest(workspace, schemas, run.runId, a.subtaskId, reviewInput("ACCEPTED", 90, [], "reviewed", ["good"]));
    const dispatchedB = await dispatchSubtask(workspace, schemas, run.runId, b.subtaskId, "worker-agent");
    expect(dispatchedB.subtask.status).toBe("DISPATCHED");
  });

  it("fails the run when the round budget is exhausted", async () => {
    const { workspace, schemas, run } = await setup();
    const subtask = await runOneSubtaskFlow(workspace, schemas, run, "Write docs/guide.md", "");
    await writeFile(path.join(workspace.root, "docs", "guide.md"), "v1\n", "utf8");
    await reportCurrentArtifactForTest(workspace, schemas, run.runId, subtask.subtaskId, { path: "docs/guide.md", kind: "file" });
    await recordCurrentReviewForTest(workspace, schemas, run.runId, subtask.subtaskId, reviewInput("REJECTED", 40, [{ location: "x", problem: "p1", suggestion: "s1" }], "reviewed", ["good"]));
    let result = run;
    for (let i = 0; i < 5; i++) result = await completeRound(workspace, run.runId, { passed: true, note: "advance" });
    expect(result).toMatchObject({ status: "FAILED", round: 5 });
    expect(result.escalationReason).toContain("ROUND_BUDGET");
    await expect(completeRound(workspace, run.runId, { passed: true, note: "cannot continue" }))
      .rejects.toMatchObject({ code: "RUN_STATE_CONFLICT" });
  });
});

describe("2.0.1 orchestration authority and completion gates", () => {
  async function addGuardSubtask(workspace: any, schemas: any, runId: string) {
    return addSubtask(workspace, schemas, runId, {
      goal: "Keep the run open while producer state is inspected",
      inputArtifactIds: [], acceptanceCriteria: ["guard"], scope: ["docs"], capabilities: ["repository-read"]
    });
  }

  async function reportAcceptedProducer(workspace: any, schemas: any, runId: string, file = "docs/producer.md") {
    const producer = await addSubtask(workspace, schemas, runId, {
      goal: `Produce ${file}`,
      inputArtifactIds: [], acceptanceCriteria: ["producer accepted"], scope: ["docs"], capabilities: ["repository-read"]
    });
    await dispatchSubtask(workspace, schemas, runId, producer.subtaskId, "producer-agent");
    await beginCurrentAttemptForTest(workspace, runId, producer.subtaskId);
    await writeFile(path.join(workspace.root, file), "authoritative producer output\n", "utf8");
    const artifact = await reportCurrentArtifactForTest(workspace, schemas, runId, producer.subtaskId, { path: file, kind: "file" });
    await recordCurrentReviewForTest(workspace, schemas, runId, producer.subtaskId, reviewInput("ACCEPTED", 90, [], "producer accepted", ["producer accepted"]));
    return { producer: await getSubtask(workspace, producer.subtaskId), artifact };
  }

  it("rejects a second active run for the same contract", async () => {
    const { workspace, schemas, contract, run } = await setup();
    await expect(createRun(workspace, schemas, { contractRef: contract.contractId }))
      .resolves.toMatchObject({ runId: run.runId });
    await expect(createRun(workspace, schemas, { contractRef: contract.contractId, maxRounds: run.budget.maxRounds + 1 }))
      .rejects.toMatchObject({ code: "ACTIVE_RUN_CONFLICT", details: { activeRunId: run.runId } });
  });

  it("rejects overlapping active repository-write attempts but permits disjoint branches", async () => {
    const { workspace, schemas, run } = await setup();
    const first = await addSubtask(workspace, schemas, run.runId, {
      goal: "Write docs/a", inputArtifactIds: [], acceptanceCriteria: ["a"], scope: ["docs/a"], capabilities: ["repository-write"]
    });
    const overlapping = await addSubtask(workspace, schemas, run.runId, {
      goal: "Write docs/a/nested", inputArtifactIds: [], acceptanceCriteria: ["nested"], scope: ["docs/a/nested"], capabilities: ["repository-write"]
    });
    const disjoint = await addSubtask(workspace, schemas, run.runId, {
      goal: "Write docs/b", inputArtifactIds: [], acceptanceCriteria: ["b"], scope: ["docs/b"], capabilities: ["repository-write"]
    });
    await dispatchSubtask(workspace, schemas, run.runId, first.subtaskId, "worker-a");
    await expect(dispatchSubtask(workspace, schemas, run.runId, overlapping.subtaskId, "worker-overlap"))
      .rejects.toMatchObject({ code: "ACTIVE_WRITE_SET_CONFLICT", details: { conflictingSubtaskId: first.subtaskId } });
    await expect(dispatchSubtask(workspace, schemas, run.runId, disjoint.subtaskId, "worker-b"))
      .resolves.toMatchObject({ subtask: { status: "DISPATCHED" } });
  });

  it("requires a new file artifact from the current retry attempt before accepting", async () => {
    const { workspace, schemas, run } = await setup();
    await completeRound(workspace, run.runId, { passed: true, note: "contract anchors checked" });
    const subtask = await addSubtask(workspace, schemas, run.runId, {
      goal: "Write docs/guide.md", inputArtifactIds: [], acceptanceCriteria: GLOBAL_CRITERIA,
      scope: ["docs"], capabilities: ["repository-read"]
    });
    await dispatchSubtask(workspace, schemas, run.runId, subtask.subtaskId, "worker-agent");
    await beginCurrentAttemptForTest(workspace, run.runId, subtask.subtaskId);
    await writeFile(path.join(workspace.root, "docs", "guide.md"), "attempt zero\n", "utf8");
    const oldArtifact = await reportCurrentArtifactForTest(workspace, schemas, run.runId, subtask.subtaskId, { path: "docs/guide.md", kind: "file" });
    expect(oldArtifact.attempt).toBe(0);
    await recordCurrentReviewForTest(workspace, schemas, run.runId, subtask.subtaskId,
      reviewInput("REJECTED", 40, [{ location: "docs/guide.md", problem: "incomplete", suggestion: "retry" }], "retry", GLOBAL_CRITERIA));

    await dispatchSubtask(workspace, schemas, run.runId, subtask.subtaskId, "worker-agent", 1);
    await beginCurrentAttemptForTest(workspace, run.runId, subtask.subtaskId);
    await expect(recordCurrentReviewForTest(workspace, schemas, run.runId, subtask.subtaskId,
      reviewInput("ACCEPTED", 90, [], "old artifact must not count", GLOBAL_CRITERIA)))
      .rejects.toMatchObject({ code: "REVIEW_ARTIFACT_REQUIRED" });

    await writeFile(path.join(workspace.root, "docs", "guide.md"), "attempt one, corrected\n", "utf8");
    const currentArtifact = await reportCurrentArtifactForTest(workspace, schemas, run.runId, subtask.subtaskId, { path: "docs/guide.md", kind: "file" });
    expect(currentArtifact.attempt).toBe(1);
    const accepted = await recordCurrentReviewForTest(workspace, schemas, run.runId, subtask.subtaskId,
      reviewInput("ACCEPTED", 90, [], "current attempt verified", GLOBAL_CRITERIA));
    expect(accepted.run.status).toBe("RUNNING");
    expect((await completeRound(workspace, run.runId, { passed: true, note: "current retry remains contract-consistent" })).status).toBe("COMPLETED");
  });

  it.each(["summary", "evidence"] as const)("rejects %s artifacts because they have no content-bearing verification contract", async (kind) => {
    const { workspace, schemas, run } = await setup();
    const subtask = await addSubtask(workspace, schemas, run.runId, {
      goal: "Report output", inputArtifactIds: [], acceptanceCriteria: ["reported"], scope: ["docs"], capabilities: ["repository-read"]
    });
    await dispatchSubtask(workspace, schemas, run.runId, subtask.subtaskId, "worker-agent");
    await beginCurrentAttemptForTest(workspace, run.runId, subtask.subtaskId);
    await expect(reportCurrentArtifactForTest(workspace, schemas, run.runId, subtask.subtaskId, { path: "docs/report.md", kind }))
      .rejects.toMatchObject({ code: "ARTIFACT_KIND_UNVERIFIABLE" });
  });

  it("bounds Artifact reads and rejects hard links before hashing", async () => {
    const { workspace, schemas, run } = await setup();
    const subtask = await addSubtask(workspace, schemas, run.runId, {
      goal: "Report a bounded file", inputArtifactIds: [], acceptanceCriteria: ["bounded"], scope: ["docs"], capabilities: ["repository-read"]
    });
    await dispatchSubtask(workspace, schemas, run.runId, subtask.subtaskId, "worker-agent");
    await beginCurrentAttemptForTest(workspace, run.runId, subtask.subtaskId);

    const outside = await mkdtemp(path.join(os.tmpdir(), "stinky-orch-outside-"));
    roots.push(outside);
    await writeFile(path.join(outside, "secret.txt"), "outside bytes\n", "utf8");
    await link(path.join(outside, "secret.txt"), path.join(workspace.root, "docs", "hard-link.md"));
    await expect(reportCurrentArtifactForTest(workspace, schemas, run.runId, subtask.subtaskId, { path: "docs/hard-link.md", kind: "file" }))
      .rejects.toMatchObject({ code: "ARTIFACT_PATH_INVALID", details: { reason: "hard-link" } });

    await rm(path.join(workspace.root, "docs", "hard-link.md"));
    await writeFile(path.join(workspace.root, "docs", "too-large.md"), "", "utf8");
    await truncate(path.join(workspace.root, "docs", "too-large.md"), 10 * 1024 * 1024 + 1);
    await expect(reportCurrentArtifactForTest(workspace, schemas, run.runId, subtask.subtaskId, { path: "docs/too-large.md", kind: "file" }))
      .rejects.toMatchObject({ code: "ARTIFACT_SIZE_LIMIT", details: { maxBytes: 10 * 1024 * 1024 } });
  });

  it.runIf(process.platform !== "win32")("rejects a FIFO Artifact without blocking the workspace lock", async () => {
    const { workspace, schemas, run } = await setup();
    const subtask = await addSubtask(workspace, schemas, run.runId, {
      goal: "Reject non-files", inputArtifactIds: [], acceptanceCriteria: ["regular file"], scope: ["docs"], capabilities: ["repository-read"]
    });
    await dispatchSubtask(workspace, schemas, run.runId, subtask.subtaskId, "worker-agent");
    await beginCurrentAttemptForTest(workspace, run.runId, subtask.subtaskId);
    await execFileAsync("mkfifo", [path.join(workspace.root, "docs", "pipe.md")]);
    await expect(reportCurrentArtifactForTest(workspace, schemas, run.runId, subtask.subtaskId, { path: "docs/pipe.md", kind: "file" }))
      .rejects.toMatchObject({ code: "ARTIFACT_PATH_INVALID" });
  });

  it("rejects an input while its producer is not ACCEPTED", async () => {
    const { workspace, schemas, run } = await setup();
    await addGuardSubtask(workspace, schemas, run.runId);
    const producer = await addSubtask(workspace, schemas, run.runId, {
      goal: "Produce input", inputArtifactIds: [], acceptanceCriteria: ["producer accepted"], scope: ["docs"], capabilities: ["repository-read"]
    });
    await dispatchSubtask(workspace, schemas, run.runId, producer.subtaskId, "producer-agent");
    await beginCurrentAttemptForTest(workspace, run.runId, producer.subtaskId);
    await writeFile(path.join(workspace.root, "docs", "producer.md"), "not reviewed\n", "utf8");
    const artifact = await reportCurrentArtifactForTest(workspace, schemas, run.runId, producer.subtaskId, { path: "docs/producer.md", kind: "file" });

    await expect(addSubtask(workspace, schemas, run.runId, {
      goal: "Consume producer", inputArtifactIds: [artifact.artifactId], acceptanceCriteria: ["consumed"],
      scope: ["docs"], capabilities: ["repository-read"]
    })).rejects.toMatchObject({ code: "SUBTASK_INPUT_PRODUCER_INVALID" });
  });

  it("accepts only an artifact from the producer's current accepted retry generation", async () => {
    const { workspace, schemas, run } = await setup();
    await addGuardSubtask(workspace, schemas, run.runId);
    const producer = await addSubtask(workspace, schemas, run.runId, {
      goal: "Produce retryable input", inputArtifactIds: [], acceptanceCriteria: ["producer accepted"], scope: ["docs"], capabilities: ["repository-read"]
    });
    await dispatchSubtask(workspace, schemas, run.runId, producer.subtaskId, "producer-agent");
    await beginCurrentAttemptForTest(workspace, run.runId, producer.subtaskId);
    await writeFile(path.join(workspace.root, "docs", "producer.md"), "attempt zero\n", "utf8");
    const oldArtifact = await reportCurrentArtifactForTest(workspace, schemas, run.runId, producer.subtaskId, { path: "docs/producer.md", kind: "file" });
    await recordCurrentReviewForTest(workspace, schemas, run.runId, producer.subtaskId,
      reviewInput("REJECTED", 40, [{ location: "docs/producer.md", problem: "stale", suggestion: "retry" }], "retry", ["producer accepted"]));
    await dispatchSubtask(workspace, schemas, run.runId, producer.subtaskId, "producer-agent", 1);
    await beginCurrentAttemptForTest(workspace, run.runId, producer.subtaskId);
    await writeFile(path.join(workspace.root, "docs", "producer.md"), "attempt one\n", "utf8");
    const currentArtifact = await reportCurrentArtifactForTest(workspace, schemas, run.runId, producer.subtaskId, { path: "docs/producer.md", kind: "file" });
    await recordCurrentReviewForTest(workspace, schemas, run.runId, producer.subtaskId,
      reviewInput("ACCEPTED", 90, [], "accepted current generation", ["producer accepted"]));

    await expect(addSubtask(workspace, schemas, run.runId, {
      goal: "Consume stale generation", inputArtifactIds: [oldArtifact.artifactId], acceptanceCriteria: ["consumed"],
      scope: ["docs"], capabilities: ["repository-read"]
    })).rejects.toMatchObject({ code: "SUBTASK_INPUT_PRODUCER_INVALID" });
    const consumer = await addSubtask(workspace, schemas, run.runId, {
      goal: "Consume current generation", inputArtifactIds: [currentArtifact.artifactId], acceptanceCriteria: ["consumed"],
      scope: ["docs"], capabilities: ["repository-read"]
    });
    expect(consumer.inputArtifacts).toEqual([expect.objectContaining({ artifactId: currentArtifact.artifactId, contentHash: currentArtifact.contentHash })]);
  });

  it("rejects cross-run input artifacts", async () => {
    const { workspace, schemas, run } = await setup();
    await addGuardSubtask(workspace, schemas, run.runId);
    const { artifact } = await reportAcceptedProducer(workspace, schemas, run.runId);
    const otherContract = await createContract(workspace, schemas, {
      taskId: "orch-task", domain: "compliance", goal: "separate run",
      globalAcceptanceCriteria: ["separate"], scope: ["docs"]
    });
    const otherRun = await createRun(workspace, schemas, { contractRef: otherContract.contractId });
    await expect(addSubtask(workspace, schemas, otherRun.runId, {
      goal: "Consume other run", inputArtifactIds: [artifact.artifactId], acceptanceCriteria: ["consumed"],
      scope: ["docs"], capabilities: ["repository-read"]
    })).rejects.toMatchObject({ code: "SUBTASK_INPUT_BINDING_MISMATCH" });
  });

  it("revalidates producer acceptance and generation again at dispatch", async () => {
    const { workspace, schemas, run } = await setup();
    await addGuardSubtask(workspace, schemas, run.runId);
    const { producer, artifact } = await reportAcceptedProducer(workspace, schemas, run.runId);
    const consumer = await addSubtask(workspace, schemas, run.runId, {
      goal: "Consume producer", inputArtifactIds: [artifact.artifactId], acceptanceCriteria: ["consumed"],
      scope: ["docs"], capabilities: ["repository-read"]
    });
    const producerFile = path.join(workspace.directory, "orchestration", `${producer.subtaskId}.json`);
    await writeFile(producerFile, `${JSON.stringify({ ...producer, retriesUsed: producer.retriesUsed + 1 }, null, 2)}\n`, "utf8");
    await expect(dispatchSubtask(workspace, schemas, run.runId, consumer.subtaskId, "consumer-agent"))
      .rejects.toMatchObject({ code: "SUBTASK_INPUT_PRODUCER_INVALID" });

    await writeFile(producerFile, `${JSON.stringify({ ...producer, status: "REJECTED" }, null, 2)}\n`, "utf8");
    await expect(dispatchSubtask(workspace, schemas, run.runId, consumer.subtaskId, "consumer-agent"))
      .rejects.toMatchObject({ code: "SUBTASK_INPUT_PRODUCER_INVALID" });
  });

  it("refuses dispatch when a verified input file changes after the consumer was created", async () => {
    const { workspace, schemas, run } = await setup();
    await addGuardSubtask(workspace, schemas, run.runId);
    const { artifact } = await reportAcceptedProducer(workspace, schemas, run.runId);
    const consumer = await addSubtask(workspace, schemas, run.runId, {
      goal: "Consume producer", inputArtifactIds: [artifact.artifactId], acceptanceCriteria: ["consumed"],
      scope: ["docs"], capabilities: ["repository-read"]
    });
    await writeFile(path.join(workspace.root, artifact.path), "changed after verification\n", "utf8");
    await expect(dispatchSubtask(workspace, schemas, run.runId, consumer.subtaskId, "consumer-agent"))
      .rejects.toMatchObject({ code: "ARTIFACT_STALE" });
  });

  it("revalidates real input bytes again at begin", async () => {
    const { workspace, schemas, run } = await setup();
    await addGuardSubtask(workspace, schemas, run.runId);
    const { artifact } = await reportAcceptedProducer(workspace, schemas, run.runId);
    const consumer = await addSubtask(workspace, schemas, run.runId, {
      goal: "Consume producer", inputArtifactIds: [artifact.artifactId], acceptanceCriteria: ["consumed"],
      scope: ["docs"], capabilities: ["repository-read"]
    });
    await dispatchSubtask(workspace, schemas, run.runId, consumer.subtaskId, "consumer-agent");
    await writeFile(path.join(workspace.root, artifact.path), "changed before begin\n", "utf8");
    await expect(beginCurrentAttemptForTest(workspace, run.runId, consumer.subtaskId))
      .rejects.toMatchObject({ code: "ARTIFACT_STALE" });
  });

  it("revalidates current output bytes at review and completion", async () => {
    const { workspace, schemas, run } = await setup();
    const reviewStale = await addSubtask(workspace, schemas, run.runId, {
      goal: "Review fresh bytes", inputArtifactIds: [], acceptanceCriteria: ["fresh"], scope: ["docs/review"], capabilities: ["repository-read"]
    });
    await mkdir(path.join(workspace.root, "docs", "review"), { recursive: true });
    await dispatchSubtask(workspace, schemas, run.runId, reviewStale.subtaskId, "worker-review");
    await beginCurrentAttemptForTest(workspace, run.runId, reviewStale.subtaskId);
    await writeFile(path.join(workspace.root, "docs", "review", "result.md"), "before review\n", "utf8");
    await reportCurrentArtifactForTest(workspace, schemas, run.runId, reviewStale.subtaskId, { path: "docs/review/result.md", kind: "file" });
    await writeFile(path.join(workspace.root, "docs", "review", "result.md"), "changed before review\n", "utf8");
    await expect(recordCurrentReviewForTest(workspace, schemas, run.runId, reviewStale.subtaskId,
      reviewInput("ACCEPTED", 90, [], "fresh", ["fresh"]))).rejects.toMatchObject({ code: "ARTIFACT_STALE" });

    const { workspace: completionWorkspace, schemas: completionSchemas, run: completionRun } = await setup();
    const completionStale = await addSubtask(completionWorkspace, completionSchemas, completionRun.runId, {
      goal: "Complete fresh bytes", inputArtifactIds: [], acceptanceCriteria: GLOBAL_CRITERIA, scope: ["docs/complete"], capabilities: ["repository-read"]
    });
    await mkdir(path.join(completionWorkspace.root, "docs", "complete"), { recursive: true });
    await dispatchSubtask(completionWorkspace, completionSchemas, completionRun.runId, completionStale.subtaskId, "worker-complete");
    await beginCurrentAttemptForTest(completionWorkspace, completionRun.runId, completionStale.subtaskId);
    await writeFile(path.join(completionWorkspace.root, "docs", "complete", "result.md"), "before completion\n", "utf8");
    await reportCurrentArtifactForTest(completionWorkspace, completionSchemas, completionRun.runId, completionStale.subtaskId, { path: "docs/complete/result.md", kind: "file" });
    await recordCurrentReviewForTest(completionWorkspace, completionSchemas, completionRun.runId, completionStale.subtaskId,
      reviewInput("ACCEPTED", 90, [], "accepted", GLOBAL_CRITERIA));
    await writeFile(path.join(completionWorkspace.root, "docs", "complete", "result.md"), "changed before completion\n", "utf8");
    await expect(completeRound(completionWorkspace, completionRun.runId, { passed: true, note: "caller claims consistency" }))
      .rejects.toMatchObject({ code: "ARTIFACT_STALE" });
  });

  it("persists engine-executed validator receipts and ignores caller-authored passing JSON", async () => {
    const { workspace, schemas, run } = await setup();
    const subtask = await addSubtask(workspace, schemas, run.runId, {
      goal: "Receipt-bound review", inputArtifactIds: [], acceptanceCriteria: ["checked"], scope: ["docs"], capabilities: ["repository-read"]
    });
    await dispatchSubtask(workspace, schemas, run.runId, subtask.subtaskId, "worker");
    await beginCurrentAttemptForTest(workspace, run.runId, subtask.subtaskId);
    await writeFile(path.join(workspace.root, "docs", "receipt.md"), "receipt\n", "utf8");
    await reportCurrentArtifactForTest(workspace, schemas, run.runId, subtask.subtaskId, { path: "docs/receipt.md", kind: "file" });
    const result = await recordCurrentReviewForTest(workspace, schemas, run.runId, subtask.subtaskId, {
      ...reviewInput("ACCEPTED", 90, [], "checked", ["checked"]),
      validatorEvidence: [{ validator: "caller-says-pass", passed: true, detail: "untrusted" }]
    });
    expect(result.review).not.toHaveProperty("validatorEvidence");
    expect(result.review.validatorReceiptIds).toHaveLength(1);
    const receipt = await getValidatorReceipt(workspace, result.review.validatorReceiptIds[0]!);
    expect(receipt).toMatchObject({
      source: "ENGINE_EXECUTED",
      validatorId: "artifact-bytes",
      status: "PASSED",
      runRef: run.runId,
      subtaskRef: subtask.subtaskId,
      attempt: 0,
      reviewRef: result.review.reviewId,
      storageBoundary: "JOURNALED_TRANSACTION"
    });
  });

  it("does not let caller-authored passing validator JSON accept a missing artifact", async () => {
    const { workspace, schemas, run } = await setup();
    const subtask = await addSubtask(workspace, schemas, run.runId, {
      goal: "No artifact", inputArtifactIds: [], acceptanceCriteria: ["checked"], scope: ["docs"], capabilities: ["repository-read"]
    });
    await dispatchSubtask(workspace, schemas, run.runId, subtask.subtaskId, "worker");
    await beginCurrentAttemptForTest(workspace, run.runId, subtask.subtaskId);
    await expect(recordCurrentReviewForTest(workspace, schemas, run.runId, subtask.subtaskId, {
      ...reviewInput("ACCEPTED", 90, [], "checked", ["checked"]),
      validatorEvidence: [{ validator: "caller-says-pass", passed: true, detail: "untrusted" }]
    })).rejects.toMatchObject({ code: "REVIEW_ARTIFACT_REQUIRED" });
  });

  it("rejects round completion with active attempts or unresolved write intents", async () => {
    const { workspace, schemas, run } = await setup();
    const subtask = await addSubtask(workspace, schemas, run.runId, {
      goal: "Still working", inputArtifactIds: [], acceptanceCriteria: GLOBAL_CRITERIA, scope: ["docs"], capabilities: ["repository-read", "repository-write"]
    });
    await dispatchSubtask(workspace, schemas, run.runId, subtask.subtaskId, "worker");
    await beginCurrentAttemptForTest(workspace, run.runId, subtask.subtaskId);
    await expect(completeRound(workspace, run.runId, { passed: true, note: "premature" }))
      .rejects.toMatchObject({ code: "ROUND_ACTIVE_ATTEMPTS" });

    await writeFile(path.join(workspace.root, "docs", "done.md"), "done\n", "utf8");
    await reportCurrentArtifactForTest(workspace, schemas, run.runId, subtask.subtaskId, { path: "docs/done.md", kind: "file" });
    const reviewing = await getSubtask(workspace, subtask.subtaskId);
    const subtaskPath = path.join(workspace.directory, "orchestration", `${subtask.subtaskId}.json`);
    // Manually stage the crash/legacy shape that the recordReview fence must
    // diagnose: a REVIEWING subtask with a still-unresolved attempt intent.
    await writeFile(subtaskPath, `${JSON.stringify({ ...reviewing, status: "RUNNING" }, null, 2)}\n`, "utf8");
    const { requestWrites, rejectWrites } = await import("../src/storage/write-intents.js");
    const intent = await requestWrites(workspace, schemas, "-", "-", [
      { target: "docs/pending.md", action: "create", purpose: "unresolved completion gate" }
    ], { autoAllow: true, runRef: run.runId, subtaskRef: subtask.subtaskId });
    await writeFile(subtaskPath, `${JSON.stringify(reviewing, null, 2)}\n`, "utf8");
    await expect(recordCurrentReviewForTest(workspace, schemas, run.runId, subtask.subtaskId,
      reviewInput("ACCEPTED", 90, [], "done", GLOBAL_CRITERIA)))
      .rejects.toMatchObject({ code: "SUBTASK_WRITE_INTENT_CONFLICT" });
    await rejectWrites(workspace, "-", "-", intent.writeIntentId, "Resolve the attempt before review.");
    await recordCurrentReviewForTest(workspace, schemas, run.runId, subtask.subtaskId,
      reviewInput("ACCEPTED", 90, [], "done", GLOBAL_CRITERIA));
    await expect(completeRound(workspace, run.runId, { passed: true, note: "intent resolved" }))
      .resolves.toMatchObject({ status: "COMPLETED" });
  });

  it("rejects stale persisted attempt generations", async () => {
    const { workspace, schemas, run } = await setup();
    const subtask = await addSubtask(workspace, schemas, run.runId, {
      goal: "Generation bound", inputArtifactIds: [], acceptanceCriteria: ["checked"], scope: ["docs"], capabilities: ["repository-read"]
    });
    const dispatched = await dispatchSubtask(workspace, schemas, run.runId, subtask.subtaskId, "worker");
    const subtaskPath = path.join(workspace.directory, "orchestration", `${subtask.subtaskId}.json`);
    await writeFile(subtaskPath, `${JSON.stringify({ ...dispatched.subtask, activeAttempt: dispatched.subtask.retriesUsed + 1 }, null, 2)}\n`, "utf8");
    await expect(beginCurrentAttemptForTest(workspace, run.runId, subtask.subtaskId))
      .rejects.toMatchObject({ code: "SUBTASK_GENERATION_STALE" });
  });

  it("rejects delayed worker mutations from an older retry generation", async () => {
    const { workspace, schemas, run } = await setup();
    const subtask = await addSubtask(workspace, schemas, run.runId, {
      goal: "Generation token", inputArtifactIds: [], acceptanceCriteria: ["checked"],
      scope: ["docs"], capabilities: ["repository-read"], maxRetries: 2
    });
    const firstDispatch = await dispatchSubtask(workspace, schemas, run.runId, subtask.subtaskId, "worker");
    const oldAttempt = firstDispatch.subtask.activeAttempt!;
    await beginCurrentAttemptForTest(workspace, run.runId, subtask.subtaskId, oldAttempt);
    await recordCurrentReviewForTest(workspace, schemas, run.runId, subtask.subtaskId, {
      ...reviewInput("REJECTED", 40, [{ location: "docs", problem: "retry", suggestion: "retry" }], "retry", ["checked"]),
      expectedAttempt: oldAttempt
    });

    const currentDispatch = await dispatchSubtask(workspace, schemas, run.runId, subtask.subtaskId, "worker", oldAttempt + 1);
    const currentAttempt = currentDispatch.subtask.activeAttempt!;
    expect(currentAttempt).toBe(oldAttempt + 1);
    await expect(beginCurrentAttemptForTest(workspace, run.runId, subtask.subtaskId, oldAttempt))
      .rejects.toMatchObject({ code: "SUBTASK_GENERATION_STALE" });
    await beginCurrentAttemptForTest(workspace, run.runId, subtask.subtaskId, currentAttempt);

    await writeFile(path.join(workspace.root, "docs", "generation.md"), "current generation\n", "utf8");
    await expect(reportCurrentArtifactForTest(workspace, schemas, run.runId, subtask.subtaskId, {
      path: "docs/generation.md", kind: "file", expectedAttempt: oldAttempt
    })).rejects.toMatchObject({ code: "SUBTASK_GENERATION_STALE" });
    await reportCurrentArtifactForTest(workspace, schemas, run.runId, subtask.subtaskId, {
      path: "docs/generation.md", kind: "file", expectedAttempt: currentAttempt
    });

    await expect(recordCurrentReviewForTest(workspace, schemas, run.runId, subtask.subtaskId, {
      ...reviewInput("ACCEPTED", 90, [], "stale review", ["checked"]), expectedAttempt: oldAttempt
    })).rejects.toMatchObject({ code: "SUBTASK_GENERATION_STALE" });
    await expect(recordCurrentReviewForTest(workspace, schemas, run.runId, subtask.subtaskId, {
      ...reviewInput("ACCEPTED", 90, [], "current review", ["checked"]), expectedAttempt: currentAttempt
    })).resolves.toMatchObject({ subtask: { status: "ACCEPTED" }, review: { attempt: currentAttempt } });
  });

  it("cancellation durably fences the run, revokes its leases, and rejects outstanding write intents", async () => {
    const { workspace, schemas, run } = await setup();
    const subtask = await addSubtask(workspace, schemas, run.runId, {
      goal: "Write cancellable output", inputArtifactIds: [], acceptanceCriteria: ["written"],
      scope: ["docs"], capabilities: ["repository-read", "repository-write"]
    });
    const dispatched = await dispatchSubtask(workspace, schemas, run.runId, subtask.subtaskId, "worker-agent");
    await beginCurrentAttemptForTest(workspace, run.runId, subtask.subtaskId);
    const { requestWrites, getWriteIntent } = await import("../src/storage/write-intents.js");
    const writeLease = (await import("../src/storage/leases.js").then((module) => module.listLeases(workspace)))
      .find((lease) => lease.capability === "repository-write" && lease.subtaskRef === subtask.subtaskId)!;
    const intent = await requestWrites(workspace, schemas, "-", "-", [
      { target: "docs/cancelled.md", action: "create", purpose: "cancellable worker output" }
    ], { autoAllow: true, runRef: run.runId, subtaskRef: subtask.subtaskId });
    expect(intent.status).toBe("CONFIRMED");

    const cancelled = await cancelRun(workspace, run.runId);
    expect(cancelled.status).toBe("CANCELLED");
    const { getLease } = await import("../src/storage/leases.js");
    for (const leaseId of dispatched.leases) expect((await getLease(workspace, leaseId)).status).toBe("revoked");
    expect((await getWriteIntent(workspace, intent.writeIntentId)).status).toBe("REJECTED");
    const { getRunCancellationFence } = await import("../src/storage/orchestration-fence.js");
    expect(await getRunCancellationFence(workspace, run.runId)).toMatchObject({ status: "CANCELLED" });
    await expect(reportCurrentArtifactForTest(workspace, schemas, run.runId, subtask.subtaskId, { path: "docs/cancelled.md", kind: "file" }))
      .rejects.toMatchObject({ code: "RUN_STATE_CONFLICT" });
    await expect(requestWrites(workspace, schemas, "-", "-", [
      { target: "docs/after-cancel.md", action: "create", purpose: "must remain fenced" }
    ], { autoAllow: true, runRef: run.runId, subtaskRef: subtask.subtaskId }))
      .rejects.toMatchObject({ code: "WRITE_RUN_STATE" });
  });

  it("rejects a new subtask WriteIntent after Task authority drift without durable side effects", async () => {
    const { workspace, schemas, run, task } = await setup();
    const subtask = await addSubtask(workspace, schemas, run.runId, {
      goal: "Write drift-sensitive output", inputArtifactIds: [], acceptanceCriteria: ["written"],
      scope: ["docs"], capabilities: ["repository-read", "repository-write"]
    });
    await dispatchSubtask(workspace, schemas, run.runId, subtask.subtaskId, "worker-agent");
    await beginCurrentAttemptForTest(workspace, run.runId, subtask.subtaskId);
    const { requestWrites, listWriteIntents } = await import("../src/storage/write-intents.js");
    const beforeIntents = await listWriteIntents(workspace);
    const beforeLedger = await listLedgerEntries(workspace);
    await saveTask(workspace, { ...task, constraints: ["authority drift before write request"] });

    await expect(requestWrites(workspace, schemas, "-", "-", [
      { target: "docs/after-drift.md", action: "create", purpose: "must be denied" }
    ], { autoAllow: true, runRef: run.runId, subtaskRef: subtask.subtaskId }))
      .rejects.toMatchObject({ code: "TASK_AUTHORITY_STALE" });
    expect(await listWriteIntents(workspace)).toEqual(beforeIntents);
    expect(await listLedgerEntries(workspace)).toEqual(beforeLedger);
  });

  it("rejects subtask WriteIntent confirmation after Task authority drift without consuming its Approval", async () => {
    const { workspace, schemas, run, task } = await setup();
    const subtask = await addSubtask(workspace, schemas, run.runId, {
      goal: "Write confirmed output", inputArtifactIds: [], acceptanceCriteria: ["written"],
      scope: ["docs"], capabilities: ["repository-read", "repository-write"]
    });
    await dispatchSubtask(workspace, schemas, run.runId, subtask.subtaskId, "worker-agent");
    await beginCurrentAttemptForTest(workspace, run.runId, subtask.subtaskId);
    const { requestWrites, confirmWrites, getWriteIntent } = await import("../src/storage/write-intents.js");
    const intent = await requestWrites(workspace, schemas, "-", "-", [
      { target: "docs/pending.md", action: "create", purpose: "explicit confirmation" }
    ], { runRef: run.runId, subtaskRef: subtask.subtaskId });
    const approval = await approveWriteIntent(workspace, schemas, intent);
    const beforeLedger = await listLedgerEntries(workspace);
    await saveTask(workspace, { ...task, constraints: ["authority drift before confirmation"] });

    await expect(confirmWrites(workspace, "-", "-", intent.writeIntentId, schemas))
      .rejects.toMatchObject({ code: "TASK_AUTHORITY_STALE" });
    expect(await getWriteIntent(workspace, intent.writeIntentId)).toMatchObject({ status: "PENDING" });
    expect(await getApproval(workspace, approval.id)).not.toHaveProperty("consumedAt");
    expect(await listLedgerEntries(workspace)).toEqual(beforeLedger);
  });

  it("completes only after accepted subtasks exactly cover all global criteria and consistency has passed", async () => {
    const { workspace, schemas, run } = await setup();
    await completeRound(workspace, run.runId, { passed: true, note: "global consistency passed" });
    const first = await addSubtask(workspace, schemas, run.runId, {
      goal: "Cover first criteria", inputArtifactIds: [], acceptanceCriteria: GLOBAL_CRITERIA.slice(0, 2), scope: ["docs"], capabilities: ["repository-read"]
    });
    const second = await addSubtask(workspace, schemas, run.runId, {
      goal: "Cover remaining criteria", inputArtifactIds: [], acceptanceCriteria: GLOBAL_CRITERIA.slice(2), scope: ["docs"], capabilities: ["repository-read"]
    });
    for (const [subtask, file] of [[first, "docs/first.md"], [second, "docs/second.md"]] as const) {
      await dispatchSubtask(workspace, schemas, run.runId, subtask.subtaskId, "worker-agent");
      await beginCurrentAttemptForTest(workspace, run.runId, subtask.subtaskId);
      await writeFile(path.join(workspace.root, file), `${subtask.goal}\n`, "utf8");
      await reportCurrentArtifactForTest(workspace, schemas, run.runId, subtask.subtaskId, { path: file, kind: "file" });
      const result = await recordCurrentReviewForTest(workspace, schemas, run.runId, subtask.subtaskId,
        reviewInput("ACCEPTED", 90, [], "covered", subtask.acceptanceCriteria));
      expect(result.run.status).toBe("RUNNING");
    }
    expect((await completeRound(workspace, run.runId, { passed: true, note: "all covered output remains globally consistent" })).status).toBe("COMPLETED");
  });

  it("does not complete when all subtasks are accepted but one global criterion is uncovered", async () => {
    const { workspace, schemas, run } = await setup();
    const subtask = await addSubtask(workspace, schemas, run.runId, {
      goal: "Cover only part of the contract", inputArtifactIds: [], acceptanceCriteria: GLOBAL_CRITERIA.slice(0, -1),
      scope: ["docs"], capabilities: ["repository-read"]
    });
    await dispatchSubtask(workspace, schemas, run.runId, subtask.subtaskId, "worker-agent");
    await beginCurrentAttemptForTest(workspace, run.runId, subtask.subtaskId);
    await writeFile(path.join(workspace.root, "docs", "partial.md"), "partial coverage\n", "utf8");
    await reportCurrentArtifactForTest(workspace, schemas, run.runId, subtask.subtaskId, { path: "docs/partial.md", kind: "file" });
    const accepted = await recordCurrentReviewForTest(workspace, schemas, run.runId, subtask.subtaskId,
      reviewInput("ACCEPTED", 90, [], "declared criteria pass", subtask.acceptanceCriteria));
    expect(accepted.subtask.status).toBe("ACCEPTED");
    const consistency = await completeRound(workspace, run.runId, { passed: true, note: "reported outputs are internally consistent" });
    expect(consistency.status).toBe("RUNNING");
    expect((await getContract(workspace, run.contractRef)).status).toBe("ACTIVE");
  });

  it("keeps a fully accepted run open until it has a consistency check, then completes on a passed check", async () => {
    const { workspace, schemas, run } = await setup();
    const subtask = await addSubtask(workspace, schemas, run.runId, {
      goal: "Cover contract", inputArtifactIds: [], acceptanceCriteria: GLOBAL_CRITERIA, scope: ["docs"], capabilities: ["repository-read"]
    });
    await dispatchSubtask(workspace, schemas, run.runId, subtask.subtaskId, "worker-agent");
    await beginCurrentAttemptForTest(workspace, run.runId, subtask.subtaskId);
    await writeFile(path.join(workspace.root, "docs", "guide.md"), "complete\n", "utf8");
    await reportCurrentArtifactForTest(workspace, schemas, run.runId, subtask.subtaskId, { path: "docs/guide.md", kind: "file" });
    const accepted = await recordCurrentReviewForTest(workspace, schemas, run.runId, subtask.subtaskId,
      reviewInput("ACCEPTED", 90, [], "accepted", GLOBAL_CRITERIA));
    expect(accepted.run.status).toBe("RUNNING");
    const completed = await completeRound(workspace, run.runId, { passed: true, note: "final consistency passed" });
    expect(completed.status).toBe("COMPLETED");
  });

  it("uses the latest consistency result as the completion gate", async () => {
    const { workspace, schemas, run } = await setup();
    await completeRound(workspace, run.runId, { passed: true, note: "initial pass" });
    await completeRound(workspace, run.runId, { passed: false, note: "later drift" });
    const subtask = await addSubtask(workspace, schemas, run.runId, {
      goal: "Cover contract", inputArtifactIds: [], acceptanceCriteria: GLOBAL_CRITERIA, scope: ["docs"], capabilities: ["repository-read"]
    });
    await dispatchSubtask(workspace, schemas, run.runId, subtask.subtaskId, "worker-agent");
    await beginCurrentAttemptForTest(workspace, run.runId, subtask.subtaskId);
    await writeFile(path.join(workspace.root, "docs", "guide.md"), "complete\n", "utf8");
    await reportCurrentArtifactForTest(workspace, schemas, run.runId, subtask.subtaskId, { path: "docs/guide.md", kind: "file" });
    const accepted = await recordCurrentReviewForTest(workspace, schemas, run.runId, subtask.subtaskId,
      reviewInput("ACCEPTED", 90, [], "accepted", GLOBAL_CRITERIA));
    expect(accepted.run.status).toBe("RUNNING");
    const completed = await completeRound(workspace, run.runId, { passed: true, note: "drift resolved" });
    expect(completed.status).toBe("COMPLETED");
  });
});

describe("domain routing (specialist)", () => {
  it("requires a user-confirmed domain on contract creation", async () => {
    const { workspace, schemas } = await setup();
    await expect(createContract(workspace, schemas, { taskId: "orch-task", domain: "", goal: "g", globalAcceptanceCriteria: ["a"], scope: ["docs"] })).rejects.toMatchObject({ code: "CONTRACT_DOMAIN_INVALID" });
  });

  it("injects the contract-domain specialist instructions into every subtask", async () => {
    const { workspace, schemas, run } = await setup(); // setup uses domain "compliance"
    const subtask = await addSubtask(workspace, schemas, run.runId, {
      goal: "Write docs/guide.md",
      inputArtifactIds: [],
      acceptanceCriteria: ["guide.md exists"],
      scope: ["docs"],
      capabilities: ["repository-read"]
    });
    expect(subtask.domain).toBe("compliance");
    expect(subtask.domainInstructions[0]).toContain("合规");
    expect(subtask.domainInstructions.some((i) => i.startsWith("验收："))).toBe(true);
    expect(subtask.domainInstructions.some((i) => i.startsWith("禁止："))).toBe(true);
  });

  it("narrows to a sub-domain (prefix match) via subtask domain override", async () => {
    const { workspace, schemas, run } = await setup(); // contract domain "compliance"
    const subtask = await addSubtask(workspace, schemas, run.runId, {
      goal: "Write docs/guide.md",
      inputArtifactIds: [],
      acceptanceCriteria: ["guide.md exists"],
      scope: ["docs"],
      capabilities: ["repository-read"],
      domain: "content"
    });
    expect(subtask.domain).toBe("content");
    expect(subtask.domainInstructions[0]).toContain("内容创作");
  });

  it("falls back to the general specialist for unknown contract domains", async () => {
    const { workspace, schemas } = await setup();
    const contract = await createContract(workspace, schemas, { taskId: "orch-task", domain: "quantum-physics", goal: "g", globalAcceptanceCriteria: ["a", "b", "c", "d"], scope: ["docs"] });
    const run = await createRun(workspace, schemas, { contractRef: contract.contractId });
    const subtask = await addSubtask(workspace, schemas, run.runId, {
      goal: "Write docs/guide.md",
      inputArtifactIds: [],
      acceptanceCriteria: ["guide.md exists"],
      scope: ["docs"],
      capabilities: ["repository-read"]
    });
    expect(subtask.domain).toBe("quantum-physics");
    expect(subtask.domainInstructions[0]).toContain("通用工程执行者");
  });
});

describe("token budget (P0-1: host-reported tokens)", () => {
  it("accumulates tokens into the run budget and fails the run on TOKEN_BUDGET", async () => {
    const { workspace, schemas } = await setup();
    const contract = await createContract(workspace, schemas, { taskId: "orch-task", domain: "compliance", goal: "g", globalAcceptanceCriteria: ["a", "b", "c", "d"], scope: ["docs"] });
    const run = await createRun(workspace, schemas, { contractRef: contract.contractId, maxSubtaskTokens: 5000 });
    const subtask = await addSubtask(workspace, schemas, run.runId, { goal: "write", inputArtifactIds: [], acceptanceCriteria: ["x"], scope: ["docs"], capabilities: ["repository-read"] });
    await dispatchSubtask(workspace, schemas, run.runId, subtask.subtaskId, "agent");
    await beginCurrentAttemptForTest(workspace, run.runId, subtask.subtaskId);
    await writeFile(path.join(workspace.root, "docs", "guide.md"), "v1\n", "utf8");
    await reportCurrentArtifactForTest(workspace, schemas, run.runId, subtask.subtaskId, { path: "docs/guide.md", kind: "file" });
    const first = await recordCurrentReviewForTest(workspace, schemas, run.runId, subtask.subtaskId, { ...reviewInput("REJECTED", 40, [{ location: "a", problem: "p1", suggestion: "s1" }], "reviewed", ["x"]), tokensUsed: 3000 });
    expect(first.run.budget.usedTokens).toBe(3000);
    expect(first.run.status).toBe("RUNNING");
    expect(first.review.tokenAccounting).toEqual({ status: "ESTIMATED", chargedTokens: 3000 });
    expect(first.review.tokenAccounting).not.toHaveProperty("providerReceiptRef");
    // second round: cumulative 6000 > 5000 → TOKEN_BUDGET fails the run
    await dispatchSubtask(workspace, schemas, run.runId, subtask.subtaskId, "agent", 1);
    await beginCurrentAttemptForTest(workspace, run.runId, subtask.subtaskId);
    await writeFile(path.join(workspace.root, "docs", "guide.md"), "v2\n", "utf8");
    await reportCurrentArtifactForTest(workspace, schemas, run.runId, subtask.subtaskId, { path: "docs/guide.md", kind: "file" });
    const second = await recordCurrentReviewForTest(workspace, schemas, run.runId, subtask.subtaskId, { ...reviewInput("REJECTED", 40, [{ location: "b", problem: "p2", suggestion: "s2" }], "reviewed", ["x"]), tokensUsed: 3000 });
    expect(second.run.budget.usedTokens).toBe(6000);
    expect(second.run.status).toBe("FAILED");
    expect(second.run.escalationReason ?? "").toContain("TOKEN_BUDGET");
  });

  it("blocks another execution at the exact token cap", async () => {
    const { workspace, schemas } = await setup();
    const contract = await createContract(workspace, schemas, { taskId: "orch-task", domain: "compliance", goal: "g", globalAcceptanceCriteria: ["a", "b", "c", "d"], scope: ["docs"] });
    const run = await createRun(workspace, schemas, { contractRef: contract.contractId, maxSubtaskTokens: 1000, maxRetriesPerSubtask: 3 });
    const subtask = await addSubtask(workspace, schemas, run.runId, { goal: "write", inputArtifactIds: [], acceptanceCriteria: ["x"], scope: ["docs"], capabilities: ["repository-read"] });
    await dispatchSubtask(workspace, schemas, run.runId, subtask.subtaskId, "agent");
    await beginCurrentAttemptForTest(workspace, run.runId, subtask.subtaskId);
    const reviewed = await recordCurrentReviewForTest(workspace, schemas, run.runId, subtask.subtaskId, {
      ...reviewInput("REJECTED", 40, [{ location: "a", problem: "p", suggestion: "s" }], "reviewed", ["x"]),
      tokensUsed: 1000
    });
    expect(reviewed.run).toMatchObject({ status: "RUNNING", budget: { usedTokens: 1000, maxSubtaskTokens: 1000 } });
    await expect(dispatchSubtask(workspace, schemas, run.runId, subtask.subtaskId, "agent", 1))
      .rejects.toMatchObject({ code: "TOKEN_BUDGET_EXHAUSTED" });
    await expect(addSubtask(workspace, schemas, run.runId, { goal: "more", inputArtifactIds: [], acceptanceCriteria: ["y"], scope: ["docs"], capabilities: ["repository-read"] }))
      .rejects.toMatchObject({ code: "TOKEN_BUDGET_EXHAUSTED" });
    await escalateRun(workspace, run.runId, "human must raise the exhausted token budget");
    await expect(resumeRun(workspace, run.runId, { expectedResumeGeneration: 1 })).rejects.toMatchObject({ code: "RUN_RESUME_BUDGET_INVALID" });
    await expect(resumeRun(workspace, run.runId, { expectedResumeGeneration: 1, maxSubtaskTokens: 1000 })).rejects.toMatchObject({ code: "RUN_RESUME_BUDGET_INVALID" });
    const resumed = await resumeRun(workspace, run.runId, { expectedResumeGeneration: 1, maxSubtaskTokens: 2000 });
    expect(resumed).toMatchObject({ status: "RUNNING", budget: { usedTokens: 1000, maxSubtaskTokens: 2000 } });
    await expect(dispatchSubtask(workspace, schemas, run.runId, subtask.subtaskId, "agent", 1))
      .resolves.toMatchObject({ subtask: { status: "DISPATCHED" } });
  });

  it("fails on a hard token overrun even when the same review also detects oscillation", async () => {
    const { workspace, schemas } = await setup();
    const contract = await createContract(workspace, schemas, { taskId: "orch-task", domain: "compliance", goal: "g", globalAcceptanceCriteria: ["a", "b", "c", "d"], scope: ["docs"] });
    const run = await createRun(workspace, schemas, { contractRef: contract.contractId, maxSubtaskTokens: 1000, maxRetriesPerSubtask: 3 });
    const subtask = await addSubtask(workspace, schemas, run.runId, { goal: "write", inputArtifactIds: [], acceptanceCriteria: ["x"], scope: ["docs"], capabilities: ["repository-read"] });
    const repeatedDefect = [{ location: "docs/guide.md", problem: "same defect", suggestion: "fix it" }];

    await dispatchSubtask(workspace, schemas, run.runId, subtask.subtaskId, "agent");
    await beginCurrentAttemptForTest(workspace, run.runId, subtask.subtaskId);
    await recordCurrentReviewForTest(workspace, schemas, run.runId, subtask.subtaskId, { ...reviewInput("REJECTED", 40, repeatedDefect, "first", ["x"]), tokensUsed: 600 });
    await dispatchSubtask(workspace, schemas, run.runId, subtask.subtaskId, "agent", 1);
    await beginCurrentAttemptForTest(workspace, run.runId, subtask.subtaskId);
    const escalated = await recordCurrentReviewForTest(workspace, schemas, run.runId, subtask.subtaskId, { ...reviewInput("REJECTED", 40, repeatedDefect, "again", ["x"]), tokensUsed: 600 });
    expect(escalated.run).toMatchObject({ status: "FAILED", budget: { usedTokens: 1200, maxSubtaskTokens: 1000 } });
    expect(escalated.run.escalationReason).toContain("TOKEN_BUDGET");
  });
});

describe("resume after escalation (P0-2: human decision path)", () => {
  it("resumes an ESCALATED run to RUNNING with optional budget adjustment", async () => {
    const { workspace, schemas } = await setup();
    const contract = await createContract(workspace, schemas, { taskId: "orch-task", domain: "compliance", goal: "g", globalAcceptanceCriteria: ["a", "b", "c", "d"], scope: ["docs"] });
    const run = await createRun(workspace, schemas, { contractRef: contract.contractId });
    // add the subtask while RUNNING (subtasks require a RUNNING run)
    const subtask = await addSubtask(workspace, schemas, run.runId, { goal: "write", inputArtifactIds: [], acceptanceCriteria: ["x"], scope: ["docs"], capabilities: ["repository-read"] });
    const escalated = await escalateRun(workspace, run.runId, "oscillation detected; human decision needed");
    expect(escalated.status).toBe("ESCALATED");
    // work is blocked while ESCALATED
    await expect(dispatchSubtask(workspace, schemas, run.runId, subtask.subtaskId, "agent")).rejects.toMatchObject({ code: "RUN_STATE_CONFLICT" });
    // human resumes with adjusted budget
    const resumed = await resumeRun(workspace, run.runId, { expectedResumeGeneration: 1, maxRounds: 8 });
    expect(resumed.status).toBe("RUNNING");
    expect(resumed.budget.maxRounds).toBe(8);
    expect(resumed.resumedAt).toBeDefined();
    // work continues after resume
    const dispatched = await dispatchSubtask(workspace, schemas, run.runId, subtask.subtaskId, "agent");
    expect(dispatched.subtask.status).toBe("DISPATCHED");
    // ledger records the resume
    const entries = await listLedgerEntries(workspace);
    expect(entries.some((e) => e.event === "orchestration-resumed")).toBe(true);
  });

  it("rejects resuming a non-ESCALATED run", async () => {
    const { workspace, schemas } = await setup();
    const contract = await createContract(workspace, schemas, { taskId: "orch-task", domain: "compliance", goal: "g", globalAcceptanceCriteria: ["a", "b", "c", "d"], scope: ["docs"] });
    const run = await createRun(workspace, schemas, { contractRef: contract.contractId });
    await expect(resumeRun(workspace, run.runId, { expectedResumeGeneration: 1 })).rejects.toMatchObject({ code: "RUN_STATE_CONFLICT" });
  });

  it("enforces the run-schema maxRounds ceiling when resuming", async () => {
    const { workspace, schemas } = await setup();
    const contract = await createContract(workspace, schemas, { taskId: "orch-task", domain: "compliance", goal: "g", globalAcceptanceCriteria: ["a", "b", "c", "d"], scope: ["docs"] });
    const run = await createRun(workspace, schemas, { contractRef: contract.contractId });
    await escalateRun(workspace, run.runId, "human budget decision required");
    await expect(resumeRun(workspace, run.runId, { expectedResumeGeneration: 1, maxRounds: 101 }))
      .rejects.toMatchObject({ code: "RUN_RESUME_BUDGET_INVALID" });
    const resumed = await resumeRun(workspace, run.runId, { expectedResumeGeneration: 1, maxRounds: 100 });
    expect(resumed.budget.maxRounds).toBe(100);
    expect(resumed.status).toBe("RUNNING");
  });
});

describe("criterion correspondence + same-source review (P2)", () => {
  it("rejects reviews with invented or skipped acceptance criteria", async () => {
    const { workspace, schemas, run } = await setup();
    const subtask = await addSubtask(workspace, schemas, run.runId, { goal: "write", inputArtifactIds: [], acceptanceCriteria: ["a", "b"], scope: ["docs"], capabilities: ["repository-read"] });
    await dispatchSubtask(workspace, schemas, run.runId, subtask.subtaskId, "worker-agent");
    await beginCurrentAttemptForTest(workspace, run.runId, subtask.subtaskId);
    await writeFile(path.join(workspace.root, "docs", "guide.md"), "x\n", "utf8");
    await reportCurrentArtifactForTest(workspace, schemas, run.runId, subtask.subtaskId, { path: "docs/guide.md", kind: "file" });
    // invented standard "c" (not declared)
    await expect(recordCurrentReviewForTest(workspace, schemas, run.runId, subtask.subtaskId, {
      ...reviewInput("ACCEPTED", 90, [], "reviewed", ["a", "c"]), reviewedBy: "reviewer-1"
    })).rejects.toMatchObject({ code: "REVIEW_CRITERION_MISMATCH" });
    // skipped standard "b"
    await expect(recordCurrentReviewForTest(workspace, schemas, run.runId, subtask.subtaskId, {
      ...reviewInput("ACCEPTED", 90, [], "reviewed", ["a"]), reviewedBy: "reviewer-1"
    })).rejects.toMatchObject({ code: "REVIEW_CRITERION_MISMATCH" });
    // exact match passes
    const accepted = await recordCurrentReviewForTest(workspace, schemas, run.runId, subtask.subtaskId, {
      ...reviewInput("ACCEPTED", 90, [], "reviewed", ["a", "b"]), reviewedBy: "reviewer-1"
    });
    expect(accepted.subtask.status).toBe("ACCEPTED");
  });

  it("allows and flags same-source reviews only when an individual Contract captured that policy", async () => {
    async function reviewOnce(reviewedBy: string) {
      const { workspace, schemas, run } = await setup("individual");
      const subtask = await addSubtask(workspace, schemas, run.runId, { goal: "write", inputArtifactIds: [], acceptanceCriteria: ["x"], scope: ["docs"], capabilities: ["repository-read"] });
      await dispatchSubtask(workspace, schemas, run.runId, subtask.subtaskId, "worker-1");
      await beginCurrentAttemptForTest(workspace, run.runId, subtask.subtaskId);
      await writeFile(path.join(workspace.root, "docs", "guide.md"), "x\n", "utf8");
      await reportCurrentArtifactForTest(workspace, schemas, run.runId, subtask.subtaskId, { path: "docs/guide.md", kind: "file" });
      return recordCurrentReviewForTest(workspace, schemas, run.runId, subtask.subtaskId, { ...reviewInput("ACCEPTED", 90, [], "reviewed", ["x"]), reviewedBy });
    }
    const sameSource = await reviewOnce("worker-1");
    expect(sameSource.review.sameSourceReview).toBe(true);
    expect(sameSource.review.reviewIndependence).toBe("SELF_REVIEW_NON_INDEPENDENT");
    const independent = await reviewOnce("reviewer-2");
    expect(independent.review.sameSourceReview).toBeUndefined();
    expect(independent.review.reviewIndependence).toBe("INDEPENDENT");
  });

  it("rejects same-source review for team, organization, and regulated profiles", async () => {
    for (const profile of ["team", "organization", "regulated"] as const) {
      const { workspace, schemas, run } = await setup(profile);
      const subtask = await addSubtask(workspace, schemas, run.runId, {
        goal: "review", inputArtifactIds: [], acceptanceCriteria: ["x"], scope: ["docs"], capabilities: ["repository-read"]
      });
      await dispatchSubtask(workspace, schemas, run.runId, subtask.subtaskId, "worker-same");
      await beginCurrentAttemptForTest(workspace, run.runId, subtask.subtaskId);
      await writeFile(path.join(workspace.root, "docs", `${profile}.md`), "ok\n", "utf8");
      await reportCurrentArtifactForTest(workspace, schemas, run.runId, subtask.subtaskId, { path: `docs/${profile}.md`, kind: "file" });
      await expect(recordCurrentReviewForTest(workspace, schemas, run.runId, subtask.subtaskId, {
        ...reviewInput("ACCEPTED", 90, [], "self review", ["x"]), reviewedBy: "worker-same"
      })).rejects.toMatchObject({ code: "INDEPENDENT_REVIEW_REQUIRED", details: { reviewPolicy: "INDEPENDENT_REQUIRED" } });
    }
  });

  it("keeps the strict Contract review policy when workspace config later disappears or becomes invalid", async () => {
    const { workspace, schemas, run } = await setup();
    await writeFile(path.join(workspace.directory, "workspace.json"), JSON.stringify({
      version: 2,
      workspaceId: "workspace-invalid-profile",
      root: workspace.root,
      profile: "individual",
      packs: ["software-engineering"],
      mode: "reviewed-workflow",
      roles: {},
      plugins: {},
      unexpected: true
    }), "utf8");
    const subtask = await addSubtask(workspace, schemas, run.runId, {
      goal: "review", inputArtifactIds: [], acceptanceCriteria: ["x"], scope: ["docs"], capabilities: ["repository-read"]
    });
    await dispatchSubtask(workspace, schemas, run.runId, subtask.subtaskId, "worker-same");
    await beginCurrentAttemptForTest(workspace, run.runId, subtask.subtaskId);
    await writeFile(path.join(workspace.root, "docs", "invalid-profile.md"), "ok\n", "utf8");
    await reportCurrentArtifactForTest(workspace, schemas, run.runId, subtask.subtaskId, { path: "docs/invalid-profile.md", kind: "file" });
    await expect(recordCurrentReviewForTest(workspace, schemas, run.runId, subtask.subtaskId, {
      ...reviewInput("ACCEPTED", 90, [], "self review", ["x"]), reviewedBy: "worker-same"
    })).rejects.toMatchObject({ code: "INDEPENDENT_REVIEW_REQUIRED", details: { reviewPolicy: "INDEPENDENT_REQUIRED" } });
  });
});

describe("cost estimation", () => {
  it("estimates tokens and mode from the contract", async () => {
    const { workspace, schemas, task } = await setup();
    const simple = await createContract(workspace, schemas, { taskId: "orch-task", domain: "frontend", goal: "g", globalAcceptanceCriteria: ["a"], scope: ["docs/guide.md"] });
    const simpleEstimate = estimateRunCost(simple);
    expect(simpleEstimate.mode).toBe("direct");
    expect(simpleEstimate.estimatedSubtasks).toBe(1);
    expect(simpleEstimate.estimatedTokens).toBeLessThan(50000);
    await saveTask(workspace, { ...task, scope: ["docs", "src"] });
    const complex = await createContract(workspace, schemas, { taskId: "orch-task", domain: "backend", goal: "g", globalAcceptanceCriteria: ["a", "b", "c", "d", "e", "f", "g", "h"], scope: ["docs", "src"] });
    const complexEstimate = estimateRunCost(complex);
    expect(complexEstimate.estimatedSubtasks).toBe(4);
    expect(complexEstimate.estimatedTokens).toBeGreaterThanOrEqual(50000);
    expect(complexEstimate.mode).toBe("orchestrate");
  });
});
