# LLM Judge Prompt v0（占位）

**状态**：W1 不接入。Phase 3 W7 周一开始正式写 v1。

## 为什么 W1 不接

来自 `docs/eval/00-总方案.md §3.4`：

1. methodology §1.2 + §5.9 强制要求 Judge 必须 kappa 校准 ≥ 0.6 才能上生产
2. 校准要先打 10 条 gold case 满分，但 W1 case 都还没写完
3. 25 条手工评分实际很快（每条 2-3 分钟，总共 1 小时）

## TODO（Phase 3 W7 接管）

- [ ] 选 Judge 模型：claude-sonnet-4-6（备选 claude-opus-4-7）
- [ ] 起草 prompt v1（5 段：任务 / 输入 / 评分维度 / 锚点示例 / 输出格式）
- [ ] 选 10 条 gold case（从 W1 的 25 条 + Phase 2 hard task 中混合）
- [ ] 校准：10 条 gold × 3 次 → ρ / mean_delta / max_delta
- [ ] 校准判定见 `07-执行顺序速查.md §5.1.1` 决策树
- [ ] 通过后写 `ADR-007-LLM-Judge-prompt-v1.md`
