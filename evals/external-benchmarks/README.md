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
| **SWE-bench Verified subset (10)** | coding agent | 5 人日 | ★★★ | 业界标准；**走路径 B 官方 harness**（2026-08-24 定，见下方「集成路径」） |
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
│   ├── 接入计划.md                     # 路径 B 方案（事实源）
│   ├── verified-subset.yaml           # 选 10 个 SWE-bench Verified case 的 instance_id
│   ├── prompt-v1.txt                  # 阶段 A 产出：带版本号的 prompt 契约
│   └── runs/{run_id}/                 # 三字段 jsonl + 官方 report.json
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
- ✅ **独立** 报告 `evals/_reports/external/`（见该目录 README；⚠️ 是 `evals/` 下那个，
  不是仓库根的 `_reports/` —— 后者不在 git 追踪范围，写进去等于产物丢失）

## 何时跑

| 频率 | 触发条件 |
|---|---|
| 每月 1 次 | sprint 末（看 self-report 与 external 的 gap 是否扩大） |
| 重大架构升级后 | grader 版本 bump、Skill 大重构、Provider 切换 |
| 外部要求 | 给 UK AISI / METR 等机构发布兼容性数据 |

## 集成路径

> **⚠️ SWE-bench 的路径已定，下面两条不再是「待选」**：
> **2026-08-24 裁决走路径 B（官方 `swebench eval`），路径 A（Inspect AI）否决。**
> 完整论证见 `swe-bench/接入计划.md §1`。本节保留两条路径的对比是为了让后来者看到
> 当时在比什么 —— **不要照「当前决策」那行去开工，它已被下面的裁决取代。**

### ~~路径 A：通过 Inspect AI~~（⛔ 已否决）

Inspect AI 有现成 SWE-bench / MT-Bench / GAIA / HumanEval 的 task 实现。

**当时认为的优点**：实现质量好、社区维护、与业界对齐、可复用已有 spike 脚手架
**否决理由**：「复用现有脚手架」实测值为 0（三个文件是伪代码：判分硬编码返 0、
`git clone` 是注释、四个 CLI flag 不存在），而这是 A 的唯一实质优势；
剩下「sandbox 由上游维护」也大半不成立（同样要配 docker、同样的 arm64 问题）。
代价是多两层 Python 框架 + 一个**仓外 venv**。

### ✅ 路径 B：官方 harness（已选）

sid-code 在容器里产出 `git diff` → 三字段 jsonl → 官方 `swebench eval` 判分并读回
`report.json`。**不自己写 scorer、不自己判对错。**

**优点**：只要 `swebench` 一个 pip 包；判分权交给上游，我们只负责「交答案」
**代价**：runner / patch 提取 / 防作弊 preflight 要自己写 —— 但这些**本来也没写**

⚠️ **MT-Bench / HumanEval 的路径未裁决**。上面这条裁决的作用域**只有 SWE-bench**，
别把它推广成「本仓一律不用 Inspect」。

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
