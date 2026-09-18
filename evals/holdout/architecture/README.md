# holdout/architecture（已退役）

> **类别**：架构 holdout 切分方法论的记录
> **当前 case 数**：0（yaml 已于 2026-09-18 随旧题集删除）
> **题面备份**：`~/Backups/sid-code-evals-legacy/`
> **本文件留下的原因**：记录「holdout 怎么切分」，新集要复用。⛔ 不删。

## 设计规则（当年怎么切）

从每类（redline / form / pluggable / kernel / platform / discipline / context-engine / orchestration / nonfunctional / meta / milestone）切 10–20% 到本目录。

**关键约束（08 §9.3 Go 条件 3）**：
- 移到本目录后**禁止改 yaml 内容**
- 不参与日常调优 / 不参与回归
- M3 Go 评审条件 3："架构 holdout baseline 偏差 ≤ 0.5"——如果 holdout 跑分相对原 case 偏差 > 0.5，说明已经过拟合本类训练 case，需要扩样本或重设计

## 当年已规划、现已随旧题集删除的 holdout

| Case ID | 子类 | 主题 | 何时切 |
| --- | --- | --- | --- |
| arch_kernel_008 | kernel | Agent Loop 不可拔插（C-档约束护身符） | S1-T23 |
| arch_form_002 | form | 五形态共享内核 parity（CLI/TUI/Headless 等价） | S1-T26 |
| arch_pluggable_002 | pluggable | Skill body 按需加载 | S2-T19 |
| arch_discipline_003 | discipline | E-06 holdout 不参与调优 | S2-T09 |
| arch_meta_004 | meta | H-04 holdout 保护 | S2-T15 |
| arch_meta_005 | meta | H-05 Eval Runner 不可拔插 | S2-T16 |

题面见 bundle，不在本目录。

## 出处

- `docs/eval/08-研发智能基座-eval总纲.md` §13.2 切 holdout 规则
- `CLAUDE.md §0.2`（评测纪律不变量第 2 条：holdout 不参与调优）
