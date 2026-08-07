---
title: Claude Code 源码解析（十四）· 记忆与上下文持久化
description: '每次新会话都要重新介绍项目背景？Claude Code 如何跨会话积累知识——记住你的编码偏好、项目约定和团队规范？'
date: "2026-04-01"
series: Claude Code 源码解析
tags: [Claude Code, 源码解析, harness]
outline: 2
---

# 第十四章：记忆与上下文持久化（Memory & Context Persistence）

> LLM 没有记忆——每次对话都是一张白纸。Claude Code 如何让 AI 跨会话"记住"用户是谁、项目在做什么、上次犯了什么错？

## 核心问题

LLM 的一个根本限制是**无状态性**——每次 API 调用都是独立的，模型不会"记住"上一次对话的任何内容。对于一个编程助手来说，这意味着：

1. **用户每次都要重新自我介绍。** "我是后端工程师"、"我们用 bun 不用 npm"、"测试不要 mock 数据库"——这些偏好和约束，用户不得不反复说明。

2. **项目上下文每次都要重新建立。** 代码库的架构决策、正在进行的重构、即将到来的发布冻结——这些"活的"知识无法从代码本身推导出来，却对做出正确决策至关重要。

3. **纠正不会被记住。** 用户纠正了一次"不要在这类测试中 mock 数据库"，下次对话又会犯同样的错误。

4. **团队知识无法共享。** 一个团队成员教会了 Claude 的东西，其他成员无法受益。

**核心矛盾：LLM 的无状态本质 vs 用户对"有记忆的助手"的期望。**

Claude Code 的解法是一个**多层记忆架构**——从静态的项目规则文件（CLAUDE.md），到自动提取的持久记忆（Auto Memory），到会话内的滚动摘要（Session Memory），再到团队共享的同步记忆（Team Memory），构成了一个完整的"记忆栈"。

---

## 14.1 架构总览：记忆栈

```
┌─────────────────────────────────────────────────────────────────┐
│                    System Prompt 注入层                          │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌───────────────┐  │
│  │CLAUDE.md │  │MEMORY.md │  │ 相关记忆  │  │ Session Notes │  │
│  │(静态规则) │  │(记忆索引) │  │(动态召回) │  │ (会话摘要)    │  │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └──────┬────────┘  │
│       │             │             │                │            │
└───────┼─────────────┼─────────────┼────────────────┼────────────┘
        │             │             │                │
        ▼             ▼             ▼                ▼
┌───────────────────────────────────────────────────────────────┐
│                      持久化存储层                               │
│                                                               │
│  Layer 1: CLAUDE.md 系统（静态规则）                            │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │ /etc/claude-code/CLAUDE.md     (企业管控)                │  │
│  │ ~/.claude/CLAUDE.md            (用户全局)                │  │
│  │ <project>/CLAUDE.md            (项目级，检入代码)         │  │
│  │ <project>/.claude/rules/*.md   (项目规则，检入代码)       │  │
│  │ <project>/CLAUDE.local.md      (本地私有，不检入)         │  │
│  └─────────────────────────────────────────────────────────┘  │
│                                                               │
│  Layer 2: Auto Memory（自动记忆）                              │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │ ~/.claude/projects/<hash>/memory/                        │  │
│  │   ├── MEMORY.md          (索引，≤200行/25KB)             │  │
│  │   ├── user_*.md          (用户画像)                      │  │
│  │   ├── feedback_*.md      (行为反馈)                      │  │
│  │   ├── project_*.md       (项目上下文)                    │  │
│  │   ├── reference_*.md     (外部引用)                      │  │
│  │   └── team/              (团队共享记忆)                   │  │
│  │       ├── MEMORY.md                                      │  │
│  │       └── *.md                                           │  │
│  └─────────────────────────────────────────────────────────┘  │
│                                                               │
│  Layer 3: Session Memory（会话记忆）                           │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │ ~/.claude/projects/<hash>/<sessionId>/                    │  │
│  │   └── session-memory/summary.md                          │  │
│  └─────────────────────────────────────────────────────────┘  │
│                                                               │
│  Layer 4: Team Memory Sync（团队同步）                         │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │ Local: ~/.claude/projects/<hash>/memory/team/            │  │
│  │   ↕ (HTTP API: GET/PUT)                                  │  │
│  │ Server: /api/claude_code/team_memory?repo={owner/repo}   │  │
│  └─────────────────────────────────────────────────────────┘  │
│                                                               │
└───────────────────────────────────────────────────────────────┘
```

这四层记忆的设计哲学是**从静态到动态、从手动到自动、从个人到团队**：

| 层级 | 写入方式 | 生命周期 | 共享范围 | 典型内容 |
|------|---------|---------|---------|---------|
| CLAUDE.md | 用户手动编写 | 永久（随代码库） | 项目所有成员 | 编码规范、架构约束、工具链偏好 |
| Auto Memory | AI 自动提取 + 用户显式请求 | 跨会话持久 | 个人（或团队） | 用户画像、行为反馈、项目状态 |
| Session Memory | AI 后台自动维护 | 单会话内 | 仅当前会话 | 当前任务摘要、工作进展 |
| Team Memory | 自动同步到服务器 | 跨会话 + 跨用户 | 团队所有成员 | 团队约定、项目决策、外部资源指针 |

**为什么需要四层而不是一层？**

因为不同类型的知识有不同的特征：

- **编码规范**（"用 bun 不用 npm"）是稳定的、应该检入代码的——适合 CLAUDE.md
- **用户偏好**（"不要在回复末尾总结"）是个人的、跨项目的——适合 Auto Memory
- **当前任务进展**（"正在重构 auth 模块，已完成 3/7 个文件"）是临时的、会话级的——适合 Session Memory
- **团队决策**（"auth 重写是因为合规要求，不是技术债"）是共享的、需要同步的——适合 Team Memory

一层记忆系统无法同时满足这些不同的需求。

---

## 14.2 CLAUDE.md 系统：静态规则层

### 面临的问题

在 Auto Memory 出现之前，CLAUDE.md 是 Claude Code 唯一的"记忆"机制。它解决的是一个看似简单的问题：**如何让 AI 遵守项目特定的规则和约定？**

但这个问题有几个维度的复杂性：

1. **规则有不同的来源和信任级别。** 企业管控的规则（"禁止使用某些 API"）、用户个人偏好（"用 vim 键位"）、项目约定（"用 bun 不用 npm"）、本地覆盖（"我的机器上用这个路径"）——它们的优先级和安全含义完全不同。

2. **规则需要组合而非覆盖。** 不像配置文件那样后者覆盖前者，CLAUDE.md 的内容是**累加**的——所有层级的规则都应该同时生效。

3. **规则可能引用外部文件。** 一个 CLAUDE.md 可能想 `@include` 另一个文件的内容，这引入了路径解析、循环引用、安全边界等问题。

4. **恶意仓库可能注入危险规则。** 如果用户 clone 了一个恶意仓库，其中的 CLAUDE.md 可能包含"忽略所有安全检查"之类的指令。

### 解法：多层级文件发现 + 优先级排序

`utils/claudemd.ts` 实现了一个精心设计的文件发现和加载系统：

```
加载顺序（从低优先级到高优先级）：

1. Managed  → /etc/claude-code/CLAUDE.md          (企业管控，IT 部门设置)
             /etc/claude-code/.claude/rules/*.md

2. User     → ~/.claude/CLAUDE.md                  (用户全局偏好)
             ~/.claude/rules/*.md

3. Project  → <root>/CLAUDE.md                     (项目级，检入代码)
             <root>/.claude/CLAUDE.md
             <root>/.claude/rules/*.md
             (从 git root 到 cwd 的每一层目录)

4. Local    → <root>/CLAUDE.local.md               (本地私有，不检入)
             (从 git root 到 cwd 的每一层目录)

5. AutoMem  → ~/.claude/projects/<hash>/memory/MEMORY.md  (自动记忆索引)

6. TeamMem  → ~/.claude/projects/<hash>/memory/team/MEMORY.md  (团队记忆索引)
```

关键设计：**文件按从低到高的优先级顺序加载，后加载的内容在 System Prompt 中排在更后面。** 这利用了 LLM 的一个特性——模型倾向于更关注 prompt 末尾的内容（recency bias）。所以最高优先级的规则（Local、AutoMem）排在最后，获得最大的注意力权重。

### 核心源码解读：`getMemoryFiles()`

