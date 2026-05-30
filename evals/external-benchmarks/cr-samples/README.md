# Code Review 标准化样本集（B8-3 报告轨）

> **状态**：spec + 配置就绪，20 条人工标注样本待 S8 实施
> **关联**：`docs/eval/演进路线/agent-eval-真化路线-v1.md` §15.1（外部锚双轨修订）
> **关联 ADR**：ADR-032（评测主轴权重重平衡）
> **执行入口**：`docs/eval/TODO-M4-M5.md` S8.E EVAL 子线 B8-3
> **业界参照**：JudgeBench（多 judge majority vote 50% → 57%）

---

## 0. 一句话定位

**外部锚报告轨**——sid-code 报告型 Skill（code-review / security-audit / incident-rca）天然没有 FAIL_TO_PASS / PASS_TO_PASS 测试，只能用"人工标注 PR review 样本 + 多 judge majority vote"做盲评校准。S8 起 Sprint 末报告中报告型 Skill 的 self_score 必须配合 `cr_judge_majority` 展示。

---

## 1. 为什么需要报告轨

| 报告型 Skill | execution_test 是否适用 | 报告轨方式 |
| --- | --- | --- |
| code-review（PR 审查） | ❌（产出是 review 意见，无 test） | CR 标准化样本盲评 |
| security-audit（安全审计） | ❌（产出是漏洞报告） | 同 CR + 安全维度补充 |
| incident-rca（事故根因） | ❌（产出是 RCA 报告） | 同 CR + 时序事件维度补充 |
| code-governance（架构治理） | ❌（产出是治理建议） | 同 CR + 架构合规维度补充 |
| ci-self-heal（CI 自愈） | ✅（CI 重新跑通即 pass） | 走执行轨（B8-1） |

**v1.3 §15.1 修订**：报告型 Skill 是 sid-code 战略叙事"为 AI 代码兜底"5 个 Skill 中的 4 个，不能因为"没 test 可跑"被边缘化。报告轨用 CR 标准化样本 + 多 judge majority vote 校准。

---

## 2. 样本来源（≥ 20 条）

### 2.1 来源分布

| 来源 | 条数 | 说明 |
| --- | --- | --- |
| sid-code 自家 git history | 8 | 历史 PR review 评论中标注质量高的 |
| 公开开源 PR review | 8 | OpenSSF / GitHub Top 100 项目精选 |
| 人工合成 hard case | 4 | 业界已知 review 困难场景（race condition / supply-chain attack / 隐式时序依赖） |
| **合计** | **20** | 满足 §4.2 ≥ 20 条门槛 |

### 2.2 难度分布

| 难度 | 条数 | 特征 |
| --- | --- | --- |
| easy | 6 | 单文件 < 100 行 diff，问题点 1–2 个 |
| medium | 10 | 跨 2–3 文件，问题点 3–5 个，含至少 1 个隐含问题 |
| hard | 4 | ≥ 4 文件，问题点 ≥ 5 个，至少 1 个语义陷阱（race / TOCTOU / 隐式契约） |

---

## 3. 样本 schema

每条 CR 样本是一个 yaml 文件，落 `evals/external-benchmarks/cr-samples/samples/cr_NNN.yaml`：

```yaml
id: cr_001
source: "sid-code-self" | "open-source" | "synthetic"
difficulty: easy | medium | hard
language: python | typescript | go | ...
context:
  repo: "sid-code/src/agent/loop.ts" # 仅供 judge 参考；脱敏处理
  pr_title: "..."
  pr_description: "..."
  diff: |
    ... unified diff,严格脱敏后写入 ...

# 人工标注的"标准答案"——由 ≥2 名工程师独立标注后取交集 + 仲裁
ground_truth:
  must_flag:
    - id: "issue_001"
      severity: "P0" | "P1" | "P2"
      category: "bug" | "security" | "perf" | "style" | "test-gap"
      description: "..."
      line_hint: 42 # 期望 review 在 ±5 行内提到
    - id: "issue_002"
      ...
  should_flag: # P3 级别,sid-code 漏掉不算大问题但加分
    - ...
  must_not_flag: # 反例:不应误报
    - description: "代码风格,但当前项目 lint 已豁免"

# 多 judge majority vote 配置
judges:
  - model: "anthropic/claude-sonnet-4-6"
    role: "primary"
  - model: "anthropic/claude-opus-4-7"
    role: "secondary"
  - model: "openai/gpt-5"
    role: "tiebreaker"
  vote: "majority"  # majority / unanimous / weighted

# 评分维度(每维度 0-1)
scoring:
  must_flag_recall:
    weight: 0.5  # P0/P1 漏报严重
    formula: "命中 must_flag 个数 / must_flag 总数"
  should_flag_recall:
    weight: 0.2
  precision:
    weight: 0.2  # 不误报
    formula: "命中(must_flag ∪ should_flag) / 总输出 issue 数"
  ground_truth_alignment:
    weight: 0.1  # judge 对 review 与 ground_truth 描述的相似度评 0-1

threshold:
  pass: 0.7  # 总分 ≥ 0.7 才算 pass
```

