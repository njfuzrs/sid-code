---
title: Claude Code 源码解析（一）· 启动与引导
description: '一个功能复杂的 CLI 工具如何做到启动不卡顿？如何在毫秒级完成快速路径分发，同时延迟加载重量级运行时？'
date: "2026-04-01"
series: Claude Code 源码解析
tags: [Claude Code, 源码解析, harness]
outline: 2
---

# 第一章：启动与引导（Bootstrap & Startup）

> 从用户敲下 `claude` 到 REPL 就绪，经历了什么？

## 核心问题

一个 CLI 工具的启动看似简单——解析参数、执行逻辑、退出。但 Claude Code 面临的启动问题远比普通 CLI 复杂：

1. **它不是一个简单的 CLI，而是一个终端应用平台。** 它需要加载 React + Ink 渲染引擎、30+ 内置工具、80+ 斜杠命令、MCP 服务器连接、插件系统、Skills 系统、OAuth 认证、企业策略……这些子系统的模块总量巨大。

2. **它有十几种运行模式。** 除了主交互 REPL，还有：`--version`、`--print`（非交互）、`daemon`、`bridge`、`mcp serve`、后台会话（`ps/logs/attach/kill`）、`environment-runner`、`self-hosted-runner`、Chrome 原生主机、SSH 远程等。每种模式需要的子系统完全不同。

3. **用户对启动速度极其敏感。** 一个 CLI 工具如果启动超过 500ms，用户体验就会明显下降。但加载上述所有子系统可能需要数秒。

**核心矛盾：功能丰富性 vs 启动速度。**

Claude Code 的解法是一个精心设计的**两阶段启动架构**——用一个极轻的 bootstrap 层拦截快速路径，只在真正需要时才加载完整应用。

---

## 1.1 架构总览

```
用户输入: claude [args...]
         │
         ▼
┌─────────────────────────────────────────────────┐
│  Stage 1: Bootstrap (entrypoints/cli.tsx)        │
│  ─────────────────────────────────────────────── │
│  • 零导入的快速路径 (--version)                    │
│  • 按需动态导入的专用模式路径                       │
│  • 编译期 feature() 门控死代码消除                  │
│                                                   │
│  快速路径命中?                                     │
│  ├─ YES → 执行并退出 (< 50ms)                     │
│  └─ NO  ↓                                         │
└─────────────────────────────────────────────────┘
         │
         │ await import('../main.js')
         ▼
┌─────────────────────────────────────────────────┐
│  Stage 2: Full CLI (main.tsx)                    │
│  ─────────────────────────────────────────────── │
│  • 副作用前置: MDM预读 / Keychain预取              │
│  • 静态导入: ~200个模块同步加载                     │
│  • init(): 配置/认证/网络/遥测初始化               │
│  • Commander.js 参数解析                           │
│  • 迁移(migrations)                               │
│  • 信任对话框 / 权限初始化                          │
│  • React + Ink 渲染引擎挂载                        │
│  • 延迟预取: 首屏渲染后的后台预热                   │
│                                                   │
│  ┌───────────┐  ┌──────────┐  ┌───────────────┐ │
│  │ REPL 交互  │  │ -p 非交互 │  │ mcp serve 等  │ │
│  └───────────┘  └──────────┘  └───────────────┘ │
└─────────────────────────────────────────────────┘
```

这个架构的关键洞察是：**大多数 `claude` 调用不需要完整应用。** `claude --version` 不需要加载 React；`claude ps` 不需要初始化 MCP；`claude daemon` 不需要 Ink 渲染引擎。通过在 bootstrap 层拦截这些路径，可以将它们的启动时间从秒级降到毫秒级。

---

## 1.2 Stage 1: Bootstrap 层（entrypoints/cli.tsx）

### 面临的问题

Node.js/Bun 的模块系统有一个根本特性：**`import` 语句在模块求值时同步执行**。一个文件顶部的 `import` 会递归加载它的所有依赖。对于 Claude Code 这样的大型应用，`main.tsx` 顶部有 ~200 个 import，这些 import 会级联加载数千个模块，仅模块求值就需要 100-300ms。

问题是：当用户只想执行 `claude --version` 时，这 300ms 的模块加载完全是浪费。

### 解法：零导入的 bootstrap 入口

`entrypoints/cli.tsx` 是整个应用的真正入口点。它的设计原则是：**顶层零 `import` 语句（除了 `bun:bundle`），所有依赖通过 `await import()` 动态加载。**

```typescript
// entrypoints/cli.tsx — 顶层只有这一个导入
import { feature } from 'bun:bundle';

// 环境变量设置（无模块依赖的纯赋值）
process.env.COREPACK_ENABLE_AUTO_PIN = '0';

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // 快速路径 1: --version — 零模块加载
  if (args.length === 1 && (args[0] === '--version' || args[0] === '-v')) {
    console.log(`${MACRO.VERSION} (Claude Code)`);  // 编译期内联
    return;
  }

  // 快速路径 2: --dump-system-prompt — 只加载必要模块
  if (feature('DUMP_SYSTEM_PROMPT') && args[0] === '--dump-system-prompt') {
    const { enableConfigs } = await import('../utils/config.js');
    // ...只加载 config + model + prompts，不加载 React/Ink/Tools
    return;
  }

  // 快速路径 3-N: daemon-worker, bridge, daemon, bg sessions, templates...
  // 每个路径只动态导入自己需要的模块

  // 所有快速路径都未命中 → 加载完整 CLI
  const { main: cliMain } = await import('../main.js');
  await cliMain();
}
```

