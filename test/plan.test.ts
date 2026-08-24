import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SchemaRegistry } from "../src/contracts/schema-registry.js";
import { loadRegistries } from "../src/config/registry.js";
import { createTask, saveTask } from "../src/storage/tasks.js";
import { initWorkspace, writeWorkspaceJson } from "../src/storage/workspace.js";
import { createPlan, getPlan, listPlans, confirmPlan, cancelPlan, ensurePlanLifecycleCommitted, injectPlanConfirmationFaultForTesting, injectPlanLifecycleFaultForTesting } from "../src/storage/plans.js";
import { consumeApproval, decideApproval, getApproval, requestApproval } from "../src/storage/approvals.js";
import { listLedgerEntries } from "../src/storage/ledger.js";
import type { TaskCharter } from "../src/contracts/types.js";
import { approvePlanConfirmation } from "./helpers/authority.js";

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
  return { workspace, schemas, registries, task, root };
}

describe("orchestration plan model", () => {
  it("creates a DRAFT plan with recommended roles and empty writes", async () => {
    const { workspace, schemas, registries } = await setup();
    const plan = await createPlan(workspace, schemas, registries, { taskId: "plan-task" });
    expect(plan).toMatchObject({
      taskId: "plan-task",
      generation: 0,
      status: "DRAFT",
      goal: "Build a feature",
      policyVersion: "task-authority-v1",
      hostSessionId: "local-cli",
      planSubjectVersion: 1
    });
    expect(plan.taskAuthorityHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(plan.planSubjectHash).toMatch(/^sha256:[a-f0-9]{64}$/);
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

  for (const point of ["after-plan", "after-ledger"] as const) {
    it(`repairs Plan creation exactly once after ${point}`, async () => {
      const { workspace, schemas, registries } = await setup();
      injectPlanLifecycleFaultForTesting(workspace, point);
      await expect(createPlan(workspace, schemas, registries, { taskId: "plan-task", roles: ["scout"] }))
        .rejects.toMatchObject({ code: "PLAN_LIFECYCLE_FAULT_INJECTED", details: { point } });
      const plans = await listPlans(workspace, "plan-task");
      expect(plans).toHaveLength(1);
      const recovered = await createPlan(workspace, schemas, registries, { taskId: "plan-task", roles: ["scout"] });
      expect(recovered.planId).toBe(plans[0]!.planId);
      await ensurePlanLifecycleCommitted(workspace, recovered);
      expect(await listPlans(workspace, "plan-task")).toHaveLength(1);
      expect((await listLedgerEntries(workspace)).filter((entry) => entry.event === "plan-created" && entry.planRef === plans[0]!.planId)).toHaveLength(1);
    });
  }

  it("honors explicit roles with deduplication and rejects unknown roles", async () => {
    const { workspace, schemas, registries } = await setup();
    const plan = await createPlan(workspace, schemas, registries, { taskId: "plan-task", roles: ["scout", "reviewer", "scout"] });
    expect(plan.steps.map((step) => step.role)).toEqual(["scout", "reviewer"]);
    expect(plan.steps[0]).toMatchObject({ tools: ["repository-read", "repository-list", "docs-index"] });
    expect(plan.steps[1]).toMatchObject({ tools: ["repository-read", "git-read"] });
    await expect(createPlan(workspace, schemas, registries, { taskId: "plan-task", roles: ["ghost-role"] })).rejects.toMatchObject({ code: "PLAN_ROLE_UNKNOWN" });
  });

  it("rejects missing tasks and oversized plans", async () => {
    const { workspace, schemas, registries } = await setup();
    await expect(createPlan(workspace, schemas, registries, { taskId: "missing-task" })).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
    await expect(createPlan(workspace, schemas, registries, { taskId: "plan-task", roles: Array.from({ length: 11 }, (_, index) => `scout${index}`) })).rejects.toMatchObject({ code: "PLAN_TOO_MANY_STEPS" });
  });

  it("does not create new Plan lifecycles for terminal Tasks", async () => {
    for (const state of ["DONE", "ARCHIVED", "CANCELLED"] as const) {
      const initialState = state === "DONE" ? "VERIFYING" : state;
      const value = await setup({
        id: `terminal-${state.toLowerCase()}`,
        workspaceId: "workspace-1",
        goal: "Already terminal",
        requestedOutputs: ["report"],
        riskLevel: "L0",
        state: initialState
      });
      if (state === "DONE") {
        await writeWorkspaceJson(value.workspace, `task-terminal-done.json`, {
          ...value.task,
          state: "DONE",
          completionReceiptRef: "runtime-receipt-placeholder",
          completionEvidenceRefs: ["evidence-placeholder"]
        });
      }
      await expect(createPlan(value.workspace, value.schemas, value.registries, { taskId: `terminal-${state.toLowerCase()}`, roles: ["conductor"] }))
        .rejects.toMatchObject({ code: "PLAN_TASK_STATE_CLOSED", details: { state } });
    }
  });

  it("bounds every nested caller-controlled Plan collection", async () => {
    const { workspace, schemas, registries } = await setup();
    const plan = await createPlan(workspace, schemas, registries, { taskId: "plan-task", roles: ["scout"] });
    const step = plan.steps[0]!;
    const oversized = [
      { ...step, tools: Array.from({ length: 33 }, (_, index) => `tool-${index}`) },
      { ...step, readScope: Array.from({ length: 65 }, (_, index) => `docs/${index}`) },
      { ...step, writes: Array.from({ length: 21 }, (_, index) => ({ target: `docs/${index}.md`, action: "modify" as const, purpose: "bounded" })) },
      { ...step, dependsOn: Array.from({ length: 11 }, (_, index) => `step-${index + 2}`) },
      { ...step, evidenceRefs: Array.from({ length: 21 }, (_, index) => `evidence-${index}`) },
      { ...step, leaseRefs: Array.from({ length: 65 }, (_, index) => `lease-${index}`) }
    ];
    for (const candidate of oversized) {
      expect(() => schemas.validate("plan", { ...plan, steps: [candidate] })).toThrow();
    }
  });

  it("enforces the workspace-configured plan step limit", async () => {
    const { workspace, schemas, registries, root } = await setup();
    const policies = path.join(root, ".stinky-cobbler", "policies");
    await mkdir(policies, { recursive: true });
    await writeFile(path.join(policies, "orchestration.yaml"), "version: 1\ndefaults:\n  maxSteps: 1\n", "utf8");
    await expect(createPlan(workspace, schemas, registries, { taskId: "plan-task", roles: ["scout", "reviewer"] }))
      .rejects.toMatchObject({ code: "PLAN_TOO_MANY_STEPS", details: { maxSteps: 1 } });
  });

  it("requires and consumes a precise one-shot plan-confirm Approval", async () => {
    const { workspace, schemas, registries } = await setup();
    const plan = await createPlan(workspace, schemas, registries, { taskId: "plan-task" });
    await expect(confirmPlan(workspace, plan.planId)).rejects.toMatchObject({ code: "PLAN_CONFIRMATION_REQUIRED" });
    const legacy = await requestApproval(workspace, schemas, { taskId: "plan-task", action: "plan-confirm", scope: [plan.planId], reason: "Legacy path-only confirmation." });
    await decideApproval(workspace, schemas, legacy.id, { status: "approved", decidedBy: "user", reason: "Confirmed." });
    await expect(confirmPlan(workspace, plan.planId)).rejects.toMatchObject({ code: "PLAN_CONFIRMATION_REQUIRED" });
    const approval = await approvePlanConfirmation(workspace, schemas, plan);
    const confirmed = await confirmPlan(workspace, plan.planId);
    expect(confirmed).toMatchObject({ status: "APPROVED", approvalRef: approval.id });
    expect(confirmed.confirmedAt).toBeTruthy();
    await expect(getApproval(workspace, approval.id)).resolves.toMatchObject({ consumedBy: plan.planId });
    const events = (await listLedgerEntries(workspace)).map((entry) => entry.event);
    expect(events).toEqual(["plan-created", "approval-requested", "approval-decided", "approval-requested", "approval-decided", "plan-approved"]);
    await expect(confirmPlan(workspace, plan.planId)).resolves.toMatchObject({ status: "APPROVED" });
  });

  it("rejects cross-session precise Plan confirmations", async () => {
    const { workspace, schemas, registries } = await setup();
    const plan = await createPlan(workspace, schemas, registries, { taskId: "plan-task", hostSessionId: "host-session-a" });
    await approvePlanConfirmation(workspace, schemas, plan, "host-session-b");
    await expect(confirmPlan(workspace, plan.planId, "host-session-a")).rejects.toMatchObject({ code: "PLAN_CONFIRMATION_REQUIRED" });
    await expect(confirmPlan(workspace, plan.planId, "host-session-b")).rejects.toMatchObject({ code: "PLAN_HOST_SESSION_MISMATCH" });
  });

  it("rejects an Approval bound to another Plan subject even when its scope names this Plan", async () => {
    const { workspace, schemas, registries } = await setup();
    const first = await createPlan(workspace, schemas, registries, { taskId: "plan-task", roles: ["scout"] });
    const target = await createPlan(workspace, schemas, registries, { taskId: "plan-task", roles: ["reviewer"] });
    const requested = await requestApproval(workspace, schemas, {
      taskId: target.taskId,
      action: "plan-confirm",
      scope: [target.planId],
      subjectKind: "plan",
      subjectId: first.planId,
      subjectVersion: first.planSubjectVersion,
      subjectHash: first.planSubjectHash,
      capability: "plan-execute",
      budget: { maxToolCalls: 1, expiresAt: "2099-01-01T00:00:00.000Z" },
      policyVersion: target.policyVersion,
      requestedBy: "test-host",
      hostSessionId: target.hostSessionId,
      nonce: "wrong-plan-subject-nonce",
      expiresAt: "2099-01-01T00:00:00.000Z",
      reason: "Must not cross Plan subjects."
    });
    await decideApproval(workspace, schemas, requested.id, { status: "approved", decidedBy: "test-host", reason: "Approved for regression test." });
    await expect(confirmPlan(workspace, target.planId)).rejects.toMatchObject({ code: "PLAN_CONFIRMATION_REQUIRED" });
  });

  it("rejects a Plan and its Approval after Task authority drifts", async () => {
    const { workspace, schemas, registries, task } = await setup();
    const plan = await createPlan(workspace, schemas, registries, { taskId: "plan-task" });
    await approvePlanConfirmation(workspace, schemas, plan);
    await saveTask(workspace, { ...task, constraints: ["new authority constraint"] });
    await expect(confirmPlan(workspace, plan.planId)).rejects.toMatchObject({ code: "PLAN_TASK_AUTHORITY_STALE" });
  });

  it("rejects a precise Plan Approval consumed by another owner", async () => {
    const { workspace, schemas, registries } = await setup();
    const plan = await createPlan(workspace, schemas, registries, { taskId: "plan-task" });
    const approval = await approvePlanConfirmation(workspace, schemas, plan);
    await consumeApproval(workspace, schemas, approval.id, "different-plan-owner");
    await expect(confirmPlan(workspace, plan.planId)).rejects.toMatchObject({ code: "PLAN_CONFIRMATION_REQUIRED" });
  });

  it("recovers idempotently when the precise Approval was already consumed by the same Plan", async () => {
    const { workspace, schemas, registries } = await setup();
    const plan = await createPlan(workspace, schemas, registries, { taskId: "plan-task" });
    const approval = await approvePlanConfirmation(workspace, schemas, plan);
    await consumeApproval(workspace, schemas, approval.id, plan.planId);
    await expect(confirmPlan(workspace, plan.planId)).resolves.toMatchObject({ status: "APPROVED" });
    await expect(confirmPlan(workspace, plan.planId)).resolves.toMatchObject({ status: "APPROVED" });
  });

  for (const point of ["after-consume", "after-plan"] as const) {
    it(`repairs Plan confirmation exactly once after ${point}`, async () => {
      const { workspace, schemas, registries } = await setup();
      const plan = await createPlan(workspace, schemas, registries, { taskId: "plan-task" });
      const approval = await approvePlanConfirmation(workspace, schemas, plan);
      injectPlanConfirmationFaultForTesting(workspace, point);
      await expect(confirmPlan(workspace, plan.planId)).rejects.toMatchObject({ code: "PLAN_CONFIRMATION_TEST_FAULT" });

      await expect(confirmPlan(workspace, plan.planId)).resolves.toMatchObject({ status: "APPROVED" });
      await expect(confirmPlan(workspace, plan.planId)).resolves.toMatchObject({ status: "APPROVED" });
      await expect(getApproval(workspace, approval.id)).resolves.toMatchObject({ consumedBy: plan.planId });
      const approvals = (await listLedgerEntries(workspace)).filter((entry) => entry.event === "plan-approved" && entry.planRef === plan.planId);
      expect(approvals).toHaveLength(1);
      expect(approvals[0]?.approvalRef).toBe(approval.id);
    });
  }

  it("repairs only Plan approval audit after the APPROVED state is written, even if the consumed Approval is revoked", async () => {
    const { workspace, schemas, registries } = await setup();
    const plan = await createPlan(workspace, schemas, registries, { taskId: "plan-task" });
    const approval = await approvePlanConfirmation(workspace, schemas, plan);
    injectPlanConfirmationFaultForTesting(workspace, "after-plan");
    await expect(confirmPlan(workspace, plan.planId)).rejects.toMatchObject({ code: "PLAN_CONFIRMATION_TEST_FAULT" });
    await expect(getPlan(workspace, plan.planId)).resolves.toMatchObject({ status: "APPROVED", approvalRef: approval.id });

    await decideApproval(workspace, schemas, approval.id, { status: "revoked", decidedBy: "test-host", reason: "Revoke after the Plan commit point." });
    await expect(confirmPlan(workspace, plan.planId)).resolves.toMatchObject({ status: "APPROVED", approvalRef: approval.id });
    await expect(confirmPlan(workspace, plan.planId)).resolves.toMatchObject({ status: "APPROVED", approvalRef: approval.id });

    const entries = (await listLedgerEntries(workspace)).filter((entry) => entry.event === "plan-approved" && entry.planRef === plan.planId);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.approvalRef).toBe(approval.id);
  });

  it("keeps legacy Plans readable and cancellable but not confirmable", async () => {
    const { workspace, schemas, registries } = await setup();
    const plan = await createPlan(workspace, schemas, registries, { taskId: "plan-task" });
    const file = path.join(workspace.directory, "plans", `${plan.planId}.json`);
    const legacy = { ...plan } as Record<string, unknown>;
    delete legacy.generation;
    delete legacy.taskAuthorityHash;
    delete legacy.policyVersion;
    delete legacy.hostSessionId;
    delete legacy.planSubjectVersion;
    delete legacy.planSubjectHash;
    await writeFile(file, JSON.stringify(legacy), "utf8");
    await expect(getPlan(workspace, plan.planId)).resolves.toMatchObject({ planId: plan.planId, status: "DRAFT" });
    await expect(confirmPlan(workspace, plan.planId)).rejects.toMatchObject({ code: "PLAN_REISSUE_REQUIRED" });
    await expect(cancelPlan(workspace, plan.planId, "Retire legacy Plan.")).resolves.toMatchObject({ status: "CANCELLED" });
  });

  it("rejects a Plan whose immutable subject changed after creation", async () => {
    const { workspace, schemas, registries } = await setup();
    const plan = await createPlan(workspace, schemas, registries, { taskId: "plan-task" });
    const file = path.join(workspace.directory, "plans", `${plan.planId}.json`);
    await writeFile(file, JSON.stringify({ ...plan, goal: "Tampered goal" }), "utf8");
    await expect(confirmPlan(workspace, plan.planId)).rejects.toMatchObject({ code: "PLAN_REISSUE_REQUIRED" });
  });

  it("ignores expired precise plan-confirm approvals", async () => {
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
      scope: [plan.planId],
      subjectKind: "plan",
      subjectId: plan.planId,
      subjectVersion: plan.planSubjectVersion,
      subjectHash: plan.planSubjectHash,
      capability: "plan-execute",
      budget: { maxToolCalls: 1, expiresAt: "2025-01-01T00:00:00.000Z" },
      policyVersion: plan.policyVersion,
      requestedBy: "test-host",
      hostSessionId: plan.hostSessionId,
      nonce: "expired-plan-confirm-nonce"
    };
    await writeFile(path.join(approvalsDir, "approval-expired-plan.json"), JSON.stringify(expiredApproval), "utf8");
    await expect(confirmPlan(workspace, plan.planId)).rejects.toMatchObject({ code: "PLAN_CONFIRMATION_REQUIRED" });
  });

  it("cancels non-terminal plans idempotently and rejects terminal cancellation", async () => {
    const { workspace, schemas, registries } = await setup();
    const plan = await createPlan(workspace, schemas, registries, { taskId: "plan-task" });
    const cancelled = await cancelPlan(workspace, plan.planId, "Changed my mind.");
    expect(cancelled).toMatchObject({ status: "CANCELLED" });
    await expect(cancelPlan(workspace, plan.planId, "Changed my mind.")).resolves.toEqual(cancelled);
    await expect(cancelPlan(workspace, plan.planId, "Again."))
      .rejects.toMatchObject({ code: "PLAN_IDEMPOTENCY_CONFLICT" });
    await expect(cancelPlan(workspace, "missing-plan", "x")).rejects.toMatchObject({ code: "PLAN_NOT_FOUND" });
    const events = (await listLedgerEntries(workspace)).map((entry) => entry.event);
    expect(events).toEqual(["plan-created", "plan-cancelled"]);
  });

  for (const point of ["after-plan", "after-ledger"] as const) {
    it(`repairs Plan cancellation exactly once after ${point}`, async () => {
      const { workspace, schemas, registries } = await setup();
      const plan = await createPlan(workspace, schemas, registries, { taskId: "plan-task", roles: ["scout"] });
      injectPlanLifecycleFaultForTesting(workspace, point);
      await expect(cancelPlan(workspace, plan.planId, "Original cancellation reason."))
        .rejects.toMatchObject({ code: "PLAN_LIFECYCLE_FAULT_INJECTED", details: { point } });
      await expect(cancelPlan(workspace, plan.planId, "A later retry cannot replace the persisted reason."))
        .rejects.toMatchObject({ code: "PLAN_IDEMPOTENCY_CONFLICT" });
      const recovered = await cancelPlan(workspace, plan.planId, "Original cancellation reason.");
      expect(recovered).toMatchObject({ status: "CANCELLED", cancellationReasonHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/) });
      expect((await listLedgerEntries(workspace)).filter((entry) => entry.event === "plan-cancelled" && entry.planRef === plan.planId)).toHaveLength(1);
    });
  }

  it("rejects invalid stored plans at the storage boundary", async () => {
    const { workspace, schemas, registries } = await setup();
    const plan = await createPlan(workspace, schemas, registries, { taskId: "plan-task" });
    const fs = await import("node:fs/promises");
    const file = path.join(workspace.directory, "plans", `${plan.planId}.json`);
    await writeFile(file, JSON.stringify({ ...plan, status: "BOGUS" }), "utf8");
    await expect(getPlan(workspace, plan.planId)).rejects.toMatchObject({ code: "SCHEMA_INVALID" });
    await writeFile(file, JSON.stringify({ ...plan, planId: "plan-other" }), "utf8");
    await expect(getPlan(workspace, plan.planId)).rejects.toMatchObject({ code: "PLAN_INVALID" });
    expect(plan.steps.length).toBeGreaterThan(0);
  });
});
