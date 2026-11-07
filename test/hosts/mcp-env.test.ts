import { parse } from "smol-toml";
import { describe, expect, it } from "vitest";
import { hostMcpEntry } from "../../src/hosts/host-adapter.js";
import { claudeCodeHost } from "../../src/hosts/claude-code.js";
import { codexHost } from "../../src/hosts/codex.js";
import { cursorHost } from "../../src/hosts/cursor.js";
import { zcodeHost } from "../../src/hosts/zcode.js";

const entry = { command: "npx", args: ["-y", "server"], env: { API_TOKEN: "${env:FS_TOKEN}", CERT: "${file:/etc/cert.pem}" } };

describe("mcp env rendering", () => {
  it("writes the documented ${env:NAME} syntax for Cursor", () => {
    const merged = cursorHost.mergeMcp("", "fs", hostMcpEntry(cursorHost, entry));
    expect(merged.status).toBe("merged");
    const written = JSON.parse(merged.status === "merged" ? merged.text : "{}") as { mcpServers: { fs: { env?: Record<string, string> } } };
    expect(written.mcpServers.fs.env).toEqual({ API_TOKEN: "${env:FS_TOKEN}" });
  });

  it("writes the documented ${VAR} syntax for Claude Code", () => {
    const merged = claudeCodeHost.mergeMcp("", "fs", hostMcpEntry(claudeCodeHost, entry));
    expect(merged.status).toBe("merged");
    const text = merged.status === "merged" ? merged.text : "";
    expect((JSON.parse(text) as { mcpServers: { fs: { env?: Record<string, string> } } }).mcpServers.fs.env).toEqual({ API_TOKEN: "${FS_TOKEN}" });
    expect(text).not.toContain("${env:");
  });

  it("forwards the referenced variable names through env_vars for Codex and stores no value", () => {
    const merged = codexHost.mergeMcp("", "fs", hostMcpEntry(codexHost, entry));
    expect(merged.status).toBe("merged");
    const text = merged.status === "merged" ? merged.text : "";
    const parsed = parse(text) as { mcp_servers: { fs: { env?: unknown; env_vars?: string[] } } };
    expect(parsed.mcp_servers.fs.env_vars).toEqual(["FS_TOKEN"]);
    expect(parsed.mcp_servers.fs.env).toBeUndefined();
    expect(text).not.toContain("${");
  });

  it("writes no env for ZCode because its expansion is undocumented", () => {
    const merged = zcodeHost.mergeMcp("", "fs", hostMcpEntry(zcodeHost, entry));
    expect(merged.status).toBe("merged");
    const text = merged.status === "merged" ? merged.text : "";
    expect(text).not.toContain("env");
    expect(text).not.toContain("FS_TOKEN");
  });

  it.each([cursorHost, claudeCodeHost, codexHost, zcodeHost])("$id reads back what it wrote and treats a changed env as a conflict", (host) => {
    const rendered = hostMcpEntry(host, entry);
    const merged = host.mergeMcp("", "fs", rendered);
    const text = merged.status === "merged" ? merged.text : "";
    expect(host.readMcp(text).fs).toEqual(rendered);
    expect(host.mergeMcp(text, "fs", rendered).status).toBe("unchanged");
    const changed = hostMcpEntry(host, { ...entry, env: { API_TOKEN: "${env:OTHER_TOKEN}" } });
    expect(host.mergeMcp(text, "fs", changed).status).toBe(host.documentedEnvExpansion === "unknown" ? "unchanged" : "conflict");
  });
});
