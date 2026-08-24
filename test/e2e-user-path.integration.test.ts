import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { hashTaskAuthority, TASK_AUTHORITY_POLICY_VERSION } from "../src/storage/task-authority.js";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(import.meta.dirname, "..");
const roots: string[] = [];

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function tmp(prefix: string): Promise<string> {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), prefix)));
  roots.push(dir);
  return dir;
}

async function cli(home: string, ...args: string[]): Promise<Record<string, any>> {
  const result = await execFileAsync(process.execPath, [path.join(projectRoot, "dist/cli.js"), ...args], {
    cwd: projectRoot,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, HOME: home, USERPROFILE: home }
  });
  return JSON.parse(result.stdout) as Record<string, any>;
}

describe("end-to-end user path (temporary HOME)", () => {
  it("walks install → governance → schedule → write → rollback → audit", async () => {
    const home = await tmp("stinky-e2e-home-");
    const root = await tmp("stinky-e2e-ws-");
    await writeFile(path.join(root, "README.md"), "original readme\n", "utf8");

    // 1. Installation into the temporary host.
    await cli(home, "entry", "install-host", "--scope", "user", "--json");
    const commandFile = await readFile(path.join(home, ".zcode", "commands", "stinky-cobbler.md"), "utf8");
    expect(commandFile).toContain("/stinky-cobbler");
    const skillFile = await readFile(path.join(home, ".zcode", "skills", "stinky-cobbler", "SKILL.md"), "utf8");
    expect(skillFile).toContain("via=skill|mcp|auto");
    const preflight = await cli(home, "entry", "preflight", "--workspace", root, "--json");
    expect(preflight.workspaceInitialized).toBe(false);

    // 2. Governance: init, task, lease.
    await cli(home, "init", "--workspace-id", "e2e", "--profile", "team", "--pack", "software-engineering", "--mode", "reviewed-workflow", "--root", root, "--json");
    const taskFile = path.join(root, "task.json");
    await writeFile(taskFile, JSON.stringify({
      id: "e2e-task",
      workspaceId: "e2e",
      goal: "Review docs",
      requestedOutputs: ["report"],
      riskLevel: "L0",
      state: "DRAFT",
      scope: ["."],
      writeSet: ["README.md"],
      packs: ["software-engineering"]
    }), "utf8");
    await cli(home, "task", "create", "--file", taskFile, "--root", root, "--json");
    await cli(home, "task", "transition", "e2e-task", "--to", "SCOPED", "--root", root, "--json");
    await cli(home, "task", "transition", "e2e-task", "--to", "DESIGNED", "--root", root, "--json");
    const designedTask = await cli(home, "task", "show", "e2e-task", "--root", root, "--json");
    const expiresAt = "2099-01-01T00:00:00.000Z";
    const executionApprovalFile = path.join(root, "task-execution-approval.json");
    await writeFile(executionApprovalFile, JSON.stringify({
      taskId: "e2e-task",
      action: "task-execution",
      scope: ["."],
      subjectKind: "task-authority",
      subjectId: "e2e-task",
      subjectVersion: 1,
      subjectHash: hashTaskAuthority(designedTask),
      capability: "task-execution",
      budget: { maxToolCalls: 100, expiresAt },
      policyVersion: TASK_AUTHORITY_POLICY_VERSION,
      requestedBy: "e2e-host",
      nonce: "e2e-task-execution",
      expiresAt,
      reason: "Authorize the end-to-end Task for execution."
    }), "utf8");
    const executionApproval = await cli(home, "approval", "request", "--file", executionApprovalFile, "--root", root, "--json");
    await cli(home, "approval", "decide", executionApproval.id, "--status", "approved", "--decided-by", "e2e-host", "--reason", "Approved.", "--root", root, "--json");
    await cli(home, "task", "transition", "e2e-task", "--to", "APPROVED_FOR_EXECUTION", "--approval", executionApproval.id, "--root", root, "--json");
    await cli(home, "task", "transition", "e2e-task", "--to", "RUNNING", "--root", root, "--json");
    const runningTask = await cli(home, "task", "show", "e2e-task", "--root", root, "--json");
    const capabilityApprovalFile = path.join(root, "write-capability-approval.json");
    await writeFile(capabilityApprovalFile, JSON.stringify({
      taskId: "e2e-task",
      action: "delegate-capability",
      scope: ["README.md"],
      subjectKind: "task-authority",
      subjectId: "e2e-task",
      subjectVersion: 1,
      subjectHash: hashTaskAuthority(runningTask),
      capability: "repository-write",
      budget: { maxToolCalls: 100, expiresAt },
      policyVersion: TASK_AUTHORITY_POLICY_VERSION,
      requestedBy: "e2e-host",
      nonce: "e2e-repository-write",
      expiresAt,
      reason: "Delegate the exact end-to-end write capability."
    }), "utf8");
    const capabilityApproval = await cli(home, "approval", "request", "--file", capabilityApprovalFile, "--root", root, "--json");
    await cli(home, "approval", "decide", capabilityApproval.id, "--status", "approved", "--decided-by", "e2e-host", "--reason", "Approved.", "--root", root, "--json");
    const readLease = await cli(home, "lease", "issue", "--task", "e2e-task", "--agent", "e2e-agent", "--capability", "repository-read", "--root", root, "--json");
    expect(readLease.id).toMatch(/^lease-/);

    // 3. Scheduling: plan → confirm → execute → step → finish.
    const plan = await cli(home, "plan", "create", "--task", "e2e-task", "--roles", "scout,verifier", "--root", root, "--json");
    const planApprovalFile = path.join(root, "plan-approval.json");
    await writeFile(planApprovalFile, JSON.stringify({
      taskId: "e2e-task", action: "plan-confirm", scope: [plan.planId],
      subjectKind: "plan", subjectId: plan.planId, subjectVersion: plan.planSubjectVersion, subjectHash: plan.planSubjectHash,
      capability: "plan-execute", budget: { maxToolCalls: 1, expiresAt }, policyVersion: plan.policyVersion,
      requestedBy: "e2e-host", hostSessionId: plan.hostSessionId, nonce: "e2e-plan-confirm", expiresAt,
      reason: "Confirm the exact Plan snapshot."
    }), "utf8");
    const planApproval = await cli(home, "approval", "request", "--file", planApprovalFile, "--root", root, "--json");
    await cli(home, "approval", "decide", planApproval.id, "--status", "approved", "--decided-by", "user", "--reason", "Confirmed.", "--root", root, "--json");
    await expect(cli(home, "plan", "confirm", plan.planId, "--root", root, "--json")).resolves.toMatchObject({ status: "APPROVED" });
    await cli(home, "plan", "execute", plan.planId, "--root", root, "--json");
    const step1 = await cli(home, "plan", "step", plan.planId, "step-1", "--root", root, "--json");
    expect(step1.leases.length).toBeGreaterThan(0);
    await cli(home, "plan", "step-done", plan.planId, "step-1", "--evidence", "receipt-e2e-read", "--root", root, "--json");
    await cli(home, "plan", "step", plan.planId, "step-2", "--root", root, "--json");
    await cli(home, "plan", "step-done", plan.planId, "step-2", "--root", root, "--json");
    await expect(cli(home, "plan", "finish", plan.planId, "--root", root, "--json")).resolves.toMatchObject({ status: "COMPLETED" });

    // 4. Controlled write: second plan with a builder step → confirm → apply → rollback.
    const writePlan = await cli(home, "plan", "create", "--task", "e2e-task", "--roles", "builder", "--root", root, "--json");
    const writePlanApprovalFile = path.join(root, "write-plan-approval.json");
    await writeFile(writePlanApprovalFile, JSON.stringify({
      taskId: "e2e-task", action: "plan-confirm", scope: [writePlan.planId],
      subjectKind: "plan", subjectId: writePlan.planId, subjectVersion: writePlan.planSubjectVersion, subjectHash: writePlan.planSubjectHash,
      capability: "plan-execute", budget: { maxToolCalls: 1, expiresAt }, policyVersion: writePlan.policyVersion,
      requestedBy: "e2e-host", hostSessionId: writePlan.hostSessionId, nonce: "e2e-write-plan-confirm", expiresAt,
      reason: "Confirm the exact Write Plan snapshot."
    }), "utf8");
    const writePlanApproval = await cli(home, "approval", "request", "--file", writePlanApprovalFile, "--root", root, "--json");
    await cli(home, "approval", "decide", writePlanApproval.id, "--status", "approved", "--decided-by", "user", "--reason", "Confirmed.", "--root", root, "--json");
    await cli(home, "plan", "confirm", writePlan.planId, "--root", root, "--json");
    await cli(home, "plan", "execute", writePlan.planId, "--root", root, "--json");
    await cli(home, "plan", "step", writePlan.planId, "step-1", "--root", root, "--json");
    const writesFile = path.join(root, "writes.json");
    await writeFile(writesFile, JSON.stringify([{ target: "README.md", action: "modify", purpose: "Fix typo." }]), "utf8");
    const writeIntent = await cli(home, "plan", "write-request", writePlan.planId, "step-1", "--file", writesFile, "--approval", capabilityApproval.id, "--root", root, "--json");
    const writeApprovalFile = path.join(root, "write-approval.json");
    await writeFile(writeApprovalFile, JSON.stringify({
      taskId: "e2e-task",
      action: "write-confirm",
      scope: ["README.md"],
      subjectKind: "write-intent",
      subjectId: writeIntent.writeIntentId,
      subjectVersion: writeIntent.version,
      subjectHash: writeIntent.intentHash,
      capability: "repository-write",
      expectedPreimageHash: writeIntent.expectedPreimageHash,
      budget: { maxToolCalls: 1, expiresAt },
      policyVersion: TASK_AUTHORITY_POLICY_VERSION,
      requestedBy: "e2e-host",
      nonce: "e2e-write-intent-confirmation",
      expiresAt,
      reason: "Confirm the exact write intent."
    }), "utf8");
    const writeApproval = await cli(home, "approval", "request", "--file", writeApprovalFile, "--root", root, "--json");
    await cli(home, "approval", "decide", writeApproval.id, "--status", "approved", "--decided-by", "user", "--reason", "Confirmed.", "--root", root, "--json");
    await cli(home, "plan", "write-confirm", writePlan.planId, "step-1", writeIntent.writeIntentId, "--root", root, "--json");
    const leaseCapabilityApprovalFile = path.join(root, "write-lease-capability-approval.json");
    await writeFile(leaseCapabilityApprovalFile, JSON.stringify({
      taskId: "e2e-task",
      action: "delegate-capability",
      scope: ["README.md"],
      subjectKind: "task-authority",
      subjectId: "e2e-task",
      subjectVersion: 1,
      subjectHash: hashTaskAuthority(runningTask),
      capability: "repository-write",
      budget: { maxToolCalls: 100, expiresAt },
      policyVersion: TASK_AUTHORITY_POLICY_VERSION,
      requestedBy: "e2e-host",
      nonce: "e2e-repository-write-lease",
      expiresAt,
      reason: "Delegate the exact end-to-end write Lease capability."
    }), "utf8");
    const leaseCapabilityApproval = await cli(home, "approval", "request", "--file", leaseCapabilityApprovalFile, "--root", root, "--json");
    await cli(home, "approval", "decide", leaseCapabilityApproval.id, "--status", "approved", "--decided-by", "e2e-host", "--reason", "Approved.", "--root", root, "--json");
    const writeLease = await cli(home, "lease", "issue", "--task", "e2e-task", "--agent", "e2e-builder", "--role", "builder", "--capability", "repository-write", "--write-set", "README.md", "--approval", leaseCapabilityApproval.id, "--root", root, "--json");
    const contentFile = path.join(root, "content.txt");
    await writeFile(contentFile, "fixed readme\n", "utf8");
    await cli(home, "write", "apply", "--lease", writeLease.id, "--intent", writeIntent.writeIntentId, "--target", "README.md", "--file", contentFile, "--root", root, "--json");
    expect(await readFile(path.join(root, "README.md"), "utf8")).toBe("fixed readme\n");
    await cli(home, "write", "rollback", writeIntent.writeIntentId, "--reason", "Revert.", "--root", root, "--json");
    expect(await readFile(path.join(root, "README.md"), "utf8")).toBe("original readme\n");
    await cli(home, "plan", "step-done", writePlan.planId, "step-1", "--root", root, "--json");
    await expect(cli(home, "plan", "finish", writePlan.planId, "--root", root, "--json")).resolves.toMatchObject({ status: "COMPLETED" });

    // 5. Audit queries.
    await expect(cli(home, "ledger", "verify", "--root", root, "--json")).resolves.toMatchObject({ valid: true });
    await expect(cli(home, "plan", "list", "--root", root, "--json")).resolves.toHaveLength(2);
    await expect(cli(home, "write", "list", "--root", root, "--json")).resolves.toHaveLength(1);
  }, 60_000);
});