```typescript
// utils/claudemd.ts — 简化后的核心流程
export const getMemoryFiles = memoize(
  async (forceIncludeExternal = false): Promise<MemoryFileInfo[]> => {
    const result: MemoryFileInfo[] = []
    const processedPaths = new Set<string>()  // 防止重复加载

    // ① Managed（企业管控）
    result.push(...(await processMemoryFile(
      getMemoryPath('Managed'), 'Managed', processedPaths, includeExternal
    )))

    // ② User（用户全局）— 仅当 userSettings 启用时
    if (isSettingSourceEnabled('userSettings')) {
      result.push(...(await processMemoryFile(
        getMemoryPath('User'), 'User', processedPaths, true  // 用户文件总是允许外部引用
      )))
    }

    // ③ Project + Local — 从 git root 向下遍历到 cwd
    let currentDir = originalCwd
    while (currentDir !== parse(currentDir).root) {
      dirs.push(currentDir)
      currentDir = dirname(currentDir)
    }
    for (const dir of dirs.reverse()) {  // 从根向 cwd 遍历
      // Project: CLAUDE.md, .claude/CLAUDE.md, .claude/rules/*.md
      // Local: CLAUDE.local.md
    }

    // ④ AutoMem 索引（MEMORY.md）
    if (isAutoMemoryEnabled()) {
      result.push(memdirEntry)
    }

    // ⑤ TeamMem 索引（team/MEMORY.md）
    if (feature('TEAMMEM') && isTeamMemoryEnabled()) {
      result.push(teamMemEntry)
    }

    return result
  }
)
```

### @include 指令：文件组合机制

CLAUDE.md 支持 `@path` 语法引用其他文件：

```markdown
# 项目规则
@./coding-standards.md
@./testing-policy.md
@~/global-preferences.md
```

实现上，`processMemoryFile()` 使用 marked 的 Lexer 解析 Markdown AST，从文本节点中提取 `@path` 引用，然后递归加载：

```typescript
// utils/claudemd.ts
async function processMemoryFile(
  filePath, type, processedPaths, includeExternal, depth = 0, parent?
): Promise<MemoryFileInfo[]> {
  // 防循环：已处理的路径跳过
  if (processedPaths.has(normalizedPath) || depth >= MAX_INCLUDE_DEPTH) {
    return []
  }

  // 读取文件，解析 frontmatter 和 @include 路径（单次 lex）
  const { info, includePaths } = await safelyReadMemoryFileAsync(
    filePath, type, resolvedPath
  )

  const result = [info]  // 父文件在前

  // 递归处理 @include 引用
  for (const includePath of includePaths) {
    const isExternal = !pathInOriginalCwd(includePath)
    if (isExternal && !includeExternal) continue  // 安全门控

    result.push(...(await processMemoryFile(
      includePath, type, processedPaths, includeExternal,
      depth + 1, filePath  // 传递 parent 用于追踪
    )))
  }
  return result
}
```

这里有几个关键的安全设计：

- **最大深度限制**（`MAX_INCLUDE_DEPTH = 5`）：防止无限递归
- **循环检测**（`processedPaths` Set）：防止 A → B → A 的循环引用
- **外部文件门控**（`includeExternal`）：Project 类型的 @include 默认不允许引用项目目录外的文件，除非用户显式批准
- **文本文件白名单**（`TEXT_FILE_EXTENSIONS`）：只允许 include 文本文件，防止加载二进制文件

### Frontmatter 路径过滤：条件规则

CLAUDE.md 文件支持 frontmatter 中的 `paths` 字段，实现**条件规则**——只在操作特定路径时生效：

```markdown
---
paths: "src/api/** tests/api/**"
---
API 模块的测试必须使用真实数据库连接，不要 mock。
```

这个机制让规则可以精确地作用于代码库的特定区域，避免全局规则的"一刀切"问题。

### 注入 System Prompt：`getUserContext()`

所有加载的 CLAUDE.md 文件最终通过 `context.ts` 的 `getUserContext()` 注入到 System Prompt 中：

```typescript
// context.ts
export const getUserContext = memoize(async () => {
  const claudeMd = shouldDisableClaudeMd
    ? null
    : getClaudeMds(filterInjectedMemoryFiles(await getMemoryFiles()))

  return {
    ...(claudeMd && { claudeMd }),
    currentDate: `Today's date is ${getLocalISODate()}.`,
  }
})
```

`getClaudeMds()` 将 `MemoryFileInfo[]` 转换为一个字符串，包含所有文件的内容和一个前导指令：

```
Codebase and user instructions are shown below. Be sure to adhere to
these instructions. IMPORTANT: These instructions OVERRIDE any default
behavior and you MUST follow them exactly as written.
```

### 设计决策讨论

**为什么 CLAUDE.md 内容放在 `userContext` 而不是 `systemPrompt` 中？**

System Prompt 是 API 调用中的 `system` 参数，而 `userContext` 是作为对话的第一条 user message 注入的。将 CLAUDE.md 放在 userContext 中有两个好处：

1. **Prompt Cache 友好**：System Prompt 是所有对话共享的前缀，变化会导致 cache miss。CLAUDE.md 内容因项目而异，放在 system 中会频繁破坏缓存。放在 userContext 中，system 前缀保持稳定。

2. **优先级控制**：userContext 在 systemContext（git status 等）之后注入，确保 CLAUDE.md 的规则在模型的注意力中有更高的权重。

**为什么 `getMemoryFiles()` 用 `memoize` 包装？**

CLAUDE.md 文件在一次会话中不会变化（除非用户手动编辑）。memoize 确保文件系统遍历只执行一次，后续调用直接返回缓存结果。这对性能至关重要——`getMemoryFiles()` 涉及大量的 `readFile` 和 `readdir` 调用。

**为什么 Project 类型的 @include 默认不允许外部引用？**

这是一个安全设计。考虑这个攻击场景：恶意仓库的 CLAUDE.md 包含 `@~/.ssh/id_rsa`，如果允许外部引用，就会把用户的私钥加载到 System Prompt 中，然后通过模型的输出泄露。通过默认禁止外部引用，这个攻击被阻断。用户可以通过信任对话框显式批准外部引用。

---

## 14.3 Auto Memory：让 AI 自己学会记住

### 面临的问题

CLAUDE.md 解决了"静态规则"的问题，但它有一个根本局限：**需要用户手动编写和维护。**

现实中，大量有价值的上下文是在对话过程中自然产生的：

- 用户说"我是数据科学家"——这是用户画像
- 用户说"别在回复末尾总结"——这是行为反馈
- 用户说"auth 重写是因为合规要求"——这是项目上下文
- 用户说"bug 在 Linear 的 INGEST 项目里追踪"——这是外部引用

这些信息如果不被记录，下次对话就会丢失。但指望用户每次都手动把这些写进 CLAUDE.md 是不现实的。

**核心矛盾：有价值的上下文在对话中自然产生，但 LLM 无法跨会话保留它们。**

### 解法：基于文件系统的持久记忆 + 后台自动提取

Auto Memory 的设计有两个关键组成部分：

1. **主代理的记忆能力**：通过 System Prompt 注入记忆指令，让主代理在对话中直接写入记忆文件
2. **后台提取代理**：在每轮对话结束后，用一个 forked agent 自动从对话中提取值得记住的信息

这两者是**互斥**的——如果主代理已经写了记忆，后台代理就跳过这一轮。

### 记忆类型分类法

Auto Memory 将记忆约束为四种类型，这是一个精心设计的**封闭分类法**（closed taxonomy）：

```
┌─────────────────────────────────────────────────────────────┐
│                    四类记忆分类法                              │
│                                                             │
│  user      用户画像：角色、目标、知识、偏好                    │
│            "我是后端工程师，Go 写了十年，React 是新手"          │
│                                                             │
│  feedback  行为反馈：纠正 + 确认                              │
│            "别 mock 数据库——上季度因此出过事故"                 │
│            "单个大 PR 是对的，拆分只是浪费"                    │
│                                                             │
│  project   项目上下文：进行中的工作、决策、截止日期             │
│            "周四后冻结非关键合并——移动端要切分支"               │
│                                                             │
│  reference 外部引用：外部系统的指针                            │
│            "pipeline bug 在 Linear 的 INGEST 项目里追踪"      │
│                                                             │
└─────────────────────────────────────────────────────────────┘

明确排除的内容（不应保存为记忆）：
  ✗ 代码模式、架构、文件结构 — 可从代码推导
  ✗ Git 历史、最近变更 — git log 是权威来源
  ✗ 调试方案、修复方法 — 修复在代码里，上下文在 commit message 里
  ✗ CLAUDE.md 中已有的内容 — 避免重复
  ✗ 临时任务状态、当前对话上下文 — 用 Task/Plan 而非记忆
