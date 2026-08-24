import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SchemaRegistry } from "../src/contracts/schema-registry.js";
import type { TaskCharter } from "../src/contracts/types.js";
import { decideApproval, getApproval, requestApproval } from "../src/storage/approvals.js";
import { listLedgerEntries } from "../src/storage/ledger.js";
import { hashTaskAuthority, TASK_AUTHORITY_POLICY_VERSION } from "../src/storage/task-authority.js";
import {
  injectTaskTransitionFaultForTesting,
  listTaskTransitionTransactions,
  transitionTask
} from "../src/storage/task-transitions.js";
import { createTask, getTask } from "../src/storage/tasks.js";
import { initWorkspace } from "../src/storage/workspace.js";

const roots: string[] = [];
const projectRoot = path.resolve(import.meta.dirname, "..");
const expiresAt = "2099-01-01T00:00:00.000Z";

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function setup(state: TaskCharter["state"] = "DESIGNED") {
  const root = await mkdtemp(path.join(os.tmpdir(), "stinky-task-transaction-"));
  roots.push(root);
  const workspace = await initWorkspace(root);
  const schemas = await SchemaRegistry.create(projectRoot);
  const task: TaskCharter = {
    id: "task", workspaceId: "workspace", goal: "Crash-safe transition", requestedOutputs: ["report"],
    riskLevel: "L1", state, scope: ["src"]
  };
  await createTask(workspace, task);
  return { workspace, schemas, task };
}

async function executionApproval(value: Awaited<ReturnType<typeof setup>>) {
  const requested = await requestApproval(value.workspace, value.schemas, {
    taskId: value.task.id, action: "task-execution", scope: value.task.scope ?? ["."], subjectKind: "task-authority",
    subjectId: value.task.id, subjectVersion: 1, subjectHash: hashTaskAuthority(value.task), capability: "task-execution",
    budget: { maxToolCalls: 1, expiresAt }, policyVersion: TASK_AUTHORITY_POLICY_VERSION, requestedBy: "host-user",
    hostSessionId: "local-cli", nonce: `task-transaction-approval-${randomUUID()}`, expiresAt, reason: "Approve exact Task transition."
  });
  return decideApproval(value.workspace, value.schemas, requested.id, { status: "approved", decidedBy: "host-user", reason: "Approved." });
}

async function transitionLedgerEntries(value: Awaited<ReturnType<typeof setup>>) {
  return (await listLedgerEntries(value.workspace)).filter((entry) => entry.event === "task-transitioned" || entry.event === "task-cancelled");
}

