# 工具 schema 方言 · 出处与实测记录

> 随行文档：`tool-schema.ts` 写结论，本文写依据。
> 厂商文档 URL 直接给出（与其它随行文档只给私有库行号不同）——本层的判据全部来自
> 公开文档，可自行复核。核查日期 **2026-08-16**。

## 为什么要这一层：三条本仓实测

### ① `$schema` 每轮白烧 ~570 token

zod v4 的 `z.toJSONSchema()` 给**每份** schema 顶层注入
`"$schema":"https://json-schema.org/draft/2020-12/schema"`（57 字节）。

```
40 份内置工具 schema，含 $schema: 40（100%）
合计 2280 字节 ≈ 570 token / 每轮请求
```

它常驻 prompt cache 的工具区前缀，每轮都发。**五家厂商没有任何一家的文档承认接受
这个键**（见下方「未验证项」）——它是 zod 的产物，不是协议的一部分。

**接线后的实测（40 个真实内置工具，schema 合计 19814 字节）**：

| 线 | 处理 | 结果 |
| --- | --- | --- |
| 非 strict（Chat Completions / Anthropic 非 strict） | 只剥 `$schema` | 17534，**净省 2280 字节** |
| Anthropic strict | 剥元信息 + 剥约束、转写描述 | 17119，**净省 2695 字节** |
| OpenAI Responses strict | 剥元信息 + required 全补全 | 19079，**净省 735 字节** |

> ⚠️ **Responses 线只省 735 而不是 2280，是预期的**：strict 改造本身会**增**字节
> （`required` 补全 + optional 转 `["string","null"]`）。那部分增量在本 PR 之前就存在，
> 不是本层引入的 —— 本层在这条线上的净效果是「省下 `$schema`，其余不变」。
> **别把 2280 当成三条线的统一收益去宣传。**

### ② 三次生产事故全压在一条路径上

| 日期 | 症状 | 根因 |
| --- | --- | --- |
| 2026-07-13 | 内置工具 30 个里 23 个发给 GPT-5.x 就 400 | zod `.optional()` 不进 `required`，不满足 OpenAI strict |
| 2026-07-14 | 修完仍在 `workflow` 工具上 400 | `z.unknown()` → 空 schema `{}`，无 `type` key |
| 2026-08-01 | **整个请求** 400，一次会话复发 8 次 | `z.record()` → `propertyNames`，OpenAI strict 不允许 |

三次的修复都内联在 `openai-responses-request.ts` 一个文件里。另外两条线
（`openai.ts` 的 Chat Completions、`anthropic.ts` 的原生 Messages）共 **4 处**
`input_schema` 裸透传，同一类缺陷无人接。

### ③ 原生 Anthropic strict 路径正在下发它自己文档拒绝的关键字

实测 7 个内置工具（都被 `registry.ts:79` 打了 `strict: true`）：

| 工具 | 关键字 |
| --- | --- |
| `grep` | `minimum` ×7、`maximum` ×7 |
| `lsp` | `minimum` ×2、`maximum` ×2 |
| `enter_worktree` | `exclusiveMinimum`、`maximum` |
| `tool_search` | `exclusiveMinimum`、`maximum` |
| `ask_user_question` | `maxItems: 4` ×2 |
| `task_create` / `task_update` | `propertyNames` |

而 Anthropic strict 子集**明确不含**全部数值约束与字符串长度约束，`minItems` 只认 0/1。

> ⚠️ **这一条是文档依据，不是轨迹证据。** 本仓 51 个会话的轨迹里
> **查不到任何 schema 类 400**：
>
> ```bash
> grep -rhoiE "invalid.{0,20}schema|not permitted|unsupported.{0,20}keyword" \
>   ~/.sid-code/trajectories/sessions/*/{events,raw}.jsonl | sort | uniq -c
> # → 零命中（唯一一条命中是某份代码里的 `EvalSchema` 字符串）
> ```
>
> 也就是说 Anthropic 实际上**容忍**了这些关键字（旁证：我们一次发 40 个 strict 工具，
> 也超过它文档写的「每请求 20 个」上限而未报错）。
>
> 故本层对 Anthropic 的处置是**按文档保守化下发**，不是「修一个正在炸的 bug」：
> 裁掉文档外的约束，把有信息量的转写进 `description`（官方 SDK 的同一策略），
> 语义不丢、token 略减、与文档一致。**不要把它宣传成线上事故修复。**

