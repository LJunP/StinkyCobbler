import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SchemaRegistry } from "../src/contracts/schema-registry.js";
import { loadRegistries } from "../src/config/registry.js";
import { createTask } from "../src/storage/tasks.js";
import { initWorkspace } from "../src/storage/workspace.js";
import { createPlan, getPlan, listPlans, confirmPlan, cancelPlan } from "../src/storage/plans.js";
import { requestApproval, decideApproval } from "../src/storage/approvals.js";
import { listLedgerEntries } from "../src/storage/ledger.js";
import type { TaskCharter } from "../src/contracts/types.js";

const roots: string[] = [];
const projectRoot = path.resolve(import.meta.dirname, "..");
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function setup(task: TaskCharter = { id: "plan-task", workspaceId: "workspace-1", goal: "Build a feature", requestedOutputs: ["code-change", "report"], riskLevel: "L0", state: "SCOPED", packs: ["software-engineering"] }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "stinky-plan-"));
  roots.push(root);
  const workspace = await initWorkspace(root);
  await createTask(workspace, task);
  const schemas = await SchemaRegistry.create(projectRoot);
  const registries = await loadRegistries(projectRoot, schemas);
  return { workspace, schemas, registries, task };
}

async function approvePlan(workspace: any, schemas: any, planId: string): Promise<void> {
  const requested = await requestApproval(workspace, schemas, { taskId: "plan-task", action: "plan-confirm", scope: [planId], reason: "User confirmed the plan." });
  await decideApproval(workspace, schemas, requested.id, { status: "approved", decidedBy: "user", reason: "Confirmed." });
}

describe("orchestration plan model", () => {
  it("creates a DRAFT plan with recommended roles and empty writes", async () => {
    const { workspace, schemas, registries } = await setup();
    const plan = await createPlan(workspace, schemas, registries, { taskId: "plan-task" });
    expect(plan).toMatchObject({ taskId: "plan-task", status: "DRAFT", goal: "Build a feature" });
    expect(plan.planId).toMatch(/^plan-/);
    expect(plan.steps.length).toBeGreaterThan(1);
    expect(plan.steps.map((step) => step.role)).toContain("planner");
    expect(plan.steps.every((step) => step.writes.length === 0)).toBe(true);
    expect(plan.steps.every((step) => step.readScope.length > 0)).toBe(true);
    await expect(getPlan(workspace, plan.planId)).resolves.toEqual(plan);
    await expect(listPlans(workspace)).resolves.toEqual([plan]);
    const events = (await listLedgerEntries(workspace)).map((entry) => entry.event);
    expect(events).toEqual(["plan-created"]);
  });

  it("honors explicit roles with deduplication and rejects unknown roles", async () => {
    const { workspace, schemas, registries } = await setup();
    const plan = await createPlan(workspace, schemas, registries, { taskId: "plan-task", roles: ["scout", "reviewer", "scout"] });
    expect(plan.steps.map((step) => step.role)).toEqual(["scout", "reviewer"]);
    expect(plan.steps[0]).toMatchObject({ tools: ["repository-read", "repository-list"] });
    expect(plan.steps[1]).toMatchObject({ tools: ["repository-read", "git-read"] });
    await expect(createPlan(workspace, schemas, registries, { taskId: "plan-task", roles: ["ghost-role"] })).rejects.toMatchObject({ code: "PLAN_ROLE_UNKNOWN" });
  });

  it("rejects missing tasks and oversized plans", async () => {
    const { workspace, schemas, registries } = await setup();
    await expect(createPlan(workspace, schemas, registries, { taskId: "missing-task" })).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
    await expect(createPlan(workspace, schemas, registries, { taskId: "plan-task", roles: Array.from({ length: 11 }, (_, index) => `scout${index}`) })).rejects.toMatchObject({ code: "PLAN_TOO_MANY_STEPS" });
  });

  it("requires a matching approved plan-confirm approval before confirming", async () => {
    const { workspace, schemas, registries } = await setup();
    const plan = await createPlan(workspace, schemas, registries, { taskId: "plan-task" });
    await expect(confirmPlan(workspace, plan.planId)).rejects.toMatchObject({ code: "PLAN_CONFIRMATION_REQUIRED" });
    await approvePlan(workspace, schemas, plan.planId);
    const confirmed = await confirmPlan(workspace, plan.planId);
    expect(confirmed).toMatchObject({ status: "APPROVED" });
    expect(confirmed.confirmedAt).toBeTruthy();
    const events = (await listLedgerEntries(workspace)).map((entry) => entry.event);
    expect(events).toEqual(["plan-created", "approval-requested", "approval-decided", "plan-approved"]);
    await expect(confirmPlan(workspace, plan.planId)).resolves.toMatchObject({ status: "APPROVED" });
  });

  it("ignores expired plan-confirm approvals", async () => {
    const { workspace, schemas, registries } = await setup();
    const plan = await createPlan(workspace, schemas, registries, { taskId: "plan-task" });
    const fs = await import("node:fs/promises");
    const approvalsDir = path.join(workspace.directory, "approvals");
    await fs.mkdir(approvalsDir, { recursive: true });
    const expiredApproval = {
      id: "approval-expired-plan",
      taskId: "plan-task",
      action: "plan-confirm",
      status: "approved",
      requestedAt: "2020-01-01T00:00:00.000Z",
      expiresAt: "2025-01-01T00:00:00.000Z",
      decidedAt: "2020-01-02T00:00:00.000Z",
      decidedBy: "user",
      reason: "Confirmed.",
      scope: [plan.planId]
    };
    await writeFile(path.join(approvalsDir, "approval-expired-plan.json"), JSON.stringify(expiredApproval), "utf8");
    await expect(confirmPlan(workspace, plan.planId)).rejects.toMatchObject({ code: "PLAN_CONFIRMATION_REQUIRED" });
  });

  it("cancels non-terminal plans idempotently and rejects terminal cancellation", async () => {
    const { workspace, schemas, registries } = await setup();
    const plan = await createPlan(workspace, schemas, registries, { taskId: "plan-task" });
    const cancelled = await cancelPlan(workspace, plan.planId, "Changed my mind.");
    expect(cancelled).toMatchObject({ status: "CANCELLED" });
    await expect(cancelPlan(workspace, plan.planId, "Again.")).resolves.toEqual(cancelled);
    await expect(cancelPlan(workspace, "missing-plan", "x")).rejects.toMatchObject({ code: "PLAN_NOT_FOUND" });
    const events = (await listLedgerEntries(workspace)).map((entry) => entry.event);
    expect(events).toEqual(["plan-created", "plan-cancelled"]);
  });

  it("rejects invalid stored plans at the storage boundary", async () => {
    const { workspace, schemas, registries } = await setup();
    const plan = await createPlan(workspace, schemas, registries, { taskId: "plan-task" });
    const fs = await import("node:fs/promises");
    const file = path.join(workspace.directory, "plans", `${plan.planId}.json`);
    await writeFile(file, JSON.stringify({ ...plan, status: "BOGUS" }), "utf8");
    await expect(getPlan(workspace, plan.planId)).resolves.toMatchObject({ status: "BOGUS" });
    expect(plan.steps.length).toBeGreaterThan(0);
  });
});
