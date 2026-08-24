import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { initWorkspace, workspaceFile } from "../src/storage/workspace.js";
import { admitAndReserveLeaseCall, getLeaseCallUsage, MAX_LEASE_USAGE_COUNTERS, releaseLatestLeaseCall, reserveLeaseCall } from "../src/storage/lease-usage.js";
import { withWorkspaceLock } from "../src/storage/workspace-lock.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("lease usage locking", () => {
  it("keeps one workspace-lock order when a direct write reservation races a queued usage read", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "stinky-lease-usage-"));
    roots.push(root);
    const workspace = await initWorkspace(root);

    let markHeld!: () => void;
    let allowReservation!: () => void;
    const held = new Promise<void>((resolve) => { markHeld = resolve; });
    const reservationGate = new Promise<void>((resolve) => { allowReservation = resolve; });
    const writer = withWorkspaceLock(workspace, async () => {
      markHeld();
      await reservationGate;
      return reserveLeaseCall(workspace, "lease", 2);
    });

    await held;
    const queuedUsageRead = getLeaseCallUsage(workspace, "lease");
    await new Promise<void>((resolve) => setImmediate(resolve));
    allowReservation();

    const completed = Promise.all([writer, queuedUsageRead]);
    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("lease usage lock-order deadlock")), 2_000));
    await expect(Promise.race([completed, timeout])).resolves.toEqual([{ allowed: true, used: 1 }, 1]);
  });

  it("validates the aggregate schema and rejects invalid lease IDs before every public operation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "stinky-lease-usage-invalid-"));
    roots.push(root);
    const workspace = await initWorkspace(root);
    await writeFile(await workspaceFile(workspace, "lease-usage.json"), JSON.stringify({ "lease-1": -1 }), "utf8");
    await expect(getLeaseCallUsage(workspace, "lease-1")).rejects.toMatchObject({ code: "SCHEMA_INVALID", details: { kind: "lease-usage" } });

    for (const operation of [
      () => getLeaseCallUsage(workspace, "../lease"),
      () => getLeaseCallUsage(workspace, ".lease"),
      () => reserveLeaseCall(workspace, "../lease", 1),
      () => releaseLatestLeaseCall(workspace, "../lease", 1),
      () => admitAndReserveLeaseCall(workspace, "../lease", { taskId: "task", role: "scout", capability: "repository-read" })
    ]) await expect(operation()).rejects.toMatchObject({ code: "LEASE_USAGE_INVALID" });
    await expect(reserveLeaseCall(workspace, "lease", 0)).rejects.toMatchObject({ code: "LEASE_USAGE_INVALID" });
    await expect(releaseLatestLeaseCall(workspace, "lease", 0)).rejects.toMatchObject({ code: "LEASE_USAGE_INVALID" });
  });

  it("bounds durable Lease identities and reclaims only orphaned counters", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "stinky-lease-usage-cap-"));
    roots.push(root);
    const workspace = await initWorkspace(root);
    const state = Object.fromEntries(Array.from({ length: MAX_LEASE_USAGE_COUNTERS }, (_, index) => [
      `lease-cap-${String(index).padStart(4, "0")}`,
      0
    ]));
    await writeFile(await workspaceFile(workspace, "lease-usage.json"), JSON.stringify(state), "utf8");

    await expect(reserveLeaseCall(workspace, "lease-new", 1)).resolves.toEqual({ allowed: true, used: 1 });
    await expect(getLeaseCallUsage(workspace, "lease-new")).resolves.toBe(1);

    const oversized = { ...state, "lease-over-cap": 0 };
    await writeFile(await workspaceFile(workspace, "lease-usage.json"), JSON.stringify(oversized), "utf8");
    await expect(getLeaseCallUsage(workspace, "lease-new"))
      .rejects.toMatchObject({ code: "SCHEMA_INVALID", details: { kind: "lease-usage" } });
  });
});
