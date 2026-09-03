---
title: 'Agent Runtime（05）· 任务规划：agent 的「计划」到底是什么东西'
description: '计划不是一段文本，是一个有状态机、有审批闸门、有恢复路径的运行时对象。这篇讲 plan mode 怎么把「先想再做」变成机制，而不是一句提示词。'
date: "2026-09-03"
series: Agent Runtime 从零到一
tags: [Agent 架构, 规划, 从零到一]
outline: [2, 3]
---

# 任务规划从零到一：agent 的「计划」到底是什么东西

::: info 这是一份快照
本文的数字、常量、行数取自 **2026-08-31** 对 sid-code 源码的一次实读。
代码在动，这些数字会腐坏——引用其中任何一个之前，请按文中给出的命令在你自己的仓库里复跑一次。
:::

> **这份文档写给谁**
>
> 你听过 CoT / ReAct / Plan-and-Execute，也许还能背出 ToT 在 Game of 24 上 74% vs CoT 4%。
> 但你没做过「让一个 agent 先出方案、等人批准、再照着方案干完一件跨十几个文件的活」这件事。
> 你想搞懂：计划生成出来之后**存在哪里**、凭什么「只规划的 agent」不会顺手改文件、
> 计划怎么活过一次上下文压缩、面试官追问「你怎么设计 agent 的规划能力」时该答什么。
>
> **它和源材料的关系**：源材料是一份 882 行的**源码实读笔记**
> （`ai-agent-inter/04-源码实战/Planning-任务规划/01-Study-Source-Planning-任务规划.md`），
> 密度极高、满篇 `文件:行号`，默认你已经知道 harness / attachment / compaction 是什么。
> 这一份是**教学版**：从「一次 LLM 调用产出一段文字」讲起，每个概念先给「为什么需要它」，
> 再给「它长什么样」，最后才给「谁做得好、代价是什么」。
>
> **它不是摘要。** 摘要会把结论抽出来变成一句正确但没用的话
> （比如「计划应该持久化」）。本文的写法相反：**每个结论都从「为什么会有人搞错」讲起**，
> 因为面试里能拉开差距的从来不是结论本身，是你能不能说清它的反面为什么诱人。

---

## 关于文中数字的免责声明（先读这 6 行）

全文的事实来源分两级，逐处标注，**请不要把两级当成同等可靠**：

| 标记 | 含义 | 可信度 |
| --- | --- | --- |
| 🔬 | **源码实读**，带文件与行号，可回溯复现 | 高。命令与路径在附录 A，可自己复跑 |
| 📄 | **二手引用**（论文 / 博客 / 别人的实读笔记转述） | 中。版本会变、论文结论会被推翻 |

两个具体口径：

- **sid-code 侧的 🔬 是我 2026-08-31 亲手复跑的**（本仓 `packages/core/src/plan/`、
  `tool/todo-write.ts`、`query/todo-reminder*.ts`、`task/structured-task-store.ts`）。
- **claude-code 侧的 🔬 来自源材料 2026-08-13 的实读，本文未复跑**。
  凡引用一律标「（claude-code, 2026-08-13 实读）」。产品每周在变，
  **引用到面试里请带上这个时间**，别说成「claude-code 现在是这么做的」。

最后一条纪律，它本身就是本文 §12 的一个失效模式：**引用旧文档的「现状」是最贵的错误**。
本文写作过程中就抓到两处漂移（§13.2 那 173 个孤儿计划文件、§11.3 那个零调用的保真度模块），
两处都成了很好的教学素材——所以我把它们留在正文里，而不是悄悄改掉。

---

## 目录

