# Stinky Cobbler

> 面向多领域工作的、以产物和证据为中心的本地隔离式 AI Agent 协作控制面。

Stinky Cobbler 不是模型、聊天机器人或业务执行器。它通过 Profile、Pack、Task Capsule、短时 Capability Lease、Evidence Reference、Receipt 与审计门禁，约束 AI 协作中的建议和**受控只读探索**。

```text
Profile + Pack
→ Task Charter
→ 显式 Task Capsule + L0 Capability Lease
→ 单次只读 Agent Run
→ Tool Call / Evidence Reference / Receipt
→ 人工审核与后续决策
```

它可用于软件研发、研究、内容创作、运营、教育和数据分析等任务。推荐候选可以标注 **（推荐）**，但工具与 Skill 永远不替用户选择 Profile、Pack、模式、Lease 或审批。

## 统一入口 `/stinky-cobbler`

安装后，用户可以像引用一个 Skill 一样使用统一入口：

```text
/stinky-cobbler <request> [via=skill|mcp|auto]
```

`via`（可选，缺省 `auto`）决定本次请求的执行通道：

| via | 行为 |
|---|---|
| `skill` | 只用 Skill 的解释、规划、推荐与校验能力；不启动、不调用 MCP，不做本地读取 |
| `mcp` | 经宿主 MCP client 调用本地 `stinky-cobbler-mcp` 工具；未配置 MCP 时明确报告并给出配置指引，不静默回退 |
| `auto` | 仅当请求需要读取本地文件、仓库或控制面状态时才走 MCP；纯问答/规划只用 Skill |

入口的决策依据是只读事实检查，不是猜测：

```bash
stinky-cobbler entry preflight [--via <via>] [--workspace <path>]
```

`preflight` 永远不创建 workspace、不写任何文件；它返回 `via` 解析结果、workspace 是否初始化、MCP 是否已配置，以及最终 `decision`（`skill-only` / `mcp-available` / `mcp-missing` / `workspace-uninitialized` / `invalid-via`）。

为了让宿主（如 ZCode）发现 `/stinky-cobbler` 命令，需要显式安装一次（**不会自动运行**）：

```bash
# 只安装命令文件（默认 user 作用域）
stinky-cobbler entry install-host --dry-run    # 先预览
stinky-cobbler entry install-host              # 确认后安装

# 同时注册本地 MCP server（需要用户明确指定 --mcp）
stinky-cobbler entry install-host --mcp --dry-run   # 先预览完整 diff
stinky-cobbler entry install-host --mcp              # 确认后写入并备份

# Codex 宿主（无命令文件；skill → ~/.codex/skills/，MCP → ~/.codex/config.toml）
stinky-cobbler entry install-host --host codex --mcp --dry-run   # 先预览
stinky-cobbler entry install-host --host codex --mcp              # 确认后安装
```

- `install-host` 从不覆盖已存在的不同内容；写宿主配置前会在同目录备份原文件。
- 安装包不包含 `postinstall`，不会在安装时自动修改宿主 `.zcode/`。
- 单独查看 MCP 注册模板：`stinky-cobbler entry mcp-config`。

Skill 会依据 `preflight` 事实和 `via` 选项执行唯一分支，并把结果按“结果 / 证据 / 边界 / 下一步”统一输出；内部错误码只对调试用户以 `--json` 暴露。

## v1.0 Durability Foundation（当前开发批次）

当前 v1.0 第一批已为控制面元数据加入跨进程一致性基础：同一 workspace 的可变 JSON/JSONL 操作经过 `.stinky-cobbler/workspace.lock` 互斥，JSON 临时文件和 ledger append 会在 rename/返回前执行文件 `fsync`，并尽力同步元数据目录；Lease usage、Audit outbox、Task、Receipt、Run 和配置迁移的读改写路径使用同一锁。Receipt/outbox/ledger 仍不是数据库事务，崩溃窗口通过显式 `audit recover` 或后续诊断处理，不会自动批准、签发 Lease 或推进 Task 到 `DONE`。

