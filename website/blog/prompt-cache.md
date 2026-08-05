---
title: Prompt Cache：两族协议的分叉，和 4.2 亿 token 的实测账
description: 同一套缓存策略，在 Anthropic 协议和 OpenAI 协议上必须写成两种形状。这篇拆开 sid-code 的实现分叉，交出 283 个会话 4.2 亿输入 token 的命中率账本，以及几个只有实测才能发现的坑——包括一个把我自己骗了两天的假数据。
date: "2026-08-04"
series: 上下文工程
highlight: 283 会话 · 4.2 亿输入 token 账本 · 命中率 0 → 83.2%
tags: [prompt cache, 成本优化, 机制解析, 实测]
---

# Prompt Cache：两族协议的分叉，和 4.2 亿 token 的实测账

一个 coding agent 每轮请求都要重发整段系统提示词、全部工具定义、以及到目前为止的所有历史消息。
在这个仓库里那是几万个 token 起步，而一次任务动辄几十轮。不复用缓存，成本和延迟都不成立。

prompt cache 的原理简单到一句话：**服务端认前缀，前缀没变就按折扣价重算**。
难的地方在"没变"这三个字——它在两族协议里的含义不一样，
而这个差异会一直渗透到你怎么摆放一条日期字符串。

sid-code 同时接 Anthropic 协议和 OpenAI 协议（含 deepseek / glm / kimi / qwen 等经网关的后端）。
这篇拆开两族的实现分叉、交出实测账本，并照实写下当前还没做到的部分。

## 为什么"把动态内容放哪"是个成本问题

系统提示词里天然混着两类东西：

- **静态**：角色设定、工具使用规范、项目 `CLAUDE.md`。一整场会话不变。
- **动态**：当前日期、`git status`、剩余 token 预算。**每轮都在变**。

它们混在一起时，动态那一小段会决定静态那一大段能不能复用。
sid-code 用一个哨兵字面量 `DYNAMIC_BOUNDARY` 把两者切开
（`src/api/cache-strategy.ts`，`buildSystemBlocks` 与 `splitSystemByDynamicBoundary` 共用同一份切分口径）。

切开之后怎么摆，两族协议的答案完全不同。

## 分叉一：Anthropic 是分段的，OpenAI 是一条线

| 项 | Anthropic 族 | OpenAI 族（deepseek / glm / kimi 等） |
| --- | --- | --- |
| 缓存粒度 | content block 级，显式打 `cache_control` | 从 token 0 起的**整体前缀匹配**，无法分段 |
| 断点数上限 | 4（`src/api/cache-strategy.ts:308`） | 无断点概念 |
| 动态内容处置 | 静态区/动态区各打一个断点，都留在 system 里 | **把动态区搬出 system，挪到消息序列末尾** |
| `cacheCreationInputTokens` | 有值（写入单独计费） | 恒 0（`src/llm/openai.ts:78-80`） |

Anthropic 族给了你分段能力，所以只要在正确的位置放断点就行。四个断点的位置
（流式与非流式各打一遍，代码对齐）：

| 断点 | 流式 | 非流式 | 实现 |
| --- | --- | --- | --- |
| system 静态区尾 | `anthropic.ts:207` | `:684` | `buildSystemBlocks` |
| system 动态区尾 | 同上 | 同上 | 同上（有 `DYNAMIC_BOUNDARY` 才拆两块） |
| 工具数组最后一项 | `:215-217` | `:698-699` | `markLastToolCacheBreakpoint` |
| 最后一条 user 消息末块 | `:171-179` | `:686-690` | 手写倒序循环 |

四个断点是硬上限，超了服务端直接 400。所以发请求前有一道预算断言
（`cache-strategy.ts:314` `assertCacheBreakpointBudget`），
非生产环境抛错把 bug 暴露出来，生产环境只打 error 不抛——
遥测和护栏不该成为阻断主流程的新故障源。

OpenAI 族没有分段能力，这就逼出了一个不太直觉的做法。

## 分叉二：为什么 OpenAI 族要把动态内容搬到消息末尾

