import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SchemaRegistry } from "../src/contracts/schema-registry.js";
import { loadRegistries } from "../src/config/registry.js";
import { initWorkspace } from "../src/storage/workspace.js";
import { createTask } from "../src/storage/tasks.js";
import { admitReadonlyRuntime } from "../src/runtime/admission.js";
import { executeReadonlyRuntime } from "../src/runtime/service.js";
import { getRun, transitionRun, recoverStaleRun } from "../src/storage/runs.js";
import { listReceipts, recordReceipt } from "../src/storage/receipts.js";
import type { RuntimeToolBroker } from "../src/runtime/scripted-readonly.js";

const roots: string[] = [];
const projectRoot = path.resolve(import.meta.dirname, "..");
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function setup(options: { persistTask?: boolean } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "stinky-runtime-")); roots.push(root); const ws = await initWorkspace(root);
  await writeFile(path.join(root, "README.md"), "# Runtime\n", "utf8");
  const schemas = await SchemaRegistry.create(projectRoot); const registries = await loadRegistries(projectRoot, schemas);
  const task = { id: "task", workspaceId: "ws", goal: "Read README", requestedOutputs: ["report"], acceptanceCriteria: ["Evidence exists"], stopConditions: ["Budget exceeded"], riskLevel: "L0" as const, state: "SCOPED" as const };
  if (options.persistTask !== false) await createTask(ws, task);
  const lease = { id: "lease", taskId: "task", agentId: "agent", role: "scout", capability: "repository-read", level: "L0" as const, workspace: ws.root, readScope: ["."], writeSet: [], issuedAt: "2026-01-01T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z", maxToolCalls: 3, status: "active" as const };
  const capsule = { version: 1, capsuleId: "capsule", runId: "run", taskId: "task", agentId: "agent", role: "scout", workspaceId: "ws", leaseId: "lease", policyVersion: "1", goal: "Read README", scope: ["README.md"], readScope: ["."], nonGoals: [], facts: [], decisions: [], unknowns: [], allowedTools: ["repository-read"], writeSet: [], outputSchema: ["receipt"], budget: { maxToolCalls: 2, maxFiles: 2, maxBytes: 4096 }, issuedAt: "2026-01-01T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z" };
  return { root, ws, schemas, registries, task, lease, capsule };
}

