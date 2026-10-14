---
Status: implemented
Date: 2026-10-14
---
# 子代理失败归因：漏斗放弃证据优先于「墙钟到点」，建议按错误族给

## 决定了什么

旧判据 `isTimeout = detached || hardKilled`（四处出口同型）：墙钟到点只置 `detached=true`，此后不管子代理因为什么失败
都报「达到墙钟预算」，漏斗给出的 `recovery_give_up` 真因被丢掉。事故里真因是「休眠 → 连接断 → 重试预算被吃光」。

- `salvage.ts classifySubAgentFailure`（四处出口共用）优先级：外层 abort → `aborted`；硬 kill → `timeout`；
  漏斗放弃证据（`giveUp.{reason,family,attempts,lastError}`，由 `runAgentLoop` 结果对象结构化带出，不拼字符串）→ `error`；
  只有无更具体原因且 detached 时才 `timeout` / `detached`。
- 残卷：生命周期内休眠账本有增量时追加 `<host-sleep>`（「期间系统休眠 Ns，休眠会断开网络连接，这不是网关或模型故障」）；
  建议按错误族（transient/network → 可直接重派；rate_limit → 稍后重试；auth → 检查凭证；context_overflow → 缩小范围）；
  「停在读懂上下文」只在 timeout/detached、无具体错误且非只读子代理时给（explore/plan 零改动是必然）。
- `error-messages.ts subagent_failed` 兜底改为「子代理执行失败，详见上方 partial-result 中的原因」，不再猜「模型是否可用」。
- `<progress>` 显式口径 `input/output/cache_read/cache_creation`；无 usage 时属性名写 `input_output_tokens`，不再有裸 `tokens=`
  （事故里 `tokens="4136"` 比实际消耗小约 70 倍）。

## 放弃了什么（以及为什么不选）

- **只改文案**：判据还是 `detached || hardKilled`，下一个故障类型照样被说成超时。
- **在 `subagent_failed` 里按错误码猜建议**：那一层拿不到漏斗证据，猜错就是本次的「检查模型是否可用」。建议只在有证据的 salvage 层给。

## 拿什么证明它生效了

- `tests/agent/salvage.test.ts`「D1 classifySubAgentFailure + 建议文案（表驱动）」覆盖 detached × hardKilled × giveUp 证据 × 休眠 × 子代理类型，
  含事故组（detached、giveUp=deadline/transient、休眠 181s、explore）：`reason=error`，含「网络连接中断」与休眠说明，
  不含「墙钟预算」「读懂上下文」「模型是否可用」。变异：退回 `detached || hardKilled` → 红。
- 「D1 回放」组：事故三个 explore 子代理的脱敏 fixture（turns / usage / 放弃证据 / 休眠 181s），断言输出文案。
