import path from "node:path";
import { directoryExists } from "../io/directory-exists.js";
import { located, unsupported, type ArtifactKind, type HostAdapter, type HostRoots, type HostScope } from "./host-adapter.js";
import { mergeTomlMcp, readTomlMcp } from "./toml-mcp.js";

const UNSUPPORTED_KIND = new Set<ArtifactKind>(["instructions", "command"]);

/** Codex paths verified by the 2.0.1 installer and its tests. */
export const codexHost = {
  id: "codex",
  presenceDirectory: ".codex",
  documentedEnvExpansion: "name-forwarding",
  bundledSkillTemplate: path.join("resources", "gate", "skills", "codex", "SKILL.md"),
  detect: (home) => directoryExists(path.join(home, ".codex")),
  supports: (kind) => !UNSUPPORTED_KIND.has(kind),
  locate: (kind, scope, roots) => locateCodex(kind, scope, roots),
  readMcp: readTomlMcp,
  mergeMcp: mergeTomlMcp,
  extraMcpFiles: () => [],
  mcpRegistration: (id, command) => ({ host: "codex", format: "toml", mcp_servers: { [id]: { command, args: [] } } })
} satisfies HostAdapter;

function locateCodex(kind: ArtifactKind, scope: HostScope, roots: HostRoots) {
  const base = path.join(scope === "user" ? roots.home : roots.cwd, ".codex");
  if (kind === "skill") return located(path.join(base, "skills"), "skill-dir");
  if (kind === "mcp-server") return located(path.join(base, "config.toml"), "toml-mcp");
  if (kind === "command") return unsupported("command-md", "Codex has no custom slash-command file.");
  return unsupported("md-segment", "Codex instruction file path is not part of the verified 2.0.1 host layout.");
}
