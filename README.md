# Stinky Cobbler

Stinky Cobbler 3.x 是声明式 AI agent 工具箱的包管理器。一份 `toolkit.yaml` 描述 skill、MCP server 和指令，`toolkit plan` 只预览，`toolkit apply` 才写到 Codex、Claude Code、Cursor 或 ZCode。

当前 checkout 是 **3.0.0-rc.1** 源码候选，不是 `3.0.0`。没有 npm tag，也没有 GitHub Release，未发布到 npm。npm 上最新是 2.0.1（本仓库记录的 tag `v2.0.1`，2026-09-13）。3.0 GA 被四个宿主的真实安装冒烟挡住，该冒烟仍是 `UNKNOWN / PENDING`。registry 与 Releases 的当前状态以 [npm](https://www.npmjs.com/package/stinky-cobbler) 和 [GitHub Releases](https://github.com/LJunP/StinkyCobbler/releases) 为准。

公共可执行文件是 `stinky-cobbler` 和 `stinky-cobbler-mcp`。`dist/**` 是内部实现，不是库 API。

## 它解决什么问题

各家 AI 编程工具的 skill 目录、MCP 配置和指令文件格式、作用域都不一样。用户要的是自己的工具箱跟着走，而不是在每个宿主里手改一遍，改坏了也找不回来。市面同类多是同步脚本：直接覆盖，没有预览，没有回滚，也不认出用户手改。

本工具用一份声明式 `toolkit.yaml` 描述工具箱，再把它落到各宿主。`plan` 先给出每个文件的 diff，不写盘。`apply` 只改受管内容，用户手改过的文件一律 `conflict`，不覆盖。每次变更有内容寻址备份和本地账本，`rollback` 按 hash 校验后逐步回退。`doctor` 报告每个宿主的状态和漂移。

## 快速开始

需要 Node.js 22 或更新版本（`package.json` 的 `engines` 是 `>=22.0.0`）。下面四条命令与 [toolkit 快速开始](./docs/guides/toolkit-quickstart.md) 一致，从本地安装包到第一次成功的 `toolkit apply`。`init` 和 `lock` 之间要编辑 `toolkit.yaml`，这次编辑不是命令。3.0.0-rc.1 没有 registry 上的安装包；`npm install -g stinky-cobbler` 装到的是已发布的 2.0.1，没有这组 `toolkit` 命令。tarball 来自本仓库的 `npm pack`，或来自你自己打的候选包。

```bash
npm install -g stinky-cobbler-*.tgz
stinky-cobbler toolkit init --json
stinky-cobbler toolkit lock --json
stinky-cobbler toolkit apply --yes --json
```

在本仓库里从源码运行：

```bash
npm install
npm run build
node dist/cli.js toolkit init --json
node dist/cli.js toolkit plan --json
node dist/cli.js toolkit apply --json
node dist/cli.js toolkit doctor --json
```

把当前 checkout 装到全局、而不是装 registry 上的另一版本：`npm install -g .`。

`init` 把带注释的 `toolkit.yaml` 写到 `$XDG_CONFIG_HOME/stinky-cobbler/toolkit.yaml`。没有设置该变量时，路径是 `~/.config/stinky-cobbler/toolkit.yaml`。文件已经存在就拒绝覆盖。`plan` 不修改宿主目录。没有变更时 `apply` 可以直接运行。有变更时必须加上 `--yes`。冲突不会覆盖手改过的受管文件。

## 命令一览

`node dist/cli.js toolkit --help` 的子命令如下。写盘一列只描述该命令自己的行为。

| 子命令 | 是否写盘 |
|---|---|
| `init` | 写一份 `toolkit.yaml`（默认 user 作用域）。已存在则拒绝覆盖。 |
| `plan` | 不写盘。有 lock 时预览 blob 里的字节，和 `apply` 写入的完全一致；没有 lock 时预览当前源文件（此时 `apply` 会拒绝）。 |
| `apply` | 写宿主受管文件、managed-state sidecar、内容寻址备份，并追加 toolkit 账本。有变更必须 `--yes`。冲突不覆盖。有 skill 或指令时必须先 `lock`，安装的是 blob 里的字节。 |
| `rollback` | 把最后一次 apply 按账本写回去。用 `--last` 或 `--to <applyId>`，且只能回最后一次。账本为空则失败。当前字节或 sidecar hash 不符则 `conflict` 并停止。 |
| `doctor` | 不写盘。报告漂移、`orphans`（受管但规格已不再指向的文件，toolkit 不删除，由用户处理）、`${env:NAME}` 的变量名是否出现在当前进程（不打印值）、command 是否存在、密钥提示，以及 `role: knowledge` 的新鲜度。没有该 server 的工具结果时新鲜度是 `unavailable`，不读取 `sources` 建索引。 |
| `list` | 不写盘。列出已观察到的 skill、MCP 和指令。command 还没有观察。 |
| `lock` | 写规格旁边的 `toolkit.lock` 和 `blobs/<sha256>`。`git+` 与 `npm:` 的 skill 在这时抓取，正文进 `sources/`，不执行来源里的脚本。不改宿主目录。`skills.sh:` 不抓取，没有 hash。找不到的本地文件记为 `absent`。 |
| `update` | 不改 `toolkit.lock`，不写宿主。重新读取本地来源，并重新抓取 `git+` 和 `npm:`（会改 `sources/`），只输出 plan diff。之后的 `apply` 仍安装锁定字节。 |
| `search <query>` | 不写盘，不访问网络。目录 API 未核实，返回 `TOOLKIT_SEARCH_UNVERIFIED`。 |
| `memory` | `show <id>` 不写盘，只打印受管段落原文。`edit <id> --file <path>` 只替换已经存在的那一段。目前只有 Claude Code 有已核实的 md 段落路径；Codex、Cursor、ZCode 返回 `TOOLKIT_HOST_UNSUPPORTED`。 |

`memory` 在帮助里还有 `show` 和 `edit`。帮助原文：

```text
init, plan, apply, rollback, doctor, list, lock, update, search <query>, memory
```

## `toolkit.yaml`

规格版本是 `1`。同一份文件里的 artifact `id` 必须唯一。

| 种类 | 规格里写什么 |
|---|---|
| `skill` | `id` 与 `source`。`source` 可以是本地路径、`git+`、`npm:` 或 `skills.sh:`。`skills.sh:` 仍然不抓取。 |
| `mcp-server` | `id`、`transport`（`stdio` 或 `http`）、`command`。可选 `args`、`env`、`role: knowledge` 和 `sources`。 |
| `instructions` | `id` 与 `source`。可选 `kind: memory`、本地 `files` 目录，以及按宿主的 `render`。`kind: memory` 只写入宿主文件里的受管段落，段落外字节保持不变。 |
| `bundles` | `id` 与 `includes`。只展开 lock 里已经解析出 hash 的 include。 |
| `command` | 类型里有这个种类。规格没有 command 字段，`list` 不观察它。 |

宿主 id：`zcode`、`codex`、`claude-code`、`cursor`。可以写在顶层 `hosts`，也可以写在单个 skill 上。Gemini CLI 不在 3.0 里。

作用域是 `user` 或 `project`。`user` 读 `$XDG_CONFIG_HOME/stinky-cobbler/toolkit.yaml`（未设置时是 `~/.config/stinky-cobbler/toolkit.yaml`）。`project` 读当前目录 `.stinky-cobbler/toolkit.yaml`。一次命令只读这一份，不把两份按 `id` 合并。PRD 写过 builtin → user → project 的按 `id` 合并，当前 `toolkit` 命令没有做这层合并。

冻结的 2.x 策略才是分层配置：包内 `resources/gate/policies/`，然后 `$XDG_CONFIG_HOME/stinky-cobbler/policies/`，然后项目 `.stinky-cobbler/policies/`。见 [分层配置指南](./docs/gate/tiered-config-guide.md)。

密钥只允许整段值为 `${env:NAME}` 或 `${file:PATH}`。明文会被拒绝（`SECRET_LITERAL_FORBIDDEN`）。`doctor` 对 Claude Code 和 Codex 给出 `SECRET_NEEDS_SHELL_ENV`（按已核实文档，它们的展开语法不是 `${env:NAME}`）。Cursor 的文档使用 `${env:NAME}`，不给这条提示。ZCode 的展开没有写在已核对的官方页上，`doctor` 给出 `SECRET_EXPANSION_UNKNOWN`。这些是文档结论，不是对四个宿主二进制做的展开实验。

## 宿主支持

路径说明在 [docs/hosts/](./docs/hosts/codex.md)。承诺边界在 [支持矩阵](./docs/support-matrix.md)。四个宿主的真实安装冒烟都是 `UNKNOWN / PENDING`。配置写成功不等于宿主重启后发现，也不等于消费者 E2E 通过。

| 宿主 | 路径依据 | 真实冒烟 |
|---|---|---|
| Codex | 安装路径由 2.0.1 安装器与 `test/gate/entry/host-codex.test.ts` 锁定；MCP 环境变量写法按官方文档核实，代码在 `src/hosts/codex.ts`。无自定义 slash-command 文件，指令路径未写入。见 [codex.md](./docs/hosts/codex.md)。 | `UNKNOWN / PENDING` |
| ZCode | 安装路径由 2.0.1 安装器与 entry 测试锁定；没有单独的公开路径文档。MCP 展开页未写 `${env:NAME}`。代码在 `src/hosts/zcode.ts`。见 [zcode.md](./docs/hosts/zcode.md)。 | `UNKNOWN / PENDING` |
| Claude Code | 路径按官方文档核实（2026-10-21），代码在 `src/hosts/claude-code.ts`。见 [claude-code.md](./docs/hosts/claude-code.md)。bundled `entry install-host` 为 `ENTRY_HOST_UNSUPPORTED`。 | `UNKNOWN / PENDING` |
| Cursor | 路径按官方文档核实（2026-10-21），代码在 `src/hosts/cursor.ts`。见 [cursor.md](./docs/hosts/cursor.md)。bundled `entry install-host` 为 `ENTRY_HOST_UNSUPPORTED`。 | `UNKNOWN / PENDING` |

## 安全模型

`toolkit plan`、`doctor`、`list`、`search` 和 `memory show` 不写宿主文件。`apply` 只改计划里的受管目标。手改过的受管文件是 `conflict`，不覆盖。写入走内容寻址备份（`<file>.stinky-cobbler-backup-<sha256>.bak`）和 sidecar（`<file>.stinky-cobbler-managed.json`）。`rollback` 先核对当前字节和 sidecar 的 hash，再按账本恢复。toolkit 账本是配置目录下的 `ledger.jsonl`，不是操作系统审计日志。

这不是 OS 沙箱。它不拦截宿主自己的文件工具、Shell、Git 或第三方 MCP。它也不调用模型，不调度 agent。

## 冻结的 2.x 门禁

2.x 是 Cooperative Mode 下的本地受控执行与审计层，不是当前主产品。保证只覆盖经本 CLI/MCP 路由的操作。宿主原生文件工具可以绕过它。它不是操作系统沙箱。

顶层命令里，下面这些在 `--help` 中标记 `[deprecated 2.x]`，并冻结到 4.0 再决定删除或拆包：`validate`、`recommend`、`doctor`、`config`、`init`、`task`、`approval`、`evidence`、`receipt`、`runtime`、`audit`、`ledger`、`lease`、`plan`、`write`、`orchestration`。`entry` 和 `toolkit` 不标 deprecated。冻结由 `test/repo/gate-frozen.test.ts` 守卫：只修会丢数据或误导用户的 P0，不扩展。2.x 分支只修 P0，直到 3.0 GA 之后 6 个月。2.x 的持久化记录在 3.x 里保持可读、可安全终止。`entry install-host` 与受管文件 sidecar 保持字节级兼容。

受控写入链是：持久化 Task，精确 `delegate-capability` Approval，受限 Lease，单目标 WriteIntent 捕获 `expectedPreimageHash`，然后才是可选的 `write-confirm`。create/modify 可以 `auto-allow`。这个 auto-allow 不会跳过 TaskAuthority、Lease、writeSet、路径或 preimage。delete 必须单独确认，不会被 auto-allow。apply 前会重验 TaskAuthority、Lease、scope 和 preimage。

只读 Runtime 的 cancel/deadline 使用同进程协作式（cooperative）`AbortSignal`。这不是宿主进程硬中断，也不是 hard kill。停止若与在途调用（in-flight）竞争，底层结果可能仍是 `UNKNOWN`，不能把它写成硬中断成功。

`entry install-host` 会改宿主配置，必须先 `--dry-run`。Side effects: install-host writes the host skill and, for ZCode, its command file; --mcp merges an MCP entry into the current host config. Managed-state sidecars are written, and a verified byte-for-byte backup may be created during a managed upgrade. Existing user-edited files are preserved as conflicts rather than overwritten. Rollback is a separate explicit `--rollback` operation.

2.0.1 发布后的长验证记录和 2.x 能力矩阵细则不在本文件。见 [CHANGELOG](./CHANGELOG.md)、[归档](./docs/archive/README.md) 和 [支持矩阵](./docs/support-matrix.md)。

## 项目目录

下面是仓库里的两层结构。`dist/` 和 `node_modules/` 不入库。`output/` 只有 `README.md` 入库。

```text
.
├── .github/
│   ├── ISSUE_TEMPLATE/
│   ├── workflows/
│   ├── dependabot.yml
│   └── pull_request_template.md
├── .husky/
│   ├── pre-commit             lint-staged
│   └── pre-push               lint 与 unit
├── docs/
│   ├── adr/                   NNNN-kebab-title.md
│   ├── archive/               已被取代的历史文档
│   ├── gate/                  冻结的 2.x 手册与威胁模型
│   ├── guides/                3.x 使用文档
│   ├── hosts/                 四宿主路径笔记
│   ├── migration/             2.x-to-3.x.md
│   ├── presets/               projectmem.md
│   ├── release/               宿主验收与安全审查清单
│   ├── PLAN.md  PRD.md  PROGRESS.md  STANDARDS.md
│   ├── compatibility-policy.md
│   └── support-matrix.md
├── output/README.md           其余内容 gitignore
├── resources/
│   ├── toolkit/               3.x：toolkit.schema.json
│   └── gate/                  冻结 2.x：schemas、policies、profiles、packs、plugins、examples、skills
│       ├── schemas/
│       ├── policies/
│       ├── profiles/
│       ├── packs/
│       ├── plugins/
│       ├── examples/
│       └── skills/            templates/ 与渲染好的 Codex/ZCode skill 和 command
├── scripts/                   构建、打包、发布门禁、审计与 skill 渲染（*.mjs）
├── src/
│   ├── app/                   3.x 命令即用例；也注册冻结的 2.x 命令
│   ├── core/                  plan/、render/、toolkit/（3.x，不直接碰 fs）
│   ├── gate/                  冻结的 2.x 内核
│   │   ├── config/            注册表、分层 YAML、workspace 配置
│   │   ├── contracts/         schema registry 与共享契约类型
│   │   ├── entry/             preflight 与 install-host
│   │   ├── security/          工作区路径策略门面
│   │   ├── domain/
│   │   ├── mcp/
│   │   ├── policy/
│   │   ├── runtime/
│   │   └── storage/
│   ├── hosts/                 四宿主适配与 conformance/
│   ├── io/                    有界读写、受管文件、段落、分层合并、toolkit 账本
│   ├── cli.ts  mcp-server.ts  errors.ts  version.ts
├── test/
│   ├── app/                   3.x 命令
│   ├── core/                  3.x 纯逻辑
│   ├── gate/                  冻结的 2.x 门禁
│   ├── helpers/               测试辅助
│   ├── hosts/                 宿主适配与 conformance
│   ├── io/                    磁盘边界
│   ├── repo/                  结构、链接、垃圾守卫
│   ├── scripts/               scripts/ 的测试
│   └── setup/                 集成测试的 dist 新鲜度检查
├── dist/                      不入库，build 产物
├── node_modules/              不入库
└── （根目录文件见下表）
```

### 根目录文件

| 路径 | 归属 | 用途 |
|---|---|---|
| `.dependency-cruiser-known-violations.json` | 构建/发布 | dependency-cruiser 基线，覆盖 2.x 已知循环和 `app-has-no-fs` 的既有边，只降不升。 |
| `.dependency-cruiser.cjs` | 构建/发布 | 依赖方向规则。`src/core` 不碰 fs。`src/gate` 可以被 `cli.ts`、`mcp-server.ts` 和 `src/app` 引用（dependency-cruiser `gate-is-only-reached-from-cli`）。 |
| `.editorconfig` | 构建/发布 | 编辑器基本格式。 |
| `.gitattributes` | 构建/发布 | 文本入库时规范为 LF（`* text=auto eol=lf`）。 |
| `.gitignore` | 构建/发布 | 忽略 `dist/`、`node_modules/`、`output/` 内容（保留 `output/README.md`）等。 |
| `.npmrc` | 构建/发布 | `omit-lockfile-registry-resolved=true`，lockfile 不写 registry resolved。 |
| `.nvmrc` | 构建/发布 | 源码开发使用的 Node 主版本补丁，当前是 `22.12`。 |
| `.prettierrc` | 构建/发布 | Prettier。`npm run format` 只覆盖 `src/{core,hosts,io,app}`。 |
| `AGENTS.md` | 文档 | 给 AI 工具和人类贡献者的入口，指向 STANDARDS。 |
| `CHANGELOG.md` | 文档 | 版本变更记录。发布状态以 npm 与 GitHub 为准。 |
| `CONTRIBUTING.md` | 文档 | 贡献说明。 |
| `LICENSE` | 文档 | Apache-2.0 许可文本。 |
| `README.md` | 文档 | 本文件。 |
| `SECURITY.md` | 文档 | 安全策略与 2.x 门禁边界。 |
| `eslint.config.js` | 构建/发布 | ESLint。新代码有文件长度、函数长度和嵌套限制；冻结内核的存量问题降为 warning。 |
| `package-lock.json` | 构建/发布 | 锁定依赖树。版本必须与 `package.json` 一致。 |
| `package.json` | 构建/发布 | 包清单。当前版本 `3.0.0-rc.1`，`bin`、`engines`、`files` 都在这里。 |
| `tsconfig.json` | 构建/发布 | 生产 TypeScript 配置。 |
| `tsconfig.test.json` | 构建/发布 | 测试类型检查配置。 |
| `vitest.config.ts` | 构建/发布 | Vitest 的 `unit` 与 `integration` 两个 project。 |

### 顶层目录

| 路径 | 归属 | 用途 |
|---|---|---|
| `.github/` | 构建/发布 | `workflows/ci.yml` 与 `workflows/release-candidate.yml`（Ubuntu / macOS / Windows × Node 22 / 24），以及 `ISSUE_TEMPLATE/`、`pull_request_template.md`、`dependabot.yml`。 |
| `.husky/` | 构建/发布 | `pre-commit` 跑 lint-staged。`pre-push` 跑 lint 与 unit。 |
| `docs/` | 文档 | 产品与使用文档。`STANDARDS.md` 是项目总规范。`PRD.md`、`PLAN.md`、`PROGRESS.md` 是当前事实来源。`compatibility-policy.md` 与 `support-matrix.md` 是兼容承诺与支持矩阵。`adr/` 是架构决定。`guides/` 是 3.x 上手文档。`hosts/` 是四宿主路径。`presets/` 是已核实的 preset。`migration/` 是 2.x 到 3.x。`release/` 是宿主验收与安全审查清单。`gate/` 是冻结的 2.x 手册与威胁模型。`archive/` 只保留已被取代的历史设计，不是当前规范。 |
| `output/` | 不入库 | 临时或生成产物。只有 `output/README.md` 入库。`src/`、`test/`、`scripts/` 不得从这里读取。 |
| `resources/toolkit/` | 3.x | `toolkit.schema.json`。 |
| `resources/gate/` | 冻结 2.x | schemas、policies、profiles、packs、plugins、examples、skills——skills 下是 `templates/` 与渲染好的 Codex/ZCode skill 和 command 文件；随 npm 包发布。 |
| `scripts/` | 构建/发布 | `build.mjs`、`package-smoke.mjs`、`release-gate.mjs`、`release-provenance.mjs`、离线包与 SBOM、`render-skills.mjs`、校验和。 |
| `src/` | 混合 | TypeScript 源码。3.x 在 `core/`（`plan/`、`render/`、`toolkit/`）、`hosts/`（含 `conformance/`）、`io/`，以及 `app/` 里的 toolkit 用例。冻结 2.x 在 `gate/`（`config/`、`contracts/`、`entry/`、`security/`、`domain/`、`mcp/`、`policy/`、`runtime/`、`storage/`）。根上有 `cli.ts`、`mcp-server.ts`、`errors.ts`、`version.ts`。 |
| `test/` | 混合 | Vitest，与 `src/` 镜像。`gate/` 覆盖冻结的 2.x 门禁。`app/`、`core/`、`io/`、`hosts/` 覆盖 3.x。`repo/` 是结构、链接和垃圾守卫。`scripts/` 覆盖 `scripts/`。`setup/` 检查集成测试用的 dist 是否新鲜。`helpers/` 是测试辅助。 |
| `dist/` | 不入库 | `npm run build` 的输出。不作为源码事实。 |
| `node_modules/` | 不入库 | 依赖安装目录。 |

## 开发与验证

已安装的 CLI/MCP 要求 Node.js 22+。源码开发和测试里的 Vite 8 要求 Node.js 22.12+，也支持 Node 24。`.nvmrc` 是 `22.12`。用 `npm ci` 按已提交的 lockfile 安装。

```bash
npm ci
npm run lint
npm test
npm run test:integration
npm run test:package
npm run audit:release
```

`npm run lint` 是 typecheck、测试类型基线、ESLint 和 dependency-cruiser。`npm test` 跑 Vitest。`npm run test:integration` 只跑 integration project。`npm run test:package` 会先 build，再做 pack 与安装冒烟。`npm run audit:release` 跑发布前自动审计（结构、密钥、依赖、垃圾、文档链接、工作区）。

发布门禁：

```bash
node scripts/release-gate.mjs --expected "$PACKAGE_VERSION" --git-ref "$PACKAGE_REF"
```

不带参数时，它只核对 `package.json`、`package-lock.json` 和 `src/version.ts` 的版本一致。同时传入 `--expected` 和 `--git-ref` 时，ref 只能是：`main`、精确版本标签 `v<版本>`、`release/<版本>`、`hotfix/<版本>`，以及仅用于复核历史 provenance 的旧 ref `codex/stinky-cobbler-<版本>-hardening`（2.0.1、2.0.2）。其他 ref，包括另一个版本的 `release/` 或 `hotfix/`，会被 `dispatchRefMismatch` 拒绝。这些命令只检查当前源码候选的对应契约。绿测试、打包和 release gate 都不等于 npm publish、git tag 或 GitHub Release。

分支怎么切、合进哪里，见 [CONTRIBUTING 的「分支模型」](./CONTRIBUTING.md#分支模型)。

## 版本与发布

2.0.1 是已经发布的版本。`release/2.0.2` 已推送，CI 为绿，合入 `main` 的 PR #2 开着，等作者打 tag 和发布。不能把含有 3.x 的分支合并进 main 来发 2.0.2。

3.x 在 `develop` 上经 `feature/*` 分支进行。旧分支 `codex/stinky-cobbler-3.0-m0` 已经不在。没有 tag，没有 `npm publish`，四个宿主的安装冒烟仍是 `UNKNOWN / PENDING`，GA 发布被挡住。最新状态以 [PROGRESS](./docs/PROGRESS.md) 为准。

## 文档索引

- [STANDARDS](./docs/STANDARDS.md)（项目总规范，改动仓库前必读）
- [AGENTS.md](./AGENTS.md)（入口，指向 STANDARDS）
- [PRD](./docs/PRD.md)
- [PLAN](./docs/PLAN.md)
- [PROGRESS](./docs/PROGRESS.md)
- [ADR-0001 产品范围与版本边界](./docs/adr/0001-product-scope-and-version-boundaries.md)
- [ADR-0002 从权限门禁转向工具箱包管理器](./docs/adr/0002-pivot-to-agent-toolkit-package-manager.md)
- [ADR-0003 仓库目录结构、命名与持续治理](./docs/adr/0003-repository-structure-and-standards.md)
- [架构评审与发展规划](./docs/archive/architecture-review-2026-10-20.md)
- [toolkit 快速开始](./docs/guides/toolkit-quickstart.md)
- [使用说明书](./docs/gate/user-manual.md)
- [高级用户配置指南](./docs/gate/advanced-config-guide.md)
- [分层配置指南](./docs/gate/tiered-config-guide.md)
- [发布前宿主验证清单](./docs/release/host-acceptance-checklist.md)
- [零终端用户指南](./docs/gate/no-terminal-guide.md)
- [非开发用户使用模型](./docs/gate/non-developer-model.md)
- [从 2.x 到 3.x](./docs/migration/2.x-to-3.x.md)
- [projectmem preset](./docs/presets/projectmem.md)
- [支持矩阵](./docs/support-matrix.md)
- [兼容与迁移政策](./docs/compatibility-policy.md)
- [宿主路径](./docs/hosts/codex.md) · [Claude Code](./docs/hosts/claude-code.md) · [Cursor](./docs/hosts/cursor.md) · [ZCode](./docs/hosts/zcode.md)
- [威胁模型与权限设计](./docs/gate/threat-model.md)
- [发布前安全审查清单](./docs/release/security-review-checklist.md)
- [安全策略](./SECURITY.md)
- [贡献指南](./CONTRIBUTING.md)
- [CHANGELOG](./CHANGELOG.md)
- [归档](./docs/archive/README.md)（历史文档，不是当前规范）

## License

[Apache-2.0](./LICENSE)
