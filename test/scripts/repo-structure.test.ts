import { describe, expect, it } from "vitest";
import {
  DEFAULT_NAMING_EXEMPTIONS,
  checkIgnored,
  checkNaming,
  checkStructure,
  parseRepoStructure
} from "../../scripts/repo-structure.mjs";

const markdown = [
  "```yaml repo-structure",
  "rootDirs: [src, scripts]",
  "rootFiles: [README.md]",
  "ignoredLocal: [dist, node_modules]",
  "managed:",
  "  src: [core, \"*.ts\"]",
  "  scripts: [\"*.mjs\"]",
  "```",
  ""
].join("\n");

describe("repo structure parsers", () => {
  const structure = parseRepoStructure(markdown);

  it("rejects a stray root file", () => {
    expect(checkStructure(["NOTES.txt"], structure)).toEqual(["root file not allowed: NOTES.txt"]);
  });

  it("rejects a stray first-level entry under src", () => {
    expect(checkStructure(["src/utils/index.ts"], structure)).toEqual(["managed entry not allowed: src/utils"]);
  });

  it("rejects a stray root directory, a tracked ignoredLocal path, and a wrong extension", () => {
    expect(checkStructure(["tools/x.sh"], structure)).toEqual(["root directory not allowed: tools"]);
    expect(checkStructure(["dist/cli.js"], structure)).toEqual(["tracked ignoredLocal path: dist/cli.js", "root directory not allowed: dist"]);
    expect(checkStructure(["scripts/notes.txt"], structure)).toEqual(["managed entry not allowed: scripts/notes.txt"]);
  });

  it("accepts a clean tree", () => {
    const tracked = ["README.md", "src/core/a.ts", "src/cli.ts", "scripts/build.mjs"];
    expect(checkStructure(tracked, structure)).toEqual([]);
    expect(checkNaming(tracked, DEFAULT_NAMING_EXEMPTIONS)).toEqual([]);
  });

  it("throws when the repo-structure block is missing", () => {
    expect(() => parseRepoStructure("# no whitelist\n")).toThrow("missing ```yaml repo-structure block");
  });
});

describe("repo naming", () => {
  it("rejects a CamelCase segment", () => {
    expect(checkNaming(["src/CamelCase.ts"], DEFAULT_NAMING_EXEMPTIONS)).toEqual([
      'src/CamelCase.ts has a non-kebab-case segment "CamelCase.ts"'
    ]);
  });

  it("allows GitHub-mandated names under .github", () => {
    expect(checkNaming([".github/ISSUE_TEMPLATE/bug_report.yml"], DEFAULT_NAMING_EXEMPTIONS)).toEqual([]);
  });

  it("rejects SKILL.md outside resources/gate/skills", () => {
    expect(checkNaming(["docs/SKILL.md"], DEFAULT_NAMING_EXEMPTIONS)).toEqual([
      'docs/SKILL.md has a non-kebab-case segment "SKILL.md"'
    ]);
    expect(checkNaming(["resources/gate/skills/codex/SKILL.md"], DEFAULT_NAMING_EXEMPTIONS)).toEqual([]);
  });

  it("uses the exemptions object the caller passes", () => {
    const strict = { ...DEFAULT_NAMING_EXEMPTIONS, conventionalNames: [] };
    expect(checkNaming(["README.md"], strict)).toEqual(['README.md has a non-kebab-case segment "README.md"']);
  });
});

describe("ignoredLocal coverage", () => {
  it("rejects a missing .gitignore entry", () => {
    expect(checkIgnored("node_modules/\n# dist\n", ["dist"])).toEqual([
      'ignoredLocal entry "dist" is not covered by .gitignore'
    ]);
  });

  it("accepts the exact name, name/, and /name/ forms", () => {
    expect(checkIgnored("dist\nnode_modules/\n/.DS_Store/\n", ["dist", "node_modules", ".DS_Store"])).toEqual([]);
  });
});
