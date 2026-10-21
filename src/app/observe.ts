import { readFile } from "node:fs/promises";
import path from "node:path";
import type { HostAdapter, HostRoots, HostScope } from "../hosts/host-adapter.js";
import { inspectManagedFile, type ManagedInspection, type ManagedObservationState } from "../io/managed-file.js";
import type { ArtifactKind } from "../core/toolkit/kinds.js";
import type { ToolkitSpec } from "../core/toolkit/spec.js";

export interface HostObservation {
  host: string;
  kind: Extract<ArtifactKind, "skill" | "mcp-server">;
  id: string;
  path: string;
  state: ManagedObservationState;
  hash?: string;
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
    for (const server of spec.mcpServers) observations.push(await observeMcp(adapter, server.id, scope, roots));
  }
  return observations;
}

async function observeSkill(adapter: HostAdapter, id: string, scope: HostScope, roots: HostRoots): Promise<HostObservation> {
  const directory = adapter.locate("skill", scope, roots).path;
  const file = path.join(directory, id, "SKILL.md");
  return observation(adapter.id, "skill", id, file, await inspectManagedFile(file));
}

async function observeMcp(adapter: HostAdapter, id: string, scope: HostScope, roots: HostRoots): Promise<HostObservation> {
  const file = adapter.locate("mcp-server", scope, roots).path;
  const inspection = await inspectManagedFile(file);
  if (inspection.state === "absent") return observation(adapter.id, "mcp-server", id, file, inspection);
  const servers = adapter.readMcp(await readFile(file, "utf8"));
  if (servers[id] === undefined) return observation(adapter.id, "mcp-server", id, file, { state: "absent" });
  return observation(adapter.id, "mcp-server", id, file, inspection);
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
