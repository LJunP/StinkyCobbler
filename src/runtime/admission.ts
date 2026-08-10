import type { CapabilityLease, RoleRegistry, TaskCapsule, TaskCharter } from "../contracts/types.js";
import { evaluateLease, isLeaseExpiredBeyondGrace } from "../policy/evaluate.js";
import { SchemaRegistry } from "../contracts/schema-registry.js";
import { ExitCode, StinkyCobblerError } from "../errors.js";
import { openWorkspace, type LocalWorkspace } from "../storage/workspace.js";
import { getTask } from "../storage/tasks.js";

export const READONLY_RUNTIME_TOOLS = new Set(["repository-read", "repository-list"]);

export interface RuntimeAdmission {
  workspace: LocalWorkspace;
  task: TaskCharter;
  capsule: TaskCapsule;
  lease: CapabilityLease;
}

export async function admitReadonlyRuntime(input: {
  root: string;
  task: unknown;
  capsule: unknown;
  lease: unknown;
  schemas: SchemaRegistry;
  roles: RoleRegistry;
}): Promise<RuntimeAdmission> {
  const workspace = await openWorkspace(input.root);
  input.schemas.validate("task", input.task);
  input.schemas.validate("capsule", input.capsule);
  input.schemas.validate("lease", input.lease);
  const task = input.task as TaskCharter;
  const capsule = input.capsule as TaskCapsule;
  const lease = input.lease as CapabilityLease;

  if (task.state !== "SCOPED" && task.state !== "DESIGNED") deny("RUNTIME_TASK_STATE", "Readonly runtime requires a SCOPED or DESIGNED task.");
  await assertPersistedTaskAuthority(workspace, task);
  if (task.workspaceId !== capsule.workspaceId) deny("RUNTIME_WORKSPACE_MISMATCH", "Task and capsule workspace IDs do not match.");
  if (task.workspaceId.length === 0) deny("RUNTIME_WORKSPACE_MISMATCH", "Task workspace ID is required.");
  if (task.id !== capsule.taskId || task.id !== lease.taskId) deny("RUNTIME_TASK_MISMATCH", "Task, capsule, and lease task IDs do not match.");
  if (capsule.role !== lease.role || capsule.leaseId !== lease.id) deny("RUNTIME_LEASE_MISMATCH", "Capsule and lease bindings do not match.");
  if (capsule.agentId !== lease.agentId) deny("RUNTIME_AGENT_MISMATCH", "Capsule and lease agent IDs do not match.");
  if (capsule.writeSet.length !== 0) deny("RUNTIME_WRITE_DENIED", "Readonly runtime requires an empty writeSet.");
  if (capsule.allowedTools.some((tool) => !READONLY_RUNTIME_TOOLS.has(tool))) deny("RUNTIME_TOOL_NOT_ALLOWED", "Capsule requests a capability outside the readonly runtime allowlist.");
  if ([...capsule.scope, ...capsule.readScope].some((scope) => scope === ".stinky-cobbler" || scope.startsWith(".stinky-cobbler/"))) deny("RUNTIME_CONTROL_PLANE_DENIED", "Readonly agents cannot read the control-plane metadata directory.");
  if (capsule.role === "builder" || capsule.role === "scribe" || input.roles.roles[capsule.role]?.canWrite) deny("RUNTIME_ROLE_WRITE_DENIED", "This role is not allowed in the readonly runtime.");
  if (lease.level !== "L0" || lease.writeSet.length !== 0) deny("RUNTIME_LEASE_LEVEL_DENIED", "Readonly runtime requires an active L0 lease with an empty writeSet.");
  for (const tool of capsule.allowedTools) if (!leaseCoversTool(lease.capability, tool)) deny("RUNTIME_CAPABILITY_MISMATCH", "Lease capability does not cover all capsule tools.");
  const decision = evaluateLease(lease, { taskId: task.id, role: capsule.role, workspace: workspace.root, capability: lease.capability });
  if (!decision.allowed) deny(decision.code, decision.reasons[0] ?? "Lease denied.");
  if (Date.parse(capsule.issuedAt) > Date.now() || Date.parse(capsule.expiresAt) <= Date.now()) deny("CAPSULE_EXPIRED", "Task capsule is not currently valid.");
  if (Date.parse(lease.issuedAt) > Date.now() || isLeaseExpiredBeyondGrace(lease.expiresAt)) deny("LEASE_EXPIRED", "Capability lease is not currently valid.");
  if (Date.parse(capsule.expiresAt) > Date.parse(lease.expiresAt)) deny("RUNTIME_EXPIRY_MISMATCH", "Task capsule cannot outlive its capability lease.");
  if (capsule.budget.maxToolCalls !== undefined && capsule.budget.maxToolCalls > lease.maxToolCalls) deny("RUNTIME_BUDGET_EXCEEDS_LEASE", "Runtime tool-call budget cannot exceed the lease limit.");
  if (capsule.scope.some((scope) => !scopeCovered(lease.readScope, scope)) || capsule.readScope.some((scope) => !scopeCovered(lease.readScope, scope))) deny("RUNTIME_SCOPE_MISMATCH", "Capsule scope must be covered by the lease readScope.");
  if (Date.parse(capsule.issuedAt) > Date.parse(capsule.expiresAt)) deny("RUNTIME_EXPIRY_INVALID", "Capsule issuedAt must precede expiresAt.");
  if (Date.parse(lease.issuedAt) > Date.parse(lease.expiresAt)) deny("RUNTIME_EXPIRY_INVALID", "Lease issuedAt must precede expiresAt.");

  if (capsule.budget.maxToolCalls !== undefined && capsule.budget.maxToolCalls < 1) deny("RUNTIME_BUDGET_INVALID", "Runtime budget is invalid.");
  return { workspace, task, capsule, lease };
}

