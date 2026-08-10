import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SchemaRegistry } from "../src/contracts/schema-registry.js";
import { initWorkspace } from "../src/storage/workspace.js";
import type { AgentRun, EvidenceRef } from "../src/contracts/types.js";
import { getEvidence, listEvidence, recordEvidence, recordEvidenceOwned } from "../src/storage/evidence.js";
import { listLedgerEntries, verifyLedger } from "../src/storage/ledger.js";
import { createRun, transitionRun } from "../src/storage/runs.js";
import { withWorkspaceLock } from "../src/storage/workspace-lock.js";

const roots: string[] = [];
const projectRoot = path.resolve(import.meta.dirname, "..");
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "stinky-evidence-"));
  roots.push(root);
  const workspace = await initWorkspace(root);
  const schemas = await SchemaRegistry.create(projectRoot);
  return { workspace, schemas };
}

function evidence(overrides: Partial<EvidenceRef> = {}): EvidenceRef {
  return {
    id: "evidence-test-1",
    kind: "tool",
    source: "repository-read",
    locator: "tool-call:tool-1",
    contentHash: `sha256:${"a".repeat(64)}`,
    observedAt: "2026-01-01T00:00:00.000Z",
    sensitivity: "internal",
    toolCallId: "tool-1",
    ...overrides
  };
}

