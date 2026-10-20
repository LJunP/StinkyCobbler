import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeBounded, type BoundaryFs } from "../../src/io/fs-boundary.js";
import * as nodeFs from "node:fs/promises";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function pathText(value: Parameters<typeof nodeFs.rename>[0]): string {
  if (typeof value !== "string") throw new Error("fs-boundary test expected a string path.");
  return value;
}

async function tempDir(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

describe("writeBounded", () => {
  it("throws PATH_DENIED and does not write when an ancestor is a symlink to outside the workspace", async () => {
    const workspace = await tempDir("stinky-bounded-ws-");
    const outside = await tempDir("stinky-bounded-out-");
    await mkdir(path.join(workspace, "docs"));
    await rm(path.join(workspace, "docs"), { recursive: true });
    await symlink(outside, path.join(workspace, "docs"));

    await expect(writeBounded(workspace, "docs/guide.md", "pwned\n", { mode: 0o600, fsync: true }))
      .rejects.toMatchObject({ code: "PATH_DENIED" });

    await expect(readFile(path.join(outside, "guide.md"), "utf8")).rejects.toThrow();
  });

  it("fsyncs the file before rename and the parent directory after rename", async () => {
    const workspace = await tempDir("stinky-bounded-order-");
    await mkdir(path.join(workspace, "docs"));
    const events: string[] = [];
    const fs: BoundaryFs = {
      lstat: nodeFs.lstat,
      mkdir: nodeFs.mkdir,
      rm: nodeFs.rm,
      rename: async (from, to) => {
        events.push(`rename:${path.basename(pathText(to))}`);
        await nodeFs.rename(from, to);
      },
      open: async (file, flags, mode) => {
        const opened = pathText(file);
        const handle = await nodeFs.open(opened, flags, mode);
        const sync = handle.sync.bind(handle);
        handle.sync = async () => {
          events.push(`sync:${path.basename(opened)}`);
          await sync();
        };
        return handle;
      }
    };

    await writeBounded(workspace, "docs/guide.md", "hello\n", { mode: 0o600, fsync: true, fs });

    expect(await readFile(path.join(workspace, "docs", "guide.md"), "utf8")).toBe("hello\n");
    const syncFile = events.findIndex((event) => event.startsWith("sync:.guide.md."));
    const renameIndex = events.indexOf("rename:guide.md");
    const syncDir = events.lastIndexOf("sync:docs");
    expect(syncFile).toBeGreaterThanOrEqual(0);
    expect(renameIndex).toBeGreaterThan(syncFile);
    expect(syncDir).toBeGreaterThan(renameIndex);
  });
});
