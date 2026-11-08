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
  const fragment = { mcp_servers: { [id]: serverTable(server) } };
  const next = text.length === 0 ? `${stringify(fragment)}\n` : appendTomlDocument(text, fragment);
  try {
    parse(next);
  } catch {
    return { status: "invalid" };
  }
  return { status: "merged", text: next };
}

/**
 * `config.toml` also holds the user's own Codex settings, so the entry is replaced as text: only the
 * `[mcp_servers.<id>]` table and its sub-tables change, and comments elsewhere survive. The result is
 * parsed again and must differ from the original in that entry alone, otherwise the edit is a conflict.
 */
export function replaceTomlMcp(text: string, id: string, server: HostMcpEntry): McpMergeResult {
  let before: Record<string, unknown>;
  try {
    before = asRecord(parse(text));
  } catch {
    return { status: "invalid" };
  }
  const servers = isRecord(before.mcp_servers) ? before.mcp_servers : {};
  if (servers[id] === undefined) return { status: "conflict" };
  const installed = tomlServer(servers[id]);
  if (installed !== undefined && sameMcpEntry(installed, server)) return { status: "unchanged", text };
  const table = serverTable(server);
  const rendered = stringify({ mcp_servers: { [id]: table } });
  const span = tableSpan(text, rendered.slice(0, rendered.indexOf("\n")));
  if (span === undefined) return { status: "conflict" };
  const next = `${text.slice(0, span.start)}${rendered.endsWith("\n") ? rendered : `${rendered}\n`}${text.slice(span.end)}`;
  let after: Record<string, unknown>;
  try {
    after = asRecord(parse(next));
  } catch {
    return { status: "invalid" };
  }
  return onlyEntryChanged(before, after, id, table) ? { status: "merged", text: next } : { status: "conflict" };
}

function serverTable(server: HostMcpEntry): Record<string, unknown> {
  const envVars = server.envVars ?? [];
  return { command: server.command, args: [...server.args], ...(envVars.length === 0 ? {} : { env_vars: [...envVars] }) };
}

/**
 * Byte range of one `[header]` table plus its `[header.sub]` tables. Trailing blank and comment-only
 * lines stay outside the range, because they read as belonging to whatever follows.
 */
function tableSpan(text: string, header: string): { start: number; end: number } | undefined {
  const lines = linesWithOffsets(text);
  const starts = lines.filter((line) => line.text.trim() === header);
  if (starts.length !== 1) return undefined;
  const first = lines.indexOf(starts[0]!);
  const subPrefix = `${header.slice(0, -1)}.`;
  let last = first;
  for (let index = first + 1; index < lines.length; index += 1) {
    const trimmed = lines[index]!.text.trim();
    if (trimmed.startsWith("[") && !trimmed.startsWith(subPrefix)) break;
    if (trimmed !== "" && !trimmed.startsWith("#")) last = index;
  }
  return { start: lines[first]!.start, end: lines[last]!.end };
}

function linesWithOffsets(text: string): Array<{ text: string; start: number; end: number }> {
  const lines: Array<{ text: string; start: number; end: number }> = [];
  let start = 0;
  while (start < text.length) {
    const newline = text.indexOf("\n", start);
    const end = newline < 0 ? text.length : newline + 1;
    lines.push({ text: text.slice(start, end), start, end });
    start = end;
  }
  return lines;
}

function onlyEntryChanged(before: Record<string, unknown>, after: Record<string, unknown>, id: string, table: Record<string, unknown>): boolean {
  const afterServers = asRecord(after.mcp_servers);
  if (canonical(afterServers[id]) !== canonical(table)) return false;
  return canonical(withoutEntry(before, id)) === canonical(withoutEntry(after, id));
}

function withoutEntry(document: Record<string, unknown>, id: string): Record<string, unknown> {
  const servers = { ...asRecord(document.mcp_servers) };
  delete servers[id];
  return { ...document, mcp_servers: servers };
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    isRecord(item) ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))) : item
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
