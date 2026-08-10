import { accessSync, constants } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { ExitCode, StinkyCobblerError } from "../errors.js";
import { MCP_SERVER_COMMAND, HOST_CONFIG_FILE, hostConfigHasMcpServer } from "./preflight.js";
import { resolveHostSpec, type HostId, type HostSpec } from "./host-spec.js";

export type HostScope = "user" | "workspace";
export const COMMAND_FILE_NAME = "stinky-cobbler.md";
export const MCP_SERVER_ID = "stinky-cobbler-local";
/** Legacy ZCode installs wrote to `~/.zcode/config.json`; detected for migration hints only. */
export const LEGACY_HOST_CONFIG_RELATIVE = HOST_CONFIG_FILE;

export interface InstallHostOptions {
  host?: HostId;
  scope?: HostScope;
  dryRun?: boolean;
  installMcp?: boolean;
  /** Test-only overrides. */
  homeDir?: string;
  cwd?: string;
  commandTemplatePath?: string;
  skillTemplatePath?: string;
}

export interface HostFileAction {
  action: "preview" | "installed" | "ready" | "conflict" | "skipped";
  target: string;
  detail?: string;
  before?: unknown;
  after?: unknown;
}

export interface InstallHostResult {
  version: 1;
  dryRun: boolean;
  host: HostId;
  command: HostFileAction;
  skill: HostFileAction;
  mcp?: HostFileAction;
}

/**
 * Installs the `/stinky-cobbler` entry into a supported host: the command file
 * (only for hosts that support slash commands), the matching skill file (the
 * command references `skills: stinky-cobbler`, so both must be present), and —
 * only when the user explicitly passes `--mcp` — the MCP server registration
 * into the host's MCP config (JSON for ZCode, TOML for Codex). Never runs
 * automatically; never overwrites existing content; dry-run previews write
 * nothing. Codex has no custom command mechanism, so its command action is
 * `skipped`.
 */
export async function installHost(options: InstallHostOptions = {}): Promise<InstallHostResult> {
  const host = resolveHostSpec(options.host) ?? resolveHostSpec("zcode") as HostSpec;
  const dryRun = options.dryRun === true;
  const paths = resolveHostPaths(host, options);
  const command: HostFileAction = host.supportsCommandFile
    ? await installBundledFile(host, paths.commandFile ?? "", "command file", {
        dryRun,
        ...(options.commandTemplatePath === undefined ? {} : { templatePath: options.commandTemplatePath })
      })
    : {
        action: "skipped",
        target: relativeHostPath(path.join(baseFor(host, options), "commands", COMMAND_FILE_NAME)),
        detail: "This host has no custom slash command mechanism; the skill and MCP entry apply."
      };
  const skill = await installBundledFile(host, paths.skillFile, "skill file", {
    dryRun,
    ...(options.skillTemplatePath === undefined ? {} : { templatePath: options.skillTemplatePath })
  });
  const installMcp = options.installMcp === true;
  const mcp = installMcp ? await installMcpConfigFor(host, paths.configFile, {
    dryRun,
    mcpCommand: resolveMcpServerCommand(),
    ...(paths.legacyConfigFile === undefined ? {} : { legacyConfigFile: paths.legacyConfigFile })
  }) : undefined;
  return {
    version: 1,
    dryRun,
    host: host.id,
    command,
    skill,
    ...(mcp === undefined ? {} : { mcp })
  };
}

/** Returns the MCP server registration JSON that `entry mcp-config` prints for JSON hosts. */
export function mcpServerConfigTemplate(command = MCP_SERVER_COMMAND): { mcp: { servers: Record<string, { command: string; args: string[] }> } } {
  return { mcp: { servers: { [MCP_SERVER_ID]: { command, args: [] } } } };
}

/** Returns the Codex (TOML) MCP server registration that `entry mcp-config --host codex` prints. */
export function mcpServerConfigTemplateToml(command = MCP_SERVER_COMMAND): { mcp_servers: Record<string, { command: string; args: string[] }> } {
  return { mcp_servers: { [MCP_SERVER_ID]: { command, args: [] } } };
}

/** Resolves the MCP server command to an absolute path when found on PATH (GUI hosts may not inherit the shell PATH). */
export function resolveMcpServerCommand(command = MCP_SERVER_COMMAND): string {
  if (path.isAbsolute(command)) return command;
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, command);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return command;
}

interface HostPaths {
  commandFile?: string;
  skillFile: string;
  configFile: string;
  legacyConfigFile?: string;
}

