import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { plan, type PlanObservation } from "../../../src/core/plan/plan.js";
import { renderInstructionSegment, renderMcpEntry, renderSkillDir } from "../../../src/core/render/render.js";
import { parseToolkitSpec, type ToolkitSpec } from "../../../src/core/toolkit/spec.js";

const skillBody = "# Review\nNever auto-approve.\n";

describe("pure toolkit planner", () => {
  it.each([
    ["absent", "create"],
    ["foreign", "conflict"],
    ["managed-modified", "conflict"]
  ] as const)("turns a %s skill into %s and does not overwrite protected bytes", (state, expected) => {
    const result = plan(skillSpec(), [observation("codex", "skill", "review", state)], { sources: { skills: { review: skillBody } } });
    if (expected === "create") {
      expect(result.conflicts).toEqual([]);
      expect(result.ops).toEqual([expect.objectContaining({ host: "codex", kind: "skill", id: "review", action: "create", bytes: skillBody })]);
    } else {
      expect(result.ops).toEqual([]);
      expect(result.conflicts).toEqual([expect.objectContaining({ host: "codex", kind: "skill", id: "review", state })]);
    }
  });

  it("leaves a managed skill untouched when the rendered body matches, and replaces it when the body differs", () => {
    const same = plan(skillSpec(), [observation("codex", "skill", "review", "managed", sha256(skillBody))], { sources: { skills: { review: skillBody } } });
    expect(same.ops).toEqual([]);
    expect(same.conflicts).toEqual([]);
    const nextBody = "# Review\nDifferent.\n";
    const changed = plan(skillSpec(), [observation("codex", "skill", "review", "managed", sha256(skillBody))], { sources: { skills: { review: nextBody } } });
    expect(changed.ops).toEqual([expect.objectContaining({ action: "replace", bytes: nextBody, priorHash: sha256(skillBody) })]);
  });

  it("removes a managed skill the spec no longer wants and skips an unsupported host", () => {
    const spec = parseToolkitSpec({
      version: 1,
      hosts: ["codex", "cursor", "zcode"],
      skills: [{ id: "review", source: "./skills/review", hosts: ["codex", "zcode"] }]
    });
    const result = plan(
      spec,
      [
        observation("codex", "skill", "review", "absent"),
        observation("cursor", "skill", "review", "managed", "abc123"),
        observation("zcode", "skill", "review", "absent")
      ],
      {
        sources: { skills: { review: skillBody } },
        support: [{ host: "zcode", kind: "skill", supported: false, reason: "ZCode skill directory is not selected." }]
      }
    );
    expect(result.ops.map((op) => op.action).sort()).toEqual(["create", "remove"]);
    expect(result.ops.find((op) => op.action === "remove")).toMatchObject({ host: "cursor", priorHash: "abc123" });
    expect(result.skipped).toEqual([expect.objectContaining({ host: "zcode", kind: "skill", reason: "ZCode skill directory is not selected." })]);
  });

  it("plans the section 3.3 example without reading sources or expanding bundles", () => {
    const spec = parseToolkitSpec({
      version: 1,
      hosts: ["codex", "claude-code", "cursor", "zcode"],
      skills: [
        { id: "code-review-checklist", source: "./skills/code-review-checklist", hosts: ["codex", "claude-code"] },
        { id: "lark-doc", source: "git+https://github.com/example/skills#lark-doc" }
      ],
      mcpServers: [
        { id: "filesystem", transport: "stdio", command: "npx", args: ["-y", "server"], env: { API_TOKEN: "${env:FS_TOKEN}" } },
        { id: "docs-rag", transport: "stdio", command: "cognee-mcp", role: "knowledge", sources: ["./docs"] }
      ],
      instructions: [
        {
          id: "my-style",
          source: "./instructions/my-style.md",
          render: { codex: "AGENTS.md", "claude-code": "CLAUDE.md", cursor: ".cursor/rules/my-style.mdc", zcode: "skill" }
        }
      ],
      bundles: [{ id: "fullstack-kit", includes: ["code-review-checklist", "filesystem", "my-style"] }]
    });
    const result = plan(
      spec,
      [
        observation("codex", "skill", "code-review-checklist", "absent"),
        observation("claude-code", "skill", "code-review-checklist", "foreign"),
        observation("codex", "mcp-server", "filesystem", "absent"),
        observation("codex", "mcp-server", "docs-rag", "managed-modified", "deadbeef"),
        observation("codex", "instructions", "my-style", "absent"),
        observation("cursor", "instructions", "my-style", "absent")
      ],
      {
        sources: { skills: { "code-review-checklist": skillBody }, instructions: { "my-style": "Use short paragraphs.\n" } },
        support: [{ host: "cursor", kind: "instructions", supported: false, reason: "Cursor user rules are unsupported." }]
      }
    );

    expect(result.ops.find((op) => op.id === "code-review-checklist" && op.host === "codex")).toMatchObject({ action: "create", bytes: skillBody });
    expect(result.conflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ host: "claude-code", id: "code-review-checklist", state: "foreign" }),
        expect.objectContaining({ host: "codex", id: "docs-rag", state: "managed-modified" })
      ])
    );
    expect(result.ops.find((op) => op.id === "filesystem")).toMatchObject({
      action: "merge-mcp",
      mcpEntry: { command: "npx", args: ["-y", "server"], env: { API_TOKEN: "${env:FS_TOKEN}" } }
    });
    expect(result.ops.find((op) => op.id === "my-style" && op.host === "codex")?.segment).toContain("<!-- stinky-cobbler:begin my-style -->");
    expect(result.ops.find((op) => op.id === "my-style" && op.host === "codex")?.segment).toContain("Use short paragraphs.\n");
    expect(result.skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ host: "cursor", kind: "instructions", id: "my-style", reason: "Cursor user rules are unsupported." }),
        expect.objectContaining({ kind: "bundle", id: "fullstack-kit" })
      ])
    );
    expect(result.ops.some((op) => op.id === "lark-doc" || op.id === "fullstack-kit")).toBe(false);
    expect(renderSkillDir({ id: "code-review-checklist", source: "./skills/code-review-checklist" }, skillBody).files["SKILL.md"]).toBe(skillBody);
    expect(renderMcpEntry(spec.mcpServers[0]!).env?.API_TOKEN).toBe("${env:FS_TOKEN}");
    expect(renderInstructionSegment(spec.instructions[0]!, "codex", "Use short paragraphs.\n")).toContain("<!-- stinky-cobbler:end my-style -->");
  });
});

function skillSpec(): ToolkitSpec {
  return parseToolkitSpec({
    version: 1,
    hosts: ["codex"],
    skills: [{ id: "review", source: "./skills/review" }]
  });
}

function observation(host: string, kind: PlanObservation["kind"], id: string, state: PlanObservation["state"], hash?: string): PlanObservation {
  return { host, kind, id, path: `/tmp/${host}/${kind}/${id}`, state, ...(hash === undefined ? {} : { hash }) };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
