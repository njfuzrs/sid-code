---
title: Claude Code 源码解析（九）· 命令系统
description: '80+ 斜杠命令如何做到按需加载而不拖慢启动？命令如何注册、发现、解析参数并执行？'
date: "2026-04-01"
series: Claude Code 源码解析
tags: [Claude Code, 源码解析, harness]
outline: 2
---

# 第九章：命令系统（Command System）

> 80+ 斜杠命令的注册、发现与执行机制。

## 核心问题

当你在 Claude Code 中输入 `/compact`、`/model`、`/commit` 时，背后发生了什么？这看似简单——解析命令名、查找处理函数、执行。但 Claude Code 的命令系统面临的问题远比这复杂：

1. **命令来源极其多样。** 不只是内置的 80+ 命令，还有：用户自定义 Skills 目录中的命令、插件注册的命令、MCP 服务器提供的命令、Workflow 脚本生成的命令、内置 bundled skills……这些来源的命令需要统一注册、统一发现、统一执行。

2. **命令类型差异巨大。** 有的命令只是切换一个配置（`/vim`），有的需要渲染完整的交互式 UI（`/config`、`/mcp`），有的需要把内容注入对话发给模型（`/commit`、`/review`），有的甚至需要 fork 出一个子代理在后台执行。这些完全不同的执行模式需要一个统一的抽象。

3. **命令的可见性受多重条件约束。** 某些命令只对内部用户可见（`USER_TYPE === 'ant'`），某些只在特定 feature flag 开启时存在（编译期消除），某些只对特定认证类型的用户可用（`claude-ai` 订阅者 vs `console` API key 用户），某些在远程模式下不安全……

4. **命令需要与模型交互。** 模型可以通过 `SkillTool` 调用某些命令（Skills），用户也可以通过 `/skill-name` 直接调用。同一个命令在两种调用路径下的行为可能不同。

**核心矛盾：统一的用户体验 vs 极度异构的命令实现。**

Claude Code 的解法是一个**三层架构**：类型系统定义统一接口 → 注册表聚合多来源命令 → 执行引擎按类型分发。

---

## 9.1 架构总览

```
用户输入: /command args
         │
         ▼
┌─────────────────────────────────────────────────────────────┐
│  Layer 1: 输入路由 (processUserInput.ts)                     │
│  ─────────────────────────────────────────────────────────── │
│  • 判断输入类型: bash / slash command / plain text            │
│  • 斜杠命令 → 动态 import processSlashCommand                │
│  • Bridge 安全检查 (远程输入的命令过滤)                        │
└─────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────┐
│  Layer 2: 命令解析与查找 (processSlashCommand.tsx)            │
│  ─────────────────────────────────────────────────────────── │
│  • parseSlashCommand(): 解析命令名和参数                      │
│  • findCommand(): 在注册表中查找命令                          │
│  • 可用性检查 (availability + isEnabled)                      │
│  • userInvocable 检查 (模型专用 vs 用户可用)                  │
└─────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────┐
│  Layer 3: 类型分发执行                                       │
│  ─────────────────────────────────────────────────────────── │
│                                                              │
│  ┌──────────┐  ┌──────────┐  ┌───────────────────────────┐ │
│  │ local    │  │local-jsx │  │ prompt                    │ │
│  │          │  │          │  │                           │ │
│  │ 同步执行  │  │ 渲染 Ink │  │ ┌─────────┐ ┌─────────┐ │ │
│  │ 返回文本  │  │ 交互 UI  │  │ │ inline  │ │  fork   │ │ │
│  │          │  │ onDone   │  │ │ 注入对话 │ │ 子代理  │ │ │
│  │ /cost    │  │ /config  │  │ │ /review  │ │ /commit │ │ │
│  └──────────┘  └──────────┘  │ └─────────┘ └─────────┘ │ │
│                              └───────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘

命令来源聚合 (commands.ts):
┌─────────────────────────────────────────────────────────────┐
│                                                              │
│  bundled skills ──┐                                         │
│  builtin plugins ─┤                                         │
│  skill dir ───────┤                                         │
│  workflows ───────┼──→ loadAllCommands() ──→ getCommands()  │
│  plugin commands ─┤         │                    │          │
│  plugin skills ───┤         │ memoized           │ 每次过滤  │
│  COMMANDS() ──────┘         │ by cwd             │ availability │
│                             │                    │ + isEnabled  │
│  MCP commands ──────────────┼──→ useMergedCommands() ──→ UI │
│  (AppState.mcp.commands)    │    (React Hook 层合并)         │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

这个架构的关键洞察是：**命令的"注册"和"执行"是两个完全独立的关注点。** 注册表负责"有哪些命令可用"，执行引擎负责"这个命令怎么跑"。两者通过 `Command` 类型接口连接，但互不依赖。

---

## 9.2 Command 接口定义：一个类型如何统一三种执行模式

### 面临的问题

Claude Code 的命令差异极大：

- `/cost` 只需要读取内存中的计数器，返回一行文本
- `/config` 需要渲染一个完整的交互式设置面板，用户可以上下选择、修改值、按 ESC 退出
- `/commit` 需要把一段精心构造的 prompt 注入对话，让模型分析 git diff 并生成 commit message
- `/review` 需要 fork 出一个子代理，在独立的 token 预算内完成代码审查

如何用一个统一的类型来描述这些完全不同的行为？

### 解法：判别联合类型（Discriminated Union）

`src/types/command.ts` 定义了命令系统的核心类型。它的设计采用了 TypeScript 的判别联合模式——用 `type` 字段区分三种命令变体：

```typescript
// src/types/command.ts

// 最终的 Command 类型 = 公共基础属性 + 三种变体之一
export type Command = CommandBase &
  (PromptCommand | LocalCommand | LocalJSXCommand)
```

三种变体的核心差异：

```
┌─────────────────────────────────────────────────────────────────┐
│  LocalCommand (type: 'local')                                    │
│  ─────────────────────────────────────────────────────────────── │
│  • 同步执行，返回文本/压缩结果/跳过                                │
│  • 不渲染 UI，不与模型交互                                        │
│  • 典型命令: /cost, /clear, /compact, /files                     │
│  • 返回值: LocalCommandResult                                    │
│    - { type: 'text', value: string }     → 显示文本               │
│    - { type: 'compact', ... }            → 上下文压缩结果          │
│    - { type: 'skip' }                    → 静默完成               │
│  • load(): 延迟加载命令模块                                       │
│  • supportsNonInteractive: 是否支持 -p 模式                      │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│  LocalJSXCommand (type: 'local-jsx')                             │
│  ─────────────────────────────────────────────────────────────── │
│  • 渲染 React/Ink 交互式 UI                                      │
│  • 通过 onDone 回调通知完成                                       │
│  • 典型命令: /config, /mcp, /model, /resume, /permissions        │
│  • 返回值: React.ReactNode (渲染到终端)                           │
│  • onDone 选项:                                                  │
│    - display: 'skip' | 'system' | 'user'                        │
│    - shouldQuery: 完成后是否触发模型调用                           │
│    - metaMessages: 模型可见但用户不可见的附加消息                   │
│    - nextInput / submitNextInput: 链式命令                        │
│  • load(): 延迟加载命令模块                                       │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│  PromptCommand (type: 'prompt')                                  │
│  ─────────────────────────────────────────────────────────────── │
│  • 生成 prompt 内容注入对话，触发模型调用                          │
│  • 可选 fork 到子代理执行                                         │
│  • 典型命令: /commit, /review, /security-review, 所有 Skills      │
│  • getPromptForCommand(args, context): 生成 ContentBlockParam[]  │
│  • context: 'inline' | 'fork'                                   │
│    - inline: 内容展开到当前对话                                   │
│    - fork: 在子代理中独立执行                                     │
│  • source: 标记来源 (builtin/mcp/plugin/bundled/settings)        │
│  • allowedTools: 限制模型可用的工具集                              │
│  • hooks: 调用时注册的自定义 hooks                                │
└─────────────────────────────────────────────────────────────────┘
```

### CommandBase：公共属性的精心设计

`CommandBase` 定义了所有命令共享的元数据。每个字段都解决一个具体问题：

```typescript
export type CommandBase = {
  // === 身份标识 ===
  name: string                    // 命令名 (唯一标识)
  aliases?: string[]              // 别名 (如 /q → /exit)
  description: string             // 描述 (显示在 typeahead 和 help 中)
  argumentHint?: string           // 参数提示 (如 "session-id")

  // === 可见性控制 ===
  availability?: CommandAvailability[]  // 认证/提供商门控
  isEnabled?: () => boolean             // 运行时条件门控 (feature flags 等)
  isHidden?: boolean                    // 从 typeahead/help 中隐藏

  // === 调用控制 ===
  userInvocable?: boolean         // 用户能否通过 /name 调用 (false = 仅模型可用)
  disableModelInvocation?: boolean // 模型能否通过 SkillTool 调用
  immediate?: boolean             // 是否绕过队列立即执行

  // === 来源追踪 ===
  loadedFrom?: 'commands_DEPRECATED' | 'skills' | 'plugin'
             | 'managed' | 'bundled' | 'mcp'
  kind?: 'workflow'               // 区分 workflow 命令 (UI 上有 badge)

  // === 模型集成 ===
  whenToUse?: string              // 告诉模型何时应该使用此命令
  version?: string                // 版本号

  // === 安全 ===
  isSensitive?: boolean           // 参数是否需要脱敏 (如 API key)

  // === 显示 ===
  userFacingName?: () => string   // 用户可见名称 (可能与 name 不同)
  hasUserSpecifiedDescription?: boolean // 描述是否由用户/插件显式提供
}
```

### 设计决策讨论

**为什么 `availability` 和 `isEnabled` 是两个独立的概念？**

源码注释说得很清楚：

```typescript
/**
 * This is separate from `isEnabled()`:
 *   - `availability` = who can use this (auth/provider requirement, static)
 *   - `isEnabled()`  = is this turned on right now (GrowthBook, platform, env vars)
 */
