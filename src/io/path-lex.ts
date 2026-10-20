import path from "node:path";
import { ExitCode, StinkyCobblerError } from "../errors.js";

/** Lexical workspace-relative normalization. Policy checks stay in the security facade. */
export function normalizeRelativePath(value: string): string {
  if (!value || value.includes("\0") || value.includes("\\") || path.isAbsolute(value)) {
    throw pathDenied("A non-empty workspace-relative path is required.");
  }
  if (value.split("/").includes("..")) throw pathDenied("Path escapes the workspace.");
  const normalized = path.posix.normalize(value).replace(/^\.\//, "");
  if (normalized === ".." || normalized.startsWith("../") || normalized.startsWith("/")) {
    throw pathDenied("Path escapes the workspace.");
  }
  return normalized === "" ? "." : normalized;
}

export function assertInside(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw pathDenied("Path escapes the workspace.");
  }
}

export function pathDenied(message: string, details: Record<string, unknown> = {}): StinkyCobblerError {
  return new StinkyCobblerError("PATH_DENIED", ExitCode.PATH_DENIED, message, details);
}

export function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