```

这个分类法的设计哲学是：**只记住不可从当前项目状态推导出的信息。** 代码模式可以通过 grep 发现，git 历史可以通过 git log 查看，但"用户是数据科学家"、"上季度因为 mock 出过事故"这些信息无法从代码中推导——它们才是记忆的价值所在。

源码中的定义（`memdir/memoryTypes.ts`）：

```typescript
export const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'] as const
export type MemoryType = (typeof MEMORY_TYPES)[number]
```

每种类型都有详细的 `<when_to_save>`、`<how_to_use>` 和 `<examples>` 指导，注入到 System Prompt 中引导模型的记忆行为。

### 记忆存储结构

```
~/.claude/projects/<sanitized-git-root>/memory/
├── MEMORY.md                    # 索引文件（≤200行/25KB）
├── user_role.md                 # 用户画像
├── feedback_testing.md          # 测试反馈
├── project_auth_rewrite.md      # 项目上下文
├── reference_linear.md          # 外部引用
└── team/                        # 团队共享记忆（14.5 节详述）
    ├── MEMORY.md
    └── *.md
```

每个记忆文件使用 frontmatter 格式：

```markdown
---
name: 测试策略反馈
description: 集成测试必须使用真实数据库，不要 mock
type: feedback
---

集成测试必须使用真实数据库连接，不要 mock。

**Why:** 上季度因为 mock/prod 差异导致迁移失败未被测试发现。
**How to apply:** 所有涉及数据库的测试文件中，使用真实连接而非 mock。
```

`MEMORY.md` 是索引文件，不是记忆本身——每条记录只占一行：

```markdown
- [用户画像](user_role.md) — 后端工程师，Go 专家，React 新手
- [测试策略](feedback_testing.md) — 集成测试用真实数据库，不 mock
- [Auth 重写](project_auth_rewrite.md) — 合规驱动，非技术债
```

### 核心数据流：记忆的写入与读取

```
写入路径（两种互斥方式）：

方式 A：主代理直接写入
  用户对话 → 主代理识别到值得记忆的信息
    → FileWriteTool 写入 memory/feedback_testing.md
    → FileEditTool 更新 memory/MEMORY.md 索引
    → hasMemoryWritesSince() 检测到写入
    → 后台提取代理跳过本轮

方式 B：后台提取代理自动提取
  主代理完成一轮对话（end_turn）
    → handleStopHooks 触发 executeExtractMemories()
    → hasMemoryWritesSince() 检测到主代理未写入
    → runForkedAgent() 启动 forked agent
      → 共享主对话的 prompt cache（零额外 cache 成本）
      → 分析最近 N 条消息
      → 写入记忆文件 + 更新索引
    → appendSystemMessage() 通知用户"已保存记忆"

读取路径：

  会话启动
    → getMemoryFiles() 加载 MEMORY.md 内容
    → 注入 System Prompt（通过 getUserContext）
    → 模型在每次对话中都能看到 MEMORY.md 索引

  查询时动态召回（findRelevantMemories）
    → scanMemoryFiles() 扫描所有 .md 文件的 frontmatter
    → sideQuery() 用 Sonnet 选择最多 5 个相关文件
    → 将选中文件的完整内容注入当前对话
```

### 后台提取代理：Forked Agent 模式

后台提取是 Auto Memory 最精妙的部分。它使用了 `runForkedAgent` 模式——一个"完美分叉"的子代理，共享主对话的所有上下文：

```typescript
// services/extractMemories/extractMemories.ts — 简化
async function runExtraction({ context, ... }) {
  const { messages } = context
  const memoryDir = getAutoMemPath()

  // 互斥检查：主代理已写入记忆 → 跳过
  if (hasMemoryWritesSince(messages, lastMemoryMessageUuid)) {
    lastMemoryMessageUuid = messages.at(-1)?.uuid
    return
  }

  // 预注入记忆目录清单（省去 agent 的 ls 开销）
  const existingMemories = formatMemoryManifest(
    await scanMemoryFiles(memoryDir, signal)
  )

  // 构建提取 prompt
  const userPrompt = buildExtractAutoOnlyPrompt(
    newMessageCount, existingMemories, skipIndex
  )

  // 运行 forked agent
  const result = await runForkedAgent({
    promptMessages: [createUserMessage({ content: userPrompt })],
    cacheSafeParams,           // 共享主对话的 prompt cache
    canUseTool,                // 严格的工具权限
    querySource: 'extract_memories',
    skipTranscript: true,      // 不写入会话记录（避免竞态）
    maxTurns: 5,               // 硬上限防止兔子洞
  })

  // 提取写入的文件路径，通知用户
  const writtenPaths = extractWrittenPaths(result.messages)
  if (memoryPaths.length > 0) {
    appendSystemMessage?.(createMemorySavedMessage(memoryPaths))
  }
}
```

**为什么用 Forked Agent 而不是独立的 API 调用？**

Forked Agent 的关键优势是**共享 prompt cache**。主对话的 System Prompt + 消息历史已经在 Anthropic 的 cache 中了。Forked Agent 发送相同的前缀 + 一条新的提取指令，cache 命中率极高（源码日志显示 hit rate 通常 > 90%）。如果用独立的 API 调用，就需要重新发送整个对话历史，cache 完全浪费。

**工具权限的严格限制**

提取代理的工具权限被严格限制在最小范围内：

```typescript
// services/extractMemories/extractMemories.ts
export function createAutoMemCanUseTool(memoryDir: string): CanUseToolFn {
  return async (tool, input) => {
    // ✅ 允许：Read/Grep/Glob（只读，无限制）
    if (tool.name === FILE_READ_TOOL_NAME || ...) {
      return { behavior: 'allow', updatedInput: input }
    }

    // ✅ 允许：Bash（仅只读命令：ls/find/cat/stat/wc/head/tail）
    if (tool.name === BASH_TOOL_NAME) {
      if (tool.isReadOnly(parsed.data)) {
        return { behavior: 'allow', updatedInput: input }
      }
      return denyAutoMemTool(tool, 'Only read-only shell commands...')
    }

    // ✅ 允许：Edit/Write（仅 memoryDir 内的路径）
    if ((tool.name === FILE_EDIT_TOOL_NAME || tool.name === FILE_WRITE_TOOL_NAME)
        && isAutoMemPath(filePath)) {
      return { behavior: 'allow', updatedInput: input }
    }

    // ❌ 拒绝：其他所有工具
    return denyAutoMemTool(tool, '...')
  }
}
```

这个设计确保了提取代理**只能读取项目文件 + 写入记忆目录**，不能执行任意命令、不能修改项目代码、不能调用 MCP 工具。这是最小权限原则的体现。

### 记忆路径解析：安全性考量

记忆目录的路径解析（`memdir/paths.ts`）包含了大量安全防护：

```typescript
// memdir/paths.ts
export const getAutoMemPath = memoize((): string => {
  // 优先级：环境变量覆盖 > settings.json > 默认计算
  const override = getAutoMemPathOverride() ?? getAutoMemPathSetting()
  if (override) return override

  // 默认：~/.claude/projects/<sanitized-git-root>/memory/
  return join(projectsDir, sanitizePath(getAutoMemBase()), 'memory') + sep
})
```

关键安全设计：

1. **`getAutoMemPathSetting()` 排除了 projectSettings**：

```typescript
// SECURITY: projectSettings (.claude/settings.json committed to the repo) is
// intentionally excluded — a malicious repo could otherwise set
// autoMemoryDirectory: "~/.ssh" and gain silent write access to sensitive
// directories via the filesystem.ts write carve-out
function getAutoMemPathSetting(): string | undefined {
  const dir =
    getSettingsForSource('policySettings')?.autoMemoryDirectory ??
    getSettingsForSource('flagSettings')?.autoMemoryDirectory ??
    getSettingsForSource('localSettings')?.autoMemoryDirectory ??
    getSettingsForSource('userSettings')?.autoMemoryDirectory
  // 注意：没有 projectSettings！
  return validateMemoryPath(dir, true)
}
```

如果允许项目级 settings.json 设置 `autoMemoryDirectory`，恶意仓库可以把记忆目录指向 `~/.ssh`，然后通过 Auto Memory 的写入权限覆盖用户的 SSH 密钥。

2. **`validateMemoryPath()` 的路径验证**：

```typescript
function validateMemoryPath(raw: string | undefined, expandTilde: boolean) {
  // 拒绝：相对路径、根路径、Windows 驱动器根、UNC 路径、null 字节
  if (!isAbsolute(normalized) || normalized.length < 3 ||
      /^[A-Za-z]:$/.test(normalized) || normalized.startsWith('\\\\') ||
      normalized.includes('\0')) {
    return undefined
  }
  return (normalized + sep).normalize('NFC')
}
```

3. **Git Worktree 共享**：同一个 git 仓库的所有 worktree 共享同一个记忆目录：

```typescript
// 使用 canonical git root（而非 worktree root）作为路径键
function getAutoMemBase(): string {
  return findCanonicalGitRoot(getProjectRoot()) ?? getProjectRoot()
}
```

这确保了在 worktree 中工作时，记忆不会被分散到不同的目录中。

### MEMORY.md 索引的截断机制

MEMORY.md 被完整注入到每次对话的 System Prompt 中，所以它的大小直接影响 token 消耗。源码设置了双重上限：

```typescript
// memdir/memdir.ts
export const MAX_ENTRYPOINT_LINES = 200
export const MAX_ENTRYPOINT_BYTES = 25_000  // ~125 chars/line at 200 lines

