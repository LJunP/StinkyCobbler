# Stinky Cobbler 项目规范（STANDARDS）

> 本文件是项目的**总规则**，所有贡献者（包括 Claude、grok、Codex 等 AI 工具）改动仓库前必须先读，改动必须遵守。
> 规则由作者维护，可以随时修改和新增：改规则就是改本文件，走普通 PR。§1.2 的 `repo-structure` 代码块是目录白名单的唯一来源，P6 起由结构守卫测试直接读取；在那之前没有工具读取它（见 §1.4）。
> 决定来源：[ADR-0003](adr/0003-repository-structure-and-standards.md)。迁移期间（P2–P7 未完成前）仓库还没有完全符合本文件，进度见 ADR-0003 的「迁移批次」。

## 0. 总则

1. **先找位置，再写文件。** 新文件必须能在 §1 找到归属目录；找不到就先改本文件（同一 PR），不允许"先放根目录以后再说"。
2. **一个事实只写一处。** 规则、枚举、路径、版本号各有唯一来源；其他地方引用，不复制。
3. **不留垃圾。** 没有读者的文件、配置键、代码、文档在同一 PR 里删掉；临时产物只放 `output/`。
4. **能用工具强制的就用工具强制。** 每条规则标注状态：✅ 已强制（CI 会拦）、🟡 部分强制、⬜ 未强制（靠评审，列入待办）。
5. **2.x 冻结。** 冻结的 2.x 门禁只修会丢数据或误导用户的缺陷，不加新行为（ADR-0002），统一封存在 `src/gate/`、`resources/gate/`、`test/gate/`、`docs/gate/` 四处。

## 1. 目录规范

### 1.1 目标结构

```text
StinkyCobbler/
├── src/                源码（只有 TypeScript）
│   ├── cli.ts  mcp-server.ts  version.ts  errors.ts
│   ├── core/           3.x 纯逻辑：规格模型、计划器、渲染器（不碰 fs）
│   ├── io/             3.x 所有磁盘读写：有界读写、受管文件、分层配置、账本、资源路径
│   ├── hosts/          3.x 宿主适配器与 conformance
│   ├── app/            3.x 命令即用例 + Presenter
│   └── gate/           冻结的 2.x（domain mcp policy runtime storage config contracts entry security）
├── resources/          运行时读取、随 npm 包发布的静态数据
│   ├── toolkit/        3.x：toolkit.schema.json 等
│   └── gate/           冻结的 2.x：schemas policies profiles packs plugins examples skills
├── test/               与 src/ 一一镜像
│   ├── core/ io/ hosts/ app/ gate/
│   ├── repo/           仓库级守卫（结构、冻结、文档链接）
│   ├── scripts/        scripts/ 的测试
│   └── setup/ helpers/ fixtures/
├── scripts/            构建、打包、发布、审计脚本（.mjs）
├── docs/               见 §1.3
├── output/             临时与生成产物，除 README.md 外不入库
├── .github/  .husky/
└── 根目录配置文件（见 repo-structure 的 rootFiles）
```

### 1.2 机器可读白名单（P6 起由结构守卫读取）

```yaml repo-structure
# 根目录允许的目录（git 跟踪的内容）
rootDirs: [.github, .husky, docs, output, resources, scripts, src, test]
# 根目录允许的文件
rootFiles:
  - .dependency-cruiser.cjs
  - .dependency-cruiser-known-violations.json
  - .editorconfig
  - .gitattributes
  - .gitignore
  - .npmrc
  - .nvmrc
  - .prettierrc
  - AGENTS.md
  - CHANGELOG.md
  - CONTRIBUTING.md
  - LICENSE
  - README.md
  - SECURITY.md
  - eslint.config.js
  - package-lock.json
  - package.json
  - tsconfig.json
  - tsconfig.test.json
  - vitest.config.ts
# 本地存在但不入库（必须被 .gitignore 覆盖）
ignoredLocal: [dist, node_modules, .claude, .DS_Store]
# 受管目录的一级子项白名单（文件或目录）；"*.ext" 表示该层允许的文件类型
managed:
  src: [core, io, hosts, app, gate, cli.ts, mcp-server.ts, version.ts, errors.ts]
  resources: [toolkit, gate]
  test: [core, io, hosts, app, gate, repo, scripts, setup, helpers, fixtures]
  scripts: ["*.mjs"]
  docs:
    - PRD.md
    - PLAN.md
    - PROGRESS.md
    - STANDARDS.md
    - compatibility-policy.md
    - support-matrix.md
    - adr
    - guides
    - hosts
    - presets
    - migration
    - release
    - gate
    - archive
  output: [README.md]
```

