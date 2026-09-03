---
title: 'Agent Runtime（01）· Agentic Loop：主循环里到底发生了什么'
description: '「agent 就是一个 while 循环」这句话没错，但真实实现会长到五千行。这篇从一次 HTTP POST 讲起，把循环凭什么停、状态怎么在迭代之间传、那五千行在处理什么逐层拆开。'
date: "2026-09-03"
series: Agent Runtime 从零到一
tags: [Agent 架构, 主循环, 从零到一]
outline: [2, 3]
---

# Agentic Loop 从零到一：一个 coding agent 的主循环里到底发生了什么

::: info 这是一份快照
本文的数字、常量、行数取自 **2026-08-29** 对 sid-code 源码的一次实读。
代码在动，这些数字会腐坏——引用其中任何一个之前，请按文中给出的命令在你自己的仓库里复跑一次。
:::

> **这份文档写给谁**
>
> 你会调 LLM API，也大概知道「agent 就是一个 while 循环」这句话。但你没写过、也没读过
> 一个真在生产里跑的主循环。你想搞懂：这个循环凭什么停、状态怎么在迭代之间传、
> 为什么真实实现会长到五千行、这五千行到底在处理什么，以及面试问到
> 「你们的 agent loop 怎么设计的」时该答什么。
>
> **和同目录另一份文档的关系**：`Agent循环与流式传输的关系.md` 是**调研结论**
> （回答一个具体问题：loop / SSE / 打断三者什么关系）。这一份是**教学版**：
> 从「一次 HTTP POST」讲起，每个机制先讲「不做它会怎样」，再讲「它长什么样」，
> 最后才讲「谁做得好、代价是什么」。
>
> **本文的事实来源**
> - sid-code 侧：2026-08-29 实读 `packages/core/src/query/`（18754 行，排除 `*.test.ts`；
>   其中 `loop.ts` 5097 行）+ `packages/core/src/agent/agentic-loop.ts`（1080 行）
>   + `packages/core/src/config/network-profile.ts`。凡本文出现的常量、阈值、事件名，
>   都是这次实读所得，且给了 `文件:行号` 或可复跑命令。
> - Claude Code 侧：沿用 `ai-agent-inter/04-源码实战/Agentic-Loop/01-Study-Source-Agentic-Loop.md`
>   的实读口径（记于 2026-06-26，源码版本为当时本地版），凡引用均标注「CC 口径（2026-06）」。
>   ⚠️ **那份文档写于两个月前，CC 已迭代过**——本文引用它的结构性洞察（为什么这么设计），
>   不引用它的行号。
> - 行数口径一律：
>   `find <dir> -name '*.ts' -not -name '*.test.ts' | xargs wc -l | tail -1`
>
> **一条阅读警告**：本文里所有数字（阈值、行数、次数）都会腐坏。
> 引用到任何一个之前，请按附录 C 的命令复跑一次。文档里有一处**现场实例**
> 演示了这种腐坏（见 §8.2 的 stream-processor 注释），刻意留着没修，因为它比讲道理有用。

---

## 目录

