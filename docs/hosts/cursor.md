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
