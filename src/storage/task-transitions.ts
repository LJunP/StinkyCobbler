import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { defaultSchemaRegistry } from "../contracts/default-schema-registry.js";
import type { SchemaRegistry } from "../contracts/schema-registry.js";
import type { TaskCharter, TaskState } from "../contracts/types.js";
import { assertTransition } from "../domain/task-state.js";
import { ExitCode, StinkyCobblerError } from "../errors.js";
import { consumeApproval, getApproval } from "./approvals.js";
import { getEvidence } from "./evidence.js";
import { getLease } from "./leases.js";
import { appendLedgerEntry, listLedgerEntries, prepareLedgerEntry, type AppendLedgerEntry } from "./ledger.js";
import { assertRuntimeReceiptMatchesRun, getReceipt } from "./receipts.js";
import { assertRuntimeFinalizationCommitted } from "./runtime-finalization.js";
import { getRun } from "./runs.js";
import { admitPersistedLeaseAuthority, admitTaskExecutionApproval, hashTaskAuthority } from "./task-authority.js";
import { getTask } from "./tasks.js";
import type { LocalWorkspace } from "./workspace.js";
import { createWorkspaceDirectory, createWorkspaceJson, workspaceFile, writeWorkspaceJson } from "./workspace.js";
import { withWorkspaceLock } from "./workspace-lock.js";

const TRANSACTION_DIRECTORY = "task-transitions";
const TRANSACTION_FILE_PREFIX = "transaction-";
const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;

export type TaskTransitionTransactionStatus = "PREPARED" | "COMMITTED" | "ABORTED";
export type TaskTransitionFaultPoint = "after-prepare" | "after-consume" | "after-task" | "after-ledger";

export interface TaskTransitionOptions {
  approvalRef?: string;
  hostSessionId?: string;
  receiptRef?: string;
  evidenceRefs?: string[];
  reason?: string;
}

interface TaskTransitionRequest {
  taskId: string;
  to: TaskState;
  approvalRef?: string;
  hostSessionId?: string;
  receiptRef?: string;
  evidenceRefs?: string[];
  reasonHash?: string;
}

export interface TaskTransitionTransaction {
  version: 1;
  transactionId: string;
  status: TaskTransitionTransactionStatus;
  request: TaskTransitionRequest;
  requestHash: string;
  taskId: string;
  sourceTaskHash: string;
  sourceTask: TaskCharter;
  nextTaskHash: string;
  nextTask: TaskCharter;
  approvalConsumptionOwner?: string;
  ledgerEffect: AppendLedgerEntry;
  preparedAt: string;
  updatedAt: string;
  committedAt?: string;
  abortedAt?: string;
  abortCode?: string;
}

const injectedFaults = new Map<string, TaskTransitionFaultPoint>();

