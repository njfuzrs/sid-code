# Anthropic Claude API — 完整接口参考

> 来源：docs.anthropic.com（API reference / Build with Claude / Models / Pricing 各页，2026-06 联网核对；2026-06-27 经 tavily 二次校验补全）
> 主要页面：
> - Messages API：https://docs.anthropic.com/en/api/messages
> - 认证与版本：https://docs.anthropic.com/claude/reference/getting-started-with-the-api · https://docs.anthropic.com/claude/reference/versioning
> - 错误码：https://docs.anthropic.com/en/api/errors
> - 工具使用：https://docs.anthropic.com/en/docs/build-with-claude/tool-use/overview
> - 扩展思考：https://docs.anthropic.com/en/docs/build-with-claude/extended-thinking
> - 提示缓存：https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching
> - 计数与定价：https://docs.anthropic.com/en/docs/build-with-claude/token-counting · https://docs.anthropic.com/en/docs/about-claude/pricing
> - 模型总览：https://docs.anthropic.com/en/docs/about-claude/models/overview
>
> 用途：
> 1. 给 sid-code provider 层（`src/llm/anthropic.ts`）开发提供权威参数 / 协议参考；
> 2. 供团队学习 Claude API 全貌。
>
> 边界：本文是**完整 API 参考**；**流式 SSE 协议状态机**已在 `anthropic-messages-api.md` 深度覆盖，本文只简要带过。价格 / token 数等数字以 tavily 官方拉取为准；拉不到的项标注「以官方文档为准」。模型迭代很快，正式接入前请再核对官方页面。

---

## 1. API 总览

Claude API 是位于 `https://api.anthropic.com` 的 RESTful 接口，提供对 Claude 模型与托管 Agent 的编程访问。

### 1.1 端点清单

正式可用（GA）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/v1/messages` | 创建一条 Message（核心对话推理端点） |
| POST | `/v1/messages/batches` | 批量请求（Message Batches API，异步，享折扣） |
| POST | `/v1/messages/count_tokens` | 计算一组消息的输入 token 数 |
| GET | `/v1/models` | 列出可用模型 |
| GET | `/v1/models/{model_id}` | 查询单个模型的能力与限制 |

Beta（需 beta header 或处于公测）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST/GET | `/v1/files` | Files API：上传 / 引用文件 |
| POST/GET | `/v1/skills` | Skills |
| POST/GET | `/v1/agents` | 托管 Agent |
| POST | `/v1/sessions` · GET `/v1/sessions/{id}/stream` | 有状态会话 |
| POST/GET | `/v1/environments` | 执行环境 |

> `/v1/agents`、`/v1/sessions`、`/v1/environments` 这组托管 Agent 端点是**端点级 beta**：每次请求都要带 `anthropic-beta: managed-agents-2026-04-01` 头。多个 beta 特性用逗号分隔（`anthropic-beta: feature1,feature2`）。无效 / 未启用的 beta 头会返回 400 `invalid_request_error`（message 形如 `Unsupported beta header: ...`）。

### 1.2 请求大小限制

| 端点 | 最大请求体 |
| --- | --- |
| Messages、Token Counting | 32 MB |
| Message Batches API | 256 MB |
| Files API | 500 MB |
| Sessions / Agents / Environments | 32 MB |

超限返回 413 `request_too_large`。合作平台另有限制：Vertex AI 30 MB、Bedrock 20 MB。

---

## 2. 认证与请求头

所有请求必须携带以下 header（使用官方 SDK 时自动注入）：

| Header | 取值 | 是否必需 |
| --- | --- | --- |
| `x-api-key` | Console 申请的 API Key | `x-api-key` 与 `Authorization` 二选一 |
| `Authorization` | `Bearer <token>`，`<token>` 是经 Workload Identity Federation 从 `POST /v1/oauth/token` 换取的短期访问令牌 | 二选一 |
| `anthropic-version` | API 版本，例如 `2023-06-01` | 是 |
| `content-type` | `application/json` | 是 |
| `anthropic-beta` | 启用 beta 特性，逗号分隔多个，例如 `interleaved-thinking-2025-05-14` | 否 |

### 2.1 anthropic-version

`anthropic-version` 锁定 API 行为版本。当前推荐 `2023-06-01`。对给定版本，Anthropic 承诺保持已文档化字段的稳定语义；但可能新增字段 / 事件类型，因此客户端需对**未知字段与未知 SSE 事件类型保持宽容**（见 §10）。

### 2.2 响应头

每个响应都含：

| Header | 说明 |
| --- | --- |
| `request-id` | 请求唯一 ID，排障 / 提工单必备 |
| `anthropic-organization-id` | 该 API Key 关联的组织 ID |

> Claude Platform on AWS 会在标准 `request-id` 之外**额外返回 AWS 请求 ID `x-amzn-requestid`**，排障时两者都应记录。

速率限制相关响应头见 §11。

### 2.3 最简请求示例

```bash
curl https://api.anthropic.com/v1/messages \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{
    "model": "claude-opus-4-8",
    "max_tokens": 1024,
    "messages": [
      { "role": "user", "content": "Hello, Claude" }
    ]
  }'
