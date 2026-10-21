/** Three-layer YAML config: builtin, XDG user, then workspace project overlay. */

import { lstat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultSchemaRegistry } from "../contracts/default-schema-registry.js";
import type { ContractKind } from "../contracts/schema-registry.js";
import { ExitCode, StinkyCobblerError } from "../errors.js";
import { workspaceFile, type LocalWorkspace } from "../gate/storage/workspace.js";
import { loadTieredDocument, readTieredYamlFile, userPolicyFile, type MergeStrategy, type TieredLayer } from "../io/tiered-config.js";
import { assertWorkspacePathPolicy, isReservedWorkspacePath, normalizeWorkspaceRelativePath } from "../security/workspace-path.js";

/** Package-internal policies directory (ships with the tool; npm updates replace it — never edit directly). */
export const PACKAGE_POLICIES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..", "policies");

export interface TieredLoadResult<T> {
  /** Merged builtin, then XDG user, then workspace project. */
  effective: T;
  builtin: T;
  /** Workspace project overlay. The 2.0.1 field name remains `user`. */
  user: T | null;
  userPath: string | null;
  /** `$XDG_CONFIG_HOME/stinky-cobbler/policies`, or `~/.config/...` when unset. */
  home: T | null;
  homePath: string | null;
  layers: readonly TieredLayer<T>[];
  diagnostics: readonly string[];
}

export type TieredPolicyFileName = "orchestration.yaml" | "specialists.yaml" | "contract-templates.yaml";

const POLICY_SCHEMA_KIND_BY_FILE: Record<TieredPolicyFileName, ContractKind> = {
  "orchestration.yaml": "orchestration-policy",
  "specialists.yaml": "specialists-policy",
  "contract-templates.yaml": "contract-templates-policy"
};

export const ORCHESTRATION_MERGE_STRATEGY: MergeStrategy = {
  fields: { defaults: "record", sensitiveExtraPaths: "appendOnly" }
};
export const SPECIALISTS_MERGE_STRATEGY: MergeStrategy = { fields: { specialists: { keyedList: "domain" } } };
export const CONTRACT_TEMPLATES_MERGE_STRATEGY: MergeStrategy = { fields: { templates: { keyedList: "name" } } };

const MERGE_STRATEGY_BY_FILE: Record<TieredPolicyFileName, MergeStrategy> = {
  "orchestration.yaml": ORCHESTRATION_MERGE_STRATEGY,
  "specialists.yaml": SPECIALISTS_MERGE_STRATEGY,
  "contract-templates.yaml": CONTRACT_TEMPLATES_MERGE_STRATEGY
};

/**
 * Loads builtin, XDG user, and workspace project YAML.
 * Each file declares its own merge strategy. Malformed YAML or a wrong version fails closed.
 */
export async function loadTieredYaml<T extends { version: number }>(
  workspace: LocalWorkspace | null,
  fileName: TieredPolicyFileName,
  expectedVersion: 1
): Promise<TieredLoadResult<T>> {
  const policyKind = (POLICY_SCHEMA_KIND_BY_FILE as Partial<Record<string, ContractKind>>)[fileName];
  if (policyKind === undefined) {
    throw tieredError(
      "TIERED_CONFIG_INVALID",
      `不支持的 tiered policy kind：${String(fileName)}。`,
      "修复：只允许 orchestration.yaml、specialists.yaml 或 contract-templates.yaml。"
    );
  }
  const builtinLabel = `policies/${fileName} (builtin)`;
  const builtin = await readTieredYamlFile<T>(path.join(PACKAGE_POLICIES_DIR, fileName), builtinLabel);
  if (builtin === null) {
    throw tieredError(
      "TIERED_CONFIG_MISSING",
      `policies/${fileName} (builtin) 不存在；工具安装不完整。`,
      "修复：重新安装 stinky-cobbler（npm install -g stinky-cobbler）。"
    );
  }
  if (builtin.version !== expectedVersion)
    throw tieredError(
      "TIERED_CONFIG_VERSION",
      `内置 policies/${fileName} 版本异常（应为 ${expectedVersion}）。`,
      `修复：重新安装 stinky-cobbler（npm install -g stinky-cobbler）。`
    );
  await validatePolicyLayer(fileName, policyKind, builtin, builtinLabel);
  const home = await readHomeLayer<T>(fileName, expectedVersion);
  if (home.value !== null) await validatePolicyLayer(fileName, policyKind, home.value, home.path ?? fileName);
  const project = await readProjectLayer<T>(workspace, fileName, expectedVersion);
  if (project.value !== null) await validatePolicyLayer(fileName, policyKind, project.value, project.path ?? fileName);
  const document = loadTieredDocument<T>(
    [
      { name: "builtin", value: builtin, path: builtinLabel },
      { name: "user", value: home.value, path: home.path },
      { name: "project", value: project.value, path: project.path }
    ],
    MERGE_STRATEGY_BY_FILE[fileName]
  );
  return {
    effective: document.effective,
    builtin,
    user: project.value,
    userPath: project.path,
    home: home.value,
    homePath: home.path,
    layers: document.layers,
    diagnostics: document.diagnostics
  };
}

