---
title: OpenAI Codex 深入研究（2026-07 快照）
description: 26 章逐节成册，按目录跳章查阅——把 Codex 的产品形态、架构与实现细节交叉核验到版本号级别：95.6% Rust 重写、App Server 双向协议、三平台内核沙箱（Seatbelt / Landlock+seccomp / restricted tokens）、Shell-Centric 工具设计、Codex Cloud 与 Security。这是一份手册，不是读完就走的文章。
date: "2026-08-08"
series: 深入研究
audience: engineer
highlight: 26 章逐节可查 · 核验至 CLI v0.144.1 · 截至 2026-07-16 快照
tags: [Codex, OpenAI, 深入研究, 沙箱, Rust, 参考]
outline: [2, 3]
---

# OpenAI Codex 深入研究（2026-07 快照）

::: warning 先说清这份东西是什么
**这是一份逐章查阅的手册，不是一篇文章。** 它按章节组织，供你按目录跳到需要的那一节查，
而不是从头读到尾——所以它没有主线，也没有结论。

- **调研日期**：2026-07-16（在 2026-07-15 版基础上二次联网校验）
- **被调研版本**：Codex CLI v0.144.1（2026-07-09）及同期 App / IDE / Cloud
- **证据形态**：公开信息交叉核验（官方文档 / changelog / 发布说明 / 工程博客），
  **不是我们自己的实测数据**。章节内的版本号与日期是它的证据，请连带一起读。
