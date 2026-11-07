import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(import.meta.dirname, "..", "..");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function run(env: NodeJS.ProcessEnv, ...args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(process.execPath, [path.join(projectRoot, "dist/cli.js"), ...args], {
    cwd: projectRoot,
    env,
    maxBuffer: 1024 * 1024
  });
}

describe("cli presenter", () => {
  it("prints a task table without --json and JSON with --json", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "stinky-cli-present-")));
    roots.push(root);
    const env = { ...process.env };
    await run(env, "init", "--workspace-id", "present", "--profile", "team", "--pack", "software-engineering", "--root", root, "--json");
    await writeFile(path.join(root, "task.json"), JSON.stringify({
      id: "present-task",
      workspaceId: "present",
      goal: "Show the table",
      requestedOutputs: ["report"],
      riskLevel: "L0",
      state: "DRAFT"
    }));
    await run(env, "task", "create", "--file", path.join(root, "task.json"), "--root", root, "--json");

    const human = await run(env, "task", "list", "--root", root);
    expect(human.stdout.split("\n")[0]).toContain("TASK ID");
    const json = JSON.parse((await run(env, "task", "list", "--root", root, "--json")).stdout) as Array<{ id: string }>;
    expect(json.some((task) => task.id === "present-task")).toBe(true);
  });

  it("exits 1 when install-host refuses a user-edited managed file", async () => {
    const home = await realpath(await mkdtemp(path.join(tmpdir(), "stinky-cli-conflict-")));
    roots.push(home);
    const env = { ...process.env, HOME: home, USERPROFILE: home };
    await run(env, "entry", "install-host", "--host", "zcode", "--scope", "user", "--json");
    const commandFile = path.join(home, ".zcode", "commands", "stinky-cobbler.md");
    const edited = `${await readFile(commandFile, "utf8")}\n<!-- user edit -->\n`;
    await writeFile(commandFile, edited);
    const failure = await run(env, "entry", "install-host", "--host", "zcode", "--scope", "user", "--json").then(() => null, (error: unknown) => error as { code?: number; stdout?: string });
    expect(failure?.code).toBe(1);
    expect(await readFile(commandFile, "utf8")).toBe(edited);
  });
});
