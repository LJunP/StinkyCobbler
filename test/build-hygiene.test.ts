import { afterEach, describe, expect, it } from "vitest";
import { access, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildProject } from "../scripts/build.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "stinky-build-"));
  roots.push(root);
  return root;
}

async function fakeCompile({ output }: { root: string; output: string }): Promise<void> {
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, "cli.js"), "console.log('cli');\n", "utf8");
  await writeFile(path.join(output, "mcp-server.js"), "console.log('mcp');\n", "utf8");
  await mkdir(path.join(output, "storage"));
  await writeFile(path.join(output, "storage", "current.js"), "export {};\n", "utf8");
}

describe("release build hygiene", () => {
  it("keeps both bin entries executable through source links after rebuilding", async () => {
    const root = await temporaryRoot();
    const entries = [["cli.js", "cli"], ["mcp-server.js", "mcp"]] as const;
    // POSIX npm installs expose bin symlinks; Windows uses npm-generated shims,
    // covered by package smoke, so here Windows checks the rebuilt entry bytes.
    for (const [name] of entries) {
      if (process.platform !== "win32") await symlink(path.join(root, "dist", name), path.join(root, name));
    }
    for (let generation = 0; generation < 2; generation += 1) {
      await buildProject({ root, compile: fakeCompile });
      for (const [name, expected] of entries) {
        const entry = path.join(root, "dist", name);
        if (process.platform !== "win32") {
          expect((await lstat(entry)).mode & 0o777).toBe(0o755);
        }
        const result = process.platform === "win32"
          ? await execFileAsync(process.execPath, [entry])
          : await execFileAsync(path.join(root, name), []);
        expect(result.stdout.trim()).toBe(expected);
      }
    }
  });

  it("replaces dist after a successful fresh build and removes stale compiler outputs", async () => {
    const root = await temporaryRoot();
    await mkdir(path.join(root, "dist", "mcp"), { recursive: true });
    await writeFile(path.join(root, "dist", "mcp", "orphan.js"), "stale\n", "utf8");

    await buildProject({ root, compile: fakeCompile });

    await expect(access(path.join(root, "dist", "mcp", "orphan.js"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(root, "dist", "cli.js"), "utf8")).toMatch(/^#!\/usr\/bin\/env node\n/);
    expect(await readFile(path.join(root, "dist", "mcp-server.js"), "utf8")).toMatch(/^#!\/usr\/bin\/env node\n/);
    await expect(access(path.join(root, "dist", "storage", "current.js"))).resolves.toBeUndefined();
  });

  it("preserves the prior dist when compilation fails", async () => {
    const root = await temporaryRoot();
    await mkdir(path.join(root, "dist"));
    await writeFile(path.join(root, "dist", "known-good.js"), "old\n", "utf8");

    await expect(buildProject({ root, compile: async ({ output }: { output: string }) => {
      await writeFile(path.join(output, "partial.js"), "partial\n", "utf8");
      throw new Error("compiler failed");
    } })).rejects.toThrow("compiler failed");

    expect(await readFile(path.join(root, "dist", "known-good.js"), "utf8")).toBe("old\n");
    await expect(access(path.join(root, "dist", "partial.js"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a symlinked dist without touching its target", async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    await writeFile(path.join(outside, "keep.txt"), "keep\n", "utf8");
    await symlink(outside, path.join(root, "dist"));

    await expect(buildProject({ root, compile: fakeCompile })).rejects.toMatchObject({ code: "BUILD_OUTPUT_UNSAFE" });
    expect((await lstat(path.join(root, "dist"))).isSymbolicLink()).toBe(true);
    expect(await readFile(path.join(outside, "keep.txt"), "utf8")).toBe("keep\n");
  });
});
