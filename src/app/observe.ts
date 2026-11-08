import { readFile } from "node:fs/promises";
import path from "node:path";
import { hostMcpEntry, rendersInstructionSegment, sameMcpEntry, type HostAdapter, type HostRoots, type HostScope } from "../hosts/host-adapter.js";
import { inspectManagedFile, type ManagedInspection, type ManagedObservationState } from "../io/managed-file.js";
import { readSegments } from "../io/segment-file.js";
import { HOST_IDS, type ArtifactKind, type ToolkitHostId } from "../core/toolkit/kinds.js";
import { renderMcpEntry } from "../core/render/render.js";
import type { McpServerSpec, ToolkitSpec } from "../core/toolkit/spec.js";

export interface HostObservation {
  host: string;
  kind: Extract<ArtifactKind, "skill" | "mcp-server" | "instructions">;
  id: string;
  path: string;
  state: ManagedObservationState;
  hash?: string;
  /** MCP only: false when a managed file still holds the entry an older spec rendered. */
  current?: boolean;
  /** Instructions only: marked segment bodies already in the file. */
  segments?: Readonly<Record<string, string>>;
}

export async function observe(input: { adapters: readonly HostAdapter[]; spec: ToolkitSpec; scope: HostScope; roots: HostRoots }): Promise<HostObservation[]> {
  const observations: HostObservation[] = [];
  for (const adapter of selectedAdapters(input.adapters, input.spec.hosts)) {
    observations.push(...(await observeHost(adapter, input.spec, input.scope, input.roots)));
  }
  return observations;
}

async function observeHost(adapter: HostAdapter, spec: ToolkitSpec, scope: HostScope, roots: HostRoots): Promise<HostObservation[]> {
  const observations: HostObservation[] = [];
  if (adapter.supports("skill")) {
    for (const skill of spec.skills) observations.push(await observeSkill(adapter, skill.id, scope, roots));
  }
  if (adapter.supports("mcp-server")) {
    for (const server of spec.mcpServers) observations.push(await observeMcp(adapter, server, scope, roots));
  }
  observations.push(...(await observeInstructions(adapter, spec, scope, roots)));
  return observations;
}

async function observeInstructions(adapter: HostAdapter, spec: ToolkitSpec, scope: HostScope, roots: HostRoots): Promise<HostObservation[]> {
  if (!adapter.supports("instructions")) return [];
  const host = hostId(adapter.id);
  if (host === undefined) return [];
  const target = adapter.locate("instructions", scope, roots);
  if (!rendersInstructionSegment(target)) return [];
  const items = spec.instructions.filter((item) => item.render?.[host] !== undefined);
  if (items.length === 0) return [];
  const inspection = await inspectManagedFile(target.path);
  const segments = inspection.state === "managed" ? readSegments(await readFile(target.path, "utf8")) : undefined;
  return items.map((item) => ({
    ...observation(adapter.id, "instructions", item.id, target.path, inspection),
    ...(segments === undefined ? {} : { segments })
  }));
}

async function observeSkill(adapter: HostAdapter, id: string, scope: HostScope, roots: HostRoots): Promise<HostObservation> {
  const directory = adapter.locate("skill", scope, roots).path;
  const file = path.join(directory, id, "SKILL.md");
  return observation(adapter.id, "skill", id, file, await inspectManagedFile(file));
}

async function observeMcp(adapter: HostAdapter, server: McpServerSpec, scope: HostScope, roots: HostRoots): Promise<HostObservation> {
  const file = adapter.locate("mcp-server", scope, roots).path;
  const inspection = await inspectManagedFile(file);
  if (inspection.state === "absent" || inspection.state === "managed-modified") {
    return observation(adapter.id, "mcp-server", server.id, file, inspection);
  }
  const installed = adapter.readMcp(await readFile(file, "utf8"))[server.id];
  if (installed === undefined) return observation(adapter.id, "mcp-server", server.id, file, { state: "absent" });
  const found = observation(adapter.id, "mcp-server", server.id, file, inspection);
  if (inspection.state !== "managed") return found;
  return { ...found, current: sameMcpEntry(installed, hostMcpEntry(adapter, renderMcpEntry(server))) };
}

function hostId(id: string): ToolkitHostId | undefined {
  return HOST_IDS.find((host) => host === id);
}

function selectedAdapters(adapters: readonly HostAdapter[], hosts: readonly string[] | undefined): readonly HostAdapter[] {
  if (hosts === undefined) return adapters;
  const allowed = new Set(hosts);
  return adapters.filter((adapter) => allowed.has(adapter.id));
}

function observation(host: string, kind: HostObservation["kind"], id: string, target: string, inspection: ManagedInspection): HostObservation {
  return {
    host,
    kind,
    id,
    path: target,
    state: inspection.state,
    ...(inspection.hash === undefined ? {} : { hash: inspection.hash })
  };
}
