import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SchemaRegistry } from "../src/contracts/schema-registry.js";
import { createTask } from "../src/storage/tasks.js";
import { initWorkspace } from "../src/storage/workspace.js";
import { decideApproval, getApproval, inspectApproval, listApprovals, requestApproval } from "../src/storage/approvals.js";
import { evaluateTaskApproval } from "../src/policy/approval.js";
import { verifyLedger } from "../src/storage/ledger.js";
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

  it("rejects an expiresAt that precedes requestedAt on request and decision paths", async () => {
    const { workspace, schemas, task } = await setup();
    await expect(requestApproval(workspace, schemas, { taskId: task.id, action: "review-output", expiresAt: "2020-01-01T00:00:00.000Z" })).rejects.toMatchObject({ code: "APPROVAL_INVALID" });
    const requested = await requestApproval(workspace, schemas, { taskId: task.id, action: "review-output" });
    await expect(decideApproval(workspace, schemas, requested.id, { status: "approved", decidedBy: "human-reviewer", reason: "Approved.", expiresAt: "2020-01-01T00:00:00.000Z" })).rejects.toMatchObject({ code: "APPROVAL_INVALID" });
  });
});
