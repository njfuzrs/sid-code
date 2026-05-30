# `evals/_diagnoses/` 诊断证据链 SCHEMA

> **目的**: 建立"低分 case → 根因 → 修复方案"自动化诊断的 ground truth 集 + 误诊沉淀。
> **创建时间**: 2026-05-30（A5-1 / 评测系统报告 §诊断能力 Step 1）
> **配套**: ADR-026（待落盘）/ `eval:diagnose` 脚本（A5-2）/ `eval:verify-diagnosis`（A5-3）

## 目录结构

```
evals/_diagnoses/
├── SCHEMA.md                                 # 本文件
├── dispatch-rules.yaml                       # fix_type 反推规则（A5 Step 4 编写）
├── misdiagnosis-log.jsonl                    # 误诊沉淀（A5 Step 3 写入）
├── <case_id>-<timestamp>.yaml                # 单条 gold diagnosis（≥ 6 条）
└── runs/<run-timestamp>/                     # eval:diagnose 跑批落盘
    ├── input.json                            # 输入 dimensions + sideband
    ├── output.json                           # 推断的 fix_type + confidence + evidence
    └── verify.json                           # 修复后验证结果（verify-diagnosis 写入）
```

## Gold Diagnosis Yaml Schema

每条人工诊断 case **必须** 落盘为 `<case_id>-<YYYY-MM-DD>.yaml`,字段如下:

```yaml
diagnosis_id: case_022-2026-05-20            # 唯一标识: <case_id>-<reviewed_at>
case_id: case_022                             # 关联 case yaml 的 id
case_path: evals/general/p2-edge/case_022.yaml  # 相对仓库根的路径

# === 诊断输入: 当时观测到的维度分数 + sideband ===
dimensions_snapshot:
  anchor_hit: 1.0
  rubric_score: 4.5
  efficiency: 1.0
  tool_compliance: 1.0
  negative_anchor: 1.0                        # 缺则视为 null/未跑
  cost: 0.7                                   # diagnostic 维度 (5d-v2 起 weight=0)
sideband_metadata:
  total_steps: 5
  total_tokens: 8000
  tools_used: [read, grep]
  errors: []                                  # ERROR / TIMEOUT 类计数
  exit_status: success

# === 诊断结论: 期望的根因 + fix_type ===
expected_fix_type: case_design                # case_design / system_prompt / code_bug / infra_bug / model_limit
expected_root_cause: 'anchor "更好" 是用户原话,复读即命中 (echo bias)'
expected_confidence: 0.95                     # 人审认为这个诊断结论的可信度 0-1
key_evidence:                                 # 用于 eval:diagnose 自动匹配的核心证据
  - field: anchor_in_user_query
    value: ['更好']
    rule: 'echo_bias'
  - field: rubric_score
    value: 4.5
    rule: 'high_rubric_with_anchor_echo'

# === 人审元数据 ===
reviewer: zhourusheng
reviewed_at: 2026-05-20
sources:                                      # 诊断结论参考的文档 / commit / 报告
  - docs/eval/edd-iteration-playbook.md#案例-1-case_022-anchor-echo-bias
  - evals/general/p2-edge/case_022.yaml:39-50

# === 修复后验证 ===
post_fix_verification:
  fixed_at: 2026-05-21
  fix_commit: ''                              # 可选,如果当时已 commit
  score_before: 5.0
  score_after: 4.2                            # 修了 anchor 词后真信号回落
  verified: true                              # true=诊断方向正确 / false=误诊
  notes: '修了 anchor 词后真信号回落,符合预期'
```

## Misdiagnosis Log JSONL Schema

`misdiagnosis-log.jsonl` 每行一个 JSON 对象,A5-3 verify-diagnosis 自动写入:

```json
{
  "ts": "2026-06-15T14:32:11.000Z",
  "case_id": "case_005",
  "diagnose_run_id": "wf-2026-06-15T14:00:00",
  "ai_fix_type": "code_bug",
  "ai_confidence": 0.7,
  "ai_root_cause": "agent 没调 read 工具",
  "fix_applied": "改 system prompt 强制 require read",
  "score_before": 1.2,
  "score_after": 1.4,
  "score_diff": 0.2,
  "regression_count": 0,
  "verified": false,
  "actual_fix_type": "case_design",
  "lesson": "must_include 缺少 read 工具调用证据,实际是 case 设计 anchor 缺漏"
}
```

## fix_type 五分类语义

| fix_type | 含义 | 典型证据 | §0.3 审批层级 |
| --- | --- | --- | --- |
| `case_design` | case yaml 本身有问题 | anchor 复读 user_query / 缺反例 / 锚点过宽 | L1 自动 |
| `system_prompt` | sid-code system prompt 引导有偏 | rubric 低 + anchor 高 + tools 不对 | L1 自动 |
| `code_bug` | sid-code 实现有缺陷 | 单 provider 低分 + cross_provider_delta > 0.5 | L3 人审 |
| `infra_bug` | runner / wrapper / sandbox 故障 | total_steps=0 / wrapper exit ≠ 0 / sideband 缺字段 | L1 自动 |
| `model_limit` | 模型自身能力上限 | 多 provider 均低分 + cross_provider_avg < 0.5 | 不修代码 |

冲突规则（与 dispatch-rules.yaml 同步）:

1. `infra_bug` 信号最确定（sideband 数据异常）→ 优先级最高
2. `model_limit` 需要 cross_provider 数据,优先级次之
3. `case_design` 与 `system_prompt` 边界靠 evidence 字段量化
4. `code_bug` 是兜底——其它三类不命中时,单 provider 低分归 code_bug

## 命名约束

- `<case_id>-<YYYY-MM-DD>.yaml`: 同一 case 多次诊断（fix 后再发现新问题）按日期区分
- 不删除历史诊断 yaml: 保留证据链,误诊也是数据

## 与已有 Gold Set 的区别

| 项目 | `_judge/gold-cases/` | `_diagnoses/` |
| --- | --- | --- |
| 用途 | grader **判分准确率** 校准 | **诊断准确率** 校准 |
| 输入 | case yaml + agent output | dimensions_snapshot + sideband |
| 输出 | (pass, score, reason) | (fix_type, confidence, evidence) |
| 当前数量 | 10 条 | ≥ 6 条（A5-1 起,目标 M3 ≥ 12） |
