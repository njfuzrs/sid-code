---
Status: implemented
Date: 2026-10-26
---
# fidelity 口径三点收口：matchedRatio 不再二次扣 denied、ls 移出分母、白名单与动作词表对齐

## 决定了什么

修的是 PR #446 落地后的三个残留口径缺陷。它们都不改行为路径，只改「指标怎么算」与
「哪些调用进分母」，但三处都会让数据静默失真。

**一、`matchedRatio` 的分子不再扣 `deniedCount`**（`core/src/plan/state.ts` 的 `getFidelityReport`）

从前是 `matchedActualCount = actual - denied - offPlan`。这条减法默认「命中」与「被权限拒绝」
互斥，但一个调用完全可以同时成立：证据会话里 `edit math.js` 命中 step1 又被权限拒绝，
于是它既不在 `offPlanCount`、也被从 matched 里扣掉，**在三个计数里凭空消失**。
净效果是 `matchedRatio` 在修复前后都是 0——文档定的「主口径」失去区分修复前后的能力，
而这正是 PR #446 自己承认「没做真实端到端实跑」所掩盖的那一层。

现在 `matchedActualCount = actual - offPlan`，并在 `FidelityReport` 注释里写明
「matched 含被拒的命中项；`deniedCount` 是横切标签，不是与 matched / off-plan 并列的第三类」。

**二、`ls` 移出 `FIDELITY_TRACKED_TOOLS`**

白名单里有 `ls`，但 `TOOL_VERBS` 没有 `ls` 词表，`matchAgainstPlan` 的第①道门槛
（描述含工具名或动作词）对它只能靠字面 `ls`——中文计划里几乎不会出现。
结果是**每一次探索性列举都被记成一次偏离**，与同文件注释「探索性 `ls` / `tool_search`
不进分母，不产生任何偏离记录」直接相反，也违反 P2-3「宁可漏记也不虚报」。
`ls` 本就是「不该进分母」的那一类，移出而不是补词（补词还会带来 `desc.includes("ls")`
命中 `results` / `tools` / `false` 的子串假阳性）。

**三、白名单成员补动作词，并写下「加白名单必须配词表」这条约束**

`read_many` / `notebook_edit` / `sub_agent` 同在白名单、同样没有词表，探针实测
四个工具（含 `ls`）全部 `matched=null`。处置：`read_many` 与 `read` 共享
`READ_VERBS`，`notebook_edit` 与 `edit` 共享 `EDIT_VERBS`（同语义工具各写一套必然漂移），
`sub_agent` 补最小词表 `["派", "子代理"]`。在 `FIDELITY_TRACKED_TOOLS` 文档注释里
写死判据：**加进本表的工具必须在 `TOOL_VERBS` 里有动作词**，否则必然 off-plan。

## 放弃了什么（以及为什么不选）

- **保留「denied 不算 matched」的写法、只改注释**：那 `matchedRatio` 就永远无法表达
  「命中了但被 harness 拦下」这件事，文档 §2.4 的主验收口径继续失效。要么改算法，
  要么换指标；改注释只是把矛盾从代码挪到文档。
- **新增一个独立字段（如 `matchedExecutedRatio`）表达「命中且成功执行」**：多一维口径就要
  多一个版本号、多一处消费方，而当前没有任何消费方需要区分它。`deniedCount` 已经能把
  「拦了多少」单列出来，够归因。将来真需要时再加，那时才有真实需求支撑字段形状。
- **给 `ls` 补词表（列举 / 查看目录 / list）而不是移出**：倾向「宁可漏记」。
  执行阶段的探索性列举不是计划步骤，进分母只会平白多出偏离；而且 `ls` 的
  子串匹配风险（`results` / `tools`）让它天然不适合做锚定源。
- **给 `sub_agent` 补「调研」「分析」**：这两个词太泛，会命中几乎所有探索性步骤，
  与 P2-3 的底线相反。只收「派」「子代理」两个明确指向子代理的词。
- **把 `TOOL_VERBS` 改成必需（类型层面强制白名单成员都有词表）**：`TOOL_VERBS` 的键
  与白名单是两套集合，用 `Record` 无法表达「必须覆盖」，改成 `satisfies` + 映射类型
  要动的类型面远超本次范围。用注释 + 反例测试锁住，成本低且够用。

## 拿什么证明它生效了

- **探针实测（修前）**：`ls` / `read_many` / `notebook_edit` / `sub_agent` 四个调用
  一律 `matched=null`、`off_plan=1`。
- **真实会话重放（修前）**：用证据会话 `20261024-150725-16e5381f` 的真实计划正文
  （从 `write` 的 `content` 参数还原）与真实调用参数重放，得到
  `edit math.js → matched=1 denied=true`，而报告是 `actual=2 off_plan=1 denied=1 matchedRatio=0`。
  这条重放就是「主口径看不出修复前后」的直接证据。
- **修后断言**（`packages/core/tests/plan/fidelity-caliber.test.ts`）：
  命中且被拒时 `matchedRatio === 1`；证据会话形态重放后 `matchedRatio ≈ 1/3`（从前 0）；
  `ls` 返回 `null` 且不进分母；`read_many` / `notebook_edit` / `sub_agent` 能命中，
  且 `sub_agent` 仍受锚定硬门槛约束（反例）。
- **digest 侧补测**（`packages/core/tests/trace/plan-fidelity-digest.test.ts`）：
  `denied_count` 非 0 时文案带「其中被权限拒绝 N 次，不计偏离」、rawValue 带
  `denied=N indicator=v1`；旧事件无字段时文案与 rawValue 一字不变（反向守护）。
  这两条此前完全没覆盖——PR #446 改 `digest.ts` 时只给该文件加了非空断言。
- **变异自证**：把 `matchedActualCount` 改回扣 `denied`、把 `ls` 加回白名单、
  摘掉三个工具的动词表，对应断言各自变红；恢复后全绿。
