import { mkdir, readFile, readdir } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type { Approval } from "../contracts/types.js";
import type { SchemaRegistry } from "../contracts/schema-registry.js";
import { defaultSchemaRegistry } from "../contracts/default-schema-registry.js";
import { ExitCode, StinkyCobblerError } from "../errors.js";
import { appendLedgerEntry, auditTextFingerprint, listLedgerEntries, prepareLedgerEntry, type AppendLedgerEntry } from "./ledger.js";
import type { LocalWorkspace } from "./workspace.js";
import { createWorkspaceJson, workspaceFile, writeWorkspaceJson } from "./workspace.js";
import { withWorkspaceLock } from "./workspace-lock.js";
import { assertSafeTaskId, getTask } from "./tasks.js";
import { assertApprovalSemantic, isApprovalExpired } from "../policy/approval.js";

const DIRECTORY = "approvals";
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const STATUSES = new Set<Approval["status"]>(["requested", "approved", "rejected", "expired", "revoked"]);
const MAX_APPROVAL_ACTION_LENGTH = 128;
const MAX_APPROVAL_REASON_LENGTH = 512;
const MAX_APPROVAL_SCOPE_ITEMS = 50;
const MAX_APPROVAL_SCOPE_ITEM_LENGTH = 512;
const MAX_APPROVAL_BUDGET_TOOL_CALLS = 1_000_000;
export type ApprovalFaultPoint = "after-request-record" | "after-request-ledger" | "after-decision-prepare" | "after-decision-ledger" | "after-decision-record";
const approvalFaults = new Map<string, ApprovalFaultPoint>();

export interface ApprovalRequestInput {
  taskId: string;
  action: string;
  scope?: string[];
  reason?: string;
  expiresAt?: string;
  subjectKind?: string;
  subjectId?: string;
  subjectVersion?: string | number;
  subjectHash?: string;
  capability?: string;
  expectedPreimageHash?: string | null;
  proposedContentHash?: string;
  budget?: Approval["budget"];
  policyVersion?: string;
  requestedBy?: string;
  hostSessionId?: string;
  nonce?: string;
}

export interface ApprovalDecisionInput {
  status: Exclude<Approval["status"], "requested">;
  decidedBy: string;
  reason: string;
  decidedAt?: string;
  expiresAt?: string;
}

export interface ApprovalInspection {
  valid: boolean;
  approval: Approval;
  taskExists: boolean;
  expired: boolean;
}

export async function requestApproval(workspace: LocalWorkspace, schemas: SchemaRegistry, input: ApprovalRequestInput): Promise<Approval> {
  return withWorkspaceLock(workspace, async () => {
    const request = { ...input, hostSessionId: input.hostSessionId ?? "local-cli" };
    assertRequest(request);
    await getTask(workspace, request.taskId);
    await mkdir(await workspaceFile(workspace, DIRECTORY), { recursive: true, mode: 0o700 });
    if (request.nonce !== undefined) {
      const existing = (await listApprovals(workspace, request.taskId)).find((approval) => approval.requestedBy === request.requestedBy && approval.hostSessionId === request.hostSessionId && approval.nonce === request.nonce);
      if (existing !== undefined) {
        if (sameRequest(existing, request)) {
          await ensureApprovalLedgerEffect(workspace, approvalRequestedEffect(existing), true);
          return existing;
        }
        throw approvalError("APPROVAL_NONCE_CONFLICT", "The approval nonce is already bound to a different request.", { approvalId: existing.id });
      }
    }
    const approval: Approval = assertApprovalSemantic({
      id: `approval-${randomUUID()}`,
      taskId: request.taskId,
      action: request.action,
      status: "requested",
      requestedAt: new Date().toISOString(),
      ...(request.scope === undefined ? {} : { scope: request.scope }),
      ...(request.reason === undefined ? {} : { reason: request.reason }),
      ...(request.expiresAt === undefined ? {} : { expiresAt: request.expiresAt }),
      ...(request.subjectKind === undefined ? {} : { subjectKind: request.subjectKind }),
      ...(request.subjectId === undefined ? {} : { subjectId: request.subjectId }),
      ...(request.subjectVersion === undefined ? {} : { subjectVersion: request.subjectVersion }),
      ...(request.subjectHash === undefined ? {} : { subjectHash: request.subjectHash }),
      ...(request.capability === undefined ? {} : { capability: request.capability }),
      ...(request.expectedPreimageHash === undefined ? {} : { expectedPreimageHash: request.expectedPreimageHash }),
      ...(request.proposedContentHash === undefined ? {} : { proposedContentHash: request.proposedContentHash }),
      ...(request.budget === undefined ? {} : { budget: request.budget }),
      ...(request.policyVersion === undefined ? {} : { policyVersion: request.policyVersion }),
      ...(request.requestedBy === undefined ? {} : { requestedBy: request.requestedBy }),
      hostSessionId: request.hostSessionId,
      ...(request.nonce === undefined ? {} : { nonce: request.nonce })
    });
    schemas.validate("approval", approval);
    await createWorkspaceJson(workspace, fileName(approval.id), approval);
    maybeInjectApprovalFault(workspace, "after-request-record", approval.id);
    await ensureApprovalLedgerEffect(workspace, approvalRequestedEffect(approval), true);
    maybeInjectApprovalFault(workspace, "after-request-ledger", approval.id);
    return approval;
  });
}

