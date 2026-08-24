import { COPYFILE_EXCL } from "node:constants";
import { createHash, randomUUID } from "node:crypto";
import { accessSync, constants } from "node:fs";
import { copyFile, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { ExitCode, StinkyCobblerError } from "../errors.js";
import { STINKY_COBBLER_VERSION } from "../version.js";
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
  /** Restore the last byte-for-byte managed backup instead of installing. */
  rollback?: boolean;
  /** Test-only overrides. */
  homeDir?: string;
  cwd?: string;
  commandTemplatePath?: string;
  skillTemplatePath?: string;
}

export interface HostFileAction {
  action: "preview" | "installed" | "upgraded" | "rolled-back" | "ready" | "conflict" | "skipped";
  target: string;
  detail?: string;
  before?: unknown;
  after?: unknown;
  /** Every persistent path the operation creates or replaces. Hashes are used instead of file contents. */
  writes?: HostWriteEffect[];
}

export interface HostWriteEffect {
  operation: "create" | "replace" | "ensure-backup" | "write-managed-state";
  target: string;
  beforeSha256?: string;
  afterSha256?: string;
  productVersion?: string;
}

export interface InstallHostResult {
  version: 1;
  dryRun: boolean;
  host: HostId;
  command: HostFileAction;
  skill: HostFileAction;
  mcp?: HostFileAction;
}

interface ManagedInstallMetadata {
  version: 1;
  productVersion: string;
  installedSha256: string;
  updatedAt: string;
  previous?: {
    productVersion: string;
    sha256: string;
    backup: string;
  };
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const KNOWN_BUNDLED_VERSIONS = new Map<string, ReadonlyMap<string, string>>([
  ["zcode:command file", new Map([["10f3eb9bb025410367d279da2dad277fbd1ebf6af2af0b7406da090269a5a807", "2.0.0"]])],
  ["zcode:skill file", new Map([["c86e354cda5cc758755a71018f39773fc3b417a668ed57af70a3d66ac7dc6bae", "2.0.0"]])],
  ["codex:skill file", new Map([["d4a9a2ef5ac056de38a8f03542516830f3007cf25695c743686f12e1d7b75325", "2.0.0"]])]
]);

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
        rollback: options.rollback === true,
        ...(options.commandTemplatePath === undefined ? {} : { templatePath: options.commandTemplatePath })
      })
    : {
        action: "skipped",
        target: relativeHostPath(path.join(baseFor(host, options), "commands", COMMAND_FILE_NAME)),
        detail: "This host has no custom slash command mechanism; the skill and MCP entry apply."
      };
  const skill = await installBundledFile(host, paths.skillFile, "skill file", {
    dryRun,
    rollback: options.rollback === true,
    ...(options.skillTemplatePath === undefined ? {} : { templatePath: options.skillTemplatePath })
  });
  const installMcp = options.installMcp === true;
  const mcp = installMcp
    ? options.rollback === true
      ? await rollbackManagedFile(paths.configFile, "host MCP config", dryRun)
      : await installMcpConfigFor(host, paths.configFile, {
          dryRun,
          mcpCommand: resolveMcpServerCommand(),
          ...(paths.legacyConfigFile === undefined ? {} : { legacyConfigFile: paths.legacyConfigFile })
        })
    : undefined;
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

