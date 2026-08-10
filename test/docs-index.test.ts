import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildDocumentationIndex, readDocumentationIndex } from "../src/mcp/docs-index.js";
import { initWorkspace, workspaceFile } from "../src/storage/workspace.js";

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
});
