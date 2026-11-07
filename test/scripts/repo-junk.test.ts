import { describe, expect, it } from "vitest";
import { checkJunk } from "../../scripts/repo-junk.mjs";

const MIB = 1024 * 1024;

function entry(path: string, text: string, size = text.length) {
  return { path, size, text };
}

describe("junk size", () => {
  it("rejects a tracked file larger than 1 MiB", () => {
    expect(checkJunk([{ path: "src/huge.ts", size: MIB + 1 }])).toEqual(["src/huge.ts is larger than 1 MiB"]);
  });
});

describe("junk task tags", () => {
  it("rejects an ownerless TODO", () => {
    expect(checkJunk([entry("src/a.ts", "TODO fix\n")])).toEqual(["src/a.ts: ownerless TODO"]);
  });

  it("accepts TODO(owner): with a kebab-case owner", () => {
    expect(checkJunk([entry("src/a.ts", "TODO(release-bot): later\n")])).toEqual([]);
  });

  it("rejects FIXME and a non-kebab owner", () => {
    expect(checkJunk([entry("docs/a.md", "FIXME\n")])).toEqual(["docs/a.md: ownerless FIXME"]);
    expect(checkJunk([entry("src/a.ts", "TODO(Platform): later\n")])).toEqual(["src/a.ts: ownerless TODO"]);
  });

  it("rejects a markdown list item TODO, an XXX tag, and FIXME with an owner", () => {
    expect(checkJunk([entry("docs/a.md", "- TODO: write\n")])).toEqual(["docs/a.md: ownerless TODO"]);
    expect(checkJunk([entry("docs/a.md", "1. FIXME(me): still\n")])).toEqual(["docs/a.md: ownerless FIXME"]);
    expect(checkJunk([entry("scripts/a.mjs", `${"//"} XXX hack\n`)])).toEqual(["scripts/a.mjs: ownerless XXX"]);
  });

  it("ignores task tags under docs/archive", () => {
    expect(checkJunk([entry("docs/archive/old.md", "TODO\n")])).toEqual([]);
  });

  it("rejects a task tag written as a comment", () => {
    const text = `${"//"} TODO later\n`;
    expect(checkJunk([entry("test/a.test.ts", text)])).toEqual(["test/a.test.ts: ownerless TODO"]);
  });
});

describe("junk console", () => {
  it("rejects console.log outside the presenter", () => {
    expect(checkJunk([entry("src/core/a.ts", "console.log(1)\n")])).toEqual([
      "src/core/a.ts: console.log is outside the presenter"
    ]);
    expect(checkJunk([entry("src/io/a.ts", "console.debug(1)\n")])).toEqual([
      "src/io/a.ts: console.debug is outside the presenter"
    ]);
    expect(checkJunk([entry("src/hosts/a.ts", "console.info(1)\n")])).toEqual([
      "src/hosts/a.ts: console.info is outside the presenter"
    ]);
  });

  it("allows console in app, cli, mcp-server, and gate", () => {
    expect(checkJunk([entry("src/app/a.ts", "console.log(1)\n")])).toEqual([]);
    expect(checkJunk([entry("src/cli.ts", "console.info(1)\n")])).toEqual([]);
    expect(checkJunk([entry("src/mcp-server.ts", "console.debug(1)\n")])).toEqual([]);
    expect(checkJunk([entry("src/gate/a.ts", "console.log(1)\n")])).toEqual([]);
  });
});

describe("junk resource paths", () => {
  it("rejects a resources segment outside src/io/resources.ts", () => {
    expect(checkJunk([entry("src/app/a.ts", 'path.join("resources", "gate")\n')])).toEqual([
      'src/app/a.ts: resource path literal "resources"'
    ]);
    expect(checkJunk([entry("src/core/a.ts", 'path.join(root, "schemas")\n')])).toEqual([
      'src/core/a.ts: resource path literal "schemas"'
    ]);
    expect(checkJunk([entry("src/core/a.ts", 'const p = "resources/gate/skills"\n')])).toEqual([
      'src/core/a.ts: resource path literal "resources/"'
    ]);
  });

  it("rejects .codex outside src/hosts and allows it there", () => {
    expect(checkJunk([entry("src/app/a.ts", 'const dir = ".codex",\n')])).toEqual([
      'src/app/a.ts: resource path literal ".codex"'
    ]);
    expect(checkJunk([entry("src/io/a.ts", 'path.join(home, ".zcode", "commands")\n')])).toEqual([
      'src/io/a.ts: resource path literal ".zcode"'
    ]);
    expect(checkJunk([entry("src/hosts/codex.ts", 'presenceDirectory: ".codex",\n')])).toEqual([]);
  });

  it("rejects .codex before a closing parenthesis and ignores segment words outside path calls", () => {
    expect(checkJunk([entry("src/app/a.ts", 'path.join(home, ".codex")\n')])).toEqual([
      'src/app/a.ts: resource path literal ".codex"'
    ]);
    expect(checkJunk([entry("src/core/kinds.ts", 'export const KINDS = ["skills", "packs"] as const;\nif (k === "packs") {}\n')])).toEqual([]);
  });

  it("still rejects a resources literal in src/hosts", () => {
    expect(checkJunk([entry("src/hosts/codex.ts", 'path.join("resources", "gate")\n')])).toEqual([
      'src/hosts/codex.ts: resource path literal "resources"'
    ]);
  });

  it("allows the central module and gateResourceRelative arguments", () => {
    const central = 'return path.join("resources", "gate", ...segments);\n';
    expect(checkJunk([entry("src/io/resources.ts", central)])).toEqual([]);
    const call = 'bundledSkillTemplate: gateResourceRelative("skills", "codex", "SKILL.md"),\n';
    expect(checkJunk([entry("src/hosts/codex.ts", call)])).toEqual([]);
  });

  it("allows the host skill directory and the user policy directory", () => {
    expect(checkJunk([entry("src/hosts/cursor.ts", 'path.join(base, "skills")\n')])).toEqual([]);
    expect(checkJunk([entry("src/io/tiered-config.ts", 'path.join(home, "policies", fileName)\n')])).toEqual([]);
    expect(checkJunk([entry("src/app/a.ts", 'path.join(home, "policies", fileName)\n')])).toEqual([
      'src/app/a.ts: resource path literal "policies"'
    ]);
  });
});
