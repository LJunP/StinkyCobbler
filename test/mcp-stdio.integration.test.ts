import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { STINKY_COBBLER_VERSION } from "../src/version.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(import.meta.dirname, "..");
const transports: StdioClientTransport[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(transports.splice(0).map((transport) => transport.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function connect() {
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(projectRoot, "dist/mcp-server.js")], cwd: projectRoot, stderr: "pipe" });
  const client = new Client({ name: "stinky-cobbler-blackbox-test", version: STINKY_COBBLER_VERSION });
  await client.connect(transport);
  transports.push(transport);
  return client;
}

async function createInitializedWorkspace(): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "stinky-mcp-stdio-")));
  roots.push(root);
  await runCli("init", "--workspace-id", "stdio-test", "--profile", "team", "--pack", "software-engineering", "--mode", "reviewed-workflow", "--root", root, "--json");
  const taskFile = path.join(root, "task-input.json");
  await writeFile(taskFile, JSON.stringify({
    id: "stdio-task",
    workspaceId: "stdio-test",
    goal: "Exercise the real MCP stdio transport.",
    requestedOutputs: ["test-report"],
    riskLevel: "L0",
    state: "DRAFT"
  }));
  try {
    await runCli("task", "create", "--file", taskFile, "--root", root, "--json");
  } finally {
    await rm(taskFile, { force: true });
  }
  return root;
}

async function runCli(...args: string[]): Promise<void> {
  await execFileAsync(process.execPath, [path.join(projectRoot, "dist/cli.js"), ...args], { cwd: projectRoot, maxBuffer: 1024 * 1024 });
}

function repositoryLease(workspace: string, overrides: Record<string, unknown> = {}) {
  return {
    id: "repo-lease",
    taskId: "stdio-task",
    agentId: "stdio-agent",
    role: "scout",
    capability: "repository-read",
    level: "L0",
    workspace,
    readScope: ["."],
    writeSet: [],
    issuedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
    maxToolCalls: 5,
    status: "active",
    ...overrides
  };
}

function docsLease(workspace: string, overrides: Record<string, unknown> = {}) {
  return repositoryLease(workspace, {
    id: "docs-lease",
    capability: "docs-index",
    level: "L1",
    readScope: ["docs"],
    writeSet: [".stinky-cobbler/docs-index.json"],
    maxToolCalls: 5,
    ...overrides
  });
}

async function callJson(client: Client, name: string, args: Record<string, unknown>): Promise<Record<string, any>> {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content.find((item) => item.type === "text");
  expect(text?.type).toBe("text");
  return JSON.parse((text as { text: string }).text) as Record<string, any>;
}

async function readUsage(workspace: string): Promise<Record<string, number>> {
  try {
    return JSON.parse(await readFile(path.join(workspace, ".stinky-cobbler", "lease-usage.json"), "utf8")) as Record<string, number>;
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return {};
    throw error;
  }
}

async function readLedger(workspace: string): Promise<Array<Record<string, any>>> {
  const contents = await readFile(path.join(workspace, ".stinky-cobbler", "ledger.jsonl"), "utf8");
  return contents.trim().split("\n").map((line) => JSON.parse(line) as Record<string, any>);
}

async function readReceipts(workspace: string): Promise<Array<Record<string, any>>> {
  const directory = path.join(workspace, ".stinky-cobbler", "receipts");
  const names = await readdir(directory);
  return Promise.all(names.filter((name) => name.endsWith(".json")).map(async (name) => JSON.parse(await readFile(path.join(directory, name), "utf8")) as Record<string, any>));
}

