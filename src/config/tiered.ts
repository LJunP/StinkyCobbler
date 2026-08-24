/** Two-layer tiered YAML config: package-internal builtin defaults + workspace overlay (.stinky-cobbler/policies/). */

import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { defaultSchemaRegistry } from "../contracts/default-schema-registry.js";
import type { ContractKind } from "../contracts/schema-registry.js";
import { ExitCode, StinkyCobblerError } from "../errors.js";
import { workspaceFile, type LocalWorkspace } from "../storage/workspace.js";
import { assertWorkspacePathPolicy, isReservedWorkspacePath, normalizeWorkspaceRelativePath } from "../security/workspace-path.js";

/** Package-internal policies directory (ships with the tool; npm updates replace it — never edit directly). */
export const PACKAGE_POLICIES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..", "policies");

export interface TieredLoadResult<T> {
  /** Merged effective config: user keys override builtin keys (shallow); used by callers. */
  effective: T;
  builtin: T;
  user: T | null;
  userPath: string | null;
}

export type TieredPolicyFileName = "orchestration.yaml" | "specialists.yaml" | "templates.yaml" | "contract-templates.yaml";

const POLICY_SCHEMA_KIND_BY_FILE: Record<TieredPolicyFileName, ContractKind> = {
  "orchestration.yaml": "orchestration-policy",
  "specialists.yaml": "specialists-policy",
  "templates.yaml": "templates-policy",
  "contract-templates.yaml": "contract-templates-policy"
};

/**
 * Loads a two-layer YAML config:
 * - builtin: <package>/policies/<fileName> (defaults; updated with the package)
 * - user:   <workspace>/.stinky-cobbler/policies/<fileName> (overlay; survives updates)
 * Merge is shallow (record keys), so a user file only overrides the keys it declares.
 * Malformed YAML or a wrong version fails closed — never silently falls back.
 */
export async function loadTieredYaml<T extends { version: number }>(workspace: LocalWorkspace | null, fileName: TieredPolicyFileName, expectedVersion: 1): Promise<TieredLoadResult<T>> {
  const policyKind = (POLICY_SCHEMA_KIND_BY_FILE as Partial<Record<string, ContractKind>>)[fileName];
  if (policyKind === undefined) {
    throw tieredError("TIERED_CONFIG_INVALID", `不支持的 tiered policy kind：${String(fileName)}。`,
      "修复：只允许 orchestration.yaml、specialists.yaml、templates.yaml 或 contract-templates.yaml。");
  }
  let builtin: T;
  const builtinLabel = `policies/${fileName} (builtin)`;
  try {
    builtin = await loadYamlFile<T>(path.join(PACKAGE_POLICIES_DIR, fileName), builtinLabel);
  } catch (error: unknown) {
    if (isCode(error, "ENOENT")) throw tieredError("TIERED_CONFIG_MISSING", `policies/${fileName} (builtin) 不存在；工具安装不完整。`,
      `修复：重新安装 stinky-cobbler（npm install -g stinky-cobbler）。`);
    throw error;
  }
  if (builtin.version !== expectedVersion) throw tieredError("TIERED_CONFIG_VERSION", `内置 policies/${fileName} 版本异常（应为 ${expectedVersion}）。`,
    `修复：重新安装 stinky-cobbler（npm install -g stinky-cobbler）。`);
  await validatePolicyLayer(fileName, policyKind, builtin, builtinLabel);
  let user: T | null = null;
  let userPath: string | null = null;
  if (workspace !== null) {
    try {
      // A workspace overlay is optional. If the control-plane root has not
      // been initialized, use the validated builtin policy without creating
      // anything. Once it exists, workspaceFile still enforces canonical
      // containment and rejects every symlinked component.
      await lstat(workspace.directory);
      userPath = await workspaceFile(workspace, `policies/${fileName}`);
      user = await loadYamlFile<T>(userPath, userPath);
    } catch (error: unknown) {
      if (isCode(error, "ENOENT")) { user = null; userPath = null; } else { throw error; }
    }
  }
  if (user !== null && user.version !== expectedVersion) {
    throw tieredError("TIERED_CONFIG_VERSION", `${userPath} 的 version 必须为 ${expectedVersion}（当前 ${user.version}）。`,
      `修复：打开 ${userPath}，把第一行改为 version: ${expectedVersion}。正确示例：\nversion: ${expectedVersion}\ndefaults:\n  maxRounds: 10`);
  }
  if (user !== null) await validatePolicyLayer(fileName, policyKind, user, userPath ?? `workspace ${fileName}`);
  return { effective: mergeShallow(builtin, user), builtin, user, userPath };
}

