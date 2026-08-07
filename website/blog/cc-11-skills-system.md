---
title: Claude Code 源码解析（十一）· Skills 系统
description: '通用 Agent 在垂直领域（PDF 处理、前端设计、API 开发）表现平平，如何通过预打包的 prompt + 工具组合让它变成领域专家？'
date: "2026-04-01"
series: Claude Code 源码解析
tags: [Claude Code, 源码解析, harness]
outline: 2
---

# 第十一章：Skills 系统（Skills System）

> 预定义的专业化工作流——让 Claude Code 在特定领域表现更出色。

## 核心问题

LLM 是通用的，但用户的任务是专业的。当用户说"帮我创建一个 PDF"、"帮我写一个 commit message"、"帮我做 code review"时，他们期望的不是一个从零开始摸索的通用助手，而是一个**已经知道该怎么做**的专家。

这引出了 Skills 系统要解决的核心矛盾：

1. **通用性 vs 专业性。** LLM 的 system prompt 空间有限（context window 是稀缺资源），不可能把所有领域的专业知识都塞进去。但用户在特定时刻只需要特定领域的专业能力。

2. **静态 vs 动态。** 内置的能力是编译时确定的，但用户的需求是运行时变化的。一个前端团队需要 "生成 React 组件" 的 skill，一个数据团队需要 "分析 CSV" 的 skill——这些不可能全部内置。

3. **安全 vs 开放。** Skill 本质上是"注入到 LLM 对话中的 prompt"，这意味着它可以改变 LLM 的行为、授予额外的工具权限、甚至执行 shell 命令。如何在开放扩展的同时保证安全？

4. **发现 vs 噪音。** 用户可能有几十个 skill，但每次对话只需要其中一两个。如何让模型在正确的时机发现并调用正确的 skill，而不是在 system prompt 中列出所有 skill 的完整内容（这会浪费大量 token）？

Claude Code 的 Skills 系统是对这些问题的统一回答：**一个按需加载的、多来源的、带权限控制的 prompt 注入框架。**

---

## 11.1 架构总览

```
┌─────────────────────────────────────────────────────────────────┐
│                     Skills 系统架构                               │
├─────────────────────────────────────────────────────────────────┤
│                                                                   │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────┐  ┌─────────┐ │
│  │ Bundled      │  │ File-based   │  │ Plugin    │  │ MCP     │ │
│  │ Skills       │  │ Skills       │  │ Skills    │  │ Skills  │ │
│  │ (编译时内置)  │  │ (磁盘 .md)   │  │ (DXT 插件) │  │ (远程)  │ │
│  └──────┬───────┘  └──────┬───────┘  └─────┬─────┘  └────┬────┘ │
│         │                 │                │              │       │
│         ▼                 ▼                ▼              ▼       │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │              Command 注册表 (commands.ts)                    │ │
│  │  统一类型: Command { type: 'prompt', source, loadedFrom }   │ │
│  └──────────────────────────┬──────────────────────────────────┘ │
│                             │                                     │
│              ┌──────────────┼──────────────┐                     │
│              ▼              ▼              ▼                      │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐           │
│  │ System Prompt │  │ SkillTool    │  │ /skill-name  │           │
│  │ skill_listing │  │ (模型调用)    │  │ (用户调用)    │           │
│  │ (发现层)      │  │ (执行层)      │  │ (执行层)      │           │
│  └──────────────┘  └──────┬───────┘  └──────┬───────┘           │
│                           │                 │                    │
│                           ▼                 ▼                    │
│                  ┌─────────────────────────────┐                 │
│                  │  getPromptForCommand()       │                 │
│                  │  ─────────────────────────── │                 │
│                  │  • $ARGUMENTS 替换            │                 │
│                  │  • ${CLAUDE_SKILL_DIR} 替换   │                 │
│                  │  • !`shell` 内联命令执行      │                 │
│                  │  • Base directory 注入        │                 │
│                  │  • Hooks 注册                 │                 │
│                  └──────────┬──────────────────┘                 │
│                             │                                     │
│                             ▼                                     │
│                  ┌─────────────────────────────┐                 │
│                  │  注入到对话上下文              │                 │
│                  │  (inline 或 fork 子代理)      │                 │
│                  └─────────────────────────────┘                 │
│                                                                   │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │  动态发现层                                                  │ │
│  │  • skillChangeDetector: 文件监听 → 缓存清除                  │ │
│  │  • discoverSkillDirsForPaths: 文件操作触发目录发现            │ │
│  │  • activateConditionalSkillsForPaths: 路径匹配激活条件 skill  │ │
│  └─────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

这个架构的核心设计决策是：**Skill 不是一种新的抽象，而是 Command 系统的一个特化。** 所有 Skill 最终都被表示为 `Command { type: 'prompt' }` 对象，复用了命令系统的注册、发现、执行基础设施。这避免了引入一套全新的抽象层，降低了系统复杂度。

---

## 11.2 Skill 的本质：一个带元数据的 Prompt

### 面临的问题

如何定义一个 "Skill"？最朴素的想法是：一段 markdown 文本，在需要时注入到对话中。但这远远不够——一个实用的 skill 需要：

- **元数据**：名称、描述、何时使用（供模型发现）
- **工具权限**：这个 skill 需要哪些工具（比如 PDF skill 需要 Bash 来调用 pdf 工具）
- **参数化**：用户可以传入参数（比如 `/commit -m "fix bug"`）
- **执行上下文**：是在当前对话中展开（inline），还是在子代理中执行（fork）
- **生命周期钩子**：skill 可以注册文件变更监听等 hooks
- **条件激活**：只在操作特定文件时才激活

### 解法：YAML Frontmatter + Markdown Body

Claude Code 选择了一个优雅的方案：**SKILL.md 文件 = YAML frontmatter（元数据）+ Markdown body（prompt 内容）**。

```yaml
---
name: My Skill
description: A skill that does something useful
when_to_use: When the user asks to do something specific
allowed-tools: [Bash, Read, Write]
argument-hint: "[file_path]"
context: fork
model: claude-sonnet-4-6
effort: high
paths: ["src/**/*.ts"]
hooks:
  onFileChange:
    - matcher: "*.ts"
      hooks:
        - command: "npm run lint"
          once: true
---

You are an expert at doing something specific.

When the user provides a file at $ARGUMENTS, you should:
1. Read the file using the Read tool
2. Analyze its contents
3. ...

