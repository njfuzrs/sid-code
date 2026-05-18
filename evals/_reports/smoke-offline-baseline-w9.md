# Smoke smoke-offline-baseline — W9 报告

> **生成日期**: 2026-05-18
> **输入**: `evals/raw-outputs/bench-results-1779107149530.jsonl`
> **task 数**: 49
> **模式**: sid-code-offline adapter + skip-llm-judge（L3 取常数 3.0）

---

## 1. 执行摘要

W9 起 Phase 4 持续模式启动。本次为**离线 baseline**：用 trajectory-platform 已有 49 条 smoke trajectory 跑三层 grader，跳过 L3 LLM Judge。

| 维度 | 分数 |
|---|---|
| **Final** | 4.04 / 5.0 |
| L1 Outcome | 4.61 / 5.0 |
| L2 Trajectory | 5.00 / 5.0 |
| L3 Process (skipped) | 3.00 / 5.0 |

**Sanity 指标**:
- fallback_missing_trajectory: 0/49
- zero_tool_call: 4/49

> ⚠️ L2=5.00 偏高是因为离线 adapter 拿不到 error / retry / backtrack 信号（这些需要解析 trajectory 细节）。
> ⚠️ L3 全部取常数 3.0，**不能解读为"sid-code 在 L3 拿到 3.0"**。

---

## 2. 总分对比（49 task）

| Layer | Score | 样本数 | 备注 |
| --- | --- | --- | --- |
| L1 Outcome | 4.61 | 49 | must_call_tools / must_include / max_steps 等断言 |
| L2 Trajectory | 5.00 | 49 | step_ratio / error_count（离线 adapter error/retry 恒为 0） |
| L3 Process | 3.00 | 49 | skipped（W9 阶段省钱模式） |
| Final | 4.04 | 49 | 权重 0.4 / 0.2 / 0.4 |

---

## 3. 按难度分桶

| 难度 | task 数 | Avg Final | Avg L1 | Avg L2 |
| --- | --- | --- | --- | --- |
| easy | 10 | 4.09 | 4.72 | 5.00 |
| medium | 11 | 4.07 | 4.69 | 5.00 |
| hard | 28 | 4.01 | 4.54 | 5.00 |

---

## 4. 按 tag 分桶（top 10）

| tag | 命中 task 数 | Avg Final | Avg L1 |
| --- | --- | --- | --- |
| docs | 29 | 4.02 | 4.57 |
| cli | 15 | 4.01 | 4.53 |
| ui | 15 | 4.01 | 4.54 |
| api | 11 | 4.05 | 4.61 |
| bugfix | 11 | 4.08 | 4.70 |
| refactor | 9 | 4.10 | 4.77 |
| config | 8 | 4.03 | 4.56 |
| test | 7 | 4.10 | 4.79 |
| performance | 7 | 4.10 | 4.76 |
| auth | 7 | 3.96 | 4.39 |

---

## 5. 按 primary model 分桶

| model | task 数 | Avg Final | Avg L1 |
| --- | --- | --- | --- |
| claude-opus-4-6 | 18 | 4.03 | 4.59 |
| claude-haiku-4-5-20251001 | 9 | 4.02 | 4.56 |
| claude-opus-4-6[1m] | 8 | 4.08 | 4.71 |
| claude-sonnet-4-6 | 7 | 4.04 | 4.60 |
| claude-opus-4-7 | 3 | 4.13 | 4.83 |
| qwen3.6-plus | 2 | 3.90 | 4.20 |
| claude-opus-4-7[1m] | 1 | 4.00 | 4.40 |
| qwen-plus | 1 | 4.20 | 5.00 |

---

## 6. 最强 5 个 task（差异化优势）

| task_id | Final | difficulty | tags | primary model |
| --- | --- | --- | --- | --- |
| T0001 | 4.20 | hard | refactor,test,docs | claude-opus-4-6 |
| T0006 | 4.20 | hard | refactor,test,docs | claude-opus-4-6 |
| T0011 | 4.20 | hard | refactor,docs,cli | claude-sonnet-4-6 |
| T0045 | 4.20 | hard | docs,cli | claude-opus-4-6[1m] |
| T0077 | 4.20 | hard | auth,api,test | claude-opus-4-7 |

