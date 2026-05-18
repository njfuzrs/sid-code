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

### 待改进

- [ ] 构造 3 条"差答案"（score 1-2）加入 gold case
- [ ] 构造 2 条"中等答案"（score 3）加入 gold case
- [ ] 用真实 sid-code 跑分结果做第二轮校准
