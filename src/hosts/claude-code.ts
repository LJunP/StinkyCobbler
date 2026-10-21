import path from "node:path";
import { directoryExists } from "../io/directory-exists.js";
import { located, type ArtifactKind, type HostAdapter, type HostRoots, type HostScope } from "./host-adapter.js";
import { mergeJsonMcp, readJsonMcp } from "./json-mcp.js";

const SERVERS = ["mcpServers"] as const;

/**
 * Paths from Claude Code docs checked on 2026-10-21:
 * skills and commands under ~/.claude and .claude; user MCP is ~/.claude.json;
 * project MCP is <cwd>/.mcp.json. CLAUDE_CONFIG_DIR is not applied here.
 */
export const claudeCodeHost = {
  id: "claude-code",
  presenceDirectory: ".claude",
  documentedEnvExpansion: "dollar-var",
  detect: (home) => directoryExists(path.join(home, ".claude")),
  supports: () => true,
  locate: (kind, scope, roots) => locateClaude(kind, scope, roots),
  readMcp: (text) => readJsonMcp(text, SERVERS),
  mergeMcp: (text, id, server) => mergeJsonMcp(text, SERVERS, id, server),
  extraMcpFiles: () => [],
  mcpRegistration: (id, command) => ({ mcpServers: { [id]: { command, args: [] } } })
} satisfies HostAdapter;

function locateClaude(kind: ArtifactKind, scope: HostScope, roots: HostRoots) {
  const homeBase = path.join(roots.home, ".claude");
  const projectBase = path.join(roots.cwd, ".claude");
  if (kind === "skill") return located(path.join(scope === "user" ? homeBase : projectBase, "skills"), "skill-dir");
  if (kind === "command") return located(path.join(scope === "user" ? homeBase : projectBase, "commands"), "command-md");
  if (kind === "instructions") {
    return located(scope === "user" ? path.join(homeBase, "CLAUDE.md") : path.join(roots.cwd, "CLAUDE.md"), "md-segment");
  }
  return located(scope === "user" ? path.join(roots.home, ".claude.json") : path.join(roots.cwd, ".mcp.json"), "json-mcp");
}
