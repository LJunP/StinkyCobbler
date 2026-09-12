import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { addShebangs } from "./add-shebang.mjs";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Build into a fresh sibling directory, then perform a two-stage replacement
 * of `dist` only after compiler and post-processing success. This prevents stale
 * outputs from entering npm packages and restores the previous dist on caught
 * replacement failures. The two renames are not a crash-atomic directory swap:
 * abrupt process/host failure between them can leave only the backup directory.
 */
export async function buildProject(options = {}) {
  const root = path.resolve(options.root ?? projectRoot);
  const output = path.join(root, "dist");
  const temporary = path.join(root, `.dist-build-${randomUUID()}`);
  const backup = path.join(root, `.dist-backup-${randomUUID()}`);
  const compile = options.compile ?? compileTypeScript;

  await assertReplaceableOutput(output, root);
  let movedPrevious = false;
  try {
    await mkdir(temporary, { mode: 0o700 });
    await compile({ root, output: temporary });
    await assertBuiltOutput(temporary);
    await addShebangs(temporary);
    // A fresh tsc output is not executable. Preserve npm-linked CLI/MCP bins
    // across rebuilds, before making the replacement directory visible.
    for (const name of ["cli.js", "mcp-server.js"]) {
      await chmod(path.join(temporary, name), 0o755);
    }

    if (await exists(output)) {
      await rename(output, backup);
      movedPrevious = true;
    }
    try {
      await rename(temporary, output);
    } catch (error) {
      if (movedPrevious && !(await exists(output)) && await exists(backup)) {
        await rename(backup, output);
        movedPrevious = false;
      }
      throw error;
    }

    if (movedPrevious) {
      await removeGeneratedDirectory(backup, root, ".dist-backup-");
      movedPrevious = false;
    }
  } finally {
    if (await exists(temporary)) {
      await removeGeneratedDirectory(temporary, root, ".dist-build-");
    }
  }
}

async function compileTypeScript({ root, output }) {
  const compiler = path.join(root, "node_modules", "typescript", "bin", "tsc");
  await execFileAsync(process.execPath, [compiler, "-p", path.join(root, "tsconfig.json"), "--outDir", output], {
    cwd: root,
    maxBuffer: 10 * 1024 * 1024
  });
}

async function assertReplaceableOutput(output, root) {
  assertExactChild(output, root, "dist");
  let info;
  try {
    info = await lstat(output);
  } catch (error) {
    if (isCode(error, "ENOENT")) return;
    throw error;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw buildError("BUILD_OUTPUT_UNSAFE", "The build output must be a real directory or be absent.", { output: "dist" });
  }
}

async function assertBuiltOutput(output) {
  for (const relative of ["cli.js", "mcp-server.js"]) {
    const target = path.join(output, relative);
    let info;
    try {
      info = await lstat(target);
    } catch (error) {
      if (isCode(error, "ENOENT")) throw buildError("BUILD_OUTPUT_INCOMPLETE", "The compiler did not produce a required entry point.", { file: relative });
      throw error;
    }
    if (info.isSymbolicLink() || !info.isFile()) {
      throw buildError("BUILD_OUTPUT_INCOMPLETE", "A required build entry point is not a regular file.", { file: relative });
    }
  }
}

async function removeGeneratedDirectory(target, root, prefix) {
  if (path.dirname(target) !== root || !path.basename(target).startsWith(prefix)) {
    throw buildError("BUILD_OUTPUT_UNSAFE", "Refusing to remove an unexpected build path.", { path: path.basename(target) });
  }
  const info = await lstat(target);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw buildError("BUILD_OUTPUT_UNSAFE", "Refusing to remove a non-directory build path.", { path: path.basename(target) });
  }
  await rm(target, { recursive: true });
}

function assertExactChild(target, root, name) {
  if (path.dirname(target) !== root || path.basename(target) !== name) {
    throw buildError("BUILD_OUTPUT_UNSAFE", "The build output path is not the expected project directory.", { output: name });
  }
}

async function exists(target) {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (isCode(error, "ENOENT")) return false;
    throw error;
  }
}

function buildError(code, message, details = {}) {
  return Object.assign(new Error(message), { code, details });
}

function isCode(error, code) {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await buildProject();
}