---

## 7. 最弱 5 个 task（改进方向）

| task_id | Final | L1 | L2 | difficulty | tags | exit |
| --- | --- | --- | --- | --- | --- | --- |
| T0131 | 3.20 | 2.50 | 5.00 | hard | auth,api,ui | end_turn |
| T0107 | 3.50 | 3.30 | 5.00 | medium | docs | end_turn |
| T0111 | 3.60 | 3.50 | 5.00 | hard | ui | tool_use |
| T0040 | 3.80 | 4.00 | 5.00 | medium |  | end_turn |
| T0212 | 3.80 | 3.90 | 5.00 | easy | docs | end_turn |

---

## 8. L1 断言失败 Top 10（改进信号）

| 断言 | 失败次数 |
| --- | --- |
| \`within_max_steps\` | 20 |
| \`must_not_call:Agent\` | 3 |
| \`must_include:HTMLElement\` | 1 |
| \`must_include:src/llm/provider.ts\` | 1 |
| \`must_include:src/agent/loop.ts\` | 1 |
| \`must_include:src/tool/registry.ts\` | 1 |
| \`must_include:src/permission/checker.ts\` | 1 |
| \`must_include:TokenMeter.calculateCacheSavings()\` | 1 |
| \`must_include:API调用\` | 1 |
| \`must_include:markdown表格\` | 1 |

---

## 9. 关键 finding & W10 改进方向

### 9.1 离线 baseline 的局限（**重要**，影响数据解读）

- **L1 偏高**：smoke 49 全部来自 trajectory-platform（即用户跑 claude-code/sid-code 产出的真实 trajectory），这些 trajectory 在 Phase 2 自动抽取时 expected.must_call_tools / must_include_keywords 是**从同一批 trajectory 反推出来的**。所以 L1 在离线模式下"自证为真"，**当前 L1=4.61 不代表 sid-code 真实能力**，而是 bench schema 与 trajectory 的自洽程度。
- **L2 偏高**：离线 adapter 没解析 trajectory 细节，error / retry / backtrack 恒为 0，L2 退化为"step_ratio 是否在合理范围"。
- **L3 缺失**：W9 用常数 3.0 占位。
- **Sanity**：0 条 fallback / 4 条 zero_tool_call。fallback=0 说明 49 条 primary sid 全部能在 desensitized 目录找到。

### 9.2 W10 必做（解锁真信号）

1. **L3 Judge 接入**：在 smoke 49 上跑一次真 LLM Judge（约 $0.5-1，~10 min），让 L3 进入真分数体系。
2. **L2 trajectory 细节解析**：在 adapter 里读 trajectory.json 的每一步，统计 error_count（tool_use_id 后接 tool_result.is_error=true）、retry_count（相同工具+相似参数）、backtrack_count（Write 同文件 ≥2 次）。这是 Phase 4 真正能区分 sid-code vs claude-code 的关键。
3. **bench schema 自证问题**：从 Phase 2 反推的 expected 在离线评分中天然偏高，需要在 W10/W11 引入"sid-code CLI 实跑模式"（adapter=sid-code-live），让 L1 真正测出能力差。

### 9.3 W10 capability eval 优先级

按 `docs/eval/07-执行顺序速查.md §6.2`，W9-W10 第一个子系统是 **Plan (`src/plan/`)**。下周开始写 plan 子系统的 4 维度 capability case（20-40 条），同时继续每周五跑 smoke。

---

## 10. 不变量自检

- [x] Transcript 已落盘: `evals/raw-outputs/bench-results-1779107149530.jsonl`
- [x] holdout 未参与（split 文件用的 smoke.txt，不含 holdout）
- [x] 本次跑分未改 src/ 任何文件
- [x] 报告含 sanity 指标 + 已知偏差说明（§9.1）

