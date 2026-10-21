import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { observe, type HostObservation } from "../../src/app/observe.js";
import { installManagedBytes, sha256 } from "../../src/io/managed-file.js";
import { hostAdapters } from "../../src/hosts/registry.js";
import { parseToolkitSpec } from "../../src/core/toolkit/spec.js";

const rootsToRemove: string[] = [];

afterEach(async () => {
  await Promise.all(rootsToRemove.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("host observation", () => {
  it("classifies skill and mcp targets on every host without writing", async () => {
    const home = await realpath(await mkdtemp(path.join(tmpdir(), "stinky-observe-home-")));
    const cwd = await realpath(await mkdtemp(path.join(tmpdir(), "stinky-observe-cwd-")));
    rootsToRemove.push(home, cwd);
    const spec = parseToolkitSpec({
      version: 1,
      hosts: hostAdapters.map((adapter) => adapter.id),
      skills: [{ id: "review", source: "./skills/review" }],
      mcpServers: [{ id: "filesystem", transport: "stdio", command: "npx", args: [] }]
    });
    const input = { adapters: hostAdapters, spec, scope: "user" as const, roots: { home, cwd } };

    const before = await treeDigest(home);
    const absent = await observe(input);
    expect(await treeDigest(home)).toBe(before);
    expect(absent).toHaveLength(hostAdapters.length * 2);
    expect(new Set(absent.map((item) => item.host))).toEqual(new Set(hostAdapters.map((adapter) => adapter.id)));
    expect(absent.every((item) => item.state === "absent" && item.hash === undefined)).toBe(true);

    const codexSkill = path.join(home, ".codex", "skills", "review", "SKILL.md");
    await installManagedBytes(codexSkill, "managed skill\n", "test", "test");
    const claudeSkill = path.join(home, ".claude", "skills", "review", "SKILL.md");
    await mkdir(path.dirname(claudeSkill), { recursive: true });
    await writeFile(claudeSkill, "foreign skill\n");
    const cursorMcp = path.join(home, ".cursor", "mcp.json");
    await mkdir(path.dirname(cursorMcp), { recursive: true });
    await writeFile(cursorMcp, `${JSON.stringify({ mcpServers: { filesystem: { command: "npx", args: [] } } }, null, 2)}\n`);
    const zcodeMcp = path.join(home, ".zcode", "cli", "config.json");
    await installManagedBytes(zcodeMcp, `${JSON.stringify({ mcp: { servers: { filesystem: { command: "npx", args: [] } } } }, null, 2)}\n`, "test", "test");

    const classified = await observe(input);
    expect(find(classified, "codex", "skill")).toMatchObject({ state: "managed", hash: sha256("managed skill\n") });
    expect(find(classified, "claude-code", "skill")).toMatchObject({ state: "foreign" });
    expect(find(classified, "cursor", "mcp-server")).toMatchObject({ state: "foreign" });
    expect(find(classified, "zcode", "mcp-server")).toMatchObject({ state: "managed" });
    expect(find(classified, "cursor", "skill").state).toBe("absent");

    const managedBytes = await readFile(codexSkill);
    await writeFile(codexSkill, "edited skill\n");
    const edited = await observe(input);
    expect(find(edited, "codex", "skill")).toMatchObject({ state: "managed-modified", hash: sha256("edited skill\n") });
    expect(await readFile(codexSkill)).not.toEqual(managedBytes);
    expect(await readFile(`${codexSkill}.stinky-cobbler-managed.json`, "utf8")).toContain(sha256("managed skill\n"));
  });
});

function find(observations: HostObservation[], host: string, kind: HostObservation["kind"]): HostObservation {
  const found = observations.find((item) => item.host === host && item.kind === kind && (kind === "skill" ? item.id === "review" : item.id === "filesystem"));
  if (found === undefined) throw new Error(`Missing observation ${host} ${kind}`);
  return found;
}

async function treeDigest(root: string): Promise<string> {
  const files = await walk(root);
  const hash = createHash("sha256");
  for (const file of files) hash.update(`${file}\0${await readFile(path.join(root, file))}\0`);
  return hash.digest("hex");
}

async function walk(root: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(path.join(root, prefix), { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(root, relative)));
    else files.push(relative);
  }
  return files;
}