```

---

## 3. Messages API — 请求参数

`POST /v1/messages`。下表为请求体顶层参数。

| 参数 | 类型 | 必需 | 说明 |
| --- | --- | --- | --- |
| `model` | string | 是 | 模型 ID，见 §12 |
| `messages` | array | 是 | 对话消息列表，见 §4 |
| `max_tokens` | integer | 是 | 本次生成的最大输出 token 数（含思考 token）。不得超过模型 Max output 上限 |
| `system` | string \| array | 否 | 系统提示。可为字符串，或 `text` content block 数组（数组形式可挂 `cache_control`） |
| `stream` | boolean | 否 | 是否流式返回 SSE（默认 false），见 §10 |
| `stop_sequences` | array&lt;string&gt; | 否 | 自定义停止序列；命中则 `stop_reason` 为 `stop_sequence` |
| `temperature` | number | 否 | 采样温度，0–1。**注意**：Opus 4.7 及以后（含 Opus 4.8）设为非默认值返回 400，见 §3.1 |
| `top_p` | number | 否 | 核采样。同 `temperature` 的新模型限制 |
| `top_k` | integer | 否 | top-k 采样。同上限制 |
| `tools` | array | 否 | 工具定义，见 §5 |
| `tool_choice` | object | 否 | 工具选择策略，见 §5.2 |
| `thinking` | object | 否 | 扩展 / 自适应思考配置，见 §6 |
| `output_config` | object | 否 | 输出控制：`effort`（思考深度）+ `format`（结构化输出），见 §6.2 / §8 |
| `metadata` | object | 否 | 元数据，目前仅支持 `user_id`（不透明字符串，用于滥用检测，勿放 PII） |
| `service_tier` | string | 否 | 服务层级：`auto` / `standard_only`。响应 `usage.service_tier` 回显实际层级 |
| `inference_geo` | string | 否 | 推理地域路由：默认 `global`；指定 US-only 等会带 1.1x 价格乘数（Opus 4.6 / Sonnet 4.6 及以后） |

### 3.1 采样参数的重要变更

> Opus 4.7 及以后模型（含 **Opus 4.8**、**Fable 5**、**Mythos 5**）**不支持** `temperature` / `top_p` / `top_k`。设为非默认值会被服务端拒绝并返回 400。请从请求体中省略这些字段，改用提示词引导行为。
>
> SDK 类型仍保留这些字段以兼容旧模型（即代码能通过类型检查），但 API 侧仍会拒绝。从 Claude 3.x 迁移时另有约束：`temperature` 与 `top_p` 不可同时设置。

### 3.2 助手消息预填（Prefill）

历史上可在 `messages` 末尾放一条 `assistant` 消息来「替 Claude 开个头」引导格式。**但** Fable 5 / Mythos 5 / Mythos Preview / Opus 4.8 / Opus 4.7 / Opus 4.6 / Sonnet 4.6 **不支持预填**，使用会返回 400。新模型上请改用**结构化输出**（§8）或系统提示约束。

---

## 4. 消息格式与 Content Blocks

### 4.1 message 结构

```json
{ "role": "user", "content": "..." }
```

- `role`：`user` 或 `assistant`，必须交替（不强制以 user 开头之外的约束见官方）。
- `content`：可为**字符串**（等价于单个 text block），或**content block 数组**（多模态 / 工具 / 思考时必须用数组）。

### 4.2 Content Block 类型一览

| `type` | 出现位置 | 说明 |
| --- | --- | --- |
| `text` | 输入 / 输出 | 纯文本。`{ "type": "text", "text": "…" }` |
| `image` | 输入 | 图片，`source` 支持 base64 / url / file，见 §7.1 |
| `document` | 输入 | PDF / 纯文本 / 自定义内容文档，见 §7.2 |
| `tool_use` | 输出 | 模型发起的工具调用，含 `id` / `name` / `input`（对象），见 §5 |
| `tool_result` | 输入 | 工具执行结果回传，含 `tool_use_id` / `content` / `is_error` |
| `thinking` | 输出 | 扩展思考内容块，含 `thinking` 文本 + `signature`，见 §6 |
| `redacted_thinking` | 输出 | 因安全被编辑的思考块，含 `data`，**多轮回传时不可丢弃**，见 §6.4 |
| `server_tool_use` / `web_search_tool_result` 等 | 输出 | server tool 调用与结果，见 §5.4 |

### 4.3 cache_control

任意可缓存 block 上可加 `"cache_control": { "type": "ephemeral" }`（可选 `"ttl": "1h"`）标记缓存断点，见 §9。

---

## 5. 工具使用（Tool Use）

工具让 Claude 调用你定义的函数（client tools）或 Anthropic 提供的内置工具（server tools）。

- **Client tools**（用户自定义工具、以及 bash / text_editor 等 Anthropic schema 工具）：在**你的应用里执行**。Claude 返回 `stop_reason: "tool_use"` + 一个或多个 `tool_use` block；你执行后把 `tool_result` 回传，继续下一轮。
- **Server tools**（web_search / code_execution / web_fetch / tool_search 等）：在 **Anthropic 基础设施上执行**，你直接看到结果，无需处理执行。

### 5.1 工具定义 schema

```json
{
  "tools": [
    {
      "name": "get_weather",
      "description": "Get the current weather in a given location",
      "input_schema": {
        "type": "object",
        "properties": {
          "location": { "type": "string", "description": "城市与州，如 San Francisco, CA" },
          "unit": { "type": "string", "enum": ["celsius", "fahrenheit"], "description": "温度单位" }
        },
        "required": ["location"]
      },
      "input_examples": [
        { "location": "San Francisco, CA", "unit": "fahrenheit" },
        { "location": "Tokyo, Japan", "unit": "celsius" },
        { "location": "New York, NY" }
      ]
    }
  ]
}
```

- `name`：工具名。
- `description`：详尽描述，质量直接影响调用准确率。
- `input_schema`：JSON Schema（`type: "object"`），定义入参。
- `input_examples`（可选）：示例入参，向模型展示良好调用模式（何时带可选参数、复杂结构如何组织）。
- `strict`（可选，结构化输出）：设 `true` 启用严格 schema 校验，保证工具入参严格符合 schema，见 §8。

### 5.2 tool_choice — 四种模式

| `tool_choice` | 行为 |
| --- | --- |
| `{ "type": "auto" }` | 默认。每轮模型自行决定调用工具还是直接回答 |
| `{ "type": "any" }` | 强制必须调用某个工具（任意一个） |
| `{ "type": "tool", "name": "get_weather" }` | 强制调用指定工具 |
| `{ "type": "none" }` | 禁止调用任何工具 |

注意：

- `any` / `tool` 模式下 API 会预填 assistant 消息以强制调用，**模型不会先输出自然语言说明**，直接给 `tool_use` block。
- **扩展思考 / 自适应思考与 `any`、`tool` 不兼容**，使用会报错；思考场景只能用 `auto`（默认）或 `none`。
- 自 2025-02 起，含 `tool_use` / `tool_result` block 时不再强制要求携带 `tools`；且新增 `none` 选项。
- `tool_choice` 变化会使**消息块缓存失效**（工具定义与 system 仍命中缓存）。

### 5.3 工具调用完整往返示例

```json
// 1) 你的请求
{
  "model": "claude-opus-4-8",
  "max_tokens": 1024,
  "tools": [ { "name": "get_weather", "description": "…", "input_schema": { "…": "…" } } ],
  "messages": [ { "role": "user", "content": "旧金山现在天气怎么样？" } ]
}

