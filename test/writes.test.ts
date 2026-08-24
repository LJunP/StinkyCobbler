import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SchemaRegistry } from "../src/contracts/schema-registry.js";
import { loadRegistries } from "../src/config/registry.js";
import { createTask, getTask } from "../src/storage/tasks.js";
import { initWorkspace, writeWorkspaceJson } from "../src/storage/workspace.js";
import { createPlan, confirmPlan, executePlan, beginStep, getPlan } from "../src/storage/plans.js";
import { requestWrites, confirmWrites, getWriteIntent, listWriteIntents, reconcileRollbackWrite, rollbackWrite } from "../src/storage/write-intents.js";
import { issueLease, getLease } from "../src/storage/leases.js";
import { applyWrite, applyDelete, reconcileApplyWrite } from "../src/storage/writes.js";
import { listLedgerEntries } from "../src/storage/ledger.js";
import type { CapabilityLease } from "../src/contracts/types.js";
import { approvePlanConfirmation, approveTaskCapability, approveWriteIntent } from "./helpers/authority.js";
import { decideApproval } from "../src/storage/approvals.js";

const roots: string[] = [];
const projectRoot = path.resolve(import.meta.dirname, "..");
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function setup(targets = ["docs/guide.md"], initialGuideContent: string | Buffer = "original\n") {
  const root = await mkdtemp(path.join(os.tmpdir(), "stinky-writes-"));
  roots.push(root);
  const workspace = await initWorkspace(root);
  await mkdir(path.join(root, "docs"), { recursive: true });
  await writeFile(path.join(root, "docs", "guide.md"), initialGuideContent);
  const task = { id: "write-task", workspaceId: "workspace-1", goal: "Write docs", requestedOutputs: ["report"], riskLevel: "L0" as const, state: "RUNNING" as const, scope: ["."], writeSet: targets };
  await createTask(workspace, task);
  const schemas = await SchemaRegistry.create(projectRoot);
  await approveTaskCapability(workspace, schemas, task, "repository-write", targets);
  await approveTaskCapability(workspace, schemas, task, "repository-write", targets);
  const registries = await loadRegistries(projectRoot, schemas);
  const plan = await createPlan(workspace, schemas, registries, { taskId: "write-task", roles: ["builder"] });
  await approvePlanConfirmation(workspace, schemas, plan);
  await confirmPlan(workspace, plan.planId);
  await executePlan(workspace, plan.planId);
  await beginStep(workspace, schemas, plan.planId, "step-1");
  const writes = targets.map((target) => ({ target, action: (target === "docs/guide.md" ? "modify" : "create") as "modify" | "create", purpose: "Update docs." }));
  const intent = await requestWrites(workspace, schemas, plan.planId, "step-1", writes);
  await approveWriteIntent(workspace, schemas, intent);
  await confirmWrites(workspace, plan.planId, "step-1", intent.writeIntentId, schemas);
  const confirmedIntent = await getWriteIntent(workspace, intent.writeIntentId);
  const lease = await issueLease(workspace, schemas, { taskId: "write-task", agentId: "builder-agent", role: "builder", capability: "repository-write", writeSet: targets });
  return { workspace, schemas, registries, planId: plan.planId, intent: confirmedIntent, lease };
}

async function addSensitivePath(root: string, target: string): Promise<void> {
  const directory = path.join(root, ".stinky-cobbler", "policies");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "orchestration.yaml"), `version: 1\nsensitiveExtraPaths:\n  - ${target}\n`, "utf8");
}

async function approveFreshWriteCapability(
  workspace: Awaited<ReturnType<typeof initWorkspace>>,
  schemas: SchemaRegistry,
  scope: string[]
): Promise<void> {
  await approveTaskCapability(workspace, schemas, await getTask(workspace, "write-task"), "repository-write", scope);
}

