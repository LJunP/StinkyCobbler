import { createHash, randomUUID } from "node:crypto";
import type { EvidenceRef, ToolCallRecord } from "../contracts/types.js";
import { readRepositoryFile, listRepositoryDirectory } from "../mcp/repo-read.js";
import type { RepositoryFile } from "../mcp/repo-read.js";
import type { ScriptedToolRequest, RuntimeToolBroker } from "./scripted-readonly.js";

export class ReadonlyToolBroker implements RuntimeToolBroker {
  public async call(request: ScriptedToolRequest, context: Parameters<RuntimeToolBroker["call"]>[1]): Promise<ToolCallRecord> {
    const startedAt = new Date().toISOString();
    const id = `tool-${randomUUID()}`;
    const base = {
      id,
      runId: context.run.runId,
      capsuleId: context.capsule.capsuleId,
      taskId: context.task.id,
      leaseId: context.lease.id,
      agentId: context.capsule.agentId,
      role: context.capsule.role,
      tool: request.tool,
      capability: "repository-read",
      startedAt
    };
    if (context.signal.aborted) return stopped(base, context.signal);
    try {
      const access = {
        lease: { ...context.lease, readScope: context.effectiveReadScope },
        taskId: context.task.id,
        role: context.capsule.role,
        workspace: context.workspace.root
      };
      const outcome = request.tool === "repository-read"
        ? await readRepositoryFile(access, requiredString(request.input.path, "path"), optionalNumber(request.input.maxBytes))
        : request.tool === "repository-list"
          ? await listRepositoryDirectory(access, optionalString(request.input.path) ?? ".", optionalNumber(request.input.maxEntries))
          : undefined;
      if (context.signal.aborted) return stopped(base, context.signal);
      if (!outcome) return blocked(base, "RUNTIME_TOOL_NOT_ALLOWED");
      if (!outcome.decision.allowed) return blocked(base, outcome.decision.code);
      const data = outcome.data;
      if (data === undefined) return blocked(base, "RUNTIME_TOOL_FAILED");
      if (context.signal.aborted) return stopped(base, context.signal);
      const serialized = JSON.stringify(data);
      const evidence: EvidenceRef = {
        id: `evidence-${randomUUID()}`,
        kind: "tool",
        source: request.tool,
        locator: `tool-call:${id}`,
        contentHash: digest(serialized),
        observedAt: new Date().toISOString(),
        sensitivity: "internal",
        toolCallId: id
      };
      const inputBytes = request.tool === "repository-read" && isRepositoryFile(data)
        ? Buffer.byteLength(data.content, "utf8")
        : undefined;
      const fileLocators = request.tool === "repository-read" && isRepositoryFile(data) ? [data.path] : undefined;
      if (context.signal.aborted) return stopped(base, context.signal);
      if (context.recordEvidence !== undefined) {
        try {
          await context.recordEvidence(evidence);
        } catch {
          if (context.signal.aborted) return stopped(base, context.signal);
          return blocked(base, "RUNTIME_EVIDENCE_PERSISTENCE_FAILED");
        }
      }
      if (context.signal.aborted) return stopped(base, context.signal);
      return {
        ...base,
        status: "COMPLETED",
        inputHash: digest(JSON.stringify(request.input)),
        outputHash: evidence.contentHash,
        evidenceRefs: [evidence.id],
        finishedAt: new Date().toISOString(),
        ...(inputBytes === undefined ? {} : { inputBytes }),
        ...(fileLocators === undefined ? {} : { fileLocators }),
        outputBytes: Buffer.byteLength(serialized, "utf8")
      };
    } catch (error: unknown) {
      if (context.signal.aborted) return stopped(base, context.signal);
      const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : "";
      if (code === "RUNTIME_RUN_FENCED" || code.startsWith("EVIDENCE_") || (error instanceof Error && error.message === "RUNTIME_EVIDENCE_PERSISTENCE_FAILED")) return blocked(base, "RUNTIME_EVIDENCE_PERSISTENCE_FAILED");
      return blocked(base, "RUNTIME_TOOL_FAILED");
    }
  }
}

function blocked(base: Omit<ToolCallRecord, "status">, code: string): ToolCallRecord {
  return { ...base, status: "BLOCKED", errorCode: code, finishedAt: new Date().toISOString() };
}
function stopped(base: Omit<ToolCallRecord, "status">, signal: AbortSignal): ToolCallRecord {
  const code = abortCode(signal);
  return { ...base, status: code === "RUNTIME_DEADLINE_EXCEEDED" ? "TIMED_OUT" : "CANCELLED", errorCode: code, finishedAt: new Date().toISOString() };
}
function abortCode(signal: AbortSignal): "RUNTIME_CANCELLED" | "RUNTIME_DEADLINE_EXCEEDED" {
  const reason = signal.reason;
  return typeof reason === "object" && reason !== null && "code" in reason && reason.code === "RUNTIME_DEADLINE_EXCEEDED"
    ? "RUNTIME_DEADLINE_EXCEEDED"
    : "RUNTIME_CANCELLED";
}
function isRepositoryFile(value: RepositoryFile | unknown[]): value is RepositoryFile {
  return typeof value === "object" && value !== null && !Array.isArray(value) && "content" in value && typeof value.content === "string" && "path" in value && typeof value.path === "string";
}
function requiredString(value: unknown, name: string): string { if (typeof value !== "string" || value.length === 0) throw new Error(`Missing ${name}`); return value; }
function optionalString(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
function optionalNumber(value: unknown): number | undefined { return typeof value === "number" ? value : undefined; }
function digest(value: string): string { return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`; }