Base files are available at ${CLAUDE_SKILL_DIR}/templates/
```

这个设计的关键洞察是：**Skill 的 "智能" 完全来自 prompt engineering，而不是代码。** 不需要写 TypeScript，不需要编译，不需要理解 Claude Code 的内部 API。任何人都可以用一个 markdown 文件创建一个 skill。

### 核心类型定义

在源码中，Skill 被统一表示为 `Command` 类型（`src/types/command.ts`）：

```typescript
// src/types/command.ts
type PromptCommand = CommandBase & {
  type: 'prompt'
  source: SettingSource | 'builtin' | 'mcp' | 'plugin' | 'bundled'
  context?: 'inline' | 'fork'        // 执行上下文
  allowedTools?: string[]             // 工具权限白名单
  model?: string                      // 模型覆盖
  effort?: EffortValue                // 推理努力程度
  hooks?: HooksSettings               // 生命周期钩子
  paths?: string[]                    // 条件激活路径模式
  getPromptForCommand(               // 核心：生成 prompt 内容
    args: string,
    context: ToolUseContext
  ): Promise<ContentBlockParam[]>
}
```

**设计决策讨论：为什么 Skill 复用 Command 类型，而不是独立类型？**

- **优点**：复用了命令系统的注册、发现、执行、权限检查等全部基础设施。`/skill-name` 和 `/command-name` 走完全相同的代码路径。
- **优点**：模型只需要学习一个 SkillTool，不需要区分 "skill" 和 "command"。
- **缺点**：`Command` 类型变得臃肿，承载了太多职责（prompt 命令、本地命令、JSX 命令都是 Command）。
- **Trade-off**：这是一个典型的 "统一抽象 vs 专用抽象" 的权衡。Claude Code 选择了统一，代价是类型定义的复杂性，收益是系统层面的简洁性。

---

## 11.3 四种 Skill 来源：从编译时到运行时的完整光谱

### 面临的问题

Skill 从哪里来？不同的使用场景对 skill 的来源有不同的需求：

- **产品团队**需要内置一些高质量的 skill（如 `/simplify`、`/update-config`），这些 skill 应该开箱即用，不依赖外部文件。
- **个人用户**需要创建自己的 skill（如 "我的项目的部署流程"），这些 skill 应该是简单的文件，可以版本控制。
- **插件开发者**需要通过插件分发 skill（如 "PDF 生成器"），这些 skill 应该随插件安装/卸载。
- **MCP 服务器**需要暴露远程 skill（如 "Jira 工单创建"），这些 skill 来自网络。

Claude Code 设计了四种 skill 来源，形成了从编译时到运行时的完整光谱：

```
编译时 ◄──────────────────────────────────────────────► 运行时

Bundled Skills    File-based Skills    Plugin Skills    MCP Skills
(内置于二进制)     (磁盘 .md 文件)       (DXT 插件)       (远程服务器)
│                 │                    │                │
│ 启动时注册       │ 启动时扫描目录       │ 插件加载时注册   │ MCP 连接时发现
│ 无 I/O 开销      │ 文件系统 I/O        │ 插件生命周期     │ 网络 I/O
│ 不可修改         │ 用户可编辑          │ 开发者分发       │ 动态变化
│ 最高信任         │ 项目级信任          │ 插件级信任       │ 最低信任
```

### 来源一：Bundled Skills（编译时内置）

Bundled Skills 是编译进 Claude Code 二进制文件的 skill，启动时通过 `registerBundledSkill()` 注册到内存数组中。

**核心源码：`src/skills/bundledSkills.ts`**

```typescript
// 内部注册表——一个简单的数组
const bundledSkills: Command[] = []

export function registerBundledSkill(definition: BundledSkillDefinition): void {
  const { files } = definition
  let getPromptForCommand = definition.getPromptForCommand

  // 如果 skill 携带了参考文件，包装 getPromptForCommand 以实现懒提取
  if (files && Object.keys(files).length > 0) {
    let extractionPromise: Promise<string | null> | undefined
    const inner = definition.getPromptForCommand
    getPromptForCommand = async (args, ctx) => {
      // 闭包级 memoize：只提取一次，并发调用共享同一个 Promise
      extractionPromise ??= extractBundledSkillFiles(definition.name, files)
      const extractedDir = await extractionPromise
      const blocks = await inner(args, ctx)
      if (extractedDir === null) return blocks
      return prependBaseDir(blocks, extractedDir)
    }
  }

  const command: Command = {
    type: 'prompt',
    name: definition.name,
    source: 'bundled',
    loadedFrom: 'bundled',
    // ...其他字段
    getPromptForCommand,
  }
  bundledSkills.push(command)
}
```

**启动时注册流程（`src/skills/bundled/index.ts`）：**

```typescript
export function initBundledSkills(): void {
  // 无条件注册的核心 skill
  registerUpdateConfigSkill()
  registerSimplifySkill()
  registerStuckSkill()
  // ...

  // Feature flag 门控的实验性 skill
  if (feature('AGENT_TRIGGERS')) {
    const { registerLoopSkill } = require('./loop.js')
    registerLoopSkill()
  }
  if (feature('BUILDING_CLAUDE_APPS')) {
    const { registerClaudeApiSkill } = require('./claudeApi.js')
    registerClaudeApiSkill()
  }
  // ...
}
```

**设计亮点：Bundled Skill 的文件提取安全机制。**

有些 bundled skill 需要附带参考文件（如模板、schema），这些文件编译时嵌入二进制，运行时需要提取到磁盘供模型 Read/Grep。提取过程有严格的安全措施：

```typescript
// 1. 路径遍历防护：禁止 .. 和绝对路径
function resolveSkillFilePath(baseDir: string, relPath: string): string {
  const normalized = normalize(relPath)
  if (isAbsolute(normalized) || normalized.split(pathSep).includes('..')) {
    throw new Error(`bundled skill file path escapes skill dir: ${relPath}`)
  }
  return join(baseDir, normalized)
}

// 2. 安全写入：O_NOFOLLOW | O_EXCL 防止符号链接攻击
const SAFE_WRITE_FLAGS = fsConstants.O_WRONLY | fsConstants.O_CREAT |
                         fsConstants.O_EXCL | O_NOFOLLOW

// 3. 严格权限：目录 0o700，文件 0o600（仅所有者可访问）
await mkdir(parent, { recursive: true, mode: 0o700 })
const fh = await open(p, SAFE_WRITE_FLAGS, 0o600)
```

这里的安全考量是：提取目录路径包含一个进程级 nonce（随机数），但攻击者可能通过 inotify 监听父目录来获知 nonce。即便如此，`0o700` 权限确保攻击者无法写入该目录，`O_NOFOLLOW | O_EXCL` 确保不会跟随预先创建的符号链接。

### 来源二：File-based Skills（磁盘文件）

File-based Skills 是用户在磁盘上创建的 `.md` 文件，遵循固定的目录结构：

```
~/.claude/skills/           # 用户级（全局）
  my-skill/
    SKILL.md                # 必须：skill 内容 + frontmatter
    templates/              # 可选：参考文件
    schemas/

.claude/skills/             # 项目级
  deploy/
    SKILL.md
  lint-fix/
    SKILL.md

~/.claude/commands/         # 遗留格式（向后兼容）
  my-command.md             # 单文件格式
