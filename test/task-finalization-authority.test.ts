import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SchemaRegistry } from "../src/contracts/schema-registry.js";
import type { TaskCharter } from "../src/contracts/types.js";
import { loadRegistries } from "../src/config/registry.js";
import { executeReadonlyRuntime } from "../src/runtime/service.js";
import { decideApproval, requestApproval } from "../src/storage/approvals.js";
import { admitAndReserveLeaseCall } from "../src/storage/lease-usage.js";
import { issueLease, revokeLease } from "../src/storage/leases.js";
import { getReceipt, recordReceipt } from "../src/storage/receipts.js";
import { getRuntimeFinalization, injectRuntimeFinalizationFaultOnceForTest, reconcileRuntimeFinalization, runtimeReceiptId } from "../src/storage/runtime-finalization.js";
import { getRun } from "../src/storage/runs.js";
import { injectTaskTransitionFaultForTesting, listTaskTransitionTransactions, transitionTask } from "../src/storage/task-transitions.js";
import { hashTaskAuthority, TASK_AUTHORITY_POLICY_VERSION } from "../src/storage/task-authority.js";
import { createTask, getTask, saveTask } from "../src/storage/tasks.js";
import { initWorkspace, workspaceFile } from "../src/storage/workspace.js";

const roots: string[] = [];
const projectRoot = path.resolve(import.meta.dirname, "..");
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function setup(state: TaskCharter["state"] = "VERIFYING") {
  const root = await mkdtemp(path.join(os.tmpdir(), "stinky-task-finalization-"));
  roots.push(root);
  const workspace = await initWorkspace(root);
  await writeFile(path.join(root, "README.md"), "# completion evidence\n", "utf8");
  const schemas = await SchemaRegistry.create(projectRoot);
  const registries = await loadRegistries(projectRoot, schemas);
  const task: TaskCharter = {
    id: "task", workspaceId: "workspace", goal: "Verify the final result", requestedOutputs: ["report"],
    acceptanceCriteria: ["Persisted Runtime Evidence exists"], riskLevel: "L0", state, scope: ["README.md"]
  };
  await createTask(workspace, task);
  return { root, workspace, schemas, registries, task };
}

async function completedRuntime(value: Awaited<ReturnType<typeof setup>>, requests = [{ tool: "repository-read", input: { path: "README.md" } }]) {
  const lease = await issueLease(value.workspace, value.schemas, {
    taskId: value.task.id, agentId: "verifier", role: "scout", capability: "repository-read",
    readScope: ["README.md"], maxToolCalls: 3, expiresInMinutes: 60, hostSessionId: "local-cli"
  });
  const capsule = {
    version: 1, capsuleId: "capsule", runId: "run", taskId: value.task.id, agentId: "verifier", role: "scout",
    workspaceId: value.task.workspaceId, leaseId: lease.id, policyVersion: lease.policyVersion!, goal: value.task.goal,
    scope: ["README.md"], readScope: ["README.md"], nonGoals: [], facts: [], decisions: [], unknowns: [],
    allowedTools: ["repository-read"], writeSet: [], outputSchema: ["receipt"], budget: { maxToolCalls: 2, maxFiles: 2, maxBytes: 4096 },
    issuedAt: lease.issuedAt, expiresAt: lease.expiresAt
  };
  const result = await executeReadonlyRuntime({
    root: value.root, task: value.task, capsule, lease, schemas: value.schemas, registries: value.registries, requests
  });
  return { lease, ...result };
}

