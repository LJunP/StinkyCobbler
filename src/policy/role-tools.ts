import type { CapabilityLease, PolicyDecision } from "../contracts/types.js";

/** Internal orchestration workers derive tools from an active, attempt-bound subtask. */
export const ORCHESTRATION_WORKER_ROLE = "worker";

/** Maps a concrete MCP operation to the role-policy tool that authorizes it. */
export function roleToolForOperation(operation: string): string {
  if (operation === "repository-delete") return "repository-write";
  if (operation === "docs-index-build" || operation === "docs-index-read") return "docs-index";
  return operation;
}

/** A Lease capability can cover several narrower concrete operations. */
export function leaseCapabilityCoversOperation(capability: string, operation: string): boolean {
  const requiredTool = roleToolForOperation(operation);
  return capability === requiredTool ||
    (capability === "repository-read" && (requiredTool === "repository-read" || requiredTool === "repository-list"));
}

/** Use-time role gate for persisted Leases. */
export function evaluateLeaseRoleTool(
  lease: CapabilityLease,
  operation: string,
  roleTools: Record<string, string[]>
): PolicyDecision {
  if (!leaseCapabilityCoversOperation(lease.capability, operation)) {
    return denied("LEASE_OPERATION_CAPABILITY_MISMATCH", "The Lease capability does not cover the requested operation.");
  }
  if (lease.role === ORCHESTRATION_WORKER_ROLE) {
    const boundWorker = lease.subtaskRef !== undefined && Number.isSafeInteger(lease.subtaskAttempt) &&
      lease.parentGrantRef.startsWith("contract-") && lease.issuedBy === "orchestration-derived";
    return boundWorker
      ? allowed()
      : denied("LEASE_WORKER_BINDING_INVALID", "The internal worker role requires an orchestration-derived, attempt-bound subtask Lease.");
  }
  const permitted = roleTools[lease.role];
  if (!Array.isArray(permitted)) {
    return denied("LEASE_ROLE_TOOLS_UNAVAILABLE", "The Lease role has no explicit role-to-tools policy entry.");
  }
  const requiredTool = roleToolForOperation(operation);
  return permitted.includes(requiredTool)
    ? allowed()
    : denied("LEASE_ROLE_TOOL_DENIED", "The role-to-tools policy does not grant the requested operation.");
}

function allowed(): PolicyDecision {
  return { allowed: true, code: "ALLOWED", reasons: [], policyVersion: "1" };
}
function denied(code: string, reason: string): PolicyDecision {
  return { allowed: false, code, reasons: [reason], policyVersion: "1" };
}
