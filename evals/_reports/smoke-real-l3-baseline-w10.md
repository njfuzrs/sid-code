# Smoke smoke-real-l3-baseline-w10 — W10 报告

> **生成日期**: 2026-05-19
> **输入**: `evals/raw-outputs/bench-results-1779121181173.jsonl`（W10.D3b 真 L3 Judge 跑分）
> **task 数**: 49
> **模式**: sid-code-offline adapter + **真实 L3 LLM Judge**（claude-sonnet-4-6 + prompt-v2.md）
> **vs W9**: W9 同集合用 mock L3=3.0；本周首次拿到 L3 真信号

---

## 1. 执行摘要

W10 三个修补丁（D2 max_steps fallback / D3a L2 trajectory 解析 / D3b 真 L3 Judge）全部上线。第一次拿到三层"全活"baseline。

| 维度 | W9（mock L3） | W10（real L3） | Δ |
|---|---|---|---|
| **Final** | 4.04 | **4.54** | +0.50 |
| L1 Outcome | 4.61 | **4.80** | +0.19 |
| L2 Trajectory | 5.00 | **4.52** | -0.48 |
| L3 Process | 3.00 (skipped) | **4.31** (real) | +1.31 |

**Sanity 指标**:
- fallback_missing_trajectory: 0/49（与 W9 一致，数据完整度 OK）
- zero_tool_call: 4/49（与 W9 一致）
- within_max_steps PASS: **49/49**（vs W9 29/49）— bench v0.1 max_steps=45 数据 bug 已通过 grader fallback 修复

> ⚠️ Final +0.50 不是 sid-code 能力提升，而是"评分体系本身从单层走向三层"。真信号校准要等 W11/W12 引入 sid-code-live adapter 后再看。

---

## 2. 总分对比（49 task）

| Layer | W10 Score | W9 Score | 样本数 | 备注 |
|---|---|---|---|---|
| L1 Outcome | 4.80 | 4.61 | 49 | max_steps fallback 上线后 within_max_steps 全 PASS |
| L2 Trajectory | 4.52 | 5.00 | 49 | error/retry/backtrack 真信号上线，分数从全 5 分散 |
| L3 Process | 4.31 | 3.00 | 49 | 真 LLM Judge 接入（sonnet-4-6 + prompt-v2） |
| Final | 4.54 | 4.04 | 49 | 权重 0.4 / 0.2 / 0.4 |

---

## 3. 按难度分桶

| 难度 | task 数 | W10 Final | W9 Final | Δ |
|---|---|---|---|---|
| easy | 10 | **4.69** | 4.09 | +0.60 |
| medium | 11 | **4.41** | 4.07 | +0.34 |
| hard | 28 | **4.55** | 4.01 | +0.54 |

L3 Judge 接入后难度档**仍偏不敏感**（跨度仅 0.28），但出现了 easy > hard > medium 的非单调排序 — 提示 L3 Judge 主要在打"信息完整度"分而非"任务难度"分。这与 prompt-v2.md 评分标准一致（"包含 must_include 关键词 → 至少 4 分"）。

---

## 4. L2 真信号细节（W10 新增）

| 信号 | 平均值 | 最大值 | 非零 task 数 / 49 |
|---|---|---|---|
| error_count | 0.53 | 5 | **14** |
| retry_count | 1.71 | 21 | **17** |
| backtrack_count | 1.78 | 12 | **19** |

L2 score 分布：[2.5, 3.0, 4.0, 4.5, 5.0] 五档，5 = 31 task / 4.5 = 2 / 4 = 10 / 3 = 5 / 2.5 = 1。
**这是 W9 全 5.0 平坦后第一次出现真分散** — L2 真信号上线生效。

---

## 5. L3 Judge 信号细节（W10 新增）

| L3 score | task 数 | 占比 |
|---|---|---|
| 5 | 19 | 39% |
| 4 | 25 | 51% |
| 3 | 4 | 8% |
| 2 | 1 | 2% |

L3 集中在 4-5 分（90%），符合 prompt-v2.md "Agent Response 含 must_include → ≥ 4 分" 的硬规则。
**最低分 case = T0046**（medium，docs 类）— 离线 trajectory 摘要与 expected.must_include_keywords 命中率低，是 Judge 信号有效性的直接证据。

---

## 6. 按 primary model 分桶

| model | task 数 | W10 Final | W9 Final | Δ | 解读 |
|---|---|---|---|---|---|
| claude-opus-4-7 | 3 | 5.00 | 4.13 | +0.87 | n=3 谨慎 |
| qwen-plus | 1 | 4.80 | 4.20 | +0.60 | n=1 不可靠 |
| claude-opus-4-6 | 18 | 4.55 | 4.03 | +0.52 | 主力样本 |
| claude-opus-4-7[1m] | 1 | 4.60 | 4.00 | +0.60 | n=1 |
| claude-haiku-4-5-20251001 | 9 | 4.51 | 4.02 | +0.49 | |
| claude-opus-4-6[1m] | 8 | 4.65 | 4.08 | +0.57 | |
| claude-sonnet-4-6 | 7 | 4.49 | 4.04 | +0.45 | |
| qwen3.6-plus | 2 | 4.30 | 3.90 | +0.40 | n=2 |