### 1.3 docs/ 用途

| 位置 | 放什么 |
|---|---|
| `PRD.md` `PLAN.md` `PROGRESS.md` | 需求、计划、进度：唯一事实来源，位置固定 |
| `STANDARDS.md` | 本文件 |
| `compatibility-policy.md` `support-matrix.md` | 兼容承诺、宿主与能力支持矩阵 |
| `adr/` | 架构决定，`NNNN-kebab-title.md`，编号递增不复用 |
| `guides/` | 3.x 使用文档（快速开始等） |
| `hosts/` | 各宿主路径与能力核实记录 |
| `presets/` | 经核实的第三方 preset |
| `migration/` | 版本迁移说明 |
| `release/` | 发布清单：宿主验收、安全审查、发布前审计 |
| `gate/` | 冻结的 2.x 手册与威胁模型 |
| `archive/` | 已被取代的历史文档，带索引 README；只增不改 |

### 1.4 新增与变更目录

- 新增一级目录或受管目录的一级子项：同一 PR 改 §1.2；结构性变化另写 ADR。✅（`test/repo/structure.test.ts` 读 §1.2）
- 临时产物、报告、打包结果、交接提示词：一律放 `output/`，不得入库。🟡（.gitignore 挡住误提交；audit:release 检查工作区无未忽略文件）

## 2. 命名规范

| 对象 | 规则 | 例子 | 状态 |
|---|---|---|---|
| 文件、目录 | 英文 kebab-case；文档正文可中文 | `support-matrix.md`、`fs-boundary.ts` | ✅（`test/repo/structure.test.ts`） |
| 文件名中的版本片段 | kebab-case 里的版本号可以含点，例如 `v0.1-scope-and-security-boundaries.md`、`2.x-to-3.x.md`；其余仍小写 kebab-case | `v0.1-…`、`2.x-to-3.x.md` | ✅（`test/repo/structure.test.ts`） |
| 约定大写文件 | 只限 README、CHANGELOG、CONTRIBUTING、SECURITY、LICENSE、AGENTS、PRD、PLAN、PROGRESS、STANDARDS | | ✅（`test/repo/structure.test.ts`） |
| 平台规定的名字 | .github/ 下与 GitHub 约定一致；宿主要求的 SKILL.md | `.github/ISSUE_TEMPLATE/`、`resources/gate/skills/*/SKILL.md` | ✅（结构守卫的例外清单） |
| ADR | `docs/adr/NNNN-kebab-title.md` | `0003-repository-structure-and-standards.md` | ⬜ |
| 测试 | 单测 `<模块>.test.ts`，集成 `<模块>.integration.test.ts`，路径镜像 `src/` | `test/io/fs-boundary.test.ts` | 🟡（`test/repo/structure.test.ts` 守 test/ 一级目录；文件名后缀与路径镜像无检查） |
| 标识符、错误码、日志 | 英文；面向用户的文案经 Presenter 输出；面向用户的 message/fix 提供 zh/en 两套文案，由 Presenter 选择；存储与领域层不拼中文 | `TOOLKIT_SCOPE_INVALID` | ⬜ |
| 分支 | `main` `develop` `release/<版本>` `hotfix/<版本>` `feature/<名字>` | `feature/standards-adr-0003` | 🟡（main/develop 受保护；release-gate 接受的分支 ref 只有与版本对应的 `release/<版本>`、`hotfix/<版本>` 和历史 `codex/stinky-cobbler-<版本>-hardening`，另接受 `main` 与 `v<版本>`；feature/ 命名无检查） |
| 提交 | Conventional Commits：`feat fix refactor docs test chore perf ci` | `docs: ...` | ⬜ |