describe("controlled write execution", () => {
  async function revokePlanConfirmation(value: Awaited<ReturnType<typeof setup>>): Promise<void> {
    const plan = await getPlan(value.workspace, value.planId);
    expect(plan.approvalRef).toBeDefined();
    await decideApproval(value.workspace, value.schemas, plan.approvalRef!, {
      status: "revoked",
      decidedBy: "security-reviewer",
      reason: "Withdraw Plan execution authority."
    });
  }

  it("fences Plan write request, confirmation, and apply after Plan confirmation revocation", async () => {
    const requestCase = await setup();
    const requestCount = (await listWriteIntents(requestCase.workspace, requestCase.planId)).length;
    await revokePlanConfirmation(requestCase);
    await expect(requestWrites(requestCase.workspace, requestCase.schemas, requestCase.planId, "step-1", [{
      target: "docs/guide.md", action: "modify", purpose: "must not request"
    }])).rejects.toMatchObject({ code: "PLAN_CONFIRMATION_NOT_ACTIVE" });
    expect(await listWriteIntents(requestCase.workspace, requestCase.planId)).toHaveLength(requestCount);
    expect(await readFile(path.join(requestCase.workspace.root, "docs", "guide.md"), "utf8")).toBe("original\n");

    const confirmCase = await setup();
    await approveFreshWriteCapability(confirmCase.workspace, confirmCase.schemas, ["docs/guide.md"]);
    const pending = await requestWrites(confirmCase.workspace, confirmCase.schemas, confirmCase.planId, "step-1", [{
      target: "docs/guide.md", action: "modify", purpose: "pending before revocation"
    }]);
    await approveWriteIntent(confirmCase.workspace, confirmCase.schemas, pending);
    await revokePlanConfirmation(confirmCase);
    await expect(confirmWrites(confirmCase.workspace, confirmCase.planId, "step-1", pending.writeIntentId, confirmCase.schemas))
      .rejects.toMatchObject({ code: "PLAN_CONFIRMATION_NOT_ACTIVE" });
    await expect(getWriteIntent(confirmCase.workspace, pending.writeIntentId)).resolves.toMatchObject({ status: "PENDING" });
    expect(await readFile(path.join(confirmCase.workspace.root, "docs", "guide.md"), "utf8")).toBe("original\n");

    const applyCase = await setup();
    await revokePlanConfirmation(applyCase);
    await expect(applyWrite(applyCase.workspace, applyCase.schemas, applyCase.lease, applyCase.intent, "docs/guide.md", "must not write\n"))
      .rejects.toMatchObject({ code: "PLAN_CONFIRMATION_NOT_ACTIVE" });
    expect(await readFile(path.join(applyCase.workspace.root, "docs", "guide.md"), "utf8")).toBe("original\n");
    await expect(getWriteIntent(applyCase.workspace, applyCase.intent.writeIntentId)).resolves.toMatchObject({ status: "CONFIRMED" });
  });

  it("applies a create write with evidence and audit", async () => {
    const { workspace, schemas, intent, lease } = await setup(["reports/summary.md"]);
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

  it("fails closed with an uncertain recovery journal when persistence fails after a write mutation", async () => {
    const { workspace, schemas, intent, lease } = await setup();
    const target = "docs/guide.md";
    const outside = await mkdtemp(path.join(os.tmpdir(), "stinky-write-evidence-failure-"));
    roots.push(outside);
    await symlink(outside, path.join(workspace.directory, "evidence"));

    await expect(applyWrite(workspace, schemas, lease, intent, target, "updated\n"))
      .rejects.toMatchObject({ code: "PATH_DENIED" });

    expect(await readFile(path.join(workspace.root, target), "utf8")).toBe("updated\n");
    const stored = await getWriteIntent(workspace, intent.writeIntentId);
    expect(stored).toMatchObject({
      status: "RECOVERY_REQUIRED",
      recoveryJournal: {
        state: "UNCERTAIN",
        operation: "modify",
        target,
        preImageMissing: false,
        expectedPreimageHash: intent.expectedPreimageHash,
        postImageHash: `sha256:${createHash("sha256").update("updated\n").digest("hex")}`
      }
    });
    expect(stored.recoveryJournal?.backupPath).toMatch(/backups\/write-/);
    expect(await readFile(path.join(workspace.directory, stored.recoveryJournal!.backupPath!), "utf8")).toBe("original\n");
    await expect(applyWrite(workspace, schemas, lease, stored, target, "updated\n"))
      .rejects.toMatchObject({ code: "WRITE_RECOVERY_REQUIRED" });

    await rm(path.join(workspace.directory, "evidence"));
    await mkdir(path.join(workspace.directory, "evidence"));
    await expect(reconcileApplyWrite(workspace, schemas, intent.writeIntentId))
      .resolves.toMatchObject({ outcome: "APPLIED", writeIntent: { status: "APPLIED" }, target });
    await expect(reconcileApplyWrite(workspace, schemas, intent.writeIntentId))
      .resolves.toMatchObject({ outcome: "ALREADY_APPLIED", writeIntent: { status: "APPLIED" }, target });
    expect((await listLedgerEntries(workspace)).filter((entry) => entry.event === "write-applied" && entry.writeIntentRef === intent.writeIntentId)).toHaveLength(1);
  });

  it("returns an exact pre-image apply fence to CONFIRMED without overwriting bytes", async () => {
    const { workspace, schemas, intent } = await setup();
    const backupPath = `backups/write-${intent.writeIntentId}/docs/guide.md`;
    await mkdir(path.join(workspace.directory, path.dirname(backupPath)), { recursive: true });
    await writeFile(path.join(workspace.directory, backupPath), "original\n", "utf8");
    await writeWorkspaceJson(workspace, `write-intents/${intent.writeIntentId}.json`, {
      ...intent,
      status: "RECOVERY_REQUIRED",
      recoveryJournal: {
        state: "UNCERTAIN",
        operation: "modify",
        target: "docs/guide.md",
        expectedPreimageHash: intent.expectedPreimageHash,
        preImageMissing: false,
        postImageHash: `sha256:${createHash("sha256").update("updated\n").digest("hex")}`,
        backupPath,
        startedAt: new Date().toISOString()
      }
    });

    await expect(reconcileApplyWrite(workspace, schemas, intent.writeIntentId))
      .resolves.toMatchObject({ outcome: "READY_TO_RETRY", writeIntent: { status: "CONFIRMED" } });
    expect(await readFile(path.join(workspace.root, "docs/guide.md"), "utf8")).toBe("original\n");
    await expect(stat(path.join(workspace.directory, backupPath))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves RECOVERY_REQUIRED when the apply target is a third byte state", async () => {
    const { workspace, schemas, intent, lease } = await setup();
    const outside = await mkdtemp(path.join(os.tmpdir(), "stinky-write-recovery-conflict-"));
    roots.push(outside);
    await symlink(outside, path.join(workspace.directory, "evidence"));
    await expect(applyWrite(workspace, schemas, lease, intent, "docs/guide.md", "updated\n")).rejects.toMatchObject({ code: "PATH_DENIED" });
    await writeFile(path.join(workspace.root, "docs/guide.md"), "third-party\n", "utf8");
    await rm(path.join(workspace.directory, "evidence"));
    await mkdir(path.join(workspace.directory, "evidence"));

    await expect(reconcileApplyWrite(workspace, schemas, intent.writeIntentId))
      .rejects.toMatchObject({ code: "WRITE_APPLY_RECOVERY_CONFLICT" });
    expect(await readFile(path.join(workspace.root, "docs/guide.md"), "utf8")).toBe("third-party\n");
    expect((await getWriteIntent(workspace, intent.writeIntentId)).status).toBe("RECOVERY_REQUIRED");
  });

  it("rejects hard-linked business targets at request, confirm, apply, rollback, and apply recovery", async () => {
    const requestCase = await setup();
    const requestOutside = await mkdtemp(path.join(os.tmpdir(), "stinky-hardlink-request-"));
    roots.push(requestOutside);
    await link(path.join(requestCase.workspace.root, "docs/guide.md"), path.join(requestOutside, "linked.md"));
    await approveFreshWriteCapability(requestCase.workspace, requestCase.schemas, ["docs/guide.md"]);
    await expect(requestWrites(requestCase.workspace, requestCase.schemas, requestCase.planId, "step-1", [{ target: "docs/guide.md", action: "modify", purpose: "x" }]))
      .rejects.toMatchObject({ code: "WRITE_TARGET_HARDLINK_DENIED" });

    const confirmCase = await setup();
    await approveFreshWriteCapability(confirmCase.workspace, confirmCase.schemas, ["docs/guide.md"]);
    const pending = await requestWrites(confirmCase.workspace, confirmCase.schemas, confirmCase.planId, "step-1", [{ target: "docs/guide.md", action: "modify", purpose: "x" }]);
    await approveWriteIntent(confirmCase.workspace, confirmCase.schemas, pending);
    const confirmOutside = await mkdtemp(path.join(os.tmpdir(), "stinky-hardlink-confirm-"));
    roots.push(confirmOutside);
    await link(path.join(confirmCase.workspace.root, "docs/guide.md"), path.join(confirmOutside, "linked.md"));
    await expect(confirmWrites(confirmCase.workspace, confirmCase.planId, "step-1", pending.writeIntentId, confirmCase.schemas))
      .rejects.toMatchObject({ code: "WRITE_TARGET_HARDLINK_DENIED" });

    const applyCase = await setup();
    const applyOutside = await mkdtemp(path.join(os.tmpdir(), "stinky-hardlink-apply-"));
    roots.push(applyOutside);
    await link(path.join(applyCase.workspace.root, "docs/guide.md"), path.join(applyOutside, "linked.md"));
    await expect(applyWrite(applyCase.workspace, applyCase.schemas, applyCase.lease, applyCase.intent, "docs/guide.md", "updated\n"))
      .rejects.toMatchObject({ code: "WRITE_TARGET_HARDLINK_DENIED" });
    expect(await readFile(path.join(applyOutside, "linked.md"), "utf8")).toBe("original\n");

    const rollbackCase = await setup();
    await applyWrite(rollbackCase.workspace, rollbackCase.schemas, rollbackCase.lease, rollbackCase.intent, "docs/guide.md", "updated\n");
    const rollbackOutside = await mkdtemp(path.join(os.tmpdir(), "stinky-hardlink-rollback-"));
    roots.push(rollbackOutside);
    await link(path.join(rollbackCase.workspace.root, "docs/guide.md"), path.join(rollbackOutside, "linked.md"));
    await expect(rollbackWrite(rollbackCase.workspace, rollbackCase.schemas, rollbackCase.planId, "step-1", rollbackCase.intent.writeIntentId, "revert"))
      .rejects.toMatchObject({ code: "WRITE_TARGET_HARDLINK_DENIED" });

    const recoveryCase = await setup();
    const evidenceOutside = await mkdtemp(path.join(os.tmpdir(), "stinky-hardlink-recovery-evidence-"));
    const recoveryOutside = await mkdtemp(path.join(os.tmpdir(), "stinky-hardlink-recovery-"));
    roots.push(evidenceOutside, recoveryOutside);
    await symlink(evidenceOutside, path.join(recoveryCase.workspace.directory, "evidence"));
    await expect(applyWrite(recoveryCase.workspace, recoveryCase.schemas, recoveryCase.lease, recoveryCase.intent, "docs/guide.md", "updated\n")).rejects.toMatchObject({ code: "PATH_DENIED" });
    await link(path.join(recoveryCase.workspace.root, "docs/guide.md"), path.join(recoveryOutside, "linked.md"));
    await rm(path.join(recoveryCase.workspace.directory, "evidence"));
    await mkdir(path.join(recoveryCase.workspace.directory, "evidence"));
    await expect(reconcileApplyWrite(recoveryCase.workspace, recoveryCase.schemas, recoveryCase.intent.writeIntentId))
      .rejects.toMatchObject({ code: "WRITE_TARGET_HARDLINK_DENIED" });
    expect((await getWriteIntent(recoveryCase.workspace, recoveryCase.intent.writeIntentId)).status).toBe("RECOVERY_REQUIRED");
  });

  it.each(["backups-root", "intent-directory", "target-directory", "backup-leaf"] as const)(
    "refuses a symlinked control-plane backup component: %s",
    async (position) => {
      const { workspace, schemas, intent, lease } = await setup();
      const outside = await mkdtemp(path.join(os.tmpdir(), "stinky-backup-outside-"));
      roots.push(outside);
      const backups = path.join(workspace.directory, "backups");
      const intentDirectory = path.join(backups, `write-${intent.writeIntentId}`);
      const targetDirectory = path.join(intentDirectory, "docs");
      const backupLeaf = path.join(targetDirectory, "guide.md");

      if (position === "backups-root") {
        await symlink(outside, backups);
      } else if (position === "intent-directory") {
        await mkdir(backups);
        await symlink(outside, intentDirectory);
      } else if (position === "target-directory") {
        await mkdir(intentDirectory, { recursive: true });
        await symlink(outside, targetDirectory);
      } else {
        await mkdir(targetDirectory, { recursive: true });
        const sentinel = path.join(outside, "sentinel.md");
        await writeFile(sentinel, "external sentinel\n", "utf8");
        await symlink(sentinel, backupLeaf);
      }

      await expect(applyWrite(workspace, schemas, lease, intent, "docs/guide.md", "updated\n"))
        .rejects.toMatchObject({ code: "PATH_DENIED" });
      expect(await readFile(path.join(workspace.root, "docs/guide.md"), "utf8")).toBe("original\n");
      if (position === "backup-leaf") expect(await readFile(path.join(outside, "sentinel.md"), "utf8")).toBe("external sentinel\n");
      else expect(await readdir(outside)).toEqual([]);
    }
  );

  it("preserves a pre-existing backup and refuses to modify the business file", async () => {
    const { workspace, schemas, intent, lease } = await setup();
    const outside = await mkdtemp(path.join(os.tmpdir(), "stinky-backup-conflict-"));
    roots.push(outside);
    const external = path.join(outside, "original.md");
    const backupLeaf = path.join(workspace.directory, "backups", `write-${intent.writeIntentId}`, "docs", "guide.md");
    await writeFile(external, "preserved preimage\n", "utf8");
    await mkdir(path.dirname(backupLeaf), { recursive: true });
    await link(external, backupLeaf);

    await expect(applyWrite(workspace, schemas, lease, intent, "docs/guide.md", "updated\n"))
      .rejects.toMatchObject({ code: "WRITE_BACKUP_CONFLICT" });
    expect(await readFile(path.join(workspace.root, "docs/guide.md"), "utf8")).toBe("original\n");
    expect(await readFile(external, "utf8")).toBe("preserved preimage\n");
  });

  it("enforces create/modify existence semantics", async () => {
    const createCase = await setup(["reports/summary.md"]);
    await mkdir(path.join(createCase.workspace.root, "reports"), { recursive: true });
    await writeFile(path.join(createCase.workspace.root, "reports/summary.md"), "existing\n", "utf8");
    await expect(applyWrite(createCase.workspace, createCase.schemas, createCase.lease, createCase.intent, "reports/summary.md", "changed\n"))
      .rejects.toMatchObject({ code: "WRITE_TARGET_EXISTS" });

    const modifyCase = await setup(["docs/guide.md"]);
    await rm(path.join(modifyCase.workspace.root, "docs/guide.md"));
    await expect(applyWrite(modifyCase.workspace, modifyCase.schemas, modifyCase.lease, modifyCase.intent, "docs/guide.md", "changed\n"))
      .rejects.toMatchObject({ code: "WRITE_TARGET_MISSING" });
  });

  it("rejects duplicate, out-of-lease, and unconfirmed writes", async () => {
    const { workspace, schemas, intent, lease } = await setup(["reports/summary.md"]);
    await expect(issueLease(workspace, schemas, { taskId: "write-task", agentId: "a", role: "builder", capability: "repository-write", writeSet: ["other/file.md"] }))
      .rejects.toMatchObject({ code: "TASK_WRITE_SET_EXCEEDED" });
    await expect(applyWrite(workspace, schemas, lease, intent, "reports/summary.md", "x")).resolves.toMatchObject({ target: "reports/summary.md" });
    await expect(applyWrite(workspace, schemas, lease, intent, "reports/summary.md", "y")).rejects.toMatchObject({ code: "WRITE_ALREADY_APPLIED" });
  });

  it("enforces the forbidden-target guard at apply time even for hand-crafted leases", async () => {
    const { workspace, schemas } = await setup(["docs/guide.md"]);
    await approveFreshWriteCapability(workspace, schemas, ["docs/guide.md"]);
    const forgedLease: CapabilityLease = { ...(await issueLease(workspace, schemas, { taskId: "write-task", agentId: "a", role: "builder", capability: "repository-write", writeSet: ["docs/guide.md"] })), writeSet: [".env", "tool.exe", ".git/config", "docs/guide.md"] };
    const mkdir = (await import("node:fs/promises")).mkdir;
    const writeFile = (await import("node:fs/promises")).writeFile;
    const intentId = "write-forged-intent";
    await mkdir(path.join(workspace.directory, "write-intents"), { recursive: true });
    await writeFile(path.join(workspace.directory, "write-intents", `${intentId}.json`), JSON.stringify({
      version: 1,
      writeIntentId: intentId,
      planId: (await import("../src/storage/plans.js").then(({ listPlans }) => listPlans(workspace)))[0]!.planId,
      stepId: "step-1",
      taskId: "write-task",
      status: "CONFIRMED",
      writes: [{ target: ".env", action: "modify", purpose: "forged" }],
      confirmedTargets: [".env"],
      createdAt: "2026-01-01T00:00:00.000Z",
      confirmedAt: "2026-01-01T00:01:00.000Z",
      autoAllowed: true,
      intentHash: "sha256:" + "0".repeat(64),
      expectedPreimageHash: "sha256:" + "1".repeat(64),
      authorityApprovalRefs: ["approval-forged-intent"],
      authorityApprovalRef: "approval-forged-intent",
      authorityConsumptionOwner: intentId,
      parentGrantRef: "task-authority:write-task",
      taskAuthorityHash: "sha256:" + "2".repeat(64),
      policyVersion: "task-authority-v1",
      hostSessionId: "forged-test"
    }), "utf8");
    const forgedIntent = await getWriteIntent(workspace, intentId);
    for (const target of [".env", "tool.exe", ".git/config"]) {
      await expect(applyWrite(workspace, schemas, forgedLease, forgedIntent, target, "x")).rejects.toMatchObject({ code: "WRITE_TARGET_NOT_IN_LEASE" });
    }
    await expect(applyWrite(workspace, schemas, forgedLease, forgedIntent, "docs/guide.md", "x".repeat(1024 * 1024 + 1))).rejects.toMatchObject({ code: "WRITE_INTENT_INVALID" });
  });

  it("requires the intent to be confirmed before applying", async () => {
    const { workspace, schemas, planId } = await setup(["docs/guide.md"]);
    await approveFreshWriteCapability(workspace, schemas, ["docs/guide.md"]);
    const pendingLease: CapabilityLease = await getLease(workspace, (await issueLease(workspace, schemas, { taskId: "write-task", agentId: "a", role: "builder", capability: "repository-write", writeSet: ["docs/guide.md"] })).id);
    await approveFreshWriteCapability(workspace, schemas, ["docs/guide.md"]);
    const fresh = await requestWrites(workspace, schemas, planId, "step-1", [{ target: "docs/guide.md", action: "modify", purpose: "x" }]);
    await expect(applyWrite(workspace, schemas, pendingLease, fresh, "docs/guide.md", "x")).rejects.toMatchObject({ code: "WRITE_INTENT_NOT_CONFIRMED" });
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

  it("reconciles a rollback journal persisted before the business-file mutation", async () => {
    const { workspace, schemas, intent, lease } = await setup();
    await applyWrite(workspace, schemas, lease, intent, "docs/guide.md", "updated\n");
    const applied = await getWriteIntent(workspace, intent.writeIntentId);
    const originalHash = `sha256:${createHash("sha256").update("original\n").digest("hex")}`;
    const updatedHash = `sha256:${createHash("sha256").update("updated\n").digest("hex")}`;
    const startedAt = new Date().toISOString();
    await writeWorkspaceJson(workspace, `write-intents/${intent.writeIntentId}.json`, {
      ...applied,
      status: "RECOVERY_REQUIRED",
      rollbackRecoveryJournal: {
        state: "UNCERTAIN",
        operation: "restore-backup",
        target: "docs/guide.md",
        expectedCurrentHash: updatedHash,
        restoredHash: originalHash,
        evidenceContentHash: originalHash,
        backupPath: `backups/write-${intent.writeIntentId}/docs/guide.md`,
        reason: "Simulated crash after durable rollback fence.",
        evidenceObservedAt: startedAt,
        startedAt
      }
    });

    await expect(reconcileRollbackWrite(workspace, schemas, intent.writeIntentId))
      .resolves.toMatchObject({ status: "ROLLED_BACK" });
    expect(await readFile(path.join(workspace.root, "docs/guide.md"), "utf8")).toBe("original\n");
  });

  it("reconciles idempotently after rollback mutation when evidence persistence fails", async () => {
    const { workspace, schemas, planId, intent, lease } = await setup();
    await applyWrite(workspace, schemas, lease, intent, "docs/guide.md", "updated\n");
    const evidenceDirectory = path.join(workspace.directory, "evidence");
    const outside = await mkdtemp(path.join(os.tmpdir(), "stinky-rollback-evidence-failure-"));
    roots.push(outside);
    await rm(evidenceDirectory, { recursive: true, force: true });
    await symlink(outside, evidenceDirectory);

    await expect(rollbackWrite(workspace, schemas, planId, "step-1", intent.writeIntentId, "Revert with injected evidence failure."))
      .rejects.toMatchObject({ code: "PATH_DENIED" });
    expect(await readFile(path.join(workspace.root, "docs/guide.md"), "utf8")).toBe("original\n");
    await expect(getWriteIntent(workspace, intent.writeIntentId)).resolves.toMatchObject({
      status: "RECOVERY_REQUIRED",
      rollbackRecoveryJournal: { state: "UNCERTAIN", operation: "restore-backup" }
    });

    await rm(evidenceDirectory);
    await mkdir(evidenceDirectory);
    await expect(reconcileRollbackWrite(workspace, schemas, intent.writeIntentId))
      .resolves.toMatchObject({ status: "ROLLED_BACK" });
    expect(await readFile(path.join(workspace.root, "docs/guide.md"), "utf8")).toBe("original\n");
    const rollbackEvents = (await listLedgerEntries(workspace)).filter((entry) => entry.event === "write-rolled-back");
    expect(rollbackEvents).toHaveLength(1);
  });

  it.each(["backups-root", "intent-directory", "target-directory", "backup-leaf"] as const)(
    "refuses to read rollback bytes through a symlinked backup component: %s",
    async (position) => {
      const { workspace, schemas, planId, intent, lease } = await setup();
      await applyWrite(workspace, schemas, lease, intent, "docs/guide.md", "updated\n");
      const outside = await mkdtemp(path.join(os.tmpdir(), "stinky-rollback-backup-outside-"));
      roots.push(outside);
      const backups = path.join(workspace.directory, "backups");
      const intentDirectory = path.join(backups, `write-${intent.writeIntentId}`);
      const targetDirectory = path.join(intentDirectory, "docs");
      const backupLeaf = path.join(targetDirectory, "guide.md");

      if (position === "backups-root") {
        await rm(backups, { recursive: true });
        await mkdir(path.join(outside, `write-${intent.writeIntentId}`, "docs"), { recursive: true });
        await writeFile(path.join(outside, `write-${intent.writeIntentId}`, "docs", "guide.md"), "external backup\n", "utf8");
        await symlink(outside, backups);
      } else if (position === "intent-directory") {
        await rm(intentDirectory, { recursive: true });
        await mkdir(path.join(outside, "docs"));
        await writeFile(path.join(outside, "docs", "guide.md"), "external backup\n", "utf8");
        await symlink(outside, intentDirectory);
      } else if (position === "target-directory") {
        await rm(targetDirectory, { recursive: true });
        await writeFile(path.join(outside, "guide.md"), "external backup\n", "utf8");
        await symlink(outside, targetDirectory);
      } else {
        await rm(backupLeaf);
        const externalBackup = path.join(outside, "guide.md");
        await writeFile(externalBackup, "external backup\n", "utf8");
        await symlink(externalBackup, backupLeaf);
      }

      await expect(rollbackWrite(workspace, schemas, planId, "step-1", intent.writeIntentId, "Refuse external backup."))
        .rejects.toMatchObject({ code: "PATH_DENIED" });
      expect(await readFile(path.join(workspace.root, "docs/guide.md"), "utf8")).toBe("updated\n");
    }
  );

  it("refuses rollback from a hard-linked backup", async () => {
    const { workspace, schemas, planId, intent, lease } = await setup();
    await applyWrite(workspace, schemas, lease, intent, "docs/guide.md", "updated\n");
    const backupLeaf = path.join(workspace.directory, "backups", `write-${intent.writeIntentId}`, "docs", "guide.md");
    const outside = await mkdtemp(path.join(os.tmpdir(), "stinky-rollback-hardlink-"));
    roots.push(outside);
    const external = path.join(outside, "external.md");
    await writeFile(external, "external backup\n", "utf8");
    await rm(backupLeaf);
    await link(external, backupLeaf);

    await expect(rollbackWrite(workspace, schemas, planId, "step-1", intent.writeIntentId, "Refuse linked backup."))
      .rejects.toMatchObject({ code: "WRITE_ROLLBACK_JOURNAL_INVALID" });
    expect(await readFile(path.join(workspace.root, "docs/guide.md"), "utf8")).toBe("updated\n");
    expect(await readFile(external, "utf8")).toBe("external backup\n");
  });

  it("restores a modified file byte-for-byte even when its backup is not valid UTF-8", async () => {
    const original = Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x41]);
    const { workspace, schemas, planId, intent, lease } = await setup(["docs/guide.md"], original);
    await applyWrite(workspace, schemas, lease, intent, "docs/guide.md", "replacement\n");
    await rollbackWrite(workspace, schemas, planId, "step-1", intent.writeIntentId, "Restore bytes.");
    expect(await readFile(path.join(workspace.root, "docs/guide.md"))).toEqual(original);
  });

  it("refuses symbolic-link targets and ancestors without changing outside files", async () => {
    const { workspace, schemas, intent, lease } = await setup(["reports/summary.md"]);
    const outside = await mkdtemp(path.join(os.tmpdir(), "stinky-outside-"));
    roots.push(outside);
    await writeFile(path.join(outside, "summary.md"), "outside\n", "utf8");
    await mkdir(path.join(workspace.root, "reports"), { recursive: true });
    await symlink(path.join(outside, "summary.md"), path.join(workspace.root, "reports", "summary.md"));
    await expect(applyWrite(workspace, schemas, lease, intent, "reports/summary.md", "changed\n")).rejects.toMatchObject({ code: "WRITE_TARGET_INVALID" });
    expect(await readFile(path.join(outside, "summary.md"), "utf8")).toBe("outside\n");
  });

  it("refuses rollback after a third party changes the applied target", async () => {
    const { workspace, schemas, planId, intent, lease } = await setup(["docs/guide.md"]);
    await applyWrite(workspace, schemas, lease, intent, "docs/guide.md", "updated\n");
    await writeFile(path.join(workspace.root, "docs/guide.md"), "third-party\n", "utf8");
    await expect(rollbackWrite(workspace, schemas, planId, "step-1", intent.writeIntentId, "Revert change.")).rejects.toMatchObject({ code: "WRITE_ROLLBACK_CONFLICT" });
    expect(await readFile(path.join(workspace.root, "docs/guide.md"), "utf8")).toBe("third-party\n");
  });

  it("refuses created-file rollback after a third party changes it", async () => {
    const { workspace, schemas, planId, intent, lease } = await setup(["reports/summary.md"]);
    await applyWrite(workspace, schemas, lease, intent, "reports/summary.md", "created\n");
    await writeFile(path.join(workspace.root, "reports/summary.md"), "third-party\n", "utf8");
    await expect(rollbackWrite(workspace, schemas, planId, "step-1", intent.writeIntentId, "Revert change."))
      .rejects.toMatchObject({ code: "WRITE_ROLLBACK_CONFLICT" });
    expect(await readFile(path.join(workspace.root, "reports/summary.md"), "utf8")).toBe("third-party\n");
  });

  it("revalidates create and modify rollback targets against current custom sensitive paths", async () => {
    const modifyCase = await setup(["docs/guide.md"]);
    await applyWrite(modifyCase.workspace, modifyCase.schemas, modifyCase.lease, modifyCase.intent, "docs/guide.md", "updated\n");
    await addSensitivePath(modifyCase.workspace.root, "docs/guide.md");
    await expect(rollbackWrite(modifyCase.workspace, modifyCase.schemas, modifyCase.planId, "step-1", modifyCase.intent.writeIntentId, "Revert."))
      .rejects.toMatchObject({ code: "WRITE_ROLLBACK_TARGET_INVALID" });
    expect(await readFile(path.join(modifyCase.workspace.root, "docs/guide.md"), "utf8")).toBe("updated\n");

    const createCase = await setup(["reports/summary.md"]);
    await applyWrite(createCase.workspace, createCase.schemas, createCase.lease, createCase.intent, "reports/summary.md", "created\n");
    await addSensitivePath(createCase.workspace.root, "reports/summary.md");
    await expect(rollbackWrite(createCase.workspace, createCase.schemas, createCase.planId, "step-1", createCase.intent.writeIntentId, "Revert."))
      .rejects.toMatchObject({ code: "WRITE_ROLLBACK_TARGET_INVALID" });
    expect(await readFile(path.join(createCase.workspace.root, "reports/summary.md"), "utf8")).toBe("created\n");
  });

  it("rejects rollback of non-applied writes", async () => {
    const { workspace, schemas, planId } = await setup(["docs/guide.md"]);
    await approveFreshWriteCapability(workspace, schemas, ["docs/guide.md"]);
    const fresh = await requestWrites(workspace, schemas, planId, "step-1", [{ target: "docs/guide.md", action: "modify", purpose: "x" }]);
    await expect(rollbackWrite(workspace, schemas, planId, "step-1", fresh.writeIntentId, "x")).rejects.toMatchObject({ code: "WRITE_NOT_APPLIED" });
  });
});

describe("controlled delete execution", () => {
  async function deleteSetup(initialGuideContent: string | Buffer = "original\n") {
    const root = await mkdtemp(path.join(os.tmpdir(), "stinky-writes-del-"));
    roots.push(root);
    const workspace = await initWorkspace(root);
    await mkdir(path.join(root, "docs"), { recursive: true });
    await writeFile(path.join(root, "docs", "guide.md"), initialGuideContent);
    const task = { id: "write-task", workspaceId: "workspace-1", goal: "Write docs", requestedOutputs: ["report"], riskLevel: "L0" as const, state: "RUNNING" as const, scope: ["."], writeSet: ["docs/guide.md"] };
    await createTask(workspace, task);
    const schemas = await SchemaRegistry.create(projectRoot);
    await approveTaskCapability(workspace, schemas, task, "repository-write", ["docs/guide.md"]);
    await approveTaskCapability(workspace, schemas, task, "repository-write", ["docs/guide.md"]);
    const registries = await loadRegistries(projectRoot, schemas);
    const plan = await createPlan(workspace, schemas, registries, { taskId: "write-task", roles: ["builder"] });
    await approvePlanConfirmation(workspace, schemas, plan);
    await confirmPlan(workspace, plan.planId);
    await executePlan(workspace, plan.planId);
    await beginStep(workspace, schemas, plan.planId, "step-1");
    const intent = await requestWrites(workspace, schemas, plan.planId, "step-1", [{ target: "docs/guide.md", action: "delete", purpose: "Remove." }]);
    await approveWriteIntent(workspace, schemas, intent);
    await confirmWrites(workspace, plan.planId, "step-1", intent.writeIntentId, schemas);
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

  it("fails closed with an uncertain recovery journal when persistence fails after a delete mutation", async () => {
    const { workspace, schemas, intent, lease } = await deleteSetup();
    const target = "docs/guide.md";
    const outside = await mkdtemp(path.join(os.tmpdir(), "stinky-delete-evidence-failure-"));
    roots.push(outside);
    await symlink(outside, path.join(workspace.directory, "evidence"));

    await expect(applyDelete(workspace, schemas, lease, intent, target))
      .rejects.toMatchObject({ code: "PATH_DENIED" });

    await expect(stat(path.join(workspace.root, target))).rejects.toMatchObject({ code: "ENOENT" });
    const stored = await getWriteIntent(workspace, intent.writeIntentId);
    expect(stored).toMatchObject({
      status: "RECOVERY_REQUIRED",
      recoveryJournal: {
        state: "UNCERTAIN",
        operation: "delete",
        target,
        preImageMissing: false,
        expectedPreimageHash: intent.expectedPreimageHash,
        postImageHash: null
      }
    });
    expect(await readFile(path.join(workspace.directory, stored.recoveryJournal!.backupPath!), "utf8")).toBe("original\n");
    await expect(applyDelete(workspace, schemas, lease, stored, target))
      .rejects.toMatchObject({ code: "WRITE_RECOVERY_REQUIRED" });

    await rm(path.join(workspace.directory, "evidence"));
    await mkdir(path.join(workspace.directory, "evidence"));
    await expect(reconcileApplyWrite(workspace, schemas, intent.writeIntentId))
      .resolves.toMatchObject({ outcome: "APPLIED", writeIntent: { status: "APPLIED" }, target });
    expect((await listLedgerEntries(workspace)).filter((entry) => entry.event === "delete-applied" && entry.writeIntentRef === intent.writeIntentId)).toHaveLength(1);
  });

  it("rejects a hard-linked delete target before backup or removal", async () => {
    const { workspace, schemas, intent, lease } = await deleteSetup();
    const outside = await mkdtemp(path.join(os.tmpdir(), "stinky-hardlink-delete-"));
    roots.push(outside);
    await link(path.join(workspace.root, "docs/guide.md"), path.join(outside, "linked.md"));
    await expect(applyDelete(workspace, schemas, lease, intent, "docs/guide.md"))
      .rejects.toMatchObject({ code: "WRITE_TARGET_HARDLINK_DENIED" });
    expect(await readFile(path.join(outside, "linked.md"), "utf8")).toBe("original\n");
  });

  it("refuses to delete when the backup root is a symlink", async () => {
    const { workspace, schemas, intent, lease } = await deleteSetup();
    const outside = await mkdtemp(path.join(os.tmpdir(), "stinky-delete-backup-outside-"));
    roots.push(outside);
    await symlink(outside, path.join(workspace.directory, "backups"));

    await expect(applyDelete(workspace, schemas, lease, intent, "docs/guide.md"))
      .rejects.toMatchObject({ code: "PATH_DENIED" });
    expect(await readFile(path.join(workspace.root, "docs/guide.md"), "utf8")).toBe("original\n");
    expect(await readdir(outside)).toEqual([]);
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

  it("restores a deleted file byte-for-byte even when its backup is not valid UTF-8", async () => {
    const original = Buffer.from([0xff, 0x00, 0xc3, 0x28, 0x7f]);
    const { workspace, schemas, planId, intent, lease } = await deleteSetup(original);
    await applyDelete(workspace, schemas, lease, intent, "docs/guide.md");
    await rollbackWrite(workspace, schemas, planId, "step-1", intent.writeIntentId, "Restore bytes.");
    expect(await readFile(path.join(workspace.root, "docs/guide.md"))).toEqual(original);
  });

  it("refuses delete rollback if the target was recreated", async () => {
    const { workspace, schemas, planId, intent, lease } = await deleteSetup();
    await applyDelete(workspace, schemas, lease, intent, "docs/guide.md");
    await writeFile(path.join(workspace.root, "docs/guide.md"), "third-party\n", "utf8");
    await expect(rollbackWrite(workspace, schemas, planId, "step-1", intent.writeIntentId, "Restore deleted file."))
      .rejects.toMatchObject({ code: "WRITE_ROLLBACK_CONFLICT" });
    expect(await readFile(path.join(workspace.root, "docs/guide.md"), "utf8")).toBe("third-party\n");
  });

  it("revalidates delete rollback targets against current custom sensitive paths", async () => {
    const { workspace, schemas, planId, intent, lease } = await deleteSetup();
    await applyDelete(workspace, schemas, lease, intent, "docs/guide.md");
    await addSensitivePath(workspace.root, "docs/guide.md");
    await expect(rollbackWrite(workspace, schemas, planId, "step-1", intent.writeIntentId, "Restore."))
      .rejects.toMatchObject({ code: "WRITE_ROLLBACK_TARGET_INVALID" });
    await expect(stat(path.join(workspace.root, "docs/guide.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects deleting a missing target and requesting a modify intent for missing bytes", async () => {
    const { workspace, schemas, planId, intent, lease } = await deleteSetup();
    await rm(path.join(workspace.root, "docs/guide.md"), { force: true });
    await expect(applyDelete(workspace, schemas, lease, intent, "docs/guide.md")).rejects.toMatchObject({ code: "WRITE_TARGET_MISSING" });
    await approveFreshWriteCapability(workspace, schemas, ["docs/guide.md"]);
    await expect(requestWrites(workspace, schemas, planId, "step-1", [{ target: "docs/guide.md", action: "modify", purpose: "x" }]))
      .rejects.toMatchObject({ code: "WRITE_TARGET_MISSING" });
  });
});