export async function transitionTask(
  workspace: LocalWorkspace,
  schemas: SchemaRegistry,
  taskId: string,
  to: TaskState,
  options: TaskTransitionOptions = {}
): Promise<TaskCharter> {
  return withWorkspaceLock(workspace, async () => {
    const request = normalizeRequest(taskId, to, options);
    const requestHash = recordHash(request);
    const existingTransactions = await listTaskTransitionTransactions(workspace, taskId);
    const preparedTransactions = existingTransactions.filter((transaction) => transaction.status === "PREPARED");
    if (preparedTransactions.length > 1) {
      throw transitionError("TASK_TRANSITION_TRANSACTION_CONFLICT", "Multiple PREPARED Task transitions exist for one Task; recovery is ambiguous and fails closed.", {
        taskId, transactionIds: preparedTransactions.map((transaction) => transaction.transactionId)
      });
    }
    const prepared = preparedTransactions[0];
    if (prepared !== undefined) {
      if (prepared.requestHash !== requestHash) {
        throw transitionError("TASK_TRANSITION_TRANSACTION_CONFLICT", "A different Task transition is already PREPARED and must be recovered with its exact request.", {
          taskId, transactionId: prepared.transactionId, requestedTo: to, preparedTo: prepared.request.to
        });
      }
      return (await reconcileTaskTransitionTransaction(workspace, schemas, prepared.transactionId)).nextTask;
    }

    const current = await getTask(workspace, taskId);
    const committed = [...existingTransactions].reverse().find((transaction) =>
      transaction.status === "COMMITTED" && transaction.requestHash === requestHash && transaction.nextTaskHash === recordHash(current)
    );
    if (committed !== undefined) return current;

    assertTransition(current.state, to);
    const authorityGeneration = current.authorityGeneration;
    const legacyCancellation = authorityGeneration === undefined && to === "CANCELLED";
    if (!legacyCancellation && (!Number.isSafeInteger(authorityGeneration) || (authorityGeneration ?? -1) < 0 || authorityGeneration === Number.MAX_SAFE_INTEGER)) {
      throw transitionError("TASK_AUTHORITY_REISSUE_REQUIRED", "This legacy or exhausted Task remains readable but cannot transition; create a new Task under the current authority model.", { taskId });
    }
    const generationIdentity = legacyCancellation ? -1 : authorityGeneration as number;
    const nextAuthorityGeneration = legacyCancellation ? 0 : (authorityGeneration as number) + 1;

    const transactionId = taskTransitionTransactionId(taskId, generationIdentity, requestHash);
    const approvalConsumptionOwner = to === "APPROVED_FOR_EXECUTION"
      ? `task-transition:${taskId}:APPROVED_FOR_EXECUTION`
      : undefined;
    if (to === "APPROVED_FOR_EXECUTION") {
      if (options.approvalRef === undefined) throw transitionError("TASK_EXECUTION_APPROVAL_REQUIRED", "DESIGNED -> APPROVED_FOR_EXECUTION requires a precise task-execution Approval.", { taskId });
      await admitTaskExecutionApproval(workspace, current, options.approvalRef, options.hostSessionId ?? "local-cli", approvalConsumptionOwner);
    } else if (options.approvalRef !== undefined || options.hostSessionId !== undefined) {
      throw transitionError("TASK_TRANSITION_APPROVAL_UNUSED", "An Approval reference is accepted only for APPROVED_FOR_EXECUTION.", { taskId, to });
    }
    if (to === "CANCELLED") {
      if (options.reason === undefined || options.reason.trim().length === 0) throw transitionError("CANCEL_REASON_REQUIRED", "Task cancellation requires a non-empty reason.", { taskId });
    } else if (options.reason !== undefined) {
      throw transitionError("TASK_TRANSITION_REASON_UNUSED", "A reason is accepted only for cancellation.", { taskId, to });
    }

    let completion: Pick<TaskCharter, "completionReceiptRef" | "completionEvidenceRefs"> = {};
    if (to === "DONE") {
      completion = await assertRuntimeCompletion(workspace, current, options);
    } else if (options.receiptRef !== undefined || options.evidenceRefs !== undefined) {
      throw transitionError("TASK_COMPLETION_PROOF_UNUSED", "Receipt and Evidence references are accepted only for VERIFYING -> DONE.", { taskId, to });
    }

    const nextTask: TaskCharter = { ...current, ...completion, state: to, authorityGeneration: nextAuthorityGeneration };
    schemas.validate("task", nextTask);
    const ledgerEffect = taskTransitionLedgerEffect(transactionId, current, nextTask, request);
    const now = new Date().toISOString();
    const transaction: TaskTransitionTransaction = {
      version: 1,
      transactionId,
      status: "PREPARED",
      request,
      requestHash,
      taskId,
      sourceTaskHash: recordHash(current),
      sourceTask: current,
      nextTaskHash: recordHash(nextTask),
      nextTask,
      ...(approvalConsumptionOwner === undefined ? {} : { approvalConsumptionOwner }),
      ledgerEffect,
      preparedAt: now,
      updatedAt: now
    };
    schemas.validate("task-transition", transaction);
    assertTransactionBinding(transaction);
    await prepareTaskTransitionTransaction(workspace, schemas, transaction);
    maybeInjectFault(workspace, "after-prepare", transactionId);
    return (await reconcileTaskTransitionTransaction(workspace, schemas, transactionId)).nextTask;
  });
}

