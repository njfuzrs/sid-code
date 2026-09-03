---
title: 'Agent Runtime（07）· 记忆系统：跨会话记住什么、凭什么记住'
description: '记忆不是「把对话存起来」。拆开分层记忆、检索时机、写入判据与团队记忆的凭证拦截——以及为什么「写盘前命中 secret 要拒绝写入」而不是脱敏后写入。'
date: "2026-09-03"
series: Agent Runtime 从零到一
tags: [记忆, 持久化, 从零到一]
outline: [2, 3]
---

# Agent 记忆系统：从零到一

::: info 这是一份快照
本文的数字、常量、行数取自 **2026-08-29** 对 sid-code 源码的一次实读。
代码在动，这些数字会腐坏——引用其中任何一个之前，请按文中给出的命令在你自己的仓库里复跑一次。
:::

> **这份文档写给谁**
>
> 你大概知道「让 AI 记住东西」是个需求，可能还背过几个词——向量数据库、RAG、
> 短期/长期记忆、艾宾浩斯衰减。但你没做过一套，也说不出「记忆系统到底难在哪」。
> 你想搞懂：真实生产系统是怎么做的、为什么它们的做法和教科书不一样、
> 面试问到「你怎么设计 agent 的记忆」时该怎么答。
>
> **和同目录/邻目录那两份的关系**：那两份是**研究文档**——
> 一份是事故复盘（`claude-code-记忆系统-原理与防漂移指南.md`），
> 一份是源码精读笔记（`01-Study-Source-Memory-System.md`，1274 行）。
> 它们密度极高、直接摆 `file:line`，但**默认你已经知道 frontmatter、召回、注入、
> prompt cache 是什么**，所以第一次读会卡住。
>
> 本文补的是那一层：**先把概念讲通，再把那两份里真正值钱的结论放回它该在的位置上。**
>
> **它不是摘要。** 摘要会把结论抽出来变成一句正确但没用的话
> （比如「记忆要注意时效性」——对，但你听完什么也做不了）。
> 本文的写法相反：**每个结论都从「为什么会有人搞错」讲起**，
> 因为面试里能拉开差距的从来不是结论本身，是你能不能说清它的反面为什么诱人。

> **本文的事实来源，以及一条免责声明**
>
> - **一手源码**：2026-08-29 实读 `~/claude-code/`
>   的记忆相关模块。行数口径：
>   `find <dir> -name '*.ts' -not -name '*.test.ts' | xargs wc -l`。
>   实测 `src/memdir` 1736 行、`extractMemories` 769、`SessionMemory` 1026、
>   `teamMemorySync` 2167、`autoDream` 550 —— **小计 6248 行**，
>   另加 `sessionMemoryCompact.ts` 630 行与 `attachments.ts` 里的注入侧逻辑。
> - **⚠️ 与前两份文档的一处实测差异**：两份研究文档都把记忆栈描述成**四层**
>   （CLAUDE.md / 长期记忆 / 会话记忆 / 团队记忆）。本次复核发现存在**第五层**：
>   `src/services/autoDream/`（550 行，后台记忆整理），两份文档均未覆盖。
>   §2.6 单独讲它。**这本身就是本文主题的活案例**——
>   文档写完那天是对的，三个月后就漏了一层。
> - **外部数据**（TEPA 实验、Mem0 陈旧率、AGENTS.md 采用量）沿用第二份文档的引用，
>   本文不重新验证，凡引用均标注来源与日期。
> - 文中所有具体数字都是**某个时间点的快照**，不是恒定事实。
>   引用它们是为了让你看见「真实数据长什么样」，**不要当结论沿用**。

---

## 怎么读这份文档

按顺序读。这是**一条链**，不是清单——后面每章都在用前面建立的概念。

| 你是谁 | 怎么读 |
| --- | --- |
| 完全零基础 | §0 → §1 → §2 → §3，先建立骨架，其余按需回查 |
| 会 RAG / 向量检索，不熟 agent | **跳过 §1**，直接 §5（为什么不用向量库）+ §6（召回）+ §8（漂移） |
| 想动手 | §14 + 附录 B |
| 只有 20 分钟 | 读 §3、§8、§12。这三章是骨架，其余都是它们的展开 |

### 目录

