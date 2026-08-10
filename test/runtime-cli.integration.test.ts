import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(import.meta.dirname, "..");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function cli(...args: string[]): Promise<Record<string, any>> {
  const result = await execFileAsync(process.execPath, [path.join(projectRoot, "dist/cli.js"), ...args], {
    cwd: projectRoot,
    maxBuffer: 1024 * 1024
  });
  return JSON.parse(result.stdout) as Record<string, any>;
}

describe("Runtime CLI black-box", () => {
  it("validates, runs, and shows an explicit scripted-readonly run", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "stinky-runtime-cli-")));
    roots.push(root);
    await cli("init", "--workspace-id", "runtime-cli", "--profile", "team", "--pack", "software-engineering", "--mode", "reviewed-workflow", "--root", root, "--json");
    await writeFile(path.join(root, "README.md"), "runtime CLI evidence\n", "utf8");

    const task = {
      id: "runtime-cli-task",
      workspaceId: "runtime-cli",
      goal: "Read the README",
      requestedOutputs: ["report"],
      riskLevel: "L0",
      state: "DRAFT"
    };
    const taskFile = path.join(root, "task.json");
    await writeFile(taskFile, JSON.stringify(task));
    await cli("task", "create", "--file", taskFile, "--root", root, "--json");
    await cli("task", "transition", "runtime-cli-task", "--to", "SCOPED", "--root", root, "--json");

    const canonicalRoot = root;
    const lease = {
      id: "runtime-cli-lease",
      taskId: "runtime-cli-task",
      agentId: "runtime-cli-agent",
      role: "scout",
      capability: "repository-read",
      level: "L0",
      workspace: canonicalRoot,
      readScope: ["."],
      writeSet: [],
      issuedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
      maxToolCalls: 2,
      status: "active"
    };
    const capsule = {
      version: 1,
      capsuleId: "runtime-cli-capsule",
      runId: "runtime-cli-run",
      taskId: "runtime-cli-task",
      agentId: "runtime-cli-agent",
      role: "scout",
      workspaceId: "runtime-cli",
      leaseId: "runtime-cli-lease",
      policyVersion: "1",
      goal: "Read the README",
      scope: ["README.md"],
      readScope: ["."],
      nonGoals: [],
      facts: [],
      decisions: [],
      unknowns: [],
      allowedTools: ["repository-read"],
      writeSet: [],
      outputSchema: ["receipt"],
      budget: { maxToolCalls: 1, maxBytes: 4096 },
      issuedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z"
    };
    const leaseFile = path.join(root, "lease.json");
    const capsuleFile = path.join(root, "capsule.json");
    const requestsFile = path.join(root, "requests.json");
    await writeFile(leaseFile, JSON.stringify(lease));
    await writeFile(capsuleFile, JSON.stringify(capsule));
    await writeFile(requestsFile, JSON.stringify([{ tool: "repository-read", input: { path: "README.md" } }]));
    await writeFile(taskFile, JSON.stringify({ ...task, state: "SCOPED" }));

    await expect(cli("runtime", "validate", "--task", taskFile, "--capsule", capsuleFile, "--lease", leaseFile, "--root", root, "--json")).resolves.toMatchObject({
      valid: true,
      runId: "runtime-cli-run",
      executionAuthorized: false
    });
    await expect(cli("runtime", "run", "--task", taskFile, "--capsule", capsuleFile, "--lease", leaseFile, "--script", requestsFile, "--executor", "host-injected", "--root", root, "--json")).rejects.toMatchObject({ code: 2 });
    const result = await cli("runtime", "run", "--task", taskFile, "--capsule", capsuleFile, "--lease", leaseFile, "--script", requestsFile, "--executor", "scripted-readonly", "--root", root, "--json");
    expect(result.run).toMatchObject({ runId: "runtime-cli-run", status: "COMPLETED", executor: "scripted-readonly" });
    expect(result.receipt).toMatchObject({ taskId: "runtime-cli-task", changedPaths: [] });
    const evidence = await cli("evidence", "list", "--root", root, "--json");
    expect(evidence).toHaveLength(1);
    await expect(cli("evidence", "show", evidence[0].id, "--root", root, "--json")).resolves.toMatchObject({ id: evidence[0].id, toolCallId: result.run.toolCalls[0].id });
    await expect(cli("evidence", "inspect", evidence[0].id, "--root", root, "--json")).resolves.toMatchObject({ valid: true });

    await expect(cli("runtime", "show", "runtime-cli-run", "--root", root, "--json")).resolves.toMatchObject({
      runId: "runtime-cli-run",
      status: "COMPLETED"
    });
    await expect(cli("runtime", "reconcile", "runtime-cli-run", "--root", root, "--json")).resolves.toMatchObject({
      run: { runId: "runtime-cli-run" },
      terminal: true,
      receipts: [expect.objectContaining({ runId: "runtime-cli-run" })],
      issues: []
    });
    const storedTask = JSON.parse(await readFile(path.join(root, ".stinky-cobbler", "task-runtime-cli-task.json"), "utf8")) as { state: string };
    expect(storedTask.state).toBe("SCOPED");
  }, 30_000);
});
