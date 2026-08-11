/** Two-layer tiered YAML config: package-internal builtin defaults + workspace overlay (.stinky-cobbler/policies/). */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { ExitCode, StinkyCobblerError } from "../errors.js";
import type { LocalWorkspace } from "../storage/workspace.js";

/** Package-internal policies directory (ships with the tool; npm updates replace it — never edit directly). */
export const PACKAGE_POLICIES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..", "policies");

/** Workspace overlay directory inside the control plane (user-owned; survives updates, wins over builtin). */
export function userPoliciesDir(workspace: LocalWorkspace): string {
  return path.join(workspace.directory, "policies");
}

export interface TieredLoadResult<T> {
  /** Merged effective config: user keys override builtin keys (shallow); used by callers. */
  effective: T;
  builtin: T;
  user: T | null;
  userPath: string | null;
}

/**
 * Loads a two-layer YAML config:
 * - builtin: <package>/policies/<fileName> (defaults; updated with the package)
 * - user:   <workspace>/.stinky-cobbler/policies/<fileName> (overlay; survives updates)
 * Merge is shallow (record keys), so a user file only overrides the keys it declares.
 * Malformed YAML or a wrong version fails closed — never silently falls back.
 */
export async function loadTieredYaml<T extends { version: number }>(workspace: LocalWorkspace | null, fileName: string, expectedVersion: number): Promise<TieredLoadResult<T>> {
  let builtin: T;
  try {
    builtin = await loadYamlFile<T>(path.join(PACKAGE_POLICIES_DIR, fileName), `policies/${fileName} (builtin)`);
  } catch (error: unknown) {
    if (isCode(error, "ENOENT")) throw tieredError("TIERED_CONFIG_MISSING", `policies/${fileName} (builtin) 不存在；工具安装不完整。`,
      `修复：重新安装 stinky-cobbler（npm install -g stinky-cobbler）。`);
    throw error;
  }
  if (builtin.version !== expectedVersion) throw tieredError("TIERED_CONFIG_VERSION", `内置 policies/${fileName} 版本异常（应为 ${expectedVersion}）。`,
    `修复：重新安装 stinky-cobbler（npm install -g stinky-cobbler）。`);
  let user: T | null = null;
  let userPath: string | null = null;
  if (workspace !== null) {
    userPath = path.join(userPoliciesDir(workspace), fileName);
    try {
      user = await loadYamlFile<T>(userPath, userPath);
    } catch (error: unknown) {
      if (isCode(error, "ENOENT")) { user = null; userPath = null; } else { throw error; }
    }
  }
  if (user !== null && user.version !== expectedVersion) {
    throw tieredError("TIERED_CONFIG_VERSION", `${userPath} 的 version 必须为 ${expectedVersion}（当前 ${user.version}）。`,
      `修复：打开 ${userPath}，把第一行改为 version: ${expectedVersion}。正确示例：\nversion: ${expectedVersion}\ndefaults:\n  maxRounds: 10`);
  }
  return { effective: mergeShallow(builtin, user), builtin, user, userPath };
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
  return value as T;
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
    maxParallel?: number;
    maxWritesPerBatch?: number;
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
const HARD_MAX_ROUNDS = 1000;

/** Loads orchestration.yaml and validates it fail-closed (tighten-only guards, numeric bounds). */
export async function loadOrchestrationConfig(workspace: LocalWorkspace | null): Promise<OrchestrationConfig> {
  const loaded = await loadTieredYaml<OrchestrationConfig>(workspace, "orchestration.yaml", 1);
  const { effective, userPath } = loaded;
  const source = userPath ?? "policies/orchestration.yaml (内置)";
  const d = effective.defaults ?? {};
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
  if (d.autoRejectScoreThreshold !== undefined && (d.autoRejectScoreThreshold < 0 || d.autoRejectScoreThreshold > 100)) {
    throw tieredError("TIERED_CONFIG_INVALID", `${source} 中 defaults.autoRejectScoreThreshold 必须是 0-100（0 关闭）。`,
      `修复：改为 0-100 的整数，如 60。正确示例：\ndefaults:\n  autoRejectScoreThreshold: 60`);
  }
  if (d.maxRounds !== undefined && (d.maxRounds < 1 || d.maxRounds > HARD_MAX_ROUNDS)) {
    throw tieredError("TIERED_CONFIG_INVALID", `${source} 中 defaults.maxRounds 必须是 1-${HARD_MAX_ROUNDS}。`,
      `修复：改为 1-${HARD_MAX_ROUNDS} 的整数，如 10。正确示例：\ndefaults:\n  maxRounds: 10`);
  }
  if (d.maxRetriesPerSubtask !== undefined && (d.maxRetriesPerSubtask < 0 || d.maxRetriesPerSubtask > 50)) {
    throw tieredError("TIERED_CONFIG_INVALID", `${source} 中 defaults.maxRetriesPerSubtask 必须是 0-50。`,
      `修复：改为 0-50 的整数。正确示例：\ndefaults:\n  maxRetriesPerSubtask: 3`);
  }
  if (d.maxSubtaskTokens !== undefined && (d.maxSubtaskTokens < 1000 || d.maxSubtaskTokens > 10_000_000)) {
    throw tieredError("TIERED_CONFIG_INVALID", `${source} 中 defaults.maxSubtaskTokens 必须是 1000-10000000。`,
      `修复：改为 1000-10000000 的整数。正确示例：\ndefaults:\n  maxSubtaskTokens: 400000`);
  }
  if (d.leaseGraceMinutes !== undefined && (d.leaseGraceMinutes < 0 || d.leaseGraceMinutes > 1440)) {
    throw tieredError("TIERED_CONFIG_INVALID", `${source} 中 defaults.leaseGraceMinutes 必须是 0-1440。`,
      `修复：改为 0-1440 的整数。正确示例：\ndefaults:\n  leaseGraceMinutes: 15`);
  }
  return effective;
}

/* ------------------------------------------------------------------ */
/* specialists.yaml — builtin + user specialist registry               */
/* ------------------------------------------------------------------ */

export interface SpecialistsFile {
  version: 1;
  specialists: import("../contracts/orchestration.js").WorkerProfile[];
}

export interface ContractTemplatesFile {
  version: 1;
  templates: {
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
  domainConfirmation?: Record<string, string>;
  reviewStyle?: Record<string, string>;
  instructionsLanguage?: Record<string, unknown>;
}
