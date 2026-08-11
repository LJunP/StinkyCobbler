/** Out-of-the-box customization templates: init scaffolds commented example files under .stinky-cobbler/policies/. */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { LocalWorkspace } from "../storage/workspace.js";
import { userPoliciesDir } from "./tiered.js";

const HEADER = `# ============================================================
# Stinky Cobbler 用户配置模板（由工具初始化时自动生成）
# ------------------------------------------------------------
# 这个目录 = 你的「个性化配置层」，优先级高于工具内置默认值。
# 使用方法：
#   1. 需要自定义哪一项，取消注释并改成你的值即可；
#   2. 未出现的键自动使用内置默认值（随工具版本更新）；
#   3. 保存文件后即时生效，无需重启；
#   4. 本文件被删除后下次 init/scaffold 会重新生成，但绝不覆盖
#      你已经修改过的文件。
# 查看生效值：stinky-cobbler orchestration config show --root <项目路径>
# 完整说明：docs/quickstart/分层配置指南.md
# ============================================================
version: 1
`;

const ORCHESTRATION_TEMPLATE = `# defaults:   ← 需要自定义时：取消注释此行，再取消注释下方要改的键
#   ── 编排预算（全局累计，不随轮次重置）────────────────────
  # 全局轮次上限。大任务可放宽（例：10），小任务收紧（例：3）。
  # maxRounds: 5
  # 单个子任务的重做上限（拒绝后重做的次数）。
  # maxRetriesPerSubtask: 2
  # 全局 token 预算（子任务累计消耗的上限）。
  # maxSubtaskTokens: 200000

  # ── 成本估算（run create 前的预算预览参数）─────────────
  # 每个子任务每轮预估消耗的 token 数。
  # costTokensPerSubtaskRound: 8000
  # 预估成本达到该值时推荐走编排（否则推荐直接执行 1.0 路径）。
  # orchestrateTokenThreshold: 50000

  # ── 规模与上限（大项目可放宽）───────────────────────────
  # 契约全局验收标准条数上限（默认 20）。
  # maxContractCriteria: 20
  # 子任务验收标准条数上限（默认 10）。
  # maxSubtaskCriteria: 10
  # 单次审查最多可记录缺陷数（默认 20）。
  # maxDefects: 20
  # 子任务最多引用输入产物数（默认 20）。
  # maxInputArtifacts: 20
  # 契约 scope 前缀数量上限（默认 50）。
  # maxContractScopeItems: 50
  # 子任务 scope 前缀数量上限（默认 50）。
  # maxSubtaskScopeItems: 50

  # ── 受控写入 ─────────────────────────────────────────────
  # 单次写入内容大小上限（字节，默认 1MiB = 1048576）。
  # 大文件项目可放宽（例：5MiB = 5242880）。
  # maxWriteContentBytes: 1048576

  # ── Lease 授权默认值 ────────────────────────────────────
  # 签发 lease 时未指定时长的默认分钟数（默认 60）。
  # leaseDefaultMinutes: 60
  # lease 时长上限（分钟，默认 1440）。
  # leaseMaxMinutes: 1440
  # lease 到期宽限期（分钟，默认 15，进行中任务不中断）。
  # leaseGraceMinutes: 15

  # ── 审查质量门 ──────────────────────────────────────────
  # 自动否决阈值：ACCEPTED 且分数低于此值 → 引擎强制改为 REJECTED
  # （防止 LLM 给低质量产物打高分放行）。0 = 关闭（默认）。
  # 例：autoRejectScoreThreshold: 60
  # autoRejectScoreThreshold: 0
  # 每轮目标一致性检查失败时自动升级运行（默认 false = 人工判断）。
  # autoEscalateOnConsistencyFail: false

  # ── 防打磨护栏（⚠ 只可收紧，不可放宽）───────────────────
  # 同一缺陷指纹出现多少次即判定振荡并升级（默认 2）。
  # 只能设 1（更严格）；设 3 会被拒绝加载。
  # oscillationThreshold: 2

# ── 追加敏感路径（只增不减）──────────────────────────────
# 项目特有的禁止读写路径（如 internal/、secrets/）。
# 写在这里的路径永远拒绝读取与写入；内置敏感清单不可删除。
# sensitiveExtraPaths:
#   - internal/
`;

