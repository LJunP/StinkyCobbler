/** 2.0 orchestration domain: orchestrator-worker multi-agent loop types. */

export type ContractStatus = "ACTIVE" | "COMPLETED" | "FAILED" | "CANCELLED";

export const GENERAL_DOMAIN = "general";

/** Specialist worker profile: domain instructions, acceptance checklist and guardrails applied to every subtask in that domain. */
export interface WorkerProfile {
  domain: string;
  title: string;
  /** Domain-specific professional instructions injected into the subtask package. */
  instructions: string[];
  /** Domain-specific acceptance checklist merged into review criteria guidance. */
  acceptanceChecklist: string[];
  /** Domain guardrails: what workers must never do in this domain. */
  negativeRules: string[];
  /** Suggested capabilities for subtasks in this domain. */
  suggestedCapabilities: string[];
}

/** Immutable task contract: the global anchor every subtask package references (contractRef). */
export interface TaskContract {
  version: 1;
  contractId: string;
  /** Bound task (must exist in the workspace; lease issuance for subtasks uses it). */
  taskId: string;
  /** Confirmed domain (user confirmed/refined before contract creation); routes subtasks to the specialist profile. */
  domain: string;
  goal: string;
  globalAcceptanceCriteria: string[];
  /** Workspace-relative path prefix whitelist; artifacts outside it are rejected. */
  scope: string[];
  createdAt: string;
  status: ContractStatus;
}

export type SubtaskStatus = "PENDING" | "DISPATCHED" | "RUNNING" | "REVIEWING" | "ACCEPTED" | "REJECTED" | "FAILED" | "SKIPPED";

export interface ArtifactRef {
  artifactId: string;
  contentHash: string;
}

export interface Defect {
  location: string;
  problem: string;
  suggestion: string;
}

/** One unit of work dispatched to a worker (host sub-agent). */
export interface SubtaskPackage {
  version: 1;
  subtaskId: string;
  contractRef: string;
  runRef: string;
  /** Effective domain (contract domain by default; subtask may narrow to a sub-domain, e.g. "frontend/forms"). */
  domain: string;
  /** Engine-injected specialist instructions; the worker sub-agent is told to follow ONLY this. */
  domainInstructions: string[];
  goal: string;
  /** Prior-round artifacts this subtask builds upon (verified by contentHash before dispatch). */
  inputArtifacts: ArtifactRef[];
  acceptanceCriteria: string[];
  /** Workspace-relative path prefix whitelist for this subtask's outputs. */
  scope: string[];
  maxRetries: number;
  capabilities: string[];
  status: SubtaskStatus;
  round: number;
  retriesUsed: number;
  dependsOn: string[];
  createdAt: string;
  dispatchedAt?: string;
  completedAt?: string;
  leaseRefs?: string[];
  artifactRefs?: string[];
  reviewRefs?: string[];
  lastDefects?: Defect[];
  failReason?: string;
}

export type ArtifactStatus = "VERIFIED" | "MISMATCH" | "REJECTED";

/** Immutable artifact: verified by contentHash before it can feed the next round. */
export interface Artifact {
  version: 1;
  artifactId: string;
  runRef: string;
  subtaskRef: string;
  kind: "file" | "summary" | "evidence";
  /** Workspace-relative path (kind=file). */
  path: string;
  contentHash: string;
  round: number;
  status: ArtifactStatus;
  createdAt: string;
  verifiedAt?: string;
}

export interface ValidatorEvidence {
  validator: string;
  passed: boolean;
  detail: string;
}

/** Review record: dual-channel (LLM checklist + tool verification); reason and defects required on REJECTED. */
export interface ReviewRecord {
  version: 1;
  reviewId: string;
  runRef: string;
  subtaskRef: string;
  round: number;
  decision: "ACCEPTED" | "REJECTED";
  criteriaResults: { criterion: string; passed: boolean; note: string }[];
  defects: Defect[];
  score: number;
  reason: string;
  validatorEvidence: ValidatorEvidence[];
  createdAt: string;
  reviewedBy: string;
}

export type OrchestrationRunStatus = "DRAFT" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED" | "ESCALATED";

export interface OrchestrationBudget {
  maxRounds: number;
  maxRetriesPerSubtask: number;
  maxSubtaskTokens: number;
  usedTokens: number;
}

export interface RoundConsistencyCheck {
  round: number;
  passed: boolean;
  note: string;
}

/** One orchestration run: the loop (dispatch → execute → review → redispatch) until complete or constrained. */
export interface OrchestrationRun {
  version: 1;
  runId: string;
  contractRef: string;
  status: OrchestrationRunStatus;
  round: number;
  budget: OrchestrationBudget;
  subtasks: string[];
  artifacts: string[];
  reviews: string[];
  goalConsistency: RoundConsistencyCheck[];
  createdAt: string;
  completedAt?: string;
  escalatedAt?: string;
  escalationReason?: string;
}

export const MAX_CONTRACT_CRITERIA = 20;
export const MAX_CONTRACT_SCOPE = 50;
export const MAX_SUBTASK_CRITERIA = 10;
export const MAX_SUBTASK_SCOPE = 50;
export const MAX_INPUT_ARTIFACTS = 20;
export const MAX_DEFECTS = 20;
export const MAX_DOMAIN_LENGTH = 64;
export const MAX_DOMAIN_INSTRUCTIONS = 30;
export const DEFAULT_MAX_ROUNDS = 5;
export const DEFAULT_MAX_RETRIES_PER_SUBTASK = 2;
export const DEFAULT_MAX_SUBTASK_TOKENS = 200_000;