// 2) Claude 响应（stop_reason = tool_use）
{
  "role": "assistant",
  "stop_reason": "tool_use",
  "content": [
    { "type": "text", "text": "我来查一下旧金山的天气。" },
    { "type": "tool_use", "id": "toolu_01A09…", "name": "get_weather",
      "input": { "location": "San Francisco, CA", "unit": "celsius" } }
  ]
}

// 3) 你执行工具后，把结果作为下一条 user 消息回传
{
  "role": "user",
  "content": [
    { "type": "tool_result", "tool_use_id": "toolu_01A09…",
      "content": "18°C，多云", "is_error": false }
  ]
}
```

并行工具调用：一次 assistant 响应里可包含多个 `tool_use` block，你应在**一条** user 消息里回传同样多个 `tool_result`（用 `tool_use_id` 对应）。

### 5.4 Server Tools（Anthropic 侧执行）

| 工具 | `type`（带版本日期，随版本更新） | 说明 |
| --- | --- | --- |
| Web Search | `web_search_20260209`（示例，以官方为准） | 联网搜索 |
| Code Execution | `code_execution_20250825` | 沙箱执行 Python（2025-08 GA） |
| Web Fetch | web_fetch | 抓取指定 URL 内容 |
| Tool Search | tool_search | 延迟加载工具定义，省 context |

server tool 用量在响应 `usage.server_tool_use` 中单独计数，例如：

```json
{ "usage": { "input_tokens": 105, "output_tokens": 239, "server_tool_use": { "code_execution_requests": 1 } } }
```

最简 server tool 调用（无需你处理执行）：

```json
{
  "model": "claude-opus-4-8",
  "max_tokens": 1024,
  "tools": [ { "type": "web_search_20260209", "name": "web_search" } ],
  "messages": [ { "role": "user", "content": "火星车最新进展？" } ]
}
```

### 5.5 内置 Anthropic-schema 工具的附加 token

| 工具 | 额外输入 token |
| --- | --- |
| `bash` | 245 |
| `text_editor_20250429`（Claude 4.x） | 700 |

工具系统提示本身也消耗 token，且随 `tool_choice` 不同而不同（示例，以官方定价页为准）：

| 模型 | `auto` / `none` | `any` / `tool` |
| --- | --- | --- |
| Claude Opus 4.8 | 290 | 410 |
| Claude Opus 4.7 | 675 | 804 |
| Claude Sonnet 4.6 | 497 | 589 |
| Claude Sonnet 4.5 | 496 | 588 |

---

## 6. 扩展思考 / 自适应思考（Extended / Adaptive Thinking）

思考让模型在给出最终答案前进行内部推理，输出 `thinking` content block，随后才是 `text` block。

### 6.1 两种模式

| 模式 | 配置 | 适用 |
| --- | --- | --- |
| 手动扩展思考 | `thinking: { "type": "enabled", "budget_tokens": N }` | 旧模型（Sonnet 4.5 等）；新模型已弃用 / 不支持 |
| 自适应思考 | `thinking: { "type": "adaptive" }` + `output_config.effort` | **Opus 4.7 / 4.8、Sonnet 4.6、Fable 5 等推荐 / 强制** |
| 关闭 | 省略 `thinking` 参数 | 默认不思考 |

> **重要模型差异**
> - **Opus 4.8 / Opus 4.7**：仅支持自适应思考。手动 `thinking: {type:"enabled", budget_tokens:N}` 返回 400。
> - **Fable 5 / Mythos 5**：自适应思考**始终开启**；`thinking: {type:"disabled"}` 返回错误；手动思考、预填均不支持（返回 400）。
> - **Opus 4.6 / Sonnet 4.6**：推荐自适应；手动配置仍可用但已弃用，将来移除。`budget_tokens` 在这两个模型上已标记弃用。

### 6.2 effort 参数（自适应思考的深度控制）

`output_config.effort` 取值：`low` / `medium` / `high` / `xhigh` / `max`。

- 更高 effort → 更多思考 → 更高质量但更慢更贵；查询越复杂模型自动思考越多。
- **Opus 4.8 上 `effort` 默认 `high`**（API 与 Claude Code 都是），需显式设置才用其他档。
- 编码用例常用 `high`；聊天 / 内容生成 / 分类等非编码任务从 `low` 起步，不够再升 `medium`。
- effort 现已 GA，无需 beta header（旧的 `effort-2025-11-24` 可移除）。

```json
{
  "model": "claude-opus-4-8",
  "max_tokens": 64000,
  "thinking": { "type": "adaptive" },
  "output_config": { "effort": "high" },
  "messages": [ { "role": "user", "content": "…" } ]
}
```

### 6.3 budget_tokens（手动模式）

- 决定 Claude 内部推理可用的最大 token 数（针对完整思考 token，非摘要输出）。
- 是 `max_tokens` 的子集，按**输出 token 计费**，计入速率限制。
- 模型可能用不满预算（尤其 32k 以上区间）。
- 自适应思考下模型动态分配，实际思考用量每次请求可能不同。

> 若你需要给思考成本设**硬上限**：`budget_tokens` 在 Opus 4.6 / Sonnet 4.6 上仍可用但**已弃用**。官方推荐改为**调低 `effort`**，或在自适应思考下用 `max_tokens` 作为硬上限。

### 6.4 thinking block 的处理规则

- 默认返回的是**摘要**思考（Claude 4 起）：完整思考被加密放在 `thinking` block 的 `signature` 字段。设 `thinking.display: "summarized"` 显式要摘要；`display: "omitted"` 返回空 `thinking` 字段但**保留 `signature`** 用于多轮续接（计费不变）。
- **`redacted_thinking`**：部分思考因安全被编辑时返回的独立 block 类型（含 `data`）。
  - 多轮工具回传时，若你按 `block.type == "thinking"` 过滤 content block，**必须同时保留 `redacted_thinking`**，否则会静默破坏多轮协议。
- 上一轮的 thinking block 会被 API **自动从后续轮次的 context 计算中剥离**，不占对话历史 token。
- Fable 5 / Mythos 5 / Mythos Preview 永不返回原始思考 token。

### 6.5 交错思考（Interleaved Thinking）

允许模型**在多次工具调用之间**思考，收到工具结果后做更复杂推理。

- Claude 4 模型支持。旧接入用 beta header `interleaved-thinking-2025-05-14` 开启。
- **Opus 4.7 / 4.6、Sonnet 4.6**：自适应思考会自动启用交错思考，该 beta header 可移除（带上也会被安全忽略）。

---

## 7. 多模态输入

### 7.1 图片

`image` block 的 `source` 支持三种来源：

```json
// base64
{ "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": "iVBORw0KGgo…" } }

