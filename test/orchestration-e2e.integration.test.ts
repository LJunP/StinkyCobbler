import { execFile } from "node:child_process";
import { mkdtemp, rm, mkdir, writeFile, realpath, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { hashTaskAuthority, TASK_AUTHORITY_POLICY_VERSION } from "../src/storage/task-authority.js";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(import.meta.dirname, "..");
const roots: string[] = [];
const ORCHESTRATION_E2E_TIMEOUT_MS = 90_000;

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function cli(env: NodeJS.ProcessEnv, ...args: string[]): Promise<{ stdout: string }> {
  return execFileAsync(process.execPath, [path.join(projectRoot, "dist/cli.js"), ...args], { cwd: projectRoot, maxBuffer: 4 * 1024 * 1024, env });
}

async function json(env: NodeJS.ProcessEnv, ...args: string[]): Promise<any> {
  return JSON.parse((await cli(env, ...args, "--json")).stdout);
}

async function setupWorkspace(env: NodeJS.ProcessEnv): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "stinky-orch-e2e-")));
  roots.push(root);
  await mkdir(path.join(root, "docs"), { recursive: true });
  await writeFile(path.join(root, "task.json"), JSON.stringify({
    id: "orch-e2e", workspaceId: "ws-e2e", goal: "Docs", requestedOutputs: ["document"],
    riskLevel: "L0", state: "DRAFT", scope: ["docs"], writeSet: ["docs"]
  }), "utf8");
  await cli(env, "init", "--workspace-id", "ws-e2e", "--profile", "team", "--pack", "software-engineering", "--mode", "reviewed-workflow", "--root", root, "--json");
  await cli(env, "task", "create", "--file", path.join(root, "task.json"), "--root", root, "--json");
  await cli(env, "task", "transition", "orch-e2e", "--to", "SCOPED", "--root", root, "--json");
  await cli(env, "task", "transition", "orch-e2e", "--to", "DESIGNED", "--root", root, "--json");
  const designed = await json(env, "task", "show", "orch-e2e", "--root", root);
  const expiresAt = "2099-01-01T00:00:00.000Z";
  const approvalFile = path.join(root, "task-execution-approval.json");
  await writeFile(approvalFile, JSON.stringify({
    taskId: "orch-e2e",
    action: "task-execution",
    scope: ["docs"],
    subjectKind: "task-authority",
    subjectId: "orch-e2e",
    subjectVersion: 1,
    subjectHash: hashTaskAuthority(designed),
    capability: "task-execution",
    budget: { maxToolCalls: 100, expiresAt },
    policyVersion: TASK_AUTHORITY_POLICY_VERSION,
    requestedBy: "orchestration-e2e-host",
    nonce: "orchestration-e2e-task-execution",
    expiresAt,
    reason: "Authorize orchestration CLI integration execution."
  }), "utf8");
  const approval = await json(env, "approval", "request", "--file", approvalFile, "--root", root);
  await json(env, "approval", "decide", approval.id, "--status", "approved", "--decided-by", "orchestration-e2e-host", "--reason", "Approved for CLI integration.", "--root", root);
  await cli(env, "task", "transition", "orch-e2e", "--to", "APPROVED_FOR_EXECUTION", "--approval", approval.id, "--root", root, "--json");
  await cli(env, "task", "transition", "orch-e2e", "--to", "RUNNING", "--root", root, "--json");
  return root;
}

