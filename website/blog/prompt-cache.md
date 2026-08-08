---
title: Prompt Cache：一个读错的字段名，把 95% 的命中率记成 2.2%
description: 一个模型的命中率记成 2.2%，判据看着很硬——同代码路径的对照组命中、它 67/67 次恒零，于是结论写成"网关后端不支持"。这个结论错了：判据方法对，但认错了代码路径，真实命中率是 95.2%。这篇从协议约束推到唯一解，用受控实测拿到三族 95%+ 的稳态基线，再交出五个把自己骗过去的度量事故。
date: "2026-08-08"
series: 上下文工程
audience: engineer
highlight: 受控稳态 96.3%/98.7% · 修复整族 11 个模型的漏采 · 账本下界 66.9%
tags: [prompt cache, 成本优化, 机制解析, 实测]
---

# Prompt Cache：一个读错的字段名，把 95% 的命中率记成 2.2%

同一套缓存策略，在 Anthropic 协议和 OpenAI 协议上必须写成两种形状。
而 OpenAI 自己的 Responses API 是**第三种** —— 命中数放在另一个键里，
读错键的代价是把 95% 的真实命中记成 2.2%，然后把这个数字当成"后端能力边界"写进文档。

这篇先给受控实测的结论，再讲机制怎么推出来的，然后交出五个度量事故
（每一个都以"测试全绿"为掩护），最后是没做到的部分。

::: tip 结论先放这里
- **受控实测稳态命中率**（固定前缀 + 尾部追加，排除冷启动首轮）：
  Anthropic 98.7%、OpenAI Chat 96.3%、OpenAI Responses 55.5% 且第 6 轮已达 94.0%。
- **账本下界 66.9%**（350 会话 / 4.78 亿输入 token）。它与受控数字的差距**不在协议实现**，
  在真实会话里前缀被反复打断。
- `gpt-5.6-luna` 的 2.2% **是漏采，不是后端不支持** —— 上一版这篇文章的结论是错的。
  受影响的是整个 `openai-responses` 协议族 **11 个模型**，不是两个。
- 一个月卡网关**在编造 usage**：全新前缀首发就报命中、不打断点也报命中、
  同前缀连发 5 次三段随机跳动而总和恒定。它污染过这篇文章此前的 anthropic 族数字。
- 缓存中断里 99.5% 是"本地前缀 hash 未变而命中掉了"，本地不可控。
  这个统计此前只能靠 grep 中文文案 —— hash 字段在落盘时被手写拷贝列表丢掉了。
:::

## 一、成果

### 1.1 受控实测：三族都能到 95%+

先说为什么需要"受控实测"这个东西。账本里的跨会话命中率混了太多变量
（模型、渠道、会话长短、`/compact` 次数），拿它当"缓存实现好不好"的证据不成立；
而单次 curl 又太理想，没有真实会话的前缀扰动。

所以做了个中间物（`scripts/cache-bench.ts`）：**固定静态前缀 + 每轮只在尾部追加**，
跑 N 轮出逐轮曲线。这是本文所有"能到多少"的唯一来源。

| 渠道 / 模型 | 协议线 | r1 | 稳态（排除 r1） | 全轮 |
| --- | --- | --- | --- | --- |
| uniapi / claude-sonnet-5 | Anthropic | 99.5%※ | **98.7%** | 99.0% |
| uniapi / glm-5.2 | Chat Completions | 0.0% | **96.3%** | 80.5% |
| uniapi / gpt-5.6-luna | Responses | 0.0% | **55.5%**（r6 已 94.0%） | 46.4% |

※ r1 就 99.5% 不是渠道造数：这是同一前缀的**第二次**运行，上次已把它写进服务端缓存。

glm-5.2 的曲线是教科书形态：

```text
r1  in=2366  hit=0     0.0%   ← 冷启动，服务端从未见过该前缀
r2  in=2384  hit=2304  96.6%  ← 立刻满命中
r3  in=2402  hit=2304  95.9%
r4  in=2420  hit=2304  95.2%  ← 命中值恒定而分母每轮 +18，百分比缓慢下滑
r5  in=2438  hit=2304  94.5%
r6  in=2456  hit=2432  99.0%  ← 服务端把缓存前缀往后扩了一段
```

