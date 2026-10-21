import { constants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";
import { parse as parseYaml } from "yaml";
import { plan, type FileOp, type KindSupport, type PlanSources, type ToolkitPlan } from "../core/plan/plan.js";
import { ARTIFACT_KINDS, type ArtifactKind } from "../core/toolkit/kinds.js";
import { buildToolkitLock, isRemoteToolkitSource, parseToolkitLock, type LockBodies, type ToolkitLock } from "../core/toolkit/lock.js";
import { parseToolkitSpec, type ToolkitSpec } from "../core/toolkit/spec.js";
import { ExitCode, StinkyCobblerError } from "../errors.js";
import type { DocumentedEnvExpansion, HostScope } from "../hosts/host-adapter.js";
import { hostAdapters } from "../hosts/registry.js";
import { readToolkitEvents } from "../io/ledger.js";
import { resolveConfigHome } from "../io/tiered-config.js";
import { apply, type ApplyReport } from "./apply.js";
import { fetchGitSkills } from "./git-source.js";
import { blobDirectory, sourcesFromLock, writeLockedBlobs } from "./toolkit-blobs.js";
import { observe, type HostObservation } from "./observe.js";
import { rollbackLast, type RollbackReport } from "./rollback.js";

export interface SecretHint {
  code: "SECRET_NEEDS_SHELL_ENV" | "SECRET_EXPANSION_UNKNOWN";
  host: string;
  name: string;
  hint: string;
}

export interface ToolkitDoctorReport {
  drift: ToolkitPlan["conflicts"];
  env: Array<{ name: string; present: boolean }>;
  commands: Array<{ command: string; present: boolean }>;
  secrets: SecretHint[];
}

interface LoadedToolkit {
  spec: ToolkitSpec;
  scope: HostScope;
  specPath: string;
}

export async function initToolkit(scopeFlag?: string): Promise<{ path: string; scope: HostScope; detectedHosts: string[] }> {
  const scope = parseScope(scopeFlag) ?? "user";
  const file = specFile(scope);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeScaffold(file, scope);
  return { path: file, scope, detectedHosts: await detectedHosts() };
}

export async function planToolkit(scopeFlag?: string): Promise<ToolkitPlan & { diffs: string[] }> {
  const toolkitPlan = await buildPlan(scopeFlag);
  return { ...toolkitPlan, diffs: diffsFor(toolkitPlan) };
}

export async function applyToolkit(options: { scope?: string | undefined; yes?: boolean | undefined }): Promise<ApplyReport> {
  const loaded = await loadToolkit(options.scope);
  const toolkitPlan = await planLoaded(loaded, await applySources(loaded));
  refuseUnsafeApply(toolkitPlan, options.yes === true);
  return apply(toolkitPlan);
}

export async function doctorToolkit(scopeFlag?: string): Promise<ToolkitDoctorReport> {
  const loaded = await loadToolkit(scopeFlag);
  return {
    drift: (await planLoaded(loaded)).conflicts,
    env: envPresence(loaded.spec),
    commands: await commandPresence(loaded.spec),
    secrets: secretHints(loaded.spec)
  };
}

export async function listToolkit(scopeFlag?: string): Promise<HostObservation[]> {
  return observe(observationInput(await loadToolkit(scopeFlag)));
}

export async function lockToolkit(scopeFlag?: string): Promise<ToolkitLock> {
  const loaded = await loadToolkit(scopeFlag);
  const bodies = await lockBodies(loaded.spec);
  const fetchedSkills = await fetchGitSkills(loaded.spec, path.join(path.dirname(loaded.specPath), "sources"));
  const lockBodiesWithFetch = { ...bodies, fetchedSkills };
  const lock = buildToolkitLock(loaded.spec, lockBodiesWithFetch);
  await writeLockedBlobs(blobDirectory(loaded.specPath), lock, lockBodiesWithFetch);
  await writeFile(path.join(path.dirname(loaded.specPath), "toolkit.lock"), `${JSON.stringify(lock, null, 2)}\n`, { mode: 0o600 });
  return lock;
}

export async function rollbackToolkit(options: { last?: boolean | undefined; to?: string | undefined }): Promise<RollbackReport> {
  if (options.last !== true && options.to === undefined) throw toolkitError("TOOLKIT_ROLLBACK_TARGET", "Pass --last or --to <applyId>.");
  if (options.to !== undefined) await assertLastApply(options.to);
  return rollbackLast();
}

async function buildPlan(scopeFlag?: string): Promise<ToolkitPlan> {
  return planLoaded(await loadToolkit(scopeFlag));
}

async function planLoaded(loaded: LoadedToolkit, sources?: PlanSources): Promise<ToolkitPlan> {
  const observations = await observe(observationInput(loaded));
  return plan(loaded.spec, observations, { support: kindSupport(), sources: sources ?? (await planSources(loaded)) });
}

async function planSources(loaded: LoadedToolkit): Promise<PlanSources> {
  const live = await sourceBodies(loaded.spec);
  const file = path.join(path.dirname(loaded.specPath), "toolkit.lock");
  let lock: ToolkitLock;
  try {
    lock = parseToolkitLock(JSON.parse(await readFile(file, "utf8")) as unknown);
  } catch (error: unknown) {
    if (isCode(error, "ENOENT")) return live;
    throw error;
  }
  const locked = await sourcesFromLock(blobDirectory(loaded.specPath), loaded.spec, lock);
  const skills = live.skills ?? {};
  for (const skill of loaded.spec.skills) {
    const body = skill.source.startsWith("git+") ? locked.skills?.[skill.id] : undefined;
    if (body !== undefined) skills[skill.id] = body;
  }
  return { ...live, skills };
}

async function applySources(loaded: LoadedToolkit): Promise<PlanSources> {
  if (loaded.spec.skills.length === 0 && loaded.spec.instructions.length === 0) return {};
  return sourcesFromLock(blobDirectory(loaded.specPath), loaded.spec, await readToolkitLock(loaded.specPath));
}

async function readToolkitLock(specPath: string): Promise<ToolkitLock> {
  try {
    return parseToolkitLock(JSON.parse(await readFile(path.join(path.dirname(specPath), "toolkit.lock"), "utf8")) as unknown);
  } catch (error: unknown) {
    if (isCode(error, "ENOENT")) throw toolkitError("TOOLKIT_LOCK_REQUIRED", "Run toolkit lock before apply.");
    throw error;
  }
}

function observationInput(loaded: LoadedToolkit): Parameters<typeof observe>[0] {
  return { adapters: hostAdapters, spec: loaded.spec, scope: loaded.scope, roots: { home: homedir(), cwd: process.cwd() } };
}

async function loadToolkit(scopeFlag?: string): Promise<LoadedToolkit> {
  const requested = parseScope(scopeFlag) ?? "user";
  const specPath = specFile(requested);
  const spec = parseToolkitSpec(parseDocument(await readSpec(specPath)));
  return { spec, scope: spec.scope ?? requested, specPath };
}

function specFile(scope: HostScope): string {
  if (scope === "project") return path.join(process.cwd(), ".stinky-cobbler", "toolkit.yaml");
  return path.join(resolveConfigHome(process.env, homedir()), "stinky-cobbler", "toolkit.yaml");
}

function parseScope(flag: string | undefined): HostScope | undefined {
  if (flag === undefined) return undefined;
  if (flag === "user" || flag === "project") return flag;
  throw toolkitError("TOOLKIT_SCOPE_INVALID", "Scope must be user or project.");
}

function scaffoldText(scope: HostScope): string {
  return `# Stinky Cobbler toolkit. Secrets must be \${env:NAME} or \${file:PATH}.
version: 1
scope: ${scope}
skills: []
mcpServers: []
instructions: []
bundles: []
`;
}

async function writeScaffold(file: string, scope: HostScope): Promise<void> {
  try {
    await writeFile(file, scaffoldText(scope), { flag: "wx", mode: 0o600 });
  } catch (error: unknown) {
    if (!isCode(error, "EEXIST")) throw error;
    throw new StinkyCobblerError("TOOLKIT_EXISTS", ExitCode.CONFLICT, "Toolkit spec already exists.", { path: file });
  }
}

async function detectedHosts(): Promise<string[]> {
  const home = homedir();
  const found: string[] = [];
  for (const adapter of hostAdapters) {
    if (await adapter.detect(home)) found.push(adapter.id);
  }
  return found;
}

async function readSpec(file: string): Promise<string> {
  try {
    return await readFile(file, "utf8");
  } catch (error: unknown) {
    if (isCode(error, "ENOENT")) throw toolkitError("TOOLKIT_SPEC_MISSING", "Toolkit spec does not exist. Run toolkit init.");
    throw error;
  }
}

function parseDocument(text: string): unknown {
  try {
    return parseYaml(text);
  } catch (error: unknown) {
    throw toolkitError("TOOLKIT_SPEC_INVALID", error instanceof Error ? error.message : "Toolkit YAML is invalid.");
  }
}

function kindSupport(): KindSupport[] {
  const rows: KindSupport[] = [];
  for (const adapter of hostAdapters) {
    for (const kind of ARTIFACT_KINDS) rows.push(supportRow(adapter.id, kind, adapter.supports(kind)));
  }
  return rows;
}

function supportRow(host: string, kind: ArtifactKind, supported: boolean): KindSupport {
  if (supported) return { host, kind, supported };
  return { host, kind, supported, reason: `${host} does not support ${kind}.` };
}

async function lockBodies(spec: ToolkitSpec): Promise<LockBodies> {
  const skills: Record<string, string | undefined> = {};
  const instructions: Record<string, string | undefined> = {};
  for (const skill of spec.skills) skills[skill.id] = await localBody(skill.source, true);
  for (const item of spec.instructions) instructions[item.id] = await localBody(item.source, false);
  return { skills, instructions };
}

async function localBody(source: string, skill: boolean): Promise<string | undefined> {
  if (isRemoteToolkitSource(source)) return undefined;
  return readIfFile(skill ? localSkillFile(source) : localTextFile(source));
}

async function sourceBodies(spec: ToolkitSpec): Promise<PlanSources> {
  const skills: Record<string, string> = {};
  const instructions: Record<string, string> = {};
  for (const skill of spec.skills) {
    const body = await readIfFile(localSkillFile(skill.source));
    if (body !== undefined) skills[skill.id] = body;
  }
  for (const item of spec.instructions) {
    const body = await readIfFile(localTextFile(item.source));
    if (body !== undefined) instructions[item.id] = body;
  }
  return { skills, instructions };
}

function localSkillFile(source: string): string | undefined {
  if (source.startsWith("git+") || source.startsWith("npm:")) return undefined;
  return path.resolve(source.endsWith("/SKILL.md") ? source : path.join(source, "SKILL.md"));
}

function localTextFile(source: string): string | undefined {
  if (source.startsWith("git+") || source.startsWith("npm:")) return undefined;
  return path.resolve(source);
}

async function readIfFile(file: string | undefined): Promise<string | undefined> {
  if (file === undefined) return undefined;
  try {
    return await readFile(file, "utf8");
  } catch (error: unknown) {
    if (isCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

function refuseUnsafeApply(toolkitPlan: ToolkitPlan, yes: boolean): void {
  if (toolkitPlan.conflicts.length > 0) {
    throw new StinkyCobblerError("TOOLKIT_CONFLICT", ExitCode.CONFLICT, "Toolkit plan has conflicts. Nothing was written.", {
      conflicts: toolkitPlan.conflicts
    });
  }
  if (toolkitPlan.ops.length > 0 && !yes) throw toolkitError("TOOLKIT_CONFIRM_REQUIRED", "Pass --yes to apply a non-empty toolkit plan.");
}

function secretHints(spec: ToolkitSpec): SecretHint[] {
  const names = envPresence(spec).map((item) => item.name);
  if (names.length === 0) return [];
  const hosts = spec.hosts ?? hostAdapters.map((adapter) => adapter.id);
  const hints: SecretHint[] = [];
  for (const host of hosts) {
    const syntax = hostAdapters.find((adapter) => adapter.id === host)?.documentedEnvExpansion;
    for (const name of names) {
      const hint = syntax === undefined ? undefined : secretHint(host, syntax, name);
      if (hint !== undefined) hints.push(hint);
    }
  }
  return hints;
}

function secretHint(host: string, syntax: DocumentedEnvExpansion, name: string): SecretHint | undefined {
  if (syntax === "dollar-env") return undefined;
  if (syntax === "unknown")
    return { code: "SECRET_EXPANSION_UNKNOWN", host, name, hint: `${host} MCP env expansion is not documented. Do not assume \${env:NAME} is expanded.` };
  return { code: "SECRET_NEEDS_SHELL_ENV", host, name, hint: wrapperHint(host, syntax, name) };
}

function wrapperHint(host: string, syntax: "dollar-var" | "name-forwarding", name: string): string {
  const reason = syntax === "dollar-var" ? `${host} expands \${VAR}, not \${env:NAME}.` : `${host} stores literal env values and forwards variables by name.`;
  return `${reason} Use a wrapper script that exports ${name} before the server starts.`;
}

function envPresence(spec: ToolkitSpec): ToolkitDoctorReport["env"] {
  const reports: ToolkitDoctorReport["env"] = [];
  for (const server of spec.mcpServers) {
    for (const value of Object.values(server.env ?? {})) {
      const name = /^\$\{env:([A-Z][A-Z0-9_]*)\}$/.exec(value)?.[1];
      if (name !== undefined) reports.push({ name, present: process.env[name] !== undefined });
    }
  }
  return reports;
}

async function commandPresence(spec: ToolkitSpec): Promise<ToolkitDoctorReport["commands"]> {
  const reports: ToolkitDoctorReport["commands"] = [];
  for (const server of spec.mcpServers) reports.push({ command: server.command, present: await commandPresent(server.command) });
  return reports;
}

async function commandPresent(command: string): Promise<boolean> {
  if (command.includes("/") || command.includes("\\")) return executable(command);
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (dir !== "" && (await executable(path.join(dir, command)))) return true;
  }
  return false;
}

async function executable(file: string): Promise<boolean> {
  try {
    await access(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function diffsFor(toolkitPlan: ToolkitPlan): string[] {
  return toolkitPlan.ops.map((op) => formatDiff(op));
}

function formatDiff(op: FileOp): string {
  const next = op.bytes ?? op.segment ?? JSON.stringify(op.mcpEntry ?? {});
  return `--- ${op.path}\n+++ ${op.path}\n${next
    .split("\n")
    .map((line) => `+${line}`)
    .join("\n")}`;
}

async function assertLastApply(applyId: string): Promise<void> {
  const last = (await readToolkitEvents()).at(-1);
  if (last === undefined) throw toolkitError("TOOLKIT_LEDGER_EMPTY", "No toolkit apply is recorded.");
  if (last.applyId !== applyId) throw toolkitError("TOOLKIT_ROLLBACK_NOT_LAST", "Only the latest toolkit apply can be rolled back.");
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function toolkitError(code: string, message: string): StinkyCobblerError {
  return new StinkyCobblerError(code, ExitCode.VALIDATION, message);
}