```

`availability` 回答的是"这个命令**面向谁**"——它是一个身份问题。`/upgrade` 只对 `claude-ai` 订阅者有意义（Bedrock/Vertex 用户不通过 Anthropic 升级）。`isEnabled` 回答的是"这个命令**现在能用吗**"——它是一个状态问题。`/voice` 只在 `VOICE_MODE` feature flag 开启时可用。

分离这两个概念的好处是：`availability` 在 `getCommands()` 中**每次调用都重新检查**（因为用户可能通过 `/login` 改变认证状态），而 `isEnabled` 可以在命令定义时静态绑定。

**为什么 `local` 和 `local-jsx` 都用 `load()` 延迟加载？**

```typescript
type LocalCommand = {
  type: 'local'
  load: () => Promise<LocalCommandModule>  // 延迟加载
}

type LocalJSXCommand = {
  type: 'local-jsx'
  load: () => Promise<LocalJSXCommandModule>  // 延迟加载
}
```

这是启动性能优化。80+ 命令的实现代码加起来可能有数万行，如果在启动时全部 import，会显著增加模块加载时间。通过 `load()` 延迟加载，命令的实现代码只在用户实际调用时才被加载。

一个典型的命令定义长这样：

```typescript
// commands/cost/index.ts
const command: Command = {
  type: 'local',
  name: 'cost',
  description: 'Show the total cost and duration of this session',
  supportsNonInteractive: true,
  load: () => import('./cost.js'),  // 只在 /cost 被调用时才加载 cost.js
}
```

`commands.ts` 中 import 的只是这个轻量的命令定义对象，不包含实际的执行逻辑。

**为什么 `PromptCommand` 没有 `load()` 而是直接定义 `getPromptForCommand()`？**

因为 `PromptCommand` 的"执行"本质上就是生成一段文本（prompt），这段文本通常来自 markdown 文件或简单的字符串拼接，不需要加载重量级的 UI 框架或复杂逻辑。但也有例外——`insights` 命令的实现有 113KB（3200 行），所以它用了一个手动的延迟加载 shim：

```typescript
// commands.ts — insights 命令的延迟加载 shim
const usageReport: Command = {
  type: 'prompt',
  name: 'insights',
  description: 'Generate a report analyzing your Claude Code sessions',
  contentLength: 0,
  progressMessage: 'analyzing your sessions',
  source: 'builtin',
  async getPromptForCommand(args, context) {
    // 113KB 的模块只在 /insights 被调用时才加载
    const real = (await import('./commands/insights.js')).default
    if (real.type !== 'prompt') throw new Error('unreachable')
    return real.getPromptForCommand(args, context)
  },
}
```

这是一个**务实的妥协**：大多数 prompt 命令不需要延迟加载，但对于特别重的命令，可以在注册时手动包装一层。

**`userInvocable` vs `disableModelInvocation` 的双向控制**

这两个字段控制命令的两个调用方向：

| 字段 | 用户 `/name` | 模型 SkillTool |
|------|-------------|---------------|
| 默认 | ✅ 可调用 | ✅ 可调用 |
| `userInvocable: false` | ❌ 报错 | ✅ 可调用 |
| `disableModelInvocation: true` | ✅ 可调用 | ❌ 不可见 |

为什么需要 `userInvocable: false`？某些 Skills 的 prompt 是为模型设计的（包含工具使用指令、输出格式要求等），用户直接调用没有意义。比如一个"代码审查"skill 的 prompt 可能包含"请使用 FileReadTool 读取以下文件"——这对用户来说毫无意义。

为什么需要 `disableModelInvocation: true`？某些命令是纯 UI 操作（如 `/config`、`/theme`），模型调用它们没有意义，而且会浪费 token。

---

## 9.3 命令注册表：七种来源的聚合与门控

### 面临的问题

Claude Code 的命令不是一个静态列表。它们来自至少七个不同的来源，每个来源有不同的加载时机、不同的信任级别、不同的生命周期：

1. **内置命令**（`COMMANDS()`）：随代码编译，静态 import
2. **Bundled Skills**：随代码分发的预打包 skill 文件
3. **Builtin Plugin Skills**：内置插件提供的 skill
4. **Skill 目录命令**：用户在 `.claude/skills/` 目录中定义的 markdown skill
5. **Workflow 命令**：workflow 脚本生成的命令
6. **Plugin 命令**：第三方插件注册的命令
7. **MCP 命令**：MCP 服务器动态提供的命令

问题是：如何把这些来源聚合成一个统一的命令列表，同时处理好优先级、去重、门控和缓存？

### 解法：分层加载 + 两级过滤

`src/commands.ts` 是命令注册表的核心。它的设计分为三层：

```
Layer 1: 静态注册 (模块加载时)
  ├─ 普通 import: 无条件加载的命令定义对象
  ├─ feature() 门控 require: 编译期条件加载
  └─ USER_TYPE 门控 require: 运行时条件加载

Layer 2: 动态聚合 (首次调用时, memoized)
  └─ loadAllCommands(cwd): 并行加载所有来源
      ├─ getSkills(cwd)
      │   ├─ getSkillDirCommands(cwd)    → skill 目录
      │   ├─ getPluginSkills()           → 插件 skills
      │   ├─ getBundledSkills()          → bundled skills
      │   └─ getBuiltinPluginSkillCommands() → 内置插件 skills
      ├─ getPluginCommands()             → 插件命令
      ├─ getWorkflowCommands(cwd)        → workflow 命令
      └─ COMMANDS()                      → 内置命令

Layer 3: 运行时过滤 (每次调用)
  └─ getCommands(cwd): 过滤 + 动态 skills 注入
      ├─ meetsAvailabilityRequirement()  → 认证/提供商门控
      ├─ isCommandEnabled()              → feature flag 门控
      └─ getDynamicSkills()              → 运行时发现的 skills
```

### 静态注册层：三种导入策略

`commands.ts` 的前 120 行展示了三种截然不同的导入策略，每种解决不同的问题：

**策略一：普通 `import`（无条件加载）**

```typescript
import clear from './commands/clear/index.js'
import compact from './commands/compact/index.js'
import config from './commands/config/index.js'
import cost from './commands/cost/index.js'
// ... 约 60 个命令
```

这些是所有构建变体都包含的核心命令。它们在模块求值时同步加载——但注意，加载的只是命令**定义对象**（name、description、type、load 函数），不是命令的**实现代码**。

**策略二：`feature()` 门控 `require`（编译期条件加载）**

```typescript
const voiceCommand = feature('VOICE_MODE')
  ? require('./commands/voice/index.js').default
  : null