## 3. 代码规范

（来源：[架构评审 §2.5](archive/architecture-review-2026-10-20.md) 的 25 条，按现状标注强制情况。）

| # | 规则 | 状态 |
|---|---|---|
| C1 | 新代码文件 ≤ 400 行、函数 ≤ 50 行、嵌套 ≤ 4 层；`src/gate` 豁免但冻结 | 🟡（ESLint 对 `src/core`、`io`、`hosts`、`app` 与 `errors.ts`、`version.ts` 全部生效；`eslint.config.js` 的 FROZEN_KERNEL 只剩 `src/gate/**` 与 2.x 入口 `cli.ts`、`mcp-server.ts`） |
| C2 | 依赖方向白名单、无循环（`core` 不依赖 `io/hosts/app`；`gate` 只被入口引用）；不得用动态 `import()` 隐藏循环 | 🟡（dependency-cruiser 已拦：新的循环（包括用动态 `import()` 藏起来的环；`.dependency-cruiser-known-violations.json` 里已知的 15 条循环除外）、`core` 依赖 `io/hosts/app`、`app` 直接 import fs（`app-has-no-fs`，基线只减不增，见 C9）；依赖方向白名单还不存在；`gate` 允许被 `cli.ts`、`mcp-server.ts` 与 `app` 引用（dependency-cruiser `gate-is-only-reached-from-cli`）） |
| C3 | `src/gate` 不加新行为，文件清单与非空行数有基线 | 🟡（`test/repo/gate-frozen.test.ts` 只拦新增 `.ts` 文件和非空行总数超过 16873 基线；删文件允许，非 `.ts` 文件不查；「不加新行为」靠评审） |
| C4 | 宿主、artifact 种类等枚举只在 `core/toolkit/kinds.ts` 定义一次 | 🟡（`test/core/toolkit/spec.test.ts` 断言宿主注册表、适配器的种类与 `kinds.ts` 一致；`test/core/toolkit/lock.test.ts` 断言 lock 的种类取自 `kinds.ts` 的 `LOCKED_KINDS`；别处另行定义枚举无检查） |
| C5 | 每个 schema 属性在 `src/` 有消费点，没有读者的配置键不准存在 | 🟡（`test/repo/config-liveness.test.ts` 只检查 `resources/gate/schemas/*.json` 与 `resources/toolkit/*.json` 的属性名在 `src/` 文本里出现过，不检查真实读取点；`toolkit.schema.json` 的键都写在 `core/toolkit/spec.ts` 的 zod 定义里，所以对 3.x 实际拦不住） |
| C6 | 错误码集中注册，附退出码与可读修复提示；禁止裸 `new Error` | 🟡（ESLint 拦 C1 生效范围内任何 `new Error(...)`；2.x 豁免；集中注册表 ⬜） |
| C7 | 每个命令同时支持人类输出与 `--json`；非零退出码对应错误码；`conflict` 类结果非零退出；一文件一命令（`app/commands/<name>.ts`） | 🟡（`toolkit init`、`toolkit apply` 的冲突退出 7，以及 `TOOLKIT_LEDGER_EMPTY`、`TOOLKIT_CONFIRM_REQUIRED`、`TOOLKIT_LOCK_BLOB_MISSING`、`TOOLKIT_SEARCH_UNVERIFIED`、`SEGMENT_INVALID`、`ENTRY_HOST_INVALID` 的退出 2 有集成测试，部分命令的 `--json` 有集成测试；其余命令的退出码无测试；`toolkit rollback` 遇冲突退出 7、`toolkit apply` 中途停止退出 6、`entry install-host` 遇冲突退出 7 有集成测试；人类输出与一文件一命令 ⬜） |
| C8 | 宿主适配器必须通过 `hosts/conformance/`；宿主特定逻辑只在自己的文件 | 🟡（`test/hosts/conformance.test.ts` 对注册表里每个适配器跑共享检查；宿主特定逻辑放在哪里无检查） |
| C9 | IO 只在 `io/`；`core/`、`app/` 禁止 import `node:fs` | 🟡（dependency-cruiser：`core-has-no-io`、`gate-is-only-reached-from-cli`、`app-has-no-fs`（现有 10 处基线只减不增）；间接碰盘不拦） |
| C10 | 写磁盘必须经 `managed-file` 或 `fs-boundary` | ⬜（`core` 不碰盘已记在 C9；现有 5 个 `app` 文件直接写盘：缓存、`toolkit.lock`、scaffold、rollback 删除，见 PROGRESS 待办） |
| C11 | 资源路径（`resources/` 下）只从一个模块取得，不在各处拼 `projectRoot + "schemas"` | ✅（`src/io/resources.ts` 唯一来源；`test/repo/junk.test.ts` 拦别处的资源路径字面量，豁免：冻结的 `src/gate`、宿主目录名 `"skills"`（`src/hosts`）、用户配置目录名 `"policies"`（`src/io/tiered-config.ts`）） |
| C12 | 运行时依赖 ≤ 10 个；新增依赖须写用途、维护状态、替代方案，并经作者批准 | ⬜（`package.json` 声明 6 个；`src/` 还直接 import 未声明的 `zod`（经 `@modelcontextprotocol/sdk` 间接安装），见 PROGRESS 待办；无工具统计或拦截） |
| C13 | 任何产物不得出现明文密钥，只允许 `${env:NAME}` / `${file:PATH}`；package-smoke 的敏感内容扫描覆盖所有渲染产物 | 🟡（spec 只拒绝 `mcpServers[].env` 值里的明文，`command`、`args` 不查；集成测试断言 env 引用没有被展开进 plan、apply、doctor 的输出和四个宿主的 MCP 文件（`test/app/toolkit-cli.integration.test.ts`），`hosts/conformance` 对每个适配器做 env 条目往返检查；package-smoke 扫描渲染产物 ⬜，PRD S5） |
| C14 | 不留调试输出、注释掉的代码、无主 TODO | 🟡（`test/repo/junk.test.ts`：无主 TODO、超大文件、core/io/hosts 禁 console；注释掉的代码与无引用文件 ⬜） |

