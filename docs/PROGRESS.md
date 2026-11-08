# 进度记录（PROGRESS）

> 只追加，最新在上。每条：日期 / 任务 / 做了什么 / 验证 / 待办与问题。

## 2026-11-08 · 2.0.2 发布前审计

- `release/2.0.2`（`16a75c3`）上手动触发 `release-candidate` 工作流（workflow_dispatch，version 2.0.2；只读权限，只上传构建产物，不发布）：六矩阵 verify（typecheck、build、`npm test`、`test:integration`、`test:package`）与 artifacts（`npm audit --audit-level=high`、SBOM、精确 tarball 与校验和、离线包、手册、产物校验）七个 job 全部成功，run 42462014144。PR #2 的 12 项 CI 也全绿、`mergeStateStatus` CLEAN。
- 更正：此前建议"发布前在 `release/2.0.2` 上跑 `npm run audit:release`"不成立——该脚本是 ADR-0003 P6 加在 develop 的，2.0.2 分支没有；2.0.2 的发布前审计就是上面这条工作流。
- 剩余全部由作者执行（AGENTS 规则 7）：合并 PR #2 → 在 main 上打 `v2.0.2` tag（tag 推送会再跑一次同一工作流）→ `npm publish` → GitHub Release。

## 2026-11-08 · ADR-0004：受管 MCP 条目与指令段落原地更新

- 起因：PR #11 留下的待办"alpha.1 装过的 MCP 条目在规格加 `env` 后没有原地更新路径"。复现时发现同类缺口更大：指令段落在宿主文件已受管后完全不再更新——改正文、或给同一个 `CLAUDE.md` 加第二条指令，`plan` 都给出空操作，也不报冲突（`canRenderInstruction` 只认 `absent`）。
- 决定（ADR-0004）：三类受管内容统一按 skill 的规则——文件字节与 sidecar 一致、渲染结果不同就原地更新；被手改仍冲突、不覆盖。这推翻了 M2 时"规格一变就冲突"的保守设计，所以写了 ADR。
- 实现：`observe` 对受管 MCP 文件给 `current`（不再伪装成 `managed-modified`），对受管指令文件读出各段正文 `segments`；`plan` 新增 `replace-mcp`，`upsert-segment` 只为正文不同或缺失的段落产出，两者都带 `priorHash`；`apply` 写入前对所有带 `priorHash` 的操作核对 hash（原来 skill 的 `replace` 带了 hash 但没核对），不符以 `TOOLKIT_CONFLICT` 停止；宿主适配器新增 `replaceMcp`：JSON 宿主整份重写（与合并时一致），Codex `config.toml` 只按文本替换 `[mcp_servers.<id>]` 表及子表，替换后重新解析，若除该条目外有任何差异或表头无法唯一定位就拒绝；conformance 对四宿主检查替换只动该条目、缺失条目算冲突；`segment-file` 新增 `readSegments`。
- 测试：先写 5 条 CLI 集成测试，修复前 4 红 1 绿（绿的是"手改指令文件仍拒绝"，作防回归护栏）：MCP 原地替换并可 rollback、Codex 用户设置与注释逐字节保留、给 alpha.1 式无 env 条目补 env、指令正文更新并新增第二条。原测试"reports drift when a managed mcp command no longer matches the spec"锁的正是被推翻的旧设计，改为原地替换测试；手改仍冲突由"does not restore an mcp server deleted from a hand-edited managed file"与新增的指令手改测试覆盖。另加单元测试：planner 两条、apply 的 prior-hash 一条（对改前 `apply.ts` 跑出红灯）、`readSegments` 两条、`replaceTomlMcp` 七条（含子表、尾随注释、内联表、多行字符串里的同名表头、非法 TOML）。`plan.test.ts` 的「section 3.3」用例标题改为「README example spec」（P7 待办）。
- 文档：CHANGELOG rc.1 新增一条（标为相对 alpha.1 的破坏性变化）并改写 env 迁移说明；README apply 行与 ADR 列表；`docs/hosts/codex.md` 说明替换只改该表。
- evaluator 第一轮 NEEDS_WORK（1 HIGH、2 MEDIUM、4 LOW），全部修复，每条先写红灯测试：
  - HIGH：同一文件上的多个更新操作共用计划时的 `priorHash`，第一条写完后第二条被自己误判为冲突、apply 写一半。改为同一次 apply 写过该文件后，下一个操作核对本次刚写出的 hash。补"同一 `config.toml` 两个 server 同时变化""同一 `CLAUDE.md` 两段同时变化"两条集成测试（修复前均红）。
  - 修 HIGH 时暴露一个**早已存在的数据丢失缺陷**：`rollback` 对同一次 apply 里被写两次的文件，撤销后一次时写回的 sidecar 不带 `previous`，撤销前一次时就把文件当成新建的整份删除——一次 apply 往用户自己的 `config.toml` / `~/.claude.json` 合并两个 MCP server，`rollback --last` 会删掉整个文件。只用 develop 上已有的 `merge-mcp` 就能复现（单元测试修复前红）。改为每一步按账本事件自己的 `beforeHash` 找内容寻址备份恢复。
  - MEDIUM：段落正文里引用了别的标记（例如文档里写 `<!-- stinky-cobbler:begin example -->`）会让之后的 observe 抛 `SEGMENT_INVALID`，plan/doctor/list 全部失败。写入时拒绝含任何段落标记的正文；读取只认顶层、配对完整的段，嵌套或不配对的不算段（真要写那个 id 时 `upsertSegment` 仍失败关闭）。
  - MEDIUM：`toolkit list --json` 会带出内部字段 `segments`、`current`。`listToolkit` 去掉这两个字段，保持 alpha.1 的输出形状，并加断言锁定键集合。
  - evaluator 第二轮 PASS，另提 4 条 LOW。L1 已修：`locateSegment` 原来取文件里第一个 begin 标记，不区分是否引用在别的段正文里，改前写入的文件若有这种引用，upsert 会从引用处替换到真正的 end、破坏外层段；现在读、写、删共用同一套顶层扫描（补测试，修复前红）。
  - LOW：段 id 为 `constructor` 等原型链名时永远不收敛，改用 `Object.hasOwn`；补 skill `replace` 的 prior-hash 测试；CHANGELOG 写明中途停止时退出码是 6、`TOOLKIT_CONFLICT` 在报告里；`docs/hosts/codex.md` 注明 CRLF 文件里被替换的表用 LF。

- 验证（rebase 到含 PR #12 的 develop 之前，在本分支实跑）：build 0；lint 0 error（84 条 warning 与改动前相同）；`npm test` 101 文件 / 944 项通过；`npm run test:package` 通过；`npm run coverage` 无阈值报错（io 行 89.3%、hosts 92.7%）；`git diff --check` 干净。evaluator 两轮，第二轮 PASS。

### 待办 / 问题
- 含段落标记的指令正文到 `apply` 才在 `upsertSegment` 里被拒（退出 6，前面的操作已写入，要 rollback）；更友好的是在 `plan` / `lock` 阶段就拒绝。
- `apply` 读一次文件得到账本 `beforeHash`，`installManagedBytes` 再读一次命名备份；两次读之间文件被改，账本与备份对不上，rollback 抛 ENOENT（毫秒级窗口）。同理，同一文件的第一个操作若是 `merge-mcp`（不带 `priorHash`），计划到写入之间的变化没人核对。
- 原本 foreign 的用户文件在 rollback 后仍留着受管 sidecar，之后被当成 managed（旧行为，改前一样）。

## 2026-11-08 · P7 作者决定项：测试修正、删除 3 个无读者示例、PRD 口径

- 作者 2026-11-08 授权"按推荐直接进行"，P7 待办里的三组决定按推荐执行：
  1. **删除**（STANDARDS §7.3）：`resources/gate/examples/{content-calendar,research-report,student-management-system}/task.json`。删前 `git grep` 确认 src/test/CI/package.json 无读者，只剩 `docs/archive/` 的历史散文；`frameflow/task.json` 有 `test/gate/dogfood.test.ts` 读取，保留。README 目录树只列到 `examples/`，无需改。
  2. **测试修正**（grok 写模式执行，主指挥逐条核 diff）：`registry.test.ts` 与 `orchestration.test.ts`、`specialists.test.ts` 的中文标题探测改为结构断言（标题取自产品实际加载的 specialist，并断言指令首行包含它，比原来的字面量更强）；`git-read.test.ts` 的 `gitAvailable` 改为同步 `spawnSync` 探测（原来没 await，`skipIf` 恒不生效）；`read-scope.test.ts` 里断言 `isSensitivePath` 的 7 个 expect 原样移到新文件 `test/gate/policy/path-policy.test.ts`（原 10 = 留 3 + 移 7）；`runtime-contracts.test.ts` 夹具路径改为 `src/gate/contracts/types.ts`。`test/core/plan/plan.test.ts` 的「section 3.3」标题随 ADR-0004 那个 PR 改。
  3. **PRD 口径**：按代码改 PRD。§4 指令目标如实写成"只渲染到 Claude Code 的 `CLAUDE.md`"，配置写成"每条命令只读一份 `toolkit.yaml`"；两处缺口移到 PLAN 新增的 M5（M5-T1 其余三宿主的指令渲染，M5-T2 按 id 分层合并），M2 下加一行更正说明。
- 未做：`test/gate/dogfood.test.ts:28-31` 仍只验证自己写的 README——`src/gate` 里没有准备或校验 dogfood 工作区的函数（grok 列了 6 条 grep 证据），没有产品函数可调就不改、不删。`test/gate/mcp/git-read.test.ts:50-55` 回读夹具设置的 git config，它守的是夹具本身（测试泄漏事故后加的），保留。
- 验证（沙箱外实跑）：build 0、lint 0；`npm test` 101 文件 / 922 项通过；`npm run test:package` 407 项（410 减去删掉的 3 个）；`git diff --check` 干净；改动的 7 个测试文件单独跑 120 项通过。

## 2026-11-07 · 3.x 行为缺陷修复（P7 审计待办中的 7 条）

- 分支 `feature/rc1-defect-fixes`，从 `feature/p7-audit` 切出（PR #10 在本分支推送时已合并进 develop，本分支相对 develop 正好是下列 8 个提交）；7 个提交各修一个缺陷，每个都先写复现测试（用修复前的 `dist/` 或改前代码确认红灯）再修，不改 `src/gate/`：
  1. `19fdd6c` `toolkit rollback` 有 `conflict` 退出 7、`toolkit apply` `stopped: true` 退出 6（`ExitCode.INTERNAL`，固定码，JSON 不变；op 自己的退出码没有透传，见待办）。
  2. `28be634` `entry install-host` 冲突退出 7：`release/2.0.2` 的代码与测试早已是 7，3.x 分支漏了这项；两条锁定 1 的测试改为 7，CHANGELOG rc.1 标为相对 alpha.1 的破坏性变化。
  3. `def575b` Cursor `.cursor/rules` 不再当段落文件：`host-adapter.ts` 新增 `rendersInstructionSegment` / `instructionSkipReason`，observe、plan 的 support 行、`toolkit memory` 共用；非 `md-segment` 目标进 `plan.skipped` 并带原因。
  4. `06d94dd` plan 与 apply 统一来源：有 lock 时都读 blob（本地源也是），无 lock 时 plan 预览实时文件、apply 仍 `TOOLKIT_LOCK_REQUIRED`；删除 `overlayLockedSources`。
  5. `717d364` MCP `env` 按宿主文档语法写入（Cursor `${env:NAME}`、Claude Code `${NAME}`、Codex `env_vars`、ZCode 不写），不读不展开值；`hosts/host-adapter.ts` 的重复 `McpServerSpec` 改为宿主文件形态 `HostMcpEntry`，规格类型只剩 `core/toolkit/spec.ts` 一处；readMcp 同步读回 env，env 变化算冲突/漂移；conformance 增加 env 往返检查。Codex `env_vars` 语义当天按官方页核对（`env_vars`: "Environment variables to allow and forward"）。
  6. `c3d2ce1` plan 不再生成 `remove` op，改为 `plan.orphans` 与 `doctor.orphans` 报告；apply 不再因它中断；`FileOp.action` 去掉 `remove`。
  7. `771d7ef` `lock.ts` 的种类枚举改为 `kinds.ts` 的 `LOCKED_KINDS`（C4）。
- 文档：CHANGELOG 3.0.0-rc.1 五条用户可见变化；STANDARDS C4/C7/C13 状态同步；`docs/hosts/*.md` 各补一句 apply 写什么；quickstart 与 README 的 plan/lock、orphans 说明。
- 验证：lint（typecheck、test types、ESLint 0 error、depcruise 0 violation）通过；`npm test` 100 文件 / 920 项通过（unit + integration）；`npm run test:package` 真实打包安装后冒烟通过（`stinky-cobbler-3.0.0-rc.1.tgz`）；`git diff --check` 干净。每条缺陷的复现测试都先在修复前跑出红灯（1、2、6 用修复前的 `dist/` 或改前代码复现）。

