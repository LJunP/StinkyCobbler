import { randomUUID } from "node:crypto";
import { COPYFILE_EXCL } from "node:constants";
import { copyFile, open, rename, rm } from "node:fs/promises";
import path from "node:path";

/**
 * Flushes directory metadata where Node exposes a supported directory fsync.
 * Windows rejects fsync on directory handles with EPERM; file contents are
 * still fsynced before every atomic publish operation on that platform.
 */
export async function syncDirectory(directory: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  if (platform === "win32") return;
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncFile(file: string): Promise<void> {
  const handle = await open(file, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
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
    } finally {
      await handle.close();
    }
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
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
