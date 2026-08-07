---
title: Claude Code 源码解析（零）· 引言
description: '一份意外泄露的 Harness Engineering 教材：51 万行 TS、1902 个文件。这个系列拆什么、适合谁读、以及一份快照解析的局限在哪。'
date: "2026-04-01"
series: Claude Code 源码解析
highlight: 引言 + 20 章 · 约 13.5 小时 · 基于 2026-03-31 源码快照
tags: [Claude Code, 源码解析, harness]
outline: 2
---

# Claude Code 源码解析（零）· 引言

> 深入 Claude Code 内部，聚焦其 **Harness Engineering** —— 围绕 LLM 构建的运行时基础设施，
> 拆解启动引导、对话循环、工具编排、权限控制、多 Agent 协作等核心工程架构。
>
> 这是本系列的第一篇（引言 + 20 章，共 21 篇、约 13.5 小时）。
> 左侧目录里「Claude Code 源码解析」那一组就是完整章节列表，
> 每篇底部也有「上一篇 / 下一篇」。

2026 年，AI 圈有一个越来越热的概念：**Harness Engineering**。

这个词的意思是——AI Agent 好不好用，不只取决于模型多强，更取决于你围绕模型搭建的那套「笼具」（harness）有多好。模型是一匹野马，能力惊人但不可预测；harness 是缰绳、马鞍和马蹄铁，把原始力量变成可控的生产力。它包括工具调用、约束规则、反馈循环、安全机制、记忆系统……所有让 AI 从「Demo 很惊艳」变成「生产环境能交付」的工程系统。

这个概念之所以重要，是因为行业正在经历一次认知转变：**模型能力的天花板在升高，但落地质量的瓶颈不在模型本身，而在模型之外的工程层。** 同样是 Claude Opus，裸调 API 和用 Claude Code 的体验天差地别。差距不在智商，在笼具。

## 1902 个文件里的秘密

2026 年 3 月 31 日，Claude Code 的源码意外泄露。1902 个文件，51.2 万行 TS 核心代码。

大多数人看到的是一个好用的 AI 编程助手。我翻完源码后发现的，是一份关于 harness engineering 的绝佳教材。

Claude Code 好用，我的判断是：**60% 靠 Opus 模型本身的能力，40% 靠围绕模型搭建的工程系统。** 这 40% 就是 harness——而且是我见过的、设计最精细的 harness 之一。

它包括什么？

**一套精心拼装的 System Prompt。** 不是一段固定文本，而是根据运行模式、用户配置、项目上下文、可用工具动态组装的结构化指令集。光 system prompt 的构建逻辑就涉及十几个模块，最终拼出的 prompt 可以超过数万 token。这套 prompt 是 Claude Code 行为一致性的基石——它定义了 AI 应该如何思考、何时该问、何时该做、何时该停。

**一个用第二 AI 做安全审查的四层权限系统。** 用户敲下回车，工具调用请求先过信任边界检查，再过规则匹配引擎，然后送给一个独立的分类器模型（不是主对话模型）做恶意意图检测，最后才弹出人工确认框。四层防线，任何一层拦截都会阻止执行。这不是「加个确认弹窗」的安全，是纵深防御。

**一个只记偏好不记代码的记忆系统。** LLM 天生无状态，每次对话都是白纸。Claude Code 用四层记忆栈解决这个问题：静态的 CLAUDE.md 规则文件、自动提取的持久记忆（MEMORY.md）、会话内的滚动摘要、团队共享的同步记忆。关键设计决策是——记忆系统只存储偏好、约定和决策，不存储代码内容。这让记忆体积可控，也避免了过时代码污染未来决策。

**一套 9 段式结构化上下文压缩。** 上下文窗口是 LLM 最硬的物理约束。当对话超过 token 预算的 80%，Claude Code 不是简单地截断历史，而是启动一个精心设计的压缩流程：保留 system prompt 和最近消息，对中间的历史消息按 9 个维度提取摘要——环境信息、代码变更、工具调用结果、用户偏好、关键决策……压缩后的摘要替换原始消息，对话可以无限延续而不丢失关键上下文。

**一个像真实公司一样运转的多 Agent 协作框架。** 主 Agent 是 coordinator，可以派生子代理（subagent）并行处理任务。每个子代理有独立的对话上下文、独立的工具权限、独立的 token 预算，但共享文件系统和 MCP 连接。子代理之间可以通过 SendMessage 通信，coordinator 可以随时查看进度、终止任务。更值得注意的是，源码中已经出现了四种不同类型的 Task 实现——LocalShellTask（后台 Shell）、LocalAgentTask（本地子代理）、RemoteAgentTask（远程代理）、InProcessTeammateTask（进程内队友）——这意味着 Claude Code 的 Agent 架构不只是「主从派发」，而是在为更复杂的分布式协作做准备。这不是玩具级的 multi-agent，是带状态隔离、资源管控和故障处理的生产级编排。

## 这份教材适合谁

这个系列不是 Claude Code 的用户手册——官方文档已经做得很好了。

这是一份**面向 AI 工程师的架构解析**。如果你正在做以下任何一件事，这些设计思路都可以直接借鉴：

- **搭建 AI Agent 产品**：如何设计工具系统、权限模型、记忆机制
- **优化 LLM 应用体验**：如何管理上下文窗口、构建 system prompt、处理流式响应
- **构建开发者工具**：如何做 CLI 的两阶段启动、终端 UI 渲染、IDE 集成
- **理解 harness engineering**：一个 51 万行代码库中反复出现的工程模式和架构决策

每一章聚焦一个子系统，从「它解决什么问题」开始，到源码级的实现细节结束。你不需要按顺序阅读——每章都是自包含的，可以直接跳到你感兴趣的部分。

## 一点说明

本系列基于 Claude Code 泄露源码的**静态分析**。源码版本为 2026 年 3 月 31 日泄露的快照，后续版本可能已有变化。文中的架构判断和设计意图分析，是基于代码结构和注释的推断，**不代表 Anthropic 官方观点**。

代码引用均标注了文件路径和行号，方便对照阅读。为了可读性，部分代码片段做了简化，省略了错误处理和边界情况。

难度分三级：

- ⭐ 入门级：了解 Claude Code 基本架构即可阅读
- ⭐⭐ 中级：需要 TypeScript / React 基础
- ⭐⭐⭐ 高级：涉及分布式系统、编译优化等深层设计

## 源码目录速览

```text
src/
├── entrypoints/     # 入口点（CLI、SDK）
├── main.tsx         # 主应用入口
├── QueryEngine.ts   # 对话循环引擎
├── Tool.ts / tools/ # 工具系统（30+）
├── Task.ts / tasks/ # 任务系统（Agent、Shell）
├── commands/        # 斜杠命令（80+）
├── services/        # 服务层（API、MCP、压缩、分析）
├── hooks/           # React Hooks
├── components/      # Ink 终端 UI 组件
├── plugins/         # 插件系统
├── skills/          # Skills 系统
├── state/           # 全局状态管理
├── bridge/          # IDE Bridge 通信
├── ink/             # Ink 渲染引擎定制
├── utils/           # 工具函数库（30+）
└── ...
```

## 官方资源

- [Claude Code 官方文档](https://code.claude.com/docs/zh-CN/overview)
- [Claude Code GitHub](https://github.com/anthropics/claude-code)
- [Anthropic 官方博客](https://www.anthropic.com/blog)
