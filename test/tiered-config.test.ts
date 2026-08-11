import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SchemaRegistry } from "../src/contracts/schema-registry.js";
import { createTask } from "../src/storage/tasks.js";
import { initWorkspace } from "../src/storage/workspace.js";
import { loadOrchestrationConfig, loadTieredYaml } from "../src/config/tiered.js";
import {
  createContract, createRun, addSubtask, reportArtifact, recordReview, completeRound, dispatchSubtask, beginSubtask
} from "../src/storage/orchestration.js";
import { listSpecialists } from "../src/storage/specialists.js";
import { getContractTemplate, listContractTemplates } from "../src/storage/contract-templates.js";
import { requestWrites } from "../src/storage/write-intents.js";
import { StinkyCobblerError } from "../src/errors.js";

const roots: string[] = [];
const projectRoot = path.resolve(import.meta.dirname, "..");
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "stinky-tiered-"));
  roots.push(root);
  const workspace = await initWorkspace(root);
  await mkdir(path.join(root, "docs"), { recursive: true });
  await createTask(workspace, { id: "t-tiered", workspaceId: "ws-1", goal: "Build docs", requestedOutputs: ["document"], riskLevel: "L0", state: "SCOPED" });
  const schemas = await SchemaRegistry.create(projectRoot);
  return { workspace, schemas, root };
}

async function writeUserPolicy(root: string, fileName: string, content: string): Promise<void> {
  const dir = path.join(root, ".stinky-cobbler", "policies");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, fileName), content, "utf8");
}

describe("tiered config", () => {
  it("falls back to builtin defaults when no user overlay exists", async () => {
    const { workspace } = await setup();
    const cfg = await loadOrchestrationConfig(workspace);
    expect(cfg.defaults?.maxRounds).toBe(5);
    expect(cfg.defaults?.oscillationThreshold).toBe(2);
    expect(cfg.sensitiveExtraPaths).toEqual([]);
  });

  it("merges user overlay keys over builtin (untouched keys keep builtin values)", async () => {
    const { workspace, root } = await setup();
    await writeUserPolicy(root, "orchestration.yaml", "version: 1\ndefaults:\n  maxRounds: 10\n");
    const cfg = await loadOrchestrationConfig(workspace);
    expect(cfg.defaults?.maxRounds).toBe(10);
    expect(cfg.defaults?.maxRetriesPerSubtask).toBe(2); // untouched -> builtin
  });

  it("fails closed on a wrong overlay version", async () => {
    const { workspace, root } = await setup();
    await writeUserPolicy(root, "orchestration.yaml", "version: 2\ndefaults: {}\n");
    await expect(loadOrchestrationConfig(workspace)).rejects.toMatchObject({ code: "TIERED_CONFIG_VERSION" });
  });

  it("fails closed on malformed overlay YAML", async () => {
    const { workspace, root } = await setup();
    await writeUserPolicy(root, "orchestration.yaml", "version: 1\ndefaults: [broken");
    await expect(loadOrchestrationConfig(workspace)).rejects.toMatchObject({ code: "TIERED_CONFIG_INVALID" });
  });

  it("rejects relaxing the oscillation threshold (tighten-only)", async () => {
    const { workspace, root } = await setup();
    await writeUserPolicy(root, "orchestration.yaml", "version: 1\ndefaults:\n  oscillationThreshold: 3\n");
    await expect(loadOrchestrationConfig(workspace)).rejects.toMatchObject({ code: "TIERED_CONFIG_INVALID" });
  });

  it("accepts tightening the oscillation threshold to 1", async () => {
    const { workspace, root } = await setup();
    await writeUserPolicy(root, "orchestration.yaml", "version: 1\ndefaults:\n  oscillationThreshold: 1\n");
    const cfg = await loadOrchestrationConfig(workspace);
    expect(cfg.defaults?.oscillationThreshold).toBe(1);
  });
});

describe("specialist overlay", () => {
  it("appends a new domain and replaces a builtin domain with a custom title", async () => {
    const { workspace, root } = await setup();
    await writeUserPolicy(root, "specialists.yaml", `version: 1
specialists:
  - domain: frontend
    title: 像素魔法师
    instructions: [按项目约定工作]
    acceptanceChecklist: [符合验收]
    negativeRules: [不越界]
    suggestedCapabilities: [repository-read]
  - domain: medical
    title: 妙手仁心
    instructions: [以患者数据安全为先]
    acceptanceChecklist: [隐私零泄露]
    negativeRules: [不输出患者信息]
    suggestedCapabilities: [repository-read]
`);
    const profiles = await listSpecialists(workspace);
    expect(profiles.find((p) => p.domain === "frontend")?.title).toBe("像素魔法师");
    expect(profiles.find((p) => p.domain === "medical")?.title).toBe("妙手仁心");
    expect(profiles.some((p) => p.domain === "general")).toBe(true); // fallback intact
  });
});

