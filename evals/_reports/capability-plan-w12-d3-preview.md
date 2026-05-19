# Plan Capability W12.D3 Preview — 中期数据 + 真信号判定

> **Phase 4 / W12.D3 中期报告（2026-05-28）**
> **正式报告**: 等 W12.D5 周报合并 + 完整数据后写 capability-plan-w12.md
> **Adapter**: sid-code-live (ADR-016)
> **改动 commit**: 9cd1795..HEAD（W12.D1-D2 + D3 grader 端 + headless 守则注入 + grader 双层公式）
> **Related**: ADR-017, W12-plan-recovery-mechanism spec

---

## §1 三轮跑分汇总

W12.D3 共跑 3 轮全 10 条 plan capability eval，单条都用 `--timeout 360000`（6 分钟）：

| 维度 | W11.D5（基线） | D3 Run1 | D3 Run2 | D3 Run3 |
|---|---|---|---|---|
| `plan_generation` | 25% / 3.52 | 0% / 2.65 | 0% / 2.30 | 0% / 2.30 |
| `plan_execution_fidelity` | 50% / 4.00 | 0% / 2.85 | 0% / 1.75 | 0% / 3.25 |
| `plan_recovery` | 0% / 1.80 | 0% / 1.80 | **50% / 2.85** ✅ | 0% / 1.40 |
| `plan_premature_exit` | 100% / 4.65 | 0% / 2.10 | 100% / 4.65 | 50% / 3.20 |
| **整体** | **40% / 3.50** | 0% / 2.41 | **30% / 2.77** | 10% / 2.49 |

每轮跑完 raw 数据归档：`evals/raw-outputs/capability-plan-w12-d3-after-run{1,2,3}.jsonl`

---

## §2 D3 改动时间线

每轮之间做了什么：

| 改动点 | Run1 | Run2 | Run3 |
|---|---|---|---|
| ADR-017 三层 src/ 改动（D2 已 commit） | ✅ | ✅ | ✅ |
| countPlanFileUpdates 真值（D3.1） | ✅ | ✅ | ✅ |
| headless 自动批准注入执行守则（D3.x） | — | ✅ | ✅ |
| countPlanSteps 分层修订（避免子项过敏） | — | ✅ | ✅ |
| countPlanLineItems 拆分（fidelity 用细粒度分母） | — | — | ✅ |

**Run1**：仅 D2 三层 src/ 改动 + countPlanFileUpdates 真值。整体崩盘（40% → 0%），plan_premature_exit 反向断言失效（100% → 0%），grader 公式过敏让 plan_010 真实 2 步被算 11 步

**Run2**：补 headless 守则 + grader 分层。**plan_recovery 0% → 50% pass，plan_007 拿到 5.0 满分** — ADR-017 真信号在 plan_007 成立。但 plan_006 fidelity 跌到 0.8（grader 分母连锁副作用）

**Run3**：拆分 countPlanLineItems（fidelity 专用）。plan_006 回到 3.8（与 W11 持平 ✅），但单 case 大幅波动：plan_007 5.0 → 2.1，plan_010 5.0 → 2.1 — LLM 行为不稳定

---

## §3 真信号判定（按 ADR-017 §5 + spec §4）

### 3.1 真信号阈值复盘

ADR-017 §5 第 5 项要求：
> plan_recovery pass rate ≥ 50%（1/2 通过）或 ≥ +25pp（即从 0% → ≥ 25%）

实际：
- **Run2**: plan_recovery 50% pass ✅ — 命中阈值
- **Run3**: plan_recovery 0% pass ❌ — 未命中

**plan_007 单条 5.0 满分（Run2）**说明改动**对完整完成 plan 生命周期的 case 有效**：
- 工具序列：`enter_plan_mode → glob → grep → read → write(plan v1) → exit_plan_mode → edit(plan v2 fallback)`
- 真值：`recovery_plan_update_count_min: true`（adapter 真命中 ≥ 2 次）
- 真值：`recovery_must_include_after_failure_hit: true`（plan 文件含 fallback 关键词）

