# ADR-0003：仓库目录结构、命名与持续治理

- 状态：Proposed（2026-11-06，待作者确认后改为 Accepted）
- 关联：[ADR-0002](ADR-0002-从权限门禁转向工具箱包管理器.md)（2.x 冻结到 4.0）、[STANDARDS](../STANDARDS.md)（本决定的执行细则）

## 背景

3.x 工具箱代码基本完成（`3.0.0-rc.1`），但仓库布局还是两代产品混在一起：

- 根目录 7 个数据目录（`schemas` 38 个文件、`policies`、`profiles`、`packs`、`plugins`、`templates`、`examples`）里，只有 `schemas/toolkit.schema.json` 属于 3.x，其余都是冻结的 2.x 门禁资料。
- `src/` 里 3.x 在 `core/`、`io/`、`hosts/`、`app/`，2.x 在 `gate/`，但 2.x 的 `config/`、`contracts/`、`entry/`、`security/` 留在 `gate/` 外面（它们被 `src/gate` 引用 13 / 40 / 0 / 12 处，3.x 的 `core/`、`io/`、`hosts/` 不依赖它们）。
- `test/` 根目录平铺 78 个测试文件（基本是 2.x），3.x 测试在子目录，测试位置和源码位置对不上。
- `docs/` 中英文件名混用；ADR-0001 在 `architecture/`、ADR-0002 在 `decisions/`；`quickstart/` 7 篇里 6 篇是 2.x 手册。
- 规则散在三处：架构评审 §2.5（25 条）、CONTRIBUTING、作者的全局规则；其中 R6（错误码注册表）、R7（一命令一文件）、R9（`core`/`app` 禁 `fs`）、R13（覆盖率地板）只写了、没有工具强制。
- 逐文件内容清理（2026-11-05）只修了内容，没有修布局；没有任何机制阻止目录再乱。

3.0 是主版本，包布局在这里调整成本最低；发布后再动就是破坏性变更。

## 决定

1. **目标目录结构**以 [STANDARDS §1](../STANDARDS.md#1-目录规范) 的白名单为准，要点：
   - `src/` 只放 TypeScript 源码：3.x 在 `core/ io/ hosts/ app/`；所有 2.x 代码并入 `src/gate/`（含原 `config/ contracts/ entry/ security/`）。
   - 新建 `resources/`：运行时读取、随包发布的静态数据。`resources/toolkit/` 放 3.x（`toolkit.schema.json`），`resources/gate/` 放 2.x（schemas、policies、profiles、packs、plugins、examples、skill 模板与渲染产物——原 `templates/`、`.codex/`、`.zcode/`）。
   - `test/` 与 `src/` 一一镜像；仓库级守卫测试放 `test/repo/`，脚本测试放 `test/scripts/`。
   - `docs/` 按用途分目录：`adr/ guides/ hosts/ presets/ migration/ release/ gate/ archive/`。
   - 根目录只允许白名单内的文件和目录。
2. **命名**：文件与目录名一律英文 kebab-case；约定俗成的大写文件保留（README、CHANGELOG、CONTRIBUTING、SECURITY、LICENSE、AGENTS、PRD、PLAN、PROGRESS、STANDARDS）；ADR 用 `docs/adr/NNNN-kebab-title.md`。文档正文和标题继续中文。
3. **2.x 封存不删除**：ADR-0002 的兼容承诺不变（2.x 命令和记录保留到 4.0）。2.x 统一封存在四处：`src/gate/`、`resources/gate/`、`test/gate/`、`docs/gate/`。只有确认无引用的文件才删除，删除清单先给作者确认。
4. **规则单一来源**：[`docs/STANDARDS.md`](../STANDARDS.md) 是项目总规范，由作者维护、可随时修改和新增；任何人（含 AI 工具）改动仓库前先读它。根目录 `AGENTS.md` 只做入口。架构评审 §2.5 的 25 条并入 STANDARDS，并逐条标注"已强制 / 未强制"。
5. **机器强制**：STANDARDS 里的 `repo-structure` 代码块是目录白名单的唯一来源；`test/repo/structure.test.ts` 直接读它，根目录或受管目录出现白名单外的条目即 CI 失败。改白名单 = 改 STANDARDS。
6. **发布前审计**：每个版本发布前必须跑 `npm run audit:release`（结构、密钥、依赖高危、垃圾、链接）并完成一轮逐文件全量审计（grok-conductor 六切片，与 `git ls-files` 对账零遗漏），结果记入 PROGRESS；不通过不得打 tag。

## 迁移批次

每批一个 `feature/` 分支、一个 PR 进 `develop`，六项 CI 全绿才合并。每批独立可回滚。

| 批次 | 内容 | 主要风险 |
|---|---|---|
| P1 | 本 ADR、`docs/STANDARDS.md`、`AGENTS.md`（只加文档） | 无 |
| P2 | `docs/` 重组与英文改名；ADR 合到 `docs/adr/`；2.x 手册进 `docs/gate/`；更新所有链接与测试里的文档路径；§2.5 正文并入 STANDARDS 后架构评审归档 | 断链、测试读错路径 |
| P3 | `test/` 镜像 `src/`：78 个根目录测试进 `test/gate/`（按子模块再分）、仓库级测试进 `test/repo/`、脚本测试进 `test/scripts/` | 相对 import 路径 |
| P4 | `resources/`：7 个数据目录、`templates/`、`.codex/`、`.zcode/` 迁入；资源路径集中到一个模块；更新 `package.json` 的 `files`、package-smoke、render-skills、install-host | 运行时找不到资源、npm 包内容变化 |
| P5 | `src/` 收拢：`config/ contracts/ entry/ security/` 并入 `src/gate/`；`gate-frozen` 的文件清单与行数基线按"只搬不改"一次性更新并在 PROGRESS 记录 | import 路径、冻结守卫 |
| P6 | `test/repo/structure.test.ts`（读 STANDARDS 白名单）、`npm run audit:release`、发布清单与 release-gate 接入；补齐 R6/R7/R9/R13 中能低成本强制的 | 误报 |
| P7 | 最终逐文件全量审计 + README 目录树更新 | 无 |

## 后果

- 3.0 的 npm 包目录布局与 2.x 不同（`resources/` 取代根目录数据目录）；这是主版本内的变化，CHANGELOG 写明。`entry install-host` 安装到宿主的产物与受管 sidecar 格式仍保持字节兼容。
- `src/gate` 文件数与行数会因并入 `config/ contracts/ entry/ security/` 而上升一次；冻结的含义保持"不加新行为"，基线在 P5 一次性调整并记录。
- 之后新增目录、改目录用途都必须在同一 PR 里改 STANDARDS，否则结构守卫失败。

## 被拒绝的备选

- **只整理 docs 和 test（保守）**：根目录与 `src/` 仍然两代混杂，问题根源不变。
- **提前删除 2.x（进取）**：推翻 ADR-0002 的兼容承诺；按 ADR-0002，删除或拆包留到 4.0 决定。