```

**核心加载逻辑（`src/skills/loadSkillsDir.ts`）：**

```typescript
export const getSkillDirCommands = memoize(async (cwd: string): Promise<Command[]> => {
  // 并行加载所有来源（互相独立，无共享状态）
  const [managedSkills, userSkills, projectSkillsNested,
         additionalSkillsNested, legacyCommands] = await Promise.all([
    loadSkillsFromSkillsDir(managedSkillsDir, 'policySettings'),  // 企业管控
    loadSkillsFromSkillsDir(userSkillsDir, 'userSettings'),       // 用户级
    Promise.all(projectSkillsDirs.map(dir =>                       // 项目级
      loadSkillsFromSkillsDir(dir, 'projectSettings'))),
    Promise.all(additionalDirs.map(dir =>                          // --add-dir
      loadSkillsFromSkillsDir(join(dir, '.claude', 'skills'), 'projectSettings'))),
    loadSkillsFromCommandsDir(cwd),                                // 遗留 /commands/
  ])

  // 合并 → 去重（基于 realpath）→ 分离条件 skill → 返回无条件 skill
  // ...
})
```

**加载优先级**：managed（企业管控）→ user（用户级）→ project（项目级）→ additional（额外目录）→ legacy（遗留命令）。先加载的同名 skill 优先（first-wins）。

**去重机制**：通过 `realpath()` 解析符号链接，确保同一个物理文件不会被加载两次。这解决了一个实际问题——当用户通过符号链接或重叠的父目录引用同一个 skill 文件时，避免重复注册。

```typescript
// 并行预计算所有文件的 realpath（独立的 I/O 操作）
const fileIds = await Promise.all(
  allSkillsWithPaths.map(({ filePath }) => getFileIdentity(filePath))
)
// 然后同步去重（顺序依赖的 first-wins 策略）
const seenFileIds = new Map<string, SettingSource | ...>()
for (let i = 0; i < allSkillsWithPaths.length; i++) {
  const fileId = fileIds[i]
  if (seenFileIds.has(fileId)) continue  // 跳过重复
  seenFileIds.set(fileId, skill.source)
  deduplicatedSkills.push(skill)
}
```

### 来源三和四：Plugin Skills 与 MCP Skills

Plugin Skills 通过 DXT 插件系统分发，MCP Skills 通过 MCP 协议从远程服务器获取。它们的共同特点是：**使用与 file-based skills 完全相同的 frontmatter 解析逻辑**。

MCP Skills 的特殊之处在于循环依赖问题。`mcpSkills.ts` 需要调用 `loadSkillsDir.ts` 的 `createSkillCommand` 和 `parseSkillFrontmatterFields`，但 `loadSkillsDir.ts` 又通过 `commands.ts` 间接依赖 MCP 模块。

**解法：写一次注册表（`src/skills/mcpSkillBuilders.ts`）**

```typescript
// 一个无依赖的叶子模块，只导入类型
let builders: MCPSkillBuilders | null = null

export function registerMCPSkillBuilders(b: MCPSkillBuilders): void {
  builders = b  // 写一次
}

export function getMCPSkillBuilders(): MCPSkillBuilders {
  if (!builders) throw new Error('Not registered yet')
  return builders
}
```

`loadSkillsDir.ts` 在模块初始化时注册：
```typescript
// loadSkillsDir.ts 底部
registerMCPSkillBuilders({ createSkillCommand, parseSkillFrontmatterFields })
```

`mcpSkills.ts` 在需要时获取：
```typescript
const { createSkillCommand } = getMCPSkillBuilders()
```

**为什么不用动态 import？** 注释中解释得很清楚：Bun 打包后的二进制中，变量形式的动态 import（`await import(variable)`）无法正确解析路径；字面量形式的动态 import 虽然可以工作，但会被 dependency-cruiser 追踪，导致大量循环依赖告警。写一次注册表是一个务实的折中方案。

### MCP Skills 的安全限制

MCP Skills 来自远程服务器，被视为不可信来源。因此有一个关键的安全限制：

```typescript
// createSkillCommand 中的安全检查
if (loadedFrom !== 'mcp') {
  // 只有非 MCP skill 才执行内联 shell 命令（!`...`）
  finalContent = await executeShellCommandsInPrompt(finalContent, ...)
}
```

MCP skill 的 markdown body 中的 `!`shell`` 语法会被忽略，`${CLAUDE_SKILL_DIR}` 替换也无意义。这防止了远程服务器通过 skill 内容执行任意 shell 命令。

---

## 11.4 Skill 的发现机制：两层索引

### 面临的问题

用户可能有几十个 skill，但 system prompt 的空间是有限的。如果把所有 skill 的完整内容都放进 system prompt，会浪费大量 token（context window 是最昂贵的资源）。但如果不告诉模型有哪些 skill 可用，模型就无法主动调用它们。

**核心矛盾：模型需要知道 skill 的存在（发现），但不需要知道 skill 的全部内容（加载）。**

### 解法：摘要索引 + 按需加载

Claude Code 采用了一个两层索引策略：

**第一层：System Prompt 中的摘要列表（发现层）**

在每次 API 调用的 system prompt 中，附加一个 skill 摘要列表（`system-reminder` 标签）。这个列表只包含 skill 的名称和简短描述，不包含完整内容：

```
<system-reminder>
The following skills are available for use with the Skill tool:

- update-config: Use this skill to configure the Claude Code harness...
- simplify: Review changed code for reuse, quality, and efficiency...
- loop: Run a prompt or slash command on a recurring interval...
- my-custom-skill: Deploy the application to staging...
</system-reminder>
```

**第二层：SkillTool 调用时的完整加载（执行层）**

当模型决定使用某个 skill 时，通过 SkillTool 调用它。此时才执行 `getPromptForCommand()`，加载完整的 skill 内容并注入到对话中。

### 预算控制：1% 上下文窗口规则

摘要列表的大小受到严格的预算控制（`src/tools/SkillTool/prompt.ts`）：

```typescript
// Skill 列表占用上下文窗口的 1%（以字符计）
export const SKILL_BUDGET_CONTEXT_PERCENT = 0.01
export const CHARS_PER_TOKEN = 4
export const DEFAULT_CHAR_BUDGET = 8_000  // 回退值：200k × 4 × 1%

// 每个条目的描述上限 250 字符
export const MAX_LISTING_DESC_CHARS = 250
```

当 skill 数量过多、描述总长度超出预算时，`formatCommandsWithinBudget()` 会执行分级降级：

```
预算充足 → 完整描述
    │
    ▼ 超出预算
Bundled skills 保留完整描述，其他 skill 截断描述
    │
    ▼ 仍然超出
Bundled skills 保留完整描述，其他 skill 只显示名称
```

```typescript
export function formatCommandsWithinBudget(
  commands: Command[], contextWindowTokens?: number
): string {
  const budget = getCharBudget(contextWindowTokens)

  // 尝试完整描述
  if (fullTotal <= budget) return fullEntries.map(e => e.full).join('\n')

  // Bundled skills 永远保留完整描述（它们是产品核心能力）
  // 计算剩余预算分配给非 bundled skills
  const remainingBudget = budget - bundledChars
  const maxDescLen = Math.floor(availableForDescs / restCommands.length)

  if (maxDescLen < MIN_DESC_LENGTH) {
    // 极端情况：非 bundled 只显示名称
    return commands.map((cmd, i) =>
      bundledIndices.has(i) ? fullEntries[i].full : `- ${cmd.name}`
    ).join('\n')
  }

  // 截断非 bundled 描述以适应预算
  return commands.map((cmd, i) => {
    if (bundledIndices.has(i)) return fullEntries[i].full
    return `- ${cmd.name}: ${truncate(description, maxDescLen)}`
  }).join('\n')
}
```

**设计决策讨论：为什么是 1%？**

- 太少（0.1%）：模型无法发现 skill，skill 系统形同虚设。
- 太多（5%）：浪费宝贵的 context window 空间，挤压用户对话和工具结果的空间。
- 1% 是一个经验值：对于 200k context window，约 8000 字符（~2000 token），足以列出几十个 skill 的名称和简短描述。
- Bundled skills 享有特权（不被截断），因为它们是产品核心能力，必须被模型可靠发现。

### 两种发现过滤器

系统维护两个不同的 skill 列表，服务于不同的发现场景：

```typescript
// 1. 模型可调用的 skill（出现在 SkillTool 的 system prompt 中）
export const getSkillToolCommands = memoize(async (cwd) => {
  return allCommands.filter(cmd =>
    cmd.type === 'prompt' &&
    !cmd.disableModelInvocation &&    // 未禁止模型调用
    cmd.source !== 'builtin' &&       // 非内置命令
    (cmd.loadedFrom === 'skills' ||   // 来自 /skills/ 目录
     cmd.loadedFrom === 'bundled' ||  // 或 bundled
     cmd.loadedFrom === 'commands_DEPRECATED' ||  // 或遗留命令
     cmd.hasUserSpecifiedDescription ||  // 或有明确描述
     cmd.whenToUse)                      // 或有使用场景说明
  )
})

