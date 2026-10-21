import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("cli host literals", () => {
  it("keeps zcode and codex string literals out of cli.ts", async () => {
    const source = await readFile(path.resolve(import.meta.dirname, "../../src/cli.ts"), "utf8");
    expect(source.includes('"zcode"')).toBe(false);
    expect(source.includes('"codex"')).toBe(false);
    expect(source.includes("'zcode'")).toBe(false);
    expect(source.includes("'codex'")).toBe(false);
  });
});
