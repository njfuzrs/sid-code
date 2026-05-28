# architecture/kernel

> **类别**：C 类内核约束 case（出处：08 §5.0 / §9.2 P0-tier1）
> **当前 case 数**：7（S1.C 写完后；arch_kernel_008 在 holdout/architecture/kernel/）
> **grader 类型**：以 `structured_arch` 为主（assert：fs / module 静态检查），少量 `binary_redline`
> **创建时间**：S1-T01 / 2026-05-28

## 收录范围

sid-code 当前已成熟的内核约束守护——防止 Sprint 推进时无声回归。

| Case ID | 出处编号 | 主题 |
| --- | --- | --- |
| arch_kernel_001 | C-03 | Sub-agent 4 种类型（explore/task/summarize/plan） |
| arch_kernel_002 | C-04 | 循环检测（loop_detection） |
| arch_kernel_003 | C-06 | Checkpoint 恢复 |
| arch_kernel_004 | C-07 | Permission 模式完整可用（7 种） |
| arch_kernel_005 | C-08 | Permission 读写风险区分 |
| arch_kernel_006 | C-11 | Hook 14 种事件 |
| arch_kernel_007 | C-19 | Memory 双层注入（全局 + 项目） |
| arch_kernel_008 | arch_pluggable_003 | Agent Loop 不可拔插（**holdout**） |

## 设计约束

- arch_kernel_008 → `evals/holdout/architecture/kernel/`（C 档不可拔插约束的护身符）

## 出处

- `docs/eval/09-研发智能基座-eval详细清单.md` §C 类
- `CLAUDE.md §0.1`（五层洋葱架构 + 三档可拔插）
