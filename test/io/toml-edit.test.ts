import { parse } from "smol-toml";
import { describe, expect, it } from "vitest";
import { appendTomlDocument } from "../../src/io/toml-edit.js";

describe("appendTomlDocument", () => {
  it("keeps the source bytes as a prefix and adds the new table", () => {
    const source = "# keep\nmodel = \"gpt\"\n\n[desktop]\n  codeFontSize = 14\n";
    const next = appendTomlDocument(source, {
      mcp_servers: { "stinky-cobbler-local": { command: "stinky-cobbler-mcp", args: [] } }
    });

    expect(next.startsWith(source)).toBe(true);
    expect(next).toContain("  codeFontSize = 14\n");
    const parsed = parse(next) as { model: string; desktop: { codeFontSize: number }; mcp_servers: Record<string, { command: string }> };
    expect(parsed.model).toBe("gpt");
    expect(parsed.desktop.codeFontSize).toBe(14);
    expect(parsed.mcp_servers["stinky-cobbler-local"]?.command).toBe("stinky-cobbler-mcp");
  });

  it("adds a missing final newline before the fragment", () => {
    const next = appendTomlDocument("model = \"gpt\"", { note: { value: 1 } });
    expect(next.startsWith("model = \"gpt\"\n")).toBe(true);
    expect(parse(next)).toMatchObject({ model: "gpt", note: { value: 1 } });
  });
});
