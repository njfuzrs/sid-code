---
title: Claude Code 源码解析（十八）· 高级特性
description: 'Plan 模式如何让 LLM "先想后做"？Worktree 如何实现零风险的代码实验？语音输入、Swarm 协作、Computer Use 等前沿能力如何实现？'
date: "2026-04-01"
series: Claude Code 源码解析
tags: [Claude Code, 源码解析, harness]
outline: 2
---

# 第十八章：高级特性（Advanced Features）

> 那些让 Claude Code 从"能用"变成"好用"的高级能力——Plan Mode、Worktree 隔离、Cron 调度、语音输入、后台会话、Teleport、Swarm 多代理协作、Computer Use。

## 核心问题

一个 AI 编程助手的基本能力是"对话 + 工具调用"——用户提问，模型回答并执行操作。但真实的软件工程场景远比这复杂：

1. **复杂任务需要先规划再执行。** 用户说"给这个项目加认证系统"，模型不应该直接开始写代码——它需要先探索代码库、理解架构、设计方案、征求用户意见，然后才动手。这需要一个**规划模式**。

2. **并行实验需要隔离。** 当模型需要尝试多种方案，或者多个子代理同时工作时，它们不能在同一个 Git 工作区互相踩踏。这需要**文件系统隔离**。

3. **长周期任务需要调度。** "每天早上 9 点检查 PR 状态"、"每 5 分钟跑一次测试"——这些不是一次性对话能解决的。这需要**定时调度**。

4. **打字太慢。** 描述一个复杂的需求，打字可能需要几分钟，说话只需要几十秒。这需要**语音输入**。

5. **长任务不应阻塞用户。** 一个需要 10 分钟的重构任务，用户不应该干等着。这需要**后台执行**。

6. **本地和远程需要无缝切换。** 本地探索完代码后，想把任务交给云端执行。这需要**会话迁移**。

7. **复杂项目需要多人协作。** 一个大型重构可能需要多个代理分工——一个改前端、一个改后端、一个写测试。这需要**多代理协作**。

8. **有些任务需要操作 GUI。** 测试一个 Web 应用、操作一个桌面软件——纯命令行不够。这需要**屏幕交互**。

这八个问题对应了本章的八个高级特性。它们不是独立的功能点，而是一个**能力矩阵**——彼此组合后能覆盖几乎所有真实的软件工程场景。

---

## 架构总览

```
┌─────────────────────────────────────────────────────────────────┐
│                    Claude Code 高级特性矩阵                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │  Plan Mode   │  │  Worktree    │  │  Background Sessions │  │
│  │  规划 → 审批  │  │  Git 隔离    │  │  Ctrl+B 后台化       │  │
│  │  → 执行      │  │  → 并行工作  │  │  → ps/logs/attach    │  │
│  └──────┬───────┘  └──────┬───────┘  └──────────┬───────────┘  │
│         │                 │                      │              │
│         ▼                 ▼                      ▼              │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │              核心对话循环 (QueryEngine)                    │   │
│  │         工具系统 / 权限系统 / 状态管理                      │   │
│  └─────────────────────────────────────────────────────────┘   │
│         ▲                 ▲                      ▲              │
│         │                 │                      │              │
│  ┌──────┴───────┐  ┌──────┴───────┐  ┌──────────┴───────────┐ │
│  │  Cron 调度   │  │  Voice 语音  │  │  Teleport 会话迁移    │ │
│  │  定时触发    │  │  语音 → 文字  │  │  本地 ↔ 远程          │ │
│  │  → 注入对话  │  │  → 注入输入  │  │  → 状态序列化         │ │
│  └──────────────┘  └──────────────┘  └───────────────────────┘ │
│                                                                 │
│  ┌──────────────────────┐  ┌────────────────────────────────┐  │
│  │  Swarm 多代理协作     │  │  Computer Use 屏幕交互         │  │
│  │  Leader + Teammates  │  │  截图 + 键鼠 + 应用管理         │  │
│  │  → 分工 → 通信 → 汇总 │  │  → MCP Server → Native Module │  │
│  └──────────────────────┘  └────────────────────────────────┘  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

这些特性的共同设计哲学是：**通过工具接口（Tool）暴露能力，通过权限系统控制风险，通过状态管理保持一致性。** 每个特性都不是"另起炉灶"，而是深度集成到已有的 Harness 架构中。

---

## 18.1 Plan Mode：先想清楚再动手

### 面临的问题

当用户说"给这个项目加用户认证"时，模型面临一个选择：

- **直接开始写代码？** 风险极高——可能选错了认证方案（JWT vs Session vs OAuth），可能改错了文件，可能破坏了现有架构。一旦写了几百行代码，回退成本很高。
- **先问用户所有细节？** 用户体验差——用户期望 AI 能自己探索代码库、理解架构、提出方案，而不是像填表一样逐项询问。

**核心矛盾：模型需要"探索自由"来理解问题，但又不能在探索阶段产生不可逆的副作用（写文件、执行命令）。**

### 解法：权限降级的规划阶段

Plan Mode 的核心思想是：**在模型和用户之间插入一个"规划-审批"阶段**。模型可以自由探索代码库（只读操作自动放行），但不能修改任何文件，直到用户审批了方案。

```
正常模式                          Plan Mode
┌──────────┐                    ┌──────────────────────────────┐
│ 用户提问  │                    │ 模型调用 EnterPlanMode       │
│    ↓     │                    │    ↓                         │
│ 模型思考  │                    │ 权限降级为只读               │
│    ↓     │                    │    ↓                         │
│ 直接执行  │ ←── 风险 ───→     │ 自由探索代码库               │
│ (读+写)  │                    │ (Glob/Grep/Read/Bash 自动放行)│
│    ↓     │                    │    ↓                         │
│ 返回结果  │                    │ 写方案到 plan 文件            │
└──────────┘                    │    ↓                         │
                                │ 调用 ExitPlanMode            │
                                │    ↓                         │
                                │ 用户审批方案                  │
                                │    ↓                         │
                                │ 权限恢复，开始执行            │
                                └──────────────────────────────┘
```

### 核心源码解读

**进入 Plan Mode：`EnterPlanModeTool`**

```typescript
// tools/EnterPlanModeTool/EnterPlanModeTool.ts

async call(_input, context) {
  if (context.agentId) {
    throw new Error('EnterPlanMode tool cannot be used in agent contexts')
  }

  const appState = context.getAppState()
  handlePlanModeTransition(appState.toolPermissionContext.mode, 'plan')

  // 核心：更新权限上下文，降级为 plan 模式
  context.setAppState(prev => ({
    ...prev,
    toolPermissionContext: applyPermissionUpdate(
      prepareContextForPlanMode(prev.toolPermissionContext),
      { type: 'setMode', mode: 'plan', destination: 'session' },
    ),
  }))

  return {
    data: { message: 'Entered plan mode...' },
  }
}
```

这里有两个关键调用：

1. `handlePlanModeTransition()` — 记录状态转换（用于 attachment 系统判断是否需要发送 `plan_mode_reentry` 附件）
2. `prepareContextForPlanMode()` — 真正的权限降级逻辑

**权限降级的精妙之处：`prepareContextForPlanMode()`**

```typescript
// utils/permissions/permissionSetup.ts

export function prepareContextForPlanMode(
  context: ToolPermissionContext,
): ToolPermissionContext {
  const currentMode = context.mode
  if (currentMode === 'plan') return context  // 幂等

  if (feature('TRANSCRIPT_CLASSIFIER')) {
    const planAutoMode = shouldPlanUseAutoMode()

    if (currentMode === 'auto') {
      if (planAutoMode) {
        // Auto 模式 + 用户允许 plan 期间保持 auto → 保持 auto，只记录 prePlanMode
        return { ...context, prePlanMode: 'auto' }
      }
      // Auto 模式 + 用户不允许 → 关闭 auto，恢复被剥离的危险权限
      autoModeStateModule?.setAutoModeActive(false)
      return {
        ...restoreDangerousPermissions(context),
        prePlanMode: 'auto',
      }
    }

    if (planAutoMode && currentMode !== 'bypassPermissions') {
      // 非 auto 模式 + 用户允许 plan 期间使用 auto → 激活 auto，剥离危险权限
      autoModeStateModule?.setAutoModeActive(true)
      return {
        ...stripDangerousPermissionsForAutoMode(context),
        prePlanMode: currentMode,
      }
    }
  }

  // 默认：简单记录 prePlanMode，不做额外处理
  return { ...context, prePlanMode: currentMode }
}
```

这段代码处理了四种进入 Plan Mode 的场景：

| 进入前模式 | `useAutoModeDuringPlan` | 行为 |
|-----------|------------------------|------|
| `auto` | `true` | 保持 auto，只读操作自动放行 |
| `auto` | `false` | 关闭 auto，恢复危险权限，回到逐一确认 |
| `default` | `true` | 激活 auto，剥离危险权限（如 `Bash(*)`） |
| `default` | `false` | 简单降级，只读操作需确认 |
| `bypassPermissions` | 任意 | 永远不在 plan 中激活 auto（安全兜底） |

**为什么 `bypassPermissions` 模式永远不激活 auto？** 因为 `bypassPermissions` 是最高权限模式（跳过所有确认），从它进入 plan 再激活 auto 会导致权限状态混乱——退出 plan 时应该恢复到 `bypassPermissions`，但 auto 的权限剥离逻辑会干扰恢复。

**退出 Plan Mode：`ExitPlanModeV2Tool`**

退出逻辑比进入复杂得多，因为它需要处理：
1. 从磁盘读取 plan 文件
2. 用户可能编辑了 plan（CCR Web UI 或 Ctrl+G）
3. Teammate 需要发送审批请求给 Leader
4. Auto mode 的 circuit breaker 防护
5. 权限恢复

```typescript
// tools/ExitPlanModeTool/ExitPlanModeV2Tool.ts — call() 核心逻辑