export async function getApproval(workspace: LocalWorkspace, id: string): Promise<Approval> {
  assertId(id);
  try {
    const value: unknown = JSON.parse(await readFile(await workspaceFile(workspace, fileName(id)), "utf8"));
    (await defaultSchemaRegistry()).validate("approval", value);
    const approval = assertApprovalSemantic(value as Approval);
    if (approval.id !== id) throw approvalError("APPROVAL_INVALID", "Stored approval ID does not match its canonical lookup ID.", { approvalId: id, storedApprovalId: approval.id });
    return approval;
  } catch (error: unknown) {
    if (isCode(error, "ENOENT")) throw approvalError("APPROVAL_NOT_FOUND", "Approval does not exist.", { approvalId: id });
    if (error instanceof SyntaxError) throw approvalError("APPROVAL_INVALID", "Stored approval contains invalid JSON.", { approvalId: id });
    throw error;
  }
}

export async function listApprovals(workspace: LocalWorkspace, taskId?: string): Promise<Approval[]> {
  if (taskId !== undefined) assertSafeTaskId(taskId);
  let names: string[];
  try { names = await readdir(await workspaceFile(workspace, DIRECTORY)); } catch (error: unknown) { if (isCode(error, "ENOENT")) return []; throw error; }
  const values = await Promise.all(names.filter((name) => /^approval-[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$/.test(name)).sort().map((name) => getApproval(workspace, name.slice(0, -5))));
  return taskId === undefined ? values : values.filter((approval) => approval.taskId === taskId);
}

export async function decideApproval(workspace: LocalWorkspace, schemas: SchemaRegistry, id: string, decision: ApprovalDecisionInput): Promise<Approval> {
  return withWorkspaceLock(workspace, async () => {
    assertId(id);
    assertDecision(decision);
    const current = await getApproval(workspace, id);
    if (current.status === "approved" && decision.status === "revoked") {
      const next = assertApprovalSemantic({
        ...current,
        status: "revoked",
        revokedAt: decision.decidedAt ?? new Date().toISOString(),
        revokedBy: decision.decidedBy,
        revocationReason: decision.reason
      });
      schemas.validate("approval", next);
      await writeWorkspaceJson(workspace, fileName(id), next);
      maybeInjectApprovalFault(workspace, "after-decision-record", next.id);
      await ensureApprovalLedgerEffect(workspace, approvalDecisionEffect(next), false, legacyApprovalDecisionSummary(next));
      maybeInjectApprovalFault(workspace, "after-decision-ledger", next.id);
      return next;
    }
    if (current.status !== "requested") {
      if (sameDecision(current, decision)) {
        await ensureApprovalLedgerEffect(workspace, approvalDecisionEffect(current), false, legacyApprovalDecisionSummary(current));
        return current;
      }
      throw approvalError("APPROVAL_STATE_CONFLICT", "A decided approval cannot receive a conflicting decision.", { approvalId: id, status: current.status });
    }
    if (decision.status === "revoked") {
      throw approvalError("APPROVAL_STATE_CONFLICT", "Only an approved Approval can be revoked.", { approvalId: id, status: current.status });
    }
    let prepared = current.pendingDecision;
    if (prepared === undefined) {
      prepared = createPendingDecision(current, decision);
      const journaled = assertApprovalSemantic({ ...current, pendingDecision: prepared });
      schemas.validate("approval", journaled);
      await writeWorkspaceJson(workspace, fileName(id), journaled);
      maybeInjectApprovalFault(workspace, "after-decision-prepare", id);
    } else {
      assertPendingDecisionRetry(current, decision, prepared);
    }
    assertPendingDecisionHash(current, prepared);
    const { pendingDecision: _pendingDecision, ...requested } = current;
    const next = assertApprovalSemantic({
      ...requested,
      status: prepared.status,
      decidedBy: prepared.decidedBy,
      decidedAt: prepared.decidedAt,
      reason: prepared.reason,
      ...(prepared.expiresAt === undefined ? {} : { expiresAt: prepared.expiresAt })
    });
    schemas.validate("approval", next);
    // A positive decision becomes usable only after its exact audit effect is
    // durable. Rejected/expired decisions use the same ordering so a PREPARED
    // audit can be recovered only by replaying this exact decision.
    await ensureApprovalLedgerEffect(workspace, approvalDecisionEffect(next), true);
    maybeInjectApprovalFault(workspace, "after-decision-ledger", next.id);
    await writeWorkspaceJson(workspace, fileName(id), next);
    maybeInjectApprovalFault(workspace, "after-decision-record", next.id);
    return next;
  });
}

/** Test-only, single-use Approval split-write fault point. */
export function injectApprovalFaultForTesting(workspace: LocalWorkspace, point: ApprovalFaultPoint): void {
  if (process.env.NODE_ENV !== "test") throw approvalError("APPROVAL_TEST_FAULT_DENIED", "Approval fault injection is available only under the test runner.");
  approvalFaults.set(workspace.directory, point);
}

function maybeInjectApprovalFault(workspace: LocalWorkspace, point: ApprovalFaultPoint, approvalId: string): void {
  if (approvalFaults.get(workspace.directory) !== point) return;
  approvalFaults.delete(workspace.directory);
  throw approvalError("APPROVAL_TEST_FAULT", `Injected Approval fault at ${point}.`, { approvalId, point });
}

export async function inspectApproval(workspace: LocalWorkspace, schemas: SchemaRegistry, id: string): Promise<ApprovalInspection> {
  const approval = await getApproval(workspace, id);
  schemas.validate("approval", approval);
  const expired = isApprovalExpired(approval);
  try { await getTask(workspace, approval.taskId); return { valid: true, approval, taskExists: true, expired }; }
  catch (error: unknown) { if (error instanceof StinkyCobblerError && error.code === "TASK_NOT_FOUND") return { valid: false, approval, taskExists: false, expired }; throw error; }
}

/** Atomically consumes a one-shot Approval; an exact-owner retry is idempotent. */
export async function consumeApproval(workspace: LocalWorkspace, schemas: SchemaRegistry, id: string, consumedBy: string): Promise<Approval> {
  return withWorkspaceLock(workspace, async () => {
    if (!consumedBy || consumedBy.length > 256 || consumedBy.includes("\0")) throw approvalError("APPROVAL_INVALID", "Approval consumedBy is invalid.");
    const current = await getApproval(workspace, id);
    if (current.status !== "approved" || isApprovalExpired(current)) throw approvalError("APPROVAL_NOT_ACTIVE", "Only a current approved record can be consumed.", { approvalId: id, status: current.status });
    if (current.consumedAt !== undefined || current.consumedBy !== undefined) {
      if (current.consumedAt !== undefined && current.consumedBy === consumedBy) return current;
      throw approvalError("APPROVAL_ALREADY_CONSUMED", "Approval has already been consumed and cannot authorize another subject.", { approvalId: id, consumedBy: current.consumedBy });
    }
    const next = assertApprovalSemantic({ ...current, consumedAt: new Date().toISOString(), consumedBy });
    schemas.validate("approval", next);
    await writeWorkspaceJson(workspace, fileName(id), next);
    return next;
  });
}

function assertRequest(input: ApprovalRequestInput): void {
  assertSafeTaskId(input.taskId);
  if (!input.action || input.action.includes("\0")) throw approvalError("APPROVAL_INVALID", "Approval action is invalid.");
  if (input.action.length > MAX_APPROVAL_ACTION_LENGTH) throw approvalError("APPROVAL_INPUT_TOO_LARGE", "Approval action exceeds the canonical input size limit.");
  if (input.reason !== undefined && input.reason.length > MAX_APPROVAL_REASON_LENGTH) throw approvalError("APPROVAL_INPUT_TOO_LARGE", "Approval reason exceeds the canonical input size limit.");
  if (input.scope?.some((item) => !item || item.includes("\0"))) throw approvalError("APPROVAL_INVALID", "Approval scope is invalid.");
  if (input.scope !== undefined && (input.scope.length > MAX_APPROVAL_SCOPE_ITEMS || input.scope.some((item) => item.length > MAX_APPROVAL_SCOPE_ITEM_LENGTH))) {
    throw approvalError("APPROVAL_INPUT_TOO_LARGE", "Approval scope exceeds the canonical input size limit.");
  }
  if (input.expiresAt !== undefined && !isCanonicalDate(input.expiresAt)) throw approvalError("APPROVAL_INVALID", "Approval expiresAt is invalid.");
  if (input.budget?.expiresAt !== undefined && !isCanonicalDate(input.budget.expiresAt)) throw approvalError("APPROVAL_INVALID", "Approval budget expiresAt is invalid.");
  if (input.budget?.maxToolCalls !== undefined && (!Number.isSafeInteger(input.budget.maxToolCalls) || input.budget.maxToolCalls < 1)) throw approvalError("APPROVAL_INVALID", "Approval budget maxToolCalls is invalid.");
  if (input.budget?.maxToolCalls !== undefined && input.budget.maxToolCalls > MAX_APPROVAL_BUDGET_TOOL_CALLS) throw approvalError("APPROVAL_INPUT_TOO_LARGE", "Approval budget exceeds the canonical input size limit.");
  const precise = input.subjectKind !== undefined || input.subjectId !== undefined || input.subjectHash !== undefined || input.capability !== undefined || input.policyVersion !== undefined || input.requestedBy !== undefined || input.nonce !== undefined || input.budget !== undefined || input.expectedPreimageHash !== undefined || input.proposedContentHash !== undefined;
  if (precise && (
    input.subjectKind === undefined || input.subjectId === undefined || input.subjectHash === undefined || input.capability === undefined ||
    input.policyVersion === undefined || input.requestedBy === undefined || input.hostSessionId === undefined || input.nonce === undefined || input.expiresAt === undefined ||
    input.scope === undefined || input.scope.length === 0
  )) throw approvalError("APPROVAL_PRECISE_FIELDS_REQUIRED", "A precise Approval requires subject, capability, exact scope, policy, requester, expiry, and nonce bindings.");
}
function assertDecision(input: ApprovalDecisionInput): void { if (!STATUSES.has(input.status) || !input.status) throw approvalError("APPROVAL_INVALID", "Approval decision status is invalid."); if (!input.decidedBy || input.decidedBy.length > 256 || /[\0\r\n]/.test(input.decidedBy) || !input.reason || input.reason.length > 512) throw approvalError("APPROVAL_INVALID", "Approval decision metadata is invalid."); if (input.decidedAt !== undefined && !isCanonicalDate(input.decidedAt)) throw approvalError("APPROVAL_INVALID", "Approval decidedAt is invalid."); if (input.expiresAt !== undefined && !isCanonicalDate(input.expiresAt)) throw approvalError("APPROVAL_INVALID", "Approval expiresAt is invalid."); }
function assertId(id: string): void { if (!ID_PATTERN.test(id)) throw approvalError("APPROVAL_INVALID", "Approval ID is invalid.", { approvalId: id }); }
function fileName(id: string): string { return path.join(DIRECTORY, `${id}.json`); }
function isCanonicalDate(value: string): boolean { const date = new Date(value); return !Number.isNaN(date.getTime()) && date.toISOString() === value; }
function sameRequest(existing: Approval, input: ApprovalRequestInput): boolean {
  const requested = {
    taskId: input.taskId, action: input.action, scope: input.scope ?? null, reason: input.reason ?? null, expiresAt: input.expiresAt ?? null,
    subjectKind: input.subjectKind ?? null, subjectId: input.subjectId ?? null, subjectVersion: input.subjectVersion ?? null,
    subjectHash: input.subjectHash ?? null, capability: input.capability ?? null, expectedPreimageHash: input.expectedPreimageHash ?? null,
    proposedContentHash: input.proposedContentHash ?? null, budget: input.budget ?? null, policyVersion: input.policyVersion ?? null,
    requestedBy: input.requestedBy ?? null, hostSessionId: input.hostSessionId ?? null, nonce: input.nonce ?? null
  };
  const stored = {
    taskId: existing.taskId, action: existing.action, scope: existing.scope ?? null, reason: existing.reason ?? null, expiresAt: existing.expiresAt ?? null,
    subjectKind: existing.subjectKind ?? null, subjectId: existing.subjectId ?? null, subjectVersion: existing.subjectVersion ?? null,
    subjectHash: existing.subjectHash ?? null, capability: existing.capability ?? null, expectedPreimageHash: existing.expectedPreimageHash ?? null,
    proposedContentHash: existing.proposedContentHash ?? null, budget: existing.budget ?? null, policyVersion: existing.policyVersion ?? null,
    requestedBy: existing.requestedBy ?? null, hostSessionId: existing.hostSessionId ?? null, nonce: existing.nonce ?? null
  };
  return JSON.stringify(stored) === JSON.stringify(requested);
}
function sameDecision(existing: Approval, decision: ApprovalDecisionInput): boolean {
  if (existing.status !== decision.status) return false;
  if (existing.status === "revoked" && existing.revokedAt !== undefined) {
    return existing.revokedBy === decision.decidedBy && existing.revocationReason === decision.reason &&
      (decision.decidedAt === undefined || existing.revokedAt === decision.decidedAt);
  }
  return existing.decidedBy === decision.decidedBy && existing.reason === decision.reason &&
    (decision.decidedAt === undefined || existing.decidedAt === decision.decidedAt) &&
    (decision.expiresAt === undefined || existing.expiresAt === decision.expiresAt);
}
type PendingDecision = NonNullable<Approval["pendingDecision"]>;
function createPendingDecision(current: Approval, decision: ApprovalDecisionInput): PendingDecision {
  if (decision.status === "revoked") throw approvalError("APPROVAL_STATE_CONFLICT", "Only an approved Approval can be revoked.", { approvalId: current.id });
  const prepared: Omit<PendingDecision, "decisionHash"> = {
    status: decision.status,
    decidedBy: decision.decidedBy,
    reason: decision.reason,
    decidedAt: decision.decidedAt ?? new Date().toISOString(),
    ...(decision.expiresAt === undefined
      ? (current.expiresAt === undefined ? {} : { expiresAt: current.expiresAt })
      : { expiresAt: decision.expiresAt })
  };
  return { ...prepared, decisionHash: hashPendingDecision(current.id, prepared) };
}
function assertPendingDecisionRetry(current: Approval, decision: ApprovalDecisionInput, prepared: PendingDecision): void {
  const effectiveExpiry = decision.expiresAt ?? current.expiresAt;
  if (
    decision.status !== prepared.status || decision.decidedBy !== prepared.decidedBy || decision.reason !== prepared.reason ||
    (decision.decidedAt !== undefined && decision.decidedAt !== prepared.decidedAt) || effectiveExpiry !== prepared.expiresAt
  ) throw approvalError("APPROVAL_STATE_CONFLICT", "Only the exact prepared Approval decision can be recovered.", { approvalId: current.id });
}
function assertPendingDecisionHash(current: Approval, prepared: PendingDecision): void {
  const { decisionHash, ...canonical } = prepared;
  if (decisionHash !== hashPendingDecision(current.id, canonical)) {
    throw approvalError("APPROVAL_INVALID", "Approval pending decision journal hash is invalid.", { approvalId: current.id });
  }
}
function hashPendingDecision(approvalId: string, decision: Omit<PendingDecision, "decisionHash">): string {
  return `sha256:${createHash("sha256").update(JSON.stringify({ approvalId, ...decision }), "utf8").digest("hex")}`;
}
function approvalRequestedEffect(approval: Approval): AppendLedgerEntry {
  return prepareLedgerEntry({ event: "approval-requested", taskId: approval.taskId, approvalRef: approval.id, summary: `Approval ${approval.id} requested.` });
}
function approvalDecisionEffect(approval: Approval): AppendLedgerEntry {
  const decision = approval.status === "revoked" && approval.revokedAt !== undefined
    ? { status: approval.status, decidedBy: approval.revokedBy, reason: approval.revocationReason, decidedAt: approval.revokedAt, expiresAt: approval.expiresAt ?? null }
    : { status: approval.status, decidedBy: approval.decidedBy, reason: approval.reason, decidedAt: approval.decidedAt, expiresAt: approval.expiresAt ?? null };
  return prepareLedgerEntry({
    event: "approval-decided",
    taskId: approval.taskId,
    approvalRef: approval.id,
    summary: approval.status === "revoked" && approval.revokedAt !== undefined
      ? `Approval ${approval.id} revoked; decision ${auditTextFingerprint(JSON.stringify(decision))}.`
      : `Approval ${approval.id} decided as ${approval.status}; decision ${auditTextFingerprint(JSON.stringify(decision))}.`
  });
}
function legacyApprovalDecisionSummary(approval: Approval): string {
  return approval.status === "revoked" && approval.revokedAt !== undefined
    ? `Approval ${approval.id} revoked.`
    : `Approval ${approval.id} decided as ${approval.status}.`;
}
async function ensureApprovalLedgerEffect(workspace: LocalWorkspace, effect: AppendLedgerEntry, forbidOtherDecision: boolean, allowedLegacySummary?: string): Promise<void> {
  const entries = (await listLedgerEntries(workspace)).filter((entry) => entry.event === effect.event && entry.approvalRef === effect.approvalRef);
  const exact = entries.filter((entry) => entry.taskId === effect.taskId && entry.summary === effect.summary);
  if (exact.length > 1) {
    throw approvalError("APPROVAL_AUDIT_CONFLICT", "Approval has duplicate canonical audit effects.", { approvalId: effect.approvalRef, event: effect.event, count: exact.length });
  }
  if (exact.length === 1) return;
  const legacy = allowedLegacySummary === undefined ? [] : entries.filter((entry) => entry.taskId === effect.taskId && entry.summary === allowedLegacySummary);
  if (legacy.length > 1) throw approvalError("APPROVAL_AUDIT_CONFLICT", "Approval has duplicate legacy audit effects.", { approvalId: effect.approvalRef, event: effect.event, count: legacy.length });
  if (legacy.length === 1) return;
  if (entries.length > 0 && (effect.event === "approval-requested" || forbidOtherDecision)) {
    throw approvalError("APPROVAL_AUDIT_CONFLICT", "Approval audit is already bound to different canonical content.", { approvalId: effect.approvalRef, event: effect.event });
  }
  await appendLedgerEntry(workspace, effect);
}
function approvalError(code: string, message: string, details: Record<string, unknown> = {}): StinkyCobblerError { return new StinkyCobblerError(code, ExitCode.VALIDATION, message, details); }
function isCode(error: unknown, code: string): boolean { return typeof error === "object" && error !== null && "code" in error && error.code === code; }
