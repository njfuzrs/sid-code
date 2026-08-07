---
title: Claude Code 源码解析（十）· 插件系统
description: '第三方开发者如何扩展 Claude Code 的能力？插件如何加载、隔离、热重载，又如何确保不破坏宿主安全？'
date: "2026-04-01"
series: Claude Code 源码解析
tags: [Claude Code, 源码解析, harness]
outline: 2
---

# 第十章：插件系统（Plugin System）

> 如何让一个 CLI 工具在不修改源码的情况下获得新能力？

## 核心问题

Claude Code 内置了 30+ 工具、80+ 斜杠命令、MCP 协议支持——功能已经很丰富。但它面临一个所有成功开发工具都会遇到的问题：

1. **用户需求的长尾效应。** 每个团队、每个项目都有独特的工作流。一个前端团队需要 Storybook 集成，一个 DevOps 团队需要 Terraform 命令，一个数据团队需要 Jupyter 工具。这些需求不可能全部内置。

2. **企业定制化需求。** 企业用户需要将内部工具链（私有 MCP 服务器、内部 CLI 工具、定制化 Agent）接入 Claude Code，同时需要管控哪些插件可以被使用。

3. **生态系统建设。** 一个平台的价值与其生态成正比。Claude Code 需要一个标准化的扩展机制，让第三方开发者能够贡献能力。

4. **安全与信任边界。** 插件本质上是"执行第三方代码"。如何在赋予插件足够能力的同时，防止恶意插件窃取数据、破坏环境？

**核心矛盾：开放性 vs 安全性，丰富性 vs 可控性。**

Claude Code 的解法是一个**三层架构**的插件系统——通过 Marketplace 管理分发、通过 Manifest 声明能力、通过 Scope 隔离权限，在开放与安全之间找到平衡。

---

## 10.1 架构总览

```
插件系统三层模型:

┌─────────────────────────────────────────────────────────────────┐
│  Layer 3: Active Components (运行时活跃组件)                      │
│  ─────────────────────────────────────────────────────────────── │
│  AppState.plugins.enabled / disabled / commands / errors         │
│                                                                  │
│  活跃的插件组件:                                                  │
│  ┌──────────┐ ┌──────────┐ ┌──────┐ ┌─────┐ ┌─────┐ ┌─────┐  │
│  │ Commands  │ │  Agents  │ │Hooks │ │ MCP │ │ LSP │ │Style│  │
│  │(斜杠命令) │ │(自定义Agent)│ │(钩子)│ │服务器│ │服务器│ │输出样式│ │
│  └──────────┘ └──────────┘ └──────┘ └─────┘ └─────┘ └─────┘  │
│                                                                  │
│  刷新入口: /reload-plugins → refreshActivePlugins()              │
└──────────────────────────────────────────────────────────────────┘
         ▲ loadAllPlugins() / loadAllPluginsCacheOnly()
         │
┌─────────────────────────────────────────────────────────────────┐
│  Layer 2: Materialization (物化层 — 磁盘缓存)                     │
│  ─────────────────────────────────────────────────────────────── │
│  ~/.claude/plugins/                                              │
│  ├── cache/                    # 版本化插件缓存                   │
│  │   └── {marketplace}/                                          │
│  │       └── {plugin}/                                           │
│  │           └── {version}/    # git clone / npm install 产物     │
│  │               ├── plugin.json   (Manifest)                    │
│  │               ├── commands/     (斜杠命令 .md)                 │
│  │               ├── agents/       (Agent 定义 .md)               │
│  │               ├── skills/       (Skill 定义 .md)               │
│  │               ├── hooks.json    (Hook 配置)                    │
│  │               └── .mcp.json     (MCP 服务器配置)               │
│  └── installed_plugins.json    # 已安装插件注册表                  │
│                                                                  │
│  物化入口: reconcileMarketplaces() / cacheAndRegisterPlugin()    │
└──────────────────────────────────────────────────────────────────┘
         ▲ git clone / npm install / seed probe
         │
┌─────────────────────────────────────────────────────────────────┐
│  Layer 1: Intent (意图层 — 设置声明)                              │
│  ─────────────────────────────────────────────────────────────── │
│  settings.json (多层级):                                         │
│  {                                                               │
│    "enabledPlugins": {                                           │
│      "my-plugin@my-marketplace": true,                           │
│      "another@official": true                                    │
│    },                                                            │
│    "extraKnownMarketplaces": {                                   │
│      "my-marketplace": { "source": "github:org/repo" }           │
│    }                                                             │
│  }                                                               │
│                                                                  │
│  来源: 用户设置 / 项目设置 / 企业策略(MDM) / CLI flag             │
└──────────────────────────────────────────────────────────────────┘
```

这个三层模型的核心洞察是**关注点分离**：

- **Layer 1（意图）** 回答"用户想要什么插件"——纯声明式，不涉及任何 I/O
- **Layer 2（物化）** 回答"插件代码在哪里"——负责 git clone、npm install、缓存管理
- **Layer 3（活跃）** 回答"插件当前提供了什么能力"——运行时的 Commands、Agents、Hooks、MCP 服务器

三层之间通过明确的接口连接，每层可以独立变化。比如用户在 settings.json 中启用了一个新插件（Layer 1 变化），但在执行 `/reload-plugins` 之前，Layer 3 不会变化——这是**显式刷新**的设计选择，后面会详细讨论。

---

## 10.2 插件类型系统与标识符

### 面临的问题

一个插件系统首先要回答的问题是：**插件是什么？** 更具体地说：

- 一个插件在运行时长什么样？（数据结构）
- 如何唯一标识一个插件？（标识符）
- 插件可以提供哪些能力？（组件类型）
- 插件出错时如何精确定位问题？（错误类型）

### 核心类型：LoadedPlugin

`types/plugin.ts` 定义了插件在运行时的核心表示：

```typescript
// types/plugin.ts

export type LoadedPlugin = {
  name: string              // 插件名称
  manifest: PluginManifest  // 插件清单（plugin.json 的解析结果）
  path: string              // 插件在磁盘上的路径
  source: string            // 插件标识符，如 "my-plugin@my-marketplace"
  repository: string        // 仓库标识符，通常与 source 相同
  enabled?: boolean         // 是否启用
  isBuiltin?: boolean       // 是否为内置插件

  // 版本控制
  sha?: string              // Git commit SHA（用于版本锁定）

  // 组件路径（延迟加载的入口）
  commandsPath?: string     // 斜杠命令目录
  commandsPaths?: string[]  // 额外命令路径（来自 manifest）
  commandsMetadata?: Record<string, CommandMetadata>
  agentsPath?: string       // Agent 定义目录
  agentsPaths?: string[]
  skillsPath?: string       // Skill 定义目录
  skillsPaths?: string[]
  outputStylesPath?: string // 输出样式目录
  outputStylesPaths?: string[]

  // 运行时组件（延迟填充的缓存槽）
  hooksConfig?: HooksSettings
  mcpServers?: Record<string, McpServerConfig>
  lspServers?: Record<string, LspServerConfig>
  settings?: Record<string, unknown>
}
```

这个类型设计有几个值得注意的地方：

**1. 路径与组件分离。** `commandsPath` 只是一个目录路径，不是已加载的 Command 对象数组。实际的 Command 加载由 `loadPluginCommands.ts` 按需执行。这是**延迟加载**的体现——`loadAllPlugins()` 只负责发现和验证插件，不负责加载组件。

**2. `mcpServers` / `lspServers` 是"缓存槽"。** 源码注释明确说明：

```
// LoadedPlugin.mcpServers is not populated by loadAllPlugins — it's a
// cache slot that extractMcpServersFromPlugins fills later
```

这意味着 `loadAllPlugins()` 返回的 `LoadedPlugin` 中，`mcpServers` 字段是 `undefined`。只有当 MCP 连接管理器需要这些服务器配置时，才会调用 `loadPluginMcpServers()` 填充这个字段。这避免了在启动时为每个插件解析 MCP 配置（可能涉及 MCPB 文件下载和解压）。

### 插件标识符：`name@marketplace` 格式

```typescript
// utils/plugins/pluginIdentifier.ts

export type ParsedPluginIdentifier = {
  name: string
  marketplace?: string
}

export function parsePluginIdentifier(plugin: string): ParsedPluginIdentifier {
  if (plugin.includes('@')) {
    const parts = plugin.split('@')
    return { name: parts[0] || '', marketplace: parts[1] }
  }
  return { name: plugin }
}

export function buildPluginId(name: string, marketplace?: string): string {
  return marketplace ? `${name}@${marketplace}` : name
}
```

插件标识符采用 `name@marketplace` 格式，类似 npm 的 `@scope/package`。这个设计解决了一个关键问题：**同名插件可能来自不同的 marketplace**。比如 `deploy@official` 和 `deploy@my-company` 是两个完全不同的插件。

标识符还有几个特殊值：
- `name@builtin`：内置插件（随 CLI 分发）
- `name@inline`：会话级插件（通过 `--plugin-dir` 指定，不持久化）

### 插件作用域（Scope）

```typescript
// utils/plugins/pluginIdentifier.ts

export type ExtendedPluginScope = PluginScope | 'flag'
// PluginScope = 'user' | 'project' | 'local' | 'managed'

export const SETTING_SOURCE_TO_SCOPE = {
  policySettings: 'managed',   // 企业策略（MDM）
  userSettings: 'user',        // ~/.claude/settings.json
  projectSettings: 'project',  // .claude/settings.json
  localSettings: 'local',      // .claude/settings.local.json
  flagSettings: 'flag',        // --plugin-dir（会话级，不持久化）
} as const
```

作用域决定了插件的**可见性和持久性**：

| 作用域 | 来源 | 持久化 | 谁控制 |
|--------|------|--------|--------|
| `managed` | 企业策略（MDM/远程设置） | 是 | IT 管理员 |
| `user` | `~/.claude/settings.json` | 是 | 用户 |
| `project` | `.claude/settings.json` | 是 | 项目维护者 |
| `local` | `.claude/settings.local.json` | 是 | 用户（不提交到 git） |
| `flag` | `--plugin-dir` CLI 参数 | 否 | 开发者（调试用） |

**为什么 `managed` 作用域不能安装插件？**

```typescript
export function scopeToSettingSource(scope: PluginScope): EditableSettingSource {
  if (scope === 'managed') {
    throw new Error('Cannot install plugins to managed scope')
  }
  return SCOPE_TO_EDITABLE_SOURCE[scope]
}
```

因为 `managed` 作用域由企业 IT 管理员通过 MDM 或远程托管设置控制。用户不应该能够修改企业策略——这是一个**权限边界**。

### 插件组件类型

```typescript
// types/plugin.ts

export type PluginComponent =
  | 'commands'       // 斜杠命令（Markdown 文件）
  | 'agents'         // 自定义 Agent 定义（Markdown 文件）
  | 'skills'         // Skill 定义（SKILL.md 文件）
  | 'hooks'          // 生命周期钩子（hooks.json）
  | 'output-styles'  // 输出样式
```

一个插件可以同时提供多种组件。除了上述显式声明的组件类型，插件还可以通过 manifest 声明 MCP 服务器和 LSP 服务器——这两者不在 `PluginComponent` 枚举中，因为它们走的是独立的加载路径（MCP 连接管理器和 LSP 服务器管理器）。

### 错误类型系统：25+ 种结构化错误