**为什么必须分"稳态"和"全轮"两个口径**：r1 必然 0 命中，轮数越少它对均值的拖累越大 ——
6 轮里 r1 占 1/6，能把一个 96% 的实现记成 80.5%。账本 66.9% 与受控 96%+ 的差距里，
有一部分就是这种口径差而非实现差。

### 1.2 luna：从"记成 2.2%"到能读出真实命中

Responses 族的命中在 `usage.input_tokens_details.cached_tokens`，
而 sid-code 此前只读 Chat 线的 `prompt_tokens_details.cached_tokens`。
Responses 响应里**根本没有那个键**，读到的是 `undefined` → 记成 0。

修完之后同一条路径能读出非零命中了。但别把 55.5% 当上限，看命中值：

```text
r2  hit=0        ← 服务端缓存写入有延迟
r3  hit=1792     ← 1792 = 128 × 14
r6  hit=2816     ← 一次跳了 1024
```

**都是 128 的整数倍。** 服务端是按 128 token 粒度**渐进扩展**缓存前缀，
不是一次缓存全部。轮数越多越接近上限，第 6 轮已经 94.0%。

### 1.3 修的是一整个协议族，不是两个模型

`src/llm/model-registry.ts` 里声明 `protocolKind: "openai-responses"` 的共 **11 个**模型：
`gpt-5.2 / gpt-5.4 / gpt-5.4-mini / gpt-5.4-nano / gpt-5.4-pro / gpt-5.5 / gpt-5.5-pro /
gpt-5.6 / gpt-5.6-luna / gpt-5.6-sol / gpt-5.6-terra`。

这 11 个的缓存命中此前**全部漏采**，只是账本里目前只用过 luna 与 gpt-5.4
（合计 43 会话、8733 万输入 token，占账本 18.3%）。
同一路径还漏采 `output_tokens_details.reasoning_tokens` ——
thinking 模型的隐藏成本在这一族上同样测不出。

### 1.4 账本下界

| 指标 | 值 |
| --- | --- |
| 会话数 | 350 |
| 总输入 token | 478,136,306 |
| 整体命中率 | **66.9%** |
| openai 族 | 339 会话 / 63.5% / cacheWrite=0 |
| anthropic 族 | 11 会话 / 81.4% / cacheWrite=15,784,943 |
| 总成本 | $195.63 |

这个账本是**每会话一行**聚合（`upsertUsageLedger` 按 `sessionId` 覆盖，
`src/telemetry/usage-ledger.ts:85`），每行都把该会话的冷启动首轮混在里面。
所以它是**偏保守的下界，不是稳态命中率**，与 §1.1 不可直接相比。

::: details 复现命令（你跑出来的数会和这里不同）
`~/.sid-code/` 下是滚动窗口，这份账本是某天的切片。命令能复现的是口径，不是数字。

```bash
bun -e '
const fs=require("fs");
const p=process.env.HOME+"/.sid-code/usage-ledger.jsonl";
const l=fs.readFileSync(p,"utf8").trim().split("\n").filter(Boolean)
  .map(x=>{try{return JSON.parse(x)}catch{return null}}).filter(Boolean);
const agg={};
for(const o of l){
  const k=(o.provider||"?")+" / "+(o.model||"?");
  const a=agg[k]=agg[k]||{n:0,hit:0,tot:0};
  a.n++;a.hit+=o.cacheHit||0;a.tot+=o.promptTotal||0;
}
for(const[k,a]of Object.entries(agg).sort((x,y)=>y[1].tot-x[1].tot))
  console.log(k.padEnd(34),String(a.n).padStart(4),
    ((a.tot?a.hit/a.tot*100:0).toFixed(1)+"%").padStart(7),
    String(a.tot).padStart(13));
'
```

受控实测（会真花钱，脚本自带 $0.50 硬上限与临时账本隔离）：

```bash
bun scripts/cache-bench.ts --model glm-5.2 --rounds 6
bun scripts/cache-trust-probe.ts --model claude-sonnet-5-gateway --rounds 3
```
:::

## 二、如何实现

### 2.1 约束：一个协议事实，不可协商

系统提示词里天然混着两类东西。静态的是角色设定、工具规范、项目 `CLAUDE.md`，
一整场会话不变；动态的是当前日期、`git status`、剩余 token 预算，每轮都在变。

它们混在一起时，动态那一小段决定静态那一大段能不能复用。
所以第一步是切开 —— sid-code 用一个哨兵字面量做切分
（`DYNAMIC_BOUNDARY`，`src/api/cache-strategy.ts:74`）。