OpenAI 族是从 token 0 开始的严格前缀匹配。如果把整段 system（含动态区）
塞进 `messages[0]`，那么日期变一个字节，`messages[0]` 内部的前缀就断了——
**其后全部历史消息，即使一个字节都没变，本轮也全部无法复用**。

一个 50 轮的会话，第 50 轮因为日期变了而把前 49 轮的历史全部按原价重算。

所以 sid-code 的做法是：静态区留在 `messages[0]`，动态区**搬到消息序列末尾**，
作为一条独立的 `<system-reminder>` user 消息
（`src/llm/openai.ts:276-283` 的注释是这段设计的一手解释）。

一个实现细节值得单独说：这里是**新增**一条消息，而不是改写已有的末尾消息。
因为 `convertMessages` 之后结尾未必是 user——可能是 assistant，也可能是 `role: "tool"`。
改写末尾等于赌结尾角色，赌错了就是协议错误。

命中读数也有分叉。各家把"命中了多少"放在不同字段里，所以取值是一条三级兜底链
（`src/llm/openai.ts:82-87`）：

```text
prompt_cache_hit_tokens                  ← DeepSeek 官方直连的顶层专有字段
  ↓
prompt_tokens_details.cached_tokens      ← OpenAI 标准字段（公司网关统一归一到这里）
  ↓
cached_tokens                            ← Kimi 官方直连的顶层扩展字段
```

顺序不是随便排的：Kimi 那个 `cached_tokens` 放在末位，因为标准端点顶层没有这个字段，
放最后不会误伤其它家。

## 实测账本：283 个会话，4.2 亿输入 token

先说口径，否则数字没有意义：

- 数据源 `~/.sid-code/usage-ledger.jsonl`，指标为 `cacheHit / promptTotal`。
- 这个账本是**每会话一行聚合**，不是每次调用一行（`upsertUsageLedger` 按 `sessionId` 覆盖，
  `src/telemetry/usage-ledger.ts:85`）。所以下表的"会话数"是会话数，
  且每行的命中率**已经把该会话的冷启动首轮混在里面**——首轮必然无缓存可命中。
- 因此这批数字是**偏保守**的下界，不是稳态命中率。

复现命令：

```bash
bun -e '
const fs=require("fs");const p=process.env.HOME+"/.sid-code/usage-ledger.jsonl";
const l=fs.readFileSync(p,"utf8").trim().split("\n").filter(Boolean)
  .map(x=>{try{return JSON.parse(x)}catch{return null}}).filter(Boolean);
const agg={};
for(const o of l){
  const k=(o.provider||"?")+" / "+(o.model||"?");
  const a=agg[k]=agg[k]||{n:0,hit:0,tot:0};
  a.n++;a.hit+=o.cacheHit||0;a.tot+=o.promptTotal||0;
}
for(const[k,a]of Object.entries(agg).sort((x,y)=>y[1].tot-x[1].tot))
  console.log(k.padEnd(34),String(a.n).padStart(4),((a.tot?a.hit/a.tot*100:0).toFixed(1)+"%").padStart(7),String(a.tot).padStart(13));
'
```

2026-08-04 实测：

| provider / model | 会话数 | 命中率 | 输入 token |
| --- | --- | --- | --- |
| openai / glm-5.2 | 123 | 79.4% | 187,260,820 |
| anthropic / claude-sonnet-5 | 3 | 82.2% | 84,439,779 |
| openai / gpt-5.6-luna | 31 | **2.2%** ⚠ | 83,511,933 |
| openai / deepseek-v4-pro | 48 | 94.4% | 32,925,960 |
| openai / kimi-k3 | 17 | 76.1% | 12,628,450 |
| openai / ali-deepseek-v4-pro | 24 | 78.7% | 7,923,954 |
| openai / ali-deepseek-v4-flash | 22 | 70.7% | 5,859,280 |
| anthropic / claude-opus-5 | 3 | 73.8% | 4,277,140 |
| openai / kimi-k2.6 | 3 | 75.0% | 497,414 |
| openai / gpt-5.4 | 5 | **18.4%** ⚠ | 460,191 |