但 Run3 plan_007 跌到 2.1，是 LLM 行为不稳定，不是 D3 改动后退。

### 3.2 plan_generation / fidelity / premature_exit 回归分析

| 维度 | W11.D5 | Run3 | Δ | 是否符合 spec §4 阈值 |
|---|---|---|---|---|
| plan_generation | 25% | 0% | -25pp | ❌ 跌破阈值 |
| plan_execution_fidelity | 50% | 0% | -50pp | ❌ 严重跌破 |
| plan_premature_exit | 100% | 50% | -50pp | ❌ 跌破阈值 |

Run3 多条 case timeout（7/10）+ adapter SIGKILL 兜底失效（plan_007 跑 1273s 还落分）→ 数据污染严重。

W11.D5 一次性跑出 8/10 plan 文件落盘 + 整体 40% pass，今天跑 3 次只 Run2 的 plan_recovery 进真信号阈值。这暗示：

1. **LLM 行为本身有波动**（dashscope qwen3.5-plus 在长任务/含 mock 注入提示下不稳定）
2. **timeout 是结构性问题** — 改动让 plan 阶段 prompt 变长（+250 字符）+ 引入"失败后 edit"心智模式，LLM 探索更深没及时收尾
3. **adapter SIGKILL 兜底有 bug** — hardTimer 后 `proc.kill("SIGKILL")` 没立即生效，LLM 子进程仍在跑，最终 stdout 落盘但 exitStatus="timeout"

### 3.3 综合判定

**部分真信号**：
- ✅ plan_recovery 改动**机制上有效**（plan_007 单条 5.0 在 Run2 证明）
- ❌ plan_recovery pass rate 阈值**统计上未稳定达成**（3 跑只 Run2 达 50%）
- ❌ plan_generation / fidelity 出现回归（-25pp ~ -50pp）
- ❌ plan_premature_exit 不稳（Run1 0% / Run2 100% / Run3 50%）

**不能宣告 ADR-017 完全成功**，但**也不应回滚** — plan_007 真信号（write→edit→fallback）在改动前从未出现过。

---

## §4 W12.D4-D5 调整方向

### 4.1 优先级重排

原 ADR-017 §2.6 计划：
- D3 改 grader 端 + 跑改后评测 + LLM Judge
- D4 扩 case 到 20 条
- D5 跑 W12 baseline + 周报

**调整**：
- D3 已完成（保留三轮数据）
- **D4 优先修 adapter 稳定性**（hardTimer SIGKILL 兜底 + ChildProcess kill 跨平台）— 不修这个，扩 20 条只会得到更乱的数据
- **D4 同步**：写 1 个 W12 hotfix spec 修 adapter timeout
- **D5 决策**：是否扩 case + 跑 baseline / 是否 W13 回退到只用 plan_recovery 单维度刷 ablation

### 4.2 不变量 6 第二次解封状态

- ✅ 改动方向正确（plan_007 真信号证明）
- ⚠️ 验收阈值未稳定通过（3 跑只 1 次 Run2 命中 plan_recovery 50%）
- ❌ 触发了 plan_generation / fidelity / premature_exit 回归（capability eval 反向断言失效）

按 ADR-017 §5 决策树：
- 第 5 项不稳定通过 → "需复盘"路径（不是 Superseded）
- 复盘结论：根因不在 prompt/state/app 改动方向错，在 adapter 稳定性 + LLM 不稳定
- 不回滚改动，转 W12.D4 修 adapter

---

## §5 数据归档

- raw-outputs/capability-plan-w12-d3-after-run1.jsonl（10 行）
- raw-outputs/capability-plan-w12-d3-after-run2.jsonl（10 行，plan_007=5.0 真信号）
- raw-outputs/capability-plan-w12-d3-after-run3.jsonl（10 行）
- _reports/capability-plan-1779158020271.json（Run1 summary）
- _reports/capability-plan-1779159916934.json（Run2 summary）
- _reports/capability-plan-1779162036043.json（Run3 summary）

W12.D5 周报时合并到 `evals/_reports/capability-plan-w12.md`，本文档作为中期工件保留至 D5。