### 快速路径清单

bootstrap 层拦截了以下路径，按优先级排序：

| 路径 | 触发条件 | 加载的模块 | 典型耗时 |
|------|----------|-----------|---------|
| `--version` | `-v`, `-V`, `--version` | 零（`MACRO.VERSION` 编译期内联） | < 10ms |
| `--dump-system-prompt` | 内部 flag | config + model + prompts | ~50ms |
| Chrome MCP/Native Host | `--claude-in-chrome-mcp` 等 | Chrome 集成模块 | ~80ms |
| Daemon Worker | `--daemon-worker` | worker 注册表（无 config/analytics） | ~30ms |
| Bridge 模式 | `remote-control`, `rc`, `bridge` 等 | config + auth + bridge + policy | ~150ms |
| Daemon | `daemon` | config + sinks + daemon | ~100ms |
| 后台会话 | `ps`, `logs`, `attach`, `kill`, `--bg` | config + bg 模块 | ~80ms |
| Templates | `new`, `list`, `reply` | templates handler | ~100ms |
| Environment Runner | `environment-runner` | runner 模块 | ~80ms |
| Self-hosted Runner | `self-hosted-runner` | runner 模块 | ~80ms |
| Tmux + Worktree | `--tmux` + `--worktree` | config + worktree | ~100ms |
| **完整 CLI** | 以上均未命中 | **main.tsx（全量）** | **300-500ms** |

### 设计决策讨论

**为什么不用 Commander.js 的子命令机制来分发？**

Commander.js 本身需要先被 import，而它在 `main.tsx` 中，和其他 200 个模块一起被加载。如果把分发逻辑放在 Commander 里，就必须先付出完整的模块加载代价。bootstrap 层的意义恰恰在于**在 Commander 之前**做分发。

**为什么用 `process.argv` 手动解析而不是用参数解析库？**

因为任何库都意味着额外的 import。bootstrap 层的目标是零依赖。手动检查 `args[0] === 'daemon'` 虽然原始，但它的代价是零。这是一个典型的 **"在性能关键路径上，简单胜过优雅"** 的工程决策。

**为什么 Daemon Worker 路径不调用 `enableConfigs()`？**

源码注释说得很清楚：

```typescript
// Must come before the daemon subcommand check: spawned per-worker, so
// perf-sensitive. No enableConfigs(), no analytics sinks at this layer —
// workers are lean. If a worker kind needs configs/auth (assistant will),
// it calls them inside its run() fn.
```

Worker 是由 supervisor 频繁 spawn 的，每次 spawn 都要付出启动代价。如果 worker 不需要 config，就不应该加载它。这是**按需初始化**原则的极致体现——不是"启动时全部初始化，用不到的忽略"，而是"谁需要谁自己初始化"。

---

## 1.3 编译期特性门控：`feature()` 与死代码消除

### 面临的问题

Claude Code 不是一个单一产品——它有多个构建变体：
- **外部发布版（external）**：面向公众用户
- **内部版（ant）**：Anthropic 内部使用，包含额外的调试/实验工具
- **KAIROS 版**：Assistant 模式
- **各种实验性功能**：Bridge、Daemon、后台会话、SSH Remote 等

问题是：如何在一个代码库中管理这些变体？如果用运行时 `if` 判断，那些永远不会执行的代码仍然会被打包、被加载、占用内存。

### 解法：`bun:bundle` 的编译期 `feature()` 门控

```typescript
import { feature } from 'bun:bundle';

// 编译期求值：如果目标构建不包含 DAEMON 特性，
// 整个 if 块（包括 import）会被 bundler 完全删除
if (feature('DAEMON') && args[0] === 'daemon') {
  const { daemonMain } = await import('../daemon/main.js');
  await daemonMain(args.slice(1));
  return;
}
```

`feature()` 在 Bun 的 bundler 阶段被求值为 `true` 或 `false` 字面量。当结果为 `false` 时，bundler 的死代码消除（DCE）会移除整个分支，包括其中的 `import()` 调用。这意味着：

- **外部构建**不会包含 `daemon/main.js` 的任何代码
- **打包体积更小**，模块图更简单
- **不存在"加载了但不用"的浪费**

### 源码中出现的 feature flags

从 `cli.tsx`、`tools.ts`、`commands.ts` 中可以提取出以下编译期特性门控：

| Feature Flag | 控制的功能 | 出现位置 |
|-------------|-----------|---------|
| `DUMP_SYSTEM_PROMPT` | 导出系统提示词（内部调试） | cli.tsx |
| `CHICAGO_MCP` | Computer Use MCP 服务器 | cli.tsx |
| `DAEMON` | 后台守护进程 | cli.tsx |
| `BRIDGE_MODE` | IDE Bridge / 远程控制 | cli.tsx, commands.ts |
| `BG_SESSIONS` | 后台会话管理 | cli.tsx |
| `TEMPLATES` | 模板任务系统 | cli.tsx |
| `BYOC_ENVIRONMENT_RUNNER` | 自托管环境运行器 | cli.tsx |
| `SELF_HOSTED_RUNNER` | 自托管运行器 | cli.tsx |
| `ABLATION_BASELINE` | 消融实验基线 | cli.tsx |
| `PROACTIVE` | 主动模式 | tools.ts, commands.ts |
| `KAIROS` | Assistant 模式 | tools.ts, commands.ts, main.tsx |
| `AGENT_TRIGGERS` | Cron 调度工具 | tools.ts |
| `COORDINATOR_MODE` | 多 Agent 协调器 | main.tsx |
| `VOICE_MODE` | 语音输入 | commands.ts |
| `MONITOR_TOOL` | 监控工具 | tools.ts |
| `SSH_REMOTE` | SSH 远程连接 | main.tsx |
| `DIRECT_CONNECT` | 直连模式 | main.tsx |
| `LODESTONE` | Deep Link 协议处理 | main.tsx |
| `TRANSCRIPT_CLASSIFIER` | 自动模式分类器 | main.tsx |

