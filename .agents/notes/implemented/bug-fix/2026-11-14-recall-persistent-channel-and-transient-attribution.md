---
Status: implemented
Date: 2026-11-14
Source: cost 面板数据失真与辅助调用漏账-排查修复与验收方案（2026-11-14）
---
# 语义召回改走 persistent 通道，并为 transient 丢弃补上归因

## 决定了什么

两件事，同属「召回注入通道选错」这一个根因，因此合成一个 PR：

1. **语义召回从 transient 改走 persistent**（`packages/core/src/query/loop.ts`）。
   `reminderParts.push(recalled)` → `persistentReminderParts.push(recalled)`，
   与 D9 的 MCP instructions、IDE 上下文增量同一口径。修前召回内容只进发送副本
   （`query/reminder-inject.ts` 打 `transient: true`），活不过本条用户消息的**第 1 次**
   请求：工具循环第 2 次请求起模型看不到它，该条 user 消息尾部少一整块 → 前缀在此断裂。

2. **字节探针补 `transient_dropped` 归因**（`trace/prefix-break-probe.ts` +
   `trace/collector.ts`）。指纹的 message 段新增 `transientBlocks` 计数（只活到相邻两轮
   比较完，不落盘）；断点所在的同一条消息若「上一轮有 transient 块、这一轮没有」，
   `prefix_break.cause` 记 `["transient_dropped"]` 而不是 `["none_local"]`。
   优先级为：主循环上报的具体原因 > `transient_dropped` > `none_local`；未上报时仍然缺失
   字段（`transient_dropped` 不依赖上报，子代理路径同样生效）。

## 放弃了什么（以及为什么不选）

| 方案 | 否决理由 |
| --- | --- |
| ② 保持 transient，但本轮每次请求都重注入 | 去重语义要改成「按轮」，实现更复杂；下一轮照样丢；`alreadySurfaced` 与 `RECALL_SESSION_MAX_BYTES` 这两处假设仍是错的，只是把丢失推迟一条消息 |
| ③ 保持 transient，去掉去重 | 不解决「一轮之内」的丢失（工具循环里模型依然看不到）；召回是对每条用户消息做一次 sideQuery，去掉去重会把辅助调用次数与费用乘上轮数，直接违背「更省」 |
| 让归因只认主循环上报（不做 `transient_dropped`） | 这类断裂的上报值恰好是空数组（ContextManager 确实没改写），于是永远记 `none_local` —— 已知的本地行为被记成「本地没有原因」，CP-9 的空白就还在 |

**接受的代价**：召回内容留在历史里，上下文占用增加，上限是每个压缩周期
`RECALL_SESSION_MAX_BYTES` = 60KB（约 15–20k token）。这笔占用绝大部分会命中缓存
（它落在那条 user 消息里，之后每轮原样重放），所以换来的是「更准 + 前缀稳定」。
这是有意的行为变更：召回从「一次性提示」变成「会话内长期上下文」。

另一个取舍：`transient_dropped` 会覆盖**所有** transient 块被丢弃的情形（ambient reminder、
todo 回注等），不只是召回。这是刻意的 —— 探针只判「同一条消息上的 transient 块没了」，
不判是哪一种；判据越窄越容易漏，而这里的目标正是「别再把已知本地行为记成未知」。

## 拿什么证明它生效了

**变异自证**（两处都做过，均已恢复）：

- 把 `persistentReminderParts.push(recalled)` 改回 `reminderParts.push(recalled)` →
  `bun test ./packages/core/tests/query/recall-persistent-channel.test.ts` **3 fail**：
  第 2、3 轮缺召回块、ctxMgr 历史没有召回、`prefix_break` 第 2、3 次 `broken=true`。
- 把 `transientDropped` 判据改成恒 `false` →
  `bun test ./packages/core/tests/trace/prefix-break-cause.test.ts` **2 fail**：
  归因退回 `["none_local"]` / 字段缺失。

**门禁**（worktree，基于 origin/main `a44d9809`）：

- `bun run affected-tests:run` → **2495 pass / 0 fail**（208 files，14.92s）
- `bun test` 新增/改动的两个文件单跑 → 11 pass / 0 fail
- `make build` → 成功
- `bun run smoke` → 通过（本次改了主循环注入通道，属 G2 覆盖范围）
- `bun run lint` / `bun run format:check` / `bun run typecheck:gate` → 通过

**新增回归**：

- `packages/core/tests/query/recall-persistent-channel.test.ts`：驱动**真实 queryLoop**
  连发 3 次工具循环请求，断言召回块每次都在 `messages[0]`、ctxMgr 历史里有、且字节探针对
  第 2、3 次都报 `broken=false`（方案文档 D1）。
- `packages/core/tests/trace/prefix-break-cause.test.ts` 新增 4 条：`transient_dropped`
  的阳性、两侧都有 transient 时不算丢弃、主循环上报优先、未上报时仍能落
  `transient_dropped`（方案文档 B13 的 G1 部分）。

**未覆盖（维护者本机）**：D3 端到端（`sc-dev` 带召回的会话）与 D4 指标回归
（「召回开启的会话第 2 次请求 `none_local` 断裂」基线 36 会话 / 17 次应降到 0）。
这两条依赖真实轨迹，agent 侧无法离线复现。
