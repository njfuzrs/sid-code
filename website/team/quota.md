---
title: 配额与成本控制
description: 给会话、给团队设花费上限；四级预警、按周期的预算规则、超限自动停止。
---

# 配额与成本控制

一个 agent 跑长任务时会自己决定调多少次模型。没有上限，一次跑偏的任务
能烧掉你预期十倍的钱——而且你只会在月底账单上发现。

这页讲怎么把上限设上：从最简单的"这次会话最多花 1 块钱"，
到"按天限额、超了直接停、按模型分别限额"。

::: tip 先说一句
配额是**客户端护栏**，不是网关强制。它拦的是 sid-code 自己发起的请求，
用户改自己的 `settings.json` 就能放宽。真正不可绕过的额度控制要做在网关侧。
这页讲的是前者——它能挡住绝大多数"跑飞了没人管"的情况。
:::

## 快速上手

最简单的一条，命令行传：

```bash
sid-code -p "重构这个模块" --max-budget-usd 1.0
```

写进配置就是长期生效：

```json
{
  "quota": {
    "costLimit": 5
  }
}
```

超限时的真实输出（把上限设成 `0.0001` 复现）：

```text
⚠️  成本已超出配额（$0.0040 / $0.00），自动停止
```

::: warning 上限显示成 $0.00 不是 bug
告警文案对上限只保留两位小数（`src/llm/quota.ts:108-112` 的 `toFixed(2)`），
所以设了不到 1 分钱的上限会显示成 `$0.00`。**拦截本身是按真实值算的**，只是显示取整。
:::

"自动停止"的语义是：当前这一轮 agentic loop 就地终止（`src/query/loop.ts:1613-1617`
发一条 terminal 系统消息后 `return`），不是整个进程退出。交互模式下你还能继续对话——
但下一次请求算完成本又会撞上限。

## 四个可配字段

| 字段 | 单位 | 作用 | 接线状态 |
| --- | --- | --- | --- |
| `quota.costLimit` | USD | 会话累计花费上限，超了终止本轮 | ✅ 生效 |
| `quota.requestsPerMinute` | 次/分 | 每分钟请求数上限 | ⚠️ 见下文 |
| `quota.tokensPerMinute` | token/分 | 每分钟 token 上限 | ⚠️ 见下文 |
| `quota.budgetRules[]` | — | 按周期/按模型的多维预算规则 | ✅ 生效 |

### costLimit 与 --max-budget-usd 的关系

这里有个**必须知道的覆盖关系**：

```ts
// src/app.ts:480
const effectiveCostLimit = quotaConfig?.costLimit ?? opts.config.costLimit;
```

`quota.costLimit` 用 `??` 兜住了 `costLimit`（也就是 `--max-budget-usd` 落到的字段）。
意思是：**只要配置里有 `quota.costLimit`，命令行的 `--max-budget-usd` 就静默失效。**

