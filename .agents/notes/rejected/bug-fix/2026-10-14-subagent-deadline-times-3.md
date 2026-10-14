---
Status: rejected
Date: 2026-10-14
---
# 否决：子代理 deadlineAt 改成 `startTime + timeout × 3`

## 决定了什么

子代理不给漏斗传任何 `deadlineAt`（卡 B1）。总时长失控只由硬 kill（`timeout × HARD_KILL_MULTIPLIER`，扣休眠）兜底。

## 放弃了什么（以及为什么不选）

`× 3` 是最顺手的「折中」：deadline 和硬 kill 对齐，看起来两边都照顾到了。否决理由：

- 仍是「次数听时间的」：退避累计逼近截止时漏斗照样 `giveUp("deadline")`，`maxRetries` 照样形同虚设，只是晚一点出事。
  主循环 2026-10-12 去掉 deadlineAt 就是因为这个，子代理没有理由例外。
- 双处计时必漂移：硬 kill 定时器扣休眠，漏斗 deadline 用裸 `Date.now()` 差值不扣（事故里正是两套判据结论相反：一个说「还差 162s」，一个已经超时）。
  对齐两处只能靠人记着同步改。
- 硬 kill 已经能打断退避中的 sleep（`subagent-retry-no-deadline.test.ts` 硬 kill 组），deadline 不再承担任何独有职责。

## 拿什么证明它生效了

`subagent-retry-no-deadline.test.ts`：把任意形态的 `deadlineAt` 加回 `buildBaseLoopConfig`，「墙钟 2s 下 5 次尝试仍交付」一条红。
