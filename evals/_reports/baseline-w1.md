# baseline-w1.md — sid-code 自身 baseline（2026-05-29）

> 生成时间: 2026-05-29T18:32:25.954Z
> 模式: EXECUTE（真跑）
> case 总数: 30（含 holdout）

## §1 总览

| 档位 | 数量 | 已跑 | 锚点命中率 | 平均人工分 |
|---|---:|---:|---:|---:|
| P0 | 10 | 8 | 66% | 3.90 |
| P1 | 9 | 0 | — | 4.82 |
| P2 | 6 | 4 | 50% | 3.77 |
| holdout | 5 | 0 | — | — |

## §1.5 grader 版本占比

| grader 版本 | 条数 | 占比 | 状态 |
|---|---:|---:|---|
| `<missing>` | 162 | 86.6% | 🕰️ legacy（缺 _formula_version） |
| `5d-v3` | 25 | 13.4% | 🕰️ legacy（历史版本号） |

> 当前 `5d-v4` 占比：**0.0%**（0/187）
> 收敛标准 §6 #1：5d-v4 占比 ≥ 80%（当前 ⏳ 未达标，需重跑刷新）

## §2 每条 case 明细（不含 holdout）

| ID | Pri | 类别 | 锚点命中 | 反向违规 | 用时 | 状态 | 人工分 |
|---|---|---|---:|---:|---:|---|---:|
| case_001 | P0 | 代码理解 | 2/2 | 0 | 200.0s | success | 5 |
| case_002 | P0 | 代码理解 | 6/6 | 0 | 200.0s | success | 5 |
| case_003 | P0 | 代码理解 | 3/3 | 0 | 200.0s | success | 5 |
| case_005 | P0 | bug修复 | 0/4 | 0 | 200.0s | success | 1 |
| case_006 | P0 | bug修复 | 2/4 | 0 | 200.0s | success | 3 |
| case_007 | P0 | bug修复 | 3/4 | 0 | 200.0s | success | 4 |
| case_008 | P0 | 新功能实现 | 2/4 | 0 | 200.0s | success | 3 |
| case_009 | P0 | 新功能实现 | 3/5 | 0 | 200.0s | success | 3 |
| case_011 | P1 | 重构 | — | — | — | 未跑 | 4.7 |
| case_012 | P1 | 重构 | — | — | — | 未跑 | 5 |
| case_013 | P1 | 多文件协调 | — | — | — | 未跑 | 5 |
| case_015 | P1 | 测试编写 | — | — | — | 未跑 | 5 |
| case_016 | P1 | 测试编写 | — | — | — | 未跑 | 4.1 |
| case_017 | P1 | 依赖管理 | — | — | — | 未跑 | 4.6 |
| case_018 | P1 | MCP工具调用 | — | — | — | 未跑 | 5 |
| case_019 | P1 | MCP工具调用 | — | — | — | 未跑 | 5 |
| case_020 | P2 | 跨语言 | 2/3 | 0 | 200.0s | success | 4 |
| case_021 | P2 | 歧义查询 | 1/3 | 0 | 1001.0s | success | 3 |
| case_022 | P2 | 歧义查询 | 2/5 | 0 | 200.0s | success | 3 |
| case_024 | P2 | 超长上下文 | 2/3 | 0 | 200.0s | success | 4 |
| case_026 | P0 | 文档生成 | — | — | — | 未跑 | 5 |
| case_027 | P0 | bug修复 | — | — | — | 未跑 | 5 |
| case_028 | P1 | 多文件协调 | — | — | — | 未跑 | 5 |
| case_029 | P2 | 对抗性prompt | — | — | — | 未跑 | 3.6 |
| case_030 | P2 | 诚实兜底 | — | — | — | 未跑 | 5 |

## §3 异常 / 反向违规 case

（无）

## §4 人工评分入口

跑完 baseline 后，逐条打开 case yaml，按 1-5 锚点制填 `baseline_scores.sid_code_w0.score`：

- 5 = 完全达成 outcome + 锚点全命中 + 输出清晰
- 4 = 达成 outcome 且 ≥ 2/3 锚点命中（P0 target）
- 3 = 部分达成,1/3 锚点命中（P1 target）
- 2 = 方向对但有错（P2 target）
- 1 = 完全偏离 / 编造
- null = 跑崩 / 未跑

## §5 子系统覆盖（不含 holdout）

- tool/read: 12
- tool/grep: 11
- agent: 8
- llm: 6
- permission: 3
- plan: 3
- command: 2
- checkpoint: 2
- mcp: 2
- context: 2
- memory: 2
- tool/write: 1
- tool/edit: 1
- tool/bash: 1
- tool/glob: 1
- query: 1
