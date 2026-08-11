import { mkdir, readFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { CapabilityLease } from "../contracts/types.js";
import type { SchemaRegistry } from "../contracts/schema-registry.js";
import { ExitCode, StinkyCobblerError } from "../errors.js";
import { appendLedgerEntry } from "./ledger.js";
import type { LocalWorkspace } from "./workspace.js";
import { createWorkspaceJson, workspaceFile, writeWorkspaceJson } from "./workspace.js";
import { withWorkspaceLock } from "./workspace-lock.js";
import { getTask } from "./tasks.js";
import { assertWrites } from "./write-intents.js";
import { loadOrchestrationConfig } from "../config/tiered.js";

const DIRECTORY = "leases";
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ISSUE_CAPABILITIES = new Set(["repository-read", "git-read", "docs-index", "repository-write"]);
const DEFAULT_MAX_TOOL_CALLS = 20;
const MAX_MAX_TOOL_CALLS = 100;
const DEFAULT_EXPIRES_IN_MINUTES = 60;
const MAX_EXPIRES_IN_MINUTES = 1440;

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
}

/** Issues a user-confirmed, read-only L0 lease and persists it for later use. */
export async function issueLease(workspace: LocalWorkspace, schemas: SchemaRegistry, input: LeaseIssueInput): Promise<CapabilityLease> {
  return withWorkspaceLock(workspace, async () => {
    const cfg = await loadOrchestrationConfig(workspace);
    const defaultToolCalls = cfg.defaults?.leaseDefaultToolCalls ?? DEFAULT_MAX_TOOL_CALLS;
    const defaultMinutes = cfg.defaults?.leaseDefaultMinutes ?? DEFAULT_EXPIRES_IN_MINUTES;
    const maxToolCallsCap = cfg.defaults?.leaseMaxToolCallsCap ?? MAX_MAX_TOOL_CALLS;
    const maxMinutesCap = cfg.defaults?.leaseMaxMinutes ?? MAX_EXPIRES_IN_MINUTES;
    assertIssueInput(input, { defaultToolCalls, defaultMinutes, maxToolCallsCap, maxMinutesCap });
    await getTask(workspace, input.taskId);
    await mkdir(await workspaceFile(workspace, DIRECTORY), { recursive: true, mode: 0o700 });
    const now = new Date();
    const isWrite = input.capability === "repository-write";
    const lease: CapabilityLease = {
      id: `lease-${randomUUID()}`,
      taskId: input.taskId,
      agentId: input.agentId,
      role: input.role,
      capability: input.capability,
      level: isWrite ? "L1" : "L0",
      workspace: workspace.root,
      readScope: input.readScope ?? ["."],
      writeSet: isWrite ? input.writeSet! : [],
      issuedBy: input.issuedBy ?? "user-confirmed",
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + (input.expiresInMinutes ?? defaultMinutes) * 60_000).toISOString(),
      maxToolCalls: input.maxToolCalls ?? defaultToolCalls,
      status: "active",
      ...(input.subtaskRef === undefined ? {} : { subtaskRef: input.subtaskRef })
    };
    schemas.validate("lease", lease);
    await createWorkspaceJson(workspace, fileName(lease.id), lease);
    await appendLedgerEntry(workspace, { event: "lease-issued", taskId: lease.taskId, leaseRef: lease.id, summary: `Lease ${lease.id} issued for ${lease.capability}.` });
    return lease;
  });
}

export async function getLease(workspace: LocalWorkspace, id: string): Promise<CapabilityLease> {
  assertLeaseId(id);
  try {
    return JSON.parse(await readFile(await workspaceFile(workspace, fileName(id)), "utf8")) as CapabilityLease;
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

/** Revokes an issued lease. Idempotent: revoking an already-revoked lease returns it unchanged. */
export async function revokeLease(workspace: LocalWorkspace, id: string, reason: string): Promise<CapabilityLease> {
  return withWorkspaceLock(workspace, async () => {
    if (!reason || reason.length > 512) throw leaseError("LEASE_REVOKE_REASON_INVALID", "Revocation reason must be 1-512 characters.");
    const current = await getLease(workspace, id);
    if (current.status === "revoked") return current;
    const next = { ...current, status: "revoked" as const };
    await writeWorkspaceJson(workspace, fileName(id), next);
    await appendLedgerEntry(workspace, { event: "lease-revoked", taskId: next.taskId, leaseRef: next.id, summary: `Lease ${next.id} revoked: ${reason}` });
    return next;
  });
}

function assertIssueInput(input: LeaseIssueInput, limits: { defaultToolCalls: number; defaultMinutes: number; maxToolCallsCap: number; maxMinutesCap: number }): void {
  if (!input.taskId || !input.agentId || !input.role) throw leaseError("LEASE_ISSUE_INPUT_INVALID", "taskId, agentId, and role are required.");
  if (!ISSUE_CAPABILITIES.has(input.capability)) throw leaseError("LEASE_CAPABILITY_DENIED", `Only read-only capabilities may be issued: ${[...ISSUE_CAPABILITIES].sort().join(", ")}.`, { capability: input.capability });
  const maxToolCalls = input.maxToolCalls ?? limits.defaultToolCalls;
  if (!Number.isSafeInteger(maxToolCalls) || maxToolCalls < 1 || maxToolCalls > limits.maxToolCallsCap) throw leaseError("LEASE_MAX_TOOL_CALLS_INVALID", `maxToolCalls must be between 1 and ${limits.maxToolCallsCap}.`, { maxToolCalls });
  const expiresInMinutes = input.expiresInMinutes ?? limits.defaultMinutes;
  if (!Number.isSafeInteger(expiresInMinutes) || expiresInMinutes < 1 || expiresInMinutes > limits.maxMinutesCap) throw leaseError("LEASE_EXPIRES_IN_INVALID", `expiresInMinutes must be between 1 and ${limits.maxMinutesCap}.`, { expiresInMinutes });
  for (const scope of input.readScope ?? ["."]) {
    if (!scope || scope.includes("\0") || scope.startsWith("/") || scope.split(/[\\/]/).includes("..") || scope === ".stinky-cobbler" || scope.startsWith(".stinky-cobbler/")) {
      throw leaseError("LEASE_READ_SCOPE_INVALID", "Read scopes must be workspace-relative and must not cover the control-plane directory.", { scope });
    }
  }
  if (input.capability === "repository-write") {
    if (!input.writeSet || input.writeSet.length === 0) throw leaseError("LEASE_WRITE_SET_REQUIRED", "A repository-write lease requires a non-empty writeSet.");
    assertWrites(input.writeSet.map((target) => ({ target, action: "modify", purpose: "Whitelisted write target." })));
  }
}

function assertLeaseId(id: string): void { if (!ID_PATTERN.test(id)) throw leaseError("LEASE_INVALID", "Lease ID is invalid.", { leaseId: id }); }
function fileName(id: string): string { return path.join(DIRECTORY, `${id}.json`); }
function leaseError(code: string, message: string, details: Record<string, unknown> = {}): StinkyCobblerError { return new StinkyCobblerError(code, ExitCode.VALIDATION, message, details); }
function isCode(error: unknown, code: string): boolean { return typeof error === "object" && error !== null && "code" in error && error.code === code; }
