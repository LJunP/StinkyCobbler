import { open, readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { ExitCode, StinkyCobblerError } from "../errors.js";
import type { LocalWorkspace } from "./workspace.js";
import { workspaceFile } from "./workspace.js";
import { withWorkspaceLock } from "./workspace-lock.js";

export const LEDGER_FILE = "ledger.jsonl";
export const GENESIS_HASH = "sha256:genesis";

const LEDGER_EVENTS = ["workspace-initialized", "workspace-config-migrated", "task-created", "task-transitioned", "task-cancelled", "receipt-recorded", "approval-requested", "approval-decided", "evidence-recorded", "validation-run", "mcp-call", "test-run", "run-created", "run-transitioned", "run-recovered", "lease-issued", "lease-revoked", "plan-created", "plan-approved", "plan-cancelled", "plan-executing", "plan-step-completed", "plan-step-failed", "plan-completed", "plan-failed", "write-requested", "write-confirmed", "write-auto-allowed", "write-rejected", "write-applied", "write-rolled-back", "delete-applied"] as const;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;
const OPTIONAL_FIELDS = ["taskId", "role", "policyVersion", "tool", "receiptRef", "approvalRef", "evidenceRef", "runId", "fromStatus", "toStatus", "leaseRef", "planRef", "stepId", "writeIntentRef"] as const;
const appendQueues = new Map<string, Promise<void>>();

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
}

/** Caller-supplied audit data. Storage exclusively assigns sequence, id, timestamp, and hash-chain fields. */
export interface AppendLedgerEntry {
  event: LedgerEventName;
  summary: string;
  taskId?: string;
  role?: string;
  policyVersion?: string;
  tool?: string;
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
 * Appends a hash-chained audit record to the workspace-local ledger.
 * Within one process, appends for each workspace are serialized. The hash chain can detect
 * local tampering that was not fully recomputed; it cannot prove integrity against an attacker
 * who can rewrite the ledger and recompute every subsequent hash.
 */
export async function appendLedgerEntry(workspace: LocalWorkspace, entry: AppendLedgerEntry, options: AppendLedgerOptions = {}): Promise<LedgerEntry> {
  return serializeWorkspaceAppend(workspace.directory, () => withWorkspaceLock(workspace, async () => {
    assertAppendEntry(entry);
    const ledgerPath = await workspaceFile(workspace, LEDGER_FILE);
    const prior = await readLedger(ledgerPath);
    const verification = verifyEntries(prior);
    if (!verification.valid) throw invalid("Cannot append to an invalid ledger.", verification.error ?? {});

    const summary = protectSummary(entry.summary, options.sensitiveSummary ?? "reject");
    const record: Omit<LedgerEntry, "hash"> = {
      sequence: prior.length + 1,
      id: randomUUID(),
      at: new Date().toISOString(),
      event: entry.event,
      summary,
      prevHash: prior.length === 0 ? GENESIS_HASH : prior[prior.length - 1]!.hash,
      ...optionalEntryFields(entry)
    };
    const complete: LedgerEntry = { ...record, hash: hashEntry(record) };
    await durableAppend(ledgerPath, `${JSON.stringify(complete)}\n`);
    return complete;
  }));
}

/** Returns strictly verified ledger entries for controlled audit recovery. */
export async function listLedgerEntries(workspace: LocalWorkspace): Promise<LedgerEntry[]> {
  const ledgerPath = await workspaceFile(workspace, LEDGER_FILE);
  const entries = await readLedger(ledgerPath);
  const verification = verifyEntries(entries);
  if (!verification.valid) throw invalid("Cannot read an invalid ledger.", verification.error ?? {});
  return entries;
}

/** Verifies JSON syntax, exact sequences, strict record shape, predecessor links, and SHA-256 hashes. */
export async function verifyLedger(workspace: LocalWorkspace): Promise<LedgerVerification> {
  const ledgerPath = await workspaceFile(workspace, LEDGER_FILE);
  let entries: LedgerEntry[];
  try {
    entries = await readLedger(ledgerPath);
  } catch (error: unknown) {
    if (error instanceof LedgerParseError) {
      return { valid: false, entries: error.index, lastHash: error.lastHash, error: { index: error.index, code: "INVALID_JSON" } };
    }
    throw error;
  }
  return verifyEntries(entries);
}

export function redactSensitiveSummary(summary: string): string {
  return summary
    .replace(/(authorization:\s*bearer\s+)[^\s]+/gi, "$1[REDACTED]")
    .replace(/\b(?:sk|pk)_[A-Za-z0-9_-]{16,}\b/g, "[REDACTED]")
    .replace(/\b(?:api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, (match) => `${match.split(/[:=]/, 1)[0]}=[REDACTED]`)
    .replace(/\b[A-Za-z0-9+/]{32,}={0,2}\b/g, "[REDACTED]");
}

function verifyEntries(entries: LedgerEntry[]): LedgerVerification {
  let previous = GENESIS_HASH;
  for (const [index, entry] of entries.entries()) {
    if (!isLedgerEntry(entry)) return verificationFailure(index, previous, "INVALID_ENTRY");
    if (entry.sequence !== index + 1) return verificationFailure(index, previous, "SEQUENCE_MISMATCH");
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
    if (entry[field] !== undefined && typeof entry[field] !== "string") throw invalid(`Ledger ${field} must be a string.`, { field });
  }
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
  for (const [index, line] of lines.entries()) {
    try {
      entries.push(JSON.parse(line) as LedgerEntry);
    } catch {
      throw new LedgerParseError(index, entries.length === 0 ? GENESIS_HASH : entries[entries.length - 1]!.hash);
    }
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
  return OPTIONAL_FIELDS.every((field) => value[field] === undefined || typeof value[field] === "string");
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
