import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SchemaRegistry } from "../src/contracts/schema-registry.js";
import { loadRegistries } from "../src/config/registry.js";
import { createTask } from "../src/storage/tasks.js";
import { initWorkspace } from "../src/storage/workspace.js";
import { createPlan, confirmPlan, executePlan, beginStep } from "../src/storage/plans.js";
import { requestWrites, confirmWrites, rejectWrites } from "../src/storage/write-intents.js";
import { requestApproval, decideApproval } from "../src/storage/approvals.js";
import { issueLease } from "../src/storage/leases.js";
import { listLedgerEntries } from "../src/storage/ledger.js";
import { evaluateLease } from "../src/policy/evaluate.js";
import type { WriteIntent } from "../src/contracts/types.js";

const roots: string[] = [];
const projectRoot = path.resolve(import.meta.dirname, "..");
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "stinky-write-"));
  roots.push(root);
  const workspace = await initWorkspace(root);
  await createTask(workspace, { id: "write-task", workspaceId: "workspace-1", goal: "Write docs", requestedOutputs: ["report"], riskLevel: "L0", state: "SCOPED" });
  const schemas = await SchemaRegistry.create(projectRoot);
  const registries = await loadRegistries(projectRoot, schemas);
  const plan = await createPlan(workspace, schemas, registries, { taskId: "write-task", roles: ["builder"] });
  const requested = await requestApproval(workspace, schemas, { taskId: "write-task", action: "plan-confirm", scope: [plan.planId], reason: "Confirm." });
  await decideApproval(workspace, schemas, requested.id, { status: "approved", decidedBy: "user", reason: "Confirmed." });
  await confirmPlan(workspace, plan.planId);
  await executePlan(workspace, plan.planId);
  await beginStep(workspace, schemas, plan.planId, "step-1");
  return { workspace, schemas, registries, planId: plan.planId };
}

async function approveWrites(workspace: any, schemas: any, scope: string[]): Promise<string> {
  const requested = await requestApproval(workspace, schemas, { taskId: "write-task", action: "write-confirm", scope, reason: "Confirm writes." });
  await decideApproval(workspace, schemas, requested.id, { status: "approved", decidedBy: "user", reason: "Confirmed." });
  return requested.id;
}

const writes: WriteIntent[] = [
  { target: "docs/guide.md", action: "modify", purpose: "Fix typos." },
  { target: "reports/summary.md", action: "create", purpose: "Generate summary." }
];

describe("controlled write authorization", () => {
  it("requests a pending write intent and audits it", async () => {
    const { workspace, schemas, planId } = await setup();
    const record = await requestWrites(workspace, schemas, planId, "step-1", writes);
    expect(record).toMatchObject({ planId, stepId: "step-1", status: "PENDING", writes });
    expect(record.writeIntentId).toMatch(/^write-/);
    const events = (await listLedgerEntries(workspace)).map((entry) => entry.event);
    expect(events).toContain("write-requested");
  });

  it("rejects unsafe write targets and invalid lists", async () => {
    const { workspace, schemas, planId } = await setup();
    const forbidden: Array<[WriteIntent[], string]> = [
      [[{ target: ".stinky-cobbler/workspace.json", action: "modify", purpose: "x" }], "WRITE_TARGET_FORBIDDEN"],
      [[{ target: ".env", action: "modify", purpose: "x" }], "WRITE_TARGET_FORBIDDEN"],
      [[{ target: ".git/config", action: "modify", purpose: "x" }], "WRITE_TARGET_FORBIDDEN"],
      [[{ target: "tool.exe", action: "modify", purpose: "x" }], "WRITE_TARGET_FORBIDDEN"],
      [[{ target: "../escape.md", action: "modify", purpose: "x" }], "WRITE_TARGET_INVALID"],
      [[{ target: "docs/a.md", action: "rename", purpose: "x" } as WriteIntent], "WRITE_INTENT_INVALID"],
      [[{ target: "docs/a.md", action: "modify", purpose: "x" }, { target: "docs/a.md", action: "modify", purpose: "y" }], "WRITE_TARGET_DUPLICATE"]
    ];
    for (const [list, code] of forbidden) {
      await expect(requestWrites(workspace, schemas, planId, "step-1", list)).rejects.toMatchObject({ code });
    }
  });

  it("confirms only with a matching approved write-confirm approval, supporting partial scope", async () => {
    const { workspace, schemas, planId } = await setup();
    const record = await requestWrites(workspace, schemas, planId, "step-1", writes);
    await expect(confirmWrites(workspace, planId, "step-1", record.writeIntentId)).rejects.toMatchObject({ code: "WRITE_CONFIRMATION_REQUIRED" });
    await approveWrites(workspace, schemas, ["docs/guide.md"]);
    const confirmed = await confirmWrites(workspace, planId, "step-1", record.writeIntentId);
    expect(confirmed).toMatchObject({ status: "CONFIRMED", confirmedTargets: ["docs/guide.md"] });
    expect(confirmed.approvalRef).toBeTruthy();
    const events = (await listLedgerEntries(workspace)).map((entry) => entry.event);
    expect(events).toContain("write-confirmed");
  });

  it("rejects confirmations whose scope includes unrequested targets", async () => {
    const { workspace, schemas, planId } = await setup();
    const record = await requestWrites(workspace, schemas, planId, "step-1", writes);
    await approveWrites(workspace, schemas, ["docs/guide.md", "unrequested.md"]);
    await expect(confirmWrites(workspace, planId, "step-1", record.writeIntentId)).rejects.toMatchObject({ code: "WRITE_CONFIRMATION_REQUIRED" });
  });

  it("rejects pending write requests idempotently", async () => {
    const { workspace, schemas, planId } = await setup();
    const record = await requestWrites(workspace, schemas, planId, "step-1", writes);
    const rejected = await rejectWrites(workspace, planId, "step-1", record.writeIntentId, "Not needed.");
    expect(rejected.status).toBe("REJECTED");
    await expect(rejectWrites(workspace, planId, "step-1", record.writeIntentId, "Again.")).resolves.toEqual(rejected);
    const events = (await listLedgerEntries(workspace)).map((entry) => entry.event);
    expect(events).toContain("write-rejected");
  });

  it("issues L1 repository-write leases with whitelisted writeSet and rejects unsafe ones", async () => {
    const { workspace, schemas } = await setup();
    const lease = await issueLease(workspace, schemas, { taskId: "write-task", agentId: "agent-1", role: "builder", capability: "repository-write", writeSet: ["docs/guide.md"] });
    expect(lease).toMatchObject({ level: "L1", capability: "repository-write", writeSet: ["docs/guide.md"] });
    expect(evaluateLease(lease, { taskId: "write-task", role: "builder", workspace: workspace.root, capability: "repository-write" }).allowed).toBe(true);
    await expect(issueLease(workspace, schemas, { taskId: "write-task", agentId: "agent-1", role: "builder", capability: "repository-write" })).rejects.toMatchObject({ code: "LEASE_WRITE_SET_REQUIRED" });
    await expect(issueLease(workspace, schemas, { taskId: "write-task", agentId: "agent-1", role: "builder", capability: "repository-write", writeSet: [".env"] })).rejects.toMatchObject({ code: "WRITE_TARGET_FORBIDDEN" });
  });

  it("keeps non-write capabilities on L0 with empty writeSet", async () => {
    const { workspace, schemas } = await setup();
    const lease = await issueLease(workspace, schemas, { taskId: "write-task", agentId: "agent-1", role: "scout", capability: "repository-read" });
    expect(lease).toMatchObject({ level: "L0", writeSet: [] });
  });
});
