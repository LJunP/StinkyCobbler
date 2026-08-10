import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SchemaRegistry } from "../src/contracts/schema-registry.js";
import { loadRegistries } from "../src/config/registry.js";
import { createTask } from "../src/storage/tasks.js";
import { initWorkspace } from "../src/storage/workspace.js";
import { createPlan, confirmPlan, executePlan, beginStep } from "../src/storage/plans.js";
import { requestWrites, getWriteIntent, rollbackWrite } from "../src/storage/write-intents.js";
import { requestApproval, decideApproval } from "../src/storage/approvals.js";
import { issueLease } from "../src/storage/leases.js";
import { applyWrite } from "../src/storage/writes.js";
import { listLedgerEntries } from "../src/storage/ledger.js";
import type { WriteIntent } from "../src/contracts/types.js";

const roots: string[] = [];
const projectRoot = path.resolve(import.meta.dirname, "..");
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "stinky-autoallow-"));
  roots.push(root);
  const workspace = await initWorkspace(root);
  await mkdir(path.join(root, "docs"), { recursive: true });
  await writeFile(path.join(root, "docs", "guide.md"), "original\n", "utf8");
  await createTask(workspace, { id: "write-task", workspaceId: "workspace-1", goal: "Write docs", requestedOutputs: ["report"], riskLevel: "L0", state: "SCOPED" });
  const schemas = await SchemaRegistry.create(projectRoot);
  const registries = await loadRegistries(projectRoot, schemas);
  const plan = await createPlan(workspace, schemas, registries, { taskId: "write-task", roles: ["builder"] });
  const planApproval = await requestApproval(workspace, schemas, { taskId: "write-task", action: "plan-confirm", scope: [plan.planId], reason: "Confirm." });
  await decideApproval(workspace, schemas, planApproval.id, { status: "approved", decidedBy: "user", reason: "Confirmed." });
  await confirmPlan(workspace, plan.planId);
  await executePlan(workspace, plan.planId);
  await beginStep(workspace, schemas, plan.planId, "step-1");
  return { workspace, schemas, planId: plan.planId };
}

const writes: WriteIntent[] = [
  { target: "docs/guide.md", action: "modify", purpose: "Fix typos." },
  { target: "reports/summary.md", action: "create", purpose: "Generate summary." }
];

describe("auto-allow write path", () => {
  it("creates an already-CONFIRMED intent with autoAllowed and audits write-auto-allowed", async () => {
    const { workspace, schemas, planId } = await setup();
    const record = await requestWrites(workspace, schemas, planId, "step-1", writes, { autoAllow: true });
    expect(record.status).toBe("CONFIRMED");
    expect(record.autoAllowed).toBe(true);
    expect(record.confirmedTargets).toEqual(writes.map((write) => write.target));
    expect(record.approvalRef).toBeUndefined();
    const events = (await listLedgerEntries(workspace)).map((entry) => entry.event);
    expect(events).toContain("write-requested");
    expect(events).toContain("write-auto-allowed");
    expect(events).not.toContain("write-confirmed");
  });

  it("applies an auto-allowed write with evidence and supports rollback", async () => {
    const { workspace, schemas, planId } = await setup();
    const intent = await requestWrites(workspace, schemas, planId, "step-1", writes, { autoAllow: true });
    const lease = await issueLease(workspace, schemas, { taskId: "write-task", agentId: "builder-agent", role: "builder", capability: "repository-write", writeSet: writes.map((write) => write.target) });
    const result = await applyWrite(workspace, schemas, lease, intent, "reports/summary.md", "auto-generated\n");
    expect(result.target).toBe("reports/summary.md");
    expect(await readFile(path.join(workspace.root, "reports", "summary.md"), "utf8")).toBe("auto-generated\n");
    const events = (await listLedgerEntries(workspace)).map((entry) => entry.event);
    expect(events).toContain("write-auto-allowed");
    expect(events).toContain("write-applied");
    // Rollback restores the created-file state (skip without backup) and leaves the intent ROLLED_BACK.
    const applied = await getWriteIntent(workspace, intent.writeIntentId);
    await rollbackWrite(workspace, schemas, planId, "step-1", intent.writeIntentId, "User asked to revert.");
    expect((await getWriteIntent(workspace, intent.writeIntentId)).status).toBe("ROLLED_BACK");
    expect(events.concat((await listLedgerEntries(workspace)).map((entry) => entry.event))).toContain("write-rolled-back");
  });

  it("never auto-allows delete intents", async () => {
    const { workspace, schemas, planId } = await setup();
    await expect(requestWrites(workspace, schemas, planId, "step-1", [{ target: "docs/guide.md", action: "delete", purpose: "Remove." }], { autoAllow: true }))
      .rejects.toMatchObject({ code: "WRITE_AUTO_ALLOW_DELETE_DENIED" });
    const events = (await listLedgerEntries(workspace)).map((entry) => entry.event);
    expect(events).not.toContain("write-auto-allowed");
  });

  it("keeps the explicit-confirm path PENDING without autoAllowed", async () => {
    const { workspace, schemas, planId } = await setup();
    const record = await requestWrites(workspace, schemas, planId, "step-1", writes);
    expect(record.status).toBe("PENDING");
    expect(record.autoAllowed).toBeUndefined();
    const events = (await listLedgerEntries(workspace)).map((entry) => entry.event);
    expect(events).toContain("write-requested");
    expect(events).not.toContain("write-auto-allowed");
  });
});