async function installBundledFile(host: HostSpec, target: string, kind: string, options: { dryRun: boolean; rollback: boolean; templatePath?: string }): Promise<HostFileAction> {
  if (options.rollback) return rollbackManagedFile(target, kind, options.dryRun);
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
  const templateHash = sha256(template);
  const templateVersion = detectTemplateVersion(template) ?? STINKY_COBBLER_VERSION;
  const managedState = managedStateEffect(target, templateVersion, templateHash);
  if (options.dryRun) {
    const metadata = existing === template ? await readManagedMetadata(target) : undefined;
    const action: HostFileAction = existing === undefined
      ? {
          action: "preview",
          target: targetRelative,
          detail: `Would create the managed ${kind} and its managed-state sidecar.`,
          after: { version: templateVersion, sha256: templateHash },
          writes: [targetEffect("create", target, undefined, templateHash), managedState]
        }
      : existing === template
        ? metadata?.installedSha256 === templateHash && metadata.productVersion === templateVersion
          ? { action: "ready", target: targetRelative, detail: `${label} already installed and up to date.` }
          : {
              action: "preview",
              target: targetRelative,
              detail: `${label} bytes are already up to date; would record the exact bytes as a managed install.`,
              before: { version: templateVersion, sha256: templateHash },
              after: { version: templateVersion, sha256: templateHash },
              writes: [managedState]
            }
        : await previewManagedUpgrade(host, target, kind, label, existing, templateVersion, templateHash);
    return action;
  }
  if (existing === template) {
    await adoptManagedFile(target, templateVersion, templateHash);
    return { action: "ready", target: targetRelative, writes: [managedState] };
  }
  if (existing !== undefined) {
    const currentHash = sha256(existing);
    const managedVersion = await trustedManagedVersion(host, target, kind, existing, currentHash);
    if (managedVersion === undefined) return unmanagedConflict(target, label, existing, currentHash);
    const previous = await backupManagedFile(target, currentHash, managedVersion);
    await atomicReplace(target, template, currentHash);
    await writeManagedMetadata(target, {
      version: 1,
      productVersion: templateVersion,
      installedSha256: templateHash,
      updatedAt: new Date().toISOString(),
      previous
    });
    return {
      action: "upgraded",
      target: targetRelative,
      detail: `${label} upgraded from managed ${managedVersion}; byte-for-byte rollback is available.`,
      before: { version: managedVersion, sha256: currentHash },
      after: { version: templateVersion, sha256: templateHash },
      writes: [
        backupEffect(target, currentHash),
        targetEffect("replace", target, currentHash, templateHash),
        managedState
      ]
    };
  }
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await atomicReplace(target, template, undefined);
  await writeManagedMetadata(target, {
    version: 1,
    productVersion: templateVersion,
    installedSha256: templateHash,
    updatedAt: new Date().toISOString()
  });
  return {
    action: "installed",
    target: targetRelative,
    writes: [targetEffect("create", target, undefined, templateHash), managedState]
  };
}

async function previewManagedUpgrade(
  host: HostSpec,
  target: string,
  kind: string,
  label: string,
  existing: string,
  templateVersion: string,
  templateHash: string
): Promise<HostFileAction> {
  const currentHash = sha256(existing);
  const managedVersion = await trustedManagedVersion(host, target, kind, existing, currentHash);
  if (managedVersion === undefined) return unmanagedConflict(target, label, existing, currentHash);
  return {
    action: "preview",
    target: relativeHostPath(target),
    detail: `Would upgrade the unchanged managed ${kind} from ${managedVersion}; the existing bytes would be backed up for rollback.`,
    before: { version: managedVersion, sha256: currentHash },
    after: { version: templateVersion, sha256: templateHash },
    writes: [
      backupEffect(target, currentHash),
      targetEffect("replace", target, currentHash, templateHash),
      managedStateEffect(target, templateVersion, templateHash)
    ]
  };
}

function unmanagedConflict(target: string, label: string, existing: string, currentHash: string): HostFileAction {
  const detectedVersion = detectTemplateVersion(existing);
  return {
    action: "conflict",
    target: relativeHostPath(target),
    detail: `${label} differs from the bundled template and is not an unchanged managed install; preserving user content.`,
    before: { ...(detectedVersion === undefined ? {} : { detectedVersion }), sha256: currentHash }
  };
}

async function trustedManagedVersion(host: HostSpec, target: string, kind: string, existing: string, currentHash: string): Promise<string | undefined> {
  const metadata = await readManagedMetadata(target);
  if (metadata?.installedSha256 === currentHash) return metadata.productVersion;
  const known = KNOWN_BUNDLED_VERSIONS.get(`${host.id}:${kind}`)?.get(currentHash);
  if (known !== undefined) return known;
  // A version-looking user file is not authority. Only an exact known hash or
  // a sidecar whose recorded bytes still match may be upgraded automatically.
  void existing;
  return undefined;
}

async function adoptManagedFile(target: string, productVersion: string, installedSha256: string): Promise<void> {
  const current = await readManagedMetadata(target);
  await writeManagedMetadata(target, {
    version: 1,
    productVersion,
    installedSha256,
    updatedAt: new Date().toISOString(),
    ...(current?.installedSha256 === installedSha256 && current.previous !== undefined ? { previous: current.previous } : {})
  });
}

