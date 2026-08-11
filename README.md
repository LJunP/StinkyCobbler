# Stinky Cobbler

> **多角色 AI 开发协作调度与治理工具** —— 你提出需求，它自动编排多角色协作计划（规划 → 架构 → 构建 → 测试 → 评审 → 验证），由 ZCode / Codex 等 AI 逐步执行；每一步都有授权、审计和回滚。

![version](https://img.shields.io/badge/version-1.0.0-blue) ![license](https://img.shields.io/badge/license-Apache--2.0-green)

## 它是干什么的？

Stinky Cobbler 是一个**本地 AI 开发协作调度工具**：

- 你提出需求（"帮我检查项目 README"、"帮我实现某个功能"），它**自动生成多角色协作计划**——planner 规划 → architect 架构 → builder 构建 → testwright 测试 → reviewer 评审 → verifier 验证 → scribe 记录，由宿主 AI（ZCode / Codex）按计划逐步执行，步骤间自动传递结果。
- 复杂任务（多文件/多模块/需交付质量）走 **2.0 多 Agent 编排**：主 agent 指挥拆解 → 按领域路由专才 worker → 子 agent 分工执行 → 双通道审查（通过接受/不通过重做）→ 产物流转下一轮 → 直至完成；全局防循环/防打磨/防偏航约束引擎兜底，自动循环永远有上限、永远有人工兜底。
- 同时它是一个**治理控制面**：每一步（读文件、写文件、删文件）都经过授权、留痕、可回滚——**让 AI 按计划干活，但每一步都在掌控之中**。

它不是模型、不是聊天机器人；不依赖任何云服务，全部数据留在本地。

## 它能做什么？

| 能力 | 说明 |
|---|---|
| **多角色调度（1.0）** | 自动编排 7 角色协作计划（规划/架构/构建/测试/评审/验证/记录），按步骤授权执行、结果自动传递 |
| **多 Agent 编排循环（2.0）** | 主 agent 指挥拆解 → 子 agent 分工执行 → 双通道审查（通过接受/不通过重做）→ 产物流转下一轮 → 直至完成；全局防循环/防打磨/防偏航约束引擎；创建契约前先确认领域，按领域路由到专才 worker（专业指令/验收清单/禁区自动注入任务包） |
| **分层配置（2.0）** | 普通用户零配置直接用；高级用户可自定义：编排预算/上限/Lease/写入大小、专才注册表（可自定义名称）、审查阈值、契约模板、敏感路径追加；安全底线（敏感清单/删除确认/L3/审计）任何用户不可放宽 |
| **受控读取** | 读取项目文件必须有任务级授权（Lease）；敏感文件（`.env`、凭据、私钥）永远拒绝 |
| **免确认写入** | 常规文件的新建/修改**自动放行**（展示清单 + 审计 + 可回滚），不打断你；删除/覆盖仍须确认 |
| **受控删除 + 回滚** | 删除前自动备份，任何写入/删除一句话即可回滚恢复 |
| **全量审计** | 每一次授权、读取、写入、删除都进入本地 SHA-256 哈希链（ledger），可随时校验完整性；增长可控（可归档，归档后仍可跨段校验） |
| **双宿主** | 完整支持 **ZCode** 与 **Codex**（含 Codex 计划模式），安装一次即用 |
| **Lease 授权透明化** | 授权时长由你选（60 / 480 / 1440 分钟），到期同任务 15 分钟宽限不中断，续期一句话 |
| **确认式退出** | 说"停止使用该工具"→ 确认后完全退出，工具绝不擅自介入 |

---

## 分层配置：默认即用，按需自定义（2.0）

### 适合哪些用户？

| 用户 | 需要做的事 | 典型诉求 |
|---|---|---|
| **普通用户** | **什么都不用做**，装完直接用 | 要治理、不要配置 |
| **进阶用户** | 改参数（取消注释即可） | 大项目放宽预算/写入限制、审查更严格 |
| **极客用户** | 自写专才/契约模板/敏感路径 | 给专才起个性化名字、沉淀团队任务模板 |

### 自定义配置完整教程（5 步）

**① 初始化工作区（自动生成带注释的模板）**

```bash
stinky-cobbler init --workspace-id my-proj --profile team --pack software-engineering --mode reviewed-workflow --root .
```

init 自动在项目里生成**出场配置**——4 个全中文注释的模板文件，文件本身就是说明书：

```
.stinky-cobbler/policies/
├── orchestration.yaml        # 预算/上限/Lease/写入大小/审查阈值/敏感路径
├── specialists.yaml          # 专才自定义（含自定义名称）
├── templates.yaml            # 话术/审查风格/指令语言
└── contract-templates.yaml   # 契约模板库（一键建契约）
```

**② 打开对应文件，找到要改的项**

每个键都标注了用途、默认值、怎么改、例子：

```yaml
# defaults:   ← 取消注释此行，再取消注释下方要改的键
#   全局轮次上限。大任务可放宽（例：10），小任务收紧（例：3）。
#   maxRounds: 5
```

**③ 取消注释并改成你的值**

```yaml
defaults:
  maxRounds: 10                 # 预算放宽
  autoRejectScoreThreshold: 60  # 低于 60 分引擎自动拒绝（防高分放行劣质产物）
sensitiveExtraPaths:
  - internal/                   # 项目特有敏感目录：读写永远拒绝
```

自定义专才（覆盖内置 / 追加新领域 / 起个性化名字）：

```yaml
specialists:
  - domain: frontend            # 同名 = 覆盖内置
    title: 像素魔法师           # ← 自定义名称
    instructions: [遵循项目既有组件模式]
    acceptanceChecklist: [关键交互可验证]
    negativeRules: [不全局重排样式]
    suggestedCapabilities: [repository-read]
  - domain: medical             # 新领域 = 追加
    title: 妙手仁心
    instructions: [以患者数据安全为先]
    acceptanceChecklist: [隐私零泄露]
    negativeRules: [不输出患者信息]
    suggestedCapabilities: [repository-read]
```

契约模板（一键建契约）：

```yaml
templates:
  - name: my-audit
    description: 我的季度文档审计
    domain: compliance
    goal: 审计并修订项目文档
    criteria: [术语一致, 无敏感泄露]
    scope: [docs]
```

**④ 保存文件**——立即生效，无需重启。生效范围：对**之后的新操作**生效（正在进行的编排 run 使用创建时的预算，不会中途改变；审查阈值类对之后的每次审查即时生效）。

**⑤ 验证（手动检查命令）**

```bash
stinky-cobbler orchestration config show --root .        # 查看生效值（默认 vs 你的覆盖）
stinky-cobbler doctor --root .                           # 配置健康检查（configCheck）
stinky-cobbler orchestration specialist list --root .    # 查看专才池（含你的自定义）
stinky-cobbler orchestration template list --root .      # 查看模板库
```

用模板建契约：

```bash
stinky-cobbler orchestration contract from-template my-audit --task t-1 --root .
```

### 自定义配置失败的体现（两个地方）

配置写错（版本不符 / YAML 格式错误 / 违反收紧护栏）会 **fail-closed 直接报错**，绝不悄悄用旧值：

**① 手动验证 / 下一次命令时（终端直接可见）**

```
error: TIERED_CONFIG_INVALID
message: .stinky-cobbler/policies/orchestration.yaml 中 defaults.oscillationThreshold
         只能收紧：最大 2（放宽防打磨护栏不被允许）。       ← 哪个文件哪个字段 + 为什么
fix: 修复：改为 1 或 2。正确示例：                          ← 怎么改 + 正确示例
     defaults:
       oscillationThreshold: 2
```

**② AI 对话使用（AI 完整转述）**

AI 执行命令失败后按统一输出格式转述，**必须包含**：失败（原因：配置无效：<文件与字段>）+ 修复指引 + 正确示例——不会只说"配置无效"四个字，你照着示例改即可。

> 标准动作：**改文件 → 保存 → 跑一次 `config show` 或 `doctor --root` 验证 → 放心用**。

### 安全底线（任何用户都不能放宽）

- 内置敏感路径不可删除（只能追加）；删除永不自动放行；L3 人工确认；审计不可关闭
- 收敛阈值（振荡/退化）只可收紧（设 3 直接拒绝）；`general` 专才回退不可消失
- 配置是**项目级**的——只对当前项目生效，每个项目独立治理

> 完整教程见 [分层配置指南](./docs/quickstart/分层配置指南.md)。

---

## 安装与使用

> 完整图文教程见 [使用说明书](./docs/quickstart/使用说明书.md)（含小白 AI 代装流程与常见问题）。

### 方式 A：在线安装（有网络环境）

**正常用户（终端操作）：**
```bash
npm install -g stinky-cobbler
stinky-cobbler --version      # 预期 1.0.0
stinky-cobbler doctor --json  # 预期 healthy: true
```

**小白用户（把命令丢给 AI，AI 代装）：**
```
帮我安装 stinky-cobbler，并接入当前工具
```
AI 会替你执行安装与配置，**写入你的工具配置前会先预览并等你确认**——你只需要回复确认。

### 方式 B：国内用户（镜像站，无需翻墙）

**正常用户（终端操作）：**
```bash
npm install -g stinky-cobbler --registry=https://registry.npmmirror.com
```
> npmmirror（淘宝镜像）自动同步 npmjs 的包；新版本发布后可能有几分钟到几小时同步延迟。镜像仅支持安装（发布/审计不受支持，属镜像基础设施限制）。

**小白用户（AI 代装）：**
```
帮我安装 stinky-cobbler（用国内镜像），并接入当前工具
```

### 方式 C：Releases 下载（离线 / GitHub 不便时）

在 [GitHub Releases](https://github.com/LJunP/StinkyCobbler/releases) 下载附件：

| 附件 | 用途 |
|---|---|
| `stinky-cobbler-1.0.0-offline-full.zip` | **离线完整包（下载即用）**：含全部依赖，无需网络 |
| `stinky-cobbler-1.0.0.tgz` | npm 标准包（有网时 `npm install -g ./xxx.tgz`） |
| `stinky-cobbler-1.0.0.tgz.sha256` | 包完整性校验值（防下载被篡改） |
| `sbom.cyclonedx.json` | 依赖物料清单（供应链审计用） |
| `STINKY-COBBLER-MANUAL.md` | 完整使用教程（使用说明书） |

**正常用户（离线完整包）：**
```bash
# 需本机已装 Node ≥ 20；下载 zip 后：
unzip stinky-cobbler-1.0.0-offline-full.zip -d ~/apps
export PATH="$HOME/apps/stinky-cobbler-1.0.0-offline-full/bin:$PATH"   # macOS/Linux
stinky-cobbler --version
```
> 国内访问 GitHub 不便时可用加速代理下载，**下载后务必用 sha256 校验**（附件提供校验文件）。

**小白用户（AI 代装）：**
```
帮我安装这个 zip 里的 stinky-cobbler（离线完整包），解压并配置好，然后接入当前工具
```

### 方式 D：国内源码镜像（Gitee，无需翻墙）

源码镜像（与 GitHub 同步，最新提交一致）：`https://gitee.com/LJunP/StinkyCobbler`

**正常用户（终端操作）：**
```bash
git clone https://gitee.com/LJunP/StinkyCobbler.git
cd StinkyCobbler && npm install && npm run build && npm install -g .   # 源码安装
```

> 发布附件（离线完整包 / tgz / sha256 / SBOM）仍从 [GitHub Releases](https://github.com/LJunP/StinkyCobbler/releases) 下载；需要时也可在 Gitee Releases 手动补传。

---

## 接入你的 AI 工具（一次性，三选一）

**ZCode**（获得 `/stinky-cobbler` 命令入口）：
```bash
stinky-cobbler entry install-host --dry-run    # 先预览
stinky-cobbler entry install-host --mcp        # 确认后安装（含本地 MCP）
```

**Codex**（无命令机制，走 skill 显式启用）：
```bash
stinky-cobbler entry install-host --host codex --mcp --dry-run
stinky-cobbler entry install-host --host codex --mcp
```

> `install-host` 是纯本地操作，离线可用；写入 `~/.zcode/` 或 `~/.codex/` 前必须经过你的确认。

## 日常使用

**ZCode 里**——输入命令激活（之后本会话免前缀）：
```
/stinky-cobbler 帮我检查当前项目的 README
```
**Codex 里**——显式启用 skill：
```
使用 stinky-cobbler 帮我检查当前项目的 README
```

工具统一按「结果 / 证据 / 边界 / 下一步」输出；关键决策（授权时长、删除确认、停止确认）由你点选/回复，常规写入自动放行。复杂任务自动进入多 Agent 编排循环（领域确认 → 契约 → 拆解 → 专才执行 → 审查 → 完成）。停止：`停止使用该工具`。

## 工作原理（30 秒版）

```text
项目接入（init，自动生成个性化配置模板）
  → 任务（task）→ 计划（plan，多角色步骤）
  → 授权（lease，限时/限范围，你选择时长）
  → 执行（宿主 AI 用 MCP 工具：repo_read / repo_write / repo_delete）
  → 复杂任务走编排（contract → subtask → 专才 worker → 双通道审查 → 接受/重做）
  → 留痕（Evidence + ledger 哈希链）
  → 可回滚（write rollback 恢复任何写入/删除）
```

所有操作都绑定 workspace 本地状态，**不依赖任何云服务、不上传任何数据**。

## 安全与边界

- 敏感路径（`.env*`、凭据、私钥）、控制面 `.stinky-cobbler/`、`.git/`、可执行文件：**永远拒绝**
- 删除、覆盖、泛化范围（"所有文件"）：**必须确认**，永不自动放行
- Lease 绝不自动签发；停止工具 ≠ 撤销 Lease；拒绝就是拒绝（不绕过、不扩大权限重试）
- 自定义配置也有安全底线：敏感清单只增不减、收敛阈值只可收紧、审计不可关闭
- 详细威胁模型见 [SECURITY.md](./SECURITY.md)

## CLI 能力矩阵

| 入口 | 说明 |
|---|---|
| `doctor` / `recommend` / `validate` | 健康检查（`--root` 时含配置校验）、角色/能力推荐、契约校验 |
| `init` | 初始化受管项目（创建 `.stinky-cobbler/` 控制面 + 个性化配置模板，不写业务文件） |
| `task create/...` | 控制面任务管理 |
| `approval request/decide/...` | 显式人工批准记录 |
| `lease issue/show/list/revoke` | 用户确认后签发限时授权（时长必选）；绝不自动 |
| `plan create/confirm/execute/step/...` | 多角色调度计划（含 `write-request --auto-allow` 免确认写入） |
| `write apply` / `write delete` / `write list/show/rollback` | 受控写入、删除、审计查询、回滚 |
| `orchestration contract/run/subtask/artifact/review/round` | 2.0 多 Agent 编排循环（领域确认 → 契约 → 拆解 → 执行 → 审查 → 完成） |
| `orchestration specialist list/show` | 只读查看专才注册表（含自定义） |
| `orchestration template list/show`、`contract from-template` | 契约模板库（一键建契约） |
| `orchestration config show/scaffold` | 分层配置：查看生效值 / 补生成模板 |
| `ledger verify` / `ledger archive --before-days N` | 哈希链校验（跨归档可查）/ 归档控制增长 |
| `entry preflight` / `install-host [--host zcode\|codex] [--mcp]` / `mcp-config` | 统一入口事实检查与宿主安装 |
| `audit pending/recover` | 审计恢复 |
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
npm test          # 288 个测试
npm run test:integration
npm run test:package
npm audit         # 发布前依赖审计（对官方 registry）
```

## 文档

- [使用说明书](./docs/quickstart/使用说明书.md)（安装/小白 AI 代装/日常使用/常见问题）
- [分层配置指南](./docs/quickstart/分层配置指南.md)（高级用户自定义完整教程）
- [产品设计基线](./docs/architecture/产品设计基线.md)（全部已确认决策）
- [零终端用户指南](./docs/quickstart/零终端用户指南.md)
- [高级用户配置指南](./docs/quickstart/高级用户配置指南.md)
- [发布前宿主验证清单](./docs/quickstart/发布前宿主验证清单.md)
- [威胁模型与权限设计](./docs/architecture/威胁模型与权限设计.md)

## License

[Apache-2.0](./LICENSE)
