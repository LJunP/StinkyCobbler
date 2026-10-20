import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// The file system is the boundary under test: record the order of fsync and
// publish operations so a crash between them cannot leave an un-synced rename.
const events: string[] = [];
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    open: async (...args: Parameters<typeof original.open>) => {
      const handle = await original.open(...args);
      const sync = handle.sync.bind(handle);
      handle.sync = async () => { events.push(`sync:${path.basename(String(args[0]))}`); await sync(); };
      return handle;
    },
    rename: async (from: string, to: string) => { events.push(`rename:${path.basename(to)}`); await original.rename(from, to); },
    rm: async (...args: Parameters<typeof original.rm>) => { events.push(`rm:${path.basename(String(args[0]))}`); await original.rm(...args); },
    copyFile: async (...args: Parameters<typeof original.copyFile>) => { events.push(`copy:${path.basename(String(args[1]))}`); await original.copyFile(...args); }
  };
});

const { copyFileDurably, publishFileDurably, removeFileDurably } = await import("../src/gate/storage/durability.js");

const roots: string[] = [];
afterEach(async () => { events.length = 0; await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe.runIf(process.platform !== "win32")("durable publication ordering", () => {
  it("fsyncs the temporary file before renaming it over the target, then fsyncs the directory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "stinky-durable-order-")); roots.push(root);
    await publishFileDurably(path.join(root, "notes.md"), "hello\n");
    const syncTemp = events.findIndex((event) => event.startsWith("sync:.notes.md."));
    const renameIndex = events.indexOf("rename:notes.md");
    const syncDir = events.lastIndexOf(`sync:${path.basename(root)}`);
    expect(syncTemp).toBeGreaterThanOrEqual(0);
    expect(renameIndex).toBeGreaterThan(syncTemp);
    expect(syncDir).toBeGreaterThan(renameIndex);
  });

  it("fsyncs a copied backup and its directory after copying", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "stinky-durable-order-")); roots.push(root);
    await publishFileDurably(path.join(root, "source"), "bytes\n");
    events.length = 0;
    await copyFileDurably(path.join(root, "source"), path.join(root, "backup"));
    expect(events.indexOf("copy:backup")).toBeLessThan(events.indexOf("sync:backup"));
    expect(events.indexOf("sync:backup")).toBeLessThan(events.lastIndexOf(`sync:${path.basename(root)}`));
  });

  it("fsyncs the directory after removing a file", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "stinky-durable-order-")); roots.push(root);
    await publishFileDurably(path.join(root, "gone"), "x");
    events.length = 0;
    await removeFileDurably(path.join(root, "gone"));
    expect(events.indexOf("rm:gone")).toBeLessThan(events.lastIndexOf(`sync:${path.basename(root)}`));
  });
});
