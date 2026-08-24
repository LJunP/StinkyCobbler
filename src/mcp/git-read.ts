import { execFile } from "node:child_process";
import type { Stats } from "node:fs";
import { lstat, opendir, readFile, readdir, realpath } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";
import { authorize, denied, validateCommandArgument, type ToolAccess, type ToolOutcome } from "./shared.js";
import { loadOrchestrationConfig } from "../config/tiered.js";
import { assertWorkspacePathPolicy, resolveWorkspacePath, workspacePathInScopes } from "../security/workspace-path.js";
import { openWorkspace } from "../storage/workspace.js";

const execFileAsync = promisify(execFile);
const DISABLED_GIT_PATH = process.platform === "win32" ? "NUL" : "/dev/null";
const GIT_HARDENING_ARGS = [
  "--no-optional-locks",
  "-c", "core.fsmonitor=false",
  "-c", `core.hooksPath=${DISABLED_GIT_PATH}`,
  "-c", `core.attributesFile=${DISABLED_GIT_PATH}`,
  "-c", `core.excludesFile=${DISABLED_GIT_PATH}`,
  "-c", `mailmap.file=${DISABLED_GIT_PATH}`,
  "-c", "log.mailmap=false",
  "-c", "log.showSignature=false",
  "-c", "gc.auto=0",
  "-c", "maintenance.auto=false",
  "-c", "protocol.allow=never"
] as const;
const MAX_GIT_METADATA_ENTRIES = 100_000;
const MAX_GIT_METADATA_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_GIT_METADATA_DEPTH = 64;
const GIT_COMMANDS = {
  status: ["status", "--porcelain=v1", "-z", "--branch", "--untracked-files=all", "--ignore-submodules=all"],
  log: ["log", "--no-decorate", "--format=%H%x09%an%x09%ad%x09%s", "--date=iso-strict"],
  diff: ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--ignore-submodules=all"],
  show: ["show", "--no-ext-diff", "--no-textconv", "--no-renames", "--format=fuller", "--stat"],
  branch: ["branch", "--no-color", "--all"]
} as const;

export type GitReadOperation = keyof typeof GIT_COMMANDS;

export interface GitReadRequest {
  operation: GitReadOperation;
  revision?: string;
  path?: string;
  limit?: number;
}

/** Runs Git without inherited repository/config/object redirection variables. */
function gitSafeEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.toUpperCase().startsWith("GIT_")) delete env[key];
  }
  // Do not consult caller-controlled global/system config and do not allow a
  // read command to prompt, replace objects, lazily fetch, or take optional
  // locks. Repository config is still loaded, so the command-line overrides
  // above disable its executable fsmonitor and hook surfaces.
  env.GIT_CONFIG_GLOBAL = DISABLED_GIT_PATH;
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_ATTR_NOSYSTEM = "1";
  env.GIT_NO_LAZY_FETCH = "1";
  env.GIT_NO_REPLACE_OBJECTS = "1";
  env.GIT_OPTIONAL_LOCKS = "0";
  env.GIT_PAGER = "cat";
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}

interface GitProcessOptions {
  timeout?: number;
  maxBuffer?: number;
}

interface GitProcessResult {
  argv: string[];
  stdout: string;
  stderr: string;
}

/** Every Git subprocess in this module passes through this hardened runner. */
async function execGit(workspace: string, commandArgs: readonly string[], options: GitProcessOptions = {}): Promise<GitProcessResult> {
  const argv = [...GIT_HARDENING_ARGS, ...commandArgs];
  const result = await execFileAsync("git", argv, {
    cwd: workspace,
    env: gitSafeEnv(),
    encoding: "utf8",
    timeout: options.timeout ?? 5_000,
    maxBuffer: options.maxBuffer ?? 64 * 1024,
    windowsHide: true,
    shell: false
  });
  return { argv, stdout: result.stdout, stderr: result.stderr };
}

/**
 * Fail-closed git boundary: git reads must not leave the workspace. The
 * workspace itself must be the top level of the git repository; nested
 * repositories or non-repository workspaces are rejected.
 */
export async function assertGitRepoWithinWorkspace(workspace: string): Promise<void> {
  try {
    await assertGitRepoWithinWorkspaceImpl(workspace);
  } catch {
    throw new Error("Git repository boundary exceeds the workspace.");
  }
}

