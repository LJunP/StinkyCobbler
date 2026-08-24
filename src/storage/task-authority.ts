import { createHash } from "node:crypto";
import type { TaskContract } from "../contracts/orchestration.js";
import type { Approval, CapabilityLease, TaskCharter, TaskState } from "../contracts/types.js";
import { ExitCode, StinkyCobblerError } from "../errors.js";
import { isApprovalExpired } from "../policy/approval.js";
import { targetInWriteSet } from "../policy/path-policy.js";
import { normalizeWorkspaceRelativePath, workspacePathInScopes } from "../security/workspace-path.js";
import { getApproval, listApprovals } from "./approvals.js";
import { getTask } from "./tasks.js";
import type { LocalWorkspace } from "./workspace.js";

export const TASK_AUTHORITY_POLICY_VERSION = "task-authority-v1";

const READ_CAPABILITIES = new Set(["repository-read", "git-read", "docs-index"]);
const DESIGN_READ_STATES = new Set<TaskState>([
  "SCOPED",
  "DESIGNED",
  "APPROVED_FOR_EXECUTION",
  "RUNNING",
  "REVIEWING",
  "VERIFYING"
]);
const EXECUTION_STATES = new Set<TaskState>(["APPROVED_FOR_EXECUTION", "RUNNING"]);

export interface TaskCapabilityRequest {
  taskId: string;
  capability: string;
  readScope?: string[];
  writeSet?: string[];
  approvalRefs?: string[];
  parentGrantRef?: string;
  expectedTaskAuthorityHash?: string;
  policyVersion?: string;
  maxToolCalls?: number;
  expiresAt?: string;
  hostSessionId?: string;
  adapterCapabilities?: string[];
  /** A child/use may narrow a precise root Approval; root issuance is exact. */
  allowApprovalScopeSuperset?: boolean;
  /** Internal idempotent owner allowed to reuse an already-consumed parent Approval. */
  approvalConsumptionOwner?: string;
}

export interface TaskCapabilityAdmission {
  task: TaskCharter;
  taskAuthorityHash: string;
  policyVersion: string;
  approvalRefs: string[];
  parentGrantRef: string;
  hostSessionId: string;
  matchedApprovalRef?: string;
  matchedApprovalBudget?: { maxToolCalls: number; expiresAt: string };
}

/**
 * The single persisted Task/Approval/parent-grant authority gate. Callers may
 * submit IDs and desired bounds only; this function reloads all authority from
 * workspace storage and fails closed on drift, revocation, or scope expansion.
 */
export async function admitTaskCapability(
  workspace: LocalWorkspace,
  request: TaskCapabilityRequest
): Promise<TaskCapabilityAdmission> {
  return admitTaskCapabilityInternal(workspace, request, new Set());
}