// 2. 用户可调用的 skill（出现在 /skills 命令和 system-reminder 中）
export const getSlashCommandToolSkills = memoize(async (cwd) => {
  return allCommands.filter(cmd =>
    cmd.type === 'prompt' &&
    cmd.source !== 'builtin' &&
    (cmd.hasUserSpecifiedDescription || cmd.whenToUse) &&
    (cmd.loadedFrom === 'skills' ||
     cmd.loadedFrom === 'plugin' ||
     cmd.loadedFrom === 'bundled' ||
     cmd.disableModelInvocation)  // 注意：禁止模型调用的 skill 仍然对用户可见
  )
})
```

**关键区别**：`disableModelInvocation` 的 skill 不会出现在模型的发现列表中（防止模型自动调用），但仍然出现在用户的 `/skills` 列表中（用户可以手动调用）。这是一个精细的控制——有些 skill 只应该由用户主动触发，不应该被模型自作主张地调用。

---

## 11.5 Skill 的执行流程：从触发到注入

### 面临的问题

Skill 被触发后，需要完成一系列复杂的操作：加载 prompt 内容、替换变量、执行内联 shell 命令、注册 hooks、记录调用（用于压缩保留）、注入权限……这些操作的顺序和正确性直接影响 skill 的行为。

更复杂的是，skill 有两种触发方式（用户 `/skill-name` 和模型 SkillTool）和两种执行模式（inline 和 fork），需要统一处理。

### 两种触发路径

```
触发路径 1: 用户输入 /skill-name [args]
─────────────────────────────────────────
用户输入 "/simplify"
    │
    ▼
processSlashCommand()
    │ 解析命令名和参数
    ▼
findCommand("simplify", commands)
    │ 查找 Command 对象
    ▼
command.context === 'fork' ?
├─ YES → executeForkedSlashCommand()  → 子代理执行
└─ NO  → getMessagesForPromptSlashCommand()  → 内联展开
              │
              ▼
         command.getPromptForCommand(args, context)
              │ 生成 prompt 内容
              ▼
         registerSkillHooks()  → 注册生命周期钩子
         addInvokedSkill()     → 记录调用（压缩保留）
              │
              ▼
         返回 messages[] 注入对话


触发路径 2: 模型调用 SkillTool
─────────────────────────────────────────
模型输出 tool_use: { name: "Skill", input: { skill: "simplify" } }
    │
    ▼
SkillTool.validateInput()
    │ 检查 skill 存在、未禁用、是 prompt 类型
    ▼
SkillTool.checkPermissions()
    │ 权限规则匹配 → 安全属性检查 → 用户确认
    ▼
SkillTool.call()
    │
    ▼
command.context === 'fork' ?
├─ YES → executeForkedSkill()  → runAgent() 子代理
└─ NO  → processPromptSlashCommand()  → 复用路径 1 的逻辑
              │
              ▼
         返回 { data, newMessages, contextModifier }
