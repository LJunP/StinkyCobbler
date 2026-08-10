import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";

describe("ZCode skill contract", () => {
  it("requires a human choice and preserves governance classifications", async () => {
    const skill = await readFile(path.resolve(import.meta.dirname, "../.zcode/skills/stinky-cobbler/SKILL.md"), "utf8");
    expect(skill).toContain("never make the choice");
    expect(skill).toContain("FACT");
    expect(skill).toContain("DECISION");
    expect(skill).toContain("PROPOSAL");
    expect(skill).toContain("UNKNOWN");
    expect(skill).toContain("never writes business files");
  });
});