// URL（2025-02 起支持，免去 base64 编码）
{ "type": "image", "source": { "type": "url", "url": "https://example.com/cat.png" } }

// Files API（先上传，复用引用）— 需 beta header files-api-2025-04-14
{ "type": "image", "source": { "type": "file", "file_id": "file_011…" } }
```

支持的 `media_type`：`image/jpeg`、`image/png`、`image/gif`、`image/webp`。Opus 4.8 支持长边最高 2576 像素的高分辨率输入。多张图片可放在同一 user 消息或跨多轮。

### 7.2 PDF / 文档

`document` block 支持 PDF（base64 / url / file）、纯文本文档、自定义内容文档（custom content，2025-01 起）。

```json
{
  "type": "document",
  "source": { "type": "base64", "media_type": "application/pdf", "data": "JVBERi0xLj…" }
}
```

配合 **Citations**（2025-01 GA）可让模型对来源做引用归因。

---

## 8. 结构化输出（Structured Outputs）

保证响应严格符合给定 JSON Schema。2026-01-29 在 Claude API 上对 **Sonnet 4.5 / Opus 4.5 / Haiku 4.5** GA（无需 beta header）；Bedrock / Foundry 仍公测。

两种用法：

1. **JSON 输出**：用 `output_config.format` 指定 JSON Schema，模型输出严格符合该 schema 的 JSON。
2. **严格工具使用**：工具定义里设 `"strict": true`，保证 `tool_use.input` 严格符合 `input_schema`。配合 `tool_choice: {"type":"any"}` 可同时保证「必调工具」+「入参合规」。

```json
{
  "model": "claude-sonnet-4-6",
  "max_tokens": 1024,
  "output_config": {
    "format": {
      "type": "json_schema",
      "schema": {
        "type": "object",
        "properties": { "sentiment": { "type": "string", "enum": ["pos", "neg", "neu"] } },
        "required": ["sentiment"]
      }
    }
  },
  "messages": [ { "role": "user", "content": "评价：这家店太棒了" } ]
}
```

> 参数迁移：旧 `output_format={...}` 已移到 `output_config.format={...}`。旧参数仍可用但已弃用，未来移除。OpenAI 兼容端点的 `response_format` 被忽略，要 JSON 须用原生结构化输出。

---

## 9. 提示缓存（Prompt Caching）

在 `tools` / `system` / `messages`（按此顺序）中的某个 block 上加 `cache_control` 标记缓存断点；从该断点往前的整个前缀会被缓存，后续请求命中可大幅降本提速。

### 9.1 用法

```json
{
  "system": [
    { "type": "text", "text": "你是文学分析助手。" },
    { "type": "text", "text": "<整本《傲慢与偏见》>", "cache_control": { "type": "ephemeral" } }
  ],
  "messages": [ { "role": "user", "content": "分析其中的主要主题。" } ]
}
```

- `cache_control.type` 目前为 `ephemeral`。
- 默认 TTL **5 分钟**；加 `"ttl": "1h"` 用 1 小时缓存（额外计费）。
- 最多 **4 个缓存断点**。设断点后系统会**自动从你最长的已缓存前缀读取**（2025-01 起更易用）。
- 混用 TTL 时：**1 小时条目必须排在 5 分钟条目之前**。

### 9.2 缓存计费乘数（相对基础输入价）

| 缓存操作 | 乘数 | 时效 |
| --- | --- | --- |
| 5 分钟缓存写入 | 1.25x 基础输入价 | 5 分钟有效 |
| 1 小时缓存写入 | 2x 基础输入价 | 1 小时有效 |
| 缓存读取（命中） | 0.1x 基础输入价 | 与对应写入同时效 |

命中只需基础输入价的 10%：5 分钟缓存读 1 次即回本（1.25x 写），1 小时缓存读 2 次回本（2x 写）。这些乘数与 Batch 折扣、数据驻留乘数可叠加。

### 9.3 usage 中的缓存字段

```json
{
  "usage": {
    "input_tokens": 2048,
    "cache_read_input_tokens": 1800,
    "cache_creation_input_tokens": 248,
    "output_tokens": 503,
    "cache_creation": { "ephemeral_5m_input_tokens": 148, "ephemeral_1h_input_tokens": 100 }
  }
}
```

- `cache_creation_input_tokens` 等于 `cache_creation` 对象内各值之和。
- `input_tokens` **只代表最后一个缓存断点之后**的 token，不是全部输入。
  - 总输入 = `cache_read_input_tokens + cache_creation_input_tokens + input_tokens`。
- 速率限制（ITPM）只计 `input_tokens + cache_creation_input_tokens`；`cache_read_input_tokens` **不计入**，因此缓存能显著提升有效吞吐。

### 9.4 缓存失效规则（节选）

| 改动 | tools 缓存 | system 缓存 | messages 缓存 |
| --- | --- | --- | --- |
| 工具定义（名/描述/参数） | 失效 | 失效 | 失效 |
| 开关 web search / citations | 失效 | 命中 | 命中 |
| 切换 speed 设置 | 失效 | 失效 | 命中 |
| 改 `tool_choice` | 命中 | 命中 | 失效 |
| 增删图片 | 命中 | 命中 | 失效 |

---

## 10. 流式响应（简要）

设 `"stream": true`，响应以 **SSE** 增量返回。事件顺序：

```
message_start
  → content_block_start → (content_block_delta)* → content_block_stop   [每个 block 一组，可重复 N 次]
