import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SchemaRegistry } from "../src/contracts/schema-registry.js";
import { loadRegistries } from "../src/config/registry.js";
import { createTask } from "../src/storage/tasks.js";
import { initWorkspace } from "../src/storage/workspace.js";
import { createPlan, confirmPlan, executePlan, beginStep, completeStep, failStep, finishPlan, failPlan, getPlan } from "../src/storage/plans.js";
import { requestWrites, rejectWrites, listWriteIntents } from "../src/storage/write-intents.js";
import { requestApproval, decideApproval } from "../src/storage/approvals.js";
import { listLeases } from "../src/storage/leases.js";
import { listLedgerEntries } from "../src/storage/ledger.js";
import { evaluateLease } from "../src/policy/evaluate.js";
import type { TaskCharter } from "../src/contracts/types.js";

const roots: string[] = [];
const projectRoot = path.resolve(import.meta.dirname, "..");
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function setup(task: TaskCharter = { id: "exec-task", workspaceId: "workspace-1", goal: "Build a feature", requestedOutputs: ["code-change", "report"], riskLevel: "L0", state: "SCOPED", packs: ["software-engineering"] }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "stinky-plan-exec-"));
  roots.push(root);
  const workspace = await initWorkspace(root);
  await createTask(workspace, task);
  const schemas = await SchemaRegistry.create(projectRoot);
  const registries = await loadRegistries(projectRoot, schemas);
  return { workspace, schemas, registries };
}

async function approvedPlan(workspace: any, schemas: any, registries: any, roles?: string[]): Promise<string> {
  const plan = await createPlan(workspace, schemas, registries, { taskId: "exec-task", ...(roles === undefined ? {} : { roles }) });
  const requested = await requestApproval(workspace, schemas, { taskId: "exec-task", action: "plan-confirm", scope: [plan.planId], reason: "Confirm." });
  await decideApproval(workspace, schemas, requested.id, { status: "approved", decidedBy: "user", reason: "Confirmed." });
  await confirmPlan(workspace, plan.planId);
  return plan.planId;
}

