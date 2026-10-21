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

## MCP env expansion

Checked 2026-10-21 at https://code.claude.com/docs/en/mcp, section "Environment variable expansion in `.mcp.json`".

The documented syntax is `${VAR}` and `${VAR:-default}` in `command`, `args`, `env`, `url`, and `headers`. An unset variable without a default stays as the literal `${VAR}` and Claude Code warns. This is not the toolkit reference `${env:NAME}`.

`claude` on PATH was `/Users/lijunpeng/.local/bin/claude`, version `2.1.296 (Claude Code)`. That binary was not asked to expand a variable. `capabilities.envExpansion` is not set, because a boolean would hide this syntax. `toolkit doctor` emits `SECRET_NEEDS_SHELL_ENV` for a toolkit `${env:NAME}` and suggests a wrapper script.
