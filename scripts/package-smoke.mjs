import { execFileSync } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const requiredPaths = [
  "dist/cli.js",
  "dist/mcp-server.js",
  "schemas",
  "profiles",
  "packs",
  "policies",
  "plugins",
  ".zcode/skills",
  ".zcode/commands",
  "README.md",
  "LICENSE",
  "SECURITY.md",
  "CHANGELOG.md",
  "docs",
  "examples"
];

function npmJson(args) {
  const output = execFileSync(npm, args, { cwd: root, encoding: "utf8" });
  return JSON.parse(output);
}

function normalizePackPath(value) {
  return value.replaceAll("\\", "/").replace(/^package\//, "");
}

function includesPath(files, expected) {
  return files.some((file) => file === expected || file.startsWith(`${expected}/`));
}

function assertNoForbiddenFiles(files) {
  const forbidden = files.filter((file) =>
    /^(src|test|node_modules|\.stinky-cobbler)\//.test(file)
    || /(^|\/)(\.env)(\.|$)/.test(file)
    || /(^|\/)(secrets\.json|netrc|\.npmrc)(\.|$)/.test(file)
    || /(^|\/).*\.(pem|key|crt|p12|keystore)$/.test(file)
  );
  if (forbidden.length > 0) throw new Error(`npm pack contains forbidden files: ${forbidden.join(", ")}`);
}

let tarball;
let installDirectory;
let mcpTransport;
try {
  const dryRun = npmJson(["pack", "--dry-run", "--json", "--ignore-scripts"]);
  const dryRunFiles = dryRun[0]?.files?.map((file) => normalizePackPath(file.path)) ?? [];
  assertNoForbiddenFiles(dryRunFiles);
  const missing = requiredPaths.filter((expected) => !includesPath(dryRunFiles, expected));
  if (missing.length > 0) throw new Error(`npm pack --dry-run is missing required paths: ${missing.join(", ")}`);

  const packResult = npmJson(["pack", "--json", "--ignore-scripts"]);
  const filename = packResult[0]?.filename;
  if (typeof filename !== "string" || filename.length === 0) throw new Error("npm pack did not return a tarball filename.");
  tarball = path.resolve(root, filename);

  installDirectory = mkdtempSync(path.join(os.tmpdir(), "stinky-cobbler-package-"));
  execFileSync(npm, ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock", tarball], { cwd: installDirectory, stdio: "inherit" });

  const packageDirectory = path.join(installDirectory, "node_modules", "stinky-cobbler");
  const cli = path.join(installDirectory, "node_modules", ".bin", "stinky-cobbler");
  const mcp = path.join(installDirectory, "node_modules", ".bin", "stinky-cobbler-mcp");
  if (!existsSync(cli) || !existsSync(mcp)) throw new Error("Installed CLI or MCP binary is missing.");
  const installedPackage = JSON.parse(readFileSync(path.join(packageDirectory, "package.json"), "utf8"));

  execFileSync(cli, ["--help"], { cwd: installDirectory, stdio: "inherit" });
  const installedVersion = execFileSync(cli, ["--version"], { cwd: installDirectory, encoding: "utf8" }).trim();
  if (installedVersion !== installedPackage.version) throw new Error(`Installed CLI version mismatch: ${installedVersion} !== ${installedPackage.version}`);

  const doctorOutput = execFileSync(cli, ["doctor", "--json"], { cwd: installDirectory, encoding: "utf8" });
  const doctor = JSON.parse(doctorOutput);
  const repositoryRead = doctor.plugins?.find((plugin) => plugin.id === "repository-read");
  const scriptedReadonly = doctor.adapters?.find((adapter) => adapter.id === "scripted-readonly");
  if (doctor.healthy !== true || doctor.profiles < 1 || doctor.packs < 1 || repositoryRead?.executable !== true || scriptedReadonly?.status !== "available") {
    throw new Error(`Installed tarball doctor check failed: ${doctorOutput.trim()}`);
  }

  // Entry contract: install-host is explicit, never automatic, and dry-run writes nothing.
  const fakeHome = path.join(installDirectory, "fake-home");
  const hostEnv = { ...process.env, HOME: fakeHome };
  const preflightOutput = execFileSync(cli, ["entry", "preflight", "--via", "mcp", "--json"], { cwd: installDirectory, env: hostEnv, encoding: "utf8" });
  const preflight = JSON.parse(preflightOutput);
  if (preflight.viaValid !== true || preflight.via !== "mcp" || preflight.mcpLocations?.length > 0) {
    throw new Error(`Installed entry preflight failed: ${preflightOutput.trim()}`);
  }
  const installPreview = execFileSync(cli, ["entry", "install-host", "--scope", "user", "--dry-run", "--json"], { cwd: installDirectory, env: hostEnv, encoding: "utf8" });
  const install = JSON.parse(installPreview);
  if (install.command?.action !== "preview") {
    throw new Error(`Installed entry install-host dry-run failed: ${installPreview.trim()}`);
  }
  if (existsSync(path.join(fakeHome, ".zcode", "commands", "stinky-cobbler.md"))) {
    throw new Error("Installing the tarball must not write host command files; a dry-run preview was expected to write nothing.");
  }
  if (install.mcp?.action !== undefined && install.mcp.action !== "preview") {
    throw new Error(`Installed entry install-host dry-run --mcp must only preview: ${JSON.stringify(install.mcp)}`);
  }
  if (existsSync(path.join(fakeHome, ".zcode", "config.json"))) {
    throw new Error("Installing the tarball must not write host config; a dry-run preview was expected to write nothing.");
  }

  const client = new Client({ name: "stinky-cobbler-package-smoke", version: installedPackage.version });
  mcpTransport = new StdioClientTransport({ command: mcp, cwd: installDirectory, stderr: "pipe" });
  await client.connect(mcpTransport);
  const tools = await client.listTools();
  const names = tools.tools.map((tool) => tool.name);
  if (!names.includes("repo_read") || names.includes("test-run") || names.includes("test_run") || names.includes("evidence_show")) {
    throw new Error(`Installed MCP tool boundary check failed: ${names.join(", ")}`);
  }
  await client.close();
  mcpTransport = undefined;

  console.log(`Package smoke passed: ${filename}`);
  console.log(`Dry-run entries checked: ${dryRunFiles.length}`);
} finally {
  await mcpTransport?.close().catch(() => undefined);
  if (installDirectory) rmSync(installDirectory, { recursive: true, force: true });
  if (tarball) rmSync(tarball, { force: true });
}
