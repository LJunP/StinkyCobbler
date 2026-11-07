import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { parseVia, type EntryVia } from "./via.js";
import { hostAdapters, knownHost, type HostId } from "../../hosts/registry.js";

export const MCP_SERVER_COMMAND = "stinky-cobbler-mcp";
export const HOST_CONFIG_FILE = "config.json";
/** ZCode user-level MCP config: `~/.zcode/cli/config.json` (`mcp.servers`). */
export const USER_HOST_CONFIG_RELATIVE = path.join("cli", HOST_CONFIG_FILE);
/** Same-scope fallback that ZCode reads only when the `.zcode` scope has no MCP servers (`mcpServers`). */
export const USER_AGENTS_MCP_FILE = ".agents/mcp.json";

export type EntryDecision = "skill-only" | "mcp-available" | "mcp-missing" | "invalid-via" | "workspace-uninitialized";

export interface PreflightHostOptions {
  homeDir?: string;
  workspaceDir?: string;
  host?: HostId;
}

export interface PreflightEntryOptions {
  /** Workspace root to inspect; defaults to the current working directory. */
  workspace?: string;
  /** Raw via input; defaults to `auto`. */
  via?: unknown;
  /** Host environment overrides for tests. */
  hostConfig?: PreflightHostOptions;
}

export interface EntryPreflight {
  version: 1;
  readOnly: true;
  via: EntryVia;
  viaValid: boolean;
  viaError?: string;
  workspace: string;
  workspaceInitialized: boolean;
  workspaceIssue?: string;
  mcpConfigured: boolean;
  mcpLocations: string[];
  decision: EntryDecision;
  recommendations: string[];
}

/**
 * Read-only facts for the `/stinky-cobbler` entry decision. Never creates a
 * workspace, never acquires the workspace lock, and never writes host config.
 */
export async function preflightEntry(options: PreflightEntryOptions = {}): Promise<EntryPreflight> {
  const workspace = path.resolve(options.workspace ?? process.cwd());
  let via: EntryVia;
  let viaValid = true;
  let viaError: string | undefined;
  try {
    via = parseVia(options.via);
  } catch (error: unknown) {
    viaValid = false;
    via = "auto";
    viaError = error instanceof Error ? error.message : String(error);
  }

  const workspaceCheck = await detectInitializedWorkspace(workspace);
  const mcpCheck = await detectMcpServer({ ...(options.hostConfig ?? {}), workspaceDir: workspace });

  const decision = decideEntry({ viaValid, via, workspaceInitialized: workspaceCheck.initialized, mcpConfigured: mcpCheck.configured });
  return {
    version: 1,
    readOnly: true,
    via,
    viaValid,
    ...(viaError === undefined ? {} : { viaError }),
    workspace,
    workspaceInitialized: workspaceCheck.initialized,
    ...(workspaceCheck.issue === undefined ? {} : { workspaceIssue: workspaceCheck.issue }),
    mcpConfigured: mcpCheck.configured,
    mcpLocations: mcpCheck.locations,
    decision,
    recommendations: recommendationsFor(decision, viaValid, via)
  };
}

/** Checks that `.stinky-cobbler/workspace.json` is a regular file with parseable JSON. */
export async function detectInitializedWorkspace(root: string): Promise<{ initialized: boolean; issue?: string }> {
  const configPath = path.join(root, ".stinky-cobbler", "workspace.json");
  let info;
  try {
    info = await stat(configPath);
  } catch {
    return { initialized: false, issue: "workspace-not-initialized" };
  }
  if (!info.isFile()) return { initialized: false, issue: "workspace-config-not-file" };
  try {
    JSON.parse(await readFile(configPath, "utf8")) as unknown;
  } catch {
    return { initialized: false, issue: "workspace-config-invalid-json" };
  }
  return { initialized: true };
}