const bridge = feature('BRIDGE_MODE')
  ? require('./commands/bridge/index.js').default
  : null

const ultraplan = feature('ULTRAPLAN')
  ? require('./commands/ultraplan.js').default
  : null
```

这些命令只在特定构建变体中存在。`feature()` 在编译期被求值为 `true` 或 `false`，当为 `false` 时，bundler 的死代码消除会移除整个 `require` 调用及其依赖模块。

为什么用 `require` 而不是 `import`？因为 ES module 的 `import` 语句不能出现在条件表达式中（它是声明式的，不是表达式）。`require` 是 CommonJS 的运行时调用，可以出现在任何表达式位置。虽然 `await import()` 也可以，但它是异步的，而这里需要在模块顶层同步完成。

源码中有一个有趣的注释：

```typescript
// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
```

这告诉代码格式化工具不要重排 import 顺序——因为某些 import 的位置是有意义的（ANT-ONLY 标记依赖于特定的排列）。

**策略三：`USER_TYPE` 门控 `require`（运行时条件加载）**

```typescript
const agentsPlatform =
  process.env.USER_TYPE === 'ant'
    ? require('./commands/agents-platform/index.js').default
    : null
```

这是运行时门控——同一个构建产物，根据环境变量决定是否加载。与 `feature()` 不同，这里的代码**存在于最终产物中**，只是不一定被执行。适用于不值得为其创建独立构建变体的小功能。

### COMMANDS()：内置命令的延迟初始化

```typescript
const COMMANDS = memoize((): Command[] => [
  addDir, advisor, agents, branch, btw, chrome, clear, color,
  compact, config, copy, desktop, context, cost, diff, doctor,
  effort, exit, fast, files, help, ide, init, keybindings,
  // ... 约 80 个命令
  ...(process.env.USER_TYPE === 'ant' && !process.env.IS_DEMO
    ? INTERNAL_ONLY_COMMANDS
    : []),
])
```

为什么 `COMMANDS` 是一个 `memoize` 包装的函数，而不是一个顶层常量？

源码注释说得很清楚：

```typescript
// Declared as a function so that we don't run this until getCommands is called,
// since underlying functions read from config, which can't be read at module
// initialization time
```

某些命令的定义依赖于配置系统（比如 `login()` 是一个函数调用，它需要读取当前的认证状态来决定命令的行为）。配置系统在 `enableConfigs()` 之后才可用，而 `commands.ts` 的模块求值发生在 `enableConfigs()` 之前。通过延迟到首次调用时才构建数组，避免了时序问题。

`INTERNAL_ONLY_COMMANDS` 是一个有趣的设计——它把所有内部专用命令集中在一个数组中：

```typescript
export const INTERNAL_ONLY_COMMANDS = [
  backfillSessions, breakCache, bughunter, commit, commitPushPr,
  ctx_viz, goodClaude, issue, initVerifiers, mockLimits,
  bridgeKick, version, resetLimits, onboarding, share,
  summary, teleport, antTrace, perfIssue, env, oauthRefresh,
  debugToolCall, agentsPlatform, autofixPr,
  // ... feature-gated 命令
].filter(Boolean)  // 过滤掉 feature() 门控为 null 的命令
```

注意末尾的 `.filter(Boolean)`——因为 feature-gated 命令可能是 `null`（当 feature flag 关闭时），需要过滤掉。

### loadAllCommands()：多来源并行加载

```typescript
const loadAllCommands = memoize(async (cwd: string): Promise<Command[]> => {
  const [
    { skillDirCommands, pluginSkills, bundledSkills, builtinPluginSkills },
    pluginCommands,
    workflowCommands,
  ] = await Promise.all([
    getSkills(cwd),           // 并行加载 skills
    getPluginCommands(),       // 并行加载插件命令
    getWorkflowCommands       // 并行加载 workflow 命令
      ? getWorkflowCommands(cwd)
      : Promise.resolve([]),
  ])

  return [
    ...bundledSkills,          // 优先级最高：bundled skills
    ...builtinPluginSkills,    // 内置插件 skills
    ...skillDirCommands,       // 用户 skill 目录
    ...workflowCommands,       // workflow 命令
    ...pluginCommands,         // 第三方插件命令
    ...pluginSkills,           // 第三方插件 skills
    ...COMMANDS(),             // 优先级最低：内置命令
  ]
})
```

这里有两个关键设计决策：

**1. 并行加载**：三个来源（skills、plugins、workflows）通过 `Promise.all` 并行加载。每个来源都涉及磁盘 I/O（读取 skill 文件、扫描插件目录），并行化可以显著减少总加载时间。

**2. 数组顺序即优先级**：返回数组的顺序决定了命令的优先级。当多个来源提供同名命令时，`findCommand()` 会返回第一个匹配的。bundled skills 排在最前面，内置命令排在最后——这意味着**外部来源可以覆盖内置命令**。

这个优先级设计是有意的：如果用户安装了一个插件提供了 `/review` 命令，它应该覆盖内置的 `/review`，因为用户显然希望使用插件版本。

**3. memoize by cwd**：`loadAllCommands` 按 `cwd` 缓存。不同的工作目录可能有不同的 `.claude/skills/` 内容和不同的项目级插件配置。

### getCommands()：每次调用都重新过滤

```typescript
export async function getCommands(cwd: string): Promise<Command[]> {
  const allCommands = await loadAllCommands(cwd)  // 命中缓存

  const dynamicSkills = getDynamicSkills()  // 运行时发现的 skills

  const baseCommands = allCommands.filter(
    _ => meetsAvailabilityRequirement(_) && isCommandEnabled(_),
  )

  // ... 动态 skills 去重和插入逻辑
}
```

为什么 `loadAllCommands` 是 memoized 的，但 `getCommands` 不是？

源码注释解释了：

```typescript
/**
 * Returns commands available to the current user. The expensive loading is
 * memoized, but availability and isEnabled checks run fresh every call so
 * auth changes (e.g. /login) take effect immediately.
 */
```

加载是昂贵的（磁盘 I/O），所以缓存。但过滤必须每次重新执行——因为用户可能在会话中通过 `/login` 改变了认证状态，或者 feature flag 可能在运行时被远程更新。

### meetsAvailabilityRequirement()：认证门控

```typescript
export function meetsAvailabilityRequirement(cmd: Command): boolean {
  if (!cmd.availability) return true  // 无限制 = 所有人可用

  for (const a of cmd.availability) {
    switch (a) {
      case 'claude-ai':
        if (isClaudeAISubscriber()) return true
        break
      case 'console':
        if (!isClaudeAISubscriber() && !isUsing3PServices()
            && isFirstPartyAnthropicBaseUrl())
          return true
        break
    }
  }
  return false
}
```

这个函数实现了一个**白名单模式**：命令声明它适用于哪些用户类型，只有匹配的用户才能看到。注意 `console` 的判定逻辑——它排除了三种情况：claude.ai 订阅者、第三方服务（Bedrock/Vertex/Foundry）、自定义 base URL 用户。只有直接使用 `api.anthropic.com` 的 Console API key 用户才匹配。

### MCP 命令的特殊路径

MCP 命令不走 `loadAllCommands`，而是通过 React Hook 层合并：

```typescript
// hooks/useMergedCommands.ts
export function useMergedCommands(
  initialCommands: Command[],
  mcpCommands: Command[],
): Command[] {
  return useMemo(() => {
    if (mcpCommands.length > 0) {
      return uniqBy([...initialCommands, ...mcpCommands], 'name')
    }
    return initialCommands
  }, [initialCommands, mcpCommands])
}
```

为什么 MCP 命令不在 `loadAllCommands` 中加载？因为 MCP 服务器的连接是**异步且动态的**——服务器可能在会话中途连接或断开，它提供的命令列表也可能变化。`loadAllCommands` 是一次性加载并缓存的，不适合处理这种动态性。

MCP 命令存储在 `AppState.mcp.commands` 中（响应式状态），通过 `useMergedCommands` Hook 在 React 渲染层与静态命令合并。`uniqBy` 按 `name` 去重，确保同名命令不会重复出现。

### 命令安全分级：Remote 和 Bridge 白名单

```typescript
// 远程模式下安全的命令
export const REMOTE_SAFE_COMMANDS: Set<Command> = new Set([
  session, exit, clear, help, theme, color, vim, cost,
  usage, copy, btw, feedback, plan, keybindings, statusline,
  stickers, mobile,
])

