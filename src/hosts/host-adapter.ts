import type { RenderedMcpEntry } from "../core/render/render.js";
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

/**
 * One MCP server as it appears in a host file. `env` holds values in the host's documented syntax
 * (never an expanded secret); `envVars` names variables the host forwards by name (Codex).
 * The toolkit-side shape is `McpServerSpec` in `core/toolkit/spec.ts`; this is its host-file form.
 */
export interface HostMcpEntry {
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly envVars?: readonly string[];
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
  readMcp(text: string): Readonly<Record<string, HostMcpEntry>>;
  mergeMcp(text: string, id: string, server: HostMcpEntry): McpMergeResult;
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

/**
 * Instructions are written as one managed segment inside a markdown file. A target in any other
 * format (for example Cursor's `.cursor/rules` directory of `.mdc` files) has no renderer yet, so it
 * must be skipped rather than inspected or written as a file.
 */
export function rendersInstructionSegment(target: LocatedArtifact): boolean {
  return target.unsupported === undefined && target.path.length > 0 && target.format === "md-segment";
}

/** Why an instruction target is skipped, or undefined when it renders. */
export function instructionSkipReason(host: string, target: LocatedArtifact): string | undefined {
  if (rendersInstructionSegment(target)) return undefined;
  if (target.unsupported !== undefined) return target.unsupported;
  return `${host} instructions target is a ${target.format} target; only md-segment targets are rendered.`;
}

const ENV_REFERENCE = /^\$\{env:([A-Z0-9_./-]+)\}$/;

/**
 * Renders a toolkit MCP entry into the host's documented env syntax. No value is read or expanded:
 * `dollar-env` keeps `${env:NAME}`, `dollar-var` writes `${NAME}`, `name-forwarding` lists NAME in
 * `envVars`, and `unknown` writes nothing (doctor reports SECRET_EXPANSION_UNKNOWN). `${file:PATH}`
 * references have no documented host syntax and are not written.
 */
export function hostMcpEntry(adapter: Pick<HostAdapter, "documentedEnvExpansion">, entry: RenderedMcpEntry): HostMcpEntry {
  const references = envReferences(entry.env ?? {});
  const base = { command: entry.command, args: [...entry.args] };
  if (references.length === 0 || adapter.documentedEnvExpansion === "unknown") return base;
  if (adapter.documentedEnvExpansion === "name-forwarding") {
    return { ...base, envVars: [...new Set(references.map(([, name]) => name))].sort() };
  }
  const env: Record<string, string> = {};
  for (const [key, name] of references) env[key] = adapter.documentedEnvExpansion === "dollar-env" ? `\${env:${name}}` : `\${${name}}`;
  return { ...base, env };
}

export function sameMcpEntry(left: HostMcpEntry, right: HostMcpEntry): boolean {
  return (
    left.command === right.command &&
    sameList(left.args, right.args) &&
    sameList(left.envVars ?? [], right.envVars ?? []) &&
    sameList(sortedPairs(left.env ?? {}), sortedPairs(right.env ?? {}))
  );
}

/** Key order in a host file is formatting, not meaning, so env objects compare as sorted pairs. */
function sortedPairs(env: Readonly<Record<string, string>>): string[] {
  return Object.entries(env)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .flat();
}

function envReferences(env: Readonly<Record<string, string>>): Array<[string, string]> {
  const references: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(env)) {
    const name = ENV_REFERENCE.exec(value)?.[1];
    if (name !== undefined) references.push([key, name]);
  }
  return references;
}

function sameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}
