import { ExitCode, StinkyCobblerError } from "../errors.js";
import { claudeCodeHost } from "./claude-code.js";
import { codexHost } from "./codex.js";
import { cursorHost } from "./cursor.js";
import { zcodeHost } from "./zcode.js";

/** ZCode and Codex stay first so preflight candidate order matches 2.0.1. */
export const hostAdapters = [zcodeHost, codexHost, claudeCodeHost, cursorHost] as const;

export type HostId = (typeof hostAdapters)[number]["id"];

export function hostIds(): readonly HostId[] {
  return hostAdapters.map((adapter) => adapter.id);
}

export function hostById(value: unknown): (typeof hostAdapters)[number] | undefined {
  if (typeof value !== "string") return undefined;
  return hostAdapters.find((adapter) => adapter.id === value);
}

export function requireHost(value: unknown): (typeof hostAdapters)[number] {
  if (typeof value !== "string" || value.length === 0) {
    throw new StinkyCobblerError("ENTRY_HOST_INVALID", ExitCode.VALIDATION, "Option --host is required.", {});
  }
  const found = hostById(value);
  if (found === undefined) throw unknownHost(value);
  return found;
}

export function knownHost(value: unknown): (typeof hostAdapters)[number] | undefined {
  if (value === undefined) return undefined;
  const found = hostById(value);
  if (found === undefined) throw unknownHost(value);
  return found;
}

function unknownHost(value: unknown): StinkyCobblerError {
  return new StinkyCobblerError("ENTRY_HOST_INVALID", ExitCode.VALIDATION, `host must be one of: ${hostIds().join(", ")}.`, { host: value });
}
