# Memory 子系统 Capability Eval

> **本目录**: 5 个 capability 子系统中的第二个（S0-T03 启动）。
> **设计参考**: [04-phase-4-子系统capability评测.md §7.2.2](../../../docs/eval/04-phase-4-子系统capability评测.md)
> **TODO 入口**: [docs/eval/TODO.md](../../../docs/eval/TODO.md) S0-T03

---

## 子系统职责

`src/memory/store.ts`（双层记忆系统）+ `src/tool/memory.ts`（save_memory tool）+ `src/app.ts` 的 memorySummary 注入。

- **全局 memory**：`~/.sid-code/memory/memories.json`
- **项目 memory**：`<cwd>/.sid-code/memory/memories.json`
- 查询优先级：项目 > 全局
- 注入入口：`MemoryStore.generateSummary()`（systemPrompt 拼接，src/app.ts:339 / :763）
- 写入入口：`save_memory` tool（src/tool/memory.ts，让 LLM 主动保存）

---

## Capability 维度（5 维）

| 维度 | 测试假设 | 初始通过率预期 | grader 主体 |
|---|---|---|---|
| `memory_write` | "记住..." 类指令下，agent 能调 save_memory tool 并落到正确 scope | 40-60% | `save_memory` 是否被调用 + 文件是否新增条目 |
| `memory_recall` | seed_memory 注入后，新会话能召回（出现在 final_response） | 40-70% | 关键词出现在 final_response |
| `memory_isolation` | 全局 vs 项目分级正确（global 不能 leak 到不相关 project 的 query 里） | 30-60% | scope 字段正确 + 跨场景隔离断言 |
| `memory_no_pollution` | 临时信息 / 敏感数据（API Key 等）不应被保存 | 60-80% | save_memory 未被调用 + memory 文件无新增 |
| `memory_update` | 偏好变更场景下，agent 应承认并更新（不死磕旧值） | 30-50% | final_response 含新值 + 不显式声明使用旧值 |

---

## case 文件命名

```
case_mem_{NNN}_{slug}.yaml
```

例：
- `case_mem_001_save_user_preference.yaml` — memory_write，标准 "记住" 指令
- `case_mem_005_global_vs_project_isolation.yaml` — memory_isolation
- `case_mem_007_no_save_secrets.yaml` — memory_no_pollution（反向）

---

## 跑分入口

```bash
# 跑全部 memory capability case
bun run scripts/eval/run-memory-capability.ts

# 跑单条
bun run scripts/eval/run-memory-capability.ts --case case_mem_001

# 真调 LLM Judge
bun run scripts/eval/run-memory-capability.ts --execute

# baseline 回写到 yaml（S0-T07 用）
bun run scripts/eval/run-memory-capability.ts --sync
```

> ⚠️ runner 复用 `evals/baseline-sync.ts` 共享模块（与 plan capability 一致）；
> 仅 `--sync` 时回写 case yaml 的 `baseline_scores`，调试单 case 默认不污染。

---

## seed_memory 约定（memory_recall / memory_isolation 维度）

跨会话场景的 case 需在 yaml 加 `seed_memory` 字段，runner 在跑 sid-code 之前先把数据写到对应 scope 的 memories.json：

```yaml
input:
  user_query: 我之前提过的测试框架是什么？
  seed_memory:
    - scope: project
      key: test_framework
      value: vitest
```

具体实现见 `scripts/eval/run-memory-capability.ts` 的 `seedMemory()` 函数。
runner 跑完后会**还原 memory 文件**（恢复到跑前 snapshot），避免污染开发者本地的真实 memory。

---

## 关键挑战

1. **跨会话不可保证**：sid-code 默认无 session-id 时按 cwd 隔离，但 memory 是按 scope（global / project root）持久化，不受 session 影响。test 必须保证跑前清空 / 跑后还原。
2. **save_memory 召唤难度**：LLM 是否调 save_memory 取决于系统提示词中的 usage_guide 是否触发，模型大小敏感。
3. **隔离断言难度**：要测"global memory 不应 leak 到 project A query"，需要构造跨项目场景，这里简化为"在 cwd 下 query 时 global 与 project memory 同时被注入但能区分 scope"。

---

## 失败模式归档

跑分失败的 case 进 `evals/_reports/capability-memory-w{NN}.md` 的 finding 段，类似 plan_005 / plan_006 的诊断流程。
