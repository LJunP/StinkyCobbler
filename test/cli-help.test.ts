import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(import.meta.dirname, "..");

/** Top-level 2.x governance commands. `entry` installs host skills and stays current; `toolkit` is the 3.x product. */
const GOVERNANCE_COMMANDS = [
  "validate",
  "recommend",
  "doctor",
  "config",
  "init",
  "task",
  "approval",
  "evidence",
  "receipt",
  "runtime",
  "audit",
  "ledger",
  "lease",
  "plan",
  "write",
  "orchestration"
] as const;

const TOOLKIT_COMMANDS = ["init", "plan", "apply", "rollback", "doctor", "list", "lock", "update", "search", "memory"];

async function cliHelp(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(process.execPath, ["--import", "tsx", path.join(projectRoot, "src/cli.ts"), ...args], {
    cwd: projectRoot,
    env: process.env
  });
  return stdout;
}

function commandBlurbs(help: string): Map<string, string> {
  const section = help.split("\nCommands:\n")[1] ?? "";
  const blurbs = new Map<string, string>();
  for (const block of section.split(/\n(?= {2}\S)/)) {
    const name = /^ {2}(\S+)/.exec(block)?.[1];
    if (name === undefined) continue;
    const body = block
      .slice(name.length + 2)
      .replace(/^\s*\[options\]/, "")
      .replace(/^\s*<[^>\n]+>/, "")
      .replace(/\s+/g, " ")
      .trim();
    blurbs.set(name, body);
  }
  return blurbs;
}

describe("cli help identity", () => {
  it("describes a toolkit package manager on --help", async () => {
    const preamble = (await cliHelp("--help")).split("\nCommands:\n")[0] ?? "";
    expect(preamble).toContain("toolkit package manager");
    expect(preamble).toContain("plan");
    expect(preamble).toContain("apply");
    expect(preamble).toContain("rollback");
    expect(preamble).toContain("Codex");
    expect(preamble).toContain("Claude Code");
    expect(preamble).toContain("Cursor");
    expect(preamble).toContain("ZCode");
    expect(preamble).not.toContain("control plane");
  });

  it("prefixes each 2.x governance command and leaves the host entry command current", async () => {
    const blurbs = commandBlurbs(await cliHelp("--help"));
    for (const name of GOVERNANCE_COMMANDS) {
      expect(blurbs.get(name), name).toMatch(/^\[deprecated 2\.x\] /);
    }
    expect(blurbs.get("entry")).toBe("Unified /stinky-cobbler entry: read-only preflight and explicit host installation.");
    expect(blurbs.get("toolkit")).toBe("Plan and apply a declarative agent toolkit.");
  });

  it("keeps toolkit help free of the 2.x deprecation label", async () => {
    const help = await cliHelp("toolkit", "--help");
    expect(help).toContain("Plan and apply a declarative agent toolkit.");
    expect(help).not.toContain("[deprecated 2.x]");
    const names = [...commandBlurbs(help).keys()].filter((name) => name !== "help");
    expect(names).toEqual(TOOLKIT_COMMANDS);
  });
});
