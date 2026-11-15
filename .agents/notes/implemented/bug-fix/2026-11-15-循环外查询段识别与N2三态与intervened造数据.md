---
Status: implemented
Date: 2026-11-15
Source: 20261110-等CI时轮询与唤醒重复空转-剩余缺口-修复与验收方案（2026-11-10）
---
# 补上循环外查询段的识别、N2 用例的三态判定，并用回放造出 `intervened=true` 的样本

## 决定了什么

三处改动，都来自对方案落地情况的二次复核（不是新缺陷）：

1. **`matchLoopQuery` 允许循环外出现查询段与只读过滤段**
   （`packages/core/src/task/status-query-commands.ts`）。
   原实现要求 `loop.outside` 全部是 `HARMLESS_COMMANDS`，于是
   `gh pr view 1 --json state; for n in 787 785; do gh pr view $n …; done`
   整条判 null —— 与主判据 2「查询段之前也可以是查询」
   （`gh pr status && gh pr checks 1`）自相矛盾，且失败方向是**漏拦**。
   循环外的查询段按顺序拼进签名（它们先于循环执行），循环体与 `loopSubject` 的
   既有逻辑一行未动。真实轨迹里命中该形态的 4 条命令，修复后 3 条命中
   （剩 1 条是 `for j in $(gh run view …)`，属 §N3 第 5 条已放弃的「命令替换赋值」）。

2. **N2 的 G3 用例改成三态**（`scripts/verify-monitor.ts`）。
   `analyzeWakeupTurn` 新增 `otherWaitPrimitive`：扫本轮内的 `WaitRegistered`（排除
   `kind=wakeup` 自己）、`monitor` 的 PreToolUse、`run_in_background=true` 的 bash。
   `runN2WakeupThenEnd` 据此分流：排了唤醒 → 原两条断言；没排但用了别的等待源 →
   **INVALID**（case 不适用，模型走的是合法路径）；两者都没有 → **FAIL**。
   之前只判 FAIL，于是 2026-11-10~13 的 6 次 G3 全被记成「文案没引到等待原语」，
   case 失去了区分度。

3. **新增 G2 用例 `P1-intervened-true`，造出 `intervened=true` 的样本**
   （`tests/smoke/cases/P1-intervened-true/`）。
   `UnchangedObservationRun.intervened` 需要两个条件同时成立：同工具同参的返回值
   连续 3 次完全相同 **且** 触发阈值的那次被 P1 拦截。真实轨迹 24 次全部 false ——
   模型不会自发连续 5 次调同一条查询，这个样本日常等不到。回放固定
   5 次 `gh pr checks 1 --repo '///' 2>/dev/null || echo "no checks"`，
   配合后台 `sleep 8` + `wait_until_seconds=60` 造出的 shell deadline 等待源：
   第 1、2 次真实执行（输出 O）→ 第 3 次起被拦（回执 R 恒定）→
   `observeToolResult` 看到 O,O,R,R,R，第 5 次 `run=3` 触发埋点，且该次被拦截 →
   `intervened=true`。

## 放弃了什么（以及为什么不选）

- **只改文档声明「循环外必须无害」，不改实现**：真实轨迹里这条边界让 4 条本可识别的
  命令漏拦（其中 3 条是同 family 的纯查询），而主判据对「查询段之前有查询」是放行的。
  把同一条安全边界在两个位置写成两种结论，下一个读代码的人会当成 bug 修；不如统一，
  并把「安全边界不放松」用三条反例锁住（`gh pr merge` / `git push` / `done` 之后的
  `gh pr merge` 全部仍 null）。**不选**，因为它是「文档承认实现有洞」而不是「消除洞」。
- **要求循环外的查询段与循环同 family 才放行**：更保守，但会把
  `gh run view 1; for n in …; do gh pr view $n; done` 继续判 null。拦截目标是
  「别反复查状态」，不要求查的是同一个对象；签名已包含循环外段，memo 不会互相污染。
  **不选**，因为多一道同族检查换不到安全收益，只多一处漏拦。
- **N2 用 `schedule_wakeup` 造等待源而不是后台 bash**：`schedule_wakeup` 是长尾工具，
  回放里不先 `tool_search` 激活就调不到；而 P1 判据 1 只要求「有显式声明的等待源」，
  `isDeclaredExternalWait` 认 `shell + deadline`。**不选**，因为要多写一条
  `tool_search` 回放，且引入「激活是否生效」这个与被测对象无关的变量。
- **为 `intervened` 写一个纯 G1 测试就收工**：G1 只能证明「函数的算术对」，
  证明不了「真实执行链（tool-executor → loop 埋点）把标记传到了事件里」。
  首版 G2 实测就暴露了一个 G1 看不见的坑：`recordStatusQueryResult` 只在
  `!result.isError` 时调用，用必然失败的命令造样本时 memo 永远没有 entry，
  P1 一次都不拦（`intervened=false`）。**不选**，因为那会把一个端到端缺陷留在暗处。

## 拿什么证明它生效了

- `bun test ./packages/core/tests/task/status-query-shapes.test.ts`：**36 pass**（新增 5 条）。
  改代码前先跑同一批：4 条 fail（正向用例全红、写操作反例本来就绿），确认门禁不是恒绿。
- `bun test ./tests/scripts/verify-monitor.test.ts`：**62 pass**（新增 5 条三态用例）。
- `bun run smoke P1-intervened-true`：**PASS，8.5s**；轨迹里
  `UnchangedObservationRun {"run":3,"intervened":true}` 1 条 +
  `BackgroundPollIntercepted` 3 条（第 3、4、5 次调用）+
  `WaitRegistered {kind:"shell",promise_kind:"deadline"}` 1 条。
- `bun run smoke:mutate P1-intervened-true`：**1 killed**。删掉
  `markStatusPollIntervened(block.id);` 之后用例变红（`intervened` 恒 false），
  证明这道门禁真的在守东西。
- 真实轨迹复核（不是构造）：全量 895 会话 2909 条前台 gh 状态查询，完整命令口径
  识别 2219 条 = 76.3%；循环形态 201 条，识别 61 条（30.3%），未识别的 140 条里
  73 条是命令替换赋值（已放弃）、52 条循环外有非无害命令、4 条循环外有其它查询段
  （本次修复后 3 条转命中）、11 条循环体非无害。