message_delta
message_stop
```

- `content_block_delta` 的 `delta` 类型：`text_delta`（文本）、`input_json_delta`（工具入参的 partial JSON 串）、`thinking_delta` / `signature_delta`（思考）。
- 流中可穿插任意数量 `ping` 事件，必须忽略。
- 高负载时可能收到 `event: error`（如 `overloaded_error`，对应非流式 HTTP 529）。
- `message_delta.usage` 的 token 计数是**累计**值。
- 按版本政策未来可能新增事件类型，客户端须**优雅忽略未知事件**。

> 完整 SSE 状态机、index 不连续容错、partial JSON 拼接等实现细节 **详见 `anthropic-messages-api.md`**。

---

## 11. 响应字段

### 11.1 Message 响应结构

```json
{
  "id": "msg_01XFDUDYJgAACzvnptvVoYEL",
  "type": "message",
  "role": "assistant",
  "content": [ { "type": "text", "text": "Hello!" } ],
  "model": "claude-opus-4-8",
  "stop_reason": "end_turn",
  "stop_sequence": null,
  "usage": { "input_tokens": 12, "output_tokens": 6 }
}
```

| 字段 | 说明 |
| --- | --- |
| `id` | Message 唯一 ID（`msg_` 前缀） |
| `type` | 固定 `"message"` |
| `role` | 固定 `"assistant"` |
| `content` | content block 数组（text / tool_use / thinking 等） |
| `model` | 实际使用的模型 ID |
| `stop_reason` | 停止原因，见 §11.2 |
| `stop_sequence` | 命中的自定义停止序列（否则 null） |
| `stop_details` | refusal 等场景的细节（如 `category`），见下 |
| `usage` | token 用量，见 §11.3 |

### 11.2 stop_reason 取值

| 取值 | 含义 |
| --- | --- |
| `end_turn` | 模型自然结束回合 |
| `max_tokens` | 达到 `max_tokens` 上限被截断 |
| `model_context_window_exceeded` | 生成因撞到**模型 context window 上限**而停止（区别于主动设的 `max_tokens`）。Claude 4.5 及以后模型新增，迁移时应显式处理 |
| `stop_sequence` | 命中 `stop_sequences` 中的某序列（`stop_sequence` 字段给出是哪个） |
| `tool_use` | 模型发起工具调用，等待你回传 `tool_result` |
| `refusal` | 模型基于安全策略拒答（Opus 4.7 起）。同时返回 `stop_details`，其 `category` 标识触发的策略类别（如 `cyber` / `bio`；Fable 5 上还可能有 `reasoning_extraction`） |
| `pause_turn` | 长时 server tool 调用被暂停（需续接） |

> 迁移到 Claude 4 时应**显式处理 `refusal`**；迁移到 Claude 4.5+ 还应处理 `model_context_window_exceeded`。

### 11.3 usage 字段

| 字段 | 说明 |
| --- | --- |
| `input_tokens` | 输入 token（最后一个缓存断点之后部分，见 §9.3） |
| `output_tokens` | 输出 token（含思考 token） |
| `cache_creation_input_tokens` | 写入缓存的 token |
| `cache_read_input_tokens` | 从缓存读取的 token |
| `cache_creation` | `{ ephemeral_5m_input_tokens, ephemeral_1h_input_tokens }` 细分 |
| `server_tool_use` | server tool 用量，如 `{ "code_execution_requests": 1 }` |
| `service_tier` | 实际命中的服务层级（`standard` 等） |
| `inference_geo` | 推理地域（`global` 等） |
| `iterations` | 数组，按内部迭代细分各次 token 用量（每项结构同 message 级 usage，含 `input_tokens` / `output_tokens` / 缓存四件套）。多在 server tool / 多轮内部循环场景出现 |

---

## 12. Models API

### 12.1 列出模型

`GET /v1/models`

```bash
curl https://api.anthropic.com/v1/models \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01"
```

响应（结构示例，以官方为准）：

```json
{
  "data": [
    {
      "type": "model",
      "id": "claude-opus-4-8",
      "display_name": "Claude Opus 4.8",
      "created_at": "2026-…",
      "max_input_tokens": 1000000,
      "max_tokens": 128000,
      "capabilities": { "…": "…" }
    }
  ],
  "has_more": false,
  "first_id": "…",
  "last_id": "…"
}
```

### 12.2 查询单个模型

`GET /v1/models/{model_id}`，返回同结构的单条记录。

> 自 2026-03-18 起，`GET /v1/models` 与 `GET /v1/models/{model_id}` 新增 `max_input_tokens`、`max_tokens` 与 `capabilities` 对象，可编程发现各模型能力。

---

## 13. Token 计数 API

`POST /v1/messages/count_tokens`：不实际生成，仅返回输入 token 数。请求体接受与 Messages API 相同的 `model` / `messages` / `system` / `tools` / `thinking` 等字段。

```bash
curl https://api.anthropic.com/v1/messages/count_tokens \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{
    "model": "claude-sonnet-4-6",
    "messages": [ { "role": "user", "content": "n mod 4 == 3 的素数有无穷多个吗？" } ]
  }'
