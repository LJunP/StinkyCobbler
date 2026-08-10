import path from "node:path";

export type HostId = "zcode" | "codex";
export type HostConfigFormat = "json" | "toml";

export interface HostSpec {
  id: HostId;
  /** User-level host directory name, relative to the home directory (e.g. `.zcode`, `.codex`). */
  userDir: string;
  /** Whether the host supports custom slash command files (Codex has none). */
  supportsCommandFile: boolean;
  /** Skill location relative to the host base (user level). */
  skillHostRelative: string;
  /** User-level MCP config location relative to the host base. */
  mcpConfigUserRelative: string;
  /** Workspace-level MCP config location relative to the workspace root (e.g. `.zcode/config.json`). */
  mcpConfigWorkspaceRelative: string;
  /** MCP config file format. */
  mcpConfigFormat: HostConfigFormat;
  /** Skill template location relative to the package root (install source). */
  skillTemplateRelative: string;
  /** Command template location relative to the package root; absent when the host has no command files. */
  commandTemplateRelative?: string;
}

export const ZCODE_HOST: HostSpec = {
  id: "zcode",
  userDir: ".zcode",
  supportsCommandFile: true,
  skillHostRelative: path.join("skills", "stinky-cobbler", "SKILL.md"),
  mcpConfigUserRelative: path.join("cli", "config.json"),
  mcpConfigWorkspaceRelative: path.join(".zcode", "config.json"),
  mcpConfigFormat: "json",
  skillTemplateRelative: path.join(".zcode", "skills", "stinky-cobbler", "SKILL.md"),
  commandTemplateRelative: path.join(".zcode", "commands", "stinky-cobbler.md")
};

export const CODEX_HOST: HostSpec = {
  id: "codex",
  userDir: ".codex",
  supportsCommandFile: false,
  skillHostRelative: path.join("skills", "stinky-cobbler", "SKILL.md"),
  mcpConfigUserRelative: "config.toml",
  mcpConfigWorkspaceRelative: path.join(".codex", "config.toml"),
  mcpConfigFormat: "toml",  skillTemplateRelative: path.join(".codex", "skills", "stinky-cobbler", "SKILL.md")
};

export const HOST_SPECS: Record<HostId, HostSpec> = { zcode: ZCODE_HOST, codex: CODEX_HOST };
export const HOST_IDS: HostId[] = ["zcode", "codex"];

export function isHostId(value: unknown): value is HostId {
  return typeof value === "string" && (value === "zcode" || value === "codex");
}

export function resolveHostSpec(host: unknown): HostSpec | undefined {
  return isHostId(host) ? HOST_SPECS[host] : undefined;
}