export function truncateEntrypointContent(raw: string): EntrypointTruncation {
  // 先按行截断（自然边界）
  let truncated = wasLineTruncated
    ? contentLines.slice(0, MAX_ENTRYPOINT_LINES).join('\n')
    : trimmed

  // 再按字节截断（在最后一个换行处切割，不切断行）
  if (truncated.length > MAX_ENTRYPOINT_BYTES) {
    const cutAt = truncated.lastIndexOf('\n', MAX_ENTRYPOINT_BYTES)
    truncated = truncated.slice(0, cutAt > 0 ? cutAt : MAX_ENTRYPOINT_BYTES)
  }

  // 附加警告，告诉模型索引被截断了
  return {
    content: truncated + `\n\n> WARNING: MEMORY.md is ${reason}...`,
    ...
  }
}
```

为什么需要字节上限？源码注释解释了：

```
// ~125 chars/line at 200 lines. At p97 today; catches long-line indexes that
// slip past the line cap (p100 observed: 197KB under 200 lines).
```

有些用户的 MEMORY.md 虽然不到 200 行，但每行非常长（比如把完整的记忆内容写在索引里而不是单独的文件中），导致总字节数远超预期。字节上限是对这种边缘情况的防护。

### 记忆召回：动态相关性选择

除了 MEMORY.md 索引始终在 System Prompt 中，Auto Memory 还支持**动态召回**——根据当前查询选择最相关的记忆文件：

```typescript
// memdir/findRelevantMemories.ts
export async function findRelevantMemories(
  query: string,
  memoryDir: string,
  signal: AbortSignal,
  recentTools: readonly string[] = [],
  alreadySurfaced: ReadonlySet<string> = new Set(),
): Promise<RelevantMemory[]> {
  // ① 扫描所有 .md 文件的 frontmatter（不读取完整内容）
  const memories = await scanMemoryFiles(memoryDir, signal)

  // ② 用 Sonnet 选择最多 5 个相关文件
  const selectedFilenames = await selectRelevantMemories(
    query, memories, signal, recentTools
  )

  return selected.map(m => ({ path: m.filePath, mtimeMs: m.mtimeMs }))
}
```

选择过程使用了一个轻量级的 `sideQuery`（独立的 Sonnet API 调用），而不是让主模型自己决定读哪些文件。这个设计的原因是：

1. **主模型不知道有哪些记忆文件**——它只看到 MEMORY.md 索引，不知道每个文件的详细内容
2. **Sonnet 比 Opus 便宜得多**——用 Sonnet 做初筛，只把真正相关的文件内容传给主模型
3. **结构化输出**——使用 JSON schema 确保返回格式可靠

```typescript
const result = await sideQuery({
  model: getDefaultSonnetModel(),
  system: SELECT_MEMORIES_SYSTEM_PROMPT,
  messages: [{ role: 'user', content: `Query: ${query}\n\nAvailable memories:\n${manifest}` }],
  max_tokens: 256,
  output_format: {
    type: 'json_schema',
    schema: {
      type: 'object',
      properties: {
        selected_memories: { type: 'array', items: { type: 'string' } },
      },
    },
  },
})
```

### 记忆新鲜度与漂移防护

记忆会过时。源码中有两个机制来应对这个问题：

**1. 新鲜度警告**（`memdir/memoryAge.ts`）：超过 1 天的记忆会被标记为"可能过时"，提醒模型在使用前验证。

**2. 漂移防护指令**（`memdir/memoryTypes.ts`）：

```typescript
export const TRUSTING_RECALL_SECTION: readonly string[] = [
  '## Before recommending from memory',
  '',
  'A memory that names a specific function, file, or flag is a claim that it existed *when the memory was written*. It may have been renamed, removed, or never merged. Before recommending it:',
  '',
  '- If the memory names a file path: check the file exists.',
  '- If the memory names a function or flag: grep for it.',
  '- If the user is about to act on your recommendation, verify first.',
  '',
  '"The memory says X exists" is not the same as "X exists now."',
]
```

这段指令的设计经过了 eval 验证（源码注释中提到了具体的 eval case 和通过率）。关键洞察是：**记忆中的"事实"是时间快照，不是当前真相。** 模型必须在推荐之前验证记忆中提到的文件/函数是否仍然存在。

### 设计决策讨论

**为什么记忆存储在文件系统而不是数据库？**

文件系统作为存储有几个独特优势：

1. **模型原生可操作**：Claude Code 的工具集（Read/Write/Edit/Grep）天然支持文件操作，不需要额外的数据库工具
2. **用户可直接查看和编辑**：用户可以用任何文本编辑器查看、修改、删除记忆文件
3. **Git 友好**：团队记忆可以通过 Git 版本控制（虽然当前实现用的是 HTTP API 同步）
4. **零依赖**：不需要安装数据库，不需要后台服务

代价是缺乏结构化查询能力（不能 `SELECT * WHERE type='feedback'`），但通过 frontmatter + Grep 可以近似实现。

**为什么提取代理有 `maxTurns: 5` 的硬上限？**

源码注释说得很清楚：

```typescript
// Well-behaved extractions complete in 2-4 turns (read → write).
// A hard cap prevents verification rabbit-holes from burning turns.
maxTurns: 5,
```

提取代理的理想行为是：Turn 1 并行读取所有需要更新的文件，Turn 2 并行写入所有更新。如果超过 5 轮，说明代理陷入了"验证兔子洞"——比如读了一个记忆文件，发现内容可能过时，然后去 grep 代码验证，然后发现更多需要更新的东西……这种发散行为会消耗大量 token 而收益递减。

**为什么 feedback 类型要同时记录纠正和确认？**

```typescript
// 源码中的 when_to_save 指导：
'Any time the user corrects your approach ("no not that", "don\'t", "stop doing X")
 OR confirms a non-obvious approach worked ("yes exactly", "perfect, keep doing that",
 accepting an unusual choice without pushback). Corrections are easy to notice;
 confirmations are quieter — watch for them.'
```

这是一个深思熟虑的设计。如果只记录纠正，模型会变得过度保守——它知道什么不该做，但不知道什么该继续做。记录确认可以锚定"已验证的好做法"，防止模型在避免错误的过程中偏离正确的方向。

---

## 14.4 Session Memory：会话内的滚动摘要

### 面临的问题

Auto Memory 解决了跨会话的记忆问题，但还有一个同样重要的问题：**单次会话内的上下文丢失。**

当一次对话变得很长时（比如一个复杂的重构任务，涉及几十个文件、上百次工具调用），上下文窗口会被填满。此时 Claude Code 需要执行**上下文压缩（Compact）**——丢弃旧的消息，只保留最近的部分。

但压缩意味着信息丢失。模型可能忘记：
- 当前任务的整体目标是什么
- 已经完成了哪些步骤，还剩哪些
- 之前遇到了什么错误，是怎么解决的
- 用户提到的关键约束和偏好

**核心矛盾：上下文窗口有限 vs 长会话需要保持连贯性。**

### 解法：后台维护的结构化会话笔记

Session Memory 的核心思路是：**在压缩发生之前，用一个后台代理持续维护一份结构化的会话摘要。** 当压缩发生时，这份摘要被注入到压缩后的上下文中，作为"被丢弃的历史"的替代品。

```
会话进行中：

  主对话循环
    ↓ (每轮结束后)
  postSamplingHook 触发
    ↓
  shouldExtractMemory() 检查阈值
    ├─ 上下文 tokens < 10,000 → 跳过（对话还太短）
    ├─ 距上次提取增长 < 5,000 tokens → 跳过（变化不够大）
    ├─ 工具调用次数 < 3 → 跳过（工作量不够）
    └─ 阈值满足 → 触发提取
    ↓
  extractSessionMemory() (forked agent)
    → 读取当前 summary.md
    → 用 Edit 工具更新各个 section
    → 写回 summary.md

压缩发生时：

  autoCompact 触发
    ↓
  trySessionMemoryCompaction()
    → waitForSessionMemoryExtraction()  // 等待进行中的提取完成
    → getSessionMemoryContent()         // 读取 summary.md
    → 将摘要注入压缩后的上下文
    → 丢弃旧消息，保留最近的 10K-40K tokens
