---
Status: implemented
Date: 2026-10-09
---
# workflow 编排侧 8 条缺陷：缓存键改成结构性的，闸门在扇出下生效且不被吞

## 决定了什么

修掉缺陷文档「编排与调度 —— 顺着 sc-16 核出的缺陷」里编排侧的 8 条（P0-1/2/3/4、P1-1/2/3/8）：

- **resume 语义（P0-1/2/3）**：journal 缓存键从全局自增的 `callIndex` 改成**结构性 key**
  （`runtime.ts` 的 `CallScope`，经 `AsyncLocalStorage` 传播）：parallel 第 i 个 thunk、
  pipeline 第 i 条 item 链、内联子 workflow 各开一个作用域，作用域内顺序编号，
  形如 `1p2/0`、`0l4/1`、`2w/0`。纯串行脚本的 key 恰为 `"0","1",…`，老 journal 照常命中。
  `Journal.lookup` 自带**失效游标**：未命中的 key 记下，结构上在它之后的调用一律重跑
  （`isStructurallyAfter`：同作用域序号更大才算之后，兄弟分支互不连坐）。
  `null`（runner 契约里的失败）不写盘，老 journal 里的 `null` 回放时也视为未命中。
- **扇出闸门（P0-4/P1-2/P1-3）**：预算 + abort 检查在 `agent()` 入口和**取到调度槽位后**各做一次；
  `Scheduler.run/acquire` 接受 signal，排队期间 abort 即出队 reject；
  `parallel`/`pipeline` 的 catch 用 `isRunFatalError` 区分，
  `BudgetExceededError`/`AgentLimitError`/`WorkflowAbortedError`/`UndeclaredPhaseError` 穿透，
  其余单项失败仍落 `null`（无屏障语义不变）。
- **P1-1**：影子 `Date` 不再挂真 `Date.prototype`，改为复制实例方法的独立 prototype
  （`constructor` 指回影子），实例构造后 `setPrototypeOf` 换过去。
- **P1-8**：phase 声明从实例字段挪到调用作用域上，并发子 workflow 各对各的 `meta.phases`。

## 放弃了什么（以及为什么不选）

- **把 label 纳入指纹**（缺陷文档提的备选）：改 label 就让缓存失效，且没解决「同 label 不同分支」；
  结构性 key 不需要脚本作者配合。
- **指纹失配即整段废弃缓存**：会让 resume 在扇出脚本里退化成全量重跑；游标只连坐真正的下游。
- **`Object.create(RealDate.prototype)` 当影子 prototype**：`Object.getPrototypeOf` 一步就回到真
  prototype，`.constructor` 照样拿到真 Date；**改写 `RealDate.prototype.constructor`** 会污染宿主全局，否决。
- **`withDeclaredPhases` 加引用计数/栈**：并发窗口交错时栈序不等于调用链，只有调用链局部存储正确。
- 预算检查移到槽位后仍允许**一个并发批次**的超支（已在跑的 agent 无法预知花费）——这是接受的残差，
  已写进 `budget_total` 的工具描述。

## 拿什么证明它生效了

- 新增 `packages/core/tests/workflow/orchestration-defects.test.ts`（22 条，全部经 parallel/pipeline）。
  **逐条变异自证**：把每条修复单独撤回，对应测试转红（P0-1 需同时撤 runtime 与 journal 两道 null 门，
  单撤一道仍绿——两道是刻意的双保险）。
- 缺陷文档的复现脚本在修复后复跑：
  `02` 四条 Date 逃逸全部 `THREW ...被禁`；`03` 失败后 resume `runner 被真调次数 = 1`、
  改 B 后 `真跑的 prompt: ["B-CHANGED","C"]`；`04`/`05` 扇出预算耗尽改为抛 `BudgetExceededError`（已花 2000，预算 1500）；
  `21` strict 下结果 `["A ok","B"]`（原为 A 被拒绝执行）。
- `bun test ./tests/workflow/` 151 pass / 0 fail；`bun run affected-tests:run` 1222 pass / 0 fail；
  `make build` 成功且无 `will always be undefined` 警告。
