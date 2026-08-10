import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SchemaRegistry } from "../src/contracts/schema-registry.js";
import { loadRegistries } from "../src/config/registry.js";
import {
  migrateWorkspaceConfig,
  resolveWorkspaceConfig,
  validateWorkspaceConfig,
  workspaceFile,
  type WorkspaceConfig
} from "../src/config/workspace.js";
import { initWorkspace, workspaceFile } from "../src/storage/workspace.js";

const projectRoot = path.resolve(import.meta.dirname, "..");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "stinky-config-"));
  roots.push(root);
  const workspace = await initWorkspace(root);
  const schemas = await SchemaRegistry.create(projectRoot);
  const registries = await loadRegistries(projectRoot, schemas);
  return { root: workspace.root, workspace, schemas, registries };
}

function config(root: string, version: 1 | 2 = 1): WorkspaceConfig {
  return {
    version,
    workspaceId: "config-test",
    root,
    profile: "team",
    packs: ["software-engineering"],
    mode: "reviewed-workflow",
    roles: {},
    ...(version === 2 ? { plugins: {} } : {})
  };
}

describe("Workspace Config v2 and plugin selection", () => {
  it("keeps v1 read-only compatible and does not select recommendations", async () => {
    const value = await setup();
    const v1 = config(value.root);
    expect(validateWorkspaceConfig(v1, value.schemas, value.registries, value.root).version).toBe(1);
    const resolved = resolveWorkspaceConfig(v1, value.registries);
    const repository = resolved.plugins.find((plugin) => plugin.id === "repository-read");
    expect(repository).toMatchObject({ workspaceSelection: "unset", selected: false, effective: false, recommendedByPacks: ["software-engineering"] });
  });

  it("distinguishes explicit disabled and effective executable selections", async () => {
    const value = await setup();
    const selected = { ...config(value.root, 2), plugins: { "repository-read": { enabled: true }, "git-read": { enabled: false } } } satisfies WorkspaceConfig;
    const resolved = resolveWorkspaceConfig(validateWorkspaceConfig(selected, value.schemas, value.registries, value.root), value.registries);
    expect(resolved.plugins.find((plugin) => plugin.id === "repository-read")).toMatchObject({ workspaceSelection: "enabled", selected: true, effective: true, executable: true });
    expect(resolved.plugins.find((plugin) => plugin.id === "git-read")).toMatchObject({ workspaceSelection: "disabled", selected: false, effective: false });
    expect(() => validateWorkspaceConfig({ ...selected, plugins: { "local-observe": { enabled: true } } }, value.schemas, value.registries, value.root)).toThrowError(/not executable/);
  });

  it("migrates v1 atomically with a backup and makes v2 a no-op", async () => {
    const value = await setup();
    const source = `${JSON.stringify(config(value.root), null, 2)}\n`;
    const target = await workspaceFile(value.workspace, "workspace.json");
    await writeFile(target, source, { encoding: "utf8", mode: 0o600 });

    const dryRun = await migrateWorkspaceConfig(value.workspace, value.schemas, value.registries, true);
    expect(dryRun).toMatchObject({ migrated: false, fromVersion: 1, toVersion: 2 });
    expect(await readFile(target, "utf8")).toBe(source);
    expect(await readdir(path.join(value.workspace.directory, "backups")).catch(() => [])).toEqual([]);

    const migrated = await migrateWorkspaceConfig(value.workspace, value.schemas, value.registries, false);
    expect(migrated).toMatchObject({ migrated: true, fromVersion: 1, toVersion: 2, backup: expect.stringMatching(/^\.stinky-cobbler\/backups\/workspace-v1-.+\.json$/) });
    expect(JSON.parse(await readFile(target, "utf8"))).toMatchObject({ version: 2, plugins: {} });
    expect(await readFile(path.join(value.root, migrated.backup!), "utf8")).toBe(source);

    const again = await migrateWorkspaceConfig(value.workspace, value.schemas, value.registries, false);
    expect(again).toMatchObject({ migrated: false, fromVersion: 2, toVersion: 2 });
    expect((await readdir(path.join(value.workspace.directory, "backups"))).length).toBe(1);
  });
});