```

### Session Memory 的模板结构

Session Memory 使用一个固定的模板结构，确保摘要的组织方式一致：

```typescript
// services/SessionMemory/prompts.ts
export const DEFAULT_SESSION_MEMORY_TEMPLATE = `
# Session Title
_A short and distinctive 5-10 word descriptive title for the session_

# Current State
_What is actively being worked on right now? Pending tasks not yet completed._

# Task specification
_What did the user ask to build? Any design decisions or other explanatory context_

# Files and Functions
_What are the important files? In short, what do they contain and why are they relevant?_

# Workflow
_What bash commands are usually run and in what order?_

# Errors & Corrections
_Errors encountered and how they were fixed. What did the user correct?_

# Codebase and System Documentation
_What are the important system components? How do they work/fit together?_

# Learnings
_What has worked well? What has not? What to avoid?_

# Key results
_If the user asked a specific output, repeat the exact result here_

# Worklog
_Step by step, what was attempted, done? Very terse summary for each step_
`
```

这个模板的设计经过了仔细考量：

- **Current State** 排在最前面——压缩后最重要的是知道"现在在做什么"
- **Task specification** 保留原始需求——防止压缩后偏离目标
- **Errors & Corrections** 记录失败——防止重复犯错
- **Worklog** 记录进展——防止重复已完成的工作

用户可以通过 `~/.claude/session-memory/config/template.md` 自定义模板。

### 提取阈值：何时触发

Session Memory 的提取不是每轮都触发的——它有一套精心设计的阈值系统：

```typescript
// services/SessionMemory/sessionMemoryUtils.ts
export const DEFAULT_SESSION_MEMORY_CONFIG: SessionMemoryConfig = {
  minimumMessageTokensToInit: 10000,    // 首次提取的最低 token 数
  minimumTokensBetweenUpdate: 5000,     // 两次提取之间的最低 token 增长
  toolCallsBetweenUpdates: 3,           // 两次提取之间的最低工具调用次数
}
```

触发逻辑（`shouldExtractMemory()`）：

```typescript
export function shouldExtractMemory(messages: Message[]): boolean {
  const currentTokenCount = tokenCountWithEstimation(messages)

  // 阶段 1：初始化门控
  if (!isSessionMemoryInitialized()) {
    if (!hasMetInitializationThreshold(currentTokenCount)) {
      return false  // 对话还太短，不值得提取
    }
    markSessionMemoryInitialized()
  }

  // 阶段 2：双阈值检查
  const hasMetTokenThreshold = hasMetUpdateThreshold(currentTokenCount)
  const hasMetToolCallThreshold = toolCallsSinceLastUpdate >= getToolCallsBetweenUpdates()
  const hasToolCallsInLastTurn = hasToolCallsInLastAssistantTurn(messages)

  // 触发条件（token 阈值始终必须满足）：
  //   (tokens ✓ AND toolCalls ✓)  — 正常工作中
  //   (tokens ✓ AND 最后一轮无工具调用) — 自然对话断点
  return (hasMetTokenThreshold && hasMetToolCallThreshold) ||
         (hasMetTokenThreshold && !hasToolCallsInLastTurn)
}
```

这个设计的关键洞察是：

1. **Token 阈值是硬性要求**——即使工具调用次数达标，如果上下文增长不够，也不提取。这防止了"用户连续发了几条短消息"导致的过度提取。

2. **"自然断点"触发**——当最后一轮没有工具调用时（模型只是在回答问题），这是一个自然的对话断点，适合提取。

3. **配置可远程调整**——阈值通过 GrowthBook feature flag 远程配置，可以在不发版的情况下调优。

### 提取代理的工具权限

Session Memory 的提取代理比 Auto Memory 的更加严格——它**只能编辑一个特定的文件**：

```typescript
// services/SessionMemory/sessionMemory.ts
export function createMemoryFileCanUseTool(memoryPath: string): CanUseToolFn {
  return async (tool, input) => {
    // 只允许 Edit 工具，且只能编辑 memoryPath 这一个文件
    if (tool.name === FILE_EDIT_TOOL_NAME &&
        typeof input === 'object' && input !== null &&
        'file_path' in input && input.file_path === memoryPath) {
      return { behavior: 'allow', updatedInput: input }
    }
    return { behavior: 'deny', message: `only Edit on ${memoryPath} is allowed` }
  }
}
```

为什么这么严格？因为 Session Memory 的提取代理不需要读取任何文件——它已经通过 forked agent 模式共享了主对话的完整上下文。它唯一需要做的就是根据对话内容更新 summary.md。

### Session Memory 与 Compact 的集成

Session Memory 的最终价值在压缩时体现。当 autoCompact 触发时，`trySessionMemoryCompaction()` 会：

```typescript
// services/compact/sessionMemoryCompact.ts

// 压缩配置
export const DEFAULT_SM_COMPACT_CONFIG: SessionMemoryCompactConfig = {
  minTokens: 10_000,       // 压缩后至少保留 10K tokens 的消息
  minTextBlockMessages: 5,  // 至少保留 5 条有文本内容的消息
  maxTokens: 40_000,       // 压缩后最多保留 40K tokens
}
```

压缩流程：

1. **等待进行中的提取完成**（最多 15 秒超时）
2. **读取 summary.md 内容**
3. **检查摘要是否为空**（如果只是模板没有内容，回退到传统压缩）
4. **截断过长的 section**（每个 section 最多 ~2000 tokens）
5. **构建压缩后的消息序列**：
   - 压缩边界标记（SystemMessage）
   - Session Memory 摘要（作为 UserMessage 注入）
   - 保留的最近消息（10K-40K tokens）

```
压缩前：
  [System Prompt] [msg1] [msg2] ... [msg50] [msg51] ... [msg100]
                  ←── 旧消息（将被丢弃）──→  ←── 保留 ──→

压缩后：
  [System Prompt] [Compact Boundary] [Session Memory Summary] [msg51] ... [msg100]
                  ↑                  ↑
                  标记压缩发生        替代被丢弃的历史
```

### 设计决策讨论

**为什么 Session Memory 和 Auto Memory 是分开的系统？**

它们解决的是不同时间尺度的问题：

- **Session Memory** 是**会话级**的——记录"这次对话在做什么"，压缩后注入，会话结束后不再需要
- **Auto Memory** 是**跨会话**的——记录"用户是谁、项目在做什么"，永久保存

如果合并成一个系统，要么跨会话记忆被会话级细节淹没（"正在编辑 auth.ts 的第 42 行"不值得跨会话保存），要么会话级摘要缺乏足够的细节（"用户是后端工程师"对当前任务没有直接帮助）。

**为什么 Session Memory 用固定模板而不是自由格式？**

固定模板有两个关键优势：

1. **可预测的结构**：压缩时可以按 section 截断，不会切断语义单元
2. **引导提取质量**：模板的 section 名称和描述告诉提取代理应该关注什么，避免提取出无用的信息

自由格式的风险是提取代理可能写出冗长的叙述性文本，在压缩时难以有效截断。

**为什么提取使用 `sequential()` 包装？**

```typescript
const extractSessionMemory = sequential(async function (context) { ... })
```

`sequential()` 确保同一时间只有一个提取在运行。如果主对话循环很快（用户连续发送多条消息），多个 postSamplingHook 可能同时触发。没有 `sequential()`，多个提取代理会并发编辑同一个 summary.md，导致内容冲突。

**为什么 `waitForSessionMemoryExtraction()` 有 15 秒超时？**

```typescript
const EXTRACTION_WAIT_TIMEOUT_MS = 15000
const EXTRACTION_STALE_THRESHOLD_MS = 60000 // 1 minute
```

压缩时需要等待进行中的提取完成，否则摘要可能不包含最新的对话内容。但不能无限等待——如果提取代理卡住了（比如 API 超时），压缩不应该被阻塞。15 秒是一个平衡点：正常提取通常在几秒内完成，15 秒足够等待；如果超过 15 秒，说明出了问题，继续压缩比等待更好。

额外的 60 秒"过期"检查防止了一种边缘情况：如果 `markExtractionStarted()` 被调用但 `markExtractionCompleted()` 因为异常没有被调用，`extractionStartedAt` 会永远非空。60 秒后认为这个状态是过期的，不再等待。

---

## 14.5 Team Memory：跨用户的记忆同步

### 面临的问题

Auto Memory 解决了个人的跨会话记忆问题，但在团队协作场景中还有一个缺口：**一个团队成员教会 Claude 的东西，其他成员无法受益。**

比如：
- Alice 告诉 Claude "pipeline bug 在 Linear 的 INGEST 项目里追踪"——Bob 不知道
- Bob 告诉 Claude "周四后冻结非关键合并"——Alice 不知道
- Charlie 发现了一个 API 的 gotcha 并让 Claude 记住——整个团队都应该知道

**核心矛盾：记忆是个人的，但很多知识是团队共享的。**

### 解法：基于 HTTP API 的双向同步

Team Memory 在 Auto Memory 的基础上增加了一个 `team/` 子目录，通过 HTTP API 与服务器双向同步：

```
本地文件系统                              服务器
~/.claude/projects/<hash>/memory/team/    /api/claude_code/team_memory
├── MEMORY.md                             ?repo={owner/repo}
├── feedback_testing.md          ←─ Pull ─→
├── project_freeze.md            ←─ Push ─→
└── reference_linear.md          ←─ Sync ─→
```

### 同步架构

```
┌─────────────────────────────────────────────────────────────┐
│                   Team Memory Watcher                        │
│                                                             │
│  启动时：                                                    │
│    isTeamMemoryEnabled() ──→ isTeamMemorySyncAvailable()    │
│    ──→ getGithubRepo() ──→ pullTeamMemory()                 │
│    ──→ startFileWatcher()                                   │
│                                                             │
│  运行时：                                                    │
│    fs.watch(team/, {recursive: true})                       │
│      │                                                      │
│      ▼                                                      │
│    schedulePush() ──[2s debounce]──→ executePush()          │
│      │                                │                     │
│      │                                ▼                     │
│      │                          pushTeamMemory()            │
│      │                            ├─ readLocalTeamMemory()  │
│      │                            ├─ computeDelta()         │
│      │                            ├─ batchDeltaByBytes()    │
│      │                            └─ uploadTeamMemory()     │
│      │                                ├─ 200 OK → 更新 ETag │
│      │                                ├─ 412 Conflict       │
│      │                                │   → fetchHashes()   │
│      │                                │   → retry           │
│      │                                └─ 413 Too Many       │
│      │                                    → learn max_entries│
│  关闭时：                                                    │
│    stopTeamMemoryWatcher()                                  │
│      ├─ clearTimeout(debounce)                              │
│      ├─ watcher.close()                                     │
│      ├─ await currentPushPromise                            │
│      └─ flush pending changes                               │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 核心源码解读

