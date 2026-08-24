import nodePath from "node:path";
import { assertReadScope, authorize, denied, resolveReadablePath, type ToolAccess, type ToolOutcome } from "./shared.js";
import {
  assertWorkspacePathPolicy,
  readBoundedWorkspaceFile,
  visitWorkspaceDirectory,
  WorkspaceReadBoundaryError
} from "../security/workspace-path.js";

export interface RepositoryFile { path: string; content: string; }
export interface RepositoryEntry { path: string; kind: "file" | "directory"; }

export async function readRepositoryFile(access: ToolAccess, path: string, maxBytes = 256 * 1024): Promise<ToolOutcome<RepositoryFile>> {
  const decision = authorize(access, "repository-read");
  if (!decision.allowed) return denied(decision);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1024 * 1024) throw new Error("maxBytes must be between 1 and 1048576.");

  const resolved = await resolveReadablePath(access.workspace, path);
  assertReadScope(access, resolved.relativePath);
  const file = await readBoundedWorkspaceFile(resolved.workspace, resolved.relativePath, maxBytes);
  return { decision, data: { path: resolved.relativePath, content: file.bytes.toString("utf8") } };
}

export async function listRepositoryDirectory(access: ToolAccess, path = ".", maxEntries = 200): Promise<ToolOutcome<RepositoryEntry[]>> {
  const decision = authorize(access, "repository-read");
  if (!decision.allowed) return denied(decision);
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 1000) throw new Error("maxEntries must be between 1 and 1000.");

  const resolved = await resolveReadablePath(access.workspace, path === "." ? "./" : path);
  assertReadScope(access, resolved.relativePath);
  const entries: RepositoryEntry[] = [];
  let observedEntries = 0;
  await visitWorkspaceDirectory(resolved.workspace, resolved.relativePath, (entry) => {
    observedEntries += 1;
    if (observedEntries > maxEntries) {
      throw new WorkspaceReadBoundaryError(
        "Directory exceeds the maximum entry count.",
        "entry-limit",
        observedEntries
      );
    }
    if (entry.isSymbolicLink()) return;
    // Workspace-relative paths are a platform-independent logical format.
    // Never feed native Windows separators back into the path policy.
    const entryPath = nodePath.posix.join(resolved.relativePath, entry.name);
    try {
      assertWorkspacePathPolicy(entryPath, {
        ...(resolved.sensitiveExtraPaths === undefined ? {} : { sensitiveExtraPaths: resolved.sensitiveExtraPaths })
      });
    } catch {
      return;
    }
    entries.push({ path: entryPath, kind: entry.isDirectory() ? "directory" : "file" });
  });
  return {
    decision,
    data: entries.sort((left, right) => left.path.localeCompare(right.path))
  };
}
