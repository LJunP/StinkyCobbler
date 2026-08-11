import { execFile } from "node:child_process";
import { mkdtemp, rm, mkdir, writeFile, realpath, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(import.meta.dirname, "..");
const roots: string[] = [];

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
  await writeFile(path.join(root, "task.json"), JSON.stringify({ id: "orch-e2e", workspaceId: "ws-e2e", goal: "Docs", requestedOutputs: ["document"], riskLevel: "L0", state: "DRAFT" }), "utf8");
  await cli(env, "init", "--workspace-id", "ws-e2e", "--profile", "team", "--pack", "software-engineering", "--mode", "reviewed-workflow", "--root", root, "--json");
  await cli(env, "task", "create", "--file", path.join(root, "task.json"), "--root", root, "--json");
  return root;
}

describe("orchestration CLI e2e", () => {
  it("walks contract → run → subtask → dispatch → artifact → accept → completed", async () => {
    const env = { ...process.env };
    const root = await setupWorkspace(env);
    const contract = await json(env, "orchestration", "contract", "create", "--task", "orch-e2e", "--goal", "Produce project docs", "--criteria", "docs exist", "--criteria", "no secrets", "--criteria", "structure correct", "--scope", "docs", "--root", root);
    expect(contract.contract.contractId).toMatch(/^contract-/);

    const created = await json(env, "orchestration", "run", "create", "--contract", contract.contract.contractId, "--root", root);
    expect(created.estimate).toBeDefined(); // budget estimation is shown upfront
    const run = created.run;
    expect(run.runId).toMatch(/^run-/);

    const subtask = await json(env, "orchestration", "subtask", "add", "--run", run.runId, "--goal", "Write docs/guide.md", "--criteria", "guide exists", "--scope", "docs", "--capability", "repository-read", "--root", root);
    expect(subtask.subtaskId).toMatch(/^subtask-/);

    const dispatched = await json(env, "orchestration", "subtask", "dispatch", "--run", run.runId, "--subtask", subtask.subtaskId, "--agent", "worker-1", "--root", root);
    expect(dispatched.leases.length).toBe(1);

    await cli(env, "orchestration", "subtask", "begin", "--run", run.runId, "--subtask", subtask.subtaskId, "--root", root, "--json");
    await writeFile(path.join(root, "docs", "guide.md"), "# Guide\n", "utf8");
    const artifact = await json(env, "orchestration", "artifact", "report", "--run", run.runId, "--subtask", subtask.subtaskId, "--path", "docs/guide.md", "--root", root);
    expect(artifact.status).toBe("VERIFIED");

    const reviewFile = path.join(root, "review.json");
    await writeFile(reviewFile, JSON.stringify({
      decision: "ACCEPTED", criteriaResults: [{ criterion: "guide exists", passed: true, note: "file present" }],
      defects: [], score: 90, reason: "all criteria met", validatorEvidence: [{ validator: "contentHash", passed: true, detail: "ok" }], reviewedBy: "host"
    }), "utf8");
    const result = await json(env, "orchestration", "review", "record", "--run", run.runId, "--subtask", subtask.subtaskId, "--file", reviewFile, "--root", root);
    expect(result.run.status).toBe("COMPLETED");
    expect(result.subtask.status).toBe("ACCEPTED");

    const status = await json(env, "orchestration", "run", "status", run.runId, "--root", root);
    expect(status.status).toBe("COMPLETED");
  });

  it("escalates on repeated identical defects", async () => {
    const env = { ...process.env };
    const root = await setupWorkspace(env);
    const contract = await json(env, "orchestration", "contract", "create", "--task", "orch-e2e", "--goal", "Docs", "--criteria", "ok", "--criteria", "good", "--criteria", "fine", "--scope", "docs", "--root", root);
    const created = await json(env, "orchestration", "run", "create", "--contract", contract.contract.contractId, "--root", root);
    const run = created.run;
    const subtask = await json(env, "orchestration", "subtask", "add", "--run", run.runId, "--goal", "Write guide", "--criteria", "good", "--scope", "docs", "--capability", "repository-read", "--max-retries", "5", "--root", root);
    const defect = { location: "docs/guide.md", problem: "same bug", suggestion: "fix" };

    for (let round = 0; round < 2; round++) {
      await json(env, "orchestration", "subtask", "dispatch", "--run", run.runId, "--subtask", subtask.subtaskId, "--agent", "worker-1", "--root", root);
      await cli(env, "orchestration", "subtask", "begin", "--run", run.runId, "--subtask", subtask.subtaskId, "--root", root, "--json");
      await writeFile(path.join(root, "docs", "guide.md"), `v${round}\n`, "utf8");
      await json(env, "orchestration", "artifact", "report", "--run", run.runId, "--subtask", subtask.subtaskId, "--path", "docs/guide.md", "--root", root);
      const reviewFile = path.join(root, `review-${round}.json`);
      await writeFile(reviewFile, JSON.stringify({
        decision: "REJECTED", criteriaResults: [{ criterion: "good", passed: false, note: "bug" }],
        defects: [defect], score: 40, reason: "defect found", validatorEvidence: [], reviewedBy: "host"
      }), "utf8");
      await json(env, "orchestration", "review", "record", "--run", run.runId, "--subtask", subtask.subtaskId, "--file", reviewFile, "--root", root);
    }
    const status = await json(env, "orchestration", "run", "status", run.runId, "--root", root);
    expect(status.status).toBe("ESCALATED");
    expect(status.escalationReason).toContain("OSCILLATION");
  });
});
