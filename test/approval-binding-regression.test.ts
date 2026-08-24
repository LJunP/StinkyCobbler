import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SchemaRegistry } from "../src/contracts/schema-registry.js";
import { loadRegistries } from "../src/config/registry.js";
import type { TaskCharter, WriteIntent } from "../src/contracts/types.js";
import { createTask } from "../src/storage/tasks.js";
import { initWorkspace } from "../src/storage/workspace.js";
import { beginStep, confirmPlan, createPlan, executePlan } from "../src/storage/plans.js";
import { decideApproval, getApproval, requestApproval } from "../src/storage/approvals.js";
import { confirmWrites, requestWrites, type WriteIntentRecord } from "../src/storage/write-intents.js";
import { hashTaskAuthority, TASK_AUTHORITY_POLICY_VERSION } from "../src/storage/task-authority.js";
import { issueLease } from "../src/storage/leases.js";
import { applyDelete, applyWrite } from "../src/storage/writes.js";
import { approvePlanConfirmation, approveTaskCapability } from "./helpers/authority.js";

const roots: string[] = [];
const projectRoot = path.resolve(import.meta.dirname, "..");
const expiresAt = "2099-01-01T00:00:00.000Z";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup(action: WriteIntent["action"] = "modify") {
  const root = await mkdtemp(path.join(os.tmpdir(), "stinky-approval-binding-"));
  roots.push(root);
  await mkdir(path.join(root, "docs"), { recursive: true });
  await writeFile(path.join(root, "docs", "guide.md"), "original\n", "utf8");
  const workspace = await initWorkspace(root);
  const task: TaskCharter = {
    id: "write-task",
    workspaceId: "workspace-1",
    goal: "Apply one controlled write",
    requestedOutputs: ["report"],
    riskLevel: "L0",
    state: "RUNNING",
    scope: ["."],
    writeSet: ["docs/guide.md"]
  };
  await createTask(workspace, task);
  const schemas = await SchemaRegistry.create(projectRoot);
  const registries = await loadRegistries(projectRoot, schemas);
  const plan = await createPlan(workspace, schemas, registries, { taskId: task.id, roles: ["builder"] });
  await approvePlanConfirmation(workspace, schemas, plan);
  await confirmPlan(workspace, plan.planId);
  await executePlan(workspace, plan.planId);
  await beginStep(workspace, schemas, plan.planId, "step-1");
  const grantRequest = await requestApproval(workspace, schemas, {
    taskId: task.id,
    action: "delegate-capability",
    scope: ["docs/guide.md"],
    subjectKind: "task-authority",
    subjectId: task.id,
    subjectVersion: 1,
    subjectHash: hashTaskAuthority(task),
    capability: "repository-write",
    budget: { maxToolCalls: 20, expiresAt },
    policyVersion: TASK_AUTHORITY_POLICY_VERSION,
    requestedBy: "host-user",
    hostSessionId: "host-session-1",
    nonce: `task-grant-${action}-0001`,
    expiresAt,
    reason: "Delegate this exact write target."
  });
  const grant = await decideApproval(workspace, schemas, grantRequest.id, { status: "approved", decidedBy: "host-user", reason: "Approved." });
  const writes: WriteIntent[] = [{ target: "docs/guide.md", action, purpose: `${action} the guide.` }];
  const intent = await requestWrites(workspace, schemas, plan.planId, "step-1", writes, { approvalRefs: [grant.id], hostSessionId: "host-session-1" });
  return { root, workspace, task, schemas, planId: plan.planId, grant, intent };
}

async function approveIntent(
  workspace: Awaited<ReturnType<typeof initWorkspace>>,
  schemas: SchemaRegistry,
  intent: WriteIntentRecord,
  nonce: string,
  proposedContentHash?: string
) {
  const request = await requestApproval(workspace, schemas, {
    taskId: intent.taskId,
    action: "write-confirm",
    scope: intent.writes.map((write) => write.target),
    subjectKind: "write-intent",
    subjectId: intent.writeIntentId,
    subjectVersion: intent.version,
    subjectHash: intent.intentHash,
    capability: "repository-write",
    expectedPreimageHash: intent.expectedPreimageHash,
    ...(proposedContentHash === undefined ? {} : { proposedContentHash }),
    budget: { maxToolCalls: 1, expiresAt },
    policyVersion: TASK_AUTHORITY_POLICY_VERSION,
    requestedBy: "host-user",
    hostSessionId: intent.hostSessionId,
    nonce,
    expiresAt,
    reason: "Approve this exact immutable write subject."
  });
  return decideApproval(workspace, schemas, request.id, { status: "approved", decidedBy: "host-user", reason: "Approved." });
}

