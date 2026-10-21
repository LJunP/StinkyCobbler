import path from "node:path";
import { directoryExists } from "../io/directory-exists.js";
import { located, unsupported, type ArtifactKind, type HostAdapter, type HostRoots, type HostScope } from "./host-adapter.js";
import { mergeJsonMcp, readJsonMcp } from "./json-mcp.js";

const SERVERS = ["mcpServers"] as const;

/**
 * Managed paths from Cursor docs checked on 2026-10-21.
 * Cursor also reads .agents/skills and the Claude/Codex skill directories.
 * This adapter reports the Cursor-owned directory as the one path it would write.
 */
export const cursorHost = {
  id: "cursor",
  presenceDirectory: ".cursor",
  documentedEnvExpansion: "dollar-env",
  detect: (home) => directoryExists(path.join(home, ".cursor")),
  supports: (kind) => kind === "skill" || kind === "mcp-server" || kind === "instructions",
  locate: (kind, scope, roots) => locateCursor(kind, scope, roots),
  readMcp: (text) => readJsonMcp(text, SERVERS),
  mergeMcp: (text, id, server) => mergeJsonMcp(text, SERVERS, id, server),
  extraMcpFiles: () => [],
  mcpRegistration: (id, command) => ({ mcpServers: { [id]: { command, args: [] } } })
} satisfies HostAdapter;

function locateCursor(kind: ArtifactKind, scope: HostScope, roots: HostRoots) {
  const base = path.join(scope === "user" ? roots.home : roots.cwd, ".cursor");
  if (kind === "skill") return located(path.join(base, "skills"), "skill-dir");
  if (kind === "mcp-server") return located(path.join(base, "mcp.json"), "json-mcp");
  if (kind === "instructions" && scope === "project") return located(path.join(base, "rules"), "mdc-rule");
  if (kind === "instructions") return unsupported("mdc-rule", "Cursor user-level rules path was not in the rules document checked on 2026-10-21.");
  return unsupported("command-md", "Cursor has no verified custom slash-command directory in the docs checked on 2026-10-21.");
}
