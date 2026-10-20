import { constants, type BigIntStats, type Dirent, type Stats } from "node:fs";
import { lstat, open, opendir, realpath, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { assertInside, isCode, normalizeRelativePath, pathDenied } from "./path-lex.js";

export type WorkspaceReadBoundaryReason = "changed" | "entry-limit" | "hard-link" | "not-directory" | "not-file" | "size-limit" | "symbolic-link";

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

export interface BoundedPath {
  workspace: string;
  absolutePath: string;
  relativePath: string;
  exists: boolean;
  stat?: Stats;
}

export interface BoundedFile {
  bytes: Buffer;
  size: number;
}

export interface ReadBoundedOptions {
  maxBytes: number;
  afterOpen?: () => void | Promise<void>;
}

interface PathComponent {
  absolutePath: string;
  dev: bigint;
  ino: bigint;
  ctimeNs: bigint;
  mtimeNs: bigint;
  kind: "directory" | "file" | "other";
}

const READ_CHUNK_BYTES = 64 * 1024;

/** Resolves one relative path inside root, rejecting symlink components. */
export async function resolveBounded(root: string, relativePath: string, options: { allowMissing?: boolean } = {}): Promise<BoundedPath> {
  const relative = normalizeRelativePath(relativePath);
  const requestedRoot = path.resolve(root);
  const rootStat = await lstat(requestedRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw pathDenied("Workspace root must be a real directory.");
  const workspaceReal = await realpath(requestedRoot);
  const absolutePath = path.resolve(workspaceReal, relative);
  assertInside(workspaceReal, absolutePath);
  const walked = await walkExisting(workspaceReal, relative, options.allowMissing === true);
  return { workspace: workspaceReal, absolutePath, relativePath: relative, exists: walked.exists, ...(walked.stat === undefined ? {} : { stat: walked.stat }) };
}

/** Reads a regular file after re-checking every path component around the open. */
export async function readBounded(root: string, relativePath: string, options: ReadBoundedOptions): Promise<BoundedFile> {
  assertPositiveSafeInteger(options.maxBytes, "maxBytes");
  const normalized = normalizeRelativePath(relativePath);
  const before = await inspectComponents(root, normalized, "file");
  const noFollow = optionalFlag("O_NOFOLLOW");
  const nonBlock = optionalFlag("O_NONBLOCK");
  const handle = await open(workspaceAbsolutePath(root, normalized), constants.O_RDONLY | noFollow | nonBlock);
  try {
    return await readOpened(handle, root, normalized, before, options);
  } finally {
    await handle.close();
  }
}

/** Lists one directory. The caller applies entry budgets while visiting. */
export async function visitBounded(root: string, relativePath: string, visitor: (entry: Dirent) => void | Promise<void>): Promise<void> {
  const normalized = normalizeRelativePath(relativePath);
  const before = await inspectComponents(root, normalized, "directory");
  const directory = await opendir(workspaceAbsolutePath(root, normalized));
  try {
    await assertComponentsUnchanged(root, normalized, before, "directory");
    while (true) {
      const entry = await directory.read();
      if (entry === null) break;
      await visitor(entry);
    }
    await assertComponentsUnchanged(root, normalized, before, "directory");
  } finally {
    await closeDirectory(directory);
  }
}

/** Collects the names in one confined directory. */
export async function listBounded(root: string, relativePath: string): Promise<string[]> {
  const names: string[] = [];
  await visitBounded(root, relativePath, (entry) => {
    names.push(entry.name);
  });
  return names;
}

async function walkExisting(root: string, relativePath: string, allowMissing: boolean): Promise<{ exists: boolean; stat?: Stats }> {
  let current = root;
  let finalStat: Stats | undefined;
  const parts = relativePath === "." ? [] : relativePath.split("/");
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part === undefined) continue;
    current = path.join(current, part);
    const found = await lstatOrMissing(current, allowMissing);
    if (found === "missing") return { exists: false };
    if (found.isSymbolicLink()) throw pathDenied("Symbolic links are not permitted in workspace paths.");
    const isLeaf = index === parts.length - 1;
    if (!isLeaf && !found.isDirectory()) throw pathDenied("A workspace path ancestor is not a directory.");
    if (isLeaf) finalStat = found;
  }
  return { exists: true, ...(finalStat === undefined ? {} : { stat: finalStat }) };
}

async function lstatOrMissing(target: string, allowMissing: boolean): Promise<Stats | "missing"> {
  try {
    return await lstat(target);
  } catch (error: unknown) {
    if (isCode(error, "ENOENT") && allowMissing) return "missing";
    throw error;
  }
}

async function readOpened(handle: FileHandle, root: string, relativePath: string, before: PathComponent[], options: ReadBoundedOptions): Promise<BoundedFile> {
  const opened = await handle.stat({ bigint: true });
  assertOpenedPrivateFile(before, opened);
  await options.afterOpen?.();
  await assertComponentsUnchanged(root, relativePath, before, "file");
  if (opened.size > BigInt(options.maxBytes)) throw sizeLimitExceeded(options.maxBytes);
  const bytes = await readHandleBounded(handle, options.maxBytes);
  const finished = await handle.stat({ bigint: true });
  assertStableRead(opened, finished, bytes, options.maxBytes);
  await assertComponentsUnchanged(root, relativePath, before, "file");
  return { bytes, size: bytes.byteLength };
}

