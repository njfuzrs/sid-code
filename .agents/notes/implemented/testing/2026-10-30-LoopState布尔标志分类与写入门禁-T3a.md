---
Status: implemented
Date: 2026-10-30
---
# LoopState 布尔标志按写入方式分四类，并加全仓扫描门禁（T3a）

## 决定了什么

- `query/types.ts` 导出 `LOOP_STATE_FLAG_KIND`，给 `LoopState` 全部 19 个布尔字段分类：
  `set_only`（11）/ `entry_reset`（1，`turnCompleteEmitted`）/ `pending_consume`（6）/ `tracking`（1）。
  类型是 `Record<LoopState 的布尔键, ...>`，新增布尔字段不分类 tsc 直接报错。
- 新门禁 `packages/core/tests/query/one-shot-flag-invariant.test.ts` 扫 `packages/core/src/` 全部源码的**成员写入**
  （`.x =`、`["x"] =`、`??=` / `||=` / `&&=`、`delete`）：
  - `set_only`：只许 `= true`
  - `entry_reset`：回落只许在 `beginTurn` 函数体内（花括号配对定位，不靠行号）
  - `pending_consume`：回落（`= false` / `= undefined`）恰好一处
  - 完备性：从 `types.ts` 源码解析 `LoopState` 顶层布尔字段（`?:` 与非可选 `:` 都收），必须与常量键集合相等
  - 非 `tracking` 字段至少有一处置真点（零置真就是死字段）
- 删掉死字段 `hadHitlThisTurn`：全仓零置真点，只在 `beginTurn` 写 `false`、在 `turn-complete.ts` 读 `=== true`（恒假）。
  HITL 判定本来就只靠 `hitlCountAtTurnStart` 的计数差值，删除不改行为。

## 放弃了什么（以及为什么不选）

- **原方案的三分法（会话内一次性 / 每条消息一次性 / 普通状态）**：`LoopState` 每次 `queryLoop` 调用都重建，
  「会话内」这一类在 state 层面不存在，`hasAttemptedReactiveCompact` 和 `softTurnLimitReminded` 写法完全一样。照它分类，门禁一上来就是绿的。
- **只扫 `src/query/`**：state 会被传进别的域的 helper，在那里清零照样绿。
- **匹配裸标识符赋值**：`agent/agentic-loop.ts` 有同名局部变量 `deferredToolsPendingAfterCompact`，会误报。只认成员写入。
- **把跨续跑重建也塞进本门禁**：`resumeWithNotifications` 整体重建 state，不写任何赋值，静态扫描拦不住。
  这一类单列为 T3b（先拿轨迹数据再决定 carry），不在这里假装覆盖。
- **对象字面量 / 展开（`createInitialLoopState` 里的 `hasAttemptedReactiveCompact: false`、carry 回填）不扫**：
  那是构造点，不是续跑中的回落；把它们算违规就得加白名单，而白名单正是门禁恒绿的来源。

## 拿什么证明它生效了

`bun test ./packages/core/tests/query/one-shot-flag-invariant.test.ts`：恢复后 6 pass。变异自证一共五次，每次都红在对应断言上：

1. 在 `loop.ts` 置真点后面加 `state.hasAttemptedReactiveCompact = false` → `set_only` 红
2. 给 `pendingJudgmentGuide` 加第二处 `= false` → `pending_consume` 红
3. 在 `LoopState` 加非可选 `mutantFlag: boolean` 不分类 → 完备性红
4. 在 `beginTurn` 之外写 `state.turnCompleteEmitted = false` → `entry_reset` 红
5. 把 `state.lspHealthWarned = true` 改成 `||= false` → `set_only` 和死字段两条都红（复合赋值被收进来了）

另外，扫描面断言要求文件数 > 200、写入数 > 40，防止目录或正则写错后恒绿。

已知局限：这是跨域源码字面量断言，`affected-tests` 选不到它。改字段名之前先 `grep -rnF '<字段名>' packages/core/tests`。