- **时效边界**：Codex 发版节奏很快（本快照覆盖的 4–7 月就跨了 GPT-5.5 → 5.6 两代模型）。
  **这是 2026-07 的快照，不是最新状态**，以[官方文档](https://developers.openai.com/codex/)为准。

一份标清日期的快照不会变成假话，只会变成史料——但前提是你知道它的日期。
:::

---

## 1. 产品概述

OpenAI Codex 是 OpenAI 推出的 AI 编程代理平台，从 2025 年 5 月作为研究预览发布，到 2026 年已演进为一个多界面、多模态的完整编程代理生态系统。

**产品形态（5 个入口）：**

| 入口 | 说明 |
|------|------|
| **Codex CLI** | 开源终端代理，Rust 实现，Apache 2.0 许可，92K+ GitHub Stars |
| **Codex App** | macOS 桌面应用，多代理命令中心（2026.2.2 发布） |
| **Codex Web** | 云端代理，在 chatgpt.com/codex 访问，异步执行任务 |
| **Codex IDE Extension** | VS Code / Cursor / Windsurf 扩展 |
| **GitHub 集成** | PR 评审（`@codex review`）、GitHub Actions |

**安装方式：**
```bash
# npm 安装（需 Node.js 22+；务必用带 @openai 作用域的包名）
npm i -g @openai/codex
# 更新
npm i -g @openai/codex@latest   # npm 安装
codex update                    # 独立二进制安装（v0.128.0+ 自更新）

# Homebrew 安装
brew install --cask codex

# 也可从 GitHub Releases 下载二进制文件
```

> **常见坑：** npm 上有个 2012 年的**无作用域 `codex` 包**与 OpenAI 无关，装了会静默无效。必须用作用域名 `@openai/codex`。

**支持模型（截至 2026.7，按当前推荐排序）：**

| 模型 | 说明 |
|------|------|
| **GPT-5.6 Sol** | GPT-5.6 家族旗舰，主打细节与打磨，复杂编码/架构决策首选（`codex -m gpt-5.6-sol`），不确定时官方建议从 Sol 起步 |
| **GPT-5.6 Terra** | 均衡款，性能对标 GPT-5.5 但成本更低，日常主力（`codex -m gpt-5.6-terra`） |
| **GPT-5.6 Luna** | 最快最省，强能力低成本，重复性/可预测工作首选（`codex -m gpt-5.6-luna`） |
| **GPT-5.5** | 上一代旗舰（4/23 发布），复杂编码、Computer Use、知识工作、研究流程；仍可用 |
| **GPT-5.4** | 上一代均衡款，`gpt-5.6` 不可用时的回退 |
| **GPT-5.4 mini** | 轻量模型，用于代码库探索、摘要、子代理等成本敏感场景 |
| **GPT-5.3-Codex-Spark** | 超快速变体（1000+ tokens/秒，ChatGPT Pro 专属），研究预览 |
| ~~GPT-5.3-Codex / GPT-5.2~~ | **已弃用**为 ChatGPT 登录用户的可选模型（API Key 工作流不受影响，仍可调用） |

> **模型命名与认证：** GPT-5.6 家族含三档（Sol/Terra/Luna，"数字标识代际、Sol/Terra/Luna 是可各自独立演进的持久能力档"——官方原话）。ChatGPT 登录会话（Plus/Pro/Business）建议**不显式指定模型名**，让 Codex 自动跟随推荐默认（省得手动追升级）。**认证更正：GPT-5.6 自 7/9 GA 起在 ChatGPT / Codex / OpenAI API 三处均可用**，`gpt-5.6-sol/terra/luna` 都有公开 API 定价，可用 API Key 直接调用（`printenv OPENAI_API_KEY | codex login --with-api-key`）。此前版本"GPT-5.5/5.6 仅 ChatGPT 登录、不支持 API Key"的说法已随 GA 过时。但 API Key 认证仍**无法使用依赖 ChatGPT 工作区/云端的功能**（Cloud Tasks / Code Review 等），二者按 plan 有差异。

**上下文窗口：**
- GPT-5.5：Codex 内 400K tokens，API 内最高 1M tokens
- GPT-5.6：默认上下文可跨 272K「高用量阈值」（社区反馈需注意 rate-limit）
- GPT-5.4：最高 1M tokens

**发布时间线（2026）：**
- GPT-5.5：2026-04-23 发布并一度成为 Codex 默认（约 40% token 缩减、同延时下更强多步 agentic）；API 于 4/24 开放
- GPT-5.6 Sol/Terra/Luna：2026-06-25 面向受信任伙伴限量预览（API + Codex）；**2026-07-09 起在 ChatGPT / Codex / OpenAI API 全面 GA**（24 小时内全球逐步铺开）
- GPT-5.5-Cyber：2026-05-07 面向受信任网络安全团队的限量预览变体

**关键数据（截至 2026.7）：**
- GitHub Stars：92K+（4 月约 75.6K，增长迅猛）
- Contributors：428+
- Forks：10.7K+
- Open Issues：7,400+（活跃迭代，官方 README 仍标注为「实验性、可能含 bug」）
- 最新版本线：**CLI rust-v0.144.1**（2026-07-09；4 月约 v0.121，累计 release 已超 135 个 minor 线 / 3,200+ npm 版本）
- 代码库语言：95%+ Rust
- 每周活跃开发者：4 月约 3,000,000 → **6 月约 5,000,000**（官方口径，增长迅猛）
- 计费口径：2026-04 起从"按消息数"迁移为"按 token 计的 credits"（5 小时窗口 + 每周窗口双限）

**认证方式：**
- ChatGPT OAuth（推荐，使用订阅计划额度；可访问 Cloud Tasks / Code Review 等工作区/云端功能）
- OpenAI API Key（按标准 API token 计费；**GPT-5.6 GA 后 Sol/Terra/Luna 均可 API 化调用**，但依赖 ChatGPT 工作区/云端的功能受限或不可用）
- Amazon Bedrock（新增，见 §9 / §21，AWS 托管认证与计费；支持 `openai.gpt-5.6-sol/terra/luna`、`openai.gpt-5.5`、`openai.gpt-5.4`）

---

## 2. 核心架构：Agentic While-Loop

Codex CLI 的核心是一个单代理 ReAct 风格循环，实现在 `AgentLoop.run()` 中：

```
用户输入 → 追加到消息历史
         ↓
┌─→ 发送 messages + tool definitions 给 LLM（流式，Responses API）
│        ↓
│   累积流式响应，实时渲染到 TUI
│        ↓
│   检查响应：
│   ├── 包含 function_call → 检查权限/沙箱 → 执行工具 → 收集结果
│   └── 无 function_call → 结束，等待下一次用户输入
│                     ↓
└── 追加 assistant 消息 + tool_result 到历史，继续循环
```

**与 Claude Code 的关键区别：**

| 维度 | Codex CLI | Claude Code |
|------|-----------|-------------|
| API | OpenAI Responses API（流式） | Anthropic Messages API（流式） |
| 状态管理 | 完全无状态（每次发送完整历史） | 完全无状态（每次发送完整历史） |
| 主要编辑工具 | `apply_patch`（diff 格式） | `Edit`（精确字符串替换） |
| Shell 工具 | 统一 `shell` 命令执行器 | 独立 `Bash` 工具 |
| 工具设计哲学 | Shell-centric（少量工具，通过 shell 完成大部分操作） | Tool-centric（20+ 专用工具） |

**Shell-Centric 设计：**

Codex CLI 本质上暴露一个主要工具：通用 shell 命令执行器。通过这个统一接口，模型可以使用熟悉的 CLI 工具（`cat`、`grep`、`find`、`ls`）完成文件操作。文件编辑通过特殊的 `apply_patch` 命令完成，而非独立的编辑工具。

**System Prompt 结构：**
- 硬编码在 Rust 代码中的详细系统提示词
- 定义代理角色、能力、约束、编码指南
- 教模型如何调用 `apply_patch` 和 `shell` 工具
- 用户指令从 `~/.codex/instructions.md`（全局）和 `AGENTS.md`（项目级）加载
- 合并后作为对话历史的前缀发送

**apply_patch 格式：**
```json
{
  "cmd": ["apply_patch", " Begin Patch\n Update File: path/to/file.py\n@@ def example():\n- pass\n+ return 123\n End Patch"]
}
```

支持的操作：
- `Add File: path` — 创建新文件
- `Delete File: path` — 删除文件
- `Update File: path` — 修改文件（diff 格式，`-` 删除行，`+` 添加行）
- `Move to: new_path` — 移动/重命名文件

**Responses API vs Messages API：**

Codex 使用 OpenAI 的 Responses API（而非 Chat Completions API），这是 OpenAI 为代理工作流设计的新一代 API：
- 支持 function/tool calls 和可选的 reasoning items
- 流式事件包括 `response.output_item.done`（工具调用完成）和 `response.completed`（响应完成）
- 不使用 `previous_response_id`（完全无状态，简化实现）
- 支持 `apply_patch` 作为内置工具类型（`tools=[{"type": "apply_patch"}]`）

---

## 3. Rust 重写与 App Server 架构

### 3.1 从 TypeScript 到 Rust

Codex CLI 最初用 TypeScript（Node.js）实现，2025 年中开始 Rust 重写（`codex-rs`），到 2026 年 2 月 Rust 实现已成为默认维护版本，代码库 95.6% 为 Rust。

**重写动机：**
- 零依赖安装（无需 Node.js 运行时）
- 更快的启动速度和更低的内存占用
- Rust 的内存安全特性天然适合沙箱实现
- 单一二进制分发，简化部署

**Cargo Workspace 结构（`codex-rs/`）：**

| Crate | 说明 |
|-------|------|
| `codex-core` | 核心业务逻辑库，代理循环、提示词、沙箱执行 |
| `codex-tui` | 全屏终端 UI（基于 Ratatui） |
| `codex-cli` | 多功能 CLI 入口（子命令路由：exec、app-server、sandbox、mcp、config） |
| `codex-exec` | Headless CLI，用于自动化（`codex exec "your prompt"`） |
| `codex-app-server` | JSON-RPC 服务器，统一所有客户端界面 |
| `codex-linux-sandbox` | Linux 沙箱辅助进程（Landlock + seccomp + Bubblewrap） |
| `codex-process-hardening` | 进程加固（阻止 `LD_PRELOAD`/`DYLD_` 注入） |
| `codex-execpolicy` | 执行策略管理 |

### 3.2 App Server 架构

2026 年 2 月，OpenAI 发布了 App Server 架构详解（由工程师 Celia Chen 撰写）。App Server 是一个双向协议层，将 Codex 核心代理逻辑与各种客户端界面解耦。

**统一架构：**
```
┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐
│  Codex TUI  │  │  VS Code    │  │  macOS App  │  │  Web App    │
│  (终端 CLI) │  │  Extension  │  │  (桌面应用) │  │  (浏览器)   │
└──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘
       │                │                │                │
       └────────────────┴────────┬───────┴────────────────┘
                                 │
                          ┌──────▼──────┐
                          │ App Server  │  ← JSON-RPC 协议
                          │ (stdio)     │
                          └──────┬──────┘
                                 │
                    ┌────────────▼────────────┐
                    │      Codex Core         │
                    │  (代理循环 + 工具执行)   │
                    └─────────────────────────┘
```

**App Server 内部组件：**
- **stdio reader**：读取客户端 JSON-RPC 请求
- **message processor**：将请求转换为 Codex Core 操作，将内部事件转换为 JSON-RPC 通知
- **thread manager**：管理会话线程的创建、恢复、分叉
- **core threads**：实际的代理执行会话

**三个会话原语（Conversation Primitives）：**

| 原语 | 说明 |
|------|------|
| **Item** | 原子输入/输出单元，有明确生命周期（started → delta → completed）。可以是用户消息、代理消息、工具执行、审批请求或 diff |
| **Turn** | 一组由单次用户输入触发的 Items 序列 |
| **Thread** | 持久化的会话容器，支持创建、恢复、分叉、归档，客户端可重连而不丢失状态 |

**Item 类型：**
- `userMessage` — 用户输入（text、image、localImage）
- `agentMessage` — 代理回复文本
- `plan` — 计划模式下的规划文本
- `reasoning` — 推理摘要和原始推理块
- `commandExecution` — 沙箱命令执行（含状态：inProgress/completed/failed/declined）

---

## 4. 内置工具系统

与 Claude Code 的 20+ 专用工具不同，Codex CLI 采用 **Shell-Centric** 设计，核心只有两个主要工具：

### 4.1 Shell 工具

通用命令执行器，模型通过 shell 调用各种 CLI 工具完成操作：

```json
{"cmd": ["ls", "-la", "src/"]}
{"cmd": ["grep", "-rn", "TODO", "src/"]}
{"cmd": ["cat", "package.json"]}
```

**命令按能力分组进行审批：**
- 读取操作（`cat`、`ls`、`grep`）：在 Auto 模式下自动批准
- 写入操作（`rm`、`mv`）：需要确认
- 危险操作（`git push --force`）：始终需要确认

### 4.2 apply_patch 工具

文件编辑的核心机制，模型被训练为擅长这种 diff 格式：

```
 Begin Patch
 Update File: src/utils.py
@@ def greet():
-    print("Hi")
+    print("Hello, world!")
 End Patch
```

**支持的文件操作：**

| 操作 | 格式 |
|------|------|
| 创建文件 | `Add File: path/to/file.txt` + 以 `+` 开头的行 |
| 删除文件 | `Delete File: path/to/file.txt` |
| 更新文件 | `Update File: path/to/file.py` + `@@` 上下文行 + `-`/`+` diff |
| 移动文件 | `Update File: src/app.py` + `Move to: src/main.py` |

**实现细节：**
- `handleExecCommand` 检测到 `apply_patch` 命令时，不通过 shell 执行
- 而是调用 `execApplyPatch` → `process_patch`，使用文件系统 API 直接修改文件
- UI 层使用 `parse-apply-patch` 渲染 diff 供用户审查
- OpenAI 的 Responses API 也提供 `apply_patch` 作为内置工具类型

### 4.3 其他内置工具

| 工具 | 说明 |
|------|------|
| `read_file` | 读取文件内容 |
| `grep_files` | 搜索文件内容 |
| `list_dir` | 列出目录 |
| `view_image` | 查看图片（v0.117.0 新增） |
| `update_plan` | 更新计划/TODO 列表 |
| `web_search` | 网页搜索 |
| Browser Use（CDP） | 内置浏览器 + Chrome DevTools Protocol，前端调试/性能分析（详见 §18.4，需 Developer Mode + 逐次批准 CDP 访问） |

> **注意：`js_repl` 已在 v0.128.0 移除。** 早期文档/博客提到的 `js_repl` 工具不再存在，勿再引用。

**工具优先级规则（来自 Codex Prompting Guide）：**
> "Strictly avoid raw cmd/terminal when a dedicated tool exists. Default to solver tools: git (all git), list_dir, apply_patch. Use cmd/run_terminal_cmd only when no listed tool can perform the action."

### 4.4 与 Claude Code 工具系统对比

| 维度 | Codex CLI | Claude Code |
|------|-----------|-------------|
| 设计哲学 | Shell-Centric（少量工具 + shell） | Tool-Centric（20+ 专用工具） |
| 文件编辑 | `apply_patch`（diff 格式） | `Edit`（精确字符串替换）+ `MultiEdit` |
| 文件读取 | `cat` via shell / `read_file` | `Read`（带行号、分页、PDF/图片支持） |
| 文件搜索 | `grep`/`find` via shell / `grep_files` | `Grep`（基于 ripgrep）+ `Glob` |
| 文件创建 | `apply_patch` Add File | `Write` |
| 任务管理 | `update_plan` | `TodoRead` / `TodoWrite` / `TaskCreate` 等 |
| 批量操作 | 无（单工具调用） | `BatchTool`（多工具打包） |

---

## 5. 沙箱与安全系统

Codex CLI 最突出的特性是 **OS 级内核沙箱**，这是与 Claude Code（应用层 hooks）的最大架构差异。

### 5.1 三种沙箱模式

| 模式 | CLI 参数 | 文件权限 | 命令执行 | 适用场景 |
|------|----------|----------|----------|----------|
| **Read-Only**（默认） | `--sandbox read-only` | 只读 | 建议执行，需确认 | 安全验证、学习 |
| **Workspace Write** | `--sandbox workspace-write` | 工作区可写 | 需确认 | 日常开发 |
| **Danger Full Access** | `--sandbox danger-full-access` | 完全访问 | 自动执行 | CI 环境、完全自动化 |

### 5.2 平台实现

**macOS — Apple Seatbelt：**
- 使用 `/usr/bin/sandbox-exec` 执行命令
- 运行时编译模式特定的 Seatbelt 策略文件（`-p` 参数）
- 内核级强制执行，进程启动前就已被沙箱化
- 网络禁用时直接省略网络权限（Seatbelt 默认拒绝）
- 支持精细的权限配置：`macos_preferences`、`macos_automation`、`macos_accessibility`、`macos_calendar`

```rust
// codex-rs/core/src/seatbelt.rs
let network_policy = if has_full_network_access {
    "(allow network-outbound)\n(allow network-inbound)\n(allow system-socket)"
} else {
    ""
};
```

**Linux — Landlock + seccomp + Bubblewrap：**
- `codex-linux-sandbox` 是独立的辅助二进制，作为子进程启动
- **Landlock**：文件系统限制，全局只读 + 白名单目录可写（+ `/dev/null`）
- **seccomp**：系统调用过滤，阻止出站网络 socket（保留 `AF_UNIX` 用于本地 IPC）
- **Bubblewrap**（`bwrap`）：现代管道，提供 PID 隔离（`--unshare-pid`）和网络隔离（`--unshare-net`）
- 在 `execvp` 之前应用所有限制——目标命令启动时已在沙箱中

```rust
// codex-rs/linux-sandbox/src/landlock.rs
pub fn apply_sandbox_policy_to_current_thread() -> Result<()> {
    if !has_full_network_access {
        install_network_seccomp_filter_on_current_thread()?;
    }
    if !has_full_disk_write_access {
        let writable_roots = get_writable_roots_with_cwd();
        install_filesystem_landlock_rules_on_current_thread(&writable_roots)?;
    }
    Ok(())
}
```

**Windows：**
- 原生沙箱使用 restricted tokens（v0.100.0 从实验性升级为正式）
- WSL 模式继承 Linux 的 Landlock + seccomp
- VS Code 扩展支持 WSL 直接运行
- 4~6 月持续加固：命名管道、ConPTY 拆除、PowerShell 包裹的 allow 规则、worktree `safe.directory` 等修复
- Windows 桌面新增**逐应用访问控制**（per-app access controls，26.5xx）
- **Computer Use 现已支持 Windows**（26.527）：Codex 可在前台看/点/输操作 Windows 桌面应用

**网络控制：**
- 默认禁用网络访问
- 可通过配置启用：`sandbox_workspace_write.network_access = true`
- 托管代理模式下，Bubblewrap 管道通过 proxy-only bridge 路由出站流量

### 5.3 进程加固

`codex-process-hardening` crate 提供额外的安全层：
- 阻止 `LD_PRELOAD` 和 `DYLD_*` 环境变量注入
- 在 `#[ctor::ctor]` 中执行 `pre_main_hardening()`，在 main 函数之前生效

### 5.4 沙箱测试命令

```bash
# macOS
codex sandbox macos [--full-auto] [--log-denials] [COMMAND]...

# Linux
codex sandbox linux [--full-auto] [COMMAND]...

# Windows
codex sandbox windows [--full-auto] [COMMAND]...

# 旧版别名
codex debug seatbelt ...
codex debug landlock ...
```

### 5.5 与 Claude Code 安全模型对比

| 维度 | Codex CLI | Claude Code |
|------|-----------|-------------|
| 沙箱层级 | OS 内核级（Seatbelt/Landlock/seccomp） | 应用层（hooks + bubblewrap） |
| 逃逸抵抗 | 高：OS 在应用边界之下拒绝系统调用 | 中等：hooks 与代理共享进程边界 |
| 可编程性 | 低：按沙箱模式二元允许/拒绝 | 高：hook 脚本可执行任意代码 |
| 权限粒度 | 三种模式（read-only/workspace-write/full-access） | 每工具模式匹配的 allow/deny 列表 |
| 网络控制 | 默认禁用，内核级阻断 | 代理域名白名单 |

---

## 6. 权限与审批模式

### 6.1 审批模式

审批模式定义 Codex 在多大程度上可以不经确认就执行操作。可通过 `/permissions`（或 `/approvals`）在会话中切换。

> **⚠️ 重大变化（v0.128.0，2026-04-30）：`--full-auto` 已 deprecated。** OpenAI 转向**显式权限 Profiles**（组合 `--profile` + `--sandbox`，或选内置 profile），不再推荐笼统的 full-auto 开关。`--full-auto` 目前仍是 `--ask-for-approval on-request` + `--sandbox workspace-write` 的快捷方式（注意 workspace-write 下网络默认仍关闭），但官方文档已用显式 sandbox/approval 标志或 profile 替换所有 full-auto 示例。

**三个正交轴（理解权限的关键）：** 自动批准行为不是单一开关，实际由三个维度共同决定：
- `approval_policy`：agent 多频繁请求审批
- `sandbox_mode`：文件/命令访问能走多远（read-only / workspace-write / danger-full-access）
- `network_access`：是否允许出站网络（workspace-write 下**默认关闭**，需显式开启）

常见误区是只看 `approval_policy`，忽略 `sandbox_mode` 同样关键。

**桌面/App 审批模式（当前形态）：**

| 模式 | 说明 | 适用场景 |
|------|------|----------|
| **Default（默认权限）** | 沙箱内工作，需手动逐次批准；每次联网都询问 | 敏感项目、需人在环 |
| **Auto Review（自动审查）** | 沙箱内工作，由 **AI 审查代理**在动作执行前判断是否放行（见 §6.5） | 兼顾自动化与安全 |
| **Full Access** | 直接改本地文件，接近 Claude Code 的 bypass 模式 | 隔离环境/一次性容器 |

v0.144.0 起 App 还新增了 `writes` 审批模式：声明为只读的动作放行，写入动作则提示。

**审批策略（Approval Policy）：**

| 策略 | 说明 |
|------|------|
| `on-request` | 每次操作都请求审批（默认） |
| `untrusted` | 更严格，额外限制；任何敏感操作暂停等人工审查 |
| `never` | 从不请求审批 |
| ~~`on-failure`~~ | 已 deprecated |

### 6.1.1 权限 Profiles（推荐配置单元）

Profile 把 model、sandbox、approval 打包为单一激活单元，是 Codex CLI 最核心的差异化——「配置即设计单元」。除内置默认外，可在 `config.toml` 定义命名 `[profiles.NAME]`。典型三档：

| Profile | 沙箱 / 网络 | 审批 | 认证 | 场景 |
|---------|------------|------|------|------|
| `dev`（开发者笔记本） | workspace-write + 网络开 | `never`（人在键盘边逐条审阅） | ChatGPT OAuth | 最宽松，探索性编辑 |
| `ci`（CI worker） | workspace-write + 网络关 | `untrusted`（敏感操作halt） | API Key（CI runner 专用、密钥轮换） | 无人值守流水线 |
| `prod`（生产 agent） | 收紧 | 严格 | 受控 | 生产环境 agent |

`codex sandbox` 子命令也支持选择 sandbox profile、cwd 控制，并向客户端暴露 active-profile 元数据。

### 6.2 YOLO 模式

完全跳过权限检查和沙箱：
```bash
codex --dangerously-bypass-approvals-and-sandbox
```

> 注意：社区用户常创建别名 `codex-yolo` 来简化此操作。与 Claude Code 的 `--dangerously-skip-permissions` 类似。

### 6.3 中途转向（Mid-Turn Steering）

Codex 支持在代理执行过程中注入新指令：
- 按 `Enter`：向当前 turn 注入新指令
- 按 `Tab`：排队一个 follow-up prompt，在下一个 turn 执行
- 这减少了等待代理完成错误方向工作的浪费

### 6.4 版本控制集成

Codex 建议配合 Git 工作流使用：
- 在每个任务前后创建 Git checkpoint
- 所有操作都会在 transcript 中记录，可通过 `git diff` 审查或回滚
- Codex 始终展示操作记录，用户可用常规 git 工作流回滚

### 6.5 Auto-Review（自动审批审查，2026-04 新增）

自动审批审查把符合条件的审批请求先路由给一个**审查代理**，在动作真正执行**之前**评估风险，再展示审查状态与风险等级供用户决策。

**设计要点：** 审查发生在动作**执行前**（pre-action），而非事后总结（post-hoc）。事后摘要利于审计日志，但事前审查才能在 agent 尝试危险操作（装依赖、改网络可达资源等）时把爆炸半径控制到最小。这体现了 OpenAI 对「coding agent 未来 = 处处全自动」的否定，转向「受约束的自主 + 有用的审查闸门」。

**配置：** `approval_policy = "on-request"` + `approvals_reviewer = "auto_review"`（可配置审查用的模型）。

> **已知问题（社区）：** 桌面版在 context compaction / resume 后，重新生成的权限 developer message 有时会丢失 `approvals_reviewer = auto_review`，导致原本 auto-review 的线程退回手动审批（issue #23875）。根因在 context rebuild/resume 路径，非用户配置文件。这里的通用教训是：恢复会话时必须完整保留权限/审批状态，否则安全配置会在 resume 后静默降级。

### 6.6 中途转向（Queue vs Steer）

除 §6.3 的 Enter（注入当前 turn）/ Tab（排队下一 turn）外，移动端与 App 现可设置默认 follow-up 行为为 **Queue（排队）或 Steer（转向）**。这是「永不丢输入」体验的一部分。

---

## 7. Slash 命令

### 7.1 CLI Slash 命令

在交互模式中输入 `/` 开头的命令。

**会话管理：**

| 命令 | 功能 | 说明 |
|------|------|------|
| `/clear` | 清除终端和对话 | 重新开始 |
| `/compact` | 压缩对话释放 tokens | 长会话后使用 |
| `/copy` | 复制最新完成的输出 | |
| `/diff` | 显示 Git diff | 包括未跟踪文件 |
| `/exit` / `/quit` | 退出 CLI | |
| `/status` | 显示线程 ID、上下文用量、速率限制 | |

**会话管理（新增）：**

| 命令 | 功能 | 说明 |
|------|------|------|
| `/new` | 开新对话 | |
| `/resume` | 恢复历史对话 | v0.129.0 重设计的 workflow picker，更易恢复/分叉 |
| `/fork` | 把当前对话分叉为新线程 | 探索多解路径 |
| `/side` | 问一个不进主对话的旁支问题 | |
| `/rename` `/title` | 重命名会话 / 编辑标题 | `/title` 可在 turn 进行中编辑 |
| `/rollout` `/raw` | 查看 rollout / 原始 scrollback 模式 | |
| `/import` | 从 Claude Code 选择性导入 setup、项目配置、最近对话 | **v0.140.0 新增**，另有 App 内"Migrate to Codex"引导流（含 Claude Cowork） |
| `/usage` | 查看日/周/累计账户 token 活动 | **v0.140.0 新增**，补足 credit ledger 不透明的痛点 |
| `/delete` | 永久删除会话 | v0.140.0 新增（另有 `codex delete` 子命令与 app-server `thread/delete`），带确认保护 + 子代理清理 |

**模型与配置：**

| 命令 | 功能 | 说明 |
|------|------|------|
| `/model` | 切换模型 | GPT-5.6 Sol/Terra/Luna、GPT-5.5 等 |
| `/permissions` / `/approvals` | 设置审批模式 | Default / Auto Review / Full Access |
| `/theme` | 打开主题选择器 | 支持自定义 `.tmTheme` 文件 |
| `/statusline` | 主题感知状态栏，可显示 PR + 分支变更摘要 | 可在 turn 进行中编辑 |
| `/keymap` | 配置 TUI 键盘快捷键 | v0.128.0 新增（可配置 keymaps） |
| `/vim` | 切换 composer 的 Vim 模态编辑 | v0.129.0 新增，可配默认模式 |
| `/personality` | 切换回复风格 | friendly / pragmatic / none |
| `/fast` | 切换 Fast 模式 | `/fast on\|off\|status`，消耗 credit 更高 |
| `/experimental` | 切换实验性功能 | 如 subagents |
| `/settings` `/setup-default-sandbox` | 设置 / 配置默认沙箱 | |

**代理与工具：**

| 命令 | 功能 | 说明 |
|------|------|------|
| `/goal` | 设置/查看/暂停/恢复/清除长时目标 | v0.128.0 引入，**2026-05-21 升 GA**（CLI/IDE/App），详见 §7.6 |
| `/plan` | 早期塑形方案（预飞行） | 与 `/goal`（自动驾驶）互补 |
| `/agent` `/subagents` | 切换活跃代理线程 / 管理子代理 | 查看或继续子代理工作 |
| `/collab` | 协作模式 | |
| `/apps` | 浏览应用（连接器） | 以 `$app-slug` 插入 prompt |
| `/review` | 启动代码审查 | 独立审查代理，可 `/review staged changes` |
| `/skills` | 浏览和调用 skills | 以 `$skill-name` 调用 |
| `/plugins` | 管理插件 | v0.117.0 新增，v0.129.0 强化（工作区共享、访问控制、来源过滤） |
| `/hooks` | 浏览/开关生命周期 hooks | v0.129.0 新增，TUI 内发现与切换 |
| `/mcp` | 列出 MCP 工具与资源 | `/mcp verbose` 看详情 |
| `/mention` `@` | @ 提及文件/上下文 | |
| `/ide` | 纳入 IDE 选区/打开文件/上下文 | |
| `/memories` | 管理记忆 | |
| `/sandbox-add-read-dir` | 授予沙箱额外读取目录 | |

**其他：**

| 命令 | 功能 |
|------|------|
| `/init` | 生成 `AGENTS.md` 项目指令文件（App composer 也已支持） |
| `/feedback` | 发送日志给维护者 |
| `/clean` `/stop` | 清理 / 停止当前工作 |
| `/debug-config` | 调试配置 |

### 7.2 IDE 扩展 Slash 命令

IDE 扩展中的命令更精简：

| 命令 | 功能 |
|------|------|
| `/status` | 显示状态 |
| `/review` | 代码审查 |
| `/feedback` | 反馈 |
| `/local` | 切换到本地模式 |
| `/cloud` | 切换到云端模式 |

### 7.3 App Slash 命令

| 命令 | 功能 |
|------|------|
| `/feedback` | 提交反馈 |
| `/mcp` | 查看 MCP 服务器状态 |
| `/plan-mode` | 切换计划模式 |
| `/review` | 代码审查 |
| `/status` | 显示线程 ID、上下文、速率限制 |

### 7.4 自定义命令（Custom Prompts）

用户可在 `~/.codex/prompts/` 目录创建自定义命令：

```markdown
<!-- ~/.codex/prompts/draftpr.md -->
---
name: draftpr
description: Draft a pull request description
arguments:
  - name: FILES
    description: Files to include
  - name: PR_TITLE
    description: PR title
---
Review the following files and draft a PR description:
Files: $FILES
Title: $PR_TITLE
```

调用方式：
```
/prompts:draftpr FILES="src/pages/index.astro" PR_TITLE="Add hero animation"
```

### 7.5 快捷键与交互

| 快捷键 | 功能 |
|--------|------|
| `@` | 模糊文件搜索，Tab/Enter 插入路径 |
| `!` | 运行本地 shell 命令（如 `!ls`） |
| `$` | 调用 skill（如 `$skill-name`） |
| `Enter`（代理运行中） | 向当前 turn 注入新指令 |
| `Tab`（代理运行中） | 排队 follow-up prompt |
| `Esc Esc`（composer 为空） | 编辑上一条用户消息，继续按可回溯更早消息 |
| `o`（审批弹窗中） | 打开请求审批的线程查看详情 |

### 7.6 `/goal` 持续目标工作流（v0.128.0 引入，2026-05-21 升 GA）

`/goal` 把一次普通 prompt 变成**持久化、自我校验的长时 agent**：它循环 plan → act → test → review → iterate，直到满足停止条件或被暂停。这是 Jeffrey Huntley 2024 年「Ralph Loop」（bash 版循环直到达成目标）的官方化，OpenAI 明确致谢了作者。

> **⚠️ 状态更新：`/goal` 已于 2026-05-21（App 版本线 26.519）从实验性升级为 GA**，横跨 Codex CLI / IDE 扩展 / App 三处均正式可用。因此**不再需要 feature flag 才能用**（下方"启用"步骤是历史 0.128.0 时的做法，GA 后可直接使用）。官方 Cookbook《Using Goals in Codex》给出了 goal prompt 的推荐写法（明确完成条件、成功如何校验、必须保持的约束）。

**与普通 prompt 的本质区别：** 普通 prompt 跑 2~3 个 turn 就停下问你或等待；`/goal` 让 goal 成为**挂在 thread 上的一等对象**（非仅仅 transcript 里的文字），有显式状态：`pursuing`（追求中）/ `paused`（暂停）/ `achieved`（达成）/ `budget-limited`（预算受限）。循环**跨 turn、跨暂停、跨 context compaction 存活**——agent 不必每个 turn 从 chat history 重新推导自己在做什么，它「就是知道」。适合多小时的 refactor、迁移、长跑 QA、docs 流水线、需稳定目标的多 agent 工作。

**启用（历史：0.128.0 ~ GA 前需 flag；GA 后无需）：**
```bash
# GA（2026-05-21，26.519）后直接用 /goal 即可，以下为历史做法：
# 方式一
codex features enable goals
# 方式二：写入 ~/.codex/config.toml
[features]
goals = true
# 需要 v0.128.0+，重启 CLI
```

**生命周期控制：** `/goal`（设置/查看）、`/goal pause`、`/goal resume`、`/goal clear`。底层由 app-server API、model tools、runtime continuation、TUI 控件共同支撑。

> **v0.129.0（GA 前）行为变更：** goals 在 resume 后**默认保持 paused**，除非显式重新开启（改变了 v0.128.0 的默认续跑行为）——防止意外长跑烧配额。

**风险提示（官方 + 社区）：** `/goal` 不比普通运行更安全。目标含糊会烧掉周配额或产生大范围偏离目标的改动（因为 Codex 会一直干到它自认为完成）。最佳实践：只读或 scratch 分支运行、定义**一个可度量的停止条件**（测试/eval/构建/截图/Lighthouse 通过）、漂移时用 `/goal pause` 或 `/goal clear`。有社区玩法是「让另一个 AI 帮你写 `/goal` prompt」（元提示）以提升成功率。

---

## 8. CLI 命令与参数

### 8.1 子命令

| 子命令 | 成熟度 | 说明 |
|--------|--------|------|
| `codex` | Stable | 启动交互式 TUI |
| `codex app` | Stable | 启动 macOS 桌面应用 |
| `codex app-server` | Experimental | 启动 App Server（本地开发/调试） |
| `codex apply` | Stable | 将 Codex Cloud 任务的 diff 应用到本地（别名：`codex a`） |
| `codex cloud` | Experimental | 浏览/执行 Codex Cloud 任务（别名：`codex cloud-tasks`） |
| `codex completion` | Stable | 生成 shell 补全脚本（Bash/Zsh/Fish/PowerShell） |
| `codex exec` | Stable | 非交互模式执行（`codex exec "fix the CI failure"`） |
| `codex mcp` | Stable | 管理 MCP 服务器 |
| `codex mcp-server` | Experimental | 将 Codex 作为 MCP 服务器运行 |
| `codex resume` | Stable | 恢复之前的会话 |
| `codex sandbox` | Stable | 测试沙箱配置、选择 sandbox profile |
| `codex features` | Stable | 管理 feature flags |
| `codex update` | Stable | **v0.128.0 新增**：一步升级 CLI 到最新版（独立二进制安装无需手动重装；npm 安装仍用 `npm i -g @openai/codex@latest`） |
| `codex debug` | Stable | 内置调试工具（`codex debug --help` 列出诊断助手） |
| `codex doctor` | Stable | 环境自检 |

### 8.2 核心 CLI 参数

**模型与行为：**

| 参数 | 说明 |
|------|------|
| `--model, -m` | 覆盖配置的模型（如 `-m gpt-5.6-sol`） |
| `--sandbox, -s` | 沙箱策略：`read-only` / `workspace-write` / `danger-full-access` |
| ~~`--full-auto`~~ | **已 deprecated**（v0.128.0）：改用显式 `--profile` + `--sandbox` 或内置 profile |
| `--profile, -p` | 选择 config.toml 中定义的配置 profile（推荐替代 full-auto） |
| `--oss` | 使用本地开源 provider（需要运行中的 Ollama 实例） |
| `--add-dir` | 授予沙箱额外目录写入权限 |
| `--skip-git-repo-check` | 允许在非 Git 仓库中运行 |

**输出控制：**

| 参数 | 说明 |
|------|------|
| `--json` | JSON 输出格式 |
| `--output-last-message, -o` | 将最终消息写入文件（用于下游脚本） |
| `--output-schema` | JSON Schema 文件，验证最终响应格式 |

**安全与权限：**

| 参数 | 说明 |
|------|------|
| `--dangerously-bypass-approvals-and-sandbox` | 跳过所有权限和沙箱 |
| `--yolo` | `--full-auto` 的别名 |

**配置覆盖：**

```bash
# 专用参数
codex --model gpt-5.4

# 通用 key/value 覆盖（值为 TOML 格式）
codex --config model='"gpt-5.4"'
codex --config sandbox_workspace_write.network_access=true
codex --config 'shell_environment_policy.include_only=["PATH","HOME"]'
```

### 8.3 会话恢复

```bash
# 交互式选择恢复
codex resume

# 列出所有会话
codex resume --all

# 恢复最近的会话
codex resume --last

# 按 ID 恢复
codex resume <SESSION_ID>

# 非交互模式也可恢复
codex exec resume --last "Fix the race conditions you found"
```

会话存储在 `~/.codex/sessions/`。

---

## 9. 配置系统

### 9.1 配置文件

Codex 使用 TOML 格式配置文件 `~/.codex/config.toml`（Rust CLI 使用 TOML，旧版 TypeScript CLI 使用 JSON）。

**基本配置示例：**
```toml
# 模型设置（ChatGPT 登录会话建议留空，自动跟随推荐默认）
model = "gpt-5.6"          # 或 gpt-5.6-sol / gpt-5.6-terra / gpt-5.6-luna
model_reasoning_effort = "medium"

# 沙箱设置
[sandbox_workspace_write]
network_access = true

# Shell 环境策略
[shell_environment_policy]
include_only = ["PATH", "HOME"]

# Feature flags
[features]
codex_hooks = true
use_linux_sandbox_bwrap = true
# 注：goals 已于 2026-05-21 GA，无需再设 flag；旧版本(0.128~GA前)才需 goals = true

# 权限（v0.128.0 结构化权限，取代 --full-auto）
default_permissions = "workspace-write"
[permissions.filesystem]
# 声明式文件系统权限
[permissions.network]
# 声明式网络权限
approval_policy = "on-request"
approvals_reviewer = "auto_review"   # 启用 §6.5 事前审查代理

# TUI 主题
[tui]
theme = "Dracula"

# Web 搜索
web_search = "cached"  # "cached" | "live" | "disabled"
```

### 9.2 配置 Profiles

v0.128.0 起 Profile 不再只绑定模型/推理努力，而是把 **model + sandbox + approval + 认证方式 + MCP roster** 打包为单一激活单元（见 §6.1.1）。可在 config.toml 定义命名 `[profiles.NAME]`，按任务类型切换：

| Profile | 模型 | 推理努力 | 沙箱/审批 | 适用场景 |
|---------|------|----------|-----------|----------|
| `fast` | `gpt-5.4-mini` | low | read-only | 快速问答、格式化 |
| （默认） | `gpt-5.6`（跟随推荐） | medium | workspace-write / on-request | 日常开发 |
| `careful` | `gpt-5.6-sol` | xhigh | read-only / on-request | 架构设计、安全审查 |
| `dev` | `gpt-5.6` | medium | workspace-write + 网络 / never | 人在键盘边、逐条审阅 |
| `ci` | `gpt-5.4-mini` | low | workspace-write 无网络 / untrusted | CI/CD 自动化（API Key） |

使用方式：`codex --profile careful`（推荐用 profile 替代已弃用的 `--full-auto`）

### 9.3 配置层级

配置按优先级从高到低加载：

1. CLI 参数（`--model`、`-c key=value`）
2. 环境变量
3. 项目级配置（`<repo>/.codex/config.toml`）
4. 用户级配置（`~/.codex/config.toml`）

### 9.4 项目根检测

Codex 从工作目录向上遍历，直到找到包含 `.git` 的目录作为项目根。可自定义：

```toml
project_root_markers = [".git", "package.json", "Cargo.toml"]
```

### 9.5 Team Config（团队配置）

2026 年 1 月新增，支持团队共享配置，确保团队成员使用一致的设置。

### 9.6 Feature Flags

```bash
# 列出所有 feature flags
codex features list

# 启用
codex features enable unified_exec

# 禁用
codex features disable shell_snapshot
```

写入 `~/.codex/config.toml`。如果使用 `--profile`，则写入对应 profile。

---

## 10. AGENTS.md 与规则系统

### 10.1 AGENTS.md 概述

`AGENTS.md` 是 Codex 的项目级指令文件，功能类似 Claude Code 的 `CLAUDE.md`。它是一个**开放标准**（由 Agentic AI Foundation 维护），旨在跨工具兼容。

**加载位置（按优先级）：**

| 位置 | 说明 |
|------|------|
| `$CWD/AGENTS.md` | 当前工作目录 |
| `$CWD/../AGENTS.md` | 上级目录（Git 仓库内） |
| `$REPO_ROOT/AGENTS.md` | Git 仓库根目录 |
| `~/.codex/instructions.md` | 全局用户指令 |

Codex 在每次任务前自动读取这些文件，将内容注入到对话上下文中。

**典型内容：**
```markdown
# AGENTS.md

## Project Overview
This is a Next.js 14 app with TypeScript and Tailwind CSS.

## Commands
- Run tests: `npm test`
- Lint: `npm run lint`
- Build: `npm run build`

## Conventions
- Use functional components with hooks
- All API routes go in /app/api/
- Write tests for every new function
- Use Zod for input validation
```

### 10.2 与 CLAUDE.md 的对比

| 维度 | AGENTS.md (Codex) | CLAUDE.md (Claude Code) |
|------|-------------------|------------------------|
| 标准化 | 开放标准（Agentic AI Foundation） | Anthropic 专有格式 |
| 跨工具兼容 | 是（Codex、OpenClaw 等均支持） | 仅 Claude Code |
| 注入方式 | 作为对话历史前缀 | 作为 `system-reminder` 标签注入 user messages |
| 初始化 | `/init` 命令自动生成 | `/init` 命令自动生成 |

### 10.3 Rules 系统

除 AGENTS.md 外，Codex 还支持独立的 Rules 配置，提供更结构化的指令管理。详见官方文档 Rules 章节。

---

## 11. Skills 系统

### 11.1 概述

Skills 是可复用的指令包，教 Codex 特定的工作流程。每个 Skill 是一个包含 `SKILL.md` 文件的目录。

**SKILL.md 格式：**
```markdown
---
name: hello
description: Greet the user with a friendly message.
---

Greet the user warmly and ask how you can help.
```

**目录结构：**
```
my-skill/
├── SKILL.md          # 必需：指令 + 元数据
├── scripts/          # 可选：可执行脚本
├── references/       # 可选：参考文档
├── assets/           # 可选：模板、资源
└── agents/
    └── openai.yaml   # 可选：UI 显示名、调用策略、MCP 依赖
```

### 11.2 Skill 作用域

| 作用域 | 位置 | 说明 |
|--------|------|------|
| REPO | `$CWD/.agents/skills` | 当前工作目录的 skills |
| REPO | `$CWD/../.agents/skills` | 上级目录（monorepo 场景） |
| REPO | `$REPO_ROOT/.agents/skills` | 仓库根目录，所有子目录可用 |
| USER | `$HOME/.agents/skills` | 用户个人 skills，跨仓库可用 |
| ADMIN | `/etc/codex/skills` | 系统级 skills，所有用户可用 |

### 11.3 调用方式

1. **显式调用**：在 prompt 中输入 `$skill-name`，或通过 `/skills` 浏览选择
2. **隐式调用**：Codex 读取 skill 的 `description`，当任务匹配时自动激活
3. **渐进式加载**：启动时只加载 skill 名称和描述，实际使用时才加载完整指令

### 11.4 内置 Skills

| Skill | 功能 |
|-------|------|
| `$skill-creator` | 创建新 skills |
| `$skill-installer` | 安装社区 skills |
| `$plugin-creator` | 创建新 plugins |
| Figma skill | 从 Figma 设计转换为生产级 UI 代码 |
| Linear skill | Bug 分类、发布跟踪、工作负载管理 |
| 部署 skills | 推送到 Cloudflare / Netlify / Vercel / Render |
| Image Generation | 集成 GPT Image 创建和编辑图片 |

### 11.5 跨平台兼容

SKILL.md 格式是跨平台标准，以下工具均支持：
- **Codex**：`~/.agents/skills/`
- **Claude Code**：`~/.claude/skills/`
- **OpenClaw**：`~/.openclaw/skills/`

Agent Skills 规范提供了跨平台标准定义。

---

## 12. Plugins 系统

### 12.1 概述

Plugins 是 v0.117.0（2026.3.26）新增的功能，是可安装的包，将 skills、应用集成和 MCP 服务器配置打包为可复用的工作流。

**Plugin 目录结构：**
```
my-plugin/
├── .codex-plugin/
│   └── plugin.json       # 必需：插件清单
├── skills/
│   └── my-skill/
│       └── SKILL.md      # 可选：skill 指令
├── .app.json             # 可选：应用/连接器映射
├── .mcp.json             # 可选：MCP 服务器配置
└── assets/               # 可选：图标、截图
```

### 12.2 安装与使用

**在 App 中：**
- OpenAI 策划的插件出现在 Codex 目录中

**在 CLI 中：**
```bash
# 打开插件管理界面
codex plugins
```

**本地安装：**
1. 使用 `$plugin-creator` skill 脚手架创建插件
2. 或手动复制到 `~/.codex/plugins/`
3. 更新 `~/.agents/plugins/marketplace.json`

### 12.3 Plugin Manifest（plugin.json）

清单文件有三个职责：
1. 标识插件（名称、版本、描述）
2. 指向打包的组件（skills、apps、MCP 服务器）
3. 提供安装界面元数据（描述、图标、法律链接）

---

## 13. Hooks 系统

### 13.1 概述

Codex 的 Hooks 系统允许在特定事件发生时执行自定义命令。需要通过 feature flag 启用：

```toml
[features]
codex_hooks = true
```

**配置位置：**
- `~/.codex/hooks.json`（用户级）
- `<repo>/.codex/hooks.json`（项目级）

### 13.2 Hook 事件类型

| 事件 | 触发时机 |
|------|----------|
| `SessionStart` | 会话启动或恢复 |
| `PreToolUse` | 工具执行前 |
| `PostToolUse` | 工具执行后 |

### 13.3 配置示例

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume",
        "hooks": [
          {
            "type": "command",
            "command": "python3 ~/.codex/hooks/session_start.py",
            "statusMessage": "Loading session notes"
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "/usr/bin/python3 \"$(git rev-parse --show-toplevel)/.codex/hooks/pre_tool_use_policy.py\"",
            "statusMessage": "Checking Bash command"
          }
        ]
      }
    ]
  }
}
```

### 13.4 与 Claude Code Hooks 对比

| 维度 | Codex Hooks | Claude Code Hooks |
|------|-------------|-------------------|
| 成熟度 | 较新，需 feature flag 启用 | 成熟，17 种事件类型 |
| 事件数量 | 较少（SessionStart、PreToolUse、PostToolUse） | 17 种（含 PreCommit、PostCommit 等） |
| 配置格式 | JSON | JSON（settings.json） |
| 可编程性 | 任意命令 | 任意命令 + URL hook |

---

## 14. 子代理系统（Subagents）

### 14.1 概述

Codex 支持子代理工作流，用于并行化大型任务。每个子代理有独立的模型和工具调用，因此消耗更多 tokens。

**关键特性：**
- Codex 只在用户明确要求时才生成子代理
- 子代理继承父级的沙箱策略
- 父级 turn 的运行时覆盖（如 `/approvals` 更改、`--yolo`）会传递给子代理
- 在交互式 CLI 中，非活跃代理线程的审批请求也会弹出
- **MultiAgentV2**（v0.128.0）：多代理配置更新；`/subagents` 命令管理，App 内后台子代理有稳定 identicon
- 选择 Ultra reasoning 时，若多代理并发过高会警告可能快速增加用量（v0.144.0）

### 14.2 配置

在 `config.toml` 中配置代理角色：

```toml
[agents]
# 代理角色配置
```

### 14.3 审批行为

- 交互式会话中：审批弹窗显示来源线程标签，按 `o` 可打开该线程查看详情
- 非交互模式中：需要新审批的操作会失败，错误返回给父工作流
- 使用 `/agent` 命令在代理线程间切换

### 14.4 与 Claude Code 子代理对比

| 维度 | Codex Subagents | Claude Code Agent Tool |
|------|-----------------|----------------------|
| 触发方式 | 用户明确要求 | 模型自主决定或用户要求 |
| 代理类型 | 通用（通过 config.toml 配置角色） | 预定义类型（Explore/Plan/general-purpose） |
| 隔离方式 | 独立线程 | 独立对话上下文 |
| Worktree 支持 | 是（App 中内置） | 是（`isolation: "worktree"`） |
| 后台运行 | 是 | 是（`run_in_background`） |

---

## 15. MCP 协议集成

### 15.1 MCP 客户端

Codex CLI 作为 MCP 客户端，可连接外部 MCP 服务器扩展工具能力。

**配置方式（`~/.codex/config.toml`）：**
```toml
# STDIO 模式
[[mcp.servers]]
name = "my-server"
transport = "stdio"
command = "npx"
args = ["-y", "@my-org/my-mcp-server"]

