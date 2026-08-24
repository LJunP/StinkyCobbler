import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CapabilityLease } from "../src/contracts/types.js";
import type { SchemaRegistry } from "../src/contracts/schema-registry.js";
import type { Registries } from "../src/config/registry.js";
import type { LocalWorkspace } from "../src/storage/workspace.js";
import { createTask } from "../src/storage/tasks.js";
import { createPlan, confirmPlan, executePlan, beginStep } from "../src/storage/plans.js";
import { requestWrites, confirmWrites } from "../src/storage/write-intents.js";
import { issueLease } from "../src/storage/leases.js";
import { applyWrite } from "../src/storage/writes.js";
import type { WriteIntentRecord } from "../src/storage/write-intents.js";
import { approvePlanConfirmation, approveTaskCapability, approveWriteIntent } from "./helpers/authority.js";

/** Prepares a workspace with a confirmed write intent and an L1 write lease. */
export async function prepareConfirmedWrite(workspace: LocalWorkspace, schemas: SchemaRegistry, registries: Registries): Promise<{ planId: string; intent: WriteIntentRecord; lease: CapabilityLease }> {
  await mkdir(path.join(workspace.root, "docs"), { recursive: true });
  await writeFile(path.join(workspace.root, "docs", "note.md"), "original\n", "utf8");
  const task = {
    id: "crash-task",
    workspaceId: "workspace-1",
    goal: "x",
    requestedOutputs: ["report"],
    riskLevel: "L0",
    state: "RUNNING",
    scope: ["."],
    writeSet: ["docs/note.md"]
  } as const;
  await createTask(workspace, task);
  const writeIntentApproval = await approveTaskCapability(workspace, schemas, task, "repository-write", ["docs/note.md"]);
  const plan = await createPlan(workspace, schemas, registries, { taskId: "crash-task", roles: ["builder"] });
  await approvePlanConfirmation(workspace, schemas, plan);
  await confirmPlan(workspace, plan.planId);
  await executePlan(workspace, plan.planId);
  await beginStep(workspace, schemas, plan.planId, "step-1");
  const intent = await requestWrites(workspace, schemas, plan.planId, "step-1", [{ target: "docs/note.md", action: "modify", purpose: "Update." }], { approvalRefs: [writeIntentApproval.id] });
  await approveWriteIntent(workspace, schemas, intent);
  await confirmWrites(workspace, plan.planId, "step-1", intent.writeIntentId, schemas);
  const confirmed = await getWriteIntentRecord(workspace, intent.writeIntentId);
  const leaseApproval = await approveTaskCapability(workspace, schemas, task, "repository-write", ["docs/note.md"]);
  const lease = await issueLease(workspace, schemas, { taskId: "crash-task", agentId: "builder-agent", role: "builder", capability: "repository-write", writeSet: ["docs/note.md"], approvalRefs: [leaseApproval.id] });
  return { planId: plan.planId, intent: confirmed, lease };
}

async function getWriteIntentRecord(workspace: LocalWorkspace, writeIntentId: string): Promise<WriteIntentRecord> {
  const { getWriteIntent } = await import("../src/storage/write-intents.js");
  return getWriteIntent(workspace, writeIntentId);
}

/** Applies a confirmed write (thin wrapper for the crash matrix). */
export async function applyWriteForMatrix(workspace: LocalWorkspace, schemas: SchemaRegistry, lease: CapabilityLease, intent: WriteIntentRecord, target: string, content: string): Promise<unknown> {
  return applyWrite(workspace, schemas, lease, intent, target, content);
}