```typescript
// types/plugin.ts — 精简展示

export type PluginError =
  | { type: 'path-not-found'; source: string; path: string; component: PluginComponent }
  | { type: 'git-auth-failed'; source: string; gitUrl: string; authType: 'ssh' | 'https' }
  | { type: 'git-timeout'; source: string; gitUrl: string; operation: 'clone' | 'pull' }
  | { type: 'network-error'; source: string; url: string; details?: string }
  | { type: 'manifest-parse-error'; source: string; parseError: string }
  | { type: 'manifest-validation-error'; source: string; validationErrors: string[] }
  | { type: 'plugin-not-found'; source: string; pluginId: string; marketplace: string }
  | { type: 'marketplace-not-found'; source: string; marketplace: string }
  | { type: 'marketplace-blocked-by-policy'; source: string; marketplace: string }
  | { type: 'dependency-unsatisfied'; source: string; plugin: string; dependency: string;
      reason: 'not-enabled' | 'not-found' }
  | { type: 'plugin-cache-miss'; source: string; plugin: string; installPath: string }
  | { type: 'mcp-server-suppressed-duplicate'; source: string; serverName: string }
  | { type: 'mcpb-download-failed'; source: string; url: string; reason: string }
  | { type: 'lsp-server-crashed'; source: string; serverName: string; exitCode: number | null }
  | { type: 'generic-error'; source: string; error: string }
  // ... 还有 ~10 种
```

这个错误类型系统的设计值得深入讨论。

**为什么用 discriminated union 而不是 Error 子类？**

源码注释说得很清楚：

```typescript
// This replaces the previous string-based error matching approach with type-safe
// error handling that can't break when error messages change.
```

之前的实现用字符串匹配错误消息来判断错误类型——这在错误消息被修改时会静默失败。Discriminated union 通过 `type` 字段做类型安全的分发，编译器会确保所有分支都被处理。

**为什么每种错误都携带 `source` 字段？**

因为插件系统涉及多个来源（marketplace、git、npm、本地目录），同一种错误（比如 `network-error`）可能发生在不同的上下文中。`source` 字段让错误可以被精确归因到具体的插件或 marketplace。

**为什么有些错误类型标注为"Planned for future use"？**

```typescript
// Planned for future use (10 types - see TODOs in pluginLoader.ts):
// - path-not-found, git-auth-failed, git-timeout, network-error
// - manifest-parse-error, manifest-validation-error
// ...
```

这是一个**渐进式迁移**策略。团队先定义了完整的错误类型体系，然后逐步将现有的 `generic-error` 替换为更具体的类型。这比一次性重构所有错误处理更安全，也更容易 review。

### 加载结果：PluginLoadResult

```typescript
export type PluginLoadResult = {
  enabled: LoadedPlugin[]   // 已启用的插件
  disabled: LoadedPlugin[]  // 已禁用的插件
  errors: PluginError[]     // 加载过程中的错误
}
```

这个三元组是插件加载的标准返回值。注意 `errors` 是**非致命的**——一个插件加载失败不会阻止其他插件加载。这是**错误隔离**原则的体现：一个坏插件不应该拖垮整个系统。

### 设计决策讨论

**为什么插件不直接提供 Tool（工具）？**

回顾 `PluginComponent` 的枚举，你会发现没有 `tools` 类型。插件不能直接注册一个像 `BashTool` 那样的内置工具。这是一个**刻意的限制**。

原因是：内置工具（`Tool<Input, Output, Progress>`）需要 TypeScript 代码实现，涉及 Zod schema 验证、权限检查、进度回调等复杂接口。让第三方插件直接实现这个接口会带来巨大的安全风险和兼容性负担。

取而代之，插件通过**间接方式**扩展工具能力：
- **MCP 服务器**：通过标准化的 MCP 协议暴露工具，由 `MCPTool` 桥接到内置工具体系
- **Commands/Skills**：通过 Markdown 定义的 prompt 模板，由 `SkillTool` 执行
- **Agents**：通过 Markdown 定义的 Agent 配置，由 `AgentTool` 派生子代理

这是一个**"能力通过协议暴露，而非通过代码注入"**的设计哲学。MCP 协议提供了天然的进程隔离边界，Markdown 模板提供了声明式的安全保证。

---

## 10.3 插件发现与加载

### 面临的问题

插件系统最复杂的部分不是"插件能做什么"，而是"插件从哪里来"。Claude Code 需要支持多种插件来源：

- **Marketplace 插件**：从 git 仓库托管的 marketplace 中发现和安装
- **会话级插件**：通过 `--plugin-dir` 临时加载（开发调试用）
- **内置插件**：随 CLI 分发，用户可以开关
- **企业管控插件**：通过 MDM 策略强制启用或禁用

同时，加载过程必须处理：网络不可用、git 不可用、缓存过期、版本冲突、依赖缺失……

**核心挑战：如何在各种异常条件下可靠地加载插件，同时不拖慢启动速度？**

### 解法：两层加载策略（Full Load vs Cache-Only）

`pluginLoader.ts` 是整个插件系统最大的文件（2700+ 行），它的核心设计是**两个独立 memoize 的加载函数**：

```typescript
// utils/plugins/pluginLoader.ts — 核心加载入口

// 完整加载：可能触发网络 I/O（git clone、npm install）
export const loadAllPlugins = memoize(async (): Promise<PluginLoadResult> => {
  // 1. 加载 marketplace 插件（可能 clone git 仓库）
  // 2. 加载会话级插件（--plugin-dir）
  // 3. 加载内置插件（getBuiltinPlugins()）
  // 4. 合并所有来源
  // 5. 验证依赖（verifyAndDemote）
  // 6. 缓存插件设置
  const result = await assemblePluginLoadResult(/* fullLoad = true */)

  // 完整加载完成后，用结果预热 cache-only 的 memoize
  loadAllPluginsCacheOnly.cache.set(undefined, Promise.resolve(result))

  return result
})

// 缓存加载：零网络 I/O，只读 installed_plugins.json
export const loadAllPluginsCacheOnly = memoize(
  async (): Promise<PluginLoadResult> => {
    return assemblePluginLoadResult(/* fullLoad = false */)
  }
)
```

**为什么需要两个加载函数？**

这是启动性能的关键优化。在启动序列中，多个子系统需要读取插件信息：

```
main.tsx 启动序列:
  ├─ getCommands()                    ← 需要插件命令
  ├─ getAgentDefinitionsWithOverrides() ← 需要插件 Agent
  ├─ getClaudeCodeMcpConfigs()        ← 需要插件 MCP 服务器
  └─ REPL mount → useManagePlugins()  ← 完整加载
```

前三个调用发生在 REPL 挂载之前。如果它们都调用 `loadAllPlugins()`（完整加载），就会在启动关键路径上触发 git clone——这可能需要数秒。

解法是：**启动时用 `loadAllPluginsCacheOnly()`（只读磁盘缓存），REPL 挂载后用 `loadAllPlugins()`（完整加载）。**

```
时间 ──────────────────────────────────────────────────────────►

启动关键路径:
  ├─ getCommands()
  │   └─ loadAllPluginsCacheOnly()  ← 只读 installed_plugins.json (~5ms)
  ├─ getAgentDefinitions()
  │   └─ loadAllPluginsCacheOnly()  ← memoize 命中 (~0ms)
  ├─ getClaudeCodeMcpConfigs()
  │   └─ loadAllPluginsCacheOnly()  ← memoize 命中 (~0ms)
  │
  │   REPL 首屏渲染 ← 用户看到提示符
  │
  └─ useManagePlugins()
      └─ loadAllPlugins()           ← 完整加载（后台，不阻塞用户输入）
          └─ 预热 loadAllPluginsCacheOnly 的 memoize
```

注意最后一步：`loadAllPlugins()` 完成后，会用自己的结果覆盖 `loadAllPluginsCacheOnly` 的 memoize 缓存。这确保了后续所有调用 `loadAllPluginsCacheOnly()` 的代码都能拿到最新数据。

### 插件组装流程：assemblePluginLoadResult()

```
assemblePluginLoadResult(fullLoad):

  ┌─────────────────────────────────────────────────────┐
  │  1. 加载 Marketplace 插件                            │
  │     ├─ 读取 settings.enabledPlugins                  │
  │     ├─ 对每个 "name@marketplace" 条目:               │
  │     │   ├─ fullLoad=true:  从 marketplace 查找 →     │
  │     │   │   git clone / npm install → 缓存到磁盘     │
  │     │   └─ fullLoad=false: 从 installed_plugins.json │
  │     │       读取已缓存的路径                          │
  │     ├─ 加载 plugin.json (manifest)                   │
  │     ├─ 加载 hooks.json (如果存在)                     │
  │     └─ 收集错误                                      │
  └─────────────────────────────────────────────────────┘
                    │
                    ▼ (并行)
  ┌─────────────────────────────────────────────────────┐
  │  2. 加载会话级插件 (--plugin-dir)                     │
  │     ├─ 读取 getInlinePlugins()                       │
  │     ├─ 直接从目录加载 manifest                        │
  │     └─ source = "name@inline"                        │
  └─────────────────────────────────────────────────────┘
                    │
                    ▼
  ┌─────────────────────────────────────────────────────┐
  │  3. 加载内置插件                                     │
  │     └─ getBuiltinPlugins() → enabled / disabled      │
  └─────────────────────────────────────────────────────┘
                    │
                    ▼
  ┌─────────────────────────────────────────────────────┐
  │  4. 合并所有来源 (mergePluginSources)                 │
  │     ├─ 去重（同名插件以先到者为准）                    │
  │     └─ 分类为 enabled / disabled                     │
  └─────────────────────────────────────────────────────┘
                    │
                    ▼
  ┌─────────────────────────────────────────────────────┐
  │  5. 依赖验证 (verifyAndDemote)                       │
  │     ├─ 检查每个 enabled 插件的 dependencies           │
  │     ├─ 不满足的 → 降级为 disabled                     │
  │     └─ 固定点循环（A 降级可能导致依赖 A 的 B 也降级） │
  └─────────────────────────────────────────────────────┘
                    │
                    ▼
  ┌─────────────────────────────────────────────────────┐
  │  6. 缓存插件设置 (cachePluginSettings)               │
  │     └─ 将每个插件的 settings 写入 settingsCache      │
  └─────────────────────────────────────────────────────┘
                    │
                    ▼
              PluginLoadResult
              { enabled, disabled, errors }
```

### Marketplace 插件来源类型

Marketplace 中的每个插件条目可以指定不同的来源类型：

```typescript
// utils/plugins/schemas.ts — MarketplaceSourceSchema

type PluginSource =
  | { source: 'github'; repo: string; ref?: string }     // GitHub 简写
  | { source: 'git'; url: string; ref?: string }          // 完整 git URL
  | { source: 'git-subdir'; url: string; path: string;    // git 仓库子目录
      ref?: string }
  | { source: 'npm'; package: string; version?: string;   // npm 包
      registry?: string }
  | { source: 'url'; url: string }                        // HTTP URL
  | { source: 'file'; path: string }                      // 本地文件
  | { source: 'directory'; path: string }                 // 本地目录
  | string                                                // 相对路径简写
```

其中 `git-subdir` 值得特别关注。它使用了 git 的 **partial clone + sparse checkout** 优化：

```typescript
// utils/plugins/pluginLoader.ts — installFromGitSubdir()

// 序列:
// 1. clone --depth 1 --filter=tree:0 --no-checkout [--branch ref]
// 2. sparse-checkout set --cone -- <path>
// 3. checkout HEAD (或指定的 SHA)
// 4. 将 <cloneDir>/<path> 移动到 targetPath，丢弃 clone
```