```

两条路径最终都汇聚到同一个核心函数 `getMessagesForPromptSlashCommand()`，这是 Skill 执行的真正入口。

### 核心执行流程：getPromptForCommand()

当 skill 被触发时，`getPromptForCommand()` 负责将 SKILL.md 的 markdown body 转化为最终注入对话的内容。这个过程包含多个变换步骤：

```typescript
// src/skills/loadSkillsDir.ts — createSkillCommand 中的 getPromptForCommand
async getPromptForCommand(args, toolUseContext) {
  // Step 1: 注入 Base directory 头部
  let finalContent = baseDir
    ? `Base directory for this skill: ${baseDir}\n\n${markdownContent}`
    : markdownContent

  // Step 2: 替换 $ARGUMENTS 和命名参数
  finalContent = substituteArguments(finalContent, args, true, argumentNames)

  // Step 3: 替换 ${CLAUDE_SKILL_DIR}（skill 自身目录）
  if (baseDir) {
    const skillDir = process.platform === 'win32'
      ? baseDir.replace(/\\/g, '/') : baseDir
    finalContent = finalContent.replace(/\$\{CLAUDE_SKILL_DIR\}/g, skillDir)
  }

  // Step 4: 替换 ${CLAUDE_SESSION_ID}（当前会话 ID）
  finalContent = finalContent.replace(
    /\$\{CLAUDE_SESSION_ID\}/g, getSessionId()
  )

  // Step 5: 执行内联 shell 命令（!`...`）—— 仅非 MCP skill
  if (loadedFrom !== 'mcp') {
    finalContent = await executeShellCommandsInPrompt(finalContent, ...)
  }

  return [{ type: 'text', text: finalContent }]
}
```

**变量替换的设计意图：**

- `$ARGUMENTS`：让 skill 可以接收用户参数，如 `/deploy staging` 中的 `staging`。
- `${CLAUDE_SKILL_DIR}`：让 skill 的 prompt 可以引用自身目录下的文件，如 `Read ${CLAUDE_SKILL_DIR}/templates/config.yaml`。
- `${CLAUDE_SESSION_ID}`：让 skill 可以创建会话级的临时文件，避免多会话冲突。
- `!`shell``：让 skill 可以在加载时执行 shell 命令，将动态信息（如 git status、环境变量）注入 prompt。

### 执行后的关键操作

`getPromptForCommand()` 返回后，`getMessagesForPromptSlashCommand()` 还需要完成几个关键操作：

```typescript
// src/utils/processUserInput/processSlashCommand.tsx
async function getMessagesForPromptSlashCommand(command, args, context, ...) {
  // 1. 调用 getPromptForCommand 获取 prompt 内容
  const result = await command.getPromptForCommand(args, context)

  // 2. 注册 skill 的生命周期钩子
  if (command.hooks && hooksAllowedForThisSkill) {
    registerSkillHooks(context.setAppState, sessionId,
      command.hooks, command.name, command.skillRoot)
  }

  // 3. 记录 skill 调用（用于压缩保留）
  //    压缩时，已调用的 skill 内容会被保留，不会被丢弃
  const skillContent = result.filter(b => b.type === 'text')
    .map(b => b.text).join('\n\n')
  addInvokedSkill(command.name, skillPath, skillContent,
    getAgentContext()?.agentId ?? null)

  // 4. 解析 skill 声明的工具权限
  const additionalAllowedTools = parseToolListFromCLI(command.allowedTools ?? [])

  // 5. 构造消息序列
  return {
    messages: [
      createUserMessage({ content: metadata, uuid }),      // 加载元数据
      createUserMessage({ content: result, isMeta: true }), // skill 内容
      ...attachmentMessages,                                // 附件
      createAttachmentMessage({                             // 权限声明
        type: 'command_permissions',
        allowedTools: additionalAllowedTools,
        model: command.model
      }),
    ],
    shouldQuery: true,
    allowedTools: additionalAllowedTools,
    model: command.model,
    effort: command.effort,
  }
}
```

**`addInvokedSkill` 的作用**：当对话过长触发压缩（compact）时，普通消息会被摘要替代。但 skill 的 prompt 内容是模型正确执行任务的关键上下文——如果被压缩掉，模型会"忘记"自己应该遵循的工作流。`addInvokedSkill` 将 skill 内容标记为"必须保留"，压缩后会重新注入。

**`registerSkillHooks` 的作用**：skill 可以在 frontmatter 中声明生命周期钩子（如文件变更时运行 lint）。这些钩子在 skill 被调用时注册为会话级钩子，持续到会话结束。支持 `once: true` 的一次性钩子——执行一次后自动移除。

### Inline vs Fork：两种执行模式

```
Inline 模式（默认）                    Fork 模式（context: 'fork'）
─────────────────                     ──────────────────────────
skill 内容注入当前对话                  skill 在独立子代理中执行
模型在主对话中处理                      子代理有独立的 token 预算
结果直接出现在对话流中                  结果摘要返回给主对话
适合：简单指令、上下文相关的任务         适合：复杂任务、需要大量工具调用
```

Fork 模式的实现复用了 AgentTool 的 `runAgent()` 基础设施：

```typescript
// src/tools/SkillTool/SkillTool.ts — executeForkedSkill
async function executeForkedSkill(command, commandName, args, context, ...) {
  const agentId = createAgentId()

  // 准备 forked 上下文（独立的 AppState、token 预算）
  const { modifiedGetAppState, baseAgent, promptMessages, skillContent } =
    await prepareForkedCommandContext(command, args || '', context)

  // 合并 skill 的 effort 设置
  const agentDefinition = command.effort !== undefined
    ? { ...baseAgent, effort: command.effort }
    : baseAgent

  // 运行子代理
  for await (const message of runAgent({
    agentDefinition,
    promptMessages,
    toolUseContext: { ...context, getAppState: modifiedGetAppState },
    canUseTool,
    isAsync: false,
    querySource: 'agent:custom',
    model: command.model,
    availableTools: context.options.tools,
    override: { agentId },
  })) {
    agentMessages.push(message)
    // 上报进度（工具调用）
    if (onProgress) { /* ... */ }
  }

  // 提取结果文本
  const resultText = extractResultText(agentMessages, 'Skill execution completed')
  return { data: { success: true, commandName, status: 'forked', agentId, result: resultText } }
}
```

**设计决策讨论：为什么需要 Fork 模式？**

- **Token 预算隔离**：复杂 skill（如 `/simplify`）可能需要大量工具调用（读文件、搜索代码、运行测试），这些调用的结果会消耗大量 token。在 inline 模式下，这些 token 消耗在主对话的 context window 中，可能导致后续对话空间不足。Fork 模式让 skill 在独立的 token 预算中执行，不影响主对话。
- **上下文污染隔离**：skill 执行过程中的中间消息（工具调用、中间结果）不会出现在主对话中，保持主对话的清洁。
- **Trade-off**：Fork 模式的代价是子代理无法直接访问主对话的上下文（之前的对话历史），只能通过 skill prompt 获取必要信息。

### SkillTool 的权限控制

SkillTool 有一套精细的权限控制机制，决定模型是否可以自动调用某个 skill：

```typescript
// src/tools/SkillTool/SkillTool.ts — checkPermissions
async checkPermissions({ skill, args }, context): Promise<PermissionDecision> {
  // 1. 检查 deny 规则（最高优先级）
  for (const [ruleContent, rule] of denyRules.entries()) {
    if (ruleMatches(ruleContent)) return { behavior: 'deny', ... }
  }

  // 2. 检查 allow 规则
  for (const [ruleContent, rule] of allowRules.entries()) {
    if (ruleMatches(ruleContent)) return { behavior: 'allow', ... }
  }

  // 3. 安全属性白名单自动放行
  //    如果 skill 只有"安全"属性（无 hooks、无 allowedTools 等），自动允许
  if (skillHasOnlySafeProperties(commandObj)) {
    return { behavior: 'allow', ... }
  }

  // 4. 默认：询问用户
  return {
    behavior: 'ask',
    suggestions: [
      { rules: [{ toolName: 'Skill', ruleContent: commandName }], ... },
      { rules: [{ toolName: 'Skill', ruleContent: `${commandName}:*` }], ... },
    ],
  }
}
```

**安全属性白名单**的设计思路是"默认安全"：

```typescript
const SAFE_SKILL_PROPERTIES = new Set([
  'type', 'name', 'description', 'source', 'model', 'effort',
  'context', 'agent', 'getPromptForCommand', 'paths', 'version',
  // ... 其他安全属性
])

