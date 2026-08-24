import { open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { ExitCode, StinkyCobblerError } from "../errors.js";
import { defaultSchemaRegistry } from "../contracts/default-schema-registry.js";
import type { LocalWorkspace } from "./workspace.js";
import { createWorkspaceDirectory, createWorkspaceJson, workspaceFile } from "./workspace.js";
import { withWorkspaceLock } from "./workspace-lock.js";

export const LEDGER_FILE = "ledger.jsonl";
export const GENESIS_HASH = "sha256:genesis";
/** Archived ledger segments (verifyLedger chains across them). */
export const LEDGER_ARCHIVES_DIRECTORY = "ledger-archives";

const LEDGER_ARCHIVE_TRANSACTION_FILE = "ledger-archive-transaction.json";
const ARCHIVE_TRANSACTION_VERSION = 1;

const LEDGER_EVENTS = ["workspace-initialized", "workspace-config-migrated", "task-created", "task-transitioned", "task-cancelled", "receipt-recorded", "approval-requested", "approval-decided", "evidence-recorded", "validation-run", "mcp-call", "test-run", "run-created", "run-transitioned", "run-recovered", "lease-issued", "lease-revoked", "plan-created", "plan-approved", "plan-cancelled", "plan-executing", "plan-step-started", "plan-step-completed", "plan-step-failed", "plan-completed", "plan-failed", "write-requested", "write-confirmed", "write-auto-allowed", "write-rejected", "write-applied", "write-rolled-back", "delete-applied", "contract-created", "subtask-dispatched", "subtask-started", "subtask-completed", "artifact-recorded", "artifact-mismatch", "review-recorded", "subtask-accepted", "subtask-rejected", "round-completed", "orchestration-completed", "orchestration-failed", "orchestration-escalated", "orchestration-resumed", "orchestration-cancelled", "orchestration-transaction-aborted", "ledger-archived"] as const;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const OPTIONAL_FIELDS = ["taskId", "role", "policyVersion", "tool", "capability", "authorityHash", "reservationId", "reservationOrdinal", "receiptRef", "approvalRef", "evidenceRef", "runId", "fromStatus", "toStatus", "leaseRef", "planRef", "stepId", "writeIntentRef", "contractRef", "runRef", "subtaskRef", "artifactRef", "reviewRef", "round", "attempt"] as const;
const appendQueues = new Map<string, Promise<void>>();

interface ArchiveTransactionManifest {
  version: 1;
  createdAt: string;
  archived: number;
  archiveFile: string;
  archiveTemporaryFile: string;
  mainTemporaryFile: string;
  sourceLedgerHash: string;
  archiveHash: string;
  mainHash: string;
}

interface LoadedLedgerChain {
  entries: LedgerEntry[];
  mainEntries: LedgerEntry[];
  verification: LedgerVerification;
}

export type LedgerEventName = (typeof LEDGER_EVENTS)[number];
export type SensitiveSummaryHandling = "reject" | "redact";

export interface LedgerEntry {
  sequence: number;
  id: string;
  at: string;
  event: LedgerEventName;
  summary: string;
  prevHash: string;
  hash: string;
  taskId?: string;
  role?: string;
  policyVersion?: string;
  tool?: string;
  capability?: string;
  authorityHash?: string;
  reservationId?: string;
  reservationOrdinal?: number;
  receiptRef?: string;
  approvalRef?: string;
  evidenceRef?: string;
  runId?: string;
  fromStatus?: string;
  toStatus?: string;
  leaseRef?: string;
  planRef?: string;
  stepId?: string;
  writeIntentRef?: string;
  contractRef?: string;
  runRef?: string;
  subtaskRef?: string;
  artifactRef?: string;
  reviewRef?: string;
  round?: number;
  attempt?: number;
}

/** Caller-supplied audit data. Storage exclusively assigns sequence, id, timestamp, and hash-chain fields. */
export interface AppendLedgerEntry {
  event: LedgerEventName;
  summary: string;
  taskId?: string;
  role?: string;
  policyVersion?: string;
  tool?: string;
  capability?: string;
  authorityHash?: string;
  reservationId?: string;
  reservationOrdinal?: number;
  receiptRef?: string;
  approvalRef?: string;
  evidenceRef?: string;
  runId?: string;
  fromStatus?: string;
  toStatus?: string;
  leaseRef?: string;
  planRef?: string;
  stepId?: string;
  writeIntentRef?: string;
  contractRef?: string;
  runRef?: string;
  subtaskRef?: string;
  artifactRef?: string;
  reviewRef?: string;
  round?: number;
  attempt?: number;
}

export interface AppendLedgerOptions {
  sensitiveSummary?: SensitiveSummaryHandling;
}

export interface LedgerVerification {
  valid: boolean;
  entries: number;
  lastHash: string;
  error?: { index: number; code: "INVALID_JSON" | "INVALID_ENTRY" | "PREVIOUS_HASH_MISMATCH" | "HASH_MISMATCH" | "SEQUENCE_MISMATCH" };
}

/**
 * Produces a deterministic, non-secret audit fingerprint for caller-controlled
 * prose. Hyphens deliberately break up the digest so the ledger's generic
 * long-token detector does not mistake the fingerprint itself for a secret.
 */
export function auditTextFingerprint(value: string): string {
  const digest = createHash("sha256").update(value, "utf8").digest("hex");
  return `sha256:${digest.match(/.{1,12}/g)?.join("-") ?? digest}`;
}

/**
 * Performs every deterministic ledger-entry check without touching storage.
 * Mutations that depend on caller prose can call this before changing subject
 * state, preventing an invalid/secret/oversized summary from creating an
 * avoidable state-versus-audit split.
 */
export function prepareLedgerEntry(entry: AppendLedgerEntry, options: AppendLedgerOptions = {}): AppendLedgerEntry {
  assertAppendEntry(entry);
  return { ...entry, summary: protectSummary(entry.summary, options.sensitiveSummary ?? "reject") };
}

/**
 * Appends a hash-chained audit record to the workspace-local ledger.
 * Within one process, appends for each workspace are serialized. The hash chain can detect
 * local tampering that was not fully recomputed; it cannot prove integrity against an attacker
 * who can rewrite the ledger and recompute every subsequent hash.
 */
export async function appendLedgerEntry(workspace: LocalWorkspace, entry: AppendLedgerEntry, options: AppendLedgerOptions = {}): Promise<LedgerEntry> {
  const preparedEntry = prepareLedgerEntry(entry, options);
  return serializeWorkspaceAppend(workspace.directory, () => withWorkspaceLock(workspace, async () => {
    await reconcileArchiveTransaction(workspace);
    const ledgerPath = await workspaceFile(workspace, LEDGER_FILE);
    const chain = await loadLedgerChain(workspace);
    if (!chain.verification.valid) throw invalid("Cannot append to an invalid ledger.", chain.verification.error ?? {});
    const prior = chain.entries.at(-1);

    const record: Omit<LedgerEntry, "hash"> = {
      sequence: prior === undefined ? 1 : prior.sequence + 1,
      id: randomUUID(),
      at: new Date().toISOString(),
      event: preparedEntry.event,
      summary: preparedEntry.summary,
      prevHash: prior === undefined ? GENESIS_HASH : prior.hash,
      ...optionalEntryFields(preparedEntry)
    };
    const complete: LedgerEntry = { ...record, hash: hashEntry(record) };
    await validateAuditEntry(complete);
    await durableAppend(ledgerPath, `${JSON.stringify(complete)}\n`);
    return complete;
  }));
}

/** Returns strictly verified ledger entries for controlled audit recovery. */
export async function listLedgerEntries(workspace: LocalWorkspace): Promise<LedgerEntry[]> {
  return withWorkspaceLock(workspace, async () => {
    await reconcileArchiveTransaction(workspace);
    const chain = await loadLedgerChain(workspace);
    if (!chain.verification.valid) throw invalid("Cannot read an invalid ledger.", chain.verification.error ?? {});
    return chain.entries;
  });
}

/** Verifies JSON syntax, exact sequences, strict record shape, predecessor links, and SHA-256 hashes.
 *  Chained across archived segments: main chain's first prevHash must equal the last archive's tail hash
 *  (or genesis when no archive exists); each archive file chains internally and to its predecessor. */
export async function verifyLedger(workspace: LocalWorkspace): Promise<LedgerVerification> {
  return withWorkspaceLock(workspace, async () => {
    await reconcileArchiveTransaction(workspace);
    return (await loadLedgerChain(workspace)).verification;
  });
}

/** Archive segments: verifiable prefix chain (see verifyLedger). */
export async function listArchives(workspace: LocalWorkspace): Promise<string[]> {
  const directory = await workspaceFile(workspace, LEDGER_ARCHIVES_DIRECTORY);
  const names = await readdir(directory).catch((error: unknown) => (isNotFound(error) ? [] as string[] : Promise.reject(error)));
  const archiveNames = names.filter((name) => /^ledger-archive-\d{4}-\d{2}-\d{2}T.*\.jsonl$/.test(name)).sort();
  return Promise.all(archiveNames.map((name) => workspaceFile(workspace, `${LEDGER_ARCHIVES_DIRECTORY}/${name}`)));
}

/**
 * Archives the oldest contiguous prefix of the ledger (entries older than `beforeDays` days).
 * The archived segment keeps its original lines (chain intact internally). The main ledger is
 * rewritten with its remaining entries re-hashed (first prevHash links to the archive tail), and a
 * `ledger-archived` event records the operation on the new main chain — so verification stays
 * possible across segments and the rewrite is itself audited. Never archives the last entry.
 */
export async function archiveLedger(workspace: LocalWorkspace, beforeDays: number): Promise<{ archived: number; archiveFile: string }> {
  return withWorkspaceLock(workspace, async () => {
    if (!Number.isSafeInteger(beforeDays) || beforeDays < 1) throw invalid("beforeDays must be a positive integer.", { beforeDays });
    const recovered = await reconcileArchiveTransaction(workspace);
    if (recovered !== undefined) return recovered;

    const ledgerPath = await workspaceFile(workspace, LEDGER_FILE);
    const sourceContents = await readFile(ledgerPath, "utf8").catch((error: unknown) => (isNotFound(error) ? "" : Promise.reject(error)));
    const chain = await loadLedgerChain(workspace);
    if (!chain.verification.valid) throw invalid("Cannot archive an invalid ledger.", chain.verification.error ?? {});
    const entries = chain.mainEntries;
    const cutoff = Date.now() - beforeDays * 86_400_000;
    let prefixCount = 0;
    for (const entry of entries) {
      if (new Date(entry.at).getTime() < cutoff) prefixCount += 1; else break;
    }
    if (prefixCount === 0) return { archived: 0, archiveFile: "" };
    prefixCount = Math.min(prefixCount, Math.max(0, entries.length - 1)); // never archive the entire main chain
    if (prefixCount === 0) return { archived: 0, archiveFile: "" };

    const archived = entries.slice(0, prefixCount);
    const remaining = entries.slice(prefixCount);
    await createWorkspaceDirectory(workspace, LEDGER_ARCHIVES_DIRECTORY);
    const transactionId = randomUUID();
    const archiveName = `ledger-archive-${new Date().toISOString().replace(/[:.]/g, "-")}-${transactionId}.jsonl`;
    const archiveContents = archived.map((entry) => `${JSON.stringify(entry)}\n`).join("");
    const tail = archived[archived.length - 1]!;
    // Re-hash the remaining chain: first entry links to the archived tail.
    const rewritten: LedgerEntry[] = [];
    let previous = tail.hash;
    for (const [index, entry] of remaining.entries()) {
      const { hash: _discard, ...unsigned } = entry;
      const record = { ...unsigned, prevHash: previous };
      const complete = { ...record, hash: hashEntry(record) };
      rewritten.push(complete);
      previous = complete.hash;
    }
    const event = buildArchivedEntry(rewritten, archived.length, archiveName, tail.hash);
    await validateAuditEntry(event);
    const mainContents = [...rewritten, event].map((entry) => `${JSON.stringify(entry)}\n`).join("");
    const manifest: ArchiveTransactionManifest = {
      version: ARCHIVE_TRANSACTION_VERSION,
      createdAt: new Date().toISOString(),
      archived: archived.length,
      archiveFile: archiveName,
      archiveTemporaryFile: `${LEDGER_ARCHIVES_DIRECTORY}/.ledger-archive-${transactionId}.jsonl.tmp`,
      mainTemporaryFile: `.ledger-archive-${transactionId}.jsonl.tmp`,
      sourceLedgerHash: digestContents(sourceContents),
      archiveHash: digestContents(archiveContents),
      mainHash: digestContents(mainContents)
    };

    await stageArchiveTransaction(workspace, manifest, archiveContents, mainContents);
    const completed = await reconcileArchiveTransaction(workspace);
    if (completed === undefined) throw invalid("Archive transaction disappeared before completion.", { archiveFile: archiveName });
    return completed;
  });
}

function buildArchivedEntry(chain: LedgerEntry[], archivedCount: number, archiveName: string, archivedTailHash: string): LedgerEntry {
  const record: Omit<LedgerEntry, "hash"> = {
    sequence: chain.length === 0 ? 1 : chain[chain.length - 1]!.sequence + 1,
    id: randomUUID(),
    at: new Date().toISOString(),
    event: "ledger-archived",
    summary: `Archived ${archivedCount} entries to ${archiveName}; archive tail ${archivedTailHash.slice(0, 20)}...`,
    prevHash: chain.length === 0 ? GENESIS_HASH : chain[chain.length - 1]!.hash
  };
  return { ...record, hash: hashEntry(record) };
}

async function loadLedgerChain(workspace: LocalWorkspace): Promise<LoadedLedgerChain> {
  const archiveFiles = await listArchives(workspace);
  const archiveSegments: Array<{ file: string; entries: LedgerEntry[] }> = [];
  for (const file of archiveFiles) {
    try {
      const entries = await readLedger(file);
      if (entries.length === 0) {
        return {
          entries: [],
          mainEntries: [],
          verification: verificationFailure(0, GENESIS_HASH, "INVALID_ENTRY")
        };
      }
      archiveSegments.push({ file, entries });
    } catch (error: unknown) {
      const failure = readFailure(error);
      if (failure !== undefined) return { entries: [], mainEntries: [], verification: failure };
      throw error;
    }
  }

  // Filenames contain timestamps for operators, but sequence is the canonical
  // ordering source. This remains correct if the wall clock moves backwards.
  archiveSegments.sort((left, right) => {
    const bySequence = left.entries[0]!.sequence - right.entries[0]!.sequence;
    return bySequence === 0 ? left.file.localeCompare(right.file) : bySequence;
  });

  const entries: LedgerEntry[] = [];
  let anchor = GENESIS_HASH;
  let nextSequence = 1;
  for (const segment of archiveSegments) {
    const verification = verifyEntries(segment.entries, anchor, nextSequence);
    if (!verification.valid) {
      return {
        entries,
        mainEntries: [],
        verification: offsetVerificationFailure(verification, entries.length, anchor)
      };
    }
    entries.push(...segment.entries);
    anchor = verification.lastHash;
    nextSequence = segment.entries.at(-1)!.sequence + 1;
  }

  const ledgerPath = await workspaceFile(workspace, LEDGER_FILE);
  let mainEntries: LedgerEntry[];
  try {
    mainEntries = await readLedger(ledgerPath);
  } catch (error: unknown) {
    const failure = readFailure(error);
    if (failure !== undefined) {
      return {
        entries,
        mainEntries: [],
        verification: offsetVerificationFailure(failure, entries.length, anchor)
      };
    }
    throw error;
  }

  const tail = verifyEntries(mainEntries, anchor, nextSequence);
  if (!tail.valid) {
    return {
      entries,
      mainEntries,
      verification: offsetVerificationFailure(tail, entries.length, anchor)
    };
  }
  entries.push(...mainEntries);
  return {
    entries,
    mainEntries,
    verification: { valid: true, entries: entries.length, lastHash: tail.lastHash }
  };
}

function offsetVerificationFailure(verification: LedgerVerification, offset: number, fallbackHash: string): LedgerVerification {
  if (verification.valid || verification.error === undefined) return verification;
  return {
    valid: false,
    entries: offset + verification.entries,
    lastHash: verification.entries === 0 ? fallbackHash : verification.lastHash,
    error: { index: offset + verification.error.index, code: verification.error.code }
  };
}

async function stageArchiveTransaction(workspace: LocalWorkspace, manifest: ArchiveTransactionManifest, archiveContents: string, mainContents: string): Promise<void> {
  const archiveTemporary = await workspaceFile(workspace, manifest.archiveTemporaryFile);
  const mainTemporary = await workspaceFile(workspace, manifest.mainTemporaryFile);
  await durableWriteExclusive(archiveTemporary, archiveContents);
  await durableWriteExclusive(mainTemporary, mainContents);
  // Publishing the manifest is the commit intent. Once it exists, recovery
  // always rolls the two prepared files forward and never guesses a rollback.
  await createWorkspaceJson(workspace, LEDGER_ARCHIVE_TRANSACTION_FILE, manifest);
}

async function reconcileArchiveTransaction(workspace: LocalWorkspace): Promise<{ archived: number; archiveFile: string } | undefined> {
  const manifestPath = await workspaceFile(workspace, LEDGER_ARCHIVE_TRANSACTION_FILE);
  const manifest = await readArchiveTransaction(manifestPath);
  if (manifest === undefined) return undefined;

  const ledgerPath = await workspaceFile(workspace, LEDGER_FILE);
  const archivePath = await workspaceFile(workspace, `${LEDGER_ARCHIVES_DIRECTORY}/${manifest.archiveFile}`);
  const archiveTemporary = await workspaceFile(workspace, manifest.archiveTemporaryFile);
  const mainTemporary = await workspaceFile(workspace, manifest.mainTemporaryFile);

  const archiveHash = await digestFileIfPresent(archivePath);
  const archiveTemporaryHash = await digestFileIfPresent(archiveTemporary);
  const currentMainHash = await digestFileIfPresent(ledgerPath);
  const mainTemporaryHash = await digestFileIfPresent(mainTemporary);
  if (archiveHash !== undefined && archiveHash !== manifest.archiveHash) {
    throw recoveryInvalid("Published archive does not match its transaction manifest.", manifest, { actualHash: archiveHash });
  }
  if (archiveTemporaryHash !== undefined && archiveTemporaryHash !== manifest.archiveHash) {
    throw recoveryInvalid("Prepared archive does not match its transaction manifest.", manifest, { actualHash: archiveTemporaryHash });
  }
  if (archiveHash === undefined) {
    if (archiveTemporaryHash === undefined) {
      throw recoveryInvalid("Archive transaction is missing both the published and prepared archive.", manifest, {});
    }
  }
  if (mainTemporaryHash !== undefined && mainTemporaryHash !== manifest.mainHash) {
    throw recoveryInvalid("Prepared main ledger does not match its transaction manifest.", manifest, { actualHash: mainTemporaryHash });
  }
  if (currentMainHash !== manifest.mainHash) {
    if (currentMainHash !== manifest.sourceLedgerHash) {
      throw recoveryInvalid("Main ledger is neither the source nor committed transaction version.", manifest, { actualHash: currentMainHash ?? "missing" });
    }
    if (mainTemporaryHash === undefined) {
      throw recoveryInvalid("Archive transaction is missing its prepared main ledger.", manifest, {});
    }
  }

  // All available bytes and the current source state are authenticated before
  // either side is renamed, so a damaged transaction cannot make a split worse.
  if (archiveHash === undefined) {
    await rename(archiveTemporary, archivePath);
    await syncDirectory(path.dirname(archivePath));
  }
  if (currentMainHash !== manifest.mainHash) {
    await rename(mainTemporary, ledgerPath);
    await syncDirectory(path.dirname(ledgerPath));
  }

  const completed = await loadLedgerChain(workspace);
  if (!completed.verification.valid) {
    throw recoveryInvalid("Reconciled archive transaction does not form a valid ledger chain.", manifest, {
      verification: completed.verification.error ?? {}
    });
  }

  await removePreparedFile(archiveTemporary, manifest.archiveHash);
  await removePreparedFile(mainTemporary, manifest.mainHash);
  await unlink(manifestPath);
  await syncDirectory(path.dirname(manifestPath));
  return { archived: manifest.archived, archiveFile: manifest.archiveFile };
}

async function readArchiveTransaction(manifestPath: string): Promise<ArchiveTransactionManifest | undefined> {
  let contents: string;
  try {
    contents = await readFile(manifestPath, "utf8");
  } catch (error: unknown) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(contents) as unknown;
  } catch {
    throw invalid("Archive transaction manifest contains invalid JSON.", {});
  }
  if (!isArchiveTransactionManifest(value)) throw invalid("Archive transaction manifest is invalid.", {});
  return value;
}

