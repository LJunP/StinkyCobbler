import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Build inputs whose modification implies `dist/` must be regenerated. */
const BUILD_INPUT_FILES = ["tsconfig.json", "package.json", path.join("scripts", "build.mjs"), path.join("scripts", "add-shebang.mjs")];
const BUILD_OUTPUT_ENTRIES = [path.join("dist", "cli.js"), path.join("dist", "mcp-server.js")];

async function newestMtime(target: string): Promise<number> {
  const info = await stat(target).catch(() => null);
  if (info === null) return 0;
  if (!info.isDirectory()) return info.mtimeMs;
  const entries = await readdir(target, { withFileTypes: true });
  let newest = 0;
  for (const entry of entries) {
    const child = path.join(target, entry.name);
    const value = entry.isDirectory() ? await newestMtime(child) : (await stat(child)).mtimeMs;
    if (value > newest) newest = value;
  }
  return newest;
}

/**
 * True when any build input under `root` is newer than the built entry points,
 * or when an entry point is missing. Integration suites spawn `dist/`, so a
 * stale build would silently test old code.
 */
export async function isDistStale(root: string): Promise<boolean> {
  const outputs = await Promise.all(BUILD_OUTPUT_ENTRIES.map((entry) => stat(path.join(root, entry)).catch(() => null)));
  if (outputs.some((info) => info === null)) return true;
  const oldestOutput = Math.min(...outputs.map((info) => info!.mtimeMs));
  const inputs = await Promise.all([newestMtime(path.join(root, "src")), ...BUILD_INPUT_FILES.map((file) => newestMtime(path.join(root, file)))]);
  return Math.max(...inputs) > oldestOutput;
}

/** Vitest globalSetup: rebuild `dist/` before integration suites when it is stale. */
export default async function ensureFreshDist(): Promise<void> {
  if (!(await isDistStale(projectRoot))) return;
  const { buildProject } = await import("../../scripts/build.mjs");
  process.stdout.write("[dist-freshness] dist/ is older than its inputs; rebuilding before integration tests\n");
  await buildProject({ root: projectRoot });
}
