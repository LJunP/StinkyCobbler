import { mkdtemp, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { SchemaRegistry } from "../src/contracts/schema-registry.js";
import { createWorkspaceConfig, loadWorkspaceConfig } from "../src/config/workspace.js";
import { loadRegistries } from "../src/config/registry.js";
import { injectControlledInvocationFaultForTesting, invokeControlled, isWorkspaceAuditDegraded, type ControlledInvocationDependencies } from "../src/mcp/invocation.js";
import { initWorkspace, openWorkspace, workspaceFile, type LocalWorkspace } from "../src/storage/workspace.js";
import { mkdir, writeFile } from "node:fs/promises";
import { createTask, getTask, saveTask } from "../src/storage/tasks.js";
import { admitAndReserveLeaseCall, getLeaseCallUsage, getLeaseDenialAuditUsage, MAX_AUDITED_LEASE_DENIALS } from "../src/storage/lease-usage.js";
import { listReceipts, recordReceipt } from "../src/storage/receipts.js";
import { appendLedgerEntry, listLedgerEntries } from "../src/storage/ledger.js";
import { listPendingAudits, persistMcpAudit, prepareMcpAudit, recoverMcpAudit } from "../src/storage/audit-service.js";
import { createAuditOutbox, updateAuditOutbox } from "../src/storage/audit-outbox.js";
import { createPlan, confirmPlan, executePlan, beginStep } from "../src/storage/plans.js";
import { requestWrites, confirmWrites } from "../src/storage/write-intents.js";
import { requestApproval, decideApproval } from "../src/storage/approvals.js";
import { issueLease, revokeLease } from "../src/storage/leases.js";
import { addSubtask, beginSubtask, createContract, createRun, dispatchSubtask, recordReview, reportArtifact } from "../src/storage/orchestration.js";
import { readFile } from "node:fs/promises";
import { approvePlanConfirmation, approveTaskCapability, approveWriteIntent } from "./helpers/authority.js";

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
  await createTask(workspace, { id: "task", workspaceId: "workspace", goal: "Read", requestedOutputs: ["report"], riskLevel: "L0", state: "RUNNING", scope: ["."] });
  const schemas = await SchemaRegistry.create(projectRoot);
  const issuedLease = await issueLease(workspace, schemas, { taskId: "task", agentId: "agent", role: "scout", capability: "repository-read", maxToolCalls: 20, expiresInMinutes: 1440 });
  return { root, workspace, schemas, issuedLease };
}

async function authorizeWrite(workspace: LocalWorkspace, schemas: SchemaRegistry, target: string) {
  const current = await getTask(workspace, "task");
  const task = { ...current, state: "RUNNING" as const, scope: ["."], writeSet: [target] };
  await saveTask(workspace, task);
  await approveTaskCapability(workspace, schemas, task, "repository-write", [target]);
}
function lease(workspace: string, patch: Record<string, unknown> = {}) { return { id: "lease", taskId: "task", agentId: "agent", role: "scout", capability: "repository-read", level: "L0", workspace, readScope: ["."], writeSet: [], issuedAt: "2026-01-01T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z", maxToolCalls: 1, status: "active", ...patch }; }

const dependencies: ControlledInvocationDependencies = {
  openWorkspace,
  admitAndReserveLeaseCall,
  recordReceipt,
  listPendingAudits,
  appendLedgerEntry,
  loadWorkspaceConfig: async (workspace: LocalWorkspace, schemas: SchemaRegistry) => {
    const registries = await loadRegistries(projectRoot, schemas);
    await loadWorkspaceConfig(workspace, schemas, registries);
    return registries.roleTools;
  }
};

