import { access, mkdir, open, readFile, writeFile, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Pack, Profile, RoleDefinition, RoleRegistry } from "../contracts/types.js";
import type { SchemaRegistry } from "../contracts/schema-registry.js";
import { ExitCode, StinkyCobblerError } from "../errors.js";
import {
  createWorkspaceJson,
  openWorkspace,
  workspaceFile,
  type LocalWorkspace
} from "../storage/workspace.js";
import type { Registries } from "./registry.js";
import { withWorkspaceLock } from "../storage/workspace-lock.js";

export const WORKSPACE_CONFIG_FILE = "workspace.json";

export type WorkspaceMode = Profile["defaultAutomation"];

export interface WorkspaceRoleOverride {
  displayName: string;
}

export interface WorkspacePluginSelection { enabled: boolean; }

export interface WorkspaceConfig {
  version: 1 | 2;
  workspaceId: string;
  root: string;
  profile: string;
  packs: string[];
  mode: WorkspaceMode;
  allowLocalL0Exploration?: boolean;
  roles: Record<string, WorkspaceRoleOverride>;
  plugins?: Record<string, WorkspacePluginSelection>;
}

export interface ResolvedWorkspaceConfig {
  config: WorkspaceConfig;
  profile: Profile;
  packs: Pack[];
  roles: RoleRegistry;
  plugins: Array<{ id: string; recommendedByPacks: string[]; workspaceSelection: "enabled" | "disabled" | "unset"; selected: boolean; effective: boolean; executable: boolean; implementationAvailable: boolean }>;
}

export interface WorkspaceConfigCheck {
  healthy: boolean;
  config?: WorkspaceConfig;
  error?: { code: string; message: string; details: Record<string, unknown> };
}

/**
 * Reads and resolves the configuration stored in a workspace. Resolution keeps
 * stable role IDs intact and applies only the persisted displayName overrides.
 */
export class WorkspaceConfigService {
  public constructor(
    private readonly schemas: SchemaRegistry,
    private readonly registries: Registries
  ) {}

  public async read(workspaceOrRoot: LocalWorkspace | string): Promise<unknown> {
    const workspace = await asWorkspace(workspaceOrRoot);
    return readWorkspaceConfigFile(workspace);
  }

  public async load(workspaceOrRoot: LocalWorkspace | string): Promise<WorkspaceConfig> {
    const workspace = await asWorkspace(workspaceOrRoot);
    const value = await readWorkspaceConfigFile(workspace);
    return validateWorkspaceConfig(value, this.schemas, this.registries, workspace.root);
  }

  public async resolve(workspaceOrRoot: LocalWorkspace | string): Promise<ResolvedWorkspaceConfig> {
    const workspace = await asWorkspace(workspaceOrRoot);
    const config = await this.load(workspace);
    return resolveWorkspaceConfig(config, this.registries);
  }

  public validate(value: unknown, workspaceRoot?: string): WorkspaceConfig {
    return validateWorkspaceConfig(value, this.schemas, this.registries, workspaceRoot);
  }
}

/** Reads the raw JSON object from .stinky-cobbler/workspace.json. */
export async function readWorkspaceConfig(workspaceOrRoot: LocalWorkspace | string): Promise<unknown> {
  return readWorkspaceConfigFile(await asWorkspace(workspaceOrRoot));
}

/** Loads, schema-validates, and registry-validates a workspace configuration. */
export async function loadWorkspaceConfig(
  workspaceOrRoot: LocalWorkspace | string,
  schemas: SchemaRegistry,
  registries: Registries
): Promise<WorkspaceConfig> {
  const workspace = await asWorkspace(workspaceOrRoot);
  return validateWorkspaceConfig(await readWorkspaceConfigFile(workspace), schemas, registries, workspace.root);
}

/**
 * Performs schema validation and the cross-references that JSON Schema cannot
 * express: profile existence, profile-enabled packs, and stable role IDs.
 */
