export type ImpactLevel = "L0" | "L1" | "L2" | "L3";

/** A write the user has been asked to confirm as part of an orchestration plan. */
export interface WriteIntent {
  target: string;
  action: "create" | "modify" | "delete";
  purpose: string;
}

export interface PlanStep {
  stepId: string;
  role: string;
  goal: string;
  tools: string[];
  readScope: string[];
  writes: WriteIntent[];
  dependsOn?: string[];
  status: "PENDING" | "RUNNING" | "COMPLETED" | "FAILED";
  evidenceRefs?: string[];
}

export type PlanStatus = "DRAFT" | "AWAITING_CONFIRMATION" | "APPROVED" | "EXECUTING" | "COMPLETED" | "FAILED" | "CANCELLED";

/** Structured orchestration plan: the blueprint a scheduler executes step by step. */
export interface OrchestrationPlan {
  version: 1;
  planId: string;
  taskId: string;
  status: PlanStatus;
  goal: string;
  steps: PlanStep[];
  createdAt: string;
  confirmedAt?: string;
  cancelledAt?: string;
}

export type TaskState =
  | "DRAFT"
  | "SCOPED"
  | "DESIGNED"
  | "APPROVED_FOR_EXECUTION"
  | "RUNNING"
  | "REVIEWING"
  | "VERIFYING"
  | "AWAITING_APPROVAL"
  | "ARCHIVED"
  | "DONE"
  | "BLOCKED"
  | "REWORK"
  | "CANCELLED";

export interface TaskCharter {
  id: string;
  workspaceId: string;
  goal: string;
  requestedOutputs: string[];
  riskLevel: ImpactLevel;
  state: TaskState;
  nonGoals?: string[];
  scope?: string[];
  inputs?: string[];
  acceptanceCriteria?: string[];
  stopConditions?: string[];
  constraints?: string[];
  riskNotes?: string[];
  dataClassification?: "public" | "internal" | "confidential" | "restricted";
  profile?: string;
  packs?: string[];
  writeSet?: string[];
  approvalRequired?: boolean;
  approvalRefs?: string[];
}

export interface RoleDefinition {
  displayName: string;
  category: string;
  defaultLevel: ImpactLevel;
  canWrite: boolean;
  requiresWorktree?: boolean;
  writeScope?: string;
  incompatibleWith?: string[];
}

export interface RoleRegistry { version: 1; roles: Record<string, RoleDefinition>; }

export interface Profile {
  version: 1;
  id: string;
  label: string;
  defaultAutomation: "draft-first" | "reviewed-workflow" | "policy-governed" | "advice-only";
  defaultApproval: string;
  enabledPacks: string[];
}

export interface Pack {
  version: 1;
  id: string;
  label: string;
  artifactTypes: string[];
  roleExtensions: string[];
  qualityRules: string[];
  recommendedPlugins: string[];
}

export interface PluginManifest {
  version: 2;
  id: string;
  label: string;
  level: ImpactLevel;
  status: "available" | "internal" | "declared-only" | "unavailable";
  operations: string[];
  inputSchemaRef: string;
  outputSchemaRef: string;
  sideEffects: "none" | "control-plane" | "business-write" | "external-egress";
  requiresLease: boolean;
  requiresApproval: boolean;
  implementationRef?: string;
  runtime: "builtin" | "mcp" | "adapter" | "unavailable";
  timeoutMs: number;
  auditMode: "receipt-ledger" | "ledger-only" | "none";
  source: "builtin" | "workspace" | "user" | "package";
}

export type PluginStatus = PluginManifest["status"] | "invalid" | "disabled" | "degraded";

export interface PluginDiagnostic {
  id: string;
  status: PluginStatus;
  level: ImpactLevel;
  operations: string[];
  source: PluginManifest["source"];
  implementationAvailable: boolean;
  executable: boolean;
  reasonCode?: string;
  reason?: string;
  checkedAt: string;
}

export interface AdapterDescriptor {
  id: string;
  status: "available" | "unavailable" | "degraded";
  runtime: "builtin" | "host-injected";
  implementationRef: string;
  supports: string[];
  reasonCode?: string;
}


export interface CapabilityLease {
  id: string;
  taskId: string;
  agentId: string;
  role: string;
  capability: string;
  level: ImpactLevel;
  workspace: string;
  readScope: string[];
  writeSet: string[];
  issuedAt: string;
  expiresAt: string;
  maxToolCalls: number;
  status: "active" | "revoked" | "expired";
  allowedCommands?: string[];
  allowedDestinations?: string[];
  approvalRefs?: string[];
  policyVersion?: string;
  issuedBy?: string;
  /** 2.0: binds the lease to an orchestration subtask (worker). */
  subtaskRef?: string;
}

export interface PolicyDecision {
  allowed: boolean;
  code: string;
  reasons: string[];
  requiredApprovals?: string[];
  policyVersion: string;
}

export interface Approval {
  id: string;
  taskId: string;
  action: string;
  status: "requested" | "approved" | "rejected" | "expired" | "revoked";
  requestedAt: string;
  expiresAt?: string;
  decidedAt?: string;
  decidedBy?: string;
  scope?: string[];
  reason?: string;
}

/** Version values remain open so older numeric contracts and string runtime versions can coexist. */
export type ContractVersion = number | string;

export type EvidenceKind = "file" | "git" | "tool" | "document";
export type DataSensitivity = "public" | "internal" | "confidential" | "restricted";

export interface EvidenceRef {
  id: string;
  kind: EvidenceKind;
  source: string;
  locator: string;
  contentHash: string;
  observedAt: string;
  sensitivity: DataSensitivity;
  toolCallId: string;
}

