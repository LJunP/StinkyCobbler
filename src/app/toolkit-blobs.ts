import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PlanSources } from "../core/plan/plan.js";
import { toolkitContentHash, type LockBodies, type LockEntry, type ToolkitLock } from "../core/toolkit/lock.js";
import type { ToolkitSpec } from "../core/toolkit/spec.js";
import { ExitCode, StinkyCobblerError } from "../errors.js";

export function blobDirectory(specPath: string): string {
  return path.join(path.dirname(specPath), "blobs");
}

export async function writeLockedBlobs(directory: string, lock: ToolkitLock, bodies: LockBodies): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const entry of lock.entries) {
    if (!storesBytes(entry) || entry.sha256 === undefined) continue;
    const body = lockedText(entry, bodies);
    if (body === undefined || toolkitContentHash(body) !== entry.sha256) {
      throw blobError("TOOLKIT_LOCK_DRIFT", "Locked body does not match its content hash.");
    }
    await writeBlob(directory, entry.sha256, body);
    await writeMemoryBlobs(directory, entry, bodies);
  }
}

async function writeMemoryBlobs(directory: string, entry: LockEntry, bodies: LockBodies): Promise<void> {
  for (const file of entry.files ?? []) {
    const body = bodies.memoryFiles?.[entry.id]?.[file.name];
    if (body === undefined || toolkitContentHash(body) !== file.sha256) {
      throw blobError("TOOLKIT_LOCK_DRIFT", "Locked memory file does not match its content hash.");
    }
    await writeBlob(directory, file.sha256, body);
  }
}

export async function sourcesFromLock(directory: string, spec: ToolkitSpec, lock: ToolkitLock): Promise<PlanSources> {
  const skills: Record<string, string> = {};
  const instructions: Record<string, string> = {};
  for (const skill of spec.skills) {
    const body = await lockedBody(directory, lock, "skill", skill.id, skill.source);
    if (body !== undefined) skills[skill.id] = body;
  }
  const memoryFiles: Record<string, Record<string, string>> = {};
  for (const item of spec.instructions) {
    const body = await lockedBody(directory, lock, "instructions", item.id, item.source);
    if (body !== undefined) instructions[item.id] = body;
    const extra = await lockedMemoryFiles(directory, lock, item.id);
    if (extra !== undefined) memoryFiles[item.id] = extra;
  }
  return { skills, instructions, ...(Object.keys(memoryFiles).length === 0 ? {} : { memoryFiles }) };
}

async function lockedMemoryFiles(directory: string, lock: ToolkitLock, id: string): Promise<Record<string, string> | undefined> {
  const entry = lock.entries.find((item) => item.kind === "instructions" && item.id === id);
  if (entry?.files === undefined) return undefined;
  const files: Record<string, string> = {};
  for (const file of entry.files) files[file.name] = await readBlob(directory, file.sha256);
  return files;
}

async function writeBlob(directory: string, digest: string, body: string): Promise<void> {
  const file = blobFile(directory, digest);
  try {
    await writeFile(file, body, { flag: "wx", mode: 0o600 });
  } catch (error: unknown) {
    if (!isCode(error, "EEXIST")) throw error;
    if (toolkitContentHash(await readFile(file, "utf8")) !== digest) throw blobError("TOOLKIT_LOCK_DRIFT", "Blob bytes do not match the lock hash.");
  }
}

async function lockedBody(directory: string, lock: ToolkitLock, kind: LockEntry["kind"], id: string, source: string): Promise<string | undefined> {
  const entry = lock.entries.find((item) => item.kind === kind && item.id === id);
  if (entry === undefined || entry.source !== source) throw blobError("TOOLKIT_LOCK_STALE", "Run toolkit lock again before apply.");
  if (!storesBytes(entry) || entry.sha256 === undefined) return undefined;
  return readBlob(directory, entry.sha256);
}

function storesBytes(entry: LockEntry): boolean {
  return entry.resolved === "local" || entry.resolved === "fetched";
}

function lockedText(entry: LockEntry, bodies: LockBodies): string | undefined {
  if (entry.kind === "skill") return entry.resolved === "fetched" ? bodies.fetchedSkills?.[entry.id] : bodies.skills[entry.id];
  return entry.resolved === "fetched" ? bodies.fetchedInstructions?.[entry.id] : bodies.instructions[entry.id];
}

async function readBlob(directory: string, digest: string): Promise<string> {
  try {
    const body = await readFile(blobFile(directory, digest), "utf8");
    if (toolkitContentHash(body) !== digest) throw blobError("TOOLKIT_LOCK_DRIFT", "Blob bytes do not match the lock hash.");
    return body;
  } catch (error: unknown) {
    if (error instanceof StinkyCobblerError) throw error;
    if (isCode(error, "ENOENT")) throw blobError("TOOLKIT_LOCK_BLOB_MISSING", "Locked content is missing. Run toolkit lock again. The source was not read.");
    throw error;
  }
}

function blobFile(directory: string, digest: string): string {
  if (!/^[0-9a-f]{64}$/.test(digest)) throw blobError("TOOLKIT_LOCK_INVALID", "Lock hash is not a sha256 hex string.");
  return path.join(directory, digest);
}

function blobError(code: string, message: string): StinkyCobblerError {
  return new StinkyCobblerError(code, ExitCode.VALIDATION, message);
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
