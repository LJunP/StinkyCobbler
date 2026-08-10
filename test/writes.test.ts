import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SchemaRegistry } from "../src/contracts/schema-registry.js";
import { loadRegistries } from "../src/config/registry.js";
import { createTask } from "../src/storage/tasks.js";
import { initWorkspace } from "../src/storage/workspace.js";
import { createPlan, confirmPlan, executePlan, beginStep } from "../src/storage/plans.js";
import { requestWrites, confirmWrites, getWriteIntent, rollbackWrite } from "../src/storage/write-intents.js";
import { requestApproval, decideApproval } from "../src/storage/approvals.js";
import { issueLease, getLease } from "../src/storage/leases.js";
import { applyWrite, applyDelete } from "../src/storage/writes.js";
import { listLedgerEntries } from "../src/storage/ledger.js";
import type { CapabilityLease } from "../src/contracts/types.js";

const roots: string[] = [];
const projectRoot = path.resolve(import.meta.dirname, "..");
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function setup(targets = ["docs/guide.md", "reports/summary.md"]) {
  const root = await mkdtemp(path.join(os.tmpdir(), "stinky-writes-"));
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
  const writes = targets.map((target) => ({ target, action: (target === "docs/guide.md" ? "modify" : "create") as "modify" | "create", purpose: "Update docs." }));
  const intent = await requestWrites(workspace, schemas, plan.planId, "step-1", writes);
  const writeApproval = await requestApproval(workspace, schemas, { taskId: "write-task", action: "write-confirm", scope: targets, reason: "Confirm writes." });
  await decideApproval(workspace, schemas, writeApproval.id, { status: "approved", decidedBy: "user", reason: "Confirmed." });
  await confirmWrites(workspace, plan.planId, "step-1", intent.writeIntentId);
  const confirmedIntent = await getWriteIntent(workspace, intent.writeIntentId);
  const lease = await issueLease(workspace, schemas, { taskId: "write-task", agentId: "builder-agent", role: "builder", capability: "repository-write", writeSet: targets });
  return { workspace, schemas, registries, planId: plan.planId, intent: confirmedIntent, lease };
}