/** Replays a PREPARED Task transition without re-deriving already frozen authority/proof. */
export function reconcileTaskTransitionTransaction(
  workspace: LocalWorkspace,
  schemas: SchemaRegistry,
  transactionId: string
): Promise<TaskTransitionTransaction> {
  return withWorkspaceLock(workspace, async () => {
    let transaction = await getTaskTransitionTransaction(workspace, transactionId);
    schemas.validate("task-transition", transaction);
    assertTransactionBinding(transaction);
    const current = await getTask(workspace, transaction.taskId);
    const currentHash = recordHash(current);
    if (currentHash !== transaction.sourceTaskHash && currentHash !== transaction.nextTaskHash) {
      throw transitionError("TASK_TRANSITION_TARGET_CONFLICT", "The Task is neither the journaled source nor intended next state.", {
        taskId: transaction.taskId, transactionId, currentHash, sourceTaskHash: transaction.sourceTaskHash, nextTaskHash: transaction.nextTaskHash
      });
    }
    if (transaction.status === "COMMITTED" && currentHash !== transaction.nextTaskHash) {
      throw transitionError("TASK_TRANSITION_TARGET_CONFLICT", "A COMMITTED Task transition cannot be replayed onto its old source state.", {
        taskId: transaction.taskId, transactionId, currentHash, nextTaskHash: transaction.nextTaskHash
      });
    }
    if (transaction.status === "ABORTED") {
      throw transitionError("TASK_TRANSITION_TRANSACTION_ABORTED", "This Task transition was aborted after its source-side authority or proof became invalid; submit a fresh authorized transition.", {
        taskId: transaction.taskId,
        transactionId,
        abortCode: transaction.abortCode
      });
    }

    if (currentHash === transaction.sourceTaskHash) {
      try {
        if (transaction.request.approvalRef !== undefined) {
          const owner = transaction.approvalConsumptionOwner;
          if (owner === undefined) throw transitionError("TASK_TRANSITION_TRANSACTION_INVALID", "An approval-bound transaction lacks its consumption owner.", { transactionId });
          await admitTaskExecutionApproval(
            workspace,
            current,
            transaction.request.approvalRef,
            transaction.request.hostSessionId ?? "local-cli",
            owner
          );
        }
        if (transaction.request.to === "DONE") {
          await assertRuntimeCompletion(workspace, current, {
            ...(transaction.request.receiptRef === undefined ? {} : { receiptRef: transaction.request.receiptRef }),
            ...(transaction.request.evidenceRefs === undefined ? {} : { evidenceRefs: transaction.request.evidenceRefs })
          });
        }
      } catch (error: unknown) {
        await abortTaskTransitionTransaction(workspace, schemas, transaction, error);
        throw error;
      }
      if (transaction.request.approvalRef !== undefined) {
        const owner = transaction.approvalConsumptionOwner;
        if (owner === undefined) throw transitionError("TASK_TRANSITION_TRANSACTION_INVALID", "An approval-bound transaction lacks its consumption owner.", { transactionId });
        const approval = await getApproval(workspace, transaction.request.approvalRef);
        if (approval.consumedAt === undefined || approval.consumedBy !== owner) await consumeApproval(workspace, schemas, approval.id, owner);
        maybeInjectFault(workspace, "after-consume", transactionId);
      }
      await writeWorkspaceJson(workspace, taskFileName(transaction.taskId), transaction.nextTask);
      maybeInjectFault(workspace, "after-task", transactionId);
    }

    await appendLedgerEffectIdempotently(workspace, transaction);
    maybeInjectFault(workspace, "after-ledger", transactionId);

    if (transaction.status === "PREPARED") {
      const committedAt = new Date().toISOString();
      transaction = { ...transaction, status: "COMMITTED", updatedAt: committedAt, committedAt };
      schemas.validate("task-transition", transaction);
      assertTransactionBinding(transaction);
      await writeWorkspaceJson(workspace, transactionFile(transaction.transactionId), transaction);
    }
    return transaction;
  });
}

async function abortTaskTransitionTransaction(
  workspace: LocalWorkspace,
  schemas: SchemaRegistry,
  transaction: TaskTransitionTransaction,
  error: unknown
): Promise<void> {
  if (transaction.status !== "PREPARED") return;
  const abortedAt = new Date().toISOString();
  const abortCode = error instanceof StinkyCobblerError ? error.code : "TASK_TRANSITION_PROOF_REVALIDATION_FAILED";
  const aborted: TaskTransitionTransaction = {
    ...transaction,
    status: "ABORTED",
    updatedAt: abortedAt,
    abortedAt,
    abortCode
  };
  schemas.validate("task-transition", aborted);
  assertTransactionBinding(aborted);
  await writeWorkspaceJson(workspace, transactionFile(transaction.transactionId), aborted);
}

