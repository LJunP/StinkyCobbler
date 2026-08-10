import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { CapabilityLease, PolicyDecision } from "../contracts/types.js";
import { ExitCode, StinkyCobblerError } from "../errors.js";
import { evaluateLease } from "../policy/evaluate.js";
import type { LocalWorkspace } from "./workspace.js";
import { workspaceFile, writeWorkspaceJson } from "./workspace.js";
import { withWorkspaceLock } from "./workspace-lock.js";

const queues = new Map<string, Promise<unknown>>();
const LEASE_USAGE_FILE = "lease-usage.json";
export interface LeaseAdmission {
  allowed: boolean;
  decision: PolicyDecision;
  used: number;
  reservationId?: string;
}

/** Evaluates and reserves one execution attempt inside the same workspace queue. */
export async function admitAndReserveLeaseCall(
  workspace: LocalWorkspace,
  lease: CapabilityLease,
  context: { taskId: string; role: string; capability: string }
): Promise<LeaseAdmission> {
  return serialize(workspace.directory, () => withWorkspaceLock(workspace, async () => {
    const state = await readUsage(workspace);
    const used = state[lease.id] ?? 0;
    const decision = evaluateLease(lease, {
      taskId: context.taskId,
      role: context.role,
      workspace: workspace.root,
      capability: context.capability,
      toolCallsUsed: used
    });
    if (!decision.allowed) return { allowed: false, decision, used };
    if (used >= lease.maxToolCalls) {
      const limit: PolicyDecision = { allowed: false, code: "LEASE_CALL_LIMIT", reasons: ["Lease tool-call limit has been reached."], policyVersion: "1" };
      return { allowed: false, decision: limit, used };
    }
    state[lease.id] = used + 1;
    await writeWorkspaceJson(workspace, LEASE_USAGE_FILE, state);
    return { allowed: true, decision, used: used + 1, reservationId: `reservation-${randomUUID()}` };
  }));
}

export async function getLeaseCallUsage(workspace: LocalWorkspace, leaseId: string): Promise<number> {
  return serialize(workspace.directory, () => withWorkspaceLock(workspace, async () => (await readUsage(workspace))[leaseId] ?? 0));
}

/** Reserves one call only when the lease has remaining capacity. */
export async function reserveLeaseCall(workspace: LocalWorkspace, leaseId: string, maxToolCalls: number): Promise<{ allowed: boolean; used: number }> {
  return serialize(workspace.directory, () => withWorkspaceLock(workspace, async () => {
    const state = await readUsage(workspace);
    const used = state[leaseId] ?? 0;
    if (used >= maxToolCalls) return { allowed: false, used };
    state[leaseId] = used + 1;
    await writeWorkspaceJson(workspace, LEASE_USAGE_FILE, state);
    return { allowed: true, used: used + 1 };
  }));
}

async function readUsage(workspace: LocalWorkspace): Promise<Record<string, number>> {
  const statePath = await workspaceFile(workspace, LEASE_USAGE_FILE);
  let value: unknown;
  try { value = JSON.parse(await readFile(statePath, "utf8")); }
  catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return {};
    throw error;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw usageInvalid("Lease usage must be an object.");
  const state: Record<string, number> = {};
  for (const [leaseId, used] of Object.entries(value)) {
    if (!/^[A-Za-z0-9._-]+$/.test(leaseId) || typeof used !== "number" || !Number.isSafeInteger(used) || used < 0) throw usageInvalid("Lease usage contains an invalid counter.");
    state[leaseId] = used;
  }
  return state;
}

function usageInvalid(message: string): StinkyCobblerError { return new StinkyCobblerError("LEASE_USAGE_INVALID", ExitCode.VALIDATION, message); }

function serialize<T>(directory: string, action: () => Promise<T>): Promise<T> {
  const prior = queues.get(directory) ?? Promise.resolve();
  const next = prior.catch(() => undefined).then(action);
  queues.set(directory, next);
  void next.finally(() => { if (queues.get(directory) === next) queues.delete(directory); }).catch(() => undefined);
  return next;
}
