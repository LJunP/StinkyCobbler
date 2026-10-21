import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
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
    const doctor = JSON.parse((await run(env, "toolkit", "doctor", "--json")).stdout) as { drift: unknown[]; secrets: unknown[] };
    expect(doctor.drift).toEqual([]);
    expect(doctor.secrets).toEqual([]);
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
    await run(env, "toolkit", "lock", "--json");

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
    const doctor = JSON.parse(doctorText) as { drift: unknown[]; env: unknown[]; commands: unknown[]; secrets: Array<{ code: string; hint: string }> };
    expect(doctor.drift).toEqual([]);
    expect(doctor.env).toEqual([{ name: "STINKY_TEST_FS_TOKEN", present: true }]);
    expect(doctor.commands).toEqual([{ command: "stinky-cobbler-missing-cmd", present: false }]);
    expect(doctor.secrets).toEqual([
      expect.objectContaining({ code: "SECRET_NEEDS_SHELL_ENV", host: "codex", name: "STINKY_TEST_FS_TOKEN" })
    ]);
    expect(doctor.secrets[0]?.hint).toContain("wrapper");
    expect(doctorText).not.toContain(secret);

    const rolled = JSON.parse((await run(env, "toolkit", "rollback", "--last", "--json")).stdout) as { restored: string[]; conflict?: unknown };
    expect(rolled.conflict).toBeUndefined();
    expect(rolled.restored).toEqual([toml, skillFile]);
    await expect(readFile(skillFile, "utf8")).rejects.toThrow();
    await expect(readFile(toml, "utf8")).rejects.toThrow();
  });

  it("uses documented host syntax for secret hints and does not invent a ZCode result", async () => {
    const home = await tempDir("stinky-toolkit-secret-home-");
    const xdg = await tempDir("stinky-toolkit-secret-xdg-");
    const env = childEnv(home, xdg, { STINKY_TEST_FS_TOKEN: secret });
    await run(env, "toolkit", "init", "--json");
    await writeFile(path.join(xdg, "stinky-cobbler", "toolkit.yaml"), [
      "version: 1",
      "scope: user",
      "hosts:",
      "  - zcode",
      "  - codex",
      "  - claude-code",
      "  - cursor",
      "skills: []",
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
    const text = (await run(env, "toolkit", "doctor", "--json")).stdout;
    const doctor = JSON.parse(text) as { secrets: Array<{ code: string; host: string; name: string; hint: string }> };
    expect(doctor.secrets.map((item) => [item.code, item.host, item.name])).toEqual([
      ["SECRET_EXPANSION_UNKNOWN", "zcode", "STINKY_TEST_FS_TOKEN"],
      ["SECRET_NEEDS_SHELL_ENV", "codex", "STINKY_TEST_FS_TOKEN"],
      ["SECRET_NEEDS_SHELL_ENV", "claude-code", "STINKY_TEST_FS_TOKEN"]
    ]);
    expect(doctor.secrets.filter((item) => item.code === "SECRET_NEEDS_SHELL_ENV").every((item) => item.hint.includes("wrapper"))).toBe(true);
    expect(doctor.secrets.some((item) => item.host === "cursor")).toBe(false);
    expect(text).not.toContain(secret);
  });

  it("writes a local content hash and does not fetch a remote source", async () => {
    const home = await tempDir("stinky-toolkit-lock-home-");
    const xdg = await tempDir("stinky-toolkit-lock-xdg-");
    const source = await tempDir("stinky-toolkit-lock-source-");
    const env = childEnv(home, xdg);
    const body = "review the diff\n";
    await writeFile(path.join(source, "SKILL.md"), body);
    await run(env, "toolkit", "init", "--json");
    await writeFile(path.join(xdg, "stinky-cobbler", "toolkit.yaml"), [
      "version: 1",
      "scope: user",
      "skills:",
      "  - id: review",
      `    source: ${JSON.stringify(source)}`,
      "  - id: remote-skill",
      "    source: npm:example@1.0.0",
      "mcpServers: []",
      "instructions:",
      "  - id: missing-notes",
      `    source: ${JSON.stringify(path.join(source, "missing.md"))}`,
      "bundles: []",
      ""
    ].join("\n"));
    const before = await treeHash(home);
    const text = (await run(env, "toolkit", "lock", "--json")).stdout;
    const lock = JSON.parse(text) as { entries: Array<{ kind: string; id: string; resolved: string; sha256?: string }> };
    expect(lock.entries.map((entry) => [entry.kind, entry.id, entry.resolved, entry.sha256])).toEqual([
      ["skill", "review", "local", createHash("sha256").update(body).digest("hex")],
      ["skill", "remote-skill", "not-fetched", undefined],
      ["instructions", "missing-notes", "absent", undefined]
    ]);
    expect(lock.entries[1]).not.toHaveProperty("sha256");
    expect(text).not.toContain("should-not-be-hashed");
    const written = JSON.parse(await readFile(path.join(xdg, "stinky-cobbler", "toolkit.lock"), "utf8")) as { entries: unknown[] };
    expect(written.entries).toEqual(lock.entries);
    expect(await treeHash(home)).toBe(before);
  });

  it("applies the locked skill bytes after the source file changes", async () => {
    const home = await tempDir("stinky-toolkit-apply-lock-home-");
    const xdg = await tempDir("stinky-toolkit-apply-lock-xdg-");
    const source = await tempDir("stinky-toolkit-apply-lock-source-");
    const env = childEnv(home, xdg);
    const locked = "locked body\n";
    const skillFile = path.join(source, "SKILL.md");
    await writeFile(skillFile, locked);
    await run(env, "toolkit", "init", "--json");
    await writeFile(path.join(xdg, "stinky-cobbler", "toolkit.yaml"), [
      "version: 1",
      "scope: user",
      "hosts:",
      "  - codex",
      "skills:",
      "  - id: review",
      `    source: ${JSON.stringify(source)}`,
      "mcpServers: []",
      "instructions: []",
      "bundles: []",
      ""
    ].join("\n"));
    await run(env, "toolkit", "lock", "--json");
    await writeFile(skillFile, "refetched body\n");
    const applied = JSON.parse((await run(env, "toolkit", "apply", "--yes", "--json")).stdout) as { stopped: boolean };
    expect(applied.stopped).toBe(false);
    expect(await readFile(path.join(home, ".codex", "skills", "review", "SKILL.md"), "utf8")).toBe(locked);
    expect(await readFile(skillFile, "utf8")).toBe("refetched body\n");
  });

  it("does not read the source when the locked blob is missing", async () => {
    const home = await tempDir("stinky-toolkit-blob-home-");
    const xdg = await tempDir("stinky-toolkit-blob-xdg-");
    const source = await tempDir("stinky-toolkit-blob-source-");
    const env = childEnv(home, xdg);
    const locked = "locked body\n";
    const skillFile = path.join(source, "SKILL.md");
    await writeFile(skillFile, locked);
    await run(env, "toolkit", "init", "--json");
    await writeFile(path.join(xdg, "stinky-cobbler", "toolkit.yaml"), [
      "version: 1",
      "scope: user",
      "hosts:",
      "  - codex",
      "skills:",
      "  - id: review",
      `    source: ${JSON.stringify(source)}`,
      "mcpServers: []",
      "instructions: []",
      "bundles: []",
      ""
    ].join("\n"));
    await run(env, "toolkit", "lock", "--json");
    await writeFile(skillFile, "refetched body\n");
    const digest = createHash("sha256").update(locked).digest("hex");
    await rm(path.join(xdg, "stinky-cobbler", "blobs", digest));
    const failure = await fail(env, "toolkit", "apply", "--yes", "--json");
    expect(failure.code).toBe(2);
    expect(JSON.parse(failure.stderr ?? "{}")).toMatchObject({ error: "TOOLKIT_LOCK_BLOB_MISSING" });
    await expect(readFile(path.join(home, ".codex", "skills", "review", "SKILL.md"), "utf8")).rejects.toThrow();
    expect(await readFile(skillFile, "utf8")).toBe("refetched body\n");
  });

  it("fetches a git source into an isolated directory and applies it only after confirmation", async () => {
    const home = await tempDir("stinky-toolkit-git-home-");
    const xdg = await tempDir("stinky-toolkit-git-xdg-");
    const repo = await tempDir("stinky-toolkit-git-repo-");
    const marker = path.join(repo, "pwned.txt");
    const body = "from git\n";
    await commitSkillRepo(repo, body, marker);
    const env = childEnv(home, xdg);
    const source = `git+file://${repo}#skills/review`;
    await run(env, "toolkit", "init", "--json");
    await writeFile(path.join(xdg, "stinky-cobbler", "toolkit.yaml"), [
      "version: 1",
      "scope: user",
      "hosts:",
      "  - codex",
      "skills:",
      "  - id: review",
      `    source: ${JSON.stringify(source)}`,
      "mcpServers: []",
      "instructions: []",
      "bundles: []",
      ""
    ].join("\n"));
    const locked = JSON.parse((await run(env, "toolkit", "lock", "--json")).stdout) as { entries: Array<{ resolved: string; sha256?: string }> };
    expect(locked.entries).toEqual([
      expect.objectContaining({ id: "review", resolved: "fetched", sha256: createHash("sha256").update(body).digest("hex") })
    ]);
    const before = await treeHash(home);
    const planned = (await run(env, "toolkit", "plan", "--json")).stdout;
    expect(planned).toContain("from git");
    expect(await treeHash(home)).toBe(before);
    const refused = await fail(env, "toolkit", "apply", "--json");
    expect(refused.code).toBe(2);
    expect(JSON.parse(refused.stderr ?? "{}")).toMatchObject({ error: "TOOLKIT_CONFIRM_REQUIRED" });
    expect(await treeHash(home)).toBe(before);
    const applied = JSON.parse((await run(env, "toolkit", "apply", "--yes", "--json")).stdout) as { stopped: boolean };
    expect(applied.stopped).toBe(false);
    expect(await readFile(path.join(home, ".codex", "skills", "review", "SKILL.md"), "utf8")).toBe(body);
    await expect(readFile(marker, "utf8")).rejects.toThrow();
  });
});

async function commitSkillRepo(repo: string, body: string, marker: string): Promise<void> {
  const env = { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com" };
  await execFileAsync("git", ["init", repo], { env });
  await mkdir(path.join(repo, "skills", "review"), { recursive: true });
  await writeFile(path.join(repo, "skills", "review", "SKILL.md"), body);
  await writeFile(path.join(repo, "skills", "review", "evil.sh"), `#!/bin/sh\necho pwned > ${JSON.stringify(marker)}\n`);
  await execFileAsync("git", ["-C", repo, "add", "."], { env });
  await execFileAsync("git", ["-C", repo, "commit", "-m", "skill"], { env });
}
