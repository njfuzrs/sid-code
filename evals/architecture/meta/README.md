# architecture/meta

> **类别**：H 类评测自检 case（出处：08 §5.0 / §9.2 P0-tier2 + S2.C）
> **当前 case 数**：0（S2-T12~T17 共 5 条；其中 H-04 / H-05 进 holdout/architecture/meta/）
> **grader 类型**：以 `structured_arch` + `binary_redline` 为主
> **创建时间**：S1-T01 / 2026-05-28

## 收录范围

评测体系自身的金字塔结构 / 不允许自评估 / 外部 Grader / holdout 保护 / Eval Runner 不可拔插。

| Case ID | 出处编号 | 主题 |
| --- | --- | --- |
| arch_meta_001 | H-01 | 四层金字塔结构 |
| arch_meta_002 | H-02 | 不允许自评估 |
| arch_meta_003 | H-03 | 外部 Grader |
| arch_meta_004 | H-04 | holdout 保护（**holdout**） |
| arch_meta_005 | H-05 | Eval Runner 不可拔插（**holdout**） |

## 设计约束

- arch_meta_004 / arch_meta_005 → `evals/holdout/architecture/meta/`，禁止改 yaml 内容

## 出处

- `docs/eval/09-研发智能基座-eval详细清单.md` §H 类
- `docs/eval/10-eval-architecture-analysis.md`