function baseFor(host: HostSpec, options: InstallHostOptions): string {
  const scope = options.scope ?? "user";
  return scope === "user"
    ? path.join(options.homeDir ?? homedir(), host.userDir)
    : path.join(options.cwd ?? process.cwd(), host.userDir);
}

function resolveHostPaths(host: HostSpec, options: InstallHostOptions): HostPaths {
  const scope = options.scope ?? "user";
  const base = baseFor(host, options);
  return {
    ...(host.supportsCommandFile ? { commandFile: path.join(base, "commands", COMMAND_FILE_NAME) } : {}),
    skillFile: path.join(base, host.skillHostRelative),
    configFile: scope === "user"
      ? path.join(base, host.mcpConfigUserRelative)
      : path.join(options.cwd ?? process.cwd(), host.mcpConfigWorkspaceRelative),
    ...(scope === "user" && host.id === "zcode" ? { legacyConfigFile: path.join(base, LEGACY_HOST_CONFIG_RELATIVE) } : {})
  };
}

async function installBundledFile(host: HostSpec, target: string, kind: string, options: { dryRun: boolean; templatePath?: string }): Promise<HostFileAction> {
  const templatePath = options.templatePath ?? defaultTemplatePath(host, kind);
  const label = `${kind.charAt(0).toUpperCase()}${kind.slice(1)}`;
  let template: string;
  try {
    template = await readFile(templatePath, "utf8");
  } catch {
    throw installError("ENTRY_TEMPLATE_MISSING", `The bundled ${kind} template is missing from the installation.`, { templatePath });
  }
  const existing = await readExisting(target);
  const targetRelative = relativeHostPath(target);
  if (options.dryRun) {
    const action: HostFileAction = existing === undefined
      ? { action: "preview", target: targetRelative, detail: `Would create the ${kind}.` }
      : existing === template
        ? { action: "ready", target: targetRelative, detail: `${label} already installed and up to date.` }
        : { action: "conflict", target: targetRelative, detail: `${label} already exists with different content; refusing to overwrite.` };
    return action;
  }
  if (existing === template) return { action: "ready", target: targetRelative };
  if (existing !== undefined) {
    return { action: "conflict", target: targetRelative, detail: `${label} already exists with different content; refusing to overwrite.` };
  }
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(target, template, { encoding: "utf8", mode: 0o600 });
  return { action: "installed", target: targetRelative };
}

async function installMcpConfigFor(host: HostSpec, configFile: string, options: { dryRun: boolean; mcpCommand: string; legacyConfigFile?: string }): Promise<HostFileAction> {
  if (host.mcpConfigFormat === "toml") {
    return installMcpConfigToml(configFile, { dryRun: options.dryRun, mcpCommand: options.mcpCommand });
  }
  return installMcpConfigJson(configFile, options);
}

