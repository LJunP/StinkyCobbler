# Codex 宿主实测指南（2.0 完整编排）

> 目的：在 **Codex**（真实宿主）中跑通 2.0 多 Agent 编排完整闭环，验证
> Codex subagent 继承 MCP、子 agent 持 Lease 干活、约束引擎、升级恢复、
> 审计链全部真实生效。ZCode 侧已复测通过（见基线 2026-08-11 记录）。

## 0. 前置条件（先自查，全部满足再开始）

| 检查项 | 命令/位置 | 预期 |
|---|---|---|
| 全局 CLI 版本 | `stinky-cobbler --version` | 1.0.0 |
| Codex skill 已装 | `stinky-cobbler entry preflight --host codex` | `skillConfigured: true`（或已手动安装） |
| Codex MCP 已注册 | `~/.codex/config.toml` 有 `[mcp_servers.stinky-cobbler-local]` | 存在且 command 为绝对路径 |
| Codex 会话里能看到 MCP 工具 | 新开 Codex 对话，输入 `/mcp` 或问"你有哪些 stinky-cobbler 工具" | 列出 8 个读工具（validate_contract/resolve_config/recommend_task/evaluate_lease/repo_read/repo_list/git_read/docs_index） |
| 临时测试目录 | `mkdir -p /tmp/codex-test && cd /tmp/codex-test && mkdir docs` | 目录就绪 |

> ⚠ Codex 需要**新会话**（MCP 工具在会话启动时加载）。

## 1. 实测总览

| 步骤 | 内容 | 关键验证点 |
|---|---|---|
| 1 | 激活 skill + 初始化 workspace | skill 激活、init 生成 4 模板 |
| 2 | 领域确认 + 契约 + 预算预估 | 用户点选确认、estimate 展示 |
| 3 | 子任务拆解 + 派发 | 专才指令注入、Lease 绑定 |
| 4 | **子 agent 执行** | Codex subagent 继承 MCP、受控写入 |
| 5 | 审查（双通道） | criteria 对应校验、tokensUsed 上报 |
| 6 | 升级 → resume | ESCALATED → 人工点选 → resume |
| 7 | 审计回放 | ledger verify、事件链完整 |

## 2. 逐步骤提示词（复制到 Codex 对话，逐条执行）

### 步骤 1：激活 skill + 初始化

```
使用 stinky-cobbler，初始化 /tmp/codex-test 这个 workspace（profile team，pack software-engineering，mode reviewed-workflow），并创建任务（id: codex-task，目标：编写医疗文档，DRAFT 状态创建后转到 SCOPED）。
```

**观察**：init 成功（输出含 scaffolds 4 个文件 + verifyCommands）；`config show` 可查看默认配置。

### 步骤 2：领域确认 + 契约 + 预算确认

```
现在用编排方式处理这个任务。先做领域确认：这个任务是医疗文档编写，领域应该是 medical。请创建契约（orchestration contract create，domain medical），验收标准 4 条：docs exist / no patient data / structure correct / consistent。然后创建 run 并展示预算预估让我确认。
```

**观察**：
- 契约创建成功（recommendation: orchestrate）
- `run create` 返回 `estimate`（预估子任务/轮次/token）→ **你确认预算**后再继续
- 若你想验证分层配置：先写 `.stinky-cobbler/policies/orchestration.yaml`（`maxRounds: 7`），再建 run，`run.budget.maxRounds` 应为 7

### 步骤 3：子任务拆解 + 派发

```
给这个 run 添加子任务：goal「编写 docs/guide.md 医疗文档」，验收标准 2 条（guide.md exists / no patient data in file），scope docs，capabilities 含 repository-read 和 repository-write。然后派发给 agent worker-1。
```

**观察**：
- 子任务包 `domainInstructions[0]` 应为 `[专才] 妙手仁心（领域 medical）`（若你没自定义专才，则为内置 general 的 `[专才] 通用工程执行者`——注意：内置种子没有 medical，会回退 general，属正常）
- dispatch 成功 → 返回 2 个 Lease（repository-read + repository-write），`dispatchedAgentId: worker-1`

### 步骤 4：子 agent 执行（核心验证）

```
请用 subagent 启动一个 worker 子 agent 执行这个子任务：向 docs/guide.md 写入一份医疗文档（不含患者信息）。
给子 agent 的信息：workspace=/tmp/codex-test，write intent 先创建（write request --run <id> --subtask <id> --auto-allow），write lease 和 read lease 的完整 JSON 从 lease list 取，让它持 lease 调用 MCP repo_write（或 CLI write apply）写入，然后用 repo_read 验证。
```