# Streaming HTTP 模式
[[mcp.servers]]
name = "remote-server"
transport = "streamable-http"
url = "https://my-server.example.com/mcp"
```

**CLI 管理命令：**
```bash
codex mcp add <name> <url>    # 添加 MCP 服务器
codex mcp list                # 列出已配置的服务器
codex mcp remove <name>       # 移除服务器
```

Codex 在会话启动时自动启动已配置的 MCP 服务器，并将其工具暴露在内置工具旁边。

**支持的传输协议：**
- STDIO（本地进程）
- Streaming HTTP（远程服务器）
- 注意：尚不直接支持 HTTP 端点（与 Claude Code 的完整 MCP 支持相比有差距）

### 15.2 MCP 服务器

Codex 自身也可以作为 MCP 服务器运行：

```bash
codex mcp-server
```

这允许其他 MCP 客户端将 Codex 作为工具使用，实现代理嵌套。例如，可以通过 Agents SDK 编排 Codex。

### 15.3 App 中的 MCP

在 Codex App 中：Settings → MCP servers 查看自定义和推荐的服务器。Codex 可以帮助安装所需的服务器。

---

## 16. 上下文管理与压缩

### 16.1 上下文增长问题

随着对话继续，每个新 turn 包含完整的历史消息和工具调用。由于 Codex 不使用 `previous_response_id`（完全无状态），每次请求都发送完整对话历史。这导致 prompt 随交互增长，产生性能影响。

### 16.2 自动压缩（Compaction）

Codex 在 token 数超过阈值时自动压缩对话：
- 早期版本需要手动通过 `/compact` 命令触发
- 当前版本使用专门的 API 端点自动压缩
- 压缩时保留模型对已发生事情的"理解"摘要（通过加密内容项）
- 压缩后的上下文保留关键信息，释放 token 空间
- **模型级原生压缩**：GPT-5.2-Codex 起模型具备原生 context compaction 能力（自行压缩上下文并越过窗口上限继续工作），GPT-5.5/5.6 延续
- 恢复 ChatGPT 线程时若压缩引用了已退役模型，会用当前所选模型重试恢复（v0.144.0 修复）

> **对标教训（见 §6.5）：** compaction/resume 后重建的 developer message 可能丢失权限/审批配置。也就是说，实现这类压缩时必须保证它不吞掉权限状态、目标（goal）状态等关键控制项——`/goal` 正是把目标做成跨压缩存活的一等对象来规避此类问题。

**手动压缩：**
```
/compact
```

### 16.3 与 Claude Code 上下文管理对比

| 维度 | Codex | Claude Code |
|------|-------|-------------|
| 状态管理 | 完全无状态（每次发送完整历史） | 完全无状态（每次发送完整历史） |
| 自动压缩 | 是（超阈值自动触发） | 是（接近上下文限制时自动触发） |
| 手动压缩 | `/compact` | `/compact [focus]`（支持指定保留重点） |
| 压缩机制 | 专门 API 端点 + 加密内容项 | 模型生成摘要替换历史 |
| Prompt 缓存 | OpenAI 服务端缓存 | Anthropic `cache_control: ephemeral` |

---

## 17. 会话管理与持久化

### 17.1 会话存储

Codex 将会话 transcript 存储在本地 `~/.codex/sessions/` 目录，支持断点续传。

### 17.2 会话恢复

```bash
# 交互式选择
codex resume

