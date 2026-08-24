import { mkdir, readFile, readdir } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type { CapabilityLease } from "../contracts/types.js";
import type { TaskContract } from "../contracts/orchestration.js";
import type { SchemaRegistry } from "../contracts/schema-registry.js";
import { defaultSchemaRegistry } from "../contracts/default-schema-registry.js";
import { ExitCode, StinkyCobblerError } from "../errors.js";
import { appendLedgerEntry, auditTextFingerprint, listLedgerEntries, prepareLedgerEntry, type AppendLedgerEntry } from "./ledger.js";
import type { LocalWorkspace } from "./workspace.js";
import { createWorkspaceJson, workspaceFile, writeWorkspaceJson } from "./workspace.js";
import { withWorkspaceLock } from "./workspace-lock.js";
import { assertWrites } from "./write-intents.js";
import { loadOrchestrationConfig } from "../config/tiered.js";
import { assertWorkspacePathPolicy } from "../security/workspace-path.js";
import { admitTaskCapability, hashTaskAuthority } from "./task-authority.js";
import { consumeApproval, getApproval } from "./approvals.js";
import { getTask } from "./tasks.js";
import { loadRegistries, type Registries } from "../config/registry.js";
import { ORCHESTRATION_WORKER_ROLE } from "../policy/role-tools.js";

const DIRECTORY = "leases";
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ISSUE_CAPABILITIES = new Set(["repository-read", "git-read", "docs-index", "repository-write"]);
const DEFAULT_MAX_TOOL_CALLS = 20;
const MAX_MAX_TOOL_CALLS = 100;
const DEFAULT_EXPIRES_IN_MINUTES = 60;
const MAX_EXPIRES_IN_MINUTES = 1440;
const MAX_LEASE_READ_SCOPE_ITEMS = 50;
const MAX_LEASE_WRITE_SET_ITEMS = 20;
const MAX_LEASE_APPROVAL_REFS = 50;
const MAX_LEASE_SCOPE_OR_TARGET_LENGTH = 512;
const MAX_LEASE_APPROVAL_REF_LENGTH = 128;
const MAX_PENDING_CONTRACT_LEASE_ALLOCATIONS = 128;
const PACKAGE_ROOT = path.resolve(import.meta.dirname, "../..");
let canonicalRegistriesPromise: Promise<Registries> | undefined;
/** Bounds reachable active authority and keeps usage-counter reclamation live. */
export const MAX_ACTIVE_WORKSPACE_LEASES = 1024;
const DOCS_INDEX_WRITE_TARGET = ".stinky-cobbler/docs-index.json";
const issuanceFaults = new Map<string, "after-journal" | "after-consume" | "after-contract-allocation" | "after-lease" | "after-ledger">();
const revocationFaults = new Map<string, "after-state">();

export interface LeaseIssueInput {
  taskId: string;
  agentId: string;
  role: string;
  capability: string;
  readScope?: string[];
  writeSet?: string[];
  maxToolCalls?: number;
  expiresInMinutes?: number;
  issuedBy?: string;
  /** 2.0: binds the lease to an orchestration subtask (worker). */
  subtaskRef?: string;
  /** Exact retry generation for a subtask-bound Lease. */
  subtaskAttempt?: number;
  /** Binds a scheduler-issued Lease to one exact Plan step generation. */
  planRef?: string;
  stepRef?: string;
  planGeneration?: number;
  /** Precise Task capability Approval IDs; legacy path-only approvals fail closed. */
  approvalRefs?: string[];
  /** Parent Lease/Approval grant for derived authority. */
  parentGrantRef?: string;
  /** Host principal/session boundary persisted on the Lease. */
  hostSessionId?: string;
}

interface LeaseIssuanceJournal {
  version: 1;
  journalId: string;
  status: "PREPARED" | "COMMITTED";
  requestHash: string;
  taskId: string;
  approvalRef?: string;
  leaseId: string;
  preparedAt: string;
  updatedAt: string;
  committedAt?: string;
}