### 待办 / 问题
- `orphans` 只覆盖"规格仍引用、但 `hosts` 收窄后多出的受管副本"。整条从 `toolkit.yaml` 删掉的 artifact 不会被 observe 看到（observe 只按规格条目定位路径），plan/doctor 报不出来；要覆盖它需要扫描宿主目录或在 lock/账本里记安装清单，设计由作者定。真正的删除（经 managed-file、可回滚）同样待设计。
- `${file:PATH}` 引用四个宿主都没有文档语法，apply 不写、doctor 也不提示；建议 doctor 加一条提示。
- Codex 只能按名转发：`KEY: ${env:NAME}` 且 KEY≠NAME 时服务进程拿到的变量名是 NAME；doctor 的 wrapper 提示仍是正确做法。Claude Code 的 `${VAR}` 只在 `.mcp.json` 文档里核实过，用户级 `~/.claude.json` 按同一语法写。
- apply 中途停止固定退出 6；若作者希望透传 op 自身的退出码（例如 managed-file 的 3），需要在 JSON 报告里加 `exitCode` 字段。

## 2026-11-07 · ADR-0003 P7：全量审计与收尾

- 审计：8 个只读 grok 分片覆盖全部 357 个跟踪文件（按 `git ls-files` 逐项对账，357/357，零遗漏），每个文件一条 KEEP/FIX/DELETE/ARCHIVE/MOVE_OUTPUT 判定加理由。结果：KEEP 323、FIX 31、DELETE 3、ARCHIVE 0、MOVE_OUTPUT 0。
- 本批只做文案/配置类 FIX（不改行为、不改断言）：README（源码/测试清单、gate 引用规则、2.0.2 状态、根文件表、按 `git ls-files` 重生成目录树）、SECURITY（四宿主验收口径）、AGENTS（冻结规则与 §0.5 一致）、ADR-0002 修订注、两份 2.x 配置指南的内置层路径、迁移说明补 src/ 与 test/ 对照表、feature_request 模板措辞、CHANGELOG 3.0.0-rc.1 补 P3/P5/P6；dependabot 加 `target-branch: develop`；release-candidate 去掉重复的 `test:integration`（重复的 `npm audit` 步骤被 `test/scripts/release-contract.test.ts:80` 锁定，保留）；package-smoke 深层 import 探针指向 `dist/gate/storage/tasks.js`；build-offline-bundle 用法文本改为当前版本；`src/gate/entry/preflight.ts` 一句提示不再让 Claude Code/Cursor 用户跑 `entry install-host`（冻结区允许的"误导用户"修复，行数 16873 不变）；5 个无读者导出改为模块私有；`zod` 补进 dependencies（src 直接 import，此前只是 SDK 的间接依赖）。
- 执行：grok 读模式 8 片 + 写模式 1 轮；evaluator PASS（14 项逐条对照 diff，README 树三级对账，去 export 的符号逐个 grep 无引用）。验证：build/lint 0；`npm test` 99 文件 / 904 项；`test:package` 410 项；`git diff --check` 干净。
- ADR-0003 的 P1–P7 至此全部完成；STANDARDS 的状态表已随 P6/P7 更新。
- CI 修正：P6 把 `npm run coverage` 放进六个矩阵格后，Windows/Node 24 格子的 `test/gate/storage/writes.test.ts` 硬链接用例在 v8 插桩下跑到 30.8 秒超时（该用例在 Windows 本来就慢，PR #2 也超时过一次）。改为只在 ubuntu / Node 22 格子跑覆盖率门禁（阈值与平台无关，也不再让其余格子重复跑 unit 套件）；T6 文案同步。

### 待办 / 问题（P7 全量审计，需作者决定；每条附审计给出的证据）

**DELETE 候选（STANDARDS §7.3：删除先给作者确认）**
- `resources/gate/examples/content-calendar/task.json`、`research-report/task.json`、`student-management-system/task.json`：`git grep` 显示无任何 src/test/CI/package.json 读者，只有 `docs/archive/domain-model-and-extensions.md` 的散文提及；`frameflow/task.json` 有 `test/gate/dogfood.test.ts` 读取，保留。README 目录表写着"四个 2.x task 样例"，删了要同步改成一个。

**改测试断言（规则 ⛔ 不为通过而改断言，所以不代做；审计认为它们违反 T7 或测错了对象）**
- `test/gate/config/registry.test.ts:14` 锁定 `role-extensions.yaml` 里的 displayName「研究员」（T7 文案探测）。
- `test/gate/storage/orchestration.test.ts:1421/1437/1452`、`test/gate/storage/specialists.test.ts:40` 锁定 `specialists.yaml` 的标题文案（T7）。
- `test/gate/mcp/git-read.test.ts:15-22` 没有 `await` `git --version`，`gitAvailable` 恒为 true，`skipIf` 失效；`:50-55` 只回读自己刚设置的 `maintenance.auto`/`gc.auto`。
- `test/gate/mcp/read-scope.test.ts:14-39` 在 mcp 测试里断言 `policy/path-policy.ts` 的 `isSensitivePath`（T1 位置不对，应移到 `test/gate/policy/`）。
- `test/gate/dogfood.test.ts:28-31` 只验证自己写的 README 能读回来，没有调用产品。
- `test/gate/contracts/runtime-contracts.test.ts:37` 夹具 `locator` 还是旧路径 `src/contracts/types.ts`（只是字符串，不影响通过）。
- `test/core/plan/plan.test.ts:57` 用例标题引用已归档评审的「section 3.3」。

**3.x 产品缺陷（行为改动，需先写复现测试再修，建议单独任务）**
- `src/app/toolkit-commands.ts:69-73`：`rollback` 有 `conflict`、`apply` 有 `stopped` 时退出码仍为 0（C7）。`src/app/register-commands.ts:178`：`entry install-host` 冲突退出 1，不在 ExitCode 表（C7）。
- `src/app/observe.ts:41-46`：Cursor 的 `.cursor/rules` 是目录；存在时 `managed-file.ts:45` 抛错，不存在时 `plan.ts:130` 当文件写——非 md-segment 格式应跳过并标 unsupported。
- `src/app/toolkit-flow.ts:54-63`：`plan` 用 `overlayLockedSources` 保留本地实时内容，`apply` 只用 `sourcesFromLock`，plan 可能显示 apply 不会写的改动；应统一来源策略。
- `src/app/apply.ts:81`：只复制 MCP 的 `command`/`args`，`env` 引用没写进任何宿主文件；`hosts/host-adapter.ts:21` 与 `core/toolkit/spec.ts:19` 两个 `McpServerSpec` 类型不一致。
- `src/app/apply.ts:55` 对 `action: "remove"` 抛 `TOOLKIT_OP_UNSUPPORTED`，而 `plan.ts` 的 `removeUnwanted` 仍会生成该 op，首个删除就中断整批。
- `src/core/toolkit/lock.ts:9` 字面量 `["skill","instructions"]` 重复 `ARTIFACT_KINDS` 子集（C4）；`ARTIFACT_KINDS` 含 `command` 但 toolkit 规格里没有 command 条目。
- `skills.sh:` 来源：`searchToolkit` 恒抛 `TOOLKIT_SEARCH_UNVERIFIED`，没有 fetcher 存储字节。

**PRD 与代码的口径差（改 PRD 还是改代码由作者定）**
- `docs/PRD.md:24` 说指令目标含 AGENTS.md 与 ZCode skill 段；适配器只写 Claude 的 CLAUDE.md 与 Cursor 项目规则。
- `docs/PRD.md:28` 要求 builtin → user → project 按 id 合并；`toolkit` 只读一份 `toolkit.yaml`，PLAN M2 却已勾选（PROGRESS 早有记录）。

**2.x 冻结区内发现（按 §0.5 不改，只记录）**
- `src/gate/storage/specialists.ts:41-44` 在存储层拼中文前缀（§2 ⬜）；`orchestration-fence.ts:62/67/69`、`runtime-diagnostics.ts:198/218` 裸 `new Error`（C6 豁免）；`orchestration.ts:1912` 仍写「2.0.1 safety profile」；`leases.ts`/`orchestration.ts`/`write-intents.ts` 各自定义 PACKAGE_ROOT；`docs-index.ts` 与 `leases.ts` 重复字符串 `.stinky-cobbler/docs-index.json`；若干 `*ForTesting` 导出无调用方。
- `scripts/package-smoke.mjs:53-60,368-372` 复制了 `release-utils.mjs` 的 `execPortableSync`/`isDirectInvocation` 而不是 import；`scripts/generate-sbom.mjs:82,85` 的 serialNumber/timestamp 不可重现（归档评审 D-42）。
- `src/io/tiered-config.ts` 多处 message/fix 只有中文，`cli.ts` 无 zh/en 选择（§2 ⬜）。


## 2026-11-07 · ADR-0003 P6：结构守卫、链接/垃圾检查、audit:release、覆盖率地板

- 新增 4 个检查器（`scripts/repo-structure.mjs`、`check-docs-links.mjs`、`repo-junk.mjs`、`audit-release.mjs`），各有合成失败用例（`test/scripts/*.test.ts`，33 例，断言具体问题字符串）和真实仓库用例（`test/repo/{structure,docs-links,junk}.test.ts` 断言 []）。结构守卫直接读 STANDARDS §1.2 的 yaml 块；命名例外（根目录点文件、10 个约定大写文件、`.github/`、宿主要求的 `SKILL.md`）写进 §2。
- `npm run audit:release`：仓库守卫、全仓密钥样式/本机路径扫描（只报路径与模式名）、`npm audit` 全量与仅运行时依赖、工作区干净（无未忽略文件、无空目录）；release-candidate 工作流接入。
- 规则升级：dependency-cruiser `app-has-no-fs`（现有 10 处基线只减不增，基线 15→25）；ESLint 拦 3.x 代码里任何 `new Error(...)`；vitest 覆盖率阈值 core 90 / io 85 / hosts 85（行），CI 加 `npm run coverage`。宿主适配器的打包模板路径改走 `gateResourceRelative()`。STANDARDS 相应状态升为 ✅/🟡 并点名强制文件。
- 执行：grok 1 轮到 80 turn 上限中断（最后在修 dependency-cruiser 对 `fs/promises` 的匹配，已完成），Claude 撤回它为 worktree 符号链接而改的 `.gitignore`。evaluator 第一轮 NEEDS_WORK（TODO 正则漏 markdown 列表项、C11 未披露豁免、T1 过期、缺失败用例），修后 PASS。reviewer（代码审查）：0 CRITICAL/HIGH、5 MEDIUM、10 LOW；已修 4 个 MEDIUM——`".codex")` 闭括号写法漏报、资源段字面量只在 `join(`/`resolve(` 行内才算（避免误伤枚举）、链接检查支持根相对路径/HTML 注释/缩进围栏/短 setext 下划线、`audit:release` 的 repo guards 限定 `--project unit`（不再隐式 build）。验证：lint 0；`npm test` 99 文件 / 904 项；`npm run coverage` 阈值通过；`test:package` 410 项；`audit:release` 本机除两步 `npm audit`（镜像问题）外全 PASS。

### 待办 / 问题（P6 审查遗留，均不影响当前仓库通过）
- 链接检查（LOW）：标题含链接或多空格时 slug 与 GitHub 不一致；重复标题撞上已有 `-1` 后缀；徽章嵌套链接只查内层；引用式链接 `[text][ref]` 不查；macOS/Windows 文件名大小写不敏感（Linux CI 兜底）。
- 结构守卫（LOW）：`checkIgnored` 只认 `name`、`name/`、`/name/` 三种写法；非根目录点文件（如 `.gitkeep`）一律不合规。
- 垃圾检查（LOW）：console 检查对注释和字符串也生效；行尾 `# TODO`、小写 `todo` 不拦。
- audit:release（LOW）：空目录检查会报被 gitignore 的本地空目录；`readdir` 权限错误会让审计崩溃；`.env.example` 会被当密钥文件；`npm audit` 的网络/ENOAUDIT 错误与真实漏洞同为非零退出，CI 上可能偶发红。
- CI 成本：每个矩阵格 unit 套件跑两遍（`npm test` + `npm run coverage`）。
- 已知：本机 npm 镜像不提供安全通告接口，`audit:release` 的两步 `npm audit` 在本机报 FAIL（`[NOT_IMPLEMENTED] /-/npm/v1/security/*`）；CI 的 registry 正常。C14 的「无引用文件」与「注释掉的代码」仍 ⬜。

## 2026-11-07 · ADR-0003 P5：src/config、contracts、entry、security 并入 src/gate