| 章 | 主题 | 读完你能回答 |
| --- | --- | --- |
| [§0](#0) | 名词地图 | 别人说召回 / 注入 / frontmatter / 漂移时你知道指什么 |
| [§1](#1) | 为什么 agent 需要记忆 | 记忆解决的到底是哪个问题，不解决会怎样 |
| [§2](#2) | **五层记忆栈** | 拿到一个需求，你知道它该落在哪一层 |
| [§3](#3) | ★ 该记什么：拒绝器比提取器重要 | 一条信息进来，你能判断该不该记 |
| [§4](#4) | 写入：双路径 + 一条成本约束穿透三层 | 谁来决定写记忆、为什么它负担得起 |
| [§6](#6) | 召回：用小模型替代相似度检索 | 不用 embedding 怎么找回来、边界在哪 |
| [§7](#7) | 注入：三层预算与字节冻结 | 记忆进上下文的三个坑 |
| [§8](#8) | ★★ 漂移：本文最重要的一章 | 为什么陈旧记忆比没记忆更糟 |
| [§9](#9) | 会话记忆：工作记忆与压缩 | 长会话压缩丢信息怎么办 |
| [§10](#10) | 共享记忆：为什么它比记忆本身贵 | 多人共享的三条语义与一次 16.7 万次事故 |
| [§11](#11) | 安全：一条完整的路径劫持攻击链 | 三个合理设计怎么凑成一个漏洞 |
| [§14](#14) | 动手：从零实现一个 mini 记忆层 | 五阶段路线图 |
| [附录](#appendix) | 术语速查 / 可复跑命令 / 自检清单 | 查漏 |

---
<a id="0"></a>
## §0 名词地图：先把词认全

这一节是**查询表，不用背**。往后每章第一次用到某个词时都会重新解释，
这里放一份集中的，是为了你读那两份研究文档时能随时回来查。

按「一条记忆从生到死」的顺序排列，不按字母序——这些词之间有位置关系。

### 0.1 最基本的三个词

| 词 | 中文 | 是什么 |
| --- | --- | --- |
| **context / context window** | 上下文 / 上下文窗口 | 模型这一次调用能看到的全部文字。**有硬上限**（几万到上百万 token） |
| **token** | 词元 | 模型的计费与计量单位。粗略地，1 个汉字 ≈ 1–2 token，1 个英文单词 ≈ 1.3 token |
| **stateless** | 无状态 | **LLM 每次调用都是全新的，不记得上次说过什么**。这是记忆系统存在的唯一理由 |

> 🔑 **如果只记一句话**：LLM 本身**没有**记忆。
> 你以为的「它记得我们刚才聊的」，实现上是**每次都把整段历史重新发给它**。
> 所谓「记忆系统」，做的全部事情就是**决定下次发什么、发多少**。

### 0.2 记忆的两个时间尺度

| 词 | 中文 | 是什么 | 类比 |
| --- | --- | --- | --- |
| **short-term / working memory** | 短期 / 工作记忆 | **一次会话内**的东西。本质就是那串消息历史 | 你的草稿纸 |
| **long-term memory** | 长期记忆 | **跨会话**存活的东西。落盘成文件或库 | 你的笔记本 |
| **scratchpad** | 便签 | 工作记忆的一种显式形态，agent 自己写自己读 | 便利贴 |
| **session** | 会话 | 从你启动到退出的一整段。**退出即失忆**——除非有长期记忆 | 一次上班 |

### 0.3 记忆的生命周期（这一组是本文主线）

| 词 | 中文 | 是什么 | 在哪一章 |
| --- | --- | --- | --- |
| **extraction** | 抽取 / 提取 | 从对话里**提炼**出值得记的东西 | §4 |
| **write gate** | 写入门 | 决定「这条该不该存」的那道判断。**大多数系统缺这一道** | §3 |
| **storage** | 存储 | 存哪儿：文件 / 向量库 / SQL / 图 | §5 |
| **recall / retrieval** | 召回 / 检索 | 这一轮该把**哪几条**记忆取出来 | §6 |
| **injection** | 注入 | 把取出来的记忆**塞进上下文**给模型看 | §7 |
| **staleness / drift** | 陈旧 / 漂移 | 记忆当初是对的，**世界变了它没变** | §8 |
| **consolidation** | 整理 / 巩固 | 定期回头合并、去重、删除矛盾的记忆 | §2.6 |

### 0.4 存储格式相关

| 词 | 中文 | 是什么 |
| --- | --- | --- |
| **frontmatter** | 前置元数据 | markdown 文件开头 `---` 包起来的那块 YAML。存 name / description / type |
| **description** | 摘要 | frontmatter 里的一行摘要。**召回时只看这一行判断相关性**，所以必须具体 |
| **index / entrypoint** | 索引 / 入口文件 | `MEMORY.md`。每条记忆一行指针，**每次会话全量加载** |
| **topic file** | 主题文件 | 一条记忆 = 一个 `.md` = 一个事实 |
| **tombstone** | 墓碑 | 显式记录「这条已被推翻」，而不是直接覆盖掉 |

### 0.5 检索相关（这一组最容易被行话吓住）

| 词 | 中文 | 是什么 | 一句话破除神秘感 |
| --- | --- | --- | --- |
| **embedding** | 向量 / 嵌入 | 把一段文字变成一串数字（几百到几千个小数） | 就是给文字算一个「坐标」 |
| **vector DB** | 向量数据库 | 专门存这些坐标、能快速找「坐标最近的」 | 就是个能按距离查的库 |
| **cosine similarity** | 余弦相似度 | 衡量两个坐标「方向像不像」，−1 到 1 | 就是「像不像」的分数 |
| **ANN** | 近似最近邻 | 不精确但很快地找出最近的 k 个 | 「差不多最近的」 |
| **RAG** | 检索增强生成 | 先检索、把结果塞进 prompt、再让模型答 | **本文会论证这个词掩盖了两个不同规模的问题** |
| **reranking** | 重排 | 检索完再用更贵的模型重新排一遍精度 | 二次筛选 |
| **top-k** | 取前 k 个 | 固定返回 k 条结果 | ⚠️ 在记忆场景里这个默认行为是**错的**（§6.3） |

### 0.6 成本与性能相关

| 词 | 中文 | 是什么 | 为什么记忆系统必须懂它 |
| --- | --- | --- | --- |
| **prompt cache** | 提示缓存 | 相同的**前缀**第二次发不用重算，价格约 1/10 | §4.3：不懂它，后台抽取根本跑不起来 |
| **prefix** | 前缀 | 缓存按前缀匹配，**从第一个不同的字节起全部失效** | §7.3：注入内容必须字节冻结 |
| **compaction / compact** | 压缩 | 上下文快满时把前面的对话摘要掉 | §9：压缩会丢信息，会话记忆就是为它准备的 |
| **lost in the middle** | 中段迷失 | 长上下文里**中间位置**的信息更容易被忽略 | §7.1：注入预算同时是质量措施，不只省钱 |
| **fork / forked agent** | 分叉 agent | 从主对话复制出一个子 agent，**共享缓存前缀** | §4.3 |

### 0.7 一个贯穿全文的类比

> 💡 **把每次会话想成「一个新员工的上班第一天」。**
>
> 模型是无状态的（§0.1），所以每个会话开始时它对你、对项目、对你们上周的决定
> **一无所知**。记忆系统就是**入职材料**：
>
> | 记忆系统的组件 | 类比 |
> | --- | --- |
> | `MEMORY.md` 索引 | **目录页**。一定会读，所以必须短 |
> | topic 文件 | 具体的交接文档，一份讲一件事 |
> | 召回选择器 | 帮他挑「今天该读哪 5 份」的助理 |
> | freshness 标注 | 文档封面上那个「最后更新：3 个月前」的戳 |
> | 排除清单（§3） | 「代码里能查到的别往交接文档里抄」 |
> | 会话记忆（§9） | 他今天的工作笔记，下班就没了 |
> | 团队记忆（§10） | 全组共享的 wiki |
> | 整理（§2.6） | 每季度回头把过期文档清一遍 |
>
> 这个类比后面还会用好几次，尤其是 §8——**那一章讲的是
> 「交接文档写得很详细、还带行号，但内容是三个月前的，
> 而新人因为它足够详细所以特别信它」。**

---
<a id="1"></a>
## §1 为什么 agent 需要记忆——以及记忆不解决什么

大多数人第一次听到「给 agent 加记忆」，脑子里的画面是「让它更聪明」。
**这个直觉会让你在第一个决策上就错。** 这一节把记忆到底解决什么问题讲清楚。

### 1.1 先看不加记忆会发生什么

一个真实的形态。你用一个 coding agent 干了一周活：

```text
周一  你：「别再自动给我加 try/catch，这个项目统一在中间件处理错误」
      agent：「明白」→ 这次不加了 ✅

周二  新会话。agent 又加了 try/catch。
      你：「说过了，别加」

周三  新会话。agent 又加了。
      你：（开始怀疑这工具能不能用）

周四  你把这条写进 CLAUDE.md。终于不加了。
      但你还有 40 条这样的偏好，写不完，而且写完 CLAUDE.md 变成 2000 行，
      模型开始忽略中间那些（§0.6 的 lost in the middle）。
```

问题的性质不是「模型不够聪明」——它周一就听懂了。问题是**它周二不记得周一**。
这是 §0.1 那条：LLM 是无状态的，每个会话都是新员工的第一天。

### 1.2 记忆解决的是「跨会话的重复解释成本」

把它精确化。记忆解决的是这样一类问题：

> **有一条信息，① 你已经告诉过 agent 一次，② 它不在代码/git/文档里，
> ③ 下次会话还需要它。**

三个条件必须同时成立。少任何一个，记忆都不是对的解法：

| 缺哪条 | 例子 | 正确解法 |
| --- | --- | --- |
| 缺 ① | agent 从没被告知过的团队规范 | 写文档 / CLAUDE.md，不是等它自己「学」 |
| 缺 ② | 「这个项目用 bun 不用 npm」 | **代码里有** `bun.lockb`，让它自己看（§3 会展开这条） |
| 缺 ③ | 「把这个函数改成 async」 | 一次性任务，本轮做完就结束 |

### 1.3 记忆不解决什么（三个常见误解）

**误解一：记忆能让 agent 变强。**
不能。记忆不改变模型能力，只改变**它知道什么**。
一个不会写 Rust 的模型，给它一百条 Rust 记忆也不会写 Rust。
记忆的收益天花板是「不用重复解释」，不是「能力提升」。

**误解二：记得越多越好。**
这条错得最厉害，而且有硬数据推翻它。arXiv 上的 TEPA 论文
（*Revoking Stale Memories for Conflict-Robust Agent Memory*，2026）
在「用户偏好会变化」这条数据流上做了对照实验：

| 策略 | 全反转成功率 |
| --- | --- |
| append-only（只追加，从不失效） | **0.138** |
| last-write-wins（后写覆盖） | 0.686 |
| **no memory（完全不用记忆）** | **0.837** |
| last-write-wins + 验证规则 | 0.863 |
| TEPA-Full（显式撤销 + 验证） | 0.910 |

**只追加的记忆（0.138）比完全不用记忆（0.837）差 6 倍。**
而「后写覆盖」（0.686）**依然低于**不用记忆。只有加上验证规则才反超。

这组数字打碎了一个隐含假设：「有记忆总比没记忆好，只是好多少的问题」。
**实际上在信息会变化的场景里，没有失效机制的记忆是净负债。**
§8 整章讲这件事。

> ⚠️ 引用纪律：这是**一篇论文在一个数据集上的一组数**，别当成普适定律。
> 值钱的是**量级和方向**（差 6 倍、且需要验证才能转正），不是那几位小数。

**误解三：记忆是个检索问题。**
这是最专业化、也最误导的一个误解，因为它听起来很对。
第二份研究文档的作者进去之前就是这么想的，出来时写了这段：

> 「读完发现真正的 6800 行代码里，检索只占 141 行
> （`findRelevantMemories.ts`），而且实现是『让 Sonnet 读清单挑文件』。
> 剩下的 6600 行在处理：什么不该记、写入怎么不破产、注入怎么不超预算、
> 内容怎么不毁缓存、共享怎么不打架、路径怎么不被劫持。」

复核一次（2026-08-29 实测）：`findRelevantMemories.ts` 仍是 **141 行**，
而整个记忆栈小计 **6248 行**（另加 `sessionMemoryCompact.ts` 630 行与
`attachments.ts` 里的注入逻辑）。**检索占 2.3%。**

> 🔑 **本节最重要的一句**：
> **记忆系统的难点不在「找回来」，在「该记什么、记多久有效、注入多少、谁能看见」。**
> 检索是这四个问题解决之后剩下的最简单的那个。
>
> 这句话是全文的路线图：§3 答第一问，§8 答第二问，§7 答第三问，§10/§11 答第四问。
> §6 才是检索——它排在第五，不是第一。

### 1.4 本章自检

能回答这三个问题再往下：

1. 「这个项目用 bun 不用 npm」该不该存成记忆？为什么？
2. TEPA 那组数字里，为什么 `no memory`（0.837）会**高于** `last-write-wins`（0.686）？
   什么机制让「记住但可能过时」比「什么都不记」更差？
3. 如果有人说「我们的记忆系统用了向量库 + Cross-Encoder 重排，很先进」，
   按 §1.3 的第三个误解，你该追问什么？

---
<a id="2"></a>
## §2 五层记忆栈：先看清全景

前面把记忆当成一个东西讲，现在拆开。真实生产系统里它是**五层**，
每层解决**不同的问题**，用**不同的机制**，**互不替代**。

> ⚠️ **这里有一处与前置文档的实测差异，值得单独点出。**
> 本目录那两份研究文档都写的是「四层」。2026-08-29 复核发现存在第五层
> `src/services/autoDream/`（550 行）。**不是文档写错了，是三个月里多了一层。**
> 这正是 §8 要讲的漂移，只不过这次漂移的对象是文档本身。

### 2.1 五层全景表

| 层 | 名字 | 解决什么问题 | 生命周期 | 实测规模 |
| --- | --- | --- | --- | --- |
| **L0** | 项目约定文件（`CLAUDE.md` / `AGENTS.md`） | 人**手写**的项目规范 | 跟着仓库走 | 不在本文范围 |
| **L1** | 长期记忆（`memdir`） | 跨会话的用户理解 | 永久，直到被改 | 1736 行 |
| **L2** | 会话记忆（`SessionMemory`） | 长会话压缩后的连贯性 | 单会话 | 1026 行 + 压缩侧 630 行 |
| **L3** | 团队记忆（`teamMemorySync`） | 多人共享 | 跨机器、跨人 | 2167 行 |
| **L4** | 后台整理（`autoDream`） | 记忆自己会腐烂 | 定期触发 | 550 行 |
| — | 写入侧（`extractMemories`） | 谁来写 L1 | 每轮结束 | 769 行 |

### 2.2 L0：手写约定——为什么它不算「记忆」

`CLAUDE.md` / `AGENTS.md` 是人手写、进 git、每次会话全量加载的项目规范。
它和记忆的分界线很清楚：

| | L0 手写约定 | L1 记忆 |
| --- | --- | --- |
| 谁写 | 人 | agent 自己 |
| 进 git 吗 | 进 | 不进（用户私有） |
| 谁能看到 | 所有协作者 | 只有这台机器上的这个用户 |
| 适合放什么 | 「所有人都必须遵守」 | 「这个用户的偏好」 |

⚠️ 一个实际后果，也是我们自己仓库里踩过的：**L0 是共享的、L1 不是。**
所以「必须让别人也看到」的东西写 L0，写进 L1 等于只有你这台机器知道。
（我们仓库的 `CLAUDE.md` 里那句「写在记忆里不算：那只有一个 harness、
一台机器读得到」就是这条。）

顺带一个业界数字：AGENTS.md 已被 6 万+ 项目使用，并在 Linux Foundation 下标准化
（引自第二份文档的外部调研，2026-02）。**「用一个 markdown 文件当 agent 的项目约定」
不是某家的私有做法，是既成事实标准。**

### 2.3 L1：长期记忆——本文的主线

这是「记忆系统」这个词通常指的东西。物理结构长这样：

```text
~/.claude/projects/<项目路径编码>/memory/
├── MEMORY.md                         ← 索引，每次会话全量加载（200 行上限）
├── feedback-no-auto-try-catch.md     ← 一条记忆 = 一个文件 = 一个事实
├── user-prefers-chinese.md
└── …
```

三个设计点，各有一整章：

- **一条记忆 = 一个文件 = 一个事实**，按主题组织，不按时间
  （源码 `extractMemories/prompts.ts`：`Organize memory semantically by topic,
  not chronologically`）。§5 讲为什么是文件。
- **索引全量加载，正文按需召回**。§6 讲召回，§7 讲注入。
- **按项目隔离**（目录名是项目路径编码，`/` → `-`）。

### 2.4 L2：会话记忆——它和 L1 是两个问题

最容易混的一层。名字都带「记忆」，但解决的问题完全不同：

| | L1 长期记忆 | L2 会话记忆 |
| --- | --- | --- |
| 问题 | 「新会话不认识你」 | 「这个会话太长了，要压缩，压缩会丢信息」 |
| 内容 | 不可从项目状态推导的（§3） | 当前任务的状态、改过哪些文件、犯过什么错 |
| 活多久 | 永久 | 会话结束即弃 |
| 触发 | 每轮结束抽取 | 上下文增长到阈值 |

**为什么需要 L2**：会话变长 → 上下文快满 → 必须压缩 → 压缩是「让模型把前面的
对话摘要成一段话」→ **摘要必然丢信息**。丢了什么呢？往往正是
「我刚才试过 A 方案失败了」，于是压缩后 agent 又去试 A。

L2 的解法是**在压缩发生之前就持续维护一份结构化摘要**，压缩时直接用它，
而不是现场生成。§9 展开。

### 2.5 L3：团队记忆——它比记忆本身贵

一个反直觉的实测数字：**单机记忆读写 1736 行，跨机同步 2167 行。**

这个比例本身就是一条工程结论：**共享比记忆本身难。**
§10 讲三条同步语义和一次 2.5 天 16.7 万次无效请求的事故。

### 2.6 L4：后台整理（`autoDream`）——前置文档漏掉的一层

这一层两份研究文档都没有。它做的事叫 **consolidation（整理/巩固）**：
定期 fork 一个 agent，回头把记忆合并、去重、删除自相矛盾的。

源码 `src/services/autoDream/autoDream.ts:1-11` 的文件头注释：

```text
Background memory consolidation. Fires the /dream prompt as a forked
subagent when time-gate passes AND enough sessions have accumulated.

Gate order (cheapest first):
  1. Time: hours since lastConsolidatedAt >= minHours (one stat)
  2. Sessions: transcript count with mtime > lastConsolidatedAt >= minSessions
  3. Lock: no other process mid-consolidation
```

默认阈值（`autoDream.ts:63-66`）：`minHours: 24`、`minSessions: 5`。
即：**距上次整理超过 24 小时，且期间有至少 5 个会话，才整理一次。**

三个值得学的设计：

**① 门禁按成本从便宜到贵排序。** 先看时间（一次 `stat`），再数会话数（要扫目录），
最后抢锁（要写文件）。**贵的检查放在便宜的检查后面**——这个顺序在这份源码里
反复出现，是一种系统性习惯（§4.4 还会见到一次）。

**② 双门禁防的是两种不同的浪费。** 只有时间门 → 一个月没用、一开机就整理，
但没有新信息可整理。只有会话门 → 一天跑 20 个会话，整理 4 次，纯烧钱。

**③ 时间门通过但会话门不通过时，会退化成每轮重扫。**
源码显式处理了这个（`autoDream.ts:56-57`）：

```text
// Scan throttle: when time-gate passes but session-gate doesn't, the lock
// mtime doesn't advance, so the time-gate keeps passing every turn.
const SESSION_SCAN_INTERVAL_MS = 10 * 60 * 1000
```

时间门一旦通过就**一直**通过（因为它的判据是「距上次整理多久」，
而没整理就不会更新那个时间戳），于是每轮都要付一次扫目录的成本。
加一个 10 分钟的扫描节流兜住。

> 🔑 **这是一类很常见的 bug 形态，值得单独记住**：
> **一个「一旦成立就永远成立」的条件，放在每轮都跑的路径上，
> 就变成了每轮都付一次代价。** 而它不报错、不失败，只是悄悄地贵。

整理 prompt 本身（`consolidationPrompt.ts`）分四个阶段，
每一阶段都对应本文后面某一章的一条纪律：

| 阶段 | 做什么 | 对应本文 |
| --- | --- | --- |
| Phase 1 Orient | `ls` 目录、读索引、**先看已有的免得写重复** | §4.4 去重靠写前给足上下文 |
| Phase 2 Gather | 找新信号，**重点找「和现在代码矛盾」的记忆** | §8 漂移检测 |
| Phase 3 Consolidate | 合并进已有文件而非新建；**相对日期转绝对日期** | §3.4 |
| Phase 4 Prune & index | 索引压回 200 行/25KB 以内，**删掉已过时的指针** | §7.1 预算 |

Phase 3 里有一句值得抄的原话：

> `Deleting contradicted facts — if today's investigation disproves an old
> memory, fix it at the source`

**「在源头修，不要叠补丁」**——这条和第一份研究文档的纠偏 SOP 完全一致（§8.5）。

### 2.7 五层之间怎么分工：一张判断表

拿到一条信息，按这个顺序问：

```text
① 它是「所有协作者都得遵守」的规范吗？
   → 是：L0，写 CLAUDE.md（进 git，别人看得到）

② 它能从代码 / git / 已有文档里查出来吗？
   → 能：什么都别记（§3 的核心判据）

③ 它下次会话还需要吗？
   → 不需要：L2 会话记忆（或者干脆不记）
   → 需要：继续

④ 需要别人也看到吗？
   → 需要：L3 团队记忆（先想清楚 §10 的三条语义）
   → 不需要：L1 长期记忆

⑤ （不用你决定）L4 会定期回来把 L1 整理一遍
```

### 2.8 本章自检

1. 「压缩会丢信息」是 L1 还是 L2 解决的问题？为什么另一层解决不了？
2. `autoDream` 的时间门为什么需要一个额外的扫描节流？
   这个 bug 形态的通用形式是什么？
3. 你发现两份研究文档都写「四层」而源码是五层。
   按本文 §8 的纪律，你该怎么处理这两份文档——直接改数字，还是别的？

---
<a id="3"></a>
## §3 ★ 该记什么：拒绝器比提取器重要

这是全文第一个**架构核心**。如果只能读一章，读这章。

### 3.1 先看一个所有人都会犯的错

你要设计记忆系统。第一个念头几乎必然是：

> 「写一个提取器，每轮对话结束扫一遍，把重要信息提炼出来存下。」

于是问题变成「怎么提取得更准」，你开始想 prompt 怎么写、要不要打重要性分、
要不要做 embedding 去重。**你在优化一个不该存在的问题。**

因为真正的第一个问题不是「怎么提取得准」，是**「什么根本不该进来」**。

### 3.2 源码给的分类法，逻辑是倒过来的

打开 `src/memdir/memoryTypes.ts`，第一眼是四个类型：
`user` / `feedback` / `project` / `reference`。

我原以为会看到学术分类（语义/情景/程序记忆），结果是四个完全不同维度的东西。
真正的解释在文件头注释（`memoryTypes.ts:1-12`）：

```text
Memories are constrained to four types capturing context NOT derivable
from the current project state. Code patterns, architecture, git history,
and file structure are derivable (via grep/git/CLAUDE.md) and should NOT
be saved as memories.
```

**这句话把分类法的逻辑倒过来了。**

| | 我原以为的分类目的 | 实际的分类目的 |
| --- | --- | --- |
| 为什么分类 | 组织好记忆便于检索 | **划定记忆的定义域** |
| 按什么分 | 内容形态（事实/事件/流程） | **能不能从当前项目状态推导出来** |
| 结果 | 分类越细越好 | **四类就够，因为「不可推导」的东西没那么多** |

顺着「不可推导」这个判据看四个类型就通了：

| type | 存什么 | 为什么代码里没有 | 是否必须写 Why |
| --- | --- | --- | --- |
| `user` | 用户是谁、水平、偏好 | 人不在代码里 | 否 |
| `feedback` | 用户给过的工作方式指导 | 对话里说的，没落盘 | **必须** |
| `project` | 为什么做这个决策、有什么截止日期、出过什么事故 | 动机不在代码里 | **必须** |
| `reference` | 外部系统在哪（Linear 项目、Grafana 面板） | 外部的 | 否 |

### 3.3 排除清单：比分类法更重要

`WHAT_NOT_TO_SAVE_SECTION`（`memoryTypes.ts:183-195`，2026-08-29 复核逐字一致）：

```text
- Code patterns, conventions, architecture, file paths, or project structure
  — these can be derived by reading the current project state.
- Git history, recent changes, or who-changed-what — `git log` / `git blame`
  are authoritative.
- Debugging solutions or fix recipes — the fix is in the code; the commit
  message has the context.
- Anything already documented in CLAUDE.md files.
- Ephemeral task details: in-progress work, temporary state, current
  conversation context.
```

五条里最反直觉的是第三条：**排除「调试方案和修复配方」。**

agent 花半天调出来一个 bug，为什么不让它记住？我第一反应也是「排得太狠了」。
想通之后是这样：

```text
修复已经落在代码里了。
记忆里再存一份 → 有了两个真相源。
而代码会继续演进，记忆不会。
  → 三个月后代码改了，记忆里那份「修复配方」变成了错的
  → 而且它带着具体的文件名和行号，看起来特别可信（§8 的核心）
```

**存「修复方案」等于给自己埋一个会腐烂的副本。**

> 🔑 **通用判据，值得背下来**：
> **凡是「已经有一个权威真相源」的信息，都不该存进记忆。**
> 代码的权威源是代码，历史的权威源是 `git log`，规范的权威源是 `CLAUDE.md`。
> 记忆只该存**没有其它权威源**的东西。
>
> 反过来说，判断一条记忆该不该存，问一句：
> **「如果我不存，下次能查到吗？」** 能查到 → 别存。

### 3.4 最锋利的一行：用户明确要求也不存

排除清单末尾那句（`memoryTypes.ts:194`）：

```text
These exclusions apply even when the user explicitly asks you to save. If they
ask you to save a PR list or activity summary, ask what was *surprising* or
*non-obvious* about it — that is the part worth keeping.
```

**用户说「记住这个」，agent 不照做。** 这违反直觉，但注释给了理由，
而且标注了 eval 编号（`memoryTypes.ts:192-193`）：

```text
H2: explicit-save gate. Eval-validated (memory-prompt-iteration case 3,
0/2 → 3/3): prevents "save this week's PR list" → activity-log noise.
```

拆开看这个机制：

```text
用户：「记住这周的 PR 列表」
  ├─ 照做 → 存了一份快照 → 一周后全是错的 → 但它还在那儿，还会被召回
  └─ 不照做，改成提问 → 「这里面什么是意外的？」
       → 用户：「PR #43 那个改动比预期大，因为两族协议的 default 语义正好相反」
       → 存这一句。它是洞察，不会过期。
```

**把请求从「存快照」重定向到「存洞察」。**

⚠️ 注意 `0/2 → 3/3` 这个标注的含义：这不是拍脑袋加的一句话，
是 A/B 跑出来的——**加这句之前 2 个 case 全不过，加了之后 3 个全过**。
§8.3 会看到更多这类标注，它们共同说明一件事：
**记忆系统的「算法」主要是 prompt 工程，而每句 prompt 都是测出来的。**

另外 `project` 类型有一条同源的纪律（`memoryTypes.ts` 的 `when_to_save`）：

```text
Always convert relative dates in user messages to absolute dates when saving
(e.g., "Thursday" → "2026-03-05"), so the memory remains interpretable after
time passes.
```

「周四冻结合并」存下来，三个月后读到——**哪个周四？** 存的时候就转成绝对日期。
这是最便宜的一条防漂移措施：**代价是零，收益是这条记忆不会在一周后变成垃圾。**

### 3.5 feedback 类型：为什么必须同时记「纠正」和「确认」

`feedback` 的 `when_to_save` 和 `description` 里有一句我认为很聪明的话
（`memoryTypes.ts:60-61`，复核逐字一致）：

```text
Record from failure AND success: if you only save corrections, you will avoid
past mistakes but drift away from approaches the user has already validated,
and may grow overly cautious.

Corrections are easy to notice; confirmations are quieter — watch for them.
```

只记纠正会导致什么？

```text
记忆里全是「不要做 X」「别再 Y」「停止 Z」
  → agent 学到一堆禁令，但不知道「该做什么」
  → 于是每次都问、每次都用最小改动、每次都加防御性代码
  → 越来越保守，最后变成一个什么都不敢干的工具
```

这是一个**负反馈单极化**问题。设计反馈收集时人的本能是只收集失败案例
（失败信号明显、好标注），而这里点明了代价：
**只有负样本的记忆系统会产生系统性偏保守漂移。**

而且「确认」天生更难采集——用户说「不对，别这样」很显眼；
用户说「嗯，这次这样挺好」很容易滑过去。所以源码里专门写了
`confirmations are quieter — watch for them`。

### 3.6 强制写 Why：单条记忆最强的自带防漂移设计

`feedback` 和 `project` 的 `body_structure` 强制要求两行
（`memoryTypes.ts` 复核确认）：

```text
Lead with the rule itself, then a **Why:** line ... and a **How to apply:** line.
Knowing *why* lets you judge edge cases instead of blindly following the rule.
```

`project` 类型那条的措辞更直接：

```text
Project memories decay fast, so the why helps future-you judge whether the
memory is still load-bearing.
```

为什么 Why 这么重要？看一个真实对照（来自第一份研究文档的事故）：

```markdown
❌ 没有 Why：
   「ink 搬不了 cc 的 fork，别尝试。」

   → 后人只能盲信。
   → 依赖关系变了之后，这条变成一个定时炸弹，而且没人知道它已经炸了。

✅ 有 Why：
   「ink 搬不了 cc 的 fork。
     **Why**：当前 ink 是外部 npm 包 @jrichman/ink，是黑盒。
     **How to apply**：改渲染相关代码时，别指望能拿到 cc 的实现。」

   → 后人一眼看到前提是「ink 是外部 npm 包」。
   → 某天他 ls 一下发现 ink 已经 vendor 进仓库了 → 立刻知道这条失效。
```

> 🔑 **Why 把「结论的有效期」写在明面上。**
> 没有 Why 的记忆，你无法判断它什么时候该退休。
> 有 Why 的记忆，前提消失的那一刻它自己就报废了——**而且报废是可见的**。

这个事故的完整链条（第一份文档 §1.1）值得完整看一遍，因为它是本文 §8 的引子：

```text
早期会话
  └─ 观察事实 A：ink 是外部 npm 包
       └─ 推导结论 B：「cc fork 的那些能力搬不了」
            └─ 写入 5 条 memory + 一份设计文档，把 B 固化成「硬边界，别尝试」

时间流逝（ink 整套 vendor 进了仓库，node_modules 里的被删了）
  └─ 前提 A 失效，但结论 B 没人改

后来会话（要改渲染代码）
  └─ 读到 B：「搬不了，别尝试」
       └─ 差点据此放弃一条完全可行的路   ← 有害记忆的实际伤害
```

### 3.7 三道闸：一条信息进来怎么判

把这一章收成一个可执行的流程：

```text
闸一 · 该不该存？必须同时满足三条：
  ① 非显而易见（不是常识、不是文档里的）
  ② 跨会话有用（不是本轮任务的临时状态）
  ③ 不会很快过时（不是快照、不是活动日志）
  ⚠️ 用户明确要求也走这道闸（§3.4）

闸二 · 有权威真相源吗？
  代码里能 grep 到 → 不存
  git log 能查到 → 不存
  CLAUDE.md 里有 → 不存

闸三 · 格式对不对？
  选对 type（四类之一）
  feedback / project 必须配 **Why:** + **How to apply:**
  相对日期转成绝对日期
  写了 file:line / 具体数量的，加一句「以实际核对为准」
  ⚠️ 查重：有同主题记忆就更新它，不要新建（§4.4）
```

### 3.8 本章自检

1. 「这个 bug 的根因是 `foo.ts:42` 那个空指针，修法是加个判空」——该存吗？
   如果不存，那半天的调试成果怎么保留？
2. 用户说「记住我们团队周会是每周二下午三点」——该存吗？走一遍三道闸。
3. 为什么 `project` 类型的 `when_to_save` 里专门有一条「相对日期转绝对日期」，
   而 `user` 类型没有？
4. 一个记忆系统只记「用户纠正过我的事」，三个月后它会长成什么样？

---
<a id="4"></a>
## §4 写入：双路径互斥，以及一条穿透三层的成本约束

§3 讲了「该记什么」，这一章讲「谁来记、什么时候记、怎么让它负担得起」。

### 4.1 两条写入路径，运行时互斥

我原以为写入是「一个后台 pipeline 定期扫对话」。实际是两条路径：

```text
路径 A · 主 agent 在对话中直接写
  ├─ system prompt 里一直带着完整的保存指令
  ├─ 优点：上下文最全 → 质量最高
  │        它知道用户那句「别再自动加 try/catch」是在什么情境下说的
  └─ 缺点：不一定会写。它忙着完成你的任务，把这事忘了

路径 B · 后台抽取 agent（每轮结束触发）
  ├─ 每个 query loop 结束（模型给出无工具调用的最终回复）触发
  ├─ 优点：一定会跑 → 兜底
  └─ 缺点：只看得到最近 N 条消息，上下文不如主 agent 全
```

互斥的实现很朴素（`extractMemories.ts:345-360`）：

```typescript
// Mutual exclusion: when the main agent wrote memories, skip the
// forked agent and advance the cursor past this range so the next
// extraction only considers messages after the main agent's write.
if (hasMemoryWritesSince(messages, lastMemoryMessageUuid)) {
  // 扫消息历史里有没有对记忆目录的 Edit/Write 调用，有就跳过
  return
}
```

> 🔑 **这个模式值得起个名字：主路径高质量 + 兜底路径高召回，用状态检测做互斥。**
> 它比「只用后台 pipeline」质量高，比「只靠主 agent 自觉」可靠。
> 代价是要维护一个游标和一个互斥检测。

### 4.2 游标只在成功后推进——at-least-once 语义

```text
// Advance the cursor only after a successful run. If the agent errors
// out (caught below), the cursor stays put so those messages are
// reconsidered on the next extraction.
```
（`extractMemories.ts:429-431`）

失败不推进游标 → 下次重新处理这批消息。这是消息队列里的 **at-least-once**
语义（和 ack 模型一样）。

为什么选 at-least-once 而不是 at-most-once？比较两边的代价：

| | 重复提取（at-least-once 的风险） | 漏提取（at-most-once 的风险） |
| --- | --- | --- |
| 后果 | 可能写重复记忆 | **永久丢失一条用户偏好** |
| 有补救吗 | 有——prompt 里强制查重（§4.4） | 没有。那句话永远不会再说一遍 |

**不对称的代价决定了语义的选择。** 这是分布式系统里的标准推理，
但很多人做记忆系统时根本没想过这里有个选择。

### 4.3 ★ 后台抽取为什么负担得起：一条成本约束穿透三层

这一段我认为是整个写入路径里最重要的工程洞察，而且**概念资料从不讲**。

先看问题的规模：

```text
后台抽取 agent 需要看到整段对话才能判断有什么值得记的。
一段对话可能几万 token。
每轮对话结束都跑一次。
  → 如果每次都是「全新输入」重新走一遍 prefill，成本高到不可接受
```

解法（`extractMemories.ts:415-427`）：

```typescript
const result = await runForkedAgent({
  promptMessages: [createUserMessage({ content: userPrompt })],
  cacheSafeParams,          // ← 关键在这个参数
  querySource: 'extract_memories',
  skipTranscript: true,
  // Well-behaved extractions complete in 2-4 turns (read → write).
  // A hard cap prevents verification rabbit-holes from burning turns.
  maxTurns: 5,
})
```

`cacheSafeParams` 携带 system prompt / tools / model / messages 前缀，
让分叉出来的抽取 agent **和主对话共享同一个 prompt cache 前缀**。
那几万 token 走的是 cache read（约 1/10 价格）。

**现在看这条约束怎么穿透三层：**

```text
第一层（成本）：抽取器必须复用主对话的 KV cache，否则成本高一个数量级
     ↓ 而 cache 是按前缀匹配的，前缀里包含 tools 列表
第二层（架构）：所以抽取器不能改工具列表 —— 哪怕它只需要 Read/Write
     ↓ 但抽取器确实不该有主 agent 的全部权限
第三层（安全）：所以最小权限只能在执行层实现，接口层必须放宽
```

源码 `extractMemories.ts:171-182` 的注释直说了第二层：

```text
Giving the fork a different tool list would break prompt cache sharing
(tools are part of the cache key).
```

**为了缓存命中，宁可放开一个不需要的工具，也不改工具列表。**
但注意它没真的放弃最小权限——工具内部调用的每个原语还是会重新过一遍
`canUseTool` 检查。

> 🔑 **两句可以直接搬进面试的话**：
> ① **「接口层放宽、执行层收紧」**——当缓存经济学和最小权限原则冲突时的解法。
> ② **看架构决策时先问一句「这个选择是不是被缓存经济学逼出来的」。**
> 成本约束不是「架构定完之后的调优步骤」，它会反过来决定架构。

### 4.4 `maxTurns: 5` 与「验证兔子洞」

```text
// Well-behaved extractions complete in 2-4 turns (read → write).
// A hard cap prevents verification rabbit-holes from burning turns.
```

**verification rabbit-hole（验证兔子洞）**是这样的：

```text
抽取 agent 读到一条旧记忆，觉得可能过时了
  → 去 grep 代码验证
    → grep 出更多相关的东西
      → 又想去更新那些
        → 又要验证那些
          → 发散，5 轮预算烧光，什么都没写成
```

防御不只是轮次上限。prompt 里还有一条硬约束
（`extractMemories/prompts.ts:41`）：

```text
You MUST only use content from the last ~N messages to update your persistent
memories. Do not waste any turns attempting to investigate or verify that
content further — no grepping source files, no reading code to confirm a
pattern exists, no git commands.
```

**明确禁止验证。** 而这跟召回侧的指令**正好相反**——召回侧强制要求
「推荐前必须验证」（§8.4）。同一个系统，写入时禁止验证，读取时强制验证。

想通这个不对称很有意思：

| | 写入时 | 读取时 |
| --- | --- | --- |
| 你在做什么 | 记录「用户说过什么」 | 断言「代码里有什么」 |
| 这是什么性质 | **事实**（他确实说了） | **推断**（当初有，现在呢？） |
| 需要验证吗 | 不需要 | **需要** |

> 🔑 **验证成本应该花在断言点，不是记录点。**

而且 prompt 还教了一个具体的批处理策略（`prompts.ts:39`）：

```text
turn 1 — issue all Read calls in parallel for every file you might update;
turn 2 — issue all Write/Edit calls in parallel. Do not interleave.
```

为什么这么排？因为 Edit 要求先 Read 同一文件。
read-all → write-all 两轮打完，正好落在 2–4 轮的预算内。
**把工具依赖关系直接编码成 prompt 里的执行计划**，
而不是指望模型自己规划出最优批次。

### 4.5 预注入目录清单：去重不靠算法，靠给足上下文

```typescript
// Pre-inject the memory directory manifest so the agent doesn't spend
// a turn on `ls`. Reuses findRelevantMemories' frontmatter scan.
// Placed after the throttle gate so skipped turns don't pay the scan cost.
const existingMemories = formatMemoryManifest(await scanMemoryFiles(memoryDir, signal))
```
（`extractMemories.ts:395-400`）

清单格式（`memoryScan.ts:84-93`）：
`- [type] filename (ISO timestamp): description`，后面跟一句：

```text
Check this list before writing — update an existing file rather than
creating a duplicate.
```

两个收益：

**① 省一轮。** 5 轮预算里省一轮是 20%。

**② 顺带解决了去重。** agent 在写之前就看到了已有记忆的清单和描述，
才**可能**「更新而非新建」。

> 🔑 **去重不是靠事后合并算法，是靠写入前给足上下文。**
> 这比「写完之后用 embedding 算相似度然后合并」简单一个数量级，
> 而且不会有「合并合错了」这个新故障模式。

⚠️ 注意最后一句注释：**scan 放在节流门之后。** 被节流跳过的轮次不付扫描成本。
这个「把开销挪到 gate 之后」的顺序在这份源码里出现了好几次
（§2.6 的 autoDream 门禁排序是同一个习惯），是一种系统性的工程素养。

### 4.6 两步保存：漏了第二步等于没写

源码 `extractMemories/prompts.ts:70-80` 明确写入是**两步**：

```text
**Step 1** — write the memory to its own file (e.g. `feedback_testing.md`)
             using this frontmatter format: ...
**Step 2** — add a pointer to that file in `MEMORY.md`. `MEMORY.md` is an
             index, not a memory — each entry should be one line, under
             ~150 characters: `- [Title](file.md) — one-line hook`.
             It has no frontmatter. Never write memory content directly
             into `MEMORY.md`.
```

**漏了 Step 2 会怎样？** 这条记忆永远不会被加载 = 等于没写。

为什么？因为索引是召回的入口——§6 会讲，选择器读的是**扫描出来的清单**，
而人（和 `autoDream`）读的是 `MEMORY.md`。索引里没有指针，
这条记忆在人眼里就不存在，永远不会被维护、更新、纠偏。

> ⚠️ 这是一类很典型的**静默失败**：写入成功了、文件在磁盘上、没有任何报错，
> 但功能等于零。§12 整章讲这类形态。

### 4.7 本章自检

1. 为什么抽取 agent 被**禁止**验证，而召回侧被**强制**验证？
   一句话说清这个不对称的理由。
2. 「抽取器必须和主 agent 共享 prompt cache」这条成本约束，
   为什么会导致「最小权限只能在执行层做」？完整讲一遍这条链。
3. 如果游标在失败时也推进，会发生什么？为什么这个代价不可接受？
4. 你的抽取器换了一个更便宜的模型来省钱。猜猜成本会怎么变？

---
<a id="5"></a>
## §5 存储：为什么生产系统在删向量库

这一章回答一个几乎必然被问到的面试题：**「你们的记忆用什么存？上向量库吗？」**

答错的方式有两种：说「上了向量库」显得没想清楚，说「不上」又说不出理由。
这一章给你判据。

### 5.1 一个零命中的实测

先看事实。在整个记忆栈里搜向量检索的痕迹：

```bash
# 2026-08-29 实测
rg -ci 'embedding|vector|cosine|faiss' src/memdir src/services/extractMemories src/services/SessionMemory
# → 唯一命中：src/memdir/teamMemPaths.ts: 5
```

**⚠️ 这里必须做一步反向核验**（这条纪律本身是通用的，见 §12.9）：
零命中或近似零命中的结论，必须先证明你的搜索命令**能抓到已知存在的东西**，
否则「没搜到」可能只是命令写错了。

```bash
# ① 证明搜索本身有效
rg -ci 'memory' src/memdir/memoryAge.ts      # → 9，命令没问题

# ② 逐个查看那 5 处命中到底是什么
rg -in 'embedding|vector|cosine|faiss' src/memdir/teamMemPaths.ts
# → 全部是 "injection vector" / "attack vector" / "traversal vector"
#   —— 讲的是攻击面，不是向量检索
```

**结论：一个 6000+ 行的记忆系统，零向量检索。** 不是「还没做」，是选择。

### 5.2 实际用什么存：markdown 文件 + frontmatter

```markdown
---
name: feedback-no-auto-try-catch
description: 用户要求不要自动加 try/catch，项目统一在中间件处理错误
type: feedback
---

不要自动给函数加 try/catch。
**Why**：这个项目的错误统一在中间件层处理，散落的 try/catch 会吞掉错误、
让中间件拿不到，2026-07 因此漏过一次线上告警。
**How to apply**：写新函数时不主动加；看到已有的散落 try/catch 可以提出来，
但不要顺手改（不属于本次任务范围）。
```

- 一个文件 = 一条记忆 = 一个事实
- `description` 是**召回时唯一的判断依据**（§6），所以必须具体
- 正文可以用 `[[其它记忆的 name]]` 互相链接

### 5.3 得失分析：把两条路的账算清楚

| 维度 | 文件 + LLM 选择器 | 向量库 + 重排 |
| --- | --- | --- |
| 索引维护 | **无**。改文件 description 就变了 | 要重新 embed；漏了就是「陈旧向量」故障 |
| 人能读吗 | **能，还能 `git diff`、手改** | 不能。一串小数 |
| 摘要质量 | **写入时模型精心写的一句话，信息密度高** | 自动 embed，没有「摘要」这个概念 |
| 能做语义推理吗 | **能**（见 §6.4 那条「工具正常就别推文档」的规则） | 不能。只有相似度 |
| 规模上限 | **硬上限 200 个文件**（清单要塞进选择器的上下文） | 十万级、百万级都行 |
| 每次召回成本 | 一次小模型调用（几百 ms，用预取藏掉，§7.2） | 一次 ANN 查询（更快） |
| 按结构化字段聚合 | 弱（要 grep frontmatter） | SQL / 带元数据过滤的向量库更强 |

那个 200 的上限就在代码里（`memoryScan.ts:21-22`，2026-08-29 复核）：

```typescript
const MAX_MEMORY_FILES = 200
const FRONTMATTER_MAX_LINES = 30
```

**边界被写成了常量。** 这是我很欣赏的一点：一个方案的适用范围，
最好的表达形式就是代码里那个数字。

### 5.4 这不是某家的偏好，是一个有基准支撑的行业转向

三条外部证据（引自第二份研究文档的调研，2026-02/03，本文未重新验证）：

**① 命名。** 这个转向已经有名字了：
**agent-as-retriever / vectorless RAG / just-in-time context loading**。
列出的采用者包括 Claude Code、Cursor、Windsurf、Cline、Sourcegraph Amp——
都不再把目标语料预先索引进向量库，而是**把检索暴露成工具让 LLM 自己调**。

**② 对照实验。** AAAI 2026 一篇论文（Subramanian et al.，
*Keyword search is all you need*）：同一个模型、同样六个数据集、
同样评测框架，**唯一变量是检索器**——
Bedrock Knowledge Base + Titan embeddings 对比一个调 `pdfgrep`/`rga` 的 ReAct agent，
后者达到 RAG 级性能。

**③ 采用规模。** AGENTS.md 已被 6 万+ 项目使用，Linux Foundation 下标准化。

### 5.5 ⚠️ 但别把结论说过头：这是两个不同规模的问题

这里有个很容易走过头的地方。**「向量库过时了」是错的说法。**

正确的说法是：

> **记忆检索和文档检索被同一个词（RAG）掩盖成了一个问题，
> 实际是两个不同规模的问题。**

| | 记忆检索 | 文档检索 |
| --- | --- | --- |
| 规模 | 几百条 | 几万到几百万篇 |
| 有人工摘要吗 | **有**（写入时模型写的 description） | 通常没有 |
| 清单塞得进上下文吗 | **塞得进**（200 条 × 一行 ≈ 几千 token） | 塞不进 |
| 该用什么 | LLM 选择器 | 向量检索 |

而且方向也不是「回到关键词搜索」。同一份调研指出正在形成一个
**1–3B 参数的「检索专用 LLM」类别**（SWE-grep、Context-1），
以及 RL 训练的检索能力（Search-R1 之后）。

也就是说趋势是：**把检索决策交给模型，backend 用便宜的词法工具。**
Claude Code 的 Sonnet 选择器正好是这个形态的一个实例——
**用一个中等模型做检索决策，用文件系统做 backend。**

### 5.7 本章自检

1. 你搜一个仓库，`grep embedding` 零命中，于是下结论「他们没用向量检索」。
   这个结论可能错在哪？该补一步什么？
2. `MAX_MEMORY_FILES = 200` 这个常量为什么可以说是「方案边界的代码化」？
   如果一个用户有 3000 条记忆会发生什么？
3. 「向量库过时了」和「记忆与文档检索是两个规模问题」——
   为什么后者才是对的说法？前者错在哪？

---
<a id="6"></a>
## §6 召回：用小模型替代相似度检索

§5 说了「不用向量库」，这一章说「那用什么」。

### 6.1 三步流程

```text
每个用户回合：

① scanMemoryFiles
   扫记忆目录，每个 .md 只读前 30 行（FRONTMATTER_MAX_LINES）
   解析 frontmatter 拿 {filename, description, type, mtime}
   最多 200 个文件（MAX_MEMORY_FILES），按 mtime 新→旧排序后截断

② 拼成一份文本清单
   - [feedback] testing.md (2026-08-01T...): 用户要求测试必须用 bun test
   - [project]  release.md (2026-08-20T...): 发版必须先提交再发布，禁开已发布未提交窗口
   - …

③ 把「用户这轮的 query + 这份清单」丢给一个 Sonnet 选择器
   它返回最多 5 个文件名（JSON schema 约束输出）
   → 读出这几个文件的正文 → 拼上新鲜度标注 → 以 <system-reminder> 注入
```

**对照 RAG 那套流程看等价物**：

| RAG 的组件 | 这里的等价物 |
| --- | --- |
| 文档向量化 | 不做。`description` 就是索引 |
| ANN 检索 | Sonnet 读清单 |
| Cross-Encoder 重排 | 同上，一步到位 |
| top-k | 「最多 5 个，可以是 0 个」 |

### 6.2 选择器的 prompt（复核逐字一致）

`findRelevantMemories.ts:18-24`，2026-08-29 实测：

```text
Return a list of filenames for the memories that will clearly be useful to
Claude Code as it processes the user's query (up to 5). Only include memories
that you are certain will be helpful based on their name and description.
- If you are unsure if a memory will be useful in processing the user's query,
  then do not include it in your list. Be selective and discerning.
- If there are no memories in the list that would clearly be useful, feel free
  to return an empty list.
- If a list of recently-used tools is provided, do not select memories that are
  usage reference or API documentation for those tools (Claude Code is already
  exercising them). DO still select memories containing warnings, gotchas, or
  known issues about those tools — active use is exactly when those matter.
```

三条判据，逐条讲。

### 6.3 ★ 前两条：宁缺毋滥，允许返回 0 条

```text
不确定就不选。没有合适的就返回空列表。
```

**这和 RAG 默认的 top-k 行为相反。** top-k 总会返回 k 条，哪怕相关性很低。
这里允许返回 0 条。

为什么？因为**注入式检索和搜索引擎的取舍完全不同**：

| | 搜索引擎 | 注入式检索（记忆） |
| --- | --- | --- |
| 结果给谁 | 人。人会自己筛，多给几条无害 | **模型。直接进上下文** |
| 误召回的代价 | 低（用户跳过它） | **高**：占 token + 分散注意力 + **可能被当成约束遵守** |
| 该优化什么 | 召回率 | **精确率** |

第三条代价最阴：一条不相关的记忆进了上下文，模型可能把它**当成你给的约束**去遵守。
你问「帮我加个日志」，它召回了一条无关的「不要改动 config 目录」，
于是它开始绕着 config 走——而你根本没提 config。

> 🔑 **在注入式检索里，误召回的代价远高于漏召回。**
> 所以这里的默认行为必须是「宁缺毋滥」，而不是 top-k。
> 很多人（包括我读源码之前）把搜索和注入的取舍混为一谈了。

### 6.4 ★★ 第三条：用执行状态调制检索

第三条规则我在任何检索文献里都没见过：

```text
工具正在被正常使用 → 不要推该工具的 API 文档
但仍然要推它的坑、gotcha、已知问题 —— 正在用的时候恰恰最需要这些
```

实现在 `collectRecentSuccessfulTools`（`attachments.ts:2465`），注释写着：

```text
Tools that succeeded (and never errored) since the previous real turn boundary.
The memory selector uses this to suppress docs about tools that are working —
surfacing reference material for a tool the model is already calling
successfully is noise.
Any error → tool excluded (model is struggling, docs may help)
```

**「成功则不推文档，失败则推」。**

拆开看这个设计的信息量：

```text
传统检索模型：相关性 = f(query, document)
                          ↑ 只有两个输入

这里：        相关性 = f(query, document, agent 当前是否卡住)
                                          ↑ 第三个输入
```

工具跑得顺就不需要说明书；一报错就把文档送上来。

> 🔑 **这可能是整个记忆系统里最可迁移的一个想法**：
> **检索的输入不应只有 query，还应包括「当前是否遇到困难」的信号。**
>
> 为什么学术界没有这个？因为学术评测基本是单轮 QA，
> **没有「当前执行状态」这个概念**。它只在 agent 这种有循环、
> 有工具、有失败重试的形态里才存在。

### 6.5 `alreadySurfaced`：先过滤再选，不是选完再去重

```text
`alreadySurfaced` filters paths shown in prior turns before the
Sonnet call, so the selector spends its 5-slot budget on fresh
candidates instead of re-picking files the caller will discard.
```
（`findRelevantMemories.ts:35-38`）

差别在哪：

```text
❌ 选完再去重：
   Sonnet 可能 5 个名额全挑了已经在上下文里的文件
   → 去重后剩 0 条 → 白跑一次调用

✅ 先过滤再选：
   把已注入过的从清单里去掉，Sonnet 只在新候选里挑
```

而 `alreadySurfaced` 的来源很讲究（`attachments.ts:2244-2250`）：

```text
Scanning messages rather than tracking in toolUseContext means compact
naturally resets both — old attachments are gone from the compacted
transcript, so re-surfacing is valid again.
```

**去重状态从消息历史里推导，而不是存在一个独立变量里。**

好处是压缩发生时状态**自动重置**：

```text
用外挂计数器：
  压缩把旧的注入清掉了
  但计数器还记着「这条给过了」
  → 这条记忆永久缺失，而且没人知道

从消息历史推导：
  压缩后旧注入从历史里消失了
  → 推导出来的「已注入集合」自动变空
  → 重新注入，这是正确行为
```

> 🔑 **在有上下文压缩的系统里，任何「已经做过 X」的状态最好从消息历史推导，
> 而不是外挂存储。** 否则状态会和被压缩掉的上下文脱钩。
> （这条在 §12 会以一个更一般的形态再出现。）

### 6.6 两条注入路径：索引常驻 + 正文按需

回过头看全景，记忆进上下文有两条路：

| | 路径 A：`MEMORY.md` 索引 | 路径 B：topic 文件正文 |
| --- | --- | --- |
| 什么时候进 | **每次会话，全量** | 每个用户回合，选择器挑最多 5 条 |
| 进哪儿 | 系统提示 | `<system-reminder>` |
| 上限 | 200 行 **且** 25KB | 每文件 200 行且 4KB，每轮 5 个 |
| 作用 | **目录页**：让模型知道「有哪些记忆存在」 | 具体内容 |

`memdir.ts:229` 那句 prompt（复核一致）：

```text
`MEMORY.md` is always loaded into your conversation context — lines after 200
will be truncated, so keep the index concise
```

这就是为什么 `MEMORY.md` 是**索引不是内容仓库**：它一定会被加载，
所以每一行都在花你的 token 预算。

⚠️ **一个正在发生的迁移，值得知道**：源码里有个 feature flag `tengu_moth_copse`
（`memdir.ts:423`、`extractMemories.ts:367`、`claudemd.ts:1137-1151`、
`attachments.ts:2367`，2026-08-29 复核仍在）。它打开时，
**索引不再注入系统提示，全靠动态召回**。

也就是说他们正在从「常驻索引 + 动态召回」迁移到「纯动态召回」。
**动机源码没说**——省 token 还是索引效果不好，两种解释都说得通。
第二份研究文档也诚实记了这一条不确定。我这里同样不猜。

### 6.7 本章自检

1. 为什么记忆召回**允许返回 0 条**，而搜索引擎不会返回 0 条？
   一句话说清两者的取舍差别。
2. 「工具跑得顺就不推它的文档」——这条规则用向量检索能表达吗？为什么？
3. `alreadySurfaced` 如果改成用一个 `Set` 存在内存里（而不是从消息历史推导），
   会在什么时候出错？出的错长什么样，看得见吗？
4. 一个用户有 500 条记忆。按 §5.3 和本章，会发生什么？系统会报错吗？

---
<a id="7"></a>
## §7 注入：三层预算与字节冻结

召回选出了 5 个文件，现在要把它们塞进上下文。**这一步有三个坑，都不在概念资料里。**

### 7.1 三层预算：单次限流不等于总量限流

`attachments.ts:269-289`（2026-08-29 复核，注释逐字一致）：

```typescript
const MAX_MEMORY_LINES = 200
// Line cap alone doesn't bound size (200 × 500-char lines = 100KB).  The
// surfacer injects up to 5 files per turn via <system-reminder>, bypassing
// the per-message tool-result budget, so a tight per-file byte cap keeps
// aggregate injection bounded (5 × 4KB = 20KB/turn).
const MAX_MEMORY_BYTES = 4096

export const RELEVANT_MEMORIES_CONFIG = {
  // Per-turn cap (5 × 4KB = 20KB) bounds a single injection, but over a
  // long session the selector keeps surfacing distinct files — ~26K tokens/
  // session observed in prod.  Cap the cumulative bytes: once hit, stop
  // prefetching entirely.  Budget is ~3 full injections.
  MAX_SESSION_BYTES: 60 * 1024,
} as const
```

三层：

| 层 | 上限 | 防的是什么 |
| --- | --- | --- |
| ① 单文件 | 200 行 **且** 4KB | 一个巨型记忆文件吃掉整轮预算 |
| ② 单轮 | 5 个文件 → 20KB | 一轮注入太多 |
| ③ **整个会话累计** | **60KB，用完彻底停止预取** | **长会话里累积吃光上下文** |

**第三层是最容易漏的，而且只有跑过生产才会发现。** 看那句注释里的实测数据：
`~26K tokens/session observed in prod`。

机制是这样的：

```text
选择器每轮都在挑「不同」的文件（因为 alreadySurfaced 会把给过的过滤掉）
  → 单看每一轮都合规：5 个文件、20KB、完全在预算内
    → 但一个 50 轮的会话，累起来就是几十 KB → 26K tokens
      → 上下文被记忆吃掉了一大块，而每一轮的检查都显示「没超」
```

> 🔑 **单次限流不等于总量限流。**
> 做限流时人的本能是 per-request，很少想到 per-session cumulative。
> **凡是「每轮都会发生、且每轮都合规」的开销，都要额外问一句累计是多少。**

### 7.2 双上限：为什么行数和字节都要有

注意 ① 那层是「200 行**且** 4KB」，两个上限同时生效。索引那边也是一样
（`memdir.ts:35-38`，复核一致）：

```typescript
export const MAX_ENTRYPOINT_LINES = 200
// ~125 chars/line at 200 lines. At p97 today; catches long-line indexes that
// slip past the line cap (p100 observed: 197KB under 200 lines).
export const MAX_ENTRYPOINT_BYTES = 25_000
```

`p100 observed: 197KB under 200 lines` —— **有用户把完整记忆内容写进了索引，
200 行以内，但 197KB。行数上限完全没拦住。**

> 🔑 **行数和字节两个上限防的是不同形状的滥用**：
> 行数防「条目太多」，字节防「单条太长」。只设一个就有一整类滥用能绕过去。

顺带一个数字上的巧合值得知道：外部调研（2026-02）给出的数据是
**前沿模型的指令跟随上限在 150–200 条左右**，超过后
**所有指令的质量一起下降**（不只是最新的那些）。
而 `MAX_ENTRYPOINT_LINES = 200`，索引里每行一条记忆指针。
这个数字看起来是随手定的，但它和模型的能力天花板惊人地接近。

### 7.3 ★ 预算上限同时是质量措施，不只是省钱

这一层认知很关键，我一开始也以为预算纯粹是成本考虑。

外部调研的另一个数字：**lost-in-the-middle 效应下，
长上下文中段的信息有 15–30% 的性能下降。**

于是：

```text
注入的记忆越多
  → 上下文越长
    → 中段的记忆越容易被「看不见」
      → 每一条记忆被真正注意到的概率越低
```

**注入太多记忆本身会降低记忆的有效性。**

> 🔑 **预算上限是质量措施，不只是成本措施。**
> 这句话在面试里很好用，因为它说明你不是在背「要限流」这个结论，
> 而是知道限流在这里有两个独立的理由。

### 7.4 ★★ 字节冻结：注入内容一旦写入就不能重算

这是三个坑里最阴的一个，第二份研究文档的作者第一遍也漏了。

先回顾 §0.6：prompt cache 按**前缀**匹配，从第一个不同的字节起全部失效。

现在看注入的 header 长什么样（`attachments.ts:2327-2333`）：

```typescript
export function memoryHeader(path: string, mtimeMs: number): string {
  const staleness = memoryFreshnessText(mtimeMs)
  return staleness
    ? `${staleness}\n\nMemory: ${path}:`
    : `Memory (saved ${memoryAge(mtimeMs)}): ${path}:`
}
```

header 里含 **「saved today」/「N days old」这种相对时间**。问题来了：

```text
如果每轮渲染都重新计算这个 header：
  某条记忆昨天注入时写的是 "saved today"
  今天跨过午夜了，重新算变成 "saved yesterday"
    → 而这条消息已经在上下文里了
      → 内容变了一个字节
        → 从这条消息往后的整个 prompt cache 全部失效
          → 这一轮的成本翻十倍，而且没有任何报错
```

解法（`messages.ts:3708-3722`，复核一致）：

```typescript
case 'relevant_memories': {
  return wrapMessagesInSystemReminder(
    attachment.memories.map(m => {
      // Use the header stored at attachment-creation time so the
      // rendered bytes are stable across turns (prompt-cache hit).
      const header = m.header ?? memoryHeader(m.path, m.mtimeMs)
```

**header 在创建时算好存下来，之后永远复用。** 只有恢复旧会话（缺这个字段）
才回退到重算。

同一个思路还有一处更反直觉的应用（`memdir.ts:330-334`）：

```text
this prompt is cached by systemPromptSection('memory', ...) and NOT
invalidated on date change. The model derives the current date from the
date_change attachment (appended at the tail on midnight rollover) rather
than the user-context message — the latter is intentionally left stale to
preserve the prompt cache prefix across midnight.
```

**故意让系统提示里的日期保持过时**，把真实日期通过**尾部附件**传给模型。
因为系统提示在缓存前缀里，改一个字符全毁；尾部追加不影响前缀。

同一个逻辑值（当前日期）在两个位置有两种表示，**只为保住缓存**。

> 🔑 **一条硬规则**：
> **注入进上下文的任何内容，一旦写入就必须字节冻结；
> 需要变化的信息只能追加在尾部。**
>
> 很多资料会讲「Cache-Aware Design：静态前置、动态后置」，
> 但那是**设计阶段**的原则。这里是**运行时的后果**——
> 你会发现自己在故意保留一个错的日期。

### 7.5 预取：把召回的延迟藏进模型的推理时间

§6 的召回要一次小模型调用，几百毫秒。放在请求路径上就是每轮加几百毫秒。

解法是**发射即忘 + 轮询消费**（`query.ts:297-304`）：

```typescript
// Fired once per user turn — the prompt is invariant across loop iterations,
// so per-iteration firing would ask sideQuery the same question N times.
// Consume point polls settledAt (never blocks).
using pendingMemoryPrefetch = startRelevantMemoryPrefetch(...)
```

消费点在工具执行之后（`query.ts:1599-1614`）：

```typescript
if (pendingMemoryPrefetch &&
    pendingMemoryPrefetch.settledAt !== null &&      // ← 关键：没就绪就跳过
    pendingMemoryPrefetch.consumedOnIteration === -1) {
  ...
}
```

`settledAt !== null` 这个检查是全部要点：**没准备好就跳过，下一轮再试，永不阻塞。**
而 agent loop 通常有多轮迭代（模型输出 → 调工具 → 再输出），
所以预取有多次机会被消费。

三个配套细节：

**① 每个用户回合发射一次，不是每次 loop 迭代。**
注释说得很清楚：prompt 在这一轮内不变，按迭代发射就是问同一个问题 N 次。

**② 用 `using` + `Disposable` 做清理。** while 循环里有约 13 个 return 点
（`attachments.ts:2340-2352`），用 Disposable 就不用在每个点都写清理逻辑。

**③ 廉价启发式放在昂贵调用之前**（`attachments.ts:2365-2386`）：

```typescript
// Single-word prompts lack enough context for meaningful term extraction
if (!input || !/\s/.test(input.trim())) return undefined
```

单词 prompt（「继续」、「是」、「ok」）不触发召回。

> 🔑 **旁路增强（记忆召回、技能发现、相关性判断）一律做成
> 「发射即忘 + 轮询消费」，永不阻塞主路径。**
> 代价是可能这一轮赶不上，但**增强本来就是可选的**——
> 它不该给主路径加几百毫秒。

### 7.6 超限不静默：告知 + 给修复指引

索引超限时不是悄悄截断（`memdir.ts:89-91`）：

```text
> WARNING: MEMORY.md is 197KB (limit: 25KB) — index entries are too long.
Only part of it was loaded. Keep index entries to one line under ~200 chars...
```

而且截断的位置有讲究（`memdir.ts:82-85`）：字节截断在上限**之前的最后一个换行处**切，
不切在行中间。切半行会产生语义残缺的内容，模型可能误读。

> 🔑 **静默截断会让用户困惑「为什么 agent 不记得我写的东西」**，
> 而这个困惑无法自己解开——他看不到截断发生了。
> **凡是会丢数据的降级，都要让受影响的一方看见。**

### 7.7 本章自检

1. 为什么「每轮 20KB」这个上限合规，会话累计却能到 26K tokens？
   这类问题的通用形式是什么？
2. 一个记忆 header 写着「saved today」。为什么不能每轮重新计算它？
   算了会发生什么，你看得见吗？
3. 「故意让系统提示里的日期保持过时」——这不是 bug 吗？辩护一下。
4. 预取如果改成阻塞等待（「反正就几百毫秒」），会有什么后果？

---
<a id="8"></a>
## §8 ★★ 漂移：本文最重要的一章

前面七章讲的是「怎么让记忆系统跑起来」。这一章讲**为什么它会变成负债，
以及怎么让它由负转正**。

如果全文只读一章，读这章。如果面试只准备一章，也是这章。

### 8.1 先看伤害长什么样

第一份研究文档记的是一次真实事故。完整链条（§3.6 出现过，这里展开）：

```text
① 早期会话，观察到一个事实 A
   「sid-code 的 ink 是外部 npm 包 @jrichman/ink@6.4.11」

② 从 A 推出结论 B
   「ink 是黑盒 npm 包，cc fork 的 RawAnsi/Static/blit/selection 都搬不了」

③ 把 B 写进 5 条 memory + 一份设计文档，固化成「硬边界 / 别尝试」

④ 时间流逝
   cc 自研的 ink 整套 vendor 进了 src/ink/，node_modules 里的 ink 被删了
   → 前提 A 失效
   → 但结论 B 没人改   ← 漂移在这里发生

⑤ 后来的会话（要改渲染代码）
   读到 B：「搬不了 fork，别尝试」
   → 差点据此放弃一条完全可行的路   ← 实际伤害
```

注意伤害的形态：**没有报错，没有崩溃，没有任何异常信号。**
只是一个本来能做成的事，被判定为「做不了」。

### 8.2 ★ 为什么「有害记忆比没有记忆更危险」

这是本章第一个反直觉结论。直觉会说「记错了总比不知道好，至少有个起点」。
错。看这张表：

| 维度 | 没有记忆 | 有害记忆 |
| --- | --- | --- |
| agent 的行为 | 不确定 → **主动 `ls`/`grep` 去核对** | 自信 → **跳过核对，直接采信** |
| 结果 | 慢一点，但正确 | 快，但错，而且**错得理直气壮** |
| 纠错成本 | 低（它本来就在查） | 高（要先意识到「记忆错了」这件反直觉的事） |

> 🔑 **有害记忆的毒性在于它伪装成已验证的结论，诱导你跳过验证。**
> **它消灭的不是「无知」，而是「求证的动作」。**

而 §1.3 引的 TEPA 数据给了这个论断的量化版本：

```text
append-only 记忆      0.138
完全不用记忆          0.837    ← 高出 6 倍
```

**没有失效机制的记忆是净负债，不是「收益打折」。**

### 8.3 ★★ 根因：精确度被误当成了可信度

这是全章最锋利的一个洞察，来自 `memoryAge.ts:29-31` 的注释
（2026-08-29 复核，逐字一致）：

```text
Motivated by user reports of stale code-state memories (file:line
citations to code that has since changed) being asserted as fact —
the citation makes the stale claim sound more authoritative, not less.
```

**「那个引用让过时的断言听起来更权威，而不是更不权威。」**

这句话值得拆开：

```text
一条模糊的旧记忆：「渲染那块好像有点问题」
  → 模型会怀疑它，会去看一眼

一条带精确行号的旧记忆：「渲染 bug 在 renderer.ts:142，因为 blit 没处理 selection」
  → 模型会当成「已核实的事实」直接引用
  → 而它可能三个月前就不成立了
```

**精确度（precision）和可信度（credibility）在模型眼里被混淆了。**
越具体的旧记忆越危险，这和人的直觉正好相反——我们通常觉得
「说得越具体越靠得住」。

这个洞察直接决定了解法的方向：

```text
❌ 攻击「存在性」：把旧记忆删掉
   问题：删了可能还有价值的东西；而且删不干净（怎么知道哪条过时了？）

✅ 攻击「可信度」：不删，但在它前面加一句「这是 N 天前的快照，不是当前状态」
```

### 8.4 五层防御，全部在读取侧

这里要回答一个必然被问的问题：**「漂移不是 bug 吗？为什么不修？」**

答案分两半。先说为什么修不了（8.6），先看它实际怎么防的。

五层防御，**全部在「读取/使用」侧，而不是「让存储永远正确」**：

#### 防御 1 · 新鲜度标注（`memoryAge.ts:33-42`）

```typescript
export function memoryFreshnessText(mtimeMs: number): string {
  const d = memoryAgeDays(mtimeMs)
  if (d <= 1) return ''
  return (
    `This memory is ${d} days old. ` +
    `Memories are point-in-time observations, not live state — ` +
    `claims about code behavior or file:line citations may be outdated. ` +
    `Verify against current code before asserting as fact.`
  )
}
```

**它不删记忆，它给记忆贴标签。而标签是一段自然语言，写给模型看的。**

#### 防御 2 · 相对时间表述（`memoryAge.ts:10-13`）

```text
Human-readable age string.  Models are poor at date arithmetic —
a raw ISO timestamp doesn't trigger staleness reasoning the way
"47 days ago" does.
```

不给 `2026-06-27T10:23:00Z`，给 `47 days ago`。

**理由是模型的认知特性**：给它 ISO 时间戳，它得先算差值，
而且经常算错或者干脆不算；给它「47 天前」，直接触发陈旧性推理。

> 🔑 **给模型的时间信息一律预计算成相对表述。**
> 这条可以直接抄进任何系统，成本为零。

#### 防御 3 · 告警必须稀疏（`memoryAge.ts:23-24`）

```typescript
if (d <= 1) return ''   // 今天和昨天的记忆不加警告
```

注释的理由是 `warning there is noise`。

**每条记忆都挂一句警告，警告就失去意义了**——模型会学会忽略它。
这在监控系统里是常识（告警疲劳），在 prompt 设计里同样成立。

#### 防御 4 · 常驻的 drift caveat（`memoryTypes.ts:201`）

系统提示里常驻一条（复核逐字一致，我加了中文对照）：

```text
Memory records can become stale over time. Use memory as context for what was
true at a given point in time. Before answering the user or building
assumptions based solely on information in memory records, verify that the
memory is still correct and up-to-date by reading the current state of the
files or resources. If a recalled memory conflicts with current information,
trust what you observe now — and update or remove the stale memory rather
than acting on it.
```

一句话概括：**读到记忆 ≠ 得到事实，= 得到一条「过去为真、现在待核对」的线索。**

#### 防御 5 · 独立 section：「Before recommending from memory」

`memoryTypes.ts:240-256`（复核逐字一致）：

```text
## Before recommending from memory

A memory that names a specific function, file, or flag is a claim that it
existed *when the memory was written*. It may have been renamed, removed,
or never merged. Before recommending it:

- If the memory names a file path: check the file exists.
- If the memory names a function or flag: grep for it.
- If the user is about to act on your recommendation (not just asking about
  history), verify first.

"The memory says X exists" is not the same as "X exists now."

A memory that summarizes repo state (activity logs, architecture snapshots)
is frozen in time. If the user asks about *recent* or *current* state, prefer
`git log` or reading the code over recalling the snapshot.
```

**核心金句值得背下来**：

> **「The memory says X exists」is not the same as「X exists now.」**

这一层给的是**具体动作**，不是原则。这个区别很重要，8.5 讲为什么。

### 8.5 ★★ 这些 prompt 是 eval 测出来的——位置和措辞都敏感

这一节是本章最能在面试里拉开差距的部分，因为它展示了一件反常识的事：
**同一段话，放在不同位置、换个标题，效果从 0/3 变成 3/3。**

源码注释里带 eval 编号和通过率（`memoryTypes.ts:228-244`，2026-08-29 复核）：

**① 位置敏感**：

```text
H1 (verify function/file claims): 0/2 → 3/3 via appendSystemPrompt. When
   buried as a bullet under "When to access", dropped to 0/3 — position
   matters. The H1 cue is about what to DO with a memory, not when to
   look, so it needs its own section-level trigger context.
```

**同样的内容**，作为独立 section 跑 3/3；降级成「When to access」下的一个 bullet，
掉到 **0/3**。

理由给得很清楚：H1 讲的是「拿到记忆之后**该做什么**」，
不是「**什么时候**去看记忆」——放在「何时访问」下面属于**语义错位**，
模型在决策点上取不到它。

**② 措辞敏感**（`memoryTypes.ts:241-244`）：

```text
Header wording matters: "Before recommending" (action cue at the decision
point) tested better than "Trusting what you recall" (abstract). The
appendSystemPrompt variant with this header went 3/3; the abstract header
went 0/3 in-place. Same body text — only the header differed.
```

**正文一字不差，只改标题**：

| 标题 | 通过率 |
| --- | --- |
| `## Before recommending from memory`（决策点的动作提示） | **3/3** |
| `## Trusting what you recall`（抽象概念） | **0/3** |

> 🔑 **两条可迁移的 prompt 工程结论**：
> ① **prompt 的位置是设计的一部分**，不是排版问题。一条指令要放在
> 「模型会在那个时刻读到它」的位置。
> ② **标题要写成决策点的动作提示，不要写成抽象概念。**
> 「Before recommending」告诉模型「你正要推荐，停一下」；
> 「Trusting what you recall」是个名词短语，不触发任何动作。

**③ 已知缺口被诚实标注**（`memoryTypes.ts:237-238`）：

```text
Known gap: H1 doesn't cover slash-command claims (0/3 on the /fork case —
slash commands aren't files or functions in the model's ontology).
```

H1 说的是「file / function / flag」，而斜杠命令**在模型的本体论里不属于这三类**，
所以这条线索抓不到它。**连治不好的地方都写在注释里。**

**④ 还有一个失败模式的精确刻画**（`memoryTypes.ts:207-211`）：

```text
H6 (branch-pollution evals #22856, case 5 1/3 on capy): the "ignore" bullet
is the delta. Failure mode: user says "ignore memory about X" → Claude reads
code correctly but adds "not Y as noted in memory" — treats "ignore" as
"acknowledge then override" rather than "don't reference at all."
```

用户说「忽略关于 X 的记忆」，模型的失败方式不是「不听话」，而是
**把「忽略」理解成「先承认再否定」**——它正确读了代码，
但顺口加一句「而不是记忆里说的 Y」。

对应的指令（`WHEN_TO_ACCESS_SECTION`）：

```text
If the user says to *ignore* or *not use* memory: proceed as if MEMORY.md
were empty. Do not apply remembered facts, cite, compare against, or mention
memory content.
```

**「当作 MEMORY.md 是空的」**——不是「承认它但说它不对」。

### 8.6 为什么漂移不可能在存储层根治

回答那个问题：**这不是 bug 吗？**

不是。它是**信息论层面的固有矛盾**：

```text
记忆 = 对世界某一刻的快照
世界会变，快照不会自动跟着变
  → 任何「把结论持久化」的系统都必然产生漂移
  → 这不是哪段代码写错了
```

要「修复到永不漂移」，等价于要求记忆系统**在世界变化的瞬间自动更新所有相关记忆**。
这需要它持续重扫全部代码、重验所有记忆，成本爆炸，
而且**仍然无法覆盖「外部系统变化」**（依赖升级、API 变更、别人改了服务端）。

那还能不能做得更好？能，但每条都有代价：

| 更主动的方案 | 代价 |
| --- | --- |
| 后台定期重验（grep 记忆里的 file:line 还在不在） | 成本高；且只能查「代码内」断言，查不了依赖/外部系统 |
| 写入时强制 TTL（含 file:line 的记忆给更短过期） | 误杀长期有效的方法论类记忆 |
| 结构化前提字段（显式声明「我依赖前提 X」） | 要求写入时就预知所有前提，不现实 |

实际选的是**最低成本、最高鲁棒**的那条：读取侧提醒 + 模型核对，
外加 §2.6 那个 `autoDream` 定期整理（这是「后台重验」的一个轻量版本——
它不重验所有记忆，只在有足够新会话时整理一次）。

> 🔑 **面试可以直接用的一段**：
> 「漂移不是 bug，是持久化记忆的固有矛盾。所以我们不追求『记忆永远正确』
> （不可能），而是在**读取侧**不断提醒模型『记忆可能过时，用之前先核对』。
> 五层防御全在读取侧，而且每一层的措辞和位置都是 eval 调出来的——
> 有一条线索作为独立 section 是 3/3，降级成 bullet 就 0/3。」

### 8.7 发现漂移之后：纠偏 SOP

防御是减少伤害，纠偏是止损。第一份研究文档给的流程（实际用过的）：

```text
1. 先实证现状，再动手
   └─ ls / grep / 读源码确认「现在到底什么样」，逐项核对记忆里的断言
      ⚠️ 绝不凭「我记得」就改 —— 那只是用一个漂移结论换另一个

2. 分类处置
   ├─ 前提和结论都失效  → 整条作废（或删）
   ├─ 结论仍对、只是前提变了 → 保留结论，开头加「更正前提」块
   └─ 完全正确 → 不动

3. ⛔ 绝不在旧错误上叠补丁
   └─ 要么重写要么删。叠补丁会让记忆变成自相矛盾的考古地层

4. 同步 MEMORY.md 索引（§4.6：漏了索引等于没改）

5. 留漂移记录（推荐）
   └─ 作废的记忆可以保留，写明「原结论 / 为何失效 / 指向当前正确的那条」
      这是宝贵的「我们曾错在哪」元知识
```

两个模板（取自真实纠偏过的记忆）：

**整条作废型**：

```markdown
**2026-06-15 整条作废（保留作漂移记录）**：本记忆讨论的「<原结论>」——
前提与结论均已失效。
现状（实证）：<ls/grep 核对到的当前事实>
**Why**：基于「<已消失的前提>」的整套分析，在 <什么变化> 之后全部反转。
**How to apply**：<现在该怎么做>，当前正确全貌见 [[正确记忆的 name]]。
```

**更正前提型**：

```markdown
> **2026-06-15 更正前提**：本记忆原说「<失效的前提>」——已失效。
> 现状是 <当前事实>（见 [[正确记忆]]）。
> 但**正解依然成立**：<为什么结论不受这个前提变化影响>。

<保留原本仍然正确的机制/结论正文>
```

⚠️ 一个实现细节：**后台抽取 agent 不能 `rm`**（`extractMemories/prompts.ts:37`），
只能 Edit/Write。所以「删除」在自动路径里实际是「改写为作废」。
手动纠偏可以真删，但保留作漂移记录往往更有价值。

### 8.8 业界对照：这套方案在坐标系里的位置

把 §1.3 那张 TEPA 表拿回来，标出这套方案的位置：

| 策略 | 全反转成功率 | 这套方案是它吗 |
| --- | --- | --- |
| append-only | 0.138 | ❌ 不是——prompt 明确要求 `Update or remove memories that turn out to be wrong or outdated` |
| last-write-wins | 0.686 | ❌ 不是纯的 |
| no memory | 0.837 | — |
| **last-write-wins + 验证规则** | **0.863** | ✅ **最接近这一档** |
| TEPA-Full（显式撤销 + 验证） | 0.910 | ❌ 缺「显式撤销/tombstone」那一环 |

> **也就是说：它用 prompt 层的验证要求，替代了算法层的撤销机制。**
> 便宜、无状态、能覆盖大部分情况；
> 代价是**依赖模型真的执行验证**——而 8.5 那些 eval 记录
> （0/2 → 3/3、位置一错就 0/3）恰恰说明**这个依赖并不牢固**。

另外两个业界数字（引自第二份文档的调研，2026-03，本文未重新验证）：

- **Mem0 0.8.2 在 LoCoMo 基准上 91.6 分，但 30 天后的有效准确率只有 49.0%，
  陈旧率 38%。** 基准分和生产分差 32.4 个百分点。
- 那份测评把三大失效模式排第一的正是这条：**Hallucination Amplification——
  陈旧或未验证的记忆被当作 ground truth 返回，agent 从错误前提正确推理，
  产出自信的错误答案。** 而且**三个失效模式都是静默的**。

它给的根因分类是一句话：**没有写入门（write gate）**。
——回到 §3。

### 8.9 这套方案缺什么（能说出缺口才显得懂行）

诚实列四条：

| 缺口 | 业界在做什么 | 值多少 |
| --- | --- | --- |
| **显式 tombstone** | TEPA 的「显式撤销」：记录「这条已被推翻」而非直接覆盖 | 0.863 → 0.910，约 4.7 个点 |
| **陈旧率指标化** | `stale_hit_ratio`：召回的记忆里有多少已过期 | 现在只 log 召回率/选择率，**看不见质量在腐烂** |
| **记忆所有权与治理** | 按域联邦（财务团队拥有营收定义、数据工程拥有 schema 语义） | 小团队无感，几百人组织会变成无主的知识沼泽 |
| **主动确认（Active Probing）** | 「你之前偏好早班机，现在还是吗？」 | CLI 场景打断成本高，所以刻意不做——但偏好驱动的产品必须做 |

第二条值得多说一句，因为它是最可操作的一条：

```text
现在能看到的：候选多少条、选中多少条
看不到的：  选中的那几条里，有多少是已经过期的

  → 记忆质量在腐烂时，曲线上什么都不会动
    → 只能等用户报告「它又用了个老信息」
```

**这是一个典型的「防线全在、但没有度量」的形态。** §12.6 会把它归类。

### 8.10 实操口诀

> **看到一条记忆，先问三句：**
> **① 它的前提还在吗？②它多老了？③它具体到 file:line / 函数名 / flag 了吗？**
>
> **任何一句让你不安 → 先 `ls`/`grep`/`Read`，再用。**

分级采信表（按 §8.4 防御 5 的原文整理）：

| 记忆内容 | 用前动作 |
| --- | --- |
| 提到文件路径 | check the file exists |
| 提到函数 / flag | **grep for it** |
| 用户即将据此行动（不是问历史） | **verify first** |
| 仓库状态快照（活动日志/架构） | 优先 `git log` 或读代码，而不是回忆快照 |
| 方法论 / Why / 用户偏好 | **可以直接采信**（抽象的东西耐久） |

最后一行很重要，别把这一章读成「所有记忆都不可信」：

> 🔑 **记忆越具体越易漂移，越抽象越耐久。**
> 「改渲染前先读 `src/ink/` 源码」这条方法论可以活很久；
> 「渲染 bug 在 `renderer.ts:142`」下周就可能是错的。

### 8.11 本章自检

1. 为什么带 `file:line` 的旧记忆比模糊的旧记忆更危险？
   这个现象的一句话概括是什么？
2. 同一段 prompt 从独立 section 降级成 bullet，通过率 3/3 → 0/3。
   源码给的解释是什么？你能从中提炼出什么可迁移的规则？
3. 「漂移是 bug，应该在存储层修掉」——反驳它。
   然后说清「那还能做得更好吗」。
4. `stale_hit_ratio` 这个缺失的指标，为什么它的缺失特别危险？
   （提示：想想曲线会怎么动）
5. 你发现一条记忆的前提失效了，但结论恰好还对。该怎么处理？

---
<a id="9"></a>
## §9 会话记忆：工作记忆与压缩

前八章讲的都是 L1 长期记忆。这一章讲 L2——它解决**完全不同的问题**，
所以机制也完全不同。

### 9.1 它解决的问题：压缩必然丢信息

先把问题讲清楚。上下文有硬上限（§0.1），会话变长必然撞上限，撞上限就要压缩：

```text
上下文快满
  → 触发压缩（compact）：让模型把前面几十轮对话摘要成一段话
    → 摘要必然丢信息（这是摘要的定义，不是 bug）
      → 丢了什么？往往正是「我刚才试过 A 方案，失败了，原因是 X」
        → 压缩后 agent 又去试 A
          → 你看着它在你眼前重复犯同一个错，而它「不记得」自己犯过
```

**注意这个问题 L1 长期记忆解决不了。** 为什么？因为 §3 的排除清单里明确写着
不存 `Ephemeral task details: in-progress work, temporary state, current
conversation context`。「我试过 A 失败了」是本次任务的临时状态，
它不满足「跨会话有用」，不该进 L1。

所以需要一个**只活在这个会话里、专门为压缩准备**的机制。

### 9.2 解法：在压缩之前就持续维护一份结构化摘要

```text
传统压缩：           上下文满了 → 现场调一次 LLM 生成摘要 → 用它替换旧消息
                                  ↑ 这一次调用要在几万 token 上做，且只有一次机会

会话记忆的做法：      对话进行中就持续维护一份结构化笔记
                     → 上下文满了 → 直接拿现成的那份
                                  ↑ 已经攒了很多轮，信息更全，而且不占压缩时的时间
```

### 9.3 ★ 模板即契约：十个固定小节

我原以为会话记忆就是「把对话摘要写个文件」。看了 prompt 才发现**关键在结构**
（`SessionMemory/prompts.ts:11-41`，2026-08-29 复核，逐字一致）：

```markdown
# Session Title
_A short and distinctive 5-10 word descriptive title for the session..._

# Current State
_What is actively being worked on right now? Pending tasks not yet completed..._

# Task specification
_What did the user ask to build? Any design decisions or other explanatory context_

# Files and Functions
_What are the important files? In short, what do they contain and why relevant?_

# Workflow
_What bash commands are usually run and in what order?..._

# Errors & Corrections
_Errors encountered and how they were fixed. What did the user correct?
 What approaches failed and should not be tried again?_

# Codebase and System Documentation
# Learnings
# Key results
# Worklog
```

看第六节 `Errors & Corrections` 的说明：
**`What approaches failed and should not be tried again?`**
——这一节就是为 9.1 那个「压缩后又去试 A」的问题专门设的。

而更新指令里最硬的约束（`prompts.ts:55-61`，复核一致）：

```text
- The file must maintain its exact structure with all sections, headers,
  and italic descriptions intact
-- NEVER modify, delete, or add section headers
-- NEVER modify or delete the italic _section description_ lines (these are
   TEMPLATE INSTRUCTIONS that must be preserved exactly as-is - they guide
   what content belongs in each section)
-- ONLY update the actual content that appears BELOW the italic descriptions
```

**斜体说明既是文档也是 prompt。**

这个设计很巧，值得完整想一遍：

```text
如果只在 update prompt 里说「请填写 Files and Functions 小节」：
  → 模型每次更新都要重新理解这个小节要什么
  → 而 update prompt 是外部的，和文件内容是分开的两份东西

把说明留在文件里：
  → 模型读文件时，说明和已有内容一起进上下文
  → 语义锚定更强：它看到的是「这一节要填什么」紧挨着「这一节现在填了什么」
  → 而且结构固定 → 压缩后注入的格式是可预测的，下游可以按小节做截断
```

> 🔑 **模板即契约 / 自携带指令**：
> **一个数据结构不只存内容，还存「该怎么填我」。**
> 这个模式可以迁移到任何「让模型反复更新同一份文档」的场景。

### 9.4 一条反自指约束：别把「我在做笔记」写进笔记

`prompts.ts:50` 那句（复核一致）：

```text
IMPORTANT: This message and these instructions are NOT part of the actual
user conversation. Do NOT include any references to "note-taking", "session
notes extraction", or these update instructions in the notes content.
```

为什么需要这一条？因为**提取指令本身也在上下文里**，
模型可能把「我正在做会话笔记」当成会话内容的一部分写进笔记。

> 🔑 **旁路 agent 必须被明确告知不要记录自己的存在。**
> 这是一个很典型的坑：**任何 meta 层的 prompt 都有泄漏到产出物的风险。**
> 摘要器会摘要自己、翻译器会翻译自己的指令、评分器会给自己的 rubric 打分。

### 9.5 ★ 触发阈值：用「上下文增长量」而不是「API 累计用量」

三个门槛（`sessionMemoryUtils.ts:33-35`，2026-08-29 复核）：

```typescript
minimumMessageTokensToInit: 10000,   // 会话得先长到 10K token 才初始化
minimumTokensBetweenUpdate: 5000,    // 之后每增长 5K token 更新一次
toolCallsBetweenUpdates: 3,          // 或每 3 次工具调用更新一次
```

第一个门槛的意思是**短会话根本不需要摘要**——你问一句它答一句，压缩不会发生。

但真正值得学的是注释里那个区分（`sessionMemoryUtils.ts:24-25`，复核一致）：

```text
Uses the same token counting as autocompact (tokenCountWithEstimation)
to measure actual context growth, not cumulative API usage.
```

**用上下文增长量，不是 API 累计用量。** 差别在哪：

```text
场景：agent 在一轮里反复读同一个大文件（比如反复 grep 同一份 5K token 的源码）

按 API 累计输入算：
  每次调用都把整个上下文发一遍 → 累计输入暴涨（10 次调用 × 3 万 token = 30 万）
  → 判定「增长了 30 万 token，该提取 60 次了」 → 过度提取

按上下文增长量算：
  上下文实际只多了那一份文件的内容 → 增长 5K
  → 判定「增长 5K，该提取一次」 → 正确
```

这是我们自己仓库 `CLAUDE.md` 里那条「区分 stock 与 flow」的同一个陷阱：
**末次快照值和累加值不是一回事，混用会算出错数。**

而且注释强调用的是**和 autocompact 完全相同的计数函数**。为什么这很重要？

```text
如果两个功能用不同的计数方式判断「上下文有多满」：
  压缩觉得「满了，该压了」
  记忆觉得「还早，不用提取」
    → 压缩发生时，会话记忆还是几轮之前的状态
      → 压缩拿到一份过时的摘要 → 白做
```

> 🔑 **两个功能如果依赖同一个判断（「上下文有多满」），
> 就必须共用同一个计数实现。** 各写一份必然错位，而且错位是静默的。

### 9.6 压缩时的保留策略：为什么需要双下限

`sessionMemoryCompact.ts` 是这一层的收益兑现点。配置（复核 `:58-60`）：

```typescript
minTokens: 10_000,
minTextBlockMessages: 5,
maxTokens: 40_000,
```

保留策略是：**从已摘要的位置往后全留；如果留下来的太少，就往前扩展，
补到至少 10K token 且至少 5 条含文本的消息，但总量不超过 40K。**

为什么要**双下限**（token 数 **且** 消息条数）？

```text
只用 token 下限的失败形态：
  有一条巨大的工具结果，本身就占了 10K token
  → 「攒够 10K」这个条件一条消息就满足了
    → 只留了 1 条消息 → 对话的连贯性完全断了
      → 模型看到一个孤立的工具输出，不知道前因后果
```

> 🔑 **这是「双上限/双下限」这个模式的第三次出现**（前两次在 §7.1、§7.2）：
> **行数 + 字节、token + 消息条数——每个限额各防一种形状的异常。**
> 只设一个，就有一整类情况能绕过去，而且绕过去时不报错。

另外 `adjustIndexToPreserveAPIInvariants` 处理的是纯工程约束：
**`tool_use` 和 `tool_result` 必须成对**，切在中间会让 API 直接报错。
这个不知道就会踩。

### 9.7 旁路任务的等待必须有超时和 stale 判定

`waitForSessionMemoryExtraction()`（`sessionMemoryUtils.ts:89-105`，复核一致）：

```typescript
while (extractionStartedAt) {
  const extractionAge = Date.now() - extractionStartedAt
  if (extractionAge > EXTRACTION_STALE_THRESHOLD_MS) return   // 提取已 stale，不等
  if (Date.now() - startTime > EXTRACTION_WAIT_TIMEOUT_MS) return  // 超时，继续
  await sleep(1000)
}
```

压缩前要等在跑的提取完成（否则拿到半份摘要），但有两道逃逸阀：

| 判据 | 防的是什么 |
| --- | --- |
| 等待超时（15s 量级） | 提取慢 → 别把压缩拖死 |
| **提取已启动超过阈值（60s 量级）判 stale，直接不等** | 提取**卡死了** → 那个标志位永远不会被清掉 → 无限等 |

第二条是关键。第一条只防「慢」，第二条防「死」——
**如果没有 stale 判定，一个卡死的提取会让主流程永远等下去。**

> 🔑 **旁路任务的等待必须同时有超时和 stale 判定，否则主流程会被拖死。**
> 这两个判据防的是不同的故障（慢 vs 死），不能互相替代。

### 9.8 L1 与 L2 的对照总表

| 维度 | L1 长期记忆 | L2 会话记忆 |
| --- | --- | --- |
| 解决的问题 | 新会话不认识你 | 压缩会丢信息 |
| 活多久 | 永久 | 会话结束即弃 |
| 存什么 | 只存不可推导的（§3） | **就是要存临时状态**（「试过 A 失败了」） |
| 结构 | 一文件一事实 + frontmatter | **十个固定小节的单文件** |
| 触发 | 每轮结束抽取 | 上下文增长到阈值 |
| 召回 | 选择器挑最多 5 条 | 不需要召回——它只有一份，压缩时整份拿 |
| 漂移问题 | **严重**（§8） | **几乎没有**——它活不到过时 |

最后一行值得注意：**会话记忆基本不存在漂移问题，因为它的生命周期太短。**
这解释了为什么它的设计里完全没有 §8 那五层防御——**不需要**。

> 🔑 **一个组件需要什么防御，取决于它的生命周期。**
> 把 L1 的那套防漂移搬到 L2 上，就是纯粹的复杂度浪费。

### 9.9 本章自检

1. 「我试过方案 A，失败了」——这条该进 L1 还是 L2？为什么另一层不合适？
2. 十个小节的斜体说明为什么**不能**删？它在下一次更新时起什么作用？
3. 用「API 累计输入」当触发阈值，在什么场景下会过度提取？举个具体例子。
4. 压缩保留策略如果只有 token 下限（去掉「至少 5 条消息」），
   什么情况下会坏？坏成什么样？
5. 为什么等待旁路提取需要**两个**逃逸判据？只有超时不够吗？

---
<a id="10"></a>
## §10 共享记忆：为什么它比记忆本身贵

这一章讲 L3。开头先给那个反直觉的实测数字（2026-08-29 复核）：

```text
单机记忆（读写本地文件）：  src/memdir  1736 行
跨机同步：                 src/services/teamMemorySync  2167 行
```

**共享比记忆本身贵。** 这个比例本身就是一条工程结论——
如果有人跟你说「加个团队共享记忆呗，不就是同步一下文件」，
你可以拿这个数字回他。

### 10.1 三条同步语义，每条都是明确的取舍

文件头就把语义声明清楚了（`teamMemorySync/index.ts:14-19`，
2026-08-29 复核，逐字一致）：

```text
Sync semantics:
  - Pull overwrites local files with server content (server wins per-key).
  - Push uploads only keys whose content hash differs from serverChecksums
    (delta upload). Server uses upsert: keys not in the PUT are preserved.
  - File deletions do NOT propagate: deleting a local file won't remove it
    from the server, and the next pull will restore it locally.
```

逐条拆。

#### ① per-key server-wins：冲突粒度是文件，不做三方合并

两个人同时改同一条记忆 → **服务端赢**，本地那次编辑丢掉。

这是最简单的策略。为什么可以接受？

```text
记忆是「可以重新学到」的数据。
丢一次编辑的代价 = 用户可能要再说一次那句话。
而做三方合并的代价 = 一整套 merge 逻辑 + 一整类新故障（合并合错了）。
  → 对这类数据，简单性胜过完整性。
```

⚠️ 注意这个推理**依赖数据的性质**。如果是账务数据、审计日志，
「后写覆盖」是灾难。**取舍成立的前提是「丢了能重新学到」。**

#### ② delta upload by hash：只传变了的

```typescript
/**
 * Compute `sha256:<hex>` over the UTF-8 bytes of the given content.
 * Format matches the server's entryChecksums values so local-vs-server
 * comparison works by direct string equality.
 */
export function hashContent(content: string): string {
  return 'sha256:' + createHash('sha256').update(content, 'utf8').digest('hex')
}
```
（`index.ts:129-136`，复核一致）

注意那句 `so local-vs-server comparison works by direct string equality`：
**哈希格式刻意和服务端一致，于是判断「要不要上传」就是一次字符串比较**，
不需要拉全量内容比对。

> 🔑 **一个很小但很值得学的接口设计**：
> **让两边的校验和格式完全一样，比较就退化成 `===`。**
> 格式不一致的话，每次比较都要先做一次转换，而转换就是一个可能出错的地方。

#### ③ ★ 删除不传播：最容易被当成 bug 的一条

我第一反应也是「这是 bug 吧？我删了本地文件，下次 pull 又给我拉回来？」

想清楚之后这是刻意的：

```text
如果删除会传播：
  一个人误删 → 全团队丢失 → 不可逆
如果不传播：
  代价是「没法通过删本地文件来删记忆」
  但删除可以走别的路径（显式的管理界面）
```

> 🔑 **在共享系统里，破坏性操作不应该走自动同步通道。**
>
> 这条和我们自己仓库 `CLAUDE.md` 里那条铁律是同一个道理：
> 「不删与本次任务无关的文件」——
> **留着一个多余文件的代价是零；删错一个文件的代价是别人几小时的工作凭空消失。**
> 代价不对称时，默认行为必须偏向不可逆的那一侧的反面。

### 10.2 412 冲突：为冲突路径专门设计一个轻量 API

```text
Fetch only per-key checksums + metadata (no entry bodies).
Used for cheap serverChecksums refresh during 412 conflict resolution — avoids
downloading ~300KB of content just to learn which keys changed.
```
（`index.ts:308-311`，复核一致）

ETag 冲突（HTTP 412）时，客户端需要知道**服务端变了哪些 key**。
朴素做法是重新 GET 全量，300KB 下来只为了对比一下哈希。

解法是服务端提供一个 `view=hashes` 的接口，只返回 per-key checksum：**300KB → 几 KB。**

> 🔑 **为冲突解决路径设计一个专用的轻量 API，而不是复用全量 GET。**
> 冲突路径的特点是「频率不低、但只需要极少信息」，
> 而全量 GET 是为「我要完整数据」设计的。用错了不会报错，只是慢和贵。

### 10.3 ★ PUT 分批：排序不为效率，为确定性

```text
Greedy bin-packing over sorted keys — sorting gives deterministic batches
across calls, which matters for ETag stability if the conflict loop retries
after a partial commit.  The byte count is the full serialized body
including JSON overhead, so what we measure is what axios sends.
```
（`index.ts:415-425`，复核一致）

按 key **排序**再贪心装箱。**排序不是为了效率，是为了确定性。**

为什么确定性重要：

```text
一次 push 分成 3 批，第 2 批提交后失败了（部分提交）
  → 重试
    → 如果批次边界和上次不一样（比如遍历顺序变了）
      → 重试的批次内容和上次不同 → ETag 对不上 → 冲突循环打不出去
```

还有一个细节值得注意：

```text
The byte count is the full serialized body including JSON overhead,
so what we measure is what axios sends.
```

**量的是最终发出去的字节，不是内容长度。** 只数内容会漏掉 JSON 转义、
键名、括号的开销，于是「算出来 190KB、实际发出 210KB」——超限。

> 🔑 **两条**：
> ① **凡是有重试的分批，批次边界必须可复现**（排序后装箱）。
> ② **限额要量最终产物，不要量中间量。**

### 10.4 ★★ 一个真实事故：2.5 天 16.7 万次无效请求

这是本章最有教育意义的一段，因为它是事故的直接产物
（`watcher.ts:46-72`，2026-08-29 复核，注释逐字一致）：

```typescript
// Set after a push fails for a reason that can't self-heal on retry.
// Prevents watch events from other sessions' writes to the shared team
// dir driving an infinite retry loop (BQ Mar 14-16: one no_oauth device
// emitted 167K push events over 2.5 days). Cleared on unlink — file deletion
// is a recovery action for the too-many-entries case, and for no_oauth the
// suppression should persist for the session.
let pushSuppressedReason: string | null = null

export function isPermanentFailure(r: TeamMemorySyncPushResult): boolean {
  if (r.errorType === 'no_oauth' || r.errorType === 'no_repo') return true
  if (r.httpStatus !== undefined && r.httpStatus >= 400 && r.httpStatus < 500 &&
      r.httpStatus !== 409 && r.httpStatus !== 429) return true
  return false
}
```

事故链条：

```text
一台没有 OAuth 认证的设备
  → 别的会话写了共享目录
    → fs.watch 触发
      → 尝试 push
        → 失败（no_oauth）
          → 又有别的写入
            → 又 push
              → …… 2.5 天，16.7 万次请求
```

**根因分析值得完整读一遍，因为它推翻了第一直觉**：

```text
❌ 第一直觉：「重试逻辑写错了，加个退避就好」
✅ 实际根因：「重试」这个默认行为对「永久失败」是错的

而且触发源不是自己（是别人的写入）
  → 所以重试永远不会自然停止
  → 加退避也没用：退避只能拉长间隔，不能终止一个永不停歇的外部触发源
```

**分类判据写得很讲究。** 4xx 里排除了 409 和 429：

| 状态 | 判永久吗 | 理由 |
| --- | --- | --- |
| `no_oauth` / `no_repo` | **永久** | 用户不动手就永远失败 |
| 409（并发冲突） | 不 | 服务端状态变了，重新 pull 再 push 可能成功 |
| 429（限流） | 不 | watcher 的 debounce 天然就是退避 |
| 其他 4xx（404 仓库不存在 / 413 条目太多 / 403 无权限） | **永久** | 同样要用户动手 |

**解除条件更值得学**：`Cleared on unlink` —— **只有文件删除事件能解除抑制。**

为什么是「删除」这个信号？

```text
413（条目太多）的恢复动作恰好是「删文件」
  → 所以删除事件是「用户可能已经修好了」的真实信号
no_oauth 的恢复动作是「去登录」，那不产生文件事件
  → 所以它的抑制持续到会话重启才是对的
```

> 🔑 **两条可以直接抄进 checklist**：
> ① **任何由外部事件驱动的重试循环，必须区分暂时失败和永久失败。**
> ② **永久失败的解除条件必须是一个对应真实恢复动作的信号，
> 不能靠时间自动恢复。** 靠时间恢复 = 退化成无限循环，只是周期长一点。

### 10.5 上传前扫密钥：硬拦截优先低误报

```text
Client-side secret scanner for team memory (PSR M22174).
Scans content for credentials before upload so secrets never leave the
user's machine. Uses a curated subset of high-confidence rules from
gitleaks — only rules with distinctive prefixes that have near-zero
false-positive rates are included. Generic keyword-context rules are omitted.
```
（`secretScanner.ts:1-9`，2026-08-29 复核，逐字一致）

两个决策：

**① 扫描在客户端，上传之前。** 不是服务端收到再检查。**密钥根本不离开本机。**

**② 只选高置信度规则。** gitleaks 有几百条规则，这里只挑**有独特前缀**的
（`ghp_`、`AKIA`、`sk-ant-` 这类），**放弃通用的「关键词 + 高熵字符串」规则**——
那类规则召回高但误报也高。

第二条反直觉，值得掰开：

```text
听起来漏报（真密钥没拦住）比误报（正常内容被拦）严重得多，
所以应该用高召回规则？—— 错。

因为这是「硬拦截」场景：
  误报的代价 = 用户的正常记忆传不上去，而且他不知道为什么
             → 整个功能不可用 → 用户关掉它 → 拦截率归零
  漏报的代价 = 一条密钥进了团队共享（严重，但不会让功能不可用）
```

> 🔑 **硬拦截优先低误报；告警场景才优先高召回。**
> 如果要覆盖漏报，正确做法是**在服务端加一层告警式扫描**，
> 而不是把客户端拦截做得过于激进。
>
> 一般化：**一道防线的严格程度上限，取决于它误伤时用户能不能绕过它。**
> 能绕过 → 太严格就会被绕过 → 实际效果归零。

**一个小趣事**（`secretScanner.ts:43-46`，复核一致）：

```typescript
// Anthropic API key prefix, assembled at runtime so the literal byte
// sequence isn't present in the external bundle (excluded-strings check).
const ANT_KEY_PFX = ['sk', 'ant', 'api'].join('-')
```

把 `sk-ant-api` 拆成数组运行时拼接，因为构建流程有「禁止字面量」检查——
如果 bundle 里出现这个字节序列，密钥扫描工具会**误报它自己泄漏了密钥**。

> 🔑 **防泄漏工具自身要避免触发防泄漏工具。**
> 这类「工具检测自己」的自指问题，在扫描器、linter、脱敏器上普遍存在。

### 10.6 子 agent 的记忆隔离：默认隔离，不做黑板

多 agent 场景。子 agent 有独立记忆目录，三种作用域
（`agentMemory.ts:52-65`，复核确认三个 case 存在）：

| 作用域 | 存哪 | 谁能看到 |
| --- | --- | --- |
| `user` | `<记忆根>/agent-memory/<name>/` | 这个用户，跨项目 |
| `project` | `<cwd>/.claude/agent-memory/<name>/` | **入 VCS，团队共享** |
| `local` | 本地目录 | 项目内私有，不入库 |

召回时的隔离逻辑（`attachments.ts:2204-2213`）：

```text
// If an agent is @-mentioned, search only its memory dir (isolation).
// Otherwise search the auto-memory dir.
```

**@提及某个子 agent 时，只搜它的记忆目录。默认隔离，按需切换，不做合并。**

**为什么不做「黑板模式」（共享记忆池）**？污染风险：

```text
agent A 写的是它的「推断」
  → agent B 读到，会当成「事实」
    → 而记忆是持久的
      → Memory Poisoning 比 Prompt Injection 危险的地方就在这里：
        后者影响一次调用，前者影响所有后续会话
```

但「团队起始知识」这个需求确实存在，用的是另一套轻量方案
（`agentMemorySnapshot.ts`）：

```text
项目里可以提交一份记忆快照 .claude/agent-memory-snapshots/<agentType>/
  → 新用户首次使用该 agent 时，拷到本地记忆目录，记录 syncedFrom 时间戳
  → 快照更新了 → 提示用户是否同步
     （checkAgentMemorySnapshot 返回 'none' | 'initialize' | 'prompt-update'）
```

> 🔑 **共享记忆的另一种做法：不做实时同步，做「可版本化的种子 + 显式更新提示」。**
> 比 teamMemorySync 那套简单**一个数量级**（几十行 vs 2167 行），
> 适用于「起始知识」而不是「持续协作」。
>
> 面试时如果被追问团队记忆，**先反问「真的需要实时吗？快照能不能满足？」**
> ——这两个方案复杂度差一个数量级，选错了是纯亏。

### 10.7 本章自检

1. 「删除不传播」看起来像 bug。用「代价不对称」的框架辩护它。
2. PUT 分批为什么要先按 key 排序？不排序会在什么时候出问题？
3. 2.5 天 16.7 万次请求——为什么「加个指数退避」修不了这个问题？
4. 密钥扫描为什么**放弃**高召回规则？「硬拦截优先低误报」的一般化形式是什么？
5. 你要给 agent 加团队共享记忆。按 §10.6，第一个该问的问题是什么？

---
<a id="11"></a>
## §11 安全：一条完整的路径劫持攻击链

这一章讲一件很有教育意义的事：**三个单独看都合理的设计，凑在一起就是任意路径写入。**

面试里如果能完整讲出这条链，是很强的加分项——它展示的不是「我知道要校验路径」
这种常识，而是**「我会检查设计之间的组合效应」**这种能力。

### 11.1 前提：为什么记忆目录需要一个「免检通道」

先看这个洞为什么存在，因为它不是疏忽：

```text
默认记忆目录在 ~/.claude/ 下
  → 而 ~/.claude/ 属于「危险目录列表」（DANGEROUS_DIRECTORIES）
    → 不开洞的话，agent 每写一条记忆都要弹一次权限确认
      → 体验完全不可用（一轮对话可能写 3 条记忆）
```

于是有了这个免检通道：**写入路径如果命中记忆目录，就直接放行不弹窗。**
源码里叫 `write carve-out`，触发条件是 `isAutoMemPath()` 匹配
且 `hasAutoMemPathOverride()` 为 false。

**这是一个合理的设计。** 记住这一点——链条里每一环单独看都合理。

### 11.2 第二环：记忆目录路径可配置

记忆目录不是硬编码的，可以在 `settings.json` 里用 `autoMemoryDirectory` 配。

**这也是一个合理的设计。** 用户想把记忆放别处（换盘、换目录结构）是正常需求。

### 11.3 第三环：如果接受仓库内的配置文件

`settings.json` 有多个来源，其中一个是 **`projectSettings`**——
即**仓库里提交的 `.claude/settings.json`**。

接受它也很合理：项目级配置本来就该跟着仓库走。

### 11.4 ★ 三环凑齐 = 任意路径静默写入

```text
免检通道（记忆目录不弹窗）
  +
可配置边界（记忆目录路径可配）
  +
不可信配置源（接受仓库里的 .claude/settings.json）
  ‖
  ▼
克隆一个恶意仓库
  → 它的 .claude/settings.json 里写着 autoMemoryDirectory: "~/.ssh"
    → 于是 ~/.ssh 变成了「记忆目录」
      → 于是它命中免检通道
        → agent 对 ~/.ssh 拥有静默写入权限，一次弹窗都没有
```

**每一环单独看都是对的。任意两环凑在一起也还安全。三环齐了就是漏洞。**

### 11.5 防御：把不可信的那一环摘掉

源码的处理（`paths.ts:168-186`，2026-08-29 复核，注释逐字一致）：

```typescript
/**
 * SECURITY: projectSettings (.claude/settings.json committed to the repo) is
 * intentionally excluded — a malicious repo could otherwise set
 * autoMemoryDirectory: "~/.ssh" and gain silent write access to sensitive
 * directories via the filesystem.ts write carve-out.
 */
function getAutoMemPathSetting(): string | undefined {
  const dir =
    getSettingsForSource('policySettings')?.autoMemoryDirectory ??
    getSettingsForSource('flagSettings')?.autoMemoryDirectory ??
    getSettingsForSource('localSettings')?.autoMemoryDirectory ??
    getSettingsForSource('userSettings')?.autoMemoryDirectory
  return validateMemoryPath(dir, true)
}
```

**四个来源，`projectSettings` 不在其中。** 而这四个的共同点是：**都不来自仓库。**

| 来源 | 谁设的 | 来自仓库吗 |
| --- | --- | --- |
| `policySettings` | 企业管理员 | ❌ |
| `flagSettings` | 命令行 flag | ❌ |
| `localSettings` | 用户本机、不入库 | ❌ |
| `userSettings` | 用户全局 | ❌ |
| ~~`projectSettings`~~ | **仓库里提交的** | ✅ **← 所以被摘掉** |

> 🔑 **判据：一个配置项如果能扩大权限边界，它的来源就必须限定在「用户或管理员亲手设的」，
> 绝不能接受「跟着数据一起来的」。**
>
> 仓库是数据。你 clone 一个仓库不代表你信任它的作者。

### 11.6 路径本身还要校验（第二道防线）

摘掉不可信来源之后还不够，路径本身也要校验
（`paths.ts:139-148`，2026-08-29 复核）：

```typescript
if (
  !isAbsolute(normalized) ||          // 拒绝相对路径
  normalized.length < 3 ||            // 拒绝 "/" 这类近根路径
  /^[A-Za-z]:$/.test(normalized) ||   // 拒绝 "C:" 盘根
  normalized.startsWith('\\\\') ||    // 拒绝 UNC 路径
  normalized.startsWith('//') ||
  normalized.includes('\0')           // 拒绝 NUL 字节
) {
  return undefined
}
```

还有一条很细的（`paths.ts:117-134`）：**裸 `~`、`~/`、`~/.`、`~/..` 不展开。**
理由写在注释里：

```text
Bare "~", "~/", "~/.", "~/..", etc. are NOT expanded — they would make
isAutoMemPath() match all of $HOME or its parent (same class of danger
as "/" or "C:\").
```

**为什么「近根路径」是特别危险的一类？**

```text
这个路径会成为「读取白名单」和「写入免检」的根。
根目录做白名单根 = 开放整个文件系统。
  → 所以 "/" 和 "~/" 不是「奇怪的输入」，是「权限提升的最短路径」
```

### 11.7 ★ 一个对称性处理：env var 不享受免检通道

这一节展示的是**权限设计的克制**，我认为是这一章最精妙的一处。

有一个环境变量 `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE` 可以完整覆盖记忆目录路径
（给 SDK / Cowork 场景用）。它**优先级最高**（在解析顺序里排第 1，
`paths.ts:210-215`）。

但它**不享受免检通道**（`paths.ts:262-273`，复核逐字一致）：

```text
When CLAUDE_COWORK_MEMORY_PATH_OVERRIDE is set, this matches against the
env-var override directory. Note that a true return here does NOT imply
write permission in that case — the filesystem.ts write carve-out is gated
on !hasAutoMemPathOverride() (it exists to bypass DANGEROUS_DIRECTORIES).

The settings.json autoMemoryDirectory DOES get the write carve-out: it's the
user's explicit choice from a trusted settings source.
```

拆开这个不对称：

| 路径来源 | 优先级 | 享受免检吗 | 为什么 |
| --- | --- | --- | --- |
| 默认 `~/.claude/...` | 最低 | ✅ | **不开洞就没法工作**（它在危险目录下） |
| `settings.json`（可信来源） | 中 | ✅ | 用户从可信来源亲手设的 |
| **env var override** | **最高** | ❌ | **调用方指定的任意目录，没有「不开洞就无法工作」这个前提** |

免检的**理由**是「默认路径恰好落在危险目录下」。
env var 指向的是调用方任意指定的目录——**这个理由不成立，所以不给。**

> 🔑 **免检范围严格限定在「不开洞就无法工作」的那一小块。**
>
> 这是权限设计里最容易失守的地方：一旦开了一个洞，
> 后面每个「类似」的场景都会想沿用它，因为「反正已经有洞了」。
> 正确做法是**回到开洞的那个理由**，看新场景是否满足同一个理由。

### 11.8 Memory Poisoning：为什么记忆的安全等级高于普通输入

最后一层认知。为什么记忆的安全要求比一般输入严格？

| | Prompt Injection | **Memory Poisoning** |
| --- | --- | --- |
| 影响范围 | **这一次调用** | **所有后续会话** |
| 怎么消失 | 会话结束就没了 | **持久化了，不会自己消失** |
| 发现难度 | 相对容易（当次行为异常） | **难——它变成了「背景知识」** |

一条被污染的记忆会在**每一次相关召回时**被注入，
而且带着 §8.3 那个效应：**它看起来是已验证的结论。**

> 🔑 **面试可以直接说的一句**：
> 「记忆是持久的，所以 Memory Poisoning 比 Prompt Injection 危险——
> 后者影响一次调用，前者影响所有后续会话。
> 这也是我们默认让子 agent 记忆隔离、不做共享黑板的原因（§10.6）。」

### 11.9 本章自检

1. 完整讲一遍那条攻击链：三个环分别是什么，为什么每个单独看都合理？
2. 防御为什么选「摘掉 `projectSettings`」而不是「校验路径不能是 `~/.ssh`」？
   （提示：黑名单 vs 白名单）
3. env var override 优先级最高，为什么反而**不**享受免检通道？
   一句话说清那个「理由」。
4. 为什么 `"/"` 和 `"~/"` 这类近根路径要被单独拒绝？
5. Memory Poisoning 和 Prompt Injection 的关键区别是什么？
   它如何影响你对子 agent 记忆共享的设计选择？

---
<a id="12"></a>
## §12 ★ 十个会「静默坏掉」的失效模式

前面十一章讲的是「怎么做对」。这一章讲**做错时它长什么样**——
而记忆系统的失效有一个共同特征：**全都是静默的。**

没有报错，没有崩溃，没有异常日志。功能「看起来在工作」，
只是效果是零，或者是负的。

这一章面试区分度最高。因为「记忆系统怎么设计」大家都能背几句，
「它会怎么坏」只有做过的人说得出。

### 12.0 先看这个共同特征

| 一般软件的失效 | 记忆系统的失效 |
| --- | --- |
| 报错、栈、非零退出码 | **一切正常，只是记忆没起作用** |
| 你会立刻知道 | **可能几个月都不知道** |
| 有测试能覆盖 | 「写进去了」的测试全绿，而它没被召回过 |

所以这一章每条都给**判据**——不是「注意什么」，而是「跑什么能证伪它」。

### 12.1 漏了索引 = 记忆等于不存在

**形态**：写了 topic 文件，忘了在 `MEMORY.md` 加指针（§4.6 的两步保存漏了第二步）。

**为什么是静默的**：文件在磁盘上、内容正确、`ls` 看得到、
读文件的测试全绿。**但它永远不会被人和 `autoDream` 看见**，
于是永远不会被维护、纠偏、更新。

**判据**：

```bash
# 目录里的 .md 数 vs 索引里的指针数
ls ~/.claude/projects/<proj>/memory/*.md | grep -v MEMORY.md | wc -l
grep -c '^- \[' ~/.claude/projects/<proj>/memory/MEMORY.md
# 两个数差很多 → 有孤儿记忆
```

### 12.2 「写进去了」不等于「被召回过」

**形态**：这是上一条的一般化，也是最普遍的一种。你的记忆系统写入正常、
文件都在、索引也有，**但从来没有一条被真正召回并影响过行为。**

**为什么是静默的**：写入侧有测试（写文件），召回侧有测试（给定清单能选对），
**但没有任何测试覆盖「端到端真的发生过」**。

**判据**（这条判据的形式值得记住，它对任何「防线」都适用）：

```text
❌ 错的判据：「召回函数被调用过 != 0」
   为什么错：函数被调用 ≠ 选出了东西 ≠ 注入了 ≠ 影响了行为
             它会被伪装成 PASS

✅ 对的判据：真实会话里，注入过的记忆条数 > 0
             且这些注入的内容确实出现在后续上下文里
```

> 🔑 **这是我们自己仓库 `CLAUDE.md` 里那条验收标准的同一个形态**：
> **新增防线时的验收判据不是「build 过 + 单测过」，而是「真实会话里被触发过」。**
> ——防线自己成了它当初要消灭的死功能，这事已经发生过。

### 12.3 陈旧记忆：指标不动，曲线平稳，质量在腐烂

**形态**：§8 整章讲的那件事。这里补它的**可观测性缺口**。

**为什么是静默的**（这是最阴的一条）：

```text
现在能看到的指标：候选多少条、选中多少条 → 都正常
看不到的：      选中的那几条里，有多少已经过期

  → 记忆质量在持续腐烂时，所有曲线都不动
    → 只能等用户报告「它又用了个老信息」
      → 而用户往往也不知道——他只觉得「这次 agent 有点笨」
```

外部数据（§8.8 引的那份，2026-03）：**Mem0 在基准上 91.6 分，
30 天后有效准确率 49.0%，陈旧率 38%。** 基准分和生产分差 32.4 个百分点，
而**基准跑出来的那个 91.6 什么都没告诉你。**

**判据**：埋一个 `stale_hit_ratio`——召回的记忆里有多少条的断言已经不成立。
这个指标持续上升就是质量在腐烂的唯一早期信号。

### 12.4 只存纠正，不存确认 → 系统性偏保守漂移

**形态**：§3.5 讲过。这里强调它的**静默性**。

**为什么是静默的**：

```text
每一条记忆单独看都是对的（用户确实说过「别这样」）
记忆总数在增长（看起来系统很健康）
  → 但 agent 越来越畏缩：每次都问、每次都最小改动、每次都加防御性代码
    → 没有任何指标会显示「它变保守了」
      → 用户只是慢慢觉得「这工具越来越不好用」，说不出为什么
```

**判据**：数一下记忆里 `feedback` 类型的正负比。
全是「不要 X / 别 Y / 停止 Z」而几乎没有「这样做是对的」→ 已经在漂移了。

### 12.5 注入了但被「中段迷失」吃掉

**形态**：召回对了、注入成功了、token 花了，**但模型没看见。**

**为什么是静默的**：从系统角度看这次召回**完全成功**——
选对了文件、字节进了上下文、埋点记的都是成功。

**判据**：这条不好直接测，但有一个可操作的代理：
**监控每轮注入的累计字节**（§7.1 那个 `MAX_SESSION_BYTES`）。
累计越接近上限，中段迷失的概率越高。这也是为什么那个上限
**同时是质量措施**（§7.3）。

### 12.6 「防线全在、调用全零」

**形态**：所有防漂移的 prompt section 都在源码里、都注入了、
测试全绿——**但真实会话里从没触发过。**

**为什么是静默的**：静态检查（代码在不在）和动态事实（有没有被触发）是两件事，
而大部分人只查前者。

我们自己仓库有一个实测同形态的例子：审计类任务的**防线触发率 0%**——
即「防线全在、调用全 0」。而如果只看代码，会得出「我们有完整的防线」。

**判据（三档，不是两档）**：

```text
① 活代码：  生产路径调用 > 0
② 仅被测试消费：生产 = 0，测试 > 0    ← 这一档是隐形大头，最容易被记成资产
③ 真死代码：生产 = 0，测试 = 0
```

⚠️ **只分「有/没有」两档会系统性高估自己的能力。**

### 12.7 ★ 一个「一旦成立就永远成立」的条件放在热路径上

**形态**：§2.6 那个 `autoDream` 的时间门。

```text
时间门的判据是「距上次整理超过 24 小时」
  → 但没整理就不会更新那个时间戳
    → 所以一旦通过，就每轮都通过
      → 每轮都付一次「扫描会话目录」的成本
```

**为什么是静默的**：**它不报错、不失败，只是悄悄地贵。**
功能完全正常，只是每轮多花一点。而「多花一点 × 每轮」是个大数。

源码的修法是加一个 10 分钟的扫描节流（`SESSION_SCAN_INTERVAL_MS`）。

**通用形式**：

> 🔑 **任何放在每轮都跑的路径上的条件，都要问一句：
> 「它会不会一旦成立就永远成立？」**
> 如果会，它需要一个独立的节流，而不是依赖那个条件自己变 false。

### 12.8 状态外挂 → 和被压缩的上下文脱钩

**形态**：§6.5 讲过。用一个 `Set`/计数器记「这条已经注入过了」。

**为什么是静默的**：

```text
压缩把旧的注入从上下文里清掉了
  → 但外挂的计数器还记着「给过了」
    → 这条记忆永久不再注入
      → 而它「已经给过」这个记录是真的（历史上确实给过）
        → 没有任何检查能发现这个不一致
```

**判据 / 修法**：**状态从消息历史推导，不用外挂存储。**
这样压缩时状态自动重置。

> 🔑 **一般形式：在有上下文压缩的系统里，
> 任何「已经做过 X」的状态都必须能从上下文本身推导出来。**
> 否则状态和上下文会脱钩，而脱钩是不可见的。

### 12.9 ★★ 取数命令本身有 bug（造出一个不存在的结论）

**这条是元陷阱：你用来验证的命令自己错了。**

我在 §5.1 做过一次防御性核验，这里讲清为什么必须做。

**形态一：零命中当成不存在。**

```bash
# 你搜：rg -ci 'embedding|vector' src/memdir  → 近似零命中
# 结论：「他们没用向量检索」
# ⚠️ 但这个「零」可能来自：命令写错、路径写错、正则写错、被 NUL 字节截断
```

**形态二：命中了但不是你以为的东西。**
§5.1 那 5 处 `vector` 命中，全部是 `injection vector` / `attack vector`
——**讲的是攻击面，不是向量检索。** 只看计数会得出反的结论。

**形态三：shell 层面的静默失败。**
我在写这份文档时就实测撞了一次：

```bash
# zsh 下：
grep -rn "MAX_MEMORY_FILES" src/ --include=*.ts
# → zsh: no matches found: --include=*.ts
#   （zsh 不做 word splitting，把 --include=*.ts 当 glob 去展开了）
```

这次是**报错了**所以看得见。但同类问题在别的形态下会**静默返回 0 行**——
比如多个 flag 攒进一个变量再展开，zsh 下不拆词，命令实际没带上那些 flag。

**判据（这条是通用铁律）**：

```text
✅ 零命中必须做反向自证：
   先证明你的命令能抓到「已知存在」的东西。

# 我在 §5.1 做的：
rg -ci 'memory' src/memdir/memoryAge.ts   # → 9，说明命令有效
# 抓不到已知的 → 你那个「零命中」毫无意义
```

三条附带的搜索纪律：

```bash
# ① 一律用 rg -a，别用 grep（NUL 字节会让 grep 静默零输出）
# ② 英语常用词加 -w（vector / memory / cost / log 这类）
# ③ 定位阶段逐个关键词单独搜，不要 or 模式 + -l
#    -l 不告诉你是哪个词命中的，和 -n 结果对不上时会误判为工具故障
```

### 12.10 引用旧文档的「现状」——最贵的一条

**形态**：你读一份三个月前的研究文档，把它的「现状」当成现状。

**这份文档本身就撞了一次**：两份前置研究文档都写「四层记忆栈」，
而 2026-08-29 复核是**五层**（多了 `autoDream`，550 行）。

**为什么是静默的**：

```text
文档写得很好、有 file:line、结论清晰
  → 你完全没有理由怀疑它
    → 而它只是「写完那天是对的」
      → 你据此下的判断，错在一个你根本不会去查的地方
```

注意这条和 §8.3 是**同一个机制**：
**那些 `file:line` 引用让过时的断言听起来更权威，而不是更不权威。**
文档和记忆在这件事上没有区别——**文档就是一种记忆。**

**判据**：

```text
引用任何「现状」类断言（行数、字段名、是否存在、有几层）之前，
回源码/轨迹复跑一次。
成本：几分钟。
不做的代价：整条论证建立在一个不存在的前提上。
```

### 12.11 十条压成五句话

> ① **写进去 ≠ 被召回 ≠ 影响了行为**——判据必须落在最后一环，不是第一环。
> ② **静默是记忆系统失效的常态**，所以每条防线都要有「真实会话里被触发过」的证据。
> ③ **陈旧不体现在任何现有指标上**，必须专门埋 `stale_hit_ratio`。
> ④ **验证工具本身会骗你**——零命中先做反向自证。
> ⑤ **文档就是一种记忆，同样会漂移**，而 `file:line` 让它显得更可信。

### 12.12 本章自检

1. 为什么「召回函数被调用过 != 0」是个会被伪装成 PASS 的判据？
   正确的判据该落在哪一环？
2. 死代码分类为什么必须是三档而不是两档？中间那档为什么是「隐形大头」？
3. 你搜一个仓库得到零命中。在下结论之前必须做的那一步是什么？
4. 「文档漂移」和「记忆漂移」是同一个机制吗？说清为什么。
5. 一个记忆系统跑了三个月，所有指标都正常。你怎么判断它的质量有没有在腐烂？

---
<a id="13"></a>
## §14 动手：从零实现一个 mini 记忆层

看懂不等于会做。这一章给一条**五阶段路线**，每阶段有明确的完成判据。
目标不是造生产级的东西，是**把前十三章的概念亲手过一遍**。

⚠️ 下面的代码是**教学骨架**，刻意省略了错误处理细节。
它们不是从源码抄的，是按本文讲的原理重写的最小形态。

**为什么要亲手做**：这一章里每个「完成判据」都对应一个你**会亲手撞到**的坑。
读到「单次限流不等于总量限流」你会点头；自己跑到第 30 轮发现上下文被记忆吃掉，
才会真的记住。

### 阶段 1：能存能读（半天）

**目标**：文件式记忆的最小形态。**先不做召回**——全部注入。

```ts
// memory.ts
import { readFile, writeFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

export type MemoryType = "user" | "feedback" | "project" | "reference";

export interface MemoryHeader {
  filename: string;
  path: string;
  description: string;
  type?: MemoryType;
  mtimeMs: number;
}

const MAX_MEMORY_FILES = 200;      // ⚠️ §5.3：方案边界的代码化，别省这个常量
const FRONTMATTER_MAX_LINES = 30;  // 只读前 30 行，不读全文

/** 扫描记忆目录，只解析 frontmatter，不读正文 */
export async function scanMemories(dir: string): Promise<MemoryHeader[]> {
  const files = (await readdir(dir)).filter(
    f => f.endsWith(".md") && f !== "MEMORY.md",
  );

  const headers: MemoryHeader[] = [];
  for (const filename of files) {
    const path = join(dir, filename);
    const [content, st] = await Promise.all([readFile(path, "utf8"), stat(path)]);

    // 只看前 N 行 —— 一个巨大的记忆文件不该拖慢扫描
    const head = content.split("\n").slice(0, FRONTMATTER_MAX_LINES).join("\n");
    const fm = /^---\n([\s\S]*?)\n---/.exec(head);
    if (!fm) continue;

    const description = /^description:\s*(.+)$/m.exec(fm[1])?.[1]?.trim();
    if (!description) continue;   // 没有 description 的记忆召回不了，跳过

    const rawType = /^type:\s*(.+)$/m.exec(fm[1])?.[1]?.trim();
    headers.push({
      filename, path, description,
      // ⚠️ 未知/缺失 type 返回 undefined 而不是抛错 —— legacy 文件优雅降级
      type: (["user","feedback","project","reference"] as const)
              .find(t => t === rawType),
      mtimeMs: st.mtimeMs,
    });
  }

  // 新→旧排序后截断：超出上限时，丢掉的是最老的
  return headers
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, MAX_MEMORY_FILES);
}
```

**完成判据**：
- [ ] 手写 3 条记忆文件，`scanMemories` 能全部认出来
- [ ] 故意写一条**没有 `description`** 的，确认它被跳过——
      **然后想清楚：这个「静默跳过」是对的还是错的？**（§12.1 那类问题）
- [ ] 故意写一条 `type: banana`，确认它降级成 `undefined` 而不是崩溃

### 阶段 2：加召回，被迫面对「宁缺毋滥」（一天）

**目标**：把「全部注入」换成「让小模型挑」。

```ts
const SELECT_PROMPT = `You are selecting memories that will be useful as the
agent processes a user's query. You will be given the query and a list of
available memories with filenames and descriptions.

Return filenames for memories that will CLEARLY be useful (up to 5).
- If you are unsure, do NOT include it. Be selective and discerning.
- If none would clearly be useful, return an empty list.`;

export async function selectMemories(
  query: string,
  headers: MemoryHeader[],
  llm: (system: string, user: string) => Promise<string[]>,
): Promise<MemoryHeader[]> {
  if (headers.length === 0) return [];

  // ⚠️ §7.5：廉价启发式放在昂贵调用之前
  // 单词 prompt（"继续"、"ok"）没有足够上下文做相关性判断
  if (!/\s/.test(query.trim())) return [];

  const manifest = headers
    .map(h => `- [${h.type ?? "unknown"}] ${h.filename}: ${h.description}`)
    .join("\n");

  const picked = await llm(SELECT_PROMPT, `Query: ${query}\n\nMemories:\n${manifest}`);
  return headers.filter(h => picked.includes(h.filename)).slice(0, 5);
}
```

**完成判据**：
- [ ] 问一个和所有记忆都无关的问题，确认它**返回 0 条**（不是硬凑 5 条）
- [ ] **必做**：把 prompt 里那句「不确定就不要选」删掉，重跑同一个无关问题。
      观察它开始硬凑——**这就是 top-k 默认行为在注入场景的害处（§6.3），
      亲手看一次比读十遍都管用**
- [ ] 造 300 条记忆，确认 `MAX_MEMORY_FILES` 截断生效，且**没有报错**——
      然后想清楚：一个有 300 条记忆的用户，他丢掉的是哪 100 条？

### 阶段 3：注入，撞上预算与缓存（一到两天）

**目标**：把召回结果塞进上下文，并**亲手撞到三层预算和字节冻结**。

```ts
const MAX_MEMORY_BYTES = 4096;
const MAX_MEMORY_LINES = 200;
const MAX_SESSION_BYTES = 60 * 1024;

/** ⚠️ §8.4：相对时间表述，不给 ISO 时间戳 —— 模型日期算术差 */
function memoryAge(mtimeMs: number): string {
  const d = Math.max(0, Math.floor((Date.now() - mtimeMs) / 86_400_000));
  if (d === 0) return "today";
  if (d === 1) return "yesterday";
  return `${d} days ago`;
}

/** ⚠️ §8.4 防御 3：≤1 天不加警告 —— 每条都标警告等于没有警告 */
function freshnessText(mtimeMs: number): string {
  const d = Math.max(0, Math.floor((Date.now() - mtimeMs) / 86_400_000));
  if (d <= 1) return "";
  return `This memory is ${d} days old. Memories are point-in-time observations, ` +
         `not live state — claims about code behavior or file:line citations may be ` +
         `outdated. Verify against current code before asserting as fact.`;
}

export interface InjectedMemory {
  path: string;
  header: string;   // ★ §7.4：创建时算好存下来，之后永不重算
  body: string;
}

export async function buildInjection(
  selected: MemoryHeader[],
  session: { injectedBytes: number; surfacedPaths: Set<string> },
): Promise<InjectedMemory[]> {
  // ★ §7.1 第三层：会话累计预算，用完彻底停止
  if (session.injectedBytes >= MAX_SESSION_BYTES) return [];

  const out: InjectedMemory[] = [];
  for (const h of selected) {
    if (session.surfacedPaths.has(h.path)) continue;   // §6.5 去重

    let body = await readFile(h.path, "utf8");
    // ⚠️ §7.2 双上限：行数和字节各防一种形状的滥用
    const lines = body.split("\n");
    if (lines.length > MAX_MEMORY_LINES) body = lines.slice(0, MAX_MEMORY_LINES).join("\n");
    if (Buffer.byteLength(body) > MAX_MEMORY_BYTES) {
      const buf = Buffer.from(body).subarray(0, MAX_MEMORY_BYTES);
      const s = buf.toString("utf8");
      body = s.slice(0, s.lastIndexOf("\n") > 0 ? s.lastIndexOf("\n") : s.length);
      body += `\n\n> This memory file was truncated. Read the full file at: ${h.path}`;
    }

    const stale = freshnessText(h.mtimeMs);
    out.push({
      path: h.path,
      // ★ 关键：header 现在就固定下来，跨午夜也不重算（§7.4）
      header: stale ? `${stale}\n\nMemory: ${h.path}:`
                    : `Memory (saved ${memoryAge(h.mtimeMs)}): ${h.path}:`,
      body,
    });

    session.injectedBytes += Buffer.byteLength(body);
    session.surfacedPaths.add(h.path);
  }
  return out;
}
```

**完成判据**（这三条是本章最有价值的部分）：
- [ ] 造一条 50KB 的记忆，确认**两个上限都生效**，且截断切在换行处不切半行
- [ ] **必做（撞缓存坑）**：把 `header` 改成每轮渲染时重算，
      然后把系统时钟往后调一天。观察那条已在上下文里的消息**内容变了**——
      这就是 §7.4 说的「从这条消息往后整个 prompt cache 全部失效」。
      **它不报错，你只能靠对比字节发现它。**
- [ ] **必做（撞累计坑）**：把 `MAX_SESSION_BYTES` 那个检查注释掉，
      跑一个 30 轮以上的会话，统计累计注入字节。
      **单看每轮都合规，累起来是多少？**（§7.1）

### 阶段 4：写入，撞上「两步保存」与去重（一天）

**目标**：让 agent 自己写记忆，并亲手体验漏掉索引的后果。

```ts
export function buildWriteGate(): string {
  return `## What to save
Only save what is NOT derivable from the current project state:
- user: who the user is (role, expertise, preferences)
- feedback: guidance on how to approach work — corrections AND confirmations
- project: goals, constraints, incidents not derivable from code or git
- reference: pointers to external systems

## What NOT to save
- Code patterns, conventions, architecture, file paths, project structure
- Git history — \`git log\` / \`git blame\` are authoritative
- Debugging solutions or fix recipes — the fix is in the code
- Ephemeral task details

These exclusions apply EVEN when the user explicitly asks you to save.
If asked to save a PR list, ask what was *surprising* about it instead.

## How to save (two steps — skipping step 2 means the memory is invisible)
Step 1 — write the memory to its own file with frontmatter (name/description/type).
         feedback and project MUST include **Why:** and **How to apply:** lines.
         Convert relative dates to absolute ("Thursday" → "2026-03-05").
Step 2 — add a one-line pointer in MEMORY.md, under ~150 chars.

## Existing memories — update rather than duplicate
{{MANIFEST}}`;
}
```

**完成判据**：
- [ ] 对话里说「以后别自动加 try/catch」，确认它存成 `feedback` 且**带 Why**
- [ ] 说「记住这周的 PR 列表」，确认它**反问「什么是意外的」而不是照存**（§3.4）
- [ ] 说「这个项目用 bun 不用 npm」，确认它**不存**（`bun.lockb` 在仓库里，§3.3）
- [ ] **必做**：手动删掉某条记忆在 `MEMORY.md` 里的指针，但保留文件。
      跑几轮，确认**没有任何报错**，然后想清楚这条记忆此后会发生什么（§12.1）

### 阶段 5：埋点与验证（一天）

**目标**：证明它**真的在工作**——而不是「看起来在工作」。

```ts
export interface RecallShape {
  candidateCount: number;   // 候选多少条
  selectedCount: number;    // 选中多少条
  injectedBytes: number;    // 实际注入字节
  sessionCumulative: number;// ★ 会话累计
  // ★★ 这个字段是本文 §8.9 / §12.3 说的最大缺口，从第一天就埋上
  staleSelectedCount: number; // 选中的里面有多少条 mtime 超过 N 天
}
```

**完成判据**（每条都对应 §12 的一个失效模式）：
- [ ] `selectedCount` 的分布：**恒为 0** 说明召回从没起作用；
      **恒为 5** 说明「宁缺毋滥」那条 prompt 没生效
- [ ] `staleSelectedCount / selectedCount` 就是你的 `stale_hit_ratio`。
      **跑一个月，看它是不是在涨**
- [ ] 目录里的 `.md` 数 vs `MEMORY.md` 里的指针数——**对不上就是有孤儿记忆**
- [ ] **★ 最重要的一条**：用 §12.2 的判据检查——
      不是「召回函数被调用过 != 0」，而是**真实会话里注入过的记忆条数 > 0，
      且这些内容确实出现在后续上下文里**
- [ ] `feedback` 类型的正负比：**全是「不要 X」→ 已经在偏保守漂移**（§12.4）

### 阶段总览：你会亲手撞到的坑

| 阶段 | 你会撞到 | 对应章节 |
| --- | --- | --- |
| 1 | 没有 description 的记忆被静默跳过 | §12.1 |
| 2 | 删掉「宁缺毋滥」后模型开始硬凑 5 条 | §6.3 |
| 3 | **改时钟看 header 变化 → 缓存全废** | §7.4 |
| 3 | **单轮合规、会话累计爆掉** | §7.1 |
| 4 | 漏了索引，没报错，记忆等于不存在 | §12.1 / §4.6 |
| 5 | 所有指标正常，但 `stale_hit_ratio` 在涨 | §12.3 |

**做完这五个阶段，你手里就有真东西可讲了**——
不是「我读过 Claude Code 源码」，而是「我实现过，撞过缓存那个坑」。

---
<a id="appendix"></a>
## 附录

### A. 术语速查表

按「一条记忆从生到死」的顺序，不按字母序。**§0 有详细版，这里是压缩版。**

| 词 | 一句话 | 章节 |
| --- | --- | --- |
| stateless | LLM 每次调用都是全新的，这是记忆存在的唯一理由 | §0.1 |
| working memory | 会话内的东西，本质就是那串消息历史 | §0.2 |
| long-term memory | 跨会话存活，落盘成文件 | §0.2 |
| frontmatter | markdown 开头 `---` 里那块 YAML | §0.4 |
| description | frontmatter 里的一行摘要，**召回时唯一的判断依据** | §5.2 |
| entrypoint / index | `MEMORY.md`，每次会话全量加载，200 行 + 25KB 双上限 | §6.6 |
| write gate | 「这条该不该存」那道判断，**大多数系统缺这一道** | §3 |
| extraction | 从对话里提炼出值得记的东西 | §4 |
| recall | 这一轮该取哪几条 | §6 |
| injection | 把取出来的塞进上下文 | §7 |
| staleness / drift | 记忆当初对，世界变了它没变 | §8 |
| tombstone | 显式记录「这条已被推翻」，而非直接覆盖 | §8.9 |
| consolidation | 定期回头合并、去重、删矛盾的 | §2.6 |
| prompt cache | 相同**前缀**第二次发不用重算，约 1/10 价 | §0.6 |
| 字节冻结 | 注入的内容一旦写入就不能重算 | §7.4 |
| lost in the middle | 长上下文中段信息有 15–30% 降幅 | §7.3 |
| compaction | 上下文快满时把前面对话摘要掉 | §9 |
| Memory Poisoning | 污染记忆，比 Prompt Injection 危险（影响所有后续会话） | §11.8 |
| pass / server-wins | 冲突时服务端赢，不做三方合并 | §10.1 |
| stale_hit_ratio | 召回的记忆里有多少已过期。**本文认为最重要的缺失指标** | §8.9 |

### B. 可复跑命令

⚠️ **两条前提**，不遵守会得出反的结论：

```bash
# ① 一律用 rg -a，不用 grep(NUL 字节会让 grep 静默零输出)
# ② zsh 下别写 --include=*.ts —— zsh 不做 word splitting，
#    会当 glob 展开然后报 "no matches found"。用 rg -g '*.ts' 代替。
#    （我写这份文档时实测撞了一次，见 §12.9 形态三）
```

#### B.1 先确认数据存在

```bash
MEM=~/.claude/projects/<项目路径编码>/memory

ls -la "$MEM"                      # 记忆目录概览
wc -l "$MEM"/MEMORY.md             # 索引行数（上限 200）
du -sh "$MEM"/MEMORY.md            # 索引字节（上限 25KB）
ls "$MEM"/*.md | wc -l             # 记忆条数（上限 200）
```

#### B.2 ★ 孤儿记忆检查（§12.1）

> ⚠️ **这一节的第一版命令是错的，我把它连同修法一起留在这里** ——
> 因为它撞的正是 §12.9 那个元陷阱：**取数命令自己有 bug，造出一个不存在的结论。**
>
> 错的版本用 `grep -c '^- \['` 数索引指针，在一个 178 条记忆的真实目录上得到
> 「文件 178 / 指针 68」，看起来有 110 条孤儿记忆。
> **但权威判据（逐个文件反查索引）给出的孤儿数是 0。**
> 根因：那个正则假设了唯一一种行格式，而真实索引里有 `^- [Title](f.md)`、
> 分组标题下的其它缩进/前缀形式等多种写法，`^- \[` 只命中其中一部分。
>
> **教训和 §12.9 完全一致：两个命令算同一件事而结果不一致时，
> 先怀疑命令，别急着下结论。** 下面是交叉验证过的版本。

```bash
# ★ 判据一（权威）：逐个文件反查索引 —— 直接给出孤儿明细
for f in "$MEM"/*.md; do
  b=$(basename "$f")
  [ "$b" = "MEMORY.md" ] && continue
  grep -q "$b" "$MEM/MEMORY.md" || echo "孤儿: $b"
done

# ★ 判据二（计数）：抽出索引里被引用的 .md 文件名去重后计数
#   注意是「抽链接目标再去重」，不是「数行首形态」—— 后者对格式敏感
files=$(find "$MEM" -maxdepth 1 -name '*.md' ! -name 'MEMORY.md' | wc -l | tr -d ' ')
refs=$(grep -o '](\([^)]*\.md\))' "$MEM/MEMORY.md" \
       | sed 's/](//;s/)//' | xargs -n1 basename 2>/dev/null | sort -u | wc -l | tr -d ' ')
echo "文件: $files   被索引引用的唯一文件名: $refs"

# ✅ 两个判据必须一致：判据二的差值 (files - refs) 应等于判据一输出的行数
#    不一致 → 是你的命令有问题，不是数据有问题（这正是本节开头那个教训）
# 实测样例（2026-08-29，一个 178 条记忆的目录）：
#   判据一 → 0 行输出；判据二 → 文件 178 / 引用 178。一致，无孤儿。
```

⚠️ 另一个 zsh 陷阱，实测撞到过：目录为空时 `ls "$MEM"/*.md` 会报
`no matches found` 并中断（zsh 的 nomatch 行为），
所以计数一律用 `find`，别用 `ls` + glob。

#### B.3 陈旧度分布（§8 / §12.3）

```bash
# 每条记忆多少天没动过 —— 手工版的 stale_hit_ratio
for f in "$MEM"/*.md; do
  d=$(( ( $(date +%s) - $(stat -f %m "$f") ) / 86400 ))
  echo "$d 天  $(basename "$f")"
done | sort -rn
# ⚠️ 读法：天数大不等于失效。判据是「它的前提还在吗」，不是「它多老」。
#         但天数大 + 内容含 file:line → 优先核对（§8.3）
```

```bash
# 找出所有含 file:line 型断言的记忆 —— 这些是最易漂移的
rg -al ':[0-9]+' "$MEM" -g '*.md' | wc -l
```

**实测样例（2026-08-29，同一个 178 条记忆的目录）**，两个数放一起看才有意义：

```text
最老的记忆：106 天
含 file:line 断言的记忆：138 / 178 = 77.5%
```

⚠️ **读法（这是本附录最该学的一次读数）**：单看任何一个数都不构成结论。
- 「最老 106 天」单独看无所谓——方法论类记忆活一年也没问题（§8.10）。
- 「77.5% 含 file:line」单独看也无所谓——刚写的精确记忆是资产。
- **但两者的交集就是 §8.3 那个高危组合**：既老、又精确到行号，
  于是「那个引用让过时的断言听起来更权威」。

所以正确的下一步不是「按天数清理」，而是**按交集排序去核对**：

```bash
# 老 + 含 file:line 的交集，按天数降序 —— 这才是该优先核对的清单
for f in $(rg -al ':[0-9]+' "$MEM" -g '*.md'); do
  d=$(( ( $(date +%s) - $(stat -f %m "$f") ) / 86400 ))
  echo "$d 天  $(basename "$f")"
done | sort -rn | head -20
```

#### B.4 ★ feedback 正负比（§12.4）

```bash
# 全是「不要/别/停止」而几乎没有确认 → 已经在偏保守漂移
neg=$(rg -c '不要|别|禁止|不得|stop|don.t|avoid' "$MEM" -g '*.md' | wc -l | tr -d ' ')
pos=$(rg -c '这样是对的|保持|继续这么|correct approach|keep doing' "$MEM" -g '*.md' | wc -l | tr -d ' ')
echo "含否定的文件: $neg   含确认的文件: $pos"
```

**实测样例（2026-08-29，同一个目录）——这条跑出来的结果值得单独说**：

```text
含否定的文件: 120   含确认的文件: 5     → 24 : 1
```

**这正是 §3.5 和 §12.4 预测的那个形态，在一个真实目录上的样子。**
源码 prompt 里那句 `Corrections are easy to notice; confirmations are
quieter — watch for them` 不是抽象的担忧——**默认行为确实会长成 24:1。**

⚠️ 但**别把这个数当成判决**，它是筛子不是结论，有两个明确的口径问题：
1. **分母是「文件数」不是「记忆条数」**——一个文件里同时含否定和确认时两边都计一次。
2. **关键词匹配会误伤**：「别」会命中「别的」「区别」，
   而中文表达确认的方式（「对」「可以」「就这样」）比这几个词宽得多，
   **所以 `pos` 被系统性低估。**

也就是说 24:1 这个具体比值不可信，**但量级方向可信**（差一个数量级以上）。
要拿它做结论就得人工抽样核一遍——这本身就是 §12.9 那条纪律：
**说不出取数口径的数字只是自我感觉。**

#### B.5 源码侧核对（本文所有行数结论的复跑口径）

```bash
CC=~/claude-code

# 各层规模 —— 本文 §2.1 那张表的取数源
for d in src/memdir src/services/extractMemories src/services/SessionMemory \
         src/services/teamMemorySync src/services/autoDream; do
  n=$(find "$CC/$d" -name '*.ts' -not -name '*.test.ts' | xargs wc -l | tail -1 | awk '{print $1}')
  echo "$d: $n"
done

# 关键常量 —— 本文所有数字上限的取数源
rg -n 'MAX_MEMORY_FILES|MAX_ENTRYPOINT_LINES|MAX_ENTRYPOINT_BYTES|MAX_MEMORY_BYTES|MAX_SESSION_BYTES' \
   "$CC/src" -g '*.ts' -g '!*.test.ts'

# 检索侧规模（验证「检索只占 2.3%」）
wc -l "$CC/src/memdir/findRelevantMemories.ts"
```

#### B.6 ★★ 零命中的反向自证（§12.9，最重要的一条）

```bash
# 例：验证「记忆栈里没有向量检索」这个结论
rg -ci 'embedding|vector|cosine|faiss' "$CC/src/memdir"
# 假设近似零命中 —— 但先别下结论！

# ① 证明命令本身有效（能抓到已知存在的词）
rg -ci 'memory' "$CC/src/memdir/memoryAge.ts"
# → 有输出 = 命令没问题；零输出 = 你的「零命中」毫无意义

# ② 逐个看那些命中到底是什么
rg -in 'embedding|vector|cosine|faiss' "$CC/src/memdir/teamMemPaths.ts"
# → 实测全是 "injection vector" / "attack vector"，讲的是攻击面
#   只看计数会得出反的结论
```

### C. 三十秒自检清单

做记忆系统 / 面试前扫一遍。**每条都能指回一章。**

**该记什么（§3）**
- [ ] 有没有**拒绝器**，而不只是提取器？
- [ ] 「代码/git/文档里能查到的不记」这条落实了吗？
- [ ] 用户明确要求存快照时，会重定向到「存洞察」吗？
- [ ] `feedback` 同时记纠正**和**确认吗？
- [ ] `**Why:**` 是必填还是建议？
- [ ] 相对日期转绝对日期了吗？

**写入（§4）**
- [ ] 主路径 + 兜底路径都有吗？互斥怎么做的？
- [ ] 失败时游标推进了吗（应该**不**推进）？
- [ ] 后台抽取复用 prompt cache 了吗？
- [ ] 有轮次硬上限防验证兔子洞吗？
- [ ] 写入前预注入了已有记忆清单（去重）吗？
- [ ] 两步保存的第二步（写索引）有检查吗？

**召回与注入（§6 / §7）**
- [ ] 允许返回 0 条吗？还是硬凑 top-k？
- [ ] 去重状态是从消息历史推导，还是外挂存储？
- [ ] 预算是**三层**吗（单文件 / 单轮 / **会话累计**）？
- [ ] 单文件是**双上限**（行数 + 字节）吗？
- [ ] 注入的 header **字节冻结**了吗？
- [ ] 召回是预取 + 轮询消费，还是阻塞主路径？
- [ ] 超限时告知用户了，还是静默截断？

**漂移（§8）**
- [ ] 有新鲜度标注吗？用相对时间还是 ISO 时间戳？
- [ ] 新鲜记忆**不**加警告吗（告警稀疏）？
- [ ] 有「推荐前先验证」这类**独立 section**（不是埋在 bullet 里）吗？
- [ ] 这些 prompt 跑过 eval 吗？
- [ ] **有 `stale_hit_ratio` 吗？**（本文认为最重要的缺口）
- [ ] 发现漂移时的 SOP 是「在源头修」还是「叠补丁」？

**共享与安全（§10 / §11）**
- [ ] 真的需要实时同步吗？快照种子够不够？
- [ ] 破坏性操作（删除）走自动同步通道吗（不该走）？
- [ ] 重试区分暂时失败和永久失败吗？
- [ ] 永久失败的解除条件对应真实恢复动作，还是靠超时？
- [ ] 能扩大权限边界的配置项，来源限定在「不来自仓库」了吗？
- [ ] 免检通道的范围限定在「不开洞就无法工作」的那一小块了吗？

**验证（§12）**
- [ ] 验收判据是「build 过 + 单测过」，还是「**真实会话里被触发过**」？
- [ ] 死代码分类是三档（活 / 仅测试消费 / 真死）还是两档？
- [ ] 零命中做过反向自证吗？
- [ ] 引用的「现状」类数字，回源复跑过吗？

## 最后：这份文档想让你记住的五件事

**一、记忆系统的难点不在「找回来」。**
检索只占 2.3% 的代码量（141 / 6248 行）。剩下 97.7% 在处理
**该记什么、记多久有效、注入多少、谁能看见**。
如果你的设计从「用什么向量库」开始，你从第一步就在优化一个不重要的问题。

**二、没有失效机制的记忆是净负债，不是收益打折。**
append-only 0.138 vs 完全不用记忆 0.837——**差 6 倍**。
原因是有害记忆**消灭的不是「无知」，是「求证的动作」**。
所以那些「用前先验证」的 prompt 不是锦上添花的保险，
**它们是让记忆系统由负转正的必要条件**。

**三、精确度会被误当成可信度。**
带 `file:line` 的旧记忆比模糊的旧记忆**更**危险，
因为「那个引用让过时的断言听起来更权威，而不是更不权威」。
这条对代码注释、文档、wiki 同样成立——**文档就是一种记忆**。
这份文档自己就撞了一次（前置文档写「四层」，实际五层）。

**四、记忆系统的所有失效都是静默的。**
没有报错、没有崩溃、指标全绿，而功能等于零或负。
所以它比一般系统更依赖**专门设计的度量**，而不是等报错。
验收判据必须落在最后一环——不是「写进去了」，
而是「**真实会话里被召回过并影响了行为**」。

**五、成本约束会反过来决定架构。**
「抽取器必须复用 prompt cache」这一条成本要求，
穿透了架构层（不能改工具列表）和安全层（最小权限只能在执行层做）。
看任何架构决策时，先问一句：**这个选择是不是被缓存经济学逼出来的？**

---

> **一句话版本**（如果你只能记一句）：
>
> **记忆系统最重要的组件不是提取器，是拒绝器；
> 最危险的不是记不住，是记住了一件不再为真的事，还带着行号。**