async call(input, context) {
  const filePath = getPlanFilePath(context.agentId)
  const inputPlan = 'plan' in input && typeof input.plan === 'string'
    ? input.plan : undefined
  const plan = inputPlan ?? getPlan(context.agentId)  // 从磁盘读取

  // 场景 1: Teammate 需要 Leader 审批
  if (isTeammate() && isPlanModeRequired()) {
    await writeToMailbox('team-lead', {
      from: agentName,
      text: jsonStringify(approvalRequest),
      timestamp: new Date().toISOString(),
    }, teamName)
    return { data: { plan, isAgent: true, awaitingLeaderApproval: true } }
  }

  // 场景 2: 正常退出 — 恢复权限
  context.setAppState(prev => {
    let restoreMode = prev.toolPermissionContext.prePlanMode ?? 'default'

    // Circuit breaker: 如果 prePlanMode 是 auto 但 gate 已关闭，降级到 default
    if (restoreMode === 'auto' && !isAutoModeGateEnabled()) {
      restoreMode = 'default'
    }

    // 恢复被剥离的危险权限（如果有的话）
    let baseContext = prev.toolPermissionContext
    if (restoreMode === 'auto') {
      baseContext = stripDangerousPermissionsForAutoMode(baseContext)
    } else if (prev.toolPermissionContext.strippedDangerousRules) {
      baseContext = restoreDangerousPermissions(baseContext)
    }

    return {
      ...prev,
      toolPermissionContext: {
        ...baseContext,
        mode: restoreMode,
        prePlanMode: undefined,  // 清除，表示已退出 plan
      },
    }
  })

  return { data: { plan, isAgent: false, filePath } }
}
```

### Plan 文件管理

Plan 文件存储在 `~/.claude/plans/` 目录下，文件名使用**词汇 slug**（如 `curious-elephant-42.md`）而非 UUID，这是一个有意的 UX 决策——用户在文件系统中看到 `curious-elephant-42.md` 比看到 `a1b2c3d4-e5f6.md` 更友好。

```typescript
// utils/plans.ts
export function getPlanSlug(sessionId?: SessionId): string {
  const id = sessionId ?? getSessionId()
  const cache = getPlanSlugCache()
  let slug = cache.get(id)
  if (!slug) {
    const plansDir = getPlansDirectory()
    for (let i = 0; i < MAX_SLUG_RETRIES; i++) {
      slug = generateWordSlug()
      const filePath = join(plansDir, `${slug}.md`)
      if (!getFsImplementation().existsSync(filePath)) break  // 避免冲突
    }
    cache.set(id, slug!)
  }
  return slug!
}
```

子代理有独立的 plan 文件：`{slug}-agent-{agentId}.md`，避免多个代理的 plan 互相覆盖。

### 数据流分析：Attachment 系统

Plan Mode 通过 **Attachment 系统**向模型注入上下文提醒，确保模型在 plan 模式下不会"忘记"自己的角色：

```
进入 Plan Mode
  │
  ├─ 第 1 轮: plan_mode attachment (full) — 包含完整工作流指引
  ├─ 第 2 轮: plan_mode attachment (sparse) — 简短提醒
  ├─ 第 3 轮: plan_mode attachment (sparse)
  ├─ 第 4 轮: plan_mode attachment (sparse)
  ├─ 第 5 轮: plan_mode attachment (full) — 再次完整提醒
  ├─ ...
  │
  └─ 退出 Plan Mode
       │
       └─ plan_mode_exit attachment — 通知模型已退出 plan 模式
```

这个节流策略（每 5 轮发一次完整提醒）平衡了两个需求：
- **模型需要持续知道自己在 plan 模式**（否则可能尝试写文件）
- **不能每轮都发完整指引**（浪费 token 预算）

### 设计决策讨论

**为什么 Plan 从磁盘读取而不是作为工具参数传递？**

`ExitPlanModeV2Tool` 的 `inputSchema` 没有 `plan` 字段——plan 内容从磁盘文件读取。这个设计有几个原因：

1. **Plan 可能很长**（数千字），作为工具参数会占用大量 token
2. **用户可能在 CCR Web UI 中编辑了 plan**，磁盘文件是 single source of truth
3. **模型可以分多次写入 plan 文件**（通过 FileWriteTool），最终结果在磁盘上

但这也带来了一个问题：如果模型忘记写 plan 文件就调用了 ExitPlanMode，plan 会是空的。源码通过 `mapToolResultToToolResultBlockParam` 处理了这种情况——空 plan 时返回简化的确认消息。

**为什么子代理不能使用 EnterPlanMode？**

```typescript
if (context.agentId) {
  throw new Error('EnterPlanMode tool cannot be used in agent contexts')
}
```

因为 Plan Mode 涉及**权限模式切换**和**用户交互**（审批对话框），这些都是主会话级别的操作。子代理运行在隔离的上下文中，没有直接的用户交互通道。如果子代理需要规划，应该由主会话的 Plan Agent（一种专门的子代理类型）来处理。

---

## 18.2 Worktree 隔离：让并行工作互不干扰

### 面临的问题

当 Claude Code 需要同时做多件事时，一个根本性的问题浮现：**Git 仓库的工作区是全局共享的。**

考虑这个场景：用户让模型"同时尝试两种认证方案，看哪个更好"。如果两个子代理在同一个工作区工作：
- 代理 A 修改了 `auth.ts`，代理 B 也修改了 `auth.ts` → 冲突
- 代理 A 执行 `npm install`，代理 B 也执行 `npm install` → 竞态
- 代理 A 切换到分支 `feat/jwt`，代理 B 切换到分支 `feat/session` → 灾难

**核心矛盾：Git 的单工作区模型 vs 多代理并行工作的需求。**

### 解法：Git Worktree + 状态隔离

Git 原生支持 [worktree](https://git-scm.com/docs/git-worktree)——在同一个仓库下创建多个独立的工作目录，每个目录有自己的分支和暂存区，但共享 `.git` 对象库。Claude Code 在此基础上构建了完整的生命周期管理。

```
主仓库 (origin/main)
├── .git/                          ← 共享的 Git 对象库
├── .claude/
│   └── worktrees/
│       ├── agent-a1b2c3d4/        ← 子代理 A 的隔离工作区
│       │   ├── .git (→ 指向主仓库)
│       │   ├── src/
│       │   └── ...
│       ├── agent-e5f6g7h8/        ← 子代理 B 的隔离工作区
│       │   ├── .git (→ 指向主仓库)
│       │   ├── src/
│       │   └── ...
│       └── curious-elephant-42/   ← 用户手动创建的 worktree
│           ├── .git (→ 指向主仓库)
│           └── ...
├── src/                           ← 主工作区（不受影响）
└── ...
```

### 核心源码解读

**创建 Worktree：`EnterWorktreeTool`**

```typescript
// tools/EnterWorktreeTool/EnterWorktreeTool.ts

async call(input) {
  // 1. 防止嵌套 worktree
  if (getCurrentWorktreeSession()) {
    throw new Error('Already in a worktree session')
  }

  // 2. 回到主仓库根目录（从 worktree 内创建新 worktree 需要先回到主仓库）
  const mainRepoRoot = findCanonicalGitRoot(getCwd())
  if (mainRepoRoot && mainRepoRoot !== getCwd()) {
    process.chdir(mainRepoRoot)
    setCwd(mainRepoRoot)
  }

  // 3. 创建 worktree（核心逻辑在 utils/worktree.ts）
  const slug = input.name ?? getPlanSlug()
  const worktreeSession = await createWorktreeForSession(getSessionId(), slug)

  // 4. 切换 CWD 到 worktree
  process.chdir(worktreeSession.worktreePath)
  setCwd(worktreeSession.worktreePath)
  setOriginalCwd(getCwd())

  // 5. 持久化状态（用于会话恢复）
  saveWorktreeState(worktreeSession)

  // 6. 清除所有依赖 CWD 的缓存
  clearSystemPromptSections()   // 系统提示词中的环境信息
  clearMemoryFileCaches()       // CLAUDE.md 缓存
  getPlansDirectory.cache.clear?.()  // Plan 目录缓存

  return { data: { worktreePath, worktreeBranch, message: '...' } }
}
```

第 6 步的缓存清除至关重要——如果不清除，系统提示词中的 Git 状态、CLAUDE.md 内容、Plan 文件路径都会指向旧的工作目录，导致模型在新 worktree 中工作时看到错误的上下文。

**退出 Worktree：Fail-Closed 的安全设计**

`ExitWorktreeTool` 的 `validateInput` 展示了一个教科书级的 fail-closed 设计：

```typescript
// tools/ExitWorktreeTool/ExitWorktreeTool.ts

async validateInput(input) {
  // 守卫 1: 只操作当前会话创建的 worktree
  const session = getCurrentWorktreeSession()
  if (!session) {
    return { result: false, message: 'No-op: there is no active EnterWorktree session...' }
  }

  // 守卫 2: remove 操作需要检查是否有未保存的工作
  if (input.action === 'remove' && !input.discard_changes) {
    const summary = await countWorktreeChanges(
      session.worktreePath,
      session.originalHeadCommit,
    )

    // 关键：如果无法确定状态（git 命令失败），拒绝操作
    if (summary === null) {
      return {
        result: false,
        message: 'Could not verify worktree state... Refusing to remove without explicit confirmation.',
      }
    }

    // 有未提交的文件或未合并的 commit → 拒绝
    if (changedFiles > 0 || commits > 0) {
      return {
        result: false,
        message: `Worktree has ${parts.join(' and ')}. Removing will discard this work permanently.`,
      }
    }
  }

  return { result: true }
}
```

`countWorktreeChanges` 函数的注释明确说明了 fail-closed 原则：

```typescript
/**
 * Returns null when state cannot be reliably determined — callers that use
 * this as a safety gate must treat null as "unknown, assume unsafe"
 * (fail-closed). A silent 0/0 would let cleanupWorktree destroy real work.
 */