function scopeCovered(readScope: string[], requested: string): boolean {
  const normalized = requested === "" ? "." : requested.replace(/[\\/]+$/, "");
  return readScope.some((scope) => {
    const allowed = scope === "" ? "." : scope.replace(/[\\/]+$/, "");
    return allowed === "." || normalized === allowed || normalized.startsWith(`${allowed}/`);
  });
}
function leaseCoversTool(capability: string, tool: string): boolean {
  return capability === "repository-read" && (tool === "repository-read" || tool === "repository-list");
}

/**
 * The persisted workspace Task is the authority for a Runtime admission. The
 * caller-supplied task must already exist in the workspace (created via
 * `task create`) and must match its authoritative copy; missing or diverging
 * tasks fail closed. The check never writes and never changes Task state.
 */
async function assertPersistedTaskAuthority(workspace: LocalWorkspace, task: TaskCharter): Promise<void> {
  let stored: TaskCharter;
  try {
    stored = await getTask(workspace, task.id);
  } catch (error: unknown) {
    if (error instanceof StinkyCobblerError && error.code === "TASK_NOT_FOUND") {
      deny("RUNTIME_TASK_NOT_PERSISTED", "The task must be persisted in the workspace with `task create` before Runtime admission.", { taskId: task.id });
    }
    throw error;
  }
  const field = firstDifference(stored, task);
  if (field !== undefined) {
    deny("RUNTIME_TASK_AUTHORITY_MISMATCH", "The submitted task does not match the persisted workspace task.", { taskId: task.id, field });
  }
}

/** Returns the first divergent field path (dot/array notation) or undefined when deeply equal. */
function firstDifference(left: unknown, right: unknown, path = ""): string | undefined {
  if (Object.is(left, right)) return undefined;
  if (typeof left !== typeof right) return path === "" ? "<root>" : path;
  if (left === null || right === null) return path === "" ? "<root>" : path;
  if (typeof left !== "object") return path === "" ? "<root>" : path;
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  if (Array.isArray(leftRecord) !== Array.isArray(rightRecord)) return path === "" ? "<root>" : path;
  if (Array.isArray(leftRecord)) {
    if (leftRecord.length !== rightRecord.length) return path === "" ? "<root>" : path;
    for (let index = 0; index < leftRecord.length; index += 1) {
      const child = `${path}[${index}]`;
      const difference = firstDifference(leftRecord[index], rightRecord[index], child);
      if (difference !== undefined) return difference;
    }
    return undefined;
  }
  const keys = [...new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)])].sort();
  for (const key of keys) {
    const child = path === "" ? key : `${path}.${key}`;
    const leftValue = leftRecord[key];
    const rightValue = rightRecord[key];
    if (Object.is(leftValue, rightValue)) continue;
    if (typeof leftValue === "object" && leftValue !== null && typeof rightValue === "object" && rightValue !== null) {
      const difference = firstDifference(leftValue, rightValue, child);
      if (difference !== undefined) return difference;
      continue;
    }
    return child;
  }
  return undefined;
}


function deny(code: string, message: string, details: Record<string, unknown> = {}): never {
  throw new StinkyCobblerError(code, ExitCode.POLICY_DENIED, message, details);
}