async function validatePolicyLayer(fileName: TieredPolicyFileName, policyKind: ContractKind, value: unknown, label: string): Promise<void> {
  try {
    (await defaultSchemaRegistry()).validate(policyKind, value);
  } catch (error: unknown) {
    if (!(error instanceof StinkyCobblerError) || error.code !== "SCHEMA_INVALID") throw error;
    const schemaErrors = Array.isArray(error.details?.errors)
      ? error.details.errors as Array<{ path?: unknown; message?: unknown }>
      : [];
    const errors = schemaErrors.length > 0
      ? schemaErrors.map((entry) => `${String(entry.path ?? "/")} ${String(entry.message ?? "invalid")}`).join("; ")
      : "unknown schema violation";
    const fix = fileName === "orchestration.yaml" && schemaErrors.some((entry) => entry.path === "/defaults/oscillationThreshold")
      ? "修复：改为 1 或 2。正确示例：\ndefaults:\n  oscillationThreshold: 2"
      : `修复：按 ${fileName} 模板填写受支持的字段与类型，删除未知键。`;
    throw tieredError("TIERED_CONFIG_INVALID", `${label} 不符合 ${fileName} JSON Schema：${errors}`,
      fix);
  }
}

/** One-level deep merge: user keys override builtin keys; nested plain objects merge key-wise, arrays are replaced wholesale. */
function mergeShallow<T>(builtin: T, user: T | null): T {
  if (user === null) return builtin;
  if (isPlainObject(builtin) && isPlainObject(user)) {
    const result: Record<string, unknown> = { ...builtin };
    for (const [key, value] of Object.entries(user as Record<string, unknown>)) {
      const existing = (builtin as Record<string, unknown>)[key];
      if (isPlainObject(existing) && isPlainObject(value)) {
        result[key] = { ...existing, ...value };
      } else {
        result[key] = value;
      }
    }
    return result as T;
  }
  return user;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function loadYamlFile<T>(file: string, label: string): Promise<T> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error: unknown) {
    // Native ENOENT propagates untouched so callers can distinguish a missing user overlay (skip) from a missing builtin (fail).
    throw error;
  }
  let value: unknown;
  try {
    value = parseYaml(text);
  } catch (error: unknown) {
    throw tieredError("TIERED_CONFIG_INVALID", `${label} 不是有效的 YAML: ${error instanceof Error ? error.message : String(error)}`,
      `修复：检查 ${label} 的缩进与冒号——每个键一行「键: 值」，# 开头的是注释。正确示例：\nversion: 1\ndefaults:\n  maxRounds: 10`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw tieredError("TIERED_CONFIG_INVALID", `${label} 必须是一个 YAML 对象（顶层不能是数组或纯文本）。`,
      `修复：文件顶部保留 version: 1，其余键按模板格式写在下方。`);
  }
  assertNoPrototypeKeys(value, label);
  return value as T;
}

