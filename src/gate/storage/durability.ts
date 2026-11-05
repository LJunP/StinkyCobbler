import { randomUUID } from "node:crypto";
import { COPYFILE_EXCL, S_IWUSR } from "node:constants";
import { chmod, copyFile, open, rename, rm, stat, type FileHandle } from "node:fs/promises";
import path from "node:path";

type OpenSyncTarget = (path: string, flags: "r" | "r+") => Promise<FileHandle>;

/** Directory fsync. Windows returns EPERM for directory handles; file contents are still fsynced. */
export async function syncDirectory(directory: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  if (platform !== "win32") await syncOpened(open, directory, "r");
}

/**
 * File fsync. POSIX opens "r": fsync on a read-only fd keeps mode 0400 files
 * durable, and that error is never swallowed. Windows FlushFileBuffers needs a
 * writable handle (EPERM on "r"), so open "r+". copyFile preserves the
 * read-only attribute; clear it only around that flush, then restore it.
 */
export async function syncFile(file: string, platform: NodeJS.Platform = process.platform, openFile: OpenSyncTarget = open): Promise<void> {
  if (platform !== "win32") return syncOpened(openFile, file, "r");
  const mode = (await stat(file)).mode & 0o777;
  const readOnly = (mode & S_IWUSR) === 0;
  if (readOnly) await chmod(file, mode | S_IWUSR);
  try {
    await syncOpened(openFile, file, "r+");
  } finally {
    if (readOnly) await chmod(file, mode);
  }
}

async function syncOpened(openFile: OpenSyncTarget, target: string, flags: "r" | "r+"): Promise<void> {
  const handle = await openFile(target, flags);
  try { await handle.sync(); } finally { await handle.close(); }
}

/**
 * Publishes `data` at `target` through a private temporary sibling: write,
 * fsync the temporary file, rename it over the target, then fsync the parent
 * directory. A crash before the rename leaves the old bytes; a crash after it
 * leaves the new bytes already durable, so recovery journals can trust either.
 */
export async function publishFileDurably(target: string, data: string | Uint8Array, options: { mode?: number } = {}): Promise<void> {
  const directory = path.dirname(target);
  const temporary = path.join(directory, `.${path.basename(target)}.${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, "wx", options.mode ?? 0o600);
    try {
      await handle.writeFile(data, typeof data === "string" ? { encoding: "utf8" } : {});
      await handle.sync();
    } finally { await handle.close(); }
    await rename(temporary, target);
  } finally { await rm(temporary, { force: true }).catch(() => undefined); }
  await syncDirectory(directory);
}

/** Copies `source` to a new `destination` exclusively, then fsyncs the copy and its directory. */
export async function copyFileDurably(source: string, destination: string): Promise<void> {
  await copyFile(source, destination, COPYFILE_EXCL);
  await syncFile(destination);
  await syncDirectory(path.dirname(destination));
}

/** Removes `target` if present, then fsyncs its directory so the removal survives a crash. */
export async function removeFileDurably(target: string): Promise<void> {
  await rm(target, { force: true });
  await syncDirectory(path.dirname(target));
}
