import { readFile } from "node:fs/promises";
import type { TaskCharter, TaskState } from "../contracts/types.js";
import { ExitCode, StinkyCobblerError } from "../errors.js";
import type { LocalWorkspace } from "./workspace.js";
import { createWorkspaceJson, workspaceFile, writeWorkspaceJson } from "./workspace.js";
import { withWorkspaceLock } from "./workspace-lock.js";

const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function assertSafeTaskId(id: string): void {
  if (!TASK_ID.test(id)) {
    throw new StinkyCobblerError("TASK_ID_INVALID", ExitCode.VALIDATION, "Task ID must contain 1-128 letters, numbers, underscores, or hyphens and start with a letter or number.", { id });
  }
}

export async function createTask(workspace: LocalWorkspace, task: TaskCharter): Promise<void> {
  assertSafeTaskId(task.id);
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
    return JSON.parse(await readFile(target, "utf8")) as TaskCharter;
  } catch (error: unknown) {
    if (isNotFound(error)) throw new StinkyCobblerError("TASK_NOT_FOUND", ExitCode.VALIDATION, "Task does not exist.", { taskId: id });
    if (error instanceof SyntaxError) throw new StinkyCobblerError("TASK_INVALID", ExitCode.VALIDATION, "Stored task contains invalid JSON.", { taskId: id });
    throw error;
  }
}

export async function saveTask(workspace: LocalWorkspace, task: TaskCharter): Promise<void> {
  assertSafeTaskId(task.id);
  await withWorkspaceLock(workspace, () => writeWorkspaceJson(workspace, taskFileName(task.id), task));
}

export async function listTasks(workspace: LocalWorkspace): Promise<TaskCharter[]> {
  const { readdir } = await import("node:fs/promises");
  let names: string[];
  try {
    names = await readdir(workspace.directory);
  } catch (error) {
    throw error;
  }
  const tasks = await Promise.all(names.filter((name) => /^task-[A-Za-z0-9][A-Za-z0-9_-]{0,127}\.json$/.test(name)).sort().map(async (name) => {
    const task = JSON.parse(await readFile(await workspaceFile(workspace, name), "utf8")) as TaskCharter;
    assertSafeTaskId(task.id);
    return task;
  }));
  return tasks;
}

export function taskPlan(state: TaskState): { state: TaskState; nextStates: TaskState[]; terminal: boolean } {
  const nextStates: Record<TaskState, TaskState[]> = {
    DRAFT: ["SCOPED", "CANCELLED"],
    SCOPED: ["DESIGNED", "CANCELLED"],
    DESIGNED: ["CANCELLED"],
    APPROVED_FOR_EXECUTION: ["CANCELLED"],
    RUNNING: ["CANCELLED"],
    REVIEWING: ["CANCELLED"],
    VERIFYING: ["CANCELLED"],
    AWAITING_APPROVAL: ["CANCELLED"],
    ARCHIVED: ["CANCELLED"],
    DONE: ["CANCELLED"],
    BLOCKED: ["CANCELLED"],
    REWORK: ["CANCELLED"],
    CANCELLED: []
  };
  return { state, nextStates: nextStates[state], terminal: state === "CANCELLED" };
}

function taskFileName(id: string): string { return `task-${id}.json`; }
async function taskFile(workspace: LocalWorkspace, id: string): Promise<string> { return workspaceFile(workspace, taskFileName(id)); }
function isNotFound(error: unknown): boolean { return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"; }
