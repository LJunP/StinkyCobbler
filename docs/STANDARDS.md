# Stinky Cobbler 项目规范（STANDARDS）

> 本文件是项目的**总规则**，所有贡献者（包括 Claude、grok、Codex 等 AI 工具）改动仓库前必须先读，改动必须遵守。
> 规则由作者维护，可以随时修改和新增：改规则就是改本文件，走普通 PR。§1 的 `repo-structure` 代码块由测试直接读取，改它就等于改目录守卫。
> 决定来源：[ADR-0003](decisions/ADR-0003-repository-structure-and-standards.md)。迁移期间（P2–P7 未完成前）仓库还没有完全符合本文件，进度见 ADR-0003 的「迁移批次」。

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
│   └── gate/           冻结的 2.x（domain mcp policy runtime storage config contracts entry）
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

### 1.2 机器可读白名单（结构守卫读取本块）

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

- 新增一级目录或受管目录的一级子项：同一 PR 改 §1.2；结构性变化另写 ADR。✅（P6 后由 `test/repo/structure.test.ts` 强制）
- 临时产物、报告、打包结果、交接提示词：一律放 `output/`，不得入库。✅（`.gitignore`）

## 2. 命名规范

| 对象 | 规则 | 例子 | 状态 |
|---|---|---|---|
| 文件、目录 | 英文 kebab-case；文档正文可中文 | `support-matrix.md`、`fs-boundary.ts` | 🟡（P2 改名后由结构守卫检查） |
| 约定大写文件 | 只限 README、CHANGELOG、CONTRIBUTING、SECURITY、LICENSE、AGENTS、PRD、PLAN、PROGRESS、STANDARDS | | ✅（白名单） |
| ADR | `docs/adr/NNNN-kebab-title.md` | `0003-repository-structure-and-standards.md` | ⬜ |
| 测试 | 单测 `<模块>.test.ts`，集成 `<模块>.integration.test.ts`，路径镜像 `src/` | `test/io/fs-boundary.test.ts` | 🟡 |
| 标识符、错误码、日志 | 英文；面向用户的文案经 Presenter 输出 | `TOOLKIT_SCOPE_INVALID` | ⬜ |
| 分支 | `main` `develop` `release/<版本>` `hotfix/<版本>` `feature/<名字>` | `feature/standards-adr-0003` | ✅（release-gate、CI 触发） |
| 提交 | Conventional Commits：`feat fix refactor docs test chore perf ci` | `docs: ...` | ⬜ |

## 3. 代码规范

（来源：架构评审 §2.5 的 25 条，按现状标注强制情况。）

| # | 规则 | 状态 |
|---|---|---|
| C1 | 新代码文件 ≤ 400 行、函数 ≤ 50 行、嵌套 ≤ 4 层；`src/gate` 豁免但冻结 | ✅ ESLint |
| C2 | 依赖方向白名单、无循环（`core` 不依赖 `io/app`；`gate` 只被入口引用） | ✅ dependency-cruiser |
| C3 | `src/gate` 不加新行为，文件清单与非空行数有基线 | ✅ `test/gate-frozen.test.ts` |
| C4 | 宿主、artifact 种类等枚举只在 `core/toolkit/kinds.ts` 定义一次 | 🟡 |
| C5 | 每个 schema 属性在 `src/` 有消费点，没有读者的配置键不准存在 | ✅ config-liveness 测试 |
| C6 | 错误码集中注册，附退出码与可读修复提示；禁止裸 `new Error` | 🟡（裸 Error 已拦，集中注册表 ⬜） |
| C7 | 每个命令同时支持人类输出与 `--json`；非零退出码对应错误码 | 🟡 |
| C8 | 宿主适配器必须通过 `hosts/conformance/`；宿主特定逻辑只在自己的文件 | 🟡 |
| C9 | IO 只在 `io/`；`core/`、`app/` 禁止 import `node:fs` | ⬜ |
| C10 | 写磁盘必须经 `managed-file` 或 `fs-boundary` | 🟡 |
| C11 | 资源路径（`resources/` 下）只从一个模块取得，不在各处拼 `projectRoot + "schemas"` | ⬜（P4） |
| C12 | 运行时依赖 ≤ 10 个；新增依赖须写用途、维护状态、替代方案，并经作者批准 | 🟡（现 6 个） |
| C13 | 任何产物不得出现明文密钥，只允许 `${env:NAME}` / `${file:PATH}` | ✅ spec 校验 + 集成测试 |
| C14 | 不留调试输出、注释掉的代码、无主 TODO | ⬜（P6 垃圾检查） |

