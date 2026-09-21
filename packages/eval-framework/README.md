# eval-framework — 通用 Agent 评测框架

## 三层 provider 边界（⛔ 不许为「统一目录」合并）

本包的 `providers/` **只装 agent-agnostic、零仓库依赖的在线 wrapper**。
`evals/providers/` 与 `evals/bench-runner/adapters/` 是另外两层，**不是漏搬**。

出处：`core/runner.ts:167-172`（解析 `eval.config.yaml` 的 script 路径时先包内、再仓库根）：

> `evals/providers/` 共性是**依赖仓库自身**（sid-code-live 引 `scripts/eval/raw-jsonl-to-trace.ts`）。
> 搬进包等于让包反向依赖仓库源码、破坏包边界（`bun run lint:boundary` 会拦），
> 所以它们**刻意**留在仓库侧。这不是过渡态，是稳定的职责切分 ——
> 别为了「统一目录」把后两个搬进包。

| 层 | 目录 | 职责 | 判据 |
| --- | --- | --- | --- |
| agent-agnostic **在线** | `packages/eval-framework/providers/` | 实时调 agent，随包分发（`_template.ts` / `aider.ts` / `mock-echo.ts`） | 在代码路径上 ∧ 零仓库依赖 |
| sid-code 特定 **在线** | `evals/providers/` | 实时调，但引仓内脚本 | 在代码路径上 ∧ 依赖本仓 |
| 🔴 **离线**轨迹解析 | `evals/bench-runner/adapters/` | 从已落盘 trajectory 反解 | **根本不调 agent** |

🔴 **`claude-code.ts` / `sid-code-live.ts` 跨层重名是刻意的，⛔ 不许合并。**
在线 = spawn 真 agent（重跑）；离线 = 读历史轨迹（复算）。合并会把两者变成同一个入口，
而「重跑 ≠ 同一份轨迹」（上游非确定性）。

`evals/bench-runner/adapters/codex.ts` 是预留对照位，当前无调用方。
⛔ 不许因零引用删它。

## 快速接入（3 步）

### 1. 写 Provider wrapper

复制 **本包** `providers/_template.ts`（不是 `evals/providers/_template.ts` —— 那个文件不存在），实现 `runAgent()` 函数：

```typescript
async function runAgent(args: ProviderArgs): Promise<AgentResult> {
  // 调用你的 agent（spawn CLI / HTTP API / SDK）
  const proc = spawn("your-agent", ["--prompt", args.prompt]);
  // 收集输出并返回标准格式
  return { output, toolsUsed, filesEdited, numTurns, tokens };
}
```

Provider 脚本的输出契约：stdout 必须是一行 JSON：

```json
{
  "output": "Agent 的最终文本回复",
  "meta": {
    "latency_ms": 12345,
    "exit_status": "end_turn",
    "error_count": 0,
    "retry_count": 0,
    "backtrack_count": 0,
    "tools_used": ["Read", "Edit"],
    "files_edited": ["src/foo.ts"],
    "num_turns": 5,
    "total_tokens": 13000,
    "total_steps": 5
  },
  "error": false
}
```

### 2. 注册到 eval.config.yaml

```yaml
providers:
  your-agent:
    script: ./providers/your-agent.ts
    default_model: your-model-name
    timeout_ms: 480000
    max_turns: 30
    # 可选：模型前缀约束
    constraints:
      model_prefix: "your-"
```

### 3. 运行评测

```bash
# 跑单个 case
bun run eval:run --provider your-agent --cases case_001 --skip-llm-judge

# 跑指定目录的 case
bun run eval:run --provider your-agent --cases-dir ./path/to/cases

# 横评多个 agent
bun run eval:run --provider sid-code,your-agent --skip-llm-judge
```

## 架构概览

```
eval-runner.ts ──spawn──→ provider wrapper ──spawn──→ 被测 Agent
      │                         │
      │                    stdout JSON
      │                         │
      ▼                         ▼
eval-judge.ts ←──────── ProviderResult
      │
      ▼
  5 维评分 / grader 分发
```

核心原则：
- 评分引擎（eval-judge.ts）零 agent 代码 import
- Provider wrapper 是唯一的"脏层"——知道如何启动特定 agent
- 进程级隔离：agent 在独立子进程中运行

## 目录结构

| 路径 | 角色 | 可拔插档位 |
|------|------|-----------|
| `eval-judge.ts` | 5 维评分引擎 | C 档（不可拔插） |
| `eval-runner.ts` | 调度器 | C 档 |
| `_graders/` | Grader 注册表 | A 档（可扩展） |
| `_sandbox/` | Execution grading | A 档 |
| `judge/` | LLM judge：agent-agnostic 的 `prompt-v2.md` + pairwise 类型 | B 档 |
| `providers/` | **仅** agent-agnostic 在线 wrapper | A 档（每个 agent 一个；sid-code 特定的在 `evals/providers/`） |
| `eval.config.yaml` | Provider 注册配置 | A 档 |
| `framework/` | 通用组件 re-export 入口 | — |

## 评分公平性

- Cross-family judge：用 Claude 评 DeepSeek 输出
- temperature=0：消除采样随机性
- snapToTier 吸附：5 档制减少边界跳变
- Echo 排除：prompt 中的关键词不计入命中
- 多采样中位数：N 次采样取中位数