对于大型 monorepo（比如一个包含数百个插件的企业仓库），`--filter=tree:0` 避免下载整个仓库的 tree 对象（可能数百 MB），`sparse-checkout` 只物化目标子目录的文件。这是一个**显著的性能优化**——将 clone 时间从分钟级降到秒级。

### 版本化缓存

```typescript
// 缓存路径格式:
// ~/.claude/plugins/cache/{marketplace}/{plugin}/{version}/

export function getVersionedCachePath(pluginId: string, version: string): string {
  const { name, marketplace } = parsePluginIdentifier(pluginId)
  const sanitizedMarketplace = (marketplace || 'unknown').replace(/[^a-zA-Z0-9\-_]/g, '-')
  const sanitizedPlugin = (name || pluginId).replace(/[^a-zA-Z0-9\-_]/g, '-')
  const sanitizedVersion = version.replace(/[^a-zA-Z0-9\-_.]/g, '-')
  return join(baseDir, 'cache', sanitizedMarketplace, sanitizedPlugin, sanitizedVersion)
}
```

版本计算的优先级链：

```typescript
// utils/plugins/pluginVersioning.ts — calculatePluginVersion()

// 1. plugin.json 中的 version 字段（最高优先级）
// 2. marketplace entry 提供的版本
// 3. 预解析的 git commit SHA
// 4. 从安装路径提取的 git SHA
// 5. 'unknown'（兜底）
```

**为什么路径中的特殊字符要被替换？**

```typescript
const sanitizedVersion = version.replace(/[^a-zA-Z0-9\-_.]/g, '-')
```

这是**路径遍历攻击防护**。如果 version 字符串包含 `../`，未经清理就拼接到路径中，攻击者可以将插件文件写入任意目录。

### Seed Cache：企业环境的预置缓存

```typescript
// utils/plugins/pluginLoader.ts

async function probeSeedCache(pluginId: string, version: string): Promise<string | null> {
  for (const seedDir of getPluginSeedDirs()) {
    const seedPath = getVersionedCachePathIn(seedDir, pluginId, version)
    try {
      const entries = await readdir(seedPath)
      if (entries.length > 0) return seedPath
    } catch {
      // Try next seed
    }
  }
  return null
}
```

Seed cache 是为**企业 BYOC（Bring Your Own Container）环境**设计的。在这种环境中，容器镜像可以预置插件缓存目录，避免每次启动都 git clone。`probeSeedCache()` 在写入主缓存之前先检查 seed 目录——如果命中，直接返回 seed 路径（只读，不复制）。

### 设计决策讨论

**为什么 `loadAllPlugins()` 完成后要预热 `loadAllPluginsCacheOnly` 的 memoize？**

```typescript
// loadAllPlugins 完成后:
loadAllPluginsCacheOnly.cache.set(undefined, Promise.resolve(result))
```

这解决了一个微妙的一致性问题。考虑以下时序：

1. 启动时 `getCommands()` 调用 `loadAllPluginsCacheOnly()` → 返回旧缓存数据
2. REPL 挂载后 `loadAllPlugins()` 完成 → 发现了新插件
3. 某个代码路径再次调用 `loadAllPluginsCacheOnly()` → 如果不预热，仍然返回旧数据

预热确保了 `loadAllPlugins()` 之后，所有消费者看到的都是最新数据。

**为什么 `/reload-plugins` 要先 `clearAllCaches()` 再 `loadAllPlugins()`？**

```typescript
// utils/plugins/refresh.ts — refreshActivePlugins()

clearAllCaches()                    // 清除所有 memoize 缓存
clearPluginCacheExclusions()        // 重新计算孤儿过滤器
const pluginResult = await loadAllPlugins()  // 完整重新加载
```

因为 `loadAllPlugins` 和 `loadAllPluginsCacheOnly` 都是 memoized 的。如果不清除缓存，`loadAllPlugins()` 会直接返回上次的结果，用户的设置变更不会生效。`/reload-plugins` 是一个**显式的"我知道磁盘状态变了，请重新读取"**信号。

**为什么不自动检测设置变更并刷新？**

源码注释解释了这个设计选择：

```typescript
// useManagePlugins.ts

// Plugin state changed on disk (background reconcile, /plugin menu,
// external settings edit). Show a notification; user runs /reload-plugins
// to apply. The previous auto-refresh here had a stale-cache bug (only
// cleared loadAllPlugins, downstream memoized loaders returned old data)
// and was incomplete (no MCP, no agentDefinitions). /reload-plugins
// handles all of that correctly via refreshActivePlugins().
```

之前尝试过自动刷新，但遇到了**缓存一致性 bug**：只清除了 `loadAllPlugins` 的 memoize，但下游的 `getPluginCommands()`、`loadPluginAgents()` 等也有各自的 memoize，它们仍然返回旧数据。`/reload-plugins` 通过 `clearAllCaches()` 一次性清除所有缓存，避免了这个问题。

这是一个**"显式优于隐式"**的设计决策。自动刷新看起来更方便，但在有多层 memoize 缓存的系统中，保证一致性非常困难。显式刷新虽然多了一步用户操作，但行为是可预测的。

---

## 10.4 依赖解析与安全边界

### 面临的问题

当插件 A 依赖插件 B 时，系统需要回答几个问题：

1. **安装时**：安装 A 时是否自动安装 B？如果 B 来自另一个 marketplace 呢？
2. **加载时**：如果 B 被禁用了，A 还能加载吗？如果 B 被卸载了呢？
3. **卸载时**：卸载 B 时，是否警告用户 A 会受影响？
4. **循环依赖**：A 依赖 B，B 依赖 A，怎么办？

这些问题在包管理器（npm、apt）中已经有成熟的解法，但 Claude Code 的插件依赖有一个独特约束：**跨 marketplace 的依赖是一个安全问题**。

### 依赖语义：apt 风格的"存在保证"

```typescript
// utils/plugins/dependencyResolver.ts — 文件头注释

// Semantics are `apt`-style: a dependency is a *presence guarantee*, not a
// module graph. Plugin A depending on Plugin B means "B's namespaced
// components (MCP servers, commands, agents) must be available when A runs."
```

这与 npm 的依赖语义有本质区别：

| | npm 依赖 | Claude Code 插件依赖 |
|---|---|---|
| 语义 | 代码级导入（`require('B')`） | 存在保证（B 的组件可用） |
| 版本约束 | 精确的 semver 范围 | 有/无（布尔） |
| 安装位置 | `node_modules/` 嵌套 | 全局扁平（同一 cache） |
| 隔离 | 每个包独立的依赖树 | 共享命名空间 |

选择 apt 风格而非 npm 风格是合理的——插件之间不存在代码级的 `import`，它们通过共享的命名空间（MCP 服务器名、命令名）间接交互。

### 安装时依赖解析：DFS 闭包计算

```typescript
// utils/plugins/dependencyResolver.ts

export async function resolveDependencyClosure(
  rootId: PluginId,
  lookup: (id: PluginId) => Promise<DependencyLookupResult | null>,
  alreadyEnabled: ReadonlySet<PluginId>,
  allowedCrossMarketplaces: ReadonlySet<string> = new Set(),
): Promise<ResolutionResult> {
  const rootMarketplace = parsePluginIdentifier(rootId).marketplace
  const closure: PluginId[] = []
  const visited = new Set<PluginId>()
  const stack: PluginId[] = []  // 用于循环检测

  async function walk(id: PluginId, requiredBy: PluginId): Promise<...> {
    // 1. 已启用的依赖 → 跳过（不重复安装）
    if (id !== rootId && alreadyEnabled.has(id)) return null

    // 2. 跨 marketplace 安全检查
    const idMarketplace = parsePluginIdentifier(id).marketplace
    if (idMarketplace !== rootMarketplace &&
        !(idMarketplace && allowedCrossMarketplaces.has(idMarketplace))) {
      return { ok: false, reason: 'cross-marketplace', dependency: id, requiredBy }
    }

    // 3. 循环检测
    if (stack.includes(id)) {
      return { ok: false, reason: 'cycle', chain: [...stack, id] }
    }

    // 4. DFS 递归
    if (visited.has(id)) return null
    visited.add(id)
    const entry = await lookup(id)
    if (!entry) return { ok: false, reason: 'not-found', missing: id, requiredBy }

    stack.push(id)
    for (const rawDep of entry.dependencies ?? []) {
      const dep = qualifyDependency(rawDep, id)
      const err = await walk(dep, id)
      if (err) return err
    }
    stack.pop()
    closure.push(id)  // 后序添加（依赖在前，根在后）
    return null
  }

  const err = await walk(rootId, rootId)
  if (err) return err
  return { ok: true, closure }
}
```

这个算法有几个精妙的设计点：

**1. 跨 marketplace 依赖默认被阻止**

```typescript
// Cross-marketplace dependencies are BLOCKED by default: a plugin in
// marketplace A cannot auto-install a plugin from marketplace B. This is
// a security boundary — installing from a trusted marketplace shouldn't
// silently pull from an untrusted one.
```

这是一个**安全边界**。想象这个场景：你信任公司内部的 marketplace，安装了一个插件。如果这个插件声明依赖了一个来自未知 marketplace 的插件，系统会自动从那个未知来源下载代码——这等于绕过了你的信任决策。

阻止跨 marketplace 依赖意味着：**信任是不可传递的**。你信任 marketplace A 不意味着你信任 A 中的插件所依赖的 marketplace B。

有两个逃逸口：
- 手动安装跨 marketplace 的依赖（已启用的依赖会被跳过，不触发跨 marketplace 检查）
- marketplace 的 `allowCrossMarketplaceDependenciesOn` 白名单（只有根 marketplace 的白名单生效，不传递）

**2. 根插件永远不被跳过**

```typescript
// NEVER skip the root: installing an already-enabled plugin must
// still cache/register it. Without this guard, re-installing a plugin
// that's in settings but missing from disk (e.g., cache cleared,
// installed_plugins.json stale) would return an empty closure and
// `cacheAndRegisterPlugin` would never fire
```

这处理了一个边界情况：用户重新安装一个已启用的插件（可能因为缓存被清理了）。如果根也被跳过，闭包为空，安装操作什么都不做——用户看到"安装成功"但插件实际上不存在。

**3. 裸依赖名的自动限定**

```typescript
export function qualifyDependency(dep: string, declaringPluginId: string): string {
  if (parsePluginIdentifier(dep).marketplace) return dep  // 已限定
  const mkt = parsePluginIdentifier(declaringPluginId).marketplace
  if (!mkt || mkt === INLINE_MARKETPLACE) return dep  // @inline 插件不限定
  return `${dep}@${mkt}`  // 继承声明者的 marketplace
}
```

如果插件 `A@my-marketplace` 声明依赖 `B`（没有 `@marketplace` 后缀），系统自动将其限定为 `B@my-marketplace`。这是一个**便利性设计**——同一 marketplace 内的依赖不需要写完整标识符。

### 加载时依赖验证：固定点降级

安装时的依赖解析确保了依赖被安装。但加载时，情况可能已经变化——用户可能手动禁用了某个依赖。`verifyAndDemote()` 处理这种情况：

```typescript
// utils/plugins/dependencyResolver.ts

export function verifyAndDemote(plugins: readonly LoadedPlugin[]): {
  demoted: Set<string>
  errors: PluginError[]
} {
  const enabled = new Set(plugins.filter(p => p.enabled).map(p => p.source))

  let changed = true
  while (changed) {  // 固定点循环
    changed = false
    for (const p of plugins) {
      if (!enabled.has(p.source)) continue
      for (const rawDep of p.manifest.dependencies ?? []) {
        const dep = qualifyDependency(rawDep, p.source)
        if (!enabled.has(dep)) {
          enabled.delete(p.source)  // 降级：从 enabled 移到 disabled
          errors.push({
            type: 'dependency-unsatisfied',
            source: p.source,
            plugin: p.name,
            dependency: dep,
            reason: known.has(dep) ? 'not-enabled' : 'not-found',
          })
          changed = true
          break
        }
      }
    }
  }
  // ...
}
```

