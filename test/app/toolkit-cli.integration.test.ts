import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { parse as parseToml } from "smol-toml";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(import.meta.dirname, "..", "..");
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
  return runIn(projectRoot, env, ...args);
}

async function runIn(cwd: string, env: NodeJS.ProcessEnv, ...args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(process.execPath, [path.join(projectRoot, "dist/cli.js"), ...args], { cwd, env, maxBuffer: 1024 * 1024 });
}

async function fail(env: NodeJS.ProcessEnv, ...args: string[]): Promise<CliFailure> {
  return failIn(projectRoot, env, ...args);
}

async function failIn(cwd: string, env: NodeJS.ProcessEnv, ...args: string[]): Promise<CliFailure> {
  try {
    const result = await runIn(cwd, env, ...args);
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
      "    source: skills.sh:example",
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

  it("locks an npm package without running its scripts and applies the locked bytes", async () => {
    const home = await tempDir("stinky-toolkit-npm-home-");
    const xdg = await tempDir("stinky-toolkit-npm-xdg-");
    const pkg = await tempDir("stinky-toolkit-npm-pkg-");
    const marker = path.join(pkg, "pwned.txt");
    const body = "from npm\n";
    await writeFile(path.join(pkg, "package.json"), JSON.stringify({
      name: "stinky-npm-fixture",
      version: "1.0.0",
      scripts: { prepare: "node -e \"require('fs').writeFileSync(process.env.STINKY_PWN_MARKER,'pwned')\"" }
    }));
    await writeFile(path.join(pkg, "SKILL.md"), body);
    const env = childEnv(home, xdg, { STINKY_PWN_MARKER: marker });
    await run(env, "toolkit", "init", "--json");
    await writeFile(path.join(xdg, "stinky-cobbler", "toolkit.yaml"), [
      "version: 1",
      "scope: user",
      "hosts:",
      "  - codex",
      "skills:",
      "  - id: review",
      `    source: ${JSON.stringify(`npm:${pkg}`)}`,
      "mcpServers: []",
      "instructions: []",
      "bundles: []",
      ""
    ].join("\n"));
    const locked = JSON.parse((await run(env, "toolkit", "lock", "--json")).stdout) as { entries: Array<{ resolved: string; sha256?: string }> };
    expect(locked.entries).toEqual([
      expect.objectContaining({ id: "review", resolved: "fetched", sha256: createHash("sha256").update(body).digest("hex") })
    ]);
    await writeFile(path.join(pkg, "SKILL.md"), "changed after lock\n");
    const before = await treeHash(home);
    expect((await run(env, "toolkit", "plan", "--json")).stdout).toContain("from npm");
    const refused = await fail(env, "toolkit", "apply", "--json");
    expect(refused.code).toBe(2);
    expect(JSON.parse(refused.stderr ?? "{}")).toMatchObject({ error: "TOOLKIT_CONFIRM_REQUIRED" });
    expect(await treeHash(home)).toBe(before);
    const applied = JSON.parse((await run(env, "toolkit", "apply", "--yes", "--json")).stdout) as { stopped: boolean };
    expect(applied.stopped).toBe(false);
    expect(await readFile(path.join(home, ".codex", "skills", "review", "SKILL.md"), "utf8")).toBe(body);
    await expect(readFile(marker, "utf8")).rejects.toThrow();
  });

  it("expands a bundle only for includes already resolved in the lock", async () => {
    const home = await tempDir("stinky-toolkit-bundle-home-");
    const xdg = await tempDir("stinky-toolkit-bundle-xdg-");
    const source = await tempDir("stinky-toolkit-bundle-source-");
    const body = "bundled review\n";
    await writeFile(path.join(source, "SKILL.md"), body);
    const env = childEnv(home, xdg);
    await run(env, "toolkit", "init", "--json");
    await writeFile(path.join(xdg, "stinky-cobbler", "toolkit.yaml"), [
      "version: 1",
      "scope: user",
      "hosts:",
      "  - codex",
      "skills:",
      "  - id: review",
      `    source: ${JSON.stringify(source)}`,
      "  - id: remote-skill",
      "    source: skills.sh:example",
      "mcpServers: []",
      "instructions: []",
      "bundles:",
      "  - id: kit",
      "    includes: [review, remote-skill]",
      ""
    ].join("\n"));
    await run(env, "toolkit", "lock", "--json");
    const planned = JSON.parse((await run(env, "toolkit", "plan", "--json")).stdout) as {
      ops: Array<{ id: string }>;
      skipped: Array<{ kind: string; id: string; reason: string }>;
    };
    expect(planned.ops.map((op) => op.id)).toEqual(["review"]);
    expect(planned.skipped).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "bundle", id: "kit", reason: "Include review is expanded from the lock." }),
      expect.objectContaining({ kind: "bundle", id: "kit", reason: "Include remote-skill is not resolved in the lock." })
    ]));
    expect(JSON.stringify(planned.skipped)).not.toContain("Bundle expansion is not applied");
    const applied = JSON.parse((await run(env, "toolkit", "apply", "--yes", "--json")).stdout) as { stopped: boolean };
    expect(applied.stopped).toBe(false);
    expect(await readFile(path.join(home, ".codex", "skills", "review", "SKILL.md"), "utf8")).toBe(body);
    await expect(readFile(path.join(home, ".codex", "skills", "remote-skill", "SKILL.md"), "utf8")).rejects.toThrow();
  });

  it("fails closed on toolkit search and writes nothing", async () => {
    const home = await tempDir("stinky-toolkit-search-home-");
    const xdg = await tempDir("stinky-toolkit-search-xdg-");
    const env = childEnv(home, xdg);
    const homeBefore = await treeHash(home);
    const xdgBefore = await treeHash(xdg);
    const failure = await fail(env, "toolkit", "search", "review", "--json");
    expect(failure.code).toBe(2);
    expect(JSON.parse(failure.stderr ?? "{}")).toMatchObject({ error: "TOOLKIT_SEARCH_UNVERIFIED" });
    expect(`${failure.stdout ?? ""}\n${failure.stderr ?? ""}`).not.toContain("skills.sh");
    expect(await treeHash(home)).toBe(homeBefore);
    expect(await treeHash(xdg)).toBe(xdgBefore);
    await expect(readFile(path.join(home, ".codex", "skills", "remote-skill", "SKILL.md"), "utf8")).rejects.toThrow();
  });

  it("refreshes a git source into a plan diff and does not write the host", async () => {
    const home = await tempDir("stinky-toolkit-update-home-");
    const xdg = await tempDir("stinky-toolkit-update-xdg-");
    const repo = await tempDir("stinky-toolkit-update-repo-");
    const marker = path.join(repo, "pwned.txt");
    const lockedBody = "locked git\n";
    const refreshed = "refreshed git\n";
    await commitSkillRepo(repo, lockedBody, marker);
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
    await run(env, "toolkit", "lock", "--json");
    await run(env, "toolkit", "apply", "--yes", "--json");
    const installed = path.join(home, ".codex", "skills", "review", "SKILL.md");
    expect(await readFile(installed, "utf8")).toBe(lockedBody);
    await writeFile(path.join(repo, "skills", "review", "SKILL.md"), refreshed);
    const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com" };
    await execFileAsync("git", ["-C", repo, "add", "."], { env: gitEnv });
    await execFileAsync("git", ["-C", repo, "commit", "-m", "refresh"], { env: gitEnv });
    const lockFile = path.join(xdg, "stinky-cobbler", "toolkit.lock");
    const lockBefore = await readFile(lockFile, "utf8");
    const homeBefore = await treeHash(home);
    const planned = JSON.parse((await run(env, "toolkit", "plan", "--json")).stdout) as { ops: unknown[] };
    expect(planned.ops).toEqual([]);
    const updated = JSON.parse((await run(env, "toolkit", "update", "--json")).stdout) as { ops: Array<{ bytes?: string }>; diffs: string[] };
    expect(updated.diffs.join("\n")).toContain("refreshed git");
    expect(updated.ops.map((op) => op.bytes)).toContain(refreshed);
    expect(await readFile(installed, "utf8")).toBe(lockedBody);
    expect(await readFile(lockFile, "utf8")).toBe(lockBefore);
    expect(await treeHash(home)).toBe(homeBefore);
    await expect(readFile(marker, "utf8")).rejects.toThrow();
  });

  it("does not index knowledge sources when doctor has no server tool response", async () => {
    const home = await tempDir("stinky-toolkit-knowledge-home-");
    const xdg = await tempDir("stinky-toolkit-knowledge-xdg-");
    const notes = path.join(xdg, "notes");
    const sentinel = "knowledge-sentinel-not-an-index";
    await writeFile(notes, `${sentinel}\n`);
    const env = childEnv(home, xdg);
    await run(env, "toolkit", "init", "--json");
    await writeFile(path.join(xdg, "stinky-cobbler", "toolkit.yaml"), [
      "version: 1",
      "scope: user",
      "skills: []",
      "mcpServers:",
      "  - id: docs-rag",
      "    transport: stdio",
      "    command: cognee-mcp",
      "    role: knowledge",
      "    sources:",
      `      - ${JSON.stringify(notes)}`,
      "instructions: []",
      "bundles: []",
      ""
    ].join("\n"));
    const homeBefore = await treeHash(home);
    const doctorText = (await run(env, "toolkit", "doctor", "--json")).stdout;
    const doctor = JSON.parse(doctorText) as { freshness: Array<{ serverId: string; status: string }> };
    expect(doctor.freshness).toEqual([{ serverId: "docs-rag", status: "unavailable" }]);
    expect(doctorText).not.toContain(sentinel);
    expect(await treeHash(home)).toBe(homeBefore);
  });

  it("renders a memory instruction inside the managed segment and leaves the surrounding bytes", async () => {
    const home = await tempDir("stinky-toolkit-memory-home-");
    const xdg = await tempDir("stinky-toolkit-memory-xdg-");
    const source = await tempDir("stinky-toolkit-memory-source-");
    const original = "keep-before\n\nkeep-after\n";
    const memory = "remember this\n";
    const claudeMd = path.join(home, ".claude", "CLAUDE.md");
    await mkdir(path.dirname(claudeMd), { recursive: true });
    await writeFile(claudeMd, original);
    await writeFile(path.join(source, "memory.md"), memory);
    const env = childEnv(home, xdg);
    await run(env, "toolkit", "init", "--json");
    await writeFile(path.join(xdg, "stinky-cobbler", "toolkit.yaml"), [
      "version: 1",
      "scope: user",
      "hosts:",
      "  - claude-code",
      "skills: []",
      "mcpServers: []",
      "instructions:",
      "  - id: my-memory",
      `    source: ${JSON.stringify(path.join(source, "memory.md"))}`,
      "    kind: memory",
      "    render:",
      "      claude-code: CLAUDE.md",
      "bundles: []",
      ""
    ].join("\n"));
    await run(env, "toolkit", "lock", "--json");
    const applied = JSON.parse((await run(env, "toolkit", "apply", "--yes", "--json")).stdout) as { stopped: boolean };
    expect(applied.stopped).toBe(false);
    const text = await readFile(claudeMd, "utf8");
    expect(text.startsWith(original)).toBe(true);
    expect(text).toContain("<!-- stinky-cobbler:begin my-memory -->");
    expect(text).toContain(memory);
    expect(text).toContain("<!-- stinky-cobbler:end my-memory -->");
    expect(text.slice(0, original.length)).toBe(original);
  });

  it("syncs managed memory markdown and does not copy other files", async () => {
    const home = await tempDir("stinky-toolkit-memory-dir-home-");
    const xdg = await tempDir("stinky-toolkit-memory-dir-xdg-");
    const source = await tempDir("stinky-toolkit-memory-dir-source-");
    const original = "keep-before\n\nkeep-after\n";
    const claudeMd = path.join(home, ".claude", "CLAUDE.md");
    await mkdir(path.dirname(claudeMd), { recursive: true });
    await writeFile(claudeMd, original);
    await writeFile(path.join(source, "index.md"), "index body\n");
    await writeFile(path.join(source, "topic.md"), "topic body\n");
    await writeFile(path.join(source, "notes.txt"), "do-not-copy\n");
    const env = childEnv(home, xdg);
    await run(env, "toolkit", "init", "--json");
    await writeFile(path.join(xdg, "stinky-cobbler", "toolkit.yaml"), [
      "version: 1",
      "scope: user",
      "hosts:",
      "  - claude-code",
      "skills: []",
      "mcpServers: []",
      "instructions:",
      "  - id: my-memory",
      `    source: ${JSON.stringify(path.join(source, "index.md"))}`,
      "    kind: memory",
      `    files: ${JSON.stringify(source)}`,
      "    render:",
      "      claude-code: CLAUDE.md",
      "bundles: []",
      ""
    ].join("\n"));
    await run(env, "toolkit", "lock", "--json");
    const applied = JSON.parse((await run(env, "toolkit", "apply", "--yes", "--json")).stdout) as { stopped: boolean };
    expect(applied.stopped).toBe(false);
    const text = await readFile(claudeMd, "utf8");
    expect(text.startsWith(original)).toBe(true);
    expect(text).toContain("index body\n");
    expect(text).toContain("<!-- stinky-cobbler:begin topic -->");
    expect(text).toContain("topic body\n");
    expect(text).not.toContain("do-not-copy");
  });

  it("shows the managed memory segment and replaces only that segment", async () => {
    const home = await tempDir("stinky-memory-cli-home-");
    const xdg = await tempDir("stinky-memory-cli-xdg-");
    const prefix = "keep-before old-outside\n";
    const suffix = "keep-after\n";
    const claudeMd = path.join(home, ".claude", "CLAUDE.md");
    const original = `${prefix}<!-- stinky-cobbler:begin my-memory -->\nold\n<!-- stinky-cobbler:end my-memory -->\n${suffix}`;
    await mkdir(path.dirname(claudeMd), { recursive: true });
    await writeFile(claudeMd, original);
    const env = childEnv(home, xdg);
    const shown = JSON.parse((await run(env, "toolkit", "memory", "show", "my-memory", "--host", "claude-code", "--json")).stdout) as { bytes: string };
    expect(shown.bytes).toBe("old\n");
    expect(shown.bytes).not.toContain("old-outside");
    await expect(readFile(`${claudeMd}.stinky-cobbler-managed.json`, "utf8")).rejects.toThrow();
    expect(await readFile(claudeMd, "utf8")).toBe(original);
    const replacement = path.join(xdg, "next.txt");
    await writeFile(replacement, "new body\n");
    await run(env, "toolkit", "memory", "edit", "my-memory", "--file", replacement, "--host", "claude-code", "--json");
    const next = `${prefix}<!-- stinky-cobbler:begin my-memory -->\nnew body\n<!-- stinky-cobbler:end my-memory -->\n${suffix}`;
    expect(await readFile(claudeMd, "utf8")).toBe(next);
    const missed = await fail(env, "toolkit", "memory", "edit", "missing-id", "--file", replacement, "--host", "claude-code", "--json");
    expect(missed.code).toBe(2);
    expect(JSON.parse(missed.stderr ?? "{}")).toMatchObject({ error: "SEGMENT_INVALID" });
    expect(await readFile(claudeMd, "utf8")).toBe(next);
  });

  it("applies a plain instruction segment", async () => {
    const home = await tempDir("stinky-plain-instruction-home-");
    const xdg = await tempDir("stinky-plain-instruction-xdg-");
    const source = await tempDir("stinky-plain-instruction-source-");
    const body = "use short paragraphs\n";
    await writeFile(path.join(source, "notes.md"), body);
    const env = childEnv(home, xdg);
    await run(env, "toolkit", "init", "--json");
    await writeFile(path.join(xdg, "stinky-cobbler", "toolkit.yaml"), [
      "version: 1",
      "scope: user",
      "hosts:",
      "  - claude-code",
      "skills: []",
      "mcpServers: []",
      "instructions:",
      "  - id: notes",
      `    source: ${JSON.stringify(path.join(source, "notes.md"))}`,
      "    render:",
      "      claude-code: CLAUDE.md",
      "bundles: []",
      ""
    ].join("\n"));
    await run(env, "toolkit", "lock", "--json");
    const applied = JSON.parse((await run(env, "toolkit", "apply", "--yes", "--json")).stdout) as { stopped: boolean; completed: Array<{ kind: string }> };
    expect(applied.stopped).toBe(false);
    expect(applied.completed.some((op) => op.kind === "instructions")).toBe(true);
    const text = await readFile(path.join(home, ".claude", "CLAUDE.md"), "utf8");
    expect(text).toContain("<!-- stinky-cobbler:begin notes -->");
    expect(text).toContain(body);
  });

  it("does not restore an mcp server deleted from a hand-edited managed file", async () => {
    const home = await tempDir("stinky-mcp-edit-home-");
    const xdg = await tempDir("stinky-mcp-edit-xdg-");
    const env = childEnv(home, xdg);
    const specFile = path.join(xdg, "stinky-cobbler", "toolkit.yaml");
    await run(env, "toolkit", "init", "--json");
    await writeFile(specFile, mcpSpec("echo"));
    await run(env, "toolkit", "apply", "--yes", "--json");
    const toml = path.join(home, ".codex", "config.toml");
    const edited = "# edited\n";
    await writeFile(toml, edited);
    const doctor = JSON.parse((await run(env, "toolkit", "doctor", "--json")).stdout) as { drift: Array<{ kind: string; state: string }> };
    expect(doctor.drift).toEqual([expect.objectContaining({ kind: "mcp-server", id: "files", state: "managed-modified" })]);
    const refused = await fail(env, "toolkit", "apply", "--yes", "--json");
    expect(refused.code).toBe(7);
    expect(JSON.parse(refused.stderr ?? "{}")).toMatchObject({ error: "TOOLKIT_CONFLICT" });
    expect(await readFile(toml, "utf8")).toBe(edited);
  });

  it("reports drift when a managed mcp command no longer matches the spec", async () => {
    const home = await tempDir("stinky-mcp-drift-home-");
    const xdg = await tempDir("stinky-mcp-drift-xdg-");
    const env = childEnv(home, xdg);
    const specFile = path.join(xdg, "stinky-cobbler", "toolkit.yaml");
    await run(env, "toolkit", "init", "--json");
    await writeFile(specFile, mcpSpec("echo"));
    await run(env, "toolkit", "apply", "--yes", "--json");
    const toml = path.join(home, ".codex", "config.toml");
    const installed = await readFile(toml, "utf8");
    expect(installed).toContain("echo");
    await writeFile(specFile, mcpSpec("printf"));
    const doctor = JSON.parse((await run(env, "toolkit", "doctor", "--json")).stdout) as { drift: Array<{ kind: string; id: string }> };
    expect(doctor.drift).toEqual([expect.objectContaining({ kind: "mcp-server", id: "files", state: "managed-modified" })]);
    const refused = await fail(env, "toolkit", "apply", "--yes", "--json");
    expect(refused.code).toBe(7);
    expect(await readFile(toml, "utf8")).toBe(installed);
  });
  it("exits 7 when rollback meets a hand-edited managed file and still prints the report", async () => {
    const home = await tempDir("stinky-rollback-conflict-home-");
    const xdg = await tempDir("stinky-rollback-conflict-xdg-");
    const env = childEnv(home, xdg);
    await run(env, "toolkit", "init", "--json");
    await writeFile(path.join(xdg, "stinky-cobbler", "toolkit.yaml"), mcpSpec("echo"));
    await run(env, "toolkit", "apply", "--yes", "--json");
    const toml = path.join(home, ".codex", "config.toml");
    const edited = `${await readFile(toml, "utf8")}# user edit\n`;
    await writeFile(toml, edited);
    const failure = await fail(env, "toolkit", "rollback", "--last", "--json");
    expect(failure.code).toBe(7);
    expect(JSON.parse(failure.stdout ?? "{}")).toMatchObject({ restored: [], conflict: { path: toml } });
    expect(await readFile(toml, "utf8")).toBe(edited);
  });

  it("exits 6 when apply stops partway and still prints the rollback hint", async () => {
    const home = await tempDir("stinky-apply-stopped-home-");
    const xdg = await tempDir("stinky-apply-stopped-xdg-");
    const source = await tempDir("stinky-apply-stopped-source-");
    const env = childEnv(home, xdg);
    await writeFile(path.join(source, "SKILL.md"), "review the diff\n");
    await mkdir(path.join(home, ".codex"), { recursive: true });
    await writeFile(path.join(home, ".codex", "skills"), "not a directory\n");
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
    const failure = await fail(env, "toolkit", "apply", "--yes", "--json");
    expect(failure.code).toBe(6);
    expect(JSON.parse(failure.stdout ?? "{}")).toMatchObject({ stopped: true, completed: [], hint: "toolkit rollback --last", error: { code: expect.any(String) } });
    expect(await readFile(path.join(home, ".codex", "skills"), "utf8")).toBe("not a directory\n");
  });

  it("skips Cursor project rules instead of treating the rules directory as a segment file", async () => {
    const home = await tempDir("stinky-cursor-rules-home-");
    const xdg = await tempDir("stinky-cursor-rules-xdg-");
    const cwd = await tempDir("stinky-cursor-rules-cwd-");
    const env = childEnv(home, xdg);
    const source = path.join(cwd, "my-style.md");
    await writeFile(source, "Use short paragraphs.\n");
    await runIn(cwd, env, "toolkit", "init", "--scope", "project", "--json");
    await writeFile(path.join(cwd, ".stinky-cobbler", "toolkit.yaml"), [
      "version: 1",
      "scope: project",
      "hosts:",
      "  - cursor",
      "skills: []",
      "mcpServers: []",
      "instructions:",
      "  - id: my-style",
      `    source: ${JSON.stringify(source)}`,
      "    render:",
      "      cursor: .cursor/rules/my-style.mdc",
      "bundles: []",
      ""
    ].join("\n"));
    await runIn(cwd, env, "toolkit", "lock", "--scope", "project", "--json");
    const skip = expect.objectContaining({ host: "cursor", kind: "instructions", id: "my-style", reason: expect.stringContaining("md-segment") });
    const absent = JSON.parse((await runIn(cwd, env, "toolkit", "plan", "--scope", "project", "--json")).stdout) as { ops: unknown[]; conflicts: unknown[]; skipped: unknown[] };
    expect(absent.ops).toEqual([]);
    expect(absent.conflicts).toEqual([]);
    expect(absent.skipped).toEqual([skip]);
    const rules = path.join(cwd, ".cursor", "rules");
    await mkdir(rules, { recursive: true });
    await writeFile(path.join(rules, "existing.mdc"), "keep\n");
    const before = await treeHash(cwd);
    const present = JSON.parse((await runIn(cwd, env, "toolkit", "plan", "--scope", "project", "--json")).stdout) as { ops: unknown[]; conflicts: unknown[]; skipped: unknown[] };
    expect(present.ops).toEqual([]);
    expect(present.conflicts).toEqual([]);
    expect(present.skipped).toEqual([skip]);
    const applied = JSON.parse((await runIn(cwd, env, "toolkit", "apply", "--yes", "--scope", "project", "--json")).stdout) as { stopped: boolean; completed: unknown[] };
    expect(applied).toMatchObject({ stopped: false, completed: [] });
    const doctor = JSON.parse((await runIn(cwd, env, "toolkit", "doctor", "--scope", "project", "--json")).stdout) as { drift: unknown[] };
    expect(doctor.drift).toEqual([]);
    expect(await treeHash(cwd)).toBe(before);
  });

  it("previews the same locked bytes that apply writes after the local source changes", async () => {
    const home = await tempDir("stinky-plan-lock-home-");
    const xdg = await tempDir("stinky-plan-lock-xdg-");
    const source = await tempDir("stinky-plan-lock-source-");
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
    await writeFile(skillFile, "edited after lock\n");
    const planned = JSON.parse((await run(env, "toolkit", "plan", "--json")).stdout) as { ops: Array<{ bytes?: string }>; diffs: string[] };
    expect(planned.ops.map((op) => op.bytes)).toEqual([locked]);
    expect(planned.diffs.join("\n")).toContain("locked body");
    expect(planned.diffs.join("\n")).not.toContain("edited after lock");
    const applied = JSON.parse((await run(env, "toolkit", "apply", "--yes", "--json")).stdout) as { completed: Array<{ bytes?: string }> };
    expect(applied.completed.map((op) => op.bytes)).toEqual(planned.ops.map((op) => op.bytes));
    expect(await readFile(path.join(home, ".codex", "skills", "review", "SKILL.md"), "utf8")).toBe(locked);
    expect(JSON.parse((await run(env, "toolkit", "plan", "--json")).stdout)).toMatchObject({ ops: [], conflicts: [] });
  });

  it("renders the env reference in each host's documented syntax and never the value", async () => {
    const home = await tempDir("stinky-mcp-env-home-");
    const xdg = await tempDir("stinky-mcp-env-xdg-");
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
    const appliedText = (await run(env, "toolkit", "apply", "--yes", "--json")).stdout;
    expect(JSON.parse(appliedText)).toMatchObject({ stopped: false });
    expect((JSON.parse(appliedText) as { completed: unknown[] }).completed).toHaveLength(4);
    const files = {
      zcode: path.join(home, ".zcode", "cli", "config.json"),
      codex: path.join(home, ".codex", "config.toml"),
      "claude-code": path.join(home, ".claude.json"),
      cursor: path.join(home, ".cursor", "mcp.json")
    };
    const cursor = JSON.parse(await readFile(files.cursor, "utf8")) as { mcpServers: { filesystem: { env?: Record<string, string> } } };
    expect(cursor.mcpServers.filesystem.env).toEqual({ FS_TOKEN: "${env:STINKY_TEST_FS_TOKEN}" });
    const claude = JSON.parse(await readFile(files["claude-code"], "utf8")) as { mcpServers: { filesystem: { env?: Record<string, string> } } };
    expect(claude.mcpServers.filesystem.env).toEqual({ FS_TOKEN: "${STINKY_TEST_FS_TOKEN}" });
    const codex = parseToml(await readFile(files.codex, "utf8")) as { mcp_servers: { filesystem: { env?: unknown; env_vars?: string[] } } };
    expect(codex.mcp_servers.filesystem.env_vars).toEqual(["STINKY_TEST_FS_TOKEN"]);
    expect(codex.mcp_servers.filesystem.env).toBeUndefined();
    const zcode = JSON.parse(await readFile(files.zcode, "utf8")) as { mcp: { servers: { filesystem: Record<string, unknown> } } };
    expect(zcode.mcp.servers.filesystem).toEqual({ command: "stinky-cobbler-missing-cmd", args: [] });
    for (const file of Object.values(files)) expect(await readFile(file, "utf8")).not.toContain(secret);
    expect(appliedText).not.toContain(secret);
    const planned = JSON.parse((await run(env, "toolkit", "plan", "--json")).stdout) as { ops: unknown[]; conflicts: unknown[] };
    expect(planned).toMatchObject({ ops: [], conflicts: [] });
    expect((JSON.parse((await run(env, "toolkit", "doctor", "--json")).stdout) as { drift: unknown[] }).drift).toEqual([]);
  });

});

function mcpSpec(command: string): string {
  return [
    "version: 1",
    "scope: user",
    "hosts:",
    "  - codex",
    "skills: []",
    "mcpServers:",
    "  - id: files",
    "    transport: stdio",
    `    command: ${command}`,
    "instructions: []",
    "bundles: []",
    ""
  ].join("\n");
}

async function commitSkillRepo(repo: string, body: string, marker: string): Promise<void> {
  const env = { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com" };
  await execFileAsync("git", ["init", repo], { env });
  await mkdir(path.join(repo, "skills", "review"), { recursive: true });
  await writeFile(path.join(repo, "skills", "review", "SKILL.md"), body);
  await writeFile(path.join(repo, "skills", "review", "evil.sh"), `#!/bin/sh\necho pwned > ${JSON.stringify(marker)}\n`);
  await execFileAsync("git", ["-C", repo, "add", "."], { env });
  await execFileAsync("git", ["-C", repo, "commit", "-m", "skill"], { env });
}
