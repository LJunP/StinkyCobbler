import { lstat, mkdir, realpath, rename, rm, open, link, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { ExitCode, StinkyCobblerError } from "../errors.js";

export const WORKSPACE_DIRECTORY = ".stinky-cobbler";
export const WORKSPACE_CONFIG_FILE = "workspace.json";

export interface LocalWorkspace {
  /** Canonical, non-symlinked project directory chosen by the caller. */
  readonly root: string;
  /** The only directory this storage layer is permitted to write. */
  readonly directory: string;
}

/**
 * Creates the private Stinky Cobbler metadata directory for an existing project.
 * This module deliberately does not create or write business/project files.
 */
export async function initWorkspace(root: string): Promise<LocalWorkspace> {
  const requestedRoot = path.resolve(root);
  const canonicalRoot = await canonicalDirectory(requestedRoot, "WORKSPACE_ROOT_INVALID");
  const canonicalHome = await realpath(homedir()).catch(() => path.resolve(homedir()));
  if (canonicalRoot === path.parse(canonicalRoot).root || canonicalRoot === canonicalHome) {
    throw pathDenied("Workspace root cannot be the filesystem root or home directory.", { root: requestedRoot });
  }
  const workspace: LocalWorkspace = { root: canonicalRoot, directory: path.join(canonicalRoot, WORKSPACE_DIRECTORY) };
  await assertNoSymlinkIfPresent(workspace.directory);
  await mkdir(workspace.directory, { recursive: false, mode: 0o700 }).catch((error: unknown) => {
    if (isAlreadyExists(error)) return;
    throw error;
  });
  await assertDirectoryInsideRoot(workspace);
  return workspace;
}

/** Opens an initialized workspace without creating any paths. */
export async function openWorkspace(root: string): Promise<LocalWorkspace> {
  const requestedRoot = path.resolve(root);
  const canonicalRoot = await canonicalDirectory(requestedRoot, "WORKSPACE_ROOT_INVALID");
  const canonicalHome = await realpath(homedir()).catch(() => path.resolve(homedir()));
  if (canonicalRoot === path.parse(canonicalRoot).root || canonicalRoot === canonicalHome) {
    throw pathDenied("Workspace root cannot be the filesystem root or home directory.", { root: requestedRoot });
  }

  const directory = path.join(canonicalRoot, WORKSPACE_DIRECTORY);
  await assertNoSymlinkIfPresent(directory);
  return { root: canonicalRoot, directory };
}

/** Resolve a named metadata file while guaranteeing it remains in .stinky-cobbler. */
export async function workspaceFile(workspace: LocalWorkspace, name: string): Promise<string> {
  if (!name || path.isAbsolute(name) || name.includes("\0") || name.split(path.sep).some((part) => part === "" || part === "." || part === "..")) {
    throw pathDenied("Workspace metadata filename is invalid.", { name });
  }
  const target = path.resolve(workspace.directory, name);
  if (!target.startsWith(`${workspace.directory}${path.sep}`)) {
    throw pathDenied("Workspace metadata path escapes .stinky-cobbler.", { name });
  }
  await assertDirectoryInsideRoot(workspace);
  let current = workspace.directory;
  for (const part of name.split(path.sep)) {
    current = path.join(current, part);
    await assertNoSymlinkIfPresent(current);
  }
  return target;
}

export async function writeWorkspaceJson(workspace: LocalWorkspace, name: string, value: unknown): Promise<void> {
  const target = await workspaceFile(workspace, name);
  const temporary = await workspaceFile(workspace, `${name}.${randomUUID()}.tmp`);
  try {
    await durableWrite(temporary, `${JSON.stringify(value, null, 2)}\n`, "wx");
    await rename(temporary, target);
    await syncDirectory(path.dirname(target));
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

/** Creates a new JSON metadata record and refuses to overwrite an existing file. */
export async function createWorkspaceJson(workspace: LocalWorkspace, name: string, value: unknown): Promise<void> {
  const target = await workspaceFile(workspace, name);
  const temporary = await workspaceFile(workspace, `${name}.${randomUUID()}.tmp`);
  try {
    await durableWrite(temporary, `${JSON.stringify(value, null, 2)}\n`, "wx");
    try {
      await link(temporary, target);
      await unlink(temporary);
      await syncDirectory(path.dirname(target));
    } catch (error: unknown) {
      if (isAlreadyExists(error)) throw error;
      throw error;
    }
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function durableWrite(file: string, contents: string, flag: "wx" | "w"): Promise<void> {
  const handle = await open(file, flag, 0o600);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try { await handle.sync(); }
  finally { await handle.close(); }
}

/** Creates a control-plane subdirectory after containment and symlink checks. */
export async function createWorkspaceDirectory(workspace: LocalWorkspace, name: string): Promise<string> {
  const target = await workspaceFile(workspace, name);
  const created = await mkdir(target, { recursive: false, mode: 0o700 }).then(() => true).catch((error: unknown) => {
    if (isAlreadyExists(error)) return false;
    throw error;
  });
  if (created) await syncDirectory(path.dirname(target));
  return target;
}

async function assertDirectoryInsideRoot(workspace: LocalWorkspace): Promise<void> {
  const metadata = await canonicalDirectory(workspace.directory, "WORKSPACE_DIRECTORY_INVALID");
  if (metadata !== path.join(workspace.root, WORKSPACE_DIRECTORY)) {
    throw pathDenied("Workspace metadata directory resolves outside the workspace root.", {
      root: workspace.root,
      directory: workspace.directory,
      resolved: metadata
    });
  }
}

async function canonicalDirectory(directory: string, code: string): Promise<string> {
  let stat;
  try {
    stat = await lstat(directory);
  } catch (error: unknown) {
    throw new StinkyCobblerError(code, ExitCode.PATH_DENIED, "Workspace directory must already exist.", { directory, cause: errorMessage(error) });
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw pathDenied("Workspace root must be a real directory, not a symbolic link.", { directory });
  }
  return realpath(directory);
}

async function assertNoSymlinkIfPresent(target: string): Promise<void> {
  try {
    const stat = await lstat(target);
    if (stat.isSymbolicLink()) throw pathDenied("Symbolic links are not permitted in workspace storage.", { target });
  } catch (error: unknown) {
    if (isNotFound(error)) return;
    throw error;
  }
}

function pathDenied(message: string, details: Record<string, unknown>): StinkyCobblerError {
  return new StinkyCobblerError("PATH_DENIED", ExitCode.PATH_DENIED, message, details);
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
