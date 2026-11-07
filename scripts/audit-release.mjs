import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findForbiddenPackagePaths, findSensitiveContent } from "./package-smoke.mjs";
import { execPortableSync, isDirectInvocation, npmExecutable } from "./release-utils.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKIP_DIRS = new Set(["node_modules", "dist", "output", ".git", "coverage"]);
const PACK_LAYOUT = /^(?:src|test|node_modules|\.stinky-cobbler)(?:\/|$)/i;
const SECRET_FILE = /(?:^|\/)(?:\.env(?:\..+)?|\.npmrc|\.netrc|auth\.json|credentials(?:\.json)?|secrets?(?:\.json)?|known_hosts)$/i;
const SECRET_KEY = /(?:^|\/)(?:id_(?:rsa|dsa|ecdsa|ed25519)|state(?:_\d+)?\.sqlite(?:-(?:wal|shm))?|session_index\.jsonl)$/i;
const SECRET_DIR = /(?:^|\/)(?:sessions|archived_sessions|attachments|memories)(?:\/|$)/i;
const SECRET_EXT = /\.(?:pem|key|crt|cer|p12|pfx|jks|keystore)$/i;
const SECRET_SSH = /(?:^|\/)\.ssh(?:\/|$)/i;

/**
 * package-smoke-contract.test.ts embeds the scanner fixtures it asserts on.
 * Root .npmrc is the tracked project config required by STANDARDS §1.2.
 */
export const CONTENT_SCAN_EXEMPT = new Set(["test/scripts/package-smoke-contract.test.ts"]);

export function formatResult(name, ok, detail = "") {
  return ok ? `PASS ${name}` : `FAIL ${name}: ${detail}`;
}

/** Lines whose git status porcelain entry is an untracked, unignored path. */
export function untrackedStatusLines(porcelain) {
  return porcelain.split(/\r?\n/).filter((line) => line.startsWith("??"));
}

/** Empty string when status, ls-files --others, and the empty-directory list are clean. */
export function workingTreeFailure(porcelain, others, emptyDirs) {
  const parts = [];
  const untracked = untrackedStatusLines(porcelain);
  if (untracked.length > 0) parts.push(`untracked status: ${untracked.join(", ")}`);
  if (others.length > 0) parts.push(`untracked files: ${others.join(", ")}`);
  if (emptyDirs.length > 0) parts.push(`empty directories: ${emptyDirs.join(", ")}`);
  return parts.join("; ");
}

/** Path plus pattern name. Drops the npm-pack layout denylist and the root .npmrc project file. */
export function repositoryForbiddenFindings(paths) {
  return findForbiddenPackagePaths(paths).flatMap((file) => {
    const normalized = file.replaceAll("\\", "/");
    if (normalized === ".npmrc") return [];
    if (PACK_LAYOUT.test(normalized) && !isSecretPath(normalized)) return [];
    return [`${normalized} (forbidden path)`];
  });
}

/** findSensitiveContent hits as "path (pattern)". Exempt paths are scanner fixtures. */
export function contentFindings(files, exempt = CONTENT_SCAN_EXEMPT) {
  const findings = [];
  for (const file of files) {
    if (exempt.has(file.path)) continue;
    findings.push(...findSensitiveContent(file.path, file.text));
  }
  return findings;
}

function isSecretPath(file) {
  return SECRET_FILE.test(file) || SECRET_KEY.test(file) || SECRET_DIR.test(file) || SECRET_SSH.test(file) || SECRET_EXT.test(file);
}

function runAudit() {
  const steps = [repoGuards, secretScan, dependencyAudit, runtimeAudit, workingTree];
  let failed = false;
  for (const step of steps) {
    const result = step();
    console.log(formatResult(result.name, result.ok, result.detail));
    if (!result.ok) failed = true;
  }
  return failed;
}

function repoGuards() {
  return commandStep("repo guards", npxExecutable(), ["vitest", "run", "--project", "unit", "test/repo"], true);
}

function dependencyAudit() {
  return commandStep("dependency audit", npmExecutable(), ["audit", "--audit-level=high"], true);
}

function runtimeAudit() {
  return commandStep("runtime dependency audit", npmExecutable(), ["audit", "--omit=dev", "--audit-level=low"], true);
}

function secretScan() {
  const files = trackedFiles();
  const findings = [...contentFindings(trackedText(files)), ...repositoryForbiddenFindings(files)];
  return { name: "secret scan (repository)", ok: findings.length === 0, detail: findings.join("; ") };
}

function workingTree() {
  const status = git(["status", "--porcelain", "--untracked-files=all"]);
  const others = git(["ls-files", "--others", "--exclude-standard"]).split(/\r?\n/).filter(Boolean);
  const detail = workingTreeFailure(status, others, emptyDirectories(root));
  return { name: "working tree", ok: detail === "", detail };
}

function commandStep(name, command, args, portable) {
  const result = run(command, args, portable);
  return { name, ok: result.ok, detail: result.ok ? "" : failDetail(result) };
}

function run(command, args, portable) {
  const options = { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 };
  try {
    const stdout = portable ? execPortableSync(command, args, options) : execFileSync(command, args, options);
    return { ok: true, status: 0, stdout: String(stdout ?? ""), stderr: "" };
  } catch (error) {
    return { ok: false, status: error?.status ?? 1, stdout: String(error?.stdout ?? ""), stderr: String(error?.stderr ?? "") };
  }
}

function failDetail(result) {
  const lines = `${result.stderr}\n${result.stdout}`.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const picked = lines.find((line) => /^FAIL\b/.test(line)) ?? lines.at(-1) ?? `exit ${result.status}`;
  return picked.replace(/\s+/g, " ").slice(0, 200);
}

function git(args) {
  return String(execFileSync("git", args, { cwd: root, encoding: "utf8" }));
}

function trackedFiles() {
  return git(["-c", "core.quotePath=false", "ls-files", "-z"]).split("\0").filter(Boolean);
}

function trackedText(files) {
  const texts = [];
  for (const file of files) {
    const buffer = readFileSync(path.join(root, file));
    if (!buffer.includes(0)) texts.push({ path: file, text: buffer.toString("utf8") });
  }
  return texts;
}

function emptyDirectories(directory) {
  const empty = [];
  const entries = readdirSync(directory, { withFileTypes: true });
  const visible = entries.filter((entry) => !SKIP_DIRS.has(entry.name));
  if (visible.length === 0 && directory !== root) empty.push(path.relative(root, directory).replaceAll("\\", "/"));
  for (const entry of visible) {
    if (entry.isDirectory() && !entry.isSymbolicLink()) empty.push(...emptyDirectories(path.join(directory, entry.name)));
  }
  return empty;
}

function npxExecutable() {
  return process.platform === "win32" ? "npx.cmd" : "npx";
}

if (isDirectInvocation(import.meta.url)) {
  if (runAudit()) process.exitCode = 1;
}