export function validateWorkspaceConfig(
  value: unknown,
  schemas: SchemaRegistry,
  registries: Registries,
  workspaceRoot?: string
): WorkspaceConfig {
  schemas.validate("config", value);
  const config = value as WorkspaceConfig;

  if (!path.isAbsolute(config.root)) {
    throw configError("WORKSPACE_CONFIG_ROOT_INVALID", "Workspace config root must be an absolute path.", { root: config.root });
  }
  if (workspaceRoot && path.resolve(config.root) !== path.resolve(workspaceRoot)) {
    throw configError("WORKSPACE_CONFIG_ROOT_MISMATCH", "Workspace config root does not match the workspace being opened.", {
      configuredRoot: config.root,
      workspaceRoot
    });
  }

  const profile = registries.profiles.get(config.profile);
  if (!profile) {
    throw configError("WORKSPACE_CONFIG_PROFILE_UNKNOWN", `Workspace config references unknown profile ${config.profile}.`, {
      profile: config.profile
    });
  }

  for (const packId of config.packs) {
    if (!registries.packs.has(packId)) {
      throw configError("WORKSPACE_CONFIG_PACK_UNKNOWN", `Workspace config references unknown pack ${packId}.`, { pack: packId });
    }
    if (!profile.enabledPacks.includes(packId)) {
      throw configError("WORKSPACE_CONFIG_PACK_NOT_ENABLED", `Profile ${profile.id} does not enable pack ${packId}.`, {
        profile: profile.id,
        pack: packId
      });
    }
  }

  for (const roleId of Object.keys(config.roles)) {
    if (!registries.roles.roles[roleId]) {
      throw configError("WORKSPACE_CONFIG_ROLE_UNKNOWN", `Workspace config references unknown stable role ID ${roleId}.`, {
        role: roleId
      });
    }
  }

  for (const [pluginId, selection] of Object.entries(config.plugins ?? {})) {
    const manifest = registries.plugins.get(pluginId);
    if (!manifest) throw configError("WORKSPACE_CONFIG_PLUGIN_UNKNOWN", `Workspace config references unknown plugin ${pluginId}.`, { plugin: pluginId });
    if (selection.enabled && !registries.pluginDiagnostics.get(pluginId)?.executable) {
      throw configError("WORKSPACE_CONFIG_PLUGIN_NOT_EXECUTABLE", `Plugin ${pluginId} is not executable and cannot be enabled.`, { plugin: pluginId, status: manifest.status });
    }
  }

  return config;
}

/** Returns a copy with all stable role IDs and their effective display names. */
export function resolveWorkspaceConfig(config: WorkspaceConfig, registries: Registries): ResolvedWorkspaceConfig {
  const roles: Record<string, RoleDefinition> = {};
  for (const [roleId, role] of Object.entries(registries.roles.roles)) {
    const override = config.roles[roleId];
    roles[roleId] = override ? { ...role, displayName: override.displayName } : { ...role };
  }

  return {
    config,
    profile: registries.profiles.get(config.profile)!,
    packs: config.packs.map((packId) => registries.packs.get(packId)!),
    roles: { version: 1, roles },
    plugins: [...registries.plugins.values()].map((plugin) => {
      const selection = config.plugins?.[plugin.id];
      const diagnostic = registries.pluginDiagnostics.get(plugin.id)!;
      const recommendedByPacks = config.packs
        .map((packId) => registries.packs.get(packId))
        .filter((pack): pack is Pack => pack !== undefined && pack.recommendedPlugins.includes(plugin.id))
        .map((pack) => pack.id)
        .sort();
      const workspaceSelection = selection === undefined ? "unset" : selection.enabled ? "enabled" : "disabled";
      return { id: plugin.id, recommendedByPacks, workspaceSelection, selected: selection?.enabled === true, effective: selection?.enabled === true && diagnostic.executable && diagnostic.implementationAvailable, executable: diagnostic.executable, implementationAvailable: diagnostic.implementationAvailable };
    })
  };
}

export function normalizeWorkspaceConfig(value: WorkspaceConfig): WorkspaceConfig {
  return value.version === 1 ? { ...value, version: 2, plugins: {} } : value;
}