- 14 个文件（2828 个非空行）搬进 `src/gate/{config,contracts,entry,security}`，git 识别为 rename。搬动文件与 44 个既有 gate 文件只改 import/export 说明符；唯一非说明符改动是 `src/gate/entry/install-host.ts` 的包根表达式多爬一层（`../../..`），否则打包模板路径失效，`test:package` 真实安装验证过。`src/app/register-commands.ts`、`src/mcp-server.ts`、52 个测试文件跟着改路径。
- 守卫同步：`test/repo/gate-frozen.test.ts` 清单 62 个文件、基线 16873（实测；= 旧 14045 + 14 个文件原有的 2828，用测试同一算法独立核过）；ESLint FROZEN_KERNEL 收口为 `src/gate/**` + `cli.ts`、`mcp-server.ts`；dependency-cruiser 的 gate 豁免只剩 `cli.ts`、`mcp-server.ts`、`src/app`，15 条已知违规基线不变。
- 文档：STANDARDS §1.1 的 gate 清单补 `security`，C1/C2/C3/C6/C9 与 §3.1 ESLint 行按收口后的范围改写；安全审查清单三处路径。
- 执行：grok 1 轮（29 turns），evaluator 复核 PASS（14 R + 103 M 对账、536 条相对说明符全部解析、基线算术独立复算）。验证：build/lint 0；`npm test` 92 文件 / 862 项；`test:package` 410 项；`git diff --check` 干净。

## 2026-11-07 · ADR-0003 P4：resources/ 与资源路径模块

- 根目录 9 个数据目录（schemas、policies、profiles、packs、plugins、examples、templates、.codex、.zcode，66 个文件）迁入 `resources/`：`resources/toolkit/toolkit.schema.json` 是 3.x；其余进 `resources/gate/`，宿主 skill/command 模板与渲染产物放 `resources/gate/skills/`。git 全部识别为 100% 相似的 rename。
- 新增 `src/io/resources.ts`（`PACKAGE_ROOT`、`gateResource`、`toolkitResource`）作为资源路径唯一来源；`config/registry.ts`、`config/tiered.ts`、`contracts/schema-registry.ts`、`contracts/default-schema-registry.ts`、`hosts/{codex,zcode}.ts` 改走它。`src/gate` 零改动，冻结基线不变。
- `package.json` files 改为发布 `resources/`；package-smoke 的必需路径、render-skills 的读写位置同步；6 个测试只改路径。README 目录树与目录表、CHANGELOG 3.0.0-rc.1、迁移说明新表、STANDARDS C11、安全审查清单一处路径更新。
- 执行：grok 1 轮（44 turns）；全量测试暴露 8 个失败——`test/gate/entry/` 三个测试仍按旧路径读打包模板（brief 让 worker 自行判断 `.codex/` 命中，它误判为宿主侧路径），由 Claude 改为 `gateResource(...)` 并让 `config-liveness` 也走中心模块；evaluator 复核 PASS（66 个 R100 对账、路径语义、打包清单、文档）。验证：lint 0；`npm test` 92 文件 / 862 项；`test:package` 410 项（真实 tarball 装进 fake HOME 跑 `entry install-host`）；`render-skills --check` 0；`src/gate` 零改动。
- 遗留（不改行为）：`src/config/tiered.ts` 的错误标签字符串仍写 `policies/orchestration.yaml (内置)` 等，是展示标签不是路径；包内实际位置已是 `resources/gate/policies/`，是否改标签由作者定（属 2.x 行为）。

## 2026-11-07 · ADR-0003 P3：test/ 镜像 src/

- 79 个根目录文件按引用的 src 模块归位（git 全部识别为 rename）：2.x 测试进 `test/gate/{storage 39, runtime 4, mcp 6, policy 2, config 5, contracts 3, entry 3}`，跨模块的 2.x 端到端测试（dogfood、e2e-user-path）放 `test/gate/` 根；3.x CLI 测试进 `test/app/`；仓库级守卫（gate-frozen、config-liveness 两个、typecheck-baseline.json）进 `test/repo/`；脚本测试进 `test/scripts/`；两个辅助文件进 `test/helpers/`。`src/config`、`contracts`、`entry` 的测试直接放到 `test/gate/` 下，P5 搬源码时不用再搬测试。
- 搬动文件里只改了 import 层数、`projectRoot` 表达式、crash-matrix 与 durability-order 的动态 import、workspace-lock 的子进程路径；断言未动。机械检查器把每个文件与 develop 版本归一化后比对：零其他差异，所有相对 import 可解析，`projectRoot` 都指回仓库根。
- 引用更新：`scripts/check-test-types.mjs`、README、PRD、STANDARDS（C3/C5/D2 路径，§2 测试行与 T1 去掉「P3 迁移」）、ADR-0002、`docs/hosts/codex.md`、安全审查清单。CHANGELOG 已发布段、docs/archive、本文件旧条目保留历史路径。
- 执行：grok 1 轮（22 turns），evaluator 复核 PASS（逐行读完 79 个 diff，471 条相对 import 全部可解析）。。验证：build/lint 0；`npm test` 92 文件 / 862 项通过（与 develop 相同，没丢测试）；`test:package` 404 项；`git diff --check` 干净。

## 2026-11-06 · ADR-0003 P1–P2：项目规范与 docs/ 重组

- P1（PR #4，已合并 develop）：ADR-0003、`docs/STANDARDS.md`、根目录 `AGENTS.md`。作者决定：文件名用英文 kebab-case；2.x 封存进 gate 目录，不删；总规则写在 STANDARDS，由 AGENTS.md 指向；按 P1–P7 分批迁移，每批一个 PR，六项 CI 通过后合并。P1 合并时没有记 PROGRESS，在本条补记。
- P2：docs/ 下 21 个文件改名迁移，git 全部识别为 rename。ADR 合到 `docs/adr/`；2.x 手册与威胁模型进 `docs/gate/`；两份发布清单进 `docs/release/`；toolkit 快速开始进 `docs/guides/`；兼容政策与支持矩阵放在 docs 根目录；架构评审与历史设计文档进 `docs/archive/`，正文不改，只修链接目标。同步更新了 README、CONTRIBUTING、CHANGELOG（只动未发布的 3.0.0-rc.1 段）、迁移说明（新增「文档路径变更（3.0）」对照表）、GitHub 模板、脚本与测试里的文档路径、`src/config/scaffold.ts` 里的路径字符串，以及代码注释里的旧规则编号。离线包内的 `使用说明书.md` 文件名保留不变。ADR-0003 状态改为 Accepted。
- 架构评审 §2.5 的 25 条已逐条并入 STANDARDS §2–§7（第 24 条进 §2，第 17 条进 §2 与 §6，第 21 条进 §7）。第 1 条的「硬上限 800」未采用：ESLint `max-lines` 直接以 400 为硬上限。
- 规则状态核实：迁移本身先做了 45 个代理的多视角审查，grok 返工两轮，evaluator 两次 NEEDS_WORK 后 PASS。随后用 52 个代理逐条核对 STANDARDS 的 ✅/🟡/⬜（每条质疑都有反方攻击）：49 条质疑中 41 条成立；修改后再由 evaluator 复核，补改了 10 处。以 develop（`06f3bde`）的 STANDARDS 为基线，结果是：18 处状态改变——降级 16 处（§1.4 新增目录 ✅→⬜、§1.4 output/ ✅→🟡、文件目录命名 🟡→⬜、约定大写文件 ✅→⬜、测试命名 🟡→⬜、分支命名 ✅→🟡、C1/C2/C3/C5/C13 ✅→🟡、C10/C12 🟡→⬜、T1 🟡→⬜、§6 分支模型 ✅→🟡、§6 打 tag ✅→⬜），升级 2 处（C9 ⬜→🟡、D2 ⬜→🟡）；状态不变但写明工具真实覆盖范围 5 处（C4、C6、C7、C8、D6）；新增带状态的条目 18 处（§2 版本片段、§3.1 工具链 8 行含 Dependabot ⬜ 与 `npm audit` ✅、T8、T9、§6 两条、§7 五项首次标注）。§7.4、§7.5 与两份发布清单对齐；「结构守卫读取 §1.2」改为 P6 起才读取。

### 待办 / 问题（核实规则状态时发现，需作者决定）
- `toolkit rollback` 遇冲突仍退出 0，违反 C7「conflict 类结果非零退出」。已实跑复现：临时 HOME 里 `apply --yes` 后改动受管的 SKILL.md，再 `rollback --last --json`，退出码 0，stdout 带 `conflict`，`restored` 为空，用户改动未被覆盖。原因是 `src/app/toolkit-commands.ts` 的 `bind` 只打印结果，不设退出码；`src/app/rollback.ts` 冲突时 return 而不 throw。建议先写失败测试再修。
- `entry install-host` 遇冲突退出 1，这个值不在错误码表里（CONFLICT 是 7）。退出码在 `src/app/register-commands.ts:178` 设置，`test/entry.integration.test.ts:139` 与 `test/cli-presenter.integration.test.ts:55` 锁定了现行为；改成 7 会改变 2.x 命令的对外退出码，改不改由作者定。
- `entry preflight --via <无效值>` 退出 2，但输出里没有 `error` 字段，只有 `decision: "invalid-via"`（C7「非零退出码对应错误码」的第三个偏差）：`src/app/register-commands.ts:177` 直接设 `ExitCode.VALIDATION`，不经 `StinkyCobblerError`；`test/entry.integration.test.ts:72-84` 锁定现行为。与 install-host 同属 2.x `entry` 命令，改不改由作者定。
- `src/` 有 5 个文件直接 import `zod`，但 `package.json` 没有声明它，靠 `@modelcontextprotocol/sdk` 间接安装。补声明属于依赖变更，需作者批准。
- C9、C10 与现状不符：9 个 `app/` 文件直接 import fs，其中 5 个直接写盘（缓存、`toolkit.lock`、scaffold、rollback 删除）。二选一：把这些读写迁到 `io/`，或者收窄规则。
- Dependabot：配置不在默认分支 `main`，至今没有运行过；配置里没写 `target-branch`，PR #2 合并后它会向 `main` 开 PR，与分支模型不符；仓库级漏洞告警也没有开。改 CI 配置和仓库设置需作者批准。
- C4 现状偏差：`src/core/toolkit/lock.ts:9` 用字面量 `["skill", "instructions"]` 重复了 `kinds.ts` 里 artifact 种类的子集，规则要求从 `kinds.ts` 派生。
- C5 的 config-liveness 对 3.x 不起作用：toolkit schema 的键都写在 zod 定义里，文本匹配必然命中。P6 可以改成按读取点检查。
- 全局规则 `ai-tools-config/rules/dev-workflow.md` 写的 ADR 目录是 `docs/decisions/`，与 STANDARDS 的 `docs/adr/` 冲突。改配置仓库需作者确认。

## 2026-11-06 · 远端分支规范化（main / develop / release / hotfix / feature）

- 分支模型（作者决定，见 CONTRIBUTING「分支模型」）：`main` 只放已发布代码、默认分支；`develop` 集成下一版本；`release/<version>`、`hotfix/<version>` 经 PR 进 `main` 后回合并 `develop`；`feature/<name>` 经 PR 进 `develop`。
- 远端：从 `codex/stinky-cobbler-3.0-m0`（`6061010`）建 `develop`；`codex/stinky-cobbler-2.0.2-hardening` 用 GitHub 改名为 `release/2.0.2`。改名把以它为 head 的 PR #1 自动关闭（GitHub 只为以它为 base 的 PR 改目标），已开 PR #2 替代，内容不变。删除 `codex/stinky-cobbler-3.0-m0`（与 develop 同一提交）和 `codex/stinky-cobbler-2.0.1-hardening`（已包含于 `main` 与 `v2.0.1`）。远端现为 `main`、`develop`、`release/2.0.2`。
- 代码：release-gate 接受 `main`、`v<version>`、`release/<version>`、`hotfix/<version>`；旧 `codex/stinky-cobbler-<version>-hardening` 只为复核 2.0.1/2.0.2 历史 provenance 保留。CI push 触发改为 `main`、`develop`、`release/**`、`hotfix/**`。develop `12c29c4`、release/2.0.2 `16a75c3`。
- 保护：`main`、`develop` 必须 PR、六个 CI 矩阵任务通过、禁止 force push 与删除，不要求评审，管理员可绕过。
- 验证：develop 92 文件 / 862 项、release/2.0.2 72 文件 / 792 项本地通过；release-gate 对 `release/<当前版本>` 通过、对 `release/9.9.9` 拒绝。CI：develop push、release/2.0.2 push 六项全绿；PR #2 的 Windows Node 22 任务一次超时（该测试在 Windows 正常约 8.7 秒，此次 30.2 秒），重跑后六项全绿。
- 未做：PR #2 合并、tag `v2.0.2`、`npm publish`、GitHub Release；2.0.2 发布后把 `main` 回合并 `develop`；3.x 何时走 `release/3.0.0`。

## 2026-11-05 · 2.0.2 分支推送、测试泄漏事故与根因修复

