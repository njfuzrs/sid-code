# OpenAI 自家两族 · 出处

> `openai.ts`（dialect 目录下那个）写结论，本文写依据。

## o-series 与 GPT-5.x 是一组对照

放同一个文件是因为差异点**完全对称**：

| | o-series（Chat Completions） | GPT-5.x（Responses API） |
| --- | --- | --- |
| 端点 | `/v1/chat/completions` | `/v1/responses` |
| effort 字段 | 顶层 `reasoning_effort` | 嵌套 `reasoning.effort` |
| 认 `xhigh` | ❌ 钳到 high | ✅ **原生支持** |
| 认 `max` | ❌ 钳到 high | ✅ |
| 思考开关 | 无（内置） | 无（内置、不可关） |
| 默认档 | medium | medium（服务端回显实测） |

拆两个文件会让读者来回跳才能看出这组对照。

## GPT-5.x 是目前唯一原生认 `xhigh` 的协议族

实测（自建网关 `/v1/responses`）：

| 下发 | 结果 |
| --- | --- |
| low / medium / high | `reasoning_tokens = 0` |
| **xhigh** | `reasoning_tokens = 9` |
| **max** | `reasoning_tokens = 18` |
| `minimal` | **400** "not supported with this model" |
| 不传 | 服务端回显默认 `effort=medium` |

官方：`developers.openai.com/api/docs/models/gpt-5.6-sol`、`/guides/reasoning`。

注意 `minimal` 反而被拒——所以「档位越少越安全」的直觉在这一族不成立。

## 一段值得留着的历史：声明了不支持，于是永远发现不了它支持

此前 `openai-responses` 族错绑 no-op applier + `supportsEffort: false`，
注释写「当前不支持」，导致 `/effort` 对所有 GPT-5.x 硬报
「不支持推理强度档位切换」。

实为**未接线而非真不支持**：服务端对非法值返回 400 `param: reasoning.effort`，
证明字段被校验、能力存在。

这是「有代码 ≠ 有能力」的一种反面形态：**声明了不支持 → 永远不会去试 →
永远发现不了它其实支持**。与「乐观放行 + 400 自愈」正好相反——
后者会撞一次然后学到，前者永久沉默。

## `supportsThinkingToggle: false` 不影响 effort 下发

这两件事此前被混为一谈过。Responses 族与 Grok 同构：
推理内置不可关（无思考开关），但 effort **照发**、不受 thinking 门控。

`applyToSendParams` 因此不检查 `thinking` 参数。

## o-series 的另两条协议差异**不**由本方言处理

- system 消息须用 `developer` role
- 须用 `max_completion_tokens`（`max_tokens` 已废弃且不兼容）

这两条走 `openai.ts isReasoningModel` 与 `model-params-catalog` 的通用参数映射，
与「族方言」是两个关注点：它们是**请求骨架**的差异，不是**推理能力**的差异。
硬塞进 dialect 会让本层变成「所有 OpenAI 差异的杂物间」。

## 未知族（`unknownDialect`）为什么放在本文件

它不属于 OpenAI，但它的线格式**就是 OpenAI 兼容 Chat Completions 的最小子集**
——绝大多数第三方兼容端点（Kimi / Qwen / 各类自建网关）落在这里。

它的完整取舍说明写在代码注释里（那段是一次真实缺陷的修复记录，
值得在改代码的人眼前）：2026-08-01 前未知族没有任何分支接 `reasoningEffort`，
字段算出来却从不进 requestBody，连带让 400 自愈闭环
**在它唯一的目标人群上整链空转**。
