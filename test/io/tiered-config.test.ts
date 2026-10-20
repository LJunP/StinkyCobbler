import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ORCHESTRATION_MERGE_STRATEGY, loadOrchestrationConfig } from "../../src/config/tiered.js";
import { StinkyCobblerError } from "../../src/errors.js";
import { listContractTemplates } from "../../src/gate/storage/contract-templates.js";
import { listSpecialists } from "../../src/gate/storage/specialists.js";
import { initWorkspace } from "../../src/gate/storage/workspace.js";
import { mergeTiered, resolveConfigHome, userPolicyFile } from "../../src/io/tiered-config.js";

const roots: string[] = [];
let previousXdg: string | undefined;

beforeEach(() => {
  previousXdg = process.env.XDG_CONFIG_HOME;
});

afterEach(async () => {
  if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = previousXdg;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("mergeTiered", () => {
  it("keeps builtin sensitive paths when a later layer omits them", () => {
    const effective = mergeTiered(
      [
        { version: 1, defaults: { maxRounds: 5 }, sensitiveExtraPaths: ["secrets"] },
        { version: 1, sensitiveExtraPaths: [] }
      ],
      ORCHESTRATION_MERGE_STRATEGY
    );

    expect(effective.sensitiveExtraPaths).toEqual(["secrets"]);
    expect(effective.defaults?.maxRounds).toBe(5);
  });

  it("appends new sensitive paths without duplicating earlier ones", () => {
    const effective = mergeTiered([{ sensitiveExtraPaths: ["secrets"] }, { sensitiveExtraPaths: ["secrets", "internal"] }], ORCHESTRATION_MERGE_STRATEGY);

    expect(effective.sensitiveExtraPaths).toEqual(["secrets", "internal"]);
  });

  it("replaces a keyed item by id and appends an unknown id", () => {
    const effective = mergeTiered(
      [
        {
          items: [
            { id: "a", title: "old" },
            { id: "b", title: "keep" }
          ]
        },
        {
          items: [
            { id: "a", title: "new" },
            { id: "c", title: "added" }
          ]
        }
      ],
      { fields: { items: { keyedList: "id" } } }
    );

    expect(effective.items).toEqual([
      { id: "a", title: "new" },
      { id: "b", title: "keep" },
      { id: "c", title: "added" }
    ]);
  });

  it("rejects a keyed item that has no id", () => {
    expect(() => mergeTiered([{ items: [{ id: "a" }] }, { items: [{ title: "missing" }] }], { fields: { items: { keyedList: "id" } } })).toThrow(
      StinkyCobblerError
    );
  });

  it("record strategy still replaces arrays and merges one object level", () => {
    const effective = mergeTiered(
      [
        { defaults: { maxRounds: 5, maxRetriesPerSubtask: 2 }, flags: ["builtin"] },
        { defaults: { maxRounds: 8 }, flags: ["user"] },
        { defaults: { maxRounds: 9 }, flags: ["project"] }
      ],
      "record"
    );

    expect(effective).toEqual({
      defaults: { maxRounds: 9, maxRetriesPerSubtask: 2 },
      flags: ["project"]
    });
  });
});

async function isolatedLayers(prefix: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  const xdg = path.join(root, "xdg");
  const repo = path.join(root, "repo");
  await mkdir(path.join(xdg, "stinky-cobbler", "policies"), { recursive: true });
  await mkdir(repo);
  process.env.XDG_CONFIG_HOME = xdg;
  return { root, xdg, workspace: await initWorkspace(repo) };
}

describe("XDG user layer", () => {
  it("uses ~/.config when XDG_CONFIG_HOME is unset", () => {
    expect(resolveConfigHome({}, path.join("/home", "dev"))).toBe(path.join("/home", "dev", ".config"));
  });

  it("rejects a relative XDG_CONFIG_HOME", () => {
    expect(() => resolveConfigHome({ XDG_CONFIG_HOME: "relative" }, path.join("/home", "dev"))).toThrow(StinkyCobblerError);
  });

  it("reads $XDG_CONFIG_HOME/stinky-cobbler/policies before the workspace overlay", async () => {
    const { xdg, workspace } = await isolatedLayers("stinky-tiered-xdg-");
    await writeFile(
      path.join(xdg, "stinky-cobbler", "policies", "orchestration.yaml"),
      ["version: 1", "defaults:", "  maxRounds: 8", "sensitiveExtraPaths:", "  - from-user", ""].join("\n"),
      "utf8"
    );
    await mkdir(path.join(workspace.directory, "policies"), { recursive: true });
    await writeFile(
      path.join(workspace.directory, "policies", "orchestration.yaml"),
      ["version: 1", "defaults:", "  maxRounds: 9", "sensitiveExtraPaths:", "  - from-project", ""].join("\n"),
      "utf8"
    );

    const effective = await loadOrchestrationConfig(workspace);

    expect(effective.defaults?.maxRounds).toBe(9);
    expect(effective.defaults?.maxRetriesPerSubtask).toBe(2);
    expect(effective.sensitiveExtraPaths).toEqual(["from-user", "from-project"]);
    expect(userPolicyFile("orchestration.yaml")).toBe(path.join(xdg, "stinky-cobbler", "policies", "orchestration.yaml"));
  });

  it("does not follow a symlinked user policy file", async () => {
    const { root, xdg, workspace } = await isolatedLayers("stinky-tiered-xdg-link-");
    const outside = path.join(root, "outside.yaml");
    await writeFile(outside, "version: 1\ndefaults:\n  maxRounds: 99\n", "utf8");
    await symlink(outside, path.join(xdg, "stinky-cobbler", "policies", "orchestration.yaml"));

    await expect(loadOrchestrationConfig(workspace)).rejects.toMatchObject({ code: "TIERED_CONFIG_INVALID" });
  });

  it("applies an XDG specialist and a workspace specialist by domain", async () => {
    const { xdg, workspace } = await isolatedLayers("stinky-tiered-specialist-");
    await writeFile(
      path.join(xdg, "stinky-cobbler", "policies", "specialists.yaml"),
      `version: 1
specialists:
  - domain: medical
    title: 用户层专才
    instructions: [以患者数据安全为先]
    acceptanceChecklist: [隐私零泄露]
    negativeRules: [不输出患者信息]
    suggestedCapabilities: [repository-read]
`,
      "utf8"
    );
    await mkdir(path.join(workspace.directory, "policies"), { recursive: true });
    await writeFile(
      path.join(workspace.directory, "policies", "specialists.yaml"),
      `version: 1
specialists:
  - domain: medical
    title: 项目层专才
    instructions: [以患者数据安全为先]
    acceptanceChecklist: [隐私零泄露]
    negativeRules: [不输出患者信息]
    suggestedCapabilities: [repository-read]
`,
      "utf8"
    );

    const profiles = await listSpecialists(workspace);

    expect(profiles.find((profile) => profile.domain === "medical")?.title).toBe("项目层专才");
    expect(profiles.some((profile) => profile.domain === "general")).toBe(true);
  });

  it("appends an XDG contract template without dropping builtin templates", async () => {
    const { xdg, workspace } = await isolatedLayers("stinky-tiered-template-");
    await writeFile(
      path.join(xdg, "stinky-cobbler", "policies", "contract-templates.yaml"),
      `version: 1
templates:
  - name: custom-audit
    description: 自定义审计
    domain: compliance
    goal: 自定义审计目标
    criteria: [c1]
    scope: [docs]
`,
      "utf8"
    );

    const templates = await listContractTemplates(workspace);

    expect(templates.some((template) => template.name === "docs-audit")).toBe(true);
    expect(templates.some((template) => template.name === "custom-audit")).toBe(true);
  });
});
