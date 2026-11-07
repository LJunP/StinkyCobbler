import path from "node:path";
import { directoryExists } from "../io/directory-exists.js";
import { located, type ArtifactKind, type HostAdapter, type HostRoots, type HostScope } from "./host-adapter.js";
import { mergeJsonMcp, readJsonMcp } from "./json-mcp.js";

const SERVERS = ["mcp", "servers"] as const;

/** ZCode paths verified by the 2.0.1 installer and its tests. */
export const zcodeHost = {
  id: "zcode",
  presenceDirectory: ".zcode",
  documentedEnvExpansion: "unknown",
  bundledSkillTemplate: path.join("resources", "gate", "skills", "zcode", "SKILL.md"),
  bundledCommandTemplate: path.join("resources", "gate", "skills", "zcode", "commands", "stinky-cobbler.md"),
  detect: (home) => directoryExists(path.join(home, ".zcode")),
  supports: (kind) => kind !== "instructions",
  locate: (kind, scope, roots) => locateZcode(kind, scope, roots),
  readMcp: (text) => readJsonMcp(text, SERVERS),
  mergeMcp: (text, id, server) => mergeJsonMcp(text, SERVERS, id, server),
  extraMcpFiles: (roots) => [path.join(roots.home, ".zcode", "config.json"), path.join(roots.home, ".agents", "mcp.json")],
  legacyMcpFile: (roots) => path.join(roots.home, ".zcode", "config.json"),
  mcpRegistration: (id, command) => ({ mcp: { servers: { [id]: { command, args: [] } } } })
} satisfies HostAdapter;

function locateZcode(kind: ArtifactKind, scope: HostScope, roots: HostRoots) {
  const base = path.join(scope === "user" ? roots.home : roots.cwd, ".zcode");
  if (kind === "skill") return located(path.join(base, "skills"), "skill-dir");
  if (kind === "command") return located(path.join(base, "commands"), "command-md");
  if (kind === "mcp-server" && scope === "user") return located(path.join(base, "cli", "config.json"), "json-mcp");
  if (kind === "mcp-server") return located(path.join(roots.cwd, ".zcode", "config.json"), "json-mcp");
  return { path: "", format: "md-segment" as const, unsupported: "ZCode has no verified instruction file in the 2.0.1 layout." };
}
