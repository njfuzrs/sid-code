# sid-code Plan 子系统 Capability Report — Week 11

> **Phase 4 / W11 周三交付**
> **报告类型**: Capability Tracking（04 §7.5 模板 + 5 段结构）
> **Adapter**: sid-code-live (ADR-016) — 首次离开离线 baseline
> **生成时间**: 2026-05-20（W11 周三）
> **Related**: ADR-013（Plan capability 设计）, ADR-016（live adapter）

---

## §1 现状（What is）

### 1.1 W11 capability eval 概览

| 指标 | W11 baseline |
|---|---|
| 总 case 数 | 10（4 维度配额：generation 4 + fidelity 2 + recovery 2 + premature_exit 2）|
| 跑分模型 | qwen3.5-plus（用户 ~/.sid-code/config.yaml 默认；ADR-016 §4.4 偏差 2 改为不强制 claude-sonnet-4-6） |
| Adapter | sid-code-live（ADR-016 落地的最小可用版） |
| LLM Judge | skip-llm-judge（W11 周二省钱模式，仅 assert 评分） |
| Timeout | 360s/case |
| Baseline 数据归档 | `evals/raw-outputs/capability-plan-w11-baseline.jsonl` + `evals/_reports/capability-plan-w11-baseline.json` |

### 1.2 跑分汇总

| Dimension | Cases | Pass Rate | Avg Score | Target | Status |
|---|---|---|---|---|---|
| `plan_generation` | 4 | 0/4 = 0% | 1.23/5 | 4.0 | 🔴 远低 |
| `plan_execution_fidelity` | 2 | 0/2 = 0% | 1.15/5 | 4.0 | 🔴 远低 |
| `plan_recovery` | 2 | 0/2 = 0% | 0.70/5 | 4.0 | 🔴 远低 |
| `plan_premature_exit` | 2 | 2/2 = 100% | 4.65/5 | 4.0 | 🟢 达标 |
| **整体** | **10** | **2/10 = 20%** | **1.79/5** | 4.0 | 🔴 远低 |

### 1.3 跨 case 摘要

| Case | Dim | Score | Steps | Tools | Exit | Plan File | Notes |
|---|---|---|---|---|---|---|---|
| plan_001 | generation | 1.1 | 16 | enter_plan_mode, ls, glob | unknown | ❌ | 进 plan 后只 ls/glob 探索，未写 plan |
| plan_002 | generation | 0.8 | 24 | enter_plan_mode, glob, read_many, read | unknown | ❌ | 同上，更多探索仍无 plan 落盘 |
| plan_003 | generation | 1.5 | 40 | enter_plan_mode, read, glob, grep | unknown | ❌ | 40 步 max_steps 用尽仍无 plan |
| plan_004 | generation | 1.5 | 18 | enter_plan_mode, read_many, grep, read | unknown | ❌ | 同模式 |
| plan_005 | fidelity | 1.5 | 26 | enter_plan_mode, read, glob, grep | unknown | ❌ | 同模式 |
| plan_006 | fidelity | 0.8 | 18 | enter_plan_mode, ls, glob, read_many | unknown | ❌ | 同模式 |
| plan_007 | recovery | 0.7 | 26 | enter_plan_mode, glob, grep, read | unknown | ❌ | mock_environment prompt 注入未触发 plan 更新 |
| plan_008 | recovery | 0.7 | 13 | ls, read, glob | end_turn | ❌ | 没进 plan_mode 就 end_turn |
| plan_009 | premature_exit | 4.3 | 20 | read, grep | unknown | ❌ | 反向断言生效（plan 步数 ≤ 3） |
| plan_010 | premature_exit | 5.0 | 11 | read, exit_plan_mode | end_turn | ❌ | 反向断言生效（plan 步数 ≤ 3） |

`exit=unknown` 的 8 条均为 hardTimer 触发 SIGKILL（adapter 360s 超时，子进程仍在 grep loop）。
`Plan File: ❌` = 10 条全部未生成 ~/.sid-code/plans/plan-*.md 文件。

---

## §2 baseline 解读（Why these numbers）

### 2.1 关键根因：Plan Mode 与 Write 工具的硬性矛盾

直读 transcript（`~/.sid-code/trajectories/sessions/d17ec5ae/session.traj`，单跑 plan_001 做 spot-check）暴露 src/plan 子系统的核心 bug：

```
[1] enter_plan_mode → 输出 prompt: "请使用 write 工具在 ~/.sid-code/plans/plan-*.md 创建计划"
[12] write file=~/.sid-code/plans/plan-2026-05-18T23-44-11.md
     → ⚠️ 权限拒绝: 非交互模式下自动拒绝: 写入路径在工作区外
[14] write file=./plan-2026-05-18T23-44-11.md
     → ⚠️ 权限拒绝: 计划模式下只允许只读操作
```

也就是：
- **src/plan/prompt.ts:8-21**：教 LLM 用 write 工具写计划文件
- **src/permission/checker.ts:370**（plan mode 分支）：plan mode 下**所有 write 都拒绝**

