import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CapabilityLease, PolicyDecision } from "../contracts/types.js";
import { appendLedgerEntry } from "../storage/ledger.js";
import { admitAndReserveLeaseCall } from "../storage/lease-usage.js";
import { persistMcpAudit, prepareMcpAudit, listPendingAudits } from "../storage/audit-service.js";
import { recordReceipt } from "../storage/receipts.js";
import { WORKSPACE_CONFIG_FILE, loadWorkspaceConfig } from "../config/workspace.js";
import { loadRegistries } from "../config/registry.js";
import { openWorkspace, workspaceFile, type LocalWorkspace } from "../storage/workspace.js";
import type { SchemaRegistry } from "../contracts/schema-registry.js";
import type { ToolOutcome } from "./shared.js";

const degradedWorkspaces = new Set<string>();

export interface ControlledInvocationInput {
  /** Legacy 2.0 input. Only its `id` is used; all other fields are untrusted. */
  lease?: unknown | undefined;
  /** Preferred 2.0.1 input: public ID of a persisted workspace lease. */
  leaseId?: string | undefined;
  taskId: string;
  role: string;
  workspace: string;
}

export interface ControlledInvocationDependencies {
  openWorkspace: typeof openWorkspace;
  admitAndReserveLeaseCall: typeof admitAndReserveLeaseCall;
  recordReceipt: typeof recordReceipt;
  audit?: typeof persistMcpAudit;
  prepareAudit?: typeof prepareMcpAudit;
  listPendingAudits: typeof listPendingAudits;
  appendLedgerEntry: typeof appendLedgerEntry;
  loadWorkspaceConfig: (workspace: LocalWorkspace, schemas: SchemaRegistry) => Promise<Record<string, string[]>>;
}

export interface ControlledInvocationOptions { operation?: string; }

interface McpAuditAuthority {
  leaseId: string;
  taskAuthorityHash: string;
  capability: string;
  operation: string;
  reservationId?: string;
  reservationOrdinal?: number;
}

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** Production config admission: schema plus cross-reference validation against built-in registries. */
async function admitWorkspaceConfig(workspace: LocalWorkspace, schemas: SchemaRegistry): Promise<Record<string, string[]>> {
  const registries = await loadRegistries(projectRoot, schemas);
  await loadWorkspaceConfig(workspace, schemas, registries);
  return registries.roleTools;
}

const productionDependencies: ControlledInvocationDependencies = {
  openWorkspace,
  admitAndReserveLeaseCall,
  recordReceipt,
  audit: persistMcpAudit,
  prepareAudit: prepareMcpAudit,
  listPendingAudits,
  appendLedgerEntry,
  loadWorkspaceConfig: admitWorkspaceConfig
};
const invocationFaults = new Map<string, "after-audit-prepare">();

