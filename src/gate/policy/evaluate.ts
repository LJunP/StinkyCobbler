import type { CapabilityLease, PolicyDecision, TaskCharter } from "../contracts/types.js";

const NEVER_AUTONOMOUS = new Set(["secret-read", "production-access", "payment", "legal-final-decision", "medical-final-decision", "investment-final-decision", "external-data-export"]);

export function evaluateTask(task: TaskCharter): PolicyDecision {
  if (task.riskLevel === "L3") return deny("HUMAN_APPROVAL_REQUIRED", ["L3 tasks require human approval and are unavailable in the current public executor."], ["human-approval"]);
  if (task.riskLevel === "L2" && !task.approvalRequired) return deny("APPROVAL_REQUIRED", ["L2 tasks require explicit approval before execution."], ["explicit-approval"]);
  if ((task.writeSet?.length ?? 0) > 0) return deny("WRITE_NOT_IMPLEMENTED", ["Task-level business writes are not executed by this task-policy path; use the controlled L1 WriteIntent flow."]);
  return allow();
}

export function evaluateLease(lease: CapabilityLease, context: { taskId: string; role: string; workspace: string; capability: string; toolCallsUsed?: number }): PolicyDecision {
  if (lease.status !== "active") return deny("LEASE_NOT_ACTIVE", [`Lease status is ${lease.status}.`]);
  if (lease.taskId !== context.taskId) return deny("LEASE_TASK_MISMATCH", ["Lease taskId does not match the requested task."]);
  if (lease.role !== context.role) return deny("LEASE_ROLE_MISMATCH", ["Lease role does not match the requested role."]);
  if (lease.workspace !== context.workspace) return deny("CROSS_WORKSPACE_DENIED", ["Lease workspace does not match the requested workspace."]);
  if (lease.capability !== context.capability) return deny("LEASE_CAPABILITY_MISMATCH", ["Lease does not grant this capability."]);
  // Admission is the start of a new capability use. In-flight work is protected
  // by its pre-expiry reservation/fence, never by extending the Lease itself.
  if (Date.parse(lease.expiresAt) <= Date.now()) return deny("LEASE_EXPIRED", ["Lease has expired; issue a new Lease before starting another capability use."]);
  if ((context.toolCallsUsed ?? 0) >= lease.maxToolCalls) return deny("LEASE_CALL_LIMIT", ["Lease tool-call limit has been reached."]);
  if (lease.writeSet.length > 0 && lease.capability !== "repository-write" && !(lease.capability === "docs-index" && lease.writeSet.every((item) => item === ".stinky-cobbler/docs-index.json"))) return deny("WRITE_NOT_IMPLEMENTED", ["This capability cannot carry a business write scope; only repository-write or the fixed local documentation index target is allowed."]);
  if (lease.capability === "repository-write" && lease.writeSet.length === 0) return deny("WRITE_SET_EMPTY", ["A repository-write lease requires a non-empty writeSet."]);
  if (NEVER_AUTONOMOUS.has(lease.capability)) return deny("NEVER_AUTONOMOUS", [`${lease.capability} is never autonomous.`]);
  if (lease.level === "L2" || lease.level === "L3") return deny("HIGH_IMPACT_NOT_IMPLEMENTED", ["The current public executor refuses L2/L3 capability execution."]);
  return allow();
}

function allow(): PolicyDecision { return { allowed: true, code: "ALLOWED", reasons: [], policyVersion: "1" }; }
function deny(code: string, reasons: string[], requiredApprovals?: string[]): PolicyDecision {
  return { allowed: false, code, reasons, ...(requiredApprovals ? { requiredApprovals } : {}), policyVersion: "1" };
}
