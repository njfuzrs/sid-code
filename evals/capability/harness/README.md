# Harness 子系统 Capability Eval

> **本目录**: 5 个 capability 子系统中的第五个,也是最重要的（S0-T06 启动）。
> **设计参考**: [04-phase-4-子系统capability评测.md §7.2.5](../../../docs/eval/04-phase-4-子系统capability评测.md)
> **TODO 入口**: [docs/eval/TODO.md](../../../docs/eval/TODO.md) S0-T06

---

## 子系统职责

`src/agent/loop.ts`（AgentLoopRunner）+ `src/agent/loop-detection.ts`（LoopDetector）+ `src/query/auto-compact.ts`（auto-compact）+ retry / circuit-breaker。

> **战略地位**: harness 的乘数效应是 sid-code 项目最重要的差异化武器（参考 sid-code.md 战略总纲:
> "Grok Code Fast 换 Harness 从 6.7% → 68.3%"）。
> 但完整的 ablation 实验（开/关 loop_detection / auto_compact 等组合）需要 sid-code 支持
> runtime flag toggle,当前不支持,所以本子系统当前 case 主要测**可观察行为**。
> S2/S3 阶段补 ablation 实验（M1 验收要求）。

---

## Capability 维度

| 维度 | 测试假设 | 初始通过率预期 | grader 主体 |
|---|---|---|---|
| `loop_detection_trigger` | 故意诱导循环(读不存在文件 N 次),agent 应 ≤ 阈值终止 | 40-70% | tools_called 中相同工具 ≤ 阈值 |
| `loop_recovery_pivot` | 触发循环后,agent 是否换工具/换路径(LOOP_RECOVERY_PROMPT 注入观察) | 30-60% | 工具序列含 ≥ 2 种不同工具 |
| `harness_long_task_completion` | 中等复杂任务(20-30 步)能否在合理时间内完成 | 50-80% | exit_status=end_turn + steps 在范围 |
| `harness_no_zombie_after_error` | 工具报错后,agent 应继续推进或正确收尾,不卡死 | 60-80% | exit_status 不是 timeout/unknown |
| `harness_step_budget` | max_steps 守护生效,不超 budget(防御性) | 70-90% | steps ≤ max_steps |

---

## case 文件命名

```
case_hrn_{NNN}_{slug}.yaml
```

---

## 跑分入口

```bash
bun run scripts/eval/run-harness-capability.ts                # 跑全部
bun run scripts/eval/run-harness-capability.ts --case case_hrn_001
bun run scripts/eval/run-harness-capability.ts --execute      # 真调 LLM Judge
bun run scripts/eval/run-harness-capability.ts --sync         # 回写 baseline_scores
```

---

## 与 S1 红线 RL-004 的关系

S1-T06 / RL-004（不无限循环）守护"单次执行 token < $5,重试 < 3 次"。
本子系统的 `loop_detection_trigger` 维度是 RL-004 的**capability 侧**测试,
RL-004 是**红线侧**断言（binary pass/fail）。两者互补,不重复。

---

## 后续扩展（S2 起）

完整的 5 维度（包含 ablation）需要：
1. **harness_ablation 维度**：sid-code 加 `--disable-loop-detection` / `--disable-auto-compact` flag
2. **harness_overhead 维度**：harness 全开 vs 全关的 token / time 对比矩阵
3. **circuit_breaker 维度**：连续失败触发断路状态切换

这些需要 src/cli.ts 加 flag + ADR,不在 S0 范围内。