/** Applies the controlled invocation protocol to every MCP capability except test-run. */
export async function invokeControlled(
  schemas: SchemaRegistry,
  input: ControlledInvocationInput,
  capability: string,
  run: (access: { lease: CapabilityLease; taskId: string; role: string; workspace: string }) => Promise<ToolOutcome<unknown>>,
  dependencies: ControlledInvocationDependencies = productionDependencies,
  options: ControlledInvocationOptions = {}
): Promise<unknown> {
  const callId = `call-${randomUUID()}`;
  const operation = options.operation ?? capability;
  let workspace: LocalWorkspace;
  try {
    workspace = await dependencies.openWorkspace(input.workspace);
    const configPath = await workspaceFile(workspace, WORKSPACE_CONFIG_FILE);
    const configInfo = await stat(configPath);
    if (!configInfo.isFile()) return denied("WORKSPACE_NOT_INITIALIZED", "The workspace configuration must be a file.");
    const configText = await readFile(configPath, "utf8");
    JSON.parse(configText) as unknown;
  } catch {
    return denied("WORKSPACE_NOT_INITIALIZED", "The workspace must be initialized before MCP invocation.");
  }

  let roleTools: Record<string, string[]>;
  try {
    roleTools = await dependencies.loadWorkspaceConfig(workspace, schemas);
  } catch (error: unknown) {
    const raw = error instanceof Error && error.message ? error.message : "The workspace configuration failed admission.";
    const reason = raw.slice(0, 200).replace(/[\x00-\x1f]/g, " ") || "The workspace configuration failed admission.";
    return denied("WORKSPACE_CONFIG_INVALID", reason);
  }

  if (dependencies.listPendingAudits) {
    let pending: Awaited<ReturnType<typeof listPendingAudits>>;
    try {
      pending = await dependencies.listPendingAudits(workspace);
    } catch {
      return denied("AUDIT_PERSISTENCE_FAILED", "Pending audit state could not be read; recover audit state before invoking MCP capabilities.");
    }
    if (pending.length > 0) {
      return denied("AUDIT_PERSISTENCE_FAILED", "Pending audit state requires explicit recovery before invoking MCP capabilities.");
    }
    degradedWorkspaces.delete(workspace.directory);
  } else if (degradedWorkspaces.has(workspace.directory)) {
    return denied("AUDIT_PERSISTENCE_FAILED", "Workspace audit persistence is degraded in this server process.");
  }

  let leaseId: string;
  try {
    leaseId = resolveLeaseId(input);
  } catch {
    // No persisted principal exists yet. Persisting a caller-chosen taskId here
    // could create an unrecoverable audit outbox for a nonexistent Task.
    return denied("LEASE_INVALID", "The supplied lease reference is invalid.");
  }

  let lease: CapabilityLease;
  let auditAuthority: McpAuditAuthority | undefined;
  try {
    const admission = await dependencies.admitAndReserveLeaseCall(
      workspace,
      leaseId,
      { taskId: input.taskId, role: input.role, capability, operation, roleTools },
      (stored) => schemas.validate("lease", stored),
      dependencies.prepareAudit === undefined
        ? undefined
        : async (stored, reservation) => {
          auditAuthority = authorityFor(stored, capability, operation, reservation);
          await dependencies.prepareAudit!(workspace, {
            callId,
            taskId: stored.taskId,
            role: stored.role,
            tool: operation,
            ...auditAuthority
          });
          maybeInjectInvocationFault(workspace, "after-audit-prepare");
        }
    );
    lease = admission.lease;
    auditAuthority ??= authorityFor(lease, capability, operation, admission.reservationId === undefined || admission.reservationOrdinal === undefined
      ? undefined
      : { id: admission.reservationId, ordinal: admission.reservationOrdinal });
    if (!admission.allowed) {
      if (admission.auditDeniedAttempt !== true) return { decision: admission.decision };
      return finish(workspace, schemas, authoritativeInput(input, lease), auditAuthority, "rejected", { decision: admission.decision }, dependencies, callId);
    }
  } catch (error: unknown) {
    if (dependencies.prepareAudit !== undefined) {
      try {
        if ((await dependencies.listPendingAudits(workspace)).length > 0) {
          return denied("AUDIT_PERSISTENCE_FAILED", "The invocation stopped after its durable audit marker; recover the pending unknown outcome before retrying.");
        }
      } catch {
        return denied("AUDIT_PERSISTENCE_FAILED", "Audit state could not be verified after invocation admission failed.");
      }
    }
    // A missing/malformed Lease has no trustworthy Task principal. Return the
    // denial without writing caller-controlled durable audit state.
    return { decision: leaseLoadDecision(error) };
  }

  try {
    const result = await run({ lease, taskId: lease.taskId, role: lease.role, workspace: workspace.root });
    return finish(workspace, schemas, authoritativeInput(input, lease), auditAuthority, result.decision.allowed ? "completed" : "rejected", result, dependencies, callId);
  } catch {
    return finish(workspace, schemas, authoritativeInput(input, lease), auditAuthority, "failed", denied("INVOCATION_FAILED", "The invocation failed."), dependencies, callId);
  }
}

/** Test-only, single-use crash point after the durable pre-execution marker. */
export function injectControlledInvocationFaultForTesting(workspace: LocalWorkspace, point: "after-audit-prepare"): void {
  if (process.env.NODE_ENV !== "test") throw new Error("Controlled invocation fault injection is available only under the test runner.");
  invocationFaults.set(workspace.directory, point);
}

function maybeInjectInvocationFault(workspace: LocalWorkspace, point: "after-audit-prepare"): void {
  if (invocationFaults.get(workspace.directory) !== point) return;
  invocationFaults.delete(workspace.directory);
  throw new Error(`Injected controlled invocation fault at ${point}.`);
}

export function isWorkspaceAuditDegraded(workspace: LocalWorkspace): boolean { return degradedWorkspaces.has(workspace.directory); }

