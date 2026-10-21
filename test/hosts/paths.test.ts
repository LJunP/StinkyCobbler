import path from "node:path";
import { describe, expect, it } from "vitest";
import { claudeCodeHost } from "../../src/hosts/claude-code.js";
import { cursorHost } from "../../src/hosts/cursor.js";
import type { HostRoots } from "../../src/hosts/host-adapter.js";

const roots: HostRoots = { home: path.join("/home", "dev"), cwd: path.join("/work", "repo") };

describe("verified host paths", () => {
  it("points Claude Code at the documented skill, command, instruction, and MCP files", () => {
    expect(claudeCodeHost.locate("skill", "user", roots).path).toBe(path.join(roots.home, ".claude", "skills"));
    expect(claudeCodeHost.locate("skill", "project", roots).path).toBe(path.join(roots.cwd, ".claude", "skills"));
    expect(claudeCodeHost.locate("command", "user", roots).path).toBe(path.join(roots.home, ".claude", "commands"));
    expect(claudeCodeHost.locate("instructions", "project", roots).path).toBe(path.join(roots.cwd, "CLAUDE.md"));
    expect(claudeCodeHost.locate("instructions", "user", roots).path).toBe(path.join(roots.home, ".claude", "CLAUDE.md"));
    expect(claudeCodeHost.locate("mcp-server", "user", roots).path).toBe(path.join(roots.home, ".claude.json"));
    expect(claudeCodeHost.locate("mcp-server", "project", roots).path).toBe(path.join(roots.cwd, ".mcp.json"));
  });

  it("points Cursor at its own skill and MCP files and leaves unverified kinds unsupported", () => {
    expect(cursorHost.locate("skill", "user", roots).path).toBe(path.join(roots.home, ".cursor", "skills"));
    expect(cursorHost.locate("skill", "project", roots).path).toBe(path.join(roots.cwd, ".cursor", "skills"));
    expect(cursorHost.locate("mcp-server", "user", roots).path).toBe(path.join(roots.home, ".cursor", "mcp.json"));
    expect(cursorHost.locate("mcp-server", "project", roots).path).toBe(path.join(roots.cwd, ".cursor", "mcp.json"));
    expect(cursorHost.locate("instructions", "project", roots).path).toBe(path.join(roots.cwd, ".cursor", "rules"));
    expect(cursorHost.locate("instructions", "user", roots).unsupported).toBeTruthy();
    expect(cursorHost.locate("command", "user", roots).unsupported).toBeTruthy();
  });
});
