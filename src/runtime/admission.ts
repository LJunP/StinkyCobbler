import type { CapabilityLease, RoleRegistry, TaskCapsule, TaskCharter } from "../contracts/types.js";
import { evaluateLease } from "../policy/evaluate.js";
import { SchemaRegistry } from "../contracts/schema-registry.js";
import { ExitCode, StinkyCobblerError } from "../errors.js";
import { openWorkspace, type LocalWorkspace } from "../storage/workspace.js";
import { getTask } from "../storage/tasks.js";
import { getLease } from "../storage/leases.js";
import { evaluateLeaseSubtaskBinding } from "../storage/lease-usage.js";
import { normalizeWorkspaceRelativePath, workspacePathInScopes } from "../security/workspace-path.js";
import { admitPersistedLeaseAuthority } from "../storage/task-authority.js";

export const READONLY_RUNTIME_TOOLS = new Set(["repository-read", "repository-list"]);

export interface RuntimeAdmission {
  workspace: LocalWorkspace;
  task: TaskCharter;
  capsule: TaskCapsule;
  lease: CapabilityLease & { policyVersion: string };
  /** Read authority after intersecting the persisted Lease and Capsule bounds. */
  effectiveReadScope: string[];
}

export async function admitReadonlyRuntime(input: {
  root: string;
  task: unknown;
  capsule: unknown;
  lease: unknown;
  schemas: SchemaRegistry;
  roles: RoleRegistry;
  roleTools: Record<string, string[]>;
}): Promise<RuntimeAdmission> {
  const workspace = await openWorkspace(input.root);
  input.schemas.validate("task", input.task);
  input.schemas.validate("capsule", input.capsule);
  input.schemas.validate("lease", input.lease);
  const task = input.task as TaskCharter;
  const capsule = input.capsule as TaskCapsule;
  const submittedLease = input.lease as CapabilityLease;
  if (capsule.leaseId !== submittedLease.id) deny("RUNTIME_LEASE_MISMATCH", "Capsule and submitted lease references do not match.");

  if (task.state !== "SCOPED" && task.state !== "DESIGNED" && task.state !== "VERIFYING") deny("RUNTIME_TASK_STATE", "Readonly runtime requires a SCOPED, DESIGNED, or VERIFYING task.");
  await assertPersistedTaskAuthority(workspace, task);
  let lease: CapabilityLease;
  try {
    lease = await getLease(workspace, submittedLease.id);
    if (lease.id !== submittedLease.id) {
      deny("RUNTIME_LEASE_INVALID", "The persisted lease ID does not match its canonical lookup ID.", { leaseId: submittedLease.id, storedLeaseId: lease.id });
    }
    input.schemas.validate("lease", lease);
  } catch (error: unknown) {
    if (error instanceof StinkyCobblerError && error.code === "LEASE_NOT_FOUND") {
      deny("RUNTIME_LEASE_NOT_PERSISTED", "The capability lease must be issued and persisted in this workspace before Runtime admission.", { leaseId: submittedLease.id });
    }
    if (error instanceof StinkyCobblerError && (error.code === "LEASE_INVALID" || error.code === "SCHEMA_INVALID")) {
      deny("RUNTIME_LEASE_INVALID", "The persisted capability lease is invalid.", { leaseId: submittedLease.id, ...error.details });
    }
    throw error;
  }

  await admitPersistedLeaseAuthority(workspace, lease, [lease.capability]);

  if (task.workspaceId !== capsule.workspaceId) deny("RUNTIME_WORKSPACE_MISMATCH", "Task and capsule workspace IDs do not match.");
  if (task.workspaceId.length === 0) deny("RUNTIME_WORKSPACE_MISMATCH", "Task workspace ID is required.");
  if (task.id !== capsule.taskId || task.id !== lease.taskId) deny("RUNTIME_TASK_MISMATCH", "Task, capsule, and lease task IDs do not match.");
  if (capsule.role !== lease.role || capsule.leaseId !== lease.id) deny("RUNTIME_LEASE_MISMATCH", "Capsule and lease bindings do not match.");
  if (capsule.agentId !== lease.agentId) deny("RUNTIME_AGENT_MISMATCH", "Capsule and lease agent IDs do not match.");
  if (typeof lease.policyVersion !== "string" || capsule.policyVersion !== lease.policyVersion) {
    deny("RUNTIME_POLICY_VERSION_MISMATCH", "Capsule policyVersion must exactly match the authoritative persisted Lease policyVersion.", {
      capsulePolicyVersion: capsule.policyVersion,
      leasePolicyVersion: lease.policyVersion
    });
  }
  const authoritativeLease = lease as CapabilityLease & { policyVersion: string };
  if (capsule.writeSet.length !== 0) deny("RUNTIME_WRITE_DENIED", "Readonly runtime requires an empty writeSet.");
  if (capsule.allowedTools.some((tool) => !READONLY_RUNTIME_TOOLS.has(tool))) deny("RUNTIME_TOOL_NOT_ALLOWED", "Capsule requests a capability outside the readonly runtime allowlist.");
  if ([...capsule.scope, ...capsule.readScope].some((scope) => scope === ".stinky-cobbler" || scope.startsWith(".stinky-cobbler/"))) deny("RUNTIME_CONTROL_PLANE_DENIED", "Readonly agents cannot read the control-plane metadata directory.");
  const role = input.roles.roles[capsule.role];
  if (role === undefined) deny("RUNTIME_ROLE_UNKNOWN", "Readonly runtime requires a role from the persisted role registry.", { role: capsule.role });
  if (role.canWrite) deny("RUNTIME_ROLE_WRITE_DENIED", "Writable roles are not allowed in the readonly runtime.");
  const permittedRoleTools = input.roleTools[capsule.role];
  if (!Array.isArray(permittedRoleTools)) deny("RUNTIME_ROLE_TOOLS_UNAVAILABLE", "Readonly runtime requires an explicit role-to-tools policy entry.", { role: capsule.role });
  for (const tool of capsule.allowedTools) {
    if (!permittedRoleTools.includes(tool)) deny("RUNTIME_ROLE_TOOL_DENIED", "The role-to-tools policy does not grant a requested Runtime tool.", { role: capsule.role, tool });
  }
  if (lease.level !== "L0" || lease.writeSet.length !== 0) deny("RUNTIME_LEASE_LEVEL_DENIED", "Readonly runtime requires an active L0 lease with an empty writeSet.");
  for (const tool of capsule.allowedTools) if (!leaseCoversTool(lease.capability, tool)) deny("RUNTIME_CAPABILITY_MISMATCH", "Lease capability does not cover all capsule tools.");
  const decision = evaluateLease(lease, { taskId: task.id, role: capsule.role, workspace: workspace.root, capability: lease.capability });
  if (!decision.allowed) deny(decision.code, decision.reasons[0] ?? "Lease denied.");
  const subtaskDecision = await evaluateLeaseSubtaskBinding(workspace, lease);
  if (!subtaskDecision.allowed) deny(subtaskDecision.code, subtaskDecision.reasons[0] ?? "Lease subtask binding denied.");
  if (Date.parse(capsule.issuedAt) > Date.now() || Date.parse(capsule.expiresAt) <= Date.now()) deny("CAPSULE_EXPIRED", "Task capsule is not currently valid.");
  if (Date.parse(lease.issuedAt) > Date.now() || Date.parse(lease.expiresAt) <= Date.now()) deny("LEASE_EXPIRED", "Capability lease is not currently valid.");
  if (Date.parse(capsule.expiresAt) > Date.parse(lease.expiresAt)) deny("RUNTIME_EXPIRY_MISMATCH", "Task capsule cannot outlive its capability lease.");
  if (capsule.budget.maxToolCalls !== undefined && capsule.budget.maxToolCalls > lease.maxToolCalls) deny("RUNTIME_BUDGET_EXCEEDS_LEASE", "Runtime tool-call budget cannot exceed the lease limit.");
  if (capsule.scope.some((scope) => !scopeCovered(lease.readScope, scope)) || capsule.readScope.some((scope) => !scopeCovered(lease.readScope, scope))) deny("RUNTIME_SCOPE_MISMATCH", "Capsule scope must be covered by the lease readScope.");
  if (Date.parse(capsule.issuedAt) > Date.parse(capsule.expiresAt)) deny("RUNTIME_EXPIRY_INVALID", "Capsule issuedAt must precede expiresAt.");
  if (Date.parse(lease.issuedAt) > Date.parse(lease.expiresAt)) deny("RUNTIME_EXPIRY_INVALID", "Lease issuedAt must precede expiresAt.");

  if (capsule.budget.maxToolCalls !== undefined && capsule.budget.maxToolCalls < 1) deny("RUNTIME_BUDGET_INVALID", "Runtime budget is invalid.");
  let effectiveReadScope: string[];
  try {
    effectiveReadScope = intersectScopeSets(lease.readScope, capsule.scope, capsule.readScope);
  } catch {
    deny("RUNTIME_SCOPE_INVALID", "Runtime Lease and Capsule scopes must be canonical workspace-relative paths.");
  }
  return { workspace, task, capsule, lease: authoritativeLease, effectiveReadScope };
}

function intersectScopeSets(...sets: string[][]): string[] {
  if (sets.length === 0) return [];
  let current = compactScopes(sets[0] ?? []);
  for (const set of sets.slice(1)) {
    const next = compactScopes(set);
    const intersections: string[] = [];
    for (const left of current) {
      for (const right of next) {
        if (scopeCovers(left, right)) intersections.push(right);
        else if (scopeCovers(right, left)) intersections.push(left);
      }
    }
    current = compactScopes(intersections);
  }
  return current;
}

function compactScopes(scopes: string[]): string[] {
  const normalized = [...new Set(scopes.map(normalizeScope))].sort((left, right) => left.length - right.length || left.localeCompare(right));
  return normalized.filter((scope, index) => !normalized.slice(0, index).some((parent) => scopeCovers(parent, scope)));
}

function normalizeScope(scope: string): string {
  return normalizeWorkspaceRelativePath(scope);
}

function scopeCovers(allowed: string, requested: string): boolean {
  return allowed === "." || requested === allowed || requested.startsWith(`${allowed}/`);
}

function scopeCovered(readScope: string[], requested: string): boolean {
  try { return workspacePathInScopes(readScope, requested); }
  catch { return false; }
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
