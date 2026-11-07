import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkJunk } from "../../scripts/repo-junk.mjs";

const root = path.resolve(import.meta.dirname, "..", "..");
const TEXT = new Set([".ts", ".mjs", ".cjs", ".js", ".json", ".md", ".yml", ".yaml"]);
const MIB = 1024 * 1024;

describe("repository junk", () => {
  it("finds no oversized files, ownerless tasks, stray console calls, or resource literals", () => {
    const output = execFileSync("git", ["-c", "core.quotePath=false", "ls-files", "-z"], { cwd: root, encoding: "utf8" });
    const entries = output.split("\0").filter((file) => file.length > 0).map((file) => {
      const size = statSync(path.join(root, file)).size;
      const text = size <= MIB && TEXT.has(path.posix.extname(file)) ? readFileSync(path.join(root, file), "utf8") : undefined;
      return { path: file, size, text };
    });
    expect(checkJunk(entries)).toEqual([]);
  });
});