export async function getTaskTransitionTransaction(workspace: LocalWorkspace, transactionId: string): Promise<TaskTransitionTransaction> {
  assertTransactionId(transactionId);
  try {
    const parsed: unknown = JSON.parse(await readFile(await workspaceFile(workspace, transactionFile(transactionId)), "utf8"));
    (await defaultSchemaRegistry()).validate("task-transition", parsed);
    const transaction = parsed as TaskTransitionTransaction;
    if (transaction.transactionId !== transactionId) {
      throw transitionError("TASK_TRANSITION_TRANSACTION_ID_MISMATCH", "Stored Task transition transaction ID does not match its canonical lookup ID.", { transactionId, storedTransactionId: transaction.transactionId });
    }
    assertTransactionBinding(transaction);
    return transaction;
  } catch (error: unknown) {
    if (isCode(error, "ENOENT")) throw transitionError("TASK_TRANSITION_TRANSACTION_NOT_FOUND", "Task transition transaction does not exist.", { transactionId });
    if (error instanceof SyntaxError) throw transitionError("TASK_TRANSITION_TRANSACTION_INVALID", "Stored Task transition transaction contains invalid JSON.", { transactionId });
    throw error;
  }
}

export async function listTaskTransitionTransactions(workspace: LocalWorkspace, taskId?: string): Promise<TaskTransitionTransaction[]> {
  let names: string[];
  try { names = await readdir(await workspaceFile(workspace, TRANSACTION_DIRECTORY)); }
  catch (error: unknown) { if (isCode(error, "ENOENT")) return []; throw error; }
  const transactionNames = names.filter((name) => name.startsWith(TRANSACTION_FILE_PREFIX) && name.endsWith(".json"));
  const malformed = transactionNames.find((name) => !/^transaction-task-txn-[a-f0-9]{8}(?:-[a-f0-9]{8}){3}\.json$/.test(name));
  if (malformed !== undefined) throw transitionError("TASK_TRANSITION_TRANSACTION_FILENAME_INVALID", "A Task transition transaction has a non-canonical filename.", { filename: malformed });
  const values = await Promise.all(transactionNames.sort().map((name) => getTaskTransitionTransaction(workspace, name.slice(TRANSACTION_FILE_PREFIX.length, -5))));
  return taskId === undefined ? values : values.filter((transaction) => transaction.taskId === taskId);
}

export function injectTaskTransitionFaultForTesting(workspace: LocalWorkspace, point: TaskTransitionFaultPoint): void {
  injectedFaults.set(workspace.directory, point);
}

async function prepareTaskTransitionTransaction(workspace: LocalWorkspace, schemas: SchemaRegistry, transaction: TaskTransitionTransaction): Promise<TaskTransitionTransaction> {
  await createWorkspaceDirectory(workspace, TRANSACTION_DIRECTORY);
  try {
    await createWorkspaceJson(workspace, transactionFile(transaction.transactionId), transaction);
    return transaction;
  } catch (error: unknown) {
    if (!isCode(error, "EEXIST")) throw error;
    const existing = await getTaskTransitionTransaction(workspace, transaction.transactionId);
    schemas.validate("task-transition", existing);
    if (existing.requestHash !== transaction.requestHash || existing.sourceTaskHash !== transaction.sourceTaskHash || existing.nextTaskHash !== transaction.nextTaskHash) {
      throw transitionError("TASK_TRANSITION_TRANSACTION_CONFLICT", "The deterministic Task transition transaction ID is already bound to different content.", { transactionId: transaction.transactionId });
    }
    return existing;
  }
}

async function appendLedgerEffectIdempotently(workspace: LocalWorkspace, transaction: TaskTransitionTransaction): Promise<void> {
  const marker = ledgerMarker(transaction.transactionId);
  const existing = (await listLedgerEntries(workspace)).filter((entry) => entry.summary.includes(marker));
  if (existing.length > 1) throw transitionError("TASK_TRANSITION_LEDGER_CONFLICT", "A Task transition transaction has duplicate ledger effects.", { transactionId: transaction.transactionId, count: existing.length });
  if (existing.length === 1) {
    const entry = existing[0]!;
    const effect = transaction.ledgerEffect;
    if (entry.event !== effect.event || entry.taskId !== effect.taskId || entry.summary !== effect.summary || entry.approvalRef !== effect.approvalRef || entry.receiptRef !== effect.receiptRef) {
      throw transitionError("TASK_TRANSITION_LEDGER_CONFLICT", "A Task transition ledger marker is bound to a different effect.", { transactionId: transaction.transactionId });
    }
    return;
  }
  await appendLedgerEntry(workspace, transaction.ledgerEffect);
}