**观察**：
- Codex 成功 spawn 子 agent，子 agent 能调用 MCP 工具（继承父会话 mcp_servers）
- 写入走受控通道（`write-applied` + evidence），**不是直接写文件**
- 子 agent 若传错参数被拒（LEASE_INVALID / CROSS_WORKSPACE_DENIED），应如实报告而不是绕过

> 📌 MCP 调用防坑（Codex 侧同样适用）：
> ① lease 参数传**完整对象**（`lease list --json` 取），传 id 字符串会 LEASE_INVALID；
> ② workspace 传 **canonical 路径**（`realpath` 后的，如 /private/tmp/...），传符号链接路径会 CROSS_WORKSPACE_DENIED。

### 步骤 5：审查（双通道 + token 上报）

```
子任务已产出。请做双通道审查：
1. 工具验证：artifact report（校验 contentHash 与范围）
2. LLM 审查：review record，criteriaResults 必须与子任务验收标准完全一致（2 条），reviewedBy 用独立身份 reviewer-1（不要用执行者 worker-1），tokensUsed 上报本轮的 token 消耗（估算即可，如 1200）
```

**观察**：
- `artifact.status: VERIFIED`
- review 成功；若 criteriaResults 写了验收标准以外的标准 → `REVIEW_CRITERION_MISMATCH` 拒绝（可故意试一次验证）
- `run.budget.usedTokens` = 上报值（预算生效）
- reviewedBy=reviewer-1 ≠ 执行者 → 无 sameSourceReview 标记
- 若 review ACCEPTED 且全部子任务完成 → `run.status: COMPLETED`

### 步骤 6：升级 → resume（可选项，完整验证恢复路径）

> 若步骤 5 直接 COMPLETED，可再开一个 run 专门验证升级恢复（或用振荡触发：同缺陷 REJECTED 两次）。

```
这个 run 需要人工决策：先 escalate（原因：review 后需要调整预算再继续），然后我选择继续——执行 run resume --max-rounds 9，然后重新派发子任务重做，直到 ACCEPTED。
```

**观察**：
- ESCALATED 状态下 dispatch 被拒（RUN_STATE_CONFLICT）
- resume 后 RUNNING + `budget.maxRounds: 9` + `resumedAt` 有值
- ledger 出现 `orchestration-resumed` 事件

### 步骤 7：审计回放

```
最后验证审计：ledger verify，并列出本次编排的所有事件（contract-created 到 orchestration-completed）。
```

**观察**：`ledger verify: true`；事件链完整：
`contract-created → run-created → lease-issued → subtask-dispatched → write-applied → artifact-recorded → review-recorded → subtask-accepted → orchestration-completed`（含升级路径时：`orchestration-escalated → orchestration-resumed`）。

## 3. 验收标准

| # | 标准 | 判定 |
|---|---|---|
| 1 | Codex 会话中 skill 显式激活且 MCP 工具可见 | 步骤 0 |
| 2 | 完整编排闭环（契约→派发→子 agent 执行→审查→接受→完成） | 步骤 2-5 |
| 3 | 子 agent 通过 MCP/CLI 受控通道写入（evidence + write-applied），非直接写文件 | 步骤 4 |
| 4 | token 上报进 run 预算（usedTokens 非 0） | 步骤 5 |
| 5 | criteria 对应校验生效（编造标准被拒） | 步骤 5 |
| 6 | 升级后 resume 可恢复运行（如走步骤 6） | 步骤 6 |
| 7 | ledger verify true，事件链可完整回放 | 步骤 7 |
| 8 | 任何"绕过受控通道直接写文件"行为 → 整体失败 | 全程 |

## 4. 失败判定与处理

- 子 agent 无法调用 MCP → 检查 `~/.codex/config.toml` 注册（`install-host --host codex --mcp`）、Codex 版本支持 subagent mcp_servers 继承
- 命令被拒（WRITE_LEASE_DENIED 等）→ 检查 lease capability 与命令是否匹配（不要试图绕过）
- 配置加载失败（TIERED_CONFIG_*）→ 按错误响应里的 `fix` 指引修复
- 复测环境：用 `/tmp/codex-test` 全新目录，避免污染真实项目

## 5. 完成后的清理

```bash
rm -rf /tmp/codex-test
```

> 实测结果请回填到 [发布前宿主验证清单](./发布前宿主验证清单.md) 的 O1-O5 与通过标准。
