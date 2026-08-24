import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SchemaRegistry } from "../src/contracts/schema-registry.js";
import { createTask, getTask, saveTask } from "../src/storage/tasks.js";
import { initWorkspace } from "../src/storage/workspace.js";
import { loadOrchestrationConfig, loadTemplatesConfig, loadTieredYaml } from "../src/config/tiered.js";
import { loadAndValidateAllTieredConfig } from "../src/config/tiered-health.js";
import {
  createContract, createRun, addSubtask, reportArtifact, recordReview, completeRound, dispatchSubtask, beginSubtask
} from "../src/storage/orchestration.js";
import { listSpecialists } from "../src/storage/specialists.js";
import { getContractTemplate, listContractTemplates } from "../src/storage/contract-templates.js";
import { requestWrites } from "../src/storage/write-intents.js";
import { listLedgerEntries } from "../src/storage/ledger.js";
import { StinkyCobblerError } from "../src/errors.js";
import { approveTaskCapability } from "./helpers/authority.js";

const roots: string[] = [];
const projectRoot = path.resolve(import.meta.dirname, "..");
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "stinky-tiered-"));
  roots.push(root);
  const workspace = await initWorkspace(root);
  await mkdir(path.join(root, "docs"), { recursive: true });
  await createTask(workspace, { id: "t-tiered", workspaceId: "ws-1", goal: "Build docs", requestedOutputs: ["document"], riskLevel: "L0", state: "RUNNING" });
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

  it("rejects a symlinked policies directory instead of reading an external overlay", async () => {
    const { workspace } = await setup();
    const outside = await mkdtemp(path.join(os.tmpdir(), "stinky-policies-outside-"));
    roots.push(outside);
    await writeFile(path.join(outside, "orchestration.yaml"), "version: 1\ndefaults:\n  maxRounds: 99\n", "utf8");
    await symlink(outside, path.join(workspace.directory, "policies"));

    await expect(loadOrchestrationConfig(workspace)).rejects.toMatchObject({ code: "PATH_DENIED" });
  });

  it("rejects a symlinked policy file instead of reading external YAML", async () => {
    const { workspace } = await setup();
    const outside = await mkdtemp(path.join(os.tmpdir(), "stinky-policy-file-outside-"));
    roots.push(outside);
    const externalPolicy = path.join(outside, "orchestration.yaml");
    await writeFile(externalPolicy, "version: 1\ndefaults:\n  maxRounds: 99\n", "utf8");
    await mkdir(path.join(workspace.directory, "policies"));
    await symlink(externalPolicy, path.join(workspace.directory, "policies", "orchestration.yaml"));

    await expect(loadOrchestrationConfig(workspace)).rejects.toMatchObject({ code: "PATH_DENIED" });
  });

  it("merges user overlay keys over builtin (untouched keys keep builtin values)", async () => {
    const { workspace, root } = await setup();
    await writeUserPolicy(root, "orchestration.yaml", "version: 1\ndefaults:\n  maxRounds: 10\n");
    const cfg = await loadOrchestrationConfig(workspace);
    expect(cfg.defaults?.maxRounds).toBe(10);
    expect(cfg.defaults?.maxRetriesPerSubtask).toBe(2); // untouched -> builtin
  });

  it.each([
    ["orchestration.yaml", "version: 1\ndefaults:\n  maxRounds: unlimited\n"],
    ["specialists.yaml", "version: 1\nspecialists: invalid\n"],
    ["templates.yaml", "version: 1\nreviewStyle:\n  concise: 42\n"],
    ["contract-templates.yaml", "version: 1\ntemplates: invalid\n"]
  ] as const)("does not expose %s through an unvalidated loadTieredYaml boundary", async (fileName, content) => {
    const { workspace, root } = await setup();
    await writeUserPolicy(root, fileName, content);

    await expect(loadTieredYaml(workspace, fileName, 1)).rejects.toMatchObject({
      code: "TIERED_CONFIG_INVALID"
    });
  });

  it("rejects non-canonical filenames before attempting a tiered policy read", async () => {
    await expect(loadTieredYaml(null, "../profiles/default.json" as never, 1)).rejects.toMatchObject({
      code: "TIERED_CONFIG_INVALID"
    });
  });

  it("fails closed on a wrong overlay version", async () => {
    const { workspace, root } = await setup();
    await writeUserPolicy(root, "orchestration.yaml", "version: 2\ndefaults: {}\n");
    await expect(loadOrchestrationConfig(workspace)).rejects.toMatchObject({ code: "TIERED_CONFIG_VERSION" });
  });

  it("config errors carry a fix guide (where, how, correct example)", async () => {
    const { workspace, root } = await setup();
    await writeUserPolicy(root, "orchestration.yaml", "version: 2\ndefaults: {}\n");
    const error = await loadOrchestrationConfig(workspace).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "TIERED_CONFIG_VERSION" });
    const fix = (error as StinkyCobblerError).details?.fix as string;
    expect(fix).toContain("version: 1");          // correct example
    expect(fix).toContain("orchestration.yaml");  // which file
  });

  it("rejects relaxing the oscillation threshold (tighten-only)", async () => {
    const { workspace, root } = await setup();
    await writeUserPolicy(root, "orchestration.yaml", "version: 1\ndefaults:\n  oscillationThreshold: 3\n");
    const error = await loadOrchestrationConfig(workspace).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "TIERED_CONFIG_INVALID" });
    const fix = (error as StinkyCobblerError).details?.fix as string;
    expect(fix).toContain("oscillationThreshold: 2"); // correct example
  });

  it("fails closed on malformed overlay YAML", async () => {
    const { workspace, root } = await setup();
    await writeUserPolicy(root, "orchestration.yaml", "version: 1\ndefaults: [broken");
    await expect(loadOrchestrationConfig(workspace)).rejects.toMatchObject({ code: "TIERED_CONFIG_INVALID" });
  });

  it.each([
    "version: 1\nsensitiveExtraPaths: internal/\n",
    "version: 1\nsensitiveExtraPaths:\n  path: internal/\n",
    "version: 1\nsensitiveExtraPaths:\n  - 42\n"
  ])("fails closed when sensitiveExtraPaths has an invalid runtime shape", async (content) => {
    const { workspace, root } = await setup();
    await writeUserPolicy(root, "orchestration.yaml", content);
    await expect(loadOrchestrationConfig(workspace)).rejects.toMatchObject({ code: "TIERED_CONFIG_INVALID" });
  });

  it("normalizes and deduplicates custom sensitive paths", async () => {
    const { workspace, root } = await setup();
    await writeUserPolicy(root, "orchestration.yaml", "version: 1\nsensitiveExtraPaths:\n  - internal/\n  - internal\n");
    expect((await loadOrchestrationConfig(workspace)).sensitiveExtraPaths).toEqual(["internal"]);
  });

  it.each([
    "version: 1\ndefaults: invalid\n",
    "version: 1\ndefaults:\n  maxWriteContentBytes: unlimited\n",
    "version: 1\ndefaults:\n  autoEscalateOnConsistencyFail: yes\n",
    "version: 1\ndefaults:\n  leaseDefaultToolCalls: 101\n",
    "version: 1\ndefaults:\n  leaseDefaultMinutes: 120\n  leaseMaxMinutes: 60\n"
  ])("fails closed on malformed or inconsistent safety defaults", async (content) => {
    const { workspace, root } = await setup();
    await writeUserPolicy(root, "orchestration.yaml", content);
    await expect(loadOrchestrationConfig(workspace)).rejects.toMatchObject({ code: "TIERED_CONFIG_INVALID" });
  });

  it.each([
    "version: 1\nsensitiveExtraPath:\n  - internal/\n",
    "version: 1\ndefaults:\n  maxWriteContentByte: 100\n",
    "version: 1\ndefaults:\n  maxParallel: 4\n",
    "version: 1\ndefaults:\n  maxWritesPerBatch: 20\n",
    "version: 1\nconstructor:\n  unsafe: true\n"
  ])("fails closed on unknown or prototype-sensitive configuration keys", async (content) => {
    const { workspace, root } = await setup();
    await writeUserPolicy(root, "orchestration.yaml", content);
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

  it.each([
    ["maxRounds", 101],
    ["maxRetriesPerSubtask", 11],
    ["maxContractCriteria", 21],
    ["maxSubtaskCriteria", 11],
    ["leaseGraceMinutes", 16]
  ])("rejects %s above its hard safety bound", async (key, value) => {
    const { workspace, root } = await setup();
    await writeUserPolicy(root, "orchestration.yaml", `version: 1\ndefaults:\n  ${key}: ${value}\n`);
    await expect(loadOrchestrationConfig(workspace)).rejects.toMatchObject({ code: "TIERED_CONFIG_INVALID" });
  });

  it("accepts the exact maxRounds hard ceiling", async () => {
    const { workspace, root } = await setup();
    await writeUserPolicy(root, "orchestration.yaml", "version: 1\ndefaults:\n  maxRounds: 100\n");
    expect((await loadOrchestrationConfig(workspace)).defaults?.maxRounds).toBe(100);
  });
});

