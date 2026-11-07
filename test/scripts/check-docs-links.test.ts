import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkLinks, collectLinks, slugsOf } from "../../scripts/check-docs-links.mjs";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function writeTree(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "doc-links-"));
  roots.push(root);
  for (const [name, text] of Object.entries(files)) {
    const absolute = path.join(root, name);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, text);
  }
  return root;
}

describe("document links", () => {
  it("reports a missing file and strips a trailing title", () => {
    const root = writeTree({ "a.md": '[gone](missing.md "nope")\n' });
    expect(checkLinks(root, ["a.md"])).toEqual(["a.md -> missing.md (missing file)"]);
  });

  it("reports a missing anchor", () => {
    const root = writeTree({ "b.md": "# 存在\n\n[x](#不存在)\n" });
    expect(checkLinks(root, ["b.md"])).toEqual(["b.md -> #不存在 (missing anchor)"]);
  });

  it("reports a missing anchor in another file and ignores a link inside inline code", () => {
    const root = writeTree({ "e.md": "[x](other.md#missing) and `[y](gone.md)`\n", "other.md": "# here\n" });
    expect(checkLinks(root, ["e.md", "other.md"])).toEqual(["e.md -> other.md#missing (missing anchor)"]);
  });

  it("resolves root-relative links and ignores HTML comments and indented fences", () => {
    const root = writeTree({
      "docs/f.md": ["[root](/README.md)", "<!-- [x](gone.md) -->", "- item", "", "    ```md", "    [y](gone.md)", "    ```", ""].join("\n"),
      "README.md": "# readme\n"
    });
    expect(checkLinks(root, ["docs/f.md"])).toEqual([]);
  });

  it("accepts a short setext underline", () => {
    expect(slugsOf("B\n==\n")).toEqual(["b"]);
  });

  it("resolves a Chinese heading anchor", () => {
    const root = writeTree({ "c.md": "# 正式发布门禁\n\n[门禁](#正式发布门禁)\n" });
    expect(checkLinks(root, ["c.md"])).toEqual([]);
  });

  it("ignores a link inside a code fence", () => {
    const root = writeTree({
      "d.md": ["```md", "[x](missing.md)", "```", "# 真实", "[ok](#真实)", ""].join("\n")
    });
    expect(collectLinks(readFence())).toEqual(["#真实"]);
    expect(checkLinks(root, ["d.md"])).toEqual([]);
  });

  it("builds GitHub slugs, including duplicates and stripped punctuation", () => {
    const markdown = [
      "## 2.5 严格规定与规则（防屎山宪法）",
      "## 3.4 下一版本（3.0.0-alpha.1）逐任务细则",
      "# 中文标题",
      "# 中文标题"
    ].join("\n");
    expect(slugsOf(markdown)).toEqual([
      "25-严格规定与规则防屎山宪法",
      "34-下一版本300-alpha1逐任务细则",
      "中文标题",
      "中文标题-1"
    ]);
  });
});

function readFence(): string {
  return ["```md", "[x](missing.md)", "```", "# 真实", "[ok](#真实)", ""].join("\n");
}