切开之后怎么摆，取决于一个不可协商的协议事实：

| 项 | Anthropic 族 | OpenAI Chat 族 | OpenAI Responses 族 |
| --- | --- | --- | --- |
| 缓存粒度 | content block 级，显式 `cache_control` | 从 token 0 起的整体前缀匹配 | 同 Chat |
| 分段能力 | 有，上限 4 个断点 | **无** | **无** |
| 命中字段 | `cache_read_input_tokens` | `prompt_tokens_details.cached_tokens` | `input_tokens_details.cached_tokens` |
| 写入计费 | 有（`cacheCreationInputTokens`） | 恒 0 | 恒 0 |

**第三列是这次才补上的。** 它与第二列同为"OpenAI 族"、同一个 provider、同一个 base_url，
但命中字段不同 —— 这个差异正是 §3.2 那个错误结论的根源。

### 2.2 推导：为什么 OpenAI 族必须把动态内容搬到消息末尾

直觉做法是把整段 system（含动态区）塞进 `messages[0]`。跟着约束推一步：

OpenAI 族是从 token 0 开始的严格前缀匹配。日期变一个字节，`messages[0]` 内部的前缀就断了。
而前缀一旦在第一条消息里断掉，**其后全部历史消息即使一个字节都没变，本轮也全部无法复用**。

代价是具体的：一个 50 轮的会话，第 50 轮因为日期变了，把前 49 轮的历史全部按原价重算。

所以不是"我们选了"，是约束逼出了唯一解 —— 静态区留在 `messages[0]`，
动态区搬到消息序列末尾，作为一条独立的 `<system-reminder>` user 消息
（`openai.ts:286` `prependSystemMessage`）。

一个实现细节值得单独说：这里是**新增**一条消息，不是改写已有的末尾消息。
因为 `convertMessages` 之后结尾未必是 user —— 可能是 assistant，也可能是 `role: "tool"`。
改写末尾等于赌结尾角色，赌错就是协议错误。

### 2.3 Anthropic 族：四个断点，和一道预算断言

有分段能力的那一侧简单得多，只是要把四个断点放对，且流式与非流式各打一遍
（行号均在 `src/llm/anthropic.ts`）：

| 断点位置 | 流式 | 非流式 | 实现 |
| --- | --- | --- | --- |
| system 静态区尾 | `:211` | `:693` | `buildSystemBlocks` |
| system 动态区尾 | 同上 | 同上 | 同上（有边界才拆两块） |
| 工具数组最后一项 | `:220` | `:708` | `markLastToolCacheBreakpoint` |
| 最后一条 user 消息末块 | `:174` | `:696` | 手写倒序循环 |

四个是硬上限，超了服务端直接 400。所以发请求前有一道预算断言
（`cache-strategy.ts:314` `assertCacheBreakpointBudget`）：
非生产环境抛错把 bug 暴露出来，生产环境只打 error 不抛 ——
**遥测和护栏不该成为阻断主流程的新故障源**。

### 2.4 命中读数的兜底链

各家把"命中了多少"放在不同字段里，所以取值是一条兜底链
（`openai.ts:83` `extractOpenAICacheHit`）：

```text
prompt_cache_hit_tokens              ← DeepSeek 官方直连的顶层专有字段
  ↓
prompt_tokens_details.cached_tokens  ← OpenAI Chat 标准字段
  ↓
input_tokens_details.cached_tokens   ← OpenAI Responses 字段（这次补的）
  ↓
cached_tokens                        ← Kimi 官方直连的顶层扩展字段
```

顺序不是随便排的：Kimi 那个 `cached_tokens` 放在末位，
因为标准端点顶层没有这个字段，**放最后不会误伤其它家**。

## 三、过程中遇到的问题

五个事故，每一个都以"测试全绿"或"判据看着很硬"为掩护。

### 3.1 一个月卡网关在编造 usage

先说这个，因为它污染了这篇文章此前的 anthropic 族数字。

某月卡网关（`code.ppchat.vip`）上报的 Anthropic usage 是编造的。三重判据全部命中：

**判据 A —— 全新随机前缀**（服务端必然从未见过），r1 就报大量命中：

```text
[ppchat anthropic sonnet-4-6] 全新前缀 nonce=1786152040-a7f3
  r1 in=225 read=13860 create=2485 sum=16570   ← r1 就命中 13860，逻辑上不可能
```

