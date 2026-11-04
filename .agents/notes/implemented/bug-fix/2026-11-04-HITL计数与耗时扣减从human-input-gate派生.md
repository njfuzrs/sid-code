---
Status: implemented
Date: 2026-11-04
---
# HITL 的计数与耗时统一从 human-input-gate 派生，模型调用耗时不再计入人工等待

## 决定了什么

来源：会话 `20261103-213816-f5beebde` 复盘 F4（方案《20261104-会话 f5beebde 复盘-流迭代器泄漏与额度误判等六项-落地方案》§5）。

**一句话：把「在等人」这个事实的唯一登记点（`query/human-input-gate.ts`）变成 HITL 计数与耗时的唯一来源，并让 `api_duration_ms` 不再把等人时段算成模型耗时。**

1. **闸门新增进程级「HITL 区段数」**（`readHitlSegmentCount()`）：引用计数 0→1 的边沿 +1，只增不减。它回答「阻塞等人发生过几次」，与已有的 `humanInputWaitElapsedMs()`（累计时长）同源同步。
2. **`TurnComplete.had_hitl` 改为区段数差值**：`beginTurn()` 快照轮首值，`emitTurnComplete()` 与轮末值比较。**删除 `HITL_PROMPT_COUNT_KEY` / `recordHitlPrompt()` / `readHitlPromptCount()`** —— 此前那条路只覆盖权限弹窗，fallback 询问（`app.ts`）与 MCP elicitation 都让主循环阻塞等人却既不计数也不计时，消费侧想按 `had_hitl` 剔除样本时恰好剔不掉本方案那条 2.85h 的等待。
3. **`TurnComplete` 与 `AfterModel` 都加 `hitl_wait_ms`**：前者是本轮新增等待（`humanInputWaitElapsedMs()` 轮首快照差值），后者是本次模型调用期间新增等待。`had_hitl` 只能整轮剔除，`hitl_wait_ms` 让消费侧可以精确扣减（`e2e - hitl_wait_ms`），不必丢掉整个样本。
4. **`loop.ts` 的 `apiDuration` 扣除人工等待**：`perfHandle.start()` 同刻取 `humanInputWaitElapsedMs()` 快照，`perfHandle.end()` 后 `apiDuration = max(0, raw - delta)`。原始墙钟另记 `api_duration_raw_ms`，两个口径都不丢。落点是 AfterModel hook 载荷（`hook/types.ts` 加两个可选字段）→ `collector.ts` 的 `AfterModelRaw` / `AfterModel` events.jsonl。
5. **`tool-executor.ts` 把三路竞争整体包进 `withHumanInputWait`**，并删掉弹窗前的 `recordHitlPrompt(deps.sessionState)` 调用。这一条同时修掉一个方案未列出的缺口：**批量路径（`executeTools` → `resolveToolPermission`）此前没有任何闸门**，只有 `app.ts` 的抢跑路径包了 `withHumanInputWait`（方案 §5.3 假设「权限弹窗那条路径也走了闸门」，实测只对抢跑路径成立）。包在 `resolvePermission` 外层，两条路径自动同口径，异常也安全。
6. **`emitTimerDrift` 加 `during_hitl`**：`loop.ts` 的 turn_hard / watchdog 两个调用点在迟到检测处传 `isAwaitingHumanInput()`。digest 新增 `timer_drift_total` / `timer_drift_during_hitl` 并单独打印一行 —— 等人期间的迟到是宿主定时器补偿 / 事件循环让出的正常现象，与非等人期间的迟到混成一个数会把真正的性能问题稀释掉。
7. `TurnComplete` / `beginTurn` / `emitTurnComplete` **移除 `sessionState` 参数**：HITL 状态改由闸门持有，SessionState 上的第二套口径随之消失（不保留「参数留着但不用」，否则下一个人会以为还有第二份来源）。

## 放弃了什么（以及为什么不选）

