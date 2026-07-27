---
title: 无头模式与脚本化
description: 在 CI / 脚本里非交互地跑 sid-code：三种输出格式怎么选、stdout 什么时候会被污染、结构化输出的坑。
---

# 无头模式与脚本化

`-p` 让 sid-code 变成一个能读代码、改文件、跑命令的 CLI 工具，
输出可以喂给 `jq`、进 CI、被别的程序消费。

这页讲三种输出格式的取舍，以及两个会让脚本静默出错的真实坑。

## 快速上手

最简形态：

```bash
sid-code -p "calc.ts 里定义了几个顶层函数？只回一个数字。"
```

要给程序消费就加 `--output-format json`：

```bash
sid-code -p "calc.ts 里定义了几个顶层函数？只回一个数字。" --output-format json
```

实测输出：

```json
{
  "session_id": "20260728-004418-1c608aba",
  "trajectory_path": "/tmp/cleancfg/trajectories/sessions/20260728-004418-1c608aba/session.traj",
  "role": "assistant",
  "content": [
    {
      "type": "thinking",
      "thinking": "文件内容已经读出来了。看一下顶层函数：\n\n1. `add` - 第1行，export function\n2. `total` - 第5行，export function\n3. `bad` - 第9行，const，不是函数\n\n所以有 2 个顶层函数。",
      "durationMs": 1828
    },
    { "type": "text", "text": "2" }
  ],
  "usage": {
    "inputTokens": 75590,
    "outputTokens": 227,
    "cacheCreationInputTokens": 0,
    "cacheReadInputTokens": 69632
  }
}
```

注意 `content` 是**数组**，里面可能混着 `thinking` 块。取最终答案要挑 `type === "text"`：

```bash
sid-code -p "..." --output-format json | jq -r '.content[] | select(.type=="text") | .text'
```

## 三种输出格式

| 格式 | 输出形态 | 什么时候用 |
| --- | --- | --- |
| `text`（默认） | 纯文本，就是模型说的话 | 人看，或答案本身就是要的东西 |
| `json` | 单个 JSON 对象，含 session_id / content / usage | 脚本消费，需要 token 用量或会话 ID |
| `stream-json` | NDJSON 流，逐条消息 | 要实时进度，或当 SDK 用 |

`stream-json` 每行一条消息，实测消息序列：

```text
system:init
user
assistant
result:success
```

最后那条 `result` 才是给程序看的汇总——**它有 `text` / `json` 都没有的 `total_cost_usd`**：

```json
{
  "type": "result",
  "subtype": "success",
  "duration_ms": 6410,
  "duration_api_ms": 6598,
  "is_error": false,
  "num_turns": 1,
  "result": "ok",
  "stop_reason": "end_turn",
  "total_cost_usd": 0.004524167099761398,
  "usage": {
    "inputTokens": 24882,
    "outputTokens": 199,
    "cacheCreationInputTokens": 0,
    "cacheReadInputTokens": 24576
  },
  "session_id": "20260728-010611-b207f47f"
}
```

想在 CI 里按成本告警，用这个：

```bash
sid-code -p "..." --output-format stream-json 2>/dev/null \
  | jq -r 'select(.type=="result") | .total_cost_usd'
```

## ⚠ 坑一：debug 开着会污染 stdout

**这条会让你的 `jq` 直接炸，且原因不明显。**

`debug` 开启时日志走 stdout（无头模式下 `console: true`），于是 `--output-format json`
的输出前面会糊上一大段日志：

```text
[01:06:35] ● [CLI] 调试模式已启用
  {
    "level": "INFO",
    "logFile": "/Users/you/.sid-code/debug.log"
  }
[01:06:35] ● [CONFIG] 加载: CLI
  {
    "provider": "openai",
    ...
```

`jq` 拿到这个只会报解析失败。两种触发方式都要注意：

- 命令行显式加了 `-d` / `--debug`
- `~/.sid-code/app.json` 里 `"debug": true`（**用久了的机器上很可能是这个**——
  比如首次启动生成的是 `"debug": false`，但被谁改过了）

脚本里的稳妥做法是显式确认一次：

```bash
grep '"debug"' ~/.sid-code/app.json
```

CI 里更彻底的隔离——用干净的配置目录：

```bash
export SID_CONFIG_DIR=/tmp/ci-sid-config
mkdir -p "$SID_CONFIG_DIR"
cp ~/.sid-code/settings.json "$SID_CONFIG_DIR/settings.json"
sid-code -p "..." --output-format json | jq .
```

`SID_CONFIG_DIR` 会顶掉 `~/.sid-code`，配置、会话、轨迹全落到新目录，
和你日常用的环境完全隔离。

::: tip 用 stderr 判断成败，不要用 stdout
WARN / ERROR 级日志走的是 stderr（即使没开 debug，关键错误也会兜底写 stderr）。
所以 `2>/dev/null` 丢掉 stderr 是安全的，反过来则不行。
:::

## ⚠ 坑二：`--json-schema` 的结果不在 stdout 上

`--json-schema` 用来约束模型输出成结构化 JSON：

```bash
cat > /tmp/schema.json <<'EOF'
{
  "type": "object",
  "properties": {
    "language": { "type": "string" },
    "functionCount": { "type": "number" }
  },
  "required": ["language", "functionCount"]
}
EOF

sid-code -p "分析 calc.ts，给出语言与顶层函数个数。" --json-schema /tmp/schema.json
```

