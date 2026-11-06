import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isDistStale } from "./dist-freshness.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "stinky-dist-freshness-"));
  roots.push(root);
  await mkdir(path.join(root, "src", "nested"), { recursive: true });
  await mkdir(path.join(root, "dist"), { recursive: true });
  await mkdir(path.join(root, "scripts"), { recursive: true });
  await writeFile(path.join(root, "src", "nested", "a.ts"), "export {};\n");
  await writeFile(path.join(root, "tsconfig.json"), "{}\n");
  await writeFile(path.join(root, "package.json"), "{}\n");
  await writeFile(path.join(root, "scripts", "build.mjs"), "export {};\n");
  await writeFile(path.join(root, "scripts", "add-shebang.mjs"), "export {};\n");
  await writeFile(path.join(root, "dist", "cli.js"), "");
  await writeFile(path.join(root, "dist", "mcp-server.js"), "");
  return root;
}

async function touch(target: string, secondsFromNow: number): Promise<void> {
  const when = new Date(Date.now() + secondsFromNow * 1000);
  await utimes(target, when, when);
}

describe("dist freshness guard", () => {
  it("reports stale when a source file is newer than the built entry points", async () => {
    const root = await fixture();
    await touch(path.join(root, "dist", "cli.js"), -120);
    await touch(path.join(root, "dist", "mcp-server.js"), -120);
    await touch(path.join(root, "src", "nested", "a.ts"), -60);
    expect(await isDistStale(root)).toBe(true);
  });

  it("reports stale when a built entry point is missing", async () => {
    const root = await fixture();
    await rm(path.join(root, "dist", "mcp-server.js"));
    expect(await isDistStale(root)).toBe(true);
  });

  it("reports fresh when both entry points are newer than every build input", async () => {
    const root = await fixture();
    for (const input of ["src/nested/a.ts", "tsconfig.json", "package.json", "scripts/build.mjs", "scripts/add-shebang.mjs"]) {
      await touch(path.join(root, input), -120);
    }
    await touch(path.join(root, "dist", "cli.js"), -60);
    await touch(path.join(root, "dist", "mcp-server.js"), -60);
    expect(await isDistStale(root)).toBe(false);
  });
});
