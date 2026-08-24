import { readFile } from "node:fs/promises";
import type { TaskCharter, TaskState } from "../contracts/types.js";
import { defaultSchemaRegistry } from "../contracts/default-schema-registry.js";
import { allowedTaskTransitions, isTaskTerminal } from "../domain/task-state.js";
import { ExitCode, StinkyCobblerError } from "../errors.js";
import type { LocalWorkspace } from "./workspace.js";
import { createWorkspaceJson, workspaceFile, writeWorkspaceJson } from "./workspace.js";
import { withWorkspaceLock } from "./workspace-lock.js";

const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const TASK_MAX_WORKSPACE_ID_LENGTH = 256;
const TASK_MAX_GOAL_LENGTH = 2048;
const TASK_MAX_PROFILE_LENGTH = 128;
const TASK_MAX_TEXT_ITEMS = 20;
const TASK_MAX_SCOPE_ITEMS = 50;
const TASK_MAX_WRITE_SET_ITEMS = 20;
const TASK_MAX_APPROVAL_REFS = 50;
const TASK_MAX_COMPLETION_EVIDENCE_REFS = 100;
const TASK_MAX_TEXT_ITEM_LENGTH = 512;
const TASK_MAX_PACK_ID_LENGTH = 128;
const TASK_MAX_APPROVAL_REF_LENGTH = 128;

export function assertSafeTaskId(id: string): void {
  if (!TASK_ID.test(id)) {
    throw new StinkyCobblerError("TASK_ID_INVALID", ExitCode.VALIDATION, "Task ID must contain 1-128 letters, numbers, underscores, or hyphens and start with a letter or number.", { id });
  }
}

export async function createTask(workspace: LocalWorkspace, task: TaskCharter): Promise<void> {
  assertTaskInputSize(task);
  assertSafeTaskId(task.id);
  if (task.state === "DONE") {
    throw new StinkyCobblerError("TASK_INITIAL_DONE_DENIED", ExitCode.POLICY_DENIED, "A Task cannot be created directly in DONE; completion must pass VERIFYING -> DONE with Runtime proof.", { taskId: task.id });
  }
  if (task.completionReceiptRef !== undefined || task.completionEvidenceRefs !== undefined) {
    throw new StinkyCobblerError("TASK_COMPLETION_PROOF_INVALID", ExitCode.POLICY_DENIED, "Completion proof may only be attached by the guarded VERIFYING -> DONE transition.", { taskId: task.id });
  }
  if (task.authorityGeneration !== undefined && task.authorityGeneration !== 0) {
    throw new StinkyCobblerError("TASK_AUTHORITY_GENERATION_INVALID", ExitCode.VALIDATION, "New Tasks must start at authorityGeneration 0.", { taskId: task.id, authorityGeneration: task.authorityGeneration });
  }
  task.authorityGeneration = 0;
  (await defaultSchemaRegistry()).validate("task", task);
  try {
    await withWorkspaceLock(workspace, () => createWorkspaceJson(workspace, taskFileName(task.id), task));
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") {
      throw new StinkyCobblerError("TASK_EXISTS", ExitCode.VALIDATION, "A task with this ID already exists.", { taskId: task.id });
    }
    throw error;
  }
}

export async function getTask(workspace: LocalWorkspace, id: string): Promise<TaskCharter> {
  assertSafeTaskId(id);
  const target = await taskFile(workspace, id);
  try {
    const value: unknown = JSON.parse(await readFile(target, "utf8"));
    (await defaultSchemaRegistry()).validate("task", value);
    const task = value as TaskCharter;
    if (task.id !== id) {
      throw new StinkyCobblerError("TASK_INVALID", ExitCode.VALIDATION, "Stored Task ID does not match its canonical lookup ID.", { taskId: id, storedTaskId: task.id });
    }
    return task;
  } catch (error: unknown) {
    if (isNotFound(error)) throw new StinkyCobblerError("TASK_NOT_FOUND", ExitCode.VALIDATION, "Task does not exist.", { taskId: id });
    if (error instanceof SyntaxError) throw new StinkyCobblerError("TASK_INVALID", ExitCode.VALIDATION, "Stored task contains invalid JSON.", { taskId: id });
    throw error;
  }
}