# 恢复最近会话
codex resume --last

# 列出所有会话
codex resume --all

# 按 ID 恢复
codex resume <SESSION_ID>

# 非交互模式恢复
codex exec resume --last "Fix the race conditions you found"
codex exec resume <SESSION_ID> "Implement the plan"
```

### 17.3 会话状态查看

在会话中使用 `/status` 查看：
- 线程 ID
- 上下文使用量
- 速率限制信息

### 17.4 Thread 持久化

App Server 的 Thread 原语支持：
- 创建新线程
- 恢复已有线程（客户端可重连不丢失状态）
- 分叉线程（从某个点创建分支）
- 归档线程

---

## 18. Web Search 与联网能力

### 18.1 概述

2026 年 1 月起，Codex 默认启用 Web Search 功能。

### 18.2 搜索模式

| 模式 | 说明 |
|------|------|
| `cached`（默认） | 使用 OpenAI 维护的预索引 Web 结果缓存 |
| `live` | 实时从 Web 获取最新数据（`--yolo` 或 full-access 模式下默认） |
| `disabled` | 禁用 Web 搜索 |

**配置方式：**
```toml
web_search = "cached"   # 或 "live" 或 "disabled"
```

**CLI 参数：**
```bash
codex --search    # 启用搜索
```

### 18.3 与 Claude Code 的对比

| 维度 | Codex | Claude Code |
|------|-------|-------------|
| Web Search | 内置，默认启用 | 内置 `WebSearch` 工具 |
| 搜索缓存 | 支持 cached/live 模式 | 无缓存模式 |
| URL 获取 | 通过 shell 或 MCP | `WebFetch` 工具（HTML→Markdown + AI 处理） |

### 18.4 Browser Use 与 CDP Developer Mode（2026-04 ~ 06 重点）

Browser Use 把 Codex 从纯文本编码助手升级为可做**可视化迭代、后台 QA、跨应用自动化**的平台。核心是在 Codex thread 内嵌入一个共享浏览器视图，用户和 Codex 都能加载网页或本地 dev server，并在渲染页面上留下**可视批注**。

**基础能力（Browser 插件启用后）：** Codex 可操作内嵌浏览器——点击、输入、检查 DOM 状态、截图、验证修复。推荐工作流：命名页面与视觉状态 → 在需要改动的确切区域留批注 → 让 Codex 处理。

**CDP Developer Mode（2026-06-11 起，重大升级）：** 为 Browser Use 引入 **Chrome DevTools Protocol** 支持，用于 Chrome 和 Codex 内嵌浏览器：
- 能力：性能剖析（profiling）、检查网络流量、console 日志、运行时错误、local storage、应用样式、页面状态
- 典型场景：调试变慢的 Web 应用——不只做代码扫描，而是真实剖析交互、检查网络请求，定位真实瓶颈后再修，并用可量化数据佐证改进
- **性能：** 通过 CDP + DOM 快照优化减少浏览器往返，Browser Use 提速最高 **2x**
- **安全门控：** 需在 Codex app 的 Browser 设置里启用 **Developer Mode**，且 Codex 首次对某网站发起检查时须**显式批准 CDP 访问**

> **⚠️ CDP 安全警告（官方）：** CDP 很强大。若暴露你的日常 Chrome 会话，agent 可能能检查或控制标签页、cookies、localStorage、网络流量、console 与页面状态。**用一个一次性的专用 Chrome profile，不要用个人 profile。** 若无需真实 profile 访问，Codex 内嵌浏览器是更安全的默认。

**局限：** 内嵌浏览器面向**未认证页面**，不继承你的登录 cookie / 扩展 / 已保存会话；不适合需登录的复杂交互。社区正推动可分离/外部浏览器支持（issue #20642，代码里已见 `BrowserUseExternal` feature flag 与 `iab`/`chrome`/`cdp` 三种 backend）。

---

## 19. Codex App（桌面应用）

### 19.1 概述

2026 年 2 月 2 日发布的 macOS 桌面应用，定位为"代理命令中心"（Command Center for Agents）。

**核心理念：** 从"单代理对话"演进为"多代理编排"——开发者不再只与一个 AI 对话，而是同时指挥多个代理并行工作。

### 19.2 核心功能

**多项目多线程：**
- 一个窗口管理多个项目
- 每个项目可运行多个代理线程
- 线程间切换不丢失上下文

**Worktree 支持：**
- 创建新线程时选择 Local 或 Worktree
- Worktree 模式创建独立的 Git worktree，变更与主工作区隔离
- 多个代理可同时修改同一仓库的不同文件而不冲突
- 每个代理在独立分支/worktree 中工作

**Automations（自动化）：**
- 调度后台工作流，如安全审计、依赖更新
- 即使用户不在也能运行
- Automations 在专用后台 worktree 中运行

**集成终端：**
- 每个线程包含内置终端，作用域限定在当前项目或 worktree
- `Cmd+J` 切换终端显示

**Skills 支持：**
- 在 App 中直接使用 skills
- 通过 `$` 在 composer 中调用

**Review 功能：**
- 内置 diff 查看器
- 可在 App 中审查代理的变更
- 支持在常规代码编辑器中打开 diff 进行微调

### 19.3 Deeplinks

Codex App 注册了 `codex://` URL scheme，支持通过链接直接打开特定部分。

