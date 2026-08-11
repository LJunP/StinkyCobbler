import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { SchemaRegistry } from "../contracts/schema-registry.js";
import type {
  Artifact, ContractStatus, Defect, OrchestrationRun, ReviewRecord, SubtaskPackage, TaskContract, ValidatorEvidence
} from "../contracts/orchestration.js";
import {
  DEFAULT_MAX_RETRIES_PER_SUBTASK, DEFAULT_MAX_ROUNDS, DEFAULT_MAX_SUBTASK_TOKENS,
  MAX_CONTRACT_CRITERIA, MAX_CONTRACT_SCOPE, MAX_DEFECTS, MAX_DOMAIN_INSTRUCTIONS, MAX_DOMAIN_LENGTH,
  MAX_INPUT_ARTIFACTS, MAX_REVIEW_TOKENS, MAX_SUBTASK_CRITERIA, MAX_SUBTASK_SCOPE
} from "../contracts/orchestration.js";
import { domainInstructionsFor } from "./specialists.js";
import { ExitCode, StinkyCobblerError } from "../errors.js";
import { loadOrchestrationConfig, type OrchestrationConfig } from "../config/tiered.js";
import { appendLedgerEntry } from "./ledger.js";
import { issueLease } from "./leases.js";
import { evaluateConstraints } from "../policy/orchestration-constraints.js";
import type { LocalWorkspace } from "./workspace.js";
import { createWorkspaceJson, workspaceFile, writeWorkspaceJson } from "./workspace.js";
import { withWorkspaceLock } from "./workspace-lock.js";

const DIRECTORY = "orchestration";
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ISSUE_CAPABILITIES = new Set(["repository-read", "git-read", "docs-index", "repository-write"]);

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
}

/** Creates the immutable task contract (contract anchor). Ledger: contract-created. */
export async function createContract(workspace: LocalWorkspace, schemas: SchemaRegistry, input: CreateContractInput): Promise<TaskContract> {
  return withWorkspaceLock(workspace, async () => {
    const cfg = await loadOrchestrationConfig(workspace);
    assertContractInput(input, cfg);
    await mkdir(await workspaceFile(workspace, DIRECTORY), { recursive: true, mode: 0o700 });
    const contract: TaskContract = {
      version: 1,
      contractId: `contract-${randomUUID()}`,
      taskId: input.taskId,
      domain: input.domain,
      goal: input.goal,
      globalAcceptanceCriteria: input.globalAcceptanceCriteria,
      scope: input.scope,
      createdAt: new Date().toISOString(),
      status: "ACTIVE"
    };
    schemas.validate("orchestration-contract", contract);
    await createWorkspaceJson(workspace, contractFile(contract.contractId), contract);
    await appendLedgerEntry(workspace, { event: "contract-created", taskId: contract.taskId, contractRef: contract.contractId, summary: `Contract ${contract.contractId} created (${contract.globalAcceptanceCriteria.length} criteria).` });
    return contract;
  });
}

export async function getContract(workspace: LocalWorkspace, contractId: string): Promise<TaskContract> {
  assertId(contractId, "CONTRACT_ID_INVALID");
  try {
    return JSON.parse(await readFile(await workspaceFile(workspace, contractFile(contractId)), "utf8")) as TaskContract;
  } catch (error: unknown) {
    if (isCode(error, "ENOENT")) throw orchError("CONTRACT_NOT_FOUND", "Contract does not exist.", { contractId });
    throw error;
  }
}

