# Stinky Cobbler 3.x 实施计划（PLAN）

> 唯一事实来源。任务细则、文件清单、验收标准见 [架构评审与发展规划-2026-10-20 §3.4](架构评审与发展规划-2026-10-20.md#34-下一版本300-alpha1逐任务细则)。每个任务一个 PR，≤ 400 行净变更；先写失败测试再实现；进度只写 [PROGRESS.md](PROGRESS.md)。

## M0 清障与改向 → 2.0.2 候选

- [x] M0-T1 提交工作区 writes 修复 + CHANGELOG 2.0.2 条目
- [x] M0-T2 仓库卫生：`.gitignore` 并入 `release-artifacts/`、`.archify/`（根目录 2.0.0 旧产物删除待确认）
- [x] M0-T3 ADR-0002 + README 口径 + PRD / PLAN / PROGRESS
- [ ] M0-T4 测试基础设施：集成测试先 build、测试纳入类型检查、CI 去重复 + timeout + concurrency
- [ ] M0-T5 工具链与架构守卫：eslint / prettier / editorconfig / nvmrc / dependency-cruiser / hooks / dependabot（新增依赖待确认）
- [ ] M0-T6 P0 子集：D-01 MCP 错误映射、D-03 fsync、D-09 preflight 宿主校验、D-20 conflict 退出码与 `--host` 必填、D-08 两个无守卫故障钩子、D-44 锁清理文档
- [ ] M0-T7 发布 2.0.2（tag / publish / Release 单独确认）

## M1 提取资产（零行为变化）

- [ ] M1-T1 治理内核搬入 `src/gate/`
- [ ] M1-T2 `io/fs-boundary` + 有界写（修 D-02）
- [ ] M1-T3 `io/managed-file` + `segment-file` + 保格式 TOML（修 D-10）
- [ ] M1-T4 `io/tiered-config` 按文件合并策略 + user 层（修 D-14）
- [ ] M1-T5 `hosts/HostAdapter` + codex / claude-code / cursor / zcode + conformance
- [ ] M1-T6 CLI 命令注册化 + Presenter
- [ ] M1-T7 删除死配置与假 affordance（删除清单待确认）
- [ ] M1-T8 SKILL 模板单源化

## M2 toolkit 内核 → 3.0.0-alpha.1

- [ ] M2-T1 领域模型与 schema
- [ ] M2-T2 观察器
- [ ] M2-T3 纯函数计划器 + 渲染器
- [ ] M2-T4 执行器与回滚
- [ ] M2-T5 `toolkit` 命令组
- [ ] M2-T6 密钥与宿主能力核查（`${VAR}` 展开逐宿主实测）
- [ ] M2-T7 MCP 自省工具（可选）
- [ ] M2-T8 文档与 alpha 发布

## M3 插件包与来源 → 3.0.0-beta.1（待拆任务）

## M4 知识与记忆 → 3.0.0-rc.1（待拆任务）