### 19.4 平台支持

- macOS：已发布（Apple Silicon + Intel），并入 ChatGPT 桌面 App；支持可定制 Dock 图标（明/暗两款）
- Windows：已推进（逐应用访问控制、Computer Use、Remote 控制均已支持 Windows，26.5xx）
- Linux：暂无
- **EEA / 英国 / 瑞士**：Codex app 功能已在这些地区可用（26.6xx）

### 19.5 Sites（建站与托管，2026-06 预览）

**Sites** 在 Codex app 中预览上线。通过 Sites 插件可创建、保存、部署、检查网站、仪表盘、内部工具、Web 应用和游戏，由 OpenAI 托管。侧边栏打开 Sites 管理项目、托管环境变量与密钥。ChatGPT Business 工作区默认含 Sites；Enterprise 管理员可通过 RBAC 为相应角色开启。

### 19.6 Codex Remote（GA，2026-06）

**Codex Remote 已到达正式可用（GA）。** 用 ChatGPT 手机 App 可在连接的 **Mac 或 Windows 主机**上开始或继续工作、查看进度、在手机上批准动作：
- Remote Control 采用**认证的一对一 QR 配对**（每台 iOS/Android 设备与每台主机）
- 需把 ChatGPT 手机 App 与 Codex App 都更新到最新；2026-06-08 后使用过的连接保持配对，更早的失活连接需重新配对
- 新 **DigitalOcean 插件**：让 Codex 开一台 DigitalOcean Droplet、配置 SSH、接入 Codex App 作为远程工作区
- iOS App 新增：Codex 的 Face ID/密码锁、SSH 连接 Windows、Queue/Steer 默认 follow-up 设置、`/side` 侧边对话、Spotlight/Shortcuts 直达

