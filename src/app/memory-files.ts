import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";

const MEMORY_FILE = /^[a-z0-9][a-z0-9-]{0,63}\.md$/;

/** Reads one directory level of managed markdown. Other names and links are ignored. */
export async function readMemoryDirectory(directory: string, skipFile?: string): Promise<Record<string, string>> {
  const info = await lstat(directory).catch(() => undefined);
  if (info === undefined || !info.isDirectory() || info.isSymbolicLink()) return {};
  const names = (await readdir(directory)).filter((name) => MEMORY_FILE.test(name)).sort();
  const files: Record<string, string> = {};
  for (const name of names) {
    const full = path.resolve(directory, name);
    if (skipFile !== undefined && full === path.resolve(skipFile)) continue;
    const body = await regularFile(full);
    if (body !== undefined) files[name] = body;
  }
  return files;
}

async function regularFile(file: string): Promise<string | undefined> {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) return undefined;
  return readFile(file, "utf8");
}