export async function saveTask(workspace: LocalWorkspace, task: TaskCharter): Promise<void> {
  assertTaskInputSize(task);
  assertSafeTaskId(task.id);
  await withWorkspaceLock(workspace, async () => {
    const current = await getTask(workspace, task.id);
    const generation = requireAuthorityGeneration(current);
    if (task.state !== current.state) {
      throw new StinkyCobblerError("TASK_TRANSITION_REQUIRED", ExitCode.POLICY_DENIED, "Task state changes must use the guarded transition API.", { taskId: task.id, from: current.state, requested: task.state });
    }
    if (task.completionReceiptRef !== current.completionReceiptRef || JSON.stringify(task.completionEvidenceRefs) !== JSON.stringify(current.completionEvidenceRefs)) {
      throw new StinkyCobblerError("TASK_COMPLETION_TRANSITION_REQUIRED", ExitCode.POLICY_DENIED, "Task completion proof can be written only by the guarded VERIFYING -> DONE transition.", { taskId: task.id });
    }
    if (task.authorityGeneration !== generation) {
      throw new StinkyCobblerError("TASK_AUTHORITY_GENERATION_CONFLICT", ExitCode.POLICY_DENIED, "Task authorityGeneration cannot be omitted, forged, or rolled back.", { taskId: task.id, expected: generation, requested: task.authorityGeneration });
    }
    const changed = JSON.stringify(current) !== JSON.stringify(task);
    if (changed && isTaskTerminal(current.state)) {
      throw new StinkyCobblerError("TASK_TERMINAL_IMMUTABLE", ExitCode.POLICY_DENIED, "Terminal Tasks cannot be overwritten.", { taskId: task.id, state: current.state });
    }
    const next: TaskCharter = changed ? { ...task, authorityGeneration: nextGeneration(generation, task.id) } : task;
    (await defaultSchemaRegistry()).validate("task", next);
    await writeWorkspaceJson(workspace, taskFileName(task.id), next);
    task.authorityGeneration = next.authorityGeneration as number;
  });
}

export async function listTasks(workspace: LocalWorkspace): Promise<TaskCharter[]> {
  const { readdir } = await import("node:fs/promises");
  let names: string[];
  try {
    names = await readdir(workspace.directory);
  } catch (error) {
    throw error;
  }
  const tasks = await Promise.all(names.filter((name) => /^task-[A-Za-z0-9][A-Za-z0-9_-]{0,127}\.json$/.test(name)).sort()
    .map((name) => getTask(workspace, name.slice("task-".length, -".json".length))));
  return tasks;
}

export function taskPlan(state: TaskState): { state: TaskState; nextStates: TaskState[]; terminal: boolean } {
  return { state, nextStates: allowedTaskTransitions(state), terminal: isTaskTerminal(state) };
}

