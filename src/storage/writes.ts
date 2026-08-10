import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CapabilityLease, EvidenceRef } from "../contracts/types.js";
import type { SchemaRegistry } from "../contracts/schema-registry.js";
import { ExitCode, StinkyCobblerError } from "../errors.js";
import { evaluateLease } from "../policy/evaluate.js";
import { isSensitivePath, isForbiddenWriteTarget, targetInWriteSet } from "../policy/path-policy.js";
import { appendLedgerEntry } from "./ledger.js";
import { recordEvidence } from "./evidence.js";
import type { LocalWorkspace } from "./workspace.js";
import { writeWorkspaceJson } from "./workspace.js";
import { withWorkspaceLock } from "./workspace-lock.js";
import { getWriteIntent, type WriteIntentRecord } from "./write-intents.js";

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
  target: string
): Promise<ApplyDeleteResult> {
  return withWorkspaceLock(workspace, async () => {
    // Storage is authoritative: re-read the intent so stale in-memory copies cannot bypass APPLIED state.
    const current = await getWriteIntent(workspace, writeIntent.writeIntentId);
    const decision = evaluateLease(lease, { taskId: lease.taskId, role: lease.role, workspace: workspace.root, capability: "repository-write" });
    if (!decision.allowed) throw writeError("WRITE_LEASE_DENIED", decision.reasons[0] ?? "Write lease denied.");
    if (!targetInWriteSet(lease.writeSet, target)) throw writeError("WRITE_TARGET_NOT_IN_LEASE", "Target is outside the write lease writeSet.", { target });
    if (current.status === "APPLIED") throw writeError("WRITE_ALREADY_APPLIED", "This write request has already been applied.", { writeIntentId: current.writeIntentId });
    if (current.status !== "CONFIRMED") throw writeError("WRITE_INTENT_NOT_CONFIRMED", "The write request must be CONFIRMED before applying.", { writeIntentId: current.writeIntentId, status: current.status });
    if (!(current.confirmedTargets ?? []).includes(target)) throw writeError("WRITE_TARGET_NOT_CONFIRMED", "Target was not part of the confirmed write targets.", { target, confirmedTargets: current.confirmedTargets });
    const intentAction = current.writes.find((write) => write.target === target)?.action;
    if (intentAction !== "delete") throw writeError("WRITE_ACTION_MISMATCH", "Target is not a delete intent.", { target, action: intentAction });
    assertTarget(target);

    const absoluteTarget = path.resolve(workspace.root, target);
    if (!absoluteTarget.startsWith(`${workspace.root}${path.sep}`)) throw writeError("WRITE_TARGET_INVALID", "Write target escapes the workspace.", { target });

    // Backup first; the delete target must exist (unlike create, ENOENT is an error).
    let backupPath: string;
    let contentHash: string;
    try {
      const backupDirectory = path.join(workspace.directory, BACKUPS_DIRECTORY, `write-${writeIntent.writeIntentId}`);
      backupPath = path.join(backupDirectory, target);
      await mkdir(path.dirname(backupPath), { recursive: true, mode: 0o700 });
      await copyFile(absoluteTarget, backupPath);
      contentHash = `sha256:${createHash("sha256").update(await readFile(backupPath)).digest("hex")}`;
    } catch (error: unknown) {
      if (!isCode(error, "ENOENT")) throw error;
      throw writeError("WRITE_TARGET_MISSING", "Delete target does not exist.", { target });
    }

    await rm(absoluteTarget, { force: true });

    const evidence: EvidenceRef = {
      id: `evidence-${randomUUID()}`,
      kind: "file",
      source: "repository-delete",
      locator: target,
      contentHash,
      observedAt: new Date().toISOString(),
      sensitivity: "internal",
      toolCallId: `write-${writeIntent.writeIntentId}`
    };
    const saved = await recordEvidence(workspace, schemas, evidence);

    await appendLedgerEntry(workspace, {
      event: "delete-applied",
      taskId: lease.taskId,
      writeIntentRef: writeIntent.writeIntentId,
      evidenceRef: saved.id,
      summary: `Delete ${writeIntent.writeIntentId} applied to ${target}.`
    });

    const next: WriteIntentRecord = { ...current, status: "APPLIED" };
    await writeWorkspaceJson(workspace, `write-intents/${current.writeIntentId}.json`, next);
    return { evidenceId: saved.id, target, backupPath: path.relative(workspace.directory, backupPath) };
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
  content: string
): Promise<ApplyWriteResult> {
  return withWorkspaceLock(workspace, async () => {
    // Storage is authoritative: re-read the intent so stale in-memory copies cannot bypass APPLIED state.
    const current = await getWriteIntent(workspace, writeIntent.writeIntentId);
    const decision = evaluateLease(lease, { taskId: lease.taskId, role: lease.role, workspace: workspace.root, capability: "repository-write" });
    if (!decision.allowed) throw writeError("WRITE_LEASE_DENIED", decision.reasons[0] ?? "Write lease denied.");
    if (!targetInWriteSet(lease.writeSet, target)) throw writeError("WRITE_TARGET_NOT_IN_LEASE", "Target is outside the write lease writeSet.", { target });
    if (current.status === "APPLIED") throw writeError("WRITE_ALREADY_APPLIED", "This write request has already been applied.", { writeIntentId: current.writeIntentId });
    if (current.status !== "CONFIRMED") throw writeError("WRITE_INTENT_NOT_CONFIRMED", "The write request must be CONFIRMED before applying.", { writeIntentId: current.writeIntentId, status: current.status });
    if (!(current.confirmedTargets ?? []).includes(target)) throw writeError("WRITE_TARGET_NOT_CONFIRMED", "Target was not part of the confirmed write targets.", { target, confirmedTargets: current.confirmedTargets });
    assertTarget(target);
    if (typeof content !== "string") throw writeError("WRITE_CONTENT_INVALID", "Write content must be a string.");
    if (Buffer.byteLength(content, "utf8") > MAX_CONTENT_BYTES) throw writeError("WRITE_CONTENT_INVALID", "Write content exceeds 1 MiB.", { bytes: Buffer.byteLength(content, "utf8") });

    const absoluteTarget = path.resolve(workspace.root, target);
    if (!absoluteTarget.startsWith(`${workspace.root}${path.sep}`)) throw writeError("WRITE_TARGET_INVALID", "Write target escapes the workspace.", { target });

    let backupPath: string | undefined;
    try {
      await stat(absoluteTarget);
      const backupDirectory = path.join(workspace.directory, BACKUPS_DIRECTORY, `write-${writeIntent.writeIntentId}`);
      backupPath = path.join(backupDirectory, target);
      await mkdir(path.dirname(backupPath), { recursive: true, mode: 0o700 });
      await copyFile(absoluteTarget, backupPath);
    } catch (error: unknown) {
      if (!isCode(error, "ENOENT")) throw error;
    }

    await mkdir(path.dirname(absoluteTarget), { recursive: true });
    const temporary = path.join(path.dirname(absoluteTarget), `.${path.basename(absoluteTarget)}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, absoluteTarget);
    } finally {
      await import("node:fs/promises").then(({ rm }) => rm(temporary, { force: true })).catch(() => undefined);
    }

    const evidence: EvidenceRef = {
      id: `evidence-${randomUUID()}`,
      kind: "file",
      source: "repository-write",
      locator: target,
      contentHash: `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`,
      observedAt: new Date().toISOString(),
      sensitivity: "internal",
      toolCallId: `write-${writeIntent.writeIntentId}`
    };
    const saved = await recordEvidence(workspace, schemas, evidence);

    await appendLedgerEntry(workspace, {
      event: "write-applied",
      taskId: lease.taskId,
      writeIntentRef: writeIntent.writeIntentId,
      evidenceRef: saved.id,
      summary: `Write ${writeIntent.writeIntentId} applied to ${target}.`
    });

    const next: WriteIntentRecord = { ...current, status: "APPLIED" };
    await writeWorkspaceJson(workspace, `write-intents/${current.writeIntentId}.json`, next);
    return { evidenceId: saved.id, target, ...(backupPath === undefined ? {} : { backupPath: path.relative(workspace.directory, backupPath) }) };
  });
}

function assertTarget(target: string): void {
  if (!target || target.includes("\0") || target.startsWith("/") || target.split(/[\\/]/).includes("..")) throw writeError("WRITE_TARGET_INVALID", "Write targets must be workspace-relative paths.", { target });
  if (target === ".stinky-cobbler" || target.startsWith(".stinky-cobbler/") || target === ".git" || target.startsWith(".git/")) throw writeError("WRITE_TARGET_FORBIDDEN", "Control-plane and git metadata paths are never writable.", { target });
  if (isSensitivePath(target)) throw writeError("WRITE_TARGET_FORBIDDEN", "Sensitive paths are never writable.", { target });
  if (isForbiddenWriteTarget(target)) throw writeError("WRITE_TARGET_FORBIDDEN", "Executable and binary-derived targets are never writable.", { target });
}

function writeError(code: string, message: string, details: Record<string, unknown> = {}): StinkyCobblerError { return new StinkyCobblerError(code, ExitCode.VALIDATION, message, details); }
function isCode(error: unknown, code: string): boolean { return typeof error === "object" && error !== null && "code" in error && error.code === code; }