function assertNoPrototypeKeys(value: unknown, label: string, seen = new WeakSet<object>()): void {
  if (typeof value !== "object" || value === null || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const entry of value) assertNoPrototypeKeys(entry, label, seen);
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (key === "__proto__" || key === "prototype" || key === "constructor") {
      throw tieredError("TIERED_CONFIG_INVALID", `${label} 含有禁止的对象键 ${key}。`, "修复：删除该键并使用模板声明的配置项。");
    }
    assertNoPrototypeKeys(entry, label, seen);
  }
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
  if (loaded.user !== null) assertOrchestrationConfigKeys(loaded.user, loaded.userPath ?? "workspace orchestration.yaml");
  const { effective, userPath } = loaded;
  const source = userPath ?? "policies/orchestration.yaml (内置)";
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
      throw tieredError("TIERED_CONFIG_INVALID", `${source} 中 defaults.oscillationThreshold 必须是正整数。`,
        `修复：改为 1 或 2。正确示例：\ndefaults:\n  oscillationThreshold: 2`);
    }
    if (d.oscillationThreshold > OSCILLATION_TIGHTEN_MAX) {
      throw tieredError("TIERED_CONFIG_INVALID", `${source} 中 defaults.oscillationThreshold 只能收紧：最大 ${OSCILLATION_TIGHTEN_MAX}（放宽防打磨护栏不被允许）。`,
        `修复：改为 1 或 2。正确示例：\ndefaults:\n  oscillationThreshold: 2`);
    }
  }
  if (d.autoRejectScoreThreshold !== undefined && (!Number.isSafeInteger(d.autoRejectScoreThreshold) || d.autoRejectScoreThreshold < 0 || d.autoRejectScoreThreshold > 100)) {
    throw tieredError("TIERED_CONFIG_INVALID", `${source} 中 defaults.autoRejectScoreThreshold 必须是 0-100（0 关闭）。`,
      `修复：改为 0-100 的整数，如 60。正确示例：\ndefaults:\n  autoRejectScoreThreshold: 60`);
  }
  if (d.maxRounds !== undefined && d.maxRounds > HARD_MAX_ROUNDS) {
    throw tieredError("TIERED_CONFIG_INVALID", `${source} 中 defaults.maxRounds 必须是 1-${HARD_MAX_ROUNDS}。`,
      `修复：改为 1-${HARD_MAX_ROUNDS} 的整数，如 10。正确示例：\ndefaults:\n  maxRounds: 10`);
  }
  if (d.maxRetriesPerSubtask !== undefined && (!Number.isSafeInteger(d.maxRetriesPerSubtask) || d.maxRetriesPerSubtask < 0 || d.maxRetriesPerSubtask > HARD_MAX_RETRIES)) {
    throw tieredError("TIERED_CONFIG_INVALID", `${source} 中 defaults.maxRetriesPerSubtask 必须是 0-${HARD_MAX_RETRIES}。`,
      `修复：改为 0-${HARD_MAX_RETRIES} 的整数。正确示例：\ndefaults:\n  maxRetriesPerSubtask: 3`);
  }
  if (d.maxContractCriteria !== undefined && (!Number.isInteger(d.maxContractCriteria) || d.maxContractCriteria < 1 || d.maxContractCriteria > HARD_MAX_CONTRACT_CRITERIA)) {
    throw tieredError("TIERED_CONFIG_INVALID", `${source} 中 defaults.maxContractCriteria 必须是 1-${HARD_MAX_CONTRACT_CRITERIA}。`,
      `修复：该值不能超过契约 schema 上限 ${HARD_MAX_CONTRACT_CRITERIA}。`);
  }
  if (d.maxSubtaskCriteria !== undefined && (!Number.isInteger(d.maxSubtaskCriteria) || d.maxSubtaskCriteria < 1 || d.maxSubtaskCriteria > HARD_MAX_SUBTASK_CRITERIA)) {
    throw tieredError("TIERED_CONFIG_INVALID", `${source} 中 defaults.maxSubtaskCriteria 必须是 1-${HARD_MAX_SUBTASK_CRITERIA}。`,
      `修复：该值不能超过子任务 schema 上限 ${HARD_MAX_SUBTASK_CRITERIA}。`);
  }
  if (d.maxSubtaskTokens !== undefined && (d.maxSubtaskTokens < 1000 || d.maxSubtaskTokens > 10_000_000)) {
    throw tieredError("TIERED_CONFIG_INVALID", `${source} 中 defaults.maxSubtaskTokens 必须是 1000-10000000。`,
      `修复：改为 1000-10000000 的整数。正确示例：\ndefaults:\n  maxSubtaskTokens: 400000`);
  }
  if (d.leaseGraceMinutes !== undefined && d.leaseGraceMinutes !== 15) {
    throw tieredError("TIERED_CONFIG_INVALID", `${source} 中 defaults.leaseGraceMinutes 当前必须固定为 15。`,
      `修复：改为 15；2.0.1 的 Lease 宽限期尚不支持工作区级覆盖。正确示例：\ndefaults:\n  leaseGraceMinutes: 15`);
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
  "maxRounds", "maxSubtaskTokens", "costTokensPerSubtaskRound", "orchestrateTokenThreshold",
  "maxContractCriteria", "maxSubtaskCriteria", "maxDefects", "maxInputArtifacts",
  "maxContractScopeItems", "maxSubtaskScopeItems", "maxDomainLength", "maxDomainInstructions",
  "maxWriteContentBytes", "maxSteps",
  "leaseDefaultToolCalls", "leaseMaxToolCallsCap", "leaseDefaultMinutes", "leaseMaxMinutes", "leaseGraceMinutes"
] as const;