机制是：给模型挂一个 `StructuredOutput` 工具，工具的 inputSchema 就是你的 schema，
并在系统提示里强制要求"最后必须调一次它"。模型调用时按 schema 递归校验，
不合规就把错误回喂让它重试。

**但在 `-p` 路径上，校验通过的那份结构化数据不会出现在 stdout 上。** 实测输出是模型的散文：

```text
已完成。`calc.ts` 中恰好有两个顶层函数 `add` 和 `total`，语言为 TypeScript，结构化输出已返回。
```

`--output-format json` 也一样——它取的是最后一条 assistant 消息，不是工具捕获的载荷。
所以别指望管道里能直接拿到那个对象。

实际能用的做法二选一：

**① 不用 `--json-schema`，直接在提示词里要 JSON**（最省事，脚本里最常用）：

```bash
sid-code -p '分析 calc.ts。只输出 JSON，形如 {"language":"...","functionCount":0}，不要解释。' \
  --output-format json 2>/dev/null \
  | jq -r '.content[] | select(.type=="text") | .text' \
  | jq .
```

**② 用 `--output-format stream-json`**，从流里捞 `StructuredOutput` 的 tool_use 入参
（`result.result` 仍是模型的文本收尾，不是结构化载荷）。

`--json-schema` 真正发挥作用的地方是**它对模型的约束力**——不合 schema 会被打回重试。
把它当"提高模型产出 JSON 正确率的手段"，而不是"取结构化结果的通道"。

## 组合约束

有两组参数必须成对，写错会直接报错拒绝启动（不是静默降级）：

```text
错误: --input-format stream-json 需要同时指定 --output-format stream-json（双向流式必须成对）。
```

| 你想用 | 必须同时给 |
| --- | --- |
| `--input-format stream-json` | `--output-format stream-json` |
| `--include-partial-messages` | `-p` 且 `--output-format stream-json` |

`--input-format stream-json` 从 stdin 逐条读消息，配合 `--output-format stream-json`
就是双向流——这是把 sid-code 当 SDK 嵌进自己程序的路子。

## CI 里常用的参数

| 参数 | 作用 |
| --- | --- |
| `--max-turns <n>` | 限制 agent 循环轮次，防跑飞 |
| `--verbose` | 输出全量消息数组而非仅最终消息 |
| `--append-system-prompt <text>` | 追加系统提示（注入 CI 上下文） |
| `--strict-mcp-config` | 只用 `--mcp-config` 指定的 MCP server，忽略其他来源 |
| `--plugin-dir <path>` | 会话级加载插件目录 |

一个跑 review 的完整例子：

```bash
git diff main...HEAD > /tmp/pr.diff
sid-code review --diff /tmp/pr.diff
```

`review` 是独立子命令，比自己拼 `-p` 提示词更省事——它内部走的是 `code-review` Skill。

## 权限怎么办

CI 里没人按 y/n。三种做法，安全性递减：

```bash
# ① 推荐：预先在 settings.json 里配 allow 规则，只放开需要的
sid-code -p "..."

# ② 指定这次允许的工具
sid-code -p "..." --allowed-tools read,grep,glob

# ③ 全部跳过确认（只在完全可信的隔离环境用）
sid-code -p "..." --dangerously-skip-permissions
```

::: danger `--dangerously-skip-permissions` 的边界
它跳过所有确认，包括删文件、跑任意命令、`git push`。
只在容器/一次性 CI runner 这种"跑坏了重建就行"的环境用。
本机跑请走 ① 或 ②。细节见[权限与人工确认](/use/permissions)。
:::

## 常见问题

### 项目级 Skill / 命令 / 子代理在 `-p` 下加载不到

这是设计行为：项目级扩展来自仓库，默认视作不可信要用户确认，`-p` 下没法确认 → 跳过。
CI 里要用得显式打开信任（`~/.sid-code/app.json`）：

```json
{ "trust_project_extensions": true }
```

细节见 [Skill](/extend/skills#项目级-skill-写了但模型说不存在)。

### 会不会挂死

有会话级硬顶，超时自动结束并往 stderr 写：

```text
[runHeadless] 会话超过 N 分钟上限，自动结束
```

想更早收口就用 `--max-turns`。

### 怎么拿到这次跑的成本

`--output-format stream-json` 的 `result` 消息里有 `total_cost_usd`（见上文）。
`--output-format json` 只给 `usage` 的 token 数，没有折算好的金额。

### 退出码可靠吗

不完全。有些错误路径会打印中文错误信息但退出码仍是 0（比如
`sid-code mcp remove` 删不存在的 server）。脚本里别只看 `$?`，
关键判断建议解析 `stream-json` 的 `result.is_error` 字段。

### `-p` 和交互模式的行为差异

除了权限确认和项目级扩展信任，还有一处：`-p` 下 TUI 相关的东西全不生效
（键位、Copy Mode、`--inline`）。反过来说，`-p` 里 stdout 是干净的数据通道，
这也是为什么 debug 日志混进 stdout 那么讨厌。

## 相关

- [扩展方式总览](/extend/) — 五条扩展路径怎么选
- [权限与人工确认](/use/permissions) — allow / deny 规则怎么写
- [成本与用量](/use/cost) — token 与成本的完整口径
- [MCP](/extend/mcp) — CI 里配合 `--strict-mcp-config`
- [CLI 参数与子命令](/ref/cli) — 全部参数的完整签名
- [环境变量](/ref/env) — `SID_CONFIG_DIR` 等变量
