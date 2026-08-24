import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SchemaRegistry } from "../src/contracts/schema-registry.js";
import { createTask } from "../src/storage/tasks.js";
import { initWorkspace } from "../src/storage/workspace.js";
import { consumeApproval, decideApproval, getApproval, injectApprovalFaultForTesting, inspectApproval, listApprovals, requestApproval } from "../src/storage/approvals.js";
import { evaluateTaskApproval } from "../src/policy/approval.js";
import { listLedgerEntries, verifyLedger } from "../src/storage/ledger.js";
import { writeWorkspaceJson } from "../src/storage/workspace.js";
import type { TaskCharter } from "../src/contracts/types.js";

const roots: string[] = [];
const projectRoot = path.resolve(import.meta.dirname, "..");
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function setup(task: TaskCharter = {
  id: "approval-task",
  workspaceId: "workspace-1",
  goal: "Review a governed action",
  requestedOutputs: ["report"],
  riskLevel: "L2",
  state: "DRAFT",
  approvalRequired: true
}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "stinky-approval-"));
  roots.push(root);
  const workspace = await initWorkspace(root);
  await createTask(workspace, task);
  const schemas = await SchemaRegistry.create(projectRoot);
  return { workspace, schemas, task };
}

describe("explicit approval records", () => {
  for (const point of ["after-request-record", "after-request-ledger"] as const) {
    it(`repairs an Approval request exactly once after ${point}`, async () => {
      const { workspace, schemas, task } = await setup();
      const input = {
        taskId: task.id,
        action: "review-output",
        requestedBy: "test-host",
        hostSessionId: "local-cli",
        nonce: "approval-request-fault-0001",
        subjectKind: "task-authority",
        subjectId: task.id,
        subjectVersion: 1,
        subjectHash: `sha256:${"a".repeat(64)}`,
        capability: "repository-read",
        scope: ["report"],
        budget: { maxToolCalls: 1, expiresAt: "2099-01-01T00:00:00.000Z" },
        policyVersion: "task-authority-v1",
        expiresAt: "2099-01-01T00:00:00.000Z"
      };
      injectApprovalFaultForTesting(workspace, point);
      await expect(requestApproval(workspace, schemas, input)).rejects.toMatchObject({ code: "APPROVAL_TEST_FAULT" });
      const recovered = await requestApproval(workspace, schemas, input);
      await expect(requestApproval(workspace, schemas, input)).resolves.toEqual(recovered);
      expect((await listLedgerEntries(workspace)).filter((entry) => entry.event === "approval-requested" && entry.approvalRef === recovered.id)).toHaveLength(1);
    });
  }

  for (const point of ["after-decision-ledger", "after-decision-record"] as const) {
    it(`repairs a positive Approval decision exactly once after ${point}`, async () => {
      const { workspace, schemas, task } = await setup();
      const requested = await requestApproval(workspace, schemas, { taskId: task.id, action: "review-output" });
      const decision = { status: "approved" as const, decidedBy: "human-reviewer", reason: "Approved exactly once.", decidedAt: "2099-01-01T00:01:00.000Z" };
      injectApprovalFaultForTesting(workspace, point);
      await expect(decideApproval(workspace, schemas, requested.id, decision)).rejects.toMatchObject({ code: "APPROVAL_TEST_FAULT" });
      if (point === "after-decision-ledger") await expect(getApproval(workspace, requested.id)).resolves.toMatchObject({ status: "requested" });
      const recovered = await decideApproval(workspace, schemas, requested.id, decision);
      await expect(decideApproval(workspace, schemas, requested.id, decision)).resolves.toEqual(recovered);
      expect((await listLedgerEntries(workspace)).filter((entry) => entry.event === "approval-decided" && entry.approvalRef === requested.id && entry.summary.includes("decided as approved; decision sha256:"))).toHaveLength(1);
    });
  }

  it("persists an inert prepared decision and refuses a conflicting crash retry", async () => {
    const { workspace, schemas, task } = await setup();
    const requested = await requestApproval(workspace, schemas, { taskId: task.id, action: "review-output" });
    const decision = { status: "approved" as const, decidedBy: "human-reviewer", reason: "Prepared exactly once." };
    injectApprovalFaultForTesting(workspace, "after-decision-prepare");
    await expect(decideApproval(workspace, schemas, requested.id, decision)).rejects.toMatchObject({ code: "APPROVAL_TEST_FAULT" });
    const prepared = await getApproval(workspace, requested.id);
    expect(prepared).toMatchObject({ status: "requested", pendingDecision: { status: "approved", decidedBy: "human-reviewer", reason: "Prepared exactly once." } });
    await expect(decideApproval(workspace, schemas, requested.id, { ...decision, reason: "Conflicting retry." }))
      .rejects.toMatchObject({ code: "APPROVAL_STATE_CONFLICT" });
    const recovered = await decideApproval(workspace, schemas, requested.id, decision);
    expect(recovered).toMatchObject({ status: "approved", decidedAt: prepared.pendingDecision?.decidedAt });
    expect(recovered.pendingDecision).toBeUndefined();
    expect((await listLedgerEntries(workspace)).filter((entry) => entry.event === "approval-decided" && entry.approvalRef === requested.id)).toHaveLength(1);
  });

  it("binds a pre-commit decision audit to every canonical decision field", async () => {
    const { workspace, schemas, task } = await setup();
    const requested = await requestApproval(workspace, schemas, { taskId: task.id, action: "review-output" });
    const decision = { status: "approved" as const, decidedBy: "human-reviewer", reason: "Audit-bound.", decidedAt: "2099-01-01T00:01:00.000Z", expiresAt: "2099-01-02T00:00:00.000Z" };
    injectApprovalFaultForTesting(workspace, "after-decision-ledger");
    await expect(decideApproval(workspace, schemas, requested.id, decision)).rejects.toMatchObject({ code: "APPROVAL_TEST_FAULT" });
    await expect(decideApproval(workspace, schemas, requested.id, { ...decision, decidedBy: "different-reviewer" }))
      .rejects.toMatchObject({ code: "APPROVAL_STATE_CONFLICT" });
    await expect(decideApproval(workspace, schemas, requested.id, decision)).resolves.toMatchObject({ status: "approved", decidedBy: "human-reviewer" });
  });

  it("repairs revocation audit after the Approval is already fail-closed", async () => {
    const { workspace, schemas, task } = await setup();
    const requested = await requestApproval(workspace, schemas, { taskId: task.id, action: "review-output" });
    await decideApproval(workspace, schemas, requested.id, { status: "approved", decidedBy: "human-reviewer", reason: "Approved." });
    const revocation = { status: "revoked" as const, decidedBy: "security-reviewer", reason: "Withdraw authority.", decidedAt: "2099-01-01T00:02:00.000Z" };
    injectApprovalFaultForTesting(workspace, "after-decision-record");
    await expect(decideApproval(workspace, schemas, requested.id, revocation)).rejects.toMatchObject({ code: "APPROVAL_TEST_FAULT" });
    await expect(getApproval(workspace, requested.id)).resolves.toMatchObject({ status: "revoked", revokedBy: "security-reviewer" });
    const recovered = await decideApproval(workspace, schemas, requested.id, revocation);
    await expect(decideApproval(workspace, schemas, requested.id, revocation)).resolves.toEqual(recovered);
    expect((await listLedgerEntries(workspace)).filter((entry) => entry.event === "approval-decided" && entry.approvalRef === requested.id && entry.summary.includes("revoked; decision sha256:"))).toHaveLength(1);
  });

  it("always requests first, supports explicit decisions, and audits the lifecycle", async () => {
    const { workspace, schemas, task } = await setup();
    const requested = await requestApproval(workspace, schemas, {
      taskId: task.id,
      action: "review-output",
      scope: ["report"],
      reason: "Human review requested."
    });
    expect(requested).toMatchObject({ taskId: task.id, action: "review-output", status: "requested", scope: ["report"] });
    await expect(listApprovals(workspace, task.id)).resolves.toHaveLength(1);
    await expect(inspectApproval(workspace, schemas, requested.id)).resolves.toMatchObject({ valid: true, taskExists: true });

    const approved = await decideApproval(workspace, schemas, requested.id, {
      status: "approved",
      decidedBy: "human-reviewer",
      reason: "Reviewed explicitly.",
      decidedAt: "2099-01-01T00:01:00.000Z"
    });
    expect(approved).toMatchObject({ status: "approved", decidedBy: "human-reviewer" });
    await expect(decideApproval(workspace, schemas, requested.id, {
      status: "approved",
      decidedBy: "human-reviewer",
      reason: "Reviewed explicitly.",
      decidedAt: "2099-01-01T00:01:00.000Z"
    })).resolves.toEqual(approved);
    await expect(decideApproval(workspace, schemas, requested.id, {
      status: "rejected",
      decidedBy: "another-reviewer",
      reason: "Changed decision."
    })).rejects.toMatchObject({ code: "APPROVAL_STATE_CONFLICT" });
    await expect(getApproval(workspace, requested.id)).resolves.toEqual(approved);
    await expect(verifyLedger(workspace)).resolves.toMatchObject({ valid: true, entries: 2 });
  });

  it("uses only matching approved records for L2 preflight and never authorizes DONE", async () => {
    const { workspace, schemas, task } = await setup();
    const requested = await requestApproval(workspace, schemas, { taskId: task.id, action: "review-output", scope: ["report"] });
    expect(evaluateTaskApproval(task, [requested], "review-output", ["report"]).code).toBe("APPROVAL_NOT_SATISFIED");

    const approved = await decideApproval(workspace, schemas, requested.id, { status: "approved", decidedBy: "human-reviewer", reason: "Approved." });
    expect(evaluateTaskApproval(task, [approved], "review-output", ["report"])).toMatchObject({ allowed: true, code: "APPROVAL_SATISFIED", matchedApprovals: [requested.id] });
    expect(evaluateTaskApproval(task, [approved], "other-action", ["report"]).allowed).toBe(false);
    expect(evaluateTaskApproval(task, [approved], "review-output", ["other-scope"]).allowed).toBe(false);
  });

  it("routes Task-level write scopes to the implemented controlled L1 WriteIntent flow", async () => {
    const task: TaskCharter = {
      id: "approval-write-task",
      workspaceId: "workspace-1",
      goal: "Write through the controlled path",
      requestedOutputs: ["file"],
      riskLevel: "L1",
      state: "SCOPED",
      writeSet: ["docs/guide.md"]
    };
    const result = evaluateTaskApproval(task, [], "write");
    expect(result).toMatchObject({ allowed: false, code: "WRITE_NOT_IMPLEMENTED" });
    expect(result.reasons[0]).toContain("controlled L1 WriteIntent flow");
    expect(result.reasons[0]).not.toContain("workspace writes are not implemented");
  });

  it("keeps L3 denied and rejects invalid decision metadata", async () => {
    const l3 = await setup({
      id: "l3-task",
      workspaceId: "workspace-1",
      goal: "High impact",
      requestedOutputs: ["decision"],
      riskLevel: "L3",
      state: "DRAFT",
      approvalRequired: true
    });
    expect(evaluateTaskApproval(l3.task, [], "review-output")).toMatchObject({ allowed: false, code: "HUMAN_APPROVAL_REQUIRED" });
    const requested = await requestApproval(l3.workspace, l3.schemas, { taskId: l3.task.id, action: "review-output" });
    await expect(decideApproval(l3.workspace, l3.schemas, requested.id, { status: "approved", decidedBy: "human", reason: "", decidedAt: "2025-01-01T00:00:00.000Z" })).rejects.toMatchObject({ code: "APPROVAL_INVALID" });
  });

  it("persists an optional expiresAt and projects it in inspection", async () => {
    const { workspace, schemas, task } = await setup();
    const requested = await requestApproval(workspace, schemas, { taskId: task.id, action: "review-output", expiresAt: "2099-01-01T00:00:00.000Z" });
    expect(requested.expiresAt).toBe("2099-01-01T00:00:00.000Z");
    await expect(inspectApproval(workspace, schemas, requested.id)).resolves.toMatchObject({ valid: true, expired: false });
  });

  it("treats an expired approved record as unsatisfied and reports the expiry reason", async () => {
    const { workspace, schemas, task } = await setup();
    const requested = await requestApproval(workspace, schemas, { taskId: task.id, action: "review-output", scope: ["report"] });
    const approved = await decideApproval(workspace, schemas, requested.id, { status: "approved", decidedBy: "human-reviewer", reason: "Approved.", expiresAt: "2099-01-01T00:00:00.000Z" });
    expect(evaluateTaskApproval(task, [approved], "review-output", ["report"], { now: new Date("2098-01-01T00:00:00.000Z") })).toMatchObject({ allowed: true, code: "APPROVAL_SATISFIED" });
    const expired = evaluateTaskApproval(task, [approved], "review-output", ["report"], { now: new Date("2100-01-01T00:00:00.000Z") });
    expect(expired).toMatchObject({ allowed: false, code: "APPROVAL_NOT_SATISFIED", matchedApprovals: [] });
    expect(expired.reasons[0]).toContain("expired");
  });

  it("projects an expired record in inspection without changing its stored status", async () => {
    const { workspace, schemas } = await setup();
    const id = "approval-expired-fixture";
    await mkdir(path.join(workspace.directory, "approvals"), { recursive: true });
    await writeWorkspaceJson(workspace, `approvals/${id}.json`, { id, taskId: "approval-task", action: "review-output", status: "approved", requestedAt: "2020-01-01T00:00:00.000Z", expiresAt: "2025-01-01T00:00:00.000Z", decidedAt: "2020-01-02T00:00:00.000Z", decidedBy: "human-reviewer", reason: "Approved." });
    const inspection = await inspectApproval(workspace, schemas, id);
    expect(inspection).toMatchObject({ valid: true, expired: true, approval: { status: "approved", expiresAt: "2025-01-01T00:00:00.000Z" } });
  });

  it("keeps a request-set expiresAt when the decision omits it", async () => {
    const { workspace, schemas, task } = await setup();
    const requested = await requestApproval(workspace, schemas, { taskId: task.id, action: "review-output", expiresAt: "2099-01-01T00:00:00.000Z" });
    const approved = await decideApproval(workspace, schemas, requested.id, { status: "approved", decidedBy: "human-reviewer", reason: "Approved." });
    expect(approved.expiresAt).toBe("2099-01-01T00:00:00.000Z");
  });

  it("makes an exact-owner Approval consumption retry idempotent and rejects another owner", async () => {
    const { workspace, schemas, task } = await setup();
    const requested = await requestApproval(workspace, schemas, { taskId: task.id, action: "review-output" });
    await decideApproval(workspace, schemas, requested.id, { status: "approved", decidedBy: "human-reviewer", reason: "Approved." });
    const consumed = await consumeApproval(workspace, schemas, requested.id, "subject-owner-1");
    await expect(consumeApproval(workspace, schemas, requested.id, "subject-owner-1")).resolves.toEqual(consumed);
    await expect(consumeApproval(workspace, schemas, requested.id, "subject-owner-2"))
      .rejects.toMatchObject({ code: "APPROVAL_ALREADY_CONSUMED" });
  });

  it("rejects an expiresAt that precedes requestedAt on request and decision paths", async () => {
    const { workspace, schemas, task } = await setup();
    await expect(requestApproval(workspace, schemas, { taskId: task.id, action: "review-output", expiresAt: "2020-01-01T00:00:00.000Z" })).rejects.toMatchObject({ code: "APPROVAL_INVALID" });
    const requested = await requestApproval(workspace, schemas, { taskId: task.id, action: "review-output" });
    await expect(decideApproval(workspace, schemas, requested.id, { status: "approved", decidedBy: "human-reviewer", reason: "Approved.", expiresAt: "2020-01-01T00:00:00.000Z" })).rejects.toMatchObject({ code: "APPROVAL_INVALID" });
  });

  it("rejects stored Approvals that fail schema or canonical ID binding", async () => {
    const { workspace, schemas, task } = await setup();
    const approval = await requestApproval(workspace, schemas, { taskId: task.id, action: "review-output" });
    const file = path.join(workspace.directory, "approvals", `${approval.id}.json`);
    await writeFile(file, JSON.stringify({ ...approval, unexpectedAuthority: true }), "utf8");
    await expect(getApproval(workspace, approval.id)).rejects.toMatchObject({ code: "SCHEMA_INVALID" });
    await writeFile(file, JSON.stringify({ ...approval, id: "approval-other" }), "utf8");
    await expect(getApproval(workspace, approval.id)).rejects.toMatchObject({ code: "APPROVAL_INVALID" });
  });
});