- 事故：在 linked worktree 里 `git push` 2.0.2 分支时，husky pre-push 继承了绝对路径的 `GIT_DIR`，覆盖了 `test/git-read.test.ts` 夹具的 `git -C <dir>`。夹具的 `git init` / `config` / `commit` 写进了真实仓库：2.0.2 分支多出坏提交 `a364111`（作者 test，README 被换成一行），共享 `.git/config` 被写入 `user.name=test`、`user.email=test@example.com`、`core.bare=true`、`maintenance.auto=false`、`gc.auto=0`。坏提交随后被推到远端。
- 处置：`.git/config` 恢复（`core.bare=false`，删除四个泄漏键，身份回到全局 LJunP）；本地分支回到 `5951c5e`（工作区文件未动）；取消测坏提交的 CI；作者手动 `--force-with-lease` 把远端改回 `5951c5e`。核对过 `core.fsmonitor`、`filter.*`、`include.path` 等无残留；3.0 分支未受影响。
- 根因修复 `dd21ffc`：新 setup `test/setup/isolate-git.ts` 清除所有改写仓库位置的 `GIT_*` 变量，并把 `GIT_CONFIG_GLOBAL` / `GIT_CONFIG_SYSTEM` 指向空文件；回归测试 `test/setup/git-isolation.test.ts`。在丢弃克隆里设绝对 `GIT_DIR` 复现攻击：28/28 通过，克隆 HEAD 与 config 不变。
- 验证：2.0.2（`5951c5e`）六矩阵 CI 全绿（run 42003185978）。3.0 本地 92 文件 / 862 项通过。
- 未做：2.0.2 分支还没有这份隔离修复。PR、tag、`npm publish`、GitHub Release 未做。

### 待办 / 问题
- 2.0.2 分支是否补 `isolate-git` 修复再发布（建议补，避免发布前从 worktree 推送再次触发）。
- 2.0.2 → main 的 PR、tag `v2.0.2`、`npm publish`、GitHub Release 由作者执行。
- PRD §4 toolkit 配置分层合并未实现。

## 2026-11-05 · 首次推送与六矩阵 CI 转绿

- 推送 `codex/stinky-cobbler-3.0-m0`。首轮 CI（run 41986419348）六个 job 全红：Linux/macOS 卡在 `npm audit --audit-level=high`；Windows 在 `npm test` 有约 25 项失败。
- Windows 根因：`syncFile` 以只读打开再 fsync（`3343a43` 引入），Windows 的 FlushFileBuffers 需要可写句柄，报 `EPERM`；仓库没有 `.gitattributes`，Windows 签出 CRLF，`render-skills` 的槽位全部不匹配；`fs-boundary` 测试假定所有平台都 fsync 父目录。修复见 `3995703`、`f2d2c34`：win32 用 `r+` 并只在 flush 前后清除/恢复只读属性，POSIX 不变；渲染器容忍 CRLF，新增 `* text=auto eol=lf`；测试按平台分别断言。`src/gate` 行数基线未变。
- 依赖（作者批准，只修高危）：`788b6b9`，zod 4.4.3→4.6.7、body-parser 2.3.0→2.4.0、qs、hono、@hono/node-server、vite 8.3.0→8.3.6，均在原有范围内，package.json 未改。npm 10.9.8 的 `audit fix` 在 arborist 崩溃，改用 npm 11 只更新 lockfile。剩 13 个中危需主版本变更，未动。
- 验证：run 41996216735 六个 job 全部通过。本地 `npm ci`、build、lint、91 文件 / 859 项、test:package、高危 audit 通过。
- 2.0.2：`codex/stinky-cobbler-2.0.2-hardening` 本地补同样的 fsync 修复（`31cc753`）和 lockfile（`5951c5e`）；九步发布前验证全过（71 文件 / 787 项，integration 21 项，release-gate，高危 audit）。未推送。
- 未做：2.0.2 分支推送、PR、tag、`npm publish`、GitHub Release。

### 待办 / 问题（需作者决定）
- PRD §4 的 toolkit 配置按 `id` 分层合并未实现（PLAN M2 已勾）：实现或改 PRD。
- 2.0.2 分支是否推送跑 CI、开 PR 合并 main。
- 13 个中危（eslint / typescript-eslint 等）需要主版本升级。

## 2026-11-05 · 全库逐文件审计、清理与 README 重写

- 范围口径：PRD、ADR-0002、PLAN 对齐代码。Gemini CLI 移出 3.0。没有 `gate` 命令组，2.x 命令保持顶层、`[deprecated 2.x]`、冻结。M0-T7 改为从 `codex/stinky-cobbler-2.0.2-hardening`（切自 `bafbccf`）发布。
- 逐文件审计：343 项（337 个跟踪文件加本地目录）分六片只读审计，结果与 `git ls-files` 逐项对账，无遗漏。KEEP 295、FIX 36、ARCHIVE 7、GITIGNORE 5、DELETE 0（没有可举证删除的文件）。
- 修复：过时 2.x 文案、两个无人调用的段落写函数、`install-host` / `mcp-config` 示例补 `--host`、skill 模板与渲染产物写明 3.x、根文档与安全/架构文档改为 3.x 口径、GitHub 模板覆盖 toolkit 与四宿主。
- 结构：6 份历史文档移到 `docs/archive/`（内容未改）并建索引。新建 `output/`，只有 `output/README.md` 入库；本地 `.archify/`、`release-artifacts/` 与 3.x 交接提示词移入 `output/`（提示词含本机路径，不入库）。`.gitignore` 增加 `/output/*`、`.claude/`、构建临时目录；ESLint 忽略 `output/`。
- README 重写：定位、快速开始、命令一览、`toolkit.yaml`、宿主支持（区分官方文档核实与 2.0.1 安装器/测试）、安全模型、冻结 2.x、完整目录表、开发与发布。39 个相对链接全部有效。
- 2.0.2 候选（`codex/stinky-cobbler-2.0.2-hardening`，本地）：check:version、typecheck、build、71 文件 / 784 项、integration 21 项、test:package、release-gate 都通过；`npm audit --audit-level=high` 失败。
- 未做：推送前本条记录先提交。没有 tag，没有 `npm publish`。

### 待办 / 问题（需作者决定）
- `npm audit` 高危：运行时依赖 zod、body-parser（另有 3 个中危），2.0.2 和 3.x 都受影响。修复需要升级依赖。
- PRD §4 的"配置分层 builtin → user → project 按 id 合并"没有实现：`toolkit` 只读一份 `toolkit.yaml`，不合并，PLAN 的 M2 却已勾选。要么实现，要么改 PRD。
- PRD S5 的 package-smoke 扫描渲染产物仍未做。

## 2026-11-05 · 计划与方向审查后的两项修正

- 由 Claude 审查、grok worker 执行、Claude 独立验收（grok-conductor 调度）。
- `--help` 主描述改为 3.x 工具箱包管理器。16 个 2.x 治理顶层命令的描述加 `[deprecated 2.x]`。`entry`、`toolkit` 不标。命令名、选项、顺序、行为不变。README 与 toolkit 快速开始不再写不存在的 `gate` 命令组。新增 `test/cli-help.test.ts`。
- 新增 `test/gate-frozen.test.ts`：`src/gate` 冻结在 48 个文件、14045 行非空行（ADR-0002）。多一行即失败，已验证。PLAN 的 M2-T6 注明按官方文档核实，二进制实测并入 S1。
- 验证：`npm run build` 通过；`npm run lint` 通过（eslint 0 error / 42 warning，depcruise 123 modules / 731 dependencies）；`npm test` 91 文件 / 855 项通过。审查时有一次 e2e 在 60 秒超时，单独重跑 27.8 秒通过，判定为负载下的偶发超时。
- 未做：推送。没有 tag，没有 `npm publish`。

### 待办 / 问题（需作者决定）
- 分支 50+ 个提交从未推送，3.x 代码从未跑过 CI。PLAN 的"每任务一个 PR、≤ 400 行"没有执行。
- M0-T7 的"推送 → 合并 main"已不适用：2.0.2 候选在 `bafbccf`，之后叠了 3.x 提交，直接合并会发出 3.0.0-rc.1。建议从 `bafbccf` 切 `release/2.0.2` 发布，并在这条 2.x 维护线上修 D-04～D-07、D-12。
- 范围口径冲突：ADR-0002 写 Gemini CLI 放 M3，PRD 的 M3 没有；PRD §6 承诺的 `gate` 命令组在代码里不存在。需要改 PRD 或 ADR。
- PRD S5 要求 package-smoke 扫描渲染产物，未做（集成测试已断言渲染文件不含密钥）。

## 2026-11-04 · 用 3.0.0-rc.1 安装包再验一次

- `npm run test:package` 通过，包是 `stinky-cobbler-3.0.0-rc.1.tgz`。
- 两个临时前缀各跑四条命令：install、init、lock、`apply --yes`。两次 `completed` 都含 skill、mcp-server 和 instructions，`non-empty true`。
- 未做：推送。没有 tag，没有 `npm publish`。GA 仍被挡住。

## 2026-11-04 · 观察普通指令，手改的 MCP 不再被覆盖

- 有 `render` 且宿主路径已核实的指令都会被观察，不要求 `kind: memory`。`apply` 会把段落写进 `CLAUDE.md`。
- 受管 MCP 文件被手改后，即使 server id 不见了，状态仍是 `managed-modified`。`apply` 冲突退出，不把 server 写回去。
- 已受管 MCP 的 command 或 args 和规格不一致时，doctor 漂移包含该 server，`apply` 不改文件。
- `toolkit lock` 的快速开始改成：`git+` 和 `npm:` 在 lock 时抓取，`skills.sh:` 仍不抓取。
- 验证：先红（普通指令没有被安装，两处 MCP 漂移是空数组）。然后三条 CLI 测试通过。`npm run lint` 通过（eslint 0 error / 42 warning，depcruise 123 modules / 731 dependencies）。`npm test` 89 文件 / 851 项通过。
- 未做：推送。没有 tag，没有 `npm publish`。

## 2026-11-04 · 包版本改为 3.0.0-rc.1，GA 仍被挡住

- 安装包在两个临时前缀上各跑了四条命令：install、init、lock、apply --yes。两次 `completed` 都含 skill、mcp-server 和 instructions，`stopped` 都是 false。规格文件的编辑夹在 init 和 lock 之间，不算命令。
- 包版本改为 `3.0.0-rc.1`（package.json、package-lock.json、`src/version.ts`）。这不是 `3.0.0`。发布门禁现在接受带预发布号的版本，仍拒绝 `beta` 这类非版本字符串。
- 宿主探测仍是：`claude` 2.1.296 在 PATH 上，`codex`、`cursor`、`zcode` 不在。没有编造冒烟。没有 tag，没有 `npm publish`，没有推送。GA 发布被挡住。

## 2026-11-04 · 本地验证，GA 仍被挡住

- 两次空 HOME 启动：`plan` 不改 HOME，`apply --yes` 安装本地 skill、MCP 和 memory 指令，`doctor` 漂移为空，两次漂移一致。
- `npm run test:package` 通过。安装包后的四条命令（install、init、plan、apply）跑了两次，两次 `apply` 都是 `stopped: false`。
- `npm run lint` 通过（eslint 0 error / 42 warning，depcruise 123 modules / 731 dependencies）。`npm test` 89 文件 / 848 项通过。
- 宿主探测：`claude` 2.1.296 在 PATH 上。`codex`、`cursor`、`zcode` 不在。没有编造冒烟记录。包版本仍是 2.0.2。没有 tag，没有 `npm publish`，没有推送。

## 2026-11-04 · 打包冒烟补上必填的 --host

- `entry install-host` 从 M1 起 `--host` 必填。打包冒烟里安装 ZCode 的两次调用补上 `--host zcode`。Codex 的调用本来就有。
- 未做：推送。版本仍是 2.0.2。

## 2026-11-04 · 去掉宿主笔记里的本机路径

- `docs/hosts/claude-code.md` 不再写出本机 `claude` 的绝对路径。版本事实仍是 `2.1.296`。打包扫描会拒绝 `/Users/<name>/` 这种路径。
- 未做：推送。

## 2026-11-04 · 版本口径保持 2.0.2

- README、快速开始和迁移说明改成当前源码：lock、来源、bundle、失败关闭的 search、update、知识新鲜度、记忆段落。包版本仍是 `2.0.2`。
- 发布契约要求 `x.y.z`。`3.0.0-rc.1` 写不进 `package.json`。`3.0.0` 需要四个宿主的真实冒烟，目前没有。GA 发布被挡住。没有 tag，没有 `npm publish`。
- 未做：推送。没有改 TypeScript。

## 2026-11-04 · M4-T5 只写入已核实的 preset

- 2026-11-04 打开了 projectmem 的厂商 README。四项都在该页：名称 projectmem，README 宣布 v0.3.5，本地 stdio、无账号，记忆在仓库 `.projectmem/`，默认不联网。
- 写入 `docs/presets/projectmem.md`。`command` 必须是用户自己的 Python 绝对路径，所以这份 preset 不会被 `apply`。
- Cognee MCP 和 AgentKits Memory 没有写入。它们的数据流向没有在这次打开的页面里核实完。
- 未做：推送。版本仍是 2.0.2。没有改 TypeScript，所以没有为这次文档重跑全量测试。上一次全量是 M4-T4：89 文件 / 848 项通过。

