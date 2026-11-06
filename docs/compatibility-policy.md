# 兼容与迁移政策

## 原则

Stinky Cobbler 优先保持审计可读性和可安全终止性，但不会为了“继续运行”而接受缺失当前 authority 字段的旧记录。安全门禁可以在补丁版本中收紧；这类变化必须 fail-closed、给出明确的重发/重建路径，并记录在 CHANGELOG。

公开发布状态必须实时核验 [npm](https://www.npmjs.com/package/stinky-cobbler)、[GitHub tags](https://github.com/LJunP/StinkyCobbler/tags) 和 [GitHub Releases](https://github.com/LJunP/StinkyCobbler/releases)。不要从 checkout 的 `package.json`、历史文档、测试结果或预期文件名推断已发布。

## 版本与格式承诺

- patch：可以修复缺陷和收紧安全/一致性门禁；不得静默扩大权限或把旧记录当作新 authority。
- minor：可以添加向后可读的字段、命令和能力；破坏执行兼容时必须提供明确迁移或重建说明。
- major：可以移除已弃用接口或改变核心持久化契约，但仍应尽可能保留旧记录的只读导出/安全终止路径。
- 配置和记录一旦不满足当前 Schema/authority，必须明确拒绝执行；不得静默降级到旧规则或 Fake/default 行为。

## 2.0.0 authority 记录迁移

当前实现保留 2.0.0 Lease、Contract 和 Plan 的读取能力，并分别提供公共 CLI `lease revoke`、`orchestration contract cancel`、`plan cancel` 安全终止路径。这些旧记录缺少当前高保证执行所需的 authority 快照，不能直接续跑：

| 记录 | 允许 | 拒绝 | 迁移动作 |
|---|---|---|---|
| Lease | show/list/read、`revoke` | 受控调用，返回 `LEASE_REISSUE_REQUIRED` | 重新核对 persisted Task，取得当前精确 Approval，并签发新 Lease |
| Contract | show/read；公共 CLI `orchestration contract cancel` | 创建新 Run，返回 `CONTRACT_REISSUE_REQUIRED` | 先用公共 CLI 取消旧 Contract，再在当前 workspace/Profile 下新建 Contract，使其快照当前 Task authority、delegation budget 与 `reviewPolicy`；不要手改旧状态 |
| Plan | show/list/read、`cancel` | execute，返回 `PLAN_REISSUE_REQUIRED` | 重新生成 Plan、取得当前确认，再执行 |

不要手工给旧 JSON 补字段、复制 nonce/hash，或直接改状态来绕过重发。历史记录应保留为历史证据；新执行引用新 ID。

## immutable `reviewPolicy`

Contract 创建时，当前 workspace Profile 被解析为不可变策略快照：

- `individual` → `SELF_REVIEW_AUDITED`；同一 executor 可以提交 review，但会保留 `sameSourceReview` / `SELF_REVIEW_NON_INDEPENDENT` 标记。
- `team`、`organization`、`regulated` → `INDEPENDENT_REQUIRED`；同源 review 被引擎拒绝。
- 配置缺失或 legacy Contract 未带 `reviewPolicy` → `INDEPENDENT_REQUIRED`，fail-closed。

Contract 创建后修改 Profile 不会改写已有 Contract。要采用新策略，必须取消或完成旧 Contract，并新建 Contract；不得原地修改快照。

## workspace config 迁移

先只读查看和预览：

```bash
stinky-cobbler config show --root /absolute/path/to/workspace --json
stinky-cobbler config validate --root /absolute/path/to/workspace --json
stinky-cobbler config migrate --root /absolute/path/to/workspace --dry-run --json
```

审查目标、版本和差异后才执行非 dry-run。正式迁移应保留旧配置备份并记录 ledger；失败不得静默回退。工作区配置迁移不创建 Task、Approval、Lease、Contract 或执行授权。

## `install-host` managed upgrade

`entry install-host` 是显式命令，没有 `postinstall` 自动写入。对 command/Skill 和可选 MCP 配置都应先运行 `--dry-run --json`。

Managed file 的安全依据是目标旁的 sidecar：

```text
<target>.stinky-cobbler-managed.json
```

sidecar 记录安装版本、当前受管 bytes 的 SHA-256 和上一份备份元数据。自动升级只在以下任一条件成立时进行：

1. sidecar 的 `installedSha256` 与当前目标 bytes 完全一致；或
2. 当前目标 bytes 命中实现内置的**精确已知旧版 hash**。当前兼容表只认以下 2.0.0 模板：
   - ZCode command：`10f3eb9bb025410367d279da2dad277fbd1ebf6af2af0b7406da090269a5a807`
   - ZCode Skill：`c86e354cda5cc758755a71018f39773fc3b417a668ed57af70a3d66ac7dc6bae`
   - Codex Skill：`d4a9a2ef5ac056de38a8f03542516830f3007cf25695c743686f12e1d7b75325`

版本文字或“看起来像官方模板”不构成受管依据。hash 不匹配时返回 `conflict` 并保护用户内容，不覆盖、不自动合并。

升级前创建内容寻址的独占备份：

```text
<target-basename>.stinky-cobbler-backup-<sha256>.bak
```

同名备份已存在时，只有普通非 symlink 文件且 bytes hash 完全一致才可复用；否则 fail-closed。MCP 配置采用解析后合并，保留无关字段，并对完整旧配置做相同的受管备份。

## `install-host --rollback`

先预览，再执行：

```bash
stinky-cobbler entry install-host --host zcode --rollback --dry-run --json
stinky-cobbler entry install-host --host zcode --rollback --json

# 安装时包含 MCP 配置，则回滚也必须带 --mcp
stinky-cobbler entry install-host --host codex --mcp --rollback --dry-run --json
stinky-cobbler entry install-host --host codex --mcp --rollback --json
```

只有同时满足以下条件才恢复：

- sidecar 存在且包含上一份备份；
- 当前目标仍匹配 sidecar 的 `installedSha256`，即安装后没有用户改动；
- 备份路径是同目录安全 basename，且备份是普通非 symlink 文件；
- 备份 bytes 匹配记录的 SHA-256；
- 目标未缺失，替换前后没有检测到并发漂移。

任何条件不满足都保留当前用户内容并返回 conflict/error。成功回滚会把当前受管 bytes 再保存为下一回滚点，因此是可逆的受管切换，不是无条件覆盖。

## 业务写入回滚恢复

`write rollback` 在触碰业务文件前先把 WriteIntent 标记为 `RECOVERY_REQUIRED` 并写入 rollback recovery journal。如果进程在目标变更、Evidence、ledger 或最终状态之间中断，先检查 intent、journal、目标与备份 hash，再运行：

```bash
stinky-cobbler write show <write-intent-id> --root /absolute/path/to/workspace --json
stinky-cobbler write rollback-recover <write-intent-id> --root /absolute/path/to/workspace --json
```

`rollback-recover` 可幂等完成已经 fenced 的回滚，但只接受目标仍匹配 journal 记录的“回滚前”或“已恢复”状态。若目标匹配两者之外的第三方 bytes、备份缺失/漂移、路径策略变化或 journal 不完整，它会拒绝并要求人工诊断；不得强制覆盖。它不是普通 `write apply` 崩溃的通用修复，也不提供跨 WriteIntent 原子性。

## 降级与证据

- 降级前先导出/保留需要的只读状态和 ledger，不要让旧二进制写入它不理解的新格式。
- 不直接删除 `.stinky-cobbler/` 来“完成迁移”；这会丢失 authority、Evidence 和恢复线索。
- 每次迁移都记录输入版本、目标版本、精确 bytes/hash、dry-run、正式结果、失败边界和回滚结果。