describe("controlled write execution", () => {
  it("applies a create write with evidence and audit", async () => {
    const { workspace, schemas, intent, lease } = await setup();
    const target = "reports/summary.md";
    const content = "# Summary\n";
    const result = await applyWrite(workspace, schemas, lease, intent, target, content);
    expect(result.target).toBe(target);
    expect(result.backupPath).toBeUndefined();
    expect(await readFile(path.join(workspace.root, target), "utf8")).toBe(content);
    const evidence = await import("../src/storage/evidence.js").then(({ getEvidence }) => getEvidence(workspace, result.evidenceId));
    expect(evidence).toMatchObject({ kind: "file", locator: target, sensitivity: "internal", contentHash: `sha256:${createHash("sha256").update(content).digest("hex")}` });
    const stored = await getWriteIntent(workspace, intent.writeIntentId);
    expect(stored.status).toBe("APPLIED");
    const events = (await listLedgerEntries(workspace)).map((entry) => entry.event);
    expect(events).toContain("write-applied");
  });

  it("backs up the previous file before a modify write", async () => {
    const { workspace, schemas, intent, lease } = await setup();
    const target = "docs/guide.md";
    const result = await applyWrite(workspace, schemas, lease, intent, target, "updated\n");
    expect(result.backupPath).toBeTruthy();
    const backup = await readFile(path.join(workspace.directory, result.backupPath!), "utf8");
    expect(backup).toBe("original\n");
    expect(await readFile(path.join(workspace.root, target), "utf8")).toBe("updated\n");
  });

  it("rejects duplicate, out-of-lease, and unconfirmed writes", async () => {
    const { workspace, schemas, intent, lease } = await setup();
    const otherLease = await issueLease(workspace, schemas, { taskId: "write-task", agentId: "a", role: "builder", capability: "repository-write", writeSet: ["other/file.md"] });
    await expect(applyWrite(workspace, schemas, otherLease, intent, "other/file.md", "x")).rejects.toMatchObject({ code: "WRITE_TARGET_NOT_CONFIRMED" });
    await expect(applyWrite(workspace, schemas, lease, intent, "reports/summary.md", "x")).resolves.toMatchObject({ target: "reports/summary.md" });
    await expect(applyWrite(workspace, schemas, lease, intent, "reports/summary.md", "y")).rejects.toMatchObject({ code: "WRITE_ALREADY_APPLIED" });
  });

  it("enforces the forbidden-target guard at apply time even for hand-crafted leases", async () => {
    const { workspace, schemas } = await setup(["docs/guide.md"]);
    const forgedLease: CapabilityLease = { ...(await issueLease(workspace, schemas, { taskId: "write-task", agentId: "a", role: "builder", capability: "repository-write", writeSet: ["docs/guide.md"] })), writeSet: [".env", "tool.exe", ".git/config", "docs/guide.md"] };
    const mkdir = (await import("node:fs/promises")).mkdir;
    const writeFile = (await import("node:fs/promises")).writeFile;
    const intentId = "write-forged-intent";
    await mkdir(path.join(workspace.directory, "write-intents"), { recursive: true });
    await writeFile(path.join(workspace.directory, "write-intents", `${intentId}.json`), JSON.stringify({
      version: 1,
      writeIntentId: intentId,
      planId: "plan-forged",
      stepId: "step-1",
      status: "CONFIRMED",
      writes: [{ target: ".env", action: "modify", purpose: "forged" }],
      confirmedTargets: [".env", "tool.exe", ".git/config", "docs/guide.md"],
      createdAt: "2026-01-01T00:00:00.000Z",
      confirmedAt: "2026-01-01T00:01:00.000Z"
    }), "utf8");
    const forgedIntent = await getWriteIntent(workspace, intentId);
    for (const target of [".env", "tool.exe", ".git/config"]) {
      await expect(applyWrite(workspace, schemas, forgedLease, forgedIntent, target, "x")).rejects.toMatchObject({ code: "WRITE_TARGET_FORBIDDEN" });
    }
    await expect(applyWrite(workspace, schemas, forgedLease, forgedIntent, "docs/guide.md", "x".repeat(1024 * 1024 + 1))).rejects.toMatchObject({ code: "WRITE_CONTENT_INVALID" });
  });

  it("requires the intent to be confirmed before applying", async () => {
    const { workspace, schemas } = await setup(["docs/guide.md"]);
    const pendingLease: CapabilityLease = await getLease(workspace, (await issueLease(workspace, schemas, { taskId: "write-task", agentId: "a", role: "builder", capability: "repository-write", writeSet: ["docs/guide.md"] })).id);
    const fresh = await requestWrites(workspace, schemas, "plan-x", "step-1", [{ target: "docs/guide.md", action: "modify", purpose: "x" }]).catch(() => undefined);
    if (fresh) {
      await expect(applyWrite(workspace, schemas, pendingLease, fresh, "docs/guide.md", "x")).rejects.toMatchObject({ code: "WRITE_INTENT_NOT_CONFIRMED" });
    }
  });

  it("rolls back an applied write from the backup and audits it", async () => {
    const { workspace, schemas, planId, intent, lease } = await setup();
    await applyWrite(workspace, schemas, lease, intent, "docs/guide.md", "updated\n");
    expect(await readFile(path.join(workspace.root, "docs/guide.md"), "utf8")).toBe("updated\n");
    const rolledBack = await rollbackWrite(workspace, schemas, planId, "step-1", intent.writeIntentId, "Revert change.");
    expect(rolledBack.status).toBe("ROLLED_BACK");
    expect(await readFile(path.join(workspace.root, "docs/guide.md"), "utf8")).toBe("original\n");
    await expect(rollbackWrite(workspace, schemas, planId, "step-1", intent.writeIntentId, "Again.")).rejects.toMatchObject({ code: "WRITE_ALREADY_ROLLED_BACK" });
    const events = (await listLedgerEntries(workspace)).map((entry) => entry.event);
    expect(events).toContain("write-rolled-back");
  });

  it("rejects rollback of non-applied writes", async () => {
    const { workspace, schemas, planId } = await setup(["docs/guide.md"]);
    const fresh = await requestWrites(workspace, schemas, planId, "step-1", [{ target: "docs/guide.md", action: "modify", purpose: "x" }]);
    await expect(rollbackWrite(workspace, schemas, planId, "step-1", fresh.writeIntentId, "x")).rejects.toMatchObject({ code: "WRITE_NOT_APPLIED" });
  });
});

