# ADR-0004：规格变化时原地更新未被手改的受管内容

- 状态：Accepted（2026-11-08）
- 关联：[PRD §2](../PRD.md#2-解决什么问题)（"apply 只改受管内容，用户手改过的文件一律 conflict 不覆盖"）、[PRD §5 S2/S3](../PRD.md#5-成功标准30-ga)

## 背景

3.0.0-alpha.1 到 rc.1 的 `plan` 对三类受管内容的处理不一致：

- **skill**：受管文件字节与 sidecar hash 一致、但规格里的正文变了 → `replace`，带 `priorHash`。
- **MCP 条目**：同样的情况被 `observe` 报成 `managed-modified`，`plan` 记为冲突，`apply` 以 `TOOLKIT_CONFLICT` 拒绝，`doctor` 永远报漂移。用户唯一的出路是 `rollback`（只能回最后一次）或手删条目和 sidecar。3.x 缺陷修复（PR #11）开始把 `env` 写进宿主文件之后，所有 alpha.1 装过的 MCP 条目都会落进这个死角。
- **指令段落**：受管文件里只要已经有任何段落，`plan` 就不再产生操作——改了正文、或给同一个 `CLAUDE.md` 新增第二条指令，都不会写入，也不报冲突。

把"规格变了"当冲突，是 M2 时的保守选择：MCP 和指令写进的是用户自己的文件（`~/.claude.json`、`config.toml`、`CLAUDE.md`），宁可不写也不误写。但"文件是否被手改"已经由 sidecar hash 精确判定：hash 一致就说明文件里每个字节都是本工具上次写的，此时替换条目不会丢掉用户的任何输入。保守选择换来的是 S2（apply 后 doctor 零漂移）做不到、指令静默不更新。

## 决定

1. 受管内容统一按 skill 的规则：**文件字节与 sidecar 一致、规格渲染结果不同 → 原地更新；文件被手改 → 冲突，不覆盖**。
   - MCP：`observe` 对受管文件给出 `current: boolean`，不再伪装成 `managed-modified`；`plan` 对 `current: false` 生成新动作 `replace-mcp`。
   - 指令：`observe` 读出受管文件里每个段落的正文（`segments`）；`plan` 只为正文不同或缺失的段落生成 `upsert-segment`。
2. 每个覆盖受管文件的操作都带 `priorHash`；`apply` 写入前核对，文件在计划之后变了就以 `TOOLKIT_CONFLICT` 停止（原来 `replace` 带了 `priorHash` 但没有核对）。同一文件上的多个操作是按同一份字节计划的，所以同一次 apply 写过该文件后，下一个操作改为核对本次 apply 刚写出的 hash。`rollback` 也相应地按每条账本事件自己的 `beforeHash` 找内容寻址备份，不再读 sidecar 的 `previous`（后者在同一文件被写两次时会让回滚误删用户文件）。
3. Codex `config.toml` 里还有用户自己的设置，所以替换按文本做：只改 `[mcp_servers.<id>]` 表及其子表，其余字节（含注释）不动；改完重新解析，若除该条目外还有任何差异、或表头不能唯一定位（内联表、重复出现），就当冲突拒绝。JSON 宿主本来在合并时就整份重写，替换沿用同样的方式。

## 取舍

- 放弃的方案 A：保留"规格变化即冲突"，另加 `apply --update` 开关。多一个用户要记的开关，且默认行为仍让 S2 做不到。
- 放弃的方案 B：TOML 也整份重新序列化。实现简单，但会抹掉用户 `config.toml` 里的注释和排版。
- 代价：rc.1 之前依赖"规格一变就冲突"的脚本，现在会看到 `replace-mcp` / `upsert-segment` 而不是退出码 7；CHANGELOG 已标为相对 alpha.1 的破坏性变化。

## 后果

- 规格是唯一事实来源：改规格、`lock`、`apply` 就能收敛，`doctor` 的漂移只剩真正的手改。
- 新增的宿主适配器必须实现 `replaceMcp`，`src/hosts/conformance/run.ts` 对四个宿主都检查替换只改该条目、缺失条目算冲突。