// Bridge（远程控制）模式下安全的命令
export const BRIDGE_SAFE_COMMANDS: Set<Command> = new Set([
  compact, clear, cost, summary, releaseNotes, files,
])
```

这两个白名单解决了不同的安全问题：

- `REMOTE_SAFE_COMMANDS`：在 `--remote` 模式下，只有这些命令可用。它们只影响本地 TUI 状态，不依赖本地文件系统、Git、Shell 等。
- `BRIDGE_SAFE_COMMANDS`：通过 Remote Control bridge（手机/Web 客户端）发来的命令，只有这些 `local` 类型命令可以执行。`local-jsx` 命令被完全阻止（它们渲染 Ink UI，在远程端没有意义），`prompt` 命令默认允许（它们只是生成文本）。

源码注释记录了这个设计的历史背景：

```typescript
/**
 * PR #19134 blanket-blocked all slash commands from bridge inbound because
 * `/model` from iOS was popping the local Ink picker. This predicate relaxes
 * that with an explicit allowlist...
 */
```

最初是全部阻止，后来发现太严格了（用户从手机上想执行 `/compact` 是合理的），于是改为白名单模式。

### 缓存失效策略

```typescript
export function clearCommandsCache(): void {
  clearCommandMemoizationCaches()  // 清除 loadAllCommands 等的 memoize 缓存
  clearPluginCommandCache()         // 清除插件命令缓存
  clearPluginSkillsCache()          // 清除插件 skills 缓存
  clearSkillCaches()                // 清除 skill 目录缓存
}

export function clearCommandMemoizationCaches(): void {
  loadAllCommands.cache?.clear?.()
  getSkillToolCommands.cache?.clear?.()
  getSlashCommandToolSkills.cache?.clear?.()
  clearSkillIndexCache?.()  // 清除 skill 搜索索引缓存
}
```

缓存失效是一个经典的难题。这里的策略是**显式失效**——当已知缓存可能过期时（如 `/reload-plugins`、动态 skill 发现），主动调用 `clearCommandsCache()`。

源码中有一个微妙的注释揭示了多层缓存的陷阱：

```typescript
// getSkillIndex in skillSearch/localSearch.ts is a separate memoization layer
// built ON TOP of getSkillToolCommands/getCommands. Clearing only the inner
// caches is a no-op for the outer — lodash memoize returns the cached result
// without ever reaching the cleared inners. Must clear it explicitly.
```

当缓存 A 依赖缓存 B 时，清除 B 不会自动使 A 失效——因为 A 的 memoize 检查的是自己的 key，不知道 B 已经变了。必须同时清除两层。这是 memoize 缓存的一个常见陷阱。

---

## 9.4 命令分类全景：80+ 命令的功能图谱

### 面临的问题

80+ 命令不是随意堆砌的——它们覆盖了一个 AI 编程助手的完整功能面。理解命令的分类有助于理解 Claude Code 的产品边界：它不只是一个"聊天机器人"，而是一个完整的开发环境。

### 按执行类型分类

从工程视角看，命令的执行类型决定了它的技术复杂度和用户交互模式：

```
┌─────────────────────────────────────────────────────────────────┐
│  local (同步执行，返回文本)                                       │
│  ─────────────────────────────────────────────────────────────── │
│  /cost    /usage   /clear   /compact  /files   /status          │
│  /copy    /export  /color   /vim      /fast    /effort          │
│  /env     /tag     /version /stickers /btw     /feedback        │
│  /exit    /help    /stats   /passes   /memory  /output-style    │
│                                                                  │
│  特点: 最简单的命令类型。读取内存状态或执行简单操作，              │
│        返回一行文本。不需要 UI 渲染，不需要模型交互。              │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│  local-jsx (渲染交互式 Ink UI)                                   │
│  ─────────────────────────────────────────────────────────────── │
│  /config  /model   /mcp     /resume   /session  /diff           │
│  /theme   /plugin  /skills  /hooks    /permissions /keybindings  │
│  /login   /logout  /ide     /desktop  /mobile   /chrome         │
│  /doctor  /tasks   /plan    /privacy-settings   /sandbox-toggle  │
│  /rename  /branch  /rewind  /agents   /context  /terminal-setup  │
│                                                                  │
│  特点: 最复杂的命令类型。渲染完整的终端 UI 面板，                 │
│        用户可以上下选择、输入值、按 ESC 退出。                     │
│        通过 onDone 回调通知完成。                                 │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│  prompt (生成 prompt 注入对话，触发模型调用)                      │
│  ─────────────────────────────────────────────────────────────── │
│  /commit (fork)     /review (inline)    /security-review         │
│  /init   (inline)   /advisor (inline)   /insights                │
│  /bughunter         /pr_comments        /release-notes           │
│  + 所有用户自定义 Skills / 插件 Skills / MCP Skills               │
│                                                                  │
│  特点: 命令本身不执行逻辑，而是生成一段精心构造的 prompt，        │
│        注入对话后让模型来完成实际工作。                            │
│        inline 模式在当前对话中展开，fork 模式在子代理中执行。      │
└─────────────────────────────────────────────────────────────────┘
```

### 按功能领域分类

从用户视角看，命令覆盖了以下功能领域：

| 领域 | 命令 | 说明 |
|------|------|------|
| **会话管理** | `/clear` `/compact` `/resume` `/session` `/export` `/share` `/rename` | 管理对话的生命周期：清空、压缩、恢复、导出 |
| **Git 操作** | `/commit` `/diff` `/branch` `/review` `/rewind` `/pr_comments` | 深度 Git 集成：提交、审查、分支管理 |
| **配置管理** | `/config` `/model` `/effort` `/fast` `/theme` `/color` `/vim` `/keybindings` `/output-style` `/statusline` | 运行时配置调整，无需重启 |
| **工具与扩展** | `/mcp` `/plugin` `/skills` `/hooks` `/reload-plugins` | 管理外部工具链：MCP 服务器、插件、Skills |
| **安全与权限** | `/permissions` `/privacy-settings` `/sandbox-toggle` `/login` `/logout` | 权限模式切换、隐私设置、认证管理 |
| **诊断与调试** | `/doctor` `/status` `/cost` `/usage` `/stats` `/files` `/tasks` | 系统健康检查、资源使用统计 |
| **IDE 集成** | `/ide` `/desktop` `/mobile` `/chrome` | 与 VS Code、JetBrains、移动端、浏览器的集成 |
| **开发辅助** | `/review` `/security-review` `/bughunter` `/advisor` `/insights` | AI 驱动的代码审查、安全扫描、建议 |
| **上下文管理** | `/context` `/add-dir` `/memory` `/plan` | 管理模型可见的上下文信息 |

### 设计决策讨论

**为什么 `/commit` 是 prompt 类型而不是 local 类型？**

一个 git commit 命令看似可以用 `local` 类型实现——调用 `git add` + `git commit` 就行。但 Claude Code 的 `/commit` 不只是执行 git 命令，它需要：
1. 分析所有 staged changes 的语义
2. 根据项目的 commit message 风格生成合适的 message
3. 判断是否有敏感文件不应该被提交

这些都需要 LLM 的推理能力，所以 `/commit` 是一个 `prompt` 命令——它生成一段包含 git diff 和 commit 规范的 prompt，让模型来决定如何提交。而且它使用 `context: 'fork'`，在子代理中执行，避免污染主对话的上下文。

**为什么 `/model` 是 local-jsx 而不是 local？**

`/model` 需要展示一个模型选择列表，用户可以上下箭头选择、按 Enter 确认。这种交互式 UI 只有 `local-jsx` 类型才能实现。如果用 `local` 类型，只能接受命令行参数（如 `/model sonnet`），无法提供交互式选择体验。

**为什么 `/compact` 是 local 而不是 prompt？**

上下文压缩确实需要调用 LLM（生成摘要），但 `/compact` 命令本身只是**触发**压缩流程，压缩的实际执行在 `services/compact/` 中。命令返回的是压缩结果（`type: 'compact'`），由执行引擎负责重建消息列表。这是一个"命令触发 + 服务执行"的分离模式。

---

## 9.5 命令执行流程：从用户按下 Enter 到命令完成

### 面临的问题

用户输入 `/config` 按下 Enter 后，这个字符串需要经过一系列处理才能变成实际的命令执行。但这个过程面临几个棘手的问题：

1. **并发控制**：如果模型正在运行（query active），用户输入的命令应该排队等待还是立即执行？
2. **输入类型判断**：`/var/log/syslog` 是一个斜杠命令还是一个文件路径？
3. **远程安全**：从手机端发来的 `/model` 命令会弹出本地 Ink 选择器，这在远程端没有意义。
4. **命令链式执行**：某些命令完成后需要自动触发下一个命令（如 `/discover` 选择后自动执行对应的 skill）。

### 完整数据流

```
用户按下 Enter
    │
    ▼
