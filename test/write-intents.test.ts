import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SchemaRegistry } from "../src/contracts/schema-registry.js";
import { loadRegistries } from "../src/config/registry.js";
import { createTask } from "../src/storage/tasks.js";
import { initWorkspace } from "../src/storage/workspace.js";
import { createPlan, confirmPlan, executePlan, beginStep } from "../src/storage/plans.js";
import { cancelWriteIntentsForRun, confirmWrites, getWriteIntent, injectWriteConfirmationFaultForTesting, injectWriteRequestFaultForTesting, listWriteIntents, rejectWrites, requestWrites, type WriteIntentRecord } from "../src/storage/write-intents.js";
import { getApproval } from "../src/storage/approvals.js";
import { issueLease } from "../src/storage/leases.js";
import { listLedgerEntries } from "../src/storage/ledger.js";
import { evaluateLease } from "../src/policy/evaluate.js";
import type { WriteIntent } from "../src/contracts/types.js";
import { approvePlanConfirmation, approveTaskCapability, approveWriteIntent } from "./helpers/authority.js";

const roots: string[] = [];
const projectRoot = path.resolve(import.meta.dirname, "..");
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "stinky-write-"));
  roots.push(root);
  await mkdir(path.join(root, "docs"), { recursive: true });
  await writeFile(path.join(root, "docs", "guide.md"), "original\n", "utf8");
  const workspace = await initWorkspace(root);
  const task = { id: "write-task", workspaceId: "workspace-1", goal: "Write docs", requestedOutputs: ["report"], riskLevel: "L0" as const, state: "RUNNING" as const, scope: ["."], writeSet: ["."] };
  await createTask(workspace, task);
  const schemas = await SchemaRegistry.create(projectRoot);
  const capabilityApproval = await approveTaskCapability(workspace, schemas, task, "repository-write", ["docs/guide.md"]);
  const registries = await loadRegistries(projectRoot, schemas);
  const plan = await createPlan(workspace, schemas, registries, { taskId: "write-task", roles: ["builder"] });
  await approvePlanConfirmation(workspace, schemas, plan);
  await confirmPlan(workspace, plan.planId);
  await executePlan(workspace, plan.planId);
  await beginStep(workspace, schemas, plan.planId, "step-1");
  return { workspace, schemas, registries, planId: plan.planId, capabilityApproval };
}

const writes: WriteIntent[] = [{ target: "docs/guide.md", action: "modify", purpose: "Fix typos." }];

