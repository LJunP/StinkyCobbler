import { S_IWUSR } from "node:constants";
import { chmod, mkdtemp, open, readdir, readFile, rm, stat, writeFile, type FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { copyFileDurably, publishFileDurably, removeFileDurably, syncDirectory, syncFile } from "../src/storage/durability.js";

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
  // Windows chmod only toggles the read-only attribute, and stat then reports
  // 0o444 or 0o666. Compare against the mode this test just observed, and use
  // S_IWUSR for writability. POSIX hosts still require the exact chmod mode.
  async function fileWithMode(mode: number): Promise<string> {
    const root = await mkdtemp(path.join(os.tmpdir(), "stinky-file-sync-"));
    roots.push(root);
    const file = path.join(root, "notes.md");
    await writeFile(file, "hello\n");
    await chmod(file, mode);
    return file;
  }

  async function modeBits(file: string): Promise<number> {
    return (await stat(file)).mode & 0o777;
  }

  function expectHostMode(actual: number, posixMode: number, writable: boolean): void {
    if (process.platform === "win32") {
      expect(actual & S_IWUSR).toBe(writable ? S_IWUSR : 0);
      return;
    }
    expect(actual).toBe(posixMode);
  }

  // syncFile calls handle.sync(). A real "r" flush is EPERM on Windows, so simulated platforms get a fake.
  function idleHandle(): FileHandle {
    return {
      sync: async () => undefined,
      close: async () => undefined
    } as unknown as FileHandle;
  }

  it("opens read-only on POSIX and read-write on Windows", async () => {
    const file = await fileWithMode(0o644);
    const before = await modeBits(file);
    expectHostMode(before, 0o644, true);

    const flags: string[] = [];
    const record = async (_target: string, flag: "r" | "r+"): Promise<FileHandle> => {
      flags.push(flag);
      return idleHandle();
    };

    await syncFile(file, "linux", record);
    expect(flags).toEqual(["r"]);
    flags.length = 0;
    await syncFile(file, "win32", record);
    expect(flags).toEqual(["r+"]);
    const after = await modeBits(file);
    expect(after).toBe(before);
    expectHostMode(after, 0o644, true);
  });

  it("clears a Windows read-only attribute only around the flush and leaves POSIX mode 0400 untouched", async () => {
    const file = await fileWithMode(0o400);
    const before = await modeBits(file);
    expectHostMode(before, 0o400, false);
    const flags: string[] = [];

    await syncFile(file, "win32", async (target, flag) => {
      flags.push(flag);
      expect((await modeBits(target)) & S_IWUSR).toBe(S_IWUSR);
      return open(target, flag);
    });
    expect(flags).toEqual(["r+"]);
    const restored = await modeBits(file);
    expect(restored).toBe(before);
    expectHostMode(restored, 0o400, false);

    flags.length = 0;
    await syncFile(file, "linux", async (target, flag) => {
      flags.push(flag);
      expect((await modeBits(target)) & S_IWUSR).toBe(0);
      if (process.platform === "win32") return idleHandle();
      return open(target, flag);
    });
    expect(flags).toEqual(["r"]);
    const untouched = await modeBits(file);
    expect(untouched).toBe(before);
    expectHostMode(untouched, 0o400, false);
  });

  it("propagates fsync failures on POSIX and Windows, and restores a Windows read-only attribute", async () => {
    const writable = await fileWithMode(0o644);
    const readOnly = await fileWithMode(0o400);
    const writableBefore = await modeBits(writable);
    const readOnlyBefore = await modeBits(readOnly);
    expectHostMode(writableBefore, 0o644, true);
    expectHostMode(readOnlyBefore, 0o400, false);

    const failSync = async (): Promise<FileHandle> => ({
      sync: async () => {
        throw Object.assign(new Error("sync failed"), { code: "EIO" });
      },
      close: async () => undefined
    }) as unknown as FileHandle;

    await expect(syncFile(writable, "linux", async () => failSync())).rejects.toMatchObject({ code: "EIO" });
    await expect(syncFile(writable, "win32", async () => failSync())).rejects.toMatchObject({ code: "EIO" });
    const writableAfter = await modeBits(writable);
    expect(writableAfter).toBe(writableBefore);
    expectHostMode(writableAfter, 0o644, true);

    await expect(syncFile(readOnly, "win32", async () => failSync())).rejects.toMatchObject({ code: "EIO" });
    const readOnlyAfter = await modeBits(readOnly);
    expect(readOnlyAfter).toBe(readOnlyBefore);
    expectHostMode(readOnlyAfter, 0o400, false);

    await expect(syncFile(path.join(path.dirname(writable), "missing"), "linux")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(syncFile(path.join(path.dirname(writable), "missing"), "win32")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
