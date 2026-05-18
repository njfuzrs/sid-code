# Plan 子系统 Capability Eval

> **本目录**: 5 个 capability 子系统中的第一个（W9-W10 启动），按 04 §7.2.1 设计。
> **设计 ADR**: [ADR-013](../../docs/adr/ADR-013-Plan子系统capability评测设计.md)
> **Phase 4 总纲**: [04-phase-4-子系统capability评测.md §7.2.1](../../docs/eval/04-phase-4-子系统capability评测.md)

---

## 4 个维度

| 维度 | 测试假设 | 初始通过率预期 | grader 主体 |
|---|---|---|---|
| `plan_generation` | 复杂多步任务下能产出 ≥ 5 步 plan，覆盖关键节点 | 50-70% | `plan_min_steps` / `plan_must_cover` 命中率 + LLM Judge 计划质量 |
| `plan_execution_fidelity` | plan 写完后实际执行步骤与 plan 步骤的对应关系 | 40-60% | 自动：实际执行步骤 / plan 步骤 ratio |
| `plan_recovery` | 注入失败后 plan 是否被显式 update | 20-40%（最低） | 自动：plan 文件 mtime 是否在失败后被 touch + LLM Judge 更新方向 |
| `plan_premature_exit` | 简单任务下 plan 步骤数 ≤ 3（反向断言） | 70-90%（最高） | 自动：`plan_steps <= 3` |

---

## W10 起步规模（最小可信集）

| 维度 | W10 case 数 |
|---|---|
| `plan_generation` | 4-5 条 |
| `plan_execution_fidelity` | 2 条 |
| `plan_recovery` | 1-2 条 |
| `plan_premature_exit` | 1-2 条 |
| **总计** | **8-12 条** |

W10 周四完成。W11-W12 扩到 04 §7.2.1 的 20-40 条目标。

---

## case 文件命名规范

```
plan_NNN_{short_slug}.yaml
```

例：
- `plan_001_express_to_fastify.yaml` — plan_generation 维度，复杂迁移任务
- `plan_007_permission_denied_recovery.yaml` — plan_recovery 维度，注入权限失败

---

## 跑分入口（W10 周四前打通）

```bash
# 跑全部 plan capability case
bun run scripts/eval/run-plan-capability.ts

# 跑单条
bun run scripts/eval/run-plan-capability.ts --case plan_001
```

> ⚠️ 该入口**必须依赖 sid-code-live adapter**（ADR-016），与 smoke 离线模式不同 — capability case 必须现场跑 sid-code，不能用反推 trajectory。

---

## 报告归档

每两周一次 capability tracking 报告：

- `evals/_reports/capability-plan-w{NN}.md` — 跟踪 4 维度通过率 + Δ 真信号判定
- 报告模板见 04 §7.5

毕业为 regression 的 case：在 yaml 改 `eval_type: regression` + 标 `graduated_at: week-{NN}`。

---

## 失败注入约定（plan_recovery 维度）

`plan_recovery` 维度的 case 需要在 yaml 加 `mock_environment` 字段：

```yaml
mock_environment:
  # 注入"权限被拒"
  permission_denials:
    - tool: edit
      file_pattern: "src/llm/**"
      reason: "blocked_by_user"
  # 注入"文件不存在"
  file_not_found:
    - "src/nonexistent.ts"
```

具体实现见 ADR-013 §2.2 + ADR-016（sid-code-live adapter 决定如何注入）。
