# 等待源口径夹具（R9）

**来源**：`20261112-180157-b0aa0f1e` 的真实会话轨迹（收尾阶段重复挂监听事故的取证会话）。
不是合成数据。

**裁剪规则**（见方案的验收 1）：

- `events.jsonl`：从原 `events.jsonl` 里**只保留** `WaitRegistered` / `WaitReleased`
  两类事件，字段原样（`id` / `kind` / `promise_kind` / `deadline_ms` / `description`）。
  共 6 条登记 + 6 条释放——原会话里所有等待事件都在。
- `history.json`：原 `session.traj` 的 `history[265..335]` 连续窗口，逐 block 精简：
  `thinking` 截到前 400 字、`text` 截到前 300 字、`tool_result.content` 截到前 400 字，
  `tool_use.input` 清空（判据只用 `tool_result` 的启动回执与 `thinking` 的前 300 字，
  这两段完整保留）。路径 `/Users/zhourusheng` 替换为 `/home/dev` 脱敏。

**期望值（人工核过，不是从实现反推）**：

| 字段 | 值 | 为什么 |
| --- | --- | --- |
| `registered` | 6 | 10:25:04 一条（期限 10:55:04，已释放）+ 10:55:31 / 10:55:52 / 10:56:04 / 10:56:17 四条重挂 + 11:01:37 一条 |
| `maxConcurrentWaitsPerSubject` | 4 | 10:56:17–10:59:54 之间那 4 条同脚本等待同时活着（R1 之前无 `subjects`，按 `description` 归并） |
| `staleNotificationClaims` | 4 | 6 次启动回执里，4 次的下一个 thinking 前 300 字就声称「又被杀 / 等待期限到」；另 2 次没这么说 |

`staleNotificationClaims` 的期望值与方案 §7.3 的独立参考实现（读 `raw.jsonl` 的
`new_messages`）在 b0aa0f1e / ca8d7e5c / 543e0e73 三个会话上逐一对齐（4 / 2 / 1）。