**判据 B —— 完全不打 `cache_control`**，仍报命中：

```text
  r1 in=700 read=12239 create=3439 sum=16378   ← 没打断点也"命中"
```

**判据 C —— 同一前缀连发 5 次，三个数随机跳动而总和恒定。** 这是铁证：

```text
  r1 in= 31 read=8654 create=4474 sum=13159
  r2 in=710 read=7317 create=5132 sum=13159
  r3 in= 53 read=8896 create=4210 sum=13159
  r4 in=929 read=8941 create=3289 sum=13159
  r5 in=409 read=9724 create=3026 sum=13159
```

**网关把一个固定总数随机三等分。** 对照组（公司网关 uniapi）在同款判据下行为完全正确：
判据 A 冷启动 `read=0 create=2584`、repeat×3 稳定 `read=2584`、
判据 B 不打断点则 `read=0 create=0`。所以不是判据太严，是渠道在造数。

后果：这篇文章此前表格里 anthropic 族的 81.4%、以及"cacheWrite 1578 万印证协议差异"
这个证据，**建立在一个会编造 usage 的网关上**。已把 ppchat 从数据源撤下
（只保留功能可用性验证），anthropic 族的数字改用 uniapi 实测。

这套判据已固化为 `scripts/cache-trust-probe.ts`，判定写入 `channel-trust.json`，
`/cache` 视图里不可信渠道单独标记且**不进总计**。

::: warning 写判据时踩的两个坑
**① 判据 B 必须用另一个全新前缀。** Anthropic 的 `cache_control` 只决定"写不写"，
**读是自动的** —— 判据 A 已经把前缀写进缓存，B 复用同一前缀即便不打标记也会正常命中。
第一版就这么排的，把行为完全正确的 uniapi 判成了"不可信"。

**② 全零样本不得判 trusted。** 第一次实跑 ppchat 时，因为把线上 snake_case usage
直接喂给了吃 camelCase 的归一化函数，三段全读成 0 —— 而"零命中"恰好让四条判据
**全部通过**，探针给一个正在造数的渠道发了张清白证明。
这是探针的根本风险：判据都在找"不该出现的命中"，所以**采集断裂会伪装成完美可信**。
:::

### 3.2 把漏采误判成后端能力边界

上一版这篇文章有一节叫「gpt-5.6-luna 的 2.2%：是真没命中，不是漏采」。**那个结论是错的。**

当时的判据方法本身是对的：找一个走完全相同代码路径的对照组。
`glm-5.2` 与 `gpt-5.6-luna` 同 provider、同 base_url（同一个公司网关）、同一条兜底链，
而统计显示 glm 188/207 次响应命中、luna 67/67 次都有该字段且值恒 0。
于是结论写成"网关后端对 luna 不支持前缀缓存"。

**错在哪：判据方法对，但认错了代码路径。**

luna 在 registry 里声明 `protocolKind: "openai-responses"`（`model-registry.ts:127`），
而这个声明的优先级**高于**端点启发式，所以它经同一个网关走的是 `POST /v1/responses`，
glm 走的是 `POST /chat/completions`。**两者从来不是同一条路径。**

而且"67/67 都有该字段"这个观察本身也是错的：读的是 `prompt_tokens_details`，
Responses 响应里根本没有这个键 —— 读到的是 `undefined`，不是 0。

实测同一网关、`POST /responses`、全新随机前缀：

```text
r1 usage: {"input_tokens":18017,"input_tokens_details":{"cached_tokens":0},    ...}
r2 usage: {"input_tokens":18017,"input_tokens_details":{"cached_tokens":17152},...}
r3 usage: {"input_tokens":18017,"input_tokens_details":{"cached_tokens":17152},...}
```

**真实命中率 95.2%，账本记的 2.2% 是采集缺陷。**

> 判据是对的，用错了对象。**判断"同代码路径"必须核实协议分派，
> 不能只看 provider 与 base_url 相同。** 这个错误的代价不只是一个错数字 ——
> 它让 11 个模型的漏采以"后端能力边界"的名义被合理化了两个月。

### 3.3 hash 字段被手写拷贝列表丢掉，统计只能 grep 中文文案