function taskFileName(id: string): string { return `task-${id}.json`; }
async function taskFile(workspace: LocalWorkspace, id: string): Promise<string> { return workspaceFile(workspace, taskFileName(id)); }
function isNotFound(error: unknown): boolean { return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"; }
function assertTaskInputSize(task: TaskCharter): void {
  assertTaskStringSize(task.workspaceId, "workspaceId", TASK_MAX_WORKSPACE_ID_LENGTH);
  assertTaskStringSize(task.goal, "goal", TASK_MAX_GOAL_LENGTH);
  assertTaskStringSize(task.profile, "profile", TASK_MAX_PROFILE_LENGTH);
  assertTaskStringArraySize(task.nonGoals, "nonGoals", TASK_MAX_TEXT_ITEMS, TASK_MAX_TEXT_ITEM_LENGTH);
  assertTaskStringArraySize(task.scope, "scope", TASK_MAX_SCOPE_ITEMS, TASK_MAX_TEXT_ITEM_LENGTH);
  assertTaskStringArraySize(task.inputs, "inputs", TASK_MAX_TEXT_ITEMS, TASK_MAX_TEXT_ITEM_LENGTH);
  assertTaskStringArraySize(task.requestedOutputs, "requestedOutputs", TASK_MAX_TEXT_ITEMS, TASK_MAX_TEXT_ITEM_LENGTH);
  assertTaskStringArraySize(task.acceptanceCriteria, "acceptanceCriteria", TASK_MAX_TEXT_ITEMS, TASK_MAX_TEXT_ITEM_LENGTH);
  assertTaskStringArraySize(task.stopConditions, "stopConditions", TASK_MAX_TEXT_ITEMS, TASK_MAX_TEXT_ITEM_LENGTH);
  assertTaskStringArraySize(task.constraints, "constraints", TASK_MAX_TEXT_ITEMS, TASK_MAX_TEXT_ITEM_LENGTH);
  assertTaskStringArraySize(task.riskNotes, "riskNotes", TASK_MAX_TEXT_ITEMS, TASK_MAX_TEXT_ITEM_LENGTH);
  assertTaskStringArraySize(task.packs, "packs", TASK_MAX_TEXT_ITEMS, TASK_MAX_PACK_ID_LENGTH);
  assertTaskStringArraySize(task.writeSet, "writeSet", TASK_MAX_WRITE_SET_ITEMS, TASK_MAX_TEXT_ITEM_LENGTH);
  assertTaskStringArraySize(task.approvalRefs, "approvalRefs", TASK_MAX_APPROVAL_REFS, TASK_MAX_APPROVAL_REF_LENGTH);
  assertTaskStringArraySize(task.completionEvidenceRefs, "completionEvidenceRefs", TASK_MAX_COMPLETION_EVIDENCE_REFS, TASK_MAX_APPROVAL_REF_LENGTH);
}
function assertTaskStringSize(value: string | undefined, field: string, maxLength: number): void {
  if (value !== undefined && value.length > maxLength) throw taskInputSizeError(field, { maxLength, length: value.length });
}
function assertTaskStringArraySize(value: string[] | undefined, field: string, maxItems: number, maxItemLength: number): void {
  if (value === undefined) return;
  if (value.length > maxItems) throw taskInputSizeError(field, { maxItems, items: value.length });
  const index = value.findIndex((item) => item.length > maxItemLength);
  if (index !== -1) throw taskInputSizeError(field, { maxItemLength, index, length: value[index]!.length });
}
function taskInputSizeError(field: string, details: Record<string, number>): StinkyCobblerError {
  return new StinkyCobblerError("TASK_INPUT_TOO_LARGE", ExitCode.VALIDATION, `Task ${field} exceeds the canonical input size limit.`, { field, ...details });
}
function requireAuthorityGeneration(task: TaskCharter): number {
  if (!Number.isSafeInteger(task.authorityGeneration) || (task.authorityGeneration ?? -1) < 0) {
    throw new StinkyCobblerError("TASK_AUTHORITY_REISSUE_REQUIRED", ExitCode.POLICY_DENIED, "This legacy Task remains readable but cannot be mutated or executed; create a new Task under the current authority model.", { taskId: task.id });
  }
  return task.authorityGeneration as number;
}
function nextGeneration(current: number, taskId: string): number {
  if (current >= Number.MAX_SAFE_INTEGER) throw new StinkyCobblerError("TASK_AUTHORITY_GENERATION_EXHAUSTED", ExitCode.POLICY_DENIED, "Task authorityGeneration is exhausted; create a replacement Task.", { taskId });
  return current + 1;
}
