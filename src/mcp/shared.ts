import { lstat, realpath } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { evaluateLease } from "../policy/evaluate.js";
import { containsShellMetacharacter, isSensitivePath } from "../policy/path-policy.js";
import { loadOrchestrationConfig } from "../config/tiered.js";
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

  const resolvedWorkspace = resolve(workspace);
  await assertNoSymlinks(resolvedWorkspace);
  const workspaceRealPath = await realpath(resolvedWorkspace);
  const candidate = resolve(workspaceRealPath, requestedPath);
  const relativePath = relative(workspaceRealPath, candidate);
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || resolve(workspaceRealPath, relativePath) !== candidate) {
    throw new Error("Path escapes the workspace.");
  }
  const cfg = await loadOrchestrationConfig({ root: workspaceRealPath, directory: join(workspaceRealPath, ".stinky-cobbler") });
  if (isSensitivePath(relativePath, cfg.sensitiveExtraPaths)) throw new Error("Sensitive files are not readable through local tools.");
  await assertNoSymlinks(candidate, workspaceRealPath);

  return { workspace: workspaceRealPath, absolutePath: candidate, relativePath };
}

/** Enforces the lease's declared read scopes after canonical workspace resolution. */
export function assertReadScope(access: ToolAccess, relativePath: string): void {
  if (access.lease.readScope.length === 0) throw new Error("Lease does not grant any readable path.");
  const normalized = relativePath === "" ? "." : relativePath;
  const allowed = access.lease.readScope.some((scope) => {
    if (!scope || scope.includes("\0") || scope.startsWith("/") || scope === ".." || scope.startsWith(`..${sep}`)) return false;
    const normalizedScope = scope === "." ? "." : scope.replace(/[\\/]+$/, "");
    return normalizedScope === "." || normalized === normalizedScope || normalized.startsWith(`${normalizedScope}${sep}`) || normalized.startsWith(`${normalizedScope}/`);
  });
  if (!allowed) throw new Error("Requested path is outside the lease readScope.");
}

export function validateCommandArgument(value: string): void {
  if (!value || value.includes("\0") || containsShellMetacharacter(value)) throw new Error("Command arguments must be plain argv values without shell metacharacters.");
}

async function assertNoSymlinks(target: string, boundary?: string): Promise<void> {
  const absoluteTarget = resolve(target);
  const absoluteBoundary = boundary ? resolve(boundary) : undefined;
  const start = absoluteBoundary ?? parseRoot(absoluteTarget);
  const relativeTarget = relative(start, absoluteTarget);
  if (relativeTarget === ".." || relativeTarget.startsWith(`..${sep}`)) throw new Error("Path escapes the workspace.");

  let current = start;
  if (absoluteBoundary) await assertNotSymlink(current);
  for (const part of relativeTarget.split(sep).filter(Boolean)) {
    current = resolve(current, part);
    await assertNotSymlink(current);
  }
}

async function assertNotSymlink(path: string): Promise<void> {
  const stat = await lstat(path);
  if (stat.isSymbolicLink()) throw new Error("Symbolic links are not permitted.");
}

function parseRoot(path: string): string {
  const root = resolve(path, "/");
  return root.slice(0, root.indexOf(sep, 1) + 1) || sep;
}
