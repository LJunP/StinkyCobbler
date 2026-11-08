import { randomUUID } from "node:crypto";
import { hostAdapters } from "../hosts/registry.js";
import { hostMcpEntry, type HostAdapter } from "../hosts/host-adapter.js";
import type { FileOp, ToolkitPlan } from "../core/plan/plan.js";
import { ExitCode, StinkyCobblerError } from "../errors.js";
import { appendToolkitEvent } from "../io/ledger.js";
import { installManagedBytes, readRegularHostFile, relativeHostPath, sha256 } from "../io/managed-file.js";
import { upsertSegment } from "../io/segment-file.js";
import { STINKY_COBBLER_VERSION } from "../version.js";

export interface ApplyReport {
  dryRun: boolean;
  applyId?: string;
  stopped: boolean;
  completed: FileOp[];
  hint?: string;
  error?: { code: string; message: string };
}

interface AppliedHashes {
  beforeHash: string | null;
  afterHash: string;
}

export async function apply(toolkitPlan: ToolkitPlan, options: { dryRun?: boolean; adapters?: readonly HostAdapter[] } = {}): Promise<ApplyReport> {
  if (options.dryRun === true) return { dryRun: true, stopped: false, completed: [...toolkitPlan.ops] };
  const adapters = options.adapters ?? hostAdapters;
  const applyId = randomUUID();
  const completed: FileOp[] = [];
  const written = new Map<string, string>();
  for (const [index, op] of toolkitPlan.ops.entries()) {
    try {
      const hashes = await executeOp(expectingOwnWrites(op, written), adapters);
      written.set(op.path, hashes.afterHash);
      await appendToolkitEvent({
        event: "toolkit-op-applied",
        applyId,
        index,
        action: op.action,
        host: op.host,
        kind: op.kind,
        id: op.id,
        path: op.path,
        ...hashes
      });
      completed.push(op);
    } catch (error: unknown) {
      return { dryRun: false, applyId, stopped: true, completed, hint: "toolkit rollback --last", error: describeError(error) };
    }
  }
  return { dryRun: false, applyId, stopped: false, completed };
}

async function executeOp(op: FileOp, adapters: readonly HostAdapter[]): Promise<AppliedHashes> {
  if (op.action === "merge-mcp" || op.action === "replace-mcp") return applyMcp(op, adapters);
  if (op.action === "upsert-segment") return applySegment(op);
  return applyBytes(op);
}

async function applyBytes(op: FileOp): Promise<AppliedHashes> {
  if (op.bytes === undefined) throw applyError("TOOLKIT_OP_INVALID", "File op is missing bytes.");
  const beforeHash = assertPriorHash(op, await readRegularHostFile(op.path));
  await installManagedBytes(op.path, op.bytes, STINKY_COBBLER_VERSION, STINKY_COBBLER_VERSION);
  return { beforeHash, afterHash: sha256(op.bytes) };
}

async function applySegment(op: FileOp): Promise<AppliedHashes> {
  if (op.segment === undefined) throw applyError("TOOLKIT_OP_INVALID", "Segment op is missing its body.");
  const existing = await readRegularHostFile(op.path);
  const beforeHash = assertPriorHash(op, existing);
  const next = upsertSegment(existing ?? "", op.id, segmentBody(op.segment, op.id));
  await installManagedBytes(op.path, next, STINKY_COBBLER_VERSION, STINKY_COBBLER_VERSION);
  return { beforeHash, afterHash: sha256(next) };
}

async function applyMcp(op: FileOp, adapters: readonly HostAdapter[]): Promise<AppliedHashes> {
  if (op.mcpEntry === undefined) throw applyError("TOOLKIT_OP_INVALID", "MCP op is missing its entry.");
  const adapter = adapters.find((item) => item.id === op.host);
  if (adapter === undefined) throw applyError("TOOLKIT_HOST_UNKNOWN", `host must be one of: ${hostAdapters.map((item) => item.id).join(", ")}.`);
  const existing = await readRegularHostFile(op.path);
  const beforeHash = assertPriorHash(op, existing);
  const entry = hostMcpEntry(adapter, op.mcpEntry);
  const merged = op.action === "replace-mcp" ? adapter.replaceMcp(existing ?? "", op.id, entry) : adapter.mergeMcp(existing ?? "", op.id, entry);
  if (merged.status !== "merged" && merged.status !== "unchanged") {
    throw applyError("TOOLKIT_MCP_CONFLICT", `MCP merge for ${op.id} returned ${merged.status}.`);
  }
  await installManagedBytes(op.path, merged.text, STINKY_COBBLER_VERSION, STINKY_COBBLER_VERSION);
  return { beforeHash, afterHash: sha256(merged.text) };
}

function segmentBody(segment: string, id: string): string {
  const begin = `<!-- stinky-cobbler:begin ${id} -->\n`;
  const end = `<!-- stinky-cobbler:end ${id} -->`;
  if (!segment.startsWith(begin) || !segment.endsWith(end)) throw applyError("TOOLKIT_OP_INVALID", "Segment op is missing its markers.");
  return segment.slice(begin.length, segment.length - end.length);
}

/**
 * Several ops can target one file (two MCP servers in one config, two segments in one CLAUDE.md).
 * They were all planned against the same bytes, so after this apply writes the file, the next op
 * expects the hash this apply produced rather than the one from planning.
 */
function expectingOwnWrites(op: FileOp, written: ReadonlyMap<string, string>): FileOp {
  const own = written.get(op.path);
  return op.priorHash === undefined || own === undefined ? op : { ...op, priorHash: own };
}

/**
 * An op planned against a managed file carries that file's hash. If the bytes changed between plan
 * and write, the op stops instead of overwriting what someone just typed.
 */
function assertPriorHash(op: FileOp, existing: string | undefined): string | null {
  const beforeHash = existing === undefined ? null : sha256(existing);
  if (op.priorHash !== undefined && beforeHash !== op.priorHash) {
    throw new StinkyCobblerError("TOOLKIT_CONFLICT", ExitCode.CONFLICT, `${relativeHostPath(op.path)} changed after it was planned.`, { path: relativeHostPath(op.path) });
  }
  return beforeHash;
}

function describeError(error: unknown): { code: string; message: string } {
  if (error instanceof StinkyCobblerError) return { code: error.code, message: error.message };
  const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : "TOOLKIT_APPLY_FAILED";
  const message = error instanceof Error ? error.message : "Toolkit apply failed.";
  return { code, message };
}

function applyError(code: string, message: string): StinkyCobblerError {
  return new StinkyCobblerError(code, ExitCode.VALIDATION, message);
}
