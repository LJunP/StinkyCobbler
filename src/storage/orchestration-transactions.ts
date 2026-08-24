import { createHash } from "node:crypto";
import { mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { SchemaRegistry, ContractKind } from "../contracts/schema-registry.js";
import { defaultSchemaRegistry } from "../contracts/default-schema-registry.js";
import type {
  Artifact, OrchestrationRun, ReviewRecord, SubtaskPackage, TaskContract, ValidatorReceipt
} from "../contracts/orchestration.js";
import { ExitCode, StinkyCobblerError } from "../errors.js";
import { loadOrchestrationConfig } from "../config/tiered.js";
import { readBoundedWorkspaceFile, resolveWorkspacePath, WorkspaceReadBoundaryError } from "../security/workspace-path.js";
import { appendLedgerEntry, auditTextFingerprint, listLedgerEntries, prepareLedgerEntry, type AppendLedgerEntry, type LedgerEntry } from "./ledger.js";
import {
  assertValidatorReceiptBinding, getValidatorReceipt, persistValidatorReceipt, validatorReceiptId
} from "./orchestration-validator-receipts.js";
import { admitPersistedContractAuthority } from "./task-authority.js";
import type { LocalWorkspace } from "./workspace.js";
import { createWorkspaceJson, workspaceFile, writeWorkspaceJson } from "./workspace.js";
import { withWorkspaceLock } from "./workspace-lock.js";
import { getRunCancellationFence } from "./orchestration-fence.js";

const DIRECTORY = "orchestration";
const TRANSACTION_PREFIX = "transaction-";
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const LEDGER_OPTIONAL_FIELDS = [
  "taskId", "contractRef", "runRef", "subtaskRef", "reviewRef", "round"
] as const;
const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;

export type OrchestrationTransactionStatus = "PREPARED" | "COMMITTED" | "ABORTED";
export type OrchestrationTransactionFaultPoint =
  | "after-prepared"
  | "after-validator-receipts"
  | "after-review"
  | "after-subtask"
  | "after-contract"
  | "after-run"
  | "after-ledger-effect";

export interface OrchestrationLedgerEffect extends AppendLedgerEntry {
  effectId: string;
  taskId: string;
  contractRef: string;
  runRef: string;
}

interface TransactionCommon {
  version: 1;
  transactionId: string;
  status: OrchestrationTransactionStatus;
  requestHash: string;
  contractRef: string;
  runRef: string;
  round: number;
  sourceRunHash: string;
  nextRun: OrchestrationRun;
  ledgerEffects: OrchestrationLedgerEffect[];
  preparedAt: string;
  updatedAt: string;
  committedAt?: string;
  abortedAt?: string;
  abortReasonHash?: string;
}

export interface ReviewTransaction extends TransactionCommon {
  kind: "REVIEW";
  subtaskRef: string;
  attempt: number;
  reviewRef: string;
  sourceSubtaskHash: string;
  validatorReceipts: ValidatorReceipt[];
  review: ReviewRecord;
  nextSubtask: SubtaskPackage;
}

export interface CompletionTransaction extends TransactionCommon {
  kind: "COMPLETION";
  sourceContractHash: string;
  nextContract: TaskContract;
}

export interface EscalationTransaction extends TransactionCommon {
  kind: "ESCALATION";
  escalationGeneration: number;
}

export type OrchestrationTransaction = ReviewTransaction | CompletionTransaction | EscalationTransaction;

const injectedFaults = new Map<string, OrchestrationTransactionFaultPoint>();

export function reviewTransactionId(runRef: string, subtaskRef: string, attempt: number): string {
  return deterministicId("review-txn", [runRef, subtaskRef, attempt]);
}

export function completionTransactionId(runRef: string, round: number): string {
  return deterministicId("completion-txn", [runRef, round]);
}

export function escalationTransactionId(runRef: string, escalationGeneration: number): string {
  return deterministicId("escalation-txn", [runRef, escalationGeneration]);
}

export function reviewIdForTransaction(transactionId: string): string {
  return deterministicId("review", [transactionId]);
}

export function orchestrationRecordHash(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
}

export function orchestrationRequestHash(value: unknown): string {
  return orchestrationRecordHash({ version: 1, request: value });
}

export function orchestrationLedgerEffect(
  transactionId: string,
  effectId: string,
  entry: AppendLedgerEntry & { taskId: string; contractRef: string; runRef: string }
): OrchestrationLedgerEffect {
  assertId(effectId, "ORCHESTRATION_TRANSACTION_EFFECT_ID_INVALID");
  const prepared = prepareLedgerEntry({
    ...entry,
    summary: `${groupLongHexRuns(entry.summary)} ${ledgerMarker(transactionId, effectId)}`
  });
  return { ...prepared, effectId } as OrchestrationLedgerEffect;
}

/** Creates the durable PREPARED record before any transaction-owned target is written. */
export async function prepareOrchestrationTransaction(
  workspace: LocalWorkspace,
  schemas: SchemaRegistry,
  transaction: OrchestrationTransaction
): Promise<OrchestrationTransaction> {
  if (transaction.status !== "PREPARED" || transaction.committedAt !== undefined) {
    throw transactionError("ORCHESTRATION_TRANSACTION_INVALID", "A newly prepared orchestration transaction must be PREPARED without committedAt.", {
      transactionId: transaction.transactionId
    });
  }
  schemas.validate("orchestration-transaction", transaction);
  assertTransactionBinding(transaction);
  await mkdir(await workspaceFile(workspace, DIRECTORY), { recursive: true, mode: 0o700 });
  try {
    await createWorkspaceJson(workspace, transactionFile(transaction.transactionId), transaction);
  } catch (error: unknown) {
    if (!isCode(error, "EEXIST")) throw error;
    const existing = await getOrchestrationTransaction(workspace, transaction.transactionId);
    if (
      existing.kind !== transaction.kind || existing.requestHash !== transaction.requestHash ||
      existing.contractRef !== transaction.contractRef || existing.runRef !== transaction.runRef
    ) {
      throw transactionError("ORCHESTRATION_TRANSACTION_CONFLICT", "The deterministic orchestration transaction ID is already bound to a different request.", {
        transactionId: transaction.transactionId
      });
    }
    return existing;
  }
  maybeInjectFault(workspace, "after-prepared", transaction.transactionId);
  return transaction;
}

export async function getOrchestrationTransaction(workspace: LocalWorkspace, transactionId: string): Promise<OrchestrationTransaction> {
  assertId(transactionId, "ORCHESTRATION_TRANSACTION_ID_INVALID");
  try {
    const parsed: unknown = JSON.parse(await readFile(await workspaceFile(workspace, transactionFile(transactionId)), "utf8"));
    (await defaultSchemaRegistry()).validate("orchestration-transaction", parsed);
    const transaction = parsed as OrchestrationTransaction;
    if (transaction.transactionId !== transactionId) {
      throw transactionError("ORCHESTRATION_TRANSACTION_ID_MISMATCH", "Stored orchestration transaction ID does not match its canonical lookup ID.", {
        transactionId,
        storedTransactionId: transaction.transactionId
      });
    }
    assertTransactionBinding(transaction);
    return transaction;
  } catch (error: unknown) {
    if (isCode(error, "ENOENT")) {
      throw transactionError("ORCHESTRATION_TRANSACTION_NOT_FOUND", "Orchestration transaction does not exist.", { transactionId });
    }
    if (error instanceof SyntaxError) {
      throw transactionError("ORCHESTRATION_TRANSACTION_INVALID", "Stored orchestration transaction contains invalid JSON.", { transactionId });
    }
    throw error;
  }
}

export async function findOrchestrationTransaction(workspace: LocalWorkspace, transactionId: string): Promise<OrchestrationTransaction | undefined> {
  try {
    return await getOrchestrationTransaction(workspace, transactionId);
  } catch (error: unknown) {
    if (error instanceof StinkyCobblerError && error.code === "ORCHESTRATION_TRANSACTION_NOT_FOUND") return undefined;
    throw error;
  }
}

export async function listOrchestrationTransactions(workspace: LocalWorkspace): Promise<OrchestrationTransaction[]> {
  const directory = await workspaceFile(workspace, DIRECTORY);
  const names = await readdir(directory).catch((error: unknown) => isCode(error, "ENOENT") ? [] as string[] : Promise.reject(error));
  const transactionNames = names.filter((name) => name.startsWith(TRANSACTION_PREFIX) && name.endsWith(".json"));
  const malformed = transactionNames.find((name) => !/^transaction-[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$/.test(name));
  if (malformed !== undefined) {
    throw transactionError("ORCHESTRATION_TRANSACTION_FILENAME_INVALID", "A transaction-prefixed journal has a non-canonical filename.", {
      filename: malformed
    });
  }
  const ids = transactionNames
    .sort()
    .map((name) => name.slice(TRANSACTION_PREFIX.length, -5));
  return Promise.all(ids.map((id) => getOrchestrationTransaction(workspace, id)));
}

/** Replays a PREPARED journal or verifies an already COMMITTED one. Every step is idempotent. */
export function reconcileOrchestrationTransaction(
  workspace: LocalWorkspace,
  schemas: SchemaRegistry,
  transactionId: string
): Promise<OrchestrationTransaction> {
  return withWorkspaceLock(workspace, async () => {
    let transaction = await getOrchestrationTransaction(workspace, transactionId);
    schemas.validate("orchestration-transaction", transaction);
    assertTransactionBinding(transaction);
    if (transaction.status === "ABORTED") {
      throw transactionError("ORCHESTRATION_TRANSACTION_ABORTED", "A transaction superseded by durable Run cancellation cannot be reconciled.", {
        transactionId,
        runRef: transaction.runRef
      });
    }
    if (transaction.status === "COMMITTED") return transaction;
    const auditOnlyRepair = await orchestrationTransactionTargetsAreIntended(workspace, transaction);
    if (!auditOnlyRepair && await getRunCancellationFence(workspace, transaction.runRef) !== undefined) {
      throw transactionError(
        "ORCHESTRATION_TRANSACTION_CANCELLED",
        "A PREPARED transaction cannot publish business state after durable Run cancellation has begun.",
        { transactionId, runRef: transaction.runRef }
      );
    }
    await assertTransactionContractFence(workspace, transaction, auditOnlyRepair);

    if (transaction.kind === "REVIEW") {
      if (!auditOnlyRepair) await reverifyReviewTransactionArtifacts(workspace, transaction);
      for (const receipt of transaction.validatorReceipts) await persistValidatorReceipt(workspace, receipt);
      maybeInjectFault(workspace, "after-validator-receipts", transaction.transactionId);

      await persistImmutableRecord(workspace, "orchestration-review", reviewFile(transaction.reviewRef), "reviewId", transaction.reviewRef, transaction.review);
      maybeInjectFault(workspace, "after-review", transaction.transactionId);

      await reconcileMutableRecord(
        workspace, "orchestration-subtask", subtaskFile(transaction.subtaskRef), "subtaskId", transaction.subtaskRef,
        transaction.sourceSubtaskHash, transaction.nextSubtask
      );
      maybeInjectFault(workspace, "after-subtask", transaction.transactionId);

      await reconcileMutableRecord(
        workspace, "orchestration-run", runFile(transaction.runRef), "runId", transaction.runRef,
        transaction.sourceRunHash, transaction.nextRun
      );
      maybeInjectFault(workspace, "after-run", transaction.transactionId);
    } else if (transaction.kind === "COMPLETION") {
      if (!auditOnlyRepair) await reverifyCompletionTransactionArtifacts(workspace, transaction);
      // Publish the terminal Contract fence before the terminal Run. If a process
      // dies between these writes, createRun still fails closed on the Contract.
      await reconcileMutableRecord(
        workspace, "orchestration-contract", contractFile(transaction.contractRef), "contractId", transaction.contractRef,
        transaction.sourceContractHash, transaction.nextContract
      );
      maybeInjectFault(workspace, "after-contract", transaction.transactionId);

      await reconcileMutableRecord(
        workspace, "orchestration-run", runFile(transaction.runRef), "runId", transaction.runRef,
        transaction.sourceRunHash, transaction.nextRun
      );
      maybeInjectFault(workspace, "after-run", transaction.transactionId);
    } else {
      await reconcileMutableRecord(
        workspace, "orchestration-run", runFile(transaction.runRef), "runId", transaction.runRef,
        transaction.sourceRunHash, transaction.nextRun
      );
      maybeInjectFault(workspace, "after-run", transaction.transactionId);
    }

    for (const effect of transaction.ledgerEffects) {
      await appendLedgerEffectIdempotently(workspace, effect);
      maybeInjectFault(workspace, "after-ledger-effect", transaction.transactionId);
    }

    if (transaction.status === "PREPARED") {
      const committedAt = new Date().toISOString();
      transaction = { ...transaction, status: "COMMITTED", updatedAt: committedAt, committedAt };
      schemas.validate("orchestration-transaction", transaction);
      assertTransactionBinding(transaction);
      await writeWorkspaceJson(workspace, transactionFile(transaction.transactionId), transaction);
    }
    return transaction;
  });
}

/**
 * Makes cancellation an explicit terminal outcome for an unfinished journal.
 * Immutable proof files and already-written review state may remain as
 * forensic evidence, but the durable Run cancellation fence prevents any
 * further execution.  A Contract-first completion split is changed from
 * COMPLETED to CANCELLED so it cannot contradict the cancelled source Run.
 */
export function abortOrchestrationTransactionForCancellation(
  workspace: LocalWorkspace,
  schemas: SchemaRegistry,
  transactionId: string
): Promise<OrchestrationTransaction> {
  return withWorkspaceLock(workspace, async () => {
    let transaction = await getOrchestrationTransaction(workspace, transactionId);
    if (transaction.status === "COMMITTED") return transaction;
    if (transaction.status === "ABORTED") {
      await ensureTransactionAbortedLedger(workspace, transaction);
      return transaction;
    }

    if (transaction.kind === "COMPLETION") {
      const current = await readBoundRecord<TaskContract>(
        workspace, "orchestration-contract", contractFile(transaction.contractRef), "contractId", transaction.contractRef
      );
      const currentHash = orchestrationRecordHash(current);
      const nextHash = orchestrationRecordHash(transaction.nextContract);
      if (currentHash === nextHash) {
        const cancelled: TaskContract = { ...current, status: "CANCELLED" };
        schemas.validate("orchestration-contract", cancelled);
        await writeWorkspaceJson(workspace, contractFile(transaction.contractRef), cancelled);
      } else if (currentHash !== transaction.sourceContractHash && current.status !== "CANCELLED") {
        throw transactionError("ORCHESTRATION_TRANSACTION_TARGET_CONFLICT", "A completion transaction Contract is neither its prepared source, intended target, nor a prior cancellation.", {
          transactionId,
          contractRef: transaction.contractRef,
          currentHash,
          sourceHash: transaction.sourceContractHash,
          intendedHash: nextHash
        });
      }
    }

    const abortedAt = new Date().toISOString();
    transaction = {
      ...transaction,
      status: "ABORTED",
      updatedAt: abortedAt,
      abortedAt,
      abortReasonHash: orchestrationRecordHash({ kind: "RUN_CANCELLATION", runRef: transaction.runRef })
    };
    schemas.validate("orchestration-transaction", transaction);
    assertTransactionBinding(transaction);
    await writeWorkspaceJson(workspace, transactionFile(transaction.transactionId), transaction);
    await ensureTransactionAbortedLedger(workspace, transaction);
    return transaction;
  });
}

/** A cancelled/failed Contract must fence recovery before any transaction-owned target is published. */
async function assertTransactionContractFence(
  workspace: LocalWorkspace,
  transaction: OrchestrationTransaction,
  auditOnlyRepair: boolean
): Promise<void> {
  const current = await readBoundRecord<TaskContract>(
    workspace, "orchestration-contract", contractFile(transaction.contractRef), "contractId", transaction.contractRef
  );
  // Once every mutable target is already the exact journaled target, recovery
  // is audit repair only: re-verify immutable proof, append missing effects,
  // and publish COMMITTED.  A later revocation/expiry must not strand a fully
  // completed business transition in PREPARED forever.
  if (auditOnlyRepair) return;
  if (current.status === "ACTIVE") {
    if (transaction.status === "PREPARED") await admitPersistedContractAuthority(workspace, current);
    return;
  }
  if (transaction.kind === "COMPLETION" && orchestrationRecordHash(current) === orchestrationRecordHash(transaction.nextContract)) {
    if (transaction.status === "PREPARED") await admitPersistedContractAuthority(workspace, current);
    return;
  }
  throw transactionError("ORCHESTRATION_TRANSACTION_CONTRACT_NOT_ACTIVE", "Orchestration transaction recovery is fenced because its Contract is no longer ACTIVE.", {
    transactionId: transaction.transactionId,
    contractRef: transaction.contractRef,
    contractStatus: current.status
  });
}

/** True only after every mutable business target already equals the journaled commit. */
export async function orchestrationTransactionTargetsAreIntended(
  workspace: LocalWorkspace,
  transaction: OrchestrationTransaction
): Promise<boolean> {
  const currentContract = await readBoundRecord<TaskContract>(
    workspace, "orchestration-contract", contractFile(transaction.contractRef), "contractId", transaction.contractRef
  );
  const currentRun = await readBoundRecord<OrchestrationRun>(
    workspace, "orchestration-run", runFile(transaction.runRef), "runId", transaction.runRef
  );
  if (orchestrationRecordHash(currentRun) !== orchestrationRecordHash(transaction.nextRun)) return false;
  if (transaction.kind === "COMPLETION") {
    return orchestrationRecordHash(currentContract) === orchestrationRecordHash(transaction.nextContract);
  }
  if (transaction.kind === "ESCALATION") return true;
  const currentSubtask = await readBoundRecord<SubtaskPackage>(
    workspace, "orchestration-subtask", subtaskFile(transaction.subtaskRef), "subtaskId", transaction.subtaskRef
  );
  return orchestrationRecordHash(currentSubtask) === orchestrationRecordHash(transaction.nextSubtask);
}

async function reverifyReviewTransactionArtifacts(workspace: LocalWorkspace, transaction: ReviewTransaction): Promise<void> {
  const observations = new Map<string, ValidatorReceipt["artifactObservations"][number]>();
  for (const receipt of transaction.validatorReceipts) {
    for (const observation of receipt.artifactObservations) {
      const existing = observations.get(observation.artifactId);
      if (existing !== undefined && canonical(existing) !== canonical(observation)) {
        throw transactionError("ORCHESTRATION_TRANSACTION_ARTIFACT_CONFLICT", "Prepared validator receipts disagree about an artifact observation.", {
          transactionId: transaction.transactionId,
          artifactId: observation.artifactId
        });
      }
      observations.set(observation.artifactId, observation);
    }
  }
  for (const observation of observations.values()) {
    const artifact = await readBoundRecord<Artifact>(
      workspace, "orchestration-artifact", artifactFile(observation.artifactId), "artifactId", observation.artifactId
    );
    if (
      artifact.runRef !== transaction.runRef || artifact.subtaskRef !== transaction.subtaskRef ||
      artifact.kind !== "file" || artifact.status !== "VERIFIED" || artifact.attempt !== transaction.attempt ||
      artifact.path !== observation.path || artifact.contentHash !== observation.expectedHash ||
      observation.expectedHash !== observation.observedHash
    ) {
      throw transactionError("ORCHESTRATION_TRANSACTION_ARTIFACT_CONFLICT", "Prepared review proof is no longer bound to the canonical current-attempt Artifact.", {
        transactionId: transaction.transactionId,
        artifactId: observation.artifactId
      });
    }
    await rehashArtifact(workspace, artifact, transaction.transactionId);
  }
}

async function reverifyCompletionTransactionArtifacts(workspace: LocalWorkspace, transaction: CompletionTransaction): Promise<void> {
  const check = transaction.nextRun.goalConsistency.at(-1);
  if (check === undefined || check.round !== transaction.round) {
    throw transactionError("ORCHESTRATION_TRANSACTION_BINDING_MISMATCH", "Completion transaction lacks its prepared round-consistency check.", {
      transactionId: transaction.transactionId
    });
  }
  const recordedArtifactIds = check.artifactRefs ?? [];
  const recordedReceiptIds = check.validatorReceiptIds ?? [];
  if (new Set(recordedArtifactIds).size !== recordedArtifactIds.length || new Set(recordedReceiptIds).size !== recordedReceiptIds.length) {
    throw transactionError("ORCHESTRATION_TRANSACTION_BINDING_MISMATCH", "Completion proof references must be unique.", {
      transactionId: transaction.transactionId
    });
  }

  const expectedArtifactIds: string[] = [];
  const expectedReceiptIds: string[] = [];
  for (const subtaskId of transaction.nextRun.subtasks) {
    const subtask = await readBoundRecord<SubtaskPackage>(
      workspace, "orchestration-subtask", subtaskFile(subtaskId), "subtaskId", subtaskId
    );
    if (subtask.runRef !== transaction.runRef || subtask.contractRef !== transaction.contractRef) {
      throw transactionError("ORCHESTRATION_TRANSACTION_BINDING_MISMATCH", "Completion subtask is not bound to its Run and Contract.", {
        transactionId: transaction.transactionId,
        subtaskId
      });
    }
    if (subtask.status !== "ACCEPTED") continue;

    const observations: ValidatorReceipt["artifactObservations"] = [];
    for (const artifactId of subtask.artifactRefs ?? []) {
      const artifact = await readBoundRecord<Artifact>(
        workspace, "orchestration-artifact", artifactFile(artifactId), "artifactId", artifactId
      );
      if (
        artifact.runRef !== transaction.runRef || artifact.subtaskRef !== subtaskId ||
        artifact.kind !== "file" || artifact.status !== "VERIFIED" || (artifact.attempt ?? 0) !== subtask.retriesUsed
      ) continue;
      expectedArtifactIds.push(artifactId);
      observations.push({
        artifactId,
        path: artifact.path,
        expectedHash: artifact.contentHash,
        observedHash: artifact.contentHash
      });
    }
    if (observations.length === 0) {
      throw transactionError("ORCHESTRATION_TRANSACTION_ARTIFACT_CONFLICT", "An accepted completion subtask has no current-attempt verified file Artifact.", {
        transactionId: transaction.transactionId,
        subtaskId
      });
    }

    let acceptedReview: ReviewRecord | undefined;
    for (const reviewId of [...(subtask.reviewRefs ?? [])].reverse()) {
      const review = await readBoundRecord<ReviewRecord>(
        workspace, "orchestration-review", reviewFile(reviewId), "reviewId", reviewId
      );
      if (review.decision === "ACCEPTED" && (review.attempt ?? 0) === subtask.retriesUsed) {
        acceptedReview = review;
        break;
      }
    }
    if (
      acceptedReview === undefined || acceptedReview.runRef !== transaction.runRef || acceptedReview.subtaskRef !== subtaskId ||
      !transaction.nextRun.reviews.includes(acceptedReview.reviewId) || !acceptedReview.validatorReceiptIds?.length
    ) {
      throw transactionError("ORCHESTRATION_TRANSACTION_RECEIPT_CONFLICT", "An accepted completion subtask lacks its bound accepted Review and validator receipts.", {
        transactionId: transaction.transactionId,
        subtaskId
      });
    }

    let byteValidatorSeen = false;
    for (const receiptId of acceptedReview.validatorReceiptIds) {
      const receipt = await getValidatorReceipt(workspace, receiptId);
      assertValidatorReceiptBinding(receipt, {
        runRef: transaction.runRef,
        subtaskRef: subtaskId,
        reviewRef: acceptedReview.reviewId,
        attempt: subtask.retriesUsed
      });
      if (
        receipt.status !== "PASSED" || receipt.round !== acceptedReview.round ||
        receipt.storageBoundary !== "JOURNALED_TRANSACTION" ||
        receipt.receiptId !== validatorReceiptId(acceptedReview.reviewId, receipt.validatorId, receipt.validatorVersion)
      ) {
        throw transactionError("ORCHESTRATION_TRANSACTION_RECEIPT_CONFLICT", "A completion validator receipt is not a passed, deterministic journal proof for its accepted Review.", {
          transactionId: transaction.transactionId,
          receiptId
        });
      }
      expectedReceiptIds.push(receiptId);
      if (receipt.validatorId === "artifact-bytes") {
        byteValidatorSeen = true;
        const expected = new Map(observations.map((observation) => [observation.artifactId, observation]));
        if (receipt.artifactObservations.length !== expected.size || receipt.artifactObservations.some((observation) => {
          const current = expected.get(observation.artifactId);
          return current === undefined || canonical(current) !== canonical(observation);
        })) {
          throw transactionError("ORCHESTRATION_TRANSACTION_RECEIPT_CONFLICT", "The completion byte-validator receipt does not match the exact current accepted Artifact set.", {
            transactionId: transaction.transactionId,
            receiptId
          });
        }
      }
    }
    if (!byteValidatorSeen) {
      throw transactionError("ORCHESTRATION_TRANSACTION_RECEIPT_CONFLICT", "An accepted completion Review lacks the mandatory artifact-bytes validator receipt.", {
        transactionId: transaction.transactionId,
        subtaskId
      });
    }
  }

  if (canonical([...new Set(expectedArtifactIds)].sort()) !== canonical([...recordedArtifactIds].sort())) {
    throw transactionError("ORCHESTRATION_TRANSACTION_ARTIFACT_CONFLICT", "Completion Artifact references are not the exact current accepted Artifact set.", {
      transactionId: transaction.transactionId
    });
  }
  if (canonical([...new Set(expectedReceiptIds)].sort()) !== canonical([...recordedReceiptIds].sort())) {
    throw transactionError("ORCHESTRATION_TRANSACTION_RECEIPT_CONFLICT", "Completion validator receipt references are not the exact current accepted Review receipt set.", {
      transactionId: transaction.transactionId
    });
  }

  for (const artifactId of recordedArtifactIds) {
    const artifact = await readBoundRecord<Artifact>(
      workspace, "orchestration-artifact", artifactFile(artifactId), "artifactId", artifactId
    );
    if (artifact.runRef !== transaction.runRef || artifact.kind !== "file" || artifact.status !== "VERIFIED") {
      throw transactionError("ORCHESTRATION_TRANSACTION_ARTIFACT_CONFLICT", "Prepared completion proof is no longer bound to a verified file Artifact in this Run.", {
        transactionId: transaction.transactionId,
        artifactId
      });
    }
    await rehashArtifact(workspace, artifact, transaction.transactionId);
  }
}

async function rehashArtifact(workspace: LocalWorkspace, artifact: Artifact, transactionId: string): Promise<void> {
  const cfg = await loadOrchestrationConfig(workspace);
  await resolveWorkspacePath(workspace.root, artifact.path, {
    ...(cfg.sensitiveExtraPaths === undefined ? {} : { sensitiveExtraPaths: cfg.sensitiveExtraPaths })
  });
  let bytes: Buffer;
  try {
    bytes = (await readBoundedWorkspaceFile(workspace.root, artifact.path, MAX_ARTIFACT_BYTES)).bytes;
  } catch (error: unknown) {
    if (isCode(error, "ENOENT")) {
      throw transactionError("ORCHESTRATION_TRANSACTION_ARTIFACT_STALE", "A prepared transaction Artifact no longer exists.", {
        transactionId,
        artifactId: artifact.artifactId,
        path: artifact.path
      });
    }
    if (error instanceof WorkspaceReadBoundaryError) {
      throw transactionError("ORCHESTRATION_TRANSACTION_ARTIFACT_STALE", "A prepared transaction Artifact no longer satisfies the bounded regular-file read contract.", {
        transactionId,
        artifactId: artifact.artifactId,
        path: artifact.path,
        reason: error.reason,
        maxBytes: MAX_ARTIFACT_BYTES
      });
    }
    throw error;
  }
  const currentHash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (currentHash !== artifact.contentHash) {
    throw transactionError("ORCHESTRATION_TRANSACTION_ARTIFACT_STALE", "Artifact bytes changed after the orchestration transaction was prepared.", {
      transactionId,
      artifactId: artifact.artifactId,
      path: artifact.path,
      expectedHash: artifact.contentHash,
      currentHash
    });
  }
}

/** Test-only, single-use crash point. No production path reads an environment-controlled fault value. */
export function injectOrchestrationTransactionFaultForTesting(
  workspace: LocalWorkspace,
  point: OrchestrationTransactionFaultPoint
): void {
  if (process.env.NODE_ENV !== "test") {
    throw transactionError("ORCHESTRATION_TEST_FAULT_DENIED", "Transaction fault injection is available only under the test runner.");
  }
  injectedFaults.set(workspace.directory, point);
}

export function clearOrchestrationTransactionFaultForTesting(workspace: LocalWorkspace): void {
  injectedFaults.delete(workspace.directory);
}

function assertTransactionBinding(transaction: OrchestrationTransaction): void {
  const expectedId = transaction.kind === "REVIEW"
    ? reviewTransactionId(transaction.runRef, transaction.subtaskRef, transaction.attempt)
    : transaction.kind === "COMPLETION"
      ? completionTransactionId(transaction.runRef, transaction.round)
      : escalationTransactionId(transaction.runRef, transaction.escalationGeneration);
  if (transaction.transactionId !== expectedId) {
    throw transactionError("ORCHESTRATION_TRANSACTION_BINDING_MISMATCH", "Transaction ID is not bound to its run/subtask/attempt or completion round.", {
      transactionId: transaction.transactionId,
      expectedId
    });
  }
  if (transaction.nextRun.runId !== transaction.runRef || transaction.nextRun.contractRef !== transaction.contractRef) {
    throw transactionError("ORCHESTRATION_TRANSACTION_BINDING_MISMATCH", "Transaction nextRun is not bound to the journal run and Contract.", {
      transactionId: transaction.transactionId
    });
  }
  if (orchestrationRecordHash(transaction.nextRun) === transaction.sourceRunHash) {
    throw transactionError("ORCHESTRATION_TRANSACTION_NOOP", "An orchestration transaction cannot persist a no-op Run transition.", {
      transactionId: transaction.transactionId
    });
  }
  const effectIds = new Set<string>();
  for (const effect of transaction.ledgerEffects) {
    if (effectIds.has(effect.effectId)) {
      throw transactionError("ORCHESTRATION_TRANSACTION_BINDING_MISMATCH", "Transaction ledger effect IDs must be unique.", {
        transactionId: transaction.transactionId,
        effectId: effect.effectId
      });
    }
    effectIds.add(effect.effectId);
    const marker = ledgerMarker(transaction.transactionId, effect.effectId);
    if (
      effect.contractRef !== transaction.contractRef || effect.runRef !== transaction.runRef ||
      !effect.summary.endsWith(marker)
    ) {
      throw transactionError("ORCHESTRATION_TRANSACTION_BINDING_MISMATCH", "Transaction ledger effect is not bound to the journal identity.", {
        transactionId: transaction.transactionId,
        effectId: effect.effectId
      });
    }
  }

  if (transaction.kind === "REVIEW") {
    const expectedReviewId = reviewIdForTransaction(transaction.transactionId);
    if (
      transaction.reviewRef !== expectedReviewId || transaction.review.reviewId !== expectedReviewId ||
      transaction.review.runRef !== transaction.runRef || transaction.review.subtaskRef !== transaction.subtaskRef ||
      transaction.review.round !== transaction.round || transaction.review.attempt !== transaction.attempt ||
      transaction.nextSubtask.subtaskId !== transaction.subtaskRef || transaction.nextSubtask.runRef !== transaction.runRef ||
      transaction.nextSubtask.contractRef !== transaction.contractRef || !transaction.nextRun.reviews.includes(expectedReviewId) ||
      !transaction.nextSubtask.reviewRefs?.includes(expectedReviewId)
    ) {
      throw transactionError("ORCHESTRATION_TRANSACTION_BINDING_MISMATCH", "Review transaction outputs are not bound to the journal generation.", {
        transactionId: transaction.transactionId
      });
    }
    const receiptIds = transaction.validatorReceipts.map((receipt) => receipt.receiptId);
    if (canonical(receiptIds) !== canonical(transaction.review.validatorReceiptIds ?? [])) {
      throw transactionError("ORCHESTRATION_TRANSACTION_BINDING_MISMATCH", "Review receipt references do not match the transaction receipts.", {
        transactionId: transaction.transactionId
      });
    }
    for (const receipt of transaction.validatorReceipts) {
      assertValidatorReceiptBinding(receipt, {
        runRef: transaction.runRef,
        subtaskRef: transaction.subtaskRef,
        reviewRef: transaction.reviewRef,
        attempt: transaction.attempt
      });
      if (
        receipt.round !== transaction.round || receipt.storageBoundary !== "JOURNALED_TRANSACTION" ||
        receipt.receiptId !== validatorReceiptId(transaction.reviewRef, receipt.validatorId, receipt.validatorVersion)
      ) {
        throw transactionError("ORCHESTRATION_TRANSACTION_BINDING_MISMATCH", "Validator receipt identity is not deterministic for the review transaction.", {
          transactionId: transaction.transactionId,
          receiptId: receipt.receiptId
        });
      }
    }
  } else if (transaction.kind === "COMPLETION") {
    if (
      transaction.nextContract.contractId !== transaction.contractRef ||
      transaction.nextRun.round !== transaction.round + 1
    ) {
      throw transactionError("ORCHESTRATION_TRANSACTION_BINDING_MISMATCH", "Completion transaction outputs are not bound to the source round and Contract.", {
        transactionId: transaction.transactionId
      });
    }
  } else if (
    transaction.nextRun.status !== "ESCALATED" ||
    transaction.nextRun.round !== transaction.round ||
    transaction.escalationGeneration !== (transaction.nextRun.resumeGeneration ?? 0) + 1 ||
    typeof transaction.nextRun.escalationReason !== "string" || transaction.nextRun.escalationReason.length === 0
  ) {
    throw transactionError("ORCHESTRATION_TRANSACTION_BINDING_MISMATCH", "Escalation transaction output is not bound to its Run generation and reason.", {
      transactionId: transaction.transactionId,
      escalationGeneration: transaction.escalationGeneration
    });
  }
}

async function persistImmutableRecord<T extends object>(
  workspace: LocalWorkspace,
  kind: ContractKind,
  file: string,
  idField: string,
  expectedId: string,
  intended: T
): Promise<void> {
  try {
    await createWorkspaceJson(workspace, file, intended);
  } catch (error: unknown) {
    if (!isCode(error, "EEXIST")) throw error;
    const existing = await readBoundRecord<T>(workspace, kind, file, idField, expectedId);
    if (orchestrationRecordHash(existing) !== orchestrationRecordHash(intended)) {
      throw transactionError("ORCHESTRATION_TRANSACTION_TARGET_CONFLICT", "An immutable transaction target already contains different data.", {
        kind,
        expectedId
      });
    }
  }
}

async function reconcileMutableRecord<T extends object>(
  workspace: LocalWorkspace,
  kind: ContractKind,
  file: string,
  idField: string,
  expectedId: string,
  sourceHash: string,
  intended: T
): Promise<void> {
  const current = await readBoundRecord<T>(workspace, kind, file, idField, expectedId);
  const currentHash = orchestrationRecordHash(current);
  const intendedHash = orchestrationRecordHash(intended);
  if (currentHash === intendedHash) return;
  if (currentHash !== sourceHash) {
    throw transactionError("ORCHESTRATION_TRANSACTION_TARGET_CONFLICT", "A mutable transaction target is neither the prepared source nor the intended committed state.", {
      kind,
      expectedId,
      sourceHash,
      currentHash,
      intendedHash
    });
  }
  await writeWorkspaceJson(workspace, file, intended);
  const written = await readBoundRecord<T>(workspace, kind, file, idField, expectedId);
  if (orchestrationRecordHash(written) !== intendedHash) {
    throw transactionError("ORCHESTRATION_TRANSACTION_WRITE_MISMATCH", "A transaction target did not persist the intended canonical bytes.", {
      kind,
      expectedId
    });
  }
}

async function readBoundRecord<T extends object>(
  workspace: LocalWorkspace,
  kind: ContractKind,
  file: string,
  idField: string,
  expectedId: string
): Promise<T> {
  const parsed: unknown = JSON.parse(await readFile(await workspaceFile(workspace, file), "utf8"));
  (await defaultSchemaRegistry()).validate(kind, parsed);
  const record = parsed as Record<string, unknown>;
  if (record[idField] !== expectedId) {
    throw transactionError("ORCHESTRATION_TRANSACTION_TARGET_ID_MISMATCH", "Transaction target embedded ID does not match its canonical path.", {
      kind,
      expectedId,
      storedId: record[idField]
    });
  }
  return parsed as T;
}

async function appendLedgerEffectIdempotently(workspace: LocalWorkspace, effect: OrchestrationLedgerEffect): Promise<void> {
  const existing = (await listLedgerEntries(workspace)).find((entry) => ledgerEntryMatchesEffect(entry, effect));
  if (existing !== undefined) return;
  const { effectId: _effectId, ...entry } = effect;
  await appendLedgerEntry(workspace, entry);
}

async function appendLedgerEntryIdempotently(workspace: LocalWorkspace, entry: AppendLedgerEntry): Promise<void> {
  const prepared = prepareLedgerEntry(entry);
  const existing = (await listLedgerEntries(workspace)).some((candidate) =>
    candidate.event === prepared.event && candidate.summary === prepared.summary &&
    LEDGER_OPTIONAL_FIELDS.every((field) => candidate[field] === prepared[field])
  );
  if (existing) return;
  await appendLedgerEntry(workspace, prepared);
}

async function ensureTransactionAbortedLedger(
  workspace: LocalWorkspace,
  transaction: OrchestrationTransaction
): Promise<void> {
  await appendLedgerEntryIdempotently(workspace, {
    event: "orchestration-transaction-aborted",
    taskId: transaction.ledgerEffects[0]!.taskId,
    contractRef: transaction.contractRef,
    runRef: transaction.runRef,
    round: transaction.round,
    summary: `Prepared transaction identity ${auditTextFingerprint(transaction.transactionId)} aborted by durable Run cancellation.`
  });
}

function ledgerEntryMatchesEffect(entry: LedgerEntry, effect: OrchestrationLedgerEffect): boolean {
  if (entry.event !== effect.event || entry.summary !== effect.summary) return false;
  return LEDGER_OPTIONAL_FIELDS.every((field) => entry[field] === effect[field]);
}

function maybeInjectFault(workspace: LocalWorkspace, point: OrchestrationTransactionFaultPoint, transactionId: string): void {
  if (injectedFaults.get(workspace.directory) !== point) return;
  injectedFaults.delete(workspace.directory);
  throw transactionError("ORCHESTRATION_TRANSACTION_TEST_FAULT", `Injected orchestration transaction fault at ${point}.`, {
    transactionId,
    point
  });
}

function deterministicId(prefix: string, parts: readonly unknown[]): string {
  const digest = createHash("sha256").update(JSON.stringify([prefix, ...parts])).digest("hex");
  return `${prefix}-${digest.slice(0, 48)}`;
}

function ledgerMarker(transactionId: string, effectId: string): string {
  // Ledger summaries deliberately avoid long token-like runs. The persisted
  // transaction ID remains unchanged; only its audit-display form is grouped.
  const grouped = groupLongHexRuns(transactionId);
  return `[orchestration-txn:${grouped};effect:${effectId}]`;
}

function groupLongHexRuns(value: string): string {
  return value.replace(/[0-9a-f]{24,}/g, (token) => token.match(/.{1,12}/g)?.join("-") ?? token);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function transactionFile(transactionId: string): string { return path.join(DIRECTORY, `${TRANSACTION_PREFIX}${transactionId}.json`); }
function contractFile(contractId: string): string { return path.join(DIRECTORY, `${contractId}.json`); }
function runFile(runId: string): string { return path.join(DIRECTORY, `${runId}.json`); }
function subtaskFile(subtaskId: string): string { return path.join(DIRECTORY, `${subtaskId}.json`); }
function reviewFile(reviewId: string): string { return path.join(DIRECTORY, `${reviewId}.json`); }
function artifactFile(artifactId: string): string { return path.join(DIRECTORY, `${artifactId}.json`); }

function assertId(id: string, code: string): void {
  if (!ID_PATTERN.test(id)) throw transactionError(code, "Invalid orchestration transaction identifier.", { id });
}

function transactionError(code: string, message: string, details: Record<string, unknown> = {}): StinkyCobblerError {
  return new StinkyCobblerError(code, ExitCode.VALIDATION, message, details);
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