async function validatePolicyLayer(fileName: TieredPolicyFileName, policyKind: ContractKind, value: unknown, label: string): Promise<void> {
  try {
    (await defaultSchemaRegistry()).validate(policyKind, value);
  } catch (error: unknown) {
    if (!(error instanceof StinkyCobblerError) || error.code !== "SCHEMA_INVALID") throw error;
    const schemaErrors = Array.isArray(error.details?.errors) ? (error.details.errors as Array<{ path?: unknown; message?: unknown }>) : [];
    const errors =
      schemaErrors.length > 0
        ? schemaErrors.map((entry) => `${String(entry.path ?? "/")} ${String(entry.message ?? "invalid")}`).join("; ")
        : "unknown schema violation";
    const fix =
      fileName === "orchestration.yaml" && schemaErrors.some((entry) => entry.path === "/defaults/oscillationThreshold")
        ? "修复：改为 1 或 2。正确示例：\ndefaults:\n  oscillationThreshold: 2"
        : `修复：按 ${fileName} 模板填写受支持的字段与类型，删除未知键。`;
    throw tieredError("TIERED_CONFIG_INVALID", `${label} 不符合 ${fileName} JSON Schema：${errors}`, fix);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readHomeLayer<T extends { version: number }>(
  fileName: TieredPolicyFileName,
  expectedVersion: 1
): Promise<{ value: T | null; path: string | null }> {
  const file = userPolicyFile(fileName);
  const value = await readTieredYamlFile<T>(file, file);
  if (value === null) return { value: null, path: null };
  if (value.version !== expectedVersion) throw overlayVersionError(file, value.version, expectedVersion);
  return { value, path: file };
}

async function readProjectLayer<T extends { version: number }>(
  workspace: LocalWorkspace | null,
  fileName: TieredPolicyFileName,
  expectedVersion: 1
): Promise<{ value: T | null; path: string | null }> {
  if (workspace === null) return { value: null, path: null };
  try {
    // A workspace overlay is optional. If the control-plane root has not
    // been initialized, use the lower layers without creating anything.
    // workspaceFile still rejects every symlinked component.
    await lstat(workspace.directory);
    const file = await workspaceFile(workspace, `policies/${fileName}`);
    const value = await readTieredYamlFile<T>(file, file);
    if (value === null) return { value: null, path: null };
    if (value.version !== expectedVersion) throw overlayVersionError(file, value.version, expectedVersion);
    return { value, path: file };
  } catch (error: unknown) {
    if (isCode(error, "ENOENT")) return { value: null, path: null };
    throw error;
  }
}

function overlayVersionError(file: string, actual: number, expected: number): StinkyCobblerError {
  return tieredError(
    "TIERED_CONFIG_VERSION",
    `${file} 的 version 必须为 ${expected}（当前 ${actual}）。`,
    `修复：打开 ${file}，把第一行改为 version: ${expected}。正确示例：\nversion: ${expected}\ndefaults:\n  maxRounds: 10`
  );
}

function tieredError(code: string, message: string, fix?: string): StinkyCobblerError {
  return new StinkyCobblerError(code, ExitCode.VALIDATION, message, fix === undefined ? {} : { fix });
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

/* ------------------------------------------------------------------ */
/* orchestration.yaml — tiered runtime defaults for the 2.0 loop       */
/* ------------------------------------------------------------------ */

export interface OrchestrationConfig {
  version: 1;
  defaults?: {
    maxRounds?: number;
    maxRetriesPerSubtask?: number;
    maxSubtaskTokens?: number;
    costTokensPerSubtaskRound?: number;
    orchestrateTokenThreshold?: number;
    maxContractCriteria?: number;
    maxSubtaskCriteria?: number;
    maxDefects?: number;
    maxInputArtifacts?: number;
    maxContractScopeItems?: number;
    maxSubtaskScopeItems?: number;
    maxDomainLength?: number;
    maxDomainInstructions?: number;
    maxWriteContentBytes?: number;
    maxSteps?: number;
    leaseDefaultToolCalls?: number;
    leaseMaxToolCallsCap?: number;
    leaseDefaultMinutes?: number;
    leaseMaxMinutes?: number;
    leaseGraceMinutes?: number;
    /** Convergence guard: identical-defect count that escalates. Tighten-only: values > 2 are rejected. */
    oscillationThreshold?: number;
    /** Engine auto-reject: ACCEPTED reviews scoring below this are forced REJECTED. 0 disables. */
    autoRejectScoreThreshold?: number;
    /** Round consistency check failure auto-escalates the run (default: human judgment). */
    autoEscalateOnConsistencyFail?: boolean;
  };
  /** Append-only sensitive paths: workspace-specific forbidden targets (never removable, never inbuilt). */
  sensitiveExtraPaths?: string[];
}

const OSCILLATION_TIGHTEN_MAX = 2;
const HARD_MAX_ROUNDS = 100;
const HARD_MAX_RETRIES = 10;
const HARD_MAX_CONTRACT_CRITERIA = 20;
const HARD_MAX_SUBTASK_CRITERIA = 10;
const HARD_MAX_WRITE_CONTENT_BYTES = 16 * 1024 * 1024;

/** Loads orchestration.yaml and validates it fail-closed (tighten-only guards, numeric bounds). */
export async function loadOrchestrationConfig(workspace: LocalWorkspace | null): Promise<OrchestrationConfig> {
  const loaded = await loadTieredYaml<OrchestrationConfig>(workspace, "orchestration.yaml", 1);
  assertOrchestrationConfigKeys(loaded.builtin, "policies/orchestration.yaml (内置)");
  for (const overlay of overlayEntries(loaded)) assertOrchestrationConfigKeys(overlay.value, overlay.path);
  const { effective } = loaded;
  const source = effectiveSource(loaded, "policies/orchestration.yaml (内置)");
  if (effective.defaults !== undefined && !isPlainObject(effective.defaults)) {
    throw invalidOrchestrationConfig(source, "defaults 必须是 YAML 对象。");
  }
  const d = effective.defaults ?? {};
  validatePositiveIntegerDefaults(d, source);
  if (d.autoEscalateOnConsistencyFail !== undefined && typeof d.autoEscalateOnConsistencyFail !== "boolean") {
    throw invalidOrchestrationConfig(source, "defaults.autoEscalateOnConsistencyFail 必须是 true 或 false。");
  }
  if (d.oscillationThreshold !== undefined) {
    if (!Number.isInteger(d.oscillationThreshold) || d.oscillationThreshold < 1) {
      throw tieredError(
        "TIERED_CONFIG_INVALID",
        `${source} 中 defaults.oscillationThreshold 必须是正整数。`,
        `修复：改为 1 或 2。正确示例：\ndefaults:\n  oscillationThreshold: 2`
      );
    }
    if (d.oscillationThreshold > OSCILLATION_TIGHTEN_MAX) {
      throw tieredError(
        "TIERED_CONFIG_INVALID",
        `${source} 中 defaults.oscillationThreshold 只能收紧：最大 ${OSCILLATION_TIGHTEN_MAX}（放宽防打磨护栏不被允许）。`,
        `修复：改为 1 或 2。正确示例：\ndefaults:\n  oscillationThreshold: 2`
      );
    }
  }
  if (
    d.autoRejectScoreThreshold !== undefined &&
    (!Number.isSafeInteger(d.autoRejectScoreThreshold) || d.autoRejectScoreThreshold < 0 || d.autoRejectScoreThreshold > 100)
  ) {
    throw tieredError(
      "TIERED_CONFIG_INVALID",
      `${source} 中 defaults.autoRejectScoreThreshold 必须是 0-100（0 关闭）。`,
      `修复：改为 0-100 的整数，如 60。正确示例：\ndefaults:\n  autoRejectScoreThreshold: 60`
    );
  }
  if (d.maxRounds !== undefined && d.maxRounds > HARD_MAX_ROUNDS) {
    throw tieredError(
      "TIERED_CONFIG_INVALID",
      `${source} 中 defaults.maxRounds 必须是 1-${HARD_MAX_ROUNDS}。`,
      `修复：改为 1-${HARD_MAX_ROUNDS} 的整数，如 10。正确示例：\ndefaults:\n  maxRounds: 10`
    );
  }
  if (
    d.maxRetriesPerSubtask !== undefined &&
    (!Number.isSafeInteger(d.maxRetriesPerSubtask) || d.maxRetriesPerSubtask < 0 || d.maxRetriesPerSubtask > HARD_MAX_RETRIES)
  ) {
    throw tieredError(
      "TIERED_CONFIG_INVALID",
      `${source} 中 defaults.maxRetriesPerSubtask 必须是 0-${HARD_MAX_RETRIES}。`,
      `修复：改为 0-${HARD_MAX_RETRIES} 的整数。正确示例：\ndefaults:\n  maxRetriesPerSubtask: 3`
    );
  }
  if (
    d.maxContractCriteria !== undefined &&
    (!Number.isInteger(d.maxContractCriteria) || d.maxContractCriteria < 1 || d.maxContractCriteria > HARD_MAX_CONTRACT_CRITERIA)
  ) {
    throw tieredError(
      "TIERED_CONFIG_INVALID",
      `${source} 中 defaults.maxContractCriteria 必须是 1-${HARD_MAX_CONTRACT_CRITERIA}。`,
      `修复：该值不能超过契约 schema 上限 ${HARD_MAX_CONTRACT_CRITERIA}。`
    );
  }
  if (
    d.maxSubtaskCriteria !== undefined &&
    (!Number.isInteger(d.maxSubtaskCriteria) || d.maxSubtaskCriteria < 1 || d.maxSubtaskCriteria > HARD_MAX_SUBTASK_CRITERIA)
  ) {
    throw tieredError(
      "TIERED_CONFIG_INVALID",
      `${source} 中 defaults.maxSubtaskCriteria 必须是 1-${HARD_MAX_SUBTASK_CRITERIA}。`,
      `修复：该值不能超过子任务 schema 上限 ${HARD_MAX_SUBTASK_CRITERIA}。`
    );
  }
  if (d.maxSubtaskTokens !== undefined && (d.maxSubtaskTokens < 1000 || d.maxSubtaskTokens > 10_000_000)) {
    throw tieredError(
      "TIERED_CONFIG_INVALID",
      `${source} 中 defaults.maxSubtaskTokens 必须是 1000-10000000。`,
      `修复：改为 1000-10000000 的整数。正确示例：\ndefaults:\n  maxSubtaskTokens: 400000`
    );
  }
  if (d.leaseGraceMinutes !== undefined && d.leaseGraceMinutes !== 15) {
    throw tieredError(
      "TIERED_CONFIG_INVALID",
      `${source} 中 defaults.leaseGraceMinutes 当前必须固定为 15。`,
      `修复：改为 15；2.0.1 的 Lease 宽限期尚不支持工作区级覆盖。正确示例：\ndefaults:\n  leaseGraceMinutes: 15`
    );
  }
  assertUpperBound(d.maxDefects, 20, source, "maxDefects");
  assertUpperBound(d.maxInputArtifacts, 20, source, "maxInputArtifacts");
  assertUpperBound(d.maxContractScopeItems, 50, source, "maxContractScopeItems");
  assertUpperBound(d.maxSubtaskScopeItems, 50, source, "maxSubtaskScopeItems");
  assertUpperBound(d.maxDomainLength, 64, source, "maxDomainLength");
  assertUpperBound(d.maxDomainInstructions, 30, source, "maxDomainInstructions");
  assertUpperBound(d.maxWriteContentBytes, HARD_MAX_WRITE_CONTENT_BYTES, source, "maxWriteContentBytes");
  assertUpperBound(d.maxSteps, 10, source, "maxSteps");
  assertUpperBound(d.leaseMaxToolCallsCap, 100, source, "leaseMaxToolCallsCap");
  assertUpperBound(d.leaseMaxMinutes, 1440, source, "leaseMaxMinutes");
  const effectiveToolCallsCap = d.leaseMaxToolCallsCap ?? 100;
  if (d.leaseDefaultToolCalls !== undefined && d.leaseDefaultToolCalls > effectiveToolCallsCap) {
    throw invalidOrchestrationConfig(source, "defaults.leaseDefaultToolCalls 不能大于 leaseMaxToolCallsCap。");
  }
  const effectiveMinutesCap = d.leaseMaxMinutes ?? 1440;
  if (d.leaseDefaultMinutes !== undefined && d.leaseDefaultMinutes > effectiveMinutesCap) {
    throw invalidOrchestrationConfig(source, "defaults.leaseDefaultMinutes 不能大于 leaseMaxMinutes。");
  }

  const sensitiveExtraPaths = normalizeSensitiveExtraPaths(effective.sensitiveExtraPaths, source);
  return { ...effective, sensitiveExtraPaths };
}

const POSITIVE_INTEGER_DEFAULTS = [
  "maxRounds",
  "maxSubtaskTokens",
  "costTokensPerSubtaskRound",
  "orchestrateTokenThreshold",
  "maxContractCriteria",
  "maxSubtaskCriteria",
  "maxDefects",
  "maxInputArtifacts",
  "maxContractScopeItems",
  "maxSubtaskScopeItems",
  "maxDomainLength",
  "maxDomainInstructions",
  "maxWriteContentBytes",
  "maxSteps",
  "leaseDefaultToolCalls",
  "leaseMaxToolCallsCap",
  "leaseDefaultMinutes",
  "leaseMaxMinutes",
  "leaseGraceMinutes"
] as const;

const ORCHESTRATION_TOP_LEVEL_KEYS = new Set(["version", "defaults", "sensitiveExtraPaths"]);
const ORCHESTRATION_DEFAULT_KEYS = new Set<string>([
  ...POSITIVE_INTEGER_DEFAULTS,
  "maxRetriesPerSubtask",
  "oscillationThreshold",
  "autoRejectScoreThreshold",
  "autoEscalateOnConsistencyFail"
]);

function assertOrchestrationConfigKeys(config: OrchestrationConfig, source: string): void {
  const unknownTopLevel = Object.keys(config).filter((key) => !ORCHESTRATION_TOP_LEVEL_KEYS.has(key));
  if (unknownTopLevel.length > 0) {
    throw invalidOrchestrationConfig(source, `包含未知顶层配置项：${unknownTopLevel.join(", ")}。`);
  }
  if (config.defaults === undefined) return;
  if (!isPlainObject(config.defaults)) throw invalidOrchestrationConfig(source, "defaults 必须是 YAML 对象。");
  const unknownDefaults = Object.keys(config.defaults).filter((key) => !ORCHESTRATION_DEFAULT_KEYS.has(key));
  if (unknownDefaults.length > 0) {
    throw invalidOrchestrationConfig(source, `defaults 包含未知配置项：${unknownDefaults.join(", ")}。`);
  }
}

function validatePositiveIntegerDefaults(defaults: NonNullable<OrchestrationConfig["defaults"]>, source: string): void {
  for (const key of POSITIVE_INTEGER_DEFAULTS) {
    const value = defaults[key];
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
      throw invalidOrchestrationConfig(source, `defaults.${key} 必须是正安全整数。`);
    }
  }
}

function assertUpperBound(value: number | undefined, maximum: number, source: string, key: string): void {
  if (value !== undefined && value > maximum) {
    throw invalidOrchestrationConfig(source, `defaults.${key} 不能超过 ${maximum}。`);
  }
}

function normalizeSensitiveExtraPaths(value: unknown, source: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw invalidOrchestrationConfig(source, "sensitiveExtraPaths 必须是字符串数组。");
  }
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const entry of value as string[]) {
    let candidate: string;
    try {
      candidate = normalizeWorkspaceRelativePath(entry).replace(/\/+$/, "").normalize("NFC");
    } catch {
      throw invalidOrchestrationConfig(source, "sensitiveExtraPaths 只能包含规范的 workspace 相对路径。");
    }
    if (candidate === "." || isReservedWorkspacePath(candidate)) {
      throw invalidOrchestrationConfig(source, "sensitiveExtraPaths 不能是 workspace 根或控制面保留目录。");
    }
    const deduplicationKey = candidate.toLocaleLowerCase("en-US");
    if (!seen.has(deduplicationKey)) {
      seen.add(deduplicationKey);
      normalized.push(candidate);
    }
  }
  return normalized;
}

