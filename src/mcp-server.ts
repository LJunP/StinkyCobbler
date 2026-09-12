#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { SchemaRegistry, type ContractKind } from "./contracts/schema-registry.js";
import { loadRegistries } from "./config/registry.js";
import { evaluateLease, evaluateTask } from "./policy/evaluate.js";
import { recommendTask } from "./domain/recommend.js";
import { readRepositoryFile, listRepositoryDirectory } from "./mcp/repo-read.js";
import { writeRepositoryFile, deleteRepositoryFile } from "./mcp/repo-write.js";
import { runGitRead } from "./mcp/git-read.js";
import { buildDocumentationIndex, readDocumentationIndex } from "./mcp/docs-index.js";
import { invokeControlled } from "./mcp/invocation.js";
import { STINKY_COBBLER_VERSION } from "./version.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const server = new McpServer({ name: "stinky-cobbler-local", version: STINKY_COBBLER_VERSION });
const MAX_MCP_MESSAGE_BYTES = 17 * 1024 * 1024;
const MAX_MCP_WRITE_CONTENT_BYTES = 16 * 1024 * 1024;
const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const identityText = z.string().min(1).max(256).regex(/^[^\u0000\r\n]+$/);
const workspacePath = z.string().min(1).max(4096).regex(/^[^\u0000\r\n]+$/);
const relativePath = z.string().min(1).max(512).regex(/^[^\u0000\r\n]+$/);
const writeContent = z.string().max(MAX_MCP_WRITE_CONTENT_BYTES).refine(
  (value) => Buffer.byteLength(value, "utf8") <= MAX_MCP_WRITE_CONTENT_BYTES,
  { message: `content must not exceed ${MAX_MCP_WRITE_CONTENT_BYTES} UTF-8 bytes` }
);
const leaseAccess = z.object({ lease: z.unknown().optional(), leaseId: id.optional(), taskId: id, role: identityText, workspace: workspacePath })
  .refine((value) => value.lease !== undefined || value.leaseId !== undefined, { message: "lease or leaseId is required" });