function isArchiveTransactionManifest(value: unknown): value is ArchiveTransactionManifest {
  if (!isPlainObject(value)) return false;
  const expectedKeys = ["version", "createdAt", "archived", "archiveFile", "archiveTemporaryFile", "mainTemporaryFile", "sourceLedgerHash", "archiveHash", "mainHash"];
  if (Object.keys(value).length !== expectedKeys.length || Object.keys(value).some((key) => !expectedKeys.includes(key))) return false;
  if (value.version !== ARCHIVE_TRANSACTION_VERSION) return false;
  if (typeof value.createdAt !== "string" || !isCanonicalIsoDate(value.createdAt)) return false;
  if (typeof value.archived !== "number" || !Number.isSafeInteger(value.archived) || value.archived < 1) return false;
  if (typeof value.archiveFile !== "string" || typeof value.archiveTemporaryFile !== "string" || typeof value.mainTemporaryFile !== "string") return false;
  if (typeof value.sourceLedgerHash !== "string" || typeof value.archiveHash !== "string" || typeof value.mainHash !== "string") return false;
  if (![value.sourceLedgerHash, value.archiveHash, value.mainHash].every((hash) => HASH_PATTERN.test(hash))) return false;

  const uuid = "([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})";
  const archive = value.archiveFile.match(new RegExp(`^ledger-archive-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}Z-${uuid}\\.jsonl$`, "i"));
  const archiveTemporary = value.archiveTemporaryFile.match(new RegExp(`^${LEDGER_ARCHIVES_DIRECTORY}/\\.ledger-archive-${uuid}\\.jsonl\\.tmp$`, "i"));
  const mainTemporary = value.mainTemporaryFile.match(new RegExp(`^\\.ledger-archive-${uuid}\\.jsonl\\.tmp$`, "i"));
  return archive !== null && archiveTemporary !== null && mainTemporary !== null
    && archive[1]!.toLowerCase() === archiveTemporary[1]!.toLowerCase()
    && archive[1]!.toLowerCase() === mainTemporary[1]!.toLowerCase();
}

