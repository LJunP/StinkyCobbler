import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { installHost, MCP_SERVER_ID } from "../src/entry/install-host.js";
import { detectMcpServer } from "../src/entry/preflight.js";

const roots: string[] = [];
const projectRoot = path.resolve(import.meta.dirname, "..");
const codexSkillTemplate = path.join(projectRoot, ".codex", "skills", "stinky-cobbler", "SKILL.md");
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function tmp(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

describe("entry install-host (codex)", () => {
  it("installs the codex skill and skips the command file", async () => {
    const home = await tmp("stinky-codex-");
    const result = await installHost({ host: "codex", scope: "user", homeDir: home });
    expect(result.host).toBe("codex");
    expect(result.command.action).toBe("skipped");
    expect(result.skill.action).toBe("installed");
    const installed = await readFile(path.join(home, ".codex", "skills", "stinky-cobbler", "SKILL.md"), "utf8");
    expect(installed).toBe(await readFile(codexSkillTemplate, "utf8"));
  });

  it("dry-run previews without writing into the codex home", async () => {
    const home = await tmp("stinky-codex-dry-");
    const result = await installHost({ host: "codex", scope: "user", dryRun: true, installMcp: true, homeDir: home });
    expect(result.skill.action).toBe("preview");
    expect(result.mcp?.action).toBe("preview");
    await expect(readFile(path.join(home, ".codex", "skills", "stinky-cobbler", "SKILL.md"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(home, ".codex", "config.toml"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("merges the MCP server into an existing config.toml, preserves other servers and fields, and backs up", async () => {
    const home = await tmp("stinky-codex-mcp-");
    const configPath = path.join(home, ".codex", "config.toml");
    await mkdir(path.join(home, ".codex"), { recursive: true });
    const existing = `model = "gpt-5.6-sol"\n\n[mcp_servers.node_repl]\ncommand = "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node_repl"\nargs = []\n\n[desktop]\ncodeFontSize = 14\n`;
    await writeFile(configPath, existing, "utf8");
    const result = await installHost({ host: "codex", scope: "user", installMcp: true, homeDir: home });
    expect(result.mcp?.action).toBe("installed");
    const merged = parseToml(await readFile(configPath, "utf8")) as Record<string, unknown>;
    expect(merged.model).toBe("gpt-5.6-sol");
    expect(merged.mcp_servers).toMatchObject({
      node_repl: { command: expect.stringContaining("node_repl") },
      [MCP_SERVER_ID]: { command: expect.stringContaining("stinky-cobbler-mcp"), args: [] }
    });
    expect(merged.desktop).toMatchObject({ codeFontSize: 14 });
    const backups = await readdir(path.join(home, ".codex"));
    expect(backups.some((name) => name.startsWith("config.toml.bak-"))).toBe(true);
    const again = await installHost({ host: "codex", scope: "user", installMcp: true, homeDir: home });
    expect(again.mcp?.action).toBe("ready");
  });

  it("refuses to overwrite a conflicting codex MCP server command", async () => {
    const home = await tmp("stinky-codex-conflict-");
    await mkdir(path.join(home, ".codex"), { recursive: true });
    await writeFile(path.join(home, ".codex", "config.toml"), `[mcp_servers.stinky-cobbler-local]\ncommand = "someone-else"\n`, "utf8");
    await expect(installHost({ host: "codex", scope: "user", installMcp: true, homeDir: home })).rejects.toMatchObject({ code: "ENTRY_HOST_CONFIG_CONFLICT" });
  });

  it("refuses to modify an invalid config.toml", async () => {
    const home = await tmp("stinky-codex-invalid-");
    await mkdir(path.join(home, ".codex"), { recursive: true });
    await writeFile(path.join(home, ".codex", "config.toml"), "not = [valid toml\n", "utf8");
    await expect(installHost({ host: "codex", scope: "user", installMcp: true, homeDir: home })).rejects.toMatchObject({ code: "ENTRY_HOST_CONFIG_INVALID" });
  });
});

describe("entry preflight (codex)", () => {
  it("detects a configured codex MCP server in config.toml", async () => {
    const home = await tmp("stinky-codex-preflight-");
    await mkdir(path.join(home, ".codex"), { recursive: true });
    await writeFile(path.join(home, ".codex", "config.toml"), `[mcp_servers.stinky-cobbler-local]\ncommand = "stinky-cobbler-mcp"\nargs = []\n`, "utf8");
    const mcp = await detectMcpServer({ homeDir: home, host: "codex" });
    expect(mcp.configured).toBe(true);
    expect(mcp.locations).toEqual([path.join(home, ".codex", "config.toml")]);
  });

  it("does not report codex config when filtering the zcode host", async () => {
    const home = await tmp("stinky-codex-filter-");
    await mkdir(path.join(home, ".codex"), { recursive: true });
    await writeFile(path.join(home, ".codex", "config.toml"), `[mcp_servers.stinky-cobbler-local]\ncommand = "stinky-cobbler-mcp"\n`, "utf8");
    const mcp = await detectMcpServer({ homeDir: home, host: "zcode" });
    expect(mcp.configured).toBe(false);
  });
});