describe("controlled write authorization", () => {
  it("requests a pending write intent and audits it", async () => {
    const { workspace, schemas, planId, capabilityApproval } = await setup();
    const record = await requestWrites(workspace, schemas, planId, "step-1", writes);
    expect(record).toMatchObject({ planId, stepId: "step-1", status: "PENDING", writes });
    expect(record.writeIntentId).toMatch(/^write-/);
    expect(record).toMatchObject({ authorityApprovalRef: capabilityApproval.id, authorityConsumptionOwner: record.writeIntentId });
    await expect(getApproval(workspace, capabilityApproval.id)).resolves.toMatchObject({ consumedBy: record.writeIntentId });
    const events = (await listLedgerEntries(workspace)).map((entry) => entry.event);
    expect(events).toContain("write-requested");
  });

  for (const point of ["after-authority-consume", "after-intent"] as const) {
    it(`repairs WriteIntent request exactly once after ${point}`, async () => {
      const { workspace, schemas, planId, capabilityApproval } = await setup();
      injectWriteRequestFaultForTesting(workspace, point);
      await expect(requestWrites(workspace, schemas, planId, "step-1", writes))
        .rejects.toMatchObject({ code: "WRITE_REQUEST_TEST_FAULT" });

      const recovered = await requestWrites(workspace, schemas, planId, "step-1", writes);
      await expect(requestWrites(workspace, schemas, planId, "step-1", writes)).resolves.toEqual(recovered);
      await expect(getApproval(workspace, capabilityApproval.id)).resolves.toMatchObject({ consumedBy: recovered.writeIntentId });
      const events = (await listLedgerEntries(workspace)).filter((entry) =>
        entry.event === "write-requested" && entry.writeIntentRef === recovered.writeIntentId
      );
      expect(events).toHaveLength(1);
    });
  }

  it("does not amplify one capability Approval into multiple WriteIntents", async () => {
    const { workspace, schemas, planId, capabilityApproval } = await setup();
    const first = await requestWrites(workspace, schemas, planId, "step-1", writes);
    await expect(requestWrites(workspace, schemas, planId, "step-1", [{
      ...writes[0]!, purpose: "A different immutable write request."
    }])).rejects.toMatchObject({ code: "TASK_APPROVAL_REQUIRED" });
    await expect(getApproval(workspace, capabilityApproval.id)).resolves.toMatchObject({ consumedBy: first.writeIntentId });
    expect(await listWriteIntents(workspace)).toHaveLength(1);
  });

  it("rejects stored WriteIntents that fail schema or canonical ID binding", async () => {
    const { workspace, schemas, planId } = await setup();
    const record = await requestWrites(workspace, schemas, planId, "step-1", writes);
    const file = path.join(workspace.directory, "write-intents", `${record.writeIntentId}.json`);
    await writeFile(file, JSON.stringify({ ...record, unexpectedAuthority: true }), "utf8");
    await expect(getWriteIntent(workspace, record.writeIntentId)).rejects.toMatchObject({ code: "SCHEMA_INVALID" });
    await writeFile(file, JSON.stringify({ ...record, writeIntentId: "write-other" }), "utf8");
    await expect(getWriteIntent(workspace, record.writeIntentId)).rejects.toMatchObject({ code: "WRITE_INTENT_INVALID" });
  });

  it("bounds persisted WriteIntent authority references", async () => {
    const { workspace, schemas, planId } = await setup();
    const record = await requestWrites(workspace, schemas, planId, "step-1", writes);
    const file = path.join(workspace.directory, "write-intents", `${record.writeIntentId}.json`);
    await writeFile(file, JSON.stringify({
      ...record,
      authorityApprovalRefs: Array.from({ length: 65 }, (_, index) => `approval-${index}`)
    }), "utf8");
    await expect(getWriteIntent(workspace, record.writeIntentId)).rejects.toMatchObject({ code: "SCHEMA_INVALID" });
  });

  it("rejects unsafe write targets and invalid lists", async () => {
    const { workspace, schemas, planId } = await setup();
    const forbidden: Array<[WriteIntent[], string]> = [
      [[{ target: ".stinky-cobbler/workspace.json", action: "modify", purpose: "x" }], "WRITE_TARGET_FORBIDDEN"],
      [[{ target: ".env", action: "modify", purpose: "x" }], "WRITE_TARGET_FORBIDDEN"],
      [[{ target: "service-credentials.json", action: "modify", purpose: "x" }], "WRITE_TARGET_FORBIDDEN"],
      [[{ target: ".git/config", action: "modify", purpose: "x" }], "WRITE_TARGET_FORBIDDEN"],
      [[{ target: ".GiT/config", action: "modify", purpose: "x" }], "WRITE_TARGET_FORBIDDEN"],
      [[{ target: ".STINKY-COBBLER/workspace.json", action: "modify", purpose: "x" }], "WRITE_TARGET_FORBIDDEN"],
      [[{ target: "tool.exe", action: "modify", purpose: "x" }], "WRITE_TARGET_FORBIDDEN"],
      [[{ target: "../escape.md", action: "modify", purpose: "x" }], "WRITE_TARGET_INVALID"],
      [[{ target: "docs/a.md", action: "rename", purpose: "x" } as WriteIntent], "WRITE_INTENT_INVALID"],
      [[{ target: "docs/a.md", action: "modify", purpose: "x" }, { target: "docs/b.md", action: "modify", purpose: "y" }], "WRITE_LIST_INVALID"]
    ];
    for (const [list, code] of forbidden) {
      await expect(requestWrites(workspace, schemas, planId, "step-1", list)).rejects.toMatchObject({ code });
    }
  });

  it("confirms only with a matching approved write-confirm approval", async () => {
    const { workspace, schemas, planId } = await setup();
    const record = await requestWrites(workspace, schemas, planId, "step-1", writes);
    await expect(confirmWrites(workspace, planId, "step-1", record.writeIntentId)).rejects.toMatchObject({ code: "WRITE_CONFIRMATION_REQUIRED" });
    await approveWriteIntent(workspace, schemas, record);
    const confirmed = await confirmWrites(workspace, planId, "step-1", record.writeIntentId);
    expect(confirmed).toMatchObject({ status: "CONFIRMED", confirmedTargets: ["docs/guide.md"] });
    expect(confirmed.approvalRef).toBeTruthy();
    const events = (await listLedgerEntries(workspace)).map((entry) => entry.event);
    expect(events).toContain("write-confirmed");
  });

  for (const point of ["after-consume", "after-intent"] as const) {
    it(`repairs explicit Write confirmation exactly once after ${point}`, async () => {
      const { workspace, schemas, planId } = await setup();
      const record = await requestWrites(workspace, schemas, planId, "step-1", writes);
      const approval = await approveWriteIntent(workspace, schemas, record);
      injectWriteConfirmationFaultForTesting(workspace, point);
      await expect(confirmWrites(workspace, planId, "step-1", record.writeIntentId, schemas))
        .rejects.toMatchObject({ code: "WRITE_CONFIRMATION_TEST_FAULT" });

      await expect(confirmWrites(workspace, planId, "step-1", record.writeIntentId, schemas))
        .resolves.toMatchObject({ status: "CONFIRMED", approvalRef: approval.id });
      await expect(confirmWrites(workspace, planId, "step-1", record.writeIntentId, schemas))
        .resolves.toMatchObject({ status: "CONFIRMED", approvalRef: approval.id });
      await expect(getApproval(workspace, approval.id)).resolves.toMatchObject({ consumedBy: record.writeIntentId });
      const events = (await listLedgerEntries(workspace)).filter((entry) =>
        entry.event === "write-confirmed" && entry.writeIntentRef === record.writeIntentId
      );
      expect(events).toHaveLength(1);
      expect(events[0]?.approvalRef).toBe(approval.id);
    });
  }

  it("rejects confirmations whose scope includes unrequested targets", async () => {
    const { workspace, schemas, planId } = await setup();
    const record = await requestWrites(workspace, schemas, planId, "step-1", writes);
    await approveWriteIntent(workspace, schemas, record, { scope: ["unrequested.md"] });
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

  it("cancels only pending and confirmed intents for one run, idempotently", async () => {
    const { workspace } = await setup();
    await mkdir(path.join(workspace.directory, "write-intents"), { recursive: true });
    const capabilityApprovalRef = "approval-write-fixture";
    const base: Omit<WriteIntentRecord, "writeIntentId" | "authorityConsumptionOwner" | "status"> = {
      version: 1,
      planId: "-",
      stepId: "-",
      taskId: "write-task",
      runRef: "run-a",
      subtaskRef: "subtask-a",
      writes: [{ target: "docs/a.md", action: "modify", purpose: "x" }],
      intentHash: "sha256:" + "0".repeat(64),
      expectedPreimageHash: "sha256:" + "1".repeat(64),
      authorityApprovalRefs: [capabilityApprovalRef],
      authorityApprovalRef: capabilityApprovalRef,
      parentGrantRef: "task-authority:write-task",
      taskAuthorityHash: "sha256:" + "2".repeat(64),
      policyVersion: "task-authority-v1",
      hostSessionId: "test",
      createdAt: "2026-01-01T00:00:00.000Z"
    };
    const records: WriteIntentRecord[] = [
      { ...base, writeIntentId: "write-pending", authorityConsumptionOwner: "write-pending", status: "PENDING" },
      { ...base, writeIntentId: "write-confirmed", authorityConsumptionOwner: "write-confirmed", status: "CONFIRMED", confirmedTargets: ["docs/a.md"], confirmedAt: "2026-01-01T00:01:00.000Z", autoAllowed: true },
      { ...base, writeIntentId: "write-applied", authorityConsumptionOwner: "write-applied", status: "APPLIED", confirmedTargets: ["docs/a.md"], confirmedAt: "2026-01-01T00:01:00.000Z", autoAllowed: true, appliedTarget: "docs/a.md", preImageMissing: false, postImageHash: "sha256:" + "3".repeat(64) },
      { ...base, writeIntentId: "write-other-run", authorityConsumptionOwner: "write-other-run", runRef: "run-b", status: "PENDING" }
    ];
    for (const record of records) await writeFile(path.join(workspace.directory, "write-intents", `${record.writeIntentId}.json`), JSON.stringify(record), "utf8");

    const first = await cancelWriteIntentsForRun(workspace, "run-a", "Run cancelled.");
    expect(first.map((record) => record.writeIntentId).sort()).toEqual(["write-confirmed", "write-pending"]);
    expect(first.every((record) => record.status === "REJECTED" && record.cancellationReason === "Run cancelled." && record.cancelledAt !== undefined)).toBe(true);
    expect((await getWriteIntent(workspace, "write-applied")).status).toBe("APPLIED");
    expect((await getWriteIntent(workspace, "write-other-run")).status).toBe("PENDING");
    await expect(cancelWriteIntentsForRun(workspace, "run-a", "Again.")).resolves.toEqual([]);
  });
});
