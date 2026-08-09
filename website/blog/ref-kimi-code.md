---
title: Kimi Code 深入研究（2026-08 快照）
description: 21 章逐节成册，按目录跳章查阅——把 Kimi Code CLI 的产品形态、架构与实现细节交叉核验到版本号级别：17 包 monorepo、双引擎并存（agent-core / agent-core-v2）、DI × Scope 四层作用域、12 节点有序权限链、20 类 Hook 事件、AgentSwarm 128 子代理、Goal 自治模式。这是一份手册，不是读完就走的文章。
date: "2026-08-08"
series: 热点开源项目研究
audience: engineer
highlight: 21 章逐节可查 · 核验至 v0.34.0 · 截至 2026-08-08 快照
tags: [Kimi Code, Moonshot, 深入研究, 权限, Hook, MCP, 参考]
outline: [2, 3]
---

# Kimi Code 深入研究（2026-08 快照）

::: warning 先说清这份东西是什么
**这是一份逐章查阅的手册，不是一篇文章。** 它按章节组织，供你按目录跳到需要的那一节查，
而不是从头读到尾——所以它没有主线，也没有结论。

- **调研日期**：2026-08-08
- **被调研版本**：Kimi Code CLI **v0.34.0**（npm `@moonshot-ai/kimi-code@0.34.0`，2026-08-06 发布），
  源码核验至 `main` 分支 commit `01c74e9`（2026-08-08）
- **证据形态**：**本地源码实查 + 仓库内文档源文件 + GitHub REST API / npm registry 实查**
  （与 `ref-openclaw`、`ref-reasonix` 同一档，强于 Claude Code / Codex / opencode 三篇的
  「公开信息交叉核验」）。**代码结构类断言直接来自本地 clone 的源码**
  （`~/Code/person/github/kimi-code`），凡属源码结论本文都给出 `包/路径:行号`；
  因此文中有若干处是「官方文档这么写，源码实际这样」的对照（§5.2、§10.1）。
  **行为类断言仍以源码与文档为据——我们没有把它跑起来做端到端实测**，
  唯一的例外是 §7.4 的 glob 匹配矩阵（那是把项目锁定版本的 picomatch 单独装出来跑的）。
  每一章都尽量把这个区别标清了，§21 汇总了所有未核验项。
- **一手性说明**：文档类事实取自仓库内 `docs/en/**/*.md` 源文件（不是渲染后的网页）；
  计数类事实全部由脚本从原始表格 `re.findall` 数出，不是目测；
  Star 数 / 语言占比 / 版本时间线取自 GitHub REST API 与 npm registry 实查；
  架构结论取自 `packages/agent-core-v2/` 源码与其内部设计文档
  （`packages/agent-core-v2/docs/`，这批文档**没有发布到官方文档站**）。
