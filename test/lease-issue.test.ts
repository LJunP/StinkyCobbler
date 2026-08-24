import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SchemaRegistry } from "../src/contracts/schema-registry.js";
import { createTask } from "../src/storage/tasks.js";
import { initWorkspace } from "../src/storage/workspace.js";
import { injectLeaseIssuanceFaultForTesting, injectLeaseRevocationFaultForTesting, issueLease, getLease, listLeases, revokeLease, type LeaseIssueInput } from "../src/storage/leases.js";
import { listLedgerEntries } from "../src/storage/ledger.js";
import { evaluateLease } from "../src/policy/evaluate.js";
import type { TaskCharter } from "../src/contracts/types.js";
import { getApproval } from "../src/storage/approvals.js";
import { createContract, getContract } from "../src/storage/orchestration.js";
import { approveTaskCapability } from "./helpers/authority.js";

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

async function setupApprovalBackedLease() {
  const task: TaskCharter = {
    id: "lease-recovery-task",
    workspaceId: "workspace-1",
    goal: "Read the controlled docs scope",
    requestedOutputs: ["report"],
    riskLevel: "L0",
    state: "RUNNING",
    scope: ["docs"],
    approvalRequired: true
  };
  const { workspace, schemas } = await setup(task);
  const approval = await approveTaskCapability(workspace, schemas, task, "repository-read", ["docs"], 20);
  const input: LeaseIssueInput = {
    taskId: task.id,
    agentId: "recovery-agent",
    role: "scout",
    capability: "repository-read",
    readScope: ["docs"],
    approvalRefs: [approval.id]
  };
  return { workspace, schemas, approval, input };
}

