import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { defaultSchemaRegistry } from "../contracts/default-schema-registry.js";
import type { CapabilityLease, PolicyDecision } from "../contracts/types.js";
import { ExitCode, StinkyCobblerError } from "../errors.js";
import { evaluateLease } from "../policy/evaluate.js";
import type { LocalWorkspace } from "./workspace.js";
import { workspaceFile, writeWorkspaceJson } from "./workspace.js";
import { withWorkspaceLock } from "./workspace-lock.js";
import { getLease } from "./leases.js";
import { admitPersistedLeaseAuthority, TASK_AUTHORITY_POLICY_VERSION } from "./task-authority.js";
import { evaluateLeaseRoleTool } from "../policy/role-tools.js";

const LEASE_USAGE_FILE = "lease-usage.json";
const LEASE_DENIAL_USAGE_FILE = "lease-denial-usage.json";
const LEASE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** Durable security-denial audit cap per Lease. Successful calls use the ordinary Lease budget. */
export const MAX_AUDITED_LEASE_DENIALS = 8;
/** Hard bound for each durable Lease counter aggregate. */
export const MAX_LEASE_USAGE_COUNTERS = 4096;
const MAX_LEASE_PARENT_DEPTH = 64;
export interface LeaseAdmission {
  allowed: boolean;
  decision: PolicyDecision;
  used: number;
  /** Authoritative lease loaded from workspace storage while holding the reservation lock. */
  lease: CapabilityLease;
  reservationId?: string;
  reservationOrdinal?: number;
  /** A denied attempt may create durable audit state only while this bounded counter is available. */
  auditDeniedAttempt?: boolean;
}

/**
 * Loads the persisted lease, evaluates it, and reserves one execution attempt
 * inside the same workspace lock. The caller supplies only the public lease ID;
 * caller-provided lease fields never participate in authorization.
 */
export async function admitAndReserveLeaseCall(
  workspace: LocalWorkspace,
  leaseId: string,
  context: { taskId: string; role: string; capability: string; operation?: string; roleTools?: Record<string, string[]> },
  validateLease?: (lease: unknown) => void,
  beforeAuditableDecision?: (lease: CapabilityLease, reservation?: { id: string; ordinal: number }) => Promise<void>
): Promise<LeaseAdmission> {
  assertLeaseId(leaseId);
  return withWorkspaceLock(workspace, async () => {
    const lease = await getLease(workspace, leaseId);
    if (lease.id !== leaseId) {
      throw new StinkyCobblerError("LEASE_INVALID", ExitCode.VALIDATION, "Stored lease ID does not match its canonical lookup ID.", { leaseId, storedLeaseId: lease.id });
    }
    validateLease?.(lease);
    const state = await readUsage(workspace);
    const used = state[lease.id] ?? 0;
    const deniedWithBoundedAudit = async (decision: PolicyDecision): Promise<LeaseAdmission> => {
      const auditDeniedAttempt = await reserveDeniedAttemptAudit(workspace, lease.id);
      if (auditDeniedAttempt) await beforeAuditableDecision?.(lease);
      return { allowed: false, decision, used, lease, auditDeniedAttempt };
    };
    try {
      await admitPersistedLeaseAuthority(workspace, lease, [context.capability]);
    } catch (error: unknown) {
      if (error instanceof StinkyCobblerError) {
        return deniedWithBoundedAudit({ allowed: false, code: error.code, reasons: [error.message], policyVersion: TASK_AUTHORITY_POLICY_VERSION });
      }
      throw error;
    }
    if (context.operation !== undefined || context.roleTools !== undefined) {
      if (context.operation === undefined || context.roleTools === undefined) {
        throw usageInvalid("Lease operation admission requires both operation and roleTools.");
      }
      const roleToolDecision = evaluateLeaseRoleTool(lease, context.operation, context.roleTools);
      if (!roleToolDecision.allowed) return deniedWithBoundedAudit(roleToolDecision);
    }
    let decision = evaluateLease(lease, {
      taskId: context.taskId,
      role: context.role,
      workspace: workspace.root,
      capability: context.capability,
      toolCallsUsed: used
    });
    if (decision.allowed) decision = await evaluateLeaseSubtaskBinding(workspace, lease);
    if (!decision.allowed) {
      return deniedWithBoundedAudit(decision);
    }
    const budgetChain = await loadLeaseBudgetChain(workspace, lease);
    const exhausted = budgetChain.find((grant) => (state[grant.id] ?? 0) >= grant.maxToolCalls);
    if (exhausted !== undefined) {
      const limit: PolicyDecision = {
        allowed: false,
        code: exhausted.id === lease.id ? "LEASE_CALL_LIMIT" : "PARENT_LEASE_CALL_LIMIT",
        reasons: [exhausted.id === lease.id ? "Lease tool-call limit has been reached." : "An ancestor Lease shared tool-call budget has been reached."],
        policyVersion: "1"
      };
      return deniedWithBoundedAudit(limit);
    }
    if (!await ensureCounterCapacity(workspace, state, budgetChain.map((grant) => grant.id), LEASE_USAGE_FILE)) {
      const limit: PolicyDecision = {
        allowed: false,
        code: "LEASE_USAGE_CAP_REACHED",
        reasons: ["The bounded durable Lease usage aggregate has no capacity for another Lease identity."],
        policyVersion: "1"
      };
      return deniedWithBoundedAudit(limit);
    }
    const reservation = { id: `reservation-${randomUUID()}`, ordinal: used + 1 };
    await beforeAuditableDecision?.(lease, reservation);
    for (const grant of budgetChain) state[grant.id] = (state[grant.id] ?? 0) + 1;
    await writeUsage(workspace, state);
    return { allowed: true, decision, used: used + 1, lease, reservationId: reservation.id, reservationOrdinal: reservation.ordinal };
  });
}

