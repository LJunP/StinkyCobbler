import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(import.meta.dirname, "..", "..");
const roots: string[] = [];

const DECLARED_ONLY_PLUGIN_IDS = [
  "local-observe", "crm-read", "crm-write", "message-draft", "asset-read", "media-render",
  "publishing-draft", "dataset-read", "notebook-run", "visualization-render", "document-read",
  "quiz-render", "web-research", "pdf-render", "approved-document-read", "evidence-export-draft"
];
const DEAD_PROFILE_KEYS = ["defaultApproval", "maxParallelAgents", "rules"];
const DEAD_ROLE_KEYS = ["defaultLevel", "category", "requiresWorktree", "writeScope", "incompatibleWith"];
const DEAD_WORKSPACE_KEYS = ["mode", "allowLocalL0Exploration"];
const DEAD_PLUGIN_FIELDS = ["inputSchemaRef", "outputSchemaRef", "sideEffects", "requiresLease", "requiresApproval", "timeoutMs", "auditMode"];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function cli(env: NodeJS.ProcessEnv, ...args: string[]): Promise<string> {
  const result = await execFileAsync(process.execPath, [path.join(projectRoot, "dist/cli.js"), ...args], {
    cwd: projectRoot,
    env,
    maxBuffer: 1024 * 1024
  });
  return result.stdout;
}

describe("doctor hides unexecuted switches", () => {
  it("omits declared-only plugins from doctor --json", async () => {
    const report = JSON.parse(await cli({ ...process.env }, "doctor", "--json")) as { plugins: Array<{ id: string; status: string }> };
    const ids = report.plugins.map((plugin) => plugin.id);
    for (const id of DECLARED_ONLY_PLUGIN_IDS) expect(ids).not.toContain(id);
    expect(report.plugins.every((plugin) => plugin.status !== "declared-only")).toBe(true);
    expect(JSON.stringify(report)).not.toContain("PLUGIN_DECLARED_ONLY");
  });

  it("omits dead profile, role, workspace, and plugin fields after init", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "stinky-liveness-")));
    roots.push(root);
    const env = { ...process.env };
    const preview = JSON.parse(await cli(env, "init", "--workspace-id", "liveness", "--profile", "team", "--pack", "software-engineering", "--root", root, "--dry-run", "--json")) as { writes: string[] };
    expect(preview.writes).not.toContain(".stinky-cobbler/policies/templates.yaml");
    await cli(env, "init", "--workspace-id", "liveness", "--profile", "team", "--pack", "software-engineering", "--root", root, "--json");
    const stored = JSON.parse(await readFile(path.join(root, ".stinky-cobbler", "workspace.json"), "utf8")) as Record<string, unknown>;
    for (const key of DEAD_WORKSPACE_KEYS) expect(stored).not.toHaveProperty(key);

    const doctor = JSON.parse(await cli(env, "config", "doctor", "--root", root, "--json")) as {
      config: Record<string, unknown>;
      profile: Record<string, unknown>;
      roles: Record<string, Record<string, unknown>>;
      plugins: Array<Record<string, unknown>>;
    };
    for (const key of DEAD_WORKSPACE_KEYS) expect(doctor.config).not.toHaveProperty(key);
    for (const key of DEAD_PROFILE_KEYS) expect(doctor.profile).not.toHaveProperty(key);
    for (const role of Object.values(doctor.roles)) {
      for (const key of DEAD_ROLE_KEYS) expect(role).not.toHaveProperty(key);
    }
    for (const plugin of doctor.plugins) {
      for (const id of DECLARED_ONLY_PLUGIN_IDS) expect(plugin.id).not.toBe(id);
      for (const key of DEAD_PLUGIN_FIELDS) expect(plugin).not.toHaveProperty(key);
    }
  });
});
