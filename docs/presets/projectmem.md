# projectmem

核查日：2026-11-04。来源：<https://github.com/riponcm/projectmem/blob/main/README.md>。

这是文档里的 preset，不是会自动 `apply` 的规格。厂商要求 `command` 写成用户自己的 Python 绝对路径，本仓库不替用户填这条路径。

| 项 | 结论 |
| --- | --- |
| 名称 | projectmem。MCP 名 `projectmem`。命令行是 `projectmem`，别名 `pjm`。 |
| 维护状态 | 厂商 README 在该日宣布 v0.3.5。 |
| 本地或云 | 本地。stdio MCP。没有厂商云，也没有账号。 |
| 数据流向 | 记忆写在仓库里的 `.projectmem/`。默认不联网。唯一可能的网络调用是用户自己打开的更新检查。 |

厂商给出的 MCP 片段：

```json
"mcpServers": {
  "projectmem": {
    "command": "/absolute/path/to/python",
    "args": ["-m", "projectmem.mcp_server"]
  }
}
```

Cognee MCP 和 AgentKits Memory 没有写入 preset。它们的数据流向在这次打开的 projectmem 文档之外，还没有逐项核实。