锁的 stale-owner 恢复只在能确认 owner 进程不存在且超过安全时间阈值时进行；无法证明 stale 时返回 `WORKSPACE_LOCK_BUSY`。缺失或损坏 owner 的锁也默认保持 busy，只有锁目录本身的年龄满足保守的本地恢复规则时才会进入隔离回收。lock owner 的 `heartbeatAt` 是静态 stale 参考时间，不是周期性心跳；**RUNNING Run 则新增周期 `heartbeatAt`**：执行器在请求边界约每 30 秒写一次存活声明（wall-clock ISO），`runtime recover` 的 stale 判定以 `heartbeatAt ?? startedAt ?? createdAt` 为基准，心跳新鲜时拒绝恢复。Run 心跳是尽力而为的存活声明，写入失败不影响请求执行，也不产生 ledger 事件；它不是存活证明、分布式 fencing、签名、可信时间或外部见证。锁和本地 SHA-256 链不提供签名、身份认证、可信时间、外部见证或恶意重写防护。ledger 非法尾部默认只报告问题，不自动截断或重写。


## v1.0 第二批：Explicit Approval Records

Approval 已从仅有 Schema 的声明扩展为 workspace-local、可持久化、可审计的显式记录。可使用 `approval request/show/list/decide/inspect` 管理请求与人工决定，也可使用 `task approval-preflight` 进行只读检查。

`approved` 只表示匹配的 approval preflight 满足；不等于自动签发 Lease、执行授权、业务写入或 Task `DONE`。`L3` 仍不可执行，缺失、拒绝、过期、撤销、Task/action/scope 不匹配的 Approval 都不会通过 preflight。Runtime、Receipt 和 audit recovery 不会自动创建或批准 Approval。

Approval 记录可带可选的 `expiresAt`（request 或 decide 时设置）。有效期是**评估时判定**：preflight 只匹配未过期的 approved 记录（`expiresAt` 为空视为永不过期），`approval inspect` 会投影 `expired` 布尔；过期**不会自动改写**存储中的 `status`——`expired` 持久状态仍由人工显式决定。`expiresAt` 必须晚于 `requestedAt`；它只是本地时间约束，不是可信时间或外部见证。

## v1.0 第三批：Persistent Evidence References

Runtime 成功的只读 Tool Call 会把 EvidenceRef metadata 持久化到 `.stinky-cobbler/evidence/`，并可通过 `evidence list/show/inspect` 只读查询。记录只包含 ID、来源、locator、hash、时间、敏感级别和 Tool Call 引用；不会保存源文件正文或任意工具输出原文。当前 `contentHash` 仍是 tool-output envelope 的 SHA-256，不是原始文件 bytes 证明、签名、可信时间或外部见证。

Evidence persistence 不启用 Evidence Gate，不自动满足 Approval、不授权业务写入、不修改 Task 状态或推进 `DONE`。Approval 与 Evidence 是独立门槛；Evidence 持久化失败必须使 Tool Call/Run 如实阻断，不能返回一个指向不存在记录的成功引用。



- Plugin Manifest v2 明确状态、operation、scope/side-effect 元数据、审计模式、受信任实现引用和来源。
- Plugin discovery 按稳定顺序加载，并拒绝重复 Plugin ID 或 operation；manifest 存在不代表能力可执行。
- `doctor`、`config show/doctor` 和 MCP `resolve_config` 输出逐项 Plugin 诊断及受信任 Adapter 状态。
- Workspace Config v2 支持显式 `plugins.<id>.enabled` 选择；v1 配置可通过 `config migrate` 显式迁移，迁移会创建受控备份并写入审计事件。
- Runtime 通过静态 Adapter registry 解析 executor；唯一可执行 Adapter 仍是 `scripted-readonly`。
- 不从 manifest、workspace config 或 CLI 路径动态加载模块，不下载 Plugin，不允许 Plugin 自行注册工具或获取权限。

Plugin 状态含义：`available` 表示存在受信任实现，`internal` 不代表公开注册，`declared-only` 仅用于 Pack 推荐和未来规划，`unavailable` 不可执行。推荐、发现、可用和执行授权是四个不同概念。

