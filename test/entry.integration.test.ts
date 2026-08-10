import { execFile } from "node:child_process";
import { mkdtemp, rm, mkdir, writeFile, realpath, access, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(import.meta.dirname, "..");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface ExecResult {
  stdout: string;
  stderr: string;
}

async function cli(env: NodeJS.ProcessEnv, ...args: string[]): Promise<ExecResult> {
  return execFileAsync(process.execPath, [path.join(projectRoot, "dist/cli.js"), ...args], {
    cwd: projectRoot,
    maxBuffer: 1024 * 1024,
    env
  });
}

describe("entry CLI black-box", () => {
  it("reports an uninitialized workspace and an initialized one after init", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "stinky-entry-cli-")));
    roots.push(root);
    const env = { ...process.env };
    const before = JSON.parse((await cli(env, "entry", "preflight", "--workspace", root, "--json")).stdout) as { workspaceInitialized: boolean; decision: string };
    expect(before.workspaceInitialized).toBe(false);
    expect(before.decision).toBe("workspace-uninitialized");
    await cli(env, "init", "--workspace-id", "entry-cli", "--profile", "team", "--pack", "software-engineering", "--mode", "reviewed-workflow", "--root", root, "--json");
    const after = JSON.parse((await cli(env, "entry", "preflight", "--workspace", root, "--via", "mcp", "--json")).stdout) as { workspaceInitialized: boolean; decision: string };
    expect(after.workspaceInitialized).toBe(true);
  });

  it("dry-run install-host previews without writing into a fake home", async () => {
    const home = await realpath(await mkdtemp(path.join(tmpdir(), "stinky-entry-home-")));
    roots.push(home);
    const env = { ...process.env, HOME: home };
    const preview = JSON.parse((await cli(env, "entry", "install-host", "--scope", "user", "--dry-run", "--json")).stdout) as { command: { action: string }; skill: { action: string } };
    expect(preview.command.action).toBe("preview");
    expect(preview.skill.action).toBe("preview");
    await expect(access(path.join(home, ".zcode", "commands", "stinky-cobbler.md"))).rejects.toBeTruthy();
    await expect(access(path.join(home, ".zcode", "skills", "stinky-cobbler", "SKILL.md"))).rejects.toBeTruthy();
  });

  it("installs the command and skill into a fake home and reports ready on the second run", async () => {
    const home = await realpath(await mkdtemp(path.join(tmpdir(), "stinky-entry-install-")));
    roots.push(home);
    const env = { ...process.env, HOME: home };
    const first = JSON.parse((await cli(env, "entry", "install-host", "--scope", "user", "--json")).stdout) as { command: { action: string }; skill: { action: string } };
    expect(first.command.action).toBe("installed");
    expect(first.skill.action).toBe("installed");
    const second = JSON.parse((await cli(env, "entry", "install-host", "--scope", "user", "--json")).stdout) as { command: { action: string }; skill: { action: string } };
    expect(second.command.action).toBe("ready");
    expect(second.skill.action).toBe("ready");
    await access(path.join(home, ".zcode", "commands", "stinky-cobbler.md"));
    const installedSkill = await readFile(path.join(home, ".zcode", "skills", "stinky-cobbler", "SKILL.md"), "utf8");
    const bundledSkill = await readFile(path.join(projectRoot, ".zcode", "skills", "stinky-cobbler", "SKILL.md"), "utf8");
    expect(installedSkill).toBe(bundledSkill);
  });

  it("rejects an invalid via with a stable fail-closed result and nonzero exit", async () => {
    const env = { ...process.env };
    let result: ExecResult;
    try {
      result = await cli(env, "entry", "preflight", "--via", "bogus", "--json");
    } catch (error: unknown) {
      const failure = error as NodeJS.ErrnoException & { stdout?: string; code?: number };
      expect(failure.code).toBe(2);
      const parsed = JSON.parse(failure.stdout ?? "{}") as { viaValid: boolean; decision: string };
      expect(parsed.viaValid).toBe(false);
      expect(parsed.decision).toBe("invalid-via");
      return;
    }
    throw new Error(`expected failure but got: ${JSON.stringify(result)}`);
  });

  it("prints a stable MCP registration template", async () => {
    const env = { ...process.env };
    const output = JSON.parse((await cli(env, "entry", "mcp-config", "--json")).stdout) as { mcp: { servers: Record<string, { command: string; args: string[] }> } };
    expect(output.mcp.servers["stinky-cobbler-local"]).toMatchObject({ command: expect.stringContaining("stinky-cobbler-mcp"), args: [] });
  });

  it("installs the codex host into a fake home with a TOML MCP registration", async () => {
    const home = await realpath(await mkdtemp(path.join(tmpdir(), "stinky-entry-codex-")));
    roots.push(home);
    const env = { ...process.env, HOME: home };
    const first = JSON.parse((await cli(env, "entry", "install-host", "--host", "codex", "--scope", "user", "--mcp", "--json")).stdout) as { host: string; command: { action: string }; skill: { action: string }; mcp: { action: string } };
    expect(first.host).toBe("codex");
    expect(first.command.action).toBe("skipped");
    expect(first.skill.action).toBe("installed");
    expect(first.mcp.action).toBe("installed");
    await access(path.join(home, ".codex", "skills", "stinky-cobbler", "SKILL.md"));
    const toml = await readFile(path.join(home, ".codex", "config.toml"), "utf8");
    expect(toml).toContain("stinky-cobbler-mcp");
    const again = JSON.parse((await cli(env, "entry", "install-host", "--host", "codex", "--scope", "user", "--mcp", "--json")).stdout) as { command: { action: string }; skill: { action: string }; mcp: { action: string } };
    expect(again.command.action).toBe("skipped");
    expect(again.skill.action).toBe("ready");
    expect(again.mcp.action).toBe("ready");
  });
});
