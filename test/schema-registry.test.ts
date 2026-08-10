import path from "node:path";
import { describe, expect, it } from "vitest";
import { SchemaRegistry } from "../src/contracts/schema-registry.js";

const root = path.resolve(import.meta.dirname, "..");

describe("schema registry", () => {
  it("accepts v0.1 test-report artifacts", async () => {
    const schemas = await SchemaRegistry.create(root);
    expect(() => schemas.validate("artifact", {
      id: "artifact-1", type: "test-report", version: "1", sensitivity: "internal", status: "draft", provenance: { taskId: "task-1" }
    })).not.toThrow();
  });

  it("requires a lease subject and workspace", async () => {
    const schemas = await SchemaRegistry.create(root);
    expect(() => schemas.validate("lease", { id: "lease", taskId: "task", role: "scout" })).toThrow(/Invalid lease/);
  });
});