`COMPLETED` 仍仅表示该 **Agent Run** 结束；它不代表 Task 验收、批准、状态流转或 `DONE`。

## 安装与验证

从发布包安装后：

```bash
npm install -g stinky-cobbler
stinky-cobbler --help
stinky-cobbler doctor --json
stinky-cobbler-mcp
```

从源码验证公开包（不执行发布）：

```bash
npm install
npm run typecheck
npm test
npm run test:integration
npm run test:package
```

`test:package` 会检查打包清单，在临时目录安装本地 tarball，并验证 CLI 与 stdio MCP 的初始化/工具发现。不会运行 `npm publish`。

发布版本门禁：git tag 必须严格等于 `v${package.json.version}`，`workflow_dispatch` 必须显式声明与 package.json 一致的版本；`release-candidate` workflow 通过 `scripts/release-gate.mjs` 强制校验（`check:version` 只做文件间一致性，版本门禁额外校验 tag/声明版本）。版本单一来源是 `package.json`，`release-contract` 测试不硬编码任何具体版本。门禁是验证层，不会自动改版本或发布。

发布制品清单：`release-candidate` workflow 会生成依赖 SBOM（`scripts/generate-sbom.mjs`，CycloneDX 1.5，覆盖 package-lock 完整依赖树并带 SHA-512 完整性哈希）与 tarball checksum（`scripts/generate-checksum.mjs`，sha256sum 兼容格式），并校验二者与 lockfile/制品一致。SBOM 是依赖清单 + 完整性哈希，不证明依赖无漏洞、不证明构建可复现、不是签名；checksum 防传输损坏，不防恶意改写（需发布侧签名才有防伪意义）。provenance 与制品签名只在真实发布时通过 `npm publish --provenance` 完成（需 OIDC/密钥），当前仓库不做。

## CLI 能力矩阵

| 入口 | 状态 | 边界 |
|---|---|---|
| `doctor`、`recommend`、`validate` | 已实现 | 本地检查或建议；doctor 输出 Plugin/Adapter 状态；不选择、不签发 Lease、不修改输入 |
| `init` | 已实现 | 创建 `.stinky-cobbler/workspace.json` 与 `ledger.jsonl`；不写业务文件；初始化账本记录为 `workspace-initialized` |
| `config show/validate/doctor` | 已实现 | 只读读取、解析和校验 workspace config；不迁移、不写盘 |
| `config migrate [--dry-run]` | 已实现 | 仅显式执行 v1 → v2 控制面迁移；dry-run 不写盘，正式迁移备份并记录 `workspace-config-migrated` |
| `task create/list/show/status/plan/transition/cancel`、`task approval-preflight` | 已实现 | 只管理控制面任务或只读检查；不执行业务工作或自动 `DONE` |
| `approval request/show/list/decide/inspect` | 已实现 | 仅显式记录与人工决定；不自动授权、不签发 Lease、不推进 Task |
| `lease issue/show/list/revoke` | 已实现 | 用户确认后签发受控只读 L0 Lease（capability 限 repository-read/git-read/docs-index，默认有效期 60 分钟、maxToolCalls 20），持久化并审计；绝不自动签发 |
| `plan create/show/list/confirm/cancel/execute/step/step-done/step-fail/finish/fail` | 已实现 | 结构化调度计划（角色步骤/工具/读取范围/写入意图占位），确认走 action=plan-confirm 的 Approval；执行时调度器按步骤签发受控 Lease 并推进状态，宿主负责实际工作 |
| `receipt validate/record/list/show/inspect` | 已实现 | 只管理 `.stinky-cobbler/receipts/*.json`；不会批准或授权 |
| `runtime validate/run/show/cancel/recover` | 已实现 | 显式 L0 Lease/Capsule 的单次受控只读运行；见下方限制 |
| `runtime diagnose [runId]` | 已实现 | 只读 Run/Ledger/Receipt 生命周期诊断；不修复、不恢复、不授权；非原子快照 |
| `evidence list/show/inspect` | 已实现 | 仅查询持久化 EvidenceRef metadata；不保存或导出源内容，不启用 Evidence Gate |
| `entry preflight` | 已实现 | 只读返回 via/workspace/MCP 入口事实；不创建 workspace、不建锁、不写文件 |
| `entry install-host [--mcp] [--dry-run]` | 已实现 | 显式安装 `/stinky-cobbler` 命令文件并可选注册本地 MCP；dry-run 只预览，写入前备份，绝不自动运行或覆盖异内容 |
| `entry mcp-config` | 已实现 | 打印本地 MCP server 注册 JSON 模板 |
| `audit pending/recover`、`ledger verify` | 已实现 | 控制面审计检查与受限恢复；没有公开任意 ledger append |
| `test-run` | 未注册 | 不属于公开 CLI/MCP/Runtime 能力，绝不执行 |

