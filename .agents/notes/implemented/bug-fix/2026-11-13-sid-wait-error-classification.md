---
Status: implemented
Date: 2026-11-13
---
# sid-wait 的错误分类与输出上限：4 处缺陷一次修完

## 决定了什么

`packages/core/src/task/sid-wait.ts` 四处行为变更，都属于「退出条件不够确定」这一类：

1. **连续失败计数只在整轮成功后才清零**。原实现在 `getPull` 成功后立刻 `failures = 0`，
   于是 `check-runs` 端点持续失败（token 缺 Checks 读权限、GHE 未启用 checks API）时，
   计数每轮被打回 0，`failures >= maxFailures` 永远不成立 → 等待跑满 30 分钟期限。
   **这正好退化成该原语要消灭的「期限到才知道」**。现在清零只发生在 pull + check-runs
   都成功之后（`sid-wait.ts` 的 check-runs 成功分支）。
2. **4xx 是确定性拒绝，立即终态**。`extractHttpStatus` 从 `gh api` 的 stderr 里取
   `(HTTP 4xx)`，`onRestFailure` 命中即返回 `reason=rest-fatal` + `httpStatus`。
   修复前「PR 号打错」要等 3 次退避（默认 60s + 120s ≈ 3 分钟）才报出来。
3. **aborted 独立退出码 6**。原先复用 `REST_FAILED(5)`，导致脚本 `if [ $? -eq 5 ]`
   把「我主动停的」读成「网络挂了」。入口 kill 路径会短路这个码，它只对直接调用方有意义。
4. **失败检查逐条输出加上限 10 条 + 一行 `CHECK_FAILED_MORE` 汇总**。monitor 入口每行
   一条事件，全仓 CI 崩（几十个 job 同时 failure）会往上下文灌几十条通知；summary 本来
   就只提 3 项，两条通道口径现在一致。`result.failedChecks` 仍保留全部项。

## 放弃了什么（以及为什么不选）

- **failures 按 endpoint 分成两个计数器**。否决：`getPull` 失败与 `getCheckRuns` 失败
  混在一个计数器里确实丢失了「是哪个端点坏了」的区分，但「一次迭代内两个端点都成功」
  正是「连续失败」的自然定义，一个计数器 + 清零位置调整就能得到正确语义；两个计数器要
  改函数签名、两套 emit 文案，收益只是归因更细。归因可以靠 `REST_ERROR` 行里的 endpoint
  路径看出来，不必进状态。
- **4xx 复用 `rest-failed` 而不加新 reason**。否决：消费方（模型 / 脚本 / summary）
  无法区分「PR 不存在」和「网络断了」，而这两者的下一步动作完全不同（改 PR 号 vs 重试）。
  加一个 reason 值 + 一个可选字段成本很低。
- **给 4xx 单开一个退出码（如 7）**。否决：退出码集合刻意稀疏（跳过 2，因为 2 是 shell
  用法错误），新增码要同步 bash/monitor 启动回执、系统提示词、文档；而 4xx 与 REST 失败
  在消费方语义上都是「查不出状态」，用 `reason` 区分足够。
- **只把 404/401 当确定性拒绝，403 仍重试**。否决：403 在本仓的主要来源是 rate limit 和
  token 权限不足，两者的窗口都是小时级，30 分钟等待期内重试拿不到新配额或新权限；立即
  返回让模型早点去换 token 更有用。区分 403 是否 rate limit 要读响应头，当前 client 只拿
  stderr，做不到。
- **失败检查完全不 emit，只留 summary**。否决：bash 入口的 `.output` 是模型排查现场的
  唯一路径，完全不输出会让「哪几个 job 坏了」不可见。10 条 + 汇总行是折中。

## 拿什么证明它生效了

**修复前的一次性探针**（注入假 client，不联网）：

- `getPull` 成功 + `getCheckRuns` 持续失败：输出 12 行全是「连续 1/3」，`reason=aborted`，
  `checkCalls=12` —— 确认了缺陷 A 的现场。
- PR 不存在（stderr 带 `HTTP 404`）：`getPull` 调用 3 次，退避序列 `60000 + 120000`，
  总耗时 180 秒才拿到 `exit 5` —— 确认了缺陷 C 的现场。
- 50 个检查同时失败：emit 50 行 `CHECK_FAILED`，summary 只提 3 项 —— 确认了缺陷 B 的现场。

**修复后**：

```
$ bun test ./packages/core/tests/task/sid-wait-gh-pr.test.ts
 25 pass / 0 fail / 91 expect() calls
```

新增 5 个用例 + 1 处旧用例断言（「被取消」补 `exitCode === SID_WAIT_EXIT.ABORTED`）：
`check-runs 端点持续失败也要退出` / `check-runs 失败 2 次后恢复` / `4xx 是确定性拒绝` /
`5xx 仍按连续失败阈值退避` / `几十个检查同时失败时事件有上限`。

**变异自证**（4 处同时改坏 → 跑一次）：4 个用例同时变红，且红的正是对应的那 4 个：

```
(fail) check-runs 端点持续失败也要退出（计数不能被上一轮 getPull 成功清零）
(fail) 4xx 是确定性拒绝 → 立即终态，不做 3 次退避
(fail) 几十个检查同时失败时事件有上限（monitor 每行一条，不能刷屏）
(fail) 被取消 → 立即返回，不再打 REST
 21 pass / 4 fail
```

恢复后重跑 25 pass / 0 fail，并 `grep MUTATION` 确认无残留标记。

**其余门禁**：

```
bun run format          → Finished in 279ms on 3116 files
bun run lint            → Found 0 warnings and 0 errors（3148 files）
bun run format:check    → All matched files use the correct format
bun run typecheck:gate  → 当前 62 处错误 / 基线 62 处，无新增
bun run affected-tests:run → 484 pass / 0 fail（37 files, 30.28s）
make build              → 自检通过：关键修复已内联进二进制
```