/** Issues and persists one supported capability Lease. User-interaction gates live at the host/Skill layer. */
export async function issueLease(workspace: LocalWorkspace, schemas: SchemaRegistry, input: LeaseIssueInput): Promise<CapabilityLease> {
  return withWorkspaceLock(workspace, async () => {
    const cfg = await loadOrchestrationConfig(workspace);
    const defaultToolCalls = cfg.defaults?.leaseDefaultToolCalls ?? DEFAULT_MAX_TOOL_CALLS;
    const defaultMinutes = cfg.defaults?.leaseDefaultMinutes ?? DEFAULT_EXPIRES_IN_MINUTES;
    const maxToolCallsCap = cfg.defaults?.leaseMaxToolCallsCap ?? MAX_MAX_TOOL_CALLS;
    const maxMinutesCap = cfg.defaults?.leaseMaxMinutes ?? MAX_EXPIRES_IN_MINUTES;
    assertIssueInput(input, { defaultToolCalls, defaultMinutes, maxToolCallsCap, maxMinutesCap, ...(cfg.sensitiveExtraPaths === undefined ? {} : { sensitiveExtraPaths: cfg.sensitiveExtraPaths }) });
    canonicalRegistriesPromise ??= loadRegistries(PACKAGE_ROOT, schemas);
    assertRoleMayGrantCapability(input, await canonicalRegistriesPromise);
    const task = await getTask(workspace, input.taskId);
    const taskAuthorityHash = hashTaskAuthority(task);
    const maxToolCalls = input.maxToolCalls ?? defaultToolCalls;
    const expiresInMinutes = input.expiresInMinutes ?? defaultMinutes;
    const isWrite = input.capability === "repository-write";
    const isDocsIndex = input.capability === "docs-index";
    const readScope = input.readScope ?? ["."];
    const writeSet = isWrite ? input.writeSet! : isDocsIndex ? [DOCS_INDEX_WRITE_TARGET] : [];
    const requestHash = leaseIssuanceRequestHash(input, {
      taskAuthorityHash,
      readScope,
      writeSet,
      maxToolCalls,
      expiresInMinutes
    });
    const journalId = leaseIssuanceJournalId(requestHash);
    let journal = await findLeaseIssuanceJournal(workspace, journalId);
    const leaseId = journal?.leaseId ?? `lease-${randomUUID()}`;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + expiresInMinutes * 60_000).toISOString();
    const authority = await admitTaskCapability(workspace, {
      taskId: input.taskId,
      capability: input.capability,
      readScope,
      writeSet,
      approvalRefs: journal?.approvalRef === undefined ? (input.approvalRefs ?? []) : [journal.approvalRef],
      ...(input.parentGrantRef === undefined ? {} : { parentGrantRef: input.parentGrantRef }),
      maxToolCalls,
      expiresAt,
      hostSessionId: input.hostSessionId ?? "local-cli",
      allowApprovalScopeSuperset: input.parentGrantRef?.startsWith("lease-") === true || input.parentGrantRef?.startsWith("contract-") === true,
      approvalConsumptionOwner: leaseId
    });
    const persistedLeases = await listLeases(workspace);
    const activeLeaseCount = persistedLeases.filter((candidate) => candidate.id !== leaseId && isLeaseCurrentlyActive(candidate, now)).length;
    if (activeLeaseCount >= MAX_ACTIVE_WORKSPACE_LEASES) {
      throw leaseError("LEASE_ACTIVE_CAP_REACHED", "The workspace active-Lease cap is reached; revoke obsolete Leases or wait for expiry before issuing another.", {
        activeLeaseCount,
        limit: MAX_ACTIVE_WORKSPACE_LEASES
      });
    }
    let parentContract: TaskContract | undefined;
    if (authority.parentGrantRef.startsWith("contract-")) {
      const { getContract } = await import("./orchestration.js");
      const contract = await getContract(workspace, authority.parentGrantRef);
      if (contract.delegationBudget === undefined || Date.parse(expiresAt) > Date.parse(contract.delegationBudget.expiresAt)) {
        throw leaseError("CONTRACT_BUDGET_EXCEEDED", "Child Lease expiry exceeds the Contract delegation budget.", { contractId: contract.contractId });
      }
      parentContract = contract;
    }
    // Every issuance records its recovery journal before it creates the Lease.
    // This makes a partially assembled multi-capability dispatch retry reuse
    // the same still-active, not-yet-bound Lease instead of leaking duplicates.
    await mkdir(await workspaceFile(workspace, DIRECTORY), { recursive: true, mode: 0o700 });
    if (journal === undefined) {
      const preparedAt = new Date().toISOString();
      journal = {
        version: 1,
        journalId,
        status: "PREPARED",
        requestHash,
        taskId: input.taskId,
        ...(authority.matchedApprovalRef === undefined ? {} : { approvalRef: authority.matchedApprovalRef }),
        leaseId,
        preparedAt,
        updatedAt: preparedAt
      };
      schemas.validate("lease-issuance", journal);
      await createWorkspaceJson(workspace, leaseIssuanceFile(journalId), journal);
    } else if (journal.approvalRef !== authority.matchedApprovalRef || journal.leaseId !== leaseId || journal.requestHash !== requestHash) {
      throw leaseError("LEASE_ISSUANCE_CONFLICT", "The prepared Lease issuance journal is bound to another Approval or request.", { journalId });
    }
    maybeInjectLeaseIssuanceFault(workspace, "after-journal");
    if (authority.matchedApprovalRef !== undefined) {
      const approval = await getApproval(workspace, authority.matchedApprovalRef);
      await consumeApproval(workspace, schemas, approval.id, leaseId);
      maybeInjectLeaseIssuanceFault(workspace, "after-consume");
    }
    const ledgerEntry = prepareLedgerEntry({ event: "lease-issued", taskId: input.taskId, leaseRef: leaseId, summary: `Lease ${leaseId} issued for ${input.capability}.` });
    const existing = await getLease(workspace, leaseId).catch((error: unknown) => {
      if (error instanceof StinkyCobblerError && error.code === "LEASE_NOT_FOUND") return undefined;
      throw error;
    });
    if (existing !== undefined) {
      if (!leaseMatchesRequest(existing, input, authority, { readScope, writeSet, maxToolCalls, expiresInMinutes }, workspace.root)) {
        throw leaseError("LEASE_ISSUANCE_CONFLICT", "The prepared Lease ID already stores a different authority subject.", { leaseId });
      }
      if (!isLeaseCurrentlyActive(existing, now)) {
        throw leaseError("LEASE_REISSUE_REQUIRED", "A revoked or expired Lease issuance cannot be reused; issue a new authority subject or retry generation.", {
          leaseId,
          status: existing.status,
          expiresAt: existing.expiresAt
        });
      }
      if (parentContract !== undefined) {
        await reconcilePersistedContractLeaseAllocation(workspace, schemas, parentContract, existing, persistedLeases);
      }
      await ensureLeaseIssuedLedgerEntry(workspace, ledgerEntry);
      await commitLeaseIssuanceJournal(workspace, schemas, journal);
      return existing;
    }
    const lease: CapabilityLease = {
      id: leaseId,
      taskId: input.taskId,
      agentId: input.agentId,
      role: input.role,
      capability: input.capability,
      level: isWrite || isDocsIndex ? "L1" : "L0",
      workspace: workspace.root,
      readScope,
      writeSet,
      issuedBy: input.issuedBy ?? "user-confirmed",
      issuedAt: now.toISOString(),
      expiresAt,
      maxToolCalls,
      status: "active",
      parentGrantRef: authority.parentGrantRef,
      taskAuthorityHash: authority.taskAuthorityHash,
      approvalRefs: authority.approvalRefs,
      policyVersion: authority.policyVersion,
      hostSessionId: authority.hostSessionId,
      ...(input.subtaskRef === undefined ? {} : { subtaskRef: input.subtaskRef }),
      ...(input.subtaskAttempt === undefined ? {} : { subtaskAttempt: input.subtaskAttempt }),
      ...(input.planRef === undefined ? {} : { planRef: input.planRef }),
      ...(input.stepRef === undefined ? {} : { stepRef: input.stepRef }),
      ...(input.planGeneration === undefined ? {} : { planGeneration: input.planGeneration })
    };
    schemas.validate("lease", lease);
    if (parentContract !== undefined) {
      parentContract = await reserveContractLeaseAllocation(workspace, schemas, parentContract, lease, persistedLeases);
      maybeInjectLeaseIssuanceFault(workspace, "after-contract-allocation");
    }
    await createWorkspaceJson(workspace, fileName(lease.id), lease);
    if (parentContract !== undefined) {
      await reconcilePersistedContractLeaseAllocation(workspace, schemas, parentContract, lease, [...persistedLeases, lease]);
    }
    maybeInjectLeaseIssuanceFault(workspace, "after-lease");
    await ensureLeaseIssuedLedgerEntry(workspace, ledgerEntry);
    maybeInjectLeaseIssuanceFault(workspace, "after-ledger");
    await commitLeaseIssuanceJournal(workspace, schemas, journal);
    return lease;
  });
}