handlePromptSubmit()                    ← 入口点
    │
    ├─ 模型正在运行? ──YES──→ enqueue(command)  → 等待队列处理
    │                                              │
    │                                              ▼
    │                                    useQueueProcessor (React Hook)
    │                                        │
    │                                        ├─ queryGuard: 模型空闲?
    │                                        ├─ hasActiveLocalJsxUI: 无交互 UI?
    │                                        └─ queueSnapshot.length > 0?
    │                                              │ 全部满足
    │                                              ▼
    │                                    processQueueIfReady()
    │                                        │
    │                                        ├─ 斜杠命令/bash? → 单独处理
    │                                        └─ 普通文本? → 批量处理
    │                                              │
    └─ 模型空闲 ──────────────────────────→ executeUserInput()
                                                   │
                                                   ▼
                                          processUserInput()
                                                   │
                                          ┌────────┼────────┐
                                          ▼        ▼        ▼
                                        bash    slash     text
                                        mode    command   prompt
                                          │        │        │
                                          ▼        ▼        ▼
                                    processBash  process   process
                                    Command()   Slash     Text
                                                Command() Prompt()
```

### 第一站：handlePromptSubmit() — 入口分流

`src/utils/handlePromptSubmit.ts` 是用户输入的第一个处理点。它解决的核心问题是：**当模型正在运行时，用户输入应该怎么办？**

```typescript
// handlePromptSubmit.ts — 简化后的核心逻辑

export async function handlePromptSubmit(params) {
  const { input, mode, queryGuard, commands } = params

  // 1. 立即命令（immediate）：即使模型在运行也立即执行
  //    典型场景：/model、/fast、/effort — 用户想在模型运行时切换模型
  if (mode === 'prompt' && typeof input === 'string' && input.startsWith('/')) {
    const parsed = parseSlashCommand(input)
    const cmd = parsed ? findCommand(parsed.commandName, commands) : undefined
    if (cmd?.immediate && cmd.type === 'local-jsx' && isCommandEnabled(cmd)) {
      // 直接执行，不排队
      await executeImmediateCommand(cmd, parsed.args, params)
      return
    }
  }

  // 2. 模型正在运行 → 排队
  if (queryGuard.isActive()) {
    enqueue({ value: input, mode, priority: 'next', ... })
    return
  }

  // 3. 模型空闲 → 直接执行
  await executeUserInput(input, mode, params)
}
```

`immediate` 标志是一个精妙的设计。考虑这个场景：用户启动了一个长时间运行的查询，中途想切换模型。如果 `/model` 必须等查询完成才能执行，用户体验很差。`immediate: true` 让这类配置命令可以"插队"执行。

但不是所有命令都能 immediate——只有 `local-jsx` 类型的命令才行，因为它们渲染独立的 UI 面板，不会干扰正在进行的查询。`prompt` 类型的命令如果 immediate 执行，会向对话注入消息，破坏正在进行的 API 调用。

### 第二站：命令队列与队列处理器

当命令被排队后，`useQueueProcessor` Hook 负责在合适的时机取出并执行。

```typescript
// hooks/useQueueProcessor.ts

export function useQueueProcessor({
  executeQueuedInput,
  hasActiveLocalJsxUI,
  queryGuard,
}: UseQueueProcessorParams): void {
  const isQueryActive = useSyncExternalStore(
    queryGuard.subscribe,
    queryGuard.getSnapshot,
  )
  const queueSnapshot = useSyncExternalStore(
    subscribeToCommandQueue,
    getCommandQueueSnapshot,
  )

  useEffect(() => {
    if (isQueryActive) return          // 模型在运行，等待
    if (hasActiveLocalJsxUI) return    // 有交互 UI 在显示，等待
    if (queueSnapshot.length === 0) return  // 队列为空，无事可做

    processQueueIfReady({ executeInput: executeQueuedInput })
  }, [queueSnapshot, isQueryActive, executeQueuedInput, hasActiveLocalJsxUI])
}
```

这里用了 `useSyncExternalStore` 而不是 `useContext` 或 `useState`。为什么？源码注释提到：

```typescript
// This guarantees re-render when the store changes, bypassing
// React context propagation delays that cause missed notifications in Ink.
```

Ink（终端 React 渲染器）的 Context 传播有延迟问题——状态变化可能不会立即触发子组件重渲染。`useSyncExternalStore` 直接订阅外部 store，绕过了 React 的 Context 传播机制，确保队列变化能立即被感知。

### 队列优先级：now > next > later

命令队列不是简单的 FIFO，而是有优先级的：

```typescript
// messageQueueManager.ts

// 用户输入：默认 'next' 优先级
export function enqueue(command: QueuedCommand): void {
  commandQueue.push({ ...command, priority: command.priority ?? 'next' })
  notifySubscribers()
}

// 任务通知：默认 'later' 优先级
export function enqueuePendingNotification(command: QueuedCommand): void {
  commandQueue.push({ ...command, priority: command.priority ?? 'later' })
  notifySubscribers()
}
```

三级优先级的设计意图：

| 优先级 | 用途 | 典型场景 |
|--------|------|---------|
| `now` | 最高优先级，插队执行 | 系统紧急通知 |
| `next` | 用户输入的默认优先级 | 用户输入的命令和文本 |
| `later` | 系统通知的默认优先级 | 后台任务完成通知、cron 触发 |

这确保了**用户输入永远不会被系统通知饿死**——即使有大量后台任务完成通知排队，用户的下一条输入也会优先处理。

### 队列处理器：斜杠命令单独处理

```typescript
// queueProcessor.ts

export function processQueueIfReady({ executeInput }): ProcessQueueResult {
  const isMainThread = (cmd: QueuedCommand) => cmd.agentId === undefined
  const next = peek(isMainThread)
  if (!next) return { processed: false }

  // 斜杠命令和 bash 命令：单独处理
  if (isSlashCommand(next) || next.mode === 'bash') {
    const cmd = dequeue(isMainThread)!
    void executeInput([cmd])
    return { processed: true }
  }

  // 普通文本：批量处理（同 mode 的一起取出）
  const targetMode = next.mode
  const commands = dequeueAllMatching(
    cmd => isMainThread(cmd) && !isSlashCommand(cmd) && cmd.mode === targetMode,
  )
  void executeInput(commands)
  return { processed: true }
}
```

为什么斜杠命令必须单独处理？因为斜杠命令可能改变系统状态（如 `/compact` 压缩上下文、`/clear` 清空消息），如果和其他命令批量处理，状态变更的时序会变得不可预测。

为什么普通文本可以批量处理？因为多条普通文本消息最终都会被拼接成一个 API 请求发给模型，批量处理减少了 API 调用次数。

注意 `isMainThread` 过滤器——它排除了 `agentId !== undefined` 的命令。这些是发给子代理的消息，不应该被主线程的队列处理器消费。源码注释解释了不过滤的后果：

```typescript
// an unfiltered peek() returning a subagent notification would set targetMode,
// dequeueAllMatching would find nothing matching that mode with agentId===undefined,
// and we'd return processed: false with the queue unchanged → the React effect
// never re-fires and any queued user prompt stalls permanently.
```

### 第三站：processUserInput() — 三路分发

```typescript
// processUserInput/processUserInput.ts — 简化后的核心路由

