import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { defaultSchemaRegistry } from "../contracts/default-schema-registry.js";
import type { LocalWorkspace } from "./workspace.js";
import { workspaceFile, writeWorkspaceJson } from "./workspace.js";

// Keep cancellation markers outside the run-record directory.  Run discovery
// intentionally scans every `run-*.json` file under `orchestration/`; storing a
// sidecar there would make the marker look like a malformed run record.
const DIRECTORY = "orchestration-cancellations";

export interface RunCancellationFence {
  version: 1;
  runId: string;
  status: "CANCELLING" | "CANCELLED";
  requestedAt: string;
  completedAt?: string;
}

/**
 * Durable, fail-closed cancellation marker. It is deliberately stored outside
 * the public Run v1 schema so a patch release can fence execution without
 * making older readers reject otherwise valid run records.
 */
export async function getRunCancellationFence(workspace: LocalWorkspace, runId: string): Promise<RunCancellationFence | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(await workspaceFile(workspace, fileName(runId)), "utf8"));
    (await defaultSchemaRegistry()).validate("cancellation-fence", value);
    return validateFenceSemantics(value as RunCancellationFence, runId);
  } catch (error: unknown) {
    if (isCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

export async function beginRunCancellation(workspace: LocalWorkspace, runId: string): Promise<RunCancellationFence> {
  const current = await getRunCancellationFence(workspace, runId);
  if (current !== undefined) return current;
  const fence: RunCancellationFence = { version: 1, runId, status: "CANCELLING", requestedAt: new Date().toISOString() };
  (await defaultSchemaRegistry()).validate("cancellation-fence", fence);
  await mkdir(await workspaceFile(workspace, DIRECTORY), { recursive: true, mode: 0o700 });
  await writeWorkspaceJson(workspace, fileName(runId), fence);
  return fence;
}

export async function completeRunCancellation(workspace: LocalWorkspace, runId: string): Promise<RunCancellationFence> {
  const current = await getRunCancellationFence(workspace, runId);
  const next: RunCancellationFence = {
    version: 1,
    runId,
    status: "CANCELLED",
    requestedAt: current?.requestedAt ?? new Date().toISOString(),
    completedAt: current?.completedAt ?? new Date().toISOString()
  };
  (await defaultSchemaRegistry()).validate("cancellation-fence", next);
  await mkdir(await workspaceFile(workspace, DIRECTORY), { recursive: true, mode: 0o700 });
  await writeWorkspaceJson(workspace, fileName(runId), next);
  return next;
}

function fileName(runId: string): string {
  if (typeof runId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)) throw new Error("Invalid orchestration run id.");
  return path.join(DIRECTORY, `${runId}.cancellation.json`);
}

function validateFenceSemantics(value: RunCancellationFence, expectedRunId: string): RunCancellationFence {
  if (value.runId !== expectedRunId) throw new Error("Stored orchestration cancellation fence does not match its filename run ID.");
  if (value.status === "CANCELLED" && value.completedAt! < value.requestedAt) {
    throw new Error("Stored orchestration cancellation fence completion precedes its request.");
  }
  return value;
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