describe("specialist overlay", () => {
  it("appends a new domain and replaces a builtin domain with a custom title", async () => {
    const { workspace, schemas, root } = await setup();
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
    const contract = await createContract(workspace, schemas, { taskId: "t-tiered", domain: "medical", goal: "g", globalAcceptanceCriteria: ["a"], scope: ["docs"] });
    const run = await createRun(workspace, schemas, { contractRef: contract.contractId });
    const subtask = await addSubtask(workspace, schemas, run.runId, { goal: "work", inputArtifactIds: [], acceptanceCriteria: ["a"], scope: ["docs"], capabilities: ["repository-read"] });
    expect(subtask.domainInstructions[0]).toContain("妙手仁心");
  });

  it("rejects profiles whose injected instruction package exceeds the subtask schema", async () => {
    const { workspace, root } = await setup();
    const ten = Array.from({ length: 10 }, (_, index) => `item-${index}`).join(", ");
    await writeUserPolicy(root, "specialists.yaml", `version: 1
specialists:
  - domain: oversized
    title: Oversized
    instructions: [${ten}]
    acceptanceChecklist: [${ten}]
    negativeRules: [${ten}]
    suggestedCapabilities: [repository-read]
`);
    await expect(listSpecialists(workspace)).rejects.toMatchObject({ code: "TIERED_CONFIG_INVALID" });
  });

  it("accounts for injected checklist prefixes in the 512-character schema limit", async () => {
    const { workspace, root } = await setup();
    await writeUserPolicy(root, "specialists.yaml", `version: 1
specialists:
  - domain: too-long
    title: Long
    instructions: [work]
    acceptanceChecklist: [${"x".repeat(510)}]
    negativeRules: [guard]
    suggestedCapabilities: [repository-read]
`);
    await expect(listSpecialists(workspace)).rejects.toMatchObject({ code: "TIERED_CONFIG_INVALID" });
  });

  it.each([
    "version: 1\nspecialists: invalid\n",
    "version: 1\nspecialists:\n  - domain: incomplete\n",
    "version: 1\nspecialists:\n  - domain: custom\n    title: Custom\n    instructions: [work]\n    acceptanceChecklist: [check]\n    negativeRules: [guard]\n    suggestedCapabilities: [shell]\n",
    "version: 1\nunknown: true\n"
  ])("fails closed on malformed specialist policy shapes", async (content) => {
    const { workspace, root } = await setup();
    await writeUserPolicy(root, "specialists.yaml", content);
    await expect(listSpecialists(workspace)).rejects.toMatchObject({ code: "TIERED_CONFIG_INVALID" });
  });
});

