import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { initWorkspace, workspaceFile } from "../src/storage/workspace.js";
import { withWorkspaceLock } from "../src/storage/workspace-lock.js";

const projectRoot = path.resolve(import.meta.dirname, "..");
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function workspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), "stinky-lock-"));
  roots.push(root);
  return initWorkspace(root);
}

describe("durable workspace lock", () => {
  it("serializes a real child-process holder and rejects another process while held", async () => {
    const value = await workspace();
    const child = execFile(process.execPath, ["--import", "tsx", path.join(projectRoot, "test/workspace-lock-child.ts"), value.root, "hold"], { cwd: projectRoot });
    await new Promise<void>((resolve, reject) => {
      child.stdout?.once("data", () => resolve());
      child.once("error", reject);
    });
    await expect(withWorkspaceLock(value, async () => "no", { waitMs: 40, pollMs: 5 })).rejects.toMatchObject({ code: "WORKSPACE_LOCK_BUSY" });
    child.stdin?.end("release\n");
    await new Promise<void>((resolve, reject) => { child.once("exit", () => resolve()); child.once("error", reject); });
    await expect(withWorkspaceLock(value, async () => "acquired", { waitMs: 100, pollMs: 5 })).resolves.toBe("acquired");
  }, 15_000);

  it("supports reentrant operations and releases after errors", async () => {
    const value = await workspace();
    const result = await withWorkspaceLock(value, async () => withWorkspaceLock(value, async () => "ok"));
    expect(result).toBe("ok");
    await expect(withWorkspaceLock(value, async () => "again", { waitMs: 50 })).resolves.toBe("again");
  });

  it("serializes unrelated same-process operations and continues after rejection", async () => {
    const value = await workspace();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const order: string[] = [];
    const first = withWorkspaceLock(value, async () => { order.push("first-start"); await held; order.push("first-end"); throw new Error("first failed"); });
    await new Promise((resolve) => setImmediate(resolve));
    const second = withWorkspaceLock(value, async () => { order.push("second"); return "second-ok"; }, { waitMs: 50, pollMs: 5 });
    release();
    await expect(first).rejects.toThrow("first failed");
    await expect(second).resolves.toBe("second-ok");
    expect(order).toEqual(["first-start", "first-end", "second"]);
  });

  it("rejects invalid lock timing options", async () => {
    const value = await workspace();
    await expect(withWorkspaceLock(value, async () => "no", { waitMs: 0 })).rejects.toMatchObject({ code: "WORKSPACE_LOCK_OPTION_INVALID" });
    await expect(withWorkspaceLock(value, async () => "no", { pollMs: Number.NaN })).rejects.toMatchObject({ code: "WORKSPACE_LOCK_OPTION_INVALID" });
    await expect(withWorkspaceLock(value, async () => "no", { staleMs: -1 })).rejects.toMatchObject({ code: "WORKSPACE_LOCK_OPTION_INVALID" });
  });

  it("does not reclaim malformed or live owner metadata", async () => {
    const value = await workspace();
    const lock = await workspaceFile(value, "workspace.lock");
    await mkdir(lock, { mode: 0o700 });
    const owner = await workspaceFile(value, "workspace.lock/owner.json");
    const old = new Date(Date.now() - 120_000).toISOString();
    await writeFile(owner, JSON.stringify({ version: 1, token: "bad", pid: process.pid, createdAt: old, heartbeatAt: old, extra: true }), { mode: 0o600 });
    await expect(withWorkspaceLock(value, async () => "busy", { waitMs: 20, pollMs: 5, staleMs: 10 })).rejects.toMatchObject({ code: "WORKSPACE_LOCK_BUSY" });
  });

  it("reclaims an owner record only when the owner process is gone and stale", async () => {
    const value = await workspace();
    const lock = await workspaceFile(value, "workspace.lock");
    await mkdir(lock, { mode: 0o700 });
    const owner = await workspaceFile(value, "workspace.lock/owner.json");
    const old = new Date(Date.now() - 120_000).toISOString();
    await writeFile(owner, JSON.stringify({ version: 1, token: "stale-token", pid: 999999, createdAt: old, heartbeatAt: old }), { mode: 0o600 });
    await expect(withWorkspaceLock(value, async () => "recovered", { waitMs: 20, pollMs: 5, staleMs: 10 })).resolves.toBe("recovered");
  });
});