/** Test-only, single-use Lease issuance crash point. */
export function injectLeaseIssuanceFaultForTesting(
  workspace: LocalWorkspace,
  point: "after-journal" | "after-consume" | "after-contract-allocation" | "after-lease" | "after-ledger"
): void {
  if (process.env.NODE_ENV !== "test") throw leaseError("LEASE_ISSUANCE_TEST_FAULT_DENIED", "Lease issuance fault injection is available only under the test runner.");
  issuanceFaults.set(workspace.directory, point);
}

/** Test-only, single-use Lease revocation crash point. */
export function injectLeaseRevocationFaultForTesting(workspace: LocalWorkspace, point: "after-state"): void {
  if (process.env.NODE_ENV !== "test") throw leaseError("LEASE_REVOCATION_TEST_FAULT_DENIED", "Lease revocation fault injection is available only under the test runner.");
  revocationFaults.set(workspace.directory, point);
}

function maybeInjectLeaseIssuanceFault(
  workspace: LocalWorkspace,
  point: "after-journal" | "after-consume" | "after-contract-allocation" | "after-lease" | "after-ledger"
): void {
  if (issuanceFaults.get(workspace.directory) !== point) return;
  issuanceFaults.delete(workspace.directory);
  throw leaseError("LEASE_ISSUANCE_TEST_FAULT", `Injected Lease issuance fault at ${point}.`, { point });
}

function maybeInjectLeaseRevocationFault(workspace: LocalWorkspace, point: "after-state"): void {
  if (revocationFaults.get(workspace.directory) !== point) return;
  revocationFaults.delete(workspace.directory);
  throw leaseError("LEASE_REVOCATION_TEST_FAULT", `Injected Lease revocation fault at ${point}.`, { point });
}