## 4. 测试规范

| # | 规则 | 状态 |
|---|---|---|
| T1 | 测试位置镜像源码；夹具放 `test/fixtures/`，辅助放 `test/helpers/` | 🟡（P3） |
| T2 | 修 bug 先写能复现的失败测试 | ⬜ |
| T3 | 禁止为了通过而删除、跳过测试或放松断言；平台差异要分别断言 | ⬜（评审） |
| T4 | 测试与真实环境隔离：XDG 配置、`GIT_*` 环境变量、全局 git 配置都指向临时位置 | ✅ `test/setup/isolate-*.ts` |
| T5 | 集成测试前自动 build；测试纳入类型检查 | ✅ |
| T6 | 覆盖率地板：`core` ≥ 90%，`io`/`hosts` ≥ 85% | ⬜ |
| T7 | 禁止新增针对文档措辞的探测断言，优先断言不变量 | ⬜ |

## 5. 文档规范

| # | 规则 | 状态 |
|---|---|---|
| D1 | PRD、PLAN、PROGRESS 是唯一事实来源；需求变了先改 PRD 再改代码；进度只写 PROGRESS | ⬜（评审） |
| D2 | 删除一个能力，同一 PR 删它的 schema、配置、文档 | ⬜ |
| D3 | 仓库内相对链接必须有效 | ⬜（P6 链接检查） |
| D4 | 不写编造的验证结果；未验证写 `UNKNOWN / PENDING` | ⬜（评审） |
| D5 | ADR 门槛：难逆转、未来会疑惑、存在真实取舍三项同时满足 | ⬜ |
| D6 | 文档不写本机绝对路径、账号、密钥 | 🟡（package-smoke 扫描） |

## 6. 分支、提交与 PR

- 分支模型见 [CONTRIBUTING「分支模型」](../CONTRIBUTING.md#分支模型)：`feature/*` → `develop`；`release/*`、`hotfix/*` → `main`，再回合并 `develop`。✅（`main`、`develop` 受保护：必须 PR、六项 CI 通过、禁止强推和删除）
- 一个 PR 只做一件事，净变更尽量 ≤ 400 行；纯搬迁（改名、移动）可以超过，但不得夹带内容修改。⬜
- `commit` 和 `push` 分开执行；不从 linked worktree 推送（会让 hook 继承 `GIT_DIR`）。⬜
- 打 tag、GitHub Release、`npm publish` 只由作者执行。✅（流程约定）

## 7. 发布前审计（每个版本必做）

发布分支（`release/<版本>` 或 `hotfix/<版本>`）合并进 `main` 前，按顺序完成，结果写入 PROGRESS，任何一项不过不得打 tag：

1. **自动审计** `npm run audit:release`（P6 实现）：
   - 结构：§1.2 白名单、命名规则；
   - 密钥：仓库与打包产物的密钥扫描；
   - 依赖：`npm audit --audit-level=high` 为 0，运行时依赖 `--omit=dev` 为 0；
   - 垃圾：无引用文件、空目录、调试输出、无主 TODO、超大文件、未被忽略的临时产物；
   - 文档：相对链接全部有效。
2. **常规门禁**：`check:version`、lint、全量测试、integration、`test:package`、`release-gate`、`git diff --check`、六项 CI。
3. **逐文件全量审计**：按 `git -c core.quotePath=false ls-files` 生成清单，分片派只读审计（grok-conductor），每个文件给出 KEEP / FIX / DELETE / ARCHIVE / MOVE_OUTPUT 结论，与清单逐项对账、零遗漏；DELETE 先给作者确认。
4. **安全审查**：改动涉及用户输入、鉴权、密钥、文件写入、外部来源时做专项审查。
5. **真实宿主验收**：按 `docs/release/` 的宿主验收清单记录宿主版本与候选包 hash；做不到的写 `UNKNOWN / PENDING`，不得写成通过。

## 8. 修改本规范

- 作者可以随时修改、新增、删除任何条目；改动走普通 PR，并在 PROGRESS 记一行。
- 新增规则时写清楚状态（✅ / 🟡 / ⬜）；⬜ 的规则要么在后续批次补上工具强制，要么在评审清单里明确由谁检查。
- 规则与代码冲突时，以本文件为准修代码；确实要改规则，先改本文件。