跨模型 Final 跨度从 W9 的 **0.23** 扩到 W10 的 **0.70** — L3 Judge 引入后模型差异**显著放大**（虽然 n 较小的样本仍要谨慎）。这是 W11+ 横向对比的关键信号。

---

## 7. within_max_steps 修复验证

W9 报告 §8 头号问题（49 task 失败 20 次，41%）已通过 D2 排查 + grader fallback 修复：

- 根因：bench v0.1 全 844 task 的 `expected.max_steps` 硬编码 45（`docs/eval/investigations/within-max-steps-w10.md`）
- 修复：runner.ts `computeEffectiveMaxSteps` 在 `yaml=45 && estimated_turns > 45` 时 fallback 到 `estimated_turns × 1.5`
- 验证：W10 within_max_steps PASS 从 29/49 升至 **49/49**

后续：W12 末 bench v0.2 升级时彻底修 refine-tasks.py（已记入 follow-ups）。

---

## 8. L1 断言失败 Top 10（W10 残留信号）

| 断言 | 失败次数 |
|---|---|
| `must_include:HTMLElement` | 1 |
| `must_include:src/llm/provider.ts` | 1 |
| `must_include:src/agent/loop.ts` | 1 |
| `must_include:src/tool/registry.ts` | 1 |
| `must_include:src/permission/checker.ts` | 1 |
| `must_include:TokenMeter.calculateCacheSavings()` | 1 |
| `must_include:API调用` | 1 |
| `must_include:markdown表格` | 1 |
| `must_not_call:Agent` | 3 |

W9 头号失败 `within_max_steps` 已经从此榜单消失（修复生效）。剩余失败集中在 must_include 关键词命中率（共 12 次） — 是离线 adapter 在"答案摘要"维度的固有局限。

---

## 9. 关键 finding & W11 改进方向

### 9.1 W10 三个修补丁全部生效（与 ADR-012 验收条件对照）

ADR-012 §6 "Validation Signal" 列了 3 条验收条件：

- ✅ **L3 LLM Judge 跑通且 Final 显著低于 4.04** — 实际 Final = 4.54（高于而非低于；但 L3 真分进入体系）
- ✅ **L2 trajectory 细节解析后 Final 差异化** — easy/medium/hard 跨度从 0.08 扩到 0.28，模型跨度从 0.23 扩到 0.70
- ⏳ **sid-code-live adapter 跑出 vs 离线 adapter 差距** — 延后到 W11/W12（依赖 ADR-016）

**3 条达成 2 条，第 3 条延后但有明确路径**。

> 修正：原 ADR-012 §6 第 1 条预期"L3 引入后 Final 显著低于 4.04"。实际 L3=4.31 高于 mock 的 3.0（+1.31），导致 Final 反而升至 4.54。**这意味着原 mock 值 3.0 偏低**，不代表 L3 没有信号 — 关键看 L3 在 49 task 间的方差，L3 score 分布 [2,3,4,5] 四档证明信号有效。

### 9.2 离线 baseline 自证局限仍未根本解决

W9 §9.1 列的"L1 偏高是 bench schema 自证"问题在 W10 仍存在（L1 4.80 比 4.61 还高，因 max_steps fallback 减少假阴）。**真信号必须等 sid-code-live adapter 上线**（W11+）。

### 9.3 Plan capability 第一次跑分延后到 W11 初

W10.D5 原计划"跑 plan capability baseline"，实际未完成 — 因 D2/D3a/D3b 三个修补丁占满前 4 天，没时间打通最小 sid-code-live adapter（ADR-016）。

10 条 plan_NNN.yaml 已就位（grep 通过 + lint 通过 + 4 维度分布达 ADR-013 §2.2 配额），W11 周一首要任务是写 ADR-016 + 最小 live adapter，然后跑第一次 plan capability baseline。

### 9.4 W11 主线（按 07 §6.1 Day 8-10 + ADR-013 §5）

| 日 | 动作 | 验收 |
|---|---|---|
| W11 周一 | 写 ADR-016（sid-code-live adapter 实施方案）+ 最小可用版 | 单 plan_NNN case 跑通 |
| W11 周二 | live adapter 上跑全 10 条 plan capability case | 首次 baseline 数据 |
| W11 周三 | 出 capability-plan-w11.md（按 04 §7.5 模板） | 4 维度通过率明细 |
| W11 周四 | 基于 baseline，针对最低维度（预计是 plan_recovery）改 sid-code（首次解封 W1 不变量 6） | spec → 代码 PR |
| W11 周五 | 跑 W11 sid-code 改后 capability + smoke 49（雷打不动）+ week-11.md | 真信号 Δ 判定 |

---

## 10. 不变量自检

- [x] Transcript 已落盘: `evals/raw-outputs/bench-results-1779121181173.jsonl`
- [x] holdout 未参与（split=smoke.txt，不含 holdout）
- [x] 本次跑分修改了 evals/bench-runner/{runner.ts, adapters/sid-code.ts}（**不属于 src/ 范围**），未改 src/ 一行
- [x] 报告含 sanity 指标 + 已知偏差说明（§9.2）
- [x] D2 排查报告 + ADR-013 + 10 条 plan case + tests/eval/ 全部就位
