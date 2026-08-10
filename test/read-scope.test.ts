import { describe, expect, it } from "vitest";
import { assertReadScope } from "../src/mcp/shared.js";
import { isSensitivePath } from "../src/policy/path-policy.js";

const access = { lease: { readScope: ["docs"], taskId: "task", agentId: "agent", role: "scout", capability: "repository-read", level: "L0" as const, workspace: "/workspace", writeSet: [], issuedAt: "2026-01-01T00:00:00Z", expiresAt: "2099-01-01T00:00:00Z", maxToolCalls: 1, status: "active" as const }, taskId: "task", role: "scout", workspace: "/workspace" };

describe("lease readScope", () => {
  it("allows a scoped child path", () => expect(() => assertReadScope(access, "docs/guide.md")).not.toThrow());
  it("rejects a sibling path", () => expect(() => assertReadScope(access, "src/index.ts")).toThrow(/readScope/));
  it("does not treat a prefix as a scope", () => expect(() => assertReadScope(access, "docs-private/a.md")).toThrow(/readScope/));
});

describe("sensitive path names", () => {
  it("rejects credential-bearing names", () => {
    for (const value of [".npmrc", "netrc", "keyring", "auth.json", ".envrc", ".pypirc", "config.npmrc", "secrets.json", ".env.local"]) {
      expect(isSensitivePath(value), value).toBe(true);
    }
  });
  it("rejects credential-bearing extensions", () => {
    for (const value of ["terraform.tfstate", "state.tfstate", "creds.pypirc"]) {
      expect(isSensitivePath(value), value).toBe(true);
    }
  });
  it("does not false-positive on ordinary names", () => {
    for (const value of ["author.md", "keyboard.ts", "authentication.md", "notes.txt", "authored/readme.md"]) {
      expect(isSensitivePath(value), value).toBe(false);
    }
  });
});
