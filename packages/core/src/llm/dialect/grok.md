# Grok（xAI）方言 · 出处

> `grok.ts` 写结论，本文写依据。`grok-api.md` 在维护者私有文档库，行号仅作溯源线索。

## 无显式思考开关

依据 `grok-api.md:30,157,277`。Grok 推理模型是**配置化推理**——推理内置、不可通过
请求字段开关。故：

- `flags.supportsThinkingToggle: false`
- `wire.thinkingToggle: "none"`
- `applyToSendParams` **刻意不写** `params.thinking`

最后一条是重点：给一个不认 `thinking` 结构的族下发该字段是白撞 400，
而且无法从错误文本反推正确结构（自愈救不回来）。

## `reasoning_effort`：none/low/medium/high，**无 max**

依据 `grok-api.md:30`。`max` 与 `xhigh` 均钳到 `high`。

`grok-4.3` 的默认档位是 `low`（`grok-api.md:277`）——比多数族的 `medium` 低一档，
故 `defaultEffort: "low"`，状态栏 auto 态显示 low 才与实际一致。

## effort 不受思考门控（与 DeepSeek/GLM 相反）

因为没有思考开关可言，`/think off` 之后 effort 照发。
`wire.effortGatedByThinking: false`。

这个差异对用户是**可见的**：在 GLM 上关掉思考后 `/effort` 面板在空转
（切档但没有任何档位真的发出去），在 Grok 上不会。
`effort.ts isEffortGatedByThinking` 靠跑一次真实映射探测，不读本字段——
保持「探测实际行为」而非「读声明」，两者不一致时以实现为准。

## `max_completion_tokens`

Grok 推理模型在注册表里声明 `maxTokensField: "max_completion_tokens"`。
这条不由本方言处理——它走 `model-params-catalog` 的通用参数映射
（`applyModelParamsFromCatalog`），与族无关。
