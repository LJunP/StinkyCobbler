import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendLedgerEntry, verifyLedger } from "../src/storage/ledger.js";
import { initWorkspace, workspaceFile } from "../src/storage/workspace.js";

const temporaryRoots: string[] = [];

async function createProject(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "stinky-cobbler-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("workspace storage", () => {
  it("creates only the .stinky-cobbler metadata directory", async () => {
    const root = await createProject();
    const workspace = await initWorkspace(root);

    const canonicalRoot = await realpath(root);
    expect(workspace.directory).toBe(path.join(canonicalRoot, ".stinky-cobbler"));
    expect(await workspaceFile(workspace, "ledger.jsonl")).toBe(path.join(canonicalRoot, ".stinky-cobbler", "ledger.jsonl"));
    await expect(workspaceFile(workspace, "../business.txt")).rejects.toMatchObject({ code: "PATH_DENIED" });
    await expect(workspaceFile(workspace, "/tmp/business.txt")).rejects.toMatchObject({ code: "PATH_DENIED" });
  });

  it("rejects filesystem root, home, and symbolic-link escapes", async () => {
    await expect(initWorkspace(path.parse(process.cwd()).root)).rejects.toMatchObject({ code: "PATH_DENIED" });
    await expect(initWorkspace(process.env.HOME!)).rejects.toMatchObject({ code: "PATH_DENIED" });

    const root = await createProject();
    const outside = await createProject();
    await symlink(outside, path.join(root, ".stinky-cobbler"));
    await expect(initWorkspace(root)).rejects.toMatchObject({ code: "PATH_DENIED" });
  });
});

describe("hash-chain ledger", () => {
  it("assigns storage-owned fields, sequences entries, and verifies a valid ledger", async () => {
    const workspace = await initWorkspace(await createProject());
    const first = await appendLedgerEntry(workspace, { event: "task-created", summary: "Created task." });
    const second = await appendLedgerEntry(workspace, { event: "validation-run", summary: "Validated task." });

    expect(first.sequence).toBe(1);
    expect(second.sequence).toBe(2);
    expect(first.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(second.prevHash).toBe(first.hash);
    await expect(verifyLedger(workspace)).resolves.toMatchObject({ valid: true, entries: 2, lastHash: second.hash });
  });

  it("accepts run lifecycle fields while keeping the hash chain valid", async () => {
    const workspace = await initWorkspace(await createProject());
    const entry = await appendLedgerEntry(workspace, {
      event: "run-transitioned",
      summary: "Run transitioned.",
      runId: "run-1",
      fromStatus: "RUNNING",
      toStatus: "COMPLETED"
    });
    expect(entry).toMatchObject({ event: "run-transitioned", runId: "run-1", fromStatus: "RUNNING", toStatus: "COMPLETED" });
    await expect(verifyLedger(workspace)).resolves.toMatchObject({ valid: true, entries: 1 });
  });
  it("serializes concurrent single-process appends per workspace", async () => {
    const workspace = await initWorkspace(await createProject());
    const entries = await Promise.all(Array.from({ length: 20 }, (_, index) => appendLedgerEntry(workspace, {
      event: "test-run",
      summary: `Test ${index}.`
    })));

    expect(entries.map((entry) => entry.sequence).sort((left, right) => left - right)).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
    await expect(verifyLedger(workspace)).resolves.toMatchObject({ valid: true, entries: 20 });
  });

  it("rejects caller-supplied storage fields and malformed append data", async () => {
    const workspace = await initWorkspace(await createProject());
    await expect(appendLedgerEntry(workspace, { event: "task-created", summary: "Created.", id: "external" } as never)).rejects.toMatchObject({ code: "LEDGER_INVALID" });
    await expect(appendLedgerEntry(workspace, { event: "task-created", summary: "Created.", at: "2026-01-01T00:00:00.000Z" } as never)).rejects.toMatchObject({ code: "LEDGER_INVALID" });
    await expect(appendLedgerEntry(workspace, { event: "task-created", summary: "Created.", hash: "sha256:000" } as never)).rejects.toMatchObject({ code: "LEDGER_INVALID" });
    await expect(appendLedgerEntry(workspace, { event: "task-created", summary: "" })).rejects.toMatchObject({ code: "LEDGER_INVALID" });
  });

  it("rejects sensitive summaries by default and can redact them explicitly", async () => {
    const workspace = await initWorkspace(await createProject());
    await expect(appendLedgerEntry(workspace, { event: "mcp-call", summary: "token=super-secret-value" })).rejects.toMatchObject({ code: "LEDGER_INVALID" });

    const entry = await appendLedgerEntry(workspace, { event: "mcp-call", summary: "token=super-secret-value" }, { sensitiveSummary: "redact" });
    expect(entry.summary).toBe("token=[REDACTED]");
    expect(entry.summary).not.toContain("super-secret-value");
  });

  it("reports blank ledger lines instead of silently filtering them", async () => {
    const workspace = await initWorkspace(await createProject());
    await appendLedgerEntry(workspace, { event: "task-created", summary: "Created." });
    const ledger = await workspaceFile(workspace, "ledger.jsonl");
    await writeFile(ledger, `${await readFile(ledger, "utf8")}\n\n`);
    await expect(verifyLedger(workspace)).resolves.toMatchObject({ valid: false, error: { code: "INVALID_JSON" } });
  });
  it("detects modified summaries, broken predecessors, and sequences", async () => {
    const workspace = await initWorkspace(await createProject());
    await appendLedgerEntry(workspace, { event: "task-created", summary: "Created." });
    await appendLedgerEntry(workspace, { event: "test-run", summary: "Passed." });
    const ledger = await workspaceFile(workspace, "ledger.jsonl");

    await writeFile(ledger, (await readFile(ledger, "utf8")).replace("Passed.", "Forged."));
    await expect(verifyLedger(workspace)).resolves.toMatchObject({ valid: false, error: { index: 1, code: "HASH_MISMATCH" } });

    const rows = (await readFile(ledger, "utf8")).trim().split("\n");
    const second = JSON.parse(rows[1]!);
    second.prevHash = "sha256:0000000000000000000000000000000000000000000000000000000000000000";
    rows[1] = JSON.stringify(second);
    await writeFile(ledger, `${rows.join("\n")}\n`);
    await expect(verifyLedger(workspace)).resolves.toMatchObject({ valid: false, error: { index: 1, code: "PREVIOUS_HASH_MISMATCH" } });

    second.prevHash = JSON.parse(rows[0]!).hash;
    second.sequence = 99;
    rows[1] = JSON.stringify(second);
    await writeFile(ledger, `${rows.join("\n")}\n`);
    await expect(verifyLedger(workspace)).resolves.toMatchObject({ valid: false, error: { index: 1, code: "SEQUENCE_MISMATCH" } });
  });
});
