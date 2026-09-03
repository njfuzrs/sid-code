---
title: 'Agent Runtime（21）· 多 Provider：一套代码同时接住十几家大模型'
description: '「OpenAI 兼容」是营销词。拆开五个正交件、六类线格式差异、差异的三种表达形态，以及重试/超时/降级/冷却这套韧性工程的全景。'
date: "2026-09-03"
series: Agent Runtime 从零到一
tags: [Provider, 协议, 从零到一]
outline: [2, 3]
---

# 多 Provider 从零到一：一个 coding agent 怎么同时接住十几家大模型

::: info 这是一份快照
本文的数字、常量、行数取自 **2026-08-29** 对 sid-code 源码的一次实读。
代码在动，这些数字会腐坏——引用其中任何一个之前，请按文中给出的命令在你自己的仓库里复跑一次。
:::

> **这份文档写给谁**
>
> 你知道「调 LLM API」是怎么回事，但没做过「一套代码同时接住 Anthropic / OpenAI / DeepSeek /
> 国产网关」这件事。你想搞懂：这里面到底难在哪、业界有几种解法、每种解法在赌什么、
> 面试问到「你怎么设计多 provider 层」时该答什么。
>
> **和同目录另外四份文档的关系**：那四份是**调研结论**（给已经懂的人看，密度极高、
> 全是 `文件:行号`）。这一份是**教学版**：从「一次 HTTP 请求」讲起，每个概念先给
> 「为什么需要它」再给「它长什么样」，最后才给「谁做得好」。
>
> **本文的事实来源**
> - sid-code 侧：2026-08-29 实读 `packages/core/src/llm/`（21444 行，排除 `*.test.ts`）。
>   ⚠️ 另外四份文档写于 2026-08-15，此后 `dialect/` 与 `model-compat.ts` 是新增的，
>   `openai.ts` 从 2066 涨到 2685 行——**引用旧数字前先复跑**。
> - 外部项目侧（opencode / openclaw / vercel-ai）：沿用同目录三份调研文档的实测口径，
>   本文不重新测，凡引用均标注「调研口径（2026-08）」。
> - 行数口径一律：`find <dir> -name '*.ts' -not -path '*/node_modules/*' -not -path '*/dist/*' -not -name '*.test.ts' | xargs wc -l`

---

## 目录