## 2026-11-04 · M4-T4 memory show 与 edit

- `toolkit memory show <id> --host <host>` 只返回标记之间的原文。`edit --file` 先确认段落存在，再只替换这一段。缺段落时是 `SEGMENT_INVALID`，不会把新正文追加到文件末尾。
- 不读 `toolkit.yaml`，不检索，不解释正文。Codex、Cursor、ZCode 没有已核实的 md 段落路径，命令返回 `TOOLKIT_HOST_UNSUPPORTED`。`show` 不写 sidecar。
- 验证：先红（未知命令 `memory`）。然后段外的 `old-outside` 不出现在 show 里，edit 之后段外字节不变，缺少的 id 不改文件。`npm run lint` 通过（测试类型基线 0、eslint 0 error / 42 warning、depcruise 123 modules / 731 dependencies，已知循环基线未改）。`npm test` 89 文件 / 848 项通过。插入 138 行。
- 未做：推送。版本仍是 2.0.2。M4-T5 未做。

## 2026-11-04 · M4-T3 只同步受管的 memory markdown

- `kind: memory` 可以带一个本地 `files` 目录。只读一层、文件名符合 id 规则的 `*.md`。原文放进同一条宿主受管段落。`notes.txt`、符号链接和子目录不读。不解释内容，不新开宿主目录。
- 这些文件的 hash 写进 `toolkit.lock`，apply 用 blob。源文件后来改了，也不会在 apply 时重读。Codex 的指令路径仍然不写。
- 验证：先红（规格拒绝 `files`）。然后 `topic.md` 进入段落，`do-not-copy` 不出现，`CLAUDE.md` 原有前缀不变。`npm run lint` 通过（测试类型基线 0、eslint 0 error / 42 warning、depcruise 122 modules / 721 dependencies，已知循环基线未改）。`npm test` 89 文件 / 847 项通过。插入 195 行。
- 未做：推送。版本仍是 2.0.2。M4-T4 未做。

## 2026-11-04 · M4-T2 memory 只渲染受管段落

- `instructions` 可以写 `kind: memory`。它观察 Claude Code 的 `CLAUDE.md`。文件不存在或是用户原文时，只追加受管段落。段落外的原有字节保持不变。已受管且被改过的文件仍然是冲突，不覆盖。
- Codex、Cursor 用户级、ZCode 的指令路径仍未核实，不写。`schemas/toolkit.schema.json` 与 zod 导出对齐，补上 `kind`。
- 验证：先红（规格拒绝未知键 `kind`）。然后 `CLAUDE.md` 的原有前缀不变，段落里是锁定正文。`npm run lint` 通过（测试类型基线 0、eslint 0 error / 42 warning、depcruise 121 modules / 718 dependencies，已知循环基线未改）。`npm test` 89 文件 / 845 项通过。插入 83 行。
- 未做：推送。版本仍是 2.0.2。M4-T3 未做。

## 2026-11-04 · M4-T1 知识新鲜度只采用工具结果

- `doctor` 增加 `freshness`。只有 `role: knowledge` 的 server 会出现。调用方传入该 server 的工具结果时，`fresh: true/false` 变成 `fresh` 或 `stale`，并带上工具名。没有结果时是 `unavailable`。
- 不读取 `sources`，不建索引。普通 MCP server 不出现在 `freshness` 里。CLI 不启动子进程去问 server，所以命令行上的 doctor 在没有工具结果时失败关闭。
- 偏差：没有 MCP 客户端，不能替用户调用一个未核实的工具名。工具结果由 `doctorToolkit` 的参数传入。
- 验证：先红（`freshness` 为 undefined）。然后缺失的 source 目录仍可报 `fresh`，磁盘上的哨兵字符串不出现在报告里，HOME 哈希不变。`npm run lint` 通过（测试类型基线 0、eslint 0 error / 42 warning、depcruise 121 modules / 718 dependencies，已知循环基线未改）。`npm test` 89 文件 / 844 项通过。插入 160 行。
- 未做：推送。版本仍是 2.0.2。

## 2026-11-04 · M4 任务拆分

- 按架构评审 §3.5 把 M4 拆成 M4-T1 到 M4-T5，写进 `docs/PLAN.md`。还没有实现。
- `sources` 字段在 M2 已经进入规格。新鲜度必须来自知识 server 自己的工具结果。没有核实的 RAG preset 不写入。
- 未做：推送。版本仍是 2.0.2。没有改 TypeScript，所以没有为这次文档改动重跑全量测试。上一次全量是 M3-T7：88 文件 / 841 项通过。

## 2026-11-04 · M3-T7 toolkit update 只产出 plan diff

- `toolkit update` 重新读取本地来源，并重新抓取 `git+` 和 `npm:`，然后返回和 `plan` 一样的 diff。它不改 `toolkit.lock`，也不写宿主。之后的 `apply` 仍安装锁定字节。
- 偏差：重新解析不会写回 lock。隔离目录 `sources/` 会因重新 clone 而变化，这不是宿主写入。`skills.sh:` 仍然不抓取。
- 验证：先红（未知命令 `update`）。然后已安装的 git skill 保持旧正文，plan 的 ops 仍为空，update 的 diff 含新正文，lock 文件不变，HOME 哈希不变，仓库脚本没有写出标记。`npm run lint` 通过（测试类型基线 0、eslint 0 error / 42 warning、depcruise 120 modules / 717 dependencies，15 条已知循环）。`npm test` 88 文件 / 841 项通过。插入 80 行。
- 未做：推送。版本仍是 2.0.2。M4 仍待拆。

## 2026-10-22 · M3-T6 toolkit search 失败关闭

- `toolkit search <query>` 返回 `TOOLKIT_SEARCH_UNVERIFIED`，退出码 2。查询词被丢弃。不访问网络，不写 HOME，不写 XDG。
- 没有发明 skills.sh 的地址，也没有目录客户端。
- 验证：先红（未知命令退出码 1）。然后 HOME 与 XDG 的目录哈希不变，stderr 是 `TOOLKIT_SEARCH_UNVERIFIED`，输出不含 `skills.sh`。`npm run lint` 通过（测试类型基线 0、eslint 0 error / 42 warning、depcruise 120 modules / 717 dependencies，15 条已知循环）。`npm test` 88 文件 / 840 项通过。插入 42 行。
- 未做：推送。版本仍是 2.0.2。M3-T7 未做。

## 2026-10-21 · M3-T5 bundle 只展开已解析的 include

- bundle 的每个 include 单独记一条结果。lock 里是 `local` 或 `fetched` 的 include 记为从 lock 展开。没有 hash 的 include 记为未解析，不因此去抓取，也不安装。
- 已经在规格顶层的 skill 仍按自己的正文生成 op。`skills.sh:` 没有正文，所以不会变成 op。
- 偏差：展开不复制出第二份安装动作。没有 lock 时，所有 include 都算未解析。
- 验证：先红（bundle 仍写着 “Bundle expansion is not applied”）。然后只安装已锁定的 `review`，不安装 `remote-skill`。`npm run lint` 通过（测试类型基线 0、eslint 0 error / 42 warning、depcruise 120 modules / 717 dependencies，15 条已知循环）。`npm test` 88 文件 / 839 项通过。插入 83 行。
- 未做：推送。版本仍是 2.0.2。

## 2026-10-21 · M3-T4 npm 来源

- `npm:` 的本地包目录只读取 `package.json` 和 `SKILL.md`，不调用 `npm pack` 或 `npm install`。npm 10.9.8 在给本地目录执行 `npm pack --ignore-scripts` 时仍会跑 `prepare`，所以这条路不能用。
- `npm:name@version` 用 `npm view` 取 tarball 地址，再只抽出 `package/SKILL.md`。不安装，不执行包脚本。这次测试没有走这条网络路径。
- 锁定后的正文写入 blob。源文件之后改掉，`apply --yes` 仍安装锁定字节。没有 `--yes` 不安装。包里的 `prepare` 没有写出标记文件。`skills.sh:` 仍然不抓取。
- 验证：先红（`npm:` 仍是 `not-fetched`）。然后哈希与独立 sha256 一致，脚本没有运行。`npm run lint` 通过（测试类型基线 0、eslint 0 error / 42 warning、depcruise 120 modules / 717 dependencies，15 条已知循环）。`npm test` 88 文件 / 838 项通过。插入 153 行。
- 未做：推送。版本仍是 2.0.2。

## 2026-10-21 · M3-T3 git+ 来源

- `toolkit lock` 对 `git+file:` 和 `git+https:` 的 skill 做 bare clone，目录在规格旁边的 `sources/`。只读 `SKILL.md`（`#subdir` 是仓库内目录）。不 checkout。hook、attributes 和模板都被关掉，所以仓库里的脚本不会跑。
- 抓到的正文记为 `fetched` 并写入 blob。`plan` 展示这份正文的 diff，但不安装。没有 `--yes` 时 `apply` 不写宿主。`--yes` 之后安装的是锁定字节。
- 偏差：这次只抓 skill，不抓 `git+` 指令。`npm:` 和 `skills.sh:` 仍然不抓取。测试用的是本地 `file:` 仓库，没有访问外网。
- 验证：先红（`git+` 仍是 `not-fetched`）。然后本地仓库的正文被安装，仓库里的 `evil.sh` 没有写出标记文件。`npm run lint` 通过（测试类型基线 0、eslint 0 error / 42 warning、depcruise 119 modules / 709 dependencies，15 条已知循环）。`npm test` 88 文件 / 837 项通过。插入 209 行。
- 未做：推送。版本仍是 2.0.2。

## 2026-10-21 · M3-T2 apply 使用锁定字节

- `toolkit lock` 把本地正文写到规格旁边的 `blobs/<sha256>`。`toolkit apply` 在有 skill 或指令时必须先有 `toolkit.lock`，安装的是 blob 里的字节。
- 源文件在 lock 之后被改掉，apply 仍然安装锁定时的正文。blob 缺失时返回 `TOOLKIT_LOCK_BLOB_MISSING`，不退回去读源文件。规格和 lock 对不上时返回 `TOOLKIT_LOCK_STALE`。没有 skill 和指令的空规格仍然可以直接 apply。
- 偏差：`toolkit plan` 仍预览当前源文件，所以它可能和 apply 不同。远程来源继续是 `not-fetched`，这次不下载。
- 验证：先红（改源文件后 apply 装上了新正文）。然后锁定正文被安装，源文件保持被改过的内容。`npm run lint` 通过（测试类型基线 0、eslint 0 error / 42 warning、depcruise 118 modules / 701 dependencies，15 条已知循环）。`npm test` 88 文件 / 836 项通过。插入 182 行。
- 未做：推送。版本仍是 2.0.2。

## 2026-10-21 · M3-T1 toolkit.lock

- 新增 `src/core/toolkit/lock.ts` 和 `toolkit lock`。锁文件写在规格旁边，JSON，版本 1。本地 skill 哈希的是 `SKILL.md` 正文，本地指令哈希的是来源文件正文。
- `git+`、`npm:`、`skills.sh:` 记为 `not-fetched`，即使调用方塞了正文也不写 hash。找不到的本地文件记为 `absent`，也不写 hash。`parseToolkitLock` 拒绝给未抓取或缺失来源带 hash。
- 偏差：这次不锁 MCP `sources` 和 bundle，那两项分别留给 M4 和 M3-T5。`apply` 还不用这份 lock，那是 M3-T2。没有访问网络。
- 验证：先红（`src/core/toolkit/lock.ts` 不存在）。然后本地哈希与独立 sha256 一致，远程条目没有 `sha256`，HOME 目录哈希不变。`npm run lint` 通过（测试类型基线 0、eslint 0 error / 42 warning、depcruise 117 modules / 694 dependencies，15 条已知循环）。`npm test` 88 文件 / 834 项通过。插入 204 行。
- 未做：推送。版本仍是 2.0.2。

## 2026-10-21 · M3 任务拆分

- 按架构评审 §3.5 把 M3 拆成 M3-T1 到 M3-T7，写进 `docs/PLAN.md`。还没有实现。
- `toolkit search` 在目录 API 核实前失败关闭。不发明 skills.sh 的地址。
- 未做：推送。M4 仍待拆。

## 2026-10-21 · M2-T8 alpha 文档

