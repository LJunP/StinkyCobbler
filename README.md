# Stinky Cobbler

> **Codex / ZCode 本地仓库的可验证权限与变更门禁。**

Stinky Cobbler 是一个本地 CLI/MCP 控制面。它不替代 Codex 或 ZCode，也不自己调用模型；它只对**经自身受控通道**发起的仓库读取、单目标写入、删除和只读 Runtime 调用，校验持久化 Task、精确 Approval、Lease、路径范围、写前文件状态，并记录本地审计证据。

![npm](https://img.shields.io/npm/v/stinky-cobbler) ![license](https://img.shields.io/badge/license-Apache--2.0-green)

[快速开始](#安装与验证) · [功能](#当前实现能力矩阵) · [开发进度](#开发阶段与后续路线) · [文档](#文档) · [贡献指南](./CONTRIBUTING.md)

## 为什么使用它

当 AI 修改仓库时，仅有“请不要改这些文件”的提示不足以形成可检查的授权记录。Stinky Cobbler 把任务范围、批准、执行凭证和文件变更串起来：允许的操作留下证据，越界、过期授权、写前内容漂移和重复执行会被相应门禁拒绝。

适合需要审批、可追溯变更和条件回滚的本地 AI 编程工作流。使用者需要理解 CLI、Git 和宿主 MCP 配置；只想直接聊天生成代码、或者需要操作系统强隔离的用户，应先阅读下面的产品边界。

例如：批准 AI 修改一个配置文件后，如果有人先改了该文件，原 WriteIntent 会因写前 hash 不匹配而拒绝应用。需要基于新内容重新申请，避免覆盖第三方修改。

## 版本与验证状态

- 当前 checkout 的版本和 Node.js 要求以 `package.json` 为准。
- 当前公开 npm 版本必须通过 `npm view stinky-cobbler version --registry=https://registry.npmjs.org` 查询；tag、Release 与资产必须在 [GitHub Releases](https://github.com/LJunP/StinkyCobbler/releases) 核验。
- 真实宿主支持必须绑定到同一组候选 bytes，并完成 Codex/ZCode 安装、重启后发现、MCP 消费者和受控操作 E2E。历史宿主结果或 `mcpConfigured=true` 不能替代本次证据。
- 源码版本、绿测试、打包或 release gate 都不等于 npm publish、Git tag 或 GitHub Release。

## 产品边界

Stinky Cobbler 当前解决一个具体问题：**让宿主对本地仓库的受控操作能够回答“基于哪个 Task、谁批准了什么范围、用了哪个 Lease、写前文件是否漂移、最终改了什么”。**

它不承诺以下能力：

- 不是操作系统沙箱，也不能拦住宿主原生文件工具、Shell、Git 或第三方 MCP 绕过控制面；
- 不是自主 Agent 调度器；`orchestration` 是本地契约/状态/预算/产物门禁，真实 worker 的创建、执行与上下文隔离由宿主负责；
- 不创建或隔离真实 Agent/reviewer。引擎只负责状态机级 DAG 失败隔离与重叠 writeSet 阻断；Contract 创建时把 Profile 快照为不可变 `reviewPolicy`：`individual=SELF_REVIEW_AUDITED`，`team` / `organization` / `regulated` / 缺失配置=`INDEPENDENT_REQUIRED`。真正创建独立 reviewer、隔离进程或 worktree 仍由宿主负责；
- 不是“零配置直接用”。至少需要 Node.js 22、本地安装、显式宿主接入、workspace 初始化，以及与操作匹配的 Task/Approval/Lease；
- “本地”只描述控制面文件与 CLI/MCP 进程。Codex/ZCode、模型提供商或宿主其他工具是否联网、是否上传内容，不由本项目证明；
- 当前实现没有 CAS、结构化 Context/Memory、摘要检索、冲突消解或跨会话长期记忆。`summary` / `evidence` 编排产物不能冒充已验证上下文。

### Cooperative Mode

所有保证都以“操作确实经 Stinky Cobbler CLI/MCP 路由”为前提。需要强制中介时，必须由宿主把 worker 放入只暴露受控工具的隔离环境，并移除其他写通道；本仓库没有提供或验证该宿主隔离。

npm 包的受支持执行面只有 `stinky-cobbler` CLI 与 `stinky-cobbler-mcp` 两个 bin；`dist/**` 是内部实现，不是 library API，package exports 会拒绝标准 Node.js deep import。能直接读写安装目录或 workspace 控制面文件的同进程代码，本来就在 Cooperative Mode 边界之外。

## 当前实现能力矩阵

### 可使用的入口

| 功能组 | 已实现的操作 | 主要入口 |
|---|---|---|
| 初始化与诊断 | workspace 配置、Profile/Pack 校验、默认策略模板、健康检查 | CLI `init`、`doctor`、`config`、`validate` |
| 任务与权限 | Task 生命周期、规则式角色推荐、Approval 请求/决定、Lease 签发/撤销/使用重验 | CLI `task`、`recommend`、`approval`、`lease` |
| 仓库只读 | 有界文件读取、目录列表、固定 Git 只读操作、文档索引 | MCP `repo_read`、`repo_list`、`git_read`、`docs_index` |
| 仓库变更 | 单文件 create/modify/delete、写前校验、备份、条件回滚与恢复 | CLI `write`；MCP `repo_write`、`repo_delete` |
| 计划与编排 | Plan 步骤推进、Contract/Subtask、依赖、重试、审查、产物与完成门禁 | CLI `plan`、`orchestration` |
| 只读运行时 | 显式请求执行、预算、心跳、取消/超时、终态收据、恢复与核对 | CLI `runtime` |
| 证据与审计 | Evidence/Receipt 查询、审计恢复、hash-chain 验证与归档 | CLI `evidence`、`receipt`、`audit`、`ledger` |
| 宿主接入 | Codex/ZCode 安装预览、受管配置升级、冲突保护、备份回滚 | CLI `entry` |
| 分发与验证 | npm 包 smoke、离线包、SBOM、校验和、六矩阵 CI | `scripts/`、GitHub Actions |

MCP 另外提供 `validate_contract`、`resolve_config`、`recommend_task`、`evaluate_lease` 四个校验/查询工具。`evaluate_lease` 检查传入值，不签发权限；实际操作还会重读持久化授权。当前未注册 `test_run`，也没有通用 Shell、网络或 Git 写入工具。

### 保证由谁提供

状态只使用 `ENGINE_ENFORCED`、`HOST_PROCEDURAL`、`DECLARED_ONLY`、`NOT_AVAILABLE`。

| 能力 | 状态 | 当前事实与边界 |
|---|---|---|
| **TaskAuthority** | `ENGINE_ENFORCED` | 从 workspace 重载持久化 Task，校验状态、风险、scope/writeSet、policy、adapter、role→operation 与完整父授权链；未知/不允许的角色工具 fail-closed；不是签名身份或外部授权服务 |
| **精确 Approval / Lease** | `ENGINE_ENFORCED` | Approval 绑定对象 hash、能力、精确范围、预算、策略、主体、nonce 与消费状态；Lease 在签发及每次使用时都校验具体 operation 的角色权限；`worker` 仅接受 orchestration-derived、subtask/attempt-bound Lease |
| **单目标 WriteIntent / preimage / 条件回滚** | `ENGINE_ENFORCED` | intent 捕获 `expectedPreimageHash`；auto-allow 不会跳过 TaskAuthority、Lease/writeSet、路径或 preimage；业务文件和控制面不是多文件事务，故障后可进入 `RECOVERY_REQUIRED`，不能合成成功 |
| **Artifact / ValidatorReceipt / Completion 重验** | `ENGINE_ENFORCED` | dispatch、begin、review、completion 重读文件 hash；validator 由引擎注册执行；caller 自报 passing JSON 不构成证据 |
| **DAG 失败隔离 / 并发 fence** | `ENGINE_ENFORCED` | 非关键独立分支可继续，依赖后继阻断；同 Contract active Run 与重叠 writeSet 冲突被拒绝；这不是进程/worktree 隔离 |
| **Profile 审查独立性规则** | `ENGINE_ENFORCED` | Contract 创建时不可变快照：`individual=SELF_REVIEW_AUDITED`；`team` / `organization` / `regulated` / 缺失配置=`INDEPENDENT_REQUIRED`；legacy Contract 默认严格 |
| **只读 Runtime cancel/deadline/finalization** | `ENGINE_ENFORCED` | 仅 `scripted-readonly` adapter；同进程 supervisor、timer、AbortSignal、owner/epoch checkpoint，以及完整 Capsule/executor/有序请求的 `executionRequestHash` 与 `PREPARED→COMMITTED` Run/Receipt/audit 绑定；Capsule policyVersion 必须等于持久化 Lease；不是宿主 Agent/进程硬中断或跨文件单事务 |
| **本地 hash-chain ledger** | `ENGINE_ENFORCED` | 验证当前链的 Schema、顺序和 hash 自洽；不是不可篡改外部见证 |
| **Codex/ZCode 创建 Agent、独立 reviewer、隔离 worktree** | `HOST_PROCEDURAL` | 由宿主完成；当前候选只提供 Skill/MCP 接入规则，不把宿主行为冒充引擎事实 |
| **非开发 Pack 与未实现插件清单** | `DECLARED_ONLY` | 仅配置/路由元数据；没有受信任实现时不可宣称可执行 |
| **CAS、ContextManifest、结构化长期记忆、统一 Host Adapter** | `NOT_AVAILABLE` | 不属于当前实现能力 |

Runtime 的 cancel/deadline 是协作式边界；`CANCEL_REQUESTED` 后仍需查询 persisted Run。若停止与在途调用竞争，底层结果可能为 `UNKNOWN`，不能描述为硬中断成功。

编排 CLI 使用显式 generation 防止旧 worker/旧人工决定重放：dispatch 读取并提交 `retriesUsed`，begin/artifact/review 传递返回的 `activeAttempt`，resume 提交当前 escalation 的下一 `resumeGeneration`；新一代 Run 必须用 `--supersedes-run` 绑定唯一终态前驱。完整命令见[使用说明书：防陈旧重放协议](docs/quickstart/使用说明书.md#防陈旧重放协议)。

人工升级会写入精确绑定 generation、规范化 reason、Run 前后状态与 audit effect 的事务 journal。若取消 fence 已开始且升级目标尚未发布，升级、resume 与通用 reconcile 都不能越过 fence；取消重试会把该事务标为 `ABORTED`。这保证的是控制面顺序，不是宿主 worker 的停止能力。

## 安装与验证

安装公开版本前先核验 registry 实际版本：

```bash
npm view stinky-cobbler version --registry=https://registry.npmjs.org
npm install -g stinky-cobbler --registry=https://registry.npmjs.org
stinky-cobbler --version
stinky-cobbler doctor --json
```

验证当前 checkout 时从源码安装，避免把 registry 的另一版本误认为当前 bytes：

尚未取得源码时，可克隆当前候选分支；已有工作区请直接在其中执行后面的构建步骤，不要重复克隆：

```bash
git clone --branch codex/stinky-cobbler-2.0.1-hardening https://github.com/LJunP/StinkyCobbler.git
cd StinkyCobbler
```

注意：分支克隆只取得已推送内容，不包含维护者本地尚未提交的修复。候选测试结论必须对应你实际取得的提交。

```bash
node --version                       # 源码开发使用 Node 22.12+ 或 Node 24
npm ci                             # 按已提交的 lockfile 安装
npm run build
npm install -g .                    # 安装当前 checkout，而不是 registry 版本
stinky-cobbler --version             # 应与 package.json 一致
stinky-cobbler doctor --json
```

宿主接入会修改宿主配置，必须先预览并由操作者确认：

```bash
# ZCode
stinky-cobbler entry install-host --dry-run --json
stinky-cobbler entry install-host --mcp --dry-run --json

# Codex
stinky-cobbler entry install-host --host codex --mcp --dry-run --json
```

相同命令也负责安全升级：只有 sidecar 记录的当前 hash 或实现内置的精确已知旧版 hash 与现有 bytes 完全一致时才会升级。当前兼容代码可识别三份 2.0.0 command/Skill 模板的精确 SHA-256；版本文字本身不是依据。检测到用户编辑会返回 `conflict` 并保留原文件。升级前创建内容寻址的独占备份，升级后先预览再恢复上一份受管备份：

```bash
stinky-cobbler entry install-host --rollback --dry-run --json
stinky-cobbler entry install-host --rollback --json

# 若安装时包含 MCP 配置，回滚预览/执行也必须显式带 --mcp
stinky-cobbler entry install-host --mcp --rollback --dry-run --json
```

未执行非 dry-run 安装、重启宿主并完成[真实宿主验证清单](./docs/quickstart/发布前宿主验证清单.md)前，宿主能力保持 `UNKNOWN / PENDING`。

`--rollback` 只在 sidecar、当前 installed hash、普通非 symlink 备份及备份 hash 全部匹配时执行；安装后用户改动、目标/备份缺失或漂移都会 fail-closed。完整规则见[兼容与迁移政策](./docs/兼容与迁移政策.md)。

初始化也不是授权：

```bash
stinky-cobbler init \
  --workspace-id example \
  --profile team \
  --pack software-engineering \
  --mode reviewed-workflow \
  --root /absolute/path/to/repository \
  --dry-run
```

初始化仅预览/创建 `.stinky-cobbler/` 控制面。真正读取或写入仍需持久化 Task、对应 Approval 与 Lease。

## 受控变更链

```text
持久化 Task
  -> 精确 delegate-capability Approval
  -> 受限 Lease（服务端持久化记录为权威）
  -> 单目标 WriteIntent + 写前 preimage
  -> 可选的精确 write-confirm Approval（delete 必须；create/modify 可 auto-allow）
  -> apply 前重验 TaskAuthority / Lease / scope / preimage
  -> 业务文件变更
  -> Evidence + ledger + APPLIED journal
  -> 条件回滚
```

任何一步被拒绝，都不能通过扩大 scope、换 Lease 字段、宿主 Shell 或第三方 MCP 来伪装成受控成功。

## 开发候选验证

运行已安装的 CLI/MCP 要求 Node.js 22+；源码开发和测试中的 Vite 8 要求 Node.js 22.12+（也支持 Node 24）。推荐使用相应主版本的最新补丁版，并通过 `npm ci` 保留锁定的依赖树。

```bash
npm ci
PACKAGE_VERSION=$(node -p 'require("./package.json").version')
PACKAGE_REF=$(git branch --show-current)
npm run check:version
npm run typecheck
npm run build
npm test
npm run test:integration
npm run test:package
node scripts/release-gate.mjs --expected "$PACKAGE_VERSION" --git-ref "$PACKAGE_REF"
npm audit --registry=https://registry.npmjs.org --audit-level=high
git diff --check
```

上述 dispatch 门禁接受 `main`、精确版本标签或 `codex/stinky-cobbler-<版本>-hardening` 分支；其他开发分支可运行 `npm run check:version`，准备候选时再使用允许的 ref。标签 checkout 应把 `PACKAGE_REF` 显式设置为对应标签。

这些命令只验证当前源码候选的相应契约。正式发布还需同一候选 bytes 的真实 Codex/ZCode 消费者 E2E、最终资产/checksum/SBOM 复核，以及单独授权的 commit、tag、GitHub Release 和 npm publish。

## 开发阶段与后续路线

当前处于 **2.0.1 加固与发布准备阶段**：受控执行内核已有实现和自动化回归，真实宿主验收与正式发布仍是后续门禁。源码提交可以先进入 GitHub 分支接受 CI；不必等所有未来能力完成。

| 阶段 | 当前状态 | 完成标准 / 剩余工作 |
|---|---|---|
| 本地权限、单目标变更与审计内核 | 已实现，有自动化覆盖 | 持续维护授权、路径、漂移、故障恢复回归 |
| 计划、编排状态与只读 Runtime | 已实现，范围已收缩 | 宿主负责实际执行工作；引擎负责记录与门禁 |
| 2.0.1 安全和分发加固 | 发布准备中 | 依赖安全更新、当前工作区测试通过后提交；为新 SHA 取得六矩阵及候选资产 |
| 当前版本真实双宿主验收 | UNKNOWN / PENDING | Codex 和 ZCode 分别验证安装/重启发现、MCP 调用、读写删除回滚、取消/超时；绑定同一候选 bytes |
| 2.0.1 正式发布 | 待发布门禁与授权 | 固定候选、确认资产与校验和、tag/npm/GitHub Release，随后全新安装验证 |
| 后续扩展 | 未承诺排期 | 根据真实用户使用结果选范围，单独设计和验收 |

尚未实现的能力包括：自动创建和监督 worker 的统一 Host Adapter、可验证的 Provider token receipt、CAS、结构化 Context/Memory、跨会话检索，以及非开发 Pack 对应的外部执行器。这些不是当前 2.0.1 的交付承诺，不应仅为了凑齐功能而扩大范围。OS sandbox、真实身份与外部审计见证也不是现有引擎保证。

历史证据：提交 `4dba92a` 的 [六矩阵 CI](https://github.com/LJunP/StinkyCobbler/actions/runs/32808278496) 和 [候选构建](https://github.com/LJunP/StinkyCobbler/actions/runs/32808307244) 于 2026-08-25 通过。它们只证明该提交；后续代码、依赖或文档改动需要新 SHA 的验证。最新修复清单与本地验收见[当前修复与验收记录](docs/项目状态与修复记录.md)。

## 仓库导航

| 路径 | 内容 |
|---|---|
| `src/cli.ts`、`src/mcp-server.ts` | 公共 CLI / MCP 入口 |
| `src/storage/`、`src/security/`、`src/policy/` | 持久化状态、事务恢复、权限与路径校验 |
| `src/runtime/`、`src/contracts/`、`schemas/` | 只读 Runtime 与数据契约 |
| `profiles/`、`packs/`、`policies/`、`plugins/` | 配置与能力声明；声明不等于执行器 |
| `.codex/`、`.zcode/` | 宿主入口模板 |
| `test/`、`scripts/`、`.github/workflows/` | 回归测试、构建/分发校验与 CI |
| `docs/`、`examples/` | 使用、安全、架构及任务示例 |

`dist/`、`node_modules/` 和根目录旧压缩包是本地生成物，不作为当前发布版本的依据。提交源码时以 Git 跟踪文件为准；候选产物必须从最终提交重新生成。

## 文档

- [使用说明书](./docs/quickstart/使用说明书.md)
- [高级用户配置指南](./docs/quickstart/高级用户配置指南.md)
- [发布前宿主验证清单](./docs/quickstart/发布前宿主验证清单.md)
- [安全策略](./SECURITY.md)
- [支持矩阵](./docs/支持矩阵.md)
- [兼容与迁移政策](./docs/兼容与迁移政策.md)
- [产品范围 ADR](./docs/architecture/ADR-0001-产品范围与版本边界.md)
- [贡献指南](./CONTRIBUTING.md)
- [威胁模型与权限设计](./docs/architecture/威胁模型与权限设计.md)
- [产品设计历史日志](./docs/architecture/产品设计基线.md)（历史资料，不是当前实现证明）

## License

[Apache-2.0](./LICENSE)
