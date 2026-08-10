# Stinky Cobbler

> **给 AI Agent 装上"受控治理"的本地控制面** —— 让 ZCode / Codex 等 AI 工具在你的项目里读取、写入、删除都有授权、审计和回滚。

![version](https://img.shields.io/badge/version-1.0.0-blue) ![license](https://img.shields.io/badge/license-Apache--2.0-green)

## 它是干什么的？

Stinky Cobbler 不是模型、不是聊天机器人，也不是业务执行器。它是一个**本地治理层**：AI Agent 在项目里做的每件事（读文件、改文件、删文件、执行任务）都要经过它的**授权、留痕、可回滚**。

一句话：**让 AI 干活，但每一步都在掌控之中。**

## 它能做什么？

| 能力 | 说明 |
|---|---|
| **受控读取** | 读取项目文件必须有任务级授权（Lease）；敏感文件（`.env`、凭据、私钥）永远拒绝 |
| **免确认写入** | 常规文件的新建/修改**自动放行**（展示清单 + 审计 + 可回滚），不打断你；删除/覆盖仍须确认 |
| **受控删除 + 回滚** | 删除前自动备份，任何写入/删除一句话即可回滚恢复 |
| **全量审计** | 每一次授权、读取、写入、删除都进入本地 SHA-256 哈希链（ledger），可随时校验完整性 |
| **双宿主** | 完整支持 **ZCode** 与 **Codex**（含 Codex 计划模式），安装一次即用 |
| **Lease 授权透明化** | 授权时长由你选（60 / 480 / 1440 分钟），到期同任务 15 分钟宽限不中断，续期一句话 |
| **确认式退出** | 说"停止使用该工具"→ 确认后完全退出，工具绝不擅自介入 |

## 怎么用？

### 1. 安装

```bash
npm install -g stinky-cobbler
stinky-cobbler --version   # 1.0.0
stinky-cobbler doctor --json
```

### 2. 接入你的 AI 工具（一次性）

**ZCode**（获得 `/stinky-cobbler` 命令入口）：

```bash
stinky-cobbler entry install-host --dry-run    # 先预览
stinky-cobbler entry install-host --mcp        # 确认后安装（含本地 MCP）
```

**Codex**（无命令机制，走 skill 显式启用）：

```bash
stinky-cobbler entry install-host --host codex --mcp --dry-run   # 先预览
stinky-cobbler entry install-host --host codex --mcp              # 确认后安装
```

### 3. 开始使用

**ZCode 里**——输入命令激活（之后本会话免前缀）：

```
/stinky-cobbler 帮我检查当前项目的 README
```

**Codex 里**——显式启用 skill：

```
使用 stinky-cobbler 帮我检查当前项目的 README
```

工具会统一按「结果 / 证据 / 边界 / 下一步」输出，你只做点选决策（授权时长、删除确认等），其余自动。

### 4. 最小示例（终端直接体验）

```bash
# 初始化一个受管项目
stinky-cobbler init --workspace-id demo --profile team --pack software-engineering --mode reviewed-workflow --json

# 查看健康状态与审计
stinky-cobbler doctor --json
stinky-cobbler ledger verify --json
```

## 工作原理（30 秒版）

```text
项目接入（init）
  → 任务（task）→ 计划（plan，多角色步骤）
  → 授权（lease，限时/限范围，你选择时长）
  → 执行（宿主 AI 用 MCP 工具：repo_read / repo_write / repo_delete）
  → 留痕（Evidence + ledger 哈希链）
  → 可回滚（write rollback 恢复任何写入/删除）
```

所有操作都绑定 workspace 本地状态，**不依赖任何云服务、不上传任何数据**。

## 安全与边界

- 敏感路径（`.env*`、凭据、私钥）、控制面 `.stinky-cobbler/`、`.git/`、可执行文件：**永远拒绝**，任何模式都拦
- 删除、覆盖、泛化范围（"所有文件"）：**必须确认**，永不自动放行
- Lease 绝不自动签发；停止工具 ≠ 撤销 Lease；拒绝就是拒绝（不绕过、不扩大权限重试）
- 详细的威胁模型与边界见 [SECURITY.md](./SECURITY.md)

## CLI 能力矩阵

| 入口 | 说明 |
|---|---|
| `doctor` / `recommend` / `validate` | 健康检查、角色/能力推荐、契约校验 |
| `init` | 初始化受管项目（创建 `.stinky-cobbler/` 控制面，不写业务文件） |
| `task create/...` | 控制面任务管理 |
| `approval request/decide/...` | 显式人工批准记录 |
| `lease issue/show/list/revoke` | 用户确认后签发限时授权（时长必选）；绝不自动 |
| `plan create/confirm/execute/step/...` | 多角色调度计划（含 `write-request --auto-allow` 免确认写入） |
| `write apply` / `write delete` / `write list/show/rollback` | 受控写入、删除、审计查询、回滚 |
| `entry preflight` / `install-host [--host zcode\|codex] [--mcp]` / `mcp-config` | 统一入口事实检查与宿主安装 |
| `audit pending/recover`、`ledger verify` | 审计与哈希链校验 |
| `test-run` | 未注册，绝不执行 |

## MCP 工具

| 工具 | 说明 |
|---|---|
| `repo_read` / `repo_list` / `git_read` / `docs_index` | 受控只读（需匹配 Lease） |
| `repo_write` | 受控写入（确认或 auto-allow，备份 + 证据 + 审计） |
| `repo_delete` | 受控删除（必须确认，备份可回滚） |
| `validate_contract` / `resolve_config` / `recommend_task` / `evaluate_lease` | 只读治理检查 |

## 开发与验证

```bash
npm install
npm run typecheck
npm test          # 236 个测试
npm run test:integration
npm run test:package
npm audit         # 发布前依赖审计（对官方 registry）
```

## 文档

- [产品设计基线](./docs/architecture/产品设计基线.md)（全部已确认决策）
- [零终端用户指南](./docs/quickstart/零终端用户指南.md)
- [高级用户配置指南](./docs/quickstart/高级用户配置指南.md)
- [发布前宿主验证清单](./docs/quickstart/发布前宿主验证清单.md)
- [威胁模型与权限设计](./docs/architecture/威胁模型与权限设计.md)

## License

[Apache-2.0](./LICENSE)