---

## 各家 JSON Schema 子集（2026-08-16 核查）

### OpenAI（Chat Completions 与 Responses 同一子集）

官方文档把两者写在同一页（`?api-mode=responses` 只是切换视角）。约束**只在
`strict: true` 时生效**，非 strict 一律忽略不认识的关键字。

**支持**：`pattern`、`format`（date-time/time/date/duration/email/hostname/ipv4/ipv6/uuid）、
`minimum`/`maximum`/`exclusiveMinimum`/`exclusiveMaximum`/`multipleOf`、
`minItems`/`maxItems`、`anyOf`（各分支须各自合规，**根节点不可是 anyOf**）、
`$ref`/`$defs`（含递归）、`enum`、`const`。

**硬性要求**：每个 object 节点 `required` 覆盖 `properties` 全集 +
`additionalProperties: false`。

**拒绝（400）**：`allOf`、`oneOf`、`not`、`dependentRequired`、`dependentSchemas`、
`if`/`then`/`else`。确切文案：

```
Invalid schema for function 'create_where_clause': In context=(), 'oneOf' is not permitted.
In context=(),'required' is required to be supplied and to be an array including every key in properties.
schema must have a 'type' key
Invalid schema for function 'X': 413 parameters exceeds limit of 100.
Expected the total schema size … to be less than 15000 characters
```

**两处文档自相矛盾，本层刻意不动**：

- `minLength`/`maxLength` 不在支持属性表里，却又出现在「对微调模型我们**额外**不支持」
  一节 —— 后者暗示基础模型是支持的。**没有可信结论前不剥。**
- `default` 不在支持属性表里。三方错误库（Portkey）与 LangChain 文档都指向
  「strict 下 default 会被拒」，但 OpenAI 官方**没有**把它列进不支持清单。
  实测只有 `notebook_edit` / `tool_search` 两个工具带 `default`，Responses 线一直这么发、
  从未报错 —— **证据不足就不动。**

来源：<https://developers.openai.com/api/docs/guides/structured-outputs/> ·
<https://platform.openai.com/docs/guides/function-calling> ·
<https://community.openai.com/t/oneof-allof-usage-has-problems-with-strict-mode/966047> ·
<https://portkey.ai/error-library/schema-validation-error-10538>

### Anthropic（原生 Messages API）—— 与 OpenAI 有一处正好相反

**关键的不对称**（这是本层最容易写错的地方）：

> Anthropic 严格校验 `output_config.format.schema`，**但工具 schema 里不认识的关键字是
> 被忽略的**。 —— <https://github.com/vercel/ai/issues/14342>

- **不带 `strict`**：不认识的关键字**忽略**，只校验结构合法性
  （`input_schema: JSON schema is invalid. It must match JSON Schema draft 2020-12`）。
- **`strict: true`**：与 JSON 输出共用一个子集，用了子集外的特性**返回 400 并说明**。

strict 子集 —— **支持**：全部基础类型；`enum`（仅 string/number/bool/null，不含复合类型）；
`const`；`anyOf`；`allOf`（**但不可与 `$ref` 组合**）；`$ref`/`$defs`/`definitions`（仅内部引用）；
**`default`（全部支持类型）**；`required`；`additionalProperties`（必须为 `false`）；
字符串 `format`（date-time/time/date/duration/email/hostname/uri/ipv4/ipv6/uuid）；`pattern`；
数组 `minItems`（**只认 0 和 1**）。

**拒绝**：递归 schema、enum 里的复合类型、外部 `$ref`、**全部数值约束**
（`minimum`/`maximum`/`multipleOf`）、**全部字符串长度约束**（`minLength`/`maxLength`）、
`minItems` 0/1 以外的取值与其它数组约束、`additionalProperties` 非 `false`、`oneOf`。

**硬上限**：每请求 20 个 strict 工具；全部 strict schema 合计 24 个可选参数；
16 个 union 类型参数。**注意 strict 不要求 `required` 全覆盖**——它保留可选参数概念，
只是限量。这一条搞反的后果是把所有可选参数变成必填、模型被迫给每个字段编个值。

**官方 SDK 的做法值得抄**：自动剥掉不支持的约束并**把它们追加到 `description` 文本里**，
再做客户端校验。本层的 `pruneRejectedKeywords` 就是这个策略。