- **只在 `userDecision` 回调里 `begin/end` 闸门**（把 HITL 缩到「真正弹窗」的那一段）。否决理由：三路竞争中 hook/classifier 胜出时，用户路径的 promise **永不 settle**（`async-decision.ts` 只做 resolve-once，不 cancel 用户弹窗），用它的 `finally` 闭合闸门会让闸门常开 —— 那会架空两个看门狗，比多记一个布尔危险得多。整体包裹的闭合点与 `resolvePermission` 返回严格配对。代价是 hook/classifier 抢先的几百毫秒也算半个区段；但既有 `recordHitlPrompt` 本来就在三路竞争**之前**调用（「进入 needsConfirmation 分支」即记），口径几乎未变。
- **继续在 `turn-complete.ts` 里保留 SessionState 计数，只额外补 fallback 询问的登记**。否决理由：那就是第二份口径，两处必然漂移；且 MCP elicitation 是第三个入口，补丁会一直加下去。
- **只在 digest 里按 `elapsed_ms > 1h` 剔除离群样本**。否决理由：阈值是猜的，且掩盖的是埋点口径错误，不是数据离群。
- **等待期间停掉 turn_hard / watchdog 定时器**。否决理由：两个定时器已在等待期跳过判定（`loop.ts` 的 `isAwaitingHumanInput()` 闸门），停表需要在等待结束时精确恢复剩余时长，引入的状态比扣减多得多。
- **给 AfterModel 载荷的 `api_duration_ms` 改名**（如 `api_duration_model_ms`）。否决理由：会打断所有既有 hook 消费者；用「改语义 + 新增 raw 字段」表达，注释与 Note 说明口径。
- **把 `hitl_wait_ms` 只在 > 0 时落字段**（仓库常见的「0 不占字段」风格）。否决理由：这个字段会被消费侧直接做减法（`e2e - hitl_wait_ms`），缺字段会逼他们写 `?? 0` 且分不清「没落盘」与「没等待」；有基准就落 0 更诚实。

## 拿什么证明它生效了

- **单测**（`packages/core/tests/query/human-input-gate.test.ts`、`turn-complete-e2e.test.ts`）：新增/改写 10 条，覆盖区段计数 0→1 边沿与嵌套不重复、`had_hitl` 差值语义、`hitl_wait_ms`、以及 `api_duration_ms + hitl_wait_ms = api_duration_raw_ms` 的恒等式。
  - `bun test ./packages/core/tests/query/turn-complete-e2e.test.ts ./packages/core/tests/query/human-input-gate.test.ts` → **34 pass / 0 fail**。
- **变异自证**（两条都实测变红后恢复）：
  1. 把 `const apiDuration = Math.max(0, apiDurationRaw - hitlWaitMs)` 改成 `= apiDurationRaw` 后，`F4 · api_duration 扣除人工等待 > api_duration_ms 扣掉等人时段…` **变红**（`Math.abs(raw - api - hitl) < 1` 失败）。
  2. 把 `const hadHitl = hitlNow > (state.hitlSegmentAtTurnStart ?? hitlNow)` 改成 `hitlNow > 0` 后，`上一条消息等待过、本条没等 → 本条 had_hitl === false` **变红**。
  - 恢复后重跑 34 pass / 0 fail，`grep MUTATION packages/core/src` 无残留。
- **选测全量**：`bun run affected-tests:run` → **2516 pass / 0 fail，205 files**（hook / query / trace 三个域）。
- **构建**：`make build` 通过，产物自检 5 项全绿（git-status 锚点、止损阀、内嵌 skill、ripgrep、review 子命令）。
- **静态门禁**：`lint` 0 warnings / 0 errors、`format:check` 全绿、`lint:boundary` 全绿、`lint:command-system` 四项通过、`lint:legacy-tool` 58/58、`typecheck:gate` 64/64 无新增。
- **参考页**：动了 `packages/core/src/hook/types.ts`，跑 `bun run docs:gen-reference`（生成 6 页 + llms.txt）；`git status` 无 `website/` 变更 —— 该类型不在参考页数据源的生成路径上，属预期。
- **未做端到端真实会话验证**（方案 §5.5 的轨迹验收）：需要一次「网关失败 → fallback 询问 → 用户隔很久才答」的真实会话；本 PR 只有单测与构建证据，端到端留待下一次同类会话用 trace-digest 核对（`AfterModel.elapsed_ms` 应接近 `fetch_sent → stream_completed` 的间隔，`TurnComplete.had_hitl = true`）。