function skillHasOnlySafeProperties(command: Command): boolean {
  for (const key of Object.keys(command)) {
    if (SAFE_SKILL_PROPERTIES.has(key)) continue
    const value = command[key]
    // 有非安全属性且有实际值 → 需要权限
    if (value !== undefined && value !== null) return false
  }
  return true
}
```

这个设计确保了：**未来新增的 Command 属性默认需要权限审批**，除非被显式添加到白名单中。这是一个"安全默认"的设计模式——宁可多问一次用户，也不要自动放行一个可能有风险的 skill。

### SkillTool 的 contextModifier：运行时上下文修改

SkillTool 的 inline 执行路径有一个独特的能力——通过 `contextModifier` 修改后续对话的运行时上下文：

```typescript
// SkillTool.call() 返回值中的 contextModifier
return {
  data: { success: true, commandName, ... },
  newMessages,
  contextModifier(ctx) {
    let modifiedContext = ctx

    // 1. 注入 skill 声明的工具权限
    if (allowedTools.length > 0) {
      modifiedContext = {
        ...modifiedContext,
        getAppState() {
          const appState = previousGetAppState()
          return {
            ...appState,
            toolPermissionContext: {
              ...appState.toolPermissionContext,
              alwaysAllowRules: {
                ...appState.toolPermissionContext.alwaysAllowRules,
                command: [...existingRules, ...allowedTools],
              },
            },
          }
        },
      }
    }

    // 2. 覆盖模型（如 skill 指定了 model: opus）
    if (model) {
      modifiedContext = {
        ...modifiedContext,
        options: {
          ...modifiedContext.options,
          mainLoopModel: resolveSkillModelOverride(model, ctx.options.mainLoopModel),
        },
      }
    }

    // 3. 覆盖 effort 级别
    if (effort !== undefined) {
      // ... 类似的 getAppState 包装
    }

    return modifiedContext
  },
}
```

`contextModifier` 是工具系统的一个通用机制（定义在 `Tool.ts` 中），但 SkillTool 是使用它最多的工具。它允许 skill 在不修改全局状态的情况下，临时改变后续对话循环的行为——包括工具权限、模型选择和推理努力程度。

---

## 11.6 动态发现与条件激活

### 面临的问题

Skill 的加载发生在启动时，但用户的项目结构是动态的。考虑这样一个场景：

```
my-monorepo/
├── .claude/skills/          # 项目根级 skill（启动时加载）
├── packages/
│   ├── frontend/
│   │   └── .claude/skills/  # 前端子项目 skill（启动时未加载！）
│   └── backend/
│       └── .claude/skills/  # 后端子项目 skill（启动时未加载！）
```

启动时，只有项目根级的 `.claude/skills/` 会被扫描。子目录中的 skill 不会被发现——因为递归扫描整个项目树的成本太高（可能有 `node_modules` 等巨大目录）。

但当用户说"帮我修改 `packages/frontend/src/App.tsx`"时，前端子项目的 skill 应该变得可用。

另一个场景：有些 skill 只在操作特定类型的文件时才有意义。比如一个 "TypeScript lint" skill 只应该在操作 `.ts` 文件时激活，操作 `.py` 文件时不应该出现。

### 解法一：文件操作触发的目录发现

当模型通过 FileReadTool、FileWriteTool、FileEditTool 操作文件时，系统会检查文件路径上是否存在未发现的 skill 目录：

```typescript
// src/skills/loadSkillsDir.ts
export async function discoverSkillDirsForPaths(
  filePaths: string[], cwd: string
): Promise<string[]> {
  const resolvedCwd = cwd.endsWith(pathSep) ? cwd.slice(0, -1) : cwd
  const newDirs: string[] = []

  for (const filePath of filePaths) {
    let currentDir = dirname(filePath)

    // 从文件所在目录向上遍历到 cwd（不包括 cwd 本身）
    // cwd 级别的 skill 已在启动时加载
    while (currentDir.startsWith(resolvedCwd + pathSep)) {
      const skillDir = join(currentDir, '.claude', 'skills')

      if (!dynamicSkillDirs.has(skillDir)) {
        dynamicSkillDirs.add(skillDir)  // 记录已检查（避免重复 stat）
        try {
          await fs.stat(skillDir)
          // 检查是否被 gitignore（防止 node_modules 中的 skill 被加载）
          if (await isPathGitignored(currentDir, resolvedCwd)) {
            continue  // 跳过被 gitignore 的目录
          }
          newDirs.push(skillDir)
        } catch {
          // 目录不存在，继续
        }
      }

      const parent = dirname(currentDir)
      if (parent === currentDir) break
      currentDir = parent
    }
  }

  // 按深度排序（最深的优先），让更接近文件的 skill 优先
  return newDirs.sort((a, b) =>
    b.split(pathSep).length - a.split(pathSep).length
  )
}
```

**关键设计细节：**

- **`dynamicSkillDirs` 缓存**：已检查过的路径（无论是否存在）都会被记录，避免每次文件操作都重复 `stat()` 调用。这在常见场景下（目录不存在）避免了大量无效 I/O。
- **gitignore 检查**：防止 `node_modules/some-package/.claude/skills/` 这样的路径被意外加载。使用 `git check-ignore` 命令，能正确处理嵌套 `.gitignore`、`.git/info/exclude` 和全局 gitignore。
- **深度优先排序**：更接近被操作文件的 skill 目录优先级更高，这符合"就近原则"的直觉。

### 解法二：路径模式的条件激活

Skill 可以在 frontmatter 中声明 `paths` 字段，指定只在操作匹配路径的文件时才激活：

```yaml
---
name: typescript-lint
description: Run TypeScript linting
paths: ["src/**/*.ts", "src/**/*.tsx"]
---
```

启动时，带有 `paths` 的 skill 不会立即可用，而是存储在 `conditionalSkills` Map 中。当文件操作触发时，检查路径是否匹配：

```typescript
// src/skills/loadSkillsDir.ts
export function activateConditionalSkillsForPaths(
  filePaths: string[], cwd: string
): string[] {
  if (conditionalSkills.size === 0) return []

  const activated: string[] = []

  for (const [name, skill] of conditionalSkills) {
    if (skill.type !== 'prompt' || !skill.paths?.length) continue

    // 使用 ignore 库（gitignore 风格匹配）
    const skillIgnore = ignore().add(skill.paths)

    for (const filePath of filePaths) {
      const relativePath = isAbsolute(filePath)
        ? relative(cwd, filePath) : filePath

      // 跳过 cwd 外的路径
      if (!relativePath || relativePath.startsWith('..') ||
          isAbsolute(relativePath)) continue

      if (skillIgnore.ignores(relativePath)) {
        // 激活：从 conditional 移到 dynamic
        dynamicSkills.set(name, skill)
        conditionalSkills.delete(name)
        activatedConditionalSkillNames.add(name)
        activated.push(name)
        break  // 一个匹配就够了
      }
    }
  }

  if (activated.length > 0) {
    skillsLoaded.emit()  // 通知监听者清除缓存
  }

  return activated
}
```

**三层 skill 状态模型：**

```
启动时加载
    │
    ├─ 无 paths → unconditionalSkills（立即可用）
    │
    └─ 有 paths → conditionalSkills（等待激活）
                      │
                      │ 文件操作匹配 paths 模式
                      ▼
                  dynamicSkills（运行时激活）
