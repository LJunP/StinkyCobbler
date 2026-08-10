#!/usr/bin/env node
/**
 * Builds the offline full bundle: a self-contained zip (package + production
 * node_modules + platform bin shims) so a fresh machine can use stinky-cobbler
 * without any network access. Run on a machine with network once; distribute
 * the zip anywhere.
 *
 * Usage: node scripts/build-offline-bundle.mjs [version]
 * Output: stinky-cobbler-<version>-offline-full.zip
 *
 * Requires: node, npm, zip, and network access to the npm registry (the
 * production dependency tree is installed fresh from the registry so it always
 * matches the published package-lock).
 */
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile, readFile, chmod, copyFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
const version = process.argv[2] ?? pkg.version;

const work = await mkdtemp(path.join(os.tmpdir(), "sc-offline-"));
const outDir = path.join(work, `stinky-cobbler-${version}-offline-full`);
const binDir = path.join(outDir, "bin");
const pkgDir = path.join(outDir, "package");
await mkdir(binDir, { recursive: true });

try {
  // 1. Install the published package into the bundle directory (registry = production deps only).
  execFileSync("npm", ["install", "--prefix", outDir, "--omit=dev", "--registry=https://registry.npmjs.org", `stinky-cobbler@${version}`], { stdio: "inherit", cwd: work });

  // 2. Move the installed package to `package/` (bin entries live inside it, but we add our own shims).
  const installed = path.join(outDir, "node_modules", "stinky-cobbler");
  execFileSync("mv", [installed, pkgDir], { stdio: "inherit" });

  // 3. Write platform bin shims (macOS/Linux sh + Windows cmd).
  const sh = `#!/bin/sh\nexec node "$(dirname "$0")/../package/dist/cli.js" "$@"\n`;
  const shMcp = `#!/bin/sh\nexec node "$(dirname "$0")/../package/dist/mcp-server.js" "$@"\n`;
  const cmd = `@echo off\r\nnode "%~dp0\\..\\package\\dist\\cli.js" %*\r\n`;
  const cmdMcp = `@echo off\r\nnode "%~dp0\\..\\package\\dist\\mcp-server.js" %*\r\n`;
  await writeFile(path.join(binDir, "stinky-cobbler"), sh, "utf8");
  await writeFile(path.join(binDir, "stinky-cobbler-mcp"), shMcp, "utf8");
  await writeFile(path.join(binDir, "stinky-cobbler.cmd"), cmd, "utf8");
  await writeFile(path.join(binDir, "stinky-cobbler-mcp.cmd"), cmdMcp, "utf8");
  await chmod(path.join(binDir, "stinky-cobbler"), 0o755);
  await chmod(path.join(binDir, "stinky-cobbler-mcp"), 0o755);
  await writeFile(path.join(outDir, "README.txt"), [
    `Stinky Cobbler ${version} offline bundle (no network required)`,
    "",
    "Requirements: Node.js >= 20 (any OS).",
    "",
    "macOS / Linux:",
    "  export PATH=\"$PWD/bin:$PATH\"   # from this directory",
    "  stinky-cobbler --version",
    "",
    "Windows (cmd):",
    "  set PATH=%CD%\\bin;%PATH%",
    "  stinky-cobbler --version",
    "",
    "Then connect a host once:",
    "  stinky-cobbler entry install-host --mcp                # ZCode",
    "  stinky-cobbler entry install-host --host codex --mcp   # Codex",
    "",
    "Full manual: see 使用说明书.md in this directory."
  ].join("\n"), "utf8");
  await copyFile(path.join(projectRoot, "docs", "quickstart", "使用说明书.md"), path.join(outDir, "使用说明书.md"));

  // 4. Zip it next to the project (relative to projectRoot).
  const zipPath = path.join(projectRoot, `stinky-cobbler-${version}-offline-full.zip`);
  execFileSync("zip", ["-qr", zipPath, path.basename(outDir)], { stdio: "inherit", cwd: work });
  console.log(`Offline bundle written: ${zipPath}`);
} finally {
  await rm(work, { recursive: true, force: true });
}
