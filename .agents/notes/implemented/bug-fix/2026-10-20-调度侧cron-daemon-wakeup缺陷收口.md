---
Status: implemented
Date: 2026-10-20
---
# 调度侧（cron / daemon / wakeup）十一条缺陷收口：解析器严格化 + 跳段扫描 + 队列背压

## 决定了什么

对照 docs-research `20260927-编排与调度-顺着sc-16核出的缺陷.md` 第二部分与 P1-9 / P3-2，
先回源码逐条复跑复现脚本，再修仍成立的项：

- **已被 B43（#160）修掉、本次只补门禁/尾巴**：P0-5（`lock.ts` 已 mkdir、写盘与驱动权解耦）、
  P1-6（每轮 `updateDriving` 复检 daemon）、P2-4（`writeAtomic` + 损坏时抛错不覆盖）。
  P2-4 剩一处：损坏时 `cron_list` 仍显示「没有任务」→ 新增 `Scheduler.durableReadErrors()`，
  `cron_list` 明说读取失败并 `isError`。
- **P2-1**：`a/n` 按 crontab(5) 展开为 `a-max/n`（`5/10` = 5,15,…,55）。
- **P2-2**：范围端点越界一律抛 `无效范围`，删掉循环里的 `continue` 静默截断。
- **P1-5**：`computeNextCronRun` 改为「月 → 日 → 时 → 分」逐级跳段（仍用本地时间字段，保住 DST 语义），
  永不匹配表达式 70ms → <1ms；`cron_create` 对 `computeNextCronRun === null` 的表达式拒绝创建。
- **P1-4**：新增 `computePrevCronRun` 反向跳段扫描，`computeLatestMissedRun` 改用它，不再受 `maxRuns` 前向截断。
- **P2-3**：`getScheduler` 兜底实例打标记；带 opts 的调用替换它并迁移会话级任务，兜底路径 `warn` 一次。
- **P2-5**：`describeTaskSchedule` / `fireAtToHuman`，`cron_list` 与 `/loop` 列表对 `fireAt` 任务显示触发时刻；
  会话持续忙碌导致到期任务推迟 ≥5 分钟时每段忙碌期告警一次。（持久化校验接受 `fireAt` 已由 B43 修掉。）
- **P1-9**：daemon 队列对周期任务按 `task.id` 折叠为最新一次；一次性任务保留「不丢」；总上限 100（`maxQueueLength`），超限丢弃本次并 `error`。
- **P3-2**：`parseIntervalToSeconds` 用单个有序正则 `h?m?s?`，拒绝 `5m5m` / `3m2h`；
  `IntervalParseResult` 增加 `effectiveSeconds`，`/loop` 文案用它并在发生取整时明说。

## 放弃了什么（以及为什么不选）

- **P1-5 只加可满足性检查、不改扫描算法**：拒掉。磁盘上已有的永不匹配任务（手写 json / 旧版本建的）
  在 daemon catch-up 里仍会每个付 70ms，修入口不修求值等于只挡新增。
- **P1-4 给 `computeMissedRuns` 加 `truncated` 返回值**：它的唯一生产调用方就是 `computeLatestMissedRun`，
  改成反向扫描后没有消费者需要截断标记，加了是死字段；只在注释里写明截断方向。
- **P1-4 / P1-5 改成 UTC 毫秒算术**：拒掉，附录 A.3 明确这是 DST 正确性的来源。
  跳段仍用 `setDate/setHours`，并在 setter 方向异常时退回 ±1 分钟保证单调。
- **P1-9 按 jobId 去重**：jobId 带随机后缀，永远不等；也不想去掉随机后缀（落盘/审计需要唯一 id）。
- **P1-9 队列满时丢最旧**：一次性任务的「不丢」语义要求先来的不被挤掉；周期任务已经折叠，满队列只会是一次性任务或大量不同任务，丢本次 + error 日志更可预期。
- **P2-3 兜底时不缓存实例（每次现造）**：兜底期间建的会话级任务会落在临时实例上直接丢失，比现状更糟；选「替换 + 迁移」。

## 拿什么证明它生效了

- 复现脚本（指向 worktree 源码）修复前 → 后：
  `5/10` `[5]` → `[5,15,…,55]`；`1-99` ACCEPTED → `无效范围`；
  每分钟任务停机 26 天 latest `09-07 22:40` → `09-27 00:00`；
  `0 0 30 2 *` 74ms → 1ms；兜底单例 `real === early` true → false、fired `[]` → `["test-prompt"]`；
  daemon 40 次到期 `queue.length=38` → `1`；`5m5m` 600s → null。
- 新解析器与旧逐分钟暴力扫描对拍：12 个表达式 × 40 个随机起点，next + prev 共 960 次，
  `TZ=Asia/Shanghai` 与 `TZ=America/New_York` 均 `mismatches=0`。
- 新增 `packages/core/tests/cron/scheduling-defects-20260927.test.ts`、
  `packages/core/tests/daemon/daemon-queue-backpressure.test.ts`、`loop-every.test.ts` 一条；
  12 处变异（把每个修复改回原样）逐一跑，**12/12 对应断言变红**。
- `bun run affected-tests:run`：3900 pass / 0 fail；`make build` 自检通过；
  lint / format:check / lint:boundary / lint:command-system / typecheck:gate（66/66 无新增）全绿。
