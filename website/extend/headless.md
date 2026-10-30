---
title: 无头模式与脚本化
description: 在 CI / 脚本里非交互地跑 sid-code：三种输出格式怎么选、stdout 什么时候会被污染、结构化输出的坑。
---

# 无头模式与脚本化

`-p` 让 sid-code 变成一个能读代码、改文件、跑命令的 CLI 工具，
输出可以喂给 `jq`、进 CI、被别的程序消费。

这页讲三种输出格式的取舍，以及几个会让脚本静默出错的真实坑（日志走哪个流、
`structured_output` 什么时候不存在、参数组合约束）。

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
  "content": [{ "type": "text", "text": "2" }],
  "result": "2",
  "usage": {
    "inputTokens": 75590,
    "outputTokens": 227,
    "cacheCreationInputTokens": 0,
    "cacheReadInputTokens": 69632
  },
  "usage_normalized": {
    "uncached": 5958,
    "cache_read": 69632,
    "cache_write": 0,
    "prompt_total": 75590,
    "output": 227
  },
  "model": "deepseek-v4",
  "provider": "openai",
  "total_cost_usd": 0.0041,
  "num_turns": 2,
  "duration_ms": 6410
}
```

（`usage_normalized` 往后几个字段是后来加的，上面数值是示意，不是同一次实测。）

`usage.inputTokens` 的口径**随 provider 变**：Anthropic 下是未命中余量，OpenAI 兼容端点下是含命中的全量。
跨 provider 统计 token 读 `usage_normalized`，它是逐模型归一化后累加的互斥分段，`prompt_total` 与用量账本同口径。
`provider` 在会话中途 fallback 换过 provider 时是逗号拼接的多值。

取最终答案直接读 `result`，它是本次 `-p` 调用里模型全部回答文本按顺序拼接的结果，
与 `text` 格式的输出、`stream-json` 最后那条 `result` 消息的 `result` 字段同口径：

```bash
sid-code -p "..." --output-format json | jq -r '.result'
```

`content` 是同一份内容的分块形式：本次调用里每条 assistant 消息的 `text` 块按顺序排成的数组，
不含 `thinking` / `tool_use` 等块。一次调用可能产生多条带文本的 assistant 消息
（比如模型先写完报告、调一次工具、再补一句收尾），这时 `content` 有多块，
只读 `content[0]` 会漏掉后面的内容。

::: warning 0.1.612 及之前的行为
旧版本 `content` 只取历史里**最后一条** assistant 消息的全部块（含 `thinking`），
也没有 `result` 字段。模型「报告 → 工具调用 → 一句话收尾」时，`content` 只剩那句收尾。
:::

## 三种输出格式

| 格式 | 输出形态 | 什么时候用 |
| --- | --- | --- |
| `text`（默认） | 纯文本，就是模型说的话 | 人看，或答案本身就是要的东西 |
| `json` | 单个 JSON 对象，含 session_id / content / usage / 成本 | 脚本消费，需要 token 用量、成本或会话 ID |
| `stream-json` | NDJSON 流，逐条消息 | 要实时进度，或当 SDK 用 |

`stream-json` 每行一条消息，实测消息序列：

```text
system:init
user
assistant
result:success
```

中间还可能夹着 `{"type":"system","subtype":"status","message":"…","level":"info|warning|error"}`
进度 / 提示消息（压缩、重试、门禁等），解析时按 `type` 过滤即可。其中一条值得认识：
模型跑完工具后只用一句「我接着做…」收尾、却没再调用工具时，会发
`message` 为「本轮以纯文本结束（模型未调用工具）。如需继续，直接回复「继续」。」的 `info` 状态消息；
`-p` 文本模式下同一提示只写 stderr，不污染 stdout。

最后那条 `result` 才是给程序看的汇总，带 `total_cost_usd`（`json` 格式也有同名字段，`text` 没有）：

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

## 日志走哪个流：stdout 是数据通道

**这条搞错会让你的 `jq` 报解析失败，且原因不明显。**

无头模式（`-p`）下日志**一律走 stderr**，stdout 只留结果（text / json / stream-json）。
所以 `--output-format json` 的输出是干净的，`jq` 能直接解析——即使开着 debug：

```bash
sid-code -p "..." --output-format json -d 2>/dev/null | jq .
```

> 历史提示：早期版本（PR #160 之前）debug 日志走 stdout，会把 JSON 糊掉，这一节就是
> 从那个坑留下来的。现在无头模式下 `consoleToStderr` 与 `console` 一起打开
> （`packages/cli/src/cli.ts`），日志全部落到 stderr，坑已经不存在了。
>
> 但**反向的坑还在**：`2>/dev/null` 丢掉的是全部调试线索，出问题时两眼一抹黑。
> 排查时把它留到文件里：`... 2>/tmp/sid.err`。

三种方式都能开 debug（后两种等价，env 优先）：

- 命令行 `-d` / `--debug`
- `~/.sid-code/settings.json` 里 `"debug": true`
- 环境变量 `SID_CODE_DEBUG=1`（或 `true`）

反过来说，**不传 `-d` 就是关的**。虽然 `defaultConfig()` 里写着 `debug: true`，但 CLI
覆盖层算的是 `values.debug || isDebugEnvEnabled(...)`，没传就是 `false`，而它只跳过
`undefined`——所以「什么都不写」拿不到调试日志。

CI 里更彻底的隔离——用干净的配置目录：

```bash
export SID_CONFIG_DIR=/tmp/ci-sid-config
mkdir -p "$SID_CONFIG_DIR"
cp ~/.sid-code/settings.json "$SID_CONFIG_DIR/settings.json"
sid-code -p "..." --output-format json | jq .
```

`SID_CONFIG_DIR` 会顶掉 `~/.sid-code`，配置、会话、轨迹全落到新目录，
和你日常用的环境完全隔离。

::: tip 用 stderr 看日志，用退出码和 result 判成败
stdout 是数据通道，**不要**从里面找「成没成」。判断成败看两处：`$?`（非 0 即失败）
和 `result` 里的 `is_error` / `subtype`（信息比 `$?` 多）。
即使没开 debug，WARN / ERROR 也会兜底写 stderr（`packages/core/src/debug/logger.ts`），
所以 `2>/dev/null` 在脚本里是安全的——只是排查时要记得把它留着。
:::

## 用 `--json-schema` 取结构化结果

`--json-schema` 用来约束模型输出成结构化 JSON。参数既接受**文件路径**，也接受**内联
JSON**（以 `{` 或 `[` 开头即按字面量解析，`packages/cli/src/utils/json-schema-arg.ts`），
后者省掉临时文件：`--json-schema '{"type":"object","properties":{…}}'`。

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

sid-code -p "分析 calc.ts，给出语言与顶层函数个数。" \
  --json-schema /tmp/schema.json --output-format json 2>/dev/null \
  | jq .structured_output
```

机制是：给模型挂一个 `StructuredOutput` 工具，工具的 inputSchema 就是你的 schema，
并在系统提示里强制要求"最后必须调一次它"。模型调用时按 schema 递归校验，
不合规就把错误回喂让它重试。

**校验通过的那份载荷在结果的 `structured_output` 字段里**：

- `--output-format json`：顶层对象的 `structured_output`；
- `--output-format stream-json`：最后一条 `type: "result"`（`subtype: "success"`）消息的 `structured_output`。

取的是**最后一次校验通过**的调用，被打回重试的那几次不会混进来。
模型始终没交出合规输出（重试耗尽、或根本没调工具）时**这个字段不出现**，
脚本里请先判断它是否存在，别把缺失当成空对象。

::: tip 别从 stdout 的文本里取
`--output-format text`（默认）只输出模型的散文收尾，`content` / `result.result`
也是文本，都不是结构化载荷。需要对象就用 `json` 或 `stream-json` 读 `structured_output`。
:::

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

## 作为可编程运行时：SDK 双向流

`-p` 是「发一条、收一个结果」的单轮模式。把 sid-code 嵌进自己的程序（IDE、CI 编排器、
内部平台）时，用 spawn 子进程 + `--input-format stream-json --output-format stream-json`：
stdin 逐条读 NDJSON，stdout 逐条写 NDJSON，跨语言可用。

```bash
sid-code -p --input-format stream-json --output-format stream-json --verbose
```

stream-json 输入下首条 prompt 可以不写在命令行上，由宿主经 stdin 的第一条 `user` 消息送来。

### 能做的三件事

| 能力 | 方向 | 说明 |
| --- | --- | --- |
| 多轮对话 | 宿主 → sid-code | 持续写 `user` 消息，复用同一会话上下文；**每轮**结束各出一条 `result`（含 `total_cost_usd`，注意它是**会话累计**值，不是本轮增量） |
| `can_use_tool` 权限外部接管 | sid-code → 宿主 | 工具需要确认时问宿主，宿主回 `allow` / `deny` / `always_allow` |
| `interrupt` 中断当前轮 | 宿主 → sid-code | 中止正在跑的这一轮，会话不结束，下一条 `user` 消息照常跑 |

数据消息与控制消息共用一条 NDJSON 流，靠 `type` 区分。控制请求带 `request_id`，
响应（`control_response` 的 `success` / `error`）按 id 配对。

控制请求的实现状态：`initialize` / `interrupt` / `set_model` / `get_context_usage` 都能应答。
`initialize` 只接受启动后仍可改的字段——`system_prompt` / `json_schema` / `max_turns` /
`max_budget_usd` 这四个启动期字段会被**明确拒绝**，并告诉你该改用哪个 CLI 参数（而不是
假装设上了）。**只有 `mcp_message` 尚未接线**：发过来会收到 `control_response: error`，
不会被静默丢弃。

### `can_use_tool`：权限谁来批

`-p` 下需要确认的工具无人可问，一律拒绝（fail-closed）。双向流下 sid-code 改为问宿主：

```json
{"type":"control_request","request_id":"…","request":{"subtype":"can_use_tool","tool_name":"write","input":{"file_path":"a.txt","content":"…"},"tool_use_id":"call_1"}}
```

宿主回：

```json
{"type":"control_response","response":{"subtype":"success","request_id":"…","response":{"behavior":"deny","tool_use_id":"call_1"}}}
```

几条边界：

- 只问**需要确认**的工具。allow / deny 规则、`--permission-mode`、PreToolUse hook 照常先生效，
  命中规则的调用不会打扰宿主。
- 宿主回 `deny`、回 `error`、**60 秒不答**、关掉 stdin、或这一轮被 `interrupt`，都按**拒绝**处理，仍然 fail-closed。
- `always_allow` 记为本会话内的放行，同一资源不再问。**但写工具例外**：`write` / `edit` /
  `notebook_edit` 不做会话记忆（同路径不同内容会串味——批准过改注释，再写入 hook 脚本就免确认了，
  `packages/core/src/permission/checker.ts` 的 `extractMemoryResource`），每次仍会问宿主。
- 只有 `--input-format stream-json` 时才会问。只开 `--output-format stream-json` 时 stdin 没有回路，行为与 `-p` 相同。

### `interrupt`

```json
{"type":"control_request","request_id":"i1","request":{"subtype":"interrupt"}}
```

sid-code 回 `{"type":"control_response","response":{"subtype":"success","request_id":"i1"}}`，
当前轮随即结束并出一条 `result`。

### 一次真实往返

下面是 `packages/cli/tests/sdk/sdk-control-protocol-e2e.test.ts` 的消息序列（真实子进程 + 本地假模型）：

```text
[宿主 → sid-code] control_request: set_model（model="x"，不在 availableModels 里）
[sid-code → 宿主] control_response: error（"模型 x 不在可用模型列表中"——已实现的子类型也会明确回错，不静默丢）
[宿主 → sid-code] user：写 denied.txt
[sid-code → 宿主] control_request: can_use_tool（write, tool_use_id=call_deny_1）
[宿主 → sid-code] control_response: deny
[sid-code → 宿主] result（文件没有写出来，模型收到的是拒绝）
[宿主 → sid-code] user：写 allowed.txt
[sid-code → 宿主] control_request: can_use_tool（write）
[宿主 → sid-code] control_response: allow
[sid-code → 宿主] result（allowed.txt 已写出）
```

代价是宿主要自己做 NDJSON 解析、`request_id` 配对和进程生命周期管理。
目前没有可 import 的 SDK 包，接入方式只有 spawn 子进程这一条。

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

# 或者直接从 stdin 读 diff
git diff main...HEAD | sid-code review
```

`review` 是独立子命令，比自己拼 `-p` 提示词更省事——它内部走的是 `code-review` Skill，
提示词随二进制编译期嵌入。Markdown 报告写到 stdout，进度信息写到 stderr，可以直接重定向成文件。

## 权限怎么办

CI 里没人按 y/n。三种做法，安全性递减：

```bash
# ① 推荐：预先在 settings.json 里配 allow 规则，只放开需要的
sid-code -p "..."

# ② 指定这次免确认的工具（认 Claude Code 写法与模式）
sid-code -p "..." --allowed-tools 'Read,Grep,Glob,Bash(git log*)'

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
CI 里要用得显式打开信任（`~/.sid-code/settings.json`）：

```json
{ "trustProjectExtensions": true }
```

它对这台机器上的**所有项目**生效，只建议在受控的 CI 环境里用；项目级 settings 设不了它。
`--yes` / `--dangerously-skip-permissions` / `--trust-workspace` 不会放行未确认的项目级扩展。
细节见 [Skill](/extend/skills#项目级-skill-写了但模型说不存在)。

### 会不会挂死

不会，但兜底的**不是**一个总时长闸门。挂起类根因由几层按「有没有进展」判定的防线覆盖：

| 防线 | 默认值 | 覆盖什么（谓词） |
| --- | --- | --- |
| `network.headerTimeoutMs` | 300s | 请求发出后拿不到首字节（**不在下面的递增链上**，它对齐的是 watchdog 的缺快照兜底 315s） |
| `network.idleTimeoutMs` | 240s | 连一个字节都收不到（真半开 TCP） |
| `network.contentProgressTimeoutMs` | 480s | 有字节但无有效内容（keep-alive / ping 续命也不算进展） |
| `network.fallbackStreamTimeoutMs` | 600s | 降级链里备用 provider 的流式档位 |
| `network.watchdogNoProgressMs` | 720s | 外层复核「已建连但中途静默」，比上面 provider 层更宽 |
| `network.overallTimeoutMs` | 1500s | 单次请求的软兜底（每次尝试重新起表），不因事件重置 |
| `network.maxTurnDurationMs` | 90min | 单轮硬顶，兜任何单次挂起根因。**不感知内容进展**，但会扣除等用户输入与系统休眠的时长（只累计真正的业务耗时） |
| `network.maxTimeoutRetries` | 10 次 | **超时**的重试上限，指数退避 5s→120s（±15% jitter）。只由次数决定：退避等待不计入上面任何一层的「无进展」，所以不会被看门狗提前截断 |

几层的**谓词互不相同**（收不到字节 / 收到字节但没内容 / 整轮兜底），不是同一个判断
复制几遍。真正构成递增链的是
`idle 240s < contentProgress 480s < fallback 600s < watchdog 720s < overall 1500s < maxTurn 5400s`
（相邻间距 ≥120s，有哨兵测试固定）；`headerTimeoutMs` 是并列的另一条，不与它们比大小。

⚠️ **429/5xx 不走 `maxTimeoutRetries`** —— 它只管超时。429/5xx 由降级链自己的漏斗计数，
单次调用内连接阶段 + 流式阶段共享一个上界（`maxRetriesPerCall`，默认 12）。两套计数各管
一段，别用 10 去估算偶发 5xx 的重试总量。

`network.fetchAbsoluteTimeoutMs`（整个 HTTP 请求的绝对上限）**默认关闭**：它与单轮硬顶
判的是同一件事，会把一条持续有输出的慢流一并掐断。它由 runtime 直接中断，`TimeoutError`
的 reason 本身不带归因——开启后这一层会补发一条 `TimeoutFired` 事件，轨迹里查得到是它开的枪。
确有需要时显式设一个毫秒值即可开启。

上面这些**都能写进 `settings.json` 的 `network` 块**，也都有对应的 `SID_CODE_*` 环境变量
（env 优先于 settings）。其中 `SID_CODE_MAX_TURN_DURATION_MS` 目前没进 `--help` 的环境变量
段落，查名字请看[环境变量](/ref/env)。

**会话级硬顶默认关闭**（`network.maxSessionDurationMs = 0`）。它按挂钟计「一次输入触发的连续
自动执行」总时长，跑满即中断本轮、要人再敲一句才继续——这与无人值守跑长任务直接冲突，而且它
无法区分「卡死一小时」和「顺利干了一小时」。经网关转发时模型响应偏慢，多轮叠加很容易撞线。

要为 CI / 批处理设一个总时长兜底，显式开启即可（毫秒）：

```bash
SID_CODE_MAX_SESSION_DURATION_MS=7200000 sid-code -p "..."   # 2 小时
```

或写进 settings.json：

```json
{ "network": { "maxSessionDurationMs": 7200000 } }
```

开启后超时会正常收尾（退出码走成功路径），并往 stderr 写：

```text
[runHeadless] 会话超过 N 分钟上限，自动结束
```

按轮次而非时长收口用 `--max-turns`。

### 怎么拿到这次跑的成本

`--output-format stream-json` 的 `result` 消息与 `--output-format json` 的结果对象里都有
`total_cost_usd`（见上文），两处同源（`sessionState.getEffectiveTotalCostUSD()`，主循环 + 辅助调用）。
它是**会话累计**金额，stream-json 多轮对话时第 N 条 `result` 是前 N 轮的总额，不是第 N 轮的单轮增量。
撞预算硬停时 `json` 还会多带 `error.spentUsd`（以及 `error.limitUsd`）。

### 退出码可靠吗

子命令的报错路径会以非 0 退出（比如 `sid-code mcp remove` 删不存在的 server 退出码是 1），
脚本里可以靠 `$?` 判断。但 `$?` 只能告诉你「成没成」，`-p` 跑完一轮时更多信息在结果里：
解析 `stream-json` / `json` 输出里 `result` 的 `is_error`、`subtype`，能区分是模型报错、
超出轮次还是正常结束，比只看 `$?` 信息更多。

`-p` 的退出码约定：

| 退出码 | 含义 |
| --- | --- |
| `0` | 正常说完 |
| `1` | 运行时异常、预算硬停，或**没有正常说完**：超时重试耗尽、重试期间被中断、停滞叫停、上下文窗口撑爆。`json` 里 `is_error: true`，`error.reason` 是具体原因（如 `timeout_retry_exhausted`） |
| `130` / `143` / `129` | 收到 SIGINT / SIGTERM / SIGHUP。无论信号落在请求在途还是重试退避期，都是这个值 |

会话硬顶（`maxSessionDurationMs`）触发的收尾例外，仍按成功路径退 0（见上一节）。

**停滞叫停（`error_stalled`，缺省不会出现）**：`-p` 缺省完全不启用停滞升级（不注入提示、不叫停、不改收尾闸门），
所以评测和 CI 不会因它改变行为。显式设 `SID_CODE_STALL_ESCALATION_HEADLESS=1` 并打开 `SID_CODE_STALL_HARD_STOP=1`
（或 settings `stallHardStop: true`）后，任务反复改动又改回、或重复操作无新进展时，会被叫停并让模型
总结现状，此时 `stream-json` 的 `result` 里 `subtype` 是 `error_stalled`（`errors` 里有原因）。
这和 `error_during_execution` 是两回事：前者是"卡住了被叫停"，换个提示词或拆小任务重跑有意义。
被叫停时进程以 `1` 退出；要区分「卡住被叫停」和其它失败，读 `subtype`，`$?` 分不出来。

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
