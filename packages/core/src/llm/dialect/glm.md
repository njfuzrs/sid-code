# GLM（智谱）方言 · 出处与实测记录

> 随行文档：`glm.ts` 写结论，本文写依据。
> `glm-api.md` 在维护者私有文档库，不在本仓；行号仅作溯源线索。

## 思考开关：GLM-4.5+ 起支持，与 DeepSeek 同构

顶层 `thinking:{type:"enabled"|"disabled"}`，依据 `glm-api.md:144-147`。

## `reasoning_effort`：只有 GLM-5.2 真生效

依据 `glm-api.md:189-201`。非 5.2 的 GLM 会**忽略**该字段而不是报错，
故 `flags.supportsEffort` 统一声明为 `true`——按模型小版本再分一档的收益
（省一个被忽略的字段）远小于代价（又一条按模型名硬编码的分档规则）。

`max` 档同样仅 GLM-5.2 生效（`glm-api.md:189`）。

线格式认 `low/medium/high/max`，**不认 `xhigh`** → 客户端钳到 `max`（GLM 支持的最高档）。

## `tool_choice`：默认且仅支持 `auto`

依据 `glm-api.md:147,276,431`。`required` / `none` / 指定函数都会被拒绝。

处置是**降级为不下发**（等价服务端默认 auto）而不是冒 400，
故 `toolChoice: "auto-only"`。与 DeepSeek 的 `reject-when-thinking` 区别在于
GLM 仍允许显式 `auto` 通过。

用户可用 `compat.toolChoiceAutoOnly: false` 跳过本降级——GLM-5.2+ 若已放开，
或网关代为转换时用得上。

## 与 DeepSeek 为何不共用一份描述符

`wire` 的五个字段目前逐字段相同，但两族**已经**在两处不同：

| | DeepSeek | GLM |
| --- | --- | --- |
| effort 值域 | 只认 high/max | 认 low/medium/high/max |
| tool_choice | 思考时拒绝 | 仅认 auto |

原实现合成 `if (isDeepSeek || isGLM)` 只在 thinking 那一段成立，
读代码的人会以为两族全等，然后在 `applyToolChoice` 里被 GLM 的独立分支打脸。

## 400 错误文本形态（供 `model-capabilities.ts` 自愈解析）

GLM 的非法档位报错会自报合法值域，是自愈能学到真值的来源：

```
reasoning_effort 参数值非法，可选值为：none、minimal、low、medium、high、xhigh、max
```

注意它**中文**且用顿号分隔，与 DeepSeek/Qwen 的英文 `must be one of: 'low', ...`
形态不同——解析器两种都要认（见 `model-capabilities.ts` 的档位提取）。
