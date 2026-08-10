import { mkdir, readFile, readdir } from "node:fs/promises";
import type { EvidenceRef, AgentRun } from "../contracts/types.js";
import type { SchemaRegistry } from "../contracts/schema-registry.js";
import { ExitCode, StinkyCobblerError } from "../errors.js";
import { appendLedgerEntry, listLedgerEntries } from "./ledger.js";
import type { LocalWorkspace } from "./workspace.js";
import { createWorkspaceDirectory, createWorkspaceJson, workspaceFile } from "./workspace.js";
import { withWorkspaceLock } from "./workspace-lock.js";
import { assertRunOwner } from "./runs.js";

const DIRECTORY = "evidence";
const ID_PATTERN = /^evidence-[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;
const MAX_TEXT = 512;
const KINDS = new Set<EvidenceRef["kind"]>(["file", "git", "tool", "document"]);
const SENSITIVITIES = new Set<EvidenceRef["sensitivity"]>(["public", "internal", "confidential", "restricted"]);

export interface EvidenceListOptions { taskId?: string; toolCallId?: string; orphan?: boolean; }
export interface EvidenceInspection {
  valid: boolean;
  evidence: EvidenceRef;
  orphan: boolean;
  linkedTaskId?: string;
  linkedRunId?: string;
  linkedTaskIds?: string[];
  linkedRunIds?: string[];
}
interface EvidenceLink { taskIds: Set<string>; runIds: Set<string>; }

export interface EvidenceOwnerOptions {
  runId: string;
  ownerToken: string;
  expectedEpoch?: number;
}

export async function recordEvidence(workspace: LocalWorkspace, schemas: SchemaRegistry, evidence: EvidenceRef): Promise<EvidenceRef> {
  return withWorkspaceLock(workspace, () => recordEvidenceLocked(workspace, schemas, evidence));
}

export async function recordEvidenceOwned(
  workspace: LocalWorkspace,
  schemas: SchemaRegistry,
  evidence: EvidenceRef,
  owner: EvidenceOwnerOptions
): Promise<EvidenceRef> {
  return withWorkspaceLock(workspace, async () => {
    await assertRunOwner(workspace, owner.runId, owner.ownerToken, owner.expectedEpoch);
    return recordEvidenceLocked(workspace, schemas, evidence);
  });
}

async function recordEvidenceLocked(workspace: LocalWorkspace, schemas: SchemaRegistry, evidence: EvidenceRef): Promise<EvidenceRef> {
  const valid = validateEvidence(evidence);
  schemas.validate("evidence-ref", valid);
  await createWorkspaceDirectory(workspace, DIRECTORY);
  try {
    const existing = await readStoredEvidence(workspace, valid.id);
    if (JSON.stringify(existing) !== JSON.stringify(valid)) throw evidenceError("EVIDENCE_IDEMPOTENCY_CONFLICT", "Evidence ID already exists with different content.", { evidenceId: valid.id });
    await ensureEvidenceLedgerEntry(workspace, existing);
    return existing;
  } catch (error: unknown) {
    if (!isCode(error, "EVIDENCE_NOT_FOUND")) throw error;
  }
  await createWorkspaceJson(workspace, `${DIRECTORY}/${valid.id}.json`, valid);
  await ensureEvidenceLedgerEntry(workspace, valid);
  return valid;
}

async function ensureEvidenceLedgerEntry(workspace: LocalWorkspace, evidence: EvidenceRef): Promise<void> {
  const entries = await listLedgerEntries(workspace);
  if (entries.some((entry) => entry.event === "evidence-recorded" && entry.evidenceRef === evidence.id)) return;
  await appendLedgerEntry(workspace, { event: "evidence-recorded", tool: evidence.source, evidenceRef: evidence.id, summary: `Evidence ${evidence.id} recorded.` });
}

export async function getEvidence(workspace: LocalWorkspace, evidenceId: string): Promise<EvidenceRef> {
  assertEvidenceId(evidenceId);
  return readStoredEvidence(workspace, evidenceId);
}

export async function listEvidence(workspace: LocalWorkspace, options: EvidenceListOptions = {}): Promise<EvidenceRef[]> {
  let names: string[];
  try { names = await readdir(await workspaceFile(workspace, DIRECTORY)); } catch (error: unknown) { if (isCode(error, "ENOENT")) return []; throw error; }
  const values = await Promise.all(names.filter((name) => /^evidence-[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$/.test(name)).sort().map((name) => getEvidence(workspace, name.slice(0, -5))));
  const linked = options.taskId === undefined && options.orphan === undefined ? undefined : await findEvidenceLinks(workspace);
  return values.filter((value) => {
    if (options.toolCallId !== undefined && value.toolCallId !== options.toolCallId) return false;
    const link = linked?.get(value.id);
    if (options.orphan === true && link !== undefined) return false;
    if (options.orphan === false && link === undefined) return false;
    return options.taskId === undefined || link?.taskIds.has(options.taskId) === true;
  });
}

export async function inspectEvidence(workspace: LocalWorkspace, schemas: SchemaRegistry, evidenceId: string): Promise<EvidenceInspection> {
  const evidence = await getEvidence(workspace, evidenceId);
  schemas.validate("evidence-ref", evidence);
  const link = (await findEvidenceLinks(workspace)).get(evidence.id);
  const taskIds = link === undefined ? [] : [...link.taskIds].sort();
  const runIds = link === undefined ? [] : [...link.runIds].sort();
  return {
    valid: true,
    evidence,
    orphan: link === undefined,
    ...(taskIds[0] === undefined ? {} : { linkedTaskId: taskIds[0] }),
    ...(runIds[0] === undefined ? {} : { linkedRunId: runIds[0] }),
    ...(taskIds.length === 0 ? {} : { linkedTaskIds: taskIds }),
    ...(runIds.length === 0 ? {} : { linkedRunIds: runIds })
  };
}

async function findEvidenceLinks(workspace: LocalWorkspace): Promise<Map<string, EvidenceLink>> {
  const links = new Map<string, EvidenceLink>();
  let names: string[];
  try { names = await readdir(await workspaceFile(workspace, "runs")); } catch (error: unknown) { if (isCode(error, "ENOENT")) return links; throw error; }
  for (const name of names.filter((item) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$/.test(item))) {
    let run: AgentRun;
    try { run = JSON.parse(await readFile(await workspaceFile(workspace, `runs/${name}`), "utf8")) as AgentRun; } catch { continue; }
    const refs = [...(run.evidenceRefs ?? [])];
    for (const call of run.toolCalls ?? []) {
      if (typeof call === "string") continue;
      refs.push(...(call.evidenceRefs ?? []));
    }
    for (const evidenceRef of refs) {
      const link = links.get(evidenceRef) ?? { taskIds: new Set<string>(), runIds: new Set<string>() };
      link.taskIds.add(run.taskId);
      link.runIds.add(run.runId);
      links.set(evidenceRef, link);
    }
  }
  return links;
}

async function readStoredEvidence(workspace: LocalWorkspace, evidenceId: string): Promise<EvidenceRef> {
  try {
    const value = validateEvidence(JSON.parse(await readFile(await workspaceFile(workspace, `${DIRECTORY}/${evidenceId}.json`), "utf8")) as EvidenceRef);
    if (value.id !== evidenceId) throw evidenceError("EVIDENCE_INVALID", "Stored Evidence ID does not match its filename.", { evidenceId });
    return value;
  } catch (error: unknown) {
    if (isCode(error, "ENOENT")) throw evidenceError("EVIDENCE_NOT_FOUND", "Evidence does not exist.", { evidenceId });
    if (error instanceof SyntaxError) throw evidenceError("EVIDENCE_INVALID", "Stored evidence contains invalid JSON.", { evidenceId });
    throw error;
  }
}

function validateEvidence(value: EvidenceRef): EvidenceRef {
  if (!value || typeof value !== "object") throw evidenceError("EVIDENCE_INVALID", "Evidence must be an object.");
  assertEvidenceId(value.id);
  if (!KINDS.has(value.kind)) throw evidenceError("EVIDENCE_INVALID", "Evidence kind is invalid.");
  if (!SENSITIVITIES.has(value.sensitivity)) throw evidenceError("EVIDENCE_INVALID", "Evidence sensitivity is invalid.");
  for (const [name, item] of [["source", value.source], ["locator", value.locator], ["toolCallId", value.toolCallId]] as const) {
    if (typeof item !== "string" || item.length === 0 || item.length > MAX_TEXT || item.includes("\0")) throw evidenceError("EVIDENCE_INVALID", `Evidence ${name} is invalid.`);
  }
  if (value.locator.startsWith("/") || value.locator.startsWith("\\") || value.locator.split(/[\\/]/).includes("..")) throw evidenceError("EVIDENCE_LOCATOR_INVALID", "Evidence locator must not escape its workspace boundary.");
  if (!HASH_PATTERN.test(value.contentHash)) throw evidenceError("EVIDENCE_HASH_INVALID", "Evidence contentHash must be sha256:<64 lowercase hex>.");
  if (!isCanonicalDate(value.observedAt)) throw evidenceError("EVIDENCE_INVALID", "Evidence observedAt must be a canonical ISO timestamp.");
  return value;
}
function assertEvidenceId(value: string): void { if (typeof value !== "string" || !ID_PATTERN.test(value)) throw evidenceError("EVIDENCE_ID_INVALID", "Evidence ID is invalid.", { evidenceId: value }); }
function isCanonicalDate(value: string): boolean { const date = new Date(value); return !Number.isNaN(date.getTime()) && date.toISOString() === value; }
function evidenceError(code: string, message: string, details: Record<string, unknown> = {}): StinkyCobblerError { return new StinkyCobblerError(code, ExitCode.VALIDATION, message, details); }
function isCode(error: unknown, code: string): boolean { return typeof error === "object" && error !== null && "code" in error && error.code === code; }

