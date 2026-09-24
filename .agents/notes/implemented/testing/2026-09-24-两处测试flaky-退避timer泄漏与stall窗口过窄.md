---
Status: implemented
Date: 2026-09-24
---
# 两处 CI flaky：失败用例的退避 timer 泄漏，stall 用例窗口过窄

## 决定了什么

修了两个只在 CI ubuntu leg 偶发失败、本地重跑即绿的测试，都不改产品代码。

1. `packages/core/tests/analytics/http-exporter.test.ts` 的「发送失败时写入磁盘缓存」和
   「HTTP 非 2xx 视为失败」：两个用例让 `fetch` 失败，`HttpExporter` 会 `schedule` 一次
   `QuadraticBackoff` 重试，但用例结束从不 `shutdown()`。实测退避触发时刻是约 2ms、500ms、2500ms，
   用例自己只等 50ms，所以 2ms 那次被自己的 stub 吃掉，留下的 timer 在用例结束后约 450ms 才触发，
   打进后面已经换上 `fetch` stub 的用例。后面断言 `calls.length` 为精确值的用例窗口只有 20ms
   （line 181）和 80ms（line 283），本地落在窗口外所以复现不出，CI runner 慢时落进来就红，
   且红在哪一行取决于 timer 落进哪个窗口。断言之后补 `await exporter.shutdown()`，
   它只清 timer 和刷空批次，不删已落盘的 `failed_events` 文件。

2. `packages/core/tests/llm/provider-conformance.test.ts` 的「stall 告警触发」：stall 检测是
   `setInterval(stallWarnMs)` 心跳，回调必须在第二个事件刷新 `lastEventAt` 之前跑到才看得到 gap。
   用例两个事件只隔 120ms、阈值 80ms，余量 40ms，runner 负载高时回调被推迟到第二个事件之后，
   gap 归零、告警永不触发，断言收到 `null`。间隔拉到 400ms。

## 放弃了什么（以及为什么不选）

- **放宽 `calls.length` 的精确断言**（改成 `>= 1`）：掩盖的是泄漏而不是修掉它，而且 `calls.length === 0`
  的「稳定不发」用例（无凭据、明文非本地）同样会被这个 timer 打穿，放宽它们等于拆掉回归断言。
- **在 `afterEach` 里统一 `shutdown()`**：exporter 是用例局部变量，`afterEach` 拿不到；
  而且泄漏只来自这两条失败路径，其余用例的 timer 要么没 schedule、要么自己已经 shutdown。
- **把 stall 间隔只加到刚好超过一个心跳周期**（比如 160ms）：余量仍然是几十毫秒，
  在慢 runner 上还会再红一次。400ms 对 80ms 留了五个周期的余量，用例耗时仍可忽略。
- **改 `guardedStream` 的 stall 检测实现**：那是产品行为，这个用例测的就是「间隔超过阈值就告警」，
  实现本身没有 bug，是测试给的间隔太贴着阈值。

## 拿什么证明它生效了

- 退避触发时刻是实测的，不是读代码推的：单独跑一个 `QuadraticBackoff` 记 `Date.now()` 偏移，
  输出 `fire offsets ms = 2,503,2504`。
- 复刻「失败用例等 50ms 后换 stub 再开 20ms 窗口」的边界，本地连跑 5 次窗口内调用数都是 0，
  说明泄漏在本地确实落在窗口外——所以这个 flaky 不能靠本地重跑来证明已修好，
  只能靠「timer 被 shutdown 清掉」这条机制本身。
- `bun test ./packages/core/tests/analytics/ ./packages/core/tests/llm/`：1817 pass，0 fail。
- `make build`：编译通过，产物自检全绿。
- 归因核对：run 35947472562（#92）的失败日志是 `http-exporter.test.ts:181`，Expected 1 Received 7；
  run 35948408109（#91）的失败日志**不是** http-exporter（那次它全绿），而是
  `provider-conformance.test.ts:144` 的 stall 用例收到 `null`。两处对得上上面两条。