```

当 `git status` 或 `git rev-list` 失败时（锁文件、损坏的索引、无效的 ref），函数返回 `null` 而不是 `{ changedFiles: 0, commits: 0 }`。调用方将 `null` 视为"不安全"，拒绝删除操作。这防止了一个微妙但严重的 bug：如果 Git 命令因为临时原因失败，错误地报告"没有变更"，就会导致用户的工作被永久删除。

### 数据流分析：子代理的 Worktree 隔离

用户通过 `EnterWorktreeTool` 手动创建 worktree 是一种场景，但更常见的是**子代理自动使用 worktree 隔离**。当 `AgentTool` 的 `isolation` 参数设为 `"worktree"` 时：

```
AgentTool.call({ isolation: "worktree" })
  │
  ├─ createAgentWorktree(slug)
  │   ├─ slug = "agent-${earlyAgentId.slice(0,8)}"
  │   ├─ getOrCreateWorktree()
  │   │   ├─ 快速恢复: 检查 worktree 是否已存在（读 .git 指针文件）
  │   │   ├─ 新建: fetch base branch → git worktree add -B <branch> <path> <base>
  │   │   └─ 应用 sparse-checkout（如果配置了）
  │   └─ performPostCreationSetup()
  │       ├─ 复制 settings.local.json
  │       ├─ 配置 core.hooksPath（共享 hooks）
  │       ├─ 符号链接目录（node_modules 等）
  │       └─ 安装 attribution hook
  │
  ├─ runWithCwdOverride(worktreePath, () => runAgent(...))
  │   └─ 子代理在隔离的 CWD 中运行
  │      （使用 AsyncLocalStorage，不影响主会话的 CWD）
  │
  └─ cleanupWorktreeIfNeeded()
      ├─ hasWorktreeChanges(worktreePath, headCommit)
      │   ├─ git status --porcelain（检查未提交文件）
      │   └─ git rev-list --count <headCommit>..HEAD（检查新 commit）
      ├─ 无变更 → removeAgentWorktree()（删除目录 + 分支）
      └─ 有变更 → 保留（日志记录 worktreePath）
```

关键区别：子代理的 worktree **不会修改全局状态**（不调用 `process.chdir`、不调用 `setCwd`）。它通过 `runWithCwdOverride()` 使用 `AsyncLocalStorage` 实现 CWD 覆盖——子代理的所有工具看到的 CWD 是 worktree 路径，但主会话的 CWD 不受影响。

### Post-Creation Setup：为什么需要这么多步骤？

创建 worktree 后的 `performPostCreationSetup()` 做了 5 件事，每件都有明确的理由：

| 步骤 | 原因 |
|------|------|
| 复制 `settings.local.json` | Worktree 有独立的 `.claude/` 目录，需要继承主仓库的本地设置 |
| 配置 `core.hooksPath` | Git hooks（如 husky）需要在 worktree 中也能工作 |
| 符号链接 `node_modules` 等 | 避免在每个 worktree 中重复安装依赖（节省磁盘和时间） |
| 复制 `.worktreeinclude` 文件 | 用户指定的需要在 worktree 中存在的文件 |
| 安装 attribution hook | 确保 worktree 中的 commit 也带有正确的 author 信息 |

### Slug 扁平化：一个微妙的 Git 约束

Worktree 的 slug 支持 `/` 分隔符（如 `user/feature`），但在文件系统和 Git 分支名中，`/` 会被替换为 `+`：

```
用户输入: "user/feature"
文件路径: .claude/worktrees/user+feature/
分支名:   worktree-user+feature
```

这个扁平化解决了两个问题：

1. **Git D/F 冲突**：如果分支名是 `worktree-user/feature`，而另一个分支是 `worktree-user`，Git 的 refs 系统会冲突（`refs/heads/worktree-user` 既是文件又是目录）
2. **嵌套目录问题**：如果路径是 `.claude/worktrees/user/feature/`，执行 `git worktree remove .claude/worktrees/user` 会删除整个 `user/` 目录，包括 `feature/` 子目录

### 过期清理：30 天的安全窗口

子代理的 worktree 是临时的，但如果 Claude Code 异常退出，清理逻辑不会执行。为此，有一个后台清理机制：

```typescript
// utils/cleanup.ts — 简化

cleanupStaleAgentWorktrees(cutoffDate) {
  // 只清理匹配临时模式的 worktree
  const ephemeralPatterns = [
    /^agent-a[0-9a-f]{7}$/,     // 子代理
    /^wf_[0-9a-f]{8}-/,          // 工作流
    /^bridge-/,                   // Bridge 会话
    /^job-/,                      // 模板任务
  ]

  for (const dir of worktreeDirs) {
    if (!matchesEphemeralPattern(dir)) continue  // 不碰用户命名的 worktree
    if (mtime >= cutoffDate) continue             // 30 天内不碰
    if (hasTrackedChanges(dir)) continue          // 有未提交的修改不碰
    if (hasUnpushedCommits(dir)) continue         // 有未推送的 commit 不碰

    removeAgentWorktree(dir)  // 安全删除
  }

  git worktree prune  // 清理 Git 内部的孤立条目
}
```

安全保证：
- **只清理临时模式的 worktree**——用户通过 `EnterWorktreeTool` 手动创建的 worktree 永远不会被自动清理
- **30 天保留期**——给用户足够的时间发现和恢复
- **双重安全检查**——有未提交修改或未推送 commit 的 worktree 不会被删除
- **Fail-closed**——Git 命令失败时跳过该 worktree

### 设计决策讨论

**为什么用 Git Worktree 而不是简单的目录复制？**

目录复制（`cp -r`）看似更简单，但有几个致命问题：
1. **大仓库复制耗时极长**——一个 10GB 的仓库复制需要几十秒
2. **磁盘空间翻倍**——每个副本都是完整的仓库
3. **无法共享 Git 历史**——副本之间的 commit 无法互相引用

Git Worktree 共享 `.git` 对象库，创建速度是毫秒级，磁盘开销只有工作区文件的大小。

**为什么支持 Hook-based Worktree？**

```typescript
if (hasWorktreeCreateHook()) {
  return executeWorktreeCreateHook(slug)
}
// 否则使用 git worktree
```

不是所有项目都用 Git。Perforce、Mercurial、SVN 等 VCS 也需要隔离能力。通过 Hook 机制，用户可以在 `settings.json` 中配置自定义的 worktree 创建/删除命令，让 Claude Code 的隔离能力不绑定于 Git。

**为什么 `node_modules` 用符号链接而不是复制？**

一个典型的 `node_modules` 目录可能有几百 MB 甚至几 GB。如果每个 worktree 都复制一份，磁盘很快就会被填满。符号链接让所有 worktree 共享同一份依赖，零额外开销。但这也意味着如果某个 worktree 需要不同版本的依赖，符号链接就不够了——这是一个有意的 trade-off，因为绝大多数场景下依赖是相同的。

---

## 18.3 Cron 调度：让 Claude Code 自己醒来

### 面临的问题

传统的 AI 对话是**被动的**——用户说一句，AI 回一句。但很多软件工程任务是**周期性的**：

- "每天早上 9 点检查有没有新的 PR 需要 review"
- "每 5 分钟跑一次测试，看 CI 是否恢复"
- "下午 3 点提醒我部署到生产环境"

这些任务需要 Claude Code 能够**主动唤醒**——在没有用户输入的情况下，按照预定时间执行操作。

**核心挑战：如何在一个 CLI 会话中实现可靠的定时调度，同时处理多会话协调、负载均衡、进程重启等问题？**

### 解法：进程内调度器 + 文件锁协调 + 确定性抖动

Claude Code 的 Cron 系统不依赖系统级的 crontab 或外部调度服务，而是在进程内实现了一个完整的调度器。这个决策的原因是：系统 crontab 需要额外的安装步骤和权限，而且无法与 Claude Code 的会话状态集成。

```
┌─────────────────────────────────────────────────────────┐
│                    Cron 调度架构                          │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  CronCreateTool ──→ addCronTask() ──→ 存储层            │
│                                        ├─ 持久化: .claude/scheduled_tasks.json │
│                                        └─ 会话级: bootstrap/state.ts          │
│                                                         │
│  setScheduledTasksEnabled(true) ──→ 调度器启动           │
│                                                         │
│  ┌─────────────────────────────────────────────────┐   │
│  │  cronScheduler (每 1 秒 check)                   │   │
│  │  ├─ 获取 jitter 配置 (GrowthBook)               │   │
│  │  ├─ 遍历文件任务 (仅 lock owner)                 │   │
│  │  ├─ 遍历会话任务 (所有会话)                       │   │
│  │  ├─ 计算 nextFireAt (含 jitter)                  │   │
│  │  ├─ now >= nextFireAt? → 触发!                   │   │
│  │  │   ├─ recurring → 重新调度 (从 now 开始)       │   │
│  │  │   └─ one-shot → 删除                          │   │
│  │  └─ 批量写入 lastFiredAt                         │   │
│  └─────────────────────────────────────────────────┘   │
│                                                         │
│  触发 → onFire(prompt) → 注入对话队列 → 模型执行        │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### 核心源码解读

**两层存储：持久化 vs 会话级**

```typescript
// utils/cronTasks.ts

export type CronTask = {
  id: string                    // 8 字符 hex UUID
  cron: string                  // 5 字段 cron 表达式（本地时间）
  prompt: string                // 触发时注入的 prompt
  createdAt: number             // 创建时间戳（锚点）
  lastFiredAt?: number          // 最近触发时间（用于重启后恢复）
  recurring?: boolean           // true = 循环，false = 一次性
  permanent?: boolean           // true = 永不过期（仅 assistant 模式内置任务）
  durable?: boolean             // 运行时标记：true = 持久化到文件
  agentId?: string              // 运行时标记：创建者 teammate 的 ID
}
```

为什么需要两层存储？

- **持久化任务**（`durable: true`）：写入 `.claude/scheduled_tasks.json`，进程重启后仍然存在。适用于"每天早上 9 点检查 PR"这类长期任务。
- **会话级任务**（`durable: false`，默认）：只存在于内存中，进程退出即消失。适用于"5 分钟后提醒我"这类临时任务。

这个分离避免了一个常见问题：如果所有任务都持久化，用户创建的临时提醒会在文件中越积越多，需要手动清理。

**调度器的 1 秒心跳**

