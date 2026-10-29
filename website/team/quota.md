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
本地配额是**客户端护栏**：它拦的是 sid-code 自己发起的请求，
用户改自己的 `settings.json` 就能放宽，计数也只在本进程内。它能挡住绝大多数"跑飞了没人管"的情况。
跨会话、按团队 / 组织汇总的额度见下文[远程预算](#远程预算-团队-组织级)。
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
⚠️  成本已超出配额（$0.0040 / $0.0001），自动停止
```

上限和当前花费一样显示到小数点后 4 位，所以不到 1 分钱的上限也能看清。

"自动停止"的语义是：当前这一轮 agentic loop 就地终止（`packages/core/src/query/loop.ts`
发一条 terminal 系统消息后 `return`），不是整个进程退出。

超限之后**每一轮都拦**，不是只拦一次。硬停判定（`isExceeded()`）和告警去重（`check()`）是两个判据，
继续发消息时主循环在**发请求之前**就停下，不会先烧一次调用再停，提示变成：

```text
⚠️  本会话已超出成本配额（$0.0040 / $0.0001），仍拦截。调高 costLimit 或 /clear 开新会话后再继续
```

`budgetRules` 的 `block` 同理。

## 四个可配字段

| 字段 | 单位 | 作用 | 接线状态 |
| --- | --- | --- | --- |
| `quota.costLimit` | USD | 会话累计花费上限，超了终止本轮 | ✅ 生效 |
| `quota.requestsPerMinute` | 次/分 | 每分钟请求数上限，超了本地等待 | ✅ 生效 |
| `quota.tokensPerMinute` | token/分 | 每分钟 token 上限，超了本地等待 | ✅ 生效 |
| `quota.budgetRules[]` | — | 按周期/按模型的多维预算规则 | ✅ 生效 |

### costLimit 与 --max-budget-usd 的关系

两者都在时**取更严的那个**，不比优先级：

```ts
// packages/core/src/llm/quota.ts
export function resolveEffectiveCostLimit(quotaCostLimit, topLevelCostLimit): number
// 两侧正数取 min；0 / 未设 = 这一侧不限，不参与比较
```

所以团队默认配置带了 `quota: { "costLimit": 100 }`（[模板里就有](/team/defaults#仓库里的模板长什么样)），
成员传 `--max-budget-usd 0.5` 仍按 0.5 拦；反过来，成员**没法**用命令行参数把团队上限放宽。
交互模式与 `-p` 走的是同一个值。

统计口径值得点一句：`costLimit` 检查用的是 `getEffectiveTotalCostUSD()`
（`packages/core/src/query/loop.ts`），**包含标题生成 / 记忆抽取 / 摘要这些影子调用**的花费。
不然辅助调用烧钱就不受限了。下文的 `budgetRules` 用的是同一个口径。

### 四级预警

`costLimit` 不是只在 100% 才吭声，有四档（`packages/core/src/llm/quota.ts` 的 `check()`）：

| 比例 | 级别 | 行为 |
| --- | --- | --- |
| ≥ 50% | `info` | 只计入级别，**不显示**（主循环只显示 warning / critical） |
| ≥ 80% | `warning` | 黄色告警"请注意控制用量" |
| ≥ 95% | `critical` | 黄色告警"即将超限！" |
| ≥ 100% | `exceeded` | **终止本轮** |

**只在级别升级时告警一次**（同一函数里的 `lastAlertLevel` 判断），不会每轮重复刷同一档。
去重只管告警文案，不管拦不拦：`exceeded` 之后每轮都拦。
`/clear` 开新会话，会话花费归零，`costLimit` 和 `budgetRules` 的告警级别一起重置
（`packages/cli/src/app.ts`），`period: "session"` 规则的累计也清零。

### RPM / TPM 的实际状态

RPM = Requests Per Minute（每分钟请求数），TPM = Tokens Per Minute（每分钟 token 数）。
这两个字段分别对应 `quota.requestsPerMinute` 和 `quota.tokensPerMinute`。

**已接线**：超过 RPM / TPM 上限时，主循环在发下一轮请求前本地主动等待，
等窗口滑过再继续（`packages/core/src/query/loop.ts` 的 `checkRateLimit()`）。
等待期间按 `Esc` 可中断——不会卡住会话。

## 按周期的预算规则

`budgetRules` 比 `costLimit` 多三个维度：周期、模型范围、超限动作。

```jsonc
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
        "scope": { "model": "claude-sonnet-5" },   // 换成你 availableModels 里的名字
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
| `thresholds` | 0–1 小数 | 默认 `warning:0.5` / `critical:0.8` / `exceeded:1.0`。warning / critical 都会显示，比 `costLimit` 少一个 info 档 |
| `action` | `alert` / `downgrade` / `block` | 超限动作，默认 `alert` |

超限行为实测（`period: session` + `limit_usd: 0.0001` + `action: block`）：

```text
⚠️  预算规则 "测试预算" 已超限（$0.0055 / $0.0001），自动停止
```

::: warning action 三档里只有两档真的不一样
`block` 会终止本轮（`packages/core/src/query/loop.ts`）。
`alert` 只发告警。而 **`downgrade` 目前的实际行为等同于 `alert`**——
主循环只判 `action === "block"`，没有"降级到便宜模型"的实现分支。
配了 `downgrade` 启动时会有一条提示点名这件事（见下文[配置校验](#配置校验会帮你抓错)）。
想按预算自动降级，现在的可行替代是配 [`subAgentModels` 分级](/extend/subagents)
把子代理压到便宜档。
:::

### 周期是进程内的，重启即清零

计数存在内存 Map 里（`packages/core/src/telemetry/metrics/budget-tracker.ts`），
周期 key 由当前**本地时间**算出（`daily` = `2026-07-27`，`weekly` = `2026-W31`）。**没有持久化**。

推论很重要：`period: "daily"` 的语义是**"本进程内、今天这个日期键下的累计"**，
不是"这台机器今天一共花了多少"。重启 sid-code 就归零，多个并行会话各算各的。
`period: "session"` 的累计在 `/clear` 后清零（`/clear` 是开新会话）；`--resume` 恢复的会话接着算。

还有三点值得知道：

- **周期按本地时区划分**。`daily` 在本地零点翻天；`weekly` 是 ISO 周，从周一 00:00 开始。
- **含辅助调用**。和 `costLimit` 同口径（`getEffectiveTotalCostUSD()`），标题生成、记忆抽取、摘要的花费都计入，
  两者设成同一个数时同一轮触发。
- **`scope.model` 只计该模型的主调用**。辅助调用的花费拆不出是哪个模型的，只计入不限模型的规则。

跨会话的额度用下一节的远程预算；事后复盘花费用[轨迹数据](/team/observability)聚合。

## 远程预算（团队 / 组织级）

客户端已实现远程预算（`packages/core/src/telemetry/remote-budget.ts`）：额度由企业后端下发、
用量由服务端跨会话汇总，本地改 `settings.json` 放不宽它。

- **取址**：配了 `backend.url` 并[登录](/team/login)（`sid-code auth login` 或 TUI 里 `/login`）后自动生效，地址是
  `GET <backend.url>/api/v1/ctl/budget`，不需要单独配。旧的 `SID_CODE_BUDGET_ENDPOINT`
  已弃用，只在没配 `backend.url` 时生效。
- **何时拉取**：启动时拉一次；之后每次本会话用量上报到账本成功，最多每 30 秒刷新一次。
- **用量口径**：服务端返回 `used_usd`（按周期汇总的已用额），客户端加上本会话尚未计入的部分做估计，
  已上报过的本会话花费不重复计。
- **两档动作**：`alert` 只告警；`block` 终止本轮，与本地 `costLimit` 超限同一种停法。
- **与本地配额的关系**：两条都查，先到先停，数字不合并。
- **fail-open**：没登录、401 / 5xx / 超时、明文非本地地址，一律当没配远程预算，本地 `costLimit` 照常生效。

服务端额度怎么设、按什么维度汇总（组织 / 团队 / 设备三层、四种周期），见企业后端的[预算](/backend/budget)页。

## 配置校验会帮你抓错

配错的预算规则不会静默失效——启动时会逐条报出来。实测一份故意写错的配置
（第一条合法、只把 `action` 写成 `downgrade`，第二条故意写错并复用第一条的 `id`）：

```json
{
  "quota": {
    "budgetRules": [
      { "id": "daily", "name": "ok", "period": "daily", "limit_usd": 1, "action": "downgrade" },
      {
        "id": "daily",
        "name": "重复 id",
        "period": "yearly",
        "limit_usd": 0,
        "action": "stop",
        "scope": { "model": "不存在的模型" }
      }
    ]
  }
}
```

`sid-code -p "ok"` 的 stderr 输出（节选 `quota` 相关行）：

```text
配置检查发现 13 项提示（不影响本次启动，可能导致部分功能未按预期工作）:
  ⚠ [提示] quota.budgetRules[0].action: "downgrade" 当前未实现，行为等同 alert（超限只告警，不切换模型）
  ⚠ [提示] quota.budgetRules[1].id: 与其它规则重复 ("daily")
  ⚠ [提示] quota.budgetRules[1].period: 无效值 "yearly"，有效值为 session/hourly/daily/weekly/monthly
  ⚠ [提示] quota.budgetRules[1].limit_usd: 必须是正数，否则该预算规则无意义
  ⚠ [提示] quota.budgetRules[1].action: 无效值 "stop"，有效值为 alert/downgrade/block
  ⚠ [提示] quota.budgetRules[1].scope.model: 模型 "不存在的模型" 未在 availableModels 中找到，此预算规则永远不会命中用量匹配，等同于已失效。如果重命名过 availableModels 条目，请同步更新这里的引用
  ⚠ [提示] <settings.json 路径>#quota.budgetRules.1.period: Invalid enum value. Expected 'session' | 'hourly' | 'daily' | 'weekly' | 'monthly', received 'yearly'（该值已忽略，其余配置照常生效）
  …
```

同一个错误会报两遍：一遍是上面的中文语义校验，一遍是 schema 校验（带文件路径和"该值已忽略"后缀）。
后者说明非法字段会被直接摘掉，这条规则缺了必填字段，等于没配。
TUI 模式下这些提示显示在启动横幅里，格式是 `quota.budgetRules[1].id: …`，没有 `[提示]` 前缀。

`scope.model` 那条尤其值得留意：`scope.model` 是**字符串精确匹配**用量事件的模型名
（`budget-tracker.ts`）。改过 `availableModels` 里的模型名而忘了同步这里，
预算规则就永久静默失效——你以为设了限额，其实从来没生效过。校验器专门为这个场景加了检查
（`packages/core/src/config/schema.ts` 的注释把它定性为"财务/安全相关的真实风险"）。
这个检查**只在配了 `availableModels` 时才做**；没配 `availableModels` 时写错模型名不会有任何提示。

注意这些都是**警告不是错误**，启动照常继续。所以团队推配置时值得跑一次
`sid-code -p "ok" 2>&1 | grep 'quota\.'`，看有没有 `quota.` 相关的提示行。

## 常见问题

### 团队怎么统一设上限

放进[团队默认配置](/team/defaults)的 `quota` 段。但记住这是**默认值不是强制值**——
用户改自己的 `~/.sid-code/settings.json` 就能改掉。要用户改不掉的跨会话额度，用[远程预算](#远程预算-团队-组织级)。

团队默认配置不是一个独立的配置来源：它在安装或升级时被写进用户自己的 `~/.sid-code/settings.json`，
而且**只补用户缺失的顶层键**（`packages/core/src/migrations/backfill-team-defaults.ts`）。
用户已经有 `quota` 段（哪怕是 `{}`）时，团队的 `quota` 整段不会补进去，更不会和用户的规则合并。

拼接发生在多个配置来源之间（用户级 / 项目级 / 本地级 settings）：`quota` 是嵌套对象，合并时递归展开，
`budgetRules` 作为对象数组是**拼接**语义（`packages/core/src/config/settings/merge.ts`），
所以项目级 `.sid-code/settings.json` 里的规则会和用户级的规则同时生效。
想让团队规则不被个人配置挤掉，可以把它放进仓库的项目级配置。

### 想知道现在花了多少

会话里打 `/cost`，或者看退出时自动打印的摘要。口径与调优手段见
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