function runtimeRun(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    version: 1,
    runId: "run-evidence",
    capsuleId: "capsule-evidence",
    taskId: "task-evidence",
    agentId: "agent-evidence",
    role: "scout",
    workspaceId: "workspace-evidence",
    leaseId: "lease-evidence",
    policyVersion: "1",
    status: "RUNNING",
    executor: "scripted-readonly",
    ownerToken: "a".repeat(64),
    fenceEpoch: 0,
    budget: { maxToolCalls: 3 },
    budgetUsage: { toolCalls: 0 },
    toolCalls: [],
    evidenceRefs: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    startedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("persistent EvidenceRef metadata", () => {
  it("enforces owner token and epoch before Evidence idempotency", async () => {
    const { workspace, schemas } = await setup();
    const owned = runtimeRun({ runId: "run-owned" });
    const terminal = runtimeRun({ runId: "run-terminal" });
    await createRun(workspace, owned);
    await createRun(workspace, terminal);
    await transitionRun(workspace, terminal.runId, "CANCELLED", {
      errorCode: "RUNTIME_CANCELLED",
      blockedReason: "Cancellation requested.",
      finishedAt: "2026-01-01T00:01:00.000Z"
    });

    const saved = await recordEvidenceOwned(workspace, schemas, evidence({ id: "evidence-owned" }), {
      runId: owned.runId,
      ownerToken: owned.ownerToken!,
      expectedEpoch: owned.fenceEpoch
    });
    expect(saved.id).toBe("evidence-owned");
    await expect(recordEvidenceOwned(workspace, schemas, evidence({ id: "evidence-owned" }), {
      runId: owned.runId,
      ownerToken: "b".repeat(64),
      expectedEpoch: owned.fenceEpoch
    })).rejects.toMatchObject({ code: "RUNTIME_RUN_FENCED" });
    await expect(recordEvidenceOwned(workspace, schemas, evidence({ id: "evidence-epoch" }), {
      runId: owned.runId,
      ownerToken: owned.ownerToken!,
      expectedEpoch: 1
    })).rejects.toMatchObject({ code: "RUNTIME_RUN_FENCED" });
    await expect(recordEvidenceOwned(workspace, schemas, evidence({ id: "evidence-terminal" }), {
      runId: terminal.runId,
      ownerToken: terminal.ownerToken!,
      expectedEpoch: terminal.fenceEpoch
    })).rejects.toMatchObject({ code: "RUNTIME_RUN_FENCED" });

    await expect(getEvidence(workspace, "evidence-epoch")).rejects.toMatchObject({ code: "EVIDENCE_NOT_FOUND" });
    await expect(getEvidence(workspace, "evidence-terminal")).rejects.toMatchObject({ code: "EVIDENCE_NOT_FOUND" });
    expect((await listLedgerEntries(workspace)).filter((entry) => entry.event === "evidence-recorded")).toHaveLength(1);
  });

  it("linearizes cancellation before owner-aware Evidence and rejects the stale owner", async () => {
    const { workspace, schemas } = await setup();
    const owned = runtimeRun({ runId: "run-cancel-first" });
    await createRun(workspace, owned);
    const entered = deferred();
    const release = deferred();
    const holder = withWorkspaceLock(workspace, async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;

    const cancelled = transitionRun(workspace, owned.runId, "CANCELLED", {
      errorCode: "RUNTIME_CANCELLED",
      blockedReason: "Cancellation requested.",
      finishedAt: "2026-01-01T00:01:00.000Z"
    });
    const persisted = recordEvidenceOwned(workspace, schemas, evidence({ id: "evidence-cancel-first" }), {
      runId: owned.runId,
      ownerToken: owned.ownerToken!,
      expectedEpoch: owned.fenceEpoch
    });
    release.resolve();
    await holder;
    await expect(cancelled).resolves.toMatchObject({ status: "CANCELLED" });
    await expect(persisted).rejects.toMatchObject({ code: "RUNTIME_RUN_FENCED" });
    await expect(getEvidence(workspace, "evidence-cancel-first")).rejects.toMatchObject({ code: "EVIDENCE_NOT_FOUND" });
    expect((await listLedgerEntries(workspace)).some((entry) => entry.event === "evidence-recorded" && entry.evidenceRef === "evidence-cancel-first")).toBe(false);
  });

  it("linearizes owner-aware Evidence before cancellation", async () => {
    const { workspace, schemas } = await setup();
    const owned = runtimeRun({ runId: "run-evidence-first" });
    await createRun(workspace, owned);
    const entered = deferred();
    const release = deferred();
    const holder = withWorkspaceLock(workspace, async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;

    const persisted = recordEvidenceOwned(workspace, schemas, evidence({ id: "evidence-evidence-first" }), {
      runId: owned.runId,
      ownerToken: owned.ownerToken!,
      expectedEpoch: owned.fenceEpoch
    });
    const cancelled = transitionRun(workspace, owned.runId, "CANCELLED", {
      errorCode: "RUNTIME_CANCELLED",
      blockedReason: "Cancellation requested.",
      finishedAt: "2026-01-01T00:01:00.000Z"
    });
    release.resolve();
    await holder;
    await expect(persisted).resolves.toMatchObject({ id: "evidence-evidence-first" });
    await expect(cancelled).resolves.toMatchObject({ status: "CANCELLED" });
    await expect(getEvidence(workspace, "evidence-evidence-first")).resolves.toMatchObject({ id: "evidence-evidence-first" });
    expect((await listLedgerEntries(workspace)).some((entry) => entry.event === "evidence-recorded" && entry.evidenceRef === "evidence-evidence-first")).toBe(true);
  });
  it("records, reads, lists, and audits metadata without source content", async () => {
    const { workspace, schemas } = await setup();
    const saved = await recordEvidence(workspace, schemas, evidence());
    expect(await getEvidence(workspace, saved.id)).toEqual(saved);
    expect(await listEvidence(workspace)).toEqual([saved]);
    const raw = await readFile(path.join(workspace.directory, "evidence", `${saved.id}.json`), "utf8");
    expect(raw).not.toContain("source content");
    await expect(verifyLedger(workspace)).resolves.toMatchObject({ valid: true, entries: 1 });
  });

  it("serializes concurrent identical records and records one ledger event", async () => {
    const { workspace, schemas } = await setup();
    const results = await Promise.all(Array.from({ length: 20 }, () => recordEvidence(workspace, schemas, evidence())));
    expect(results.every((value) => JSON.stringify(value) === JSON.stringify(results[0]))).toBe(true);
    expect(await listEvidence(workspace)).toHaveLength(1);
    await expect(verifyLedger(workspace)).resolves.toMatchObject({ valid: true, entries: 1 });
  });

  it("reconciles an existing evidence file after ledger append failure", async () => {
    const { workspace, schemas } = await setup();
    const saved = await recordEvidence(workspace, schemas, evidence());
    await rm(path.join(workspace.directory, "ledger.jsonl"));
    await mkdir(path.join(workspace.directory, "ledger.jsonl"));
    await expect(recordEvidence(workspace, schemas, saved)).rejects.toBeTruthy();
    await rm(path.join(workspace.directory, "ledger.jsonl"), { recursive: true, force: true });
    await expect(recordEvidence(workspace, schemas, saved)).resolves.toEqual(saved);
    await expect(recordEvidence(workspace, schemas, saved)).resolves.toEqual(saved);
    await expect(verifyLedger(workspace)).resolves.toMatchObject({ valid: true, entries: 1 });
  });

  it("does not silently repair an invalid ledger during reconciliation", async () => {
    const { workspace, schemas } = await setup();
    const saved = await recordEvidence(workspace, schemas, evidence());
    await rm(path.join(workspace.directory, "ledger.jsonl"));
    await readFile(path.join(workspace.directory, "evidence", `${saved.id}.json`), "utf8");
    await writeFile(path.join(workspace.directory, "ledger.jsonl"), "not-json\n", "utf8");
    await expect(recordEvidence(workspace, schemas, saved)).rejects.toBeTruthy();
  });
});
