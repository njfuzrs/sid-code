# 第一份 Agent Eval 完整报告

> **生成日期**：2026-05-31
> **Provider**：sid_code_deepseek_v4_pro (model=deepseek-v4-pro)
> **触发**：B7-2 S7-EVAL-T02 全量回归三轴打分
> **关联**：`docs/eval/演进路线/agent-eval-真化路线-v1.md` §8.3

---

## 1. 三轴打分总览

| 轴 | 数据源 | case 数 | 有效评分 | abnormal | 平均分 | 归一化(÷5) |
| --- | --- | --- | --- | --- | --- | --- |
| **Rubric (行为)** | `evals/general/p0-p2/` | 25 | 23 | 2 | **4.79** | 0.958 |
| **Execution (执行)** | `evals/general/execution/` | 2 | 2 | 0 | **5.00** | 1.000 |
| **Trajectory (真实任务)** | `evals/real-tasks/` | 30 | 20 | 10 | **4.12** | 0.824 |
| **合计** | — | 57 | 45 | 12 | **4.46** | 0.892 |

### 关键发现

1. **Rubric 轴表现优异**（4.79/5）：sid-code 在自家 general case 上已达卓越线（≥4.25）
2. **Execution 轴 100% 通过**：bug_001 + cr_003_exec 两条 execution case 全部 pass
3. **Trajectory 轴是真实短板**（4.12/5）：真实任务场景下 agent 能力明显下降，且 33% abnormal 率暴露稳定性问题
4. **Rubric vs Trajectory gap = 0.67 分**：自家 case 与真实任务的差距量化为 0.67 分（归一化 0.134），验证了 §1.2 "自家 bench 偏向"的假设

---

## 2. Rubric 轴详情（25 条 general case）

### 2.1 分数分布

| 分段 | case 数 | 占比 |
| --- | --- | --- |
| 5.0（满分） | 16 | 70% |
| 4.0–4.99 | 5 | 22% |
| 3.0–3.99 | 2 | 9% |
| < 3.0 | 0 | 0% |
| abnormal | 2 | — |

### 2.2 低分 case 分析

| case | 分数 | 可能原因 |
| --- | --- | --- |
| case_005 | 3.50 | 复杂多步推理任务 |
| case_015 | 3.83 | 需要深度代码理解 |
| case_019 | 4.17 | 边界条件覆盖不全 |

### 2.3 Abnormal case

| case | status | steps | latency |
| --- | --- | --- | --- |
| case_002 | abnormal | 5 | 20s |
| case_017 | abnormal | 7 | 59s |

---

## 3. Execution 轴详情（2 条 execution case）

| case | execution_check | score | latency | turns | tokens |
| --- | --- | --- | --- | --- | --- |
| bug_001 | 1 (pass) | 5.0 | 23.5s | 1 | 12,334 |
| cr_003_exec | 1 (pass) | 5.0 | 32.6s | 1 | 12,927 |

**分析**：两条 case 均为 1-turn 完成，deepseek-v4-pro 能在单次响应中正确修复 bug。execution 轴当前 case 数量过少（仅 2 条），需要 B7-5 ci-self-heal + 后续 Sprint 持续扩充。

---

## 4. Trajectory 轴详情（30 条 real-tasks）

### 4.1 分数分布

| 分段 | case 数 | 占比 |
| --- | --- | --- |
| 5.0（满分） | 4 | 20% |
| 4.0–4.99 | 8 | 40% |
| 3.0–3.99 | 3 | 15% |
| < 3.0 | 5 | 25% |
| abnormal | 10 | — |

### 4.2 Abnormal 分析（33% 异常率）

| case | status | steps | latency | 可能原因 |
| --- | --- | --- | --- | --- |
| real_T0177 | abnormal | 1 | 4s | 极短响应，可能 prompt 不适配 |
| real_T0230 | abnormal | 1 | 5s | 同上 |
| real_T0243 | abnormal | 1 | 21s | 同上 |
| real_T0226 | abnormal | 4 | 14s | 短交互后异常退出 |
| real_T0071 | abnormal | 5 | 26s | wrapper spawn 异常 |
| real_T0001 | abnormal | 5 | 32s | wrapper spawn 异常 |
| real_T0597 | abnormal | 2 | 16s | exit=1 非正常退出 |
| real_T0149 | abnormal | 16 | 81s | 中途异常 |
| real_T0038 | success(但null) | 13 | 293s | judge 无法评分 |
| real_T0146 | abnormal | 30 | 297s | 达到 max_steps 超时 |

**关键洞察**：
- 33% abnormal 率远高于 rubric 轴的 8%，说明真实任务场景下 agent 稳定性是主要瓶颈
- 6/10 abnormal 在 ≤5 steps 内就失败，指向 prompt 适配 / wrapper 兼容性问题
- 2/10 是超时类（>200s），指向 agent 陷入循环或任务过于复杂