export async function getLease(workspace: LocalWorkspace, id: string): Promise<CapabilityLease> {
  assertLeaseId(id);
  try {
    const value: unknown = JSON.parse(await readFile(await workspaceFile(workspace, fileName(id)), "utf8"));
    (await defaultSchemaRegistry()).validate("lease", value);
    const lease = value as CapabilityLease;
    if (lease.id !== id) throw leaseError("LEASE_INVALID", "Stored lease ID does not match its canonical lookup ID.", { leaseId: id, storedLeaseId: lease.id });
    return lease;
  } catch (error: unknown) {
    if (isCode(error, "ENOENT")) throw leaseError("LEASE_NOT_FOUND", "Lease does not exist.", { leaseId: id });
    if (error instanceof SyntaxError) throw leaseError("LEASE_INVALID", "Stored lease contains invalid JSON.", { leaseId: id });
    throw error;
  }
}

export async function listLeases(workspace: LocalWorkspace, taskId?: string): Promise<CapabilityLease[]> {
  let names: string[];
  try { names = await readdir(await workspaceFile(workspace, DIRECTORY)); } catch (error: unknown) { if (isCode(error, "ENOENT")) return []; throw error; }
  const values = await Promise.all(names.filter((name) => /^lease-[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$/.test(name)).sort().map((name) => getLease(workspace, name.slice(0, -5))));
  return taskId === undefined ? values : values.filter((lease) => lease.taskId === taskId);
}

/** Revokes an issued lease and exactly-once persists its audit entry, recovering a state-before-ledger crash. */
export async function revokeLease(workspace: LocalWorkspace, id: string, reason: string): Promise<CapabilityLease> {
  return withWorkspaceLock(workspace, async () => {
    if (!reason || reason.length > 512) throw leaseError("LEASE_REVOKE_REASON_INVALID", "Revocation reason must be 1-512 characters.");
    const current = await getLease(workspace, id);
    const reasonHash = auditTextFingerprint(reason);
    if (current.status === "revoked") {
      if (current.revocationReasonHash === undefined || current.revokedAt === undefined) {
        throw leaseError("LEASE_REVOCATION_METADATA_REQUIRED", "A legacy revoked Lease lacks the immutable metadata needed to safely replay revocation.", { leaseId: current.id });
      }
      if (current.revocationReasonHash !== reasonHash) {
        throw leaseError("LEASE_REVOCATION_CONFLICT", "A revoked Lease may only be retried with its original revocation reason.", { leaseId: current.id });
      }
      await ensureLeaseRevokedLedgerEntry(workspace, current);
      return current;
    }
    const next: CapabilityLease = {
      ...current,
      status: "revoked",
      revokedAt: new Date().toISOString(),
      revocationReasonHash: reasonHash
    };
    await writeWorkspaceJson(workspace, fileName(id), next);
    maybeInjectLeaseRevocationFault(workspace, "after-state");
    await ensureLeaseRevokedLedgerEntry(workspace, next);
    return next;
  });
}

function leaseIssuanceRequestHash(
  input: LeaseIssueInput,
  effective: {
    taskAuthorityHash: string;
    readScope: string[];
    writeSet: string[];
    maxToolCalls: number;
    expiresInMinutes: number;
  }
): string {
  const canonical = {
    version: 1,
    taskId: input.taskId,
    agentId: input.agentId,
    role: input.role,
    capability: input.capability,
    readScope: effective.readScope,
    writeSet: effective.writeSet,
    maxToolCalls: effective.maxToolCalls,
    expiresInMinutes: effective.expiresInMinutes,
    issuedBy: input.issuedBy ?? "user-confirmed",
    subtaskRef: input.subtaskRef ?? null,
    subtaskAttempt: input.subtaskAttempt ?? null,
    planRef: input.planRef ?? null,
    stepRef: input.stepRef ?? null,
    planGeneration: input.planGeneration ?? null,
    approvalRefs: [...(input.approvalRefs ?? [])].sort(),
    parentGrantRef: input.parentGrantRef ?? null,
    hostSessionId: input.hostSessionId ?? "local-cli",
    taskAuthorityHash: effective.taskAuthorityHash
  };
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex")}`;
}

function leaseIssuanceJournalId(requestHash: string): string {
  const digest = requestHash.slice("sha256:".length, "sha256:".length + 48);
  return `issuance-${digest.match(/.{1,12}/g)?.join("-") ?? digest}`;
}

function leaseIssuanceFile(journalId: string): string {
  return path.join(DIRECTORY, `${journalId}.json`);
}

async function findLeaseIssuanceJournal(workspace: LocalWorkspace, journalId: string): Promise<LeaseIssuanceJournal | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(await workspaceFile(workspace, leaseIssuanceFile(journalId)), "utf8"));
    (await defaultSchemaRegistry()).validate("lease-issuance", parsed);
    const journal = parsed as LeaseIssuanceJournal;
    if (journal.journalId !== journalId || journalId !== leaseIssuanceJournalId(journal.requestHash)) {
      throw leaseError("LEASE_ISSUANCE_CONFLICT", "Lease issuance journal identity is not bound to its request hash.", { journalId });
    }
    return journal;
  } catch (error: unknown) {
    if (isCode(error, "ENOENT")) return undefined;
    if (error instanceof SyntaxError) throw leaseError("LEASE_ISSUANCE_INVALID", "Lease issuance journal contains invalid JSON.", { journalId });
    throw error;
  }
}

