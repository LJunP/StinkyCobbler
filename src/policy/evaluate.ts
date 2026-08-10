import type { CapabilityLease, PolicyDecision, TaskCharter } from "../contracts/types.js";

const NEVER_AUTONOMOUS = new Set(["secret-read", "production-access", "payment", "legal-final-decision", "medical-final-decision", "investment-final-decision", "external-data-export"]);

/** Fixed global grace period: an expired lease still admits the SAME task within this window, so an in-flight task is not interrupted; new tasks require a fresh lease. */
export const DEFAULT_GRACE_PERIOD_MINUTES = 15;
export const DEFAULT_GRACE_PERIOD_MS = DEFAULT_GRACE_PERIOD_MINUTES * 60_000;

/** True only when the lease expired beyond the grace window (or never expired). Callers use this instead of a bare timestamp comparison. */
export function isLeaseExpiredBeyondGrace(expiresAt: string, now: number = Date.now(), graceMs: number = DEFAULT_GRACE_PERIOD_MS): boolean {
  return Date.parse(expiresAt) + graceMs <= now;
}

export function evaluateTask(task: TaskCharter): PolicyDecision {
  if (task.riskLevel === "L3") return deny("HUMAN_APPROVAL_REQUIRED", ["L3 tasks require human approval and cannot execute in v0.1."], ["human-approval"]);
  if (task.riskLevel === "L2" && !task.approvalRequired) return deny("APPROVAL_REQUIRED", ["L2 tasks require explicit approval before execution."], ["explicit-approval"]);
  if ((task.writeSet?.length ?? 0) > 0) return deny("WRITE_NOT_IMPLEMENTED", ["Business workspace writes are not implemented in v0.1."]);
  return allow();
}

export function evaluateLease(lease: CapabilityLease, context: { taskId: string; role: string; workspace: string; capability: string; toolCallsUsed?: number }): PolicyDecision {
  if (lease.status !== "active") return deny("LEASE_NOT_ACTIVE", [`Lease status is ${lease.status}.`]);
  if (lease.taskId !== context.taskId) return deny("LEASE_TASK_MISMATCH", ["Lease taskId does not match the requested task."]);
  if (lease.role !== context.role) return deny("LEASE_ROLE_MISMATCH", ["Lease role does not match the requested role."]);
  if (lease.workspace !== context.workspace) return deny("CROSS_WORKSPACE_DENIED", ["Lease workspace does not match the requested workspace."]);
  if (lease.capability !== context.capability) return deny("LEASE_CAPABILITY_MISMATCH", ["Lease does not grant this capability."]);
  // Expiry: deny only beyond the grace window. Within the grace period the same task
  // (taskId check above) keeps running; all remaining gates below still apply.
  const inGrace = isLeaseExpiredBeyondGrace(lease.expiresAt);
  if (inGrace) return deny("LEASE_EXPIRED", ["Lease has expired beyond the grace period; issue a new lease or renew before starting new tasks."]);
  if ((context.toolCallsUsed ?? 0) >= lease.maxToolCalls) return deny("LEASE_CALL_LIMIT", ["Lease tool-call limit has been reached."]);
  if (lease.writeSet.length > 0 && lease.capability !== "repository-write" && !(lease.capability === "docs-index" && lease.writeSet.every((item) => item === ".stinky-cobbler/docs-index.json"))) return deny("WRITE_NOT_IMPLEMENTED", ["v0.1 refuses business write scopes; only the local documentation index is allowed."]);
  if (lease.capability === "repository-write" && lease.writeSet.length === 0) return deny("WRITE_SET_EMPTY", ["A repository-write lease requires a non-empty writeSet."]);
  if (NEVER_AUTONOMOUS.has(lease.capability)) return deny("NEVER_AUTONOMOUS", [`${lease.capability} is never autonomous.`]);
  if (lease.level === "L2" || lease.level === "L3") return deny("HIGH_IMPACT_NOT_IMPLEMENTED", ["v0.1 refuses L2/L3 capability execution."]);
  return Date.parse(lease.expiresAt) <= Date.now()
    ? { allowed: true, code: "ALLOWED", reasons: ["Lease expired; admitted within the grace period; renew before starting new tasks."], policyVersion: "1" }
    : allow();
}

function allow(): PolicyDecision { return { allowed: true, code: "ALLOWED", reasons: [], policyVersion: "1" }; }
function deny(code: string, reasons: string[], requiredApprovals?: string[]): PolicyDecision {
  return { allowed: false, code, reasons, ...(requiredApprovals ? { requiredApprovals } : {}), policyVersion: "1" };
}