```typescript
// utils/cronScheduler.ts — check() 核心循环

function check() {
  if (isKilled?.()) return           // Killswitch: GrowthBook 可远程关闭
  if (isLoading() && !assistantMode) return  // REPL 忙时不触发

  const now = Date.now()
  const jitterCfg = getJitterConfig?.() ?? DEFAULT_CRON_JITTER_CONFIG

  function process(t: CronTask, isSession: boolean) {
    if (inFlight.has(t.id)) return   // 防止重复触发

    let next = nextFireAt.get(t.id)
    if (next === undefined) {
      // 首次看到这个任务 — 计算下次触发时间
      next = t.recurring
        ? jitteredNextCronRunMs(t.cron, t.lastFiredAt ?? t.createdAt, t.id, jitterCfg)
        : oneShotJitteredNextCronRunMs(t.cron, t.createdAt, t.id, jitterCfg)
      nextFireAt.set(t.id, next ?? Infinity)
    }

    if (now < next) return  // 还没到时间

    // 触发!
    onFireTask ? onFireTask(t) : onFire(t.prompt)

    // 过期检查
    const aged = isRecurringTaskAged(t, now, jitterCfg.recurringMaxAgeMs)

    if (t.recurring && !aged) {
      // 循环任务：从 now 重新调度（不是从 next，避免快速追赶）
      const newNext = jitteredNextCronRunMs(t.cron, now, t.id, jitterCfg)
      nextFireAt.set(t.id, newNext ?? Infinity)
      if (!isSession) firedFileRecurring.push(t.id)  // 批量写入
    } else {
      // 一次性任务或过期任务：删除
      // ...
    }
  }

  // 先处理文件任务（仅 lock owner），再处理会话任务
  if (isOwner) {
    for (const t of tasks) process(t, false)
  }
  for (const t of getSessionCronTasks()) process(t, true)
}
```

这里有一个关键的设计选择：**循环任务从 `now` 重新调度，而不是从 `next`**。

为什么？假设一个每小时触发的任务，上次触发是 10:00，下次应该是 11:00。但如果 REPL 在 10:50-11:10 之间一直在执行一个长查询（`isLoading() === true`），任务在 11:10 才被检查到。如果从 `next`（11:00）重新调度，下次触发是 12:00——只隔了 50 分钟。如果从 `now`（11:10）重新调度，下次触发是 12:10——保持了约 1 小时的间隔。

### 确定性抖动：解决"整点风暴"

**问题**：如果全球数千个 Claude Code 用户都设置了"每小时检查"（`0 * * * *`），所有请求会在每个整点同时打到 Anthropic API，造成流量尖峰。

**解法**：基于任务 ID 的确定性抖动（jitter）。

```typescript
// utils/cronTasks.ts — 抖动计算

// 任务 ID 的前 8 个 hex 字符 → [0, 1) 的确定性分数
function jitterFrac(taskId: string): number {
  return parseInt(taskId.slice(0, 8), 16) / 0x1_0000_0000
}

// 循环任务：向后延迟（forward jitter）
export function jitteredNextCronRunMs(
  cron: string, fromMs: number, taskId: string, cfg: CronJitterConfig
): number | null {
  const t1 = computeNextCronRun(cron, fromMs)
  const t2 = computeNextCronRun(cron, t1)  // 下下次触发
  const interval = t2 - t1
  const jitter = Math.min(
    jitterFrac(taskId) * cfg.recurringFrac * interval,
    cfg.recurringCapMs
  )
  return t1 + jitter
}

// 一次性任务：向前提前（backward jitter），仅在整点/半点
export function oneShotJitteredNextCronRunMs(
  cron: string, fromMs: number, taskId: string, cfg: CronJitterConfig
): number | null {
  const t1 = computeNextCronRun(cron, fromMs)
  const minute = new Date(t1).getMinutes()
  if (minute % cfg.oneShotMinuteMod !== 0) return t1  // 非整点不抖动
  const lead = cfg.oneShotFloorMs +
    jitterFrac(taskId) * (cfg.oneShotMaxMs - cfg.oneShotFloorMs)
  return Math.max(t1 - lead, fromMs)  // 不能早于创建时间
}
```

为什么抖动是**确定性的**（基于任务 ID）而不是随机的？

1. **可重现**：进程重启后，同一个任务的抖动值不变，不会因为重启而改变触发时间
2. **均匀分布**：UUID 的 hex 前缀在 `[0, 2^32)` 范围内均匀分布，所以 `jitterFrac` 在 `[0, 1)` 内均匀分布
3. **可调优**：运维团队可以通过 GrowthBook 实时调整 `recurringFrac`（默认 10%）和 `recurringCapMs`（默认 15 分钟），无需重启客户端

**具体效果**：一个每小时触发的任务（interval = 3600s），抖动范围是 `[0, 360s)`，即 0-6 分钟。全球用户的触发时间从"全部在 :00"变成"均匀分布在 :00 到 :06"。

### 多会话协调：文件锁

**问题**：用户可能在同一个项目目录下打开多个 Claude Code 会话。如果每个会话都运行调度器，持久化任务会被重复触发。

**解法**：基于文件锁的 leader election。

```typescript
// utils/cronTasksLock.ts

export async function tryAcquireSchedulerLock(opts?): Promise<boolean> {
  const lockPath = join(dir, '.claude', 'scheduled_tasks.lock')
  const content = JSON.stringify({
    sessionId: lockIdentity ?? getSessionId(),
    pid: process.pid,
    acquiredAt: Date.now(),
  })

  try {
    // O_EXCL: 原子性创建，如果文件已存在则失败
    await writeFile(lockPath, content, { flag: 'wx' })
    return true  // 获取锁成功
  } catch {
    // 文件已存在 → 检查持有者是否还活着
    const existing = JSON.parse(await readFile(lockPath, 'utf-8'))
    if (!isProcessAlive(existing.pid)) {
      // 持有者已死 → 删除旧锁，重试一次
      await unlink(lockPath)
      try {
        await writeFile(lockPath, content, { flag: 'wx' })
        return true
      } catch { return false }
    }
    return false  // 持有者还活着，放弃
  }
}
```

只有获取到锁的会话（"owner"）才会处理文件任务。其他会话每 5 秒探测一次锁，如果 owner 崩溃（PID 不存在），就接管调度权。会话级任务不受锁影响——它们是进程私有的，不存在重复触发问题。

### 7 天自动过期

循环任务默认在创建 7 天后自动过期（最后触发一次，然后删除）：

```typescript
export function isRecurringTaskAged(
  t: CronTask, nowMs: number, maxAgeMs: number
): boolean {
  if (maxAgeMs === 0) return false           // 0 = 永不过期
  return Boolean(
    t.recurring && !t.permanent &&           // permanent 任务豁免
    nowMs - t.createdAt >= maxAgeMs          // 超过最大年龄
  )
}
```

为什么需要自动过期？源码注释揭示了原因：

