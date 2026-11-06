import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const projectRoot = path.resolve(import.meta.dirname, "..");
const gateRoot = path.join(projectRoot, "src", "gate");

// ADR-0002 freezes src/gate; baseline is the 2026-11-05 non-empty (trim) line count. Lower it after a shrink.
const GATE_NONEMPTY_LINE_BASELINE = 14045;

const GATE_TS_FILES = [
  "src/gate/domain/recommend.ts",
  "src/gate/domain/task-state.ts",
  "src/gate/mcp/docs-index.ts",
  "src/gate/mcp/git-read.ts",
  "src/gate/mcp/invocation.ts",
  "src/gate/mcp/repo-read.ts",
  "src/gate/mcp/repo-write.ts",
  "src/gate/mcp/shared.ts",
  "src/gate/policy/approval.ts",
  "src/gate/policy/evaluate.ts",
  "src/gate/policy/orchestration-constraints.ts",
  "src/gate/policy/path-policy.ts",
  "src/gate/policy/role-tools.ts",
  "src/gate/runtime/adapters.ts",
  "src/gate/runtime/admission.ts",
  "src/gate/runtime/budget.ts",
  "src/gate/runtime/execution-request.ts",
  "src/gate/runtime/scripted-readonly.ts",
  "src/gate/runtime/service.ts",
  "src/gate/runtime/tool-broker.ts",
  "src/gate/storage/approvals.ts",
  "src/gate/storage/audit-outbox.ts",
  "src/gate/storage/audit-service.ts",
  "src/gate/storage/contract-templates.ts",
  "src/gate/storage/docs-index.ts",
  "src/gate/storage/durability.ts",
  "src/gate/storage/evidence.ts",
  "src/gate/storage/lease-usage.ts",
  "src/gate/storage/leases.ts",
  "src/gate/storage/ledger.ts",
  "src/gate/storage/orchestration-fence.ts",
  "src/gate/storage/orchestration-transactions.ts",
  "src/gate/storage/orchestration-validator-receipts.ts",
  "src/gate/storage/orchestration.ts",
  "src/gate/storage/plans.ts",
  "src/gate/storage/receipts.ts",
  "src/gate/storage/runs.ts",
  "src/gate/storage/runtime-diagnostics.ts",
  "src/gate/storage/runtime-finalization.ts",
  "src/gate/storage/runtime-reconciliation.ts",
  "src/gate/storage/specialists.ts",
  "src/gate/storage/task-authority.ts",
  "src/gate/storage/task-transitions.ts",
  "src/gate/storage/tasks.ts",
  "src/gate/storage/workspace-lock.ts",
  "src/gate/storage/workspace.ts",
  "src/gate/storage/write-intents.ts",
  "src/gate/storage/writes.ts"
];

const FROZEN_MESSAGE = [
  "src/gate is frozen per ADR-0002; shrinking is fine and the baseline should then be lowered.",
  "Do not add *.ts files or non-empty lines under src/gate.",
  "After a shrink, set GATE_NONEMPTY_LINE_BASELINE to the new non-empty line count and drop deleted paths from GATE_TS_FILES.",
  "See docs/adr/0002-pivot-to-agent-toolkit-package-manager.md."
].join(" ");

function repoRelativeGatePath(entry: string): string {
  const pieces = entry.split(/[/\\]/).filter((part) => part.length > 0);
  return ["src", "gate", ...pieces].join("/");
}

function countNonEmptyLines(source: string): number {
  let count = 0;
  for (const line of source.split(/\r?\n/)) {
    if (line.trim().length > 0) count += 1;
  }
  return count;
}

async function gateTypeScriptFiles(): Promise<string[]> {
  const entries = await readdir(gateRoot, { recursive: true });
  return entries
    .map((entry) => repoRelativeGatePath(String(entry)))
    .filter((file) => file.endsWith(".ts"))
    .sort();
}

describe("src/gate freeze", () => {
  it("stays within the ADR-0002 file list and non-empty line baseline", async () => {
    const actual = await gateTypeScriptFiles();
    const allowed = new Set(GATE_TS_FILES);
    const added = actual.filter((file) => !allowed.has(file));
    let lines = 0;
    for (const file of actual) {
      lines += countNonEmptyLines(await readFile(path.join(projectRoot, file), "utf8"));
    }
    expect(added, FROZEN_MESSAGE).toEqual([]);
    expect(lines, `${FROZEN_MESSAGE} Counted ${lines} non-empty lines; baseline is ${GATE_NONEMPTY_LINE_BASELINE}.`).toBeLessThanOrEqual(
      GATE_NONEMPTY_LINE_BASELINE
    );
  });
});
