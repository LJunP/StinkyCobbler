import { execFile } from "node:child_process";
import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { parseSlots, renderSkill } from "../scripts/render-skills.mjs";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(import.meta.dirname, "..");

async function readRepoFile(relativePath: string): Promise<string> {
  return readFile(path.resolve(projectRoot, relativePath), "utf8");
}

describe("host skill documentation contract", () => {
  it("regenerates Codex and ZCode skills from one core plus host fragments", async () => {
    const check = await execFileAsync(process.execPath, ["scripts/render-skills.mjs", "--check"], { cwd: projectRoot });
    expect(check.stderr).toBe("");
    const core = await readRepoFile("templates/skill-core.md");
    expect(core).not.toMatch(/Codex|ZCode/);
    const codex = renderSkill(core, parseSlots(await readRepoFile("templates/hosts/codex.md")));
    const zcode = renderSkill(core, parseSlots(await readRepoFile("templates/hosts/zcode.md")));
    expect(codex).toBe(await readRepoFile(".codex/skills/stinky-cobbler/SKILL.md"));
    expect(zcode).toBe(await readRepoFile(".zcode/skills/stinky-cobbler/SKILL.md"));
    expect(codex).not.toBe(zcode);
  });

  it("renders CRLF templates to the same LF bytes as the checked-in skills", async () => {
    const [core, codexHost, zcodeHost, codexSkill, zcodeSkill] = await Promise.all([
      readRepoFile("templates/skill-core.md"),
      readRepoFile("templates/hosts/codex.md"),
      readRepoFile("templates/hosts/zcode.md"),
      readRepoFile(".codex/skills/stinky-cobbler/SKILL.md"),
      readRepoFile(".zcode/skills/stinky-cobbler/SKILL.md")
    ]);
    const crlf = (text: string) => text.replace(/\n/g, "\r\n");
    const codex = renderSkill(crlf(core), parseSlots(crlf(codexHost)));
    const zcode = renderSkill(crlf(core), parseSlots(crlf(zcodeHost)));
    expect(codex).toBe(codexSkill);
    expect(zcode).toBe(zcodeSkill);
    expect(codex.includes("\r")).toBe(false);
    expect(zcode.includes("\r")).toBe(false);
  });

  it("keeps eight shared skill invariants and the ZCode via choice", async () => {
    const [codex, zcode, command] = await Promise.all([
      readRepoFile(".codex/skills/stinky-cobbler/SKILL.md"),
      readRepoFile(".zcode/skills/stinky-cobbler/SKILL.md"),
      readRepoFile(".zcode/commands/stinky-cobbler.md")
    ]);
    for (const skill of [codex, zcode]) {
      expect(skill).toContain("Never auto-approve");
      expect(skill).toContain("结果：");
      expect(skill).toContain("证据：");
      expect(skill).toContain("边界：");
      expect(skill).toContain("下一步：");
      expect(skill).toContain("Cooperative Mode");
      expect(skill).toContain("UNKNOWN/PENDING");
      expect(skill).toContain("expectedPreimageHash");
      expect(skill).toContain("Delete is never auto-allowed");
      expect(skill).toContain("TaskAuthority");
      expect(skill).not.toContain("数据全部留在本地");
      expect(skill).not.toContain("不依赖任何云服务");
      expect(skill).not.toContain("零配置直接用");
    }
    expect(zcode).toContain("never make the choice");
    expect(command).toContain("不得静默使用默认值");
  });

  it("documents the exact TaskAuthority, Approval, and preimage boundaries", async () => {
    const [readme, security, manual, advanced] = await Promise.all([
      readRepoFile("README.md"),
      readRepoFile("SECURITY.md"),
      readRepoFile("docs/quickstart/使用说明书.md"),
      readRepoFile("docs/quickstart/高级用户配置指南.md"),
    ]);

    for (const document of [readme, security, manual, advanced]) {
      expect(document).toContain("TaskAuthority");
      expect(document).toContain("delegate-capability");
      expect(document).toContain("write-confirm");
      expect(document).toContain("expectedPreimageHash");
      expect(document).toMatch(/preimage/iu);
    }
    expect(security).toContain("exact root scope");
    expect(security).toContain("configured default");
    expect(security).toContain("issuedBy");
    expect(security).toContain("one-shot");
    expect(security).toContain("proposed content hash");
    expect(readme).toContain("auto-allow");
    expect(readme).toContain("不会跳过 TaskAuthority");
    expect(security).toContain("role-to-tools");
    expect(security).toContain("concrete operation");
  });

  it("keeps Runtime cancellation and orchestration cancellation cooperative", async () => {
    const [readme, security, manual, checklist] = await Promise.all([
      readRepoFile("README.md"),
      readRepoFile("SECURITY.md"),
      readRepoFile("docs/quickstart/使用说明书.md"),
      readRepoFile("docs/quickstart/发布前宿主验证清单.md"),
    ]);

    for (const document of [readme, security, manual, checklist]) {
      expect(document).toContain("AbortSignal");
      expect(document).toMatch(/协作式|cooperative/iu);
      expect(document).toMatch(/在途|in[- ]flight/iu);
      expect(document).toMatch(/(?:不是|not).*?(?:硬中断|hard.*kill)/isu);
    }
    expect(security).toContain("monotonic");
    expect(security).toContain("CANCEL_REQUESTED");
    expect(security).toContain("persisted terminal");
    expect(checklist).toContain("Orchestration 边界");
    expect(checklist).toContain("不会撤销已落盘文件");
    expect(security).toContain("PREPARED → COMMITTED");
    expect(security).toContain("runtime reconcile --repair");
  });

  it("separates the source candidate, real-host proof, and public release", async () => {
    const [readme, security, changelog, manual, checklist] = await Promise.all([
      readRepoFile("README.md"),
      readRepoFile("SECURITY.md"),
      readRepoFile("CHANGELOG.md"),
      readRepoFile("docs/quickstart/使用说明书.md"),
      readRepoFile("docs/quickstart/发布前宿主验证清单.md"),
    ]);

    for (const document of [readme, security, manual, checklist]) {
      expect(document).toMatch(/source candidate|源码候选|candidate|候选/iu);
      expect(document).toMatch(/UNKNOWN\s*\/?\s*PENDING/iu);
    }
    expect(changelog).toMatch(/source candidate|源码候选/iu);
    expect(changelog).toContain("2.0.0");
    expect(changelog).toContain("v2.0.1");
    expect(readme).toContain("npm install -g .");
    expect(checklist).toContain("不只是");
    expect(checklist).toContain("同一候选 bytes");
  });

  it("labels historical and declared-only documents without promoting future capabilities", async () => {
    const [core, roles, domain, history, nonDeveloper, threat] = await Promise.all([
      readRepoFile("docs/archive/核心调度内核设计.md"),
      readRepoFile("docs/archive/默认角色与调度策略.md"),
      readRepoFile("docs/archive/通用领域模型与扩展机制.md"),
      readRepoFile("docs/archive/产品设计基线.md"),
      readRepoFile("docs/quickstart/非开发用户使用模型.md"),
      readRepoFile("docs/architecture/威胁模型与权限设计.md"),
    ]);

    expect(core).toMatch(/Dated historical design.*不是当前实现证明/iu);
    expect(roles).toContain("DECLARED_ONLY");
    expect(domain).toContain("DECLARED_ONLY");
    expect(history).toMatch(/Dated historical snapshot.*非当前权威规范/iu);
    expect(history).toContain("已被 2.0.1 收缩定位取代");
    expect(nonDeveloper).toContain("DECLARED_ONLY / NOT_AVAILABLE");
    expect(threat).toContain("same-source review");
    for (const document of [core, roles, domain, nonDeveloper, threat]) {
      expect(document).toMatch(/本地仓库/iu);
      expect(document).toMatch(/不|not/iu);
    }
  });
});
