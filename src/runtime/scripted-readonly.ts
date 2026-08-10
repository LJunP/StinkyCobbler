import { createHash, randomBytes, randomUUID } from "node:crypto";
import { assertRunOwner } from "../storage/runs.js";
import type { AgentReceipt, AgentRun, EvidenceRef, RoleRegistry, TaskCapsule, ToolCallRecord } from "../contracts/types.js";
import { BudgetSupervisor } from "./budget.js";
import { SchemaRegistry } from "../contracts/schema-registry.js";
import { admitReadonlyRuntime, type RuntimeAdmission } from "./admission.js";

export interface ScriptedToolRequest { tool: string; input: Record<string, unknown>; }
export interface RuntimeToolBroker { call(request: ScriptedToolRequest, context: RuntimeAdmission & { run: AgentRun; signal: AbortSignal; recordEvidence?: (evidence: EvidenceRef) => Promise<void> }): Promise<ToolCallRecord>; }

export interface ScriptedReadonlyInput {
  root: string;
  task: unknown;
  capsule: unknown;
  lease: unknown;
  schemas: SchemaRegistry;
  roles: RoleRegistry;
  requests: ScriptedToolRequest[];
  broker: RuntimeToolBroker;
  supervisor?: BudgetSupervisor;
  ownerToken?: string;
  fenceEpoch?: number;
  recordEvidence?: (evidence: EvidenceRef) => Promise<void>;
  onRunCreated?: (run: AgentRun) => Promise<void> | void;
  beforeRequest?: () => Promise<void> | void;
}

export interface ReadonlyRunResult { run: AgentRun; receipt: AgentReceipt; }

export async function runScriptedReadonly(input: ScriptedReadonlyInput): Promise<ReadonlyRunResult> {
  const admission = await admitReadonlyRuntime({ root: input.root, task: input.task, capsule: input.capsule, lease: input.lease, schemas: input.schemas, roles: input.roles });
  const capsule = admission.capsule;
  const now = new Date().toISOString();
  const ownerToken = input.ownerToken ?? randomBytes(32).toString("hex");
  const fenceEpoch = input.fenceEpoch ?? 0;
  const run: AgentRun = {
    version: 1, runId: capsule.runId, capsuleId: capsule.capsuleId, taskId: capsule.taskId, agentId: capsule.agentId,
    role: capsule.role, workspaceId: capsule.workspaceId, leaseId: capsule.leaseId, policyVersion: capsule.policyVersion,
    status: "RUNNING", executor: "scripted-readonly", ownerToken, fenceEpoch, budget: capsule.budget, budgetUsage: { toolCalls: 0, files: 0, bytes: 0 }, createdAt: now, startedAt: now, toolCalls: [], evidenceRefs: [], events: []
  };
  const supervisor = input.supervisor ?? new BudgetSupervisor(capsule.budget);
  await input.onRunCreated?.(run);
  const receipts: string[] = [];
  try {
    for (const request of input.requests) {
      await input.beforeRequest?.();
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
        brokerStarted = true;
        const call = await raceCancellation(input.broker.call(request, {
          ...admission,
          run,
          signal: supervisor.signal,
          ...(input.recordEvidence === undefined ? {} : { recordEvidence: input.recordEvidence })
        }), supervisor.signal);
        run.toolCalls?.push(call);
        turn.commit();
        const usage = call.status === "COMPLETED"
          ? callReservation.commit({ ...(call.inputBytes === undefined ? {} : { bytes: call.inputBytes }), ...(call.fileLocators === undefined ? {} : { files: call.fileLocators }), ...(call.outputBytes === undefined ? {} : { outputBytes: call.outputBytes }) })
          : callReservation.commit();
        run.budgetUsage = usage;
        if (call.status !== "COMPLETED") {
          run.status = call.status === "FAILED" ? "FAILED" : "BLOCKED";
          run.errorCode = call.errorCode ?? "RUNTIME_TOOL_BLOCKED";
          run.blockedReason = call.blockedReason ?? `Readonly tool call ${call.id} did not complete.`;
          throw new Error(run.errorCode);
        }
        for (const ref of call.evidenceRefs ?? []) { run.evidenceRefs?.push(ref); receipts.push(ref); }
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
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
    run.status = "COMPLETED";
    run.finishedAt = new Date().toISOString();
    run.outputHash = digest(JSON.stringify({ toolCalls: run.toolCalls, evidenceRefs: run.evidenceRefs }));
  } catch (error: unknown) {
    const code = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : error instanceof Error ? error.message : "";
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
    facts: run.status === "COMPLETED" ? [{ statement: "Readonly scripted Agent run completed.", evidenceRefs: receipts }] : [], proposals: [], unknowns: run.status === "COMPLETED" ? [] : [run.blockedReason ?? "Readonly run blocked."], evidenceRefs: receipts,
    changedPaths: [], policyVersion: run.policyVersion, toolSummary: "Readonly scripted Agent run.", createdAt: run.finishedAt ?? now,
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
}

function raceCancellation<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("RUNTIME_CANCELLED"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("RUNTIME_CANCELLED"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).then(() => signal.removeEventListener("abort", onAbort), () => signal.removeEventListener("abort", onAbort));
  });
}

function digest(value: string): string { return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`; }