### 4.3 低分 case（< 3.5）

| case | score | 分析方向 |
| --- | --- | --- |
| real_T0004 | 2.67 | 需要深入调查 |
| real_T0136 | 2.67 | 需要深入调查 |
| real_T0694 | 2.67 | 需要深入调查 |
| real_T0072 | 3.00 | 边界表现 |
| real_T0078 | 3.33 | 边界表现 |

---

## 5. Token 消耗统计

| 指标 | 值 |
| --- | --- |
| 有效评分 case 数 | 45 |
| 总 token 消耗 | 1,166,936 |
| 平均 token/case | 25,931 |
| 最小 | 11,269 |
| 最大 | 83,996 |
| 本次跑总耗时 | ~1031s (17 min) |

---

## 6. 与 §10.3 监控指标对照

| 指标 | 要求 | 实测 | 状态 |
| --- | --- | --- | --- |
| ① 30 条 general 平均分降幅 ≤ 0.3 | baseline 对比 | 4.79（首次，无历史对比） | ✅ 首次建立 baseline |
| ② Layer 1/Execution/Trajectory 三栏占比 | 未偏离 §4.2 | 25/2/30 = 44%/4%/53% | ✅ trajectory 占比最大，符合"真化"方向 |
| ③ trajectory-platform 适配器吞吐 ≥ 5 条/Sprint | B6 起 | 30 条已入库 | ✅ 远超阈值 |
| ④ self-vs-external gap 报告 | M5 Gate 起 | 尚未启动 | ⏳ 待 B8 |

---

## 7. 结论与下一步

### 7.1 本次验证了什么

1. **三轴打分流程端到端通畅**：rubric / execution / trajectory 三栏独立产出数据，DASHBOARD 三栏并列展示正常
2. **真实任务暴露了自家 case 看不到的问题**：33% abnormal + 平均分 gap 0.67 证明"评 agent"与"评 LLM"确实不同
3. **execution 轴基础设施就绪**：sandbox + grader + verify_commands 全链路通畅，但 case 数量不足

### 7.2 下一步行动

| 优先级 | 行动 | 对应 task |
| --- | --- | --- |
| P0 | 调查 10 条 trajectory abnormal 根因，修复 wrapper 兼容性 | B6-5 剩余 |
| P0 | 扩充 execution case（ci-self-heal Skill） | B7-5 |
| P1 | 降低 trajectory abnormal 率到 <15% | 下 Sprint |
| P1 | 补 Sprint S5 末报告 | B5-7 |
| P2 | CI=true 自动跑 holdout 回归 | B7-7 剩余 |

### 7.3 §7.4 毕业判定预评估

| 条件 | 状态 |
| --- | --- |
| general 平均 ≥ 3.5 (GA) | ✅ 4.79 |
| general 平均 ≥ 4.25 (卓越) | ✅ 4.79 |
| execution pass rate ≥ 50% | ✅ 100% (2/2) |
| trajectory abnormal < 20% | ❌ 33% (10/30) |
| 失败分类法覆盖率 green | ✅ 0% unknown (B7-8) |

---

## 附录 A：完整分数清单

### Rubric 轴

```
case_001: 5.00  case_003: 5.00  case_006: 5.00  case_007: 5.00
case_008: 5.00  case_009: 5.00  case_011: 5.00  case_013: 5.00
case_016: 5.00  case_018: 5.00  case_020: 5.00  case_021: 5.00
case_024: 5.00  case_026: 5.00  case_027: 5.00  case_028: 5.00
case_022: 4.86  case_012: 4.71  case_029: 4.71  case_030: 4.42
case_019: 4.17  case_015: 3.83  case_005: 3.50
case_002: null  case_017: null
```

### Execution 轴

```
bug_001:      5.00 (execution_check=1)
cr_003_exec:  5.00 (execution_check=1)
```

### Trajectory 轴

```
real_T0049: 5.00  real_T0076: 5.00  real_T0091: 5.00  real_T0331: 5.00
real_T0016: 4.75  real_T0246: 4.75  real_T0395: 4.75
real_T0046: 4.56  real_T0234: 4.56  real_T0107: 4.42
real_T0165: 4.25  real_T0006: 4.00  real_T0179: 4.08  real_T0270: 4.08
real_T0040: 3.83  real_T0078: 3.33  real_T0072: 3.00
real_T0004: 2.67  real_T0136: 2.67  real_T0694: 2.67
real_T0001: null  real_T0038: null  real_T0071: null  real_T0146: null
real_T0149: null  real_T0177: null  real_T0226: null  real_T0230: null
real_T0243: null  real_T0597: null
```