async function leaseIssuanceJournals(workspace: Awaited<ReturnType<typeof initWorkspace>>) {
  const leaseDirectory = path.join(workspace.directory, "leases");
  const files = (await readdir(leaseDirectory)).filter((name) => /^issuance-[A-Za-z0-9._-]+\.json$/.test(name)).sort();
  return Promise.all(files.map(async (name) => JSON.parse(await readFile(path.join(leaseDirectory, name), "utf8")) as {
    status: string;
    leaseId: string;
    approvalRef: string;
  }));
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

  it("issues docs-index as a fixed-scope L1 control-plane lease", async () => {
    const { workspace, schemas } = await setup();
    const lease = await issueLease(workspace, schemas, {
      taskId: "lease-task",
      agentId: "agent-1",
      role: "scout",
      capability: "docs-index",
      readScope: ["docs"]
    });
    expect(lease).toMatchObject({
      capability: "docs-index",
      level: "L1",
      readScope: ["docs"],
      writeSet: [".stinky-cobbler/docs-index.json"]
    });
    await expect(issueLease(workspace, schemas, {
      taskId: "lease-task",
      agentId: "agent-1",
      role: "scout",
      capability: "docs-index",
      writeSet: ["docs/other.json"]
    })).rejects.toMatchObject({ code: "LEASE_WRITE_SET_DENIED" });
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

  it("rejects unknown and role-disallowed Lease grants at issuance", async () => {
    const { workspace, schemas } = await setup();
    await expect(issueLease(workspace, schemas, {
      taskId: "lease-task", agentId: "agent-1", role: "unknown-role", capability: "repository-read"
    })).rejects.toMatchObject({ code: "LEASE_ROLE_UNKNOWN" });
    await expect(issueLease(workspace, schemas, {
      taskId: "lease-task", agentId: "agent-1", role: "conductor", capability: "repository-read"
    })).rejects.toMatchObject({ code: "LEASE_ROLE_CAPABILITY_DENIED" });
    await expect(issueLease(workspace, schemas, {
      taskId: "lease-task", agentId: "agent-1", role: "planner", capability: "git-read"
    })).rejects.toMatchObject({ code: "LEASE_ROLE_CAPABILITY_DENIED" });
    await expect(issueLease(workspace, schemas, {
      taskId: "lease-task", agentId: "agent-1", role: "scout", capability: "docs-index", readScope: ["docs"]
    })).resolves.toMatchObject({ role: "scout", capability: "docs-index" });
  });

  it("rejects unsafe read scopes", async () => {
    const { workspace, schemas } = await setup();
    for (const readScope of [[".stinky-cobbler"], ["/etc"], ["../outside"], ["docs/../escape"], [""]]) {
      await expect(issueLease(workspace, schemas, { taskId: "lease-task", agentId: "agent-1", role: "scout", capability: "repository-read", readScope })).rejects.toMatchObject({ code: "LEASE_READ_SCOPE_INVALID" });
    }
  });

  it("rejects repository-write targets covered by the current custom sensitive policy", async () => {
    const { workspace, schemas } = await setup();
    const policies = path.join(workspace.directory, "policies");
    await mkdir(policies, { recursive: true });
    await writeFile(path.join(policies, "orchestration.yaml"), "version: 1\nsensitiveExtraPaths:\n  - internal/\n", "utf8");

    await expect(issueLease(workspace, schemas, {
      taskId: "lease-task",
      agentId: "agent-1",
      role: "writer",
      capability: "repository-write",
      writeSet: ["internal/note.md"]
    })).rejects.toMatchObject({ code: "WRITE_TARGET_FORBIDDEN" });
    await expect(listLeases(workspace)).resolves.toEqual([]);
    await expect(listLedgerEntries(workspace)).resolves.toEqual([]);
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
    expect(revoked).toMatchObject({ status: "revoked", revokedAt: expect.any(String), revocationReasonHash: expect.stringMatching(/^sha256:/) });
    await expect(revokeLease(workspace, lease.id, "No longer needed.")).resolves.toEqual(revoked);
    await expect(revokeLease(workspace, lease.id, "A conflicting reason.")).rejects.toMatchObject({ code: "LEASE_REVOCATION_CONFLICT" });
    const decision = evaluateLease(revoked, { taskId: "lease-task", role: "scout", workspace: workspace.root, capability: "repository-read" });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe("LEASE_NOT_ACTIVE");
    const events = (await listLedgerEntries(workspace)).map((entry) => entry.event);
    expect(events).toEqual(["lease-issued", "lease-revoked"]);
  });

  it("recovers an exactly-once revocation ledger after the revoked state is persisted", async () => {
    const { workspace, schemas } = await setup();
    const lease = await issueLease(workspace, schemas, { taskId: "lease-task", agentId: "agent-1", role: "scout", capability: "repository-read" });
    injectLeaseRevocationFaultForTesting(workspace, "after-state");

    await expect(revokeLease(workspace, lease.id, "Worker generation superseded.")).rejects.toMatchObject({ code: "LEASE_REVOCATION_TEST_FAULT" });
    const splitState = await getLease(workspace, lease.id);
    expect(splitState).toMatchObject({ status: "revoked", revokedAt: expect.any(String), revocationReasonHash: expect.stringMatching(/^sha256:/) });
    expect((await listLedgerEntries(workspace)).filter((entry) => entry.event === "lease-revoked")).toHaveLength(0);

    await expect(revokeLease(workspace, lease.id, "Worker generation superseded.")).resolves.toEqual(splitState);
    await expect(revokeLease(workspace, lease.id, "Worker generation superseded.")).resolves.toEqual(splitState);
    const revocations = (await listLedgerEntries(workspace)).filter((entry) => entry.event === "lease-revoked" && entry.leaseRef === lease.id);
    expect(revocations).toHaveLength(1);
    await expect(revokeLease(workspace, lease.id, "Different reason.")).rejects.toMatchObject({ code: "LEASE_REVOCATION_CONFLICT" });
  });

  it("rejects stored Leases that fail schema or canonical ID binding", async () => {
    const { workspace, schemas } = await setup();
    const lease = await issueLease(workspace, schemas, { taskId: "lease-task", agentId: "agent-1", role: "scout", capability: "repository-read" });
    const file = path.join(workspace.directory, "leases", `${lease.id}.json`);
    await writeFile(file, JSON.stringify({ ...lease, unexpectedAuthority: true }), "utf8");
    await expect(getLease(workspace, lease.id)).rejects.toMatchObject({ code: "SCHEMA_INVALID" });
    await writeFile(file, JSON.stringify({ ...lease, id: "lease-other" }), "utf8");
    await expect(getLease(workspace, lease.id)).rejects.toMatchObject({ code: "LEASE_INVALID" });
  });

  it.each(["after-consume", "after-lease", "after-ledger"] as const)("recovers an Approval-backed issuance exactly once after %s", async (point) => {
    const { workspace, schemas, approval, input } = await setupApprovalBackedLease();
    injectLeaseIssuanceFaultForTesting(workspace, point);

    await expect(issueLease(workspace, schemas, input)).rejects.toMatchObject({ code: "LEASE_ISSUANCE_TEST_FAULT" });

    const retry = await issueLease(workspace, schemas, input);
    const persistedApproval = await getApproval(workspace, approval.id);
    const leases = await listLeases(workspace);
    const journals = await leaseIssuanceJournals(workspace);
    const issued = (await listLedgerEntries(workspace)).filter((entry) => entry.event === "lease-issued");

    expect(persistedApproval.consumedBy).toBe(retry.id);
    expect(leases).toEqual([retry]);
    // The journal shares the Lease directory but is never exposed as a Lease.
    expect(journals).toHaveLength(1);
    expect(journals[0]).toMatchObject({ status: "COMMITTED", leaseId: retry.id, approvalRef: approval.id });
    expect(issued).toHaveLength(1);
    expect(issued[0]?.leaseRef).toBe(retry.id);
  });

  it("does not reuse a prepared issuance journal for a different request", async () => {
    const { workspace, schemas, approval, input } = await setupApprovalBackedLease();
    injectLeaseIssuanceFaultForTesting(workspace, "after-consume");
    await expect(issueLease(workspace, schemas, input)).rejects.toMatchObject({ code: "LEASE_ISSUANCE_TEST_FAULT" });

    await expect(issueLease(workspace, schemas, { ...input, agentId: "other-agent" })).rejects.toMatchObject({ code: "TASK_APPROVAL_INVALID" });
    await expect(listLeases(workspace)).resolves.toEqual([]);
    expect(await leaseIssuanceJournals(workspace)).toHaveLength(1);

    await expect(issueLease(workspace, schemas, input)).resolves.toMatchObject({ agentId: input.agentId, approvalRefs: [approval.id] });
  });

  it("rejects a recovered Lease whose persisted workspace root differs from the exact request workspace", async () => {
    const { workspace, schemas, input } = await setupApprovalBackedLease();
    injectLeaseIssuanceFaultForTesting(workspace, "after-lease");
    await expect(issueLease(workspace, schemas, input)).rejects.toMatchObject({ code: "LEASE_ISSUANCE_TEST_FAULT" });

    const [lease] = await listLeases(workspace);
    expect(lease).toBeDefined();
    const file = path.join(workspace.directory, "leases", `${lease!.id}.json`);
    await writeFile(file, JSON.stringify({ ...lease, workspace: "/another/workspace" }), "utf8");

    await expect(issueLease(workspace, schemas, input)).rejects.toMatchObject({ code: "LEASE_ISSUANCE_CONFLICT" });
  });

  it("fails closed instead of reusing an expired active issuance subject", async () => {
    const { workspace, schemas } = await setup();
    const input: LeaseIssueInput = { taskId: "lease-task", agentId: "agent-1", role: "scout", capability: "repository-read", expiresInMinutes: 1 };
    const lease = await issueLease(workspace, schemas, input);
    const expiresAt = new Date(Date.now() - 60_000);
    const issuedAt = new Date(expiresAt.getTime() - 60_000);
    await writeFile(path.join(workspace.directory, "leases", `${lease.id}.json`), JSON.stringify({ ...lease, issuedAt: issuedAt.toISOString(), expiresAt: expiresAt.toISOString() }), "utf8");

    await expect(issueLease(workspace, schemas, input)).rejects.toMatchObject({ code: "LEASE_REISSUE_REQUIRED" });
    await expect(listLeases(workspace)).resolves.toHaveLength(1);
  });

  it("keeps Contract child-Lease allocation lifetime-bound across siblings, revocation, and expiry", async () => {
    const task: TaskCharter = {
      id: "contract-lease-task", workspaceId: "workspace-1", goal: "Read controlled docs", requestedOutputs: ["report"],
      riskLevel: "L0", state: "RUNNING", scope: ["docs"]
    };
    const { workspace, schemas } = await setup(task);
    const contract = await createContract(workspace, schemas, {
      taskId: task.id, domain: "general", goal: "Delegate one read", globalAcceptanceCriteria: ["report"], scope: ["docs"]
    });
    const contractFile = path.join(workspace.directory, "orchestration", `${contract.contractId}.json`);
    await writeFile(contractFile, JSON.stringify({
      ...contract,
      delegationBudget: { ...contract.delegationBudget!, maxToolCalls: 2, expiresAt: new Date(Date.now() + 4 * 60 * 60_000).toISOString() }
    }), "utf8");
    const first = await issueLease(workspace, schemas, {
      taskId: task.id, agentId: "agent-1", role: "scout", capability: "repository-read", readScope: ["docs"],
      parentGrantRef: contract.contractId, maxToolCalls: 1
    });
    const second = await issueLease(workspace, schemas, {
      taskId: task.id, agentId: "agent-2", role: "scout", capability: "repository-read", readScope: ["docs"],
      parentGrantRef: contract.contractId, maxToolCalls: 1
    });
    expect((await getContract(workspace, contract.contractId)).delegationBudget).toMatchObject({ lifetimeAllocatedToolCalls: 2, pendingLeaseAllocations: {} });

    await revokeLease(workspace, first.id, "First sibling completed.");
    await expect(issueLease(workspace, schemas, {
      taskId: task.id, agentId: "agent-3", role: "scout", capability: "repository-read", readScope: ["docs"],
      parentGrantRef: contract.contractId, maxToolCalls: 1
    })).rejects.toMatchObject({ code: "CONTRACT_BUDGET_EXCEEDED" });

    const expiresAt = new Date(Date.now() - 60_000);
    await writeFile(path.join(workspace.directory, "leases", `${second.id}.json`), JSON.stringify({
      ...second,
      issuedAt: new Date(expiresAt.getTime() - 60 * 60_000).toISOString(),
      expiresAt: expiresAt.toISOString()
    }), "utf8");

    await expect(issueLease(workspace, schemas, {
      taskId: task.id, agentId: "agent-4", role: "scout", capability: "repository-read", readScope: ["docs"],
      parentGrantRef: contract.contractId, maxToolCalls: 1
    })).rejects.toMatchObject({ code: "CONTRACT_BUDGET_EXCEEDED" });
    expect((await getContract(workspace, contract.contractId)).delegationBudget).toMatchObject({ lifetimeAllocatedToolCalls: 2, pendingLeaseAllocations: {} });
  });

  it("recovers a Contract lifetime allocation reservation without double charging", async () => {
    const task: TaskCharter = {
      id: "contract-allocation-recovery-task", workspaceId: "workspace-1", goal: "Read controlled docs", requestedOutputs: ["report"],
      riskLevel: "L0", state: "RUNNING", scope: ["docs"]
    };
    const { workspace, schemas } = await setup(task);
    const contract = await createContract(workspace, schemas, {
      taskId: task.id, domain: "general", goal: "Delegate one read", globalAcceptanceCriteria: ["report"], scope: ["docs"]
    });
    await writeFile(path.join(workspace.directory, "orchestration", `${contract.contractId}.json`), JSON.stringify({
      ...contract,
      delegationBudget: { ...contract.delegationBudget!, maxToolCalls: 1, expiresAt: new Date(Date.now() + 4 * 60 * 60_000).toISOString() }
    }), "utf8");
    const input: LeaseIssueInput = {
      taskId: task.id, agentId: "agent-1", role: "scout", capability: "repository-read", readScope: ["docs"],
      parentGrantRef: contract.contractId, maxToolCalls: 1
    };
    injectLeaseIssuanceFaultForTesting(workspace, "after-contract-allocation");
    await expect(issueLease(workspace, schemas, input)).rejects.toMatchObject({ code: "LEASE_ISSUANCE_TEST_FAULT" });

    const [journal] = await leaseIssuanceJournals(workspace);
    expect(journal).toBeDefined();
    await expect(listLeases(workspace)).resolves.toEqual([]);
    expect((await getContract(workspace, contract.contractId)).delegationBudget).toMatchObject({
      lifetimeAllocatedToolCalls: 1,
      pendingLeaseAllocations: { [journal!.leaseId]: 1 }
    });

    const retry = await issueLease(workspace, schemas, input);
    expect((await getContract(workspace, contract.contractId)).delegationBudget).toMatchObject({ lifetimeAllocatedToolCalls: 1, pendingLeaseAllocations: {} });
    await expect(issueLease(workspace, schemas, { ...input, agentId: "agent-2" })).rejects.toMatchObject({ code: "CONTRACT_BUDGET_EXCEEDED" });
    expect(retry.parentGrantRef).toBe(contract.contractId);
  });
});