### 设计决策讨论

**为什么不用环境变量做运行时门控？**

源码中实际上**两种都用了**，各有分工：

- **编译期 `feature()`**：用于**整个子系统的开关**。当一个特性被关闭时，相关的所有代码（可能数十个模块）都不应该出现在最终产物中。这是打包体积和模块加载性能的问题。
- **运行时环境变量**（如 `process.env.USER_TYPE === 'ant'`）：用于**同一构建内的细粒度控制**。比如 `REPLTool` 只在内部用户可用，但它的代码量小，不值得为它做一个独立构建变体。

有一个微妙的时序问题值得注意。`cli.tsx` 中有这样一段注释：

```typescript
// Harness-science L0 ablation baseline. Inlined here (not init.ts) because
// BashTool/AgentTool/PowerShellTool capture DISABLE_BACKGROUND_TASKS into
// module-level consts at import time — init() runs too late.
```

这揭示了一个重要约束：**某些环境变量必须在模块求值之前设置**，因为模块顶层的 `const` 会在 import 时捕获环境变量的值。如果在 `init()` 中设置，模块已经求值完毕，`const` 已经绑定了旧值。这就是为什么消融实验的环境变量设置被放在 `cli.tsx` 的顶层——它在任何其他模块被 import 之前执行。

---

## 1.4 Stage 2: 完整 CLI 入口（main.tsx）

### 面临的问题

当所有快速路径都未命中，bootstrap 层执行 `await import('../main.js')`，进入完整 CLI 的加载。此时面临的问题变了：

**不再是"要不要加载"，而是"如何让加载尽可能快"。**

`main.tsx` 需要初始化的子系统包括：配置系统、认证、网络代理、mTLS、遥测、MCP 连接、插件、Skills、权限、沙箱、Git 状态、会话恢复……这些子系统之间存在复杂的依赖关系和时序约束。

### 解法：副作用前置 + 并行预取 + 延迟初始化

`main.tsx` 的前 20 行是整个文件最精妙的部分：

```typescript
// main.tsx — 文件最顶部

// 这些副作用必须在所有其他 import 之前运行：
// 1. profileCheckpoint 在重量级模块求值开始前打点
// 2. startMdmRawRead 启动 MDM 子进程 (plutil/reg query)，
//    使其与后续 ~135ms 的 import 并行执行
// 3. startKeychainPrefetch 并行启动两个 macOS keychain 读取
//    (OAuth + legacy API key)——否则 isRemoteManagedSettingsEligible()
//    会通过同步 spawn 顺序读取它们 (~65ms)

import { profileCheckpoint } from './utils/startupProfiler.js';
profileCheckpoint('main_tsx_entry');

import { startMdmRawRead } from './utils/settings/mdm/rawRead.js';
startMdmRawRead();  // 立即启动子进程，不等结果

import { startKeychainPrefetch } from './utils/secureStorage/keychainPrefetch.js';
startKeychainPrefetch();  // 立即启动子进程，不等结果

// 接下来是 ~200 个 import 语句，耗时 ~135ms
// 在这 135ms 内，MDM 读取和 Keychain 读取已经在后台并行执行
import { Command as CommanderCommand } from '@commander-js/extra-typings';
import chalk from 'chalk';
import React from 'react';
// ... 还有 ~197 个 import
```

这里利用了一个关键洞察：**ES module 的 import 是同步的，但被 import 的模块中启动的异步操作（子进程、网络请求）会在后台并行执行。** 通过把"启动子进程"的 import 放在最前面，可以让子进程的执行时间与后续模块加载时间重叠。

用时间线表示：

```
时间 ──────────────────────────────────────────────────────►

main.tsx 模块求值:
  ├─ startMdmRawRead()     ──→ [plutil 子进程在后台运行......]
  ├─ startKeychainPrefetch() → [keychain 读取在后台运行......]
  ├─ import chalk           ─┐
  ├─ import React            │ ~135ms 的同步模块加载
  ├─ import ...              │ (此时子进程已在并行执行)
  ├─ import ...             ─┘
  └─ profileCheckpoint('main_tsx_imports_loaded')

main() 函数开始:
  ├─ init()
  │   ├─ enableConfigs()     ← 此时 MDM 数据可能已经就绪
  │   ├─ applySafeConfigEnv  ← 此时 Keychain 数据可能已经就绪
  │   └─ ...
```

**节省的时间**：注释中提到 Keychain 的顺序读取需要 ~65ms。通过并行化，这 65ms 被隐藏在模块加载时间内，用户感知到的启动时间减少了 65ms。

