# Anthropic 原生 Claude 方言 · 出处

> `anthropic.ts` 写结论，本文写依据。`anthropic-api.md` 在维护者私有文档库，
> 行号仅作溯源线索。

## 两条协议路径，判据是注册表的 `thinkingMode`

依据 `anthropic-api.md:316-323,325-332`。

| `thinkingMode` | 模型 | 线格式 | 强度载体 |
| --- | --- | --- | --- |
| `adaptive` | Opus 4.7+ / Sonnet 4.6 | `thinking:{type:"adaptive"}` + `output_config.effort` | 档位字符串，预算服务端定 |
| `always-on` | Fable 5 / Mythos 5 | 同 adaptive，但**不可关闭思考** | 同上 |
| `undefined`（manual） | 旧模型（Opus 4-20250514 / Sonnet 4.5 / Haiku 4.5） | `thinking:{type:"enabled", budget_tokens:N}` | **数值预算** |

`always-on` 模型关思考也按低 effort 下发——显式关闭会 400。

## 档位 → 预算映射

| 档位 | budget_tokens |
| --- | --- |
| low | 2,000 |
| medium | 10,000 |
| high | 20,000 |
| xhigh | 32,000 |
| max | 50,000 |

沿用既有预算思路（simple 2K / medium 10K / complex 50K），补 high/xhigh 两档使 5 档
与预算一一对应。

adaptive 线格式官方档位是 `low/medium/high/max`，**不含 xhigh** → xhigh 钳到 max。

## 思考 token 上限的钳制方式随协议不同（本族最需要「算法」的一处）

| 协议 | 能否精确钳制 | 做法 |
| --- | --- | --- |
| manual | ✅ 能 | `Math.min(档位预算, 上限)`，直接写 `budget_tokens` |
| adaptive | ❌ 不能 | 预算由服务端定，客户端没有字段可写 → **反查档位间接压低** |

adaptive 的反查阈值（`mapThinkingCapToEffort`）：`<5K→low`、`<15K→medium`、`<32K→high`，
`≥32K` 不降档（已接近/超过 xhigh 预算，再降是无谓削弱）。

⚠ 两个方向共用 `ANTHROPIC_EFFORT_BUDGET` 这张表，**必须同步改**——
改一处就是「正向映射与反向钳制对不上」。

降档生效时在 `params.thinkingBudgetCapped` 打标记（`mode: "adaptive" | "manual"`），
供 UI/日志诚实告知用户「你要的档位被上限压低了」。只降不升。

## 为什么本族必须用函数钩子而不是描述符

其余六族的差异都能用 `WireDialect` 的五个字段枚举完，本族三条都不能枚举：

1. 强度是**数值**而非档位字符串
2. 新旧模型走**两条不同协议**
3. 上限钳制方式**随协议不同**（一个 `Math.min`，一个反查降档）

这正是 PR-2 的 compat 布尔位层刻意留下的边界。那层的注释写明：
对 adaptive 模型声明 `supportsReasoningEffort: false` 是**矛盾配置**
（`effort` 在该类型里是必填），要支持这种组合需 dialect 层做结构转换。

## `output_config.effort` 是两族共用字段

adaptive 原生 Claude 与 DeepSeek-via-Anthropic 端点**都**走这个字段
（见 `anthropic.ts:262`）。区别是前者带 `thinkingType: "adaptive"`、后者不带——
`buildThinkingParam` 靠这个标记决定下发 `{type:"adaptive"}` 还是 `{type:"enabled"}`。

丢掉整个 `outputConfig` 会让它从 adaptive **静默退回** manual `budget_tokens`，
即用一个协议降级去实现另一个字段的关闭。PR-2 因此刻意不在
`supportsReasoningEffort: false` 时清空带 `thinkingType` 的 `outputConfig`。
