import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(import.meta.dirname, "..");
const roots: string[] = [];
const secret = "stinky-secret-value-not-for-files";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface CliFailure {
  code?: number | string;
  stdout?: string;
  stderr?: string;
}

async function run(env: NodeJS.ProcessEnv, ...args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(process.execPath, [path.join(projectRoot, "dist/cli.js"), ...args], {
    cwd: projectRoot,
    env,
    maxBuffer: 1024 * 1024
  });
}

async function fail(env: NodeJS.ProcessEnv, ...args: string[]): Promise<CliFailure> {
  try {
    const result = await run(env, ...args);
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error: unknown) {
    return error as CliFailure;
  }
}

async function tempDir(prefix: string): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), prefix)));
  roots.push(root);
  return root;
}

function childEnv(home: string, xdg: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...process.env, ...extra, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: xdg };
}

async function treeHash(root: string): Promise<string> {
  const hash = createHash("sha256");
  await hashTree(root, root, hash);
  return hash.digest("hex");
}

async function hashTree(root: string, dir: string, hash: ReturnType<typeof createHash>): Promise<void> {
  const entries = (await readdir(dir, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    hash.update(`${path.relative(root, full)}\0${entry.isSymbolicLink() ? "l" : entry.isDirectory() ? "d" : "f"}`);
    if (entry.isDirectory() && !entry.isSymbolicLink()) await hashTree(root, full, hash);
    else if (entry.isFile()) hash.update(await readFile(full));
  }
}

describe("toolkit cli", () => {
  it("leaves an empty home unchanged from init through doctor and fails closed on rollback", async () => {
    const home = await tempDir("stinky-toolkit-home-");
    const xdg = await tempDir("stinky-toolkit-xdg-");
    const env = childEnv(home, xdg);
    const specFile = path.join(xdg, "stinky-cobbler", "toolkit.yaml");

    const init = JSON.parse((await run(env, "toolkit", "init", "--json")).stdout) as { path: string; scope: string; detectedHosts: string[] };
    expect(init).toMatchObject({ path: specFile, scope: "user", detectedHosts: [] });
    const spec = await readFile(specFile, "utf8");
    expect(spec).toContain("version: 1");
    expect(spec).toContain("${env:NAME}");
    const before = await treeHash(home);

    const planned = JSON.parse((await run(env, "toolkit", "plan", "--json")).stdout) as { ops: unknown[]; conflicts: unknown[]; diffs: unknown[] };
    expect(planned.ops).toEqual([]);
    expect(planned.conflicts).toEqual([]);
    expect(planned.diffs).toEqual([]);
    expect(await readFile(specFile, "utf8")).toBe(spec);
    expect(await treeHash(home)).toBe(before);

    const applied = JSON.parse((await run(env, "toolkit", "apply", "--json")).stdout) as { stopped: boolean; completed: unknown[] };
    expect(applied.stopped).toBe(false);
    expect(applied.completed).toEqual([]);
    const doctor = JSON.parse((await run(env, "toolkit", "doctor", "--json")).stdout) as { drift: unknown[] };
    expect(doctor.drift).toEqual([]);
    expect(Array.isArray(JSON.parse((await run(env, "toolkit", "list", "--json")).stdout))).toBe(true);
    expect(await treeHash(home)).toBe(before);

    const again = await fail(env, "toolkit", "init", "--json");
    expect(again.code).toBe(7);
    expect(JSON.parse(again.stderr ?? "{}")).toMatchObject({ error: "TOOLKIT_EXISTS" });
    expect(await readFile(specFile, "utf8")).toBe(spec);

    const rollback = await fail(env, "toolkit", "rollback", "--last", "--json");
    expect(rollback.code).toBe(2);
    expect(JSON.parse(rollback.stderr ?? "{}")).toMatchObject({ error: "TOOLKIT_LEDGER_EMPTY" });
    expect(await treeHash(home)).toBe(before);
  });

  it("requires --yes before writing and never prints a secret value", async () => {
    const home = await tempDir("stinky-toolkit-write-home-");
    const xdg = await tempDir("stinky-toolkit-write-xdg-");
    const source = await tempDir("stinky-toolkit-source-");
    const env = childEnv(home, xdg, { STINKY_TEST_FS_TOKEN: secret });
    await writeFile(path.join(source, "SKILL.md"), "review the diff\n");
    await run(env, "toolkit", "init", "--json");
    const specFile = path.join(xdg, "stinky-cobbler", "toolkit.yaml");
    await writeFile(specFile, [
      "version: 1",
      "scope: user",
      "hosts:",
      "  - codex",
      "skills:",
      "  - id: review",
      `    source: ${JSON.stringify(source)}`,
      "mcpServers:",
      "  - id: filesystem",
      "    transport: stdio",
      "    command: stinky-cobbler-missing-cmd",
      "    env:",
      '      FS_TOKEN: "${env:STINKY_TEST_FS_TOKEN}"',
      "instructions: []",
      "bundles: []",
      ""
    ].join("\n"));
    const before = await treeHash(home);

    const plannedText = (await run(env, "toolkit", "plan", "--json")).stdout;
    const planned = JSON.parse(plannedText) as { ops: Array<{ action: string }>; diffs: unknown[] };
    expect(planned.ops.map((op) => op.action)).toEqual(["create", "merge-mcp"]);
    expect(planned.diffs).toHaveLength(2);
    expect(plannedText).not.toContain(secret);
    expect(await treeHash(home)).toBe(before);

    const refused = await fail(env, "toolkit", "apply", "--json");
    expect(refused.code).toBe(2);
    expect(JSON.parse(refused.stderr ?? "{}")).toMatchObject({ error: "TOOLKIT_CONFIRM_REQUIRED" });
    expect(await treeHash(home)).toBe(before);

    const appliedText = (await run(env, "toolkit", "apply", "--yes", "--json")).stdout;
    const applied = JSON.parse(appliedText) as { stopped: boolean };
    expect(applied.stopped).toBe(false);
    expect(appliedText).not.toContain(secret);
    const skillFile = path.join(home, ".codex", "skills", "review", "SKILL.md");
    const toml = path.join(home, ".codex", "config.toml");
    expect(await readFile(skillFile, "utf8")).toBe("review the diff\n");
    expect(await readFile(toml, "utf8")).not.toContain(secret);

    const doctorText = (await run(env, "toolkit", "doctor", "--json")).stdout;
    const doctor = JSON.parse(doctorText) as { drift: unknown[]; env: unknown[]; commands: unknown[] };
    expect(doctor.drift).toEqual([]);
    expect(doctor.env).toEqual([{ name: "STINKY_TEST_FS_TOKEN", present: true }]);
    expect(doctor.commands).toEqual([{ command: "stinky-cobbler-missing-cmd", present: false }]);
    expect(doctorText).not.toContain(secret);

    const rolled = JSON.parse((await run(env, "toolkit", "rollback", "--last", "--json")).stdout) as { restored: string[]; conflict?: unknown };
    expect(rolled.conflict).toBeUndefined();
    expect(rolled.restored).toEqual([toml, skillFile]);
    await expect(readFile(skillFile, "utf8")).rejects.toThrow();
    await expect(readFile(toml, "utf8")).rejects.toThrow();
  });
});
