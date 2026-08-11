import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { initWorkspace } from "../src/storage/workspace.js";
import { appendLedgerEntry, verifyLedger, archiveLedger, listArchives } from "../src/storage/ledger.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "stinky-archive-"));
  roots.push(root);
  const workspace = await initWorkspace(root);
  await mkdir(path.join(root, "docs"), { recursive: true });
  return { workspace, root };
}

describe("ledger archiving (verifiable)", () => {
  it("archives old entries, keeps the chain verifiable across segments, and appends continue", async () => {
    const { workspace, root } = await setup();
    // append several entries
    for (let i = 0; i < 4; i++) {
      await appendLedgerEntry(workspace, { event: "task-created", taskId: "t", summary: `entry ${i}` });
    }
    // force old timestamps for first two entries by rewriting the file with backdated `at`
    const ledgerPath = path.join(root, ".stinky-cobbler", "ledger.jsonl");
    const { readFile } = await import("node:fs/promises");
    const lines = (await readFile(ledgerPath, "utf8")).trim().split("\n");
    const entries = lines.map((l) => JSON.parse(l));
    entries[0].at = new Date(Date.now() - 10 * 86_400_000).toISOString();
    entries[1].at = new Date(Date.now() - 10 * 86_400_000).toISOString();
    // re-hash entries after backdating (tests operate on a fresh scratch ledger)
    let prev = "sha256:genesis";
    for (const e of entries) {
      e.prevHash = prev;
      const { hash, ...rest } = e;
      const canonical = JSON.stringify(Object.fromEntries(Object.entries(rest).sort(([a], [b]) => a.localeCompare(b))));
      const { createHash } = await import("node:crypto");
      e.hash = `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
      prev = e.hash;
    }
    await writeFile(ledgerPath, entries.map((e) => JSON.stringify(e) + "\n").join(""), "utf8");

    const result = await archiveLedger(workspace, 7);
    expect(result.archived).toBe(2);
    expect((await listArchives(workspace)).length).toBe(1);

    const verification = await verifyLedger(workspace);
    expect(verification.valid).toBe(true);
    expect(verification.entries).toBe(5); // 2 archived + 2 main + 1 ledger-archived event

    // append continues to work and verify stays valid
    await appendLedgerEntry(workspace, { event: "task-transitioned", taskId: "t", summary: "after archive" });
    expect((await verifyLedger(workspace)).valid).toBe(true);
  });

  it("archives nothing when all entries are fresh", async () => {
    const { workspace } = await setup();
    await appendLedgerEntry(workspace, { event: "task-created", taskId: "t", summary: "fresh" });
    const result = await archiveLedger(workspace, 7);
    expect(result.archived).toBe(0);
  });
});
