import type { SchemaRegistry } from "../contracts/schema-registry.js";
import { authorize, denied, type ToolAccess, type ToolOutcome } from "./shared.js";
import { targetInWriteSet } from "../policy/path-policy.js";
import { getWriteIntent } from "../storage/write-intents.js";
import { applyWrite, applyDelete } from "../storage/writes.js";
import { openWorkspace } from "../storage/workspace.js";

export interface WriteRepositoryFileRequest {
  writeIntentId: string;
  target: string;
  content: string;
}

export interface WriteRepositoryFileResult {
  evidenceId: string;
  target: string;
  backupPath?: string;
}

export interface DeleteRepositoryFileRequest {
  writeIntentId: string;
  target: string;
}

export interface DeleteRepositoryFileResult {
  evidenceId: string;
  target: string;
  backupPath: string;
}

/** Authorizes a repository-write lease, then applies a confirmed write. */
export async function writeRepositoryFile(access: ToolAccess, schemas: SchemaRegistry, request: WriteRepositoryFileRequest): Promise<ToolOutcome<WriteRepositoryFileResult>> {
  const decision = authorize(access, "repository-write");
  if (!decision.allowed) return denied(decision);
  if (!targetInWriteSet(access.lease.writeSet, request.target)) {
    return denied({ allowed: false, code: "WRITE_TARGET_NOT_IN_LEASE", reasons: ["Target is outside the write lease writeSet."], policyVersion: "1" });
  }
  const workspace = await openWorkspace(access.workspace);
  const intent = await getWriteIntent(workspace, request.writeIntentId);
  const result = await applyWrite(workspace, schemas, access.lease, intent, request.target, request.content);
  return { decision, data: result };
}

/** Authorizes a repository-write lease, then applies a confirmed delete (backed up, rollback-able). */
export async function deleteRepositoryFile(access: ToolAccess, schemas: SchemaRegistry, request: DeleteRepositoryFileRequest): Promise<ToolOutcome<DeleteRepositoryFileResult>> {
  const decision = authorize(access, "repository-write");
  if (!decision.allowed) return denied(decision);
  if (!targetInWriteSet(access.lease.writeSet, request.target)) {
    return denied({ allowed: false, code: "WRITE_TARGET_NOT_IN_LEASE", reasons: ["Target is outside the write lease writeSet."], policyVersion: "1" });
  }
  const workspace = await openWorkspace(access.workspace);
  const intent = await getWriteIntent(workspace, request.writeIntentId);
  const result = await applyDelete(workspace, schemas, access.lease, intent, request.target);
  return { decision, data: result };
}
