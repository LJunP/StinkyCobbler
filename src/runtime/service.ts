import { randomBytes } from "node:crypto";
import type { CapabilityLease, TaskCapsule, TaskCharter, AgentRun, AgentReceipt } from "../contracts/types.js";
import type { SchemaRegistry } from "../contracts/schema-registry.js";
import type { Registries } from "../config/registry.js";
import { recordReceipt, listReceipts } from "../storage/receipts.js";
import { withWorkspaceLock } from "../storage/workspace-lock.js";
import { recordEvidenceOwned } from "../storage/evidence.js";
import { createRun, getRun, transitionRun, heartbeatRun, assertRunOwner, TERMINAL_RUN_STATUSES } from "../storage/runs.js";
import { openWorkspace } from "../storage/workspace.js";
import { admitReadonlyRuntime } from "./admission.js";
import { ReadonlyToolBroker } from "./tool-broker.js";
import type { ScriptedToolRequest } from "./scripted-readonly.js";
import { ExitCode, StinkyCobblerError } from "../errors.js";
import { createAdapterRegistry } from "./adapters.js";
import { BudgetSupervisor } from "./budget.js";

const activeSupervisors = new Map<string, BudgetSupervisor>();
function supervisorKey(root: string, runId: string): string { return `${root}\0${runId}`; }

/** Best-effort liveness throttle: write a run heartbeat at most every 30s. */
const HEARTBEAT_INTERVAL_MS = 30_000;
const lastHeartbeats = new Map<string, number>();
function shouldHeartbeat(key: string): boolean {
  const last = lastHeartbeats.get(key);
  const now = performance.now();
  if (last === undefined || now - last >= HEARTBEAT_INTERVAL_MS) {
    lastHeartbeats.set(key, now);
    return true;
  }
  return false;
}

export async function validateRuntime(input: { root: string; task: unknown; capsule: unknown; lease: unknown; schemas: SchemaRegistry; registries: Registries }) {
  const admission = await admitReadonlyRuntime({ ...input, roles: input.registries.roles });
  return { valid: true, taskId: admission.task.id, runId: admission.capsule.runId, role: admission.capsule.role, executionAuthorized: false, mode: "readonly" };
}

export async function executeReadonlyRuntime(input: { root: string; task: TaskCharter; capsule: TaskCapsule; lease: CapabilityLease; requests: ScriptedToolRequest[]; schemas: SchemaRegistry; registries: Registries; executor?: string; beforeFinalTransition?: (run: AgentRun) => Promise<void> }) {
  const executor = input.executor ?? "scripted-readonly";
  const adapter = createAdapterRegistry().resolve(executor);
  const admission = await admitReadonlyRuntime({ ...input, roles: input.registries.roles });
  const workspace = admission.workspace;
  const existingRun = await getRun(workspace, admission.capsule.runId).catch((error: unknown) => {
    if (error instanceof StinkyCobblerError && error.code === "RUNTIME_RUN_NOT_FOUND") return undefined;
    throw error;
  });
  if (existingRun !== undefined) {
    throw new StinkyCobblerError("RUNTIME_RUN_EXISTS", ExitCode.POLICY_DENIED, "An Agent run with this ID already exists.", { runId: admission.capsule.runId, status: existingRun.status });
  }
  const key = supervisorKey(workspace.root, admission.capsule.runId);
  if (activeSupervisors.has(key)) {
    throw new StinkyCobblerError("RUNTIME_RUN_ACTIVE", ExitCode.POLICY_DENIED, "An Agent run with this ID is already executing.", { runId: admission.capsule.runId });
  }
  const supervisor = new BudgetSupervisor(admission.capsule.budget);
  activeSupervisors.set(key, supervisor);
  const ownerToken = randomBytes(32).toString("hex");
  const fenceEpoch = 0;
  let persisted = false;
  try {
    const result = await adapter.executeReadonly({
      ...input,
      roles: input.registries.roles,
      broker: new ReadonlyToolBroker(),
      recordEvidence: async (evidence) => { await recordEvidenceOwned(workspace, input.schemas, evidence, { runId: admission.capsule.runId, ownerToken, expectedEpoch: fenceEpoch }); },
      ownerToken,
      fenceEpoch,
      onRunCreated: async (run) => {
        await createRun(workspace, { ...run, ownerToken, fenceEpoch });
        persisted = true;
      },
      beforeRequest: async () => {
        const stored = await getRun(workspace, input.capsule.runId);
        if (stored.status === "CANCELLED") supervisor.cancel();
        // Best-effort liveness: failures must not block the request itself.
        if (shouldHeartbeat(key) && !isTerminalRun(stored)) {
          await heartbeatRun(workspace, input.capsule.runId, { ownerToken, expectedEpoch: fenceEpoch }).catch(() => undefined);
        }
      }    });
    let authoritativeRun: AgentRun;
    if (persisted) {
      const stored = await getRun(workspace, result.run.runId);
      if (!isTerminalRun(stored)) await input.beforeFinalTransition?.(stored);
      if (isTerminalRun(stored)) {
        // A persisted terminal state is the authority when cancellation or
        // explicit stale recovery wins a race with in-memory execution.
        authoritativeRun = stored;
      } else {
        try {
          authoritativeRun = await transitionRun(workspace, result.run.runId, result.run.status, {
            ...(result.run.errorCode === undefined ? {} : { errorCode: result.run.errorCode }),
            ...(result.run.blockedReason === undefined ? {} : { blockedReason: result.run.blockedReason }),
            ...(result.run.finishedAt === undefined ? {} : { finishedAt: result.run.finishedAt }),
            ...(result.run.budgetUsage === undefined ? {} : { budgetUsage: result.run.budgetUsage }),
            ...(result.run.toolCalls === undefined ? {} : { toolCalls: result.run.toolCalls }),
            ...(result.run.evidenceRefs === undefined ? {} : { evidenceRefs: result.run.evidenceRefs }),
            ...(result.run.outputHash === undefined ? {} : { outputHash: result.run.outputHash })
          }, { ownerToken, expectedEpoch: fenceEpoch, expectedStatus: "RUNNING" });
        } catch (error: unknown) {
          const latest = await getRun(workspace, result.run.runId).catch(() => undefined);
          if (latest === undefined || !isTerminalRun(latest)) throw error;
          authoritativeRun = latest;
        }
      }
      result.run = authoritativeRun;
      reconcileReceiptToRun(result.receipt, authoritativeRun);
    } else {
      await createRun(workspace, result.run);
      authoritativeRun = result.run;
    }
    result.receipt = await finalizeRuntimeReceipt(workspace, input.schemas, result.receipt, authoritativeRun);
    return result;
  } finally {
    if (activeSupervisors.get(key) === supervisor) activeSupervisors.delete(key);
  }
}