/** Reserves one call against a persisted Lease and every ancestor Lease budget. */
export async function reservePersistedLeaseCall(workspace: LocalWorkspace, leaseId: string): Promise<{ allowed: boolean; used: number }> {
  assertLeaseId(leaseId);
  return withWorkspaceLock(workspace, async () => {
    const lease = await getLease(workspace, leaseId);
    const chain = await loadLeaseBudgetChain(workspace, lease);
    const state = await readUsage(workspace);
    const exhausted = chain.find((grant) => (state[grant.id] ?? 0) >= grant.maxToolCalls);
    if (exhausted !== undefined) return { allowed: false, used: state[lease.id] ?? 0 };
    if (!await ensureCounterCapacity(workspace, state, chain.map((grant) => grant.id), LEASE_USAGE_FILE)) return { allowed: false, used: state[lease.id] ?? 0 };
    for (const grant of chain) state[grant.id] = (state[grant.id] ?? 0) + 1;
    await writeUsage(workspace, state);
    return { allowed: true, used: state[lease.id]! };
  });
}

/** Releases a failed pre-mutation reservation from the leaf and all ancestor budgets. */
export async function releasePersistedLeaseCall(workspace: LocalWorkspace, leaseId: string, reservedUsed: number): Promise<boolean> {
  assertLeaseId(leaseId);
  if (!Number.isSafeInteger(reservedUsed) || reservedUsed < 1) throw usageInvalid("Lease reservation counter is invalid.");
  return withWorkspaceLock(workspace, async () => {
    const lease = await getLease(workspace, leaseId);
    const chain = await loadLeaseBudgetChain(workspace, lease);
    const state = await readUsage(workspace);
    if ((state[lease.id] ?? 0) !== reservedUsed) return false;
    for (const grant of chain) {
      const current = state[grant.id] ?? 0;
      if (current <= 1) delete state[grant.id];
      else state[grant.id] = current - 1;
    }
    await writeUsage(workspace, state);
    return true;
  });
}

export async function getLeaseCallUsage(workspace: LocalWorkspace, leaseId: string): Promise<number> {
  assertLeaseId(leaseId);
  return withWorkspaceLock(workspace, async () => (await readUsage(workspace))[leaseId] ?? 0);
}