async function installManagedMergedFile(target: string, next: string): Promise<void> {
  const existing = await readExisting(target);
  const previous = existing === undefined
    ? undefined
    : await backupManagedFile(target, sha256(existing), detectTemplateVersion(existing) ?? "unversioned-host-config");
  await atomicReplace(target, next, existing === undefined ? undefined : sha256(existing));
  await writeManagedMetadata(target, {
    version: 1,
    productVersion: STINKY_COBBLER_VERSION,
    installedSha256: sha256(next),
    updatedAt: new Date().toISOString(),
    ...(previous === undefined ? {} : { previous })
  });
}

async function backupManagedFile(target: string, digest: string, productVersion: string): Promise<NonNullable<ManagedInstallMetadata["previous"]>> {
  const backup = path.basename(backupPathFor(target, digest));
  const backupPath = path.join(path.dirname(target), backup);
  try {
    await copyFile(target, backupPath, COPYFILE_EXCL);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const info = await lstat(backupPath);
    if (!info.isFile() || info.isSymbolicLink() || sha256(await readFile(backupPath)) !== digest) {
      throw installError("ENTRY_BACKUP_CONFLICT", "The deterministic managed backup path already exists with different or unsafe content.", {
        target: relativeHostPath(target),
        backup: relativeHostPath(backupPath)
      });
    }
  }
  if (sha256(await readFile(backupPath)) !== digest) {
    await rm(backupPath, { force: true });
    throw installError("ENTRY_INSTALL_RACE", "The host target changed while its managed backup was being created.", { target: relativeHostPath(target) });
  }
  return { productVersion, sha256: digest, backup };
}

async function rollbackManagedFile(target: string, kind: string, dryRun: boolean): Promise<HostFileAction> {
  const targetRelative = relativeHostPath(target);
  const label = `${kind.charAt(0).toUpperCase()}${kind.slice(1)}`;
  const metadata = await readManagedMetadata(target);
  if (metadata?.previous === undefined) {
    return { action: "skipped", target: targetRelative, detail: `${label} has no verified managed backup to restore.` };
  }
  const existing = await readExisting(target);
  if (existing === undefined) {
    return { action: "conflict", target: targetRelative, detail: `${label} is missing; refusing to synthesize a rollback target.` };
  }
  const currentHash = sha256(existing);
  if (currentHash !== metadata.installedSha256) {
    return {
      action: "conflict",
      target: targetRelative,
      detail: `${label} changed after the managed install; preserving user content instead of rolling it back.`,
      before: { expectedSha256: metadata.installedSha256, observedSha256: currentHash }
    };
  }
  if (path.basename(metadata.previous.backup) !== metadata.previous.backup) {
    throw installError("ENTRY_ROLLBACK_INVALID", "Managed rollback metadata contains an unsafe backup path.", { target: targetRelative });
  }
  const backupPath = path.join(path.dirname(target), metadata.previous.backup);
  let backupInfo;
  try {
    backupInfo = await lstat(backupPath);
  } catch {
    throw installError("ENTRY_ROLLBACK_MISSING", "The managed rollback backup is missing.", { target: targetRelative, backup: metadata.previous.backup });
  }
  if (!backupInfo.isFile() || backupInfo.isSymbolicLink()) {
    throw installError("ENTRY_ROLLBACK_INVALID", "The managed rollback backup must be a regular file.", { target: targetRelative, backup: metadata.previous.backup });
  }
  const previousBytes = await readFile(backupPath);
  if (sha256(previousBytes) !== metadata.previous.sha256) {
    throw installError("ENTRY_ROLLBACK_DRIFT", "The managed rollback backup no longer matches its recorded hash.", { target: targetRelative, backup: metadata.previous.backup });
  }
  const preview: HostFileAction = {
    action: "preview",
    target: targetRelative,
    detail: `Would restore the byte-for-byte managed backup for ${kind}; the current managed bytes would become the next rollback point.`,
    before: { version: metadata.productVersion, sha256: currentHash },
    after: { version: metadata.previous.productVersion, sha256: metadata.previous.sha256 },
    writes: [
      backupEffect(target, currentHash),
      targetEffect("replace", target, currentHash, metadata.previous.sha256),
      managedStateEffect(target, metadata.previous.productVersion, metadata.previous.sha256)
    ]
  };
  if (dryRun) return preview;

  const nextPrevious = await backupManagedFile(target, currentHash, metadata.productVersion);
  await atomicReplace(target, previousBytes, currentHash);
  await writeManagedMetadata(target, {
    version: 1,
    productVersion: metadata.previous.productVersion,
    installedSha256: metadata.previous.sha256,
    updatedAt: new Date().toISOString(),
    previous: nextPrevious
  });
  return { ...preview, action: "rolled-back", detail: `${label} restored from its verified managed backup.` };
}

