import { COPYFILE_EXCL } from "node:constants";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { ExitCode, StinkyCobblerError } from "../errors.js";

/** Sidecar written beside a managed host file. Byte-identical to the 2.0.1 name. */
export function managedMetadataPath(target: string): string {
  return `${target}.stinky-cobbler-managed.json`;
}

/** Content-addressed backup beside a managed host file. The digest is the pre-image sha256. */
export function backupPathFor(target: string, digest: string): string {
  return path.join(path.dirname(target), `${path.basename(target)}.stinky-cobbler-backup-${digest}.bak`);
}

export function sha256(contents: string | Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}

export interface ManagedInstallMetadata {
  version: 1;
  productVersion: string;
  installedSha256: string;
  updatedAt: string;
  previous?: { productVersion: string; sha256: string; backup: string };
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export function relativeHostPath(file: string): string {
  const home = homedir();
  const displayed = file.startsWith(`${home}${path.sep}`) ? path.join("~", path.relative(home, file)) : file;
  return displayed.split(path.sep).join("/");
}

export async function readRegularHostFile(file: string): Promise<string | undefined> {
  let info;
  try {
    info = await lstat(file);
  } catch {
    return undefined;
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw managedError("ENTRY_TARGET_INVALID", "The host target must be a regular file, not a directory or link.", { target: relativeHostPath(file) });
  }
  return readFile(file, "utf8");
}

export type ManagedObservationState = "absent" | "managed" | "managed-modified" | "foreign";

export interface ManagedInspection {
  state: ManagedObservationState;
  hash?: string;
}

/** Reads a host target and its sidecar. Does not create or modify either file. */
export async function inspectManagedFile(target: string): Promise<ManagedInspection> {
  const text = await readRegularHostFile(target);
  if (text === undefined) return { state: "absent" };
  const hash = sha256(text);
  const metadata = await readManagedMetadata(target);
  if (metadata === undefined) return { state: "foreign", hash };
  return { state: metadata.installedSha256 === hash ? "managed" : "managed-modified", hash };
}

export async function readManagedMetadata(target: string): Promise<ManagedInstallMetadata | undefined> {
  const file = managedMetadataPath(target);
  const info = await lstat(file).catch(() => undefined);
  if (info === undefined) return undefined;
  if (!info.isFile() || info.isSymbolicLink()) {
    throw managedError("ENTRY_MANAGED_STATE_INVALID", "Managed install metadata must be a regular file.", { target: relativeHostPath(target) });
  }
  const value = await readMetadataJson(file, target);
  if (!isManagedMetadata(value)) {
    throw managedError("ENTRY_MANAGED_STATE_INVALID", "Managed install metadata does not match the supported schema.", { target: relativeHostPath(target) });
  }
  return value;
}

export async function writeManagedMetadata(target: string, metadata: ManagedInstallMetadata): Promise<void> {
  await atomicWrite(managedMetadataPath(target), `${JSON.stringify(metadata, null, 2)}\n`);
}

export async function backupManagedFile(target: string, digest: string, productVersion: string): Promise<NonNullable<ManagedInstallMetadata["previous"]>> {
  const backup = path.basename(backupPathFor(target, digest));
  const backupPath = path.join(path.dirname(target), backup);
  await copyBackupExclusive(target, backupPath, digest);
  if (sha256(await readFile(backupPath)) !== digest) {
    await rm(backupPath, { force: true });
    throw managedError("ENTRY_INSTALL_RACE", "The host target changed while its managed backup was being created.", { target: relativeHostPath(target) });
  }
  return { productVersion, sha256: digest, backup };
}

export async function atomicWrite(target: string, contents: string | Buffer): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.tmp-${randomUUID()}`);
  try {
    await writeFile(temporary, contents, { mode: 0o600, flag: "wx" });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function atomicReplace(target: string, contents: string | Buffer, expectedSha256: string | undefined): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.tmp-${randomUUID()}`);
  try {
    await writeFile(temporary, contents, { mode: 0o600, flag: "wx" });
    const observed = await readRegularHostFile(target);
    const changed = expectedSha256 === undefined ? observed !== undefined : observed === undefined || sha256(observed) !== expectedSha256;
    if (changed) {
      throw managedError("ENTRY_INSTALL_RACE", "The host target changed after preview/backup; refusing to replace it.", { target: relativeHostPath(target) });
    }
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function installManagedBytes(target: string, next: string, productVersion: string, previousVersion: string): Promise<void> {
  const existing = await readRegularHostFile(target);
  const previous = existing === undefined ? undefined : await backupManagedFile(target, sha256(existing), previousVersion);
  await atomicReplace(target, next, existing === undefined ? undefined : sha256(existing));
  await writeManagedMetadata(target, {
    version: 1,
    productVersion,
    installedSha256: sha256(next),
    updatedAt: new Date().toISOString(),
    ...(previous === undefined ? {} : { previous })
  });
}

async function copyBackupExclusive(target: string, backupPath: string, digest: string): Promise<void> {
  try {
    await copyFile(target, backupPath, COPYFILE_EXCL);
  } catch (error: unknown) {
    if (!isCode(error, "EEXIST")) throw error;
    const info = await lstat(backupPath);
    if (!info.isFile() || info.isSymbolicLink() || sha256(await readFile(backupPath)) !== digest) {
      throw managedError("ENTRY_BACKUP_CONFLICT", "The deterministic managed backup path already exists with different or unsafe content.", {
        target: relativeHostPath(target),
        backup: relativeHostPath(backupPath)
      });
    }
  }
}

async function readMetadataJson(file: string, target: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as unknown;
  } catch {
    throw managedError("ENTRY_MANAGED_STATE_INVALID", "Managed install metadata is not valid JSON.", { target: relativeHostPath(target) });
  }
}

function isManagedMetadata(value: unknown): value is ManagedInstallMetadata {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || typeof record.productVersion !== "string" || typeof record.updatedAt !== "string") return false;
  if (typeof record.installedSha256 !== "string" || !SHA256_PATTERN.test(record.installedSha256)) return false;
  if (record.previous === undefined) return true;
  return isPreviousMetadata(record.previous);
}

function isPreviousMetadata(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const previous = value as Record<string, unknown>;
  return (
    typeof previous.productVersion === "string" &&
    typeof previous.sha256 === "string" &&
    SHA256_PATTERN.test(previous.sha256) &&
    typeof previous.backup === "string" &&
    previous.backup.length > 0 &&
    path.basename(previous.backup) === previous.backup
  );
}

function managedError(code: string, message: string, details: Record<string, unknown> = {}): StinkyCobblerError {
  return new StinkyCobblerError(code, ExitCode.POLICY_DENIED, message, details);
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