describe("engine defaults from config", () => {
  it("applies the user-configured budget to a new run", async () => {
    const { workspace, schemas, root } = await setup();
    await writeUserPolicy(root, "orchestration.yaml", "version: 1\ndefaults:\n  maxRounds: 9\n");
    const contract = await createContract(workspace, schemas, { taskId: "t-tiered", domain: "compliance", goal: "g", globalAcceptanceCriteria: ["a", "b", "c", "d"], scope: ["docs"] });
    const run = await createRun(workspace, schemas, { contractRef: contract.contractId });
    expect(run.budget.maxRounds).toBe(9);
  });

  it("auto-rejects ACCEPTED reviews scoring below the configured threshold", async () => {
    const { workspace, schemas, root } = await setup();
    await writeUserPolicy(root, "orchestration.yaml", "version: 1\ndefaults:\n  autoRejectScoreThreshold: 60\n");
    const contract = await createContract(workspace, schemas, { taskId: "t-tiered", domain: "compliance", goal: "g", globalAcceptanceCriteria: ["a", "b", "c", "d"], scope: ["docs"] });
    const run = await createRun(workspace, schemas, { contractRef: contract.contractId });
    const subtask = await addSubtask(workspace, schemas, run.runId, { goal: "write", inputArtifactIds: [], acceptanceCriteria: ["x"], scope: ["docs"], capabilities: ["repository-read"] });
    await dispatchSubtask(workspace, schemas, run.runId, subtask.subtaskId, "agent");
    await beginSubtask(workspace, run.runId, subtask.subtaskId);
    await writeFile(path.join(workspace.root, "docs", "guide.md"), "x\n", "utf8");
    await reportArtifact(workspace, schemas, run.runId, subtask.subtaskId, { path: "docs/guide.md", kind: "file" });
    const result = await recordReview(workspace, schemas, run.runId, subtask.subtaskId, {
      decision: "ACCEPTED", criteriaResults: [{ criterion: "x", passed: true, note: "ok" }],
      defects: [], score: 40, reason: "looks fine", validatorEvidence: [], reviewedBy: "host"
    });
    expect(result.review.decision).toBe("REJECTED");
    expect(result.review.reason).toContain("auto-reject");
    expect(result.review.defects.some((d) => d.location === "engine")).toBe(true);
  });

  it("auto-escalates the run when a consistency check fails (configured)", async () => {
    const { workspace, schemas, root } = await setup();
    await writeUserPolicy(root, "orchestration.yaml", "version: 1\ndefaults:\n  autoEscalateOnConsistencyFail: true\n");
    const contract = await createContract(workspace, schemas, { taskId: "t-tiered", domain: "compliance", goal: "g", globalAcceptanceCriteria: ["a", "b", "c", "d"], scope: ["docs"] });
    const run = await createRun(workspace, schemas, { contractRef: contract.contractId });
    const result = await completeRound(workspace, run.runId, { passed: false, note: "scope drifted" });
    expect(result.status).toBe("ESCALATED");
    expect(result.escalationReason).toContain("consistency check failed");
  });

  it("keeps human judgment by default when consistency fails", async () => {
    const { workspace, schemas } = await setup();
    const contract = await createContract(workspace, schemas, { taskId: "t-tiered", domain: "compliance", goal: "g", globalAcceptanceCriteria: ["a", "b", "c", "d"], scope: ["docs"] });
    const run = await createRun(workspace, schemas, { contractRef: contract.contractId });
    const result = await completeRound(workspace, run.runId, { passed: false, note: "drift" });
    expect(result.status).toBe("RUNNING");
    expect(result.goalConsistency.at(-1)?.passed).toBe(false);
  });
});

describe("append-only sensitive paths", () => {
  it("blocks writes to user-appended sensitive paths (builtin behavior unchanged)", async () => {
    const { workspace, schemas, root } = await setup();
    await writeUserPolicy(root, "orchestration.yaml", `version: 1
sensitiveExtraPaths:
  - internal/
`);
    // Prepare a RUNNING subtask so write requests take the subtask-mode path.
    const contract = await createContract(workspace, schemas, { taskId: "t-tiered", domain: "compliance", goal: "g", globalAcceptanceCriteria: ["a", "b", "c", "d"], scope: ["docs"] });
    const run = await createRun(workspace, schemas, { contractRef: contract.contractId });
    const subtask = await addSubtask(workspace, schemas, run.runId, { goal: "write", inputArtifactIds: [], acceptanceCriteria: ["x"], scope: ["docs"], capabilities: ["repository-read"] });
    await dispatchSubtask(workspace, schemas, run.runId, subtask.subtaskId, "agent");
    await beginSubtask(workspace, run.runId, subtask.subtaskId);
    const options = { runRef: run.runId, subtaskRef: subtask.subtaskId };
    await expect(requestWrites(workspace, schemas, "-", "-", [{ target: "internal/note.md", action: "create", purpose: "test" }], options))
      .rejects.toMatchObject({ code: "WRITE_TARGET_FORBIDDEN" });
    await expect(requestWrites(workspace, schemas, "-", "-", [{ target: "docs/ok.md", action: "create", purpose: "test" }], options))
      .resolves.toBeDefined();
  });
});

describe("contract templates", () => {
  it("lists builtin templates and supports user append", async () => {
    const { workspace, root } = await setup();
    const builtin = await listContractTemplates(null);
    expect(builtin.some((t) => t.name === "docs-audit")).toBe(true);
    await writeUserPolicy(root, "contract-templates.yaml", `version: 1
templates:
  - name: custom-audit
    description: 自定义审计
    domain: compliance
    goal: 自定义审计目标
    criteria: [c1]
    scope: [docs]
`);
    const merged = await listContractTemplates(workspace);
    expect(merged.some((t) => t.name === "custom-audit")).toBe(true);
    const custom = await getContractTemplate(workspace, "custom-audit");
    expect(custom.goal).toBe("自定义审计目标");
  });
});
