import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_NAMING_EXEMPTIONS,
  checkIgnored,
  checkNaming,
  checkStructure,
  parseRepoStructure
} from "../../scripts/repo-structure.mjs";

const root = path.resolve(import.meta.dirname, "..", "..");

function tracked(): string[] {
  const output = execFileSync("git", ["-c", "core.quotePath=false", "ls-files", "-z"], { cwd: root, encoding: "utf8" });
  return output.split("\0").filter((item) => item.length > 0);
}

describe("repository structure", () => {
  it("matches STANDARDS §1.2, kebab-case names, and ignoredLocal", () => {
    const paths = tracked();
    const structure = parseRepoStructure(readFileSync(path.join(root, "docs/STANDARDS.md"), "utf8"));
    expect(checkStructure(paths, structure)).toEqual([]);
    expect(checkNaming(paths, DEFAULT_NAMING_EXEMPTIONS)).toEqual([]);
    expect(checkIgnored(readFileSync(path.join(root, ".gitignore"), "utf8"), structure.ignoredLocal)).toEqual([]);
  });
});
