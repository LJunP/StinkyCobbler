import { constants, type BigIntStats, type Dirent, type Stats } from "node:fs";
import { lstat, open, opendir, realpath, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { containsShellMetacharacter, isSensitivePath } from "../policy/path-policy.js";

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

export interface SafeWorkspacePath {
  workspace: string;
  absolutePath: string;
  relativePath: string;
  exists: boolean;
  stat?: Stats;
}

export type WorkspaceReadBoundaryReason =
  | "changed"
  | "entry-limit"
  | "hard-link"
  | "not-directory"
  | "not-file"
  | "size-limit"
  | "symbolic-link";

export class WorkspaceReadBoundaryError extends Error {
  constructor(
    message: string,
    readonly reason: WorkspaceReadBoundaryReason,
    readonly observed?: number
  ) {
    super(message);
    this.name = "WorkspaceReadBoundaryError";
  }
}

export interface WorkspaceFileReadHooks {
  /** Explicit dependency-injection seam for deterministic race regression tests. */
  afterOpen?: () => void | Promise<void>;
}

export interface BoundedWorkspaceFile {
  bytes: Buffer;
  /** The bytes actually read from the descriptor, not the earlier stat size. */
  size: number;
}

interface WorkspacePathComponent {
  absolutePath: string;
  dev: bigint;
  ino: bigint;
  ctimeNs: bigint;
  mtimeNs: bigint;
  kind: "directory" | "file" | "other";
}

const READ_CHUNK_BYTES = 64 * 1024;

/**
 * Canonicalizes one workspace-relative path and rejects traversal, reserved
 * control directories, sensitive names, and every existing
 * symbolic-link component. Missing paths are allowed only when explicitly
 * requested, which is required for create targets and historical Git paths.
 */
export async function resolveWorkspacePath(
  workspace: string,
  requestedPath: string,
  options: WorkspacePathOptions = {}
): Promise<SafeWorkspacePath> {
  const relativePath = normalizeWorkspaceRelativePath(requestedPath);
  assertWorkspacePathPolicy(relativePath, options);

  const requestedWorkspace = path.resolve(workspace);
  const rootStat = await lstat(requestedWorkspace);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error("Workspace root must be a real directory.");
  const workspaceReal = await realpath(requestedWorkspace);

  const absolutePath = path.resolve(workspaceReal, relativePath);
  const boundary = path.relative(workspaceReal, absolutePath);
  if (boundary === ".." || boundary.startsWith(`..${path.sep}`) || path.isAbsolute(boundary)) {
    throw new Error("Path escapes the workspace.");
  }

  let current = workspaceReal;
  let finalStat: Stats | undefined;
  let missing = false;
  const parts = relativePath === "." ? [] : relativePath.split("/");
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part === undefined) continue;
    current = path.join(current, part);
    let info: Stats;
    try {
      info = await lstat(current);
    } catch (error: unknown) {
      if (isCode(error, "ENOENT") && options.allowMissing === true) {
        missing = true;
        break;
      }
      throw error;
    }
    if (info.isSymbolicLink()) throw new Error("Symbolic links are not permitted in workspace paths.");
    const isLeaf = index === parts.length - 1;
    if (!isLeaf && !info.isDirectory()) throw new Error("A workspace path ancestor is not a directory.");
    if (isLeaf) finalStat = info;
  }

  return {
    workspace: workspaceReal,
    absolutePath,
    relativePath,
    exists: !missing,
    ...(finalStat === undefined ? {} : { stat: finalStat })
  };
}

/**
 * Reads at most maxBytes + 1 bytes from a descriptor opened on the validated
 * leaf. Every path component is lstat'ed immediately before and after open and
 * once more before return, so a persistent ancestor or leaf replacement fails
 * closed. O_NOFOLLOW protects the leaf during open where the host exposes it.
 *
 * Node does not expose openat/openat2-style descriptor-relative traversal for
 * every ancestor. An ancestor that is swapped and restored entirely between
 * lstat samples therefore remains a residual race; callers must not describe
 * this helper as an atomic filesystem sandbox.
 */