function invalidOrchestrationConfig(source: string, message: string): StinkyCobblerError {
  return tieredError("TIERED_CONFIG_INVALID", `${source} 中 ${message}`, "修复：按 orchestration.yaml 模板使用正确类型、范围和 workspace 相对路径。");
}

/* ------------------------------------------------------------------ */
/* specialists.yaml — builtin + user specialist registry               */
/* ------------------------------------------------------------------ */

export interface SpecialistsFile {
  version: 1;
  specialists?: import("../contracts/orchestration.js").WorkerProfile[];
}

export interface ContractTemplatesFile {
  version: 1;
  templates?: {
    name: string;
    description: string;
    domain: string;
    goal: string;
    criteria: string[];
    scope: string[];
  }[];
}

const SPECIALISTS_TOP_LEVEL_KEYS = new Set(["version", "specialists"]);
const SPECIALIST_KEYS = new Set(["domain", "title", "instructions", "acceptanceChecklist", "negativeRules", "suggestedCapabilities"]);
const CONTRACT_TEMPLATES_TOP_LEVEL_KEYS = new Set(["version", "templates"]);
const CONTRACT_TEMPLATE_KEYS = new Set(["name", "description", "domain", "goal", "criteria", "scope"]);
const SUGGESTED_CAPABILITIES = new Set(["repository-read", "git-read", "docs-index", "repository-write"]);

