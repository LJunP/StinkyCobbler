import { describe, expect, it } from "vitest";
import { validateRoleTools, KNOWN_TOOLS } from "../src/config/registry.js";
import type { RoleRegistry } from "../src/contracts/types.js";

const roles: RoleRegistry = { version: 1, roles: { scout: { displayName: "侦察", category: "discovery", defaultLevel: "L0", canWrite: false }, reviewer: { displayName: "审查", category: "review", defaultLevel: "L0", canWrite: false } } };

describe("role tools mapping validation", () => {
  it("accepts a valid mapping with known tools", () => {
    expect(() => validateRoleTools({ scout: ["repository-read", "repository-list"], reviewer: ["git-read"] }, roles, KNOWN_TOOLS)).not.toThrow();
  });

  it("rejects unknown roles", () => {
    expect(() => validateRoleTools({ ghost: ["repository-read"] }, roles, KNOWN_TOOLS)).toThrow(/unknown role/);
  });

  it("rejects unknown tools", () => {
    expect(() => validateRoleTools({ scout: ["repository-delete"] }, roles, KNOWN_TOOLS)).toThrow(/unknown tool/);
  });

  it("rejects duplicate tools", () => {
    expect(() => validateRoleTools({ scout: ["repository-read", "repository-read"] }, roles, KNOWN_TOOLS)).toThrow(/duplicate tool/);
  });
});