export async function migrateWorkspaceConfig(workspace: LocalWorkspace, schemas: SchemaRegistry, registries: Registries, dryRun: boolean): Promise<{ migrated: boolean; fromVersion: number; toVersion: 2; backup?: string; config: WorkspaceConfig }> {
  return withWorkspaceLock(workspace, async () => {
    const current = await loadWorkspaceConfig(workspace, schemas, registries);
    if (current.version === 2) return { migrated: false, fromVersion: 2, toVersion: 2, config: current };
    const migrated = normalizeWorkspaceConfig(current);
    if (dryRun) return { migrated: false, fromVersion: 1, toVersion: 2, config: migrated };
    const backups = await workspaceFile(workspace, "backups");
    await mkdir(backups, { recursive: true, mode: 0o700 });
    const backup = path.join(backups, `workspace-v1-${randomUUID()}.json`);
    const source = await workspaceFile(workspace, WORKSPACE_CONFIG_FILE);
    await durableWrite(backup, await readFile(source));
    const temporary = await workspaceFile(workspace, `${WORKSPACE_CONFIG_FILE}.${randomUUID()}.tmp`);
    try {
      await durableWrite(temporary, Buffer.from(`${JSON.stringify(migrated, null, 2)}\n`, "utf8"));
      await rename(temporary, source);
      await syncDirectory(workspace.directory);
    } finally {
      await rm(temporary, { force: true });
    }
    return { migrated: true, fromVersion: 1, toVersion: 2, backup: ".stinky-cobbler/backups/" + path.basename(backup), config: migrated };
  });
}

async function durableWrite(file: string, contents: string | Buffer): Promise<void> {
  const handle = await open(file, "wx", 0o600);
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try { await handle.sync(); }
  finally { await handle.close(); }
}


export async function createWorkspaceConfig(workspace: LocalWorkspace, config: WorkspaceConfig): Promise<void> {
  try {
    await createWorkspaceJson(workspace, WORKSPACE_CONFIG_FILE, config);
  } catch (error: unknown) {
    if (isAlreadyExists(error)) {
      throw configError("WORKSPACE_ALREADY_INITIALIZED", "Workspace is already initialized; init will not overwrite workspace.json.", {
        root: workspace.root,
        file: path.join(".stinky-cobbler", WORKSPACE_CONFIG_FILE)
      });
    }
    throw error;
  }
}

/** Checks the initialization sentinel without changing the workspace. */
export async function workspaceConfigExists(workspace: LocalWorkspace): Promise<boolean> {
  try {
    const file = await workspaceFile(workspace, WORKSPACE_CONFIG_FILE);
    await access(file);
    return true;
  } catch (error: unknown) {
    if (isNotFound(error)) return false;
    if (error instanceof StinkyCobblerError && error.code === "PATH_DENIED") throw error;
    return false;
  }
}

async function readWorkspaceConfigFile(workspace: LocalWorkspace): Promise<unknown> {
  let file: string;
  try {
    await access(workspace.directory);
    file = await workspaceFile(workspace, WORKSPACE_CONFIG_FILE);
  } catch (error: unknown) {
    if (isNotFound(error) || isMissingMetadataDirectory(error)) {
      throw configError("WORKSPACE_CONFIG_NOT_FOUND", "Workspace has not been initialized; workspace.json is missing.", {
        root: workspace.root,
        file: path.join(".stinky-cobbler", WORKSPACE_CONFIG_FILE)
      });
    }
    throw error;
  }

  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error: unknown) {
    if (isNotFound(error)) {
      throw configError("WORKSPACE_CONFIG_NOT_FOUND", "Workspace has not been initialized; workspace.json is missing.", {
        root: workspace.root,
        file: path.join(".stinky-cobbler", WORKSPACE_CONFIG_FILE)
      });
    }
    throw error;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch (error: unknown) {
    throw configError("WORKSPACE_CONFIG_INVALID_JSON", "Workspace config is not valid JSON.", {
      file: path.join(".stinky-cobbler", WORKSPACE_CONFIG_FILE),
      cause: error instanceof Error ? error.message : String(error)
    });
  }
}

async function asWorkspace(workspaceOrRoot: LocalWorkspace | string): Promise<LocalWorkspace> {
  return typeof workspaceOrRoot === "string" ? openWorkspace(workspaceOrRoot) : workspaceOrRoot;
}

function configError(code: string, message: string, details: Record<string, unknown>): StinkyCobblerError {
  return new StinkyCobblerError(code, ExitCode.VALIDATION, message, details);
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function isMissingMetadataDirectory(error: unknown): boolean {
  return error instanceof StinkyCobblerError && error.code === "PATH_DENIED" && error.message.includes("must already exist");
}
