import { mkdtemp, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { SchemaRegistry } from "../src/contracts/schema-registry.js";
import { createWorkspaceConfig, loadWorkspaceConfig } from "../src/config/workspace.js";
import { loadRegistries } from "../src/config/registry.js";
import { invokeControlled, isWorkspaceAuditDegraded, type ControlledInvocationDependencies } from "../src/mcp/invocation.js";
import { initWorkspace, openWorkspace, workspaceFile, type LocalWorkspace } from "../src/storage/workspace.js";
import { mkdir, writeFile } from "node:fs/promises";
import { createTask } from "../src/storage/tasks.js";
import { getLeaseCallUsage, reserveLeaseCall } from "../src/storage/lease-usage.js";
import { recordReceipt } from "../src/storage/receipts.js";
import { appendLedgerEntry } from "../src/storage/ledger.js";
import { evaluateLease } from "../src/policy/evaluate.js";
import { listPendingAudits } from "../src/storage/audit-service.js";
import { createAuditOutbox, updateAuditOutbox } from "../src/storage/audit-outbox.js";
import { createPlan, confirmPlan, executePlan, beginStep } from "../src/storage/plans.js";
import { requestWrites, confirmWrites } from "../src/storage/write-intents.js";
import { requestApproval, decideApproval } from "../src/storage/approvals.js";
import { issueLease } from "../src/storage/leases.js";
import { readFile } from "node:fs/promises";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const projectRoot = path.resolve(import.meta.dirname, "..");

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "stinky-mcp-")); roots.push(root);
  const workspace = await initWorkspace(root);
  await createWorkspaceConfig(workspace, {
    version: 2,
    workspaceId: "workspace",
    root: workspace.root,
    profile: "team",
    packs: ["software-engineering"],
    mode: "reviewed-workflow",
    roles: {},
    plugins: {}
  });
  await createTask(workspace, { id: "task", workspaceId: "workspace", goal: "Read", requestedOutputs: [], riskLevel: "L0", state: "DRAFT" });
  return { root, workspace, schemas: await SchemaRegistry.create(projectRoot) };
}
function lease(workspace: string, patch: Record<string, unknown> = {}) { return { id: "lease", taskId: "task", agentId: "agent", role: "scout", capability: "repository-read", level: "L0", workspace, readScope: ["."], writeSet: [], issuedAt: "2026-01-01T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z", maxToolCalls: 1, status: "active", ...patch }; }

const dependencies: ControlledInvocationDependencies = {
  openWorkspace,
  getLeaseCallUsage,
  reserveLeaseCall,
  evaluateLease,
  recordReceipt,
  listPendingAudits,
  appendLedgerEntry,
  loadWorkspaceConfig: async (workspace: LocalWorkspace, schemas: SchemaRegistry) => {
    const registries = await loadRegistries(projectRoot, schemas);
    await loadWorkspaceConfig(workspace, schemas, registries);
  }
};