| 章 | 内容 | 你会得到什么 |
| --- | --- | --- |
| [0](#0) | 最小心智模型：一次 LLM 调用其实是什么 | 能用 curl 手搓两家的请求 |
| [1](#1) | 第一个认知陷阱：「OpenAI 兼容」是营销词 | 知道「兼容」到底兼容了什么 |
| [2](#2) | 解剖一次调用：五个正交件 | 多 provider 层的核心数学 |
| [3](#3) | 流式：从字节到事件 | SSE 全解 + 三个真实生产坑 |
| [4](#4) | 差异博物馆：六类线格式差异 | 知道具体要处理什么 |
| [5](#5) | ★ 差异的三种表达形态 | **本文架构核心** |
| [6](#6) | 韧性工程：真实世界不可靠 | 重试/超时/降级/冷却全景 |
| [7](#7) | 元数据与能力发现 | 400 自愈闭环 |
| [8](#8) | 省钱：prompt cache | 唯一有硬数据的成本杠杆 |
| [9](#9) | 可观测：没有埋点就没有优化 | 指标口径的四个陷阱 |
| [10](#10) | 四种架构原型横向对比 | 各自在赌什么 |
| [12](#12) | 动手：从零实现一个 mini provider 层 | 五阶段路线图 |
| [附](#appendix) | 术语表 / 自检清单 | 查漏 |

---
<a id="0"></a>
## 0. 最小心智模型：一次 LLM 调用其实是什么

### 0.1 剥掉 SDK，它就是一次 HTTP POST

所有「大模型 API」的本质是同一件事：**你 POST 一段 JSON，它流式返回一段 JSON**。
没有魔法，没有长连接协议，没有 gRPC。先看两家真实请求：

**OpenAI Chat Completions**

```bash
curl https://api.openai.com/v1/chat/completions \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5",
    "messages": [
      {"role": "system",  "content": "你是一个代码助手"},
      {"role": "user",    "content": "读一下 README"}
    ],
    "max_tokens": 1024,
    "stream": true
  }'
```

**Anthropic Messages**

```bash
curl https://api.anthropic.com/v1/messages \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-opus-5",
    "system": "你是一个代码助手",
    "messages": [
      {"role": "user", "content": "读一下 README"}
    ],
    "max_tokens": 1024,
    "stream": true
  }'
```

**盯住这两段的差异**，它们是本文后面所有复杂度的种子：

| | OpenAI | Anthropic |
| --- | --- | --- |
| 认证头 | `Authorization: Bearer xxx` | `x-api-key: xxx` |
| 额外必需头 | 无 | `anthropic-version`（**不带就 400**） |
| system prompt 的位置 | `messages` 数组里一个 `role:"system"` 元素 | **顶层独立字段** `system` |
| `max_tokens` | 可选（新模型改叫 `max_completion_tokens`） | **必填** |
| 路径 | `/v1/chat/completions` | `/v1/messages` |

四个字段的差异，就已经决定了「同一份对话历史，必须写两套转换代码」。

### 0.2 「Provider」这个词到底指什么

初学者最常见的误解：**以为 provider = 厂商**。不是。

> **Provider 是一个适配器：把 agent 内部的统一表示，翻译成某一家的线格式；
> 再把那一家的流式回复，翻译回统一的事件序列。**

「线格式」（wire format）是本文的核心术语——**真正在网线上跑的那些字节**。
你的 agent 内部有一套自己的数据结构（sid-code 里是 `SendParams` 和 `StreamEvent`，
`packages/core/src/llm/types.ts`），provider 的全部职责就是双向翻译：

```
                     ┌──────────── provider（适配器）────────────┐
  agent 内部           翻译出去                        翻译回来        agent 内部
  SendParams  ────▶  厂商原生 request body  ──HTTP──▶  厂商原生 SSE  ────▶  StreamEvent[]
 （统一表示）        （OpenAI 形 / Anthropic 形）      （各家事件名不同）   （统一表示）
```

为什么这层间接是必需的？因为**上层不能知道下层是谁**。agent 的主循环
（sid-code 里是 `packages/core/src/query/loop.ts` 的 `queryLoop`）要做的事是
「拿到模型输出 → 执行工具 → 把结果拼回历史 → 再问一次」。这个循环里**不该出现
任何一处 `if (provider === "anthropic")`**——一旦出现，你的循环就和某一家绑死了。

sid-code 的这层契约只有 40 行左右（`packages/core/src/llm/provider.ts`，实读）：

```ts
export interface Provider {
  name(): string;
  sendMessageStream(params: SendParams, signal?: AbortSignal): AsyncIterable<StreamEvent>;
  capabilities?(): ProviderCapabilities;                                    // 可选
  sendMessageNonStreaming?(params, signal?): Promise<AccumulatedResponse>;   // 可选，流式降级用
}

export interface ProviderCapabilities {
  streaming: boolean;          tools: boolean;
  thinking: boolean;           vision: boolean;
  promptCaching: boolean;      parallelToolCalls: boolean;
}
```

**一个方法 + 六个能力位。** 记住这个极简形态——第 10 章你会看到另外三个项目
把同一个契约做成了什么样，以及各自付出了什么代价。

### 0.3 为什么一定要「多」provider

这不是炫技，四个理由每一条都是真实压力：

| 动机 | 具体形态 | 谁在乎 |
| --- | --- | --- |
| **成本** | 同一任务用便宜模型跑简单步骤。输出单价通常是输入的 3–8 倍，模型间差 10 倍以上 | 所有人 |
| **可用性** | 主模型 529 / 429 / 网关抖动时能自动切备用，长任务不会因一次抖动全废 | 长任务用户 |
| **能力** | 有的模型擅长长上下文、有的擅长 thinking、有的工具调用更稳 | 追效果的人 |
| **数据主权 / 合规** | 企业要求代码不出内网 → 必须能接自建网关、私有部署、内部 SSO | **企业**，且这是最硬的需求 |

第四条最容易被低估，但它决定架构。**企业环境的特征就是「非官方端点」**：
一个自建的 new-api / one-api 网关，挂着十几个上游，模型名是运维自己起的
（`origin-deepseek-v4-pro` 这种），价格表是网关自己的，`/v1` 路径前缀可能有可能没有，
usage 字段可能是编造的。**为官方端点写的代码，在这里会以各种「不报错但结果错」
的方式失效**——这是第 6、7 章的全部动机。

### 0.4 本章自检

能回答这三个问题再往下：

1. 为什么 system prompt 在两家的位置不同，会导致「必须写两套消息转换」而不是「改个字段名」？
   （提示：想想多轮对话里 system 被改写的场景）
2. `Provider` 接口里为什么 `sendMessageNonStreaming` 是**可选**的？
3. 如果你的 agent 主循环里出现了 `if (model.startsWith("claude"))`，这说明什么设计问题？

---
<a id="1"></a>
## 1. 第一个认知陷阱：「OpenAI 兼容」是个营销词

### 1.1 三大协议族

现实中你要面对的不是「几十家厂商」，而是**三个协议族 + 两个特殊形态**：

| 协议族 | 谁在用 | 请求体特征 | 备注 |
| --- | --- | --- | --- |
| **OpenAI Chat Completions** | OpenAI、DeepSeek、GLM、Kimi、Qwen、Grok、Groq、几乎所有国产、几乎所有网关 | `messages` / `tools[].function` / `max_tokens` | **事实标准**，覆盖面最广 |
| **Anthropic Messages** | Anthropic 官方 + 一批「Anthropic 兼容」代理 | `system` 顶层 / `tools[].input_schema` / content blocks | 结构最干净 |
| **OpenAI Responses** | OpenAI 新模型（o 系列、gpt-5 系列）、Azure | `input` 而非 `messages`、`max_output_tokens`、`reasoning.effort` | OpenAI 自己的**第二代**协议 |
| Google Generative AI | Gemini | `contents[].parts` / `systemInstruction` / `generationConfig` | 字段名全不一样 |
| Bedrock Converse | AWS | SigV4 签名 + **二进制 event-stream 分帧** | 连「SSE」都不是 |

**关键认知：一家厂商 ≠ 一个协议。** OpenAI 自己就有两个（Chat Completions 和
Responses），且行为不同；Azure OpenAI 又是 Responses 的一个变体（路径和认证头都不同）。

**更准确的一条**（本仓 `api-reference/protocol-comparison.md` 的原话）：

> 协议族由 **端点（baseURL）** 决定，不是模型。
> DeepSeek / Gemini / Qwen / Ollama 都同时提供 OpenAI 兼容端点。
> **走兼容端点时一律用 OpenAI 协议处理。**

这条直接决定了代码怎么分派：**不要按模型名选协议，要按端点选协议。**
同一个 `deepseek-v4-pro`，走官方 Anthropic 端点和走 `/v1/chat/completions`
是两个完全不同的协议路径。（这也是第 5.2 节「能力位挂在渠道而非模型」的同源理由。）

### 1.2 「兼容」兼容的是什么

当一家厂商说「我们兼容 OpenAI API」，它承诺的是：

- ✅ URL 形状是 `{base}/chat/completions`
- ✅ 请求体的**核心字段**（`model` / `messages` / `stream`）认
- ✅ 响应体的**核心形状**（`choices[0].delta.content`）对

它**没有**承诺：

- ❌ 认全部字段（`reasoning_effort`、`tool_choice`、`response_format`、`store`、`stream_options`…）
- ❌ 不认的字段会**报错**——很多网关是**静默丢弃**，这比报错糟糕得多
- ❌ `usage` 的口径一致（第 4.4 节，这是最容易算错钱的地方）
- ❌ 工具 schema 接受同样的 JSON Schema 子集（第 4.3 节）
- ❌ 流式事件的时序和粒度一致

**「静默丢弃」是这一层最大的杀手。** 你设了 `reasoning_effort: "high"`，
网关不认这个字段，直接透传给上游或干脆删掉，返回 200，内容正常。
你以为深度思考打开了，实际没有。**没有任何错误、没有任何日志、
用户只会觉得「这个 agent 好像变笨了」。**

### 1.3 一个真实的差异清单

这是 sid-code 真实处理过的差异（每条都有代码在跑），先感受一下数量级：

| 差异 | 形态 |
| --- | --- |
| `max_tokens` vs `max_completion_tokens` | 字段名不同，发错了 400 |
| 支不支持 `reasoning_effort` | 不支持时发了可能 400，也可能静默无效 |
| thinking 开关的结构 | DeepSeek `thinking:{type:"enabled"}` vs Anthropic `thinking:{budget_tokens:N}` |
| 有的模型 thinking **只能开不能关** | GLM-5.3：发 `disabled` 会报错 |
| `tool_choice` 只认 `auto` | GLM：发 `required` 会降级而非报错 |
| 工具调用后必须回传 `reasoning_content` | DeepSeek V4：不回传则下一轮工具调用异常 |
| `stream_options.include_usage` 才给 usage | OpenAI 族：不发这个字段流里就没有 usage → **算不出成本** |
| `usage.prompt_tokens` 含不含缓存命中 | 两族**语义相反**（4.4 节详解） |
| SSE 少 `event:` 行 | 部分 Anthropic 兼容代理：SDK 静默丢弃全部事件 |
| content-type 标成 `application/json` 实际是 SSE | 部分网关：SDK 按 JSON 解析直接崩 |
| 工具 schema 里 `$schema` 键 | 五家厂商**没有一家文档承认接受它**，每轮白烧 ~570 token |

**这张表就是「多 provider 难在哪」的答案**：难点不在「支持三个协议」，
在于**每一族内部还有几十个厂商级、模型级、渠道级的差异**，
而且**大部分差异不会报错**。

### 1.4 一个数字对照：接入成本

「接第 N 家新厂商要多少工作量」是衡量一个 provider 层设计好坏的核心指标。
四个项目的实测（调研口径 2026-08）：

| 项目 | 接一家 OpenAI 兼容厂商的成本 |
| --- | --- |
| sid-code | 用户自己在 `availableModels` 里手配 `baseURL`（无骨架复用） |
| opencode | 仓库里加 **2 行** profile（`{provider, baseURL}`） |
| openclaw | **外部开发者**写一个 `openclaw.plugin.json` + 53 行 `index.ts`，装上就能用 |
| vercel-ai | 发一个 npm 包实现 `LanguageModelV4`（47 个包在这么干） |

**成本差 1–2 个数量级，且这个差距完全由架构决定，不由工作量决定。** 第 2 章讲为什么。

---
<a id="2"></a>
## 2. 解剖一次调用：五个正交件

### 2.1 先看「不拆」会发生什么

最自然的写法是「一家一个类」：

```ts
class AnthropicProvider  { sendMessageStream() { /* 认证 + URL + body + SSE 解析 */ } }
class OpenAIProvider     { sendMessageStream() { /* 同上，全是自己的一套 */ } }
class DeepSeekProvider   { sendMessageStream() { /* 又一套 */ } }
class GroqProvider       { /* 又一套 */ }
```

问题不是「代码多」，是**同一个知识被复制了 N 份**。DeepSeek / Groq / Cerebras /
TogetherAI 用的是**同一个协议**（OpenAI Chat Completions），差别只有 `baseURL`
和几个能力位。给它们各写一个类，等于把「OpenAI Chat 协议怎么解析」这件事抄了四遍。
下次协议解析有 bug，你要修四个地方——**而且大概率漏一个，漏掉的那个测试还是绿的**。

### 2.2 正交拆分：opencode 的核心洞察

opencode 在自己的注释里写了这层拆分最好的一句话
（调研口径：`packages/llm/src/route/protocol.ts:20-24`）：

> A `Protocol` is **not** a deployment. It does not know which URL, which headers,
> or which auth scheme to use. […] This separation is what lets DeepSeek, TogetherAI,
> Cerebras, etc. all reuse `OpenAIChat.protocol` **without forking 300 lines per provider**.

翻译成中文：**「说什么话」和「打给谁」是两个独立维度，不该耦合。**

于是一次调用被拆成五个可独立替换的正交件：

```
┌─────────────────────────────────────────────────────────────────────────┐
│ Protocol   语义契约：统一请求 → 厂商 body；厂商事件 → 统一事件           │
│            换它 = 换「说什么话」        （openai-chat / anthropic / …）  │
├─────────────────────────────────────────────────────────────────────────┤
│ Endpoint   URL 构造：baseURL + path（可为函数）+ query                   │
│            换它 = 换「打给谁」          （官方 / 网关 / 本地 ollama）    │
├─────────────────────────────────────────────────────────────────────────┤
│ Auth       凭据装配：bearer / 自定义 header / SigV4 / OAuth              │
│            换它 = 换「怎么证明我是我」                                  │
├─────────────────────────────────────────────────────────────────────────┤
│ Framing    字节分帧：SSE 文本行 / AWS 二进制 event-stream                │
│            换它 = 换「字节怎么切成消息」                                │
├─────────────────────────────────────────────────────────────────────────┤
│ Transport  传输：HTTP / WebSocket                                       │
└─────────────────────────────────────────────────────────────────────────┘
```

**为什么是这五个而不是别的**——每一维都对应一个「真实存在的、会独立变化的」东西：

| 维度 | 存在的证据（真实场景） |
| --- | --- |
| Protocol | OpenAI 同时有 Chat 和 Responses 两个协议，同一家 |
| Endpoint | 同一个 DeepSeek 模型，官方端点 / 公司网关 / OpenRouter 三个 URL |
| Auth | Azure OpenAI 要**删掉** bearer 换 `api-key`；Bedrock 要 SigV4 签名 |
| Framing | Bedrock 是二进制帧，SSE 解析器根本读不了 |
| Transport | 有些实现走 WebSocket（openclaw 有 `resolveWebSocketSessionPolicy` 钩子） |

### 2.3 拆完的效果：一个 provider 只剩三十几行

opencode 的 Anthropic provider 全文 **35 行**（调研口径 `providers/anthropic.ts`）：

```ts
export const routes = [AnthropicMessages.route]                      // 复用哪个 protocol
const auth = (options) => Auth.optional(options.apiKey)              // 凭据回落链
  .orElse(Auth.config("ANTHROPIC_API_KEY"))
  .pipe(Auth.header("x-api-key"))
const configuredRoute = (input) =>
  AnthropicMessages.route.with({ endpoint: { baseURL }, auth: auth(input) })
export const configure = (input = {}) => ({ id, model: (id) => route.model({ id }) })
```

而接一家 OpenAI 兼容厂商，退化成一张表里加两行：

```ts
deepseek: { provider: "deepseek", baseURL: "https://api.deepseek.com/v1" },
groq:     { provider: "groq",     baseURL: "https://api.groq.com/openai/v1" },
```

**这就是「边际成本」的意义**：第一个 OpenAI 兼容厂商成本是「写一个 Protocol」，
第 2 到第 N 个成本是「两行配置」。

### 2.4 sid-code 现状：一个接口 + 一个 switch

实读 `packages/core/src/llm/registry.ts`（2026-08-29），装配逻辑就是三个 case：

```
case "anthropic": { ... }     // registry.ts:453
case "openai":    { ... }     // registry.ts:458
case "ollama":    { ... }     // registry.ts:462
```

而 Ollama 是**继承** `OpenAIProvider` 改 `baseURL`（`ollama.ts`，30 行左右）。
所以事实上是 **2 个协议实现承担 3 个 provider**。

后果是具体的、可指认的：

- `openai.ts` **2685 行**（实测）一个文件里同时承担：Chat / Responses 分派、
  DeepSeek / GLM / Grok / o 系列的 thinking 差异、能力自愈、SSE 解析。
- **想加 Gemini 原生协议，没有地方放。** `model-registry.ts` 里有 Gemini 的价格和
  上下文窗口，但没有原生协议路径——只能让用户走 Gemini 的 OpenAI 兼容端点。
- **想加 Bedrock**（SigV4 + 二进制帧），当前架构下等于新写一个 provider 类，
  无法复用任何东西。

**这是一笔真实的架构欠账**，也是第 10 章「四种原型」里 sid-code 最弱的一格。

### 2.5 但拆分不是免费的：注意 opencode 的代价

新手看到「35 行 vs 2685 行」容易得出「所以应该立刻重构」。慢一点。opencode 买到了
边际成本，付出的是（调研口径）：

- **它假设上游是官方端点**：没有 SSE 缺 `event:` 行的补丁、没有死 socket 处理、
  **没有流内看门狗**（grep `timeout` 只命中一处，是把 Effect 的 TimeoutError 分类，
  不是主动看门狗）。接公司中转站会踩一遍别人已经踩完的坑。
- **没有跨模型降级**：主模型挂了就是挂了。
- **Effect-first 的阅读门槛**：整个 llm 包是 `Effect.gen` / `Layer` / `Context.Service`，
  对不熟 Effect 的人读改成本陡增。
- **自己的迁移都没完**：老的 AI SDK 路径还在，GitHub Copilot 还留着一份 4517 行私有分叉。

**这条信息本身很有价值**：它证明了「先跑通、再重构分层」是可行路径，
不是必须一开始就上抽象。面试里如果你能说出这一点，比只会背「应该正交拆分」强得多。

### 2.6 本章自检

1. 为什么 Protocol 和 Endpoint 必须分开？举一个「同 Protocol 不同 Endpoint」和一个
   「同 Endpoint 不同 Protocol」的真实例子。
2. Framing 为什么要独立成一维，而不是塞进 Protocol？
3. sid-code 只有 2 个协议实现，为什么说「加 Gemini 没地方放」是架构问题而不是工作量问题？

---
<a id="3"></a>
## 3. 流式：从字节到事件

流式是 provider 层**最容易出错**的部分，也是面试最容易问深的部分。因为它是唯一
「跨越网络边界的有状态解析」——上游可以在任何一个字节处停下、卡住、或者发畸形数据。

### 3.1 SSE 是什么：三条规则讲完

Server-Sent Events 就是一个**纯文本、单向、按行**的流协议：

```
event: content_block_delta          ← 事件名（可选）
data: {"type":"content_block_delta","delta":{"text":"你"}}   ← 数据行
                                    ← 空行 = 一个事件结束（分帧符）
event: content_block_delta
data: {"type":"content_block_delta","delta":{"text":"好"}}

data: [DONE]                        ← OpenAI 族的结束哨兵（Anthropic 不用这个）
```

三条规则：

1. **`\n\n`（空行）是分帧符**，不是 `\n`。一个事件可以有多个 `data:` 行，拼接起来。
2. **`event:` 行可选**，语义上冗余（`data` 的 JSON 里通常已有 `type`）——
   但**某些 SDK 硬性依赖它**（3.4 节的坑就出在这）。
3. **`:` 开头的行是注释**，常被用作 keep-alive 心跳（`: ping`）。

### 3.2 两族的事件模型完全不同

**OpenAI 族：扁平增量**

```
data: {"choices":[{"delta":{"content":"你"}}]}
data: {"choices":[{"delta":{"content":"好"}}]}
data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"pa"}}]}}]}
data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\":\"a\"}"}}]}}]}
data: {"choices":[{"finish_reason":"tool_calls"}]}
data: [DONE]
```

注意工具参数：**JSON 字符串是被切碎的**，你必须按 `index` 累积拼接，
**拼完才能 parse**。中途 parse 一定失败。

**Anthropic 族：显式块生命周期**

```
event: message_start          data: {"message":{"id":"...","usage":{...}}}
event: content_block_start    data: {"index":0,"content_block":{"type":"text"}}
event: content_block_delta    data: {"index":0,"delta":{"type":"text_delta","text":"你"}}
event: content_block_stop     data: {"index":0}
event: content_block_start    data: {"index":1,"content_block":{"type":"tool_use","name":"read"}}
event: content_block_delta    data: {"index":1,"delta":{"type":"input_json_delta","partial_json":"{\"pa"}}
event: content_block_stop     data: {"index":1}
event: message_delta          data: {"delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":57}}
event: message_stop
```

差异的实质：**Anthropic 显式告诉你「一个块开始了 / 结束了」，OpenAI 让你自己从
`index` 和 `finish_reason` 推断。** 这就是为什么统一事件抽象是必需的——
上层不该关心这个区别。

sid-code 的统一事件是 `StreamEvent`（`packages/core/src/llm/types.ts`），
provider 的职责就是把上面两种形态都翻译成它。

**三个容易漏的流式差异**（核对本仓 `api-reference/protocol-comparison.md` §4）：

**(a) 不是所有「流式」都是 SSE。** **Ollama 原生是 NDJSON** ——
每行一个完整 JSON，没有 `data:` 前缀、没有 `\n\n` 分帧、结束靠 `"done": true`。
如果你的分帧器硬编码了 SSE，接 Ollama 原生端点会一个字都读不出来。
（走 Ollama 的 OpenAI 兼容端点则是正常 SSE —— 又一次印证「协议由端点决定」。）

**(b) usage 的累积口径两族相反。** 这是 4.4 节那个坑的流式版本：

> Anthropic 的 `message_delta.usage.output_tokens` 是**累积值**不是增量；
> OpenAI 末尾一次性给全量。

**把 Anthropic 的累积值当增量去累加，输出 token 会被重复计数到爆。**
这类错误的形态还是「不报错，只是数字错」。

**(c) 第三方代理会破坏 index 的假设**（原文）：

> Anthropic 代理可能跳跃 content block `index`；
> OpenAI 兼容代理（如 Gemini 兼容模式）流式 tool_calls 可能**缺 `index` 字段**。
> 两者都需兜底。

**注意这两个坑针对的正是 3.3 节要维护的那个「按 index 累积」的状态**：
你的累积器如果假设 index 从 0 连续递增，接第三方代理时会静默错位或崩掉。

### 3.3 三个必须自己维护的状态

流式解析是有状态的，新手最常漏的三块：

**(a) 缓冲区**——TCP 不保证按行到达。一个 chunk 可能是半行：

```ts
let buffer = "";
for await (const chunk of response.body) {
  buffer += decoder.decode(chunk, { stream: true });     // ⚠️ stream:true 必须有，否则多字节字符被切断
  let idx: number;
  while ((idx = buffer.indexOf("\n\n")) !== -1) {         // 按 \n\n 而非 \n
    const frame = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 2);
    yield* parseFrame(frame);
  }
}
```

⚠️ `decoder.decode(chunk, {stream: true})` 里的 `stream: true` **不能漏**：
一个 UTF-8 中文字符占 3 字节，正好被 chunk 边界切开时，不加这个标志会产生乱码字符。
中文优先的产品尤其会踩。

**(b) 工具调用累积器**——按 index 拼 JSON 字符串，只在块结束时 parse。

**(c) usage 累积**——usage 可能只在流末尾出现（`message_delta`），也可能分散在多处。
sid-code 有一个「单一权威累加实现」（`types.ts` 的 usage 累加函数），
就是为了避免多处各自累加导致的口径不一致。

### 3.4 三个真实生产坑（都是 sid-code 代码在处理的）

这三个是本章最有价值的部分——它们是「教科书不会写、只有踩过才知道」的东西。

**坑 1：SDK 因为缺 `event:` 行静默丢弃全部事件**

实读 `packages/core/src/llm/sse-event-line-shim.ts` 的注释（原文）：

> `@anthropic-ai/sdk` 的 SSE 解析器**只在 `sse.event` 字段匹配到已知事件类型时才派发
> 事件**。[…] 部分第三方 Anthropic 兼容代理只发 `data:` 行、省略 `event:` 行，此时
> SDK 的 `sse.event` 恒为 null，匹配不到任何已知类型，**所有事件被静默丢弃**，
> 最终抛 `request ended without sending any chunks`。报错点离根因极远
> （看起来像"模型不回话"），排查成本极高。

**这个坑的教学价值极高**，它示范了三件事：

1. **`event:` 行"语义上冗余"不等于"可以省"** —— 规范允许省，但实现依赖它。
2. **失败模式是「静默丢弃 + 远端报错」** —— 错误信息（`request ended without sending
   any chunks`）指向的是「流空了」，而根因在「解析器没认出事件名」，中间隔了好几层。
3. **解法是在 fetch 层做纯响应体变换**：给 SDK 传自定义 fetch，用 `TransformStream`
   逐行扫描，检测到 `data:` 行的 JSON 含 `"type"` 但前面没有 `event:` 行时，
   自动补注入 `event: <type>\n`。对规范代理**逐字节透传、零影响**。

它还有一个值得学的工程细节：**开关是三态而非布尔**
（`SIDCODE_SSE_EVENT_SHIM`：`auto` 默认只在检测到缺失时介入并打一次 warn 遥测 /
`off` 完全旁路 / `force` 强制走变换逻辑供调试）。
「打一次 warn 遥测」是为了**知道哪些代理有这个问题**——修 bug 的同时收集数据。

**坑 2：ECONNRESET 后原样重试，重试次数全白烧**

实读 `packages/core/src/llm/keepalive.ts` 注释：

> ECONNRESET/EPIPE 的典型成因是连接池里的 socket 已被对端（或中间网关/LB）单方面关闭，
> 但本地池仍认为它可用，下一个请求复用到这条死连接即刻被 reset。此时**原样重试仍会
> 命中同一条死 socket**，重试次数被白白烧掉。正解是重试前禁用连接复用，强制新建连接。

两个设计决策值得记：

- **状态放在模块级，不是实例字段**。原注释：「它描述的是**进程级传输层**状态，
  不是某次调用的状态；多 provider / 多并发请求共享同一个连接池，
  所以状态位置在模块级才正确」。
- **单向置位（只关不开）**：一旦发现池子脏了，本进程后续都不再复用。

以及一个**极具代表性的元教训**，同一份注释里记着：

> `fallback.ts` 检测到 ECONNRESET/EPIPE 后会置位 `ctx.disableKeepAlive` 与
> `config.disableKeepAlive`，但**全仓没有任何消费者**（实测 grep 零命中）。
> 即：我们以为处理了「陈旧 keep-alive socket 导致的连接重置」，实际只是设了个没人读的标志位。

**「设了标志位但没有消费者」是这类系统里最常见的假防线形态。** 它的可怕之处在于
代码 review 时看起来完全正确——检测有了、置位有了、注释也写了。只有 grep
「谁读这个字段」才会发现链路是断的。

**坑 3：content-type 标错 / keep-alive 块让 SDK 崩溃**

openclaw 的解法值得对照（调研口径 `provider-transport-fetch.ts`，935 行）：

- OpenAI SDK 会对「只有 `event:` 行或 `data:` 为空」的 keep-alive 块尝试
  `JSON.parse` 并抛错 → 在 fetch 层把这类畸形块丢掉
- 部分网关流真是 SSE 但 header 写 `application/json` → **嗅探首字节**后按 SSE 处理
- ChatGPT Codex 甚至完全不带 content-type → 也靠嗅探
- 非流式 JSON 响应**合成成 SSE 帧**喂给 SDK（带 16MB 上限防 OOM）

**架构对比值得记**：sid-code 是 per-provider 挂 shim（Anthropic 一个、
keepalive 一个、unicode 净化一个），openclaw 是**一个 guarded fetch 包裹所有 provider**。
openclaw 的收敛点更好——sid-code 每新增一个 provider 都要重新挂一遍，
这正是「provider 边际成本高」的一个具体来源。

### 3.5 流式降级：SSE 走不通怎么办

有些网关根本不支持 SSE（返回一整个 JSON）。sid-code 的 `Provider` 接口里那个可选的
`sendMessageNonStreaming` 就是为此存在的：拿到完整响应后，由调用方转换成流式事件序列
「假装」是流。遥测里有 `non_streaming_degrade` 事件记录这件事发生了。

vercel-ai 用另一种方式解决同一问题——`simulateStreamingMiddleware`
（调研口径），在 middleware 层把非流式包装成流式。**注意这个对比**：
同一个需求，一个用「接口上开可选方法」，一个用「middleware 外挂」。
第 5 章会讲为什么后者更好。

### 3.6 本章自检

1. 为什么按 `\n` 分帧是错的？举一个会出错的具体输入。
2. `decoder.decode(chunk, {stream:true})` 漏掉 `stream:true` 会怎样？中文场景为什么更容易暴露？
3. 「缺 `event:` 行导致全部事件被丢弃」这个坑，为什么错误信息会是
   `request ended without sending any chunks`？这种「报错点离根因远」的问题该怎么系统性预防？
4. 为什么 keep-alive 开关的状态要放模块级而不是实例级？

---
<a id="4"></a>
## 4. 差异博物馆：六类线格式差异

这一章是「具体要处理什么」的完整清单。**按差异的形态分类，不按厂商分类**——
因为形态决定你该用什么手段处理它（第 5 章）。

### 4.1 第一类：字段改名（最简单）

同一个语义，两个名字。

| 语义 | OpenAI Chat | OpenAI Responses | Anthropic |
| --- | --- | --- | --- |
| 输出上限 | `max_tokens`（旧）/ `max_completion_tokens`（新模型） | `max_output_tokens` | `max_tokens`（**必填**） |
| 消息数组 | `messages` | `input` | `messages` |
| system prompt | `messages[0].role="system"` | `instructions` | 顶层 `system` |
| 工具的参数 schema | `tools[].function.parameters` | `tools[].parameters` | `tools[].input_schema` |

**处理手段**：一张映射表。这类差异**不需要架构**，一个字段名常量就够。

⚠️ 但有一个陷阱：`max_tokens` 在 OpenAI 新模型上**不是被忽略，是 400 报错**
（"Unsupported parameter: 'max_tokens' is not supported with this model"）。
所以「发哪个名字」必须能按模型判断，不能按 provider 判断。

### 4.2 第二类：结构不同（需要转换函数）

thinking / reasoning 的开关是最典型的例子，**三家的结构完全不同**：

```jsonc
// OpenAI Responses / o 系列：枚举档位
{ "reasoning": { "effort": "high" } }

// DeepSeek：开关 + 类型
{ "thinking": { "type": "enabled" } }

// Anthropic：token 预算（数字！）
{ "thinking": { "type": "enabled", "budget_tokens": 10000 } }
```

`packages/core/src/llm/dialect/types.ts` 里有一张表把这个道理写得很清楚（实读原文）：

| 差异 | 形态 | 布尔位能表达吗 |
| --- | --- | --- |
| 这家认不认 `reasoning_effort` | 一个标量字段的有无 | ✅ 能 |
| DeepSeek 的 `thinking:{type}` vs Anthropic 的 `{budget_tokens:N}` | **请求体结构不同** | ❌ 不能 |
| GLM 的 `tool_choice` 只认 `auto`，其余降级而非报错 | **降级策略** | ⚠️ 勉强 |
| Anthropic adaptive 模型按 effort 反查 budget 再钳制 | **算法** | ❌ 不能 |

**「布尔位能不能表达」是本文最重要的判据**，第 5 章整章讲它。
这里先记住：从 `effort: "high"` 到 `budget_tokens: 10000` 需要一个**映射函数**
（还要按模型的上下文窗口做上限钳制），一个布尔位表达不了。

### 4.3 第三类：JSON Schema 子集不同（需要递归改写）

这一类最容易被低估。你的工具定义是一份 JSON Schema，但**各家只接受它的一个子集**。

实读 `packages/core/src/llm/dialect/tool-schema.ts`（553 行）的注释，
三条实测证据非常有教学价值：

**证据 1：`$schema` 键每轮白烧约 570 token**

> zod v4 的 `z.toJSONSchema()` 给**每份** schema 顶层加
> `"$schema":"https://json-schema.org/draft/2020-12/schema"`（57 字节）。
> 实测 40 份内置工具 schema **无一例外**，合计 2280 字节 ≈ 570 token，
> **每一轮请求都发**，且位于 prompt cache 的工具区前缀里常驻。
> 五家厂商**没有任何一家的文档承认接受这个键**——它是 zod 的产物，不是协议的一部分。

这条示范了一个重要认知：**你的 schema 生成工具会往线格式里塞它自己的东西**。
570 token/轮 × 每天几百轮 = 真金白银，而且没有任何人会注意到，因为它不报错。

**证据 2：三次真实生产事故压在一条路径上**

> OpenAI Responses 的 strict 改造（2026-07-13 `required` 缺失 / 07-14 `z.unknown()`
> 空 schema / 08-01 `propertyNames` 整请求 400 复发 8 次）此前**内联在
> `openai-responses-request.ts` 一个文件里**，另外两条线（Chat Completions 的
> `openai.ts`、原生 Anthropic 的 `anthropic.ts`）共 4 处 `input_schema` **裸透传**。
> 同一类缺陷在另外两条线上无人接。

**这是「差异散落在代码里」的典型代价**：同一类问题，一条线上修了三次，
另两条线上根本没人管。收敛成一个模块，三条线才能共享同一份知识。

**证据 3：一个「不要把它说成修 bug」的诚实标注**

> ⚠️ 第 3 条是文档依据，不是轨迹证据——本仓 51 个会话的轨迹里**查不到**任何
> schema 类 400。也就是说 Anthropic 实际上**容忍**了这些关键字 […]
> 故本层对 Anthropic 的处置刻意是**保守化下发**而非「修一个正在炸的 bug」[…]
> **不要在 PR 里把它说成修复线上事故。**

**这段值得单独学**。它示范的是「文档说不支持」和「实测正在报错」是**两种强度完全
不同的证据**，不能混。面试里如果你能区分这两者，会显得非常靠谱。

还有一个**反面教训**，同一份注释里的「刻意不做的三件事」之一：

> **不无条件剥 `default`。** 这是本层最容易犯的错：Anthropic strict **明确支持**
> `default`，而 OpenAI strict 的支持属性表里**没有**它 […]
> 一个「共用 sanitizer 顺手剥掉 default」的实现会在 Anthropic 上白丢语义。

**两族的规则正好相反时，共用一个 sanitizer 就一定会伤到一边。** 这是「共用代码」
在方言层的边界。

### 4.3b 插叙：工具调用的三处形状差异（最常写错的一块）

工具调用是 agent 的命脉，而它在两族之间**有三处独立的形状差异**。
核对本仓 `api-reference/protocol-comparison.md` §3：

**(a) 入参：对象 vs JSON 字符串**

| | Anthropic | OpenAI | Gemini |
| --- | --- | --- | --- |
| 调用位置 | `content[].type == "tool_use"` | **顶层 `message.tool_calls[]`** | `parts[].functionCall` |
| 入参形态 | `input`（**对象**） | `function.arguments`（**JSON 字符串**）⚠️ | `args`（**对象**） |
| 调用 ID | `tool_use.id` | `tool_calls[].id` | **无显式 ID**（靠 name 匹配） |

**只有 OpenAI 是字符串**，所以只有它需要「累加片段再 `JSON.parse`」（3.3 节那个累积器）。
Anthropic 走 `input_json_delta` 拼 `partial_json`，最终也是对象。

**(b) 结果回传：位置完全不同**

| | 回传形态 | 配对键 |
| --- | --- | --- |
| Anthropic | `user` 消息内 `{type:"tool_result", tool_use_id, content}` | `tool_use_id` ↔ `tool_use.id` |
| OpenAI | **独立的 `{role:"tool", tool_call_id, content}` 消息** | `tool_call_id` ↔ `tool_calls[].id` |
| Gemini | `user` 消息内 `{functionResponse:{name, response}}` | **`name` ↔ `name`**（没有 ID！） |

**这是「结构不同」而非「字段改名」的教科书例子**：Anthropic 把工具结果塞进
一条 user 消息，OpenAI 用一条独立的 `role:"tool"` 消息。
消息**条数都不一样**，不可能用改字段名解决。

**Gemini 那一格尤其值得注意**：它**没有调用 ID**，靠函数名配对。
这意味着**同一轮里并行调用同一个工具两次，它在协议层就无法区分结果**。
（这类「协议本身表达不了」的限制，是能力位也救不了的——只能在转换层报错或串行化。）

**(c) 配对完整性是 400 高发区**

sid-code 用 `protocol-sentinel.ts` 在**发送前**校验配对完整性
（参考文档原话：「orphan tool_use/tool_result 是 400 高发区」）。

**为什么值得单独设一道发送前的门**：孤儿 `tool_use`（有调用无结果）
或孤儿 `tool_result`（有结果无调用）会被服务端 400 拒掉，
而这时你已经付出了一次网络往返，且错误信息通常只说「messages 格式不对」，
**不告诉你是哪一条孤儿**。在本地校验能立刻指出是哪个 ID 不配对。

**这是「把远端的模糊报错换成本地的精确报错」这个模式的一个实例** ——
和第 3.4 节坑 1（报错点离根因极远）是同一类问题的两种解法。

**(d) `tool_choice` 的语义映射**

| 语义 | Anthropic | OpenAI | Gemini |
| --- | --- | --- | --- |
| 自动决定 | `{type:"auto"}` | `"auto"` | `AUTO` |
| 强制调用某个 | `{type:"tool", name}` | `{type:"function", function:{name}}` | `ANY` + `allowedFunctionNames` |
| 强制调用任一 | `{type:"any"}` | `"required"` | `ANY` |
| 禁止调用 | `{type:"none"}` | `"none"` | `NONE` |
| 并行开关 | `disable_parallel_tool_use` | `parallel_tool_calls`（默认 true） | 默认支持 |

⚠️ 注意**并行开关的极性是相反的**：Anthropic 是 `disable_parallel_tool_use`（禁用式），
OpenAI 是 `parallel_tool_calls`（启用式，默认 true）。
**把布尔值直接透传过去，行为会完全颠倒。**

这一格也是第 4.5 节 `toolChoiceAutoOnly` 那个能力位的来源：
**GLM 只支持 `auto`**，不支持 `none`/`required`/指定函数。
所以「强制调用任一」这个语义在 GLM 上必须降级为 `auto`，而不是原样下发。

### 4.4 第四类：语义相反（最危险，会算错钱）

**这是全文最该背下来的一节。** 同一个字段名，两族的**含义相反**。

实读 `packages/core/src/llm/types.ts` 的 `normalizeCacheUsage`（原文注释）：

> - **Anthropic**：`inputTokens` 已是未命中余量 →
>     uncached = inputTokens；promptTotal = inputTokens + hit + write。
> - **OpenAI/DeepSeek**：`inputTokens = prompt_tokens` **含命中** →
>     uncached = inputTokens − hit（DeepSeek 写入恒 0）；promptTotal = inputTokens。

画成图：

```
Anthropic 的 input_tokens：          ┌─ uncached ─┐
完整输入 = input + hit + write        │            │  + cache_read + cache_creation

OpenAI 的 prompt_tokens：            ┌──── 完整输入（已含 hit）────┐
完整输入 = prompt_tokens              │  uncached  │  cached_tokens │
```

**搞错的后果**：

- 把 OpenAI 的 `prompt_tokens` 当 Anthropic 用（再加一次 hit）→ **成本高估**，
  且缓存命中率越高，高估越多。
- 把 Anthropic 的 `input_tokens` 当 OpenAI 用（减一次 hit）→ **成本低估**，
  甚至算出负数被 `Math.max(0, ...)` 兜成 0 → 看起来「输入几乎不要钱」。

**而这两种错都不会报错。** 你会得到一份完整、自洽、精确到小数点后四位的成本报表，
只是数字是错的。

解法就是**归一化成互斥三段**（sid-code 的 `NormalizedCacheUsage`）：

```ts
interface NormalizedCacheUsage {
  cacheHitTokens: number;        // 命中（读缓存）
  cacheWriteTokens: number;      // 写入缓存（DeepSeek 恒 0，仅 Anthropic 有）
  uncachedInputTokens: number;   // 既非命中也非写入的全价输入
  outputTokens: number;
  promptTotal: number;           // = hit + write + uncached（派生，可断言校验）
}
```

三个设计点：

1. **互斥**：三段不重叠，加起来是全部输入 → 可以断言校验。
2. **`promptTotal` 是派生字段**，存在的意义就是给测试一个可断言的等式。
3. **归一化必须发生在最早的地方**（provider 解析 usage 时），
   而不是在成本计算时——否则每个消费方都要自己判断族别，必然有人漏。

⚠️ **还有一个相关陷阱（stock vs flow）**：`total_tokens_sent` 这类字段是
**末次快照值**（stock），`total_cost_usd` 是**累加值**（flow）。
拿末次快照除以累加值得到的是错数，要用累积字段
（`total_cumulative_prompt_tokens`）。这条在 sid-code 的项目约定里被列为
跨方向通用铁律之一。

### 4.5 第五类：能力有无（布尔位能表达的那部分）

这类差异是「这条渠道认不认某个字段」，纯粹的有/无。sid-code 把这类收进了
`model-compat.ts`，实读的**全部 7 个键**（`MODEL_COMPAT_KEYS`）：

```ts
"supportsReasoningEffort",                  // 认不认 reasoning_effort
"supportsThinkingToggle",                   // 有没有 thinking 开关
"thinkingAlwaysOn",                         // 有开关但只能开不能关（GLM-5.3）
"supportsMaxEffort",                        // 认不认最高档
"supportsToolChoice",                       // 认不认 tool_choice
"toolChoiceAutoOnly",                       // tool_choice 只认 auto（GLM）
"requiresReasoningContentForToolCalls",      // 工具调用需回传 reasoning_content（DeepSeek V4）
```

注意第 2 和第 3 位的关系，注释里专门解释了为什么不能合并（实读原文）：

> 与 `supportsThinkingToggle: false` 的区别是**方向相反**，两者不能互相替代：
> 本字段是"有这个开关、但只能开不能关"（GLM-5.3）。

`supportsThinkingToggle: false` = 「没有这个开关，别发」；
`thinkingAlwaysOn: true` = 「有开关，但发 `disabled` 会报错」。
**一个是「不要发」，一个是「只能发 enabled」，行为不同。**

同理第 5 和第 6 位：`supportsToolChoice: false` 是「别发这个字段」，
`toolChoiceAutoOnly: true` 是「只能发 `auto`，发 `required` 会被降级」。

**这种「看起来能合并、实际语义不同」的字段对，是能力位设计里最容易出错的地方。**

### 4.6 第六类：行为差异（既非字段也非结构）

有些差异不在请求体里，在**行为时序**上：

| 差异 | 形态 |
| --- | --- |
| 本地模型（Ollama / LM Studio / llama.cpp）在 prompt eval 阶段**合法静默好几分钟** | 「网络静默 = 挂了」这个启发式对它们不成立 |
| 有的网关抢先回 HTTP header，再等模型 prefill | TTFB 语义变成「网关接单了」而非「模型开始出字」 |
| 有的端点 `stream_options.include_usage` 不发就没有 usage | 算不出成本，但一切正常 |

**第二条尤其值得记，它是一个真实的度量陷阱。** sid-code 的实测数据：

> 同一底层模型走不同网关路由，`ttfb` 的**语义不同**：一路是「模型开始出字」，
> 另一路是「网关接单了」。实测 51 会话 / 1372 对：`deepseek-v4-pro` 的
> `ttft − ttfb` gap 占比 p50 = **86.77%**（ttfb 484ms → ttft 3983ms），
> 而 `origin-deepseek-v4-pro`（**同底层模型、同属 provider `openai`**）
> 只有 **5.02%**——差 17 倍。按 provider 汇总出的 `ttfb p50 = 2665ms` 是个假数，
> 它既不描述前者也不描述后者，却会让人下「首字节很快」的结论。

**判据**：`(ttft − ttfb) / ttft` 的中位数就是**路由缓冲指纹**，> 50% 即该路由在抢先回 header。

**因果方向别搞反**：gap 大**恰恰发生在网关响应最快的时候**
（gap>50% 的样本 ttfb p50 仅 483ms），所以这个差值**不是**框架开销，
是「网关缓冲 + 模型 prefill」。别拿它做「框架 overhead 拆解」。

sid-code 的落地方式值得学：单一事实源在 `latency-by-model.ts`，
**该模块刻意不提供跨 model 汇总的 TTFB API**——原话「提供了就会有人用」。
**用 API 的缺失来强制口径正确，比写文档说「别这么用」有效得多。**

### 4.7 六类差异总表

| # | 类别 | 例子 | 处理手段 | 会不会报错 |
| --- | --- | --- | --- | --- |
| 1 | 字段改名 | `max_tokens` vs `max_output_tokens` | 映射表 | ⚠️ 有时 400 |
| 2 | 结构不同 | thinking 的三种结构 | 转换函数 | ⚠️ 有时 400 |
| 3 | Schema 子集 | `$schema` / `propertyNames` / `default` | 递归改写 | ⚠️ 有时 400 |
| 4 | **语义相反** | `prompt_tokens` 含不含缓存 | **归一化层** | ❌ **永不报错** |
| 5 | 能力有无 | 认不认 `reasoning_effort` | 布尔位（数据） | ❌ 常静默丢弃 |
| 6 | 行为差异 | 本地模型合法静默 / 网关抢回 header | 分场景策略 + 分组度量 | ❌ 永不报错 |

**看最后一列：六类里有三类完全不报错。** 这是多 provider 层最本质的困难——
**大部分 bug 的形态是「结果错但一切正常」**，所以这个领域的工程重点是
「怎么让静默失效变得可见」，而不是「怎么处理错误」。

**还有一类特殊形态值得单列：极性相反。** 它形式上属于第 1 类（字段改名），
但危害等级是第 4 类（永不报错）：

| 极性相反的一对 | 直接透传布尔值的后果 |
| --- | --- |
| Anthropic `disable_parallel_tool_use` vs OpenAI `parallel_tool_calls` | **行为完全颠倒**，且两边都合法、都不报错 |
| Anthropic `input_tokens`（不含命中） vs OpenAI `prompt_tokens`（含命中） | 成本高估或低估（4.4 节） |

**判据**：两个字段名读起来像同一件事时，先确认**它们的默认值和极性**，
再确认语义。「名字相似」是这一层最不可靠的线索。

### 4.8 本章自检

1. 为什么 `supportsThinkingToggle: false` 和 `thinkingAlwaysOn: true` 不能合并成一个字段？
2. 把 OpenAI 的 `prompt_tokens` 当 Anthropic 的 `input_tokens` 用，成本会高估还是低估？
   缓存命中率越高，偏差越大还是越小？
3. 为什么说「按 provider 汇总 TTFB」会得到一个「既不描述 A 也不描述 B」的假数？
4. 六类差异里哪三类不会报错？这对测试策略意味着什么？
5. 工具结果回传，Anthropic 和 OpenAI 的**消息条数**为什么不一样？
   这说明它属于哪一类差异？
6. Gemini 的工具调用没有 ID，靠函数名配对。这在什么场景下会**在协议层就无法表达**？
7. `disable_parallel_tool_use` 和 `parallel_tool_calls` 直接透传布尔值会发生什么？

---
<a id="5"></a>
## 5. ★ 差异的三种表达形态（本文架构核心）

前一章列了六类差异。这一章回答**唯一真正重要的架构问题**：

> 每一条差异，应该表达成 **代码分支** / **配置数据** / **声明式描述符** 中的哪一种？

这个问题选错，就会得到两种病态之一：

- **全写成代码分支** → 上一家新厂商改一次代码，差异散落在巨型文件里
- **全写成布尔位** → 表达不了结构差异，最后还是要加代码，但现在有了一堆死字段

### 5.1 判据：一句话

> **能不能被枚举完？**
> 能枚举完 → 数据（布尔位或描述符）。
> 不能（需要算法）→ 函数。

`packages/core/src/llm/dialect/types.ts` 的原话（实读）：

> 判据是「这条差异能不能被枚举完」：能就进描述符，不能才写函数。
> 一律写函数会让 7 族出现 7 份高度重复的 if；一律写描述符则表达不了 Anthropic。

### 5.2 三层的分工（sid-code 的现状）

sid-code 现在有三层，实读 `dialect/tool-schema.ts` 里的这张表（原文）：

| 层 | 管什么 | 形态 |
| --- | --- | --- |
| `model-compat.ts` | 这条**渠道**认不认某个字段 | 布尔位（用户声明） |
| `WireDialect`（`dialect/`） | 这一**族**的请求体顶层字段发不发、发什么形状 | 声明式描述符 |
| `dialect/tool-schema.ts` | 这一族的**工具 schema 里哪些 JSON Schema 关键字合法** | **描述符 + 递归改写** |

注意三层的**作用域不同**，这是设计的关键：

```
model-compat  →  作用域 = 一条渠道（一个 availableModels 条目）  →  用户声明
WireDialect   →  作用域 = 一个协议族                            →  我们内置
tool-schema   →  作用域 = 一个协议族 × 一棵 schema 树            →  我们内置 + 递归
```

**为什么 compat 的作用域是「渠道」而不是「模型」**——实读 `model-compat.ts` 原文：

> `compat` 表达的是「**这条渠道**认什么」，不是「这个模型认什么」——同一个真名接两个渠道
> （官方端点 + 公司网关），网关那条可能因为自己做了参数透传过滤而不认 `thinking`。

**这个洞察非常重要**：同一个模型，走官方端点和走公司网关，能力可能不同。
因为网关自己会做参数过滤。所以能力位必须挂在「渠道」这个维度上，不是「模型」。

### 5.3 优先级链：三层谁说了算

实读 `model-compat.ts` 的三层表（原文）：

| 层 | 来源 | 权威度 | 覆盖面 |
| --- | --- | --- | --- |
| `compat` | 用户显式声明**这条渠道** | **最高** | 只覆盖用户配了的 |
| `model-registry.ts` | 内置注册表按模型名前缀/家族匹配 | 中 | 只覆盖已登记的模型 |
| `withCapabilityHealing` + `model-capabilities.ts` | 真实请求 400 反推 | 兜底 | **全部模型** |

**为什么用户声明的权威度最高**：因为只有用户知道他们公司的网关叫什么、认什么。
按模型名前缀匹配对 `origin-deepseek-v4-pro` 这种运维起的名字必然 miss。

**为什么自愈层不能因为有了 compat 就删**——实读原文：

> ⚠ **`compat` 不替代自愈** […] 恰恰相反，两者互补且叠加后比任何单独一层都强：
> `compat` 给先验 […] 自愈修正先验（用户也会配错，配错了仍然自愈到能跑）。
> 参照实现有 compat 无自愈——新模型 compat 猜错就是错；
> 我们此前有自愈无 compat——每家差异都要写代码分支。

**「先验 + 修正」这个组合是本章最值得记的设计模式**：
静态配置给一个起点，运行时反馈修正它。两者都不完美，叠加后覆盖面互补。

### 5.4 为什么「只有 7 个布尔位」是刻意的

参照实现（openclaw）有 20+ 个 compat 位，sid-code 只挑了 7 个。
实读 `model-compat.ts` 的理由（原文）：

> 参照实现（openclaw）有 24 位。这里只有 6 位，每一位都能指到本仓已有的一处族分支
> 与一份厂商文档依据（见各字段注释）。**没踩过的差异不预先加位**：一个没人配、
> 没人读的布尔位是死字段，而死字段会让人误以为这层已经覆盖了它其实没覆盖的事。

（注：注释写 6 位，实测 `MODEL_COMPAT_KEYS` 现为 7 位——中间加过一位，
**这是"注释里的数字会腐坏"的一个现场实例**，引用任何数字前先复跑。）

**「死字段的危害是让人误以为已覆盖」** —— 这个论证的形态值得学。它不是说
「多加字段浪费」，而是说**多加字段会造成虚假的安全感**，这是更严重的问题。

同一个道理在 `dialect/types.ts` 里又出现了一次（原文）：

> 参照实现（oh-my-pi 的 `dialect/`）是 24 个模块 5838 行，每族 240–609 行。
> 我们**只有 7 族且其中 3 族的差异是纯声明式的**，照抄那个体量等于为 3 个布尔位
> 建一个模块——那是把「收敛」做成了另一种散落。

**「把收敛做成另一种散落」** —— 这句话是对「过度抽象」最精准的描述。
为 3 个布尔位建 3 个模块，形式上是收敛了（每族一个模块），实质上还是散落
（同一个知识分在 3 处）。

### 5.5 「分类逻辑必须只有一份」——这一层存在的第一理由

这是 `dialect/` 模块**最重要**的存在理由，实读原文：

> 重构前「这个模型属于哪一族」被实现了**三次**，判据是同一套正则：
> `effort.ts classifyCapability`、`openai.ts applyDeepSeekThinking`、
> `openai.ts applyToolChoice`。三份各自维护，且后两份已经不一致
> （前者判 4 族、后者只判 2 族）。
>
> 这类重复的危害不是「代码多」，而是**新增一族时改一处、漏两处，且测试全绿**——
> 漏掉的那处会静默走兜底分支：能力算出来了却从不进请求体
> （本仓 2026-08-01 真实发生过一次）。
> 故 `classifyProtocolFamily` 是**唯一**的分类入口。

**把这段完整背下来，它是面试的黄金答案。** 拆解一下它为什么好：

1. **不说「重复代码不好」这种废话**，而是精确指出危害的**形态**：
   改一处漏两处，且**测试全绿**。
2. **有具体事故**：2026-08-01 真实发生过，形态是「能力算出来了却从不进请求体」。
3. **解法是结构性的**：不是「注意同步三处」，而是「只允许有一个入口」。

这个失效形态值得单独命名——**「算出来了但没用上」**。它的完整链路是：

```
用户设 /effort high
  → effort.ts 对未知族「乐观放行」，算出 effort=high        ✅ 算对了
  → applyDeepSeekThinking 的分派只认 4 族，未知族无分支      ❌ 没接住
  → 字段算出来却从不进 requestBody                          ❌ 静默丢弃
  → 服务端永不报 400                                        ❌ 自愈永不触发
  → 「乐观放行 + 400 自愈学真值」的闭环，恰好在它唯一的目标人群上是断的
```

**最后那句是精髓**：一个自愈机制，在它唯一真正需要服务的对象（未知模型）上失效了。
这类「闭环在关键路径上断开」的 bug，是 harness 层最难发现的一类。

### 5.6 openclaw 的极端形态：把差异全部数据化

openclaw 把这条路走到了尽头。它的 `OpenAICompletionsCompat` 有 20+ 位
（调研口径 `packages/llm-core/src/types.ts:438-484`）：

```ts
supportsStore?: boolean                            // 支持 store 字段吗
supportsDeveloperRole?: boolean                    // developer 角色 vs system
supportsUsageInStreaming?: boolean                 // stream_options.include_usage
maxTokensField?: "max_completion_tokens" | "max_tokens"
requiresToolResultName?: boolean                   // tool result 必须带 name
requiresAssistantAfterToolResult?: boolean         // tool result 后的 user 前必须插 assistant
requiresThinkingAsText?: boolean                   // thinking 块要转成 <thinking> 文本
thinkingFormat?: "openai" | "openrouter" | "deepseek" | "together" | "zai" | "qwen" | ...
cacheControlFormat?: "anthropic"                   // 第三方端点支持 Anthropic 风格 cache_control
supportsPromptCacheKey?: boolean
supportsLongCacheRetention?: boolean
// … 还有十几位
```

**看第 8 行 `thinkingFormat`**：这是「布尔位不够用时的中间形态」——
不是布尔，是**枚举**。它把第 4.2 节那个「结构不同」的差异，通过枚举出全部已知形态
硬压成了数据。**能这么做的前提是形态可枚举**，一旦出现一家的结构不在枚举里，
就要加枚举值 + 加一份转换代码。

更完整的是它的**默认值链**：

```
插件 manifest 声明 host  →  endpointClass（26 个枚举值）  →  compat 默认值  →  请求构造
                                    ↑                            ↑
                          deepseek-native / groq-native /   用户可在模型级
                          openrouter / azure-openai /       逐位覆盖
                          local / custom / invalid …
```

**这条链的价值在于「零配置也能对」**：用户只填了一个 `baseURL`，
系统从 host 推出 endpointClass，从 endpointClass 推出一整套 compat 默认值。
用户什么都不用配，绝大多数情况就是对的。

**代价**（调研口径）：openclaw 的 provider 相关代码是 sid-code 的 9 倍
（核心 31679 + 扩展 53566 + 降级 3464 行）。要理解「一个请求怎么发出去」得穿四层。

### 5.7 三种形态的选择表

| 差异形态 | 选什么 | 反面教训 |
| --- | --- | --- |
| 一个字段的有无 | **布尔位**（数据） | 写成代码分支 → 上一家改一次代码 |
| 一个字段的有限取值 | **枚举位**（数据） | 写成布尔 → 表达不了第三种取值 |
| 请求体顶层字段的形状 | **声明式描述符** | 写成函数 → N 族 N 份重复 if |
| 需要算法（映射 + 钳制） | **函数钩子** | 写成描述符 → 根本表达不了 |
| 一棵树的递归改写 | **描述符 + 递归函数** | 写成布尔 → `additionalProperties` 可在任意深度出现 |
| 「这个模型属于哪一族」 | **唯一入口的纯函数** | 实现多份 → 改一处漏两处且测试全绿 |

最后一行加粗记住：**分类逻辑永远只能有一份实现。**

### 5.8 一个跨仓陷阱：同名不同义

调研过程本身踩到过一个坑，值得单独提（来自 `00-` 那份方法论文档，原文）：

> 我在二次评审里差点把 `pi/packages/ai/src/compat.ts`（298 行）当第五个 compat 样本，
> **实读文件头是「旧 API 表面的向后兼容 re-export 层，且注明将被删除」，能力位零命中**。
> […] `compat` 在 openclaw 指能力位、在 pi 指版本兼容层。

**跨项目按关键词检索必须实读那几十行再归类。** 「文件名读起来像」不是证据。
这条对面试也有用——被问到「你看过哪些开源实现」时，
说得出「同一个词在两个项目里指不同东西」比说得出十个项目名有说服力。

### 5.9 本章自检

1. 用一句话说出「代码分支 / 布尔位 / 描述符 / 函数」的选择判据。
2. 为什么 compat 的作用域是「渠道」而不是「模型」？举一个具体场景。
3. 「compat 给先验、自愈修正先验」这个组合，比只有 compat 或只有自愈强在哪？
4. 「死字段会让人误以为这层已经覆盖了它其实没覆盖的事」——为什么这比「浪费代码」严重？
5. 「分类逻辑实现了三份」的危害为什么不是「代码多」？失效形态具体是什么？

---
<a id="6"></a>
## 6. 韧性工程：真实世界不可靠

前五章讲的是「怎么把话说对」。这一章讲**「说对了但对方不好好回话」**怎么办。

这是 sid-code 最深的一层，也是官方 SDK / 教程完全不覆盖的一层——因为
**官方 SDK 假设你在打官方端点**。一旦你面对的是公司自建网关、第三方代理、
本地 Ollama，所有假设都会破。

### 6.1 会出什么错：按「能不能重试」分两类

第一件事是**给错误分类**，因为处理方式完全不同：

```
终态错误（Terminal）—— 重试必然还是失败，立刻停
  400 请求格式错 / 401 认证失败 / 403 无权限 / 404 模型不存在
  → 重试是纯浪费，且会烧掉后面要讲的「探针配额」

可重试错误（Retryable）—— 等一会儿可能就好了
  429 限流 / 529 过载 / 500-503 服务端错 / 网络抖动 / 超时
  → 该退避重试

流验证错误（StreamValidation）—— 连上了但流本身不对
  流中途截断 / stopReason 为 null / 孤儿 tool_use / 空响应
  → 这一类最微妙，第 6.6 节单讲
```

sid-code 的 `errors.ts`（810 行实测）就是这套分类，三个错误类
`TerminalError` / `RetryableError` / `StreamValidationError`。

**这里有一条重要的归因铁律**（来自项目约定）：

> 判据优先级 = **状态码 / reason 白名单 > 数字边界 > 裸子串**。

意思是：判断「这是什么错」时，优先用结构化信号（HTTP 状态码、
错误对象的 `reason` 字段），其次用数字边界，**最后才是从错误文本里 grep 关键词**。
因为文本会变——厂商改一次错误文案，你的 `includes("rate limit")` 就失效了，
而且**失效的形态是静默降级**（分类落到「未知」，走兜底路径）。

### 6.2 重试：三个必须做对的细节

**(a) 指数退避 + jitter**

```
第 1 次失败 → 等 base × 1
第 2 次失败 → 等 base × 2
第 3 次失败 → 等 base × 4    ← 指数
…
封顶 maxDelay
每次都 × (1 ± jitter)          ← jitter 防「惊群」
```

**jitter 为什么必需**：没有它，N 个并发请求同时被限流、同时退避、
**同时重试**——第二波撞击和第一波一样密集。sid-code 用 25% jitter。

**(b) `Retry-After` 优先于自己算**

服务端明确告诉你「等 30 秒」时，你算出来的 5 秒毫无意义。
sid-code 的实测默认值（`network-profile.ts`，2026-08-29 实读）：

```
retryBackoffBaseMs:  5_000     // 首次重试就给足恢复窗口
retryBackoffMaxMs:   120_000   // 指数退避到第 5-6 次即封顶 2 分钟
maxTimeoutRetries:   10
```

注释里的校准理由（原文）：

> 旧值 4 次 + 30s 上限约 1 分钟就把机会耗尽。现按"保任务成功"取 10 次 […]
> 名义累计退避约 12+ 分钟，足够扛过短时限流与网关抖动。

⚠️ 还有一个**架空陷阱**，同一份注释里（原文）：

> 注意 fallback.ts 的 STREAM_RETRY/CONNECTION_RETRY 两阶段各有 maxDelayMs，
> 已同步放宽到 120s，**否则会架空这里的上限**。

**「架空」是多层配置系统的典型病**：你在 A 层把上限改成 120s，
但 B 层还有一个 30s 的上限在更内侧生效，于是你的修改**完全无效但不报错**。
第 6.5 节还会看到这个病的另一个形态。

**(c) 两个边界处理**（vercel-ai 的实现值得抄，调研口径）

- `isAbortError(error)` **最先判**——用户按 ESC 不该触发重试
- `maxRetries === 0` 时**不包装错误**直接抛，避免用户看到
  「Failed after 1 attempts」这种噪音包装

### 6.3 超时：为什么需要三层

**一层不够**，因为「卡住」有三种不同形态：

```
Layer 1  idle timeout            N 秒无任何事件      → TCP 彻底断了
Layer 2  content progress        N 秒无有效内容      → 连接活着但没进展
Layer 3  overall timeout         整请求硬上限        → 兜任何未知根因
```

**Layer 2 是关键，也是最容易漏的。** 为什么？

上游可以一直发 keep-alive 心跳（`: ping`）让连接看起来活着，
但**一个业务 token 都不产出**。这时 Layer 1（idle）永远不触发——
它看到事件了。只有「有效内容进展」这个更严格的谓词能抓住它。

sid-code 的 `stream-lifecycle.ts`（610 行实测）注释（原文）:

```
Layer 1  idle timeout          —— N 秒无**任何事件** → 中断（TCP 连接彻底断开）
Layer 2  content progress      —— N 秒无**有效业务内容** → 中断（防 keep-alive/ping 续命）
Layer 3  overall timeout       —— 整个请求从开始超过硬上限 → 中断
signal   abort 穿透            —— 用户 ESC / 上层超时 → 立即退出
TTFT     first-content 回调    —— 首个真实内容事件到达时回调一次
```

**关键设计决策**（原文）：

> **provider 提供"进展判定"，通用层管定时器。**
> openai 的 keep-alive 判定发生在 SSE 原始字节层，anthropic 的事件已结构化——
> 两者对"什么算业务进展"定义不同。解法：通用层管定时器和 signal，
> provider 通过 `isContentProgress` 回调告诉通用层"这个事件算不算进展"。

**这个模式（通用层管机制、provider 管判据）是本章最值得抄的设计。**
它让新增 provider「白嫖」全套超时保护——只要实现一个回调，
三层超时 + TTFT 追踪全部免费拿到。

### 6.4 一个必须知道的教训：层数是负资产

看到「三层超时」很容易觉得越多越好。**恰恰相反。**
sid-code 横向对标六个开源项目后的结论（来自记忆记录，实测读源码）：

> 开源项目全是 1 层且更优。**层数是负资产。**
> `300_000` 这个常量的语义是 **idle 而非 total**。

以及一条真实事故：

> **多层超时同为 300s → 单点修复只换杀手。**
> 三层的值一样，你以为修了最外层，实际是内层先开枪。
> 而且 #2/#3 不写 `TimeoutFired` 事件，所以它们在遥测里**隐身**。

**这就是「伪阶梯」**：多层的价值来自**层与层之间的值不同且语义不同**。
三层同值 = 一层，但你以为有三层，于是排查时找错地方。

sid-code 现在的层级是**刻意错开**的（`network-profile.ts` 实读）：

```
contentProgressTimeoutMs   480s   ← provider 内层：信息最多，最先判
fallbackStreamTimeoutMs    600s   ← fallback 层
watchdogNoProgressMs       720s   ← 外层复核：信息最少，最后判
maxTurnDurationMs          90min  ← 单轮硬顶，不感知进展
```

**排序理由写得极好**（原文）：

> **必须比 provider 层的档②（480s）与 fallback 层（600s）都更宽**：
> watchdog 是远端观察者，读的是 provider 广播出来的快照，掌握的信息严格少于
> provider 自己 —— **信息更少的一层更激进，就会在 provider 还没判定之前先开枪。**

**「信息更少的一层不该更激进」是一条通用的分布式系统原则**，
不只适用于超时。面试时能说出这条会很亮眼。

### 6.5 放宽超时的连带效应（一个漂亮的完整论证）

`network-profile.ts` 里这段是我见过对「改一个常量的连带后果」最完整的分析（原文）：

> `maxTurnDurationMs` 90min […] **必须与上面的放宽同批次抬**，否则 `fallback.ts` 的
> S3 判据（`remaining <= effectiveDelayMs + MIN_USEFUL_ATTEMPT_MS` → 停止重试）
> 会先把重试预算判死：最坏路径是 3 个 attempt 各跑满 720s + 2 次退避各 120s ≈ 2400s，
> 撞破旧的 30min 硬顶 —— 等于**"为了保成功放宽了超时，却把保成功的另一半（重试）关掉了"**。

拆解为什么这个论证好：

1. **算了具体的最坏路径**：3 × 720s + 2 × 120s = 2400s，不是「感觉可能不够」。
2. **指出了自相矛盾**：放宽超时和保留重试都是为了「保成功」，
   只改一个会让另一个失效——**净效果可能是负的**。
3. **给出了操作纪律**：「同批次抬」，不是「记得也要改那个」。

还有一条相关的方法论（来自记忆记录）：

> **被截断的分布不能论证自己的上限。** max 紧贴常量 = 先怀疑删失
> （censoring），不是「实测最大值就是这么大」。

意思是：如果你观测到的 idle gap 最大值是 299s，而你的超时常量是 300s，
**你不能得出「300s 够用」的结论**——因为超过 300s 的样本全被超时杀掉了，
它们从未进入你的数据。要先放宽超时、拿到未截断的分布，再来论证上限。

sid-code 现在的 600s 就是这么来的（原文）：

> 600s 的依据是**已解除删失**的新分布（>600s: 0/1370，实测 idle gap max 293.1s）。

**先解除删失，再论证上限** —— 这个顺序在任何「基于观测数据调参」的场合都适用。

### 6.6 降级：主模型挂了怎么办

重试是「同一个模型再试一次」，降级是「换一个模型」。

sid-code 的 `fallback.ts`（**2405 行实测**，注意比旧文档写的 1289/1362 大得多）
覆盖的场景，从注释里读（原文）：

```
- QuerySource 前台/后台差异化
- 指数退避 + 25% jitter + Retry-After 优先
- x-should-retry header 支持
- rate-limit-reset header 解析
- 529 连续计数 + Fallback 触发
- max_tokens 溢出自动恢复
- 401 认证刷新重试
- keep-alive 管理（ECONNRESET/EPIPE）
- Telemetry 埋点回调
- persistent retry
```

几个值得单独讲的：

**(a) 529 连续 3 次才降级，不是一次就降**

单次 529 可能是瞬时抖动，立刻降级会让用户莫名其妙换了模型。
连续 3 次说明是持续过载。**「计数阈值」是避免过度反应的通用手段。**

**(b) max_tokens 溢出自动恢复**

请求的 `max_tokens` 超过模型剩余空间时会 400。解法是自动下调重试。
关键细节：**按 `contextLimit` 的 5% 算下限，不是固定 3K**——
因为 1M 窗口的模型和 32K 窗口的模型，「合理的最小输出预算」差 30 倍。

**(c) 三种切换模式 ask / auto / off**

这是**权限设计**渗进 provider 层的例子：换模型意味着换钱、换效果，
用户可能想被问一下。`ask` = 问，`auto` = 自动切，`off` = 不切。

**(d) persistent 模式：无限重试**

给长任务用的。5 分钟上限退避，不放弃。
**这是「无人值守跑长任务」这个场景的直接需求**——人不在场时，
「失败退出」比「一直重试」糟糕得多。

### 6.7 冷却与探针：一个非常精巧的设计

这一节讲 sid-code 的 `cooldown-probe.ts`，**它是本章最值得学的单点设计**，
因为它示范了「一个看起来正确的机制，如何有一个结构性盲区」。

**背景**：多路并发时，一路撞 429，其余路径就该延迟起跑（共享冷却），
免得一起去撞。这叫「共享限流冷却」。

**盲区**（实读 `cooldown-probe.ts` 原文）：

> S2 有一个结构性盲区：**冷却只有两条出口——自然到期，或该模型成功产出一次内容
> （`clearCooldown`）。** 而当所有并发路径都在守冷却时，没人去发那一发请求，
> 于是"成功产出"这个出口永远走不到。结果是：网关回一个偏保守的 `Retry-After`
> （或限流窗口其实早已过去），全部路径仍然把这段睡满——
> **S2 从"更省"退化成纯"更慢"。**

**这个 bug 的形态值得记**：一个机制有两条出口，其中一条在特定条件下**必然走不到**，
于是退化成只有另一条。而这个退化**完全不报错**，只是变慢。

**解法：探针**。放一路先走，其余照旧等。成功 → 一次性解放所有路径；
失败 → 只烧掉一发请求。

但「直接放一路走」会踩两个坑，于是需要**三个判定函数**（原文）：

> 1. **不是所有冷却成因都值得用一发真实请求去试。** 认证失败、模型不存在这类
>    "敲错门"的故障，等多久答案都不会变，探针纯属白烧 → 判定 ①。
> 2. **不是所有成因都该共用同一份配额。** 429 是**全局配额**问题（一路探出的结论
>    对所有路径都有效，所以整个冷却窗口只该有一发探针）；而超时 / 网络抖动是
>    **单路径**问题（我的 socket 断了，不代表你的也断），拿全局配额去卡它就是
>    让健康的路径替坏路径背锅 → 判定 ②。
> 3. **探针失败不等于"配额还没恢复"。** 探针撞上 401 / 模型不存在，说明的是
>    "这次没敲对门"，它对"限流窗口过了没有"**一个字都没回答**。这种失败就该把
>    配额还回去 → 判定 ③。

**第 3 条是三条里最精妙的**：它区分了「探针的失败」和「探针要测的那件事的失败」。
探针撞 401 是探针自己的问题，不是「限流还没恢复」的证据，所以不该消耗配额。

**这种「区分失败的归属」的思路，是韧性设计的高阶技巧。**

openclaw 有同类设计（调研口径 `failover-policy.ts`），三个函数：
`shouldAllowCooldownProbeForReason` / `shouldUseTransientCooldownProbeSlot` /
`shouldPreserveTransientCooldownProbeSlot`。它的失败归类有 **16 类**
（`auth` / `auth_permanent` / `format` / `rate_limit` / `overloaded` / `billing` /
`server_error` / `timeout` / `tls_certificate` / `context_overflow` /
`model_not_found` / `session_expired` / `empty_response` / `no_error_details` /
`unclassified` / `unknown`），**归类直接驱动探针策略**。

**「失败归类的粒度，决定了你能做多精细的恢复策略」** —— 这是 16 类 vs 3 类的实质差别。

### 6.8 本地模型：一个反直觉的场景

openclaw 的 idle 超时**按场景分档**（调研口径 `llm-idle-timeout.ts`）：

```
DEFAULT_LLM_IDLE_TIMEOUT_MS      = 120_000   // 云端默认 2 分钟
SELF_HOSTED_LLM_IDLE_TIMEOUT_MS  = 300_000   // 自建（ollama/lmstudio/vllm/llama-cpp）5 分钟
CLOUD_LLM_FIRST_EVENT_TIMEOUT_MS = 120_000   // 首事件超时单独一档
LOCAL_LLM_FIRST_EVENT_TIMEOUT_MS = 300_000
CRON_LLM_IDLE_TIMEOUT_MS         = 60_000    // cron 有外层看门狗，必须更早失败
```

理由（原文）：

> 本地 provider（Ollama / LM Studio / llama.cpp）在 prompt eval 和 thinking 阶段
> **合法地静默好几分钟**，「网络静默 = 挂了」这个启发式对它们不成立，
> 所以按 baseUrl 是否 loopback/私网/`.local` 分档。

**最后一档（cron 60s）的理由更妙**：cron 有外层看门狗，
**必须更早失败让 fallback 链有机会跑**。如果内层超时比外层还宽，
外层一开枪就直接杀了整个任务，降级链根本没机会执行。

**这又是 6.4 那条原则的一个实例**：层级的值必须按「谁的信息多」和
「谁该先动」排序，不能随手取。

还有一个 sid-code 没有的维度：**工具活动心跳**
（openclaw 的 `tool-activity-heartbeat.ts`）。长跑工具每 60s 上报一次活动，
让 attempt 级的 idle 看门狗不误杀。

### 6.9 一个宿主层的坑：休眠会污染耗时

这条来自 sid-code 的真实排查（记忆记录 + 代码实读，
`fallback.ts` 与 `stream-lifecycle.ts` 都 import 了 `sleep-detect.ts`）：

> **宿主休眠污染耗时 + 给超时闸门续命。**
> `agent_ms` 超上限而 `timed_out=None`，看起来像闸门坏了。
> 真凶是 pmset 里 717s 的休眠——alarm 按「可运行时间」算，而 `now_ms` 取墙钟。
> 长时评测先 `caffeinate -dimsu`。

所以 sid-code 的三层超时判据统一改成了 `now - start - sleepPause`
（`network-profile.ts` 的 PR9 注释：「休眠扣减下沉到流式路径」）。

**这个坑的教学价值**：「超时」这个概念依赖「时间」，而**墙钟时间不等于可运行时间**。
笔记本合盖 12 分钟，墙钟走了 12 分钟，但你的程序一个指令都没执行。
按墙钟判超时 = 把休眠算成「上游没响应」。

还有一条同源教训：

> **休眠扣减只在 loop.ts → fallback 误杀。** 两套判据同刻相反；**抬阈值治不了**。

一层做了休眠扣减、另一层没做，于是同一时刻两层的判断相反。
**修法不是抬阈值，是让判据统一。**

### 6.10 本章自检

1. 为什么 idle timeout 一层不够？举一个 idle 不触发但请求实际已死的场景。
2. 「三层超时同为 300s」的危害是什么？为什么比只有一层更糟？
3. 「信息更少的一层不该更激进」——用 watchdog 和 provider 的关系解释这句话。
4. 放宽超时时为什么必须同批次抬 `maxTurnDurationMs`？不抬会发生什么？
5. 冷却探针的「判定 ③」（失败时归还配额）为什么必需？
6. 为什么本地模型的 idle 超时要更宽，而 cron 的要更窄？
7. 按墙钟判超时会在什么情况下误杀？

---
<a id="7"></a>
## 7. 元数据与能力发现：这个模型到底支持什么

### 7.1 你需要知道的三件事

发一次请求之前，你必须知道这个模型的三类元数据：

| 类别 | 具体字段 | 不知道会怎样 |
| --- | --- | --- |
| **能力** | 支不支持 tools / vision / thinking / prompt cache | 发了不支持的字段 → 400 或静默失效 |
| **限额** | contextWindow / maxOutputTokens | 算不出还剩多少空间 → 超限，或 auto-compact 失效 |
| **价格** | input / output / cacheRead / cacheWrite 单价 | 算不出成本 → 「更省」这个方向整个没有度量 |

**这三类里最容易被忽视的是 contextWindow**，因为它错了以后的失效形态最隐蔽：
上下文预算算错 → auto-compact 该触发时不触发 → 直到某一轮突然 400 超限。

### 7.2 元数据从哪来：四种源

| 源 | 优点 | 缺点 |
| --- | --- | --- |
| **硬编码在代码里** | 简单、离线可用、权威 | 新模型必须发版才支持 |
| **外部目录**（models.dev / litellm / OpenRouter） | 覆盖广、自动更新 | 依赖网络；对私有模型名必然 miss |
| **网关自报**（`/api/pricing` 之类） | 对企业网关是**唯一正确源** | 各家网关接口不统一；数据可能是编造的 |
| **运行时探测**（发请求看报什么错） | 覆盖 100%，包括未知模型 | 要付一次 400 的代价 |

sid-code 用的是**三源合流 + 一个自愈层**（实读的模块）：

```
model-registry.ts            1176 行   内置权威能力表
model-capabilities.ts        1741 行   从 litellm / OpenRouter 动态采集（TTL 24h，失败退避 30m→24h）
gateway-pricing.ts            957 行   从 new-api 类网关 /api/pricing 采集价格（按归一化端点分桶）
model-compat.ts               290 行   用户在 availableModels[].compat 里显式声明（第 5 章）
withCapabilityHealing        openai.ts  400 自愈（本章 7.4）
```

优先级：**用户手写 > 网关采集 > 内置注册表 > 兜底默认值**。

**为什么用户手写最高**：只有用户知道他们公司网关上那个叫
`origin-deepseek-v4-pro` 的东西实际是什么。任何按名匹配都会 miss。

### 7.3 磁盘缓存必须视为不可信（一个价值极高的事故）

这条是本章最重要的教训。实读 `model-capabilities.ts` 原文：

> ⚠ 关键：磁盘数据一律视为不可信（可能被手工改坏、被旧版本写入、或被外部工具篡改），
> […] 事故复现：`{"contextWindow": 1e400}` JSON 解析后是 `Infinity`——
> 它是 `typeof === "number"` 且 `> 0`。

**拆解这个 bug 为什么如此阴险**：

```js
JSON.parse('{"contextWindow": 1e400}').contextWindow   // → Infinity
typeof Infinity === "number"                            // → true   ✅ 类型检查通过
Infinity > 0                                            // → true   ✅ 正数检查通过
```

于是 `if (typeof v === "number" && v > 0)` 这个**看起来无懈可击**的校验放它过了。
后果（实读原文）：

> 导致上下文预算永远「还有空间」，auto-compact / 超限检测**全部失效**。

**失效链条**：一个畸形的数字 → 通过了两道校验 → 上下文预算变成无穷大 →
「还剩多少空间」永远是「很多」→ 压缩永不触发 → 一路涨到真正 400。
**中间没有任何一步报错。**

正确的校验（实读原文）：

> 严格数值校验：第三方数据不可信，非有限/非正/非整一律丢弃（含 Infinity/NaN）。

即必须是 `Number.isFinite(v) && Number.isInteger(v) && v > 0`。
`Number.isFinite` 是关键——`typeof === "number"` 不排除 `Infinity` 和 `NaN`。

还有一个**同源的连带通路**，同一份文件里（原文）：

> validator 会被原样塞进出网请求头，所以它是**磁盘 → 请求头**的一条数据通路，
> 必须当不可信。

**「磁盘 → 请求头」这个视角很重要**：一旦某个磁盘上的值会进入出网请求，
它就是一条注入通路，不只是数据质量问题，还是安全问题。

以及一条 sanitize 的粒度决策（原文）：

> 不牵连其它字段（例如 contextWindow 是 Infinity 但 maxOutputTokens 合法时，仍保留后者）。

**逐字段丢弃而非整条丢弃** —— 因为整条丢会让一个坏字段毁掉一整条本来可用的记录。

### 7.4 400 自愈闭环：sid-code 独有的能力

三个外部项目都没有这个（openclaw 靠静态 compat + live discovery，
opencode 靠 models.dev，vercel-ai 是库不管这事）。

**问题**：企业自建网关上有个私有模型名，你不知道它支不支持 `reasoning_effort`。
内置注册表按名匹配必然 miss，外部目录也没有它。怎么办？

**sid-code 的答案**：乐观放行 → 撞 400 → 从错误文本学真值 → 剥字段重试 → 记账。

实读 `openai.ts` 的 `withCapabilityHealing` 注释（原文）：

> 能力自愈包装 —— 「永不报错」的执行层。
> 未知模型的能力靠乐观假设，假设错了会 400。这里捕获那类 400，从错误文本学到真值
> （写入能力缓存），剥掉冒犯字段重试一次。**用户看到的是一次正常完成的请求；
> 下次起缓存已准，不再多这一跳。**

这段实现里有**五个细节**，每一个都是踩出来的：

**(1) 只自愈「我们自己多发的字段」**（原文）

> 只自愈**我们自己多发的能力字段**（当前：reasoning_effort / reasoning.effort）。
> 其余错误（鉴权、限流、上下文超限、模型不存在）原样透出——那些不是能力误判，
> 盲目重试只会掩盖真问题。

**边界画得很清楚**：自愈的对象是「我们猜错了」，不是「所有 400」。
把鉴权失败也自愈了 = 掩盖真问题。

**(2) 判据是「措辞匹配 OR 结构匹配」，两条缺一不可**（原文）

> - `learnFromError().dropEffort` 认措辞，顺带把服务端自报的档位学进缓存（有值才学）。
> - `shouldRetryWithoutEffort()` 只认 HTTP 4xx，不看措辞——这是兜底。
> 因为我们现在会对未知族**主动多发** `reasoning_effort`，若只靠措辞匹配，
> 漏判就等于让用户看到一个修复前不存在的 400（**实测 11 种真实措辞漏 5 种**）。

**「11 种措辞漏 5 种」是这条设计的全部依据。** 这就是第 6.1 节
「裸子串是最弱判据」的实证：厂商的错误文案五花八门，纯文本匹配召回率不到一半。
所以必须有一个不看文本的结构兜底（只看 HTTP 4xx）。

**(3) 只在「尚未产出任何内容」时自愈**（实读代码注释）

> 只在「首次尝试 + 尚未产出任何内容 + 我们确实发了 effort」的错误上考虑自愈；
> **已经开始输出就不能重发（会重复内容）。**

流式重试的硬约束：吐了一半再重来，用户会看到重复内容。

**(4) `sawError` 标志防「把重试也失败当成功记账」**（实读代码注释）

> 本轮是否出过错。第二轮的错误是直接 yield 出去的（不再自愈），
> `capabilityError` 仍为 null——**不单独记一个标志就会把「重试也失败」当成成功记账。**

这是记账正确性的细节：剥掉字段后**仍然失败**，说明 400 的原因不是那个字段，
不该把这个模型标成「不支持 effort」——**否则会冤枉一个其实支持的模型**。

**(5) 缓存按真名记账，不按别名**（实读代码注释）

> 400 是端点针对真实模型报的，学到的「不支持 effort」属于那个真模型，
> 不属于某条本地别名。用别名当 key 会让同一真模型的两个渠道各自重新踩一遍 400
> （学不到彼此的经验），也会污染 `lookupCapability` 的前缀/家族匹配。

**注意这里和第 5.2 节的对比**：`compat` 按**别名**建键（因为它表达「这条渠道认什么」），
自愈缓存按**真名**建键（因为 400 是真实模型报的）。
**同一个系统里，两层用不同的键，各有各的理由** —— 这是设计精度的体现。

### 7.5 「闭环在关键路径上断开」——自愈的一次真实失效

第 5.5 节提过这条，这里补完整，因为它是自愈机制**最重要的反面教训**：

```
effort.ts 对未知族乐观放行，算出 effort=high              ✅
  ↓
applyDeepSeekThinking 的分派只认 4 族，未知族没有分支       ❌ 没接住
  ↓
字段算出来却从不进 requestBody                            ❌
  ↓
服务端永不报 400                                          ❌
  ↓
自愈对未知模型永不触发                                     ❌
```

**结论**：「乐观放行 + 400 自愈学真值」这个闭环，
**恰好在它唯一的目标人群（未知模型）上是断的。**

而这个断裂的**症状是零**：没有报错、没有异常日志、遥测里那类事件计数是 0。
而「计数为 0」有两种成因长得完全一样——**「没有故障」和「代码不可达」**。
这就是第 9 章要讲的核心问题。

顺带记住那条取舍的表述（很值得学的思考方式）：

> 下发 = 主动去撞可能的 400 换自愈学习，代价是首次可能多一跳；
> 反面更糟 = 用户设了 `/effort` 却静默无效，**且这个静默永远不会自愈**。

**「主动去撞错误来换取学习」是一个反直觉但正确的选择** ——
因为另一个选项的代价（永久静默失效）不可恢复。

### 7.6 三层元数据的互补关系（总结）

```
        覆盖面窄 ←──────────────────────────────→ 覆盖面宽
        权威度高 ←──────────────────────────────→ 权威度低

  compat（用户声明）      内置注册表        外部目录         400 自愈
  只覆盖配了的           只覆盖登记的       覆盖公开的       覆盖全部
  最权威                 中                中               兜底但最慢
       │                    │                │                 │
       └────────────────────┴────────────────┴─────────────────┘
                              先验                      修正先验
```

**记住这个组合逻辑**：静态源给先验（快但可能错），运行时反馈修正它（慢但一定对）。
**只有先验会在未知模型上失效，只有修正会让每次首用多付一跳。两个都要。**

### 7.7 本章自检

1. `{"contextWindow": 1e400}` 为什么能通过 `typeof === "number" && > 0` 的校验？
   正确的校验该怎么写？
2. 这个坏数据的失效链条是什么？为什么中间没有任何一步报错？
3. 自愈为什么只处理「我们自己多发的字段」，不处理所有 400？
4. 为什么自愈判据需要「措辞 OR 结构」两条？只用措辞的实测召回率是多少？
5. 为什么 `compat` 按别名建键，而自愈缓存按真名建键？
6. 「自愈对未知模型永不触发」这个闭环断裂，症状为什么是「零」？

---
<a id="8"></a>
## 8. 省钱：prompt cache 是唯一有硬数据的杠杆

### 8.1 为什么这一章重要

agent 的成本结构和聊天机器人完全不同。核心事实：

> **一个 agent 任务里，绝大部分 input token 是重复的。**

每一轮请求都要发：system prompt（含工具定义）+ 全部历史消息 + 新增内容。
第 10 轮的 input ≈ 10 × 第 1 轮。所以：

> **turns per task 是成本最大的杠杆：2× 轮数 ≈ 3–4× 成本。**

而 prompt cache 就是针对「重复前缀」的官方优化：命中的部分按 **0.1×** 计价
（Anthropic 5m cache 的口径），写入按 **1.25×**。
**5 分钟内复用一次就已经划算。**

### 8.2 前缀缓存的机制：一个字节都不能变

关键认知：**缓存匹配的是「从第一个 token 开始的、逐字节相同的前缀」**。

```
请求 1:  [system][tools][msg1][msg2]
请求 2:  [system][tools][msg1][msg2][msg3]
                                    ↑ 前缀完全相同 → 前面全部命中

请求 3:  [system+当前时间][tools][msg1][msg2][msg3]
          ↑ 第一个 block 就变了 → 后面全部失效，一个字节都不命中
```

**推论（极其重要）**：任何动态内容放在前面，都会让它后面的全部内容失去缓存。

所以有一条铁律：**动态内容必须放在最后**。常见的动态内容：

- 当前时间 / 日期
- `git status` 快照
- 随机排序的工具列表
- 每轮变化的环境信息

sid-code 踩过一个相关的坑，正是这条铁律的反面
（记忆记录 `gitstatus-frozen-snapshot-deadlock`）：

> **git-status 冻结快照致认知死锁。** 冻进 prompt 整会话不刷新 → 弱模型绕圈 26 轮。

**注意这是一个 trade-off，不是纯 bug**：把 `git status` 冻结进 prompt 保住了缓存
（省钱），但代价是模型看到的是过期状态（返工）。**「更省」和「更准」在这里直接对立。**

### 8.3 工具顺序必须稳定（一个容易漏的点）

工具定义在 system 区，属于最前面的前缀。如果你的工具列表**顺序不稳定**
（比如来自 `Object.keys()` 或 Map 遍历），**每轮的字节都不同，缓存永不命中**。

sid-code 的做法（`tool/registry.ts`）：**字典序排序 + `StructuredOutput` 强制排最后**。

第二半比第一半更聪明：`StructuredOutput` 的 schema 是**动态生成的**
（随本次请求的输出格式变），把它排在末尾，
**它的变化就不会影响前面所有工具的缓存**。

**「把不稳定项挪到末尾」这个洞察，比「排序」本身更值得记** ——
它是 8.2 那条铁律在工具区内部的应用。

vercel-ai 有同类设计（`toolOrder`，调研口径），但是纯手动列表；
sid-code 的「自动识别不稳定项并排尾」更进一步。

### 8.4 断点该打在哪：四块分区

sid-code 的 `cache-strategy.ts`（实读注释原文）把 prompt 分成四块：

> **G12 四块精细分区**：attribution（不缓存）/ corePrefix（global）/
> staticExtensions（org）/ dynamic（会话内）

配合 **G4 Global Scope**（原文）：

> 静态区可标记 `scope=global`，让所有用户共享同一份 KV Cache
> （SaaS 规模命中率远超 org 级）。

**这是一个很有想象力的设计**：如果 system prompt 的核心部分对所有用户都一样，
那它可以是**全局共享**的缓存，而不是每个组织一份。规模越大，命中率越高。

opencode 的策略更简洁（调研口径 `cache-policy.ts`），但有两个洞察值得抄：

**(a) 默认开启，理由写在注释里**：5m cache 写 1.25×、读 0.1×，
5 分钟内复用一次就划算 → 默认开是理性的。

**(b) 断点打在「最后一条 user message」而不是「最后一条 message」**（原文动机）：

> 一个 turn 会炸开成很多 assistant/tool 往返，把断点钉在 user 边界，
> **turn 内每次 API 调用都命中同一前缀。**

**这个细节很妙**：一个用户请求会触发 N 次 API 调用（工具往返），
如果断点跟着「最后一条消息」跑，每次调用的断点位置都不同 → 缓存不停重建。
钉在 user 边界，整个 turn 内断点位置固定。

### 8.5 断点数量有硬约束（两条不同的规则）

实读 `cache-strategy.ts` 原文：

> - **System blocks**：可以有多个 cache_control（每个 block 独立标记）—— OK。
>   system 总在请求最前面，服务端按序处理，多个 block 边界是合法的前缀缓存分层。
> - **Messages 序列**：只放 **1 个** cache_control（最后一条或倒数第二条）。
>   原因：服务端 KV 驱逐策略下，messages 上多断点会导致中间位置的 KV pages
>   无法被及时释放，降低服务端内存效率。

**system 可以多个、messages 只能一个** —— 这个非对称约束的理由是服务端的 KV 驱逐策略。
另外总断点数有上限（Anthropic 是 4 个），超了要**降级为忽略 + warning**，
不该报错（vercel-ai 的 `CacheControlValidator` 是这个做法，sid-code 有等价的
`assertCacheBreakpointBudget`）。

### 8.6 协议感知：给 OpenAI 打 cache 标记是无效功

opencode 有一个 sid-code 曾缺的设计（调研口径 `cache-policy.ts:42,100`）：

> 只有 `anthropic-messages` / `bedrock-converse` 尊重 inline hint，
> OpenAI（隐式前缀缓存）/ Gemini（隐式 + 带外 CachedContent）**直接跳过整个 pass**。

**因为两族的缓存机制根本不同**：

| | Anthropic | OpenAI 族 |
| --- | --- | --- |
| 机制 | **显式** —— 你打 `cache_control` 标记 | **隐式** —— 服务端自动缓存长前缀 |
| 你能控制什么 | 断点位置、scope、TTL | **只能控制「前缀稳不稳定」** |
| 结构性上限 | 高（可到 90%+） | **60–70%** |

**推论 1**：给 OpenAI 端点打 `cache_control` 标记是**纯粹的无效功**——
不报错，也不起作用，白白增加请求体。

**推论 2（考核口径）**：不能拿同一个命中率阈值考核两族。
sid-code 的项目约定明确写了这条：

> cache 命中率目标 >70%（Anthropic 族显式缓存）；
> **OpenAI 族隐式缓存结构性上限 60–70%，别拿同一阈值考核两族。**

### 8.7 一个真实的从 0 到 83% 的修复

sid-code 有这一层唯一的硬数据（记忆记录 `deepseek-cache-prefix-split-fix`）：

> **deepseek 缓存前缀断裂修复。** 按 `DYNAMIC_BOUNDARY` 拆分；命中率 **0 → 46.6 → 83.2%**。

**注意这是「0」**，不是「偏低」。前缀断裂的失效形态是**全有或全无**：
只要有一个字节在前面变了，整个缓存就是 0 命中。
所以这类 bug 的信号极强——**只要你在看命中率这个指标**。

「0 → 46.6 → 83.2」这三个数说明修了两次：第一次修对了主要断裂点（0→46.6），
第二次找到了剩余的断裂点（46.6→83.2）。

### 8.8 一个更阴的问题：网关会伪造 usage

记忆记录 `prompt-cache-closure-gateway-forges-usage`：

> **Cache 闭环：网关伪造 usage + 网关 B 漏采。** 网关 A **编造** Anthropic usage；
> 网关 B 报 2.2% 其实 95.2%。

**两个方向的错都出现了**：一个网关编造 usage 字段（数字是假的），
另一个漏采（报 2.2% 实际 95.2%）。

**这意味着「命中率」这个指标本身可能是假的。** 验证方式（记忆记录
`raw-jsonl-records-internal-request-not-wire`）：

> `raw.jsonl` 记的是**内部请求**而非 wire body —— 验 wire 要看 `usage.cache_read`。

**教训**：当一个指标的数据源是「上游自报」时，它可能是编造的。
需要交叉验证（比如用实际计费金额反推）。

### 8.9 缓存之外：其他成本杠杆

按杠杆大小排（sid-code 的北极星口径）：

| 杠杆 | 量级 | 状态 |
| --- | --- | --- |
| **turns per task** | 2× 轮数 ≈ 3–4× 成本 | ✅ 有埋点（`total_steps`） |
| **cache 命中率** | 命中部分 0.1× | ✅ 有埋点，且有硬数据 |
| **compaction 次数** | 压缩丢信息 → 重读文件 → 重复付费 | ✅ 有埋点（`compactions`） |
| **output/input 比** | 输出单价是输入的 3–8× | ❌ **数据齐全，从未做除法** |
| **side-call 成本** | 标题/摘要/recall 等辅助调用 | ✅ 但「影子调用绕过主埋点，是最易漏计的一块」 |
| **retry 白烧占比** | `retryWastedRatio` >20% 判病态 | ✅ 有埋点 |
| **cost per successful task** | = 成本 ÷ 成功率 | ❌ 需先定义「任务成功」 |

**最后一行是这一节最重要的**：2026 年公认唯一真正重要的成本指标是
**「每个成功任务的成本」**，而不是「每次调用的成本」。
因为一个便宜但失败的任务，成本是无穷大（要重做）。

而它算不出来的原因是**分母没定义**——「什么叫任务成功」在 coding agent 上
本身就是个难题。**这是个诚实的缺口，不是懒。**

⚠️ 顺带一条重要的反面教训（记忆记录 `removing-waste-does-not-yield-score`）：

> **省下浪费 ≠ 得到分数。** web 调用 14 → 0 而 outcome **逐字节不变**；
> 预算总被花光。

意思是：你把浪费的调用砍掉了，但**任务质量一点没变**——
因为省下来的预算被别的地方花掉了。**「减少浪费」和「提升结果」是两件事**，
不能拿前者的改善去声称后者。

### 8.10 本章自检

1. 为什么「动态内容必须放最后」？如果把当前时间放在 system 开头会发生什么？
2. 工具列表顺序不稳定为什么会让缓存永不命中？`StructuredOutput` 为什么要排最后？
3. 为什么断点该打在「最后一条 user message」而不是「最后一条 message」？
4. 为什么给 OpenAI 端点打 `cache_control` 是无效功？两族的命中率上限为什么不同？
5. 「命中率 0 → 83.2%」为什么起点是 0 而不是某个偏低的值？
6. 为什么「每个成功任务的成本」比「每次调用的成本」更重要？为什么它现在算不出来？

---
<a id="9"></a>
## 9. 可观测：没有埋点就没有优化

### 9.1 为什么这一章是全文的地基

回顾前八章：第 6 章讲重试和降级，第 7 章讲自愈，第 8 章讲省钱。
**这三章的所有结论，都建立在「你能看到发生了什么」之上。**

而 provider 层的特殊困难是：**它的绝大多数故障不报错**
（第 4.7 节：六类差异里三类完全不报错）。所以：

> **在 provider 层，「没有报错」和「工作正常」是两个完全不同的状态，
> 而且它们在日志里长得一模一样。**

唯一的区分手段是**主动埋点**：不是「出错时记一条」，
而是「每一次都记下发生了什么」。

### 9.2 sid-code 的 provider 层埋点：16 类事件

实读 `retry-telemetry.ts`（2026-08-29），完整的 16 类：

```
retry                              普通重试
fallback                           跨模型降级触发
529_dropped                        529 连续计数触发丢弃
max_tokens_adjust                  max_tokens 溢出自动下调
persistent_retry_wait              persistent 模式等待
auth_refresh                       401 触发认证刷新
non_streaming_degrade              SSE 走不通，降级到非流式
retry_budget_exhausted             重试预算用尽
shared_cooldown_wait               共享冷却等待
cooldown_probe                     冷却探针发出
cooldown_probe_denied              探针被拒（三个判定之一否了它）
stream_stall                       流卡住
stream_idle_timeout                Layer 1 触发
stream_content_progress_timeout    Layer 2 触发
stream_overall_timeout             Layer 3 触发
stream_completed                   正常完成
```

**注意这个清单的结构**：它把第 6 章的每一条防线都配了一个事件。
`stream_idle_timeout` / `stream_content_progress_timeout` / `stream_overall_timeout`
三个分开记 —— 这正是第 6.4 节那个教训的修法：

> 三层同值 = 一层，而且 #2/#3 不写 `TimeoutFired` 事件，所以它们在遥测里**隐身**。

**每一层防线必须有自己的事件名。** 否则你只知道「超时了」，不知道「哪一层开的枪」，
而这两者的修法完全不同。

### 9.3 ★ 最重要的一节：「零触发」有两种成因

这是本章的核心，也是我认为整份文档最值得记的一条方法论。

假设你查遥测，发现 `cooldown_probe_denied` 这个事件**计数是 0**。
这说明什么？

**两种可能，长得完全一样**：

```
成因 A：没有故障      —— 从来没有需要拒绝探针的情况，防线待命中，一切正常  ✅
成因 B：代码不可达    —— 那段代码根本没被接线，防线是死的                ❌
```

**这两种成因在数据上完全无法区分**，而它们的含义相反。

sid-code 有一条真实记录（记忆 `harness-defenses-built-but-zero-triggered`）：

> **四环防线已落地却零触发。** 代码全在，调用全 0；转向"接活已有防线"。

以及一条更精确的（记忆 `defense-trigger-rate-measurement`）：

> 防线触发率 —— **分母限定在「审计核查类任务」**，全量任务的分母会把信号稀释掉。
> 实测审计类任务 **0% 触发**，即「防线全在、调用全 0」。

**注意「分母」这个词**，它是这条方法论的另一半（第 9.5 节详讲）。

**这条教训催生了一个验收判据**（项目约定原文）：

> 新增防线时的验收判据：不是「build 过 + 单测过」，而是**「真实会话里被触发过」**——
> 防线自己成了它当初要消灭的死功能，这事已经发生过一次。

**「防线自己成了死功能」** —— 这句话值得反复读。你写了一段代码来防止某类问题，
结果那段代码本身就是同类问题（存在但不生效）。

**怎么区分 A 和 B**：唯一的办法是**变异自证**——
故意制造一次该触发的条件，看事件有没有出来。

> **新增门禁/防线必做变异自证。**（记忆 `static-scan-misses-indirect-disk-writes`）

而变异自证还有一个进阶要求（记忆 `harbor-gate-must-run-without-optional-dep`）：

> **变异自证要看「红的是哪一条」。**

不是「改坏了以后有测试红了」就算过 —— 必须是**你期望的那一条**红了。
否则你可能是因为另一个原因红的，而你要验的那条断言仍然是死的。

### 9.4 「指标本身可能是错的」——四种形态

这一组教训是 sid-code 最贵的资产之一，四种形态各不相同：

**形态 1：仪器少记了一个字段**（记忆 `instrument-only-records-hit-not-write`）

> 仪器只记 hit 不记 write。**结论矛盾时先怀疑仪器。**

你在分析数据时发现两个结论互相矛盾。第一反应通常是「哪个分析错了」，
但正确的第一反应是**「采集是不是漏了字段」**。

**形态 2：字段在但值是废的**（记忆 `metric-exists-but-value-is-junk`）

> 字段在但值是废的。**测试要锁值形态。**

比字段缺失更阴：字段存在、类型正确、你的代码读到了它，
但里面的值毫无意义（比如恒为 0、恒为默认值、单位错了）。

修法是**测试断言值的形态**，不只断言字段存在。
「不为 undefined」是最弱的断言，它放过了「恒为 0」。

**形态 3：代理指标奖励「重新贴标签」**（记忆 `proxy-metric-rewards-relabeling-waste`）

> 代理指标奖励"重新贴标签"。目标 4 → 0 全绿，而真实 **-11.2pp**。

这是最危险的一种。你定了一个代理指标（proxy metric）来衡量改善，
优化它，指标从 4 降到 0，测试全绿 —— 而**真实的端到端指标退步了 11.2 个百分点**。

因为「优化代理指标」的最省力方式往往是**把被计数的东西改个名字**，
而不是真的消除它。

**这条对应到项目的收尾自检**（原文）：

> **目标指标改善 + 测试全绿 + 机理讲得通，三者同时成立时结论仍然可能是错的。**
> 收尾必须回到端到端的真实指标上验证，不要只看你专门优化的那个代理指标 ——
> 代理指标会奖励「把浪费重新贴个标签」。

**「三者同时成立仍可能错」** —— 这是我见过对「工程自信」最好的一剂解药。

**形态 4：省下浪费 ≠ 得到分数**（记忆 `removing-waste-does-not-yield-score`）

> web 调用 14 → 0 而 outcome **逐字节不变**；预算总被花光。
> 「edit>0」被 `/tmp` 脚本骗过 → 用 `patch_bytes>0`。

两个教训：**(a)** 减少浪费不等于提升结果；
**(b)** 判据的选择极其重要 —— 「有没有编辑动作」被一个写 `/tmp` 的脚本骗过了，
换成「实际打了多少字节的补丁」才骗不过。

**「判据要选那个骗不过的」** —— 这是度量设计的核心技巧。

### 9.5 分母比分子重要

项目的通用铁律之一（原文）：

> **分母比分子重要。** 「命中率」「成功率」「触发率」的分母口径一变，
> 曲线就整体平移 —— 分母必须和指标一起写死。

三个真实例子：

| 指标 | 错的分母 | 对的分母 |
| --- | --- | --- |
| 防线触发率 | 全量任务（信号被稀释） | **审计核查类任务** |
| cache 命中率 | 所有请求（含无缓存模型） | 支持缓存的族，分族看 |
| TTFB p50 | 按 provider 汇总 | **按 model 分组**（第 4.6 节） |

**为什么分母错了比分子错了更难发现**：分子错通常会让数字看起来离谱
（负数、超过 100%），而**分母错只会让数字「偏一点」**，看起来完全合理。

### 9.6 stock vs flow：一个静默的算错

项目铁律之四（原文）：

> **区分 stock 与 flow。** 末次快照值（如 `total_tokens_sent`）除以累加值
> （如 `total_cost_usd`）得到的是错数，要用累积字段
> （`total_cumulative_prompt_tokens`）。

```
stock（存量 / 快照）：这一刻的值      —— 「当前上下文有 50K token」
flow （流量 / 累加）：累计发生的量    —— 「这场会话累计发了 800K token」
```

拿 stock 除 flow = 拿「最后一刻的快照」除「整场的累加」，**量纲都不对**。
但它算得出一个数，而且那个数看起来很合理。

### 9.7 三个「零命中」类的排查陷阱

这一组是**工具层面**的坑，非常实用：

**(a) zsh 不做 word splitting → grep 静默返回 0 行**
（记忆 `zsh-no-word-splitting-silent-empty-grep`）

> 多 flag 攒进变量即失效**且无报错**。「返回空」多成因长得一样，
> **猜机理 = 没查**。文档命令须按最终文本重跑。

```zsh
# bash 下可以，zsh 下静默失败：
FLAGS="-rn --include=*.ts"
grep $FLAGS "pattern" .       # zsh 把整个 $FLAGS 当一个参数 → 0 行，无报错
```

**你会得出「代码里没有这个模式」的错误结论。**

**(b) NUL 字节让 grep 静默漏报**（记忆 `app-ts-nul-byte-breaks-grep`）

> 要 `grep -a`；**结论与 git 史冲突时先疑工具**。

文件里有一个 NUL 字节，grep 把它当二进制文件，默认不输出匹配内容。

**「结论与 git 史冲突时先疑工具」** —— 当你的搜索结果和版本历史矛盾时，
不要先怀疑历史，先怀疑你的搜索命令。

**(c) 显式 undefined 击穿默认值**（记忆 `explicit-undefined-punches-through-defaults`）

> 要断「键不存在」。

```ts
function f({ timeout = 5000 } = {}) { return timeout; }
f({})                    // → 5000  ✅ 默认值生效
f({ timeout: undefined }) // → 5000  ✅ 也生效（解构默认值认 undefined）

// 但对象展开不一样：
{ ...defaults, ...{ timeout: undefined } }   // → timeout 变成 undefined ❌ 击穿了
```

所以测试要断言**「键不存在」**，不是「值不是 undefined」。

还有一条同源的（记忆 `tests-green-but-bypassing-real-entrypoint`）：

> **测试绕过真实入口。** 31 例全绿而真实 CLI 起不来。

测试直接调内部函数，绕过了真正的入口（CLI 参数解析、配置加载）。
于是入口坏了，测试全绿。

### 9.8 一个「函数零调用」推不出的结论

记忆 `zero-callers-vs-capability-ungated`：

> 「函数零调用」**推不出**「能力未生效」。

这是 9.3 的镜像：零调用可能是因为**有别的路径实现了同一件事**。
所以看到一个函数没有调用者，不能直接下「这个能力没接线」的结论 ——
要找「这件事有没有别的做法」。

### 9.9 provider 层该埋什么：一份清单

综合前面，如果你从零设计一个 provider 层的埋点，最小集合是：

| 类别 | 事件 / 字段 | 用来回答什么问题 |
| --- | --- | --- |
| **延迟** | `ttft_ms`（首个**任意**内容 chunk，含 thinking / tool_use） | 用户等多久看到第一个字 |
| | `ttfb_ms`（首字节，**按 model 分组**） | 卡在网关还是模型 |
| | 纯生成耗时（单次 fetch，不含重试） | 生成本身快不快 |
| | 整轮 API 耗时（含重试）—— **必须和上面分开** | 用户实际等了多久 |
| **成本** | 归一化后的四段 usage（hit / write / uncached / output） | 钱花在哪 |
| | cache 命中率（**分族**） | 缓存有没有生效 |
| | 轮数 / compaction 次数 | 最大的成本杠杆 |
| **韧性** | 每一层超时**各自**的事件 | 哪一层开的枪 |
| | 重试次数 + 白烧占比 | 重试有没有病态 |
| | 降级触发 + 原因 | 为什么换了模型 |
| | 探针发出 / 被拒 | 冷却机制有没有在工作 |
| **能力** | 自愈触发 + 学到了什么 | 未知模型的能力发现有没有在跑 |

**TTFT 的口径铁律**（项目原文，有 P0 bug 教训）：

> 必须是**首个任意内容 chunk**（含 thinking / tool_use），
> 且**每次 fetch 单独计、不跨重试累计**。
> 只在可视文本上计 → 对 thinking 模型和纯工具调用轮**系统性虚高数十秒**。

**为什么**：thinking 模型会先输出几十秒的思考内容，再输出可见文本。
只在可见文本上计 TTFT，等于把整个思考时间算进「首字延迟」。
纯工具调用轮更极端 —— 它**永远没有**可见文本，TTFT 会是整轮时长。

### 9.10 本章自检

1. `cooldown_probe_denied` 计数为 0，有哪两种成因？怎么区分？
2. 「防线自己成了死功能」是什么意思？新增防线的正确验收判据是什么？
3. 「目标指标改善 + 测试全绿 + 机理讲得通」三者同时成立，为什么仍可能是错的？
4. 「代理指标奖励重新贴标签」举一个具体的例子。
5. 为什么分母错了比分子错了更难发现？
6. TTFT 只在可见文本上计，对 thinking 模型会怎样？对纯工具调用轮会怎样？
7. `f({ timeout: undefined })` 和 `{...defaults, timeout: undefined}` 的行为差别是什么？
   测试该断言什么？

---
<a id="10"></a>
## 10. 四种架构原型：各自在赌什么

前九章讲的是「有哪些问题」。这一章讲**「怎么组织这些解法」**——
四个真实项目代表四种不同的架构原型，**没有一个是全面最优的**。

⚠️ 本章的外部项目数据全部来自同目录三份调研文档（调研口径 2026-08），
本文不重新测。sid-code 侧是 2026-08-29 实读。

### 10.1 四种原型一句话

| 原型 | 代表 | 一句话 |
| --- | --- | --- |
| **单体 · 韧性优先** | sid-code | 少数几家，但在真实的烂网络 + 山寨网关下不静默失效 |
| **单体 · 分层优先** | opencode | 五维正交组合，接第 N 家的成本趋近于零 |
| **插件平台** | openclaw | 每个 provider 是一个可安装插件，**第三方能加** |
| **库 + 规范** | vercel-ai | 定义契约，让 47 个 npm 包各自实现它 |

### 10.2 关键结构对照表

| | sid-code | opencode | openclaw | vercel-ai |
| --- | --- | --- | --- | --- |
| **本质** | 单体产品 | 单体产品 | 插件平台 | 库 + 规范 |
| **装配方式** | `switch(name)` 三个 case | Route 五维组合 | 插件 manifest + 17 钩子 | 实现 `LanguageModelV4` 接口 |
| **协议族数** | 3（Chat / Responses / Anthropic） | 6 | 9 | —（规范，由各包实现） |
| **provider 数** | 3 | 10 facade + 9 兼容 profile | **47 个独立扩展** | **47 个 npm 包** |
| **谁能加 provider** | 只有仓库作者 | 只有仓库作者 | **第三方（装插件）** | **任何人（发包）** |
| **协议实现方式** | 官方 SDK + 自研 SSE | **自研 SSE + Effect Schema** | 官方 SDK 包裹 | 各包自定 |
| **接口有版本号吗** | ❌ | ❌ | ⚠️（类型留了扩展口子） | ✅ **`specificationVersion` v2/v3/v4 并存** |
| **横切接缝** | ❌ 无统一 middleware | ❌ | ⚠️ 17 个生命周期钩子 | ✅ **middleware 五钩子** |
| **provider 层代码量** | 21444 行（实测 08-29） | 9533 行 | 核心 31679 + 扩展 53566 | `packages/ai` 37882 + 规范 9868 |

### 10.3 逐维度裁决（六档图例，不用星级）

图例：✅ 有且在真实路径上跑 / ⚠️ 有但有条件（未接线 / 覆盖窄 / 口径受限）/ ❌ 无 /
⬜ 不适用（定位决定的，不算缺陷）

| # | 维度 | sid-code | opencode | openclaw | vercel-ai |
| --- | --- | --- | --- | --- | --- |
| 1 | 分层正交性 | ❌ 一个 switch | ✅ 五维 | ✅ 四层 + 钩子 | ✅ 契约 + 中间件 |
| 2 | 新 provider 边际成本 | ❌ 无骨架 | ✅ 2 行 profile | ✅ 一个插件 | ✅ 一个包 |
| 3 | **第三方可扩展** | ❌ | ❌ | ✅ **唯一** | ✅ |
| 4 | 协议覆盖广度 | ❌ 3（无 Gemini / Bedrock 原生） | ✅ 6 | ✅ 9 | ⬜ 由各包决定 |
| 5 | 线格式差异表达 | ⚠️ 7 布尔位 + dialect（新增，覆盖 7 族） | ⚠️ 代码分支 | ✅ 20+ compat 位 + 26 endpointClass 自动探测 | ⬜ |
| 6 | 认证 | ❌ apiKey 字符串直传 | ✅ 凭据代数 + Redacted 类型 | ✅ 3 家 OAuth + 多凭据轮换 | ⬜ 各包自理 |
| 7 | **Prompt Cache 策略** | ✅ **四块分区 + global scope，且唯一有硬数据** | ⚠️ 声明式但策略糙 | ⚠️ per-provider compat 位 | ⚠️ 有断点预算护栏 |
| 8 | **流式韧性** | ✅ **三层超时 + TTFT 回调** | ❌ **无流内看门狗** | ✅ idle 分场景 + 工具心跳 | ❌ 只有重试 |
| 9 | 失败归类粒度 | ⚠️ 三组（Terminal/Retryable/StreamValidation） | ⚠️ 7 类 tagged reason | ✅ **16 类，直接驱动探针配额** | ❌ |
| 10 | 降级链深度 | ✅ 2405 行（跨模型 + 529 阈值 + max_tokens 恢复 + persistent） | ❌ 仅 2 次 HTTP 重试 | ✅ 3464 行（有序候选链 + 多凭据 + cooldown） | ❌ |
| 11 | 山寨网关兼容 | ✅ 事故淬炼的 per-provider shim | ❌ | ✅ **统一 guarded fetch（收敛更好）** | ❌ |
| 12 | **未知模型能力发现** | ✅ **400 自愈闭环（唯一）** | ❌ 依赖 models.dev | ⚠️ compat + live discovery（静态） | ❌ |
| 13 | **provider 层可观测** | ✅ **16 类事件进 events.jsonl** | ❌ | ⚠️ 有 failover 事件，偏单点 | ⚠️ devtools 看单次调用 |
| 14 | 可测性 | ⚠️ 覆盖广但缺线格式回放 | ✅ **40 份 HTTP 录制夹具 + golden 交叉验证** | ✅ 48 live + parity 断言 | ✅ |
| 15 | 元数据治理 | ✅ 三源合流 + **磁盘不可信强校验** | ⚠️ 单一外部源，但有跨进程锁 | ✅ bundled + remote overlay（minVersion 门控） | ⬜ |
| 16 | 接口可演进性 | ❌ 无版本字段 | ❌ | ⚠️ | ✅ **v2/v3/v4 并存 + codemod** |
| 17 | 横切关注点接缝 | ❌ 散在三个 provider 里 | ❌ | ⚠️ 17 钩子（隐式契约） | ✅ **middleware 五钩子** |
| 18 | 架构复杂度 | ✅ 一致但抽象低 | ⚠️ AISDK 遗留未拆干净 | ❌ **最高（穿四层）** | ⚠️ 72 个包 |

⚠️ **第 18 行要特别注意**：openclaw 的「复杂度最高」是它平台化定位的**代价，不是缺陷**。
把代价填进矩阵当缺点，是评估方法上的一个已知错误
（`00-` 那份方法论文档把它列为陷阱 P-7）。**矩阵只填事实，价值判断留到结论。**

### 10.4 各自在赌什么

#### sid-code 赌「已接入的这几家要在真实环境里不静默失效」

**买到的**：
- 三层超时 + TTFT 回调，长任务不会因一次抖动全废
- 事故淬炼的网关兼容层（`sse-event-line-shim` / `keepalive` / `protocol-sentinel` /
  `sanitize-unicode`），每一个背后是一次真实事故
- **400 自愈闭环**（四家里唯一）—— 新模型不用等注册表更新
- 16 类遥测事件进 `events.jsonl` —— 「省了多少 / 卡在哪」可以量
- cache 四块分区，且是唯一有硬数据的（0 → 83.2%）

**付出的**：
- **3 provider / 3 协议族，Gemini 和 Bedrock 进不来**（真欠账）
- `openai.ts` **2685 行**承载 Chat/Responses 分派 + 四族 thinking 差异 + 能力自愈 + SSE 解析
- 认证最薄（apiKey 字符串直传，无 OAuth、无凭据链、无类型层脱敏防护）
- 缺真实线格式回放测试 —— 「改了协议实现，deepseek 的线格式还对不对」
  目前没有一条命令能答

**它的定位决定了这个取舍是对的**：企业环境的特征就是
「非官方端点 + 自建网关 + 私有模型名」。为官方端点优化的代码在这里会失效。
**这是护城河，不是欠账**；而 Gemini / Bedrock 进不来才是真欠账。

#### opencode 赌「分层对了，接入成本自然趋零」

**买到的**：最少代码支撑 6 协议 10 facade；40 份录制夹具兜住协议改动；
Effect Schema 在编码前就把 body 校验掉。

**付出的**：
- **假设上游是官方端点** —— 无 SSE shim、无死 socket 处理、**无流内看门狗**
- **假设 models.dev 元数据可靠** —— 新模型无自愈路径
- **无跨模型降级** —— 主模型挂了就是挂了
- Effect-first 的阅读门槛
- **自己的迁移都没完** —— AISDK 路径还在，Copilot 还是 4517 行私有分叉

最后一条**反而是给别人的好消息**：它证明了
「先跑通再重构分层」是可行路径，不必一开始就上抽象。

#### openclaw 赌「provider 是生态，不是功能」

**买到的**：47 个 provider 全覆盖（bedrock / vertex / azure / copilot / 国产全家桶）；
**第三方可扩展**；线格式差异沉淀成数据；失败处理最精细（16 类 + 探针配额）。

**付出的**：
- **复杂度爆炸** —— provider 相关代码约是 sid-code 的 4–9 倍（口径不同差别大），
  要理解「一个请求怎么发出去」得穿四层
- **钩子的隐式契约** —— 17 个钩子的调用时机、返回 `undefined` 的语义、
  钩子间的顺序依赖全靠约定。**这类 API 一旦公开就很难改**
- **规则分散** —— 上下文溢出正则散在 47 个插件里，没有一个地方能看全，
  核心必须永远保留兜底路径
- **依赖 4 个官方 SDK** —— 好处是跟着官方走，坏处是被 SDK 的坑绑定
  （被迫在 fetch 层给 OpenAI SDK 的 `JSON.parse` 崩溃擦屁股）
- **能力发现是静态的** —— compat 猜错就是错，无自愈路径

#### vercel-ai 赌「契约对了，生态自己会长出来」

它不是 coding agent，**它是给别人造 coding agent 的地基**。
唯一的产品化压力是「几十万下游项目升级时不能炸」，这个压力逼出了三样东西：

**(a) 版本化契约**（调研口径 `language-model-v4.ts:8-61`）

```ts
export type LanguageModelV4 = {
  readonly specificationVersion: 'v4';   // ← 关键
  readonly provider: string;
  readonly modelId: string;
  supportedUrls: ...;
  doGenerate(options): PromiseLike<...>;
  doStream(options): PromiseLike<...>;
};
```

三个细节值得学：

1. **`specificationVersion` 让新旧实现在同一进程共存** —— 仓库里 `v2/` `v3/` `v4/`
   三个目录**真实并列存在**。核心拿到一个 model，读版本号就知道走哪条适配路径，
   **不需要所有 provider 同时升级**。配套 `packages/codemod` 提供自动迁移。
2. **`do` 前缀是刻意的** —— 注释写明「prevent accidental direct usage by the user」。
   **命名即约束**：用户该调 `streamText`，不该直接碰 model。
3. **prompt 类型是「内部格式」** —— 注释原文：

   > This is **not** the user-facing prompt. […] That approach allows us to evolve
   > the user facing prompts without breaking the language model interface.

   **用户面 prompt 和 provider 面 prompt 是两套类型，中间一层映射。**
   用户面怎么改都不动 provider 契约。

**(b) Middleware 五钩子**（调研口径）

| 钩子 | 作用 |
| --- | --- |
| `transformParams` | 请求参数入模型前改写 |
| `wrapGenerate` | 包裹非流式调用 |
| `wrapStream` | 包裹流式调用 |
| `overrideProvider` / `overrideModelId` | 改写身份标识 |
| `overrideSupportedUrls` | 改写 URL 支持声明 |

**精妙处**：`wrapGenerate` / `wrapStream` 同时拿到 `doGenerate` **和** `doStream`。
于是「流式降级为非流式」和「非流式模拟成流式」都能在 middleware 层实现，
**provider 一行不改**。

基于这一个接缝实现了：`defaultSettingsMiddleware` / `extractReasoningMiddleware`
（从文本抽 `<think>` 标签）/ `extractJsonMiddleware` / `simulateStreamingMiddleware` /
`addToolInputExamplesMiddleware`。**全部是纯外挂。**

**对照 sid-code**：全仓 grep `middleware|wrapProvider|wrapModel` **零命中**。
横切逻辑散在 `fallback.ts` / `resilient-stream.ts` / `stream-guard.ts` /
`stream-lifecycle.ts` / 四个 shim / 三个 provider 各自的 cache 逻辑里。
`ModelFallback` 是事实上唯一的包裹层，**但它耦合了降级语义，不是通用接缝**。

后果具体是什么：**加一个新的横切能力，要在三个 provider 里各改一遍。**

**(c) 停止条件是谓词，不是数字**（调研口径 `stop-condition.ts:16-21`）

```ts
export type StopCondition<TOOLS, CTX> =
  (options: { steps: Array<StepResult<TOOLS, CTX>> }) => PromiseLike<boolean> | boolean;
```

内置 `isStepCount(n)` / `hasToolCall(name)` / `isLoopFinished()`，
`stopWhen` 收一个数组，任一为真即停。

**对照 sid-code**：是 `maxTurns: number`。
「调了 ExitPlanMode 就停」「连续 3 轮没有工具调用就停」这类条件
**现在只能硬编码在循环体里**。

**(d) `prepareStep`：每步可换模型、工具集、消息**（调研口径 `prepare-step.ts:105-185`）

返回值可覆盖 `model` / `toolChoice` / `activeTools` / `toolOrder` /
`instructions` / `messages` / `providerOptions`。注释明确区分了
「只作用本步」（call settings）和「延续到后续步」（instructions、messages）。

**这直接关系到「更省」**：长任务后期把简单步骤降到便宜模型、
或按阶段裁剪工具集 —— sid-code **现在没有这个挂载点**。
而 sid-code 已有 `subAgentModels` 按类型分级，
说明「分级省钱」的思路是通的，只是主循环内没有同等能力。

### 10.5 一个诚实的汇总

**用「谁赢的维度多」来排名是错的**（那会让 openclaw 因为体量大而「赢」）。
真实的结构是：

- **openclaw 在「广度 + 平台化 + 失败处理」三块全面领先**，代价是复杂度爆炸
- **sid-code 在「cache 策略 / 能力自愈 / 可观测埋点 / 流式韧性」四个具体点上领先**，
  这四点都不是抽象能力而是**场景积累**
- **opencode 在「分层优雅度 + 录制测试」上赢**，其他维度是四家里最薄的
  （它是最年轻的实现）
- **vercel-ai 在「契约演进 + 横切接缝」上是唯一有答案的**，
  因为它是库，那是它唯一的生存压力

一句话概括四家的关系：

> **opencode 教你把 provider 层做「宽」（分层），
> openclaw 教你做「活」（差异数据化 + 插件化 + 失败精细化），
> vercel-ai 教你做「久」（版本化契约 + 横切接缝），
> sid-code 已经把它做「深」（韧性 + 自愈 + 埋点）。**

### 10.6 如果让你重新设计，该怎么排优先级

这是面试常问的「你会怎么做」。正确答案**不是照抄任何一家**，
而是按「能不能在现架构里增量做」排序：

| 顺序 | 做什么 | 为什么排这里 |
| --- | --- | --- |
| **P0** | **能力位数据化 + endpointClass 自动探测** | 纯增量，不动架构；加一家从「改代码」变「配一行」。**且它和 400 自愈互补**（先验 + 修正） |
| **P1** | **统一 guarded fetch** | 把 per-provider 的 shim 收敛成一个包裹所有 provider 的 fetch。现在新增 provider 得重挂一遍 shim |
| **P2** | **失败归类细化 + 探针配额** | 纯逻辑、无依赖，可直接移植。关键洞察：`model_not_found` / `auth` 这类重试必然还是失败，不该烧探针额度 |
| **P3** | **录制回放测试** | **必须在 P4 之前** —— 没有回归网不敢拆协议层 |
| **P4** | **Protocol / Endpoint / Auth / Framing 四维拆分** | 唯一能让 Gemini / Bedrock 进来的路。但成本高，且要先有 P3 |
| **P5** | **middleware 接缝** | 横切逻辑从三处收拢到一层 |
| 记账 | **版本化契约** | 3 个 provider 时收益不明显；**要做插件化 provider 时必须先有** |

**注意 P0 排在 P4 前面这个判断**——直觉会说「先拆分层，架构对了其他都好办」。
但实际相反：**先把「协议差异」从代码搬到数据里，剩下的才是真正的协议骨架**，
那时候拆分层会容易很多。

### 10.7 明确不该抄的（附理由）

| 不抄 | 理由 |
| --- | --- |
| **Effect-first**（opencode） | sid-code 是 AsyncGenerator + async/await 的一致体系。混入 Effect = 两套并发模型并存，正是 opencode 现在 AISDK/Native 并存那种技术债 |
| **插件平台化**（openclaw） | provider 数量不是 sid-code 的护城河，不值得为它付 4–9 倍复杂度 |
| **外置元数据到单一来源**（opencode） | 三源合流是为了处理「公司网关有自己的模型名和价格」，这是 opencode 不面对的场景，不能退化 |
| **只做 2 次 HTTP 重试**（opencode） | 对官方端点够用，对真实企业环境远不够 |
| **把溢出正则分散到各 provider**（openclaw） | 在 3 provider 的规模下，集中式表明显更好维护 |
| **harness / sandbox 抽象**（vercel-ai） | vercel-ai 需要它是因为要适配 5 个外部 agent。sid-code **就是**那个被适配的 agent，做这层是纯负担 |

**最后一行的视角很有意思**：vercel-ai 的 `packages/harness/` 把
claude-code / codex / opencode / deepagents / pi 五个 coding agent 抽象成了统一契约。
**也就是说，它把 sid-code 这类产品当成了自己的「被适配对象」。**

### 10.8 本章自检

1. 为什么「谁赢的维度多」是错的排名方式？
2. openclaw 的「复杂度最高」为什么不该算作缺陷？
3. `specificationVersion` 解决的是什么问题？没有它，3 个 provider 的项目会痛吗？
   什么时候会开始痛？
4. `wrapStream` 同时拿到 `doGenerate` 和 `doStream`，这个设计让什么变得可能？
5. 为什么「能力位数据化」该排在「协议分层」之前？
6. 为什么「录制回放测试」必须在「协议分层」之前？

---
<a id="11"></a>
## 12. 动手：从零实现一个 mini provider 层

看懂不等于会做。这一章给一条**五阶段路线**，每阶段有明确的完成判据。
目标不是造一个生产级的东西，是**把前十一章的概念亲手过一遍**。

⚠️ 下面的代码是**教学骨架**，刻意省略了错误处理细节。
它们不是从 sid-code 抄的，是按本文讲的原理重写的最小形态。

### 阶段 1：能跑通一家（半天）

**目标**：用 `fetch` 手写一次 OpenAI Chat Completions 流式调用，不用任何 SDK。

**为什么不用 SDK**：SDK 会替你处理 SSE 分帧、重连、错误包装——
而这一章的全部价值就在于亲手踩这些。用了 SDK 你学到的是那个 SDK，不是这件事。

```ts
// 统一的内部表示（对应第 0.2 节的 SendParams / StreamEvent）
interface SendParams {
  model: string;
  system?: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  maxTokens: number;
}

type StreamEvent =
  | { type: "text"; text: string }
  | { type: "usage"; inputTokens: number; outputTokens: number; cacheReadTokens: number }
  | { type: "done"; stopReason: string }
  | { type: "error"; message: string; statusCode?: number };

async function* streamOpenAI(
  params: SendParams,
  opts: { baseURL: string; apiKey: string },
  signal?: AbortSignal,
): AsyncIterable<StreamEvent> {
  const messages = [
    ...(params.system ? [{ role: "system", content: params.system }] : []),
    ...params.messages,
  ];

  const res = await fetch(`${opts.baseURL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${opts.apiKey}`,
    },
    body: JSON.stringify({
      model: params.model,
      messages,
      max_tokens: params.maxTokens,
      stream: true,
      // ⚠️ 第 4.6 节：不发这个，流里就没有 usage → 算不出成本
      stream_options: { include_usage: true },
    }),
    signal,
  });

  if (!res.ok) {
    yield { type: "error", message: await res.text(), statusCode: res.status };
    return;
  }

  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of res.body as any) {
    // ⚠️ stream:true 不能漏（第 3.3 节）：中文字符跨 chunk 边界会乱码
    buffer += decoder.decode(chunk, { stream: true });

    // ⚠️ 按 \n\n 分帧，不是 \n（第 3.1 节）
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);

      for (const line of frame.split("\n")) {
        if (!line.startsWith("data:")) continue;          // 注释行 / event: 行跳过
        const data = line.slice(5).trim();
        if (data === "[DONE]") return;

        const json = JSON.parse(data);
        const delta = json.choices?.[0]?.delta;
        if (delta?.content) yield { type: "text", text: delta.content };
        if (json.choices?.[0]?.finish_reason) {
          yield { type: "done", stopReason: json.choices[0].finish_reason };
        }
        if (json.usage) {
          yield {
            type: "usage",
            // ⚠️ 第 4.4 节：OpenAI 的 prompt_tokens 含缓存命中
            inputTokens: json.usage.prompt_tokens,
            outputTokens: json.usage.completion_tokens,
            cacheReadTokens: json.usage.prompt_tokens_details?.cached_tokens ?? 0,
          };
        }
      }
    }
  }
}
```

**完成判据**：
- [ ] 能流式打印出中文，且**没有乱码字符**（验证 `stream: true` 生效）
- [ ] 能拿到 `usage`（验证 `stream_options.include_usage` 生效）
- [ ] 故意把 `\n\n` 改成 `\n`，观察输出坏成什么样（**必做，体感一下 3.1 节**）

### 阶段 2：接第二家，被迫做抽象（一天）

**目标**：加上 Anthropic Messages，然后**把重复的部分提取出来**。

这一步的价值不在「写出第二个函数」，在**发现哪些是共性、哪些是差异**。
你会亲手体验到第 2.1 节说的「同一个知识被复制了 N 份」。

写完 `streamAnthropic` 之后做这件事：把两个函数并排放，**逐行标注**：

| 这一行 | 属于哪一维（第 2.2 节） |
| --- | --- |
| `${baseURL}/chat/completions` vs `/v1/messages` | **Endpoint** |
| `Authorization: Bearer` vs `x-api-key` + `anthropic-version` | **Auth** |
| system 进 messages vs 进顶层 | **Protocol**（请求侧） |
| `choices[0].delta.content` vs `content_block_delta` | **Protocol**（响应侧） |
| 按 `\n\n` 分帧 + TextDecoder | **Framing**（两家一样！） |

标完你会看到：**Framing 完全相同，Protocol 完全不同，Auth 和 Endpoint 是参数化的差异。**
这就是那五维拆分的由来——**它是从重复里长出来的，不是设计出来的**。

**完成判据**：
- [ ] 两家都能跑
- [ ] SSE 分帧逻辑**只有一份**（提取成 `parseSSEFrames(body)`）
- [ ] 上层调用代码里**没有任何 `if (provider === ...)`**

### 阶段 3：加韧性（一到两天）

**目标**：按第 6 章顺序加，每加一层都**写一个能触发它的测试**。

推荐顺序（从最容易验证的开始）：

1. **错误分类** —— `TerminalError` / `RetryableError` 两类就够。
   判据优先级：状态码 > 数字边界 > 裸子串。
2. **指数退避 + jitter + Retry-After 优先** ——
   测试用一个假 server 连续返回 429 + `Retry-After: 2`。
3. **三层超时** —— 关键是**用一个假 server 分别制造三种卡法**：
   - Layer 1：接受连接后**什么都不发**
   - Layer 2：每秒发一个 `: ping`，**永不发内容**（这一层最容易漏）
   - Layer 3：慢速但持续发内容，总时长超过硬上限
4. **归一化 usage** —— 断言 `hit + write + uncached === promptTotal`。

**这一步的核心训练是「怎么造出触发条件」**。写一个能被测试的防线，
比写一个正确的防线更难——而**不能被测试触发的防线，就是第 9.3 节那个死功能**。

**完成判据**：
- [ ] 三层超时**各有一个测试能单独触发它**
- [ ] 每层触发时**发出各自不同的事件名**（不是同一个 `timeout` 事件）
- [ ] 用 `Number.isFinite` 而非 `typeof === "number"` 校验从磁盘/网络读的数字
      （第 7.3 节，故意喂一个 `1e400` 进去验证它被丢弃）

### 阶段 4：差异数据化（一天）

**目标**：把阶段 2-3 里写出来的 `if` 分支，能变成数据的都变成数据。

具体做法：

1. **grep 自己的代码，数一下有多少处族判定**（`includes("deepseek")` 这类）。
   这个数字就是你的欠账。
2. **每一处问一遍第 5.1 节那个问题**：这条差异能被枚举完吗？
3. **能枚举的抽成布尔位或枚举位**，建一张表；不能的留成函数，
   但**分类逻辑只留一个入口**（第 5.5 节）。

一个最小的形态：

```ts
interface Compat {
  supportsReasoningEffort?: boolean;
  maxTokensField?: "max_tokens" | "max_completion_tokens";
  supportsUsageInStreaming?: boolean;
  toolChoiceAutoOnly?: boolean;
}

// 从 host 推默认值（第 5.6 节 openclaw 的 endpointClass 思路的最小版）
function defaultCompatFor(baseURL: string): Compat {
  const host = new URL(baseURL).host;
  if (host.includes("deepseek")) return { supportsReasoningEffort: true, maxTokensField: "max_tokens", supportsUsageInStreaming: true };
  if (host.includes("api.openai.com")) return { supportsReasoningEffort: true, maxTokensField: "max_completion_tokens", supportsUsageInStreaming: true };
  if (host === "localhost" || host.startsWith("127.")) return { supportsUsageInStreaming: false };
  return {};  // custom：什么都不假设
}

// 用户显式声明 > host 推导（第 5.3 节的优先级链）
const compat = { ...defaultCompatFor(baseURL), ...userDeclaredCompat };
```

**完成判据**：
- [ ] 族判定的处数比阶段 3 结束时**减少**了
- [ ] 「这个模型属于哪一族」**只有一个函数**在判（grep 验证）
- [ ] 加一家新的 OpenAI 兼容厂商，只需要**加一行**而不是改代码

### 阶段 5：埋点与验证（一天）

**目标**：让第 9 章那些指标真的能算出来。

1. **埋点**：把每个防线的触发写进一个 JSONL 文件（一行一个事件）。
   最小集合：`retry` / `fallback` / 三个 `*_timeout` / `stream_completed` / `usage`。
2. **算指标**：写一个脚本读那个 JSONL，输出：
   - TTFT p50/p95/p99（**首个任意内容 chunk，每次 fetch 单独计**）
   - cache 命中率（**分族**）
   - retry 白烧占比
3. **变异自证**（这一步最重要）：
   **故意改坏一处，确认你期望的那条指标动了**。
   比如把工具顺序改成随机，确认 cache 命中率掉到 0——
   如果没掉，说明你的采集是死的。

**完成判据**：
- [ ] 每个指标都能指到一个源字段
- [ ] 每个指标的分母都写在旁边
- [ ] **至少做过一次变异自证，且红的是你期望的那一条**

### 阶段总览：你会亲手撞到的坑

| 阶段 | 你大概会撞到 | 对应章节 |
| --- | --- | --- |
| 1 | 中文乱码（漏 `stream: true`） | 3.3 |
| 1 | 拿不到 usage（漏 `stream_options`） | 4.6 |
| 2 | 两家的工具参数格式不一样，累积逻辑要写两遍 | 3.2 / 3.3 |
| 3 | Layer 2 超时想不出怎么测（想不到「发 ping 但不发内容」） | 6.3 |
| 3 | 成本算出来是负数 | 4.4 |
| 4 | 加了个布尔位，发现表达不了 thinking 的结构差异 | 4.2 / 5.1 |
| 5 | 指标算出来了但恒为 0，分不清是没触发还是没接线 | 9.3 |

**最后一行是这条路线的终点**：当你亲手遇到「恒为 0 分不清成因」这个困惑时，
你才真正理解了第 9 章。

---
<a id="appendix"></a>
## 附录

### A. 术语表

| 术语 | 含义 | 章节 |
| --- | --- | --- |
| **线格式**（wire format） | 真正在网线上跑的那些字节。本文的核心术语 | 0.2 |
| **Provider** | 双向适配器（内部表示 ↔ 某一家的线格式），**不是厂商** | 0.2 |
| **协议族** | 一套请求/响应格式规范。三大族：OpenAI Chat / OpenAI Responses / Anthropic Messages | 1.1 |
| **静默丢弃** | 端点不认某字段，既不报错也不生效。多 provider 层最大的杀手 | 1.2 |
| **Protocol / Endpoint / Auth / Framing / Transport** | 一次调用的五个正交维度 | 2.2 |
| **边际成本** | 接第 N 家新厂商的工作量。衡量 provider 层设计好坏的核心指标 | 1.4 / 2.3 |
| **SSE** | Server-Sent Events。纯文本、单向、按行的流协议，`\n\n` 分帧 | 3.1 |
| **compat 位** | 「这条渠道认不认某字段」的布尔/枚举声明。差异数据化的形态 | 4.5 / 5.2 |
| **dialect / WireDialect** | 「这一族的请求体字段发不发、发什么形状」的声明式描述符 | 5.2 |
| **endpointClass** | 从 baseURL 的 host 推出的端点归类，用来推 compat 默认值 | 5.6 |
| **400 自愈** | 乐观放行 → 撞 400 → 学真值 → 剥字段重试 → 记账 | 7.4 |
| **stock / flow** | 存量（末次快照）/ 流量（累计）。混用会算出量纲都不对的数 | 9.6 |
| **代理指标** | 用来近似真实目标的可测指标。会奖励「重新贴标签」 | 9.4 |
| **变异自证** | 故意改坏一处，确认期望的那条断言红了 | 9.3 / 12 |
| **删失**（censoring） | 超过阈值的样本被杀掉，从未进入数据。被截断的分布不能论证自己的上限 | 6.5 |
| **路由缓冲指纹** | `(ttft − ttfb) / ttft` 的中位数。> 50% 即该网关路由在抢先回 header | 4.6 |

### B. 三十秒自检清单

设计或 review 一个 provider 层时，逐条过：

**协议与差异**
- [ ] 上层代码里有没有 `if (provider === ...)`？有就说明抽象漏了
- [ ] 「这个模型属于哪一族」有几个实现？**必须只有一个**
- [ ] 每条族差异问过「能不能枚举完」吗？能枚举的搬到数据里了吗？
- [ ] 有没有加了但没人配、没人读的布尔位？（死字段 = 虚假的安全感）

**流式**
- [ ] 按 `\n\n` 分帧而不是 `\n`？
- [ ] `TextDecoder.decode(chunk, {stream: true})` 有没有漏？
- [ ] 工具参数是**拼完才 parse** 吗？
- [ ] 有 Layer 2（内容进展）超时吗？只有 idle 超时挡不住「发 ping 不发内容」

**韧性**
- [ ] 错误分类的判据优先级是「状态码 > 数字边界 > 裸子串」吗？
- [ ] 终态错误（400/401/403/404）会被重试吗？**不该被重试**
- [ ] 退避有 jitter 吗？`Retry-After` 优先于自己算吗？
- [ ] 多层超时的值**互不相同**且按「谁的信息多谁先判」排序了吗？
- [ ] 改一层超时时，检查过它会不会架空/被架空另一层吗？

**成本**
- [ ] usage 在**最早的地方**归一化成互斥四段了吗？
- [ ] 有 `hit + write + uncached === promptTotal` 这类可断言的等式吗？
- [ ] 动态内容都在 prompt 的**最后**吗？
- [ ] 工具顺序稳定吗？动态 schema 的工具排最后了吗？
- [ ] cache 命中率的考核阈值**分族**了吗？（OpenAI 族结构上限只有 60-70%）

**元数据**
- [ ] 从磁盘/网络读的数字用 `Number.isFinite` 校验了吗？
      （`typeof === "number"` 放过 `Infinity` 和 `NaN`）
- [ ] sanitize 是逐字段丢弃而非整条丢弃吗？
- [ ] 有没有「磁盘 → 出网请求头」的数据通路？那是注入面

**可观测**
- [ ] 每一层防线有**自己的事件名**吗？（同一个 `timeout` 事件 = 三层隐身）
- [ ] 每个指标能指到一个源字段吗？分母写在旁边了吗？
- [ ] 新增的防线**在真实会话里被触发过**吗？（不是「测试过了」）
- [ ] 做过变异自证吗？**红的是你期望的那一条**吗？
- [ ] 你验证的是端到端真实指标，还是你专门优化的那个代理指标？

## 最后：这份文档想让你记住的三件事

**第一，多 provider 的难点不在「支持三个协议」。**
三个协议是一天的活。难点在**每一族内部还有几十个厂商级、模型级、渠道级的差异，
而其中大部分不会报错**。六类差异里三类完全静默——所以这个领域的工程重点是
「让静默失效变得可见」，而不是「怎么处理错误」。

**第二，架构问题的答案是「这条差异能不能被枚举完」。**
能枚举 → 数据（布尔位 / 枚举 / 描述符）；不能 → 函数。
但**分类逻辑永远只能有一份实现**——它被实现三次的后果不是代码多，
是「改一处漏两处，且测试全绿」，而漏掉的那处会静默走兜底分支。

**第三，没有埋点就没有优化，而有埋点也可能是错的。**
「计数为 0」有两种成因且长得一样；「目标指标改善 + 测试全绿 + 机理讲得通」
三者同时成立时结论仍可能是错的。所以每个数字都要能指到源字段，
每个分母都要和指标一起写死，每条新防线都要在真实会话里被触发过——
**而不是「测试过了」。**
