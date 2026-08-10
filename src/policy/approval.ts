import type { Approval, TaskCharter } from "../contracts/types.js";
import { ExitCode, StinkyCobblerError } from "../errors.js";

export interface ApprovalPreflight {
  allowed: boolean;
  code: string;
  reasons: string[];
  requiredApprovals?: string[];
  matchedApprovals?: string[];
}

/** True when the approval carries an expiresAt that has passed by `now`. */
export function isApprovalExpired(approval: Approval, now: Date = new Date()): boolean {
  return approval.expiresAt !== undefined && Date.parse(approval.expiresAt) <= now.getTime();
}

export function evaluateTaskApproval(
  task: TaskCharter,
  approvals: Approval[],
  action: string,
  scope: string[] = [],
  options: { now?: Date } = {}
): ApprovalPreflight {
  if (typeof action !== "string" || action.length === 0 || action.includes("\0")) {
    throw new StinkyCobblerError("APPROVAL_ACTION_INVALID", ExitCode.VALIDATION, "Approval preflight action is invalid.");
  }
  const base = evaluateBaseline(task);
  if (!base.allowed) return base;
  if (task.riskLevel !== "L2") return base;

  const requiredApprovals = task.approvalRefs?.length ? [...task.approvalRefs] : ["explicit-approval"];
  const now = options.now ?? new Date();
  const matching = approvals.filter((approval) =>
    approval.taskId === task.id &&
    approval.status === "approved" &&
    approval.action === action &&
    coversScope(approval.scope, scope)
  );
  const matches = matching.filter((approval) => !isApprovalExpired(approval, now));
  if (matches.length === 0) {
    const expired = matching.length > 0;
    return {
      allowed: false,
      code: "APPROVAL_NOT_SATISFIED",
      reasons: [expired
        ? "Matching approved records exist but have all expired."
        : "No current approved record matches the task, action, and requested scope."],
      requiredApprovals,
      matchedApprovals: []
    };
  }
  return {
    allowed: true,
    code: "APPROVAL_SATISFIED",
    reasons: ["An explicit approved record matches the task, action, and requested scope."],
    requiredApprovals,
    matchedApprovals: matches.map((approval) => approval.id).sort()
  };
}

function evaluateBaseline(task: TaskCharter): ApprovalPreflight {
  if (task.riskLevel === "L3") {
    return {
      allowed: false,
      code: "HUMAN_APPROVAL_REQUIRED",
      reasons: ["L3 tasks require human approval and remain non-executable in this release."],
      requiredApprovals: ["human-approval"]
    };
  }
  if (task.riskLevel === "L2" && !task.approvalRequired) {
    return {
      allowed: false,
      code: "APPROVAL_REQUIRED",
      reasons: ["L2 tasks must explicitly declare that approval is required."],
      requiredApprovals: ["explicit-approval"]
    };
  }
  if ((task.writeSet?.length ?? 0) > 0) {
    return { allowed: false, code: "WRITE_NOT_IMPLEMENTED", reasons: ["Business workspace writes are not implemented."] };
  }
  return { allowed: true, code: "ALLOWED", reasons: [] };
}

function coversScope(approved: string[] | undefined, requested: string[]): boolean {
  if (requested.length === 0) return true;
  if (!approved || approved.length === 0) return false;
  return requested.every((item) => approved.some((allowed) => allowed === "." || item === allowed || item.startsWith(`${allowed.replace(/[\\/]+$/, "")}/`)));
}

export function assertApprovalSemantic(value: Approval): Approval {
  const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
  if (!idPattern.test(value.id) || !idPattern.test(value.taskId)) throw approvalInvalid("Approval ID or task ID is invalid.");
  if (!value.action || value.action.includes("\0") || value.action.length > 256) throw approvalInvalid("Approval action is invalid.");
  if (!isCanonicalDate(value.requestedAt)) throw approvalInvalid("Approval requestedAt must be a canonical ISO timestamp.");
  if (value.expiresAt !== undefined && (!isCanonicalDate(value.expiresAt) || Date.parse(value.expiresAt) <= Date.parse(value.requestedAt))) throw approvalInvalid("Approval expiresAt must be a canonical ISO timestamp after requestedAt.");
  if (value.scope?.some((item) => typeof item !== "string" || item.length === 0 || item.includes("\0"))) throw approvalInvalid("Approval scope is invalid.");
  const decided = value.status !== "requested";
  if (decided && (!value.decidedBy || !isCanonicalDate(value.decidedAt ?? ""))) throw approvalInvalid("A decided approval requires decidedAt and decidedBy.");
  if (!decided && (value.decidedAt !== undefined || value.decidedBy !== undefined)) throw approvalInvalid("A requested approval cannot contain decision metadata.");
  if (value.decidedAt !== undefined && Date.parse(value.decidedAt) < Date.parse(value.requestedAt)) throw approvalInvalid("Approval decision cannot precede the request.");
  if (value.reason !== undefined && (value.reason.length === 0 || value.reason.length > 512)) throw approvalInvalid("Approval reason is invalid.");
  return value;
}

function isCanonicalDate(value: string): boolean { const date = new Date(value); return !Number.isNaN(date.getTime()) && date.toISOString() === value; }
function approvalInvalid(message: string): StinkyCobblerError { return new StinkyCobblerError("APPROVAL_INVALID", ExitCode.VALIDATION, message); }