export async function readBoundedWorkspaceFile(
  workspace: string,
  relativePath: string,
  maxBytes: number,
  hooks: WorkspaceFileReadHooks = {}
): Promise<BoundedWorkspaceFile> {
  assertPositiveSafeInteger(maxBytes, "maxBytes");
  const normalized = normalizeWorkspaceRelativePath(relativePath);
  const before = await inspectWorkspacePathComponents(workspace, normalized, "file");
  const absolutePath = workspaceAbsolutePath(workspace, normalized);
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const nonBlock = typeof constants.O_NONBLOCK === "number" ? constants.O_NONBLOCK : 0;
  const handle = await open(absolutePath, constants.O_RDONLY | noFollow | nonBlock);
  try {
    const opened = await handle.stat({ bigint: true });
    assertOpenedPrivateFile(before, opened);
    await hooks.afterOpen?.();
    await assertWorkspacePathComponentsUnchanged(workspace, normalized, before, "file");

    if (opened.size > BigInt(maxBytes)) throw sizeLimitExceeded(maxBytes);
    const bytes = await readFileHandleBounded(handle, maxBytes);
    const finished = await handle.stat({ bigint: true });
    assertSameIdentity(opened, finished, "File identity changed while reading.");
    if (!finished.isFile()) throw boundary("Opened workspace path is no longer a regular file.", "not-file");
    if (finished.nlink !== 1n) throw boundary("Hard-linked files are not readable through a path-scoped Lease.", "hard-link");
    if (finished.size > BigInt(maxBytes)) throw sizeLimitExceeded(maxBytes);
    if (
      finished.size !== opened.size
      || finished.size !== BigInt(bytes.byteLength)
      || finished.ctimeNs !== opened.ctimeNs
      || finished.mtimeNs !== opened.mtimeNs
    ) {
      throw boundary("File changed while reading.", "changed");
    }
    await assertWorkspacePathComponentsUnchanged(workspace, normalized, before, "file");
    return { bytes, size: bytes.byteLength };
  } finally {
    await handle.close();
  }
}

/**
 * Streams a directory one Dirent at a time while checking every no-follow path
 * component around opendir and again before returning. The caller owns any
 * local or recursive entry budget and can reject exactly on limit + 1. Node
 * exposes no descriptor-relative ancestor walk here either, so the documented
 * swap-and-restore residual still applies.
 */
export async function visitWorkspaceDirectory(
  workspace: string,
  relativePath: string,
  visitor: (entry: Dirent) => void | Promise<void>
): Promise<void> {
  const normalized = normalizeWorkspaceRelativePath(relativePath);
  const before = await inspectWorkspacePathComponents(workspace, normalized, "directory");
  const directory = await opendir(workspaceAbsolutePath(workspace, normalized));
  try {
    await assertWorkspacePathComponentsUnchanged(workspace, normalized, before, "directory");
    while (true) {
      const entry = await directory.read();
      if (entry === null) break;
      await visitor(entry);
    }
    await assertWorkspacePathComponentsUnchanged(workspace, normalized, before, "directory");
  } finally {
    await closeDirectory(directory);
  }
}

async function readFileHandleBounded(handle: FileHandle, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  while (total <= maxBytes) {
    const remaining = maxBytes + 1 - total;
    const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, remaining));
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, total);
    if (bytesRead === 0) break;
    chunks.push(buffer.subarray(0, bytesRead));
    total += bytesRead;
  }
  if (total > maxBytes) throw sizeLimitExceeded(maxBytes, total);
  return Buffer.concat(chunks, total);
}

async function inspectWorkspacePathComponents(
  workspace: string,
  relativePath: string,
  expectedLeaf: "directory" | "file"
): Promise<WorkspacePathComponent[]> {
  const normalized = normalizeWorkspaceRelativePath(relativePath);
  const absoluteWorkspace = path.resolve(workspace);
  const parts = normalized === "." ? [] : normalized.split("/");
  const components: WorkspacePathComponent[] = [];
  let current = absoluteWorkspace;

  for (let index = 0; index <= parts.length; index += 1) {
    if (index > 0) current = path.join(current, parts[index - 1]!);
    const info = await lstat(current, { bigint: true });
    if (info.isSymbolicLink()) throw boundary("Symbolic links are not permitted in workspace paths.", "symbolic-link");
    const leaf = index === parts.length;
    if (!leaf && !info.isDirectory()) throw boundary("A workspace path ancestor is not a directory.", "not-directory");
    if (leaf && expectedLeaf === "directory" && !info.isDirectory()) {
      throw boundary("Only directories can be listed.", "not-directory");
    }
    if (leaf && expectedLeaf === "file" && !info.isFile()) {
      throw boundary("Only regular files can be read.", "not-file");
    }
    components.push({
      absolutePath: current,
      dev: info.dev,
      ino: info.ino,
      ctimeNs: info.ctimeNs,
      mtimeNs: info.mtimeNs,
      kind: statKind(info)
    });
  }
  return components;
}

