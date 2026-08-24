import { mkdir, readFile, readdir } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type { CapabilityLease, OrchestrationPlan, PlanStep } from "../contracts/types.js";
import type { SchemaRegistry } from "../contracts/schema-registry.js";
import { defaultSchemaRegistry } from "../contracts/default-schema-registry.js";
import type { Registries } from "../config/registry.js";
import { ExitCode, StinkyCobblerError } from "../errors.js";
import { appendLedgerEntry, listLedgerEntries, prepareLedgerEntry, type AppendLedgerEntry } from "./ledger.js";
import type { LocalWorkspace } from "./workspace.js";
import { createWorkspaceJson, workspaceFile, writeWorkspaceJson } from "./workspace.js";
import { withWorkspaceLock } from "./workspace-lock.js";
import { getTask } from "./tasks.js";
import { consumeApproval, getApproval, listApprovals } from "./approvals.js";
import { isApprovalExpired } from "../policy/approval.js";
import { recommendTask } from "../domain/recommend.js";
import { issueLease, listLeases, revokeLease } from "./leases.js";
import { listWriteIntents } from "./write-intents.js";
import { loadOrchestrationConfig } from "../config/tiered.js";
import { assertCurrentTaskAuthorityGeneration, hashTaskAuthority, TASK_AUTHORITY_POLICY_VERSION } from "./task-authority.js";

const DIRECTORY = "plans";
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_STEPS = 10;
const TERMINAL_TASK_STATES = new Set(["DONE", "ARCHIVED", "CANCELLED"]);
const PLAN_CONFIRM_ACTION = "plan-confirm";
export const PLAN_CONFIRM_CAPABILITY = "plan-execute";
export const PLAN_SUBJECT_VERSION = 1;
const TOOLS_TO_CAPABILITY: Record<string, string> = {
  "repository-read": "repository-read",
  "repository-list": "repository-read",
  "git-read": "git-read",
  "docs-index": "docs-index",
  "repository-write": "repository-write"
};
const DEFAULT_STEP_AGENT = "host-agent";
const planConfirmationFaults = new Map<string, "after-consume" | "after-plan">();
export type PlanLifecycleFaultPoint = "after-plan" | "after-ledger";
const planLifecycleFaults = new Map<string, PlanLifecycleFaultPoint>();

export interface CreatePlanInput {
  taskId: string;
  roles?: string[];
  hostSessionId?: string;
}

/** Test-only, single-use crash point for Plan target/audit ordering. */
export function injectPlanLifecycleFaultForTesting(workspace: LocalWorkspace, point: PlanLifecycleFaultPoint): void {
  if (process.env.NODE_ENV !== "test") throw planError("PLAN_LIFECYCLE_TEST_FAULT_DENIED", "Plan lifecycle fault injection is available only under the test runner.");
  planLifecycleFaults.set(workspace.directory, point);
}

export async function createPlan(workspace: LocalWorkspace, schemas: SchemaRegistry, registries: Registries, input: CreatePlanInput): Promise<OrchestrationPlan> {
  return withWorkspaceLock(workspace, async () => {
    if (!input.taskId) throw planError("PLAN_INPUT_INVALID", "taskId is required.");
    const task = await getTask(workspace, input.taskId);
    assertCurrentTaskAuthorityGeneration(task);
    assertPlanTaskLifecycleOpen(task.id, task.state);
    const hostSessionId = input.hostSessionId ?? "local-cli";
    assertHostSessionId(hostSessionId);
    const roles = input.roles ?? recommendTask(task, registries.packs).minimalDag;
    const maxSteps = (await loadOrchestrationConfig(workspace)).defaults?.maxSteps ?? MAX_STEPS;
    if (roles.length === 0) throw planError("PLAN_NO_ROLES", "A plan requires at least one role.");
    if (roles.length > MAX_STEPS) throw planError("PLAN_TOO_MANY_STEPS", `A plan request may contain at most ${MAX_STEPS} roles.`, { roles: roles.length, maxSteps: MAX_STEPS });
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
    if (steps.length > maxSteps) throw planError("PLAN_TOO_MANY_STEPS", `A plan may have at most ${maxSteps} distinct steps.`, { steps: steps.length, maxSteps });
    const taskAuthorityHash = hashTaskAuthority(task);
    const creationRequestHash = hashPlanCreationRequest({
      taskId: task.id,
      taskAuthorityHash,
      hostSessionId,
      goal: task.goal,
      steps
    });
    const matching = (await listPlans(workspace, task.id)).filter((candidate) =>
      candidate.creationRequestHash === creationRequestHash && !["COMPLETED", "FAILED", "CANCELLED"].includes(candidate.status)
    );
    if (matching.length > 1) {
      throw planError("PLAN_CREATION_CONFLICT", "Multiple active Plans are bound to the same exact creation request.", {
        taskId: task.id, creationRequestHash, planIds: matching.map((candidate) => candidate.planId)
      });
    }
    if (matching[0] !== undefined) {
      await ensurePlanLifecycleCommitted(workspace, matching[0]);
      return matching[0];
    }
    await mkdir(await workspaceFile(workspace, DIRECTORY), { recursive: true, mode: 0o700 });
    const plan: OrchestrationPlan = {
      version: 1,
      planId: `plan-${randomUUID()}`,
      taskId: task.id,
      generation: 0,
      taskAuthorityHash,
      policyVersion: TASK_AUTHORITY_POLICY_VERSION,
      hostSessionId,
      planSubjectVersion: PLAN_SUBJECT_VERSION,
      creationRequestHash,
      status: "DRAFT",
      goal: task.goal,
      steps,
      createdAt: new Date().toISOString()
    };
    plan.planSubjectHash = hashPlanSubject(plan);
    schemas.validate("plan", plan);
    const ledgerEffect = planCreatedEffect(plan);
    await createWorkspaceJson(workspace, fileName(plan.planId), plan);
    maybeInjectPlanLifecycleFault(workspace, "after-plan", plan.planId);
    await ensureExactPlanLedgerEffect(workspace, ledgerEffect);
    maybeInjectPlanLifecycleFault(workspace, "after-ledger", plan.planId);
    return plan;
  });
}

