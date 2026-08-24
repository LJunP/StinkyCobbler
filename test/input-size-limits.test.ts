import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SchemaRegistry } from "../src/contracts/schema-registry.js";
import type { TaskCharter } from "../src/contracts/types.js";
import { requestApproval } from "../src/storage/approvals.js";
import { issueLease } from "../src/storage/leases.js";
import { recordReceipt } from "../src/storage/receipts.js";
import { createTask, getTask, saveTask } from "../src/storage/tasks.js";
import { initWorkspace } from "../src/storage/workspace.js";

const roots: string[] = [];
const projectRoot = path.resolve(import.meta.dirname, "..");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "stinky-input-size-"));
  roots.push(root);
  const workspace = await initWorkspace(root);
  const task: TaskCharter = {
    id: "bounded-task",
    workspaceId: "workspace-1",
    goal: "Read bounded docs",
    requestedOutputs: ["report"],
    riskLevel: "L0",
    state: "SCOPED",
    scope: ["docs"]
  };
  const schemas = await SchemaRegistry.create(projectRoot);
  return { workspace, schemas, task };
}

describe("caller-controlled canonical input size limits", () => {
  it("rejects oversized Task inputs before create/save and schema persistence", async () => {
    const { workspace, schemas, task } = await setup();
    await expect(createTask(workspace, { ...task, goal: "x".repeat(2049) })).rejects.toMatchObject({ code: "TASK_INPUT_TOO_LARGE" });
    await createTask(workspace, task);
    const current = await getTask(workspace, task.id);

    await expect(saveTask(workspace, { ...current, scope: Array.from({ length: 51 }, () => "docs") }))
      .rejects.toMatchObject({ code: "TASK_INPUT_TOO_LARGE" });
    await expect(getTask(workspace, task.id)).resolves.toEqual(current);
    expect(() => schemas.validate("task", { ...current, requestedOutputs: Array.from({ length: 21 }, () => "report") }))
      .toThrow(/Invalid task contract/);
  });

  it("bounds Approval action, reason, scope, and budget before persistence", async () => {
    const { workspace, schemas, task } = await setup();
    await createTask(workspace, task);

    await expect(requestApproval(workspace, schemas, { taskId: task.id, action: "a".repeat(129) }))
      .rejects.toMatchObject({ code: "APPROVAL_INPUT_TOO_LARGE" });
    await expect(requestApproval(workspace, schemas, { taskId: task.id, action: "review", reason: "r".repeat(513) }))
      .rejects.toMatchObject({ code: "APPROVAL_INPUT_TOO_LARGE" });
    await expect(requestApproval(workspace, schemas, { taskId: task.id, action: "review", scope: Array.from({ length: 51 }, () => "docs") }))
      .rejects.toMatchObject({ code: "APPROVAL_INPUT_TOO_LARGE" });
    await expect(requestApproval(workspace, schemas, { taskId: task.id, action: "review", budget: { maxToolCalls: 1_000_001 } }))
      .rejects.toMatchObject({ code: "APPROVAL_INPUT_TOO_LARGE" });

    const approval = await requestApproval(workspace, schemas, { taskId: task.id, action: "review", scope: ["docs"] });
    expect(() => schemas.validate("approval", { ...approval, scope: Array.from({ length: 51 }, () => "docs") }))
      .toThrow(/Invalid approval contract/);
  });

  it("bounds Lease scopes, write targets, and Approval references before authority admission", async () => {
    const { workspace, schemas, task } = await setup();
    await createTask(workspace, task);
    const base = { taskId: task.id, agentId: "agent", role: "scout", capability: "repository-read" as const };

    await expect(issueLease(workspace, schemas, { ...base, readScope: Array.from({ length: 51 }, () => "docs") }))
      .rejects.toMatchObject({ code: "LEASE_READ_SCOPE_INVALID" });
    await expect(issueLease(workspace, schemas, { ...base, writeSet: Array.from({ length: 21 }, () => "docs/file.md") }))
      .rejects.toMatchObject({ code: "LEASE_WRITE_SET_INVALID" });
    await expect(issueLease(workspace, schemas, { ...base, approvalRefs: Array.from({ length: 51 }, (_, index) => `approval-${index}`) }))
      .rejects.toMatchObject({ code: "LEASE_APPROVAL_REFS_INVALID" });

    const lease = await issueLease(workspace, schemas, { ...base, readScope: ["docs"] });
    expect(() => schemas.validate("lease", { ...lease, readScope: Array.from({ length: 51 }, () => "docs") }))
      .toThrow(/Invalid lease contract/);
  });

  it("bounds general Receipt collections, nested statements, and total durable bytes", async () => {
    const { workspace, schemas, task } = await setup();
    await createTask(workspace, task);
    const base = { taskId: task.id, role: "scout", status: "COMPLETED", facts: [], proposals: [], unknowns: [], evidenceRefs: [], createdAt: "2026-08-24T00:00:00.000Z" };
    await expect(recordReceipt(workspace, schemas, { ...base, facts: Array.from({ length: 101 }, () => ({ statement: "fact" })) }))
      .rejects.toMatchObject({ code: "SCHEMA_INVALID" });
    await expect(recordReceipt(workspace, schemas, { ...base, facts: [{ statement: "x".repeat(2049) }] }))
      .rejects.toMatchObject({ code: "SCHEMA_INVALID" });
    await expect(recordReceipt(workspace, schemas, { ...base, proposals: ["x".repeat(1024 * 1024)] }))
      .rejects.toMatchObject({ code: "RECEIPT_INVALID" });
  });
});
