import path from "node:path";
import { StinkyCobblerError } from "../../errors.js";
import { containsShellMetacharacter, isSensitivePath } from "../policy/path-policy.js";
import {
  readBounded,
  resolveBounded,
  visitBounded,
  WorkspaceReadBoundaryError,
  type BoundedFile,
  type BoundedPath,
  type WorkspaceReadBoundaryReason
} from "../../io/fs-boundary.js";
import type { Dirent } from "node:fs";

export { WorkspaceReadBoundaryError, type WorkspaceReadBoundaryReason };

const RESERVED_DIRECTORIES = new Set([".git", ".stinky-cobbler"]);

export interface WorkspacePathOptions {
  /** Permit a missing leaf (and missing descendants of the first missing ancestor). */
  allowMissing?: boolean;
  /** Reject the control-plane and Git metadata directories. Defaults to true. */
  forbidReserved?: boolean;
  /** Workspace-local additions to the always-on common sensitive-name policy. */
  sensitiveExtraPaths?: string[];
  /** Optional lease scopes that must cover the requested path. */
  readScope?: string[];
}

export type SafeWorkspacePath = BoundedPath;

export interface WorkspaceFileReadHooks {
  /** Explicit dependency-injection seam for deterministic race regression tests. */
  afterOpen?: () => void | Promise<void>;
}

export type BoundedWorkspaceFile = BoundedFile;

/**
 * Policy facade over src/io/fs-boundary. Filesystem confinement lives in io.
 * These wrappers keep the historical Error messages: io reports PATH_DENIED,
 * and existing callers map a plain Error message into their own error codes.
 */
export async function resolveWorkspacePath(
  workspace: string,
  requestedPath: string,
  options: WorkspacePathOptions = {}
): Promise<SafeWorkspacePath> {
  const relativePath = normalizeWorkspaceRelativePath(requestedPath);
  assertWorkspacePathPolicy(relativePath, options);
  try {
    return await resolveBounded(workspace, relativePath, { allowMissing: options.allowMissing === true });
  } catch (error: unknown) {
    rethrowLegacy(error);
  }
}

export async function readBoundedWorkspaceFile(
  workspace: string,
  relativePath: string,
  maxBytes: number,
  hooks: WorkspaceFileReadHooks = {}
): Promise<BoundedWorkspaceFile> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes >= Number.MAX_SAFE_INTEGER) {
    throw new Error("maxBytes must be a positive safe integer below Number.MAX_SAFE_INTEGER.");
  }
  const normalized = normalizeWorkspaceRelativePath(relativePath);
  try {
    return await readBounded(workspace, normalized, { maxBytes, ...(hooks.afterOpen === undefined ? {} : { afterOpen: hooks.afterOpen }) });
  } catch (error: unknown) {
    rethrowLegacy(error);
  }
}

export async function visitWorkspaceDirectory(
  workspace: string,
  relativePath: string,
  visitor: (entry: Dirent) => void | Promise<void>
): Promise<void> {
  const normalized = normalizeWorkspaceRelativePath(relativePath);
  try {
    await visitBounded(workspace, normalized, visitor);
  } catch (error: unknown) {
    rethrowLegacy(error);
  }
}

/** Synchronous validation used before an intent is persisted or a lease is issued. */
export function assertWorkspacePathPolicy(relativePath: string, options: WorkspacePathOptions = {}): void {
  const normalized = normalizeWorkspaceRelativePath(relativePath);
  if (options.forbidReserved !== false && isReservedWorkspacePath(normalized)) {
    throw new Error("Git metadata and control-plane paths are not permitted.");
  }
  if (isSensitivePath(normalized, options.sensitiveExtraPaths)) {
    throw new Error("Sensitive workspace paths are not permitted.");
  }
  if (options.readScope !== undefined && !workspacePathInScopes(options.readScope, normalized)) {
    throw new Error("Requested path is outside the lease readScope.");
  }
}

export function normalizeWorkspaceRelativePath(value: string): string {
  if (!value || value.includes("\0") || value.includes("\\") || path.isAbsolute(value)) {
    throw new Error("A non-empty workspace-relative path is required.");
  }
  if (containsShellMetacharacter(value)) throw new Error("Path contains forbidden characters.");
  const rawParts = value.split("/");
  if (rawParts.includes("..")) throw new Error("Path escapes the workspace.");
  const normalized = path.posix.normalize(value).replace(/^\.\//, "");
  if (normalized === ".." || normalized.startsWith("../") || normalized.startsWith("/")) throw new Error("Path escapes the workspace.");
  return normalized === "" ? "." : normalized;
}

export function isReservedWorkspacePath(relativePath: string): boolean {
  return normalizeWorkspaceRelativePath(relativePath)
    .split("/")
    .some((part) => RESERVED_DIRECTORIES.has(part.toLocaleLowerCase("en-US")));
}

export function workspacePathInScopes(scopes: string[], requestedPath: string): boolean {
  const normalized = normalizeWorkspaceRelativePath(requestedPath);
  return scopes.some((scope) => {
    let allowed: string;
    try { allowed = normalizeWorkspaceRelativePath(scope); }
    catch { return false; }
    return allowed === "." || normalized === allowed || normalized.startsWith(`${allowed}/`);
  });
}

function rethrowLegacy(error: unknown): never {
  // io reports confinement failures as PATH_DENIED. Callers, and visitors
  // passed to visitWorkspaceDirectory, throw their own StinkyCobblerError
  // codes. Only the confinement code is translated back to a plain Error.
  if (error instanceof StinkyCobblerError && error.code === "PATH_DENIED") throw new Error(error.message);
  throw error;
}