async function assertGitRepoWithinWorkspaceImpl(workspace: string): Promise<void> {
  const requestedWorkspace = path.resolve(workspace);
  const workspaceStat = await lstat(requestedWorkspace);
  if (workspaceStat.isSymbolicLink() || !workspaceStat.isDirectory()) throw new Error("invalid workspace");
  const workspaceReal = await realpath(requestedWorkspace);

  // Reject .git indirection before invoking Git. This excludes linked
  // worktrees, separate/external gitdirs, and a symlinked metadata root.
  const expectedGitDir = path.join(workspaceReal, ".git");
  await assertCanonicalDirectory(workspaceReal, expectedGitDir);
  await assertOptionalRegularFile(workspaceReal, path.join(expectedGitDir, "config"));
  await assertOptionalRegularFile(workspaceReal, path.join(expectedGitDir, "config.worktree"));
  await assertNoGitdirIndirection(workspaceReal, path.join(expectedGitDir, "commondir"));
  await assertNoGitdirIndirection(workspaceReal, path.join(expectedGitDir, "gitdir"));
  const traversal = createMetadataTraversal();
  await assertSafeMetadataTree(workspaceReal, expectedGitDir, traversal);
  await assertSafeLocalConfig(workspaceReal);

  const { stdout } = await execGit(workspaceReal, [
    "rev-parse",
    "--show-toplevel",
    "--absolute-git-dir",
    "--path-format=absolute",
    "--git-common-dir",
    "--git-path", "objects",
    "--git-path", "index"
  ]);
  const records = stdout.split(/\r?\n/).filter((record) => record.length > 0);
  if (records.length !== 5) throw new Error("malformed repository paths");
  const [topLevel, gitDir, commonDir, objectDir, indexPath] = records;
  if (topLevel === undefined || gitDir === undefined || commonDir === undefined || objectDir === undefined || indexPath === undefined) {
    throw new Error("missing repository paths");
  }

  const topLevelReal = await assertCanonicalDirectory(workspaceReal, topLevel);
  const gitDirReal = await assertCanonicalDirectory(workspaceReal, gitDir);
  const commonDirReal = await assertCanonicalDirectory(workspaceReal, commonDir);
  const objectDirReal = await assertCanonicalDirectory(workspaceReal, objectDir);
  await assertCanonicalFileCandidate(workspaceReal, indexPath);
  if (topLevelReal !== workspaceReal || gitDirReal !== expectedGitDir || commonDirReal !== expectedGitDir) {
    throw new Error("repository paths do not match workspace");
  }

  await assertObjectDatabaseChain(workspaceReal, objectDirReal, new Set<string>(), traversal);
}

interface MetadataTraversal {
  entries: number;
  bytes: number;
  visitedDirectories: Set<string>;
}

function createMetadataTraversal(): MetadataTraversal {
  return { entries: 0, bytes: 0, visitedDirectories: new Set<string>() };
}

/**
 * Walks Git-controlled metadata without following links or special files.
 * A shared bounded budget covers the primary gitdir and every internal
 * alternate object database, preventing an attacker from turning preflight
 * itself into an unbounded filesystem walk.
 */
async function assertSafeMetadataTree(
  workspaceReal: string,
  root: string,
  traversal: MetadataTraversal,
  depth = 0
): Promise<void> {
  if (depth > MAX_GIT_METADATA_DEPTH) throw new Error("git metadata tree is too deep");
  const canonicalRoot = await assertCanonicalDirectory(workspaceReal, root);
  if (traversal.visitedDirectories.has(canonicalRoot)) return;
  traversal.visitedDirectories.add(canonicalRoot);

  const directory = await opendir(canonicalRoot);
  for await (const entry of directory) {
    traversal.entries += 1;
    if (traversal.entries > MAX_GIT_METADATA_ENTRIES) throw new Error("git metadata tree has too many entries");
    const entryPath = path.join(canonicalRoot, entry.name);
    const stat = await lstat(entryPath);
    if (stat.isSymbolicLink()) throw new Error("symbolic git metadata is not permitted");
    if (stat.isDirectory()) {
      await assertSafeMetadataTree(workspaceReal, entryPath, traversal, depth + 1);
      continue;
    }
    if (!stat.isFile()) throw new Error("special git metadata files are not permitted");
    traversal.bytes += stat.size;
    if (!Number.isSafeInteger(traversal.bytes) || traversal.bytes > MAX_GIT_METADATA_BYTES) {
      throw new Error("git metadata tree is too large");
    }
  }
}

