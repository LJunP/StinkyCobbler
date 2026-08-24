import path from "node:path";
import { ExitCode, StinkyCobblerError } from "../errors.js";
import { DOCS_INDEX_WRITE_SET, loadDocumentationIndex, saveDocumentationIndex, type DocumentationIndex, type DocumentationIndexEntry } from "../storage/docs-index.js";
import { openWorkspace } from "../storage/workspace.js";
import { assertReadScope, authorize, denied, resolveReadablePath, type ToolAccess, type ToolOutcome } from "./shared.js";
import { loadOrchestrationConfig } from "../config/tiered.js";
import {
  assertWorkspacePathPolicy,
  readBoundedWorkspaceFile,
  visitWorkspaceDirectory,
  WorkspaceReadBoundaryError
} from "../security/workspace-path.js";

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
  const documents = await collectDocuments(
    root.workspace,
    root.relativePath,
    0,
    { entries: 0, documents: 0, totalBytes: 0 },
    root.sensitiveExtraPaths
  );
  documents.sort((left, right) => left.path.localeCompare(right.path));
  const index: DocumentationIndex = { version: 1, generatedAt: new Date().toISOString(), documents };
  const serialized = `${JSON.stringify(index, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > DOCS_INDEX_BUDGET.maxIndexBytes) throw budgetExceeded("indexBytes", DOCS_INDEX_BUDGET.maxIndexBytes);

  await saveDocumentationIndex(await openWorkspace(root.workspace), index);
  return { decision, data: index };
}

export async function readDocumentationIndex(access: ToolAccess): Promise<ToolOutcome<DocumentationIndex>> {
  const decision = authorize(access, "docs-index");
  if (!decision.allowed) return denied(decision);
  const workspace = await openWorkspace(access.workspace);
  const [index, cfg] = await Promise.all([
    loadDocumentationIndex(workspace),
    loadOrchestrationConfig(workspace)
  ]);
  for (let entryIndex = 0; entryIndex < index.documents.length; entryIndex += 1) {
    const document = index.documents[entryIndex]!;
    try {
      assertWorkspacePathPolicy(document.path, {
        readScope: access.lease.readScope,
        ...(cfg.sensitiveExtraPaths === undefined ? {} : { sensitiveExtraPaths: cfg.sensitiveExtraPaths })
      });
    } catch {
      throw new StinkyCobblerError(
        "DOCS_INDEX_ACCESS_DENIED",
        ExitCode.POLICY_DENIED,
        "Stored documentation index contains an entry outside the current Lease or path policy.",
        { entryIndex }
      );
    }
  }
  return { decision, data: index };
}

async function collectDocuments(
  workspace: string,
  relativeDirectory: string,
  depth: number,
  budget: CollectionBudget,
  sensitiveExtraPaths?: string[]
): Promise<DocumentationIndexEntry[]> {
  if (depth > DOCS_INDEX_BUDGET.maxDepth) throw budgetExceeded("depth", DOCS_INDEX_BUDGET.maxDepth);
  const documents: DocumentationIndexEntry[] = [];
  try {
    await visitWorkspaceDirectory(workspace, relativeDirectory, async (entry) => {
      budget.entries += 1;
      if (budget.entries > DOCS_INDEX_BUDGET.maxEntries) {
        throw budgetExceeded("entries", DOCS_INDEX_BUDGET.maxEntries, { observed: budget.entries });
      }

      const relativeEntryPath = path.posix.join(relativeDirectory, entry.name);
      if (entry.isSymbolicLink()) return;
      try {
        assertWorkspacePathPolicy(relativeEntryPath, {
          ...(sensitiveExtraPaths === undefined ? {} : { sensitiveExtraPaths })
        });
      } catch {
        return;
      }
      if (entry.isDirectory()) {
        documents.push(...await collectDocuments(workspace, relativeEntryPath, depth + 1, budget, sensitiveExtraPaths));
        return;
      }
      if (!entry.isFile() || !DOCUMENT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) return;

      budget.documents += 1;
      if (budget.documents > DOCS_INDEX_BUDGET.maxDocuments) throw budgetExceeded("documents", DOCS_INDEX_BUDGET.maxDocuments);
      const { content, size } = await readPrivateDocument(workspace, relativeEntryPath);
      budget.totalBytes += size;
      if (budget.totalBytes > DOCS_INDEX_BUDGET.maxTotalBytes) throw budgetExceeded("totalBytes", DOCS_INDEX_BUDGET.maxTotalBytes);
      documents.push({ path: relativeEntryPath, title: documentTitle(content, path.basename(entry.name)) });
    });
  } catch (error: unknown) {
    if (error instanceof WorkspaceReadBoundaryError) {
      throw invalid("Documentation directory changed while establishing the index read boundary.", { path: relativeDirectory });
    }
    throw error;
  }
  return documents;
}

async function readPrivateDocument(workspace: string, relativePath: string): Promise<{ content: string; size: number }> {
  try {
    const file = await readBoundedWorkspaceFile(workspace, relativePath, DOCS_INDEX_BUDGET.maxFileBytes);
    return { content: file.bytes.toString("utf8"), size: file.size };
  } catch (error: unknown) {
    if (error instanceof WorkspaceReadBoundaryError && error.reason === "size-limit") {
      throw budgetExceeded("fileBytes", DOCS_INDEX_BUDGET.maxFileBytes, { path: relativePath, size: error.observed });
    }
    if (error instanceof WorkspaceReadBoundaryError) {
      throw invalid("Document changed while establishing the index read boundary.", { path: relativePath });
    }
    throw error;
  }
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
