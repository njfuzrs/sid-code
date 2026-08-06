---
title: Prompt Cache：两族协议的分叉，和 4.48 亿 token 的实测账
description: OpenAI 族没有分段缓存能力，这一个协议事实逼出了一个反直觉的做法——把动态内容搬出 system、挪到消息序列末尾。这篇从约束推到唯一解，再用 303 个会话 4.48 亿输入 token 的账本验证它，最后交出一个把自己骗过去的污染事故。
date: "2026-08-06"
series: 上下文工程
audience: engineer
highlight: 303 会话 · 4.48 亿输入 token · 整体命中率 66.0%
tags: [prompt cache, 成本优化, 机制解析, 实测]
---

# Prompt Cache：两族协议的分叉，和 4.48 亿 token 的实测账

同一套缓存策略，在 Anthropic 协议和 OpenAI 协议上必须写成两种形状。
不是风格差异——写错一边，一个字节的日期会把整段静态前缀作废。

原理一句话就说完：服务端认前缀，前缀没变就按折扣价重算
（完整定义见[术语表](/ref/glossary#prompt-cache)）。
难的全在"没变"这三个字——**它在两族协议里的含义不同，而这个差异会一直渗透到
你怎么摆放一条日期字符串**。

这篇从那个协议约束推到唯一解，再用实测账本验证推导，最后交出一次
让所有测试都保持绿色的数据污染事故。

::: tip 结论先放这里
- 两族的动态内容处置方式相反：Anthropic 族分段打断点、动态区留在 system；
  OpenAI 族无法分段，必须把动态区搬出 system、挪到消息序列末尾。
- 实测账本（2026-08-06，303 个会话 / 4.48 亿输入 token）：整体命中率 66.0%，
  anthropic 族 81.4%、openai 族 62.2%。
- `gpt-5.6-luna` 的 2.2% 不是漏采：同代码路径的 glm 对照组 188/207 次响应命中，
  luna 67/67 次响应都有该字段、值恒 0 —— 是网关后端不支持。
- 带归因判据的 418 条缓存中断里，416 条（99.5%）是"本地前缀 hash 未变而命中掉了"，
  本地不可控。
- 一个必须点破的口径缺陷：同一行账本里成本含影子调用、token 不含，
  两个数不同源、不能相除 —— 所以"缓存省了百分之多少钱"用现在的账本算不出来。
:::

## 约束：一个协议事实，不可协商

系统提示词里天然混着两类东西。静态的那部分是角色设定、工具规范、项目 `CLAUDE.md`，
一整场会话不变；动态的那部分是当前日期、`git status`、剩余 token 预算，每轮都在变。

它们混在一起时，动态那一小段决定静态那一大段能不能复用。
所以第一步是把两者切开——sid-code 用一个哨兵字面量做切分
（`DYNAMIC_BOUNDARY`，`src/api/cache-strategy.ts:74`），
`buildSystemBlocks` 与 `splitSystemByDynamicBoundary` 共用同一份切分口径。

切开之后怎么摆，取决于一个不可协商的协议事实：

| 项 | Anthropic 族 | OpenAI 族 |
| --- | --- | --- |
| 缓存粒度 | content block 级，显式打 `cache_control` | 从 token 0 起的整体前缀匹配 |
| 分段能力 | 有，上限 4 个断点 | **无** |
| `cacheCreationInputTokens` | 有值（写入单独计费） | 恒 0 |

（OpenAI 族在这个仓库里指经公司网关的 deepseek / glm / kimi / qwen 等后端。
断点上限见 `cache-strategy.ts:308`，写入恒 0 的依据见 `src/llm/openai.ts:79`。）

Anthropic 族给了分段能力，问题就退化成"把断点放对位置"。OpenAI 族没有，
这就逼出了一个不太直觉的做法。

## 推导：为什么 OpenAI 族必须把动态内容搬到消息末尾

直觉做法是把整段 system（含动态区）塞进 `messages[0]`。跟着约束推一步：

OpenAI 族是从 token 0 开始的严格前缀匹配。日期变一个字节，
`messages[0]` 内部的前缀就断了。而前缀一旦在第一条消息里断掉，
**其后全部历史消息即使一个字节都没变，本轮也全部无法复用**。

代价是具体的：一个 50 轮的会话，第 50 轮因为日期变了，把前 49 轮的历史全部按原价重算。

所以不是"我们选了"，是约束逼出了唯一解——静态区留在 `messages[0]`，
动态区搬到消息序列末尾，作为一条独立的 `<system-reminder>` user 消息
（`openai.ts:286` `prependSystemMessage`，函数上方的注释是这段设计的一手解释）。

一个实现细节值得单独说：这里是新增一条消息，不是改写已有的末尾消息。
因为 `convertMessages` 之后结尾未必是 user——可能是 assistant，也可能是 `role: "tool"`。
改写末尾等于赌结尾角色，赌错就是协议错误。

副作用一定有，写在后面的「张力」一节。

### Anthropic 族这一侧：四个断点，和一道预算断言

有分段能力的那一侧简单得多，只是要把四个断点放对，且流式与非流式各打一遍
（下表行号均在 `src/llm/anthropic.ts`）：

| 断点位置 | 流式 | 非流式 | 实现 |
| --- | --- | --- | --- |
| system 静态区尾 | `:211` | `:693` | `buildSystemBlocks` |
| system 动态区尾 | 同上 | 同上 | 同上（有边界才拆两块） |
| 工具数组最后一项 | `:220` | `:708` | `markLastToolCacheBreakpoint` |
| 最后一条 user 消息末块 | `:174` | `:696` | 手写倒序循环 |

四个是硬上限，超了服务端直接 400。所以发请求前有一道预算断言
（`cache-strategy.ts:314` `assertCacheBreakpointBudget`）：
非生产环境抛错把 bug 暴露出来，生产环境只打 error 不抛——
**遥测和护栏不该成为阻断主流程的新故障源**。

### 命中读数也有分叉

各家把"命中了多少"放在不同字段里，所以取值是一条三级兜底链
（`openai.ts:83` `extractOpenAICacheHit`）：

```text
prompt_cache_hit_tokens        ← DeepSeek 官方直连的顶层专有字段
  ↓
prompt_tokens_details          ← OpenAI 标准字段
  .cached_tokens                 （公司网关统一归一到这里）
  ↓
cached_tokens                 ← Kimi 官方直连的顶层扩展字段
```

顺序不是随便排的：Kimi 那个 `cached_tokens` 放在末位，
因为标准端点顶层没有这个字段，**放最后不会误伤其它家**。

## 验证：303 个会话，4.48 亿输入 token

推导对不对，实测说话。先说口径，否则数字没有意义：

- 数据源 `~/.sid-code/usage-ledger.jsonl`，指标为 `cacheHit / promptTotal`，
  2026-08-06 实测。
- 这个账本是每会话一行聚合，不是每次调用一行
  （`upsertUsageLedger` 按 `sessionId` 覆盖，`src/telemetry/usage-ledger.ts:85`）。
  所以"会话数"就是会话数，且每行的命中率已经把该会话的冷启动首轮混在里面——
  首轮必然无缓存可命中。
- 因此这批数字是**偏保守的下界，不是稳态命中率**。
- 下表按输入 token 降序取前 10。另有 4 个小样本组合未列
  （`claude-sonnet-4-6` 3 会话、`kimi-k2.6` 3 会话、`claude-opus-4-8` 1 会话、
  `origin-deepseek-v4-flash` 1 会话），合计 8 会话 / 129 万 token。

| provider / model | 会话数 | 命中率 | 输入 token |
| --- | --- | --- | --- |
| openai / glm-5.2 | 127 | 79.4% | 195,739,522 |
| openai / gpt-5.6-luna | 37 | 2.2% ⚠ | 85,980,014 |
| anthropic / claude-sonnet-5 | 3 | 82.2% | 84,439,779 |
| openai / deepseek-v4-pro | 48 | 94.4% | 32,925,960 |
| openai / origin-deepseek-v4-pro | 7 | 91.7% | 14,653,128 |
| openai / kimi-k3 | 17 | 76.1% | 12,628,450 |
| openai / ali-deepseek-v4-pro | 24 | 78.7% | 7,923,954 |
| openai / ali-deepseek-v4-flash | 22 | 70.7% | 5,859,280 |
| anthropic / claude-opus-5 | 4 | 73.8% | 5,257,306 |
| openai / gpt-5.4 | 6 | 6.3% ⚠ | 1,344,377 |

前 10 行 295 会话 / 4.4675 亿 token，加上未列的 8 会话 / 129 万，
合计 14 个组合、303 会话、4.48 亿输入 token，其中 2.96 亿命中，整体 66.0%。

两族分开看，`cacheWrite` 那一列恰好印证了前面的协议差异：

| 族 | 会话数 | 命中率 | cacheWrite |
| --- | --- | --- | --- |
| anthropic | 11 | 81.4% | 15,784,943 |
| openai | 292 | 62.2% | 0 |

::: details 复现命令（你跑出来的数会和这里不同）
`~/.sid-code/` 下的轨迹是滚动窗口，旧会话会被清理、新会话不断追加。
所以这份账本是某一天的切片，不是能被复现的固定值——
下面的命令能复现的是口径，不是数字。

实测就撞到过：两天前同一个脚本给出的是 294 会话，其中 `gpt-5.4` 是 18.4%，
现在是 303 会话、6.3%。数字没错，是窗口移动了。

```bash
bun -e '
const fs=require("fs");
const p=process.env.HOME+"/.sid-code/usage-ledger.jsonl";
const l=fs.readFileSync(p,"utf8").trim().split("\n").filter(Boolean)
  .map(x=>{try{return JSON.parse(x)}catch{return null}})
  .filter(Boolean);
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
:::

### gpt-5.6-luna 的 2.2%：是真没命中，不是漏采

这个数字第一眼像 bug，而且有个很有说服力的假设：会不会是这家后端的 usage 字段名
不在三级兜底链里，导致漏采——明明命中了，我们读成 0？

分辨这两者很要紧。如果是漏采，它属于度量缺陷；如果是真没命中，它属于后端能力边界。
两者的处置完全不同，所以不能猜。

判据是找一个走完全相同代码路径的对照组。`glm-5.2` 与 `gpt-5.6-luna` 同 provider、
同 base_url（同一个公司网关）、同一条兜底链。从 24 个会话的原始轨迹
（`raw.jsonl`，2026-08-06 实测）里统计两者的命中字段：

| model | 响应数 | 有该字段 | 命中 > 0 |
| --- | --- | --- | --- |
| glm-5.2 | 207 | 207 | 188 |
| origin-deepseek-v4-pro | 167 | 167 | 166 |
| gpt-5.6-luna | 67 | 67 | **0** |
| gpt-5.4 | 14 | 14 | 0 |

结论是确定的：字段一直都在（67/67 都有），只是值恒为 0。
漏采会让同一条代码路径上的所有模型表现一致，不会只对其中一个恒零。
所以这是该网关后端对 luna 不支持前缀缓存，不是采集缺陷。

`gpt-5.4` 的形态与 luna 一致（14/14 恒零），但样本量只有 luna 的五分之一，
账本里也只有 6 个会话。列为同源可疑，等更多样本再下结论。

## 反常项：99.5% 的缓存中断本地不可控

sid-code 有一个缓存中断检测器，命中率骤降时做归因并落盘
（`~/.sid-code/cache-breaks.jsonl`）。两个文件合计 650 条真实记录
（2026-06-29 → 2026-08-05，2026-08-06 统计）。

分母要先说清：650 条里只有 418 条带 hash 判据，另外 232 条是判据上线前写入的旧记录，
归因一律是"未知原因"，不参与下面这张表。

| 归因（418 条带判据的子集） | 条数 | 占比 |
| --- | --- | --- |
| 服务端缓存波动（本地前缀 hash 未变） | 416 | 99.5% |
| 模型变化 | 2 | 0.5% |

这个分布出乎意料，而且**它本身就是结论**：本地能优化的前缀断裂是零，
99.5% 的中断是本地前缀 hash 没变、命中却掉了——网关 TTL 过期或路由换了节点，
本地不可控。它直接改变了下一步该做什么：不必去找前缀断裂的 bug，
该做的是缓存退化监测。

这个"前缀 hash 变没变"的判据是关键（`src/api/cache-detection.ts:262-268`）：
hash 变了才说明是本地 prompt 前缀断裂，是我们的问题、可以优化；
hash 没变而命中掉了，只能归给服务端。没有这个字段，所有中断都会被笼统记成
"未知原因"，看着像有一堆待修的 bug——上面那 232 条旧记录就是这个样子。

## 一次让所有测试都保持绿色的污染事故

采集上面那份归因分布时，第一次统计的结果是清一色"System prompt 变化"，
时间戳全部显示 2023-11-15。

`cache-breaks.jsonl` 当时 3929 行，其中 3889 行是假数据（`ts: 1700000000`
这种测试固定值），真实记录只剩 40 行。轮转文件 `.1` 里 60701 行，假的 60109 行。
而 `/cache --history` 读尾部 20 条做明细、尾部 500 条做聚合——
两个窗口里一条真记录都取不到。

根因是 `recordCacheBreak()` 除了推内存环形缓冲，还会同步落盘遥测
（`cache-detection.ts:427`），而两个单测直接调了它，
却没设项目早就提供好的隔离环境变量 `SID_CODE_CACHE_BREAKS`。
每跑一次 `bun test` 就往真实文件灌 78 行。

三个条件叠加让它成了静默故障：

1. 落盘是 fire-and-forget 且吞异常——写错位置不会有任何提示；
2. 测试断言的是内存缓冲，落盘那一路不在断言范围内——**测试全绿也说明不了落盘去了哪**；
3. 10MB 才轮转——污染先静静堆积，堆满一轮 rename 成 `.1`，
   看起来像"正常有历史数据"。

值得记的不是这两个文件，而是判据：

> 只要一个函数除了返回值还有「写用户家目录」这种进程外副作用，
> 调它的测试就必须显式隔离；而"必须记得隔离"这件事不能只靠人记住。

所以补隔离之外还加了一道门禁（`tests/telemetry/no-real-path-writes.test.ts`）：
静态扫描 `tests/` 下所有 import 了落盘类导出的文件，没声明隔离就让 CI 变红。

门禁自己也得验。只验"加了门禁后是绿的"不够——那条门禁可能压根没在检查东西。
反向验证的做法是故意去掉一个文件的隔离，确认它会红并点名那个文件。
门禁里还留了护栏：扫到的文件数必须 > 100（`no-real-path-writes.test.ts:89`），
否则正则漂移导致"一个都没扫到"时，它会静默变成永远通过的绿灯。

顺带一个反直觉的实现细节：落盘走的是 `import().then()`（`cache-detection.ts:451`），
是待处理微任务。`afterAll` 里同步恢复环境变量会与那个待处理的写赛跑，
让最后几条漏写到真实路径。得先 `await new Promise(r => setTimeout(r, 0))`
让微任务队列跑干。

### 两个 bug 互相打掩护

清理完假数据，`/cache --history` 的聚合视图仍然不对：500 条记录里 499 条落在 `unknown`。

原因是 `summarizeCacheBreakHistory`（`src/telemetry/cache-telemetry.ts:162`）
的分类分支是照"模型变化 / 工具变化 / TTL"这些归因写的，
而后来新增的两条前缀 hash 归因——就是上一节那个关键判据——没有对应分支，
全部掉进兜底的 `unknown`。

这个 bug 存在期间没人发现，恰恰是因为假数据长期霸占读取窗口：
假数据的归因是"System prompt 变化"，有分支、能正确分类。
**污染掩盖了聚合缺陷**，两个 bug 互相打掩护。

补分支之后（`cache-telemetry.ts:184-185`）`unknown` 从 499 降到 0。
同时加了一个对账测试：不手抄归因文案常量，而是让真实检测器产出归因再喂给聚合器。
手抄两份必然漂移——这个仓库已经因为"测试手抄生产逻辑"吃过一次全绿的假安全。

### 顺带推翻一个我们自己的旧诊断

当初的判断是"deepseek 经公司网关完全没有 prompt cache"。实测否证：
44 个修复前的多轮会话，平均命中率（第 2 轮起）已经是 75%——
网关本来就透传 OpenAI 协议的 prompt cache。

真正的问题不是"没有缓存"，而是"静态前缀被动态内容整体打断"。
修复的价值也不是"从 0 到有"，而是让静态前缀在动态内容变化时不被连带作废：
受控测试里（turn 间真实修改 `git status`）命中率沿 0% → 46.6% → 83.2% 逐轮爬升。

顺便说清一个口径差异，避免读者拿这里的数字对不上别处：
`83.2%` 是单个受控会话内逐轮爬升的终点，而上面账本里 deepseek 的 `94.4%`
是跨 48 个会话的聚合。两个数字都对，量的不是同一件事。

## 张力：JIT 上下文与 prompt cache 互相拉扯

现在回到推导留下的那个副作用。

[JIT 上下文](/blog/jit-context)那篇讲的按需注入——工具访问了
`src/ui/components/Footer.tsx`，就把 `src/ui/CLAUDE.md` 注入进去——
和 prompt cache 有直接冲突。

因为 OpenAI 族的动态区在消息序列末尾，而 JIT 注入正是往那个位置追加内容。
每次 JIT 注入都改写这条消息，该位置之后的前缀本轮断裂。
Anthropic 族因为有分段断点，受影响小得多。所以"JIT 注入是安全的"这个说法
**只对 Anthropic 族完整成立**——而 deepseek / glm 才是这个仓库的主力。

还有一点让它更麻烦：JIT 的已加载集合只加不减，没有淘汰、没有作用域退出时的移除。
每注入一份，末尾那条消息就永久变大，之后每一轮都携带全量。
所以治理重点不是"单份规则多大"，而是累积总量。

这是个真实的 trade-off，不是可以两全的：更精准的上下文注入天然伤缓存命中率。
把它写出来比假装没有更有用。

## 当前的能力边界

照实写没做到的部分。

**1. 同一行账本里，成本和 token 不是同一个 population。**
这是本轮排查最要紧的一条，也解释了项目自己说的"影子调用绕过埋点"到底指什么。

账本每一行的字段有两条不同的来源（`src/app.ts:4917` `buildLedgerEntry`）：

- `promptTotal` / `cacheHit` / `cacheWrite` 来自 `sessionState.updateUsage()`，
  全仓只有两个调用点——主循环（`src/query/loop.ts:2452`）和子代理 sink
  （`app.ts:1105`）。
- `costUSD` 来自 `getEffectiveTotalCostUSD()`，它是 `totalCostUSD + sideCostUSD`
  （`src/session/state.ts:329`）。而 `sideCostUSD` 由 `recordSideCall()` 累加
  （`state.ts:263`），调用方遍布 13 个模块：auto-compact、partial-compact、
  context-collapse、memory/recall、bash-classifier、tool-classifier、
  goal/evaluator、hook/runner、session/warmup 等。

也就是说，这些辅助调用的「钱」进了账本、「token」没进。后果是这一行里的命中率
分母不含影子调用的 token，而成本分子含影子调用的钱——两个数不同源，不能相除。
所以"缓存帮我省了百分之多少成本"这个问题，用现在的账本算不出来。

绕法：要谈成本就只看 `costUSD` 的绝对值，要谈缓存效果就只看 `cacheHit / promptTotal`，
两者之间不做除法。账本里那个 `savingsUSD` 字段（按未命中原价与实付价的差额估算）
同样只能当量级参考：303 个会话合计 251.79 美元，但其中 81 个会话该字段为 0——
四分之一的样本没有有效值，均值没有意义。

**2. 缓存与延迟的关系没测。** 这条要说准确：TTFT 本身是有埋点的——
`src/llm/stream-lifecycle.ts` 在 lifecycle 层统一 emit `first_content`，
`bun scripts/trace-digest.ts --health` 直接打得出 TTFT 分位数。

缺的是这两件事之间的因果：没有"命中 / 未命中"分组的 TTFT 对照，
所以"缓存让首字快了多少"仍然没数。也没有端到端耗时（用户回车 → 最终答复）的
独立埋点。这篇通篇讲的是"省"，不是"快"——但原因是没做对照实验，不是没有基线。
绕法暂无；失效方向是安全的，缺的只是一个我们还没建的对照维度。

**3. `gpt-5.4` 的 6.3% 没查清。** 原始轨迹里 14 个响应全部恒零，形态与 luna 一致，
但样本量不足以像 luna 那样下结论。绕法：把它当"疑似不支持缓存"对待，
成本敏感的长会话别选它。

**4. Anthropic 族样本太少。** 11 个会话，其中 sonnet-5 只有 3 个。
81.4% 这个数字的置信度远低于 openai 族的 292 个会话。绕法：
把两族的数字当两个独立量看，别拿一个去校准另一个。

**5. 一处可收口的技术债。** Anthropic 族"最后一条 user 消息打断点"走的是手写倒序循环，
流式（`anthropic.ts:174`）与非流式（`:696`）各写了一遍，都没走 `cache-strategy.ts:234`
里现成的 `addMessageCacheBreakpoint`——实测那个函数在生产 provider 路径上一次都没被调用。
功能上没错，但同一件事三种写法，改断点策略时容易只改一处。

**6. 没有对标对象。** claude-code 的遥测上报到服务端，本地不落这类明细文件。
这是"数据全部自主"这个方向自带的成本：数据在本地，
就得自己管好测试与真实数据的边界——上面那次污染就是这个成本的账单。

## 一句话

prompt cache 的机制不难。难的是它的正确性依赖你对协议差异的准确理解，
而验证它需要真实数据——**而真实数据这条链，比想象中更容易被自己的测试污染，
且污染时所有测试都是绿的**。

## 相关

- [成本与用量](/use/cost) —— 自己的命中率怎么看，以及
  [两族协议的正常值](/use/cost#缓存命中率-两族协议的正常值不同)分别是多少
- [缓存退化监测](/use/cost#breaks-缓存退化监测) —— `/cache --breaks`：
  既然 99.5% 的中断是服务端波动，那就只能靠监测发现命中率从 90% 掉到 70%
- [上下文与压缩](/use/context) —— 前缀为什么会变、`/compact` 与缓存的关系
- [JIT 上下文](/blog/jit-context) —— 与本篇拉扯的另一头：按需注入的实测基线，
  以及它为什么恰好落在伤缓存的那个位置