**为什么需要固定点循环？**

因为降级是**级联的**。如果 A 依赖 B，B 依赖 C：
1. 第一轮：C 被禁用 → B 的依赖不满足 → B 被降级
2. 第二轮：B 被降级 → A 的依赖不满足 → A 被降级
3. 第三轮：没有新的降级 → 循环结束

如果只做一轮检查，A 在第一轮时看到 B 还在 enabled 集合中，不会被降级——但 B 实际上已经不可用了。

**`reason` 字段区分两种失败原因**

```typescript
reason: known.has(dep) ? 'not-enabled' : 'not-found'
```

- `'not-enabled'`：依赖存在但被禁用——用户可以通过启用它来修复
- `'not-found'`：依赖完全不存在——需要安装

这个区分让 `/doctor` UI 可以给出更精确的修复建议。

### 反向依赖查询：卸载前的安全检查

```typescript
export function findReverseDependents(
  pluginId: PluginId,
  plugins: readonly LoadedPlugin[],
): string[] {
  return plugins
    .filter(p => p.enabled && p.source !== pluginId &&
      (p.manifest.dependencies ?? []).some(d => {
        const qualified = qualifyDependency(d, p.source)
        return qualified === pluginId
      }))
    .map(p => p.name)
}
```

当用户卸载或禁用插件 B 时，系统会查找所有依赖 B 的已启用插件，并显示警告："warning: required by X, Y"。这不会阻止操作——用户仍然可以卸载——但确保了**知情决策**。

### 设计决策讨论

**为什么不支持版本约束（semver range）？**

npm 的依赖系统支持 `"B": "^1.0.0"` 这样的版本范围。Claude Code 的插件依赖只有"有/无"两种状态。

原因是：Claude Code 插件的"接口"是 MCP 协议和 Markdown 模板，不是 TypeScript API。MCP 协议本身有版本协商机制，Markdown 模板是人类可读的 prompt——这些"接口"的兼容性不能用 semver 精确描述。

引入版本约束会增加大量复杂性（版本解析、冲突解决、锁文件），但收益有限。这是一个**"简单胜过完备"**的工程决策。

**为什么 `verifyAndDemote` 不修改设置（不写磁盘）？**

```typescript
// Does NOT mutate input. Returns the set of plugin IDs (sources) to demote.
// session-local, does NOT write settings
```

降级是**会话级的**——只影响当前运行的 Claude Code 实例，不修改 `settings.json`。这意味着下次启动时，如果依赖被重新启用，插件会自动恢复。

如果降级写入设置，用户可能不理解为什么自己启用的插件被"自动禁用"了。会话级降级是一个**最小惊讶原则**的体现。

---

## 10.5 插件组件加载：从磁盘文件到运行时能力

### 面临的问题

`loadAllPlugins()` 完成后，我们有了一组 `LoadedPlugin` 对象——但它们只是"元数据壳"。插件真正的能力（命令、Agent、Hooks、MCP 服务器）还没有被加载。

这些组件的加载面临几个挑战：

1. **异构格式**：命令是 Markdown 文件，Hooks 是 JSON 配置，MCP 服务器是进程配置——每种组件的加载逻辑完全不同
2. **命名空间隔离**：不同插件的命令不能同名冲突，MCP 服务器需要加前缀
3. **变量替换**：组件中可能引用 `${CLAUDE_PLUGIN_ROOT}`、`${user_config.X}` 等变量
4. **错误隔离**：一个组件加载失败不应该影响其他组件

### 命令加载：Markdown → Command 对象

```typescript
// utils/plugins/loadPluginCommands.ts

export const getPluginCommands = memoize(async (): Promise<Command[]> => {
  const { enabled } = await loadAllPluginsCacheOnly()
  const allCommands: Command[] = []

  for (const plugin of enabled) {
    // 从 commands/ 目录加载
    if (plugin.commandsPath) {
      const commands = await loadCommandsFromDirectory(plugin, plugin.commandsPath)
      allCommands.push(...commands)
    }
    // 从 manifest 声明的额外路径加载
    for (const path of plugin.commandsPaths ?? []) {
      const commands = await loadCommandsFromDirectory(plugin, path)
      allCommands.push(...commands)
    }
  }
  return allCommands
})
```

命令的命名规则是**插件名作为命名空间前缀**：

```typescript
// 命令名生成规则:
// commands/build.md        → /my-plugin:build
// commands/deploy/prod.md  → /my-plugin:deploy:prod
// skills/test/SKILL.md     → /my-plugin:test

function getCommandNameFromFile(filePath, baseDir, pluginName): string {
  const isSkill = isSkillFile(filePath)  // SKILL.md

  if (isSkill) {
    // Skill 用父目录名
    const commandBaseName = basename(dirname(filePath))
    return `${pluginName}:${commandBaseName}`
  } else {
    // 普通命令用文件名（去掉 .md）
    const commandBaseName = basename(filePath).replace(/\.md$/, '')
    // 子目录作为额外命名空间
    const namespace = relativePath.split('/').join(':')
    return namespace
      ? `${pluginName}:${namespace}:${commandBaseName}`
      : `${pluginName}:${commandBaseName}`
  }
}
```

这个命名规则确保了：
- 不同插件的命令不会冲突（`plugin-a:build` vs `plugin-b:build`）
- 目录结构映射到命名空间层级（`deploy/prod.md` → `:deploy:prod`）
- Skill 文件（`SKILL.md`）用目录名而非文件名（因为文件名固定是 `SKILL.md`）

命令内容支持**变量替换**：

```typescript
// 支持的变量:
// ${CLAUDE_PLUGIN_ROOT}  → 插件在磁盘上的路径
// ${user_config.X}       → 用户配置的值（来自 /plugin 配置界面）
// ${CLAUDE_SESSION_ID}   → 当前会话 ID
```

### Hooks 加载：JSON 配置 → 注册到全局状态

```typescript
// utils/plugins/loadPluginHooks.ts

export const loadPluginHooks = memoize(async (): Promise<void> => {
  const { enabled } = await loadAllPluginsCacheOnly()

  // 收集所有插件的 hooks
  for (const plugin of enabled) {
    if (!plugin.hooksConfig) continue
    const pluginMatchers = convertPluginHooksToMatchers(plugin)
    // 合并到全局集合
    for (const event of Object.keys(pluginMatchers)) {
      allPluginHooks[event].push(...pluginMatchers[event])
    }
  }

  // 原子交换：先清除旧的，再注册新的
  clearRegisteredPluginHooks()
  registerHookCallbacks(allPluginHooks)
})
```

这里的**原子交换**模式值得深入讨论。源码注释记录了一个真实的 bug：

```typescript
// Clear-then-register as an atomic pair. Previously the clear lived in
// clearPluginHookCache(), which meant any clearAllCaches() call (from
// /plugins UI, pluginInstallationHelpers, thinkback, etc.) wiped plugin
// hooks from STATE.registeredHooks and left them wiped until someone
// happened to call loadPluginHooks() again. SessionStart explicitly awaits
// loadPluginHooks() before firing so it always re-registered; Stop has no
// such guard, so plugin Stop hooks silently never fired after any plugin
// management operation (gh-29767).
```

之前的实现把"清除旧 hooks"和"注册新 hooks"分开了——清除在 `clearPluginHookCache()` 中，注册在 `loadPluginHooks()` 中。问题是：任何调用 `clearAllCaches()` 的代码（插件管理 UI、安装助手等）都会触发清除，但不一定会触发重新注册。结果是 `Stop` 类型的 hooks 在插件管理操作后静默失效。

修复方案是把清除和注册放在同一个函数中，作为**原子对**执行。旧 hooks 一直有效，直到新 hooks 准备好替换它们。

插件 hooks 还支持**热重载**——当远程管理设置变化时自动刷新：

```typescript
// utils/plugins/loadPluginHooks.ts

export function setupPluginHookHotReload(): void {
  settingsChangeDetector.subscribe(source => {
    if (source === 'policySettings') {
      const newSnapshot = getPluginAffectingSettingsSnapshot()
      if (newSnapshot === lastPluginSettingsSnapshot) return  // 无变化，跳过

      lastPluginSettingsSnapshot = newSnapshot
      clearPluginCache('loadPluginHooks: plugin-affecting settings changed')
      clearPluginHookCache()
      void loadPluginHooks()  // fire-and-forget
    }
  })
}
```

快照比较不仅检查 `enabledPlugins`，还检查 `strictKnownMarketplaces`、`blockedMarketplaces`、`extraKnownMarketplaces`——因为这些策略字段也会影响哪些插件被加载。

### MCP 服务器加载：多格式支持 + 环境变量解析

MCP 服务器的加载是最复杂的组件加载路径，因为它需要处理多种配置格式：

```typescript
// utils/plugins/mcpPluginIntegration.ts

export async function loadPluginMcpServers(
  plugin: LoadedPlugin,
  errors: PluginError[] = [],
): Promise<Record<string, McpServerConfig> | undefined> {
  let servers: Record<string, McpServerConfig> = {}

  // 1. 从 .mcp.json 文件加载（最低优先级）
  const defaultMcpServers = await loadMcpServersFromFile(plugin.path, '.mcp.json')
  if (defaultMcpServers) servers = { ...servers, ...defaultMcpServers }

  // 2. 从 manifest.mcpServers 加载（更高优先级）
  if (plugin.manifest.mcpServers) {
    const mcpServersSpec = plugin.manifest.mcpServers

    if (typeof mcpServersSpec === 'string') {
      if (isMcpbSource(mcpServersSpec)) {
        // MCPB/DXT 文件：下载、解压、验证
        const mcpbServers = await loadMcpServersFromMcpb(plugin, mcpServersSpec, errors)
        if (mcpbServers) servers = { ...servers, ...mcpbServers }
      } else {
        // JSON 文件路径
        const mcpServers = await loadMcpServersFromFile(plugin.path, mcpServersSpec)
        if (mcpServers) servers = { ...servers, ...mcpServers }
      }
    } else if (Array.isArray(mcpServersSpec)) {
      // 数组：并行加载所有条目
      const results = await Promise.all(mcpServersSpec.map(async spec => { ... }))
      for (const result of results) { if (result) servers = { ...servers, ...result } }
    } else {
      // 内联配置对象
      servers = { ...servers, ...mcpServersSpec }
    }
  }

  return Object.keys(servers).length > 0 ? servers : undefined
}
```

加载完成后，MCP 服务器需要经过**环境变量解析**和**作用域前缀添加**：

```typescript
// 环境变量解析链:
// 1. ${CLAUDE_PLUGIN_ROOT} → 插件磁盘路径
// 2. ${user_config.X}      → 用户配置值
// 3. ${VAR}                → 系统环境变量

export function resolvePluginMcpEnvironment(
  config: McpServerConfig,
  plugin: { path: string; source: string },
  userConfig?: UserConfigValues,
): McpServerConfig {
  const resolveValue = (value: string): string => {
    let resolved = substitutePluginVariables(value, plugin)      // 步骤 1
    if (userConfig) resolved = substituteUserConfigVariables(resolved, userConfig)  // 步骤 2
    const { expanded } = expandEnvVarsInString(resolved)         // 步骤 3
    return expanded
  }
  // 对 command、args、env、url、headers 等字段逐一解析
  // ...
}

// 作用域前缀:
// "my-server" → "plugin:my-plugin:my-server"
export function addPluginScopeToServers(servers, pluginName, pluginSource) {
  for (const [name, config] of Object.entries(servers)) {
    const scopedName = `plugin:${pluginName}:${name}`
    scopedServers[scopedName] = { ...config, scope: 'dynamic', pluginSource }
  }
  return scopedServers
}
```