async function durableWriteExclusive(file: string, contents: string): Promise<void> {
  const handle = await open(file, "wx", 0o600);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(path.dirname(file));
}

function digestContents(contents: string | Buffer): string {
  return `sha256:${createHash("sha256").update(contents).digest("hex")}`;
}

async function digestFileIfPresent(file: string): Promise<string | undefined> {
  try {
    return digestContents(await readFile(file));
  } catch (error: unknown) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

async function removePreparedFile(file: string, expectedHash: string): Promise<void> {
  const actualHash = await digestFileIfPresent(file);
  if (actualHash === undefined) return;
  if (actualHash !== expectedHash) throw invalid("Refusing to remove an unexpected archive transaction file.", { file: path.basename(file), actualHash });
  await unlink(file);
  await syncDirectory(path.dirname(file));
}

function recoveryInvalid(message: string, manifest: ArchiveTransactionManifest, details: Record<string, unknown>): StinkyCobblerError {
  return invalid(message, { archiveFile: manifest.archiveFile, ...details });
}

export function redactSensitiveSummary(summary: string): string {
  return summary
    .replace(/(authorization:\s*bearer\s+)[^\s]+/gi, "$1[REDACTED]")
    .replace(/\b(?:sk|pk)_[A-Za-z0-9_-]{16,}\b/g, "[REDACTED]")
    .replace(/\b(?:api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, (match) => `${match.split(/[:=]/, 1)[0]}=[REDACTED]`)
    .replace(/\b[A-Za-z0-9+/]{32,}={0,2}\b/g, "[REDACTED]");
}

function verifyEntries(entries: LedgerEntry[], anchor = GENESIS_HASH, expectedFirstSequence?: number): LedgerVerification {
  let previous = anchor;
  for (const [index, entry] of entries.entries()) {
    if (!isLedgerEntry(entry)) return verificationFailure(index, previous, "INVALID_ENTRY");
    const expected = expectedFirstSequence === undefined ? index + 1 : expectedFirstSequence + index;
    if (entry.sequence !== expected) return verificationFailure(index, previous, "SEQUENCE_MISMATCH");
    if (entry.prevHash !== previous) return verificationFailure(index, previous, "PREVIOUS_HASH_MISMATCH");
    const { hash, ...unsigned } = entry;
    if (hash !== hashEntry(unsigned)) return verificationFailure(index, previous, "HASH_MISMATCH");
    previous = hash;
  }
  return { valid: true, entries: entries.length, lastHash: previous };
}

function verificationFailure(index: number, lastHash: string, code: NonNullable<LedgerVerification["error"]>["code"]): LedgerVerification {
  return { valid: false, entries: index, lastHash, error: { index, code } };
}

function assertAppendEntry(entry: AppendLedgerEntry): void {
  if (!isPlainObject(entry)) throw invalid("Ledger entry must be an object.", {});
  const suppliedKeys = Object.keys(entry);
  const allowedKeys = new Set(["event", "summary", ...OPTIONAL_FIELDS]);
  const forbidden = suppliedKeys.filter((key) => !allowedKeys.has(key));
  if (forbidden.length > 0) throw invalid("Ledger storage assigns sequence, id, timestamp, and hash-chain fields.", { forbidden });
  if (!LEDGER_EVENTS.includes(entry.event)) throw invalid("Ledger event is invalid.", { event: entry.event });
  if (typeof entry.summary !== "string") throw invalid("Ledger summary must be a string.", {});
  for (const field of OPTIONAL_FIELDS) {
    if (entry[field] === undefined) continue;
    if (field === "round" || field === "attempt" || field === "reservationOrdinal") {
      const minimum = field === "reservationOrdinal" ? 1 : 0;
      if (typeof entry[field] !== "number" || !Number.isSafeInteger(entry[field]) || entry[field] < minimum) throw invalid(`Ledger ${field} must be a safe integer at or above ${minimum}.`, { field });
      continue;
    }
    if (typeof entry[field] !== "string" || entry[field].length === 0 || entry[field].length > 256 || /[\0\r\n]/.test(entry[field])) {
      throw invalid(`Ledger ${field} must contain 1 to 256 safe characters.`, { field });
    }
  }
  if (entry.runId !== undefined && !RUN_ID_PATTERN.test(entry.runId)) throw invalid("Ledger runId is invalid.", { runId: entry.runId });
}

function optionalEntryFields(entry: AppendLedgerEntry): Pick<LedgerEntry, (typeof OPTIONAL_FIELDS)[number]> {
  return Object.fromEntries(OPTIONAL_FIELDS.filter((field) => entry[field] !== undefined).map((field) => [field, entry[field]])) as Pick<LedgerEntry, (typeof OPTIONAL_FIELDS)[number]>;
}

function protectSummary(summary: string, handling: SensitiveSummaryHandling): string {
  if (summary.length === 0 || summary.length > 512) throw invalid("Ledger summary must contain 1 to 512 characters.", { length: summary.length });
  const redacted = redactSensitiveSummary(summary);
  if (redacted === summary) return summary;
  if (handling === "redact") return redacted;
  throw invalid("Ledger summary appears to contain sensitive data.", {});
}

function hashEntry(entry: Omit<LedgerEntry, "hash">): string {
  return `sha256:${createHash("sha256").update(canonicalJson(entry), "utf8").digest("hex")}`;
}

function canonicalJson(entry: Omit<LedgerEntry, "hash">): string {
  return JSON.stringify(Object.fromEntries(Object.entries(entry).sort(([left], [right]) => left.localeCompare(right))));
}

async function durableAppend(file: string, contents: string): Promise<void> {
  const handle = await open(file, "a", 0o600);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(path.dirname(file));
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try { await handle.sync(); }
  finally { await handle.close(); }
}

async function serializeWorkspaceAppend<T>(workspaceDirectory: string, operation: () => Promise<T>): Promise<T> {
  const preceding = appendQueues.get(workspaceDirectory) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  appendQueues.set(workspaceDirectory, current);
  await preceding.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (appendQueues.get(workspaceDirectory) === current) appendQueues.delete(workspaceDirectory);
  }
}

async function readLedger(ledgerPath: string): Promise<LedgerEntry[]> {
  let contents: string;
  try {
    contents = await readFile(ledgerPath, "utf8");
  } catch (error: unknown) {
    if (isNotFound(error)) return [];
    throw error;
  }
  const lines = contents.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const entries: LedgerEntry[] = [];
  const schemas = await defaultSchemaRegistry();
  for (const [index, line] of lines.entries()) {
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      throw new LedgerParseError(index, entries.length === 0 ? GENESIS_HASH : entries[entries.length - 1]!.hash);
    }
    try {
      schemas.validate("audit", value);
    } catch (error: unknown) {
      if (error instanceof StinkyCobblerError && error.code === "SCHEMA_INVALID") {
        throw new LedgerEntryValidationError(index, entries.length === 0 ? GENESIS_HASH : entries[entries.length - 1]!.hash);
      }
      throw error;
    }
    entries.push(value as LedgerEntry);
  }
  return entries;
}

