# 进度记录（PROGRESS）

> 只追加，最新在上。每条：日期 / 任务 / 做了什么 / 验证 / 待办与问题。

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
