import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { assertInside, isCode, normalizeRelativePath, pathDenied } from "./path-lex.js";

export { normalizeRelativePath } from "./path-lex.js";
export {
  listBounded,
  readBounded,
  resolveBounded,
  visitBounded,
  WorkspaceReadBoundaryError,
  type BoundedFile,
  type BoundedPath,
  type ReadBoundedOptions,
  type WorkspaceReadBoundaryReason
} from "./bounded-read.js";

/** Injected filesystem seam. Production uses node:fs/promises; tests record fsync order. */
export interface BoundaryFs {
  lstat: typeof lstat;
  open: typeof open;
  rename: typeof rename;
  mkdir: typeof mkdir;
  rm: typeof rm;
}

export interface WriteBoundedOptions {
  mode?: number;
  /** Durable writes always fsync the file and, except on Windows, its parent directory. */
  fsync: true;
  fs?: BoundaryFs;
  /** Defaults to the host platform. Windows cannot fsync a directory handle. */
  platform?: NodeJS.Platform;
}

interface ParentLocation {
  absolutePath: string;
  leaf: string;
  dev: bigint;
  ino: bigint;
}

const realFs: BoundaryFs = { lstat, open, rename, mkdir, rm };

/**
 * Writes one file inside root. An ancestor that is a symlink, including one
 * that points outside root, fails closed with PATH_DENIED before the target
 * is published. Node has no renameat: the parent directory fd is checked
 * again before and after rename.
 */
export async function writeBounded(root: string, relativePath: string, data: string | Uint8Array, options: WriteBoundedOptions): Promise<void> {
  const fs = options.fs ?? realFs;
  const platform = options.platform ?? process.platform;
  const parent = await prepareParent(path.resolve(root), normalizeRelativePath(relativePath), fs);
  await assertLeafReplaceable(parent, fs);
  const handle = await openDirectory(parent.absolutePath, fs);
  try {
    await assertSameDirectory(handle, parent);
    await publish(parent, data, options.mode ?? 0o600, fs);
    await assertSameDirectory(handle, parent);
    await assertWrittenFile(parent, fs);
    if (platform !== "win32") await handle.sync();
  } finally {
    await handle.close();
  }
}

async function prepareParent(root: string, relativePath: string, fs: BoundaryFs): Promise<ParentLocation> {
  await assertRoot(root, fs);
  const parts = relativePath === "." ? [] : relativePath.split("/");
  const leaf = parts.pop();
  if (leaf === undefined || leaf.length === 0 || leaf === "." || leaf === "..") {
    throw pathDenied("A bounded write requires a file path.");
  }
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    await ensureRealDirectory(current, fs);
  }
  assertInside(root, path.join(current, leaf));
  const info = await fs.lstat(current, { bigint: true });
  if (info.isSymbolicLink() || !info.isDirectory()) throw pathDenied("A workspace path ancestor is not a directory.");
  return { absolutePath: current, leaf, dev: info.dev, ino: info.ino };
}

async function assertRoot(root: string, fs: BoundaryFs): Promise<void> {
  const info = await fs.lstat(root);
  if (info.isSymbolicLink() || !info.isDirectory()) throw pathDenied("Workspace root must be a real directory.");
}

async function ensureRealDirectory(target: string, fs: BoundaryFs): Promise<void> {
  try {
    await assertRealDirectory(target, fs);
  } catch (error: unknown) {
    if (!isCode(error, "ENOENT")) throw error;
    await fs.mkdir(target);
    await assertRealDirectory(target, fs);
  }
}

async function assertRealDirectory(target: string, fs: BoundaryFs): Promise<void> {
  const info = await fs.lstat(target);
  if (info.isSymbolicLink()) throw pathDenied("Symbolic links are not permitted in workspace paths.", { target });
  if (!info.isDirectory()) throw pathDenied("A workspace path ancestor is not a directory.", { target });
}

async function assertLeafReplaceable(parent: ParentLocation, fs: BoundaryFs): Promise<void> {
  let info;
  try {
    info = await fs.lstat(path.join(parent.absolutePath, parent.leaf));
  } catch (error: unknown) {
    if (isCode(error, "ENOENT")) return;
    throw error;
  }
  if (info.isSymbolicLink()) throw pathDenied("Symbolic links are not permitted in workspace paths.");
  if (!info.isFile()) throw pathDenied("Write target must be a regular file.");
}

async function openDirectory(directory: string, fs: BoundaryFs): Promise<FileHandle> {
  const flags = constants.O_RDONLY | optionalFlag("O_NOFOLLOW") | optionalFlag("O_DIRECTORY");
  const handle = await fs.open(directory, flags);
  try {
    const info = await handle.stat({ bigint: true });
    if (!info.isDirectory()) throw pathDenied("A workspace path ancestor is not a directory.", { directory });
    return handle;
  } catch (error: unknown) {
    await handle.close();
    throw error;
  }
}

async function assertSameDirectory(handle: FileHandle, parent: ParentLocation): Promise<void> {
  const info = await handle.stat({ bigint: true });
  if (info.dev !== parent.dev || info.ino !== parent.ino || !info.isDirectory()) {
    throw pathDenied("Workspace path changed while establishing the write boundary.");
  }
}

async function publish(parent: ParentLocation, data: string | Uint8Array, mode: number, fs: BoundaryFs): Promise<void> {
  const target = path.join(parent.absolutePath, parent.leaf);
  const temporary = path.join(parent.absolutePath, `.${parent.leaf}.${randomUUID()}.tmp`);
  try {
    const handle = await fs.open(temporary, "wx", mode);
    try {
      await handle.writeFile(data, typeof data === "string" ? { encoding: "utf8" } : {});
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, target);
  } finally {
    // The temporary name is private to this attempt. After a successful rename
    // it is already gone; ENOENT here is the success path, not a hidden failure.
    await fs.rm(temporary, { force: true }).catch((error: unknown) => {
      if (!isCode(error, "ENOENT")) throw error;
    });
  }
}

async function assertWrittenFile(parent: ParentLocation, fs: BoundaryFs): Promise<void> {
  const info = await fs.lstat(path.join(parent.absolutePath, parent.leaf));
  if (info.isSymbolicLink() || !info.isFile()) throw pathDenied("Bounded write target is not a regular file.");
}

function optionalFlag(name: "O_NOFOLLOW" | "O_DIRECTORY"): number {
  const value = constants[name];
  return typeof value === "number" ? value : 0;
}