function assertStableRead(opened: BigIntStats, finished: BigIntStats, bytes: Buffer, maxBytes: number): void {
  if (opened.dev !== finished.dev || opened.ino !== finished.ino) throw boundary("File identity changed while reading.", "changed");
  if (!finished.isFile()) throw boundary("Opened workspace path is no longer a regular file.", "not-file");
  if (finished.nlink !== 1n) throw boundary("Hard-linked files are not readable through a path-scoped Lease.", "hard-link");
  if (finished.size > BigInt(maxBytes)) throw sizeLimitExceeded(maxBytes);
  if (
    finished.size !== opened.size ||
    finished.size !== BigInt(bytes.byteLength) ||
    finished.ctimeNs !== opened.ctimeNs ||
    finished.mtimeNs !== opened.mtimeNs
  ) {
    throw boundary("File changed while reading.", "changed");
  }
}

async function inspectComponents(root: string, relativePath: string, expectedLeaf: "directory" | "file"): Promise<PathComponent[]> {
  const normalized = normalizeRelativePath(relativePath);
  const parts = normalized === "." ? [] : normalized.split("/");
  const components: PathComponent[] = [];
  let current = path.resolve(root);
  for (let index = 0; index <= parts.length; index += 1) {
    if (index > 0) current = path.join(current, parts[index - 1]!);
    components.push(await componentAt(current, index === parts.length, expectedLeaf));
  }
  return components;
}

async function componentAt(target: string, leaf: boolean, expectedLeaf: "directory" | "file"): Promise<PathComponent> {
  const info = await lstat(target, { bigint: true });
  if (info.isSymbolicLink()) throw boundary("Symbolic links are not permitted in workspace paths.", "symbolic-link");
  if (!leaf && !info.isDirectory()) throw boundary("A workspace path ancestor is not a directory.", "not-directory");
  if (leaf && expectedLeaf === "directory" && !info.isDirectory()) throw boundary("Only directories can be listed.", "not-directory");
  if (leaf && expectedLeaf === "file" && !info.isFile()) throw boundary("Only regular files can be read.", "not-file");
  const kind = info.isDirectory() ? "directory" : info.isFile() ? "file" : "other";
  return { absolutePath: target, dev: info.dev, ino: info.ino, ctimeNs: info.ctimeNs, mtimeNs: info.mtimeNs, kind };
}

async function assertComponentsUnchanged(root: string, relativePath: string, expected: PathComponent[], expectedLeaf: "directory" | "file"): Promise<void> {
  let actual: PathComponent[];
  try {
    actual = await inspectComponents(root, relativePath, expectedLeaf);
  } catch (error: unknown) {
    if (error instanceof WorkspaceReadBoundaryError) throw boundary("Workspace path changed while establishing the read boundary.", "changed");
    throw error;
  }
  if (actual.length !== expected.length) throw boundary("Workspace path changed while establishing the read boundary.", "changed");
  for (let index = 0; index < expected.length; index += 1)
    compareComponent(expected[index]!, actual[index]!, index < expected.length - 1 || expectedLeaf === "directory");
}

function compareComponent(left: PathComponent, right: PathComponent, compareDirectoryMetadata: boolean): void {
  const metadataChanged = compareDirectoryMetadata && (left.ctimeNs !== right.ctimeNs || left.mtimeNs !== right.mtimeNs);
  if (left.absolutePath !== right.absolutePath || left.dev !== right.dev || left.ino !== right.ino || left.kind !== right.kind || metadataChanged) {
    throw boundary("Workspace path changed while establishing the read boundary.", "changed");
  }
}

function assertOpenedPrivateFile(components: PathComponent[], opened: BigIntStats): void {
  const leaf = components.at(-1);
  if (leaf === undefined) throw boundary("Workspace file identity is unavailable.", "changed");
  if (leaf.dev !== opened.dev || leaf.ino !== opened.ino) throw boundary("File changed while establishing the read boundary.", "changed");
  if (!opened.isFile()) throw boundary("Only regular files can be read.", "not-file");
  if (opened.nlink !== 1n) throw boundary("Hard-linked files are not readable through a path-scoped Lease.", "hard-link");
}

async function readHandleBounded(handle: FileHandle, maxBytes: number): Promise<Buffer> {
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

function workspaceAbsolutePath(root: string, relativePath: string): string {
  const absoluteRoot = path.resolve(root);
  const absolutePath = path.resolve(absoluteRoot, relativePath);
  assertInside(absoluteRoot, absolutePath);
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
    throw pathDenied(`${name} must be a positive safe integer below Number.MAX_SAFE_INTEGER.`);
  }
}

function boundary(message: string, reason: WorkspaceReadBoundaryReason, observed?: number): WorkspaceReadBoundaryError {
  return observed === undefined ? new WorkspaceReadBoundaryError(message, reason) : new WorkspaceReadBoundaryError(message, reason, observed);
}

function sizeLimitExceeded(maxBytes: number, observed = maxBytes + 1): WorkspaceReadBoundaryError {
  return boundary("File exceeds the maximum readable size.", "size-limit", observed);
}

function optionalFlag(name: "O_NOFOLLOW" | "O_NONBLOCK"): number {
  const value = constants[name];
  return typeof value === "number" ? value : 0;
}