> Cron is primary driver of multi-day sessions (p99 uptime 61min → 53h post-#19931). Unbounded recurrence lets heap leaks compound indefinitely.

Cron 任务是导致 Claude Code 会话长时间运行的主要原因。如果循环任务永不过期，内存泄漏会随时间累积。7 天的限制是一个务实的选择——足够覆盖大多数使用场景，同时防止资源泄漏。

`permanent` 标记是一个逃生舱口，仅供 assistant 模式的内置任务使用（如每日签到、晨间检查），不通过 `CronCreateTool` 暴露给用户。

### 设计决策讨论

**为什么不用系统 crontab？**

1. **跨平台问题**：macOS、Linux、Windows 的定时任务机制完全不同
2. **权限问题**：修改系统 crontab 需要额外权限，用户可能不愿意授予
3. **状态集成**：系统 crontab 触发的命令无法访问 Claude Code 的会话状态（消息历史、工具上下文等）
4. **生命周期管理**：系统 crontab 的任务在 Claude Code 退出后仍然存在，需要额外的清理逻辑

进程内调度器虽然在进程退出后就停止了，但这恰恰是大多数场景下期望的行为——"每 5 分钟跑一次测试"这个需求只在当前工作会话中有意义。

**为什么 `isLoading` 时不触发？**

```typescript
if (isLoading() && !assistantMode) return
```

当 REPL 正在处理用户查询时，触发 cron 任务会导致两个问题：
1. **上下文污染**：cron 的 prompt 会被注入到正在进行的对话中，干扰当前任务
2. **资源竞争**：同时运行两个查询会竞争 API 配额和 token 预算

所以调度器在 REPL 忙时推迟触发，等到空闲时再执行。Assistant 模式例外——它的工作模式就是"空闲 → 触发 → 执行 → 空闲"的循环，如果等待 `isLoading` 会导致死锁。

---

## 18.4 语音输入：用说的比用打的快

### 面临的问题

描述一个复杂的编程需求，打字可能需要 2-3 分钟，说话只需要 20-30 秒。对于 Claude Code 这样的对话式工具，输入速度直接影响工作效率。

但在终端中实现语音输入面临独特的挑战：
1. **没有浏览器的 Web Audio API**——需要直接访问系统麦克风
2. **终端没有"录音按钮"**——需要用键盘快捷键控制录音
3. **网络延迟**——语音转文字需要实时流式处理，否则用户说完后要等几秒才能看到文字
4. **按键冲突**——用空格键触发录音，但空格也是正常的输入字符

### 解法：Native 音频捕获 + WebSocket 流式 STT + Hold-to-Talk

```
用户按住空格键
     │
     ▼
┌─────────────────────────────────────────────────┐
│  音频捕获层                                       │
│  ├─ 首选: audio-capture-napi (Rust/CPAL)         │
│  ├─ 备选: arecord (Linux ALSA)                   │
│  └─ 备选: SoX rec (macOS/Linux)                  │
│  格式: 16kHz, mono, 16-bit PCM                   │
└──────────────────┬──────────────────────────────┘
                   │ 音频块 (每 ~1 秒合并为 32KB)
                   ▼
┌─────────────────────────────────────────────────┐
│  WebSocket 流式传输                               │
│  端点: /api/ws/speech_to_text/voice_stream       │
│  认证: OAuth Bearer Token                        │
│  协议:                                           │
│  ├─ 客户端 → 服务端: 二进制音频帧 / KeepAlive    │
│  └─ 服务端 → 客户端: TranscriptText / Endpoint   │
└──────────────────┬──────────────────────────────┘
                   │ 实时转录文本
                   ▼
┌─────────────────────────────────────────────────┐
│  文本注入                                         │
│  ├─ 临时转录 (isFinal=false): 灰色预览显示       │
│  └─ 最终转录 (isFinal=true): 注入输入框          │
└─────────────────────────────────────────────────┘
                   │
                   ▼
              用户松开空格键 → 提交文本
```

### 核心源码解读

**WebSocket 流式 STT 客户端**

```typescript
// services/voiceStreamSTT.ts

const VOICE_STREAM_PATH = '/api/ws/speech_to_text/voice_stream'
const KEEPALIVE_INTERVAL_MS = 8_000

export type VoiceStreamConnection = {
  send: (audioChunk: Buffer) => void        // 发送音频块
  finalize: () => Promise<FinalizeSource>   // 结束录音，等待最终转录
  close: () => void                          // 关闭连接
  isConnected: () => boolean
}

export type VoiceStreamCallbacks = {
  onTranscript: (text: string, isFinal: boolean) => void  // 转录回调
  onError: (error: string, opts?: { fatal?: boolean }) => void
  onClose: () => void
  onReady: (connection: VoiceStreamConnection) => void
}
```

语音系统使用 Anthropic 自有的 `voice_stream` WebSocket 端点，底层由 Deepgram STT 引擎驱动。协议设计很简洁：

- **客户端 → 服务端**：二进制音频帧（PCM 数据）+ JSON 控制消息（`KeepAlive`、`CloseStream`）
- **服务端 → 客户端**：`TranscriptText`（含 `isFinal` 标记）+ `TranscriptEndpoint`（语句结束标记）

**Hold-to-Talk 的按键检测难题**

终端环境下检测"按住"和"松开"是一个非平凡的问题——终端只能收到 keypress 事件，没有 keyup 事件。Claude Code 的解法是利用**操作系统的按键重复机制**：

```
按住空格键时的事件流:
  t=0ms    keypress(space)  ← 第一次按下
  t=500ms  keypress(space)  ← 系统重复延迟后的第一次重复
  t=530ms  keypress(space)  ← 后续重复（间隔 ~30ms）
  t=560ms  keypress(space)
  ...
  t=1200ms (无事件)          ← 松开！200ms 无事件 = 判定为松开
```

关键参数：
- **200ms 间隔**：如果两次 keypress 之间超过 200ms，判定为松开
- **5 次预热**：裸字符（如空格）需要连续快速按 5 次才激活录音，避免误触
- **修饰键组合**（如 `Meta+K`）：首次按下即激活，因为意图明确

**Silent-Drop 检测与重放**

源码中有一个有趣的容错机制——约 1% 的会话会遇到"静默丢弃"问题：WebSocket 连接正常，音频正常发送，但服务端不返回任何转录结果。

```typescript
// 检测: CloseStream 发送后 1.5 秒内没有收到任何数据
FINALIZE_TIMEOUTS_MS = {
  noData: 1_500,    // 静默丢弃检测
  safety: 5_000,    // 最终安全超时
}
```

检测到静默丢弃后，客户端会：
1. 关闭当前 WebSocket
2. 建立新连接
3. 将缓冲的全部音频数据重新发送（最多 ~2MB，约 60 秒音频）

这个机制对用户完全透明——用户只会感觉到转录稍微慢了一点，而不是完全没有结果。

### 设计决策讨论

**为什么音频在 WebSocket 连接建立前就开始捕获？**

WebSocket 连接建立需要 1-2 秒（TCP + TLS + 认证）。如果等连接就绪才开始录音，用户按下空格后会有明显的延迟。Claude Code 的做法是：**按下空格立即开始录音，音频块缓冲在内存中，连接就绪后一次性发送缓冲的音频，然后切换到实时流式发送。**

这消除了用户感知到的启动延迟——按下空格的瞬间就开始录音，不需要等待网络。

**为什么用 Native Module 而不是 FFmpeg/SoX？**

首选的 `audio-capture-napi` 是一个 Rust 编写的 Node.js Native Module（基于 CPAL 库）。相比 SoX 等外部进程：
1. **无需安装额外软件**——Native Module 随 Claude Code 分发
2. **更低的延迟**——进程内直接访问音频设备，无需 IPC
3. **更好的错误处理**——可以直接获取 TCC 权限状态（macOS）

SoX 和 arecord 作为备选方案保留，用于 Native Module 不可用的环境。

---

## 18.5 后台会话：长任务不应阻塞用户

### 面临的问题

一个大型重构任务可能需要 10-30 分钟。在这段时间里，用户只能盯着终端看模型一步步执行，无法做其他事情。这在交互式工具中是不可接受的——用户应该能够把长任务"扔到后台"，然后继续提新的问题。

但"后台执行"在终端环境中比在 GUI 中困难得多：
1. **终端是单线程的**——一个 REPL 同时只能处理一个对话
2. **进程退出 = 任务丢失**——如果用户关闭终端，后台任务也会被杀死
3. **输出需要持久化**——后台任务的输出不能只存在内存中，需要能在之后查看

### 解法：Ctrl+B 前台/后台切换 + 任务状态机 + 磁盘输出持久化

Claude Code 的后台会话系统有两个层次：

1. **任务级后台化**：把当前正在执行的 Shell 命令或子代理"推到后台"，用户可以继续在同一个 REPL 中提新问题
2. **会话级后台化**：把整个 Claude Code 会话推到 tmux 中，用户可以关闭终端，之后通过 `claude attach` 重新连接

```
用户正在等待长任务执行...
     │
     │  按下 Ctrl+B
     ▼
┌─────────────────────────────────────────────┐
│  有前台任务?                                  │
│  ├─ YES → backgroundAll()                    │
│  │   ├─ 任务标记为 isBackgrounded = true     │
│  │   ├─ 输出从内存 spill 到磁盘              │
│  │   ├─ UI 清空，用户获得新的输入提示符       │
│  │   └─ 任务在后台继续执行                    │
│  │                                           │
│  └─ NO → onBackgroundQuery()                 │
│      └─ 整个查询推到后台任务                  │
└─────────────────────────────────────────────┘
     │
     │  之后...
     ▼
┌─────────────────────────────────────────────┐
│  查看后台任务:                                │
│  ├─ TaskOutputTool → 读取磁盘输出            │
│  ├─ TaskStopTool → 终止后台任务              │
│  └─ 前台化 → 将后台任务的消息同步到主视图     │
└─────────────────────────────────────────────┘
```

### 核心源码解读

**Ctrl+B 的双击检测**

```typescript
// components/SessionBackgroundHint.tsx — 简化

// 双击模式：第一次按 Ctrl+B 显示提示，800ms 内再按一次才执行
// 这防止了误触——Ctrl+B 在 tmux 中是前缀键，用户可能只是想操作 tmux
```

在 tmux 环境中，`Ctrl+B` 是 tmux 的默认前缀键。为了避免冲突，Claude Code 要求用户按 `Ctrl+B Ctrl+B`（两次）才能触发后台化。第一次按下显示提示信息，800ms 内第二次按下才执行。

**任务后台化的核心：输出 Spill**

当一个前台任务被推到后台时，最关键的操作是**将内存中的输出缓冲区写入磁盘**：

```typescript
// utils/ShellCommand.ts — background() 方法

background(taskId) {
  // 1. 状态转换
  this.status = 'backgrounded'

  // 2. 清理监听器（不再向 UI 推送输出）
  this.cleanupListeners()

  // 3. 如果是 pipe 模式：将内存缓冲区 spill 到磁盘
  if (this.mode === 'pipe') {
    this.spillToDisk()
  }

  // 4. 如果是 file 模式：启动大小看门狗
  if (this.mode === 'file') {
    this.startSizeWatchdog()  // 防止磁盘被填满
  }

  return true
}
```

`spillToDisk()` 将内存中积累的输出写入 `~/.claude/tasks/{taskId}.output` 文件。之后的输出直接追加到文件，不再经过内存缓冲。这确保了即使任务运行很长时间，内存占用也不会持续增长。

大小看门狗（size watchdog）是一个安全机制——源码注释提到了一个真实的事故：一个后台任务的输出文件增长到 768GB，填满了磁盘。看门狗会定期检查文件大小，超过阈值时截断输出。

**会话注册与 `claude ps`**

每个 Claude Code 会话在启动时注册到 `~/.claude/sessions/` 目录：

```typescript
// utils/concurrentSessions.ts

export async function registerSession(): Promise<boolean> {
  if (getAgentId() != null) return false  // 子代理不注册

  const kind: SessionKind = envSessionKind() ?? 'interactive'
  const pidFile = join(sessionsDir, `${process.pid}.json`)

  await writeFile(pidFile, JSON.stringify({
    pid: process.pid,
    sessionId: getSessionId(),
    cwd: getOriginalCwd(),
    startedAt: Date.now(),
    kind,  // 'interactive' | 'bg' | 'daemon' | 'daemon-worker'
    name: sessionName,
    logPath: logFilePath,
  }))

  // 进程退出时清理 PID 文件
  registerCleanup(async () => { await unlink(pidFile) })
}
```

`claude ps` 命令扫描这个目录，检查每个 PID 文件对应的进程是否还活着（通过 `kill(pid, 0)` 信号探测），然后展示活跃会话列表。

**后台会话的折叠通知**

当多个后台 Shell 命令完成时，UI 不会逐一显示通知，而是折叠为一条：

```typescript
// utils/collapseBackgroundBashNotifications.ts

// 连续的已完成后台 bash 通知折叠为:
// "N background commands completed"
// 失败/被杀死的任务保持单独显示
```

这是一个 UX 细节——如果用户后台化了 10 个测试命令，不应该在回到前台时看到 10 条通知刷屏。

### 设计决策讨论

**为什么不用操作系统的 job control（`bg`/`fg`）？**

Unix 的 job control 是进程级的——它可以把整个 Claude Code 进程推到后台。但 Claude Code 需要的是**任务级**的后台化——一个 REPL 中可能同时有多个后台任务，用户可以选择性地查看或终止某一个。操作系统的 job control 粒度太粗，无法满足这个需求。

**为什么后台任务的输出写磁盘而不是保持在内存？**

1. **内存限制**：一个长时间运行的编译任务可能产生几十 MB 的输出，保持在内存中会导致 OOM
2. **进程重启**：如果 Claude Code 崩溃重启，磁盘上的输出仍然可以恢复
3. **多会话访问**：`claude logs` 命令可以从另一个终端查看后台会话的输出，这需要输出在磁盘上

---

## 18.6 Teleport：本地与远程的无缝切换

### 面临的问题

开发者的工作场景经常跨越多个环境：
- 在本地笔记本上探索代码、理解需求
- 把实际的编码任务交给云端的 CCR（Claude Code Remote）执行——云端有更强的算力、更快的网络、更大的磁盘
- 在另一台机器上继续之前的工作

**核心挑战：如何在不同环境之间迁移一个"正在进行的"编程会话，包括对话历史、Git 状态、未提交的修改？**

### 解法：会话日志序列化 + Git Bundle 状态快照

Teleport 提供两个方向的迁移：

```
┌──────────────────┐                    ┌──────────────────┐
│   本地 Claude     │   teleportToRemote │   CCR 远程       │
│                  │ ──────────────────→ │                  │
│  • 对话历史      │   1. 检测 Git 仓库  │  • 创建新会话    │
│  • Git 状态      │   2. 创建 Git Bundle│  • 克隆 Bundle   │
│  • 未提交修改    │   3. 上传到 Files API│  • 恢复对话上下文│
│                  │   4. 创建远程会话   │                  │
│                  │                    │                  │
│                  │ ←────────────────── │                  │
│  • 恢复对话历史  │  teleportResume     │  • 会话日志      │
│  • 检出远程分支  │   1. 获取会话日志   │  • Git 分支      │
│  • 继续工作      │   2. 反序列化消息   │  • 执行结果      │
└──────────────────┘   3. 检出分支       └──────────────────┘
```

### 核心源码解读

**Teleport to Remote：源选择阶梯**

将本地会话迁移到远程时，最关键的问题是：**如何把本地的代码状态传递给远程环境？**

源码实现了一个三级降级策略：

```typescript
// utils/teleport.tsx — teleportToRemote() 简化

async function teleportToRemote(prompt, options) {
  const repo = detectCurrentRepositoryWithHost()

  // 阶梯 1: GitHub 直连
  // 如果 CCR 有 GitHub App 权限，直接从 GitHub 克隆
  if (repo && await checkGithubAppInstalled(repo)) {
    source = { type: 'git_repository', url: repo.url }
  }

  // 阶梯 2: Git Bundle
  // 如果没有 GitHub 权限，创建 Git Bundle 上传
  else if (repo) {
    const bundle = await createAndUploadGitBundle(apiConfig, signal)
    if (bundle.success) {
      source = { type: 'git_repository', url: repo.url }
      seedBundleFileId = bundle.fileId
    }
  }

  // 阶梯 3: 空沙箱
  // 如果不在 Git 仓库中，创建空的远程环境
  else {
    source = null  // empty sandbox
  }

  // 创建远程会话
  const session = await createSession({
    sources: source ? [source] : [],
    seed_bundle_file_id: seedBundleFileId,
    environment_variables: { ANTHROPIC_AUTH_TOKEN: oauthToken },
  })
}
```

**Git Bundle：状态快照的三级降级**

Git Bundle 是 Git 原生的仓库打包格式。Claude Code 的 Bundle 创建也有三级降级：

```typescript
// utils/teleport/gitBundle.ts

async function _bundleWithFallback(gitRoot, bundlePath, maxBytes, hasStash) {
  // 级别 1: --all（完整历史，所有分支和标签）
  const allResult = await mkBundle('--all')
  if (allResult.code === 0 && size <= maxBytes) {
    return { scope: 'all' }
  }

  // 级别 2: HEAD（仅当前分支历史）
  const headResult = await mkBundle('HEAD')
  if (headResult.code === 0 && size <= maxBytes) {
    return { scope: 'head' }
  }

  // 级别 3: squashed-root（单个无父 commit，仅快照）
  // 创建一个包含当前工作树（含未提交修改）的单 commit
  return { scope: 'squashed' }
}
```

默认最大 Bundle 大小是 100MB。对于大型仓库，`--all` 可能超过这个限制，所以降级到只打包当前分支（`HEAD`），再降级到只打包当前快照（`squashed`）。

**WIP（Work In Progress）处理**

未提交的修改通过 `git stash create` 捕获：

```
1. git stash create → 创建一个 stash commit（不影响工作区）
2. git update-ref refs/seed/stash <stash-sha> → 让 stash 可被 bundle 引用
3. git bundle create ... refs/seed/stash → 打包时包含 stash
4. git update-ref -d refs/seed/stash → 清理临时 ref
```

这个流程的巧妙之处在于：`git stash create` 不会修改工作区或暂存区（与 `git stash push` 不同），所以用户的本地状态完全不受影响。

**Teleport Resume：从远程恢复**

```typescript
// utils/teleport.tsx — teleportResumeCodeSession() 简化

async function teleportResumeCodeSession(sessionId, onProgress) {
  // 1. 获取会话元数据
  const session = await fetchSession(sessionId)

  // 2. 验证仓库匹配（防止跨仓库恢复）
  validateRepositoryMatch(session, localRepo)

  // 3. 获取会话日志（对话历史）
  const events = await getTeleportEvents(sessionId)
  const messages = deserializeMessages(events)
    .filter(isTranscriptMessage)  // 过滤掉 sidechain 消息

  // 4. 提取远程分支名
  const branchName = getBranchFromSession(session)

  // 5. 检出远程分支
  await execFileNoThrow('git', ['fetch', 'origin', branchName])
  await execFileNoThrow('git', ['checkout', '-B', branchName, `origin/${branchName}`])

  return { messages, branchName }
}
```

仓库匹配验证是一个安全措施——防止用户在仓库 A 中恢复仓库 B 的会话，这会导致文件路径不匹配、Git 操作失败等问题。

### 设计决策讨论

**为什么用 Git Bundle 而不是直接推送到远程仓库？**

1. **权限问题**：用户可能没有远程仓库的推送权限，或者不想把未完成的工作推送到远程
2. **隐私问题**：未提交的修改可能包含敏感信息（API key、临时调试代码），不应该出现在 Git 历史中
3. **速度问题**：Git Bundle 是一个本地操作 + 一次文件上传，比 `git push` + `git clone` 更快

**为什么需要会话标题和分支名的 AI 生成？**

```typescript
const SESSION_TITLE_AND_BRANCH_PROMPT = `You are coming up with a succinct title
and git branch name for a coding session based on the provided description...`
```

Teleport 使用 Haiku（Claude 3.5 Haiku）为远程会话生成标题和分支名。这不是必需的——可以用时间戳或随机字符串。但好的命名让用户在 `claude ps` 或 Git 分支列表中能快速识别每个会话的用途，这是一个 UX 优化。

---

## 18.7 Swarm：多代理协作

### 面临的问题

一个大型重构任务——比如"把整个项目从 JavaScript 迁移到 TypeScript"——涉及几十个文件的修改。单个 Claude Code 代理串行处理需要很长时间。如果能让多个代理**分工并行**——一个改前端组件、一个改后端路由、一个写类型定义——效率会大幅提升。

但多代理协作面临几个核心挑战：
1. **执行隔离**：多个代理不能在同一个工作区互相踩踏（这就是 Worktree 解决的问题）
2. **权限协调**：Teammate 需要执行危险操作时，谁来审批？
3. **通信机制**：代理之间如何传递消息和状态？
4. **可视化**：用户如何看到多个代理的工作进度？

### 解法：Leader-Teammate 架构 + 文件邮箱 + 终端面板

```
┌─────────────────────────────────────────────────────────────┐
│  Tmux / iTerm2 窗口                                          │
├──────────────────────┬──────────────────────────────────────┤
│                      │                                      │
│  Leader (30%)        │  Teammates (70%)                     │
│  ┌────────────────┐  │  ┌────────────────┐ ┌─────────────┐ │
│  │ 主 Claude Code │  │  │ Teammate A     │ │ Teammate B  │ │
│  │                │  │  │ (前端重构)      │ │ (后端重构)   │ │
│  │ • 分配任务     │  │  │                │ │             │ │
│  │ • 审批权限     │  │  │ • 独立 worktree│ │ • 独立      │ │
│  │ • 汇总结果     │  │  │ • 独立对话     │ │   worktree  │ │
│  │                │  │  │ • 通过邮箱通信 │ │ • 独立对话  │ │
│  └────────────────┘  │  └────────────────┘ └─────────────┘ │
│                      │                                      │
└──────────────────────┴──────────────────────────────────────┘
```

### 核心源码解读

**三种执行后端**

Swarm 系统支持三种后端，通过自动检测选择最佳方案：

```typescript
// utils/swarm/backends/registry.ts — 检测优先级

// 1. 已在 tmux 内? → 使用 tmux（分割当前窗口）
if (isInsideTmux()) return 'tmux'

// 2. 在 iTerm2 中且有 it2 CLI? → 使用 iTerm2 原生面板
if (isInITerm2() && isIt2CliAvailable()) return 'iterm2'

// 3. 在 iTerm2 但没有 it2? → 降级到 tmux（如果可用）
if (isInITerm2() && isTmuxAvailable()) return 'tmux'

// 4. tmux 可用? → 使用 tmux（创建外部会话）
if (isTmuxAvailable()) return 'tmux'

// 5. 非交互模式（-p 模式）? → 使用进程内后端
if (isNonInteractiveSession()) return 'in_process'

// 6. 都不可用 → 报错，提示安装 tmux
```

| 后端 | 隔离方式 | 可视化 | 适用场景 |
|------|---------|--------|---------|
| Tmux | 独立 tmux pane | 可见的终端面板 | 大多数场景 |
| iTerm2 | 原生 split pane | 原生面板分割 | macOS + iTerm2 |
| In-Process | AsyncLocalStorage | 无可视化 | `-p` 非交互模式 |

**Teammate 生成：一个完整的 Claude Code 实例**

每个 Teammate 不是一个轻量级的"线程"，而是一个**完整的 Claude Code 进程**：

```bash
# Teammate 的启动命令（由 Leader 生成）
env CLAUDECODE=1 CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 \
  claude --agent-id researcher@my-team \
         --agent-name researcher \
         --team-name my-team \
         --agent-color blue \
         --parent-session-id <uuid> \
         --model <inherited-model> \
         --permission-mode <inherited-mode>
```

这意味着每个 Teammate 有自己的：
- 完整的工具集（Bash、FileEdit、Grep 等）
- 独立的对话历史
- 独立的 Worktree（文件系统隔离）
- 独立的权限上下文

**文件邮箱：代理间通信**

代理之间通过文件系统邮箱通信，而不是 IPC 或网络：

```
~/.claude/teams/{team-name}/
├── config.json                    # 团队配置（成员列表、状态）
└── mailbox/
    ├── team-lead/                 # Leader 的收件箱
    │   ├── msg-001.json           # Teammate 发来的消息
    │   └── msg-002.json           # 权限请求
    ├── researcher/                # Teammate A 的收件箱
    │   └── msg-003.json           # Leader 的回复
    └── implementer/               # Teammate B 的收件箱
        └── msg-004.json           # Leader 的任务分配
```

为什么用文件而不是 IPC？
1. **跨进程**：Teammate 是独立进程，IPC 需要额外的连接管理
2. **持久化**：文件在进程崩溃后仍然存在，可以恢复
3. **可调试**：开发者可以直接查看邮箱文件来调试通信问题
4. **简单**：不需要实现消息队列或 pub/sub 系统

**权限同步：Leader 代理审批**

当 Teammate 需要执行危险操作（如写文件、运行命令）时，权限请求通过邮箱路由到 Leader：

```typescript
// utils/swarm/permissionSync.ts — 权限同步流程

// Teammate 侧：
// 1. 遇到需要权限的工具调用
// 2. 创建权限请求消息
const request = {
  id: requestId,
  workerId: agentId,
  workerName: agentName,
  toolName: 'Bash',
  description: 'Run npm test',
  input: { command: 'npm test' },
  status: 'pending',
}
// 3. 写入 Leader 的邮箱
await writeToMailbox('team-lead', request, teamName)
// 4. 轮询自己的邮箱等待响应...

// Leader 侧：
// 1. 检测到邮箱中有权限请求
// 2. 在 Leader 的 UI 中显示权限对话框
// 3. 用户审批/拒绝
// 4. 将响应写入 Teammate 的邮箱
await writeToMailbox(workerName, response, teamName)
```

这个设计确保了**所有危险操作都经过用户审批**，即使操作是由 Teammate 发起的。用户只需要在 Leader 的终端面板中操作，不需要在多个面板之间切换。

### 数据流分析：Swarm 的完整生命周期

```
1. 用户请求: "把项目迁移到 TypeScript"
   │
2. Leader 分析任务，决定创建团队
   │  调用 TeamCreateTool
   │
3. 检测后端 (tmux/iTerm2/in-process)
   │
4. 为每个 Teammate 创建:
   │  ├─ Tmux pane (或 iTerm2 pane)
   │  ├─ Git Worktree (文件隔离)
   │  ├─ 邮箱目录
   │  └─ 启动 Claude Code 进程
   │
5. Leader 通过邮箱分配任务:
   │  ├─ researcher: "分析项目结构，列出需要迁移的文件"
   │  └─ implementer: "等待 researcher 的分析结果"
   │
6. Teammates 独立工作:
   │  ├─ 读写自己的 Worktree
   │  ├─ 需要权限时 → 发送请求到 Leader 邮箱
   │  └─ 完成时 → 发送 idle 通知
   │
7. Leader 汇总结果:
   │  ├─ 检查每个 Teammate 的 Worktree
   │  ├─ 合并分支
   │  └─ 向用户报告
   │
8. 清理:
   ├─ 终止所有 Teammate 进程
   ├─ 删除团队目录
   └─ 清理 Worktree（如果无变更）
```

### 设计决策讨论

**为什么每个 Teammate 是独立进程而不是线程/协程？**

1. **完全隔离**：独立进程有独立的内存空间、环境变量、CWD，不会互相干扰
2. **容错性**：一个 Teammate 崩溃不会影响其他 Teammate 或 Leader
3. **可视化**：独立进程可以有独立的终端面板，用户可以实时看到每个 Teammate 的工作
4. **复用现有架构**：每个 Teammate 就是一个标准的 Claude Code 实例，不需要为多代理场景重写任何工具

代价是更高的资源开销（每个 Teammate 是一个完整的 Node.js 进程），但对于需要多代理协作的复杂任务来说，这个代价是值得的。

**为什么 In-Process 后端使用 AsyncLocalStorage？**

在 `-p`（非交互）模式下，没有终端面板可以显示 Teammate。此时使用 In-Process 后端——所有 Teammate 在同一个 Node.js 进程中运行，通过 `AsyncLocalStorage` 实现上下文隔离。

`AsyncLocalStorage` 是 Node.js 的异步上下文传播机制——每个异步调用链可以有自己的"本地存储"，类似于线程的 ThreadLocal。这让每个 Teammate 看到不同的 CWD、不同的 Agent ID，即使它们共享同一个进程。

优势是共享 API 客户端和 MCP 连接（减少资源开销），劣势是没有可视化（用户看不到 Teammate 的实时输出）。

---

## 18.8 Computer Use：让 Claude 操作你的屏幕

### 面临的问题

有些任务无法通过命令行完成：
- "帮我测试这个 Web 应用的登录流程"——需要打开浏览器、填写表单、点击按钮
- "把这个设计稿中的颜色值提取出来"——需要查看图片、使用取色器
- "帮我在 Figma 中调整这个组件的间距"——需要操作 GUI 应用

这些任务需要 Claude Code 能够**看到屏幕**和**操作键鼠**——从 CLI 工具跨越到 GUI 交互。

**核心挑战：如何在终端应用中安全地实现屏幕交互，同时处理权限控制、坐标映射、应用管理等复杂问题？**

### 解法：MCP Server + Native Module + 审批对话框

Computer Use 不是直接内置在 Claude Code 中的工具，而是通过 **MCP Server** 暴露——这意味着它使用与外部 MCP 工具相同的集成机制，但运行在进程内。

```
┌─────────────────────────────────────────────────────────────┐
│  Claude Code 主进程                                          │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  Computer Use MCP Server (进程内)                     │   │
│  │  ├─ 工具: screenshot, click, type, key, scroll, ... │   │
│  │  ├─ 权限: ComputerUseApproval 审批对话框             │   │
│  │  └─ 调度: wrapper.tsx → bindSessionContext           │   │
│  └──────────────────┬──────────────────────────────────┘   │
│                     │                                       │
│  ┌──────────────────┴──────────────────────────────────┐   │
│  │  Native Modules                                      │   │
│  │  ├─ @ant/computer-use-input (Rust/enigo)             │   │
│  │  │   └─ 鼠标移动/点击、键盘输入、前台应用检测         │   │
│  │  └─ @ant/computer-use-swift (Swift)                  │   │
│  │      └─ 屏幕截图(SCContentFilter)、应用枚举、TCC权限  │   │
│  └─────────────────────────────────────────────────────┘   │
│                     │                                       │
│                     ▼                                       │
│              macOS 系统 API                                  │
│              (Accessibility / Screen Recording 权限)         │
└─────────────────────────────────────────────────────────────┘
```

### 核心源码解读

**两个 Native Module 的分工**

```typescript
// utils/computerUse/executor.ts

// Rust 模块：输入控制（鼠标 + 键盘）
// 延迟加载——纯截图流程不需要它
import { requireComputerUseInput } from './inputLoader.js'

// Swift 模块：屏幕捕获 + 应用管理
// 使用 macOS 原生 API（SCContentFilter, NSWorkspace）
import { requireComputerUseSwift } from './swiftLoader.js'
```

为什么用两个独立的 Native Module？因为它们使用不同的技术栈：
- **输入控制**用 Rust（enigo 库）——跨平台，性能好
- **屏幕捕获**用 Swift——必须使用 macOS 原生的 `ScreenCaptureKit` API，这是 Apple 要求的

**截图：排除终端窗口**

截图时需要排除 Claude Code 自己的终端窗口，否则截图中会包含 Claude Code 的 UI，干扰模型的理解。

```typescript
// utils/computerUse/common.ts

// 检测当前终端的 Bundle ID
function getTerminalBundleId(): string | undefined {
  // 优先从环境变量获取
  const envId = process.env.__CFBundleIdentifier
  if (envId) return envId

  // 备选：已知终端的映射表
  const TERMINAL_BUNDLE_ID_FALLBACK = {
    'iTerm.app': 'com.googlecode.iterm2',
    'Terminal.app': 'com.apple.Terminal',
    'Ghostty': 'com.mitchellh.ghostty',
    'kitty': 'net.kovidgoyal.kitty',
    'WarpTerminal': 'dev.warp.Warp-Stable',
    'Code': 'com.microsoft.VSCode',
  }
}
```

终端的 Bundle ID 传递给 Swift 模块的 `captureExcluding`，截图时会跳过这个窗口。

**坐标映射：三层转换**

屏幕坐标在三个坐标系之间转换：

```typescript
// 逻辑坐标 → 物理坐标 → API 目标坐标
function computeTargetDims(
  logicalW: number,    // 如 1440（macOS 逻辑分辨率）
  logicalH: number,    // 如 900
  scaleFactor: number, // 如 2（Retina 显示器）
): [number, number] {
  const physW = Math.round(logicalW * scaleFactor)  // 2880
  const physH = Math.round(logicalH * scaleFactor)  // 1800
  return targetImageSize(physW, physH, API_RESIZE_PARAMS)  // API 期望的尺寸
}
```

模型看到的截图尺寸与实际屏幕尺寸不同（截图会被缩放以适应 API 的 token 预算）。当模型返回点击坐标时，需要反向映射回实际屏幕坐标。

**鼠标操作：动画拖拽**

拖拽操作不是简单的"从 A 点瞬移到 B 点"，而是有动画效果：

```typescript
// executor.ts — drag 操作

// ease-out-cubic 缓动函数，60fps，速度 2000px/s，最大 0.5s
// 这让拖拽看起来更自然，也给目标应用足够的时间响应
```

为什么需要动画？因为很多 GUI 应用（如 Figma、浏览器的拖放）依赖鼠标移动事件的连续性来触发拖拽行为。如果瞬间从 A 跳到 B，应用可能不会识别为拖拽操作。

**键盘输入：剪贴板辅助**

对于长文本输入，逐字符键入太慢（每个字符 8ms 延迟）。Claude Code 使用剪贴板辅助输入：

```typescript
// 长文本输入流程:
// 1. 保存当前剪贴板内容
// 2. 将目标文本写入剪贴板 (pbcopy)
// 3. 验证剪贴板内容（读回确认）
// 4. 模拟 Cmd+V 粘贴
// 5. 等待 100ms（让应用处理粘贴）
// 6. 恢复原始剪贴板内容（在 finally 块中，确保异常时也恢复）
```

剪贴板验证（步骤 3）是一个防御性措施——某些情况下 `pbcopy` 可能静默失败，如果不验证就粘贴，会粘贴出错误的内容。

**Pre-Action 安全措施**

每次操作前，executor 会执行一系列安全准备：

```typescript
// prepareForAction():
// 1. 隐藏不在允许列表中的应用（防止误操作）
// 2. 取消当前前台应用的焦点（防止意外输入）
// 3. 排空 CFRunLoop（等待窗口管理器事件处理完毕）
```

操作完成后（`cleanupComputerUseAfterTurn`）：
- 恢复被隐藏的应用
- 释放文件锁（防止并发 CU 会话）
- 注销 Escape 热键
- 发送 OS 通知："Claude is done using your computer"

### 权限模型

Computer Use 有自己的审批对话框（`ComputerUseApproval`），独立于普通工具的权限系统：

```typescript
// wrapper.tsx — 权限请求

onPermissionRequest: async (req: CuPermissionRequest) => {
  // 显示审批对话框，包含:
  // - 要操作的应用列表
  // - 请求的权限（剪贴板读/写、系统快捷键）
  // 用户可以选择允许哪些应用
  // 审批结果持久化到 AppState
}
```

用户需要明确批准 Claude 可以操作哪些应用。这不是一次性的"允许所有"——每个应用需要单独授权。

### 设计决策讨论

**为什么通过 MCP Server 而不是直接作为内置工具？**

1. **代码复用**：Computer Use 的核心逻辑（`@ant/computer-use-mcp` 包）在 Claude Code 和 Cowork（桌面应用）之间共享。MCP 接口是两者的公共契约。
2. **隔离性**：MCP Server 有自己的工具注册和权限模型，不会污染内置工具的命名空间
3. **可选性**：通过 `feature('CHICAGO_MCP')` 编译期门控，外部构建可以完全排除 Computer Use 代码

**为什么需要文件锁防止并发？**

```typescript
// computerUseLock.ts
// 同一时间只允许一个 Claude Code 会话使用 Computer Use
```

如果两个 Claude Code 会话同时操作屏幕，它们的鼠标和键盘操作会互相干扰——一个会话移动鼠标到 A 点，另一个会话立即移动到 B 点，导致两个会话都无法正确操作。文件锁确保同一时间只有一个会话可以控制屏幕。

**为什么终端是"代理宿主"而不是被排除的应用？**

源码注释解释了这个微妙的设计：

```typescript
// Terminal as surrogate host. getTerminalBundleId() detects the emulator
// we're running inside. It's passed as hostBundleId to prepareDisplay/
// resolvePrepareCapture so the Swift side exempts it from hide AND skips
// it in the activate z-order walk
```

终端窗口有双重身份：
- 作为 Claude Code 的"宿主"，它不应该被隐藏（否则用户看不到 Claude Code 的输出）
- 作为截图的干扰源，它不应该出现在截图中

通过将终端标记为"代理宿主"（surrogate host），Swift 模块知道要在截图时排除它，但不会在 `prepareForAction` 时隐藏它。

---

## 18.9 特性间的组合与协同

这八个高级特性不是孤立的功能点，它们之间存在深度的组合关系。理解这些组合是理解 Claude Code 架构设计的关键。

### 组合矩阵

```
              Plan Mode  Worktree  Cron  Voice  Background  Teleport  Swarm  CU
Plan Mode        -         ✓       ·      ·       ·          ·        ✓      ·
Worktree         ✓         -       ·      ·       ·          ✓        ✓✓     ·
Cron             ·         ·       -      ·       ✓          ·        ·      ·
Voice            ·         ·       ·      -       ·          ·        ·      ·
Background       ·         ·       ✓      ·       -          ✓        ·      ·
Teleport         ·         ✓       ·      ·       ✓          -        ·      ·
Swarm            ✓         ✓✓      ·      ·       ·          ·        -      ·
Computer Use     ·         ·       ·      ·       ·          ·        ·      -

✓ = 有意义的组合    ✓✓ = 核心依赖    · = 独立
```

**关键组合解析：**

**Swarm + Worktree（核心依赖）**：每个 Teammate 自动获得独立的 Git Worktree。这不是可选的——没有 Worktree 隔离，多个代理在同一个工作区并行修改文件会导致灾难。Swarm 的 `spawn()` 方法内部调用 `createAgentWorktree()`，这是两个特性最紧密的耦合点。

**Plan Mode + Swarm**：Teammate 可以被要求在执行前先进入 Plan Mode（`isPlanModeRequired()`）。此时 Teammate 写好方案后，通过邮箱发送给 Leader 审批，而不是直接弹出本地对话框。这是 Plan Mode 的 `ExitPlanModeV2Tool` 中 `isTeammate()` 分支的用途。

**Cron + Background**：Cron 任务触发时，如果 REPL 正在处理用户查询（`isLoading() === true`），任务会被推迟。但如果用户把当前查询后台化了（Ctrl+B），REPL 变为空闲，Cron 任务就可以触发了。两个特性通过 `isLoading` 状态间接协调。

**Teleport + Worktree**：Teleport 到远程时，Git Bundle 包含了当前 Worktree 的状态（包括未提交修改）。远程环境会在 Bundle 的基础上创建新的 Worktree。这确保了本地的工作状态能完整迁移到远程。

### 共享的架构模式

回顾这八个特性，可以提炼出几个反复出现的架构模式：

**1. 工具即接口（Tool as Interface）**

Plan Mode、Worktree、Cron 都通过 Tool 接口暴露给模型。这不是偶然——Tool 接口提供了：
- **输入校验**（Zod schema）
- **权限控制**（`checkPermissions`）
- **进度上报**（`ToolCallProgress`）
- **结果序列化**（`mapToolResultToToolResultBlockParam`）

把高级特性包装成 Tool，就自动获得了这些基础设施，不需要为每个特性重新实现。

**2. 文件系统作为通信总线**

Cron 的 `scheduled_tasks.json`、Swarm 的邮箱目录、Background 的 PID 文件、Worktree 的状态持久化——都使用文件系统作为进程间通信的媒介。这个选择的核心原因是：**文件系统是唯一一个所有进程都能访问、不需要额外设置、天然持久化的通信通道。**

**3. Fail-Closed 安全原则**

Worktree 的 `countWorktreeChanges` 在 Git 命令失败时返回 `null`（拒绝删除）；Cron 的调度器锁在 PID 检测失败时不接管；Computer Use 在权限检查失败时不执行操作。所有涉及不可逆操作的特性都遵循 fail-closed 原则——**不确定时，宁可不做。**

**4. 确定性优于随机性**

Cron 的抖动基于任务 ID（确定性），Worktree 的 slug 基于词汇生成（可读性），Plan 文件名基于词汇 slug（可识别性）。在需要"分散"或"唯一"的场景中，Claude Code 倾向于使用确定性算法而非纯随机——这让行为可重现、可调试。

---

## 本章小结

本章分析了 Claude Code 的八个高级特性。它们解决的问题各不相同，但共享一个设计哲学：**在已有的 Harness 架构（Tool 系统、权限系统、状态管理）之上构建，而不是另起炉灶。**

| 特性 | 核心问题 | 关键源码 |
|------|---------|---------|
| Plan Mode | 复杂任务需要先规划再执行 | `tools/EnterPlanModeTool/`, `tools/ExitPlanModeTool/`, `utils/plans.ts` |
| Worktree | 并行工作需要文件系统隔离 | `tools/EnterWorktreeTool/`, `tools/ExitWorktreeTool/`, `utils/worktree.ts` |
| Cron | 周期性任务需要定时调度 | `tools/ScheduleCronTool/`, `utils/cronScheduler.ts`, `utils/cronTasks.ts` |
| Voice | 语音输入比打字更快 | `services/voiceStreamSTT.ts`, `services/voice.ts` |
| Background | 长任务不应阻塞用户 | `hooks/useSessionBackgrounding.ts`, `utils/concurrentSessions.ts` |
| Teleport | 本地和远程需要无缝切换 | `utils/teleport.tsx`, `utils/teleport/gitBundle.ts` |
| Swarm | 复杂项目需要多代理协作 | `utils/swarm/backends/`, `utils/swarm/permissionSync.ts` |
| Computer Use | GUI 操作需要屏幕交互 | `utils/computerUse/executor.ts`, `utils/computerUse/wrapper.tsx` |

这些特性的存在，让 Claude Code 从一个"能回答编程问题的 CLI"进化为一个"能独立完成复杂软件工程任务的平台"。每个特性都是对一个真实工程场景的回应——不是为了技术炫耀，而是为了解决开发者在日常工作中遇到的实际问题。