sid-code 有个缓存中断检测器，命中率骤降时做归因并落盘。
上一版文章说"650 条里 418 条带 hash 判据"。实测：**676 条记录里带 `previousPrefixHash` 的是 0 条。**

根因：`emitCacheBreakTelemetry` 手写字段拷贝列表，漏了 `previousPrefixHash` /
`currentPrefixHash`。检测器算出来了（`cache-detection.ts:277-278`），落盘时被丢掉。

那 418 从哪来的？从 `changes[]` 的**人类可读中文文案**里 grep "hash未变"：

```text
服务端波动(hash未变，从 changes 文案推断)  442
未知原因（判据上线前的旧记录）              232
模型变化                                      2
```

所以"99.5% 是服务端波动"这个**结论方向是对的**（442/444），
但它依赖对中文文案做子串匹配 —— 文案改一个字，所有历史统计就断。

修法分两层。表层是补两个字段 + 加结构化 `categories` 枚举（聚合只读枚举，不读文案）。
但**根因是"手写字段拷贝列表"这个模式本身**，所以落盘改成
**默认透传 + 显式剔除**（`EXCLUDED_KEYS` 目前为空集），并加门禁测试：
`CacheBreakRecord` 的键集合减去剔除集合，必须被落盘 entry 全覆盖 ——
新增字段忘了拷就变红。

> 这个病在本仓库出现过不止一次（消息块字段静默丢失是同病）。
> **手写字段列表与手写分派链同源：根治都是"默认透传 + 兜底告警"，不是"这次记得补上"。**

### 3.4 非流式不做协议分派，降级时口径分裂

查 §3.2 时撞到的独立缺陷。

`shouldUseResponsesAPI` 只在流式入口被调用；非流式路径**无条件**打 `/chat/completions`。
三条真实触发路径：流式传输错误降级、空流降级、ModelFallback。

后果分三层，第三层与度量直接相关：

1. 请求以 Chat 线格式发出，丢掉 Responses 专属能力（reasoning 档位、instructions 语义）
2. 网关若不为该模型提供 Chat 端点，降级会**二次失败** —— 而降级恰好发生在网关已异常的时刻
3. **缓存口径分裂**：同一个模型，流式走 Responses（命中在 `input_tokens_details`）、
   降级走 Chat（命中在 `prompt_tokens_details`）。修完 §3.2 后两条路径读不同字段，
   就会出现"同一模型同一会话，取决于当时是否降级而命中率口径不同"。

这个坑**代码注释里早就记录了**，还为此在 `isUnknownFamily` 判据里打了一道补丁
（避免把 Responses 专属的 `xhigh`/`max` 档位当普通 `reasoning_effort` 发到 Chat 线）。
**但补丁只挡住了 effort 字段，没解决协议错配本身**，直到度量口径分裂才暴露。

已在非流式入口补上同样的分派 + 非流式 Responses 分支（复用同一份 usage 提取逻辑）。

### 3.5 一次让所有测试都保持绿色的污染事故

采集 §3.3 那份归因分布时，第一次统计结果是清一色"System prompt 变化"，
时间戳全部显示 2023-11-15。

`cache-breaks.jsonl` 当时 3929 行，其中 3889 行是假数据（`ts: 1700000000` 这种测试固定值），
真实记录只剩 40 行。轮转文件 `.1` 里 60701 行，假的 60109 行。
而 `/cache --history` 读尾部 20 条做明细、尾部 500 条做聚合 —— 两个窗口里一条真记录都取不到。

根因是 `recordCacheBreak()` 除了推内存环形缓冲，还会落盘遥测，
而两个单测直接调了它，却没设项目早就提供好的隔离环境变量 `SID_CODE_CACHE_BREAKS`。
每跑一次 `bun test` 就往真实文件灌 78 行。

三个条件叠加让它成了静默故障：

1. 落盘是 fire-and-forget 且吞异常 —— 写错位置不会有任何提示；
2. 测试断言的是内存缓冲，落盘那一路不在断言范围内 —— **测试全绿也说明不了落盘去了哪**；
3. 10MB 才轮转 —— 污染先静静堆积，堆满一轮 rename 成 `.1`，看起来像"正常有历史数据"。

值得记的不是这两个文件，而是判据：

> 只要一个函数除了返回值还有「写用户家目录」这种进程外副作用，
> 调它的测试就必须显式隔离；而"必须记得隔离"这件事不能只靠人记住。

