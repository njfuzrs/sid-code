# architecture/context-engine

> **类别**：F 类 Context Engine case（出处：08 §5.0 / §9.2 P0-tier1 + S1.E + S3.A）
> **当前 case 数**：0（S1-T31~T36 共 5 条作为契约占位）
> **grader 类型**：以 `structured_arch` + `execution_test` 为主（依赖前置实现，S1 暂不跑分）
> **创建时间**：S1-T01 / 2026-05-28

## 收录范围

代码图谱 / LST / 调用链 / 增量索引 / 影响分析（CLAUDE.md §0.1 L3 Context 护城河）。

| Case ID | 出处编号 | 主题 | 前置能力 |
| --- | --- | --- | --- |
| arch_ctxeng_001 | F-01 | tree-sitter 解析 TS/Python/Go | 不存在 |
| arch_ctxeng_002 | F-03 | 增量更新（修改 1 文件仅重索引） | 不存在 |
| arch_ctxeng_003 | F-05 | 调用图（funcA 调用者） | 不存在 |
| arch_ctxeng_004 | F-06 | 依赖图（moduleA 依赖） | 不存在 |
| arch_ctxeng_005 | F-07 | 跨文件变更影响分析 | 不存在 |

## 设计约束

- 前置全部"不存在"，case 写出来作为契约，DASHBOARD 显示"未实现"分类
- 阶段 2 模块就位后再补 baseline（08 §13.1 节奏并轨表）
- 写 case 必须在写实现之前（08 §12.3 EDD 铁律）

## 出处

- `docs/eval/09-研发智能基座-eval详细清单.md` §F 类
- `docs/eval/08-研发智能基座-eval总纲.md` §9.2 P0-tier1（最危险的护城河）