describe("guidance templates", () => {
  it("merges a partial workspace overlay into the validated builtin dictionary", async () => {
    const { workspace, root } = await setup();
    await writeUserPolicy(root, "templates.yaml", "version: 1\nreviewStyle:\n  concise: 一行结论\n");
    const templates = await loadTemplatesConfig(workspace);
    expect(templates.reviewStyle.concise).toBe("一行结论");
    expect(templates.reviewStyle.default).toBeTruthy();
    expect(templates.instructionsLanguage.options).toContain(templates.instructionsLanguage.default);
  });

  it.each([
    "version: 1\nreviewStyle: concise\n",
    "version: 1\nreviewStyle:\n  typo: invalid\n",
    "version: 1\ninstructionsLanguage:\n  options: zh\n",
    "version: 1\ninstructionsLanguage:\n  default: fr\n  options: [fr]\n",
    "version: 1\nunknown: true\n"
  ])("fails closed on malformed guidance-template policy shapes", async (content) => {
    const { workspace, root } = await setup();
    await writeUserPolicy(root, "templates.yaml", content);
    await expect(loadTemplatesConfig(workspace)).rejects.toMatchObject({ code: "TIERED_CONFIG_INVALID" });
  });
});

describe("four-file effective config health", () => {
  it.each([
    ["maxDomainInstructions", 1],
    ["maxDomainLength", 1],
    ["maxContractCriteria", 2]
  ])("rejects an effective %s limit that makes a merged policy entry unusable", async (key, value) => {
    const { workspace, root } = await setup();
    await writeUserPolicy(root, "orchestration.yaml", `version: 1\ndefaults:\n  ${key}: ${value}\n`);
    await expect(loadAndValidateAllTieredConfig(workspace)).rejects.toMatchObject({ code: "TIERED_CONFIG_INVALID" });
  });

  it("rejects a contract template whose scope becomes custom-sensitive", async () => {
    const { workspace, root } = await setup();
    await writeUserPolicy(root, "orchestration.yaml", "version: 1\nsensitiveExtraPaths:\n  - docs\n");
    await expect(loadAndValidateAllTieredConfig(workspace)).rejects.toMatchObject({ code: "TIERED_CONFIG_INVALID" });
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
    await dispatchSubtask(workspace, schemas, run.runId, subtask.subtaskId, "agent", 0);
    await beginSubtask(workspace, run.runId, subtask.subtaskId, 0);
    await writeFile(path.join(workspace.root, "docs", "guide.md"), "x\n", "utf8");
    await reportArtifact(workspace, schemas, run.runId, subtask.subtaskId, { path: "docs/guide.md", kind: "file", expectedAttempt: 0 });
    const result = await recordReview(workspace, schemas, run.runId, subtask.subtaskId, {
      decision: "ACCEPTED", criteriaResults: [{ criterion: "x", passed: true, note: "ok" }],
      defects: [], score: 40, reason: "looks fine", validatorEvidence: [], reviewedBy: "host", tokensUsed: 0, expectedAttempt: 0
    });
    expect(result.review.decision).toBe("REJECTED");
    expect(result.review.reason).toContain("auto-reject");
    expect(result.review.defects).toHaveLength(1);
    expect(result.review.defects[0]?.location).toBe("engine");
    expect(result.subtask.lastDefects).toEqual(result.review.defects);
    const ledger = await listLedgerEntries(workspace);
    expect(ledger.findLast((entry) => entry.event === "subtask-rejected")?.summary).toContain("1 defect(s)");
  });

  it("enforces the configured per-review defect limit", async () => {
    const { workspace, schemas, root } = await setup();
    await writeUserPolicy(root, "orchestration.yaml", "version: 1\ndefaults:\n  maxDefects: 1\n");
    const contract = await createContract(workspace, schemas, { taskId: "t-tiered", domain: "compliance", goal: "g", globalAcceptanceCriteria: ["a"], scope: ["docs"] });
    const run = await createRun(workspace, schemas, { contractRef: contract.contractId });
    const subtask = await addSubtask(workspace, schemas, run.runId, { goal: "write", inputArtifactIds: [], acceptanceCriteria: ["x"], scope: ["docs"], capabilities: ["repository-read"] });
    await dispatchSubtask(workspace, schemas, run.runId, subtask.subtaskId, "agent", 0);
    await beginSubtask(workspace, run.runId, subtask.subtaskId, 0);
    await expect(recordReview(workspace, schemas, run.runId, subtask.subtaskId, {
      decision: "REJECTED",
      criteriaResults: [{ criterion: "x", passed: false, note: "bad" }],
      defects: [
        { location: "docs/a", problem: "a", suggestion: "fix a" },
        { location: "docs/b", problem: "b", suggestion: "fix b" }
      ],
      score: 20,
      reason: "too many defects",
      validatorEvidence: [],
      reviewedBy: "host",
      tokensUsed: 0,
      expectedAttempt: 0
    })).rejects.toMatchObject({ code: "REVIEW_DEFECTS_TOO_MANY" });
  });

  it("rechecks the defect limit after a low score adds the engine defect", async () => {
    const { workspace, schemas, root } = await setup();
    await writeUserPolicy(root, "orchestration.yaml", "version: 1\ndefaults:\n  maxDefects: 1\n  autoRejectScoreThreshold: 60\n");
    const contract = await createContract(workspace, schemas, { taskId: "t-tiered", domain: "compliance", goal: "g", globalAcceptanceCriteria: ["a"], scope: ["docs"] });
    const run = await createRun(workspace, schemas, { contractRef: contract.contractId });
    const subtask = await addSubtask(workspace, schemas, run.runId, { goal: "write", inputArtifactIds: [], acceptanceCriteria: ["x"], scope: ["docs"], capabilities: ["repository-read"] });
    await dispatchSubtask(workspace, schemas, run.runId, subtask.subtaskId, "agent", 0);
    await beginSubtask(workspace, run.runId, subtask.subtaskId, 0);
    await expect(recordReview(workspace, schemas, run.runId, subtask.subtaskId, {
      decision: "ACCEPTED",
      criteriaResults: [{ criterion: "x", passed: true, note: "ok" }],
      defects: [{ location: "docs/a", problem: "caller defect", suggestion: "fix" }],
      score: 40,
      reason: "low score",
      validatorEvidence: [],
      reviewedBy: "host",
      tokensUsed: 0,
      expectedAttempt: 0
    })).rejects.toMatchObject({ code: "REVIEW_DEFECTS_TOO_MANY" });
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
    const currentTask = await getTask(workspace, "t-tiered");
    const writeTask = { ...currentTask, scope: ["docs"], writeSet: ["docs/ok.md"] };
    await saveTask(workspace, writeTask);
    await approveTaskCapability(workspace, schemas, writeTask, "repository-write", ["docs/ok.md"]);
    await writeUserPolicy(root, "orchestration.yaml", `version: 1
sensitiveExtraPaths:
  - internal/
`);
    // Prepare a RUNNING subtask so write requests take the subtask-mode path.
    const contract = await createContract(workspace, schemas, { taskId: "t-tiered", domain: "compliance", goal: "g", globalAcceptanceCriteria: ["a", "b", "c", "d"], scope: ["docs"] });
    const run = await createRun(workspace, schemas, { contractRef: contract.contractId });
    const subtask = await addSubtask(workspace, schemas, run.runId, { goal: "write", inputArtifactIds: [], acceptanceCriteria: ["x"], scope: ["docs"], capabilities: ["repository-read"] });
    await dispatchSubtask(workspace, schemas, run.runId, subtask.subtaskId, "agent", 0);
    await beginSubtask(workspace, run.runId, subtask.subtaskId, 0);
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

  it.each([
    "version: 1\ntemplates: invalid\n",
    "version: 1\ntemplates:\n  - name: incomplete\n",
    "version: 1\ntemplates:\n  - name: unsafe\n    description: unsafe\n    domain: compliance\n    goal: unsafe\n    criteria: [ok]\n    scope: [.stinky-cobbler]\n",
    "version: 1\nunknown: true\n"
  ])("fails closed on malformed contract-template policy shapes", async (content) => {
    const { workspace, root } = await setup();
    await writeUserPolicy(root, "contract-templates.yaml", content);
    await expect(listContractTemplates(workspace)).rejects.toMatchObject({ code: "TIERED_CONFIG_INVALID" });
  });
});