### 设计决策讨论

**为什么不把所有初始化都并行化？**

因为存在**依赖顺序约束**。比如：

1. `enableConfigs()` 必须在读取任何配置之前
2. `applySafeConfigEnvironmentVariables()` 必须在信任对话框之前（只应用"安全"的环境变量）
3. `applyConfigEnvironmentVariables()`（完整版）必须在信任对话框之后
4. `configureGlobalMTLS()` 和 `configureGlobalAgents()` 必须在任何 TLS 连接之前
5. `preconnectAnthropicApi()` 必须在 mTLS/proxy 配置之后

这些约束形成了一个偏序关系，不能随意并行化。`main.tsx` 的做法是：**在约束允许的范围内最大化并行，对有依赖关系的步骤严格保序。**

**为什么 `import` 语句之间穿插了副作用调用？**

这在常规代码中是反模式（ESLint 规则 `no-top-level-side-effects` 会报警，源码中用 `eslint-disable` 显式豁免）。但在这里，它是一个**刻意的性能优化**。如果把 `startMdmRawRead()` 放在 `main()` 函数内部，它就要等到所有 import 完成后才执行，白白浪费了 135ms 的并行窗口。

这是一个典型的 **"打破常规以获取性能"** 的工程决策。代码注释详细解释了为什么这样做，确保后续维护者理解意图。

---

## 1.5 init()：核心初始化序列

### 面临的问题

`main.tsx` 的模块加载完成后，`main()` 函数开始执行。第一个关键步骤是调用 `init()`（定义在 `entrypoints/init.ts`）。

`init()` 要解决的问题是：**在用户看到任何 UI 之前，把运行环境准备好。** 但"准备好"涉及十几个子系统，它们之间有复杂的依赖关系，而且有些操作涉及安全敏感的时序约束。

### init() 的执行序列

```typescript
// entrypoints/init.ts — 简化后的核心流程

export const init = memoize(async (): Promise<void> => {

  // ① 配置系统启用
  enableConfigs();

  // ② 安全环境变量（信任对话框之前只能应用"安全"的）
  applySafeConfigEnvironmentVariables();

  // ③ CA 证书配置（必须在任何 TLS 连接之前）
  applyExtraCACertsFromConfig();

  // ④ 优雅退出处理
  setupGracefulShutdown();

  // ⑤ 1P 事件日志（异步，fire-and-forget）
  void Promise.all([
    import('../services/analytics/firstPartyEventLogger.js'),
    import('../services/analytics/growthbook.js'),
  ]).then(([fp, gb]) => { fp.initialize1PEventLogging(); });

  // ⑥ OAuth 账户信息填充（异步）
  void populateOAuthAccountInfoIfNeeded();

  // ⑦ 远程托管设置加载 promise 初始化
  if (isEligibleForRemoteManagedSettings()) {
    initializeRemoteManagedSettingsLoadingPromise();
  }
  if (isPolicyLimitsEligible()) {
    initializePolicyLimitsLoadingPromise();
  }

  // ⑧ mTLS 配置
  configureGlobalMTLS();

  // ⑨ HTTP 代理配置
  configureGlobalAgents();

  // ⑩ API 预连接（TCP+TLS 握手与后续工作重叠）
  preconnectAnthropicApi();

  // ⑪ 上游代理（仅远程容器环境）
  if (isEnvTruthy(process.env.CLAUDE_CODE_REMOTE)) {
    await initUpstreamProxy();
  }

  // ⑫ Windows shell 设置
  setShellIfWindows();

  // ⑬ 清理回调注册
  registerCleanup(shutdownLspServerManager);
  registerCleanup(cleanupSessionTeams);
});
```

### 数据流分析：init() 中的依赖链

```
enableConfigs()
    │
    ├──→ applySafeConfigEnvironmentVariables()
    │        │
    │        ├──→ applyExtraCACertsFromConfig()
    │        │        │
    │        │        └──→ configureGlobalMTLS()
    │        │                 │
    │        │                 └──→ configureGlobalAgents()
    │        │                          │
    │        │                          └──→ preconnectAnthropicApi()
    │        │
    │        └──→ isEligibleForRemoteManagedSettings()
    │                 │
    │                 └──→ initializeRemoteManagedSettingsLoadingPromise()
    │
    └──→ setupGracefulShutdown()
         populateOAuthAccountInfoIfNeeded()  [异步，无依赖]
         initialize1PEventLogging()          [异步，无依赖]
```

### 设计决策讨论

**为什么 `init()` 用 `memoize` 包装？**

```typescript
export const init = memoize(async (): Promise<void> => { ... });
```

`init()` 可能被多个入口路径调用（交互式 REPL、非交互式 `-p` 模式、MCP serve 模式等）。`memoize` 确保无论调用多少次，实际初始化只执行一次。这比手动维护一个 `initialized` 标志更简洁，也更不容易出错。

**为什么区分 `applySafeConfigEnvironmentVariables()` 和 `applyConfigEnvironmentVariables()`？**

这是一个**安全设计**。在用户接受信任对话框之前，不应该应用所有配置中的环境变量——因为项目级 `.claude/settings.json` 可能被恶意仓库注入危险的环境变量（比如修改 `PATH`）。只有在用户明确信任当前目录后，才应用完整的环境变量。

