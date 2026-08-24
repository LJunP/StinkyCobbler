import { createHash, randomUUID } from "node:crypto";
import { COPYFILE_EXCL } from "node:constants";
import { copyFile, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CapabilityLease, EvidenceRef } from "../contracts/types.js";
import type { SchemaRegistry } from "../contracts/schema-registry.js";
import { ExitCode, StinkyCobblerError } from "../errors.js";
import { evaluateLease } from "../policy/evaluate.js";
import { isSensitivePath, isForbiddenWriteTarget, targetInWriteSet } from "../policy/path-policy.js";
import { loadOrchestrationConfig, type OrchestrationConfig } from "../config/tiered.js";
import { appendLedgerEntry, listLedgerEntries } from "./ledger.js";
import { listEvidence, recordEvidence } from "./evidence.js";
import type { LocalWorkspace } from "./workspace.js";
import { createWorkspaceDirectory, workspaceFile, writeWorkspaceJson } from "./workspace.js";
import { withWorkspaceLock } from "./workspace-lock.js";
import { getWriteIntent, type WriteIntentRecord } from "./write-intents.js";
import { resolveWorkspacePath } from "../security/workspace-path.js";
import { getLease } from "./leases.js";
import { evaluateLeaseSubtaskBinding, releasePersistedLeaseCall, reservePersistedLeaseCall } from "./lease-usage.js";
import { admitPersistedLeaseAuthority, admitTaskCapability, TASK_AUTHORITY_POLICY_VERSION } from "./task-authority.js";
import { getApproval } from "./approvals.js";
import { isApprovalExpired } from "../policy/approval.js";
import { hashWriteIntentSubject } from "./write-intents.js";

const BACKUPS_DIRECTORY = "backups";
const MAX_CONTENT_BYTES = 1024 * 1024;

export interface ApplyWriteResult {
  evidenceId: string;
  target: string;
  backupPath?: string;
}

export interface ApplyDeleteResult {
  evidenceId: string;
  target: string;
  backupPath: string;
}

export interface ApplyRecoveryResult {
  outcome: "APPLIED" | "READY_TO_RETRY" | "ALREADY_APPLIED";
  writeIntent: WriteIntentRecord;
  target: string;
  evidenceId?: string;
  backupPath?: string;
}

const MCP_RESERVED_WRITE = Symbol("mcp-reserved-write");
type WriteAdmissionContext = typeof MCP_RESERVED_WRITE;

/**
 * Applies one confirmed delete: validates the write lease and the confirmed
 * delete intent, backs up the target file, removes it, records file Evidence
 * (hash of the pre-delete content), appends a `delete-applied` ledger event,
 * and marks the intent APPLIED. Deletes are never auto-allowed; rollback
 * restores the file from the backup.
 */
