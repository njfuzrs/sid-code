# architecture/discipline

> **类别**：E 类建设纪律 case（出处：08 §5.0 / §9.2 P0-tier2 + S2.B）
> **当前 case 数**：0（S2-T07~T11 共 5 条）
> **grader 类型**：以 `structured_arch`（lint-script 类） + `binary_redline` 为主
> **创建时间**：S1-T01 / 2026-05-28

## 收录范围

评测纪律不变量 + lint 类规则（08 §1 三组不变量第 1 组：评测纪律 7 条）。

- E-01 / E-02：底座加固 ADR 必须标注"垂直场景需求来源"
- E-03：M3 Go/No-Go 检查器
- E-05：30 case 平均分回归告警
- E-06：holdout 不参与调优（**holdout** —— S2-T09）
- E-07：阶段 1 失败退路可行（CLI fallback）
- E-14 / E-15 / E-16：其他 lint 规则

## 出处

- `docs/eval/09-研发智能基座-eval详细清单.md` §E 类
- `docs/eval/08-研发智能基座-eval总纲.md` §1.1 评测纪律不变量 + §9.2 P0-tier2
