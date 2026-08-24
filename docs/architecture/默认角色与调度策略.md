# 默认角色与调度策略

> **DECLARED_ONLY 设计路由。** 当前产品聚焦 Cooperative Mode 下 Codex/ZCode 本地仓库的受控执行与审计；角色 ID、Pack 映射和 DAG 示例只是配置/推荐材料，不证明宿主会自动创建这些 Agent。Contract 创建时不可变快照 `reviewPolicy`：`individual=SELF_REVIEW_AUDITED`，其余受支持 Profile/缺失配置=`INDEPENDENT_REQUIRED`。当前权威边界见 [README](../../README.md) 与 [SECURITY](../../SECURITY.md)。

## 稳定 ID 与显示名

角色策略依赖 stable ID；用户可修改显示名，不得修改 stable ID。

```yaml
roles:
  builder:
    displayName: 锻造师
```

显示名仅影响界面、提示词和展示；任务 Capsule、策略、回执始终使用 `builder`。

## 默认调度选择

```text
先按 Pack 确定领域角色
→ 再按任务风险、数据密级、是否有副作用选择最小 DAG
→ 只读工作可并行
→ 同 writeSet 写入必须串行
→ 高影响动作进入人工审批
```

| 场景 | 默认 DAG |
|---|---|
| 总结资料 | planner → researcher/producer → reviewer → scribe |
| 研究报告 | planner → researcher → fact-reviewer → verifier → scribe |
| 内部流程草稿 | planner → producer → reviewer → scribe |
| 跨系统更新 | planner → policy guardian → operator → reviewer → verifier → approval → scribe |
| 软件功能 | planner → architect → builder → testwright/reviewer → verifier → scribe |
| 安全/权限/上传 | 软件功能 DAG + sentinel |
| 缓存/事务/MQ | 软件功能 DAG + reliability |

## 历史设计规则（非全部 ENGINE_ENFORCED）

- Builder 与 reviewer 分离仍需宿主实现；引擎在 `INDEPENDENT_REQUIRED` 下拒绝同源 review，在 `SELF_REVIEW_AUDITED` 下允许但记录 `sameSourceReview`。
- PROPOSAL 未转为 DECISION 时，不能成为写入依据。
- 本工具不会自动把 Task 标记为 `DONE`；宿主的完成判断不由本页证明。
- Capability Lease 过期、范围不符或调用次数超限时，工具必须拒绝。
- 用户可选择模式和自定义显示名，但高风险默认审批、跨 Workspace 隔离、Secret 默认拒绝不可被静默关闭。