async function readManagedMetadata(target: string): Promise<ManagedInstallMetadata | undefined> {
  const file = managedMetadataPath(target);
  let info;
  try {
    info = await lstat(file);
  } catch {
    return undefined;
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw installError("ENTRY_MANAGED_STATE_INVALID", "Managed install metadata must be a regular file.", { target: relativeHostPath(target) });
  }
  let value: unknown;
  try {
    value = JSON.parse(await readFile(file, "utf8")) as unknown;
  } catch {
    throw installError("ENTRY_MANAGED_STATE_INVALID", "Managed install metadata is not valid JSON.", { target: relativeHostPath(target) });
  }
  if (!isManagedMetadata(value)) {
    throw installError("ENTRY_MANAGED_STATE_INVALID", "Managed install metadata does not match the supported schema.", { target: relativeHostPath(target) });
  }
  return value;
}

function isManagedMetadata(value: unknown): value is ManagedInstallMetadata {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || typeof record.productVersion !== "string" || typeof record.updatedAt !== "string"
    || typeof record.installedSha256 !== "string" || !SHA256_PATTERN.test(record.installedSha256)) return false;
  if (record.previous === undefined) return true;
  if (typeof record.previous !== "object" || record.previous === null || Array.isArray(record.previous)) return false;
  const previous = record.previous as Record<string, unknown>;
  return typeof previous.productVersion === "string"
    && typeof previous.sha256 === "string" && SHA256_PATTERN.test(previous.sha256)
    && typeof previous.backup === "string" && previous.backup.length > 0
    && path.basename(previous.backup) === previous.backup;
}

async function writeManagedMetadata(target: string, metadata: ManagedInstallMetadata): Promise<void> {
  await atomicWrite(managedMetadataPath(target), `${JSON.stringify(metadata, null, 2)}\n`);
}

function managedMetadataPath(target: string): string {
  return `${target}.stinky-cobbler-managed.json`;
}

function backupPathFor(target: string, digest: string): string {
  return path.join(path.dirname(target), `${path.basename(target)}.stinky-cobbler-backup-${digest}.bak`);
}

function targetEffect(operation: "create" | "replace", target: string, beforeSha256: string | undefined, afterSha256: string): HostWriteEffect {
  return {
    operation,
    target: relativeHostPath(target),
    ...(beforeSha256 === undefined ? {} : { beforeSha256 }),
    afterSha256
  };
}

function backupEffect(target: string, digest: string): HostWriteEffect {
  return {
    operation: "ensure-backup",
    target: relativeHostPath(backupPathFor(target, digest)),
    afterSha256: digest
  };
}

function managedStateEffect(target: string, productVersion: string, installedSha256: string): HostWriteEffect {
  return {
    operation: "write-managed-state",
    target: relativeHostPath(managedMetadataPath(target)),
    afterSha256: installedSha256,
    productVersion
  };
}