async function commitLeaseIssuanceJournal(
  workspace: LocalWorkspace,
  schemas: SchemaRegistry,
  journal: LeaseIssuanceJournal
): Promise<void> {
  if (journal.status === "COMMITTED") return;
  const committedAt = new Date().toISOString();
  const next: LeaseIssuanceJournal = { ...journal, status: "COMMITTED", updatedAt: committedAt, committedAt };
  schemas.validate("lease-issuance", next);
  await writeWorkspaceJson(workspace, leaseIssuanceFile(journal.journalId), next);
}

function leaseMatchesRequest(
  lease: CapabilityLease,
  input: LeaseIssueInput,
  authority: Awaited<ReturnType<typeof admitTaskCapability>>,
  effective: { readScope: string[]; writeSet: string[]; maxToolCalls: number; expiresInMinutes: number },
  workspaceRoot: string
): boolean {
  const duration = Date.parse(lease.expiresAt) - Date.parse(lease.issuedAt);
  return lease.taskId === input.taskId && lease.agentId === input.agentId && lease.role === input.role &&
    lease.capability === input.capability && lease.workspace === workspaceRoot &&
    JSON.stringify(lease.readScope) === JSON.stringify(effective.readScope) &&
    JSON.stringify(lease.writeSet) === JSON.stringify(effective.writeSet) &&
    lease.maxToolCalls === effective.maxToolCalls && duration === effective.expiresInMinutes * 60_000 &&
    lease.issuedBy === (input.issuedBy ?? "user-confirmed") &&
    lease.subtaskRef === input.subtaskRef && lease.subtaskAttempt === input.subtaskAttempt && lease.planRef === input.planRef && lease.stepRef === input.stepRef &&
    lease.planGeneration === input.planGeneration && lease.parentGrantRef === authority.parentGrantRef &&
    lease.taskAuthorityHash === authority.taskAuthorityHash && lease.policyVersion === authority.policyVersion &&
    lease.hostSessionId === authority.hostSessionId &&
    JSON.stringify([...(lease.approvalRefs ?? [])].sort()) === JSON.stringify([...authority.approvalRefs].sort());
}

async function ensureLeaseIssuedLedgerEntry(workspace: LocalWorkspace, entry: AppendLedgerEntry): Promise<void> {
  const entries = await listLedgerEntries(workspace);
  if (entries.some((candidate) => candidate.event === "lease-issued" && candidate.leaseRef === entry.leaseRef)) return;
  await appendLedgerEntry(workspace, entry);
}

/**
 * Reserves a Contract's lifetime child-Lease allocation before the Lease bytes
 * are written. The pending entry makes a crash in that split state retry-safe:
 * the deterministic issuance journal reuses the same Lease ID and therefore
 * cannot increment the lifetime total twice.
 *
 * This function must run while the caller already owns the workspace lock.
 */
async function reserveContractLeaseAllocation(
  workspace: LocalWorkspace,
  schemas: SchemaRegistry,
  contract: TaskContract,
  lease: CapabilityLease,
  persistedLeases: CapabilityLease[]
): Promise<TaskContract> {
  const state = contractDelegationState(contract, persistedLeases);
  const reserved = state.pendingLeaseAllocations[lease.id];
  if (reserved !== undefined) {
    if (reserved !== lease.maxToolCalls) {
      throw leaseError("CONTRACT_BUDGET_ACCOUNTING_INVALID", "The pending Contract allocation does not match the deterministic Lease issuance.", {
        contractId: contract.contractId,
        leaseId: lease.id,
        reserved,
        requested: lease.maxToolCalls
      });
    }
    if (state.changed) await writeContractDelegationState(workspace, schemas, contract, state);
    return state.changed ? state.contract : contract;
  }
  if (state.lifetimeAllocatedToolCalls + lease.maxToolCalls > state.maxToolCalls) {
    throw leaseError("CONTRACT_BUDGET_EXCEEDED", "Child Lease allocations exceed the Contract lifetime tool-call budget.", {
      contractId: contract.contractId,
      allocated: state.lifetimeAllocatedToolCalls,
      requested: lease.maxToolCalls,
      limit: state.maxToolCalls
    });
  }
  if (Object.keys(state.pendingLeaseAllocations).length >= MAX_PENDING_CONTRACT_LEASE_ALLOCATIONS) {
    throw leaseError("CONTRACT_BUDGET_ACCOUNTING_CAP_REACHED", "The Contract has too many unresolved Lease allocation recoveries; retry or reconcile the existing issuances before issuing another Lease.", {
      contractId: contract.contractId,
      limit: MAX_PENDING_CONTRACT_LEASE_ALLOCATIONS
    });
  }
  const next: TaskContract = {
    ...state.contract,
    delegationBudget: {
      ...state.contract.delegationBudget!,
      lifetimeAllocatedToolCalls: state.lifetimeAllocatedToolCalls + lease.maxToolCalls,
      pendingLeaseAllocations: { ...state.pendingLeaseAllocations, [lease.id]: lease.maxToolCalls }
    }
  };
  schemas.validate("orchestration-contract", next);
  await writeWorkspaceJson(workspace, contractFileName(next.contractId), next);
  return next;
}

