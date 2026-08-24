import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SchemaRegistry } from "../src/contracts/schema-registry.js";
import { loadRegistries } from "../src/config/registry.js";
import { createTask, getTask, saveTask } from "../src/storage/tasks.js";
import { initWorkspace } from "../src/storage/workspace.js";
import { createPlan, confirmPlan, executePlan, beginStep, completeStep, failStep, finishPlan, failPlan, getPlan, cancelPlan, injectPlanLifecycleFaultForTesting } from "../src/storage/plans.js";
import { requestWrites, rejectWrites, listWriteIntents } from "../src/storage/write-intents.js";
import { issueLease, listLeases } from "../src/storage/leases.js";
import { listLedgerEntries } from "../src/storage/ledger.js";
import { evaluateLease } from "../src/policy/evaluate.js";
import type { TaskCharter } from "../src/contracts/types.js";
import { approvePlanConfirmation, approveTaskCapability } from "./helpers/authority.js";
import { admitAndReserveLeaseCall } from "../src/storage/lease-usage.js";
import { writeWorkspaceJson } from "../src/storage/workspace.js";
import { decideApproval } from "../src/storage/approvals.js";

const roots: string[] = [];
const projectRoot = path.resolve(import.meta.dirname, "..");
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function setup(task: TaskCharter = { id: "exec-task", workspaceId: "workspace-1", goal: "Build a feature", requestedOutputs: ["code-change", "report"], riskLevel: "L0", state: "SCOPED", packs: ["software-engineering"] }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "stinky-plan-exec-"));
  roots.push(root);
  const workspace = await initWorkspace(root);
  await createTask(workspace, task);
  const schemas = await SchemaRegistry.create(projectRoot);
  const registries = await loadRegistries(projectRoot, schemas);
  return { workspace, schemas, registries, task };
}

async function approvedPlan(workspace: any, schemas: any, registries: any, roles?: string[]): Promise<string> {
  const plan = await createPlan(workspace, schemas, registries, { taskId: "exec-task", ...(roles === undefined ? {} : { roles }) });
  await approvePlanConfirmation(workspace, schemas, plan);
  await confirmPlan(workspace, plan.planId);
  return plan.planId;
}

