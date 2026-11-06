# AGENTS.md

本仓库的总规则在 [docs/STANDARDS.md](docs/STANDARDS.md)。任何 AI 工具（Claude、grok、Codex、Cursor 等）和人类贡献者，在改动仓库前必须先读它，并遵守：

1. 新文件先在 STANDARDS §1 找到归属目录；找不到就在同一 PR 里先改 STANDARDS。
2. 文件和目录名用英文 kebab-case；临时产物只放 `output/`。
3. 冻结的 2.x 门禁（`src/gate/` 等）只修严重缺陷，不加新行为。
4. 分支：`feature/*` → `develop`；`release/*`、`hotfix/*` → `main`。不直接推 `main`、`develop`，不从 linked worktree 推送。
5. 需求、计划、进度分别以 `docs/PRD.md`、`docs/PLAN.md`、`docs/PROGRESS.md` 为准。
6. 不提交密钥、本机绝对路径或测试产生的临时文件；不为了通过而改测试断言。
7. 打 tag、发布 npm、建 GitHub Release 只由作者执行。
