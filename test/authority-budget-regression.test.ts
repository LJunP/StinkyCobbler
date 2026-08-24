import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SchemaRegistry } from "../src/contracts/schema-registry.js";
import { decideApproval, requestApproval } from "../src/storage/approvals.js";
import { admitAndReserveLeaseCall, getLeaseCallUsage } from "../src/storage/lease-usage.js";
import { issueLease } from "../src/storage/leases.js";
import { hashTaskAuthority, TASK_AUTHORITY_POLICY_VERSION } from "../src/storage/task-authority.js";
import { createTask } from "../src/storage/tasks.js";
import { initWorkspace } from "../src/storage/workspace.js";

const roots: string[] = [];
const projectRoot = path.resolve(import.meta.dirname, "..");
const expiresAt = "2099-01-01T00:00:00.000Z";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "stinky-authority-budget-"));
  roots.push(root);
  const workspace = await initWorkspace(root);
  const task = {
    id: "budget-task", workspaceId: "workspace", goal: "Write one document", requestedOutputs: ["document"],
    riskLevel: "L0" as const, state: "RUNNING" as const, scope: ["docs"], writeSet: ["docs/guide.md"]
  };
  await createTask(workspace, task);
  const schemas = await SchemaRegistry.create(projectRoot);
  const requested = await requestApproval(workspace, schemas, {
    taskId: task.id,
    action: "delegate-capability",
    scope: ["docs/guide.md"],
    subjectKind: "task-authority",
    subjectId: task.id,
    subjectVersion: 1,
    subjectHash: hashTaskAuthority(task),
    capability: "repository-write",
    budget: { maxToolCalls: 4, expiresAt },
    policyVersion: TASK_AUTHORITY_POLICY_VERSION,
    requestedBy: "host-user",
    nonce: "budget-regression-approval",
    expiresAt,
    reason: "Authorize the exact root write grant."
  });
  const approval = await decideApproval(workspace, schemas, requested.id, {
    status: "approved", decidedBy: "host-user", reason: "Approved."
  });
  return { workspace, schemas, task, approval };
}

describe("authority budget regressions", () => {
  it("does not let one one-shot Approval mint sibling root Leases", async () => {
    const { workspace, schemas, task, approval } = await setup();
    await issueLease(workspace, schemas, {
      taskId: task.id, agentId: "agent-a", role: "builder", capability: "repository-write",
      readScope: ["docs"], writeSet: ["docs/guide.md"], approvalRefs: [approval.id], maxToolCalls: 1
    });

    await expect(issueLease(workspace, schemas, {
      taskId: task.id, agentId: "agent-b", role: "builder", capability: "repository-write",
      readScope: ["docs"], writeSet: ["docs/guide.md"], approvalRefs: [approval.id], maxToolCalls: 1
    })).rejects.toMatchObject({ code: "TASK_APPROVAL_INVALID" });
  });

  it("charges sibling child calls to their shared parent Lease budget", async () => {
    const { workspace, schemas, task, approval } = await setup();
    const parent = await issueLease(workspace, schemas, {
      taskId: task.id, agentId: "parent-agent", role: "builder", capability: "repository-write",
      readScope: ["docs"], writeSet: ["docs/guide.md"], approvalRefs: [approval.id], maxToolCalls: 1, expiresInMinutes: 120
    });
    const childA = await issueLease(workspace, schemas, {
      taskId: task.id, agentId: "child-a", role: "builder", capability: "repository-write",
      readScope: ["docs"], writeSet: ["docs/guide.md"], parentGrantRef: parent.id, maxToolCalls: 1
    });
    const childB = await issueLease(workspace, schemas, {
      taskId: task.id, agentId: "child-b", role: "builder", capability: "repository-write",
      readScope: ["docs"], writeSet: ["docs/guide.md"], parentGrantRef: parent.id, maxToolCalls: 1
    });

    await expect(admitAndReserveLeaseCall(workspace, childA.id, {
      taskId: task.id, role: "builder", capability: "repository-write"
    })).resolves.toMatchObject({ allowed: true, used: 1 });
    await expect(admitAndReserveLeaseCall(workspace, childB.id, {
      taskId: task.id, role: "builder", capability: "repository-write"
    })).resolves.toMatchObject({ allowed: false, decision: { code: "PARENT_LEASE_CALL_LIMIT" }, used: 0 });
    await expect(getLeaseCallUsage(workspace, parent.id)).resolves.toBe(1);
    await expect(getLeaseCallUsage(workspace, childA.id)).resolves.toBe(1);
    await expect(getLeaseCallUsage(workspace, childB.id)).resolves.toBe(0);
  });
});
