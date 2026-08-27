---
Status: implemented
Date: 2026-08-27
---
# `permission_denials` 的真问题不是「没写入点」，是一个字符串代理判据在假装字段判据

## 决定了什么

A7.13.2 原文说「`permission_denials` 全仓无写入点」。**查过之后没照这个说法做**：
这个字段**能出数**（smoke-8 实测 113 次全是真的），取数源是
`runner.ts` 数 agent.log 里的 `权限拒绝` 中文字符串。所以缺的不是写入点，
是**这个数的三个结构性缺陷**：

| 缺陷 | 后果 |
| --- | --- |
| 判据是日志文案 | 产品侧改一次文案 → **静默归零**，报告显示「权限拒绝 0 次 ✅」 |
| 只有计数、没有成因 | 「headless 把 ask 自动拒了」（换权限档）与「deny 规则生效」（什么都不用做）同形 |
| 只有主循环发事件 | 子代理 / forked 两条鉴权路径**一条埋点都不发** → 那两条路上的拒绝永久隐身 |

第三条是产品侧真缺陷，前两条是评测侧仪器缺陷。两侧一起改：

```
产品侧（结构化通道补齐三条路径）
  analytics/events.ts       新增 PermissionContext / PermissionDenyReasonType 两个枚举；
                            logPermissionDeny/Allow 增 context + reasonType 字段
  query/tool-executor.ts    两条既有 deny 分支透传 decisionReason.type
  agent/tool-executor.ts    子代理 checker 拒绝 + fail-closed 拒绝 → 补埋点（原先零 producer）
  agent/sub-agent.ts        子代理第二条鉴权分支 → 补埋点（原先零 producer）
  agent/forked-agent.ts     canUseTool 拒绝 → 补埋点（原先只进返回值与一行日志）

评测侧（换取数源，旧源降级为交叉校验）
  runner.ts   新增 extractPermissionSignals 读 telemetry/events.jsonl 的 permission_deny；
              RunRecord.permission_denials 改 number|null，增 by_reason/by_context/log_proxy；
              extractAgentLogSignals 的字段改名 permissionDenialsLogProxy（不改名下一个人会继续当权威值用）
  record.ts   读结构化源；遥测缺失落 null；双源背离写进 unaccounted
  grade.ts    新增 aggregatePermissionDenials；三类信号进报告 unaccounted
```

**`null` 与 `0` 语义分开**是这次最关键的一条口径：
`null` = 遥测没取回（不知道有没有被拒），`0` = 量到了确实没被拒。
缺省成 0 会把「仪器没接上」伪装成「防线全绿」—— 那正是 A7.13.2 **本身**的形态
（原判据把「字段不存在」读成「值为 0」）。在修它的过程里重演一次会格外讽刺。

## 放弃了什么

**没让 `permission_denials` 在遥测缺失时回退去读字符串。** 回退等于把刚拆掉的
代理判据又接回去，且下次没人看得出来。字符串源只留作**交叉校验**：
两个数背离即说明有一条链路坏了，而这是「将来新增第四条鉴权分支忘了发埋点」
的唯一会说话的信号。

**没上报任何拒绝原因的文本**（`reason` / `rule` / `pattern`）。
只取 `decisionReason.type` 这个固定枚举 —— 那些文本含规则内容与入参片段（含路径），
与 `analytics/events.ts` 顶部第 2 条硬约束冲突。有一条断言专门钉这件事。

**没给 forked agent 编造 `reasonType`。** 那条路走调用方注入的 `canUseTool` 回调，
拿不到 `PermissionDecisionReason`，所以固定填 `"other"`。
填一个像模像样的 `"rule"` 会让读数的人以为有规则参与，而那是编的。

**没动 `hitMaxTurns` / `llmFatal`。** 它们仍是文案判据，`extractAgentLogSignals`
那段「刻意的取舍」对它们照旧成立。只把权限这一项走完了那条「长期替代」路，
并在注释里点明剩下两个还没做 —— 免得下一个人看到那节以为整个函数都不靠文案了。

## 拿什么证明它生效了

**变异自证（4 次，每次都指定要红哪一条）**，这是本次最有价值的部分：

| 把实现改成 | 结果 |
| --- | --- |
| 读 `event_name` 而不是 `eventName` | ✅ 5 条红 |
| 缺字段就跳过（不落 `unknown`） | ✅ 「分解之和恒等于总数」单独红 |
| 不数坏行（静默跳过） | ✅ 「坏行要计数」单独红 |
| 删掉子代理那处 `logPermissionDeny` | ✅ 4 条红；两条负向对照（放行 / fail-closed）保持绿 |

**🔴 中途抓到一个真实的覆盖盲区，值得单独记：**
汇总逻辑最初内联在 `runGrade` 里，我先写了 5 条 `buildAcceptance` 断言（传入
已汇总好的对象）。把实现改成 `permTotal += r.permission_denials ?? 0`
—— 即 **A7.13.2 的原始错法** —— **156 条断言全绿**。
原因：断言传的是已汇总结果，压根覆盖不到「`null` 怎么变成 total」这个决定。
处置是把它抽成 `aggregatePermissionDenials` 纯函数 + 7 条直接断言，
再跑同一个变异 → 3 条红。

> 教训：**断言写在哪一层，决定了它能防住哪一层的错**。
> 把关键判定抽成可单测的纯函数，比在集成层多写几条断言有效。
> 这与 A7.11.9 那条「别重新实现 digest 已有的口径」不同源，是新的一条。

**门禁**：`affected-tests:run` **2357 pass / 1 skip / 0 fail**（161 文件）；
新增断言 19 条（评测侧 12 + 产品侧 6，另 1 条形态防漂移）；
`lint` / `format:check` 通过；`make build` 通过、编译产物自检 4 项全过；
`docs:gen-reference-check` 参考页与源码一致；`verify:agent-note` 合规。

⚠️ **未在真实评测里验证过**：结构化事件的落盘形态取自 smoke-10 已取回的
`events.jsonl`（逐字对齐，形态本身有断言钉住），但**这一版的三条新 producer
还没跑过一轮真 SWE-bench**。完整验收标志是：某一轮 run 的报告里
`permission_denials` 与 `permission_denials_log_proxy` 同向、
且 `by_context` 里真的出现 `subagent`/`forked` 分桶。
按 A7.11.5 那条教训（「防线自己成了它当初要消灭的死功能」），
在那之前不该声称这条链路已验证。
