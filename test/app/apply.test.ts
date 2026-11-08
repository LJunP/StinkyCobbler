import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { apply } from "../../src/app/apply.js";
import { rollbackLast } from "../../src/app/rollback.js";
import type { FileOp, ToolkitPlan } from "../../src/core/plan/plan.js";
import { sha256 } from "../../src/io/managed-file.js";
import { toolkitLedgerPath } from "../../src/io/ledger.js";

const roots: string[] = [];
const previousXdg = process.env.XDG_CONFIG_HOME;

afterEach(async () => {
  process.env.XDG_CONFIG_HOME = previousXdg;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("toolkit apply and rollback", () => {
  it("stops on the third op without rolling back the first two", async () => {
    const root = await freshRoot("stinky-apply-stop-");
    const blocked = path.join(root, "blocked");
    await writeFile(blocked, "not-a-directory\n");
    const first = createOp(path.join(root, "one.md"), "one\n");
    const second = createOp(path.join(root, "two.md"), "two\n");
    const third = createOp(path.join(blocked, "three.md"), "three\n");
    const report = await apply(planOf(first, second, third));

    expect(report.stopped).toBe(true);
    expect(report.completed.map((op) => op.path)).toEqual([first.path, second.path]);
    expect(report.hint).toContain("toolkit rollback --last");
    expect(await readFile(first.path, "utf8")).toBe("one\n");
    expect(await readFile(second.path, "utf8")).toBe("two\n");
    await expect(readFile(third.path, "utf8")).rejects.toThrow();
    const events = (await readFile(toolkitLedgerPath(), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { event: string; path: string; afterHash: string });
    expect(events).toHaveLength(2);
    expect(events.map((event) => event.event)).toEqual(["toolkit-op-applied", "toolkit-op-applied"]);
    expect(events.map((event) => event.path)).toEqual([first.path, second.path]);
    expect(events[0]?.afterHash).toBe(sha256("one\n"));
  });

  it("restores pre-apply bytes after rollback and refuses a drifted file", async () => {
    const root = await freshRoot("stinky-apply-roll-");
    const existing = path.join(root, "skill.md");
    await writeFile(existing, "before\n");
    const created = path.join(root, "new.md");
    const report = await apply(
      planOf(
        { host: "codex", kind: "skill", id: "review", path: existing, action: "replace", bytes: "after\n", priorHash: sha256("before\n") },
        createOp(created, "created\n")
      )
    );
    expect(report.stopped).toBe(false);
    expect(await readFile(existing, "utf8")).toBe("after\n");
    expect(await readFile(created, "utf8")).toBe("created\n");

    const rolled = await rollbackLast();
    expect(rolled.conflict).toBeUndefined();
    expect(await readFile(existing, "utf8")).toBe("before\n");
    await expect(readFile(created, "utf8")).rejects.toThrow();

    await apply(planOf(createOp(created, "created\n")));
    await writeFile(created, "user edit\n");
    const drifted = await rollbackLast();
    expect(drifted.conflict).toMatchObject({ path: created });
    expect(await readFile(created, "utf8")).toBe("user edit\n");
  });

  it("rolls back two ops on the user's own file to its original bytes instead of deleting it", async () => {
    const root = await freshRoot("stinky-apply-two-ops-");
    const target = path.join(root, "config.toml");
    const userText = '# my settings\nmodel = "o3"\n';
    await writeFile(target, userText);
    const merge = (id: string): FileOp => ({ host: "codex", kind: "mcp-server", id, path: target, action: "merge-mcp", mcpEntry: { command: id, args: [] } });
    const report = await apply(planOf(merge("files"), merge("docs")));
    expect(report).toMatchObject({ stopped: false });
    expect(await readFile(target, "utf8")).toContain("[mcp_servers.docs]");

    const rolled = await rollbackLast();
    expect(rolled.conflict).toBeUndefined();
    expect(await readFile(target, "utf8")).toBe(userText);
  });

  it("merges an mcp server through the host adapter and rolls the file back", async () => {
    const root = await freshRoot("stinky-apply-mcp-");
    const target = path.join(root, "mcp.json");
    await apply(
      planOf({
        host: "cursor",
        kind: "mcp-server",
        id: "filesystem",
        path: target,
        action: "merge-mcp",
        mcpEntry: { command: "npx", args: ["-y", "server"], env: { API_TOKEN: "${env:FS_TOKEN}" } }
      })
    );
    const written = JSON.parse(await readFile(target, "utf8")) as { mcpServers: { filesystem: { command: string; args: string[]; env?: Record<string, string> } } };
    expect(written.mcpServers.filesystem).toEqual({ command: "npx", args: ["-y", "server"], env: { API_TOKEN: "${env:FS_TOKEN}" } });
    await rollbackLast();
    await expect(readFile(target, "utf8")).rejects.toThrow();
  });

  it("upserts an instruction segment and restores the previous bytes", async () => {
    const root = await freshRoot("stinky-apply-segment-");
    const target = path.join(root, "AGENTS.md");
    await writeFile(target, "keep\n");
    await apply(
      planOf({
        host: "codex",
        kind: "instructions",
        id: "my-style",
        path: target,
        action: "upsert-segment",
        segment: "<!-- stinky-cobbler:begin my-style -->\nUse short paragraphs.\n<!-- stinky-cobbler:end my-style -->"
      })
    );
    const text = await readFile(target, "utf8");
    expect(text.startsWith("keep\n")).toBe(true);
    expect(text).toContain("Use short paragraphs.\n");
    await rollbackLast();
    expect(await readFile(target, "utf8")).toBe("keep\n");
  });
});

async function freshRoot(prefix: string): Promise<string> {
  const xdg = await realpath(await mkdtemp(path.join(tmpdir(), `${prefix}xdg-`)));
  const root = await realpath(await mkdtemp(path.join(tmpdir(), prefix)));
  process.env.XDG_CONFIG_HOME = xdg;
  roots.push(xdg, root);
  await mkdir(root, { recursive: true });
  return root;
}

function createOp(target: string, bytes: string): FileOp {
  return { host: "codex", kind: "skill", id: "review", path: target, action: "create", bytes };
}

function planOf(...ops: FileOp[]): ToolkitPlan {
  return { ops, conflicts: [], skipped: [], orphans: [] };
}
