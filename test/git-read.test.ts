import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { runGitRead, assertGitRepoWithinWorkspace } from "../src/mcp/git-read.js";
import type { ToolAccess } from "../src/mcp/shared.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const gitAvailable = (() => {
  try {
    execFileAsync("git", ["--version"]);
    return true;
  } catch {
    return false;
  }
})();

function access(workspace: string): ToolAccess {
  return { lease: { id: "lease", taskId: "task", agentId: "agent", role: "scout", capability: "git-read", level: "L0", workspace, readScope: ["."], writeSet: [], issuedAt: "2026-01-01T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z", maxToolCalls: 2, status: "active" }, taskId: "task", role: "scout", workspace };
}

async function tmp(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "stinky-git-"));
  roots.push(dir);
  return dir;
}

async function initRepo(dir: string): Promise<string> {
  await execFileAsync("git", ["init", "-q", dir]);
  await execFileAsync("git", ["-C", dir, "config", "user.name", "test"]);
  await execFileAsync("git", ["-C", dir, "config", "user.email", "test@example.com"]);
  await writeFile(path.join(dir, "README.md"), "git-read evidence\n", "utf8");
  await execFileAsync("git", ["-C", dir, "add", "README.md"]);
  await execFileAsync("git", ["-C", dir, "commit", "-q", "-m", "initial commit"]);
  return dir;
}

describe("git-read boundary and revision handling", () => {
  it.skipIf(!gitAvailable)("places the terminator after the revision so git show honors it", async () => {
    const repo = await initRepo(await tmp());
    const result = await runGitRead(access(repo), { operation: "show", revision: "HEAD" });
    expect(result.decision.allowed).toBe(true);
    const argv = result.data!.argv;
    const dashIndex = argv.indexOf("--");
    const revisionIndex = argv.indexOf("HEAD");
    expect(revisionIndex).toBeGreaterThan(-1);
    expect(dashIndex).toBeGreaterThan(revisionIndex);
    expect(result.data!.stdout).toContain("initial commit");
  });

  it.skipIf(!gitAvailable)("shows HEAD when no revision is given", async () => {
    const repo = await initRepo(await tmp());
    const result = await runGitRead(access(repo), { operation: "show" });
    expect(result.decision.allowed).toBe(true);
    expect(result.data!.stdout).toContain("initial commit");
  });

  it.skipIf(!gitAvailable)("rejects workspaces that are not git repository top levels", async () => {
    const repo = await initRepo(await tmp());
    const subdir = path.join(repo, "subdir");
    await mkdir(subdir);
    await writeFile(path.join(subdir, "note.txt"), "x", "utf8");
    await expect(runGitRead(access(subdir), { operation: "status" })).rejects.toThrow(/Git repository boundary exceeds/);
  });

  it.skipIf(!gitAvailable)("rejects non-repository workspaces", async () => {
    const dir = await tmp();
    await expect(runGitRead(access(dir), { operation: "status" })).rejects.toThrow(/Git repository boundary exceeds/);
  });

  it.skipIf(!gitAvailable)("keeps revision token validation fail-closed", async () => {
    const repo = await initRepo(await tmp());
    await expect(runGitRead(access(repo), { operation: "show", revision: "-x" })).rejects.toThrow();
    await expect(runGitRead(access(repo), { operation: "show", revision: "../outside" })).rejects.toThrow();
  });

  it("exposes the toplevel assertion for direct testing", async () => {
    const repo = await initRepo(await tmp());
    await expect(assertGitRepoWithinWorkspace(repo)).resolves.toBeUndefined();
  });
});