const ORCHESTRATION_TOP_LEVEL_KEYS = new Set(["version", "defaults", "sensitiveExtraPaths"]);
const ORCHESTRATION_DEFAULT_KEYS = new Set<string>([
  ...POSITIVE_INTEGER_DEFAULTS,
  "maxRetriesPerSubtask", "oscillationThreshold", "autoRejectScoreThreshold", "autoEscalateOnConsistencyFail"
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
    try { candidate = normalizeWorkspaceRelativePath(entry).replace(/\/+$/, "").normalize("NFC"); }
    catch { throw invalidOrchestrationConfig(source, "sensitiveExtraPaths 只能包含规范的 workspace 相对路径。"); }
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
  return tieredError("TIERED_CONFIG_INVALID", `${source} 中 ${message}`,
    "修复：按 orchestration.yaml 模板使用正确类型、范围和 workspace 相对路径。");
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

export interface TemplatesFile {
  version: 1;
  domainConfirmation?: {
    prompt?: string;
    exampleHint?: string;
    unknownHint?: string;
  };
  reviewStyle?: {
    default?: string;
    concise?: string;
    detailed?: string;
  };
  instructionsLanguage?: {
    default?: string;
    options?: string[];
    note?: string;
  };
}

export interface EffectiveTemplatesConfig {
  version: 1;
  domainConfirmation: { prompt: string; exampleHint: string; unknownHint: string };
  reviewStyle: { default: string; concise: string; detailed: string };
  instructionsLanguage: { default: string; options: string[]; note: string };
}

const SPECIALISTS_TOP_LEVEL_KEYS = new Set(["version", "specialists"]);
const SPECIALIST_KEYS = new Set(["domain", "title", "instructions", "acceptanceChecklist", "negativeRules", "suggestedCapabilities"]);
const CONTRACT_TEMPLATES_TOP_LEVEL_KEYS = new Set(["version", "templates"]);
const CONTRACT_TEMPLATE_KEYS = new Set(["name", "description", "domain", "goal", "criteria", "scope"]);
const TEMPLATES_TOP_LEVEL_KEYS = new Set(["version", "domainConfirmation", "reviewStyle", "instructionsLanguage"]);
const DOMAIN_CONFIRMATION_KEYS = new Set(["prompt", "exampleHint", "unknownHint"]);
const REVIEW_STYLE_KEYS = new Set(["default", "concise", "detailed"]);
const INSTRUCTIONS_LANGUAGE_KEYS = new Set(["default", "options", "note"]);
const SUGGESTED_CAPABILITIES = new Set(["repository-read", "git-read", "docs-index", "repository-write"]);
const INSTRUCTION_LANGUAGES = new Set(["zh", "en"]);

/** Loads and validates both specialist policy layers before registry merge-by-domain. */
export async function loadSpecialistsPolicy(workspace: LocalWorkspace | null): Promise<TieredLoadResult<SpecialistsFile>> {
  const loaded = await loadTieredYaml<SpecialistsFile>(workspace, "specialists.yaml", 1);
  assertSpecialistsFile(loaded.builtin, "policies/specialists.yaml (内置)", true);
  if (loaded.user !== null) assertSpecialistsFile(loaded.user, loaded.userPath ?? "workspace specialists.yaml", false);
  return loaded;
}

/** Loads and validates both contract-template layers before merge-by-name. */
export async function loadContractTemplatesPolicy(workspace: LocalWorkspace | null): Promise<TieredLoadResult<ContractTemplatesFile>> {
  const loaded = await loadTieredYaml<ContractTemplatesFile>(workspace, "contract-templates.yaml", 1);
  assertContractTemplatesFile(loaded.builtin, "policies/contract-templates.yaml (内置)", true);
  if (loaded.user !== null) assertContractTemplatesFile(loaded.user, loaded.userPath ?? "workspace contract-templates.yaml", false);
  return loaded;
}

/** Loads the effective interaction-template dictionary and validates every key and value fail-closed. */
export async function loadTemplatesConfig(workspace: LocalWorkspace | null): Promise<EffectiveTemplatesConfig> {
  const loaded = await loadTieredYaml<TemplatesFile>(workspace, "templates.yaml", 1);
  assertTemplatesFile(loaded.builtin, "policies/templates.yaml (内置)", true);
  if (loaded.user !== null) assertTemplatesFile(loaded.user, loaded.userPath ?? "workspace templates.yaml", false);
  assertTemplatesFile(loaded.effective, loaded.userPath ?? "policies/templates.yaml (内置)", true);
  const effective = loaded.effective as EffectiveTemplatesConfig;
  if (!effective.instructionsLanguage.options.includes(effective.instructionsLanguage.default)) {
    throw invalidTieredPolicy(loaded.userPath ?? "policies/templates.yaml (内置)", "instructionsLanguage.default 必须出现在 options 中。", "templates.yaml");
  }
  return effective;
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
      try { assertWorkspacePathPolicy(scope); }
      catch { throw invalidTieredPolicy(source, `${label}.scope 只能包含非敏感、非保留的 workspace 相对路径。`, "contract-templates.yaml"); }
    }
    const nameKey = String(value.name).normalize("NFC").toLocaleLowerCase("en-US");
    if (names.has(nameKey)) throw invalidTieredPolicy(source, `${label}.name 与同文件中的其他模板重复。`, "contract-templates.yaml");
    names.add(nameKey);
  }
}