/** Read-only diagnostic for the bounded durable audit allowance consumed by denied attempts. */
export async function getLeaseDenialAuditUsage(workspace: LocalWorkspace, leaseId: string): Promise<number> {
  assertLeaseId(leaseId);
  return withWorkspaceLock(workspace, async () => (await readCounters(workspace, LEASE_DENIAL_USAGE_FILE))[leaseId] ?? 0);
}

/** Reserves one call only when the lease has remaining capacity. */
export async function reserveLeaseCall(workspace: LocalWorkspace, leaseId: string, maxToolCalls: number): Promise<{ allowed: boolean; used: number }> {
  assertLeaseId(leaseId);
  if (!Number.isSafeInteger(maxToolCalls) || maxToolCalls < 1) throw usageInvalid("Lease call limit is invalid.");
  return withWorkspaceLock(workspace, async () => {
    const state = await readUsage(workspace);
    const used = state[leaseId] ?? 0;
    if (used >= maxToolCalls) return { allowed: false, used };
    if (!await ensureCounterCapacity(workspace, state, [leaseId], LEASE_USAGE_FILE)) return { allowed: false, used };
    state[leaseId] = used + 1;
    await writeUsage(workspace, state);
    return { allowed: true, used: used + 1 };
  });
}

/**
 * Reverts one reservation only when it is still the newest reservation for
 * this lease. Used when a storage-layer write cannot commit any business-file
 * mutation after direct CLI admission. It never decrements past concurrent
 * later reservations.
 */
export async function releaseLatestLeaseCall(workspace: LocalWorkspace, leaseId: string, reservedUsed: number): Promise<boolean> {
  assertLeaseId(leaseId);
  if (!Number.isSafeInteger(reservedUsed) || reservedUsed < 1) throw usageInvalid("Lease reservation counter is invalid.");
  return withWorkspaceLock(workspace, async () => {
    const state = await readUsage(workspace);
    if ((state[leaseId] ?? 0) !== reservedUsed || reservedUsed < 1) return false;
    if (reservedUsed === 1) delete state[leaseId];
    else state[leaseId] = reservedUsed - 1;
    await writeUsage(workspace, state);
    return true;
  });
}

async function readUsage(workspace: LocalWorkspace): Promise<Record<string, number>> {
  return readCounters(workspace, LEASE_USAGE_FILE);
}

async function readCounters(workspace: LocalWorkspace, file: string): Promise<Record<string, number>> {
  const statePath = await workspaceFile(workspace, file);
  let value: unknown;
  try { value = JSON.parse(await readFile(statePath, "utf8")); }
  catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return {};
    throw error;
  }
  (await defaultSchemaRegistry()).validate("lease-usage", value);
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw usageInvalid("Lease usage must be an object.");
  const state: Record<string, number> = {};
  for (const [leaseId, used] of Object.entries(value)) {
    if (!LEASE_ID_PATTERN.test(leaseId) || typeof used !== "number" || !Number.isSafeInteger(used) || used < 0) throw usageInvalid("Lease usage contains an invalid counter.");
    state[leaseId] = used;
  }
  return state;
}

async function writeUsage(workspace: LocalWorkspace, state: Record<string, number>): Promise<void> {
  await writeCounters(workspace, LEASE_USAGE_FILE, state);
}

async function writeCounters(workspace: LocalWorkspace, file: string, state: Record<string, number>): Promise<void> {
  (await defaultSchemaRegistry()).validate("lease-usage", state);
  await writeWorkspaceJson(workspace, file, state);
}

async function reserveDeniedAttemptAudit(workspace: LocalWorkspace, leaseId: string): Promise<boolean> {
  const state = await readCounters(workspace, LEASE_DENIAL_USAGE_FILE);
  const used = state[leaseId] ?? 0;
  if (used >= MAX_AUDITED_LEASE_DENIALS) return false;
  if (!await ensureCounterCapacity(workspace, state, [leaseId], LEASE_DENIAL_USAGE_FILE)) return false;
  state[leaseId] = used + 1;
  await writeCounters(workspace, LEASE_DENIAL_USAGE_FILE, state);
  return true;
}

