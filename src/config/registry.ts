import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import type { Pack, PluginDiagnostic, PluginManifest, Profile, RoleRegistry } from "../contracts/types.js";
import { discoverBuiltinPlugins } from "./plugin-discovery.js";
import { SchemaRegistry } from "../contracts/schema-registry.js";
import { ExitCode, StinkyCobblerError } from "../errors.js";

export interface Registries {
  profiles: Map<string, Profile>;
  packs: Map<string, Pack>;
  roles: RoleRegistry;
  plugins: Map<string, PluginManifest>;
  pluginDiagnostics: Map<string, PluginDiagnostic>;
  roleTools: Record<string, string[]>;
}

/** Tools a role lease may grant; must stay aligned with the scheduler capability mapping. */
export const KNOWN_TOOLS = new Set(["repository-read", "repository-list", "git-read", "docs-index", "repository-write"]);

/** Pure validation for the role→tools mapping table: roles must exist, tools must be known. */
export function validateRoleTools(tools: Record<string, string[]>, roles: RoleRegistry, knownTools: Set<string>): void {
  for (const [role, roleTools] of Object.entries(tools)) {
    if (!roles.roles[role]) throw missing("ROLE_TOOLS_UNKNOWN_ROLE", `Role tools references unknown role ${role}.`);
    if (!Array.isArray(roleTools) || roleTools.some((tool) => typeof tool !== "string" || !knownTools.has(tool))) {
      throw missing("ROLE_TOOLS_UNKNOWN_TOOL", `Role ${role} references an unknown tool.`);
    }
    if (new Set(roleTools).size !== roleTools.length) throw missing("ROLE_TOOLS_DUPLICATE", `Role ${role} lists a duplicate tool.`);
  }
}

export async function loadRegistries(projectRoot: string, schemas: SchemaRegistry): Promise<Registries> {
  const profiles = await loadDirectory<Profile>(path.join(projectRoot, "profiles"), schemas, "profile", (item) => item.id);
  const packs = await loadPackDirectory(projectRoot, schemas);
  const coreRoles = await loadYaml<RoleRegistry>(path.join(projectRoot, "policies", "roles.yaml"));
  const extensions = await loadYaml<RoleRegistry>(path.join(projectRoot, "policies", "role-extensions.yaml"));
  const roles: RoleRegistry = { version: 1, roles: { ...coreRoles.roles, ...extensions.roles } };
  schemas.validate("role", roles);
  const roleToolsFile = await loadYaml<{ version: 1; tools: Record<string, string[]> }>(path.join(projectRoot, "policies", "role-tools.yaml"));
  if (roleToolsFile.version !== 1 || typeof roleToolsFile.tools !== "object" || roleToolsFile.tools === null || Array.isArray(roleToolsFile.tools)) {
    throw missing("ROLE_TOOLS_INVALID", "role-tools.yaml must be version 1 with a tools map.");
  }
  validateRoleTools(roleToolsFile.tools, roles, KNOWN_TOOLS);
  const pluginFile = await loadYaml<{ version: 2; plugins: PluginManifest[] }>(path.join(projectRoot, "plugins", "builtin.yaml"));
  for (const plugin of pluginFile.plugins) schemas.validate("plugin", plugin);
  const discovered = discoverBuiltinPlugins(pluginFile.plugins);
  validateReferences(profiles, packs, roles, discovered.plugins);
  return { profiles, packs, roles, plugins: discovered.plugins, pluginDiagnostics: discovered.diagnostics, roleTools: roleToolsFile.tools };
}

async function loadDirectory<T>(directory: string, schemas: SchemaRegistry, kind: "profile", key: (item: T) => string): Promise<Map<string, T>> {
  const result = new Map<string, T>();
  for (const filename of await readdir(directory)) {
    if (!filename.endsWith(".yaml")) continue;
    const item = await loadYaml<T>(path.join(directory, filename));
    schemas.validate(kind, item);
    result.set(key(item), item);
  }
  return result;
}

async function loadPackDirectory(projectRoot: string, schemas: SchemaRegistry): Promise<Map<string, Pack>> {
  const result = new Map<string, Pack>();
  for (const directory of await readdir(path.join(projectRoot, "packs"))) {
    const item = await loadYaml<Pack>(path.join(projectRoot, "packs", directory, "pack.yaml"));
    schemas.validate("pack", item);
    result.set(item.id, item);
  }
  return result;
}

async function loadYaml<T>(file: string): Promise<T> {
  return YAML.parse(await readFile(file, "utf8")) as T;
}

function validateReferences(profiles: Map<string, Profile>, packs: Map<string, Pack>, roles: RoleRegistry, plugins: Map<string, PluginManifest>): void {
  const artifactTypes = new Set(["document", "report", "dataset", "plan", "design", "message", "code-change", "workflow-run", "decision-record", "media", "test-report", "evidence-pack"]);
  for (const profile of profiles.values()) for (const pack of profile.enabledPacks) {
    if (!packs.has(pack)) throw missing("PROFILE_UNKNOWN_PACK", `Profile ${profile.id} references unknown pack ${pack}.`);
  }
  for (const pack of packs.values()) {
    for (const artifact of pack.artifactTypes) if (!artifactTypes.has(artifact)) throw missing("PACK_UNKNOWN_ARTIFACT", `Pack ${pack.id} references unknown artifact type ${artifact}.`);
    for (const role of pack.roleExtensions) if (!roles.roles[role]) throw missing("PACK_UNKNOWN_ROLE", `Pack ${pack.id} references unknown role ${role}.`);
    for (const plugin of pack.recommendedPlugins) if (!plugins.has(plugin)) throw missing("PACK_UNKNOWN_PLUGIN", `Pack ${pack.id} references unknown plugin ${plugin}.`);
  }
}

function missing(code: string, message: string): StinkyCobblerError {
  return new StinkyCobblerError(code, ExitCode.VALIDATION, message);
}
