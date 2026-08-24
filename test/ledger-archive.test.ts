import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { initWorkspace } from "../src/storage/workspace.js";
import { appendLedgerEntry, verifyLedger, archiveLedger, listArchives, listLedgerEntries } from "../src/storage/ledger.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "stinky-archive-"));
  roots.push(root);
  const workspace = await initWorkspace(root);
  await mkdir(path.join(root, "docs"), { recursive: true });
  return { workspace, root };
}

function hashEntry(entry: Record<string, unknown>): string {
  const canonical = JSON.stringify(Object.fromEntries(Object.entries(entry).sort(([left], [right]) => left.localeCompare(right))));
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

function hashContents(contents: string): string {
  return `sha256:${createHash("sha256").update(contents, "utf8").digest("hex")}`;
}

async function backdatePrefix(root: string, count: number): Promise<Array<Record<string, unknown>>> {
  const ledgerPath = path.join(root, ".stinky-cobbler", "ledger.jsonl");
  const entries = (await readFile(ledgerPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  for (let index = 0; index < count; index += 1) entries[index]!.at = new Date(Date.now() - 10 * 86_400_000).toISOString();
  let previous = typeof entries[0]?.prevHash === "string" ? entries[0].prevHash : "sha256:genesis";
  for (const entry of entries) {
    entry.prevHash = previous;
    delete entry.hash;
    entry.hash = hashEntry(entry);
    previous = entry.hash as string;
  }
  await writeFile(ledgerPath, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""), "utf8");
  return entries;
}

type InterruptedState = "prepared" | "archive-published" | "main-published" | "both-published";

async function prepareInterruptedArchive(root: string, state: InterruptedState): Promise<{ archiveFile: string }> {
  const metadata = path.join(root, ".stinky-cobbler");
  const ledgerPath = path.join(metadata, "ledger.jsonl");
  const sourceContents = await readFile(ledgerPath, "utf8");
  const entries = sourceContents.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  const archived = entries.slice(0, 2);
  const remaining = entries.slice(2);
  const transactionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const archiveFile = `ledger-archive-2026-08-24T00-00-00-000Z-${transactionId}.jsonl`;
  const archiveTemporaryFile = `ledger-archives/.ledger-archive-${transactionId}.jsonl.tmp`;
  const mainTemporaryFile = `.ledger-archive-${transactionId}.jsonl.tmp`;
  const archiveContents = archived.map((entry) => `${JSON.stringify(entry)}\n`).join("");
  const archiveTail = archived.at(-1)!;
  const mainTail = remaining.at(-1)!;
  const archiveEvent: Record<string, unknown> = {
    sequence: (mainTail.sequence as number) + 1,
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    at: "2026-08-24T00:00:00.000Z",
    event: "ledger-archived",
    summary: `Archived 2 entries to ${archiveFile}; archive tail ${(archiveTail.hash as string).slice(0, 20)}...`,
    prevHash: mainTail.hash
  };
  archiveEvent.hash = hashEntry(archiveEvent);
  const mainContents = [...remaining, archiveEvent].map((entry) => `${JSON.stringify(entry)}\n`).join("");
  const archiveDirectory = path.join(metadata, "ledger-archives");
  await mkdir(archiveDirectory, { recursive: true });

  const archivePath = path.join(archiveDirectory, archiveFile);
  const archiveTemporaryPath = path.join(metadata, archiveTemporaryFile);
  const mainTemporaryPath = path.join(metadata, mainTemporaryFile);
  if (state === "archive-published" || state === "both-published") await writeFile(archivePath, archiveContents, "utf8");
  else await writeFile(archiveTemporaryPath, archiveContents, "utf8");
  if (state === "main-published" || state === "both-published") await writeFile(ledgerPath, mainContents, "utf8");
  else await writeFile(mainTemporaryPath, mainContents, "utf8");

  await writeFile(path.join(metadata, "ledger-archive-transaction.json"), `${JSON.stringify({
    version: 1,
    createdAt: "2026-08-24T00:00:00.000Z",
    archived: 2,
    archiveFile,
    archiveTemporaryFile,
    mainTemporaryFile,
    sourceLedgerHash: hashContents(sourceContents),
    archiveHash: hashContents(archiveContents),
    mainHash: hashContents(mainContents)
  }, null, 2)}\n`, "utf8");
  return { archiveFile };
}

describe("ledger archiving (verifiable)", () => {
  it("archives old entries, keeps the chain verifiable across segments, and appends continue", async () => {
    const { workspace, root } = await setup();
    // append several entries
    for (let i = 0; i < 4; i++) {
      await appendLedgerEntry(workspace, { event: "task-created", taskId: "t", summary: `entry ${i}` });
    }
    await backdatePrefix(root, 2);

    const result = await archiveLedger(workspace, 7);
    expect(result.archived).toBe(2);
    expect((await listArchives(workspace)).length).toBe(1);

    const verification = await verifyLedger(workspace);
    expect(verification.valid).toBe(true);
    expect(verification.entries).toBe(5); // 2 archived + 2 main + 1 ledger-archived event
    const listed = await listLedgerEntries(workspace);
    expect(listed.map((entry) => entry.sequence)).toEqual([1, 2, 3, 4, 5]);
    expect(listed.slice(0, 4).map((entry) => entry.summary)).toEqual(["entry 0", "entry 1", "entry 2", "entry 3"]);

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

  it("clamps a single old main-ledger entry without dereferencing an empty archive", async () => {
    const { workspace, root } = await setup();
    await appendLedgerEntry(workspace, { event: "task-created", taskId: "t", summary: "only old entry" });
    await backdatePrefix(root, 1);

    await expect(archiveLedger(workspace, 7)).resolves.toEqual({ archived: 0, archiveFile: "" });
    await expect(verifyLedger(workspace)).resolves.toMatchObject({ valid: true, entries: 1 });
    await expect(listArchives(workspace)).resolves.toEqual([]);
  });

  it("returns every validated archive segment plus main in canonical sequence order", async () => {
    const { workspace, root } = await setup();
    for (let index = 0; index < 4; index += 1) {
      await appendLedgerEntry(workspace, { event: "task-created", taskId: "t", summary: `multi ${index}` });
    }
    await backdatePrefix(root, 2);
    await expect(archiveLedger(workspace, 7)).resolves.toMatchObject({ archived: 2 });
    await backdatePrefix(root, 2);
    await expect(archiveLedger(workspace, 7)).resolves.toMatchObject({ archived: 2 });

    expect(await listArchives(workspace)).toHaveLength(2);
    const entries = await listLedgerEntries(workspace);
    expect(entries.map((entry) => entry.sequence)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(entries.filter((entry) => entry.event === "ledger-archived")).toHaveLength(2);
    await expect(verifyLedger(workspace)).resolves.toMatchObject({ valid: true, entries: 6 });
  });

  it.each<InterruptedState>(["prepared", "archive-published", "main-published", "both-published"])(
    "reconciles a %s archive transaction and makes retry idempotent",
    async (state) => {
      const { workspace, root } = await setup();
      for (let index = 0; index < 4; index += 1) {
        await appendLedgerEntry(workspace, { event: "task-created", taskId: "t", summary: `crash entry ${index}` });
      }
      await backdatePrefix(root, 2);
      const transaction = await prepareInterruptedArchive(root, state);

      await expect(archiveLedger(workspace, 7)).resolves.toEqual({ archived: 2, archiveFile: transaction.archiveFile });
      await expect(verifyLedger(workspace)).resolves.toMatchObject({ valid: true, entries: 5 });
      expect((await listLedgerEntries(workspace)).map((entry) => entry.sequence)).toEqual([1, 2, 3, 4, 5]);
      await expect(readFile(path.join(root, ".stinky-cobbler", "ledger-archive-transaction.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    }
  );

  it("fails closed before either rename when prepared transaction bytes are damaged", async () => {
    const { workspace, root } = await setup();
    for (let index = 0; index < 4; index += 1) {
      await appendLedgerEntry(workspace, { event: "task-created", taskId: "t", summary: `damaged ${index}` });
    }
    await backdatePrefix(root, 2);
    const sourcePath = path.join(root, ".stinky-cobbler", "ledger.jsonl");
    const sourceContents = await readFile(sourcePath, "utf8");
    const transaction = await prepareInterruptedArchive(root, "prepared");
    await writeFile(path.join(root, ".stinky-cobbler", ".ledger-archive-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jsonl.tmp"), "damaged\n", "utf8");

    await expect(archiveLedger(workspace, 7)).rejects.toMatchObject({ code: "LEDGER_INVALID" });
    await expect(readFile(path.join(root, ".stinky-cobbler", "ledger-archives", transaction.archiveFile), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(sourcePath, "utf8")).toBe(sourceContents);
  });

  it("refuses to list archive entries through a symlinked control-plane directory", async () => {
    const { workspace } = await setup();
    const outside = await mkdtemp(path.join(os.tmpdir(), "stinky-ledger-archive-outside-"));
    roots.push(outside);
    await writeFile(path.join(outside, "ledger-archive-2026-01-01T00-00-00-000Z.jsonl"), "external\n", "utf8");
    await symlink(outside, path.join(workspace.directory, "ledger-archives"));

    await expect(listArchives(workspace)).rejects.toMatchObject({ code: "PATH_DENIED" });
  });
});
