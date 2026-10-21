---
Status: implemented
Date: 2026-10-21
---
# 账本在每次入账后节流刷新；digest 取较新的成本源；abort 后被丢下的 fetch 在会话收尾补记

## 决定了什么

来源是会话 `20261020-110542-ce7ea52e` 评估的发现 8、13（PR G）。

**发现 8（账本只在 done 刷新）**，回源码核实成立（刷新点 `app.ts:10035` 的 done 与退出路径；`app.ts:7603` 注释写「每轮」与实现不符；digest `ledger?.costUSD ?? meta.total_cost_usd` 账本无条件优先）。
- `session/state.ts`：`updateUsage` / `addSideCost` 之后通知一个入账观察者，并递增入账版本号 `getUsageVersion()`。挂在这里而不是 loop 的 AfterModel：主循环、子代理 usage-sink、side-call 三条入账路都汇到这两个方法，挂在任一消费侧只覆盖一条。
- 新增 `telemetry/ledger-flush-throttle.ts`：纯函数 `shouldFlushLedger` + `LedgerFlushThrottle`。判据：无新入账不刷；从未刷过有入账就刷；成本增量 ≥ $0.1 或距上次 ≥ 30s 即刷。
- `cli/src/app.ts`：构造 SessionState 后挂观察者走节流刷新；`flushSessionLedgerIncremental` 自上次刷新无新入账时跳过；onUserInput 内层 `finally` 强刷一次（覆盖 abort 与异常）；`/clear` 换会话时 reset 节流；修正两处注释。
- `trace/digest.ts` 新增 `resolveDigestCost`：比较账本 `ts` 与 traj 元数据 `snapshot_at`，取较新的那个（1 秒内视为同时，取账本），首行标注取数源。

**发现 13（abort 漏记一条 BilledRequest）**，核实成立但根因与文档不同：provider 的 `finally` 本来就会在 abort 时发 BilledRequest，问题是 index 1316 的生成器在 abort 后被丢下、再没人驱动，`finally` 一次都没跑。events 里 HttpConnected 1359、BilledRequest 1358，唯一缺口就是这一条。
- `llm/billing-sink.ts`：`markFetchInFlight` / `flushInFlightBilledRequests`；`recordBilledRequest` 进入即注销在途；`BilledRequest.reason?: "aborted"` 落盘。
- provider 三条流式路径（openai parseSSE、Responses，anthropic 流式）在生成 fetchId 后登记在途。已核：登记点与对应 `try/finally` 之间没有会抛错或 await 的语句，不会给没建连的 fetch 补出假记录。
- `trace/collector.ts` `handleSessionEnd` 在 `resetStreamObserver` 之前补记。
- digest 计费恒等式把有 `reason:"aborted"` 补记的算进已计费，新增 `abortedBilledRequests` 字段；没有配对的仍判漏计。

## 放弃了什么（以及为什么不选）

- **在 abort 当下补记**：abort 之后生成器仍可能被正常 return，届时真实 usage 才到；提前补记会让带真实 usage 的那条被 fetchId 去重吃掉。所以只在会话收尾（之后不会再有东西驱动它）补。
- **按成本判「脏」**（子任务初版）：本地 provider（ollama 等）成本恒为 0，强刷路径会永远跳过，账本行再也写不进去，而改前 done 是无条件写的。改为入账版本号判脏，成本只决定要不要提前刷。
- **每次入账都写账本**：`upsertUsageLedger` 是全量重写，不节流就是每次 fetch 一次全量 IO。
- **挂在 loop 的 AfterModel**：只覆盖主循环一条入账路，子代理和 side-call 的钱照样滞后。
- **非流式路径登记在途**：它的收口在同一个 try/finally 里，不存在生成器被丢下的情形。

## 拿什么证明它生效了

- `ledger-flush-throttle.test.ts` 13 条（判据、零成本 provider、观察者两条路、端到端「多轮不经 done 后 abort 账本已更新」、零成本强刷落行、app.ts 接线源码断言）；`digest-cost-source.test.ts` 5 条（第一条用 ce7ea52e 的真实数字）；`billing-identity-real-trace.test.ts` 追加 6 条。测试落盘隔离到 tmpdir（`SID_CONFIG_DIR`、`SID_CODE_USAGE_LEDGER` 存/恢复原值）。
- 变异自证 12 处均变红：删节流增量分支、删「无新入账不刷」、`addSideCost` 不通知、不注销在途、补记不带 reason、collector 不调补记、digest 恢复账本无条件优先、删 `abortedBilledRequests`、删 finally 强刷、版本不递增、isDirty 恒假、判据不看版本。
- trace + telemetry + session 目录、引用改动模块的文件与 llm 目录合计 3840 pass / 0 fail（子任务实跑）。
- `trace-digest.ts 20261020-110542-ce7ea52e` 首行为「成本 $11.1984（账本）」。注意这个数现在改前也能读到：该会话后来在 SessionEnd 时刷过一次账本。$0.17 只出现在那之前的 11 小时窗口，修复的价值在这段窗口。
- 局限：补记的 usage 只有收尾时已聚合的部分。1316 那次 usage 一直没回来，补记是 0 token：恒等式对上了，钱仍少一笔，只是「漏了」现在可见。真实金额仍要靠 `pricing-reconcile` 对账单。app 层未用 sc-dev 端到端跑。
- 发版说明要写：长会话成本曲线会上移；账本写入频率上升（节流后每会话每分钟约 2 次全量重写）。