describe("readonly Agent runtime", () => {
  it("runs through the broker and leaves the task state unchanged", async () => {
    const value = await setup();
    const result = await executeReadonlyRuntime({ ...value, requests: [{ tool: "repository-read", input: { path: "README.md" } }] });
    expect(result.run.status).toBe("COMPLETED");
    expect(result.receipt.changedPaths).toEqual([]);
    expect(value.task.state).toBe("SCOPED");
  });

  it("finalizes a receipt from the authoritative terminal Run after a transition race", async () => {
    const value = await setup();
    const result = await executeReadonlyRuntime({
      ...value,
      requests: [{ tool: "repository-read", input: { path: "README.md" } }],
      beforeFinalTransition: async () => {
        await transitionRun(value.ws, "run", "CANCELLED", {
          errorCode: "RUNTIME_CANCELLED",
          blockedReason: "Readonly run cancellation requested.",
          finishedAt: "2026-01-01T00:02:00.000Z"
        });
      }
    });
    expect(result.run).toMatchObject({ status: "CANCELLED", errorCode: "RUNTIME_CANCELLED" });
    expect(result.receipt).toMatchObject({ status: "BLOCKED", errorCode: "RUNTIME_CANCELLED", blockedReason: "Readonly run cancellation requested." });
    expect(result.receipt.facts).toEqual([]);
    await expect(listReceipts(value.ws)).resolves.toHaveLength(1);
    await expect(getRun(value.ws, "run")).resolves.toMatchObject({ status: "CANCELLED" });
  });
  it("preserves stale recovery authority during finalization", async () => {
    const value = await setup();
    const result = await executeReadonlyRuntime({
      ...value,
      requests: [{ tool: "repository-read", input: { path: "README.md" } }],
      beforeFinalTransition: async () => {
        await recoverStaleRun(value.ws, "run", {
          staleMs: 1,
          now: new Date(Date.now() + 10_000)
        });
      }
    });
    expect(result.run).toMatchObject({ status: "FAILED", fenceEpoch: 1, errorCode: "RUNTIME_STALE_RECOVERY" });
    expect(result.receipt).toMatchObject({ status: "FAILED", errorCode: "RUNTIME_STALE_RECOVERY" });
    expect(result.receipt.facts).toEqual([]);
    await expect(listReceipts(value.ws)).resolves.toHaveLength(1);
  });

  it("reuses an existing run Receipt instead of creating a duplicate", async () => {
    const value = await setup();
    const result = await executeReadonlyRuntime({
      ...value,
      requests: [{ tool: "repository-read", input: { path: "README.md" } }],
      beforeFinalTransition: async () => {
        await transitionRun(value.ws, "run", "CANCELLED", {
          errorCode: "RUNTIME_CANCELLED",
          blockedReason: "Readonly run cancellation requested.",
          finishedAt: "2026-01-01T00:02:00.000Z"
        });
        await recordReceipt(value.ws, value.schemas, {
          id: "existing-runtime-receipt",
          taskId: "task",
          role: "scout",
          status: "BLOCKED",
          facts: [],
          proposals: [],
          unknowns: ["Existing recovery receipt."],
          evidenceRefs: [],
          changedPaths: [],
          policyVersion: "1",
          toolSummary: "Existing recovery receipt.",
          createdAt: "2026-01-01T00:02:00.000Z",
          runId: "run",
          capsuleId: "capsule",
          leaseId: "lease",
          agentId: "agent",
          executor: "scripted-readonly",
          finishedAt: "2026-01-01T00:02:00.000Z",
          errorCode: "RUNTIME_CANCELLED",
          blockedReason: "Readonly run cancellation requested."
        });
      }
    });
    expect(result.receipt.id).toBe("existing-runtime-receipt");
    await expect(listReceipts(value.ws)).resolves.toHaveLength(1);
  });
  it("rejects duplicate executions for the same run ID before tool execution", async () => {
    const value = await setup();
    const input = { ...value, requests: [{ tool: "repository-read", input: { path: "README.md" } }] };
    const results = await Promise.allSettled([executeReadonlyRuntime(input), executeReadonlyRuntime(input)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const rejection = results.find((result) => result.status === "rejected");
    expect(rejection).toMatchObject({ reason: expect.objectContaining({ code: expect.stringMatching(/^RUNTIME_RUN_(EXISTS|ACTIVE)$/) }) });
    await expect(getRun(value.ws, "run")).resolves.toMatchObject({ runId: "run", status: "COMPLETED" });
  });



  it("blocks the run when evidence persistence fails", async () => {
    const value = await setup();
    const broker: RuntimeToolBroker = {
      async call(request, context) {
        const call = {
          id: "tool-failing-evidence",
          runId: context.run.runId,
          capsuleId: context.capsule.capsuleId,
          taskId: context.task.id,
          leaseId: context.lease.id,
          agentId: context.capsule.agentId,
          role: context.capsule.role,
          tool: request.tool,
          capability: "repository-read",
          status: "BLOCKED" as const,
          errorCode: "RUNTIME_EVIDENCE_PERSISTENCE_FAILED",
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString()
        };
        return call;
      }
    };
    const result = await import("../src/runtime/scripted-readonly.js").then(({ runScriptedReadonly }) => runScriptedReadonly({ ...value, requests: [{ tool: "repository-read", input: { path: "README.md" } }], broker, recordEvidence: async () => { throw new Error("failure"); }, roles: value.registries.roles }));
    expect(result.run.status).toBe("BLOCKED");
    expect(result.run.errorCode).toBe("RUNTIME_EVIDENCE_PERSISTENCE_FAILED");
    expect(result.receipt.status).toBe("BLOCKED");
    expect(result.receipt.evidenceRefs).toEqual([]);
  });

  it("rejects writable roles, DRAFT tasks, control-plane scope, and non-readonly tools", async () => {
    const value = await setup();
    await expect(admitReadonlyRuntime({ ...value, task: { ...value.task, state: "DRAFT" }, roles: value.registries.roles })).rejects.toMatchObject({ code: "RUNTIME_TASK_STATE" });
    await expect(admitReadonlyRuntime({ ...value, capsule: { ...value.capsule, role: "builder" }, lease: { ...value.lease, role: "builder" }, roles: value.registries.roles })).rejects.toMatchObject({ code: "RUNTIME_ROLE_WRITE_DENIED" });
    await expect(admitReadonlyRuntime({ ...value, capsule: { ...value.capsule, readScope: [".stinky-cobbler"] }, roles: value.registries.roles })).rejects.toMatchObject({ code: "RUNTIME_CONTROL_PLANE_DENIED" });
    await expect(admitReadonlyRuntime({ ...value, capsule: { ...value.capsule, agentId: "other-agent" }, roles: value.registries.roles })).rejects.toMatchObject({ code: "RUNTIME_AGENT_MISMATCH" });
    await expect(admitReadonlyRuntime({ ...value, capsule: { ...value.capsule, allowedTools: ["test-run"] }, roles: value.registries.roles })).rejects.toMatchObject({ code: "RUNTIME_TOOL_NOT_ALLOWED" });
  });
  it("rejects capsule budgets that exceed the lease and scopes outside readScope", async () => {
    const value = await setup();
    await expect(admitReadonlyRuntime({ ...value, capsule: { ...value.capsule, budget: { maxToolCalls: 4 } }, roles: value.registries.roles })).rejects.toMatchObject({ code: "RUNTIME_BUDGET_EXCEEDS_LEASE" });
    await expect(admitReadonlyRuntime({ ...value, capsule: { ...value.capsule, scope: ["other"] }, lease: { ...value.lease, readScope: ["README.md"] }, roles: value.registries.roles })).rejects.toMatchObject({ code: "RUNTIME_SCOPE_MISMATCH" });
  });

  it("requires the task to be persisted in the workspace before admission", async () => {
    const value = await setup({ persistTask: false });
    await expect(admitReadonlyRuntime({ ...value, roles: value.registries.roles })).rejects.toMatchObject({ code: "RUNTIME_TASK_NOT_PERSISTED", details: { taskId: "task" } });
    await expect(executeReadonlyRuntime({ ...value, requests: [{ tool: "repository-read", input: { path: "README.md" } }] })).rejects.toMatchObject({ code: "RUNTIME_TASK_NOT_PERSISTED" });
  });

  it("rejects a submitted task that diverges from the persisted workspace task", async () => {
    const value = await setup();
    await expect(admitReadonlyRuntime({ ...value, task: { ...value.task, goal: "Read something else" }, roles: value.registries.roles })).rejects.toMatchObject({ code: "RUNTIME_TASK_AUTHORITY_MISMATCH", details: { taskId: "task", field: "goal" } });
  });

  it("keeps the task state check before the persisted-task authority check", async () => {
    const value = await setup();
    await expect(admitReadonlyRuntime({ ...value, task: { ...value.task, state: "DRAFT" }, roles: value.registries.roles })).rejects.toMatchObject({ code: "RUNTIME_TASK_STATE" });
  });
});
