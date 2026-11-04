# Stinky Cobbler 3.x 实施计划（PLAN）

> 唯一事实来源。任务细则、文件清单、验收标准见 [架构评审与发展规划-2026-10-20 §3.4](架构评审与发展规划-2026-10-20.md#34-下一版本300-alpha1逐任务细则)。每个任务一个 PR，≤ 400 行净变更；先写失败测试再实现；进度只写 [PROGRESS.md](PROGRESS.md)。

## M0 清障与改向 → 2.0.2 候选

- [x] M0-T1 提交工作区 writes 修复 + CHANGELOG 2.0.2 条目
- [x] M0-T2 仓库卫生：`.gitignore` 并入 `release-artifacts/`、`.archify/`；根目录 2.0.0 旧产物已删除
- [x] M0-T3 ADR-0002 + README 口径 + PRD / PLAN / PROGRESS
- [x] M0-T4 测试基础设施：集成测试先 build、测试纳入类型检查、CI 去重复 + timeout + concurrency
- [x] M0-T5 工具链与架构守卫：eslint / prettier / editorconfig / nvmrc / dependency-cruiser / hooks / dependabot；同时 `npm audit fix` 清零 6 条 advisory
- [x] M0-T6 P0 子集：D-01 MCP 错误映射、D-03 fsync、D-09 preflight 宿主校验、D-20 conflict 退出码、D-08 两个无守卫故障钩子、D-44 锁清理文档（`--host` 必填推迟到 M1-T5，2.x patch 不破坏现有 CLI 调用）
- [x] M0-T4b 清零 49 条测试类型错误（legacy lease 字面量改显式夹具 `asLegacyLease`），基线 0，`tsconfig.test.json` 已恢复全严格
- [ ] M0-T7 发布 2.0.2：候选已就绪（版本 bump、check:version、package smoke、release-gate 对 main 通过）；剩余推送 → 合并 main → 六矩阵 CI → tag `v2.0.2` → `npm publish` → GitHub Release，由作者执行

## M1 提取资产（零行为变化）

- [x] M1-T1 治理内核搬入 `src/gate/`
- [x] M1-T2 `io/fs-boundary` + 有界写（修 D-02）
- [x] M1-T3 `io/managed-file` + `segment-file` + 保格式 TOML（修 D-10）
- [x] M1-T4 `io/tiered-config` 按文件合并策略 + user 层（修 D-14）
- [x] M1-T5 `hosts/HostAdapter` + codex / claude-code / cursor / zcode + conformance；`entry install-host` / `mcp-config` 的 `--host` 改为必填（从 M0-T6 推迟）
- [x] M1-T6 CLI 命令注册化 + Presenter
- [x] M1-T7 删除死配置与假 affordance
- [x] M1-T8 SKILL 模板单源化

## M2 toolkit 内核 → 3.0.0-alpha.1

- [x] M2-T1 领域模型与 schema
- [x] M2-T2 观察器
- [x] M2-T3 纯函数计划器 + 渲染器
- [x] M2-T4 执行器与回滚
- [x] M2-T5 `toolkit` 命令组
- [x] M2-T6 密钥与宿主能力核查（`${VAR}` 展开逐宿主实测）
- [ ] M2-T7 MCP 自省工具（可选）
- [x] M2-T8 文档与 alpha 发布

## M3 插件包与来源 → 3.0.0-beta.1

只做架构评审 §3.5 点名的范围。`skills.sh` 的 API 还没核实，`toolkit search` 在核实前必须失败关闭。

- [x] M3-T1 `toolkit.lock` 记录来源解析结果和内容 hash，不访问网络
- [x] M3-T2 本地来源的 apply 使用 lock 里的字节，不重新读取已锁定正文
- [x] M3-T3 `git+` 来源下载到隔离目录；plan 展示 diff，确认后才应用；不执行来源内脚本
- [x] M3-T4 `npm:` 来源同样只使用已锁定内容，不执行脚本
- [x] M3-T5 bundle 只展开 lock 里已经解析的 includes
- [x] M3-T6 `toolkit search` 在目录 API 未核实前失败关闭，并且不写盘
- [x] M3-T7 `toolkit update` 重新解析来源并产出 plan diff，不直接写宿主

## M4 知识与记忆 → 3.0.0-rc.1

只做架构评审 §3.5 点名的范围。不自建向量索引，不解释、不检索记忆内容。RAG preset 在四项事实核实前不写入。

- [x] M4-T1 `role: knowledge` 的 `sources` 已在规格中。`doctor` 的索引新鲜度只采用该 server 自己的工具结果；没有工具结果时失败关闭，不读取 `sources` 建索引
- [x] M4-T2 `instructions` 增加 `memory` 子类型，只渲染到宿主受管段落。段落外字节保持不变
- [x] M4-T3 可选 `memory/*.md` 只同步受管文件，不解释内容
- [x] M4-T4 `toolkit memory show` 显示受管段落原文，`toolkit memory edit` 只替换该段落
- [x] M4-T5 经核实的 RAG/memory preset：名称、维护状态、本地或云、数据流向四项都核实后才写入；核实前不写 preset