**同步状态管理**（`services/teamMemorySync/index.ts`）：

```typescript
export type SyncState = {
  /** 最后已知的服务器 ETag，用于条件请求 */
  lastKnownChecksum: string | null
  /** 每个 key 的内容哈希，用于计算 delta */
  serverChecksums: Map<string, string>
  /** 服务器强制的最大条目数，从 413 响应中学习 */
  serverMaxEntries: number | null
}
```

所有可变状态都封装在 `SyncState` 对象中，由 watcher 创建并传递给所有同步函数。这避免了模块级可变状态，也让测试可以自然隔离。

**Pull 语义：服务器赢**

```
GET /api/claude_code/team_memory?repo={owner/repo}
  → 200: 返回所有条目 + entryChecksums
  → 304: 未修改（ETag 匹配）
  → 404: 无数据

Pull 将服务器内容覆盖本地文件（server wins per-key）。
```

**Push 语义：Delta 上传**

Push 不是全量上传，而是只上传**内容哈希与 serverChecksums 不同的 key**：

```typescript
// 计算 delta：只上传变化的条目
export function hashContent(content: string): string {
  return 'sha256:' + createHash('sha256').update(content, 'utf8').digest('hex')
}

// push 时比较本地哈希与 serverChecksums
// 只有不同的 key 才会被上传
```

**冲突解决：乐观锁 + 重试**

```
PUT /api/claude_code/team_memory?repo={owner/repo}
  Headers: If-Match: "<etag>"
  Body: { entries: { "key": "content", ... } }

  → 200: 成功，更新 ETag
  → 412 Precondition Failed: ETag 不匹配（其他用户已修改）
    → fetchTeamMemoryHashes() 刷新 serverChecksums
    → 重新计算 delta
    → 重试（最多 2 次）
  → 413 Too Many Entries: 超过服务器条目限制
    → 学习 max_entries 限制
    → 后续 push 截断到限制内
```

**批量上传：网关体积限制**

```typescript
// services/teamMemorySync/index.ts
const MAX_PUT_BODY_BYTES = 200_000  // 200KB per batch
const MAX_FILE_SIZE_BYTES = 250_000 // 250KB per file

export function batchDeltaByBytes(delta: Record<string, string>): Array<Record<string, string>> {
  // 贪心装箱：按 key 排序（确定性），每批 ≤200KB
  // 单个条目可超过 200KB（但 ≤250KB）——独占一批
  // 多批顺序 PUT，服务器 upsert 语义保证安全
}
```

为什么是 200KB？源码注释详细解释了：

```
// Gateway body-size cap. The API gateway rejects PUT bodies over ~256-512KB
// with an unstructured (HTML) 413 before the request reaches the app server —
// distinguishable from the app's structured entry-count 413 only by latency.
// 200KB leaves headroom under the observed threshold.
```

这是一个典型的**从生产事故中学到的教训**——之前没有批量限制时，冷启动 push 发送了 300KB-1.4MB 的 body，触发了网关的体积限制。

### 文件系统监视：平台差异处理

Watcher 使用 Node.js 原生的 `fs.watch` 而不是 chokidar：

```typescript
// services/teamMemorySync/watcher.ts
watcher = watch(teamDir, { persistent: true, recursive: true }, (_eventType, filename) => {
  // fs.watch 不区分 add/change/unlink — 都是 'rename'
  // 需要 stat 来判断是否是删除（ENOENT → unlink）
  if (pushSuppressedReason !== null) {
    void stat(join(teamDir, filename)).catch((err) => {
      if (err.code === 'ENOENT') {
        pushSuppressedReason = null  // 删除文件清除抑制
        schedulePush()
      }
    })
    return
  }
  schedulePush()
})
```

源码注释解释了为什么不用 chokidar：

```
// chokidar 4+ dropped fsevents, and Bun's fs.watch fallback uses kqueue,
// which requires one open fd per watched file — with 500+ team memory files
// that's 500+ permanently-held fds.
//
// recursive: true on macOS uses FSEvents — O(1) fds regardless of tree size
// (verified: 2 fds for 60 files across 5 subdirs).
```

### 永久失败抑制：防止无限重试

一个关键的防御性设计是**永久失败抑制**：

```typescript
// 永久失败 = 重试不会自愈
function isPermanentFailure(r: TeamMemorySyncPushResult): boolean {
  if (r.errorType === 'no_oauth' || r.errorType === 'no_repo') return true
  if (r.httpStatus >= 400 && r.httpStatus < 500 &&
      r.httpStatus !== 409 && r.httpStatus !== 429) return true
  return false
}
```

当 push 遇到永久失败时，watcher 会**抑制后续所有 push 尝试**，直到用户删除文件（触发 unlink 事件）或重启会话。

这个设计源于一个真实的生产问题：

```
// BQ Mar 14-16: one no_oauth device emitted 167K push events over 2.5 days
```

一个没有 OAuth 认证的设备，因为其他会话写入了 team/ 目录触发了 fs.watch 事件，每次事件都尝试 push 并失败，2.5 天内产生了 167K 次无效请求。永久失败抑制机制就是为了防止这种情况。

### 秘密防护：上传前扫描

Team Memory 的内容会被同步到服务器，所以必须防止敏感信息泄露。`secretScanner.ts` 实现了一个基于 gitleaks 规则的客户端扫描器：

```typescript
// services/teamMemorySync/secretScanner.ts
const SECRET_RULES: SecretRule[] = [
  // 云服务商
  { id: 'aws-access-token', source: '\\b((?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16})\\b' },
  { id: 'gcp-api-key', source: '\\b(AIza[\\w-]{35})...' },
  // AI API
  { id: 'anthropic-api-key', source: `\\b(${ANT_KEY_PFX}03-...)...` },
  { id: 'openai-api-key', source: '\\b(sk-(?:proj|svcacct|admin)-...)...' },
  // 版本控制
  { id: 'github-pat', source: 'ghp_[0-9a-zA-Z]{36}' },
  // ... 30+ 规则
]
```

注意一个巧妙的细节——Anthropic API key 的前缀是**运行时拼接**的：

```typescript
const ANT_KEY_PFX = ['sk', 'ant', 'api'].join('-')
```

源码注释解释了原因：

```
// assembled at runtime so the literal byte sequence isn't present
// in the external bundle (excluded-strings check)
```

如果直接写 `sk-ant-api`，这个字符串会出现在编译后的 bundle 中，可能触发安全扫描工具的误报。通过运行时拼接，bundle 中不包含完整的 key 前缀。

### 路径遍历防护

Team Memory 的 key（文件名）来自本地文件系统，但会被发送到服务器。`teamMemPaths.ts` 中的 `validateTeamMemKey()` 防止路径遍历攻击：

```typescript
// memdir/teamMemPaths.ts
export function validateTeamMemKey(key: string, teamDir: string): void {
  // 1. sanitizePathKey() → 检查空字节、URL 编码、Unicode 规范化
  // 2. resolve() → 消除 .. 段
  // 3. realpathDeepestExisting() → 解析符号链接
  // 4. isRealPathWithinTeamDir() → 验证真实路径在 team/ 内
}
```

这防止了一种攻击：如果服务器返回的 key 包含 `../../.ssh/authorized_keys`，pull 操作可能会覆盖用户的 SSH 配置。

### 设计决策讨论

**为什么删除不传播？**

