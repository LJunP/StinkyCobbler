import { parse, stringify } from "smol-toml";
import { appendTomlDocument } from "../io/toml-edit.js";
import { sameMcpEntry, type HostMcpEntry, type McpMergeResult } from "./host-adapter.js";

export function readTomlMcp(text: string): Record<string, HostMcpEntry> {
  if (text.trim() === "") return {};
  const parsed = parse(text);
  const servers = isRecord(parsed.mcp_servers) ? parsed.mcp_servers : {};
  const result: Record<string, HostMcpEntry> = {};
  for (const [id, value] of Object.entries(servers)) {
    const server = tomlServer(value);
    if (server !== undefined) result[id] = server;
  }
  return result;
}

function tomlServer(value: unknown): HostMcpEntry | undefined {
  if (!isRecord(value) || typeof value.command !== "string") return undefined;
  const args = Array.isArray(value.args) ? value.args.filter((arg): arg is string => typeof arg === "string") : [];
  const envVars = Array.isArray(value.env_vars) ? value.env_vars.filter((name): name is string => typeof name === "string") : [];
  return { command: value.command, args, ...(envVars.length === 0 ? {} : { envVars }) };
}

export function mergeTomlMcp(text: string, id: string, server: HostMcpEntry): McpMergeResult {
  let parsed: Record<string, unknown> = {};
  if (text.trim() !== "") {
    try {
      parsed = asRecord(parse(text));
    } catch {
      return { status: "invalid" };
    }
  }
  const servers = isRecord(parsed.mcp_servers) ? parsed.mcp_servers : {};
  const current = servers[id] === undefined ? undefined : tomlServer(servers[id]);
  if (servers[id] !== undefined) {
    return current !== undefined && sameMcpEntry(current, server) ? { status: "unchanged", text } : { status: "conflict" };
  }
  const envVars = server.envVars ?? [];
  const fragment = { mcp_servers: { [id]: { command: server.command, args: [...server.args], ...(envVars.length === 0 ? {} : { env_vars: [...envVars] }) } } };
  const next = text.length === 0 ? `${stringify(fragment)}\n` : appendTomlDocument(text, fragment);
  try {
    parse(next);
  } catch {
    return { status: "invalid" };
  }
  return { status: "merged", text: next };
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
