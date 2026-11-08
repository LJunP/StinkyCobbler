import { createHash } from "node:crypto";
import type { ArtifactKind, ToolkitHostId } from "../toolkit/kinds.js";
import { HOST_IDS } from "../toolkit/kinds.js";
import type { InstructionsSpec, McpServerSpec, SkillSpec, ToolkitSpec } from "../toolkit/spec.js";
import { renderInstructionSegment, renderMcpEntry, type RenderedMcpEntry } from "../render/render.js";

export interface PlanObservation {
  host: string;
  kind: ArtifactKind;
  id: string;
  path: string;
  state: "absent" | "managed" | "managed-modified" | "foreign";
  hash?: string;
  /** MCP only: false when a managed host file still holds the entry an older spec rendered. */
  current?: boolean;
  /** Instructions only: the body of each marked segment already in the file, keyed by segment id. */
  segments?: Readonly<Record<string, string>>;
}

export interface KindSupport {
  host: string;
  kind: ArtifactKind;
  supported: boolean;
  reason?: string;
}

export interface PlanSources {
  skills?: Record<string, string>;
  instructions?: Record<string, string>;
  memoryFiles?: Record<string, Record<string, string>>;
}

export interface PlanOptions {
  support?: readonly KindSupport[];
  sources?: PlanSources;
  resolvedIds?: readonly string[];
}

export interface FileOp {
  host: string;
  kind: ArtifactKind;
  id: string;
  path: string;
  action: "create" | "replace" | "upsert-segment" | "merge-mcp" | "replace-mcp";
  bytes?: string;
  segment?: string;
  mcpEntry?: RenderedMcpEntry;
  priorHash?: string;
}

export interface PlanConflict {
  host: string;
  kind: ArtifactKind;
  id: string;
  path: string;
  state: "foreign" | "managed-modified";
}

export interface PlanSkip {
  host: string;
  kind: ArtifactKind | "bundle";
  id: string;
  reason: string;
}

/** A managed artifact the spec no longer targets. The toolkit never deletes host files; it reports these. */
export interface PlanOrphan {
  host: string;
  kind: ArtifactKind;
  id: string;
  path: string;
  hash?: string;
}

export interface ToolkitPlan {
  ops: FileOp[];
  conflicts: PlanConflict[];
  skipped: PlanSkip[];
  orphans: PlanOrphan[];
}

interface Draft {
  spec: ToolkitSpec;
  observations: readonly PlanObservation[];
  support: readonly KindSupport[];
  sources: PlanSources;
  wanted: Set<string>;
  ops: FileOp[];
  conflicts: PlanConflict[];
  skipped: PlanSkip[];
  orphans: PlanOrphan[];
}

export function plan(spec: ToolkitSpec, observations: readonly PlanObservation[], options: PlanOptions = {}): ToolkitPlan {
  const draft: Draft = {
    spec,
    observations,
    support: options.support ?? [],
    sources: options.sources ?? {},
    wanted: new Set<string>(),
    ops: [],
    conflicts: [],
    skipped: [],
    orphans: []
  };
  expandBundles(draft, new Set(options.resolvedIds ?? []));
  for (const skill of spec.skills) planSkill(draft, skill);
  for (const server of spec.mcpServers) planMcp(draft, server);
  for (const item of spec.instructions) planInstruction(draft, item);
  reportOrphans(draft);
  return { ops: draft.ops, conflicts: draft.conflicts, skipped: draft.skipped, orphans: draft.orphans };
}

function planSkill(draft: Draft, skill: SkillSpec): void {
  for (const host of targetHosts(draft.spec, skill.hosts)) {
    const found = guard(draft, "skill", skill.id, host);
    if (found === undefined) continue;
    const body = draft.sources.skills?.[skill.id];
    if (body === undefined) {
      draft.skipped.push({ host, kind: "skill", id: skill.id, reason: "Skill body was not provided." });
      continue;
    }
    const op = skillOp(skill.id, host, found, body);
    if (op) draft.ops.push(op);
  }
}

/**
 * An absent entry is merged in. A managed file whose entry an older spec rendered is replaced in
 * place: the file still has the exact bytes the toolkit wrote, so nothing a user typed is lost.
 * A hand-edited file never gets here; `guard` turns it into a conflict.
 */
function planMcp(draft: Draft, server: McpServerSpec): void {
  for (const host of targetHosts(draft.spec)) {
    const found = guard(draft, "mcp-server", server.id, host);
    if (found === undefined) continue;
    const base = { host, kind: "mcp-server" as const, id: server.id, path: found.path, mcpEntry: renderMcpEntry(server) };
    if (found.state === "absent") draft.ops.push({ ...base, action: "merge-mcp" });
    else if (found.state === "managed" && found.current === false) draft.ops.push({ ...base, action: "replace-mcp", ...priorHash(found) });
  }
}

