# Stinky Cobbler 3.x 产品需求（PRD）

> 唯一事实来源。需求变化先改本文件，再改代码。来源与论证见 [架构评审与发展规划-2026-10-20](archive/architecture-review-2026-10-20.md) 与 [ADR-0002](adr/0002-pivot-to-agent-toolkit-package-manager.md)。

## 1. 为什么做

AI 编程工具（Codex、Claude Code、Cursor、ZCode、Gemini CLI…）各有自己的 skill 目录、MCP 配置文件、指令文件格式与作用域。用户想要的是"我自己的工具箱"跟着我走，而不是在每个宿主里手改一遍、改坏了也找不回来。市面同类工具多是"同步脚本"：直接覆盖、无预览、无回滚、不识别用户手改。

## 2. 解决什么问题

用一份声明式 `toolkit.yaml` 描述工具箱，由本工具**安全地**落到各宿主：
- 先 `plan` 看到每个文件的 diff，不写盘；
- `apply` 只改受管内容，用户手改过的文件一律 `conflict` 不覆盖；
- 每次变更有内容寻址备份与本地账本，`rollback` 按 hash 校验逐步回退；
- `doctor` 报告每个宿主的真实状态与漂移。

## 3. 用户

独立开发者与小团队的工程师，使用两个以上 AI 编程宿主，有自己习惯的 skill / MCP / 指令集合，愿意用 CLI。

## 4. 范围

### 3.0.0-alpha.1（M0–M2）
- artifact 种类：`skill`（Agent Skills 规范的 SKILL.md 目录）、`mcp-server`（stdio / http）、`instructions`（受管段落）。3.0.0 只渲染到 Claude Code 的 `CLAUDE.md`（user 与 project 两个作用域）；Codex `AGENTS.md`、Cursor `.cursor/rules/*.mdc`、ZCode skill 段落的路径或格式尚未按宿主文档核实，适配器标为不支持并在 `plan.skipped` 里说明原因，补齐见 PLAN M5-T1。
- 宿主：Codex、Claude Code、Cursor、ZCode。
- 作用域：user、project。
- 命令：`toolkit init | plan | apply | rollback | doctor | list`。
- 配置：每条命令只读一份 `toolkit.yaml`，`--scope user` 读 `~/.config/stinky-cobbler/toolkit.yaml`，`--scope project` 读 `<repo>/.stinky-cobbler/toolkit.yaml`。builtin → user → project 按 `id` 合并尚未实现，见 PLAN M5-T2。
- 密钥：只允许 `${env:NAME}` / `${file:path}` 引用；明文拒绝。

### 3.0.0-beta.1（M3）
- 远程来源（git、npm、skills.sh 只读检索）、`toolkit.lock`、`bundles`、`search`、`update`。

### 3.0.0-rc.1（M4）
- `role: knowledge` 的 MCP server 与数据源管理、记忆指令文件子类型、经核实的 RAG / memory server preset。

### 非目标
- OS 沙箱、模型调用、agent 调度；自建向量库；托管服务与账号；在任何产物中写明文密钥；3.x 内扩展 `gate/`；Gemini CLI 宿主（3.0 GA 后再议）。

## 5. 成功标准（3.0 GA）

| # | 标准 | 验证方式 |
|---|---|---|
| S1 | 四宿主 conformance 测试全绿；真实宿主冒烟各一次有记录（版本 + 候选 hash） | CI + PROGRESS.md 记录 |
| S2 | `plan` 零写盘；`apply` 后 `doctor` 零漂移；`rollback` 后受管目标 byte-for-byte 回到之前 | 黑盒测试断言 HOME 目录 hash 树 |
| S3 | 用户手改过的受管文件永远 `conflict` 不覆盖 | golden 测试 |
| S4 | 从 `npm i -g` 到第一次成功 `apply` ≤ 4 条命令 | quickstart 实测 |
| S5 | `toolkit.yaml` 与所有渲染产物无明文密钥 | package-smoke 扫描扩展到渲染输出 |

## 6. 兼容承诺

2.x 记录可读可终止；2.x 治理命令保持顶层命令，`--help` 标记 `[deprecated 2.x]` 并冻结（CI 守卫 `test/repo/gate-frozen.test.ts`）；2.x 分支只修 P0 至 3.0 GA 后 6 个月；受管文件 sidecar 格式字节级兼容。