合计 4.2 亿输入 token，其中 2.75 亿命中缓存，整体命中率 65.4%。

两族分开看，差异很清楚：

| 族 | 会话数 | 命中率 | cacheWrite |
| --- | --- | --- | --- |
| anthropic | 10 | 81.5% | 15,537,507 |
| openai | 273 | 61.0% | 0 |

`cacheWrite` 那一列恰好印证了前面的机制差异：OpenAI 族没有缓存写入计费概念，恒为 0。

### gpt-5.6-luna 的 2.2%：是真没命中，不是漏采

这个数字第一眼像 bug。而且有个很有说服力的假设：会不会是这家后端的 usage 字段名
不在三级兜底链里，导致**漏采**——明明命中了，我们读成 0？

如果是漏采，那它属于"度量缺陷"；如果是真没命中，那它属于"后端能力边界"。
两者的处置完全不同，所以不能猜。

判据是找一个**走完全相同代码路径**的对照组。`glm-5.2` 与 `gpt-5.6-luna`：
同 provider（`openai`）、同 base_url（同一个公司网关）、同一个 `extractOpenAICacheHit` 兜底链。
从轨迹文件里统计两者的原始命中字段：

```text
model            响应数   有该字段   命中=0   命中>0    最大命中
glm-5.2            195      195       17      178       98,304
gpt-5.6-luna        66       66       66        0            0
```

结论是确定的：**字段一直都在**（66/66 都有），只是值恒为 0。
漏采会让同一条代码路径上的两个模型表现一致，不会只对其中一个恒零。
所以这是该网关后端对 luna 不支持前缀缓存，不是我们的采集缺陷。

`gpt-5.4` 的 18.4% 同源可疑，但样本只有 5 个会话，**证据不足，不下结论**。

## 什么操作会打断缓存：实测归因分布

sid-code 有一个缓存中断检测器，命中率骤降时做归因并落盘
（`~/.sid-code/cache-breaks.jsonl`）。清理掉污染数据后（见下一节），
632 条真实中断记录的归因分布是：

| 归因 | 条数 | 占比 |
| --- | --- | --- |
| 服务端缓存波动（本地前缀 hash 未变） | 631 | 99.8% |
| 模型变化 | 1 | 0.2% |

这个分布出乎意料，而且**它本身就是结论**：本地能优化的前缀断裂几乎为零，
99.8% 的中断是本地前缀 hash 没变、命中却掉了——网关 TTL 过期或路由换了节点，
本地不可控。

这个"前缀 hash 变没变"的判据是关键（`src/api/cache-detection.ts:263-268`）：
hash 变了才说明是本地 prompt 前缀断裂，是我们的问题、可以优化；
hash 没变而命中掉了，就只能归给服务端。没有这个字段，
所有中断都会被笼统记成"未知原因"，看着像有一堆待修的 bug。

## 只有实测才能发现的坑

### 坑一：847 条历史记录，全是我自己的单测写进去的

采集上面那份归因分布时，第一次统计的结果是「清一色 System prompt 变化」，
时间戳全部显示 2023-11-15。

`~/.sid-code/cache-breaks.jsonl` 里当时 3929 行，其中 3889 行是假数据——
`ts: 1700000000` 这种测试固定值。轮转文件 `.1` 里 60701 行，假的 60109 行。
`/cache --history` 读尾部 20 条做明细、尾部 500 条做聚合，
两个窗口里**一条真记录都取不到**。

根因是 `recordCacheBreak()` 除了推内存环形缓冲，还会同步落盘遥测
（`src/api/cache-detection.ts:428`），而两个单测直接调了它、
却没设项目**早就提供好**的隔离环境变量 `SID_CODE_CACHE_BREAKS`。
每跑一次 `bun test` 就往真实文件灌 78 行。

三个条件叠加让它成了静默故障：

