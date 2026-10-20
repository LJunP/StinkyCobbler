# 进度记录（PROGRESS）

> 只追加，最新在上。每条：日期 / 任务 / 做了什么 / 验证 / 待办与问题。

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
