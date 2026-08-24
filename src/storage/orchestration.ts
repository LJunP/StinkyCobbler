import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { SchemaRegistry } from "../contracts/schema-registry.js";
import { defaultSchemaRegistry } from "../contracts/default-schema-registry.js";
import type {
  Artifact, ContractStatus, Defect, OrchestrationRun, ReviewRecord, SubtaskPackage, TaskContract,
  ValidatorArtifactObservation, ValidatorEvidence
} from "../contracts/orchestration.js";
import {
  DEFAULT_MAX_RETRIES_PER_SUBTASK, DEFAULT_MAX_ROUNDS, DEFAULT_MAX_SUBTASK_TOKENS,
  MAX_CONTRACT_CRITERIA, MAX_CONTRACT_SCOPE, MAX_DEFECTS, MAX_DOMAIN_INSTRUCTIONS, MAX_DOMAIN_LENGTH,
  MAX_INPUT_ARTIFACTS, MAX_REVIEW_TOKENS, MAX_RUN_ARTIFACTS, MAX_RUN_REVIEWS, MAX_RUN_SUBTASKS,
  MAX_SUBTASK_ARTIFACTS, MAX_SUBTASK_CRITERIA, MAX_SUBTASK_SCOPE
} from "../contracts/orchestration.js";
import { domainInstructionsFor } from "./specialists.js";
import { ExitCode, StinkyCobblerError } from "../errors.js";
import { loadOrchestrationConfig, type OrchestrationConfig } from "../config/tiered.js";
import { loadRegistries, type Registries } from "../config/registry.js";
import { loadWorkspaceConfig } from "../config/workspace.js";
import { appendLedgerEntry, auditTextFingerprint, listLedgerEntries, prepareLedgerEntry, type AppendLedgerEntry } from "./ledger.js";
import { issueLease } from "./leases.js";
import { listLeases, revokeLease } from "./leases.js";
import { artifactInScope, evaluateConstraints } from "../policy/orchestration-constraints.js";
import type { LocalWorkspace } from "./workspace.js";
import { createWorkspaceJson, workspaceFile, writeWorkspaceJson } from "./workspace.js";
import { withWorkspaceLock } from "./workspace-lock.js";
import { beginRunCancellation, completeRunCancellation, getRunCancellationFence } from "./orchestration-fence.js";
import {
  assertWorkspacePathPolicy, readBoundedWorkspaceFile, resolveWorkspacePath, WorkspaceReadBoundaryError
} from "../security/workspace-path.js";
import { listWriteIntents } from "./write-intents.js";
import {
  assertValidatorReceiptBinding, getValidatorReceipt, prepareRegisteredValidatorReceipts
} from "./orchestration-validator-receipts.js";
import {
  abortOrchestrationTransactionForCancellation, completionTransactionId, findOrchestrationTransaction, listOrchestrationTransactions,
  escalationTransactionId, orchestrationLedgerEffect, orchestrationRecordHash, orchestrationRequestHash, orchestrationTransactionTargetsAreIntended,
  prepareOrchestrationTransaction, reconcileOrchestrationTransaction, reviewIdForTransaction,
  reviewTransactionId, type CompletionTransaction, type OrchestrationLedgerEffect,
  type EscalationTransaction, type ReviewTransaction
} from "./orchestration-transactions.js";
import { admitPersistedContractAuthority, admitTaskCapability, hashTaskAuthority } from "./task-authority.js";
import { consumeApproval } from "./approvals.js";
import { getTask } from "./tasks.js";

const DIRECTORY = "orchestration";
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ISSUE_CAPABILITIES = new Set(["repository-read", "git-read", "docs-index", "repository-write"]);
const EXECUTABLE_RUN_STATUSES = new Set<OrchestrationRun["status"]>(["RUNNING", "DEGRADED"]);
const ACTIVE_RUN_STATUSES = new Set<OrchestrationRun["status"]>(["DRAFT", "RUNNING", "DEGRADED", "ESCALATED"]);
const ACTIVE_ATTEMPT_STATUSES = new Set<SubtaskPackage["status"]>(["DISPATCHED", "RUNNING", "REVIEWING"]);
const PACKAGE_ROOT = path.resolve(import.meta.dirname, "../..");
const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;
const MAX_SUBTASK_CREATION_SCAN_FILES = 4096;
let canonicalRegistriesPromise: Promise<Registries> | undefined;
const contractCreationFaults = new Map<string, "after-consume" | "after-contract" | "after-ledger">();
const contractStatusFaults = new Map<string, "after-contract">();
const cancellationFaults = new Map<string, "after-fence" | "after-run" | "after-ledger">();
const artifactReportingFaults = new Map<string, "after-artifact" | "after-run" | "after-ledger">();
const subtaskCreationFaults = new Map<string, "after-subtask" | "after-run">();
export type OrchestrationActivationFaultPoint = "after-run" | "after-subtask" | "after-ledger";
const orchestrationActivationFaults = new Map<string, OrchestrationActivationFaultPoint>();

/** Test-only, single-use crash point for executable orchestration activation. */
export function injectOrchestrationActivationFaultForTesting(
  workspace: LocalWorkspace,
  point: OrchestrationActivationFaultPoint
): void {
  if (process.env.NODE_ENV !== "test") {
    throw orchError("ORCHESTRATION_ACTIVATION_TEST_FAULT_DENIED", "Orchestration activation fault injection is available only under the test runner.");
  }
  orchestrationActivationFaults.set(workspace.directory, point);
}

function maybeInjectOrchestrationActivationFault(
  workspace: LocalWorkspace,
  point: OrchestrationActivationFaultPoint,
  subjectId: string
): void {
  if (orchestrationActivationFaults.get(workspace.directory) !== point) return;
  orchestrationActivationFaults.delete(workspace.directory);
  throw orchError("ORCHESTRATION_ACTIVATION_TEST_FAULT", `Injected orchestration activation fault at ${point}.`, { point, subjectId });
}

/* ------------------------------------------------------------------ */
/* TaskContract                                                        */
/* ------------------------------------------------------------------ */

export interface CreateContractInput {
  taskId: string;
  /** Confirmed domain (user confirmed/refined before creation); routes subtasks to the specialist profile. */
  domain: string;
  goal: string;
  globalAcceptanceCriteria: string[];
  scope: string[];
  approvalRefs?: string[];
  hostSessionId?: string;
}

/** Creates the immutable task contract (contract anchor). Ledger: contract-created. */
export async function createContract(workspace: LocalWorkspace, schemas: SchemaRegistry, input: CreateContractInput): Promise<TaskContract> {
  return withWorkspaceLock(workspace, async () => {
    const cfg = await loadOrchestrationConfig(workspace);
    assertContractInput(input, cfg);
    // A Contract is the business commit for this operation. If the process
    // died after creating it but before appending its ledger event, recover the
    // exact deterministic request from the immutable Contract itself. Current
    // Task/Approval/config drift must not make that audit-only repair
    // impossible; it still fences every *new* Contract below.
    const recoverable = await findUnloggedContractForRequest(workspace, input);
    if (recoverable !== undefined) {
      await ensureContractCreatedLedgerEntry(workspace, recoverable);
      return recoverable;
    }
    const task = await getTask(workspace, input.taskId);
    const expectedTaskAuthorityHash = hashTaskAuthority(task);
    const reviewPolicy = await resolveContractReviewPolicy(workspace);
    const contractId = contractIdForRequest(input, expectedTaskAuthorityHash, reviewPolicy);
    const authority = await admitTaskCapability(workspace, {
      taskId: input.taskId,
      capability: "orchestration-control",
      readScope: input.scope,
      approvalRefs: input.approvalRefs ?? [],
      maxToolCalls: 1,
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      hostSessionId: input.hostSessionId ?? "local-cli",
      expectedTaskAuthorityHash,
      approvalConsumptionOwner: contractId
    });
    await mkdir(await workspaceFile(workspace, DIRECTORY), { recursive: true, mode: 0o700 });
    const initialDelegationBudget = authority.matchedApprovalBudget ?? {
      maxToolCalls: cfg.defaults?.leaseMaxToolCallsCap ?? 100,
      expiresAt: new Date(Date.now() + (cfg.defaults?.leaseMaxMinutes ?? 1440) * 60_000).toISOString()
    };
    const delegationBudget = {
      ...initialDelegationBudget,
      lifetimeAllocatedToolCalls: 0,
      pendingLeaseAllocations: {}
    };
    if (authority.matchedApprovalRef !== undefined) {
      await consumeApproval(workspace, schemas, authority.matchedApprovalRef, contractId);
      maybeInjectContractCreationFault(workspace, "after-consume");
    }
    const existing = await getContract(workspace, contractId).catch((error: unknown) => {
      if (error instanceof StinkyCobblerError && error.code === "CONTRACT_NOT_FOUND") return undefined;
      throw error;
    });
    if (existing !== undefined) {
      if (!contractMatchesRequest(existing, input, authority, reviewPolicy)) {
        throw orchError("CONTRACT_IDEMPOTENCY_CONFLICT", "The deterministic Contract request ID already stores a different subject.", { contractId });
      }
      await ensureContractCreatedLedgerEntry(workspace, existing);
      return existing;
    }
    const contract: TaskContract = {
      version: 1,
      contractId,
      taskId: input.taskId,
      domain: input.domain,
      goal: input.goal,
      globalAcceptanceCriteria: input.globalAcceptanceCriteria,
      scope: input.scope,
      createdAt: new Date().toISOString(),
      status: "ACTIVE",
      taskAuthorityHash: authority.taskAuthorityHash,
      approvalRefs: authority.approvalRefs,
      policyVersion: authority.policyVersion,
      hostSessionId: authority.hostSessionId,
      reviewPolicy,
      delegationBudget
    };
    schemas.validate("orchestration-contract", contract);
    await createWorkspaceJson(workspace, contractFile(contract.contractId), contract);
    maybeInjectContractCreationFault(workspace, "after-contract");
    await ensureContractCreatedLedgerEntry(workspace, contract);
    maybeInjectContractCreationFault(workspace, "after-ledger");
    return contract;
  });
}

/** Test-only, single-use Contract creation crash point. */
export function injectContractCreationFaultForTesting(
  workspace: LocalWorkspace,
  point: "after-consume" | "after-contract" | "after-ledger"
): void {
  if (process.env.NODE_ENV !== "test") throw orchError("CONTRACT_CREATION_TEST_FAULT_DENIED", "Contract creation fault injection is available only under the test runner.");
  contractCreationFaults.set(workspace.directory, point);
}

function maybeInjectContractCreationFault(
  workspace: LocalWorkspace,
  point: "after-consume" | "after-contract" | "after-ledger"
): void {
  if (contractCreationFaults.get(workspace.directory) !== point) return;
  contractCreationFaults.delete(workspace.directory);
  throw orchError("CONTRACT_CREATION_TEST_FAULT", `Injected Contract creation fault at ${point}.`, { point });
}

export async function getContract(workspace: LocalWorkspace, contractId: string): Promise<TaskContract> {
  assertId(contractId, "CONTRACT_ID_INVALID");
  try {
    const value: unknown = JSON.parse(await readFile(await workspaceFile(workspace, contractFile(contractId)), "utf8"));
    (await defaultSchemaRegistry()).validate("orchestration-contract", value);
    const contract = value as TaskContract;
    if (contract.contractId !== contractId) {
      throw orchError("CONTRACT_ID_MISMATCH", "Stored Contract ID does not match its canonical lookup ID.", {
        contractId,
        storedContractId: contract.contractId
      });
    }
    return contract;
  } catch (error: unknown) {
    if (isCode(error, "ENOENT")) throw orchError("CONTRACT_NOT_FOUND", "Contract does not exist.", { contractId });
    throw error;
  }
}

export async function listContracts(workspace: LocalWorkspace): Promise<TaskContract[]> {
  return (await listAllContracts(workspace)).filter((contract) => contract.status === "ACTIVE");
}

