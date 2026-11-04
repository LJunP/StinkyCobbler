import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import process from "node:process";
import { ExitCode, StinkyCobblerError } from "../errors.js";
import type { HostScope } from "../hosts/host-adapter.js";
import { requireHost } from "../hosts/registry.js";
import { installManagedBytes, readRegularHostFile } from "../io/managed-file.js";
import { readSegment, upsertSegment } from "../io/segment-file.js";
import { STINKY_COBBLER_VERSION } from "../version.js";

export async function showToolkitMemory(input: { id: string; host?: string | undefined; scope?: string | undefined }): Promise<{ bytes: string }> {
  const text = await memoryText(input.host, input.scope);
  return { bytes: readSegment(text, input.id) };
}

export async function editToolkitMemory(input: {
  id: string;
  host?: string | undefined;
  scope?: string | undefined;
  file?: string | undefined;
}): Promise<{ id: string; path: string }> {
  if (input.file === undefined) throw memoryError("SEGMENT_INVALID", "Pass --file with the replacement bytes.");
  const target = memoryPath(input.host, input.scope);
  const text = await memoryText(input.host, input.scope);
  readSegment(text, input.id);
  const next = upsertSegment(text, input.id, await replacement(input.file));
  await installManagedBytes(target, next, STINKY_COBBLER_VERSION, STINKY_COBBLER_VERSION);
  return { id: input.id, path: target };
}

async function memoryText(host: string | undefined, scope: string | undefined): Promise<string> {
  const text = await readRegularHostFile(memoryPath(host, scope));
  if (text === undefined) throw memoryError("SEGMENT_INVALID", "Managed segment was not found.");
  return text;
}

function memoryPath(host: string | undefined, scope: string | undefined): string {
  const adapter = requireHost(host);
  if (!adapter.supports("instructions")) throw unsupported(adapter.id);
  const located = adapter.locate("instructions", parseScope(scope), { home: homedir(), cwd: process.cwd() });
  if (located.unsupported !== undefined || located.format !== "md-segment" || located.path.length === 0) throw unsupported(adapter.id);
  return located.path;
}

function parseScope(flag: string | undefined): HostScope {
  if (flag === undefined || flag === "user") return "user";
  if (flag === "project") return "project";
  throw memoryError("TOOLKIT_SCOPE_INVALID", "Scope must be user or project.");
}

async function replacement(file: string): Promise<string> {
  try {
    return await readFile(file, "utf8");
  } catch (error: unknown) {
    if (isCode(error, "ENOENT")) throw memoryError("SEGMENT_INVALID", "Replacement file was not found.");
    throw error;
  }
}

function unsupported(host: string): StinkyCobblerError {
  return memoryError("TOOLKIT_HOST_UNSUPPORTED", `${host} has no verified instruction file.`);
}

function memoryError(code: string, message: string): StinkyCobblerError {
  return new StinkyCobblerError(code, ExitCode.VALIDATION, message);
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
