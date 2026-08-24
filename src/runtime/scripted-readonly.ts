import { createHash, randomBytes, randomUUID } from "node:crypto";
import { assertRunOwner } from "../storage/runs.js";
import type { AgentReceipt, AgentRun, EvidenceRef, RoleRegistry, TaskCapsule, ToolCallRecord } from "../contracts/types.js";
import { BudgetSupervisor } from "./budget.js";
import { SchemaRegistry } from "../contracts/schema-registry.js";
import { admitReadonlyRuntime, type RuntimeAdmission } from "./admission.js";
import { admitAndReserveLeaseCall } from "../storage/lease-usage.js";
import { ExitCode, StinkyCobblerError } from "../errors.js";
import { hashRuntimeExecutionRequest } from "./execution-request.js";

export interface ScriptedToolRequest { tool: string; input: Record<string, unknown>; }
export interface RuntimeToolBroker { call(request: ScriptedToolRequest, context: RuntimeAdmission & { run: AgentRun; signal: AbortSignal; recordEvidence?: (evidence: EvidenceRef) => Promise<void> }): Promise<ToolCallRecord>; }

export interface ScriptedReadonlyInput {
  root: string;
  task: unknown;
  capsule: unknown;
  lease: unknown;
  schemas: SchemaRegistry;
  roles: RoleRegistry;
  roleTools: Record<string, string[]>;
  requests: ScriptedToolRequest[];
  broker: RuntimeToolBroker;
  supervisor?: BudgetSupervisor;
  ownerToken?: string;
  fenceEpoch?: number;
  recordEvidence?: (evidence: EvidenceRef) => Promise<void>;
  onRunCreated?: (run: AgentRun) => Promise<void> | void;
  onProgress?: (run: AgentRun) => Promise<void> | void;
  beforeRequest?: () => Promise<RuntimeAdmission | void> | RuntimeAdmission | void;
}

export interface ReadonlyRunResult { run: AgentRun; receipt: AgentReceipt; }