| 章 | 讲什么 | 读完你能回答 |
| --- | --- | --- |
| [§0](#s0) | **名词地图**：「规划」这个词指五件不同的事 | 别人说「planning」时，你知道他在说哪一件 |
| [§1](#s1) | 第一个认知陷阱：「计划 = 一次 LLM 输出」 | 为什么生产系统里过半复杂度在「输出之后」 |
| [§2](#s2) | 为什么需要规划：不规划会怎样 | 用真实数据说出规划要解决的三个具体故障 |
| [§3](#s3) | CoT / ToT / GoT 那套八股的真实位置 | 为什么 coding agent 几乎不用 ToT，什么时候才用 |
| [§4](#s4) | ★ 计划的生命周期：从「一段文字」到「可寻址对象」 | **本文架构核心之一** |
| [§5](#s5) | Plan Mode 是一个状态机（三态 + 一个正交标志） | 能画出状态图，并说出每条边为什么存在 |
| [§6](#s6) | 越权防线：「只规划不执行」是权限工程 | 为什么剥离 Write 工具毫无意义 |
| [§7](#s7) | ★ 复述（recitation）：TodoWrite 的真实目的 | **最反直觉的一章** |
| [§8](#s8) | 三个不同的洞：注意力衰减 / 压缩擦除 / 状态过期 | 为什么三个机制不是同一件事做三遍 |
| [§9](#s9) | 从扁平清单到任务图：多 agent 共享状态的真实成本 | TOCTOU、悬空边、ABA 问题 |
| [§10](#s10) | 一条实测红线：只加前向压力，绝不加拦截 | 105.4 秒的教训 |
| [§11](#s11) | 怎么证明规划真的生效了 | 机制指标 vs 目标指标；一个零调用的保真度模块 |
| [§12](#s12) | ★ 会「绿着坏掉」的失效模式 | **本文最值钱的一章** |
| [§13](#s13) | 两个实现的横向对照（claude-code vs sid-code） | 各自在赌什么，谁抄谁 |
| [§15](#s15) | 动手：从零实现一个 mini plan mode | 五阶段路线图，含会撞到的坑 |
| [附](#appendix) | 可复跑命令 / 术语表 / 自检清单 | 查漏 |

**如果只有 20 分钟**：读 §4、§7、§12。这三章是这个领域的骨架，其余都是它们的展开。

**如果只有 5 分钟**：读 §1 和 §12.0 那张表。

---
<a id="s0"></a>

## §0 名词地图：「规划」这个词指五件不同的事

这一节是**分类，不是背诵**。放在最前面是因为：如果你混用这五个意思，
后面所有推理都会串味——这不是学术洁癖，是面试里最常见的答偏原因。

### 0.1 五件事

有人对你说「agent 的 planning」，他可能在说下面任何一件：

| # | 形态 | 一句话 | 典型代表 | 核心难点 |
| --- | --- | --- | --- | --- |
| **A** | **推理拓扑** | 让模型在**一次或几次调用内部**多想几步 | CoT / ToT / GoT / Self-Consistency | 搜索成本、评估函数怎么设计 |
| **B** | **任务分解** | 把「做一个电商网站」拆成 N 个可执行步骤 | Plan-and-Execute / ReWOO | 粒度怎么定、错了怎么改 |
| **C** | **规划态**（人在回路） | 一个**受限模式**：只准看不准动，出方案给人批 | Claude Code 的 Plan Mode、sid-code 的 `plan` 权限模式 | 越权防护、审批对象的一致性 |
| **D** | **进度清单** | 一份「还剩什么没做」的活账 | TodoWrite / task list | 让模型**真的去更新它** |
| **E** | **任务图** | 带依赖关系、可被多个 agent 认领的持久化任务集 | TaskCreate/Update（DAG）、swarm 派活 | 并发写、死锁、ID 复用 |

**这五件事的性质不同，不是程度不同。** 举个最直接的对比：

- A 的难点是**算力怎么花**（ToT 的 token 复杂度是 `O(b^d)`，b 是分支数 d 是深度）；
- C 的难点是**权限怎么锁**（模型有 Bash 就等于有写权限，跟推理质量毫无关系）；
- E 的难点是**并发怎么控**（两个 agent 同时认领一个任务，这是分布式系统问题）。

A 和 C 的问题域几乎没有交集。**所以「我们用了 ToT 做规划」和「我们做了 Plan Mode」
不是同一个层次的答案，前者答的是模型怎么想，后者答的是系统怎么管。**

### 0.2 本文的重心，以及为什么

本文重点讲 **C / D / E**，A 和 B 放在 §3 一次讲完并给出它们的真实位置。

原因很直接：**八股文已经把 A 和 B 讲烂了，而生产系统里超过一半的复杂度在 C / D / E。**
一个可以量化的对照（claude-code, 2026-08-13 实读 🔬）：

```
「怎么生成计划」的代码：
  Plan Mode 的两套工作流 prompt   ≈ 170 行 prompt 模板

「计划生成之后怎么管」的代码：
  utils/plans.ts（计划的磁盘持久化）        397 行，全是文件 IO
  ExitPlanModeTool（提交审批）              493 行
  utils/tasks.ts（任务图 + 文件锁）         862 行
  attachments.ts 里的周期性重注入逻辑        约 100 行
```

**397 + 493 + 862 行的工程量，八股文里一个字都没有。**

sid-code 侧的同一组对照（本仓，2026-08-31 实读 🔬）：

```bash
# 复跑命令见附录 A-1
packages/core/src/plan/state.ts          445 行   # 状态机 + 计划文件路径 + 保真度追踪
packages/core/src/plan/prompt.ts         185 行   # 进入引导 + 分档提醒 + 批准消息
packages/core/src/plan/recovery.ts       201 行   # 执行阶段失败 → 提醒更新计划
packages/core/src/plan/slug.ts           140 行   # 计划文件命名（项目名 / 时间 / 主题 sanitize）
packages/core/src/tool/todo-write.ts     658 行   # 进度清单工具（其中一半是 prompt 与前向压力）
packages/core/src/query/todo-reminder.ts          # 回注 + end_turn 完成度校验
packages/core/src/query/todo-reminder-scan.ts     # 「该不该回注」的无状态判定
packages/core/src/task/structured-task-store.ts 376 行  # 任务图（blocks/blockedBy + 成环检测）
```

同一个结论：**没有一行是在「让模型想得更好」，全部在「让计划这个东西可管」。**

### 0.3 会反复出现的词（查询表，不用背）

按「一个计划从生到死」的顺序排，不按字母序——这些词之间有位置关系。

| 词 | 中文 | 是什么 |
| --- | --- | --- |
| **harness** | 脚手架 / 外壳 | 包着模型的那层代码：主循环、工具、上下文管理、权限。**模型不是 agent，harness + 模型才是** |
| **turn** | 轮次 | 一次「模型说话」或「用户说话」。⚠️ 有三个不同口径，见 §7.4，选错会让机制整体走偏 |
| **tool_use / tool_result** | 工具调用 / 工具返回 | 模型输出的一种块；harness 执行后把结果作为 `tool_result` 送回。**tool_result 在协议上属于 user 消息**，这是 §7.4 那个坑的根源 |
| **system-reminder** | 系统提醒 | harness 悄悄塞进对话的一段文字，**用户看不到**。是 C / D 两类机制的主要投递方式 |
| **attachment** | 附件 | 同上的另一种叫法（claude-code 的术语），指「附加到某条消息上的注入内容」 |
| **compaction / compact** | 压缩 | 上下文塞满时把前面的对话总结成一段摘要。**它是本文一半失效模式的成因** |
| **plan file** | 计划文件 | 磁盘上一个 markdown 文件。§4 整章在讲它为什么必须是文件 |
| **plan mode** | 计划模式 | 一个只读受限模式（形态 C）。sid-code 里它同时是**权限模式**和**独立状态机**，见 §5.3 |
| **recitation** | 复述 | 定期把关键目标重新贴到上下文**末尾**，对抗注意力衰减。§7 的主题 |
| **governance decay** | 治理衰减 | 压缩把常驻约束（如「不许改文件」）当过期文本丢掉。§8.2 的主题 📄 |
| **fidelity** | 保真度 | 「实际干的」与「计划写的」对不对得上。§11.3 的主题 |
| **TOCTOU** | 检查与使用之间 | Time-Of-Check-To-Time-Of-Use：检查通过了，但等你真去用的时候状态已经变了。§9.3 |

### 0.4 本章自检

- [ ] 有人说「我们用 LLM 做 planning」，你能问出三个澄清问题，定位到 A–E 哪一种吗？
- [ ] 你能说出 A 和 C 的难点为什么没有交集吗？
- [ ] 「模型不是 agent」这句话，你能用一句话解释它对本文的意义吗？
      （提示：本文讨论的几乎所有东西都在 harness 里，换个模型这些代码一行不改）

---
<a id="s1"></a>

## §1 第一个认知陷阱：「计划就是一次 LLM 输出」

这一章讲一个**被推翻的认知**，而不是直接给正确答案。
原因见 §14 的一条自检：**任何一条设计原则，你都应该能说出它在什么条件下会反转；
说不出来，说明你只背了理由、没想过代价。** 而看清「为什么会有人搞错」，
是你在面试里能跟别人拉开差距的地方。

### 1.1 大多数人的默认心智模型

问一个学过 Plan-and-Execute 的人「计划存在哪里」，最常见的答案是：

```
用户请求 → Planner（一次 LLM 调用）→ 输出一段步骤清单
                                         ↓
                                  存在 messages 数组里
                                         ↓
                              Executor 逐条读它、执行
```

这个模型有三个隐含假设，**每一个都在真实系统里不成立**：

| 隐含假设 | 为什么不成立 |
| --- | --- |
| 计划一次生成、之后不改 | 规划是**逐步细化**的过程。作为消息，每次改动要全文重发；作为文件，可以 `edit` 局部替换 |
| 计划只有模型读 | 用户要**在审批框里改它**；下游工具要读它；恢复逻辑要读它。它有至少四个读者 |
| 上下文一直在 | 长会话必然触发**压缩**。压缩器优化的是「任务连续性」，它会把计划当旧文本丢掉 |

### 1.2 三个把源材料作者「按住」的意外

源材料作者读 claude-code 源码时，写下了三个让他立刻停下来的发现
（claude-code, 2026-08-13 实读 🔬）。这三条我原样保留，因为**它们就是最好的教学材料**：

**意外一：`utils/plans.ts` 397 行全是文件 IO。**

> 我预期计划是 LLM 的一段输出、塞在 message 里。结果这个文件里全是
> `getPlanFilePath`、`getPlan`、`copyPlanForResume`、`copyPlanForFork`、
> `persistFileSnapshotIfRemote`。计划是**磁盘上的一个 markdown 文件**，
> 有 slug 命名、有 fork 语义、有跨会话恢复、有远程环境快照兜底。

「有 fork 语义」这四个字值得停一下：**fork 是版本控制的词汇**。
一份「计划」为什么需要 fork？§4.4 会讲，答案很漂亮。

**意外二：`ExitPlanModeTool` 的入参里没有 `plan` 字段。**

一个「提交计划请求批准」的工具，**不接收计划内容作为参数**。它的 prompt 明写着：

> This tool does NOT take the plan content as a parameter —
> it will read the plan from the file you wrote.

第一次看到这个的正常反应是「这不是绕远路吗」。§4.3 会用三个猜测逐个验证它，
其中两个猜测是错的——**看清错的那两个，比直接知道对的那个有用**。

**意外三：`utils/tasks.ts` 里出现了 `proper-lockfile`、`TOCTOU`、`.highwatermark`。**

一个 agent 的 todo 列表，用上了分布式系统的并发控制词汇。

> 这说明任务状态不是内存对象，而是多进程共享的持久化资源。

### 1.3 修正后的心智模型

```
                    ┌───────────────────────────────────────┐
                    │  计划文件（磁盘上一个 markdown）        │
                    │  ~/.sid-code/plans/<项目>/<时间-主题>.md │
                    └───────────────────────────────────────┘
                       ↑         ↑          ↑           ↑
              ①模型 write/edit  ②用户在审批框里改  ③下游工具 read  ④恢复逻辑重建
                       │         │          │           │
    ┌──────────────────┴─────────┴──────────┴───────────┴──────────────┐
    │  生命周期：创建 → 增量修订 → 人类编辑回写 → 批准 → 跨压缩存活      │
    │            → 跨会话恢复 → 分支(fork) → 过期判定                   │
    └───────────────────────────────────────────────────────────────────┘
```

**这是一套完整的资源生命周期管理，跟「一次输出」差了一个数量级。**

一句可以直接用在面试里的话：

> 八股文里那张 CoT / ToT / GoT 对比表，讨论的全是「怎么生成计划」；
> 生产系统里超过一半的复杂度在「计划生成之后怎么管」。

### 1.4 一个立刻可做的自我检验

如果你觉得「存文件而不是存消息」是个显而易见的选择，问自己这四个问题：

1. 文件名叫什么？用 `sessionId` 吗？（§4.2 说不用，理由不是技术性的）
2. 同一分钟内用户连按两次进入规划态，两份计划会不会互相覆盖？（§4.2 有答案）
3. 会话被 fork 成两条时间线，两条各写自己的计划，还是共享一份？（§4.4）
4. 部署到一个**容器随时被回收**的云端环境，文件还在吗？不在怎么办？（§4.5 有三级降级链）

**四个问题里答不上两个以上，就说明「存文件」这个决定你还没真正做过。**
这四问也是面试里追问规划设计时最常出现的第二层问题。

### 1.5 本章自检

- [ ] 「计划 = 一次 LLM 输出」这个模型的三个隐含假设，你能复述吗？
- [ ] `ExitPlanMode` 不接收计划参数，你能猜出至少一个理由吗？（先自己猜，§4.3 再对答案）
- [ ] 一份计划有几个读者？各自在什么时刻读？

---
<a id="s2"></a>

## §2 为什么需要规划：不规划会怎样

上一章说「计划是个可管理的资产」，但还没说**为什么值得费这个劲**。
这一章用三个有实测数字的具体故障回答它——**不是「规划让 agent 更聪明」这种空话**。

### 2.1 先看不规划的 agent 长什么样

最朴素的 agent 是一个 while 循环：

```
while (模型还想调工具) {
  模型看整段对话 → 输出：一段话 + 也许几个 tool_use
  harness 执行工具 → 把 tool_result 塞回对话
}
```

这个循环**没有任何「目标」的概念**。它每一轮的输入是「整段对话」，
输出是「下一步做什么」。目标只以「用户最初那句话」的形式存在于对话开头。

于是三个故障必然出现，而且**都不报错**：

### 2.2 故障一：长任务遗漏——「做了 7 件，用户要的是 10 件」

这是最常见也最贵的一个。sid-code 2026-06-09 的全量轨迹调查
（1481 个会话，经 `events.jsonl` 统计 🔬，源自项目记忆 `long-task-omission-harness-rootcause`）：

```
62 个长任务中，只有 7 个用过 todo 清单     → 覆盖率 11.3%
```

而在**没有清单**的那 55 个里，遗漏是系统性的，不是偶发。机制很直白：

> 用户在第 1 轮说了 10 件事。到第 30 轮时，那句话在上下文的最前面，
> 中间夹了 29 轮工具输出。模型的注意力已经被稀释——它不是「忘了」，
> 是那句话在它当前的权重分布里已经很轻。

这就是**注意力衰减**（attention dilution）。它有一个广为人知的名字：
**Lost in the Middle** 📄——长上下文里，开头和结尾的信息被利用得远好于中间。

一个反直觉的推论，先记下来，§7 会展开：

> **信息「在上下文里」和「在上下文的末尾」是两件完全不同的事。**

### 2.3 故障二：方向错了才发现——「你改的不是我要的那个模块」

第二个故障发生在**动手之后**。模型读了几个文件，觉得懂了，直接开始改，
改完 12 个文件后用户说「等一下，你为什么动了认证模块」。

这个故障的成本不对称：

| | 成本 |
| --- | --- |
| 规划阶段发现方向错 | 重写一份 markdown，几千 token |
| 执行到一半发现方向错 | 12 个文件的改动要回滚 + 重做，还可能已经 commit |

**规划的第一价值不是「想得更好」，是把「发现错误」这件事挪到成本最低的时刻。**
这也是形态 C（规划态）必须有**人类审批**这一步的根本理由——
人是那个唯一知道「我到底想要什么」的信息源。

一个直接推论，很多人没想过：

> **人在回路（HITL）不只是安全机制，它同时是一个免费的、高质量的标注管道。**

用户拒绝了什么、改了什么、改成了什么——这些是无需额外标注成本的偏好信号。
§11.2 有一组用它算出来的、我认为整个领域最有说服力的数据。

### 2.4 故障三：空转——「同一个工具反复调，返回值一模一样」

第三个故障最隐蔽：agent 没停、没报错、token 在烧，但**没有任何进展**。

sid-code 实测的一个具体形态（🔬 同上记忆）：

```
exit_plan_mode 的失败率 46.9%（134/286 次调用失败）
其中 127 次的失败原因是「当前不在计划模式中」
53 个会话出现「成功退出后又反复调用」的模式
```

机制是这样的：模型成功退出了规划态，但**上下文被压缩后它「忘了」自己已经退出**，
于是又调一次 `exit_plan_mode`。工具报错「你不在计划模式」，模型不知道该怎么办，
再调一次——**空转**。

这里有一条极其重要的设计教训，我单独拉出来，因为它可迁移到所有工具设计上：

> **错误信息本身就是给模型的 prompt。**
> 工具报错时，别只说「你错了」，要说「你错了，正确的做法是 X」——
> 因为模型下一步的行为完全取决于它读到什么。

sid-code 的修复正是这么做的（🔬 `packages/core/src/tool/exit-plan-mode.ts:79-101`）。
它做了两件事：**把报错改成幂等成功**，并且**在返回值里给出正确的下一步**：

```ts
// 根因 3 修复（P0-1）：非 planning 状态下的 exit_plan_mode 改为**幂等成功**，
// 从源头切断"报错 → 重试 → 再报错"的空转循环（实测 46.9% 失败率，127 次"不在计划模式"）。
if (this.planManager.isAwaitingApproval()) {
  return { output: "计划已提交，正在等待用户审批，无需重复调用 exit_plan_mode。请耐心等待审批结果。" };
}
return {
  output:
    "计划已进入执行阶段（已审批通过或当前不在计划模式）。请直接开始执行计划的第一步任务，" +
    "不要再调用 exit_plan_mode——它只用于提交新计划等待审批。" +
    "如计划包含多个步骤，建议先用 todo_write 将计划逐条拆解为任务清单，再依次执行。",
};
```

注意这段代码里三个刻意的选择，每一个都有理由：

1. **`isError` 不设为 true**。因为「重复调用」不是一个需要模型去修的错误，
   而是一个需要模型**换个动作**的状态。标成 error 会让模型进入「排查模式」。
2. **两种非 planning 状态给不同文案**。等审批 vs 已批准，正确的下一步不同：
   前者是「等着」，后者是「开干」。给同一句话会让一半情况被误导。
3. **末尾主动引导去用 `todo_write`**。这是把形态 C 交接给形态 D
   ——一个跨机制的接力点。

**对照 claude-code 的处理（🔬 2026-08-13 实读）**，它选了另一条路：
在 `validateInput` 里硬拦，返回 `{ result: false }`，但错误信息里同样给了正确指引
（`If your plan was already approved, continue with implementation.`），
并且**打点记录这件事的发生频率**（`tengu_exit_plan_mode_called_outside_plan`）。

两条路的差异值得一句评论：**claude-code 拦得更硬但会看到弹窗风险**
（注释明写 `Reject before checkPermissions to avoid showing the approval dialog.`
——不能让用户看到一个莫名其妙的二次批准弹窗），
**sid-code 选了幂等成功，代价是模型收不到「你做错了」的信号**。
在弱模型上后者更稳（模型不会陷入排查），在强模型上前者信息量更大。
⚠️ 这是一个**真实的权衡，不是谁更对**。

### 2.5 三个故障，三种机制，一张对应表

这张表是本文后半部分的骨架，值得记住：

| 故障 | 机制 | 形态 | 本文哪一章 |
| --- | --- | --- | --- |
| **长任务遗漏**（注意力衰减） | 进度清单 + **周期性复述** | D | §7 |
| **方向错了才发现** | 规划态 + **人类审批** | C | §4 §5 §6 |
| **空转 / 反复调用** | 幂等 + **错误信息即 prompt** + 循环检测 | — | §2.4 §12.5 |
| （多 agent）**抢同一个任务** | 任务图 + 文件锁 | E | §9 |

### 2.6 一个必须先说清的反面：什么时候不该规划

如果你只读到这里就去做，会犯一个很常见的错：**给所有任务都加规划**。

代价是实测的（📄 claude-code 的实验数据，见 §11.2）：

```
计划长度 <2K 字符  → 用户拒绝率 20%
计划长度 >20K 字符 → 用户拒绝率 50%
（N = 26.3M 样本）
```

**计划越长，用户越倾向于拒绝。** 而「给简单任务也强行规划」必然产出长计划
——因为没什么真东西可写，只能堆散文。

sid-code 的 system prompt 因此写了一句措辞很小心的引导
（🔬 `packages/core/src/config/system-prompt.ts:1136`）：

> **方案不确定先规划**：当实现路径存在真实架构歧义（多种合理方案、需求不明确、
> 高风险重构）时，用 `enter_plan_mode` 先对齐方案再编码。日常任务拿不准时倾向于
> **直接开始工作**，遇到具体选择点再问用户——**「先动手再问」比「每个任务都 plan」更高效**。

⚠️ 这里有一个我认为非常值得知道的对照（📄 claude-code, 2026-08-13 实读）：
**claude-code 对外部用户和内部员工用了两套哲学相反的 prompt**：

| 受众 | 措辞 | 哲学 |
| --- | --- | --- |
| external（外部用户） | `Prefer using EnterPlanMode for implementation tasks unless they're simple` + `err on the side of planning` | **默认多规划** |
| ant（内部员工） | `genuine ambiguity about the right approach` / `when the implementation approach is genuinely unclear` | **默认少规划** |

同一个产品，同一个功能，对两类用户给相反的默认值。合理的解读是：
**内部员工能自己判断什么时候需要规划，外部用户不能，所以对后者宁可多规划**。
这是一个「默认值该向哪边倾斜」的经典判断——**它取决于用户的判断力，不取决于什么是「对」的**。

### 2.7 本章自检

- [ ] 三个故障你能各举一个自己遇到过的例子吗？
- [ ] 「错误信息本身就是给模型的 prompt」——你能说出它跟传统软件错误处理的区别吗？
      （提示：传统软件的错误信息读者是人，人会去查文档；模型只有这一句话）
- [ ] `exit_plan_mode` 改成幂等成功，代价是什么？什么条件下这个选择会反转？
- [ ] 「计划越长拒绝率越高」，你觉得因果方向是什么？（§11.2 会讨论这个陷阱）

---
<a id="s3"></a>

## §3 CoT / ToT / GoT 那套八股的真实位置

这一章一次讲完形态 A（推理拓扑）和 B（任务分解），并回答一个更重要的问题：
**为什么 coding agent 几乎不用 ToT。**

如果你的面试准备只覆盖这一章的内容，那你准备的是**2023 年的 agent**。
但完全不知道它们也不行——面试官会直接问，而且它们确实有适用场景。

### 3.1 四个拓扑，一分钟讲完

| 名字 | 结构 | 一句话 | 代价 |
| --- | --- | --- | --- |
| **IO** | 一个点 | 直接问直接答 | 最便宜，复杂任务错得也最快 |
| **CoT** | 一条链 | 「让我一步步想」——把中间推理写出来 | ~2-5x token |
| **CoT-SC** | N 条平行链 | 跑 N 次投票取多数 | N 倍成本 |
| **ToT** | 一棵树 | 每步生成 b 个候选、评估、回溯 | `O(b^d)`，可以是 100x |
| **GoT** | 一张图 | 允许节点合并、复用（不只是树） | 最贵，实现最复杂 |

📄 最常被引用的数据：**ToT 在 Game of 24 上 74% vs CoT 4%**。
这个数字非常有说服力，也非常容易误导——下面说为什么。

### 3.2 为什么 coding agent 几乎不用 ToT：三个前提全塌

ToT 要跑起来，需要三件东西。在 Game of 24 上三件都白送，在 coding 上三件全没有：

| ToT 需要的前提 | Game of 24 | 写代码 / 改代码 |
| --- | --- | --- |
| ① **状态可评估**（给一个中间状态打分） | 有精确启发式（剩余数字能否凑出 24） | ❌ 「这个重构方案改了一半」值多少分？**没有函数能算** |
| ② **状态可回溯**（退回上一步重来） | 纯数学，回溯零成本 | ❌ 已经写进磁盘的文件、已经跑过的 migration，**回溯有真实副作用** |
| ③ **分支数可控** | 每步候选有限 | ❌ 「下一步怎么改」的候选空间是开放的 |

**第 ② 条是决定性的。** ToT 的核心机制是「探索错了就退回来」，
而 coding agent 的每一步都在真实世界留下痕迹。你没法「回溯」一个已经执行的 `rm`。

所以 coding agent 用的是另一套东西，本质上是**把回溯换成了别的机制**：

| ToT 的机制 | coding agent 的替代 | 在本文哪一章 |
| --- | --- | --- |
| 分支探索 | **并行只读子 agent**（explore 类型，只读所以安全） | §6.4 |
| 状态评估 | **人类审批**（因为没有评估函数，人就是评估函数） | §4.3 §5 |
| 回溯 | **计划文件的增量修订**（标 `[FAILED]` + 写新策略，不是回退） | §5.5 |

**一句可以直接说出口的话**：

> ToT 的三个前提在 coding agent 上全部不成立，最关键的是「回溯」——
> 已经写进磁盘的改动没法零成本撤销。所以 coding agent 的做法是把
> 「探索」限制在只读子 agent 里（探索错了没有副作用），
> 把「评估」交给人类审批（因为没有可计算的评估函数），
> 把「回溯」换成计划文件的增量修订。

### 3.3 什么时候 ToT 真的有用

不要把上一节读成「ToT 没用」。它在满足三前提的场景里非常有效：

- **有精确验证器的任务**：数学题、SQL 生成（可以跑起来看对不对）、
  单元测试生成（可以跑测试）、约束求解
- **纯推理、无副作用的任务**：逻辑谜题、规划路径（在模拟器里）
- **可以廉价重来的任务**：短文本生成的多方案比选

判据是一句话：**你能不能写出一个函数给中间状态打分，且退回上一步不花钱。**
两个都是「能」，ToT 值得考虑；任一个是「不能」，别用。

### 3.4 形态 B：自顶向下 vs 渐进式

这是另一道高频八股题。两种分解策略：

| | 自顶向下（Plan-and-Execute） | 渐进式（ReAct） |
| --- | --- | --- |
| 做法 | 先出完整计划，再逐条执行 | 每步看情况决定下一步 |
| 优点 | 有全局视野；可以先给人审批 | 灵活；能利用新发现的信息 |
| 缺点 | 初始计划可能整体错，且错得贵 | 短视；容易走偏、容易遗漏 |
| token | 规划集中在前期 | 分散，且总量常更高（反复试探） |

八股文的标准答案是「混合策略：粗粒度规划 + 细粒度执行」。这个答案不算错，
但它给人一种「这道题有正确答案」的错觉。

**源码告诉我们的事实完全不同**（📄 claude-code, 2026-08-13 实读 🔬）：

claude-code 里这两种工作流是**同一个产品里两个并行的 A/B 实验分支**：

```ts
if (isPlanModeInterviewPhaseEnabled()) {
  return getPlanModeInterviewInstructions(attachment)   // 访谈式（渐进）
}
// 否则走 5 阶段工作流（自顶向下）
```

**5 阶段工作流**（自顶向下）：

```
Phase 1 Initial Understanding — 并行启动最多 3 个 Explore 子 agent 探索代码
Phase 2 Design               — 启动最多 N 个 Plan 子 agent 设计方案（N 按订阅档位定）
Phase 3 Review               — 主 agent 读关键文件、用 AskUserQuestion 澄清
Phase 4 Final Plan           — 写最终计划到文件
Phase 5 Call ExitPlanMode    — 请求批准
```

**访谈式工作流**（渐进）：

```
The Loop（循环直到计划完成）：
1. Explore              — 读代码
2. Update the plan file — 每有发现立即写入，不要等到最后
3. Ask the user         — 遇到代码答不了的歧义就问，然后回到 1
```

而 `isPlanModeInterviewPhaseEnabled()` 的实现是：**内部员工始终开启，外部用户走灰度**。

也就是说：**造出这个产品的团队自己都还没确定哪种更好。**

这个认知对面试极其有价值。对比两种答法：

> ❌ 「自顶向下适合需求明确的场景，渐进式适合需求模糊的场景，我们用混合策略。」
> （任何看过 LangGraph 文档的人都能说，零信号量）
>
> ✅ 「这两种没有定论——Anthropic 自己在同一个产品里并行跑两套工作流做 A/B，
> 内部员工用访谈式、外部用户走灰度。我们的选择是 X，因为我们的场景是 Y。」

### 3.5 访谈式工作流里三句比八股更实用的话

📄 claude-code 的访谈式 prompt 里有三句话，我认为比整篇八股都实用：

| 原文 | 中文 | 为什么值钱 |
| --- | --- | --- |
| `Don't explore exhaustively before engaging the user.` | 别探索完再问，先问 | 反直觉。直觉是「先弄明白再问才不显得笨」，但探索的成本远高于问一句 |
| `Never ask what you could find out by reading the code` | 别问代码里能查到的 | 上一条的必要配平。缺了它，模型会变成「什么都问」 |
| `Scale depth to the task — a vague feature request needs many rounds; a focused bug fix may need one or none` | 按任务调整深度：模糊需求需要多轮，明确的 bug 修复可能一轮都不需要 | 这是「自适应分解深度」的**可操作落地话术** |

第三条特别值得学。「自适应粒度」这个概念在八股里是抽象的，
这句 prompt 给了模型一个**可判断的锚**：看需求的模糊程度，而不是看任务的大小。

sid-code 的对应实现走的是另一条路——它不在 prompt 里描述深度，
而是**在进入引导里直接给一条捷径**（🔬 `packages/core/src/plan/prompt.ts:29-31`）：

> **如果用户已经提供了足够具体的设计文档/指令**（含文件路径、改动内容），
> 不必从零重写计划——可以直接基于用户文档做轻量确认与补充，尽快进入执行；
> **不要为了"走流程"而重复用户已写清楚的内容**。

这一句在解决同一个问题的另一半：不是「该探索多深」，而是「该不该探索」。
用户已经把方案写好了，规划阶段的正确行为是**确认后放行**，不是重写一遍。

### 3.6 形态 A/B 的真实位置：一张定位图

```
      ┌─────────────────────────────────────────────────────┐
      │  形态 A（推理拓扑）：CoT / ToT / GoT                  │
      │  位置：在「一次模型调用内部」                          │
      │  coding agent 里：基本只用 CoT（thinking / reasoning） │
      │  ToT/GoT：三前提不成立，几乎不用                       │
      └─────────────────────────────────────────────────────┘
                              │
                              │ 模型输出一份计划
                              ▼
      ┌─────────────────────────────────────────────────────┐
      │  形态 B（任务分解）：自顶向下 vs 渐进式                 │
      │  位置：跨越多轮，由 prompt 里的工作流描述驱动           │
      │  真实状态：**未结的 A/B 实验**，不是有正确答案的选择    │
      └─────────────────────────────────────────────────────┘
                              │
                              │ 计划要被存下来、被审批、被执行
                              ▼
      ┌═════════════════════════════════════════════════════┐
      ║  形态 C/D/E：规划态 / 进度清单 / 任务图                ║
      ║  位置：**全部在 harness 里，与模型无关**               ║
      ║  这里是本文剩下 12 章的内容，也是生产复杂度的所在       ║
      └═════════════════════════════════════════════════════┘
```

**最后一格那句「与模型无关」很重要**：换个模型，C/D/E 的代码一行都不用改。
这就是为什么这部分能力属于 harness 的护城河，而 A/B 属于模型的能力。

### 3.7 本章自检

- [ ] 你能说出 ToT 的三个前提，并解释为什么第 ② 条在 coding 上是决定性的吗？
- [ ] coding agent 用什么替代了 ToT 的「分支探索」和「状态评估」？
- [ ] 「自顶向下 vs 渐进式」这道题，你现在会怎么答？（要能提到 A/B 实验这个事实）
- [ ] 「别探索完再问」和「别问代码里能查到的」这两句话为什么必须成对出现？

---
<a id="s4"></a>

## §4 ★ 计划的生命周期：从「一段文字」到「可寻址对象」

这是本文两个架构核心之一。一句话总纲：

> **判据是「这个产物会不会被第二个主体读或改？会不会活过一次压缩？」
> 两个都是「是」，它就必须有一个地址。**

「地址」在实践中就是**磁盘上的一个路径**。这一章讲这个路径的八个生命周期阶段，
每一节回答一个具体问题。

### 4.0 先看全景

```
①创建         write 工具写一个 md 文件
②增量修订     edit 工具局部替换（不是全文重发）
③人类编辑     用户在审批框里改 → 写回同一路径 → 重新快照
④批准         状态跃迁；模型被告知「计划被改过」
⑤跨压缩存活   压缩时主动把「路径 + 全文」注入回上下文
⑥跨会话恢复   三级降级链：文件 → 快照 → 从消息历史里挖
⑦分支(fork)   会话分叉 → 生成新路径后复制内容（不共享）
⑧过期判定     重入规划态 → 强制先判断「旧计划还相关吗」
```

**八个阶段里有五个（③⑤⑥⑦⑧）在八股文里完全不存在。**
它们全都是「把状态放到上下文之外」这个决定的**衍生代价**。

### 4.1 ① 创建：它为什么必须是文件，而不是消息

先说三个具体理由，按重要性排：

**理由一：可增量编辑。**

规划是一个**逐步细化**的过程。模型探索完 A 模块写三段，再探索 B 模块补两段。

| 承载方式 | 每次修订的成本 |
| --- | --- |
| 消息（tool_use 参数） | **全文重新输出**。5000 字符的计划改一行 = 重发 5000 字符 |
| 文件 | `edit` 局部替换。改一行 = 输出那一行的前后文 |

**全量重写和增量编辑的成本差异随计划长度线性放大。** 这是最朴素的理由，
但不是最重要的。

**理由二：多方可寻址。** 见 4.3，那一节完整展开。

**理由三：能活过压缩。** 见 §8.2。压缩器会把常驻内容当旧文本丢掉，
而文件不在上下文里，压缩碰不到它。

### 4.2 ② 命名：为什么不用 sessionId

这是个小细节，但它暴露了一个重要事实。两个实现的选择：

**claude-code**（🔬 2026-08-13 实读）：**随机可读词 slug**

```ts
export function getPlanSlug(sessionId?: SessionId): string {
  for (let i = 0; i < MAX_SLUG_RETRIES; i++) {
    slug = generateWordSlug()                   // 如 brisk-otter
    const filePath = join(plansDir, `${slug}.md`)
    if (!existsSync(filePath)) break            // 冲突就重摇
  }
}
export function getPlanFilePath(agentId?: AgentId): string {
  const planSlug = getPlanSlug(getSessionId())
  if (!agentId) return join(getPlansDirectory(), `${planSlug}.md`)
  return join(getPlansDirectory(), `${planSlug}-agent-${agentId}.md`)   // 子 agent 独立文件
}
```

**sid-code**（🔬 本仓 `packages/core/src/plan/state.ts:359-371`）：**项目 / 时间-主题**

```ts
private generatePlanFilePath(topic?: string): string {
  const project = resolvePlanProject(getCwd());     // git 根目录的 basename
  const time = formatPlanTime();                    // YYYYMMDD-HHmm
  const safeTopic = sanitizePlanTopic(topic);       // 中文主题，限长 40
  const base = safeTopic ? `${time}-${safeTopic}` : time;
  // 去重：同项目同分钟内多次进入 plan（或兜底时间戳）避免覆盖
  let candidate = sidPaths.plan(project, base);
  let n = 2;
  while (existsSync(candidate)) {
    candidate = sidPaths.plan(project, `${base}-${n++}`);
  }
  return candidate;
}
```

实际长这样（🔬 本机 `~/.sid-code/plans/`）：

```
sid-code/20260803-1505-修复韧性层方案未落地缺口.md
sid-code/20260715-1747-文件定期清理机制.md
```

**两个方案都刻意避开了 sessionId，理由是同一个，而且不是技术性的**：

> **这些文件是给人看的。** 用户要在目录里翻自己的历史计划，
> `brisk-otter.md` 或 `20260803-1505-修复韧性层方案未落地缺口.md`
> 都比 `plan-a3f8c9d2-4e1b-....md` 好认。

sid-code 走得更远一步：**它把「项目」和「主题」编进了路径**，
于是「翻历史计划」变成了「按项目 + 时间 + 主题三个维度找」。
代价是要额外做两件事：`resolvePlanProject`（跑一次 `git rev-parse --show-toplevel`）
和 `sanitizePlanTopic`（清掉路径分隔符、Windows 敌对字符、防隐藏目录的首尾点）。

⚠️ **`while (existsSync(candidate))` 那个循环别当成小聪明**：
时间戳精度是**分钟**，同一分钟内两次进入规划态是完全可能的
（用户拒绝了、你重新进入）。没有这个循环，第二份计划会**静默覆盖**第一份。
这就是 §1.4 那四个自检问题里的第 2 问。

### 4.3 ③ 人类编辑：为什么 ExitPlanMode 不接收计划参数

回到 §1.2 那个意外。这一节完整展开，因为**推理过程比结论有用**。

源材料作者提了三个猜测，逐个验证（🔬 claude-code, 2026-08-13）：

**猜测一：省 token。** ❌ 不成立。

理由：计划最终还是会通过 `mapToolResultToToolResultBlockParam` **原文贴回 tool_result**。
省不了。（顺带得到一个有用的数字：实测计划长度 `p50 4,906 字符 / p90 11,617`。）

**猜测二：让计划可增量编辑。** ✅ 成立，但不是关键。

这就是 4.1 的理由一。prompt 里明写：
`A plan file already exists at ... You can read it and make incremental edits using the Edit tool.`

**猜测三：让人类能在提交前后编辑同一份对象。** ✅✅ **这才是关键。**

看这段代码和它的注释（🔬 `ExitPlanModeV2Tool.ts:255-261`）：

```ts
// Sync disk so VerifyPlanExecution / Read see the edit. Re-snapshot
// after: the only other persistFileSnapshotIfRemote call (api.ts) runs
// in normalizeToolInput, pre-permission — it captured the old plan.
if (inputPlan !== undefined && filePath) {
  await writeFile(filePath, inputPlan, 'utf-8').catch(e => logError(e))
  void persistFileSnapshotIfRemote()
}
```

这段处理的是「**用户在批准对话框里改了计划**」。用户改完，
改动**写回同一个文件路径**，然后重新快照。于是下游所有读这个文件的地方
（Read 工具、验证逻辑、恢复逻辑）看到的都是**用户改过的版本**。

反过来推：如果计划是纯参数，用户的编辑只能存在于这一次 tool_result 里，
后续任何环节想拿到「最终批准的那版计划」都得**去翻消息历史**。
而作为文件，它有一个稳定的、所有参与方都能寻址的身份。

**一句可迁移的话**：

> 不只是计划。任何「需要被多方读写、需要跨上下文边界存活」的 agent 中间产物都适用——
> 研究笔记、需求规格、代码审查结论、多 agent 的共享黑板。

### 4.4 ④ 批准：人的编辑本身是要回传给模型的信息

这一节是个很细但很重要的设计点。

`ExitPlanMode` 的 `outputSchema` 里有一个字段 `planWasEdited`
（🔬 claude-code `ExitPlanModeV2Tool.ts:476-479`）：

```ts
const planLabel = planWasEdited
  ? 'Approved Plan (edited by user)'
  : 'Approved Plan'
```

模型会被**明确告知「用户改过这份计划」**。为什么这很重要：

> **人在回路不只是「批准 / 拒绝」的二值信号，人的修改本身是信息。**
> 如果只告诉模型「批准了」，模型会以为自己那版就是最终版，
> 后续实施可能偏离用户真实意图。

sid-code 的对应处理走了不同的路径。它没有 `planWasEdited` 字段，
但**在拒绝路径上传回了用户的反馈文本**（🔬 `packages/cli/src/app.ts:4959-4974`）：

```ts
const feedback = typeof decision === "string" && decision.startsWith("reject:")
  ? decision.slice("reject:".length).trim() : "";
const canContinue = this.planManager.reject();
if (canContinue) {
  const count = this.planManager.getRejectionCount();
  const feedbackLine = feedback ? `\n\n用户的修改意见：${feedback}` : "";
  return [{ type: "text", text: `<system-reminder>\n用户拒绝了你的计划（第 ${count} 次）。请根据用户反馈修改计划文件，然后再次调用 exit_plan_mode 提交审批。${feedbackLine}\n</system-reminder>` }];
}
```

注意三个细节：

1. **拒绝次数被告知模型**（`第 ${count} 次`）。这是给模型的一个压力信号：
   同一个方向已经被否两次了，该换思路。
2. **有上限**：`maxRejections = 5`（🔬 `state.ts:61`）。超限**强制退出规划态**，
   不是无限循环让用户和模型互相耗。
3. 批准路径注入的是 `buildPlanApprovedMessage`，它做的事比「告知批准」多得多，
   见下一节。

### 4.5 ④' 批准消息：一个「唯一锚点」的设计

这一节讲一个很容易被忽略的问题：**批准之后，规划态的 prompt 就被移除了。**

sid-code 的注释把这件事说得很清楚（🔬 `packages/core/src/plan/prompt.ts:150-155`）：

> 嵌入失败更新执行守则 —— 因为 `deactivatePlanMode` 后系统提示词的 plan prompt
> （含阶段 5）会被移除，**批准消息是 LLM 进入执行阶段唯一保留的「plan 上下文锚点」**

所以这条消息被塞进了三件东西（🔬 `prompt.ts:157-198`）：

**第一件：全集锚点（防遗漏）**

```ts
const todoMandate = planStepCount >= 3
  ? `**第一步（必须执行）**：调用 todo_write 把计划逐条拆解为任务清单。` +
    `本计划已识别出约 ${planStepCount} 个步骤，你的 todo 清单**必须覆盖计划的全部步骤**` +
    `（每步一个 todo 项，不要只挑其中几件做），创建后清单总数保持稳定、只更新状态。`
  : `如果计划包含多个步骤（≥ 3 步），**必须首先**使用 todo_write ...`;
```

⚠️ **`planStepCount` 这个数字是 harness 自己数出来的，不是模型报的**
（🔬 `app.ts:5002-5009` → `state.ts:262-296` 的 `parsePlanFromMarkdown`：
只匹配**顶层**的 `1. xxx` / `- xxx`，用 `if (/^\s/.test(raw)) continue` 跳过缩进子项）。

这个设计的价值在于：**它把「全集覆盖」从依赖模型记忆变成了外部约束。**
模型看到的不是「请覆盖全部步骤」（一句它可以自欺的话），
而是「本计划有 **11** 个步骤，你的清单必须有 11 项」——一个可以自我核对的数字。

**第二件：防方案漂移（尊重既有决策）**

```
**尊重既有决策（防方案漂移）**：如果计划文件里有"## 决策记录"小节，说明上一轮已就某些条目
做出了"推迟/跳过"的判断。除非触发了其中写明的"重新评估条件"，否则**不要推翻这些决定**，
更不要把已明确标注"本次不实施"的条目重新提上日程。
```

这一条对应规划阶段的一个要求（🔬 `prompt.ts:57-66`）：

> **决策记录（跨会话防漂移，重要）**：如果你在计划中决定**推迟 / 跳过 / 暂不实施**某个条目，
> 必须在计划文件中用一个"## 决策记录"小节写明：
> 1. 推迟/跳过的**原因** 2. **替代方案** 3. **触发重新评估的条件**
>
> 理由：后续会话（甚至本会话执行阶段）的你只能看到计划的静态文本，看不到当初的推理过程。
> 没有决策记录，下一轮很可能在不理解原委的情况下推翻这个决定，造成"方案漂移"和反复返工。

**这一段值得单独拿出来讲，因为它解决的是一个纯粹的信息论问题**：

```
规划阶段的模型知道：  「跳过 X，因为依赖 Y 还没就绪」  ← 推理过程
执行阶段的模型看到：  「计划里没有 X」                  ← 静态文本
                     ↓
              模型的合理推断：「计划漏了 X，我补上」
                     ↓
                    方案漂移
```

**「为什么不做」这个信息，不写下来就等于不存在。**
这跟本项目 CLAUDE.md 里 `.agents/notes/rejected/` 那一格是同一个道理：
**否决论证是最贵的资产**，因为它防的是「下一个人重新提议同一件事，
然后你把整套论证重做一遍」。

**第三件：执行阶段的失败处理守则**（§5.5 讲）

### 4.6 ⑤ 跨压缩存活

压缩时，harness **主动**把计划文件塞回压缩后的上下文
（🔬 claude-code `compact.ts:1470-1486`）：

```ts
export function createPlanAttachmentIfNeeded(agentId?: AgentId): AttachmentMessage | null {
  const planContent = getPlan(agentId)
  if (!planContent) return null
  return createAttachmentMessage({
    type: 'plan_file_reference',
    planFilePath: getPlanFilePath(agentId),
    planContent,                            // ← 路径和全文都给
  })
}
```

渲染出来是：

```
A plan file exists from plan mode at: ${planFilePath}
Plan contents: ...
If this plan is relevant to the current work and not already complete, continue working on it.
```

**注意它同时给了路径和内容。** 这是所谓「可逆压缩」原则的一个实例：
**压缩时保留取回原文的钥匙。** 给了路径，模型即使觉得贴过来的内容不够，
也能自己 `Read` 完整文件。

为什么要主动做这件事，而不是信任摘要器？答案在 §8.2（Governance Decay），
那是本文最重要的机制解释之一。

### 4.7 ⑥ 跨会话恢复：三级降级链

这一节的价值在于它揭示了一个更普遍的规律。

🔬 claude-code `copyPlanForResume`（`plans.ts:164-231`）：

```ts
try {
  await readFile(planPath)                            // 1. 直接读文件
  return true
} catch (e) {
  if (!isENOENT(e)) { ... }
  if (getEnvironmentKind() === null) return false     // 本地环境不需要兜底
  // 2. 从 transcript 里的 file_snapshot 恢复
  const snapshotPlan = findFileSnapshotEntry(log.messages, 'plan')
  if (snapshotPlan?.content.length) recovered = snapshotPlan.content
  else recovered = recoverPlanFromMessages(log)       // 3. 从消息历史里挖
  if (recovered) await writeFile(planPath, recovered)
}
```

第 3 级 `recoverPlanFromMessages` 从**三个不同位置**捞计划：
`ExitPlanMode` 的 tool_use input、user message 的 `planContent` 字段、
以及自动压缩产生的 `plan_file_reference` attachment。

三级的顺序有讲究：

| 级别 | 来源 | 特点 |
| --- | --- | --- |
| 1 | 文件 | 最快最准 |
| 2 | transcript 里的快照 | 结构化、内容完整 |
| 3 | 消息历史挖掘 | 最脏，但兜底 |

**为什么要这么复杂？** `getEnvironmentKind() === null` 那行注释给了答案：

> `Only attempt recovery in remote sessions (CCR) where files don't persist`

云端环境（Claude Code on the web）里容器是临时的，文件系统不可靠。于是得到一条通用规律：

> **当你把状态外置到文件系统时，你就依赖了文件系统的持久性假设；
> 一旦部署环境不保证这个假设，你必须自己补一层恢复。**

还有一个细节：`persistFileSnapshotIfRemote` 是**增量写**的——
每次计划变更就往 transcript 里追加一次快照，**不是等到崩溃才想起来备份**。

⚠️ **sid-code 没有这一层**（🔬 复跑确认：全仓 `grep -rn "copyPlan\|planForResume\|planForFork\|restorePlan"` **零命中**）。
这不是缺陷——sid-code 目前只跑在本地，文件系统是可靠的。
**但它意味着：如果 sid-code 要上云端容器环境，这一层必须补。**
这也是一个很好的面试素材：**能力的缺失和缺陷不是一回事，判据是部署环境的假设**。

### 4.8 ⑦ 分支（fork）：Resume 是 checkout，Fork 是 branch

🔬 claude-code `copyPlanForFork`（`plans.ts:239-264`）：

```ts
// 与 copyPlanForResume 不同：fork 时生成新 slug，而不是复用原 slug
const newSlug = getPlanSlug(targetSessionId)
const newPlanPath = join(plansDir, `${newSlug}.md`)
await copyFile(originalPlanPath, newPlanPath)
```

注释解释原因：`This prevents the original and forked sessions from clobbering each other's plan files.`

| 操作 | slug | 为什么 |
| --- | --- | --- |
| **Resume**（恢复会话） | **复用**原 slug | 同一条时间线的延续 |
| **Fork**（分叉会话） | **生成新** slug | 两条时间线会并行演化，共享文件会互相覆盖 |

**这是把计划当作有版本语义的资源在管理，而不是当作一段文本。**
一句好记的类比：**Resume 是 `git checkout`，Fork 是 `git branch`。**

### 4.9 ⑧ 过期判定：持久化解决了「丢失」，引入了「过期」

这是整个 §4 最反直觉的一节，也是最容易被忽略的一节。

🔬 claude-code `attachments.ts:1216-1219`：

```ts
if (hasExitedPlanModeInSession() && existingPlan !== null) {
  attachments.push({ type: 'plan_mode_reentry', planFilePath })
  setHasExitedPlanMode(false)   // Clear flag - one-time guidance
}
```

用户退出规划态后**又重新进入**（且旧计划文件还在），触发一次性引导：

```
1. Read the existing plan file to understand what was previously planned
2. Evaluate the user's current request against that plan
3. Decide how to proceed:
   - Different task: start fresh by overwriting the existing plan
   - Same task, continuing: modify the existing plan while cleaning up outdated sections
Treat this as a fresh planning session. Do not assume the existing plan is relevant.
```

**这是在处理状态外置的副作用**：

> 计划持久化到文件带来一个新问题：**旧计划会变成污染源。**
> 模型看到文件里有内容，容易默认「这就是当前任务的计划」，
> 从而在错误的前提上继续工作。

一句必须记住的话：

> **状态持久化解决了「丢失」，但引入了「过期」。**

很多人（包括源材料作者本人）一开始都觉得持久化是**纯收益**。它不是。

顺带一个细节值得学：`setHasExitedPlanMode(false)` 的注释写 `one-time guidance`
——这个引导只在**转移的那一刻**发一次，不重复发。
**转移是事件，不是状态**，这两者用不同的注入策略。

### 4.10 一个我复跑时抓到的活体样本：过期的另一种形态

上一节讲的「过期」是内容层面的。**还有一种过期是文件层面的**，
而我在核验本文时正好抓到一个（🔬 2026-08-31，本机）：

```bash
$ find ~/.sid-code/plans -maxdepth 1 -name '*.md' | wc -l
     173                     # 顶层散落的「词-slug」计划文件
$ find ~/.sid-code/plans -mindepth 2 -name '*.md' | wc -l
      11                     # 项目子目录里的「时间-主题」计划文件

# 按月份分布
顶层（旧命名）：2026-03: 6 | 2026-04: 4 | 2026-05: 125 | 2026-06: 37 | 2026-07: 1
子目录（新命名）：2026-07: 5 | 2026-08: 6
```

**发生了什么**：sid-code 的计划文件命名规则在 2026-07 前后改过一次
（词 slug `calm-raven-83.md` → 项目/时间-主题 `sid-code/20260803-1505-xxx.md`），
**旧文件全留在原地，没人清理。**

更有意思的是我顺手核验的第二件事：

```bash
$ grep -n "MAX_AGE_MS" packages/core/src/config/startup-housekeeping.ts
78:  const TRAJECTORY_MAX_AGE_MS  = 30 天     # 轨迹会话目录
96:  const SHELL_SNAPSHOT_MAX_AGE_MS = 1 天   # shell 快照
99:  const TASK_OUTPUT_MAX_AGE_MS = 7 天      # 任务输出
108: const CHECKPOINT_MAX_AGE_MS = 30 天      # 检查点
# ← plans 不在这个清单里，一条都没有
```

**`plans/` 目录在启动清理清单里根本不存在。** 有意思的是，
这 173 个文件里就有一份叫 `20260715-1747-文件定期清理机制.md`
——**清理机制的计划文件，自己成了没被清理的孤儿。**

这算 bug 吗？我倾向于说：**这是「资产 vs 产物」判据缺失的典型形态**。
两种解读都成立：

| 解读 | 结论 |
| --- | --- |
| 计划是**资产**（用户的历史决策记录） | 不该清理，184 个文件是正常积累 |
| 计划是**产物**（一次任务的中间态） | 该清理，跟 checkpoint 同类 |

⚠️ **没有第三种解读，但必须选一个**——因为「不选」的结果就是现在这样：
按资产对待（不清），却按产物命名（旧规则的文件人已经认不出是哪个项目的了）。

**教学价值**：这一节是 §4.9「持久化引入过期」的**实证**。
不是抽象论述，是我在写这份文档时从自己机器上翻出来的 184 个文件。

### 4.11 本章自检

- [ ] 「这个产物该不该有一个地址」的判据是什么？两个条件缺一个会怎样？
- [ ] 为什么 `ExitPlanMode` 不接收计划参数？三个猜测里哪两个是错的，为什么？
- [ ] 「决策记录」小节解决的是什么信息论问题？为什么执行阶段的模型会「重新提议」？
- [ ] Resume 与 Fork 的 slug 策略为什么不同？对应 git 的哪两个操作？
- [ ] 「持久化解决了丢失、引入了过期」——你能举一个自己项目里的例子吗？
- [ ] sid-code 没有三级恢复链，这是缺陷吗？判据是什么？

---
<a id="s5"></a>

## §5 Plan Mode 是一个状态机（三态 + 一个正交标志）

§4 讲的是「计划这个对象」，这一章讲「围着它的那个模式」。

### 5.1 三个状态和四条边

🔬 sid-code `packages/core/src/plan/state.ts:17`：

```ts
export type PlanModeState = "inactive" | "planning" | "awaiting_approval";
```

```
                    enter()
        ┌──────────────────────────────┐
        │                              ▼
   ┌─────────┐                   ┌──────────┐
   │inactive │                   │ planning │◄──────┐
   └─────────┘                   └──────────┘       │
        ▲  ▲                          │             │ reject()
        │  │                          │ submitFor   │ （且未超上限）
        │  │                          │ Approval()  │
        │  │                          ▼             │
        │  │                   ┌──────────────────┐ │
        │  └───────────────────┤ awaiting_approval├─┘
        │      approve()       └──────────────────┘
        │                              │
        └──────────────────────────────┘
            reject() 且 rejectionCount >= 5
            或 forceExit()（用户取消）
```

四条边，每条都有一个具体理由：

| 边 | 触发者 | 关键实现细节 |
| --- | --- | --- |
| `enter()` | 用户按 `/plan` 或模型调 `enter_plan_mode` | **只在 inactive 时生效**（`if (this.state !== "inactive") return false`）——防重入造出假状态 |
| `submitForApproval()` | 模型调 `exit_plan_mode` | 只从 planning 出发 |
| `approve()` | **用户**在审批框点批准 | 状态回 inactive，但**同时置起 `executing` 标志**（见 5.3） |
| `reject()` | **用户**拒绝 | 回 planning 继续改；**计数到 5 强制退出** |

⚠️ **注意谁是触发者**：`approve` 和 `reject` 的主语是**用户**，不是模型。
这是形态 C 的定义性特征——**模型没有自己批准计划的权力**。
如果一个「Plan Mode」的实现里模型能自己批准，那它只是个 prompt 技巧，不是规划态。

### 5.2 为什么拒绝要有上限

`maxRejections = 5`（🔬 `state.ts:61`）。超限后**强制退出规划态**。

这个设计防的是一个具体的死循环：用户和模型互相耗。

```
模型出计划 → 用户拒绝 → 模型改 → 用户又拒绝 → ...
```

没有上限时，如果模型**根本没理解**用户在拒什么（比如用户的意见是
「你完全没抓住重点」，模型只会微调措辞），这个循环可以无限进行，
每一轮都烧一份完整的规划成本。

**上限的语义不是「你不许再改了」，是「这条路走不通，换个交互方式」。**
超限后回到普通模式，用户可以直接说「不要 plan，就按我说的做」。

这是一个更普遍的原则的实例：**任何「重试直到成功」的循环都必须有上限，
而且超限后的行为不能是「报错」，得是「换一条路」。** 对比 §2.4 那个
`exit_plan_mode` 空转——它当初的问题恰恰是**没有上限也没有换路**。

### 5.3 那个正交标志：`executing`

这一节讲一个非常漂亮的 bug 修复，它揭示了「状态机」建模的一个常见陷阱。

先看这段注释（🔬 `state.ts:74-83`）：

```ts
/**
 * 是否处于"执行阶段"——计划已被 approve、正在按计划执行。
 *
 * 缺陷修复：Recovery Hook 的设计意图是"执行阶段工具失败时提醒先更新 plan 再继续"，
 * 但 approve() 后状态立刻回到 inactive、isPlanning() 为 false，recovery 永远触发不到。
 * 这里用独立标志追踪执行阶段：approve() 时置 true，下次 enter()/forceExit() 时清零。
 * 与三态状态机正交——执行阶段权限模式已恢复（非 plan），但语义上仍"在按计划干活"。
 */
private executing = false;
```

**问题的形态非常典型**：

```
设计意图：  执行阶段工具失败 → 提醒模型「先更新计划再继续」
实际行为：  approve() 后 state = inactive
           → isPlanning() 返回 false
           → recovery hook 的触发条件永远不成立
           → 这个功能代码全在，调用次数恒为 0
```

**这就是本项目 CLAUDE.md 里反复强调的那类失效：「防线全在、调用全 0」。**
代码在、测试可能还绿着、机理讲得通，但它一次都没生效过。

修复方式值得学：**没有把 `executing` 塞进那三个状态里**（比如加一个第四态
`executing`），而是**开了一个正交的布尔标志**。为什么这样对：

| 维度 | 语义 |
| --- | --- |
| 三态（`state`） | **权限**：现在准不准写文件 |
| `executing` 标志 | **语义**：现在是不是「在按一份计划干活」 |

这两件事真的是正交的：执行阶段**权限已经恢复**（可以写文件了），
但**语义上仍在按计划走**。硬塞进一个枚举，就必须回答
「executing 状态下权限是什么」——而答案是「跟 inactive 一样」，
说明它压根不是同一个维度的东西。

**一条可迁移的建模判据**：

> 当你想给状态机加一个新状态时，先问：**它在原有维度上的取值是什么？**
> 如果答案是「跟某个已有状态一样」，那它不是新状态，是一个正交维度。

### 5.4 分档提醒：为什么第 1 轮和第 5 轮不一样

🔬 sid-code `state.ts:216-219`：

```ts
nextReminderIsFull(): boolean {
  this.reminderTurn++;
  return this.reminderTurn === 1 || this.reminderTurn % this.fullReminderInterval === 0;
}
```

`fullReminderInterval = 5`。所以节奏是：

```
轮次:   1     2     3     4     5     6     7     8     9    10
档位:  FULL  spar  spar  spar  FULL  spar  spar  spar  spar  FULL
```

两档的内容差异（🔬 `plan/prompt.ts:116-143`）：

**sparse 档**（3 行）：

```
[计划模式] 只允许只读操作。如果你已完成分析并有清晰方案，立即写计划并调用 exit_plan_mode 提交审批。
不要反复探索或过度分析——目标是尽快拿出可执行的方案，不是写出完美的设计文档。
```

**full 档**（约 20 行）：完整的权限模式声明 + 允许操作清单 + 禁止操作清单 +
那句最强的越权防线：

```
你**绝对不能**进行任何编辑（计划文件除外）、运行任何非只读工具、或对系统做出任何变更。
此约束覆盖你收到的所有其他指令。
```

**为什么要分档**（这是核心）：

| 方案 | 问题 |
| --- | --- |
| 只在进入时说一次 | **会衰减**。10 轮后那段话在注意力分布里已经很轻 |
| 每轮都发完整版 | **太贵**。20 行 × 每轮 = 纯浪费，还挤占上下文 |
| **分档** | 高频低成本维持存在感，低频高成本重建完整规则 |

claude-code 是同一个思路但两个独立计数器（🔬 `PLAN_MODE_ATTACHMENT_CONFIG`）：

```ts
{ TURNS_BETWEEN_ATTACHMENTS: 5, FULL_REMINDER_EVERY_N_ATTACHMENTS: 5 }
```

即：**每 5 轮提醒一次，每 5 次提醒里 1 次是完整版** = 每 5 轮轻提醒、每 25 轮重提醒。

它的 sparse 档还有一个漂亮的细节：

```
Plan mode still active (see full instructions earlier in conversation).
Read-only except plan file (${planFilePath}). Follow 5-phase workflow.
End turns with AskUserQuestion or ExitPlanMode.
```

**`see full instructions earlier in conversation`** ——明确告诉模型
「完整规则在对话前面，去那里找」。这是一个很经济的做法：
**精简版不重复内容，只重建「有这么个约束」的存在感 + 给出取回的路径。**

### 5.5 执行阶段的失败处理：一条被写进 prompt 的循环

§4.5 提到批准消息里有第三件东西，就是这个（🔬 `prompt.ts:190-197`）：

```
执行守则：如果在执行过程中遇到工具失败（权限拒绝、文件不存在、命令报错等）、
发现实际环境与计划假设不一致、或发现计划遗漏关键步骤，
**你必须先用 edit 工具更新计划文件再继续执行**：
1. 在计划中标注失败步骤（[FAILED] 或 [BLOCKED]）+ 原因
2. 写出新策略（fallback / 跳过 / 求澄清）
3. 然后按更新后的计划继续

这是为了让计划反映真实执行过程，不停留在初版乐观估计。
```

**这就是 §3.2 说的「把 ToT 的回溯换成计划文件的增量修订」的具体形态。**
注意它不是「退回上一步」，而是**在计划里留下失败的痕迹再往前走**。
两者的区别：

| | 回溯（ToT） | 增量修订（coding agent） |
| --- | --- | --- |
| 已发生的副作用 | 假设可撤销 | **承认不可撤销，记录下来** |
| 计划文件的最终状态 | 只有成功路径 | **含 `[FAILED]` 标记和真实走过的弯路** |
| 下一轮的模型看到 | 一份干净的计划 | 一份**带疤的**计划——但那些疤是信息 |

最后一行注释是这个设计的灵魂：**「不停留在初版乐观估计」**。
初版计划总是乐观的（没遇到真实环境），如果它永远不更新，
那它就从「当前的行动依据」退化成「一份历史文档」。

### 5.6 Recovery Hook：一次归因错误的教训

上一节那个守则是靠 prompt 说的。sid-code 还有一个**代码级**的触发器
（🔬 `packages/core/src/plan/recovery.ts`），它在工具失败时注入提醒。

它的核心是一个分类函数，而这个函数**是修 bug 修出来的**：

```ts
// 背景 (bug fix): 旧逻辑 `block.name === "read" || "edit" ? "file_not_found" : "tool_failure"`
// 把 read/edit 的**任何**失败都当成 file_not_found。但这两个工具的失败远不止"路径不存在":
//   - read: "是一个目录，不是文件" / "文件过大" / "二进制文件" / "无权限"
//   - edit: "未找到要替换的字符串" / "模糊匹配歧义" / "文件已存在且非空" / "无权限"
// 结果是模型收到误导性的"文件/目录不存在"提示 —— 明明目录存在, 只是把目录当文件读了.
export function classifyRecoveryTrigger(_toolName: string, errorMessage: string): RecoveryTrigger {
  // 1) 权限拒绝
  if (/无权限|权限被拒|权限拒绝|permission denied|\bEACCES\b|\bEPERM\b/i.test(msg)) return "permission_denied";
  // 2) 真·文件不存在（刻意排除"是一个目录 / 不是文件"—— 路径存在, 只是类型不符）
  if (/文件不存在|no such file or directory|\bENOENT\b/i.test(msg)) return "file_not_found";
  // 3) 兜底: 由 buildRecoveryHint 回显真实错误消息, 不臆造"不存在"
  return "tool_failure";
}
```

**注意第一个参数叫 `_toolName`——带下划线前缀，表示「收下但不用」。**
这个下划线本身就是那次 bug 修复的痕迹：**判据从「工具名」改成了「错误消息内容」**。

**教训是可迁移的，而且很锋利**：

> **harness 给模型的归因提示如果是错的，会诱导模型 hallucinate。**
> 模型收到「文件不存在」，会去查「文件是不是被删了/改名了」——
> 而真相是它把一个目录当文件读了。**错误的归因比没有归因更糟**，
> 因为它给了模型一个错误但具体的方向。

这条对应一个更一般的判据优先级（本项目多次踩到）：

```
状态码 / reason 白名单   >   数字边界   >   裸子串匹配
（最可靠）                                （最容易误判）
```

上面那个修复本质上是从「拿工具名当代理」升级到「读真实错误消息」——
**往判据优先级的上游走了一格。**

### 5.7 一个必须点破的现状：这个 hook 接线了吗

⚠️ 我复跑核验了（🔬 2026-08-31）：

```bash
$ grep -rn "classifyRecoveryTrigger\|buildRecoveryHint" packages/ --include='*.ts' | grep -v /tests/
packages/core/src/plan/recovery.ts:39:   （定义）
packages/core/src/plan/recovery.ts:105:  （定义）
packages/cli/src/app.ts:4781: const { getSharedRecoveryHook, classifyRecoveryTrigger } = ...
packages/cli/src/app.ts:4801: const triggerType = classifyRecoveryTrigger(block.name, ctx.errorMessage);
packages/cli/src/app.ts:4804: const hint = hook.buildRecoveryHint(triggerType, ctx);
```

**✅ 这个是真接线了**（`app.ts` 有生产调用点）。

我特意做这个核验，是因为**同一个文件族里另一个模块就没接线**——
见 §11.3。**「代码在」和「在跑」是两件事，每次引用一个能力前都该跑一次这个 grep。**

### 5.8 本章自检

- [ ] 三态状态机的四条边，你能说出每条的触发者是「模型」还是「用户」吗？
- [ ] 拒绝上限的语义为什么不是「你不许再改了」？超限后正确的行为是什么？
- [ ] `executing` 为什么是正交标志而不是第四个状态？判据是什么？
- [ ] 分档提醒的两个独立计数器各控制什么？只用一个会怎样？
- [ ] 「增量修订」和「回溯」的三个区别，你能复述吗？
- [ ] `classifyRecoveryTrigger` 的第一个参数为什么带下划线前缀？

---
<a id="s6"></a>

## §6 越权防线：「只规划不执行」是权限工程，不是一句 prompt

这一章回答 §1 那个问题：**凭什么规划态的 agent 不会顺手改个文件？**

概念层把「Planner 只规划不执行」当成一个可以靠**角色设定**实现的事
（「你是一个规划专家，你只负责出方案」）。源码告诉我们这是个**权限工程**问题。

### 6.1 先想清楚：靠 prompt 说「你不要改」够不够

不够，而且不够的方式有三种，一层比一层隐蔽：

| # | 失效方式 | 为什么 |
| --- | --- | --- |
| ① | **约束随距离衰减** | 第 30 轮时，第 1 轮那句「不要改文件」在注意力分布里已经很轻（§2.2） |
| ② | **压缩会把它删掉** | 摘要器优化任务连续性，常驻约束在它看来是「不是当前子目标的旧文本」（§8.2） |
| ③ | **模型可以「合理地」违规** | 「我需要建一个临时文件来验证方案」——它不觉得自己在违规 |

第 ③ 条最麻烦。它不是模型不听话，是**模型对「修改」的理解和你不一样**。

所以正确的做法是分层。claude-code 的 planAgent 有**三层防线，从硬到软**
（🔬 2026-08-13 实读 `AgentTool/built-in/planAgent.ts`）：

### 6.2 第一层（最硬）：工具级剥离

```ts
disallowedTools: [
  AGENT_TOOL_NAME,          // 不能再派子 agent（防止递归爆炸）
  EXIT_PLAN_MODE_TOOL_NAME,
  FILE_EDIT_TOOL_NAME,
  FILE_WRITE_TOOL_NAME,
  NOTEBOOK_EDIT_TOOL_NAME,
],
```

写文件的工具**根本不在这个 agent 的工具表里**。这是最硬的约束——
模型想违规也调不到，因为那个工具在它的 API 请求里不存在。

⚠️ 顺带注意第一项 `AGENT_TOOL_NAME`：**规划 agent 不能再派子 agent。**
理由是防递归爆炸——一个规划 agent 派 3 个规划 agent，每个再派 3 个……

sid-code 的对应实现是四层工具过滤（🔬 `packages/core/src/agent/tool-filter.ts`）：

```ts
/** 所有子代理都不能使用的工具（硬性禁止） */
const ALL_AGENT_DISALLOWED_TOOLS = new Set([
  "enter_plan_mode",   // 计划模式是主代理的状态
  "exit_plan_mode",    // 同上
  "save_memory",       // 记忆管理是主代理的职责
  "task_output",       // 子代理不应读取其他任务输出
  "task_stop",         // 子代理不应终止其他任务
]);

/** 内置子代理类型的工具白名单 */
const BUILTIN_AGENT_ALLOWED_TOOLS = {
  explore: ["read", "grep", "glob", "ls", "read_many", "task_list", "task_get", "todo_write"],
  plan:    ["read", "grep", "glob", "ls", "read_many", "task_list", "task_get", "todo_write"],
  verify:  ["read", "grep", "glob", "ls", "read_many", "bash", "task_list", "task_get", "todo_write"],
  ...
};
```

**注意一个刻意的差异**：`plan` 子代理的白名单里**没有 `bash`**，
而 `verify` 子代理有（注释写「对抗式验证：只读 + bash 核实」）。

这跟 claude-code 的 planAgent 不一样——**后者给了 bash，只是限制用法**。
6.5 会讨论这个差异的代价，那是本章最有价值的一节。

⚠️ 还要注意「计划模式是主代理的状态」那条注释：**子代理不能进出规划态。**
这个约束的理由和递归爆炸不同——规划态涉及**人类审批**，
而子代理没有跟用户对话的通道，它调 `exit_plan_mode` 是给谁看的？

### 6.3 第二层（最容易漏）：等价替代路径的显式封堵

这是全章最重要的一节。

剥离了 Edit / Write 工具之后，模型还有 **Bash**。而 `echo x > file` **一样能写文件**。

claude-code 的 planAgent prompt 把这条绕道路径**显式点名封堵**
（🔬 `planAgent.ts:23-33`）：

```
=== CRITICAL: READ-ONLY MODE - NO FILE MODIFICATIONS ===
- Creating temporary files anywhere, including /tmp
- Using redirect operators (>, >>, |) or heredocs to write to files
```

连 `/tmp` 和 heredoc 都点到了。为什么这两个特别值得点名：

| 绕道 | 模型的「合理」理由 |
| --- | --- |
| `/tmp` | 「这不是项目文件，不算修改代码库」 |
| heredoc（`cat <<EOF > f`） | 语法上不像重定向，模型可能不认为它属于「写文件」 |
| 管道 `\|` | 「我只是在处理文本」（但 `\| tee f` 会写文件） |

**通用规律，这是本章最该记住的一句**：

> **能力剥离必须考虑「等价能力的替代路径」。你把前门锁了，得数清楚有几扇窗。**

几个同构的例子：

| 你以为锁住了 | 实际的窗 |
| --- | --- |
| 只读 agent（摘掉 Write） | **Bash 重定向** |
| 禁网 agent（curl 域名白名单漏一个） | 数据外传 |
| 禁删 agent（摘掉 rm） | `mv` 到 `/tmp` = 等效删除 |
| 禁改 git 历史 | `git commit --amend` / 直接改 `.git/` |

**一句可以背下来的结论**：

> **任何图灵完备的工具（Shell、Python `exec`、`eval`）都会让细粒度权限模型失效。
> 必须单独为它设计白名单。**

### 6.4 第三层（最软）：正向白名单 + 首尾重申

claude-code 的做法（🔬 `planAgent.ts:47-48, 70`）：

```
- Use Bash ONLY for read-only operations (ls, git status, git log, git diff, find, cat, head, tail)
- NEVER use Bash for: mkdir, touch, rm, cp, mv, git add, git commit, npm install, ...

（prompt 最末尾）
REMEMBER: You can ONLY explore and plan. You CANNOT and MUST NOT write, edit, or modify any files.
```

三个细节值得学：

1. **既给白名单又给黑名单**。白名单告诉模型「能做什么」（否则它会保守到什么都不做），
   黑名单堵住具体的诱惑。
2. **在 prompt 最末尾再重申一次**。首尾都放约束、中间放流程——
   这是对 **Lost-in-the-Middle** 的直接应对。
3. 白名单里的命令全是**真正只读**的：`git status` / `git log` / `git diff` 不写工作区。

顺带一个 token 优化的细节（🔬 `planAgent.ts:88-90`）：

```ts
// Plan is read-only and can Read CLAUDE.md directly if it needs conventions.
// Dropping it from context saves tokens without blocking access.
omitClaudeMd: true,
```

不把 `CLAUDE.md` 塞进规划 agent 的上下文，因为它是只读 agent，
真需要规范时可以自己 `Read`。

> **「能力可达」和「预先加载」是两件事。**
> 把可选内容从「推进去」改成「让它自己拿」，省 token 且不损失能力。

这直接回答了那道 token 预算八股题（「规划 20% / 执行 60% / 反思 20%」）：
**真实系统里规划阶段的预算控制不是靠算术分配，是靠结构性地不加载不必要的东西。**

### 6.5 ★ sid-code 的选择：整个禁掉 bash，以及它的代价

这一节是本章最有价值的部分，因为它是一个**真实的、双向都有代价的权衡**。

sid-code 的 plan 权限模式是**代码级强制**的（🔬 `packages/core/src/permission/checker.ts:1746-1798`）。
核心是三个集合：

```ts
const READ_ONLY_TOOLS = new Set([
  "read", "grep", "glob", "ls", "read_many", "save_memory",
  "hypothesis_register", "hypothesis_challenge",
]);
// ← bash 不在里面

const PLAN_MODE_EXTRA_TOOLS = new Set(["enter_plan_mode", "exit_plan_mode", "sub_agent"]);
```

判定逻辑：

```ts
private checkPlanMode(req, filePath, resource): Decision {
  if (this.prePlanMode === "always-allow") return { allowed: true };      // 逃逸阀①，见 6.6
  if (READ_ONLY_TOOLS.has(req.toolName)) return { allowed: true };        // bash 不在此
  if (PLAN_MODE_EXTRA_TOOLS.has(req.toolName)) {
    if (req.toolName === "sub_agent") {
      const subType = req.input?.subagent_type || req.input?.type;
      if (subType && subType !== "explore")
        return { allowed: false, reason: "计划模式下只允许 explore 类型的子代理" };
    }
    return { allowed: true };
  }
  if ((req.toolName === "write" || req.toolName === "edit") && this.planManager?.isPlanFile(filePath))
    return { allowed: true };                                             // 计划文件例外
  return { allowed: false, reason: "计划模式下只允许只读操作" };            // ← bash 落到这里
}
```

**于是 claude-code 的第二层防线（封堵 bash 重定向）在 sid-code 主代理的规划态里
根本不需要——因为 bash 整个被拦在门外。**

这个选择的两面：

| | 收益 | 代价 |
| --- | --- | --- |
| **禁掉 bash** | 越权风险归零，不需要维护「几扇窗」的清单 | 规划阶段**不能跑 `git log` / `git diff` / `git status`** |
| **给只读 bash** | 规划时能看历史、看 diff（这些信息很有价值） | 必须维护绕道封堵清单，且靠 prompt 保证（软的） |

**代价是真实的。** 「这个模块最近谁改的、上次重构为什么失败」这类信息
只能从 `git log` 拿到，`read` / `grep` 拿不到。规划阶段拿不到它，
方案质量会打折。

⚠️ 但这不是说 sid-code 错了。它有一个 claude-code 没有的约束：
**sid-code 要在弱模型上跑**（DeepSeek / GLM 系）。而 6.3 那套封堵完全靠 prompt——
**prompt 约束在弱模型上的遵守率显著更低**。对弱模型来说，
「给了 bash 再靠 prompt 说别写文件」和「不给 bash」的实际安全性差距很大。

**一句可以直接说出口的判断**：

> 「给只读 bash 还是不给」取决于你的越权封堵是硬的还是软的。
> claude-code 靠 prompt 封堵绕道，那要求模型有足够的指令遵循能力；
> 如果你的目标模型是弱模型，把 bash 整个拦掉是更稳的选择，
> 代价是规划阶段失去 git 历史这个信息源。

### 6.6 两个必须知道的逃逸阀（这才是真实系统的样子）

上面那段代码里有两处会让「plan 模式 = 只读」这个论断失效的地方。
**它们都是刻意设计的，不是 bug，但你必须知道它们存在。**

**逃逸阀①：`prePlanMode === "always-allow"` 时 plan 模式全放行。**

```ts
// plan 继承 bypass：如果 prePlanMode 是 always-allow，则自动放行
if (this.prePlanMode === "always-allow") return { allowed: true, ... };
```

语义是：**用户在进入规划态之前已经选了「全部允许」，
说明他信任这个会话，规划态不该再退回去问他。**

这个设计的合理性可以争论，但它的存在必须知道——
**如果你在 `--dangerously-skip-permissions` 或 always-allow 模式下测「plan 模式能不能写文件」，
你测到的是「能」，而这不代表 plan 模式坏了。**

**逃逸阀②：`allow` 规则排在 plan 模式判定之前。**

判定链的顺序（🔬 `checker.ts` 的 Step 注释）：

```
Step 1  deny 规则
Step 2  危险命令拦截
Step 3  禁用工具
Step 3.5 ★ Plan Mode 计划文件提前放行
Step 4  路径验证
Step 5  ask 规则
Step 6  safetyCheck（bypass-immune）
Step 7  沙箱自动放行
Step 8  bypass/always-allow 模式
Step 8  allow 规则          ← 在这里
Step 9  plan 模式            ← 在这里
Step 10 只读工具自动放行
...
Step 14 passthrough → ask
```

**Step 8 在 Step 9 之前**，意味着：**一条用户配置的 `allow` 规则
（比如 `Bash(git *)`）会在 plan 模式判定之前命中并放行。**

这不是 bug，是有意的优先级：**用户显式配置的规则比模式默认值优先。**
但它有一个直接推论：**「plan 模式强制只读」这句话严格来说是
「plan 模式在没有更高优先级规则命中时强制只读」。**

⚠️ 顺带看 Step 3.5 那个「计划文件提前放行」，它的注释解释了一个有趣的顺序问题
（🔬 `checker.ts:774-791`）：

```ts
// Step 3.5: Plan Mode 计划文件提前放行（W11.D4：解锁 plan capability eval）
// 背景：src/plan/prompt.ts 教 LLM 用 write 写计划文件到 ~/.sid-code/plans/plan-*.md，
// 但 Step 4 路径验证会因「不在工作区内」直接拒绝，Step 9 的计划文件
// 放行逻辑永远走不到。本步骤在 Step 4 之前判断：plan mode + write/edit 计划文件 → 提前放行。
// 安全：精确匹配 planManager.getPlanFilePath()（不接受路径前缀匹配），避免目录遍历。
```

**这是一个「两条正确的规则相撞」的经典形态**：

```
规则 A（路径验证）：不许写工作区之外的文件      ← 正确
规则 B（plan 模式）：允许写计划文件              ← 正确
计划文件在 ~/.sid-code/plans/（工作区之外）
                ↓
        A 排在 B 前面 → B 永远走不到
                ↓
        症状：模型写不了计划文件，而 B 的代码全在
```

修复方式是**把 B 的一个特化版本提到 A 之前**，并加一条安全约束
（精确匹配路径，不接受前缀匹配——否则 `~/.sid-code/plans/../../.ssh/id_rsa` 就通了）。

**这一节的教学价值**：真实系统的权限层是一条**有顺序的判定链**，
而「顺序」本身就是设计。任何「X 模式强制 Y」的论断，
都要问一句：**它在链上的第几步？前面有几步能抢走它？**

### 6.7 三层防线的总表

| 层 | 手段 | 硬度 | 失效方式 | sid-code 主代理规划态 |
| --- | --- | --- | --- | --- |
| ① | 工具不在工具表里 / 权限层代码拦截 | **硬** | 逃逸阀（allow 规则、bypass 继承） | ✅ 有，且 bash 也被拦 |
| ② | 绕道路径封堵（bash 重定向 / tmp / heredoc） | 中（靠 prompt） | 弱模型不遵守；漏掉某扇窗 | ➖ 不需要（bash 已拦） |
| ③ | prompt 首尾重申 + 正反白名单 | **软** | 距离衰减、压缩擦除 | ✅ 有（full 档提醒，§5.4） |

### 6.8 本章自检

- [ ] 靠 prompt 说「不要改文件」不够，三种失效方式你能复述吗？
- [ ] 「能力剥离必须枚举等价替代路径」——除了 bash 重定向，你还能想出两个例子吗？
- [ ] sid-code 禁掉 bash 的代价具体是什么？什么条件下这个选择会反转？
- [ ] 「plan 模式强制只读」这句话严格来说该怎么说？
- [ ] Step 3.5 那个「两条正确规则相撞」的形态，你在自己项目里见过吗？

---
<a id="s7"></a>

## §7 ★ 复述（recitation）：TodoWrite 的真实目的不是「记录」

这是本文第二个架构核心，也是**最反直觉的一章**。

一句话总纲：

> **TodoWrite 表面是给人看的进度条，实质是一个注意力操纵机制。**

### 7.1 先看表面：它长什么样

一个 todo 项就三个字段（🔬 `packages/core/src/tool/todo-write.ts:22-36`）：

```ts
{
  content:    string,                                       // "给设置页加深色模式开关"
  activeForm: string,                                       // "正在添加深色模式开关"（进行时，spinner 用）
  status:     "pending" | "in_progress" | "completed",
}
```

模型调用 `todo_write` 传一份完整清单，harness 存起来、更新 UI 面板。
看起来就是个进度条。

**表面之下有三个反常的现象**，每一个都在提示这不是进度条：

### 7.2 反常现象一：全部完成就直接清空

🔬 claude-code `TodoWriteTool.ts:69`：

```ts
const allDone = todos.every(_ => _.status === 'completed')
const newTodos = allDone ? [] : todos
```

sid-code 同样（🔬 `todo-write.ts:566` 附近的 `allDone` 分支，
注释明写「全部完成时 `currentTodos` 被清空、TodoPanel 随之收起」）。

**如果这是任务记录系统，历史应该保留下来用于审计和复盘。清空说明它只关心「当前还有什么没做」。**

> **它是一块工作内存，不是账本。**

sid-code 的注释还把这个选择的代价点破了（🔬 `todo-write.ts:195-198`）：

> ⚠️ 全部完成时 `currentTodos` 被清空、TodoPanel 随之收起，
> **那一刻屏幕上确实没有「任务全做完了」的痕迹**。这是**刻意接受**的：
> 完成结论由模型的正文收尾承担，而不是靠一张残留的全绿清单。

### 7.3 反常现象二：这个工具的返回值不给用户看

🔬 sid-code `todo-write.ts:200`：

```ts
readonly resultDisplayMode = "hidden" as const;
```

整条工具结果卡片**不渲染**。注释给了两条判据（🔬 `todo-write.ts:187-193`）：

> 1. 本工具 `output` 是**专门写给模型的**——清单 diff 之后紧跟前向推进指令
>    与状态建议。用户读到「请继续用 `todo_write` **实时**流转状态」只会困惑：
>    **那是对模型说的**。
> 2. 清单的权威呈现是 **TodoPanel**（输入框上方常驻面板）。`⎿` 里那份是第二遍，
>    且是拼成给模型读的形态。

**一个「给人看的进度条」工具，它的返回值刻意不给人看。** 这句话本身就说明了定位。

### 7.4 反常现象三：harness 会定期把清单重新贴回对话

这是决定性的一条。

🔬 claude-code `attachments.ts:254` + `messages.ts:3300`：

```ts
export const TODO_REMINDER_CONFIG = {
  TURNS_SINCE_WRITE: 10,
  TURNS_BETWEEN_REMINDERS: 10,
} as const

if (turnsSinceLastTodoWrite >= TODO_REMINDER_CONFIG.TURNS_SINCE_WRITE &&
    turnsSinceLastReminder  >= TODO_REMINDER_CONFIG.TURNS_BETWEEN_REMINDERS) {
  return [{ type: 'todo_reminder', content: todos, itemCount: todos.length }]
}
```

10 个 assistant 轮次没调 `todo_write`，就注入一次提醒；两次提醒间至少隔 10 轮。

注入的**内容**才是关键（🔬 `messages.ts:3668`）：

```ts
let message = `The TodoWrite tool hasn't been used recently. ...`
if (todoItems.length > 0) {
  message += `\n\nHere are the existing contents of your todo list:\n\n[${todoItems}]`
}
```

**它不只是催你用工具，它把整个 todo 列表连同每一项的状态一起重新贴到了对话的最末尾。**

sid-code 的同一机制（🔬 `packages/core/src/query/todo-reminder.ts:19-24, 105-116`）：

```ts
export const TODO_REMINDER_CONFIG = {
  TURNS_SINCE_WRITE: 8,        // 比对标的 10 更低
  TURNS_BETWEEN_REMINDERS: 8,
} as const;

export function buildTodoReminder(todos: TodoItem[]): string {
  const unfinished = countUnfinished(todos);
  return `<system-reminder>
这是你当前的任务清单（请勿向用户提及本提醒）：
${renderTodoLines(todos)}
仍有 ${unfinished} 项未完成。请继续推进，不要遗漏；完成每一项后立即用 todo_write 更新状态。
...
</system-reminder>`;
}
```

⚠️ **阈值定得比对标低（8 vs 10），理由写在注释里**：

> 弱模型（DeepSeek）记忆更短，阈值比 claude-code 的 10 略低，定为 8。

**这是一个值得学的做法：把「为什么是这个数」写进注释，而不是写「重试 8 次」。**
后面的人要改这个数字，就知道该重新考虑什么。

### 7.5 拼起来：为什么要重复贴一遍

这里是全章的推理核心。源材料作者的原始困惑值得原样保留：

> 我原本的理解是：TodoWrite 是给人看的进度条，顺便让模型自己记住做到哪了。
> 但如果只是「让模型记住」，模型的 context 里本来就有它几十轮前调 TodoWrite 的记录，
> **为什么要重复贴一遍？**

反应过来的那句话是本文最值钱的一句之一：

> **因为「在 context 里」和「在 context 的末尾」是两件完全不同的事。**
> 几十轮前的 TodoWrite 调用记录，在 attention 上已经被稀释了；
> 而贴在末尾的内容享受 **recency bias**（近期偏好）。

所以这个机制的真正目的不是存储，是**把目标重新推到注意力最高的位置**。

**验证这个判断的证据**：两个实现的提醒文本末尾都有同一句话——

| 实现 | 原文 |
| --- | --- |
| claude-code 🔬 | `Make sure that you NEVER mention this reminder to the user` |
| sid-code 🔬 | `请勿向用户提及本提醒` |

> **如果这只是一个「进度条同步」的 UX 机制，没必要藏着不让用户知道。
> 要求模型不提及，说明设计者把它定位成对模型的内部干预手段，而不是产品功能。**

于是 TodoWrite 的架构定位必须重写：

```
表面：模型主动调用工具 → 更新清单 → 用户看到进度

实质：harness 定期把剩余目标重新注入尾部 → 对抗注意力衰减
     工具调用只是让模型有机会「亲手写下」这份清单，从而更认可它
```

### 7.6 业界给这个手法起了名字

📄 这不是我们的独家发现。三处外部印证：

**印证一**（📄 Shrivu Shankar, *Building Multi-Agent Systems*）：

> Todos — This is a meta-tool the agent uses to effectively keep a persistent TODO list
> (often seeded by a planning agent). While this is great for the human-facing UX,
> **its primary function is to re-inject the remaining plan and goals into the end of
> the context window, where the model pays the most attention.**

「主要功能是把剩余计划重新注入上下文末尾」——和从源码推出的结论一致。

**印证二**（📄 一篇 Context Engineering 综述）把这个手法命名为
**recitation（复述）**，列为六大高影响技术之一：

> attention manipulation through periodic recitation of key objectives
> into the tail context every 5-7 steps

**三个实现的周期对照**（这个对照本身很有说服力）：

| 来源 | 周期 |
| --- | --- |
| 综述建议 📄 | 5-7 步 |
| claude-code TodoWrite 🔬 | 10 轮 |
| claude-code Plan Mode 🔬 | 5 轮（轻）/ 25 轮（重） |
| sid-code TodoWrite 🔬 | 8 轮 |

**数量级一致。** 这种独立收敛比任何单个数字都有说服力——
它说明「个位数到十几轮」是这个机制的有效区间，而不是某个人拍的。

### 7.7 ★ 一个真陷阱：怎么数「轮次」

这一节非常实用，因为**几乎所有基于「N 轮之后做 X」的机制都会踩这个坑**。

问题：「10 轮」里的「轮」是什么？至少有三个不同口径：

| 口径 | 数什么 | 典型倍数差 |
| --- | --- | --- |
| **消息条数** | 数组里的元素个数 | 最大 |
| **工具调用轮数** | 每次模型→工具→返回算一轮 | 中 |
| **人类交互轮数** | 用户真的说了一句话 | 最小 |

**三者可以差好几倍。** claude-code 的注释把这个坑说得很清楚
（🔬 `attachments.ts:1146-1151`）：

```ts
if (message?.type === 'user' && !message.isMeta && !hasToolResultContent(message.message.content)) {
  turnsSinceLastAttachment++
}
```

> the tool loop in query.ts calls getAttachmentMessages on **every tool round**,
> so counting assistant messages would fire the reminder **every 5 tool calls
> instead of every 5 human turns**.

必须排除两种伪装成 user 的消息：

1. **meta 消息**（harness 自己塞的）
2. **`tool_result` 消息**——⚠️ 这条最阴：**在 Anthropic / OpenAI 协议里，
   工具返回值都是以 user 角色回传的**。所以「数 user 消息」会把每次工具返回都算一轮。

不排除的后果：「每 5 轮」退化成「每 5 次工具调用」，**提醒频率暴涨**
（一轮里模型可能调 5 个工具，于是同一轮注入 5 次）。

**结论，这条值得抄进自己的代码规范**：

> **在 agent 里数「轮次」是个陷阱：消息条数 ≠ 工具调用轮数 ≠ 人类交互轮数。
> 三个口径差异巨大，选错了行为完全走偏。**

### 7.8 ★ sid-code 的一个改进：判定不要存状态，去扫历史

这一节讲一个非常漂亮的重构，它的价值超出 todo 这个话题。

**病灶**（🔬 `packages/core/src/query/todo-reminder-scan.ts:1-30` 的注释，
实测数据是 2026-08-01 的一个 60 轮停滞会话）：

```
旧实现把"该不该回注 todo 清单"押在 LoopState 的一串计数器上，再叠「逐字节去重 + 封顶 2 次」两道闸。

实测后果（60 轮停滞会话）：
  60 轮内注入轮次: [ 11 ]  共 1 次
  nagCount 最终 = 1 / cap 2  → 封顶根本没用上，dedup 先锁死

全网遥测同向：todo 通道累计只注入过 3 次 / 4 个会话。这条通道在现网基本不工作。
```

**两层病因，两个都很值得学**：

**病因一：去重把「该催」和「不该催」判反了。**

```
去重逻辑：reminder 文本跟上次一样 → 不重复注入（省 token）
文本什么时候一样？ → todos 内容没变的时候
todos 什么时候不变？ → 模型停滞、什么都没推进的时候
                      ↑
              而这恰恰是最需要催更的时刻
```

**去重是个通用的好优化，但它在这里把因果搞反了。**
「内容没变」在别处意味着「没有新信息」，在这里意味着「出问题了」。

**病因二：状态放错了位置。**

```
LoopState 由 createInitialLoopState() 在**每条用户消息**重建
     ↓
7 个 todo 计数器跨用户消息全部归零
     ↓
与对标「扫描全历史」的语义根本不等价
```

**修复方向**（这是重点）：

> 对标实现的节流判定**不存任何状态**，每轮倒序扫描消息历史现算。
> 这不是风格差异，是**正确性差异**：**消息历史是唯一事实源，而计数器是它的影子。**

两个白拿的好处：

| 好处 | 为什么 |
| --- | --- |
| **跨用户消息不失忆** | 历史不会因为用户又发了一句话就归零 |
| **压缩后自动重注** | 压缩把 `todo_write` 的 tool_use 块删掉后，扫描算出「距上次写清单很久了」→ 自动重注一次 |

第二条特别漂亮。旧实现要为此专门背一个 `todoReminderPendingAfterCompact` 补丁位，
而那个补丁位**要在 6 处 compact 调用点手工置位——漏一处就是清单永久消失**。

**一条可迁移的原则**：

> **能从事实源现算的东西，不要存成状态。**
> 存下来的那份是影子，它会跟事实源漂移，而且漂移**不报错**。
> 判据：如果你发现自己在给某个计数器打「压缩后要记得置位」这类补丁，
> 说明它本该是算出来的。

### 7.9 一处刻意的偏离，以及它为什么是对的

同一个文件里还记了一处**明知对标怎么做但选择不做**的地方
（🔬 `todo-reminder-scan.ts:38-53`）。这种记录本身就很有价值：

> 对标把 reminder 自己作为一条 attachment 消息**写进 conversation**，
> 于是「上次注入是哪轮」也记录在历史里。**本项目不这么做**，
> 因为 `reminder-inject.ts` 不变量 3（「注入产物只进发送副本、永不写回 ctxMgr」）
> 有三处实测事故背书 + 哨兵测试守卫：破坏它会同时引发
> ① TUI 泄漏内部文本 ② 压缩把工具列表当「用户最初的请求」③ reminder 在历史里逐轮累积。
>
> 对标能安全走那条路，是因为它有**独立的 attachment 消息类型** +
> `nullRenderingAttachments` 白名单；本项目的 `Message.role` **只有 `user | assistant`**，
> reminder 落历史就是一条真 user 消息，正是那三处事故的成因。

于是折中方案是：**只把「上次注入是哪轮」这一个标量交给 `SessionState`**
（跨用户消息持久），历史侧只扫真正属于历史的事实（`todo_write` 调用）。

> **拿到的非重置语义与对标等价，代价是一个标量，而不是一条会泄漏进 TUI 的消息。**

**这一节的教学价值有两层**：

1. **不能直接抄的原因常常是类型系统层面的**，不是能力层面的。
   claude-code 有第三种消息类型，sid-code 只有两种——**同一个设计在两个系统里安全性不同**。
2. **「刻意偏离」必须写下来，否则下一个人会「修复」它。**
   这跟 §4.5 的「决策记录」是同一个道理：没写下来的否决论证等于不存在。

### 7.10 本章自检

- [ ] TodoWrite 的三个反常现象，你能复述吗？各自说明了什么？
- [ ] 「在 context 里」和「在 context 末尾」的区别是什么？为什么它决定了这个机制的存在？
- [ ] `请勿向用户提及本提醒` 这句话为什么是定位的关键证据？
- [ ] 三种「轮次」口径，你能说出 `tool_result` 为什么最容易出错吗？
- [ ] 「去重把该催和不该催判反了」——这个形态在你自己的项目里有同构的例子吗？
- [ ] 「能从事实源现算的就不要存成状态」的判据是什么？

---
<a id="s8"></a>

## §8 三个不同的洞：注意力衰减 / 压缩擦除 / 状态过期

§7 讲了周期性重注入。但一个规划态里其实有**三个**机制在往上下文里塞东西：

```
① 每 5 轮的分档提醒          （§5.4）
② 压缩时注入 plan_file_reference（§4.6）
③ 重入规划态时的一次性引导     （§4.9）
```

源材料作者的第一反应是「这三个是同一件事做了三遍」。**这是误判。**
这一章讲清它们各自堵的是哪个洞——**因为如果你以为是重复，你会删掉两个，然后在生产里踩到。**

### 8.1 洞一：注意力衰减（attention dilution）

**机制**：约束和目标离得越远，权重越低。

| 项 | 内容 |
| --- | --- |
| **成因** | Transformer 的注意力分布 + 上下文变长（Lost in the Middle 📄） |
| **症状** | 模型没「忘」，只是那句话很轻。表现为：漏做、跑偏、忘了自己在规划态 |
| **对策** | **周期性重注入到尾部**（recitation） |
| **判据** | 它跟压缩**没关系**：即使一次压缩都没发生，长会话照样衰减 |

**这个洞的关键特征：它是连续的、渐进的。** 所以对策也是连续的（每 N 轮一次），
而不是事件触发的。

### 8.2 洞二：压缩擦除（Governance Decay）

**机制**：压缩器会把常驻约束当成过期文本丢掉。

📄 这个风险在 2026 年 6 月有了一个正式名字——**Governance Decay**（arXiv:2606.22528）：

> Governance decay is the progressive, silent loss of an agent's in-context governance ...
> as the agent's conversation history is compressed. ... compaction has been engineered
> for exactly one objective: **preserving task accuracy**. A standing policy is,
> from the summarizer's perspective, **old text that is not the current sub-goal,
> competing for a shrinking token budget.**

**这段话的核心洞察值得慢读一遍**：

```
压缩器的优化目标        =  任务连续性（模型压缩后还能接着干）
常驻约束（不许改文件）  =  「不是当前子目标的旧文本」
                            ↓
             在压缩器的价值函数里，它是应该被丢掉的那类
                            ↓
        摘要器会忠实记录「我做到第 7 步了」，但丢掉「我不许改文件」
```

**两者不是同一件事，也不能靠同一个机制解决**：

| | 洞一（衰减） | 洞二（压缩擦除） |
| --- | --- | --- |
| 时间特征 | **连续、渐进** | **离散、事件性**（压缩发生的那一刻） |
| 内容是否还在 | 在，只是权重低 | **不在了** |
| 对策 | 周期性重注入 | **在压缩边界主动注入** |
| 只做另一个的后果 | 压缩后约束彻底消失，下一次周期注入之前有一个**完全无约束的窗口** | 长会话中约束被稀释 |

**「完全无约束的窗口」这句话是重点。** 假设只有洞一的对策（每 5 轮注入一次），
压缩刚好发生在第 3 轮之后，那么第 4、5 轮模型是**在没有任何规划态约束的状态下**运行的。
论文甚至指出：**攻击者可以主动触发压缩来擦除安全约束。**

sid-code 在这个洞上有一处对应处理，而且是**「不受封顶管辖」的特例**
（🔬 `packages/core/src/query/loop.ts:1320-1321`）：

```ts
// afterCompact 旁路**不受封顶管辖**：压缩把清单从上下文里抹掉后若不强制重注，
// 清单会在模型视野里永久消失——那是信息丢失，不是催促噪音，两者不能共用预算。
```

**这句话把两个洞的区别说得比论文还清楚**：

> **「催促噪音」和「信息丢失」不能共用同一个预算。**

前者可以封顶（催了 N 次没用就停手），后者不能——因为它不是催促，是恢复。

### 8.3 洞三：状态过期（外置带来的新问题）

**机制**：见 §4.9。旧计划躺在文件里，模型看到就容易当成当前任务的依据。

| 项 | 内容 |
| --- | --- |
| **成因** | 状态外置（文件比会话活得久） |
| **症状** | 模型在一个**过期的前提**上继续工作。**它有信息，但信息是错的** |
| **对策** | 在**状态转移的那一刻**注入一次性引导，要求先判断相关性 |
| **判据** | 它是三个洞里唯一**由「解决方案」本身引入的** |

⚠️ 这个洞和前两个有一个本质区别：

```
洞一、洞二：信息「不够」（衰减了 / 被删了）→ 补
洞三：      信息「有但过期」                 → 必须先质疑再用
```

**所以对策的形态也不同：不是注入内容，是注入一条「怀疑指令」。**
claude-code 的原文是 `Do not assume the existing plan is relevant without evaluating it first.`

### 8.4 三个洞的总表（这张表值得记住）

| 洞 | 成因 | 症状 | 对策形态 | 触发方式 |
| --- | --- | --- | --- | --- |
| **① 注意力衰减** | 上下文变长 | 约束变轻，漏做/跑偏 | 分档重注入 | **周期性**（每 N 轮） |
| **② 压缩擦除** | 摘要器只优化任务连续性 | 约束彻底消失 | 压缩边界主动注入路径+全文 | **事件性**（压缩发生时） |
| **③ 状态过期** | 状态外置比会话活得久 | 在错误前提上工作 | 注入「先质疑」指令 | **事件性**（重入那一刻） |

**三个机制不是重复，各自堵一个不同的洞。**

**一条可迁移的诊断方法**：当你看到「同一件事好像做了好几遍」时，
问：**如果只留一个，另外两个防的场景会怎样？** 如果答不出具体场景，
那可能真是冗余；如果每个都能说出一个独立场景，那它们是不同的机制。

### 8.5 一个交叉验证：sid-code 的「双通道」曾经真的冗余过

上一节说「看起来重复的可能不是重复」。但**也真的会有重复**，
而且 sid-code 就踩过一次，修复过程很值得学（🔬 `packages/core/src/plan/prompt.ts:93-113`）：

```
此前 plan 的约束文案有**两条通道**：
  ① PERMISSION_MODE_DESCRIPTIONS.plan → system prompt 附件（每次 buildSystemPrompt 都带）
  ② buildPlanModeReminder            → user 侧 reminder（每轮，full/sparse 分档节流）

二者语义重叠但措辞已独立漂移（附件说"绝对不能/此约束覆盖你收到的所有其他指令"，
本函数说"不要进行任何编辑"），构成同一份约束两处说 + 事实源分裂。
```

**这是真冗余**，判据是：**它们防的是同一个洞（洞一），只是投递通道不同。**

修复方向是**删附件、保留 reminder 通道**，理由有两条，第二条很技术但很重要：

> 附件走 system prompt 动态区，在 **OpenAI 族会被 `openai.ts prependSystemMessage`
> 原样搬回 user 消息**——「放 system 不占 user turn」在本项目不成立；
> 而 reminder 是**每轮 pull 判定**，不需要任何「mode 切换即重建 system prompt」的 push 触发点
> （那条路径会**击穿全量静态前缀**，CC 实测占 10.2% cache_creation，正在反向迁移）。

两个知识点：

1. **「放进 system prompt」在多 provider 环境下不一定是「放进 system」。**
   OpenAI 族没有独立的 system 字段（或者 harness 为了兼容会搬位置），
   于是你以为的「system 约束」实际是一条 user 消息。
2. **动态改 system prompt 会击穿 prompt cache。** 前缀缓存要求
   **一个字节都不能变**，而 system prompt 在最前面——改它 = 整个前缀重算。
   实测占 10.2% 的 `cache_creation`。

⚠️ 而删附件之前必须做一件事，否则是**真实的安全回归**：

> 删附件前必须把它独有的强约束语义搬到这里……
> plan 与 acceptEdits / deny-write 等**权限模式**性质不同——后者由 `PermissionChecker`
> **代码硬拦**、模型看不到文案也拿不到多一个字节的权限；plan 是**行为模式**
> （「先规划再执行」无法用权限规则表达），**只能靠模型自觉**。
> 「此约束覆盖你收到的所有其他指令」是其中最强的一道越权防线，不能静默消失。

**这段区分极其重要，它回答了「为什么规划态需要 prompt 层的约束」**：

| 模式类型 | 例子 | 靠什么保证 | 模型看不到文案会怎样 |
| --- | --- | --- | --- |
| **权限模式** | `acceptEdits` / `deny-write` | 代码硬拦 | 无影响，一个字节的权限都拿不到 |
| **行为模式** | **plan**（先规划再执行） | **只能靠模型自觉** | **失效** |

「先规划再执行」这件事**无法用权限规则表达**——权限规则能说「不许写文件」，
但说不出「你应该先出方案再动手」。所以规划态是**权限约束 + 行为约束的混合体**，
两部分要用两种手段。

**这也是为什么 §6 那三层防线里第三层（prompt）不能省**：
它承载的不是「不许写文件」（那一层代码已经拦了），
而是「你现在的任务是出方案，不是干活」。

### 8.6 本章自检

- [ ] 三个洞你能各说出一个只有它才会出现的具体症状吗？
- [ ] 「完全无约束的窗口」是怎么产生的？只做周期注入为什么不够？
- [ ] 「催促噪音」和「信息丢失」为什么不能共用预算？
- [ ] 「放进 system prompt」为什么在多 provider 环境下不一定成立？
- [ ] 权限模式和行为模式的区别是什么？为什么行为模式必须靠 prompt？
- [ ] 判断「看起来重复的机制是否真冗余」的方法是什么？

---
<a id="s9"></a>

## §9 从扁平清单到任务图：多 agent 共享状态的真实成本

前面讲的都是**单个 agent** 的规划。这一章讲形态 E：
**多个 agent 要共享一份任务清单时会发生什么。**

八股文里这件事是一句话：「Multi-Agent 通过共享状态协作」。
落地是几百行加三个并发陷阱。

### 9.1 数据结构的升级：从清单到 DAG

扁平清单（形态 D）：

```ts
{ content: string, activeForm: string, status: "pending" | "in_progress" | "completed" }
```

任务图（形态 E，🔬 sid-code `packages/core/src/task/structured-task-store.ts:15-32`）：

```ts
export interface StructuredTask {
  id: string;                      // 自增数字 ID，如 "1" "2"
  subject: string;
  description: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
  owner?: string;                  // ★ 归属的 agent 名，空表示未认领
  blocks: string[];                // ★ 本任务完成后才能开始的下游任务 ID
  blockedBy: string[];             // ★ 必须先完成、否则本任务不能开始的上游任务 ID
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}
```

三个新增字段，每个对应一个新能力：

| 字段 | 新能力 | 新问题 |
| --- | --- | --- |
| `owner` | 任务可以被「认领」 | 两个 agent 同时认领怎么办（§9.3） |
| `blocks` / `blockedBy` | 任务有依赖顺序 | 成环怎么办（§9.2）、悬空边怎么办 |
| `metadata` | 可以按团队分区 | 分区串味怎么办（§9.5） |

### 9.2 为什么双向存边（而且必须同步维护）

`blocks` 和 `blockedBy` 是**同一条边的两个方向**。单向就够表达依赖关系了，为什么双向存？

**答案是查询效率**：

| 操作 | 需要查什么 | 单向存的话 |
| --- | --- | --- |
| 「我能不能开工」 | 查我的 `blockedBy` 是否全完成 | 需要**遍历所有任务**找谁 blocks 我 |
| 「删掉我之后要清理谁」 | 查我的 `blocks` | 需要遍历所有任务 |

**双向冗余存储换查询免遍历，是图存储的常规权衡。** 代价是一致性维护成本：

🔬 `structured-task-store.ts:121-133`（加边时**两端同时改**）：

```ts
function addDependencyEdge(blockerId: string, blockedId: string): string | undefined {
  const blocker = tasks.get(blockerId);
  const blocked = tasks.get(blockedId);
  if (!blocker) return `依赖任务 "${blockerId}" 不存在`;
  if (!blocked) return `依赖任务 "${blockedId}" 不存在`;
  if (wouldCreateCycle(blockerId, blockedId)) {
    return `添加依赖会导致循环依赖（${blockerId} ↔ ${blockedId}）`;
  }
  if (!blocker.blocks.includes(blockedId))     blocker.blocks.push(blockedId);
  if (!blocked.blockedBy.includes(blockerId))  blocked.blockedBy.push(blockerId);
}
```

🔬 `structured-task-store.ts:137-142`（删任务时**摘掉所有指向它的边**）：

```ts
function detachDependencies(id: string): void {
  for (const t of tasks.values()) {
    t.blocks     = t.blocks.filter((x) => x !== id);
    t.blockedBy  = t.blockedBy.filter((x) => x !== id);
  }
}
```

⚠️ **少了 `detachDependencies` 会发生什么？死锁。**

```
任务 #5 被删了
任务 #7 的 blockedBy 里还有 "#5"
     ↓
isTaskUnblocked(#7) 查 #5 → 找不到
     ↓
如果实现是「找不到 = 未完成」→ #7 永远不能开工 = 死锁
```

sid-code 在这里做了**双保险**（🔬 `structured-task-store.ts:186-191`）：

```ts
export function isTaskUnblocked(task: StructuredTask): boolean {
  return task.blockedBy.every((depId) => {
    const dep = tasks.get(depId);
    return !dep || dep.status === "completed";     // ← 「已不存在」也算解除阻塞
  });
}
```

**`!dep ||` 那半句就是双保险**：即使摘边漏了，找不到的上游也算解除阻塞。

⚠️ 这是一个值得讨论的权衡：**它把「死锁」换成了「可能提前开工」**。
前者是硬故障（agent 永久卡住），后者是软故障（依赖没真完成就开始了）。
**选后者是对的**——因为死锁不会自愈，而提前开工至少任务还在推进，
且真出问题会有报错。

### 9.3 成环检测：一个源材料里没有的东西

源材料（claude-code 侧）没有提成环检测。sid-code 有
（🔬 `structured-task-store.ts:102-118`）：

```ts
/**
 * 检测「若在 fromId → toId 之间加一条 blocks 边（from 完成后 to 才能开始）」是否成环。
 * 沿 blocks 方向从 toId 出发做 DFS，若能回到 fromId 说明成环。
 */
function wouldCreateCycle(fromId: string, toId: string): boolean {
  if (fromId === toId) return true;                 // 自环
  const visited = new Set<string>();
  const stack = [toId];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (cur === fromId) return true;
    if (visited.has(cur)) continue;
    visited.add(cur);
    const t = tasks.get(cur);
    if (t) stack.push(...t.blocks);
  }
  return false;
}
```

**为什么必须有这个**：环 = 死锁。

```
#1 blockedBy #2
#2 blockedBy #3
#3 blockedBy #1
     ↓
三个任务互相等，全部永远 pending，调度循环永不退出
```

⚠️ 而且这个死锁**不报错**——`hasUnfinishedTasks()` 一直返回 true，
调度循环一直转，看起来「还在干活」。**这是本文 §12 那类失效模式的又一个实例。**

注意两个实现细节：

1. **`if (fromId === toId) return true`** 单独处理自环——DFS 循环从 `toId` 出发，
   如果 `from === to`，第一次 pop 就命中，其实也能查出来，但显式写更清楚。
2. **「先校验后写，任一失败整体不生效」**（🔬 `structured-task-store.ts:156-168`）：
   ```ts
   if (input.addBlocks) {
     for (const toId of input.addBlocks) {
       const err = addDependencyEdge(id, toId);
       if (err) return { ok: false, error: err };     // ← 提前返回
     }
   }
   ```
   ⚠️ 这里其实有个微妙问题：注释说「任一失败整体不生效」，
   但代码是**边校验边写**的——如果 `addBlocks` 有三条边，第三条成环，
   前两条**已经写进去了**。要真做到「整体不生效」需要先全部校验再全部写，
   或者失败时回滚。**这是我在核验时注意到的一处注释与实现的细微不一致**，
   影响有限（多写了两条合法的边），但值得知道。

### 9.4 ★ 并发控制：两个实现走了完全不同的路

这一节是本章最值钱的部分，因为**两条路的差异揭示了「什么时候才真的需要锁」**。

**claude-code 的路：每任务一个 JSON 文件 + 文件锁**（🔬 2026-08-13 实读 `utils/tasks.ts`，862 行）

```ts
// Budget sized for ~10+ concurrent swarm agents: each critical section does
// readdir + N×readFile + writeFile (~50-100ms on slow disks), so the last
// caller in a 10-way race needs ~900ms. retries=30 gives ~2.6s total wait.
const LOCK_OPTIONS = {
  retries: { retries: 30, minTimeout: 5, maxTimeout: 100 },
}
```

⭐ **这段注释是我见过的最好的「魔法数字辩护」。** 它没有写
`retries: 30 // 重试30次`，而是给出了完整的推导链：

```
并发规模（10+ agents）→ 临界区耗时（50-100ms）→ 最坏等待（900ms）→ 预算（2.6s）
```

**任何人后来想改这个数字，都知道该重新算什么。**

> **魔法常量要附带它的推导过程，而不是它的字面含义。**

**sid-code 的路：进程内存 Map，无锁**（🔬 `structured-task-store.ts:35-36`）

```ts
/** 内存态清单：id → 任务。 */
const tasks = new Map<string, StructuredTask>();
let idCounter = 0;
```

认领任务就是一个普通的同步循环（🔬 `structured-task-store.ts:342-358`）：

```ts
export function claimNextUnblockedTask(owner, teamName?, opts?): StructuredTask | undefined {
  const pool = teamName ? getTeamTasks(teamName) : getAllStructuredTasks();
  for (const task of pool) {
    if (task.status !== "pending") continue;
    if (opts?.onlyUnassigned && isPreassignedTask(task)) continue;
    if (!isTaskUnblocked(task)) continue;
    task.owner = owner;                    // ← 认领
    task.status = "in_progress";
    task.updatedAt = Date.now();
    return task;
  }
  return undefined;
}
```

**没有锁，也不需要锁。** 为什么这是对的：

| | claude-code | sid-code |
| --- | --- | --- |
| agent 运行方式 | **独立进程**（swarm agents） | **同进程内的并发任务**（team 成员） |
| 共享状态位置 | 磁盘上的 JSON 文件 | 进程内存的 Map |
| 需要锁吗 | **需要**（跨进程） | **不需要**（JS 单线程，同步函数不会被打断） |

⭐ **这是一条极其重要的判据**：

> **锁的必要性由「共享者是否跨进程」决定，不由「有几个 agent 在跑」决定。**
> 同进程内 10 个并发 agent，只要状态在内存里、修改是同步的，
> **JS 的单线程模型天然给了你原子性**——`claimNextUnblockedTask` 从头跑到尾
> 中间不会有别的 agent 插进来。

⚠️ 但这个便利有**明确的边界，越界就必须加锁**：

1. **任何 `await` 都是一个断点。** 如果 `claimNextUnblockedTask` 里有 `await`
   （比如落盘），那么 await 前后状态可能已变——**必须加锁或改成原子操作**。
   现在它是**纯同步的**，这是刻意的。
2. **spawn 出去的独立子进程不共享这个 Map。** sid-code 的 `sub_agent` 有
   spawn 路径（独立子进程），那条路径上的 todo 是**各自独立的实例**
   （🔬 `tool-filter.ts` 注释：「每个进程内子代理在 `buildIsolatedToolRegistry`
   拿独立 `TodoWriteTool` 实例（spawn 路径本就是独立子进程），污染根因消除」）。
3. **落盘就重新引入了跨进程问题**，见下一节。

### 9.5 落盘：原子写 + 一个「分区串味」的真实 bug

sid-code 的团队任务确实要落盘（进程重启可恢复），
落盘逻辑在另一个文件（🔬 `packages/core/src/task/team-task-store.ts`）：

```ts
/**
 * 团队任务列表持久化（P2-2，对齐 CC ~/.claude/tasks/{team}/）
 * 原子写（temp + rename）防并发/崩溃时半写损坏。
 */
export function teamTasksPath(teamName: string, baseDir?: string): string {
  return join(base, ".sid-code", "tasks", safeName(teamName), "tasks.json");
}
```

两个细节：

1. **`safeName()` 防路径穿越**：`s.replace(/[^a-zA-Z0-9_-]/g, "_")`。
   团队名是用户可控的，不过滤就能写到任意路径。
2. **temp + rename 原子写**。`rename` 在同一文件系统内是原子的，
   所以读者永远看到「旧的完整版」或「新的完整版」，**不会看到半个文件**。
   ⚠️ 直接 `writeFileSync` 覆盖就没有这个保证——写到一半崩溃 = 文件损坏。

**然后是那个 bug**（🔬 `team-task-store.ts:31-36` 的注释）：

```
注意只落该团队的任务（按 metadata.team 过滤）——此前用全量快照，会把主会话
LLM 的 TODO 清单和其他团队的任务一起写进本团队文件，重启恢复时再灌回内存。
```

**形态很值得学**：

```
一个模块级单例 Map，同时服务两类消费方：
  ① 主会话 LLM 的 TODO 清单（无 team 标记）
  ② swarm 团队的共享任务列表（metadata.team = 团队名）
        ↓
  落盘时用了 serializeStructuredTasks()（全量）
        ↓
  团队 A 的文件里存了主会话的 todo + 团队 B 的任务
        ↓
  重启恢复 → 全灌回内存 → 主会话看到一堆不属于它的任务
```

修复是加一组带 `teamName` 的分区 API，并把全量 API 限定给主会话和测试
（🔬 `structured-task-store.ts:196-204` 的注释明写这个分工）。

> **一条可迁移的判据：单例 + 多消费方 = 必须有分区维度，
> 且「全量 API」必须明确写清它的合法调用方。**
> 否则「全量」这个词会让人以为它总是安全的。

### 9.6 claude-code 那两个 sid-code 没踩到的坑

因为 sid-code 走了内存路线，下面两个坑它天然不会遇到。
但**如果你要做跨进程的任务图，这两个必须知道**（🔬 claude-code, 2026-08-13 实读）。

**坑一：TOCTOU —— 锁的粒度由「不变量的作用域」决定**

`claimTask` 有两个变体，差别在锁的粒度：

```ts
if (options.checkAgentBusy) {
  return claimTaskWithBusyCheck(taskListId, taskId, claimantAgentId)  // 任务列表级锁
}
release = await lockfile.lock(taskPath, LOCK_OPTIONS)                  // 单任务级锁
```

为什么需要粗粒度的那个？注释说了：

> If true, checks whether the agent is already busy (owns other open tasks)
> before allowing the claim. This check is performed **atomically with the claim
> using a task-list-level lock to prevent TOCTOU race conditions.**

推理链：

```
不变量：「一个 agent 同时只干一件事」
检查它需要读**所有**任务文件（看这个 agent 有没有别的 open 任务）
     ↓
如果只锁住目标任务，读的过程中别的 agent 可能给它塞了新任务
     ↓
检查通过了，但等你真去认领时它已经忙了 —— TOCTOU
     ↓
所以必须升级到列表级锁
```

⭐ **这条判据非常容易搞错，值得背下来**：

> **锁的粒度由「不变量的作用域」决定，不由「要改的数据」决定。**
> 我要改的只是一个任务文件，但我要维护的不变量横跨整个列表，
> 所以锁必须覆盖整个列表。

**坑二：ID 复用（ABA 问题）**

重置任务列表时的逻辑（🔬 `tasks.ts:147-188`）：

```ts
// Find the current highest ID and save it to the high water mark file
const currentHighest = await findHighestTaskIdFromFiles(taskListId)
if (currentHighest > 0) {
  const existingMark = await readHighWaterMark(taskListId)
  if (currentHighest > existingMark) await writeHighWaterMark(taskListId, currentHighest)
}
// 然后删除所有任务文件
```

先把当前最大 ID 记到 `.highwatermark` 文件，再删所有任务。目的是**防止 ID 复用**：

```
重置后如果又从 1 开始编号
     ↓
某个还在运行的 agent 手里攥着旧的 #1 的引用
     ↓
它去更新 #1 → 改到了一个**完全不同的新任务**上
```

**这是分布式系统里的经典 ABA 问题，用单调递增水位线解决。**

⚠️ sid-code 的 `idCounter` 是模块级变量，`__clearStructuredTasks()` 会把它重置为 0
（🔬 `structured-task-store.ts:373-376`）。但那个函数的注释明写
**「测试辅助」**——生产路径不调它，所以不会遇到这个问题。
**这是「靠约定避开问题」，不是「解决了问题」**——如果哪天生产代码调了它，
这个坑会立刻出现。

### 9.7 一个 agent 的 todo 列表，为什么需要分布式系统的词汇

回到 §1.2 的意外三。现在答案清楚了：

```
单 agent 的 todo         → 一个数组，进程内存，零并发问题
同进程多 agent 的 todo    → 一个 Map + 分区维度 + 成环检测（sid-code）
跨进程多 agent 的 todo    → 每任务一文件 + 文件锁 + TOCTOU 处理 + 水位线（claude-code）
```

**每往右一格，都不是「功能更多」，是「引入了一整类新的失败模式」。**

| 层级 | 新增的失败模式 |
| --- | --- |
| 单 agent | — |
| 同进程多 agent | 成环死锁、悬空边、分区串味 |
| 跨进程多 agent | TOCTOU、ID 复用（ABA）、半写损坏、锁超时 |

**所以正确的设计顺序是：先确认你真的需要跨进程共享，再上锁。**
反过来（一上来就每任务一文件加锁）是过度工程，
而这个过度工程的代价是**你要维护那 862 行**。

一句可以直接说出口的话：

> 八股文里说「Multi-Agent 通过共享状态协作」，一句话；
> 落地是几百行加三类并发陷阱。而**这些陷阱有一半可以靠「不跨进程」直接绕开**——
> 判据是共享者是否在同一个进程里，不是有几个 agent。

### 9.8 本章自检

- [ ] 双向存边的收益和代价各是什么？漏了 `detachDependencies` 会怎样？
- [ ] `isTaskUnblocked` 里 `!dep ||` 那半句把什么故障换成了什么故障？为什么这个交换是对的？
- [ ] 成环死锁为什么「不报错」？调度循环会表现成什么样？
- [ ] 「锁的必要性由共享者是否跨进程决定」——JS 单线程给你的原子性有哪三个边界？
- [ ] 「锁的粒度由不变量的作用域决定」——你能重述那条 TOCTOU 推理链吗？
- [ ] 单例 + 多消费方的判据是什么？

---
<a id="s10"></a>

## §10 一条实测红线：只加前向压力，绝不加拦截

这一章只讲一件事，但它是本文里**最容易被新手做反**的一件。

一句话红线（🔬 `packages/core/src/tool/todo-write.ts:101-102`，原文照抄）：

> ⚠️ 红线：**只加前向压力，绝不加拦截**。见 `execute()` 里 `statusAdvisories` 上方那段
> 注释记录的硬拦截代价（模型白等 105.4 秒重交一份逐字相同的清单，纯自伤）。

### 10.1 事情是怎么发生的

`todo_write` 的 prompt 里有一条规范：**同一时刻只应有一个 `in_progress`**。

看起来很合理，于是有人（本项目自己）把它做成了**代码级校验**：
提交的清单里 `in_progress` 不等于 1 就返回 `isError: true`，**整次写入丢弃**。

实测代价（🔬 `todo-write.ts:584-586`）：

```
某会话提交 12 条清单、其中 4 条 in_progress 被拒
模型 105.4 秒后重试
两次提交的 content 数组**逐字相同**、只有 status 不同
     ↓
这次往返没有产生任何信息，纯属自伤
```

**「逐字相同」这四个字是全部关键。** 模型没有因为被拒而想出更好的清单，
它只是把同一份东西按你要的格式重排了一遍——**你花了 105.4 秒和一整轮的
token 买到了零信息。**

### 10.2 为什么这是「过度执行」：三条证据

修复注释给了三条证据（🔬 `todo-write.ts:571-582`），三条的性质各不相同，值得逐条看：

**证据一：对标实现只把它当建议。**

> claude-code 的 `TodoWriteTool.call()` 里**没有任何** `in_progress` 计数检查，
> 规范只写在提示词里且明确带 hedge：
> 「**Ideally** you should only have one todo as in_progress at a time」。
> 其 V2 的 `TaskUpdateTool` 同样不校验。

⭐ 注意 `Ideally` 这个词。**prompt 里的 hedge 词不是措辞软弱，是语义**——
它在说「这是偏好，不是约束」。**把带 hedge 的规范实现成硬约束，
是把偏好误读成了不变量。**

**证据二：自己的 UI 就按复数渲染。**

> 对标实现的 UI 按**复数**渲染 `in_progress`（`tasks.filter(t => t.status === 'in_progress')`），
> 我们的 `TodoPanel.tsx:287` 也一样——即多个 `in_progress` 在展示层根本不是问题。

⭐ **这条证据的形式很值得学：去看下游消费方能不能承受。**
如果 UI 早就按复数渲染了，那「只能有一个」这个约束在系统里就没有支撑它的理由。

**证据三：同一个系统的另一半给出了相反的硬约束。**

> 我们自己的 `structured-task-store`（多 agent 协作）本来就**允许多个 `in_progress` 并存**
> （每个 teammate 各占一个），**两套任务模型对同一语义给出相反的硬约束，本身就不自洽。**

⭐ 这条最锋利。**同一个概念在系统的两处有相反的规则，必有一处是错的。**
而在这里，多 agent 那一侧显然是对的（三个 agent 各干一件事，就是三个 `in_progress`）。

### 10.3 修复后的形态：接受写入 + 附上建议

```ts
// 现在的处理：**接受写入**，把规范作为提示附在成功输出里。
// 模型能看到纠正建议，但已经做的工作不会被丢掉。
const statusAdvisories: string[] = [];
if (!allDone) {
  const inProgressCount = todos.filter((t) => t.status === "in_progress").length;
  if (inProgressCount > 1) {
    statusAdvisories.push(
      `提示：当前有 ${inProgressCount} 个 in_progress。清单已按你提交的内容保存，` +
      `但建议同一时刻只保留 1 个 in_progress、其余置 pending——这样进度展示更清晰，` +
      `也更容易发现自己是否在并行摊开太多任务。`);
  } else if (inProgressCount === 0 && todos.length > 0) {
    const nextPending = todos.find((t) => t.status === "pending");
    const named = nextPending ? `（建议是「${nextPending.content}」）` : "";
    statusAdvisories.push(
      `提示：当前没有 in_progress 任务。清单已保存，但若你正要继续推进，` +
      `请先把下一项${named}置为 in_progress 再开始工作——这样进度才是实时可见的。`);
  }
}
```

**注意 `named` 那个变量。** 提示不是泛泛说「把下一项置为 in_progress」，
而是**点名到具体那一项**。理由写在注释里：

> 点名下一项（而非泛泛说「把下一项置为 `in_progress`」）：
> **弱模型对具体指令的执行率显著高于泛化提醒。**

### 10.4 一个方向搞反的守卫（同一处代码的第二次修复）

同一段代码在 2026-08-01 又修了一次，这次是**守卫的方向反了**
（🔬 `todo-write.ts:592-598`）：

```
旧条件是 `hasNonPending && inProgressCount === 0`，于是**全 pending** 的清单
（`hasNonPending === false`）两条分支都不触发、零提示。

守卫方向正好反了：「全 pending、无 in_progress」恰恰是**保证不会有实时更新的那个形态**
——没有"当前项"这个锚点，就没有"做完当前项要翻状态位"的触发时机。

旧守卫只在**已经开工**后才管，正好漏掉了最需要管的入口态。
本缺陷现场就是这样：18 项全 pending 首建后再没碰过清单。
```

**这个形态值得单独记住**：

```
守卫的意图： 提醒模型「该把某项置为 in_progress 了」
守卫的条件： 「已经有非 pending 项」（即已经开工）
                    ↓
   而最需要提醒的时刻是「刚建完清单、全是 pending」
                    ↓
   守卫恰好在那个时刻不触发
```

⚠️ 这和 §7.8 那个「去重把该催和不该催判反了」**是同一类错误**：
**守卫条件把「最需要它的场景」排除掉了。**

**诊断方法**（这条很实用）：写完一个「在 X 情况下提醒」的守卫后，
问一句：**最需要这个提醒的那个场景，X 成立吗？** 两次 bug 都是这一问没做。

### 10.5 那么什么时候可以拦截

红线是「绝不加拦截」，但**有一处例外，而且它就在同一个文件族里**——
`end_turn` 门禁（🔬 `packages/core/src/query/todo-reminder.ts:126-140`）：

```ts
export function buildTodoGateMessage(todos: TodoItem[], alreadyDelivered = false): string {
  const pending = unfinishedTodos(todos);
  return `<system-reminder>
检测到你试图结束本轮对话，但任务清单中仍有 ${pending.length} 项未完成：
${renderTodoLines(pending)}
请对照实际进展判断，二选一：
1. 若这些项**尚未真正做完**：继续完成，不要提前收尾；...
2. 若这些项**其实已经做完**（代码已改、构建/测试已过），只是忘了标记：直接用 todo_write 标为 completed 并如实收尾。...
</system-reminder>`;
}
```

**为什么这个可以拦，而 `in_progress` 校验不可以？** 三个判据：

| 判据 | `in_progress` 硬校验 | `end_turn` 门禁 |
| --- | --- | --- |
| **拦下来后，模型有新信息可用吗** | ❌ 没有。它只能重排格式 | ✅ 有。「还剩 3 项没做」是它可能真忘了的事实 |
| **模型能做的下一步是什么** | 重交一份逐字相同的清单 | 继续干活，或补标记 |
| **有上限吗** | 无（可以无限拒） | ✅ `MAX_TODO_GATE_RETRIES = 3` |

⭐ **第一条是决定性的判据**：

> **拦截只在「模型下一步能做出实质不同的行为」时才有价值。
> 如果拦下来它只能把同一件事重做一遍，那这次拦截的期望收益是负的。**

而且这个门禁做了三件很细的事，每件都在防一个具体误判：

**① 软续命而非硬拦**：最多 3 次（`MAX_TODO_GATE_RETRIES`），超限**放行**并如实列出未完成项
（🔬 `buildTodoGateExhaustedMessage`）：

```
⚠️ 仍有 N 项任务未完成（已达自动续推上限 3 次）：...
```

**不假装完成**——把未尽事项明确呈现给用户，而不是悄悄放过。

**② 误判自愈**：区分「真没做完」和「忘标记」
（🔬 `TODO_GATE_FORGOT_MARK_THRESHOLD`）：

```ts
/**
 * 续命耗尽时，若"有实质产出却不翻状态位"的次数 ≥ 此值，
 * 判定极可能是"任务已交付、只是忘标记"（而非真没做完），收尾不抛假警报。
 * 取 MAX_TODO_GATE_RETRIES：即**每一次**续命模型都在实质应答却始终不更新清单，
 * 才认定为"忘标记"——足够保守，不会把"真没做完但产出了点东西"误当忘标记放过。
 */
```

⭐ **注意「取 `MAX_TODO_GATE_RETRIES`」这个选择的论证方式**：
不是拍一个数，而是说「要求**每一次**续命都符合这个特征」——
这是一个**可以从语义推出来的阈值**，而不是调参调出来的。

而且它的收尾文案措辞极其小心（🔬 `buildTodoGateForgotMarkMessage`）：

```
已完成本轮工作并收尾。如清单仍有未勾选项，多为状态标记遗漏，可让我核对。
```

注释解释为什么这么写：

> 措辞**不断言"已完成"**（门禁读不到模型的心），只如实说"已放行收尾"。

**③ 防重复输出**：这是一个非常漂亮的二阶修复（🔬 `todo-reminder.ts:118-126`）：

```
缺陷复现（2026-07-30）：
模型输出完整报告后 end_turn，只是漏标最后一项
  → 本 gate 拦下
  → 模型正确判断出"报告已在上一轮完整输出，只是忘了标记"
  → 补标记
  → todo_write 全部完成分支回"请汇总执行结果并告知用户"（无条件祈使句）
  → 模型把整份报告**又打了一遍**

模型自己的判断是对的，是被 harness 的指令盖过去了。
所以修复要落在"harness 别在已交付时下汇总命令"，而不是指望模型顶住指令。
```

⭐ **最后那句话是本章最重要的一条设计原则**：

> **模型判断对了却被 harness 的指令盖过去 —— 修 harness，不要指望模型顶住指令。**

这也解释了为什么 `buildTodoGateMessage` 有一个 `alreadyDelivered` 参数：

```ts
const noRestate = alreadyDelivered
  ? `\n注意：你本轮**已经输出过实质结论**。补标记后请仅用一句话收尾，
     **不要重述/重新输出**已经给过用户的报告、结论或代码——重复输出对用户是纯噪音。`
  : "";
```

判据是一个字符数阈值（🔬 `TODO_GATE_PRODUCTIVE_TEXT_MIN = 200`），
注释说明了它的口径：

> 阈值与 output-stall 的语义对齐：远高于一句寒暄，约等于"至少写了一段实质文字"。

### 10.5b 顺带一个反例：无条件祈使句是个坑

上面那个 bug 的直接成因是一句「请汇总执行结果并告知用户」——
**一个无条件的祈使句**。

**问题在于「无条件」**：不管模型上一轮干了什么，它都会读到这句命令。
如果上一轮已经输出了完整报告，这句话就是在命令它**重复一遍**。

> **给模型的指令必须带条件，或者由 harness 按状态分流。
> 无条件祈使句会在你没想到的状态下被执行——而模型会照做，
> 因为它不知道你没想到那个状态。**

这跟 §7.8 那个「点名到具体项」是一体两面：
**分流的粒度越细，误命中的概率越低。**

### 10.6 三条压力通道的成本对照

sid-code 的注释里还有一段很实用的对照，讲**为什么工具返回值是最好的通道**
（🔬 `todo-write.ts:88-94`）：

> 为什么这是实时化的**主力通道**：它必达（不受任何节流 / 去重 / 封顶管辖，
> 每次调用 100% 送达）、**零边际 token 成本**（复用本就要回传的 `tool_result`）、
> **零幻觉风险**（它是工具返回值，弱模型不可能误判成"用户又发了半句话"）。
> 我们原先把实时化全押在"每 8 轮回注一次 reminder"那条最脆弱的通道上
> （实测 60 轮只注入 1 次），却空着这条最稳的。

整理成表：

| 通道 | 送达率 | 边际 token 成本 | 幻觉风险 | 时机可控性 |
| --- | --- | --- | --- | --- |
| **工具返回值**（`tool_result` 附加文本） | **100%**（必达） | **0**（本来就要回传） | **0**（模型知道这是工具输出） | 只能在调用时 |
| **system-reminder 注入** | 受节流/去重/封顶管辖，实测可低至 1/60 | 每次都要付 | ⚠️ 弱模型可能误认为是用户说的 | 任意轮次 |
| **system prompt** | 100% | 每轮都付 + **可能击穿 cache** | 低 | 只能全局，不能按状态分流 |

⭐ **结论很直接**：

> **能挂在工具返回值上的压力，不要放到 reminder 里。**
> 它必达、免费、无歧义；reminder 是给「工具没被调用」那个场景兜底的，
> 不该承担主力职责。

这也是一个更一般的设计判据的实例：**行为约束要挂在状态机的确定性转移点上，
而不是只写在 prompt 里。** claude-code 有一个同构的例子
（🔬 `TodoWriteTool.ts:76-86`）：

```ts
if (feature('VERIFICATION_AGENT') && ... &&
    !context.agentId &&          // 只对主线程
    allDone &&                   // 恰好在清空的这一刻
    todos.length >= 3 &&
    !todos.some(t => /verif/i.test(t.content))) {
  verificationNudgeNeeded = true
}
```

注释写得很直白：`Fires at the exact loop-exit moment where skips happen
("when the last task closed, the loop exited")`。

**这是在结构化的时间点上挂钩子**——不是靠 prompt 里写「记得验证」（那会被稀释），
而是识别出「关闭最后一个任务」这个**确定性事件**，在那一刻精确注入。
注入的话术还很硬：`You cannot self-assign PARTIAL by listing caveats in your
summary — only the verifier issues a verdict.`

> **Prompt 里的规则会随距离衰减，状态转移点不会。**

### 10.7 本章自检

- [ ] 「105.4 秒」那次往返为什么是「纯自伤」？关键词是哪四个字？
- [ ] 三条证据的性质各不相同，你能说出每条的「取证方法」吗？
      （提示：看对标 / 看下游消费方 / 看系统内部是否自洽）
- [ ] `Ideally` 这个 hedge 词为什么是语义而不是措辞？
- [ ] 「拦截可不可以做」的决定性判据是什么？
- [ ] 「守卫方向反了」这类 bug 的诊断方法是什么？
- [ ] 三条压力通道的成本对照里，为什么工具返回值的幻觉风险是 0？
- [ ] 「模型判断对了却被 harness 指令盖过去」——修哪一边？

---
<a id="s11"></a>

## §11 怎么证明规划真的生效了

前面十章讲了怎么做。这一章讲**怎么知道做对了**——而这一章的结论会让人有点不舒服。

### 11.0 先说清「机制指标」和「目标指标」的区别

这是全章的基础，也是最容易搞错的地方。

📄 claude-code 有一个规划 prompt 的 A/B 实验（`planModeV2.ts:64-95`），
注释里的这段话是我在整个源码里见过最成熟的工程表述：

```
* Primary: session-level Avg Cost — Opus output is 5× input price so cost is
*   an output-weighted proxy. planLengthChars on tengu_plan_exit is the
*   mechanism but NOT the goal — the cap arm could shrink the plan file while
*   increasing total output via write→count→edit cycles.
* Guardrail: feedback-bad rate, requests/session (too-thin plans →
*   more implementation iterations), tool error rate
```

拆开看，三层：

| 层 | 这个实验里是什么 | 作用 |
| --- | --- | --- |
| **主指标**（目标） | 会话级平均成本 | 你真正想优化的东西 |
| **机制指标** | 计划长度（`planLengthChars`） | 你直接操作的东西 |
| **护栏指标** | `feedback-bad` 率、`requests/session`、工具错误率 | 防止你为了主指标牺牲别的 |

⭐ **两层洞察，每一层都值钱：**

**洞察一：优化的机制指标不等于目标指标。**

```
「计划变短」是手段，「总成本下降」才是目标。
如果模型为了压到 40 行以内反复「写 → 数行数 → 删改」，
计划文件短了，但总输出反而涨了。
```

⚠️ **这个反直觉的失败模式被提前写进了注释**——不是事后复盘发现的，
是设计实验时就预判到的。这是「成熟」的具体含义。

**洞察二：护栏指标要包含反方向的风险。**

```
requests/session 涨了 → 说明计划省略了必要信息 → 实施阶段要来回折腾更多轮
```

**优化任何一个方向都要同时盯住反方向的代价。** 只盯「计划长度」，
你会得到一堆又短又没用的计划，然后在实施阶段把省下的成本连本带利还回去。

### 11.1 那个 A/B 实验本身：Prompt 工程可以是受控实验

📄 同一段注释给了基线数据：

```
* Baseline (control, 14d ending 2026-03-02, N=26.3M):
*   p50 4,906 chars | p90 11,617 | mean 6,207 | 82% Opus 4.6
*   Reject rate monotonic with size: 20% at <2K → 50% at 20K+
```

四个实验组的 prompt 措辞递进（📄 `messages.ts:3156-3188`），
这个递进本身就是很好的教材：

| 组 | 措辞 |
| --- | --- |
| **control** | `Begin with a **Context** section: explain why this change is being made` |
| **trim** | `One-line **Context**: what is being changed and why` |
| **cut** | `Do NOT write a Context or Background section. The user just told you what they want.` + `Most good plans are under 40 lines. Prose is a sign you are padding.` |
| **cap** | `**Hard limit: 40 lines.** If the plan is longer, delete prose — not file paths.` |

从「要写背景」一路走到「禁止写背景 + 硬限 40 行 + 超了就删散文不要删文件路径」。

⭐ **注意 cap 组那句 `delete prose — not file paths`。**
这是在**指定裁剪的优先级**——因为如果你只说「压到 40 行」，
模型可能会删掉最有价值的部分（具体文件路径），保留最没价值的部分（漂亮的散文）。

**这段实验的教学价值**：

> 它把「Prompt 工程」从玄学变成了**带基线、带主指标、带护栏、带失败模式假设的受控实验**。
> 如果面试官问「你怎么优化 prompt」，能说出「主指标 / 机制指标 / 护栏指标」
> 这个三层结构，比说「我们反复迭代测试」强一个量级。

### 11.2 那个数字的因果方向：一个必须小心的陷阱

```
计划长度 <2K  → 拒绝率 20%
计划长度 >20K → 拒绝率 50%
```

**很容易读成「把计划写短，用户就更容易批准」。这个推论不一定成立。**

三种可能的因果结构：

| # | 结构 | 含义 |
| --- | --- | --- |
| ① | 长 → 拒 | 长计划本身让人不想读，所以被拒 |
| ② | 难 → 长 且 难 → 拒 | **任务难**同时导致「计划长」和「容易被拒」（混淆变量） |
| ③ | 差 → 长 且 差 → 拒 | 模型没想清楚时会**堆散文**，同时方案也确实差 |

⚠️ **②③ 都是「计划长度只是症状，不是原因」。** 如果真相是 ②，
那么强制压短计划**只会让难任务的计划变得又短又差**，拒绝率不会降。

这就是为什么那个实验的主指标是**成本**而不是拒绝率——
成本是一个更难被这种混淆污染的下游指标。而拒绝率被放在……

实际上注释里 `feedback-bad rate` 是护栏。**这个安排本身就是对因果不确定性的正确处理**：
把因果关系可疑的指标放护栏（「别变差就行」），把可信的放主指标。

⭐ **一条可迁移的判据**：

> 看到一个漂亮的单调相关时，先问：**有没有第三个变量同时驱动两边？**
> 如果有，那这个相关不能当作干预依据。

### 11.3 ★ 一个复跑抓到的现状：保真度模块生产零调用

sid-code 有一个专门用来度量「规划是否生效」的设施——**计划保真度**
（ADR-028，🔬 `packages/core/src/plan/state.ts:19-45`）：

```ts
/** ADR-028: plan markdown 解析后的单步 */
export interface PlanStep {
  index: number;
  description: string;
  matchedActualIndices: number[];      // ← 这一步对应了哪几次实际工具调用
}

/** ADR-028: exit_plan_mode 后实际工具调用记录 */
export interface ActualToolCall {
  index: number;
  toolName: string;
  argsHash: string;
  matchedPlanStepIndex: number | null; // ← null = off-plan（计划里没这一步）
  timestamp: number;
}

/** ADR-028: fidelity 报告 (内核权威信号) */
export interface FidelityReport {
  planStepCount: number;
  actualToolCallCount: number;
  stepRatio: number;      // actual / plan
  matchedRatio: number;   // 对得上的 actual 占 plan 比例
  offPlanCount: number;   // 计划外的调用数
}
```

**这个设计非常好。** 它度量的正是「更准 / 一次做对」这个方向最难度量的东西：

```
stepRatio 远大于 1   → 实际干的步数远超计划 → 计划太粗，或执行在乱走
matchedRatio 低      → 干的事跟计划对不上   → 计划形同虚设
offPlanCount 高      → 大量计划外动作       → 要么计划漏了，要么模型跑偏
```

⚠️ **然后我复跑了它的调用点**（🔬 2026-08-31）：

```bash
$ grep -rn "getFidelityReport\|recordActualToolCall\|setPlanSteps" packages/ --include='*.ts' | grep -v node_modules
packages/core/src/plan/state.ts:302:  recordActualToolCall(...)     ← 定义
packages/core/src/plan/state.ts:320:  getFidelityReport(): ...      ← 定义
packages/core/tests/plan/fidelity.test.ts: ...（20+ 处）            ← 测试
# 生产代码调用点：0
```

**`recordActualToolCall` 没有任何生产调用点。** 没人喂数据给它，
所以 `actualToolCalls` 永远是空数组，`getFidelityReport()` 永远返回全零。

**这是本项目 CLAUDE.md 里那句话的又一次实例：**

> 新增防线时的验收判据：不是「build 过 + 单测过」，而是**「真实会话里被触发过」**
> ——防线自己成了它当初要消灭的死功能，这事已经发生过一次。

**注意这里的失效有多隐蔽**：

| 检查项 | 结果 |
| --- | --- |
| 代码在吗 | ✅ 在，445 行里有完整实现 |
| 类型对吗 | ✅ 对，`FidelityReport` 定义完备 |
| 单测过吗 | ✅ 过，`fidelity.test.ts` 有 20+ 处断言，全绿 |
| 机理讲得通吗 | ✅ 讲得通，`stepRatio`/`matchedRatio` 的口径都是对的 |
| **真实会话里跑过吗** | ❌ **一次都没有** |

**前四项全绿，第五项是 0。** 而只有第五项决定它有没有用。

⚠️ 对照 §5.7 那个 recovery hook——**同一个目录下的两个模块，
一个接线了一个没有**。所以：

> **每次引用一个「我们有 X 能力」之前，跑一次 grep 排除测试目录。
> 「代码在」和「在跑」是两件事，而它们的差别不会有任何报错告诉你。**

### 11.4 那么现在能测什么

既然保真度是零，规划的效果目前只能靠**间接指标**度量。
下面这张表分两栏，左边是本仓已有的（可直接复算），右边是缺口。

| 想回答的问题 | 已有的取数源 🔬 | 缺口 |
| --- | --- | --- |
| **规划有没有减少返工** | `metadata.total_steps`（轮数）、`maxUnchangedObservationRun`（空转段长） | 没有「用了 plan vs 没用 plan」的分组对照 |
| **规划本身贵不贵** | `usage-ledger.jsonl` + `metadata.total_cost_usd` | 没有按「规划阶段 / 执行阶段」拆分成本 |
| **计划被批准了吗** | `PlanModeManager.getRejectionCount()`（内存态） | ❌ **未落 trace**，出不了曲线 |
| **清单有没有被真的更新** | `todo_write` 调用在消息历史里可扫（§7.8 那个 scan 就是这么做的） | 没有派生成指标 |
| **越权防线触发过吗** | `scripts/defense-trigger-rate.ts` | 分母口径要小心（见下） |
| **计划保真度** | — | ❌ 设施在，**零调用**（§11.3） |

⚠️ **「防线触发率」这个指标有一个必须知道的分母陷阱**（本项目 CLAUDE.md 已记）：

```
分母 = 全量任务        → 信号被稀释到看不见（大部分任务根本不进规划态）
分母 = 审计核查类任务   → 才是有意义的口径
```

实测结果是「审计类任务 0% 触发」，读法是**「防线全在、调用全 0」**——
而这正是 §11.3 那个形态。

### 11.5 如果让你从零设计规划的度量，该测什么

这一节是我基于前面十章整理的一份清单，可以直接用在面试回答里。
**按「能不能立刻算出来」排序**，不按重要性——因为立刻能算的才会真被用上。

**第一档：不需要新埋点，现在就能算**

| 指标 | 定义 | 判据 |
| --- | --- | --- |
| **规划触发率** | 进入规划态的会话 ÷ 全部会话 | 太高说明简单任务也在规划（§2.6 的代价） |
| **计划长度分布** | p50 / p90 字符数 | 对照 📄 的 p50 4906 / p90 11617 |
| **拒绝率与拒绝次数分布** | 被拒 ÷ 提交 | ⚠️ 因果可疑，当护栏不当主指标（§11.2） |
| **轮数比** | 用了规划的会话 vs 没用的，`total_steps` 对比 | 这是「更少返工」最直接的代理 |

**第二档：需要少量埋点**

| 指标 | 需要什么 | 为什么值得 |
| --- | --- | --- |
| **规划/执行阶段成本拆分** | 在 usage 打点上加一个「阶段」标签 | 回答「规划本身贵不贵」，是所有成本讨论的前提 |
| **清单实时更新率** | 统计「相邻两次 `todo_write` 之间的轮数」分布 | 直接度量 §10 那套前向压力有没有用 |
| **计划保真度** | **把 `recordActualToolCall` 接上**（§11.3） | 设施已有，只差接线 |

**第三档：需要定义「成功」才能算**

| 指标 | 障碍 |
| --- | --- |
| **cost per successful task** | 必须先定义「任务成功」的信号。这是 2026 年公认最重要的成本指标，但也是最难落地的 |
| **一次做对率** | 同上。且要区分「模型做对」和「用户没提新要求」 |

⭐ **第三档那个障碍值得单独说**：

> 「任务成功」在 coding agent 上**没有免费的信号**。
> 用户不再提要求可能是满意，也可能是放弃了。
> ⚠️ 所以任何声称「我们的 agent 任务成功率 87%」的说法，
> **第一个该问的是「成功怎么定义的」**——而不是这个数字高不高。

而 §2.3 那个洞察在这里派上用场：**人在回路提供的批准/拒绝信号，
是这个领域里少有的、无需额外标注成本的高质量标签。**
一个有 26.3M 样本审批数据的团队，在这件事上有结构性优势
（📄 而这也是纯做 agent 框架、不做产品的团队拿不到的东西）。

### 11.6 本章自检

- [ ] 主指标 / 机制指标 / 护栏指标，你能各举一个规划场景的例子吗？
- [ ] 「cap 组可能让计划变短但总输出变多」这个失败模式的机制是什么？
- [ ] `delete prose — not file paths` 在防什么？
- [ ] 「长计划拒绝率高」有哪三种可能的因果结构？哪两种会让「压短计划」这个干预失效？
- [ ] `FidelityReport` 的三个指标各能诊断出什么问题？
- [ ] 「代码在」和「在跑」的差别怎么查？为什么这个差别不会报错？
- [ ] 「防线触发率」的分母该怎么定？定错了会得出什么结论？

---
<a id="s12"></a>

## §12 ★ 会「绿着坏掉」的失效模式

这一章是本文最值钱的部分。

### 12.0 先看这张表，它们的共同结构

前面十一章里散落着十四个具体故障。把它们排在一起，会看到一个共同点：

| # | 失效 | 症状 | 章节 |
| --- | --- | --- | --- |
| 1 | **防线零调用** | 代码在、单测绿、机理对，真实会话零触发 | §11.3 §5.7 |
| 2 | **正交维度塞进枚举** | `approve()` 后 `isPlanning()` 为 false，recovery 永不触发 | §5.3 |
| 3 | **两条正确规则相撞** | 路径验证排在 plan 放行之前，模型写不了计划文件 | §6.6 |
| 4 | **去重把该催和不该催判反** | 模型越停滞，提醒越静音 | §7.8 |
| 5 | **守卫方向反了** | 最需要提醒的入口态恰好不触发 | §10.4 |
| 6 | **状态放在会被重建的地方** | `LoopState` 每条用户消息重建，计数器全归零 | §7.8 |
| 7 | **轮次口径选错** | 「每 5 轮」退化成「每 5 次工具调用」 | §7.7 |
| 8 | **硬拦截买到零信息** | 模型重交逐字相同的清单，白烧 105.4 秒 | §10.1 |
| 9 | **无条件祈使句** | 「请汇总结果」让已交付的报告被重打一遍 | §10.5b |
| 10 | **成环死锁不报错** | 调度循环一直转，看起来在干活 | §9.3 |
| 11 | **悬空边死锁** | 上游任务被删，下游永远 pending | §9.2 |
| 12 | **单例多消费方串味** | 团队 A 的文件里存了主会话的 todo | §9.5 |
| 13 | **持久化引入过期** | 旧计划成了污染源，模型在错误前提上工作 | §4.9 §4.10 |
| 14 | **压缩擦除约束** | 压缩后到下次注入之间有一个完全无约束的窗口 | §8.2 |

⭐ **共同结构，这是本章要点破的东西：**

> **它们全都不报错。**
> 代码在、类型对、测试绿、文件在、机理讲得通，而**结论是错的**。

这不是巧合。agent 系统的绝大多数机制是「**注入一段文字，希望模型照做**」——
这条链上**没有任何一个环节会抛异常**：

```
注入没发生     → 不报错，只是模型没看到
注入发生了但太晚 → 不报错，模型已经跑偏了
模型看到了但没照做 → 不报错，这是概率问题
模型照做了但做错了 → 不报错，harness 不知道什么是对的
```

**所以「测试绿」在 agent harness 里的信息量比在传统软件里低得多。**
你需要的是**真实会话里的触发计数**。

### 12.1 五类根因

十四个故障可以归到五类根因，每类有一个专属的检查动作。

#### 根因 A：状态位置错了（#2 #6 #13）

**形态**：状态存在一个「生命周期比它的语义短」或「比它的语义长」的地方。

| 故障 | 状态放在哪 | 语义要求 | 错在哪 |
| --- | --- | --- | --- |
| #6 | `LoopState`（每条用户消息重建） | 跨用户消息持久 | **太短** |
| #2 | 三态枚举（approve 后回 inactive） | 执行阶段要能被识别 | 维度错了 |
| #13 | 磁盘文件（比会话活得久） | 只在本任务内有效 | **太长** |

⭐ **检查动作**：对每个状态问两句话——

1. **它什么时候被重建/清零？** 这个时机和它的语义边界一致吗？
2. **它什么时候被销毁？** 如果永不销毁，谁负责判断它是否过期？

#### 根因 B：判据方向反了（#4 #5）

**形态**：守卫/优化的条件恰好在「最需要它的场景」不成立。

```
#4：去重条件 = 「文本没变」   最需要催更的场景 = 模型停滞 = 文本不变 → 静音
#5：守卫条件 = 「已经开工」   最需要提醒的场景 = 刚建清单全 pending → 不触发
```

⭐ **检查动作**（这条最实用，两次 bug 都是它没做）：

> 写完一个「在 X 情况下做 Y」的条件后，**举出最需要 Y 的那个场景，
> 检查 X 在那个场景里成立吗。**

#### 根因 C：口径没写死（#7，以及 §11.4 那个分母）

**形态**：一个量有多个合理口径，代码里选了一个，文档/使用者以为是另一个。

| 量 | 可能的口径 | 差异 |
| --- | --- | --- |
| 「轮次」 | 消息条数 / 工具调用轮 / 人类交互轮 | 可以差 5 倍 |
| 「防线触发率」的分母 | 全量任务 / 相关类型任务 | 信号被稀释到看不见 |
| 「计划步骤数」 | 所有列表项 / 仅顶层项 | sid-code 明确选了后者（🔬 跳过缩进） |

⭐ **检查动作**：任何进入指标或阈值的量，**在注释里写死它的口径 + 为什么是这个口径**。
`TURNS_SINCE_WRITE: 8` 后面那句「弱模型记忆更短，比对标的 10 略低」就是范本。

#### 根因 D：优先级链上被抢先（#3，以及 §6.6 的两个逃逸阀）

**形态**：一条有顺序的判定链上，你的规则前面还有别人的规则。

⭐ **检查动作**：对任何「X 模式下强制 Y」的论断，问：
**它在链上第几步？前面有几步能命中同一个请求？**

**这一类特别容易在写文档时说错**——很容易写成「plan 模式强制只读」，
而真实情况是「plan 模式在没有更高优先级规则命中时强制只读」。

#### 根因 E：没有触发证据（#1，以及所有「机制指标 ≠ 目标指标」的情形）

**形态**：功能全在，从未被执行过。

⭐ **检查动作**（本项目已把它写成验收判据）：

> 新增防线的验收标准不是「build 过 + 单测过」，是**「真实会话里被触发过」**。

**最小的落地动作**是一条命令（附录 A-3 有完整版）：

```bash
grep -rn "<你的函数名>" packages/ --include='*.ts' | grep -v node_modules | grep -v '/tests/'
```

**排除测试目录之后还有命中吗？** 没有 = 这个能力目前不存在，
不管它的代码有多完整。

### 12.2 三个「看起来是模型的问题，其实是 harness 的问题」

这一节单独拉出来，因为它是最容易归因错的一类。**归因错的代价是：
你会去调 prompt、换模型，而真正的 bug 一直在。**

| 现象 | 直觉归因 | 真实根因 |
| --- | --- | --- |
| 模型不用 todo 清单（覆盖率 11.3%） | 模型不听话 | **清单从不回注**，模型看不到它（§2.2） |
| 模型反复调 `exit_plan_mode`（失败率 46.9%） | 模型有循环倾向 | **报错不含正确指引**，且被循环检测豁免（§2.4） |
| 模型把报告打了两遍 | 模型话多 | **harness 下了无条件祈使句**（§10.5b） |

⭐ 第三条最锋利，值得把原话再贴一次（🔬 `todo-reminder.ts:124-126`）：

> **模型自己的判断是对的，是被 harness 的指令盖过去了。**
> 所以修复要落在「harness 别在已交付时下汇总命令」，而不是指望模型顶住指令。

**一条诊断纪律**：

> 看到「模型行为不符合预期」时，先问三个问题再改 prompt：
> ① 相关信息在它的上下文里吗（在哪个位置）？
> ② harness 有没有给它相互冲突的指令？
> ③ 它想做对的时候，工具/权限层让它做吗？
>
> **三个都排除了，才轮到「这是模型能力问题」。**

第 ③ 条有一个很好的实例（🔬 `permission/checker.ts:226-233`）：
假设登记表的两个工具本来是纯内存操作，但**不在 `READ_ONLY_TOOLS` 里**，
于是在无头模式下**权限层直接拒**——

> 实测 11 次 ON 臂运行全部收到「权限拒绝: 非交互模式」，
> 假设机制在无头/评测/CI 场景**完全失效且无任何报错**，只在日志里留一行。
> 这也让「防线零触发」类排查**极易误判成模型不调工具**，而真因是权限层拦死。

**「极易误判成模型不调工具」**——这就是归因错的具体形态。

### 12.3 两个专属于「规划」的失效模式

前面的根因是通用的。有两个是规划这个话题特有的，值得单独记。

**特有失效一：方案漂移（plan drift）**

```
第 1 轮规划：决定「跳过 X，因为依赖 Y 还没就绪」  ← 有推理过程
写进计划文件的：「（没有 X）」                    ← 只有结果
第 2 轮（或执行阶段）的模型看到：计划里没有 X
它的合理推断：「计划漏了 X，我补上」
                ↓
        方案漂移，且它觉得自己在帮忙
```

**这不是模型的错。** 它拿到的信息确实支持这个推断。
对策见 §4.5 的「决策记录」小节——**把「为什么不做」写下来**。

⭐ 一句总结：

> **计划文件记录「做什么」是不够的，必须记录「不做什么，以及为什么」。
> 否则下一轮的自己会好心地把你否决掉的东西加回来。**

**特有失效二：规划态的空转（planning loop）**

模型在规划态里反复探索，迟迟不提交计划。三个成因：

| 成因 | 表现 | 对策 |
| --- | --- | --- |
| 没有「够了」的判据 | 一直读文件，从不写计划 | sparse 档提醒里那句「**不要反复探索或过度分析**——目标是尽快拿出可执行的方案」（🔬 `prompt.ts:120`） |
| 用户已给方案却还在重写 | 把用户的文档重新论述一遍 | 进入引导里那句「不必从零重写计划……不要为了'走流程'而重复用户已写清楚的内容」（🔬 `prompt.ts:29-31`） |
| 反复被拒 | 每次微调措辞再提交 | 拒绝上限 5 次强制退出（§5.2） |

⚠️ **但这里有一个必须知道的现状**：规划相关的工具**全部在循环检测的豁免名单里**
（🔬 `packages/core/src/agent/loop-detection.ts:468-486`）：

```ts
export const EXEMPT_TOOLS = new Set([
  "sub_agent", "task_output", "task_stop", "send_message",
  "todo_write", "enter_plan_mode", "exit_plan_mode",
  "bg_task_list", "bg_task_get",
  "task_create", "task_update", "task_list", "task_get",
  "team_message",
]);
```

**而且循环检测本身默认关闭**（🔬 `loop-detection.ts:528-534`）：

```ts
/** 循环检测是否已禁用（默认全局关闭对齐 CC，仅 SID_ENABLE_LOOP_DETECTION=1 可显式开启） */
private _disabled = false;
constructor(...) { if (!isLoopDetectionEnabled()) { this._disabled = true; ... return; } }
```

**所以 §2.4 那个 `exit_plan_mode` 空转是双重豁免的**：
① 循环检测默认关 ② 即便开了，这个工具也在豁免名单里。

**这解释了为什么那个修复走的是「幂等 + 错误信息即 prompt」而不是「让循环检测拦下它」**
——后一条路在架构上是通的，但需要先改两个默认值，而每一个都有它自己的理由。

⭐ 顺带看这个豁免名单自己的一次收窄，形态非常典型
（🔬 `loop-detection.ts:490-517`）：

```
这三个工具原本的豁免理由是"连续查询**不同**后台任务是正当轮询"——**理由本身成立**。
但实现是 `EXEMPT_TOOLS.has(name) → return false`，于是：入参完全相同（`{}`）、
返回体除时间戳外无变化的**49 次**调用同样被放过（实测占全部工具调用 18.8%，间隔约 5.7s）。

13:51:59  <progress tools="17" tokens="169174">  last_activity: read ink.d.ts
13:52:03  <progress tools="17" tokens="169174">  last_activity: read ink.d.ts   ← 无变化
13:52:08  <progress tools="17" tokens="169174">  last_activity: read ink.d.ts   ← 无变化
```

修复是把无条件豁免收窄成**「入参不同才豁免」**。

> ⭐ **豁免的语义前提正确，不代表实现的粒度正确。**
> 「连续查询不同任务是正当的」是对的，但代码写的是「这个工具一律放过」——
> **前者是有条件的，后者是无条件的，中间那个条件就是 bug 的藏身处。**

### 12.4 一个自检清单：交付前跑一遍

把前面所有检查动作压成一张清单。**这是我认为这份文档最实用的一页。**

**状态类**

- [ ] 每个新状态：它什么时候重建/清零？和它的语义边界一致吗？
- [ ] 每个持久化状态：谁负责判断它过期？（§4.9）
- [ ] 想加新状态时：它在原有维度上的取值是什么？如果和已有状态一样，**它是正交维度**（§5.3）

**判据类**

- [ ] 每个条件：**举出最需要它的场景，检查条件在那里成立吗**（§10.4）
- [ ] 每个「去重 / 封顶」优化：它会不会在故障时静音？（§7.8）
- [ ] 「催促噪音」和「信息丢失」用的是同一个预算吗？（§8.2）

**口径类**

- [ ] 每个「N 轮」：N 数的是哪种轮？注释写了吗？（§7.7）
- [ ] 每个比率：分母写死了吗？（§11.4）
- [ ] 每个魔法常量：注释写的是**推导过程**还是字面含义？（§9.4）

**优先级类**

- [ ] 每条「X 模式下强制 Y」：它在判定链第几步？前面有谁能抢？（§6.6）
- [ ] 每个能力剥离：等价替代路径枚举完了吗？（§6.3）

**触发证据类**

- [ ] 每个新机制：`grep` 排除测试目录后还有命中吗？（§12.1-E）
- [ ] 每个新机制：真实会话里触发过吗？触发计数在哪看？
- [ ] 每个「我们有 X 能力」的表述：引用前跑过上面那条 grep 吗？

**拦截类**

- [ ] 每个拦截：拦下来后模型有新信息可用吗？（§10.5）
- [ ] 每个拦截：有上限吗？超限后是「报错」还是「换一条路」？（§5.2）

**指令类**

- [ ] 每个给模型的祈使句：是无条件的吗？在哪些状态下它会说错话？（§10.5b）
- [ ] 压力能挂在工具返回值上吗？（比 reminder 必达且免费，§10.6）

### 12.5 本章自检

- [ ] 十四个失效模式的共同结构是什么？为什么「测试绿」在这里信息量低？
- [ ] 五类根因你能各说出一个专属的检查动作吗？
- [ ] 「看起来是模型的问题」的三个排除步骤是什么？
- [ ] 方案漂移的信息论成因是什么？为什么模型觉得自己在帮忙？
- [ ] 「豁免的语义前提正确 ≠ 实现的粒度正确」——你能重述那个 49 次轮询的例子吗？

---
<a id="s13"></a>

## §13 两个实现的横向对照

这一章把 claude-code 和 sid-code 放在一起。**目的不是评分，是看清每个差异背后在赌什么**
——因为面试里真正加分的是「我知道我们的选择放弃了什么」。

⚠️ 口径提醒：claude-code 侧全部是 📄 **2026-08-13 的实读转述，本文未复跑**；
sid-code 侧是 🔬 **2026-08-31 亲手复跑**。两侧时间差 18 天，且 claude-code 每周在变。

### 13.1 能力矩阵

| 能力 | claude-code 📄 | sid-code 🔬 | 差异在赌什么 |
| --- | --- | --- | --- |
| **规划态状态机** | 有（含 V2 实验分支） | 有（三态 + `executing` 正交标志） | — |
| **计划文件持久化** | ✅ `utils/plans.ts` 397 行 | ✅ `plan/state.ts` + `slug.ts` | — |
| **计划文件命名** | 随机词 slug（`brisk-otter.md`） | **项目/时间-主题**（`sid-code/20260803-1505-xxx.md`） | sid-code 赌「用户会按项目翻历史」，代价是要跑 git + sanitize |
| **跨会话恢复** | ✅ 三级降级链 | ❌ **无** | sid-code 赌「只跑本地，文件系统可靠」。上云端必须补 |
| **fork 语义** | ✅ 新 slug + copyFile | ❌ 无 | 同上 |
| **压缩边界注入计划** | ✅ `plan_file_reference` | ⚠️ 未见等价物（见 13.4） | — |
| **重入规划态的过期引导** | ✅ 一次性 `plan_mode_reentry` | ❌ 未见 | sid-code 有 §4.10 那 184 个孤儿文件，这个洞是真实的 |
| **分档提醒** | ✅ 5 轮轻 / 25 轮重（两个计数器） | ✅ 5 轮一次 full（单计数器 `reminderTurn % 5`） | sid-code 更简单：每轮都发，只分档；CC 是「隔轮发 + 分档」 |
| **拒绝上限** | 未见记录 | ✅ 5 次强制退出 | — |
| **拒绝反馈回传模型** | ✅ `planWasEdited` 标记 | ✅ 拒绝次数 + 用户意见文本 | 两种不同的信号：CC 传「被改过」，sid 传「被拒几次 + 为什么」 |
| **规划态权限强制** | prompt 层 + 工具剥离 | ✅ **权限层代码级**（`checkPlanMode`） | sid-code 赌弱模型不遵守 prompt，所以往下压到代码层 |
| **规划态给 bash 吗** | ✅ 给（只读白名单 + 绕道封堵） | ❌ **不给**（不在 `READ_ONLY_TOOLS`） | 见 §6.5，这是本表最重要的一格 |
| **计划文件写入放行** | — | ✅ Step 3.5 提前放行 + 精确路径匹配 | 因为计划文件在工作区外，见 §6.6 |
| **进度清单（todo）** | ✅ TodoWrite + V2 TaskUpdate | ✅ `todo_write` | — |
| **周期性回注** | ✅ 10 轮 / 10 轮 | ✅ **8 轮 / 8 轮**（弱模型阈值更低） | — |
| **回注判定方式** | 扫消息历史（无状态） | ✅ 扫消息历史 + 一个标量 | sid-code 刻意偏离，理由见 §7.9 |
| **工具返回值里的前向压力** | 一句无状态套话 | ✅ **按清单状态分流 + 点名下一项** | sid-code 赌「弱模型对具体指令执行率更高」 |
| **`end_turn` 完成度门禁** | ✅ stopHooks | ✅ 3 次软续命 + 误判自愈 + 防重复输出 | sid-code 这块比对标细，因为踩过三次 |
| **任务图（DAG）** | ✅ 每任务一文件 + 文件锁 + 水位线（862 行） | ✅ 内存 Map + 成环检测 + 团队分区落盘 | **锁的必要性由跨进程决定**，见 §9.4 |
| **计划保真度度量** | ✅ `VerifyPlanExecutionTool` | ⚠️ **设施在，生产零调用**（§11.3） | — |
| **规划 prompt A/B 实验** | ✅ 4 臂，N=26.3M | ❌ 无 | 需要产品规模的流量，这是结构性差异 |
| **子代理不能进规划态** | ✅ `if (context.agentId) throw` | ✅ `if (inp?._agentId)` 拦截 | — |
| **规划子代理** | ✅ planAgent（给只读 bash，`omitClaudeMd`） | ✅ `plan` 类型（白名单**不含 bash**） | 同 §6.5 那格 |

### 13.2 三个「sid-code 更细」的地方

不是所有差异都是 sid-code 落后。有三处它明显更细，而且**原因都是踩过**：

**① `end_turn` 门禁的误判自愈（§10.5）**

claude-code 的 stopHooks 会拦，但 sid-code 多了三层：软续命上限、
「忘标记 vs 真没做完」的判别、以及「已交付就别重述」的抑制。
**三层都对应一次实测事故**，包括那个「报告被打两遍」的二阶 bug。

**② 前向压力的分流（§10.3）**

对标是一句不看清单内容的套话（`Ensure that you continue to use the todo list…`），
sid-code 按清单状态分流并**点名到具体那一项**。
理由（🔬 `todo-write.ts:96-99`）：

> 弱模型（本缺陷现场是 `glm-5.2`）记忆更短、对具体指令的执行率显著高于泛化提醒
> ——同一理由下 `TURNS_SINCE_WRITE` 也定得比对标的 10 更低（8）。

**③ 权限层的代码级强制（§6.5）**

claude-code 的规划态约束主要在 prompt + 工具剥离；
sid-code 在 `PermissionChecker` 里有一个专门的 `checkPlanMode` 分支。
**这是同一个目标的两种硬度。**

⭐ 三处的共同点值得点破：

> **它们全部指向同一个约束：sid-code 要在弱模型上跑。**
> 弱模型的指令遵循率更低、工作记忆更短，
> 于是所有「靠模型自觉」的机制都要往「靠 harness 强制」的方向压一格。

这是一个很好的面试回答骨架：**不是「我们做得更好」，是「我们的目标模型不同，
所以我们把同一条约束放在了更低的层」。**

### 13.3 四个「claude-code 有而 sid-code 没有」的地方

| 缺口 | 影响 | 补的条件 |
| --- | --- | --- |
| **跨会话恢复 + fork** | 目前无影响（本地文件系统可靠） | **上云端容器环境时必须补** |
| **重入规划态的过期引导** | 真实存在（§4.10 那 184 个孤儿文件） | 成本低，应该补 |
| **规划 prompt A/B** | 无法量化 prompt 改动的效果 | 需要产品级流量，短期补不了 |
| **计划保真度接线** | 「规划有没有生效」目前测不了 | **设施已有，只差接线**，性价比最高 |

⭐ **注意第一行和第二行的区别，这是本节的教学点**：

> **「缺口」和「缺陷」不是一回事。**
> 判据是：**当前部署环境的假设成立吗？**
>
> - 跨会话恢复：本地跑，假设成立 → **是缺口，不是缺陷**
> - 重入过期引导：184 个孤儿文件已经在那了 → **是缺陷**

面试里能做出这个区分，比列一堆「我们还差 XX」强得多。

### 13.4 一处我无法确认的地方（如实标注）

⚠️ 我复跑时没有在 sid-code 找到「压缩边界主动注入计划文件」的等价物：

```bash
$ grep -rn "plan" packages/core/src/context/*.ts | grep -iE "compact|preserve|保留"
packages/core/src/context/manager.ts:1918:  # 只有一处提及，且是在讲保留段的消息角色前提
```

**但我不能断言它不存在**——sid-code 的压缩保留逻辑分散在
`context/manager.ts`（约 2000+ 行）和 reminder 注入链上，
而 §8.2 提到 `query/loop.ts:1320` 有一个「afterCompact 旁路不受封顶管辖」的机制
——**那个是 todo 清单的压缩后重注，不是计划文件的**。

**所以准确的表述是**：todo 清单有压缩后重注（🔬 已确认），
计划文件的压缩后重注**我没找到，也没有证据说它一定没有**。

⭐ 把这一节留在正文里，是因为它示范了本文开头那条纪律：

> **「我没找到」和「它不存在」是两句不同的话。**
> 写文档时把前者写成后者，是本文 §12 那类失效在文档层的等价物
> ——**它同样不报错，而且会一直被引用下去。**

### 13.5 一张「谁该抄谁」的表

如果你在做自己的 agent，下面是我的建议顺序（按性价比）：

| 优先级 | 抄什么 | 从哪抄 | 为什么优先 |
| --- | --- | --- | --- |
| **P0** | 计划存文件，不存消息 | 两边都是 | 一切的基础，不做这个后面全白搭 |
| **P0** | 周期性回注清单到尾部 | 两边都是 | 长任务遗漏的唯一有效对策 |
| **P0** | 判定扫历史而不存计数器 | sid-code §7.8 | 免费拿到「压缩后自动重注」 |
| **P1** | 工具返回值挂前向压力 | sid-code §10.6 | 必达 + 免费 + 无幻觉 |
| **P1** | 权限层代码级强制只读 | sid-code §6.5 | 弱模型上唯一可靠的越权防线 |
| **P1** | 错误信息即 prompt（幂等 + 给下一步） | sid-code §2.4 | 消灭空转，改动量极小 |
| **P1** | 分档提醒 | 两边都是 | 成本/效果比最好的注入策略 |
| **P2** | 决策记录小节 | sid-code §4.5 | 防方案漂移，纯 prompt 改动 |
| **P2** | `end_turn` 完成度门禁 | sid-code §10.5 | 但**必须带上限 + 误判自愈**，否则会造新 bug |
| **P2** | 压缩边界注入计划 | claude-code §4.6 | 堵住「无约束窗口」 |
| **P3** | 任务图 + 成环检测 | sid-code §9 | **只在真需要多 agent 时**做 |
| **P3** | 文件锁 + 水位线 | claude-code §9.6 | **只在真需要跨进程时**做 |
| **P3** | 跨会话恢复三级链 | claude-code §4.7 | 只在部署环境不保证文件持久时做 |

⚠️ **P3 那三行的共同点：它们都是「先确认需求成立」再做的。**
反过来做就是过度工程，而过度工程的代价是那 862 行你要一直维护。

### 13.6 本章自检

- [ ] sid-code 三处「更细」的共同原因是什么？
- [ ] 「缺口」和「缺陷」的判据是什么？各举一例。
- [ ] 「我没找到」和「它不存在」的区别为什么重要？
- [ ] P3 那三项的共同前提是什么？

---
<a id="s14"></a>

## §15 动手：从零实现一个 mini plan mode

这一章给一条五阶段路线。**每个阶段都能独立跑起来、独立验证**，
且每个阶段末尾都标了「这一步会撞到的坑」——那些坑前面各章都讲过，
这里是让你在写代码时按顺序遇到它们。

前提假设：你已经有一个最小 agent 循环（模型 + 几个工具 + while 循环）。

### 15.1 阶段一：一个只读模式（半天）

**目标**：加一个 `plan` 模式，开启后只准读不准写。

**做三件事**：

```
① 一个模式变量：mode: "default" | "plan"
② 权限检查函数里加一个分支：mode === "plan" 时，只放行读工具白名单
③ 一个切换入口（斜杠命令或快捷键）
```

**白名单从最小开始**：`read` / `grep` / `glob` / `ls`。

⚠️ **这一步会撞到的坑**：

1. **别把 bash 放进白名单**（§6.3）。要放的话，你必须同时封堵
   重定向、`/tmp`、heredoc、`| tee`——而这层只能靠 prompt，是软的。
   第一版建议直接不给。
2. **写死一个「这是第几步」的意识**（§6.6）。你的 plan 分支在权限链的哪一步？
   前面有 deny 规则、路径验证吗？它们会不会抢在你之前？

**怎么验证**：进入 plan 模式，让模型改一个文件。**看到拒绝日志才算通过。**
⚠️ 不要用「模型没有改文件」当通过标准——它可能只是没想改。

### 15.2 阶段二：计划文件（一天）

**目标**：计划落到磁盘，模型能写、能改。

**做四件事**：

```
① 一个路径生成函数（见下）
② 权限层给「写计划文件」开一个例外
③ prompt 告诉模型「把计划写到这个路径」
④ 一个状态机：inactive → planning → awaiting_approval
```

**路径生成的三个要点**（§4.2）：

```
① 不用 sessionId——这些文件是给人翻的
② 编进可检索的维度：项目名 / 时间 / 主题
③ 必须有去重循环：while (existsSync(candidate)) candidate = `${base}-${n++}`
   （时间戳精度是分钟，同一分钟重复进入是常态）
```

⚠️ **这一步会撞到的坑**：

1. **计划文件在工作区之外，路径验证会拦死它**（§6.6 的 Step 3.5）。
   你需要把「计划文件放行」提到路径验证**之前**，
   并且**精确匹配路径，不接受前缀匹配**（否则 `plans/../../.ssh/id_rsa` 就通了）。
2. **`enter()` 要防重入**：`if (state !== "inactive") return false`，
   否则会造出一个假的规划态。

**怎么验证**：进 plan 模式 → 让模型写计划 → 磁盘上有文件 → 让它改一行 →
**用 `edit` 局部替换成功**（不是全文重写）。

### 15.3 阶段三：审批闭环（一天）

**目标**：计划提交给人批，人的编辑要回传给模型。

**做四件事**：

```
① 一个 submit 工具（★ 不接收计划内容作为参数）
② 一个审批 UI：批准 / 拒绝（可带意见）/ 取消
③ 用户编辑 → 写回同一路径 → 重新快照
④ 批准后注入一条「锚点消息」
```

**submit 工具的三条铁律**：

| 铁律 | 理由 |
| --- | --- |
| **不接收计划参数** | 人要在提交前后编辑同一份对象（§4.3） |
| **非 planning 状态下幂等成功**，不标 `isError` | 消灭空转（§2.4）。且**按状态分流**：等审批 vs 已批准，正确的下一步不同 |
| **拒绝要有上限**（5 次），超限强制退出 | 上限的语义是「换一条路」，不是「不许再改」（§5.2） |

**批准消息（锚点）里要塞三件东西**（§4.5）：

```
① 步骤总数（harness 自己数的，不是模型报的）+ 「清单必须覆盖全部步骤」
② 「尊重既有决策」（防方案漂移）
③ 执行阶段的失败处理守则（失败先更新计划再继续）
```

⚠️ **这一步会撞到的坑**：

1. **批准后规划态的 prompt 就被移除了**，批准消息是**唯一保留的锚点**——
   所以它必须自带完整的执行守则，不能只说「已批准」。
2. **需要一个正交的 `executing` 标志**（§5.3）。
   `approve()` 后 `state` 回到 inactive，任何挂在 `isPlanning()` 上的
   执行阶段功能都会**永不触发**。
3. **步骤数解析要定口径**：只数顶层列表项，跳过缩进子项
   （`if (/^\s/.test(line)) continue`）。口径不写死，这个数字就会漂。

**怎么验证**：提交 → 在审批框改一行 → 批准 → **模型的下一轮能看到你改的那一行**。

### 15.4 阶段四：进度清单 + 复述（一到两天）

**目标**：让长任务不遗漏。**这是收益最大的一个阶段。**

**做四件事**：

```
① 一个 todo 工具（content / activeForm / status 三字段）
② ★ 工具返回值里挂前向压力（必达通道）
③ ★ 周期性回注：扫历史判定，不存计数器
④ end_turn 门禁（★ 必须带上限 + 误判自愈）
```

**② 前向压力的写法**（§10.3，这是**性价比最高的一处**）：

```
有 in_progress   → 「下一步：当前进行中的是「X」。做完后立即标 completed，并把下一项置 in_progress」
无 in_progress   → 点名下一个 pending：「建议是「Y」」
全部完成         → 如实收尾即可
```

**为什么挂在返回值上**（§10.6）：**必达**（不受节流/去重/封顶管辖）、
**零边际 token**（复用本就要回传的 `tool_result`）、
**零幻觉风险**（模型不会把工具输出误认成用户说的话）。

**③ 回注判定的写法**（§7.8）：

```
每轮倒序扫消息历史：
  距上次 todo_write 调用 ≥ 8 轮  且  距上次注入 ≥ 8 轮  → 注入完整清单到尾部
```

⚠️ **这一步会撞到的坑**（这一阶段坑最多）：

1. **轮次口径**（§7.7）：数 user 消息时**必须排除 `tool_result` 消息和 meta 消息**,
   否则「每 8 轮」退化成「每 8 次工具调用」。
2. **千万不要加去重**（§7.8）：文本不变正是模型停滞的信号，
   去重会在最需要提醒时静音。实测 60 轮只注入 1 次。
3. **不要存计数器**（§7.8）：如果你的循环状态每条用户消息重建，计数器会全归零。
   扫历史现算还白拿「压缩后自动重注」。
4. **不要把「只能一个 in_progress」做成硬校验**（§10.1）：
   实测代价是模型白等 105.4 秒重交一份逐字相同的清单。**接受写入 + 附上建议。**
5. **门禁必须带上限 + 误判自愈**（§10.5）：3 次软续命，超限放行并如实列出未完成项；
   且判别「真没做完」vs「忘标记」；且**已交付时不要下汇总命令**
   （否则模型会把报告重打一遍）。
6. **守卫方向**（§10.4）：写完每个条件，举出最需要它的场景，检查条件在那里成立吗。
   「全 pending 首建」是最需要提醒的入口态，别把它排除掉。

**怎么验证**：跑一个 10 项以上的长任务。看三件事：
① 清单被实时更新（不是攒到最后）② 中途有回注发生
③ 漏项时门禁拦下且**没有重复输出报告**。

### 15.5 阶段五：跨压缩与跨会话（按需）

⚠️ **这一阶段是「按需」的，先确认前提成立**（§13.5 的 P2/P3）。

**必做（只要你有压缩）**：

```
① 压缩边界主动注入计划：路径 + 全文都给（§4.6）
② 这条注入不受任何封顶管辖 —— 它是「信息丢失」不是「催促噪音」（§8.2）
③ 重入规划态时注入一次性过期引导（§4.9）
```

**③ 特别值得做，因为它成本极低而洞是真实的**：
我在自己机器上翻出 **184 个计划文件**，其中 173 个是旧命名规则的孤儿，
而 `plans/` 目录**根本不在启动清理清单里**（§4.10）。
没有过期引导，模型看到文件里有内容就容易当成当前任务的依据。

**按需（先确认部署环境）**：

| 做什么 | 前提 |
| --- | --- |
| 跨会话恢复三级降级链 | **文件系统不保证持久**（云端容器）。本地跑不需要 |
| fork 时生成新路径 | 你的产品有「会话分叉」功能 |
| 任务图 + 成环检测 | **真的有多 agent 协作** |
| 文件锁 + TOCTOU + 水位线 | **真的跨进程**。同进程内 JS 单线程已给原子性（§9.4） |

⚠️ **最后一行是最容易过度工程的地方。** claude-code 那套是 862 行，
而它之所以需要，是因为 swarm agents 是**独立进程**。
如果你的并发 agent 在同一个进程里、状态在内存里、修改是同步函数，
**你不需要锁**——但要守住三个边界：任何 `await` 都是断点、
spawn 出去的子进程不共享内存、落盘就重新引入跨进程问题。

### 15.6 一张「做到哪一步能声称什么」的对照表

这张表用来自检，也可以直接用在简历/面试的表述里：

| 做到 | 能诚实地说 |
| --- | --- |
| 阶段一 | 「有只读的规划模式」 |
| 阶段二 | 「计划是可寻址的持久化对象」 |
| 阶段三 | 「有人在回路的审批闭环，人的编辑会回传模型」 |
| 阶段四 | 「有复述机制对抗注意力衰减，长任务遗漏有 harness 级兜底」 |
| 阶段五（必做部分） | 「规划约束能活过上下文压缩」 |
| 阶段五（按需部分） | 「支持跨会话/跨进程的规划状态共享」 |

⚠️ **每一行都要能过 §12.1-E 那条 grep**：
排除测试目录后有生产调用点，且真实会话里触发过。
**否则就是在声称一个不存在的能力。**

---
<a id="appendix"></a>

## 附录

### 附录 A：可复跑命令

⚠️ 下面每条命令**都在 2026-08-31 按最终文本原样跑过一遍**，输出附在下面。
这条纪律本身来自一次教训：上一份教学文档的第一版命令字段名全靠猜，
jq 中文键名没加引号直接 10 个编译错误——**教学文档里的命令必须按最终文本跑一遍**,
否则就是在传播会造假数据的命令。

#### A-1 行数口径（本文所有行数的来源）

```bash
cd ~/sid-code

# plan 模块
find packages/core/src/plan -name '*.ts' -not -name '*.test.ts' | xargs wc -l

# 规划相关的单文件
wc -l packages/core/src/tool/todo-write.ts \
      packages/core/src/tool/enter-plan-mode.ts \
      packages/core/src/tool/exit-plan-mode.ts \
      packages/core/src/query/todo-reminder.ts \
      packages/core/src/query/todo-reminder-scan.ts \
      packages/core/src/task/structured-task-store.ts \
      packages/core/src/task/team-task-store.ts
```

**2026-08-31 实际输出**：

```
     445 packages/core/src/plan/state.ts
     140 packages/core/src/plan/slug.ts
     185 packages/core/src/plan/prompt.ts
     201 packages/core/src/plan/recovery.ts
     971 total

     658 packages/core/src/tool/todo-write.ts
     157 packages/core/src/tool/enter-plan-mode.ts
     140 packages/core/src/tool/exit-plan-mode.ts
     148 packages/core/src/query/todo-reminder.ts
     156 packages/core/src/query/todo-reminder-scan.ts
     376 packages/core/src/task/structured-task-store.ts
      76 packages/core/src/task/team-task-store.ts
    1711 total
```

#### A-2 计划文件盘点（§4.10 那 184 个文件）

```bash
printf '顶层旧命名(词-slug): '; find ~/.sid-code/plans -maxdepth 1 -name '*.md' | wc -l
printf '子目录新命名(项目/时间-主题): '; find ~/.sid-code/plans -mindepth 2 -name '*.md' | wc -l

# 按月份分布（macOS 的 stat 语法；Linux 用 stat -c '%y'）
find ~/.sid-code/plans -maxdepth 1 -name '*.md' \
  -exec stat -f '%Sm' -t '%Y-%m' {} \; | sort | uniq -c
```

**2026-08-31 实际输出**：

```
顶层旧命名(词-slug): 173
子目录新命名(项目/时间-主题): 11

   6 2026-03
   4 2026-04
 125 2026-05
  37 2026-06
   1 2026-07
```

#### A-3 ★ 接线核验（本文最该复跑的一条）

**用途**：判断一个能力是「代码在」还是「在跑」。

```bash
cd ~/sid-code

# 通用形式：排除 node_modules 和测试目录
grep -rn "<函数名>" packages/ --include='*.ts' | grep -v node_modules | grep -v '/tests/'

# 进一步排除定义行，只留真调用点（注意带上 `.` 和 `(`）
grep -rn "\.<函数名>(" packages/ --include='*.ts' | grep -v node_modules | grep -v '/tests/'
```

**2026-08-31 三个对照样本**：

```bash
$ for f in recordActualToolCall classifyRecoveryTrigger buildTodoReminder; do
    n=$(grep -rn "$f" packages/ --include='*.ts' | grep -v node_modules \
        | grep -v '/tests/' | grep -v ':\s*\*' | wc -l | tr -d ' ')
    echo "$f → 非测试命中 $n"
  done
recordActualToolCall     → 非测试命中 1     ← ⚠️ 这 1 处是定义本身
classifyRecoveryTrigger  → 非测试命中 4     ← ✅ 含 app.ts 的真调用
buildTodoReminder        → 非测试命中 5     ← ✅

# 排除定义行后
$ grep -rn "\.recordActualToolCall(\|\.getFidelityReport()" packages/ --include='*.ts' \
    | grep -v node_modules | grep -v '/tests/'
（空）  ← 零生产调用点，§11.3 的结论
```

⭐ **注意 `recordActualToolCall` 那一步**：粗略 grep 得到「1 处命中」
很容易被读成「接线了」，**而那 1 处是函数定义本身**。
所以必须跑第二条（带 `.` 和 `(` 的形式）才能得出正确结论。

#### A-4 关键常量与阈值

```bash
cd ~/sid-code

# todo 回注阈值与门禁上限
grep -n "TURNS_SINCE_WRITE\|TURNS_BETWEEN_REMINDERS\|MAX_TODO_GATE_RETRIES\|TODO_GATE_PRODUCTIVE_TEXT_MIN" \
  packages/core/src/query/todo-reminder.ts

# 规划态的拒绝上限与提醒间隔
grep -n "maxRejections\|fullReminderInterval" packages/core/src/plan/state.ts

# 只读工具白名单 + 规划态额外放行
grep -n "READ_ONLY_TOOLS = \|PLAN_MODE_EXTRA_TOOLS" -A 20 packages/core/src/permission/checker.ts

# 权限判定链的完整顺序（§6.6）
grep -nE "^\s+// Step [0-9]" packages/core/src/permission/checker.ts

# 循环检测的豁免名单与默认开关（§12.3）
grep -n "EXEMPT_TOOLS = " -A 18 packages/core/src/agent/loop-detection.ts
grep -n "_disabled = false" -B 2 packages/core/src/agent/loop-detection.ts
```

#### A-5 启动清理清单（§4.10 那个「plans 不在里面」）

```bash
grep -n "MAX_AGE_MS" packages/core/src/config/startup-housekeeping.ts
```

**2026-08-31 实际输出**（注意 `plans` 一条都没有）：

```
 78: TRAJECTORY_MAX_AGE_MS      = 30 天
 96: SHELL_SNAPSHOT_MAX_AGE_MS  =  1 天
 99: TASK_OUTPUT_MAX_AGE_MS     =  7 天
108: CHECKPOINT_MAX_AGE_MS      = 30 天
```

### 附录 B：术语表（按「一个计划从生到死」排序）

| 词 | 一句话 | 章节 |
| --- | --- | --- |
| **harness** | 包着模型的那层代码。**模型不是 agent，harness + 模型才是** | §0 |
| **形态 A-E** | 「planning」这个词指的五件不同的事：推理拓扑 / 任务分解 / 规划态 / 进度清单 / 任务图 | §0.1 |
| **CoT / ToT / GoT** | 推理拓扑：链 / 树 / 图。ToT 的三前提在 coding 上全塌 | §3 |
| **plan mode（规划态）** | 只读受限模式 + 人类审批。**同时是权限模式和行为模式** | §5 |
| **plan file** | 磁盘上的 markdown。判据：会被第二个主体读改 + 要活过压缩 → 必须有地址 | §4 |
| **决策记录** | 计划里的「不做什么 + 为什么 + 重新评估条件」。防方案漂移 | §4.5 |
| **executing 标志** | 与三态正交的布尔位。三态管权限，它管语义 | §5.3 |
| **分档提醒** | 高频精简 + 低频完整。精简版只重建存在感 + 给取回路径 | §5.4 |
| **逃逸阀** | 让「X 模式强制 Y」失效的更高优先级规则 | §6.6 |
| **等价替代路径** | 前门锁了还有几扇窗（bash 重定向 / tmp / heredoc） | §6.3 |
| **recitation（复述）** | 定期把关键目标重贴到上下文**末尾**。TodoWrite 的真实定位 | §7 |
| **前向压力** | 挂在 `tool_result` 上的推进指令。必达 + 免费 + 无幻觉 | §10.6 |
| **轮次口径** | 消息条数 ≠ 工具调用轮 ≠ 人类交互轮。⚠️ `tool_result` 是 user 角色 | §7.7 |
| **Governance Decay** | 压缩静默擦除常驻约束。2026-06 的正式术语 📄 | §8.2 |
| **无约束窗口** | 压缩后到下次周期注入之间，约束完全缺席的那几轮 | §8.2 |
| **状态过期** | 持久化解决了「丢失」，引入了「过期」 | §4.9 |
| **TOCTOU** | 检查通过了但等你去用时状态已变。**锁的粒度由不变量的作用域决定** | §9.6 |
| **ABA / ID 复用** | 重置后重新编号，旧引用改到了新任务上。用单调水位线解决 | §9.6 |
| **fidelity（保真度）** | 实际干的 vs 计划写的。三个量：stepRatio / matchedRatio / offPlanCount | §11.3 |
| **主/机制/护栏指标** | 想优化的 / 直接操作的 / 防反噬的。**机制指标 ≠ 目标指标** | §11.0 |
| **绿着坏掉** | 代码在、测试绿、机理对，而真实会话零触发 | §12 |

### 附录 C：自检清单（交付前跑一遍）

**状态类**
- [ ] 每个新状态：什么时候重建/清零？和语义边界一致吗？（§12.1-A）
- [ ] 每个持久化状态：谁负责判断它过期？（§4.9）
- [ ] 想加新状态时：它在原有维度上的取值是什么？和已有状态一样 → **它是正交维度**（§5.3）

**判据类**
- [ ] 每个条件：**举出最需要它的场景，检查条件在那里成立吗**（§10.4）
- [ ] 每个去重/封顶：它会不会在故障时静音？（§7.8）
- [ ] 「催促噪音」和「信息丢失」用的是同一个预算吗？（§8.2）

**口径类**
- [ ] 每个「N 轮」：N 数的是哪种轮？注释写了吗？（§7.7）
- [ ] 每个比率：分母写死了吗？（§11.4）
- [ ] 每个魔法常量：注释写的是**推导过程**还是字面含义？（§9.4）

**优先级类**
- [ ] 每条「X 模式强制 Y」：在判定链第几步？前面有谁能抢？（§6.6）
- [ ] 每个能力剥离：等价替代路径枚举完了吗？（§6.3）

**触发证据类**
- [ ] 每个新机制：跑过 A-3 那条 grep 吗？**排除定义行后还有命中吗？**
- [ ] 每个新机制：真实会话里触发过吗？触发计数在哪看？
- [ ] 每个「我们有 X 能力」的表述：引用前跑过 A-3 吗？

**拦截类**
- [ ] 每个拦截：拦下来后模型有**新信息**可用吗？（§10.5）
- [ ] 每个拦截：有上限吗？超限后是「报错」还是「换一条路」？（§5.2）

**指令类**
- [ ] 每个祈使句：是无条件的吗？哪些状态下它会说错话？（§10.5b）
- [ ] 这条压力能挂在工具返回值上吗？（§10.6）

### 附录 D：本文的三条元纪律

写这份文档的过程本身有三条纪律，它们比任何单个结论都更该带走：

**① 「我没找到」和「它不存在」是两句不同的话。**
§13.4 那一节我保留了一个「无法确认」的结论，
因为把前者写成后者是 §12 那类失效在**文档层**的等价物
——它同样不报错，而且会一直被引用下去。

**② 引用「现状」是最贵的错误。**
本文写作过程中抓到两处漂移：计划文件命名规则改过（173 个孤儿文件）、
保真度模块从未接线。**如果照抄旧文档，前者会被漏掉，后者会被报成「我们有保真度度量」。**
所以全文所有数字都带时间戳 + 复跑命令。

**③ 命令必须按最终文本跑一遍。**
附录 A 的每条命令都原样跑过，输出贴在下面。
⚠️ 特别是 A-3——粗略 grep 会把「函数定义」误读成「接线了」，
必须跑第二条带 `.` 和 `(` 的形式才得出正确结论。
**这个坑我在写这一节时真的踩了一次。**

---