来源：<https://platform.claude.com/docs/en/build-with-claude/structured-outputs> ·
<https://platform.claude.com/docs/en/agents-and-tools/tool-use/strict-tool-use> ·
<https://github.com/vercel/ai/issues/14342>

> 抓取技巧（留给下次）：`docs.claude.com` / `platform.claude.com` 在本环境拒绝 WebFetch，
> 但给 URL 加 `.md` 后缀能拿到原始 markdown。

### DeepSeek

strict 模式**需要 `base_url` 换到 `https://api.deepseek.com/beta`**，且 tools 列表里
所有 function 都要设 `strict: true`。

支持类型：`object`/`string`/`number`/`integer`/`boolean`/`array`/`enum`/`anyOf`，
加 `$ref`/`$def`（含递归）。object 要求全部属性进 `required` + `additionalProperties: false`。

**是 400，不是静默忽略**——官方原文：「服务端会对用户传入的 Function 的 JSON Schema
进行校验，如不符合规范，或遇到服务端不支持的 JSON Schema 类型，将返回错误信息」。
**非 strict（默认 base_url）不校验，关键字静默忽略。**

没有官方的「不支持关键字」枚举清单。三方来源声称 `pattern`/`format`/长度约束全不支持，
但**DeepSeek 官方自己的 `anyOf` 示例就同时用了 `format: email` 和 `pattern`** ——
故三方清单不可信，本层不按它裁剪。

⚠️ 另有未闭 issue：strict 模式在 `/beta` 上会吐**畸形 JSON**（第一个属性名缺右引号）——
<https://github.com/deepseek-ai/DeepSeek-V3/issues/1069>。这也是本层**不替 Chat Completions
线打开 strict** 的原因之一。

来源：<https://api-docs.deepseek.com/zh-cn/guides/tool_calls>

### Google Gemini

按 protobuf 校验，所以**未知关键字表现为「未知字段」而非「不支持的关键字」**：

```
Unknown name "propertyNames" at 'tools.function_declarations..properties.value.any_of': Cannot find field.
...properties[target_locations].properties: should be non-empty for OBJECT type   ← patternProperties
```

支持：基础类型（`null` 走 `{"type":["string","null"]}`）、`title`/`description`、
object 的 `properties`/`required`/`additionalProperties`、string 的 `enum`/`format`
（date-time/date/time）、number 的 `enum`/`minimum`/`maximum`、array 的
`items`/`prefixItems`/`minItems`/`maxItems`、`anyOf`、`$ref`，
以及 Gemini 专有的 `propertyOrdering`。

**本仓当前无 Gemini 原生族**（`openai.ts:73` 自陈 gemini 只能走 OpenAI 兼容端点），
故本层暂无 gemini 条目 —— 加一个没有对应族的声明就是死配置。**接入 gemini 原生协议时
必须回来补这一条**，它的 `propertyNames` 拒绝是确证的
（<https://github.com/RightNow-AI/openfang/issues/1000>），而我们有两个工具带这个键。

来源：<https://ai.google.dev/gemini-api/docs/structured-output> ·
<https://ai.google.dev/gemini-api/docs/function-calling> ·
<https://github.com/langchain-ai/langchain-google/issues/617>

### xAI Grok —— 五家里文档最全，且有第三档

`docs.x.ai` publishes 三档模型，**第三档是别家没有的**：

1. **支持并强制**：基础类型、`enum`、`const`、`anyOf`、**`oneOf`（行为等同 anyOf）**、
   `allOf`（仅单个子 schema）、`$ref`/`$defs`（非循环）、`format`
   （date/time/date-time/email/uuid/ipv4/ipv6/uri）。
   ⚠️ `additionalProperties` **默认 false，要 true 必须显式写**。
2. **在上限内强制**：`minimum`/`maximum` 无限制；`minLength`/`maxLength` ≤ 2048；
   `minItems`/`maxItems` ≤ 256；`minProperties`/`maxProperties` ≤ 64。
3. **接受但不保证执行**（best-effort）：`not`、`if`/`then`/`else`、多支 `allOf`、
   未列出的 `format` 值、超过上限的约束。**这一档最危险：无报错、无保证、无任何信号。**

**拒绝（400）**：零分支的 `enum`/`anyOf`、schema 为字面 `true`/`false` 的属性、
`maxContains`/`minContains`、**`items` 为数组**（必须用 `prefixItems`）。