/** Loads and validates specialist layers. Effective specialists are already merged by domain. */
export async function loadSpecialistsPolicy(workspace: LocalWorkspace | null): Promise<TieredLoadResult<SpecialistsFile>> {
  const loaded = await loadTieredYaml<SpecialistsFile>(workspace, "specialists.yaml", 1);
  assertSpecialistsFile(loaded.builtin, "policies/specialists.yaml (内置)", true);
  for (const overlay of overlayEntries(loaded)) assertSpecialistsFile(overlay.value, overlay.path, false);
  return loaded;
}

/** Loads and validates contract-template layers. Effective templates are already merged by name. */
export async function loadContractTemplatesPolicy(workspace: LocalWorkspace | null): Promise<TieredLoadResult<ContractTemplatesFile>> {
  const loaded = await loadTieredYaml<ContractTemplatesFile>(workspace, "contract-templates.yaml", 1);
  assertContractTemplatesFile(loaded.builtin, "policies/contract-templates.yaml (内置)", true);
  for (const overlay of overlayEntries(loaded)) assertContractTemplatesFile(overlay.value, overlay.path, false);
  return loaded;
}

function overlayEntries<T>(loaded: TieredLoadResult<T>): Array<{ value: T; path: string }> {
  const entries: Array<{ value: T; path: string }> = [];
  if (loaded.home !== null) entries.push({ value: loaded.home, path: loaded.homePath ?? "user layer" });
  if (loaded.user !== null) entries.push({ value: loaded.user, path: loaded.userPath ?? "workspace layer" });
  return entries;
}

