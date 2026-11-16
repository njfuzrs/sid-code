---
Status: implemented
Date: 2026-11-16
Source: 工具接口设计-剩余项T1T2T4T5（2026-11-15）T5
---
# 关掉 read 的 narrow_first 提示：照做率判据触发后的处置

## 决定了什么

`packages/core/src/tool/read.ts` 的 `narrow_first` 提示下线。它是「首次读一个不大的文件却传了
小 limit」时追加的 `[读取效率提示: ...]`，外加一条 `ReadHint{kind:"narrow_first"}` 事件。
删除后 read 的提示只剩 `repeat_narrow` 一类（同文件近期读 ≥3 次且窗口重叠 >60%）。

配套删掉的：`recordReadAndBuildHint` 的 `hadExplicitLimit` 参数（只被这一支使用）、
调用点的 `params.limit !== undefined` 实参。

**保留不动的**：`ReadHint` 事件本身、`hint_file_path` 的 LOCAL_ONLY 口径、
`stripReadEfficiencyHint` 剥离逻辑、`scripts/aftereffect-report.ts` —— 历史轨迹里还有
3259 条 `narrow_first` 事件，取数脚本必须继续能统计它们（2 周后要回看 `repeat_narrow`
的 `followed` 有没有上升，见下）。

## 放弃了什么（以及为什么不选）

- **改文案**（把「若需通览,可不传 limit 一次整读」改成更明确的动作指引）：方案 §T5 给的
  另一条路。否决依据是数据指向的原因不是文案含糊，而是**时机错配** ——
  3259 次触发里 73.2%（2386 次）的提示之后模型根本没再读这个文件。这类场景是"我只需要这一
  段"的定向读，本来就不该通览；文案写得再明确也救不回一个不该出现的提示。
  真正需要劝阻的「同段重复读」只占 5.6%（183 次），而那类场景已由 `repeat_narrow` 覆盖
  （它的 `still_narrow_overlap` 比例 15.7%，是 `narrow_first` 的近 3 倍，说明提示打得更准）。
- **保留但降级触发条件**（例如只在文件更小时提示）：没有数据支撑一个新的阈值。
  现有数据里 `narrow_first` 的 `no_reread` 高达 73%，说明问题不在"阈值宽了一点"，
  而是"首次窄读"这个信号与"需要通览"根本不相关。
- **连 `repeat_narrow` 一起关掉**：它虽然照做率也只有 1.12%，但 `not_applicable` 661 次
  说明相当一部分触发是体量超限（提示已经在说「别整读，改用 grep」），且它的触发条件
  本身就等价于"真的在重复读"这一事实，与 `narrow_first` 的推测式触发不同性质。
  方案 §T5 也只点了 `narrow_first`。

## 拿什么证明它生效了

决策依据（`bun scripts/aftereffect-report.ts --json`，2026-11-16，全部历史窗口
2026-09-24 ~ 2026-11-16，会话 1043、剔除 tmp 135）：

| kind | hints | followed | still_narrow | 其中同段重叠 | no_reread |
| --- | --- | --- | --- | --- | --- |
| `narrow_first` | 3259 | 20（0.61%） | 853 | 183（5.6%） | 2386（73.2%） |
| `repeat_narrow` | 2176 | 17（1.12%） | 828 | 238（15.7%） | 670 |

`narrow_first` 占全部 ReadHint 的 60.0%（3259/5435），是提示量的主体。

改动后的验证：

- `bun test ./packages/core/tests/tool/read-tool.test.ts ./packages/core/tests/trace/observability-gaps-g2-g6.test.ts`
  → **65 pass / 0 fail**。
- 回归改造（不是删测试）：
  - `read-tool.test.ts` 把「首次窄读 → '读太窄'提示可整读」反转为「不再追加任何效率提示」，
    并断言输出不含 `一次整读`；
  - `observability-gaps-g2-g6.test.ts` 把「首次窄读 → narrow_first」反转为「不产 ReadHint 事件」，
    另补一条「主循环重复窄读 → repeat_narrow 不带 agent_id」，把原先靠 `narrow_first`
    覆盖的「主循环无 agent_id」口径挪到真实还存在的分支上（否则这条口径会失去守卫）。
- **变异自证**：把删掉的 `else if` 分支临时贴回 `read.ts`，上述两条反转断言转红
  （`read-tool.test.ts` 报 `expect(r.output).not.toContain("[读取效率提示:")` 失败、
  `observability-gaps-g2-g6.test.ts` 报 `expected length 0, received 1`），恢复后转绿。

2 周后回看（未做，留给后续）：
`bun scripts/aftereffect-report.ts --json` 看 `repeat_narrow.followed` 与
`narrow_first.hints`（后者应停在 2026-11-16 之前，新会话不再产生）。
