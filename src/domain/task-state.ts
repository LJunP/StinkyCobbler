import type { TaskState } from "../contracts/types.js";
import { ExitCode, StinkyCobblerError } from "../errors.js";

const TERMINAL_OR_RECOVERY = new Set<TaskState>(["BLOCKED", "REWORK", "CANCELLED"]);
const EARLY_TRANSITIONS: Record<TaskState, TaskState[]> = {
  DRAFT: ["SCOPED"],
  SCOPED: ["DESIGNED"],
  DESIGNED: [],
  APPROVED_FOR_EXECUTION: [],
  RUNNING: [],
  REVIEWING: [],
  VERIFYING: [],
  AWAITING_APPROVAL: [],
  ARCHIVED: [],
  DONE: [],
  BLOCKED: [],
  REWORK: [],
  CANCELLED: []
};

export function assertTransition(from: TaskState, to: TaskState): void {
  if (TERMINAL_OR_RECOVERY.has(to)) return;
  if (to === "DONE" || to === "APPROVED_FOR_EXECUTION" || to === "RUNNING" || to === "REVIEWING" || to === "VERIFYING" || to === "AWAITING_APPROVAL" || to === "ARCHIVED") {
    throw new StinkyCobblerError("GATE_NOT_IMPLEMENTED", ExitCode.POLICY_DENIED, `The ${from} -> ${to} transition is not authorized in v0.1.`, { from, to });
  }
  if (!EARLY_TRANSITIONS[from].includes(to)) {
    throw new StinkyCobblerError("INVALID_TRANSITION", ExitCode.POLICY_DENIED, `Task cannot transition from ${from} to ${to}.`, { from, to });
  }
}
