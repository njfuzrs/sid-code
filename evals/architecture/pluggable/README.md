# architecture/pluggable

> **类别**：B 类可拔插 case（出处：08 §5.0 / §9.2 P0-tier2 + S2.D）
> **当前 case 数**：0（S2.D 起填，S2-T18~T24 共 7 条 + S1-T29 B-19 归入 form 类）
> **grader 类型**：以 `structured_arch` + `binary_redline` 为主
> **创建时间**：S1-T01 / 2026-05-28

## 收录范围

CLAUDE.md §0.1 三档可拔插矩阵的 A 档 case（Tool / Skill / LLM Provider / MCP Server / Storage Adapter 接口 + 多实现 + 第三方分发）。

## 设计约束

- arch_pluggable_002（Skill body 按需加载）属架构 holdout，迁到 `evals/holdout/architecture/pluggable/`
- arch_pluggable_003（Agent Loop 不可拔插）属架构 holdout，**注意位置**：S1-T23 把它放到 `evals/holdout/architecture/kernel/`（属内核 holdout）

## 出处

- `docs/eval/09-研发智能基座-eval详细清单.md` §B 类
- `docs/eval/08-研发智能基座-eval总纲.md` §9.2 P0-tier2