async function assertWorkspacePathComponentsUnchanged(
  workspace: string,
  relativePath: string,
  expected: WorkspacePathComponent[],
  expectedLeaf: "directory" | "file"
): Promise<void> {
  let actual: WorkspacePathComponent[];
  try {
    actual = await inspectWorkspacePathComponents(workspace, relativePath, expectedLeaf);
  } catch (error: unknown) {
    if (error instanceof WorkspaceReadBoundaryError) {
      throw boundary("Workspace path changed while establishing the read boundary.", "changed");
    }
    throw error;
  }
  if (actual.length !== expected.length) throw boundary("Workspace path changed while establishing the read boundary.", "changed");
  for (let index = 0; index < expected.length; index += 1) {
    const left = expected[index]!;
    const right = actual[index]!;
    const compareDirectoryMetadata = index < expected.length - 1 || expectedLeaf === "directory";
    if (
      left.absolutePath !== right.absolutePath
      || left.dev !== right.dev
      || left.ino !== right.ino
      || left.kind !== right.kind
      || (compareDirectoryMetadata && (left.ctimeNs !== right.ctimeNs || left.mtimeNs !== right.mtimeNs))
    ) {
      throw boundary("Workspace path changed while establishing the read boundary.", "changed");
    }
  }
}

function assertOpenedPrivateFile(components: WorkspacePathComponent[], opened: BigIntStats): void {
  const leaf = components.at(-1);
  if (leaf === undefined) throw boundary("Workspace file identity is unavailable.", "changed");
  if (leaf.dev !== opened.dev || leaf.ino !== opened.ino) {
    throw boundary("File changed while establishing the read boundary.", "changed");
  }
  if (!opened.isFile()) throw boundary("Only regular files can be read.", "not-file");
  if (opened.nlink !== 1n) throw boundary("Hard-linked files are not readable through a path-scoped Lease.", "hard-link");
}

function assertSameIdentity(left: BigIntStats, right: BigIntStats, message: string): void {
  if (left.dev !== right.dev || left.ino !== right.ino) throw boundary(message, "changed");
}

function statKind(info: BigIntStats): WorkspacePathComponent["kind"] {
  if (info.isDirectory()) return "directory";
  if (info.isFile()) return "file";
  return "other";
}

function workspaceAbsolutePath(workspace: string, relativePath: string): string {
  const absoluteWorkspace = path.resolve(workspace);
  const absolutePath = path.resolve(absoluteWorkspace, relativePath);
  const boundaryPath = path.relative(absoluteWorkspace, absolutePath);
  if (boundaryPath === ".." || boundaryPath.startsWith(`..${path.sep}`) || path.isAbsolute(boundaryPath)) {
    throw new Error("Path escapes the workspace.");
  }
  return absolutePath;
}

async function closeDirectory(directory: { close(): Promise<void> }): Promise<void> {
  try {
    await directory.close();
  } catch (error: unknown) {
    if (!isCode(error, "ERR_DIR_CLOSED")) throw error;
  }
}

function assertPositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1 || value >= Number.MAX_SAFE_INTEGER) {
    throw new Error(`${name} must be a positive safe integer below Number.MAX_SAFE_INTEGER.`);
  }
}

function boundary(message: string, reason: WorkspaceReadBoundaryReason, observed?: number): WorkspaceReadBoundaryError {
  return observed === undefined
    ? new WorkspaceReadBoundaryError(message, reason)
    : new WorkspaceReadBoundaryError(message, reason, observed);
}

function sizeLimitExceeded(maxBytes: number, observed = maxBytes + 1): WorkspaceReadBoundaryError {
  return boundary("File exceeds the maximum readable size.", "size-limit", observed);
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

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