### 3.1 工具链

| 工具 | 用途 | 状态 |
|---|---|---|
| ESLint + typescript-eslint | 文件/函数长度、嵌套、裸 `new Error` | 🟡（会拦，但只在 C1 的生效范围内；`src/gate/**` 豁免，见 C1、C6） |
| Prettier | `src/{core,hosts,io,app}` 格式 | ⬜（只有手动 npm run format；hook 与 CI 不检查） |
| `.editorconfig` | 编辑器基本格式 | 🟡（LF 换行另由 `.gitattributes` 的 `eol=lf` 在入库时规范化；编码、末尾换行、缩进、行尾空白只靠编辑器） |
| `.nvmrc` | 源码开发 Node 主版本（22.12） | ⬜（开发约定；CI 用 Node 22/24 矩阵） |
| husky / lint-staged | pre-commit：lint + typecheck；pre-push：unit | 🟡（pre-commit 只跑 ESLint；typecheck 在 pre-push 的 npm run lint 与 CI 里跑） |
| dependency-cruiser | 依赖方向与循环；known-violations 基线 | 🟡（新循环、`core` 越界与 `app` 直接 import fs（`app-has-no-fs`，基线只减不增）会拦；方向白名单还不存在，见 C2、C9） |
| Dependabot | 周依赖扫描 | ⬜（`.github/dependabot.yml` 只在 `develop` 和 `release/2.0.2`，默认分支 `main` 还没有，所以至今没有运行；生效后也只开更新 PR，不拦截） |
| `npm audit` | CI 每次运行 `npm audit --audit-level=high`，有 high 及以上漏洞即失败 | ✅ |
| `audit:release` | 发布前自动审计（结构、密钥、依赖、垃圾、文档链接、工作区） | ✅（release-candidate 工作流） |