---

## 4. 多 judge majority vote 配置

### 4.1 设计原理

JudgeBench（2025）发现单 judge 在 objective 任务上准确率仅 50–57%，多 judge majority vote 能稳定在 57% 以上。本路线采用 **3 judge 配置**：

| Judge 角色 | 模型 | 提示策略 |
| --- | --- | --- |
| primary | claude-sonnet-4-6 | 完整 ground_truth + 评分 rubric |
| secondary | claude-opus-4-7 | 完整 ground_truth + 评分 rubric |
| tiebreaker | gpt-5 | 仅在 primary/secondary 评分差 ≥ 0.2 时启用 |

### 4.2 投票算法

```
def aggregate(p_score, s_score, t_score=None):
    if abs(p_score - s_score) < 0.2:
        return (p_score + s_score) / 2
    # 分歧 → tiebreaker
    return median([p_score, s_score, t_score])
```

### 4.3 防 echo / self-grading 污染

- **禁止**用 sid-code 内置 LLM judge 评 sid-code 的 review（self-grading bias）
- **禁止**让 judge 看 sid-code 的 thinking trace（避免被引导）
- **强制**ground_truth 与 sid-code 训练数据隔离（CR 样本永不进 prompt cache）

---

## 5. 验收标准

- [ ] 20 条 cr_NNN.yaml 落 `evals/external-benchmarks/cr-samples/samples/`
- [ ] 每条样本 ≥ 2 名标注者交集，≥ 1 名仲裁
- [ ] `multi-judge-config.yaml` 落 `evals/external-benchmarks/cr-samples/`
- [ ] runner 跑通 1 条样本 → 3 judge 投票 → 写入 `_reports/external/cr-{date}.md`
- [ ] 与 SWE-bench 执行轨数据**完全不混算**（独立段呈现）

---

## 6. 跑分流程（S8 实施者）

```bash
# 1. 校验所有样本完整性
bun run evals/external-benchmarks/cr-samples/runner.ts --validate

# 2. 跑 sid-code code-review Skill 在所有 20 条样本上
bun run evals/external-benchmarks/cr-samples/runner.ts --skill code-review --provider sid-code-live

# 3. 多 judge 评分
bun run evals/external-benchmarks/cr-samples/runner.ts --judge --config multi-judge-config.yaml

# 4. 生成报告
bun run evals/external-benchmarks/cr-samples/runner.ts --report --output _reports/external/cr-{date}.md
```

---

## 7. 与执行轨的关系（双轨独立）

| 项 | 执行轨（SWE-bench） | 报告轨（CR 样本） |
| --- | --- | --- |
| 适用 Skill | ci-self-heal / code-governance | code-review / security-audit / incident-rca |
| 评分方式 | FAIL_TO_PASS 测试 binary | 多 judge majority vote 0-1 |
| 阈值 | pass@1 = 1（测试全过） | total ≥ 0.7 |
| 报告 | `_reports/external/inspect-{date}.md` | `_reports/external/cr-{date}.md` |
| Sprint 末 | self-vs-external 报告独立段呈现 | 同左 |

---

## 8. 不在本计划范围

- 实际 20 条样本人工标注（S8 实施者按 spec 落地）
- runner.ts 实现（B8-4 双轨 baseline 框架内串通）
- self-vs-external 自动生成模板（B8-5）
- M5 Gate 评审准备（B8-6）
