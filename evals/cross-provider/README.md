# Cross-provider 横评数据（T-22 §6.5）

> **状态**：框架就绪 / 数据每周自动累积
> **目的**：把"sid-code vs claude-code vs codex"横评从 case yaml 的 baseline_scores 独立出来
> **业界对应**：Artificial Analysis Coding Agent Index — correctness / cost / time / token 独立报告

## 为什么独立化

case yaml 的 baseline_scores 同时存 deepseek 和 opus 跑分，跨 provider 比较时容易把"模型成本差异"混入"agent 能力差异"。独立化后：

- **correctness**：5 分制 average_score，与现有 grader 一致
- **cost**：token usage × 进价表，估算 USD 成本
- **time**：avg_latency_ms，独立报告
- **pass_rate**：score >= 2.5 的比例

## 文件命名

```
evals/cross-provider/
├── README.md                    # 本文件
├── 2026-05-26.md                # 每次跑的人类可读报告
├── 2026-05-26.jsonl             # 每次跑的机器可消费数据
├── 2026-06-02.md
└── ...
```

每次跑 cross-provider-report 写一个时间戳文件——保留所有历史快照，便于做 provider 长期趋势对比。

## 跑命令

```bash
# 默认对比 sid-code-deepseek vs claude-code
bun run scripts/eval/cross-provider-report.ts \
  --providers sid_code_deepseek_v4_pro,claude_code_opus47

# 限定数据起点
bun run scripts/eval/cross-provider-report.ts \
  --providers sid_code_deepseek_v4_pro,claude_code_opus47 \
  --since 2026-05-15

# 自定义输出路径（覆盖默认 cross-provider/{date}.md）
bun run scripts/eval/cross-provider-report.ts \
  --providers sid_code_deepseek_v4_pro \
  --output evals/_reports/sid-self-snapshot.md
```

## Token pricing 表

进价表写在 `scripts/eval/cross-provider-report.ts` 的 `TOKEN_PRICING_USD`：

| Model | Input ($/1M) | Output ($/1M) | Cache Read | Cache Creation |
|---|---|---|---|---|
| claude-sonnet-4-5 | 3 | 15 | 0.3 | 3.75 |
| claude-opus-4-7 | 15 | 75 | 1.5 | 18.75 |
| deepseek-v4-pro | 0.28 | 1.1 | 0.028 | 0.28 |
| default（fallback） | 1 | 5 | 0.1 | 1.25 |

进价表更新规则：

- 模型供应商调价时手动更新，连带写一次 cross-provider-report 看影响
- **不进 grader / 不影响 case yaml baseline_scores**——纯横评工具

## 与 baseline_scores 的边界

| 维度 | case yaml baseline_scores | cross-provider/ |
|---|---|---|
| 生命周期 | 长期（多 sprint 不变） | 短期（每周快照） |
| 数据粒度 | 每 case × 每 provider | 每 provider 汇总 |
| 用途 | 守护回归 / 评分稳定性 | provider 选型 / 成本对比 |
| 是否进 grader | 是 | 否 |
| 是否进 dashboard | 是（按 grader 版本过滤） | 否（独立报告） |

## 与其他 task 的关系

- 上游：[[T-08]] dashboard `--include-legacy` 已分离 grader 版本
- 上游：现有 `scripts/eval/run-cross-baseline.ts` 已支持横评跑分（但混入 baseline_scores）
- 下游：[[T-23]] public benchmark 接入——SWE-bench 横评数据走同样的独立化路径