## Workspace Config

先由用户明确选择 workspace、Profile、Pack 与 mode；推荐不等于选择。重复 `--pack` 可以选择多个 Pack，所有 Pack 必须由所选 Profile 启用，重复 Pack 会被拒绝。

```bash
stinky-cobbler init \
  --workspace-id example-workspace \
  --profile team \
  --pack software-engineering \
  --mode reviewed-workflow \
  --root /absolute/path/to/workspace \
  --dry-run
```

确认预览后，去掉 `--dry-run`。已存在 `workspace.json` 时 `init` 拒绝覆盖。

```bash
stinky-cobbler config show --root /absolute/path/to/workspace --json
stinky-cobbler config validate --root /absolute/path/to/workspace --json
stinky-cobbler config doctor --root /absolute/path/to/workspace --json
stinky-cobbler config migrate --root /absolute/path/to/workspace --dry-run --json
stinky-cobbler config migrate --root /absolute/path/to/workspace --json
```

Workspace Config v2 中，Pack 的 `recommendedPlugins` 只是提示，不会自动启用 Plugin。未出现在 `plugins` 中是 `unset`，`enabled: false` 是明确禁用，`enabled: true` 仅接受发现且具有受信任实现的 executable Plugin：

```json
{
  "version": 2,
  "plugins": {
    "repository-read": { "enabled": true },
    "git-read": { "enabled": false }
  }
}
```

`config show/doctor` 的 Plugin 状态分别显示 `recommendedByPacks`、`workspaceSelection`、`selected`、`effective`、`executable` 与 `implementationAvailable`。`effective` 仅在显式启用且实现可执行时为 true；它不是 Lease 或授权。v1 配置只读加载时不会静默写盘；`config migrate --dry-run` 不写入，正式迁移会在 `.stinky-cobbler/backups/` 保留原文件并追加 `workspace-config-migrated`。

Stable role ID（如 `scout`、`builder`、`reviewer`）不可重命名；配置只能覆盖已知角色的 `displayName`。不得在 config、MCP 定义或命令行写入 Token、API key 或密钥。

## Read-only Runtime

Runtime 输入是用户或宿主显式给出的 task、capsule、lease 和 scripted request 文件。`--executor` 只解析受信任静态 registry 中的 ID，不能是模块路径：

```bash
stinky-cobbler runtime validate \
  --task task.json --capsule capsule.json --lease lease.json \
  --root /absolute/path/to/workspace --json

stinky-cobbler runtime run \
  --task task.json --capsule capsule.json --lease lease.json \
  --script requests.json --executor scripted-readonly \
  --root /absolute/path/to/workspace --json

stinky-cobbler runtime show run-001 --root /absolute/path/to/workspace --json
stinky-cobbler runtime reconcile run-001 --root /absolute/path/to/workspace --json
stinky-cobbler runtime reconcile run-001 --repair --root /absolute/path/to/workspace --json
stinky-cobbler runtime recover run-001 --stale-ms 3600000 --root /absolute/path/to/workspace --json
stinky-cobbler runtime cancel run-001 --root /absolute/path/to/workspace --json
```

运行前的集中 Admission 必须全部通过：