function effectiveSource(loaded: { userPath: string | null; homePath: string | null }, builtinLabel: string): string {
  return loaded.userPath ?? loaded.homePath ?? builtinLabel;
}

function assertSpecialistsFile(config: SpecialistsFile, source: string, requireCollection: boolean): void {
  assertExactKeys(config, SPECIALISTS_TOP_LEVEL_KEYS, source);
  if (config.specialists === undefined) {
    if (requireCollection) throw invalidTieredPolicy(source, "specialists 必须是专才数组。", "specialists.yaml");
    return;
  }
  if (!Array.isArray(config.specialists) || config.specialists.length > 100) {
    throw invalidTieredPolicy(source, "specialists 必须是最多 100 项的数组。", "specialists.yaml");
  }
  const domains = new Set<string>();
  for (const [index, value] of config.specialists.entries()) {
    const label = `specialists[${index}]`;
    if (!isPlainObject(value)) throw invalidTieredPolicy(source, `${label} 必须是对象。`, "specialists.yaml");
    assertExactKeys(value, SPECIALIST_KEYS, `${source} ${label}`);
    assertText(value.domain, source, `${label}.domain`, 64);
    assertText(value.title, source, `${label}.title`, 128);
    assertTextArray(value.instructions, source, `${label}.instructions`, 1, 30);
    assertTextArray(value.acceptanceChecklist, source, `${label}.acceptanceChecklist`, 1, 30, undefined, 512 - "验收：".length);
    assertTextArray(value.negativeRules, source, `${label}.negativeRules`, 1, 30, undefined, 512 - "禁止：".length);
    assertTextArray(value.suggestedCapabilities, source, `${label}.suggestedCapabilities`, 1, 10, SUGGESTED_CAPABILITIES);
    const instructionCount = 1 + value.instructions.length + value.acceptanceChecklist.length + value.negativeRules.length;
    if (instructionCount > 30) {
      throw invalidTieredPolicy(source, `${label} 注入 header 后的 instructions、acceptanceChecklist、negativeRules 总计不能超过 30 项。`, "specialists.yaml");
    }
    assertText(`[专才] ${value.title}（领域 ${value.domain}）`, source, `${label} 注入后的 header`, 512);
    const domainKey = String(value.domain).normalize("NFC").toLocaleLowerCase("en-US");
    if (domains.has(domainKey)) throw invalidTieredPolicy(source, `${label}.domain 与同文件中的其他专才重复。`, "specialists.yaml");
    domains.add(domainKey);
  }
}