所以补隔离之外还加了一道门禁（`tests/telemetry/no-real-path-writes.test.ts`）：
静态扫描 `tests/` 下所有 import 了落盘类导出的文件，没声明隔离就让 CI 变红。
本轮把 `usage-ledger` 的三个落盘导出也纳入了这道门禁 —— 它此前只覆盖 cache-breaks。

**门禁自己也得验。** 只验"加了门禁后是绿的"不够 —— 那条门禁可能压根没在检查东西。
反向验证的做法是故意去掉一个文件的隔离，确认它会红并点名那个文件。
门禁里还留了护栏：扫到的文件数必须 > 100，否则正则漂移导致"一个都没扫到"时，
它会静默变成永远通过的绿灯。

顺带一个反直觉的实现细节：落盘走的是 `import().then()`，是待处理微任务。
`afterAll` 里同步恢复环境变量会与那个待处理的写赛跑，让最后几条漏写到真实路径。
得先 `await new Promise(r => setTimeout(r, 0))` 让微任务队列跑干。

### 3.6 两个 bug 互相打掩护

清理完假数据，`/cache --history` 的聚合视图仍然不对：500 条记录里 499 条落在 `unknown`。

原因是 `summarizeCacheBreakHistory` 的分类分支是照"模型变化 / 工具变化 / TTL"写的，
而后来新增的两条前缀 hash 归因 —— 就是 §3.3 那个关键判据 —— 没有对应分支，
全部掉进兜底的 `unknown`。

这个 bug 存在期间没人发现，恰恰是因为假数据长期霸占读取窗口：
假数据的归因是"System prompt 变化"，有分支、能正确分类。
**污染掩盖了聚合缺陷**，两个 bug 互相打掩护。

### 3.7 仪器自己的缺陷：只记命中，分不清"没缓存"与"反复重写"

本轮新做的受控实测脚本自己也交了一次学费，值得记，因为它是**结论矛盾救回来的**。

第一次跑 uniapi 的 anthropic 通道，6 轮命中全是 0。差一步就写成"网关不透传 `cache_control`"。
但可信度探针用**完全相同的请求**却稳定命中（`read=2584`、判定可信）。

两个结论矛盾，说明不是渠道问题，是**仪器**问题：bench 只记了 `hit` 没记 `write`，
而 `hit=0` 有两种成因：

1. 什么都没缓存（断点没生效 / 前缀太短）
2. 每轮都在**重新写入**（缓存键把变化的尾部也算进去了 → 永远写、永远读不到）

**这两种成因的修法相反，而只看命中列无法区分。**
已给 bench 补 `write` 列 + "命中恒 0 但每轮都在写入"的自动提示，并加单测锚死这个区分。

> 两个工具的前缀策略是**相反**的：探针用每次全新的 nonce 前缀（判据要求服务端没见过），
> bench 用跨轮固定前缀（要测的是缓存生效后能到多少）。
> 正因如此它们能互相当对照组 —— 结论矛盾时，先怀疑仪器。

## 四、张力：JIT 上下文与 prompt cache 互相拉扯

[JIT 上下文](/blog/jit-context)那篇讲的按需注入 —— 工具访问了
`src/ui/components/Footer.tsx`，就把 `src/ui/CLAUDE.md` 注入进去 —— 和 prompt cache 直接冲突。

因为 OpenAI 族的动态区在消息序列末尾，而 JIT 注入正是往那个位置追加内容。
每次 JIT 注入都改写这条消息，该位置之后的前缀本轮断裂。
Anthropic 族因为有分段断点，受影响小得多。所以"JIT 注入是安全的"这个说法
**只对 Anthropic 族完整成立** —— 而 deepseek / glm 才是这个仓库的主力。

这是个真实的 trade-off，不是可以两全的：更精准的上下文注入天然伤缓存命中率。
把它写出来比假装没有更有用。

为了不再靠猜，本轮加了 `prefix_break` 埋点：逐轮与上一轮做最长公共前缀比对，
记下第一个变化点落在哪个区段（system 静态区 / 动态区 / 工具 / 第 N 条消息）
以及**作废了多大比例的前缀**。聚合按浪费量而非次数排序 ——
断在第 2 条消息与第 200 条都算 1 次，但作废的前缀量差两个数量级，
只看次数会把优化力气用错地方。

## 五、后续规划待办

照实写没做到的部分。