**为什么 MCP 服务器名要加 `plugin:` 前缀？**

因为 MCP 服务器名是全局唯一的——用户配置的 MCP 服务器和插件提供的 MCP 服务器共享同一个命名空间。`plugin:my-plugin:my-server` 前缀确保了：
- 插件服务器不会与用户手动配置的服务器冲突
- 从服务器名可以追溯到提供它的插件
- 权限系统可以基于前缀做批量控制

**为什么环境变量每次都重新解析，而不是缓存解析结果？**

```typescript
// Store the UNRESOLVED servers on the plugin for caching
// (Environment variables will be resolved fresh each time they're needed)
plugin.mcpServers = servers  // 缓存未解析的版本
```

因为环境变量可能在运行时变化（比如用户修改了 `user_config`）。缓存未解析的版本，每次使用时重新解析，确保了**配置的实时性**。

### 组件合并：useMergedCommands 与 useMergedTools

所有插件组件最终需要与内置组件合并，供 REPL 使用：

```typescript
// REPL.tsx 中的合并链路:

// 命令合并: 内置命令 + 插件命令 + MCP 命令
const commandsWithPlugins = useMergedCommands(localCommands, plugins.commands)
const mergedCommands = useMergedCommands(commandsWithPlugins, mcp.commands)

// 工具合并: 内置工具 + MCP 工具（插件工具通过 MCP 桥接）
const mergedTools = useMergedTools(combinedInitialTools, mcp.tools, toolPermissionContext)
```

命令合并的实现非常简洁：

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

`uniqBy([...initialCommands, ...mcpCommands], 'name')` 的语义是：**内置命令优先**。如果插件命令与内置命令同名，内置命令胜出。这是一个安全设计——插件不能覆盖内置的 `/help`、`/clear` 等核心命令。

工具合并更复杂，因为涉及权限过滤和 deny 规则：

```typescript
// hooks/useMergedTools.ts

export function useMergedTools(initialTools, mcpTools, toolPermissionContext): Tools {
  return useMemo(() => {
    // assembleToolPool: 内置工具 + MCP deny 规则过滤 + 去重 + MCP CLI 排除
    const assembled = assembleToolPool(toolPermissionContext, mcpTools)
    // mergeAndFilterTools: 按权限模式过滤
    return mergeAndFilterTools(initialTools, assembled, toolPermissionContext.mode)
  }, [initialTools, mcpTools, toolPermissionContext])
}
```

### 设计决策讨论

**为什么命令用 Markdown 而不是 TypeScript/JavaScript？**

这是整个插件系统最重要的设计决策之一。插件命令是 Markdown 文件（带 frontmatter），不是可执行代码：

```markdown
---
description: Deploy to production
allowed-tools: BashTool
model: opus
---

Deploy the current project to production using the deployment script
at ${CLAUDE_PLUGIN_ROOT}/scripts/deploy.sh.

Steps:
1. Run tests first
2. Build the project
3. Deploy using the script
```

这个选择的 trade-off：

| | Markdown 命令 | TypeScript 命令 |
|---|---|---|
| 安全性 | 高（声明式，不执行代码） | 低（可执行任意代码） |
| 表达力 | 中（prompt 模板 + 工具约束） | 高（完整编程能力） |
| 开发门槛 | 低（写 Markdown） | 中（写 TypeScript） |
| 审计难度 | 低（人类可读） | 高（需要代码审查） |
| 沙箱需求 | 无（不执行代码） | 需要（V8 isolate 或进程隔离） |

Claude Code 选择了安全性和低门槛，牺牲了一些表达力。对于需要完整编程能力的场景，插件可以通过 MCP 服务器暴露工具——MCP 服务器运行在独立进程中，天然具有进程隔离。

**为什么每种组件都有独立的 memoize？**

```typescript
export const getPluginCommands = memoize(async () => { ... })
export const loadPluginAgents = memoize(async () => { ... })
export const loadPluginHooks = memoize(async () => { ... })
```

而不是一个统一的 `loadAllPluginComponents()`？

因为不同的消费者需要不同的组件：
- `getCommands()` 只需要命令，不需要 Hooks
- MCP 连接管理器只需要 MCP 服务器配置
- 权限系统只需要 Hooks

独立 memoize 意味着**按需加载**——只有被请求的组件才会被加载。但这也带来了 10.3 节讨论的缓存一致性问题：`/reload-plugins` 必须清除所有 memoize 才能保证一致性。

---

## 10.6 内置插件与 DXT 格式

### 面临的问题

除了第三方 marketplace 插件，Claude Code 还需要支持两种特殊的插件形态：

1. **内置插件（Builtin Plugins）**：随 CLI 分发的功能，但用户应该能够开关它们。比如某些实验性功能，默认关闭，用户可以在 `/plugin` UI 中启用。
2. **DXT 插件（Desktop Extension）**：一种打包格式（`.dxt` / `.mcpb` 文件），将 MCP 服务器及其运行时依赖打包成单个可分发文件。

这两种形态面临不同的问题：内置插件需要在"内置"和"可配置"之间找到平衡；DXT 需要在"便捷分发"和"安全解压"之间找到平衡。

### 内置插件：从 Map 注册表到 LoadedPlugin

```typescript
// plugins/builtinPlugins.ts

const BUILTIN_PLUGINS: Map<string, BuiltinPluginDefinition> = new Map()

export function registerBuiltinPlugin(definition: BuiltinPluginDefinition): void {
  BUILTIN_PLUGINS.set(definition.name, definition)
}
```

内置插件的注册发生在启动的最早期（`main.tsx` 中 `initBuiltinPlugins()` 调用）：

```typescript
// plugins/bundled/index.ts

export function initBuiltinPlugins(): void {
  // No built-in plugins registered yet — this is the scaffolding for
  // migrating bundled skills that should be user-toggleable.
}
```

目前这个函数是空的——这是一个**预留的架构脚手架**。源码注释说明了意图：将现有的 bundled skills 中"用户应该能开关"的部分迁移为内置插件。

内置插件的类型定义揭示了它的能力边界：

```typescript
// types/plugin.ts

export type BuiltinPluginDefinition = {
  name: string
  description: string
  version?: string
  skills?: BundledSkillDefinition[]    // 可以提供 Skills
  hooks?: HooksSettings                // 可以提供 Hooks
  mcpServers?: Record<string, McpServerConfig>  // 可以提供 MCP 服务器
  isAvailable?: () => boolean          // 动态可用性检查
  defaultEnabled?: boolean             // 默认启用状态
}
```

内置插件与 marketplace 插件的关键区别：

| | 内置插件 | Marketplace 插件 |
|---|---|---|
| 分发方式 | 随 CLI 打包 | git clone / npm install |
| 磁盘路径 | 无（`path: 'builtin'` 哨兵值） | `~/.claude/plugins/cache/...` |
| 标识符 | `name@builtin` | `name@marketplace` |
| 启用/禁用 | 用户设置 + `defaultEnabled` 兜底 | 用户设置 |
| 可用性 | `isAvailable()` 动态判断 | 始终可用（如果已安装） |

**`isAvailable()` 的设计意图**：某些内置插件可能依赖系统能力（比如只在 macOS 上可用）。`isAvailable()` 返回 `false` 时，插件完全隐藏——不出现在 `/plugin` UI 中，不计入 enabled/disabled 列表。

**启用状态的三级优先级**：

```typescript
// plugins/builtinPlugins.ts — getBuiltinPlugins()

const userSetting = settings?.enabledPlugins?.[pluginId]
// Enabled state: user preference > plugin default > true
const isEnabled = userSetting !== undefined
  ? userSetting === true
  : (definition.defaultEnabled ?? true)
```

1. 用户在 settings 中的显式设置（最高优先级）
2. 插件定义的 `defaultEnabled`
3. 兜底值 `true`（默认启用）

### DXT 格式：安全的 MCP 服务器打包

DXT（Desktop Extension）是一种 ZIP 格式的打包文件（`.dxt` 或 `.mcpb` 后缀），包含：
- `manifest.json`：DXT 清单（服务器配置、用户配置 schema、权限声明）
- MCP 服务器的可执行文件和依赖

DXT 的加载流程：

```
.dxt/.mcpb 文件
    │
    ▼
loadMcpbFile()
    ├─ 1. 获取文件内容（本地读取或 HTTP 下载）
    ├─ 2. 计算内容哈希（SHA-256）
    ├─ 3. 检查缓存（哈希匹配 → 跳过解压）
    ├─ 4. 解压 ZIP（带安全验证）
    ├─ 5. 解析 manifest.json
    ├─ 6. 验证用户配置（如果需要）
    ├─ 7. 恢复文件权限（Unix 可执行位）
    └─ 8. 构建 McpServerConfig
```

DXT 解压的安全验证是整个流程中最关键的部分：

```typescript
// utils/dxt/zip.ts

const LIMITS = {
  MAX_FILE_SIZE: 512 * 1024 * 1024,      // 单文件 512MB
  MAX_TOTAL_SIZE: 1024 * 1024 * 1024,     // 总计 1GB
  MAX_FILE_COUNT: 100000,                  // 最多 10 万个文件
  MAX_COMPRESSION_RATIO: 50,              // 压缩比上限 50:1
  MIN_COMPRESSION_RATIO: 0.5,             // 压缩比下限 0.5:1
}

export function validateZipFile(file, state): FileValidationResult {
  state.fileCount++

  // 1. 文件数量检查
  if (state.fileCount > LIMITS.MAX_FILE_COUNT) { /* error */ }

  // 2. 路径遍历攻击检查
  if (!isPathSafe(file.name)) { /* error */ }

  // 3. 单文件大小检查
  if (fileSize > LIMITS.MAX_FILE_SIZE) { /* error */ }

  // 4. 总大小检查
  state.totalUncompressedSize += fileSize
  if (state.totalUncompressedSize > LIMITS.MAX_TOTAL_SIZE) { /* error */ }

  // 5. Zip Bomb 检测（压缩比异常）
  const currentRatio = state.totalUncompressedSize / state.compressedSize
  if (currentRatio > LIMITS.MAX_COMPRESSION_RATIO) { /* error */ }

  return { isValid: true }
}
```

**路径遍历攻击防护**：

```typescript
export function isPathSafe(filePath: string): boolean {
  if (containsPathTraversal(filePath)) return false  // 检查 ../
  const normalized = normalize(filePath)
  if (isAbsolute(normalized)) return false            // 拒绝绝对路径
  return true
}
```

恶意 ZIP 文件可能包含 `../../etc/passwd` 这样的路径，解压时会写入 ZIP 目标目录之外的位置。`isPathSafe()` 通过检查路径遍历和绝对路径来防止这种攻击。

**Zip Bomb 检测**：

压缩比超过 50:1 被视为可疑。经典的 Zip Bomb（如 42.zip）通过嵌套压缩达到极端压缩比（百万:1），解压时会耗尽磁盘空间和内存。50:1 的阈值对正常的代码/二进制文件来说绰绰有余，但能有效拦截 Zip Bomb。

**Unix 文件权限恢复**：

