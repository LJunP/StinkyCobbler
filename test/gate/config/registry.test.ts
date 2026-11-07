import path from "node:path";
import { describe, expect, it } from "vitest";
import { SchemaRegistry } from "../../../src/gate/contracts/schema-registry.js";
import { loadRegistries } from "../../../src/gate/config/registry.js";

const root = path.resolve(import.meta.dirname, "..", "..", "..");

describe("built-in registries", () => {
  it("loads all profiles, packs, roles, and plugin references", async () => {
    const schemas = await SchemaRegistry.create(root);
    const registries = await loadRegistries(root, schemas);
    expect(registries.packs.get("software-engineering")?.artifactTypes).toContain("test-report");
    expect(registries.packs.get("regulated-work")?.artifactTypes).toContain("evidence-pack");
    expect(registries.roles.roles.researcher!.displayName).toBe("研究员");
    expect(registries.plugins.has("web-research")).toBe(false);
    expect(registries.pluginDiagnostics.get("repository-read")?.executable).toBe(true);
    expect(registries.roleTools.scout).toEqual(["repository-read", "repository-list", "docs-index"]);
    expect(registries.roleTools.reviewer).toEqual(["repository-read", "git-read"]);
    expect(registries.roleTools.conductor).toEqual([]);
    expect(registries.roleTools["ghost-role"]).toBeUndefined();
  });
});
