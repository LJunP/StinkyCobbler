import { ExitCode, StinkyCobblerError } from "../errors.js";
import { sameMcpEntry, type HostMcpEntry, type McpMergeResult } from "./host-adapter.js";

function isSameMcpServer(value: unknown, server: HostMcpEntry): boolean {
  const installed = normalizeServer(value);
  return installed !== undefined && sameMcpEntry(installed, server);
}

export function readJsonMcp(text: string, keyPath: readonly string[]): Record<string, HostMcpEntry> {
  if (text.trim() === "") return {};
  const servers = objectAt(parseObject(text), keyPath) ?? {};
  return normalizeServers(servers);
}

export function mergeJsonMcp(text: string, keyPath: readonly string[], id: string, server: HostMcpEntry): McpMergeResult {
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

/** JSON hosts are rewritten as a whole on merge too, so replacing keeps every other key but not the original layout. */
export function replaceJsonMcp(text: string, keyPath: readonly string[], id: string, server: HostMcpEntry): McpMergeResult {
  let root: Record<string, unknown>;
  try {
    root = parseObject(text);
  } catch {
    return { status: "invalid" };
  }
  const current = objectAt(root, keyPath)?.[id];
  if (current === undefined) return { status: "conflict" };
  if (isSameMcpServer(current, server)) return { status: "unchanged", text };
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

function assignServer(root: Record<string, unknown>, keyPath: readonly string[], id: string, server: HostMcpEntry): Record<string, unknown> {
  const [head, ...rest] = keyPath;
  if (head === undefined) return { ...root, [id]: serverJson(server) };
  const child = isRecord(root[head]) ? root[head] : {};
  return { ...root, [head]: assignServer(child, rest, id, server) };
}

/** JSON hosts write `env` as an object; `envVars` is a TOML-host field and is never written here. */
function serverJson(server: HostMcpEntry): Record<string, unknown> {
  const env = server.env ?? {};
  return { command: server.command, args: [...server.args], ...(Object.keys(env).length === 0 ? {} : { env: { ...env } }) };
}

function normalizeServers(servers: Record<string, unknown>): Record<string, HostMcpEntry> {
  const result: Record<string, HostMcpEntry> = {};
  for (const [id, value] of Object.entries(servers)) {
    const server = normalizeServer(value);
    if (server !== undefined) result[id] = server;
  }
  return result;
}

function normalizeServer(value: unknown): HostMcpEntry | undefined {
  if (!isRecord(value) || typeof value.command !== "string") return undefined;
  const args = Array.isArray(value.args) ? value.args.filter((arg): arg is string => typeof arg === "string") : [];
  const env = isRecord(value.env) ? Object.fromEntries(Object.entries(value.env).filter((pair): pair is [string, string] => typeof pair[1] === "string")) : {};
  return { command: value.command, args, ...(Object.keys(env).length === 0 ? {} : { env }) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
