import { describe, expect, it } from "vitest";
import { assertReadScope } from "../../../src/gate/mcp/shared.js";
import { asLegacyLease } from "../../helpers/lease.js";

const access = { lease: asLegacyLease({ readScope: ["docs"], taskId: "task", agentId: "agent", role: "scout", capability: "repository-read", level: "L0" as const, workspace: "/workspace", writeSet: [], issuedAt: "2026-01-01T00:00:00Z", expiresAt: "2099-01-01T00:00:00Z", maxToolCalls: 1, status: "active" as const }), taskId: "task", role: "scout", workspace: "/workspace" };

describe("lease readScope", () => {
  it("allows a scoped child path", () => expect(() => assertReadScope(access, "docs/guide.md")).not.toThrow());
  it("rejects a sibling path", () => expect(() => assertReadScope(access, "src/index.ts")).toThrow(/readScope/));
  it("does not treat a prefix as a scope", () => expect(() => assertReadScope(access, "docs-private/a.md")).toThrow(/readScope/));
});