function isLedgerEntry(value: unknown): value is LedgerEntry {
  if (!isPlainObject(value)) return false;
  const allowedKeys = new Set(["sequence", "id", "at", "event", "summary", "prevHash", "hash", ...OPTIONAL_FIELDS]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) return false;
  if (typeof value.sequence !== "number" || !Number.isSafeInteger(value.sequence) || value.sequence < 1) return false;
  if (typeof value.id !== "string" || !UUID_PATTERN.test(value.id)) return false;
  if (typeof value.at !== "string" || !isCanonicalIsoDate(value.at)) return false;
  if (typeof value.event !== "string" || !LEDGER_EVENTS.includes(value.event as LedgerEventName)) return false;
  if (typeof value.summary !== "string" || value.summary.length === 0 || value.summary.length > 512) return false;
  if (typeof value.prevHash !== "string" || (value.prevHash !== GENESIS_HASH && !HASH_PATTERN.test(value.prevHash))) return false;
  if (typeof value.hash !== "string" || !HASH_PATTERN.test(value.hash)) return false;
  return OPTIONAL_FIELDS.every((field) => {
    if (value[field] === undefined) return true;
    return field === "round" || field === "attempt" || field === "reservationOrdinal"
      ? typeof value[field] === "number" && Number.isSafeInteger(value[field]) && value[field] >= (field === "reservationOrdinal" ? 1 : 0)
      : typeof value[field] === "string" && value[field].length > 0 && value[field].length <= 256 && !/[\0\r\n]/.test(value[field]);
  });
}