async function admitTaskCapabilityInternal(
  workspace: LocalWorkspace,
  request: TaskCapabilityRequest,
  ancestorLeaseRefs: Set<string>
): Promise<TaskCapabilityAdmission> {
  const task = await getTask(workspace, request.taskId);
  assertCurrentTaskAuthorityGeneration(task);
  const authorityHash = hashTaskAuthority(task);
  const policyVersion = request.policyVersion ?? TASK_AUTHORITY_POLICY_VERSION;
  if (policyVersion !== TASK_AUTHORITY_POLICY_VERSION) {
    deny("TASK_POLICY_STALE", "The requested authority policy is not active.", { policyVersion });
  }
  if (request.expectedTaskAuthorityHash !== undefined && request.expectedTaskAuthorityHash !== authorityHash) {
    deny("TASK_AUTHORITY_STALE", "The persisted Task authority changed after this grant was derived.", {
      taskId: task.id,
      expected: request.expectedTaskAuthorityHash,
      observed: authorityHash
    });
  }
  if (task.riskLevel === "L3") {
    deny("TASK_RISK_DENIED", "L3 Tasks are not executable by the current public executor.", { taskId: task.id });
  }
  if (task.dataClassification === "restricted") {
    deny("TASK_DATA_CLASSIFICATION_DENIED", "Restricted Task data is denied by default in the current public executor.", { taskId: task.id });
  }

  const readScope = normalizeScopes(request.readScope ?? ["."]);
  const writeSet = normalizeScopes(request.writeSet ?? []);
  assertState(task, request.capability);
  assertTaskScope(task, readScope, writeSet, request.capability);
  if (request.adapterCapabilities !== undefined && !request.adapterCapabilities.includes(request.capability)) {
    deny("ADAPTER_CAPABILITY_DENIED", "The active adapter does not grant the requested capability.", { capability: request.capability });
  }

  const inherited = await assertParentGrant(workspace, task, authorityHash, request, readScope, writeSet, ancestorLeaseRefs);
  const effectiveHostSessionId = request.hostSessionId ?? inherited.hostSessionId ?? "local-cli";
  let approvalRefs = uniqueSorted([...(task.approvalRefs ?? []), ...(request.approvalRefs ?? []), ...inherited.approvalRefs]);
  const approvalRequired = request.capability === "repository-write" || task.riskLevel === "L2" ||
    task.approvalRequired === true || task.dataClassification === "confidential" || inherited.approvalParentRef !== undefined;
  const explicitApprovals: Approval[] = [];
  for (const approvalRef of uniqueSorted(request.approvalRefs ?? [])) {
    if ((inherited.leaseParentValidated === true || inherited.contractParentValidated === true) && inherited.approvalRefs.includes(approvalRef)) {
      // This inherited ref was already revalidated while recursively admitting
      // the parent Lease. It is not a new root Approval supplied by the child.
      continue;
    }
    const match = await findCapabilityApproval(workspace, task, authorityHash, request, [approvalRef], readScope, writeSet, effectiveHostSessionId);
    if (match === undefined) {
      deny("TASK_APPROVAL_INVALID", "A caller-supplied Approval does not grant this exact Task capability.", {
        taskId: task.id,
        capability: request.capability,
        approvalRef
      });
    }
    explicitApprovals.push(match);
  }
  let matchingApproval = inherited.approvalParentRef === undefined
    ? explicitApprovals[0]
    : await findCapabilityApproval(workspace, task, authorityHash, request, [inherited.approvalParentRef], readScope, writeSet, effectiveHostSessionId);
  // A persisted parent Lease is re-admitted recursively below, including its
  // entire Approval chain.  Do not demand that the already-consumed root
  // Approval be consumable by each child again; doing so would make legitimate
  // derived Leases impossible while adding no authority check.
  if (approvalRequired && inherited.leaseParentValidated !== true) {
    approvalRefs = uniqueSorted([
      ...approvalRefs,
      ...(await listApprovals(workspace, task.id)).map((approval) => approval.id)
    ]);
    matchingApproval ??= await findCapabilityApproval(workspace, task, authorityHash, request, approvalRefs, readScope, writeSet, effectiveHostSessionId);
    if (matchingApproval === undefined) {
      deny("TASK_APPROVAL_REQUIRED", "A current precise delegation Approval is required for this Task capability.", {
        taskId: task.id,
        capability: request.capability,
        approvalRefs
      });
    }
    if (inherited.approvalParentRef !== undefined && matchingApproval.id !== inherited.approvalParentRef) {
      deny("PARENT_GRANT_DENIED", "The explicit parent Approval does not grant this exact Task capability.", {
        parentGrantRef: inherited.approvalParentRef,
        matchedApprovalRef: matchingApproval.id
      });
    }
  }

  return {
    task,
    taskAuthorityHash: authorityHash,
    policyVersion,
    approvalRefs: uniqueSorted([
      ...inherited.approvalRefs,
      ...explicitApprovals.map((approval) => approval.id),
      ...(matchingApproval === undefined ? [] : [matchingApproval.id])
    ]),
    parentGrantRef: inherited.parentGrantRef ?? matchingApproval?.id ?? `task-authority:${task.id}`,
    hostSessionId: effectiveHostSessionId,
    ...(matchingApproval === undefined ? {} : {
      matchedApprovalRef: matchingApproval.id,
      ...(matchingApproval.budget?.maxToolCalls === undefined || matchingApproval.budget.expiresAt === undefined ? {} : {
        matchedApprovalBudget: {
          maxToolCalls: matchingApproval.budget.maxToolCalls,
          expiresAt: matchingApproval.budget.expiresAt
        }
      })
    })
  };
}