const SPECIALISTS_TEMPLATE = `# ── 专才注册表（自定义你的专业 worker）─────────────────────
# 每个专才包含：domain（领域标识）、title（显示名称，可自定义）、
# instructions（专业指令）、acceptanceChecklist（验收清单）、
# negativeRules（禁区）、suggestedCapabilities（建议能力）。
# 匹配规则：精确 → 前缀（frontend/forms → frontend）→ general 回退。
# 语义：同名 domain = 完全覆盖内置专才（含名称）；新 domain = 追加。
# ⚠ general 回退专才可改名但不可删除（未知领域必须有兜底）。
#
# 示例一：覆盖内置「前端专才」并自定义名称：
# specialists:
#   - domain: frontend
#     title: 像素魔法师
#     instructions:
#       - 遵循项目既有组件模式，不另起炉灶。
#     acceptanceChecklist:
#       - 关键交互在代码层面可验证。
#     negativeRules:
#       - 不全局重排样式。
#     suggestedCapabilities:
#       - repository-read
#       - repository-write
#
# 示例二：追加全新领域（如医疗）：
#   - domain: medical
#     title: 妙手仁心
#     instructions:
#       - 以患者数据安全为先。
#     acceptanceChecklist:
#       - 隐私零泄露。
#     negativeRules:
#       - 不输出患者信息。
#     suggestedCapabilities:
#       - repository-read
# 注意：specialists 键取消注释后，写几个就是「内置 + 你的」合并结果。
`;

const TEMPLATES_TEMPLATE = `# ── 话术 / 审查风格 / 指令语言模板 ─────────────────────────
# 这些是 orchestrator skill 消费的指导字典（config show 可查看）。
# 想改交互文案：编辑宿主侧 skill 文件（SKILL.md）最直接。
# domainConfirmation:
#   prompt: 识别到问题领域：{domain}。请确认或一句话修正。
# reviewStyle:
#   default: reason 直述结论；defects 每条含位置、问题、建议。
#   concise: reason ≤2 句；defects 每条一行。
# instructionsLanguage:
#   default: zh
#   options: [zh, en]
`;

const CONTRACT_TEMPLATES_TEMPLATE = `# ── 契约模板库（一键建契约）─────────────────────────────────
# 用法：stinky-cobbler orchestration contract from-template <name> --task <id> --root <路径>
# 语义：同名 name = 替换内置；新 name = 追加。
# 模板字段：name（模板名）、description（说明）、domain（领域，需与专才对应）、
# goal（目标）、criteria（验收标准）、scope（产出范围）。
# 示例：追加你自己的任务模板：
# templates:
#   - name: my-audit
#     description: 我的季度文档审计
#     domain: compliance
#     goal: 审计并修订项目文档
#     criteria:
#       - 术语与既有文档一致
#       - 无敏感信息泄露
#     scope:
#       - docs
`;

const SCAFFOLD_FILES: { fileName: string; body: string }[] = [
  { fileName: "orchestration.yaml", body: ORCHESTRATION_TEMPLATE },
  { fileName: "specialists.yaml", body: SPECIALISTS_TEMPLATE },
  { fileName: "templates.yaml", body: TEMPLATES_TEMPLATE },
  { fileName: "contract-templates.yaml", body: CONTRACT_TEMPLATES_TEMPLATE }
];

/**
 * Writes the out-of-the-box commented templates under .stinky-cobbler/policies/.
 * Never overwrites existing files (user edits survive). Returns the created file names.
 */
export async function scaffoldUserPolicies(workspace: LocalWorkspace): Promise<string[]> {
  const directory = userPoliciesDir(workspace);
  const created: string[] = [];
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const { fileName, body } of SCAFFOLD_FILES) {
    const file = path.join(directory, fileName);
    try {
      await writeFile(file, `${HEADER}${body}`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      created.push(fileName);
    } catch (error: unknown) {
      // EEXIST: user file already present — keep it untouched.
      if (!isCode(error, "EEXIST")) throw error;
    }
  }
  return created;
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
