# Toolkit 快速开始

这是 3.0.0-alpha.1 源码候选的用法。包版本仍是 2.0.2。它不表示已经发布，也不表示 Codex、Claude Code、Cursor、ZCode 已经完成安装冒烟。宿主冒烟仍是 `UNKNOWN / PENDING`。

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

`doctor` 列出漂移。规格里的 `${env:NAME}` 只报告变量名是否出现在当前进程中，不打印值。Claude Code 的已核实文档展开 `${VAR}`，Codex 的已核实文档使用字面量 `env` 和按名字转发。这两种都会得到 `SECRET_NEEDS_SHELL_ENV`，并建议用 wrapper 脚本先导出变量。Cursor 的文档使用 `${env:NAME}`，不给这条提示。ZCode 的展开没有写在已核对的官方页上，doctor 给出 `SECRET_EXPANSION_UNKNOWN`。这些是文档结论，不是对四个宿主二进制做的展开实验。

`toolkit rollback --last` 恢复最后一次 apply。账本为空时命令失败。

`toolkit list --json` 列出已观察的 skill 和 MCP。instructions 和 command 还没有观察。

`gate` 命令组仍可用，已 deprecated，不再扩展。