/** Re-admits a persisted Lease against current Task, Approval, policy, and parent state. */
export async function admitPersistedLeaseAuthority(
  workspace: LocalWorkspace,
  lease: CapabilityLease,
  adapterCapabilities?: string[]
): Promise<TaskCapabilityAdmission> {
  if (lease.parentGrantRef === undefined || lease.taskAuthorityHash === undefined || lease.hostSessionId === undefined) {
    deny("LEASE_REISSUE_REQUIRED", "This pre-2.0.1 Lease remains readable/revocable but cannot execute; revoke it and issue a new Lease under the current Task authority.", {
      leaseId: lease.id
    });
  }
  return admitTaskCapability(workspace, {
    taskId: lease.taskId,
    capability: lease.capability,
    readScope: lease.readScope,
    writeSet: lease.writeSet,
    approvalRefs: lease.approvalRefs ?? [],
    parentGrantRef: lease.parentGrantRef,
    expectedTaskAuthorityHash: lease.taskAuthorityHash,
    ...(lease.policyVersion === undefined ? {} : { policyVersion: lease.policyVersion }),
    maxToolCalls: lease.maxToolCalls,
    expiresAt: lease.expiresAt,
    hostSessionId: lease.hostSessionId,
    ...(adapterCapabilities === undefined ? {} : { adapterCapabilities }),
    allowApprovalScopeSuperset: true,
    approvalConsumptionOwner: lease.id
  });
}

/**
 * Re-admits an immutable orchestration Contract against the current Task and
 * its original precise Approval.  Callers remain responsible for deciding
 * whether the Contract status is appropriate for the operation (for example,
 * ACTIVE for a new mutation).  Keeping this check independent of status also
 * lets a PREPARED completion journal verify a Contract-first partial write.
 */
export async function admitPersistedContractAuthority(
  workspace: LocalWorkspace,
  contract: TaskContract
): Promise<TaskCapabilityAdmission> {
  if (
    contract.taskAuthorityHash === undefined || contract.approvalRefs === undefined ||
    contract.policyVersion === undefined || contract.hostSessionId === undefined ||
    contract.delegationBudget === undefined
  ) {
    deny("CONTRACT_REISSUE_REQUIRED", "This pre-2.0.1 Contract remains readable/cancellable but cannot execute; cancel it and create a new Contract under current Task authority.", {
      contractId: contract.contractId
    });
  }
  if (
    !Number.isSafeInteger(contract.delegationBudget.maxToolCalls) || contract.delegationBudget.maxToolCalls < 1 ||
    !Number.isFinite(Date.parse(contract.delegationBudget.expiresAt)) ||
    Date.parse(contract.delegationBudget.expiresAt) <= Date.now()
  ) {
    deny("CONTRACT_BUDGET_EXPIRED", "The Contract delegation budget is invalid or expired; no further orchestration mutation or PREPARED recovery is authorized.", {
      contractId: contract.contractId,
      expiresAt: contract.delegationBudget.expiresAt
    });
  }
  return admitTaskCapability(workspace, {
    taskId: contract.taskId,
    capability: "orchestration-control",
    readScope: contract.scope,
    approvalRefs: contract.approvalRefs,
    expectedTaskAuthorityHash: contract.taskAuthorityHash,
    policyVersion: contract.policyVersion,
    maxToolCalls: contract.delegationBudget.maxToolCalls,
    expiresAt: contract.delegationBudget.expiresAt,
    hostSessionId: contract.hostSessionId,
    approvalConsumptionOwner: contract.contractId
  });
}

/** Deterministic hash of fields that can change a Task's execution authority. */
export function hashTaskAuthority(task: TaskCharter): string {
  const canonical = {
    id: task.id,
    workspaceId: task.workspaceId,
    authorityGeneration: task.authorityGeneration ?? null,
    state: task.state,
    riskLevel: task.riskLevel,
    dataClassification: task.dataClassification ?? null,
    scope: uniqueSorted(task.scope ?? ["."]),
    writeSet: uniqueSorted(task.writeSet ?? []),
    approvalRequired: task.approvalRequired ?? false,
    approvalRefs: uniqueSorted(task.approvalRefs ?? []),
    constraints: uniqueSorted(task.constraints ?? []),
    stopConditions: uniqueSorted(task.stopConditions ?? [])
  };
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex")}`;
}