- README 开头改成工具箱包管理器。新增 `docs/quickstart/toolkit.md` 和 `docs/migration/2.x-to-3.x.md`。CHANGELOG 增加 `3.0.0-alpha.1` 源码候选条目。
- 包版本保持 `2.0.2`。发布契约 `test/release-contract.test.ts` 要求 `x.y.z`，而 `3.0.0` 需要四个宿主的真实冒烟。没有把版本写成 `3.0.0-alpha.1`，也没有打 tag 或发布。宿主冒烟仍是 `UNKNOWN / PENDING`。
- 2.x 的 `gate` 命令组保留为 deprecated。README 里 TaskAuthority、preimage、AbortSignal 和候选/UNKNOWN 的原有句子还在。
- 验证：`npx vitest run test/skill-contract.test.ts` 6 项通过。没有改运行时代码。`npm run lint` 通过（测试类型基线 0、eslint 0 error / 42 warning、depcruise 116 modules / 689 dependencies，15 条已知循环）。`npm test` 87 文件 / 830 项通过。没有重跑 `test:package`：未跟踪的交接文件还在 `docs/` 下，放进包会让冒烟失败。
- 未做：推送。M2-T7 可选，跳过。M3 还没拆进 PLAN。

## 2026-10-21 · M2-T6 doctor 密钥提示

- 四个 adapter 增加 `documentedEnvExpansion`，不增加布尔 `capabilities.envExpansion`。Claude 是 `dollar-var`，Cursor 是 `dollar-env`，Codex 是 `name-forwarding`，ZCode 是 `unknown`。这些值来自上一提交核对过的官方页，不是本机展开实验。
- `toolkit doctor` 在规格含 `${env:NAME}` 时：Claude 和 Codex 给出 `SECRET_NEEDS_SHELL_ENV`，并建议 wrapper 脚本先导出该变量名。Cursor 的文档语法与工具包一致，不给这条提示。ZCode 给出 `SECRET_EXPANSION_UNKNOWN`，不把它说成已证实的不支持。提示里只有变量名，没有变量值。
- 偏差：计划里的布尔值会把三种已核实写法和一种未知压扁，所以没有写。没有宿主二进制参与展开。`claude` 2.1.296 只用来看版本；`codex`、`cursor`、`zcode` 不在 PATH 上。
- 验证：先红（doctor JSON 没有 `secrets`）。然后三条 CLI 测试通过，包括空规格 `secrets: []`、只选 Codex 的 wrapper 提示、四宿主矩阵里 Cursor 不出现且 ZCode 不是 `SECRET_NEEDS_SHELL_ENV`。`npm run lint` 通过（测试类型基线 0、eslint 0 error / 42 warning、depcruise 116 modules / 689 dependencies，15 条已知循环）。`npm test` 87 文件 / 830 项通过。插入 105 行。
- 未做：推送。版本仍是 2.0.2。M2-T8 未做，M2 总项不勾。

## 2026-10-21 · M2-T6 宿主 MCP 环境变量展开（文档，未勾完）

- 只改了 `docs/hosts/*.md`。没有给 adapter 加 `capabilities.envExpansion`。一个布尔值分不清三种已核实的写法，也会把未核实的 ZCode 说成不支持。
- Claude Code：官方页写明展开 `${VAR}` 和 `${VAR:-default}`，字段是 command、args、env、url、headers。这不是工具包的 `${env:NAME}`。本机 `claude` 是 2.1.296，没有拿它做展开实验。
- Cursor：官方页写明展开 `${env:NAME}`，另外还有 `${userHome}`、`${workspaceFolder}` 等。本机 PATH 上没有 `cursor`。
- Codex：官方页写的是字面量 `env`、按名字转发的 `env_vars`，以及 `bearer_token_env_var`。该页没有 `${VAR}` 展开。本机 PATH 上没有 `codex`。
- ZCode：官方页只展示 `env` 对象，没有展开语法。结论是未知。本机 PATH 上没有 `zcode`。
- 未做：doctor 的 `SECRET_NEEDS_SHELL_ENV`。M2-T6 不勾。没有推送。

## 2026-10-21 · M2-T5 toolkit 命令组

- 新增 `src/app/toolkit-commands.ts` 和 `src/app/toolkit-flow.ts`。`registerCommands` 只多一次注册。六条命令：`init`、`plan`、`apply`、`rollback`、`doctor`、`list`。
- `init` 用 `wx` 写带注释的 `toolkit.yaml`，已存在就 `TOOLKIT_EXISTS`，不覆盖。用户范围在 `$XDG_CONFIG_HOME/stinky-cobbler/toolkit.yaml`。同时用各宿主 `detect` 报告已安装宿主，不要求四家都在。
- `plan` 只读。加载规格，观察宿主，本地有 `SKILL.md` 或指令文件才把正文交给纯计划器。`--json` 含 ops、conflicts、skipped，以及按计划正文合成的 diff。空 HOME 上 plan 前后目录 hash 不变。
- `apply` 看到冲突就不写。有 op 且没有 `--yes` 时返回 `TOOLKIT_CONFIRM_REQUIRED`。空计划可以直接 apply。真正写入仍走已有的 `apply`。
- `rollback --last` 调用 `rollbackLast`。`--to` 只能是最后一次 applyId，否则 `TOOLKIT_ROLLBACK_NOT_LAST`。空账本是 `TOOLKIT_LEDGER_EMPTY`。
- `doctor` 的 drift 就是计划冲突。每个 MCP `${env:NAME}` 只报名字和当前进程里在不在，不打印值。`command` 只查 PATH 上能否执行，不运行它。`list` 返回观察结果。
- 偏差：命令落在两个模块，不是 `src/app/commands/toolkit/*.ts`。diff 不是 Myers，也没有新的 `io/diff` 依赖。instructions 和 command 仍然不观察。前向 remove 仍然不执行。这次不能拆成仍能单独验收的提交，插入 468 行。
- 验证：先红（`unknown command 'toolkit'`）。空 HOME 从 init 到 doctor 目录 hash 不变，drift 为空，第二次 init 不覆盖，空账本 rollback 退出 2。非空计划没有 `--yes` 不写盘；`--yes` 之后 drift 为空；输出不含密钥值；rollback 删掉新建文件。`npm run lint` 通过（测试类型基线 0、eslint 0 error / 42 warning、depcruise 116 modules / 689 dependencies，15 条已知循环）。`npm test` 87 文件 / 829 项通过。
- 未做：推送。版本仍是 2.0.2。M2-T6 和 M2-T8 未做，M2 总项不勾。

## 2026-10-21 · M2-T4 apply 与 hash 回滚

- 新增 `src/app/apply.ts`、`src/app/rollback.ts`、`src/io/ledger.ts`。apply 按 op 调用 `installManagedBytes`、`upsertSegment` 和宿主 `mergeMcp`。每个成功的 op 追加 `toolkit-op-applied` 到 `$XDG_CONFIG_HOME/stinky-cobbler/ledger.jsonl`。某一步失败就停，不自动回滚，报告里提示 `toolkit rollback --last`。
- 回滚按最后一次 apply 的 op 逆序执行。当前字节的 hash 必须等于账本里的 `afterHash` 和 sidecar。不一致就 conflict 并停。新建文件回滚后删除；替换和段落回滚到 apply 前的字节。
- 偏差：这不是 gate 的 hash 链账本，只是 toolkit 的 JSONL。`mergeMcp` 现有接口只写 command 和 args，env 引用留在计划里，不写进宿主文件。前向 `remove` 这次不执行。
- 验证：先红（`src/app/apply.ts` 不存在）。第三个 op 的父路径是文件时，前两个文件和两条账本还在。apply 后再 rollback，原字节回来。改过的文件 rollback 停在 conflict。`npm run lint` 通过（测试类型基线 0、eslint 0 error / 42 warning、depcruise 114 modules / 669 dependencies，15 条已知循环）。`npm test` 86 文件 / 827 项通过。
- 未做：推送。版本仍是 2.0.2。

## 2026-10-21 · M2-T3 纯函数计划器

- 新增 `src/core/plan/plan.ts` 和 `src/core/render/render.ts`。计划器只吃规格、观察结果和已经准备好的正文，不读文件、不访问网络。`src/core` 仍然不能 import `src/hosts` 或 `src/io`。
- `absent` 的 skill 生成 `create`，MCP 生成 `merge-mcp`，instructions 生成 `upsert-segment`。`foreign` 和 `managed-modified` 只进冲突，不生成写入。规格不再要的 `managed` 目标生成 `remove`。宿主明确不支持时进 `skipped`。
- skill 正文的 sha256 与观察 hash 相同则不动；不同则 `replace` 并带上 `priorHash`。MCP 和环境变量引用原样放进 `mcpEntry`，不展开。没有提供正文的 `git+` skill 被跳过，不抓取。bundle 只记一条跳过，不展开。
- 偏差：已安装且 sidecar 仍匹配的 MCP 配置和指令文件不会因为规格里的 command 变了就自动 `replace`。它们的观察 hash 是整份文件，不是单条 server 或单个段落。
- 验证：先红（`src/core/plan/plan.ts` 不存在）。`npm run lint` 通过（测试类型基线 0、eslint 0 error / 42 warning、depcruise 111 modules / 651 dependencies，15 条已知循环）。`npm test` 85 文件 / 823 项通过。
- 未做：推送。版本仍是 2.0.2。

## 2026-10-21 · M2-T2 宿主观察

- 新增 `inspectManagedFile` 和 `src/app/observe.ts`。观察只读：不创建、不修改宿主文件。skill 看 `SKILL.md` 和 sidecar；MCP 再读宿主配置里有没有该 server id。
- 状态：文件不存在，或 MCP 文件里没有这个 id，是 `absent`。sidecar 的 hash 与当前字节一致是 `managed`。sidecar 在但字节变了是 `managed-modified`。文件在、没有 sidecar 是 `foreign`。
- 四个宿主的 skill 和 mcp-server 都走 adapter 的 `locate` / `readMcp`。instructions 和 command 这次不观察，等计划器处理段落和命令路径。
- 验证：先红（`src/app/observe.ts` 不存在）。假 HOME 上覆盖 absent、managed、managed-modified、foreign，并且观察前后目录摘要不变。`npm run lint` 通过（测试类型基线 0、eslint 0 error / 42 warning、depcruise 109 modules / 643 dependencies，15 条已知循环）。`npm test` 84 文件 / 817 项通过。
- 未做：推送。版本仍是 2.0.2。

## 2026-10-21 · M2-T1 toolkit 规格

- 新增 `src/core/toolkit/kinds.ts`、`src/core/toolkit/spec.ts`、`schemas/toolkit.schema.json`。`parseToolkitSpec` 用已经在依赖树里的 zod 4。明文 `env` 值报 `SECRET_LITERAL_FORBIDDEN`。重复 id 报 `TOOLKIT_DUPLICATE_ID`。未知宿主报 `TOOLKIT_HOST_UNKNOWN`，消息里列出合法宿主。
- `HOST_IDS` 写在 core 里，顺序与 `hostAdapters` 相同。core 不能 import `src/hosts`（依赖规则 A9），所以测试锁定 `hostIds()` 与 `HOST_IDS` 相等，`ARTIFACT_KINDS` 从 core 再导出给 host adapter。
- JSON Schema 用 zod 4 的 `toJSONSchema` 生成，没有新增 `zod-to-json-schema`。已提交的 `schemas/toolkit.schema.json` 必须与这个函数的输出相等。
- id 在 skills、mcpServers、instructions、bundles 之间也不能重复。`role: knowledge` 和 `sources` 可以出现在规格里，但还没有 M4 的 doctor 行为。密钥引用字符集按计划是 `[A-Z0-9_./-]`。
- 验证：先红（模块不存在）。`npm run lint` 通过（测试类型基线 0、eslint 0 error / 42 warning、depcruise 108 modules / 637 dependencies，15 条已知循环）。`npm test` 83 文件 / 816 项通过。
- 未做：推送。版本仍是 2.0.2。

## 2026-10-21 · M1-T8 SKILL 模板单源

- 新增 `templates/skill-core.md`、`templates/hosts/codex.md`、`templates/hosts/zcode.md`、`scripts/render-skills.mjs`。核心模板不含 Codex 或 ZCode。两份已提交的 SKILL.md 由同一核心加宿主片段生成，重新生成不改变这两个文件。
- `.zcode/commands/stinky-cobbler.md` 没有对应的 Codex 命令文件，所以不从这套模板生成。
- 两份 SKILL 的措辞断言收成共享不变量：Never auto-approve、输出四段（结果 / 证据 / 边界 / 下一步）、Cooperative Mode、UNKNOWN/PENDING、expectedPreimageHash、Delete is never auto-allowed、TaskAuthority，以及不出现“数据全部留在本地”“不依赖任何云服务”“零配置直接用”。ZCode 仍要求 via 选择不得代选。README、SECURITY 和变更记录的断言留在同一测试里，它们不是两份 skill 的重复散文。
- 没有改 CI 工作流。现有 `npm test` 会执行 `scripts/render-skills.mjs --check`。
- 验证：先让渲染结果与现有 SKILL 字节相同，再改测试。`npm run lint` 通过（测试类型基线 0、eslint 0 error / 42 warning、depcruise 106 modules / 633 dependencies，15 条已知循环）。`npm test` 82 文件 / 811 项通过。
- 未做：推送。`src/` 顶层仍有 config、entry、security、contracts，M1 出口的目录收敛还没做。

