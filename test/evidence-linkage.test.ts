import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentRun, EvidenceRef } from "../src/contracts/types.js";
import { SchemaRegistry } from "../src/contracts/schema-registry.js";
import { initWorkspace } from "../src/storage/workspace.js";
import { recordEvidence, listEvidence, inspectEvidence } from "../src/storage/evidence.js";
import { createRun } from "../src/storage/runs.js";

const roots: string[] = [];
const projectRoot = path.resolve(import.meta.dirname, "..");
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

function evidence(id = "evidence-orphan"): EvidenceRef {
  return { id, kind: "tool", source: "repository-read", locator: `tool-call:${id}`, contentHash: `sha256:${"a".repeat(64)}`, observedAt: "2026-01-01T00:00:00.000Z", sensitivity: "internal", toolCallId: id };
}
function run(refs: string[]): AgentRun {
  return { version: 1, runId: "run-link", capsuleId: "capsule", taskId: "task-link", agentId: "agent", role: "scout", workspaceId: "ws", leaseId: "lease", policyVersion: "1", status: "COMPLETED", executor: "scripted-readonly", budget: {}, createdAt: "2026-01-01T00:00:00.000Z", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:01:00.000Z", evidenceRefs: refs, toolCalls: [] };
}

describe("Evidence linkage diagnostics", () => {
  it("links top-level Run evidenceRefs and reports orphan evidence", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "stinky-evidence-link-")); roots.push(root);
    const workspace = await initWorkspace(root); const schemas = await SchemaRegistry.create(projectRoot);
    const linked = await recordEvidence(workspace, schemas, evidence("evidence-linked"));
    await recordEvidence(workspace, schemas, evidence());
    await createRun(workspace, run([linked.id]));
    await expect(inspectEvidence(workspace, schemas, linked.id)).resolves.toMatchObject({ orphan: false, linkedTaskId: "task-link", linkedRunId: "run-link" });
    await expect(inspectEvidence(workspace, schemas, "evidence-orphan")).resolves.toMatchObject({ orphan: true });
    await expect(listEvidence(workspace, { orphan: true })).resolves.toEqual([expect.objectContaining({ id: "evidence-orphan" })]);
  });

  it("retains object ToolCall linkage and multiple run links", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "stinky-evidence-call-")); roots.push(root);
    const workspace = await initWorkspace(root); const schemas = await SchemaRegistry.create(projectRoot);
    const item = await recordEvidence(workspace, schemas, evidence("evidence-call"));
    const first = run([]); first.runId = "run-a"; first.taskId = "task-a"; first.toolCalls = [{ id: "call", runId: "run-a", capsuleId: "capsule", taskId: "task-a", leaseId: "lease", agentId: "agent", role: "scout", tool: "repository-read", status: "COMPLETED", startedAt: "2026-01-01T00:00:00.000Z", evidenceRefs: [item.id] }];
    const second = run([item.id]); second.runId = "run-b"; second.taskId = "task-b";
    await createRun(workspace, first); await createRun(workspace, second);
    await expect(inspectEvidence(workspace, schemas, item.id)).resolves.toMatchObject({ linkedTaskIds: ["task-a", "task-b"], linkedRunIds: ["run-a", "run-b"] });
  });
});