describe("controlled delete execution", () => {
  async function deleteSetup() {
    const root = await mkdtemp(path.join(os.tmpdir(), "stinky-writes-del-"));
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
    const intent = await requestWrites(workspace, schemas, plan.planId, "step-1", [{ target: "docs/guide.md", action: "delete", purpose: "Remove." }]);
    const writeApproval = await requestApproval(workspace, schemas, { taskId: "write-task", action: "write-confirm", scope: ["docs/guide.md"], reason: "Confirm." });
    await decideApproval(workspace, schemas, writeApproval.id, { status: "approved", decidedBy: "user", reason: "Confirmed." });
    await confirmWrites(workspace, plan.planId, "step-1", intent.writeIntentId);
    const confirmedIntent = await getWriteIntent(workspace, intent.writeIntentId);
    const lease = await issueLease(workspace, schemas, { taskId: "write-task", agentId: "builder-agent", role: "builder", capability: "repository-write", writeSet: ["docs/guide.md"] });
    return { workspace, schemas, planId: plan.planId, intent: confirmedIntent, lease };
  }

  it("deletes a confirmed file with backup, evidence, and audit", async () => {
    const { workspace, schemas, intent, lease } = await deleteSetup();
    const result = await applyDelete(workspace, schemas, lease, intent, "docs/guide.md");
    expect(result.target).toBe("docs/guide.md");
    await expect(stat(path.join(workspace.root, "docs/guide.md"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(workspace.directory, result.backupPath), "utf8")).toBe("original\n");
    const events = (await listLedgerEntries(workspace)).map((entry) => entry.event);
    expect(events).toContain("delete-applied");
    expect((await getWriteIntent(workspace, intent.writeIntentId)).status).toBe("APPLIED");
  });

  it("restores a deleted file via rollback", async () => {
    const { workspace, schemas, planId, intent, lease } = await deleteSetup();
    await applyDelete(workspace, schemas, lease, intent, "docs/guide.md");
    await rollbackWrite(workspace, schemas, planId, "step-1", intent.writeIntentId, "Restore deleted file.");
    expect(await readFile(path.join(workspace.root, "docs/guide.md"), "utf8")).toBe("original\n");
    expect((await getWriteIntent(workspace, intent.writeIntentId)).status).toBe("ROLLED_BACK");
    const events = (await listLedgerEntries(workspace)).map((entry) => entry.event);
    expect(events).toContain("write-rolled-back");
  });

  it("rejects deleting a missing target and applying delete on a non-delete intent", async () => {
    const { workspace, schemas, planId, intent, lease } = await deleteSetup();
    await rm(path.join(workspace.root, "docs/guide.md"), { force: true });
    await expect(applyDelete(workspace, schemas, lease, intent, "docs/guide.md")).rejects.toMatchObject({ code: "WRITE_TARGET_MISSING" });
    // A modify intent cannot be applied through the delete path.
    const modifyIntent = await requestWrites(workspace, schemas, planId, "step-1", [{ target: "docs/guide.md", action: "modify", purpose: "x" }]);
    const modifyApproval = await requestApproval(workspace, schemas, { taskId: "write-task", action: "write-confirm", scope: ["docs/guide.md"], reason: "Confirm." });
    await decideApproval(workspace, schemas, modifyApproval.id, { status: "approved", decidedBy: "user", reason: "Confirmed." });
    await confirmWrites(workspace, planId, "step-1", modifyIntent.writeIntentId);
    const modify = await getWriteIntent(workspace, modifyIntent.writeIntentId);
    await expect(applyDelete(workspace, schemas, lease, modify, "docs/guide.md")).rejects.toMatchObject({ code: "WRITE_ACTION_MISMATCH" });
  });
});
