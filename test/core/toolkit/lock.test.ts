import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { buildToolkitLock, parseToolkitLock } from "../../../src/core/toolkit/lock.js";
import type { ToolkitSpec } from "../../../src/core/toolkit/spec.js";

const remote = "git+https://example.invalid/skills.git";

function spec(): ToolkitSpec {
  return {
    version: 1,
    skills: [
      { id: "review", source: "/tmp/review" },
      { id: "remote-skill", source: remote }
    ],
    mcpServers: [],
    instructions: [{ id: "missing-notes", source: "/tmp/missing.md" }],
    bundles: []
  };
}

describe("toolkit lock", () => {
  it("hashes a local body and does not lock a remote source even when a body is supplied", () => {
    const body = "review the diff\n";
    const lock = buildToolkitLock(spec(), {
      skills: { review: body, "remote-skill": "should-not-be-hashed\n" },
      instructions: {}
    });
    expect(lock.entries.map((entry) => [entry.kind, entry.id, entry.resolved, entry.sha256])).toEqual([
      ["skill", "review", "local", createHash("sha256").update(body).digest("hex")],
      ["skill", "remote-skill", "not-fetched", undefined],
      ["instructions", "missing-notes", "absent", undefined]
    ]);
    expect(lock.entries[1]).not.toHaveProperty("sha256");
    expect(parseToolkitLock(lock)).toEqual(lock);
  });

  it("rejects a content hash on a source that was not fetched", () => {
    expect(() => parseToolkitLock({
      version: 1,
      entries: [{ kind: "skill", id: "remote-skill", source: remote, resolved: "not-fetched", sha256: "ab".repeat(32) }]
    })).toThrowError(expect.objectContaining({ code: "TOOLKIT_LOCK_INVALID" }));
  });

  it("does not import a network client", async () => {
    const source = await readFile(new URL("../../../src/core/toolkit/lock.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/node:https?|node:net|undici|fetch\(/);
  });
});