```typescript
// utils/dxt/zip.ts — parseZipModes()

// fflate's unzipSync returns only Record<string, Uint8Array> — it does not
// surface the external file attributes stored in the central directory. This
// means executable bits are lost during extraction (everything becomes 0644).

export function parseZipModes(data: Uint8Array): Record<string, number> {
  // 手动解析 ZIP 中央目录，提取 Unix 文件权限位
  // versionMadeBy high byte === 3 表示 Unix 主机创建
  // externalAttr 高 16 位包含 st_mode
}
```

这是一个精巧的实现细节。`fflate`（ZIP 解压库）不保留文件权限信息，但 MCP 服务器的可执行文件需要 `+x` 权限。`parseZipModes()` 直接解析 ZIP 的中央目录二进制格式，提取 Unix 文件权限位，然后在解压后通过 `chmod` 恢复。

**DXT manifest 验证的延迟导入**：

```typescript
// utils/dxt/helpers.ts

export async function validateManifest(manifestJson: unknown): Promise<McpbManifest> {
  // Lazy-imports @anthropic-ai/mcpb: that package uses zod v3 which eagerly
  // creates 24 .bind(this) closures per schema instance (~300 instances between
  // schemas.js and schemas-loose.js). Deferring the import keeps ~700KB of bound
  // closures out of the startup heap for sessions that never touch .dxt/.mcpb.
  const { McpbManifestSchema } = await import('@anthropic-ai/mcpb')
  return McpbManifestSchema.safeParse(manifestJson)
}
```

`@anthropic-ai/mcpb` 包在导入时会创建大量 Zod schema 实例（~700KB 堆内存）。由于大多数会话不会接触 DXT 文件，延迟导入避免了这个启动开销。这与第一章讨论的"按需加载"原则一脉相承。

### 设计决策讨论

**为什么内置插件用 Map 而不是静态数组？**

```typescript
const BUILTIN_PLUGINS: Map<string, BuiltinPluginDefinition> = new Map()
```

Map 支持动态注册（`registerBuiltinPlugin()`），这意味着内置插件可以在不同的构建变体中有不同的集合。比如内部版本可以注册额外的调试插件，而外部版本不注册。这与第一章讨论的 `feature()` 编译期门控配合使用。

**为什么 DXT 不直接执行 ZIP 中的代码，而是先解压到磁盘？**

理论上可以在内存中运行 ZIP 中的 Node.js 脚本（类似 Java 的 JAR）。但 MCP 服务器通常需要：
- 文件系统访问（读取配置文件、写入日志）
- 子进程 spawn（某些 MCP 服务器是 Python/Go 编写的）
- 动态链接库加载

这些操作都需要磁盘上的真实文件。解压到磁盘是最兼容的方案。

**为什么 DXT 用内容哈希做缓存键，而不是版本号？**

```typescript
function generateContentHash(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex').substring(0, 16)
}
```

因为 DXT 文件可能来自 URL，而 URL 不一定包含版本信息。内容哈希是**内容寻址**的——相同内容总是得到相同的缓存路径，不同内容总是得到不同的缓存路径。这比依赖外部版本号更可靠。

---

## 10.7 插件生命周期管理

### 面临的问题

插件不是"安装了就完事"的静态资源。它有完整的生命周期：

- **安装**：从 marketplace 下载、缓存、注册
- **启用/禁用**：用户可以临时关闭插件而不卸载
- **更新**：marketplace 中的插件可能有新版本
- **卸载**：清理缓存、设置、数据目录
- **下架（Delisting）**：marketplace 维护者移除了某个插件
- **刷新**：将磁盘上的变更同步到运行时

每个操作都需要处理多作用域（user/project/local）、依赖关系、缓存一致性等问题。

### 安装与卸载：pluginOperations.ts

`services/plugins/pluginOperations.ts` 是插件操作的核心模块。它的设计原则在文件头注释中说得很清楚：

```typescript
// Core plugin operations (install, uninstall, enable, disable, update)
//
// This module provides pure library functions that can be used by both:
// - CLI commands (`claude plugin install/uninstall/enable/disable/update`)
// - Interactive UI (ManagePlugins.tsx)
//
// Functions in this module:
// - Do NOT call process.exit()
// - Do NOT write to console
// - Return result objects indicating success/failure with messages
// - Can throw errors for unexpected failures
```

这是一个**关注点分离**的设计——操作逻辑与 UI 展示完全解耦。CLI 命令和交互式 UI 共享同一套操作函数，只是展示方式不同。

安装流程涉及依赖解析：

```
installPluginOp(pluginId, scope)
    │
    ├─ 1. 解析 pluginId → name + marketplace
    ├─ 2. 从 marketplace 查找插件条目
    ├─ 3. resolveDependencyClosure() → 计算依赖闭包
    │     ├─ 跨 marketplace 检查
    │     ├─ 循环依赖检测
    │     └─ 已启用依赖跳过
    ├─ 4. 对闭包中的每个插件:
    │     ├─ installResolvedPlugin() → git clone / npm install
    │     ├─ cacheAndRegisterPlugin() → 写入 installed_plugins.json
    │     └─ 更新 settings.enabledPlugins
    └─ 5. 返回结果（成功/失败 + 消息）
```

卸载时会检查反向依赖：

```typescript
// 卸载前检查谁依赖了这个插件
const rdeps = findReverseDependents(pluginId, allPlugins)
// 返回警告: "warning: required by X, Y"
// 但不阻止卸载——用户有最终决定权
```

### 自动更新：后台静默升级

```typescript
// utils/plugins/pluginAutoupdate.ts

// At startup, this module:
// 1. First updates marketplaces that have autoUpdate enabled
// 2. Then checks all installed plugins from those marketplaces and updates them
//
// Updates are non-inplace (disk-only), requiring a restart to take effect.
```

自动更新的关键设计是**非原地更新**（non-inplace）：

```
自动更新流程:

1. 后台 git pull marketplace 仓库
2. 对比 installed_plugins.json 中的版本与 marketplace 最新版本
3. 如果有更新:
   ├─ 下载新版本到新的版本化缓存目录
   │   ~/.claude/plugins/cache/mkt/plugin/v2/  (新)
   │   ~/.claude/plugins/cache/mkt/plugin/v1/  (旧，仍在使用)
   ├─ 更新 installed_plugins.json 指向新版本
   └─ 通知用户 "Plugins updated. Restart to apply."
4. 旧版本在下次启动时被标记为孤儿，7 天后清理
```

**为什么不原地更新？**

因为当前会话正在使用旧版本的插件文件（命令 Markdown、Agent 定义等）。如果原地覆盖，可能导致：
- 正在执行的命令读到半写入的文件
- 内存中缓存的路径指向已变更的内容
- MCP 服务器进程的可执行文件被替换

非原地更新通过版本化缓存路径避免了这些问题。新版本写入新目录，旧版本保持不变，直到下次启动时切换。

**更新通知的竞态处理**：

```typescript
// Store pending updates that occurred before callback was registered
// This handles the race condition where updates complete before REPL mounts
let pendingNotification: string[] | null = null

export function onPluginsAutoUpdated(callback: PluginAutoUpdateCallback): () => void {
  pluginUpdateCallback = callback
  // If there are pending updates that happened before registration, deliver them now
  if (pendingNotification !== null && pendingNotification.length > 0) {
    callback(pendingNotification)
    pendingNotification = null
  }
  return () => { pluginUpdateCallback = null }
}
```

自动更新在后台运行，可能在 REPL 挂载之前就完成了。`pendingNotification` 缓存了这些"早到的"更新通知，在回调注册时立即投递。

### 下架检测：安全的强制移除

```typescript
// utils/plugins/pluginBlocklist.ts

export async function detectAndUninstallDelistedPlugins(): Promise<string[]> {
  for (const marketplaceName of Object.keys(knownMarketplaces)) {
    const marketplace = await getMarketplace(marketplaceName)

    // 只有启用了 forceRemoveDeletedPlugins 的 marketplace 才执行
    if (!marketplace.forceRemoveDeletedPlugins) continue

    const delisted = detectDelistedPlugins(installedPlugins, marketplace, marketplaceName)

    for (const pluginId of delisted) {
      // 跳过已标记的（避免重复处理）
      if (pluginId in alreadyFlagged) continue

      // 跳过 managed 作用域的（企业管理员负责）
      const hasUserInstall = installations.some(
        i => i.scope === 'user' || i.scope === 'project' || i.scope === 'local'
      )
      if (!hasUserInstall) continue

      // 自动卸载 + 标记
      for (const installation of installations) {
        await uninstallPluginOp(pluginId, scope)
      }
      await addFlaggedPlugin(pluginId)
    }
  }
}
```

下架检测解决了一个安全问题：**如果 marketplace 维护者发现某个插件是恶意的，需要能够远程移除它。**

流程是：
1. marketplace 维护者从 `marketplace.json` 中删除该插件条目
2. 用户下次启动 Claude Code 时，`detectAndUninstallDelistedPlugins()` 发现该插件不在 marketplace 中了
3. 自动从所有用户可控作用域卸载
4. 标记为"已下架"，在 `/plugins` UI 中显示通知

**为什么跳过 managed 作用域？**

因为 managed 作用域由企业 IT 管理员控制。如果管理员通过 MDM 策略强制安装了某个插件，marketplace 维护者的下架操作不应该覆盖管理员的决策。这是**管理权限层级**的体现。

### 刷新机制：refreshActivePlugins()

`/reload-plugins` 命令触发的刷新是整个插件生命周期中最复杂的操作：

```typescript
// utils/plugins/refresh.ts — refreshActivePlugins()

export async function refreshActivePlugins(setAppState): Promise<RefreshActivePluginsResult> {
  // 1. 清除所有缓存
  clearAllCaches()
  clearPluginCacheExclusions()

  // 2. 完整重新加载（可能触发网络 I/O）
  const pluginResult = await loadAllPlugins()

  // 3. 加载组件（命令和 Agent 可以并行）
  const [pluginCommands, agentDefinitions] = await Promise.all([
    getPluginCommands(),
    getAgentDefinitionsWithOverrides(getOriginalCwd()),
  ])

  // 4. 加载 MCP 和 LSP 服务器（每个插件并行）
  const [mcpCounts, lspCounts] = await Promise.all([
    Promise.all(enabled.map(async p => {
      const servers = await loadPluginMcpServers(p, errors)
      if (servers) p.mcpServers = servers
      return servers ? Object.keys(servers).length : 0
    })),
    Promise.all(enabled.map(async p => {
      const servers = await loadPluginLspServers(p, errors)
      if (servers) p.lspServers = servers
      return servers ? Object.keys(servers).length : 0
    })),
  ])

  // 5. 原子更新 AppState
  setAppState(prev => ({
    ...prev,
    plugins: { ...prev.plugins, enabled, disabled, commands: pluginCommands, errors, needsRefresh: false },
    agentDefinitions,
    mcp: { ...prev.mcp, pluginReconnectKey: prev.mcp.pluginReconnectKey + 1 },
  }))

  // 6. 重新初始化 LSP 管理器
  reinitializeLspServerManager()

  // 7. 重新加载 Hooks（原子交换）
  await loadPluginHooks()
}
```

注意步骤 5 中的 `pluginReconnectKey + 1`。这是一个**递增计数器**，MCP 连接管理器的 `useEffect` 依赖这个值——当它变化时，effect 重新运行，触发 MCP 服务器的重新连接。这是 React 中触发副作用的标准模式。

**刷新的顺序约束**：

