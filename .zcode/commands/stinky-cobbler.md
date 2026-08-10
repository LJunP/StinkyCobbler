---
description: Stinky Cobbler 统一入口：接收 AI 协作请求，按 via=skill|mcp|auto 决定使用 Skill 还是本地 MCP，并返回统一结果。不自动选择、不自动授权、不写业务文件。
argument-hint: "<request> [via=skill|mcp|auto]"
skills:
  - stinky-cobbler
---

# /stinky-cobbler

Stinky Cobbler 的本地统一入口。它把用户请求整理成任务草案或执行一次受控只读任务，并根据 `via` 选择 Skill 或本地 MCP 作为执行通道。

## 参数

- `request`：自然语言请求。
- `via`（可选）：`skill` | `mcp` | `auto`，缺省 `auto`。大小写不敏感。

## 执行规则

1. 解析 `via`；非法值按 fail-closed 处理（见下方 `via=非法值`）。
2. 先运行只读事实检查 `stinky-cobbler entry preflight [--via <via>] [--workspace <path>]`，以它的输出作为决策依据，不要凭猜测判断 workspace 是否初始化或 MCP 是否已配置。
3. 依据 preflight 的 `decision` 与 `via` 执行对应分支。
4. 使用 Skill 的交互流程（见 SKILL.md `## 决策流程`）处理请求。
5. 输出统一格式（见 SKILL.md `## 统一输出格式`）。

## via 语义

- `via=skill`：只用 Skill 的能力（解释、规划、推荐、校验、生成 CLI 调用计划）。不启动、不调用 MCP，不做本地读取。
- `via=mcp`：先 preflight；当 `mcpConfigured: true` 时经宿主 MCP client 调用已注册的 `stinky-cobbler-mcp` 工具。当 `mcpConfigured: false` 时明确报告 MCP 未配置并给出 `stinky-cobbler entry mcp-config` / `install-host --mcp` 指引，**不静默回退到 skill**。
- `via=auto`（缺省）：仅当请求需要读取本地文件、仓库或控制面状态时才走 MCP；纯问答/规划只用 Skill。

## 决策分支

- preflight `decision=skill-only` 或 `via=skill`：只走 Skill 分支。
- preflight `decision=mcp-available` 且 `via=mcp`：走 MCP 分支。
- preflight `decision=mcp-missing`：报告配置状态，展示 `entry mcp-config` 模板或 `entry install-host --mcp` 指引，不执行 MCP、不回退。
- preflight `decision=workspace-uninitialized`：报告 workspace 未初始化，给出 `init --dry-run` 预览路径，等待用户选择后再初始化。
- preflight `decision=invalid-via`：返回稳定错误结构，不执行任何能力。

## 禁止事项

- 禁止静默切换执行模式；每次只按解析出的 `via` 与 preflight 结果执行一个分支。
- 禁止自动运行 `stinky-cobbler entry install-host`；只有用户明确要求安装/配置宿主时才执行。
- 禁止自动签发 Lease（`lease issue` 必须由用户确认后执行；签发仅限只读 L0 capability）。
- 禁止把拒绝变成批准：CLI/MCP 的策略结果具有权威性。
- 禁止读取 `.env`、凭据、私钥、token 或受限数据；禁止写业务文件；禁止自动批准、自动标记 Task `DONE`。
- 禁止调用 `test-run`（未注册）或把内部错误码当作最终结论展示给用户（见 SKILL.md `## 统一输出格式`）。

需要本地读取时，先向用户确认，再运行 `stinky-cobbler lease issue`（capability 限 `repository-read` / `git-read` / `docs-index`，默认 L0 只读），然后用已签发的 lease 执行 MCP 工具或 Runtime；不要手写 lease JSON。

多步骤任务先建立调度计划：`stinky-cobbler plan create --task <id>` → `plan show` 展示步骤给用户 → 用户确认后走 `approval request`（action=`plan-confirm`，scope=[planId]）+ `approval decide` → `plan confirm`。计划确认前不得执行任何步骤。

计划执行（调度器只授权与推进，宿主执行实际工作）：`plan execute` → 对每个步骤 `plan step <id> <stepId>`（签发该步骤的受控 lease）→ 用签发的 lease 调用 MCP 工具完成该步骤 → `plan step-done <id> <stepId> --evidence <ref>`（报告该步骤产生的引用，下一步骤经 `plan show` 读取）→ 全部完成后 `plan finish <id>`；步骤失败用 `plan step-fail`，计划失败用 `plan fail`。

实际的 CLI `--help` 与 MCP 注册工具列表是可用性的事实来源。