describe("orchestration CLI e2e", () => {
  it("shows and validates all four tiered policy files", { timeout: ORCHESTRATION_E2E_TIMEOUT_MS }, async () => {
    const env = { ...process.env };
    const root = await setupWorkspace(env);
    const shown = await json(env, "orchestration", "config", "show", "--root", root);
    expect(shown.guidanceTemplates.domainConfirmation.prompt).toContain("{domain}");
    expect(shown.contractTemplates).toContain("docs-audit");
    expect(shown.specialists.some((entry: { domain: string }) => entry.domain === "general")).toBe(true);
    expect(shown.userPaths.guidanceTemplates).toBe(path.join(root, ".stinky-cobbler", "policies", "templates.yaml"));

    await writeFile(path.join(root, ".stinky-cobbler", "policies", "orchestration.yaml"), "version: 1\ndefaults:\n  maxDomainInstructions: 1\n", "utf8");
    const crossFileDoctor = await json(env, "doctor", "--root", root);
    expect(crossFileDoctor.configCheck.error).toContain("TIERED_CONFIG_INVALID");
    const crossFileShowError = await cli(env, "orchestration", "config", "show", "--root", root, "--json").catch((error: unknown) => error as { stderr?: string });
    expect("stderr" in crossFileShowError ? crossFileShowError.stderr : "").toContain("TIERED_CONFIG_INVALID");
    await writeFile(path.join(root, ".stinky-cobbler", "policies", "orchestration.yaml"), "version: 1\n", "utf8");

    await writeFile(path.join(root, ".stinky-cobbler", "policies", "templates.yaml"), "version: 1\nreviewStyle: invalid\n", "utf8");
    const doctor = await json(env, "doctor", "--root", root);
    expect(doctor).toMatchObject({ healthy: false, configCheck: { healthy: false } });
    expect(doctor.configCheck.error).toContain("TIERED_CONFIG_INVALID");
    expect(doctor.configCheck.fix).toContain("templates.yaml");
    const showError = await cli(env, "orchestration", "config", "show", "--root", root, "--json").catch((error: unknown) => error as { stderr?: string });
    expect("stderr" in showError ? showError.stderr : "").toContain("TIERED_CONFIG_INVALID");
  });

  it("walks contract → run → subtask → dispatch → artifact → accept → completed", { timeout: ORCHESTRATION_E2E_TIMEOUT_MS }, async () => {
    const env = { ...process.env };
    const root = await setupWorkspace(env);
    const contract = await json(env, "orchestration", "contract", "create", "--task", "orch-e2e", "--domain", "compliance", "--goal", "Produce project docs", "--criteria", "docs exist", "--criteria", "no secrets", "--criteria", "structure correct", "--scope", "docs", "--root", root);
    expect(contract.contract.contractId).toMatch(/^contract-/);

    const created = await json(env, "orchestration", "run", "create", "--contract", contract.contract.contractId, "--root", root);
    expect(created.estimate).toBeDefined(); // budget estimation is shown upfront
    const run = created.run;
    expect(run.runId).toMatch(/^run-/);

    const subtask = await json(env, "orchestration", "subtask", "add", "--run", run.runId, "--goal", "Write docs/guide.md", "--criteria", "docs exist", "--criteria", "no secrets", "--criteria", "structure correct", "--scope", "docs", "--capability", "repository-read", "--root", root);
    expect(subtask.subtaskId).toMatch(/^subtask-/);
    const observedSubtask = await json(env, "orchestration", "subtask", "show", subtask.subtaskId, "--root", root);
    expect(observedSubtask).toMatchObject({ subtaskId: subtask.subtaskId, retriesUsed: 0, status: "PENDING" });

    const dispatched = await json(env, "orchestration", "subtask", "dispatch", "--run", run.runId, "--subtask", subtask.subtaskId, "--agent", "worker-1", "--attempt", "0", "--root", root);
    expect(dispatched.leases.length).toBe(1);
    expect(dispatched.activeAttempt).toBe(0);

    const missingAttempt = await cli(env, "orchestration", "subtask", "begin", "--run", run.runId, "--subtask", subtask.subtaskId, "--root", root, "--json")
      .catch((error: unknown) => error as { stderr?: string });
    expect("stderr" in missingAttempt ? missingAttempt.stderr : "").toContain("--attempt");
    const attempt = String(dispatched.activeAttempt);
    await cli(env, "orchestration", "subtask", "begin", "--run", run.runId, "--subtask", subtask.subtaskId, "--attempt", attempt, "--root", root, "--json");
    await writeFile(path.join(root, "docs", "guide.md"), "# Guide\n", "utf8");
    const artifact = await json(env, "orchestration", "artifact", "report", "--run", run.runId, "--subtask", subtask.subtaskId, "--attempt", attempt, "--path", "docs/guide.md", "--root", root);
    expect(artifact.status).toBe("VERIFIED");
    const reviewFile = path.join(root, "review.json");
    await writeFile(reviewFile, JSON.stringify({
      decision: "ACCEPTED", criteriaResults: ["docs exist", "no secrets", "structure correct"].map((criterion) => ({ criterion, passed: true, note: "verified" })),
      defects: [], score: 90, reason: "all criteria met", validatorEvidence: [{ validator: "contentHash", passed: true, detail: "ok" }], reviewedBy: "host", tokensUsed: 0
    }), "utf8");
    const result = await json(env, "orchestration", "review", "record", "--run", run.runId, "--subtask", subtask.subtaskId, "--attempt", attempt, "--file", reviewFile, "--root", root);
    expect(result.run.status).toBe("RUNNING");
    expect(result.subtask.status).toBe("ACCEPTED");
    const completed = await json(env, "orchestration", "round", "complete", "--run", run.runId, "--passed", "--note", "current outputs remain contract-consistent", "--root", root);
    expect(completed.status).toBe("COMPLETED");

    const status = await json(env, "orchestration", "run", "status", run.runId, "--root", root);
    expect(status.status).toBe("COMPLETED");
  });

  it("escalates on repeated identical defects", { timeout: ORCHESTRATION_E2E_TIMEOUT_MS }, async () => {
    const env = { ...process.env };
    const root = await setupWorkspace(env);
    const contract = await json(env, "orchestration", "contract", "create", "--task", "orch-e2e", "--domain", "content", "--goal", "Docs", "--criteria", "ok", "--criteria", "good", "--criteria", "fine", "--scope", "docs", "--root", root);
    const created = await json(env, "orchestration", "run", "create", "--contract", contract.contract.contractId, "--max-retries", "3", "--root", root);
    const run = created.run;
    const subtask = await json(env, "orchestration", "subtask", "add", "--run", run.runId, "--goal", "Write guide", "--criteria", "good", "--scope", "docs", "--capability", "repository-read", "--max-retries", "3", "--root", root);
    const defect = { location: "docs/guide.md", problem: "same bug", suggestion: "fix" };

    for (let round = 0; round < 2; round++) {
      const current = await json(env, "orchestration", "subtask", "show", subtask.subtaskId, "--root", root);
      expect(current.retriesUsed).toBe(round);
      const dispatched = await json(env, "orchestration", "subtask", "dispatch", "--run", run.runId, "--subtask", subtask.subtaskId, "--agent", "worker-1", "--attempt", String(current.retriesUsed), "--root", root);
      expect(dispatched.activeAttempt).toBe(round);
      if (round === 1) {
        const stale = await cli(env, "orchestration", "subtask", "begin", "--run", run.runId, "--subtask", subtask.subtaskId, "--attempt", "0", "--root", root, "--json")
          .catch((error: unknown) => error as { stderr?: string });
        expect("stderr" in stale ? stale.stderr : "").toContain("SUBTASK_GENERATION_STALE");
      }
      const attempt = String(dispatched.activeAttempt);
      await cli(env, "orchestration", "subtask", "begin", "--run", run.runId, "--subtask", subtask.subtaskId, "--attempt", attempt, "--root", root, "--json");
      await writeFile(path.join(root, "docs", "guide.md"), `v${round}\n`, "utf8");
      await json(env, "orchestration", "artifact", "report", "--run", run.runId, "--subtask", subtask.subtaskId, "--attempt", attempt, "--path", "docs/guide.md", "--root", root);
      const reviewFile = path.join(root, `review-${round}.json`);
      await writeFile(reviewFile, JSON.stringify({
        decision: "REJECTED", criteriaResults: [{ criterion: "good", passed: false, note: "bug" }],
        defects: [defect], score: 40, reason: "defect found", validatorEvidence: [], reviewedBy: "host", tokensUsed: 0
      }), "utf8");
      await json(env, "orchestration", "review", "record", "--run", run.runId, "--subtask", subtask.subtaskId, "--attempt", attempt, "--file", reviewFile, "--root", root);
    }
    const status = await json(env, "orchestration", "run", "status", run.runId, "--root", root);
    expect(status.status).toBe("ESCALATED");
    expect(status.escalationReason).toContain("OSCILLATION");
  });
});