## 2026-10-21 · M1-T7 删除未执行的配置

- 删了 `policies/default-approvals.yaml`、`policies/default-data-classification.yaml`、`policies/templates.yaml`、`schemas/templates-policy.schema.json`、`src/gate/mcp/test-run.ts`。`plugins/builtin.yaml` 只保留 repository-read、git-read、docs-index、internal 的 test-run。账本事件名 `test-run` 还在。
- profile 去掉 `rules`、`maxParallelAgents`、`defaultApproval`。角色去掉 `defaultLevel`、`category`、`requiresWorktree`、`writeScope`、`incompatibleWith`，留下 `displayName` 和 `canWrite`。workspace 去掉 `mode` 和 `allowLocalL0Exploration`，`init` 不再接受 `--mode`。
- 插件清单删掉的 7 个字段是 `inputSchemaRef`、`outputSchemaRef`、`sideEffects`、`requiresLease`、`requiresApproval`、`timeoutMs`、`auditMode`。`version` 仍由 schema 校验。`label` 仍随清单加载。`qualityRules` 和 `plugins.enabled` 不在删除清单里，保留。
- 删了 `AgentExecutor`、`AgentExecutorInput`、`AgentExecutorResult`。`GateResult`、`AgentStep`、`RuntimeEvent` 仍被 `types.ts` 里的运行记录引用，没有删。
- 偏差：活性测试还扫到 `schemas/artifact.schema.json` 里只出现在 schema、src 和测试都没有的 `schemaRef`、`contentRef`、`sourceRefs`、`toolRefs`。同一变更删了这四项，否则规定的活性测试不能变绿。
- 偏差：六个 pack 的 `recommendedPlugins` 原来只指向已删插件，现改成空数组。`software-engineering` 去掉 `local-observe`，保留 repository-read、git-read、test-run。否则 `loadRegistries` 会报 `PACK_UNKNOWN_PLUGIN`。
- 已有 `workspace.json` 如果还带着 `mode` 或 `allowLocalL0Exploration`，schema 会拒绝。这次没有加“未知键只警告”的迁移。`defaultAutomation` 仍写在 profile 里，`config doctor` 仍会打印它；运行时不根据它分支。它不在删除清单里。
- 验证：先红后绿。`test/config-liveness.test.ts` 起初失败，孤儿是 `contentRef`、`maxParallelAgents`、`schemaRef`、`sourceRefs`、`toolRefs`。`doctor --json` 起初仍含 `local-observe`；不带 `--mode` 的 `init` 被 commander 拒绝。
- `npm run lint` 通过（测试类型基线 0、eslint 0 error / 42 warning、depcruise 106 modules / 633 dependencies，15 条已知循环，条数未增加）。`npm test` 82 文件 / 811 项通过。
- `git diff --cached --shortstat`：55 files，222 insertions，551 deletions。低于每任务 400 行新增。
- 未做：推送。`gate/` 总行数守卫仍未加。

## 2026-10-21 · M1-T6 CLI 命令注册与 Presenter

- `src/cli.ts` 只负责创建 commander 并调用 `registerCommands`，25 行。命令实现在 `src/app/register-commands.ts`，按命令组拆成不超过 50 行的函数。`task list` 无 `--json` 时首行含 `TASK ID`；`--json` 仍是可解析 JSON。数值选项从 `Number()` 改为 zod `coerce.number().int().nonnegative()`。
- `install-host` 遇到用户改过的受管文件时退出码从 7 改为 1，并且不覆盖文件。
- 偏差：没有拆成每个命令一个文件。拆开会切断 commander 父命令绑定，而整个注册文件仍低于 400 行。dependency-cruiser 允许 `src/app` 引用 `src/gate`，因为命令实现就在 app 里。
- 验证：先红后绿。`npm run lint` 通过（测试类型基线 0、eslint 0 error / 42 warning、depcruise 107 modules，15 条已知循环）。`npm test` 80 文件 / 815 项通过。
- 未做：推送。

## 2026-10-21 · M1-T5 HostAdapter 四宿主

- 新增 `src/hosts/`。`hostAdapters` 是宿主 id 的唯一枚举。`entry/host-spec.ts` 已删除。`preflight` 和 `install-host` 改向 adapter 要路径。
- `entry install-host` 和 `entry mcp-config` 的 `--host` 改为必填，省略时退出码 2、`ENTRY_HOST_INVALID`。`src/cli.ts` 里不再有 `"zcode"` 或 `"codex"` 字符串。库函数 `installHost()` 在没传 host 时仍默认 zcode，所以原来的单元测试不用改调用。
- Codex 与 ZCode 的安装路径保持 2.0.1。Claude Code 与 Cursor 的路径写在 `docs/hosts/`，来源是 2026-10-21 核对过的官方文档。这两个宿主还没有内置安装模板，`installHost({ host: "claude-code" | "cursor" })` 抛 `ENTRY_HOST_UNSUPPORTED`，不写猜测路径。
- 偏差：CLI 的 scope 仍是 `user | workspace`，adapter 的 scope 是 `user | project`。架构草稿没有 slash command 的 format，所以加了 `command-md`。Cursor 还会读 `.agents/skills` 和 Claude/Codex 的 skill 目录；adapter 只把 `.cursor/skills` 当作自己的托管路径。`CLAUDE_CONFIG_DIR` 没有接入。不带 `--host` 的 preflight 现在也会查看 Claude Code 和 Cursor 的 MCP 文件。
- 偏差：`git diff --cached` 为 25 files，591 insertions，114 deletions。新增行数超过每任务 400。四个 adapter、conformance 和路径文档必须一次落地，否则 `host-spec` 删除后安装路径没有来源。
- 验证：`npm run lint` 通过（测试类型基线 0、eslint 0 error / 43 warning、depcruise 106 modules / 630 dependencies，15 条已知循环，条数未增加）。`npm test` 79 文件 / 813 项通过。四个 adapter 的 conformance 通过。
- 未做：推送。`gate/` 总行数守卫仍未加。Claude Code 与 Cursor 的真实宿主冒烟仍是未知。没有给这两个宿主做 bundled install。

## 2026-10-20 · M1-T4 tiered-config 合并策略与 user 层

- 新增 `src/io/tiered-config.ts`。四份旧文件各自声明策略：`orchestration.yaml` 的 `defaults` 用 `record`，`sensitiveExtraPaths` 用 `appendOnly`；`specialists.yaml` 按 `domain` 做 keyed list；`contract-templates.yaml` 按 `name`；`templates.yaml` 用 `record`。
- D-14：后一层不能删掉前一层已有的 `sensitiveExtraPaths`。空数组表示不再追加，不表示清空。内置文件今天仍是 `[]`，所以旧测试看到的结果不变。
- 新增 XDG 用户层，文件在 `$XDG_CONFIG_HOME/stinky-cobbler/policies/<file>`。变量未设置或为空时用 `~/.config`。相对路径直接拒绝。该层文件若是符号链接或目录，拒绝读取；文件不存在则跳过。优先级是 builtin，然后 XDG，然后工作区 `.stinky-cobbler/policies/`。
- 偏差：计划里的层名是 builtin / user / project。返回值里的 `user` / `userPath` 仍是 2.0.1 的工作区覆盖层，避免 `orchestration config show` 的字段改义。XDG 层用 `home` / `homePath`。计划里的策略类型只有三种；同一份文件要同时做 record 和 appendOnly，所以增加了 `{ fields }`。
- `specialists.ts` 和 `contract-templates.ts` 改为读取已经合并的 `effective`。没有 XDG 文件时，按 domain / name 替换和追加的结果与原来一致。
- 测试把 `XDG_CONFIG_HOME` 指到空临时目录，避免本机配置改变套件。本机 `~/.config/stinky-cobbler` 不存在。
- 偏差：`git diff --cached` 为 9 files，665 insertions，168 deletions。新增行数超过每任务 400。合并函数、三层加载，以及「后一层不能删前一层条目」的测试必须一次落地，否则加载路径仍会把数组整体替换掉。
- 验证：先红（`src/io/tiered-config.ts` 不存在）。`npm run lint` 通过（测试类型基线 0、eslint 0 error / 43 warning、depcruise 97 modules / 600 dependencies，15 条已知循环，条数未增加，没有重生成 baseline）。`npm test` 76 文件 / 805 项通过。原 `test/tiered-config.test.ts` 64 项通过。
- 未做：推送。`gate/` 总行数守卫仍未加。15 条 storage 循环没有解开。CLI `config show` 没有加 home 字段。

## 2026-10-20 · M1-T3 managed-file、segment-file、保格式 TOML

- 事实：当前 `smol-toml` 的 `stringify` 会丢掉注释（用一段带 `# keep me` 的 TOML 实测，输出里没有这行注释）。所以 Codex `config.toml` 不再整文件重写，只在原文后面追加新的 `[mcp_servers.<id>]` 表。追加结果若不能再被 parse，安装拒绝，不改写成无注释文本。
- 新增 `src/io/toml-edit.ts`、`src/io/managed-file.ts`、`src/io/segment-file.ts`。sidecar 名仍是 `<file>.stinky-cobbler-managed.json`，备份名仍是 `<file>.stinky-cobbler-backup-<sha256>.bak`。`install-host` 的备份、原子替换和 MCP 合并改调这些函数。
- 段落标记是 `<!-- stinky-cobbler:begin <id> -->` 与 `<!-- stinky-cobbler:end <id> -->`。结束标记带上 id，避免同一文件里两段互相截断。架构评审草稿的结束标记没有 id，这是偏差。
- 回滚的 `HostFileAction` 文案仍留在 `install-host`。用户改过受管文件后返回 `conflict` 且不覆盖，这条行为原来的 `slash-entry` 测试仍覆盖。
- `git diff --cached` 为 10 files，396 insertions，142 deletions。新增行数没有超过 400。sidecar、备份和 TOML 追加放在同一次提交，避免安装路径一半走旧写、一半走新写。
- 验证：先红后绿（注释测试在整文件 stringify 时 `startsWith` 为 false）。`npm run lint` 通过（测试类型基线 0、eslint 0 error / 44 warning、depcruise 15 条已知循环）。`npm test` 75 文件 / 794 项通过。`npm run test:package` 在移开未跟踪的交接文件后打印 `Package smoke passed`（316 个包内文件）。交接文件含本机家目录路径，留在工作区时会被敏感内容检查拒绝；测完已放回，仍未跟踪。
- 未做：推送。`gate/` 总行数守卫仍未加。

## 2026-10-20 · M1-T2 io/fs-boundary 与有界写

- 新增 `src/io/path-lex.ts`、`src/io/bounded-read.ts`、`src/io/fs-boundary.ts`。`fs-boundary` 再导出计划里的读/写表面：`normalizeRelativePath`、`resolveBounded`、`readBounded`、`writeBounded`、`listBounded`。
- `writeBounded` 修 D-02：逐级 lstat，缺目录只建一层；父目录用 `O_DIRECTORY|O_NOFOLLOW` 打开并在 rename 前后核对 dev/ino；临时文件 fsync 后 rename，再 lstat 目标；非 Windows 对父目录 fd 做 fsync。Node 没有 `renameat`，所以用这次复验代替。祖先若是指向 workspace 外的符号链接，抛 `PATH_DENIED` 且不落盘。
- 只换了两处业务落盘：`writes.ts` 的 apply，`write-intents.ts` 的回滚恢复。备份复制、删除、控制面 JSON 仍走原来的 durability / workspace 写。`publishFileDurably` 还在。
- `src/security/workspace-path.ts` 变成策略门面，不是一行 re-export。`io` 不能引用 `gate/policy`。门面只把 `PATH_DENIED` 译回普通 `Error`；`WorkspaceReadBoundaryError` 和调用方自己抛的 `StinkyCobblerError`（例如 docs-index 预算）原样传出。`normalizeWorkspaceRelativePath` 保持原实现，避免 shell 元字符、绝对路径、`..` 的报错顺序变化。
- 偏差：单文件会超过 400 行，而且 `fs-boundary` 与 `bounded-read` 互相 import 会成环，所以拆成三个文件。代码约 569 行新增 / 296 行删除，超过每任务 400 行；读边界必须和有界写一起搬，拆开不能编译。
- 验证：`npm run lint` 通过（typecheck、测试类型基线 0、eslint 0 error / 44 warning、depcruise 93 modules，15 条已知循环被忽略，条数未增加）。`npm test` 72 文件 / 786 项通过。中途一次全量里 `orchestration.test.ts` 的 “rejects an input while its producer is not ACCEPTED” 在 setup 报 “Approval decision cannot precede the request”；单独重跑通过，最终全量也通过。该失败栈在 approval 时间戳校验，不在本次写路径上。
- 未做：推送。交接文件仍未跟踪。`gate/` 总行数守卫仍未加。控制面写与备份复制没有改成 `writeBounded`。

## 2026-10-20 · M1-T1 治理内核搬入 src/gate

