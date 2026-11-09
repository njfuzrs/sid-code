---
Status: implemented
Date: 2026-11-09
---
# todo_write 的唤醒撤销改成主会话专属，并把 blocked 从「已完成」里拿出来

## 决定了什么

两处行为改动，落在 `packages/core/src/tool/todo-write.ts`（外加 `packages/cli/src/cli.ts` 一行注册）：

1. **D6：撤销资格由构造选项决定，默认关闭**。新增 `TodoWriteToolOptions.invalidatesWakeups`（默认 `false`），
   只有主会话注册点 `cli/src/cli.ts` 传 `true`；`agent/sub-agent.ts` 给每个子代理构造的独立实例保持默认、不传参。
   根因不是「清单没隔离」——清单早就隔离了（P1-2）——而是 `invalidateWakeups` 动的是**进程级全局状态**
   （`wait-registry.ts` 的 `explicitWaits` + 全局调度器），它不区分调用方是谁：隔离了清单，没隔离副作用。
2. **D7：S1 判据从「没有 pending / in_progress」改成「所有项都是 completed」**（复用已有的 `allDone`）。
   `blocked` 的语义是「等用户 / 外部系统」，事没做完，把它算成已完成会让「提完 PR、等 CI」这个
   `todo_write` 工具描述亲自教会的正确用法撤销掉刚排好的唤醒。`unfinishedBefore` 同步改用新增的
   `countOpenItems`（非 completed 都算）。原 `countUnfinishedItems` 删除——它唯一的调用点就是被替换的
   S1 判据，留着是死代码；它的催办口径（与 todo-reminder 的 `countUnfinished` 同源、**不能**用于 S1）
   写进 `countOpenItems` 的注释里，防止下次又有人把两个语义合回去。
3. **附带（服务于 D7 补充证据）**：撤销真的发生时（`invalidateWakeups` 返回非空），全完成分支的工具返回值
   追加一句「唤醒已撤销，若仍需等待请重新 schedule_wakeup」。理由：撤销是全局副作用，用户侧的常驻提示
   （D9）不在本 PR 范围，模型侧则完全看不到——同轮「清零 → 又写回新清单」的实测形态（`8a3b2af5` 5→0→9）
   里它根本不知道自己已经不会被叫醒。

缺陷来源：`docs-research/sid-code/bugfixes/todo/20261109-等待态四PR合入后review缺陷-修复与验收方案.md`
§3.2 D6 / D7，附录 A 的 R4 / R5 复现已迁进仓内测试并把断言反转为期望行为。

## 放弃了什么（以及为什么不选）

- **在 `execute` 里用 `ToolUseContext.agentId` 判断调用方**（方案文档已否决，这里补一条实施期证据）：
  `TodoWriteTool.execute(input, _signal?)` 不带 context（`task-stop.ts` 同款），要判就得改 `LegacyTool`
  接口，波及面远大于本缺陷。构造选项的事实源在**注册点**（谁知道自己是主会话，谁自己传），不在调用链上。
- **默认 `true`、让子代理显式传 `false`**：以后新增任何隔离实例（又一个后台执行器 / workflow 内的工具池）
  忘了传参，D6 就以新形态复发。默认 `false` 时最坏是「少撤销一次」，退回改动前的行为。
- **「本轮结束时仍为 0」的轮级判据**（方案 D7 的补充证据要求评估的那条）：**不选**，三条理由：
  1. 判据需要「轮」的生命周期，只有 `queryLoop` 有；而 loop 的结束出口不止一个（正常收尾 / 中断 /
     报错 / 预算耗尽）。把撤销挂到每个出口上，漏一个就是**新的静默失效**——本方案的 D1 / D8 正是
     「判据散在多个出口、测试又直调内部函数所以全绿」这个形态。
  2. 实测两例「>0 → 0 → >0」的第二次写回本身就是模型重新开工；它若还需要被叫醒，正确动作是
     重排唤醒（工具描述与本次新增的返回值提示都指向这个动作），而不是 harness 替它保留一条
     已经按确定事实作废的唤醒。
  3. 代价端：为一条只有 2 个会话的观测引入跨模块延迟状态，换来的是「同轮内极短窗口」的正确性，不划算。
   改由 `zombie_wakeups` 口径（FIX-8 的 `scripts/wait-audit.ts`）持续观测：若线上仍出现
   「清单清零后唤醒仍触发」，再回来做轮级判据。这条已写入方案 §6.2 的登记口径。