export async function applyDelete(
  workspace: LocalWorkspace,
  schemas: SchemaRegistry,
  lease: CapabilityLease,
  writeIntent: WriteIntentRecord,
  target: string,
  admission?: WriteAdmissionContext
): Promise<ApplyDeleteResult> {
  return withWorkspaceLock(workspace, async () => {
    let directReservation: number | undefined;
    let businessFileChanged = false;
    try {
    const cfg = await loadOrchestrationConfig(workspace);
    // Storage is authoritative: re-read the intent so stale in-memory copies cannot bypass APPLIED state.
    const current = await getWriteIntent(workspace, writeIntent.writeIntentId);
    assertNotRecoveryRequired(current);
    const authoritativeLease = await loadAuthoritativeWriteLease(workspace, lease);
    schemas.validate("lease", authoritativeLease);
    await admitPersistedLeaseAuthority(workspace, authoritativeLease, ["repository-write"]);
    const decision = evaluateLease(authoritativeLease, { taskId: authoritativeLease.taskId, role: authoritativeLease.role, workspace: workspace.root, capability: "repository-write" });
    if (!decision.allowed) throw writeError("WRITE_LEASE_DENIED", decision.reasons[0] ?? "Write lease denied.");
    const subtaskDecision = await evaluateLeaseSubtaskBinding(workspace, authoritativeLease);
    if (!subtaskDecision.allowed) throw writeError("WRITE_LEASE_DENIED", subtaskDecision.reasons[0] ?? "Write lease subtask binding denied.");
    if (admission !== MCP_RESERVED_WRITE) {
      const reservation = await reservePersistedLeaseCall(workspace, authoritativeLease.id);
      if (!reservation.allowed) throw writeError("WRITE_LEASE_DENIED", "Lease tool-call limit has been reached.");
      directReservation = reservation.used;
    }
    if (!targetInWriteSet(authoritativeLease.writeSet, target)) throw writeError("WRITE_TARGET_NOT_IN_LEASE", "Target is outside the write lease writeSet.", { target });
    if (current.status === "APPLIED") throw writeError("WRITE_ALREADY_APPLIED", "This write request has already been applied.", { writeIntentId: current.writeIntentId });
    if (current.status !== "CONFIRMED") throw writeError("WRITE_INTENT_NOT_CONFIRMED", "The write request must be CONFIRMED before applying.", { writeIntentId: current.writeIntentId, status: current.status });
    assertSingleTargetIntent(current, target);
    await assertIntentAuthority(workspace, current, authoritativeLease);
    const intentAction = current.writes[0]?.action;
    if (intentAction !== "delete") throw writeError("WRITE_ACTION_MISMATCH", "Target is not a delete intent.", { target, action: intentAction });
    assertTarget(target, cfg);
    await assertActiveIntentBinding(workspace, current, authoritativeLease);

    const resolvedTarget = await resolveWriteTarget(workspace, target, cfg, true);
    if (!resolvedTarget.exists) throw writeError("WRITE_TARGET_MISSING", "Delete target does not exist.", { target });
    if (resolvedTarget.stat?.isFile() !== true) throw writeError("WRITE_TARGET_INVALID", "Delete target must be a regular file.", { target });
    assertPrivateRegularStat(resolvedTarget.stat, target);
    const absoluteTarget = resolvedTarget.absolutePath;
    await assertExpectedPreimage(current, resolvedTarget.exists ? absoluteTarget : undefined, target);

    // Backup first; the delete target must exist (unlike create, ENOENT is an error).
    let backupPath: string;
    const backupRelativePath = backupFileName(current.writeIntentId, target);
    try {
      backupPath = await prepareBackupPath(workspace, writeIntent.writeIntentId, target);
      await copyBackup(absoluteTarget, backupPath, target);
    } catch (error: unknown) {
      if (!isCode(error, "ENOENT")) throw error;
      throw writeError("WRITE_TARGET_MISSING", "Delete target does not exist.", { target });
    }

    const recoveryCurrent: WriteIntentRecord = {
      ...current,
      status: "RECOVERY_REQUIRED",
      recoveryJournal: {
        state: "UNCERTAIN",
        operation: "delete",
        target,
        expectedPreimageHash: current.expectedPreimageHash,
        preImageMissing: false,
        postImageHash: null,
        backupPath: backupRelativePath,
        startedAt: new Date().toISOString()
      }
    };
    await writeWorkspaceJson(workspace, `write-intents/${current.writeIntentId}.json`, recoveryCurrent);

    await assertPrivateRegularFile(absoluteTarget, target);
    await rm(absoluteTarget, { force: true });
    businessFileChanged = true;

    const completed = await completeApplyRecovery(workspace, schemas, recoveryCurrent);
    return { evidenceId: completed.evidenceId!, target, backupPath: backupRelativePath };
    } catch (error: unknown) {
      if (!businessFileChanged && directReservation !== undefined) await releasePersistedLeaseCall(workspace, lease.id, directReservation).catch(() => false);
      throw error;
    }
  });
}

/**
 * Applies one confirmed write: validates the write lease and the confirmed
 * intent, backs up the previous file, atomically writes the content, records
 * file Evidence, appends a `write-applied` ledger event, and marks the intent
 * APPLIED. Content semantics are the host's responsibility; this only enforces
 * target, lease, and size bounds.
 */
