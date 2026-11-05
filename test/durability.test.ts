import { chmod, mkdtemp, open, readdir, readFile, rm, stat, writeFile, type FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { copyFileDurably, publishFileDurably, removeFileDurably, syncDirectory, syncFile } from "../src/gate/storage/durability.js";

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

describe("durable business-file publication", () => {
  async function temporaryRoot(): Promise<string> {
    const root = await mkdtemp(path.join(os.tmpdir(), "stinky-durable-publish-"));
    roots.push(root);
    return root;
  }

  it("publishes bytes atomically with a private mode and leaves no temporary file behind", async () => {
    const root = await temporaryRoot();
    const target = path.join(root, "notes.md");
    await publishFileDurably(target, "hello\n", { mode: 0o600 });
    expect(await readFile(target, "utf8")).toBe("hello\n");
    if (process.platform !== "win32") expect((await stat(target)).mode & 0o777).toBe(0o600);
    expect(await readdir(root)).toEqual(["notes.md"]);
  });

  it("replaces an existing target and still leaves a single file", async () => {
    const root = await temporaryRoot();
    const target = path.join(root, "notes.md");
    await writeFile(target, "old\n");
    await publishFileDurably(target, Buffer.from("new\n"));
    expect(await readFile(target, "utf8")).toBe("new\n");
    expect(await readdir(root)).toEqual(["notes.md"]);
  });

  it("copies exclusively and refuses to overwrite an existing destination", async () => {
    const root = await temporaryRoot();
    await writeFile(path.join(root, "source"), "bytes\n");
    await copyFileDurably(path.join(root, "source"), path.join(root, "backup"));
    expect(await readFile(path.join(root, "backup"), "utf8")).toBe("bytes\n");
    await expect(copyFileDurably(path.join(root, "source"), path.join(root, "backup"))).rejects.toMatchObject({ code: "EEXIST" });
  });

  it.runIf(process.platform !== "win32")("copies an owner-read-only source without needing write permission on the copy", async () => {
    const root = await temporaryRoot();
    const source = path.join(root, "readonly.md");
    await writeFile(source, "locked\n");
    await chmod(source, 0o400);
    await copyFileDurably(source, path.join(root, "backup"));
    expect(await readFile(path.join(root, "backup"), "utf8")).toBe("locked\n");
  });

  it("removes a file and tolerates an already-missing target", async () => {
    const root = await temporaryRoot();
    const target = path.join(root, "gone");
    await writeFile(target, "x");
    await removeFileDurably(target);
    await expect(stat(target)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(removeFileDurably(target)).resolves.toBeUndefined();
  });
});

describe("file fsync open flags", () => {
  async function fileWithMode(mode: number): Promise<string> {
    const root = await mkdtemp(path.join(os.tmpdir(), "stinky-file-sync-"));
    roots.push(root);
    const file = path.join(root, "notes.md");
    await writeFile(file, "hello\n");
    await chmod(file, mode);
    return file;
  }

  it("opens read-only on POSIX and read-write on Windows", async () => {
    const file = await fileWithMode(0o644);
    const flags: string[] = [];
    const record = async (target: string, flag: "r" | "r+") => {
      flags.push(flag);
      return open(target, flag);
    };

    await syncFile(file, "linux", record);
    expect(flags).toEqual(["r"]);
    flags.length = 0;
    await syncFile(file, "win32", record);
    expect(flags).toEqual(["r+"]);
    expect((await stat(file)).mode & 0o777).toBe(0o644);
  });

  it("clears a Windows read-only attribute only around the flush and leaves POSIX mode 0400 untouched", async () => {
    const file = await fileWithMode(0o400);
    const flags: string[] = [];

    await syncFile(file, "win32", async (target, flag) => {
      flags.push(flag);
      expect((await stat(target)).mode & 0o200).not.toBe(0);
      return open(target, flag);
    });
    expect(flags).toEqual(["r+"]);
    expect((await stat(file)).mode & 0o777).toBe(0o400);

    flags.length = 0;
    await syncFile(file, "linux", async (target, flag) => {
      flags.push(flag);
      expect((await stat(target)).mode & 0o200).toBe(0);
      return open(target, flag);
    });
    expect(flags).toEqual(["r"]);
    expect((await stat(file)).mode & 0o777).toBe(0o400);
  });

  it("propagates fsync failures on POSIX and Windows, and restores a Windows read-only attribute", async () => {
    const writable = await fileWithMode(0o644);
    const readOnly = await fileWithMode(0o400);
    const failSync = async (): Promise<FileHandle> => ({
      sync: async () => {
        throw Object.assign(new Error("sync failed"), { code: "EIO" });
      },
      close: async () => undefined
    }) as unknown as FileHandle;

    await expect(syncFile(writable, "linux", async () => failSync())).rejects.toMatchObject({ code: "EIO" });
    await expect(syncFile(writable, "win32", async () => failSync())).rejects.toMatchObject({ code: "EIO" });
    expect((await stat(writable)).mode & 0o777).toBe(0o644);
    await expect(syncFile(readOnly, "win32", async () => failSync())).rejects.toMatchObject({ code: "EIO" });
    expect((await stat(readOnly)).mode & 0o777).toBe(0o400);
    await expect(syncFile(path.join(path.dirname(writable), "missing"), "linux")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(syncFile(path.join(path.dirname(writable), "missing"), "win32")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