1. 落盘是 fire-and-forget 且吞异常——写错位置不会有任何提示；
2. 测试断言的是内存缓冲，落盘那一路不在断言范围内——**测试全绿也说明不了落盘去了哪**；
3. 10MB 才轮转——污染先静静堆积，堆满一轮 rename 成 `.1`，看起来像"正常有历史数据"。

值得记的不是这两个文件，而是判据：

> 只要一个函数除了返回值还有「写用户家目录」这种进程外副作用，
> 调它的测试就必须显式隔离；而"必须记得隔离"这件事不能只靠人记住。

所以补隔离之外还加了一道门禁（`tests/telemetry/no-real-path-writes.test.ts`）：
静态扫描 `tests/` 下所有 import 了落盘类导出的文件，没声明隔离就让 CI 变红。

这道门禁自己也得验。只验"加了门禁后是绿的"不够——那条门禁可能压根没在检查东西。
反向验证的做法是故意去掉一个文件的隔离，确认它会红并点名那个文件。
门禁里还留了两个护栏：扫到的文件数必须 >100、匹配到的调用方必须 ≥3，
否则正则漂移导致"一个都没扫到"时，门禁会静默变成永远通过的绿灯。

顺带一个反直觉的实现细节：落盘走的是 `import().then()`（`cache-detection.ts:451`），
是待处理微任务。`afterAll` 里同步恢复环境变量会**与那个待处理的写赛跑**，
让最后几条漏写到真实路径。得先 `await new Promise(r => setTimeout(r, 0))` 让微任务队列跑干。

### 坑二：归因聚合把 499/500 条记录归成了"未知"

清理完假数据，`/cache --history` 的聚合视图仍然不对：500 条记录里 499 条落在 `unknown`。

原因是 `summarizeCacheBreakHistory` 的分类分支是照"模型变化 / 工具变化 / TTL"
这些归因写的，而后来新增的两条前缀 hash 归因（就是上面那个关键判据）
**没有对应分支**，全部掉进兜底的 `unknown`。

这个 bug 存在期间没人发现，恰恰是因为假数据长期霸占读取窗口——
假数据的归因是"System prompt 变化"，有分支、能正确分类。
**污染掩盖了聚合缺陷**，两个 bug 互相打掩护。

补分支之后 `unknown` 从 499 降到 0。同时加了一个对账测试：
不手抄归因文案常量，而是让**真实检测器**产出归因再喂给聚合器。
手抄两份必然漂移——这个仓库里已经因为"测试手抄生产逻辑"吃过一次全绿的假安全。

### 坑三：原始诊断"deepseek 一点缓存都没命中"是错的

这条是历史记录里的，值得写出来当反面教材。

当初的判断是"deepseek 经公司网关完全没有 prompt cache"。实测否证：
44 个修复前的多轮会话，平均命中率（第 2 轮起）已经是 75%——
网关本来就透传 OpenAI 协议的 prompt cache。

真正的问题不是"没有缓存"，而是"静态前缀被动态内容整体打断"。
修复的价值也不是"从 0 到有"，而是让静态前缀在动态内容变化时不被连带作废：
受控测试里（turn 间真实修改 `git status`）命中率沿 0% → 46.6% → 83.2% 逐轮爬升。

顺便说清一个口径差异，避免读者拿这里的数字对不上别处：
`83.2%` 是**单个受控会话内逐轮爬升的终点**，而上面账本里 deepseek 的 `94.4%`
是**跨 48 个会话的聚合**。两个数字都对，量的不是同一件事。

## 张力：JIT 上下文与 prompt cache 是互相拉扯的

[上一篇](/blog/jit-context)讲的 JIT 注入——工具访问了 `src/ui/Footer.tsx`，
就把 `src/ui/CLAUDE.md` 注入进去——和 prompt cache 有直接冲突。

因为 OpenAI 族的动态区在**消息序列末尾**，而 JIT 注入正是往那个位置追加内容。
每次 JIT 注入都改写这条消息，该位置之后的前缀本轮断裂。

Anthropic 族因为有分段断点，受影响小得多。所以"JIT 注入是安全的"这个说法
**只对 Anthropic 族完整成立**——而 deepseek / glm 才是这个仓库的主力。