describe("MCP stdio black-box", () => {
  it("handshakes, exposes controlled tools, and keeps test-run unregistered", async () => {
    const client = await connect();
    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name);
    expect(names).toContain("resolve_config");
    expect(names).toContain("repo_read");
    expect(names).toContain("docs_index");
    expect(names).not.toContain("test_run");
    expect(names).not.toContain("test-run");
  }, 30_000);

  it("calls a no-side-effect governance tool over real stdio", async () => {
    const client = await connect();
    const result = await client.callTool({ name: "resolve_config", arguments: {} });
    const text = result.content.find((item) => item.type === "text");
    expect(text?.type).toBe("text");
    const parsed = JSON.parse((text as { text: string }).text) as { profiles: string[]; packs: string[] };
    expect(parsed.profiles).toContain("team");
    expect(parsed.packs).toContain("software-engineering");
    expect(parsed.plugins).toContainEqual(expect.objectContaining({ id: "repository-read", executable: true }));
    expect(parsed.plugins).toContainEqual(expect.objectContaining({ id: "web-research", executable: false }));
    expect(parsed.adapters).toContainEqual(expect.objectContaining({ id: "scripted-readonly", status: "available" }));
  }, 30_000);

  it("reads a file from an initialized temporary workspace and records receipt and ledger events", async () => {
    const workspace = await createInitializedWorkspace();
    await writeFile(path.join(workspace, "README.md"), "stdio repository content\n");
    const client = await connect();

    const result = await callJson(client, "repo_read", {
      lease: repositoryLease(workspace),
      taskId: "stdio-task",
      role: "scout",
      workspace,
      path: "README.md"
    });

    expect(result).toMatchObject({
      decision: { allowed: true, code: "ALLOWED" },
      data: { path: "README.md", content: "stdio repository content\n" }
    });

    const receipts = await readReceipts(workspace);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ taskId: "stdio-task", role: "scout", status: "COMPLETED" });

    const ledger = await readLedger(workspace);
    expect(ledger.map((entry) => entry.event)).toEqual(["workspace-initialized", "task-created", "receipt-recorded", "mcp-call"]);
    expect(ledger.at(-1)).toMatchObject({ event: "mcp-call", taskId: "stdio-task", role: "scout", tool: "repository-read", receiptRef: receipts[0]?.id });
  }, 30_000);

  it("rejects expired and malformed leases without increasing lease usage", async () => {
    const workspace = await createInitializedWorkspace();
    await writeFile(path.join(workspace, "README.md"), "should not be read\n");
    const client = await connect();

    const expired = await callJson(client, "repo_read", {
      lease: repositoryLease(workspace, { id: "expired-lease", expiresAt: "2020-01-01T00:00:00.000Z" }),
      taskId: "stdio-task",
      role: "scout",
      workspace,
      path: "README.md"
    });
    expect(expired).toMatchObject({ decision: { allowed: false, code: "LEASE_EXPIRED" } });

    const malformed = await callJson(client, "repo_read", {
      lease: { id: "malformed-lease" },
      taskId: "stdio-task",
      role: "scout",
      workspace,
      path: "README.md"
    });
    expect(malformed).toMatchObject({ decision: { allowed: false, code: "LEASE_INVALID" } });

    expect(await readUsage(workspace)).toEqual({});
  }, 30_000);

  it("enforces maxToolCalls over stdio after the first repository read", async () => {
    const workspace = await createInitializedWorkspace();
    await writeFile(path.join(workspace, "README.md"), "one allowed read\n");
    const client = await connect();
    const lease = repositoryLease(workspace, { id: "one-call-lease", maxToolCalls: 1 });
    const args = { lease, taskId: "stdio-task", role: "scout", workspace, path: "README.md" };

    await expect(callJson(client, "repo_read", args)).resolves.toMatchObject({ decision: { allowed: true, code: "ALLOWED" } });
    const second = await callJson(client, "repo_read", args);

    expect(second).toMatchObject({ decision: { allowed: false, code: "LEASE_CALL_LIMIT" } });
    expect(await readUsage(workspace)).toEqual({ "one-call-lease": 1 });
  }, 30_000);

  it("builds and reads docs-index within scope, rejects an out-of-scope read, and preserves the prior index on budget failure", async () => {
    const workspace = await createInitializedWorkspace();
    await mkdir(path.join(workspace, "docs"));
    await writeFile(path.join(workspace, "docs", "guide.md"), "# Guide\n");
    await writeFile(path.join(workspace, "docs", "notes.txt"), "Notes\n");
    const client = await connect();
    const lease = docsLease(workspace);
    const common = { taskId: "stdio-task", role: "scout", workspace, lease };

    const built = await callJson(client, "docs_index", { ...common, action: "build", docsPath: "docs" });
    expect(built).toMatchObject({
      decision: { allowed: true, code: "ALLOWED" },
      data: { version: 1, documents: [{ path: "docs/guide.md", title: "Guide" }, { path: "docs/notes.txt", title: "notes.txt" }] }
    });

    const read = await callJson(client, "docs_index", { ...common, action: "read" });
    expect(read).toMatchObject({ decision: { allowed: true, code: "ALLOWED" }, data: { documents: built.data?.documents } });
    const indexPath = path.join(workspace, ".stinky-cobbler", "docs-index.json");
    const previousIndex = await readFile(indexPath, "utf8");

    const outOfScope = await callJson(client, "docs_index", {
      ...common,
      lease: docsLease(workspace, { id: "docs-out-of-scope", readScope: ["src"] }),
      action: "read"
    });
    expect(outOfScope).toMatchObject({ decision: { allowed: false, code: "INVOCATION_FAILED" } });

    await writeFile(path.join(workspace, "docs", "too-large.md"), "x".repeat(64 * 1024 + 1));
    const overBudget = await callJson(client, "docs_index", { ...common, action: "build", docsPath: "docs" });
    expect(overBudget).toMatchObject({ decision: { allowed: false, code: "INVOCATION_FAILED" } });
    expect(await readFile(indexPath, "utf8")).toBe(previousIndex);
    expect(await readUsage(workspace)).toEqual({ "docs-lease": 3, "docs-out-of-scope": 1 });
  }, 30_000);
});
