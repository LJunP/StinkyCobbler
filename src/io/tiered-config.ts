import { lstat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { ExitCode, StinkyCobblerError } from "../errors.js";

export type TieredLayerName = "builtin" | "user" | "project";

/** record replaces arrays. fields selects a strategy per key. */
export type MergeStrategy = "record" | "appendOnly" | { readonly keyedList: string } | { readonly fields: Readonly<Record<string, MergeStrategy>> };

export interface TieredLayer<T> {
  name: TieredLayerName;
  value: T | null;
  path: string | null;
}

export interface TieredDocument<T> {
  effective: T;
  layers: readonly TieredLayer<T>[];
  diagnostics: readonly string[];
}

/** Folds layers from lowest precedence to highest. Null layers are skipped. */
export function mergeTiered<T>(layers: readonly (T | null | undefined)[], strategy: MergeStrategy): T {
  let current: unknown;
  let started = false;
  for (const layer of layers) {
    if (layer == null) continue;
    current = started ? applyStrategy(current, layer, strategy) : layer;
    started = true;
  }
  if (!started) {
    throw tieredConfigError("TIERED_CONFIG_MISSING", "分层配置至少需要一个内置层。", "修复：重新安装 stinky-cobbler（npm install -g stinky-cobbler）。");
  }
  return current as T;
}

export function loadTieredDocument<T>(layers: readonly TieredLayer<T>[], strategy: MergeStrategy): TieredDocument<T> {
  return {
    effective: mergeTiered(
      layers.map((layer) => layer.value),
      strategy
    ),
    layers,
    diagnostics: []
  };
}

/** XDG Base Directory config home. An empty variable means ~/.config. */
export function resolveConfigHome(env: Readonly<NodeJS.ProcessEnv>, homeDirectory: string): string {
  const raw = env.XDG_CONFIG_HOME;
  if (raw === undefined || raw.trim() === "") return path.join(homeDirectory, ".config");
  const configured = raw.trim();
  if (!path.isAbsolute(configured)) {
    throw tieredConfigError(
      "TIERED_CONFIG_INVALID",
      "XDG_CONFIG_HOME 必须是绝对路径。",
      "修复：把 XDG_CONFIG_HOME 设为绝对路径，或取消该变量以使用 ~/.config。"
    );
  }
  return configured;
}

export function userPolicyFile(fileName: string, env: Readonly<NodeJS.ProcessEnv> = process.env, homeDirectory = homedir()): string {
  return path.join(resolveConfigHome(env, homeDirectory), "stinky-cobbler", "policies", fileName);
}

/** Reads one YAML object. A missing file is null. A symlink is refused. */
export async function readTieredYamlFile<T>(file: string, label: string): Promise<T | null> {
  try {
    const info = await lstat(file);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw tieredConfigError("TIERED_CONFIG_INVALID", `${label} 必须是普通文件，不能是符号链接或目录。`, `修复：把 ${label} 换成普通文件，或删除该路径。`);
    }
  } catch (error: unknown) {
    if (isNodeCode(error, "ENOENT")) return null;
    throw error;
  }
  try {
    return parseTieredYaml<T>(await readFile(file, "utf8"), label);
  } catch (error: unknown) {
    if (isNodeCode(error, "ENOENT")) return null;
    throw error;
  }
}

function applyStrategy(base: unknown, over: unknown, strategy: MergeStrategy): unknown {
  if (strategy === "appendOnly") return appendUnique(base, over);
  if (strategy === "record") return mergeOneLevel(base, over);
  if ("keyedList" in strategy) return mergeKeyed(base, over, strategy.keyedList);
  return mergeFields(base, over, strategy.fields);
}

function mergeFields(base: unknown, over: unknown, fields: Readonly<Record<string, MergeStrategy>>): unknown {
  if (!isPlainObject(base) || !isPlainObject(over)) return over;
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(over)) {
    const existing = base[key];
    result[key] = existing === undefined ? value : applyStrategy(existing, value, fields[key] ?? "record");
  }
  return result;
}

function mergeOneLevel(base: unknown, over: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(over)) return over;
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(over)) {
    const existing = result[key];
    result[key] = isPlainObject(existing) && isPlainObject(value) ? { ...existing, ...value } : value;
  }
  return result;
}

/** Later items are added. Earlier items stay even when the later array omits them. */
function appendUnique(base: unknown, over: unknown): unknown[] {
  if (!Array.isArray(base) || !Array.isArray(over)) {
    throw tieredConfigError("TIERED_CONFIG_INVALID", "appendOnly 合并的两侧都必须是数组。", "修复：把该字段写成 YAML 数组。");
  }
  const seen = new Set<unknown>();
  const merged: unknown[] = [];
  for (const item of base) {
    seen.add(item);
    merged.push(item);
  }
  for (const item of over) {
    if (seen.has(item)) continue;
    seen.add(item);
    merged.push(item);
  }
  return merged;
}

function mergeKeyed(base: unknown, over: unknown, key: string): unknown[] {
  if (!Array.isArray(base) || !Array.isArray(over)) {
    throw tieredConfigError("TIERED_CONFIG_INVALID", "keyedList 合并的两侧都必须是数组。", "修复：把该字段写成对象数组。");
  }
  const merged = new Map<string, unknown>();
  for (const item of base) merged.set(keyedId(item, key), item);
  for (const item of over) merged.set(keyedId(item, key), item);
  return [...merged.values()];
}

function keyedId(item: unknown, key: string): string {
  if (!isPlainObject(item) || typeof item[key] !== "string" || item[key].length === 0) {
    throw tieredConfigError("TIERED_CONFIG_INVALID", `keyedList 条目必须包含非空字符串字段 ${key}。`, `修复：为每个条目填写 ${key}。`);
  }
  return item[key];
}

function parseTieredYaml<T>(text: string, label: string): T {
  let value: unknown;
  try {
    value = parseYaml(text);
  } catch (error: unknown) {
    throw tieredConfigError(
      "TIERED_CONFIG_INVALID",
      `${label} 不是有效的 YAML: ${error instanceof Error ? error.message : String(error)}`,
      `修复：检查 ${label} 的缩进与冒号——每个键一行「键: 值」，# 开头的是注释。正确示例：\nversion: 1\ndefaults:\n  maxRounds: 10`
    );
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw tieredConfigError(
      "TIERED_CONFIG_INVALID",
      `${label} 必须是一个 YAML 对象（顶层不能是数组或纯文本）。`,
      `修复：文件顶部保留 version: 1，其余键按模板格式写在下方。`
    );
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
      throw tieredConfigError("TIERED_CONFIG_INVALID", `${label} 含有禁止的对象键 ${key}。`, "修复：删除该键并使用模板声明的配置项。");
    }
    assertNoPrototypeKeys(entry, label, seen);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function tieredConfigError(code: string, message: string, fix: string): StinkyCobblerError {
  return new StinkyCobblerError(code, ExitCode.VALIDATION, message, { fix });
}

function isNodeCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