describe("Task terminal authority", () => {
  it("reaches DONE through the real lifecycle and a fresh VERIFYING-generation Runtime proof", async () => {
    const value = await setup("DRAFT");
    await transitionTask(value.workspace, value.schemas, value.task.id, "SCOPED");
    const designed = await transitionTask(value.workspace, value.schemas, value.task.id, "DESIGNED");
    const expiresAt = "2099-01-01T00:00:00.000Z";
    const requested = await requestApproval(value.workspace, value.schemas, {
      taskId: designed.id, action: "task-execution", scope: designed.scope ?? ["."], subjectKind: "task-authority",
      subjectId: designed.id, subjectVersion: 1, subjectHash: hashTaskAuthority(designed), capability: "task-execution",
      budget: { maxToolCalls: 1, expiresAt }, policyVersion: TASK_AUTHORITY_POLICY_VERSION, requestedBy: "host-user",
      hostSessionId: "local-cli", nonce: "full-lifecycle-execution-approval", expiresAt, reason: "Authorize lifecycle test."
    });
    const approval = await decideApproval(value.workspace, value.schemas, requested.id, {
      status: "approved", decidedBy: "host-user", reason: "Approved."
    });
    await transitionTask(value.workspace, value.schemas, designed.id, "APPROVED_FOR_EXECUTION", { approvalRef: approval.id, hostSessionId: "local-cli" });
    await transitionTask(value.workspace, value.schemas, designed.id, "RUNNING");
    await transitionTask(value.workspace, value.schemas, designed.id, "REVIEWING");
    value.task = await transitionTask(value.workspace, value.schemas, designed.id, "VERIFYING");

    const result = await completedRuntime(value);
    const done = await transitionTask(value.workspace, value.schemas, designed.id, "DONE", {
      receiptRef: result.receipt.id, evidenceRefs: result.receipt.evidenceRefs
    });
    expect(done).toMatchObject({ state: "DONE", authorityGeneration: 7, completionReceiptRef: result.receipt.id });
  });

  it("accepts only an exact current Runtime proof with non-empty persisted Evidence", async () => {
    const value = await setup();
    const result = await completedRuntime(value);
    expect(result.run.status).toBe("COMPLETED");
    expect(result.receipt.evidenceRefs.length).toBeGreaterThan(0);

    const completionRequest = {
      receiptRef: result.receipt.id,
      evidenceRefs: result.receipt.evidenceRefs
    };
    injectTaskTransitionFaultForTesting(value.workspace, "after-task");
    await expect(transitionTask(value.workspace, value.schemas, value.task.id, "DONE", completionRequest))
      .rejects.toMatchObject({ code: "TASK_TRANSITION_FAULT_INJECTED", details: { point: "after-task" } });
    const done = await transitionTask(value.workspace, value.schemas, value.task.id, "DONE", completionRequest);
    expect(done).toMatchObject({
      state: "DONE",
      authorityGeneration: 1,
      completionReceiptRef: result.receipt.id,
      completionEvidenceRefs: result.receipt.evidenceRefs
    });
    const withoutProof = { ...done };
    delete withoutProof.completionReceiptRef;
    delete withoutProof.completionEvidenceRefs;
    await expect(saveTask(value.workspace, withoutProof)).rejects.toMatchObject({ code: "TASK_COMPLETION_TRANSITION_REQUIRED" });
  });

  it("blocks DONE until a receipt-before-ledger crash is durably reconciled", async () => {
    const value = await setup();
    injectRuntimeFinalizationFaultOnceForTest(value.workspace, "after-receipt");
    await expect(completedRuntime(value)).rejects.toMatchObject({
      code: "RUNTIME_FINALIZATION_FAULT_INJECTED",
      details: { point: "after-receipt" }
    });
    const run = await getRun(value.workspace, "run");
    const receipt = await getReceipt(value.workspace, runtimeReceiptId(run.runId));
    await expect(getRuntimeFinalization(value.workspace, run.runId)).resolves.toMatchObject({ status: "PREPARED" });
    await expect(transitionTask(value.workspace, value.schemas, value.task.id, "DONE", {
      receiptRef: receipt.id,
      evidenceRefs: receipt.evidenceRefs as string[]
    })).rejects.toMatchObject({ code: "RUNTIME_FINALIZATION_INCOMPLETE" });

    await reconcileRuntimeFinalization(value.workspace, value.schemas, run.runId);
    await expect(transitionTask(value.workspace, value.schemas, value.task.id, "DONE", {
      receiptRef: receipt.id,
      evidenceRefs: receipt.evidenceRefs as string[]
    })).resolves.toMatchObject({ state: "DONE", completionReceiptRef: receipt.id });
  });

  it("aborts a PREPARED DONE transition when its Runtime Lease is revoked before the Task write", async () => {
    const value = await setup();
    const result = await completedRuntime(value);
    const completionRequest = { receiptRef: result.receipt.id, evidenceRefs: result.receipt.evidenceRefs };
    injectTaskTransitionFaultForTesting(value.workspace, "after-prepare");
    await expect(transitionTask(value.workspace, value.schemas, value.task.id, "DONE", completionRequest))
      .rejects.toMatchObject({ code: "TASK_TRANSITION_FAULT_INJECTED", details: { point: "after-prepare" } });
    await revokeLease(value.workspace, result.lease.id, "Completion proof revoked before Task commit.");

    await expect(transitionTask(value.workspace, value.schemas, value.task.id, "DONE", completionRequest))
      .rejects.toMatchObject({ code: "TASK_COMPLETION_AUTHORITY_STALE" });
    await expect(getTask(value.workspace, value.task.id)).resolves.toMatchObject({ state: "VERIFYING", authorityGeneration: 0 });
    await expect(listTaskTransitionTransactions(value.workspace, value.task.id))
      .resolves.toEqual([expect.objectContaining({ status: "ABORTED", abortCode: "TASK_COMPLETION_AUTHORITY_STALE" })]);
    await expect(transitionTask(value.workspace, value.schemas, value.task.id, "CANCELLED", { reason: "Proof revoked before completion." }))
      .resolves.toMatchObject({ state: "CANCELLED", authorityGeneration: 1 });
  });

  it("rejects a self-reported COMPLETED Receipt that has no authoritative Runtime binding", async () => {
    const value = await setup();
    const receipt = await recordReceipt(value.workspace, value.schemas, {
      id: "self-reported", taskId: value.task.id, role: "scout", status: "COMPLETED", facts: [], proposals: [],
      unknowns: [], evidenceRefs: [], createdAt: "2026-01-01T00:00:00.000Z"
    });
    await expect(transitionTask(value.workspace, value.schemas, value.task.id, "DONE", {
      receiptRef: receipt.id, evidenceRefs: ["evidence-invented"]
    })).rejects.toMatchObject({ code: "TASK_COMPLETION_RECEIPT_RUNTIME_REQUIRED" });
    await expect(getTask(value.workspace, value.task.id)).resolves.toMatchObject({ state: "VERIFYING", authorityGeneration: 0 });
  });

  it("rejects a completed Runtime proof after any Task authority mutation", async () => {
    const value = await setup();
    const result = await completedRuntime(value);
    const current = await getTask(value.workspace, value.task.id);
    await saveTask(value.workspace, { ...current, constraints: ["new authority constraint"] });

    await expect(transitionTask(value.workspace, value.schemas, value.task.id, "DONE", {
      receiptRef: result.receipt.id, evidenceRefs: result.receipt.evidenceRefs
    })).rejects.toMatchObject({ code: "TASK_COMPLETION_AUTHORITY_STALE" });
  });

  it("rejects a Runtime completion with no Evidence", async () => {
    const value = await setup();
    const result = await completedRuntime(value, []);
    await expect(transitionTask(value.workspace, value.schemas, value.task.id, "DONE", {
      receiptRef: result.receipt.id, evidenceRefs: []
    })).rejects.toMatchObject({ code: "TASK_COMPLETION_EVIDENCE_REQUIRED" });
  });

  it("keeps legacy Tasks readable but denies authority replay", async () => {
    const value = await setup("SCOPED");
    const legacy = { ...value.task } as TaskCharter;
    delete legacy.authorityGeneration;
    await writeFile(await workspaceFile(value.workspace, "task-task.json"), JSON.stringify(legacy), "utf8");
    await expect(getTask(value.workspace, value.task.id)).resolves.not.toHaveProperty("authorityGeneration");
    await expect(issueLease(value.workspace, value.schemas, {
      taskId: value.task.id, agentId: "agent", role: "scout", capability: "repository-read", readScope: ["README.md"]
    })).rejects.toMatchObject({ code: "TASK_AUTHORITY_REISSUE_REQUIRED" });
  });

  it("does not revive an old Lease after a Task returns to the same state", async () => {
    const value = await setup("DESIGNED");
    const lease = await issueLease(value.workspace, value.schemas, {
      taskId: value.task.id, agentId: "agent", role: "scout", capability: "repository-read", readScope: ["README.md"]
    });
    await transitionTask(value.workspace, value.schemas, value.task.id, "BLOCKED");
    await transitionTask(value.workspace, value.schemas, value.task.id, "REWORK");
    const returned = await transitionTask(value.workspace, value.schemas, value.task.id, "DESIGNED");
    expect(returned.authorityGeneration).toBe(3);

    const admission = await admitAndReserveLeaseCall(value.workspace, lease.id, {
      taskId: value.task.id, role: "scout", capability: "repository-read"
    });
    expect(admission).toMatchObject({ allowed: false, decision: { code: "TASK_AUTHORITY_STALE" } });
  });
});