时序上：
1. `init()` 中：`applySafeConfigEnvironmentVariables()` — 只应用全局/用户级的安全变量
2. 信任对话框通过后：`applyConfigEnvironmentVariables()` — 应用所有变量（包括项目级）

**为什么 `preconnectAnthropicApi()` 放在 proxy/mTLS 配置之后？**

注释说得很清楚：

```typescript
// Preconnect to the Anthropic API — overlap TCP+TLS handshake
// (~100-200ms) with the ~100ms of action-handler work before the API
// request. After CA certs + proxy agents are configured so the warmed
// connection uses the right transport.
```

如果在 proxy 配置之前预连接，建立的连接不会经过代理，后续真正的 API 请求会建立新连接，预连接就白费了。这是一个**"优化必须尊重正确性"**的例子。

**为什么远程托管设置用"初始化 loading promise"而不是直接 await？**

```typescript
if (isEligibleForRemoteManagedSettings()) {
  initializeRemoteManagedSettingsLoadingPromise();
}
```

这里只是**创建了一个 Promise**，并没有 await 它。实际的远程设置加载会在后台进行。其他需要远程设置的代码可以 `await waitForRemoteManagedSettingsToLoad()` 来等待。

这个设计解决了一个微妙的问题：如果 `init()` 直接 await 远程设置加载，那么网络延迟（可能数百毫秒甚至超时）会阻塞整个启动流程。通过分离"启动加载"和"等待完成"，可以让加载在后台进行，只在真正需要结果时才等待。

---

## 1.6 main() 函数：从 init 到 REPL 的完整链路

### 面临的问题

`init()` 完成后，运行环境已经就绪。但从"环境就绪"到"用户看到 REPL 提示符"之间，还有大量工作：

- CLI 参数解析（Commander.js）
- 数据迁移（migrations）
- 认证检查与 GrowthBook 初始化
- 信任对话框
- 权限系统初始化
- MCP 服务器连接
- 插件与 Skills 加载
- 会话恢复
- AppState 创建
- React + Ink 渲染引擎挂载

这些步骤的顺序不是随意的——它们之间存在严格的依赖关系和安全约束。

### main() 的关键阶段

```
main() 执行流程（简化）:

 ┌─ 安全防护 ─────────────────────────────────────────┐
 │  process.env.NoDefaultCurrentDirectoryInExePath = 1 │
 │  initializeWarningHandler()                         │
 │  SIGINT / exit 处理                                 │
 └─────────────────────────────────────────────────────┘
                    │
                    ▼
 ┌─ 早期 argv 处理 ──────────────────────────────────┐
 │  cc:// deep link URL 重写                          │
 │  `claude assistant` / `claude ssh` 参数提取        │
 │  --settings / --setting-sources 早期解析           │
 └────────────────────────────────────────────────────┘
                    │
                    ▼
 ┌─ init() ──────────────────────────────────────────┐
 │  (见 1.5 节)                                       │
 └────────────────────────────────────────────────────┘
                    │
                    ▼
 ┌─ Commander.js 参数解析 ───────────────────────────┐
 │  定义所有 CLI 选项和子命令                          │
 │  解析 process.argv                                 │
 └────────────────────────────────────────────────────┘
                    │
                    ▼
 ┌─ 主命令 action handler ──────────────────────────┐
 │                                                    │
 │  ① Migrations（数据迁移）                          │
 │  ② GrowthBook 初始化（feature flags）              │
 │  ③ 认证检查                                        │
 │  ④ 信任对话框                                      │
 │  ⑤ 权限系统初始化                                  │
 │  ⑥ MCP 配置解析                                    │
 │  ⑦ 插件 & Skills 加载                              │
 │  ⑧ 工具 & 命令注册                                 │
 │  ⑨ AppState 创建                                   │
 │  ⑩ 分支: 交互式 REPL / 非交互式 -p / MCP serve    │
 │                                                    │
 └────────────────────────────────────────────────────┘
                    │
          ┌─────────┼──────────┐
          ▼         ▼          ▼
       REPL      print      mcp serve
     (交互式)   (非交互)    (服务器)
```

### 早期 argv 处理：为什么在 Commander 之前？

`main()` 函数的前 200 行（约 585-784 行）在 Commander 解析之前做了大量 argv 预处理。这看起来很奇怪——Commander 不就是干这个的吗？

原因有两个：

**1. 某些参数需要重写 argv 后再交给 Commander**

比如 `claude ssh host /tmp` 需要被转换为普通的 `claude` 调用（去掉 `ssh host /tmp`），同时把 host 和 cwd 存入 `_pendingSSH` 对象。Commander 看到的是一个普通的交互式启动命令，但 REPL 初始化时会检查 `_pendingSSH` 并建立 SSH 连接。

```typescript
// `claude ssh <host> [dir]` — strip from argv so the main command handler
// runs (full interactive TUI), stash the host/dir for the REPL branch
if (feature('SSH_REMOTE') && _pendingSSH) {
  if (rawCliArgs[0] === 'ssh' && rawCliArgs[1]) {
    _pendingSSH.host = rawCliArgs[1];
    // ... 从 argv 中移除 ssh 相关参数
    process.argv = [process.argv[0]!, process.argv[1]!, ...rest];
  }
}
```

**2. 某些设置必须在 init() 之前生效**

```typescript
function eagerLoadSettings(): void {
  const settingsFile = eagerParseCliFlag('--settings');
  if (settingsFile) {
    loadSettingsFromFlag(settingsFile);  // 必须在 init() 之前
  }
}
```