```

`activatedConditionalSkillNames` Set 确保了：即使 skill 缓存被清除（如文件变更触发重新加载），已激活的 skill 不会退回到 conditional 状态。这是一个"只进不退"的设计——一旦用户触碰了匹配的文件，skill 就永久可用（在当前会话内）。

### 文件监听：skillChangeDetector

当用户在会话期间修改了 skill 文件（编辑 SKILL.md、添加新 skill 目录），系统需要自动感知变化并重新加载。

**核心源码：`src/utils/skills/skillChangeDetector.ts`**

```typescript
export async function initialize(): Promise<void> {
  const paths = await getWatchablePaths()
  // 监听的目录：~/.claude/skills, ~/.claude/commands,
  //            .claude/skills, .claude/commands, --add-dir 目录

  watcher = chokidar.watch(paths, {
    persistent: true,
    ignoreInitial: true,
    depth: 2,  // skill 使用 skill-name/SKILL.md 格式
    awaitWriteFinish: {
      stabilityThreshold: 1000,  // 等待文件写入稳定
      pollInterval: 500,
    },
    usePolling: USE_POLLING,  // Bun 下使用轮询（避免 FSWatcher 死锁）
    interval: 2000,           // 轮询间隔 2s（skill 文件变化不频繁）
  })

  watcher.on('add', handleChange)
  watcher.on('change', handleChange)
  watcher.on('unlink', handleChange)
}
```

**防抖机制**：当大量文件同时变化时（如 git 操作），每个文件变化都会触发一个事件。如果每个事件都触发完整的缓存清除和重新加载，可能导致事件循环死锁。因此使用 300ms 的防抖：

```typescript
function scheduleReload(changedPath: string): void {
  pendingChangedPaths.add(changedPath)
  if (reloadTimer) clearTimeout(reloadTimer)
  reloadTimer = setTimeout(async () => {
    reloadTimer = null
    const paths = [...pendingChangedPaths]
    pendingChangedPaths.clear()

    // 执行 ConfigChange hook（允许外部逻辑阻止重新加载）
    const results = await executeConfigChangeHooks('skills', paths[0]!)
    if (hasBlockingResult(results)) return

    // 清除所有缓存并通知监听者
    clearSkillCaches()
    clearCommandsCache()
    resetSentSkillNames()
    skillsChanged.emit()
  }, RELOAD_DEBOUNCE_MS)  // 300ms
}
```

**Bun 兼容性问题**：注释中详细记录了一个 Bun 的 bug（oven-sh/bun#27469）——Bun 的 `fs.watch()` 在关闭 watcher 时可能与文件监听线程死锁。解决方案是在 Bun 环境下使用 `stat()` 轮询代替原生 FSWatcher。这是一个典型的"运行时兼容性"问题，通过条件编译解决：

```typescript
const USE_POLLING = typeof Bun !== 'undefined'
```

---

## 11.7 Bundled Skills 案例分析

### `/update-config`：最复杂的 Bundled Skill

`/update-config` 是一个典型的"知识密集型" skill——它的 prompt 包含了 Claude Code 设置系统的完整文档，包括设置文件位置、JSON Schema、Hooks 配置格式、常见模式等。

```typescript
// src/skills/bundled/updateConfig.ts
export function registerUpdateConfigSkill(): void {
  registerBundledSkill({
    name: 'update-config',
    description: 'Use this skill to configure the Claude Code harness via settings.json...',
    allowedTools: ['Read'],  // 只需要读取权限
    userInvocable: true,
    async getPromptForCommand(args) {
      // 动态生成 JSON Schema（保持与实际类型同步）
      const jsonSchema = generateSettingsSchema()

      let prompt = UPDATE_CONFIG_PROMPT
      prompt += `\n\n## Full Settings JSON Schema\n\n\`\`\`json\n${jsonSchema}\n\`\`\``

      if (args) {
        prompt += `\n\n## User Request\n\n${args}`
      }
      return [{ type: 'text', text: prompt }]
    },
  })
}
```

**亮点：动态 Schema 生成。** `generateSettingsSchema()` 从 Zod Schema 动态生成 JSON Schema，确保 skill prompt 中的 schema 文档始终与实际代码类型保持同步。这避免了手写文档与代码不一致的问题。

**亮点：参数路由。** 当参数以 `[hooks-only]` 前缀开头时，只返回 Hooks 相关文档，减少不必要的 token 消耗。

### `/simplify`：多代理协作的 Skill

`/simplify` 展示了 skill 如何编排多个子代理并行工作：

```typescript
const SIMPLIFY_PROMPT = `# Simplify: Code Review and Cleanup

## Phase 1: Identify Changes
Run \`git diff\` to see what changed.

## Phase 2: Launch Three Review Agents in Parallel
Use the Agent tool to launch all three agents concurrently:

### Agent 1: Code Reuse Review
Search for existing utilities that could replace newly written code...

### Agent 2: Code Quality Review
Review for hacky patterns: redundant state, parameter sprawl, copy-paste...

### Agent 3: Efficiency Review
Review for: unnecessary work, missed concurrency, hot-path bloat...

## Phase 3: Fix Issues
Wait for all three agents to complete. Aggregate findings and fix each issue.
`
```

这个 skill 的 prompt 本身就是一个"工作流编排指令"——它告诉模型启动三个并行的子代理，每个负责不同维度的代码审查，然后汇总结果并修复问题。Skill 的"智能"完全来自 prompt engineering，不需要任何代码逻辑。

### `/loop`：与其他系统集成的 Skill

`/loop` 展示了 skill 如何与 Claude Code 的其他子系统（Cron 调度）集成：

```typescript
export function registerLoopSkill(): void {
  registerBundledSkill({
    name: 'loop',
    description: 'Run a prompt or slash command on a recurring interval...',
    whenToUse: 'When the user wants to set up a recurring task...',
    argumentHint: '[interval] <prompt>',
    userInvocable: true,
    isEnabled: isKairosCronEnabled,  // 动态启用条件
    async getPromptForCommand(args) {
      if (!trimmed) return [{ type: 'text', text: USAGE_MESSAGE }]
      return [{ type: 'text', text: buildPrompt(trimmed) }]
    },
  })
}
```

**亮点：`isEnabled` 回调。** Skill 的可用性不是静态的——`/loop` 只在 Kairos Cron 功能启用时才可用。`isEnabled` 是一个运行时回调，每次检查 skill 可用性时都会调用。这允许 skill 根据 feature flag、用户配置、环境条件等动态决定是否可用。

**亮点：Feature flag 门控注册。** `/loop` 的注册本身也受 feature flag 控制：

```typescript
if (feature('AGENT_TRIGGERS')) {
  const { registerLoopSkill } = require('./loop.js')
  registerLoopSkill()
}
```

这是双重门控：编译时 `feature('AGENT_TRIGGERS')` 决定代码是否包含在二进制中，运行时 `isEnabled: isKairosCronEnabled` 决定 skill 是否对用户可见。

---

## 11.8 完整数据流总结

```
┌─────────────────────────────────────────────────────────────────────┐
│                        启动阶段                                      │
│                                                                       │
│  main.tsx                                                             │
│    │                                                                  │
│    ├─ initBundledSkills()                                             │
│    │    └─ registerBundledSkill() × N → bundledSkills[]               │
│    │                                                                  │
│    ├─ getCommands(cwd)                                                │
│    │    ├─ getBundledSkills() → bundled skills                        │
│    │    ├─ getSkillDirCommands(cwd)                                   │
│    │    │    ├─ loadSkillsFromSkillsDir(managed) ─┐                   │
│    │    │    ├─ loadSkillsFromSkillsDir(user)    ─┤ 并行              │
│    │    │    ├─ loadSkillsFromSkillsDir(project) ─┤                   │
│    │    │    ├─ loadSkillsFromSkillsDir(addDir)  ─┤                   │
│    │    │    └─ loadSkillsFromCommandsDir(legacy) ─┘                  │
│    │    │         │                                                   │
│    │    │         ▼                                                   │
│    │    │    去重(realpath) → 分离条件skill → unconditionalSkills      │
│    │    │                                                             │
│    │    ├─ plugin skills                                              │
│    │    └─ built-in commands                                          │
│    │                                                                  │
│    └─ skillChangeDetector.initialize()                                │
│         └─ chokidar.watch(skill dirs) → handleChange → debounce      │
│                                                                       │
├─────────────────────────────────────────────────────────────────────┤
│                        运行阶段                                      │
│                                                                       │
│  System Prompt 构建                                                   │
│    └─ formatCommandsWithinBudget(skills, contextWindowTokens)         │
│         └─ 1% 预算 → 分级降级 → skill_listing 摘要                   │
│                                                                       │
│  用户触发: /skill-name [args]                                         │
│    └─ processSlashCommand()                                           │
│         └─ getMessagesForPromptSlashCommand()                         │
│              ├─ getPromptForCommand(args, ctx)                        │
│              │    ├─ Base dir 注入                                    │
│              │    ├─ $ARGUMENTS 替换                                  │
│              │    ├─ ${CLAUDE_SKILL_DIR} 替换                         │
│              │    ├─ ${CLAUDE_SESSION_ID} 替换                        │
│              │    └─ !`shell` 执行（非 MCP）                          │
│              ├─ registerSkillHooks()                                  │
│              ├─ addInvokedSkill()（压缩保留）                         │
│              └─ 返回 messages[] + allowedTools + model                │
│                                                                       │
│  模型触发: SkillTool({ skill, args })                                 │
│    ├─ validateInput() → 存在性/类型检查                               │
│    ├─ checkPermissions() → deny/allow/safe/ask                        │
│    └─ call()                                                          │
│         ├─ inline → processPromptSlashCommand() + contextModifier     │
│         └─ fork → executeForkedSkill() → runAgent()                   │
│                                                                       │
│  文件操作触发动态发现                                                  │
│    ├─ discoverSkillDirsForPaths() → 向上遍历发现新 skill 目录         │
│    │    └─ addSkillDirectories() → loadSkillsFromSkillsDir()          │
│    └─ activateConditionalSkillsForPaths() → 路径匹配激活条件 skill    │
│         └─ dynamicSkills.set() + skillsLoaded.emit()                  │
│                                                                       │
│  文件变更触发重新加载                                                  │
│    └─ skillChangeDetector → debounce(300ms)                           │
│         └─ clearSkillCaches() + clearCommandsCache()                  │
│              └─ skillsChanged.emit() → UI 更新                        │
│                                                                       │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 11.9 设计决策总结与反思