async function assertSafeLocalConfig(workspace: string): Promise<void> {
  for (const scope of ["--local", "--worktree"] as const) {
    const { stdout } = await execGit(workspace, ["config", scope, "--no-includes", "--null", "--name-only", "--list"]);
    for (const rawKey of stdout.split("\0")) {
      if (rawKey.length === 0) continue;
      const key = rawKey.toLowerCase();
      if (key === "include.path" || key.startsWith("includeif.")) throw new Error("git config includes are not permitted");
      if (/^filter\..+\.(clean|process|required|smudge)$/.test(key)) throw new Error("git content filters are not permitted");
      if (key === "diff.external" || /^diff\..+\.(command|textconv)$/.test(key)) throw new Error("git external diff drivers are not permitted");
      if (key === "core.attributesfile" || key === "core.excludesfile") throw new Error("external git metadata is not permitted");
      if (key === "mailmap.file") throw new Error("external git mailmap files are not permitted");
      if (key === "extensions.partialclone" || /^remote\..+\.(partialclonefilter|promisor)$/.test(key)) {
        throw new Error("promisor repository config is not permitted");
      }
    }
  }
}

async function assertCanonicalDirectory(workspaceReal: string, candidate: string): Promise<string> {
  const resolved = assertLexicallyWithinWorkspace(workspaceReal, candidate);
  await assertNoSymlinkComponents(workspaceReal, resolved, false);
  const stat = await lstat(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("repository directory is not canonical");
  const canonical = await realpath(resolved);
  if (canonical !== resolved || !isWithinWorkspace(workspaceReal, canonical)) throw new Error("repository directory escapes workspace");
  return canonical;
}

async function assertCanonicalFileCandidate(workspaceReal: string, candidate: string): Promise<void> {
  const resolved = assertLexicallyWithinWorkspace(workspaceReal, candidate);
  const exists = await assertNoSymlinkComponents(workspaceReal, resolved, true);
  if (!exists) return;
  const stat = await lstat(resolved);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("repository file is not canonical");
  const canonical = await realpath(resolved);
  if (canonical !== resolved || !isWithinWorkspace(workspaceReal, canonical)) throw new Error("repository file escapes workspace");
}

async function assertOptionalRegularFile(workspaceReal: string, candidate: string): Promise<void> {
  const resolved = assertLexicallyWithinWorkspace(workspaceReal, candidate);
  const exists = await assertNoSymlinkComponents(workspaceReal, resolved, true);
  if (!exists) return;
  const stat = await lstat(resolved);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("repository metadata file is not canonical");
}

async function assertNoGitdirIndirection(workspaceReal: string, candidate: string): Promise<void> {
  const resolved = assertLexicallyWithinWorkspace(workspaceReal, candidate);
  if (await assertNoSymlinkComponents(workspaceReal, resolved, true)) {
    throw new Error("gitdir indirection is not permitted");
  }
}

async function assertNoSymlinkComponents(workspaceReal: string, target: string, allowMissingLeaf: boolean): Promise<boolean> {
  const relative = path.relative(workspaceReal, target);
  const components = relative === "" ? [] : relative.split(path.sep);
  let current = workspaceReal;
  for (let index = 0; index < components.length; index += 1) {
    const component = components[index];
    if (component === undefined) throw new Error("invalid repository path");
    current = path.join(current, component);
    let stat: Stats;
    try {
      stat = await lstat(current);
    } catch (error: unknown) {
      if (allowMissingLeaf && index === components.length - 1 && isCode(error, "ENOENT")) return false;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error("symbolic repository paths are not permitted");
    if (index < components.length - 1 && !stat.isDirectory()) throw new Error("repository path ancestor is not a directory");
  }
  return true;
}

function assertLexicallyWithinWorkspace(workspaceReal: string, candidate: string): string {
  if (!path.isAbsolute(candidate)) throw new Error("repository path is not absolute");
  const resolved = path.resolve(candidate);
  if (resolved !== candidate || !isWithinWorkspace(workspaceReal, resolved)) throw new Error("repository path escapes workspace");
  return resolved;
}

function isWithinWorkspace(workspaceReal: string, candidate: string): boolean {
  const relative = path.relative(workspaceReal, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function assertObjectDatabaseChain(
  workspaceReal: string,
  objectDir: string,
  visited: Set<string>,
  traversal: MetadataTraversal
): Promise<void> {
  if (visited.has(objectDir)) return;
  visited.add(objectDir);
  await assertSafeMetadataTree(workspaceReal, objectDir, traversal);
  await assertNoPromisorPack(workspaceReal, objectDir);

  const alternatesFile = path.join(objectDir, "info", "alternates");
  const exists = await assertNoSymlinkComponents(workspaceReal, alternatesFile, true);
  if (!exists) return;
  const stat = await lstat(alternatesFile);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error("invalid object alternates file");
  const contents = await readFile(alternatesFile, "utf8");
  if (contents.includes("\0")) throw new Error("invalid object alternates file");
  for (const rawLine of contents.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.length === 0) continue;
    const alternate = path.isAbsolute(line) ? path.resolve(line) : path.resolve(objectDir, line);
    const alternateReal = await assertCanonicalDirectory(workspaceReal, alternate);
    await assertObjectDatabaseChain(workspaceReal, alternateReal, visited, traversal);
  }
}

async function assertNoPromisorPack(workspaceReal: string, objectDir: string): Promise<void> {
  const packDir = path.join(objectDir, "pack");
  const exists = await assertNoSymlinkComponents(workspaceReal, packDir, true);
  if (!exists) return;
  const stat = await lstat(packDir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("invalid object pack directory");
  const entries = await readdir(packDir);
  if (entries.some((entry) => entry.endsWith(".promisor"))) throw new Error("promisor object databases are not permitted");
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

export async function runGitRead(access: ToolAccess, request: GitReadRequest): Promise<ToolOutcome<{ argv: string[]; stdout: string; stderr: string }>> {
  const decision = authorize(access, "git-read");
  if (!decision.allowed) return denied(decision);
  const base = GIT_COMMANDS[request.operation];
  if (!base) throw new Error("Unsupported git read operation.");
  if (request.revision !== undefined) {
    if (request.operation !== "show") throw new Error("A revision is only supported for git show.");
    validateGitRevision(request.revision);
  }
  if ((request.operation === "status" || request.operation === "log" || request.operation === "branch")
      && !workspacePathInScopes(access.lease.readScope, ".")) {
    throw new Error("Git aggregate operations require repository-wide readScope.");
  }
  await assertGitRepoWithinWorkspace(access.workspace);
  const workspace = await openWorkspace(access.workspace);
  const restrictedShow = request.operation === "show" && !workspacePathInScopes(access.lease.readScope, ".");
  const showRevision = restrictedShow
    ? await resolveCommitRevision(workspace.root, request.revision ?? "HEAD")
    : request.revision;
  // Treat the authorized path as a literal filename, never as Git pathspec magic.
  const commandArgs: string[] = ["--literal-pathspecs", ...base];
  if (restrictedShow) {
    const formatIndex = commandArgs.indexOf("--format=fuller");
    if (formatIndex >= 0) commandArgs[formatIndex] = "--format=";
    commandArgs.push("--no-notes");
  }

  if ((request.operation === "diff" || request.operation === "show") && request.path === undefined) {
    throw new Error("Git diff and show require an explicit repository-relative path.");
  }

  if (request.operation === "log") {
    const limit = request.limit ?? 20;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("limit must be between 1 and 100.");
    commandArgs.push(`-n${limit}`);
  }
  if (showRevision !== undefined) commandArgs.push(showRevision);
  if (request.path !== undefined) {
    if (request.operation !== "diff" && request.operation !== "show") throw new Error("A path is only supported for git diff and git show.");
    const cfg = await loadOrchestrationConfig(workspace);
    const resolved = await resolveWorkspacePath(workspace.root, request.path, {
      allowMissing: true,
      readScope: access.lease.readScope,
      ...(cfg.sensitiveExtraPaths === undefined ? {} : { sensitiveExtraPaths: cfg.sensitiveExtraPaths })
    });
    await assertSingleGitFile(workspace.root, request.operation, resolved.relativePath, resolved.exists, resolved.stat, showRevision);
    commandArgs.push("--", resolved.relativePath);
  }

  const result = await execGit(workspace.root, commandArgs, { timeout: 15_000, maxBuffer: 1024 * 1024 });
  let stdout = result.stdout;
  if (request.operation === "status") {
    const cfg = await loadOrchestrationConfig(workspace);
    assertGitStatusPaths(stdout, cfg.sensitiveExtraPaths);
    // The NUL form is used for unambiguous validation; expose a readable form
    // only after every path has passed the same workspace path policy.
    stdout = stdout.replaceAll("\0", "\n");
  }
  return { decision, data: { argv: result.argv, stdout, stderr: result.stderr } };
}

function assertGitStatusPaths(stdout: string, sensitiveExtraPaths?: string[]): void {
  const records = stdout.split("\0").filter((record) => record.length > 0);
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record === undefined || record.startsWith("## ")) continue;
    if (record.length < 4 || record[2] !== " ") throw new Error("Git status output is malformed.");
    assertStatusPath(record.slice(3), sensitiveExtraPaths);
    const status = record.slice(0, 2);
    if (status.includes("R") || status.includes("C")) {
      const sourcePath = records[index + 1];
      if (sourcePath === undefined) throw new Error("Git status rename output is malformed.");
      assertStatusPath(sourcePath, sensitiveExtraPaths);
      index += 1;
    }
  }
}

function assertStatusPath(relativePath: string, sensitiveExtraPaths?: string[]): void {
  try {
    assertWorkspacePathPolicy(relativePath, {
      ...(sensitiveExtraPaths === undefined ? {} : { sensitiveExtraPaths })
    });
  } catch {
    // Do not echo the forbidden filename in an error that may be returned to a
    // caller without permission to observe that name.
    throw new Error("Git status contains a path forbidden by the workspace path policy.");
  }
}

function validateGitRevision(value: string): void {
  validateCommandArgument(value);
  if (value.startsWith("-") || value.includes("..") || value.includes("/") || value.includes(":")) {
    throw new Error("Git revisions must be a single safe revision name.");
  }
}

async function resolveCommitRevision(workspace: string, revision: string): Promise<string> {
  try {
    const { stdout } = await execGit(workspace, ["rev-parse", "--verify", "--end-of-options", `${revision}^{commit}`]);
    const oid = stdout.trim();
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid)) throw new Error("invalid commit object ID");
    return oid;
  } catch {
    throw new Error("Git show revision must resolve to a commit.");
  }
}

async function assertSingleGitFile(
  workspace: string,
  operation: "diff" | "show",
  relativePath: string,
  exists: boolean,
  stat: Stats | undefined,
  revision?: string
): Promise<void> {
  if (relativePath === "." || (exists && stat?.isFile() !== true)) {
    throw new Error("Git diff and show require one regular file path, not a directory or special file.");
  }

  if (operation === "show") {
    const entry = await readTreeEntry(workspace, revision ?? "HEAD", relativePath);
    if (entry === undefined || entry.path !== relativePath || entry.type !== "blob" || !entry.mode.startsWith("100")) {
      throw new Error("Git show path must resolve to exactly one regular file blob at the requested revision.");
    }
    return;
  }

  const indexEntries = await readIndexEntries(workspace, relativePath);
  if (indexEntries.some((entry) => entry.path !== relativePath || !entry.mode.startsWith("100") || entry.stage !== "0") || indexEntries.length > 1) {
    throw new Error("Git diff path must identify exactly one regular file.");
  }
  const headEntry = await readTreeEntry(workspace, "HEAD", relativePath);
  if (headEntry !== undefined && (headEntry.path !== relativePath || headEntry.type !== "blob" || !headEntry.mode.startsWith("100"))) {
    throw new Error("Git diff path must identify exactly one regular file.");
  }
  if (!exists && indexEntries.length === 0 && headEntry === undefined) {
    throw new Error("Git diff path does not identify a known regular file.");
  }
}

interface TreeEntry { mode: string; type: string; path: string }

async function readTreeEntry(workspace: string, revision: string, relativePath: string): Promise<TreeEntry | undefined> {
  const { stdout } = await execGit(
    workspace,
    ["--literal-pathspecs", "ls-tree", "-z", "--full-tree", revision, "--", relativePath],
    { maxBuffer: 256 * 1024 }
  );
  const records = stdout.split("\0").filter(Boolean);
  if (records.length === 0) return undefined;
  if (records.length !== 1) throw new Error("Git path resolves to multiple tree entries.");
  const record = records[0];
  if (record === undefined) return undefined;
  const separator = record.indexOf("\t");
  if (separator < 0) throw new Error("Git tree entry is malformed.");
  const [mode, type] = record.slice(0, separator).split(" ");
  if (mode === undefined || type === undefined) throw new Error("Git tree entry is malformed.");
  return { mode, type, path: record.slice(separator + 1) };
}

async function readIndexEntries(workspace: string, relativePath: string): Promise<Array<{ mode: string; stage: string; path: string }>> {
  const { stdout } = await execGit(
    workspace,
    ["--literal-pathspecs", "ls-files", "--stage", "-z", "--", relativePath],
    { maxBuffer: 256 * 1024 }
  );
  return stdout.split("\0").filter(Boolean).map((record) => {
    const separator = record.indexOf("\t");
    if (separator < 0) throw new Error("Git index entry is malformed.");
    const [mode, , stage] = record.slice(0, separator).split(" ");
    if (mode === undefined || stage === undefined) throw new Error("Git index entry is malformed.");
    return { mode, stage, path: record.slice(separator + 1) };
  });
}