async function loadLeaseBudgetChain(workspace: LocalWorkspace, leaf: CapabilityLease): Promise<CapabilityLease[]> {
  const chain: CapabilityLease[] = [];
  const seen = new Set<string>();
  let current: CapabilityLease | undefined = leaf;
  while (current !== undefined) {
    if (seen.has(current.id)) throw usageInvalid("Lease parent chain contains a cycle.");
    if (chain.length >= MAX_LEASE_PARENT_DEPTH) throw usageInvalid("Lease parent chain exceeds the supported depth.");
    seen.add(current.id);
    chain.push(current);
    current = current.parentGrantRef.startsWith("lease-") ? await getLease(workspace, current.parentGrantRef) : undefined;
  }
  return chain;
}

function hasCounterCapacity(state: Record<string, number>, ids: string[]): boolean {
  const additions = new Set(ids.filter((id) => state[id] === undefined));
  return Object.keys(state).length + additions.size <= MAX_LEASE_USAGE_COUNTERS;
}

/** Reclaims counters only when their persisted Lease can no longer execute. */
async function ensureCounterCapacity(
  workspace: LocalWorkspace,
  state: Record<string, number>,
  ids: string[],
  file: typeof LEASE_USAGE_FILE | typeof LEASE_DENIAL_USAGE_FILE
): Promise<boolean> {
  if (hasCounterCapacity(state, ids)) return true;
  const required = new Set(ids);
  let changed = false;
  const now = Date.now();
  for (const leaseId of Object.keys(state).sort()) {
    if (required.has(leaseId)) continue;
    let reclaimable = false;
    try {
      const lease = await getLease(workspace, leaseId);
      reclaimable = lease.status !== "active" || !Number.isFinite(Date.parse(lease.expiresAt)) || Date.parse(lease.expiresAt) <= now;
    } catch (error: unknown) {
      if (error instanceof StinkyCobblerError && error.code === "LEASE_NOT_FOUND") reclaimable = true;
      else throw error;
    }
    if (!reclaimable) continue;
    delete state[leaseId];
    changed = true;
    if (hasCounterCapacity(state, ids)) break;
  }
  if (changed) await writeCounters(workspace, file, state);
  return hasCounterCapacity(state, ids);
}