LLM 第一次 write 失败后会"学会"不再尝试，转而用 final_response 直接陈述计划（不落盘）。但 capability grader 需要从 plan 文件读步骤 → 找不到文件 → `plan_min_steps=false`、`cover_hits_ge_4=false` 全 fail。

更糟：plan_premature_exit 维度（plan_009 / plan_010）反而高分通过 — 因为它**反向断言**"plan 步骤 ≤ 3"，没生成 plan 时步数=0 ≤ 3 → 误判通过。这是 capability eval 的过拟合风险（ADR-013 §4.2 已预警）。

### 2.2 plan_generation（4 case）— 全 fail

- 预期 50-70%（ADR-013 §2.1）
- 实测 0%
- 根因：plan 文件未落盘 → 4 维度核心断言 `plan_must_cover_any_of_hit_ge_N` 全失败（grep 空字符串）
- 即使 LLM 真的"心里有计划"，capability grader 看不到 → 信号失效

### 2.3 plan_execution_fidelity（2 case）— 全 fail

- 预期 40-60%
- 实测 0%
- 根因：plan_steps=0（无 plan 文件），fidelity_step_ratio = actual_steps / 0 = Infinity → 不在 [0.5, 2.5] 范围 → fail
- 这个维度严重依赖 plan 文件落盘，2.1 的根因直接传染

### 2.4 plan_recovery（2 case）— 最低维度 0.70

- 预期 20-40%（ADR-013 §1.2 已预测最低）
- 实测 0%（远低预期）
- 根因双重：
  1. plan 文件未落盘 → `recovery_plan_update_count_min` 直接 fail
  2. mock_environment prompt 注入（"Write 到 ~/.sid-code/** 会失败"）在子进程中通过 `--append-system-prompt` 注入，但 sid-code 没识别注入 → 与真 permission denial 行为重叠
- ADR-016 §2.2 prompt-level mock 注入有效性需要 W12 复盘（plan_007/008 都 0.7 → 注入"似乎"生效但成本是 plan 文件没生成）

### 2.5 plan_premature_exit（2 case）— 100% pass

- 预期 70-90%
- 实测 100%（pass=2/2）
- **但这是误报**：plan 步骤 ≤ 3 因为根本没生成 plan，不是 LLM 真的"克制"
- W11.D4 修复 plan write 后，需要重测此维度 — 真实通过率可能下降（因为 LLM 会写 5+ 步 plan 来应对简单任务，premature_exit 反向断言正常发挥）

---

## §3 风险（What could go wrong）

| 风险 | 状态 | 说明 |
|---|---|---|
| premature_exit 100% pass 是误报 | ⚠️ **W11.D4 后必复盘** | 修 write 后此维度可能从 100% → 60-70%（真实信号） |
| plan_recovery 真信号 vs 注入失真 | ⚠️ W12 复盘 | mock 注入和真 permission denial 的混淆需要单独控制 |
| 单维度 case 数过少 | ⚠️ W12 扩量到 5 条/维度 | ADR-013 §2.2 起步规模约定 |
| qwen3.5-plus 的 plan 倾向特殊 | ⚠️ W12 跑 claude-sonnet-4-6 baseline 对比 | 不同 model 在 plan mode 下行为差异未量化 |
| LLM Judge 未跑 | ⚠️ W11.D5 前补 execute 模式 | 仅 assert 评分对 generation/fidelity 信号薄 |
| capability runner 子进程 keep-alive 问题 | ✅ 已修 | D2 中发现 stdout idle 早退 → 改 isDone 检测 + hardTimer kill 兜底 |

---

## §4 决策（What's decided）

### 4.1 W11.D4 改动方向（spec 摘要）

基于 §2.1 根因，最低维度（实际是 plan_generation / fidelity / recovery 三个并列）的根因都指向同一个 bug：**plan write 被拒**。

D4 改动方案（候选，待 D4 spec 落地确认）：

| 候选 | 改动范围 | 优劣 |
|---|---|---|
| **A. plan mode 允许 write `~/.sid-code/plans/`** | src/permission/checker.ts:370 | 最小改动；解锁 write；保留对 src/ 的写禁 |
| B. plan write 改为虚拟内存 store（不落盘） | src/plan/state.ts + grader 改读内存 | 改动大，capability runner 也要改；不推荐 |
| C. plan/prompt.ts 改为"用 final_response 输出计划，不写文件" | src/plan/prompt.ts | 与 src/plan/state.ts:plan_file_path 冲突；不推荐 |

**预选 A**：在 plan mode 下放行 `~/.sid-code/plans/plan-*.md` 路径的 write 调用（路径白名单），其他写入仍拒。改动 < 30 行，单测 ≥ 3 条。

### 4.2 ADR-016 §4.4 已落地的偏差修正（D1 + D2 期间）

