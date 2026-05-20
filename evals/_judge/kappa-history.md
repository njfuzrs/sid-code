# Judge Kappa 校准历史

## v1 (2026-05-18)

| 指标 | v1 (原始 prompt) | v2 (修复后) |
|---|---|---|
| Spearman ρ | 0.289 | 0.354 |
| Mean |Δ| | 2.29 | 1.00 |
| Max |Δ| | 3 | 3 |
| Valid judgments | 21/30 | 24/30 |
| JSON 解析失败 | 9/30 | 6/30 |

### 问题诊断

1. **v1 系统性低估**: Judge 看到 reference_answer（简短摘要）认为"回答不完整"，打 2 分
2. **v2 修复**: 明确告知"Agent Response 是摘要，按信息质量打分"
3. **ρ 仍低的根因**: gold case 全部用满分答案测试，author_score 分布窄（3-5），缺乏区分度

### 决策

- **接受 prompt-v2**，mean_delta=1.0 可接受
- ρ < 0.6 但不阻塞 Phase 3：
  - 根因是测试方法（全用满分答案），不是 Judge 能力
  - Phase 3 后期用真实 agent 回答（好/中/差混合）重新校准
  - 如果真实校准仍 < 0.6，再回来改 prompt

---

## v3 (2026-05-21) ✅ 校准通过

| 指标 | v2 (旧方法) | v3 (新方法 + opus-4-7) |
|---|---|---|
| Spearman ρ | 0.354 | **0.921** |
| Mean |Δ| | 1.00 | **0.78** |
| Max |Δ| | 3 | 2 |
| Valid judgments | 24/30 | **45/45** |
| JSON 解析失败 | 6/30 | **0/45** |

### 改进措施

1. **校准方法升级**：从"10 条 gold case 全用满分答案"改为"5 条 case × 好/中/差 3 种答案 = 15 条"
2. **Judge 模型升级**：从 qwen-plus 升级到 claude-opus-4-7（通过本地代理 127.0.0.1:4000）
3. **Prompt 升级**：prompt-v3.md 加入 few-shot 示例（5 分 + 1 分各一个）+ 更精确的评分锚点

### 按答案质量分组

| 质量 | avg_author | avg_judge | mean_Δ |
|---|---|---|---|
| good | 4.4 | 4.5 | 0.33 |
| medium | 3.0 | 1.8 | 1.20 |
| bad | 1.4 | 0.6 | 0.80 |

### 已知偏差

- medium 答案 Judge 偏低（avg 1.8 vs author 3.0）：Judge 对"泛泛描述"惩罚较重
- 这个偏差方向是安全的（宁可严格不可宽松），不影响 ρ 达标

### 决策

- ✅ **锁定 prompt-v3 + claude-opus-4-7 作为生产 Judge 配置**
- ✅ ρ=0.921 远超 0.6 阈值，校准正式通过
- ✅ JSON 解析成功率 100%（0 失败）
- 后续 Judge 调用统一使用：`model=claude-opus-4-7` / `baseUrl=http://127.0.0.1:4000/v1` / `prompt=prompt-v3.md`