/** Finalizes a pre-Lease Contract reservation once the matching Lease is durable. */
async function reconcilePersistedContractLeaseAllocation(
  workspace: LocalWorkspace,
  schemas: SchemaRegistry,
  contract: TaskContract,
  lease: CapabilityLease,
  persistedLeases: CapabilityLease[]
): Promise<void> {
  const state = contractDelegationState(contract, persistedLeases);
  const pending = state.pendingLeaseAllocations[lease.id];
  if (pending !== undefined && pending !== lease.maxToolCalls) {
    throw leaseError("CONTRACT_BUDGET_ACCOUNTING_INVALID", "The pending Contract allocation does not match its persisted Lease.", {
      contractId: contract.contractId,
      leaseId: lease.id,
      pending,
      leaseMaxToolCalls: lease.maxToolCalls
    });
  }
  if (pending === undefined && !state.changed) return;
  const pendingLeaseAllocations = { ...state.pendingLeaseAllocations };
  delete pendingLeaseAllocations[lease.id];
  const next: TaskContract = {
    ...state.contract,
    delegationBudget: {
      ...state.contract.delegationBudget!,
      lifetimeAllocatedToolCalls: state.lifetimeAllocatedToolCalls,
      pendingLeaseAllocations
    }
  };
  schemas.validate("orchestration-contract", next);
  await writeWorkspaceJson(workspace, contractFileName(next.contractId), next);
}

function contractDelegationState(contract: TaskContract, persistedLeases: CapabilityLease[]): {
  contract: TaskContract;
  maxToolCalls: number;
  lifetimeAllocatedToolCalls: number;
  pendingLeaseAllocations: Record<string, number>;
  changed: boolean;
} {
  const budget = contract.delegationBudget;
  if (budget === undefined) {
    throw leaseError("CONTRACT_BUDGET_EXCEEDED", "The parent Contract has no delegation budget.", { contractId: contract.contractId });
  }
  const pendingLeaseAllocations = { ...(budget.pendingLeaseAllocations ?? {}) };
  const observedLeaseIds = new Set(persistedLeases
    .filter((candidate) => candidate.parentGrantRef === contract.contractId)
    .map((candidate) => candidate.id));
  const observedAllocated = sumContractAllocation(
    persistedLeases.filter((candidate) => candidate.parentGrantRef === contract.contractId).map((candidate) => candidate.maxToolCalls),
    contract.contractId
  );
  const outstandingPending = sumContractAllocation(
    Object.entries(pendingLeaseAllocations)
      .filter(([leaseId]) => !observedLeaseIds.has(leaseId))
      .map(([, allocation]) => allocation),
    contract.contractId
  );
  const persisted = budget.lifetimeAllocatedToolCalls;
  if (persisted !== undefined && (!Number.isSafeInteger(persisted) || persisted < observedAllocated + outstandingPending)) {
    throw leaseError("CONTRACT_BUDGET_ACCOUNTING_INVALID", "The Contract lifetime allocation counter is lower than its persisted Lease or recovery reservations.", {
      contractId: contract.contractId,
      lifetimeAllocatedToolCalls: persisted,
      observedAllocated,
      outstandingPending
    });
  }
  const lifetimeAllocatedToolCalls = persisted ?? observedAllocated + outstandingPending;
  return {
    contract: persisted === undefined
      ? { ...contract, delegationBudget: { ...budget, lifetimeAllocatedToolCalls, pendingLeaseAllocations } }
      : contract,
    maxToolCalls: budget.maxToolCalls,
    lifetimeAllocatedToolCalls,
    pendingLeaseAllocations,
    changed: persisted === undefined
  };
}

function sumContractAllocation(values: number[], contractId: string): number {
  let total = 0;
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value < 1 || total > Number.MAX_SAFE_INTEGER - value) {
      throw leaseError("CONTRACT_BUDGET_ACCOUNTING_INVALID", "The Contract allocation record is invalid.", { contractId });
    }
    total += value;
  }
  return total;
}

async function writeContractDelegationState(
  workspace: LocalWorkspace,
  schemas: SchemaRegistry,
  contract: TaskContract,
  state: ReturnType<typeof contractDelegationState>
): Promise<void> {
  schemas.validate("orchestration-contract", state.contract);
  await writeWorkspaceJson(workspace, contractFileName(contract.contractId), state.contract);
}

function contractFileName(contractId: string): string { return path.join("orchestration", `${contractId}.json`); }

