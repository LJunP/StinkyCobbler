import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SchemaRegistry } from "../src/contracts/schema-registry.js";
import { createTask } from "../src/storage/tasks.js";
import { initWorkspace } from "../src/storage/workspace.js";
import { issueLease, getLease, listLeases, revokeLease } from "../src/storage/leases.js";
import { listLedgerEntries } from "../src/storage/ledger.js";
import { evaluateLease } from "../src/policy/evaluate.js";
import type { TaskCharter } from "../src/contracts/types.js";

const roots: string[] = [];
const projectRoot = path.resolve(import.meta.dirname, "..");
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function setup(task: TaskCharter = { id: "lease-task", workspaceId: "workspace-1", goal: "Read workspace", requestedOutputs: ["report"], riskLevel: "L0", state: "SCOPED" }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "stinky-lease-"));
  roots.push(root);
  const workspace = await initWorkspace(root);
  await createTask(workspace, task);
  return { workspace, schemas: await SchemaRegistry.create(projectRoot) };
}

describe("lease issuance", () => {
  it("issues a user-confirmed read-only L0 lease with defaults and persists it", async () => {
    const { workspace, schemas } = await setup();
    const lease = await issueLease(workspace, schemas, { taskId: "lease-task", agentId: "agent-1", role: "scout", capability: "repository-read" });
    expect(lease).toMatchObject({
      taskId: "lease-task",
      agentId: "agent-1",
      role: "scout",
      capability: "repository-read",
      level: "L0",
      writeSet: [],
      readScope: ["."],
      maxToolCalls: 20,
      status: "active",
      issuedBy: "user-confirmed"
    });
    expect(lease.id).toMatch(/^lease-/);
    expect(Date.parse(lease.expiresAt) - Date.parse(lease.issuedAt)).toBe(60 * 60_000);
    await expect(getLease(workspace, lease.id)).resolves.toEqual(lease);
    await expect(listLeases(workspace)).resolves.toEqual([lease]);
    const events = (await listLedgerEntries(workspace)).map((entry) => entry.event);
    expect(events).toEqual(["lease-issued"]);
  });

  it("honors explicit parameter overrides", async () => {
    const { workspace, schemas } = await setup();
    const lease = await issueLease(workspace, schemas, {
      taskId: "lease-task",
      agentId: "agent-1",
      role: "reviewer",
      capability: "git-read",
      readScope: ["docs/", "src/"],
      maxToolCalls: 5,
      expiresInMinutes: 10,
      issuedBy: "explicit-user"
    });
    expect(lease).toMatchObject({ role: "reviewer", capability: "git-read", readScope: ["docs/", "src/"], maxToolCalls: 5, issuedBy: "explicit-user" });
    expect(Date.parse(lease.expiresAt) - Date.parse(lease.issuedAt)).toBe(10 * 60_000);
    const decision = evaluateLease(lease, { taskId: "lease-task", role: "reviewer", workspace: workspace.root, capability: "git-read" });
    expect(decision.allowed).toBe(true);
  });

  it("rejects leases for tasks that are not persisted", async () => {
    const { workspace, schemas } = await setup();
    await expect(issueLease(workspace, schemas, { taskId: "missing-task", agentId: "agent-1", role: "scout", capability: "repository-read" })).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
  });

  it("rejects capabilities outside the read-only allowlist", async () => {
    const { workspace, schemas } = await setup();
    await expect(issueLease(workspace, schemas, { taskId: "lease-task", agentId: "agent-1", role: "scout", capability: "secret-read" })).rejects.toMatchObject({ code: "LEASE_CAPABILITY_DENIED" });
    await expect(issueLease(workspace, schemas, { taskId: "lease-task", agentId: "agent-1", role: "scout", capability: "test-run" })).rejects.toMatchObject({ code: "LEASE_CAPABILITY_DENIED" });
  });

  it("rejects unsafe read scopes", async () => {
    const { workspace, schemas } = await setup();
    for (const readScope of [[".stinky-cobbler"], ["/etc"], ["../outside"], ["docs/../escape"], [""]]) {
      await expect(issueLease(workspace, schemas, { taskId: "lease-task", agentId: "agent-1", role: "scout", capability: "repository-read", readScope })).rejects.toMatchObject({ code: "LEASE_READ_SCOPE_INVALID" });
    }
  });

  it("rejects out-of-range limits", async () => {
    const { workspace, schemas } = await setup();
    await expect(issueLease(workspace, schemas, { taskId: "lease-task", agentId: "agent-1", role: "scout", capability: "repository-read", maxToolCalls: 0 })).rejects.toMatchObject({ code: "LEASE_MAX_TOOL_CALLS_INVALID" });
    await expect(issueLease(workspace, schemas, { taskId: "lease-task", agentId: "agent-1", role: "scout", capability: "repository-read", maxToolCalls: 101 })).rejects.toMatchObject({ code: "LEASE_MAX_TOOL_CALLS_INVALID" });
    await expect(issueLease(workspace, schemas, { taskId: "lease-task", agentId: "agent-1", role: "scout", capability: "repository-read", expiresInMinutes: 0 })).rejects.toMatchObject({ code: "LEASE_EXPIRES_IN_INVALID" });
    await expect(issueLease(workspace, schemas, { taskId: "lease-task", agentId: "agent-1", role: "scout", capability: "repository-read", expiresInMinutes: 1441 })).rejects.toMatchObject({ code: "LEASE_EXPIRES_IN_INVALID" });
  });

  it("revokes a lease, audits it, and makes evaluateLease fail closed", async () => {
    const { workspace, schemas } = await setup();
    const lease = await issueLease(workspace, schemas, { taskId: "lease-task", agentId: "agent-1", role: "scout", capability: "repository-read" });
    const revoked = await revokeLease(workspace, lease.id, "No longer needed.");
    expect(revoked).toMatchObject({ status: "revoked" });
    await expect(revokeLease(workspace, lease.id, "Again.")).resolves.toEqual(revoked);
    const decision = evaluateLease(revoked, { taskId: "lease-task", role: "scout", workspace: workspace.root, capability: "repository-read" });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe("LEASE_NOT_ACTIVE");
    const events = (await listLedgerEntries(workspace)).map((entry) => entry.event);
    expect(events).toEqual(["lease-issued", "lease-revoked"]);
  });
});