async function processUserInputBase(input, mode, ...): Promise<ProcessUserInputBaseResult> {
  // ... 图片处理、附件提取 ...

  // Bridge 安全检查：远程输入的命令过滤
  if (bridgeOrigin && inputString.startsWith('/')) {
    const cmd = findCommand(parsed.commandName, context.options.commands)
    if (cmd) {
      if (isBridgeSafeCommand(cmd)) {
        effectiveSkipSlash = false   // 安全命令：允许执行
      } else {
        return errorMessage(`/${getCommandName(cmd)} isn't available over Remote Control.`)
      }
    }
    // 未知命令：当作普通文本处理（手机用户输入 "/shrug" 不应该报错）
  }

  // 路由 1: Bash 模式
  if (mode === 'bash') {
    return processBashCommand(inputString, ...)
  }

  // 路由 2: 斜杠命令
  if (!effectiveSkipSlash && inputString.startsWith('/')) {
    const { processSlashCommand } = await import('./processSlashCommand.js')
    return processSlashCommand(inputString, ...)
  }

  // 路由 3: 普通文本
  return processTextPrompt(normalizedInput, ...)
}
```

注意 `processSlashCommand` 是**动态 import** 的。这是又一个延迟加载优化——`processSlashCommand.tsx` 有 922 行，依赖了 `runAgent`、`compact` 等重量级模块。如果静态 import，即使用户从不使用斜杠命令，这些模块也会被加载。

### 第四站：processSlashCommand() — 命令执行核心

这是整个命令执行流程中最复杂的函数。它处理了命令查找、验证、分发和结果格式化。

```typescript
// processSlashCommand.tsx — 简化后的核心流程

export async function processSlashCommand(inputString, ...): Promise<ProcessUserInputBaseResult> {
  // Step 1: 解析
  const parsed = parseSlashCommand(inputString)
  if (!parsed) {
    return errorMessage('Commands are in the form `/command [args]`')
  }

  // Step 2: 查找
  if (!hasCommand(commandName, context.options.commands)) {
    // 看起来像命令名？→ "Unknown skill: xxx"
    // 看起来像文件路径？→ 当作普通文本发给模型
    if (looksLikeCommand(commandName) && !isFilePath) {
      return errorMessage(`Unknown skill: ${commandName}`)
    }
    // 不像命令 → 当作普通用户输入
    return { messages: [createUserMessage(inputString)], shouldQuery: true }
  }

  // Step 3: 执行
  const result = await getMessagesForSlashCommand(commandName, args, ...)

  // Step 4: 遥测
  logEvent('tengu_input_command', { input: sanitizedCommandName, ... })

  return result
}
```

**`looksLikeCommand()` 的巧妙判断**

```typescript
export function looksLikeCommand(commandName: string): boolean {
  return !/[^a-zA-Z0-9:\-_]/.test(commandName)
}
```

这个函数解决了一个微妙的歧义问题：`/var/log/syslog` 以 `/` 开头，但它是一个文件路径，不是命令。判断标准是：命令名只包含字母、数字、冒号、连字符和下划线。如果包含 `/`（路径分隔符）或其他特殊字符，就不是命令。

但这还不够——`/tmp` 看起来像一个合法的命令名（只有字母），但它是一个目录。所以还有一个额外的文件系统检查：

```typescript
let isFilePath = false
try {
  await getFsImplementation().stat(`/${commandName}`)
  isFilePath = true
} catch {
  // Not a file path
}
```

### 第五站：getMessagesForSlashCommand() — 按类型分发

这是命令执行的最终分发点，根据命令的 `type` 字段走不同的执行路径：

```typescript
async function getMessagesForSlashCommand(commandName, args, ...): Promise<SlashCommandResult> {
  const command = getCommand(commandName, context.options.commands)

  // 用户可调用性检查
  if (command.userInvocable === false) {
    return errorMessage('This skill can only be invoked by Claude...')
  }

  // 记录 skill 使用频率（用于 typeahead 排序）
  if (command.type === 'prompt' && command.userInvocable !== false) {
    recordSkillUsage(commandName)
  }

  switch (command.type) {
    case 'local-jsx':  return executeLocalJSXCommand(command, args, ...)
    case 'local':      return executeLocalCommand(command, args, ...)
    case 'prompt':     return executePromptCommand(command, args, ...)
  }
}
```

#### local-jsx 命令的执行：Promise + onDone 回调模式

`local-jsx` 命令的执行模式是整个命令系统中最复杂的部分。它需要解决一个根本矛盾：**React 组件是声明式的（返回 JSX），但命令执行是命令式的（需要知道"完成了"）。**

```typescript
case 'local-jsx': {
  return new Promise<SlashCommandResult>(resolve => {
    let doneWasCalled = false

    const onDone = (result?, options?) => {
      doneWasCalled = true

      if (options?.display === 'skip') {
        resolve({ messages: [], shouldQuery: false, command })
        return
      }

      // 根据 display 选项决定如何格式化结果消息
      resolve({
        messages: formatResultMessages(command, args, result, options),
        shouldQuery: options?.shouldQuery ?? false,
        command,
      })
    }

    // 延迟加载并执行命令
    command.load()
      .then(mod => mod.call(onDone, context, args))
      .then(jsx => {
        if (jsx == null) return
        if (context.options.isNonInteractiveSession) {
          resolve({ messages: [], shouldQuery: false, command })
          return
        }
        // 防护：如果 onDone 在 call() 期间已经被调用（早期退出路径），
        // 不要再设置 JSX，否则会导致 UI 状态卡死
        if (doneWasCalled) return

        setToolJSX({
          jsx,
          shouldHidePromptInput: true,  // 隐藏输入框
          isLocalJSXCommand: true,       // 标记为交互式命令
          isImmediate: command.immediate === true,
        })
      })
      .catch(e => {
        // 如果 load()/call() 抛异常且 onDone 从未被调用，
        // Promise 会永远挂起，导致 queryGuard 卡在 'dispatching'
        if (doneWasCalled) return
        doneWasCalled = true
        setToolJSX({ jsx: null, clearLocalJSX: true })
        resolve({ messages: [], shouldQuery: false, command })
      })
  })
}
```

这段代码有几个值得注意的防护措施：

1. **`doneWasCalled` 守卫**：防止 `onDone` 被调用两次，或者在 `onDone` 已经调用后还设置 JSX。源码注释解释了不加守卫的后果：

```typescript
// Guard: if onDone fired during mod.call() (early-exit path
// that calls onDone then returns JSX), skip setToolJSX. This
// chain is fire-and-forget — the outer Promise resolves when
// onDone is called, so executeUserInput may have already run
// its setToolJSX({clearLocalJSX: true}) before we get here.
// Setting isLocalJSXCommand after clear leaves it stuck true,
// blocking useQueueProcessor and TextInput focus.
```

2. **异常兜底**：如果命令加载或执行失败，必须 resolve Promise（而不是让它挂起），否则 `queryGuard` 会永远卡在 `dispatching` 状态，整个队列处理器死锁。

3. **非交互模式降级**：在 `-p`（非交互）模式下，`local-jsx` 命令无法渲染 UI，直接返回空结果。

#### local 命令的执行：简单直接

```typescript
case 'local': {
  const mod = await command.load()
  const result = await mod.call(args, context)

  if (result.type === 'skip') {
    return { messages: [], shouldQuery: false, command }
  }

  if (result.type === 'compact') {
    // 特殊处理：压缩结果需要重建消息列表
    return buildPostCompactMessages(result.compactionResult)
  }

  // 文本结果
  return {
    messages: [userMessage, createCommandInputMessage(`<local-command-stdout>${result.value}</local-command-stdout>`)],
    shouldQuery: false,
    command,
  }
}
```

`local` 命令的三种返回值类型各有用途：
- `text`：最常见，显示一行文本（如 `/cost` 显示费用）
- `compact`：`/compact` 命令专用，返回压缩后的消息列表
- `skip`：静默完成，不在对话中留下任何痕迹

注意 `isSensitive` 的处理：

```typescript
const displayArgs = command.isSensitive && args.trim() ? '***' : args
```

如果命令标记为敏感（如涉及 API key 的命令），参数在对话历史中会被替换为 `***`。

#### prompt 命令的执行：inline vs fork

```typescript
case 'prompt': {
  if (command.context === 'fork') {
    return executeForkedSlashCommand(command, args, ...)
  }
  return getMessagesForPromptSlashCommand(command, args, ...)
}
```

**inline 模式**（默认）：命令的 prompt 内容直接展开到当前对话中，然后触发模型调用。模型在当前对话的上下文中处理这个 prompt。

**fork 模式**：命令在一个独立的子代理中执行，有自己的 token 预算和工具集。执行完成后，结果作为文本返回到主对话。

fork 模式的实现特别有趣——在 KAIROS（Assistant）模式下，它是 fire-and-forget 的：

```typescript
if (feature('KAIROS') && (await context.getAppState()).kairosEnabled) {
  // 后台执行，立即返回
  void (async () => {
    // 等待 MCP 服务器就绪
    while (Date.now() < deadline) {
      if (!s.mcp.clients.some(c => c.type === 'pending')) break
      await sleep(MCP_SETTLE_POLL_MS)
    }

    // 运行子代理
    for await (const message of runAgent({ ... })) {
      agentMessages.push(message)
    }

    // 结果重新入队
    enqueueResult(`<scheduled-task-result>...</scheduled-task-result>`)
  })()

  return { messages: [], shouldQuery: false, command }
}
```

为什么 KAIROS 模式下要 fire-and-forget？源码注释解释了：

```typescript
// Without this, N scheduled tasks on startup = N serial (subagent + main
// agent turn) cycles blocking user input. With this, N subagents run in
// parallel and results trickle into the queue as they finish.
```

在 Assistant 模式下，启动时可能有 N 个定时任务同时触发。如果串行执行，每个任务需要 30 秒，N 个任务就要 N×30 秒，期间用户无法输入。fire-and-forget 让 N 个子代理并行运行，结果通过队列异步返回。

还有一个微妙的 MCP 等待逻辑：

```typescript
// Wait for MCP servers to settle. Scheduled tasks fire at startup and
// all N drain within ~1ms (since we return immediately), capturing
// context.options.tools before MCP connects.
const deadline = Date.now() + MCP_SETTLE_TIMEOUT_MS  // 10秒
while (Date.now() < deadline) {
  if (!s.mcp.clients.some(c => c.type === 'pending')) break
  await sleep(MCP_SETTLE_POLL_MS)  // 200ms
}
```

因为 fire-and-forget 的子代理在启动后几乎立即开始执行，此时 MCP 服务器可能还没连接完成。如果不等待，子代理会缺少 MCP 工具。所以在执行前轮询等待所有 MCP 客户端就绪，最多等 10 秒。

---

## 9.6 命令发现与自动补全：让用户找到正确的命令

### 面临的问题

80+ 内置命令加上用户自定义的 Skills、插件命令、MCP 命令，总数可能超过 100 个。用户不可能记住所有命令名。如何帮助用户快速找到想要的命令？

这个问题有几个子问题：
1. **模糊搜索**：用户输入 `/com` 时，应该同时匹配 `/compact`、`/commit`、`/config`、`/copy`
2. **排序**：匹配结果的排序应该反映"用户最可能想要的"
3. **中间位置补全**：用户输入 `help me /com` 时，应该能补全中间的 `/com`
4. **性能**：每次按键都触发搜索，必须足够快

### 解法：Fuse.js 模糊搜索 + 多维度排序

`src/utils/suggestions/commandSuggestions.ts` 实现了命令自动补全的核心逻辑。

#### 搜索索引构建

```typescript
const fuse = new Fuse(commandData, {
  includeScore: true,
  threshold: 0.3,      // 相对严格的匹配阈值
  location: 0,         // 偏好字符串开头的匹配
  distance: 100,       // 允许在描述中较远位置匹配
  keys: [
    { name: 'commandName', weight: 3 },   // 命令名权重最高
    { name: 'partKey',     weight: 2 },   // 命令名的分段（如 commit-push-pr → [commit, push, pr]）
    { name: 'aliasKey',    weight: 2 },   // 别名
    { name: 'descriptionKey', weight: 0.5 }, // 描述权重最低
  ],
})
```

权重设计的意图：用户输入 `com` 时，命令名以 `com` 开头的（`compact`、`commit`）应该排在描述中包含 "com" 的命令之前。命令名的分段匹配（`partKey`）允许用户输入 `push` 匹配到 `commit-push-pr`。

索引按命令数组的引用缓存——命令列表在 REPL.tsx 中是 memoized 的，只有当命令列表真正变化时才重建索引：

```typescript
let fuseCache: { commands: Command[]; fuse: Fuse<CommandSearchItem> } | null = null