function assertTemplatesFile(config: TemplatesFile, source: string, requireComplete: boolean): void {
  assertExactKeys(config, TEMPLATES_TOP_LEVEL_KEYS, source);
  assertTemplateSection(config.domainConfirmation, DOMAIN_CONFIRMATION_KEYS, source, "domainConfirmation", requireComplete);
  assertTemplateSection(config.reviewStyle, REVIEW_STYLE_KEYS, source, "reviewStyle", requireComplete);
  const language = config.instructionsLanguage;
  if (language === undefined) {
    if (requireComplete) throw invalidTieredPolicy(source, "缺少 instructionsLanguage。", "templates.yaml");
    return;
  }
  if (!isPlainObject(language)) throw invalidTieredPolicy(source, "instructionsLanguage 必须是对象。", "templates.yaml");
  assertExactKeys(language, INSTRUCTIONS_LANGUAGE_KEYS, `${source} instructionsLanguage`);
  for (const key of ["default", "note"] as const) {
    if (language[key] === undefined) {
      if (requireComplete) throw invalidTieredPolicy(source, `instructionsLanguage.${key} 缺失。`, "templates.yaml");
    } else {
      assertText(language[key], source, `instructionsLanguage.${key}`, 1024);
    }
  }
  if (language.options === undefined) {
    if (requireComplete) throw invalidTieredPolicy(source, "instructionsLanguage.options 缺失。", "templates.yaml");
  } else {
    assertTextArray(language.options, source, "instructionsLanguage.options", 1, 2, INSTRUCTION_LANGUAGES);
  }
}

function assertTemplateSection(value: unknown, allowed: Set<string>, source: string, label: string, requireComplete: boolean): void {
  if (value === undefined) {
    if (requireComplete) throw invalidTieredPolicy(source, `缺少 ${label}。`, "templates.yaml");
    return;
  }
  if (!isPlainObject(value)) throw invalidTieredPolicy(source, `${label} 必须是对象。`, "templates.yaml");
  assertExactKeys(value, allowed, `${source} ${label}`);
  for (const key of allowed) {
    if (value[key] === undefined) {
      if (requireComplete) throw invalidTieredPolicy(source, `${label}.${key} 缺失。`, "templates.yaml");
    } else {
      assertText(value[key], source, `${label}.${key}`, 1024);
    }
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
  return tieredError("TIERED_CONFIG_INVALID", `${source} 中 ${message}`,
    `修复：按 ${fileName} 模板填写完整字段，删除未知键，并使用受支持的非空值。`);
}