async function atomicWrite(target: string, contents: string | Buffer): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.tmp-${randomUUID()}`);
  try {
    await writeFile(temporary, contents, { mode: 0o600, flag: "wx" });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function atomicReplace(target: string, contents: string | Buffer, expectedSha256: string | undefined): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.tmp-${randomUUID()}`);
  try {
    await writeFile(temporary, contents, { mode: 0o600, flag: "wx" });
    const observed = await readExisting(target);
    if (expectedSha256 === undefined ? observed !== undefined : observed === undefined || sha256(observed) !== expectedSha256) {
      throw installError("ENTRY_INSTALL_RACE", "The host target changed after preview/backup; refusing to replace it.", { target: relativeHostPath(target) });
    }
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function detectTemplateVersion(contents: string): string | undefined {
  return contents.match(/Stinky Cobbler\s+(\d+\.\d+\.\d+)/i)?.[1];
}

function sha256(contents: string | Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
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
    if (isExactMcpServer(current, options.mcpCommand)) {
      return { action: "ready", target: targetRelative, detail: "MCP server is already registered." };
    }
    throw installError("ENTRY_HOST_CONFIG_CONFLICT", `An existing ${MCP_SERVER_ID} server uses a different command; refusing to overwrite it.`, { configFile: targetRelative });
  }

  const template = mcpServerConfigTemplate(options.mcpCommand);
  const next = { ...config, mcp: { ...(((config.mcp as Record<string, unknown> | undefined) ?? {})), servers: { ...servers, ...template.mcp.servers } } };
  const currentBytes = await readExisting(configFile);
  const nextBytes = `${JSON.stringify(next, null, 2)}\n`;
  const currentHash = currentBytes === undefined ? undefined : sha256(currentBytes);
  const nextHash = sha256(nextBytes);
  const writes: HostWriteEffect[] = [
    ...(currentHash === undefined ? [] : [backupEffect(configFile, currentHash)]),
    targetEffect(currentHash === undefined ? "create" : "replace", configFile, currentHash, nextHash),
    managedStateEffect(configFile, STINKY_COBBLER_VERSION, nextHash)
  ];
  const legacyHint = options.legacyConfigFile !== undefined && await hostConfigHasMcpServer(options.legacyConfigFile)
    ? ` Legacy registration found at ${relativeHostPath(options.legacyConfigFile)}; it is not read by ZCode and can be deleted.`
    : "";
  if (options.dryRun) {
    // Preview only the MCP-relevant subset — the host config may contain credentials.
    const before = { mcp: config.mcp };
    const after = { mcp: next.mcp };
    return { action: "preview", target: targetRelative, detail: `Would register the MCP server in host ${HOST_CONFIG_FILE}.${legacyHint}`, before, after, writes };
  }
  await installManagedMergedFile(configFile, nextBytes);
  return { action: "installed", target: targetRelative, detail: `MCP server registered in host ${HOST_CONFIG_FILE}.${legacyHint}`, writes };
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
    if (isExactMcpServer(current, options.mcpCommand)) {
      return { action: "ready", target: targetRelative, detail: "MCP server is already registered." };
    }
    throw installError("ENTRY_HOST_CONFIG_CONFLICT", `An existing ${MCP_SERVER_ID} server uses a different command; refusing to overwrite it.`, { configFile: targetRelative });
  }

  const template = mcpServerConfigTemplateToml(options.mcpCommand);
  const next = { ...config, mcp_servers: { ...servers, ...template.mcp_servers } };
  const currentBytes = await readExisting(configFile);
  const nextBytes = `${stringifyToml(next)}\n`;
  const currentHash = currentBytes === undefined ? undefined : sha256(currentBytes);
  const nextHash = sha256(nextBytes);
  const writes: HostWriteEffect[] = [
    ...(currentHash === undefined ? [] : [backupEffect(configFile, currentHash)]),
    targetEffect(currentHash === undefined ? "create" : "replace", configFile, currentHash, nextHash),
    managedStateEffect(configFile, STINKY_COBBLER_VERSION, nextHash)
  ];
  if (options.dryRun) {
    // Preview only the MCP-relevant subset — the host config may contain credentials.
    const before = { mcp_servers: config.mcp_servers };
    const after = { mcp_servers: next.mcp_servers };
    return { action: "preview", target: targetRelative, detail: "Would register the MCP server in host config.toml.", before, after, writes };
  }
  await installManagedMergedFile(configFile, nextBytes);
  return { action: "installed", target: targetRelative, detail: "MCP server registered in host config.toml.", writes };
}

async function readJsonConfig(file: string): Promise<unknown | "invalid" | undefined> {
  let info;
  try {
    info = await lstat(file);
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
    info = await lstat(file);
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

async function readExisting(file: string): Promise<string | undefined> {
  let info;
  try {
    info = await lstat(file);
  } catch {
    return undefined;
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw installError("ENTRY_TARGET_INVALID", "The host target must be a regular file, not a directory or link.", { target: relativeHostPath(file) });
  }
  return readFile(file, "utf8");
}

function isExactMcpServer(value: unknown, expectedCommand: string): boolean {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return record.command === expectedCommand && Array.isArray(record.args) && record.args.length === 0;
}

function defaultTemplatePath(host: HostSpec, kind: string): string {
  const relative = kind === "skill file"
    ? host.skillTemplateRelative
    : (host.commandTemplateRelative ?? path.join(host.userDir, "commands", COMMAND_FILE_NAME));
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..", relative);
}

function relativeHostPath(file: string): string {
  const home = homedir();
  const displayed = file.startsWith(`${home}${path.sep}`) ? path.join("~", path.relative(home, file)) : file;
  return displayed.split(path.sep).join("/");
}

function installError(code: string, message: string, details: Record<string, unknown> = {}): StinkyCobblerError {
  return new StinkyCobblerError(code, ExitCode.POLICY_DENIED, message, details);
}
