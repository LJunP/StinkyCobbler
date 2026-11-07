import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkLinks } from "../../scripts/check-docs-links.mjs";

const root = path.resolve(import.meta.dirname, "..", "..");

describe("repository document links", () => {
  it("resolves every relative link in tracked markdown and yml", () => {
    const output = execFileSync("git", ["-c", "core.quotePath=false", "ls-files", "-z"], { cwd: root, encoding: "utf8" });
    const files = output.split("\0").filter((file) => file.endsWith(".md") || file.endsWith(".yml"));
    expect(checkLinks(root, files)).toEqual([]);
  });
});