- Task 是 `SCOPED` 或 `DESIGNED`，**必须在 workspace 内持久化（`task create`）且提交内容与持久化权威副本一致**，缺失或不一致 fail-closed；并与 Capsule/Lease 的 task、workspace、role、agent、lease 绑定一致；
- Role 不可写，Lease 为 active L0 且 `writeSet: []`；Capsule 的 `writeSet: []`；
- Capsule 只允许 `repository-read`、`repository-list`，read/scope 不得涉及 `.stinky-cobbler` 或敏感路径；
- 预算、Lease 与 Capsule 尚未过期，且 Lease capability 覆盖全部请求。

每次请求经 Broker 产生 Tool Call Record 与仅含 hash/locator 的 Evidence Reference；Run 还会保存 Receipt。Runtime 不直读工作区文件、不写业务文件、不变更 Task state、不执行 shell、网络、Git 写入、`docs-index.build` 或 `test-run`。`host-injected` 仍未实现。Broker 级失败均 fail-closed：不支持或未授权请求返回 `RUNTIME_TOOL_NOT_ALLOWED`，工具、路径、文件系统、scope 或读取失败归一化为 `RUNTIME_TOOL_FAILED`，Evidence 记录或校验失败（包括 owner fence 失效）归一化为 `RUNTIME_EVIDENCE_PERSISTENCE_FAILED`；这些结果会阻断 Tool Call，并由 Supervisor 传递为阻断 Run。

`maxTurns`（每个 scripted request 一 turn）、`maxToolCalls`（每次尝试，包括 blocked/failed）、`maxFiles`（成功读取的唯一规范化普通文件）、`maxBytes`（正文 UTF-8 bytes，重复读取累计）、`maxOutputBytes`（Broker 序列化输出 UTF-8 bytes）和 `maxMinutes`（monotonic deadline）。超限前不会调用 Broker；实际结果提交后越界会保留调用记录并阻断 Run。Run usage 会保存到 AgentRun/Receipt。

- `runtime cancel` 会先持久化 `CANCELLED` 请求并在同一进程中触发 cooperative `AbortSignal`；非合作 I/O 不承诺硬终止。不同 CLI 进程之间依靠持久化 Run 在请求边界重新观察，无法保证中断已经进行的单次文件系统调用。`runtime show` 会附带 stale 状态；只有显式 `runtime recover` 才会把超过阈值且仍为 `RUNNING` 的未知 Run 标记为 `FAILED`，不会创建成功 Receipt 或修改 Task。Admission 失败还包括持久化 Task 缺失（`RUNTIME_TASK_NOT_PERSISTED`）或与 workspace 权威副本不一致（`RUNTIME_TASK_AUTHORITY_MISMATCH`）；预算错误码包括 `RUNTIME_BUDGET_EXCEEDED`、`RUNTIME_DEADLINE_EXCEEDED` 与 `RUNTIME_CANCELLED`。

`runtime reconcile` 是只读的 Run/Receipt 对账报告；`--repair` 仅对没有 Receipt 的非成功 terminal Run 写入一个明确标注为恢复事实的控制面 Receipt，不修改 Run、Task、Lease 或 Approval，不推进 `DONE`，也不为 `COMPLETED` 缺失 Receipt 伪造成功事实。已有冲突或多个 Receipt 只报告。该过程不是多文件事务，Evidence orphan 诊断同样只报告元数据关系，不是原始源内容证明。

`runtime diagnose [runId]` 是独立的只读 Run/Ledger/Receipt 生命周期诊断。它报告缺失关联、孤儿引用、语义冲突、结构完整性和 `UNVERIFIABLE` 状态，但不补写 lifecycle event、不创建或删除 Receipt、不修复 Ledger、不创建 workspace lock，也不把诊断结果解释为授权、签名、可信时间或历史真实性。


`stinky-cobbler-mcp` 是本地 stdio 服务。已注册的工具：

| MCP 工具 | 边界 |
|---|---|
| `validate_contract`、`resolve_config`、`recommend_task`、`evaluate_lease` | 只读治理检查或建议 |
| `repo_read`、`repo_list`、`git_read` | 要求匹配 Lease；仓库与 Git 操作受固定只读边界约束 |
| `docs_index` | `read` 受 Lease 约束；`build` 需 L1 Lease，且仅写 `.stinky-cobbler/docs-index.json`；它不属于只读 Runtime allowlist |
| `test-run` | 未注册，客户端不可调用 |