如果你的团队默认配置带了 `quota: { "costLimit": 100 }`（[模板里就有](/team/defaults#快速上手)），
那么全团队的 `--max-budget-usd` 默认都不起作用。想让命令行参数生效，得先把
配置里的 `quota.costLimit` 删掉。

统计口径值得点一句：配额检查用的是 `getEffectiveTotalCostUSD()`
（`src/query/loop.ts:1612`），**包含标题生成 / 记忆抽取 / 摘要这些影子调用**的花费。
不然辅助调用烧钱就不受限了。

### 四级预警

`costLimit` 不是只在 100% 才吭声，有四档（`src/llm/quota.ts:85-93`）：

| 比例 | 级别 | 行为 |
| --- | --- | --- |
| ≥ 50% | `info` | 提示 |
| ≥ 80% | `warning` | 黄色告警"请注意控制用量" |
| ≥ 95% | `critical` | 黄色告警"即将超限！" |
| ≥ 100% | `exceeded` | **终止本轮** |

**只在级别升级时告警一次**（`quota.ts:97-102`），不会每轮重复刷同一档。
`/clear` 会重置告警级别（`src/app.ts:1613`），所以清空上下文后又会从 info 档开始提醒。

### RPM / TPM 的实际状态

`requestsPerMinute` 和 `tokensPerMinute` 会被读进 `QuotaManager`，
滑动窗口也在正常记账（`recordRequest` 每轮都调，`src/query/loop.ts:1577-1581`）。

**但计算等待时长的 `checkRateLimit()` 目前没有任何生产调用方**——
全仓 grep 只有它自己的定义和单测（`tests/llm/quota.test.ts`）。
也就是说：这两个字段配上去不报错、窗口在转，但**不会真的限速**。

如实说这一点，因为「以为限了、其实没限」比「知道没限」危险得多。
需要硬限速的话，现在得做在网关侧。

## 按周期的预算规则

`budgetRules` 比 `costLimit` 多三个维度：周期、模型范围、超限动作。

```json
{
  "quota": {
    "budgetRules": [
      {
        "id": "daily-total",
        "name": "每日总预算",
        "period": "daily",
        "limit_usd": 10,
        "action": "block"
      },
      {
        "id": "expensive-model",
        "name": "贵模型单独限额",
        "period": "daily",
        "limit_usd": 3,
        "scope": { "model": "claude-sonnet-5" },
        "thresholds": { "warning": 0.6, "critical": 0.9, "exceeded": 1.0 },
        "action": "alert"
      }
    ]
  }
}
```

字段语义：

| 字段 | 取值 | 说明 |
| --- | --- | --- |
| `id` | 字符串 | 必填、团队内唯一（重复会告警） |
| `name` | 字符串 | 必填，告警文案里显示的就是它 |
| `period` | `session` / `hourly` / `daily` / `weekly` / `monthly` | 周期 |
| `limit_usd` | 正数 | 该周期的上限 |
| `scope.model` | 模型名 | 只统计这个模型的花费；省略则全局 |
| `thresholds` | 0–1 小数 | 默认 `warning:0.5` / `critical:0.8` / `exceeded:1.0` |
| `action` | `alert` / `downgrade` / `block` | 超限动作，默认 `alert` |

超限行为实测（`period: session` + `limit_usd: 0.0001` + `action: block`）：

```text
⚠️  预算规则 "测试预算" 已超限（$0.0055 / $0.00），自动停止
```

::: warning action 三档里只有两档真的不一样
`block` 会终止本轮（`src/query/loop.ts:1588-1596`）。
`alert` 只发告警。而 **`downgrade` 目前的实际行为等同于 `alert`**——
主循环只判 `action === "block"`，没有"降级到便宜模型"的实现分支。
想按预算自动降级，现在的可行替代是配 [`subAgentModels` 分级](/extend/subagents)
把子代理压到便宜档。
:::

### 周期是进程内的，重启即清零

计数存在内存 Map 里（`src/telemetry/metrics/budget-tracker.ts:54`），
周期 key 由当前时间算出（`daily` = `2026-07-27` 这样的字符串）。**没有持久化**。

推论很重要：`period: "daily"` 的语义是**"本进程内、今天这个日期键下的累计"**，
不是"这台机器今天一共花了多少"。重启 sid-code 就归零，多个并行会话各算各的。
真正的跨会话日额度统计要靠[轨迹数据](/team/observability)在事后聚合，
或者做在网关侧。

## 配置校验会帮你抓错

配错的预算规则不会静默失效——启动时会逐条报出来。实测一份故意写错的配置：

```json
{
  "id": "daily",
  "name": "重复 id",
  "period": "yearly",
  "limit_usd": 0,
  "action": "stop",
  "scope": { "model": "不存在的模型" }
}
```

启动输出：

```text
⚠ quota.budgetRules[1].id: 与其它规则重复 ("daily")
⚠ quota.budgetRules[1].period: 无效值 "yearly"，有效值为 session/hourly/daily/weekly/monthly
⚠ quota.budgetRules[1].limit_usd: 必须是正数，否则该预算规则无意义
⚠ quota.budgetRules[1].action: 无效值 "stop"，有效值为 alert/downgrade/block
⚠ quota.budgetRules[1].scope.model: 模型 "不存在的模型" 未在 availableModels 中找到，
  此预算规则永远不会命中用量匹配，等同于已失效。如果重命名过 availableModels 条目，
  请同步更新这里的引用
```

最后那条尤其值得留意：`scope.model` 是**字符串精确匹配**用量事件的模型名
（`budget-tracker.ts:162`）。改过 `availableModels` 里的模型名而忘了同步这里，
预算规则就永久静默失效——你以为设了限额，其实从来没生效过。校验器专门为这个场景加了检查
（`src/config/schema.ts:497-500` 的注释把它定性为"财务/安全相关的真实风险"）。

注意这些都是**警告不是错误**，启动照常继续。所以团队推配置时值得跑一次
`sid-code -p "ok"` 看有没有 `⚠ quota.` 开头的行。

## 常见问题

### 团队怎么统一设上限

放进[团队默认配置](/team/defaults)的 `quota` 段。但记住这是**默认值不是强制值**——
用户改自己的 `~/.sid-code/settings.json` 就能改掉。

配置来源里 `quota` 是嵌套对象，合并时递归展开，`budgetRules` 作为对象数组是
**拼接**语义（`src/config/settings/merge.ts:25`）——用户加自己的规则不会覆盖团队的规则，
两边的规则同时生效。这对配额来说方向是对的：多一条规则只会更严不会更松。

### 想知道现在花了多少

会话里打 `/cost`，或者看任务结束的自动摘要。口径与调优手段见
[成本与用量](/use/cost)。

### 配额和上下文自动压缩会互相影响吗

会，方向是好的：自动压缩降低每轮输入量，直接降低花费。反过来配额超限终止时
不会触发压缩。两者互不干扰，见[上下文管理](/use/context)。

### 上限设多少合适

先跑几个真实任务看 `/cost`，用实测值定。参考量级：一个"改一个函数 + 跑测试"的
小任务大约 $0.05（[实测数据](/use/cost)），跑到 $5 的会话通常意味着任务规模被低估
或者陷进了重复循环——把 `costLimit` 设在"正常任务的 10 倍"是个合理起点，
它拦的是异常不是日常。

## 相关

- [成本与用量](/use/cost) —— 单会话怎么看花了多少、怎么降下来
- [团队默认配置分发](/team/defaults) —— 把 `quota` 段发给全团队
- [轨迹采集与可观测](/team/observability) —— 跨会话聚合花费的正确做法
- [子代理](/extend/subagents) —— 按类型分级用便宜模型，从源头省钱
- [settings.json 字段参考](/ref/settings) —— `quota` 全部字段