### 19.7 Appshots（macOS，2026-05-21，26.519）

**Appshots** 是把桌面上下文一键喂给 Codex 的方式：在 Mac 上**双击 Command 键**（或配置热键），当前最前台的 app 窗口就被附给 Codex 线程。它同时抓取两份 payload：
- **窗口位图截图**（基于 Apple 的 ScreenCaptureKit，只抓单个窗口而非整屏）
- **可访问性树文本**（窗口内容的结构化文本，含视口外的文件路径、URL、代码/邮件行等"看不见"的内容）

跨 Plus/Pro/Business/Edu/Enterprise 计划在 Mac 上可用（Enterprise 起初稍晚）。这是 OpenAI 在"人显式在环"前提下降低"解释屏幕内容"成本的设计，与 Anthropic Claude computer use、Cursor 的视觉上下文形成对位。

### 19.8 Computer Use while locked（锁屏后继续，2026-05-21）

Computer Use 任务现在满足条件时**可在 Mac 锁屏后继续运行**，扩展了依赖 GUI 的常驻任务范围（此前锁屏会中断）。配合 in-app browser 可视批注、Remote 控制，共同把 Codex 推向"常驻、情境化的环境型编码 agent"。

### 19.9 其它 App 更新（2026 春夏）

- **`/init`** 进入 App composer（与 CLI 同款初始化工作流，生成项目指令）
- 默认终端位置控制（底部/右侧面板）
- Profile 区显示用量统计与 token 活动
- 本地项目/worktree 的线程协调、后台子代理稳定 identicon、按会话内容与 Git 分支名搜索历史线程
- **从 Claude Code 迁移**：App 内"Migrate to Codex"引导流可导入 Claude Code / Claude Cowork 的受支持配置（另见 CLI `/import`，§7.1）
- Plugin 管理改进：纳入工作区插件、安装/移除后更可靠刷新状态、可对已共享插件上传新版本而不改访问权限

---

## 20. Codex Cloud（云端执行）

### 20.1 概述

Codex Cloud 是 Codex 的云端异步执行模式。用户提交任务后，Codex 在 OpenAI 管理的隔离云容器中执行，完成后返回结果供审查。

**核心特点：**
- 每个任务在独立的云沙箱环境中运行
- 环境预加载用户的仓库
- 任务通常需要 1-30 分钟完成
- 返回命令日志、测试结果、diff 供审查
- 支持提出 Pull Request

### 20.2 使用方式

**Web 界面：** chatgpt.com/codex

**CLI 操作：**
```bash
# 提交云任务
codex cloud exec "fix the CI failure"

# 列出最近的云任务
codex cloud list

# 将云任务的 diff 应用到本地
codex apply <TASK_ID>
```

**GitHub 集成：** 在 PR 评论中 `@codex` 触发

### 20.3 与本地执行的对比

| 维度 | Codex Cloud | Codex CLI（本地） |
|------|-------------|-------------------|
| 执行环境 | OpenAI 管理的云容器 | 用户本地机器 |
| 交互方式 | 异步委托，完成后审查 | 实时交互，开发者在环 |
| 网络访问 | 可选启用 | 默认禁用（沙箱控制） |
| 适用场景 | 长时间任务、后台工作 | 快速迭代、实时开发 |
| 代码安全 | 代码上传到 OpenAI 服务器 | 代码留在本地 |

### 20.4 Amazon Bedrock 模型提供商（2026 新增）

Codex 现可使用通过 **Amazon Bedrock** 提供的受支持 OpenAI 模型。将 Amazon Bedrock 配置为模型提供商后，可在本地运行 Codex，同时用 **AWS 托管的认证、账户控制与计费**。这为受合规约束、已在 AWS 生态的团队提供了不走 OpenAI 直连的通路。（4~6 月持续修复 Bedrock runtime endpoint 上报等边缘问题。）

---

## 21. IDE 扩展

### 21.1 支持的 IDE

| IDE | 状态 |
|-----|------|
| VS Code | GA（正式发布） |
| Cursor | GA |
| Windsurf | GA |
| JetBrains | GA（2026 年初） |
| Xcode | GA（Apple 在 Xcode 26.3 中直接集成，2026.2） |

### 21.2 功能

- 在 IDE 内的聊天面板中与 Codex 交互
- 使用打开文件和选中代码作为上下文
- 支持本地模式和云端模式切换
- 会话历史和配置与 CLI/App 共享（通过 App Server 统一）
- 支持 Slash 命令（`/status`、`/review`、`/feedback`、`/local`、`/cloud`）
- 支持 WSL（Windows 用户可在 VS Code 中使用 Linux 沙箱语义）

### 21.3 VS Code 特定配置

```json
{
  "chatgpt.runCodexInWindowsSubsystemForLinux": true
}
```

确保 IDE 扩展在 Windows 上继承 Linux 沙箱语义。

---

## 22. GitHub 集成

### 22.1 PR 代码审查

