import { ARTIFACT_KINDS, type ArtifactKind } from "../core/toolkit/kinds.js";

export { ARTIFACT_KINDS, type ArtifactKind };
export type HostScope = "user" | "project";
/** Documented MCP env syntax. This is not a runtime probe. */
export type DocumentedEnvExpansion = "dollar-env" | "dollar-var" | "name-forwarding" | "unknown";
/** `command-md` is a slash-command markdown file. The architecture sketch had no format for it. */
export type ArtifactFormat = "skill-dir" | "md-segment" | "json-mcp" | "toml-mcp" | "mdc-rule" | "command-md";

export interface HostRoots {
  readonly home: string;
  readonly cwd: string;
}

export interface LocatedArtifact {
  readonly path: string;
  readonly format: ArtifactFormat;
  readonly unsupported?: string;
}

export interface McpServerSpec {
  readonly command: string;
  readonly args: readonly string[];
}

export type McpMergeResult = { readonly status: "unchanged" | "merged"; readonly text: string } | { readonly status: "conflict" | "invalid" };

export interface HostAdapter {
  readonly id: string;
  /** Directory under the home directory whose presence means the host is installed. */
  readonly presenceDirectory: string;
  readonly documentedEnvExpansion: DocumentedEnvExpansion;
  detect(home: string): Promise<boolean>;
  supports(kind: ArtifactKind): boolean;
  locate(kind: ArtifactKind, scope: HostScope, roots: HostRoots): LocatedArtifact;
  readMcp(text: string): Readonly<Record<string, McpServerSpec>>;
  mergeMcp(text: string, id: string, server: McpServerSpec): McpMergeResult;
  extraMcpFiles(roots: HostRoots): readonly string[];
  legacyMcpFile?(roots: HostRoots): string;
  bundledSkillTemplate?: string;
  bundledCommandTemplate?: string;
  mcpRegistration(id: string, command: string): unknown;
}

export function located(file: string, format: ArtifactFormat): LocatedArtifact {
  return { path: file, format };
}

export function unsupported(format: ArtifactFormat, reason: string): LocatedArtifact {
  return { path: "", format, unsupported: reason };
}