export async function runScriptedReadonly(input: ScriptedReadonlyInput): Promise<ReadonlyRunResult> {
  let admission = await admitReadonlyRuntime({ root: input.root, task: input.task, capsule: input.capsule, lease: input.lease, schemas: input.schemas, roles: input.roles, roleTools: input.roleTools });
  const capsule = admission.capsule;
  const executionRequestHash = hashRuntimeExecutionRequest(capsule, "scripted-readonly", input.requests);
  const now = new Date().toISOString();
  const ownerToken = input.ownerToken ?? randomBytes(32).toString("hex");
  const fenceEpoch = input.fenceEpoch ?? 0;
  const run: AgentRun = {
    version: 1, runId: capsule.runId, capsuleId: capsule.capsuleId, taskId: capsule.taskId, agentId: capsule.agentId,
    role: capsule.role, workspaceId: capsule.workspaceId, leaseId: capsule.leaseId, policyVersion: admission.lease.policyVersion, executionRequestHash,
    status: "RUNNING", executor: "scripted-readonly", ownerToken, fenceEpoch, budget: capsule.budget, budgetUsage: { toolCalls: 0, files: 0, bytes: 0 }, createdAt: now, startedAt: now, toolCalls: [], evidenceRefs: [], events: []
  };
  const supervisor = input.supervisor ?? new BudgetSupervisor(capsule.budget);
  try {
    await input.onRunCreated?.(run);
    const receipts: string[] = [];
    let inFlightSideEffectsUncertain = false;
    try {
      for (const request of input.requests) {
        const refreshed = await input.beforeRequest?.();
        admission = refreshed ?? await admitReadonlyRuntime({ root: input.root, task: input.task, capsule: input.capsule, lease: input.lease, schemas: input.schemas, roles: input.roles, roleTools: input.roleTools });
        if (input.onRunCreated !== undefined) {
          const currentOwner = await assertRunOwner(admission.workspace, run.runId, ownerToken, fenceEpoch);
          run.fenceEpoch = currentOwner.fenceEpoch ?? fenceEpoch;
        }
        const turn = supervisor.beginTurn();
        const callReservation = supervisor.reserveToolCall();
        let brokerStarted = false;
        try {
          supervisor.check();
          if (!capsule.allowedTools.includes(request.tool)) throw new Error("RUNTIME_TOOL_NOT_ALLOWED");
          const leaseAttempt = await admitAndReserveLeaseCall(
            admission.workspace,
            admission.lease.id,
            { taskId: admission.task.id, role: admission.capsule.role, capability: "repository-read", operation: request.tool, roleTools: input.roleTools },
            (stored) => input.schemas.validate("lease", stored)
          );
          if (!leaseAttempt.allowed) {
            throw new StinkyCobblerError(
              leaseAttempt.decision.code,
              ExitCode.POLICY_DENIED,
              leaseAttempt.decision.reasons[0] ?? "Runtime Lease attempt was denied."
            );
          }
          // The reservation reloads the Lease under the workspace lock. Re-run
          // the full Runtime admission if it changed between the refresh and the
          // atomic reservation, and always hand the authoritative object onward.
          if (JSON.stringify(leaseAttempt.lease) !== JSON.stringify(admission.lease)) {
            admission = await admitReadonlyRuntime({ root: input.root, task: input.task, capsule: input.capsule, lease: input.lease, schemas: input.schemas, roles: input.roles, roleTools: input.roleTools });
          } else {
            admission = { ...admission, lease: leaseAttempt.lease as typeof admission.lease };
          }
          brokerStarted = true;
          const call = await raceCancellation(input.broker.call(request, {
            ...admission,
            run,
            signal: supervisor.signal,
            ...(input.recordEvidence === undefined ? {} : { recordEvidence: input.recordEvidence })
          }), supervisor.signal);
          supervisor.check();
          run.toolCalls?.push(call);
          turn.commit();
          const usage = call.status === "COMPLETED"
            ? callReservation.commit({ ...(call.inputBytes === undefined ? {} : { bytes: call.inputBytes }), ...(call.fileLocators === undefined ? {} : { files: call.fileLocators }), ...(call.outputBytes === undefined ? {} : { outputBytes: call.outputBytes }) })
            : callReservation.commit();
          run.budgetUsage = usage;
          for (const ref of call.evidenceRefs ?? []) { run.evidenceRefs?.push(ref); receipts.push(ref); }
          await input.onProgress?.(run);
          if (call.status !== "COMPLETED") {
            const callCode = call.errorCode ?? "RUNTIME_TOOL_BLOCKED";
            if (isCancellationCode(callCode)) inFlightSideEffectsUncertain = true;
            run.status = callCode === "RUNTIME_DEADLINE_EXCEEDED"
              ? "TIMED_OUT"
              : callCode === "RUNTIME_CANCELLED"
                ? "CANCELLED"
                : call.status === "FAILED"
                  ? "FAILED"
                  : "BLOCKED";
            run.errorCode = callCode;
            run.blockedReason = call.blockedReason ?? `Readonly tool call ${call.id} did not complete.`;
            throw new Error(run.errorCode);
          }
        } catch (error) {
          const message = errorCode(error);
          if (brokerStarted && isCancellationCode(message)) inFlightSideEffectsUncertain = true;
          const rejectedBeforeBroker = !brokerStarted && message === "RUNTIME_TOOL_NOT_ALLOWED";
          if (brokerStarted || rejectedBeforeBroker) {
            try { turn.commit(); } catch { /* snapshot below preserves usage after an overrun/deadline */ }
            try { callReservation.commit(); } catch { /* snapshot below preserves usage after an overrun/deadline */ }
            run.budgetUsage = supervisor.snapshot();
          } else {
            callReservation.release();
            turn.release();
          }
          throw error;
        }
      }
      supervisor.check();
      run.status = "COMPLETED";
      run.finishedAt = new Date().toISOString();
      run.outputHash = digest(JSON.stringify({ toolCalls: run.toolCalls, evidenceRefs: run.evidenceRefs }));
    } catch (error: unknown) {
      const code = errorCode(error);
      if (run.status !== "BLOCKED" && run.status !== "FAILED") {
        run.errorCode = ["RUNTIME_BUDGET_EXCEEDED", "RUNTIME_DEADLINE_EXCEEDED", "RUNTIME_CANCELLED"].includes(code) ? code : "RUNTIME_EXECUTION_FAILED";
        run.status = code === "RUNTIME_DEADLINE_EXCEEDED" ? "TIMED_OUT" : code === "RUNTIME_CANCELLED" ? "CANCELLED" : "BLOCKED";
        run.blockedReason = "Readonly scripted execution did not complete.";
      } else {
        run.errorCode = run.errorCode ?? (code || "RUNTIME_EXECUTION_FAILED");
        run.blockedReason = run.blockedReason ?? "Readonly scripted execution did not complete.";
      }
      run.finishedAt = run.finishedAt ?? new Date().toISOString();
    }
    input.schemas.validate("agent-run", run);
    const receipt: AgentReceipt = {
      id: `runtime-receipt-${randomUUID()}`, taskId: run.taskId, role: run.role, status: run.status === "COMPLETED" ? "COMPLETED" : run.status === "FAILED" ? "FAILED" : "BLOCKED",
      facts: run.status === "COMPLETED" ? [{ statement: "Readonly scripted Agent run completed.", evidenceRefs: receipts }] : [],
      proposals: [],
      unknowns: run.status === "COMPLETED"
        ? []
        : [
            run.blockedReason ?? "Readonly run blocked.",
            ...(inFlightSideEffectsUncertain ? ["A Runtime tool call was in flight when execution stopped; whether side effects occurred before the cancellation fence is unknown."] : [])
          ],
      evidenceRefs: receipts,
      changedPaths: [], policyVersion: run.policyVersion, executionRequestHash, toolSummary: "Readonly scripted Agent run.", createdAt: run.finishedAt ?? now,
      runId: run.runId, capsuleId: run.capsuleId, leaseId: run.leaseId, agentId: run.agentId, executor: run.executor,
      ...(run.startedAt === undefined ? {} : { startedAt: run.startedAt }),
      ...(run.finishedAt === undefined ? {} : { finishedAt: run.finishedAt }),
      ...(run.budgetUsage === undefined ? {} : { budgetUsage: run.budgetUsage }),
      ...(run.toolCalls === undefined ? {} : { toolCalls: run.toolCalls }),
      ...(run.outputHash === undefined ? {} : { outputHash: run.outputHash }),
      ...(run.errorCode === undefined ? {} : { errorCode: run.errorCode }),
      ...(run.blockedReason === undefined ? {} : { blockedReason: run.blockedReason })
    };
    input.schemas.validate("receipt", receipt);
    return { run, receipt };
  } finally {
    if (input.supervisor === undefined) supervisor.dispose();
  }
}

function raceCancellation<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      cleanup();
      reject(abortError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => { cleanup(); resolve(value); },
      (error: unknown) => { cleanup(); reject(error); }
    );
  });
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("RUNTIME_CANCELLED");
}

function errorCode(error: unknown): string {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : error instanceof Error
      ? error.message
      : "";
}

function isCancellationCode(code: string): boolean {
  return code === "RUNTIME_CANCELLED" || code === "RUNTIME_DEADLINE_EXCEEDED";
}

function digest(value: string): string { return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`; }