describe("controlled MCP invocation", () => {
  it("fails closed before lease reservation when workspace.json is missing or malformed", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "stinky-mcp-uninitialized-")); roots.push(root);
    const workspace = await initWorkspace(root);
    let called = false;
    const result = await invokeControlled((await SchemaRegistry.create(projectRoot)), { lease: lease(root), taskId: "task", role: "scout", workspace: root }, "repository-read", async () => { called = true; return { decision: { allowed: true, code: "ALLOWED", reasons: [], policyVersion: "1" } }; }, dependencies);
    expect(result).toMatchObject({ decision: { code: "WORKSPACE_NOT_INITIALIZED" } });
    expect(called).toBe(false);
    await expect(getLeaseCallUsage(workspace, "lease")).resolves.toBe(0);
    await mkdir(await workspaceFile(workspace, "workspace.json"));
    const malformed = await invokeControlled((await SchemaRegistry.create(projectRoot)), { lease: lease(root), taskId: "task", role: "scout", workspace: root }, "repository-read", async () => { called = true; return { decision: { allowed: true, code: "ALLOWED", reasons: [], policyVersion: "1" } }; }, dependencies);
    expect(malformed).toMatchObject({ decision: { code: "WORKSPACE_NOT_INITIALIZED" } });
    await rm(await workspaceFile(workspace, "workspace.json"), { recursive: true, force: true });
    await writeFile(await workspaceFile(workspace, "workspace.json"), "not-json", "utf8");
    const invalid = await invokeControlled((await SchemaRegistry.create(projectRoot)), { lease: lease(root), taskId: "task", role: "scout", workspace: root }, "repository-read", async () => { called = true; return { decision: { allowed: true, code: "ALLOWED", reasons: [], policyVersion: "1" } }; }, dependencies);
    expect(invalid).toMatchObject({ decision: { code: "WORKSPACE_NOT_INITIALIZED" } });
    expect(called).toBe(false);
  });
  it("fails closed before lease reservation when the workspace config fails schema admission", async () => {
    const { root, workspace, schemas } = await setup();
    await writeFile(await workspaceFile(workspace, "workspace.json"), JSON.stringify({ version: 3, workspaceId: "workspace", root: workspace.root, profile: "team", packs: ["software-engineering"], mode: "reviewed-workflow", roles: {}, plugins: {} }), "utf8");
    let called = false;
    const result = await invokeControlled(
      schemas,
      { lease: lease(root), taskId: "task", role: "scout", workspace: root },
      "repository-read",
      async () => {
        called = true;
        return { decision: { allowed: true, code: "ALLOWED", reasons: [], policyVersion: "1" } };
      },
      dependencies
    );
    expect(result).toMatchObject({ decision: { code: "WORKSPACE_CONFIG_INVALID" } });
    expect(called).toBe(false);
    await expect(getLeaseCallUsage(workspace, "lease")).resolves.toBe(0);
  });
  it("fails closed before lease reservation when the workspace config fails cross-reference admission", async () => {
    const { root, workspace, schemas } = await setup();
    await writeFile(await workspaceFile(workspace, "workspace.json"), JSON.stringify({ version: 2, workspaceId: "workspace", root: workspace.root, profile: "missing-profile", packs: ["software-engineering"], mode: "reviewed-workflow", roles: {}, plugins: {} }), "utf8");
    let called = false;
    const result = await invokeControlled(
      schemas,
      { lease: lease(root), taskId: "task", role: "scout", workspace: root },
      "repository-read",
      async () => {
        called = true;
        return { decision: { allowed: true, code: "ALLOWED", reasons: [], policyVersion: "1" } };
      },
      dependencies
    );
    expect(result).toMatchObject({ decision: { code: "WORKSPACE_CONFIG_INVALID" } });
    const reason = (result as { decision: { reasons: string[] } }).decision.reasons[0];
    expect(reason.length).toBeLessThanOrEqual(200);
    expect(reason).not.toMatch(/[\x00-\x1f]/);
    expect(called).toBe(false);
    await expect(getLeaseCallUsage(workspace, "lease")).resolves.toBe(0);
  });
  it("fails closed on persisted prepared and recovery-required audits before reservation", async () => {
    for (const stage of ["prepared", "recovery-required"] as const) {
      const { root, workspace, schemas } = await setup();
      const outbox = await createAuditOutbox(workspace, {
        callId: `pending-${stage}`,
        taskId: "task",
        role: "scout",
        tool: "repository-read",
        outcome: "completed",
        receiptId: `mcp-pending-${stage}`
      });
      if (stage === "recovery-required") {
        await updateAuditOutbox(workspace, outbox.id, {
          stage,
          attempts: 1,
          errorCode: "AUDIT_PERSISTENCE_FAILED"
        });
      }
      let called = false;
      const result = await invokeControlled(
        schemas,
        { lease: lease(root), taskId: "task", role: "scout", workspace: root },
        "repository-read",
        async () => {
          called = true;
          return { decision: { allowed: true, code: "ALLOWED", reasons: [], policyVersion: "1" } };
        },
        dependencies
      );
      expect(result).toMatchObject({ decision: { code: "AUDIT_PERSISTENCE_FAILED" } });
      expect(called).toBe(false);
      await expect(getLeaseCallUsage(workspace, "lease")).resolves.toBe(0);
    }
  });

  it("fails closed when persisted pending audit state cannot be read", async () => {
    const { root, workspace, schemas } = await setup();
    let called = false;
    const unreadable = {
      ...dependencies,
      listPendingAudits: async () => {
        throw new Error("outbox read failure");
      }
    };
    const result = await invokeControlled(
      schemas,
      { lease: lease(root), taskId: "task", role: "scout", workspace: root },
      "repository-read",
      async () => {
        called = true;
        return { decision: { allowed: true, code: "ALLOWED", reasons: [], policyVersion: "1" } };
      },
      unreadable
    );
    expect(result).toMatchObject({ decision: { code: "AUDIT_PERSISTENCE_FAILED" } });
    expect(called).toBe(false);
    await expect(getLeaseCallUsage(workspace, "lease")).resolves.toBe(0);
  });

  it("rechecks persisted state after a server-process marker and clears a recovered marker", async () => {
    const { root, workspace, schemas } = await setup();
    const failing = { ...dependencies, appendLedgerEntry: async () => { throw new Error("disk failure"); } };
    const first = await invokeControlled(
      schemas,
      { lease: lease(root, { maxToolCalls: 2 }), taskId: "task", role: "scout", workspace: root },
      "repository-read",
      async () => ({ decision: { allowed: true, code: "ALLOWED", reasons: [], policyVersion: "1" } }),
      failing
    );
    expect(first).toMatchObject({ decision: { code: "AUDIT_PERSISTENCE_FAILED" } });
    expect(isWorkspaceAuditDegraded(workspace)).toBe(true);

    const second = await invokeControlled(
      schemas,
      { lease: lease(root, { maxToolCalls: 2 }), taskId: "task", role: "scout", workspace: root },
      "repository-read",
      async () => ({ decision: { allowed: true, code: "ALLOWED", reasons: [], policyVersion: "1" }, data: "recovered" }),
      dependencies
    );
    expect(second).toMatchObject({ data: "recovered" });
    expect(isWorkspaceAuditDegraded(workspace)).toBe(false);
  });
  it("opens an initialized workspace, evaluates before reserving, and records the call", async () => {
    const { root, workspace, schemas } = await setup();
    const result = await invokeControlled(schemas, { lease: lease(root), taskId: "task", role: "scout", workspace: root }, "repository-read", async () => ({ decision: { allowed: true, code: "ALLOWED", reasons: [], policyVersion: "1" }, data: "ok" }), dependencies);
    expect(result).toMatchObject({ data: "ok" });
    await expect(getLeaseCallUsage(workspace, "lease")).resolves.toBe(1);
  });

  it("does not reserve an already rejected lease", async () => {
    const { root, workspace, schemas } = await setup();
    const result = await invokeControlled(schemas, { lease: lease(root, { status: "revoked" }), taskId: "task", role: "scout", workspace: root }, "repository-read", async () => { throw new Error("must not run"); }, dependencies);
    expect(result).toMatchObject({ decision: { code: "LEASE_NOT_ACTIVE" } });
    await expect(getLeaseCallUsage(workspace, "lease")).resolves.toBe(0);
  });

  it("returns a safe error and degrades the workspace if audit persistence fails", async () => {
    const { root, workspace, schemas } = await setup();
    const failing = { ...dependencies, appendLedgerEntry: async () => { throw new Error("disk failure"); } };
    const result = await invokeControlled(schemas, { lease: lease(root), taskId: "task", role: "scout", workspace: root }, "repository-read", async () => ({ decision: { allowed: true, code: "ALLOWED", reasons: [], policyVersion: "1" } }), failing);
    expect(result).toMatchObject({ decision: { code: "AUDIT_PERSISTENCE_FAILED" } });
    expect(isWorkspaceAuditDegraded(workspace)).toBe(true);
  });

  it("runs a confirmed repository write through the full invocation chain", async () => {
    const { root, workspace, schemas } = await setup();
    await writeFile(path.join(root, "notes.md"), "original\n", "utf8");
    const registries = await loadRegistries(projectRoot, schemas);
    const plan = await createPlan(workspace, schemas, registries, { taskId: "task", roles: ["builder"] });
    const planApproval = await requestApproval(workspace, schemas, { taskId: "task", action: "plan-confirm", scope: [plan.planId], reason: "Confirm." });
    await decideApproval(workspace, schemas, planApproval.id, { status: "approved", decidedBy: "user", reason: "Confirmed." });
    await confirmPlan(workspace, plan.planId);
    await executePlan(workspace, plan.planId);
    await beginStep(workspace, schemas, plan.planId, "step-1");
    const intent = await requestWrites(workspace, schemas, plan.planId, "step-1", [{ target: "notes.md", action: "modify", purpose: "Update." }]);
    const writeApproval = await requestApproval(workspace, schemas, { taskId: "task", action: "write-confirm", scope: ["notes.md"], reason: "Confirm." });
    await decideApproval(workspace, schemas, writeApproval.id, { status: "approved", decidedBy: "user", reason: "Confirmed." });
    await confirmWrites(workspace, plan.planId, "step-1", intent.writeIntentId);
    const writeLease = await issueLease(workspace, schemas, { taskId: "task", agentId: "builder-agent", role: "builder", capability: "repository-write", writeSet: ["notes.md"] });
    const { writeRepositoryFile } = await import("../src/mcp/repo-write.js");
    const result = await invokeControlled(
      schemas,
      { lease: writeLease, taskId: "task", role: "builder", workspace: await realpath(root) },
      "repository-write",
      async (access) => writeRepositoryFile(access, schemas, { writeIntentId: intent.writeIntentId, target: "notes.md", content: "updated\n" }),
      dependencies
    );
    expect(result).toMatchObject({ decision: { allowed: true } });
    const stored = await import("node:fs/promises").then(({ readFile: rf }) => rf(path.join(root, "notes.md"), "utf8"));
    expect(stored).toBe("updated\n");
    await expect(getLeaseCallUsage(workspace, writeLease.id)).resolves.toBe(1);
  });

  it("runs a confirmed repository delete through the full invocation chain and backs it up", async () => {
    const { root, workspace, schemas } = await setup();
    await writeFile(path.join(root, "notes.md"), "original\n", "utf8");
    const registries = await loadRegistries(projectRoot, schemas);
    const plan = await createPlan(workspace, schemas, registries, { taskId: "task", roles: ["builder"] });
    const planApproval = await requestApproval(workspace, schemas, { taskId: "task", action: "plan-confirm", scope: [plan.planId], reason: "Confirm." });
    await decideApproval(workspace, schemas, planApproval.id, { status: "approved", decidedBy: "user", reason: "Confirmed." });
    await confirmPlan(workspace, plan.planId);
    await executePlan(workspace, plan.planId);
    await beginStep(workspace, schemas, plan.planId, "step-1");
    const intent = await requestWrites(workspace, schemas, plan.planId, "step-1", [{ target: "notes.md", action: "delete", purpose: "Remove." }]);
    const writeApproval = await requestApproval(workspace, schemas, { taskId: "task", action: "write-confirm", scope: ["notes.md"], reason: "Confirm." });
    await decideApproval(workspace, schemas, writeApproval.id, { status: "approved", decidedBy: "user", reason: "Confirmed." });
    await confirmWrites(workspace, plan.planId, "step-1", intent.writeIntentId);
    const writeLease = await issueLease(workspace, schemas, { taskId: "task", agentId: "builder-agent", role: "builder", capability: "repository-write", writeSet: ["notes.md"] });
    const { deleteRepositoryFile } = await import("../src/mcp/repo-write.js");
    const result = await invokeControlled(
      schemas,
      { lease: writeLease, taskId: "task", role: "builder", workspace: await realpath(root) },
      "repository-write",
      async (access) => deleteRepositoryFile(access, schemas, { writeIntentId: intent.writeIntentId, target: "notes.md" }),
      dependencies
    );
    expect(result).toMatchObject({ decision: { allowed: true } });
    await expect(import("node:fs/promises").then(({ stat }) => stat(path.join(root, "notes.md")))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(getLeaseCallUsage(workspace, writeLease.id)).resolves.toBe(1);
  });

  it("rejects a repository write whose intent is not confirmed without writing", async () => {
    const { root, workspace, schemas } = await setup();
    await writeFile(path.join(root, "notes.md"), "original\n", "utf8");
    const registries = await loadRegistries(projectRoot, schemas);
    const plan = await createPlan(workspace, schemas, registries, { taskId: "task", roles: ["builder"] });
    const planApproval = await requestApproval(workspace, schemas, { taskId: "task", action: "plan-confirm", scope: [plan.planId], reason: "Confirm." });
    await decideApproval(workspace, schemas, planApproval.id, { status: "approved", decidedBy: "user", reason: "Confirmed." });
    await confirmPlan(workspace, plan.planId);
    await executePlan(workspace, plan.planId);
    await beginStep(workspace, schemas, plan.planId, "step-1");
    const intent = await requestWrites(workspace, schemas, plan.planId, "step-1", [{ target: "notes.md", action: "modify", purpose: "Update." }]);
    const writeLease = await issueLease(workspace, schemas, { taskId: "task", agentId: "builder-agent", role: "builder", capability: "repository-write", writeSet: ["notes.md"] });
    const { writeRepositoryFile } = await import("../src/mcp/repo-write.js");
    const result = await invokeControlled(
      schemas,
      { lease: writeLease, taskId: "task", role: "builder", workspace: await realpath(root) },
      "repository-write",
      async (access) => writeRepositoryFile(access, schemas, { writeIntentId: intent.writeIntentId, target: "notes.md", content: "updated\n" }),
      dependencies
    );
    expect(result).toMatchObject({ decision: { code: "INVOCATION_FAILED" } });
    const stored = await import("node:fs/promises").then(({ readFile: rf }) => rf(path.join(root, "notes.md"), "utf8"));
    expect(stored).toBe("original\n");
    await expect(getLeaseCallUsage(workspace, writeLease.id)).resolves.toBe(1);
  });
});
