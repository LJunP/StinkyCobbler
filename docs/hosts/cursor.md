# Cursor

Sources checked on 2026-10-21:

- https://cursor.com/docs/skills
- https://cursor.com/docs/mcp
- https://cursor.com/docs/rules

| Kind | User | Project |
|---|---|---|
| skill | `~/.cursor/skills/<name>/SKILL.md` | `.cursor/skills/<name>/SKILL.md` |
| mcp-server | `~/.cursor/mcp.json`, key `mcpServers` | `.cursor/mcp.json`, key `mcpServers` |
| instructions | unsupported | `.cursor/rules/*.mdc` |
| command | unsupported | unsupported |

The skills document also lists `.agents/skills/`, `~/.agents/skills/`, and the Claude and Codex skill directories as places Cursor reads. The adapter reports the Cursor-owned directory as its single managed path. A user-level rules directory was not in the rules document. Bundled install for this host is not part of M1-T5.

## MCP env expansion

Checked 2026-10-21 at https://cursor.com/docs/mcp, section "Config interpolation".

Cursor documents `${env:NAME}` in `command`, `args`, `env`, `url`, and `headers`. The same section also documents `${userHome}`, `${workspaceFolder}`, `${workspaceFolderBasename}`, `${pathSeparator}`, and `${/}`. `${env:NAME}` matches the toolkit secret reference. No `cursor` binary was on PATH, so this was not executed. `capabilities.envExpansion` is not set. `toolkit doctor` does not emit `SECRET_NEEDS_SHELL_ENV` for this syntax.
