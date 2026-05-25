# External Benchmark 接入评估（T-23 §6.5）

> **状态**：评估文档 / 框架就绪，真实接入待 S3+
> **目的**：避免"自家 bench 偏向防护"——内部 benchmark 必须有外部锚校准
> **业界对应**：SWE Atlas 自家 + SWE-bench Verified 对照（标准做法）

## 为什么需要外部锚

CLAUDE.md §0.4 评测纪律不变量第 5 条："自家 bench 偏向防护"——sid-code 自家 30 case 是手写的，不可避免会偏向 sid-code 擅长的任务类型。如果只看自家 baseline_scores 上升，可能只是"sid-code 越来越懂这 30 个 case"而非"sid-code 真的变强"。

外部锚的价值：

| 风险 | 自家 bench 单跑 | 加外部锚后 |
|---|---|---|
| 自家 case 偏向 sid-code 擅长场景 | ⚠️ 看不出 | ✅ 外部 bench 暴露 |
| Grader prompt drift（5d-v2 → v3 让分数虚高） | ⚠️ 内部对比无信号 | ✅ 外部 bench 不变 |
| 跨版本 sid-code 真实能力变化 | ⚠️ baseline 只反映自家 case | ✅ 外部 bench 是绝对锚 |

## 候选 benchmark

| Benchmark | 域 | 工时（含接入） | 优先级 | 备注 |
|---|---|---|---|---|
| **SWE-bench Verified subset (10)** | coding agent | 5 人日 | ★★★ | 业界标准；可走 [[T-21]] Inspect AI |
| **MT-Bench Hard** | LLM judge 校准 | 3 人日 | ★★★ | 校准 sid-code judge 而非 sid-code agent 自身 |
| **HumanEval+** | 代码生成 | 2 人日 | ★★ | 最简单接入；但和 coding agent 痛点不完全重合 |
| **GAIA** | 通用 agent | 5 人日 | ★ | 工具调用 + 多步推理；与 PR-to-Prod 主线偏离 |
| **AppWorld** | 真实应用 | 7 人日 | ★ | API agent，与 sid-code 偏离更大 |

**当前推荐**：SWE-bench Verified subset（10 case）+ MT-Bench Hard。其它 S3+ 视情况评估。

## 目录结构

```
evals/external-benchmarks/
├── README.md                          # 本文件
├── swe-bench/
│   ├── verified-subset.yaml           # 选 10 个 SWE-bench Verified case 的 instance_id
│   ├── runner.ts                      # 跑 SWE-bench 的 wrapper（走 Inspect AI 或自研）
│   └── results-{date}.jsonl           # 跑分历史
├── mt-bench/
│   ├── hard-subset.yaml               # MT-Bench Hard 子集
│   ├── runner.ts                      # 跑 judge 自校准的 wrapper
│   └── results-{date}.jsonl
└── humaneval/
    └── ...
```

## 数据隔离原则

- ❌ **不写** case yaml 的 baseline_scores（external-benchmarks 数据完全独立）
- ❌ **不进** 自家 grader 注册表（rubric_5d / binary_redline 等都不评 external case）
- ✅ **独立** results-{date}.jsonl，按时间戳归档
- ✅ **独立** 报告 `_reports/external/`，与自家 case 分离呈现

## 何时跑

| 频率 | 触发条件 |
|---|---|
| 每月 1 次 | sprint 末（看 self-report 与 external 的 gap 是否扩大） |
| 重大架构升级后 | grader 版本 bump、Skill 大重构、Provider 切换 |
| 外部要求 | 给 UK AISI / METR 等机构发布兼容性数据 |

## 集成路径

### 路径 A：通过 Inspect AI（推荐）

Inspect AI 有现成 SWE-bench / MT-Bench / GAIA / HumanEval 的 task 实现（200+ benchmarks）：

```bash
# 详见 docs/eval/inspect-ai-integration-plan.md
cd evals/inspect
source .venv/bin/activate
inspect eval tasks/swe_bench_verified.py --model anthropic/claude-sonnet-4-5 --limit 10
```

**优点**：实现质量好、社区维护、与业界对齐
**缺点**：Python venv 依赖；需要先做 [[T-21]] Inspect AI 接入

### 路径 B：自研最小适配器

只接 SWE-bench docker container，不依赖 Inspect AI：

```typescript
// evals/external-benchmarks/swe-bench/runner.ts
// 1. clone SWE-bench-Verified instances（一次性）
// 2. 每个 instance：起 docker → mount sid-code → spawn provider → 跑测试
// 3. 写 results-{date}.jsonl
```

**优点**：无 Python 依赖，与 sid-code 1271 单测主栈一致
**缺点**：要自己维护 docker 镜像、SWE-bench 数据下载、测试 runner

**当前决策**：默认路径 A（Inspect AI），路径 B 作为 fallback（如果 Inspect AI 接入受阻）。

## 与自家 case 的差异化报告

每次跑完 external 后，生成对照报告：

```markdown
# Self vs External — 2026-06-01

## Coverage gap
- 自家 P0 case 平均 4.2/5 (84%)
- SWE-bench Verified 10 子集 pass@1: 35%
- Gap: 49pp —— 说明自家 bench 对 sid-code 严重偏向

## Trend
- 2026-05 self avg: 4.0  external pass@1: 32%
- 2026-06 self avg: 4.2  external pass@1: 35%
- self +0.2 / external +3pp —— 进步同方向，但 external 增幅小，警惕"自家 case 漂移"
```

## 与其他 task 的关系

- 上游：[[T-21]] Inspect AI 接入是首选路径
- 上游：[[T-22]] cross-provider 横评数据独立化（external 走同样的隔离原则）
- 下游：M3 Go/No-Go 评审时，self-report 必须配合 external benchmark 数据看
