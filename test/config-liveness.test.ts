import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const projectRoot = path.resolve(import.meta.dirname, "..");

function collectPropertyNames(schema: unknown, names: Set<string>): void {
  if (Array.isArray(schema)) {
    for (const item of schema) collectPropertyNames(item, names);
    return;
  }
  if (schema === null || typeof schema !== "object") return;
  const record = schema as Record<string, unknown>;
  const properties = record.properties;
  if (properties !== null && typeof properties === "object" && !Array.isArray(properties)) {
    for (const [name, child] of Object.entries(properties as Record<string, unknown>)) {
      names.add(name);
      collectPropertyNames(child, names);
    }
  }
  for (const value of Object.values(record)) {
    if (value === properties) continue;
    collectPropertyNames(value, names);
  }
}

async function sourceText(): Promise<string> {
  const files = await readdir(path.join(projectRoot, "src"), { recursive: true });
  const chunks: string[] = [];
  for (const file of files) {
    const name = String(file);
    if (!name.endsWith(".ts") && !name.endsWith(".mjs") && !name.endsWith(".js")) continue;
    chunks.push(await readFile(path.join(projectRoot, "src", name), "utf8"));
  }
  return chunks.join("\n");
}

describe("schema property liveness", () => {
  it("rejects a schema property name that src never references", async () => {
    const schemaDir = path.join(projectRoot, "schemas");
    const entries = (await readdir(schemaDir)).filter((name) => name.endsWith(".json"));
    const names = new Set<string>();
    for (const entry of entries) {
      collectPropertyNames(JSON.parse(await readFile(path.join(schemaDir, entry), "utf8")) as unknown, names);
    }
    const source = await sourceText();
    const orphans = [...names].filter((name) => {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return !new RegExp(`(?:^|[^A-Za-z0-9_])${escaped}(?:[^A-Za-z0-9_]|$)`).test(source);
    }).sort();
    expect(orphans).toEqual([]);
  });
});
