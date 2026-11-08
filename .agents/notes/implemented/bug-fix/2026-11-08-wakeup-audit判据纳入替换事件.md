---
Status: implemented
Date: 2026-11-08
---
# wakeup-audit 判据纳入 ScheduledReplace：修复后会话不再被误判 stale / pending

## 决定了什么

`scripts/wakeup-audit.ts` 的两套 stale 判据与 `max_pending_wakeups` 都隐含一个**旧实现的假设**：
「每个 `schedule_wakeup` create 恰好会 fire 一次」。F1（单链替换）打破了这个假设——被替换的
任务永不 fire，于是它仍然占着 create 序号、仍然被算作 pending。后果不是数字差一点，而是
**方案 §5.4 定义的两条验收线在修复后永远无法通过**，任何人照它验收都会得出「修复无效」的
反向结论。

修法：`ScheduledReplace.replaced_count` 同时参与三处推演——

- 「有效 create 序列」减去被替换数，`stale` / `stale_literal` 只按仍可能 fire 的 create 配对；
- `pending` 减去被替换数，峰值反映真实并存数；
- `wakeup_replaced` 也走同一个 clamp 函数（原本的裸 `typeof number` 会让一条负数脏数据把
  合集统计压成负值）。

`replaced_count` 缺失 / 非字符串 / 负数一律按 0 计，且减完 clamp 到 0——负的 `createSeq` 会让
`fireIdx < createSeq - 1` 恒假，是**静默少报**，比报错更难发现。

顺序前提（已由源码保证，写在注释里）：`ScheduledReplace` 由 `replaceSessionTasksByOrigin`
在工具返回之前发出，因此在 events.jsonl 里必然排在对应的 `PostToolUse(schedule_wakeup)` 之前，
先减后加，峰值不会被新任务的 +1 顶高。

## 放弃了什么（以及为什么不选）

**在脚本里按 task_id 精确配对，而不是按序号。** 这才是语义上最干净的判据，但
`PostToolUse` 事件里只有 `tool_name` / `tool_use_id`，**没有 task_id**——create 侧的 id 在轨迹里
根本不存在，无法配对。所以只能继续用「序号 + 替换修正」这个近似口径。

**让新会话的 `max_pending=2` 也算达标（放宽验收线）。** 不选：`max_pending ≤ 1` 是 F1 的
核心承诺，放宽它等于把验收项作废。真正错的是脚本口径，不是验收线。

**只修 `max_pending`，不修 `stale`。** 不选：只修一半会让修复后的会话从「两条不达标」变成
「一条不达标」，仍然指向错误结论。两处同源，必须一起改。

**在旧会话上重算历史数字。** 不选：旧轨迹没有 `ScheduledReplace` 事件，代码路径天然不进入
新增分支，数字逐字不变——这一点由单测锁住（`ff96d1f2` 的 `5/5/stale=3/max_pending=4`），
防止以后有人为了「让新会话好看」而改动历史口径。

## 拿什么证明它生效了

**真实轨迹**（`bun run scripts/wakeup-audit.ts --all`，7 个会话）：

```
20261107-095213-ff96d1f2: create=5 fire=5 stale=3(literal 3) replaced=0 dropped=0 max_pending=4   ← 旧口径逐字未变
20261108-112039-9e3a681d: create=2 fire=1 stale=0(literal 0) replaced=1 dropped=0 max_pending=1   ← 修复后，达标
```

`9e3a681d` 的真实事件序列是 `create(5b7e7729) → ScheduledReplace(5e6b9688 替换它) →
create(5e6b9688) → fire(5e6b9688)`：一次替换、一次 fire、零多余唤醒。修复前脚本给出
`stale=1 / max_pending=2`，修复后 `0 / 1`。`replaced=1` 同时是 F1 在真实轨迹上的第一次正向验证。

**单测**（`tests/scripts/wakeup-audit.test.ts`，7 例全绿，`bun test ./tests/scripts/` 532 pass）：

- 旧会话口径不变：`create→fire→create→fire` 无 stale；积压形态 `5 create/5 fire` 得 `stale=3/峰值=4`；
- Replace 参与推演：真实序列得 `0/1`；连续两次替换峰值仍 1；被替换的 create 不再占序号
  （同一组事件去掉 Replace 事件则仍判 `stale=1/峰值=2`，证明断言真的在判而不是恒过）；
- 异常值：缺 count / 非数字 / 负数按 0；count 大于 pending 时 clamp 不产生负峰值。

**变异自证**：删掉三处 `ScheduledReplace` 处理（等价修复前口径）后 **3 例变红**，报错正是
`stale` 0→1、`max_pending` 1→3；恢复后 7 例全绿。

**门禁**：`make build` 成功且产物自检 5 项全过；`lint` / `format:check` / `lint:boundary` /
`lint:command-system` / `lint:legacy-tool` / `typecheck:gate` 全绿。

**没做到的**：本机全量 `bun test` 未跑完（worktree 里 `affected-tests` 因未跟踪的 `node_modules`
假判 full，全量前台超 600s 被中止），覆盖依赖 CI 的合并前全量。改动只在 `scripts/` 域，
`scripts/wakeup-audit.ts` 无其它测试引用（已 grep 确认）。
