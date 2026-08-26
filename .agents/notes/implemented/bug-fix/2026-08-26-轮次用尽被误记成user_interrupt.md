---
Status: implemented
Date: 2026-08-26
---
# 轮次用尽被记成 `exit_status: user_interrupt` —— 而没有任何人中断过

## 决定了什么

给 `TraceCollector` 加一个 `recordMaxTurns()` 上报口，由 `query/engine.ts` 在收到
`max_turns` 事件时调用；收尾推断 `exit_status` 时**先判它**，落 `"max_turns"` 而不是掉进
`user_interrupt` 兜底桶。

成因是一个兜底桶吃掉了两种语义。轮次用尽走 `query/loop.ts:4810` 的
`yield { kind: "max_turns" }`，收尾 reason 是 `exit`；而此刻最后一次 `stop_reason` 是
`tool_use`（模型正想调下一个工具，只是被叫停了）。`collector.ts` 原来的判据是：

```ts
lastPair?.stop_reason === "end_turn" ? "end_turn" : "user_interrupt"
```

于是「预算耗尽」被记成「用户中断」。

**后果不是显示难看，是归因方向错了一步。** `trace/digest.ts` 把 `user_interrupt` 算进
`abnormal`，排查时读到的是"会话被中断"，真相是"轮次预算花完了" —— 这两件事的处置完全不同
（一个查中断源，一个调预算 / 查它为什么在绕圈）。实测 SWE-bench smoke-9 两条撞顶的题
都是这个形态：`exit_status=user_interrupt`，而 `grep -c 达到最大轮次限制` = 2。

配套改了三处消费侧，全部**只改归因、不改判据松紧**：

- `digest.ts` 两处 `abnormal` 名单加 `max_turns`。它**以前就被算作 abnormal**（那时被误记成
  `user_interrupt`），所以加进去是让 abnormal 总数保持不变；而预算耗尽确实不是干净收尾。
  两处必须同步 —— 会话列表标红、详情页不标，用户会以为自己挑错了会话。
- `digest.ts` 新增一条 L0 异常 `exit_status_max_turns`，与 `user_interrupt` 分开成两条：
  分开的意义在处置不同，混成一条时排查往错的方向走一步（smoke-9 就走错了）。
- **不进 `REAL_ERROR_KINDS`**（`collector.ts:1993`）：预算耗尽不是硬错误，
  塞进去会污染批量分诊的主键 `real_errors`。

## 放弃了什么（以及为什么不选）

**在 collector 内部推断，不新开上报口。** 否决 —— `max_turns` 是 queryLoop 的**控制流事实**，
它不在任何 hook 事件里。collector 只订阅 hook（BeforeModel / AfterModel / PostToolUse / SessionEnd…），
从这些事件里看不出"预算耗尽"与"模型还想调工具但被叫停"的区别。唯一能区分的地方就是 loop 里那个 yield。

**用「`stop_reason !== "end_turn"` 且轮数 >= maxTurns」这类代理判据。** 否决 ——
这正是本 bug 的成因（一个粗糙代理吃掉两种语义），换一个同样粗糙的代理只是把错误挪个位置。
判据必须是真实信号本身。同 CLAUDE.md 那条：判据优先级 **结构化信号 > 数字边界 > 裸子串**。

**埋在 `loop.ts` 里。** 否决 —— collector 的引用在 `deps` 上，`engine.ts` 是唯一
既拿得到它、又能看见 loop 全部 yield 的位置；loop 里要再穿一层依赖。

**另发一条 events.jsonl 事件。** 否决 —— `TurnComplete` 已经带了 `stop_reason: "max_turns"`
（`query/turn-complete.ts`），再写一条是重复记账。这里只更新收尾判据用的那一位状态。

**把 `max_turns` 从 `abnormal` 名单里摘掉**（"它不是错误"）。否决 ——
那会让 abnormal 总数**悄悄下降**，读起来像"异常变少了"，其实只是换了个桶。
本次只修归因，判据松紧一个字不动。

## 拿什么证明它生效了

`packages/core/tests/trace/collector.test.ts` 新增 5 条断言，**两轮变异自证**：

```
变异 A：把 max_turns 分支改回兜底桶（即 bug 原状）
  → (fail) 上报了 max_turns → exit_status 落 max_turns（哪怕末轮 stop_reason 是 tool_use）
  → (fail) max_turns 落进 session.traj（内存里有、落盘没有等于没采）
     82 pass / 2 fail

变异 B：无条件返回 max_turns（验反向自证抓不抓得住）
  → (fail) 正常收尾不受影响：end_turn 仍是 end_turn
  → 另外 3 条既有测试同时转红（正常会话 errors=0 / 不写 exit_attribution / Harness 回归）
     78 pass / 6 fail
```

第 2 条断言是**反向自证**（不上报 `max_turns` 时，同样的输入必须仍落 `user_interrupt`）——
没有它，一个无条件返回 `max_turns` 的实现也能让第 1 条通过。
这正是踩过的那个教训的适用场景：**`exit_status` 是个字符串，很容易写出一条
"断言它等于当前错误值"的假门禁**，把错误取值锁定成正确行为。变异 B 就是来证明这条没白写的。

另外两条覆盖优先级与落盘：
- `abort` 优先级更高（撞顶之后用户又按 Ctrl-C，该记的是中断）；
- 值要真的进 `session.traj` 的 metadata（内存里有、落盘没有 = 消费侧读不到，等于没采）。

全仓：`bun run test` → **11120 tests / 0 fail**；`lint` / `format` /
`docs:gen-reference --check` 全过；`bunx tsc --noEmit` 的 5 条 error 在 `git stash` 后同样存在（预先存在）。

**未做**：没有拿真实撞顶的 SWE-bench 轨迹复验（本次不跑评测，按安排留给下一棒）。
下一棒跑 smoke-10 时，撞顶那几题的 `exit_status` 应为 `max_turns` —— 若仍是 `user_interrupt`，
说明 `engine.ts` 那个上报点没被走到，而不是判据写错了。