**1. 账本里成本与 token 仍不同源。** `costUSD` 含影子调用（auto-compact、
bash-classifier、goal/evaluator 等 13 个模块的辅助调用），`promptTotal` / `cacheHit` 不含。
两个数不能相除，所以"缓存省了百分之多少钱"用账本算不出来。
本轮已给账本行加 `sideInputTokens` / `sideOutputTokens` / `sideCostUSD`
（影子调用的 token 其实**早就在采集**，只是没进账本，是接线而非新建埋点），
但新字段只对新会话生效，历史行仍不同源。

**2. 缓存 × 延迟的对照只做了一半。** TTFT 有纯净埋点，本轮已按命中/未命中分桶
（`trace-digest --health` 能出两组分位数）。但 anthropic 族的 usage 在 `message_start`
就有、首内容时刻可得，而**OpenAI 族的 usage 在流尾部**，首内容时刻拿不到 ——
只能在 `completed` 阶段补 emit。所以 openai 族的这个对照精度不如 anthropic 族。
端到端耗时（用户回车 → 最终答复）仍无独立埋点。

**3. 服务端波动占中断 99.5%，本地不可控。** 这条改不了，只能监测。
`/cache --breaks` 就是为此存在的：既然本地能优化的前缀断裂接近零，
该做的是发现命中率从 90% 掉到 70%。

**4. anthropic 族样本不仅少，此前还是脏的。** 现在有了 uniapi 的可信实测（98.7% 稳态），
但账本里 anthropic 只有 11 个会话，且其中 ppchat 渠道的行已标为不可信。
别拿一族的数字去校准另一族。

**5. Responses 族的 55.5% 需要更长的轮次才能定性。** 实测显示服务端按 128 token 粒度
渐进扩展前缀，第 6 轮已 94.0%。到底稳态在哪、需要几轮收敛，现有 6 轮样本答不了。

**6. deepseek 官方直连的缓存写入有延迟且不保证。** 实测同一前缀有时 r2 命中、
有时 r3 才命中。这是"稳态命中率 ≠ 每轮命中"的实证，也意味着任何单次观测都不能当结论。

**7. `raw.jsonl` 缺响应侧时间戳，离线算不出 TTFT。** 配对行的时间戳与 `request_sent`
逐字节相同（写的是请求发起时刻）。所以 TTFT 只能靠在线埋点，历史轨迹补算不出来。

**8. 一处断点技术债，且有语义分叉。** Anthropic 族"最后一条 user 消息打断点"走的是
手写倒序循环，流式与非流式各写了一遍，都没走 `cache-strategy.ts` 里现成的
`addMessageCacheBreakpoint`。上一版这篇说它"功能上没错" —— **这个说法要修正**：
手写循环找的是最后一条 `role==="user"` 的消息，而 `addMessageCacheBreakpoint`
打的是最后一条消息（不论 role）。**assistant 结尾时两者落点不同**，是语义分叉而非纯重复。
收口时必须保留现有生产行为，不能直接替换。

**9. 没有对标对象。** claude-code 的遥测上报到服务端，本地不落这类明细文件。
这是"数据全部自主"这个方向自带的成本：数据在本地，就得自己管好测试与真实数据的边界。

## 一句话

prompt cache 的机制不难。难的是**验证它的那条链**：
真实数据比想象中更容易被自己的测试污染（且污染时测试全绿）、
被网关编造（且判据不做就发现不了）、被一个读错的字段名整族抹平
（且会以"后端能力边界"的名义被合理化）。

**判据方法对，不代表用对了对象。** 这次最贵的一课不是某个 bug，
而是一个看起来很硬的判据 —— 同代码路径对照组 —— 因为认错了代码路径，
让 11 个模型的漏采被合理化了两个月。

## 相关

- [成本与用量](/use/cost) —— 自己的命中率怎么看，以及
  [两族协议的正常值](/use/cost#缓存命中率-两族协议的正常值不同)分别是多少
- [缓存退化监测](/use/cost#breaks-缓存退化监测) —— `/cache --breaks`：
  既然 99.5% 的中断是服务端波动，那就只能靠监测发现命中率掉档
- [上下文与压缩](/use/context) —— 前缀为什么会变、`/compact` 与缓存的关系
- [JIT 上下文](/blog/jit-context) —— 与本篇拉扯的另一头：按需注入的实测基线，
  以及它为什么恰好落在伤缓存的那个位置