## 4. 测试规范

| # | 规则 | 状态 |
|---|---|---|
| T1 | 测试位置镜像源码；夹具放 `test/fixtures/`，辅助放 `test/helpers/` | 🟡（`test/repo/structure.test.ts` 守 `test/` 一级目录；路径镜像无检查，见 §2 测试行） |
| T2 | 修 bug 先写能复现的失败测试 | ⬜ |
| T3 | 禁止为了通过而删除、跳过测试或放松断言；平台差异要分别断言 | ⬜（评审） |
| T4 | 测试与真实环境隔离：XDG 配置、`GIT_*` 环境变量、全局 git 配置都指向临时位置 | ✅ `test/setup/isolate-*.ts` |
| T5 | 集成测试前自动 build；测试纳入类型检查 | ✅ |
| T6 | 覆盖率地板：`core` ≥ 90%，`io`/`hosts` ≥ 85% | 🟡（`npm run coverage` 在 CI 的 ubuntu / Node 22 格子强制 core ≥ 90、io/hosts ≥ 85 行覆盖；分支覆盖 ⬜） |
| T7 | 禁止新增针对文档措辞的探测断言，优先断言不变量 | ⬜ |
| T8 | `core/plan` 可在无磁盘下测试（纯函数 + 快照） | 🟡（`core` 直接 import fs 会被 dependency-cruiser 拦，间接碰盘不拦，见 C9；快照测试 ⬜，目前没有快照测试） |
| T9 | `scripts/` 纳入类型检查 | ⬜（scripts/ 只有 ESLint，未纳入 tsc 类型检查） |

## 5. 文档规范

| # | 规则 | 状态 |
|---|---|---|
| D1 | PRD、PLAN、PROGRESS 是唯一事实来源；需求变了先改 PRD 再改代码；进度只写 PROGRESS | ⬜（评审） |
| D2 | 删除一个能力，同一 PR 删它的 schema、配置、文档 | 🟡（只有 schema 这一半有工具：`test/core/toolkit/spec.test.ts` 锁定 `resources/toolkit/toolkit.schema.json` 与 zod 定义一致，`test/repo/config-liveness.test.ts` 发现 `resources/` 下 schema 里在 `src/` 文本中不再出现的属性名；配置文件与文档无检查） |
| D3 | 仓库内相对链接必须有效 | ✅（`test/repo/docs-links.test.ts`） |
| D4 | 不写编造的验证结果；未验证写 `UNKNOWN / PENDING` | ⬜（评审） |
| D5 | ADR 门槛：难逆转、未来会疑惑、存在真实取舍三项同时满足 | ⬜ |
| D6 | 文档不写本机绝对路径、账号、密钥 | 🟡（package-smoke 在 CI 扫描打包产物里的密钥样式与本机家目录路径；audit:release 全仓扫描密钥样式与本机路径；GitHub 仓库设置已开 secret scanning 与 push protection，推送含已知格式密钥会被拒；账号信息无检查） |

## 6. 分支、提交与 PR

