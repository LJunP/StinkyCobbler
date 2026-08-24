import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SchemaRegistry } from "../src/contracts/schema-registry.js";
import type { TaskCharter } from "../src/contracts/types.js";
import { consumeApproval, decideApproval, getApproval, requestApproval } from "../src/storage/approvals.js";
import { hashTaskAuthority, TASK_AUTHORITY_POLICY_VERSION } from "../src/storage/task-authority.js";
import { transitionTask } from "../src/storage/task-transitions.js";
import { createTask, getTask, saveTask } from "../src/storage/tasks.js";
import { initWorkspace } from "../src/storage/workspace.js";

const roots: string[] = [];
const projectRoot = path.resolve(import.meta.dirname, "..");
const expiresAt = "2099-01-01T00:00:00.000Z";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup(patch: Partial<TaskCharter> = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "stinky-task-transition-"));
  roots.push(root);
  const workspace = await initWorkspace(root);
  const task: TaskCharter = {
    id: "task",
    workspaceId: "workspace",
    goal: "Run one authorized task",
    requestedOutputs: ["report"],
    riskLevel: "L1",
    state: "DESIGNED",
    scope: ["src"],
    ...patch
  };
  await createTask(workspace, task);
  return { workspace, task, schemas: await SchemaRegistry.create(projectRoot) };
}

async function approveExecution(workspace: Awaited<ReturnType<typeof initWorkspace>>, schemas: SchemaRegistry, task: TaskCharter) {
  const requested = await requestApproval(workspace, schemas, {
    taskId: task.id,
    action: "task-execution",
    scope: task.scope ?? ["."],
    subjectKind: "task-authority",
    subjectId: task.id,
    subjectVersion: 1,
    subjectHash: hashTaskAuthority(task),
    capability: "task-execution",
    budget: { maxToolCalls: 1, expiresAt },
    policyVersion: TASK_AUTHORITY_POLICY_VERSION,
    requestedBy: "host-user",
    nonce: "task-execution-approval-0001",
    expiresAt,
    reason: "Approve this Task snapshot for execution."
  });
  return decideApproval(workspace, schemas, requested.id, { status: "approved", decidedBy: "host-user", reason: "Approved." });
}

describe("Task execution transition authority", () => {
  it("requires and consumes a precise Approval before entering executable states", async () => {
    const { workspace, task, schemas } = await setup();
    await expect(transitionTask(workspace, schemas, task.id, "APPROVED_FOR_EXECUTION"))
      .rejects.toMatchObject({ code: "TASK_EXECUTION_APPROVAL_REQUIRED" });
    const approval = await approveExecution(workspace, schemas, task);

    await expect(transitionTask(workspace, schemas, task.id, "APPROVED_FOR_EXECUTION", { approvalRef: approval.id }))
      .resolves.toMatchObject({ state: "APPROVED_FOR_EXECUTION" });
    await expect(getApproval(workspace, approval.id)).resolves.toMatchObject({ consumedBy: "task-transition:task:APPROVED_FOR_EXECUTION" });
    await expect(transitionTask(workspace, schemas, task.id, "RUNNING")).resolves.toMatchObject({ state: "RUNNING" });
  });

  it("recovers an exact Task transition retry after Approval consumption committed first", async () => {
    const { workspace, task, schemas } = await setup();
    const approval = await approveExecution(workspace, schemas, task);
    const owner = `task-transition:${task.id}:APPROVED_FOR_EXECUTION`;
    await consumeApproval(workspace, schemas, approval.id, owner);

    await expect(transitionTask(workspace, schemas, task.id, "APPROVED_FOR_EXECUTION", { approvalRef: approval.id }))
      .resolves.toMatchObject({ state: "APPROVED_FOR_EXECUTION", authorityGeneration: 1 });
    await expect(getApproval(workspace, approval.id)).resolves.toMatchObject({ consumedBy: owner });
  });

  it("rejects a stale Approval after Task authority fields change", async () => {
    const { workspace, task, schemas } = await setup();
    const approval = await approveExecution(workspace, schemas, task);
    await saveTask(workspace, { ...task, scope: ["src", "docs"] });

    await expect(transitionTask(workspace, schemas, task.id, "APPROVED_FOR_EXECUTION", { approvalRef: approval.id }))
      .rejects.toMatchObject({ code: "TASK_EXECUTION_APPROVAL_INVALID" });
  });

  it("does not revive an old unconsumed Approval after DESIGNED is re-entered", async () => {
    const { workspace, task, schemas } = await setup();
    const approval = await approveExecution(workspace, schemas, task);
    await transitionTask(workspace, schemas, task.id, "BLOCKED");
    await transitionTask(workspace, schemas, task.id, "REWORK");
    const returned = await transitionTask(workspace, schemas, task.id, "DESIGNED");
    expect(returned.authorityGeneration).toBe(3);

    await expect(transitionTask(workspace, schemas, task.id, "APPROVED_FOR_EXECUTION", { approvalRef: approval.id }))
      .rejects.toMatchObject({ code: "TASK_EXECUTION_APPROVAL_INVALID" });
  });

  it("keeps L3 non-executable even with a syntactically precise Approval", async () => {
    const { workspace, task, schemas } = await setup({ riskLevel: "L3" });
    const approval = await approveExecution(workspace, schemas, task);

    await expect(transitionTask(workspace, schemas, task.id, "APPROVED_FOR_EXECUTION", { approvalRef: approval.id }))
      .rejects.toMatchObject({ code: "TASK_RISK_DENIED" });
  });

  it("advances a monotonic authority generation and prevents saveTask state/generation bypass", async () => {
    const { workspace, task, schemas } = await setup({ state: "SCOPED" });
    expect(task.authorityGeneration).toBe(0);
    const designed = await transitionTask(workspace, schemas, task.id, "DESIGNED");
    expect(designed.authorityGeneration).toBe(1);

    await expect(saveTask(workspace, { ...designed, state: "BLOCKED" })).rejects.toMatchObject({ code: "TASK_TRANSITION_REQUIRED" });
    await expect(saveTask(workspace, { ...designed, authorityGeneration: 0 })).rejects.toMatchObject({ code: "TASK_AUTHORITY_GENERATION_CONFLICT" });
    await expect(getTask(workspace, task.id)).resolves.toMatchObject({ state: "DESIGNED", authorityGeneration: 1 });
  });
});
