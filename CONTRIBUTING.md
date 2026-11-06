# Contributing to Stinky Cobbler

感谢你帮助改进 Stinky Cobbler。提交贡献前，请先确认问题属于本项目的实际范围：3.x 是声明式 AI agent 工具箱包管理器，用一份 `toolkit.yaml` 把 skill、MCP server 和指令落到 Codex、Claude Code、Cursor、ZCode；2.x 顶层治理命令（`validate`、`task`、`approval`、`lease`、`write`、`orchestration` 等）保持可用，在 `--help` 标记 `[deprecated 2.x]` 并冻结。贡献范围包括 toolkit 文档与这四个宿主的适配，以及仍在维护的 2.x 门禁缺陷。它不是宿主 sandbox、通用多 Agent 平台，也不自动保证安全、审查独立或语义正确。只治理经自身 CLI/MCP 路由的仓库操作。

## 提交问题

- 可复现缺陷请使用 Bug report，并写明安装来源、精确版本、Node.js/操作系统/宿主版本、最小复现和已脱敏日志。
- 产品建议请从具体问题和用户价值出发，说明是否需要新增能力、兼容迁移或安全边界变化。
- 怀疑安全漏洞时不要创建公开 Issue。请使用 [GitHub Security Advisories](https://github.com/LJunP/StinkyCobbler/security/advisories/new) 私密报告。
- 不要提交 API key、Token、私钥、凭据、个人数据、生产信息或未脱敏的工作区内容。

## 开发环境

当前运行时要求以 `package.json` 的 `engines` 为准。源码开发与测试使用 Node.js 22.12+ 或 Node 24（Vite 8 的开发依赖要求比 CLI/MCP 运行时更高）。开发前至少执行：

```bash
node --version
npm ci
npm run build
npm run typecheck
npm test
```

涉及 CLI/MCP、安装、打包或发布契约时，还应按改动范围运行：

```bash
npm run test:integration
npm run test:package
git diff --check
```

这些结果只证明被执行的当前源码检查，不等于真实 Codex/ZCode 宿主验证，也不等于 npm/GitHub 已发布。

## 分支模型

- `main`：只放已发布代码。每次发布打标签 `v<version>`。这是 GitHub 默认分支。
- `develop`：下一版本的集成分支。当前集成的是 `3.0.0-rc.1`。
- `release/<version>`：发布准备。用 PR 合并进 `main`，再把 `main` 合并回 `develop`。
- `hotfix/<version>`：从 `main` 切出的紧急修复。用 PR 合并进 `main`，再合并回 `develop`。
- `feature/<name>`：从 `develop` 切出的短生命周期分支，用 PR 合并回 `develop`。

`feature/*` 的 PR 目标是 `develop`。`release/*` 和 `hotfix/*` 的 PR 目标是 `main`，合并后再把 `main` 回合并进 `develop`。

`main` 和 `develop` 受保护：必须走 PR，六项 CI 矩阵任务（Ubuntu / macOS / Windows × Node 22 / 24）通过，禁止 force push，禁止删除。

打标签、GitHub Release 和 `npm publish` 只由作者执行。合并不自动授权这些发布动作。

旧分支名 `codex/stinky-cobbler-<version>-hardening` 已停用。release-gate 仍接受这个与版本精确对应的旧 ref，只为复核 2.0.1 和 2.0.2 的历史 provenance。

## 变更原则

1. 先写清问题、边界和验收条件，再修改实现。
2. 权限、路径、Approval、Lease、WriteIntent、preimage、回滚和审计门禁必须 fail-closed；不得用兼容性理由静默放宽。
3. 保留 Cooperative Mode 边界：未经本工具路由的宿主文件工具、Shell、Git 和第三方 MCP 不受治理。
4. 新能力必须区分 `ENGINE_ENFORCED`、`HOST_PROCEDURAL`、`DECLARED_ONLY` 和 `NOT_AVAILABLE`，不能把设计或宿主流程写成引擎保证。
5. 修改持久化格式、CLI 或宿主安装行为时，同步更新 [支持矩阵](./docs/支持矩阵.md)、[兼容与迁移政策](./docs/兼容与迁移政策.md)、CHANGELOG 和相应回归测试。
6. 不直接修改用户的宿主配置或工作区控制面来“修复”测试；安装与迁移必须先提供 dry-run，并保护用户改动。

## Pull Request 验收

PR 应包含：

- 解决的问题与明确非目标；
- 行为变化、兼容影响和安全影响；
- 对应测试及实际运行结果；
- 文档变化；
- 未验证事项与回滚方案（如适用）。

维护者可能要求缩小范围、补充失败路径测试，或把发布/迁移工作拆成独立 PR。合并不自动授权 tag、GitHub Release 或 npm publish。