```

响应：

```json
{ "input_tokens": 14 }
```

支持图片、PDF、思考块等多模态 / 复杂消息的计数（限制同 Messages API）。

> 提醒：Opus 4.7 及以后使用**新 tokenizer**，相同文本可能比旧模型多用最高约 35% 的 token。

---

## 14. 错误码与速率限制

### 14.1 HTTP 错误码

| HTTP | `error.type` | 含义 |
| --- | --- | --- |
| 400 | `invalid_request_error` | 请求格式 / 内容有误（也用于本表未列的其他 4XX） |
| 401 | `authentication_error` | API Key 有问题 |
| 402 | `billing_error` | 账单 / 付款信息问题 |
| 403 | `permission_error` | Key 无权限使用该资源 |
| 404 | `not_found_error` | 资源不存在 |
| 413 | `request_too_large` | 超过请求体大小上限（见 §1.2） |
| 429 | `rate_limit_error` | 触发速率限制 / 加速限制 |
| 500 | `api_error` | Anthropic 内部异常 |
| 504 | `timeout_error` | 处理超时（长任务建议改用流式） |
| 529 | `overloaded_error` | API 临时过载（跨用户高流量） |

错误响应体结构（顶层除 `error` 外还含 `request_id`，便于排障 / 提工单）：

```json
{
  "type": "error",
  "error": { "type": "not_found_error", "message": "The requested resource could not be found." },
  "request_id": "req_011CSHoEeqs5C35K2UUqR7Fy"
}
```

> 官方 SDK 会把这些错误抛成**带类型的异常**（如 Python `anthropic.NotFoundError`、Ruby `Anthropic::Errors::NotFoundError`、Java `com.anthropic.errors.NotFoundException`；Go 统一为 `anthropic.Error` 按 `StatusCode` 分支）。最佳实践是 **catch SDK 类型类**而非匹配 message 字符串，且优先处理最具体的类。
>
> 直连 Claude API 时，413 `request_too_large` 由 **Cloudflare 在请求到达 API 服务器前**返回。

> 注意：流式（SSE）返回 200 之后仍可能在事件流中发生错误（如 `overloaded_error`），此时不走上述标准 HTTP 机制，需在流处理里单独处理 `event: error`。

### 14.2 429 vs 529

- 历史上组织用量骤增会触发 529；自 2025-08 起，组织级用量骤增更可能返回 **429（加速限制）**。
- 规避：**逐步爬坡**放量、保持稳定用量模式。

### 14.3 速率限制（Rate Limits）

- 按**使用层级（usage tier）**组织，随用量自动提升；含 RPM / ITPM / OTPM 等维度，采用 token bucket 算法。
- **ITPM 仅计** `input_tokens + cache_creation_input_tokens`；`cache_read_input_tokens` 不计入（缓存提升有效吞吐）。
- 更高限额 / Priority Tier（承诺消费的增强服务）需联系销售。具体限额见 Console。

---

## 15. 模型列表与定价

> 价格单位 USD / 百万 token（MTok）。以下为 2026-06 联网核对值，**正式接入前请再核对官方 Pricing 页**。

### 15.1 当前主力模型

| 模型 | API ID | Context | Max output | 输入价 | 输出价 | 思考模式 |
| --- | --- | --- | --- | --- | --- | --- |
| Claude Fable 5 | `claude-fable-5` | 1M | 128k | $10 | $50 | 自适应（始终开） |
| Claude Opus 4.8 | `claude-opus-4-8` | 1M ¹ | 128k | $5 | $25 | 自适应 |
| Claude Sonnet 4.6 | `claude-sonnet-4-6` | 1M | 128k | $3 | $15 | 自适应 |
| Claude Haiku 4.5 | `claude-haiku-4-5-20251001`（别名 `claude-haiku-4-5`） | 200k | 64k | $1 | $5 | 扩展思考 |
| Claude Mythos 5 | `claude-mythos-5` | 1M | 128k | $10 | $50 | 自适应（限定提供，Project Glasswing） |

¹ Microsoft Foundry 上 Opus 4.8 为 200k context。

定位：

- **Fable 5**：最强、面向最苛刻推理与长程 agentic 工作。
- **Opus 4.8**：最强 Opus 档，复杂推理 + agentic 编码。
- **Sonnet 4.6**：智能与速度最佳平衡，多数生产负载首选。
- **Haiku 4.5**：最快、近前沿智能，高并发 / 低延迟场景。

### 15.2 缓存价（部分模型，USD/MTok）

| 模型 | 基础输入 | 5m 缓存写 | 1h 缓存写 | 缓存命中 | 输出 |
| --- | --- | --- | --- | --- | --- |
| Claude Fable 5 | $10 | $12.50 | $20 | $1 | $50 |
| Claude Mythos 5 | $10 | $12.50 | $20 | $1 | $50 |
| Claude Opus 4.8 | $5 | $6.25 | $10 | $0.50 | $25 |
| Claude Opus 4.7 | $5 | $6.25 | $10 | $0.50 | $25 |

（5m 写 = 1.25x，1h 写 = 2x，命中 = 0.1x，见 §9.2。）

### 15.3 平台 ID 对照（节选）

| 模型 | AWS Bedrock ID | Vertex AI ID |
| --- | --- | --- |
| Opus 4.8 | `anthropic.claude-opus-4-8` | `claude-opus-4-8` |
| Sonnet 4.6 | `anthropic.claude-sonnet-4-6` | `claude-sonnet-4-6` |
| Haiku 4.5 | `anthropic.claude-haiku-4-5-20251001-v1:0` | `claude-haiku-4-5@20251001` |

### 15.4 弃用 / 退役（节选）

| 退役日期 | 模型 | 推荐替代 |
| --- | --- | --- |
| 2025-07-21 | `claude-3-sonnet-20240229` | `claude-sonnet-4-6` |
| 2025-10-28 | `claude-3-5-sonnet-20240620` / `-20241022` | `claude-sonnet-4-6` |
| 2026-01-05 | `claude-3-opus-20240229` | `claude-opus-4-8` |

完整退役表见 https://docs.anthropic.com/en/docs/about-claude/model-deprecations 。

---

## 16. 迁移要点（接入新模型时核对）

从 Claude 3.x / 4.x 迁移到 Opus 4.7+ / Sonnet 4.6 / Fable 5 时的高频破坏性变更：

- **移除采样参数**：`temperature` / `top_p` / `top_k` 非默认值在 Opus 4.7+ 返回 400（§3.1）。
- **移除助手预填**：改用结构化输出或系统提示（§3.2）。
- **思考改自适应**：`thinking: {type:"enabled", budget_tokens:N}` → `thinking: {type:"adaptive"}` + `output_config.effort`（§6）。
- **处理 `refusal` 停止原因**（§11.2）；Claude 4.5+ 还要处理 `model_context_window_exceeded`（撞 context window 而非 `max_tokens`）。
- **结构化输出参数迁移**：`output_format` → `output_config.format`（§8）。
- **工具版本升级**：`text_editor_20250728`、`code_execution_20250825`；移除 `undo_edit`（3.x 迁移时）。
- **移除已 GA 的 beta header**：`fine-grained-tool-streaming-2025-05-14`、`interleaved-thinking-2025-05-14`、`effort-2025-11-24` 等。
- **工具入参 JSON 转义可能不同**：用标准 JSON 解析器即可，自定义字符串解析需更新。
- **核对工具字符串参数的尾部换行处理**：官方迁移清单专门列出此项——从 4.1 及更早迁移时，校验工具入参里字符串末尾换行符的处理是否仍符合预期。
- **跨模型重放历史先剥离思考块**：若把对话历史重放到另一模型上，先从历史 assistant 轮次中删除 `thinking` / `redacted_thinking` 块——思考块与产出它的模型绑定（如 `claude-fable-5` 的思考块），换模型回放会报错。

---

## 17. 对 sid-code provider 层的提示

- `src/llm/anthropic.ts` 用 SDK 的 **raw stream 模式**（`messages.create({ stream: true })`）自管事件解析，协议细节见 `anthropic-messages-api.md`。
- 接新模型务必处理：`refusal` 停止原因、采样参数 400、思考从 `budget_tokens` 迁到 `effort`、`redacted_thinking` block 不可丢弃。
- 计费 / 用量统计应读取完整 `usage`（含缓存四件套 + `server_tool_use`），ITPM 估算只计 `input_tokens + cache_creation_input_tokens`。
- 第三方 Anthropic 代理可能返回非标准 index / 截断流，需 fail-safe（见 `anthropic-messages-api.md` §2）。

---

> 本文档为离线快照，模型 / 价格 / 参数随官方迭代。任何拿不准的数字与行为，以 docs.anthropic.com 当时页面为准。
