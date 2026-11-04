# 进度记录（PROGRESS）

> 只追加，最新在上。每条：日期 / 任务 / 做了什么 / 验证 / 待办与问题。

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