function taskTransitionLedgerEffect(transactionId: string, current: TaskCharter, next: TaskCharter, request: TaskTransitionRequest): AppendLedgerEntry {
  const marker = ledgerMarker(transactionId);
  return prepareLedgerEntry(next.state === "CANCELLED"
    ? { event: "task-cancelled", taskId: current.id, summary: `Task cancelled; reason ${auditFingerprintFromReasonHash(request.reasonHash!)}. ${marker}` }
    : {
        event: "task-transitioned", taskId: current.id,
        ...(request.approvalRef === undefined ? {} : { approvalRef: request.approvalRef }),
        ...(request.receiptRef === undefined ? {} : { receiptRef: request.receiptRef }),
        summary: `Task transitioned from ${current.state} to ${next.state}. ${marker}`
      });
}

function normalizeRequest(taskId: string, to: TaskState, options: TaskTransitionOptions): TaskTransitionRequest {
  const evidenceRefs = options.evidenceRefs === undefined ? undefined : [...options.evidenceRefs].sort();
  return {
    taskId, to,
    ...(options.approvalRef === undefined ? {} : { approvalRef: options.approvalRef, hostSessionId: options.hostSessionId ?? "local-cli" }),
    ...(options.receiptRef === undefined ? {} : { receiptRef: options.receiptRef }),
    ...(evidenceRefs === undefined ? {} : { evidenceRefs }),
    ...(options.reason === undefined ? {} : { reasonHash: digest(options.reason) })
  };
}

function taskTransitionTransactionId(taskId: string, generation: number, requestHash: string): string {
  const value = createHash("sha256").update(`${taskId}\0${generation}\0${requestHash}`, "utf8").digest("hex").slice(0, 32);
  return `task-txn-${value.match(/.{8}/g)!.join("-")}`;
}
function taskFileName(taskId: string): string { return `task-${taskId}.json`; }
function transactionFile(transactionId: string): string { return path.join(TRANSACTION_DIRECTORY, `${TRANSACTION_FILE_PREFIX}${transactionId}.json`); }
function ledgerMarker(transactionId: string): string { return `[task-transition-txn:${transactionId}]`; }

