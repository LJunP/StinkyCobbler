import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SchemaRegistry } from "../src/contracts/schema-registry.js";
import { loadRegistries } from "../src/config/registry.js";
import { recommendTask } from "../src/domain/recommend.js";
import { evaluateLease } from "../src/policy/evaluate.js";

const projectRoot = path.resolve(import.meta.dirname, "..");
const paths: string[] = [];
afterEach(async () => { await Promise.all(paths.splice(0).map((entry) => rm(entry, { recursive: true, force: true }))); });

describe("FrameFlow read-only dogfood", () => {
  it("validates and recommends the FrameFlow sample without touching FrameFlow", async () => {
    const schemas = await SchemaRegistry.create(projectRoot);
    const frameFlowTask = JSON.parse(await (await import("node:fs/promises")).readFile(path.join(projectRoot, "examples/frameflow/task.json"), "utf8"));
    schemas.validate("task", frameFlowTask);
    const registries = await loadRegistries(projectRoot, schemas);
    const proposal = recommendTask(frameFlowTask, registries.packs);
    expect(proposal.requiresHumanChoice).toBe(true);
    expect(proposal.minimalDag).toContain("sentinel");
    expect(evaluateLease({ id: "lease", taskId: frameFlowTask.id, agentId: "agent", role: "scout", capability: "repository-read", level: "L0", workspace: "/isolated", readScope: ["."], writeSet: [], issuedAt: "2026-01-01T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z", maxToolCalls: 1, status: "active" }, { taskId: frameFlowTask.id, role: "scout", workspace: "/isolated", capability: "repository-read" }).allowed).toBe(true);
  });

  it("does not execute source code while preparing an isolated dogfood workspace", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "stinky-dogfood-")); paths.push(workspace);
    await writeFile(path.join(workspace, "README.md"), "# Isolated Dogfood\n", "utf8");
    expect(await (await import("node:fs/promises")).readFile(path.join(workspace, "README.md"), "utf8")).toContain("Isolated");
  });
});