async function finish(
  workspace: LocalWorkspace,
  schemas: SchemaRegistry,
  input: ControlledInvocationInput,
  authority: McpAuditAuthority,
  outcome: "completed" | "rejected" | "failed",
  result: unknown,
  dependencies: ControlledInvocationDependencies,
  callId: string
): Promise<unknown> {
  try {
    if (dependencies.audit) {
      await dependencies.audit(workspace, schemas, { callId, taskId: input.taskId, role: input.role, tool: authority.operation, ...authority, outcome });
    } else {
      const receiptId = `mcp-${randomUUID()}`;
      await dependencies.recordReceipt(workspace, schemas, {
        id: receiptId, taskId: input.taskId, role: input.role,
        status: outcome === "completed" ? "COMPLETED" : outcome === "rejected" ? "BLOCKED" : "FAILED",
        facts: [], proposals: [], unknowns: [], evidenceRefs: [], policyVersion: "1",
        authorityLeaseId: authority.leaseId,
        authorityHash: authority.taskAuthorityHash,
        capability: authority.capability,
        operation: authority.operation,
        ...(authority.reservationId === undefined ? {} : { reservationId: authority.reservationId }),
        ...(authority.reservationOrdinal === undefined ? {} : { reservationOrdinal: authority.reservationOrdinal }),
        toolSummary: outcome === "completed" ? "MCP workspace capability completed." : outcome === "rejected" ? "MCP workspace capability denied." : "MCP workspace capability failed.",
        createdAt: new Date().toISOString()
      });
      await dependencies.appendLedgerEntry(workspace, {
        event: "mcp-call", taskId: input.taskId, role: input.role, policyVersion: "1", tool: authority.operation,
        capability: authority.capability,
        authorityHash: authority.taskAuthorityHash,
        leaseRef: authority.leaseId,
        ...(authority.reservationId === undefined ? {} : { reservationId: authority.reservationId }),
        ...(authority.reservationOrdinal === undefined ? {} : { reservationOrdinal: authority.reservationOrdinal }),
        receiptRef: receiptId,
        summary: outcome === "completed" ? "MCP workspace capability completed." : outcome === "rejected" ? "MCP workspace capability denied." : "MCP workspace capability failed."
      });
    }
    return result;
  } catch {
    degradedWorkspaces.add(workspace.directory);
    return denied("AUDIT_PERSISTENCE_FAILED", "Audit persistence failed; this workspace is degraded for this server process.");
  }
}

function authorityFor(
  lease: CapabilityLease,
  capability: string,
  operation: string,
  reservation?: { id: string; ordinal: number }
): McpAuditAuthority {
  return {
    leaseId: lease.id,
    taskAuthorityHash: lease.taskAuthorityHash,
    capability,
    operation,
    ...(reservation === undefined ? {} : { reservationId: reservation.id, reservationOrdinal: reservation.ordinal })
  };
}

function denied(code: string, reason: string): { decision: PolicyDecision } { return { decision: deniedDecision(code, reason) }; }
function deniedDecision(code: string, reason: string): PolicyDecision { return { allowed: false, code, reasons: [reason], policyVersion: "1" }; }

function resolveLeaseId(input: ControlledInvocationInput): string {
  const direct = input.leaseId;
  const legacy = typeof input.lease === "object" && input.lease !== null && !Array.isArray(input.lease)
    ? (input.lease as Record<string, unknown>).id
    : undefined;
  if (direct !== undefined && legacy !== undefined && direct !== legacy) throw new Error("Conflicting lease references.");
  const id = direct ?? legacy;
  if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) throw new Error("Invalid lease reference.");
  return id;
}

function authoritativeInput(input: ControlledInvocationInput, lease: CapabilityLease): ControlledInvocationInput {
  return { ...input, taskId: lease.taskId, role: lease.role };
}

function leaseLoadDecision(error: unknown): PolicyDecision {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (code === "LEASE_NOT_FOUND") return deniedDecision("LEASE_NOT_FOUND", "The referenced lease was not issued in this workspace.");
    if (code === "LEASE_INVALID" || code === "SCHEMA_INVALID") return deniedDecision("LEASE_INVALID", "The persisted lease is invalid.");
    if (code === "LEASE_USAGE_INVALID") return deniedDecision("LEASE_USAGE_INVALID", "Persisted lease usage is invalid.");
  }
  return deniedDecision("INVOCATION_FAILED", "The invocation could not be admitted.");
}
