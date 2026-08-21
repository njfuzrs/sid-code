---
Status: rejected
Date: 2026-08-20
---
# 不做 `finish_reason=length` 的 prefix 续写（方案 PR15 / P0-7 二级）

## 决定了什么

方案 `20260817-GLM-5.3思考阶段卡死-300s硬顶掐断丢弃已累积内容-修复方案.md`
的 **PR15（可选，P2）** 不实现。方案原文：

> 照搬 Reasonix `openai.go:518`：`finish_reason == "length"` 时把已累积 text + reasoning
> 作为 prefix 续发，**上限 1 次**。DeepSeek Beta 的 prefix 续写我们已有对接面（`llm/dialect/`）。

同批的 PR11 / PR12 / PR13 / PR14 已实现，见
`.agents/notes/implemented/bug-fix/2026-08-20-超时埋点归一与per-model覆盖替代全局抬阈值.md`。

## 放弃了什么（以及为什么不选）

三条前提逐条核验，**全部不成立**。这条是关键：它不是"收益不够大"，
而是"方案描述的现状与仓库实际不符"，所以照做会做出一个解决不存在问题的功能。

### ① 「我们已有 prefix 对接面（`llm/dialect/`）」—— 不存在

`packages/core/src/llm/dialect/` 下 8 个 TS 文件里 `prefix` 一共出现 2 次，
都在 `tool-schema.md` 里说 JSON Schema 的 `prefixItems`，与 prefix completion 无关。
`packages/core/src/llm/` 全目录也没有任何 `"prefix": true` / prefix continuation 的实现。

所以这不是"复用已有对接面"，而是**从零新建**一条 DeepSeek Beta 专用请求路径
（换 `base_url` 到 `/beta`、造 assistant prefix 消息、处理它与 tool_calls 的交互）。
工作量与风险都比方案描述的高一个量级，而方案是按"照搬 + 复用"定的 P2 优先级。

### ② 「`finish_reason=length` 是个待解决的问题」—— 本机零发生

50 个会话轨迹复算：

```
stop_reason 分布（n=780）: {'tool_use': 727, 'end_turn': 53}
max_tokens / length: 0
max_tokens_escalate / max_tokens_continuation transition: 零命中
```

**一次都没有。** 给一个零发生的场景加一条计费的新请求路径，
拿到的是一条永远不被执行、也永远不会被发现写错了的分支 ——
本仓已记过这类教训（`policyLimits` 生产调用点为 0、`recordMetric` 三处零命中），
而这次是主动去造一个。

### ③ 「已累积内容被丢弃」—— 这个洞已经被堵上了，且堵法更好

`query/loop.ts:4467` 起已有完整的 max_tokens 恢复链，**比 prefix 续写更完备**：

- **Stage 1**：查注册表 `maxOutputTokens`，把 `maxTokens` 上限抬上去重试一次
  （治因，prefix 续写治不了）；
- **Stage 2**：注入 `<system-reminder>` 截断通知让模型自己从断点续写
  （已累积内容**留在历史里**，不是丢弃后重来）；
- **Stage 3**：递减收益检测 + 让手提示，防无限续写烧 token。

Stage 2 已经实现了方案说 prefix 续写才有的那个性质 ——「真的保留内容」。
差别只是"由模型读着历史续"而不是"由 API 从字面 prefix 续"，
而后者要付出 `/beta` 端点 + 与 tool_calls 交互的复杂度。

### ④ 顺带纠一处：PR15 挂在 P0-7 之下，但它解决的不是本文档的主问题

本文档标题的问题是**超时切断**时丢弃已累积的 thinking，
`finish_reason=length` 是**输出达上限**，两者根本不同：
- 超时切断：连接被杀，已产出内容在 harness 手里，能不能保住是我们的决定；
- length：模型正常返回、`stop_reason` 完整，是配额问题。

把它们并列成"P0-7 的一级/二级"会让人以为做了二级就更好地解决了主问题。
主问题的对策是 PR6（重试决策上抛已产出内容，已在 #80 合入）+ PR1/PR2 改谓词。

## 拿什么证明它生效了

本条是"决定不做"，所以要证的是**不做的依据是事实而非印象**。跑过的复算：

- `grep -rn "prefix" packages/core/src/llm/dialect/` → 2 处命中，均为 `prefixItems`（JSON Schema）
- `grep -rln "prefix" packages/core/src/llm/` → 4 个文件，无一是 prefix completion
  （`error-messages.ts` / `model-registry.ts` / `hooks/secret-redact.ts` / `dialect/tool-schema.md`）
- 轨迹复算 `~/.sid-code/trajectories/sessions`（50 个含 events.jsonl 的会话）：
  `stop_reason` 只有 `tool_use` 727 / `end_turn` 53，`max_tokens` 与 `length` **各 0**；
  `max_tokens_escalate` / `max_tokens_continuation` transition 零命中
- `packages/core/src/query/loop.ts:4467-4600` 通读：三段式恢复链已在生产路径上

**这份证据的弱点（诚实标注）**：分母只有本机 50 个会话、且用户主要用 GLM/DeepSeek 系
长思考模型。`max_tokens` 零发生**很可能是这批模型 + 当前 maxTokens 配置的结果**，
不能推广成"所有用户都不会遇到"。

## 什么条件下该重新捡起来

不是永久否决。三条里任意一条翻转就值得重开：

1. **轨迹里开始出现 `stop_reason=max_tokens`**（跑 `bun scripts/telemetry-trigger-rate.ts`
   或直接 grep raw.jsonl）—— 那时 ② 不再成立，说明现有三段式链条不够用；
2. **现有恢复链被实测证明不够**：具体形态是 Stage 2 续写后模型重头再来 / 跳过内容
   （那正是 prefix 续写比"读历史续"强的地方）；
3. **因别的需求已经建好了 DeepSeek `/beta` 通道** —— 那时 ① 才真的成立，成本降到方案假设的量级。

重开时**必须先开 issue**（方案 §0.0.4 已把 PR15 列入"必须先开 issue"），
且第一步应当是补 `stop_reason` 的分布复算，而不是直接写代码。