async function validateAuditEntry(entry: LedgerEntry): Promise<void> {
  try {
    (await defaultSchemaRegistry()).validate("audit", entry);
  } catch (error: unknown) {
    if (error instanceof StinkyCobblerError && error.code === "SCHEMA_INVALID") {
      throw invalid("Ledger entry violates the canonical audit schema.", { errors: error.details.errors ?? [] });
    }
    throw error;
  }
}

function readFailure(error: unknown): LedgerVerification | undefined {
  if (error instanceof LedgerParseError) {
    return { valid: false, entries: error.index, lastHash: error.lastHash, error: { index: error.index, code: "INVALID_JSON" } };
  }
  if (error instanceof LedgerEntryValidationError) {
    return { valid: false, entries: error.index, lastHash: error.lastHash, error: { index: error.index, code: "INVALID_ENTRY" } };
  }
  return undefined;
}

function isCanonicalIsoDate(value: string): boolean {
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

function invalid(message: string, details: Record<string, unknown>): StinkyCobblerError {
  return new StinkyCobblerError("LEDGER_INVALID", ExitCode.VALIDATION, message, details);
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

class LedgerParseError extends Error {
  constructor(readonly index: number, readonly lastHash: string) {
    super("Ledger contains invalid JSON.");
  }
}

class LedgerEntryValidationError extends Error {
  constructor(readonly index: number, readonly lastHash: string) {
    super("Ledger entry violates the canonical audit schema.");
  }
}