/** An execution-bound lease is usable only by its current Plan step or subtask dispatch. */
export async function evaluateLeaseSubtaskBinding(workspace: LocalWorkspace, lease: CapabilityLease): Promise<PolicyDecision> {
  if (lease.planRef !== undefined || lease.stepRef !== undefined || lease.planGeneration !== undefined) {
    if (lease.planRef === undefined || lease.stepRef === undefined || lease.planGeneration === undefined || lease.subtaskRef !== undefined) {
      return deniedDecision("LEASE_PLAN_BINDING_INVALID", "Lease Plan binding is incomplete or conflicts with a subtask binding.");
    }
    try {
      const { assertCurrentPlanExecutionAuthority, getPlan } = await import("./plans.js");
      const plan = await getPlan(workspace, lease.planRef);
      if (plan.taskId !== lease.taskId) return deniedDecision("LEASE_PLAN_BINDING_INVALID", "Lease task does not match its bound Plan.");
      if (plan.status !== "EXECUTING") return deniedDecision("LEASE_PLAN_NOT_ACTIVE", `Lease Plan status is ${plan.status}; only EXECUTING Plans may invoke tools.`);
      if (plan.generation !== lease.planGeneration) return deniedDecision("LEASE_PLAN_GENERATION_STALE", "Lease Plan generation is no longer current.");
      const step = plan.steps.find((candidate) => candidate.stepId === lease.stepRef);
      if (step === undefined || !step.leaseRefs?.includes(lease.id)) return deniedDecision("LEASE_PLAN_BINDING_INVALID", "Lease is not registered on its bound Plan step.");
      if (step.status !== "RUNNING") return deniedDecision("LEASE_PLAN_STEP_NOT_ACTIVE", `Lease Plan step status is ${step.status}; only RUNNING steps may invoke tools.`);
      if (step.role !== lease.role) return deniedDecision("LEASE_PLAN_ROLE_MISMATCH", "Lease role does not match its bound Plan step.");
      try {
        await assertCurrentPlanExecutionAuthority(workspace, plan);
      } catch (error: unknown) {
        if (error instanceof StinkyCobblerError && error.code === "PLAN_CONFIRMATION_NOT_ACTIVE") {
          return deniedDecision("LEASE_PLAN_CONFIRMATION_NOT_ACTIVE", error.message);
        }
        return deniedDecision("LEASE_PLAN_CONFIRMATION_INVALID", "Lease Plan confirmation proof could not be verified.");
      }
      return allowedDecision();
    } catch {
      return deniedDecision("LEASE_PLAN_BINDING_INVALID", "Lease Plan binding could not be verified.");
    }
  }
  if (lease.subtaskRef === undefined) return allowedDecision();
  if (!Number.isSafeInteger(lease.subtaskAttempt) || (lease.subtaskAttempt ?? -1) < 0) {
    return deniedDecision("LEASE_REISSUE_REQUIRED", "Legacy subtask Lease has no retry-generation binding and cannot invoke tools; re-dispatch the subtask.");
  }
  try {
    const [{ ensureOrchestrationActivationCommitted, getRun, getSubtask }, { getRunCancellationFence }] = await Promise.all([
      import("./orchestration.js"),
      import("./orchestration-fence.js")
    ]);
    const subtask = await getSubtask(workspace, lease.subtaskRef);
    if (subtask.subtaskId !== lease.subtaskRef || !subtask.leaseRefs?.includes(lease.id)) {
      return deniedDecision("LEASE_SUBTASK_BINDING_INVALID", "Lease is not registered on its bound subtask.");
    }
    if (subtask.activeAttempt !== lease.subtaskAttempt || subtask.retriesUsed !== lease.subtaskAttempt) {
      return deniedDecision("LEASE_SUBTASK_GENERATION_STALE", "Lease retry generation is no longer the subtask's active attempt.");
    }
    const run = await getRun(workspace, subtask.runRef);
    if (!run.subtasks.includes(subtask.subtaskId) || run.contractRef !== subtask.contractRef) {
      return deniedDecision("LEASE_SUBTASK_BINDING_INVALID", "Lease subtask is not bound to its declared orchestration run.");
    }
    await ensureOrchestrationActivationCommitted(workspace, run, subtask);
    if ((run.status !== "RUNNING" && run.status !== "DEGRADED") || await getRunCancellationFence(workspace, run.runId)) {
      return deniedDecision("LEASE_SUBTASK_NOT_ACTIVE", "Lease orchestration run is not active.");
    }
    if (subtask.status !== "RUNNING") {
      return deniedDecision("LEASE_SUBTASK_NOT_ACTIVE", `Lease subtask status is ${subtask.status}; only RUNNING subtasks may invoke tools.`);
    }
    if (subtask.dispatchedAgentId !== lease.agentId) {
      return deniedDecision("LEASE_SUBTASK_AGENT_MISMATCH", "Lease agent does not match the subtask's current dispatched agent.");
    }
    const ownIndex = subtask.leaseRefs.lastIndexOf(lease.id);
    for (const laterId of subtask.leaseRefs.slice(ownIndex + 1)) {
      const later = await getLease(workspace, laterId);
      if (later.capability === lease.capability) {
        return deniedDecision("LEASE_SUBTASK_LEASE_STALE", "A newer lease supersedes this lease for the same subtask capability.");
      }
    }
    return allowedDecision();
  } catch {
    return deniedDecision("LEASE_SUBTASK_BINDING_INVALID", "Lease subtask binding could not be verified.");
  }
}

function allowedDecision(): PolicyDecision { return { allowed: true, code: "ALLOWED", reasons: [], policyVersion: "1" }; }
function deniedDecision(code: string, reason: string): PolicyDecision { return { allowed: false, code, reasons: [reason], policyVersion: "1" }; }

function usageInvalid(message: string): StinkyCobblerError { return new StinkyCobblerError("LEASE_USAGE_INVALID", ExitCode.VALIDATION, message); }

function assertLeaseId(leaseId: string): void {
  if (typeof leaseId !== "string" || !LEASE_ID_PATTERN.test(leaseId)) throw usageInvalid("Lease ID is invalid.");
}
