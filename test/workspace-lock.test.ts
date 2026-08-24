import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
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

  it("rejects concurrent sibling reentry while preserving sequential and deeper nesting", async () => {
    const value = await workspace();
    await withWorkspaceLock(value, async () => {
      let release!: () => void;
      let markStarted!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      const started = new Promise<void>((resolve) => { markStarted = resolve; });
      const first = withWorkspaceLock(value, async () => {
        markStarted();
        await held;
        return "first";
      });
      await started;
      const sibling = withWorkspaceLock(value, async () => "sibling");
      release();
      const [firstResult, siblingResult] = await Promise.allSettled([first, sibling]);
      expect(firstResult).toEqual({ status: "fulfilled", value: "first" });
      expect(siblingResult).toMatchObject({
        status: "rejected",
        reason: { code: "WORKSPACE_LOCK_CONCURRENT_REENTRY" }
      });

      await expect(withWorkspaceLock(value, async () => withWorkspaceLock(value, async () => "deep"))).resolves.toBe("deep");
      await expect(withWorkspaceLock(value, async () => "sequential")).resolves.toBe("sequential");
    });
    await expect(withWorkspaceLock(value, async () => "released", { waitMs: 50 })).resolves.toBe("released");
  });

  it("keeps different workspaces independent while one workspace is held", async () => {
    const values = [await workspace(), await workspace()].sort((left, right) => left.directory < right.directory ? -1 : 1);
    const first = values[0]!;
    const second = values[1]!;
    await expect(withWorkspaceLock(first, async () => withWorkspaceLock(second, async () => "other"))).resolves.toBe("other");
  });

  it("keeps the durable holder until an entered unawaited reentry drains", async () => {
    const value = await workspace();
    let releaseChild!: () => void;
    let markChildStarted!: () => void;
    const held = new Promise<void>((resolve) => { releaseChild = resolve; });
    const childStarted = new Promise<void>((resolve) => { markChildStarted = resolve; });
    let child!: Promise<string>;
    const outer = withWorkspaceLock(value, async () => {
      child = withWorkspaceLock(value, async () => {
        markChildStarted();
        await held;
        return "child";
      });
      await childStarted;
      return "outer";
    });

    await childStarted;
    let competitorEntered = false;
    const competitor = withWorkspaceLock(value, async () => {
      competitorEntered = true;
      return "competitor";
    }, { waitMs: 200, pollMs: 5 });
    await new Promise((resolve) => setImmediate(resolve));
    expect(competitorEntered).toBe(false);
    releaseChild();
    await expect(child).resolves.toBe("child");
    await expect(outer).resolves.toBe("outer");
    await expect(competitor).resolves.toBe("competitor");
  });

  it("keeps a parent child active until an unawaited grandchild drains", async () => {
    const value = await workspace();
    let releaseGrandchild!: () => void;
    let markGrandchildStarted!: () => void;
    const held = new Promise<void>((resolve) => { releaseGrandchild = resolve; });
    const grandchildStarted = new Promise<void>((resolve) => { markGrandchildStarted = resolve; });

    await withWorkspaceLock(value, async () => {
      let grandchild!: Promise<string>;
      const child = withWorkspaceLock(value, async () => {
        grandchild = withWorkspaceLock(value, async () => {
          markGrandchildStarted();
          await held;
          return "grandchild";
        });
        await grandchildStarted;
        return "child";
      });
      await grandchildStarted;
      await new Promise((resolve) => setImmediate(resolve));
      await expect(withWorkspaceLock(value, async () => "sibling")).rejects.toMatchObject({ code: "WORKSPACE_LOCK_CONCURRENT_REENTRY" });
      releaseGrandchild();
      await expect(grandchild).resolves.toBe("grandchild");
      await expect(child).resolves.toBe("child");
    });
  });

  it("propagates a slow unawaited child failure and releases for the queued competitor", async () => {
    const value = await workspace();
    const childFailure = new Error("slow child failed");
    let releaseChild!: () => void;
    let markChildStarted!: () => void;
    const held = new Promise<void>((resolve) => { releaseChild = resolve; });
    const childStarted = new Promise<void>((resolve) => { markChildStarted = resolve; });
    let child!: Promise<never>;
    const outer = withWorkspaceLock(value, async () => {
      child = withWorkspaceLock(value, async () => {
        markChildStarted();
        await held;
        throw childFailure;
      });
      await childStarted;
      return "outer";
    });

    await childStarted;
    let competitorEntered = false;
    const competitor = withWorkspaceLock(value, async () => {
      competitorEntered = true;
      return "competitor";
    }, { waitMs: 200, pollMs: 5 });
    await new Promise((resolve) => setImmediate(resolve));
    expect(competitorEntered).toBe(false);
    releaseChild();
    await expect(child).rejects.toBe(childFailure);
    await expect(outer).rejects.toBe(childFailure);
    await expect(competitor).resolves.toBe("competitor");
  });

  it("remembers a fast child failure even when the callback catches it", async () => {
    const value = await workspace();
    const childFailure = new Error("fast child failed");
    const outer = withWorkspaceLock(value, async () => {
      const child = withWorkspaceLock(value, async () => { throw childFailure; });
      await child.catch(() => undefined);
      return "outer";
    });
    await expect(outer).rejects.toBe(childFailure);
    await expect(withWorkspaceLock(value, async () => "released")).resolves.toBe("released");
  });

  it("recursively propagates an unawaited grandchild failure to the root", async () => {
    const value = await workspace();
    const grandchildFailure = new Error("grandchild failed");
    let releaseGrandchild!: () => void;
    let markGrandchildStarted!: () => void;
    const held = new Promise<void>((resolve) => { releaseGrandchild = resolve; });
    const grandchildStarted = new Promise<void>((resolve) => { markGrandchildStarted = resolve; });
    let child!: Promise<string>;
    let grandchild!: Promise<never>;
    const outer = withWorkspaceLock(value, async () => {
      child = withWorkspaceLock(value, async () => {
        grandchild = withWorkspaceLock(value, async () => {
          markGrandchildStarted();
          await held;
          throw grandchildFailure;
        });
        await grandchildStarted;
        return "child";
      });
      await grandchildStarted;
      return "outer";
    });

    await grandchildStarted;
    releaseGrandchild();
    await expect(grandchild).rejects.toBe(grandchildFailure);
    await expect(child).rejects.toBe(grandchildFailure);
    await expect(outer).rejects.toBe(grandchildFailure);
  });

  it("preserves the enclosing operation error after draining a failed child", async () => {
    const value = await workspace();
    const outerFailure = new Error("outer failed");
    const childFailure = new Error("child also failed");
    let releaseChild!: () => void;
    let markChildStarted!: () => void;
    const held = new Promise<void>((resolve) => { releaseChild = resolve; });
    const childStarted = new Promise<void>((resolve) => { markChildStarted = resolve; });
    let child!: Promise<never>;
    const outer = withWorkspaceLock(value, async () => {
      child = withWorkspaceLock(value, async () => {
        markChildStarted();
        await held;
        throw childFailure;
      });
      await childStarted;
      throw outerFailure;
    });

    await childStarted;
    releaseChild();
    await expect(child).rejects.toBe(childFailure);
    await expect(outer).rejects.toBe(outerFailure);
    await expect(withWorkspaceLock(value, async () => "released")).resolves.toBe("released");
  });

  it("rejects a delayed branch inherited from a closed ownership frame", async () => {
    const value = await workspace();
    let releaseLate!: () => void;
    const lateGate = new Promise<void>((resolve) => { releaseLate = resolve; });
    let lateAttempt!: Promise<string>;
    await withWorkspaceLock(value, async () => {
      lateAttempt = lateGate.then(() => withWorkspaceLock(value, async () => "too-late"));
    });
    releaseLate();
    await expect(lateAttempt).rejects.toMatchObject({ code: "WORKSPACE_LOCK_STALE_CONTEXT" });
  });

  it("does not let an old ownership token reenter a newer holder generation", async () => {
    const value = await workspace();
    const ownerPath = await workspaceFile(value, "workspace.lock/owner.json");
    let oldToken = "";
    let releaseOldAttempt!: () => void;
    const oldAttemptGate = new Promise<void>((resolve) => { releaseOldAttempt = resolve; });
    let oldAttempt!: Promise<string>;
    await withWorkspaceLock(value, async () => {
      oldToken = (JSON.parse(await readFile(ownerPath, "utf8")) as { token: string }).token;
      oldAttempt = oldAttemptGate.then(() => withWorkspaceLock(value, async () => "wrong-generation"));
    });

    let releaseCurrent!: () => void;
    let markCurrentStarted!: () => void;
    const currentHeld = new Promise<void>((resolve) => { releaseCurrent = resolve; });
    const currentStarted = new Promise<void>((resolve) => { markCurrentStarted = resolve; });
    let currentToken = "";
    const current = withWorkspaceLock(value, async () => {
      currentToken = (JSON.parse(await readFile(ownerPath, "utf8")) as { token: string }).token;
      markCurrentStarted();
      await currentHeld;
    });
    await currentStarted;
    expect(currentToken).not.toBe(oldToken);
    releaseOldAttempt();
    await expect(oldAttempt).rejects.toMatchObject({ code: "WORKSPACE_LOCK_STALE_CONTEXT" });
    releaseCurrent();
    await current;
  });

  it("merges cross-workspace ownership so A to B to A is a valid reentry", async () => {
    const values = [await workspace(), await workspace()].sort((left, right) => left.directory < right.directory ? -1 : 1);
    const lower = values[0]!;
    const higher = values[1]!;
    await expect(withWorkspaceLock(lower, async () => (
      withWorkspaceLock(higher, async () => withWorkspaceLock(lower, async () => "round-trip"))
    ))).resolves.toBe("round-trip");
  });

  it("fails a reverse multi-root lock order instead of deadlocking", async () => {
    const values = [await workspace(), await workspace()].sort((left, right) => left.directory < right.directory ? -1 : 1);
    const lower = values[0]!;
    const higher = values[1]!;
    let markLowerStarted!: () => void;
    let markHigherStarted!: () => void;
    const lowerStarted = new Promise<void>((resolve) => { markLowerStarted = resolve; });
    const higherStarted = new Promise<void>((resolve) => { markHigherStarted = resolve; });

    const forward = withWorkspaceLock(lower, async () => {
      markLowerStarted();
      await higherStarted;
      return withWorkspaceLock(higher, async () => "forward");
    });
    const reverse = withWorkspaceLock(higher, async () => {
      markHigherStarted();
      await lowerStarted;
      return withWorkspaceLock(lower, async () => "reverse");
    });
    const [forwardResult, reverseResult] = await Promise.allSettled([forward, reverse]);
    expect(forwardResult).toEqual({ status: "fulfilled", value: "forward" });
    expect(reverseResult).toMatchObject({
      status: "rejected",
      reason: { code: "WORKSPACE_LOCK_ORDER_VIOLATION" }
    });
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
    const malformed = JSON.stringify({ version: 1, token: "bad", pid: process.pid, createdAt: old, heartbeatAt: old, extra: true });
    await writeFile(owner, malformed, { mode: 0o600 });
    await expect(withWorkspaceLock(value, async () => "busy", { waitMs: 20, pollMs: 5, staleMs: 10 })).rejects.toMatchObject({ code: "WORKSPACE_LOCK_BUSY" });
    expect(await readFile(owner, "utf8")).toBe(malformed);
  });

  it("never reclaims an ownerless lock automatically, even when its directory is old", async () => {
    const value = await workspace();
    const lock = await workspaceFile(value, "workspace.lock");
    await mkdir(lock, { mode: 0o700 });
    const old = new Date(Date.now() - 120_000);
    await utimes(lock, old, old);

    await expect(withWorkspaceLock(value, async () => "unsafe", { waitMs: 20, pollMs: 5, staleMs: 10 })).rejects.toMatchObject({ code: "WORKSPACE_LOCK_BUSY" });
    await expect(access(lock)).resolves.toBeUndefined();
    await expect(readFile(await workspaceFile(value, "workspace.lock/owner.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never automatically reclaims a stale lock from a dead owner", async () => {
    const value = await workspace();
    const lock = await workspaceFile(value, "workspace.lock");
    await mkdir(lock, { mode: 0o700 });
    const owner = await workspaceFile(value, "workspace.lock/owner.json");
    const old = new Date(Date.now() - 120_000).toISOString();
    await writeFile(owner, JSON.stringify({ version: 1, token: "stale-token", pid: 999999, createdAt: old, heartbeatAt: old }), { mode: 0o600 });
    await expect(withWorkspaceLock(value, async () => "unsafe", { waitMs: 20, pollMs: 5, staleMs: 10 })).rejects.toMatchObject({ code: "WORKSPACE_LOCK_BUSY" });
    expect(JSON.parse(await readFile(owner, "utf8"))).toMatchObject({ token: "stale-token", pid: 999999 });
  });
});