function planInstruction(draft: Draft, item: InstructionsSpec): void {
  const memory = item.kind === "memory";
  for (const host of instructionHosts(draft.spec, item)) {
    const found = guard(draft, "instructions", item.id, host, memory);
    if (found === undefined) continue;
    const body = draft.sources.instructions?.[item.id];
    if (body === undefined) {
      draft.skipped.push({ host, kind: "instructions", id: item.id, reason: "Instruction body was not provided." });
      continue;
    }
    const wanted = [{ id: item.id, body }, ...(memory ? memoryFileSegments(draft, item) : [])];
    for (const segment of wanted) {
      if (found.state === "managed" && holdsSegment(found, segment.id, segment.body)) continue;
      draft.ops.push({
        host,
        kind: "instructions",
        id: segment.id,
        path: found.path,
        action: "upsert-segment",
        segment: renderInstructionSegment({ ...item, id: segment.id }, host, segment.body),
        ...(found.state === "managed" ? priorHash(found) : {})
      });
    }
  }
}

function memoryFileSegments(draft: Draft, item: InstructionsSpec): Array<{ id: string; body: string }> {
  const files = draft.sources.memoryFiles?.[item.id];
  if (files === undefined) return [];
  const segments: Array<{ id: string; body: string }> = [];
  for (const name of Object.keys(files).sort()) {
    const stem = name.slice(0, -3);
    const body = files[name];
    if (body === undefined || stem === item.id || stem.length === 0) continue;
    segments.push({ id: stem, body });
  }
  return segments;
}

function holdsSegment(found: PlanObservation, id: string, body: string): boolean {
  return found.segments !== undefined && Object.hasOwn(found.segments, id) && found.segments[id] === segmentText(body);
}

/** The bytes `upsertSegment` stores between the markers for this body. */
function segmentText(body: string): string {
  return body.endsWith("\n") ? body : `${body}\n`;
}

function priorHash(found: PlanObservation): { priorHash?: string } {
  return found.hash === undefined ? {} : { priorHash: found.hash };
}

function guard(draft: Draft, kind: ArtifactKind, id: string, host: string, allowForeign = false): PlanObservation | undefined {
  draft.wanted.add(key(host, kind, id));
  const blocked = draft.support.find((item) => item.host === host && item.kind === kind && !item.supported);
  if (blocked) {
    draft.skipped.push({ host, kind, id, reason: blocked.reason ?? "Host does not support this artifact." });
    return undefined;
  }
  const found = draft.observations.find((item) => item.host === host && item.kind === kind && item.id === id);
  if (found === undefined) {
    draft.skipped.push({ host, kind, id, reason: "No observation for this target." });
    return undefined;
  }
  if (found.state === "managed-modified" || (found.state === "foreign" && !allowForeign)) {
    draft.conflicts.push({ host, kind, id, path: found.path, state: found.state });
    return undefined;
  }
  return found;
}

function skillOp(id: string, host: string, found: PlanObservation, body: string): FileOp | undefined {
  if (found.state === "managed" && found.hash === sha256(body)) return undefined;
  const action = found.state === "managed" ? "replace" : "create";
  return {
    host,
    kind: "skill",
    id,
    path: found.path,
    action,
    bytes: body,
    ...(action === "replace" && found.hash !== undefined ? { priorHash: found.hash } : {})
  };
}

function reportOrphans(draft: Draft): void {
  for (const found of draft.observations) {
    if (found.state !== "managed" || !selectedHosts(draft.spec).includes(found.host)) continue;
    if (draft.wanted.has(key(found.host, found.kind, found.id))) continue;
    draft.orphans.push({
      host: found.host,
      kind: found.kind,
      id: found.id,
      path: found.path,
      ...(found.hash === undefined ? {} : { hash: found.hash })
    });
  }
}

function targetHosts(spec: ToolkitSpec, limited?: readonly string[]): string[] {
  const top = selectedHosts(spec);
  return (limited ?? top).filter((host) => top.includes(host));
}

function instructionHosts(spec: ToolkitSpec, item: InstructionsSpec): ToolkitHostId[] {
  return selectedHosts(spec).filter((host): host is ToolkitHostId => item.render?.[host as ToolkitHostId] !== undefined);
}

function selectedHosts(spec: ToolkitSpec): string[] {
  return [...(spec.hosts ?? HOST_IDS)];
}

function expandBundles(draft: Draft, resolved: ReadonlySet<string>): void {
  const host = selectedHosts(draft.spec)[0] ?? HOST_IDS[0];
  for (const bundle of draft.spec.bundles) {
    for (const include of bundle.includes) {
      const reason = resolved.has(include) ? `Include ${include} is expanded from the lock.` : `Include ${include} is not resolved in the lock.`;
      draft.skipped.push({ host, kind: "bundle", id: bundle.id, reason });
    }
  }
}

function key(host: string, kind: string, id: string): string {
  return `${host}\0${kind}\0${id}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