describe("precise Approval and WriteIntent binding", () => {
  it("fails closed for a legacy path-only write-confirm Approval", async () => {
    const { workspace, schemas, planId, intent } = await setup();
    const legacy = await requestApproval(workspace, schemas, { taskId: intent.taskId, action: "write-confirm", scope: ["docs/guide.md"], reason: "Legacy approval." });
    await decideApproval(workspace, schemas, legacy.id, { status: "approved", decidedBy: "host-user", reason: "Approved." });

    await expect(confirmWrites(workspace, planId, "step-1", intent.writeIntentId, schemas))
      .rejects.toMatchObject({ code: "WRITE_CONFIRMATION_REQUIRED" });
  });

  it("binds and consumes a precise Approval once", async () => {
    const { workspace, schemas, planId, intent, grant } = await setup();
    const approval = await approveIntent(workspace, schemas, intent, "write-intent-once-0001");
    const confirmed = await confirmWrites(workspace, planId, "step-1", intent.writeIntentId, schemas);
    expect(confirmed).toMatchObject({ status: "CONFIRMED", approvalRef: approval.id });
    await expect(getApproval(workspace, approval.id)).resolves.toMatchObject({ consumedBy: intent.writeIntentId });

    const second = await requestWrites(workspace, schemas, planId, "step-1", intent.writes, { approvalRefs: [grant.id], hostSessionId: "host-session-1" });
    expect(second).toEqual(confirmed);
    await expect(confirmWrites(workspace, planId, "step-1", second.writeIntentId, schemas)).resolves.toEqual(confirmed);
  });

  it("rejects delete when target bytes drift after confirmation", async () => {
    const { root, workspace, task, schemas, planId, intent } = await setup("delete");
    await approveIntent(workspace, schemas, intent, "delete-intent-once-0001");
    const confirmed = await confirmWrites(workspace, planId, "step-1", intent.writeIntentId, schemas);
    const executionGrant = await approveTaskCapability(workspace, schemas, task, "repository-write", ["docs/guide.md"], 100, "host-session-1");
    const lease = await issueLease(workspace, schemas, {
      taskId: task.id,
      agentId: "builder",
      role: "builder",
      capability: "repository-write",
      readScope: ["docs/guide.md"],
      writeSet: ["docs/guide.md"],
      approvalRefs: [executionGrant.id],
      hostSessionId: "host-session-1"
    });
    await writeFile(path.join(root, "docs", "guide.md"), "changed-after-approval\n", "utf8");

    await expect(applyDelete(workspace, schemas, lease, confirmed, "docs/guide.md"))
      .rejects.toMatchObject({ code: "WRITE_PREIMAGE_MISMATCH" });
    await expect(readFile(path.join(root, "docs", "guide.md"), "utf8")).resolves.toBe("changed-after-approval\n");
  });

  it("enforces an optional proposed content hash", async () => {
    const { workspace, task, schemas, planId, intent } = await setup("modify");
    const approvedContent = "approved-content\n";
    const proposed = `sha256:${createHash("sha256").update(approvedContent).digest("hex")}`;
    await approveIntent(workspace, schemas, intent, "content-bound-once-0001", proposed);
    const confirmed = await confirmWrites(workspace, planId, "step-1", intent.writeIntentId, schemas);
    const executionGrant = await approveTaskCapability(workspace, schemas, task, "repository-write", ["docs/guide.md"], 100, "host-session-1");
    const lease = await issueLease(workspace, schemas, {
      taskId: task.id,
      agentId: "builder",
      role: "builder",
      capability: "repository-write",
      readScope: ["docs/guide.md"],
      writeSet: ["docs/guide.md"],
      approvalRefs: [executionGrant.id],
      hostSessionId: "host-session-1"
    });

    await expect(applyWrite(workspace, schemas, lease, confirmed, "docs/guide.md", "different\n"))
      .rejects.toMatchObject({ code: "WRITE_CONTENT_HASH_MISMATCH" });
    await expect(applyWrite(workspace, schemas, lease, confirmed, "docs/guide.md", approvedContent))
      .resolves.toMatchObject({ target: "docs/guide.md" });
  });
});