- **时效边界**：这个项目非常年轻且发版极快——**2026-05-21 首发，到 2026-08-06 的 77 天里发了 63 个版本**，
  其中 6 月 26 个、7 月 27 个。**这是 2026-08-08 的快照，不是最新状态。**
  任何与当前行为不一致的地方，以[官方文档](https://moonshotai.github.io/kimi-code/en/)为准。

一份标清日期的快照不会变成假话，只会变成史料——但前提是你知道它的日期。
:::

::: danger 三条容易搞错的事（其中两条会让你装错东西 / 配错权限）
1. **`npm i -g kimi-code` 装的不是这个产品。** npm 上的
   [`kimi-code`](https://www.npmjs.com/package/kimi-code)（latest `1.0.11`，2025-09-15 停更）
   是第三方无关包，自述为 *"A CLI tool that starts anthropic-proxy with Kimi model and runs claude-code"*，
   仓库指向 `whitesmith/kimi-code`，依赖 `fastify` / `keytar`。
   本产品的包名是 **`@moonshot-ai/kimi-code`**。见 §1。
2. **官方文档里那条 `Bash(rm -rf*)` 拦不住 `rm -rf /tmp/x`。** 权限规则用 picomatch 做 glob 匹配，
   而 picomatch 的 `*` **不跨 `/`**——实测在项目锁定的 picomatch 4.0.4 上，
   `rm -rf*` 对 `rm -rf /tmp/x` 返回 `false`。这条 deny 规则在 yolo 模式下等于不存在。
   完整实测矩阵与正确写法见 §7，这是本文最该先看的一节。
3. **"三个内置子代理都开箱可用"这句话里，`explore` 的只读是提示词层面的，不是工具层面的。**
   源码里 `EXPLORE_TOOLS` **包含 `Bash`**
   （`packages/agent-core-v2/src/session/agentLifecycle/profile/profiles.ts:71`），
   官方文档自己的措辞也是 "prompt-enforced read-only"。真正靠工具清单锁死只读的是 `plan`。见 §10。

前三篇 ref 的教训是「引用二手分析而不回一手源要付代价」。这一篇的教训换了个方向：
**连一手官方文档也会和源码不一致**——文档是人写的，代码是跑的。
:::

---

## 1. 产品概述与身份辨析

Kimi Code CLI 是 Moonshot AI（月之暗面）推出的终端 AI 编程 agent。仓库
[`MoonshotAI/kimi-code`](https://github.com/MoonshotAI/kimi-code)，MIT 许可。

**GitHub 实查数据（2026-08-08）：**

| 项 | 值 |
| --- | --- |
| 仓库 | `MoonshotAI/kimi-code` |
| 描述 | Kimi Code CLI — The Starting Point for Next-Gen Agents |
| 许可 | MIT |
| Stars | 6,176 |
| Forks | 971 |
| Open issues | 958 |
| 创建时间 | **2026-05-22** |
| 最后 push | 2026-08-08 |
| 默认分支 | `main` |
| 语言占比 | **TypeScript 97.8%**、JavaScript 2.1%，其余 CSS / Nix / Shell / C / HTML / Dockerfile / Makefile 合计不到 0.1% |
| 提交数 | 1,114 |
| 贡献者 | 49 |

**这个项目只有 78 天历史**（2026-05-22 建仓 → 2026-08-08 本快照）。读下面任何一节时都请把这件事
放在心里：它解释了为什么会有两套引擎并存（§3）、为什么文档与源码有对不上的地方（§5、§10）。

### 1.1 包名辨析（装错了不会报错，只会装到别人的东西）

| npm 包 | 是不是这个产品 | 证据 |
| --- | --- | --- |
| **`@moonshot-ai/kimi-code`** | **是** | latest `0.34.0`（2026-08-06），`bin: {kimi: dist/main.mjs}`，MIT |
| `kimi-code` | **不是** | latest `1.0.11`（2025-09-15），描述为 anthropic-proxy + claude-code 包装器，仓库 `whitesmith/kimi-code` |

`kimi-code` 这个名字在仓库里**另有一处占用**：`apps/vscode/package.json` 的 `name` 字段也是
`kimi-code`（version `0.6.7`，`private: true`），那是 VS Code 扩展的标识，不是 npm 发布名。

### 1.2 npm 发布形态

`@moonshot-ai/kimi-code@0.34.0` registry 实查：

| 项 | 值 |
| --- | --- |
| 解包体积 | **55,059,589 字节（约 52.5 MB）**，546 个文件 |
| `dependencies` | **0 个**（全部打进产物） |
| `optionalDependencies` | `@mariozechner/clipboard`、`node-pty` |
| `engines.node` | `>=22.19.0` |
| `bin` | `kimi` → `dist/main.mjs` |

「零 runtime 依赖 + 52.5 MB 单包」是 bundler 全量内联的结果，对应 README 里
"Single-binary distribution / no Node.js setup" 那条卖点。注意 **npm 包本身仍需要 Node ≥ 22.19.0**；
真正"不需要 Node"的是官方安装脚本那条路径（§18.1）。

### 1.3 安装方式

```sh
# 官方脚本（不需要预装 Node）
curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash          # macOS / Linux
irm https://code.kimi.com/kimi-code/install.ps1 | iex                 # Windows PowerShell

# npm 全局
npm install -g @moonshot-ai/kimi-code
pnpm add -g @moonshot-ai/kimi-code
```

Windows 需要先装 [Git for Windows](https://gitforwindows.org/)——Kimi Code 用它自带的 Git Bash
作为 shell 环境；装在非默认位置时用 `KIMI_SHELL_PATH` 指向 `bash.exe` 绝对路径。

### 1.4 产品入口

| 入口 | 形态 | 状态 |
| --- | --- | --- |
| **Terminal TUI** | `kimi` | 核心形态 |
| **非交互模式** | `kimi -p "<prompt>"` | 支持 `text` / `stream-json` 两种输出 |
| **Web UI** | `kimi web` | 本地前台单进程，同源提供 REST + WebSocket + 前端 |
| **ACP（编辑器/IDE）** | `kimi acp` | Zed / JetBrains 等 ACP 客户端，stdio JSON-RPC |
| **VS Code 扩展** | `apps/vscode` | 仓库内 `private: true`，未在 npm 发布 |
| **会话可视化器** | `kimi vis` | 浏览器里看会话展开过程 |

---

## 2. 仓库结构：17 包 monorepo

pnpm workspace，`pnpm-workspace.yaml` 声明的成员是 `packages/*`、`apps/*`、
`apps/vis/server`、`apps/vis/web`、`docs`。实查共 **24 个 package.json**，
其中 `packages/` 下 **17 个**、`apps/` 下 4 个（`vis` 另含 2 个子包）、`docs` 1 个。

**唯一对外发布的包是 `apps/kimi-code`**（`@moonshot-ai/kimi-code`）。
其余 **全部 `private: true`**——包括看起来像通用库的 `kosong`、`minidb`、`pi-tui`。
这一点值得单独点出：README 里把 `pi-tui` 写成来自
[`earendil-works/pi-mono`](https://github.com/earendil-works/pi-mono) 的第三方 TUI 框架并致谢，
但仓库内 `packages/pi-tui` 是 `@moonshot-ai/pi-tui@0.80.8` 且 `private: true`，
即**已 vendor 进仓库自行演进**，不是运行时依赖。

**各包规模实查**（`src/` 下 `.ts`，已排除 `*.test.ts`）：

| 包 | 版本 | 行数 | 文件数 | 职责 |
| --- | --- | --- | --- | --- |
| `agent-core-v2` | 0.3.1 | **107,465** | 782 | 新引擎，DI × Scope 架构（§3、§4） |
| `agent-core` | 0.15.7 | **68,913** | 371 | 旧引擎，仍可用 `KIMI_CODE_LEGACY_FLAG=1` 回退 |
| `apps/kimi-code` | **0.34.0** | 55,891 | 293 | CLI 入口 + TUI，唯一发布包 |
| `kap-server` | 0.2.1 | 31,228 | 139 | `kimi web` 的 REST + WS 服务端 |
| `minidb` | 0.2.0 | 18,862 | 58 | 纯 Node 嵌入式 KV（WAL + snapshot），零原生依赖 |
| `pi-tui` | 0.80.8 | 12,477 | 29 | 差分渲染终端 UI 框架 |
| `kosong` | 0.5.5 | 9,187 | 26 | LLM 抽象层（§8） |
| `node-sdk` | 0.15.3 | 7,242 | 20 | `@moonshot-ai/kimi-code-sdk`（未发布） |
| `acp-adapter` | 0.3.6 | 5,534 | 19 | Agent Client Protocol 适配 |
| `protocol` | 0.5.0 | 5,394 | 42 | REST + WS 协议 schema |
| `oauth` | 0.3.0 | 5,265 | 21 | 托管账号 OAuth（RFC 8628 设备码） |
| `klient` | 0.1.1 | 4,935 | 47 | 契约驱动客户端 SDK，ipc / in-memory 双传输 |
| `tree-sitter-bash` | 0.1.0 | 4,790 | 7 | **纯 TS** bash 解析器，用于命令权限分析（§7.4） |
| `transcript` | 0.0.1 | 3,824 | 23 | 同构 transcript 渲染数据层（L1–L4） |
| `kaos` | 0.1.6 | 2,963 | 11 | 执行环境抽象（Kimi Agent OS） |
| `telemetry` | 0.1.1 | 1,180 | 9 | 遥测基础设施 |
| `migration-legacy` | 0.1.16 | — | — | 把 `~/.kimi/` 老数据迁到 `~/.kimi-code/` |

另有 `acp-server`（0.0.0）与 `apps/kimi-inspect`（0.0.0）两个版本号为 0 的雏形包。

> **两个包名值得记住，因为它们是「自己造轮子」的信号**：`minidb` 是自研嵌入式 KV
> （README 自述混合 Redis 的内存 KV 与 SQLite 的 WAL/snapshot 持久化，零运行时依赖），
> `tree-sitter-bash` 是**纯 TypeScript 重写**的 bash 解析器，
> 自述与 tree-sitter-bash 0.25.0 的 named node types 一一对应，
> 目的明确写着 "built for agent-side command permission analysis"。
> 一个 78 天的项目为了权限分析自己写 bash parser，这个取舍本身就是信息。

---

## 3. 双引擎并存：agent-core 与 agent-core-v2

**这是理解 Kimi Code 当前状态最关键的一节。** 仓库里有两套完整的 agent 引擎，
不是"旧代码没删"，而是**两套都在维护、可通过环境变量切换**。

| | `agent-core`（legacy） | `agent-core-v2`（默认） |
| --- | --- | --- |
| 版本 | 0.15.7 | 0.3.1 |
| 规模 | 68,913 行 / 371 文件 | **107,465 行 / 782 文件** |
| 架构 | 传统分层 | **DI × Scope 四层作用域**（§4） |
| Hook 事件 | **16 个** | **20 个** |
| 何时使用 | `KIMI_CODE_LEGACY_FLAG=1` | 默认 |

**切换开关**：`KIMI_CODE_LEGACY_FLAG`（真值 `1`/`true`/`yes`/`on`），
定义在 `apps/kimi-code/src/cli/experimental-v2.ts:14`。

**默认切换发生在 v0.33.0（2026-08-05）**，changelog 原文：

> Run the CLI surfaces (interactive TUI, `kimi -p`, `kimi acp`, `kimi export`, `kimi provider`)
> on the agent-core-v2 engine by default. Set `KIMI_CODE_LEGACY_FLAG=1` to fall back to the legacy engine.

也就是说**本快照距离 v2 成为默认只有 3 天**。这解释了本文多处「文档与源码不一致」——
文档正在追赶一次刚发生的引擎切换。

### 3.1 哪些入口走哪套引擎

| 入口 | 默认引擎 | `KIMI_CODE_LEGACY_FLAG=1` 时 |
| --- | --- | --- |
| 交互式 TUI（`kimi`） | v2 | legacy |
| `kimi -p` | v2 | legacy |
| `kimi acp` | v2 | legacy（走 SDK harness + `acp-adapter`） |
| `kimi export` | v2 | legacy |
| `kimi provider` | v2 | legacy |
| `kimi doctor` | v2 | legacy |
| **`kimi web`** | **v2（始终）** | **不受影响** |

`kimi web` 永远走 v2——`kap-server` 的 package 描述直接写着
"Kimi Code server backed by the DI × Scope agent engine (agent-core-v2)"。

### 3.2 只有 v2 读的配置（回退即失效）

设了 `KIMI_CODE_LEGACY_FLAG=1` 之后，下面这些配置会被**静默忽略**：

| 配置 | 说明 | 出处 |
| --- | --- | --- |
| `[identity]` | 自定义 agent 名称 / slug | `docs/en/configuration/config-files.md:323` |
| `builtin_product_skills` | 内置产品 Skills 开关 | 同上 `:106` |
| `KIMI_CODE_IDENTITY_NAME` / `_SLUG` | 上面两项的 env 形式 | `env-vars.md:157` |
| `cache_expiry_hint` | 长闲置后的缓存过期提示（`tui.toml`） | 文档标注 "v2 engine only" |
| 4 个新 Hook 事件 | `TurnStarted` / `UserPromptQueued` / `TaskStarted` / `SessionHeartbeat` | §9 |

**「回退开关会让一批配置静默失效」这件事官方文档是逐条标注的**，但分散在 4 个文件里，
没有一处汇总——上表是本文用脚本聚合出来的。

---

## 4. agent-core-v2 的 DI × Scope 架构

这一节的材料来自 `packages/agent-core-v2/docs/`（9 份设计文档 + 3 份 manifest），
**这批文档没有发布到官方文档站**，只存在于仓库里：

| 文件 | 大小 | 内容 |
| --- | --- | --- |
| `rw-model-design.md` | 48,684 B | 读写模型设计 |
| `Permission.md` | 21,524 B | 权限系统设计（§7） |
| `di.md` | 18,930 B | DI 与 Scope 场景化指南 |
| `config-manifest.toml` | 15,849 B | 配置清单 |
| `di-testing.md` | 15,312 B | DI 测试指南 |
| `service-design.md` | 13,790 B | 服务设计规范 |
| `errors.md` | 9,864 B | 错误模型 |
| `flag.md` | 6,889 B | 特性开关 |
| `features.md` | 6,189 B | 特性扩展点 |
| `state-manifest.d.ts` | 62,859 B | 状态清单（生成物） |
| `wire-manifest.d.ts` | 24,761 B | wire 协议清单（生成物） |

### 4.1 四层生命周期作用域

`packages/agent-core-v2/src/app/scopes.ts` 声明了四层，**内核只认识不透明的
`ScopeKind` 字符串加拓扑序**，四层本身是业务概念：

```ts
export enum LifecycleScope {
  App = 'app',             // 进程级，全局一份
  Workspace = 'workspace', // 一个工作区 handler（与 Session 一对多）
  Session = 'session',     // 一次会话
  Agent = 'agent',         // 一个 agent
}
```

Scope 是一棵树，`kind` 沿父子方向严格递增：`App(0) → Workspace(1) → Session(2) → Agent(3)`。
解析服务时容器先看本层，没有就递归问父 scope。由此得到一条**由结构强制、不靠纪律维持**的铁律
（`docs/di.md` 场景 3.2 原文）：

> **短寿命的服务可以注入长寿命的服务，反过来不行。**

- ✅ Agent 服务注入 Session / Workspace / App 服务（往上找，找得到）
- ❌ App 服务注入 Session 服务（App 创建时 Session 还不存在，父不会往下找）

「单例」的粒度是**每个 scope 一份**：App 的 `ILogService` 全进程一份；
每个 Session scope 各有自己的 `ISessionMetadata`。

### 4.2 Workspace 层：为什么会多出这一层

Workspace 与 Session 是**一对多**。App 层的 `workspaceLifecycle` 持有 handler 注册表
（每个 workspaceId 一个 handler，create-or-get + join，**永不关闭**），
每个 handler 的 `sessionLifecycle` 把会话生命周期（create / resume / fork / close / delete）
作为自己的子 scope 管理。

Workspace 层服务持有 handler 共享资源——加载一次，之后由 fs watch 刷新。
`agent-core-v2/AGENTS.md` 列出的 Workspace 层服务有 11 个：

`workspaceSkillCatalog`、`workspaceAgentProfileLoader`、`workspaceInstructions`、
`workspaceMcp`、`workspaceDirs`、`workspaceFs`、`workspaceFsWatch`、`workspaceProcess`、
`workspaceGit`、`workspaceToolPolicy`、`workspaceTrust`。

Session 通过 **5 个 seed-adapter 单元**
（`src/session/sessionSeed/sessionSeedAdapters.ts`）消费这些共享资源：
每个 adapter 用 `@ref` 观察其 workspace 上游、通过 getter 实时读、
底层 generation 切换时重新触发 `onDidChange`。

### 4.3 workspaceTrust：工作区信任

`workspaceTrust` 记录 per-workspace 的信任标记（持久化在 home 下，
按 `encodeWorkDirKey(root)` 作 key）。**未信任时，`workspaceMcpConfig` 跳过项目级 MCP 配置文件**
（`.mcp.json`、`.kimi-code/mcp.json`）。

这是一个实际的安全边界：项目级 `mcp.json` 里的 stdio 条目会在会话启动时执行本地命令
（官方文档在 §MCP 处也有 warning），信任门控让 clone 下来的陌生仓库不会自动跑它声明的 MCP server。
信任状态通过 kap-server 的 `GET|POST /workspaces/{id}/trust` 与
`POST /workspaces/{id}/untrust` 翻转。

v0.33.0 的 changelog 对应条目：*"Ask whether to trust the current folder on startup."*

### 4.4 Service 单元的两阶段构造

`src/_base/di/service.ts` 的 `Service` 基类（继承 `Disposable`）把能力挂在 `this` 上
（`provide` / `effect` / `on` / `get` / `ref`，外加 `name` / `state` / `config`）。
**两阶段构造**：

1. 构造器内 `provide` / `on` / `effect` 只做缓冲（**只写**——此时 `get` / `ref` 会抛错，
   依赖只能走构造器参数）
2. 内核在 `Reflect.construct` 之后绑定运行时，按写入顺序 flush

手动 `new` 出来的实例在任何能力调用上都会抛错——这是一条把「必须走容器」变成运行时错误
而不是约定的设计。

容器**拒绝同步循环依赖**（`docs/di.md` 场景 9），撞上就得重构，不允许用激活方式绕开。

---

## 5. 内置工具系统

### 5.1 官方文档列的 22 个（脚本数出）

`docs/en/reference/tools.md` 的表格共 **22 行**，脚本统计：
**自动允许 16 个、需批准 6 个**。

| 分组 | 工具 | 默认权限 |
| --- | --- | --- |
| **文件**（6） | `Read` | 自动允许 |
| | `Write` | 需批准 |
| | `Edit` | 需批准 |
| | `Grep` | 自动允许（ripgrep） |
| | `Glob` | 自动允许 |
| | `ReadMediaFile` | 自动允许（图片 / **视频**） |
| **Shell**（1） | `Bash` | 需批准 |
| **Web**（2） | `WebSearch` | 自动允许 |
| | `FetchURL` | 自动允许 |
| **Plan**（2） | `EnterPlanMode` | 自动允许 |
| | `ExitPlanMode` | 自动允许（**但需用户确认计划**） |
| **状态**（1） | `TodoList` | 自动允许 |
| **协作**（4） | `Agent` | 自动允许 |
| | `AgentSwarm` | swarm 模式下自动允许，否则需批准 |
| | `AskUserQuestion` | 自动允许 |
| | `Skill` | 自动允许 |
| **后台任务**（3） | `TaskList` | 自动允许 |
| | `TaskOutput` | 自动允许 |
| | `TaskStop` | 需批准 |
| **定时任务**（3） | `CronCreate` | 需批准 |
| | `CronList` | 自动允许 |
| | `CronDelete` | 需批准 |

### 5.2 源码里其实是 26 个：文档漏了 4 个 Goal 工具

`packages/agent-core-v2/src/session/agentLifecycle/profile/profiles.ts:21` 的
`AGENT_TOOLS` 是默认主 agent 的工具清单，脚本数出 **27 项**——
26 个具名工具 + 1 个 `mcp__*` 通配。比文档多出的 4 个是：

| 工具 | 注册位置 |
| --- | --- |
| `CreateGoal` | `src/agent/tools/goal/create-goal/createGoalTool.ts:81` |
| `GetGoal` | `src/agent/tools/goal/get-goal/getGoalTool.ts:43` |
| `UpdateGoal` | `src/agent/tools/goal/update-goal/updateGoalTool.ts:110` |
| `SetGoalBudget` | `src/agent/tools/goal/set-goal-budget/setGoalBudgetTool.ts:101` |

这 4 个是 Goal 自治模式（§11）的机器可读状态接口。**官方 `tools.md` 完全没有提到它们**，
而 Goal 功能在 `slash-commands.md` 里有整节篇幅。合理推断是：Goal 被当作「用户用 `/goal` 驱动」
的功能来写文档，因此它的工具层没进工具参考页。但从模型视角看，它们和别的工具没有区别——
你写权限规则时需要知道它们存在。

::: tip 这处差异我核验到什么程度
`registerAgentToolService` 的调用我用多行正则扫了整个 `agent-core-v2/src`，
得到 20 个具名注册；余下 6 个（`ReadMediaFile`、`EnterPlanMode`、`ExitPlanMode`、
`CronCreate`、`CronList`、`CronDelete`）走别的注册路径
（如 `src/features/plan/planFeature.ts:35`、`src/agent/tools/cron/*/`）。
**我没有逐一核验这 26 个在运行时是否都真的暴露给模型**——
`AGENT_TOOLS` 是 profile 声明的清单，实际可见集还要与 `[tools]` 全局开关（§6.4）
和 agent 自己的 `tools` / `disallowedTools` 求交集。
:::

### 5.3 几个工具的实现细节

**`Read`**：参数 `path` + 可选 `line_offset`（负值从末尾数）+ `n_lines`。
单次上限 **1000 行或 100 KB**，超出附截断提示。检测到图片 / 视频会建议改用 `ReadMediaFile`。

**`Grep`**：调 ripgrep。`output_mode` 三种（`files_with_matches` / `content` / `count_matches`，
默认第一种），`head_limit` 默认 **250**（`0` 为无限）。
**`.env` 与私钥等敏感文件被自动过滤**，`include_ignored=true` 只能放开 `.gitignore`
忽略的文件，**敏感文件仍然过滤**。

**`Glob`**：结果按修改时间倒序，**上限 100 条**。默认尊重 `.gitignore` / `.ignore` / `.rgignore`。

**`ReadMediaFile`**：文件大小上限 **100 MB**。默认读取会压缩到模型限制；
压不到安全范围时**返回错误而不发送原图**，并引导模型自己造一个更小的副本。
是否可用取决于当前模型的 `image_in` / `video_in` 能力。

**`Bash`**：前台默认超时 **60 秒**、最大 5 分钟；后台默认 **10 分钟**。
一个反直觉的默认值：**前台命令超时后默认不被杀掉，而是转为后台任务继续跑**
（受 600s 后台超时约束），由 `[background] bash_auto_background_on_timeout`（默认 `true`）控制，
设为 `false` 才恢复「超时即杀」。stdin 始终关闭——交互式命令立刻收到 EOF。
终止走两阶段：SIGTERM → 5 秒宽限 → SIGKILL。Windows 默认用 Git Bash。

**`CronCreate`**：标准 5 字段 cron（用户本地时区），prompt 上限 8 KB。
**调度器加确定性 jitter 以避免所有用户整点同时触发**：
周期任务前移 `min(周期的 10%, 15 分钟)`；正好落在 `:00` / `:30` 的一次性任务前移最多 90 秒。
错过多次触发（比如笔记本睡眠）时唤醒**只触发一次**，prompt 包在 `<cron-fire>` 信封里带
`coalescedCount`。**存活超过 7 天的周期任务**会带 `stale="true"` 触发最后一次然后自动删除。
单会话最多 **50 个**活动定时任务，`KIMI_DISABLE_CRON=1` 全局关闭。

---

## 6. 配置系统

### 6.1 配置文件位置与拆分

**两个文件，职责分开**（这一点与 Claude Code 单一 `settings.json` 不同）：

| 文件 | 内容 |
| --- | --- |
| `~/.kimi-code/config.toml` | Agent 与运行时配置：providers / models / 权限 / hooks / loop 控制 |
| `~/.kimi-code/tui.toml` | 终端 UI 与客户端偏好：主题 / 编辑器 / 通知 / 自动更新 / 状态栏 |

**格式是 TOML，字段名一律 snake_case**。含 `.` 的 key 必须加引号
（`[models."gpt-4.1"]`），否则 TOML 把 `.` 当嵌套表分隔符。

`KIMI_CODE_HOME` 改变整个数据根目录，配置路径随之变为 `$KIMI_CODE_HOME/config.toml`；
文件名恒为 `config.toml`。

::: warning 没有项目级 config.toml
官方文档明确写着：*"The CLI currently reads a single user-level config file and has no
project-level config file mechanism."* 要按项目隔离配置，只能让
`KIMI_CODE_HOME` 指向不同数据目录。

唯一的项目级文件是 `<project-root>/.kimi-code/local.toml`，
但它**目前只有一个字段** `[workspace] additional_dir`（由 `/add-dir` 自动写入）。
因为存绝对路径，官方建议把它加进 `.gitignore`。
:::

### 6.2 顶层字段（脚本数出 19 个）

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `default_model` | string | — | 默认模型别名，必须在 `models` 里定义 |
| `default_permission_mode` | string | `manual` | `manual` / `yolo` / `auto` |
| `default_plan_mode` | bool | `false` | 新会话是否以 Plan 模式启动 |
| `merge_all_available_skills` | bool | `true` | 是否合并所有可用目录的 Skills |
| `extra_skill_dirs` | string[] | — | 额外 Skill 搜索目录（叠加） |
| `extra_agent_dirs` | string[] | — | 额外 agent 搜索目录（叠加） |
| `builtin_product_skills` | bool | `true` | 内置产品 Skills 开关（**仅 v2**） |
| `telemetry` | bool | `true` | 匿名遥测；仅显式 `false` 才关 |

余下 11 个是嵌套表入口：`providers`、`models`、`thinking`、`loop_control`、
`background`、`tools`、`image`、`services`、`permission`、`hooks`、`identity`。

`config-files.md` 的 `##` 级配置节共 **16 个**（含 `tui.toml` 与被 HTML 注释掉的
`experimental`）：`providers`、`models`、`secondary_model`、`thinking`、`loop_control`、
`token_counting`、`background`、`subagent`、`mcp`、`identity`、`tools`、`image`、
`experimental`、`services`、`permission`、`tui.toml`。

> `[experimental]` 那一节在文档源文件里是被 `<!-- -->` 注释掉的
> （`config-files.md:357`），渲染页上看不到。里面唯一的条目是
> `micro_compaction`（默认 `false`，开启后自动裁剪较旧的大工具结果）。
> **这是「读源文件而非渲染页」才能拿到的东西。**

### 6.3 三类环境变量：不是统一的优先级链

`docs/en/configuration/overrides.md` 把 env 变量的角色拆成三类，并明确说
**它们不能压成一条线性优先级**：

1. **定位配置文件**：`KIMI_CODE_HOME` 决定数据根，在所有其他解析之前运行，
   **不是单个参数的 fallback**
2. **运行时开关**：如 `KIMI_DISABLE_TELEMETRY`，语义是「额外关闭」而非「普通覆盖」——
   即使 `config.toml` 写了 `telemetry = true`，设了这个变量也会关掉
3. **运行时端点与诊断**：`KIMI_CODE_OAUTH_HOST`、`KIMI_CODE_BASE_URL`、`KIMI_LOG_LEVEL` 等，
   在对应子系统初始化时读取

普通运行时参数的优先级只有两级：**命令行选项 > 用户配置文件**。

::: danger 一个高频踩坑：provider 凭证不读 shell 环境变量
`export KIMI_API_KEY=xxx` **不会**被自动读取。官方文档专门为此写了一段
（`overrides.md` 开头就点破："many users run `export KIMI_API_KEY=xxx` in the shell
expecting the CLI to pick it up automatically, but it does not"）。

凭证解析顺序：
1. `[providers.<name>].api_key` 直接字段
2. `[providers.<name>.env]` **子表**里的对应 key（仅当上一步为空时才查）
3. 两者都缺 → **启动失败并报错**

关键在于第 2 步：`[providers.<name>.env]` **只是 config.toml 里的一个 TOML 段**，
它不往 shell 环境写任何东西，也不从 shell 读——名字叫 `env` 容易让人误解。

唯一的例外通道是显式的 `KIMI_MODEL_*` 家族（§6.5）。
:::

### 6.4 `[tools]` 全局工具开关

```toml
[tools]
disabled = ["EnterPlanMode", "ExitPlanMode", "mcp__github__*"]
```

`enabled` 是全局白名单（非空时只有列出的可用），`disabled` 是黑名单、在 `enabled` 之后应用。
它**与每个 agent 自己的 `tools` / `disallowedTools` 求交集**。

**三种永不匹配的写法**会带 warning 报出来（这段值得记，因为直觉全反）：

| 写法 | 实际效果 |
| --- | --- |
| `enabled = ["*"]` | **禁用所有工具**（不是全部启用） |
| `disabled = ["*"]` | **一个都没禁**（不是全部禁用） |
| `mcp__github`（缺 tool 段） | 不匹配；整个 server 要写 `mcp__github__*` |

内置工具按**精确名**匹配（`Read`），MCP 工具用 glob（`mcp__github__*`），**大小写敏感**。

### 6.5 用环境变量定义一个模型：`KIMI_MODEL_*`

这是唯一「env 直接定义配置对象」的通道，共 14 个变量：
`KIMI_MODEL_NAME`、`_API_KEY`、`_PROVIDER_TYPE`、`_BASE_URL`、`_MAX_CONTEXT_SIZE`、
`_CAPABILITIES`、`_DISPLAY_NAME`、`_MAX_OUTPUT_SIZE`、`_REASONING_KEY`、
`_THINKING_EFFORT`、`_ADAPTIVE_THINKING`、`_MAX_COMPLETION_TOKENS`、`_TEMPERATURE`、`_TOP_P`。

注意后 4 个的作用域和前面不同：`KIMI_MODEL_TEMPERATURE` / `_TOP_P` /
`_MAX_COMPLETION_TOKENS` / `_THINKING_EFFORT` 文档标注**只对 `kimi` provider 生效**，
且是**全局的**（与 `KIMI_MODEL_NAME` 无关）。

### 6.6 环境变量总表（脚本数出 61 个）

`env-vars.md` 表格行共 **61 个**变量，分组如下：

| 分组 | 数量 | 举例 |
| --- | --- | --- |
| Provider 凭证 key 名 | 10 | `KIMI_API_KEY`、`ANTHROPIC_API_KEY`、`GOOGLE_CLOUD_PROJECT` |
| `KIMI_MODEL_*` 模型定义 | 14 | 见 §6.5 |
| OAuth / 托管服务 | 3 | `KIMI_CODE_OAUTH_HOST`、`KIMI_OAUTH_HOST`、`KIMI_CODE_BASE_URL` |
| 运行时开关 | 约 20 | `KIMI_CODE_LEGACY_FLAG`、`KIMI_DISABLE_CRON`、`KIMI_SHELL_PATH` |
| 诊断日志 | 5 | `KIMI_LOG_LEVEL`、`KIMI_LOG_GLOBAL_MAX_BYTES` |
| 内置服务端点 | 4 | `KIMI_WEB_SEARCH_BASE_URL` / `_API_KEY`、`KIMI_WEB_FETCH_*` |

两个**已废弃但仍被兼容**的别名（会带启动警告）：
`KIMI_CLI_NO_AUTO_UPDATE`（→ `KIMI_CODE_NO_AUTO_UPDATE`）、
`KIMI_LOOP_MAX_RETRIES_PER_STEP`（→ `KIMI_LOOP_MAX_ATTEMPTS_PER_STEP`）。

---

## 7. 权限系统（本文最该先读的一节）

### 7.1 三种权限模式

| 模式 | 行为 | 入口 |
| --- | --- | --- |
| `manual` | 每次询问（默认） | 默认值 |
| `yolo` | 自动批准**常规**工具调用；**agent 仍可以向你提问** | `/yolo`、`-y` |
| `auto` | 完全无人值守：所有批准自动处理，**包括敏感文件与 Plan 退出**；agent **不会**再问你任何问题 | `/auto`、`--auto` |

源码：`src/agent/permissionMode/configSection.ts:20`，
`z.enum(['manual', 'auto', 'yolo'])`。

**`yolo` 与 `auto` 的差别不是程度而是种类**，这点容易搞混：

- `yolo` 仍会在两处停下来：**访问敏感文件**（`.env`、SSH key）和**退出 Plan 模式**
- `auto` 两处都不停，并且**禁掉了 `AskUserQuestion`**——
  源码里有一条专门的策略 `auto-mode-ask-user-question-deny`
  （`src/agent/permissionPolicy/policies/auto-mode-ask-user-question-deny.ts`）

`--yolo` 与 `--auto` **互斥**，启动时直接拒绝。`--prompt` 不能与 `--yolo` / `--auto` / `--plan`
同用——非交互模式**默认就是 `auto` 权限**。

### 7.2 12 节点有序权限链

`src/agent/permissionPolicy/permissionPolicyService.ts` 的头注释写明这是
"the static, ordered permission chain"。**下面是 `policies` 数组的实际排列顺序**
（`permissionPolicyService.ts:45`），求值是 `for` 循环 **第一个返回非 undefined 的节点胜出**
（`:62`）：

| # | 策略 | 作用 |
| --- | --- | --- |
| 1 | `auto-mode-ask-user-question-deny` | auto 模式**拒绝** `AskUserQuestion` |
| 2 | **`user-configured-deny`** | 用户 deny 规则 |
| 3 | `auto-mode-approve` | auto 模式放行 |
| 4 | `session-approval-history` | 本会话已批准过的同类调用 |
| 5 | `user-configured-ask` | 用户 ask 规则 |
| 6 | `user-configured-allow` | 用户 allow 规则 |
| 7 | `sensitive-file-access-ask` | 敏感文件 → 问 |
| 8 | `git-control-path-access-ask` | 访问 git 控制路径 → 问 |
| 9 | **`yolo-mode-approve`** | yolo 模式放行 |
| 10 | `default-tool-approve` | 工具固有低风险 → 放行（如 `CronList`） |
| 11 | `git-cwd-write-approve` | git 仓库 cwd 内写入 → 放行 |
| 12 | `fallback-ask` | 兜底：问 |

（`policies/` 目录下有 13 个 `.ts`，但 `user-configured-rule.ts` 是三个
`user-configured-*` 共用的匹配辅助函数，不是链上节点——脚本按
`readonly name = '…'` 数出的节点正好 **12** 个。）

**这个顺序里有三处值得记住的设计**：

1. **`user-configured-deny`（#2）在 `auto-mode-approve`（#3）与
   `yolo-mode-approve`（#9）之前** —— 所以用户 deny 规则**优先于两个自动放行模式**。
   §7.4 说的「deny 规则在 yolo 下漏」**不是因为顺序，而是因为 glob 匹配不上**：
   顺序是对的，规则本身没命中。
2. **`sensitive-file-access-ask`（#7）在 `yolo-mode-approve`（#9）之前** ——
   这正是「yolo 仍会在敏感文件处停下来」的实现；而 `auto-mode-approve` 排在 #3、
   在它之前，所以 auto 模式连敏感文件都不问（§7.1）。
3. **`auto-mode-ask-user-question-deny` 排第 1** —— auto 模式禁掉提问是最高优先级，
   保证无人值守不会卡在等待输入上。

### 7.3 规则语法与作用域

```toml
[[permission.rules]]
decision = "allow"        # allow | deny | ask
scope = "user"            # turn-override | session-runtime | project | user（默认 user）
pattern = "Bash(rm -rf*)" # ToolName 或 ToolName(arg-pattern)
reason = "调试用"          # 可选，用于审计
```

**按顺序匹配，第一条命中的生效。**

四种 scope 里，`user-configured-*` 三个策略只认 **3 种**：
`turn-override`、`project`、`user`
（`src/agent/permissionPolicy/policies/user-configured-rule.ts:14`）——
`session-runtime` 不在这个集合里，它走 `session-approval-history` 那条路。

**哪些工具支持参数模式**：多数内置工具定义了自己的匹配主体
（`Bash(command-pattern)`、`Read(path-pattern)`）。
**`AgentSwarm`、MCP 工具、自定义工具只能按工具名匹配**——
写 `AgentSwarm(swarm)` 不会生效。MCP 工具的参数也不参与权限匹配。

### 7.4 ⚠️ `Bash(rm -rf*)` 拦不住 `rm -rf /tmp/x`

**官方文档 `config-files.md` 的权限示例里，写了两次这条规则**：

```toml
[[permission.rules]]
decision = "deny"
pattern = "Bash(rm -rf*)"
```

**它匹配不到 `rm -rf /tmp/x`。**

原因是匹配实现：`Bash` 的 `matchesRule` 闭包
（`src/agent/tools/os/bash/bashTool.ts:186`）调
`matchesGlobRuleSubject(ruleArgs, args.command)`，后者
（`src/tool/rule-match.ts:148`）最终落到 **picomatch 的 `isMatch`**。
而 picomatch 是**路径 glob**——`*` **不跨 `/`**。

我在项目锁定的 **picomatch 4.0.4**（`packages/agent-core-v2/package.json:78` 声明 `^4.0.4`，
`pnpm-lock.yaml:7800` 锁定 `4.0.4`）上实测：

| 规则 pattern | 命令 | 匹配？ |
| --- | --- | --- |
| `rm -rf*` | `rm -rf /tmp/x` | **false** ← 官方示例，不生效 |
| `rm -rf*` | `rm -rf x` | true（无 `/` 才匹配） |
| `rm -rf**` | `rm -rf /tmp/x` | **false**（`**` 也救不了） |
| `rm *` | `rm -rf /tmp/x` | **false** ← 他们自己测试里用的写法 |
| `rm *` | `rm file.txt` | true |
| `rm -rf /**` | `rm -rf /tmp/x` | **true** ← 可用写法 |
| `**` | `rm -rf /tmp/x` | true |

（`rm *` 那条出现在 `packages/agent-core-v2/test/agent/permissionRules/permissionRules.test.ts:22`，
是他们自己单测里的 `denyRule`。该测试用的是构造好的匹配上下文，
并不断言"`rm *` 能拦住带路径的 rm"，所以测试通过与这个结论并不矛盾。）

**第二个问题：不做命令拆分。** `matchRuleSubjects`
（`src/tool/rule-match.ts:162`）的全部逻辑就是「取整条命令串、可选 `!` 取反、
交给 picomatch」——**没有按 `&&` / `;` / `|` 拆分子命令**。所以：

| 规则 | 命令 | 匹配？ |
| --- | --- | --- |
| `git push*` | `git push origin main` | true |
| `git push*` | `cd /x && git push origin main` | **false** ← 加个前缀就绕过 |

**这意味着基于 deny 规则的命令黑名单在语义上是不完整的**：
`sh -c "rm -rf /"`、`ls && rm -rf /tmp/x`、多一个空格的 `rm  -rf` 都不匹配。

::: warning 这个结论的边界，说清楚
- **✅ 已核验**：picomatch 4.0.4 的匹配行为（实测矩阵如上）；
  `bashTool.ts:186` 把整条 `args.command` 作为匹配主体；
  `matchRuleSubjects` 无拆分逻辑；官方文档确实推荐 `Bash(rm -rf*)`。
- **❌ 未核验**：**我没有真的跑一次 Kimi Code 去验证 `rm -rf /tmp/x` 会被放行**。
  依赖未安装（仓库无 `node_modules`），我是分别验证「匹配层行为」与「调用链」后推断的。
  不过在写完 §7.2 之后这个推断变强了：我已经读完 `policies` 数组的全部 12 个节点，
  **链上没有任何「危险命令硬编码黑名单」**——
  唯一能拦住 `rm -rf` 的就是 `user-configured-deny` 这条走 glob 匹配的路。
  也就是说：若 glob 不命中，链上没有第二道防线接手。
- **一个真实的缓解因素**：`Bash` 的默认权限是**需批准**。
  所以在默认 `manual` 模式下，这条 deny 规则失效不会导致命令静默执行——你还是会被问。
  **它真正咬人的场合是 `yolo` / `auto` 模式**，或者当你写了
  `Bash` allow 规则、只想用 deny 挖个洞的时候：那个洞是漏的。
- 仓库里有 `@moonshot-ai/tree-sitter-bash`（纯 TS bash 解析器，自述用途正是
  "agent-side command permission analysis"）和 `src/app/bashParser/`，
  它**具备**做子命令拆分的能力（其单测
  `bashParserService.test.ts:43` 断言 `git status && rm -rf /` 被拆成两条），
  **但我没有找到它被接进 `matchesRule` 这条权限匹配链的证据**。
  也就是说：能力已经造好了，权限匹配这条路上还没用上。
:::

**如果你现在要配 deny 规则，可用的写法**：

```toml
# 用 /** 覆盖带路径的形态
[[permission.rules]]
decision = "deny"
pattern = "Bash(rm -rf /**)"

# 更稳的做法：不依赖命令串匹配，改用 Hook 做拦截（§9.4）
# 或者干脆不给 Bash 开 allow，保持默认「需批准」
```

### 7.5 敏感文件保护（这一层做得扎实）

与上面的规则匹配相反，**敏感文件检测这层实现得相当细**。
`src/tool/path-access.ts` 的 `isSensitiveFile()`：

**基础名黑名单**：`.env`、`id_rsa`、`id_ed25519`、`id_ecdsa`、`credentials`

**路径后缀**：`.aws/credentials`、`.gcp/credentials`（结尾或中间段都算）

**前缀 + 变体后缀**：`id_rsa` / `id_ed25519` / `id_ecdsa` / `credentials` 之后跟
`-`、`_`，或跟这 10 个后缀之一——
`.bak`、`.backup`、`.copy`、`.disabled`、`.key`、`.old`、`.orig`、`.pem`、`.save`、`.tmp`。
所以 `id_rsa.bak`、`credentials_prod` 都会被拦。

**两组显式豁免**（这是"细"的体现）：
- `.env.example`、`.env.sample`、`.env.template` → **不算敏感**（模板文件本该能读）
- `id_rsa.pub`、`id_ed25519.pub`、`id_ecdsa.pub` → **不算敏感**（公钥本该能读）

匹配**大小写不敏感**（内部先 `toLowerCase()`）。

**工作区路径守卫**同文件，几个设计点值得记：
- **规范化是纯词法的**（no `realpath` / 不跟随符号链接）——文件头注释明确标注了这一点，
  意味着符号链接逃逸不在这层的防护范围内
- **共享前缀逃逸被堵住**：`/workspace-evil` 不会通过对 `/workspace` 的朴素
  `startswith` 检查——`isWithinDirectory` 要求 base 前缀之后必须是路径分隔符或完全相等
- **host-aware**：调用方传入当前 `IHostEnvironment` 的 path class，
  所以 SSH 路径在 Windows 宿主上也保持 POSIX 语义

---

## 8. 模型与 Provider

### 8.1 六种 provider 类型

`providers` 表的 `type` 字段决定协议实现（脚本数出 **6 种**）：

| type | 协议 | 典型用途 |
| --- | --- | --- |
| `kimi` | OpenAI 兼容 | Kimi Code 托管服务、Kimi 开放平台 API key |
| `anthropic` | Anthropic Messages | Claude 系列 |
| `openai` | OpenAI Chat Completions | OpenAI 及兼容服务、DeepSeek、Qwen |
| `openai_responses` | OpenAI Responses API | OpenAI 较新的 Responses 接口 |
| `google-genai` | Google GenAI | Gemini API |
| `vertexai` | Google GenAI on Vertex | Google Cloud Vertex AI |

所有 provider **默认流式**。thinking / vision / tool use 等能力**按模型名前缀自动匹配**，
通常不需要手写。`kimi` 类型额外支持**视频上传**。

对比：opencode 那篇写的是 75+ provider（走 models.dev 目录），
Kimi Code 是 6 种**协议实现**——两个数字不是一回事。
Kimi Code 通过 `/provider` 交互式管理器从 [models.dev](https://models.dev/) 拉模型目录，
但落地时仍归到上面 6 种协议之一：
目录未声明协议的厂商（xai、openrouter 等）**按 OpenAI 兼容导入并标注 "guessed"**；
私有协议（Amazon Bedrock、Cohere）**直接拒绝**；deprecated / alpha 状态的模型不进导入列表。
**公开目录不可达时回落到内置快照**，所以离线也能导入。

### 8.2 默认模型（来自官方配置示例）

| 别名 | model | 上下文 | capabilities |
| --- | --- | --- | --- |
| `kimi-code/k3` | `k3` | **1,048,576**（1M） | thinking, always_thinking, image_in, video_in, tool_use |
| `kimi-code/kimi-for-coding` | `kimi-for-coding` | 262,144（256K） | 同上 |
| `kimi-code/kimi-for-coding-highspeed` | `kimi-for-coding-highspeed` | 262,144 | 同上 |

`k3` 还带 `support_efforts = ["max"]` / `default_effort = "max"`。
注意 `always_thinking` 这个 capability——**thinking 是默认开着的**。

托管服务的 `base_url` 是 `https://api.kimi.com/coding/v1`；
`kimi` provider 的默认 `base_url` 是 `https://api.moonshot.ai/v1`。

### 8.3 `kosong`：LLM 抽象层

`packages/kosong`（9,187 行）自述是 "The LLM abstraction layer for modern AI agent
applications"。它是 provider 协议差异的收敛点，
`agent-core-v2` 里通过 `src/app/kosongConfig` 包装消费。

### 8.4 secondary model：给子代理用的便宜模型

`[secondary_model]` 配置一个**新建子代理默认绑定**的模型，
需要开启 `secondary-model` 实验开关。
`/secondary_model` 命令写入这一节并立即对当前会话生效。

`Agent` / `AgentSwarm` 的 `model` 参数可取 `"secondary"` / `"primary"`，
**显式值覆盖 agent profile 的 `model_preference`**；两者都没有时，
**已配置的 secondary model 就是默认**，没配则继承调用方的模型。
resume 已有子代理时 `model` 被忽略——**恢复的子代理保留自己原来的模型**。

env 形式：`KIMI_SECONDARY_MODEL`、`KIMI_SECONDARY_EFFORT`、
`KIMI_CODE_EXPERIMENTAL_SECONDARY_MODEL`。

### 8.5 thinking 与 token 计数

`[thinking]`：`enabled`（默认 true）、`effort`、`keep`（`all` / 其他）。

`[token_counting] strategy` 三选一，决定**对外显示**的上下文用量口径：

| 值 | 含义 |
| --- | --- |
| `measured+estimated`（默认） | provider 报的已用量 + 未测量尾部的估算，并以最后一次实测总量兜底 |
| `measured` | 只用 provider 报的用量——显示只在一次交换完成后才动 |
| `estimated` | 纯估算、忽略 provider 用量——给不报或报不准的 provider 兜底 |

**内部逻辑（自动压缩触发、预算、溢出退避）始终同时用实测与估算两种**，
不受这个设置影响。这是个值得注意的设计：显示口径与决策口径分离。

### 8.6 重试语义

`[loop_control]`：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `max_steps_per_turn` | — | 每轮最大步数；未设或 `0` 为无限 |
| `max_attempts_per_step` | `10` | 失败步骤的总尝试次数（**含首次**） |
| `reserved_context_size` | — | 为输出预留的 token；剩余窗口低于此值触发自动压缩 |

**只对瞬时失败重试**：连接错误、超时、HTTP 429、5xx。
**配额耗尽或余额不足导致的 429 不重试、立即失败**——
因为在充值之前不可能成功。这条区分做得对。

---

## 9. Hook 系统

### 9.1 20 类事件（v2）/ 16 类（legacy）

脚本从两套引擎的源码 `HOOK_EVENT_TYPES` 常量数出：

| 引擎 | 文件 | 事件数 |
| --- | --- | --- |
| `agent-core-v2` | `src/agent/externalHooks/types.ts:3` | **20** |
| `agent-core` | `src/session/hooks/types.ts:3` | **16** |

**v2 独有的 4 个**：`TurnStarted`、`UserPromptQueued`、`TaskStarted`、`SessionHeartbeat`。
（v1 没有 v2 之外的事件——v2 是严格超集。）
官方文档 `hooks.md` 的事件参考表也是 20 行，与 v2 源码一致。

**只有 3 个事件可以阻断**：`UserPromptSubmit`、`PreToolUse`、`Stop`。
其余 17 个是**纯观察事件**——fire and forget，脚本返回什么都不影响主流程。

| 事件 | matcher 匹配什么 | 可阻断 | 备注 |
| --- | --- | --- | --- |
| `UserPromptSubmit` | 用户提交的文本 | **✓** | 返回的文本会追加进上下文；阻断则本轮不调模型 |
| `PreToolUse` | 工具名 | **✓** | **在权限检查之前**触发 |
| `Stop` | 空串 | **✓** | 模型将要结束本轮时；阻断可追加消息让模型继续 |
| `UserPromptQueued` | 排队的 prompt 文本 | — | 载荷含 `prompt_id` / `prompt` / `queue_length` |
| `TurnStarted` | turn 来源（`user` / `task` / `system_trigger`） | — | 载荷含 `turn_id` / `origin_kind` / `origin_name` / `prompt` |
| `PostToolUse` | 工具名 | — | 成功后 |
| `PostToolUseFailure` | 工具名 | — | 失败**或被阻断**后 |
| `PermissionRequest` | 工具名 | — | 即将等待用户批准前 |
| `PermissionResult` | 工具名 | — | 批准完成后 |
| `SessionStart` | `startup` / `resume` | — | 载荷含 `source` / `model` / `profile` |
| `SessionEnd` | `exit` / `archive` | — | `archive` 表示归档而非退出 |
| `SessionHeartbeat` | 空串 | — | **每 60 秒**；**只在配置了该事件时才启动这个定时器** |
| `SubagentStart` | 子代理名 | — | |
| `SubagentStop` | 子代理名 | — | 成功完成后 |
| `TaskStarted` | 任务种类（`agent` / `process` / `question`） | — | 载荷含 `task_id` / `description` / `detached` |
| `StopFailure` | 错误类型 | — | 本轮因错误失败后 |
| `Interrupt` | 空串 | — | **用户主动打断**（Esc）；超时等程序化 abort 不触发 |
| `PreCompact` | `manual` / `auto` | — | **返回值完全被忽略** |
| `PostCompact` | `manual` / `auto` | — | |
| `Notification` | 通知类型 | — | 如 `task.completed` |

> **`Interrupt` 与 `Stop` 的关系值得单独记**：用户打断时 **`Stop` 不触发**，
> 由 `Interrupt` 代替。如果你用 `Stop` 做「轮次结束后跑 lint」，
> 被打断的轮次不会触发它。

### 9.2 配置格式：只允许 4 个字段

```toml
[[hooks]]
event = "PreToolUse"      # 必填，必须是上表之一
matcher = "Bash"          # 可选，正则；省略则匹配全部
command = "node ~/.kimi-code/hooks/check-bash.mjs"   # 必填
timeout = 5               # 可选，秒，1–600，默认 30
```

**`[[hooks]]` 只允许这 4 个字段，多写任何字段会导致整个配置文件加载失败。**
（注意：v2 的 `HookDef` 接口里还有 `cwd` / `env` 两个字段，
但文档明确说配置层只接受 4 个——推测是内部/插件通道用的。）

多条规则命中同一事件时**全部并行执行**；**`command` 完全相同的多条规则只跑一次**。
工作目录是当前会话的项目目录。非 Windows 平台上 hook 进程被放进**独立进程组**，
超时先发信号给清理机会，再强制终止。

### 9.3 返回值协议

| 退出码 | 含义 | CLI 行为 |
| --- | --- | --- |
| `0` | 允许 | 继续；stdout 内容**可能**被追加进上下文 |
| `2` | **有意阻断** | 停止当前操作；**stderr** 作为阻断原因 |
| 其他非零 | 脚本出错 | **默认允许**（fail-open） |
| 超时 / 崩溃 | 脚本异常 | **默认允许**（fail-open） |

也可以用 stdout 返回 JSON 来阻断：

```json
{
  "hookSpecificOutput": {
    "permissionDecision": "deny",
    "permissionDecisionReason": "Please use rg instead of grep"
  }
}
```

**stdin 传入的事件数据**用 snake_case，基础字段：
`hook_event_name`、`session_id`、`session_title`、`client_type`、`cwd`，
各事件另加自己的字段。

### 9.4 fail-open：官方自己写了免责声明

`hooks.md` 里有一段 warning，值得原样引用（这是少见的诚实）：

> Precisely because of fail-open, Hooks are suitable for alerts and lightweight interception,
> but **should not be used as the sole security barrier**. For truly high-risk operations,
> rely on permission approvals and manual confirmation.

**把 §7.4 与这里连起来看，会得到一个不太舒服的结论**：
命令黑名单在权限规则层因为 glob 语义而漏（`rm -rf*` 不匹配带路径的命令），
在 Hook 层则因为 fail-open 而不能当唯一防线。
**两层都不适合单独承担「禁止危险命令」这件事**——
剩下的可靠手段就是保持 `Bash` 默认的「需批准」，即不要在 `yolo`/`auto` 下跑不受信任的任务。

不过 `PreToolUse` 有一个实际优势弥补了 §7.4 的缺陷：**它在权限检查之前触发，
拿到的是完整的工具输入**，所以你可以在脚本里用真正的字符串包含判断
（而不是 glob）来拦命令。官方给的示例正是这个用法：

```toml
[[hooks]]
event = "PreToolUse"
matcher = "Bash"
command = "node ~/.kimi-code/hooks/check-bash.mjs"
timeout = 5
```

脚本里 `if (/rm\s+-rf/.test(command)) { console.error('Blocked'); process.exit(2) }`——
正则比 picomatch glob 更适合这件事。**代价是 fail-open：脚本本身崩了就等于没拦。**

---

## 10. 子代理系统

### 10.1 三个内置子代理，但只读性的实现方式不同

| 名称 | 工具数 | 只读靠什么 | 定位 |
| --- | --- | --- | --- |
| `coder` | **22**（含 `mcp__*`） | 不只读 | 默认子代理，唯一带文件编辑工具的 |
| `explore` | **7** | **提示词** | 代码库探索 |
| `plan` | **6** | **工具清单** | 实现规划与架构设计 |

源码位置：`coder` / `explore` 在
`src/session/agentLifecycle/profile/profiles.ts`，
`plan` 在 `src/features/plan/profile/plan.ts`（**不在同一个文件**，
因为 plan 是一个 feature 扩展点）。

**`explore` 的工具清单包含 `Bash`**（`profiles.ts:71`）：

```ts
const EXPLORE_TOOLS = [
  'Bash',        // ← 在这里
  'Read', 'ReadMediaFile', 'Glob', 'Grep', 'WebSearch', 'FetchURL',
] as const;
```

官方 `agents.md` 对 `explore` 的描述是
*"performs read-only operations only and does not modify any files"*，
但 profile 自己的 `description` 用词是
**"Fast codebase exploration with prompt-enforced read-only behavior"**——
`prompt-enforced` 这个词很准确，只是它出现在源码里而不是用户文档里。

**`plan` 则是真的锁死了**：`PLAN_TOOLS` 只有 6 个，**没有 `Bash`、没有 `Write`/`Edit`**，
且它的角色提示词额外强调：
*"You are a read-only planning agent... you have no shell and no file-editing tools.
Where the general instructions tell you to make changes with tools, that does not apply to you."*

> **实践含义**：如果你需要「保证不动文件」的探索，用 `plan` 而不是 `explore`。
> `explore` 快，但它手里有 shell——提示词能不能拦住取决于模型听不听话。

### 10.2 coder 的 summary 门槛：太短会被打回

`profiles.ts` 里 `coder` 带 `DEFAULT_SUMMARY_POLICY`：

```ts
const DEFAULT_SUMMARY_POLICY = {
  minChars: 200,
  continuationPrompt: SUMMARY_CONTINUATION_PROMPT,
  retries: 1,
} as const;
```

配套的角色提示词说明了为什么：

> Your final message is the entire handoff — the parent sees nothing else from your run.
> ... A final message of only a sentence or two is treated as too brief and
> **sent back to you for expansion, costing an extra turn**.

**少于 200 字符的最终消息会被打回重写一次**（`retries: 1`）。
这是一个用机械阈值兜住「子代理偷懒返回一句话」的设计——
代价是多一轮 token。`explore` 与 `plan` 没有这个策略。

### 10.3 上下文隔离

每个子代理有**完全独立的上下文窗口**，只能看到主 agent 显式传入的任务描述，
看不到主 agent 的对话历史；它自己的中间推理与工具调用记录**不回流**，
只有最终结果进入主 agent 上下文。

**权限继承**：主 agent 通过 `/permission` 或批准对话框接受的「总是允许」规则
**自动传播到它派发的所有子代理**，子代理不需要重新批准同类调用。
`Agent` 工具本身默认允许。反过来说：**要让某类工具在子代理里永久不可用，
不能靠不批准，得收紧 agent 文件的 `disallowedTools` 或全局 `[tools] disabled`。**

### 10.4 超时：2 小时，但 print 模式下是无限

`[subagent] timeout_ms` 默认 **7,200,000 ms（2 小时）**，`0` 为无超时。
**`kimi -p` 非交互模式下默认是 `0`（无超时）**，除非显式设置。
超过 `2147483647`（约 24.8 天）的值被运行时钳到约 24.8 天。
env 覆盖：`KIMI_SUBAGENT_TIMEOUT_MS`。

### 10.5 AgentSwarm：批量子代理

`AgentSwarm` 从一个 `prompt_template` + `items` 数组批量启动子代理，
或通过 `resume_agent_ids` 恢复已有子代理，或两者混用。

| 约束 | 值 |
| --- | --- |
| 模板必须含 | `{{item}}` 占位符 |
| 无 `resume_agent_ids` 时最少 items | **2** |
| 总子代理上限 | **128** |
| 默认并发 | **无上限**（爬坡式） |
| 并发上限 env | `KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY`（正整数，**非法值直接 fail fast**） |

源码：`src/session/swarm/agentRunBatch.ts:640` 的 `resolveSwarmMaxConcurrency()`——
未设或空串返回 `undefined`（无上限），非正整数**抛 `VALIDATION_FAILED`**。

**一个重要的调用约束**：*"If a model response calls `AgentSwarm`,
that call must be the only tool call in the response."*
要跑多个 swarm 只能串行——调一个、等结果、再调下一个。

权限上：`AgentSwarm` **只能按工具名匹配**，`AgentSwarm(swarm)` 这种参数模式不支持。
在 `manual` 模式下，**swarm 模式未激活时**的 `AgentSwarm` 调用需要批准；
**swarm 模式激活期间它自动批准**。用 `/swarm on|off` 或 `/swarm <task>` 控制。

### 10.6 自定义 agent

agent 文件是带 YAML frontmatter 的 Markdown，**8 个字段**（脚本数出）：

| 字段 | 说明 |
| --- | --- |
| `name` | agent 标识 |
| `description` | 描述 |
| `whenToUse` | 何时使用（供主 agent 判断） |
| `override` | 是否覆盖同名内置 profile |
| `model_preference` | 模型偏好（被 `Agent` 的显式 `model` 参数覆盖） |
| `tools` | 工具白名单 |
| `disallowedTools` | 工具黑名单 |
| `subagents` | 可派发的子代理集合 |

**目录发现**：项目级 > 用户级 > `extra_agent_dirs`。
`--agent <name>` 指定主 agent，`--agent-file <path>` 从 Markdown 加载；
两者都不能与 `--session` / `--continue` 同用，`--agent-file` 也不能重复或与 `--agent` 同用。

**用 `SYSTEM.md` 覆盖主 agent 系统提示词**是一个单独的机制（`docs/en/customization/agents.md` 有专节），
`[identity] name` 会填充其中的 `${product_name}` 槽位。

---

## 11. Goal 自治模式

一个跨轮次持续、由 agent 自己判断是否达成的目标。

> **不要把它当成 Kimi Code 独有**：同系列的 `ref-codex` 已经记录了 Codex 也有
> `/goal` 持续目标（跨 turn / 暂停 / 压缩存活），并在对比表里把 Claude Code 标为
> 「无同类一等对象」。**所以「长时自治目标」这个能力至少两家都有，
> 命令名还都叫 `/goal`。** 我没有核验两者的语义差异（状态机、预算、排队是否一致），
> 因此这里只描述 Kimi Code 的实现，不做谁更强的判断。

普通 prompt 说「接下来做什么」，goal 说「什么必须变成真」。
Kimi Code 保存目标、作为下一条用户消息发出、进入 goal 模式，
**每轮结束后检查目标是 complete / blocked / paused / 仍 active**。

### 11.1 生命周期与三种停止方式

| 命令 | 作用 | 可用性 |
| --- | --- | --- |
| `/goal <objective>` | 启动 | 空闲时 |
| `/goal` 或 `/goal status` | 显示目标、状态、耗时、轮数、token 数 | 总是可用 |
| `/goal pause` | 暂停但保留 | 总是可用 |
| `/goal resume` | 恢复 paused 或 blocked 的目标 | 空闲时 |
| `/goal cancel` | 删除当前目标（**不可恢复，需确认**） | 总是可用 |
| `/goal replace <objective>` | 换成新目标 | 空闲时 |
| `/goal next <objective>` | **排队**下一个目标 | 总是可用 |
| `/goal next manage` | 打开排队目标管理器 | 总是可用 |

**三种停止方式**：

- **complete**：目标达成，清除目标，agent 总结如何完成的
- **paused**：你暂停了、打断了本轮、恢复了一个带活动目标的会话，
  或**撞上模型 / provider / 运行时错误**
- **blocked**：需要你输入、按当前表述无法完成、或**触及预算上限**；
  agent 会写一段简短说明为什么卡住

### 11.2 目标排队

`/goal next` 排队的目标**在当前目标运行期间对 agent 不可见**。
当前目标完成后，Kimi Code 以「用户输入 `/goal <objective>`」的同样方式启动第一个排队目标。

**但当前目标 paused / canceled / blocked 时，不会启动下一个**——
blocked 且有排队目标时，TUI 会提醒你它们在等待。

排队管理器的键位：`↑`/`↓` 浏览，`Space` 选中待移动，选中后 `↑`/`↓` 重排，
`E` 编辑，`D` 删除，`Esc` 取消；编辑时 `Shift-Enter` / `Ctrl-J` 换行，`Enter` 保存。

### 11.3 四个 Goal 工具（文档未列，见 §5.2）

模型侧通过 4 个工具读写目标状态：`CreateGoal`、`GetGoal`、`UpdateGoal`、`SetGoalBudget`。
`SetGoalBudget` 对应文档里提到的 token 预算——
配置了预算的目标会在 Web UI 里显示进度条，没配的不显示。
**触及预算上限会让目标进入 blocked。**

### 11.4 非交互模式下的退出码

`kimi -p` 里**只支持创建目标**（`/goal next` 等管理命令是 TUI 控件）：

```sh
kimi -p "/goal Fix the failing checkout test"
```

**退出码有语义**，这对 CI 编排很有用：

| 退出码 | 含义 |
| --- | --- |
| `0` | 目标 complete |
| `3` | 目标 blocked |
| `6` | 目标 paused |

### 11.5 官方自己给的反例（值得照抄进你的规范）

`goals.md` 罕见地花了大篇幅写**什么时候不要用 goal**，并给了三个具名反例：

| 反例 | 会发生什么 |
| --- | --- |
| `/goal Greetings!` | 非目标，agent **立即标记 complete** |
| `/goal Prove 1 + 1 = 3.` | 看起来不可能，agent **标记 blocked** |
| `/goal Create a videogame in a single HTML file.` | 目标含糊，**可能跑很久后给出意外结果** |

它还点破了 `/goal Find all bugs in this codebase.` 这类的问题：
「没说什么算成功、该查什么、何时停」——agent 可能立刻 block，也可能跑得远超预期。

**停止条件要写进目标本身**：`/goal` **没有独立的 stop-limit 参数**。
官方示例的写法是把它塞进自然语言：
`/goal Update the checkout docs, run docs build, and stop if still blocked after 20 turns`。

::: warning goal + 权限模式的组合风险
`manual` 模式下 goal 工作会**因为工具批准而暂停**——所以无人值守跑 goal 需要
`yolo` 或 `auto`。而 §7.4 的结论是：那两个模式下命令 deny 规则是漏的。

**「无人值守的自治目标」与「命令黑名单不可靠」这两件事叠在一起，
是本文我最想让你带走的一条实践结论**：
goal 模式请在容器 / 沙箱 / 干净 worktree 里跑，不要靠 deny 规则兜底。
官方文档自己的措辞也是 "use a permission mode that matches the risk of the repository"。
:::

---

## 12. 斜杠命令

脚本从 `slash-commands.md` 表格数出：**53 行、45 个唯一基础命令、13 个别名**。

### 12.1 账号与配置（10）

| 命令 | 别名 | 说明 | 流式中可用 |
| --- | --- | --- | --- |
| `/login` | — | OAuth 设备码流程 或 Kimi 平台 API key | 否 |
| `/logout` | — | 清除当前账号凭证 | 否 |
| `/provider` | — | 交互式 provider 管理器 | **是** |
| `/model` | — | 切换当前会话模型 | **是** |
| `/secondary_model` | — | 配置子代理默认绑定的次要模型（需实验开关） | **是** |
| `/settings` | `/config` | TUI 内设置面板 | **是** |
| `/experiments` | `/experimental` | 实验特性面板 | **是** |
| `/permission` | — | 选择权限模式 | **是** |
| `/editor` | — | 配置 `Ctrl-G` 启动的外部编辑器 | **是** |
| `/theme` | — | 切换配色主题 | **是** |

### 12.2 会话管理（13）

| 命令 | 别名 | 说明 |
| --- | --- | --- |
| `/new` | `/clear` | 新会话，丢弃当前上下文 |
| `/sessions` | `/resume` | 浏览历史会话并切换/恢复 |
| `/tasks` | `/task` | 后台任务列表 |
| `/fork` | — | 从当前会话分叉（**你留在原会话**） |
| `/title [<text>]` | `/rename` | 查看/设置标题（上限 200 字符） |
| `/compact [<instruction>]` | — | 压缩上下文，可带保留提示 |
| `/undo [<count>]` | — | 撤销最近的 prompt |
| `/reload` | — | 重载会话并应用最新 `config.toml` + `tui.toml` |
| `/reload-tui` | — | **只**重载 `tui.toml` |
| `/init` | — | 分析代码库并生成 `AGENTS.md` |
| `/export-md [<path>]` | `/export` | 导出为 Markdown |
| `/export-debug-zip` | — | 导出调试 ZIP（同 `kimi export`） |
| `/copy` | — | 复制最后一条助手消息到剪贴板 |

**`/undo` 的边界值得记**：**上一次压缩之前的 prompt 无法撤销**；
撤销会同时回滚那些 prompt 产生的 todo 列表与 plan 模式状态，
**但不会回滚代码改动**。

**`/fork` 在 v0.33.0 改过语义**：changelog 原文
*"`/fork` no longer switches to the forked session: the current session stays active
and its background tasks keep running."* 分叉后去 `/sessions` 里找那个副本。
另外**保存的 `/goal` 不会复制到分叉**。

### 12.3 模式与运行控制（7）

`/add-dir [<path>]`、`/web`、`/yolo [on|off]`、`/auto [on|off]`、
`/plan [on|off]`、`/plan clear`、`/swarm on|off`、`/swarm <task>`。

### 12.4 信息与状态（8）

`/help`（别名 `/?`、`/h`）、`/btw [question]`、`/usage`、`/status`、
`/mcp`、`/plugins`、`/version`、`/feedback`（别名 `/bug`）。

`/btw` 是个有意思的设计：**在流式输出期间也能问的旁路问题**。
`/feedback` 在 v0.33.0 加了 `/bug` 别名。

### 12.5 退出（1）

`/exit`，别名 `/q`、`/quit`。

### 12.6 五个内置产品 Skill 命令

这五个是**以 Skill 形式实现的内置命令**，由 `builtin_product_skills`（默认 `true`）控制：
`/mcp-config`、`/custom-theme [<text>]`、`/update-config`、
`/check-kimi-code-docs`、`/import-from-cc-codex`。

关掉这个开关会把它们的名称与描述从系统提示词里摘掉（省 token），
代价是失去这些任务的引导流程。**这个开关只有 v2 引擎读**。

> `/import-from-cc-codex` 值得单独提：**从 Claude Code / Codex 导入配置**。
> 一个 78 天的新产品把「从竞品迁移」做成内置 Skill，这个产品判断挺直接。

### 12.7 Skill 动态命令

活跃的 Skill 自动注册为斜杠命令：

| 形态 | 调用方式 |
| --- | --- |
| 普通外部 Skill | `/skill:<name>` |
| 外部子 Skill | 点号形式 `/parent.child` |
| 内置 Skill | 直接 `/<name>` |
| 外部 Skill 名不与系统命令冲突时 | 可省略前缀，直接 `/<name>` |

`/sub-skill` 也在命令表里。**不匹配任何命令的 `/` 输入会作为普通消息发给 agent**；
**前面有空白的 `/` 被当作普通文本**，不触发命令菜单。

---

## 13. CLI 命令与参数

### 13.1 主命令选项（脚本数出 13 个长选项）

| 选项 | 短 | 说明 |
| --- | --- | --- |
| `--version` | `-V` | 打印版本 |
| `--help` | `-h` | 帮助 |
| `--session [id]` | `-S` | 恢复会话；不给 id 进入交互选择器 |
| `--continue` | `-c` | 继续当前目录最近一次会话 |
| `--model <model>` | `-m` | 本次启动指定模型别名 |
| `--prompt <prompt>` | `-p` | 非交互单次执行，流式输出到 stdout |
| `--output-format <format>` | | `text` / `stream-json`，**只能与 `--prompt` 同用** |
| `--yolo` | `-y` | 自动批准常规工具调用 |
| `--auto` | | auto 权限模式启动 |
| `--plan` | | 以 Plan 模式启动新会话 |
| `--skills-dir <dir>` | | **替换**自动发现的 Skill 目录，可重复 |
| `--agent <name>` | | 指定主 agent |
| `--agent-file <path>` | | 从 Markdown 加载自定义 agent |
| `--add-dir <dir>` | | 追加工作区目录，可重复 |

**隐藏别名**（不出现在 `--help` 里）：`-r` / `--resume` → `--session`；
`--yes` / `--auto-approve` → `--yolo`。

**冲突规则**（启动时直接拒绝）：

- `--continue` ✕ `--session`（都表示恢复）
- `--yolo` ✕ `--auto`（两种权限模式不能叠）
- `--prompt` ✕ `--yolo` / `--auto` / `--plan`（非交互模式**默认 auto 权限**）
- `--output-format` 必须配 `--prompt`

恢复会话时可用 `--auto` / `--yolo` / `--plan` **覆盖它保存的模式**：
`kimi --continue --auto`。

`--skills-dir` 是**替换**而不是叠加——这与 `extra_skill_dirs`（叠加）语义相反，容易混。

### 13.2 子命令

| 子命令 | 作用 |
| --- | --- |
| `kimi login` | RFC 8628 设备码 OAuth，不进 TUI；`Ctrl-C` 取消退出码 `1` |
| `kimi acp` | ACP 模式，stdio JSON-RPC（通常由 IDE 作为子进程启动） |
| `kimi web` | 前台跑本地服务并开浏览器 |
| `kimi doctor` | 诊断配置 |
| `kimi export` | 导出会话为 ZIP |
| `kimi migrate` | 迁移 `~/.kimi/` 老数据 |
| `kimi upgrade` | 检查并安装新版本 |
| `kimi vis` | 会话可视化器 |
| `kimi provider` | 非交互式 provider 管理（`add` / `remove` / `list` / `catalog`） |
| ~~`kimi server`~~ | **已废弃**（见下） |

**`kimi server` 命令树已废弃**：任何 `kimi server …` 调用**只打印废弃提示并以退出码 1 退出**。
唯一例外是 `kimi server kill`，保留用于停掉 **0.28.0 之前**版本遗留的后台服务
（那些版本会留下后台 server，记录在旧的单实例锁 `~/.kimi-code/server/lock`）。
提示将在下一个大版本移除。

### 13.3 `kimi web` 的安全默认值

| 选项 | 说明 |
| --- | --- |
| `--port <port>` | 默认 **58627**；占用则 `+1` 重试 |
| `--host [host]` | 省略为 `127.0.0.1`；裸 `--host` 为 `0.0.0.0` |
| `--allowed-host <host...>` | 额外允许通过 **DNS rebinding 检查**的 Host 头 |
| `--log-level <level>` | 服务端日志级别，默认不开 |
| `--debug-endpoints` | 挂载 `/api/v1/debug/*`，**默认关** |
| `--dangerous-bypass-auth` | **关闭所有 REST/WS 路由的 bearer 认证** |
| `--no-open` | 不开浏览器 |

**默认只绑本地回环，并在启动横幅里打印 bearer token**；
Web UI 通过 URL fragment `#token=` 自动认证（fragment 不会进入服务端日志或 Referer）。
多实例可共享一个 home：各自注册在 `~/.kimi-code/server/instances/` 下，
端口冲突就 58628、58629 递增。

`GET /openapi.json` 返回 REST 的 OpenAPI 文档，`GET /asyncapi.json` 返回 WebSocket 的
AsyncAPI 文档。

::: danger `--dangerous-bypass-auth`
官方文档给它单独配了一个 danger 块，原文大意：**认证完全关闭，
能访问这个端口的任何人都拿到你会话、文件系统和 shell 的完全权限**。
只在可信网络或自己的认证反代之后用。

这个标志的命名（`dangerous-` 前缀）和文档处理都算负责。
值得对照的是 §7.4——**同一个产品在「显式危险开关」上很谨慎，
在「默认推荐的 deny 规则」上却给了一条不生效的示例**。
:::

---

## 14. MCP 集成

### 14.1 三种传输

| 方式 | 说明 |
| --- | --- |
| **stdio** | CLI 把本地 MCP server 作为子进程启动，走标准输入输出 |
| **HTTP** | 连接已在运行的 HTTP 端点 |
| **SSE** | 旧式 HTTP+SSE；**新 server 优先用 HTTP**，只有服务仅暴露 SSE 时才 `transport: "sse"` |

`mcp.json` 里**有 `command` 字段的是 stdio；有 `url` 且无 `transport` 的是 HTTP**；
旧 SSE 必须显式写 `transport: "sse"`。

### 14.2 两级配置与优先级

| 级别 | 路径 |
| --- | --- |
| 用户级 | `~/.kimi-code/mcp.json`（或 `$KIMI_CODE_HOME/mcp.json`） |
| 项目级 | `<cwd>/.kimi-code/mcp.json` |

**同名条目项目级覆盖用户级。** 注意 MCP 配置**不在 `config.toml` 里**——
`config.toml` 的 `[mcp]` 段只放超时等全局默认值。

### 14.3 可选字段

| 字段 | 适用 | 说明 |
| --- | --- | --- |
| `env` | stdio | 注入子进程的环境变量 |
| `cwd` | stdio | 子进程工作目录 |
| `headers` | HTTP / SSE | 附加到每个请求的静态头 |
| `bearerTokenEnvVar` | HTTP / SSE | **存放 token 的环境变量名**（而不是 token 本身） |
| `enabled` | 全部 | `false` 禁用 |
| `startupTimeoutMs` | 全部 | 1–2147483647，默认 **30000** |
| `toolTimeoutMs` | 全部 | 单次工具调用超时 |
| `enabledTools` | 全部 | 工具白名单 |
| `disabledTools` | 全部 | 工具黑名单 |

**超时优先级**：per-server 字段 > 环境变量（`KIMI_MCP_STARTUP_TIMEOUT_MS` /
`KIMI_MCP_TOOL_TIMEOUT_MS`）> `config.toml` 的 `[mcp]` > 内置默认。

`bearerTokenEnvVar` 是个好设计：**配置文件里存变量名而不是密钥本身**，
这样 `mcp.json` 可以进版本库。

### 14.4 中途增删 server 的语义（这块处理得细）

- **删除 server 不打断已开会话**：它在 `/mcp` 里仍列为 `removed`，
  工具仍可见，**调用时返回 removal notice 而失败**；新会话则完全不注册这些工具
- **中途新增 server**（编辑 `mcp.json` 或装插件）**不会注册进已开会话**，
  只对之后创建的会话生效

v0.34.0 的 changelog 有对应修复：
*"Fix removing an MCP server breaking open sessions: its tools stay visible but calls
fail with a removal notice."*——说明这个语义是踩过 bug 之后定下来的。

### 14.5 结构化内容与 `_meta`

v0.33.0 修了一个值得注意的兼容性问题：

> MCP tool results now surface the spec-defined `structuredContent` field and `_meta`
> server metadata to the model instead of silently dropping them, so servers that return
> their machine-readable contract in these fields work the same as on other MCP hosts.

**之前这两个字段被静默丢弃**。如果你的 MCP server 依赖 `structuredContent`，
需要 ≥ 0.33.0。

### 14.6 会话级临时 server 与信任门控

`CreateSessionOptions.mcpServers` 可以给单个会话附加**临时 MCP server**：
`workspaceMcp.sessionOverlay` 为它们建一个会话自有的 manager——
**永不持久化、对该 handler 的其他会话不可见、不受 `workspaceTrust` 门控**，
会话句柄释放时关闭。同名的临时 server 会在该会话里**遮蔽**工作区级的同名 server。

**工作区级的项目 MCP 配置则受信任门控**（§4.3）：未信任的工作区跳过项目级 `mcp.json`。

### 14.7 OAuth 与身份

MCP 的 OAuth 凭证存在 `~/.kimi-code/credentials/mcp/<key>-<suffix>.json`
（目录 0700 / 文件 0600）。

一个容易踩的点：**`[identity] slug` 会作为announce给 MCP server 的 client name**，
而**已授权的 MCP OAuth 会保留它当时注册的 client registration**——
改了 identity 之后要重置那个 server 的认证才会用新的 token 注册。

v0.33.0 修了 *"MCP OAuth re-authorization always failing with 'Invalid redirect URI'"*：
现在会丢弃过期的 client registration 并用当前 callback URI 重建。

### 14.8 `/mcp-config`：用对话配 MCP

README 把这条列为卖点之一（"AI-native MCP configuration"）：
`/mcp-config` 是一个内置 Skill（§12.6），让你**用自然语言增删改和认证 MCP server**，
不用手写 JSON。`/mcp` 只看连接状态。

---

## 15. Skills 与插件

### 15.1 Skill 文件格式（6 个 frontmatter 字段）

| 字段 | 说明 |
| --- | --- |
| `name` | 目录形式的 `SKILL.md` **必填**；扁平 `.md` 省略则取文件名。**大小写不敏感** |
| `description` | 一行摘要，模型据此决定何时使用。目录形式**必填**；扁平形式省略则取正文首个非空行（≤240 字符） |
| `type` | `prompt`（默认）/ `inline`（同语义）/ `flow`（**仅手动调用，模型不能自动触发**）。其他值被跳过 |
| `whenToUse` | 触发时机；也接受 `when-to-use` / `when_to_use` |
| `disableModelInvocation` | `true` 则模型不能自动调用；也接受 kebab / snake 变体 |
| `arguments` | 命名参数，字符串数组或空格分隔字符串 |

**目录形式里 `name` 与 `description` 都必填，缺一个直接解析失败。**

**两种文件结构**：目录形式（`<name>/SKILL.md`，推荐，可放脚本与素材）与扁平形式（单个 `.md`）。
**同目录下同名的 `<name>/SKILL.md` 与 `<name>.md` 同时存在时，子目录优先。**

### 15.2 正文占位符

| 占位符 | 展开为 |
| --- | --- |
| `$ARGUMENTS` | 调用时传入的完整原始参数串 |
| `$ARGUMENTS[0]` / `$0`（及 `[1]` / `$1`…） | 空白分词后的位置参数（**0 起**） |
| `$<name>` | `arguments` 里声明的命名参数 |
| `${KIMI_SKILL_DIR}` | 当前 Skill 文件所在目录 |

位置参数**支持单双引号**：`/skill:commit "fix login" patch` 里 `$0` 展开为 `fix login`。
**正文里没有任何参数占位符时**，传入文本会以 `\n\nARGUMENTS: <text>` 追加到正文末尾。

### 15.3 四级 Skill 目录

优先级：**Project > User > Extra > Built-in**。

一个跨工具设计值得注意：**通用 `.agents` 资源留在真实 OS home 下以便多工具共享**——
用户级通用 Skills 在 `~/.agents/skills/`，
而 Kimi 专属的用户级 Skills 随 `KIMI_CODE_HOME` 走（`$KIMI_CODE_HOME/skills/`）。
同理 `~/.agents/AGENTS.md` 是跨工具指令，`$KIMI_CODE_HOME/AGENTS.md` 是 Kimi 专属。

### 15.4 插件清单

清单放在 `<plugin_root>/kimi.plugin.json` 或 `<plugin_root>/.kimi-plugin/plugin.json`，
**两者都存在时前者优先**。

| 字段 | 说明 |
| --- | --- |
| `name` | **必填**，作为插件 id，须匹配 `[a-z0-9][a-z0-9_-]{0,63}` |
| `version` / `description` / `keywords` / `author` / `homepage` / `license` | 展示元数据 |
| `interface` | `/plugins` 里显示的字段：`displayName` / `shortDescription` / `longDescription` / `developerName` / `websiteURL` |
| `skills` | 一个或多个 `./` 路径，**必须在插件根目录内** |
| `agents` | 同上，指向含 agent 文件的目录；省略则自动拾取根下 `agents/` |
| `sessionStart.skill` | 新建或恢复会话时把指定 Skill 载入主 agent |
| `skillInstructions` | 本插件任一 Skill 被载入时追加的额外指令 |
| `systemPrompt` | 内联系统提示词贡献 |
| `systemPromptPath` | `./` 路径指向 UTF-8 文本；与 `systemPrompt` 同时存在时**接在其后** |
| `mcpServers` | MCP server 声明，**默认启用**，可在 `/plugins` 里禁用 |
| `hooks` | 插件启用期间生效的 Hook 规则 |
| `commands` | `./` 路径指向目录或 `.md`，把其中 Markdown 注册为斜杠命令 |

**不支持的运行时字段**（`tools`、`apps`、`inject`、`configFile`）会作为诊断项报出并忽略。

### 15.5 系统提示词预算（两道闸）

| 限制 | 值 |
| --- | --- |
| 单个字段（内联 `systemPrompt` 或 `systemPromptPath` 文件） | **32 KB**（UTF-8 字节），超出**忽略**并进诊断 |
| 一次提示词构建、所有启用插件合计 | **64 KB**，超预算的贡献被跳过并 warning |

**单个插件的内联 + 文件加起来超过 64 KB 也会被跳过。**
文件内容在安装或 reload 时读取，**改了文件要 `/plugins reload` 才生效**。

新会话与新建 agent 读取当前启用插件的贡献；**进行中的请求保持已有系统提示词**。

### 15.6 从 GitHub 安装的四种 URL 形态

| 形态 | 行为 |
| --- | --- |
| `https://github.com/<owner>/<repo>` | 装最新 release；无 release 则回落默认分支 |
| `.../tree/<ref>` | 指定分支 / tag / 短 SHA |
| `.../releases/tag/<tag>` | 钉到 tag |
| `.../commit/<sha>` | 钉到 commit |

**网络请求只走 `github.com` 重定向与 `codeload.github.com` 下载，不调 `api.github.com`。**

### 15.7 几条安装期的实际行为

- **改动需 `/reload` 或 `/new` 才生效**，当前会话不会自动更新
- 本地安装会**复制**到 `$KIMI_CODE_HOME/plugins/managed/<id>/`，
  CLI 始终跑这个托管副本——**安装后改原目录无效，必须重装**
- **移除插件只删安装记录**，托管副本与原文件都留在磁盘上
- **目前只有用户级安装**，作用于所有项目；**项目级安装尚不支持**

### 15.8 三个官方插件

`/plugins` 面板有四个 tab（`Tab` / `Shift-Tab` 切换）：
**Installed / Official / Curated（Kimi 合作方的第三方插件）/ Custom**。

| 插件 | 版本 | 能力 |
| --- | --- | --- |
| **Kimi Datasource** | v3.3.0 | 数据源接入 |
| **Kimi WebBridge** | v1.11.3 | 需装浏览器扩展 |
| **Kimi Computer Use** | v0.5.4 | macOS 需授权；**v0.34.0 起支持 Windows x64** |

---

## 16. 会话、上下文与数据落盘

### 16.1 目录布局

```
$KIMI_CODE_HOME  (默认 ~/.kimi-code)
├── config.toml             # 运行时配置
├── tui.toml                # 终端 UI 偏好（含自动更新开关）
├── AGENTS.md               # 全局 Kimi 专属指令（可选）
├── mcp.json                # 用户级 MCP 声明（可选）
├── skills/                 # Kimi 专属用户级 Skills
├── plugins/
│   ├── installed.json      # 安装记录与启用状态
│   └── managed/            # zip/本地路径安装的托管副本
├── session_index.jsonl     # 会话索引
├── credentials/            # OAuth 凭证（目录 0700，文件 0600）
│   ├── <name>.json
│   └── mcp/<key>-<suffix>.json
├── sessions/
│   └── <workDirKey>/<sessionId>/
│       ├── state.json      # 标题、创建时间等元数据
│       └── agents/
│           ├── main/wire.jsonl
│           └── <subagentId>/wire.jsonl
├── bin/
│   ├── rg                  # 托管的 ripgrep（Grep 用）
│   └── fd                  # 托管的 fd（文件引用用）
├── logs/kimi-code.log      # 全局诊断日志
├── updates/                # latest.json / install.json / install.lock / rollout.log
└── user-history/<md5(workDir)>.jsonl   # 按工作目录的输入历史
```

**会话按工作目录分组**（`<workDirKey>`），**每个 agent 一个 `wire.jsonl`**——
主 agent 与每个子代理各自一份。

`wire.jsonl` 不只是消息流：它还带 **request trace**——
发给模型的工具 schema、请求参数、MCP 工具清单，用于调试。
这对排查「模型为什么没调这个工具」很有用。

**大 base64 媒体载荷从 v0.5.0 起被卸载到外部 blob 文件**
（changelog：*"Offload large base64 media payloads from `wire.jsonl` into external blob files
to reduce wire size and memory pressure during session replay"*），
`BlobStore` 带内存读穿缓存。

::: warning 不要手改 sessions/
官方文档明确警告：手工编辑 `sessions/` 下的文件可能导致会话无法正确恢复。
:::

### 16.2 会话恢复的三条路

```sh
kimi --continue          # 当前目录最近一次
kimi --session abc123    # 指定 id
kimi --session           # 交互式浏览
```

TUI 内：`/new`（`/clear`）、`/sessions`（`/resume`）、`/fork`、`/title`。

### 16.3 上下文压缩

上下文接近窗口上限时**自动压缩**，也可 `/compact` 手动触发，并能带提示：

```
/compact Keep the discussion about database migrations
```

触发阈值由 `[loop_control] reserved_context_size` 控制（为输出预留的 token 数，
剩余窗口低于它就压缩）。

**压缩相关的 Hook 有两个**（`PreCompact` / `PostCompact`），
但 `PreCompact` 的**返回值完全被忽略**——它纯观察，不能阻止压缩。

`[experimental] micro_compaction`（默认 `false`）是另一条路：
开启后自动裁剪较旧的大工具结果，而不是整体压缩。

**v0.34.0 新增缓存过期提示**：长时间闲置后恢复或发送时提示上下文缓存可能已失效，
并给出压缩或新建会话的选项，由 `tui.toml` 的 `cache_expiry_hint`（默认 `true`）控制，
**仅 v2 引擎**。这是个务实的功能——prompt cache 过期后那一轮会显著变贵变慢。

### 16.4 导出

| 方式 | 产物 |
| --- | --- |
| `kimi export [<sessionId>]` | ZIP，含会话目录全部文件**与全局诊断日志** |
| `/export-debug-zip` | 同上 |
| `/export-md [<path>]` | 人读的 Markdown |

`kimi export` 省略 id 时导出当前目录最近会话（有交互确认，`-y` 跳过），
`-o` 指定输出路径，**`--no-include-global-log` 排除全局日志**。
`/export-md` 不带参数时写到 `kimi-export-<short-id>...`。

> **导出默认打包全局诊断日志**这点提交 bug report 时方便，
> 但也意味着**分享 ZIP 前该想想里面有什么**——全局日志跨会话跨项目。

### 16.5 数据清理

`session_index.jsonl` 是索引，`sessions/` 是数据。
`bin/` 下的 `rg` / `fd` 是托管二进制，删了会重新下载
（文件引用的快速搜索助手还在下载时，`@` 补全**回落到基础文件系统扫描**）。

---

## 17. 终端 UI 与交互

### 17.1 输入基础

| 操作 | 键位 |
| --- | --- |
| 发送 | `Enter` |
| 换行 | `Shift-Enter` / `Ctrl-J` |
| 输入历史（输入框为空时） | `↑` / `↓`，按工作目录隔离，**含此前的 shell 命令** |
| 退出 | 空输入框 `Ctrl-D`、空闲时连按两次 `Ctrl-C`、或 `/exit` |
| 打断当前轮 | 流式输出中 `Ctrl-C` 或 `Esc`（**不退出程序**） |
| 外部编辑器 | `Ctrl-G` |
| 展开工具卡片 | `Ctrl-O` |
| 全屏查看 diff | `Ctrl-E` |

### 17.2 视频输入：这是 Kimi Code 的差异点

文档原话：*"**Video input is a distinctive Kimi Code capability**"*——
可以直接把视频片段粘进输入框，让模型分析内容、UI 流程或代码走查。

粘贴键位：**macOS / Linux `Ctrl-V`，Windows `Alt-V`**。
粘贴后输入框显示可编辑占位符，提交时替换为真实内容；纯文本剪贴板回落为普通粘贴。

是否可用取决于当前模型的 `image_in` / `video_in` 能力——
登录 Kimi Code 账号时默认开启（§8.2 的三个默认模型都带 `video_in`）。

`[image]` 配置：`max_edge_px`（长边像素上限）与 `read_byte_budget`（默认 262144 = 256 KB），
env 分别是 `KIMI_IMAGE_MAX_EDGE_PX` / `KIMI_IMAGE_READ_BYTE_BUDGET`。

### 17.3 pi-tui：差分渲染

TUI 建在 `packages/pi-tui`（12,477 行）之上，自述是
"Minimal terminal UI framework with differential rendering and synchronized output
for flicker-free interactive CLI applications"。

README 的卖点是 **"Blazing-fast startup. The TUI is ready in milliseconds"**。
差分渲染 + synchronized output（终端同步更新转义序列）是无闪烁的技术手段。

前面提过：这个包源自 [`earendil-works/pi-mono`](https://github.com/earendil-works/pi-mono)
（README 里有致谢），但已 vendor 进仓库作为 `private` 包演进到 0.80.8。

### 17.4 状态栏可配置

`tui.toml` 的 `[status_line]`：

```toml
[status_line]
items = ["mode", "goal", "model", "tasks", "cwd", "git", "tips"]
command = "~/.kimi-code/statusline.sh"
```

`items` 决定显示哪些段（注意 **`goal` 是其中一项**，对应 §11），
`command` 可以挂自定义脚本。

### 17.5 主题

`/theme` 切换，`/custom-theme` 是内置 Skill（§12.6）——**用自然语言描述配色让 agent 生成主题**。
`/reload-tui` 只重载 `tui.toml`（改主题后不用重启整个会话）。

### 17.6 批准界面

工具调用的批准界面会**显示文件内容与 diff**（v0.5.0 起），
`Ctrl-E` 进专门的全屏查看器而不是内联展开。
Bash 卡片头部长命令截断在 60 字符，`Ctrl-O` 展开看完整多行命令与输出。

多个前台 `Agent` 调用在同一步时，**TUI 会分组显示每个子代理的
running / waiting / completed / failed 状态**。

---

## 18. 分发、更新与 IDE 集成

### 18.1 两条安装路径的区别

| 路径 | 需要 Node？ | 产物 |
| --- | --- | --- |
| 官方脚本（`install.sh` / `install.ps1`） | **否** | 自带运行时的可执行文件 |
| npm 全局 | **是**，`>=22.19.0` | 52.5 MB 单包，0 runtime 依赖 |

README 把 "Single-binary distribution: no Node.js setup, PATH gymnastics, or global
module conflicts" 列为首条卖点——**这条只适用于脚本安装**。
npm 包的 `engines.node` 明确写了 `>=22.19.0`。

### 18.2 自动更新

`kimi upgrade` 检查并给出更新选项，按当前安装来源升级。
自动更新开关在 `tui.toml`，也可用 `KIMI_CODE_NO_AUTO_UPDATE`
（旧名 `KIMI_CLI_NO_AUTO_UPDATE` 仍兼容但带警告）关掉。

更新状态落在 `$KIMI_CODE_HOME/updates/`：
`latest.json`（版本检查缓存）、`install.json`、`install.lock`、`rollout.log`。
`rollout.log` 这个名字暗示有灰度发布机制，**但我没有找到公开文档说明它的策略**。

### 18.3 IDE 集成走 ACP

Kimi Code 的编辑器集成走 **ACP（Agent Client Protocol）**，
`kimi acp` 用 stdin/stdout 上的 JSON-RPC 与 IDE 通信，
通常由 IDE 作为子进程启动，不需要手动跑。

实现分两个包：`packages/acp-adapter`（5,534 行）与 `packages/acp-server`（雏形，0.0.0）。
默认走 v2 引擎；`KIMI_CODE_LEGACY_FLAG=1` 时走 SDK harness + `acp-adapter`。

**VS Code 扩展**在 `apps/vscode`（`name: kimi-code`，v0.6.7，`private: true`），
**未在 npm 发布**——分发渠道应该是 VS Code marketplace，但仓库里看不到证据。

> **ACP 不是 Kimi Code 的差异点**：同系列的 `ref-opencode` §20 记录了 opencode
> 也通过 ACP 接编辑器（Zed 原生），且同样是 stdio 上的 JSON-RPC。
> **「CLI 作为 ACP agent、编辑器作为 client」正在成为这批工具的通用做法**，
> Kimi Code 是跟随而非首创。真正的取舍是：走开放协议意味着任何 ACP 客户端都能接，
> 代价是深度不如 Claude Code 那种自建 VS Code / JetBrains 扩展 + IDE bridge。

### 18.4 `kimi web` 的服务端架构

`packages/kap-server`（31,228 行）是 `kimi web` 的服务端，
自述 "Kimi Code server backed by the DI × Scope agent engine (agent-core-v2)"。

- **单进程**同源提供 REST + WebSocket + 前端静态资源
- `packages/protocol`（5,394 行）定义共享的 REST + WS schema（envelope、错误码、分页、ws-control）
- `packages/klient`（4,935 行）是契约驱动的客户端 facade，
  **一套 API 两种传输**（ipc / in-memory），创建时选一次，之后字节级一致
- `packages/transcript`（3,824 行）提供同构的 transcript 渲染数据层（L1–L4 分层）

「同一套 transcript 渲染层同时服务 TUI 与 Web」是这个架构的用意，
`transcript` 包的 L1–L4 分层就是为此。

### 18.5 `kimi vis` 与 `kimi-inspect`

`apps/vis`（含 `vis-server` / `vis-web` 两个子包）是会话可视化器，
`kimi vis` 在浏览器里看会话展开过程。
`apps/kimi-inspect`（0.0.0）是另一个雏形工具，**仓库里没有文档说明它的用途**。

---

## 19. 遥测与迁移

### 19.1 遥测

`telemetry` 顶层字段默认 `true`，**只有显式写 `false` 才关**。
env 开关 `KIMI_DISABLE_TELEMETRY` 语义是「额外关闭」——
即使 `config.toml` 写了 `telemetry = true`，设了这个变量也关（§6.3）。

`packages/telemetry`（1,180 行）是共享遥测基础设施。文档描述为「匿名使用数据」，
**具体采集字段清单我没有在文档或源码注释里找到**，因此不做进一步描述。

### 19.2 从 `~/.kimi/` 迁移

`packages/migration-legacy`（0.1.16）负责把老数据目录 `~/.kimi/` 迁到 `~/.kimi-code/`，
入口是 `kimi migrate`。changelog 里有相关修复记录，
比如 0.5.0 的 *"Fix migration mapping the legacy `default_yolo` key to the dead `yolo` field
instead of `default_permission_mode`"*——说明配置键名在早期改过。

### 19.3 从 Claude Code / Codex 迁移

`/import-from-cc-codex` 是内置 Skill（§12.6），
从 Claude Code 与 Codex 导入配置。`docs/en/guides/migration.md`（2,262 B，最短的一篇文档）
是配套说明。

---

## 20. 版本时间线与发版节奏

### 20.1 发版节奏（npm registry 实查）

`@moonshot-ai/kimi-code` 共 **63 个版本**，首发 `0.1.0`（2026-05-21），
最新 `0.34.0`（2026-08-06）：

| 月份 | 发版数 |
| --- | --- |
| 2026-05 | 7 |
| 2026-06 | **26** |
| 2026-07 | **27** |
| 2026-08（至 08-06） | 3 |

**77 天 63 个版本，平均 1.2 天一版。** 6 月和 7 月都是 26–27 个版本，
相当于工作日每天发一版。

同系列的横向参照（各篇快照口径不同，**只能当量级参考，不是同一把尺**）：

| 产品 | 口径 | 折算 |
| --- | --- | --- |
| **Kimi Code** | 77 天 63 个版本 | **约 1.2 天/版** |
| OpenClaw | 2026 年前 7 个月 244 个版本（**含预发布**） | 约 0.87 天/版 |
| opencode | 12 天 10 个版本 | 约 1.2 天/版 |
| Claude Code | 24 天 15 个版本 | 约 1.6 天/版 |

**所以「最快」这个说法给不了**——OpenClaw 含预发布的口径比它更密，
而 opencode 那个 12 天窗口与它基本同速。
能说的是：**Kimi Code 属于这批产品里发版最密的一档，并且它是在只有 77 天历史的前提下做到的。**

**近期版本**（npm 实查）：

| 版本 | 日期 |
| --- | --- |
| 0.34.0 | 2026-08-06 |
| 0.33.0 | 2026-08-05 |
| 0.32.0 | 2026-08-04 |
| 0.31.1 | 2026-07-31 |
| 0.31.0 | 2026-07-30 |
| 0.30.0 | 2026-07-29 |
| 0.29.2 | 2026-07-27 |
| 0.29.1 | 2026-07-24 |
| 0.29.0 | 2026-07-22 |
| 0.28.1 | 2026-07-20 |
| 0.28.0 | 2026-07-20 |
| 0.27.0 | 2026-07-17 |

`docs/en/release-notes/changelog.md`（92,564 B）有 **61 个版本条目**，
是最长的一篇文档——比第二长的 `config-files.md`（39,166 B）还多一倍。

### 20.2 功能里程碑（按引入版本）

| 版本 | 日期 | 里程碑 |
| --- | --- | --- |
| **0.1.0** | 2026-05-21 | 首个 npm 版本 |
| 0.2.0 | 2026-05-26 | changelog 起点 |
| **0.5.0** | 2026-05-28 | **定时任务**（cron）；`/auto` 与 `--auto`；批准界面显示 diff |
| 0.7.0 | 2026-06-02 | `/provider` 取代废弃的 `/connect`；`KIMI_MODEL_ADAPTIVE_THINKING` |
| 0.11.0 | 2026-06-05 | 实验性 sub-skill 发现；内置 Skill 提为直接斜杠命令 |
| 0.15.0 | 2026-06-15 | 全会话选择器；**SSE MCP** 传输 |
| **0.20.0** | 2026-06-26 | **TUI shell 模式**（输入 `!`，`Ctrl-B` 转后台）；`kimi web --host` |
| 0.24.0 | 2026-07-14 | **前台 Bash 超时转后台**（`bash_auto_background_on_timeout`）；web 会话导出 |
| **0.26.0** | 2026-07-16 | **coder 子代理工具集扩到对齐主 agent**（后台任务/todo/plan/skill/嵌套 agent）；标题写着 "Say hi to the BIIIG DAY!" |
| 0.28.0 | 2026-07-20 | （`kimi server` 遗留后台服务的分界版本，见 §13.2） |
| 0.29.0 | 2026-07-22 | |
| 0.32.0 | 2026-08-04 | |
| **0.33.0** | 2026-08-05 | **agent-core-v2 成为默认引擎**；启动时询问是否信任当前目录；MCP `structuredContent` / `_meta` 不再丢弃；`/fork` 不再切换会话 |
| **0.34.0** | 2026-08-06 | Kimi Computer Use 支持 Windows x64；缓存过期提示；本快照版本 |

**注意 0.26.0 的标题**："Say hi to the BIIIG DAY!"——
那一版把 coder 子代理的工具集扩到与主 agent 对齐。

### 20.3 这个时间线说明什么

三件事值得记：

1. **v2 引擎成为默认只有 3 天**（0.33.0，2026-08-05 → 本快照 08-08）。
   本文多处「文档与源码不一致」都指向这个窗口——文档在追赶一次刚落地的引擎切换。
2. **早期就有的功能反而是差异化的那些**：cron 定时任务在 0.5.0
   （建仓后 6 天）就进来了，goal 相关代码在 0.11.0 已在修 bug。
   这不是后期补的功能，是从一开始就在的产品判断。
3. **配置键名早期改过**（0.5.0 修 `default_yolo` → `default_permission_mode` 的迁移映射），
   所以引用 0.5.0 之前的任何第三方教程都要小心。

---

## 21. 未能核验与存疑的部分

按本系列的规矩，把没查实的东西单独列出来，而不是含糊过去。

### 21.1 明确未核验

| 项 | 为什么没核验 |
| --- | --- |
| **§7.4 的端到端行为** | 没真跑一次 Kimi Code 验证 `rm -rf /tmp/x` 在配了 deny 规则 + yolo 模式下会被放行。仓库无 `node_modules`，我是分别验证匹配层与调用链后推断的 |
| **§7.5 符号链接逃逸** | 路径守卫的规范化是纯词法的（源码注释自陈不做 `realpath`），我**没有实测**通过符号链接把工作区外的文件读进来 |
| **§5.2 的 26 个工具运行时可见性** | `AGENT_TOOLS` 是 profile 声明，实际可见集还要与 `[tools]` 开关和 agent 自己的 `tools`/`disallowedTools` 求交 |
| **遥测采集字段** | 文档只说「匿名使用数据」，我没在文档或源码注释里找到字段清单 |
| **`updates/rollout.log`** | 文件名暗示灰度发布，但没有公开文档说明策略 |
| **`apps/kimi-inspect`** | 0.0.0 版本，仓库里没有文档说明用途 |
| **`HookDef` 的 `cwd` / `env`** | v2 接口里有，但文档说配置层只接受 4 个字段。推测是内部/插件通道用，未核实 |
| **VS Code 扩展分发渠道** | `private: true` 且未在 npm，推测走 marketplace，仓库内无证据 |
| **Star 数的时间维度** | 6,176 stars 是 2026-08-08 单点值，没有增长曲线 |

### 21.2 我改过的判断（留作记录）

写作过程中有两处我先写错、核验后改了，留在这里因为它们说明了「目测计数」的风险：

- 一开始把包数写成 **22**，脚本实查是 `packages/` 下 **17 个**、
  workspace manifest 共 **24 个**。目测目录数会把 `apps/vis` 的两个子包和 `docs` 算漏或算错。
- 一开始用单行正则扫 `registerAgentToolService` 得到 **14 个**工具，
  漏掉了所有多行写法的注册；改成多行正则后是 **20 个**，
  再加上走别的注册路径的 6 个才凑齐 26 个。
- §7.2 的权限链一开始我只敢报「有 12 个节点」并声明未核验运行时顺序；
  后来读到 `permissionPolicyService.ts:45` 的 `policies` 数组，
  把实际顺序补齐了——**结论反而更有价值**：顺序本身是对的
  （deny 规则确实排在两个自动放行模式之前），
  §7.4 那个缺陷纯粹出在 glob 匹配上，不在优先级设计上。
- §7.4 的实测我第一次用的是手边的 picomatch **2.3.2**，
  发现项目锁定的是 **4.0.4** 后重新 `npm pack` 落盘重测。
  两个版本在这几个用例上结论相同，但**版本不对的实测不能算实测**。

### 21.3 会最快过期的部分

按漂移速度排序，引用前优先复查这几节：

1. **§3 双引擎** —— v2 刚成默认 3 天，legacy 引擎大概率会在某个版本被删。
   `KIMI_CODE_LEGACY_FLAG` 这个逃生阀是临时的。
2. **§5.2 工具数** —— Goal 工具进不进官方文档、会不会再加工具，都在变。
3. **§7.4** —— 这是个可修的缺陷。如果他们把 `tree-sitter-bash` 接进权限匹配链
   （能力已经造好了，见 §7.4 的 warning 块），这一节就该整节重写。
4. **§20 版本表** —— 1.2 天一版的节奏下，这张表一周就旧。

---

## 附录：本文的核验方法

为了让你能复现或反驳本文的任何一条：

**计数类事实**：全部用 Python `re.findall` 从原始 Markdown 表格数出，不目测。
例如工具数是从 `docs/en/reference/tools.md` 匹配
`^\|\s*`([A-Z][A-Za-z0-9_]*)`\s*\|` 得到 22 行；
Hook 事件数是从两套引擎源码的 `HOOK_EVENT_TYPES` 常量块里提取字符串字面量。

**源码类事实**：给出 `包/路径:行号`。跨引擎对比（如 Hook 事件的 20 vs 16）
是脚本对两个文件同名常量做集合差。

**匹配行为**：`npm pack picomatch@4.0.4` 落盘后本地跑，
版本与 `pnpm-lock.yaml:7800` 锁定的一致——**不是拿手边的 2.3.2 凑数**
（我第一次测就是用 2.3.2，发现版本不对后重测了一遍；两个版本在这几个用例上结论相同，
但结论必须来自项目实际锁定的版本）。

**外部数据**：GitHub REST API 与 npm registry 全部 `curl -o` 落盘到 `/tmp/kimi/`，
再用脚本只打印摘要——**原始 JSON 从不整份进上下文**
（这是 `docs/reference/产品深入研究-通用提示词.md` §1 那条 32MB 铁律）。

**文档源文件优先于渲染页**：`docs/en/**/*.md` 直接读源文件。
这让我拿到了渲染页上看不见的东西——比如 `[experimental]` 那一节
在源文件里是被 HTML 注释掉的（§6.2）。