export async function applyWrite(
  workspace: LocalWorkspace,
  schemas: SchemaRegistry,
  lease: CapabilityLease,
  writeIntent: WriteIntentRecord,
  target: string,
  content: string,
  admission?: WriteAdmissionContext
): Promise<ApplyWriteResult> {
  return withWorkspaceLock(workspace, async () => {
    let directReservation: number | undefined;
    let businessFileChanged = false;
    try {
    const cfg = await loadOrchestrationConfig(workspace);
    const maxContentBytes = cfg.defaults?.maxWriteContentBytes ?? MAX_CONTENT_BYTES;
    // Storage is authoritative: re-read the intent so stale in-memory copies cannot bypass APPLIED state.
    const current = await getWriteIntent(workspace, writeIntent.writeIntentId);
    assertNotRecoveryRequired(current);
    const authoritativeLease = await loadAuthoritativeWriteLease(workspace, lease);
    schemas.validate("lease", authoritativeLease);
    await admitPersistedLeaseAuthority(workspace, authoritativeLease, ["repository-write"]);
    const decision = evaluateLease(authoritativeLease, { taskId: authoritativeLease.taskId, role: authoritativeLease.role, workspace: workspace.root, capability: "repository-write" });
    if (!decision.allowed) throw writeError("WRITE_LEASE_DENIED", decision.reasons[0] ?? "Write lease denied.");
    const subtaskDecision = await evaluateLeaseSubtaskBinding(workspace, authoritativeLease);
    if (!subtaskDecision.allowed) throw writeError("WRITE_LEASE_DENIED", subtaskDecision.reasons[0] ?? "Write lease subtask binding denied.");
    if (admission !== MCP_RESERVED_WRITE) {
      const reservation = await reservePersistedLeaseCall(workspace, authoritativeLease.id);
      if (!reservation.allowed) throw writeError("WRITE_LEASE_DENIED", "Lease tool-call limit has been reached.");
      directReservation = reservation.used;
    }
    if (!targetInWriteSet(authoritativeLease.writeSet, target)) throw writeError("WRITE_TARGET_NOT_IN_LEASE", "Target is outside the write lease writeSet.", { target });
    if (current.status === "APPLIED") throw writeError("WRITE_ALREADY_APPLIED", "This write request has already been applied.", { writeIntentId: current.writeIntentId });
    if (current.status !== "CONFIRMED") throw writeError("WRITE_INTENT_NOT_CONFIRMED", "The write request must be CONFIRMED before applying.", { writeIntentId: current.writeIntentId, status: current.status });
    assertSingleTargetIntent(current, target);
    await assertIntentAuthority(workspace, current, authoritativeLease);
    assertTarget(target, cfg);
    await assertActiveIntentBinding(workspace, current, authoritativeLease);
    if (typeof content !== "string") throw writeError("WRITE_CONTENT_INVALID", "Write content must be a string.");
    if (Buffer.byteLength(content, "utf8") > maxContentBytes) throw writeError("WRITE_CONTENT_INVALID", `Write content exceeds the ${maxContentBytes}-byte limit.`, { bytes: Buffer.byteLength(content, "utf8") });

    const intentAction = current.writes[0]?.action;
    if (intentAction !== "create" && intentAction !== "modify") throw writeError("WRITE_ACTION_MISMATCH", "Target is not a create or modify intent.", { target, action: intentAction });
    const resolvedTarget = await resolveWriteTarget(workspace, target, cfg, true);
    if (intentAction === "create" && resolvedTarget.exists) throw writeError("WRITE_TARGET_EXISTS", "Create target already exists.", { target });
    if (intentAction === "modify" && !resolvedTarget.exists) throw writeError("WRITE_TARGET_MISSING", "Modify target does not exist.", { target });
    if (resolvedTarget.exists && resolvedTarget.stat?.isFile() !== true) throw writeError("WRITE_TARGET_INVALID", "Write target must be a regular file.", { target });
    if (resolvedTarget.exists) assertPrivateRegularStat(resolvedTarget.stat, target);
    const absoluteTarget = resolvedTarget.absolutePath;
    await assertExpectedPreimage(current, resolvedTarget.exists ? absoluteTarget : undefined, target);
    if (current.proposedContentHash !== undefined) {
      const proposed = `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
      if (proposed !== current.proposedContentHash) throw writeError("WRITE_CONTENT_HASH_MISMATCH", "Write content does not match the approved proposed content hash.", { target });
    }

    const postImageHash = `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
    let backupPath: string | undefined;
    const backupRelativePath = resolvedTarget.exists ? backupFileName(current.writeIntentId, target) : undefined;
    if (resolvedTarget.exists) {
      backupPath = await prepareBackupPath(workspace, writeIntent.writeIntentId, target);
      await copyBackup(absoluteTarget, backupPath, target);
    }

    const recoveryCurrent: WriteIntentRecord = {
      ...current,
      status: "RECOVERY_REQUIRED",
      recoveryJournal: {
        state: "UNCERTAIN",
        operation: intentAction,
        target,
        expectedPreimageHash: current.expectedPreimageHash,
        preImageMissing: !resolvedTarget.exists,
        postImageHash,
        backupPath: backupRelativePath ?? null,
        startedAt: new Date().toISOString()
      }
    };
    await writeWorkspaceJson(workspace, `write-intents/${current.writeIntentId}.json`, recoveryCurrent);

    await mkdir(path.dirname(absoluteTarget), { recursive: true });
    const temporary = path.join(path.dirname(absoluteTarget), `.${path.basename(absoluteTarget)}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, absoluteTarget);
      businessFileChanged = true;
    } finally {
      await import("node:fs/promises").then(({ rm }) => rm(temporary, { force: true })).catch(() => undefined);
    }

    const completed = await completeApplyRecovery(workspace, schemas, recoveryCurrent);
    return { evidenceId: completed.evidenceId!, target, ...(backupRelativePath === undefined ? {} : { backupPath: backupRelativePath }) };
    } catch (error: unknown) {
      if (!businessFileChanged && directReservation !== undefined) await releasePersistedLeaseCall(workspace, lease.id, directReservation).catch(() => false);
      throw error;
    }
  });
}

/**
 * Explicitly reconciles a pre-mutation apply fence. Recovery never guesses:
 * an exact post-image is rolled forward, an exact pre-image is returned to
 * CONFIRMED for a fresh admission/retry, and every other byte state remains
 * RECOVERY_REQUIRED.
 */
export async function reconcileApplyWrite(
  workspace: LocalWorkspace,
  schemas: SchemaRegistry,
  writeIntentId: string
): Promise<ApplyRecoveryResult> {
  return withWorkspaceLock(workspace, async () => {
    const current = await getWriteIntent(workspace, writeIntentId);
    if (current.status === "APPLIED") {
      return { outcome: "ALREADY_APPLIED", writeIntent: current, target: current.appliedTarget ?? current.writes[0]!.target };
    }
    if (current.status !== "RECOVERY_REQUIRED" || current.recoveryJournal === undefined) {
      throw writeError("WRITE_APPLY_RECOVERY_NOT_FOUND", "WriteIntent has no apply recovery journal.", { writeIntentId, status: current.status });
    }
    if (current.rollbackRecoveryJournal !== undefined) {
      throw writeError("WRITE_APPLY_RECOVERY_NOT_FOUND", "WriteIntent is fenced for rollback recovery; use write rollback-recover.", { writeIntentId });
    }
    return completeApplyRecovery(workspace, schemas, current);
  });
}

async function completeApplyRecovery(
  workspace: LocalWorkspace,
  schemas: SchemaRegistry,
  intent: WriteIntentRecord
): Promise<ApplyRecoveryResult> {
  const journal = intent.recoveryJournal;
  if (intent.status !== "RECOVERY_REQUIRED" || journal === undefined) {
    throw writeError("WRITE_APPLY_RECOVERY_NOT_FOUND", "WriteIntent has no apply recovery journal.", { writeIntentId: intent.writeIntentId });
  }
  const write = intent.writes.length === 1 ? intent.writes[0] : undefined;
  if (
    write === undefined || write.target !== journal.target || write.action !== journal.operation ||
    intent.confirmedTargets?.length !== 1 || intent.confirmedTargets[0] !== journal.target ||
    intent.expectedPreimageHash !== journal.expectedPreimageHash ||
    (journal.operation === "create" && (journal.preImageMissing !== true || journal.expectedPreimageHash !== null || typeof journal.postImageHash !== "string" || journal.backupPath !== null)) ||
    (journal.operation === "modify" && (journal.preImageMissing !== false || typeof journal.expectedPreimageHash !== "string" || typeof journal.postImageHash !== "string" || journal.backupPath === null)) ||
    (journal.operation === "delete" && (journal.preImageMissing !== false || typeof journal.expectedPreimageHash !== "string" || journal.postImageHash !== null || journal.backupPath === null))
  ) {
    throw writeError("WRITE_APPLY_RECOVERY_JOURNAL_INVALID", "Apply recovery journal is inconsistent with its immutable WriteIntent subject.", { writeIntentId: intent.writeIntentId });
  }
  const expectedBackupPath = journal.operation === "create" ? null : backupFileName(intent.writeIntentId, journal.target);
  if (journal.backupPath !== expectedBackupPath) {
    throw writeError("WRITE_APPLY_RECOVERY_JOURNAL_INVALID", "Apply recovery backup path is not the canonical private backup for this WriteIntent.", { writeIntentId: intent.writeIntentId });
  }

  const cfg = await loadOrchestrationConfig(workspace);
  assertTarget(journal.target, cfg);
  const resolved = await resolveWriteTarget(workspace, journal.target, cfg, true);
  const observedHash = resolved.exists ? await hashPrivateTarget(resolved.absolutePath, journal.target) : null;
  const reachedPostImage = observedHash === journal.postImageHash;
  const stillAtPreImage = observedHash === journal.expectedPreimageHash;

  if (!reachedPostImage && !stillAtPreImage) {
    throw writeError("WRITE_APPLY_RECOVERY_CONFLICT", "Target matches neither the fenced pre-image nor post-image; recovery will not overwrite conflicting bytes.", {
      writeIntentId: intent.writeIntentId,
      target: journal.target,
      expectedPreimageHash: journal.expectedPreimageHash,
      postImageHash: journal.postImageHash,
      observedHash
    });
  }

  if (expectedBackupPath !== null) {
    const backupFile = await workspaceFile(workspace, expectedBackupPath);
    const backupHash = await readApplyBackupHash(backupFile, journal.target, !reachedPostImage);
    if (backupHash !== null && backupHash !== journal.expectedPreimageHash) {
      throw writeError("WRITE_APPLY_RECOVERY_JOURNAL_INVALID", "Apply recovery backup does not match the fenced pre-image.", { writeIntentId: intent.writeIntentId });
    }
    if (reachedPostImage && backupHash === null) {
      throw writeError("WRITE_APPLY_RECOVERY_JOURNAL_INVALID", "Applied modify/delete recovery requires its verified private backup.", { writeIntentId: intent.writeIntentId });
    }
    if (stillAtPreImage && backupHash !== null) await rm(backupFile);
  }

  if (stillAtPreImage && !reachedPostImage) {
    const { recoveryJournal: _journal, ...base } = intent;
    const retryable: WriteIntentRecord = { ...base, status: "CONFIRMED" };
    await writeWorkspaceJson(workspace, `write-intents/${intent.writeIntentId}.json`, retryable);
    return { outcome: "READY_TO_RETRY", writeIntent: retryable, target: journal.target };
  }

  const source = journal.operation === "delete" ? "repository-delete" : "repository-write";
  const evidenceHash = journal.operation === "delete" ? journal.expectedPreimageHash! : journal.postImageHash!;
  const ledgerEvent = journal.operation === "delete" ? "delete-applied" : "write-applied";
  const existingEvents = (await listLedgerEntries(workspace)).filter((entry) => entry.writeIntentRef === intent.writeIntentId && (entry.event === "write-applied" || entry.event === "delete-applied"));
  if (existingEvents.length > 1 || (existingEvents[0] !== undefined && existingEvents[0].event !== ledgerEvent)) {
    throw writeError("WRITE_APPLY_RECOVERY_AUDIT_CONFLICT", "Apply recovery found conflicting or duplicate terminal audit events.", { writeIntentId: intent.writeIntentId });
  }

  let saved: EvidenceRef | undefined;
  if (existingEvents[0]?.evidenceRef !== undefined) {
    saved = (await listEvidence(workspace)).find((item) => item.id === existingEvents[0]!.evidenceRef);
    if (saved === undefined || saved.source !== source || saved.locator !== journal.target || saved.contentHash !== evidenceHash) {
      throw writeError("WRITE_APPLY_RECOVERY_AUDIT_CONFLICT", "Existing apply audit does not reference matching Evidence.", { writeIntentId: intent.writeIntentId });
    }
    saved = await recordEvidence(workspace, schemas, saved);
  } else {
    const matching = (await listEvidence(workspace)).filter((item) =>
      item.source === source && item.locator === journal.target && item.contentHash === evidenceHash && item.toolCallId === `write-${intent.writeIntentId}`
    ).sort((left, right) => left.id.localeCompare(right.id));
    saved = await recordEvidence(workspace, schemas, matching[0] ?? {
      id: applyEvidenceId(intent.writeIntentId),
      kind: "file",
      source,
      locator: journal.target,
      contentHash: evidenceHash,
      observedAt: new Date().toISOString(),
      sensitivity: "internal",
      toolCallId: `write-${intent.writeIntentId}`
    });
    await appendLedgerEntry(workspace, {
      event: ledgerEvent,
      taskId: intent.taskId,
      writeIntentRef: intent.writeIntentId,
      evidenceRef: saved.id,
      summary: `${journal.operation === "delete" ? "Delete" : "Write"} ${intent.writeIntentId} applied to ${journal.target}.`
    });
  }

  const { recoveryJournal: _journal, ...base } = intent;
  const applied: WriteIntentRecord = {
    ...base,
    status: "APPLIED",
    appliedTarget: journal.target,
    preImageMissing: journal.preImageMissing,
    postImageHash: journal.postImageHash
  };
  await writeWorkspaceJson(workspace, `write-intents/${intent.writeIntentId}.json`, applied);
  return {
    outcome: "APPLIED",
    writeIntent: applied,
    target: journal.target,
    evidenceId: saved.id,
    ...(journal.backupPath === null ? {} : { backupPath: journal.backupPath })
  };
}

function applyEvidenceId(writeIntentId: string): string {
  const digest = createHash("sha256").update(writeIntentId, "utf8").digest("hex").slice(0, 32);
  return `evidence-apply-${digest.match(/.{1,8}/g)!.join("-")}`;
}

async function hashPrivateTarget(absolutePath: string, target: string): Promise<string> {
  try {
    const info = await lstat(absolutePath);
    assertPrivateRegularStat(info, target);
    return `sha256:${createHash("sha256").update(await readFile(absolutePath)).digest("hex")}`;
  } catch (error: unknown) {
    if (isCode(error, "ENOENT")) throw writeError("WRITE_APPLY_RECOVERY_CONFLICT", "Target disappeared during apply recovery inspection.", { target });
    throw error;
  }
}

async function readApplyBackupHash(backupFile: string, target: string, allowMissing: boolean): Promise<string | null> {
  try {
    const info = await lstat(backupFile);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
      throw writeError("WRITE_APPLY_RECOVERY_JOURNAL_INVALID", "Apply recovery backup must be one private regular file.", { target });
    }
    return `sha256:${createHash("sha256").update(await readFile(backupFile)).digest("hex")}`;
  } catch (error: unknown) {
    if (allowMissing && isCode(error, "ENOENT")) return null;
    if (isCode(error, "ENOENT")) throw writeError("WRITE_APPLY_RECOVERY_JOURNAL_INVALID", "Apply recovery backup is missing.", { target });
    throw error;
  }
}

function assertPrivateRegularStat(info: { isFile(): boolean; isSymbolicLink(): boolean; nlink: number } | undefined, target: string): void {
  if (info === undefined || !info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
    throw writeError("WRITE_TARGET_HARDLINK_DENIED", "Business write targets must be private regular files with exactly one hard link.", { target, nlink: info?.nlink });
  }
}

/** Internal MCP continuation: invokeControlled already reserved this attempt. */
export async function applyReservedMcpWrite(
  workspace: LocalWorkspace,
  schemas: SchemaRegistry,
  lease: CapabilityLease,
  writeIntent: WriteIntentRecord,
  target: string,
  content: string
): Promise<ApplyWriteResult> {
  return applyWrite(workspace, schemas, lease, writeIntent, target, content, MCP_RESERVED_WRITE);
}

/** Internal MCP continuation: invokeControlled already reserved this attempt. */
export async function applyReservedMcpDelete(
  workspace: LocalWorkspace,
  schemas: SchemaRegistry,
  lease: CapabilityLease,
  writeIntent: WriteIntentRecord,
  target: string
): Promise<ApplyDeleteResult> {
  return applyDelete(workspace, schemas, lease, writeIntent, target, MCP_RESERVED_WRITE);
}

function backupFileName(writeIntentId: string, target: string): string {
  return [BACKUPS_DIRECTORY, `write-${writeIntentId}`, ...target.split(/[\\/]/)].join("/");
}

async function prepareBackupPath(workspace: LocalWorkspace, writeIntentId: string, target: string): Promise<string> {
  const name = backupFileName(writeIntentId, target);
  const parts = name.split("/");
  for (let index = 1; index < parts.length; index += 1) {
    await createWorkspaceDirectory(workspace, parts.slice(0, index).join("/"));
  }
  // Re-resolve after directory creation so every current ancestor and the leaf
  // receive the control-plane symlink check immediately before copyFile.
  return workspaceFile(workspace, name);
}

async function copyBackup(source: string, destination: string, target: string): Promise<void> {
  try {
    await assertPrivateRegularFile(source, target);
    // Never overwrite a prior backup. It may be the only recoverable preimage
    // left by a crash after the business file changed but before APPLIED state.
    await copyFile(source, destination, COPYFILE_EXCL);
  } catch (error: unknown) {
    if (isCode(error, "EEXIST")) {
      throw writeError("WRITE_BACKUP_CONFLICT", "A backup already exists for this write; preserve it and diagnose the incomplete prior attempt before retrying.", { target });
    }
    throw error;
  }
}

async function assertPrivateRegularFile(absolutePath: string, target: string): Promise<void> {
  try {
    assertPrivateRegularStat(await lstat(absolutePath), target);
  } catch (error: unknown) {
    if (isCode(error, "ENOENT")) throw writeError("WRITE_TARGET_MISSING", "Write target no longer exists.", { target });
    throw error;
  }
}

function assertTarget(target: string, cfg?: OrchestrationConfig): void {
  if (!target || target.includes("\0") || target.startsWith("/") || target.split(/[\\/]/).includes("..")) throw writeError("WRITE_TARGET_INVALID", "Write targets must be workspace-relative paths.", { target });
  const lower = target.toLocaleLowerCase("en-US");
  if (lower === ".stinky-cobbler" || lower.startsWith(".stinky-cobbler/") || lower === ".git" || lower.startsWith(".git/")) throw writeError("WRITE_TARGET_FORBIDDEN", "Control-plane and git metadata paths are never writable.", { target });
  if (isSensitivePath(target, cfg?.sensitiveExtraPaths)) throw writeError("WRITE_TARGET_FORBIDDEN", "Sensitive paths are never writable.", { target });
  if (isForbiddenWriteTarget(target)) throw writeError("WRITE_TARGET_FORBIDDEN", "Executable and binary-derived targets are never writable.", { target });
}

function assertSingleTargetIntent(intent: WriteIntentRecord, target: string): void {
  if (intent.writes.length !== 1 || intent.confirmedTargets?.length !== 1 || intent.writes[0]?.target !== target || intent.confirmedTargets[0] !== target) {
    throw writeError("WRITE_INTENT_INVALID", "Only one storage-authoritative, exactly matching target may be applied per WriteIntent.", { target, writes: intent.writes.length, confirmedTargets: intent.confirmedTargets });
  }
}

function assertNotRecoveryRequired(intent: WriteIntentRecord): void {
  if (intent.status === "RECOVERY_REQUIRED") {
    throw writeError(
      "WRITE_RECOVERY_REQUIRED",
      "This write has an uncertain durable recovery journal; inspect the target and preserved pre/post-image data before any retry.",
      { writeIntentId: intent.writeIntentId, recoveryJournal: intent.recoveryJournal }
    );
  }
}

async function loadAuthoritativeWriteLease(workspace: LocalWorkspace, submitted: CapabilityLease): Promise<CapabilityLease> {
  const stored = await getLease(workspace, submitted.id).catch(() => undefined);
  if (stored === undefined || stored.id !== submitted.id) throw writeError("WRITE_LEASE_DENIED", "The write Lease must be persisted in this workspace.");
  return stored;
}

async function resolveWriteTarget(workspace: LocalWorkspace, target: string, cfg: OrchestrationConfig, allowMissing: boolean) {
  try {
    return await resolveWorkspacePath(workspace.root, target, {
      allowMissing,
      ...(cfg.sensitiveExtraPaths === undefined ? {} : { sensitiveExtraPaths: cfg.sensitiveExtraPaths })
    });
  } catch (error: unknown) {
    throw writeError("WRITE_TARGET_INVALID", error instanceof Error ? error.message : "Write target is invalid.", { target });
  }
}

async function assertActiveIntentBinding(workspace: LocalWorkspace, intent: WriteIntentRecord, lease: CapabilityLease): Promise<void> {
  if (
    intent.taskId !== lease.taskId || intent.taskAuthorityHash !== lease.taskAuthorityHash ||
    intent.policyVersion !== lease.policyVersion || intent.hostSessionId !== lease.hostSessionId
  ) {
    throw writeError("WRITE_AUTHORITY_BINDING_MISMATCH", "WriteIntent and Lease must share the exact Task authority, policy, and host session.", {
      writeIntentId: intent.writeIntentId,
      leaseId: lease.id
    });
  }
  if (intent.runRef === undefined && intent.subtaskRef === undefined) {
    if (lease.subtaskRef !== undefined) throw writeError("WRITE_BINDING_MISMATCH", "A subtask lease cannot apply a plan-step write intent.");
    const { assertCurrentPlanExecutionAuthority, getPlan } = await import("./plans.js");
    const plan = await getPlan(workspace, intent.planId);
    await assertCurrentPlanExecutionAuthority(workspace, plan);
    const step = plan.steps.find((candidate) => candidate.stepId === intent.stepId);
    if (plan.taskId !== lease.taskId || plan.status !== "EXECUTING" || step?.status !== "RUNNING") {
      throw writeError("WRITE_BINDING_MISMATCH", "Write intent requires its bound task, plan, and step to remain active.", { planId: intent.planId, stepId: intent.stepId });
    }
    return;
  }
  if (intent.runRef === undefined || intent.subtaskRef === undefined || lease.subtaskRef !== intent.subtaskRef) {
    throw writeError("WRITE_BINDING_MISMATCH", "Write intent, lease, run, and subtask bindings do not match.");
  }
  const { getRun, getSubtask, getContract } = await import("./orchestration.js");
  const run = await getRun(workspace, intent.runRef);
  const subtask = await getSubtask(workspace, intent.subtaskRef);
  const contract = await getContract(workspace, run.contractRef);
  const { getRunCancellationFence } = await import("./orchestration-fence.js");
  if (await getRunCancellationFence(workspace, run.runId)) {
    throw writeError("WRITE_BINDING_MISMATCH", "Write intent cannot execute for a cancelling or cancelled run.", { runRef: intent.runRef });
  }
  if ((run.status !== "RUNNING" && run.status !== "DEGRADED") || subtask.status !== "RUNNING" || subtask.runRef !== run.runId || subtask.contractRef !== run.contractRef || contract.taskId !== lease.taskId || intent.attempt === undefined || intent.attempt !== subtask.activeAttempt) {
    throw writeError("WRITE_BINDING_MISMATCH", "Write intent requires its bound run to remain executable and its subtask to remain RUNNING.", { runRef: intent.runRef, subtaskRef: intent.subtaskRef });
  }
}

async function assertIntentAuthority(workspace: LocalWorkspace, intent: WriteIntentRecord, lease: CapabilityLease): Promise<void> {
  if (
    intent.authorityConsumptionOwner !== intent.writeIntentId ||
    typeof intent.authorityApprovalRef !== "string" ||
    !Array.isArray(intent.authorityApprovalRefs) ||
    !intent.authorityApprovalRefs.includes(intent.authorityApprovalRef)
  ) {
    throw writeError("WRITE_REISSUE_REQUIRED", "This pre-2.0.1 WriteIntent remains readable/cancellable but cannot execute; request a new WriteIntent.", {
      writeIntentId: intent.writeIntentId
    });
  }
  let observedHash: string;
  try { observedHash = hashWriteIntentSubject(intent); }
  catch { throw writeError("WRITE_INTENT_INVALID", "Write intent lacks a complete immutable authority binding.", { writeIntentId: intent.writeIntentId }); }
  if (observedHash !== intent.intentHash) throw writeError("WRITE_INTENT_HASH_MISMATCH", "The persisted write intent immutable subject has changed.", { writeIntentId: intent.writeIntentId });
  // The intent and the execution Lease are independently authorized subjects.
  // Re-admit the persisted intent on every use so Task drift, Approval
  // revocation/consumption, parent inactivity, policy changes, and host-session
  // mismatches fail closed. The root capability Approval remains owned by this
  // exact WriteIntent; the independently admitted execution Lease cannot reuse
  // or replace that ownership.
  const authority = await admitTaskCapability(workspace, {
    taskId: intent.taskId,
    capability: "repository-write",
    readScope: intent.writes.map((write) => write.target),
    writeSet: intent.writes.map((write) => write.target),
    approvalRefs: [intent.authorityApprovalRef],
    parentGrantRef: intent.parentGrantRef,
    expectedTaskAuthorityHash: intent.taskAuthorityHash,
    policyVersion: intent.policyVersion,
    maxToolCalls: 1,
    hostSessionId: intent.hostSessionId,
    allowApprovalScopeSuperset: true,
    approvalConsumptionOwner: intent.authorityConsumptionOwner
  });
  if (authority.matchedApprovalRef !== intent.authorityApprovalRef) {
    throw writeError("WRITE_REISSUE_REQUIRED", "WriteIntent capability Approval no longer resolves to its exact persisted authority binding.", {
      writeIntentId: intent.writeIntentId,
      authorityApprovalRef: intent.authorityApprovalRef
    });
  }
  if (intent.autoAllowed === true) return;
  if (intent.approvalRef === undefined) throw writeError("WRITE_CONFIRMATION_REQUIRED", "A non-auto write intent requires a consumed precise Approval.", { writeIntentId: intent.writeIntentId });
  const approval = await getApproval(workspace, intent.approvalRef);
  if (
    approval.status !== "approved" || isApprovalExpired(approval) ||
    approval.action !== "write-confirm" || approval.subjectKind !== "write-intent" ||
    approval.subjectId !== intent.writeIntentId || approval.subjectVersion !== intent.version ||
    approval.subjectHash !== intent.intentHash || approval.capability !== "repository-write" ||
    approval.policyVersion !== TASK_AUTHORITY_POLICY_VERSION || approval.expectedPreimageHash !== intent.expectedPreimageHash ||
    approval.consumedBy !== intent.writeIntentId || approval.consumedAt === undefined
  ) throw writeError("WRITE_APPROVAL_INVALID", "The precise write Approval is missing, stale, revoked, expired, or bound to another subject.", { writeIntentId: intent.writeIntentId, approvalRef: intent.approvalRef });
}

async function assertExpectedPreimage(intent: WriteIntentRecord, absoluteTarget: string | undefined, target: string): Promise<void> {
  let observed: string | null = null;
  if (absoluteTarget !== undefined) {
    try {
      await assertPrivateRegularFile(absoluteTarget, target);
      observed = `sha256:${createHash("sha256").update(await readFile(absoluteTarget)).digest("hex")}`;
    }
    catch (error: unknown) {
      if (!isCode(error, "ENOENT")) throw error;
      observed = null;
    }
  }
  if (observed !== intent.expectedPreimageHash) {
    throw writeError("WRITE_PREIMAGE_MISMATCH", "Target bytes changed after approval; request and approve a new WriteIntent.", {
      target,
      expectedPreimageHash: intent.expectedPreimageHash,
      observedPreimageHash: observed
    });
  }
}

function writeError(code: string, message: string, details: Record<string, unknown> = {}): StinkyCobblerError { return new StinkyCobblerError(code, ExitCode.VALIDATION, message, details); }
function isCode(error: unknown, code: string): boolean { return typeof error === "object" && error !== null && "code" in error && error.code === code; }
