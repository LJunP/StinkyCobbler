import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SchemaRegistry } from "../src/contracts/schema-registry.js";
import type { TaskCharter } from "../src/contracts/types.js";
import { verifyLedger } from "../src/storage/ledger.js";
import { getReceipt, listReceipts, recordReceipt, validateReceipt } from "../src/storage/receipts.js";
import { createTask, getTask, taskPlan } from "../src/storage/tasks.js";
import { initWorkspace, workspaceFile } from "../src/storage/workspace.js";

const roots: string[] = [];
const schemaRoot = path.resolve(import.meta.dirname, "..");
async function project(): Promise<string> { const root = await mkdtemp(path.join(tmpdir(), "stinky-cobbler-")); roots.push(root); return root; }
function task(id = "task-1"): TaskCharter { return { id, workspaceId: "workspace", goal: "Ship it", requestedOutputs: ["code"], riskLevel: "L0", state: "DRAFT" }; }
function receipt(taskId = "task-1"): Record<string, unknown> { return { taskId, role: "builder", status: "COMPLETED", facts: [], proposals: [], unknowns: [], evidenceRefs: [], createdAt: "2026-01-01T00:00:00.000Z" }; }
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("task lifecycle storage", () => {
  it("rejects unsafe and duplicate task IDs, and reads stored tasks", async () => {
    const workspace = await initWorkspace(await project());
    await createTask(workspace, task());
    await expect(createTask(workspace, task())).rejects.toMatchObject({ code: "TASK_EXISTS" });
    await expect(createTask(workspace, task("../escape"))).rejects.toMatchObject({ code: "TASK_ID_INVALID" });
    await expect(getTask(workspace, "task-1")).resolves.toMatchObject({ state: "DRAFT" });
    expect(taskPlan("DRAFT").nextStates).toEqual(["SCOPED", "CANCELLED"]);
  });
});

describe("receipt lifecycle storage", () => {
  it("assigns an ID, validates the referenced task, stores only below receipts, and audits recording", async () => {
    const workspace = await initWorkspace(await project());
    const schemas = await SchemaRegistry.create(schemaRoot);
    await createTask(workspace, task());
    const saved = await recordReceipt(workspace, schemas, receipt());
    expect(saved.id).toMatch(/^receipt-[0-9a-f-]{36}$/);
    expect(await getReceipt(workspace, saved.id)).toEqual(saved);
    expect(await listReceipts(workspace, "task-1")).toEqual([saved]);
    expect(JSON.parse(await readFile(await workspaceFile(workspace, `receipts/${saved.id}.json`), "utf8"))).toEqual(saved);
    await expect(verifyLedger(workspace)).resolves.toMatchObject({ valid: true, entries: 1 });
  });

  it("rejects receipts with missing tasks or business changedPaths", async () => {
    const workspace = await initWorkspace(await project());
    const schemas = await SchemaRegistry.create(schemaRoot);
    await expect(validateReceipt(workspace, schemas, receipt("missing"))).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
    await createTask(workspace, task());
    await expect(validateReceipt(workspace, schemas, { ...receipt(), changedPaths: ["src/unsafe.ts"] })).rejects.toMatchObject({ code: "RECEIPT_INVALID" });
  });
});
