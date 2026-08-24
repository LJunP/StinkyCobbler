import { open } from "node:fs/promises";

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