- trace upload 默认开启 → cli 加 `--trace-upload-disabled` flag
- baseUrl 透传污染 → adapter 不再注入 LLM_BASE_URL
- SIGTERM kill 不立即生效 → 1.5s 后 SIGKILL 兜底
- **D2 新增**：stdout idle 检测 30s 误杀 → 改为只看 isDone + stream EOF（参考 ADR-016 §4.4 偏差 3 扩展）

### 4.3 不变量 6 解封时机

W11.D4（明天）将首次解封不变量 6（W1 起 65 天首次改 src/）。本报告 §4.1 确认改动靶场为 src/permission/checker.ts，符合"基于 capability baseline 引导改动"的 EDD 原则。

---

## §5 下一步（What's next）

### 5.1 W11.D4（周四，2026-05-21）

| 步骤 | 动作 | 验收 |
|---|---|---|
| 1 | 写 spec：`docs/specs/plan-write-permission-w11.md` | spec 含改动范围 + 单测覆盖 + 预期 capability Δ |
| 2 | 改 src/permission/checker.ts（plan mode 下放行 plan 路径的 write） | diff < 30 行 |
| 3 | 加单测 ≥ 3 条覆盖：plan 路径 ALLOW / 非 plan 路径 DENY / plan mode 外保持原行为 | bun test 全绿 |
| 4 | make build + make test | 1066 → ≥ 1069 pass |
| 5 | 回写 ADR-013 §5 Validation Signal 章节，标记本次解封时间 | ADR-013 更新 |

### 5.2 W11.D5（周五，2026-05-22）

| 步骤 | 动作 | 验收 |
|---|---|---|
| 1 | 跑改后 plan capability eval（execute 模式，含 LLM Judge） | `capability-plan-w11-after.jsonl` 落盘 |
| 2 | 跑改后 smoke 49（验证未引入回归） | smoke 报告 |
| 3 | 在本报告 §6 加"W11 改后 vs 改前 Δ" 表 | 真信号 / 噪声判定 |
| 4 | 写 week-11.md 周报 | 7 段固定结构 |
| 5 | 更新 docs/eval-status.md | Phase 4 W11 标记完成 |

### 5.3 W11.D5 的真信号判定阈值（提前定义，避免事后挪门）

| 指标 | 改前 (D2) | 真信号阈值 | 噪声阈值 |
|---|---|---|---|
| plan_generation pass rate | 0% | ≥ +25pp（即 ≥ 1/4 通过） | < +12pp |
| plan_recovery pass rate | 0% | ≥ +25pp（即 ≥ 1/2 通过 — case 数少不强求高 Δ） | < +12pp |
| plan_premature_exit pass rate | 100% | **不下降** > 25pp（防过拟合） | -|
| 整体 avg score | 1.79 | ≥ 2.5 | < 2.1 |

**真信号定义**：3 个原低分维度都至少进入"接近"阈值（≥ +12pp），且 premature_exit 没暴跌。
**噪声**：只动 1 个维度，或 premature_exit 暴跌（说明改坏了反向断言 case）。

---

## §6 W11.D4 改后跑分（W11 周五回填）

> 此节由 D5 当天填写，模板已就位。

### 6.1 改后 vs 改前 Δ

| Dimension | Before (D2) | After (D5) | Δ | 真信号? |
|---|---|---|---|---|
| `plan_generation` | 0%（avg 1.23） | TBD | TBD | TBD |
| `plan_execution_fidelity` | 0%（avg 1.15） | TBD | TBD | TBD |
| `plan_recovery` | 0%（avg 0.70） | TBD | TBD | TBD |
| `plan_premature_exit` | 100%（avg 4.65） | TBD | TBD | TBD（防过拟合） |

### 6.2 真信号判定

按 §5.3 的阈值规则，最终判定：TBD

---

## 附录 A：失败 case transcript 引用

| case_id | session_id | 关键观察 |
|---|---|---|
| plan_001 | 44d4368a | 16 步 enter_plan_mode + ls + glob，未尝试 write（已学会"plan mode 不能 write"） |
| plan_001（D1 单跑） | d17ec5ae | 21 步含 2 次 write 尝试，**均被 permission 拒绝**（根因证据） |
| plan_002 | aae7d74d | 24 步深度探索，无 plan 落盘 |
| plan_003 | 9afb6727 | 40 步用尽 max_steps，无 plan 落盘 |
| plan_007 | 287a6c8c | 26 步，mock_environment 注入下行为同其他 generation case |
| plan_008 | 0e3b9e36 | 13 步 end_turn，未 enter_plan_mode（trigger_plan_mode 提示有时不生效） |
| plan_010 | d9ce9f19 | 11 步 end_turn 含 2 次 edit package.json **被拒**（plan mode 限制生效但破坏功能） |

## 附录 B：数据归档

- baseline raw: `evals/raw-outputs/capability-plan-w11-baseline.jsonl`（10 行 JSON Lines）
- baseline summary: `evals/_reports/capability-plan-w11-baseline.json`
- after raw / summary: D5 末归档
