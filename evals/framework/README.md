# eval-framework — 通用 Agent 评测框架

## 快速接入（3 步）

### 1. 写 Provider wrapper

复制 `evals/providers/_template.ts`，实现 `runAgent()` 函数：

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
| `_judge/` | LLM judge prompt | B 档 |
| `_types/` | Trace 格式定义 | B 档 |
| `providers/` | Provider wrapper | A 档（每个 agent 一个） |
| `eval.config.yaml` | Provider 注册配置 | A 档 |
| `framework/` | 通用组件 re-export 入口 | — |

## 评分公平性

- Cross-family judge：用 Claude 评 DeepSeek 输出
- temperature=0：消除采样随机性
- snapToTier 吸附：5 档制减少边界跳变
- Echo 排除：prompt 中的关键词不计入命中
- 多采样中位数：N 次采样取中位数