function assertContractTemplatesFile(config: ContractTemplatesFile, source: string, requireCollection: boolean): void {
  assertExactKeys(config, CONTRACT_TEMPLATES_TOP_LEVEL_KEYS, source);
  if (config.templates === undefined) {
    if (requireCollection) throw invalidTieredPolicy(source, "templates 必须是契约模板数组。", "contract-templates.yaml");
    return;
  }
  if (!Array.isArray(config.templates) || config.templates.length > 100) {
    throw invalidTieredPolicy(source, "templates 必须是最多 100 项的数组。", "contract-templates.yaml");
  }
  const names = new Set<string>();
  for (const [index, value] of config.templates.entries()) {
    const label = `templates[${index}]`;
    if (!isPlainObject(value)) throw invalidTieredPolicy(source, `${label} 必须是对象。`, "contract-templates.yaml");
    assertExactKeys(value, CONTRACT_TEMPLATE_KEYS, `${source} ${label}`);
    assertText(value.name, source, `${label}.name`, 128);
    assertText(value.description, source, `${label}.description`, 512);
    assertText(value.domain, source, `${label}.domain`, 64);
    assertText(value.goal, source, `${label}.goal`, 512);
    assertTextArray(value.criteria, source, `${label}.criteria`, 1, HARD_MAX_CONTRACT_CRITERIA);
    assertTextArray(value.scope, source, `${label}.scope`, 1, 50);
    for (const scope of value.scope as string[]) {
      try {
        assertWorkspacePathPolicy(scope);
      } catch {
        throw invalidTieredPolicy(source, `${label}.scope 只能包含非敏感、非保留的 workspace 相对路径。`, "contract-templates.yaml");
      }
    }
    const nameKey = String(value.name).normalize("NFC").toLocaleLowerCase("en-US");
    if (names.has(nameKey)) throw invalidTieredPolicy(source, `${label}.name 与同文件中的其他模板重复。`, "contract-templates.yaml");
    names.add(nameKey);
  }
}