async function installMcpConfigJson(configFile: string, options: { dryRun: boolean; mcpCommand: string; legacyConfigFile?: string }): Promise<HostFileAction> {
  const targetRelative = relativeHostPath(configFile);
  const existing = await readJsonConfig(configFile);
  if (existing === "invalid") {
    throw installError("ENTRY_HOST_CONFIG_INVALID", "The host config.json exists but is not valid JSON; refusing to modify it.", { configFile: targetRelative });
  }
  const config = (existing ?? {}) as Record<string, unknown>;

  const servers = (((config.mcp as { servers?: Record<string, unknown> } | undefined)?.servers) ?? {}) as Record<string, unknown>;
  const current = servers[MCP_SERVER_ID];
  if (current !== undefined) {
    if (isMcpServerForStinkyCobbler(current)) {
      return { action: "ready", target: targetRelative, detail: "MCP server is already registered." };
    }
    throw installError("ENTRY_HOST_CONFIG_CONFLICT", `An existing ${MCP_SERVER_ID} server uses a different command; refusing to overwrite it.`, { configFile: targetRelative });
  }

  const template = mcpServerConfigTemplate(options.mcpCommand);
  const next = { ...config, mcp: { ...(((config.mcp as Record<string, unknown> | undefined) ?? {})), servers: { ...servers, ...template.mcp.servers } } };
  const legacyHint = options.legacyConfigFile !== undefined && await hostConfigHasMcpServer(options.legacyConfigFile)
    ? ` Legacy registration found at ${relativeHostPath(options.legacyConfigFile)}; it is not read by ZCode and can be deleted.`
    : "";
  if (options.dryRun) {
    // Preview only the MCP-relevant subset — the host config may contain credentials.
    const before = { mcp: config.mcp };
    const after = { mcp: next.mcp };
    return { action: "preview", target: targetRelative, detail: `Would register the MCP server in host ${HOST_CONFIG_FILE}.${legacyHint}`, before, after };
  }
  await backupExistingConfig(configFile);
  await mkdir(path.dirname(configFile), { recursive: true, mode: 0o700 });
  await writeFile(configFile, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return { action: "installed", target: targetRelative, detail: `MCP server registered in host ${HOST_CONFIG_FILE}.${legacyHint}` };
}

async function installMcpConfigToml(configFile: string, options: { dryRun: boolean; mcpCommand: string }): Promise<HostFileAction> {
  const targetRelative = relativeHostPath(configFile);
  const existing = await readTomlConfig(configFile);
  if (existing === "invalid") {
    throw installError("ENTRY_HOST_CONFIG_INVALID", "The host config.toml exists but is not valid TOML; refusing to modify it.", { configFile: targetRelative });
  }
  const config = (existing ?? {}) as Record<string, unknown>;
  const servers = (typeof config.mcp_servers === "object" && config.mcp_servers !== null && !Array.isArray(config.mcp_servers)
    ? config.mcp_servers
    : {}) as Record<string, unknown>;
  const current = servers[MCP_SERVER_ID];
  if (current !== undefined) {
    if (isMcpServerForStinkyCobbler(current)) {
      return { action: "ready", target: targetRelative, detail: "MCP server is already registered." };
    }
    throw installError("ENTRY_HOST_CONFIG_CONFLICT", `An existing ${MCP_SERVER_ID} server uses a different command; refusing to overwrite it.`, { configFile: targetRelative });
  }

  const template = mcpServerConfigTemplateToml(options.mcpCommand);
  const next = { ...config, mcp_servers: { ...servers, ...template.mcp_servers } };
  if (options.dryRun) {
    // Preview only the MCP-relevant subset — the host config may contain credentials.
    const before = { mcp_servers: config.mcp_servers };
    const after = { mcp_servers: next.mcp_servers };
    return { action: "preview", target: targetRelative, detail: "Would register the MCP server in host config.toml.", before, after };
  }
  await backupExistingConfig(configFile);
  await mkdir(path.dirname(configFile), { recursive: true, mode: 0o700 });
  await writeFile(configFile, `${stringifyToml(next)}\n`, { encoding: "utf8", mode: 0o600 });
  return { action: "installed", target: targetRelative, detail: "MCP server registered in host config.toml." };
}

async function readJsonConfig(file: string): Promise<unknown | "invalid" | undefined> {
  let info;
  try {
    info = await stat(file);
  } catch {
    return undefined;
  }
  if (!info.isFile()) return "invalid";
  try {
    return JSON.parse(await readFile(file, "utf8")) as unknown;
  } catch {
    return "invalid";
  }
}

async function readTomlConfig(file: string): Promise<unknown | "invalid" | undefined> {
  let info;
  try {
    info = await stat(file);
  } catch {
    return undefined;
  }
  if (!info.isFile()) return "invalid";
  try {
    return parseToml(await readFile(file, "utf8")) as unknown;
  } catch {
    return "invalid";
  }
}

async function backupExistingConfig(file: string): Promise<void> {
  let info;
  try {
    info = await stat(file);
  } catch {
    return;
  }
  if (!info.isFile()) return;
  const backup = path.join(path.dirname(file), `${path.basename(file)}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  await rename(file, backup);
}

async function readExisting(file: string): Promise<string | undefined> {
  let info;
  try {
    info = await stat(file);
  } catch {
    return undefined;
  }
  if (!info.isFile()) return undefined;
  return readFile(file, "utf8");
}

function isMcpServerForStinkyCobbler(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const command = (value as Record<string, unknown>).command;
  return typeof command === "string" && command.includes(MCP_SERVER_COMMAND);
}

function defaultTemplatePath(host: HostSpec, kind: string): string {
  const relative = kind === "skill file"
    ? host.skillTemplateRelative
    : (host.commandTemplateRelative ?? path.join(host.userDir, "commands", COMMAND_FILE_NAME));
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..", relative);
}

function relativeHostPath(file: string): string {
  const home = homedir();
  return file.startsWith(`${home}${path.sep}`) ? path.join("~", path.relative(home, file)) : file;
}

function installError(code: string, message: string, details: Record<string, unknown> = {}): StinkyCobblerError {
  return new StinkyCobblerError(code, ExitCode.POLICY_DENIED, message, details);
}
