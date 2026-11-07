# ZCode

Verified by the 2.0.1 installer and the entry tests. Checked again on 2026-10-21. No separate public path document was found; these paths stay the ones the existing tests install.

| Kind | User | Project |
|---|---|---|
| skill | `~/.zcode/skills/<id>/SKILL.md` | `<cwd>/.zcode/skills/<id>/SKILL.md` |
| command | `~/.zcode/commands/<name>.md` | `<cwd>/.zcode/commands/<name>.md` |
| mcp-server | `~/.zcode/cli/config.json`, object `mcp.servers` | `<cwd>/.zcode/config.json` |
| instructions | unsupported | unsupported |

Preflight still also reads the legacy `~/.zcode/config.json` and `~/.agents/mcp.json`. The legacy file is not the install target.

## MCP env expansion

Checked 2026-10-21 at https://zcode.z.ai/en/docs/mcp-services. The page shows `env` as an object on `mcp.servers` and tells the user to type environment values into the settings form. It does not document `${VAR}` or `${env:NAME}` expansion. No `zcode` binary was on PATH. Expansion is **unknown**. `capabilities.envExpansion` is not set. `toolkit doctor` emits `SECRET_EXPANSION_UNKNOWN` and does not claim the host rejected expansion. `toolkit apply` writes no `env` for this host, because no syntax is documented.
