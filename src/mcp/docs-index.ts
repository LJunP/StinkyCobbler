import { readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, join, relative } from "node:path";
import { ExitCode, StinkyCobblerError } from "../errors.js";
import { DOCS_INDEX_WRITE_SET, loadDocumentationIndex, saveDocumentationIndex, type DocumentationIndex, type DocumentationIndexEntry } from "../storage/docs-index.js";
import { openWorkspace } from "../storage/workspace.js";
import { assertReadScope, authorize, denied, resolveReadablePath, type ToolAccess, type ToolOutcome } from "./shared.js";
import { isSensitivePath } from "../policy/path-policy.js";

export { type DocumentationIndex, type DocumentationIndexEntry } from "../storage/docs-index.js";

const DOCUMENT_EXTENSIONS = new Set([".md", ".mdx", ".txt", ".rst", ".adoc"]);
export const DOCS_INDEX_BUDGET = {
  maxDepth: 8,
  maxEntries: 500,
  maxDocuments: 100,
  maxFileBytes: 64 * 1024,
  maxTotalBytes: 1024 * 1024,
  maxIndexBytes: 128 * 1024
} as const;

interface CollectionBudget { entries: number; documents: number; totalBytes: number; }

export async function buildDocumentationIndex(access: ToolAccess, docsPath = "docs"): Promise<ToolOutcome<DocumentationIndex>> {
  const decision = authorize(access, "docs-index");
  if (!decision.allowed) return denied(decision);
  assertBuildLease(access);

  const root = await resolveReadablePath(access.workspace, docsPath);
  assertReadScope(access, root.relativePath);
  const rootInfo = await stat(root.absolutePath);
  if (!rootInfo.isDirectory()) throw invalid("Documentation root must be a directory.", { path: root.relativePath });

  const documents = await collectDocuments(root.workspace, root.absolutePath, 0, { entries: 0, documents: 0, totalBytes: 0 });
  const index: DocumentationIndex = { version: 1, generatedAt: new Date().toISOString(), documents };
  const serialized = `${JSON.stringify(index, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > DOCS_INDEX_BUDGET.maxIndexBytes) throw budgetExceeded("indexBytes", DOCS_INDEX_BUDGET.maxIndexBytes);

  await saveDocumentationIndex(await openWorkspace(root.workspace), index);
  return { decision, data: index };
}

export async function readDocumentationIndex(access: ToolAccess): Promise<ToolOutcome<DocumentationIndex>> {
  const decision = authorize(access, "docs-index");
  if (!decision.allowed) return denied(decision);
  assertReadScope(access, "docs");
  return { decision, data: await loadDocumentationIndex(await openWorkspace(access.workspace)) };
}

async function collectDocuments(workspace: string, directory: string, depth: number, budget: CollectionBudget): Promise<DocumentationIndexEntry[]> {
  if (depth > DOCS_INDEX_BUDGET.maxDepth) throw budgetExceeded("depth", DOCS_INDEX_BUDGET.maxDepth);
  const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
  const documents: DocumentationIndexEntry[] = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink() || entry.name === ".stinky-cobbler" || isSensitivePath(entry.name)) continue;
    budget.entries += 1;
    if (budget.entries > DOCS_INDEX_BUDGET.maxEntries) throw budgetExceeded("entries", DOCS_INDEX_BUDGET.maxEntries);

    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) {
      documents.push(...await collectDocuments(workspace, absolutePath, depth + 1, budget));
      continue;
    }
    if (!entry.isFile() || !DOCUMENT_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;

    budget.documents += 1;
    if (budget.documents > DOCS_INDEX_BUDGET.maxDocuments) throw budgetExceeded("documents", DOCS_INDEX_BUDGET.maxDocuments);
    const info = await stat(absolutePath);
    if (info.size > DOCS_INDEX_BUDGET.maxFileBytes) throw budgetExceeded("fileBytes", DOCS_INDEX_BUDGET.maxFileBytes, { path: relative(workspace, absolutePath), size: info.size });
    budget.totalBytes += info.size;
    if (budget.totalBytes > DOCS_INDEX_BUDGET.maxTotalBytes) throw budgetExceeded("totalBytes", DOCS_INDEX_BUDGET.maxTotalBytes);

    const content = await readFile(absolutePath, "utf8");
    documents.push({ path: relative(workspace, absolutePath), title: documentTitle(content, basename(entry.name)) });
  }
  return documents;
}

function assertBuildLease(access: ToolAccess): void {
  if (access.lease.level !== "L1" || access.lease.writeSet.length !== 1 || access.lease.writeSet[0] !== DOCS_INDEX_WRITE_SET) {
    throw new StinkyCobblerError("DOCS_INDEX_WRITE_DENIED", ExitCode.POLICY_DENIED, "Building a documentation index requires an L1 docs-index lease with the exact documentation-index write set.", { requiredWriteSet: DOCS_INDEX_WRITE_SET });
  }
}

function documentTitle(content: string, fallback: string): string {
  const heading = content.match(/^\s{0,3}#\s+(.+?)\s*#*\s*$/m)?.[1]?.trim();
  return heading || fallback;
}

function budgetExceeded(budget: string, limit: number, details: Record<string, unknown> = {}): StinkyCobblerError {
  return new StinkyCobblerError("DOCS_INDEX_BUDGET_EXCEEDED", ExitCode.VALIDATION, `Documentation index ${budget} budget exceeded.`, { budget, limit, ...details });
}
function invalid(message: string, details: Record<string, unknown>): StinkyCobblerError { return new StinkyCobblerError("DOCS_INDEX_INVALID", ExitCode.VALIDATION, message, details); }
