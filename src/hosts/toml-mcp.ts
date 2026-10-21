import { parse, stringify } from "smol-toml";
import { appendTomlDocument } from "../io/toml-edit.js";
import type { McpMergeResult, McpServerSpec } from "./host-adapter.js";
import { isSameMcpServer } from "./json-mcp.js";

export function readTomlMcp(text: string): Record<string, McpServerSpec> {
  if (text.trim() === "") return {};
  const parsed = parse(text);
  const servers = isRecord(parsed.mcp_servers) ? parsed.mcp_servers : {};
  const result: Record<string, McpServerSpec> = {};
  for (const [id, value] of Object.entries(servers)) {
    if (!isRecord(value) || typeof value.command !== "string") continue;
    const args = Array.isArray(value.args) ? value.args.filter((arg): arg is string => typeof arg === "string") : [];
    result[id] = { command: value.command, args };
  }
  return result;
}

export function mergeTomlMcp(text: string, id: string, server: McpServerSpec): McpMergeResult {
  let parsed: Record<string, unknown> = {};
  if (text.trim() !== "") {
    try {
      parsed = asRecord(parse(text));
    } catch {
      return { status: "invalid" };
    }
  }
  const servers = isRecord(parsed.mcp_servers) ? parsed.mcp_servers : {};
  if (servers[id] !== undefined) {
    return isSameMcpServer(servers[id], server) ? { status: "unchanged", text } : { status: "conflict" };
  }
  const fragment = { mcp_servers: { [id]: { command: server.command, args: [...server.args] } } };
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
