import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseVia, isValidVia } from "../src/entry/via.js";
import { preflightEntry, decideEntry, detectMcpServer } from "../src/entry/preflight.js";
import { installHost, MCP_SERVER_ID } from "../src/entry/install-host.js";

const roots: string[] = [];
const projectRoot = path.resolve(import.meta.dirname, "..");
const commandTemplate = path.join(projectRoot, ".zcode", "commands", "stinky-cobbler.md");
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function tmp(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

describe("entry via parsing", () => {
  it("defaults to auto and is case-insensitive", () => {
    expect(parseVia(undefined)).toBe("auto");
    expect(parseVia("")).toBe("auto");
    expect(parseVia("skill")).toBe("skill");
    expect(parseVia("MCP")).toBe("mcp");
    expect(parseVia("  Auto  ")).toBe("auto");
  });

  it("fails closed on invalid values", () => {
    expect(isValidVia("bogus")).toBe(false);
    expect(() => parseVia("bogus")).toThrow();
    expect(() => parseVia(42)).toThrow();
  });
});

describe("entry preflight", () => {
  it("reports an uninitialized workspace and never creates files", async () => {
    const root = await tmp("stinky-entry-uninit-");
    const result = await preflightEntry({ workspace: root });
    expect(result).toMatchObject({ readOnly: true, workspaceInitialized: false, decision: "workspace-uninitialized" });
    await expect(import("node:fs/promises").then(({ stat }) => stat(path.join(root, ".stinky-cobbler")))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports an initialized workspace with a regular parseable config", async () => {
    const root = await tmp("stinky-entry-init-");
    const home = await tmp("stinky-entry-init-home-");
    await mkdir(path.join(root, ".stinky-cobbler"));
    await writeFile(path.join(root, ".stinky-cobbler", "workspace.json"), '{"version":2}\n', "utf8");
    const result = await preflightEntry({ workspace: root, via: "mcp", hostConfig: { homeDir: home, workspaceDir: root } });
    expect(result.workspaceInitialized).toBe(true);
    expect(result.decision).toBe("mcp-missing");
  });

  it("detects a configured MCP server in the host config", async () => {
    const root = await tmp("stinky-entry-ws-");
    const home = await tmp("stinky-entry-home-");
    await mkdir(path.join(home, ".zcode", "cli"), { recursive: true });
    await mkdir(path.join(root, ".stinky-cobbler"));
    await writeFile(path.join(root, ".stinky-cobbler", "workspace.json"), '{"version":2}\n', "utf8");
    await writeFile(path.join(home, ".zcode", "cli", "config.json"), JSON.stringify({ mcp: { servers: { [MCP_SERVER_ID]: { command: "stinky-cobbler-mcp", args: [] } } } }), "utf8");
    const mcp = await detectMcpServer({ homeDir: home, workspaceDir: root });
    expect(mcp.configured).toBe(true);
    const result = await preflightEntry({ workspace: root, via: "mcp", hostConfig: { homeDir: home, workspaceDir: root } });
    expect(result.mcpConfigured).toBe(true);
    expect(result.decision).toBe("mcp-available");
  });

  it("keeps skill-only decisions even when the workspace is uninitialized", async () => {
    const root = await tmp("stinky-entry-skill-");
    const result = await preflightEntry({ workspace: root, via: "skill" });
    expect(result.decision).toBe("skill-only");
  });

  it("reports invalid via without throwing", async () => {
    const result = await preflightEntry({ via: "bogus" });
    expect(result.viaValid).toBe(false);
    expect(result.viaError).toContain("via must be skill, mcp, or auto");
    expect(result.decision).toBe("invalid-via");
  });
});

describe("entry install-host", () => {
  it("previews without writing anything in dry-run mode", async () => {
    const home = await tmp("stinky-entry-dry-");
    const result = await installHost({ scope: "user", dryRun: true, homeDir: home, commandTemplatePath: commandTemplate });
    expect(result.command.action).toBe("preview");
    await expect(readFile(path.join(home, ".zcode", "commands", "stinky-cobbler.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("installs the command file and reports ready on re-run", async () => {
    const home = await tmp("stinky-entry-install-");
    const result = await installHost({ scope: "user", homeDir: home, commandTemplatePath: commandTemplate });
    expect(result.command.action).toBe("installed");
    const installed = await readFile(path.join(home, ".zcode", "commands", "stinky-cobbler.md"), "utf8");
    expect(installed).toBe(await readFile(commandTemplate, "utf8"));
    const again = await installHost({ scope: "user", homeDir: home, commandTemplatePath: commandTemplate });
    expect(again.command.action).toBe("ready");
  });

  it("refuses to overwrite an existing different command file", async () => {
    const home = await tmp("stinky-entry-conflict-");
    await mkdir(path.join(home, ".zcode", "commands"), { recursive: true });
    await writeFile(path.join(home, ".zcode", "commands", "stinky-cobbler.md"), "other-content\n", "utf8");
    const result = await installHost({ scope: "user", homeDir: home, commandTemplatePath: commandTemplate });
    expect(result.command.action).toBe("conflict");
    expect(await readFile(path.join(home, ".zcode", "commands", "stinky-cobbler.md"), "utf8")).toBe("other-content\n");
  });

  it("merges the MCP server into an existing host config and backs it up", async () => {
    const home = await tmp("stinky-entry-mcp-");
    const configPath = path.join(home, ".zcode", "cli", "config.json");
    await mkdir(path.join(home, ".zcode", "cli"), { recursive: true });
    const existing = { mcp: { servers: { "other": { command: "other-mcp", args: [] } } } };
    await writeFile(configPath, JSON.stringify(existing), "utf8");
    const result = await installHost({ scope: "user", installMcp: true, homeDir: home, commandTemplatePath: commandTemplate });
    expect(result.mcp?.action).toBe("installed");
    const merged = JSON.parse(await readFile(configPath, "utf8")) as { mcp: { servers: Record<string, unknown> } };
    expect(merged.mcp.servers["other"]).toBeDefined();
    expect(merged.mcp.servers[MCP_SERVER_ID]).toMatchObject({ command: expect.stringContaining("stinky-cobbler-mcp") });
    const backups = await import("node:fs/promises").then(({ readdir }) => readdir(path.join(home, ".zcode", "cli")));
    expect(backups.some((name) => name.startsWith("config.json.bak-"))).toBe(true);
    const again = await installHost({ scope: "user", installMcp: true, homeDir: home, commandTemplatePath: commandTemplate });
    expect(again.mcp?.action).toBe("ready");
  });

  it("refuses to overwrite a conflicting MCP server command", async () => {
    const home = await tmp("stinky-entry-mcp-conflict-");
    await mkdir(path.join(home, ".zcode", "cli"), { recursive: true });
    await writeFile(path.join(home, ".zcode", "cli", "config.json"), JSON.stringify({ mcp: { servers: { [MCP_SERVER_ID]: { command: "someone-else", args: [] } } } }), "utf8");
    await expect(installHost({ scope: "user", installMcp: true, homeDir: home, commandTemplatePath: commandTemplate })).rejects.toMatchObject({ code: "ENTRY_HOST_CONFIG_CONFLICT" });
  });

  it("installs into the workspace scope", async () => {
    const root = await tmp("stinky-entry-ws-scope-");
    const result = await installHost({ scope: "workspace", dryRun: true, cwd: root, commandTemplatePath: commandTemplate });
    expect(result.command.target).toContain(".zcode/commands/stinky-cobbler.md");
    expect(result.command.action).toBe("preview");
  });
});