在 GitHub PR 评论中使用 `@codex review`，Codex 会以标准 GitHub 代码审查的形式回复。

**设置步骤：**
1. 安装 Codex GitHub App
2. 在 PR 评论中 `@codex review`
3. Codex 读取 diff，返回优先级排序的可操作发现

### 22.2 GitHub Actions

OpenAI 发布了官方 Codex GitHub Action，支持在 CI/CD 中运行 Codex：

```yaml
- name: Run Codex
  id: codex
  uses: icoretech/codex-action@v0
  with:
    prompt: "Summarize these changes for operators"
    openai_api_key: ${{ secrets.OPENAI_API_KEY }}

- name: Use result
  run: echo "${{ steps.codex.outputs.result }}"
```

**用途：**
- 自动代码审查
- 应用补丁
- 发布准备
- 迁移任务
- 变更日志更新

### 22.3 Codex Autofix

在 CI 中自动修复问题，作为 CI/CD 管道的一部分运行。

---

## 23. Codex Security（安全扫描）

### 23.1 概述

2026 年 3 月 6 日发布的应用安全代理，前身为内部项目 **Aardvark**。定位为"像安全研究员一样工作"的 AI 安全扫描工具，而非传统静态扫描器。

**可用性：** 研究预览，面向 ChatGPT Pro、Enterprise、Business、Edu 客户，通过 Codex Web 访问，首月免费。

### 23.2 工作流程

**三步流程：**

1. **分析与威胁建模**
   - 分析仓库的安全相关结构
   - 生成可编辑的威胁模型
   - 识别入口点和信任边界

2. **漏洞识别与验证**
   - 基于系统上下文识别漏洞
   - 按真实世界影响分类发现
   - 在沙箱环境中压力测试，确认可利用性
   - 生成概念验证（PoC）exploit

3. **修复提案**
   - 提出与系统行为一致的修复方案
   - 以易于接受的补丁形式呈现
   - 减少回归风险，简化部署

### 23.3 成果数据

**首月扫描结果（研究预览期间）：**
- 扫描超过 120 万次 commits
- 发现 792 个关键（Critical）问题
- 发现 10,561 个高严重性（High）问题
- 关键问题出现在不到 0.1% 的扫描 commits 中

**已发现的知名项目漏洞（含 CVE）：**

| 项目 | CVE 编号 |
|------|----------|
| GnuPG | CVE-2026-24881, CVE-2026-24882 |
| GnuTLS | CVE-2025-32988, CVE-2025-32989, CVE-2025-32990 |
| GOGS | CVE-2025-64175, CVE-2026-25242 |
| Thorium | CVE-2025-35430 ~ CVE-2025-35436（7 个） |
| Chromium | 多个 |
| OpenSSH | 多个 |
| PHP | 多个 |
| libssh | 多个 |

**质量改进：**
- 噪音降低 84%（从初始部署到当前）
- 严重性过度报告率降低 90%+
- 误报率降低 50%+

### 23.4 与传统安全工具的区别

| 维度 | Codex Security | 传统 SAST/DAST |
|------|---------------|----------------|
| 方法论 | 像安全研究员一样推理攻击路径 | 基于规则/模式匹配 |
| 验证 | 在沙箱中复现确认可利用性 | 通常不验证 |
| 误报率 | 低（持续改进） | 通常较高 |
| 修复建议 | 生成可合并的补丁 | 通常只报告问题 |
| 上下文理解 | 深度理解项目结构和业务逻辑 | 有限的上下文理解 |

---

## 24. SDK 与非交互模式

### 24.1 codex exec（非交互模式）

将 Codex 嵌入脚本和自动化管道：

```bash
# 基本用法
codex exec "fix the CI failure"

# 临时模式（不持久化会话）
codex exec --ephemeral "run without persisting"

# 恢复会话继续
codex exec resume --last "Fix the race conditions you found"
```

**与 shell 脚本组合：**
```bash
# 自动更新 changelog
codex exec "update CHANGELOG.md with the latest changes"

# 在 PR 前执行检查
codex exec "check for type errors and fix them"
```

### 24.2 Python SDK

Codex 提供 Python SDK（位于 `openai/codex/sdk`），可将 Codex 嵌入自定义工具和工作流：
- 编程式控制 Codex 会话
- 集成到 CI 管道
- 构建自定义 AI 工作流

### 24.3 App Server API

通过 App Server 的 JSON-RPC 协议，可以构建自定义的 Codex 客户端：

```json
// 启动线程
{
  "method": "thread/start",
  "id": 10,
  "params": {
    "model": "gpt-5.6",
    "cwd": "/Users/me/project",
    "approvalPolicy": "never",
    "sandbox": "workspaceWrite"
  }
}
```

支持的操作：
- `thread/start` — 创建新线程
- `thread/list` — 列出线程
- `thread/loaded/list` — 列出内存中的活跃线程
- Item 流式事件（started → delta → completed）

### 24.4 MCP Server 模式

```bash
codex mcp-server
```

将 Codex 作为 MCP 服务器运行，允许其他代理（如通过 Agents SDK 编排的代理）将 Codex 作为工具调用。

---

## 25. 定价与计划

### 25.1 订阅计划

Codex 包含在 ChatGPT 订阅中，无独立订阅：

| 计划 | 月费 | Codex 特性 |
|------|------|-----------|
| **ChatGPT Free** | $0 | 基础探索 |
| **ChatGPT Go** | $8/月 | 轻量任务 |
| **ChatGPT Plus** | $20/月 | 包含 Codex，GPT-5.5 每 5 小时约 15-80 条本地消息 |
| **ChatGPT Pro 5x** | $100/月 | 每 5 小时约 80-400 条 |
| **ChatGPT Pro 20x** | $200/月 | 每 5 小时约 300-1600 条，优先速度 |
| **ChatGPT Business** | $30/用户/月（标准）或按量 | 团队工作区、SSO、MFA |
| **ChatGPT Enterprise/Edu** | 自定义 | 按 credits 扩展；弹性定价下无固定 rate limit |
| **API Key** | 按量付费 | Token 计费，无云端功能 |

