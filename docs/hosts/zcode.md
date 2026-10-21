# ZCode

Verified by the 2.0.1 installer and the entry tests. Checked again on 2026-10-21. No separate public path document was found; these paths stay the ones the existing tests install.

| Kind | User | Project |
|---|---|---|
| skill | `~/.zcode/skills/<id>/SKILL.md` | `<cwd>/.zcode/skills/<id>/SKILL.md` |
| command | `~/.zcode/commands/<name>.md` | `<cwd>/.zcode/commands/<name>.md` |
| mcp-server | `~/.zcode/cli/config.json`, object `mcp.servers` | `<cwd>/.zcode/config.json` |
| instructions | unsupported | unsupported |

Preflight still also reads the legacy `~/.zcode/config.json` and `~/.agents/mcp.json`. The legacy file is not the install target.
