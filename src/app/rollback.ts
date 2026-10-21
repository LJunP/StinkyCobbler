import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { ExitCode, StinkyCobblerError } from "../errors.js";
import { readToolkitEvents, type ToolkitLedgerEvent } from "../io/ledger.js";
import { atomicReplace, managedMetadataPath, readManagedMetadata, readRegularHostFile, sha256, writeManagedMetadata } from "../io/managed-file.js";

export interface RollbackConflict {
  path: string;
  expectedHash: string;
  observedHash: string | null;
}

export interface RollbackReport {
  applyId: string;
  restored: string[];
  conflict?: RollbackConflict;
}

export async function rollbackLast(): Promise<RollbackReport> {
  const events = (await readToolkitEvents()).filter((event) => event.event === "toolkit-op-applied");
  const last = events.at(-1);
  if (last === undefined) throw new StinkyCobblerError("TOOLKIT_LEDGER_EMPTY", ExitCode.VALIDATION, "No toolkit apply is recorded.");
  const batch = events.filter((event) => event.applyId === last.applyId);
  const restored: string[] = [];
  for (const event of [...batch].reverse()) {
    const conflict = await undoEvent(event);
    if (conflict) return { applyId: last.applyId, restored, conflict };
    restored.push(event.path);
  }
  return { applyId: last.applyId, restored };
}

async function undoEvent(event: ToolkitLedgerEvent): Promise<RollbackConflict | undefined> {
  const current = await readRegularHostFile(event.path);
  const observedHash = current === undefined ? null : sha256(current);
  if (observedHash !== event.afterHash) return { path: event.path, expectedHash: event.afterHash, observedHash };
  const metadata = await readManagedMetadata(event.path);
  if (metadata?.installedSha256 !== event.afterHash) return { path: event.path, expectedHash: event.afterHash, observedHash };
  if (metadata.previous === undefined) {
    await rm(event.path, { force: true });
    await rm(managedMetadataPath(event.path), { force: true });
    return undefined;
  }
  await restoreBackup(event.path, metadata.previous, observedHash);
  return undefined;
}

async function restoreBackup(target: string, previous: { productVersion: string; sha256: string; backup: string }, observedHash: string): Promise<void> {
  if (path.basename(previous.backup) !== previous.backup) {
    throw new StinkyCobblerError("ENTRY_ROLLBACK_INVALID", ExitCode.VALIDATION, "Managed rollback metadata contains an unsafe backup path.", { target });
  }
  const bytes = await readFile(path.join(path.dirname(target), previous.backup));
  if (sha256(bytes) !== previous.sha256) {
    throw new StinkyCobblerError("ENTRY_ROLLBACK_DRIFT", ExitCode.VALIDATION, "The managed rollback backup no longer matches its recorded hash.", { target });
  }
  await atomicReplace(target, bytes, observedHash);
  await writeManagedMetadata(target, {
    version: 1,
    productVersion: previous.productVersion,
    installedSha256: previous.sha256,
    updatedAt: new Date().toISOString()
  });
}
