import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
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

function access(workspace: string, readScope = ["."]): ToolAccess {
  return { lease: { id: "lease", taskId: "task", agentId: "agent", role: "scout", capability: "git-read", level: "L0", workspace, readScope, writeSet: [], issuedAt: "2026-01-01T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z", maxToolCalls: 2, status: "active" }, taskId: "task", role: "scout", workspace };
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
    const result = await runGitRead(access(repo), { operation: "show", revision: "HEAD", path: "README.md" });
    expect(result.decision.allowed).toBe(true);
    const argv = result.data!.argv;
    const dashIndex = argv.indexOf("--");
    const revisionIndex = argv.indexOf("HEAD");
    expect(argv).toContain("--no-optional-locks");
    expect(argv).toContain("--no-renames");
    expect(argv).toContain("core.fsmonitor=false");
    expect(argv.some((argument) => argument.startsWith("core.hooksPath="))).toBe(true);
    expect(argv.some((argument) => argument.startsWith("core.attributesFile="))).toBe(true);
    expect(argv.some((argument) => argument.startsWith("core.excludesFile="))).toBe(true);
    expect(argv.some((argument) => argument.startsWith("mailmap.file="))).toBe(true);
    expect(argv).toContain("log.mailmap=false");
    expect(revisionIndex).toBeGreaterThan(-1);
    expect(dashIndex).toBeGreaterThan(revisionIndex);
    expect(result.data!.stdout).toContain("initial commit");
  });

  it.skipIf(!gitAvailable)("shows a declared path from HEAD when no revision is given", async () => {
    const repo = await initRepo(await tmp());
    const result = await runGitRead(access(repo), { operation: "show", path: "README.md" });
    expect(result.decision.allowed).toBe(true);
    expect(result.data!.stdout).toContain("initial commit");
  });

  it.skipIf(!gitAvailable)("suppresses repository-wide commit metadata for a path-scoped show", async () => {
    const repo = await initRepo(await tmp());
    await mkdir(path.join(repo, "docs"));
    await writeFile(path.join(repo, "docs", "guide.md"), "scoped content\n", "utf8");
    await execFileAsync("git", ["-C", repo, "add", "docs/guide.md"]);
    await execFileAsync("git", ["-C", repo, "commit", "-q", "-m", "SCOPE-OUTSIDE-METADATA"]);

    const result = await runGitRead(access(repo, ["docs"]), { operation: "show", revision: "HEAD", path: "docs/guide.md" });
    expect(result.data!.stdout).toContain("docs/guide.md");
    expect(result.data!.stdout).not.toContain("SCOPE-OUTSIDE-METADATA");
    expect(result.data!.argv).toContain("--format=");
  });

  it.skipIf(!gitAvailable)("peels restricted show revisions to a commit and rejects non-commit tree refs", async () => {
    const repo = await initRepo(await tmp());
    await mkdir(path.join(repo, "docs"));
    await writeFile(path.join(repo, "docs", "guide.md"), "scoped content\n", "utf8");
    await execFileAsync("git", ["-C", repo, "add", "docs/guide.md"]);
    await execFileAsync("git", ["-C", repo, "commit", "-q", "-m", "scoped commit"]);
    await execFileAsync("git", ["-C", repo, "tag", "-a", "scoped-tag", "-m", "TAG-OBJECT-SECRET"]);

    const shown = await runGitRead(access(repo, ["docs"]), { operation: "show", revision: "scoped-tag", path: "docs/guide.md" });
    expect(shown.data!.stdout).toContain("docs/guide.md");
    expect(shown.data!.stdout).not.toContain("TAG-OBJECT-SECRET");
    expect(shown.data!.argv).toContain("--no-notes");
    expect(shown.data!.argv).not.toContain("scoped-tag");
    expect(shown.data!.argv.some((argument) => /^[0-9a-f]{40}$/.test(argument))).toBe(true);

    const { stdout: tree } = await execFileAsync("git", ["-C", repo, "rev-parse", "HEAD^{tree}"]);
    await execFileAsync("git", ["-C", repo, "tag", "tree-tag", tree.trim()]);
    await expect(runGitRead(access(repo, ["docs"]), { operation: "show", revision: "tree-tag", path: "docs/guide.md" }))
      .rejects.toThrow(/must resolve to a commit/);
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

  it.skipIf(!gitAvailable)("rejects separate, external, and symlinked gitdirs", async () => {
    const root = await tmp();
    const separateWorkspace = path.join(root, "separate-workspace");
    const separateGitDir = path.join(root, "separate-metadata");
    await execFileAsync("git", ["init", "-q", `--separate-git-dir=${separateGitDir}`, separateWorkspace]);
    await expect(runGitRead(access(separateWorkspace), { operation: "status" }))
      .rejects.toThrow(/Git repository boundary exceeds/);

    const sourceRepo = await initRepo(path.join(root, "source"));
    const symlinkWorkspace = path.join(root, "symlink-workspace");
    await mkdir(symlinkWorkspace);
    await symlink(path.join(sourceRepo, ".git"), path.join(symlinkWorkspace, ".git"), "dir");
    await expect(runGitRead(access(symlinkWorkspace), { operation: "status" }))
      .rejects.toThrow(/Git repository boundary exceeds/);
  });

  it.skipIf(!gitAvailable)("rejects external object alternates and promisor repositories", async () => {
    const root = await tmp();
    const repo = await initRepo(path.join(root, "repo"));
    const external = await initRepo(path.join(root, "external"));
    await mkdir(path.join(repo, ".git", "objects", "info"), { recursive: true });
    await writeFile(path.join(repo, ".git", "objects", "info", "alternates"), `${path.join(external, ".git", "objects")}\n`, "utf8");
    await expect(runGitRead(access(repo), { operation: "status" }))
      .rejects.toThrow(/Git repository boundary exceeds/);

    await rm(path.join(repo, ".git", "objects", "info", "alternates"));
    await execFileAsync("git", ["-C", repo, "config", "remote.origin.promisor", "true"]);
    await expect(runGitRead(access(repo), { operation: "status" }))
      .rejects.toThrow(/Git repository boundary exceeds/);
  });

  it.skipIf(!gitAvailable)("rejects ref and loose-object symlinks that leave the workspace", async () => {
    const root = await tmp();
    const repo = await initRepo(path.join(root, "repo"));
    const { stdout: refNameOutput } = await execFileAsync("git", ["-C", repo, "rev-parse", "--symbolic-full-name", "HEAD"]);
    const { stdout: oidOutput } = await execFileAsync("git", ["-C", repo, "rev-parse", "HEAD"]);
    const refPath = path.join(repo, ".git", refNameOutput.trim());
    const oid = oidOutput.trim();
    const externalRef = path.join(root, "external-ref");
    await writeFile(externalRef, `${oid}\n`, "utf8");
    await rm(refPath);
    await symlink(externalRef, refPath);
    await expect(runGitRead(access(repo), { operation: "status" }))
      .rejects.toThrow(/Git repository boundary exceeds/);

    await rm(refPath);
    await writeFile(refPath, `${oid}\n`, "utf8");
    const looseObject = path.join(repo, ".git", "objects", oid.slice(0, 2), oid.slice(2));
    const externalObject = path.join(root, "external-object");
    await rename(looseObject, externalObject);
    await symlink(externalObject, looseObject);
    await expect(runGitRead(access(repo), { operation: "status" }))
      .rejects.toThrow(/Git repository boundary exceeds/);
  });

  it.skipIf(!gitAvailable)("recursively rejects symlinks inside an internal alternate object database", async () => {
    const root = await tmp();
    const repo = await initRepo(path.join(root, "repo"));
    const alternate = path.join(repo, "alternate-objects");
    await mkdir(path.join(alternate, "info"), { recursive: true });
    await mkdir(path.join(alternate, "pack"), { recursive: true });
    await mkdir(path.join(alternate, "aa"), { recursive: true });
    const externalObject = path.join(root, "alternate-external-object");
    await writeFile(externalObject, "not an object\n", "utf8");
    await symlink(externalObject, path.join(alternate, "aa", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"));
    await writeFile(path.join(repo, ".git", "objects", "info", "alternates"), "../../alternate-objects\n", "utf8");

    await expect(runGitRead(access(repo), { operation: "status" }))
      .rejects.toThrow(/Git repository boundary exceeds/);
  });

  it.skipIf(!gitAvailable)("disables default XDG attributes and excludes files", async () => {
    const root = await tmp();
    const repo = await initRepo(path.join(root, "repo"));
    const xdg = path.join(root, "xdg");
    await mkdir(path.join(xdg, "git"), { recursive: true });
    await writeFile(path.join(xdg, "git", "attributes"), "README.md binary\n", "utf8");
    await writeFile(path.join(xdg, "git", "ignore"), "hidden.txt\n", "utf8");
    await writeFile(path.join(repo, "README.md"), "changed content\n", "utf8");
    await writeFile(path.join(repo, "hidden.txt"), "visible to git-read\n", "utf8");
    const previousXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = xdg;
    try {
      const status = await runGitRead(access(repo), { operation: "status" });
      expect(status.data!.stdout).toContain("hidden.txt");
      expect(status.data!.argv.some((argument) => argument.startsWith("core.excludesFile="))).toBe(true);
      const diff = await runGitRead(access(repo), { operation: "diff", path: "README.md" });
      expect(diff.data!.argv).toContain("--no-renames");
      expect(diff.data!.stdout).toContain("changed content");
      expect(diff.data!.stdout).not.toContain("Binary files");
      expect(diff.data!.argv.some((argument) => argument.startsWith("core.attributesFile="))).toBe(true);
    } finally {
      if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousXdg;
    }
  });

  it.skipIf(!gitAvailable)("disables rename inference for path-scoped diffs", async () => {
    const repo = await initRepo(await tmp());
    await execFileAsync("git", ["-C", repo, "mv", "README.md", "renamed.md"]);

    const result = await runGitRead(access(repo), { operation: "diff", path: "README.md" });
    expect(result.data!.argv).toContain("--no-renames");
    expect(result.data!.stdout).not.toContain("similarity index");
    expect(result.data!.stdout).not.toContain("rename from");
    expect(result.data!.stdout).not.toContain("rename to");
  });

  it.skipIf(!gitAvailable)("does not execute a configured fsmonitor hook", async () => {
    const repo = await initRepo(await tmp());
    const hook = path.join(repo, "fsmonitor-hook");
    const sentinel = `${hook}.ran`;
    await writeFile(hook, "#!/bin/sh\n: > \"$0.ran\"\nexit 0\n", "utf8");
    await chmod(hook, 0o755);
    await execFileAsync("git", ["-C", repo, "config", "core.fsmonitor", hook]);

    if (process.platform !== "win32") {
      await execFileAsync("git", ["-C", repo, "status", "--porcelain"]);
      await expect(readFile(sentinel, "utf8")).resolves.toBe("");
      await rm(sentinel);
    }

    const result = await runGitRead(access(repo), { operation: "status" });
    expect(result.data!.argv).toContain("core.fsmonitor=false");
    await expect(readFile(sentinel, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.skipIf(!gitAvailable)("rejects local includes and executable content filters without running them", async () => {
    const root = await tmp();
    const repo = await initRepo(path.join(root, "repo"));
    const sentinel = path.join(root, "filter-ran");
    const filter = path.join(root, "filter-hook");
    const includedConfig = path.join(root, "outside.config");
    await writeFile(filter, `#!/bin/sh\n: > "${sentinel}"\ncat\n`, "utf8");
    await chmod(filter, 0o755);
    const portableFilterPath = filter.split(path.sep).join("/");
    await writeFile(includedConfig, `[filter "unsafe"]\n\tclean = "${portableFilterPath}"\n`, "utf8");
    await execFileAsync("git", ["-C", repo, "config", "include.path", includedConfig]);

    await expect(runGitRead(access(repo), { operation: "status" }))
      .rejects.toThrow(/Git repository boundary exceeds/);
    await expect(readFile(sentinel, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    await execFileAsync("git", ["-C", repo, "config", "--unset-all", "include.path"]);
    await execFileAsync("git", ["-C", repo, "config", "filter.unsafe.clean", filter]);
    await writeFile(path.join(repo, ".gitattributes"), "README.md filter=unsafe\n", "utf8");
    await expect(runGitRead(access(repo), { operation: "status" }))
      .rejects.toThrow(/Git repository boundary exceeds/);
    await expect(readFile(sentinel, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.skipIf(!gitAvailable)("rejects an external mailmap and disables mailmap rewriting", async () => {
    const root = await tmp();
    const repo = await initRepo(path.join(root, "repo"));
    const mailmap = path.join(root, "outside.mailmap");
    await writeFile(mailmap, "OUTSIDE-AUTHOR <outside@example.com> test <test@example.com>\n", "utf8");
    await execFileAsync("git", ["-C", repo, "config", "mailmap.file", mailmap]);

    await expect(runGitRead(access(repo), { operation: "log" }))
      .rejects.toThrow(/Git repository boundary exceeds/);
  });

  it.skipIf(!gitAvailable)("ignores inherited Git redirection and trace environments", async () => {
    const root = await tmp();
    const repo = await initRepo(path.join(root, "repo"));
    const external = await initRepo(path.join(root, "external"));
    const trace = path.join(root, "git-trace");
    const inherited: Record<string, string> = {
      GIT_DIR: path.join(external, ".git"),
      GIT_WORK_TREE: external,
      GIT_INDEX_FILE: path.join(external, ".git", "index"),
      GIT_OBJECT_DIRECTORY: path.join(external, ".git", "objects"),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(external, ".git", "objects"),
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.fsmonitor",
      GIT_CONFIG_VALUE_0: path.join(external, "untrusted-hook"),
      GIT_TRACE: trace
    };
    const previous = new Map<string, string | undefined>();
    for (const [key, value] of Object.entries(inherited)) {
      previous.set(key, process.env[key]);
      process.env[key] = value;
    }
    try {
      await expect(runGitRead(access(repo), { operation: "status" })).resolves.toMatchObject({ decision: { allowed: true } });
      await expect(readFile(trace, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it.skipIf(!gitAvailable)("keeps revision token validation fail-closed", async () => {
    const repo = await initRepo(await tmp());
    await expect(runGitRead(access(repo), { operation: "show", revision: "-x", path: "README.md" })).rejects.toThrow();
    await expect(runGitRead(access(repo), { operation: "show", revision: "../outside", path: "README.md" })).rejects.toThrow();
  });

  it.skipIf(!gitAvailable)("requires a scoped non-sensitive path for content operations", async () => {
    const repo = await initRepo(await tmp());
    await writeFile(path.join(repo, ".env"), "secret\n", "utf8");
    await writeFile(path.join(repo, "service-credentials.json"), "{}\n", "utf8");
    await expect(runGitRead(access(repo), { operation: "show", revision: "HEAD" })).rejects.toThrow(/explicit/);
    await expect(runGitRead(access(repo, ["docs"]), { operation: "diff", path: "README.md" })).rejects.toThrow(/readScope/);
    await expect(runGitRead(access(repo), { operation: "diff", path: ".env" })).rejects.toThrow(/Sensitive/);
    await expect(runGitRead(access(repo), { operation: "diff", path: "service-credentials.json" })).rejects.toThrow(/Sensitive/);
    await expect(runGitRead(access(repo), { operation: "show", revision: "HEAD:README.md", path: "README.md" })).rejects.toThrow(/revision/);
  });

  it.skipIf(!gitAvailable)("rejects repository-wide metadata operations under a restricted readScope", async () => {
    const repo = await initRepo(await tmp());
    for (const operation of ["status", "log", "branch"] as const) {
      await expect(runGitRead(access(repo, ["docs"]), { operation })).rejects.toThrow(/repository-wide readScope/);
    }
  });

  it.skipIf(!gitAvailable)("does not reveal custom sensitive paths through repository-wide status", async () => {
    const repo = await initRepo(await tmp());
    await mkdir(path.join(repo, ".stinky-cobbler", "policies"), { recursive: true });
    await writeFile(path.join(repo, ".stinky-cobbler", "policies", "orchestration.yaml"), "version: 1\nsensitiveExtraPaths:\n  - docs/internal/\n");
    await writeFile(path.join(repo, ".git", "info", "exclude"), ".stinky-cobbler/\n", "utf8");
    await mkdir(path.join(repo, "docs", "internal"), { recursive: true });
    await writeFile(path.join(repo, "docs", "internal", "note.md"), "private\n", "utf8");

    await expect(runGitRead(access(repo), { operation: "status" }))
      .rejects.toThrow(/forbidden by the workspace path policy/);
  });

  it.skipIf(!gitAvailable)("treats authorized paths literally instead of as pathspec expressions", async () => {
    const repo = await initRepo(await tmp());
    const literalPath = "[ab].md";
    await writeFile(path.join(repo, literalPath), "literal path only\n", "utf8");
    await writeFile(path.join(repo, "a.md"), "pathspec expansion bait\n", "utf8");
    await execFileAsync("git", ["-C", repo, "--literal-pathspecs", "add", "--", literalPath]);
    await execFileAsync("git", ["-C", repo, "commit", "-q", "-m", "literal path"]);
    const result = await runGitRead(access(repo), { operation: "show", revision: "HEAD", path: literalPath });
    expect(result.data!.argv).toContain("--literal-pathspecs");
    expect(result.data!.stdout).toContain(literalPath);
    expect(result.data!.stdout).not.toContain("a.md");
  });

  it.skipIf(!gitAvailable)("rejects aggregate paths and unknown missing paths", async () => {
    const repo = await initRepo(await tmp());
    await mkdir(path.join(repo, "docs"));
    await writeFile(path.join(repo, "docs", "guide.md"), "guide\n", "utf8");
    await expect(runGitRead(access(repo), { operation: "show", revision: "HEAD", path: "." })).rejects.toThrow(/one regular file/);
    await expect(runGitRead(access(repo), { operation: "diff", path: "docs" })).rejects.toThrow(/one regular file/);
    await expect(runGitRead(access(repo), { operation: "diff", path: "missing.md" })).rejects.toThrow(/known regular file/);
  });

  it.skipIf(!gitAvailable)("allows one historical blob and one tracked working-tree deletion", async () => {
    const repo = await initRepo(await tmp());
    await writeFile(path.join(repo, "old.md"), "historical\n", "utf8");
    await execFileAsync("git", ["-C", repo, "add", "old.md"]);
    await execFileAsync("git", ["-C", repo, "commit", "-q", "-m", "add old"]);
    await rm(path.join(repo, "old.md"));
    const diff = await runGitRead(access(repo), { operation: "diff", path: "old.md" });
    expect(diff.data!.stdout).toContain("historical");
    await execFileAsync("git", ["-C", repo, "add", "-u"]);
    await execFileAsync("git", ["-C", repo, "commit", "-q", "-m", "remove old"]);
    const shown = await runGitRead(access(repo), { operation: "show", revision: "HEAD~1", path: "old.md" });
    expect(shown.data!.stdout).toContain("old.md");
  });

  it("exposes the toplevel assertion for direct testing", async () => {
    const repo = await initRepo(await tmp());
    await expect(assertGitRepoWithinWorkspace(repo)).resolves.toBeUndefined();
  });
});
