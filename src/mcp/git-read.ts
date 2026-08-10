import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";
import { authorize, denied, validateCommandArgument, type ToolAccess, type ToolOutcome } from "./shared.js";

const execFileAsync = promisify(execFile);
const GIT_COMMANDS = {
  status: ["status", "--short", "--branch"],
  log: ["log", "--no-decorate", "--format=%H%x09%an%x09%ad%x09%s", "--date=iso-strict"],
  diff: ["diff", "--no-ext-diff"],
  show: ["show", "--no-ext-diff", "--format=fuller", "--stat"],
  branch: ["branch", "--no-color", "--all"]
} as const;

export type GitReadOperation = keyof typeof GIT_COMMANDS;

export interface GitReadRequest {
  operation: GitReadOperation;
  revision?: string;
  path?: string;
  limit?: number;
}

/** Runs git without inherited repository redirection variables. */
function gitSafeEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  return env;
}

/**
 * Fail-closed git boundary: git reads must not leave the workspace. The
 * workspace itself must be the top level of the git repository; nested
 * repositories or non-repository workspaces are rejected.
 */
export async function assertGitRepoWithinWorkspace(workspace: string): Promise<void> {
  let stdout: string;
  try {
    const result = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
      cwd: workspace,
      env: gitSafeEnv(),
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 64 * 1024,
      windowsHide: true,
      shell: false
    });
    stdout = result.stdout;
  } catch {
    throw new Error("Git repository boundary exceeds the workspace.");
  }
  const toplevel = stdout.trim();
  const workspaceReal = await realpath(workspace);
  if (!toplevel || path.resolve(toplevel) !== workspaceReal) {
    throw new Error("Git repository boundary exceeds the workspace.");
  }
}

export async function runGitRead(access: ToolAccess, request: GitReadRequest): Promise<ToolOutcome<{ argv: string[]; stdout: string; stderr: string }>> {
  const decision = authorize(access, "git-read");
  if (!decision.allowed) return denied(decision);
  await assertGitRepoWithinWorkspace(access.workspace);
  const base = GIT_COMMANDS[request.operation];
  if (!base) throw new Error("Unsupported git read operation.");
  const argv: string[] = [...base];

  if (request.operation === "log") {
    const limit = request.limit ?? 20;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("limit must be between 1 and 100.");
    argv.push(`-n${limit}`);
  }
  if (request.revision) {
    if (request.operation !== "show") throw new Error("A revision is only supported for git show.");
    validateGitToken(request.revision);
    argv.push(request.revision);
  }
  if (request.path) {
    if (request.operation !== "diff" && request.operation !== "show") throw new Error("A path is only supported for git diff and git show.");
    validateGitToken(request.path);
    argv.push(request.path);
  }
  if (request.operation === "diff" || request.operation === "show") argv.push("--");

  const { stdout, stderr } = await execFileAsync("git", argv, {
    cwd: access.workspace,
    env: gitSafeEnv(),
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
    shell: false
  });
  return { decision, data: { argv, stdout, stderr } };
}

function validateGitToken(value: string): void {
  validateCommandArgument(value);
  if (value.startsWith("-") || value.includes("..") || value.includes("/")) throw new Error("Git arguments must be a single safe revision or repository-relative path.");
}
