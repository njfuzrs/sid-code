# DeepSeek 方言 · 出处与实测记录

> 随行文档：`deepseek.ts` 写结论，本文写依据。
> 引用的 `deepseek-api.md` 是维护者私有文档库里的厂商 API 文档，不在本仓
> （同 `CONTRIBUTING.md` 说的「注释里的 `docs/xxx.md` 指向仓外」）。
> 行号会随厂商改文档腐坏，**结论以本文正文为准，行号仅作溯源线索**。

## 两个端点，两套线格式

DeepSeek 同时提供 OpenAI 兼容与 Anthropic 兼容端点，同一模型的请求体结构不同：

| | OpenAI 兼容 | Anthropic 兼容 |
| --- | --- | --- |
| 思考开关 | 顶层 `thinking:{type:"enabled"\|"disabled"}` | `thinking:{enabled}`（budget 被服务端忽略） |
| 思考强度 | 顶层 `reasoning_effort` | `output_config.effort` |
| 判据 | 默认 | `baseURL` 含 `/anthropic` |

这一对是「compat 布尔位表达不了族差异」的最短证明：6 个布尔位里没有一位能表达
「effort 该写到哪个字段」。

## `reasoning_effort` 只有 high / max 两档

依据 `deepseek-api.md:2003-2004`。低档不会报错，但会被服务端映射为 `high`——
即下发 `low` 与下发 `high` 等效。

客户端仍做映射（`toDeepSeekWireEffort`），理由是 `previewWireEffort` 要能对用户
诚实显示「你选了 low，实际发的是 high」。不映射的话面板显示 low、线上发 low、
服务端按 high 跑，三者对不上。

## `thinking` 开关是顶层字段，不是 `extra_body`

OpenAI **SDK** 的用法是放进 `extra_body`，但 SDK 只是把它展开到 HTTP body 顶层。
sid-code 直发 fetch，故直接写顶层即可。

## `tool_choice`：V4 思考模式下会 400

实测确认，OMP 官方配置亦标注 `supportsToolChoice: false`。
故 `toolChoice: "reject-when-thinking"`——**思考关闭时可正常下发**，
不是一律拒绝。

用户可用 `compat.supportsToolChoice: true` 覆盖这条族推导：网关可能已替我们过滤掉
该字段，或用户跑的是修过这个问题的私有版本，只有他知道。

## `reasoning_content` 回传规则在 V3.2 反转过

这是本族最容易改错的一条，两个方向都会 400：

| 模型 | tool-call 轮 | 后果 |
| --- | --- | --- |
| V4（V3.2 起）thinking 系 | **必须**回传 | 不回传 → 400 + 思维链被切断 → 思考量雪崩 → 漂移进 `content` 当正文 / 600s hang |
| 旧 `deepseek-reasoner`（R1 系，2026-07-24 弃用） | **禁止**回传 | 回传 → 旧协议 400（旧注释「实测 13 次命中」的来源） |

依据 `deepseek-api.md:1012/1055/1057`，官方样例 1160-1174 行一律
`messages.append(带 reasoning_content 的整条消息)`。

判据取 `model-registry.ts` 的 `requiresReasoningContentForToolCalls`，
**不是**散落的模型名 if——协议演进时按名判断必漂移。
用户侧出口是 `compat.requiresReasoningContentForToolCalls`：注册表按模型名前缀匹配，
私有网关上的私有模型名（如 `gw-internal-r1`）必然 miss，而这个字段
**自愈救不回来**（两个方向都是 400），故必须给显式出口。

## `insufficient_system_resource`：DeepSeek 特有的可重试终止原因

依据 `deepseek-api.md:2094-2096`。`finish_reason` 的规范 5 值之外的第 6 个取值，
须视为**可重试**而非 `end_turn`。落 default 会把「推理系统资源不足」误报成正常结束。

## `user_id`

KVCache / 调度 / 内容安全隔离。须满足 `[a-zA-Z0-9\-*]+`、长度 ≤512。
语义是 DeepSeek 专有，但字段通用——其它端点忽略不报错，故不做族门控。
