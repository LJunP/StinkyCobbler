import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { parse as parseToml } from "smol-toml";

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
  ".codex/skills",
  ".zcode/skills",
  ".zcode/commands",
  "README.md",
  "LICENSE",
  "SECURITY.md",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "docs",
  "examples"
];

const forbiddenPathPatterns = [
  /^(src|test|node_modules|\.stinky-cobbler)(?:\/|$)/i,
  /(^|\/)(?:\.env(?:\..+)?|\.npmrc|\.netrc|auth\.json|credentials(?:\.json)?|secrets?(?:\.json)?|known_hosts)$/i,
  /(^|\/)(?:id_(?:rsa|dsa|ecdsa|ed25519)|state(?:_\d+)?\.sqlite(?:-(?:wal|shm))?|session_index\.jsonl)$/i,
  /(^|\/)(?:sessions|archived_sessions|attachments|memories)(?:\/|$)/i,
  /(^|\/)\.ssh(?:\/|$)/i,
  /\.(?:pem|key|crt|cer|p12|pfx|jks|keystore)$/i
];

const sensitiveContentPatterns = [
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ["OpenAI-style token", /\bsk-(?:proj-|admin-)?[A-Za-z0-9_-]{20,}\b/],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{20,}\b/],
  ["npm token", /\bnpm_[A-Za-z0-9]{30,}\b/],
  ["AWS access key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ["npm registry auth", /(?:^|\n)\s*(?:(?:\/\/[^\s:]+\/?:)?_authToken|_auth)\s*=\s*["']?[A-Za-z0-9._~+/=-]{16,}/im],
  ["private home path", /(?:\/Users\/(?!<|example(?:\/|$)|user(?:\/|$)|username(?:\/|$))[^/\s"'`]+\/|[A-Za-z]:\\Users\\(?!<|example(?:\\|$)|user(?:\\|$)|username(?:\\|$))[^\\\s"'`]+\\)/i]
];

function execPortableSync(command, args, options = {}) {
  if (process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command)) {
    // Windows command shims are scripts, not PE executables. `shell` is
    // required for npm.cmd and the package's generated .cmd bin shims.
    return execFileSync(command, args, { ...options, shell: process.env.ComSpec ?? true });
  }
  return execFileSync(command, args, options);
}

function npmJson(args) {
  const output = execPortableSync(npm, args, { cwd: root, encoding: "utf8" });
  return JSON.parse(output);
}

export function normalizePackPath(value) {
  return value.replaceAll("\\", "/").replace(/^package\//, "");
}

function includesPath(files, expected) {
  return files.some((file) => file === expected || file.startsWith(`${expected}/`));
}

export function findForbiddenPackagePaths(files) {
  return files.filter((file) => forbiddenPathPatterns.some((pattern) => pattern.test(normalizePackPath(file))));
}

function assertNoForbiddenFiles(files) {
  const forbidden = findForbiddenPackagePaths(files);
  if (forbidden.length > 0) throw new Error(`npm pack contains forbidden files: ${forbidden.join(", ")}`);
}

export function findSensitiveContent(relativePath, contents) {
  const text = Buffer.isBuffer(contents) ? contents.toString("utf8") : String(contents);
  return sensitiveContentPatterns
    .filter(([, pattern]) => pattern.test(text))
    .map(([label]) => `${normalizePackPath(relativePath)} (${label})`);
}

function assertNoSensitivePackedContent(packageDirectory, files) {
  const findings = [];
  const resolvedPackage = path.resolve(packageDirectory);
  for (const relative of files) {
    const normalized = normalizePackPath(relative);
    if (path.posix.isAbsolute(normalized) || normalized === ".." || normalized.startsWith("../")) {
      throw new Error(`npm pack returned an unsafe package path: ${relative}`);
    }
    const absolute = path.resolve(resolvedPackage, ...normalized.split("/"));
    if (absolute !== resolvedPackage && !absolute.startsWith(`${resolvedPackage}${path.sep}`)) {
      throw new Error(`npm pack path escapes the installed package: ${relative}`);
    }
    const info = lstatSync(absolute);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error(`Packed entry must install as a regular file: ${relative}`);
    }
    findings.push(...findSensitiveContent(normalized, readFileSync(absolute)));
  }
  if (findings.length > 0) {
    throw new Error(`npm pack contains sensitive content signatures: ${findings.join(", ")}`);
  }
}

/** Inventory the files actually extracted from one exact tarball without following links. */
export function listInstalledPackageFiles(packageDirectory) {
  const files = [];
  const visit = (directory, prefix = "") => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const absolute = path.join(directory, entry.name);
      const info = lstatSync(absolute);
      if (info.isSymbolicLink()) throw new Error(`Packed entry must not install as a symbolic link: ${relative}`);
      if (info.isDirectory()) visit(absolute, relative);
      else if (info.isFile()) files.push(normalizePackPath(relative));
      else throw new Error(`Packed entry must install as a regular file or directory: ${relative}`);
    }
  };
  visit(path.resolve(packageDirectory));
  return files.sort();
}

