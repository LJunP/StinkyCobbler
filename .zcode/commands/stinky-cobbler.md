---
description: Stinky Cobbler 入口：为 ZCode 本地仓库操作提供 Cooperative Mode 下的 TaskAuthority、精确 Approval、Lease、单目标 WriteIntent、preimage 与审计门禁。
argument-hint: "<request> [via=skill|mcp|auto]"
skills:
  - stinky-cobbler
---

# /stinky-cobbler

这是 **Codex/ZCode 本地仓库的可验证权限与变更门禁**入口，不是自动 Agent 调度器。

## 参数

- `request`：用户请求。
- `via=skill|mcp|auto`：仅对本次请求有效。未提供时必须展示三种模式并等待用户选择，**不得静默使用默认值**。

## 执行

1. 解析本次 `via`。
2. 运行只读 `stinky-cobbler entry preflight --host zcode --workspace <path> --via <mode> --json`。
3. 按 SKILL.md 核验当前 persisted Task、TaskAuthority、精确 Approval（需要时）和 persisted Lease。
4. 只经 Stinky Cobbler CLI/MCP 执行；MCP 只提交 Lease ID，由服务端重载权威记录。
5. 输出“结果 / 模式 / 证据 / 边界 / 下一步”。

`mcpConfigured=true` 只说明检测到配置，不证明 ZCode 已加载或验证 MCP。每组候选 bytes 的真实 ZCode 安装、重启和消费者 E2E 在完成当前清单前都是 `UNKNOWN/PENDING`。

## 禁止事项

- Cooperative Mode 外的 ZCode 文件工具、Shell、Git 写入或第三方 MCP 不受本门禁保证；不得用它们绕过拒绝。
- 不自动运行 `entry install-host`。用户明确要求配置时，先展示 `--dry-run --json`，再等待确认。
- 不自动批准、扩权、标记 Task `DONE`、commit/push/publish/deploy。
- 不自动创建多 Agent；`orchestration` 只是本地状态/预算/产物门禁，不保证宿主失败隔离。Contract 创建时 `individual=SELF_REVIEW_AUDITED`，同源审查保留 `sameSourceReview`；`team`/`organization`/`regulated`/缺失配置=`INDEPENDENT_REQUIRED` 并拒绝 same-source review。
- 编排 dispatch 必须先读 Subtask 的 `retriesUsed`，begin/artifact/review 必须传同一 `activeAttempt`；resume 必须先读 Run 并传当前 escalation 的下一 generation。旧 token 被拒绝后不得盲目递增；新一代 Run 必须用 `--supersedes-run` 绑定终态前驱。
- 不宣称“全本地/离线”；宿主、模型与插件的网络行为不由本项目证明。
- 不把 CAS/Context/Memory 写成当前已实现。`kind=summary` / `kind=evidence` 必须拒绝。

## 写入

- 每个 WriteIntent 恰好一个目标。
- 创建 intent 时捕获 `expectedPreimageHash`；apply 前重读，漂移就停止并重新请求/批准。
- 非 auto-allow 写入使用一次性精确 `write-confirm` Approval，绑定 intent hash、版本、目标、preimage，并可绑定 proposed content hash。
- create/modify 的 `--auto-allow` 只跳过 write-confirm；TaskAuthority capability Approval、Lease/writeSet、intent hash、路径和 preimage 门禁仍然执行。delete 永不 auto-allow。
- 成功变更后才记录 `APPLIED`。业务文件、Evidence、ledger、状态不是一个事务。
- 完整单目标 `APPLIED` journal 且无第三方冲突时，create 回滚删除本次新文件，modify/delete 恢复独占备份；多个 intent 不是全有或全无事务。

## 取消与超时

只读 Runtime 的 cancel/deadline 是同进程 `AbortSignal` + 单调计时 + 边界检查，不是 ZCode Agent/进程硬中断。`CANCEL_REQUESTED` 后要查询最终 Run；若停止与在途调用竞争，底层结果按 `UNKNOWN` 报告。成功 read 会在 owner/epoch fence 下 checkpoint，但终态仍需 `PREPARED→COMMITTED` Run/Receipt/audit finalization；缺失、损坏或冲突 journal fail-closed。编排取消会撤销相关 Lease、拒绝未应用 intent，但不会撤销已落盘文件或终止宿主 worker。

实际 CLI `--help`、当前源码、持久化 workspace 记录和 ZCode 已注册 MCP 工具列表是能力事实来源。
