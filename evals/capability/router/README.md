# Router 子系统 Capability Eval

> **本目录**: 5 个 capability 子系统中的第四个（S0-T05 启动）。
> **设计参考**: [04-phase-4-子系统capability评测.md §7.2.4](../../../docs/eval/04-phase-4-子系统capability评测.md)
> **TODO 入口**: [docs/eval/TODO.md](../../../docs/eval/TODO.md) S0-T05

---

## 子系统职责

`src/llm/registry.ts`（ProviderRegistry） + `src/llm/fallback.ts`（ModelFallback） + `src/llm/quota.ts`（QuotaManager） + `src/llm/availability.ts`（ModelAvailabilityService）。

- **多 Provider 支持**：Anthropic / OpenAI / Ollama
- **Fallback 配置**：通过 SubAgentModelMap 或 config 切换
- **Quota**：四级预警 50% / 80% / 95% / 100%
- **Availability**：三态健康 healthy / retry_once / terminal

---

## Capability 维度

> 注：sid-code-live adapter 跑子进程是端到端黑盒,无法 mock provider 错误。
> 所以本子系统的 capability case 主要测**契约层**（行为可观察的部分）,而非真实 fallback。

| 维度 | 测试假设 | 初始通过率预期 | grader 主体 |
|---|---|---|---|
| `provider_registration` | sid-code 启动后,registry 含 ≥ 3 家 provider | 80-100% | sid-code config --list 或行为侧推 |
| `quota_alert_visible` | 跑长任务时,若触发 quota 告警,final_response 应提示 | 30-60% | final_response 含 "quota" / "超限" 关键字 |
| `multi_provider_routing` | 询问 agent "你当前用什么模型/provider",应能正确回答 | 50-70% | final_response 含 provider 名 |
| `fallback_message_continuity` | 跑普通任务时,即使 retry 也不应在 final_response 中报"会话已断" | 70-90% | exit_status=end_turn |

---

## case 文件命名

```
case_rtr_{NNN}_{slug}.yaml
```

---

## 跑分入口

```bash
bun run scripts/eval/run-router-capability.ts                # 跑全部
bun run scripts/eval/run-router-capability.ts --case case_rtr_001
bun run scripts/eval/run-router-capability.ts --execute      # 真调 LLM Judge
bun run scripts/eval/run-router-capability.ts --sync         # 回写 baseline_scores
```

---

## 与 S1 红线 RL-011 的关系

S1-T12 / RL-011（禁止模型厂商锁定）守护"Provider 注册 ≥ 3 家厂商"。
本子系统的 `provider_registration` 维度是 RL-011 的**capability 侧**测试,
RL-011 是**红线侧**断言（binary pass/fail）。两者互补,不重复。