> 说明：不同资料给出的档位口径略有出入（计划改版频繁）。以官方 [Pricing](https://developers.openai.com/codex/pricing) 为准。

### 25.2 用量限制详情（Local Messages / 5h，Plus & Business 同档）

| 模型 | 本地消息 / 5h |
|------|--------------|
| GPT-5.6 Sol | 15-90 |
| GPT-5.6 Terra | 20-110 |
| GPT-5.6 Luna | 50-280 |
| GPT-5.5 | 15-80 |
| GPT-5.4 | 20-100 |
| GPT-5.4 mini | 60-350 |

> 本地消息与云任务共享同一个 5 小时窗口，另可能有每周上限。Enterprise/Edu 弹性定价无固定限制。

### 25.3 Credits 单价（每 1M tokens）

| 模型 | 输入 | 缓存输入 | 输出 |
|------|------|----------|------|
| GPT-5.6 Sol | 125 | 12.5 | 750 |
| GPT-5.6 Terra | 62.5 | 6.25 | 375 |
| GPT-5.6 Luna | 25 | 2.5 | 150 |
| GPT-5.5 | 125 | 12.5 | 750 |
| GPT-5.4 | 62.5 | 6.25 | 375 |
| GPT-5.4 mini | 18.75 | 1.875 | 113 |
| GPT-Image-2（图像） | 200 | 50 | 750 |

> GPT-5.6 单条消息平均消耗约 5-40 credits。Fast 模式对支持的模型按更高速率消耗 credits。
> 上表为 ChatGPT 订阅内的 **credits 单价**（对齐官方 [Pricing](https://learn.chatgpt.com/docs/pricing)），与下方 API Key 的**美元单价是两套独立计量**，不要混用换算。

### 25.3.1 GPT-5.6 API 美元单价（每 1M tokens，API Key 路径）

| 模型 | 输入 | 输出 |
|------|------|------|
| GPT-5.6 Sol | $5.00 | $30.00 |
| GPT-5.6 Terra | $2.50 | $15.00 |
| GPT-5.6 Luna | $1.00 | $6.00 |

> - GPT-5.6 全家族：知识截止 2026-02-16、1M token 上下文、128K 最大输出。
> - **缓存改进（GPT-5.6 起）：** 支持显式 cache breakpoints + 最低 30 分钟缓存寿命；缓存写入按未缓存输入价的 **1.25x** 计费，缓存读取仍享 **90% 折扣**。
> - Sol 与 GPT-5.5 API 价格持平（$5/$30），Terra/Luna 显著更低——GPT-5.5 老用户可把合适负载下沉到 Terra/Luna 省钱。
> - **Cerebras 托管：** 2026-07 起 GPT-5.6 Sol 在 Cerebras 上可达最高 750 tokens/秒（初期限量）。

### 25.4 API Key 计费

使用 API Key 时按标准 API token 计费，不受订阅计划限制，但**依赖 ChatGPT 工作区/云端的功能受限或不可用**（Cloud Tasks / Code Review 等）。**GPT-5.6 GA（7/9）后 Sol/Terra/Luna 已可通过 API Key 直接调用**（API 定价见 §25.5），此前"仅 gpt-5.2/5.3-codex 可 API 化"的限制已解除。

### 25.5 Credits 系统与新特性

- 超出包含用量后可购买额外 credits，按模型/功能不同速率消耗；Speed（Fast）配置增加消耗
- **Rate-limit reset banking**（2026 春夏）：Plus/Pro 用户可累积「限额重置」额度（发布时送 1 次免费重置 + 推荐邀请赚取）；重置额度现显示类型与到期时间，可选择兑换哪一个
- Business 成员可通过推荐计划邀请同事赚取共享工作区额度
- 用量超限错误现内联展示计划/工作区指引与重置时间

---

## 26. 与 Claude Code 对比

### 26.1 总体对比

| 维度 | Codex CLI | Claude Code |
|------|-----------|-------------|
| 开发商 | OpenAI | Anthropic |
| 开源 | 是（Apache 2.0） | 否 |
| 实现语言 | Rust（95%+） | TypeScript（推测） |
| 默认模型 | GPT-5.6 Sol/Terra/Luna（跟随推荐） | Claude 系列（Opus/Sonnet） |
| 最大上下文 | Codex 内 400K（GPT-5.5）/ API 1M | 1M tokens（beta） |
| 最大输出 | - | 128K tokens |
| 配置文件 | AGENTS.md（开放标准） | CLAUDE.md（专有） |
| 配置格式 | TOML（config.toml） | JSON（settings.json） |
| 沙箱 | OS 内核级（Seatbelt/Landlock/seccomp） | 应用层（hooks + bubblewrap） |
| 工具设计 | Shell-Centric（少量工具） | Tool-Centric（20+ 专用工具） |
| 文件编辑 | apply_patch（diff 格式） | Edit（精确字符串替换） |
| 权限模型 | 权限 Profiles（取代 full-auto）+ Auto-Review 事前审查 | 审批模式 + hooks |
| 长时自治 | `/goal` 持续目标（跨 turn/暂停/压缩存活） | 无同类一等对象 |
| 浏览器能力 | Browser Use + CDP Developer Mode（前端调试/剖析） | 无内置（靠 MCP） |
| 云端执行 | 是（Codex Cloud） | 否（纯本地） |
| 建站托管 | 是（Sites 预览） | 否 |
| 远程操控 | 是（Codex Remote GA，手机控 Mac/Windows） | 否 |
| 桌面应用 | 是（并入 ChatGPT 桌面 App） | 是（Desktop App） |
| IDE 集成 | VS Code / Cursor / Windsurf / JetBrains / Xcode | VS Code / JetBrains |
| 安全扫描 | Codex Security | Claude Code Security |
| 语音输入 | 是（iOS 语音 dictation） | 是 |
| Computer Use | 是（原生，含 Windows 桌面应用） | 是 |
| 多代理 | Subagents + App 多线程 + Worktree | Agent Teams（实验性） |
| 模型提供商 | OpenAI 直连 / Amazon Bedrock | Anthropic / Bedrock / Vertex |
| 定价入口 | ChatGPT Plus $20/月 | Claude Pro $20/月 |
| GitHub Stars | 92K+ | 非开源 |

### 26.2 架构差异

| 维度 | Codex | Claude Code |
|------|-------|-------------|
| 核心循环 | ReAct 风格，Responses API | Agentic While-Loop，Messages API |
| 客户端架构 | App Server（JSON-RPC）统一所有界面 | 各界面独立实现 |
| 工具调用 | 主要通过 shell + apply_patch | 20+ 专用工具，每个有独立 schema |
| Prompt 缓存 | OpenAI 服务端自动缓存 | Anthropic `cache_control: ephemeral` 显式标记 |
| 上下文压缩 | 专门 API 端点 + 加密内容项 | 模型生成摘要替换历史 |
| 扩展机制 | Skills + Plugins（含 marketplace/工作区共享）+ MCP + Hooks | Skills + MCP + Hooks |

### 26.3 各自优势场景

**Codex CLI 更适合：**
- 沙箱化的不可信代码审查（内核级沙箱）
- 云端异步任务委托（Codex Cloud）
- 成本敏感的工作流（token 效率更高）
- 需要开源可定制的场景
- CI/CD 自动化（GitHub Actions 集成）
- 多代理并行编排（App + Worktrees）

**Claude Code 更适合：**
- 深度推理和复杂多文件重构
- 可编程的治理和安全策略（17 种 hook 事件）
- 前端/UI 开发（代码质量更高）
- 需要精细权限控制的场景
- 长会话中的上下文保持
- 交互式开发者在环工作流

### 26.4 社区偏好与基准（第三方数据，方向性参考）

**Reddit 社区偏好（较早期）：**
- 原始偏好：65.3% 选择 Codex CLI vs 34.7% Claude Code
- 加权投票：79.9% 偏向 Codex CLI（最强烈意见倾向 Codex）
- Codex 偏好者引用：token 效率、速度、开源灵活性、无限制运行
- Claude Code 偏好者引用：代码质量、深度推理、复杂任务处理、前端输出

**基准（2026 春夏，第三方，非官方复现，仅方向性）：**
- Terminal-Bench：Codex（GPT-5.5）77.3% vs Claude Code 65.4%（Particula 两周对比）；GPT-5.5 在 Terminal-Bench 2.0 达 82.7%、Expert-SWE 73.1%
- SWE-Bench Pro：Claude Opus 4.7 仍更强（64.3% vs GPT-5.5 58.6%）
- Token 效率：Codex 约 4x（第三方口径）
- GPT-5.6 新基准：ALE 53.6、AA Coding Index 80.0，含 Ultra reasoning 模式

> ⚠️ 基准数字随版本快速变化且各家口径不一，模型选择应按**任务类型**而非品牌。选型前以官方与自测为准。


---

## 附录：2026 版本里程碑（4~7 月增补）

| 日期 | 版本 / 事件 | 关键变化 |
|------|------------|---------|
| 2026-04-23 | GPT-5.5 发布 | 成为 Codex 默认；约 40% token 缩减、更强多步 agentic；Codex 内 400K / API 1M 上下文 |
| 2026-04-24 | GPT-5.5 API | Responses & Chat Completions API 开放（model string `gpt-5.5`） |
| 2026-04-30 | **CLI v0.128.0** | 持久化 `/goal`；`codex update`；可配置 TUI keymaps；权限 profiles（内置默认 + `codex sandbox` 选择 + cwd 控制 + active-profile 元数据）；MultiAgentV2；外部 agent 会话导入；**deprecate `--full-auto`**；**移除 `js_repl`** |
| 2026-05-05 | GPT-5.5 Instant | 面向更广用户成为新默认 |
| 2026-05-07 | **CLI v0.129.0** | `/vim` 模态编辑；重设计 workflow picker（易恢复/分叉 + raw 模式）；`/hooks` 浏览器；主题感知状态栏（PR+分支摘要）；插件管理升级（工作区共享/访问控制/来源过滤）；`/goal` resume 后默认保持 paused；Linux 沙箱启动加固；Bubblewrap 升 0.11.2 |
| 2026-05-07 | GPT-5.5-Cyber | 面向受信任网络安全团队限量预览 |
| 2026-05-14 | Hooks GA / Remote iOS | Hooks 正式可用；ChatGPT iOS 远程访问；Codex access tokens for CI（Enterprise 管理员）|
| 2026-05-21 | **26.519（App）** | **`/goal` 从实验性升 GA**（CLI/IDE/App）；**Appshots**（双击 Command 附窗口截图+可访问性文本）；**Computer Use while locked**（锁屏后继续）；插件共享 |
| 2026-05 | 26.527（App） | Computer Use 支持 Windows；Remote 控制支持 Windows；Profile 用量统计 |
| 2026-06 | Browser Use + CDP | Developer Mode 引入 Chrome DevTools Protocol（性能剖析/网络/console/DOM）；Browser Use 提速 2x |
| 2026-06-15 | **CLI v0.140.0** | `/usage`（日/周/累计 token 活动）；`/import`（从 Claude Code 导入 setup/配置/最近对话）；`codex delete` `/delete`（永久删除会话）；`/goal` 保留超长文本/图片附件；扩展 Bedrock + OAuth；**移除实验性 `/realtime` 语音控制** |
| 2026-06 | Sites 预览 / Bedrock / Remote GA | 建站托管；Amazon Bedrock 模型提供商；**Codex Remote GA**（QR 配对手机控主机）+ DigitalOcean 插件 |
| 2026-06-25 | GPT-5.6 预览 | Sol/Terra/Luna 面向受信任伙伴限量预览（API + Codex）|
| 2026-07-07 | **CLI v0.143.0** | 更广的插件 + MCP 支持（远程插件默认开）；macOS/Windows proxy-aware auth；新增 Bedrock 模型；app-server history + thread 工具 |
| 2026-07-09 | **GPT-5.6 GA / CLI v0.144.1** | GPT-5.6 在 **ChatGPT / Codex / OpenAI API 全面 GA**（有公开 API 定价）；ALE 53.6、AA Coding Index 80.0、Ultra reasoning 模式；知识截止 2026-02-16、1M 上下文、128K 输出；改进的 prompt caching（显式 cache breakpoints + 30 分钟最低缓存寿命）；`writes` 审批模式；MCP 工具可交互式请求认证；恢复线程遇退役模型自动重试；Sol 于 Cerebras 达 750 tok/s（限量）|

> ⚠️ Codex 迭代极快（近乎每周），部分中间 patch 版本未列出。以官方 changelog 为准。
> **版本号说明：** Codex 有两条版本线——CLI 用 `rust-vX.Y.Z`（如 v0.144.1），App 用 `26.5xx`（如 26.519），两者不对应，引用时注意区分。

---

## 参考资料

- [OpenAI Codex 官方文档](https://developers.openai.com/codex/)
- [Codex CLI GitHub 仓库](https://github.com/openai/codex)（92K+ Stars）
- [Codex Changelog](https://developers.openai.com/codex/changelog/)
- [Codex Models](https://developers.openai.com/codex/models)（GPT-5.6 Sol/Terra/Luna、弃用表）
- [Codex Pricing](https://developers.openai.com/codex/pricing)（credits 单价、用量限制）
- [Codex Remote connections](https://developers.openai.com/codex/remote-connections)
- [Codex Sites](https://developers.openai.com/codex/sites)
- [Codex Permissions](https://developers.openai.com/codex/permission-modes)
- [Debug web apps with browser use in Codex](https://www.youtube.com/watch?v=bhgYFRZLyKI)（OpenAI 官方，CDP 演示）
- [Codex Changelog April 2026: Goals, Browser Use, GPT-5.5](https://www.developersdigest.tech/blog/codex-changelog-april-2026)
- [Codex /goal 使用与实测](https://www.jdhodges.com/blog/codex-goal-feature-review)
- [Using Goals in Codex](https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex)（OpenAI 官方 Cookbook，goal prompt 写法）
- [Previewing GPT-5.6 Sol](https://openai.com/index/previewing-gpt-5-6-sol) / [GPT-5.6: Frontier intelligence](https://openai.com/index/gpt-5-6)（GPT-5.6 GA、三档定价、缓存改进）
- [Codex Authentication](https://learn.chatgpt.com/docs/auth)（ChatGPT vs API Key，`codex login --with-api-key`）
- [Configure Codex with Amazon Bedrock](https://help.openai.com/en/articles/20001253-configure-codex-with-amazon-bedrock)（`openai.gpt-5.6-sol` 等 Bedrock 模型 ID）
- [Introducing Appshots in Codex](https://www.youtube.com/watch?v=QKYbGCvNpFo)（OpenAI 官方，Command-Command）
- [Codex in June 2026: What Changed](https://www.developersdigest.tech/blog/codex-changelog-june-2026)（/goal GA、计费迁移、5M 周活）
- [Migrate Claude Code to Codex (2026)](https://ofox.ai/blog/migrate-claude-code-to-codex-2026)（`/import` 迁移 12 配置面）
- [Codex Prompting Guide](https://developers.openai.com/cookbook/examples/gpt-5/codex_prompting_guide/)
- [Unlocking the Codex harness: how we built the App Server](https://openai.com/index/unlocking-the-codex-harness/)（OpenAI 官方博客）
- [OpenAI spills technical details about how its AI coding agent works](https://arstechnica.com/ai/2026/01/)（Ars Technica）
- [How OpenAI Codex Works Behind-the-Scenes](https://blog.promptlayer.com/how-openai-codex-works-behind-the-scenes-and-how-it-compares-to-claude-code/)（PromptLayer）
- [Codex CLI: The Definitive Technical Reference](https://blakecrosley.com/guides/codex)（Blake Crosley）
- [Codex CLI vs Claude Code in 2026: Architecture Deep Dive](https://blakecrosley.com/blog/codex-vs-claude-code-2026)
- [OpenAI Codex (AI agent) - Wikipedia](https://en.wikipedia.org/wiki/OpenAI_Codex_(AI_agent))
- [Codex Security: now in research preview](https://openai.com/index/codex-security-now-in-research-preview/)（OpenAI 官方）
- [Codex Pricing](https://developers.openai.com/codex/pricing/)
- [A deep dive on agent sandboxes](https://pierce.dev/notes/a-deep-dive-on-agent-sandboxes)（沙箱实现分析）
- [Sandboxing Architecture - Codex CLI](https://mintlify.com/openai/codex/architecture/sandboxing)（Mintlify 文档）
