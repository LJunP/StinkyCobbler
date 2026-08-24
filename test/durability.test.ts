import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { syncDirectory } from "../src/storage/durability.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("directory durability boundary", () => {
  it("skips unsupported directory fsync on Windows without touching the path", async () => {
    const missing = path.join(os.tmpdir(), "stinky-missing-directory");
    await expect(syncDirectory(missing, "win32")).resolves.toBeUndefined();
  });

  it("does not swallow path failures on platforms that support directory fsync", async () => {
    const missing = path.join(os.tmpdir(), "stinky-missing-directory");
    await expect(syncDirectory(missing, "linux")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.runIf(process.platform !== "win32")("fsyncs an existing directory on supported hosts", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "stinky-directory-sync-"));
    roots.push(root);
    await expect(syncDirectory(root)).resolves.toBeUndefined();
  });
});