/** Validates one one-shot human Approval for DESIGNED -> APPROVED_FOR_EXECUTION. */
export async function admitTaskExecutionApproval(
  workspace: LocalWorkspace,
  task: TaskCharter,
  approvalRef: string,
  hostSessionId = "local-cli",
  approvalConsumptionOwner?: string
): Promise<Approval> {
  assertCurrentTaskAuthorityGeneration(task);
  if (task.state !== "DESIGNED") deny("TASK_STATE_DENIED", "Only a DESIGNED Task can receive execution approval.", { taskId: task.id, state: task.state });
  if (task.riskLevel === "L3") deny("TASK_RISK_DENIED", "L3 Tasks are not executable by the current public executor.", { taskId: task.id });
  const approval = await getApproval(workspace, approvalRef);
  const taskScope = normalizeScopes(task.scope ?? ["."]);
  const approvedScope = normalizeScopes(approval.scope ?? []);
  if (
    approval.taskId !== task.id || approval.status !== "approved" || isApprovalExpired(approval) ||
    approval.action !== "task-execution" || approval.subjectKind !== "task-authority" ||
    approval.subjectId !== task.id || approval.subjectHash !== hashTaskAuthority(task) ||
    approval.capability !== "task-execution" || approval.policyVersion !== TASK_AUTHORITY_POLICY_VERSION ||
    approval.requestedBy === undefined || approval.hostSessionId !== hostSessionId || approval.decidedBy === undefined || approval.expiresAt === undefined ||
    approval.nonce === undefined || approval.budget?.maxToolCalls === undefined || approval.budget.expiresAt === undefined ||
    Date.parse(approval.budget.expiresAt) <= Date.now() ||
    ((approval.consumedAt !== undefined || approval.consumedBy !== undefined) &&
      !(approval.consumedAt !== undefined && approval.consumedBy === approvalConsumptionOwner)) ||
    !exactSet(approvedScope, taskScope)
  ) deny("TASK_EXECUTION_APPROVAL_INVALID", "Execution Approval is missing, stale, consumed, expired, or bound to another Task snapshot.", { taskId: task.id, approvalRef });
  return approval;
}

export function assertCurrentTaskAuthorityGeneration(task: TaskCharter): asserts task is TaskCharter & { authorityGeneration: number } {
  if (!Number.isSafeInteger(task.authorityGeneration) || (task.authorityGeneration ?? -1) < 0) {
    deny("TASK_AUTHORITY_REISSUE_REQUIRED", "This legacy Task remains readable but cannot execute; create a new Task under the current authority model.", { taskId: task.id });
  }
}

function assertState(task: TaskCharter, capability: string): void {
  if (capability === "repository-write" || capability === "orchestration-control") {
    if (!EXECUTION_STATES.has(task.state)) {
      deny("TASK_STATE_DENIED", `${capability} requires an APPROVED_FOR_EXECUTION or RUNNING Task.`, { taskId: task.id, state: task.state, capability });
    }
    return;
  }
  if (READ_CAPABILITIES.has(capability)) {
    if (!DESIGN_READ_STATES.has(task.state)) {
      deny("TASK_STATE_DENIED", "Read capabilities require a SCOPED, DESIGNED, or active execution/review Task.", { taskId: task.id, state: task.state });
    }
    return;
  }
  deny("TASK_CAPABILITY_DENIED", "The requested capability is not part of the public Task authority policy.", { capability });
}

function assertTaskScope(task: TaskCharter, readScope: string[], writeSet: string[], capability: string): void {
  const taskScope = normalizeScopes(task.scope ?? ["."]);
  for (const requested of readScope) {
    if (!workspacePathInScopes(taskScope, requested)) {
      deny("TASK_SCOPE_EXCEEDED", "Requested read scope exceeds the persisted Task scope.", { requested, taskScope });
    }
  }
  if (capability !== "repository-write") return;
  const taskWriteSet = normalizeScopes(task.writeSet ?? []);
  for (const target of writeSet) {
    if (!targetInWriteSet(taskWriteSet, target)) {
      deny("TASK_WRITE_SET_EXCEEDED", "Requested write scope exceeds the persisted Task writeSet.", { target, taskWriteSet });
    }
  }
}

