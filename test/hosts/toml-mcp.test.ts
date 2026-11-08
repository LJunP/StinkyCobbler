import { parse } from "smol-toml";
import { describe, expect, it } from "vitest";
import { mergeTomlMcp, readTomlMcp, replaceTomlMcp } from "../../src/hosts/toml-mcp.js";

const userText = '# my settings\nmodel = "o3"\n\n[profiles.fast]\nmodel = "mini" # keep\n';

function merged(text: string, id: string, command: string): string {
  const result = mergeTomlMcp(text, id, { command, args: [] });
  if (result.status !== "merged") throw new Error(`merge returned ${result.status}`);
  return result.text;
}

describe("replaceTomlMcp", () => {
  it("rewrites only the entry's table and keeps every other byte, including a later table", () => {
    const before = `${merged(merged(userText, "files", "echo"), "other", "cat")}# trailing note\n`;
    const result = replaceTomlMcp(before, "files", { command: "printf", args: ["-v"], envVars: ["TOKEN"] });
    expect(result.status).toBe("merged");
    const text = result.status === "merged" ? result.text : "";
    expect(text.startsWith(userText)).toBe(true);
    expect(text.endsWith('[mcp_servers.other]\ncommand = "cat"\nargs = []\n# trailing note\n')).toBe(true);
    expect(readTomlMcp(text)).toEqual({ files: { command: "printf", args: ["-v"], envVars: ["TOKEN"] }, other: { command: "cat", args: [] } });
  });

  it("drops the entry's own sub-tables with it", () => {
    const before = `${userText}\n[mcp_servers.files]\ncommand = "echo"\nargs = []\n\n[mcp_servers.files.env]\nTOKEN = "x"\n`;
    const result = replaceTomlMcp(before, "files", { command: "printf", args: [] });
    expect(result.status).toBe("merged");
    const parsed = parse(result.status === "merged" ? result.text : "") as { mcp_servers: { files: Record<string, unknown> } };
    expect(parsed.mcp_servers.files).toEqual({ command: "printf", args: [] });
  });

  it("returns unchanged with the same bytes when the entry already matches", () => {
    const before = merged(userText, "files", "echo");
    expect(replaceTomlMcp(before, "files", { command: "echo", args: [] })).toEqual({ status: "unchanged", text: before });
  });

  it.each([
    ["the entry is missing", userText],
    ["the entry is an inline table it cannot locate as a header", `${userText}mcp_servers.files = { command = "echo", args = [] }\n`],
    ["the header appears in a multi-line string as well", `note = """\n[mcp_servers.files]\n"""\n\n[mcp_servers.files]\ncommand = "echo"\nargs = []\n`]
  ])("refuses as a conflict when %s", (_case, before) => {
    expect(replaceTomlMcp(before, "files", { command: "printf", args: [] })).toEqual({ status: "conflict" });
  });

  it("reports invalid TOML instead of guessing", () => {
    expect(replaceTomlMcp("[mcp_servers.files\n", "files", { command: "printf", args: [] })).toEqual({ status: "invalid" });
  });
});
