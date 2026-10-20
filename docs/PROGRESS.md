# 进度记录（PROGRESS）

> 只追加，最新在上。每条：日期 / 任务 / 做了什么 / 验证 / 待办与问题。

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