function assertTransactionBinding(transaction: TaskTransitionTransaction): void {
  assertTransactionId(transaction.transactionId);
  const generation = transaction.sourceTask.authorityGeneration;
  const legacyCancellation = generation === undefined && transaction.request.to === "CANCELLED";
  if (!legacyCancellation && (!Number.isSafeInteger(generation) || (generation ?? -1) < 0 || generation === Number.MAX_SAFE_INTEGER)) {
    throw transitionError("TASK_TRANSITION_TRANSACTION_BINDING_MISMATCH", "Task transition source generation is invalid.", { transactionId: transaction.transactionId });
  }
  const generationIdentity = legacyCancellation ? -1 : generation as number;
  const nextAuthorityGeneration = legacyCancellation ? 0 : (generation as number) + 1;
  if ((transaction.request.to === "CANCELLED") !== (transaction.request.reasonHash !== undefined)) {
    throw transitionError("TASK_TRANSITION_TRANSACTION_BINDING_MISMATCH", "Task transition reason binding does not match its target state.", { transactionId: transaction.transactionId });
  }
  if ((transaction.request.to === "APPROVED_FOR_EXECUTION") !== (transaction.request.approvalRef !== undefined)) {
    throw transitionError("TASK_TRANSITION_TRANSACTION_BINDING_MISMATCH", "Task transition Approval binding does not match its target state.", { transactionId: transaction.transactionId });
  }
  if ((transaction.request.approvalRef === undefined) !== (transaction.request.hostSessionId === undefined)) {
    throw transitionError("TASK_TRANSITION_TRANSACTION_BINDING_MISMATCH", "Task transition host-session binding does not match its Approval.", { transactionId: transaction.transactionId });
  }
  if ((transaction.request.to === "DONE") !== (transaction.request.receiptRef !== undefined || transaction.request.evidenceRefs !== undefined)) {
    throw transitionError("TASK_TRANSITION_TRANSACTION_BINDING_MISMATCH", "Task transition completion binding does not match its target state.", { transactionId: transaction.transactionId });
  }
  const expectedNext: TaskCharter = {
    ...transaction.sourceTask,
    ...(transaction.request.to === "DONE" ? {
      completionReceiptRef: transaction.request.receiptRef,
      completionEvidenceRefs: transaction.request.evidenceRefs
    } : {}),
    state: transaction.request.to,
    authorityGeneration: nextAuthorityGeneration
  };
  const expectedLedgerEffect = taskTransitionLedgerEffect(transaction.transactionId, transaction.sourceTask, transaction.nextTask, transaction.request);
  if (
    transaction.taskId !== transaction.request.taskId || transaction.sourceTask.id !== transaction.taskId || transaction.nextTask.id !== transaction.taskId ||
    transaction.requestHash !== recordHash(transaction.request) || transaction.sourceTaskHash !== recordHash(transaction.sourceTask) || transaction.nextTaskHash !== recordHash(transaction.nextTask) ||
    transaction.transactionId !== taskTransitionTransactionId(transaction.taskId, generationIdentity, transaction.requestHash) ||
    transaction.nextTask.state !== transaction.request.to || recordHash(transaction.nextTask) !== recordHash(expectedNext) ||
    transaction.nextTask.authorityGeneration !== nextAuthorityGeneration || transaction.ledgerEffect.taskId !== transaction.taskId ||
    !transaction.ledgerEffect.summary.includes(ledgerMarker(transaction.transactionId)) ||
    recordHash(transaction.ledgerEffect) !== recordHash(expectedLedgerEffect) ||
    transaction.approvalConsumptionOwner !== (transaction.request.approvalRef === undefined ? undefined : `task-transition:${transaction.taskId}:APPROVED_FOR_EXECUTION`) ||
    (transaction.status === "PREPARED" && (transaction.committedAt !== undefined || transaction.abortedAt !== undefined || transaction.abortCode !== undefined)) ||
    (transaction.status === "COMMITTED" && (transaction.committedAt === undefined || transaction.abortedAt !== undefined || transaction.abortCode !== undefined)) ||
    (transaction.status === "ABORTED" && (transaction.committedAt !== undefined || transaction.abortedAt === undefined || transaction.abortCode === undefined))
  ) throw transitionError("TASK_TRANSITION_TRANSACTION_BINDING_MISMATCH", "Task transition transaction fields are not internally bound.", { transactionId: transaction.transactionId });
  if (transaction.request.to === "DONE" && (
    transaction.request.receiptRef === undefined || transaction.request.evidenceRefs === undefined ||
    transaction.nextTask.completionReceiptRef !== transaction.request.receiptRef || !exactSet(transaction.nextTask.completionEvidenceRefs ?? [], transaction.request.evidenceRefs)
  )) throw transitionError("TASK_TRANSITION_TRANSACTION_BINDING_MISMATCH", "DONE transaction proof is not bound to its intended Task.", { transactionId: transaction.transactionId });
  try { assertTransition(transaction.sourceTask.state, transaction.nextTask.state); }
  catch { throw transitionError("TASK_TRANSITION_TRANSACTION_BINDING_MISMATCH", "Journaled Task states are not a valid transition.", { transactionId: transaction.transactionId }); }
}

