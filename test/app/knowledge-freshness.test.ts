import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { doctorToolkit, initToolkit } from "../../src/app/toolkit-flow.js";

const roots: string[] = [];
const previous = {
  home: process.env.HOME,
  profile: process.env.USERPROFILE,
  xdg: process.env.XDG_CONFIG_HOME
};

afterEach(async () => {
  restore("HOME", previous.home);
  restore("USERPROFILE", previous.profile);
  restore("XDG_CONFIG_HOME", previous.xdg);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("knowledge freshness", () => {
  it("reports freshness from the server tool response and does not read sources", async () => {
    const xdg = await tempDir("stinky-knowledge-xdg-");
    const home = await tempDir("stinky-knowledge-home-");
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.XDG_CONFIG_HOME = xdg;
    const missing = path.join(xdg, "missing-notes");
    await initToolkit();
    await writeFile(path.join(xdg, "stinky-cobbler", "toolkit.yaml"), spec(missing));
    const report = await doctorToolkit(undefined, [{ serverId: "docs-rag", tool: "index_status", fresh: true }]);
    expect(report.freshness).toEqual([{ serverId: "docs-rag", status: "fresh", tool: "index_status" }]);
    expect(JSON.stringify(report)).not.toContain("knowledge-sentinel-not-an-index");
  });

  it("fails closed when the knowledge server was not queried", async () => {
    const xdg = await tempDir("stinky-knowledge-closed-xdg-");
    const home = await tempDir("stinky-knowledge-closed-home-");
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.XDG_CONFIG_HOME = xdg;
    const notes = path.join(xdg, "notes");
    await writeFile(notes, "knowledge-sentinel-not-an-index\n");
    await initToolkit();
    await writeFile(path.join(xdg, "stinky-cobbler", "toolkit.yaml"), spec(notes));
    const report = await doctorToolkit();
    expect(report.freshness).toEqual([{ serverId: "docs-rag", status: "unavailable" }]);
    expect(JSON.stringify(report)).not.toContain("knowledge-sentinel-not-an-index");
  });
});

function spec(source: string): string {
  return [
    "version: 1",
    "scope: user",
    "skills: []",
    "mcpServers:",
    "  - id: docs-rag",
    "    transport: stdio",
    "    command: cognee-mcp",
    "    role: knowledge",
    "    sources:",
    `      - ${JSON.stringify(source)}`,
    "  - id: filesystem",
    "    transport: stdio",
    "    command: npx",
    "instructions: []",
    "bundles: []",
    ""
  ].join("\n");
}

async function tempDir(prefix: string): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), prefix)));
  roots.push(root);
  return root;
}

function restore(name: "HOME" | "USERPROFILE" | "XDG_CONFIG_HOME", value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
