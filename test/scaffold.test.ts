import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { initWorkspace } from "../src/storage/workspace.js";
import { scaffoldUserPolicies } from "../src/config/scaffold.js";
import { loadOrchestrationConfig } from "../src/config/tiered.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "stinky-scaffold-"));
  roots.push(root);
  const workspace = await initWorkspace(root);
  return { workspace, root };
}

describe("out-of-the-box policy templates (scaffold)", () => {
  it("creates all four commented template files", async () => {
    const { workspace } = await setup();
    const created = await scaffoldUserPolicies(workspace);
    expect(created.sort()).toEqual(["contract-templates.yaml", "orchestration.yaml", "specialists.yaml", "templates.yaml"]);
    for (const name of created) {
      const content = await readFile(path.join(workspace.root, ".stinky-cobbler", "policies", name), "utf8");
      expect(content).toContain("version: 1");
    }
  });

  it("refuses to scaffold through a symlinked policies directory", async () => {
    const { workspace } = await setup();
    const outside = await mkdtemp(path.join(os.tmpdir(), "stinky-scaffold-outside-"));
    roots.push(outside);
    const sentinel = path.join(outside, "sentinel.txt");
    await writeFile(sentinel, "unchanged\n", "utf8");
    await symlink(outside, path.join(workspace.directory, "policies"));

    await expect(scaffoldUserPolicies(workspace)).rejects.toMatchObject({ code: "PATH_DENIED" });
    expect(await readFile(sentinel, "utf8")).toBe("unchanged\n");
  });

  it("refuses to scaffold over a symlinked policy file", async () => {
    const { workspace } = await setup();
    const outside = await mkdtemp(path.join(os.tmpdir(), "stinky-scaffold-file-outside-"));
    roots.push(outside);
    const sentinel = path.join(outside, "orchestration.yaml");
    await writeFile(sentinel, "external sentinel\n", "utf8");
    await mkdir(path.join(workspace.directory, "policies"));
    await symlink(sentinel, path.join(workspace.directory, "policies", "orchestration.yaml"));

    await expect(scaffoldUserPolicies(workspace)).rejects.toMatchObject({ code: "PATH_DENIED" });
    expect(await readFile(sentinel, "utf8")).toBe("external sentinel\n");
  });

  it("does not overwrite files the user already edited", async () => {
    const { workspace, root } = await setup();
    const dir = path.join(root, ".stinky-cobbler", "policies");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "orchestration.yaml"), "version: 1\ndefaults:\n  maxRounds: 99\n", "utf8");
    const created = await scaffoldUserPolicies(workspace);
    expect(created).not.toContain("orchestration.yaml");
    expect(created.length).toBe(3);
    const cfg = await loadOrchestrationConfig(workspace);
    expect(cfg.defaults?.maxRounds).toBe(99); // user edit survives
  });

  it("commented templates keep builtin defaults effective (no behavior change)", async () => {
    const { workspace } = await setup();
    await scaffoldUserPolicies(workspace);
    const cfg = await loadOrchestrationConfig(workspace);
    expect(cfg.defaults?.maxRounds).toBe(5);
    expect(cfg.defaults?.oscillationThreshold).toBe(2);
  });

  it("is idempotent: second scaffold run creates nothing", async () => {
    const { workspace } = await setup();
    await scaffoldUserPolicies(workspace);
    const again = await scaffoldUserPolicies(workspace);
    expect(again).toEqual([]);
  });
});