export async function listContracts(workspace: LocalWorkspace): Promise<TaskContract[]> {
  let names: string[];
  try { names = await readdir(await workspaceFile(workspace, DIRECTORY)); } catch (error: unknown) { if (isCode(error, "ENOENT")) return []; throw error; }
  const values = await Promise.all(names.filter((name) => /^contract-[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$/.test(name)).sort().map((name) => getContract(workspace, name.slice(0, -5))));
  return values.filter((contract) => contract.status === "ACTIVE");
}

export async function updateContractStatus(workspace: LocalWorkspace, schemas: SchemaRegistry, contractId: string, status: ContractStatus): Promise<TaskContract> {
  return withWorkspaceLock(workspace, async () => {
    const current = await getContract(workspace, contractId);
    const next = { ...current, status };
    schemas.validate("orchestration-contract", next);
    await writeWorkspaceJson(workspace, contractFile(contractId), next);
    return next;
  });
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
  maxRounds?: number;
  maxRetriesPerSubtask?: number;
  maxSubtaskTokens?: number;
}

/** Creates the orchestration run. Ledger: run-created. */
export async function createRun(workspace: LocalWorkspace, schemas: SchemaRegistry, input: CreateRunInput): Promise<OrchestrationRun> {
  return withWorkspaceLock(workspace, async () => {
    const contract = await getContract(workspace, input.contractRef);
    if (contract.status !== "ACTIVE") throw orchError("CONTRACT_NOT_ACTIVE", "Contract must be ACTIVE to create a run.", { contractId: input.contractRef });
    const cfg = await loadOrchestrationConfig(workspace);
    const run: OrchestrationRun = {
      version: 1,
      runId: `run-${randomUUID()}`,
      contractRef: contract.contractId,
      status: "RUNNING",
      round: 0,
      budget: {
        maxRounds: input.maxRounds ?? cfg.defaults?.maxRounds ?? DEFAULT_MAX_ROUNDS,
        maxRetriesPerSubtask: input.maxRetriesPerSubtask ?? cfg.defaults?.maxRetriesPerSubtask ?? DEFAULT_MAX_RETRIES_PER_SUBTASK,
        maxSubtaskTokens: input.maxSubtaskTokens ?? cfg.defaults?.maxSubtaskTokens ?? DEFAULT_MAX_SUBTASK_TOKENS,
        usedTokens: 0
      },
      subtasks: [],
      artifacts: [],
      reviews: [],
      goalConsistency: [],
      createdAt: new Date().toISOString()
    };
    schemas.validate("orchestration-run", run);
    await mkdir(await workspaceFile(workspace, DIRECTORY), { recursive: true, mode: 0o700 });
    await createWorkspaceJson(workspace, runFile(run.runId), run);
    await appendLedgerEntry(workspace, { event: "run-created", taskId: contract.taskId, contractRef: contract.contractId, runRef: run.runId, summary: `Orchestration run ${run.runId} created.` });
    return run;
  });
}

export async function getRun(workspace: LocalWorkspace, runId: string): Promise<OrchestrationRun> {
  assertId(runId, "RUN_ID_INVALID");
  try {
    return JSON.parse(await readFile(await workspaceFile(workspace, runFile(runId)), "utf8")) as OrchestrationRun;
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
}

/** Adds a subtask to the run (PENDING). Ledger: none (dispatch records). */
export async function addSubtask(workspace: LocalWorkspace, schemas: SchemaRegistry, runId: string, input: AddSubtaskInput): Promise<SubtaskPackage> {
  return withWorkspaceLock(workspace, async () => {
    const cfg = await loadOrchestrationConfig(workspace);
    const run = await getRun(workspace, runId);
    if (run.status !== "RUNNING" && run.status !== "DRAFT") throw orchError("RUN_STATE_CONFLICT", "Subtasks can only be added to a RUNNING run.", { runId, status: run.status });
    if (input.capabilities.length === 0 || !input.capabilities.every((cap) => ISSUE_CAPABILITIES.has(cap))) {
      throw orchError("SUBTASK_CAPABILITY_INVALID", "Subtask capabilities must be non-empty and within the issuable set.", { capabilities: input.capabilities });
    }
    if (input.goal.length < 1 || input.goal.length > 512) throw orchError("SUBTASK_GOAL_INVALID", "Subtask goal must be 1-512 characters.");
    const maxSubtaskCriteria = cfg.defaults?.maxSubtaskCriteria ?? MAX_SUBTASK_CRITERIA;
    const maxSubtaskScope = cfg.defaults?.maxSubtaskScopeItems ?? MAX_SUBTASK_SCOPE;
    const maxInputArtifacts = cfg.defaults?.maxInputArtifacts ?? MAX_INPUT_ARTIFACTS;
    if (input.acceptanceCriteria.length < 1 || input.acceptanceCriteria.length > maxSubtaskCriteria) throw orchError("SUBTASK_CRITERIA_INVALID", `Subtask acceptance criteria must be 1-${maxSubtaskCriteria} items.`);
    if (input.scope.length < 1 || input.scope.length > maxSubtaskScope) throw orchError("SUBTASK_SCOPE_INVALID", `Subtask scope must be 1-${maxSubtaskScope} workspace-relative prefixes.`);
    if (input.inputArtifactIds.length > maxInputArtifacts) throw orchError("SUBTASK_INPUT_INVALID", `Subtask input artifacts must be at most ${maxInputArtifacts}.`);
    const inputArtifacts = [];
    for (const artifactId of input.inputArtifactIds) {
      const artifact = await getArtifact(workspace, artifactId);
      inputArtifacts.push({ artifactId, contentHash: artifact.contentHash });
    }
    const contract = await getContract(workspace, run.contractRef);
    const subtaskDomain = input.domain ?? contract.domain;
    const maxDomainLength = cfg.defaults?.maxDomainLength ?? MAX_DOMAIN_LENGTH;
    if (subtaskDomain.length > maxDomainLength) throw orchError("SUBTASK_DOMAIN_INVALID", `Subtask domain must be at most ${maxDomainLength} characters.`);
    const domainInstructions = await domainInstructionsFor(workspace, subtaskDomain);
    const maxDomainInstructions = cfg.defaults?.maxDomainInstructions ?? MAX_DOMAIN_INSTRUCTIONS;
    if (domainInstructions.length > maxDomainInstructions) throw orchError("SUBTASK_DOMAIN_INSTRUCTIONS_INVALID", `Subtask domain instructions must be at most ${maxDomainInstructions} items.`);
    const subtask: SubtaskPackage = {
      version: 1,
      subtaskId: `subtask-${randomUUID()}`,
      contractRef: contract.contractId,
      runRef: run.runId,
      domain: subtaskDomain,
      domainInstructions: domainInstructions,
      goal: input.goal,
      inputArtifacts: inputArtifacts,
      acceptanceCriteria: input.acceptanceCriteria,
      scope: input.scope,
      maxRetries: input.maxRetries ?? run.budget.maxRetriesPerSubtask,
      capabilities: input.capabilities,
      status: "PENDING",
      round: run.round,
      retriesUsed: 0,
      dependsOn: input.dependsOn ?? [],
      createdAt: new Date().toISOString()
    };
    schemas.validate("orchestration-subtask", subtask);
    await createWorkspaceJson(workspace, subtaskFile(subtask.subtaskId), subtask);
    const next = { ...run, subtasks: [...run.subtasks, subtask.subtaskId] };
    await writeWorkspaceJson(workspace, runFile(runId), next);
    return subtask;
  });
}

export async function getSubtask(workspace: LocalWorkspace, subtaskId: string): Promise<SubtaskPackage> {
  assertId(subtaskId, "SUBTASK_ID_INVALID");
  try {
    return JSON.parse(await readFile(await workspaceFile(workspace, subtaskFile(subtaskId)), "utf8")) as SubtaskPackage;
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
export async function dispatchSubtask(workspace: LocalWorkspace, schemas: SchemaRegistry, runId: string, subtaskId: string, agentId: string): Promise<{ subtask: SubtaskPackage; leases: string[] }> {
  return withWorkspaceLock(workspace, async () => {
    const run = await getRun(workspace, runId);
    if (run.status !== "RUNNING") throw orchError("RUN_STATE_CONFLICT", "Only RUNNING runs can dispatch subtasks.", { runId, status: run.status });
    const subtask = await getSubtask(workspace, subtaskId);
    if (subtask.status !== "PENDING" && subtask.status !== "REJECTED") throw orchError("SUBTASK_STATE_CONFLICT", "Only PENDING (or REJECTED for redispatch) subtasks can be dispatched.", { subtaskId, status: subtask.status });
    for (const dep of subtask.dependsOn) {
      const depSubtask = await getSubtask(workspace, dep);
      if (depSubtask.status !== "ACCEPTED") throw orchError("SUBTASK_DEPENDENCY_PENDING", "A dependency is not ACCEPTED yet.", { subtaskId, dependency: dep, status: depSubtask.status });
    }
    for (const ref of subtask.inputArtifacts) {
      const artifact = await getArtifact(workspace, ref.artifactId);
      if (artifact.contentHash !== ref.contentHash || artifact.status !== "VERIFIED") {
        throw orchError("ARTIFACT_HASH_MISMATCH", "Input artifact hash mismatch; refusing to dispatch.", { subtaskId, artifactId: ref.artifactId });
      }
    }
    const contract = await getContract(workspace, run.contractRef);
    const leaseIds: string[] = [];
    for (const capability of subtask.capabilities) {
      const lease = await issueLease(workspace, schemas, {
        taskId: contract.taskId,
        agentId,
        role: "worker",
        capability,
        ...(capability === "repository-write" ? { writeSet: subtask.scope } : {}),
        subtaskRef: subtask.subtaskId,
        expiresInMinutes: 60,
        issuedBy: "user-confirmed"
      });
      leaseIds.push(lease.id);
    }
    const nextSubtask: SubtaskPackage = { ...subtask, status: "DISPATCHED", dispatchedAt: new Date().toISOString(), dispatchedAgentId: agentId, leaseRefs: [...(subtask.leaseRefs ?? []), ...leaseIds] };
    await writeWorkspaceJson(workspace, subtaskFile(subtaskId), nextSubtask);
    await appendLedgerEntry(workspace, { event: "subtask-dispatched", taskId: contract.taskId, contractRef: contract.contractId, runRef: runId, subtaskRef: subtaskId, summary: `Subtask ${subtaskId} dispatched (${leaseIds.length} lease(s)).` });
    return { subtask: nextSubtask, leases: leaseIds };
  });
}

/** Marks a dispatched subtask RUNNING (worker started). Ledger: subtask-started. */
export async function beginSubtask(workspace: LocalWorkspace, runId: string, subtaskId: string): Promise<SubtaskPackage> {
  return withWorkspaceLock(workspace, async () => {
    const subtask = await getSubtask(workspace, subtaskId);
    if (subtask.status !== "DISPATCHED") throw orchError("SUBTASK_STATE_CONFLICT", "Only DISPATCHED subtasks can begin.", { subtaskId, status: subtask.status });
    const next: SubtaskPackage = { ...subtask, status: "RUNNING" };
    await writeWorkspaceJson(workspace, subtaskFile(subtaskId), next);
    const run = await getRun(workspace, runId);
    const contract = await getContract(workspace, run.contractRef);
    await appendLedgerEntry(workspace, { event: "subtask-started", taskId: contract.taskId, contractRef: contract.contractId, runRef: runId, subtaskRef: subtaskId, summary: `Subtask ${subtaskId} started.` });
    return next;
  });
}

/* ------------------------------------------------------------------ */
/* Artifact                                                            */
/* ------------------------------------------------------------------ */

export interface ReportArtifactInput {
  path: string;
  kind: "file" | "summary" | "evidence";
}

/** Reports a worker artifact; engine verifies contentHash of the file. Ledger: artifact-recorded / artifact-mismatch. */
export async function reportArtifact(workspace: LocalWorkspace, schemas: SchemaRegistry, runId: string, subtaskId: string, input: ReportArtifactInput): Promise<Artifact> {
  return withWorkspaceLock(workspace, async () => {
    const subtask = await getSubtask(workspace, subtaskId);
    if (subtask.status !== "RUNNING" && subtask.status !== "REVIEWING") throw orchError("SUBTASK_STATE_CONFLICT", "Artifacts can only be reported for RUNNING/REVIEWING subtasks.", { subtaskId, status: subtask.status });
    const run = await getRun(workspace, runId);
    const contract = await getContract(workspace, run.contractRef);
    const artifact: Artifact = {
      version: 1,
      artifactId: `artifact-${randomUUID()}`,
      runRef: runId,
      subtaskRef: subtaskId,
      kind: input.kind,
      path: input.path,
      contentHash: "sha256:" + "0".repeat(64),
      round: run.round,
      status: "VERIFIED",
      createdAt: new Date().toISOString(),
      verifiedAt: new Date().toISOString()
    };
    if (input.kind === "file") {
      assertRelativePath(input.path);
      const absolute = path.resolve(workspace.root, input.path);
      if (!absolute.startsWith(`${workspace.root}${path.sep}`)) throw orchError("ARTIFACT_PATH_INVALID", "Artifact path escapes the workspace.", { path: input.path });
      let bytes: Buffer;
      try {
        bytes = await readFile(absolute);
      } catch (error: unknown) {
        if (isCode(error, "ENOENT")) throw orchError("ARTIFACT_FILE_MISSING", "Artifact file does not exist.", { path: input.path });
        throw error;
      }
      artifact.contentHash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
      const scopeDecision = evaluateConstraints({ run, subtask, reviews: await loadReviews(workspace, run, subtaskId), artifact });
      if (scopeDecision.code === "SCOPE_VIOLATION") {
        artifact.status = "REJECTED";
        schemas.validate("orchestration-artifact", artifact);
        await createWorkspaceJson(workspace, artifactFile(artifact.artifactId), artifact);
        const nextRun = { ...run, artifacts: [...run.artifacts, artifact.artifactId] };
        await writeWorkspaceJson(workspace, runFile(runId), nextRun);
        await appendLedgerEntry(workspace, { event: "artifact-mismatch", taskId: contract.taskId, contractRef: contract.contractId, runRef: runId, subtaskRef: subtaskId, artifactRef: artifact.artifactId, summary: `Artifact ${artifact.artifactId} rejected: ${scopeDecision.detail}` });
        return artifact;
      }
    }
    schemas.validate("orchestration-artifact", artifact);
    await createWorkspaceJson(workspace, artifactFile(artifact.artifactId), artifact);
    const nextRun = { ...run, artifacts: [...run.artifacts, artifact.artifactId] };
    await writeWorkspaceJson(workspace, runFile(runId), nextRun);
    await appendLedgerEntry(workspace, { event: "artifact-recorded", taskId: contract.taskId, contractRef: contract.contractId, runRef: runId, subtaskRef: subtaskId, artifactRef: artifact.artifactId, summary: `Artifact ${artifact.artifactId} recorded (${artifact.kind}, hash ${artifact.contentHash.slice(0, 20)}...).` });
    const reviewStatus: SubtaskPackage = { ...subtask, status: "REVIEWING", artifactRefs: [...(subtask.artifactRefs ?? []), artifact.artifactId] };
    await writeWorkspaceJson(workspace, subtaskFile(subtaskId), reviewStatus);
    return artifact;
  });
}

export async function getArtifact(workspace: LocalWorkspace, artifactId: string): Promise<Artifact> {
  assertId(artifactId, "ARTIFACT_ID_INVALID");
  try {
    return JSON.parse(await readFile(await workspaceFile(workspace, artifactFile(artifactId)), "utf8")) as Artifact;
  } catch (error: unknown) {
    if (isCode(error, "ENOENT")) throw orchError("ARTIFACT_NOT_FOUND", "Artifact does not exist.", { artifactId });
    throw error;
  }
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
  validatorEvidence: ValidatorEvidence[];
  reviewedBy: string;
  /** Host-reported tokens consumed by this subtask round; engine accumulates into run.budget.usedTokens. */
  tokensUsed?: number;
}

/**
 * Records the dual-channel review and applies the constraint engine:
 * ACCEPTED → subtask ACCEPTED; REJECTED → retries/FAILED; oscillation/regression/budget → ESCALATED/FAILED.
 * Ledger: review-recorded / subtask-accepted / subtask-rejected / orchestration-escalated / orchestration-failed / orchestration-completed.
 */
export async function recordReview(workspace: LocalWorkspace, schemas: SchemaRegistry, runId: string, subtaskId: string, input: RecordReviewInput): Promise<{ review: ReviewRecord; run: OrchestrationRun; subtask: SubtaskPackage }> {
  return withWorkspaceLock(workspace, async () => {
    const run = await getRun(workspace, runId);
    if (run.status !== "RUNNING") throw orchError("RUN_STATE_CONFLICT", "Reviews only apply to RUNNING runs.", { runId, status: run.status });
    const subtask = await getSubtask(workspace, subtaskId);
    if (subtask.status !== "REVIEWING" && subtask.status !== "RUNNING") throw orchError("SUBTASK_STATE_CONFLICT", "Subtask must be REVIEWING (or RUNNING) to review.", { subtaskId, status: subtask.status });
    if (input.decision === "REJECTED" && input.defects.length < 1) throw orchError("REVIEW_DEFECTS_REQUIRED", "REJECTED reviews require at least one actionable defect.");
    if (input.reason.length < 1 || input.reason.length > 1024) throw orchError("REVIEW_REASON_REQUIRED", "Review reason is required (1-1024 characters).");
    if (input.score < 0 || input.score > 100) throw orchError("REVIEW_SCORE_INVALID", "Review score must be 0-100.");
    if (input.defects.length > MAX_DEFECTS) throw orchError("REVIEW_DEFECTS_TOO_MANY", `At most ${MAX_DEFECTS} defects per review.`);
    if (input.tokensUsed !== undefined && (!Number.isSafeInteger(input.tokensUsed) || input.tokensUsed < 0 || input.tokensUsed > MAX_REVIEW_TOKENS)) {
      throw orchError("REVIEW_TOKENS_INVALID", `tokensUsed must be a non-negative integer at most ${MAX_REVIEW_TOKENS}.`);
    }
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
    const cfg = await loadOrchestrationConfig(workspace);
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
    // Same-source flag (P2): reviewer === executor is allowed but audit-visible.
    const sameSourceReview = subtask.dispatchedAgentId !== undefined && input.reviewedBy === subtask.dispatchedAgentId;
    const contract = await getContract(workspace, run.contractRef);
    const review: ReviewRecord = {
      version: 1,
      reviewId: `review-${randomUUID()}`,
      runRef: runId,
      subtaskRef: subtaskId,
      round: run.round,
      decision,
      criteriaResults: input.criteriaResults,
      defects,
      score,
      reason,
      validatorEvidence: input.validatorEvidence,
      createdAt: new Date().toISOString(),
      reviewedBy: input.reviewedBy,
      ...(input.tokensUsed === undefined ? {} : { tokensUsed: input.tokensUsed }),
      ...(sameSourceReview ? { sameSourceReview: true } : {})
    };
    schemas.validate("orchestration-review", review);
    await createWorkspaceJson(workspace, reviewFile(review.reviewId), review);

    const reviews = [...(await loadReviews(workspace, run, subtaskId)), review];
    // Accumulate host-reported token consumption BEFORE constraint evaluation so TOKEN_BUDGET is live.
    const nextBudget = { ...run.budget, usedTokens: run.budget.usedTokens + (input.tokensUsed ?? 0) };
    let nextRun = { ...run, budget: nextBudget, reviews: [...run.reviews, review.reviewId] };
    let nextSubtask: SubtaskPackage;

    if (decision === "ACCEPTED") {
      nextSubtask = { ...subtask, status: "ACCEPTED", completedAt: new Date().toISOString(), reviewRefs: [...(subtask.reviewRefs ?? []), review.reviewId] };
      await writeWorkspaceJson(workspace, subtaskFile(subtaskId), nextSubtask);
      await writeWorkspaceJson(workspace, runFile(runId), nextRun);
      await appendLedgerEntry(workspace, { event: "review-recorded", taskId: contract.taskId, contractRef: contract.contractId, runRef: runId, subtaskRef: subtaskId, reviewRef: review.reviewId, summary: `Review ${review.reviewId}: ACCEPTED (score ${review.score})${sameSourceReview ? " [same-source]" : ""}.` });
      await appendLedgerEntry(workspace, { event: "subtask-accepted", taskId: contract.taskId, contractRef: contract.contractId, runRef: runId, subtaskRef: subtaskId, summary: `Subtask ${subtaskId} accepted.` });
    } else {
      nextSubtask = { ...subtask, status: "REJECTED", retriesUsed: subtask.retriesUsed + 1, reviewRefs: [...(subtask.reviewRefs ?? []), review.reviewId], lastDefects: input.defects };
      await writeWorkspaceJson(workspace, subtaskFile(subtaskId), nextSubtask);
      await writeWorkspaceJson(workspace, runFile(runId), nextRun);
      await appendLedgerEntry(workspace, { event: "review-recorded", taskId: contract.taskId, contractRef: contract.contractId, runRef: runId, subtaskRef: subtaskId, reviewRef: review.reviewId, summary: `Review ${review.reviewId}: REJECTED (score ${review.score})${sameSourceReview ? " [same-source]" : ""}.` });
      await appendLedgerEntry(workspace, { event: "subtask-rejected", taskId: contract.taskId, contractRef: contract.contractId, runRef: runId, subtaskRef: subtaskId, summary: `Subtask ${subtaskId} rejected with ${input.defects.length} defect(s).` });
    }

    // Constraint engine: oscillation / regression escalate; budgets fail.
    const oscillationThreshold = cfg.defaults?.oscillationThreshold;
    const constraint = evaluateConstraints({ run: nextRun, subtask: nextSubtask, reviews, ...(oscillationThreshold === undefined ? {} : { oscillationThreshold }) });
    if (constraint.action === "escalate") {
      nextRun = { ...nextRun, status: "ESCALATED", escalatedAt: new Date().toISOString(), escalationReason: constraint.code === null ? constraint.detail : `${constraint.code}: ${constraint.detail}` };
      await writeWorkspaceJson(workspace, runFile(runId), nextRun);
      await appendLedgerEntry(workspace, { event: "orchestration-escalated", taskId: contract.taskId, contractRef: contract.contractId, runRef: runId, subtaskRef: subtaskId, summary: `Run ${runId} escalated: ${constraint.detail}` });
    } else if (constraint.action === "fail") {
      nextRun = { ...nextRun, status: "FAILED", completedAt: new Date().toISOString(), escalationReason: `${constraint.code}: ${constraint.detail}` };
      await writeWorkspaceJson(workspace, runFile(runId), nextRun);
      await appendLedgerEntry(workspace, { event: "orchestration-failed", taskId: contract.taskId, contractRef: contract.contractId, runRef: runId, subtaskRef: subtaskId, summary: `Run ${runId} failed: ${constraint.detail}` });
    }

    // Auto-complete when every subtask is ACCEPTED.
    if (nextRun.status === "RUNNING") {
      const all = await Promise.all(nextRun.subtasks.map((id) => getSubtask(workspace, id)));
      if (all.length > 0 && all.every((item) => item.status === "ACCEPTED")) {
        nextRun = { ...nextRun, status: "COMPLETED", completedAt: new Date().toISOString() };
        await writeWorkspaceJson(workspace, runFile(runId), nextRun);
        await updateContractStatus(workspace, schemas, contract.contractId, "COMPLETED");
        await appendLedgerEntry(workspace, { event: "orchestration-completed", taskId: contract.taskId, contractRef: contract.contractId, runRef: runId, summary: `Run ${runId} completed: all ${all.length} subtasks accepted.` });
      } else {
        await writeWorkspaceJson(workspace, runFile(runId), nextRun);
      }
    }
    return { review, run: nextRun, subtask: nextSubtask };
  });
}

/** Completes a round: records the orchestrator's goal-consistency check and advances the round.
 *  When autoEscalateOnConsistencyFail is configured and the check failed, the run escalates instead. Ledger: round-completed. */
export async function completeRound(workspace: LocalWorkspace, runId: string, input: { passed: boolean; note: string }): Promise<OrchestrationRun> {
  return withWorkspaceLock(workspace, async () => {
    const run = await getRun(workspace, runId);
    if (run.status !== "RUNNING") throw orchError("RUN_STATE_CONFLICT", "Only RUNNING runs can complete a round.", { runId, status: run.status });
    const cfg = await loadOrchestrationConfig(workspace);
    let nextRun: OrchestrationRun = { ...run, round: run.round + 1, goalConsistency: [...run.goalConsistency, { round: run.round, passed: input.passed, note: input.note }] };
    const contract = await getContract(workspace, run.contractRef);
    if (!input.passed && cfg.defaults?.autoEscalateOnConsistencyFail === true) {
      nextRun = { ...nextRun, status: "ESCALATED", escalatedAt: new Date().toISOString(), escalationReason: `Goal-consistency check failed: ${input.note}` };
      await writeWorkspaceJson(workspace, runFile(runId), nextRun);
      await appendLedgerEntry(workspace, { event: "orchestration-escalated", taskId: contract.taskId, contractRef: contract.contractId, runRef: runId, summary: `Run ${runId} escalated (auto): consistency check failed: ${input.note}` });
      return nextRun;
    }
    await writeWorkspaceJson(workspace, runFile(runId), nextRun);
    await appendLedgerEntry(workspace, { event: "round-completed", taskId: contract.taskId, contractRef: contract.contractId, runRef: runId, summary: `Round ${run.round} completed; consistency ${input.passed ? "passed" : "failed"}: ${input.note}` });
    return nextRun;
  });
}

/** Escalates a run to the user. Ledger: orchestration-escalated. */
export async function escalateRun(workspace: LocalWorkspace, runId: string, reason: string): Promise<OrchestrationRun> {
  return withWorkspaceLock(workspace, async () => {
    const run = await getRun(workspace, runId);
    if (run.status !== "RUNNING") throw orchError("RUN_STATE_CONFLICT", "Only RUNNING runs can be escalated.", { runId, status: run.status });
    const next = { ...run, status: "ESCALATED" as const, escalatedAt: new Date().toISOString(), escalationReason: reason };
    await writeWorkspaceJson(workspace, runFile(runId), next);
    const contract = await getContract(workspace, run.contractRef);
    await appendLedgerEntry(workspace, { event: "orchestration-escalated", taskId: contract.taskId, contractRef: contract.contractId, runRef: runId, summary: `Run ${runId} escalated: ${reason}` });
    return next;
  });
}

/**
 * Human decision path after escalation: resumes an ESCALATED run back to RUNNING,
 * optionally adjusting the budget (rounds/tokens) per the user's choice.
 * Ledger: orchestration-resumed.
 */
export async function resumeRun(workspace: LocalWorkspace, runId: string, input: { maxRounds?: number; maxSubtaskTokens?: number } = {}): Promise<OrchestrationRun> {
  return withWorkspaceLock(workspace, async () => {
    const run = await getRun(workspace, runId);
    if (run.status !== "ESCALATED") throw orchError("RUN_STATE_CONFLICT", "Only ESCALATED runs can be resumed.", { runId, status: run.status });
    const budget = { ...run.budget };
    if (input.maxRounds !== undefined) {
      if (!Number.isSafeInteger(input.maxRounds) || input.maxRounds < 1 || input.maxRounds > 1000) {
        throw orchError("RUN_RESUME_BUDGET_INVALID", "maxRounds must be 1-1000.", { maxRounds: input.maxRounds });
      }
      budget.maxRounds = input.maxRounds;
    }
    if (input.maxSubtaskTokens !== undefined) {
      if (!Number.isSafeInteger(input.maxSubtaskTokens) || input.maxSubtaskTokens < 1000 || input.maxSubtaskTokens > 10_000_000) {
        throw orchError("RUN_RESUME_BUDGET_INVALID", "maxSubtaskTokens must be 1000-10000000.", { maxSubtaskTokens: input.maxSubtaskTokens });
      }
      budget.maxSubtaskTokens = input.maxSubtaskTokens;
    }
    const next: OrchestrationRun = { ...run, status: "RUNNING", budget, resumedAt: new Date().toISOString() };
    await writeWorkspaceJson(workspace, runFile(runId), next);
    const contract = await getContract(workspace, run.contractRef);
    await appendLedgerEntry(workspace, { event: "orchestration-resumed", taskId: contract.taskId, contractRef: contract.contractId, runRef: runId, summary: `Run ${runId} resumed after escalation${budget.maxRounds !== run.budget.maxRounds || budget.maxSubtaskTokens !== run.budget.maxSubtaskTokens ? " (budget adjusted)" : ""}.` });
    return next;
  });
}

/** Cancels a run. Ledger: orchestration-cancelled. */
export async function cancelRun(workspace: LocalWorkspace, runId: string): Promise<OrchestrationRun> {
  return withWorkspaceLock(workspace, async () => {
    const run = await getRun(workspace, runId);
    if (run.status === "COMPLETED" || run.status === "CANCELLED") return run;
    const next = { ...run, status: "CANCELLED" as const, completedAt: new Date().toISOString() };
    await writeWorkspaceJson(workspace, runFile(runId), next);
    const contract = await getContract(workspace, run.contractRef);
    await appendLedgerEntry(workspace, { event: "orchestration-cancelled", taskId: contract.taskId, contractRef: contract.contractId, runRef: runId, summary: `Run ${runId} cancelled.` });
    return next;
  });
}

export async function getReview(workspace: LocalWorkspace, reviewId: string): Promise<ReviewRecord> {
  assertId(reviewId, "REVIEW_ID_INVALID");
  try {
    return JSON.parse(await readFile(await workspaceFile(workspace, reviewFile(reviewId)), "utf8")) as ReviewRecord;
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
}

function assertRelativePath(target: string): void {
  if (!target || target.includes("\0") || target.startsWith("/") || target.split(/[\\/]/).includes("..")) {
    throw orchError("ARTIFACT_PATH_INVALID", "Artifact paths must be workspace-relative.", { target });
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
