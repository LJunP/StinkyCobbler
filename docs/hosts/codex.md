# Codex

Verified by the 2.0.1 installer and `test/host-codex.test.ts`. Checked again on 2026-10-21.

| Kind | User | Project |
|---|---|---|
| skill | `~/.codex/skills/<id>/SKILL.md` | `<cwd>/.codex/skills/<id>/SKILL.md` |
| mcp-server | `~/.codex/config.toml`, table `[mcp_servers.<id>]` | `<cwd>/.codex/config.toml` |
| command | unsupported | unsupported |
| instructions | unsupported | unsupported |

Codex has no custom slash-command file. An instruction-file path is not part of the verified 2.0.1 layout, so the adapter does not invent one.
