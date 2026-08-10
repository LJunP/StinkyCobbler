import { mkdir, readFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { CapabilityLease, OrchestrationPlan, PlanStep } from "../contracts/types.js";
import type { SchemaRegistry } from "../contracts/schema-registry.js";
import type { Registries } from "../config/registry.js";
import { ExitCode, StinkyCobblerError } from "../errors.js";
import { appendLedgerEntry } from "./ledger.js";
import type { LocalWorkspace } from "./workspace.js";
import { createWorkspaceJson, workspaceFile, writeWorkspaceJson } from "./workspace.js";
import { withWorkspaceLock } from "./workspace-lock.js";
import { getTask } from "./tasks.js";
import { listApprovals } from "./approvals.js";
import { isApprovalExpired } from "../policy/approval.js";
import { recommendTask } from "../domain/recommend.js";
import { issueLease } from "./leases.js";
import { listWriteIntents } from "./write-intents.js";

const DIRECTORY = "plans";
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_STEPS = 10;
const PLAN_CONFIRM_ACTION = "plan-confirm";
const TOOLS_TO_CAPABILITY: Record<string, string> = {
  "repository-read": "repository-read",
  "repository-list": "repository-read",
  "git-read": "git-read",
  "docs-index": "docs-index",
  "repository-write": "repository-write"
};
const DEFAULT_STEP_AGENT = "host-agent";

export interface CreatePlanInput {
  taskId: string;
  roles?: string[];
}

export async function createPlan(workspace: LocalWorkspace, schemas: SchemaRegistry, registries: Registries, input: CreatePlanInput): Promise<OrchestrationPlan> {
  return withWorkspaceLock(workspace, async () => {
    if (!input.taskId) throw planError("PLAN_INPUT_INVALID", "taskId is required.");
    const task = await getTask(workspace, input.taskId);
    const roles = input.roles ?? recommendTask(task, registries.packs).minimalDag;
    if (roles.length === 0) throw planError("PLAN_NO_ROLES", "A plan requires at least one role.");
    if (roles.length > MAX_STEPS) throw planError("PLAN_TOO_MANY_STEPS", `A plan may have at most ${MAX_STEPS} steps.`, { steps: roles.length });
    const seen = new Set<string>();
    const steps: PlanStep[] = [];
    for (const role of roles) {
      if (!registries.roles.roles[role]) throw planError("PLAN_ROLE_UNKNOWN", `Unknown role ${role}.`, { role });
      if (seen.has(role)) continue;
      seen.add(role);
      steps.push({
        stepId: `step-${steps.length + 1}`,
        role,
        goal: `${role} step of plan for task ${task.id}`,
        tools: registries.roleTools[role] ?? [],
        readScope: ["."],
        writes: [],
        status: "PENDING"
      });
    }
    if (steps.length === 0) throw planError("PLAN_NO_ROLES", "A plan requires at least one role.");
    await mkdir(await workspaceFile(workspace, DIRECTORY), { recursive: true, mode: 0o700 });
    const plan: OrchestrationPlan = {
      version: 1,
      planId: `plan-${randomUUID()}`,
      taskId: task.id,
      status: "DRAFT",
      goal: task.goal,
      steps,
      createdAt: new Date().toISOString()
    };
    schemas.validate("plan", plan);
    await createWorkspaceJson(workspace, fileName(plan.planId), plan);
    await appendLedgerEntry(workspace, { event: "plan-created", taskId: plan.taskId, planRef: plan.planId, summary: `Plan ${plan.planId} created with ${plan.steps.length} steps.` });
    return plan;
  });
}

export async function getPlan(workspace: LocalWorkspace, planId: string): Promise<OrchestrationPlan> {
  assertPlanId(planId);
  try {
    return JSON.parse(await readFile(await workspaceFile(workspace, fileName(planId)), "utf8")) as OrchestrationPlan;
  } catch (error: unknown) {
    if (isCode(error, "ENOENT")) throw planError("PLAN_NOT_FOUND", "Plan does not exist.", { planId });
    if (error instanceof SyntaxError) throw planError("PLAN_INVALID", "Stored plan contains invalid JSON.", { planId });
    throw error;
  }
}

export async function listPlans(workspace: LocalWorkspace, taskId?: string): Promise<OrchestrationPlan[]> {
  let names: string[];
  try { names = await readdir(await workspaceFile(workspace, DIRECTORY)); } catch (error: unknown) { if (isCode(error, "ENOENT")) return []; throw error; }
  const values = await Promise.all(names.filter((name) => /^plan-[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$/.test(name)).sort().map((name) => getPlan(workspace, name.slice(0, -5))));
  return taskId === undefined ? values : values.filter((plan) => plan.taskId === taskId);
}

/** Approves a plan only when a matching, unexpired plan-confirm Approval exists. */
export async function confirmPlan(workspace: LocalWorkspace, planId: string): Promise<OrchestrationPlan> {
  return withWorkspaceLock(workspace, async () => {
    const current = await getPlan(workspace, planId);
    if (current.status === "APPROVED") return current;
    if (current.status !== "DRAFT" && current.status !== "AWAITING_CONFIRMATION") {
      throw planError("PLAN_STATE_CONFLICT", "Only DRAFT or AWAITING_CONFIRMATION plans can be confirmed.", { planId, status: current.status });
    }
    const approvals = await listApprovals(workspace, current.taskId);
    const matching = approvals.find((approval) =>
      approval.action === PLAN_CONFIRM_ACTION &&
      approval.status === "approved" &&
      (approval.scope ?? []).includes(planId) &&
      !isApprovalExpired(approval)
    );
    if (!matching) throw planError("PLAN_CONFIRMATION_REQUIRED", "An approved plan-confirm Approval matching this plan is required before confirmation.", { planId });
    const next: OrchestrationPlan = { ...current, status: "APPROVED", confirmedAt: new Date().toISOString() };
    await writeWorkspaceJson(workspace, fileName(planId), next);
    await appendLedgerEntry(workspace, { event: "plan-approved", taskId: next.taskId, planRef: next.planId, approvalRef: matching.id, summary: `Plan ${next.planId} approved.` });
    return next;
  });
}

export async function cancelPlan(workspace: LocalWorkspace, planId: string, reason: string): Promise<OrchestrationPlan> {
  return withWorkspaceLock(workspace, async () => {
    if (!reason || reason.length > 512) throw planError("PLAN_CANCEL_REASON_INVALID", "Cancellation reason must be 1-512 characters.");
    const current = await getPlan(workspace, planId);
    if (current.status === "CANCELLED") return current;
    if (current.status === "COMPLETED" || current.status === "FAILED") {
      throw planError("PLAN_STATE_CONFLICT", "Terminal plans cannot be cancelled.", { planId, status: current.status });
    }
    const next: OrchestrationPlan = { ...current, status: "CANCELLED", cancelledAt: new Date().toISOString() };
    await writeWorkspaceJson(workspace, fileName(planId), next);
    await appendLedgerEntry(workspace, { event: "plan-cancelled", taskId: next.taskId, planRef: next.planId, summary: `Plan ${next.planId} cancelled: ${reason}` });
    return next;
  });
}

function assertPlanId(id: string): void { if (!ID_PATTERN.test(id)) throw planError("PLAN_INVALID", "Plan ID is invalid.", { planId: id }); }
function fileName(id: string): string { return path.join(DIRECTORY, `${id}.json`); }
function planError(code: string, message: string, details: Record<string, unknown> = {}): StinkyCobblerError { return new StinkyCobblerError(code, ExitCode.VALIDATION, message, details); }
function isCode(error: unknown, code: string): boolean { return typeof error === "object" && error !== null && "code" in error && error.code === code; }

function stepById(plan: OrchestrationPlan, stepId: string): PlanStep {
  const step = plan.steps.find((candidate) => candidate.stepId === stepId);
  if (!step) throw planError("PLAN_STEP_NOT_FOUND", "Plan step does not exist.", { planId: plan.planId, stepId });
  return step;
}

async function persistStep(workspace: LocalWorkspace, plan: OrchestrationPlan, stepId: string, status: PlanStep["status"]): Promise<OrchestrationPlan> {
  const next = { ...plan, steps: plan.steps.map((candidate) => (candidate.stepId === stepId ? { ...candidate, status } : candidate)) };
  await writeWorkspaceJson(workspace, fileName(plan.planId), next);
  return next;
}

/** Moves an APPROVED plan into execution. */
export async function executePlan(workspace: LocalWorkspace, planId: string): Promise<OrchestrationPlan> {
  return withWorkspaceLock(workspace, async () => {
    const current = await getPlan(workspace, planId);
    if (current.status !== "APPROVED") throw planError("PLAN_STATE_CONFLICT", "Only APPROVED plans can be executed.", { planId, status: current.status });
    const next: OrchestrationPlan = { ...current, status: "EXECUTING" };
    await writeWorkspaceJson(workspace, fileName(planId), next);
    await appendLedgerEntry(workspace, { event: "plan-executing", taskId: next.taskId, planRef: next.planId, summary: `Plan ${next.planId} started executing.` });
    return next;
  });
}

export interface BegunStep {
  step: PlanStep;
  leases: CapabilityLease[];
}

/** Begins one step: marks it RUNNING and issues one controlled lease per mapped capability. */
export async function beginStep(workspace: LocalWorkspace, schemas: SchemaRegistry, planId: string, stepId: string, agentId = DEFAULT_STEP_AGENT): Promise<BegunStep> {
  return withWorkspaceLock(workspace, async () => {
    const current = await getPlan(workspace, planId);
    if (current.status !== "EXECUTING") throw planError("PLAN_STATE_CONFLICT", "Only EXECUTING plans can begin steps.", { planId, status: current.status });
    const step = stepById(current, stepId);
    if (step.status !== "PENDING") throw planError("PLAN_STEP_STATE_CONFLICT", "Only PENDING steps can be begun.", { planId, stepId, status: step.status });
    const capabilities = new Set<string>();
    for (const tool of step.tools) {
      const capability = TOOLS_TO_CAPABILITY[tool];
      if (!capability) throw planError("PLAN_STEP_TOOL_UNSUPPORTED", `Step tool ${tool} has no supported capability.`, { planId, stepId, tool });
      capabilities.add(capability);
    }
    const leases: CapabilityLease[] = [];
    for (const capability of [...capabilities].sort()) {
      // Write leases are issued only after write confirmation (write-confirm flow),
      // not automatically at step begin; the writeSet comes from the confirmed intent.
      if (capability === "repository-write") continue;
      leases.push(await issueLease(workspace, schemas, { taskId: current.taskId, agentId, role: step.role, capability, readScope: step.readScope }));
    }
    const next = await persistStep(workspace, current, stepId, "RUNNING");
    return { step: next.steps.find((candidate) => candidate.stepId === stepId)!, leases };
  });
}

/** Marks a RUNNING step completed, optionally recording the step's result references. */
export async function completeStep(workspace: LocalWorkspace, planId: string, stepId: string, evidenceRefs?: string[]): Promise<OrchestrationPlan> {
  return withWorkspaceLock(workspace, async () => {
    const current = await getPlan(workspace, planId);
    const step = stepById(current, stepId);
    if (step.status !== "RUNNING") throw planError("PLAN_STEP_STATE_CONFLICT", "Only RUNNING steps can be completed.", { planId, stepId, status: step.status });
    if (evidenceRefs !== undefined) assertEvidenceRefs(evidenceRefs);
    const pendingWrites = (await listWriteIntents(workspace, planId)).filter((record) => record.stepId === stepId && (record.status === "PENDING" || record.status === "CONFIRMED"));
    if (pendingWrites.length > 0) {
      throw planError("PLAN_STEP_PENDING_WRITES", "Steps with pending or confirmed writes must resolve them (apply or reject) before completion.", { planId, stepId, pendingWriteIntents: pendingWrites.map((record) => record.writeIntentId) });
    }
    const next: OrchestrationPlan = {
      ...current,
      steps: current.steps.map((candidate) => (candidate.stepId === stepId ? { ...candidate, status: "COMPLETED" as const, ...(evidenceRefs === undefined ? {} : { evidenceRefs }) } : candidate))
    };
    await writeWorkspaceJson(workspace, fileName(planId), next);
    const evidenceCount = evidenceRefs?.length ?? 0;
    await appendLedgerEntry(workspace, { event: "plan-step-completed", taskId: next.taskId, planRef: next.planId, stepId, summary: `Plan ${next.planId} step ${stepId} completed with ${evidenceCount} result reference(s).` });
    return next;
  });
}

function assertEvidenceRefs(refs: string[]): void {
  if (refs.length === 0 || refs.length > 20) throw planError("PLAN_STEP_EVIDENCE_INVALID", "A step may report 1-20 result references.", { count: refs.length });
  const seen = new Set<string>();
  for (const ref of refs) {
    if (typeof ref !== "string" || ref.length === 0 || ref.length > 256 || seen.has(ref)) {
      throw planError("PLAN_STEP_EVIDENCE_INVALID", "Step result references must be unique non-empty strings up to 256 characters.");
    }
    seen.add(ref);
  }
}

/** Marks a RUNNING step failed. */
export async function failStep(workspace: LocalWorkspace, planId: string, stepId: string, reason: string): Promise<OrchestrationPlan> {
  return withWorkspaceLock(workspace, async () => {
    if (!reason || reason.length > 512) throw planError("PLAN_STEP_FAIL_REASON_INVALID", "Failure reason must be 1-512 characters.");
    const current = await getPlan(workspace, planId);
    const step = stepById(current, stepId);
    if (step.status !== "RUNNING") throw planError("PLAN_STEP_STATE_CONFLICT", "Only RUNNING steps can fail.", { planId, stepId, status: step.status });
    const next = await persistStep(workspace, current, stepId, "FAILED");
    await appendLedgerEntry(workspace, { event: "plan-step-failed", taskId: next.taskId, planRef: next.planId, stepId, summary: `Plan ${next.planId} step ${stepId} failed: ${reason}` });
    return next;
  });
}

/** Finishes an EXECUTING plan when every step is completed. */
export async function finishPlan(workspace: LocalWorkspace, planId: string): Promise<OrchestrationPlan> {
  return withWorkspaceLock(workspace, async () => {
    const current = await getPlan(workspace, planId);
    if (current.status !== "EXECUTING") throw planError("PLAN_STATE_CONFLICT", "Only EXECUTING plans can be finished.", { planId, status: current.status });
    if (current.steps.some((step) => step.status !== "COMPLETED")) throw planError("PLAN_STEPS_INCOMPLETE", "All steps must be completed before finishing the plan.", { planId });
    const next: OrchestrationPlan = { ...current, status: "COMPLETED" };
    await writeWorkspaceJson(workspace, fileName(planId), next);
    await appendLedgerEntry(workspace, { event: "plan-completed", taskId: next.taskId, planRef: next.planId, summary: `Plan ${next.planId} completed.` });
    return next;
  });
}

/** Fails an EXECUTING plan. */
export async function failPlan(workspace: LocalWorkspace, planId: string, reason: string): Promise<OrchestrationPlan> {
  return withWorkspaceLock(workspace, async () => {
    if (!reason || reason.length > 512) throw planError("PLAN_FAIL_REASON_INVALID", "Failure reason must be 1-512 characters.");
    const current = await getPlan(workspace, planId);
    if (current.status !== "EXECUTING") throw planError("PLAN_STATE_CONFLICT", "Only EXECUTING plans can fail.", { planId, status: current.status });
    const next: OrchestrationPlan = { ...current, status: "FAILED" };
    await writeWorkspaceJson(workspace, fileName(planId), next);
    await appendLedgerEntry(workspace, { event: "plan-failed", taskId: next.taskId, planRef: next.planId, summary: `Plan ${next.planId} failed: ${reason}` });
    return next;
  });
}
