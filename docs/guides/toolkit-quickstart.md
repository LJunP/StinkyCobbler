# Toolkit 快速开始

这是包版本 **3.0.0-rc.1** 的用法。它不是 `3.0.0`。Codex、Claude Code、Cursor、ZCode 的安装冒烟仍是 `UNKNOWN / PENDING`。GA 发布被挡住。

从安装包到第一次成功的 `toolkit apply`，四条命令。`init` 和 `lock` 之间编辑 `toolkit.yaml`，这次编辑不是命令：

```
npm install -g stinky-cobbler-*.tgz
stinky-cobbler toolkit init --json
stinky-cobbler toolkit lock --json
stinky-cobbler toolkit apply --yes --json
```

需要 Node.js 22 或更新版本。在本仓库里：

```
npm install
npm run build
node dist/cli.js toolkit init --json
node dist/cli.js toolkit plan --json
node dist/cli.js toolkit apply --json
node dist/cli.js toolkit doctor --json
```

`init` 把带注释的 `toolkit.yaml` 写到 `$XDG_CONFIG_HOME/stinky-cobbler/toolkit.yaml`。没有设置该变量时，路径是 `~/.config/stinky-cobbler/toolkit.yaml`。文件已经存在就拒绝覆盖。

`plan` 不修改宿主目录。没有变更时，`apply` 可以直接运行。有变更时必须加上 `--yes`。冲突不会覆盖手改过的受管文件。

`doctor` 列出漂移和 `orphans`（受管、但规格已不再指向的文件；`plan` 也列出它们）。toolkit 不删除宿主文件，是否删除由用户决定。规格里的 `${env:NAME}` 只报告变量名是否出现在当前进程中，不打印值。Claude Code 的已核实文档展开 `${VAR}`，Codex 的已核实文档使用字面量 `env` 和按名字转发。这两种都会得到 `SECRET_NEEDS_SHELL_ENV`，并建议用 wrapper 脚本先导出变量。Cursor 的文档使用 `${env:NAME}`，不给这条提示。ZCode 的展开没有写在已核对的官方页上，doctor 给出 `SECRET_EXPANSION_UNKNOWN`。这些是文档结论，不是对四个宿主二进制做的展开实验。

`toolkit rollback --last` 恢复最后一次 apply。账本为空时命令失败。

`toolkit list --json` 列出已观察的 skill、MCP 和指令。command 还没有观察。

`toolkit lock` 在规格旁边写 `toolkit.lock`，并把正文存进 `blobs/<sha256>`。本地 skill 或指令文件记录正文的 sha256。`git+` 和 `npm:` 的 skill 会在这时抓取：`git+` 做 bare clone，`npm:` 读取本地包或已发布的 tarball，只取出 `SKILL.md`，不执行脚本。抓到的正文记为 `fetched` 并带 hash。`skills.sh:` 仍然记为未抓取，没有 hash。找不到的本地文件记为 `absent`。这个命令不改宿主目录。

有 skill 或指令时，`toolkit apply` 先要有这份 lock。它安装的是 blob 里的字节。源文件在 lock 之后改过，也不会被重新读取。blob 缺失时命令失败，不会退回去读源文件。有 lock 之后，`plan` 预览的也是 blob 里的字节，和 apply 写入的完全一致；只有还没有 lock 时 `plan` 才预览当前源文件（此时 apply 会拒绝）。

`git+file:` 和 `git+https:` 的 skill 在 `toolkit lock` 时用 bare clone 放进规格旁边的 `sources/`。只读取 `SKILL.md`（`#subdir` 是仓库内的目录）。不 checkout，不运行仓库里的脚本或 hook。`plan` 展示这份锁定正文的 diff。没有 `--yes` 时 `apply` 不安装。`npm:` 的本地包目录只读取 `SKILL.md`，不执行 `prepare` 或其他脚本。`npm:name@version` 只下载已发布的 tarball 并取出 `SKILL.md`，不安装。`skills.sh:` 仍然不抓取。bundle 只展开 lock 里已经解析的 include。没有 hash 的 include 不会被安装，也不会因此去抓取。`toolkit search <query>` 在目录 API 核实前返回 `TOOLKIT_SEARCH_UNVERIFIED`，不访问网络，也不写盘。`toolkit update` 重新读取本地来源，并重新抓取 `git+` 和 `npm:`，然后只产出 plan diff。它不改 `toolkit.lock`，也不写宿主；之后的 `apply` 仍安装锁定字节。`role: knowledge` 的新鲜度只采用该 server 自己的工具结果。`toolkit doctor` 没有这份结果时记为 `unavailable`，不读取 `sources` 建索引。`instructions` 的 `kind: memory` 只把正文放进宿主文件的受管段落，例如 Claude Code 的 `CLAUDE.md`。段落外的原有字节保持不变。可选 `files` 目录只复制一层合格的 `*.md` 原文到同一受管段落，不解释内容，也不新开宿主目录。`toolkit memory show <id> --host claude-code` 只打印该受管段落的原文。`toolkit memory edit <id> --file <path> --host claude-code` 只替换这一段。它们不检索、不解释记忆内容。Codex 的指令路径还没有核实，所以不会写。

2.x 治理命令仍是顶层命令，例如 `task`、`approval`、`lease`、`ledger`，已 deprecated 并冻结，不再扩展。
