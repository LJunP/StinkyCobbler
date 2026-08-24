import { createHash } from "node:crypto";
import { lstat, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { defaultSchemaRegistry } from "../contracts/default-schema-registry.js";
import type { SchemaRegistry } from "../contracts/schema-registry.js";
import type { AgentRun } from "../contracts/types.js";
import { ExitCode, StinkyCobblerError } from "../errors.js";
import { appendLedgerEntry, listLedgerEntries, prepareLedgerEntry, type AppendLedgerEntry, type LedgerEntry } from "./ledger.js";
import {
  assertRuntimeReceiptMatchesRun,
  listReceipts,
  persistReceiptFile,
  validateRuntimeReceiptCandidate,
  type AgentReceipt
} from "./receipts.js";
import { ensureRunLifecycleCommitted, getRun } from "./runs.js";
import type { LocalWorkspace } from "./workspace.js";
import { createWorkspaceJson, workspaceFile, writeWorkspaceJson } from "./workspace.js";
import { withWorkspaceLock } from "./workspace-lock.js";

const DIRECTORY = "runtime-finalizations";
const MAX_FINALIZATION_BYTES = 2 * 1024 * 1024;

export type RuntimeFinalizationStatus = "PREPARED" | "COMMITTED";
export type RuntimeFinalizationFaultPoint = "after-prepare" | "after-receipt" | "after-ledger";

export interface RuntimeFinalization {
  version: 1;
  finalizationId: string;
  status: RuntimeFinalizationStatus;
  runId: string;
  runHash: string;
  executionRequestHash: string;
  receiptId: string;
  receiptHash: string;
  receipt: AgentReceipt;
  ledgerEffect: AppendLedgerEntry & { event: "receipt-recorded"; taskId: string; receiptRef: string; runId: string };
  preparedAt: string;
  updatedAt: string;
  committedAt?: string;
}

const injectedFaults = new Map<string, RuntimeFinalizationFaultPoint>();

export function runtimeReceiptId(runId: string): string {
  return `runtime-receipt-${digestText(runId)}`;
}

export function runtimeFinalizationId(runId: string): string {
  return `runtime-finalization-${digestText(runId)}`;
}

/**
 * Freezes the exact Receipt before writing either the Receipt target or its
 * audit entry. Retries therefore replay only the originally prepared bytes.
 */
export function recordRuntimeReceipt(
  workspace: LocalWorkspace,
  schemas: SchemaRegistry,
  receipt: Record<string, unknown>
): Promise<AgentReceipt> {
  return withWorkspaceLock(workspace, async () => {
    const validated = await validateRuntimeReceiptCandidate(workspace, schemas, receipt);
    if (typeof validated.runId !== "string") {
      throw finalizationError("RUNTIME_RECEIPT_CONFLICT", "Runtime Receipt runId is required.", { receiptId: validated.id });
    }
    const run = await getRun(workspace, validated.runId);
    if (typeof run.executionRequestHash !== "string") {
      throw finalizationError("RUNTIME_RUN_REISSUE_REQUIRED", "A legacy Runtime Run without an executionRequestHash cannot be finalized or repaired into a success proof.", {
        runId: run.runId
      });
    }
    await ensureRunLifecycleCommitted(workspace, run);
    const durableReceipt = JSON.parse(JSON.stringify(validated)) as AgentReceipt;
    schemas.validate("receipt", durableReceipt);
    assertRuntimeReceiptMatchesRun(durableReceipt, run);
    const expectedReceiptId = runtimeReceiptId(run.runId);
    if (durableReceipt.id !== expectedReceiptId) {
      throw finalizationError("RUNTIME_RECEIPT_ID_NONDETERMINISTIC", "Runtime Receipts must use the deterministic ID derived from their authoritative Run.", {
        runId: run.runId, receiptId: durableReceipt.id, expectedReceiptId
      });
    }

    let journal = await findRuntimeFinalization(workspace, run.runId);
    if (journal === undefined) {
      const associated = (await listReceipts(workspace)).filter((candidate) => candidate.runId === run.runId);
      if (associated.length > 0) {
        throw finalizationError("RUNTIME_FINALIZATION_LEGACY_RECEIPT", "A Runtime Receipt exists without its required finalization journal; this Run must be reissued under the current authority model.", {
          runId: run.runId, receiptIds: associated.map((candidate) => candidate.id)
        });
      }
      const now = new Date().toISOString();
      const finalizationId = runtimeFinalizationId(run.runId);
      journal = {
        version: 1,
        finalizationId,
        status: "PREPARED",
        runId: run.runId,
        runHash: recordHash(run),
        executionRequestHash: run.executionRequestHash,
        receiptId: durableReceipt.id,
        receiptHash: recordHash(durableReceipt),
        receipt: durableReceipt,
        ledgerEffect: runtimeReceiptLedgerEffect(finalizationId, run.runId, run.taskId, durableReceipt.id),
        preparedAt: now,
        updatedAt: now
      };
      schemas.validate("runtime-finalization", journal);
      assertFinalizationBinding(journal);
      await mkdir(await workspaceFile(workspace, DIRECTORY), { recursive: true, mode: 0o700 });
      try {
        await createWorkspaceJson(workspace, finalizationFile(journal.finalizationId), journal);
      } catch (error: unknown) {
        if (!isCode(error, "EEXIST")) throw error;
        journal = await getRuntimeFinalization(workspace, run.runId);
      }
      maybeInjectFault(workspace, "after-prepare", journal.finalizationId);
    }

    if (journal.executionRequestHash !== run.executionRequestHash || journal.runHash !== recordHash(run) || journal.receiptHash !== recordHash(durableReceipt)) {
      throw finalizationError("RUNTIME_FINALIZATION_CONFLICT", "The prepared Runtime finalization is bound to different Run or Receipt bytes.", {
        runId: run.runId, finalizationId: journal.finalizationId
      });
    }
    return reconcileRuntimeFinalizationLocked(workspace, schemas, journal, run);
  });
}

export function reconcileRuntimeFinalization(
  workspace: LocalWorkspace,
  schemas: SchemaRegistry,
  runId: string
): Promise<AgentReceipt> {
  return withWorkspaceLock(workspace, async () => {
    const run = await getRun(workspace, runId);
    await ensureRunLifecycleCommitted(workspace, run);
    const journal = await getRuntimeFinalization(workspace, runId);
    return reconcileRuntimeFinalizationLocked(workspace, schemas, journal, run);
  });
}

export function assertRuntimeFinalizationCommitted(
  workspace: LocalWorkspace,
  schemas: SchemaRegistry,
  run: AgentRun,
  receipt: AgentReceipt
): Promise<RuntimeFinalization> {
  return withWorkspaceLock(workspace, async () => {
    await ensureRunLifecycleCommitted(workspace, run);
    return assertRuntimeFinalizationSnapshotLocked(workspace, schemas, run, receipt);
  });
}

/** Read-only committed-finalization proof check used by diagnostics and retry admission. */
export function assertRuntimeFinalizationSnapshot(
  workspace: LocalWorkspace,
  schemas: SchemaRegistry,
  run: AgentRun,
  receipt: AgentReceipt
): Promise<RuntimeFinalization> {
  return withWorkspaceLock(workspace, () => assertRuntimeFinalizationSnapshotLocked(workspace, schemas, run, receipt));
}

async function assertRuntimeFinalizationSnapshotLocked(
  workspace: LocalWorkspace,
  schemas: SchemaRegistry,
  run: AgentRun,
  receipt: AgentReceipt
): Promise<RuntimeFinalization> {
  const journal = await getRuntimeFinalization(workspace, run.runId);
  schemas.validate("runtime-finalization", journal);
  assertFinalizationBinding(journal);
  if (journal.status !== "COMMITTED") {
    throw finalizationError("RUNTIME_FINALIZATION_INCOMPLETE", "Runtime finalization has not committed its Receipt and exact audit effect.", {
      runId: run.runId, finalizationId: journal.finalizationId, status: journal.status
    });
  }
  if (journal.executionRequestHash !== run.executionRequestHash || journal.runHash !== recordHash(run) || journal.receiptHash !== recordHash(receipt)) {
    throw finalizationError("RUNTIME_FINALIZATION_CONFLICT", "Committed Runtime finalization no longer matches its Run or Receipt.", {
      runId: run.runId, finalizationId: journal.finalizationId
    });
  }
  assertRuntimeReceiptMatchesRun(receipt, run);
  await assertFinalizationTargets(workspace, journal, run);
  return journal;
}

export async function getRuntimeFinalization(workspace: LocalWorkspace, runId: string): Promise<RuntimeFinalization> {
  const finalizationId = runtimeFinalizationId(runId);
  const target = await workspaceFile(workspace, finalizationFile(finalizationId));
  try {
    const stat = await lstat(target);
    if (!stat.isFile() || stat.size > MAX_FINALIZATION_BYTES) {
      throw finalizationError("RUNTIME_FINALIZATION_INVALID", "Stored Runtime finalization exceeds the durable byte limit.", {
        runId, bytes: stat.size, limit: MAX_FINALIZATION_BYTES
      });
    }
    const value: unknown = JSON.parse(await readFile(target, "utf8"));
    (await defaultSchemaRegistry()).validate("runtime-finalization", value);
    const journal = value as RuntimeFinalization;
    if (journal.finalizationId !== finalizationId || journal.runId !== runId) {
      throw finalizationError("RUNTIME_FINALIZATION_BINDING_MISMATCH", "Stored Runtime finalization does not match its canonical lookup identity.", {
        runId, finalizationId, storedRunId: journal.runId, storedFinalizationId: journal.finalizationId
      });
    }
    assertFinalizationBinding(journal);
    return journal;
  } catch (error: unknown) {
    if (isCode(error, "ENOENT")) {
      throw finalizationError("RUNTIME_FINALIZATION_NOT_FOUND", "Runtime finalization does not exist.", { runId, finalizationId });
    }
    if (error instanceof SyntaxError) {
      throw finalizationError("RUNTIME_FINALIZATION_INVALID", "Stored Runtime finalization contains invalid JSON.", { runId, finalizationId });
    }
    throw error;
  }
}

export async function findRuntimeFinalization(workspace: LocalWorkspace, runId: string): Promise<RuntimeFinalization | undefined> {
  try { return await getRuntimeFinalization(workspace, runId); }
  catch (error: unknown) {
    if (error instanceof StinkyCobblerError && error.code === "RUNTIME_FINALIZATION_NOT_FOUND") return undefined;
    throw error;
  }
}

export function injectRuntimeFinalizationFaultOnceForTest(workspace: LocalWorkspace, point: RuntimeFinalizationFaultPoint): void {
  injectedFaults.set(workspace.directory, point);
}

async function reconcileRuntimeFinalizationLocked(
  workspace: LocalWorkspace,
  schemas: SchemaRegistry,
  initial: RuntimeFinalization,
  run: AgentRun
): Promise<AgentReceipt> {
  let journal = initial;
  schemas.validate("runtime-finalization", journal);
  assertFinalizationBinding(journal);
  if (journal.executionRequestHash !== run.executionRequestHash || journal.runHash !== recordHash(run)) {
    throw finalizationError("RUNTIME_FINALIZATION_RUN_CHANGED", "The authoritative terminal Run changed after Runtime finalization was prepared.", {
      runId: run.runId, finalizationId: journal.finalizationId
    });
  }
  schemas.validate("receipt", journal.receipt);
  assertRuntimeReceiptMatchesRun(journal.receipt, run);
  if (journal.status === "COMMITTED") {
    await assertFinalizationTargets(workspace, journal, run);
    return journal.receipt;
  }

  const associated = (await listReceipts(workspace)).filter((candidate) => candidate.runId === run.runId);
  if (associated.length > 1 || (associated[0] !== undefined && recordHash(associated[0]) !== journal.receiptHash)) {
    throw finalizationError("RUNTIME_RECEIPT_CONFLICT", "Runtime finalization found conflicting or multiple Receipts for one Run.", {
      runId: run.runId, receiptIds: associated.map((candidate) => candidate.id)
    });
  }
  if (associated.length === 0) await persistReceiptFile(workspace, journal.receipt);
  maybeInjectFault(workspace, "after-receipt", journal.finalizationId);

  await ensureExactLedgerEffect(workspace, journal);
  maybeInjectFault(workspace, "after-ledger", journal.finalizationId);

  const now = new Date().toISOString();
  journal = { ...journal, status: "COMMITTED", updatedAt: now, committedAt: now };
  schemas.validate("runtime-finalization", journal);
  assertFinalizationBinding(journal);
  await writeWorkspaceJson(workspace, finalizationFile(journal.finalizationId), journal);
  await assertFinalizationTargets(workspace, journal, run);
  return journal.receipt;
}

async function assertFinalizationTargets(workspace: LocalWorkspace, journal: RuntimeFinalization, run: AgentRun): Promise<void> {
  const associated = (await listReceipts(workspace)).filter((candidate) => candidate.runId === run.runId);
  if (associated.length !== 1 || associated[0]?.id !== journal.receiptId || recordHash(associated[0]) !== journal.receiptHash) {
    throw finalizationError("RUNTIME_FINALIZATION_TARGET_MISMATCH", "Runtime finalization requires exactly one immutable Receipt target for its Run.", {
      runId: run.runId, receiptIds: associated.map((candidate) => candidate.id)
    });
  }
  const entries = await listLedgerEntries(workspace);
  const matching = entries.filter((entry) => sameLedgerEffect(entry, journal.ledgerEffect));
  if (matching.length !== 1) {
    throw finalizationError("RUNTIME_FINALIZATION_AUDIT_MISMATCH", "Runtime finalization requires exactly one matching receipt-recorded ledger effect.", {
      runId: run.runId, receiptId: journal.receiptId, matchingEntries: matching.length
    });
  }
}

async function ensureExactLedgerEffect(workspace: LocalWorkspace, journal: RuntimeFinalization): Promise<void> {
  const entries = await listLedgerEntries(workspace);
  const sameReceipt = entries.filter((entry) => entry.event === "receipt-recorded" && entry.receiptRef === journal.receiptId);
  if (sameReceipt.some((entry) => !sameLedgerEffect(entry, journal.ledgerEffect))) {
    throw finalizationError("RUNTIME_FINALIZATION_AUDIT_CONFLICT", "The Runtime Receipt ID already has a conflicting receipt-recorded ledger entry.", {
      runId: journal.runId, receiptId: journal.receiptId
    });
  }
  if (sameReceipt.length === 0) await appendLedgerEntry(workspace, journal.ledgerEffect);
  if (sameReceipt.length > 1) {
    throw finalizationError("RUNTIME_FINALIZATION_AUDIT_CONFLICT", "The Runtime Receipt has duplicate receipt-recorded ledger entries.", {
      runId: journal.runId, receiptId: journal.receiptId, entries: sameReceipt.length
    });
  }
}

function runtimeReceiptLedgerEffect(finalizationId: string, runId: string, taskId: string, receiptId: string): RuntimeFinalization["ledgerEffect"] {
  return prepareLedgerEntry({
    event: "receipt-recorded",
    taskId,
    receiptRef: receiptId,
    runId,
    summary: `Runtime Receipt finalized. [${groupLongHexRuns(finalizationId)}]`
  }) as RuntimeFinalization["ledgerEffect"];
}

function assertFinalizationBinding(journal: RuntimeFinalization): void {
  const expectedId = runtimeFinalizationId(journal.runId);
  const expectedReceiptId = runtimeReceiptId(journal.runId);
  const expectedLedger = runtimeReceiptLedgerEffect(expectedId, journal.runId, journal.receipt.taskId, expectedReceiptId);
  if (
    journal.finalizationId !== expectedId || journal.receiptId !== expectedReceiptId || journal.receipt.id !== expectedReceiptId ||
    journal.receipt.runId !== journal.runId || journal.receiptHash !== recordHash(journal.receipt) ||
    journal.receipt.executionRequestHash !== journal.executionRequestHash ||
    !samePreparedLedgerEffect(journal.ledgerEffect, expectedLedger) ||
    (journal.status === "PREPARED" && journal.committedAt !== undefined) ||
    (journal.status === "COMMITTED" && journal.committedAt === undefined)
  ) {
    throw finalizationError("RUNTIME_FINALIZATION_BINDING_MISMATCH", "Runtime finalization fields are not internally bound.", {
      runId: journal.runId, finalizationId: journal.finalizationId
    });
  }
}

function sameLedgerEffect(entry: LedgerEntry, effect: RuntimeFinalization["ledgerEffect"]): boolean {
  return samePreparedLedgerEffect(entry, effect);
}

function samePreparedLedgerEffect(entry: Partial<LedgerEntry> | AppendLedgerEntry, effect: RuntimeFinalization["ledgerEffect"]): boolean {
  return entry.event === effect.event && entry.taskId === effect.taskId && entry.receiptRef === effect.receiptRef &&
    entry.runId === effect.runId && entry.summary === effect.summary;
}

function maybeInjectFault(workspace: LocalWorkspace, point: RuntimeFinalizationFaultPoint, finalizationId: string): void {
  if (injectedFaults.get(workspace.directory) !== point) return;
  injectedFaults.delete(workspace.directory);
  throw finalizationError("RUNTIME_FINALIZATION_FAULT_INJECTED", `Injected Runtime finalization fault at ${point}.`, { finalizationId, point });
}

function finalizationFile(finalizationId: string): string { return path.join(DIRECTORY, `${finalizationId}.json`); }
function digestText(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function recordHash(value: unknown): string { return `sha256:${createHash("sha256").update(canonical(value), "utf8").digest("hex")}`; }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
function groupLongHexRuns(value: string): string { return value.replace(/[0-9a-f]{24,}/g, (token) => token.match(/.{1,12}/g)?.join("-") ?? token); }
function finalizationError(code: string, message: string, details: Record<string, unknown>): StinkyCobblerError { return new StinkyCobblerError(code, ExitCode.POLICY_DENIED, message, details); }
function isCode(error: unknown, code: string): boolean { return typeof error === "object" && error !== null && "code" in error && error.code === code; }
