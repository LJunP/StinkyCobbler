import { readFile } from "node:fs/promises";
import { ExitCode, StinkyCobblerError } from "../errors.js";
import type { LocalWorkspace } from "./workspace.js";
import { workspaceFile, writeWorkspaceJson } from "./workspace.js";

export const DOCS_INDEX_FILE = "docs-index.json";
export const DOCS_INDEX_WRITE_SET = ".stinky-cobbler/docs-index.json";

export interface DocumentationIndexEntry { path: string; title: string; }
export interface DocumentationIndex { version: 1; generatedAt: string; documents: DocumentationIndexEntry[]; }

/** Stores the index through the workspace metadata boundary using an atomic replacement. */
export async function saveDocumentationIndex(workspace: LocalWorkspace, index: DocumentationIndex): Promise<void> {
  await writeWorkspaceJson(workspace, DOCS_INDEX_FILE, index);
}

/** Reads and validates the stored index without exposing the metadata path to callers. */
export async function loadDocumentationIndex(workspace: LocalWorkspace): Promise<DocumentationIndex> {
  const target = await workspaceFile(workspace, DOCS_INDEX_FILE);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(target, "utf8"));
  } catch (error: unknown) {
    if (isNotFound(error)) throw invalid("Documentation index does not exist.");
    if (error instanceof SyntaxError) throw invalid("Stored documentation index contains invalid JSON.");
    throw error;
  }
  if (!isDocumentationIndex(parsed)) throw invalid("Stored documentation index is invalid.");
  return parsed;
}

function isDocumentationIndex(value: unknown): value is DocumentationIndex {
  if (!isRecord(value) || value.version !== 1 || typeof value.generatedAt !== "string" || !Array.isArray(value.documents)) return false;
  return value.documents.every((entry) => isRecord(entry) && typeof entry.path === "string" && typeof entry.title === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null; }
function isNotFound(error: unknown): boolean { return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"; }
function invalid(message: string): StinkyCobblerError { return new StinkyCobblerError("DOCS_INDEX_INVALID", ExitCode.VALIDATION, message); }