async function ensureLeaseRevokedLedgerEntry(workspace: LocalWorkspace, lease: CapabilityLease): Promise<void> {
  if (lease.status !== "revoked" || lease.revocationReasonHash === undefined || lease.revokedAt === undefined) {
    throw leaseError("LEASE_REVOCATION_METADATA_REQUIRED", "A revoked Lease must retain immutable revocation metadata before its audit can be persisted.", { leaseId: lease.id });
  }
  const entry = prepareLedgerEntry({
    event: "lease-revoked",
    taskId: lease.taskId,
    leaseRef: lease.id,
    summary: `Lease ${lease.id} revoked; reason ${lease.revocationReasonHash}.`
  });
  const matches = (await listLedgerEntries(workspace)).filter((candidate) => candidate.event === "lease-revoked" && candidate.leaseRef === lease.id);
  if (matches.length === 0) {
    await appendLedgerEntry(workspace, entry);
    return;
  }
  if (matches.length !== 1 || matches[0]!.taskId !== entry.taskId || matches[0]!.summary !== entry.summary) {
    throw leaseError("LEASE_REVOCATION_AUDIT_CONFLICT", "The Lease revocation ledger evidence is not uniquely bound to its persisted revocation metadata.", { leaseId: lease.id, entries: matches.length });
  }
}

function isLeaseCurrentlyActive(lease: CapabilityLease, now: Date): boolean {
  const expiresAt = Date.parse(lease.expiresAt);
  return lease.status === "active" && Number.isFinite(expiresAt) && expiresAt > now.getTime();
}

function assertIssueInput(input: LeaseIssueInput, limits: { defaultToolCalls: number; defaultMinutes: number; maxToolCallsCap: number; maxMinutesCap: number; sensitiveExtraPaths?: string[] }): void {
  if (!input.taskId || !input.agentId || !input.role) throw leaseError("LEASE_ISSUE_INPUT_INVALID", "taskId, agentId, and role are required.");
  assertLeaseStringArraySize(input.readScope, "readScope", MAX_LEASE_READ_SCOPE_ITEMS, MAX_LEASE_SCOPE_OR_TARGET_LENGTH, "LEASE_READ_SCOPE_INVALID");
  assertLeaseStringArraySize(input.writeSet, "writeSet", MAX_LEASE_WRITE_SET_ITEMS, MAX_LEASE_SCOPE_OR_TARGET_LENGTH, "LEASE_WRITE_SET_INVALID");
  assertLeaseStringArraySize(input.approvalRefs, "approvalRefs", MAX_LEASE_APPROVAL_REFS, MAX_LEASE_APPROVAL_REF_LENGTH, "LEASE_APPROVAL_REFS_INVALID");
  for (const [field, value] of [["agentId", input.agentId], ["role", input.role], ["issuedBy", input.issuedBy]] as const) {
    if (value !== undefined && (value.length === 0 || value.length > 256 || /[\0\r\n]/.test(value))) {
      throw leaseError("LEASE_ISSUE_INPUT_INVALID", `${field} must be 1-256 characters without control line breaks.`, { field });
    }
  }
  if (!ISSUE_CAPABILITIES.has(input.capability)) throw leaseError("LEASE_CAPABILITY_DENIED", `Only supported repository capabilities may be issued: ${[...ISSUE_CAPABILITIES].sort().join(", ")}.`, { capability: input.capability });
  const planBindingCount = [input.planRef, input.stepRef, input.planGeneration].filter((value) => value !== undefined).length;
  if (planBindingCount !== 0 && planBindingCount !== 3) throw leaseError("LEASE_PLAN_BINDING_INVALID", "Plan-bound Leases require planRef, stepRef, and planGeneration together.");
  if (planBindingCount > 0 && (input.subtaskRef !== undefined || input.subtaskAttempt !== undefined)) throw leaseError("LEASE_PLAN_BINDING_INVALID", "A Lease cannot be bound to both a Plan step and an orchestration subtask.");
  if (input.planGeneration !== undefined && (!Number.isSafeInteger(input.planGeneration) || input.planGeneration < 1)) throw leaseError("LEASE_PLAN_BINDING_INVALID", "planGeneration must be a positive safe integer.");
  if (input.subtaskRef !== undefined && (!Number.isSafeInteger(input.subtaskAttempt) || (input.subtaskAttempt ?? -1) < 0)) {
    throw leaseError("LEASE_SUBTASK_BINDING_INVALID", "Subtask-bound Leases require a non-negative safe-integer subtaskAttempt.");
  }
  if (input.subtaskRef === undefined && input.subtaskAttempt !== undefined) {
    throw leaseError("LEASE_SUBTASK_BINDING_INVALID", "subtaskAttempt requires subtaskRef.");
  }
  const maxToolCalls = input.maxToolCalls ?? limits.defaultToolCalls;
  if (!Number.isSafeInteger(maxToolCalls) || maxToolCalls < 1 || maxToolCalls > limits.maxToolCallsCap) throw leaseError("LEASE_MAX_TOOL_CALLS_INVALID", `maxToolCalls must be between 1 and ${limits.maxToolCallsCap}.`, { maxToolCalls });
  const expiresInMinutes = input.expiresInMinutes ?? limits.defaultMinutes;
  if (!Number.isSafeInteger(expiresInMinutes) || expiresInMinutes < 1 || expiresInMinutes > limits.maxMinutesCap) throw leaseError("LEASE_EXPIRES_IN_INVALID", `expiresInMinutes must be between 1 and ${limits.maxMinutesCap}.`, { expiresInMinutes });
  for (const scope of input.readScope ?? ["."]) {
    if (!scope || scope.includes("\0") || scope.startsWith("/") || scope.split(/[\\/]/).includes("..") || scope === ".stinky-cobbler" || scope.startsWith(".stinky-cobbler/")) {
      throw leaseError("LEASE_READ_SCOPE_INVALID", "Read scopes must be workspace-relative and must not cover the control-plane directory.", { scope });
    }
    try {
      assertWorkspacePathPolicy(scope, { ...(limits.sensitiveExtraPaths === undefined ? {} : { sensitiveExtraPaths: limits.sensitiveExtraPaths }) });
    } catch {
      throw leaseError("LEASE_READ_SCOPE_INVALID", "Read scopes must not cover reserved or sensitive workspace paths.", { scope });
    }
  }
  if (input.capability === "repository-write") {
    if (!input.writeSet || input.writeSet.length === 0) throw leaseError("LEASE_WRITE_SET_REQUIRED", "A repository-write lease requires a non-empty writeSet.");
    // A Lease may cover several future single-target intents. Validate every
    // target independently; do not accidentally turn the WriteIntent
    // single-target transaction rule into a Lease-wide one-target limit.
    for (const target of input.writeSet) {
      assertWrites(
        [{ target, action: "modify", purpose: "Whitelisted write target." }],
        limits.sensitiveExtraPaths
      );
    }
    if (new Set(input.writeSet).size !== input.writeSet.length) {
      throw leaseError("LEASE_WRITE_SET_DUPLICATE", "A repository-write Lease writeSet must not contain duplicate targets.", { writeSet: input.writeSet });
    }
  } else if (input.capability === "docs-index") {
    if (input.writeSet !== undefined && (input.writeSet.length !== 1 || input.writeSet[0] !== DOCS_INDEX_WRITE_TARGET)) {
      throw leaseError("LEASE_WRITE_SET_DENIED", `A docs-index lease has a fixed writeSet of ${DOCS_INDEX_WRITE_TARGET}.`, { writeSet: input.writeSet });
    }
  } else if (input.writeSet !== undefined && input.writeSet.length > 0) {
    throw leaseError("LEASE_WRITE_SET_DENIED", "Only repository-write and docs-index leases may have a writeSet.", { capability: input.capability });
  }
}

