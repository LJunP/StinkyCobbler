import { link, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildDocumentationIndex, DOCS_INDEX_BUDGET, readDocumentationIndex } from "../src/mcp/docs-index.js";
import { listRepositoryDirectory } from "../src/mcp/repo-read.js";
import { initWorkspace, workspaceFile } from "../src/storage/workspace.js";
import { loadDocumentationIndex, saveDocumentationIndex } from "../src/storage/docs-index.js";

const roots: string[] = [];

async function createProject(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "stinky-cobbler-docs-"));
  roots.push(root);
  return root;
}

function access(workspace: string, overrides: Record<string, unknown> = {}) {
  return {
    taskId: "task",
    role: "scout",
    workspace,
    lease: {
      id: "lease", taskId: "task", agentId: "agent", role: "scout", capability: "docs-index", level: "L1" as const,
      workspace, readScope: ["docs"], writeSet: [".stinky-cobbler/docs-index.json"], issuedAt: "2026-01-01T00:00:00Z",
      expiresAt: "2099-01-01T00:00:00Z", maxToolCalls: 10, status: "active" as const, ...overrides
    }
  };
}

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("documentation index", () => {
  it("uses scoped source documents and workspace-backed atomic storage", async () => {
    const root = await createProject();
    const workspace = await initWorkspace(root);
    await mkdir(path.join(root, "docs", "guide"), { recursive: true });
    await mkdir(path.join(root, "docs", ".stinky-cobbler"), { recursive: true });
    await writeFile(path.join(root, "docs", "readme.md"), "# Welcome\n");
    await writeFile(path.join(root, "docs", "guide", "plain.txt"), "Text\n");
    await writeFile(path.join(root, "docs", ".stinky-cobbler", "private.md"), "# Do not index\n");

    const built = await buildDocumentationIndex(access(workspace.root));
    expect(built.data?.documents).toEqual([
      { path: "docs/guide/plain.txt", title: "plain.txt" },
      { path: "docs/readme.md", title: "Welcome" }
    ]);
    expect(JSON.parse(await readFile(await workspaceFile(workspace, "docs-index.json"), "utf8"))).toMatchObject({ version: 1, documents: built.data?.documents });
    await expect(readDocumentationIndex(access(workspace.root))).resolves.toMatchObject({ data: { documents: built.data?.documents } });
  });

  it("requires the exact L1 write set and a readable documentation scope", async () => {
    const root = await createProject();
    const workspace = await initWorkspace(root);
    await mkdir(path.join(root, "docs"));

    await expect(buildDocumentationIndex(access(workspace.root, { writeSet: [".stinky-cobbler/docs-index.json", "other"] }))).resolves.toMatchObject({ decision: { allowed: false, code: "WRITE_NOT_IMPLEMENTED" } });
    await expect(buildDocumentationIndex(access(workspace.root, { readScope: ["src"] }))).rejects.toThrow("readScope");
  });

  it("retains the prior index when collection exceeds a fixed budget", async () => {
    const root = await createProject();
    const workspace = await initWorkspace(root);
    await mkdir(path.join(root, "docs"));
    const indexFile = await workspaceFile(workspace, "docs-index.json");
    const previous = '{"version":1,"generatedAt":"2026-01-01T00:00:00.000Z","documents":[]}\n';
    await writeFile(indexFile, previous);
    await writeFile(path.join(root, "docs", "large.md"), "x".repeat(64 * 1024 + 1));

    await expect(buildDocumentationIndex(access(workspace.root))).rejects.toMatchObject({ code: "DOCS_INDEX_BUDGET_EXCEEDED" });
    await expect(readFile(indexFile, "utf8")).resolves.toBe(previous);
  });

  it("streams the recursive global entry budget and rejects on exactly limit + 1", async () => {
    const root = await createProject();
    const workspace = await initWorkspace(root);
    const nested = path.join(root, "docs", "nested");
    await mkdir(nested, { recursive: true });
    const rootEntryCount = Math.floor(DOCS_INDEX_BUDGET.maxEntries / 2);
    const nestedEntryCount = DOCS_INDEX_BUDGET.maxEntries - rootEntryCount;
    await Promise.all(Array.from({ length: rootEntryCount }, (_, index) =>
      writeFile(path.join(root, "docs", `root-${index}.bin`), "", "utf8")
    ));
    await Promise.all(Array.from({ length: nestedEntryCount }, (_, index) =>
      writeFile(path.join(nested, `nested-${index}.bin`), "", "utf8")
    ));

    await expect(buildDocumentationIndex(access(workspace.root))).rejects.toMatchObject({
      code: "DOCS_INDEX_BUDGET_EXCEEDED",
      details: { budget: "entries", limit: DOCS_INDEX_BUDGET.maxEntries, observed: DOCS_INDEX_BUDGET.maxEntries + 1 }
    });
  });

  it("rejects hard-linked documents instead of indexing an alias outside the documentation tree", async () => {
    const root = await createProject();
    const outside = await createProject();
    const workspace = await initWorkspace(root);
    await mkdir(path.join(root, "docs"));
    const external = path.join(outside, "external.md");
    await writeFile(external, "# External\n", "utf8");
    await link(external, path.join(root, "docs", "linked.md"));

    await expect(buildDocumentationIndex(access(workspace.root)))
      .rejects.toMatchObject({ code: "DOCS_INDEX_INVALID" });
  });

  it("inherits custom sensitive paths across recursive indexing and directory listings", async () => {
    const root = await createProject();
    const workspace = await initWorkspace(root);
    await mkdir(path.join(root, ".stinky-cobbler", "policies"), { recursive: true });
    await writeFile(path.join(root, ".stinky-cobbler", "policies", "orchestration.yaml"), "version: 1\nsensitiveExtraPaths:\n  - docs/internal/\n");
    await mkdir(path.join(root, "docs", "internal"), { recursive: true });
    await mkdir(path.join(root, "docs", "public"), { recursive: true });
    await writeFile(path.join(root, "docs", "internal", "roadmap.md"), "# Private roadmap\n");
    await writeFile(path.join(root, "docs", "public", "guide.md"), "# Public guide\n");

    const built = await buildDocumentationIndex(access(workspace.root));
    expect(built.data?.documents).toEqual([{ path: "docs/public/guide.md", title: "Public guide" }]);

    const listed = await listRepositoryDirectory(access(workspace.root, {
      capability: "repository-read",
      level: "L0",
      writeSet: []
    }), "docs");
    expect(listed.data).toEqual([{ path: "docs/public", kind: "directory" }]);
  });

  it("rejects a stored root index when the reading Lease is narrower", async () => {
    const root = await createProject();
    const workspace = await initWorkspace(root);
    await mkdir(path.join(root, "docs"));
    await writeFile(path.join(root, "README.md"), "# Root document\n");
    await writeFile(path.join(root, "docs", "guide.md"), "# Guide\n");

    await buildDocumentationIndex(access(workspace.root, { readScope: ["."] }), ".");
    const denied = await readDocumentationIndex(access(workspace.root)).catch((error: unknown) => error);
    expect(denied).toMatchObject({ code: "DOCS_INDEX_ACCESS_DENIED" });
    expect(JSON.stringify(denied)).not.toContain("README.md");
  });

  it("revalidates an existing index against newly configured sensitive paths", async () => {
    const root = await createProject();
    const workspace = await initWorkspace(root);
    await mkdir(path.join(root, "docs", "internal"), { recursive: true });
    await writeFile(path.join(root, "docs", "internal", "roadmap.md"), "# Roadmap\n");
    await buildDocumentationIndex(access(workspace.root));

    await mkdir(path.join(root, ".stinky-cobbler", "policies"), { recursive: true });
    await writeFile(path.join(root, ".stinky-cobbler", "policies", "orchestration.yaml"), "version: 1\nsensitiveExtraPaths:\n  - docs/internal/\n");
    const denied = await readDocumentationIndex(access(workspace.root)).catch((error: unknown) => error);
    expect(denied).toMatchObject({ code: "DOCS_INDEX_ACCESS_DENIED" });
    expect(JSON.stringify(denied)).not.toContain("docs/internal/roadmap.md");
  });

  it("schema-validates save/load and enforces canonical paths, titles, duplicates, timestamps, and document budget", async () => {
    const root = await createProject();
    const workspace = await initWorkspace(root);
    const base = { version: 1 as const, generatedAt: "2026-01-01T00:00:00.000Z", documents: [{ path: "docs/a.md", title: "A" }] };

    await expect(saveDocumentationIndex(workspace, { ...base, documents: [...base.documents, ...base.documents] }))
      .rejects.toMatchObject({ code: "DOCS_INDEX_INVALID" });
    await expect(saveDocumentationIndex(workspace, { ...base, documents: [{ path: "docs/../secret.md", title: "A" }] }))
      .rejects.toMatchObject({ code: "DOCS_INDEX_INVALID" });
    await expect(saveDocumentationIndex(workspace, { ...base, documents: [{ path: ".stinky-cobbler/private.md", title: "A" }] }))
      .rejects.toMatchObject({ code: "DOCS_INDEX_INVALID" });
    await expect(saveDocumentationIndex(workspace, { ...base, documents: [{ path: "docs/a.md", title: " A " }] }))
      .rejects.toMatchObject({ code: "DOCS_INDEX_INVALID" });
    await expect(saveDocumentationIndex(workspace, { ...base, generatedAt: "2026-01-01T00:00:00Z" }))
      .rejects.toMatchObject({ code: "SCHEMA_INVALID", details: { kind: "docs-index" } });
    await expect(saveDocumentationIndex(workspace, {
      ...base,
      documents: Array.from({ length: 101 }, (_, index) => ({ path: `docs/${index}.md`, title: String(index) }))
    })).rejects.toMatchObject({ code: "SCHEMA_INVALID", details: { kind: "docs-index" } });

    await writeFile(await workspaceFile(workspace, "docs-index.json"), JSON.stringify({ ...base, extra: true }), "utf8");
    await expect(loadDocumentationIndex(workspace)).rejects.toMatchObject({ code: "SCHEMA_INVALID", details: { kind: "docs-index" } });
  });
});
