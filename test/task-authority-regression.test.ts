import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SchemaRegistry } from "../src/contracts/schema-registry.js";
import type { TaskCharter } from "../src/contracts/types.js";
import { createTask, saveTask } from "../src/storage/tasks.js";
import { issueLease, revokeLease } from "../src/storage/leases.js";
import { initWorkspace } from "../src/storage/workspace.js";
import { decideApproval, getApproval, requestApproval } from "../src/storage/approvals.js";
import { admitAndReserveLeaseCall, getLeaseCallUsage } from "../src/storage/lease-usage.js";
import { hashTaskAuthority, TASK_AUTHORITY_POLICY_VERSION } from "../src/storage/task-authority.js";
import { transitionTask } from "../src/storage/task-transitions.js";

const roots: string[] = [];
const projectRoot = path.resolve(import.meta.dirname, "..");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup(task: TaskCharter) {
  const root = await mkdtemp(path.join(os.tmpdir(), "stinky-task-authority-"));
  roots.push(root);
  const workspace = await initWorkspace(root);
  await createTask(workspace, task);
  return { workspace, schemas: await SchemaRegistry.create(projectRoot) };
}

async function approveWrite(
  workspace: Awaited<ReturnType<typeof initWorkspace>>,
  schemas: SchemaRegistry,
  value: TaskCharter,
  scope: string[],
  hostSessionId = "local-cli"
) {
  const expiresAt = "2099-01-01T00:00:00.000Z";
  const requested = await requestApproval(workspace, schemas, {
    taskId: value.id,
    action: "delegate-capability",
    scope,
    subjectKind: "task-authority",
    subjectId: value.id,
    subjectVersion: 1,
    subjectHash: hashTaskAuthority(value),
    capability: "repository-write",
    budget: { maxToolCalls: 20, expiresAt },
    policyVersion: TASK_AUTHORITY_POLICY_VERSION,
    requestedBy: "host-user",
    hostSessionId,
    nonce: `authority-grant-${value.id}`,
    expiresAt,
    reason: "Permit this exact repository write delegation."
  });
  return decideApproval(workspace, schemas, requested.id, { status: "approved", decidedBy: "host-user", reason: "Approved." });
}

async function approveCapability(
  workspace: Awaited<ReturnType<typeof initWorkspace>>,
  schemas: SchemaRegistry,
  value: TaskCharter,
  capability: string,
  scope: string[]
) {
  const expiresAt = "2099-01-01T00:00:00.000Z";
  const requested = await requestApproval(workspace, schemas, {
    taskId: value.id,
    action: "delegate-capability",
    scope,
    subjectKind: "task-authority",
    subjectId: value.id,
    subjectVersion: 1,
    subjectHash: hashTaskAuthority(value),
    capability,
    budget: { maxToolCalls: 20, expiresAt },
    policyVersion: TASK_AUTHORITY_POLICY_VERSION,
    requestedBy: "host-user",
    nonce: `authority-grant-${capability}-${value.id}`,
    expiresAt,
    reason: "Permit this exact capability delegation."
  });
  return decideApproval(workspace, schemas, requested.id, { status: "approved", decidedBy: "host-user", reason: "Approved." });
}

function task(patch: Partial<TaskCharter> = {}): TaskCharter {
  return {
    id: "authority-task",
    workspaceId: "workspace-1",
    goal: "Exercise the repository gate",
    requestedOutputs: ["report"],
    riskLevel: "L0",
    state: "SCOPED",
    scope: ["src"],
    ...patch
  };
}