`--settings` 指定的配置文件会影响 `init()` 中的行为（比如 CA 证书路径、代理配置）。如果等 Commander 解析完再处理，就太晚了。

### Migrations：版本间的数据迁移

```typescript
const CURRENT_MIGRATION_VERSION = 11;

function runMigrations(): void {
  if (getGlobalConfig().migrationVersion !== CURRENT_MIGRATION_VERSION) {
    migrateAutoUpdatesToSettings();
    migrateBypassPermissionsAcceptedToSettings();
    migrateSonnet1mToSonnet45();
    migrateLegacyOpusToCurrent();
    migrateSonnet45ToSonnet46();
    migrateOpusToOpus1m();
    // ... 更多迁移
    saveGlobalConfig(prev => ({
      ...prev,
      migrationVersion: CURRENT_MIGRATION_VERSION
    }));
  }
}
```

这是一个经典的**顺序迁移模式**：每次启动检查版本号，如果落后就依次执行所有迁移。迁移是幂等的（可以安全重复执行），版本号只在所有迁移成功后才更新。

值得注意的是迁移的内容——大部分是**模型名称迁移**（`Sonnet 1m → Sonnet 4.5 → Sonnet 4.6`、`Opus → Opus 1m`）。这反映了 Claude Code 面临的一个独特挑战：模型名称会随着 Anthropic 的产品迭代而变化，用户配置中保存的旧模型名需要被自动更新。

---

## 1.7 延迟预取：首屏渲染后的后台预热

### 面临的问题

即使经过了上述所有优化，从 `main()` 开始到 REPL 首屏渲染仍然需要数百毫秒。在这段时间内，有些工作是首屏渲染**不需要**但**首次 API 调用需要**的，比如：

- 用户信息初始化（`initUser()`）
- 用户上下文构建（`getUserContext()`）
- Git 状态获取（`getSystemContext()`）
- 文件计数（`countFilesRoundedRg()`）
- 提示建议（`getRelevantTips()`）
- Feature flag 刷新（`initializeAnalyticsGates()`）
- 设置变更检测器初始化

如果把这些放在首屏渲染之前，会增加用户等待时间。如果完全不做，首次 API 调用时会有明显延迟。

### 解法：`startDeferredPrefetches()`

```typescript
/**
 * Start background prefetches and housekeeping that are NOT needed
 * before first render. These are deferred from setup() to reduce
 * event loop contention and child process spawning during the
 * critical startup path.
 * Call this after the REPL has been rendered.
 */
export function startDeferredPrefetches(): void {
  // 性能测量模式下跳过所有预取
  if (isEnvTruthy(process.env.CLAUDE_CODE_EXIT_AFTER_FIRST_RENDER)) {
    return;
  }
  // --bare 模式下跳过（脚本化调用不需要预热）
  if (isBareMode()) {
    return;
  }

  // 这些都是 fire-and-forget，不 await
  void initUser();
  void getUserContext();
  prefetchSystemContextIfSafe();
  void getRelevantTips();
  void countFilesRoundedRg(getCwd(), AbortSignal.timeout(3000), []);
  void initializeAnalyticsGates();
  void prefetchOfficialMcpUrls();
  void refreshModelCapabilities();
  void settingsChangeDetector.initialize();
  void skillChangeDetector.initialize();
}
```

这个函数在 REPL 首屏渲染**之后**被调用。所有操作都是 `void`（fire-and-forget），不阻塞用户交互。当用户开始输入第一个问题时，这些预取大概率已经完成，首次 API 调用可以直接使用缓存的结果。

### 数据流：预取与消费的时间线

```
时间 ──────────────────────────────────────────────────────────►

REPL 首屏渲染完成
  │
  ├─ startDeferredPrefetches()
  │   ├─ initUser()              ──→ [后台执行...] → 缓存就绪
  │   ├─ getUserContext()        ──→ [后台执行...] → 缓存就绪
  │   ├─ getSystemContext()      ──→ [git 命令...] → 缓存就绪
  │   ├─ countFilesRoundedRg()   ──→ [rg 计数...]  → 缓存就绪
  │   └─ ...
  │
  │   用户正在输入问题...
  │   (预取在后台完成)
  │
  └─ 用户按下 Enter
       │
       └─ 构建 API 请求
            ├─ getSystemContext()  ← 命中缓存，零延迟
            ├─ getUserContext()    ← 命中缓存，零延迟
            └─ 发送 API 请求
```

### 设计决策讨论

**为什么 `getSystemContext()` 的预取有安全门控？**

```typescript
function prefetchSystemContextIfSafe(): void {
  if (isNonInteractiveSession) {
    void getSystemContext();  // 非交互模式：信任是隐式的
    return;
  }
  const hasTrust = checkHasTrustDialogAccepted();
  if (hasTrust) {
    void getSystemContext();  // 已接受信任：安全
  }
  // 否则不预取——等信任建立后再说
}
```

`getSystemContext()` 会执行 `git status`、`git log` 等命令。Git 命令可以通过 hooks 和 config（如 `core.fsmonitor`、`diff.external`）执行任意代码。在用户接受信任对话框之前执行 Git 命令，等于在未经用户同意的情况下执行了潜在的恶意代码。