MCP 不提供任意 shell、业务写入、Git 写入、网络外发、消息发送、发布、部署、生产访问或 secret 读取。所有带 `workspace` 的受控 MCP 工具还要求目标目录已完成初始化：`.stinky-cobbler/workspace.json` 必须存在、是普通文件且包含可解析 JSON；仅有 `.stinky-cobbler` metadata 目录不构成可调用 workspace。初始化门禁失败时会在 Lease 校验、usage reservation 和 capability callback 之前 fail-closed，返回 `WORKSPACE_NOT_INITIALIZED`，不执行 capability，也不增加 Lease usage。初始化存在之后，MCP 还在同一 admission 边界对 workspace config 做**完整 schema 与 cross-reference 校验**（profile 存在、pack 被 profile 启用、plugin executable、稳定 role ID）；配置校验失败返回 `WORKSPACE_CONFIG_INVALID` 并 fail-closed，同样不执行 capability、不增加 Lease usage。该门禁不等于 Task、Lease、Approval 或执行授权。MCP 还会在同一 admission 边界读取持久化 Audit outbox：`prepared`、`recovery-required` 或 pending 状态读取失败都会返回 `AUDIT_PERSISTENCE_FAILED`，不会继续 reservation 或执行；必须显式使用 `audit pending` / `audit recover`，不会自动恢复或推进控制面状态。长运行 MCP 进程会在下一次调用重新读取 outbox，并在确认没有 pending 后清除已恢复的进程内 degraded marker。

## 安全与审计边界

- 默认拒绝 `.env`、credentials、private key、token、restricted data、路径逃逸、符号链接和 `.stinky-cobbler` 的 Runtime 读取。
- Lease、Receipt、Task Plan、Run `COMPLETED`、测试输出和 ledger 验证都不是高风险操作的授权。
- `ledger.jsonl` 是单进程、按 workspace 串行化的 SHA-256 hash-chain；它能检测当前链的结构或哈希损坏，**不是**签名、可信时间、外部见证、身份认证或跨进程锁。
- Run 生命周期现在会以 `run-created`、`run-transitioned`、`run-recovered` 事件写入 ledger，并用 `runId` 关联；这些事件只提供可观察性，不表示授权、重新执行、业务写入或 Task `DONE`。Run JSON 与 ledger 事件仍是多文件步骤，可能在崩溃时暂时不一致。
- Runtime Run 可带 workspace-local `ownerToken` 与 `fenceEpoch`。cancel/stale recovery 后，旧执行路径在请求边界和最终状态写入时会被 cooperative fence 拒绝；Runtime Evidence 的 owner check、幂等检查、Evidence JSON 写入和 `evidence-recorded` Ledger append 在同一个 workspace lock 临界区内线性化，因此 owner 失效后才开始写入的 TOCTOU 会被关闭。该临界区不是 Evidence、Run、Receipt、Ledger 的多文件事务：若 Evidence 先提交、cancel/recovery 随后获锁，orphan Evidence 仍可能出现，只能由诊断报告，不自动删除。最终化阶段会重新读取持久化 Run，将 cancel/stale recovery 胜出的 terminal Run 作为 authoritative state，并只复用或写入与其一致的唯一 Receipt；不会把旧 owner 的结果写回 Run，也不会创建第二份同 Run Receipt。多个 Receipt、冲突 Receipt 或无法安全判断的状态只报告，不自动删除或覆盖。这不是硬中断、身份认证或 distributed fencing，非合作 I/O 仍可能完成。
- 审计持久化失败必须如实报告；不得借此继续高风险流程。

详见：[高级用户配置指南](./docs/quickstart/高级用户配置指南.md)、[零终端用户指南](./docs/quickstart/零终端用户指南.md)、[发布前宿主验证清单](./docs/quickstart/发布前宿主验证清单.md)、[v0.3 范围与安全边界](./docs/architecture/v0.1-范围与安全边界.md)。
