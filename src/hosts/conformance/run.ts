import path from "node:path";
import { ARTIFACT_KINDS, hostMcpEntry, sameMcpEntry, type HostAdapter, type HostScope } from "../host-adapter.js";

export async function runHostConformance(adapter: HostAdapter, input: { emptyHome: string; presentHome: string; cwd: string }): Promise<readonly string[]> {
  const issues: string[] = [];
  if (await adapter.detect(input.emptyHome)) issues.push(`${adapter.id} detect returned true for an empty home`);
  if (!(await adapter.detect(input.presentHome))) issues.push(`${adapter.id} detect returned false when ${adapter.presenceDirectory} exists`);
  for (const kind of ARTIFACT_KINDS) {
    for (const scope of ["user", "project"] as const) {
      issues.push(...checkLocation(adapter, kind, scope, input));
    }
  }
  issues.push(...checkMerge(adapter, input));
  return issues;
}

function checkLocation(adapter: HostAdapter, kind: (typeof ARTIFACT_KINDS)[number], scope: HostScope, input: { presentHome: string; cwd: string }): string[] {
  const found = adapter.locate(kind, scope, { home: input.presentHome, cwd: input.cwd });
  if (found.unsupported !== undefined) {
    return found.unsupported.trim() === "" ? [`${adapter.id} ${kind} ${scope} has an empty unsupported reason`] : [];
  }
  const root = scope === "user" ? input.presentHome : input.cwd;
  const relative = path.relative(root, found.path);
  const escapes = relative === "" || relative.startsWith("..") || path.isAbsolute(relative);
  const issues: string[] = [];
  if (escapes) issues.push(`${adapter.id} ${kind} ${scope} is outside ${scope === "user" ? "HOME" : "cwd"}`);
  if (found.path.split(path.sep).includes("..")) issues.push(`${adapter.id} ${kind} ${scope} contains ..`);
  return issues;
}

function checkMerge(adapter: HostAdapter, input: { presentHome: string; cwd: string }): string[] {
  const format = adapter.locate("mcp-server", "user", { home: input.presentHome, cwd: input.cwd }).format;
  if (format !== "json-mcp" && format !== "toml-mcp") return [`${adapter.id} mcp format is not mergeable`];
  const seed = format === "toml-mcp" ? "keep = true\n" : '{\n  "keep": true\n}\n';
  const first = adapter.mergeMcp(seed, "demo", { command: "tool", args: ["--a"] });
  if (first.status !== "merged" || !first.text.includes("keep")) return [`${adapter.id} merge dropped an unrelated field`];
  const second = adapter.mergeMcp(first.text, "other", { command: "other", args: [] });
  if (second.status !== "merged") return [`${adapter.id} second server was not merged`];
  const read = adapter.readMcp(second.text);
  if (read.demo?.command !== "tool" || read.other?.command !== "other") return [`${adapter.id} readMcp lost a merged server`];
  const same = adapter.mergeMcp(second.text, "demo", { command: "tool", args: ["--a"] });
  if (same.status !== "unchanged" || same.text !== second.text) return [`${adapter.id} identical server was rewritten`];
  const conflict = adapter.mergeMcp(second.text, "demo", { command: "other-tool", args: [] });
  if (conflict.status !== "conflict") return [`${adapter.id} different command was not a conflict`];
  return [...checkReplace(adapter, second.text), ...checkEnv(adapter, second.text)];
}

/** Replacing one entry changes that entry only; a missing entry is a conflict, never a silent add. */
function checkReplace(adapter: HostAdapter, text: string): string[] {
  const replaced = adapter.replaceMcp(text, "demo", { command: "tool-v2", args: ["--b"] });
  if (replaced.status !== "merged") return [`${adapter.id} existing server was not replaced`];
  const read = adapter.readMcp(replaced.text);
  if (read.demo?.command !== "tool-v2" || read.demo.args[0] !== "--b") return [`${adapter.id} replaceMcp did not write the new entry`];
  if (read.other?.command !== "other" || !replaced.text.includes("keep")) return [`${adapter.id} replaceMcp changed another entry`];
  if (adapter.replaceMcp(replaced.text, "demo", { command: "tool-v2", args: ["--b"] }).status !== "unchanged") return [`${adapter.id} identical replace was rewritten`];
  if (adapter.replaceMcp(text, "missing", { command: "x", args: [] }).status !== "conflict") return [`${adapter.id} replacing a missing server was not a conflict`];
  return [];
}

/** An env reference round-trips through the host file as the host's own syntax; the value never appears. */
function checkEnv(adapter: HostAdapter, text: string): string[] {
  const rendered = hostMcpEntry(adapter, { command: "secret-tool", args: [], env: { API_TOKEN: "${env:CONFORMANCE_TOKEN}" } });
  const merged = adapter.mergeMcp(text, "secret", rendered);
  if (merged.status !== "merged") return [`${adapter.id} env entry was not merged`];
  const read = adapter.readMcp(merged.text).secret;
  if (read === undefined || !sameMcpEntry(read, rendered)) return [`${adapter.id} readMcp did not round-trip the env entry`];
  if (adapter.mergeMcp(merged.text, "secret", rendered).status !== "unchanged") return [`${adapter.id} identical env entry was rewritten`];
  return [];
}
