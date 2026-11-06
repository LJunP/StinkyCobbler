import { afterEach, describe, expect, it } from "vitest";
import { execFile, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { GIT_REPOSITORY_OVERRIDE_VARS, isolateGitEnv } from "./isolate-git.js";

const execFileAsync = promisify(execFile);
const gitAvailable = spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0;
const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const CONFIG_PAIR = /^GIT_CONFIG_(KEY|VALUE)_\d+$/i;

function leakedRepositoryOverrides(env: NodeJS.ProcessEnv): string[] {
  const named = GIT_REPOSITORY_OVERRIDE_VARS.filter((key) => env[key] !== undefined);
  const pairs = Object.keys(env).filter((key) => CONFIG_PAIR.test(key));
  return [...named, ...pairs];
}

/** Never spawn `git init`/`commit` while a locating var is still set. */
function assertIsolatedFromRealRepo(): void {
  const leaked = leakedRepositoryOverrides(process.env);
  if (leaked.length > 0) {
    throw new Error(`refusing to spawn git fixtures; leaked ${leaked.join(", ")}`);
  }
}

async function snapshotCheckout(root: string): Promise<{ head: string; localConfig: string; commonConfig: string }> {
  const git = async (...args: string[]): Promise<string> =>
    (await execFileAsync("git", ["-C", root, ...args], { encoding: "utf8" })).stdout;
  const head = (await git("rev-parse", "HEAD")).trim();
  const localConfig = await git("config", "--local", "--list");
  const commonDir = path.resolve(root, (await git("rev-parse", "--git-common-dir")).trim());
  const commonConfig = await readFile(path.join(commonDir, "config"), "utf8");
  return { head, localConfig, commonConfig };
}

describe("git env isolation", () => {
  it("strips repository-locating vars from a poisoned env object", () => {
    const env: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      GIT_DIR: "/tmp/real.git",
      GIT_WORK_TREE: "/tmp/real",
      GIT_INDEX_FILE: "/tmp/real.git/index",
      GIT_OBJECT_DIRECTORY: "/tmp/real.git/objects",
      GIT_ALTERNATE_OBJECT_DIRECTORIES: "/tmp/other.git/objects",
      GIT_COMMON_DIR: "/tmp/real.git",
      GIT_NAMESPACE: "refs",
      GIT_CEILING_DIRECTORIES: "/tmp",
      GIT_PREFIX: "subdir/",
      GIT_CONFIG: "/tmp/real.git/config",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "user.name",
      GIT_CONFIG_VALUE_0: "developer",
      GIT_CONFIG_PARAMETERS: "'core.bare=true'",
      GIT_AUTHOR_NAME: "keep-me"
    };
    isolateGitEnv(env);
    expect(leakedRepositoryOverrides(env)).toEqual([]);
    expect(env.PATH).toBe("/usr/bin");
    expect(env.GIT_AUTHOR_NAME).toBe("keep-me");
    expect(env.GIT_CONFIG_GLOBAL).toBeTruthy();
    expect(env.GIT_CONFIG_SYSTEM).toBeTruthy();
  });

  it("setup removes GIT_DIR and friends and pins empty identity files", async () => {
    expect(leakedRepositoryOverrides(process.env)).toEqual([]);
    const globalFile = process.env.GIT_CONFIG_GLOBAL;
    const systemFile = process.env.GIT_CONFIG_SYSTEM;
    expect(globalFile).toBeTruthy();
    expect(systemFile).toBeTruthy();
    expect(path.resolve(globalFile!)).not.toBe(path.resolve(os.homedir(), ".gitconfig"));
    expect(await readFile(globalFile!, "utf8")).toBe("");
    expect(await readFile(systemFile!, "utf8")).toBe("");
  });

  it.skipIf(!gitAvailable)("fixture git init and commit do not change the real checkout", async () => {
    assertIsolatedFromRealRepo();
    const before = await snapshotCheckout(repoRoot);
    const fixture = await mkdtemp(path.join(os.tmpdir(), "stinky-git-iso-"));
    roots.push(fixture);
    await execFileAsync("git", ["init", "-q", fixture], { encoding: "utf8" });
    await execFileAsync("git", ["-C", fixture, "config", "user.name", "test"], { encoding: "utf8" });
    await execFileAsync("git", ["-C", fixture, "config", "user.email", "test@example.com"], { encoding: "utf8" });
    await writeFile(path.join(fixture, "README.md"), "isolation fixture\n", "utf8");
    await execFileAsync("git", ["-C", fixture, "add", "README.md"], { encoding: "utf8" });
    await execFileAsync("git", ["-C", fixture, "commit", "-q", "-m", "ISOLATION-FIXTURE-MUST-NOT-LAND-IN-REAL-REPO"], { encoding: "utf8" });
    const fixtureHead = (await execFileAsync("git", ["-C", fixture, "rev-parse", "HEAD"], { encoding: "utf8" })).stdout.trim();
    expect(fixtureHead).toMatch(/^[0-9a-f]{40,}$/);
    expect(fixtureHead).not.toBe(before.head);
    const after = await snapshotCheckout(repoRoot);
    expect(after).toEqual(before);
  });
});