describe("plan scheduling loop", () => {
  it("executes only APPROVED plans", async () => {
    const { workspace, schemas, registries } = await setup();
    const plan = await createPlan(workspace, schemas, registries, { taskId: "exec-task", roles: ["scout"] });
    await expect(executePlan(workspace, plan.planId)).rejects.toMatchObject({ code: "PLAN_STATE_CONFLICT" });
    const planId = await approvedPlan(workspace, schemas, registries, ["scout"]);
    const executing = await executePlan(workspace, planId);
    expect(executing.status).toBe("EXECUTING");
    expect(executing.generation).toBe(1);
    const events = (await listLedgerEntries(workspace)).map((entry) => entry.event);
    expect(events).toContain("plan-executing");
  });

  it("rejects execution after a Plan confirmation Approval expires", async () => {
    const { workspace, schemas, registries } = await setup();
    const plan = await createPlan(workspace, schemas, registries, { taskId: "exec-task", roles: ["scout"] });
    await approvePlanConfirmation(workspace, schemas, plan);
    await confirmPlan(workspace, plan.planId);
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2100-01-01T00:00:00.000Z"));
      await expect(executePlan(workspace, plan.planId)).rejects.toMatchObject({ code: "PLAN_CONFIRMATION_NOT_ACTIVE" });
    } finally {
      vi.useRealTimers();
    }
    await expect(cancelPlan(workspace, plan.planId, "Expired confirmation cannot execute.")).resolves.toMatchObject({ status: "CANCELLED" });
  });

  it("fences every Plan mutation and bound Lease use after the confirmation Approval is revoked, while cancellation remains available", async () => {
    const { workspace, schemas, registries } = await setup();
    const plan = await createPlan(workspace, schemas, registries, { taskId: "exec-task", roles: ["scout", "reviewer"] });
    const approval = await approvePlanConfirmation(workspace, schemas, plan);
    await confirmPlan(workspace, plan.planId);
    await executePlan(workspace, plan.planId);
    const begun = await beginStep(workspace, schemas, plan.planId, "step-1");
    await decideApproval(workspace, schemas, approval.id, { status: "revoked", decidedBy: "test-host", reason: "Stop Plan execution authority." });

    await expect(beginStep(workspace, schemas, plan.planId, "step-2")).rejects.toMatchObject({ code: "PLAN_CONFIRMATION_NOT_ACTIVE" });
    await expect(completeStep(workspace, plan.planId, "step-1")).rejects.toMatchObject({ code: "PLAN_CONFIRMATION_NOT_ACTIVE" });
    await expect(failStep(workspace, plan.planId, "step-1", "Must not mutate after revoke.")).rejects.toMatchObject({ code: "PLAN_CONFIRMATION_NOT_ACTIVE" });
    await expect(finishPlan(workspace, plan.planId)).rejects.toMatchObject({ code: "PLAN_CONFIRMATION_NOT_ACTIVE" });
    await expect(failPlan(workspace, plan.planId, "Must not terminalize after revoke.")).rejects.toMatchObject({ code: "PLAN_CONFIRMATION_NOT_ACTIVE" });
    for (const lease of begun.leases) {
      await expect(admitAndReserveLeaseCall(workspace, lease.id, { taskId: "exec-task", role: lease.role, capability: lease.capability }))
        .resolves.toMatchObject({ decision: { allowed: false, code: "LEASE_PLAN_CONFIRMATION_NOT_ACTIVE" } });
    }

    await expect(cancelPlan(workspace, plan.planId, "Confirmation was revoked.")).resolves.toMatchObject({ status: "CANCELLED" });
  });

  it("rejects a Plan-bound Lease when the persisted Plan subject no longer matches its immutable hash", async () => {
    const { workspace, schemas, registries } = await setup();
    const planId = await approvedPlan(workspace, schemas, registries, ["scout"]);
    await executePlan(workspace, planId);
    const begun = await beginStep(workspace, schemas, planId, "step-1");
    const plan = await getPlan(workspace, planId);
    await writeWorkspaceJson(workspace, `plans/${planId}.json`, { ...plan, goal: "Tampered after confirmation" });

    const lease = begun.leases[0]!;
    await expect(admitAndReserveLeaseCall(workspace, lease.id, { taskId: "exec-task", role: lease.role, capability: lease.capability }))
      .resolves.toMatchObject({ decision: { allowed: false, code: "LEASE_PLAN_CONFIRMATION_INVALID" } });
  });

  it("rejects beginning a tool-free step after Task authority drifts", async () => {
    const { workspace, schemas, registries, task } = await setup();
    const planId = await approvedPlan(workspace, schemas, registries, ["conductor"]);
    await executePlan(workspace, planId);
    await saveTask(workspace, { ...task, constraints: ["authority changed before dispatch"] });

    await expect(beginStep(workspace, schemas, planId, "step-1"))
      .rejects.toMatchObject({ code: "PLAN_TASK_AUTHORITY_STALE" });
    await expect(getPlan(workspace, planId)).resolves.toMatchObject({
      status: "EXECUTING",
      steps: [expect.objectContaining({ stepId: "step-1", status: "PENDING" })]
    });
  });

  it("rejects every running Plan mutation after Task authority drifts", async () => {
    const { workspace, schemas, registries, task } = await setup();
    const planId = await approvedPlan(workspace, schemas, registries, ["conductor"]);
    await executePlan(workspace, planId);
    await beginStep(workspace, schemas, planId, "step-1");
    await saveTask(workspace, { ...task, constraints: ["authority changed during execution"] });

    await expect(completeStep(workspace, planId, "step-1"))
      .rejects.toMatchObject({ code: "PLAN_TASK_AUTHORITY_STALE" });
    await expect(failStep(workspace, planId, "step-1", "Must not bypass Task drift."))
      .rejects.toMatchObject({ code: "PLAN_TASK_AUTHORITY_STALE" });
    await expect(finishPlan(workspace, planId))
      .rejects.toMatchObject({ code: "PLAN_TASK_AUTHORITY_STALE" });
    await expect(failPlan(workspace, planId, "Must not terminalize after Task drift."))
      .rejects.toMatchObject({ code: "PLAN_TASK_AUTHORITY_STALE" });
    await expect(getPlan(workspace, planId)).resolves.toMatchObject({
      status: "EXECUTING",
      steps: [expect.objectContaining({ stepId: "step-1", status: "RUNNING" })]
    });
  });

  it("begins a step by issuing matching controlled leases", async () => {
    const { workspace, schemas, registries } = await setup();
    const planId = await approvedPlan(workspace, schemas, registries, ["reviewer"]);
    await executePlan(workspace, planId);
    const begun = await beginStep(workspace, schemas, planId, "step-1", "step-agent");
    expect(begun.step).toMatchObject({ stepId: "step-1", status: "RUNNING" });
    expect(begun.leases).toHaveLength(2);
    const capabilities = begun.leases.map((lease) => lease.capability).sort();
    expect(capabilities).toEqual(["git-read", "repository-read"]);
    for (const lease of begun.leases) {
      expect(lease).toMatchObject({
        taskId: "exec-task",
        agentId: "step-agent",
        role: "reviewer",
        readScope: ["."],
        planRef: planId,
        stepRef: "step-1",
        planGeneration: 1
      });
      const decision = evaluateLease(lease, { taskId: "exec-task", role: "reviewer", workspace: workspace.root, capability: lease.capability });
      expect(decision.allowed).toBe(true);
      const admission = await admitAndReserveLeaseCall(workspace, lease.id, { taskId: "exec-task", role: "reviewer", capability: lease.capability });
      expect(admission.decision).toMatchObject({ allowed: true, code: "ALLOWED" });
    }
    expect(begun.step.leaseRefs).toEqual(begun.leases.map((lease) => lease.id));
    await expect(listLeases(workspace)).resolves.toHaveLength(2);
  });

  it("recovers a partially issued multi-capability step without binding a revoked or duplicate Lease", async () => {
    const { workspace, schemas, registries } = await setup({
      id: "exec-task", workspaceId: "workspace-1", goal: "Review a feature", requestedOutputs: ["report"],
      riskLevel: "L2", state: "SCOPED", scope: ["."], writeSet: [], packs: ["software-engineering"]
    });
    const task = await getTask(workspace, "exec-task");
    await approveTaskCapability(workspace, schemas, task, "git-read", ["."]);
    const planId = await approvedPlan(workspace, schemas, registries, ["reviewer"]);
    await executePlan(workspace, planId);

    await expect(beginStep(workspace, schemas, planId, "step-1", "step-agent"))
      .rejects.toMatchObject({ code: "TASK_APPROVAL_REQUIRED" });
    const partial = await listLeases(workspace);
    expect(partial).toHaveLength(1);
    expect(partial[0]).toMatchObject({ capability: "git-read", status: "active", planRef: planId, stepRef: "step-1" });
    await expect(admitAndReserveLeaseCall(workspace, partial[0]!.id, { taskId: "exec-task", role: "reviewer", capability: "git-read" }))
      .resolves.toMatchObject({ decision: { allowed: false, code: "LEASE_PLAN_BINDING_INVALID" } });

    await approveTaskCapability(workspace, schemas, task, "repository-read", ["."]);
    const recovered = await beginStep(workspace, schemas, planId, "step-1", "step-agent");
    expect(recovered.leases).toHaveLength(2);
    expect(recovered.leases.find((lease) => lease.capability === "git-read")?.id).toBe(partial[0]!.id);
    expect(new Set(recovered.leases.map((lease) => lease.id)).size).toBe(2);
    expect(recovered.leases.every((lease) => lease.status === "active")).toBe(true);
    for (const lease of recovered.leases) {
      await expect(admitAndReserveLeaseCall(workspace, lease.id, { taskId: "exec-task", role: "reviewer", capability: lease.capability }))
        .resolves.toMatchObject({ decision: { allowed: true, code: "ALLOWED" } });
    }
  });

  it("revokes a partial orphan before retrying the step with a different agent", async () => {
    const { workspace, schemas, registries } = await setup({
      id: "exec-task", workspaceId: "workspace-1", goal: "Review a feature", requestedOutputs: ["report"],
      riskLevel: "L2", state: "SCOPED", scope: ["."], writeSet: [], packs: ["software-engineering"]
    });
    const task = await getTask(workspace, "exec-task");
    await approveTaskCapability(workspace, schemas, task, "git-read", ["."]);
    const planId = await approvedPlan(workspace, schemas, registries, ["reviewer"]);
    await executePlan(workspace, planId);

    await expect(beginStep(workspace, schemas, planId, "step-1", "first-agent"))
      .rejects.toMatchObject({ code: "TASK_APPROVAL_REQUIRED" });
    const orphan = (await listLeases(workspace))[0]!;
    expect(orphan).toMatchObject({ agentId: "first-agent", capability: "git-read", status: "active" });

    // The first Approval was consumed by the first agent's Lease. A changed-agent
    // retry needs fresh precise authority for both capabilities.
    await approveTaskCapability(workspace, schemas, task, "git-read", ["."]);
    await approveTaskCapability(workspace, schemas, task, "repository-read", ["."]);
    const recovered = await beginStep(workspace, schemas, planId, "step-1", "replacement-agent");

    expect(recovered.leases).toHaveLength(2);
    expect(recovered.leases.every((lease) => lease.agentId === "replacement-agent" && lease.status === "active")).toBe(true);
    expect(recovered.leases.some((lease) => lease.id === orphan.id)).toBe(false);
    const stored = await listLeases(workspace);
    expect(stored.find((lease) => lease.id === orphan.id)?.status).toBe("revoked");
    expect(stored.filter((lease) =>
      lease.status === "active" && lease.planRef === planId && lease.stepRef === "step-1"
    )).toHaveLength(2);
  });

  it("revokes an unregistered partial step Lease when the Plan is cancelled", async () => {
    const { workspace, schemas, registries } = await setup({
      id: "exec-task", workspaceId: "workspace-1", goal: "Review a feature", requestedOutputs: ["report"],
      riskLevel: "L2", state: "SCOPED", scope: ["."], writeSet: [], packs: ["software-engineering"]
    });
    const task = await getTask(workspace, "exec-task");
    await approveTaskCapability(workspace, schemas, task, "git-read", ["."]);
    const planId = await approvedPlan(workspace, schemas, registries, ["reviewer"]);
    await executePlan(workspace, planId);
    await expect(beginStep(workspace, schemas, planId, "step-1", "step-agent"))
      .rejects.toMatchObject({ code: "TASK_APPROVAL_REQUIRED" });
    const partial = (await listLeases(workspace))[0]!;

    await cancelPlan(workspace, planId, "Cancel after partial dispatch.");
    expect((await listLeases(workspace)).find((lease) => lease.id === partial.id)?.status).toBe("revoked");
  });

  it("rejects Plan leases moved across concurrently running steps", async () => {
    const { workspace, schemas, registries } = await setup();
    const planId = await approvedPlan(workspace, schemas, registries, ["scout", "reviewer"]);
    await executePlan(workspace, planId);
    const first = await beginStep(workspace, schemas, planId, "step-1");
    await beginStep(workspace, schemas, planId, "step-2");
    const lease = first.leases[0]!;
    const plan = await getPlan(workspace, planId);
    const moved = {
      ...plan,
      steps: plan.steps.map((step) => step.stepId === "step-1"
        ? { ...step, leaseRefs: (step.leaseRefs ?? []).filter((leaseId) => leaseId !== lease.id) }
        : step.stepId === "step-2"
          ? { ...step, leaseRefs: [...(step.leaseRefs ?? []), lease.id] }
          : step)
    };
    await writeWorkspaceJson(workspace, `plans/${planId}.json`, moved);

    const admission = await admitAndReserveLeaseCall(workspace, lease.id, { taskId: "exec-task", role: lease.role, capability: lease.capability });
    expect(admission.decision).toMatchObject({ allowed: false, code: "LEASE_PLAN_BINDING_INVALID" });
  });

  it("rejects a Plan lease from an older execution generation", async () => {
    const { workspace, schemas, registries } = await setup();
    const planId = await approvedPlan(workspace, schemas, registries, ["scout"]);
    await executePlan(workspace, planId);
    const begun = await beginStep(workspace, schemas, planId, "step-1");
    const plan = await getPlan(workspace, planId);
    await writeWorkspaceJson(workspace, `plans/${planId}.json`, { ...plan, generation: plan.generation + 1 });

    const lease = begun.leases[0]!;
    const admission = await admitAndReserveLeaseCall(workspace, lease.id, { taskId: "exec-task", role: lease.role, capability: lease.capability });
    expect(admission.decision).toMatchObject({ allowed: false, code: "LEASE_PLAN_GENERATION_STALE" });
  });

  it("keeps partially issued Plan leases unusable until the step commit point", async () => {
    const { workspace, schemas, registries } = await setup();
    const planId = await approvedPlan(workspace, schemas, registries, ["scout"]);
    const executing = await executePlan(workspace, planId);
    const orphan = await issueLease(workspace, schemas, {
      taskId: "exec-task",
      agentId: "step-agent",
      role: "scout",
      capability: "repository-read",
      planRef: planId,
      stepRef: "step-1",
      planGeneration: executing.generation
    });

    const admission = await admitAndReserveLeaseCall(workspace, orphan.id, { taskId: "exec-task", role: "scout", capability: "repository-read" });
    expect(admission.decision).toMatchObject({ allowed: false, code: "LEASE_PLAN_BINDING_INVALID" });
  });

  it("revokes and rejects Plan leases after step or Plan terminal state", async () => {
    const { workspace, schemas, registries } = await setup();
    const stepPlanId = await approvedPlan(workspace, schemas, registries, ["scout"]);
    await executePlan(workspace, stepPlanId);
    const stepBegun = await beginStep(workspace, schemas, stepPlanId, "step-1");
    await completeStep(workspace, stepPlanId, "step-1");
    const stepLease = stepBegun.leases[0]!;
    const stepAdmission = await admitAndReserveLeaseCall(workspace, stepLease.id, { taskId: "exec-task", role: stepLease.role, capability: stepLease.capability });
    expect(stepAdmission.decision).toMatchObject({ allowed: false, code: "LEASE_NOT_ACTIVE" });

    const terminalPlanId = await approvedPlan(workspace, schemas, registries, ["reviewer"]);
    await executePlan(workspace, terminalPlanId);
    const planBegun = await beginStep(workspace, schemas, terminalPlanId, "step-1");
    await cancelPlan(workspace, terminalPlanId, "Stop execution.");
    for (const lease of planBegun.leases) {
      const admission = await admitAndReserveLeaseCall(workspace, lease.id, { taskId: "exec-task", role: lease.role, capability: lease.capability });
      expect(admission.decision).toMatchObject({ allowed: false, code: "LEASE_NOT_ACTIVE" });
    }
    const statuses = new Map((await listLeases(workspace)).map((lease) => [lease.id, lease.status]));
    expect(statuses.get(stepLease.id)).toBe("revoked");
    for (const lease of planBegun.leases) expect(statuses.get(lease.id)).toBe("revoked");
  });

  it("returns no leases for steps without tools and rejects unsupported tools", async () => {
    const { workspace, schemas, registries } = await setup();
    const planId = await approvedPlan(workspace, schemas, registries, ["conductor"]);
    await executePlan(workspace, planId);
    const begun = await beginStep(workspace, schemas, planId, "step-1");
    expect(begun.leases).toEqual([]);
    expect(begun.step.status).toBe("RUNNING");
  });

  it("issues a lease for a previously unmapped role via the tools config", async () => {
    const { workspace, schemas, registries } = await setup();
    const planId = await approvedPlan(workspace, schemas, registries, ["planner"]);
    const plan = await getPlan(workspace, planId);
    expect(plan.steps[0].tools).toEqual(["repository-read"]);
    await executePlan(workspace, planId);
    const begun = await beginStep(workspace, schemas, planId, "step-1");
    expect(begun.leases).toHaveLength(1);
    expect(begun.leases[0]).toMatchObject({ capability: "repository-read", role: "planner" });
  });

  it("enforces step state transitions and plan state guards", async () => {
    const { workspace, schemas, registries } = await setup();
    const planId = await approvedPlan(workspace, schemas, registries, ["scout"]);
    await expect(beginStep(workspace, schemas, planId, "step-1")).rejects.toMatchObject({ code: "PLAN_STATE_CONFLICT" });
    await executePlan(workspace, planId);
    const firstBegin = await beginStep(workspace, schemas, planId, "step-1");
    const repeatedBegin = await beginStep(workspace, schemas, planId, "step-1");
    expect(repeatedBegin.step).toMatchObject({ status: "RUNNING" });
    expect(repeatedBegin.leases.map((lease) => lease.capability).sort()).toEqual(["docs-index", "repository-read"]);
    expect(repeatedBegin.leases.map((lease) => lease.id).sort()).toEqual(firstBegin.leases.map((lease) => lease.id).sort());
    await expect(completeStep(workspace, planId, "step-missing")).rejects.toMatchObject({ code: "PLAN_STEP_NOT_FOUND" });
  });

  it("completes steps and finishes a plan only when all steps are done", async () => {
    const { workspace, schemas, registries } = await setup();
    const planId = await approvedPlan(workspace, schemas, registries, ["scout", "verifier"]);
    await executePlan(workspace, planId);
    await expect(finishPlan(workspace, planId)).rejects.toMatchObject({ code: "PLAN_STEPS_INCOMPLETE" });
    for (const stepId of ["step-1", "step-2"]) {
      await beginStep(workspace, schemas, planId, stepId);
      await completeStep(workspace, planId, stepId);
    }
    const finished = await finishPlan(workspace, planId);
    expect(finished.status).toBe("COMPLETED");
    const events = (await listLedgerEntries(workspace)).map((entry) => entry.event);
    expect(events).toEqual(expect.arrayContaining(["plan-executing", "plan-step-completed", "plan-step-completed", "plan-completed"]));
  });

  it("fails steps and plans with audit events", async () => {
    const { workspace, schemas, registries } = await setup();
    const planId = await approvedPlan(workspace, schemas, registries, ["scout"]);
    await executePlan(workspace, planId);
    await beginStep(workspace, schemas, planId, "step-1");
    await failStep(workspace, planId, "step-1", "Tool failed.");
    const failed = await failPlan(workspace, planId, "Step could not recover.");
    expect(failed.status).toBe("FAILED");
    const events = (await listLedgerEntries(workspace)).map((entry) => entry.event);
    expect(events).toEqual(expect.arrayContaining(["plan-step-failed", "plan-failed"]));
  });

  for (const point of ["after-plan", "after-ledger"] as const) {
    it(`repairs every Plan execution audit boundary after ${point}`, async () => {
      const executingFixture = await setup();
      const executePlanId = await approvedPlan(executingFixture.workspace, executingFixture.schemas, executingFixture.registries, ["scout"]);
      injectPlanLifecycleFaultForTesting(executingFixture.workspace, point);
      await expect(executePlan(executingFixture.workspace, executePlanId))
        .rejects.toMatchObject({ code: "PLAN_LIFECYCLE_FAULT_INJECTED", details: { point } });
      await expect(executePlan(executingFixture.workspace, executePlanId)).resolves.toMatchObject({ status: "EXECUTING" });
      expect((await listLedgerEntries(executingFixture.workspace)).filter((entry) => entry.event === "plan-executing" && entry.planRef === executePlanId)).toHaveLength(1);

      const beginFixture = await setup();
      const beginPlanId = await approvedPlan(beginFixture.workspace, beginFixture.schemas, beginFixture.registries, ["scout"]);
      await executePlan(beginFixture.workspace, beginPlanId);
      injectPlanLifecycleFaultForTesting(beginFixture.workspace, point);
      await expect(beginStep(beginFixture.workspace, beginFixture.schemas, beginPlanId, "step-1", "recovery-agent"))
        .rejects.toMatchObject({ code: "PLAN_LIFECYCLE_FAULT_INJECTED", details: { point } });
      const committedBeginPlan = await getPlan(beginFixture.workspace, beginPlanId);
      const committedBeginLease = (await listLeases(beginFixture.workspace)).find((lease) =>
        committedBeginPlan.steps[0]!.leaseRefs?.includes(lease.id)
      )!;
      await expect(admitAndReserveLeaseCall(beginFixture.workspace, committedBeginLease.id, {
        taskId: "exec-task",
        role: committedBeginLease.role,
        capability: committedBeginLease.capability
      })).resolves.toMatchObject({ allowed: true });
      expect((await listLedgerEntries(beginFixture.workspace)).filter((entry) => entry.event === "plan-step-started" && entry.planRef === beginPlanId)).toHaveLength(1);
      const begun = await beginStep(beginFixture.workspace, beginFixture.schemas, beginPlanId, "step-1", "recovery-agent");
      expect(begun.step).toMatchObject({ status: "RUNNING" });
      expect((await listLedgerEntries(beginFixture.workspace)).filter((entry) => entry.event === "plan-step-started" && entry.planRef === beginPlanId)).toHaveLength(1);

      const completeFixture = await setup();
      const completePlanId = await approvedPlan(completeFixture.workspace, completeFixture.schemas, completeFixture.registries, ["scout"]);
      await executePlan(completeFixture.workspace, completePlanId);
      const completeBegun = await beginStep(completeFixture.workspace, completeFixture.schemas, completePlanId, "step-1");
      injectPlanLifecycleFaultForTesting(completeFixture.workspace, point);
      await expect(completeStep(completeFixture.workspace, completePlanId, "step-1", ["evidence-result"]))
        .rejects.toMatchObject({ code: "PLAN_LIFECYCLE_FAULT_INJECTED", details: { point } });
      await expect(completeStep(completeFixture.workspace, completePlanId, "step-1", ["different-retry-input"]))
        .rejects.toMatchObject({ code: "PLAN_IDEMPOTENCY_CONFLICT" });
      await expect(completeStep(completeFixture.workspace, completePlanId, "step-1", ["evidence-result"]))
        .resolves.toMatchObject({ steps: [expect.objectContaining({ status: "COMPLETED", evidenceRefs: ["evidence-result"] })] });
      expect((await listLedgerEntries(completeFixture.workspace)).filter((entry) => entry.event === "plan-step-completed" && entry.planRef === completePlanId)).toHaveLength(1);
      expect((await listLeases(completeFixture.workspace)).find((lease) => lease.id === completeBegun.leases[0]!.id)?.status).toBe("revoked");

      const failStepFixture = await setup();
      const failStepPlanId = await approvedPlan(failStepFixture.workspace, failStepFixture.schemas, failStepFixture.registries, ["scout"]);
      await executePlan(failStepFixture.workspace, failStepPlanId);
      await beginStep(failStepFixture.workspace, failStepFixture.schemas, failStepPlanId, "step-1");
      injectPlanLifecycleFaultForTesting(failStepFixture.workspace, point);
      await expect(failStep(failStepFixture.workspace, failStepPlanId, "step-1", "Original step failure."))
        .rejects.toMatchObject({ code: "PLAN_LIFECYCLE_FAULT_INJECTED", details: { point } });
      await expect(failStep(failStepFixture.workspace, failStepPlanId, "step-1", "Different retry reason."))
        .rejects.toMatchObject({ code: "PLAN_IDEMPOTENCY_CONFLICT" });
      await expect(failStep(failStepFixture.workspace, failStepPlanId, "step-1", "Original step failure."))
        .resolves.toMatchObject({ steps: [expect.objectContaining({ status: "FAILED", failureReasonHash: expect.stringMatching(/^sha256:/) })] });
      expect((await listLedgerEntries(failStepFixture.workspace)).filter((entry) => entry.event === "plan-step-failed" && entry.planRef === failStepPlanId)).toHaveLength(1);

      const finishFixture = await setup();
      const finishPlanId = await approvedPlan(finishFixture.workspace, finishFixture.schemas, finishFixture.registries, ["conductor"]);
      await executePlan(finishFixture.workspace, finishPlanId);
      await beginStep(finishFixture.workspace, finishFixture.schemas, finishPlanId, "step-1");
      await completeStep(finishFixture.workspace, finishPlanId, "step-1");
      injectPlanLifecycleFaultForTesting(finishFixture.workspace, point);
      await expect(finishPlan(finishFixture.workspace, finishPlanId))
        .rejects.toMatchObject({ code: "PLAN_LIFECYCLE_FAULT_INJECTED", details: { point } });
      await expect(finishPlan(finishFixture.workspace, finishPlanId)).resolves.toMatchObject({ status: "COMPLETED" });
      expect((await listLedgerEntries(finishFixture.workspace)).filter((entry) => entry.event === "plan-completed" && entry.planRef === finishPlanId)).toHaveLength(1);

      const failPlanFixture = await setup();
      const failPlanId = await approvedPlan(failPlanFixture.workspace, failPlanFixture.schemas, failPlanFixture.registries, ["conductor"]);
      await executePlan(failPlanFixture.workspace, failPlanId);
      injectPlanLifecycleFaultForTesting(failPlanFixture.workspace, point);
      await expect(failPlan(failPlanFixture.workspace, failPlanId, "Original Plan failure."))
        .rejects.toMatchObject({ code: "PLAN_LIFECYCLE_FAULT_INJECTED", details: { point } });
      await expect(failPlan(failPlanFixture.workspace, failPlanId, "Different retry reason."))
        .rejects.toMatchObject({ code: "PLAN_IDEMPOTENCY_CONFLICT" });
      await expect(failPlan(failPlanFixture.workspace, failPlanId, "Original Plan failure."))
        .resolves.toMatchObject({ status: "FAILED", failureReasonHash: expect.stringMatching(/^sha256:/) });
      expect((await listLedgerEntries(failPlanFixture.workspace)).filter((entry) => entry.event === "plan-failed" && entry.planRef === failPlanId)).toHaveLength(1);
    });
  }

  it("records reported result references on step completion and reads them back", async () => {
    const { workspace, schemas, registries } = await setup();
    const planId = await approvedPlan(workspace, schemas, registries, ["scout"]);
    await executePlan(workspace, planId);
    await beginStep(workspace, schemas, planId, "step-1");
    const completed = await completeStep(workspace, planId, "step-1", ["receipt-mcp-1", "evidence-run-1"]);
    expect(completed.steps[0]).toMatchObject({ status: "COMPLETED", evidenceRefs: ["receipt-mcp-1", "evidence-run-1"] });
    const stored = await getPlan(workspace, planId);
    expect(stored.steps[0].evidenceRefs).toEqual(["receipt-mcp-1", "evidence-run-1"]);
  });

  it("leaves evidenceRefs undefined when none are reported and rejects invalid references", async () => {
    const { workspace, schemas, registries } = await setup();
    const planId = await approvedPlan(workspace, schemas, registries, ["scout"]);
    await executePlan(workspace, planId);
    await beginStep(workspace, schemas, planId, "step-1");
    const completed = await completeStep(workspace, planId, "step-1");
    expect(completed.steps[0].evidenceRefs).toBeUndefined();
  });

  it("rejects invalid step result references", async () => {
    const { workspace, schemas, registries } = await setup();
    const planId = await approvedPlan(workspace, schemas, registries, ["scout"]);
    await executePlan(workspace, planId);
    await beginStep(workspace, schemas, planId, "step-1");
    await expect(completeStep(workspace, planId, "step-1", [""])).rejects.toMatchObject({ code: "PLAN_STEP_EVIDENCE_INVALID" });
    await expect(completeStep(workspace, planId, "step-1", ["a", "a"])).rejects.toMatchObject({ code: "PLAN_STEP_EVIDENCE_INVALID" });
    await expect(completeStep(workspace, planId, "step-1", ["x".repeat(257)])).rejects.toMatchObject({ code: "PLAN_STEP_EVIDENCE_INVALID" });
    await expect(completeStep(workspace, planId, "step-1", Array.from({ length: 21 }, (_, index) => `ref-${index}`))).rejects.toMatchObject({ code: "PLAN_STEP_EVIDENCE_INVALID" });
  });

  it("blocks step completion while writes are pending or confirmed", async () => {
    const task: TaskCharter = {
      id: "exec-task",
      workspaceId: "workspace-1",
      goal: "Build a feature",
      requestedOutputs: ["code-change", "report"],
      riskLevel: "L0",
      state: "RUNNING",
      scope: ["."],
      writeSet: ["docs/note.md"],
      packs: ["software-engineering"]
    };
    const { workspace, schemas, registries } = await setup(task);
    await approveTaskCapability(workspace, schemas, task, "repository-write", ["docs/note.md"]);
    const planId = await approvedPlan(workspace, schemas, registries, ["builder"]);
    await executePlan(workspace, planId);
    await beginStep(workspace, schemas, planId, "step-1");
    await requestWrites(workspace, schemas, planId, "step-1", [{ target: "docs/note.md", action: "create", purpose: "Draft." }]);
    await expect(completeStep(workspace, planId, "step-1")).rejects.toMatchObject({ code: "PLAN_STEP_PENDING_WRITES" });
    const writes = await listWriteIntents(workspace, planId);
    await rejectWrites(workspace, planId, "step-1", writes[0].writeIntentId, "Not needed.");
    await expect(completeStep(workspace, planId, "step-1")).resolves.toMatchObject({ status: "EXECUTING" });
  });
});