server.registerTool("validate_contract", { description: "Validate a Stinky Cobbler JSON contract without executing an action.", inputSchema: { kind: z.enum(["task", "artifact", "capsule", "lease", "receipt", "approval", "audit", "config", "profile", "pack", "role", "plugin", "policy-decision", "evidence-ref", "agent-run", "tool-call-record"]), value: z.unknown(), policy: z.boolean().optional() } }, async ({ kind, value, policy }) => { const s = await SchemaRegistry.create(projectRoot); s.validate(kind as ContractKind, value); const d = policy && kind === "task" ? evaluateTask(value as never) : { allowed: true, code: "ALLOWED", reasons: [], policyVersion: "1" }; return text({ valid: d.allowed, decision: d }); });
server.registerTool("resolve_config", { description: "Read and cross-validate built-in governance configuration.", inputSchema: {} }, async () => { const s = await SchemaRegistry.create(projectRoot); const r = await loadRegistries(projectRoot, s); return text({ profiles: [...r.profiles.keys()], packs: [...r.packs.keys()], roles: Object.keys(r.roles.roles), plugins: [...r.pluginDiagnostics.values()], adapters: [{ id: "scripted-readonly", status: "available", runtime: "builtin", implementationRef: "builtin.scripted-readonly", supports: ["repository-read", "repository-list"] }] }); });
server.registerTool("recommend_task", { description: "Recommend a minimum DAG without selecting user choices or executing work.", inputSchema: { task: z.unknown() } }, async ({ task }) => { const s = await SchemaRegistry.create(projectRoot); s.validate("task", task); return text(recommendTask(task as never, (await loadRegistries(projectRoot, s)).packs)); });
server.registerTool("evaluate_lease", { description: "Check a lease without executing a capability.", inputSchema: { lease: z.unknown(), taskId: id, role: identityText, workspace: workspacePath, capability: identityText } }, async ({ lease, taskId, role, workspace, capability }) => { const s = await SchemaRegistry.create(projectRoot); s.validate("lease", lease); return text(evaluateLease(lease as never, { taskId, role, workspace, capability })); });
server.registerTool("repo_read", { description: "Read an explicit non-sensitive workspace file under a lease readScope.", inputSchema: { ...leaseAccess.shape, path: relativePath, maxBytes: z.number().int().min(1).max(262144).optional() } }, async (input) => text(await runControlled(input, "repository-read", "repository-read", (a) => readRepositoryFile(a, input.path, input.maxBytes))));
server.registerTool("repo_list", { description: "List an explicit non-sensitive workspace directory under a lease readScope.", inputSchema: { ...leaseAccess.shape, path: relativePath.optional(), maxEntries: z.number().int().min(1).max(200).optional() } }, async (input) => text(await runControlled(input, "repository-read", "repository-list", (a) => listRepositoryDirectory(a, input.path, input.maxEntries))));
server.registerTool("repo_write", { description: "Apply one CONFIRMED single-target create/modify intent under its persisted L1 repository-write Lease. The intent may be explicitly confirmed or auto-allowed by the supported low-risk flow.", inputSchema: { ...leaseAccess.shape, writeIntentId: id, target: relativePath, content: writeContent } }, async (input) => { const schemas = await SchemaRegistry.create(projectRoot); return text(await invokeControlled(schemas, input, "repository-write", (a) => writeRepositoryFile(a, schemas, { writeIntentId: input.writeIntentId, target: input.target, content: input.content }), undefined, { operation: "repository-write" })); });
server.registerTool("repo_delete", { description: "Apply a user-confirmed delete (writeIntentId + whitelisted target) under a repository-write lease; the file is backed up before removal and rollback-able. Never automatic: requires a confirmed write-confirm Approval and an L1 write lease; deletes are never auto-allowed.", inputSchema: { ...leaseAccess.shape, writeIntentId: id, target: relativePath } }, async (input) => { const schemas = await SchemaRegistry.create(projectRoot); return text(await invokeControlled(schemas, input, "repository-write", (a) => deleteRepositoryFile(a, schemas, { writeIntentId: input.writeIntentId, target: input.target }), undefined, { operation: "repository-delete" })); });
server.registerTool("git_read", { description: "Run a fixed Git read-only operation under an L0 git-read lease.", inputSchema: { ...leaseAccess.shape, operation: z.enum(["status", "log", "diff", "show", "branch"]), revision: z.string().min(1).max(256).regex(/^[^\u0000\r\n]+$/).optional(), path: relativePath.optional(), limit: z.number().int().min(1).max(100).optional() } }, async (input) => text(await runControlled(input, "git-read", "git-read", (a) => runGitRead(a, { operation: input.operation, ...(input.revision === undefined ? {} : { revision: input.revision }), ...(input.path === undefined ? {} : { path: input.path }), ...(input.limit === undefined ? {} : { limit: input.limit }) }))));
server.registerTool("docs_index", { description: "Read or build a bounded local documentation index under a docs-index lease.", inputSchema: { ...leaseAccess.shape, action: z.enum(["build", "read"]), docsPath: relativePath.optional() } }, async (input) => text(await runControlled(input, "docs-index", `docs-index-${input.action}`, (a) => input.action === "build" ? buildDocumentationIndex(a, input.docsPath) : readDocumentationIndex(a))));

async function runControlled(input: z.infer<typeof leaseAccess>, capability: string, operation: string, run: Parameters<typeof invokeControlled>[3]) {
  return invokeControlled(await SchemaRegistry.create(projectRoot), input, capability, run, undefined, { operation });
}
function text(value: unknown) { return { content: [{ type: "text" as const, text: JSON.stringify(value) }] }; }
server.connect(new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: MAX_MCP_MESSAGE_BYTES })).catch((error: unknown) => { console.error("Stinky Cobbler MCP server failed:", error); process.exitCode = 1; });