async function assertParentGrant(
  workspace: LocalWorkspace,
  task: TaskCharter,
  authorityHash: string,
  request: TaskCapabilityRequest,
  readScope: string[],
  writeSet: string[],
  ancestorLeaseRefs: Set<string>
): Promise<{ parentGrantRef?: string; approvalRefs: string[]; hostSessionId?: string; approvalParentRef?: string; leaseParentValidated?: true; contractParentValidated?: true }> {
  if (request.parentGrantRef === undefined) return { approvalRefs: [] };
  if (request.parentGrantRef === `task-authority:${task.id}`) {
    return { parentGrantRef: request.parentGrantRef, approvalRefs: [] };
  }
  if (request.parentGrantRef.startsWith("approval-")) {
    return {
      parentGrantRef: request.parentGrantRef,
      approvalRefs: [request.parentGrantRef],
      approvalParentRef: request.parentGrantRef
    };
  }
  if (request.parentGrantRef.startsWith("contract-")) {
    const { getContract } = await import("./orchestration.js");
    const parent = await getContract(workspace, request.parentGrantRef);
    if (
      parent.status !== "ACTIVE" || parent.taskId !== task.id || parent.taskAuthorityHash !== authorityHash ||
      parent.policyVersion !== TASK_AUTHORITY_POLICY_VERSION || parent.delegationBudget === undefined ||
      Date.parse(parent.delegationBudget.expiresAt) <= Date.now()
    ) {
      deny("PARENT_GRANT_DENIED", "The parent Contract is inactive, stale, or belongs to another Task.", {
        parentGrantRef: parent.contractId
      });
    }
    if (readScope.some((scope) => !workspacePathInScopes(parent.scope, scope))) {
      deny("PARENT_SCOPE_EXCEEDED", "Child read scope exceeds the parent Contract.", { parentGrantRef: parent.contractId });
    }
    if (writeSet.some((target) => !workspacePathInScopes(parent.scope, target))) {
      deny("PARENT_SCOPE_EXCEEDED", "Child writeSet exceeds the parent Contract.", { parentGrantRef: parent.contractId });
    }
    if (request.hostSessionId !== undefined && request.hostSessionId !== parent.hostSessionId) {
      deny("PARENT_SESSION_MISMATCH", "Child and parent grants must stay in the same host session.", { parentGrantRef: parent.contractId });
    }
    // Revalidate the Contract's original one-shot orchestration Approval on
    // every derived Lease admission. Its Approval refs are parent authority,
    // not caller-supplied grants for the child's repository capability.
    await admitPersistedContractAuthority(workspace, parent);
    return {
      parentGrantRef: parent.contractId,
      approvalRefs: parent.approvalRefs,
      hostSessionId: parent.hostSessionId,
      contractParentValidated: true
    };
  }
  if (!request.parentGrantRef.startsWith("lease-")) {
    deny("PARENT_GRANT_DENIED", "The parent grant must be a persisted Task authority, Approval, Lease, or Contract.", {
      parentGrantRef: request.parentGrantRef
    });
  }
  if (ancestorLeaseRefs.has(request.parentGrantRef)) {
    deny("PARENT_GRANT_DENIED", "The persisted parent Lease chain contains a cycle.", { parentGrantRef: request.parentGrantRef });
  }
  const { getLease } = await import("./leases.js");
  const parent = await getLease(workspace, request.parentGrantRef);
  if (parent.status !== "active" || Date.parse(parent.expiresAt) <= Date.now() || parent.taskId !== task.id || parent.taskAuthorityHash !== authorityHash) {
    deny("PARENT_GRANT_DENIED", "The parent Lease is inactive, stale, or belongs to another Task.", { parentGrantRef: parent.id });
  }
  if (parent.capability !== request.capability) {
    deny("PARENT_GRANT_DENIED", "A child Lease cannot change its parent capability.", { parentCapability: parent.capability, capability: request.capability });
  }
  if (readScope.some((scope) => !workspacePathInScopes(parent.readScope, scope))) {
    deny("PARENT_SCOPE_EXCEEDED", "Child read scope exceeds the parent Lease.", { parentGrantRef: parent.id });
  }
  if (writeSet.some((target) => !targetInWriteSet(parent.writeSet, target))) {
    deny("PARENT_SCOPE_EXCEEDED", "Child writeSet exceeds the parent Lease.", { parentGrantRef: parent.id });
  }
  if (request.maxToolCalls !== undefined && request.maxToolCalls > parent.maxToolCalls) {
    deny("PARENT_BUDGET_EXCEEDED", "Child tool-call budget exceeds the parent Lease.", { parentGrantRef: parent.id });
  }
  if (request.expiresAt !== undefined && Date.parse(request.expiresAt) > Date.parse(parent.expiresAt)) {
    deny("PARENT_BUDGET_EXCEEDED", "Child expiry exceeds the parent Lease.", { parentGrantRef: parent.id });
  }
  if (request.hostSessionId !== undefined && request.hostSessionId !== parent.hostSessionId) {
    deny("PARENT_SESSION_MISMATCH", "Child and parent grants must stay in the same host session.", { parentGrantRef: parent.id });
  }
  const nextAncestors = new Set(ancestorLeaseRefs);
  nextAncestors.add(parent.id);
  await admitTaskCapabilityInternal(workspace, {
    taskId: parent.taskId,
    capability: parent.capability,
    readScope: parent.readScope,
    writeSet: parent.writeSet,
    approvalRefs: parent.approvalRefs ?? [],
    parentGrantRef: parent.parentGrantRef,
    expectedTaskAuthorityHash: parent.taskAuthorityHash,
    ...(parent.policyVersion === undefined ? {} : { policyVersion: parent.policyVersion }),
    maxToolCalls: parent.maxToolCalls,
    expiresAt: parent.expiresAt,
    hostSessionId: parent.hostSessionId,
    allowApprovalScopeSuperset: true,
    approvalConsumptionOwner: parent.id
  }, nextAncestors);
  return { parentGrantRef: parent.id, approvalRefs: parent.approvalRefs ?? [], hostSessionId: parent.hostSessionId, leaseParentValidated: true };
}

