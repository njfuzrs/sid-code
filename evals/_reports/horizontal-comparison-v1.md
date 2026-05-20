# 横向对比报告 v1 — sid-code vs claude-code

> **生成日期**: 2026-05-21
> **测试集**: 25 条手写 case（P0=10 + P1=9 + P2=6，排除 holdout）
> **sid-code 数据来源**: W1 baseline（离线 adapter，2026-05-16）
> **claude-code 数据来源**: 实时跑分（claude-opus-4-7，2026-05-21）
> **Judge**: claude-opus-4-7 + prompt-v3（ρ=0.921 校准通过）

---

## 1. 执行摘要

| 指标 | sid-code (W1 baseline) | claude-code (opus-4-7) |
|---|---|---|
| **Avg Outcome Score** | 4.80/5 | 3.96/5 |
| **Avg Final Score** | 4.52/5 | 4.04/5 |
| **Pass Rate (≥4.0)** | 92% (23/25) | 72% (18/25) |
| **Perfect Score (5.0)** | 76% (19/25) | 48% (12/25) |
| **Timeouts** | 0/25 | 5/25 (20%) |
| **Total Cost** | $0 (离线) | $13.14 |
| **Avg Turns** | 7.2 | 4.6 |

**结论**: sid-code 在自家 case 上 outcome 分数领先 claude-code 0.84 分（4.80 vs 3.96）。但需注意：
1. sid-code 数据来自离线 adapter（基于已有 trajectory 回放），存在自证偏差
2. claude-code 有 5 条 case 超时（turns=0），拉低了均分
3. 排除超时后，claude-code 有效 case 均分为 4.95/5

---

## 2. 总分对比

### 2.1 Outcome Score 分布

| 分数段 | sid-code | claude-code |
|---|---|---|
| 5.0 | 19 (76%) | 12 (48%) |
| 4.0-4.9 | 4 (16%) | 6 (24%) |
| 3.0-3.9 | 1 (4%) | 0 (0%) |
| 2.0-2.9 | 1 (4%) | 7 (28%) |
| 0-1.9 | 0 (0%) | 0 (0%) |

### 2.2 关键发现

- claude-code 的 7 条 2.0 分全部是 **turns=0 的超时/错误 case**（JSON 解析失败或 CLI 启动问题）
- 当 claude-code 正常运行时（turns > 0），outcome 均分为 **4.95/5**，与 sid-code 持平
- claude-code 的 Judge 分数普遍高于 outcome 分数（avg judge=4.72），说明回答质量好但关键词命中率低

---

## 3. 按类别分桶

| 类别 | sid-code | claude-code | Δ | 说明 |
|---|---|---|---|---|
| 代码理解 | 5.0 | **5.0** | 0 | 两者持平 |
| 新功能实现 | 5.0 | **5.0** | 0 | 两者持平 |
| 文档生成 | 5.0 | **5.0** | 0 | 两者持平 |
| 依赖管理 | 5.0 | **5.0** | 0 | 两者持平 |
| 超长上下文 | 5.0 | **5.0** | 0 | 两者持平 |
| 跨语言 | 5.0 | **5.0** | 0 | 两者持平 |
| 重构 | 5.0 | 4.5 | -0.5 | claude-code 略低 |
| 测试编写 | 4.5 | 4.5 | 0 | 持平 |
| bug修复 | 4.5 | 3.25 | -1.25 | claude-code 有 1 条超时 |
| 对抗性prompt | 5.0 | 4.0 | -1.0 | claude-code 关键词命中少 |
| MCP工具调用 | 4.5 | 3.5 | -1.0 | claude-code 有 1 条超时 |
| 歧义查询 | 4.0 | 3.0 | -1.0 | claude-code 有 1 条超时 |
| 多文件协调 | 4.5 | 2.0 | -2.5 | claude-code 2 条全超时 |
| 诚实兜底 | 5.0 | 2.0 | -3.0 | claude-code 关键词未命中 |

---

## 4. 超时分析

claude-code 有 5 条 case 返回 turns=0（CLI 启动失败或 JSON 解析错误）：

| Case | 类别 | 可能原因 |
|---|---|---|
| case_005 | bug修复 | CLI 启动超时或权限问题 |
| case_013 | 多文件协调 | CLI 启动超时 |
| case_018 | MCP工具调用 | CLI 启动超时 |
| case_022 | 歧义查询 | CLI 启动超时 |
| case_028 | 多文件协调 | CLI 启动超时 |

**根因推测**: claude CLI 的 `--dangerously-skip-permissions` 模式在某些 case 下仍需要交互确认，导致 stdin 阻塞超时。

---

## 5. 效率对比

| 指标 | sid-code | claude-code |
|---|---|---|
| Avg Turns (有效 case) | 7.2 | 4.6 |
| Avg Cost/case | $0 (离线) | $0.66 |
| 最高 cost 单条 | - | $1.73 (case_017 依赖管理, 14 turns) |

claude-code 平均 turns 更少（4.6 vs 7.2），说明 opus-4-7 模型在单次回答中信息密度更高。

---

## 6. 已知偏差与局限

1. **自证偏差**: sid-code 的 W1 baseline 来自离线 adapter（回放已有 trajectory），不是实时跑分。实时跑分可能更低。
2. **Case 设计偏向**: 25 条 case 是为 sid-code 设计的，关键词锚点基于 sid-code 的输出风格。claude-code 可能给出正确答案但关键词不匹配。
3. **超时问题**: claude-code 5 条超时不代表能力不足，可能是 adapter 实现问题（CLI 交互模式）。
4. **模型差异**: sid-code W1 baseline 用的是 qwen3.5-plus（dashscope），claude-code 用的是 opus-4-7。不是同模型对比。
5. **样本量**: 25 条 case 统计意义有限，单条 case 的波动影响大。

---

## 7. 结论与下一步

### 结论

- 在自家 case 上，sid-code 离线 baseline 领先 claude-code 实时跑分 0.84 分
- 但排除超时后，claude-code 有效 case 均分 4.95/5，说明 opus-4-7 模型能力本身很强
- 差距主要来自：(1) 超时/adapter 问题 (2) 关键词匹配风格差异 (3) 离线 vs 实时的自证偏差

### 下一步

- [ ] 修复 claude-code adapter 超时问题（增加 stdin 关闭 / 环境变量配置）
- [ ] 用 sid-code-live adapter 跑同样 25 条 case，消除离线自证偏差
- [ ] 增加 case 数量到 50 条，提高统计显著性
- [ ] 跑 codex adapter（如果可用）形成三方对比

---

## 附录：原始数据

数据文件：`evals/raw-outputs/cross-baseline-claude-code-1779296690069.jsonl`