describe("plan scheduling loop", () => {
  it("executes only APPROVED plans", async () => {
    const { workspace, schemas, registries } = await setup();
    const plan = await createPlan(workspace, schemas, registries, { taskId: "exec-task", roles: ["scout"] });
    await expect(executePlan(workspace, plan.planId)).rejects.toMatchObject({ code: "PLAN_STATE_CONFLICT" });
    const planId = await approvedPlan(workspace, schemas, registries, ["scout"]);
    const executing = await executePlan(workspace, planId);
    expect(executing.status).toBe("EXECUTING");
    const events = (await listLedgerEntries(workspace)).map((entry) => entry.event);
    expect(events).toContain("plan-executing");
  });

  it("begins a step by issuing matching controlled leases", async () => {
    const { workspace, schemas, registries } = await setup();
    const planId = await approvedPlan(workspace, schemas, registries, ["reviewer"]);
    await executePlan(workspace, planId);
    const begun = await beginStep(workspace, schemas, planId, "step-1", "step-agent");
    expect(begun.step).toMatchObject({ stepId: "step-1", status: "RUNNING" });
    expect(begun.leases).toHaveLength(2);
    const capabilities = begun.leases.map((lease) => lease.capability).sort();
    expect(capabilities).toEqual(["git-read", "repository-read"]);
    for (const lease of begun.leases) {
      expect(lease).toMatchObject({ taskId: "exec-task", agentId: "step-agent", role: "reviewer", readScope: ["."] });
      const decision = evaluateLease(lease, { taskId: "exec-task", role: "reviewer", workspace: workspace.root, capability: lease.capability });
      expect(decision.allowed).toBe(true);
    }
    await expect(listLeases(workspace)).resolves.toHaveLength(2);
  });

  it("returns no leases for steps without tools and rejects unsupported tools", async () => {
    const { workspace, schemas, registries } = await setup();
    const planId = await approvedPlan(workspace, schemas, registries, ["conductor"]);
    await executePlan(workspace, planId);
    const begun = await beginStep(workspace, schemas, planId, "step-1");
    expect(begun.leases).toEqual([]);
    expect(begun.step.status).toBe("RUNNING");
  });

  it("issues a lease for a previously unmapped role via the tools config", async () => {
    const { workspace, schemas, registries } = await setup();
    const planId = await approvedPlan(workspace, schemas, registries, ["planner"]);
    const plan = await getPlan(workspace, planId);
    expect(plan.steps[0].tools).toEqual(["repository-read"]);
    await executePlan(workspace, planId);
    const begun = await beginStep(workspace, schemas, planId, "step-1");
    expect(begun.leases).toHaveLength(1);
    expect(begun.leases[0]).toMatchObject({ capability: "repository-read", role: "planner" });
  });

  it("enforces step state transitions and plan state guards", async () => {
    const { workspace, schemas, registries } = await setup();
    const planId = await approvedPlan(workspace, schemas, registries, ["scout"]);
    await expect(beginStep(workspace, schemas, planId, "step-1")).rejects.toMatchObject({ code: "PLAN_STATE_CONFLICT" });
    await executePlan(workspace, planId);
    await beginStep(workspace, schemas, planId, "step-1");
    await expect(beginStep(workspace, schemas, planId, "step-1")).rejects.toMatchObject({ code: "PLAN_STEP_STATE_CONFLICT" });
    await expect(completeStep(workspace, planId, "step-missing")).rejects.toMatchObject({ code: "PLAN_STEP_NOT_FOUND" });
  });

  it("completes steps and finishes a plan only when all steps are done", async () => {
    const { workspace, schemas, registries } = await setup();
    const planId = await approvedPlan(workspace, schemas, registries, ["scout", "verifier"]);
    await executePlan(workspace, planId);
    await expect(finishPlan(workspace, planId)).rejects.toMatchObject({ code: "PLAN_STEPS_INCOMPLETE" });
    for (const stepId of ["step-1", "step-2"]) {
      await beginStep(workspace, schemas, planId, stepId);
      await completeStep(workspace, planId, stepId);
    }
    const finished = await finishPlan(workspace, planId);
    expect(finished.status).toBe("COMPLETED");
    const events = (await listLedgerEntries(workspace)).map((entry) => entry.event);
    expect(events).toEqual(expect.arrayContaining(["plan-executing", "plan-step-completed", "plan-step-completed", "plan-completed"]));
  });

  it("fails steps and plans with audit events", async () => {
    const { workspace, schemas, registries } = await setup();
    const planId = await approvedPlan(workspace, schemas, registries, ["scout"]);
    await executePlan(workspace, planId);
    await beginStep(workspace, schemas, planId, "step-1");
    await failStep(workspace, planId, "step-1", "Tool failed.");
    const failed = await failPlan(workspace, planId, "Step could not recover.");
    expect(failed.status).toBe("FAILED");
    const events = (await listLedgerEntries(workspace)).map((entry) => entry.event);
    expect(events).toEqual(expect.arrayContaining(["plan-step-failed", "plan-failed"]));
  });

  it("records reported result references on step completion and reads them back", async () => {
    const { workspace, schemas, registries } = await setup();
    const planId = await approvedPlan(workspace, schemas, registries, ["scout"]);
    await executePlan(workspace, planId);
    await beginStep(workspace, schemas, planId, "step-1");
    const completed = await completeStep(workspace, planId, "step-1", ["receipt-mcp-1", "evidence-run-1"]);
    expect(completed.steps[0]).toMatchObject({ status: "COMPLETED", evidenceRefs: ["receipt-mcp-1", "evidence-run-1"] });
    const stored = await getPlan(workspace, planId);
    expect(stored.steps[0].evidenceRefs).toEqual(["receipt-mcp-1", "evidence-run-1"]);
  });

  it("leaves evidenceRefs undefined when none are reported and rejects invalid references", async () => {
    const { workspace, schemas, registries } = await setup();
    const planId = await approvedPlan(workspace, schemas, registries, ["scout"]);
    await executePlan(workspace, planId);
    await beginStep(workspace, schemas, planId, "step-1");
    const completed = await completeStep(workspace, planId, "step-1");
    expect(completed.steps[0].evidenceRefs).toBeUndefined();
  });

  it("rejects invalid step result references", async () => {
    const { workspace, schemas, registries } = await setup();
    const planId = await approvedPlan(workspace, schemas, registries, ["scout"]);
    await executePlan(workspace, planId);
    await beginStep(workspace, schemas, planId, "step-1");
    await expect(completeStep(workspace, planId, "step-1", [""])).rejects.toMatchObject({ code: "PLAN_STEP_EVIDENCE_INVALID" });
    await expect(completeStep(workspace, planId, "step-1", ["a", "a"])).rejects.toMatchObject({ code: "PLAN_STEP_EVIDENCE_INVALID" });
    await expect(completeStep(workspace, planId, "step-1", ["x".repeat(257)])).rejects.toMatchObject({ code: "PLAN_STEP_EVIDENCE_INVALID" });
    await expect(completeStep(workspace, planId, "step-1", Array.from({ length: 21 }, (_, index) => `ref-${index}`))).rejects.toMatchObject({ code: "PLAN_STEP_EVIDENCE_INVALID" });
  });

  it("blocks step completion while writes are pending or confirmed", async () => {
    const { workspace, schemas, registries } = await setup();
    const planId = await approvedPlan(workspace, schemas, registries, ["builder"]);
    await executePlan(workspace, planId);
    await beginStep(workspace, schemas, planId, "step-1");
    await requestWrites(workspace, schemas, planId, "step-1", [{ target: "docs/note.md", action: "create", purpose: "Draft." }]);
    await expect(completeStep(workspace, planId, "step-1")).rejects.toMatchObject({ code: "PLAN_STEP_PENDING_WRITES" });
    const writes = await listWriteIntents(workspace, planId);
    await rejectWrites(workspace, planId, "step-1", writes[0].writeIntentId, "Not needed.");
    await expect(completeStep(workspace, planId, "step-1")).resolves.toMatchObject({ status: "EXECUTING" });
  });
});
