# Claude Code

Sources checked on 2026-10-21:

- https://code.claude.com/docs/en/skills
- https://code.claude.com/docs/en/claude-directory
- https://code.claude.com/docs/en/mcp-quickstart

| Kind | User | Project |
|---|---|---|
| skill | `~/.claude/skills/<name>/SKILL.md` | `.claude/skills/<name>/SKILL.md` |
| command | `~/.claude/commands/*.md` | `.claude/commands/*.md` |
| instructions | `~/.claude/CLAUDE.md` | `<cwd>/CLAUDE.md` |
| mcp-server | `~/.claude.json`, key `mcpServers` | `<cwd>/.mcp.json`, key `mcpServers` |

The MCP quickstart says Claude Code does not read `~/.claude/mcp.json` or `~/.claude/.mcp.json`. `CLAUDE_CONFIG_DIR` can move the user directory; this adapter uses the default home paths. Project `.claude/CLAUDE.md` is also read by Claude Code and is not the managed path chosen here. Bundled install for this host is not part of M1-T5.