```
// File deletions do NOT propagate: deleting a local file won't remove it
// from the server, and the next pull will restore it locally.
```

这是一个**安全优先**的设计。如果删除传播，一个团队成员的误操作（或恶意操作）可以删除所有团队记忆。不传播删除意味着：

- 删除是本地的、可恢复的（下次 pull 会恢复）
- 服务器上的数据只增不减（除非通过管理界面操作）
- 最坏情况是某个成员看不到某条记忆，而不是所有人都丢失

**为什么用 HTTP API 而不是 Git？**

Git 是一个自然的选择——团队记忆可以作为 Git 仓库的一部分同步。但 HTTP API 有几个优势：

1. **不污染 Git 历史**：记忆文件的频繁更新会产生大量 commit，干扰项目的 Git 历史
2. **不需要 Git 权限**：有些团队成员可能只有读权限，但应该能贡献记忆
3. **服务器端控制**：可以实施条目数限制、秘密扫描、审计日志等策略
4. **实时性**：Git push/pull 需要用户主动操作，HTTP API 可以后台自动同步

**为什么 Watcher 在 pull 之后才启动？**

```typescript
// Initial pull from server (runs before the watcher starts, so its disk
// writes won't trigger schedulePush)
const pullResult = await pullTeamMemory(syncState)
// ...
await startFileWatcher(getTeamMemPath())
```

如果先启动 watcher 再 pull，pull 写入本地文件会触发 watcher 的 push，形成一个无意义的"pull → push 回去"循环。先 pull 再启动 watcher 避免了这个问题。

---

## 14.6 端到端数据流：记忆如何流经整个系统

把前面四层记忆系统串联起来，看一个完整的数据流：

```
会话启动
  │
  ├─ getMemoryFiles()
  │   ├─ 加载 CLAUDE.md 层级（Managed → User → Project → Local）
  │   ├─ 加载 MEMORY.md（Auto Memory 索引）
  │   └─ 加载 team/MEMORY.md（Team Memory 索引）
  │
  ├─ startTeamMemoryWatcher()
  │   ├─ pullTeamMemory() → 从服务器拉取最新团队记忆
  │   └─ startFileWatcher() → 监视 team/ 目录变化
  │
  ├─ initSessionMemory()
  │   └─ registerPostSamplingHook(extractSessionMemory)
  │
  └─ initExtractMemories()
      └─ 注册 stop hook（每轮结束后触发）

对话进行中
  │
  ├─ 每次 API 调用
  │   ├─ System Prompt 包含：
  │   │   ├─ 记忆系统指令（四类分类法、保存方式、不保存的内容）
  │   │   ├─ MEMORY.md 索引内容
  │   │   └─ CLAUDE.md 所有层级的规则
  │   │
  │   └─ 动态召回（findRelevantMemories）
  │       └─ Sonnet 选择最多 5 个相关记忆文件注入
  │
  ├─ 主代理可能直接写入记忆
  │   └─ FileWriteTool → memory/feedback_testing.md
  │       └─ 如果写入 team/ → fs.watch 触发 → schedulePush()
  │
  ├─ 每轮结束后（postSamplingHook）
  │   ├─ extractSessionMemory()
  │   │   └─ 更新 session-memory/summary.md
  │   │
  │   └─ extractMemories()（stop hook）
  │       ├─ hasMemoryWritesSince() → 主代理已写入？跳过
  │       └─ runForkedAgent() → 后台提取记忆
  │
  └─ 上下文压缩时（autoCompact）
      ├─ trySessionMemoryCompaction()
      │   ├─ waitForSessionMemoryExtraction()
      │   ├─ getSessionMemoryContent() → 读取 summary.md
      │   └─ 注入压缩后的上下文
      │
      └─ resetGetMemoryFilesCache()
          └─ 重新加载 CLAUDE.md（可能已被用户编辑）

会话结束
  │
  ├─ stopTeamMemoryWatcher()
  │   └─ flush pending changes → 最后一次 push
  │
  └─ drainExtractMemories()
      └─ 等待进行中的提取完成
```

### 缓存策略总结

记忆系统涉及大量的文件 I/O 和 API 调用，缓存是性能的关键：

| 缓存对象 | 缓存方式 | 失效时机 | 原因 |
|---------|---------|---------|------|
| `getAutoMemPath()` | `memoize`（按 projectRoot 键） | 会话内不失效 | 路径在会话内不变 |
| `getMemoryFiles()` | `memoize` | compact 后手动清除 | 文件可能被用户编辑 |
| `getUserContext()` | `memoize` | 会话内不失效 | CLAUDE.md 在会话内视为不变 |
| `getSystemContext()` | `memoize` | 会话内不失效 | Git 状态是启动快照 |
| Session Memory config | `memoize`（一次性初始化） | 会话内不失效 | 远程配置在会话内视为稳定 |
| `serverChecksums` | `SyncState` 对象 | 每次 pull/push 更新 | 需要反映服务器最新状态 |

### 安全边界总结

记忆系统的安全设计贯穿每一层：

```
CLAUDE.md 层：
  ✓ @include 外部文件默认禁止（Project 类型）
  ✓ 文本文件白名单（防止加载二进制文件）
  ✓ 最大深度限制（防止无限递归）
  ✓ claudeMdExcludes 排除机制

Auto Memory 层：
  ✓ projectSettings 不能设置 autoMemoryDirectory（防止恶意仓库）
  ✓ 路径验证（拒绝相对路径、根路径、UNC 路径、null 字节）
  ✓ 提取代理工具权限严格限制（只读 + memdir 内写入）
  ✓ maxTurns 硬上限（防止 token 浪费）

Session Memory 层：
  ✓ 提取代理只能编辑一个特定文件
  ✓ 目录权限 0o700（仅所有者）
  ✓ 文件权限 0o600（仅所有者读写）

Team Memory 层：
  ✓ 秘密扫描（30+ gitleaks 规则，上传前检查）
  ✓ 路径遍历防护（validateTeamMemKey）
  ✓ 永久失败抑制（防止无限重试）
  ✓ 乐观锁（ETag + If-Match）
  ✓ 批量大小限制（200KB per batch）
  ✓ 删除不传播（防止误删/恶意删除）
```

---

## 14.7 设计哲学与 Trade-off 总结

回顾整个记忆系统的设计，有几个贯穿始终的哲学：

### 1. "只记住不可推导的"

这是记忆类型分类法的核心原则。代码模式可以 grep，Git 历史可以 git log，架构可以从文件结构推断——这些都不需要记忆。记忆的价值在于那些**只存在于人脑中的知识**：用户是谁、为什么做这个决策、上次犯了什么错。

这个原则大幅减少了记忆的体积，也提高了记忆的信噪比。

### 2. "主代理优先，后台兜底"

Auto Memory 的双路径设计（主代理直接写入 vs 后台提取代理）体现了一个务实的策略：

- 主代理在对话中有最好的上下文理解，它的记忆写入质量最高
- 但主代理不总是会主动写记忆（它可能忙于完成用户的任务）
- 后台提取代理作为兜底，确保有价值的信息不会丢失
- 两者互斥，避免重复写入

### 3. "文件系统即数据库"

整个记忆系统建立在文件系统之上，没有引入任何数据库。这不是技术限制，而是刻意的设计选择：

- 文件系统是 Claude Code 工具集的原生操作对象
- 用户可以直接查看、编辑、删除记忆文件
- 不需要额外的依赖和后台服务
- 与 Git 工作流自然兼容

代价是缺乏结构化查询能力，但通过 frontmatter + Sonnet 选择器弥补了这个不足。

### 4. "安全是非功能性需求中的第一优先级"

从 CLAUDE.md 的 @include 外部文件门控，到 Auto Memory 的 projectSettings 排除，到 Team Memory 的秘密扫描和路径遍历防护——安全考量渗透在每一个设计决策中。

特别值得注意的是，很多安全设计来自**真实的攻击场景分析**（恶意仓库设置 autoMemoryDirectory 指向 ~/.ssh）和**生产事故复盘**（167K 次无效 push 请求）。这不是纸上谈兵的安全设计，而是经过实战检验的防御。

### 5. "渐进式复杂度"

四层记忆系统不是一次性设计出来的，而是随着需求的演进逐步添加的：

- CLAUDE.md 是最早的——解决"项目规则"问题
- Auto Memory 是第二个——解决"跨会话记忆"问题
- Session Memory 是第三个——解决"长会话压缩后的连贯性"问题
- Team Memory 是最新的——解决"团队知识共享"问题

每一层都建立在前一层的基础上，而不是推翻重来。这种渐进式的架构演进，让系统在保持向后兼容的同时不断增加能力。

---

## 14.8 Memory 命令与 UI：用户的记忆管理界面

### 面临的问题

记忆系统的大部分工作是自动化的——自动提取、自动同步、自动注入。但用户仍然需要一个**手动管理记忆的入口**：查看有哪些记忆文件、编辑它们、开关自动记忆功能。