async function findCapabilityApproval(
  workspace: LocalWorkspace,
  task: TaskCharter,
  authorityHash: string,
  request: TaskCapabilityRequest,
  refs: string[],
  readScope: string[],
  writeSet: string[],
  hostSessionId: string
): Promise<Approval | undefined> {
  const requestedScope = request.capability === "repository-write" ? writeSet : readScope;
  for (const ref of refs) {
    let approval: Approval;
    try { approval = await getApproval(workspace, ref); }
    catch { continue; }
    if (
      approval.taskId !== task.id ||
      approval.status !== "approved" ||
      isApprovalExpired(approval) ||
      approval.action !== "delegate-capability" ||
      approval.subjectKind !== "task-authority" ||
      approval.subjectId !== task.id ||
      approval.subjectHash !== authorityHash ||
      approval.capability !== request.capability ||
      approval.policyVersion !== TASK_AUTHORITY_POLICY_VERSION ||
      approval.requestedBy === undefined ||
      approval.hostSessionId !== hostSessionId ||
      approval.decidedBy === undefined ||
      approval.expiresAt === undefined ||
      approval.nonce === undefined ||
      approval.budget?.maxToolCalls === undefined ||
      approval.budget.expiresAt === undefined ||
      ((approval.consumedAt !== undefined || approval.consumedBy !== undefined) &&
        !(approval.consumedAt !== undefined && approval.consumedBy === request.approvalConsumptionOwner) &&
        !(approval.consumedAt !== undefined && approval.consumedBy === request.parentGrantRef && request.parentGrantRef?.startsWith("contract-") === true))
    ) continue;
    const approvedScope = normalizeScopes(approval.scope ?? []);
    const scopeMatches = request.allowApprovalScopeSuperset === true
      ? requestedScope.every((scope) => workspacePathInScopes(approvedScope, scope))
      : exactSet(approvedScope, requestedScope);
    if (!scopeMatches) continue;
    if (request.maxToolCalls !== undefined && request.maxToolCalls > approval.budget.maxToolCalls) continue;
    if (Date.parse(approval.budget.expiresAt) <= Date.now()) continue;
    if (request.expiresAt !== undefined && (
      Date.parse(request.expiresAt) > Date.parse(approval.expiresAt) ||
      Date.parse(request.expiresAt) > Date.parse(approval.budget.expiresAt)
    )) continue;
    return approval;
  }
  return undefined;
}

function normalizeScopes(scopes: string[]): string[] {
  try { return uniqueSorted(scopes.map((scope) => normalizeWorkspaceRelativePath(scope))); }
  catch (error: unknown) {
    deny("TASK_SCOPE_INVALID", error instanceof Error ? error.message : "Task scope is invalid.");
  }
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function exactSet(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function deny(code: string, message: string, details: Record<string, unknown> = {}): never {
  throw new StinkyCobblerError(code, ExitCode.POLICY_DENIED, message, details);
}
