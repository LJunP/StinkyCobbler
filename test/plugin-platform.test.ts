import path from "node:path";
import { describe, expect, it } from "vitest";
import { SchemaRegistry } from "../src/contracts/schema-registry.js";
import type { PluginManifest } from "../src/contracts/types.js";
import { discoverBuiltinPlugins } from "../src/config/plugin-discovery.js";
import { loadRegistries } from "../src/config/registry.js";
import { createAdapterRegistry } from "../src/runtime/adapters.js";

const root = path.resolve(import.meta.dirname, "..");
const base: PluginManifest = {
  version: 2,
  id: "sample-read",
  label: "Sample read",
  level: "L0",
  status: "declared-only",
  operations: ["sample-read"],
  inputSchemaRef: "builtin:sample-read.input",
  outputSchemaRef: "builtin:sample-read.output",
  sideEffects: "none",
  requiresLease: true,
  requiresApproval: false,
  runtime: "unavailable",
  timeoutMs: 1000,
  auditMode: "receipt-ledger",
  source: "builtin"
};

describe("v0.3 Plugin and Adapter platform", () => {
  it("loads strict v2 manifests and distinguishes declarations from executable capabilities", async () => {
    const schemas = await SchemaRegistry.create(root);
    expect(() => schemas.validate("plugin", base)).not.toThrow();
    expect(() => schemas.validate("plugin", { ...base, arbitraryModule: "./plugin.js" })).toThrow(/Invalid plugin/);

    const registries = await loadRegistries(root, schemas);
    expect(registries.pluginDiagnostics.get("repository-read")).toMatchObject({ status: "available", implementationAvailable: true, executable: true });
    expect(registries.pluginDiagnostics.get("web-research")).toMatchObject({ status: "declared-only", implementationAvailable: false, executable: false, reasonCode: "PLUGIN_DECLARED_ONLY" });
    expect(registries.pluginDiagnostics.get("test-run")).toMatchObject({ status: "internal", executable: false });
  });

  it("rejects duplicate plugin and operation identifiers deterministically", () => {
    expect(() => discoverBuiltinPlugins([base, { ...base }])).toThrowError(expect.objectContaining({ code: "PLUGIN_DUPLICATE_ID" }));
    expect(() => discoverBuiltinPlugins([base, { ...base, id: "other-read" }])).toThrowError(expect.objectContaining({ code: "PLUGIN_DUPLICATE_OPERATION" }));
  });

  it("resolves only explicitly registered trusted adapters", async () => {
    const registry = createAdapterRegistry();
    expect(registry.resolve("scripted-readonly").descriptor).toMatchObject({ id: "scripted-readonly", status: "available" });
    expect(() => registry.resolve("host-injected")).toThrowError(expect.objectContaining({ code: "RUNTIME_EXECUTOR_UNAVAILABLE" }));
  });
});
