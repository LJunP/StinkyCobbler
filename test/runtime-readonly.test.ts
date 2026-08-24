import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SchemaRegistry } from "../src/contracts/schema-registry.js";
import type { AgentRun } from "../src/contracts/types.js";
import { loadRegistries } from "../src/config/registry.js";
import { initWorkspace, workspaceFile } from "../src/storage/workspace.js";
import { createTask } from "../src/storage/tasks.js";
import { issueLease, revokeLease } from "../src/storage/leases.js";
import { admitReadonlyRuntime } from "../src/runtime/admission.js";
import { cancelRuntime, executeReadonlyRuntime } from "../src/runtime/service.js";
import { getRun, transitionRun, recoverStaleRun } from "../src/storage/runs.js";
import { listReceipts } from "../src/storage/receipts.js";
import { getRuntimeFinalization, recordRuntimeReceipt, runtimeFinalizationId, runtimeReceiptId } from "../src/storage/runtime-finalization.js";
import { runScriptedReadonly, type RuntimeToolBroker } from "../src/runtime/scripted-readonly.js";
import { ReadonlyToolBroker } from "../src/runtime/tool-broker.js";
import { getLeaseCallUsage } from "../src/storage/lease-usage.js";
import { listEvidence } from "../src/storage/evidence.js";

const roots: string[] = [];
const projectRoot = path.resolve(import.meta.dirname, "..");
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  return { promise: new Promise<void>((done) => { resolve = done; }), resolve };
}
async function setup(options: { persistTask?: boolean } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "stinky-runtime-")); roots.push(root); const ws = await initWorkspace(root);
  await writeFile(path.join(root, "README.md"), "# Runtime\n", "utf8");
  const schemas = await SchemaRegistry.create(projectRoot); const registries = await loadRegistries(projectRoot, schemas);
  const task = { id: "task", workspaceId: "ws", goal: "Read README", requestedOutputs: ["report"], acceptanceCriteria: ["Evidence exists"], stopConditions: ["Budget exceeded"], riskLevel: "L0" as const, state: "SCOPED" as const };
  if (options.persistTask !== false) await createTask(ws, task);
  const lease = options.persistTask === false
    ? { id: "lease", taskId: "task", agentId: "agent", role: "scout", capability: "repository-read", level: "L0" as const, workspace: ws.root, readScope: ["."], writeSet: [], issuedAt: "2026-01-01T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z", maxToolCalls: 3, status: "active" as const, parentGrantRef: "task:task", taskAuthorityHash: `sha256:${"a".repeat(64)}`, policyVersion: "task-authority-v1", hostSessionId: "runtime-test" }
    : await issueLease(ws, schemas, { taskId: "task", agentId: "agent", role: "scout", capability: "repository-read", maxToolCalls: 3, expiresInMinutes: 1440 });
  const capsule = { version: 1, capsuleId: "capsule", runId: "run", taskId: "task", agentId: "agent", role: "scout", workspaceId: "ws", leaseId: lease.id, policyVersion: lease.policyVersion!, goal: "Read README", scope: ["README.md"], readScope: ["."], nonGoals: [], facts: [], decisions: [], unknowns: [], allowedTools: ["repository-read"], writeSet: [], outputSchema: ["receipt"], budget: { maxToolCalls: 2, maxFiles: 2, maxBytes: 4096 }, issuedAt: lease.issuedAt, expiresAt: lease.expiresAt };
  return { root, ws, schemas, registries, roleTools: registries.roleTools, task, lease, capsule };
}

function runtimeReceipt(run: AgentRun, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: runtimeReceiptId(run.runId),
    taskId: run.taskId,
    role: run.role,
    status: run.status === "COMPLETED" ? "COMPLETED" : run.status === "FAILED" ? "FAILED" : "BLOCKED",
    facts: [],
    proposals: [],
    unknowns: ["Existing recovery receipt."],
    evidenceRefs: run.evidenceRefs ?? [],
    changedPaths: [],
    policyVersion: run.policyVersion,
    executionRequestHash: run.executionRequestHash,
    toolSummary: "Existing recovery receipt.",
    createdAt: run.finishedAt ?? run.createdAt,
    runId: run.runId,
    capsuleId: run.capsuleId,
    leaseId: run.leaseId,
    agentId: run.agentId,
    executor: run.executor,
    ...(run.startedAt === undefined ? {} : { startedAt: run.startedAt }),
    ...(run.finishedAt === undefined ? {} : { finishedAt: run.finishedAt }),
    ...(run.budgetUsage === undefined ? {} : { budgetUsage: run.budgetUsage }),
    ...(run.toolCalls === undefined ? {} : { toolCalls: run.toolCalls }),
    ...(run.outputHash === undefined ? {} : { outputHash: run.outputHash }),
    ...(run.errorCode === undefined ? {} : { errorCode: run.errorCode }),
    ...(run.blockedReason === undefined ? {} : { blockedReason: run.blockedReason }),
    ...overrides
  };
}

