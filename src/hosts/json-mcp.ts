import { ExitCode, StinkyCobblerError } from "../errors.js";
import type { McpMergeResult, McpServerSpec } from "./host-adapter.js";

export function isSameMcpServer(value: unknown, server: McpServerSpec): boolean {
  if (!isRecord(value) || value.command !== server.command || !Array.isArray(value.args)) return false;
  return value.args.length === server.args.length && value.args.every((arg, index) => arg === server.args[index]);
}

export function readJsonMcp(text: string, keyPath: readonly string[]): Record<string, McpServerSpec> {
  if (text.trim() === "") return {};
  const servers = objectAt(parseObject(text), keyPath) ?? {};
  return normalizeServers(servers);
}

export function mergeJsonMcp(text: string, keyPath: readonly string[], id: string, server: McpServerSpec): McpMergeResult {
  if (text.trim() === "") return { status: "merged", text: `${JSON.stringify(assignServer({}, keyPath, id, server), null, 2)}\n` };
  let root: Record<string, unknown>;
  try {
    root = parseObject(text);
  } catch {
    return { status: "invalid" };
  }
  const current = objectAt(root, keyPath)?.[id];
  if (current !== undefined) {
    return isSameMcpServer(current, server) ? { status: "unchanged", text } : { status: "conflict" };
  }
  return { status: "merged", text: `${JSON.stringify(assignServer(root, keyPath, id, server), null, 2)}\n` };
}

function parseObject(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value)) throw new StinkyCobblerError("HOST_MCP_INVALID", ExitCode.VALIDATION, "Host MCP config must be a JSON object.");
  return value;
}

function objectAt(root: Record<string, unknown>, keyPath: readonly string[]): Record<string, unknown> | undefined {
  let current: unknown = root;
  for (const key of keyPath) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return isRecord(current) ? current : undefined;
}

function assignServer(root: Record<string, unknown>, keyPath: readonly string[], id: string, server: McpServerSpec): Record<string, unknown> {
  const [head, ...rest] = keyPath;
  if (head === undefined) return { ...root, [id]: { command: server.command, args: [...server.args] } };
  const child = isRecord(root[head]) ? root[head] : {};
  return { ...root, [head]: assignServer(child, rest, id, server) };
}

function normalizeServers(servers: Record<string, unknown>): Record<string, McpServerSpec> {
  const result: Record<string, McpServerSpec> = {};
  for (const [id, value] of Object.entries(servers)) {
    if (!isRecord(value) || typeof value.command !== "string") continue;
    const args = Array.isArray(value.args) ? value.args.filter((arg): arg is string => typeof arg === "string") : [];
    result[id] = { command: value.command, args };
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