```
loadAllPlugins()          ← 必须先完成（写入 installed_plugins.json）
    │
    ├─→ getPluginCommands()      ← 读取 loadAllPluginsCacheOnly()（已被预热）
    ├─→ getAgentDefinitions()    ← 同上
    │
    ├─→ loadPluginMcpServers()   ← 填充 LoadedPlugin.mcpServers 缓存槽
    ├─→ loadPluginLspServers()   ← 填充 LoadedPlugin.lspServers 缓存槽
    │
    └─→ setAppState()            ← 必须在所有组件加载后
         │
         └─→ loadPluginHooks()   ← 可以在 setAppState 后（hooks 不在 AppState 中）
```

源码注释记录了一个之前的 bug：

```typescript
// Before #23693 all three shared loadAllPlugins()'s memoize promise so
// Promise.all was a no-op race. After #23693 getPluginCommands/getAgentDefinitions
// call loadAllPluginsCacheOnly (separate memoize) — racing them means they
// read installed_plugins.json before loadAllPlugins() has cloned+cached
// the plugin, returning plugin-cache-miss.
```

之前 `getPluginCommands()` 和 `loadAllPlugins()` 共享同一个 memoize，所以 `Promise.all` 实际上是串行的。重构后它们用了不同的 memoize，如果并行执行，`getPluginCommands()` 可能在 `loadAllPlugins()` 完成缓存之前就读取了 `installed_plugins.json`，导致 cache miss。修复方案是先 `await loadAllPlugins()`，再并行加载组件。

### 设计决策讨论

**为什么 pluginOperations.ts 不直接操作 UI？**

```typescript
// Functions in this module:
// - Do NOT call process.exit()
// - Do NOT write to console
// - Return result objects indicating success/failure with messages
```

这是**命令-查询分离（CQS）**原则的应用。操作函数只负责执行逻辑和返回结果，不负责展示。这使得同一套操作可以被 CLI（`claude plugin install`）、交互式 UI（`/plugin` 菜单）、甚至 SDK 调用共享。

**为什么孤儿版本要等 7 天才清理？**

```typescript
// markPluginVersionOrphaned() → 标记为孤儿
// cleanupOrphanedPluginVersionsInBackground() → 7 天后清理
```

因为用户可能有多个 Claude Code 会话同时运行。一个会话更新了插件（旧版本变成孤儿），但另一个会话可能还在使用旧版本。7 天的宽限期确保了所有会话都有足够时间切换到新版本。

---

## 10.8 企业安全策略与 Marketplace 管控

### 面临的问题

对于个人开发者，插件系统的安全模型相对简单——用户自己决定信任哪些插件。但在企业环境中，问题变得复杂得多：

1. **IT 管理员需要控制哪些 marketplace 可以被使用。** 不能让员工从任意来源安装插件。
2. **某些插件需要被强制启用或禁用。** 比如企业内部的合规检查插件必须启用，某些有安全风险的插件必须禁用。
3. **用户自定义的命令、Agent、Hooks 可能需要被限制。** 在高安全环境中，只允许通过审核的插件提供定制化能力。
4. **策略变更需要实时生效。** 不能等用户重启 Claude Code。

### Marketplace 白名单与黑名单

企业管理员通过 `policySettings`（MDM 或远程托管设置）控制 marketplace 访问：

```typescript
// utils/plugins/marketplaceHelpers.ts

// 白名单模式：只允许列表中的 marketplace
export function getStrictKnownMarketplaces(): MarketplaceSource[] | null {
  const policySettings = getSettingsForSource('policySettings')
  if (!policySettings?.strictKnownMarketplaces) return null  // 无限制
  return policySettings.strictKnownMarketplaces
}

// 黑名单模式：阻止列表中的 marketplace
export function getBlockedMarketplaces(): MarketplaceSource[] | null {
  const policySettings = getSettingsForSource('policySettings')
  if (!policySettings?.blockedMarketplaces) return null  // 无黑名单
  return policySettings.blockedMarketplaces
}
```

白名单和黑名单可以同时存在，检查逻辑是**白名单优先**：

```typescript
// utils/plugins/marketplaceHelpers.ts — isSourceAllowedByPolicy()

export function isSourceAllowedByPolicy(source: MarketplaceSource): boolean {
  // 1. 如果有白名单，source 必须在白名单中
  const strict = getStrictKnownMarketplaces()
  if (strict !== null) {
    return strict.some(allowed => sourceMatchesPolicy(source, allowed))
  }

  // 2. 如果有黑名单，source 不能在黑名单中
  const blocked = getBlockedMarketplaces()
  if (blocked !== null) {
    return !blocked.some(b => sourceMatchesPolicy(source, b))
  }

  // 3. 都没有 → 允许
  return true
}
```

策略匹配支持多种粒度：

```typescript
// 精确匹配：完整的 source 对象比较
{ "source": "github", "repo": "anthropics/claude-plugins-official" }

// 主机模式匹配：基于域名的通配
{ "source": "hostPattern", "host": "*.company.com" }

// 路径模式匹配：基于路径的通配
{ "source": "pathPattern", "pattern": "/opt/company/plugins/*" }
```

`hostPattern` 的实现提取 marketplace source 的域名进行匹配：

```typescript
export function extractHostFromSource(source: MarketplaceSource): string | null {
  switch (source.source) {
    case 'github':
      return 'github.com'  // GitHub 简写总是 github.com
    case 'git': {
      // SSH: git@HOST:path → 提取 HOST
      const sshMatch = source.url.match(/^[^@]+@([^:]+):/)
      if (sshMatch?.[1]) return sshMatch[1]
      // HTTPS: 提取 hostname
      return new URL(source.url).hostname
    }
    case 'url':
      return new URL(source.url).hostname
    default:
      return null  // npm/file/directory 不支持 host 匹配
  }
}
```

### 受管插件：企业强制安装

```typescript
// utils/plugins/managedPlugins.ts

export function getManagedPluginNames(): Set<string> | null {
  const enabledPlugins = getSettingsForSource('policySettings')?.enabledPlugins
  if (!enabledPlugins) return null  // 无策略

  const names = new Set<string>()
  for (const [pluginId, value] of Object.entries(enabledPlugins)) {
    // 只有 plugin@marketplace 格式的布尔值条目受保护
    if (typeof value !== 'boolean' || !pluginId.includes('@')) continue
    const name = pluginId.split('@')[0]
    if (name) names.add(name)
  }
  return names.size > 0 ? names : null
}
```

受管插件有特殊的保护：
- 用户不能卸载或禁用受管插件
- 受管插件的启用/禁用状态由策略决定（`true` = 强制启用，`false` = 强制禁用）
- 在 `/plugin` UI 中，受管插件显示锁定图标

### strictPluginOnlyCustomization：锁定定制化来源

这是最严格的企业策略——限制定制化能力只能来自插件：

```typescript
// utils/settings/pluginOnlyPolicy.ts

export function isRestrictedToPluginOnly(surface: CustomizationSurface): boolean {
  const policy = getSettingsForSource('policySettings')?.strictPluginOnlyCustomization
  if (policy === true) return true          // 锁定所有表面
  if (Array.isArray(policy)) return policy.includes(surface)  // 锁定指定表面
  return false                              // 不锁定
}
```

当某个"定制化表面"（customization surface）被锁定时：

```
被锁定的表面:
  ├─ commands  → 用户自定义的斜杠命令被忽略
  ├─ agents    → 用户自定义的 Agent 定义被忽略
  ├─ hooks     → 用户自定义的 Hooks 被忽略
  └─ skills    → 用户自定义的 Skills 被忽略

仍然允许的来源:
  ├─ plugin        → 通过审核的插件（受 strictKnownMarketplaces 管控）
  ├─ policySettings → 管理员通过策略设置的
  ├─ built-in      → CLI 内置的
  ├─ builtin       → 内置斜杠命令
  └─ bundled       → 捆绑的 Skills
```

```typescript
// 判断来源是否受信任
const ADMIN_TRUSTED_SOURCES: ReadonlySet<string> = new Set([
  'plugin',          // 插件（受 marketplace 策略管控）
  'policySettings',  // 管理员策略
  'built-in',        // 内置（AgentDefinition.source）
  'builtin',         // 内置（Command.source）
  'bundled',         // 捆绑 Skills
])

export function isSourceAdminTrusted(source: string | undefined): boolean {
  return source !== undefined && ADMIN_TRUSTED_SOURCES.has(source)
}
```

这个策略的使用模式是：

```typescript
// 在加载定制化组件时:
const allowed = !isRestrictedToPluginOnly('commands') || isSourceAdminTrusted(command.source)
if (command.hooks && allowed) {
  register(command.hooks)
}
```

### 策略热重载

企业策略可能通过远程托管设置（remoteManagedSettings）实时推送。插件系统通过 `settingsChangeDetector` 监听策略变更：

```typescript
// utils/plugins/loadPluginHooks.ts — setupPluginHookHotReload()

settingsChangeDetector.subscribe(source => {
  if (source === 'policySettings') {
    const newSnapshot = getPluginAffectingSettingsSnapshot()
    if (newSnapshot === lastPluginSettingsSnapshot) return

    lastPluginSettingsSnapshot = newSnapshot
    clearPluginCache('plugin-affecting settings changed')
    clearPluginHookCache()
    void loadPluginHooks()  // fire-and-forget 重新加载
  }
})
```

快照函数检查四个策略字段：

```typescript
export function getPluginAffectingSettingsSnapshot(): string {
  // 检查这四个字段的变化:
  // 1. enabledPlugins          → 哪些插件被启用
  // 2. strictKnownMarketplaces → marketplace 白名单
  // 3. blockedMarketplaces     → marketplace 黑名单
  // 4. extraKnownMarketplaces  → 额外的 marketplace 声明
}
```

源码注释记录了为什么需要检查所有四个字段：

```typescript
// Hashes FOUR fields — not just enabledPlugins — because the memoized
// loadAllPluginsCacheOnly() also reads strictKnownMarketplaces, blockedMarketplaces,
// and extraKnownMarketplaces. If remote managed settings set only one of
// these (no enabledPlugins), a snapshot keyed only on enabledPlugins
// would never diff, the listener would skip, and the memoized result
// would retain the pre-remote marketplace allow/blocklist.
```

### 设计决策讨论

**为什么白名单和黑名单可以共存？**

在大多数系统中，白名单和黑名单是互斥的——有白名单就不需要黑名单。但 Claude Code 的策略可能来自多个管理层级（总部 MDM + 部门远程设置）。总部可能设置白名单（只允许官方 marketplace），部门可能在白名单基础上额外阻止某些特定来源。共存设计支持了这种**层级化策略组合**。

**为什么 `strictPluginOnlyCustomization` 不阻止 MCP 服务器？**

注意 `CustomizationSurface` 只包含 `commands`、`agents`、`hooks`、`skills`——不包含 MCP 服务器。这是因为 MCP 服务器有自己独立的管控机制（`allowedMcpServers` / `deniedMcpServers`），不需要通过 `strictPluginOnlyCustomization` 重复管控。

**为什么受管插件用 `boolean` 而不是更复杂的策略对象？**

```typescript
// policySettings.enabledPlugins:
// { "my-plugin@official": true }   → 强制启用
// { "my-plugin@official": false }  → 强制禁用
```

简单的布尔值覆盖了最常见的企业需求：强制启用合规工具，强制禁用有风险的工具。更复杂的策略（比如"只允许在特定项目中使用"）可以通过 `projectSettings` 层级实现，不需要在 `policySettings` 中增加复杂性。

---

## 10.9 数据流总览与设计哲学

### 完整数据流：从 settings.json 到 LLM 可用工具