/** Detects a Stinky Cobbler MCP server in supported host config locations (read-only). */
export async function detectMcpServer(options: { homeDir?: string; workspaceDir?: string; host?: HostId }): Promise<{ configured: boolean; locations: string[] }> {
  const homeDir = options.homeDir ?? homedir();
  const workspaceDir = options.workspaceDir;
  const selected = options.host === undefined ? hostAdapters : [knownHost(options.host)].filter((adapter) => adapter !== undefined);
  const roots = { home: homeDir, cwd: workspaceDir ?? homeDir };
  const candidates: string[] = [];
  for (const adapter of selected) {
    const userMcp = adapter.locate("mcp-server", "user", roots);
    if (userMcp.unsupported === undefined) candidates.push(userMcp.path);
  }
  for (const adapter of selected) candidates.push(...adapter.extraMcpFiles(roots));
  if (workspaceDir !== undefined) {
    for (const adapter of selected) {
      const projectMcp = adapter.locate("mcp-server", "project", roots);
      if (projectMcp.unsupported === undefined) candidates.push(projectMcp.path);
    }
  }
  const locations: string[] = [];
  for (const file of candidates) {
    if (await hostConfigHasMcpServer(file)) locations.push(file);
  }
  return { configured: locations.length > 0, locations };
}

export async function hostConfigHasMcpServer(file: string): Promise<boolean> {
  let info;
  try {
    info = await stat(file);
  } catch {
    return false;
  }
  if (!info.isFile()) return false;
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return false;
  }
  const isToml = file.endsWith(".toml");
  let value: unknown;
  try {
    value = isToml ? parseToml(raw) : JSON.parse(raw) as unknown;
  } catch {
    return false;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  // `.zcode` config uses nested `mcp.servers`; `.agents/mcp.json` uses top-level `mcpServers`; Codex `config.toml` uses top-level `mcp_servers`.
  const mcp = record.mcp;
  const servers =
    (typeof mcp === "object" && mcp !== null && !Array.isArray(mcp) ? (mcp as Record<string, unknown>).servers : undefined) ??
    record.mcpServers ??
    record.mcp_servers;
  if (typeof servers !== "object" || servers === null || Array.isArray(servers)) return false;
  for (const server of Object.values(servers as Record<string, unknown>)) {
    if (typeof server !== "object" || server === null) continue;
    const command = (server as Record<string, unknown>).command;
    if (typeof command === "string" && command.includes(MCP_SERVER_COMMAND)) return true;
  }
  return false;
}

export function decideEntry(input: { viaValid: boolean; via: EntryVia; workspaceInitialized: boolean; mcpConfigured: boolean }): EntryDecision {
  if (!input.viaValid) return "invalid-via";
  if (input.via === "skill") return "skill-only";
  if (!input.workspaceInitialized) return "workspace-uninitialized";
  return input.mcpConfigured ? "mcp-available" : "mcp-missing";
}

function recommendationsFor(decision: EntryDecision, viaValid: boolean, via: EntryVia): string[] {
  switch (decision) {
    case "skill-only":
      return ["Use the Skill flow only; do not start or call MCP for this request."];
    case "mcp-available":
      return ["MCP is configured; the host MCP client can call stinky-cobbler-mcp tools.", "Keep using Skill for planning and interpretation."];
    case "mcp-missing":
      return ["stinky-cobbler-mcp was not found in the selected host MCP config: Codex config.toml; Claude Code .claude.json or .mcp.json; Cursor mcp.json; ZCode .zcode/cli/config.json, .zcode/config.json, or .agents/mcp.json.", "Review `stinky-cobbler entry mcp-config` for the registration template.", "Explicitly run `stinky-cobbler entry install-host --host zcode` or `--host codex` with `--mcp --dry-run` first, then confirm, if the user asked to configure zcode or codex.", "Do not silently fall back to Skill when via=mcp."];
    case "workspace-uninitialized":
      return ["The workspace has no initialized .stinky-cobbler/workspace.json.", "Offer `stinky-cobbler init --dry-run` for the control-plane preview and wait for the user's explicit choice before initializing.", "Skill-only requests still work without an initialized workspace."];
    case "invalid-via":
      return viaValid ? [] : [`via value was rejected: skill|mcp|auto are the only valid options.`];
  }
}
