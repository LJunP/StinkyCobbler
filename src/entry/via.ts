import { StinkyCobblerError, ExitCode } from "../errors.js";

export type EntryVia = "skill" | "mcp" | "auto";
export const ENTRY_VIA_VALUES: readonly EntryVia[] = ["skill", "mcp", "auto"] as const;

/** Parses the user-supplied via option. Defaults to `auto`; invalid values fail closed. */
export function parseVia(input: unknown): EntryVia {
  if (input === undefined || input === null || input === "") return "auto";
  if (typeof input !== "string") throw entryError("ENTRY_VIA_INVALID", "via must be skill, mcp, or auto.");
  const normalized = input.trim().toLowerCase();
  if (normalized === "") return "auto";
  if ((ENTRY_VIA_VALUES as readonly string[]).includes(normalized)) return normalized as EntryVia;
  throw entryError("ENTRY_VIA_INVALID", "via must be skill, mcp, or auto.", { via: input });
}

export function isValidVia(input: unknown): input is EntryVia {
  try {
    parseVia(input);
    return true;
  } catch {
    return false;
  }
}

function entryError(code: string, message: string, details: Record<string, unknown> = {}): StinkyCobblerError {
  return new StinkyCobblerError(code, ExitCode.VALIDATION, message, details);
}
