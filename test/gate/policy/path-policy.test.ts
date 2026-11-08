import { describe, expect, it } from "vitest";
import { isSensitivePath } from "../../../src/gate/policy/path-policy.js";

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
  it("matches custom sensitive paths case-insensitively for common cross-platform filesystems", () => {
    expect(isSensitivePath("INTERNAL/roadmap.md", ["internal/"])).toBe(true);
    expect(isSensitivePath("internal/roadmap.md", ["INTERNAL"])).toBe(true);
  });
  it("matches canonically equivalent Unicode custom sensitive paths in both directions", () => {
    const nfc = "docs/caf\u00e9";
    const nfd = "docs/cafe\u0301";
    expect(isSensitivePath(`${nfd}/private.md`, [nfc])).toBe(true);
    expect(isSensitivePath(`${nfc}/private.md`, [nfd])).toBe(true);
  });
  it("does not false-positive on ordinary names", () => {
    for (const value of ["author.md", "keyboard.ts", "authentication.md", "notes.txt", "authored/readme.md"]) {
      expect(isSensitivePath(value), value).toBe(false);
    }
  });
});
