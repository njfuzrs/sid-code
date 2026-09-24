---
Status: implemented
Date: 2026-09-24
---

# http-exporter 鉴权组按 url 过滤 fetch 记录，不再裸数全局调用次数

## 决定了什么

CI ubuntu leg 连续红在 `http-exporter.test.ts:187`（`有设备凭据时带 Bearer`），
`Expected: 1`、`Received: 4`（main `710ef7dd`）与 `Received: 7`（本分支）。
本地全量 `bun test` 12557 pass 复现不了。

`stubFetch` 把 `globalThis.fetch` 整个换掉，而 `calls` 数的是**这个进程里所有**
经过全局 fetch 的请求。bun test 同批多文件跑在同一进程，别的测试文件留下的定时器
（心跳 / 退避重试 / 轮询）会在本用例那 20ms 等待窗口里打到 stub 上，把
`calls.length === 1` 顶成任意值。

改成记 `{url, headers}` 并提供 `to(url)` 过滤器，十处断言全部按本 exporter 自己的
endpoint 过滤。断言问的才是它本来要问的那件事：**这个 exporter 自己发了几次**。

顺带更正了 `b87f472e` 留在文件里的错误归因注释（它把成因写成「本文件的 timer 泄漏」）。

## 放弃了什么（以及为什么不选）

- **再补一次 `shutdown()` / 加大等待窗口**。`b87f472e` 就是这条路，补完仍然红。
  探针证伪：失败 flush 后 `shutdown()`，再换计数 stub 等 120ms，偷跑次数 **0**。
  因为退避 timer 到期走 `retryFromDisk` → `retryPreviousBatches`，而后者
  **排除自己的 batchUUID**（`disk-cache.ts:66`），扫不到文件，一次 fetch 都不发。
  也就是说那个 timer 根本发不出请求，它不可能是成因。加大窗口只会让外来流量更多。
- **给 `QuadraticBackoff` 加一个「测试模式」开关**。为测试改生产代码的行为，
  而且这里生产代码没有错 —— 错的是断言口径。
- **`--test-name-pattern` 把这条跳过 / 标 flaky**。它测的是真契约（设备凭据优先于
  静态 authHeader），不该被跳过；跳过还会把「断言太宽」这个问题留给下一个人。
- **给 stub 加一层「只认本 exporter」的包装**（记 exporter 名）。`fetch` 的入参里
  没有 exporter 身份，只能靠 url，绕一圈还是 url。

## 拿什么证明它生效了

**先证伪 `b87f472e` 的假设**（临时探针，已删）：失败 flush 后 `shutdown()`，换计数
stub 等 120ms —— `shutdown 后被偷跑的 fetch 次数 = 0`。所以那次修的机制产不出这个症状。

**再复现真成因并验证新口径扛得住**（临时探针，已删）：`setInterval` 每 3ms 往
另一个 endpoint 打一次，模拟外来 timer，在同一个 20ms 窗口里跑本用例：

```
全部 fetch = 6，本 exporter 自己的 = 1
```

裸数 `all.length` = 6（正是 CI 的 `Received: 4` / `7` 形态），按 url 过滤 = 1。
即：旧口径在这个条件下必红，新口径不动。这条探针同时充当变异自证 —— 把过滤去掉
就会红。

```
bun test packages/core/tests/analytics/                              # 128 pass, 0 fail
bun test packages/core/tests/analytics/ telemetry/ trace/            # 1168 pass, 0 fail
bun test                                                             # 见下
bun run lint && bun run format:check                                 # 均通过
```

本地全量 `bun test` 本来就是绿的（修前 12557 pass / 1 fail，那 1 条是无关的
`WorktreeManager` 用例撞了 406s 超时），所以**本地全绿不能证明这条修好了** ——
能证明的是上面那条「注入外来流量」的探针。真正的判据在 CI ubuntu leg 连续绿。
