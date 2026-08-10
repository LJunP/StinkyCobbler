import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { assertReadScope, authorize, denied, resolveReadablePath, type ToolAccess, type ToolOutcome } from "./shared.js";

export interface RepositoryFile { path: string; content: string; }
export interface RepositoryEntry { path: string; kind: "file" | "directory"; }

export async function readRepositoryFile(access: ToolAccess, path: string, maxBytes = 256 * 1024): Promise<ToolOutcome<RepositoryFile>> {
  const decision = authorize(access, "repository-read");
  if (!decision.allowed) return denied(decision);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1024 * 1024) throw new Error("maxBytes must be between 1 and 1048576.");

  const resolved = await resolveReadablePath(access.workspace, path);
  assertReadScope(access, resolved.relativePath);
  const info = await stat(resolved.absolutePath);
  if (!info.isFile()) throw new Error("Only regular files can be read.");
  if (info.size > maxBytes) throw new Error("File exceeds the maximum readable size.");
  return { decision, data: { path: resolved.relativePath, content: await readFile(resolved.absolutePath, "utf8") } };
}

export async function listRepositoryDirectory(access: ToolAccess, path = ".", maxEntries = 200): Promise<ToolOutcome<RepositoryEntry[]>> {
  const decision = authorize(access, "repository-read");
  if (!decision.allowed) return denied(decision);
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 1000) throw new Error("maxEntries must be between 1 and 1000.");

  const resolved = await resolveReadablePath(access.workspace, path === "." ? "./" : path);
  assertReadScope(access, resolved.relativePath);
  const info = await stat(resolved.absolutePath);
  if (!info.isDirectory()) throw new Error("Only directories can be listed.");
  const entries = await readdir(resolved.absolutePath, { withFileTypes: true });
  if (entries.length > maxEntries) throw new Error("Directory exceeds the maximum entry count.");
  return {
    decision,
    data: entries
      .filter((entry) => !entry.isSymbolicLink())
      .map((entry) => ({ path: join(resolved.relativePath, basename(entry.name)), kind: entry.isDirectory() ? "directory" as const : "file" as const }))
      .sort((left, right) => left.path.localeCompare(right.path))
  };
}
