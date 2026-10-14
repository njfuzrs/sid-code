---
Status: implemented
Date: 2026-10-14
---
# 子代理重试与墙钟解耦：去掉 deadlineAt、墙钟扣休眠、唤醒主动重开跨休眠请求

## 决定了什么

三张卡一起改「重试 / 超时 / 休眠」，互相依赖，必须一起验证：

- **B1** `sub-agent.ts buildBaseLoopConfig` 不再传 `deadlineAt: startTime + timeout`。P0-1(a) 之后墙钟 timeout 只是 detach
  （软返回点），把它当漏斗硬截止等于「次数听时间的」——事故里子代理第一次可重试错误就 `giveUp("deadline") attempts=1`，
  同一漏斗主循环能重试 10 次。现在三者各管一件：次数 → `maxRetries`；卡死 → 漏斗单次尝试上限
  （`LIFECYCLE_PRESETS.subAgent.overallTimeoutMs=180s`，扣休眠）；总时长失控 → 硬 kill（`timeout × HARD_KILL_MULTIPLIER`）。
  硬 kill 能打断退避中的 sleep。`loop.ts:2209` 过时注释同步更正。
- **B2** 子代理墙钟与硬 kill 定时器改用 `agent/sleep-aware-timer.ts` 的 `armSleepAwareTimer`：到点先查休眠账本，
  有效时长没到就重排而非开枪。两条路径（内置 / 自定义）共用同一函数，源码锚点测试禁止裸 `setTimeout` 回流。
- **C1** `shared/utils/sleep-detect.ts` 新增 `onWake` 订阅；`llm/fallback.ts` 在 attempt 期间订阅，**仅当 attempt 发起早于休眠开始**时
  以 `host-sleep-reopen` abort 并在固定 2s 网卡就绪等待后重开。旁路 `decideRecovery`：不计重试次数、不退避、不记 availability 失败；
  发 `host_sleep_reopen` 遥测，digest 与 `network_error` 分开计数。
- **G1 哨兵**：`tests/llm/subagent-attempt-timeout-sentinel.test.ts` 锁「子代理单次尝试上限 = 180s 且扣休眠」，
  防有人以为子代理没有首字节超时再叠一层。

## 放弃了什么（以及为什么不选）

- `deadlineAt = startTime + timeout × 3`：见 `rejected/bug-fix/2026-10-14-subagent-deadline-times-3.md`。
- 唤醒时 abort **所有**在飞请求：休眠之后才发出的请求是健康的，误杀会把一次休眠放大成一串重开。`sleepStartedAt` 取上界估计，只会少杀。
- 唤醒重开走 `decideRecovery`：会消耗为服务端故障准备的预算并触发退避 / 冷却，而休眠不是服务端故障。
- Anthropic 首字节 30–60s 超时：见 `rejected/architecture/2026-10-14-anthropic-first-byte-30-60s-timeout.md`。

## 拿什么证明它生效了

- `tests/agent/subagent-retry-no-deadline.test.ts`：墙钟 2s、前 4 次 `Connection error.` 第 5 次成功 → 交付成功、`calls=5`、
  无 `giveUpReason=deadline`。变异：把 `deadlineAt: startTime + timeout` 加回 → 红（已跑）。硬 kill 组：退避 base 60s 时在 `timeout×3` 附近结束。
- `tests/agent/sleep-aware-timer.test.ts`：300s 墙钟、第 200s 注入 181s 休眠，挂钟 300s 不开枪、有效满 300s 才开枪；无休眠准点开枪（负向对照）。
- `tests/llm/host-sleep-reopen.test.ts`：休眠前发起的 attempt 被 `host_sleep_reopen` 中断、约 2s 后重开成功、重试计数 0；
  反例：休眠后发起的 attempt 不被中断。变异：去掉「attempt 早于休眠」判据 → 反例红（反例 provider 必须响应 abort 且先查 `signal.aborted`，
  否则同步 abort 漏看——调试时踩过一次，变异仍绿）。
- **未做**：真机 `pmset sleepnow` e2e（卡 C1 验收 4 / §5 整体验收 1）。按 CLAUDE.md 泡制道，发 beta 后自跑一段含子代理的真实任务再 promote。