async function assertRuntimeCompletion(workspace: LocalWorkspace, task: TaskCharter, options: Pick<TaskTransitionOptions, "receiptRef" | "evidenceRefs">): Promise<Required<Pick<TaskCharter, "completionReceiptRef" | "completionEvidenceRefs">>> {
  if (options.receiptRef === undefined) throw transitionError("TASK_COMPLETION_RECEIPT_REQUIRED", "VERIFYING -> DONE requires a persisted Runtime Receipt.", { taskId: task.id });
  if (options.evidenceRefs === undefined || options.evidenceRefs.length === 0) throw transitionError("TASK_COMPLETION_EVIDENCE_REQUIRED", "VERIFYING -> DONE requires non-empty persisted Runtime Evidence.", { taskId: task.id });
  const evidenceRefs = [...new Set(options.evidenceRefs)].sort();
  if (evidenceRefs.length !== options.evidenceRefs.length) throw transitionError("TASK_COMPLETION_EVIDENCE_INVALID", "Completion Evidence references must be unique.", { taskId: task.id });
  const receipt = await getReceipt(workspace, options.receiptRef);
  if (receipt.taskId !== task.id || receipt.status !== "COMPLETED" || typeof receipt.runId !== "string") throw transitionError("TASK_COMPLETION_RECEIPT_RUNTIME_REQUIRED", "Task completion accepts only a COMPLETED Receipt bound to a persisted Runtime Run for this Task.", { taskId: task.id, receiptRef: receipt.id });
  const run = await getRun(workspace, receipt.runId);
  assertRuntimeReceiptMatchesRun(receipt, run);
  await assertRuntimeFinalizationCommitted(workspace, await defaultSchemaRegistry(), run, receipt);
  if (run.status !== "COMPLETED" || run.taskId !== task.id || typeof run.outputHash !== "string" || !HASH_PATTERN.test(run.outputHash)) throw transitionError("TASK_COMPLETION_RUN_INVALID", "Completion requires a COMPLETED Runtime Run with a canonical outputHash for this Task.", { taskId: task.id, runId: run.runId, status: run.status });
  if (run.evidenceRefs === undefined || run.evidenceRefs.length === 0 || !exactSet(evidenceRefs, run.evidenceRefs)) throw transitionError("TASK_COMPLETION_EVIDENCE_MISMATCH", "Completion Evidence must exactly match the Runtime Run and Receipt.", { taskId: task.id, runId: run.runId });
  const lease = await getLease(workspace, run.leaseId);
  if (
    lease.taskId !== task.id || lease.id !== run.leaseId || lease.agentId !== run.agentId || lease.role !== run.role || lease.capability !== "repository-read" ||
    lease.status !== "active" || Date.parse(lease.expiresAt) <= Date.now() || lease.taskAuthorityHash !== hashTaskAuthority(task) || lease.policyVersion !== run.policyVersion
  ) throw transitionError("TASK_COMPLETION_AUTHORITY_STALE", "The terminal Runtime proof is not bound to the current active Task/Lease/Agent authority.", { taskId: task.id, runId: run.runId, leaseId: lease.id });
  await admitPersistedLeaseAuthority(workspace, lease, [lease.capability]);
  await Promise.all(evidenceRefs.map((evidenceRef) => getEvidence(workspace, evidenceRef)));
  return { completionReceiptRef: receipt.id, completionEvidenceRefs: evidenceRefs };
}

function maybeInjectFault(workspace: LocalWorkspace, point: TaskTransitionFaultPoint, transactionId: string): void {
  if (injectedFaults.get(workspace.directory) !== point) return;
  injectedFaults.delete(workspace.directory);
  throw transitionError("TASK_TRANSITION_FAULT_INJECTED", `Injected Task transition fault at ${point}.`, { transactionId, point });
}
function assertTransactionId(value: string): void {
  if (!/^task-txn-[a-f0-9]{8}(?:-[a-f0-9]{8}){3}$/.test(value)) throw transitionError("TASK_TRANSITION_TRANSACTION_ID_INVALID", "Task transition transaction ID is invalid.", { transactionId: value });
}
function recordHash(value: unknown): string { return digest(canonical(value)); }
function digest(value: string): string { return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`; }
function auditFingerprintFromReasonHash(reasonHash: string): string {
  const digestValue = reasonHash.slice("sha256:".length);
  return `sha256:${digestValue.match(/.{1,12}/g)?.join("-") ?? digestValue}`;
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}
function exactSet(left: string[], right: string[]): boolean {
  const sortedLeft = [...left].sort(); const sortedRight = [...right].sort();
  return sortedLeft.length === sortedRight.length && sortedLeft.every((value, index) => value === sortedRight[index]);
}
function transitionError(code: string, message: string, details: Record<string, unknown>): StinkyCobblerError { return new StinkyCobblerError(code, ExitCode.POLICY_DENIED, message, details); }
function isCode(error: unknown, code: string): boolean { return typeof error === "object" && error !== null && "code" in error && error.code === code; }