- 分支模型见 [CONTRIBUTING「分支模型」](../CONTRIBUTING.md#分支模型)：`feature/*` → `develop`；`release/*`、`hotfix/*` → `main`，再回合并 `develop`。🟡（`main`、`develop` 有 GitHub 分支保护：必须 PR、六项 CI 通过、禁止强推和删除；这是仓库设置而不是仓库内的工具，管理员可以绕过（未开 `enforce_admins`）；分支流向本身无检查）
- 一个 PR 只做一件事，净变更尽量 ≤ 400 行；纯搬迁（改名、移动）可以超过，但不得夹带内容修改。⬜
- 一次提交只做一件事；commit message 用 Conventional Commits。⬜
- 每个 PR 对应 PLAN.md 的一个任务（纯搬迁批次对应 ADR 的批次）。⬜
- `commit` 和 `push` 分开执行；不从 linked worktree 推送（会让 hook 继承 `GIT_DIR`）。⬜
- 打 tag、GitHub Release、`npm publish` 只由作者执行。⬜（流程约定，无工具强制）

## 7. 发布前审计（每个版本必做）

发布分支（`release/<版本>` 或 `hotfix/<版本>`）合并进 `main` 前，按顺序完成，结果写入 PROGRESS，任何一项不过不得打 tag：

1. **自动审计** ✅ `npm run audit:release`（`scripts/audit-release.mjs`；release-candidate 工作流执行）：
   - 结构：§1.2 白名单、命名规则；
   - 密钥：仓库与打包产物的密钥扫描（打包产物已由 package-smoke 在 CI 扫描；audit:release 全仓扫描密钥样式与本机路径；推送由 GitHub push protection 拦已知格式，GitHub secret scanning 只告警不拦截）；
   - 依赖：`npm audit --audit-level=high` 为 0，运行时依赖 `--omit=dev` 为 0；
   - 垃圾：无引用文件 ⬜、空目录、调试输出、无主 TODO、超大文件、未被忽略的临时产物；
   - 文档：相对链接全部有效。
2. **常规门禁**：`check:version`、lint、全量测试、integration、`test:package`、`release-gate`、`git diff --check`、六项 CI。🟡（推 `v*` tag 或手动触发时 release-candidate 工作流自动跑 check:version、release-gate、typecheck、build、全量测试、integration、test:package、`npm audit --audit-level=high`；六项 CI 由 main/develop 分支保护要求；`git diff --check` 无自动检查）
3. **逐文件全量审计**：按 `git -c core.quotePath=false ls-files` 生成清单，分片派只读审计（grok-conductor），每个文件给出 KEEP / FIX / DELETE / ARCHIVE / MOVE_OUTPUT 结论，与清单逐项对账、零遗漏；DELETE 先给作者确认。⬜（流程，人工执行）
4. **安全审查**：每组最终候选 bytes 都按 `docs/release/security-review-checklist.md` 重新执行，包括其「正式发布门禁」；本版改动涉及用户输入、鉴权、密钥、文件写入、外部来源时，另做专项审查。🟡（门禁里的真实 `.tgz` 安装、SBOM 与 lockfile 一对一对账、checksum 校验由 release-candidate 工作流在推 `v*` tag 或手动触发时自动执行，每个 PR 的 CI 也通过 `test:package` 真实打包并安装；实时核对 registry、tag 与 Release、真实宿主 E2E、专项审查仍是人工）
5. **真实宿主验收**：按 `docs/release/host-acceptance-checklist.md` 执行，四个宿主绑定同一份候选 bytes：Codex、ZCode 做第 1–8 节（2.x 门禁的真实消费者验证），Claude Code、Cursor 做第 2b 节的 toolkit `plan`、`apply`、`doctor`、`rollback`（PRD S1）。2.x 维护版（如 `release/2.0.2`）按该分支自带的清单，在 Codex 与 ZCode 上验证。记录宿主版本与候选包 hash；做不到的写 `UNKNOWN / PENDING`，不得写成通过。⬜（人工执行）

## 8. 修改本规范

- 作者可以随时修改、新增、删除任何条目；改动走普通 PR，并在 PROGRESS 记一行。
- 新增规则时写清楚状态（✅ / 🟡 / ⬜）；⬜ 的规则要么在后续批次补上工具强制，要么在评审清单里明确由谁检查。
- 规则与代码冲突时，以本文件为准修代码；确实要改规则，先改本文件。
