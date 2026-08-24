import type { TaskState } from "../contracts/types.js";
import { ExitCode, StinkyCobblerError } from "../errors.js";

const ALLOWED_TRANSITIONS: Record<TaskState, TaskState[]> = {
  DRAFT: ["SCOPED", "BLOCKED", "CANCELLED"],
  SCOPED: ["DESIGNED", "BLOCKED", "REWORK", "CANCELLED"],
  DESIGNED: ["APPROVED_FOR_EXECUTION", "BLOCKED", "REWORK", "CANCELLED"],
  APPROVED_FOR_EXECUTION: ["RUNNING", "BLOCKED", "REWORK", "CANCELLED"],
  RUNNING: ["REVIEWING", "BLOCKED", "REWORK", "CANCELLED"],
  REVIEWING: ["VERIFYING", "BLOCKED", "REWORK", "CANCELLED"],
  VERIFYING: ["DONE", "BLOCKED", "REWORK", "CANCELLED"],
  AWAITING_APPROVAL: ["BLOCKED", "REWORK", "CANCELLED"],
  ARCHIVED: [],
  DONE: [],
  BLOCKED: ["REWORK", "CANCELLED"],
  REWORK: ["DESIGNED", "BLOCKED", "CANCELLED"],
  CANCELLED: []
};

export function allowedTaskTransitions(from: TaskState): TaskState[] {
  return [...ALLOWED_TRANSITIONS[from]];
}

export function isTaskTerminal(state: TaskState): boolean {
  return ALLOWED_TRANSITIONS[state].length === 0;
}

export function isTaskExecutionState(state: TaskState): boolean {
  return state === "APPROVED_FOR_EXECUTION" || state === "RUNNING";
}

export function assertTransition(from: TaskState, to: TaskState): void {
  if (to === "AWAITING_APPROVAL" || to === "ARCHIVED") throw new StinkyCobblerError("GATE_NOT_IMPLEMENTED", ExitCode.POLICY_DENIED, `The ${from} -> ${to} transition is not authorized by the current Task state engine.`, { from, to });
  if (!ALLOWED_TRANSITIONS[from].includes(to)) {
    throw new StinkyCobblerError("INVALID_TRANSITION", ExitCode.POLICY_DENIED, `Task cannot transition from ${from} to ${to}.`, { from, to });
  }
}
