import { join } from "node:path";
import { evaluateLease } from "../policy/evaluate.js";
import { containsShellMetacharacter } from "../policy/path-policy.js";
import { loadOrchestrationConfig } from "../config/tiered.js";
import { resolveWorkspacePath, workspacePathInScopes } from "../security/workspace-path.js";
import type { CapabilityLease, PolicyDecision } from "../contracts/types.js";

export interface ToolAccess {
  lease: CapabilityLease;
  taskId: string;
  role: string;
  workspace: string;
  toolCallsUsed?: number;
}

export interface ToolOutcome<T> {
  decision: PolicyDecision;
  data?: T;
}

export interface ResolvedWorkspacePath {
  workspace: string;
  absolutePath: string;
  relativePath: string;
  sensitiveExtraPaths?: string[];
}

export function authorize(access: ToolAccess, capability: string): PolicyDecision {
  return evaluateLease(access.lease, {
    taskId: access.taskId,
    role: access.role,
    workspace: access.workspace,
    capability,
    ...(access.toolCallsUsed === undefined ? {} : { toolCallsUsed: access.toolCallsUsed })
  });
}

export function denied<T>(decision: PolicyDecision): ToolOutcome<T> {
  return { decision };
}

export function allowed<T>(data: T): ToolOutcome<T> {
  return { decision: { allowed: true, code: "ALLOWED", reasons: [], policyVersion: "1" }, data };
}

export async function resolveReadablePath(workspace: string, requestedPath: string): Promise<ResolvedWorkspacePath> {
  if (!requestedPath || requestedPath.includes("\0")) throw new Error("A non-empty relative path is required.");
  if (containsShellMetacharacter(requestedPath)) throw new Error("Path contains forbidden characters.");
  const cfg = await loadOrchestrationConfig({ root: workspace, directory: join(workspace, ".stinky-cobbler") });
  const resolved = await resolveWorkspacePath(workspace, requestedPath, {
    ...(cfg.sensitiveExtraPaths === undefined ? {} : { sensitiveExtraPaths: cfg.sensitiveExtraPaths })
  });
  return {
    workspace: resolved.workspace,
    absolutePath: resolved.absolutePath,
    relativePath: resolved.relativePath,
    ...(cfg.sensitiveExtraPaths === undefined ? {} : { sensitiveExtraPaths: cfg.sensitiveExtraPaths })
  };
}

/** Enforces the lease's declared read scopes after canonical workspace resolution. */
export function assertReadScope(access: ToolAccess, relativePath: string): void {
  if (!workspacePathInScopes(access.lease.readScope, relativePath)) throw new Error("Requested path is outside the lease readScope.");
}

export function validateCommandArgument(value: string): void {
  if (!value || value.includes("\0") || containsShellMetacharacter(value)) throw new Error("Command arguments must be plain argv values without shell metacharacters.");
}