- **把撤销从 `todo_write` 挪到 `loop` 的固定信号上**（例如 todo gate 的 `allDone`）：撤销会因此延迟到
  「下一次有人问清单」，而 `todo_write` 是模型唯一主动报告「我做完了」的时刻；延迟只扩大误撤销窗口。
- **保留 `countUnfinishedItems` 并只改注释**（方案 D7 的字面写法）：它失去唯一调用点后就是死代码，
  `oxlint` 的 `no-unused-vars` 会红；把「两个口径为什么不能共用」的知识搬进 `countOpenItems` 注释，
  信息不丢，也不会给下一个人留下一个可以顺手复用的旧口径。

## 拿什么证明它生效了

新增 `packages/core/tests/tool/todo-write-wakeup-invalidation.test.ts`（8 条）：

```text
bun test ./packages/core/tests/tool/todo-write-wakeup-invalidation.test.ts
 8 pass / 0 fail, 27 expect() calls
```

其中 R4 / R5 是附录 A 的复现迁入：R4 走「默认构造实例（= 子代理）把清单写到 completed → 主会话唤醒仍在、
`drainWaitNotices()` 为空、`isWaitInvalidated` 为 false」；R5 走「`pending → blocked` 写入后唤醒仍在」。
对照组用 `new TodoWriteTool({ invalidatesWakeups: true })` 锁住 S1 本身仍然有效。另有边界：
`[completed, blocked]` 不触发、`blocked → completed` 触发、空清单 `[]` 不触发、从未写过清单首次全 completed
不触发。构造点穷举读**源码文本**：`packages/*/src` 下 `new TodoWriteTool` 恰好 2 处，`cli.ts` 必须带
`invalidatesWakeups: true`，`sub-agent.ts` 必须保持无参。

既有用例：`wait-registry.test.ts` 的 T-W3-3 构造从 `new TodoWriteTool()` 改成
`new TodoWriteTool({ invalidatesWakeups: true })`——S1 现在是主会话专属副作用，用例测的是 S1 本身，
断言方向一字未改。同批 `todo-write.test.ts` / `todo-write-blocked.test.ts` / `input-alias.test.ts` /
`subagent-todo-write-isolation.test.ts` / `subagent-todo-loop-mechanisms.test.ts` 共 65 pass / 0 fail。

变异自证（改坏 → 跑 → 恢复，四条都实测过）：

| 变异 | 变红的断言 |
| --- | --- |
| 默认值 `=== true` → `!== false` | `D6 > R4：子代理实例…主会话唤醒仍在`（7 pass / 1 fail） |
| S1 触发判据退回 `pending / in_progress` 计数 | `D7 > R5：pending → blocked…唤醒仍在` + `边界：写入空清单 [] 不算清零`（6 pass / 2 fail） |
| `countOpenItems` 改回只数 pending / in_progress | `D7 > 边界：[completed, blocked] … blocked → completed 才触发`（7 pass / 1 fail） |
| `cli.ts` 去掉 `{ invalidatesWakeups: true }` | `构造点穷举：只有主会话注册点传 true`（7 pass / 1 fail） |

第三行值得记一笔：方案 D7 写的变异是「`countOpenItems` 改回 → R5 红」，但本实现的**触发判据**是
`allDone`（`countOpenItems` 只算 `unfinishedBefore`），所以那一变异不会让 R5 红，而是让
`[completed, blocked] → completed` 这条边界红（它才是 `unfinishedBefore` 口径的哨兵）。R5 的哨兵对应的是
第二行（触发判据退回旧口径）。两个变异都做，才把两条判据各自钉住。
