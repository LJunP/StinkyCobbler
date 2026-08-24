import { afterEach, describe, expect, it } from "vitest";
import { appendFile, link, mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { listRepositoryDirectory, readRepositoryFile } from "../src/mcp/repo-read.js";
import { readBoundedWorkspaceFile } from "../src/security/workspace-path.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function access(workspace: string) {
  return {
    taskId: "task",
    role: "scout",
    workspace,
    lease: {
      id: "lease", taskId: "task", agentId: "agent", role: "scout", capability: "repository-read", level: "L0" as const,
      workspace, readScope: ["docs"], writeSet: [], issuedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z", maxToolCalls: 10, status: "active" as const
    }
  };
}

describe("repository file read boundary", () => {
  it("reads one private regular file through its opened descriptor", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "stinky-repo-read-"));
    roots.push(root);
    await mkdir(path.join(root, "docs"));
    await writeFile(path.join(root, "docs", "guide.md"), "private bytes\n", "utf8");

    await expect(readRepositoryFile(access(root), "docs/guide.md"))
      .resolves.toMatchObject({ data: { path: "docs/guide.md", content: "private bytes\n" } });
  });

  it("rejects a hard-linked file instead of reading an alias outside the scoped path", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "stinky-repo-read-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "stinky-repo-read-outside-"));
    roots.push(root, outside);
    await mkdir(path.join(root, "docs"));
    const external = path.join(outside, "external.md");
    await writeFile(external, "external bytes\n", "utf8");
    await link(external, path.join(root, "docs", "linked.md"));

    await expect(readRepositoryFile(access(root), "docs/linked.md"))
      .rejects.toThrow("Hard-linked files are not readable");
  });

  it("reads at most limit + 1 bytes and rejects growth after descriptor stat", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "stinky-repo-read-"));
    roots.push(root);
    await mkdir(path.join(root, "docs"));
    const target = path.join(root, "docs", "growing.md");
    await writeFile(target, "12345678", "utf8");

    const error = await readBoundedWorkspaceFile(root, "docs/growing.md", 8, {
      afterOpen: async () => appendFile(target, "x".repeat(1024), "utf8")
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ reason: "size-limit", observed: 9 });
  });

  it("detects a persistent ancestor symlink swap after the leaf descriptor opens", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "stinky-repo-read-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "stinky-repo-read-outside-"));
    roots.push(root, outside);
    const docs = path.join(root, "docs");
    const originalDocs = path.join(root, "docs-original");
    await mkdir(docs);
    await writeFile(path.join(docs, "guide.md"), "private bytes\n", "utf8");
    await writeFile(path.join(outside, "guide.md"), "outside bytes\n", "utf8");
    let swapped = false;

    try {
      const error = await readBoundedWorkspaceFile(root, "docs/guide.md", 1024, {
        afterOpen: async () => {
          await rename(docs, originalDocs);
          await symlink(outside, docs, process.platform === "win32" ? "junction" : "dir");
          swapped = true;
        }
      }).catch((caught: unknown) => caught);

      expect(error).toMatchObject({ reason: "changed" });
    } finally {
      if (swapped) await rm(docs, { force: true });
      await rename(originalDocs, docs).catch(() => undefined);
    }
  });

  it("rejects a directory on exactly maxEntries + 1 without materializing the full listing", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "stinky-repo-read-"));
    roots.push(root);
    await mkdir(path.join(root, "docs"));
    await Promise.all(Array.from({ length: 64 }, (_, index) =>
      writeFile(path.join(root, "docs", `${String(index).padStart(3, "0")}.txt`), "x", "utf8")
    ));

    const error = await listRepositoryDirectory(access(root), "docs", 5).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ reason: "entry-limit", observed: 6 });
  });
});