这是一个**安全性优先于性能**的决策：宁可在首次 API 调用时多等几十毫秒，也不能在信任建立前执行不受信任的代码。

**为什么 `--bare` 模式跳过所有预取？**

```typescript
// --bare: skip ALL prefetches. These are cache-warms for the REPL's
// first-turn responsiveness. Scripted -p calls don't have a
// "user is typing" window to hide this work in — it's pure overhead
// on the critical path.
if (isBareMode()) {
  return;
}
```

`--bare` 模式用于脚本化调用（如 SDK 的 `query()` 方法）。这种场景下没有"用户正在输入"的时间窗口来隐藏预取开销——预取的 CPU 和 I/O 开销会直接拖慢首次 API 调用。所以干脆不做。

这揭示了一个重要的设计原则：**优化策略必须匹配使用场景。** 同一个优化（预取）在交互式场景下是净收益（利用空闲时间），在脚本化场景下却是净损失（增加关键路径开销）。

---

## 1.8 Bootstrap 状态：全局单例的集中管理

### 面临的问题

在启动过程中，有大量"状态"需要在不同模块之间共享：当前工作目录、会话 ID、模型设置、遥测计数器、OAuth token、feature flags 缓存……

这些状态有几个特点：
1. **生命周期是进程级的**——从启动到退出一直存在
2. **需要被几十个模块访问**——工具、服务、UI 组件都可能读取
3. **部分状态需要在模块求值阶段就可用**——比如 `cwd`、`isInteractive`
4. **存在循环依赖风险**——如果状态定义在某个"高层"模块中，底层模块 import 它就会形成环

### 解法：`bootstrap/state.ts` — 低依赖的全局状态容器

```typescript
// bootstrap/state.ts — 文件头部的注释
// DO NOT ADD MORE STATE HERE - BE JUDICIOUS WITH GLOBAL STATE

type State = {
  originalCwd: string
  projectRoot: string
  totalCostUSD: number
  totalAPIDuration: number
  cwd: string
  modelUsage: { [modelName: string]: ModelUsage }
  mainLoopModelOverride: ModelSetting | undefined
  initialMainLoopModel: ModelSetting
  isInteractive: boolean
  kairosActive: boolean
  sessionId: SessionId
  // ... 还有 ~50 个字段
}
```

`bootstrap/state.ts` 是一个**刻意保持低依赖**的模块。它只 import 类型定义和极少数工具函数，不 import 任何"业务"模块。这确保了：

- 任何模块都可以安全地 import `bootstrap/state.ts` 而不会引入循环依赖
- 模块求值阶段就可以读取状态（因为 `state.ts` 会在依赖链的早期被求值）

状态通过 getter/setter 函数暴露，而不是直接导出变量：

```typescript
// 不是这样：
export let cwd = process.cwd();  // ❌ 可变导出，难以追踪变更

// 而是这样：
export function getCwd(): string { return state.cwd; }
export function setCwd(newCwd: string): void {
  state.cwd = newCwd;
  resetSettingsCache();  // 副作用：cwd 变化时清除设置缓存
}
```

### 设计决策讨论

**为什么不用 React Context 或状态管理库？**

因为 `bootstrap/state.ts` 的消费者不全是 React 组件。工具执行逻辑、API 客户端、CLI 参数解析——这些都是纯 TypeScript 代码，不在 React 树中。全局单例是唯一能跨越"React 世界"和"非 React 世界"边界的方案。

实际上 Claude Code 有**两套状态系统**：
- `bootstrap/state.ts`：进程级全局状态，非响应式，用于配置/环境/遥测
- `state/AppState.tsx` + `state/store.ts`：会话级应用状态，响应式，用于 UI 渲染（消息列表、任务列表、权限状态等）

这种分离是合理的——不是所有状态都需要触发 UI 重渲染。

**"DO NOT ADD MORE STATE HERE" 的警告意味着什么？**

这是一个**架构护栏**。全局可变状态是已知的维护性杀手——它让代码的数据流变得隐式、难以追踪、难以测试。`bootstrap/state.ts` 是一个必要的妥协（启动阶段确实需要跨模块共享状态），但团队显然希望限制它的增长。

---

## 1.9 启动性能剖析：profileCheckpoint 体系

### 面临的问题

启动优化的前提是**能测量**。但 CLI 工具的启动性能测量比 Web 应用困难得多——没有 Chrome DevTools，没有 Performance API，`console.time` 的精度和开销都不理想。

### 解法：轻量级打点系统

```typescript
import { profileCheckpoint } from './utils/startupProfiler.js';

profileCheckpoint('main_tsx_entry');
// ... 200 个 import ...
profileCheckpoint('main_tsx_imports_loaded');

// main() 函数内
profileCheckpoint('main_function_start');
profileCheckpoint('main_warning_handler_initialized');
// ...
profileCheckpoint('init_function_start');
profileCheckpoint('init_configs_enabled');
profileCheckpoint('init_safe_env_vars_applied');
profileCheckpoint('init_network_configured');
profileCheckpoint('init_function_end');
```

从源码中可以提取出完整的 checkpoint 序列：

```
cli_entry
  → cli_before_main_import
  → cli_after_main_import
    → main_tsx_entry
    → main_tsx_imports_loaded        (~135ms 的模块加载)
    → main_function_start
    → main_warning_handler_initialized
    → eagerLoadSettings_start
    → eagerLoadSettings_end
    → init_function_start
      → init_configs_enabled
      → init_safe_env_vars_applied
      → init_after_graceful_shutdown
      → init_after_1p_event_logging
      → init_after_oauth_populate
      → init_after_jetbrains_detection
      → init_after_remote_settings_check
      → init_network_configured
      → init_function_end
    → cli_after_main_complete
```