function getCommandFuse(commands: Command[]): Fuse<CommandSearchItem> {
  if (fuseCache?.commands === commands) {
    return fuseCache.fuse  // 引用相同 → 命中缓存
  }
  // 重建索引...
}
```

#### 搜索结果排序：五级优先级

Fuse.js 返回的结果按模糊匹配分数排序，但这不够好。Claude Code 在 Fuse 结果之上叠加了一个五级优先级排序：

```
优先级 1: 精确名称匹配    /compact → compact (精确)
优先级 2: 精确别名匹配    /q → exit (q 是 exit 的别名)
优先级 3: 前缀名称匹配    /com → compact, commit, config, copy
优先级 4: 前缀别名匹配    /co → copy (co 是 copy 的别名)
优先级 5: 模糊匹配        /cmpct → compact (模糊)
```

在同一优先级内，还有两个次级排序维度：

1. **名称长度**：前缀匹配中，更短的名称排在前面（`/com` → `copy` 排在 `compact` 前面，因为更"接近"精确匹配）
2. **使用频率**：Fuse 分数相近时，更常用的命令排在前面

#### 使用频率追踪：指数衰减算法

`src/utils/suggestions/skillUsageTracking.ts` 实现了一个基于指数衰减的使用频率追踪：

```typescript
export function getSkillUsageScore(skillName: string): number {
  const usage = config.skillUsage?.[skillName]
  if (!usage) return 0

  // 7 天半衰期的指数衰减
  const daysSinceUse = (Date.now() - usage.lastUsedAt) / (1000 * 60 * 60 * 24)
  const recencyFactor = Math.pow(0.5, daysSinceUse / 7)

  // 最低衰减因子 0.1，避免高频使用的命令完全消失
  return usage.usageCount * Math.max(recencyFactor, 0.1)
}
```

这个算法的设计意图：

- **7 天半衰期**：一周前的使用只值当前的一半。这确保了排序反映"最近的使用习惯"而不是"历史总量"。
- **最低因子 0.1**：即使一个命令很久没用，如果它被使用过 100 次，分数仍然是 10（100 × 0.1），不会完全消失。这保护了"不常用但重要"的命令。
- **写入防抖**：`recordSkillUsage()` 有 60 秒的防抖——同一个命令在 60 秒内多次调用只记录一次。因为 7 天半衰期下，分钟级的精度毫无意义，但每次写入都涉及文件锁和 I/O。

```typescript
const SKILL_USAGE_DEBOUNCE_MS = 60_000

