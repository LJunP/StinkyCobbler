import { randomUUID } from "node:crypto";
import type { SchemaRegistry } from "../../src/contracts/schema-registry.js";
import type { Approval, OrchestrationPlan, TaskCharter } from "../../src/contracts/types.js";
import { decideApproval, requestApproval } from "../../src/storage/approvals.js";
import type { WriteIntentRecord } from "../../src/storage/write-intents.js";
import { hashTaskAuthority, TASK_AUTHORITY_POLICY_VERSION } from "../../src/storage/task-authority.js";
import { PLAN_CONFIRM_CAPABILITY } from "../../src/storage/plans.js";
import type { LocalWorkspace } from "../../src/storage/workspace.js";

const EXPIRES_AT = "2099-01-01T00:00:00.000Z";

export async function approveTaskCapability(
  workspace: LocalWorkspace,
  schemas: SchemaRegistry,
  task: TaskCharter,
  capability: string,
  scope: string[],
  maxToolCalls = 100,
  hostSessionId = "local-cli"
): Promise<Approval> {
  const requested = await requestApproval(workspace, schemas, {
    taskId: task.id,
    action: "delegate-capability",
    scope,
    subjectKind: "task-authority",
    subjectId: task.id,
    subjectVersion: 1,
    subjectHash: hashTaskAuthority(task),
    capability,
    budget: { maxToolCalls, expiresAt: EXPIRES_AT },
    policyVersion: TASK_AUTHORITY_POLICY_VERSION,
    requestedBy: "test-host",
    hostSessionId,
    nonce: `task-grant-${randomUUID()}`,
    expiresAt: EXPIRES_AT,
    reason: "Test-only precise Task capability grant."
  });
  return decideApproval(workspace, schemas, requested.id, { status: "approved", decidedBy: "test-host", reason: "Approved for test." });
}

export async function approveWriteIntent(
  workspace: LocalWorkspace,
  schemas: SchemaRegistry,
  intent: WriteIntentRecord,
  options: { scope?: string[]; proposedContentHash?: string } = {}
): Promise<Approval> {
  const requested = await requestApproval(workspace, schemas, {
    taskId: intent.taskId,
    action: "write-confirm",
    scope: options.scope ?? intent.writes.map((write) => write.target),
    subjectKind: "write-intent",
    subjectId: intent.writeIntentId,
    subjectVersion: intent.version,
    subjectHash: intent.intentHash,
    capability: "repository-write",
    expectedPreimageHash: intent.expectedPreimageHash,
    ...(options.proposedContentHash === undefined ? {} : { proposedContentHash: options.proposedContentHash }),
    budget: { maxToolCalls: 1, expiresAt: EXPIRES_AT },
    policyVersion: TASK_AUTHORITY_POLICY_VERSION,
    requestedBy: "test-host",
    hostSessionId: intent.hostSessionId,
    nonce: `write-grant-${randomUUID()}`,
    expiresAt: EXPIRES_AT,
    reason: "Test-only precise WriteIntent grant."
  });
  return decideApproval(workspace, schemas, requested.id, { status: "approved", decidedBy: "test-host", reason: "Approved for test." });
}

export async function approvePlanConfirmation(
  workspace: LocalWorkspace,
  schemas: SchemaRegistry,
  plan: OrchestrationPlan,
  hostSessionId = plan.hostSessionId ?? "local-cli"
): Promise<Approval> {
  if (plan.planSubjectVersion === undefined || plan.planSubjectHash === undefined || plan.policyVersion === undefined) {
    throw new Error("A legacy Plan cannot receive a precise Plan confirmation Approval.");
  }
  const requested = await requestApproval(workspace, schemas, {
    taskId: plan.taskId,
    action: "plan-confirm",
    scope: [plan.planId],
    subjectKind: "plan",
    subjectId: plan.planId,
    subjectVersion: plan.planSubjectVersion,
    subjectHash: plan.planSubjectHash,
    capability: PLAN_CONFIRM_CAPABILITY,
    budget: { maxToolCalls: 1, expiresAt: EXPIRES_AT },
    policyVersion: plan.policyVersion,
    requestedBy: "test-host",
    hostSessionId,
    nonce: `plan-confirm-${randomUUID()}`,
    expiresAt: EXPIRES_AT,
    reason: "Test-only precise Plan confirmation."
  });
  return decideApproval(workspace, schemas, requested.id, { status: "approved", decidedBy: "test-host", reason: "Approved for test." });
}
