# Context 子系统 Capability Eval

> **本目录**: 5 个 capability 子系统中的第三个（S0-T04 启动）。
> **设计参考**: [04-phase-4-子系统capability评测.md §7.2.3](../../../docs/eval/04-phase-4-子系统capability评测.md)
> **TODO 入口**: [docs/eval/TODO.md](../../../docs/eval/TODO.md) S0-T04

---

## 子系统职责

`src/context/manager.ts`（Manager） + `src/context/token.ts`（token 估算）+ `src/context/tool-output-masking.ts`（工具输出遮罩）+ `src/context/validator.ts`（消息验证）+ `src/query/auto-compact.ts`（4 级压缩 none/soft/hard/emergency）。

- **token 估算**：ASCII 0.25 token/char，非 ASCII 1.3 token/char（中文加权）
- **压缩级别**：soft 50% → hard 70% → emergency 94%
- **工具输出 masking**：保护窗口 50K token，旧的可修剪输出 ≥ 30K 触发批量遮罩，落临时文件
- **消息验证**：第一条 user / 角色交替 / 内容非空（API 400 防护）

---

## Capability 维度

| 维度 | 测试假设 | 初始通过率预期 | grader 主体 |
|---|---|---|---|
| `signal_retention` | 长输入中嵌入关键信号 X,压缩后回答仍提到 X | 40-60% | 关键词 X 出现在 final_response |
| `token_efficiency` | 短任务下 agent 不应跑长链工具调用(token 浪费) | 50-70% | tools_called 数量 ≤ 阈值 |
| `large_output_masking` | grep 大目录 / 读大文件后,后续步骤仍能正常推进(不被旧输出撑爆) | 30-60% | steps 完成 + 无 API 400 |
| `chinese_context` | 全中文长对话能正确响应(非 ASCII 加权 token 不溢出) | 60-80% | final_response 含中文关键词 |
| `message_validity` | 中途引入异常工具结果,agent 不因消息序列违规而崩溃 | 70-90% | exit_status=end_turn |

---

## case 文件命名

```
case_ctx_{NNN}_{slug}.yaml
```

---

## 跑分入口

```bash
bun run scripts/eval/run-context-capability.ts                # 跑全部
bun run scripts/eval/run-context-capability.ts --case case_ctx_001
bun run scripts/eval/run-context-capability.ts --execute      # 真调 LLM Judge
bun run scripts/eval/run-context-capability.ts --sync         # 回写 baseline_scores
```

---

## 注意事项

1. **无法直接观察压缩级别**：sid-code-live adapter 跑子进程读 session.traj 看不到 contextManager 内部状态。所以本子系统 case 主要从**行为表现**侧推（"关键信号是否保留"、"任务是否完成"），不直接测压缩级别。
2. **长输入构造**：通过把"关键信号"嵌入到 user_query 前部 + 大量填充内容 + 后部 query 来模拟长上下文场景。
3. **token 估算偏差**：模型实际 token 数与 estimateTextTokens 估算有 ±20% 偏差,case 设计时不强依赖精确数字。
