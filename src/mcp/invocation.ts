import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CapabilityLease, PolicyDecision } from "../contracts/types.js";
import { evaluateLease } from "../policy/evaluate.js";
import { appendLedgerEntry } from "../storage/ledger.js";
import { admitAndReserveLeaseCall, getLeaseCallUsage, reserveLeaseCall } from "../storage/lease-usage.js";
import { persistMcpAudit, listPendingAudits } from "../storage/audit-service.js";
import { recordReceipt } from "../storage/receipts.js";
import { WORKSPACE_CONFIG_FILE, loadWorkspaceConfig } from "../config/workspace.js";
import { loadRegistries } from "../config/registry.js";
import { openWorkspace, workspaceFile, type LocalWorkspace } from "../storage/workspace.js";
import type { SchemaRegistry } from "../contracts/schema-registry.js";
import type { ToolOutcome } from "./shared.js";

const degradedWorkspaces = new Set<string>();

export interface ControlledInvocationInput {
  lease: unknown;
  taskId: string;
  role: string;
  workspace: string;
}

export interface ControlledInvocationDependencies {
  openWorkspace: typeof openWorkspace;
  getLeaseCallUsage: typeof getLeaseCallUsage;
  reserveLeaseCall: typeof reserveLeaseCall;
  admitAndReserveLeaseCall?: typeof admitAndReserveLeaseCall;
  evaluateLease: typeof evaluateLease;
  recordReceipt: typeof recordReceipt;
  audit?: typeof persistMcpAudit;
  listPendingAudits: typeof listPendingAudits;
  appendLedgerEntry: typeof appendLedgerEntry;
  loadWorkspaceConfig?: (workspace: LocalWorkspace, schemas: SchemaRegistry) => Promise<void>;
}

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** Production config admission: schema plus cross-reference validation against built-in registries. */
async function admitWorkspaceConfig(workspace: LocalWorkspace, schemas: SchemaRegistry): Promise<void> {
  const registries = await loadRegistries(projectRoot, schemas);
  await loadWorkspaceConfig(workspace, schemas, registries);
}

const productionDependencies: ControlledInvocationDependencies = {
  openWorkspace,
  getLeaseCallUsage,
  reserveLeaseCall,
  admitAndReserveLeaseCall,
  evaluateLease,
  recordReceipt,
  audit: persistMcpAudit,
  listPendingAudits,
  appendLedgerEntry,
  loadWorkspaceConfig: admitWorkspaceConfig
};

/** Applies the v0.1.2 invocation protocol to every MCP capability except test-run. */
export async function invokeControlled(
  schemas: SchemaRegistry,
  input: ControlledInvocationInput,
  capability: string,
  run: (access: { lease: CapabilityLease; taskId: string; role: string; workspace: string }) => Promise<ToolOutcome<unknown>>,
  dependencies: ControlledInvocationDependencies = productionDependencies
): Promise<unknown> {
  const callId = `call-${randomUUID()}`;
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

  if (dependencies.loadWorkspaceConfig) {
    try {
      await dependencies.loadWorkspaceConfig(workspace, schemas);
    } catch (error: unknown) {
      const raw = error instanceof Error && error.message ? error.message : "The workspace configuration failed admission.";
      const reason = raw.slice(0, 200).replace(/[\x00-\x1f]/g, " ") || "The workspace configuration failed admission.";
      return denied("WORKSPACE_CONFIG_INVALID", reason);
    }
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

  let lease: CapabilityLease;
  try {
    schemas.validate("lease", input.lease);
    lease = input.lease as CapabilityLease;
  } catch {
    return finish(workspace, schemas, input, capability, "rejected", denied("LEASE_INVALID", "The supplied lease is invalid."), dependencies, callId);
  }

  try {
    if (dependencies.admitAndReserveLeaseCall) {
      const admission = await dependencies.admitAndReserveLeaseCall(workspace, lease, { taskId: input.taskId, role: input.role, capability });
      if (!admission.allowed) return finish(workspace, schemas, input, capability, "rejected", { decision: admission.decision }, dependencies, callId);
    } else {
      const used = await dependencies.getLeaseCallUsage(workspace, lease.id);
      const decision = dependencies.evaluateLease(lease, { taskId: input.taskId, role: input.role, workspace: input.workspace, capability, toolCallsUsed: used });
      if (!decision.allowed) return finish(workspace, schemas, input, capability, "rejected", { decision }, dependencies, callId);
      const reservation = await dependencies.reserveLeaseCall(workspace, lease.id, lease.maxToolCalls);
      if (!reservation.allowed) return finish(workspace, schemas, input, capability, "rejected", { decision: deniedDecision("LEASE_CALL_LIMIT", "Lease tool-call limit has been reached.") }, dependencies, callId);
    }
  } catch {
    return finish(workspace, schemas, input, capability, "failed", denied("INVOCATION_FAILED", "The invocation could not be admitted."), dependencies, callId);
  }

  try {
    const result = await run({ lease, taskId: input.taskId, role: input.role, workspace: input.workspace });
    return finish(workspace, schemas, input, capability, result.decision.allowed ? "completed" : "rejected", result, dependencies, callId);
  } catch {
    return finish(workspace, schemas, input, capability, "failed", denied("INVOCATION_FAILED", "The invocation failed."), dependencies, callId);
  }
}

export function isWorkspaceAuditDegraded(workspace: LocalWorkspace): boolean { return degradedWorkspaces.has(workspace.directory); }

async function finish(
  workspace: LocalWorkspace,
  schemas: SchemaRegistry,
  input: ControlledInvocationInput,
  capability: string,
  outcome: "completed" | "rejected" | "failed",
  result: unknown,
  dependencies: ControlledInvocationDependencies,
  callId: string
): Promise<unknown> {
  try {
    if (dependencies.audit) {
      await dependencies.audit(workspace, schemas, { callId, taskId: input.taskId, role: input.role, tool: capability, outcome });
    } else {
      const receiptId = `mcp-${randomUUID()}`;
      await dependencies.recordReceipt(workspace, schemas, {
        id: receiptId, taskId: input.taskId, role: input.role,
        status: outcome === "completed" ? "COMPLETED" : outcome === "rejected" ? "BLOCKED" : "FAILED",
        facts: [], proposals: [], unknowns: [], evidenceRefs: [], policyVersion: "1",
        toolSummary: outcome === "completed" ? "MCP workspace capability completed." : outcome === "rejected" ? "MCP workspace capability denied." : "MCP workspace capability failed.",
        createdAt: new Date().toISOString()
      });
      await dependencies.appendLedgerEntry(workspace, {
        event: "mcp-call", taskId: input.taskId, role: input.role, policyVersion: "1", tool: capability,
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

function denied(code: string, reason: string): { decision: PolicyDecision } { return { decision: deniedDecision(code, reason) }; }
function deniedDecision(code: string, reason: string): PolicyDecision { return { allowed: false, code, reasons: [reason], policyVersion: "1" }; }