export function packageBinPath(binDirectory, name, platform = process.platform) {
  return path.join(binDirectory, platform === "win32" ? `${name}.cmd` : name);
}

export function isolatedHostEnvironment(fakeHome, baseEnvironment = process.env, platform = process.platform) {
  if (platform === "win32") {
    const rootDirectory = path.win32.parse(fakeHome).root;
    const homeDrive = rootDirectory.replace(/[\\/]$/, "");
    return {
      ...baseEnvironment,
      HOME: fakeHome,
      USERPROFILE: fakeHome,
      HOMEDRIVE: homeDrive,
      HOMEPATH: fakeHome.slice(homeDrive.length) || "\\"
    };
  }
  return {
    ...baseEnvironment,
    HOME: fakeHome,
    USERPROFILE: fakeHome,
    HOMEDRIVE: "",
    HOMEPATH: fakeHome
  };
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertManagedTarget(target, expectedVersion) {
  const targetBytes = readFileSync(target);
  const sidecar = `${target}.stinky-cobbler-managed.json`;
  const managed = JSON.parse(readFileSync(sidecar, "utf8"));
  if (managed.version !== 1 || managed.productVersion !== expectedVersion || managed.installedSha256 !== sha256(targetBytes)) {
    throw new Error(`Managed install sidecar does not bind the installed bytes: ${sidecar}`);
  }
}

export async function packageSmoke(options = {}) {
  let tarball;
  let ownsTarball = false;
  let installDirectory;
  let mcpTransport;
  try {
    const dryRun = npmJson(["pack", "--dry-run", "--json", "--ignore-scripts"]);
    const dryRunFiles = dryRun[0]?.files?.map((file) => normalizePackPath(file.path)) ?? [];
    assertNoForbiddenFiles(dryRunFiles);
    const missing = requiredPaths.filter((expected) => !includesPath(dryRunFiles, expected));
    if (missing.length > 0) throw new Error(`npm pack --dry-run is missing required paths: ${missing.join(", ")}`);

    let filename;
    if (options.tarballPath !== undefined) {
      tarball = path.resolve(options.tarballPath);
      const info = lstatSync(tarball);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Exact release tarball must be a regular non-link file: ${tarball}`);
      filename = path.basename(tarball);
    } else {
      const packResult = npmJson(["pack", "--json", "--ignore-scripts"]);
      filename = packResult[0]?.filename;
      if (typeof filename !== "string" || filename.length === 0) throw new Error("npm pack did not return a tarball filename.");
      tarball = path.resolve(root, filename);
      ownsTarball = true;
    }

    installDirectory = mkdtempSync(path.join(os.tmpdir(), "stinky-cobbler-package-"));
    execPortableSync(npm, ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock", tarball], { cwd: installDirectory, stdio: "inherit" });

    const packageDirectory = path.join(installDirectory, "node_modules", "stinky-cobbler");
    const binDirectory = path.join(installDirectory, "node_modules", ".bin");
    const cli = packageBinPath(binDirectory, "stinky-cobbler");
    const mcp = packageBinPath(binDirectory, "stinky-cobbler-mcp");
    if (!existsSync(cli) || !existsSync(mcp)) throw new Error("Installed CLI or MCP binary is missing.");
    const installedPackage = JSON.parse(readFileSync(path.join(packageDirectory, "package.json"), "utf8"));
    const installedFiles = listInstalledPackageFiles(packageDirectory);
    assertNoForbiddenFiles(installedFiles);
    const installedMissing = requiredPaths.filter((expected) => !includesPath(installedFiles, expected));
    if (installedMissing.length > 0) throw new Error(`Exact installed tarball is missing required paths: ${installedMissing.join(", ")}`);
    assertNoSensitivePackedContent(packageDirectory, installedFiles);
    assertNoPublishedLibrarySurface(installDirectory, installedPackage);

    execPortableSync(cli, ["--help"], { cwd: installDirectory, stdio: "inherit" });
    const installedVersion = execPortableSync(cli, ["--version"], { cwd: installDirectory, encoding: "utf8" }).trim();
    if (installedVersion !== installedPackage.version) throw new Error(`Installed CLI version mismatch: ${installedVersion} !== ${installedPackage.version}`);

    const doctorOutput = execPortableSync(cli, ["doctor", "--json"], { cwd: installDirectory, encoding: "utf8" });
    const doctor = JSON.parse(doctorOutput);
    const repositoryRead = doctor.plugins?.find((plugin) => plugin.id === "repository-read");
    const scriptedReadonly = doctor.adapters?.find((adapter) => adapter.id === "scripted-readonly");
    if (doctor.healthy !== true || doctor.profiles < 1 || doctor.packs < 1 || repositoryRead?.executable !== true || scriptedReadonly?.status !== "available") {
      throw new Error(`Installed tarball doctor check failed: ${doctorOutput.trim()}`);
    }

    // Entry contract: dry-run writes nothing; an explicit real install is
    // confined to a fake home and must bind every write to a managed sidecar.
    const fakeHome = path.join(installDirectory, "fake-home");
    const hostEnv = isolatedHostEnvironment(fakeHome, {
      ...process.env,
      PATH: `${binDirectory}${path.delimiter}${process.env.PATH ?? ""}`
    });
    const preflightOutput = execPortableSync(cli, ["entry", "preflight", "--via", "mcp", "--json"], { cwd: installDirectory, env: hostEnv, encoding: "utf8" });
    const preflight = JSON.parse(preflightOutput);
    if (preflight.viaValid !== true || preflight.via !== "mcp" || preflight.mcpLocations?.length > 0) {
      throw new Error(`Installed entry preflight failed: ${preflightOutput.trim()}`);
    }

    const commandFile = path.join(fakeHome, ".zcode", "commands", "stinky-cobbler.md");
    const skillFile = path.join(fakeHome, ".zcode", "skills", "stinky-cobbler", "SKILL.md");
    const configFile = path.join(fakeHome, ".zcode", "cli", "config.json");
    const legacyConfigFile = path.join(fakeHome, ".zcode", "config.json");
    const zcodeManagedTargets = [commandFile, skillFile, configFile];

    const installPreviewOutput = execPortableSync(cli, ["entry", "install-host", "--scope", "user", "--mcp", "--dry-run", "--json"], {
      cwd: installDirectory,
      env: hostEnv,
      encoding: "utf8"
    });
    const installPreview = JSON.parse(installPreviewOutput);
    if ([installPreview.command, installPreview.skill, installPreview.mcp].some((action) => action?.action !== "preview")) {
      throw new Error(`Installed entry install-host --mcp dry-run failed: ${installPreviewOutput.trim()}`);
    }
    if (zcodeManagedTargets.some((target) => existsSync(target) || existsSync(`${target}.stinky-cobbler-managed.json`))) {
      throw new Error("install-host --mcp --dry-run wrote a host file or managed sidecar.");
    }
    if (existsSync(legacyConfigFile)) throw new Error("install-host must not write the legacy ~/.zcode/config.json path.");

    const installOutput = execPortableSync(cli, ["entry", "install-host", "--scope", "user", "--mcp", "--json"], {
      cwd: installDirectory,
      env: hostEnv,
      encoding: "utf8"
    });
    const install = JSON.parse(installOutput);
    if ([install.command, install.skill, install.mcp].some((action) => action?.action !== "installed")) {
      throw new Error(`Installed entry install-host --mcp failed: ${installOutput.trim()}`);
    }
    for (const target of zcodeManagedTargets) assertManagedTarget(target, installedPackage.version);
    if (existsSync(legacyConfigFile)) throw new Error("install-host wrote the legacy ~/.zcode/config.json path.");

    const hostConfig = JSON.parse(readFileSync(configFile, "utf8"));
    const server = hostConfig.mcp?.servers?.["stinky-cobbler-local"];
    const serverCommand = typeof server?.command === "string" ? path.basename(server.command).toLowerCase() : "";
    if (!Array.isArray(server?.args) || server.args.length !== 0 || !["stinky-cobbler-mcp", "stinky-cobbler-mcp.cmd"].includes(serverCommand)) {
      throw new Error(`Installed ~/.zcode/cli/config.json has an invalid MCP registration: ${JSON.stringify(server)}`);
    }

    const postflightOutput = execPortableSync(cli, ["entry", "preflight", "--via", "mcp", "--json"], { cwd: installDirectory, env: hostEnv, encoding: "utf8" });
    const postflight = JSON.parse(postflightOutput);
    if (postflight.mcpConfigured !== true || !postflight.mcpLocations?.includes(configFile)) {
      throw new Error(`Installed entry post-install preflight failed: ${postflightOutput.trim()}`);
    }

    // The published tarball must independently install the Codex template and
    // TOML MCP registration; source-tree host tests cannot prove packed bytes.
    const codexSkillFile = path.join(fakeHome, ".codex", "skills", "stinky-cobbler", "SKILL.md");
    const codexConfigFile = path.join(fakeHome, ".codex", "config.toml");
    const codexManagedTargets = [codexSkillFile, codexConfigFile];
    const codexPreviewOutput = execPortableSync(cli, [
      "entry", "install-host", "--host", "codex", "--scope", "user", "--mcp", "--dry-run", "--json"
    ], { cwd: installDirectory, env: hostEnv, encoding: "utf8" });
    const codexPreview = JSON.parse(codexPreviewOutput);
    if (
      codexPreview.command?.action !== "skipped" || codexPreview.skill?.action !== "preview" ||
      codexPreview.mcp?.action !== "preview"
    ) {
      throw new Error(`Installed Codex install-host --mcp dry-run failed: ${codexPreviewOutput.trim()}`);
    }
    if (codexManagedTargets.some((target) => existsSync(target) || existsSync(`${target}.stinky-cobbler-managed.json`))) {
      throw new Error("Codex install-host --mcp --dry-run wrote a host file or managed sidecar.");
    }

    const codexInstallOutput = execPortableSync(cli, [
      "entry", "install-host", "--host", "codex", "--scope", "user", "--mcp", "--json"
    ], { cwd: installDirectory, env: hostEnv, encoding: "utf8" });
    const codexInstall = JSON.parse(codexInstallOutput);
    if (
      codexInstall.command?.action !== "skipped" || codexInstall.skill?.action !== "installed" ||
      codexInstall.mcp?.action !== "installed"
    ) {
      throw new Error(`Installed Codex install-host --mcp failed: ${codexInstallOutput.trim()}`);
    }
    for (const target of codexManagedTargets) assertManagedTarget(target, installedPackage.version);
    const codexConfig = parseToml(readFileSync(codexConfigFile, "utf8"));
    const codexServer = codexConfig.mcp_servers?.["stinky-cobbler-local"];
    const codexServerCommand = typeof codexServer?.command === "string" ? path.basename(codexServer.command).toLowerCase() : "";
    if (!Array.isArray(codexServer?.args) || codexServer.args.length !== 0 || !["stinky-cobbler-mcp", "stinky-cobbler-mcp.cmd"].includes(codexServerCommand)) {
      throw new Error(`Installed ~/.codex/config.toml has an invalid MCP registration: ${JSON.stringify(codexServer)}`);
    }
    const codexPostflightOutput = execPortableSync(cli, [
      "entry", "preflight", "--host", "codex", "--via", "mcp", "--json"
    ], { cwd: installDirectory, env: hostEnv, encoding: "utf8" });
    const codexPostflight = JSON.parse(codexPostflightOutput);
    if (codexPostflight.mcpConfigured !== true || !codexPostflight.mcpLocations?.includes(codexConfigFile)) {
      throw new Error(`Installed Codex post-install preflight failed: ${codexPostflightOutput.trim()}`);
    }

    const client = new Client({ name: "stinky-cobbler-package-smoke", version: installedPackage.version });
    const transportLaunch = process.platform === "win32"
      ? { command: process.execPath, args: [path.join(packageDirectory, "dist", "mcp-server.js")] }
      : { command: mcp, args: [] };
    mcpTransport = new StdioClientTransport({ ...transportLaunch, cwd: installDirectory, stderr: "pipe" });
    await client.connect(mcpTransport);
    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name);
    if (!names.includes("repo_read") || names.includes("test-run") || names.includes("test_run") || names.includes("evidence_show")) {
      throw new Error(`Installed MCP tool boundary check failed: ${names.join(", ")}`);
    }
    await client.close();
    mcpTransport = undefined;

    console.log(`Package smoke passed: ${filename}`);
    console.log(`Source dry-run entries checked: ${dryRunFiles.length}`);
    console.log(`Exact installed tarball files and sensitive content checked: ${installedFiles.length}`);
  } finally {
    await mcpTransport?.close().catch(() => undefined);
    if (installDirectory) rmSync(installDirectory, { recursive: true, force: true });
    if (tarball && ownsTarball) rmSync(tarball, { force: true });
  }
}

function assertNoPublishedLibrarySurface(installDirectory, installedPackage) {
  if (JSON.stringify(installedPackage.exports) !== JSON.stringify({ "./package.json": "./package.json" })) {
    throw new Error("Installed package must expose metadata only; CLI/MCP bins are the supported executable surface.");
  }
  try {
    execPortableSync(process.execPath, [
      "--input-type=module",
      "--eval",
      "await import('stinky-cobbler/dist/storage/tasks.js')"
    ], { cwd: installDirectory, encoding: "utf8" });
  } catch (error) {
    const stderr = typeof error === "object" && error !== null && "stderr" in error ? String(error.stderr) : "";
    if (stderr.includes("ERR_PACKAGE_PATH_NOT_EXPORTED")) return;
    throw new Error(`Installed package deep-import boundary failed unexpectedly: ${stderr || String(error)}`);
  }
  throw new Error("Installed package unexpectedly permits deep imports of internal storage modules.");
}

function isDirectInvocation() {
  if (process.argv[1] === undefined) return false;
  const current = path.resolve(fileURLToPath(import.meta.url));
  const invoked = path.resolve(process.argv[1]);
  return process.platform === "win32" ? current.toLowerCase() === invoked.toLowerCase() : current === invoked;
}

function directInvocationOptions(argv) {
  if (argv.length === 0) return {};
  if (argv.length === 2 && argv[0] === "--tarball" && argv[1]?.length > 0) return { tarballPath: argv[1] };
  throw new Error("Usage: node scripts/package-smoke.mjs [--tarball <exact-tarball-path>]");
}

if (isDirectInvocation()) await packageSmoke(directInvocationOptions(process.argv.slice(2)));
