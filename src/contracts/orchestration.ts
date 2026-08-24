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

/** Durable lifetime allocation state for child Leases derived from a Contract. */
export interface ContractDelegationBudget {
  maxToolCalls: number;
  expiresAt: string;
  /** Monotonic allocation total; expiry/revocation never returns this budget. */
  lifetimeAllocatedToolCalls?: number;
  /** Short-lived pre-Lease reservations keyed by deterministic issuance Lease ID. */
  pendingLeaseAllocations?: Record<string, number>;
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
  /** Central Task-authority snapshot that all later Run/dispatch operations must re-admit. */
  taskAuthorityHash: string;
  /** Precise human grants, if any, that authorized this Contract envelope. */
  approvalRefs: string[];
  /** Active central policy version used to derive the authority snapshot. */
  policyVersion: string;
  /** Host principal/session that created the Contract authority envelope. */
  hostSessionId: string;
  /** Immutable review rule captured when the Contract is created; legacy Contracts imply the strict rule. */
  reviewPolicy?: "INDEPENDENT_REQUIRED" | "SELF_REVIEW_AUDITED";
  /** Aggregate lifetime child-Lease allocation ceiling and durable accounting state. */
  delegationBudget?: ContractDelegationBudget;
}

export type SubtaskStatus = "PENDING" | "DISPATCHED" | "RUNNING" | "REVIEWING" | "ACCEPTED" | "REJECTED" | "FAILED" | "SKIPPED";

export interface ArtifactRef {
  artifactId: string;
  contentHash: string;
  /** File location copied from the verified Artifact so a worker can resolve the input. */
  path?: string;
  kind?: "file";
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
  /** Exact normalized add-subtask request identity for crash-safe retries. */
  creationRequestHash?: string;
  contractRef: string;
  runRef: string;
  /** Effective domain (contract domain by default; subtask may narrow to a sub-domain, e.g. "frontend/forms"). */
  domain: string;
  /** Engine-injected specialist instructions; the worker sub-agent is told to follow ONLY this. */
  domainInstructions: string[];
  /** Immutable global anchors copied into the package at creation time. */
  contractGoal?: string;
  globalAcceptanceCriteria?: string[];
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
  /** Executor recorded at dispatch (audit trace; used to flag same-source reviews). */
  dispatchedAgentId?: string;
  /** True when exhaustion of this subtask must fail the whole run. */
  critical?: boolean;
  /** Retry generation admitted by the current dispatch; absent outside an active attempt. */
  activeAttempt?: number;
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
  /** Retry generation that produced this artifact; legacy records imply 0. */
  attempt?: number;
}

export interface ValidatorEvidence {
  validator: string;
  passed: boolean;
  detail: string;
}

export interface ValidatorArtifactObservation {
  artifactId: string;
  path: string;
  expectedHash: string;
  observedHash: string;
}

/** Engine-created proof that registered validator code executed for one immutable attempt/review binding. */
export interface ValidatorReceipt {
  version: 1;
  receiptId: string;
  source: "ENGINE_EXECUTED";
  validatorId: string;
  validatorVersion: string;
  status: "PASSED" | "FAILED" | "ERROR";
  detail: string;
  runRef: string;
  subtaskRef: string;
  reviewRef: string;
  round: number;
  attempt: number;
  artifactObservations: ValidatorArtifactObservation[];
  createdAt: string;
  /** Persistence boundary used by the caller that prepared this receipt. */
  storageBoundary: "MULTI_FILE_NON_TRANSACTIONAL" | "JOURNALED_TRANSACTION";
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
  /** References only engine-executed persisted receipts; caller-authored validator JSON is never stored as proof. */
  validatorReceiptIds?: string[];
  createdAt: string;
  reviewedBy: string;
  /** Retry generation reviewed by this record; legacy records imply 0. */
  attempt?: number;
  reviewIndependence?: "INDEPENDENT" | "SELF_REVIEW_NON_INDEPENDENT";
  /** Tokens charged to the budget. This number is not provider-verified without a provider receipt. */
  tokensUsed?: number;
  tokenAccounting?: {
    status: "ESTIMATED" | "UNKNOWN" | "PROVIDER_RECEIPT";
    chargedTokens: number;
    providerReceiptRef?: string;
  };
  /** 2.0.0 caller-authored evidence is retained as untrusted history only. */
  validatorEvidence?: ValidatorEvidence[];
  /** True when the reviewer is the same agent that executed the subtask (self-review; audit-visible). */
  sameSourceReview?: boolean;
}

export type OrchestrationRunStatus = "DRAFT" | "RUNNING" | "DEGRADED" | "COMPLETED" | "FAILED" | "CANCELLED" | "ESCALATED";

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
  /** Engine-observed proof that supplements (and constrains) caller judgment. */
  validatorReceiptIds?: string[];
  artifactRefs?: string[];
  engineVerifiedAt?: string;
}

/** One orchestration run: the loop (dispatch → execute → review → redispatch) until complete or constrained. */
export interface OrchestrationRun {
  version: 1;
  runId: string;
  contractRef: string;
  /** Exact raw create request identity used to recover a lost create response. */
  creationRequestHash?: string;
  /** Explicit terminal predecessor binding required for every successor Run. */
  supersedesRunRef?: string;
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
  /** Human decision after escalation resumed the run (resume sets it). */
  resumedAt?: string;
  /** Monotonic human-resume generation and its exact caller request binding. */
  resumeGeneration?: number;
  resumeRequestHash?: string;
  resumedBudgetAdjusted?: boolean;
  escalationReason?: string;
  /** Retry exhaustion of any subtask fails the whole run when true. */
  failFast?: boolean;
}

export const MAX_CONTRACT_CRITERIA = 20;
export const MAX_CONTRACT_SCOPE = 50;
export const MAX_SUBTASK_CRITERIA = 10;
export const MAX_SUBTASK_SCOPE = 50;
export const MAX_INPUT_ARTIFACTS = 20;
export const MAX_RUN_SUBTASKS = 100;
export const MAX_RUN_ARTIFACTS = 1000;
export const MAX_RUN_REVIEWS = 1000;
export const MAX_SUBTASK_ARTIFACTS = 100;
export const MAX_DEFECTS = 20;
export const MAX_DOMAIN_LENGTH = 64;
export const MAX_DOMAIN_INSTRUCTIONS = 30;
export const DEFAULT_MAX_ROUNDS = 5;
export const DEFAULT_MAX_RETRIES_PER_SUBTASK = 2;
export const DEFAULT_MAX_SUBTASK_TOKENS = 200_000;
/** Upper bound for a single host-reported token figure in a review (per-subtask round). */
export const MAX_REVIEW_TOKENS = 10_000_000;