function assertRoleMayGrantCapability(input: LeaseIssueInput, registries: Registries): void {
  if (input.role === ORCHESTRATION_WORKER_ROLE) {
    if (
      input.subtaskRef === undefined || !Number.isSafeInteger(input.subtaskAttempt) ||
      input.parentGrantRef?.startsWith("contract-") !== true || input.issuedBy !== "orchestration-derived"
    ) {
      throw leaseError("LEASE_WORKER_BINDING_INVALID", "The internal worker role may only receive an orchestration-derived, attempt-bound subtask Lease.", {
        role: input.role,
        capability: input.capability
      });
    }
    return;
  }
  if (registries.roles.roles[input.role] === undefined) {
    throw leaseError("LEASE_ROLE_UNKNOWN", "A Lease may only be issued to a role in the canonical role registry.", { role: input.role });
  }
  const permitted = registries.roleTools[input.role];
  if (!Array.isArray(permitted)) {
    throw leaseError("LEASE_ROLE_TOOLS_UNAVAILABLE", "The Lease role has no explicit role-to-tools policy entry.", { role: input.role });
  }
  if (!permitted.includes(input.capability)) {
    throw leaseError("LEASE_ROLE_CAPABILITY_DENIED", "The role-to-tools policy does not permit this Lease capability.", {
      role: input.role,
      capability: input.capability
    });
  }
}

function assertLeaseStringArraySize(value: string[] | undefined, field: string, maxItems: number, maxItemLength: number, code: string): void {
  if (value === undefined) return;
  if (value.length > maxItems) throw leaseError(code, `${field} exceeds the canonical input size limit.`, { field, maxItems, items: value.length });
  const index = value.findIndex((item) => item.length > maxItemLength);
  if (index !== -1) throw leaseError(code, `${field} exceeds the canonical input size limit.`, { field, maxItemLength, index, length: value[index]!.length });
}

function assertLeaseId(id: string): void { if (!ID_PATTERN.test(id)) throw leaseError("LEASE_INVALID", "Lease ID is invalid.", { leaseId: id }); }
function fileName(id: string): string { return path.join(DIRECTORY, `${id}.json`); }
function leaseError(code: string, message: string, details: Record<string, unknown> = {}): StinkyCobblerError { return new StinkyCobblerError(code, ExitCode.VALIDATION, message, details); }
function isCode(error: unknown, code: string): boolean { return typeof error === "object" && error !== null && "code" in error && error.code === code; }