function reconcileReceiptToRun(receipt: AgentReceipt, run: AgentRun): void {
  const completed = run.status === "COMPLETED";
  receipt.status = completed ? "COMPLETED" : run.status === "FAILED" ? "FAILED" : "BLOCKED";
  receipt.facts = completed ? receipt.facts : [];
  receipt.evidenceRefs = run.evidenceRefs ?? [];
  receipt.toolCalls = run.toolCalls ?? [];
  if (run.budgetUsage === undefined) delete receipt.budgetUsage; else receipt.budgetUsage = run.budgetUsage;
  if (run.outputHash === undefined) delete receipt.outputHash; else receipt.outputHash = run.outputHash;
  if (run.errorCode === undefined) delete receipt.errorCode; else receipt.errorCode = run.errorCode;
  if (run.blockedReason === undefined) delete receipt.blockedReason; else receipt.blockedReason = run.blockedReason;
  if (run.finishedAt === undefined) delete receipt.finishedAt; else receipt.finishedAt = run.finishedAt;
}

async function finalizeRuntimeReceipt(
  workspace: Awaited<ReturnType<typeof openWorkspace>>,
  schemas: SchemaRegistry,
  candidate: AgentReceipt,
  run: AgentRun
): Promise<AgentReceipt> {
  return withWorkspaceLock(workspace, async () => {
    const associated = (await listReceipts(workspace)).filter((receipt) => receipt.runId === run.runId);
    if (associated.length > 1) {
      throw new StinkyCobblerError("RUNTIME_RECEIPT_CONFLICT", ExitCode.POLICY_DENIED, "Multiple Receipts already exist for this Agent run.", { runId: run.runId, receiptIds: associated.map((receipt) => receipt.id) });
    }
    if (associated.length === 1) return associated[0] as unknown as AgentReceipt;
    await recordReceipt(workspace, schemas, candidate as unknown as Record<string, unknown>);
    return candidate;
  });
}

function isTerminalRun(run: AgentRun): boolean {
  return TERMINAL_RUN_STATUSES.includes(run.status as (typeof TERMINAL_RUN_STATUSES)[number]);
}
export async function cancelRuntime(root: string, runId: string, schemas: SchemaRegistry) {
  const workspace = await openWorkspace(root);
  const run = await getRun(workspace, runId);
  if (["COMPLETED", "BLOCKED", "FAILED", "TIMED_OUT", "CANCELLED"].includes(run.status)) {
    throw new StinkyCobblerError("RUNTIME_RUN_TERMINAL", ExitCode.POLICY_DENIED, "Terminal Agent runs cannot be cancelled.", { runId, status: run.status });
  }
  const active = activeSupervisors.get(supervisorKey(workspace.root, runId));
  const cancelled = await transitionRun(workspace, runId, "CANCELLED", {
    errorCode: "RUNTIME_CANCELLED",
    blockedReason: "Readonly run cancellation requested.",
    finishedAt: new Date().toISOString()
  });
  active?.cancel();
  return active ? { runId, status: "CANCEL_REQUESTED" as const } : cancelled;
}