describe("central Task authority regressions", () => {
  it("denies every executable Lease while the Task is DRAFT", async () => {
    const { workspace, schemas } = await setup(task({ state: "DRAFT", scope: ["."] }));

    await expect(issueLease(workspace, schemas, {
      taskId: "authority-task",
      agentId: "agent",
      role: "scout",
      capability: "repository-read"
    })).rejects.toMatchObject({ code: "TASK_STATE_DENIED" });
  });

  it("denies L3 even when the caller asks for an L0 read Lease", async () => {
    const { workspace, schemas } = await setup(task({ state: "RUNNING", riskLevel: "L3", scope: ["."] }));

    await expect(issueLease(workspace, schemas, {
      taskId: "authority-task",
      agentId: "agent",
      role: "scout",
      capability: "repository-read"
    })).rejects.toMatchObject({ code: "TASK_RISK_DENIED" });
  });

  it("intersects a read Lease with the persisted Task scope", async () => {
    const { workspace, schemas } = await setup(task({ scope: ["src"] }));

    await expect(issueLease(workspace, schemas, {
      taskId: "authority-task",
      agentId: "agent",
      role: "scout",
      capability: "repository-read",
      readScope: ["."]
    })).rejects.toMatchObject({ code: "TASK_SCOPE_EXCEEDED" });
  });

  it("denies repository-write when no precise delegation Approval is supplied", async () => {
    const { workspace, schemas } = await setup(task({
      state: "RUNNING",
      scope: ["docs"],
      writeSet: ["docs/guide.md"]
    }));

    await expect(issueLease(workspace, schemas, {
      taskId: "authority-task",
      agentId: "agent",
      role: "builder",
      capability: "repository-write",
      readScope: ["docs"],
      writeSet: ["docs/guide.md"]
    })).rejects.toMatchObject({ code: "TASK_APPROVAL_REQUIRED" });
  });

  it("intersects a write Lease with the persisted Task writeSet", async () => {
    const { workspace, schemas } = await setup(task({
      state: "RUNNING",
      scope: ["docs"],
      writeSet: ["docs/allowed.md"]
    }));

    await expect(issueLease(workspace, schemas, {
      taskId: "authority-task",
      agentId: "agent",
      role: "builder",
      capability: "repository-write",
      readScope: ["docs"],
      writeSet: ["docs/other.md"]
    })).rejects.toMatchObject({ code: "TASK_WRITE_SET_EXCEEDED" });
  });

  it("persists the precise Task snapshot, parent grant, policy, session, and Approval on a write Lease", async () => {
    const value = task({ state: "RUNNING", scope: ["docs"], writeSet: ["docs/guide.md"] });
    const { workspace, schemas } = await setup(value);
    const unrelated = await requestApproval(workspace, schemas, {
      taskId: value.id,
      action: "review-output",
      scope: ["docs/guide.md"],
      reason: "This legacy path-only record must not be projected as a delegation grant."
    });
    await decideApproval(workspace, schemas, unrelated.id, { status: "approved", decidedBy: "host-user", reason: "Reviewed." });
    const approval = await approveWrite(workspace, schemas, value, ["docs/guide.md"], "host-session-1");

    const lease = await issueLease(workspace, schemas, {
      taskId: value.id,
      agentId: "agent",
      role: "builder",
      capability: "repository-write",
      readScope: ["docs"],
      writeSet: ["docs/guide.md"],
      approvalRefs: [approval.id],
      hostSessionId: "host-session-1"
    });

    expect(lease).toMatchObject({
      parentGrantRef: approval.id,
      taskAuthorityHash: hashTaskAuthority(value),
      approvalRefs: [approval.id],
      policyVersion: TASK_AUTHORITY_POLICY_VERSION,
      hostSessionId: "host-session-1"
    });
  });

  it("does not let another host session discover and consume an unreferenced precise Approval", async () => {
    const value = task({ state: "RUNNING", scope: ["docs"], writeSet: ["docs/guide.md"] });
    const { workspace, schemas } = await setup(value);
    const approval = await approveWrite(workspace, schemas, value, ["docs/guide.md"], "host-session-a");

    await expect(issueLease(workspace, schemas, {
      taskId: value.id,
      agentId: "agent-b",
      role: "builder",
      capability: "repository-write",
      readScope: ["docs"],
      writeSet: ["docs/guide.md"],
      hostSessionId: "host-session-b"
    })).rejects.toMatchObject({ code: "TASK_APPROVAL_REQUIRED" });
    await expect(getApproval(workspace, approval.id)).resolves.not.toHaveProperty("consumedAt");

    await expect(issueLease(workspace, schemas, {
      taskId: value.id,
      agentId: "agent-a",
      role: "builder",
      capability: "repository-write",
      readScope: ["docs"],
      writeSet: ["docs/guide.md"],
      approvalRefs: [approval.id],
      hostSessionId: "host-session-a"
    })).resolves.toMatchObject({ hostSessionId: "host-session-a", approvalRefs: [approval.id] });
  });

  it("blocks a persisted Lease immediately after its Approval is revoked", async () => {
    const value = task({ state: "RUNNING", scope: ["docs"], writeSet: ["docs/guide.md"] });
    const { workspace, schemas } = await setup(value);
    const approval = await approveWrite(workspace, schemas, value, ["docs/guide.md"]);
    const lease = await issueLease(workspace, schemas, {
      taskId: value.id,
      agentId: "agent",
      role: "builder",
      capability: "repository-write",
      readScope: ["docs"],
      writeSet: ["docs/guide.md"],
      approvalRefs: [approval.id]
    });
    await decideApproval(workspace, schemas, approval.id, { status: "revoked", decidedBy: "host-user", reason: "Withdrawn." });

    const admission = await admitAndReserveLeaseCall(workspace, lease.id, {
      taskId: value.id,
      role: "builder",
      capability: "repository-write"
    });
    expect(admission).toMatchObject({ allowed: false, decision: { code: "TASK_APPROVAL_INVALID" } });
    await expect(getLeaseCallUsage(workspace, lease.id)).resolves.toBe(0);
  });

  it("blocks an old Lease when the persisted Task authority snapshot changes", async () => {
    const value = task({ state: "SCOPED", scope: ["src"] });
    const { workspace, schemas } = await setup(value);
    const lease = await issueLease(workspace, schemas, {
      taskId: value.id,
      agentId: "agent",
      role: "scout",
      capability: "repository-read",
      readScope: ["src"]
    });
    await transitionTask(workspace, schemas, value.id, "DESIGNED");

    const admission = await admitAndReserveLeaseCall(workspace, lease.id, {
      taskId: value.id,
      role: "scout",
      capability: "repository-read"
    });
    expect(admission).toMatchObject({ allowed: false, decision: { code: "TASK_AUTHORITY_STALE" } });
    await expect(getLeaseCallUsage(workspace, lease.id)).resolves.toBe(0);
  });

  it("denies a child Lease whose scope exceeds its persisted parent Lease", async () => {
    const value = task({ state: "SCOPED", scope: ["."] });
    const { workspace, schemas } = await setup(value);
    const parent = await issueLease(workspace, schemas, {
      taskId: value.id,
      agentId: "parent",
      role: "scout",
      capability: "repository-read",
      readScope: ["src"],
      hostSessionId: "host-session-1"
    });

    await expect(issueLease(workspace, schemas, {
      taskId: value.id,
      agentId: "child",
      role: "scout",
      capability: "repository-read",
      readScope: ["."],
      parentGrantRef: parent.id,
      hostSessionId: "host-session-1"
    })).rejects.toMatchObject({ code: "PARENT_SCOPE_EXCEEDED" });
  });

  it("revalidates the full persisted parent chain and cascades ancestor revocation", async () => {
    const value = task({ state: "SCOPED", scope: ["src"] });
    const { workspace, schemas } = await setup(value);
    const root = await issueLease(workspace, schemas, {
      taskId: value.id, agentId: "root", role: "scout", capability: "repository-read",
      readScope: ["src"], hostSessionId: "host-session-1", maxToolCalls: 20, expiresInMinutes: 60
    });
    const middle = await issueLease(workspace, schemas, {
      taskId: value.id, agentId: "middle", role: "scout", capability: "repository-read",
      readScope: ["src"], hostSessionId: "host-session-1", parentGrantRef: root.id, maxToolCalls: 10, expiresInMinutes: 50
    });
    const child = await issueLease(workspace, schemas, {
      taskId: value.id, agentId: "child", role: "scout", capability: "repository-read",
      readScope: ["src"], hostSessionId: "host-session-1", parentGrantRef: middle.id, maxToolCalls: 5, expiresInMinutes: 40
    });
    await revokeLease(workspace, root.id, "Ancestor authority withdrawn.");

    const admission = await admitAndReserveLeaseCall(workspace, child.id, {
      taskId: value.id, role: "scout", capability: "repository-read"
    });
    expect(admission).toMatchObject({ allowed: false, decision: { code: "PARENT_GRANT_DENIED" } });
    await expect(getLeaseCallUsage(workspace, child.id)).resolves.toBe(0);
  });

  it("fails closed on an unrecognized parent grant instead of persisting caller text", async () => {
    const value = task({ state: "SCOPED", scope: ["src"] });
    const { workspace, schemas } = await setup(value);

    await expect(issueLease(workspace, schemas, {
      taskId: value.id,
      agentId: "child",
      role: "scout",
      capability: "repository-read",
      readScope: ["src"],
      parentGrantRef: "caller-invented-parent"
    })).rejects.toMatchObject({ code: "PARENT_GRANT_DENIED" });
  });

  it("enforces the persisted approvalRequired flag for otherwise low-risk reads", async () => {
    const value = task({ state: "SCOPED", scope: ["src"], approvalRequired: true });
    const { workspace, schemas } = await setup(value);

    await expect(issueLease(workspace, schemas, {
      taskId: value.id,
      agentId: "reader",
      role: "scout",
      capability: "repository-read",
      readScope: ["src"]
    })).rejects.toMatchObject({ code: "TASK_APPROVAL_REQUIRED" });

    const approval = await approveCapability(workspace, schemas, value, "repository-read", ["src"]);
    await expect(issueLease(workspace, schemas, {
      taskId: value.id,
      agentId: "reader",
      role: "scout",
      capability: "repository-read",
      readScope: ["src"],
      approvalRefs: [approval.id]
    })).resolves.toMatchObject({ approvalRefs: [approval.id] });
  });

  it("denies restricted Task data to the current public executor", async () => {
    const value = task({ state: "SCOPED", scope: ["src"], dataClassification: "restricted" });
    const { workspace, schemas } = await setup(value);

    await expect(issueLease(workspace, schemas, {
      taskId: value.id,
      agentId: "reader",
      role: "scout",
      capability: "repository-read",
      readScope: ["src"]
    })).rejects.toMatchObject({ code: "TASK_DATA_CLASSIFICATION_DENIED" });
  });

  it("requires a precise grant before reading confidential Task data", async () => {
    const value = task({ state: "SCOPED", scope: ["src"], dataClassification: "confidential" });
    const { workspace, schemas } = await setup(value);

    await expect(issueLease(workspace, schemas, {
      taskId: value.id,
      agentId: "reader",
      role: "scout",
      capability: "repository-read",
      readScope: ["src"]
    })).rejects.toMatchObject({ code: "TASK_APPROVAL_REQUIRED" });

    const approval = await approveCapability(workspace, schemas, value, "repository-read", ["src"]);
    await expect(issueLease(workspace, schemas, {
      taskId: value.id,
      agentId: "reader",
      role: "scout",
      capability: "repository-read",
      readScope: ["src"],
      approvalRefs: [approval.id]
    })).resolves.toMatchObject({ approvalRefs: [approval.id] });
  });
});