export function recordSkillUsage(skillName: string): void {
  const now = Date.now()
  const lastWrite = lastWriteBySkill.get(skillName)
  // 7 天半衰期下，分钟级精度无意义。跳过 saveGlobalConfig 避免锁 + 文件 I/O
  if (lastWrite !== undefined && now - lastWrite < SKILL_USAGE_DEBOUNCE_MS) {
    return
  }
  lastWriteBySkill.set(skillName, now)
  saveGlobalConfig(current => ({
    ...current,
    skillUsage: {
      ...current.skillUsage,
      [skillName]: {
        usageCount: (existing?.usageCount ?? 0) + 1,
        lastUsedAt: now,
      },
    },
  }))
}
```

#### 空输入时的分类展示

当用户只输入 `/`（没有后续字符）时，不使用模糊搜索，而是按分类展示所有命令：

```
排序顺序:
1. 最近使用的 skills (top 5, 按使用分数排序)
2. 内置命令 (local + local-jsx, 字母序)
3. 用户级 skills (userSettings/localSettings, 字母序)
4. 项目级 skills (projectSettings, 字母序)
5. 策略级 skills (policySettings, 字母序)
6. 其他命令 (字母序)
```

这个分类设计确保了：
- 最常用的命令总是在最前面（减少滚动）
- 内置命令紧随其后（它们是最稳定、最常用的）
- 用户自定义的 skills 按来源分组（便于区分"我的"和"项目的"）

#### 中间位置补全（Mid-Input Slash Command）

一个独特的功能：用户可以在输入中间位置使用斜杠命令。比如输入 `help me /com` 时，系统会检测到 `/com` 并提供补全建议。

```typescript
export function findMidInputSlashCommand(
  input: string,
  cursorOffset: number,
): MidInputSlashCommand | null {
  if (input.startsWith('/')) return null  // 开头的 / 由其他逻辑处理

  // 从光标位置向前查找：空白符 + / + 字母数字
  const beforeCursor = input.slice(0, cursorOffset)
  const match = beforeCursor.match(/\s\/([a-zA-Z0-9_:-]*)$/)
  if (!match) return null

  return {
    token: '/' + fullCommand,
    startPos: slashPos,
    partialCommand: fullCommand,
  }
}
```

源码中有一个性能注释值得关注：

```typescript
// Lookbehind (?<=\s) is avoided — it defeats YARR JIT in JSC, and the
// interpreter scans O(n) even with the $ anchor. Capture the whitespace
// instead and offset match.index by 1.
```

正则表达式的 lookbehind（`(?<=\s)`）在 JavaScriptCore（Bun 使用的 JS 引擎）中会导致 JIT 编译失败，退回到解释器模式，性能从 O(1) 退化到 O(n)。这在每次按键都触发的搜索中是不可接受的。所以改用捕获组 + 偏移量的方式，避免了 lookbehind。

### 设计决策讨论

**为什么用 Fuse.js 而不是简单的前缀匹配？**

前缀匹配只能处理 `/com` → `compact` 这种情况。但用户可能输入 `/cmpct`（漏打字母）、`/push`（想找 `commit-push-pr`）、`/search`（想找 `grep` 但不知道命令名）。Fuse.js 的模糊匹配和多字段搜索能处理这些场景。

但 Fuse.js 的模糊匹配有时会产生意外结果（比如 `/a` 匹配到描述中包含 "a" 的所有命令），所以在 Fuse 结果之上叠加了严格的优先级排序——精确匹配和前缀匹配总是排在模糊匹配之前。

**为什么隐藏命令在精确输入时仍然可见？**

```typescript
let hiddenExact = commands.find(
  cmd => cmd.isHidden && getCommandName(cmd).toLowerCase() === query,
)
```

`isHidden` 的命令不出现在 typeahead 列表中，但如果用户精确输入了命令名，它仍然会出现。这是一个**渐进式发现**的设计——隐藏命令不会干扰普通用户，但知道命令名的高级用户仍然可以使用。

---

## 9.7 设计决策总结与 Trade-off 分析

### 三种命令类型 vs 统一接口

| 方案 | 优点 | 缺点 |
|------|------|------|
| 当前方案：判别联合（3 种 type） | 类型安全，每种类型有专属字段 | 执行引擎需要 switch 分发 |
| 替代方案：统一 execute() 接口 | 执行引擎简单 | 丢失类型信息，字段混杂 |
| 替代方案：继承体系 | OOP 风格，多态分发 | TypeScript 中类继承不如联合类型灵活 |

Claude Code 选择判别联合是正确的——它让每种命令类型可以有完全不同的字段（`local` 有 `supportsNonInteractive`，`prompt` 有 `getPromptForCommand`、`context`、`allowedTools`），同时保持类型安全。

### 静态注册 vs 动态发现

| 方案 | 优点 | 缺点 |
|------|------|------|
| 当前方案：静态 import + 动态聚合 | 启动快（只加载定义），类型安全 | 新增命令需要修改 commands.ts |
| 替代方案：文件系统扫描 | 新增命令零配置 | 启动慢，无类型检查 |
| 替代方案：装饰器注册 | 声明式，自动发现 | TypeScript 装饰器生态不成熟 |

Claude Code 的混合方案是务实的：内置命令用静态 import（类型安全、编译期检查），外部命令用动态发现（灵活、可扩展）。

### 命令队列 vs 直接执行

| 方案 | 优点 | 缺点 |
|------|------|------|
| 当前方案：队列 + 优先级 | 并发安全，支持排队和插队 | 复杂度高，调试困难 |
| 替代方案：直接执行 + 锁 | 简单 | 无法处理"模型运行时用户输入"的场景 |
| 替代方案：事件总线 | 解耦 | 执行顺序不可控 |

队列方案的核心价值在于 `immediate` 命令——它允许用户在模型运行时切换配置，这是直接执行方案无法实现的。三级优先级（now/next/later）确保了用户输入不会被系统通知饿死。

### 延迟加载 vs 预加载

| 方案 | 优点 | 缺点 |
|------|------|------|
| 当前方案：load() 延迟加载 | 启动快，按需付费 | 首次执行有延迟 |
| 替代方案：全部预加载 | 首次执行无延迟 | 启动慢 200-300ms |
| 替代方案：后台预热 | 两全其美 | 实现复杂，内存占用高 |

Claude Code 选择延迟加载，因为大多数用户在一次会话中只会使用 5-10 个命令，预加载 80+ 命令的实现代码是浪费。首次执行的延迟（通常 < 50ms）在用户感知上几乎不可见。

---

## 9.8 关键源码文件索引

| 文件 | 行数 | 职责 |
|------|------|------|
| `src/types/command.ts` | 217 | Command 类型定义（CommandBase、PromptCommand、LocalCommand、LocalJSXCommand） |
| `src/commands.ts` | 755 | 命令注册表（静态注册、动态聚合、过滤、查找） |
| `src/hooks/useMergedCommands.ts` | 16 | React Hook 层合并内置命令 + MCP 命令 |
| `src/hooks/useCommandQueue.ts` | 16 | 命令队列的 React 订阅 Hook |
| `src/hooks/useQueueProcessor.ts` | 69 | 队列处理器 Hook（触发条件判断） |
| `src/hooks/useCommandKeybindings.tsx` | 107 | 快捷键到命令的映射 |
| `src/utils/slashCommandParsing.ts` | 61 | 斜杠命令解析（命令名 + 参数 + MCP 标记） |
| `src/utils/messageQueueManager.ts` | 548 | 统一命令队列（enqueue/dequeue/优先级/信号） |
| `src/utils/queueProcessor.ts` | 96 | 队列处理逻辑（斜杠命令单独处理、普通文本批量处理） |
| `src/utils/handlePromptSubmit.ts` | 600+ | 用户输入入口（immediate 命令、排队、直接执行） |
| `src/utils/processUserInput/processUserInput.ts` | 606 | 输入路由（bash/slash/text 三路分发） |
| `src/utils/processUserInput/processSlashCommand.tsx` | 922 | 斜杠命令执行核心（解析、查找、分发、结果格式化） |
| `src/utils/suggestions/commandSuggestions.ts` | 500+ | 命令自动补全（Fuse.js 模糊搜索、多维排序） |
| `src/utils/suggestions/skillUsageTracking.ts` | 56 | 使用频率追踪（指数衰减、写入防抖） |
| `src/utils/immediateCommand.ts` | 16 | immediate 命令判定逻辑 |
| `src/commands/` | 87 子目录 | 80+ 命令的具体实现 |
