import path from "node:path";
import { describe, expect, it } from "vitest";
import { SchemaRegistry } from "../src/contracts/schema-registry.js";
import type { AgentReceipt, AgentRun, EvidenceRef, TaskCapsule, ToolCallRecord } from "../src/contracts/types.js";

const root = path.resolve(import.meta.dirname, "..");

const capsule: TaskCapsule = {
  version: "0.2",
  capsuleId: "capsule-1",
  runId: "run-1",
  taskId: "task-1",
  agentId: "agent-1",
  role: "scout",
  workspaceId: "workspace-1",
  leaseId: "lease-1",
  policyVersion: "1",
  goal: "Inspect the repository",
  scope: ["src"],
  readScope: ["src"],
  nonGoals: ["writes"],
  facts: [{ statement: "The repository is local.", evidenceRefs: ["evidence-1"] }],
  decisions: [{ statement: "Use read-only tools.", approvalRefs: [], provenance: "task-1" }],
  unknowns: [],
  allowedTools: ["repository-read"],
  writeSet: [],
  outputSchema: ["agent-receipt.schema.json"],
  budget: { maxTurns: 3, maxToolCalls: 5 },
  issuedAt: "2026-01-01T00:00:00.000Z",
  expiresAt: "2026-01-01T01:00:00.000Z"
};

const evidence: EvidenceRef = {
  id: "evidence-1",
  kind: "file",
  source: "workspace-1",
  locator: "src/contracts/types.ts",
  contentHash: "sha256:abc",
  observedAt: "2026-01-01T00:00:00.000Z",
  sensitivity: "internal",
  toolCallId: "call-1"
};

const toolCall: ToolCallRecord = {
  id: "call-1",
  runId: "run-1",
  capsuleId: "capsule-1",
  taskId: "task-1",
  leaseId: "lease-1",
  agentId: "agent-1",
  role: "scout",
  tool: "repository-read",
  status: "COMPLETED",
  startedAt: "2026-01-01T00:00:01.000Z",
  finishedAt: "2026-01-01T00:00:02.000Z",
  durationMs: 1000,
  evidenceRefs: ["evidence-1"]
};

const run: AgentRun = {
  version: "0.2",
  runId: "run-1",
  capsuleId: "capsule-1",
  taskId: "task-1",
  agentId: "agent-1",
  role: "scout",
  workspaceId: "workspace-1",
  leaseId: "lease-1",
  policyVersion: "1",
  status: "COMPLETED",
  executor: "scripted-readonly",
  budget: { maxTurns: 3, maxToolCalls: 5 },
  budgetUsage: { turns: 1, toolCalls: 1 },
  toolCalls: [toolCall],
  evidenceRefs: ["evidence-1"],
  createdAt: "2026-01-01T00:00:00.000Z",
  startedAt: "2026-01-01T00:00:01.000Z",
  finishedAt: "2026-01-01T00:00:02.000Z"
};

const receipt: AgentReceipt = {
  id: "receipt-1",
  taskId: "task-1",
  role: "scout",
  status: "COMPLETED",
  facts: [{ statement: "The repository is local.", evidenceRef: "evidence-1" }],
  proposals: [],
  unknowns: [],
  evidenceRefs: ["evidence-1"],
  createdAt: "2026-01-01T00:00:02.000Z",
  runId: "run-1",
  capsuleId: "capsule-1",
  leaseId: "lease-1",
  agentId: "agent-1",
  startedAt: "2026-01-01T00:00:01.000Z",
  finishedAt: "2026-01-01T00:00:02.000Z",
  executor: "scripted-readonly",
  budgetUsage: { turns: 1, toolCalls: 1 },
  toolCalls: ["call-1"]
};

describe("v0.2 runtime contracts", () => {
  it("registers and validates evidence, run, and tool-call contracts", async () => {
    const schemas = await SchemaRegistry.create(root);
    expect(() => schemas.validate("evidence-ref", evidence)).not.toThrow();
    expect(() => schemas.validate("tool-call-record", toolCall)).not.toThrow();
    expect(() => schemas.validate("agent-run", run)).not.toThrow();
  });

  it("requires an empty writeSet for versioned read-only capsules", async () => {
    const schemas = await SchemaRegistry.create(root);
    expect(() => schemas.validate("capsule", capsule)).not.toThrow();
    expect(() => schemas.validate("capsule", { ...capsule, writeSet: ["src/output.ts"] })).toThrow(/Invalid capsule/);
  });

  it("keeps the v0.1 capsule fixture shape valid", async () => {
    const schemas = await SchemaRegistry.create(root);
    expect(() => schemas.validate("capsule", {
      taskId: "task-1",
      role: "scout",
      goal: "Inspect the repository",
      scope: ["src"],
      nonGoals: [],
      facts: [],
      decisions: [],
      unknowns: [],
      allowedTools: ["repository-read"],
      outputSchema: ["agent-receipt.schema.json"]
    })).not.toThrow();
  });

  it("accepts runtime metadata on the backward-compatible receipt", async () => {
    const schemas = await SchemaRegistry.create(root);
    expect(() => schemas.validate("receipt", receipt)).not.toThrow();
  });
});