describe("controlled MCP invocation", () => {
  it("returns a missing-Lease denial without creating caller-controlled durable audit state", async () => {
    const { root, workspace, schemas } = await setup();
    const result = await invokeControlled(
      schemas,
      { leaseId: "lease-missing", taskId: "missing-caller-task", role: "forged-role", workspace: root },
      "repository-read",
      async () => ({ decision: { allowed: true, code: "ALLOWED", reasons: [], policyVersion: "1" } }),
      dependencies
    );

    expect(result).toMatchObject({ decision: { allowed: false, code: "LEASE_NOT_FOUND" } });
    await expect(listPendingAudits(workspace)).resolves.toEqual([]);
    const ledger = await listLedgerEntries(workspace);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ event: "lease-issued", taskId: "task", leaseRef: expect.any(String) });
    await expect(listReceipts(workspace)).resolves.toEqual([]);
  });
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
    const { root, workspace, schemas, issuedLease } = await setup();
    const failing = { ...dependencies, appendLedgerEntry: async () => { throw new Error("disk failure"); } };
    const first = await invokeControlled(
      schemas,
      { lease: issuedLease, taskId: "task", role: "scout", workspace: root },
      "repository-read",
      async () => ({ decision: { allowed: true, code: "ALLOWED", reasons: [], policyVersion: "1" } }),
      failing
    );
    expect(first).toMatchObject({ decision: { code: "AUDIT_PERSISTENCE_FAILED" } });
    expect(isWorkspaceAuditDegraded(workspace)).toBe(true);

    const second = await invokeControlled(
      schemas,
      { lease: issuedLease, taskId: "task", role: "scout", workspace: root },
      "repository-read",
      async () => ({ decision: { allowed: true, code: "ALLOWED", reasons: [], policyVersion: "1" }, data: "recovered" }),
      dependencies
    );
    expect(second).toMatchObject({ data: "recovered" });
    expect(isWorkspaceAuditDegraded(workspace)).toBe(false);
  });
  it("opens an initialized workspace, evaluates before reserving, and records the call", async () => {
    const { root, workspace, schemas, issuedLease } = await setup();
    const result = await invokeControlled(schemas, { lease: issuedLease, taskId: "task", role: "scout", workspace: root }, "repository-read", async () => ({ decision: { allowed: true, code: "ALLOWED", reasons: [], policyVersion: "1" }, data: "ok" }), dependencies);
    expect(result).toMatchObject({ data: "ok" });
    await expect(getLeaseCallUsage(workspace, issuedLease.id)).resolves.toBe(1);
  });

  it("persists an unknown audit marker before reservation and capability execution", async () => {
    const { root, workspace, schemas, issuedLease } = await setup();
    let ran = false;
    const durable = { ...dependencies, prepareAudit: prepareMcpAudit, audit: persistMcpAudit };
    injectControlledInvocationFaultForTesting(workspace, "after-audit-prepare");
    const interrupted = await invokeControlled(
      schemas,
      { leaseId: issuedLease.id, taskId: "task", role: "scout", workspace: root },
      "repository-read",
      async () => { ran = true; return { decision: { allowed: true, code: "ALLOWED", reasons: [], policyVersion: "1" } }; },
      durable
    );
    expect(interrupted).toMatchObject({ decision: { code: "AUDIT_PERSISTENCE_FAILED" } });
    expect(ran).toBe(false);
    await expect(getLeaseCallUsage(workspace, issuedLease.id)).resolves.toBe(0);
    const [pending] = await listPendingAudits(workspace);
    expect(pending).toMatchObject({
      outcome: "unknown",
      taskId: "task",
      role: "scout",
      tool: "repository-read",
      operation: "repository-read",
      capability: "repository-read",
      leaseId: issuedLease.id,
      taskAuthorityHash: issuedLease.taskAuthorityHash,
      reservationId: expect.stringMatching(/^reservation-/),
      reservationOrdinal: 1
    });

    const blocked = await invokeControlled(
      schemas,
      { leaseId: issuedLease.id, taskId: "task", role: "scout", workspace: root },
      "repository-read",
      async () => { ran = true; return { decision: { allowed: true, code: "ALLOWED", reasons: [], policyVersion: "1" } }; },
      durable
    );
    expect(blocked).toMatchObject({ decision: { code: "AUDIT_PERSISTENCE_FAILED" } });
    expect(ran).toBe(false);
    await recoverMcpAudit(workspace, schemas, pending!.id);
    await expect(listPendingAudits(workspace)).resolves.toEqual([]);
  });

  it("does not reserve an already rejected lease", async () => {
    const { root, workspace, schemas, issuedLease } = await setup();
    await revokeLease(workspace, issuedLease.id, "Test revocation.");
    const result = await invokeControlled(schemas, { lease: { ...issuedLease, status: "active" }, taskId: "task", role: "scout", workspace: root }, "repository-read", async () => { throw new Error("must not run"); }, dependencies);
    expect(result).toMatchObject({ decision: { code: "LEASE_NOT_ACTIVE" } });
    await expect(getLeaseCallUsage(workspace, issuedLease.id)).resolves.toBe(0);
  });

  it("durably caps audited admission denials without spending executable Lease calls", async () => {
    const { root, workspace, schemas, issuedLease } = await setup();
    const attempts = MAX_AUDITED_LEASE_DENIALS + 4;
    for (let index = 0; index < attempts; index += 1) {
      const result = await invokeControlled(
        schemas,
        { leaseId: issuedLease.id, taskId: "task", role: "forged-role", workspace: root },
        "repository-read",
        async () => { throw new Error("must not run"); },
        dependencies
      );
      expect(result).toMatchObject({ decision: { code: "LEASE_ROLE_MISMATCH" } });
    }
    await expect(getLeaseCallUsage(workspace, issuedLease.id)).resolves.toBe(0);
    await expect(getLeaseDenialAuditUsage(workspace, issuedLease.id)).resolves.toBe(MAX_AUDITED_LEASE_DENIALS);
    await expect(listReceipts(workspace)).resolves.toHaveLength(MAX_AUDITED_LEASE_DENIALS);
    expect((await listLedgerEntries(workspace)).filter((entry) => entry.event === "mcp-call")).toHaveLength(MAX_AUDITED_LEASE_DENIALS);
  });

  it("denies a persisted lease immediately after it expires", async () => {
    const { root, workspace, schemas, issuedLease } = await setup();
    const expired = {
      ...issuedLease,
      issuedAt: new Date(Date.now() - 2 * 60_000).toISOString(),
      expiresAt: new Date(Date.now() - 60_000).toISOString()
    };
    await writeFile(await workspaceFile(workspace, `leases/${issuedLease.id}.json`), JSON.stringify(expired), "utf8");
    const result = await invokeControlled(
      schemas,
      { lease: { ...issuedLease, expiresAt: "2099-01-01T00:00:00.000Z" }, taskId: "task", role: "scout", workspace: root },
      "repository-read",
      async () => { throw new Error("must not run"); },
      dependencies
    );
    expect(result).toMatchObject({ decision: { code: "LEASE_EXPIRED" } });
    await expect(getLeaseCallUsage(workspace, issuedLease.id)).resolves.toBe(0);
  });

  it("returns a safe error and degrades the workspace if audit persistence fails", async () => {
    const { root, workspace, schemas, issuedLease } = await setup();
    const failing = { ...dependencies, appendLedgerEntry: async () => { throw new Error("disk failure"); } };
    const result = await invokeControlled(schemas, { lease: issuedLease, taskId: "task", role: "scout", workspace: root }, "repository-read", async () => ({ decision: { allowed: true, code: "ALLOWED", reasons: [], policyVersion: "1" } }), failing);
    expect(result).toMatchObject({ decision: { code: "AUDIT_PERSISTENCE_FAILED" } });
    expect(isWorkspaceAuditDegraded(workspace)).toBe(true);
  });

  it("uses only the persisted lease and supports the leaseId input", async () => {
    const { root, workspace, schemas, issuedLease } = await setup();
    let authoritative: unknown;
    const forged = { ...issuedLease, capability: "repository-write", level: "L1", readScope: ["private"], writeSet: ["private"] };
    const result = await invokeControlled(
      schemas,
      { lease: forged, leaseId: issuedLease.id, taskId: "task", role: "scout", workspace: root },
      "repository-read",
      async (access) => {
        authoritative = access.lease;
        return { decision: { allowed: true, code: "ALLOWED", reasons: [], policyVersion: "1" }, data: "persisted" };
      },
      dependencies
    );
    expect(result).toMatchObject({ data: "persisted" });
    expect(authoritative).toEqual(issuedLease);
    await expect(getLeaseCallUsage(workspace, issuedLease.id)).resolves.toBe(1);
  });

  it("enforces the concrete operation against the persisted role-to-tools policy before reservation", async () => {
    const { root, workspace, schemas } = await setup();
    const plannerLease = await issueLease(workspace, schemas, {
      taskId: "task", agentId: "planner-agent", role: "planner", capability: "repository-read",
      maxToolCalls: 2, expiresInMinutes: 1440
    });
    let ran = false;
    const deniedList = await invokeControlled(
      schemas,
      { leaseId: plannerLease.id, taskId: "task", role: "planner", workspace: root },
      "repository-read",
      async () => { ran = true; return { decision: { allowed: true, code: "ALLOWED", reasons: [], policyVersion: "1" } }; },
      dependencies,
      { operation: "repository-list" }
    );
    expect(deniedList).toMatchObject({ decision: { allowed: false, code: "LEASE_ROLE_TOOL_DENIED" } });
    expect(ran).toBe(false);
    await expect(getLeaseCallUsage(workspace, plannerLease.id)).resolves.toBe(0);

    await expect(invokeControlled(
      schemas,
      { leaseId: plannerLease.id, taskId: "task", role: "planner", workspace: root },
      "repository-read",
      async () => ({ decision: { allowed: true, code: "ALLOWED", reasons: [], policyVersion: "1" }, data: "read-ok" }),
      dependencies,
      { operation: "repository-read" }
    )).resolves.toMatchObject({ data: "read-ok" });
    await expect(getLeaseCallUsage(workspace, plannerLease.id)).resolves.toBe(1);
  });

  it("rejects a legacy unbound conductor Lease at MCP use time", async () => {
    const { root, workspace, schemas, issuedLease } = await setup();
    const legacy = { ...issuedLease, id: "lease-legacy-conductor", role: "conductor" };
    await writeFile(await workspaceFile(workspace, `leases/${legacy.id}.json`), JSON.stringify(legacy), "utf8");
    let ran = false;
    const result = await invokeControlled(
      schemas,
      { leaseId: legacy.id, taskId: "task", role: "conductor", workspace: root },
      "repository-read",
      async () => { ran = true; return { decision: { allowed: true, code: "ALLOWED", reasons: [], policyVersion: "1" } }; },
      dependencies,
      { operation: "repository-read" }
    );
    expect(result).toMatchObject({ decision: { allowed: false, code: "LEASE_ROLE_TOOL_DENIED" } });
    expect(ran).toBe(false);
    await expect(getLeaseCallUsage(workspace, legacy.id)).resolves.toBe(0);
  });

  it("rejects never-issued and conflicting lease references without reserving", async () => {
    const { root, workspace, schemas, issuedLease } = await setup();
    const neverIssued = await invokeControlled(
      schemas,
      { lease: { ...issuedLease, id: "never-issued" }, taskId: "task", role: "scout", workspace: root },
      "repository-read",
      async () => { throw new Error("must not run"); },
      dependencies
    );
    expect(neverIssued).toMatchObject({ decision: { code: "LEASE_NOT_FOUND" } });
    const conflicting = await invokeControlled(
      schemas,
      { lease: issuedLease, leaseId: "other-lease", taskId: "task", role: "scout", workspace: root },
      "repository-read",
      async () => { throw new Error("must not run"); },
      dependencies
    );
    expect(conflicting).toMatchObject({ decision: { code: "LEASE_INVALID" } });
    await expect(getLeaseCallUsage(workspace, issuedLease.id)).resolves.toBe(0);
  });

  it("rejects a persisted lease whose embedded ID differs from its canonical lookup ID", async () => {
    const { root, workspace, schemas, issuedLease } = await setup();
    await writeFile(
      await workspaceFile(workspace, `leases/${issuedLease.id}.json`),
      JSON.stringify({ ...issuedLease, id: "different-lease-id", maxToolCalls: 100 }),
      "utf8"
    );
    const result = await invokeControlled(
      schemas,
      { leaseId: issuedLease.id, taskId: "task", role: "scout", workspace: root },
      "repository-read",
      async () => { throw new Error("must not run"); },
      dependencies
    );
    expect(result).toMatchObject({ decision: { code: "LEASE_INVALID" } });
    await expect(getLeaseCallUsage(workspace, issuedLease.id)).resolves.toBe(0);
    await expect(getLeaseCallUsage(workspace, "different-lease-id")).resolves.toBe(0);
  });

  it("atomically enforces the persisted call limit under concurrent admission", async () => {
    const { workspace, schemas } = await setup();
    const limited = await issueLease(workspace, schemas, { taskId: "task", agentId: "parallel", role: "scout", capability: "repository-read", maxToolCalls: 2, expiresInMinutes: 1440 });
    const results = await Promise.all(Array.from({ length: 8 }, () => admitAndReserveLeaseCall(
      workspace,
      limited.id,
      { taskId: "task", role: "scout", capability: "repository-read" },
      (stored) => schemas.validate("lease", stored)
    )));
    expect(results.filter((result) => result.allowed)).toHaveLength(2);
    expect(results.filter((result) => result.decision.code === "LEASE_CALL_LIMIT")).toHaveLength(6);
    await expect(getLeaseCallUsage(workspace, limited.id)).resolves.toBe(2);
  });

  it("enforces active subtask binding and supersedes retry leases", async () => {
    const { root, workspace, schemas } = await setup();
    await mkdir(path.join(root, "docs"), { recursive: true });
    const contract = await createContract(workspace, schemas, {
      taskId: "task",
      domain: "general",
      goal: "Read project documentation",
      globalAcceptanceCriteria: ["read succeeds", "scope holds", "evidence exists", "review completes"],
      scope: ["docs"]
    });
    const orchestrationRun = await createRun(workspace, schemas, { contractRef: contract.contractId });
    const subtask = await addSubtask(workspace, schemas, orchestrationRun.runId, {
      goal: "Read docs/guide.md",
      inputArtifactIds: [],
      acceptanceCriteria: ["guide checked"],
      scope: ["docs"],
      capabilities: ["repository-read"]
    });
    const firstDispatch = await dispatchSubtask(workspace, schemas, orchestrationRun.runId, subtask.subtaskId, "worker-agent", 0);
    const firstLeaseId = firstDispatch.leases[0]!;
    const beforeBegin = await invokeControlled(
      schemas,
      { leaseId: firstLeaseId, taskId: "task", role: "worker", workspace: root },
      "repository-read",
      async () => { throw new Error("must not run"); },
      dependencies
    );
    expect(beforeBegin).toMatchObject({ decision: { code: "LEASE_SUBTASK_NOT_ACTIVE" } });
    await beginSubtask(workspace, orchestrationRun.runId, subtask.subtaskId, firstDispatch.activeAttempt);
    await expect(invokeControlled(
      schemas,
      { leaseId: firstLeaseId, taskId: "task", role: "worker", workspace: root },
      "repository-read",
      async () => ({ decision: { allowed: true, code: "ALLOWED", reasons: [], policyVersion: "1" }, data: "active" }),
      dependencies
    )).resolves.toMatchObject({ data: "active" });

    await writeFile(path.join(root, "docs", "guide.md"), "first\n", "utf8");
    await reportArtifact(workspace, schemas, orchestrationRun.runId, subtask.subtaskId, { path: "docs/guide.md", kind: "file", expectedAttempt: firstDispatch.activeAttempt });
    await recordReview(workspace, schemas, orchestrationRun.runId, subtask.subtaskId, {
      decision: "REJECTED",
      criteriaResults: [{ criterion: "guide checked", passed: false, note: "retry" }],
      defects: [{ location: "docs/guide.md", problem: "incomplete", suggestion: "retry" }],
      score: 40,
      reason: "retry",
      validatorEvidence: [{ validator: "hash", passed: true, detail: "checked" }],
      reviewedBy: "reviewer",
      tokensUsed: 0,
      expectedAttempt: firstDispatch.activeAttempt
    });
    const secondDispatch = await dispatchSubtask(workspace, schemas, orchestrationRun.runId, subtask.subtaskId, "worker-agent", 1);
    const secondLeaseId = secondDispatch.leases[0]!;
    expect(secondLeaseId).not.toBe(firstLeaseId);
    await beginSubtask(workspace, orchestrationRun.runId, subtask.subtaskId, secondDispatch.activeAttempt);
    const stale = await invokeControlled(
      schemas,
      { leaseId: firstLeaseId, taskId: "task", role: "worker", workspace: root },
      "repository-read",
      async () => { throw new Error("must not run"); },
      dependencies
    );
    expect(stale).toMatchObject({ decision: { code: "LEASE_NOT_ACTIVE" } });
    await expect(invokeControlled(
      schemas,
      { leaseId: secondLeaseId, taskId: "task", role: "worker", workspace: root },
      "repository-read",
      async () => ({ decision: { allowed: true, code: "ALLOWED", reasons: [], policyVersion: "1" }, data: "current" }),
      dependencies
    )).resolves.toMatchObject({ data: "current" });
    await expect(getLeaseCallUsage(workspace, firstLeaseId)).resolves.toBe(1);
    await expect(getLeaseCallUsage(workspace, secondLeaseId)).resolves.toBe(1);
  });

  it("recovers a partial L2 multi-capability dispatch and admits the Contract-derived child Lease", async () => {
    const { root, workspace, schemas } = await setup();
    await mkdir(path.join(root, "docs"), { recursive: true });
    const current = await getTask(workspace, "task");
    const task = { ...current, riskLevel: "L2" as const };
    await saveTask(workspace, task);
    const orchestrationApproval = await approveTaskCapability(workspace, schemas, task, "orchestration-control", ["docs"]);
    await approveTaskCapability(workspace, schemas, task, "repository-read", ["docs"]);
    const contract = await createContract(workspace, schemas, {
      taskId: task.id,
      domain: "general",
      goal: "Read project documentation under L2 authority",
      globalAcceptanceCriteria: ["read succeeds"],
      scope: ["docs"],
      approvalRefs: [orchestrationApproval.id]
    });
    const run = await createRun(workspace, schemas, { contractRef: contract.contractId });
    const subtask = await addSubtask(workspace, schemas, run.runId, {
      goal: "Read and inspect docs",
      inputArtifactIds: [],
      acceptanceCriteria: ["docs checked"],
      scope: ["docs"],
      capabilities: ["repository-read", "git-read"]
    });

    await expect(dispatchSubtask(workspace, schemas, run.runId, subtask.subtaskId, "l2-worker", 0))
      .rejects.toMatchObject({ code: "TASK_APPROVAL_REQUIRED" });
    const partial = (await import("../src/storage/leases.js").then((module) => module.listLeases(workspace)))
      .filter((lease) => lease.subtaskRef === subtask.subtaskId);
    expect(partial).toHaveLength(1);
    expect(partial[0]).toMatchObject({ capability: "repository-read", status: "active", subtaskAttempt: 0 });

    await approveTaskCapability(workspace, schemas, task, "git-read", ["docs"]);
    const recovered = await dispatchSubtask(workspace, schemas, run.runId, subtask.subtaskId, "l2-worker", 0);
    expect(recovered.leases).toHaveLength(2);
    expect(recovered.leases).toContain(partial[0]!.id);
    expect(new Set(recovered.leases).size).toBe(2);
    await beginSubtask(workspace, run.runId, subtask.subtaskId, recovered.activeAttempt);

    const readLease = recovered.leases.find((id) => id === partial[0]!.id)!;
    await expect(invokeControlled(
      schemas,
      { leaseId: readLease, taskId: task.id, role: "worker", workspace: root },
      "repository-read",
      async () => ({ decision: { allowed: true, code: "ALLOWED", reasons: [], policyVersion: "1" }, data: "l2-current" }),
      dependencies
    )).resolves.toMatchObject({ data: "l2-current" });
  });

  it("runs a confirmed repository write through the full invocation chain", async () => {
    const { root, workspace, schemas } = await setup();
    await writeFile(path.join(root, "notes.md"), "original\n", "utf8");
    await authorizeWrite(workspace, schemas, "notes.md");
    const registries = await loadRegistries(projectRoot, schemas);
    const plan = await createPlan(workspace, schemas, registries, { taskId: "task", roles: ["builder"] });
    await approvePlanConfirmation(workspace, schemas, plan);
    await confirmPlan(workspace, plan.planId);
    await executePlan(workspace, plan.planId);
    await beginStep(workspace, schemas, plan.planId, "step-1");
    const intent = await requestWrites(workspace, schemas, plan.planId, "step-1", [{ target: "notes.md", action: "modify", purpose: "Update." }]);
    await approveWriteIntent(workspace, schemas, intent);
    await confirmWrites(workspace, plan.planId, "step-1", intent.writeIntentId, schemas);
    await approveTaskCapability(workspace, schemas, await getTask(workspace, "task"), "repository-write", ["notes.md"]);
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
    await authorizeWrite(workspace, schemas, "notes.md");
    const registries = await loadRegistries(projectRoot, schemas);
    const plan = await createPlan(workspace, schemas, registries, { taskId: "task", roles: ["builder"] });
    await approvePlanConfirmation(workspace, schemas, plan);
    await confirmPlan(workspace, plan.planId);
    await executePlan(workspace, plan.planId);
    await beginStep(workspace, schemas, plan.planId, "step-1");
    const intent = await requestWrites(workspace, schemas, plan.planId, "step-1", [{ target: "notes.md", action: "delete", purpose: "Remove." }]);
    await approveWriteIntent(workspace, schemas, intent);
    await confirmWrites(workspace, plan.planId, "step-1", intent.writeIntentId, schemas);
    await approveTaskCapability(workspace, schemas, await getTask(workspace, "task"), "repository-write", ["notes.md"]);
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
    await authorizeWrite(workspace, schemas, "notes.md");
    const registries = await loadRegistries(projectRoot, schemas);
    const plan = await createPlan(workspace, schemas, registries, { taskId: "task", roles: ["builder"] });
    await approvePlanConfirmation(workspace, schemas, plan);
    await confirmPlan(workspace, plan.planId);
    await executePlan(workspace, plan.planId);
    await beginStep(workspace, schemas, plan.planId, "step-1");
    const intent = await requestWrites(workspace, schemas, plan.planId, "step-1", [{ target: "notes.md", action: "modify", purpose: "Update." }]);
    await approveTaskCapability(workspace, schemas, await getTask(workspace, "task"), "repository-write", ["notes.md"]);
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