`default` 出现在它自己的参数 schema 示例里，故是接受的。

来源：<https://docs.x.ai/developers/model-capabilities/text/structured-outputs> ·
<https://docs.x.ai/docs/guides/function-calling>

### GLM（智谱）—— 无任何文档

核查了 `docs.bigmodel.cn` 的工具调用与结构化输出两页：**都没有发布任何 JSON Schema
子集、支持/不支持关键字清单，也没有工具级 `strict` 开关**。示例是纯 OpenAI 兼容形态。

结构化输出页上出现的 `minimum`/`maximum`/`additionalProperties` 位于一段**客户端**
`jsonschema.validate()` 示例里，**不是服务端强制的 schema**——照抄它当依据就是自我欺骗。

唯一确证的约束是 `tool_choice` 只支持 `auto`（已由 `glm.ts` 的 `toolChoice: "auto-only"`
表达，与本层无关）。

**处置：按最宽松处理，只剥元信息键。** 猜错的两个方向代价不对称：多剥 = 白丢语义
且无从发现；少剥 = 400 当场可见。

来源：<https://docs.bigmodel.cn/cn/guide/capabilities/function-calling> ·
<https://docs.bigmodel.cn/cn/guide/capabilities/struct-output>

---

## 三种失败模式（比关键字覆盖面更重要）

关键字清单只回答「认不认」，**失败模式回答「不认的时候会怎样」**，后者决定我们该激进
还是保守：

| 失败模式 | 谁 | 对我们意味着 |
| --- | --- | --- |
| **400 报错** | OpenAI strict、DeepSeek strict、Anthropic strict、Gemini | 响亮失败、当场可见、可自愈 → **可以激进** |
| **静默忽略** | Anthropic 非 strict、DeepSeek 非 strict、GLM | 发多了零代价 → **不必裁剪** |
| **接受但不执行** | Grok best-effort 档 | **最坏**：约束写了不生效，且完全没有信号 |

这张表是「未知族兜底为不裁剪」的依据：不确定时，宁可撞一个会报错的 400
（能学到、能自愈），也不要静默丢掉一个真会生效的约束。

## 两处需要值级判断、关键字白名单表达不了

1. **Anthropic 的 `minItems` 只认 0/1** —— 键合法但取值受限。
   故 `minItemsAllowedValues` 单独开一个字段。
2. **Grok 的约束上限**（`maxLength` ≤ 2048 等）—— 超限不报错，降级为 best-effort。
   当前不处理（我们的 schema 远不及这些上限），记录在此备查。

## 未验证项（想用先自己测，别当结论）

| 项 | 状态 |
| --- | --- |
| **顶层 `$schema`** 在五家的接受情况 | ❌ **无任何一家文档提及**。本层无条件剥它的依据是「它不是协议的一部分 + 白烧 570 token」，不是「某家会拒」 |
| OpenAI `minLength`/`maxLength` | ⚠️ 官方文档自相矛盾（见上），**故不剥** |
| OpenAI `default` | ⚠️ 仅三方来源指向被拒，官方未列，**故不剥** |
| Gemini `allOf` / `oneOf` / `$schema` | ❌ 未验证（且本仓暂无 gemini 原生族） |
| DeepSeek 真实的不支持关键字清单 | ❌ 官方无枚举，三方清单与官方示例矛盾 |

## 留的口子（真出现时再接，别提前写）

- **`oneOf` → `anyOf` 改写**：OpenAI strict 硬拒 `oneOf`（有确切 400 文案），但 zod v4 的
  union 一律 emit `anyOf`，实测 40 份 schema 里 `oneOf` **零命中**。唯一可能带它的是
  MCP 工具的外部 schema，而 MCP 工具**不打 strict**（`registry.ts:79` 显式排除）。
  真出现时在 `pruneRejectedKeywords` 旁边加一个 `rewriteOneOfToAnyOf` 即可
  （AI SDK 修 Anthropic 就是这么做的）。**现在写就是死代码。**
- **Chat Completions 线的 strict 开关**：`openai.ts` 全文零 `strict` 命中，
  `registry.ts` 打的 40 个 `strict: true` 在这条线上被完全忽略。要接需要同时决定
  DeepSeek 的 `/beta` base_url 切换 —— 那是改渠道行为，独立一件事。
