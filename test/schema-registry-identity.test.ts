import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SchemaRegistry } from "../src/contracts/schema-registry.js";

const roots: string[] = [];
const projectRoot = path.resolve(import.meta.dirname, "..");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("schema registry canonical identities", () => {
  it("rejects canonical schema files whose contents and $ids were swapped", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "stinky-schema-identity-"));
    roots.push(root);
    await cp(path.join(projectRoot, "schemas"), path.join(root, "schemas"), { recursive: true });

    const taskFile = path.join(root, "schemas", "task.schema.json");
    const artifactFile = path.join(root, "schemas", "artifact.schema.json");
    const [taskSchema, artifactSchema] = await Promise.all([
      readFile(taskFile, "utf8"),
      readFile(artifactFile, "utf8")
    ]);
    await Promise.all([
      writeFile(taskFile, artifactSchema, "utf8"),
      writeFile(artifactFile, taskSchema, "utf8")
    ]);

    await expect(SchemaRegistry.create(root)).rejects.toThrow(/task\.schema\.json.*\$id/i);
  });

  it("binds every aggregate kind to its exact canonical filename and $id", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "stinky-schema-aggregate-identity-"));
    roots.push(root);
    await cp(path.join(projectRoot, "schemas"), path.join(root, "schemas"), { recursive: true });
    const target = path.join(root, "schemas", "cancellation-fence.schema.json");
    const schema = JSON.parse(await readFile(target, "utf8")) as Record<string, unknown>;
    schema.$id = "https://stinkycobbler.dev/schemas/docs-index.schema.json";
    await writeFile(target, JSON.stringify(schema), "utf8");

    await expect(SchemaRegistry.create(root)).rejects.toThrow(/cancellation-fence\.schema\.json.*\$id/i);
  });
});
