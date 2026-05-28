# architecture/form

> **类别**：A 类五形态最小集 case（出处：08 §5.0 / §9.2 P0-tier1）
> **当前 case 数**：5（S1.D 写完后；其中 1 条在 holdout/architecture/form/，另 1 条 B-19 Skill 隔离归入此节）
> **grader 类型**：以 `structured_arch` + `binary_redline` 为主
> **创建时间**：S1-T01 / 2026-05-28

## 收录范围

五形态共存（CLI / SDK / Daemon / MCP Server / IDE Plugin）的最小验收契约。

| Case ID | 出处编号 | 主题 | 前置能力 |
| --- | --- | --- | --- |
| arch_form_001 | A-01 | CLI 作为 Skill 开发 IDE | 已有 |
| arch_form_002 | A 五形态共享内核 parity | CLI/TUI/Headless 等价（**holdout**） | 已有 |
| arch_form_003 | A-06 | MCP Server 被外部 Agent 调用 | 待建（≤1sprint） |
| arch_form_004 | A-23 | MCP Server 被 Claude Code 调用 | 待建（≤1sprint） |
| arch_form_005 | B-19 | Skill 卸载后 system prompt 恢复 | 已有 |

## 设计约束

- arch_form_002 → `evals/holdout/architecture/form/`，禁止改 yaml 内容（08 §9.3 Go 条件 3）
- arch_form_003 / arch_form_004 前置"待建"，yaml 落盘但跑 baseline 时跳过（标注 placeholder）

## 出处

- `docs/eval/09-研发智能基座-eval详细清单.md` §A 类
- `docs/eval/08-研发智能基座-eval总纲.md` §1.1（五形态共存）+ §9.2 P0-tier1
- `CLAUDE.md §0.1` 五层洋葱架构