describe("readonly Agent runtime", () => {
  it("rejects a Capsule policy version that differs from the authoritative persisted Lease", async () => {
    const value = await setup();
    await expect(admitReadonlyRuntime({
      ...value,
      capsule: { ...value.capsule, policyVersion: "forged-policy" },
      roles: value.registries.roles,
      roleTools: value.registries.roleTools
    })).rejects.toMatchObject({ code: "RUNTIME_POLICY_VERSION_MISMATCH" });
  });

  it("derives Run and Receipt policy provenance from the authoritative Lease", async () => {
    const value = await setup();
    const result = await executeReadonlyRuntime({ ...value, requests: [{ tool: "repository-read", input: { path: "README.md" } }] });
    expect(result.run.policyVersion).toBe(value.lease.policyVersion);
    expect(result.receipt.policyVersion).toBe(value.lease.policyVersion);
    expect(result.run.executionRequestHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(result.receipt.executionRequestHash).toBe(result.run.executionRequestHash);
    await expect(getRuntimeFinalization(value.ws, result.run.runId)).resolves.toMatchObject({
      executionRequestHash: result.run.executionRequestHash
    });
  });

  it("runs through the broker and leaves the task state unchanged", async () => {
    const value = await setup();
    const result = await executeReadonlyRuntime({ ...value, requests: [{ tool: "repository-read", input: { path: "README.md" } }] });
    expect(result.run.status).toBe("COMPLETED");
    expect(result.receipt.changedPaths).toEqual([]);
    expect(value.task.state).toBe("SCOPED");
  });

  it("checkpoints completed tool and Evidence progress before the next broker call finishes", async () => {
    const value = await setup();
    const enteredSecond = deferred();
    const releaseSecond = deferred();
    const delegate = new ReadonlyToolBroker();
    const originalCall = ReadonlyToolBroker.prototype.call;
    let calls = 0;
    const spy = vi.spyOn(ReadonlyToolBroker.prototype, "call").mockImplementation(async (request, context) => {
      calls += 1;
      if (calls === 1) return originalCall.call(delegate, request, context);
      enteredSecond.resolve();
      await releaseSecond.promise;
      return originalCall.call(delegate, request, context);
    });
    try {
      const executing = executeReadonlyRuntime({
        ...value,
        requests: [
          { tool: "repository-read", input: { path: "README.md" } },
          { tool: "repository-read", input: { path: "README.md" } }
        ]
      });
      await enteredSecond.promise;
      const checkpoint = await getRun(value.ws, value.capsule.runId);
      expect(checkpoint).toMatchObject({
        status: "RUNNING",
        budgetUsage: { toolCalls: 1 },
        toolCalls: [expect.objectContaining({ status: "COMPLETED", tool: "repository-read" })],
        evidenceRefs: [expect.stringMatching(/^evidence-/)]
      });

      releaseSecond.resolve();
      await expect(executing).resolves.toMatchObject({
        run: { status: "COMPLETED", budgetUsage: { toolCalls: 2 } }
      });
    } finally {
      releaseSecond.resolve();
      spy.mockRestore();
    }
  });

  it("aborts the broker signal used by an in-flight call when cancelRuntime wins", async () => {
    const value = await setup();
    const entered = deferred();
    const release = deferred();
    const brokerSettled = deferred();
    let brokerSignal: AbortSignal | undefined;
    let evidenceError: unknown;
    const spy = vi.spyOn(ReadonlyToolBroker.prototype, "call").mockImplementation(async (request, context) => {
      brokerSignal = context.signal;
      entered.resolve();
      await release.promise;
      try {
        await context.recordEvidence?.({
          id: "evidence-after-cancel",
          kind: "tool",
          source: request.tool,
          locator: "tool-call:after-cancel",
          contentHash: `sha256:${"a".repeat(64)}`,
          observedAt: new Date().toISOString(),
          sensitivity: "internal",
          toolCallId: "tool-after-cancel"
        });
      } catch (error) {
        evidenceError = error;
      } finally {
        brokerSettled.resolve();
      }
      return {
        id: "tool-after-cancel",
        runId: context.run.runId,
        capsuleId: context.capsule.capsuleId,
        taskId: context.task.id,
        leaseId: context.lease.id,
        agentId: context.capsule.agentId,
        role: context.capsule.role,
        tool: request.tool,
        status: "COMPLETED",
        evidenceRefs: ["evidence-after-cancel"],
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString()
      };
    });

    try {
      const executing = executeReadonlyRuntime({
        ...value,
        requests: [{ tool: "repository-read", input: { path: "README.md" } }]
      });
      await entered.promise;
      await expect(cancelRuntime(value.root, value.capsule.runId, value.schemas)).resolves.toMatchObject({ status: "CANCEL_REQUESTED" });
      const signalWasAborted = brokerSignal?.aborted;
      release.resolve();
      const result = await executing;
      await brokerSettled.promise;

      expect(signalWasAborted).toBe(true);
      expect(result.run).toMatchObject({ status: "CANCELLED", errorCode: "RUNTIME_CANCELLED" });
      expect(result.receipt).toMatchObject({ status: "BLOCKED", facts: [], evidenceRefs: [] });
      expect(result.receipt.unknowns.join(" ")).toMatch(/side effects.*unknown/i);
      expect(evidenceError).toMatchObject({ code: expect.stringMatching(/RUNTIME_(CANCELLED|RUN_FENCED)/) });
      await expect(listEvidence(value.ws)).resolves.toEqual([]);
      await expect(listReceipts(value.ws)).resolves.toEqual([expect.objectContaining({ status: "BLOCKED", facts: [], evidenceRefs: [] })]);
    } finally {
      release.resolve();
      spy.mockRestore();
    }
  });

  it("actively times out an in-flight broker at maxMinutes", async () => {
    const value = await setup();
    const entered = deferred();
    const release = deferred();
    let brokerSignal: AbortSignal | undefined;
    const spy = vi.spyOn(ReadonlyToolBroker.prototype, "call").mockImplementation(async (request, context) => {
      brokerSignal = context.signal;
      entered.resolve();
      await release.promise;
      return {
        id: "tool-after-deadline",
        runId: context.run.runId,
        capsuleId: context.capsule.capsuleId,
        taskId: context.task.id,
        leaseId: context.lease.id,
        agentId: context.capsule.agentId,
        role: context.capsule.role,
        tool: request.tool,
        status: "COMPLETED",
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString()
      };
    });

    vi.useFakeTimers();
    try {
      const executing = executeReadonlyRuntime({
        ...value,
        capsule: { ...value.capsule, budget: { ...value.capsule.budget, maxMinutes: 1 } },
        requests: [{ tool: "repository-read", input: { path: "README.md" } }]
      });
      await entered.promise;
      await vi.advanceTimersByTimeAsync(60_000);
      const signalWasAborted = brokerSignal?.aborted;
      release.resolve();
      const result = await executing;

      expect(signalWasAborted).toBe(true);
      expect(result.run).toMatchObject({ status: "TIMED_OUT", errorCode: "RUNTIME_DEADLINE_EXCEEDED" });
      expect(result.receipt).toMatchObject({ status: "BLOCKED", errorCode: "RUNTIME_DEADLINE_EXCEEDED", facts: [], evidenceRefs: [] });
      expect(result.receipt.unknowns.join(" ")).toMatch(/side effects.*unknown/i);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      release.resolve();
      spy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("does not report a broker call as completed when cancellation arrives during Evidence persistence", async () => {
    const value = await setup();
    const admission = await admitReadonlyRuntime({ ...value, roles: value.registries.roles });
    const controller = new AbortController();
    const broker = new ReadonlyToolBroker();
    const startedAt = new Date().toISOString();
    const call = await broker.call(
      { tool: "repository-read", input: { path: "README.md" } },
      {
        ...admission,
        run: {
          version: 1,
          runId: value.capsule.runId,
          capsuleId: value.capsule.capsuleId,
          taskId: value.task.id,
          agentId: value.capsule.agentId,
          role: value.capsule.role,
          workspaceId: value.capsule.workspaceId,
          leaseId: value.lease.id,
          policyVersion: value.capsule.policyVersion,
          status: "RUNNING",
          executor: "scripted-readonly",
          budget: value.capsule.budget,
          createdAt: startedAt
        },
        signal: controller.signal,
        recordEvidence: async () => { controller.abort(); }
      }
    );

    expect(call).toMatchObject({ status: "CANCELLED", errorCode: "RUNTIME_CANCELLED" });
    expect(call).not.toHaveProperty("outputHash");
    expect(call).not.toHaveProperty("evidenceRefs");
  });

  it("passes a dynamically narrowed persisted Lease from beforeRequest to the broker", async () => {
    const value = await setup();
    const capsule = { ...value.capsule, scope: ["README.md"], readScope: ["README.md"] };
    const delegate = new ReadonlyToolBroker();
    let observed: { leaseReadScope: string[]; effectiveReadScope: string[] } | undefined;
    const broker: RuntimeToolBroker = {
      async call(request, context) {
        observed = { leaseReadScope: [...context.lease.readScope], effectiveReadScope: [...context.effectiveReadScope] };
        return delegate.call(request, context);
      }
    };
    const result = await runScriptedReadonly({
      root: value.root,
      task: value.task,
      capsule,
      lease: value.lease,
      schemas: value.schemas,
      roles: value.registries.roles,
      roleTools: value.registries.roleTools,
      requests: [{ tool: "repository-read", input: { path: "README.md" } }],
      broker,
      beforeRequest: async () => {
        await writeFile(
          await workspaceFile(value.ws, `leases/${value.lease.id}.json`),
          JSON.stringify({ ...value.lease, readScope: ["README.md"] }),
          "utf8"
        );
        return admitReadonlyRuntime({ ...value, capsule, roles: value.registries.roles });
      }
    });
    expect(result.run.status).toBe("COMPLETED");
    expect(observed).toEqual({ leaseReadScope: ["README.md"], effectiveReadScope: ["README.md"] });
    await expect(getLeaseCallUsage(value.ws, value.lease.id)).resolves.toBe(1);
  });

  it("enforces Capsule scope in addition to the broader Lease readScope", async () => {
    const value = await setup();
    await writeFile(path.join(value.root, "outside-capsule.md"), "must stay outside capsule\n", "utf8");
    const result = await executeReadonlyRuntime({
      ...value,
      requests: [{ tool: "repository-read", input: { path: "outside-capsule.md" } }]
    });
    expect(result.run).toMatchObject({ status: "BLOCKED", errorCode: "RUNTIME_TOOL_FAILED" });
    expect(result.receipt.status).toBe("BLOCKED");
    await expect(getLeaseCallUsage(value.ws, value.lease.id)).resolves.toBe(1);
  });

  it("shares the persisted Lease maxToolCalls limit across distinct Runtime runs", async () => {
    const value = await setup();
    const sharedLease = await issueLease(value.ws, value.schemas, {
      taskId: "task",
      agentId: "agent",
      role: "scout",
      capability: "repository-read",
      maxToolCalls: 1,
      expiresInMinutes: 1440
    });
    const capsuleFor = (suffix: string) => ({
      ...value.capsule,
      capsuleId: `capsule-${suffix}`,
      runId: `run-${suffix}`,
      leaseId: sharedLease.id,
      budget: { ...value.capsule.budget, maxToolCalls: 1 },
      issuedAt: sharedLease.issuedAt,
      expiresAt: sharedLease.expiresAt
    });
    const first = await executeReadonlyRuntime({
      ...value,
      capsule: capsuleFor("one"),
      lease: sharedLease,
      requests: [{ tool: "repository-read", input: { path: "README.md" } }]
    });
    const second = await executeReadonlyRuntime({
      ...value,
      capsule: capsuleFor("two"),
      lease: sharedLease,
      requests: [{ tool: "repository-read", input: { path: "README.md" } }]
    });
    expect(first.run.status).toBe("COMPLETED");
    expect(second.run.status).toBe("BLOCKED");
    await expect(getLeaseCallUsage(value.ws, sharedLease.id)).resolves.toBe(1);
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
        const cancelled = await transitionRun(value.ws, "run", "CANCELLED", {
          errorCode: "RUNTIME_CANCELLED",
          blockedReason: "Readonly run cancellation requested.",
          finishedAt: "2026-01-01T00:02:00.000Z"
        });
        await recordRuntimeReceipt(value.ws, value.schemas, runtimeReceipt(cancelled));
      }
    });
    expect(result.receipt.id).toBe(runtimeReceiptId("run"));
    await expect(listReceipts(value.ws)).resolves.toHaveLength(1);
  });

  it("rejects an existing Runtime Receipt when its required finalization journal is missing", async () => {
    const value = await setup();
    const executing = executeReadonlyRuntime({
      ...value,
      requests: [{ tool: "repository-read", input: { path: "README.md" } }],
      beforeFinalTransition: async () => {
        const cancelled = await transitionRun(value.ws, "run", "CANCELLED", {
          errorCode: "RUNTIME_CANCELLED",
          blockedReason: "Readonly run cancellation requested.",
          finishedAt: "2026-01-01T00:02:00.000Z"
        });
        await recordRuntimeReceipt(value.ws, value.schemas, runtimeReceipt(cancelled));
        await rm(path.join(
          value.ws.directory,
          "runtime-finalizations",
          `${runtimeFinalizationId(cancelled.runId)}.json`
        ));
      }
    });

    await expect(executing).rejects.toMatchObject({ code: "RUNTIME_FINALIZATION_NOT_FOUND" });
    await expect(listReceipts(value.ws)).resolves.toHaveLength(1);
  });

  it("rejects a pre-existing forged run Receipt instead of reusing it", async () => {
    const value = await setup();
    const executing = executeReadonlyRuntime({
      ...value,
      requests: [{ tool: "repository-read", input: { path: "README.md" } }],
      beforeFinalTransition: async () => {
        const cancelled = await transitionRun(value.ws, "run", "CANCELLED", {
          errorCode: "RUNTIME_CANCELLED",
          blockedReason: "Readonly run cancellation requested.",
          finishedAt: "2026-01-01T00:02:00.000Z"
        });
        const forged = runtimeReceipt(cancelled, {
          taskId: "forged-task",
          capsuleId: "forged-capsule",
          leaseId: "forged-lease",
          agentId: "forged-agent",
          role: "forged-role",
          executor: "forged-executor",
          policyVersion: "forged-policy",
          executionRequestHash: `sha256:${"b".repeat(64)}`,
          status: "COMPLETED",
          evidenceRefs: ["forged-evidence"],
          outputHash: "sha256:forged"
        });
        const directory = path.join(value.ws.directory, "receipts");
        await mkdir(directory, { recursive: true });
        await writeFile(path.join(directory, `${runtimeReceiptId("run")}.json`), JSON.stringify(forged), "utf8");
      }
    });
    await expect(executing).rejects.toMatchObject({
      code: "RUNTIME_RECEIPT_CONFLICT",
      details: {
        fields: expect.arrayContaining(["taskId", "capsuleId", "leaseId", "agentId", "role", "executor", "policyVersion", "executionRequestHash", "status", "evidenceRefs", "outputHash"])
      }
    });
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

  it("returns the exact terminal Run and Receipt for an exact sequential retry without executing again", async () => {
    const value = await setup();
    const firstInput = { ...value, requests: [{ tool: "repository-read", input: { path: "README.md", maxBytes: 4096 } }] };
    const retryWithReorderedObjectKeys = { ...value, requests: [{ tool: "repository-read", input: { maxBytes: 4096, path: "README.md" } }] };
    const first = await executeReadonlyRuntime(firstInput);
    const evidenceBefore = await listEvidence(value.ws);
    const second = await executeReadonlyRuntime(retryWithReorderedObjectKeys);

    expect(second.run).toEqual(first.run);
    expect(second.receipt).toEqual(first.receipt);
    expect(await listEvidence(value.ws)).toEqual(evidenceBefore);
    await expect(listReceipts(value.ws)).resolves.toHaveLength(1);
  });

  it("rejects terminal retries when path, Capsule scope, Capsule budget, or ordered requests change", async () => {
    const cases: Array<(value: Awaited<ReturnType<typeof setup>>) => Parameters<typeof executeReadonlyRuntime>[0]> = [
      (value) => ({ ...value, requests: [{ tool: "repository-read", input: { path: "different.md" } }] }),
      (value) => ({ ...value, capsule: { ...value.capsule, scope: ["."] }, requests: [{ tool: "repository-read", input: { path: "README.md" } }] }),
      (value) => ({ ...value, capsule: { ...value.capsule, budget: { ...value.capsule.budget, maxFiles: 1 } }, requests: [{ tool: "repository-read", input: { path: "README.md" } }] }),
      (value) => ({ ...value, requests: [
        { tool: "repository-read", input: { path: "README.md" } },
        { tool: "repository-read", input: { path: "README.md" } }
      ] })
    ];

    for (const changedInput of cases) {
      const value = await setup();
      await executeReadonlyRuntime({ ...value, requests: [{ tool: "repository-read", input: { path: "README.md" } }] });
      await expect(executeReadonlyRuntime(changedInput(value))).rejects.toMatchObject({ code: "RUNTIME_IDEMPOTENCY_CONFLICT" });
    }
  });

  it("fails closed when a legacy terminal Run has no execution request hash", async () => {
    const value = await setup();
    const input = { ...value, requests: [{ tool: "repository-read", input: { path: "README.md" } }] };
    await executeReadonlyRuntime(input);
    const stored = await getRun(value.ws, "run");
    const { executionRequestHash: _legacyMissing, ...legacy } = stored;
    await writeFile(await workspaceFile(value.ws, "runs/run.json"), JSON.stringify(legacy), "utf8");

    await expect(executeReadonlyRuntime(input)).rejects.toMatchObject({
      code: "RUNTIME_IDEMPOTENCY_CONFLICT",
      details: { storedExecutionRequestHash: null }
    });
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
    const builderLease = await issueLease(value.ws, value.schemas, { taskId: "task", agentId: "agent", role: "builder", capability: "repository-read", expiresInMinutes: 1440 });
    await expect(admitReadonlyRuntime({
      ...value,
      lease: builderLease,
      capsule: { ...value.capsule, role: "builder", leaseId: builderLease.id, issuedAt: builderLease.issuedAt, expiresAt: builderLease.expiresAt },
      roles: value.registries.roles
    })).rejects.toMatchObject({ code: "RUNTIME_ROLE_WRITE_DENIED" });
    await expect(admitReadonlyRuntime({ ...value, capsule: { ...value.capsule, readScope: [".stinky-cobbler"] }, roles: value.registries.roles })).rejects.toMatchObject({ code: "RUNTIME_CONTROL_PLANE_DENIED" });
    await expect(admitReadonlyRuntime({ ...value, capsule: { ...value.capsule, agentId: "other-agent" }, roles: value.registries.roles })).rejects.toMatchObject({ code: "RUNTIME_AGENT_MISMATCH" });
    await expect(admitReadonlyRuntime({ ...value, capsule: { ...value.capsule, allowedTools: ["test-run"] }, roles: value.registries.roles })).rejects.toMatchObject({ code: "RUNTIME_TOOL_NOT_ALLOWED" });
  });
  it("enforces the persisted role-to-tools policy and rejects unknown roles", async () => {
    const value = await setup();
    await expect(issueLease(value.ws, value.schemas, { taskId: "task", agentId: "agent", role: "conductor", capability: "repository-read", expiresInMinutes: 1440 }))
      .rejects.toMatchObject({ code: "LEASE_ROLE_CAPABILITY_DENIED" });
    const conductorLease = { ...value.lease, id: "lease-legacy-conductor", role: "conductor" };
    await writeFile(await workspaceFile(value.ws, `leases/${conductorLease.id}.json`), JSON.stringify(conductorLease), "utf8");
    await expect(admitReadonlyRuntime({
      ...value,
      lease: conductorLease,
      capsule: { ...value.capsule, role: "conductor", leaseId: conductorLease.id, issuedAt: conductorLease.issuedAt, expiresAt: conductorLease.expiresAt },
      roles: value.registries.roles
    })).rejects.toMatchObject({ code: "RUNTIME_ROLE_TOOL_DENIED" });

    await expect(issueLease(value.ws, value.schemas, { taskId: "task", agentId: "agent", role: "unknown-role", capability: "repository-read", expiresInMinutes: 1440 }))
      .rejects.toMatchObject({ code: "LEASE_ROLE_UNKNOWN" });
    const unknownLease = { ...value.lease, id: "lease-legacy-unknown", role: "unknown-role" };
    await writeFile(await workspaceFile(value.ws, `leases/${unknownLease.id}.json`), JSON.stringify(unknownLease), "utf8");
    await expect(admitReadonlyRuntime({
      ...value,
      lease: unknownLease,
      capsule: { ...value.capsule, role: "unknown-role", leaseId: unknownLease.id, issuedAt: unknownLease.issuedAt, expiresAt: unknownLease.expiresAt },
      roles: value.registries.roles
    })).rejects.toMatchObject({ code: "RUNTIME_ROLE_UNKNOWN" });
  });
  it("rejects capsule budgets that exceed the lease and scopes outside readScope", async () => {
    const value = await setup();
    await expect(admitReadonlyRuntime({ ...value, capsule: { ...value.capsule, budget: { maxToolCalls: 4 } }, roles: value.registries.roles })).rejects.toMatchObject({ code: "RUNTIME_BUDGET_EXCEEDS_LEASE" });
    await expect(admitReadonlyRuntime({ ...value, capsule: { ...value.capsule, scope: ["other"] }, lease: { ...value.lease, readScope: ["README.md"] }, roles: value.registries.roles })).resolves.toMatchObject({ lease: { readScope: ["."] } });
  });

  it("uses the persisted runtime lease as authority and honors revocation", async () => {
    const value = await setup();
    const forged = { ...value.lease, readScope: ["other"], maxToolCalls: 999, status: "active" as const };
    await expect(admitReadonlyRuntime({ ...value, lease: forged, roles: value.registries.roles })).resolves.toMatchObject({
      lease: { id: value.lease.id, readScope: ["."], maxToolCalls: 3 }
    });
    await revokeLease(value.ws, value.lease.id, "Runtime test revocation.");
    await expect(admitReadonlyRuntime({ ...value, lease: forged, roles: value.registries.roles })).rejects.toMatchObject({ code: "LEASE_NOT_ACTIVE" });
  });

  it("rejects a runtime lease that was never issued in the workspace", async () => {
    const value = await setup();
    await expect(admitReadonlyRuntime({
      ...value,
      lease: { ...value.lease, id: "never-issued" },
      capsule: { ...value.capsule, leaseId: "never-issued" },
      roles: value.registries.roles
    })).rejects.toMatchObject({ code: "RUNTIME_LEASE_NOT_PERSISTED", details: { leaseId: "never-issued" } });
  });

  it("rejects a persisted runtime lease whose embedded ID differs from its canonical lookup ID", async () => {
    const value = await setup();
    await writeFile(
      await workspaceFile(value.ws, `leases/${value.lease.id}.json`),
      JSON.stringify({ ...value.lease, id: "different-runtime-lease", maxToolCalls: 100 }),
      "utf8"
    );
    await expect(admitReadonlyRuntime({ ...value, roles: value.registries.roles })).rejects.toMatchObject({
      code: "RUNTIME_LEASE_INVALID",
      details: { leaseId: value.lease.id, storedLeaseId: "different-runtime-lease" }
    });
  });

  it("rejects a persisted runtime lease whose orchestration subtask binding cannot be verified", async () => {
    const value = await setup();
    const boundLease = await issueLease(value.ws, value.schemas, {
      taskId: "task",
      agentId: "agent",
      role: "scout",
      capability: "repository-read",
      subtaskRef: "missing-subtask",
      subtaskAttempt: 0,
      expiresInMinutes: 1440
    });
    await expect(admitReadonlyRuntime({
      ...value,
      lease: boundLease,
      capsule: {
        ...value.capsule,
        leaseId: boundLease.id,
        issuedAt: boundLease.issuedAt,
        expiresAt: boundLease.expiresAt
      },
      roles: value.registries.roles
    })).rejects.toMatchObject({ code: "LEASE_SUBTASK_BINDING_INVALID" });
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