将前面各节串联起来，一个插件从声明到可用的完整数据流如下：

```
┌─────────────────────────────────────────────────────────────────────────┐
│  用户/管理员操作                                                         │
│  ─────────────────────────────────────────────────────────────────────── │
│  • settings.json: enabledPlugins["my-plugin@mkt"] = true                │
│  • settings.json: extraKnownMarketplaces["mkt"] = { source: "..." }     │
│  • CLI: claude --plugin-dir /path/to/dev-plugin                         │
│  • MDM: policySettings.enabledPlugins["corp-tool@official"] = true      │
└─────────────────────────────────────────────────────────────────────────┘
         │
         │ (1) 意图声明
         ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  pluginLoader.ts — assemblePluginLoadResult()                           │
│  ─────────────────────────────────────────────────────────────────────── │
│  读取 settings → 查找 marketplace → git clone/npm install → 缓存到磁盘  │
│  → 加载 manifest → 验证 → 合并所有来源 → verifyAndDemote()              │
│                                                                         │
│  输出: PluginLoadResult { enabled[], disabled[], errors[] }             │
└─────────────────────────────────────────────────────────────────────────┘
         │
         │ (2) 物化 + 发现
         ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  组件加载器（并行）                                                      │
│  ─────────────────────────────────────────────────────────────────────── │
│  ┌─────────────────┐  ┌──────────────────┐  ┌──────────────────────┐  │
│  │ loadPluginCmds() │  │ loadPluginAgents()│  │ loadPluginHooks()    │  │
│  │ commands/*.md    │  │ agents/*.md       │  │ hooks.json           │  │
│  │ → Command[]      │  │ → AgentDef[]      │  │ → registerCallbacks()│  │
│  └─────────────────┘  └──────────────────┘  └──────────────────────┘  │
│  ┌─────────────────┐  ┌──────────────────┐                            │
│  │ loadPluginMcp() │  │ loadPluginLsp()  │                            │
│  │ .mcp.json/.mcpb │  │ manifest.lsp     │                            │
│  │ → McpConfig{}   │  │ → LspConfig{}    │                            │
│  └─────────────────┘  └──────────────────┘                            │
└─────────────────────────────────────────────────────────────────────────┘
         │
         │ (3) 组件加载
         ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  AppState 更新 + 合并                                                    │
│  ─────────────────────────────────────────────────────────────────────── │
│  setAppState({                                                          │
│    plugins: { enabled, disabled, commands, errors },                    │
│    agentDefinitions,                                                    │
│    mcp: { pluginReconnectKey++ }  ← 触发 MCP 重连                       │
│  })                                                                     │
│                                                                         │
│  useMergedCommands(builtinCmds, pluginCmds, mcpCmds)                   │
│  useMergedTools(builtinTools, mcpTools, permissionCtx)                  │
└─────────────────────────────────────────────────────────────────────────┘
         │
         │ (4) 运行时合并
         ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  REPL 对话循环                                                          │
│  ─────────────────────────────────────────────────────────────────────── │
│  • 插件命令: 用户输入 /my-plugin:deploy → SkillTool 执行                 │
│  • 插件 Agent: LLM 调用 AgentTool → 派生子代理                          │
│  • 插件 MCP 工具: LLM 调用 mcp__plugin:my-plugin:server__tool           │
│  • 插件 Hooks: PreToolUse/PostToolUse 事件触发插件钩子                   │
│  • 插件 LSP: 编辑器集成提供代码补全/诊断                                 │
└─────────────────────────────────────────────────────────────────────────┘
```

### 启动时序：性能关键路径上的插件加载

```
时间 ──────────────────────────────────────────────────────────────────►

main.tsx:
  │
  ├─ initBuiltinPlugins()              [~1ms, 纯内存操作]
  │
  ├─ getCommands()                     [并行]
  │   └─ loadAllPluginsCacheOnly()     [~5ms, 只读 installed_plugins.json]
  │       └─ getPluginCommands()       [memoize, 读 Markdown 文件]
  │
  ├─ getAgentDefinitions()             [并行]
  │   └─ loadAllPluginsCacheOnly()     [memoize 命中, ~0ms]
  │       └─ loadPluginAgents()        [memoize, 读 Markdown 文件]
  │
  ├─ getClaudeCodeMcpConfigs()         [MCP 服务器配置]
  │   └─ loadAllPluginsCacheOnly()     [memoize 命中, ~0ms]
  │       └─ extractMcpServersFromPlugins()
  │
  ├─ ★ REPL 首屏渲染 ★                 [用户看到提示符]
  │
  ├─ useManagePlugins()                [REPL mount 后]
  │   └─ loadAllPlugins()              [完整加载, 可能 git clone]
  │       ├─ detectAndUninstallDelistedPlugins()
  │       ├─ getPluginCommands()       [可能刷新]
  │       ├─ loadPluginAgents()        [可能刷新]
  │       ├─ loadPluginHooks()         [注册到全局状态]
  │       ├─ loadPluginMcpServers()    [填充缓存槽]
  │       └─ loadPluginLspServers()    [填充缓存槽]
  │
  └─ backgroundPluginAutoupdate()      [后台, fire-and-forget]
      ├─ refreshMarketplace()          [git pull]
      └─ updatePlugin()               [非原地更新]
```

关键洞察：**用户看到提示符之前，插件系统只做了缓存读取（~5ms）。** 完整的插件加载（可能涉及网络 I/O）被推迟到 REPL 挂载之后，不阻塞用户输入。

### 缓存层级与一致性模型

插件系统有多层缓存，每层有不同的生命周期：

```
缓存层级:

1. memoize 缓存（进程内存）
   ├─ loadAllPlugins.cache          生命周期: 进程级, clearAllCaches() 清除
   ├─ loadAllPluginsCacheOnly.cache 生命周期: 进程级, clearAllCaches() 清除
   ├─ getPluginCommands.cache       生命周期: 进程级, clearAllCaches() 清除
   ├─ loadPluginAgents.cache        生命周期: 进程级, clearAllCaches() 清除
   └─ loadPluginHooks.cache         生命周期: 进程级, clearPluginHookCache() 清除

2. LoadedPlugin 缓存槽（对象属性）
   ├─ plugin.mcpServers             生命周期: 对象级, 首次访问时填充
   └─ plugin.lspServers             生命周期: 对象级, 首次访问时填充

3. 磁盘缓存
   ├─ installed_plugins.json        生命周期: 持久化, 安装/卸载时更新
   ├─ cache/{mkt}/{plugin}/{ver}/   生命周期: 持久化, 孤儿 7 天后清理
   └─ known_marketplaces.json       生命周期: 持久化, marketplace 操作时更新

4. 设置缓存
   └─ settingsCache                 生命周期: 进程级, resetSettingsCache() 清除
```

一致性保证：

- **读路径**：`loadAllPluginsCacheOnly()` 只读磁盘缓存，保证快速但可能过时
- **写路径**：`loadAllPlugins()` 完成后预热 `loadAllPluginsCacheOnly` 的 memoize，保证后续读取一致
- **刷新路径**：`/reload-plugins` → `clearAllCaches()` → 全部重新加载，保证完全一致
- **热重载路径**：`settingsChangeDetector` → 清除相关 memoize → 重新加载 hooks

### 核心设计哲学总结

回顾整个插件系统，可以提炼出几个贯穿始终的设计哲学：

**1. 能力通过协议暴露，而非代码注入**

插件不能直接注入 TypeScript 代码到 Claude Code 进程中。所有能力扩展都通过声明式接口（Markdown 模板、JSON 配置）或进程隔离协议（MCP、LSP）实现。这是安全性的根基。

**2. 信任是不可传递的**

信任 marketplace A 不意味着信任 A 中插件依赖的 marketplace B。跨 marketplace 依赖默认被阻止。企业策略（白名单/黑名单）在 marketplace 级别而非插件级别生效。

**3. 显式优于隐式**

设置变更不会自动刷新运行时状态——用户需要执行 `/reload-plugins`。自动更新只写磁盘不改运行时——用户需要重启。这避免了多层 memoize 缓存的一致性问题，也让用户对系统行为有明确预期。

**4. 错误隔离，优雅降级**

一个插件加载失败不影响其他插件。一个 marketplace 不可用不阻止其他 marketplace 的插件加载。依赖不满足的插件被降级而非报错退出。错误被收集到 `PluginLoadResult.errors` 中，供 `/doctor` UI 展示。

**5. 启动性能是硬约束**

插件系统的所有设计决策都受启动性能约束。缓存优先（`loadAllPluginsCacheOnly`）、延迟加载（组件按需加载）、后台更新（`backgroundPluginAutoupdate`）、延迟导入（DXT 的 `@anthropic-ai/mcpb`）——这些都是为了确保用户在 500ms 内看到提示符。

**6. 三层分离，各司其职**

意图层（settings）、物化层（磁盘缓存）、活跃层（AppState）各自独立变化。这使得系统可以在不同层级做不同的优化：意图层可以实时同步（远程策略推送），物化层可以后台更新（git pull），活跃层可以显式刷新（`/reload-plugins`）。

### 关键源码文件索引

| 文件 | 职责 | 行数 |
|------|------|------|
| `types/plugin.ts` | 插件类型定义、错误类型系统 | ~340 |
| `utils/plugins/pluginLoader.ts` | 插件发现与加载核心 | ~2700 |
| `utils/plugins/dependencyResolver.ts` | 依赖解析（DFS 闭包 + 固定点降级） | ~300 |
| `utils/plugins/schemas.ts` | Zod schema（manifest、marketplace、hooks） | ~1680 |
| `utils/plugins/pluginIdentifier.ts` | 标识符解析与作用域映射 | ~124 |
| `utils/plugins/pluginVersioning.ts` | 版本计算（manifest/git/timestamp） | ~158 |
| `utils/plugins/installedPluginsManager.ts` | installed_plugins.json 管理 | ~1200 |
| `utils/plugins/marketplaceManager.ts` | Marketplace 发现与缓存 | ~2000 |
| `utils/plugins/marketplaceHelpers.ts` | 策略匹配（白名单/黑名单） | ~400 |
| `utils/plugins/loadPluginCommands.ts` | 命令加载（Markdown → Command） | ~400 |
| `utils/plugins/loadPluginHooks.ts` | Hooks 加载与热重载 | ~250 |
| `utils/plugins/mcpPluginIntegration.ts` | MCP 服务器加载与环境变量解析 | ~300 |
| `utils/plugins/mcpbHandler.ts` | DXT/MCPB 文件处理 | ~800 |
| `utils/plugins/refresh.ts` | /reload-plugins 刷新逻辑 | ~215 |
| `services/plugins/pluginOperations.ts` | 安装/卸载/启用/禁用操作 | ~1000 |
| `utils/plugins/pluginAutoupdate.ts` | 后台自动更新 | ~200 |
| `utils/plugins/pluginBlocklist.ts` | 下架检测与强制移除 | ~128 |
| `plugins/builtinPlugins.ts` | 内置插件注册表 | ~160 |
| `hooks/useManagePlugins.ts` | React Hook：初始加载与状态同步 | ~300 |
| `hooks/useMergedTools.ts` | 工具合并 Hook | ~45 |
| `hooks/useMergedCommands.ts` | 命令合并 Hook | ~16 |
| `utils/settings/pluginOnlyPolicy.ts` | strictPluginOnlyCustomization 策略 | ~61 |
| `utils/dxt/zip.ts` | ZIP 解压与安全验证 | ~227 |
| `utils/dxt/helpers.ts` | DXT manifest 验证 | ~89 |
