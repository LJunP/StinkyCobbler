# Codex

Verified by the 2.0.1 installer and `test/gate/entry/host-codex.test.ts`. Checked again on 2026-10-21.

| Kind | User | Project |
|---|---|---|
| skill | `~/.codex/skills/<id>/SKILL.md` | `<cwd>/.codex/skills/<id>/SKILL.md` |
| mcp-server | `~/.codex/config.toml`, table `[mcp_servers.<id>]` | `<cwd>/.codex/config.toml` |
| command | unsupported | unsupported |
| instructions | unsupported | unsupported |

Codex has no custom slash-command file. An instruction-file path is not part of the verified 2.0.1 layout, so the adapter does not invent one.

## MCP env expansion

Checked 2026-10-21. https://developers.openai.com/codex/mcp redirected to https://learn.chatgpt.com/docs/extend/mcp.

That page documents `env` as variables to set, with the example `MY_ENV_VAR = "MY_ENV_VALUE"`. `env_vars` forwards named variables. `bearer_token_env_var` and `env_http_headers` store variable names, not `${VAR}` text. The page does not document `${VAR}` or `${env:NAME}` expansion. No `codex` binary was on PATH, so this was not executed. `capabilities.envExpansion` is not set. `toolkit doctor` emits `SECRET_NEEDS_SHELL_ENV` and suggests a wrapper script.