export interface RuntimeBudget {
  maxTurns?: number;
  maxMinutes?: number;
  maxToolCalls?: number;
  maxFiles?: number;
  maxBytes?: number;
  maxOutputBytes?: number;
}

export interface RuntimeBudgetUsage {
  turns?: number;
  minutes?: number;
  toolCalls?: number;
  files?: number;
  bytes?: number;
  outputBytes?: number;
}

export interface CapsuleFact {
  statement: string;
  evidenceRefs: string[];
}

export interface CapsuleDecision {
  statement: string;
  approvalRefs: string[];
  provenance: string;
}

export interface TaskCapsule {
  version: ContractVersion;
  capsuleId: string;
  runId: string;
  taskId: string;
  agentId: string;
  role: string;
  workspaceId: string;
  leaseId: string;
  policyVersion: string;
  goal: string;
  scope: string[];
  readScope: string[];
  nonGoals: string[];
  facts: CapsuleFact[];
  decisions: CapsuleDecision[];
  unknowns: string[];
  allowedTools: string[];
  writeSet: string[];
  outputSchema: string[];
  budget: RuntimeBudget;
  issuedAt: string;
  expiresAt: string;
}

export type AgentRunStatus =
  | "CREATED"
  | "ADMITTED"
  | "RUNNING"
  | "COMPLETED"
  | "BLOCKED"
  | "FAILED"
  | "TIMED_OUT"
  | "CANCELLED";

export type AgentStepStatus = "PENDING" | "RUNNING" | "COMPLETED" | "BLOCKED" | "FAILED" | "TIMED_OUT" | "CANCELLED";

export interface AgentStep {
  id: string;
  sequence?: number;
  status: AgentStepStatus;
  toolCallIds?: string[];
  evidenceRefs?: string[];
  startedAt?: string;
  finishedAt?: string;
  errorCode?: string;
  summary?: string;
}

export interface RuntimeEvent {
  type: string;
  at: string;
  message?: string;
  toolCallId?: string;
  evidenceRef?: string;
}

export interface GateResult {
  gate: string;
  allowed: boolean;
  reasons: string[];
  policyVersion?: string;
}

export interface AgentRun {
  version: ContractVersion;
  runId: string;
  capsuleId: string;
  taskId: string;
  agentId: string;
  role: string;
  workspaceId: string;
  leaseId: string;
  policyVersion: string;
  status: AgentRunStatus;
  executor: string;
  ownerToken?: string;
  fenceEpoch?: number;
  budget: RuntimeBudget;
  budgetUsage?: RuntimeBudgetUsage;
  steps?: AgentStep[];
  toolCalls?: Array<ToolCallRecord | string>;
  evidenceRefs?: string[];
  events?: RuntimeEvent[];
  gateResults?: GateResult[];
  startedAt?: string;
  heartbeatAt?: string;
  finishedAt?: string;
  createdAt: string;
  outputHash?: string;
  errorCode?: string;
  blockedReason?: string;
}

export type ToolCallStatus = "REQUESTED" | "RUNNING" | "COMPLETED" | "BLOCKED" | "REJECTED" | "FAILED" | "TIMED_OUT" | "CANCELLED";

export interface ToolCallRecord {
  id: string;
  runId: string;
  capsuleId: string;
  taskId: string;
  leaseId: string;
  agentId: string;
  role: string;
  tool: string;
  status: ToolCallStatus;
  inputHash?: string;
  outputHash?: string;
  input?: unknown;
  output?: unknown;
  evidenceRefs?: string[];
  budgetUsage?: RuntimeBudgetUsage;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  outputBytes?: number;
  inputBytes?: number;
  fileLocators?: string[];
  errorCode?: string;
  blockedReason?: string;
}

export interface AgentReceiptFact {
  statement: string;
  evidenceRef?: string;
  evidenceRefs?: string[];
}

export interface AgentReceiptFinding {
  severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  statement: string;
  evidenceRef?: string;
}

/** Agent Receipt keeps v0.1 fields and adds optional run-level runtime metadata. */
export interface AgentReceipt {
  id: string;
  taskId: string;
  role: string;
  status: "COMPLETED" | "BLOCKED" | "NEEDS_CONTEXT" | "FAILED";
  facts: AgentReceiptFact[];
  findings?: AgentReceiptFinding[];
  proposals: string[];
  unknowns: string[];
  testResults?: Array<{ command: string; exitCode: number; reportRef?: string }>;
  changedPaths?: string[];
  evidenceRefs: string[];
  artifactRefs?: string[];
  approvalRefs?: string[];
  policyVersion?: string;
  toolSummary?: string;
  createdAt: string;
  runId?: string;
  capsuleId?: string;
  leaseId?: string;
  agentId?: string;
  startedAt?: string;
  finishedAt?: string;
  executor?: string;
  budgetUsage?: RuntimeBudgetUsage;
  toolCalls?: Array<ToolCallRecord | string>;
  outputHash?: string;
  errorCode?: string;
  blockedReason?: string;
}

export interface AgentExecutorInput {
  run: AgentRun;
  capsule: TaskCapsule;
  callTool: (request: Omit<ToolCallRecord, "id" | "status" | "startedAt">) => Promise<ToolCallRecord>;
}

export interface AgentExecutorResult {
  status: Exclude<AgentRunStatus, "CREATED" | "ADMITTED" | "RUNNING">;
  outputHash?: string;
  errorCode?: string;
  blockedReason?: string;
}

export interface AgentExecutor {
  id: string;
  execute(input: AgentExecutorInput): Promise<AgentExecutorResult>;
  cancel?(runId: string): Promise<void>;
}
