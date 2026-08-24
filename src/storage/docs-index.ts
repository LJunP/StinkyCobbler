import { readFile } from "node:fs/promises";
import path from "node:path";
import { defaultSchemaRegistry } from "../contracts/default-schema-registry.js";
import { ExitCode, StinkyCobblerError } from "../errors.js";
import { assertWorkspacePathPolicy } from "../security/workspace-path.js";
import type { LocalWorkspace } from "./workspace.js";
import { workspaceFile, writeWorkspaceJson } from "./workspace.js";

export const DOCS_INDEX_FILE = "docs-index.json";
export const DOCS_INDEX_WRITE_SET = ".stinky-cobbler/docs-index.json";

export interface DocumentationIndexEntry { path: string; title: string; }
export interface DocumentationIndex { version: 1; generatedAt: string; documents: DocumentationIndexEntry[]; }
const MAX_INDEX_BYTES = 128 * 1024;

/** Stores the index through the workspace metadata boundary using an atomic replacement. */
export async function saveDocumentationIndex(workspace: LocalWorkspace, index: DocumentationIndex): Promise<void> {
  await validateDocumentationIndex(index);
  assertIndexBudget(`${JSON.stringify(index, null, 2)}\n`);
  await writeWorkspaceJson(workspace, DOCS_INDEX_FILE, index);
}

/** Reads and validates the stored index without exposing the metadata path to callers. */
export async function loadDocumentationIndex(workspace: LocalWorkspace): Promise<DocumentationIndex> {
  const target = await workspaceFile(workspace, DOCS_INDEX_FILE);
  let serialized: string;
  let parsed: unknown;
  try {
    serialized = await readFile(target, "utf8");
    assertIndexBudget(serialized);
    parsed = JSON.parse(serialized);
  } catch (error: unknown) {
    if (isNotFound(error)) throw invalid("Documentation index does not exist.");
    if (error instanceof SyntaxError) throw invalid("Stored documentation index contains invalid JSON.");
    throw error;
  }
  return validateDocumentationIndex(parsed);
}

async function validateDocumentationIndex(value: unknown): Promise<DocumentationIndex> {
  (await defaultSchemaRegistry()).validate("docs-index", value);
  const index = value as DocumentationIndex;
  if (new Date(index.generatedAt).toISOString() !== index.generatedAt) throw invalid("Documentation index timestamp is not canonical.");
  const seenPaths = new Set<string>();
  for (const document of index.documents) {
    if (!isCanonicalDocumentPath(document.path)) throw invalid("Documentation index contains a non-canonical path.");
    try { assertWorkspacePathPolicy(document.path); }
    catch { throw invalid("Documentation index contains a forbidden or sensitive path."); }
    if (document.title.trim() !== document.title) throw invalid("Documentation index contains a non-canonical title.");
    if (seenPaths.has(document.path)) throw invalid("Documentation index contains a duplicate path.");
    seenPaths.add(document.path);
  }
  return index;
}

function isCanonicalDocumentPath(value: string): boolean {
  return value.trim() === value
    && value !== "."
    && !value.endsWith("/")
    && !path.posix.isAbsolute(value)
    && path.posix.normalize(value) === value
    && value.split("/").every((segment) => segment !== "." && segment !== "..");
}

function assertIndexBudget(serialized: string): void {
  if (Buffer.byteLength(serialized, "utf8") > MAX_INDEX_BYTES) throw invalid("Documentation index exceeds its storage budget.");
}

function isNotFound(error: unknown): boolean { return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"; }
function invalid(message: string): StinkyCobblerError { return new StinkyCobblerError("DOCS_INDEX_INVALID", ExitCode.VALIDATION, message); }