describe("journaled Task transitions", () => {
  it("recovers after Approval consumption, rejects a conflicting request, and emits one ledger effect", async () => {
    const value = await setup();
    const approval = await executionApproval(value);
    const request = { approvalRef: approval.id, hostSessionId: "local-cli" };
    injectTaskTransitionFaultForTesting(value.workspace, "after-consume");
    await expect(transitionTask(value.workspace, value.schemas, value.task.id, "APPROVED_FOR_EXECUTION", request))
      .rejects.toMatchObject({ code: "TASK_TRANSITION_FAULT_INJECTED", details: { point: "after-consume" } });
    await expect(getTask(value.workspace, value.task.id)).resolves.toMatchObject({ state: "DESIGNED", authorityGeneration: 0 });
    await expect(getApproval(value.workspace, approval.id)).resolves.toMatchObject({ consumedBy: "task-transition:task:APPROVED_FOR_EXECUTION" });
    await expect(listTaskTransitionTransactions(value.workspace, value.task.id)).resolves.toEqual([expect.objectContaining({ status: "PREPARED" })]);

    await expect(transitionTask(value.workspace, value.schemas, value.task.id, "BLOCKED"))
      .rejects.toMatchObject({ code: "TASK_TRANSITION_TRANSACTION_CONFLICT" });
    await expect(transitionTask(value.workspace, value.schemas, value.task.id, "APPROVED_FOR_EXECUTION", request))
      .resolves.toMatchObject({ state: "APPROVED_FOR_EXECUTION", authorityGeneration: 1 });
    await expect(transitionTask(value.workspace, value.schemas, value.task.id, "APPROVED_FOR_EXECUTION", request))
      .resolves.toMatchObject({ state: "APPROVED_FOR_EXECUTION", authorityGeneration: 1 });
    expect(await transitionLedgerEntries(value)).toHaveLength(1);
    await expect(listTaskTransitionTransactions(value.workspace, value.task.id)).resolves.toEqual([expect.objectContaining({ status: "COMMITTED" })]);
  });

  it("repairs only audit after the Task write, even if the consumed Approval is later revoked", async () => {
    const value = await setup();
    const approval = await executionApproval(value);
    const request = { approvalRef: approval.id, hostSessionId: "local-cli" };
    injectTaskTransitionFaultForTesting(value.workspace, "after-task");
    await expect(transitionTask(value.workspace, value.schemas, value.task.id, "APPROVED_FOR_EXECUTION", request))
      .rejects.toMatchObject({ code: "TASK_TRANSITION_FAULT_INJECTED", details: { point: "after-task" } });
    await expect(getTask(value.workspace, value.task.id)).resolves.toMatchObject({ state: "APPROVED_FOR_EXECUTION", authorityGeneration: 1 });
    await decideApproval(value.workspace, value.schemas, approval.id, { status: "revoked", decidedBy: "host-user", reason: "Revoked after subject commit." });

    await expect(transitionTask(value.workspace, value.schemas, value.task.id, "APPROVED_FOR_EXECUTION", request))
      .resolves.toMatchObject({ state: "APPROVED_FOR_EXECUTION", authorityGeneration: 1 });
    expect(await transitionLedgerEntries(value)).toHaveLength(1);
  });

  it("aborts source-side recovery when a consumed execution Approval is revoked before the Task write", async () => {
    const value = await setup();
    const approval = await executionApproval(value);
    const request = { approvalRef: approval.id, hostSessionId: "local-cli" };
    injectTaskTransitionFaultForTesting(value.workspace, "after-consume");
    await expect(transitionTask(value.workspace, value.schemas, value.task.id, "APPROVED_FOR_EXECUTION", request))
      .rejects.toMatchObject({ code: "TASK_TRANSITION_FAULT_INJECTED" });
    await decideApproval(value.workspace, value.schemas, approval.id, { status: "revoked", decidedBy: "host-user", reason: "Revoked before Task commit." });

    await expect(transitionTask(value.workspace, value.schemas, value.task.id, "APPROVED_FOR_EXECUTION", request))
      .rejects.toMatchObject({ code: "TASK_EXECUTION_APPROVAL_INVALID" });
    await expect(getTask(value.workspace, value.task.id)).resolves.toMatchObject({ state: "DESIGNED", authorityGeneration: 0 });
    await expect(listTaskTransitionTransactions(value.workspace, value.task.id))
      .resolves.toEqual([expect.objectContaining({ status: "ABORTED", abortCode: "TASK_EXECUTION_APPROVAL_INVALID" })]);

    const replacement = await executionApproval(value);
    await expect(transitionTask(value.workspace, value.schemas, value.task.id, "APPROVED_FOR_EXECUTION", {
      approvalRef: replacement.id,
      hostSessionId: "local-cli"
    })).resolves.toMatchObject({ state: "APPROVED_FOR_EXECUTION", authorityGeneration: 1 });
  });

  it("does not duplicate the ledger when the process dies after append", async () => {
    const value = await setup();
    const approval = await executionApproval(value);
    const request = { approvalRef: approval.id, hostSessionId: "local-cli" };
    injectTaskTransitionFaultForTesting(value.workspace, "after-ledger");
    await expect(transitionTask(value.workspace, value.schemas, value.task.id, "APPROVED_FOR_EXECUTION", request))
      .rejects.toMatchObject({ code: "TASK_TRANSITION_FAULT_INJECTED", details: { point: "after-ledger" } });
    expect(await transitionLedgerEntries(value)).toHaveLength(1);

    await expect(transitionTask(value.workspace, value.schemas, value.task.id, "APPROVED_FOR_EXECUTION", request))
      .resolves.toMatchObject({ state: "APPROVED_FOR_EXECUTION", authorityGeneration: 1 });
    expect(await transitionLedgerEntries(value)).toHaveLength(1);
  });

  it("recovers an approval-free cancellation after the Task write without persisting the raw reason", async () => {
    const value = await setup("SCOPED");
    const reason = "cancel token=super-secret-value";
    injectTaskTransitionFaultForTesting(value.workspace, "after-task");
    await expect(transitionTask(value.workspace, value.schemas, value.task.id, "CANCELLED", { reason }))
      .rejects.toMatchObject({ code: "TASK_TRANSITION_FAULT_INJECTED", details: { point: "after-task" } });
    await expect(getTask(value.workspace, value.task.id)).resolves.toMatchObject({ state: "CANCELLED", authorityGeneration: 1 });
    const [prepared] = await listTaskTransitionTransactions(value.workspace, value.task.id);
    expect(JSON.stringify(prepared)).not.toContain("super-secret-value");

    await expect(transitionTask(value.workspace, value.schemas, value.task.id, "CANCELLED", { reason }))
      .resolves.toMatchObject({ state: "CANCELLED", authorityGeneration: 1 });
    const entries = await transitionLedgerEntries(value);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.summary).not.toContain("super-secret-value");
    expect(entries[0]!.summary).toContain("sha256:");
  });
});