这些 checkpoint 构成了一个**启动时间线**，可以精确定位哪个阶段耗时异常。

### 设计决策讨论

**为什么 `profileCheckpoint` 是第一个被 import 的模块？**

```typescript
// main.tsx 第一行
import { profileCheckpoint } from './utils/startupProfiler.js';
profileCheckpoint('main_tsx_entry');
```

因为它需要在所有其他模块加载之前记录时间戳。如果它在第 10 个 import 的位置，前 9 个 import 的耗时就无法测量。这也是为什么 `startupProfiler.js` 必须是一个极轻量的模块——它自身的加载时间会影响测量精度。

**`CLAUDE_CODE_EXIT_AFTER_FIRST_RENDER` 环境变量的用途**

```typescript
if (isEnvTruthy(process.env.CLAUDE_CODE_EXIT_AFTER_FIRST_RENDER)) {
  return;  // 跳过所有延迟预取
}
```

这是一个**性能基准测试工具**。设置这个环境变量后，Claude Code 会在首屏渲染完成后立即退出，不执行任何后台预取。这样可以精确测量"从启动到首屏"的时间，不受后台任务的 CPU 竞争干扰。

---

## 1.10 Early Input Capture：不丢失用户的第一次按键

### 面临的问题

有一个容易被忽视的用户体验问题：用户可能在 REPL 渲染完成之前就开始打字。如果这些按键被丢弃，用户会感到困惑——"我明明打了字，怎么没了？"

### 解法：在 main.tsx 加载前捕获输入

```typescript
// cli.tsx — 在加载 main.js 之前
const { startCapturingEarlyInput } = await import('../utils/earlyInput.js');
startCapturingEarlyInput();  // 开始缓冲 stdin

// main.tsx 加载完成...
// REPL 渲染完成后...
const { seedEarlyInput, stopCapturingEarlyInput } = ...;
stopCapturingEarlyInput();   // 停止缓冲
seedEarlyInput(inputBuffer); // 将缓冲的输入注入 REPL
```

这个机制在 bootstrap 层（`cli.tsx`）启动，在 REPL 就绪后结束。中间的所有按键都被缓冲，然后一次性注入到 REPL 的输入框中。

这是一个**用户体验的细节打磨**——技术上不复杂，但体现了对用户感受的关注。

---

## 1.11 总结：启动架构的设计哲学

回顾整个启动流程，可以提炼出几个贯穿始终的设计哲学：

### 1. 按需加载，而非预加载

从 bootstrap 层的动态 `import()` 到 `init()` 中的条件初始化，再到延迟预取——整个架构的核心思想是**不做不需要的事**。这不是懒惰，而是对"每一毫秒都属于用户"的尊重。

### 2. 并行化一切可以并行的

MDM 预读与模块加载并行、Keychain 预取与模块加载并行、API 预连接与 action handler 并行、延迟预取与用户输入并行——每一个可以重叠的时间窗口都被利用了。

### 3. 编译期消除 > 运行时判断

`feature()` 门控在编译期消除死代码，比运行时 `if` 判断更彻底——不仅不执行，连代码本身都不存在于最终产物中。

### 4. 安全约束是不可妥协的

即使在追求极致启动速度的过程中，安全约束也从未被绕过：
- 信任对话框之前不执行 Git 命令
- 信任对话框之前只应用"安全"的环境变量
- Windows PATH 劫持防护在任何命令执行之前

### 5. 可观测性是优化的前提

`profileCheckpoint` 体系、`logForDiagnosticsNoPII` 日志、`CLAUDE_CODE_EXIT_AFTER_FIRST_RENDER` 基准测试——没有测量就没有优化。

---

## 关键源码索引

| 文件 | 职责 | 关键函数/导出 |
|------|------|-------------|
| `entrypoints/cli.tsx` | Bootstrap 入口，快速路径分发 | `main()` |
| `main.tsx` | 完整 CLI 入口，子系统编排 | `main()`, `startDeferredPrefetches()` |
| `entrypoints/init.ts` | 核心初始化序列 | `init()`, `initializeTelemetryAfterTrust()` |
| `bootstrap/state.ts` | 全局状态容器 | `getCwd()`, `getSessionId()`, `setMainLoopModelOverride()` 等 |
| `utils/startupProfiler.ts` | 启动性能打点 | `profileCheckpoint()`, `profileReport()` |
| `utils/earlyInput.ts` | 早期输入捕获 | `startCapturingEarlyInput()`, `seedEarlyInput()` |
| `utils/config.ts` | 配置系统 | `enableConfigs()`, `getGlobalConfig()` |
| `utils/managedEnv.ts` | 环境变量管理 | `applySafeConfigEnvironmentVariables()`, `applyConfigEnvironmentVariables()` |
| `utils/secureStorage/keychainPrefetch.ts` | Keychain 预取 | `startKeychainPrefetch()` |
| `utils/settings/mdm/rawRead.ts` | MDM 设置预读 | `startMdmRawRead()` |
| `migrations/*.ts` | 数据迁移 | 各 `migrate*()` 函数 |