### 决策 1：Skill = Prompt，不是代码

**选择**：Skill 的核心是 markdown prompt，不是可执行代码。

**为什么**：
- 降低创建门槛：任何人都能写 markdown，不需要 TypeScript 知识。
- 安全性：prompt 本身不能直接执行操作，只能通过模型间接调用工具。
- 可审计：skill 的行为完全由 prompt 文本决定，可以人工审查。

**Trade-off**：prompt 的表达能力有限——无法实现复杂的条件逻辑、循环、状态管理。对于需要这些能力的场景，需要依赖模型的推理能力来"解释"prompt 中的指令。

### 决策 2：统一 Command 抽象

**选择**：Skill 复用 Command 类型系统，而不是独立的 Skill 类型。

**为什么**：避免引入新的注册、发现、执行基础设施。一个 `findCommand()` 函数同时服务于 `/help`（内置命令）和 `/simplify`（bundled skill）和 `/my-deploy`（用户 skill）。

**Trade-off**：Command 类型变得复杂（`PromptCommand | LocalCommand | LocalJSXCommand`），新开发者需要理解 `type` 字段的含义才能区分不同类型的命令。

### 决策 3：两层索引（摘要 + 按需加载）

**选择**：system prompt 中只放 skill 摘要，完整内容在调用时才加载。

**为什么**：context window 是最昂贵的资源。如果 50 个 skill 每个 2000 token，全部放入 system prompt 就是 100k token——占据了一半的 context window。两层索引将发现成本降低到 ~2000 token（1% 预算）。

**Trade-off**：模型需要两步才能使用 skill（先发现、再调用），增加了一次 API 往返。但这个代价远小于浪费 100k token 的 context window 空间。

### 决策 4：动态发现而非全量扫描

**选择**：启动时只扫描已知目录，运行时通过文件操作触发增量发现。

**为什么**：全量递归扫描项目树的成本不可控（`node_modules` 可能有数万个目录）。按需发现将成本分摊到实际的文件操作中。

**Trade-off**：用户必须先操作某个子目录中的文件，该目录的 skill 才会被发现。如果用户直接问"帮我部署前端"，但还没有操作过 `packages/frontend/` 中的任何文件，前端的 skill 不会被发现。这是一个"懒加载"的固有限制。

### 决策 5：MCP Skill 禁止 shell 执行

**选择**：来自 MCP 服务器的 skill 不能执行内联 shell 命令（`!`...``）。

**为什么**：MCP 服务器是远程的、不可信的。如果允许 MCP skill 的 markdown 中嵌入 shell 命令，远程服务器就可以在用户机器上执行任意代码。

**Trade-off**：MCP skill 的功能受限——不能在加载时动态获取环境信息。但这是安全性的必要代价。MCP skill 仍然可以通过 `allowed-tools` 声明工具权限，让模型在执行时调用 Bash 工具——这走的是正常的权限检查流程，用户有机会审批。

---

## 关键源码索引

| 文件 | 职责 | 关键函数/导出 |
|------|------|-------------|
| `skills/bundledSkills.ts` | Bundled Skill 注册表与文件提取 | `registerBundledSkill()`, `getBundledSkills()`, `extractBundledSkillFiles()` |
| `skills/bundled/index.ts` | Bundled Skill 初始化入口 | `initBundledSkills()` |
| `skills/bundled/*.ts` | 各 Bundled Skill 实现 | `registerUpdateConfigSkill()`, `registerSimplifySkill()`, `registerLoopSkill()` 等 |
| `skills/loadSkillsDir.ts` | File-based Skill 加载引擎 | `getSkillDirCommands()`, `createSkillCommand()`, `parseSkillFrontmatterFields()`, `discoverSkillDirsForPaths()`, `activateConditionalSkillsForPaths()` |
| `skills/mcpSkillBuilders.ts` | MCP Skill 循环依赖解耦 | `registerMCPSkillBuilders()`, `getMCPSkillBuilders()` |
| `tools/SkillTool/SkillTool.ts` | SkillTool 工具实现（模型调用入口） | `SkillTool`, `executeForkedSkill()`, `validateInput()`, `checkPermissions()` |
| `tools/SkillTool/prompt.ts` | Skill 发现列表与预算控制 | `formatCommandsWithinBudget()`, `getPrompt()`, `getCharBudget()` |
| `tools/SkillTool/UI.tsx` | SkillTool 终端 UI 渲染 | `renderToolUseMessage()`, `renderToolResultMessage()` |
| `utils/skills/skillChangeDetector.ts` | Skill 文件变更监听 | `initialize()`, `dispose()`, `subscribe()` |
| `utils/hooks/registerSkillHooks.ts` | Skill 生命周期钩子注册 | `registerSkillHooks()` |
| `utils/processUserInput/processSlashCommand.tsx` | 用户斜杠命令执行（含 Skill） | `processSlashCommand()`, `getMessagesForPromptSlashCommand()`, `processPromptSlashCommand()` |
| `commands.ts` | 命令注册表（含 Skill 过滤） | `getCommands()`, `getSkillToolCommands()`, `getSlashCommandToolSkills()`, `getMcpSkillCommands()` |
| `types/command.ts` | Command/PromptCommand 类型定义 | `PromptCommand`, `Command`, `CommandBase` |
| `utils/frontmatterParser.ts` | YAML Frontmatter 解析 | `parseFrontmatter()`, `coerceDescriptionToString()` |
| `utils/argumentSubstitution.ts` | $ARGUMENTS 变量替换 | `substituteArguments()`, `parseArgumentNames()` |
| `utils/promptShellExecution.ts` | 内联 Shell 命令执行 | `executeShellCommandsInPrompt()` |
| `utils/forkedAgent.ts` | Fork 模式上下文准备 | `prepareForkedCommandContext()`, `extractResultText()` |
| `bootstrap/state.ts` | 全局状态（Skill 调用记录） | `addInvokedSkill()`, `clearInvokedSkillsForAgent()`, `getSessionId()` |
