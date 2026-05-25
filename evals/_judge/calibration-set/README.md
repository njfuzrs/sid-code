# Pairwise Calibration Set（T-13，§6.3）

> **状态**：框架就绪 / 数据待填充 | **创建**：2026-05-26
> **触发**：`docs/eval/investigations/eval-rubric-industry-survey.md` §6.3 T-13
> **目的**：量化自家 LLM judge 的 position bias 与 verdict accuracy

## 与现有 calibration-v3 的关系

| 维度 | calibration-v3 | calibration-set（本目录） |
|---|---|---|
| 范式 | point-wise（单 case 整数评分） | pairwise（A/B 对比） |
| 校准什么 | judge 给单个 response 的**绝对分数准度**（kappa） | judge 在 A/B 对比中的**位置偏置 + verdict 准度** |
| 数据规模 | 约 60 case × 5 judges | 100 对 (good, bad) pair |
| 衡量指标 | Cohen's κ（当前 0.921） | position bias = % verdict 翻转；judge accuracy = % 选对 ground truth |

**关键**：两者**互补，不重复**——point-wise 保证单分数可信度，pairwise 保证排序公正性。

## Pair 数据 schema（pairs.jsonl，逐行 JSON）

```jsonc
{
  "pair_id": "P-001",
  "category": "代码理解",  // 与 case yaml category 对齐
  "user_query": "sid-code 的 Agent 主循环在哪里？",
  "response_A": "src/agent/loop.ts:45 是 runAgenticLoop 主入口，按 stop_reason=tool_use 循环...",
  "response_B": "应该在 src/cli.ts 的 main 函数里",  // 错误答案
  "ground_truth_winner": "A",  // 已知正确选项
  "source": "case_001 真实 sid-code-deepseek 输出 vs 人工构造错误版",
  "notes": "A 版来自 2026-05-22 baseline run；B 版人工构造（误指 cli.ts 入口）"
}
```

**目标分布**：
- 50 对来自 case_001~030 真实 agent 输出（standard pass / known failure 各一）
- 50 对人工构造（已知正确 vs 已知错误）
- 覆盖：代码理解 / bug 修复 / 新功能 / 重构 / 架构 5 个 category 各 ≥10 对

## 跑校准的脚本

`scripts/eval/calibrate-pairwise.ts`（T-13 已就位）：

```bash
# 用 Anthropic claude-sonnet 跑全部 pair
bun run scripts/eval/calibrate-pairwise.ts --judge claude-sonnet-4-5-20250929

# 输出：
#   _judge/calibration-set/results-{date}-{judge}.jsonl   每对 pair 两次（AB + BA）
#   _judge/calibration-set/summary-{date}-{judge}.md     汇总指标
```

## 输出指标

| 指标 | 解读 | 阈值参考 |
|---|---|---|
| `position_bias`（顺序偏置率） | (A 顺序选 A% - B 顺序选 A%) 的绝对值 | <5% 良好；5-10% 边缘；>10% 强偏置 |
| `accuracy_AB`（AB 顺序准确率） | AB 顺序时选对 ground truth 的比例 | ≥70% 可接受；<60% judge 不可信 |
| `accuracy_BA`（BA 顺序准确率） | BA 顺序时选对 ground truth 的比例 | 同上 |
| `accuracy_avg`（顺序平均） | (accuracy_AB + accuracy_BA) / 2 | 同上 |
| `verdict_flip_rate`（翻转率） | AB / BA 顺序下 verdict 不一致的比例 | <10% 良好；>15% 严重 |

## 触发动作

跑完 calibration 后看汇总 markdown：

- **position_bias > 5%** → 启用 swap+average mitigation：每 case 跑 AB + BA 两遍取均值
- **accuracy_avg < 0.7** → 启用 [[T-12 ensemble]]（多 judge majority vote），再跑一次 calibration 看是否回升
- **verdict_flip_rate > 15%** → judge 不可信，告警 + 临时回退到 anchor 主导评分

## 业界对应

> Future AGI 2026 实战手册原话："Build a pairwise calibration set of 100 to 300 cases with known winners.
> Run each pair twice... Anything above 5 percent is real bias; 10 to 15 percent is typical for frontier
> judges per the MT-Bench paper."

## 与其他 task 的关系

- 上游：[[T-10]] task-specific scorer（calibration 数据可作为 binary_redline grader 的 ground truth）
- 上游：[[T-12]] judge ensemble（calibration 触发动作之一）
- 下游：[[T-18]] judge calibration 持续监控（月度跑 calibration 看 drift）
