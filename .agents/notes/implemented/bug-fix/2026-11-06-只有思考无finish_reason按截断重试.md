---
Status: implemented
Date: 2026-11-06
---
# OpenAI 族流「只有思考、没有 finish_reason」按上游截断重试，不再当成正常收尾

对应《评测接入 CI/CD》§6.6 **T16b**（T15 R3 的 T0007 / T0018 被当 infra 排除的根因）。

## 决定了什么

`packages/core/src/llm/openai.ts` 的 `parseSSE` 收尾处（`[DONE]` / EOF 共用出口之前）加一条判据，
**四条同时成立**才判截断：

- 没收到 `finish_reason`（`pendingFinishReason === null`）；
- 收到过 `reasoning_content`；
- 没开过正文块（`textBlockIndex === -1`）；
- 没有工具调用（`toolCalls.size === 0`）。

命中时抛 `StreamValidationError("no_finish_reason")`。provider 的外层 catch 对这个类型**原样重抛**，
不转成 error 事件：转成事件只剩 message，分类器认不出 `no_finish_reason`，会落进
`unrecognized` 并被同指纹封顶；抛出时 fallback 经 `normalizeThrown` → `validation` →
transient 族（已识别），走既有的流重开路径（`stream_restart`）。

根因（读 T15 run 产物得出）：两条的最后一次请求都是上游 stall 97–138s 后直接 `[DONE]`，
此前只下发过 reasoning_content。旧逻辑照常 `finishStream` → `stop_reason=null` →
`query/loop.ts` 落「未知停止原因」分支直接结束本轮 → harbor 记 `error_during_execution`。
`trace/collector.ts:1420` 的 `stop_reason ?? "end_turn"` 让 raw.jsonl 里显示成 `end_turn`，
这也是为什么从轨迹看不出它是截断。

## 放弃了什么（以及为什么不选）

- **所有「没有 finish_reason」都重试**：有的网关从不发 finish_reason，但正文完整。全部重试会让
  这类网关的每一轮都白跑一次。有正文或工具调用就说明回答已经成形，不在本判据范围（有反例测试钉住）。
- **在 `query/loop.ts` 的「未知停止原因」分支里重发请求**：那一层已经拿不到「这次流到底收到了什么」，
  只能靠 `contentBlocks` 猜；而且会绕开 fallback 的重试预算与退避，形成第二套重试出口
  （正是 fallback.ts I3 收敛掉的那种平行出口）。
- **改网关（harbor gateway）在 stall 后不发 `[DONE]`**：网关是透传，`[DONE]` 来自上游；
  而且 sid-code 用户走的是各自的网关，修在客户端才覆盖得到。
- **继续按 infra 排除**：这是可恢复的瞬态故障，客户端没恢复是 sid-code 的缺陷；排除会把它藏到分母外。

## 拿什么证明它生效了

- `bun test tests/llm/vcr/` → 47 pass / 0 fail。新增夹具 `deepseek-thinking-only-no-finish.json`
  （只有 reasoning_content + `[DONE]`）：断言抛 `StreamValidationError`、`reason === "no_finish_reason"`、
  `classifyFamily(normalizeThrown(e))` 为 `transient / no_finish_reason`。反例：`deepseek-reasoning-cache.json`
  （有正文）照常收尾，无 error。
- `tests/llm/fallback.test.ts` 新增：首次 attempt 只出思考就抛 → `calls === 2`、出现 `stream_restart`、
  无 error 事件、最终 `stop_reason === "end_turn"`。
- 变异自证：把判据首条改成 `false`，VCR 新用例变红（28 pass / 1 fail）。
- `bun test tests/llm tests/query tests/agent` → 4051 pass / 2 fail；那 2 条
  （`B5-6 门槛` / `PR-B frontmatter timeout`）在 main `087f2fb0` 上同样失败，与本改动无关。
- 本改动让 `stream-progress-snapshot-chokepoint.test.ts` 的「持续吐 reasoning_content 的慢流」
  红过一次：它的夹具只有思考、没有收尾帧，正好命中新判据。给夹具补 `finish_reason: "stop"` 收尾帧，
  该用例只测进展采样，与收尾判定无关。
- `bun run typecheck`：62 条 error，与 main 相同，均不在本次改动的文件里。
- ⚠️ 未做：真实网关上复现截断并观察重试生效（截断是偶发的，T15 96 次里出现 2 次）。
  T17 之后的下一轮基线里，若这两题不再出现 `error_during_execution`，即为线上证据。