function assertExactKeys(value: object, allowed: Set<string>, source: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw invalidTieredPolicy(source, `包含未知配置项：${unknown.join(", ")}。`);
}

function assertText(value: unknown, source: string, label: string, maximum: number): void {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum || /[\0\r\n]/.test(value)) {
    throw invalidTieredPolicy(source, `${label} 必须是 1-${maximum} 字符的单行非空字符串。`);
  }
}

function assertTextArray(value: unknown, source: string, label: string, minimum: number, maximum: number, allowed?: Set<string>, itemMaximum = 512): void {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    throw invalidTieredPolicy(source, `${label} 必须是 ${minimum}-${maximum} 项的字符串数组。`);
  }
  const seen = new Set<string>();
  for (const item of value) {
    assertText(item, source, `${label}[]`, itemMaximum);
    const normalized = String(item).normalize("NFC");
    if (allowed !== undefined && !allowed.has(normalized)) {
      throw invalidTieredPolicy(source, `${label} 含不支持的值 ${normalized}。`);
    }
    const key = normalized.toLocaleLowerCase("en-US");
    if (seen.has(key)) throw invalidTieredPolicy(source, `${label} 不能包含重复值。`);
    seen.add(key);
  }
}

function invalidTieredPolicy(source: string, message: string, fileName = "policy YAML"): StinkyCobblerError {
  return tieredError("TIERED_CONFIG_INVALID", `${source} 中 ${message}`, `修复：按 ${fileName} 模板填写完整字段，删除未知键，并使用受支持的非空值。`);
}