async function listAllContracts(workspace: LocalWorkspace): Promise<TaskContract[]> {
  let names: string[];
  try { names = await readdir(await workspaceFile(workspace, DIRECTORY)); } catch (error: unknown) { if (isCode(error, "ENOENT")) return []; throw error; }
  return Promise.all(names.filter((name) => /^contract-[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$/.test(name)).sort().map((name) => getContract(workspace, name.slice(0, -5))));
}

export async function updateContractStatus(workspace: LocalWorkspace, schemas: SchemaRegistry, contractId: string, status: ContractStatus): Promise<TaskContract> {
  return withWorkspaceLock(workspace, async () => {
    const current = await getContract(workspace, contractId);
    if (current.status === status) {
      if (status === "CANCELLED" || status === "FAILED") await ensureContractTerminalLedgerEntry(workspace, current, status);
      return current;
    }
    if (current.status !== "ACTIVE") {
      throw orchError("CONTRACT_STATE_CONFLICT", "A terminal Contract cannot transition to another status.", { contractId, currentStatus: current.status, requestedStatus: status });
    }
    if (status === "COMPLETED") {
      throw orchError("CONTRACT_COMPLETION_GATE", "Contract completion is owned by orchestration round complete; accepted subtasks, global-criteria coverage, and a passed consistency check are required.", { contractId });
    }
    if (status === "ACTIVE") return current;
    const activeRuns = (await listRuns(workspace, contractId)).filter((run) => ACTIVE_RUN_STATUSES.has(run.status));
    if (activeRuns.length > 0) {
      throw orchError("CONTRACT_ACTIVE_RUN", "Cancel every active Run before terminating its Contract.", {
        contractId,
        runIds: activeRuns.map((run) => run.runId)
      });
    }
    const next = { ...current, status };
    schemas.validate("orchestration-contract", next);
    const ledgerEntry = contractTerminalLedgerEntry(current, status);
    await writeWorkspaceJson(workspace, contractFile(contractId), next);
    maybeInjectContractStatusFault(workspace, "after-contract");
    await ensureContractTerminalLedgerEntry(workspace, next, status, ledgerEntry);
    return next;
  });
}

/** Test-only, single-use Contract terminal split-write crash point. */
export function injectContractStatusFaultForTesting(workspace: LocalWorkspace, point: "after-contract"): void {
  if (process.env.NODE_ENV !== "test") throw orchError("CONTRACT_STATUS_TEST_FAULT_DENIED", "Contract status fault injection is available only under the test runner.");
  contractStatusFaults.set(workspace.directory, point);
}

function maybeInjectContractStatusFault(workspace: LocalWorkspace, point: "after-contract"): void {
  if (contractStatusFaults.get(workspace.directory) !== point) return;
  contractStatusFaults.delete(workspace.directory);
  throw orchError("CONTRACT_STATUS_TEST_FAULT", `Injected Contract status fault at ${point}.`, { point });
}

/** Complexity adaptation: simple contracts recommend the direct (1.0 plan) path. */
export function recommendExecutionMode(contract: TaskContract): { mode: "direct" | "orchestrate"; reason: string } {
  const firstScope = contract.scope[0];
  const simple = contract.globalAcceptanceCriteria.length <= 3 && contract.scope.length === 1 && firstScope !== undefined && !firstScope.includes("/");
  if (simple) {
    return { mode: "direct", reason: "Simple contract (few criteria, single-file scope): direct execution costs less than orchestration." };
  }
  return { mode: "orchestrate", reason: "Complex contract: orchestration with review gates pays off." };
}

/* ------------------------------------------------------------------ */
/* OrchestrationRun                                                    */
/* ------------------------------------------------------------------ */

export interface CreateRunInput {
  contractRef: string;
  /** Required when this Run intentionally succeeds a terminal Run under the same Contract. */
  supersedesRunRef?: string;
  maxRounds?: number;
  maxRetriesPerSubtask?: number;
  maxSubtaskTokens?: number;
  failFast?: boolean;
}

/** Creates the orchestration run. Ledger: run-created. */
export async function createRun(workspace: LocalWorkspace, schemas: SchemaRegistry, input: CreateRunInput): Promise<OrchestrationRun> {
  return withWorkspaceLock(workspace, async () => {
    assertCreateRunRequestShape(input);
    let contract = await getContract(workspace, input.contractRef);
    // A prior process may have stopped after publishing a PREPARED journal or
    // one side of a completion transition. Reconcile only unfinished journals
    // before deciding whether another Run can be admitted. A COMMITTED round is
    // immutable history: replaying its old mutable target after the Run has a
    // legitimate successor (later round/cancellation/failure) would be a
    // rollback attempt, not recovery.
    const transactions = (await listOrchestrationTransactions(workspace))
      .filter((transaction) => transaction.contractRef === contract.contractId);
    for (const transaction of transactions) {
      if (transaction.status === "PREPARED") {
        const reconciled = await reconcileOrchestrationTransaction(workspace, schemas, transaction.transactionId);
        if (reconciled.kind === "REVIEW") await revokeCompletedAttemptLeases(workspace, reconciled);
      }
    }
    contract = await getContract(workspace, input.contractRef);
    const creationRequestHash = hashRunCreationRequest(input, contract);
    const historicalRuns = await listRuns(workspace, contract.contractId);
    const exactRuns = historicalRuns.filter((candidate) => candidate.creationRequestHash === creationRequestHash);
    if (exactRuns.length > 1) {
      throw orchError("RUN_CREATION_RECOVERY_CONFLICT", "Multiple Runs match the same exact creation request.", {
        contractId: contract.contractId,
        creationRequestHash,
        runIds: exactRuns.map((candidate) => candidate.runId)
      });
    }
    const exact = exactRuns[0];
    if (exact !== undefined) {
      await ensureRunCreatedLedgerEntry(workspace, contract, exact);
      return exact;
    }
    if (contract.status !== "ACTIVE") throw orchError("CONTRACT_NOT_ACTIVE", "Contract must be ACTIVE to create a run.", { contractId: input.contractRef });
    assertCurrentContractAuthority(contract);
    await admitTaskCapability(workspace, {
      taskId: contract.taskId,
      capability: "orchestration-control",
      readScope: contract.scope,
      approvalRefs: contract.approvalRefs,
      parentGrantRef: contract.contractId,
      expectedTaskAuthorityHash: contract.taskAuthorityHash,
      policyVersion: contract.policyVersion,
      maxToolCalls: 1,
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      hostSessionId: contract.hostSessionId,
      allowApprovalScopeSuperset: true
    });
    const cfg = await loadOrchestrationConfig(workspace);
    const budget = {
      maxRounds: input.maxRounds ?? cfg.defaults?.maxRounds ?? DEFAULT_MAX_ROUNDS,
      maxRetriesPerSubtask: input.maxRetriesPerSubtask ?? cfg.defaults?.maxRetriesPerSubtask ?? DEFAULT_MAX_RETRIES_PER_SUBTASK,
      maxSubtaskTokens: input.maxSubtaskTokens ?? cfg.defaults?.maxSubtaskTokens ?? DEFAULT_MAX_SUBTASK_TOKENS,
      usedTokens: 0
    };
    assertRunBudget(budget, "RUN_BUDGET_INVALID");
    const splitCompletion = historicalRuns.find((candidate) => candidate.status === "COMPLETED");
    if (splitCompletion !== undefined) {
      throw orchError("ORCHESTRATION_COMPLETION_SPLIT", "A historical Run is COMPLETED while its Contract remains ACTIVE; no new Run can be created without a bound completion transaction recovery.", {
        contractId: contract.contractId,
        completedRunId: splitCompletion.runId
      });
    }
    const active = historicalRuns.find((candidate) => ACTIVE_RUN_STATUSES.has(candidate.status));
    if (active !== undefined) {
      throw orchError("ACTIVE_RUN_CONFLICT", "Only one active orchestration run may exist for a contract.", {
        contractId: contract.contractId,
        activeRunId: active.runId,
        activeRunStatus: active.status
      });
    }
    const terminalRuns = historicalRuns.filter((candidate) => !ACTIVE_RUN_STATUSES.has(candidate.status));
    if (terminalRuns.length === 0 && input.supersedesRunRef !== undefined) {
      throw orchError("RUN_SUCCESSOR_BINDING_INVALID", "An initial Run must not declare a predecessor.", {
        contractId: contract.contractId,
        supersedesRunRef: input.supersedesRunRef
      });
    }
    if (terminalRuns.length > 0) {
      if (input.supersedesRunRef === undefined) {
        throw orchError("RUN_SUCCESSOR_BINDING_REQUIRED", "Creating a successor Run requires the exact terminal predecessor ID.", {
          contractId: contract.contractId,
          terminalRunIds: terminalRuns.map((candidate) => candidate.runId)
        });
      }
      const predecessor = terminalRuns.find((candidate) => candidate.runId === input.supersedesRunRef);
      if (predecessor === undefined) {
        throw orchError("RUN_SUCCESSOR_BINDING_INVALID", "The declared predecessor is not a terminal Run under this Contract.", {
          contractId: contract.contractId,
          supersedesRunRef: input.supersedesRunRef
        });
      }
      const newer = historicalRuns.some((candidate) => candidate.supersedesRunRef === predecessor.runId);
      if (newer) {
        throw orchError("RUN_SUCCESSOR_BINDING_CONFLICT", "The declared predecessor already has a successor Run.", {
          contractId: contract.contractId,
          supersedesRunRef: predecessor.runId
        });
      }
    }
    const run: OrchestrationRun = {
      version: 1,
      runId: `run-${randomUUID()}`,
      contractRef: contract.contractId,
      creationRequestHash,
      ...(input.supersedesRunRef === undefined ? {} : { supersedesRunRef: input.supersedesRunRef }),
      status: "RUNNING",
      round: 0,
      budget,
      subtasks: [],
      artifacts: [],
      reviews: [],
      goalConsistency: [],
      resumeGeneration: 0,
      createdAt: new Date().toISOString(),
      ...(input.failFast === undefined ? {} : { failFast: input.failFast })
    };
    schemas.validate("orchestration-run", run);
    await mkdir(await workspaceFile(workspace, DIRECTORY), { recursive: true, mode: 0o700 });
    await createWorkspaceJson(workspace, runFile(run.runId), run);
    maybeInjectOrchestrationActivationFault(workspace, "after-run", run.runId);
    await ensureRunCreatedLedgerEntry(workspace, contract, run);
    maybeInjectOrchestrationActivationFault(workspace, "after-ledger", run.runId);
    return run;
  });
}

export async function getRun(workspace: LocalWorkspace, runId: string): Promise<OrchestrationRun> {
  assertId(runId, "RUN_ID_INVALID");
  try {
    const value: unknown = JSON.parse(await readFile(await workspaceFile(workspace, runFile(runId)), "utf8"));
    (await defaultSchemaRegistry()).validate("orchestration-run", value);
    const run = value as OrchestrationRun;
    if (run.runId !== runId) {
      throw orchError("RUN_ID_MISMATCH", "Stored Run ID does not match its canonical lookup ID.", {
        runId,
        storedRunId: run.runId
      });
    }
    return run;
  } catch (error: unknown) {
    if (isCode(error, "ENOENT")) throw orchError("RUN_NOT_FOUND", "Orchestration run does not exist.", { runId });
    throw error;
  }
}

export async function listRuns(workspace: LocalWorkspace, contractRef?: string): Promise<OrchestrationRun[]> {
  let names: string[];
  try { names = await readdir(await workspaceFile(workspace, DIRECTORY)); } catch (error: unknown) { if (isCode(error, "ENOENT")) return []; throw error; }
  const values = await Promise.all(names.filter((name) => /^run-[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$/.test(name)).sort().map((name) => getRun(workspace, name.slice(0, -5))));
  return contractRef === undefined ? values : values.filter((run) => run.contractRef === contractRef);
}

/* ------------------------------------------------------------------ */
/* SubtaskPackage                                                      */
/* ------------------------------------------------------------------ */

export interface AddSubtaskInput {
  goal: string;
  /** Input artifact ids; content hashes are loaded from storage (engine-authoritative). */
  inputArtifactIds: string[];
  acceptanceCriteria: string[];
  scope: string[];
  capabilities: string[];
  dependsOn?: string[];
  maxRetries?: number;
  /** Optional sub-domain narrowing (e.g. "frontend/forms"); defaults to the contract domain. */
  domain?: string;
  /** Retry exhaustion of this subtask fails the whole run when true. */
  critical?: boolean;
}

/** Test-only, single-use crash point for Subtask target/Run membership ordering. */
export function injectSubtaskCreationFaultForTesting(workspace: LocalWorkspace, point: "after-subtask" | "after-run"): void {
  if (process.env.NODE_ENV !== "test") throw orchError("SUBTASK_CREATION_TEST_FAULT_DENIED", "Subtask creation fault injection is available only under the test runner.");
  subtaskCreationFaults.set(workspace.directory, point);
}

function maybeInjectSubtaskCreationFault(workspace: LocalWorkspace, point: "after-subtask" | "after-run", subtaskId: string): void {
  if (subtaskCreationFaults.get(workspace.directory) !== point) return;
  subtaskCreationFaults.delete(workspace.directory);
  throw orchError("SUBTASK_CREATION_TEST_FAULT", `Injected Subtask creation fault at ${point}.`, { point, subtaskId });
}

/** Adds a subtask to the run (PENDING). Ledger: none (dispatch records). */
export async function addSubtask(workspace: LocalWorkspace, schemas: SchemaRegistry, runId: string, input: AddSubtaskInput): Promise<SubtaskPackage> {
  return withWorkspaceLock(workspace, async () => {
    const cfg = await loadOrchestrationConfig(workspace);
    const run = await getRun(workspace, runId);
    const contract = await getActiveContractForRun(workspace, run);
    if (!EXECUTABLE_RUN_STATUSES.has(run.status) && run.status !== "DRAFT") throw orchError("RUN_STATE_CONFLICT", "Subtasks can only be added to an executable run.", { runId, status: run.status });
    assertExecutionBudgetAvailable(run);
    await assertRunNotCancelling(workspace, runId);
    if (input.capabilities.length === 0 || !input.capabilities.every((cap) => ISSUE_CAPABILITIES.has(cap))) {
      throw orchError("SUBTASK_CAPABILITY_INVALID", "Subtask capabilities must be non-empty and within the issuable set.", { capabilities: input.capabilities });
    }
    if (new Set(input.capabilities).size !== input.capabilities.length) {
      throw orchError("SUBTASK_CAPABILITY_INVALID", "Subtask capabilities must be unique.", { capabilities: input.capabilities });
    }
    if (input.goal.length < 1 || input.goal.length > 512) throw orchError("SUBTASK_GOAL_INVALID", "Subtask goal must be 1-512 characters.");
    const maxSubtaskCriteria = cfg.defaults?.maxSubtaskCriteria ?? MAX_SUBTASK_CRITERIA;
    const maxSubtaskScope = cfg.defaults?.maxSubtaskScopeItems ?? MAX_SUBTASK_SCOPE;
    const maxInputArtifacts = cfg.defaults?.maxInputArtifacts ?? MAX_INPUT_ARTIFACTS;
    const maxRetries = input.maxRetries ?? run.budget.maxRetriesPerSubtask;
    if (!Number.isSafeInteger(maxRetries) || maxRetries < 0 || maxRetries > run.budget.maxRetriesPerSubtask) {
      throw orchError("SUBTASK_RETRY_BUDGET_INVALID", "Subtask maxRetries must be a non-negative integer no greater than the run retry budget.", { maxRetries, runMaxRetriesPerSubtask: run.budget.maxRetriesPerSubtask });
    }
    if (input.acceptanceCriteria.length < 1 || input.acceptanceCriteria.length > maxSubtaskCriteria) throw orchError("SUBTASK_CRITERIA_INVALID", `Subtask acceptance criteria must be 1-${maxSubtaskCriteria} items.`);
    if (input.scope.length < 1 || input.scope.length > maxSubtaskScope) throw orchError("SUBTASK_SCOPE_INVALID", `Subtask scope must be 1-${maxSubtaskScope} workspace-relative prefixes.`);
    if (input.inputArtifactIds.length > maxInputArtifacts) throw orchError("SUBTASK_INPUT_INVALID", `Subtask input artifacts must be at most ${maxInputArtifacts}.`);
    if (new Set(input.inputArtifactIds).size !== input.inputArtifactIds.length) throw orchError("SUBTASK_INPUT_INVALID", "Subtask input artifact references must be unique.");
    const dependsOn = input.dependsOn ?? [];
    if (
      dependsOn.length > MAX_RUN_SUBTASKS || new Set(dependsOn).size !== dependsOn.length ||
      dependsOn.some((dependency) => !run.subtasks.includes(dependency))
    ) {
      throw orchError("SUBTASK_DEPENDENCY_INVALID", "Subtask dependencies must be unique existing subtasks in the same Run and remain within the Run subtask limit.", {
        runId,
        dependsOn
      });
    }
    assertScopeSubset(input.scope, contract.scope, "SUBTASK_SCOPE_OUTSIDE_CONTRACT", cfg.sensitiveExtraPaths);
    const subtaskDomain = input.domain ?? contract.domain;
    const maxDomainLength = cfg.defaults?.maxDomainLength ?? MAX_DOMAIN_LENGTH;
    if (subtaskDomain.length > maxDomainLength) throw orchError("SUBTASK_DOMAIN_INVALID", `Subtask domain must be at most ${maxDomainLength} characters.`);
    const creationIdentity: SubtaskCreationIdentity = {
      contractRef: contract.contractId,
      runRef: run.runId,
      domain: subtaskDomain,
      goal: input.goal,
      inputArtifactIds: input.inputArtifactIds,
      acceptanceCriteria: input.acceptanceCriteria,
      scope: input.scope,
      maxRetries,
      capabilities: input.capabilities,
      dependsOn,
      ...(input.critical === undefined ? {} : { critical: input.critical })
    };
    const creationRequestHash = hashSubtaskCreationRequest(creationIdentity);
    const existing = await findSubtaskByCreationHash(workspace, run, creationRequestHash);
    if (existing !== undefined) {
      if (!run.subtasks.includes(existing.subtaskId)) {
        if (run.subtasks.length >= MAX_RUN_SUBTASKS) {
          throw orchError("RUN_SUBTASK_LIMIT", `A Run may contain at most ${MAX_RUN_SUBTASKS} subtasks.`, { runId, limit: MAX_RUN_SUBTASKS });
        }
        await writeWorkspaceJson(workspace, runFile(runId), { ...run, subtasks: [...run.subtasks, existing.subtaskId] });
        maybeInjectSubtaskCreationFault(workspace, "after-run", existing.subtaskId);
      }
      return existing;
    }
    const inputArtifacts = [];
    for (const artifactId of input.inputArtifactIds) {
      const artifact = await getArtifact(workspace, artifactId);
      if (artifact.runRef !== run.runId || !run.artifacts.includes(artifact.artifactId)) {
        throw orchError("SUBTASK_INPUT_BINDING_MISMATCH", "Input artifacts must belong to the same orchestration run.", { artifactId, runId });
      }
      if (artifact.kind !== "file" || artifact.status !== "VERIFIED") {
        throw orchError("SUBTASK_INPUT_UNVERIFIABLE", "Only verified file artifacts can be used as subtask inputs in 2.0.1.", { artifactId });
      }
      await assertAcceptedProducerArtifact(workspace, run, artifact);
      await assertArtifactCurrent(workspace, artifact);
      inputArtifacts.push({ artifactId, contentHash: artifact.contentHash, path: artifact.path, kind: "file" as const });
    }
    const domainInstructions = await domainInstructionsFor(workspace, subtaskDomain);
    const maxDomainInstructions = cfg.defaults?.maxDomainInstructions ?? MAX_DOMAIN_INSTRUCTIONS;
    if (domainInstructions.length > maxDomainInstructions) throw orchError("SUBTASK_DOMAIN_INSTRUCTIONS_INVALID", `Subtask domain instructions must be at most ${maxDomainInstructions} items.`);
    const subtaskBase: Omit<SubtaskPackage, "subtaskId" | "creationRequestHash" | "createdAt"> = {
      version: 1,
      contractRef: contract.contractId,
      runRef: run.runId,
      domain: subtaskDomain,
      domainInstructions: domainInstructions,
      contractGoal: contract.goal,
      globalAcceptanceCriteria: contract.globalAcceptanceCriteria,
      goal: input.goal,
      inputArtifacts: inputArtifacts,
      acceptanceCriteria: input.acceptanceCriteria,
      scope: input.scope,
      maxRetries,
      capabilities: input.capabilities,
      status: "PENDING",
      round: run.round,
      retriesUsed: 0,
      dependsOn,
      ...(input.critical === undefined ? {} : { critical: input.critical })
    };
    if (run.subtasks.length >= MAX_RUN_SUBTASKS) {
      throw orchError("RUN_SUBTASK_LIMIT", `A Run may contain at most ${MAX_RUN_SUBTASKS} subtasks.`, { runId, limit: MAX_RUN_SUBTASKS });
    }
    const subtask: SubtaskPackage = {
      ...subtaskBase,
      subtaskId: `subtask-${randomUUID()}`,
      creationRequestHash,
      createdAt: new Date().toISOString()
    };
    schemas.validate("orchestration-subtask", subtask);
    await createWorkspaceJson(workspace, subtaskFile(subtask.subtaskId), subtask);
    maybeInjectSubtaskCreationFault(workspace, "after-subtask", subtask.subtaskId);
    const next = { ...run, subtasks: [...run.subtasks, subtask.subtaskId] };
    await writeWorkspaceJson(workspace, runFile(runId), next);
    maybeInjectSubtaskCreationFault(workspace, "after-run", subtask.subtaskId);
    return subtask;
  });
}

export async function getSubtask(workspace: LocalWorkspace, subtaskId: string): Promise<SubtaskPackage> {
  assertId(subtaskId, "SUBTASK_ID_INVALID");
  try {
    const value: unknown = JSON.parse(await readFile(await workspaceFile(workspace, subtaskFile(subtaskId)), "utf8"));
    (await defaultSchemaRegistry()).validate("orchestration-subtask", value);
    const subtask = value as SubtaskPackage;
    if (subtask.subtaskId !== subtaskId) {
      throw orchError("SUBTASK_ID_MISMATCH", "Stored Subtask ID does not match its canonical lookup ID.", {
        subtaskId,
        storedSubtaskId: subtask.subtaskId
      });
    }
    return subtask;
  } catch (error: unknown) {
    if (isCode(error, "ENOENT")) throw orchError("SUBTASK_NOT_FOUND", "Subtask does not exist.", { subtaskId });
    throw error;
  }
}

/**
 * Dispatches a subtask: verifies dependencies are ACCEPTED, verifies input artifact
 * hashes against storage, issues one lease per capability (bound to the subtask),
 * and marks DISPATCHED. Ledger: subtask-dispatched.
 */
export async function dispatchSubtask(
  workspace: LocalWorkspace,
  schemas: SchemaRegistry,
  runId: string,
  subtaskId: string,
  agentId: string,
  expectedAttempt: number
): Promise<{ subtask: SubtaskPackage; leases: string[]; activeAttempt: number }> {
  return withWorkspaceLock(workspace, async () => {
    const run = await getRun(workspace, runId);
    const contract = await getActiveContractForRun(workspace, run);
    if (!EXECUTABLE_RUN_STATUSES.has(run.status)) throw orchError("RUN_STATE_CONFLICT", "Only executable RUNNING/DEGRADED runs can dispatch subtasks.", { runId, status: run.status });
    assertExecutionBudgetAvailable(run);
    if (await getRunCancellationFence(workspace, runId)) throw orchError("RUN_CANCELLED", "Cancelled runs cannot dispatch subtasks.", { runId });
    const subtask = await getSubtask(workspace, subtaskId);
    assertSubtaskBinding(run, subtask, runId, subtaskId);
    assertExpectedDispatchAttempt(subtask, expectedAttempt);
    if (ACTIVE_ATTEMPT_STATUSES.has(subtask.status)) {
      assertActiveAttemptGeneration(subtask);
      if (subtask.dispatchedAgentId !== agentId) {
        throw orchError("SUBTASK_DISPATCH_IDEMPOTENCY_CONFLICT", "The active subtask attempt is already bound to a different dispatched agent.", {
          subtaskId,
          activeAttempt: subtask.activeAttempt,
          expectedAgentId: subtask.dispatchedAgentId,
          observedAgentId: agentId
        });
      }
      const leaseIds = await committedSubtaskAttemptLeaseIds(workspace, contract, subtask, agentId);
      await ensureOrchestrationActivationCommitted(workspace, run, subtask);
      return { subtask, leases: leaseIds, activeAttempt: subtask.activeAttempt };
    }
    if (subtask.status !== "PENDING" && subtask.status !== "REJECTED") throw orchError("SUBTASK_STATE_CONFLICT", "Only PENDING (or REJECTED for redispatch) subtasks can be dispatched.", { subtaskId, status: subtask.status });
    if (subtask.activeAttempt !== undefined) throw orchError("SUBTASK_GENERATION_STALE", "An inactive subtask must not retain an active attempt generation.", { subtaskId, activeAttempt: subtask.activeAttempt, retriesUsed: subtask.retriesUsed });
    assertSubtaskRetryAdmission(run, subtask);
    for (const dep of subtask.dependsOn) {
      const depSubtask = await getSubtask(workspace, dep);
      assertSubtaskBinding(run, depSubtask, runId, dep);
      if (depSubtask.status !== "ACCEPTED") throw orchError("SUBTASK_DEPENDENCY_PENDING", "A dependency is not ACCEPTED yet.", { subtaskId, dependency: dep, status: depSubtask.status });
    }
    await reverifyInputArtifacts(workspace, run, subtask);
    await assertNoActiveWriteSetConflict(workspace, run, subtask);
    await assertNoUnresolvedAttemptIntents(workspace, run, subtask);
    await revokeSupersededSubtaskLeases(workspace, contract, subtask, agentId);
    await admitTaskCapability(workspace, {
      taskId: contract.taskId,
      capability: "orchestration-control",
      readScope: subtask.scope,
      approvalRefs: contract.approvalRefs,
      parentGrantRef: contract.contractId,
      expectedTaskAuthorityHash: contract.taskAuthorityHash,
      policyVersion: contract.policyVersion,
      maxToolCalls: 1,
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      hostSessionId: contract.hostSessionId,
      allowApprovalScopeSuperset: true
    });
    const leaseIds: string[] = [];
    try {
      for (const capability of subtask.capabilities) {
        const lease = await issueLease(workspace, schemas, {
          taskId: contract.taskId,
          agentId,
          role: "worker",
          capability,
          readScope: subtask.scope,
          ...(capability === "repository-write" ? { writeSet: subtask.scope } : {}),
          subtaskRef: subtask.subtaskId,
          subtaskAttempt: subtask.retriesUsed,
          issuedBy: "orchestration-derived",
          parentGrantRef: contract.contractId,
          hostSessionId: contract.hostSessionId
        });
        leaseIds.push(lease.id);
      }
    } catch (error: unknown) {
      // Partially issued Leases remain unregistered and therefore unusable.
      // Exact retry reuses their issuance journals; run cancellation scans and
      // revokes every subtask-bound orphan as explicit cleanup.
      throw error;
    }
    const activeAttempt = subtask.retriesUsed;
    const nextSubtask: SubtaskPackage = {
      ...subtask,
      status: "DISPATCHED",
      dispatchedAt: new Date().toISOString(),
      dispatchedAgentId: agentId,
      activeAttempt,
      leaseRefs: [...(subtask.leaseRefs ?? []), ...leaseIds]
    };
    schemas.validate("orchestration-subtask", nextSubtask);
    await writeWorkspaceJson(workspace, subtaskFile(subtaskId), nextSubtask);
    maybeInjectOrchestrationActivationFault(workspace, "after-subtask", subtaskId);
    await ensureOrchestrationActivationCommitted(workspace, run, nextSubtask);
    maybeInjectOrchestrationActivationFault(workspace, "after-ledger", subtaskId);
    return { subtask: nextSubtask, leases: leaseIds, activeAttempt };
  });
}

async function revokeSupersededSubtaskLeases(
  workspace: LocalWorkspace,
  contract: TaskContract,
  subtask: SubtaskPackage,
  intendedAgentId: string
): Promise<void> {
  const intendedCapabilities = new Set(subtask.capabilities);
  for (const lease of await listLeases(workspace)) {
    if (lease.status !== "active" || lease.subtaskRef !== subtask.subtaskId) continue;
    const superseded = lease.subtaskAttempt !== subtask.retriesUsed;
    const wrongCurrentRequest = lease.subtaskAttempt === subtask.retriesUsed && (
      lease.agentId !== intendedAgentId || lease.role !== "worker" ||
      lease.parentGrantRef !== contract.contractId || lease.hostSessionId !== contract.hostSessionId ||
      !intendedCapabilities.has(lease.capability)
    );
    if (!superseded && !wrongCurrentRequest) continue;
    await revokeLease(
      workspace,
      lease.id,
      superseded
        ? `Subtask ${subtask.subtaskId} retry generation ${subtask.retriesUsed} superseded this Lease.`
        : `Subtask ${subtask.subtaskId} dispatch request changed before the Lease was registered.`
    );
  }
}

/** Loads the exact Lease set already committed to the current dispatch attempt. */
async function committedSubtaskAttemptLeaseIds(
  workspace: LocalWorkspace,
  contract: TaskContract,
  subtask: SubtaskPackage & { activeAttempt: number },
  agentId: string
): Promise<string[]> {
  const registered = new Set(subtask.leaseRefs ?? []);
  const leases = (await listLeases(workspace)).filter((lease) =>
    registered.has(lease.id) && lease.subtaskRef === subtask.subtaskId && lease.subtaskAttempt === subtask.activeAttempt
  );
  const result: string[] = [];
  for (const capability of subtask.capabilities) {
    const matching = leases.filter((lease) => lease.capability === capability);
    if (matching.length !== 1) {
      throw orchError("SUBTASK_DISPATCH_RECOVERY_CONFLICT", "The committed dispatch Lease set is missing or duplicated for a capability.", {
        subtaskId: subtask.subtaskId,
        activeAttempt: subtask.activeAttempt,
        capability,
        count: matching.length
      });
    }
    const lease = matching[0]!;
    const expectedWriteSet = capability === "repository-write" ? subtask.scope : [];
    if (
      lease.status !== "active" || lease.agentId !== agentId || lease.role !== "worker" ||
      lease.parentGrantRef !== contract.contractId || lease.hostSessionId !== contract.hostSessionId ||
      lease.issuedBy !== "orchestration-derived" ||
      JSON.stringify(lease.readScope) !== JSON.stringify(subtask.scope) ||
      JSON.stringify(lease.writeSet) !== JSON.stringify(expectedWriteSet)
    ) {
      throw orchError("SUBTASK_DISPATCH_RECOVERY_CONFLICT", "The committed dispatch Lease set no longer matches its exact authority binding.", {
        subtaskId: subtask.subtaskId,
        activeAttempt: subtask.activeAttempt,
        capability,
        leaseId: lease.id
      });
    }
    result.push(lease.id);
  }
  if (leases.length !== result.length) {
    throw orchError("SUBTASK_DISPATCH_RECOVERY_CONFLICT", "The committed dispatch contains unexpected current-attempt Leases.", {
      subtaskId: subtask.subtaskId,
      activeAttempt: subtask.activeAttempt,
      expected: result.length,
      observed: leases.length
    });
  }
  return result;
}

/** Marks a dispatched subtask RUNNING (worker started). Ledger: subtask-started. */
export async function beginSubtask(workspace: LocalWorkspace, runId: string, subtaskId: string, expectedAttempt: number): Promise<SubtaskPackage> {
  return withWorkspaceLock(workspace, async () => {
    const run = await getRun(workspace, runId);
    await getActiveContractForRun(workspace, run);
    if (!EXECUTABLE_RUN_STATUSES.has(run.status) || await getRunCancellationFence(workspace, runId)) throw orchError("RUN_STATE_CONFLICT", "Only executable RUNNING/DEGRADED runs can begin subtasks.", { runId, status: run.status });
    assertExecutionBudgetAvailable(run);
    const subtask = await getSubtask(workspace, subtaskId);
    assertSubtaskBinding(run, subtask, runId, subtaskId);
    if (subtask.status === "RUNNING") {
      assertExpectedAttempt(subtask, expectedAttempt);
      await ensureOrchestrationActivationCommitted(workspace, run, subtask);
      return subtask;
    }
    if (subtask.status !== "DISPATCHED") throw orchError("SUBTASK_STATE_CONFLICT", "Only DISPATCHED subtasks can begin.", { subtaskId, status: subtask.status });
    assertExpectedAttempt(subtask, expectedAttempt);
    assertSubtaskRetryAdmission(run, subtask);
    await reverifyInputArtifacts(workspace, run, subtask);
    await assertNoActiveWriteSetConflict(workspace, run, subtask);
    await ensureOrchestrationActivationCommitted(workspace, run, subtask);
    const next: SubtaskPackage = { ...subtask, status: "RUNNING" };
    await writeWorkspaceJson(workspace, subtaskFile(subtaskId), next);
    maybeInjectOrchestrationActivationFault(workspace, "after-subtask", subtaskId);
    await ensureOrchestrationActivationCommitted(workspace, run, next);
    maybeInjectOrchestrationActivationFault(workspace, "after-ledger", subtaskId);
    return next;
  });
}

/* ------------------------------------------------------------------ */
/* Artifact                                                            */
/* ------------------------------------------------------------------ */

export interface ReportArtifactInput {
  path: string;
  kind: "file" | "summary" | "evidence";
  /** Generation token returned by dispatchSubtask. */
  expectedAttempt: number;
}

/** Reports a worker artifact; engine verifies contentHash of the file. Ledger: artifact-recorded / artifact-mismatch. */
export async function reportArtifact(workspace: LocalWorkspace, schemas: SchemaRegistry, runId: string, subtaskId: string, input: ReportArtifactInput): Promise<Artifact> {
  return withWorkspaceLock(workspace, async () => {
    const run = await getRun(workspace, runId);
    const contract = await getActiveContractForRun(workspace, run);
    if (!EXECUTABLE_RUN_STATUSES.has(run.status) || await getRunCancellationFence(workspace, runId)) throw orchError("RUN_STATE_CONFLICT", "Artifacts can only be reported for an executable RUNNING/DEGRADED run.", { runId, status: run.status });
    const subtask = await getSubtask(workspace, subtaskId);
    assertSubtaskBinding(run, subtask, runId, subtaskId);
    if (subtask.status !== "RUNNING" && subtask.status !== "REVIEWING") throw orchError("SUBTASK_STATE_CONFLICT", "Artifacts can only be reported for RUNNING/REVIEWING subtasks.", { subtaskId, status: subtask.status });
    assertExpectedAttempt(subtask, input.expectedAttempt);
    await ensureOrchestrationActivationCommitted(workspace, run, subtask);
    await assertNoUnresolvedAttemptIntents(workspace, run, subtask);
    if (input.kind !== "file") {
      throw orchError("ARTIFACT_KIND_UNVERIFIABLE", "Only file artifacts can be verified in 2.0.1; summary/evidence require a content-bearing contract planned for 2.1.", { kind: input.kind });
    }
    assertRelativePath(input.path);
    if (!artifactInScope(subtask.scope, input.path)) {
      // Caller-invalid paths are rejected without creating an Artifact, growing
      // Run arrays, or appending attacker-amplifiable ledger records. The
      // bounded invocation audit remains the denial record at the tool edge.
      throw orchError("ARTIFACT_SCOPE_VIOLATION", "Artifact path is outside the subtask scope.", { path: input.path, subtaskId });
    }
    // The immutable report identity is independent of mutable file bytes. A
    // retry after Artifact/Run/ledger split writes therefore repairs the same
    // object rather than consuming another cardinality slot. A changed file at
    // the same path/attempt is a stale immutable report, not a new Artifact.
    const artifactId = artifactIdForReport(runId, subtaskId, input.expectedAttempt, input.kind, input.path);
    let artifact = await getArtifact(workspace, artifactId).catch((error: unknown) => {
      if (error instanceof StinkyCobblerError && error.code === "ARTIFACT_NOT_FOUND") return undefined;
      throw error;
    });
    if (artifact === undefined) {
      if (run.artifacts.length >= MAX_RUN_ARTIFACTS || (subtask.artifactRefs?.length ?? 0) >= MAX_SUBTASK_ARTIFACTS) {
        throw orchError("ARTIFACT_LIMIT_REACHED", "The Run or subtask artifact limit has been reached.", {
          runId,
          subtaskId,
          runLimit: MAX_RUN_ARTIFACTS,
          subtaskLimit: MAX_SUBTASK_ARTIFACTS
        });
      }
      const cfg = await loadOrchestrationConfig(workspace);
      try {
        await resolveWorkspacePath(workspace.root, input.path, {
          ...(cfg.sensitiveExtraPaths === undefined ? {} : { sensitiveExtraPaths: cfg.sensitiveExtraPaths })
        });
      } catch (error: unknown) {
        throw orchError("ARTIFACT_PATH_INVALID", error instanceof Error ? error.message : "Artifact path is invalid.", { path: input.path });
      }
      let bytes: Buffer;
      try {
        bytes = (await readBoundedWorkspaceFile(workspace.root, input.path, MAX_ARTIFACT_BYTES)).bytes;
      } catch (error: unknown) {
        if (isCode(error, "ENOENT")) throw orchError("ARTIFACT_FILE_MISSING", "Artifact file does not exist.", { path: input.path });
        if (error instanceof WorkspaceReadBoundaryError) {
          throw orchError(
            error.reason === "size-limit" ? "ARTIFACT_SIZE_LIMIT" : "ARTIFACT_PATH_INVALID",
            error.message,
            { path: input.path, reason: error.reason, maxBytes: MAX_ARTIFACT_BYTES }
          );
        }
        throw error;
      }
      const now = new Date().toISOString();
      artifact = {
        version: 1,
        artifactId,
        runRef: runId,
        subtaskRef: subtaskId,
        kind: input.kind,
        path: input.path,
        contentHash: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
        round: run.round,
        attempt: subtask.activeAttempt,
        status: "VERIFIED",
        createdAt: now,
        verifiedAt: now
      };
      schemas.validate("orchestration-artifact", artifact);
      await createWorkspaceJson(workspace, artifactFile(artifact.artifactId), artifact);
      maybeInjectArtifactReportingFault(workspace, "after-artifact");
    } else {
      if (
        artifact.runRef !== runId || artifact.subtaskRef !== subtaskId || artifact.kind !== input.kind ||
        artifact.path !== input.path || artifact.attempt !== input.expectedAttempt || artifact.round !== run.round ||
        artifact.status !== "VERIFIED"
      ) {
        throw orchError("ARTIFACT_IDEMPOTENCY_CONFLICT", "The deterministic Artifact ID already stores a different report subject.", {
          artifactId,
          runId,
          subtaskId
        });
      }
      await assertArtifactCurrent(workspace, artifact);
    }

    if (!run.artifacts.includes(artifact.artifactId)) {
      if (run.artifacts.length >= MAX_RUN_ARTIFACTS) throw orchError("ARTIFACT_LIMIT_REACHED", "The Run artifact limit has been reached.", { runId, runLimit: MAX_RUN_ARTIFACTS });
      const nextRun = { ...run, artifacts: [...run.artifacts, artifact.artifactId] };
      schemas.validate("orchestration-run", nextRun);
      await writeWorkspaceJson(workspace, runFile(runId), nextRun);
    }
    maybeInjectArtifactReportingFault(workspace, "after-run");
    await ensureArtifactRecordedLedgerEntry(workspace, contract, artifact);
    maybeInjectArtifactReportingFault(workspace, "after-ledger");
    if (!(subtask.artifactRefs ?? []).includes(artifact.artifactId)) {
      if ((subtask.artifactRefs?.length ?? 0) >= MAX_SUBTASK_ARTIFACTS) throw orchError("ARTIFACT_LIMIT_REACHED", "The subtask artifact limit has been reached.", { subtaskId, subtaskLimit: MAX_SUBTASK_ARTIFACTS });
      const reviewStatus: SubtaskPackage = { ...subtask, status: "REVIEWING", artifactRefs: [...(subtask.artifactRefs ?? []), artifact.artifactId] };
      schemas.validate("orchestration-subtask", reviewStatus);
      await writeWorkspaceJson(workspace, subtaskFile(subtaskId), reviewStatus);
    }
    return artifact;
  });
}

/** Test-only, single-use Artifact report split-write crash point. */
export function injectArtifactReportingFaultForTesting(
  workspace: LocalWorkspace,
  point: "after-artifact" | "after-run" | "after-ledger"
): void {
  if (process.env.NODE_ENV !== "test") throw orchError("ARTIFACT_REPORTING_TEST_FAULT_DENIED", "Artifact reporting fault injection is available only under the test runner.");
  artifactReportingFaults.set(workspace.directory, point);
}

function maybeInjectArtifactReportingFault(
  workspace: LocalWorkspace,
  point: "after-artifact" | "after-run" | "after-ledger"
): void {
  if (artifactReportingFaults.get(workspace.directory) !== point) return;
  artifactReportingFaults.delete(workspace.directory);
  throw orchError("ARTIFACT_REPORTING_TEST_FAULT", `Injected Artifact reporting fault at ${point}.`, { point });
}

export async function getArtifact(workspace: LocalWorkspace, artifactId: string): Promise<Artifact> {
  assertId(artifactId, "ARTIFACT_ID_INVALID");
  try {
    const value: unknown = JSON.parse(await readFile(await workspaceFile(workspace, artifactFile(artifactId)), "utf8"));
    (await defaultSchemaRegistry()).validate("orchestration-artifact", value);
    const artifact = value as Artifact;
    if (artifact.artifactId !== artifactId) {
      throw orchError("ARTIFACT_ID_MISMATCH", "Stored Artifact ID does not match its canonical lookup ID.", {
        artifactId,
        storedArtifactId: artifact.artifactId
      });
    }
    return artifact;
  } catch (error: unknown) {
    if (isCode(error, "ENOENT")) throw orchError("ARTIFACT_NOT_FOUND", "Artifact does not exist.", { artifactId });
    throw error;
  }
}

function artifactIdForReport(
  runId: string,
  subtaskId: string,
  attempt: number,
  kind: ReportArtifactInput["kind"],
  artifactPath: string
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify({ version: 1, runId, subtaskId, attempt, kind, path: artifactPath }), "utf8")
    .digest("hex")
    .slice(0, 48);
  return `artifact-${digest.match(/.{1,12}/g)?.join("-") ?? digest}`;
}

async function ensureArtifactRecordedLedgerEntry(
  workspace: LocalWorkspace,
  contract: TaskContract,
  artifact: Artifact
): Promise<void> {
  const expected = prepareLedgerEntry({
    event: "artifact-recorded",
    taskId: contract.taskId,
    contractRef: contract.contractId,
    runRef: artifact.runRef,
    subtaskRef: artifact.subtaskRef,
    artifactRef: artifact.artifactId,
    summary: `Artifact ${artifact.artifactId} recorded (${artifact.kind}, hash ${artifact.contentHash.slice(0, 20)}...).`
  });
  const entries = (await listLedgerEntries(workspace))
    .filter((entry) => entry.event === "artifact-recorded" && entry.artifactRef === artifact.artifactId);
  if (entries.length === 1) {
    const entry = entries[0]!;
    if (
      entry.taskId === expected.taskId && entry.contractRef === expected.contractRef &&
      entry.runRef === expected.runRef && entry.subtaskRef === expected.subtaskRef &&
      entry.summary === expected.summary
    ) return;
  }
  if (entries.length > 0) {
    throw orchError("ARTIFACT_AUDIT_CONFLICT", "Artifact audit is duplicated or bound to different canonical content.", {
      artifactId: artifact.artifactId,
      count: entries.length
    });
  }
  await appendLedgerEntry(workspace, expected);
}

/* ------------------------------------------------------------------ */
/* Review                                                              */
/* ------------------------------------------------------------------ */

export interface RecordReviewInput {
  decision: "ACCEPTED" | "REJECTED";
  criteriaResults: { criterion: string; passed: boolean; note: string }[];
  defects: Defect[];
  score: number;
  reason: string;
  /** @deprecated Caller-authored validator JSON is accepted only for wire compatibility and is ignored. */
  validatorEvidence?: ValidatorEvidence[];
  reviewedBy: string;
  /** Host estimate charged to the run budget; it is not provider-verified. */
  tokensUsed: number;
  /** Reserved for a future engine-verified provider receipt adapter; unsupported caller references fail closed in 2.0.1. */
  providerTokenReceiptId?: string;
  /** Generation token returned by dispatchSubtask. */
  expectedAttempt: number;
}

/**
 * Records the dual-channel review and applies the constraint engine:
 * ACCEPTED → subtask ACCEPTED; REJECTED → retries/FAILED; oscillation/regression/budget → ESCALATED/FAILED.
 * Ledger: review-recorded / subtask-accepted / subtask-rejected / orchestration-escalated / orchestration-failed.
 */
export async function recordReview(workspace: LocalWorkspace, schemas: SchemaRegistry, runId: string, subtaskId: string, input: RecordReviewInput): Promise<{ review: ReviewRecord; run: OrchestrationRun; subtask: SubtaskPackage }> {
  return withWorkspaceLock(workspace, async () => {
    const transactionId = reviewTransactionId(runId, subtaskId, input.expectedAttempt);
    const { validatorEvidence: _ignoredCallerEvidence, ...authoritativeInput } = input;
    const requestHash = orchestrationRequestHash({ kind: "REVIEW", runId, subtaskId, input: authoritativeInput });
    const existingTransaction = await findOrchestrationTransaction(workspace, transactionId);
    if (existingTransaction !== undefined) {
      if (existingTransaction.kind !== "REVIEW") {
        throw orchError("ORCHESTRATION_TRANSACTION_CONFLICT", "This run/subtask/attempt review generation is already bound to a different immutable request.", {
          transactionId,
          runId,
          subtaskId,
          expectedAttempt: input.expectedAttempt
        });
      }
      if (existingTransaction.requestHash !== requestHash) {
        // Preserve generation-fence semantics for a delayed caller after a
        // later retry has already become active. A same-generation attempt to
        // replace a prepared immutable request remains a transaction conflict.
        const currentRun = await getRun(workspace, runId);
        const currentSubtask = await getSubtask(workspace, subtaskId);
        assertSubtaskBinding(currentRun, currentSubtask, runId, subtaskId);
        assertExpectedAttempt(currentSubtask, input.expectedAttempt);
        throw orchError("ORCHESTRATION_TRANSACTION_CONFLICT", "This run/subtask/attempt review generation is already bound to a different immutable request.", {
          transactionId,
          runId,
          subtaskId,
          expectedAttempt: input.expectedAttempt
        });
      }
      const recovered = await reconcileOrchestrationTransaction(workspace, schemas, transactionId) as ReviewTransaction;
      await revokeCompletedAttemptLeases(workspace, recovered);
      return { review: recovered.review, run: recovered.nextRun, subtask: recovered.nextSubtask };
    }

    const run = await getRun(workspace, runId);
    const contract = await getActiveContractForRun(workspace, run);
    if (!EXECUTABLE_RUN_STATUSES.has(run.status)) throw orchError("RUN_STATE_CONFLICT", "Reviews only apply to executable RUNNING/DEGRADED runs.", { runId, status: run.status });
    if (await getRunCancellationFence(workspace, runId)) throw orchError("RUN_CANCELLED", "Cancelled runs cannot accept reviews.", { runId });
    const subtask = await getSubtask(workspace, subtaskId);
    assertSubtaskBinding(run, subtask, runId, subtaskId);
    if (subtask.status !== "REVIEWING" && subtask.status !== "RUNNING") throw orchError("SUBTASK_STATE_CONFLICT", "Subtask must be REVIEWING (or RUNNING) to review.", { subtaskId, status: subtask.status });
    assertExpectedAttempt(subtask, input.expectedAttempt);
    await ensureOrchestrationActivationCommitted(workspace, run, subtask);
    await assertNoUnresolvedAttemptIntents(workspace, run, subtask);
    if (run.reviews.length >= MAX_RUN_REVIEWS) throw orchError("RUN_REVIEW_LIMIT", `A Run may contain at most ${MAX_RUN_REVIEWS} reviews.`, { runId, limit: MAX_RUN_REVIEWS });
    if (input.decision === "REJECTED" && input.defects.length < 1) throw orchError("REVIEW_DEFECTS_REQUIRED", "REJECTED reviews require at least one actionable defect.");
    if (input.reason.length < 1 || input.reason.length > 1024) throw orchError("REVIEW_REASON_REQUIRED", "Review reason is required (1-1024 characters).");
    if (input.score < 0 || input.score > 100) throw orchError("REVIEW_SCORE_INVALID", "Review score must be 0-100.");
    const cfg = await loadOrchestrationConfig(workspace);
    const maxDefects = cfg.defaults?.maxDefects ?? MAX_DEFECTS;
    if (input.defects.length > maxDefects) throw orchError("REVIEW_DEFECTS_TOO_MANY", `At most ${maxDefects} defects per review.`);
    if (
      input.criteriaResults.length < 1 || input.criteriaResults.length > MAX_SUBTASK_CRITERIA ||
      new Set(input.criteriaResults.map((result) => result.criterion)).size !== input.criteriaResults.length ||
      input.criteriaResults.some((result) => !result.criterion || result.criterion.length > 512 || result.note.length > 512)
    ) throw orchError("REVIEW_CRITERIA_INVALID", "Review criteria must be unique, non-empty, bounded results for the declared subtask criteria.");
    if (input.defects.some((defect) =>
      !defect.location || defect.location.length > 512 ||
      !defect.problem || defect.problem.length > 512 ||
      !defect.suggestion || defect.suggestion.length > 512
    )) throw orchError("REVIEW_DEFECT_INVALID", "Review defect location, problem, and suggestion must each be 1-512 characters.");
    if (input.tokensUsed === undefined || !Number.isSafeInteger(input.tokensUsed) || input.tokensUsed < 0 || input.tokensUsed > MAX_REVIEW_TOKENS) {
      throw orchError("REVIEW_TOKENS_INVALID", `tokensUsed is required and must be a non-negative integer at most ${MAX_REVIEW_TOKENS}.`);
    }
    if (input.providerTokenReceiptId !== undefined) {
      throw orchError("TOKEN_PROVIDER_RECEIPT_UNSUPPORTED", "2.0.1 has no engine adapter that can authenticate caller-supplied provider token receipts; token usage remains ESTIMATED/UNKNOWN.", { providerTokenReceiptId: input.providerTokenReceiptId });
    }
    if (!input.reviewedBy.trim() || input.reviewedBy.length > 128) throw orchError("REVIEWER_INVALID", "reviewedBy is required and must be at most 128 characters.");
    // Criterion correspondence (P2): every reviewed criterion must be a declared acceptance criterion,
    // and every acceptance criterion must be evaluated — no invented standards, no skipped standards.
    {
      const declared = new Set(subtask.acceptanceCriteria);
      const evaluated = new Set(input.criteriaResults.map((result) => result.criterion));
      const missing = [...declared].filter((criterion) => !evaluated.has(criterion));
      const extra = [...evaluated].filter((criterion) => !declared.has(criterion));
      if (missing.length > 0 || extra.length > 0) {
        throw orchError("REVIEW_CRITERION_MISMATCH", `Review criteria must exactly match the subtask acceptance criteria.${missing.length > 0 ? ` Missing: ${missing.join(", ")}` : ""}${extra.length > 0 ? ` Not declared: ${extra.join(", ")}` : ""}`);
      }
    }
    // Engine auto-reject: ACCEPTED reviews scoring below the configured threshold are forced REJECTED
    // (guards against an LLM passing low-quality output with a high score).
    const autoRejectThreshold = cfg.defaults?.autoRejectScoreThreshold ?? 0;
    let decision = input.decision;
    let defects = input.defects;
    let reason = input.reason;
    let score = input.score;
    if (decision === "ACCEPTED" && autoRejectThreshold > 0 && score < autoRejectThreshold) {
      decision = "REJECTED";
      defects = [...defects, { location: "engine", problem: `自动否决：分数 ${score} 低于阈值 ${autoRejectThreshold}`, suggestion: "按缺陷清单重做并重新提交" }];
      reason = `Engine auto-reject: score ${score} below threshold ${autoRejectThreshold}. ${reason}`;
    }
    if (defects.length > maxDefects) throw orchError("REVIEW_DEFECTS_TOO_MANY", `At most ${maxDefects} defects per review after engine evaluation.`);
    await reverifyInputArtifacts(workspace, run, subtask);
    const artifactObservations = await collectCurrentArtifactObservations(workspace, run, subtask);
    if (decision === "ACCEPTED") {
      if (artifactObservations.length === 0) throw orchError("REVIEW_ARTIFACT_REQUIRED", "Accepted reviews require at least one verified file artifact from the current retry attempt.", { subtaskId, attempt: subtask.activeAttempt });
      if (input.criteriaResults.some((result) => !result.passed)) throw orchError("REVIEW_ACCEPTANCE_FAILED", "An ACCEPTED review requires every declared criterion to pass.", { subtaskId });
    }
    // Caller validatorEvidence is deliberately ignored. Only registered engine code below can create proof.
    const sameSourceReview = subtask.dispatchedAgentId !== undefined && input.reviewedBy === subtask.dispatchedAgentId;
    const reviewPolicy = contract.reviewPolicy ?? "INDEPENDENT_REQUIRED";
    if (sameSourceReview && reviewPolicy === "INDEPENDENT_REQUIRED") {
      throw orchError("INDEPENDENT_REVIEW_REQUIRED", "The Contract requires an independent reviewer; legacy Contracts default to this strict rule.", { reviewPolicy, reviewedBy: input.reviewedBy, dispatchedAgentId: subtask.dispatchedAgentId });
    }
    const reviewIndependence = sameSourceReview ? "SELF_REVIEW_NON_INDEPENDENT" as const : "INDEPENDENT" as const;
    const preparedAt = new Date().toISOString();
    const reviewId = reviewIdForTransaction(transactionId);
    const validatorReceipts = await prepareRegisteredValidatorReceipts(schemas, {
      runRef: runId,
      subtaskRef: subtaskId,
      reviewRef: reviewId,
      round: run.round,
      attempt: subtask.activeAttempt,
      artifactObservations
    }, { createdAt: preparedAt, storageBoundary: "JOURNALED_TRANSACTION" });
    if (decision === "ACCEPTED" && validatorReceipts.some((receipt) => receipt.status !== "PASSED")) {
      throw orchError("REVIEW_VALIDATOR_FAILED", "An ACCEPTED review requires every engine-executed validator receipt to pass.", {
        subtaskId,
        validatorReceiptIds: validatorReceipts.map((receipt) => receipt.receiptId)
      });
    }
    const review: ReviewRecord = {
      version: 1,
      reviewId,
      runRef: runId,
      subtaskRef: subtaskId,
      round: run.round,
      decision,
      criteriaResults: input.criteriaResults,
      defects,
      score,
      reason,
      validatorReceiptIds: validatorReceipts.map((receipt) => receipt.receiptId),
      createdAt: preparedAt,
      reviewedBy: input.reviewedBy,
      attempt: subtask.activeAttempt,
      reviewIndependence,
      tokensUsed: input.tokensUsed,
      tokenAccounting: {
        status: input.tokensUsed === 0 ? "UNKNOWN" : "ESTIMATED",
        chargedTokens: input.tokensUsed
      },
      ...(sameSourceReview ? { sameSourceReview: true } : {})
    };
    schemas.validate("orchestration-review", review);

    const reviews = [...(await loadReviews(workspace, run, subtaskId)), review];
    // Accumulate host-reported token consumption BEFORE constraint evaluation so TOKEN_BUDGET is live.
    const nextBudget = { ...run.budget, usedTokens: run.budget.usedTokens + input.tokensUsed };
    let nextRun = { ...run, budget: nextBudget, reviews: [...run.reviews, review.reviewId] };
    let nextSubtask: SubtaskPackage;
    const { activeAttempt: _completedAttempt, ...inactiveSubtask } = subtask;
    const ledgerEffects: OrchestrationLedgerEffect[] = [];

    if (decision === "ACCEPTED") {
      nextSubtask = { ...inactiveSubtask, status: "ACCEPTED", completedAt: preparedAt, reviewRefs: [...(subtask.reviewRefs ?? []), review.reviewId] };
      ledgerEffects.push(
        orchestrationLedgerEffect(transactionId, "review-recorded", { event: "review-recorded", taskId: contract.taskId, contractRef: contract.contractId, runRef: runId, subtaskRef: subtaskId, reviewRef: review.reviewId, summary: `Review ${review.reviewId}: ACCEPTED (score ${review.score})${sameSourceReview ? " [same-source]" : ""}.` }),
        orchestrationLedgerEffect(transactionId, "subtask-accepted", { event: "subtask-accepted", taskId: contract.taskId, contractRef: contract.contractId, runRef: runId, subtaskRef: subtaskId, summary: `Subtask ${subtaskId} accepted.` })
      );
    } else {
      nextSubtask = { ...inactiveSubtask, status: "REJECTED", retriesUsed: subtask.retriesUsed + 1, reviewRefs: [...(subtask.reviewRefs ?? []), review.reviewId], lastDefects: defects };
      ledgerEffects.push(
        orchestrationLedgerEffect(transactionId, "review-recorded", { event: "review-recorded", taskId: contract.taskId, contractRef: contract.contractId, runRef: runId, subtaskRef: subtaskId, reviewRef: review.reviewId, summary: `Review ${review.reviewId}: REJECTED (score ${review.score})${sameSourceReview ? " [same-source]" : ""}.` }),
        orchestrationLedgerEffect(transactionId, "subtask-rejected", { event: "subtask-rejected", taskId: contract.taskId, contractRef: contract.contractId, runRef: runId, subtaskRef: subtaskId, summary: `Subtask ${subtaskId} rejected with ${defects.length} defect(s).` })
      );
    }

    // Constraint engine: oscillation / regression escalate; budgets fail.
    const oscillationThreshold = cfg.defaults?.oscillationThreshold;
    const constraint = evaluateConstraints({ run: nextRun, subtask: nextSubtask, reviews, ...(oscillationThreshold === undefined ? {} : { oscillationThreshold }) });
    if (constraint.action === "escalate") {
      nextRun = { ...nextRun, status: "ESCALATED", escalatedAt: preparedAt, escalationReason: constraint.code === null ? constraint.detail : `${constraint.code}: ${constraint.detail}` };
      ledgerEffects.push(orchestrationLedgerEffect(transactionId, "constraint-escalated", { event: "orchestration-escalated", taskId: contract.taskId, contractRef: contract.contractId, runRef: runId, subtaskRef: subtaskId, summary: `Run ${runId} escalated: ${constraint.detail}` }));
    } else if (constraint.action === "degrade") {
      nextSubtask = { ...nextSubtask, status: "FAILED", completedAt: preparedAt, failReason: `${constraint.code}: ${constraint.detail}` };
      nextRun = { ...nextRun, status: "DEGRADED", escalationReason: `${constraint.code}: ${constraint.detail}` };
      ledgerEffects.push(orchestrationLedgerEffect(transactionId, "constraint-degraded", { event: "run-transitioned", taskId: contract.taskId, contractRef: contract.contractId, runRef: runId, subtaskRef: subtaskId, summary: `Run ${runId} transitioned to DEGRADED: ${constraint.detail} Independent DAG branches remain executable.` }));
    } else if (constraint.action === "fail") {
      if (constraint.code === "RETRIES_EXHAUSTED") {
        nextSubtask = { ...nextSubtask, status: "FAILED", completedAt: preparedAt, failReason: `${constraint.code}: ${constraint.detail}` };
      }
      nextRun = { ...nextRun, status: "FAILED", completedAt: preparedAt, escalationReason: `${constraint.code}: ${constraint.detail}` };
      ledgerEffects.push(orchestrationLedgerEffect(transactionId, "constraint-failed", { event: "orchestration-failed", taskId: contract.taskId, contractRef: contract.contractId, runRef: runId, subtaskRef: subtaskId, summary: `Run ${runId} failed: ${constraint.detail}` }));
    }

    schemas.validate("orchestration-subtask", nextSubtask);
    schemas.validate("orchestration-run", nextRun);
    const transaction: ReviewTransaction = {
      version: 1,
      transactionId,
      kind: "REVIEW",
      status: "PREPARED",
      requestHash,
      contractRef: contract.contractId,
      runRef: runId,
      subtaskRef: subtaskId,
      round: run.round,
      attempt: subtask.activeAttempt,
      reviewRef: reviewId,
      sourceRunHash: orchestrationRecordHash(run),
      sourceSubtaskHash: orchestrationRecordHash(subtask),
      validatorReceipts,
      review,
      nextRun,
      nextSubtask,
      ledgerEffects,
      preparedAt,
      updatedAt: preparedAt
    };
    await prepareOrchestrationTransaction(workspace, schemas, transaction);
    const committed = await reconcileOrchestrationTransaction(workspace, schemas, transactionId) as ReviewTransaction;
    await revokeCompletedAttemptLeases(workspace, committed);
    return { review: committed.review, run: committed.nextRun, subtask: committed.nextSubtask };
  });
}

async function revokeCompletedAttemptLeases(workspace: LocalWorkspace, transaction: ReviewTransaction): Promise<void> {
  for (const lease of await listLeases(workspace)) {
    if (
      lease.status === "active" && lease.subtaskRef === transaction.subtaskRef &&
      lease.subtaskAttempt === transaction.attempt
    ) {
      await revokeLease(workspace, lease.id, `Subtask ${transaction.subtaskRef} attempt ${transaction.attempt} review committed.`);
    }
  }
}

/** Completes a round: records the orchestrator's goal-consistency check and advances the round.
 *  When autoEscalateOnConsistencyFail is configured and the check failed, the run escalates instead. Ledger: round-completed. */
export async function completeRound(workspace: LocalWorkspace, runId: string, input: { passed: boolean; note: string }): Promise<OrchestrationRun> {
  return withWorkspaceLock(workspace, async () => {
    const schemas = await defaultSchemaRegistry();
    const requestHash = orchestrationRequestHash({ kind: "COMPLETION", runId, input });
    const transactions = (await listOrchestrationTransactions(workspace))
      .filter((transaction): transaction is CompletionTransaction => transaction.kind === "COMPLETION" && transaction.runRef === runId);
    const pending = transactions.filter((transaction) => transaction.status === "PREPARED");
    if (pending.length > 1) {
      throw orchError("ORCHESTRATION_TRANSACTION_CONFLICT", "More than one PREPARED completion transaction exists for this Run.", {
        runId,
        transactionIds: pending.map((transaction) => transaction.transactionId)
      });
    }
    if (pending[0] !== undefined) {
      if (pending[0].requestHash !== requestHash) {
        throw orchError("ORCHESTRATION_TRANSACTION_CONFLICT", "The unfinished completion transaction is bound to a different consistency request.", {
          runId,
          transactionId: pending[0].transactionId
        });
      }
      return (await reconcileOrchestrationTransaction(workspace, schemas, pending[0].transactionId) as CompletionTransaction).nextRun;
    }

    const run = await getRun(workspace, runId);
    const currentRunHash = orchestrationRecordHash(run);
    const idempotent = transactions.find((transaction) =>
      transaction.status === "COMMITTED" && transaction.requestHash === requestHash &&
      !EXECUTABLE_RUN_STATUSES.has(transaction.nextRun.status) &&
      orchestrationRecordHash(transaction.nextRun) === currentRunHash
    );
    if (idempotent !== undefined) {
      return (await reconcileOrchestrationTransaction(workspace, schemas, idempotent.transactionId) as CompletionTransaction).nextRun;
    }
    if (!EXECUTABLE_RUN_STATUSES.has(run.status)) throw orchError("RUN_STATE_CONFLICT", "Only executable RUNNING/DEGRADED runs can complete a round.", { runId, status: run.status });
    await assertRunNotCancelling(workspace, runId);
    if (!input.note.trim() || input.note.length > 1024) throw orchError("ROUND_NOTE_INVALID", "Round consistency note must be 1-1024 characters.");
    const cfg = await loadOrchestrationConfig(workspace);
    const contract = await getActiveContractForRun(workspace, run);
    const subtasks = await Promise.all(run.subtasks.map((id) => getSubtask(workspace, id)));
    const activeAttempts = subtasks.filter((subtask) => ACTIVE_ATTEMPT_STATUSES.has(subtask.status));
    if (activeAttempts.length > 0) {
      throw orchError("ROUND_ACTIVE_ATTEMPTS", "A round cannot complete while subtask attempts are DISPATCHED, RUNNING, or REVIEWING.", {
        runId,
        subtaskIds: activeAttempts.map((subtask) => subtask.subtaskId)
      });
    }
    const unresolvedIntents = (await listWriteIntents(workspace)).filter((intent) =>
      intent.runRef === runId && (intent.status === "PENDING" || intent.status === "CONFIRMED")
    );
    if (unresolvedIntents.length > 0) {
      throw orchError("ROUND_WRITE_INTENTS_UNRESOLVED", "A round cannot complete while write intents remain PENDING or CONFIRMED.", {
        runId,
        writeIntentIds: unresolvedIntents.map((intent) => intent.writeIntentId)
      });
    }

    const validatorReceiptIds: string[] = [];
    const verifiedArtifactRefs: string[] = [];
    for (const subtask of subtasks) {
      assertSubtaskBinding(run, subtask, runId, subtask.subtaskId);
      await reverifyInputArtifacts(workspace, run, subtask);
      if (subtask.status !== "ACCEPTED") continue;
      const observations = await collectCurrentArtifactObservations(workspace, run, subtask);
      if (observations.length === 0) {
        throw orchError("ROUND_ACCEPTED_ARTIFACT_INVALID", "An ACCEPTED subtask no longer has a current-attempt verified file artifact.", { subtaskId: subtask.subtaskId, attempt: subtask.retriesUsed });
      }
      verifiedArtifactRefs.push(...observations.map((observation) => observation.artifactId));
      validatorReceiptIds.push(...await assertAcceptedReviewIntegrity(workspace, run, subtask, observations));
    }

    const preparedAt = new Date().toISOString();
    const transactionId = completionTransactionId(runId, run.round);
    let nextRun: OrchestrationRun = {
      ...run,
      round: run.round + 1,
      goalConsistency: [...run.goalConsistency, {
        round: run.round,
        passed: input.passed,
        note: input.note,
        validatorReceiptIds,
        artifactRefs: verifiedArtifactRefs,
        engineVerifiedAt: preparedAt
      }]
    };
    let nextContract: TaskContract = contract;
    const ledgerEffects: OrchestrationLedgerEffect[] = [];
    if (!input.passed && cfg.defaults?.autoEscalateOnConsistencyFail === true) {
      nextRun = { ...nextRun, status: "ESCALATED", escalatedAt: preparedAt, escalationReason: `Goal-consistency check failed: ${input.note}` };
      ledgerEffects.push(orchestrationLedgerEffect(transactionId, "consistency-escalated", { event: "orchestration-escalated", taskId: contract.taskId, contractRef: contract.contractId, runRef: runId, summary: `Run ${runId} escalated (auto): consistency check failed; note ${auditTextFingerprint(input.note)}.` }));
    } else if (input.passed) {
      const accepted = subtasks.length > 0 && subtasks.every((item) => item.status === "ACCEPTED");
      const coveredCriteria = new Set(subtasks.filter((item) => item.status === "ACCEPTED").flatMap((item) => item.acceptanceCriteria));
      const contractCovered = contract.globalAcceptanceCriteria.every((criterion) => coveredCriteria.has(criterion));
      if (accepted && contractCovered) {
        nextRun = { ...nextRun, status: "COMPLETED", completedAt: preparedAt };
        nextContract = { ...contract, status: "COMPLETED" };
        ledgerEffects.push(
          orchestrationLedgerEffect(transactionId, "round-completed", { event: "round-completed", taskId: contract.taskId, contractRef: contract.contractId, runRef: runId, round: run.round, summary: `Round ${run.round} completed; consistency passed; note ${auditTextFingerprint(input.note)}.` }),
          orchestrationLedgerEffect(transactionId, "orchestration-completed", { event: "orchestration-completed", taskId: contract.taskId, contractRef: contract.contractId, runRef: runId, summary: `Run ${runId} completed: all ${subtasks.length} subtasks accepted and all contract criteria covered.` })
        );
      }
    }

    if (ledgerEffects.length === 0 && nextRun.round >= run.budget.maxRounds) {
      nextRun = { ...nextRun, status: "FAILED", completedAt: preparedAt, escalationReason: `ROUND_BUDGET: Run exhausted maxRounds ${run.budget.maxRounds}.` };
      ledgerEffects.push(
        orchestrationLedgerEffect(transactionId, "round-completed", { event: "round-completed", taskId: contract.taskId, contractRef: contract.contractId, runRef: runId, round: run.round, summary: `Round ${run.round} completed; consistency ${input.passed ? "passed" : "failed"}; note ${auditTextFingerprint(input.note)}.` }),
        orchestrationLedgerEffect(transactionId, "round-budget-failed", { event: "orchestration-failed", taskId: contract.taskId, contractRef: contract.contractId, runRef: runId, summary: `Run ${runId} failed: ROUND_BUDGET exhausted at ${run.budget.maxRounds}.` })
      );
    } else if (ledgerEffects.length === 0) {
      ledgerEffects.push(orchestrationLedgerEffect(transactionId, "round-completed", { event: "round-completed", taskId: contract.taskId, contractRef: contract.contractId, runRef: runId, round: run.round, summary: `Round ${run.round} completed; consistency ${input.passed ? "passed" : "failed"}; note ${auditTextFingerprint(input.note)}.` }));
    }

    schemas.validate("orchestration-run", nextRun);
    schemas.validate("orchestration-contract", nextContract);
    const transaction: CompletionTransaction = {
      version: 1,
      transactionId,
      kind: "COMPLETION",
      status: "PREPARED",
      requestHash,
      contractRef: contract.contractId,
      runRef: runId,
      round: run.round,
      sourceRunHash: orchestrationRecordHash(run),
      sourceContractHash: orchestrationRecordHash(contract),
      nextRun,
      nextContract,
      ledgerEffects,
      preparedAt,
      updatedAt: preparedAt
    };
    await prepareOrchestrationTransaction(workspace, schemas, transaction);
    return (await reconcileOrchestrationTransaction(workspace, schemas, transactionId) as CompletionTransaction).nextRun;
  });
}

/** Escalates a run to the user. Ledger: orchestration-escalated. */
export async function escalateRun(workspace: LocalWorkspace, runId: string, reason: string): Promise<OrchestrationRun> {
  return withWorkspaceLock(workspace, async () => {
    const normalizedReason = reason.trim();
    if (normalizedReason.length === 0 || normalizedReason.length > 1024) {
      throw orchError("RUN_ESCALATION_REASON_INVALID", "Escalation reason must be 1-1024 characters.");
    }
    const schemas = await defaultSchemaRegistry();
    const run = await getRun(workspace, runId);
    await assertRunNotCancelling(workspace, runId);
    const escalationGeneration = (run.resumeGeneration ?? 0) + 1;
    const transactionId = escalationTransactionId(runId, escalationGeneration);
    const requestHash = orchestrationRequestHash({
      kind: "MANUAL_ESCALATION",
      runRef: runId,
      escalationGeneration,
      reason: normalizedReason
    });
    const existing = await findOrchestrationTransaction(workspace, transactionId);
    if (existing !== undefined) {
      if (existing.kind !== "ESCALATION" || existing.requestHash !== requestHash) {
        throw orchError("RUN_ESCALATION_IDEMPOTENCY_CONFLICT", "This Run escalation generation is already bound to a different exact reason.", {
          runId,
          escalationGeneration,
          transactionId
        });
      }
      return (await reconcileOrchestrationTransaction(workspace, schemas, transactionId) as EscalationTransaction).nextRun;
    }
    if (!EXECUTABLE_RUN_STATUSES.has(run.status)) throw orchError("RUN_STATE_CONFLICT", "Only executable RUNNING/DEGRADED runs can be escalated.", { runId, status: run.status });
    const contract = await getActiveContractForRun(workspace, run);
    const preparedAt = new Date().toISOString();
    const next = { ...run, status: "ESCALATED" as const, escalatedAt: preparedAt, escalationReason: normalizedReason };
    schemas.validate("orchestration-run", next);
    const transaction: EscalationTransaction = {
      version: 1,
      transactionId,
      kind: "ESCALATION",
      status: "PREPARED",
      requestHash,
      contractRef: contract.contractId,
      runRef: runId,
      round: run.round,
      escalationGeneration,
      sourceRunHash: orchestrationRecordHash(run),
      nextRun: next,
      ledgerEffects: [orchestrationLedgerEffect(transactionId, "manual-escalation", {
        event: "orchestration-escalated",
        taskId: contract.taskId,
        contractRef: contract.contractId,
        runRef: runId,
        summary: `Run ${runId} escalated; reason ${auditTextFingerprint(normalizedReason)}.`
      })],
      preparedAt,
      updatedAt: preparedAt
    };
    await prepareOrchestrationTransaction(workspace, schemas, transaction);
    return (await reconcileOrchestrationTransaction(workspace, schemas, transactionId) as EscalationTransaction).nextRun;
  });
}

/**
 * Human decision path after escalation: resumes an ESCALATED run back to RUNNING,
 * optionally adjusting the budget (rounds/tokens) per the user's choice.
 * Ledger: orchestration-resumed.
 */
export interface ResumeRunInput {
  /** Caller-observed next generation. A stale human decision must never resume a later escalation. */
  expectedResumeGeneration: number;
  maxRounds?: number;
  maxSubtaskTokens?: number;
}

export async function resumeRun(workspace: LocalWorkspace, runId: string, input: ResumeRunInput): Promise<OrchestrationRun> {
  return withWorkspaceLock(workspace, async () => {
    assertResumeRequestShape(input);
    const schemas = await defaultSchemaRegistry();
    await assertRunNotCancelling(workspace, runId);
    await reconcilePendingManualEscalation(workspace, schemas, runId);
    const run = await getRun(workspace, runId);
    await getActiveContractForRun(workspace, run);
    if (run.status !== "ESCALATED") {
      if (
        EXECUTABLE_RUN_STATUSES.has(run.status) && (run.resumeGeneration ?? 0) > 0 &&
        input.expectedResumeGeneration === run.resumeGeneration
      ) {
        const expectedHash = hashRunResumeRequest(runId, run.resumeGeneration!, input);
        if (run.resumeRequestHash !== expectedHash) {
          throw orchError("RUN_RESUME_IDEMPOTENCY_CONFLICT", "The active Run was resumed by a different exact request.", {
            runId,
            resumeGeneration: run.resumeGeneration
          });
        }
        await ensureOrchestrationActivationCommitted(workspace, run);
        return run;
      }
      if (EXECUTABLE_RUN_STATUSES.has(run.status) && (run.resumeGeneration ?? 0) > 0) {
        throw orchError("RUN_RESUME_GENERATION_STALE", "The caller resume generation does not match the active Run generation.", {
          runId,
          expectedResumeGeneration: input.expectedResumeGeneration,
          resumeGeneration: run.resumeGeneration
        });
      }
      throw orchError("RUN_STATE_CONFLICT", "Only ESCALATED runs can be resumed.", { runId, status: run.status });
    }
    await assertRunNotCancelling(workspace, runId);
    const resumeGeneration = (run.resumeGeneration ?? 0) + 1;
    if (input.expectedResumeGeneration !== resumeGeneration) {
      throw orchError("RUN_RESUME_GENERATION_STALE", "The caller human-decision generation is stale for the current escalation.", {
        runId,
        expectedResumeGeneration: input.expectedResumeGeneration,
        nextResumeGeneration: resumeGeneration,
        currentResumeGeneration: run.resumeGeneration ?? 0
      });
    }
    const budget = { ...run.budget };
    if (input.maxRounds !== undefined) {
      if (!Number.isSafeInteger(input.maxRounds) || input.maxRounds < 1 || input.maxRounds > 100) {
        throw orchError("RUN_RESUME_BUDGET_INVALID", "maxRounds must be 1-100.", { maxRounds: input.maxRounds });
      }
      budget.maxRounds = input.maxRounds;
    }
    if (input.maxSubtaskTokens !== undefined) {
      if (!Number.isSafeInteger(input.maxSubtaskTokens) || input.maxSubtaskTokens < 1000 || input.maxSubtaskTokens > 10_000_000) {
        throw orchError("RUN_RESUME_BUDGET_INVALID", "maxSubtaskTokens must be 1000-10000000.", { maxSubtaskTokens: input.maxSubtaskTokens });
      }
      budget.maxSubtaskTokens = input.maxSubtaskTokens;
    }
    assertRunBudget(budget, "RUN_RESUME_BUDGET_INVALID");
    if (budget.maxRounds <= run.round) {
      throw orchError("RUN_RESUME_BUDGET_INVALID", "Resumed maxRounds must be greater than the number of already completed rounds.", { maxRounds: budget.maxRounds, completedRounds: run.round });
    }
    if (budget.maxSubtaskTokens <= run.budget.usedTokens) {
      throw orchError("RUN_RESUME_BUDGET_INVALID", "Resumed maxSubtaskTokens must be greater than the tokens already used.", { maxSubtaskTokens: budget.maxSubtaskTokens, usedTokens: run.budget.usedTokens });
    }
    const hasFailedSubtask = (await Promise.all(run.subtasks.map((subtaskId) => getSubtask(workspace, subtaskId))))
      .some((subtask) => subtask.status === "FAILED");
    const resumedBudgetAdjusted = budget.maxRounds !== run.budget.maxRounds || budget.maxSubtaskTokens !== run.budget.maxSubtaskTokens;
    const next: OrchestrationRun = {
      ...run,
      status: hasFailedSubtask ? "DEGRADED" : "RUNNING",
      budget,
      resumedAt: new Date().toISOString(),
      resumeGeneration,
      resumeRequestHash: hashRunResumeRequest(runId, resumeGeneration, input),
      resumedBudgetAdjusted
    };
    schemas.validate("orchestration-run", next);
    await writeWorkspaceJson(workspace, runFile(runId), next);
    maybeInjectOrchestrationActivationFault(workspace, "after-run", runId);
    await ensureOrchestrationActivationCommitted(workspace, next);
    maybeInjectOrchestrationActivationFault(workspace, "after-ledger", runId);
    return next;
  });
}

async function reconcilePendingManualEscalation(
  workspace: LocalWorkspace,
  schemas: SchemaRegistry,
  runId: string
): Promise<void> {
  const pending = (await listOrchestrationTransactions(workspace)).filter((transaction): transaction is EscalationTransaction =>
    transaction.kind === "ESCALATION" && transaction.runRef === runId && transaction.status === "PREPARED"
  );
  if (pending.length > 1) {
    throw orchError("ORCHESTRATION_TRANSACTION_CONFLICT", "More than one PREPARED manual escalation transaction exists for this Run.", {
      runId,
      transactionIds: pending.map((transaction) => transaction.transactionId)
    });
  }
  if (pending[0] !== undefined) {
    await reconcileOrchestrationTransaction(workspace, schemas, pending[0].transactionId);
  }
}

/** Cancels a run. Ledger: orchestration-cancelled. */
export async function cancelRun(workspace: LocalWorkspace, runId: string): Promise<OrchestrationRun> {
  return withWorkspaceLock(workspace, async () => {
    const schemas = await defaultSchemaRegistry();
    let run = await getRun(workspace, runId);
    let pendingTransactions = (await listOrchestrationTransactions(workspace))
      .filter((transaction) => transaction.runRef === runId && transaction.status === "PREPARED");
    // If every mutable target already equals a PREPARED journal's intended
    // result, the business decision was published before cancellation began.
    // Finish only its audit/COMMITTED tail first; cancellation may then apply
    // to a non-terminal review result, but can never rewrite a completed one.
    for (const transaction of pendingTransactions) {
      if (await orchestrationTransactionTargetsAreIntended(workspace, transaction)) {
        await reconcileOrchestrationTransaction(workspace, schemas, transaction.transactionId);
      }
    }
    run = await getRun(workspace, runId);
    pendingTransactions = (await listOrchestrationTransactions(workspace))
      .filter((transaction) => transaction.runRef === runId && transaction.status === "PREPARED");
    // Cancellation is a terminal consumer of executable state. Repair every
    // already-published activation before installing the cancellation fence so
    // its creation/dispatch/start history cannot be lost or reordered later.
    await ensureOrchestrationActivationCommitted(workspace, run);
    for (const subtaskId of run.subtasks) {
      const subtask = await getSubtask(workspace, subtaskId);
      assertSubtaskBinding(run, subtask, runId, subtaskId);
      if (ACTIVE_ATTEMPT_STATUSES.has(subtask.status)) {
        await ensureOrchestrationActivationCommitted(workspace, run, subtask);
      }
    }
    // A fully published terminal Run is no longer cancellable.  Any surviving
    // PREPARED marker must first be reconciled as an audit-repair operation.
    if (run.status === "COMPLETED") {
      for (const transaction of pendingTransactions) {
        await reconcileOrchestrationTransaction(workspace, schemas, transaction.transactionId);
      }
      return getRun(workspace, runId);
    }
    const existingFence = await getRunCancellationFence(workspace, runId);
    if (run.status === "CANCELLED" && existingFence?.status === "CANCELLED") return run;
    await beginRunCancellation(workspace, runId);
    maybeInjectCancellationFault(workspace, "after-fence");
    // PREPARED means no commit decision was published.  Cancellation wins and
    // records an explicit ABORTED terminal journal instead of extending stale,
    // revoked, expired, or no-longer-wanted authority just to finish recovery.
    for (const transaction of pendingTransactions) {
      await abortOrchestrationTransactionForCancellation(workspace, schemas, transaction.transactionId);
    }
    run = await getRun(workspace, runId);
    for (const lease of await listLeases(workspace)) {
      if (lease.subtaskRef !== undefined && run.subtasks.includes(lease.subtaskRef) && lease.status === "active") {
        await revokeLease(workspace, lease.id, `Orchestration run ${runId} cancelled.`);
      }
    }
    const { cancelWriteIntentsForRun } = await import("./write-intents.js");
    await cancelWriteIntentsForRun(workspace, runId, `Orchestration run ${runId} cancelled.`);
    const next: OrchestrationRun = run.status === "CANCELLED"
      ? run
      : { ...run, status: "CANCELLED" as const, completedAt: new Date().toISOString() };
    if (run.status !== "CANCELLED") await writeWorkspaceJson(workspace, runFile(runId), next);
    maybeInjectCancellationFault(workspace, "after-run");
    const contract = await getContract(workspace, run.contractRef);
    await ensureCancellationLedgerEntry(workspace, contract, next);
    maybeInjectCancellationFault(workspace, "after-ledger");
    await completeRunCancellation(workspace, runId);
    return next;
  });
}

/** Test-only, single-use cancellation crash point. */
export function injectCancellationFaultForTesting(workspace: LocalWorkspace, point: "after-fence" | "after-run" | "after-ledger"): void {
  if (process.env.NODE_ENV !== "test") throw orchError("ORCHESTRATION_CANCELLATION_TEST_FAULT_DENIED", "Cancellation fault injection is available only under the test runner.");
  cancellationFaults.set(workspace.directory, point);
}

function maybeInjectCancellationFault(workspace: LocalWorkspace, point: "after-fence" | "after-run" | "after-ledger"): void {
  if (cancellationFaults.get(workspace.directory) !== point) return;
  cancellationFaults.delete(workspace.directory);
  throw orchError("ORCHESTRATION_CANCELLATION_TEST_FAULT", `Injected cancellation fault at ${point}.`, { point });
}

async function ensureCancellationLedgerEntry(workspace: LocalWorkspace, contract: TaskContract, run: OrchestrationRun): Promise<void> {
  const summary = `Run ${run.runId} cancelled.`;
  const entries = (await listLedgerEntries(workspace)).filter((entry) => entry.event === "orchestration-cancelled" && entry.runRef === run.runId);
  if (entries.length === 1) {
    const entry = entries[0]!;
    if (entry.taskId === contract.taskId && entry.contractRef === contract.contractId && entry.summary === summary) return;
  }
  if (entries.length > 0) {
    throw orchError("ORCHESTRATION_CANCELLATION_AUDIT_CONFLICT", "Cancellation audit for this Run is duplicated or bound to different canonical content.", {
      runId: run.runId,
      contractId: contract.contractId,
      count: entries.length
    });
  }
  await appendLedgerEntry(workspace, {
    event: "orchestration-cancelled",
    taskId: contract.taskId,
    contractRef: contract.contractId,
    runRef: run.runId,
    summary
  });
}

export async function getReview(workspace: LocalWorkspace, reviewId: string): Promise<ReviewRecord> {
  assertId(reviewId, "REVIEW_ID_INVALID");
  try {
    const value: unknown = JSON.parse(await readFile(await workspaceFile(workspace, reviewFile(reviewId)), "utf8"));
    (await defaultSchemaRegistry()).validate("orchestration-review", value);
    const review = value as ReviewRecord;
    if (review.reviewId !== reviewId) {
      throw orchError("REVIEW_ID_MISMATCH", "Stored Review ID does not match its canonical lookup ID.", {
        reviewId,
        storedReviewId: review.reviewId
      });
    }
    return review;
  } catch (error: unknown) {
    if (isCode(error, "ENOENT")) throw orchError("REVIEW_NOT_FOUND", "Review does not exist.", { reviewId });
    throw error;
  }
}

/* ------------------------------------------------------------------ */
/* internals                                                           */
/* ------------------------------------------------------------------ */

async function loadReviews(workspace: LocalWorkspace, run: OrchestrationRun, subtaskRef: string): Promise<ReviewRecord[]> {
  const reviews: ReviewRecord[] = [];
  for (const reviewId of run.reviews) {
    const review = await getReview(workspace, reviewId);
    if (review.subtaskRef === subtaskRef) reviews.push(review);
  }
  return reviews;
}

async function assertAcceptedReviewIntegrity(
  workspace: LocalWorkspace,
  run: OrchestrationRun,
  subtask: SubtaskPackage,
  observations: ValidatorArtifactObservation[]
): Promise<string[]> {
  const reviewIds = [...(subtask.reviewRefs ?? [])].reverse();
  let acceptedReview: ReviewRecord | undefined;
  for (const reviewId of reviewIds) {
    const review = await getReview(workspace, reviewId);
    if (review.decision === "ACCEPTED" && (review.attempt ?? 0) === subtask.retriesUsed) {
      acceptedReview = review;
      break;
    }
  }
  if (
    acceptedReview === undefined || acceptedReview.runRef !== run.runId || acceptedReview.subtaskRef !== subtask.subtaskId ||
    !run.reviews.includes(acceptedReview.reviewId) || !Array.isArray(acceptedReview.validatorReceiptIds) || acceptedReview.validatorReceiptIds.length === 0
  ) {
    throw orchError("ROUND_ACCEPTED_REVIEW_INVALID", "An ACCEPTED subtask lacks a bound accepted review with engine validator receipts.", { subtaskId: subtask.subtaskId, attempt: subtask.retriesUsed });
  }
  let byteValidatorSeen = false;
  for (const receiptId of acceptedReview.validatorReceiptIds) {
    const receipt = await getValidatorReceipt(workspace, receiptId);
    assertValidatorReceiptBinding(receipt, {
      runRef: run.runId,
      subtaskRef: subtask.subtaskId,
      reviewRef: acceptedReview.reviewId,
      attempt: subtask.retriesUsed
    });
    if (receipt.status !== "PASSED") {
      throw orchError("ROUND_VALIDATOR_RECEIPT_FAILED", "An ACCEPTED review references a validator receipt that did not pass.", { receiptId, status: receipt.status });
    }
    if (receipt.validatorId === "artifact-bytes") {
      byteValidatorSeen = true;
      const expected = new Map(observations.map((observation) => [observation.artifactId, observation]));
      if (receipt.artifactObservations.length !== expected.size || receipt.artifactObservations.some((observation) => {
        const current = expected.get(observation.artifactId);
        return current === undefined || current.path !== observation.path || current.expectedHash !== observation.expectedHash || current.observedHash !== observation.observedHash;
      })) {
        throw orchError("ROUND_VALIDATOR_RECEIPT_STALE", "The artifact-byte validator receipt does not describe the current accepted artifact set.", { receiptId });
      }
    }
  }
  if (!byteValidatorSeen) throw orchError("ROUND_VALIDATOR_RECEIPT_REQUIRED", "The accepted review lacks the mandatory artifact-bytes validator receipt.", { subtaskId: subtask.subtaskId });
  return acceptedReview.validatorReceiptIds;
}

async function assertRunNotCancelling(workspace: LocalWorkspace, runId: string): Promise<void> {
  if (await getRunCancellationFence(workspace, runId)) {
    throw orchError("RUN_CANCELLED", "A cancelling or cancelled run cannot be mutated.", { runId });
  }
}

function assertContractInput(input: CreateContractInput, cfg: OrchestrationConfig): void {
  if (!input.taskId || input.taskId.length > 128) throw orchError("CONTRACT_TASK_INVALID", "A valid taskId is required.");
  const maxDomainLength = cfg.defaults?.maxDomainLength ?? MAX_DOMAIN_LENGTH;
  if (!input.domain || input.domain.length > maxDomainLength) throw orchError("CONTRACT_DOMAIN_INVALID", `Contract domain (user-confirmed) is required and must be at most ${maxDomainLength} characters.`);
  if (input.goal.length < 1 || input.goal.length > 512) throw orchError("CONTRACT_GOAL_INVALID", "Contract goal must be 1-512 characters.");
  const maxContractCriteria = cfg.defaults?.maxContractCriteria ?? MAX_CONTRACT_CRITERIA;
  const maxContractScope = cfg.defaults?.maxContractScopeItems ?? MAX_CONTRACT_SCOPE;
  if (input.globalAcceptanceCriteria.length < 1 || input.globalAcceptanceCriteria.length > maxContractCriteria) {
    throw orchError("CONTRACT_CRITERIA_INVALID", `Global acceptance criteria must be 1-${maxContractCriteria} items.`);
  }
  if (input.scope.length < 1 || input.scope.length > maxContractScope) throw orchError("CONTRACT_SCOPE_INVALID", `Contract scope must be 1-${maxContractScope} workspace-relative prefixes.`);
  if (input.approvalRefs !== undefined && (input.approvalRefs.length > 50 || new Set(input.approvalRefs).size !== input.approvalRefs.length || input.approvalRefs.some((ref) => !ID_PATTERN.test(ref)))) {
    throw orchError("CONTRACT_APPROVAL_REFS_INVALID", "approvalRefs must contain at most 50 unique valid identifiers.");
  }
  if (input.hostSessionId !== undefined && (!input.hostSessionId.trim() || input.hostSessionId.length > 256)) {
    throw orchError("CONTRACT_HOST_SESSION_INVALID", "hostSessionId must be 1-256 characters when provided.");
  }
  for (const scope of input.scope) {
    try { assertWorkspacePathPolicy(scope, { ...(cfg.sensitiveExtraPaths === undefined ? {} : { sensitiveExtraPaths: cfg.sensitiveExtraPaths }) }); }
    catch (error: unknown) { throw orchError("CONTRACT_SCOPE_INVALID", error instanceof Error ? error.message : "Contract scope is invalid.", { scope }); }
  }
}

function assertSubtaskBinding(run: OrchestrationRun, subtask: SubtaskPackage, runId: string, subtaskId: string): void {
  if (subtask.runRef !== runId || subtask.contractRef !== run.contractRef || !run.subtasks.includes(subtaskId)) {
    throw orchError("SUBTASK_BINDING_MISMATCH", "Subtask is not bound to the supplied run and contract.", { runId, subtaskId });
  }
}

function assertActiveAttemptGeneration(subtask: SubtaskPackage): asserts subtask is SubtaskPackage & { activeAttempt: number } {
  if (!Number.isSafeInteger(subtask.activeAttempt) || subtask.activeAttempt !== subtask.retriesUsed) {
    throw orchError("SUBTASK_GENERATION_STALE", "The active attempt generation does not match the persisted retry generation.", {
      subtaskId: subtask.subtaskId,
      activeAttempt: subtask.activeAttempt,
      retriesUsed: subtask.retriesUsed
    });
  }
}

function assertExpectedDispatchAttempt(subtask: SubtaskPackage, expectedAttempt: number): void {
  if (!Number.isSafeInteger(expectedAttempt) || expectedAttempt < 0 || expectedAttempt !== subtask.retriesUsed) {
    throw orchError("SUBTASK_GENERATION_STALE", "The caller dispatch token does not match the persisted retry generation.", {
      subtaskId: subtask.subtaskId,
      expectedAttempt,
      activeAttempt: subtask.activeAttempt,
      retriesUsed: subtask.retriesUsed
    });
  }
  if (ACTIVE_ATTEMPT_STATUSES.has(subtask.status) && subtask.activeAttempt !== expectedAttempt) {
    throw orchError("SUBTASK_GENERATION_STALE", "The active dispatch generation does not match the caller token.", {
      subtaskId: subtask.subtaskId,
      expectedAttempt,
      activeAttempt: subtask.activeAttempt,
      retriesUsed: subtask.retriesUsed
    });
  }
}

function assertExpectedAttempt(subtask: SubtaskPackage, expectedAttempt: number): asserts subtask is SubtaskPackage & { activeAttempt: number } {
  assertActiveAttemptGeneration(subtask);
  if (!Number.isSafeInteger(expectedAttempt) || expectedAttempt < 0 || expectedAttempt !== subtask.activeAttempt) {
    throw orchError("SUBTASK_GENERATION_STALE", "The caller attempt token does not match the active retry generation.", {
      subtaskId: subtask.subtaskId,
      expectedAttempt,
      activeAttempt: subtask.activeAttempt,
      retriesUsed: subtask.retriesUsed
    });
  }
}

function scopeContains(parent: string, child: string): boolean {
  const normalizedParent = parent.replace(/^\.\//, "").replace(/[\\/]+$/, "") || ".";
  const normalizedChild = child.replace(/^\.\//, "").replace(/[\\/]+$/, "") || ".";
  return normalizedParent === "." || normalizedChild === normalizedParent || normalizedChild.startsWith(`${normalizedParent}/`);
}

function assertScopeSubset(child: string[], parent: string[], code: string, sensitiveExtraPaths?: string[]): void {
  for (const scope of child) {
    try { assertWorkspacePathPolicy(scope, { ...(sensitiveExtraPaths === undefined ? {} : { sensitiveExtraPaths }) }); }
    catch (error: unknown) { throw orchError(code, error instanceof Error ? error.message : "Subtask scope is invalid.", { scope }); }
  }
  if (child.some((scope) => !parent.some((allowed) => scopeContains(allowed, scope)))) {
    throw orchError(code, "Subtask scope must be a subset of the contract scope.", { child, parent });
  }
}

async function reverifyInputArtifacts(workspace: LocalWorkspace, run: OrchestrationRun, subtask: SubtaskPackage): Promise<ValidatorArtifactObservation[]> {
  const observations: ValidatorArtifactObservation[] = [];
  for (const ref of subtask.inputArtifacts) {
    const artifact = await getArtifact(workspace, ref.artifactId);
    if (artifact.runRef !== run.runId || !run.artifacts.includes(artifact.artifactId)) {
      throw orchError("ARTIFACT_BINDING_MISMATCH", "Input artifact is not bound to this run.", { artifactId: ref.artifactId, runId: run.runId });
    }
    if (artifact.contentHash !== ref.contentHash || artifact.status !== "VERIFIED") {
      throw orchError("ARTIFACT_HASH_MISMATCH", "Input artifact hash mismatch.", { subtaskId: subtask.subtaskId, artifactId: ref.artifactId });
    }
    if (artifact.kind !== "file" || artifact.path !== ref.path || ref.kind !== "file") {
      throw orchError("ARTIFACT_BINDING_MISMATCH", "Input artifact metadata is not the verified file reference stored in the subtask package.", { artifactId: ref.artifactId });
    }
    await assertAcceptedProducerArtifact(workspace, run, artifact);
    const observedHash = await assertArtifactCurrent(workspace, artifact);
    observations.push({ artifactId: artifact.artifactId, path: artifact.path, expectedHash: artifact.contentHash, observedHash });
  }
  return observations;
}

async function collectCurrentArtifactObservations(workspace: LocalWorkspace, run: OrchestrationRun, subtask: SubtaskPackage): Promise<ValidatorArtifactObservation[]> {
  const observations: ValidatorArtifactObservation[] = [];
  for (const artifactId of subtask.artifactRefs ?? []) {
    const artifact = await getArtifact(workspace, artifactId);
    if (artifact.runRef !== run.runId || artifact.subtaskRef !== subtask.subtaskId || !run.artifacts.includes(artifactId) || artifact.status !== "VERIFIED") {
      throw orchError("ARTIFACT_BINDING_MISMATCH", "Review artifact is not verified and bound to this run/subtask.", { artifactId });
    }
    if (artifact.kind !== "file") throw orchError("ARTIFACT_UNVERIFIABLE", "Only file artifacts are accepted in the 2.0.1 safety profile.", { artifactId, kind: artifact.kind });
    if ((artifact.attempt ?? 0) !== subtask.retriesUsed) continue;
    const observedHash = await assertArtifactCurrent(workspace, artifact);
    observations.push({ artifactId, path: artifact.path, expectedHash: artifact.contentHash, observedHash });
  }
  return observations;
}

async function assertNoActiveWriteSetConflict(workspace: LocalWorkspace, run: OrchestrationRun, subtask: SubtaskPackage): Promise<void> {
  if (!subtask.capabilities.includes("repository-write")) return;
  for (const candidateRun of await listRuns(workspace)) {
    if (!ACTIVE_RUN_STATUSES.has(candidateRun.status)) continue;
    for (const candidateId of candidateRun.subtasks) {
      if (candidateId === subtask.subtaskId) continue;
      const candidate = await getSubtask(workspace, candidateId);
      if (!candidate.capabilities.includes("repository-write") || !ACTIVE_ATTEMPT_STATUSES.has(candidate.status)) continue;
      assertActiveAttemptGeneration(candidate);
      if (scopesOverlap(subtask.scope, candidate.scope)) {
        throw orchError("ACTIVE_WRITE_SET_CONFLICT", "Overlapping repository-write attempts cannot be active concurrently.", {
          runId: run.runId,
          subtaskId: subtask.subtaskId,
          conflictingRunId: candidateRun.runId,
          conflictingSubtaskId: candidate.subtaskId
        });
      }
    }
  }
}

async function assertNoUnresolvedAttemptIntents(workspace: LocalWorkspace, run: OrchestrationRun, subtask: SubtaskPackage): Promise<void> {
  const unresolved = (await listWriteIntents(workspace)).filter((intent) => intent.status === "PENDING" || intent.status === "CONFIRMED");
  const own = unresolved.find((intent) => intent.runRef === run.runId && intent.subtaskRef === subtask.subtaskId);
  if (own !== undefined) {
    throw orchError("SUBTASK_WRITE_INTENT_CONFLICT", "A previous attempt has an unresolved write intent.", { subtaskId: subtask.subtaskId, writeIntentId: own.writeIntentId });
  }
  if (!subtask.capabilities.includes("repository-write")) return;
  const conflict = unresolved.find((intent) => intent.writes.some((write) => subtask.scope.some((scope) => artifactInScope([scope], write.target))));
  if (conflict !== undefined) {
    throw orchError("ACTIVE_WRITE_SET_CONFLICT", "An unresolved write intent overlaps the subtask write scope.", { subtaskId: subtask.subtaskId, writeIntentId: conflict.writeIntentId });
  }
}

function scopesOverlap(left: string[], right: string[]): boolean {
  return left.some((leftScope) => right.some((rightScope) => scopeContains(leftScope, rightScope) || scopeContains(rightScope, leftScope)));
}

async function resolveContractReviewPolicy(workspace: LocalWorkspace): Promise<NonNullable<TaskContract["reviewPolicy"]>> {
  try {
    const schemas = await defaultSchemaRegistry();
    canonicalRegistriesPromise ??= loadRegistries(PACKAGE_ROOT, schemas);
    return (await loadWorkspaceConfig(workspace, schemas, await canonicalRegistriesPromise)).profile === "individual"
      ? "SELF_REVIEW_AUDITED"
      : "INDEPENDENT_REQUIRED";
  } catch (error: unknown) {
    // Missing configuration can never weaken review independence. Storage-only
    // and legacy workspaces receive the strict rule in their immutable Contract.
    if (isCode(error, "ENOENT") || (error instanceof StinkyCobblerError && error.code === "WORKSPACE_CONFIG_NOT_FOUND")) return "INDEPENDENT_REQUIRED";
    throw error;
  }
}

function hashRunCreationRequest(input: CreateRunInput, contract: TaskContract): string {
  return `sha256:${createHash("sha256").update(JSON.stringify({
    version: 1,
    contractRef: input.contractRef,
    supersedesRunRef: input.supersedesRunRef ?? null,
    taskAuthorityHash: contract.taskAuthorityHash ?? null,
    policyVersion: contract.policyVersion ?? null,
    hostSessionId: contract.hostSessionId ?? null,
    maxRounds: input.maxRounds ?? null,
    maxRetriesPerSubtask: input.maxRetriesPerSubtask ?? null,
    maxSubtaskTokens: input.maxSubtaskTokens ?? null,
    failFast: input.failFast ?? null
  }), "utf8").digest("hex")}`;
}

function assertCreateRunRequestShape(input: CreateRunInput): void {
  if (input.supersedesRunRef !== undefined && !ID_PATTERN.test(input.supersedesRunRef)) {
    throw orchError("RUN_SUCCESSOR_BINDING_INVALID", "supersedesRunRef must be a canonical Run ID.", {
      supersedesRunRef: input.supersedesRunRef
    });
  }
  const integerFields: Array<[string, number | undefined]> = [
    ["maxRounds", input.maxRounds],
    ["maxRetriesPerSubtask", input.maxRetriesPerSubtask],
    ["maxSubtaskTokens", input.maxSubtaskTokens]
  ];
  for (const [field, value] of integerFields) {
    if (value !== undefined && !Number.isSafeInteger(value)) {
      throw orchError("RUN_BUDGET_INVALID", `${field} must be a finite safe integer.`, { [field]: value });
    }
  }
  if (input.failFast !== undefined && typeof input.failFast !== "boolean") {
    throw orchError("RUN_BUDGET_INVALID", "failFast must be boolean when provided.", { failFast: input.failFast });
  }
}

function hashRunResumeRequest(
  runId: string,
  resumeGeneration: number,
  input: ResumeRunInput
): string {
  return `sha256:${createHash("sha256").update(JSON.stringify({
    version: 1,
    runId,
    resumeGeneration,
    maxRounds: input.maxRounds ?? null,
    maxSubtaskTokens: input.maxSubtaskTokens ?? null
  }), "utf8").digest("hex")}`;
}

function assertResumeRequestShape(input: ResumeRunInput): void {
  if (!Number.isSafeInteger(input.expectedResumeGeneration) || input.expectedResumeGeneration < 1) {
    throw orchError("RUN_RESUME_GENERATION_STALE", "expectedResumeGeneration must be a positive integer returned by the current escalation state.", {
      expectedResumeGeneration: input.expectedResumeGeneration
    });
  }
  if (input.maxRounds !== undefined && (!Number.isSafeInteger(input.maxRounds) || input.maxRounds < 1 || input.maxRounds > 100)) {
    throw orchError("RUN_RESUME_BUDGET_INVALID", "maxRounds must be 1-100.", { maxRounds: input.maxRounds });
  }
  if (
    input.maxSubtaskTokens !== undefined &&
    (!Number.isSafeInteger(input.maxSubtaskTokens) || input.maxSubtaskTokens < 1000 || input.maxSubtaskTokens > 10_000_000)
  ) {
    throw orchError("RUN_RESUME_BUDGET_INVALID", "maxSubtaskTokens must be 1000-10000000.", { maxSubtaskTokens: input.maxSubtaskTokens });
  }
}

interface SubtaskCreationIdentity {
  contractRef: string;
  runRef: string;
  domain: string;
  goal: string;
  inputArtifactIds: string[];
  acceptanceCriteria: string[];
  scope: string[];
  maxRetries: number;
  capabilities: string[];
  dependsOn: string[];
  critical?: boolean;
}

function hashSubtaskCreationRequest(subtask: SubtaskCreationIdentity): string {
  return `sha256:${createHash("sha256").update(JSON.stringify({
    version: 1,
    contractRef: subtask.contractRef,
    runRef: subtask.runRef,
    domain: subtask.domain,
    goal: subtask.goal,
    inputArtifactIds: subtask.inputArtifactIds,
    acceptanceCriteria: subtask.acceptanceCriteria,
    scope: subtask.scope,
    maxRetries: subtask.maxRetries,
    capabilities: subtask.capabilities,
    dependsOn: subtask.dependsOn,
    critical: subtask.critical ?? null
  }), "utf8").digest("hex")}`;
}

async function findSubtaskByCreationHash(
  workspace: LocalWorkspace,
  run: OrchestrationRun,
  creationRequestHash: string
): Promise<SubtaskPackage | undefined> {
  const matches: SubtaskPackage[] = [];
  const seen = new Set<string>();
  for (const subtaskId of run.subtasks) {
    const candidate = await getSubtask(workspace, subtaskId);
    seen.add(candidate.subtaskId);
    if (candidate.creationRequestHash !== creationRequestHash) continue;
    assertSubtaskCreationHash(candidate);
    matches.push(candidate);
  }
  const names = await readdir(await workspaceFile(workspace, DIRECTORY));
  const subtaskNames = names.filter((name) => /^subtask-[A-Za-z0-9._-]{1,119}\.json$/.test(name)).sort();
  if (subtaskNames.length > MAX_SUBTASK_CREATION_SCAN_FILES) {
    throw orchError("SUBTASK_CREATION_SCAN_LIMIT", "Subtask creation recovery exceeds the bounded file scan limit.", {
      files: subtaskNames.length,
      limit: MAX_SUBTASK_CREATION_SCAN_FILES
    });
  }
  for (const name of subtaskNames) {
    const subtaskId = name.slice(0, -5);
    if (seen.has(subtaskId)) continue;
    const candidate = await getSubtask(workspace, subtaskId);
    if (candidate.runRef !== run.runId || candidate.creationRequestHash !== creationRequestHash) continue;
    assertSubtaskCreationHash(candidate);
    matches.push(candidate);
  }
  if (matches.length > 1) {
    throw orchError("SUBTASK_CREATION_CONFLICT", "One exact Subtask creation request resolves to multiple persisted records.", {
      runId: run.runId,
      creationRequestHash,
      subtaskIds: matches.map((candidate) => candidate.subtaskId)
    });
  }
  return matches[0];
}

function assertSubtaskCreationHash(subtask: SubtaskPackage): void {
  const expected = hashSubtaskCreationRequest({
    contractRef: subtask.contractRef,
    runRef: subtask.runRef,
    domain: subtask.domain,
    goal: subtask.goal,
    inputArtifactIds: subtask.inputArtifacts.map((artifact) => artifact.artifactId),
    acceptanceCriteria: subtask.acceptanceCriteria,
    scope: subtask.scope,
    maxRetries: subtask.maxRetries,
    capabilities: subtask.capabilities,
    dependsOn: subtask.dependsOn,
    ...(subtask.critical === undefined ? {} : { critical: subtask.critical })
  });
  if (subtask.creationRequestHash !== expected) {
    throw orchError("SUBTASK_CREATION_BINDING_MISMATCH", "Persisted Subtask creation identity does not match its immutable request fields.", {
      subtaskId: subtask.subtaskId,
      stored: subtask.creationRequestHash,
      expected
    });
  }
}

function runCreatedActivationEffect(contract: TaskContract, run: OrchestrationRun): AppendLedgerEntry {
  return prepareLedgerEntry({
    event: "run-created",
    taskId: contract.taskId,
    contractRef: contract.contractId,
    runRef: run.runId,
    summary: `Orchestration run ${run.runId} created.`
  });
}

function runResumedActivationEffect(contract: TaskContract, run: OrchestrationRun): AppendLedgerEntry {
  const resumeGeneration = run.resumeGeneration;
  if (
    !Number.isSafeInteger(resumeGeneration) || (resumeGeneration ?? 0) < 1 ||
    run.resumeRequestHash === undefined || run.resumedAt === undefined || run.resumedBudgetAdjusted === undefined
  ) {
    throw orchError("RUN_ACTIVATION_REISSUE_REQUIRED", "A resumed Run lacks its exact activation generation or request binding.", { runId: run.runId });
  }
  return prepareLedgerEntry({
    event: "orchestration-resumed",
    taskId: contract.taskId,
    contractRef: contract.contractId,
    runRef: run.runId,
    attempt: resumeGeneration!,
    summary: `Run ${run.runId} resume generation ${resumeGeneration} committed${run.resumedBudgetAdjusted ? " (budget adjusted)" : ""}.`
  });
}

function subtaskDispatchedActivationEffect(contract: TaskContract, run: OrchestrationRun, subtask: SubtaskPackage & { activeAttempt: number }): AppendLedgerEntry {
  return prepareLedgerEntry({
    event: "subtask-dispatched",
    taskId: contract.taskId,
    contractRef: contract.contractId,
    runRef: run.runId,
    subtaskRef: subtask.subtaskId,
    round: subtask.round,
    attempt: subtask.activeAttempt,
    summary: `Subtask ${subtask.subtaskId} attempt ${subtask.activeAttempt} dispatched (${subtask.capabilities.length} lease(s)).`
  });
}

function subtaskStartedActivationEffect(contract: TaskContract, run: OrchestrationRun, subtask: SubtaskPackage & { activeAttempt: number }): AppendLedgerEntry {
  return prepareLedgerEntry({
    event: "subtask-started",
    taskId: contract.taskId,
    contractRef: contract.contractId,
    runRef: run.runId,
    subtaskRef: subtask.subtaskId,
    round: subtask.round,
    attempt: subtask.activeAttempt,
    summary: `Subtask ${subtask.subtaskId} attempt ${subtask.activeAttempt} started.`
  });
}

async function ensureExactOrchestrationActivationEffect(workspace: LocalWorkspace, effect: AppendLedgerEntry): Promise<void> {
  const entries = await listLedgerEntries(workspace);
  const generationBound = effect.event !== "run-created";
  const sameIdentity = entries.filter((entry) =>
    entry.event === effect.event && entry.runRef === effect.runRef && entry.subtaskRef === effect.subtaskRef &&
    (!generationBound || entry.attempt === effect.attempt)
  );
  const exact = sameIdentity.filter((entry) => activationLedgerPayload(entry) === activationLedgerPayload(effect));
  if (sameIdentity.length > 1 || (sameIdentity.length === 1 && exact.length !== 1)) {
    throw orchError("ORCHESTRATION_ACTIVATION_AUDIT_CONFLICT", "Executable orchestration activation has a duplicate or conflicting audit effect.", {
      event: effect.event,
      runId: effect.runRef,
      subtaskId: effect.subtaskRef,
      attempt: effect.attempt,
      count: sameIdentity.length
    });
  }
  if (exact.length === 0) await appendLedgerEntry(workspace, effect);
}

function activationLedgerPayload(value: AppendLedgerEntry | Awaited<ReturnType<typeof listLedgerEntries>>[number]): string {
  const storageFields = new Set(["sequence", "id", "at", "prevHash", "hash"]);
  return JSON.stringify(Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !storageFields.has(key))
      .sort(([left], [right]) => left.localeCompare(right))
  ));
}

async function ensureRunCreatedLedgerEntry(workspace: LocalWorkspace, contract: TaskContract, run: OrchestrationRun): Promise<void> {
  await ensureExactOrchestrationActivationEffect(workspace, runCreatedActivationEffect(contract, run));
}

/**
 * Use-time activation fence. Persisted executable state is not usable until its
 * deterministic Run/resume/dispatch/start audit effects are uniquely present.
 */
export async function ensureOrchestrationActivationCommitted(
  workspace: LocalWorkspace,
  run: OrchestrationRun,
  subtask?: SubtaskPackage
): Promise<void> {
  return withWorkspaceLock(workspace, async () => {
    const currentRun = await getRun(workspace, run.runId);
    if (JSON.stringify(currentRun) !== JSON.stringify(run)) {
      throw orchError("ORCHESTRATION_ACTIVATION_STATE_CONFLICT", "The Run changed before activation reconciliation.", { runId: run.runId });
    }
    const contract = await getContract(workspace, currentRun.contractRef);
    await ensureRunCreatedLedgerEntry(workspace, contract, currentRun);
    if ((currentRun.resumeGeneration ?? 0) > 0) {
      await ensureExactOrchestrationActivationEffect(workspace, runResumedActivationEffect(contract, currentRun));
    }
    if (subtask === undefined) return;
    const currentSubtask = await getSubtask(workspace, subtask.subtaskId);
    if (JSON.stringify(currentSubtask) !== JSON.stringify(subtask)) {
      throw orchError("ORCHESTRATION_ACTIVATION_STATE_CONFLICT", "The subtask changed before activation reconciliation.", {
        runId: run.runId,
        subtaskId: subtask.subtaskId
      });
    }
    assertSubtaskBinding(currentRun, currentSubtask, currentRun.runId, currentSubtask.subtaskId);
    if (!ACTIVE_ATTEMPT_STATUSES.has(currentSubtask.status)) return;
    assertActiveAttemptGeneration(currentSubtask);
    await ensureExactOrchestrationActivationEffect(workspace, subtaskDispatchedActivationEffect(contract, currentRun, currentSubtask));
    if (currentSubtask.status === "RUNNING" || currentSubtask.status === "REVIEWING") {
      await ensureExactOrchestrationActivationEffect(workspace, subtaskStartedActivationEffect(contract, currentRun, currentSubtask));
    }
  });
}

function assertCurrentContractAuthority(contract: TaskContract): asserts contract is TaskContract & Required<Pick<TaskContract, "taskAuthorityHash" | "approvalRefs" | "policyVersion" | "hostSessionId" | "delegationBudget">> {
  if (contract.taskAuthorityHash === undefined || contract.approvalRefs === undefined || contract.policyVersion === undefined || contract.hostSessionId === undefined || contract.delegationBudget === undefined) {
    throw orchError("CONTRACT_REISSUE_REQUIRED", "This pre-2.0.1 Contract remains readable/cancellable but cannot create or dispatch execution; cancel it and create a new Contract under current Task authority.", {
      contractId: contract.contractId
    });
  }
}

/** Every Run mutation reloads its Contract so cancellation is an immediate execution fence. */
export async function getActiveContractForRun(workspace: LocalWorkspace, run: OrchestrationRun): Promise<TaskContract> {
  await ensureOrchestrationActivationCommitted(workspace, run);
  const contract = await getContract(workspace, run.contractRef);
  if (contract.status !== "ACTIVE") {
    throw orchError("CONTRACT_NOT_ACTIVE", "Run mutation is denied because its Contract is no longer ACTIVE.", {
      contractId: contract.contractId,
      contractStatus: contract.status,
      runId: run.runId
    });
  }
  assertCurrentContractAuthority(contract);
  await admitPersistedContractAuthority(workspace, contract);
  return contract;
}

async function reverifySubtaskArtifacts(workspace: LocalWorkspace, run: OrchestrationRun, subtask: SubtaskPackage): Promise<void> {
  if ((await collectCurrentArtifactObservations(workspace, run, subtask)).length === 0) {
    throw orchError("REVIEW_ARTIFACT_REQUIRED", "Accepted reviews require at least one verified file artifact from the current retry attempt.", { subtaskId: subtask.subtaskId, attempt: subtask.retriesUsed });
  }
}

async function assertAcceptedProducerArtifact(workspace: LocalWorkspace, run: OrchestrationRun, artifact: Artifact): Promise<void> {
  const producer = await getSubtask(workspace, artifact.subtaskRef);
  if (
    producer.runRef !== run.runId ||
    producer.contractRef !== run.contractRef ||
    !run.subtasks.includes(producer.subtaskId) ||
    producer.status !== "ACCEPTED" ||
    !producer.artifactRefs?.includes(artifact.artifactId) ||
    (artifact.attempt ?? 0) !== producer.retriesUsed
  ) {
    throw orchError("SUBTASK_INPUT_PRODUCER_INVALID", "Input artifacts must come from the current accepted attempt of a producer subtask in this run.", { artifactId: artifact.artifactId, producerSubtaskId: artifact.subtaskRef });
  }
}

async function assertArtifactCurrent(workspace: LocalWorkspace, artifact: Artifact): Promise<string> {
  const cfg = await loadOrchestrationConfig(workspace);
  try {
    await resolveWorkspacePath(workspace.root, artifact.path, {
      ...(cfg.sensitiveExtraPaths === undefined ? {} : { sensitiveExtraPaths: cfg.sensitiveExtraPaths })
    });
  } catch (error: unknown) {
    throw orchError("ARTIFACT_PATH_INVALID", error instanceof Error ? error.message : "Artifact path is invalid.", { artifactId: artifact.artifactId, path: artifact.path });
  }
  let bytes: Buffer;
  try {
    bytes = (await readBoundedWorkspaceFile(workspace.root, artifact.path, MAX_ARTIFACT_BYTES)).bytes;
  } catch (error: unknown) {
    if (isCode(error, "ENOENT")) throw orchError("ARTIFACT_FILE_MISSING", "Artifact file no longer exists.", { artifactId: artifact.artifactId, path: artifact.path });
    if (error instanceof WorkspaceReadBoundaryError) {
      throw orchError(
        error.reason === "size-limit" ? "ARTIFACT_SIZE_LIMIT" : "ARTIFACT_PATH_INVALID",
        error.message,
        { artifactId: artifact.artifactId, path: artifact.path, reason: error.reason, maxBytes: MAX_ARTIFACT_BYTES }
      );
    }
    throw error;
  }
  const currentHash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (currentHash !== artifact.contentHash) throw orchError("ARTIFACT_STALE", "Artifact content changed after verification.", { artifactId: artifact.artifactId, expected: artifact.contentHash, actual: currentHash });
  return currentHash;
}

function assertRelativePath(target: string): void {
  if (!target || target.includes("\0") || target.startsWith("/") || target.split(/[\\/]/).includes("..")) {
    throw orchError("ARTIFACT_PATH_INVALID", "Artifact paths must be workspace-relative.", { target });
  }
}

export function contractIdForRequest(
  input: CreateContractInput,
  taskAuthorityHash: string,
  reviewPolicy: NonNullable<TaskContract["reviewPolicy"]>
): string {
  const digest = createHash("sha256").update(JSON.stringify({
    version: 1,
    taskId: input.taskId,
    domain: input.domain,
    goal: input.goal,
    globalAcceptanceCriteria: input.globalAcceptanceCriteria,
    scope: input.scope,
    approvalRefs: [...(input.approvalRefs ?? [])].sort(),
    hostSessionId: input.hostSessionId ?? "local-cli",
    taskAuthorityHash,
    reviewPolicy
  }), "utf8").digest("hex").slice(0, 48);
  return `contract-${digest.match(/.{1,12}/g)?.join("-") ?? digest}`;
}

function contractMatchesRequest(
  contract: TaskContract,
  input: CreateContractInput,
  authority: Awaited<ReturnType<typeof admitTaskCapability>>,
  reviewPolicy: NonNullable<TaskContract["reviewPolicy"]>
): boolean {
  return contract.version === 1 &&
    contract.contractId === contractIdForRequest(input, authority.taskAuthorityHash, reviewPolicy) &&
    contract.taskId === input.taskId && contract.domain === input.domain && contract.goal === input.goal &&
    JSON.stringify(contract.globalAcceptanceCriteria) === JSON.stringify(input.globalAcceptanceCriteria) &&
    JSON.stringify(contract.scope) === JSON.stringify(input.scope) &&
    contract.taskAuthorityHash === authority.taskAuthorityHash && contract.policyVersion === authority.policyVersion &&
    contract.hostSessionId === authority.hostSessionId && contract.reviewPolicy === reviewPolicy &&
    JSON.stringify([...(contract.approvalRefs ?? [])].sort()) === JSON.stringify([...authority.approvalRefs].sort());
}

async function findUnloggedContractForRequest(
  workspace: LocalWorkspace,
  input: CreateContractInput
): Promise<TaskContract | undefined> {
  const entries = await listLedgerEntries(workspace);
  const logged = new Set(entries
    .filter((entry) => entry.event === "contract-created" && entry.contractRef !== undefined)
    .map((entry) => entry.contractRef!));
  const candidates = (await listAllContracts(workspace)).filter((contract) => {
    if (logged.has(contract.contractId)) return false;
    if (
      contract.taskAuthorityHash === undefined || contract.reviewPolicy === undefined ||
      contract.taskId !== input.taskId || contract.domain !== input.domain || contract.goal !== input.goal ||
      contract.hostSessionId !== (input.hostSessionId ?? "local-cli") ||
      JSON.stringify(contract.globalAcceptanceCriteria) !== JSON.stringify(input.globalAcceptanceCriteria) ||
      JSON.stringify(contract.scope) !== JSON.stringify(input.scope)
    ) return false;
    return contract.contractId === contractIdForRequest(input, contract.taskAuthorityHash, contract.reviewPolicy);
  });
  if (candidates.length > 1) {
    throw orchError("CONTRACT_RECOVERY_CONFLICT", "Multiple unlogged Contracts match the same deterministic creation request.", {
      taskId: input.taskId,
      contractIds: candidates.map((contract) => contract.contractId)
    });
  }
  return candidates[0];
}

async function ensureContractCreatedLedgerEntry(workspace: LocalWorkspace, contract: TaskContract): Promise<void> {
  const expected = prepareLedgerEntry({
    event: "contract-created",
    taskId: contract.taskId,
    contractRef: contract.contractId,
    summary: `Contract ${contract.contractId} created (${contract.globalAcceptanceCriteria.length} criteria).`
  });
  const entries = (await listLedgerEntries(workspace))
    .filter((entry) => entry.event === "contract-created" && entry.contractRef === contract.contractId);
  if (entries.length === 1) {
    const entry = entries[0]!;
    if (entry.taskId === expected.taskId && entry.summary === expected.summary) return;
  }
  if (entries.length > 0) {
    throw orchError("CONTRACT_CREATION_AUDIT_CONFLICT", "Contract creation audit is duplicated or bound to different canonical content.", {
      contractId: contract.contractId,
      count: entries.length
    });
  }
  await appendLedgerEntry(workspace, expected);
}

function contractTerminalLedgerEntry(contract: TaskContract, status: ContractStatus) {
  if (status !== "CANCELLED" && status !== "FAILED") {
    throw orchError("CONTRACT_STATUS_AUDIT_INVALID", "Only CANCELLED or FAILED Contract status is supported by the direct terminal audit path.", {
      contractId: contract.contractId,
      status
    });
  }
  return prepareLedgerEntry({
    event: status === "CANCELLED" ? "orchestration-cancelled" : "orchestration-failed",
    taskId: contract.taskId,
    contractRef: contract.contractId,
    summary: status === "CANCELLED"
      ? `Contract ${contract.contractId} cancelled after all active Runs terminated.`
      : `Contract ${contract.contractId} failed after all active Runs terminated.`
  });
}

async function ensureContractTerminalLedgerEntry(
  workspace: LocalWorkspace,
  contract: TaskContract,
  status: ContractStatus,
  prepared = contractTerminalLedgerEntry(contract, status)
): Promise<void> {
  const entries = (await listLedgerEntries(workspace)).filter((entry) =>
    entry.contractRef === contract.contractId && entry.runRef === undefined &&
    (entry.event === "orchestration-cancelled" || entry.event === "orchestration-failed")
  );
  if (entries.length === 1) {
    const entry = entries[0]!;
    if (entry.event === prepared.event && entry.taskId === prepared.taskId && entry.summary === prepared.summary) return;
  }
  if (entries.length > 0) {
    throw orchError("CONTRACT_STATUS_AUDIT_CONFLICT", "Contract terminal audit is duplicated or bound to different canonical content.", {
      contractId: contract.contractId,
      status,
      count: entries.length
    });
  }
  await appendLedgerEntry(workspace, prepared);
}

function assertRunBudget(budget: OrchestrationRun["budget"], code: string): void {
  if (!Number.isSafeInteger(budget.maxRounds) || budget.maxRounds < 1 || budget.maxRounds > 100) {
    throw orchError(code, "maxRounds must be 1-100.", { maxRounds: budget.maxRounds });
  }
  if (!Number.isSafeInteger(budget.maxRetriesPerSubtask) || budget.maxRetriesPerSubtask < 0 || budget.maxRetriesPerSubtask > 10) {
    throw orchError(code, "maxRetriesPerSubtask must be 0-10.", { maxRetriesPerSubtask: budget.maxRetriesPerSubtask });
  }
  if (!Number.isSafeInteger(budget.maxSubtaskTokens) || budget.maxSubtaskTokens < 1000 || budget.maxSubtaskTokens > 10_000_000) {
    throw orchError(code, "maxSubtaskTokens must be 1000-10000000.", { maxSubtaskTokens: budget.maxSubtaskTokens });
  }
  if (!Number.isSafeInteger(budget.usedTokens) || budget.usedTokens < 0) {
    throw orchError(code, "usedTokens must be a non-negative safe integer.", { usedTokens: budget.usedTokens });
  }
}

function assertExecutionBudgetAvailable(run: OrchestrationRun): void {
  assertRunBudget(run.budget, "RUN_BUDGET_INVALID");
  if (run.round >= run.budget.maxRounds) {
    throw orchError("ROUND_BUDGET_EXHAUSTED", "Run has no remaining round budget.", { round: run.round, maxRounds: run.budget.maxRounds });
  }
  if (run.budget.usedTokens >= run.budget.maxSubtaskTokens) {
    throw orchError("TOKEN_BUDGET_EXHAUSTED", "Run has no remaining token budget for another subtask execution.", { usedTokens: run.budget.usedTokens, maxSubtaskTokens: run.budget.maxSubtaskTokens });
  }
}

function assertSubtaskRetryAdmission(run: OrchestrationRun, subtask: SubtaskPackage): void {
  if (!Number.isSafeInteger(subtask.maxRetries) || subtask.maxRetries < 0 || subtask.maxRetries > run.budget.maxRetriesPerSubtask
      || !Number.isSafeInteger(subtask.retriesUsed) || subtask.retriesUsed < 0) {
    throw orchError("SUBTASK_RETRY_BUDGET_INVALID", "Persisted subtask retry state is invalid or exceeds the run retry budget.", {
      subtaskId: subtask.subtaskId,
      maxRetries: subtask.maxRetries,
      retriesUsed: subtask.retriesUsed,
      runMaxRetriesPerSubtask: run.budget.maxRetriesPerSubtask
    });
  }
  const retryExecution = subtask.status === "REJECTED" || (subtask.status === "DISPATCHED" && subtask.retriesUsed > 0);
  if (retryExecution && subtask.retriesUsed > subtask.maxRetries) {
    throw orchError("SUBTASK_RETRIES_EXHAUSTED", "Subtask has exhausted its retry budget and cannot start another execution.", { subtaskId: subtask.subtaskId, retriesUsed: subtask.retriesUsed, maxRetries: subtask.maxRetries });
  }
}

function assertId(id: string, code: string): void {
  if (!ID_PATTERN.test(id)) throw orchError(code, "Invalid identifier.", { id });
}

function contractFile(contractId: string): string { return path.join(DIRECTORY, `${contractId}.json`); }
function runFile(runId: string): string { return path.join(DIRECTORY, `${runId}.json`); }
function subtaskFile(subtaskId: string): string { return path.join(DIRECTORY, `${subtaskId}.json`); }
function artifactFile(artifactId: string): string { return path.join(DIRECTORY, `${artifactId}.json`); }
function reviewFile(reviewId: string): string { return path.join(DIRECTORY, `${reviewId}.json`); }

function orchError(code: string, message: string, details: Record<string, unknown> = {}): StinkyCobblerError {
  return new StinkyCobblerError(code, ExitCode.VALIDATION, message, details);
}

function isCode(error: unknown, code: string): boolean { return typeof error === "object" && error !== null && "code" in error && error.code === code; }

/* ------------------------------------------------------------------ */
/* Cost estimation (budget confirmation upfront)                       */
/* ------------------------------------------------------------------ */

export const ESTIMATED_TOKENS_PER_SUBTASK_ROUND = 8000;
export const ORCHESTRATE_TOKEN_THRESHOLD = 50_000;

export interface RunCostEstimate {
  mode: "direct" | "orchestrate";
  estimatedSubtasks: number;
  estimatedRounds: number;
  estimatedTokens: number;
  reason: string;
}

/** Simple cost model: subtasks × rounds × per-round tokens; shown to the user before run create (budget confirmation). */
export function estimateRunCost(contract: TaskContract, options: { plannedSubtasks?: number; maxRounds?: number } = {}, config?: OrchestrationConfig): RunCostEstimate {
  const planned = options.plannedSubtasks ?? Math.min(Math.max(Math.ceil(contract.globalAcceptanceCriteria.length / 2), 1), 10);
  const maxRounds = options.maxRounds ?? config?.defaults?.maxRounds ?? DEFAULT_MAX_ROUNDS;
  const rounds = Math.min(Math.max(Math.ceil(planned / 3), 1), maxRounds);
  const tokensPerRound = config?.defaults?.costTokensPerSubtaskRound ?? ESTIMATED_TOKENS_PER_SUBTASK_ROUND;
  const threshold = config?.defaults?.orchestrateTokenThreshold ?? ORCHESTRATE_TOKEN_THRESHOLD;
  const tokens = planned * rounds * tokensPerRound;
  const mode = tokens >= threshold ? "orchestrate" : "direct";
  return {
    mode,
    estimatedSubtasks: planned,
    estimatedRounds: rounds,
    estimatedTokens: tokens,
    reason: `~${planned} subtasks × ~${rounds} rounds × ${tokensPerRound} tokens per subtask-round.`
  };
}