export async function getPlan(workspace: LocalWorkspace, planId: string): Promise<OrchestrationPlan> {
  assertPlanId(planId);
  try {
    const value: unknown = JSON.parse(await readFile(await workspaceFile(workspace, fileName(planId)), "utf8"));
    (await defaultSchemaRegistry()).validate("plan", value);
    const plan = value as OrchestrationPlan;
    if (plan.planId !== planId) throw planError("PLAN_INVALID", "Stored plan ID does not match its canonical lookup ID.", { planId, storedPlanId: plan.planId });
    return plan;
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
export async function confirmPlan(workspace: LocalWorkspace, planId: string, hostSessionId = "local-cli"): Promise<OrchestrationPlan> {
  const schemas = await defaultSchemaRegistry();
  return withWorkspaceLock(workspace, async () => {
    const current = await getPlan(workspace, planId);
    await ensurePlanLifecycleCommitted(workspace, current);
    assertCurrentPlanGeneration(current);
    assertHostSessionId(hostSessionId);
    if (current.status === "APPROVED") {
      const proof = await getPersistedPlanConfirmationProof(workspace, current);
      await ensurePlanApprovedLedgerEntry(workspace, current, proof.id);
      return current;
    }
    await assertCurrentPlanTaskAuthority(workspace, current);
    if (current.hostSessionId !== hostSessionId) {
      throw planError("PLAN_HOST_SESSION_MISMATCH", "The Plan can be confirmed only by the host session that created it.", {
        planId,
        expectedHostSessionId: current.hostSessionId,
        observedHostSessionId: hostSessionId
      });
    }
    if (current.status !== "DRAFT" && current.status !== "AWAITING_CONFIRMATION") {
      throw planError("PLAN_STATE_CONFLICT", "Only DRAFT or AWAITING_CONFIRMATION plans can be confirmed.", { planId, status: current.status });
    }
    const approvals = await listApprovals(workspace, current.taskId);
    const matching = approvals.find((approval) => approval.consumedBy === current.planId && isExactPlanConfirmationApproval(current, approval, hostSessionId)) ??
      approvals.find((approval) => isExactPlanConfirmationApproval(current, approval, hostSessionId));
    if (!matching) throw planError("PLAN_CONFIRMATION_REQUIRED", "A current precise one-shot plan-confirm Approval matching this exact Plan is required before confirmation.", { planId });
    const consumed = await consumeApproval(workspace, schemas, matching.id, current.planId);
    maybeInjectPlanConfirmationFault(workspace, "after-consume");
    const next: OrchestrationPlan = { ...current, status: "APPROVED", confirmedAt: new Date().toISOString(), approvalRef: consumed.id };
    await writeWorkspaceJson(workspace, fileName(planId), next);
    maybeInjectPlanConfirmationFault(workspace, "after-plan");
    await ensurePlanApprovedLedgerEntry(workspace, next, consumed.id);
    return next;
  });
}

/** Test-only, single-use Plan confirmation crash point. */
export function injectPlanConfirmationFaultForTesting(workspace: LocalWorkspace, point: "after-consume" | "after-plan"): void {
  if (process.env.NODE_ENV !== "test") throw planError("PLAN_CONFIRMATION_TEST_FAULT_DENIED", "Plan confirmation fault injection is available only under the test runner.");
  planConfirmationFaults.set(workspace.directory, point);
}

function maybeInjectPlanConfirmationFault(workspace: LocalWorkspace, point: "after-consume" | "after-plan"): void {
  if (planConfirmationFaults.get(workspace.directory) !== point) return;
  planConfirmationFaults.delete(workspace.directory);
  throw planError("PLAN_CONFIRMATION_TEST_FAULT", `Injected Plan confirmation fault at ${point}.`, { point });
}

async function ensurePlanApprovedLedgerEntry(workspace: LocalWorkspace, plan: OrchestrationPlan, approvalRef: string): Promise<void> {
  const existing = (await listLedgerEntries(workspace)).filter((entry) => entry.event === "plan-approved" && entry.planRef === plan.planId);
  if (existing.some((entry) => entry.approvalRef === approvalRef)) return;
  if (existing.length > 0) {
    throw planError("PLAN_APPROVAL_AUDIT_CONFLICT", "The Plan approval ledger is already bound to a different Approval.", {
      planId: plan.planId,
      approvalRef,
      existingApprovalRefs: existing.map((entry) => entry.approvalRef)
    });
  }
  await appendLedgerEntry(workspace, { event: "plan-approved", taskId: plan.taskId, planRef: plan.planId, approvalRef, summary: `Plan ${plan.planId} approved.` });
}

/**
 * Replays every audit effect that can be derived exactly from the persisted
 * Plan. Terminal reason hashes live on the Plan/step, so recovery never needs
 * caller prose and cannot silently substitute a different reason.
 */
export function ensurePlanLifecycleCommitted(workspace: LocalWorkspace, plan: OrchestrationPlan): Promise<void> {
  return withWorkspaceLock(workspace, async () => {
    const current = await getPlan(workspace, plan.planId);
    if (JSON.stringify(current) !== JSON.stringify(plan)) {
      throw planError("PLAN_STATE_CONFLICT", "The persisted Plan changed before lifecycle reconciliation.", { planId: plan.planId });
    }
    await ensureExactPlanLedgerEffect(workspace, planCreatedEffect(current));
    if (current.approvalRef !== undefined) {
      const proof = await getPersistedPlanConfirmationProof(workspace, current);
      await ensurePlanApprovedLedgerEntry(workspace, current, proof.id);
    }
    if (Number.isSafeInteger(current.generation) && (current.generation ?? 0) > 0) {
      await ensureExactPlanLedgerEffect(workspace, planExecutingEffect(current));
    }
    for (const step of current.steps) {
      if (step.status !== "PENDING") {
        await ensureExactPlanLedgerEffect(workspace, planStepStartedEffect(current, step.stepId));
      }
      if (step.status === "COMPLETED") {
        await ensureExactPlanLedgerEffect(workspace, planStepCompletedEffect(current, step.stepId));
      } else if (step.status === "FAILED") {
        if (step.failureReasonHash === undefined) {
          await assertLegacyPlanLedgerEffect(workspace, current.planId, "plan-step-failed", step.stepId);
        } else {
          await ensureExactPlanLedgerEffect(workspace, planStepFailedEffect(current, step.stepId));
        }
      }
    }
    if (current.status === "COMPLETED") {
      await ensureExactPlanLedgerEffect(workspace, planCompletedEffect(current));
    } else if (current.status === "FAILED") {
      if (current.failureReasonHash === undefined) await assertLegacyPlanLedgerEffect(workspace, current.planId, "plan-failed");
      else await ensureExactPlanLedgerEffect(workspace, planFailedEffect(current));
    } else if (current.status === "CANCELLED") {
      if (current.cancellationReasonHash === undefined) await assertLegacyPlanLedgerEffect(workspace, current.planId, "plan-cancelled");
      else await ensureExactPlanLedgerEffect(workspace, planCancelledEffect(current));
    }
  });
}

async function ensureExactPlanLedgerEffect(workspace: LocalWorkspace, effect: AppendLedgerEntry): Promise<void> {
  const entries = await listLedgerEntries(workspace);
  const sameIdentity = entries.filter((entry) => entry.event === effect.event && entry.planRef === effect.planRef &&
    entry.stepId === effect.stepId && entry.approvalRef === effect.approvalRef);
  const exact = sameIdentity.filter((entry) => entry.taskId === effect.taskId && entry.summary === effect.summary);
  if (sameIdentity.length > 1 || (sameIdentity.length === 1 && exact.length !== 1)) {
    throw planError("PLAN_LIFECYCLE_AUDIT_CONFLICT", "Plan lifecycle has a duplicate or conflicting audit effect.", {
      planId: effect.planRef, event: effect.event, stepId: effect.stepId, entries: sameIdentity.length
    });
  }
  if (exact.length === 0) await appendLedgerEntry(workspace, effect);
}

async function assertLegacyPlanLedgerEffect(workspace: LocalWorkspace, planId: string, event: "plan-step-failed" | "plan-failed" | "plan-cancelled", stepId?: string): Promise<void> {
  const matching = (await listLedgerEntries(workspace)).filter((entry) => entry.event === event && entry.planRef === planId && entry.stepId === stepId);
  if (matching.length !== 1) {
    throw planError("PLAN_REISSUE_REQUIRED", "A legacy terminal Plan without a bound reason hash is usable only when its original audit effect is intact.", {
      planId, event, stepId, entries: matching.length
    });
  }
}

function planCreatedEffect(plan: OrchestrationPlan): AppendLedgerEntry {
  return prepareLedgerEntry({ event: "plan-created", taskId: plan.taskId, planRef: plan.planId, summary: `Plan ${plan.planId} created with ${plan.steps.length} steps.` });
}
function planExecutingEffect(plan: OrchestrationPlan): AppendLedgerEntry {
  return prepareLedgerEntry({ event: "plan-executing", taskId: plan.taskId, planRef: plan.planId, summary: `Plan ${plan.planId} started executing.` });
}
function planStepCompletedEffect(plan: OrchestrationPlan, stepId: string): AppendLedgerEntry {
  const step = stepById(plan, stepId);
  const evidenceCount = step.evidenceRefs?.length ?? 0;
  return prepareLedgerEntry({ event: "plan-step-completed", taskId: plan.taskId, planRef: plan.planId, stepId, summary: `Plan ${plan.planId} step ${stepId} completed with ${evidenceCount} result reference(s).` });
}
function planStepStartedEffect(plan: OrchestrationPlan, stepId: string): AppendLedgerEntry {
  stepById(plan, stepId);
  return prepareLedgerEntry({ event: "plan-step-started", taskId: plan.taskId, planRef: plan.planId, stepId, summary: `Plan ${plan.planId} step ${stepId} started.` });
}
function planStepFailedEffect(plan: OrchestrationPlan, stepId: string): AppendLedgerEntry {
  const step = stepById(plan, stepId);
  if (step.failureReasonHash === undefined) throw planError("PLAN_REISSUE_REQUIRED", "Failed Plan step lacks its bound reason hash.", { planId: plan.planId, stepId });
  return prepareLedgerEntry({ event: "plan-step-failed", taskId: plan.taskId, planRef: plan.planId, stepId, summary: `Plan ${plan.planId} step ${stepId} failed; reason ${auditFingerprintFromReasonHash(step.failureReasonHash)}.` });
}
function planCompletedEffect(plan: OrchestrationPlan): AppendLedgerEntry {
  return prepareLedgerEntry({ event: "plan-completed", taskId: plan.taskId, planRef: plan.planId, summary: `Plan ${plan.planId} completed.` });
}
function planFailedEffect(plan: OrchestrationPlan): AppendLedgerEntry {
  if (plan.failureReasonHash === undefined) throw planError("PLAN_REISSUE_REQUIRED", "Failed Plan lacks its bound reason hash.", { planId: plan.planId });
  return prepareLedgerEntry({ event: "plan-failed", taskId: plan.taskId, planRef: plan.planId, summary: `Plan ${plan.planId} failed; reason ${auditFingerprintFromReasonHash(plan.failureReasonHash)}.` });
}
function planCancelledEffect(plan: OrchestrationPlan): AppendLedgerEntry {
  if (plan.cancellationReasonHash === undefined) throw planError("PLAN_REISSUE_REQUIRED", "Cancelled Plan lacks its bound reason hash.", { planId: plan.planId });
  return prepareLedgerEntry({ event: "plan-cancelled", taskId: plan.taskId, planRef: plan.planId, summary: `Plan ${plan.planId} cancelled; reason ${auditFingerprintFromReasonHash(plan.cancellationReasonHash)}.` });
}
function reasonHash(reason: string): string { return `sha256:${createHash("sha256").update(reason, "utf8").digest("hex")}`; }
function auditFingerprintFromReasonHash(hash: string): string {
  const digest = hash.slice("sha256:".length);
  return `sha256:${digest.match(/.{1,12}/g)?.join("-") ?? digest}`;
}
function maybeInjectPlanLifecycleFault(workspace: LocalWorkspace, point: PlanLifecycleFaultPoint, planId: string): void {
  if (planLifecycleFaults.get(workspace.directory) !== point) return;
  planLifecycleFaults.delete(workspace.directory);
  throw planError("PLAN_LIFECYCLE_FAULT_INJECTED", `Injected Plan lifecycle fault at ${point}.`, { planId, point });
}

export async function cancelPlan(workspace: LocalWorkspace, planId: string, reason: string): Promise<OrchestrationPlan> {
  return withWorkspaceLock(workspace, async () => {
    if (!reason || reason.length > 512) throw planError("PLAN_CANCEL_REASON_INVALID", "Cancellation reason must be 1-512 characters.");
    const current = await getPlan(workspace, planId);
    await ensurePlanLifecycleCommitted(workspace, current);
    if (current.status === "CANCELLED") {
      if (current.cancellationReasonHash !== reasonHash(reason)) {
        throw planError("PLAN_IDEMPOTENCY_CONFLICT", "Cancelled Plan retry reason does not match the persisted terminal reason.", { planId });
      }
      await revokePlanLeases(workspace, current, `Plan ${current.planId} cancelled.`);
      return current;
    }
    if (current.status === "COMPLETED" || current.status === "FAILED") {
      throw planError("PLAN_STATE_CONFLICT", "Terminal plans cannot be cancelled.", { planId, status: current.status });
    }
    const cancellationReasonHash = reasonHash(reason);
    const next: OrchestrationPlan = { ...current, status: "CANCELLED", cancelledAt: new Date().toISOString(), cancellationReasonHash };
    const ledgerEntry = planCancelledEffect(next);
    await writeWorkspaceJson(workspace, fileName(planId), next);
    maybeInjectPlanLifecycleFault(workspace, "after-plan", planId);
    await revokePlanLeases(workspace, next, `Plan ${next.planId} cancelled.`);
    await ensureExactPlanLedgerEffect(workspace, ledgerEntry);
    maybeInjectPlanLifecycleFault(workspace, "after-ledger", planId);
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

/** Moves an APPROVED plan into execution. */
export async function executePlan(workspace: LocalWorkspace, planId: string): Promise<OrchestrationPlan> {
  return withWorkspaceLock(workspace, async () => {
    const current = await getPlan(workspace, planId);
    await ensurePlanLifecycleCommitted(workspace, current);
    assertCurrentPlanGeneration(current);
    if (current.status === "EXECUTING") return current;
    await assertCurrentPlanTaskAuthority(workspace, current);
    if (current.status !== "APPROVED") throw planError("PLAN_STATE_CONFLICT", "Only APPROVED plans can be executed.", { planId, status: current.status });
    await assertCurrentPlanConfirmationApproval(workspace, current);
    const next: OrchestrationPlan = { ...current, status: "EXECUTING", generation: current.generation + 1 };
    const ledgerEffect = planExecutingEffect(next);
    await writeWorkspaceJson(workspace, fileName(planId), next);
    maybeInjectPlanLifecycleFault(workspace, "after-plan", planId);
    await ensureExactPlanLedgerEffect(workspace, ledgerEffect);
    maybeInjectPlanLifecycleFault(workspace, "after-ledger", planId);
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
    await ensurePlanLifecycleCommitted(workspace, current);
    assertCurrentPlanGeneration(current);
    if (current.status === "EXECUTING") {
      const committedStep = stepById(current, stepId);
      if (committedStep.status === "RUNNING") {
        const refs = committedStep.leaseRefs ?? [];
        const byId = new Map((await listLeases(workspace)).map((lease) => [lease.id, lease]));
        const committedLeases = refs.map((leaseId) => byId.get(leaseId));
        if (committedLeases.some((lease) => lease === undefined) || committedLeases.some((lease) =>
          lease!.status !== "active" || lease!.planRef !== current.planId || lease!.stepRef !== stepId ||
          lease!.planGeneration !== current.generation || lease!.agentId !== agentId
        )) {
          throw planError("PLAN_STEP_LEASE_RECOVERY_CONFLICT", "A RUNNING Plan step cannot recover because its committed Lease set is missing or bound to another execution.", {
            planId, stepId, leaseRefs: refs, agentId
          });
        }
        return { step: committedStep, leases: committedLeases as CapabilityLease[] };
      }
    }
    await assertCurrentPlanTaskAuthority(workspace, current);
    await assertCurrentPlanConfirmationApproval(workspace, current);
    if (current.status !== "EXECUTING") throw planError("PLAN_STATE_CONFLICT", "Only EXECUTING plans can begin steps.", { planId, status: current.status });
    const step = stepById(current, stepId);
    if (step.status !== "PENDING") throw planError("PLAN_STEP_STATE_CONFLICT", "Only PENDING steps can be begun.", { planId, stepId, status: step.status });
    const capabilities = new Set<string>();
    for (const tool of step.tools) {
      const capability = TOOLS_TO_CAPABILITY[tool];
      if (!capability) throw planError("PLAN_STEP_TOOL_UNSUPPORTED", `Step tool ${tool} has no supported capability.`, { planId, stepId, tool });
      capabilities.add(capability);
    }
    const issuedCapabilities = [...capabilities].filter((capability) => capability !== "repository-write").sort();
    await revokeMismatchedOrphanedStepLeases(workspace, current, step, agentId, issuedCapabilities);
    const leases: CapabilityLease[] = [];
    try {
      for (const capability of issuedCapabilities) {
        leases.push(await issueLease(workspace, schemas, {
          taskId: current.taskId,
          agentId,
          role: step.role,
          capability,
          readScope: step.readScope,
          planRef: current.planId,
          stepRef: step.stepId,
          planGeneration: current.generation,
          issuedBy: "plan-step-derived"
        }));
      }
      // The Plan record is the commit point: until every Lease ID is registered
      // on a RUNNING step, use-time admission rejects any partially issued Lease.
      const next: OrchestrationPlan = {
        ...current,
        steps: current.steps.map((candidate) => candidate.stepId === stepId
          ? { ...candidate, status: "RUNNING" as const, leaseRefs: leases.map((lease) => lease.id) }
          : candidate)
      };
      schemas.validate("plan", next);
      const ledgerEffect = planStepStartedEffect(next, stepId);
      await writeWorkspaceJson(workspace, fileName(planId), next);
      maybeInjectPlanLifecycleFault(workspace, "after-plan", planId);
      await ensureExactPlanLedgerEffect(workspace, ledgerEffect);
      maybeInjectPlanLifecycleFault(workspace, "after-ledger", planId);
      return { step: next.steps.find((candidate) => candidate.stepId === stepId)!, leases };
    } catch (error: unknown) {
      // Partially issued Leases are not registered on a RUNNING step, so
      // use-time admission rejects them. Exact retry reuses the journals;
      // terminal Plan/step cleanup scans and revokes registered and orphaned
      // generation-bound Leases alike.
      throw error;
    }
  });
}

/**
 * A PENDING step has not committed any Lease authority yet. Preserve only
 * exact-request active orphans so same-agent crash recovery can reuse their
 * issuance journals; revoke every stale agent/role/capability/scope variant.
 */
async function revokeMismatchedOrphanedStepLeases(
  workspace: LocalWorkspace,
  plan: OrchestrationPlan & { generation: number },
  step: PlanStep,
  agentId: string,
  capabilities: string[]
): Promise<void> {
  const expectedCapabilities = new Set(capabilities);
  const registered = new Set(step.leaseRefs ?? []);
  const reason = `Plan ${plan.planId} step ${step.stepId} orphaned Lease superseded before commit.`;
  for (const lease of await listLeases(workspace)) {
    if (
      lease.status !== "active" || lease.planRef !== plan.planId || lease.stepRef !== step.stepId ||
      lease.planGeneration !== plan.generation || registered.has(lease.id)
    ) continue;
    const exactRequest = lease.agentId === agentId && lease.role === step.role && expectedCapabilities.has(lease.capability) &&
      lease.issuedBy === "plan-step-derived" && JSON.stringify(lease.readScope) === JSON.stringify(step.readScope) &&
      lease.writeSet.length === 0;
    if (!exactRequest) await revokeLease(workspace, lease.id, reason);
  }
}

/** Marks a RUNNING step completed, optionally recording the step's result references. */
export async function completeStep(workspace: LocalWorkspace, planId: string, stepId: string, evidenceRefs?: string[]): Promise<OrchestrationPlan> {
  return withWorkspaceLock(workspace, async () => {
    const current = await getPlan(workspace, planId);
    await ensurePlanLifecycleCommitted(workspace, current);
    const existingStep = stepById(current, stepId);
    if (existingStep.status === "COMPLETED") {
      if (JSON.stringify(existingStep.evidenceRefs) !== JSON.stringify(evidenceRefs)) {
        throw planError("PLAN_IDEMPOTENCY_CONFLICT", "Completed Plan step retry evidence does not match the persisted result references.", { planId, stepId });
      }
      await revokeStepLeases(workspace, current, stepId, `Plan ${current.planId} step ${stepId} completed.`);
      return current;
    }
    assertCurrentPlanGeneration(current);
    await assertCurrentPlanTaskAuthority(workspace, current);
    await assertCurrentPlanConfirmationApproval(workspace, current);
    const step = existingStep;
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
    const ledgerEffect = planStepCompletedEffect(next, stepId);
    await writeWorkspaceJson(workspace, fileName(planId), next);
    maybeInjectPlanLifecycleFault(workspace, "after-plan", planId);
    await revokeStepLeases(workspace, next, stepId, `Plan ${next.planId} step ${stepId} completed.`);
    await ensureExactPlanLedgerEffect(workspace, ledgerEffect);
    maybeInjectPlanLifecycleFault(workspace, "after-ledger", planId);
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
    await ensurePlanLifecycleCommitted(workspace, current);
    const existingStep = stepById(current, stepId);
    if (existingStep.status === "FAILED") {
      if (existingStep.failureReasonHash !== reasonHash(reason)) {
        throw planError("PLAN_IDEMPOTENCY_CONFLICT", "Failed Plan step retry reason does not match the persisted terminal reason.", { planId, stepId });
      }
      await revokeStepLeases(workspace, current, stepId, `Plan ${current.planId} step ${stepId} failed.`);
      return current;
    }
    assertCurrentPlanGeneration(current);
    await assertCurrentPlanTaskAuthority(workspace, current);
    await assertCurrentPlanConfirmationApproval(workspace, current);
    const step = existingStep;
    if (step.status !== "RUNNING") throw planError("PLAN_STEP_STATE_CONFLICT", "Only RUNNING steps can fail.", { planId, stepId, status: step.status });
    const failureReasonHash = reasonHash(reason);
    const next: OrchestrationPlan = {
      ...current,
      steps: current.steps.map((candidate) => candidate.stepId === stepId
        ? { ...candidate, status: "FAILED" as const, failureReasonHash }
        : candidate)
    };
    const ledgerEntry = planStepFailedEffect(next, stepId);
    await writeWorkspaceJson(workspace, fileName(planId), next);
    maybeInjectPlanLifecycleFault(workspace, "after-plan", planId);
    await revokeStepLeases(workspace, next, stepId, `Plan ${next.planId} step ${stepId} failed.`);
    await ensureExactPlanLedgerEffect(workspace, ledgerEntry);
    maybeInjectPlanLifecycleFault(workspace, "after-ledger", planId);
    return next;
  });
}

/** Finishes an EXECUTING plan when every step is completed. */
export async function finishPlan(workspace: LocalWorkspace, planId: string): Promise<OrchestrationPlan> {
  return withWorkspaceLock(workspace, async () => {
    const current = await getPlan(workspace, planId);
    await ensurePlanLifecycleCommitted(workspace, current);
    if (current.status === "COMPLETED") {
      await revokePlanLeases(workspace, current, `Plan ${current.planId} completed.`);
      return current;
    }
    assertCurrentPlanGeneration(current);
    await assertCurrentPlanTaskAuthority(workspace, current);
    await assertCurrentPlanConfirmationApproval(workspace, current);
    if (current.status !== "EXECUTING") throw planError("PLAN_STATE_CONFLICT", "Only EXECUTING plans can be finished.", { planId, status: current.status });
    if (current.steps.some((step) => step.status !== "COMPLETED")) throw planError("PLAN_STEPS_INCOMPLETE", "All steps must be completed before finishing the plan.", { planId });
    const next: OrchestrationPlan = { ...current, status: "COMPLETED" };
    const ledgerEffect = planCompletedEffect(next);
    await writeWorkspaceJson(workspace, fileName(planId), next);
    maybeInjectPlanLifecycleFault(workspace, "after-plan", planId);
    await revokePlanLeases(workspace, next, `Plan ${next.planId} completed.`);
    await ensureExactPlanLedgerEffect(workspace, ledgerEffect);
    maybeInjectPlanLifecycleFault(workspace, "after-ledger", planId);
    return next;
  });
}

/** Fails an EXECUTING plan. */
export async function failPlan(workspace: LocalWorkspace, planId: string, reason: string): Promise<OrchestrationPlan> {
  return withWorkspaceLock(workspace, async () => {
    if (!reason || reason.length > 512) throw planError("PLAN_FAIL_REASON_INVALID", "Failure reason must be 1-512 characters.");
    const current = await getPlan(workspace, planId);
    await ensurePlanLifecycleCommitted(workspace, current);
    if (current.status === "FAILED") {
      if (current.failureReasonHash !== reasonHash(reason)) {
        throw planError("PLAN_IDEMPOTENCY_CONFLICT", "Failed Plan retry reason does not match the persisted terminal reason.", { planId });
      }
      await revokePlanLeases(workspace, current, `Plan ${current.planId} failed.`);
      return current;
    }
    assertCurrentPlanGeneration(current);
    await assertCurrentPlanTaskAuthority(workspace, current);
    await assertCurrentPlanConfirmationApproval(workspace, current);
    if (current.status !== "EXECUTING") throw planError("PLAN_STATE_CONFLICT", "Only EXECUTING plans can fail.", { planId, status: current.status });
    const failureReasonHash = reasonHash(reason);
    const next: OrchestrationPlan = { ...current, status: "FAILED", failureReasonHash };
    const ledgerEntry = planFailedEffect(next);
    await writeWorkspaceJson(workspace, fileName(planId), next);
    maybeInjectPlanLifecycleFault(workspace, "after-plan", planId);
    await revokePlanLeases(workspace, next, `Plan ${next.planId} failed.`);
    await ensureExactPlanLedgerEffect(workspace, ledgerEntry);
    maybeInjectPlanLifecycleFault(workspace, "after-ledger", planId);
    return next;
  });
}

async function revokeStepLeases(workspace: LocalWorkspace, plan: OrchestrationPlan, stepId: string, reason: string): Promise<void> {
  stepById(plan, stepId);
  const leaseIds = new Set<string>();
  for (const lease of await listLeases(workspace)) {
    if (
      lease.status === "active" && lease.planRef === plan.planId &&
      lease.stepRef === stepId && lease.planGeneration === plan.generation
    ) leaseIds.add(lease.id);
  }
  for (const leaseId of leaseIds) {
    // Terminal persisted state is the fail-closed authority. Revocation is an
    // explicit cleanup and audit signal, but its failure cannot reactivate it.
    await revokeLease(workspace, leaseId, reason).catch(() => undefined);
  }
}

async function revokePlanLeases(workspace: LocalWorkspace, plan: OrchestrationPlan, reason: string): Promise<void> {
  for (const step of plan.steps) await revokeStepLeases(workspace, plan, step.stepId, reason);
}

/** Legacy Plans remain inspectable/cancellable, but cannot regain execution authority. */
export function assertCurrentPlanGeneration(plan: OrchestrationPlan): asserts plan is OrchestrationPlan & { generation: number } {
  if (
    !Number.isSafeInteger(plan.generation) || plan.generation! < 0 ||
    plan.taskAuthorityHash === undefined || plan.policyVersion === undefined || plan.hostSessionId === undefined ||
    plan.planSubjectVersion !== PLAN_SUBJECT_VERSION || plan.planSubjectHash === undefined ||
    plan.creationRequestHash === undefined || plan.planSubjectHash !== hashPlanSubject(plan)
  ) {
    throw planError(
      "PLAN_REISSUE_REQUIRED",
      "This legacy or invalid Plan remains readable/cancellable but cannot execute; cancel it and create a new Plan under the current authority model.",
      { planId: plan.planId }
    );
  }
}

/** Exact create-request identity used to recover a Plan whose response was lost. */
function hashPlanCreationRequest(input: {
  taskId: string;
  taskAuthorityHash: string;
  hostSessionId: string;
  goal: string;
  steps: PlanStep[];
}): string {
  const canonical = {
    version: 1,
    policyVersion: TASK_AUTHORITY_POLICY_VERSION,
    planSubjectVersion: PLAN_SUBJECT_VERSION,
    taskId: input.taskId,
    taskAuthorityHash: input.taskAuthorityHash,
    hostSessionId: input.hostSessionId,
    goal: input.goal,
    steps: input.steps.map((step) => ({
      stepId: step.stepId,
      role: step.role,
      goal: step.goal,
      tools: step.tools,
      readScope: step.readScope,
      writes: step.writes,
      dependsOn: step.dependsOn ?? null
    }))
  };
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex")}`;
}

/** Deterministic immutable subject hash used by precise plan-confirm Approvals. */
export function hashPlanSubject(plan: OrchestrationPlan): string {
  const canonical = {
    version: plan.version,
    planId: plan.planId,
    taskId: plan.taskId,
    taskAuthorityHash: plan.taskAuthorityHash ?? null,
    policyVersion: plan.policyVersion ?? null,
    hostSessionId: plan.hostSessionId ?? null,
    planSubjectVersion: plan.planSubjectVersion ?? null,
    creationRequestHash: plan.creationRequestHash ?? null,
    goal: plan.goal,
    steps: plan.steps.map((step) => ({
      stepId: step.stepId,
      role: step.role,
      goal: step.goal,
      tools: step.tools,
      readScope: step.readScope,
      writes: step.writes,
      dependsOn: step.dependsOn ?? null
    }))
  };
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex")}`;
}

async function assertCurrentPlanTaskAuthority(workspace: LocalWorkspace, plan: OrchestrationPlan): Promise<void> {
  if (plan.policyVersion !== TASK_AUTHORITY_POLICY_VERSION) {
    throw planError("PLAN_POLICY_STALE", "The Plan was created under a policy version that is no longer active.", {
      planId: plan.planId,
      expected: TASK_AUTHORITY_POLICY_VERSION,
      observed: plan.policyVersion
    });
  }
  const task = await getTask(workspace, plan.taskId);
  assertCurrentTaskAuthorityGeneration(task);
  assertPlanTaskLifecycleOpen(task.id, task.state);
  const currentHash = hashTaskAuthority(task);
  if (plan.taskAuthorityHash !== currentHash) {
    throw planError("PLAN_TASK_AUTHORITY_STALE", "The Task authority changed after this Plan was created.", {
      planId: plan.planId,
      taskId: plan.taskId,
      expected: plan.taskAuthorityHash,
      observed: currentHash
    });
  }
}

function assertPlanTaskLifecycleOpen(taskId: string, state: string): void {
  if (TERMINAL_TASK_STATES.has(state)) {
    throw planError("PLAN_TASK_STATE_CLOSED", "A terminal Task cannot create, confirm, or execute Plan work; existing Plans remain readable and cancellable.", { taskId, state });
  }
}

/** Shared use-time fence for every Plan-owned execution or write mutation. */
export async function assertCurrentPlanExecutionAuthority(workspace: LocalWorkspace, plan: OrchestrationPlan): Promise<void> {
  await ensurePlanLifecycleCommitted(workspace, plan);
  assertCurrentPlanGeneration(plan);
  await assertCurrentPlanTaskAuthority(workspace, plan);
  await assertCurrentPlanConfirmationApproval(workspace, plan);
}

function isExactPlanConfirmationApproval(plan: OrchestrationPlan, approval: import("../contracts/types.js").Approval, hostSessionId: string): boolean {
  return hasImmutablePlanConfirmationBinding(plan, approval, hostSessionId) &&
    approval.status === "approved" &&
    !isApprovalExpired(approval) &&
    Date.parse(approval.budget!.expiresAt!) > Date.now() &&
    ((approval.consumedAt === undefined && approval.consumedBy === undefined) ||
      (approval.consumedAt !== undefined && approval.consumedBy === plan.planId));
}

/**
 * Execution-time gate for a confirmed Plan. Unlike audit repair, this requires
 * the consumed Approval to remain currently approved and unexpired.
 */
export async function assertCurrentPlanConfirmationApproval(workspace: LocalWorkspace, plan: OrchestrationPlan): Promise<void> {
  assertCurrentPlanGeneration(plan);
  const approval = await getPersistedPlanConfirmationProof(workspace, plan);
  if (
    approval.status !== "approved" || isApprovalExpired(approval) ||
    approval.budget?.expiresAt === undefined || Date.parse(approval.budget.expiresAt) <= Date.now()
  ) {
    throw planError("PLAN_CONFIRMATION_NOT_ACTIVE", "The Plan confirmation Approval is revoked or expired; cancel the Plan or obtain a newly confirmed Plan.", {
      planId: plan.planId,
      approvalRef: approval.id,
      approvalStatus: approval.status
    });
  }
}

/** Loads the immutable consumed proof used only for APPROVED-state audit repair. */
async function getPersistedPlanConfirmationProof(workspace: LocalWorkspace, plan: OrchestrationPlan): Promise<import("../contracts/types.js").Approval> {
  if (plan.approvalRef === undefined || plan.hostSessionId === undefined) {
    throw planError("PLAN_APPROVAL_PROOF_MISSING", "An APPROVED or executing Plan must retain its exact consumed plan-confirm Approval reference.", { planId: plan.planId });
  }
  const approval = await getApproval(workspace, plan.approvalRef);
  if (!hasImmutablePlanConfirmationBinding(plan, approval, plan.hostSessionId) || approval.consumedAt === undefined || approval.consumedBy !== plan.planId) {
    throw planError("PLAN_APPROVAL_PROOF_INVALID", "The persisted Plan confirmation Approval does not match this immutable Plan subject.", {
      planId: plan.planId,
      approvalRef: plan.approvalRef
    });
  }
  return approval;
}

/** Status/clock-independent binding retained after a legitimate revoke/expiry. */
function hasImmutablePlanConfirmationBinding(plan: OrchestrationPlan, approval: import("../contracts/types.js").Approval, hostSessionId: string): boolean {
  return approval.taskId === plan.taskId &&
    approval.action === PLAN_CONFIRM_ACTION &&
    approval.subjectKind === "plan" &&
    approval.subjectId === plan.planId &&
    approval.subjectVersion === plan.planSubjectVersion &&
    approval.subjectHash === plan.planSubjectHash &&
    approval.capability === PLAN_CONFIRM_CAPABILITY &&
    approval.policyVersion === plan.policyVersion &&
    approval.requestedBy !== undefined &&
    approval.hostSessionId === hostSessionId &&
    approval.decidedBy !== undefined &&
    approval.expiresAt !== undefined &&
    approval.nonce !== undefined &&
    approval.budget?.maxToolCalls === 1 &&
    approval.budget.expiresAt !== undefined &&
    Date.parse(approval.budget.expiresAt) <= Date.parse(approval.expiresAt) &&
    exactSet(approval.scope ?? [], [plan.planId]);
}

function exactSet(left: string[], right: string[]): boolean {
  return left.length === right.length && new Set(left).size === left.length && left.every((item) => right.includes(item));
}

function assertHostSessionId(hostSessionId: string): void {
  if (hostSessionId.length === 0 || hostSessionId.length > 256 || /[\0\r\n]/.test(hostSessionId)) {
    throw planError("PLAN_HOST_SESSION_INVALID", "Plan hostSessionId is invalid.");
  }
}