| 章 | 内容 | 你会得到什么 |
| --- | --- | --- |
| [0](#0) | 最小心智模型：循环是什么，为什么必须是循环 | 能手写一个 30 行的能跑的 loop |
| [1](#1) | 第一个认知陷阱：API 无状态，SSE 不是对话 | 讲清 loop / HTTP / SSE 三层关系 |
| [2](#2) | 循环凭什么停：`stop_reason` 为什么不可靠 | 三种停止判据 + 两个兜底 |
| [3](#3) | 状态：为什么必须是一个显式对象 | 状态机模式 + 可测试性设计 |
| [4](#4) | ★ continue 的十五种理由 | **本文架构核心** |
| [5](#5) | `end_turn` 不是终点：四道闸门 | 「说完了」和「做完了」的区别 |
| [6](#6) | 工具执行：并发、保序、抢跑 | 三种编排策略 + 一个死接线现场 |
| [7](#7) | 上下文：O(N²) 与渐进式压缩管道 | 五层管道 + 熔断器 + 假压缩事故 |
| [8](#8) | 韧性：超时阶梯 / 重试 / 看门狗 | 六层阶梯为什么必须严格递增 |
| [9](#9) | 空转与死循环：为什么检测默认关闭 | 三道阀 + 一个用数据推翻自己的例子 |
| [10](#10) | 可观测：怎么证明这个循环是好的 | 四个锚点事件 + 口径陷阱 |
| [12](#12) | 动手：从零实现一个 mini loop | 六阶段路线图 |
| [附](#appendix) | 术语表 / 自检清单 / 可复跑命令 | 查漏 |

**建议读法**：第一遍只读 §0–§2 和 §11 的 L1 档，先建立骨架；第二遍读 §4–§7，
那是真正的工程内容；§8–§10 是「怎么不让它坏、怎么知道它没坏」，面试时最容易问出深度。

---
<a id="0"></a>
## 0. 最小心智模型：循环是什么，为什么必须是循环

### 0.1 先看「不循环」会怎样

假设你要让模型帮你「看看 `config.ts` 里的端口号是多少」。不循环的做法是一次调用：

```
你 → 模型：config.ts 里的端口号是多少？
模型 → 你：我不知道，我看不到你的文件。
```

模型没有手。它只能生成文本。所以要让它「做事」，必须给它一套**约定**：
它可以在回复里写「我要调用 read 工具，参数是 config.ts」，然后**你**去读文件，
把内容告诉它，它再继续。

这就是循环的来源——**不是为了「多想几步」，而是因为模型的每一次「动手」都需要
外部世界替它执行，而执行结果只能通过下一次调用送回去。**

一次最小的完整往返：

```
第 1 次调用  你 → 模型：[问题] + [可用工具清单]
             模型 → 你：tool_use(read, "config.ts")        ← 它想动手
             ──── 你执行：读文件，拿到内容 ────
第 2 次调用  你 → 模型：[问题] + [工具清单] + [它刚才的 tool_use] + [tool_result: 文件内容]
             模型 → 你：「端口是 3000」                     ← 纯文本，不再动手
             ──── 循环结束 ────
```

**判据就一句话：模型这次回复里还有没有「要动手」的意图。有就继续，没有就停。**

### 0.2 三十行能跑的版本

把上面那段写成代码，就是 agentic loop 的全部骨架：

```javascript
let messages = [{ role: "user", content: "config.ts 里的端口号是多少？" }];

while (true) {
  // ① 把「完整历史」发出去 —— 注意是完整，不是增量
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: MODEL, messages, tools, max_tokens: 8192 }),
  });
  const reply = await res.json();

  // ② 无论如何，先把模型的回复追加进历史
  messages.push({ role: "assistant", content: reply.content });

  // ③ 找出它想调的工具
  const toolUses = reply.content.filter((b) => b.type === "tool_use");
  if (toolUses.length === 0) break;              // ← 唯一的停止判据

  // ④ 替它执行，结果作为 user 消息追加回去
  const results = [];
  for (const tu of toolUses) {
    const out = await runTool(tu.name, tu.input);
    results.push({ type: "tool_result", tool_use_id: tu.id, content: out });
  }
  messages.push({ role: "user", content: results });
  // ⑤ 回到 ①
}
```

**这三十行是真的能跑的**，不是伪代码。sid-code 五千行的 `loop.ts` 和它的关系，
就像一辆量产车和一个「四个轮子加一个发动机」的关系——骨架一模一样，
剩下的 99% 在处理「路上会出什么事」。

有三个细节现在就要点破，它们是后面所有章节的根：

1. **`tool_result` 的 role 是 `user`，不是什么 `tool`。** 在 Anthropic 协议里，
   工具结果是「用户」把观测送回给模型。（OpenAI 协议里确实有独立的 `tool` role，
   这是两族的一处结构差异。）
2. **每个 `tool_use` 必须有一个对应的 `tool_result`，一个都不能少。** 少一个，
   下次请求就是 400。这条在 §6.4 会展开——它是生产里最常见的一类崩溃。
3. **第 ② 步在第 ③ 步之前。** 先无条件把回复入历史，再判断要不要继续。
   顺序反了，某些异常路径下模型的 `tool_use` 会进不了历史，而 `tool_result` 进了，
   于是产生一个「无主的结果」，同样 400。

### 0.3 「一轮」这个词有三种含义，别混

这是初学者最容易糊的地方，也是面试里一问就露的地方：

| 说法 | 指什么 | 一个任务里有几个 |
| --- | --- | --- |
| 一次**对话轮**（conversation turn） | 用户说一句话 → agent 干完活给出最终答复 | 用户说几句就有几个 |
| 一次**循环迭代**（loop iteration / step） | 一次 `while` 循环体 = 一次 API 调用 + 一批工具执行 | 一个对话轮里可能几十次 |
| 一次**API 调用**（request） | 一次 HTTP POST | 通常 = 迭代数，但重试会让它更多 |

sid-code 里这三个概念各有各的计数器，且**刻意不共用**：

- `LoopState.turnCount` —— 循环迭代数，**每条用户消息归零**
  （`packages/core/src/query/loop.ts:751` 的 `while (state.turnCount < state.maxTurns)`）
- `sessionState.getAbsoluteTurn()` —— 跨用户消息的会话累计轮次
- SDK 侧的 `num_turns` —— 只在真的拿到 assistant 回复时才 `++`

**这三个数不等价，而且它们不等价的那个缝隙里藏过一个真实缺陷**，见 §8.5。
先记住：谁在数什么，必须说得出来。

### 0.4 为什么这件事叫「harness」

模型是发动机，循环是传动系统，而「传动系统 + 底盘 + 安全带 + 仪表盘」这一整套叫
**harness**（挽具）。业界的共识（CC 口径 2026-06 引 Victor Dibia）是一句很扎人的话：

> Agent loop 占代码库不到 1%，另外 99% 让它活着。

sid-code 这边的对应数字：`packages/core/src/query/` 全部 18754 行，
而 §0.2 那个骨架是 30 行。**比例 1:625。**

**这个比例本身就是本文的论点**：如果你面试时只答得出那 30 行，你答的是「概念」；
面试官想听的是那 625 倍里你踩过哪些。

### 0.5 本章自检

能回答这三个问题再往下：

1. 为什么 `tool_result` 必须作为 `user` 消息而不是 `assistant` 消息追加？
   （提示：想想「谁在向谁提供信息」）
2. 如果把 §0.2 里第 ② 步和第 ③ 步交换顺序，什么场景下会出错？
3. 「这个任务跑了 40 轮」这句话有歧义。三种「轮」里，说成本时该用哪个？说延迟时该用哪个？

---
<a id="1"></a>
## 1. 第一个认知陷阱：API 是无状态的，SSE 不是对话

这一章要拆掉一个几乎人人都有的错觉。这个错觉不拆掉，后面讲成本、讲缓存、讲打断恢复
全都会理解错。

### 1.1 错觉长什么样

大多数人第一次想象 agent 时，脑子里的图是这样的：

```
❌ 错的图
你 ──── 建立一个长连接 ────► 模型
    ←─── 模型持续吐字，中间它记着我们聊过什么 ───
```

这张图有两处错：**没有长连接，模型也不记得任何事。**

### 1.2 正确的图：三层，互相正交

```
✅ 对的图

┌─ Agent Loop（应用层，你的代码）─────────────────────────────┐
│  messages[] 这个数组就是全部状态，它在你的内存/磁盘里         │
│                                                            │
│  ┌ 第 1 次迭代 ────────────────────────────────────────┐   │
│  │  ┌ HTTP POST（传输层，一次请求）─────────────────┐  │   │
│  │  │  发出：完整 messages[]                        │  │   │
│  │  │  收回：SSE 流（一个个 chunk 吐回来）           │  │   │
│  │  │  ★ 响应结束 → 连接关闭                        │  │   │
│  │  └──────────────────────────────────────────────┘  │   │
│  │  执行工具，把结果 push 进 messages[]                 │   │
│  └────────────────────────────────────────────────────┘   │
│                                                            │
│  ┌ 第 2 次迭代 ─── 一个全新的 HTTP 请求，全新的 SSE 流 ──┐  │
│  │  发出：完整 messages[]（现在多了两条）                │  │
│  └────────────────────────────────────────────────────┘   │
│  ... 直到模型不再要求动手 ...                                │
└────────────────────────────────────────────────────────────┘
```

三句话说清三层：

- **Agent Loop 是应用层**：跨多次 HTTP 请求，管「任务做完了没有」。
- **HTTP POST 是传输层**：一次请求一次响应，请求结束连接就关。
- **SSE 是单次响应内部的传输方式**：让 token 一个个流回来，而不是等全部生成完。
  它**只解决「这一次回复别让用户干等」**，跟「保持对话」毫无关系。

| | SSE | Agent Loop |
| --- | --- | --- |
| 层级 | 传输层，单次请求内 | 应用层，跨多次请求 |
| 作用 | 流式吐 token，改善体感 | 多步任务编排 |
| 状态 | 无状态，用完即断 | 客户端自己维护 `messages[]` |
| 生命周期 | 1 次 API 调用 = 1 条 SSE 流 | 1 个任务 = N 次 API 调用 |

**一句话**：agent loop 是 N 次独立 HTTP 请求，每次请求内部用 SSE 流式返回。
两者正交——一个管传输体验，一个管任务编排。

### 1.3 「模型的记忆」是你伪造出来的假象

模型每次看到的，就是你这次传过去的那个数组，**从头读一遍再回答**。它上一次说过什么，
它自己不知道；它知道，只是因为你把它上次说的话又传了一遍。

这条推论极其重要，因为它直接决定了三件事：

1. **成本是 O(N²) 的**（下一节）。
2. **「恢复」不需要任何 API 支持**（§1.5）。
3. **上下文窗口是硬约束，而且是循环特有的**（§7）。

### 1.4 O(N²)：为什么长任务贵得离谱

因为每次都要带全部历史：

```
第 1 次调用：发送 X
第 2 次调用：发送 X + (tool_use₁ + tool_result₁)
第 3 次调用：发送 X + (tu₁+tr₁) + (tu₂+tr₂)
...
第 N 次调用：发送前面所有累积的一切
```

累计输入 token ≈ O(N²)。这条有一个非常反直觉的推论，是 CLAUDE.md 里明写的：

> **会话长度是成本最大的杠杆：2× 轮数 ≈ 3–4× 成本。**
> 后段每一轮都更贵——第 N 轮的 input ≈ N × 第 1 轮的 input。

**所以「让 agent 少跑几轮」比「换个便宜模型」对成本的影响大得多。**
这也解释了为什么 §9 那些「空转检测」不只是体验问题——空转的每一轮都在按 N 的量级付钱。

四种对冲手段（每一种后面都有专门章节）：

| 手段 | 做什么 | 本文位置 |
| --- | --- | --- |
| Prompt Cache | 相同前缀不重复计费（Anthropic 折扣约 90%） | §1.6 |
| 上下文压缩 | 逼近窗口上限时压缩/摘要早期历史 | §7 |
| 工具输出截断 | 控制单次工具返回量，减缓上下文膨胀 | §7.3 |
| 子 agent 隔离 | 复杂子任务丢给独立 agent，各自干净窗口 | §6.6 |

### 1.5 打断与恢复：没有 resume API，因为不需要

既然状态全在你手上，那么：

- **打断** = `AbortController.abort()`，直接断掉这次 HTTP 连接。服务端察觉连接断开就停止生成。
  **没有「暂停」API。**
- **恢复** = 拿着你保存的 `messages[]`，再发一次请求。**没有「resume」API。**

对模型来说，「恢复后的第一次调用」和「正常的下一次迭代」**没有任何区别**——
它看到的都只是一个消息数组。它不知道中间有人按过 ESC。

打断的三种时机，处置各不相同（这是实现层真正要做决定的地方）：

| 打断时机 | 问题 | sid-code 的选择 |
| --- | --- | --- |
| 模型正在吐文本 | 已收到的半截文本要不要留 | **留**。实时累积在 `AccumulatedResponse` 里，截断的 assistant 消息入历史 |
| `tool_use` 已返回但还没执行 | 留着就是孤儿（§0.2 第 2 条） | **补一条 `tool_result`：「用户取消了此操作」**，`is_error: true` |
| 工具正在执行（如长 shell） | 部分输出算不算结果 | 杀子进程，**把已有部分输出当作 `tool_result` 返回**（部分结果也是信息） |

第二行是重点：**打断必须补齐 `tool_result`，否则下次请求 400。**
「用户按了 ESC」和「协议完整性」是两件事，前者不能破坏后者。

### 1.6 一个漂亮的连带效果：loop 天生对 prompt cache 友好

看相邻两次调用的消息前缀：

```
第 N   次：[m₁, m₂, ..., m_{N-1}, m_N]
第 N+1 次：[m₁, m₂, ..., m_{N-1}, m_N, m_{N+1}]
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^  完全相同 → 可命中缓存
```

**agent loop 的相邻两次调用只在末尾追加，前缀天然完全一致。** 这是 prompt cache
在 agent 场景下效果极好的结构性原因（普通聊天场景反而更容易因为改写历史而破缓存）。

但这个礼物有一条极其苛刻的前提：

> **前缀必须逐字节一致。一个字节都不能变。**

这条前提会跟 §7 的上下文压缩**正面冲突**——压缩就是在改历史，改了历史就破缓存。
sid-code 为此写了两套 microcompact 模式（§7.5），这是全文最典型的一处
「为了省 90% 的钱，值得多写几百行代码」。

### 1.7 五个常见误解，逐个澄清

| 误解 | 为什么错 |
| --- | --- |
| 「只调一次 API，然后靠 SSE 保持连续对话」 | SSE 是单次请求的响应传输方式，响应结束即断 |
| 「模型能记住之前的对话」 | 模型无状态。记忆是你每次重传历史伪造的假象 |
| 「打断后需要 resume API 恢复」 | 没有 resume。打断=断连接，恢复=带历史重发 |
| 「SSE 断了，已生成的内容就丢了」 | 取决于你有没有实时累积。累积了就都在，只丢「还没生成的」 |
| 「WebSocket 更适合 agent，因为要双向」 | loop 不需要在流中间向服务端发消息；打断是关连接而非发消息 |

### 1.8 本章自检

1. 为什么说「agent loop 天然对 prompt cache 友好」是一个**结构性**优势，而不是运气？
2. 用户按 ESC 时，模型刚返回了 3 个 `tool_use` 但一个都没执行。你必须做什么，为什么？
3. 有人说「我们的 agent 用 WebSocket，所以延迟更低」。这句话的问题在哪？

---
<a id="2"></a>
## 2. 循环凭什么停：`stop_reason` 为什么不可靠

现在骨架有了，开始讲工程。第一个真问题：**你凭什么判断这一轮该继续还是该停？**

### 2.1 教科书答案，以及它为什么是错的

几乎所有教程都会告诉你：

```javascript
while (response.stop_reason === "tool_use") { ... }   // ❌
```

这个判据在生产里会坏，原因有两层。

**第一层（CC 口径 2026-06）**：CC 的源码注释直说 `stop_reason === 'tool_use'`
「不总是被正确设置」。所以 CC 的真实判据不是看 `stop_reason`，而是
**看 response 的 content 里有没有 `tool_use` 块**。

**第二层（sid-code 实测，更值得记）**：接经过网关转发的模型时，
`stop_reason` 会出现和 content **自相矛盾**的情况——声称 `end_turn`，
content 里却明明躺着一个没执行的 `tool_use`。

sid-code 为这个形态专门写了一条兜底，代码里叫 **F2**
（`packages/core/src/query/loop.ts:3376` 起，注释原文）：

> F2：end_turn 兜底——模型有时 `stop_reason=end_turn` 却在 content 里留下正常参数的 `tool_use`。

进入条件（`loop.ts:3399`）：

```typescript
response.stopReason === "end_turn" ||
response.stopReason === "stop" ||
response.stopReason === "stop_sequence";
```

命中后会记一条告警（`loop.ts:3410`，原文）：

> `stop_reason 与 content 不一致：声称 end_turn/stop 但含 tool_use（疑似代理协议偏差，已自动兜底执行工具）`

**这里有一个判据设计的通用教训，源码注释里写得比我清楚**（`loop.ts:3391`）：

> 不要改成"排除已知的错误情况"——后者每新增一种未识别的错误 `stopReason` 都会重新
> 命中这个分支。

也就是说：**F2 用的是白名单（只有这三个值才进），不是黑名单（排除已知错误值）。**
白名单在遇到未知值时的行为是「不进」，黑名单是「进」。
对一个兜底分支来说，「遇到没见过的东西就别自作聪明」才是安全的。

> **这条可以直接迁移**：凡是写「异常兜底分支」，判据用白名单。
> 黑名单会随着世界变复杂而自动扩大覆盖面，且扩大得静默无声。

### 2.2 于是真实的停止判据是三层

```
① 主判据：content 里有没有未执行的 tool_use
      有 → 执行 → continue
② 兜底 F2：stop_reason 说 end_turn，但 content 里有 tool_use
      → 仍然执行（并记告警）
③ 反向兜底 F1：content 里有 tool_use，但参数是空的 {}
      → 这不是「要动手」，是模型退化了 → 不执行，重试
```

第三条（F1）是个很妙的例子，值得展开。

### 2.3 F1：`input={}` 既不是「要动手」也不是「说完了」

sid-code 的 `empty-param.ts` 顶部注释（实读原文）：

> 根因（已确证）：DeepSeek v4-pro 在大上下文（~80k input tokens）场景下，
> 生成 tool_use 声明但对参数填空（`input={}`），并以 `stop_reason=end_turn` 自行停止。
> 系统若不干预，会走到 loop.ts 的 end_turn 分支直接退出，**永不重试 → 任务卡死**。

这个形态很阴：它同时骗过了两条判据——`stop_reason` 说结束，content 里的 `tool_use`
看起来像要动手，但那个 `tool_use` 什么也做不了。

**但修复它的第一版引入了一个更严重的 bug**，这才是最值得学的部分（同文件注释原文）：

> ⚠️ 误杀防护（2026-06-10）：`enter_plan_mode` / `cron_list` 这类工具的 inputSchema
> 本就是 `{ type:"object", properties:{} }`（无必填参数），`input={}` 是它们**唯一合法状态**。
> 旧实现对任何 `{}` 都判退化，导致 `enter_plan_mode` 的合法调用被反复作废、
> plan mode 永远进不去（会话 b168a817 死循环根因）。

**修法是把判据从「input 是不是空」换成「schema 有没有必填参数而 input 却空」**：

```
❌ input === {}                              → 判退化   （误杀无参工具）
✅ toolHasRequiredParams(schema) && input==={} → 判退化   （正确）
```

> **通用教训：「异常」的定义必须包含「相对于什么才算异常」。**
> `{}` 本身不是异常，`{}` 相对于「有必填参数的 schema」才是异常。
> 少了后半句，防线自己变成了故障源。

还有第二个坑，同样值得记（`empty-param.ts` 注释原文）：

> 把 `tool_use` 块替换为 `text` 块，消除孤儿：**本轮一旦有退化命中，同一 content 里的
> 所有 tool_use 一并降为 text**。因为 F1 分支替换后即 `continue` 重开一轮，
> 被"保留"的健康 `tool_use` 永不执行 → 必成孤儿（2026-08-04 事故第二根因）。

这是 §0.2 第 2 条那个协议约束的一次真实发作：你以为你在「只处理坏的那个，保留好的」，
实际上因为要 `continue`，那些「好的」也永远不会被执行，于是全都变成孤儿。

**只要一条路径要 `continue`，这一轮的 `tool_use` 就必须整批处理，不能挑。**

重试策略也不是简单重发（同文件注释原文）：

> 每次重试前先压缩上下文（`reactiveCompact`），让 input tokens 单调下降，
> 直接打击"大上下文"这个根因——而非原样追加提示重发（后者只会让上下文更饱和，加剧退化）。

**这是「针对根因重试」而不是「针对症状重试」的一个漂亮实例。** 上限
`MAX_EMPTY_PARAM_RETRIES = 3`（`empty-param.ts:31`）。

### 2.4 完整的 `stopReason` 分支表（sid-code 实测）

`loop.ts` 处理的远不止两种。实读的完整分支（含行号）：

| `stopReason` | 行号 | 处置 |
| --- | --- | --- |
| `tool_use` | 3919 | 执行工具 → continue（正常路径） |
| `end_turn` / `stop` / `stop_sequence` | 3399 | 走四道闸门（§5）；若含 `tool_use` 则 F2 兜底执行 |
| `max_tokens` / `length` | 4531 | 递减收益检测 → 让手 or 续写 |
| `refusal` | 4650 | 安全拒答 → 收尾 |
| `model_context_window_exceeded` | 4671 | 上下文溢出 → 压缩后重试 |
| `pause_turn` | 4715 | 长任务中途暂停 → continue |
| `null` 且 content 为空 | 4724 | **「伪装成功的空流」** → 中断本轮 |
| 其他未识别值 | 4750 | 记 warn，给用户一条「可重新发送继续」的提示 |

最后两行是本表最值得看的两行。

**`stopReason=null` + 空 content** 的形态（`loop.ts:4733` 原文）：

> 空响应且停止原因异常（stopReason=null），判定为伪装成功的空流，本轮中断

「伪装成功」这个词用得很准：HTTP 200、SSE 正常关闭、没有任何异常抛出，
**唯一的问题是什么内容都没有**。如果没有这个分支，它会一路穿透上面所有停止原因分支，
落到「模型说完了」的路径上——于是一个网络故障被报告成「任务完成」。

还有一条排查留痕（`loop.ts:4747` 原文）：

> `stopReason=null` 且**有内容**的典型场景是"截断流"（代理 delta 后直接断流）

同一个 `null`，有内容和没内容是两种不同的故障，修法也不同。
**能把一个值按邻近字段拆成两种故障，说明埋点设计对了。**

### 2.5 一个必须知道的架构事实：`yield done` 有 22 个出口

实测（命令见附录 C）：

```bash
grep -c 'kind: "done"' packages/core/src/query/loop.ts
# → 22
```

**22 个正常退出点。** 这个数字本身就是本章的结论：「循环什么时候停」不是一个
`while` 条件能表达的东西，它是二十多个业务判断的并集。

这直接带来一个工程问题：任何「每轮结束必须做一次」的事（发遥测、清资源、算耗时），
如果靠在每个出口各写一遍，必然会漏。sid-code 的解法是幂等位 + `finally` 兜底
（`types.ts` 的 `turnCompleteEmitted` 注释原文）：

> queryLoop 有 20+ 个 `yield done; return` 出口，再加 finally 兜底 ——
> 不做幂等必然重复计数。

**「20+ 个出口」和「幂等位」是同一个事实的两面。** 面试里这是一个很好的信号词：
你说得出「我们的循环有二十多个退出点，所以收尾逻辑必须做成幂等 + finally 兜底」，
比说「我们用 while(true)」有信息量得多。

### 2.6 本章自检

1. 为什么「异常兜底分支的判据要用白名单而不是黑名单」？举一个黑名单会静默扩大覆盖面的例子。
2. `input={}` 什么时候是 bug，什么时候是唯一合法状态？判据是什么？
3. `stopReason=null` 且 content 为空 vs 且 content 非空，是两种不同的故障。分别是什么？
4. 一个循环有 22 个退出点，你要在「每轮结束」发一个耗时事件。怎么保证不漏也不重？

---
<a id="3"></a>
## 3. 状态：为什么必须是一个显式对象

这一章讲一个看起来很无聊、实际上是整个循环能不能维护的分水岭的决定：
**跨迭代的状态放在哪。**

### 3.1 先看「不做这个决定」会怎样

回到 §0.2 那个骨架。它只有一个跨迭代变量 `messages`，所以随便放。
但真实循环需要记的东西远不止一个：

- 现在第几轮了？
- `max_tokens` 恢复过几次了？（不封顶就会无限续写）
- 响应式压缩尝试过了吗？（同一轮不该压两次）
- 连续压缩失败几次了？（要熔断）
- 超时重试几次了？
- Stop Hook 重试几次了？
- 上一轮为什么 continue 的？

假设你用独立的 `let` 变量装这些，然后循环里有 7 个 `continue`。
每个 `continue` 之前你都要更新一批变量。**7 个分支 × 9 个字段 = 63 次赋值机会出错**，
而漏掉一次的后果是：某个计数器没加，于是某个上限永远达不到，于是无限重试。

**这不是假设。** sid-code 的 `types.ts` 里有一条注释，记的就是这个形态的真实发作
（`timeoutRetryCount` 字段，原文）：

> 注意：不能在 while 循环顶部重置——timeout continue 也会回到那里，会导致每次
> 重试后立即被清零、永远达不到 maxTimeoutRetries。只在"成功"路径重置，才能同时
> 保证当前请求的重试计数正确递增、且不会"一次超时永久丧失后续轮次的重试能力"。

读一遍这段：**在循环顶部重置计数器**——这是一个看起来极其自然、极其"干净"的写法，
而它的效果是把重试上限彻底架空，且不报任何错。

### 3.2 解法：一个显式 State 对象

CC 的做法（CC 口径 2026-06），源码注释原话：

> Continue sites write `state = { ... }` instead of 9 separate assignments.

即：把所有跨迭代字段收进一个 `State` 对象，每个 `continue` 之前只写一行
`state = { ...state, 改动的字段 }`，让 TypeScript 编译器保证字段完整性。

sid-code 的对应物是 `LoopState`（`packages/core/src/query/types.ts:153`）。
它比 CC 那个 9 字段版本大得多——实读有 30+ 字段。挑几个有代表性的：

```typescript
export interface LoopState {
  turnCount: number;                          // 当前轮次
  maxTurns: number;
  maxOutputTokensRecoveryCount: number;       // max_tokens 恢复次数
  maxOutputTokensOverride?: number;           // 上限提升覆盖值
  diminishingReturnsHandoffDone?: boolean;    // 递减收益「让手」是否做过（one-shot）
  hasAttemptedReactiveCompact: boolean;       // 本轮是否压缩过（one-shot）
  consecutiveCompactFailures?: number;        // 连续压缩失败数（熔断用）
  transition: ContinueReason | undefined;     // ★ 上一次为何 continue
  timeoutRetryCount: number;
  turnsConsumedWithoutAssistant: number;      // ★ 被网络故障偷走的轮数
  turnStartedAtMs?: number;                   // 端到端耗时基准
  turnCompleteEmitted?: boolean;              // 幂等位（22 个出口）
  // ... 还有 20 来个
}
```

### 3.3 `transition` 字段：一个看似无用的字段，其实是可测试性设计

这是全章最值得学的一处。`transition` 记的是「上一次迭代为什么 continue」。
CC 的注释（CC 口径 2026-06）原文：

> Why the previous iteration continued. Undefined on first iteration.
> **Lets tests assert recovery paths fired without inspecting message contents.**

第一眼看它像调试字段。但想一层：一个循环有十几条恢复路径，
你怎么写测试验证「在条件 X 下走了路径 Y」？

- 没有 `transition`：只能去翻消息历史，找注入的提示文本里有没有某个特征词。
  **脆弱**（改文案就断）、**间接**（文案可能被别的路径也注入）。
- 有 `transition`：`expect(state.transition).toEqual({ type: "reactive_compact" })`。

> **这说明什么：这个循环上有大量集成测试，而测试反过来驱动了内部 API 的设计。**
> 面试里这是一个很硬的信号——「我们给循环加了一个 `transition` 字段，
> 它不参与任何业务逻辑，唯一作用是让测试能直接断言走了哪条恢复路径」。

sid-code 在这里比 CC 多走了一步，而且这一步解决的问题很典型
（`packages/core/src/query/transition.ts` 文件头注释原文）：

> **解决 transition 字段"只写不读"问题**：通过 `traceAppendEvent` 让测试和可观测性系统
> 都能断言/追踪恢复路径的触发。

整个模块只有 20 行，做两件事：

```typescript
export function setTransition(state, reason, deps, sessionId?): void {
  state.transition = reason;                    // ① 写字段（给测试）
  try {
    deps.traceAppendEvent?.({                   // ② 发事件（给可观测性）
      event: "LoopTransition",
      session_id: sessionId || "unknown",
      timestamp: new Date().toISOString(),
      data: { type: reason.type, turn: state.turnCount },
    });
  } catch {
    /* trace 写入失败不阻断主循环 */
  }
}
```

三个细节都值得学：

1. **「只写不读的字段」是一个明确的坏味道**，而修法不是删掉它，是给它找第二个消费者。
   `transition` 对测试有价值，但如果生产里没人读，它在真实会话上就是零信息——
   而「哪条恢复路径最常触发」恰恰是排查时最想知道的。
2. **`catch {}` 吞掉 trace 失败**。埋点绝不能让主流程崩。这条是通用纪律：
   **可观测性是旁路，不是关键路径。**
3. **`session_id || "unknown"`** 而不是让它 undefined。缺值也要有个可搜的标记，
   否则聚合时那些行会静默消失。

### 3.4 为什么是 `while(true)` 而不是递归

这是面试常问的一题，答案有两层。

**表层理由：栈。** 复杂任务可能跑 50+ 轮，递归会栈溢出。

**深层理由（更值得说）：generator 组合。** 主循环是一个 async generator（§3.5），
递归的 generator 需要 `yield*` 委托，**每层递归多包一层 generator**。
50 层嵌套 generator 的性能和可调试性都很糟。

而 `while(true) + State 对象`是经典的**状态机模式**——
**用数据表达状态转换，而不是用控制流表达。** 这句话是本章的一句话总结。

### 3.5 为什么用 async generator 连接两层

sid-code 的循环是两层（和 CC 同构）：

```
QueryEngine（会话层，engine.ts 513 行）
    │  职责：用户输入预处理、会话持久化、消息规范化、消费 yield 桥到外部回调
    │
    │  ── async generator ──
    ▼
queryLoop（执行层，loop.ts 5097 行）
    │  职责：调 API、执行工具、恢复路径、终止判定
    ├── provider.sendMessageStream()  → 流式 API 调用
    ├── processStream()               → 流式事件累积（stream-processor.ts 606 行）
    ├── executeTools()                → 工具执行（tool-executor.ts 1646 行）
    ├── runCompactPipeline()          → 上下文压缩（compact/ 目录）
    └── 四道闸门                       → end_turn 后的完成度校验（§5）
```

`queryLoop` 的签名（`loop.ts:629`）：

```typescript
export async function* queryLoop(loopConfig: QueryLoopConfig): AsyncGenerator<QueryLoopYield>
```

选 async generator 而不是回调 / EventEmitter，四个理由：

| 理由 | 说明 |
| --- | --- |
| **背压** | 消费者（TUI 渲染）慢了，生产者自然暂停。回调做不到，EventEmitter 会堆积 |
| **类型安全** | `yield` 的类型可静态检查。`QueryLoopYield` 是一个 12 种 kind 的联合类型 |
| **生命周期清晰** | generator 的 `return` 就是结束；外部 `.return()` 就是中止，`finally` 必然跑 |
| **易测试** | mock 一个 generator 比 mock 一个 EventEmitter 容易得多 |

第三条在 sid-code 里有具体落地（`loop.ts:747` 注释原文）：

> Fix 1：try/finally 包裹整个 while 循环，确保 queryLoop 结束时（正常/异常/
> **外部 `.return()` 中止**）都能批量清理本次 loopId 下的所有残留快照，避免孤儿
> generator 写入的脏数据无限累积，也避免内存泄漏。

**「孤儿 generator」是这个模式特有的一类泄漏**：外部不再 `next()` 了，
generator 卡在某个 `yield` 上永不推进，它持有的资源永不释放。
`try/finally` + 外部 `.return()` 是唯一可靠的解法。

### 3.6 `yield` 什么：12 种 kind

实测（命令见附录 C）`QueryLoopYield` 有 12 种 kind。挑几个有设计含量的：

| kind | 用途 | 设计要点 |
| --- | --- | --- |
| `assistant_message` | 模型回复 | 带 `persistMeta`（usage/model/stopReason），**只用于落盘归因，不进 LLM 历史** |
| `stream_text` | 流式文本增量 | 实时喂给 TUI |
| `compact` | 压缩发生了 | **必填 before/after 消息数**（见下） |
| `max_turns` | 撞轮次上限 | 必带 `turnsConsumedWithoutAssistant`（见 §8.5） |
| `tombstone` | 撤回一条已 yield 的消息 | 降级时用（§8.6） |
| `done` | 本轮结束 | 22 个出口都发这个 |

`compact` 那条的注释是一个极好的教学案例（`types.ts` 原文）：

> P1-3：压缩横幅**必须携带实据**，不能是与消息数组解耦的独立信号。
> 事故背景（2026-07-29）：`yield { kind: "compact" }` 原本零字段，8 处调用点任一误发就画出
> 「对话已压缩」横幅——而那次消息历史一条都没少。字段设为必填后，「没压动却画横幅」需要
> 调用方编造两个数字才能做到，从"靠自觉"变成"靠类型强制"。
> 不变式：**只有 `messageCountAfter < messageCountBefore` 时才允许 yield 这个事件。**

> **这个修法的形态值得单独记住：把「靠自觉遵守的约定」改成「靠类型强制的义务」。**
> 原来的信号是零字段的，任何人误发都能画出横幅；改成必填两个数字之后，
> 要撒谎就必须**主动编造**两个具体数值——门槛从「疏忽」抬到了「故意」。
> 这比写一行注释「请确认真的压缩了才发」有效得多。

### 3.7 本章自检

1. 「在 while 循环顶部重置重试计数器」这个写法为什么是 bug？它的症状是什么（会报错吗）？
2. `transition` 字段不参与任何业务逻辑，为什么不能删？它有几个消费者？
3. 为什么递归实现 agent loop 的**深层**问题不是栈溢出，而是 generator 组合？
4. 「把靠自觉的约定改成靠类型强制的义务」——`compact` 事件是怎么做到的？

---
<a id="4"></a>
## 4. ★ continue 的十五种理由（本文架构核心）

这一章是全文的心脏。前面讲了「循环怎么停」，这一章讲**循环为什么不停**——
而后者才是生产循环里真正的复杂度所在。

### 4.1 先看数字

实测（命令见附录 C）：

```bash
awk '/export type ContinueReason/,/;$/' packages/core/src/query/types.ts \
  | grep -c 'type: "'
# → 15
```

**15 种 continue 理由。** CC 口径（2026-06）当时是 7 种。
差异不代表谁更好——sid-code 接的是国产网关 + 弱模型，那些环境会产生
CC 在 Anthropic 官方端点上遇不到的形态（比如 §2.3 那个 `input={}`）。

完整列表（`types.ts:131-149` 实读）：

```typescript
export type ContinueReason =
  | { type: "tool_use" }                    // ① 正常：执行完工具继续
  | { type: "max_tokens_continuation" }     // ② 输出被截断，续写
  | { type: "max_tokens_escalate" }         // ③ 输出被截断，先提高上限
  | { type: "reactive_compact" }            // ④ prompt-too-long，压缩后重试
  | { type: "context_overflow_retry" }      // ⑤ 上下文溢出，压缩后重试
  | { type: "loop_recovery" }               // ⑥ 检测到死循环，注入提示后放行
  | { type: "stop_hook_retry" }             // ⑦ Stop Hook 报错，让模型修
  | { type: "timeout_retry" }               // ⑧ 超时，重试
  | { type: "todo_gate_retry" }             // ⑨ 待办没做完，不许收尾
  | { type: "unanswered_retry" }            // ⑩ 声称说完了但没给答复
  | { type: "hypothesis_gate_retry" }       // ⑪ 有未裁决的假设，不许收尾
  | { type: "goal_gate_retry" }             // ⑫ 目标未达成，不许收尾
  | { type: "goal_budget_warning" }         // ⑬ 目标预算告警
  | { type: "empty_param_retry" }           // ⑭ 空参数退化，压缩后重试
  | { type: "token_budget_continuation" };  // ⑮ 预算没花完，鼓励继续深入
```

### 4.2 按「谁在推动」分四类，这个分类比列表有用

十五条平铺着记没意义。真正的结构是它们**代表四种完全不同的意图**：

```
┌─ A. 任务还没做完（模型自己要求继续）─────────────────┐
│  ① tool_use                                        │
│  说明：唯一的「正常」路径。其余 14 条都是异常或干预。   │
└───────────────────────────────────────────────────┘

┌─ B. 技术故障恢复（外部环境坏了，循环自己修）───────────┐
│  ④ reactive_compact      ⑤ context_overflow_retry   │
│  ⑧ timeout_retry         ⑭ empty_param_retry        │
│  ② max_tokens_continuation  ③ max_tokens_escalate   │
│  说明：模型/网络/窗口出了问题，不是模型不想干。         │
│  关键设计：这些错误**不暴露给上层**（§4.5 错误扣留）    │
└───────────────────────────────────────────────────┘

┌─ C. 质量闸门（模型说完了，但我们不认）────────────────┐
│  ⑦ stop_hook_retry   ⑨ todo_gate_retry              │
│  ⑩ unanswered_retry  ⑪ hypothesis_gate_retry        │
│  ⑫ goal_gate_retry                                  │
│  说明：模型「说完了」≠「做完了」。见 §5 整章。          │
└───────────────────────────────────────────────────┘

┌─ D. 病态干预（模型在原地转圈或提前收工）───────────────┐
│  ⑥ loop_recovery   ⑬ goal_budget_warning            │
│  ⑮ token_budget_continuation                        │
│  说明：⑥ 是「转太多」，⑮ 是「转太少」。见 §9。          │
└───────────────────────────────────────────────────┘
```

**这个四分法是本章唯一必须记住的东西。** 它有三个直接用途：

1. **面试时能结构化地答。** 「我们循环有十几条 continue 路径」是罗列；
   「分四类：正常推进、技术恢复、质量闸门、病态干预」是理解。
2. **它解释了为什么这些路径不能拆成中间件。** 见 §4.4。
3. **它给出了新增路径时的归类判据。** 一条新的 continue 属于哪类，
   决定了它该不该扣留错误、该不该封顶、该不该默认开启。

### 4.3 每一类的封顶策略不同，而这是刻意的

**所有恢复路径必须封顶**，否则就是无限循环。但四类的封顶方式不一样：

| 类 | 封顶方式 | 实测常量 |
| --- | --- | --- |
| A 正常 | 靠 `maxTurns` 兜（交互模式是 `Infinity`，见 §4.6） | — |
| B 技术恢复 | **次数封顶** | `MAX_EMPTY_PARAM_RETRIES = 3`、`maxTimeoutRetries = 10` |
| B 压缩类 | **one-shot 标志位 + 跨轮熔断** | `hasAttemptedReactiveCompact`、`MAX_CONSECUTIVE_COMPACT_FAILURES = 3` |
| C 质量闸门 | **次数封顶，且耗尽后放行而非终止** | `MAX_TODO_GATE_RETRIES = 3`、`MAX_STOP_HOOK_RETRIES = 3`、`MAX_UNANSWERED_RETRIES = 2` |
| D 病态干预 | **注入次数封顶，且从不强制终止** | `MAX_LOW_YIELD_INTERVENTIONS = 2`、`MAX_STUCK_REMINDERS = 2` |

C 和 D 那两行的「耗尽后放行 / 从不终止」是一个重要的取向选择，§9.4 会展开论证。
先给结论：**在 coding agent 上，误杀一个跑了 40 轮的正当长任务，
比放过一次空转更贵。**

### 4.4 一个 one-shot 标志位的血案：「绝不能在 continue 分支重置」

这条是全章最实用的一条纪律。`types.ts` 的 `hasAttemptedReactiveCompact` 注释（原文）：

> P0-2（对齐 CC 死亡螺旋防御）：这是一个 one-shot 标志位，只允许在触发响应式压缩的两处
> 设为 `true`。**绝不能在任何 continue 分支中把它重置回 `false`**——CC 曾有过前车之鉴：
> 有人在 stop hook blocking 分支里重置了同类一次性标志位，导致同一个不可恢复的
> prompt-too-long 场景每轮都重新触发压缩重试，**"烧掉数千次 API 调用"**才被发现。
> 新增类似的"只能尝试一次"的恢复机制时，遵循同一模式：**只有成功路径才置真，
> 任何软重试/continue 路径都不得清零。**

拆解一下这个 bug 为什么这么难发现：

```
prompt-too-long
  → 触发压缩，标志位 = true
  → 压缩失败（历史压不动）
  → 走到 stop hook 分支，那里「顺手」重置了标志位 = false
  → continue
  → 又 prompt-too-long
  → 标志位是 false，所以「还没试过」→ 再压一次
  → 无限循环，每轮烧一次 API 调用
```

**每一步都合理，组合起来是灾难。** 而且它不报错、不崩溃，
只是账单在涨——CC 那次是「数千次 API 调用」才被发现。

代码里的防线是两条互补的（`consecutiveCompactFailures` 注释原文）：

> 与 `hasAttemptedReactiveCompact` **互补而非重复**：那个是「prompt-too-long 本轮只反应式
> 压缩一次」的防抖（粒度=**本轮**）；这个是跨轮累计的失败熔断（粒度=**本会话**）。
> 任一次压缩成功即清零——熔断只针对"连续"失败。

> **两个粒度的防线都要有**：本轮防抖挡「一轮内重复试」，会话熔断挡「每轮试一次，试一百轮」。
> 只有前者时，第二种形态畅通无阻——而第二种正是 CC 踩到的那个。

### 4.5 错误扣留（withhold）：可恢复错误不许向上暴露

B 类路径有一个共同的、非常重要的设计：

> **prompt-too-long、max_output_tokens、timeout 这些错误，循环自己能修，
> 就不 yield 给上层。只有恢复手段穷尽了，才暴露。**

为什么这条重要？因为上层（SDK 调用方、评测 harness、CLI）收到一个 `error` 事件时，
**它的合理反应是终止会话**。如果循环把「我遇到 prompt-too-long，正在压缩重试」
当 error 报上去，上层就会在一个本来能自愈的场景里把任务掐死。

sid-code 的 `loop.ts:2523` 有一段注释，讲的是同一个思路在 catch 块里的落地（原文）：

> 放在 catch **最前面**是刻意的：本 catch 有三条 `continue` 重试出口
> ……是唯一能同时覆盖三条出口的位置；分别在每条 continue 前埋一次必然漏掉将来
> 新增的第四条。

**「在唯一能覆盖所有出口的位置埋一次，而不是在每个出口各埋一次」** ——
这是应对「出口很多」这个结构性事实的通用手法，和 §2.5 那个幂等位同源。

### 4.6 `maxTurns` 在交互模式下是 `Infinity`，这不是 bug

实读 `loop.ts:634`：

```typescript
const state: LoopState = createInitialLoopState(config.maxTurns || Infinity);
```

而 `config.maxTurns` 默认值是 `0`（`packages/core/src/config/config.ts:882`）。
`0 || Infinity` → `Infinity`。**所以交互模式下循环没有硬上限。**

这看起来很危险，但它是刻意的（`soft-turn-limit.ts` 注释原文）：

> 历史死锁的最后一道口子——交互模式 `maxTurns=Infinity`、无 costLimit，关掉循环检测后
> 只剩用户 ESC。这与 claude-code 一致（**CC 交互模式也无硬上限**），故**默认保持不变**，
> 尊重用户"不打断长任务"的偏好。

补偿措施是一个**默认关闭的软阈值**（同文件）：

> 但对接入弱模型（deepseek 等易陷入空转）的场景，提供一个**可选**的软阈值：单条用户消息
> 处理超过 N 轮时，注入一次性软提醒"已 N 轮，若已完成请收尾"。这是**软提示、不强杀**——
> 只提醒模型自省，**绝不 yield done 掐断**。

`SID_MAX_TURNS=<正整数>` 显式开启，非法值视为未开启。

> **这是一个「谁在场」决定「防线要不要开」的例子**：人在场时有 ESC，
> 不需要定时器代劳；人不在场（无头评测）时才需要硬上限。
> 所以硬上限的正确位置是 headless/SDK 入口的显式参数，不是交互模式的默认值。

### 4.7 `maxTurns` 之后还有一轮：强制总结

实读 `loop.ts:4801`（注释原文）：

> P1-1：主循环达到 maxTurns——**强制请求总结（额外一轮，不计入 maxTurns）**

判据（`loop.ts:4807`）：

```typescript
if (state.turnCount >= state.maxTurns && !deps.getAbortSignal?.()?.aborted) {
```

**为什么要多这一轮**：撞上限时模型往往正在干活中途，直接停会给用户一个
「跑了 40 轮然后什么也没说」的结果。多花一次调用让它总结一下已完成的部分，
用户至少知道进展到哪了。

注意 `&& !aborted` 这个条件：**用户主动 ESC 时不加这一轮**。
用户按了停止键还硬发一次 API，那是不尊重用户的中止意图。

### 4.8 一个跨仓对照：十五条 vs 七条，多的是什么

| 类 | CC（口径 2026-06） | sid-code（实测 2026-08-29） | 差异来源 |
| --- | --- | --- | --- |
| A 正常 | `next_turn` | `tool_use` | 同 |
| B 技术恢复 | `reactive_compact_retry`、`collapse_drain_retry`、`max_output_tokens_recovery`、`max_output_tokens_escalate` | `reactive_compact`、`context_overflow_retry`、`max_tokens_continuation`、`max_tokens_escalate`、**`timeout_retry`**、**`empty_param_retry`** | timeout / 空参数是**弱模型 + 网关**特有形态 |
| C 质量闸门 | `stop_hook_blocking` | `stop_hook_retry`、**`todo_gate_retry`**、**`unanswered_retry`**、**`hypothesis_gate_retry`**、**`goal_gate_retry`** | sid-code 押注「过程合规」，见 §5 |
| D 病态干预 | `token_budget_continuation` | `token_budget_continuation`、**`loop_recovery`**、**`goal_budget_warning`** | 弱模型更容易空转 |

**这张表的读法不是「谁的多谁就强」**，而是：
**恢复路径的数量，是你踩过的坑数量的一个诚实投影。**
CC 跑在 Anthropic 官方端点 + 自家最强模型上；sid-code 跑在企业网关 + 各家国产模型上。
后者会遇到前者遇不到的形态，于是多了 8 条。

> **面试可以直接用这句**：「恢复路径不是设计出来的，是踩出来的。
> 我们有十五条，其中八条是接国产网关和弱模型之后才加的——比如
> `stop_reason=end_turn` 却带着 `tool_use`、或者 `tool_use` 的参数是空对象。
> 这些在官方端点上不会发生。」

### 4.9 本章自检

1. 十五条 continue 理由分四类，分别是什么？为什么这个分类比背列表有用？
2. one-shot 标志位「绝不能在 continue 分支重置」——不遵守的症状是什么？会报错吗？
3. 为什么 `hasAttemptedReactiveCompact`（本轮防抖）和 `consecutiveCompactFailures`
   （会话熔断）不是重复的两套东西？只留前者会漏掉什么形态？
4. 「错误扣留」是什么意思？不扣留会导致上层做出什么错误决定？
5. 交互模式 `maxTurns = Infinity` 为什么不是 bug？补偿措施是什么，默认开还是关？

---
<a id="5"></a>
## 5. `end_turn` 不是终点：四道闸门

这一章讲 §4 里 C 类那五条 continue。它回答一个哲学味很重但极其实用的问题：

> **模型说「我做完了」，你信不信？**

### 5.1 先把问题讲清楚

模型返回 `end_turn` 只表示一件事：**它不打算再调工具了。**
它**不**表示：任务完成了、代码能编译、测试通过了、待办清空了、
它给出的结论有证据支撑、它真的回答了你的问题。

这两件事之间的缝隙，就是「一次做对率」的全部战场。CLAUDE.md 里把这个方向
叫「更准 / 更少返工」，并且明确写了主语是谁：

> **「更准」不是「模型更聪明」**（那不由我们控制），准确主语是 harness：
> **同一个模型，在 sid-code 里返工更少、一次做对的比例更高。**

**这句话是这一章存在的全部理由。** 你换不了模型的智力，但你能在它说「做完了」时
多问几个问题。

### 5.2 四道闸门，按顺序

`goal-gate.ts` 文件头把链序写得很明确（实读原文）：

> Goal Gate 是 queryLoop 中 end_turn 处理链的最后一环。
> 只有前三道 Gate（**Stop Hook → Todo → Hypothesis**）全部放行，才轮到 Goal Gate 做最终判定。

```
模型返回 end_turn
      │
      ├─ 前置：AfterAgent hook（loop.ts:3422）
      │
      ▼
① Stop Hook Gate ── 外部验证器（lint / test / 你自己的脚本）
      │  报错 → 注入错误 → continue（stop_hook_retry）
      │  封顶 MAX_STOP_HOOK_RETRIES = 3
      ▼
② Todo Gate ── 待办清单还有没做完的？
      │  有 → 注入提醒 → continue（todo_gate_retry）
      │  封顶 MAX_TODO_GATE_RETRIES = 3
      ▼
③ Hypothesis Gate ── 有没有「登记了但没裁决」的假设？
      │  有 → 强制裁决 → continue（hypothesis_gate_retry）
      │  封顶 1 或 2（视有无 open 假设，loop.ts:3607）
      ▼
④ Goal Gate ── /goal 设定的目标达成了吗？预算还有吗？
      │  未达成 → continue（goal_gate_retry）
      ▼
真正结束：yield done
```

另外还有一道**不在这条链上、位置更早**的检查，`unanswered_retry`（§5.6），
它在流处理阶段就命中了——因为它检测的是「这一轮压根没产出答复」，
不必等走到闸门链。

### 5.3 ① Stop Hook：唯一的「外部验证器」

这道闸门的特殊性在于：**前三道之外的三道都是 harness 自己的判断，
只有这一道请了外人。**

它做的事很简单（`stop-hooks.ts` 文件头原文）：

> 当模型认为"完成"后，执行用户配置的 Stop Hooks（如 lint/test），
> 如果有 blocking error，将错误注入对话让模型自动修复。

```
模型 end_turn → 执行 Stop Hooks → 全部通过         → 正常结束
                               → blocking error   → 注入错误 → continue
                               → preventContinuation → 强制结束
```

三种结果里第三种值得注意：`preventContinuation` 是 hook 说
「不许再继续了」——用于「这个错误不是模型能修的，别浪费轮次」。
**验证器不仅能说「不对」，还能说「别再试了」，这是两个不同的信号。**

**为什么外部验证器这么重要**：因为它是唯一一个 harness 完全不理解语义、
纯粹执行用户意图的闸门。`bun test` 说失败就是失败，
没有任何启发式判断的空间。业界把这个模式叫 Ralph Loop 的核心
（「用外部确定性验证替代模型自评」）。

封顶（`stop-hooks.ts:29`）：`MAX_STOP_HOOK_RETRIES = 3`，
耗尽后的行为是 `{ shouldContinue: false, forceStop: false }` ——
**放行，不是终止**。注意这个取向，§9.4 会集中论证。

### 5.4 ② Todo Gate：一个「误判自愈」的精巧设计

判据很直白：待办清单里还有 `unfinished` 项时不许收尾，注入提醒让它继续
（`loop.ts:3520` 起）。

有意思的是**续命耗尽之后**那段。代码注释（`loop.ts:3548` 附近）：

> 续命耗尽。**区分两种外部观测相同、本质不同的收尾**：

两种是什么？`todo-reminder.ts` 的常量注释说得很清楚（原文）：

> P0-3 误判自愈阈值：续命耗尽时，若"有实质产出却不翻状态位"的次数 ≥ 此值，
> 判定极可能是"**任务已交付、只是忘标记**"（而非真没做完），收尾不抛假警报。
> 取 `MAX_TODO_GATE_RETRIES`：即**每一次**续命模型都在实质应答却始终不更新清单，
> 才认定为"忘标记"——足够保守，不会把"真没做完但产出了点东西"误当忘标记放过。

拆开看这个设计：

```
续命 3 次都耗尽了，清单还是没清空。两种可能：
  (a) 真没做完                        → 该抛警报「任务未完成」
  (b) 做完了，但模型忘了把待办打勾    → 抛警报是**假警报**，会误导用户
判据：这 3 次续命里，模型每次都产出了实质正文吗？
  都产出了 → 判 (b)，安静收尾
  有没产出的 → 判 (a)，抛警报
```

> **这个形态值得记住：一个闸门耗尽之后，「失败」本身还要再分类一次。**
> 「阻止收尾」失败了，可能是模型不行，也可能是**闸门的判据（状态位）
> 和真实世界（实质产出）脱节了**。不做这层区分，防线就会稳定地生产假警报——
> 而假警报的代价是用户开始无视你的警报。

还有一条细节，讲的是「不要重复输出」（`loop.ts:3530` 注释原文）：

> 「重复输出」修复：把本轮"已输出实质正文"的判定传下去，让提醒在
> 已交付时明确禁止重述。`producedSubstantialText` 就在上面几行算好，
> 是这一层独有的精确信号——工具层拿不到，所以约束必须由这里下达。

**「这个信号只有这一层有，所以约束必须由这一层下达」** ——
这是一条关于职责边界的判据：不要把只有你知道的事情交给别人去判断。

### 5.5 ③ Hypothesis Gate：把「元认知」从模型自律外化成 harness 机制

这道闸门是 sid-code 独有的（CC 没有对应物），而且它的设计动机是全文最有意思的一段。
`hypothesis-ledger.ts` 文件头（实读原文）：

> 背景(fdb47f30 / harness-llm 差距归因)：deepseek 在排查中途已推出正确结论("进程没崩")，
> 却因沉没成本把它丢弃、最终写成"崩溃"。**根因不在算力，在元认知缺失**：形成假设后不预注册
> 证伪条件、拿到反驳证据时不主动裁决、把未证实的假设当结论交付。
> **光靠 prompt 提醒不够——deepseek 投入 6.2 万字思考仍然错了。**

读一遍最后那句。**6.2 万字思考，结论还是错的，而且是从对的滑向错的。**
这不是模型不够聪明的问题，是它没有「我刚才那个判断被后来的证据推翻了」这个自省环节。

三个机制（同文件原文）：

> 机制1 **预注册证伪**：登记假设时必须声明 `falsifier`（证伪条件），**事后不可修改**。
> 机制2 **矛盾中断**：新证据匹配到某条 open 假设的 falsifier 关键线索时，主循环插入高优先级
>        中断，**强制模型显式裁决**（confirm / refute），而非装没看见继续滑向既定叙事。
> 机制3 **交付门禁**：状态仍为 open 或 refuted 的假设**不得作为结论写进最终交付物**。

三条各有一个精妙点：

1. **`falsifier` 事后不可修改** —— 否则模型会在证据不利时偷偷改证伪条件
   （这正是人类也会犯的错，叫 moving the goalposts）。**不可修改性是这个机制的全部锋利之处。**
2. **矛盾中断是主循环插入的**，不依赖模型自己想起来。模型「装没看见」是常态，
   所以检测和打断都必须在 harness 层。
3. **交付门禁是最后一道**：即使前两条都被绕过，未裁决的假设也进不了结论。

这道门的封顶很有意思（`loop.ts:3607`）：

```typescript
const MAX_HYPOTHESIS_GATE_RETRIES = gateHasOpen ? 2 : 1;
```

**有未裁决假设时给 2 次机会，没有时只给 1 次。** 封顶值随情况变——
因为「有 open 假设」意味着确实有事要做，值得多给一次；否则拦一次就够了。

> **面试可以直接用这段**：「我们把『元认知纪律』外化成了 harness 机制。
> 背景是一个真实案例：模型投入 6 万多字思考，中途已经推出正确结论，
> 又因为沉没成本把它丢了，最终交付了错的。这不是算力问题，
> 光在 prompt 里提醒也没用。所以我们做了三件事：假设必须预注册证伪条件且不可改、
> 新证据命中证伪条件时主循环强制中断要求裁决、未裁决的假设不许写进结论。」

### 5.6 ④ 加一道：`unanswered_retry`——「说完了但没说话」

这道不在闸门链上，位置更早（在流处理阶段）。它检测的形态叫
「未答复的 end_turn」（`unanswered-end-turn.ts` 文件头，原文）：

> 模型以 end_turn 收尾，却没有产出**面向用户的有效答复**。两种形态：
>
> 形态 A「**思考漂移进 content**」：思考文本走了普通 content 通道 → 落成 text 块，
>   无 tool_use、usage 原始为 0、text 极长（**数万字符独白**）。
> 形态 B「**只思考不答复**」：整轮只产出 thinking 块（走 `reasoning_content`），
>   content 通道**一字未发**。

判据的演进过程是本节最值得学的：

> 判据把轴从"**思考块长度**"换成"**是否真答复**"：`end_turn/stop` + 无 `tool_use` + 无有效正文。

第一版判据是「思考块超过 N 字符就疑为泄漏」。这个判据的问题是：
**它在度量一个代理指标（长度），而真正要管的是「有没有答复」。**
于是形态 B 那个「970 字思考单块」被旧的 500 字上限**放行**了——
因为它不够长，但它确实一个字都没答。

换成结构信号后（同文件原文）：

> 主判据（**全用结构信号**）：`usage.outputTokens === 0` + 存在超长 text 块 + 无 thinking 块。
> `usage.outputTokens===0` 是三例最硬的共同信号（比特征词可靠）；
> **特征词不参与判定，避免中/英文差异导致漏判。**

> **两条通用教训**：
> ① **把判据从「代理量（长度）」换成「本质量（有没有答复）」**。
>    代理量总有一个阈值，而阈值两边都会有反例。
> ② **能用结构信号就别用文本特征**。`outputTokens === 0` 是协议级事实，
>    跨语言、跨模型都成立；「包含『我需要』这个词」在英文回复上直接失效。

封顶 `MAX_UNANSWERED_RETRIES = 2`（`unanswered-end-turn.ts:59`）。

### 5.7 四道闸门的共同结构（这是本章的总结）

把四道门抽象一下，它们都是同一个模式：

```
模型说「完了」
   → 拿一个 harness 能独立核验的判据去查
   → 不过 → 注入「为什么不过 + 该做什么」 → continue
   → 过   → 放行
   → 查了 N 次还不过 → 放行（并如实记录），而不是终止
```

四道门的区别只在**「判据从哪来」**：

| 门 | 判据来源 | 谁定义的 | 能不能作弊 |
| --- | --- | --- | --- |
| Stop Hook | 外部命令的退出码 | **用户** | 不能（`bun test` 不会撒谎） |
| Todo | 待办状态位 | 模型自己写的 | **能**（不打勾 / 乱打勾）→ 所以要 §5.4 那层误判自愈 |
| Hypothesis | 预注册的证伪条件 | 模型写的，但**事后不可改** | 不能改条件，但能装没看见 → 所以要主循环强制中断 |
| Goal | `/goal` 的目标描述 + 预算 | 用户 | — |

**「这个判据模型能不能作弊」是设计闸门时的第一个问题。**
能作弊的判据（Todo）必须配一层「作弊检测」；
不能作弊的判据（Stop Hook）反而最简单——这就是为什么外部验证器
在 agent 工程里地位这么高。

### 5.8 本章自检

1. 模型返回 `end_turn` 到底表示什么、不表示什么？
2. 四道闸门的顺序是什么？为什么 Stop Hook 在最前面（提示：谁定义判据）？
3. Todo Gate 续命耗尽后，为什么还要再分类一次？不分类会产生什么？
4. 「未答复的 end_turn」的判据为什么要从「思考块长度」换成「有没有有效答复」？
   旧判据漏掉了哪个形态？
5. 为什么说「这个判据模型能不能作弊」是设计闸门的第一个问题？举两个例子。

---
<a id="6"></a>
## 6. 工具执行：并发、保序、抢跑

模型一轮可能要求调 5 个工具。这一章讲这 5 个怎么跑。它看起来是个纯性能话题，
实际上里面藏着一条协议级不变量和一个「代码在但没接线」的现场。

### 6.1 先看最朴素的做法为什么不够

```javascript
// ❌ 全串行
for (const tu of toolUses) results.push(await runTool(tu));
// 5 个 Read 各 200ms → 1 秒。但它们互不影响，为什么要排队？

// ❌ 全并发
const results = await Promise.all(toolUses.map(runTool));
// 快了，但：Write("a.ts") 和 Read("a.ts") 同时跑，读到的是改前还是改后？
```

**全串行浪费时间，全并发破坏语义。** 所以需要一个判据：**哪些工具能一起跑。**

### 6.2 判据：让工具自己声明

sid-code 的判定函数（`packages/core/src/query/streaming-tool-executor.ts:56`）：

```typescript
function judgeConcurrencySafe(tool: Tool, block: ToolUseBlock): boolean {
  try {
    return tool.isConcurrencySafe
      ? tool.isConcurrencySafe(block.input)     // ① 工具自己判，且能看到入参
      : (tool.readOnly?.() ?? false);           // ② 回退：只读工具视为安全
  } catch {
    return false;                               // ③ 判定异常 → 保守视为不安全
  }
}
```

三层都有讲究：

1. **`isConcurrencySafe(input)` 能看到入参**，不只是工具名。
   为什么必要：`bash("ls")` 和 `bash("rm -rf /")` 是同一个工具，安全性完全不同。
   **判据必须是「这次调用」级别的，不是「这个工具」级别的。**
2. **回退到 `readOnly()`**：没有显式声明时，只读即安全，这是个合理的保守默认。
3. **异常时返回 `false`**：判定本身出错时，选「不安全」。
   **所有安全相关的默认值都应该指向「更保守」那一侧**，这是 fail-closed 原则。

**为什么不能让框架静态分析？** 因为 `bash` 的副作用藏在命令字符串里，
框架要分析它等于写一个 shell 解释器。**工具实现者最了解自己的语义，
所以判据下沉给工具。**

### 6.3 批量模式：贪心连续合并分区

默认路径。算法在 `tool-orchestration.ts:38`，注释写了规则（原文）：

> - 连续的并发安全工具合并为一个并行批次
> - 非并发安全工具各自成为独立的串行批次
> - **保留模型的隐式顺序语义**（"先 Read → Edit → 再 Read"不被打乱）

举例：

```
模型要求：Read(a)  Read(b)  Edit(c)  Read(d)  Bash(x)  Bash(y)
安全性：    ✅安全   ✅安全   ❌不安全  ✅安全   ❌不安全  ❌不安全

分区结果：[Read(a), Read(b)]  [Edit(c)]  [Read(d)]  [Bash(x)]  [Bash(y)]
             并行批次           串行      串行(独批)   串行      串行
执行顺序：批次之间严格按序，批次内部并发
```

注意 `Read(d)` **没有**和前面的 Read 合并——因为中间隔了个 `Edit(c)`。
这就是「保留隐式顺序语义」：模型先读 a、b，改了 c，再读 d，
说明它可能想看 c 改完之后 d 的样子。**打乱这个顺序就改变了语义。**

关键代码（`tool-orchestration.ts:47`）：

```typescript
if (batches.length > 0 && batches[batches.length - 1].isConcurrencySafe === isSafe && isSafe) {
  batches[batches.length - 1].items.push(item);   // 只合并「连续的、且都安全的」
} else {
  batches.push({ isConcurrencySafe: isSafe, items: [item] });
}
```

那个 `&& isSafe` 是关键：**只有安全的才合并，不安全的即使连续也各自成批。**

并发上限（`tool-orchestration.ts:60`）：

```typescript
export function getMaxToolConcurrency(): number {
  const raw = process.env.SID_TOOL_MAX_CONCURRENT;
  if (raw === undefined || raw === "") return 10;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 10;
}
```

**默认 10**，对齐 CC。为什么要有上限：防文件描述符耗尽。
模型偶尔会一次要求读 50 个文件，`Promise.all` 五十个并发读会打爆 fd 限制。

### 6.4 ★ 一条协议级不变量：N 个 `tool_use` → N 个 `tool_result`

这是全章最重要的一条，也是生产里最常见的一类崩溃。

OpenAI 协议的原文错误（`agent/message-invariants.ts` 文件头引用）：

> `An assistant message with 'tool_calls' must be followed by tool messages
> responding to each 'tool_call_id'`

**缺一个就是 400。** 而「缺一个」的成因五花八门：

| 成因 | 怎么发生的 |
| --- | --- |
| 用户 ESC | 工具还没执行完就中断（§1.5） |
| F1 空参数 | `continue` 重开一轮，健康的 `tool_use` 永不执行（§2.3） |
| 循环检测触发 | `loop.ts:4942` 注释原文：「executeTools 被 continue 跳过，这些 tool_use 永远拿不到 tool_result → 孤儿 → OpenAI 400」 |
| plan-mode 转换 | 模式切换时消息重排 |
| followup 排序 | 工具产生的追加内容插入位置不对 |

sid-code 的防线是**三层**，这个分层本身值得学：

```
① 生产端单点（ADR-039）：executeTools 出口保证「N 进 N 出」
      ↓ 但孤儿还能从 executeTools 之外的路径进入历史
② 全局不变量（message-invariants.ts，431 行纯函数）
      checkMessageHistoryIntegrity() → 报告 OrphanToolUse[] / DanglingToolResult[]
      在发送前校验 + 告警
      ↓ 但发现了还得修
③ 兜底补齐（tool-result-guard.ts）
      yieldMissingToolResults() → 为每个孤儿生成 is_error: true 的 tool_result
```

第 ② 层的设计纪律很典型（`message-invariants.ts` 文件头原文）：

> 本模块把"无孤儿 tool_use"抽成**纯函数**，作为单一事实源，供：
>   - D1-1 convertMessages 发送前关卡（消费端只读校验 + 告警）
>   - D1-2 中断路径完整性测试
>   - D1-3 followup / plan-mode 时序不变量测试
>   - 未来所有 OpenAI 兼容 provider 复用
>
> 纯函数：无副作用、无 I/O、无日志。**调用方负责"发现后怎么办"（告警 / 落盘 / 抛错）。**

> **「检测」和「处置」分离，是这个设计的锋利之处。** 同一个检测函数，
> 在测试里用来断言，在发送路径上用来告警，在兜底路径上用来补齐。
> 如果把日志和抛错写在检测函数里，它就只能服务一个调用方。

第 ③ 层还有一个方向相反的孤儿——`DanglingToolResult`（`tool_result` 找不到对应的
`tool_use`）。它的处置不是补齐而是**删除**：一个无主的结果没有任何意义。
**两种孤儿，两种修法，别混。**

### 6.5 流式抢跑：把工具执行藏进模型输出时间里

这是延迟优化的核心手法。先看时间线对比：

```
批量模式：
模型输出 [========完整接收 3s========]
工具执行                              [Read(a),Read(b) 0.2s] → [Bash 1s]
总计 ≈ 4.2s

流式模式：
模型输出 [===Read(a)===Read(b)===Bash===  3s  ]
工具执行     [Read(a) 完成]
                  [Read(b) 完成]
                                       [Bash 1s]  ← 只剩这个要等
总计 ≈ 4s，但两个 Read 的 0.2s 完全被吸收
```

对典型的 3-5 个工具调用，能省 1-3 秒。**在交互式场景里体感明显。**

sid-code 的实现是一个 4 状态状态机（`streaming-tool-executor.ts` 文件头原文）：

```
queued     — 已加入队列，尚未开始（等待并发安全条件满足）
executing  — 正在执行（Promise 未 settle）
completed  — 执行完成（结果已就绪，未被收集）
yielded    — 结果已被主循环收集
```

`canExecuteTool()` 的判定（同文件原文）：

> 一个排队工具可以**立即启动**，当且仅当：
>   - 当前没有任何正在执行的工具（executing 为空）；或
>   - 它自身并发安全 **且** 所有正在执行的工具都并发安全。
>
> 即："**非并发安全工具必须独占执行窗口**"（前后都不能有别的工具在跑）。

**这个判据和批量模式的分区语义是等价的**，只是实现方式不同——
批量模式等全部到齐再分区，流式模式按到达顺序增量调度。
两套实现表达同一个语义，这是刻意的（同文件原文）：

> 与批量模式"并发安全批次并行、非安全批次串行"的语义一致——只是这里按到达顺序
> 增量调度，而非等全部到齐再分区。

还有两条设计纪律（同文件原文）：

> - 本执行器**只负责"何时启动哪个工具"的调度**；单工具的权限/hook/校验/执行仍复用
>   传入的 `executeOne` 回调，**不重复实现管线**。
> - **保序**：结果按工具的**原始 index** 收集，主循环据此按模型输出顺序组装 `tool_result`。

第一条是「新增一条快路径时，绝不复制一遍权限检查」——否则两条路径的权限逻辑会漂移，
而漂移的那一天你会发现快路径漏了一个检查。

第二条是**有序并发**模式：**执行是并发的，产出是有序的。**
因为协议要求 `tool_result` 的顺序和 `tool_use` 一致（§6.4）。

### 6.6 一个「代码在但没接线」的现场（本章最值得看的部分）

实测（命令见附录 C）：

```bash
grep -rn "StreamingToolExecutor" --include='*.ts' packages/ | grep -v node_modules
```

结果：

```
tests/query/streaming-tool-executor.test.ts:6,69,72,92,113   ← 测试在用
src/query/streaming-tool-executor.ts:2,65                     ← 定义本身
src/query/stream-processor.ts:59                               ← 只是注释里提到
cli/src/app.ts:4628                                            ← 只是注释里提到
```

**`StreamingToolExecutor` 这个类，生产代码里一个调用点都没有。** 只有测试在用。

那流式抢跑到底生效了吗？生效了，但**走的是另一条路**（`packages/cli/src/app.ts:4386` 起）：
`app.ts` 自己接了 `onToolUseComplete` 回调，用一个 `Map` 做结果缓存，
**没有用那个 4 状态状态机类**。

而且它默认关闭（`streaming-tool-executor.ts:191`）：

```typescript
export function isStreamingToolExecEnabled(): boolean {
  return process.env.SID_ENABLE_STREAMING_TOOL_EXEC === "1";
}
```

`app.ts` 那条路径还比类版本更保守（`app.ts:4382` 注释原文）：

> **只抢跑并发安全工具**：写类工具依赖执行顺序/checkpoint 快照/plan-mode 处理，
> 仍留给 `executeTools` 的批量编排统一处理（此处 precomputed 只对读类命中，
> 写类不进缓存 → 走正常路径，零行为变化）。

> **这一节为什么值得单独写出来**：因为它是「有代码 ≠ 有能力」这个陷阱的活体标本。
> 如果你只看 `src/query/` 目录，你会得出「sid-code 有一个 4 状态流式工具执行器」
> 的结论——文件在、193 行、注释详尽、测试齐全。而真相是：
> 生产走的是 `app.ts` 里一个更简单的 Map 缓存版本，且默认关闭。
>
> **调研任何项目的任何能力，第一个动作都应该是「数生产调用点」，而不是「找到文件」。**
> 判据：`grep -rn "<符号>" --include='*.ts' src/ | grep -v '\.test\.ts'`，
> 结果为空就是死代码，只在注释里出现也是死代码。
>
> 三档结论比两档准确：**活代码** / **仅被测试消费** / **真死代码**。
> `StreamingToolExecutor` 属于第二档——这一档是隐形大头，因为它测试全绿、
> 覆盖率报告好看，唯一的问题是生产里没人调。

`app.ts` 那条抢跑路径里还有一个非常精巧的细节，值得单独讲（`app.ts:4416` 注释原文）：

> H7：权限确认可能弹 ask 对话框阻塞等用户作答。抢跑发生在流式接收窗口内（模型仍在
> 吐后续内容），此时 stream-processor 心跳 / loop 看门狗 / turn_hard 都在计时——
> **若不接闸门，用户思考的这段静默会被误判成流 hang 强杀**，掐断权限弹窗
> （与 fallback 弹窗同型，事故 20260721-142757）。

**抢跑把一个「等人」的动作挪进了「等模型」的时间窗里，于是所有看门狗都开始误判。**
解法是 `withHumanInputWait()` 包住权限确认那一步（§8.4 的人机闸门）。

> **这是一个通用教训：任何「把 A 阶段的工作提前到 B 阶段」的优化，
> 都要检查 B 阶段的所有计时器和守卫是否还成立。** 优化改变了时序，
> 而守卫的假设是建立在旧时序上的。

### 6.7 子 agent：另一种「工具」，也是另一个循环

`task` 工具会 spawn 一个子 agent。它的特殊之处是：**这个「工具」内部又是一整个循环。**

sid-code 的实现分两层，和主循环共享核心（`agent/agentic-loop.ts` 文件头原文）：

> AgenticLoop — 共享的 Agent 循环核心
> 对标 claude-code 的 `runAgent()`，使**子代理和主代理共享同一套循环逻辑**。
> 从 `executeInner()` 提取，消除与 `AgentLoopRunner.run()` 之间的代码重复。

而且明确点出了「不共享会怎样」（`agentic-loop.ts:34` 注释原文）：

> B5-1：撞 context window 上限时的压缩恢复。**与主循环 query/loop.ts 用同一份实现**——
> 子代理另写一套压缩策略就是两份平行实现（本方案 §0.4 判据禁止的形态）。

**子 agent 的价值是上下文隔离**（`agent/sub-agent.ts` 文件头原文）：

> 每个子代理有**独立的短上下文**，干完活只返回结果。
> 主代理当协调者，spawn 子代理执行子任务，汇总结果。

回到 §1.4 那个 O(N²)：如果主 agent 自己去读 20 个文件，
那 20 个文件的全文会**永久留在主上下文里**，后面每一轮都要重付一次。
丢给子 agent 的话，主上下文里只留一段结论。**这是对抗 O(N²) 最有效的手段。**

代价有两个，必须点破：

1. **子 agent 看不到主上下文**，所以任务描述必须自包含。描述写不好，
   子 agent 会做错方向的事。
2. **子 agent 的结论是压缩过的**，主 agent 拿不到细节。
   如果主 agent 后来需要那些细节，得重读一次——**这时候子 agent 反而更贵**。

> **判据**：子任务的「输入很大、输出很小」时用子 agent（搜索、调研、批量检查）；
> 「输出还要被反复引用」时不要用（核心文件的实现细节）。

### 6.8 本章自检

1. 为什么并发安全的判据必须是「这次调用」级别而不是「这个工具」级别？举个例子。
2. `Read(a) Read(b) Edit(c) Read(d)` 会分成几个批次？为什么 `Read(d)` 不和前两个合并？
3. 「N 个 `tool_use` → N 个 `tool_result`」这条不变量，有哪三种破坏路径？三层防线各管什么？
4. `OrphanToolUse` 和 `DanglingToolResult` 的修法为什么方向相反？
5. 怎么判断一个类是「活代码 / 仅被测试消费 / 真死代码」？给出具体命令。
6. 流式抢跑为什么会让看门狗误判？这个教训能推广成什么通用原则？
7. 什么时候该用子 agent，什么时候不该用？判据是什么？

---
<a id="7"></a>
## 7. 上下文：O(N²) 与渐进式压缩管道

§1.4 说过成本是 O(N²) 的。这一章讲怎么活下来。它是全文工程含量最高的一章，
因为它同时要满足三个互相冲突的目标：**别撑爆窗口** / **别丢信息** / **别破缓存**。

### 7.1 这一章的三个敌人

```
敌人①：窗口是硬上限。撑爆了，API 直接 400（prompt too long）。
敌人②：压缩就是丢信息。丢错了，模型开始重读文件、重复付费、甚至自我否定。
敌人③：改历史就破缓存（§1.6）。破了缓存，输入 token 从 10% 单价回到 100%。
```

**三个敌人互斥。** 最激进的压缩最保窗口、最伤信息和缓存；不压缩最保信息和缓存、
但必然撑爆。所以不存在「最优压缩策略」，只存在**分档策略**。

### 7.2 教科书答案，以及它为什么不够

概念层讲上下文压缩，通常只讲一种：**调模型生成摘要，用摘要替换旧消息。**

这个方案的三个代价，教程一般不提：

| 代价 | 量级 |
| --- | --- |
| 一次额外的 LLM 调用 | 3–10 秒延迟 + 一次完整往返的钱 |
| 摘要必然丢细节 | 「为什么这么做」会被稀释成一两句话 |
| 整个前缀被改写 | prompt cache 全灭，下一次请求全价 |

**所以摘要压缩必须是最后手段，不是唯一手段。**

### 7.3 sid-code 的五层管道（按成本从低到高）

实读 `packages/core/src/query/compact/index.ts` 文件头（原文）：

> 渐进式压缩管道入口
> 按成本从低到高依次尝试：
> ① `applyToolResultBudget` — 超大工具结果替换为占位符
> ② `snipCompact` — 裁剪最早的消息
> ③ `microcompactMessages` — 清理旧工具结果内容
> ④ `autoCompact` — 调用模型生成摘要（最后手段）

再加上主循环里在 ④ 之前插入的 Context Collapse（`loop.ts:900` 附近），
实际是五层：

```
① toolResultBudget   零 API   超大工具结果 → 占位符（原文可落盘，可恢复）
      ↓ 还不够
② snipCompact        零 API   裁掉最早的消息对
      ↓ 还不够
③ microcompact       零 API   清理旧工具结果内容（两种模式，见 §7.5）
      ↓ 还不够
④ contextCollapse    中成本   对最老 1-2 段做分段摘要（不是全量）
      ↓ 还不够
⑤ autoCompact        高成本   全量 LLM 摘要（最后手段，有熔断器）
```

**前三层零 API 调用。** 这是这个设计的全部价值：
大多数轮次在前三层就解决了，**零额外延迟、零额外成本**。

各层的实测参数：

**① toolResultBudget**（`tool-result-budget.ts:23`）：

```typescript
const DEFAULT_OPTIONS = {
  maxTokensPerResult: 10000,   // 单个工具结果上限
  totalBudget: 50000,          // 所有工具结果总预算
  preserveRecentCount: 4,      // 最近 4 条消息的结果豁免
  charsPerToken: 4,            // 粗略估算系数
};
```

`preserveRecentCount: 4` 是关键：**刚拿到的工具结果绝不动**，
因为模型正在用它。只压旧的。

**② snipCompact**（`snip-compact.ts:17`）：

```typescript
minPreserveCount: 6,    // 最少保留 6 条（3 轮对话）
snipSize: 2,            // 每次裁 2 条（1 轮）
maxSnipRatio: 0.5,      // 最多裁一半
```

注意它 import 了 `checkMessageHistoryIntegrity`（§6.4 那个纯函数）——
**裁消息最容易切断 `tool_use`/`tool_result` 配对，所以裁完必须校验不变量。**

**④ contextCollapse**（`context-collapse.ts` 文件头原文）：

> 定位：介于轻量压缩与全量 autoCompact 之间的"中等成本"压缩层。
> - snip 只丢消息（零语义保留），autoCompact 全量摘要（一次完整 LLM 调用，高成本）。
> - collapse 对**最老的 1-2 段**消息做**分段摘要**：保留近 70% 消息不动，只压老段。

它的四条设计要点里有两条特别值得学（同文件原文）：

> 2. 分段摘要：每段独立轻量 prompt（非全局摘要）。**每段 prompt 附带"前一段摘要"作为上下文，
>    避免丢失跨段因果**；段摘要 < 原段 10% 视为失败回退。
> 3. 边界安全：**只在 user 消息且不含 tool_result 处切段**，避免切断 tool_use/tool_result 配对。

第 2 条的「附带前一段摘要」解决的是分段摘要的固有缺陷：
分段之后每段都不知道前因后果，摘出来的东西会失去因果链。
第 3 条又是 §6.4 那条不变量在另一个地方发作——**任何动消息数组的操作，
都要检查这条不变量。**

### 7.4 触发阈值：为什么从百分比改成绝对值

这是一个非常好的「参数选型」案例。实读 `context/manager.ts:181`（注释原文）：

> 旧值（百分比，已废弃）：soft=0.50 / hard=0.70 / emergency=0.94
> **百分比在不同窗口模型下行为不可预测**（32K 窗口 50%=16K 过早，200K 窗口 50%=100K 过晚）

改成绝对 buffer（`manager.ts:182`）：

```typescript
const BUFFER_THRESHOLDS = {
  masking:     80_000,   // 剩余 ≤ 80K → 工具输出遮罩
  compression: 60_000,   // 剩余 ≤ 60K → LLM 摘要压缩
  emergency:   40_000,   // 剩余 ≤ 40K → 紧急截断
};
const SMALL_WINDOW_EMERGENCY_RATIO = 0.9;   // ≤60K 小窗口模型只有 emergency 一档
```

外加一条绝对底线（`context/auto-compact.ts:32`）：

```typescript
export const TOKEN_THRESHOLDS = {
  blocking: 3_000,   // 剩余 ≤ 3K → 强制截断，不调 LLM
} as const;
```

**为什么 blocking 档不调 LLM**：剩 3K token 时，连发一次摘要请求都可能因为窗口不足而失败。
**这一档是「连抢救都来不及」的档，只能硬截断。**

> **「阈值该用相对值还是绝对值」的判据**：看这个阈值要保护的东西是相对的还是绝对的。
> 「留够空间说完这一轮」是**绝对**需求（模型的 max output 是固定 token 数），
> 所以阈值该是绝对值。用百分比的话，同一个绝对需求在不同窗口下被换算成不同的值——
> 这就是「32K 窗口 50% 过早，200K 窗口 50% 过晚」的根因。

还有一个非常精妙的补丁，叫「完成缓冲区」（`manager.ts:192` 注释原文）：

> **关键设计：缓冲区是「地板」而非「减法」。**
> 直觉做法是 `有效窗口 = 窗口 - 缓冲区` 再套三层阈值，但那会与既有绝对 buffer
> （80K/60K/40K）**叠加**——绝对 buffer 本来就是为「留完成空间」设的，再减一次等于双重预留：
> 200K 窗口的 hard 触发点会从 70% 猛提前到 55%，128K 更是提前到 38%，
> **白扔掉三成可用上下文**。故改为对每层剩余门槛取 `max(原门槛, 缓冲区)`。

> **「地板 vs 减法」这个区分值得记住。** 两个机制都在做同一件事（留出完成空间）时，
> 正确的组合是 `max()` 而不是相加。相加就是双重预留，代价是白扔掉三成窗口，
> 而且这个损失完全静默——没人会发现「本来还能用 60K」。

### 7.5 microcompact 的两种模式：为省 90% 的钱多写几百行

这是 §1.6 那个「前缀必须逐字节一致」和「压缩就是改历史」正面冲突的解法。

两种模式（`microcompact.ts` 文件头原文）：

> - **缓存模式（cache）**：保留结构但清空内容（保护 prompt cache 位置）
> - **时间模式（time）**：直接清空旧工具结果（cache 已冷时）

判据是**缓存冷热**（`types.ts` 的 `lastResponseAt` 注释原文）：

> 用于 cached-microcompact 的缓存冷热判定：距上次响应超过 prompt cache 的
> **5min ephemeral TTL** 时，视为缓存已冷，改走 direct-clear 真正释放本地 token
> （对标 CC time-based microcompact：缓存反正要重写，趁机清老工具结果）。

```
距上次响应 < 5min（缓存还热）
    → 别改前缀字节！走 cache 模式，只清「内容」不动「结构」
    → 保住 cache hit，输入 token 省 90%

距上次响应 > 5min（缓存已冷）
    → 反正缓存没了，趁机真清，把本地 token 真正释放出来
```

**「反正缓存要重写，趁机清老工具结果」这个思路很聪明**：
把一次不可避免的损失（缓存过期）变成一次机会（免费做一次激进压缩）。

`cached-microcompact.ts` 里还有一段关于「能力骨架 vs 生产启用」的务实取舍
（文件头原文）：

> ⚠️ 多供应商务实约束：`cache_edits` 是 **Anthropic 私有的、未公开进 Messages API 文档**的字段。
> 无脑把它注入每次请求体会导致非 Anthropic 供应商 400。因此本模块：
> 1. 默认 **不** 真正发射 `cache_edits`（`emitCacheEdits=false`）——只做"供应商感知的模式选择" +
>    "tool_use_id 状态追踪"，已能消除"缓存模式仍改前缀"这一确定性的 cache 破坏。
> 2. 仅当调用方**显式 opt-in** 且供应商为 anthropic 才产出 `cache_edits` 块。

> **这是一个很成熟的分层做法**：把「确定有收益的部分」（不改前缀）默认开启，
> 把「依赖私有字段的部分」（真发 `cache_edits`）默认关闭。
> 一个功能不必全有或全无——**能力可以只上线它已经被证实的那一半。**

microcompact 还有一层工具类型感知（`microcompact.ts` 文件头原文）：

> - 可丢弃工具（输出可重新生成）：read/bash/grep/glob/ls/websearch/webfetch → **完全清空**
> - 不可丢弃工具（输出不可复现）：edit/write/memory/askuser → **保留前 200 字符摘要**
>
> 为什么要区分：edit/write 等工具的输出**无法靠"重新执行"复现**（它们有副作用），
> 盲目清空会导致后续对话丢失"我改了什么"的关键信息。

> **「这个信息丢了能不能重新拿到」是压缩取舍的第一判据。**
> `read` 的输出可以重读（幂等），所以能清；`edit` 的输出是「我做了什么改动」，
> 重新执行一次不会给你同样的信息（文件已经改了）。**幂等性决定可丢弃性。**

### 7.6 熔断器：一个被真实数据逼出来的设计

`autoCompact` 有熔断器（`packages/core/src/query/circuit-breaker.ts:24`）：

```typescript
const DEFAULT_OPTIONS = {
  failureThreshold: 3,              // 连续失败 3 次 → 熔断
  recoveryTimeMs: 5 * 60 * 1000,    // 5 分钟后转半开，试探一次
};
```

三态：`closed`（正常）→ `open`（熔断中）→ `half-open`（试探）。

**为什么需要它**，CC 的数据（CC 口径 2026-06，源码注释原文）：

> BQ 2026-03-10: **1,279 sessions had 50+ consecutive failures (up to 3,272)**
> in a single session, wasting **~250K API calls/day** globally.

单会话连续失败 3272 次。全球每天浪费 25 万次 API 调用。

sid-code 侧的对应记录（`types.ts` 的 `consecutiveCompactFailures` 注释原文）：

> 对标 CC 的 `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3`。修完 P0-1 后
> `reactiveCompact` 会**开始如实返回 `false`（此前谎报成功）**，若没有熔断器就会出现
> 「反复尝试同一个压不动的历史」——CC 踩过的坑是单会话 3,272 次。

**注意那句「修完 P0-1 后才开始如实返回 false」** ——
这是一个很有意思的因果链：**修好一个「谎报成功」的 bug，会暴露出下一个 bug。**
之前压缩失败被上报成成功，所以「连续失败」这个状态根本不存在，
熔断器也就没有必要。修好之后，真实的失败开始出现，才需要熔断器。

> **通用教训：修一个「静默失败被上报为成功」的 bug 时，必须同时准备好
> 「失败现在会真的出现了」的处理路径。** 否则你会把一个「假成功」换成一个「真死循环」。

### 7.7 假压缩事故：为什么「成功」必须由实测差值定义

这是全章最重要的一个事故，它同时是 §3.6 那个 `compact` 事件必填字段的成因。

`reactive-compact.ts` 的 `success` 字段注释（实读原文）：

> **P0-1（2026-07-29 假压缩误报事故）**：此前策略 1 分支**硬编码** `true`，而它调用的
> `compactWithSummary` 在无安全分割点时**静默 no-op** ——于是「消息一条没少」却上报成功，
> 上层照此画出「对话已压缩」横幅、并给模型注入「系统已为你精简对话上下文」这句假话
> （**模型随后 30 条回复持续自我否定**）。
> 现在本字段一律由 `messageCountAfter < messageCountBefore` 实测决定，
> **任何路径都不得再自行宣告成功。**

把这个事故的链条摆出来，它有四层：

```
① compactWithSummary 找不到安全分割点 → 静默 return（没压，也没报错）
② reactiveCompact 硬编码 success: true          ← 谎报
③ 上层画出「对话已压缩」横幅                     ← 用户被骗
④ 给模型注入「系统已为你精简对话上下文」          ← 模型被骗
⑤ 模型发现上下文并没变短，与系统告知矛盾
   → 30 条回复持续自我否定                       ← 最终伤害
```

**第 ⑤ 层是最贵的**：一句注入给模型的假话，导致它连续 30 条回复陷入自我怀疑。
模型会认真对待你告诉它的每一句话，**所以对模型撒谎的代价比对用户撒谎更高。**

修法有三条，每条都是可迁移的纪律：

1. **「成功」必须由实测前后差值定义，不能由代码路径宣告**
   （`context/manager.ts:135` 也有同源注释）。
2. **必填字段强制携带实据**（§3.6 那个 `compact` 事件）。
3. **静默 no-op 是最危险的失败形态** —— 它既不报错也不生效，
   所以它会伪装成成功一路传播。

> **这条可以直接当面试答案**：「我们有一条纪律：任何『操作成功了』的判定，
> 必须由前后实测差值决定，不能由代码路径宣告。起因是一次假压缩事故——
> 压缩函数在找不到安全分割点时静默 no-op，但调用方硬编码了 `success: true`，
> 于是画出了『已压缩』横幅，还给模型注入了『系统已为你精简上下文』，
> 模型发现上下文没变短，接下来 30 条回复都在自我否定。」

### 7.8 压缩之后：三件事必须补回来

压缩把历史砍了，有些东西必须重新注入。实读 `loop.ts:840` 附近，
每个压缩分支后面都跟着同样三行：

```typescript
state.goalReminderPendingAfterCompact = true;      // 目标要重申
state.todoReminderPendingAfterCompact = true;      // 待办要重述
state.deferredToolsPendingAfterCompact = true;     // 延迟加载的工具清单要重发
```

还有一层「决策外化」（`compact/decisions.ts` 文件头原文）：

> **全量摘要会把"为什么这么做"的关键决策稀释成一两句话甚至丢失。**
> 本模块在压缩前从被压缩的消息段提取候选"决策点"（用户纠正、明确指令、架构选择），
> 追加写入会话级 `decisions.jsonl`，并构造一条"决策点已外化到 `<path>`"的重注入消息。

它的提取是纯启发式的，理由很实在（同文件原文）：

> 提取是纯启发式（关键词匹配），**零 LLM 调用——决策外化必须便宜，否则每次压缩多一次往返。**

关键词表分两类（`decisions.ts:32` 起）：`CORRECTION_PATTERNS`（不要/别/错了/不对/
`don't`/`instead`/`actually`…）和 `ARCHITECTURE_PATTERNS`（用X而不是/选择/架构/方案/改用/决定…）。

**为什么优先保「用户纠正」**：用户说过「不要这样做」是最容易在摘要里丢、
而丢了之后代价最高的一类信息——模型会重犯已经被纠正过的错。

> **这一节的通用原则：压缩不只是「删掉一些东西」，
> 还必须包含「把不能丢的东西以更便宜的形式重新注入」。**
> 只做前半截，你会得到一个「失忆但不知道自己失忆」的 agent。

### 7.9 上下文该占多少：一个反直觉的数字

CLAUDE.md 里的口径：

> **上下文占用率** used ÷ window（**有效区 <50–65%**）

**不是 90%，是 50–65%。** 为什么这么低：

1. 要给模型留出说完这一轮的空间（§7.4 的完成缓冲区）。
2. 要留出跑一次摘要的空间（摘要请求本身也占 input + output）。
3. **上下文越满，模型的注意力质量越差**（业界共识，「中间迷失」现象）。

第 3 条是最反直觉的：**上下文不是越满越好，甚至不是「满了才有问题」。**
塞满 90% 的窗口，模型对中段内容的利用率会显著下降——你付了钱，
但那些 token 没起作用。

### 7.10 本章自检

1. 上下文管理的三个敌人是什么？为什么它们互斥？
2. 五层管道里前三层的共同特点是什么？为什么这个特点是整个设计的价值所在？
3. 触发阈值为什么从百分比改成绝对值？举出百分比失效的两个具体场景。
4. 「完成缓冲区是地板而非减法」——用减法会白扔掉多少窗口？为什么这个损失是静默的？
5. microcompact 的两种模式，判据是什么？为什么「缓存已冷」反而是压缩的好时机？
6. 「这个信息丢了能不能重新拿到」——为什么 `read` 的输出能清而 `edit` 的不能？
7. 假压缩事故的链条有五层，最贵的伤害在哪一层？为什么？
8. 「修好一个静默失败的 bug 会暴露下一个 bug」——在压缩这条链上具体是什么？

---
<a id="8"></a>
## 8. 韧性：超时阶梯 / 重试 / 看门狗

前面七章都假设「请求会返回」。这一章处理它不返回的情况。这是 5000 行里占比最大的一块，
也是最容易写出「层数越多越不可靠」这种反直觉结果的一块。

### 8.1 为什么需要「层」：单个超时不够用

先想清楚一次流式请求可能怎么坏：

```
发出请求 ──?── 收到 header ──?── 收到首个内容 ──?── 持续吐字 ──?── 正常结束
         │                 │                  │              │
         ①连不上/网关排队    ②握手完但模型不出字  ③吐了一半卡住   ④永远吐不完
```

四种故障的「正常等待时长」差了两个数量级：

- ① 网关鉴权 + 排队，**实测 p95 已达 56s、最大 59.8s**（`stream-processor.ts:37` 注释）
- ② 模型 prefill，长 prompt 可能几十秒
- ③ 半开 TCP，可能永远不返回任何字节
- ④ 模型陷入重复输出，一直在吐但永不停

**用一个超时值卡这四种，必然要么误杀（阈值太小）要么形同虚设（阈值太大）。**
所以必须分层，每层用**不同的谓词**（判断依据）。

### 8.2 六层阶梯（实测数值）

sid-code 的超时阶梯（`packages/core/src/config/network-profile.ts` 实读）：

| 档 | 常量 | 默认值 | 谓词（判什么） | 作用域 |
| --- | --- | --- | --- | --- |
| ① | `idleTimeoutMs` | **240s** | **零字节到达**（真半开 TCP） | 一次 attempt |
| ② | `contentProgressTimeoutMs` | **480s** | **有字节但无有效内容**（keep-alive 不续命） | 一次 attempt |
| — | `fallbackStreamTimeoutMs` | **600s** | attempt 级无进展上限 | 一次 attempt |
| — | `watchdogNoProgressMs` | **720s** | 外层复核层的无进展上限 | 整轮 |
| — | `overallTimeoutMs` | **1500s** | 请求级绝对上限（不因事件重置） | 一次请求 |
| ③ | `maxTurnDurationMs` | **5400s**（90min） | **任何未知挂起根因**，不感知进展 | 整轮（含多 attempt + 退避） |

数值取向的原文（`network-profile.ts:203`）：

> 数值取向（保活优先；严格递增便于"哪一档开的枪"一眼可辨）：
> **① 240s < ② 480s < fallback 600s < watchdog 720s < overall 1500s < ③ 5400s**
> 相邻差值均 ≥ 120s，**不是同值错开的伪阶梯**。

**「严格递增便于一眼看出哪一档开的枪」是这个设计的核心价值。**
如果两层同值，你从日志里永远分不清是哪层触发的，也就修不了。

而这条不变量是**用测试守住**的（`network-profile.ts:206` 原文）：

> 数值哨兵与**谓词哨兵**都在 `tests/config/timeout-ladder-sentinel.test.ts`
> （**后者更重要**：数值哨兵拦不住"三个绝对计时器错开成 240/480/600"这种形态）。

> **「谓词哨兵比数值哨兵更重要」值得单独记住。**
> 数值不同但谓词相同，那是**伪阶梯**——三个都是绝对计时器，只是错开了数值，
> 本质上还是同一层，没有增加任何区分能力。
> **真正的分层是谓词不同，数值只是附带的。**

#### ★ 一个「注释腐坏」的现场实例（刻意留着没修）

这是全文最好的教学样本，因为它是活的。

`packages/core/src/query/stream-processor.ts:30` 的注释说：

> 默认取 network-profile 的 `watchdogNoProgressMs`（**300s**），与 loop.ts 外层看门狗同阈值。

而 `network-profile.ts:125` 的实际值是：

```typescript
watchdogNoProgressMs: 720_000,   // = 720s
```

**注释写 300s，实际 720s，差了 2.4 倍。**

同一个文件里另外两处注释，一处对一处错——**而这个「一半对一半错」正是注释腐坏最难缠的形态**：

| 位置 | 注释写的 | 实际值 | |
| --- | --- | --- | --- |
| `:30` | `watchdogNoProgressMs`（300s） | **720s** | ❌ 腐坏 |
| `:37` | `headerTimeoutMs`（300s） | 300s | ✅ 仍然正确 |
| `:46` | provider `overallTimeoutMs`（600s）／单轮硬顶 30min | **1500s** ／ **90min** | ❌ 腐坏 |

三处写法完全一样、可信度看起来完全相同，实际两错一对。
**你无法靠「读起来像不像真的」区分它们，只能逐条复跑。**

> 我写这一节时就栽了一次：第一版草稿断言「另外两处也都和现值不符」，
> 复跑 `grep` 之后才发现 `:37` 那处是对的。
> **在一篇讲「引用数字前先复跑」的文档里，我自己漏跑了一条。**
> 留着这段，因为它比任何说教都能说明这条纪律有多容易失守。

代码本身是对的——它读的是变量不是字面量（`stream-processor.ts:148`）：

```typescript
const HEARTBEAT_TIMEOUT = options?.heartbeatTimeoutMs ?? netTimeouts.watchdogNoProgressMs;
```

**所以这不是 bug，是注释腐坏。** 但它的危害很具体：
一个新人读这段注释，会以为心跳超时是 300s，然后拿这个数字去算「为什么我的请求
5 分钟就被杀了」——而真实阈值是 12 分钟，真凶在别处。

> **两条纪律**：
> ① **注释里写具体数值 = 制造一个必然腐坏的副本。** 宁可写「取 network-profile 的
>    `watchdogNoProgressMs`」而不带括号里那个数字。
> ② **引用任何文档/注释里的数字前，先复跑一次。** 本文附录 C 给了全部命令，
>    就是为了让你能在读的时候就验证。

### 8.3 重试：三个必须做对的细节

重试参数（`network-profile.ts:159`）：

```typescript
maxTimeoutRetries: 10,        // loop 层超时重试上限
maxRetriesPerCall: 12,        // provider 内部（连接+流）重试上限
retryBackoffBaseMs: 5_000,    // 退避基数
retryBackoffMaxMs: 120_000,   // 退避上限
```

取值理由（同文件原文）：

> 网关抖动/厂商限流往往需要几十秒到数分钟才恢复，旧值 4 次 + 30s 上限约 1 分钟就把机会耗尽。
> 现按"保任务成功"取 10 次，名义累计退避约 **12+ 分钟**。
> 退避基数从 2s 抬到 5s（**首次重试就给足恢复窗口**，避免"几秒就重试一次"打在仍未恢复的服务上）。

**「首次重试就给足恢复窗口」是一条容易忽略的原则**：
标准指数退避的第一次退避很短（2s），但如果故障是「网关限流」，
2 秒后重试 100% 还是被限流——**你只是白烧了一次连接。**

三个细节：

**细节 1：退避期必须可被 abort 打断。** 这有一个非常具体的事故
（`loop.ts:2636` 注释原文）：

> 根因（轨迹 20260730-142920-d98e7f16）：退避用裸 `setTimeout` 睡满，期间
> 会话级硬顶 abort 了也感知不到，醒来直接 continue 发下一个请求——实测
> 07:37:49.077 触发 session-timeout abort，07:37:53.491 仍发出 BeforeModel idx=47。
> UI 上先弹「会话已运行超过 60 分钟，已自动结束本轮」，紧接着又弹
> 「⟳ 正在重试（第 1 次）…」，**两个状态机各说各话。**

修法是 `sleepUnlessAborted(backoffMs, signal)` + **醒来后再复检一次 signal**。

> **「两个状态机各说各话」是这类 bug 的典型外观。** 用户先看到「已结束」，
> 又看到「正在重试」。**只要有一个 sleep 不响应 abort，整个中止链就有一个 4 秒的窗口
> 会做出与已决定的中止相反的动作。**

**细节 2：重试前必须清掉旧快照**（`loop.ts:2643` 注释原文）：

> Fix 2：重试前清除本轮旧快照，防止看门狗读到上次失败的**脏 `lastContentProgressAt`
> 立即误杀**。

重试是「重开一次」，但看门狗读的是共享快照。不清掉的话，
新 attempt 一出生就带着上一次失败时的「已经 720 秒没进展」状态，**出生即死**。

**细节 3：埋点里填的必须是真实耗时，不是配置常量。** 这个坑非常典型
（`loop.ts:2609` 注释原文）：

> 排查可用性修复（2026-08-05）：此前这里填的是 `netTimeouts.maxTurnDurationMs`
> ——一个**配置常量**（默认 1800000），不是真实耗时。轨迹里于是出现"第 1 次尝试、
> 开始才几秒，却报 `elapsed_ms=1800000`（30 分钟）"这种自相矛盾的记录，
> **把排查直接引向"单轮硬顶超时"的错误方向（真凶是 60s 心跳，差了 30 倍）。**

> **「埋点填了一个常量」是一类极其隐蔽的可观测性 bug**：
> 字段存在、类型正确、聚合不报错，唯一的问题是所有样本的值都一样。
> 而它的危害不是「少一个指标」，是**主动把排查引向错误方向**——
> 比没有这个字段更糟。

### 8.4 三种「不该计入业务时长」的等待

这一节是本章最精细的地方。看门狗要判断「多久没进展」，
但有三种「静默」不是故障：

| 静默来源 | 为什么不算故障 | 处理 |
| --- | --- | --- |
| **等用户**（权限确认弹窗） | 等的是人，不是 agent | `humanInputPauseAccumMs` 累计后扣除 |
| **系统休眠**（笔记本合盖） | 进程被冻结，定时器不 tick | `sleepPauseAccumMs` 累计后扣除 |
| **退避睡眠** | 是我们主动决定的等待 | 同上扣除 |

实读 `loop.ts:2181`：

```typescript
let humanInputPauseAccumMs = 0;   // 已结束的「等用户输入」段累计总时长
let sleepPauseAccumMs = 0;        // 系统休眠累计时长（进程被冻结，定时器不 tick）
```

真实耗时的算法（`loop.ts:2286`）：

```typescript
const businessElapsedMs =
  Date.now() - turnStartedAt - humanInputPauseAccumMs - sleepPauseAccumMs;
```

原文点出了原则（`loop.ts:2210`）：

> 与 `humanInputPauseAccumMs` 完全同构、同理由：**非业务时长不该计入业务预算**。

**人机闸门**的实现是一个引用计数器（`human-input-gate.ts` 文件头原文）：

> 背景（事故复盘 session 20260721-142757）：主模型失败触发 fallback 询问弹窗时，
> 弹窗是**阻塞等用户作答**的。此时没有任何 SSE 事件流动，于是：
>   - stream-processor 的心跳看门狗 → `abort("stream-heartbeat-timeout")`
>   - loop.ts 的无进展看门狗 → `abort("watchdog-timeout")`
> **弹窗被 abort 掐断** → `askUserQuestion` 返回 cancelled → 被误判成"用户取消/超时"，
> 触发 timeout-retry，**与弹窗形成双状态机打架、无限重试**。

设计要点两条（同文件原文）：

> - **引用计数而非布尔**：允许嵌套/并发的多个等待段，最后一个 end 才真正关闭。
> - 不持有任何 timer/promise：**纯状态查询，看门狗只读。**

而且它有一条明确的使用纪律：

> 真正阻塞等用户输入的代码段用 begin/end 包裹（**务必 try/finally 配对，
> 否则闸门永不关闭会架空看门狗**）。

> **这是一个非常典型的「防线的防线」问题**：闸门是为了防止看门狗误杀，
> 但闸门自己泄漏（begin 了没 end）就会**让看门狗彻底失效**。
> 所以闸门必须 `try/finally`，而且用引用计数而不是布尔——布尔在嵌套场景下
> 内层 end 会提前打开闸门。

**系统休眠**那条更妙。检测方法是：**定时器该 tick 的时候没 tick**
（`loop.ts:2247` 附近）。如果周期检查间隔是 5s，而两次检查之间过了 300s，
那中间 295s 进程是被冻结的。CLAUDE.md 里也记了这条：

> **一个宿主层的坑：休眠会污染耗时**

### 8.5 ★ 「轮数预算被网络故障偷走」——一个用数据自证的缺陷

这是全章最值得学的一个案例，因为它展示了「一个指标怎么自己证明自己被污染了」。

**现象**：无头评测里出现 7 个 `error_max_turns`（打满 40 轮上限）。
直觉结论是「上限不够用，调大 `--max-turns`」。

**实测（`types.ts` 的 `turnsConsumedWithoutAssistant` 注释，原文）**：

> `queryLoop` 的 `while (turnCount < maxTurns)` 一进来就 `turnCount++`，是在**发请求
> 之前**；而 SDK 侧的 `num_turns` 只在 `assistant_message` 事件上 `++`。于是一个被
> watchdog 强杀、零内容产出的轮次：**占掉一格 maxTurns 预算，却在 `num_turns` 里完全隐身**。
>
> 真实 benchmark 上 7 个 `error_max_turns` 样本**全部满足**
> `num_turns + WatchdogKill 次数 = 41`（**7/7**）—— 其中两题 `num_turns` 只有 **34**，
> 各被 watchdog 杀了 7 次。它们实际只拿到 34 次真正的模型交互机会，
> 却被报成"打满了 40 轮上限"。

**那个 `7/7` 的不变量是这个分析的全部说服力来源。** 不是「我觉得可能是网络问题」，
而是「7 个样本全部满足 `num_turns + WatchdogKill = maxTurns + 1`」。

**两个后果，第二个更贵（原文）**：

> 1. 本该解出的题因预算被偷而解不出（服务「更准」）。
> 2. **"打满上限"与"上限够不够用"之间插了一层网络故障** —— 看到
>    `error_max_turns` 的人会去调 `--max-turns`，而**真凶是上游掉流**。

**修法的选择过程比修法本身更值得学（原文）**：

> 曾考虑「被杀的轮次不 `turnCount++`」。**否决**：那样上游持续故障时循环
> **永不收敛**（每次都退回同一格），把一个「预算被偷」的缺陷换成一个「无限重试」的缺陷 ——
> 而后者在无头评测里会一路烧到 1 小时硬顶。所以**预算照扣（保留收敛性），
> 但把被偷的格数如实记下来并透出**，让 `error_max_turns` 能自证
> 「40 格里有几格根本没换来一次模型交互」。

> **这是一个教科书级的取舍**：直觉修法（不扣预算）会把一个「统计偏差」缺陷
> 换成一个「无限循环」缺陷。**正确的选择是保留有缺陷的行为，但让它可归因。**
> 于是 `max_turns` 事件带上了 `turnsConsumedWithoutAssistant`：
> 0 = 真的是上限不够用，非 0 = 有几格被偷了。

还有一条计数纪律（`loop.ts:2597` 原文）：

> ⚠️ 只在**重试真的会发生**的这一支记（`timeoutRetryCount < maxRetries`）。
> 记在 `isTimeoutError` 那个 if 的外层会把「重试耗尽、随后 return 收尾」
> 那一次也算进去 —— 而那一格并没有被"偷"，它是本轮的正常终点。
> **判据必须与"下面会 continue"逐字同源**，否则计数会系统性高一。

> **「判据必须与下面那个动作逐字同源」是一条可以到处用的纪律。**
> 计数器和它计的那个动作，判据必须是同一份代码/同一个条件。
> 两处分别写，两处就会漂移，而漂移的方向通常是「系统性偏高一」这种
> 看起来很像正常波动的形态。

### 8.6 降级与 tombstone：撤回已经吐出去的话

主模型挂了要切备用模型。但流式场景有个特殊问题：
**主模型已经吐了半截文本到屏幕上了。**

实读 `loop.ts:3101`：

```typescript
if (deps.checkFallbackOccurred?.()) {
  log.info("QUERY_LOOP", "检测到模型降级，yield tombstone 通知上层清理残留内容");
  const assistantMsg = { role: "assistant" as const, content: response.content };
  yield { kind: "tombstone", message: assistantMsg, reason: "模型降级，使用备用模型重试" };
  deps.resetFallbackFlag?.();
}
```

**tombstone（墓碑）消息的语义是「把这条撤回」。** 不撤回的后果很具体
（`stream-processor.ts:70` 注释原文）：

> 少了它的后果（2026-08-04 事故的用户可见面）：作废尝试的文本已经通过 `onText`
> 流到屏幕上了，重置只清了内部累加器，**屏幕上那段孤立叙述留在原地**——
> 用户看到「§六已完成…」紧跟「§7.5 已更新…」两段**互不衔接**的话。

> **这是「流式」这个特性的固有代价**：一旦吐出去了就收不回来，
> 除非你显式设计一个撤回通道。**任何「先输出后作废」的路径都需要一个 tombstone。**
> 而且撤回必须做到 UI 层——只清内部状态是不够的，那是事故的原因。

### 8.7 一个必须知道的教训：层数是负资产

这条来自 CLAUDE.md（Provider 那份文档的同源结论），在超时这块尤其成立。

`network-profile.ts` 里有一个被**默认关闭**的第四层绝对计时器
（`fetchAbsoluteTimeoutMs`），关闭理由（原文）：

> **三条理由，每条都是"确定成本"而收益近零**：
> 1. **它声称的职责已被双重覆盖。** 注释原话是"打破 SSE 半开、reader 永不 settle
>    的 hang"。但半开时正是**零字节到达** —— 那本就是档① 的领地，且档① 的归因是
>    `idle_timeout`（**说得出是哪一层、哪个阈值**）；而"任何未知挂起根因"的兜底是档③。
> 2. **它是唯一把 deadline 委托给 runtime 的一层**，runtime 的 abort
>    **不携带可归因的 reason** —— 于是它抛出的 `DOMException("TimeoutError")`
>    既非 `RetryableError` 也非 `TerminalError`。

> **「谓词与已有层重合」+「归因能力更差」= 应该删掉的层。**
> 判断一个超时层要不要留，问两个问题：
> ① 它的谓词和现有层重合吗？② 它开枪时说得出「是我、因为这个阈值」吗？
> 第二个问题特别关键——**一个不能自证的计时器，触发之后会让排查变难，不是变易。**

还有一个漂亮的连带论证（`network-profile.ts:98` 原文）：

> `maxTurnDurationMs` 90min **必须与上面的放宽同批次抬**，否则 `fallback.ts` 的 S3 判据
> （`remaining <= effectiveDelayMs + MIN_USEFUL_ATTEMPT_MS` → 停止重试）
> 会先把重试预算判死：最坏路径是 3 个 attempt 各跑满 720s + 2 次退避各 120s
> ≈ 2400s，撞破旧的 30min 硬顶 —— 等于"**为了保成功放宽了超时，
> 却把保成功的另一半（重试）关掉了**"。

> **这是一个「放宽一个参数会关掉另一个机制」的完整推导。**
> 放宽单层超时 → 单 attempt 变长 → 累计时长撞硬顶 → 硬顶的存在让重试预算提前判死
> → 净效果是**更不容易成功**。改参数时必须算「最坏路径的累计时长」，
> 不能只看单层数值。

### 8.8 看门狗为什么必须比 provider 层更宽松

这条极其反直觉，但论证非常干净（`network-profile.ts:96` 原文）：

> `watchdogNoProgressMs` 720s：外层复核层的"无进展"上限。**必须比 provider 层的
> 档②（480s）与 fallback 层（600s）都更宽**：
> watchdog 是**远端观察者**，读的是 provider 广播出来的快照，**掌握的信息严格少于
> provider 自己** —— **信息更少的一层更激进，就会在 provider 还没判定之前先开枪。**

> **「信息更少的层必须更宽松」是一条可以推广到所有分层守卫的原则。**
> 外层的信息是内层广播出来的，必然滞后且不完整。
> 外层比内层激进 = 外层用更差的信息抢先做决定，而且它做的决定（强杀）
> 会让内层那个信息更全的判定永远不会发生。

### 8.9 本章自检

1. 为什么一个超时值卡不住四种故障？四种故障的谓词分别是什么？
2. 「谓词哨兵比数值哨兵更重要」——什么叫伪阶梯？举一个数值不同但仍是伪阶梯的例子。
3. `stream-processor.ts` 注释写 300s 而实际是 720s，这是 bug 吗？危害是什么？该怎么写注释？
4. 退避睡眠不响应 abort，会产生什么用户可见的现象？
5. 埋点里填了配置常量而不是真实耗时——为什么这比「没有这个字段」更糟？
6. 「轮数预算被偷」这个缺陷，为什么修法不是「被杀的轮次不计数」？
7. 「判据必须与下面那个动作逐字同源」——不同源会产生什么形态的偏差？
8. 为什么外层看门狗必须比内层 provider 超时更宽松？

---
<a id="9"></a>
## 9. 空转与死循环：为什么检测默认关闭

§4 的 D 类（病态干预）在这一章展开。它回答两个方向相反的问题：
**模型在原地转圈怎么办**，以及**模型太早收工怎么办**。

这一章最值得看的不是那些检测器，而是**一个团队怎么用自己的数据推翻自己写好的功能**。

### 9.1 教科书答案：检测重复，然后掐掉

```javascript
// 直觉方案
if (最近 3 次工具调用完全相同) 判为死循环 → 终止;
```

这个方案有两个问题，第二个是致命的：

1. 「完全相同」太窄——模型通常会微调参数（换个 grep pattern），绕开检测。
2. **放宽到「形状相同」之后，误判率会爆炸。** 下一节就是这个的实测数据。

### 9.2 ★ 一个团队用数据推翻自己的功能（本章核心）

sid-code 写了两个循环检测器（`agent/loop-detection.ts`，728 行）：

- `ExactLoopDetector` —— 连续 N 次**完全相同**的工具调用
- `ToolShapeLoopDetector` —— 连续 N 次**形状相同**（同 toolName + 同 key-set，忽略 value）

默认配置（`loop-detection.ts:35`）：

```typescript
export const DEFAULT_LOOP_CONFIG = {
  toolCallThreshold: 3,      // 连续 3 次相同工具调用
  contentThreshold: 10,      // 相同内容块出现 10 次
  contentChunkSize: 50,
  maxRecoveryAttempts: 3,
  toolShapeThreshold: 7,     // 滑动窗口 10 次内出现 7 次同 shape
  toolShapeWindow: 10,
  recoveryExhaustedAction: "continue",
};
```

**然后他们把整个功能默认关掉了。** 判据（`loop-detection.ts:731`）：

```typescript
export function isLoopDetectionEnabled(): boolean {
  return process.env.SID_ENABLE_LOOP_DETECTION === "1";
}
```

理由那段注释是全文最值得完整读的一段（实读原文，为可读性分段）：

> 为什么默认关闭（2026-07-07 决策，**推翻此前 P0-1 的"默认全局启用"**）：
> **主依据是实测误判率，不是"对齐 CC"这个类比**（类比只是旁证，见文末）。

先注意这句：**「主依据是实测，类比只是旁证」**。这是一个方法论声明——
「CC 也这么做」不能作为主要理由。

> shape 检测把工具调用降维成"toolName + key-set + anchor 字段"的形状指纹，**故意丢弃
> 参数 value**——这让它天然无法区分两类**语义相反**的行为：
>   - 真死循环："反复用不同 pattern 探测同一个不存在的目标"
>   - 正当推进："系统性操作同类目标下的多个不同对象"（如 /commit 连跑 git diff/add/
>     commit/log、系统性 grep 多个不同 symbol、连续跑测试/构建命令）

这是**结构性缺陷**，不是阈值调不好：两类行为在丢弃 value 之后的投影是**同一个东西**。
任何阈值都区分不了它们。

> 对 bash **尤其严重**：bash 的 command 值不进 shape key、又没有 path/cwd 等 anchor 字段，
> 于是**所有 bash 调用的 shape key 全退化成同一个字符串**，检测器实际变成"滑动窗口内
> bash 调用数 ≥ 阈值就误判循环"，**完全无视命令内容**。

**然后是实测（同注释原文）**：

> **实测证据（2026-07-14，`scripts/loop-detection-probe.ts` + `loop-stats-probe.ts`）**：
> - 探针：8 条语义完全不同的 bash 命令（git status / rm -rf / release.sh …）shape key
>   **全部塌成同一串** `bash::keys=[command]::anchors=(none)` —— 退化实锤。
> - 回放 42 个真实会话：模拟开 shape 检测有 14 个会话命中，抽样 **14/14 全是**
>   "git status→diff→log 巡检 / 发布流程 / 系统性 glob"等正当操作 —— **会话级误判率 ≈ 100%**。
> - 模拟开 exact 检测仅 **1/42** 命中，且唯一命中还是低危的 commit 后 status 轮询 —— **召回 ≈ 0**。
>
> 两个检测器都拿不到净收益，这是"默认关闭"的**决定性依据**。

把这三个数字并排看：

| 检测器 | 命中 | 其中真死循环 | 结论 |
| --- | --- | --- | --- |
| shape | 14 / 42 会话 | **0 / 14** | 误判率 ≈ 100% |
| exact | 1 / 42 会话 | 那 1 个是低危轮询 | 召回 ≈ 0 |

**一个全是误报，一个什么都抓不到。** 这就是「拿不到净收益」。

> **这一节的方法论值得单独拎出来，它可以用在任何「我们做了个检测/防线」的场合**：
>
> 1. **先做退化探针**：构造 8 条语义完全不同的输入，看你的指纹函数是不是把它们
>    全映射成同一个值。**如果是，这个检测器已经死了，不用再测阈值。**
> 2. **再做真实会话回放**：拿真实历史数据模拟开启，统计命中数。
> 3. **然后人工抽检每一个命中**：这一步是关键。命中数不是收益，**命中里有几个是真的**才是。
> 4. **两个数一起报**：误判率（命中里几个是假的）+ 召回（真问题里抓到几个）。
>    只报一个数就是片面的（对齐 CLAUDE.md 的「分母比分子重要」）。

还有一条对「对齐 CC」这个论据的诚实限定（同注释原文）：

> 旁证（非主依据）：Claude Code 源码也**不做**任何 agent 工具调用循环检测（已核实）。
> 但注意 **CC 敢不做的前提是它只跑自家强模型**；接入弱模型（如 deepseek-v4-pro）时
> 不能仅凭"对齐 CC"照搬关闭 —— 真正的兜底是 costLimit / 轮次上限 / 用户 ESC，
> **而交互模式下 maxTurns 默认 Infinity、costLimit 默认不设**，
> 关掉检测后交互模式实际**只剩用户 ESC 一根兜底**。

> **「照搬别人的默认值之前，先问它的前提在你这儿成不成立」。**
> CC 不做检测的前提是「只跑自家强模型」。sid-code 要接弱模型，
> 这个前提不成立，所以不能照搬结论——**只能照搬方法（用数据决定），不能照搬结论。**

最后是可逆性（原文）：

> **代码不删除、仅默认关闭**（env 门控），保留可逆性。

**这是一个成熟的处理**：这些检测器在「接入弱模型」场景下确实有用。
删掉就没得选了，默认关闭 + env 门控让需要的人能开。

### 9.3 那么真正默认开启的是什么：三道极窄的阀

既然通用检测不可用，就只保留**被实证过的窄形态**。sid-code 有三道默认开启的阀，
每一道都对应一个具体的、有会话号的真实死循环。

#### 阀一：`repeated-readonly-guard` —— git 快照冻结死循环

背景（`repeated-readonly-guard.ts` 文件头原文）：

> 背景（会话 20260710-164407）：git-status 快照在会话初始化时**冻结进 system prompt，
> 整会话不刷新**。当模型连续 3 次 `/commit` 把脏工作区提交干净后，冻结快照仍显示
> "10 个文件待处理"，与 bash 实时 `git status --short` 返回的"(空)"**长期矛盾**。
> 弱模型（deepseek-v4-pro）**无法仲裁这对方向相反的事实源**，在一个已经干净的工作区上
> 反复空跑 `git status --short` **11 轮**直到用户 ESC —— **任务其实早已 100% 完成。**

**根因不在模型，在 harness 给了它两个互相矛盾的事实源。**
一个冻结的快照说「有 10 个文件待处理」，实时命令说「干净」。
强模型能判断哪个更可信，弱模型会卡死。

> **这是一个极重要的教训：给模型两个矛盾的事实源，比给它一个不完整的事实源更糟。**
> 冻结快照的本意是省 token（不用每轮重新跑 git status），
> 代价是它会和真实世界漂移，而漂移之后模型无法仲裁。

为什么它敢默认开（同文件原文）：

> **默认全局启用**：与 loop-detection（默认关，靠 shape 易误判）不同，本阀只盯"完全相同
> 命令 + **完全相同输出**"这一极窄且高确定性的模式，**误伤面极小**，故默认开。

判据阈值 `STUCK_REPEAT_THRESHOLD = 3`（原文注释）：

> 取 3：**给模型两次自我纠正机会后才介入。**

这道阀还修过一个自己的 bug（同文件原文）：

> ★根治「git 快照冻结死循环」缺口 B：历史死循环里模型是
> `git status`(bash) → `read×3` → `git status` **交替空转**，而旧逻辑把"本轮出现任何
> 非 bash-probe 工具（含 read）"一律当"有进展"清零，**连续计数永远到不了阈值。**

修法是把只读检查类工具（`read`/`ls`/`glob`/`grep`/`lsp`…）也折叠进探查签名，
而不是当成进展信号。**判据变成「只有写操作或输出不同的新探查才算真进展」。**

> **「什么算进展」这个定义，比「什么算重复」更容易写错。**
> 旧逻辑把「调了个 read」当进展，于是模型只要在两次 git status 之间插一个 read，
> 就能永久绕开检测——而且它不是故意的。

#### 阀二：`low-yield-spin` —— 低信息量空转

这道阀的背景是全文最生动的一个案例（`low-yield-spin.ts` 文件头原文）：

> 背景（会话 20260810-214525-2df54593，13:55:30 – 14:04:14 窗口）：
> 模型 **8 分 44 秒、约 30 轮、edit 次数 = 0**，唯一动作是反复跑同一条命令 **33 次**：
>
> ```
> cd <repo> && bunx tsc --noEmit 2>&1 | grep -c "error TS"
> ```
>
> 返回值序列 `139 ×22 → 136 ×7 → 113 ×9`。**每轮花约 6 秒拿回一个数字**，
> 得不到任何可执行信息，于是只能再想一遍策略 —— 这是由"**低信息量观测**"驱动的稳定死循环。

**对照组极有说服力（同注释原文）**：

> 对照组 CC 跑同一任务时的形态是
> `cmd > /tmp/e.txt 2>&1; wc -l /tmp/e.txt; grep <域> /tmp/e.txt`
> —— 每轮既拿到总数又拿到**这一批要处理的具体错误行**，错误数单调递减
> 267→60→…→21。
>
> **同样是"重复跑 tsc"，一个每次都拿到下一步动作，一个每次只拿到一个数字。**

> **这个对照是全文最好的一个洞察**：死循环的根因不是「重复」，
> 是**「每次重复拿回的信息量不足以决定下一步」**。
> 同一条命令，输出是完整错误列表时反复跑只是浪费；
> 输出是单个数字时反复跑会形成**认知死锁**——模型没有新信息，
> 只能反复重想同一个策略。

判据是四条 AND，刻意极窄（同注释原文）：

> 1. 本轮**没有任何文件落盘**（edit/write/notebook_edit）——有落盘就是在干活；
> 2. 本轮**没有面向用户的文本产出**，只有 thinking + 工具调用——即"只思考不交付"；
> 3. 本轮的命令签名与上一轮**逐字节相同**；
> 4. 该命令的输出是**单个标量**（`grep -c` / `wc -l` 只回一个数字）**且与上一轮相同**。

第 4 条是关键分工（原文）：

> 第 4 条是与 `repeated-readonly-guard` 的关键分工：那道阀盯"只读探查命令 + 输出不变"，
> 本阀盯"**输出信息量本身就低**（单标量）+ 不变"。
> 判据用"**输出形态**"而非命令名，故**不硬编码 tsc**（换 cargo check / pytest 同样命中）。

而**介入方式**是本节最实用的一点（原文）：

> 介入话术给**可执行指令**而非训话：这是本项的核心。事故里模型自己已经说了 **8 次**
> "我需要停止反复思考，直接开始修复" —— **它不缺决心，缺的是"下一条命令该敲什么"。**
> 再催一遍"请推进"只会加重空转，故文案直接给出落盘 + 计数 + 切片的替代命令。

> **「模型说了 8 次『我要停止反复思考』然后继续反复思考」** ——
> 这一句话就否掉了整个「注入提醒催它推进」的思路。
> 模型不是不想推进，是它的观测方式不给它下一步。
> **所以正确的干预是「换一种观测方式」，不是「催」。**

阈值 `LOW_YIELD_SPIN_THRESHOLD = 5`（比前一道阀的 3 更宽松，因为覆盖面更广），
封顶 `MAX_LOW_YIELD_INTERVENTIONS = 2`，且注释明写：

> 达上限后沉默——本阀**绝不**强制收尾。

#### 阀三：`measured-progress` —— 假的进展信号造成的正反馈

同一个会话（20260810-214525）还暴露了第二个缺陷，形态完全不同
（`measured-progress.ts` 文件头原文）：

> work-log 回注给模型的"已完成 N 项"唯一数据源是 todo 状态。模型全程
> 只调了 3 次 `todo_write` 且每次 `completed: 0`，于是 harness 每 8 轮告诉它
> "已完成 0 项：（无）"。**而同期真实进展是 7 个文件已落盘、可量化检查指标从 139 降到 113。**
> 这个假信号形成**正反馈**：
>
> ```
>   模型没标 completed → work-log 报"已完成 0 项" → 模型以为自己白干了
>     → 重新梳理策略而不是继续干 → 更不会去标 completed ┐
>     └──────────────────────────────────────────────────┘
> ```

**harness 每 8 轮告诉模型「你什么都没做」，而它已经改了 7 个文件。**
这是 harness 主动制造的死循环。

修法是加第二个事实源（原文）：

> 1. `filesChanged`：edit/write/notebook_edit **真实落盘过哪些文件**——这是**不可伪造的副作用**；
> 2. `metrics`：**可量化观测值**的首末变化（如 139 → 113）。

而「为什么不硬编码 tsc」那段注释，是本文关于「泛化」讲得最好的一段（原文）：

> harness 不知道、也不该知道用户项目的检查命令是什么（tsc / cargo check / pytest / make lint /
> 自研脚本），把命令名写进 harness 等于只对 TypeScript 项目有效，换个语言这条信号就**静默失效**——
> 而"**静默失效的信号比没有信号更糟**"（它会让下一轮排查以为这里已经有覆盖）。
> 改用**形态判据**：同一条命令被反复执行、其输出可解析成单个标量 → 就是一个可量化观测值。

还有一条关于「不替模型下价值判断」的纪律（原文）：

> 方向不做解释（只报 139 → 113，**不判定"降了就是好"**）——是升是降由模型自己结合任务判断，
> harness 不替它下价值判断，避免"**错误数升高但那是新增测试暴露出来的**"这类误导。

> **「harness 报事实，不报解释」是一条很成熟的边界。**
> 「错误数从 139 降到 113」是事实；「进展良好」是解释。
> 而解释可能是错的——新增测试导致错误数上升，恰恰是进展。

### 9.4 反方向：模型太早收工

`token_budget_continuation`（§4 的 ⑮）管的是相反的病态。

用户可以在消息里写 `+500k` 表示「这个任务我给你 50 万 token 预算，别省」。
解析规则（`token-budget-continuation.ts:36`）：

```typescript
const match = text.match(/\+(\d+(?:\.\d+)?)\s*([kKmM])\b/);
```

**强制要求 k/m 后缀**，理由很实在（原文）：

> 强制要求 k/m 单位后缀——这是避免误判的关键：**电话号码**（+8613800001234）、
> **算式**（+5）、版本号等场景里的裸数字都没有 k/m 后缀，天然不会命中。

范围 `[MIN_TOKEN_BUDGET = 10_000, MAX_TOKEN_BUDGET = 20_000_000]`，超出即 clamp。

注入的提示（`token-budget-continuation.ts:43`）：

```
[预算续写] 当前任务设定了 token 预算，已用约 N tokens，预计还剩约 M tokens。
如果你认为当前工作已经完整、没有更多有价值的内容可以补充，可以直接结束；
否则请继续深入完善（比如：补充测试、检查边界情况、完善文档、复核实现细节）。
```

**注意措辞给了模型明确的退出许可**（「可以直接结束」）。
不给退出许可的话，这条提示会变成一个逼模型无限续写的引擎——
它会为了「花完预算」而写垃圾。

### 9.5 ★ 一个贯穿全章的取向：耗尽后放行，而不是终止

回到 §4.3 那张表里 C 类和 D 类的「耗尽后放行」。这里集中论证。

判据在 `loop-detection.ts:28`（原文）：

> `recoveryExhaustedAction` 恢复次数耗尽后的处置策略：
> - **`"continue"`（默认，保成功优先）**：注入最终强提示后**继续放行**，把"停不停"交给模型自己。
>   真死循环模型会 end_turn / 用户会 ESC / costLimit 会兜底；**被误判的正当长任务能存活。**
>   这是"**优先保成功、不首先防坏**"的取舍——避免一次循环误判废掉跑了几十轮的复杂任务。
> - `"terminate"`：旧行为，耗尽即终止整个任务（防失控优先，弱模型场景可 opt-in 回退）。

把两种错误的代价摆出来：

| | 误杀（终止了一个正当长任务） | 放过（让一次空转多跑几轮） |
| --- | --- | --- |
| 代价 | **几十轮的工作全废**，用户要从头再来 | 多烧几轮的 token |
| 可恢复性 | 差（上下文没了，得重新描述任务） | 好（用户 ESC 即可） |
| 用户感受 | 「这工具会无理由掐我的任务」 | 「这工具有时候会绕圈」 |

**误杀的代价高一个量级，而且不可恢复。** 所以默认取向是放行。

这个取向在四个地方一致出现，这种一致性本身就是设计质量的信号：

| 位置 | 表现 |
| --- | --- |
| `loop-detection.ts` | `recoveryExhaustedAction: "continue"` |
| `stop-hooks.ts` | 重试耗尽 → `{ shouldContinue: false, forceStop: false }`（放行） |
| `low-yield-spin.ts` | 「达上限后沉默——本阀**绝不**强制收尾」 |
| `soft-turn-limit.ts` | 「**软提示、不强杀**……绝不 yield done 掐断」 |
| `loop.ts:4892` | 「continue（默认，**保成功优先**）：注入最终强提示 + 软重置检测器后**继续放行**」 |

> **面试可以直接用这段**：「我们所有启发式防线的取向是『耗尽后放行，不终止』。
> 理由是两种错误的代价不对称——误杀一个跑了 40 轮的正当任务，
> 用户要从头描述需求重来；放过一次空转，用户按 ESC 就行。
> 前者不可恢复，后者可恢复，所以默认偏向放行。
> 需要防失控优先的场景（比如无头评测接弱模型）可以 opt-in 切成终止。」

### 9.6 本章自检

1. shape 检测为什么存在**结构性**误判（不是阈值问题）？bash 的退化具体是什么？
2. 「退化探针」怎么做？为什么它应该在调阈值之前做？
3. 42 个会话回放里，shape 检测命中 14 个。为什么「命中 14 个」不是收益？还要报哪个数？
4. 「照搬 CC 的默认关闭」为什么不够？CC 敢不做检测的前提是什么？
5. 「git 快照冻结」死循环的根因在模型还是在 harness？为什么说「两个矛盾的事实源比一个不完整的更糟」？
6. tsc 空转那个案例里，为什么「催模型推进」无效？正确的干预是什么？
7. harness 报「已完成 0 项」而实际改了 7 个文件——这个假信号怎么形成正反馈？
8. 「耗尽后放行而不是终止」的论证是什么？两种错误的代价怎么不对称？

---
<a id="10"></a>
## 10. 可观测：怎么证明这个循环是好的

前面九章讲了「怎么做」。这一章讲**「怎么知道做对了」**。

它不是可选的收尾章。CLAUDE.md 把这件事说得很重：

> **它不是技术细节，是四大方向的载体**：没有轨迹就画不出那四条曲线。

也就是说：**没有埋点，前面九章所有的优化都无法证明。** 你说「我们把延迟降了 30%」，
凭什么？

### 10.1 循环的四个锚点事件

实测（命令见附录 C），主循环相关的 trace 事件：

| 事件 | 发在哪 | 锚定什么 |
| --- | --- | --- |
| `StreamPhase(first_content)` | `trace/stream-observer.ts:440` | **TTFT**（首字内容） |
| `LoopTransition` | `query/transition.ts:18` | **为什么 continue**（15 种理由） |
| `TurnComplete` | `query/turn-complete.ts:216` | **端到端耗时**（用户回车 → 最终答复） |
| `WatchdogKill` | `trace/stream-observer.ts:1027` | **哪一层开的枪** |

四个事件覆盖了四个不同的问题：慢在哪、为什么不停、一整轮多久、被谁杀了。

### 10.2 ★ `TurnComplete` 的诞生过程：为什么必须新开一个事件

这一节是全章最值得学的，因为它演示了**「一个指标为什么不能靠派生」**。

需求很朴素：想知道**端到端耗时**（用户回车 → 最终答复）。

**尝试一：用现有的加起来。** 不行（`turn-complete.ts:5` 原文）：

> 现有的是 TTFT（首字节）与生成段耗时，两者相加**也不等于**端到端 ——
> 中间还有工具往返、JIT 注入、权限确认、重试等待。

**尝试二：从 `LoopTransition` 派生。** 也不行，理由非常干净（原文）：

> `setTransition()` 只在**继续循环**时发事件（函数职责就是"记录 continue 原因"），
> 而轮次结束是**退出循环**，天然不经过它。
> 实测 `LoopTransition.type` 只有 4 个取值（`tool_use` 767 / `todo_gate_retry` 1 /
> `timeout_retry` 2 / `unanswered_retry` 1），**没有 `end_turn`**。
> 于是"最终答复时刻"这个最重要的锚点反而是唯一没有事件的时刻。

**尝试三：用邻近事件近似。** 试了，失真（原文）：

> 只能用「下一个 `UserPromptSubmit` 之前的最后一个 `AfterModel`」近似 ——
> 那个近似在会话中断、用户中途 ESC、多轮嵌套子代理时全部失真
> （**实测派生出 p95 758.7s，明显被污染**）。

**尝试四：把「结束」塞进 `LoopTransition`。** 否决，理由是语义污染（原文）：

> 它的语义是"继续"，混进一个反义值会让所有现有消费方的 `type` 分支都需要重新审视
> （`trace/digest.ts` 已经在按 `type === "todo_gate_retry"` 过滤）。

**所以只能新开一个事件。**

> **这四次尝试的顺序值得记住，它就是「该不该新增埋点」的判据链**：
> ① 能用现有的算出来吗？② 能从现有事件派生吗？③ 能用邻近事件近似吗（近似的失真有多大）？
> ④ 能扩展现有事件的语义吗（会不会污染现有消费方）？
> **四条都不行，才新开一个事件。** 而且第 ③ 步必须给出失真的**实测数字**
> （758.7s 那个），不能只说「感觉不准」。

### 10.3 三条口径铁律（可以直接搬到任何埋点上）

`turn-complete.ts` 文件头（原文）：

> 1. **差值在发事件时当场算，不留给消费侧配对**。配对式口径已经栽过一次
>    （watchdog 快照注册用 `turnCount`、查用 pair index，**结构性恒 null**）。
> 2. **每轮重设基准**，绝不跨轮累计（同 TTFT 那个 bug 的形态：基准不重设让
>    thinking 模型虚高数十秒）。
> 3. **异常/中断轮次也必须发**。只在成功路径发事件会造成**选择偏差** ——
>    慢轮次往往正是被中断的那些，漏掉它们会让 p95 **系统性偏低**，
>    "看起来变快了"其实是把慢样本筛掉了。**这是本文件唯一不可妥协的一条。**

逐条拆：

**铁律 1（当场算，不留配对）** —— 配对需要两个事件用同一个 key。
两处分别写 key，两处就会漂移，而漂移的结果是**恒 null**（永远配不上）。
恒 null 的可怕之处是它看起来像「这个场景没发生过」，而不是「我算错了」。

**铁律 2（每轮重设基准）** —— TTFT 那个 bug 的量级（`types.ts` 原文）：

> 重试循环外只设一次基准，于是 thinking 模型的首字节延迟被算成"整轮生成耗时"，
> **实测合成 53.7s vs 真实 4.9s。**

**11 倍的虚高。** 而且方向是虚高，所以你会去优化一个不存在的问题。

**铁律 3（异常轮次也要发）** —— 这条是三条里最重要的，也是最容易违反的。
「只在成功时记录」是一个极其自然的写法（`try { ...; emit(); } catch {}`），
而它的效果是**系统性筛掉慢样本**。

> **这条铁律有一个非常好用的自检问题**：
> **「如果这个流程现在崩了，我的埋点会发出什么？」**
> 如果答案是「什么也不发」，那你的 p95 是假的。
> 这和 Monitor 工具的那条纪律同源——只匹配成功标志的过滤器，在崩溃时保持沉默，
> 而沉默看起来和「还在正常跑」一模一样。

### 10.4 口径诚实：不能剔除的就标记出来

`TurnComplete` 的耗时**包含**权限确认弹窗的等待时间。这是个瑕疵，
但处理方式很值得学（`turn-complete.ts` 原文）：

> `elapsed_ms_since_prompt` 里包含权限确认弹窗的等待 —— 那段等的是人，不是 agent。
> **刻意不剔除**：剔除需要再引两个事件（弹窗开/关）并保证配对，收益不足、失真风险
> 更高。改为在发生过确认的轮次上打 `had_hitl: true`，**让消费侧自己决定是否排除**。
> 这样口径诚实，且不引入任何配对。

> **「不剔除，但标记出来」是处理已知瑕疵的正确方式。**
> 三个选项：① 假装没问题（不诚实）② 引入配对去剔除（引入铁律 1 禁止的形态）
> ③ 保留瑕疵 + 打标记让消费侧选择。**③ 在信息量上不输 ②，而且不引入新的失真风险。**

注意这里和 §8.4 的对比：**看门狗**里那三种等待是**真的扣除**了的
（`humanInputPauseAccumMs`），因为看门狗要用它做**判断**（该不该开枪）；
而 `TurnComplete` 只是**报告**，报告可以带标记让消费侧自己算。

> **「用来做判断的口径必须干净，用来做报告的口径可以带标记」** ——
> 这个区分能省掉很多不必要的工程。

### 10.5 `hadHitlThisTurn`：为什么必须是差值而不是布尔

一个小细节，但它是本文出现过第三次的同一个坑（`turn-complete.ts:58` 原文）：

> 为什么是累计计数而不是布尔标志：`hadHitlThisTurn` 必须由**前后差值**判定。
> **布尔标志一旦被某轮置真，后续每轮都会被误标成"有 HITL"**
> （同 `LoopState` 上那些一次性标志位踩过的坑）。
> 计数器 + 轮首快照 + 轮末比较，才能如实回答"本轮有没有"。

以及挂载位置的讲究（原文）：

> 挂 `SessionState` 而非 `LoopState`：`LoopState` **每条用户消息重建**，
> 而权限确认发生在 `tool-executor` 里、跨用户消息累计，放 `LoopState` 拿不到。

> **「回答『本轮有没有』要用差值，不能用标志位」** ——
> 这个坑在本文出现了三次（§3.1 的重试计数器、§4.4 的 one-shot 标志位、这里）。
> 三次的形态完全一样：**一个跨轮存活的变量被用来回答一个「本轮」的问题。**
> 判据：**变量的生命周期必须和问题的时间粒度匹配。**

### 10.6 CLAUDE.md 的口径纪律，用循环的例子对照

CLAUDE.md 列了四条跨方向通用铁律。用本章的例子对照一遍：

| 铁律 | 循环里的对应例子 |
| --- | --- |
| **一律看 p95/p99，均值会骗人** | 慢尾巴是用户流失点。均值会被大量快轮次拉平 |
| **每个指标必须能指到源字段** | 端到端耗时 → `TurnComplete.elapsed_ms_since_prompt`，说不出源就是自我感觉 |
| **分母比分子重要** | 「命中 14 个会话」的分母是 42（§9.2）。不说分母，14 这个数没意义 |
| **区分 stock 与 flow** | `turnCount` 是末次快照（stock），`turnsConsumedWithoutAssistant` 是累加（flow）。相除会得到错数 |

再补一条本章特有的：

> **区分「计数器数的是意图还是事实」。** `types.ts` 的
> `toolCallsInTurn` 注释（原文）：
>
> 在真正派发工具的那一处累加，而不是数响应里的 `tool_use` 块数：后者含被循环检测拦下、
> 被 abort 跳过、被 F2 fall-through 重排的块，数出来的是"**模型想调多少**"
> 而非"**实际调了多少**"。

**同一个概念「工具调用数」，有两个都能自圆其说的口径，差值就是被各种防线拦掉的那些。**
说「我们平均每轮调 3.2 个工具」的时候，你数的是哪个？

### 10.7 一个反例：埋点自己成为故障源的三种方式

本文出现过三次「埋点坏了」，形态各不相同，值得并列：

| 形态 | 实例 | 为什么比「没埋点」更糟 |
| --- | --- | --- |
| **填了配置常量** | `elapsed_ms` 填 `maxTurnDurationMs`（§8.3） | 主动把排查引向错误方向（差 30 倍） |
| **配对键不一致** | watchdog 快照注册用 `turnCount`、查用 pair index | 结构性恒 null，看起来像「没发生过」 |
| **只在成功路径发** | 铁律 3 那条 | p95 系统性偏低，「看起来变快了」 |

三种的共同点：**它们都不报错。** 字段存在、类型正确、聚合能跑、图能画出来。
唯一的问题是画出来的图是错的，而且错得很自信。

> **面试可以直接用这段**：「我们踩过三类可观测性 bug，共同点是它们都不报错：
> 一是埋点里填了配置常量，导致所有样本值都一样，把排查引向错方向；
> 二是两个配对事件的 key 口径不一致，导致结构性恒 null，看起来像这个场景没发生过；
> 三是只在成功路径发事件，慢样本恰好是被中断的那些，于是 p95 系统性偏低。
> 所以我们有三条铁律：差值当场算不留配对、每轮重设基准、异常轮次也必须发。」

### 10.8 本章自检

1. 「该不该新增一个埋点事件」的四步判据链是什么？第三步为什么必须给实测失真数字？
2. 「差值当场算，不留给消费侧配对」——不遵守会产生什么形态的错误？为什么它特别难发现？
3. 「异常轮次也必须发事件」——不遵守时 p95 会偏高还是偏低？为什么？
4. 有一个已知瑕疵（耗时含人工等待），三种处理方式各是什么？为什么「标记」不输于「剔除」？
5. 「用来做判断的口径」和「用来做报告的口径」，纪律为什么不同？
6. 「本轮有没有发生 X」为什么必须用差值而不是布尔标志？这个坑在本文出现了几次？
7. 「每轮平均调 3.2 个工具」——这个数有两个口径，差别是什么？

---
<a id="11"></a>
## 12. 动手：从零实现一个 mini loop（六阶段）

读完前面十一章，最好的固化方式是自己写一个。这一章给一条**每阶段都能跑、
每阶段都能自己验证**的路线图。

**六个阶段的设计原则**：每一阶段只引入**一个**新概念，
且每一阶段结束时你都有一个能跑的东西。不要跳阶段——
后面的阶段全都在修前面阶段暴露出来的问题，跳过去你就不知道那些机制在解决什么。

---

### 阶段 1：能跑的骨架（目标：30 行）

抄 §0.2 那段。要求：

- [ ] 一个 `while(true)`，判据是「content 里有没有 `tool_use`」
- [ ] 两个工具：`read_file` 和 `list_dir`（都是只读的，先不碰权限）
- [ ] `tool_result` 用 `role: "user"` 追加
- [ ] 先写非流式（`stream: false`），流式留到阶段 3

**自测**：问它「这个目录里有几个 .ts 文件，最大的那个多少行？」
它应该 `list_dir` → 若干次 `read_file` → 给答案。

**你会遇到的第一个问题**：它可能一次要求调 5 个 `read_file`。
你的代码是不是只处理了第一个？**这就是 §6 那条不变量的第一次发作。**

---

### 阶段 2：让它坏，然后处理坏（目标：认识 stop_reason）

不加新功能，只加**观察**和**处理异常**。

- [ ] 每轮打印一行：`轮次 / stopReason / content 块类型 / tool_use 数量`
- [ ] 把 `max_tokens` 调到很小（比如 200），观察 `stopReason=max_tokens`
- [ ] 手动构造一个会 400 的请求：删掉一个 `tool_result`，看错误长什么样
- [ ] 加上 `stopReason` 的分支表（§2.4），未识别值走 warn 而不是静默穿透

**自测**：`stopReason=max_tokens` 时你的循环做什么？
如果它直接停了，用户会看到一个被截断到半句话的回答。

**这一阶段的目的是让你亲眼见到 §2 讲的每一种坏法。** 光读是不够的。

---

### 阶段 3：流式（目标：认识 SSE 和累积状态）

- [ ] 改成 `stream: true`，自己解析 SSE（三条规则：`data:` 前缀、
      空行分隔事件、`[DONE]` 或 `message_stop` 结束）
- [ ] **实时累积** `AccumulatedResponse`：文本拼接、`tool_use` 的 `input` JSON 分片拼接
- [ ] `onText` 回调实时打印，让你看到打字机效果
- [ ] 加 `AbortController`，绑到 Ctrl+C

**这里会遇到三个必须自己维护的状态**（对齐 §1 和 §8）：

1. **`tool_use` 的 `input` 是分片到达的** —— 你要按 `index` 累积字符串，
   最后 `JSON.parse`。**解析失败要有兜底**（模型偶尔吐出不完整 JSON）。
2. **中断时半截文本要留下** —— 累积器里已有的内容入历史，
   否则用户看到的那半句话在历史里不存在。
3. **中断时未执行的 `tool_use` 要补 `tool_result`** —— §1.5 那条。

**自测**：跑一个长任务，中途 Ctrl+C，然后**继续发一条新消息**。
如果报 400，说明你漏了第 3 条。

---

### 阶段 4：并发与保序（目标：认识分区）

- [ ] 给工具加 `readOnly()` 声明
- [ ] 实现 §6.3 的**贪心连续合并**分区（注意 `&& isSafe` 那个条件）
- [ ] 加一个写工具 `write_file`，验证它确实独占一个批次
- [ ] 并发上限设 10，用 `Promise.all` 跑每个批次
- [ ] **结果按原始 index 收集**，组装 `tool_result` 时顺序必须和 `tool_use` 一致

**自测（关键）**：构造一个 `read(a) read(b) write(c) read(a)` 的场景，
最后那个 `read(a)` 必须读到 `write(c)` 之后的内容。
如果读到旧内容，说明你的分区把它和前两个 read 合并了。

---

### 阶段 5：上下文与恢复（目标：认识 O(N²) 和压缩）

- [ ] 每轮打印 `input_tokens`，**亲眼看它二次增长**
- [ ] 加最便宜的两层压缩：工具结果预算（超过 N 字符 → 占位符）+ snip（裁最早的消息对）
- [ ] **裁完必须校验不变量**（§6.4 那个纯函数）——裁消息最容易切断
      `tool_use`/`tool_result` 配对
- [ ] 加一条 `prompt-too-long` 的恢复路径：压缩后重试，**用 one-shot 标志位封顶**
- [ ] 把状态收进一个显式 `State` 对象（§3.2），此时你应该有 5-6 个跨迭代字段了

**自测（两个）**：
1. 跑一个 30 轮的任务，看 `input_tokens` 曲线。它应该接近线性增长
   （单轮线性 → 累计二次）。
2. **故意把 `hasAttemptedReactiveCompact` 在循环顶部重置**，
   然后触发一次压不动的 `prompt-too-long`。观察它无限重试。
   **这一步别跳过——亲手复现一次 §4.4 那个「烧掉数千次 API 调用」的形态，
   比读十遍都记得牢。** 复现完记得改回来。

---

### 阶段 6：闸门与可观测（目标：认识「说完了 ≠ 做完了」）

- [ ] 加一道 Stop Hook：`end_turn` 后跑一条用户配置的命令（比如 `tsc --noEmit`），
      非零退出码就把 stderr 注入对话让模型修
- [ ] 封顶 3 次，**耗尽后放行而不是终止**（§9.5 的取向）
- [ ] 加 `transition` 字段，记录每次 continue 的理由
- [ ] 发四个事件：`TTFT` / `LoopTransition` / `TurnComplete` / 超时击杀
- [ ] **`TurnComplete` 必须在异常路径也发**（用 `finally` + 幂等位，§10.3 铁律 3）

**自测（这是全部六阶段里最重要的一个）**：

```
① 正常跑一轮，记下 TurnComplete 的耗时
② 跑一轮，中途 Ctrl+C
③ 检查：第 ② 次有没有发出 TurnComplete？
```

如果没有，**你的 p95 是假的**。这是 §10.3 那条「唯一不可妥协」的铁律。

---

### 做完六阶段你会有什么

一个大约 400-600 行的 loop，以及**对那 5000 行为什么存在的具体理解**。

更重要的是，你会有一批「我亲手复现过」的经验，
而这正是 §11 的 L4 档在筛的东西。面试时你可以说
「我自己写过一个 mini loop，故意在循环顶部重置了 one-shot 标志位，
亲眼看它无限重试」——这比复述别人的事故有说服力得多。

### 六阶段的常见卡点

| 卡点 | 原因 | 对应章节 |
| --- | --- | --- |
| 一直 400，说 `tool_call_id` 缺响应 | 漏了某个 `tool_use` 的结果 | §6.4 |
| 中断后再发消息就 400 | 未执行的 `tool_use` 没补 `tool_result` | §1.5 |
| 流式解析出 `undefined` | `tool_use` 的 `input` 分片没累积完就 parse | §3.5 |
| 模型反复读同一个文件 | 你的 `tool_result` 没进历史，或进错了 role | §0.2 |
| 压缩后模型开始自我否定 | 你注入了「已压缩」但实际没压动 | §7.7 |
| 改完分区后读到旧内容 | 合并条件漏了 `&& isSafe` | §6.3 |
| 无限重试烧钱 | one-shot 标志位被 continue 分支重置 | §4.4 |

---
<a id="appendix"></a>
## 附录

### A. 术语表

| 术语 | 含义 | 常见误解 |
| --- | --- | --- |
| **Agentic Loop** | 「调模型 → 执行工具 → 结果回灌 → 再调」的循环 | 不是「多想几步」，是「观测必须经由下一次调用才能进入模型视野」 |
| **Harness（挽具）** | 让 loop 在生产里活着的那 99% 代码 | 不是「框架」，是权限/恢复/持久化/观测的总和 |
| **迭代 / 轮 / 请求** | 三个不同粒度的计数 | 三者不等价，缝隙里藏过缺陷（§8.5） |
| **`stop_reason`** | 模型为什么停止生成 | **不可信**，主判据是 content 里有没有 `tool_use` |
| **孤儿 `tool_use`** | 有 `tool_use` 但没有对应 `tool_result` | 直接导致 400，有五种成因 |
| **游离 `tool_result`** | 有结果但找不到对应的 `tool_use` | 修法是**删除**，不是补齐 |
| **F1 / F2** | sid-code 里两条兜底分支的代号 | F1 = 空参数退化；F2 = `end_turn` 却带 `tool_use` |
| **one-shot 标志位** | 「本轮只允许尝试一次」的布尔 | **绝不能在任何 continue 分支重置** |
| **Tombstone（墓碑）** | 撤回一条已经 yield 给 UI 的消息 | 降级时用；撤回必须做到 UI 层 |
| **反应式压缩 vs autoCompact** | 前者是错误恢复路径，后者是预防性触发 | 两者的 success 判定都必须由实测差值决定 |
| **Microcompact** | 只清理旧工具结果内容的轻量压缩 | 有 cache/time 两种模式，按缓存冷热分流 |
| **Context Collapse** | 对最老 1-2 段做分段摘要 | 介于 snip 和全量摘要之间的中等成本层 |
| **HITL** | Human-In-The-Loop，需用户确认的弹窗 | 它的等待时长**不该**计入业务预算 |
| **人机闸门** | 让看门狗在「等人」期间停止计时的引用计数器 | 泄漏（begin 没 end）会架空所有看门狗 |
| **伪阶梯** | 数值不同但谓词相同的多层超时 | 没有增加任何区分能力，是负资产 |
| **退化探针** | 构造语义不同的输入，验证指纹函数是否塌成同值 | 应在调阈值**之前**做 |
| **stock vs flow** | 末次快照值 vs 累加值 | 相除会得到错数（CLAUDE.md 铁律 4） |

### B. 自检清单（读完全文回来打勾）

**基础（答不出回 §0–§2）**
- [ ] 为什么 `tool_result` 是 `user` role
- [ ] Agent Loop / HTTP / SSE 三层各管什么
- [ ] O(N²) 的成因，以及「2× 轮数 ≈ 3-4× 成本」
- [ ] 打断的三种时机，各自的处置
- [ ] 为什么不能只看 `stop_reason`
- [ ] 兜底分支的判据为什么用白名单

**机制（答不出回 §3–§7）**
- [ ] 为什么状态必须是显式对象，不能用独立变量
- [ ] `transition` 字段的两个消费者
- [ ] 15 条 continue 的四分类
- [ ] one-shot 标志位的那条纪律，以及违反的症状
- [ ] 并发安全判据为什么是「这次调用」级别
- [ ] 贪心连续合并里 `&& isSafe` 的作用
- [ ] 五层压缩管道，前三层的共同特点
- [ ] 阈值为什么从百分比改成绝对值
- [ ] 「地板 vs 减法」，用减法白扔多少窗口

**韧性与判据（答不出回 §8–§9）**
- [ ] 六层超时的谓词各是什么
- [ ] 为什么谓词哨兵比数值哨兵重要
- [ ] 三种「不该计入业务时长」的等待
- [ ] 为什么外层看门狗必须比内层宽松
- [ ] 「轮数预算被偷」为什么不能靠「不计数」修
- [ ] shape 检测的结构性误判是什么
- [ ] 退化探针 + 会话回放 + 人工抽检，三步的顺序为什么不能反
- [ ] 「耗尽后放行」的代价不对称论证

**可观测（答不出回 §10）**
- [ ] 该不该新增埋点的四步判据链
- [ ] 三条口径铁律，哪一条不可妥协
- [ ] 三种「不报错的可观测性 bug」
- [ ] 「如果这个流程现在崩了，我的埋点会发出什么？」

### C. 可复跑命令（引用本文任何数字前先跑一遍）

**⚠️ 本文所有数字都会腐坏。** 下面每条命令对应正文的一处引用，
输出与正文不符时**以命令输出为准**，并顺手改掉正文。

```bash
cd ~/sid-code

# ── §0.4 / §3.5：行数口径 ──
find packages/core/src/query -name '*.ts' -not -name '*.test.ts' | xargs wc -l | tail -1
wc -l packages/core/src/query/loop.ts packages/core/src/query/engine.ts \
      packages/core/src/query/tool-executor.ts packages/core/src/agent/agentic-loop.ts

# ── §2.5：yield done 的出口数（正文：22）──
grep -c 'kind: "done"' packages/core/src/query/loop.ts

# ── §3.6：QueryLoopYield 的 kind 数（正文：12）──
awk '/export type QueryLoopYield/,/kind: "done"; turns: number }/' \
  packages/core/src/query/types.ts | grep -o 'kind: "[a-z_]*"' | sort -u | wc -l

# ── §4.1：ContinueReason 取值数与完整列表（正文：15）──
awk '/export type ContinueReason/,/;$/' packages/core/src/query/types.ts | grep -c 'type: "'
awk '/export type ContinueReason/,/;$/' packages/core/src/query/types.ts \
  | grep -o 'type: "[a-z_]*"'

# ── §4.3：各类封顶常量 ──
grep -rhn '^export const MAX_[A-Z_]* = \|^const MAX_[A-Z_]* = ' \
  --include='*.ts' packages/core/src/query/

# ── §4.6：maxTurns 默认值链（0 || Infinity）──
grep -n 'createInitialLoopState(config.maxTurns' packages/core/src/query/loop.ts
grep -n 'maxTurns: 0' packages/core/src/config/config.ts

# ── §6.3：并发上限（正文：默认 10）──
grep -n -A 6 'function getMaxToolConcurrency' packages/core/src/query/tool-orchestration.ts

# ── §6.6 ★ 死接线自查：StreamingToolExecutor 有没有生产调用点 ──
#    正文结论：只有测试在用（「仅被测试消费」档）
grep -rn "StreamingToolExecutor" --include='*.ts' packages/ | grep -v node_modules
#    通用判据模板（把 <符号> 换成你要查的名字）：
#    grep -rn "<符号>" --include='*.ts' packages/*/src | grep -v '\.test\.ts'
#    结果为空 = 死代码；只在注释里出现 = 也是死代码
grep -n -A 3 'function isStreamingToolExecEnabled' \
  packages/core/src/query/streaming-tool-executor.ts

# ── §7.3 / §7.4：压缩阈值 ──
grep -n -A 8 'const BUFFER_THRESHOLDS' packages/core/src/context/manager.ts
grep -n -A 4 'export const TOKEN_THRESHOLDS' packages/core/src/context/auto-compact.ts
grep -n -A 8 'const DEFAULT_OPTIONS' packages/core/src/query/compact/tool-result-budget.ts

# ── §7.6：熔断器参数（正文：3 次 / 5 分钟）──
grep -n -A 5 'const DEFAULT_OPTIONS' packages/core/src/query/circuit-breaker.ts

# ── §8.2 ★ 超时阶梯全部数值 ──
awk '/^export const DEFAULTS/,/^};/' packages/core/src/config/network-profile.ts \
  | grep -E '^\s+[a-zA-Z]+:\s'
awk '/^export const PROVIDER_STREAM_DEFAULTS/,/^};/' \
  packages/core/src/config/network-profile.ts | grep -E '^\s+[a-zA-Z]+:'

# ── §8.2 ★ 注释腐坏现场：注释写 300s/600s，实际 720s/1500s ──
#    这一处刻意留着没修，作为「注释里的数字必然腐坏」的活体样本
grep -n '300s\|600s\|30min' packages/core/src/query/stream-processor.ts
grep -n 'watchdogNoProgressMs: \|overallTimeoutMs: 1_500_000' \
  packages/core/src/config/network-profile.ts

# ── §9.2：循环检测默认关闭 + 默认阈值 ──
grep -n -A 3 'function isLoopDetectionEnabled' packages/core/src/agent/loop-detection.ts
grep -n -A 12 'export const DEFAULT_LOOP_CONFIG' packages/core/src/agent/loop-detection.ts

# ── §9.5：「耗尽后放行」在五处一致出现 ──
grep -rn 'recoveryExhaustedAction' --include='*.ts' packages/core/src/agent/loop-detection.ts
grep -n '绝不.*强制收尾\|软提示、不强杀\|保成功优先' \
  --include='*.ts' -r packages/core/src/query/

# ── §10.1：四个锚点事件的发射点 ──
grep -rn 'event: "LoopTransition"\|event: "TurnComplete"\|event: "StreamPhase"\|event: "WatchdogKill"' \
  --include='*.ts' packages/core/src | grep -v '\.test\.ts'
```

**三条搜索纪律**（沿用同目录 Observability 文档的口径）：

```bash
# ① 一律 rg -a，别用 grep 查轨迹文件（NUL 字节会让 grep 静默零输出）
# ② 英语常用词加 -w（hang / stat / cost / trace / log / span）
# ③ 定位阶段逐个关键词单独搜，不要 or 模式 + -l
#    -l 不告诉你是哪个词命中的，与 -n 结果对不上时会误判为工具故障
```