还有一点让它更麻烦：JIT 的已加载集合只加不减，没有淘汰、没有作用域退出时的移除。
每注入一份，末尾那条消息就永久变大，之后每一轮都携带全量。
所以治理重点不是"单份规则多大"，而是**累积总量**。

这是个真实的 trade-off，不是可以两全的：更精准的上下文注入天然伤缓存命中率。
把它写出来比假装没有更有用。

## 当前的能力边界

照实写没做到的部分。

**1. 同一行账本里，成本和 token 不是同一个population。** 这是本轮排查最要紧的一条，
也解释了项目自己说的"影子调用绕过埋点"到底指什么。

账本每一行的字段有两条不同的来源（`src/app.ts:4894` `buildLedgerEntry`）：

- `promptTotal` / `cacheHit` / `cacheWrite` 来自 `sessionState.updateUsage()`，
  全仓**只有两个调用点**——主循环（`src/query/loop.ts:2430`）和子代理 sink（`src/app.ts:1102`）。
- `costUSD` 来自 `getEffectiveTotalCostUSD()`，它是 `totalCostUSD + sideCostUSD`
  （`src/session/state.ts:329`）。而 `sideCostUSD` 由 `recordSideCall()` 累加，
  调用方遍布十几个模块：auto-compact、partial-compact、context-collapse、
  memory/recall、bash-classifier、tool-classifier、goal/evaluator、hook/runner……

也就是说：**这些辅助调用的「钱」进了账本，「token」没进**。
后果是这一行里的命中率分母不含影子调用的 token，而成本分子含影子调用的钱——
两个数不同源，**不能相除**。所以"缓存帮我省了百分之多少成本"这个问题，
用现在的账本算不出来。

上面那个 `savingsUSD` 合计 240.73 美元同理只能当量级参考：
283 个会话里有 71 个该字段为 0。

要修的话方向是清楚的：让影子调用也走 `updateUsage` 那条路把 token 记进来，
或者在账本里把两类分栏、明确标注各自口径。但这属于"要补的度量"，本轮没做。

**2. 延迟没有基线。** 四个北极星方向里"更快"几乎没有度量。
命中率上去了，TTFT 到底降了多少，**没数**。这篇通篇讲的是"省"，不是"快"。

**3. `gpt-5.4` 的 18.4% 没查清。** 样本只有 5 个会话，
不足以像 luna 那样用对照组下结论。

**4. Anthropic 族样本太少。** 10 个会话，其中 sonnet-5 只有 3 个。
81.5% 这个数字的置信度远低于 openai 族的 273 个会话。

**5. 一处可收口的技术债。** Anthropic 族"最后一条 user 消息打断点"
走的是手写倒序循环（`anthropic.ts:171-179`），
没走 `cache-strategy.ts` 里现成的 `addMessageCacheBreakpoint`。
功能上没错，但同一件事两种写法，改断点策略时容易只改一处。

**6. 没有对标对象。** claude-code 的遥测上报到服务端，本地不落这类明细文件。
这是"数据全部自主"这个方向自带的成本：数据在本地，
就得自己管好测试与真实数据的边界——坑一就是这个成本的账单。

## 一句话

prompt cache 的机制不难，难的是**它的正确性依赖你对协议差异的准确理解，
而验证它需要真实数据**——而真实数据这条链，比想象中更容易被自己的测试污染，
且污染时所有测试都是绿的。

## 相关

- [成本与用量](/use/cost) —— 自己的命中率怎么看、[两族协议的正常值](/use/cost#缓存命中率-两族协议的正常值不同)分别是多少
- [缓存退化监测](/use/cost#breaks-缓存退化监测) —— `/cache --breaks`：命中率从 90% 掉到 70% 时怎么发现
- [上下文与压缩](/use/context) —— 前缀为什么会变、`/compact` 与缓存的关系
- [术语表 · prompt cache](/ref/glossary#prompt-cache) —— 一段话讲清定义与"别拿一个数字套两族"