- `git mv` 把 `src/storage`、`src/runtime`、`src/policy`、`src/domain`、`src/mcp` 搬到 `src/gate/`。`src/contracts/` 整目录留在原地（含 `schema-registry.ts`）。`src/cli.ts`、`src/mcp-server.ts`、`src/config`、`src/security`、测试的 import 改为新路径。行为没有改。
- 四个包根常量各多一层 `..`，源码和 `dist` 都仍然解析到仓库根，而不是 `src/` 或 `dist/`：`gate/storage/leases.ts`、`gate/storage/write-intents.ts`、`gate/storage/orchestration.ts`、`gate/mcp/invocation.ts`。未搬的 `src/config/tiered.ts`、`src/contracts/default-schema-registry.ts`、`src/entry/install-host.ts` 保持原来的 `../..`。
- 偏差（记在这里，不改评审快照）：
  1. §3.4 写了连 `contracts` 一起搬、只留 `schema-registry.ts`。交接提示词只列五个目录，且拆 `contracts/` 会打断同目录相对 import，所以整份 `src/contracts/` 不动。
  2. `FROZEN_KERNEL` 的内核部分改为 `src/gate/**`。`config`、`entry`、`security`、`contracts`、`cli.ts`、`mcp-server.ts` 仍豁免，否则未搬的超长文件会在本任务里被行数规则挡住。
  3. `gate-is-only-reached-from-cli` 临时允许 `config`、`entry`、`security`、`contracts` 引用 `src/gate/`。这些边是原有的，M1 出口前必须收回。
  4. `git diff --stat` 为 116 files, 575 insertions, 578 deletions，超过每任务 400 行。超出的是搬迁必需的 import 前缀，拆开不能编译。逻辑改动只有上述四个包根常量、eslint 列表和 depcruise 规则。
- 未改：架构评审文档（`main` `e4dcdb9` 的快照）、历史 PROGRESS 条目、`tsconfig`、`package.json` 的 `files`。`gate/` 总行数不得增加的守卫仍未加（M0-T5 推迟项，不在本任务验收里）。
- 验证：`npm run lint` 通过（typecheck、测试类型基线 0、eslint 0 error / 44 warning、depcruise 15 条已知循环被忽略，条数未增加，路径只从 `src/storage/` 换成 `src/gate/storage/`）。`npm test` 71 文件 / 784 项通过。
- 未做：推送。交接文件 `docs/交接提示词-3.x执行.md` 仍未跟踪。
- 补记：独立 evaluator（`01a159a5-ebc5-7053-adab-19a63dd89b95`）复核 `1cf19a0` 为 **PASS**。五目录是 rename；`src/contracts` 与 `src/entry` 无 diff；四个包根常量是 `../../..`；depcruise 基线仍是 15 条且都在 `src/gate/storage/`；identical-byte 备份条件未改。未 amend 该提交。

## 2026-10-20 · M0-T7 2.0.2 候选就绪

- 最终 evaluator 复核（372080b、ae8a88e、0fc2b81）**PASS**：自跑 lint / 784 项测试 / package smoke / check:version / release-gate / audit 全部通过；eslint 探针复现；depcruise `core-has-no-io` 探针由我在 372080b 前实跑并记录于 M0-T5 条目。
- 版本 bump 到 2.0.2（package.json、package-lock.json 两处、`src/version.ts`），`npm run check:version` 通过；CHANGELOG 标题改为 release candidate。
- 完整 `npm run lint`（typecheck + 测试类型基线 0 + eslint 0 错误/44 警告 + depcruise 基线）通过；全量 `npm test` 71 文件 / 784 项通过；`npm run test:package` 对 `stinky-cobbler-2.0.2.tgz` 通过（298 文件）。
- `release-gate --expected 2.0.2 --git-ref codex/stinky-cobbler-3.0-m0` 按设计拒绝（`dispatchRefMismatch`：候选分支名不在允许列表）；`--git-ref main` 为 `valid: true`，即合并到 main 后门禁可过。
- 未做（需要作者凭据或对外发布）：推送分支、合并 main、取得新 SHA 的六矩阵 CI、`git tag v2.0.2`、`npm publish`、GitHub Release、真实宿主冒烟。README 的"发布状态必须实时核验 npm/GitHub"口径不变。
- 真实双宿主（Codex / ZCode）验收仍是 UNKNOWN / PENDING；2.0.2 是维护补丁，不改变这一状态。

## 2026-10-20 · M0-T4b 测试类型错误清零

- 新增 `test/helpers/lease.ts` 的 `asLegacyLease()`：6 个测试文件里故意传给纯评估器/只读工具的 2.0 形态 lease 字面量，用它显式声明意图（字节不变，只是类型断言并注明原因）。
- 其余 27 条：`as const` 任务改 `satisfies TaskCharter`；JSON 解析结果补窄类型；可能为 undefined 的夹具字段用 `!`；`run-lifecycle` 夹具改为条件展开而不是把可选字段设成 `undefined`。
- 恢复 `tsconfig.test.json` 的 `exactOptionalPropertyTypes` 与 `noUncheckedIndexedAccess`（再暴露 20 条，同样修完）。`test/typecheck-baseline.json` 降到 0。
- 验证：受影响的 12 + 8 个测试文件分别 200/200、118/118 通过；完整 lint 与全量测试见下一条记录。

## 2026-10-20 · M0-T2 删除旧产物、M0-T5 工具链、依赖安全更新

- 作者确认按推荐执行。删除根目录四个已 ignore 的 2.0.0 旧产物（zip 5.7 MB、孤儿 sha256、旧 SBOM、手册）。
- 新增 devDependencies（精确版本）：eslint 10.13.0、@eslint/js 10.0.1、typescript-eslint 8.72.0、prettier 3.9.10、dependency-cruiser 18.7.0、husky 9.1.7、lint-staged 17.6.0、@vitest/coverage-v8 4.1.11。
- `npm audit` 在安装前就有 6 条 advisory（1 critical / 2 high / 3 moderate，均为生产依赖链：MCP SDK、fast-uri、smol-toml、ip-address、proxy-addr、source-map-js），CI 的 `--audit-level=high` 本就会失败。`npm audit fix` 后 0 条；MCP SDK 1.12.x → 1.32.1，全量测试 71 文件 / 784 项通过，`typecheck` 通过。
- 守卫落地：`eslint.config.js`（新代码：文件 ≤ 400 行、函数 ≤ 50 行、嵌套 ≤ 4、禁裸 `throw new Error`；冻结内核/测试/脚本的存量问题降为 warning，当前 44 条）；`.dependency-cruiser.cjs`（禁循环、禁用动态 import 解环、`src/core` 不碰 fs、`src/gate` 只能被入口引用）+ 15 条已知 storage 循环写入 `.dependency-cruiser-known-violations.json` 基线（只降不升）；husky pre-commit 跑 lint-staged、pre-push 跑 lint + unit；Dependabot 周更。
- 守卫实证：在 `src/core/probe.ts` 放入 `import fs` + `throw new Error` 探针，eslint 报 `no-restricted-syntax`，depcruise 报 `core-has-no-io`，探针已删。
- `npm run lint` = typecheck + 测试类型基线 + eslint + depcruise，全部通过。
- 推迟：`gate/` 行数不得增加的守卫等 M1-T1 目录存在后再加；Prettier 只对新目录生效（`npm run format`），存量代码不重排。

## 2026-10-20 · M0-T6 evaluator 复核与返工

- 复验结论 **PASS**（evaluator 自跑：3 个新/改套件 13/13；`npm run lint` 通过；完整 `npm test` 71 文件 / 784 项，155 s）。
- evaluator 结论 NEEDS_WORK，三条全部成立并已修：
  1. `durability.ts` 的备份 fsync 用 `open("r+")`，owner 只读（0o400）的业务文件做 modify 时备份副本同为 0o400，会 EACCES。先写红测试（`durability.test.ts` "copies an owner-read-only source"，复现 EACCES）再改成 `open("r")`。
  2. PLAN 的 M0-T6 行仍写 "`--host` 必填" 但未实现：改为注明推迟，并把该项挂到 M1-T5。
  3. D-08 守卫没有先红后绿测试：新增 `test/fault-injection-guard.test.ts`，对 `ebd317b` 的旧源码验证为红（2 failed），对当前源码为绿。
- 与 §3.4 细则的偏差（行为等价，记录备查）：D-01 的结果映射实现为 `src/mcp-server.ts` 的 `controlled()` 而非新文件 `src/mcp/result.ts`；M0-T6 六项合在一个 commit（`08b0c5e`）而非逐项 commit。
- evaluator 自跑：`npm run lint` 通过；5 个相关套件 51/51；三个调用被守卫钩子的套件 26/26。

## 2026-10-20 · M0-T6 P0 子集

- D-01：`invokeControlled` 对 `StinkyCobblerError` 透出 code/message（截断 200 字符、去控制字符），普通异常仍为 `INVOCATION_FAILED`；MCP 受控工具在 `decision.allowed === false` 时置 `isError: true`。两处旧断言从泛泛的 `INVOCATION_FAILED` 改为具体码（`WRITE_INTENT_NOT_CONFIRMED`、`DOCS_INDEX_BUDGET_EXCEEDED`），这正是修复目标。
- D-03：`storage/durability.ts` 新增 `publishFileDurably / copyFileDurably / removeFileDurably`（写临时文件 → fsync → rename → fsync 目录；备份 copy 后 fsync；删除后 fsync 目录）；`writes.ts` 与 `write-intents.ts` 的业务文件落盘、备份、删除、回滚恢复全部改走它们。
- D-09 / D-20：`entry preflight --host` 未知值返回 `ENTRY_HOST_INVALID`（退出 2）；`install-host` 任一动作为 `conflict` 时退出 7（新增 `ExitCode.CONFLICT`）。`--host` 必填推迟到 M1-T5 HostAdapter 落地时一起做（2.x patch 不破坏现有 CLI 调用）。
- D-08：两个无守卫钩子加 `NODE_ENV === "test"` 守卫。
- D-44：使用说明书新增"控制面锁残留的诊断与清理"。
- 验证：先红后绿 9 条新测试；`npm run lint` 通过；`npm test` 70 文件 / 781 项通过；`npm run test:package` 通过（298 文件）。
- 已派 evaluator 独立复核分支 diff（结果见下一条记录）。

## 2026-10-20 · M0-T4 测试基础设施

- `vitest.config.ts` 拆成 `unit` / `integration` 两个 project；integration 的 globalSetup `test/setup/dist-freshness.ts` 在 `dist/` 比构建输入旧时自动重建（实测：故意把 dist 弄旧后 `npm test` 输出重建提示，69 文件 / 770 项通过）。
- `tsconfig.test.json` 把 `test/` 纳入类型检查（放宽 `exactOptionalPropertyTypes` 与 `noUncheckedIndexedAccess`，`lib` ES2023，`allowJs` 以便 import `scripts/*.mjs`）。暴露 49 条测试类型错误，用 `scripts/check-test-types.mjs` 做只降不升的基线（`test/typecheck-baseline.json`）；`npm run lint` = typecheck + 基线检查。
- CI：删去重复的 `test:integration` 与 `runtime-cli` 重跑，`typecheck` 换成 `lint`，加 `timeout-minutes: 30` 与 `concurrency` 取消。
- 新增待办：M0-T4b 清零 49 条测试类型错误（主要是测试里故意构造的 legacy lease 字面量缺 `parentGrantRef/taskAuthorityHash/hostSessionId`，应改成显式 `legacyLease()` 夹具）。

## 2026-10-20 · M0-T1～T3

- 分支：`codex/stinky-cobbler-3.0-m0`（自 `main` `e4dcdb9`）。
- M0-T1：提交 `src/storage/writes.ts` 修复（modify 落盘字节与原文件相同时保留回滚备份）+ 测试 + CHANGELOG 2.0.2 条目。验证：`npx vitest run test/writes.test.ts` 40/40。
- M0-T2：`.gitignore` 并入 `/release-artifacts/`、`/.archify/`。
- M0-T3：ADR-0002、PRD、PLAN、本文件；README 顶部改为 3.x 方向声明 + 2.x 维护承诺。
- 评审基线：`npm run typecheck` 通过；全量 `npx vitest run` 68 文件 / 767 项通过；重新 build 后 5 个集成测试 18/18 通过。

### 待办 / 问题
- 根目录 2.0.0 旧产物（`stinky-cobbler-2.0.0-offline-full.zip`、`stinky-cobbler-2.0.0.tgz.sha256`、`sbom.cyclonedx.json`、`STINKY-COBBLER-MANUAL.md`）均已 ignore，删除待作者确认。
- M0-T5 新增 devDependencies 待作者确认。
- 未核实：各宿主 MCP 配置是否支持 `${VAR}` 展开（M2-T6）。
- 2.x `gate` 待修 P0（M0 不做）：D-04 裸 mkdir 不 fsync、D-05 账本队列与锁嵌套、D-06 leases 直写 contract、D-07 自批、D-12 写入未校验。