### 解法：`/memory` 斜杠命令 + React 选择器组件

`/memory` 命令是用户与记忆系统交互的主要入口。它的实现分为两层：

**命令层**（`commands/memory/memory.tsx`）：

```typescript
// commands/memory/memory.tsx — 简化
export const call: LocalJSXCommandCall = async onDone => {
  // 清除缓存并重新加载（确保看到最新的文件列表）
  clearMemoryFileCaches()
  await getMemoryFiles()
  return <MemoryCommand onDone={onDone} />
}

function MemoryCommand({ onDone }) {
  const handleSelectMemoryFile = async (memoryPath: string) => {
    // 确保目录存在
    await mkdir(getClaudeConfigHomeDir(), { recursive: true })

    // 创建文件（如果不存在）— wx flag 在文件已存在时失败
    try {
      await writeFile(memoryPath, '', { encoding: 'utf8', flag: 'wx' })
    } catch (e) {
      if (getErrnoCode(e) !== 'EEXIST') throw e
    }

    // 用用户的编辑器打开文件
    await editFileInEditor(memoryPath)
    onDone(`Opened memory file at ${getRelativeMemoryPath(memoryPath)}`)
  }

  return (
    <Dialog title="Memory" color="remember">
      <MemoryFileSelector onSelect={handleSelectMemoryFile} onCancel={...} />
    </Dialog>
  )
}
```

**UI 层**（`components/memory/MemoryFileSelector.tsx`）：

MemoryFileSelector 是一个 React（Ink）组件，展示所有记忆文件的列表，支持：

- 列出所有已存在的 CLAUDE.md 文件（按类型分组：User、Project、Local 等）
- 显示 @include 的嵌套关系（缩进 + `L` 前缀）
- 提供"User memory"和"Project memory"的快捷入口（即使文件不存在也显示）
- "Open auto-memory folder"——在文件管理器中打开记忆目录
- "Open team memory folder"——在文件管理器中打开团队记忆目录
- Auto Memory 开关——通过 `updateSettingsForSource('userSettings', { autoMemoryEnabled })` 切换
- Auto Dream 开关——控制后台记忆整理功能

```
/memory 命令的 UI 结构：

┌─ Memory ──────────────────────────────────────┐
│                                               │
│  > User memory          Saved in ~/.claude/   │
│    Project memory       Checked in at ./      │
│    ./CLAUDE.md                                │
│      L ./coding-standards.md   @-imported     │
│    ./.claude/rules/testing.md                 │
│    Open auto-memory folder                    │
│    Open team memory folder                    │
│                                               │
│  [Auto memory: ON]  [Auto dream: ON]          │
│                                               │
│  Learn more: https://code.claude.com/...      │
└───────────────────────────────────────────────┘
```

### MemoryUpdateNotification：记忆更新通知

当后台提取代理写入了新的记忆文件时，`MemoryUpdateNotification` 组件会在对话中显示一条通知：

```
💾 Saved memory: feedback_testing.md
```

这个通知让用户知道 AI 记住了什么，保持了透明性——用户可以随时去查看和修改这些记忆文件。

### 设计决策讨论

**为什么用外部编辑器而不是内联编辑？**

`/memory` 命令调用 `editFileInEditor()`，使用 `$VISUAL` 或 `$EDITOR` 环境变量指定的编辑器打开文件。这比在终端内提供一个简陋的文本编辑器要好得多——用户可以用自己熟悉的编辑器（VS Code、Vim、Emacs）来编辑记忆文件，享受语法高亮、自动补全等功能。

**为什么 `/memory` 命令要先 `clearMemoryFileCaches()`？**

因为 `getMemoryFiles()` 是 memoized 的。如果用户在会话中手动编辑了 CLAUDE.md 文件（比如通过另一个终端窗口），缓存中的内容是过时的。清除缓存确保 `/memory` 命令总是显示最新的文件列表。

---

## 14.9 MagicDocs：自动维护的活文档

### 面临的问题

在开发过程中，团队经常需要维护一些"活文档"——比如系统架构概览、API 端点清单、部署流程说明。这些文档的特点是：

1. **需要随代码变化而更新**——但人们经常忘记更新
2. **内容来自对话中的知识**——开发者在讨论中提到的架构决策、调试经验等
3. **不适合放在 CLAUDE.md 中**——它们是参考文档，不是行为规则

### 解法：Magic Doc 头标记 + 后台自动更新

MagicDocs 是一个巧妙的机制：任何以 `# MAGIC DOC: [title]` 开头的 Markdown 文件，都会被 Claude Code 自动追踪和更新。

```markdown
# MAGIC DOC: System Architecture
_Keep this document updated with the latest architecture decisions and component relationships_

## Components
...（内容由 AI 自动维护）
```

### 工作原理

```
用户读取文件（FileReadTool）
  │
  ▼
registerFileReadListener 触发
  │
  ▼
detectMagicDocHeader() 检测 "# MAGIC DOC:" 头
  ├─ 未检测到 → 忽略
  └─ 检测到 → registerMagicDoc(filePath)
                → 加入 trackedMagicDocs Map

每轮对话结束后（postSamplingHook）
  │
  ▼
updateMagicDocs() (sequential 包装，防并发)
  ├─ 检查：querySource === 'repl_main_thread'？
  ├─ 检查：最后一轮有工具调用？→ 跳过（等待自然断点）
  └─ 遍历 trackedMagicDocs
      └─ updateMagicDoc(docInfo, context)
          ├─ FileReadTool 读取最新内容
          ├─ detectMagicDocHeader() 重新检测（文件可能已被修改）
          ├─ buildMagicDocsUpdatePrompt() 构建更新指令
          └─ runAgent() 运行 Sonnet 代理
              └─ 只允许 FileEditTool 编辑该文件
```

### 核心源码解读

**Magic Doc 检测**：

```typescript
// services/MagicDocs/magicDocs.ts
const MAGIC_DOC_HEADER_PATTERN = /^#\s*MAGIC\s+DOC:\s*(.+)$/im

export function detectMagicDocHeader(content: string):
  { title: string; instructions?: string } | null {
  const match = content.match(MAGIC_DOC_HEADER_PATTERN)
  if (!match) return null

  const title = match[1].trim()

  // 检查标题下一行是否有斜体指令（可选）
  // 例如：_Keep this document updated with..._
  const italicsMatch = nextLine.match(/^[_*](.+?)[_*]\s*$/m)
  if (italicsMatch) {
    return { title, instructions: italicsMatch[1].trim() }
  }

  return { title }
}
```

**更新代理的权限限制**：

```typescript
// 只允许 Edit 操作，且只能编辑这一个文件
const canUseTool = async (tool: Tool, input: unknown) => {
  if (tool.name === FILE_EDIT_TOOL_NAME &&
      typeof input === 'object' && input !== null &&
      'file_path' in input && input.file_path === docInfo.path) {
    return { behavior: 'allow', updatedInput: input }
  }
  return { behavior: 'deny', message: `only Edit for ${docInfo.path}` }
}
```

**初始化门控**：

```typescript
export async function initMagicDocs(): Promise<void> {
  if (process.env.USER_TYPE === 'ant') {  // 仅内部用户
    registerFileReadListener((filePath, content) => {
      if (detectMagicDocHeader(content)) {
        registerMagicDoc(filePath)
      }
    })
    registerPostSamplingHook(updateMagicDocs)
  }
}
```

注意 MagicDocs 目前仅对 Anthropic 内部用户（`USER_TYPE === 'ant'`）启用，说明这是一个实验性功能。

### 设计决策讨论

**为什么用文件头标记而不是文件扩展名或目录约定？**

文件头标记（`# MAGIC DOC:`）的优势是**零配置**——用户不需要把文件放在特定目录，不需要修改配置文件，只需要在文件开头加一行标记。这降低了使用门槛，也让 MagicDocs 可以应用于项目中任何位置的任何 Markdown 文件。

**为什么只在"自然断点"更新（最后一轮无工具调用）？**

如果模型正在执行一系列工具调用（比如编辑多个文件），中间插入 MagicDocs 更新会：
1. 消耗额外的 API 调用和 token
2. 可能基于不完整的状态更新文档（比如重构只完成了一半）

等到模型停下来（end_turn，无工具调用）再更新，确保文档反映的是一个相对完整的状态。

**MagicDocs 与 Auto Memory 的关系**

两者都是"后台自动维护"的机制，但目标不同：

- **Auto Memory** 维护的是**模型的内部知识**——用户画像、行为反馈、项目上下文
- **MagicDocs** 维护的是**用户可见的文档**——架构说明、API 清单、部署流程

Auto Memory 的输出注入到 System Prompt 中影响模型行为；MagicDocs 的输出是普通的 Markdown 文件，供人类阅读。
