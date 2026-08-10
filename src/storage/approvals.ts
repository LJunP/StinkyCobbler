import { mkdir, readFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Approval } from "../contracts/types.js";
import type { SchemaRegistry } from "../contracts/schema-registry.js";
import { ExitCode, StinkyCobblerError } from "../errors.js";
import { appendLedgerEntry } from "./ledger.js";
import type { LocalWorkspace } from "./workspace.js";
import { createWorkspaceJson, workspaceFile, writeWorkspaceJson } from "./workspace.js";
import { withWorkspaceLock } from "./workspace-lock.js";
import { assertSafeTaskId, getTask } from "./tasks.js";
import { assertApprovalSemantic, isApprovalExpired } from "../policy/approval.js";

const DIRECTORY = "approvals";
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const STATUSES = new Set<Approval["status"]>(["requested", "approved", "rejected", "expired", "revoked"]);

export interface ApprovalRequestInput {
  taskId: string;
  action: string;
  scope?: string[];
  reason?: string;
  expiresAt?: string;
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
    assertRequest(input);
    await getTask(workspace, input.taskId);
    await mkdir(await workspaceFile(workspace, DIRECTORY), { recursive: true, mode: 0o700 });
    const approval: Approval = assertApprovalSemantic({
      id: `approval-${randomUUID()}`,
      taskId: input.taskId,
      action: input.action,
      status: "requested",
      requestedAt: new Date().toISOString(),
      ...(input.scope === undefined ? {} : { scope: input.scope }),
      ...(input.reason === undefined ? {} : { reason: input.reason }),
      ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt })
    });
    schemas.validate("approval", approval);
    await createWorkspaceJson(workspace, fileName(approval.id), approval);
    await appendLedgerEntry(workspace, { event: "approval-requested", taskId: approval.taskId, approvalRef: approval.id, summary: `Approval ${approval.id} requested.` });
    return approval;
  });
}

export async function getApproval(workspace: LocalWorkspace, id: string): Promise<Approval> {
  assertId(id);
  try {
    return assertApprovalSemantic(JSON.parse(await readFile(await workspaceFile(workspace, fileName(id)), "utf8")) as Approval);
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
    if (current.status !== "requested") {
      if (current.status === decision.status && current.decidedBy === decision.decidedBy && current.reason === decision.reason) return current;
      throw approvalError("APPROVAL_STATE_CONFLICT", "A decided approval cannot receive a conflicting decision.", { approvalId: id, status: current.status });
    }
    const next = assertApprovalSemantic({ ...current, status: decision.status, decidedBy: decision.decidedBy, decidedAt: decision.decidedAt ?? new Date().toISOString(), reason: decision.reason, ...(decision.expiresAt === undefined ? {} : { expiresAt: decision.expiresAt }) });
    schemas.validate("approval", next);
    await writeWorkspaceJson(workspace, fileName(id), next);
    await appendLedgerEntry(workspace, { event: "approval-decided", taskId: next.taskId, approvalRef: next.id, summary: `Approval ${next.id} decided as ${next.status}.` });
    return next;
  });
}

export async function inspectApproval(workspace: LocalWorkspace, schemas: SchemaRegistry, id: string): Promise<ApprovalInspection> {
  const approval = await getApproval(workspace, id);
  schemas.validate("approval", approval);
  const expired = isApprovalExpired(approval);
  try { await getTask(workspace, approval.taskId); return { valid: true, approval, taskExists: true, expired }; }
  catch (error: unknown) { if (error instanceof StinkyCobblerError && error.code === "TASK_NOT_FOUND") return { valid: false, approval, taskExists: false, expired }; throw error; }
}

function assertRequest(input: ApprovalRequestInput): void { assertSafeTaskId(input.taskId); if (!input.action || input.action.includes("\0")) throw approvalError("APPROVAL_INVALID", "Approval action is invalid."); if (input.scope?.some((item) => !item || item.includes("\0"))) throw approvalError("APPROVAL_INVALID", "Approval scope is invalid."); if (input.expiresAt !== undefined && !isCanonicalDate(input.expiresAt)) throw approvalError("APPROVAL_INVALID", "Approval expiresAt is invalid."); }
function assertDecision(input: ApprovalDecisionInput): void { if (!STATUSES.has(input.status) || !input.status) throw approvalError("APPROVAL_INVALID", "Approval decision status is invalid."); if (!input.decidedBy || input.decidedBy.includes("\0") || !input.reason || input.reason.length > 512) throw approvalError("APPROVAL_INVALID", "Approval decision metadata is invalid."); if (input.decidedAt !== undefined && !isCanonicalDate(input.decidedAt)) throw approvalError("APPROVAL_INVALID", "Approval decidedAt is invalid."); if (input.expiresAt !== undefined && !isCanonicalDate(input.expiresAt)) throw approvalError("APPROVAL_INVALID", "Approval expiresAt is invalid."); }
function assertId(id: string): void { if (!ID_PATTERN.test(id)) throw approvalError("APPROVAL_INVALID", "Approval ID is invalid.", { approvalId: id }); }
function fileName(id: string): string { return path.join(DIRECTORY, `${id}.json`); }
function isCanonicalDate(value: string): boolean { const date = new Date(value); return !Number.isNaN(date.getTime()) && date.toISOString() === value; }
function approvalError(code: string, message: string, details: Record<string, unknown> = {}): StinkyCobblerError { return new StinkyCobblerError(code, ExitCode.VALIDATION, message, details); }
function isCode(error: unknown, code: string): boolean { return typeof error === "object" && error !== null && "code" in error && error.code === code; }
