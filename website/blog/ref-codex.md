---
title: OpenAI Codex 深入研究（2026-08 快照）
description: 26 章逐节成册，按目录跳章查阅——把 Codex 的产品形态、架构与实现细节交叉核验到版本号级别：96% Rust 重写、App Server 双向协议、三平台内核沙箱（Seatbelt / Landlock+seccomp / restricted tokens）、Shell-Centric 工具设计、11 类 Hook 事件、Auto-review 事前审查、Codex Cloud 与 Security。这是一份手册，不是读完就走的文章。
date: "2026-08-08"
series: 深入研究
audience: engineer
highlight: 26 章逐节可查 · 核验至 CLI v0.147.0 · 截至 2026-08-08 快照
tags: [Codex, OpenAI, 深入研究, 沙箱, Rust, 参考]
outline: [2, 3]
---

# OpenAI Codex 深入研究（2026-08 快照）

::: warning 先说清这份东西是什么
**这是一份逐章查阅的手册，不是一篇文章。** 它按章节组织，供你按目录跳到需要的那一节查，
而不是从头读到尾——所以它没有主线，也没有结论。

- **调研日期**：2026-08-08（在 2026-07-16 版基础上第三次联网校验）
- **被调研版本**：Codex CLI v0.147.0（2026-08-07）及同期 ChatGPT 桌面 App / IDE / Cloud
- **证据形态**：公开信息交叉核验（官方文档 / changelog / 发布说明 / 工程博客 / GitHub API），
  **不是我们自己的实测数据**。章节内的版本号与日期是它的证据，请连带一起读。
- **时效边界**：Codex 发版节奏很快（本快照覆盖的 4–8 月跨了 GPT-5.5 → 5.6 两代模型、
  一次产品合并和一次降价）。**这是 2026-08 的快照，不是最新状态**，
  以[官方文档](https://developers.openai.com/codex/)为准。

一份标清日期的快照不会变成假话，只会变成史料——但前提是你知道它的日期。
:::

::: tip 本次（2026-08-08）修订了什么
上一版是 2026-07-16 快照。三周内发生了三件会改变结论的事，**如果你读的是旧版，这三条都是错的**：

1. **Codex App 不再是独立应用**——2026-07-09 起并入 ChatGPT 桌面 App（Chat / Work / Codex 三视图），
   旧版 ChatGPT 桌面 App 改名 **ChatGPT Classic**。见 §1、§19。
2. **Terra / Luna 降价（2026-07-30）**：Luna 降约 80%（$1.00→$0.20 输入）、Terra 降约 20%，
   Sol 不变。credits 消耗同步下调，用量上限大改。见 §25。
3. **GPT-5.4 / 5.4-mini 将于 2026-08-31 从 Codex（ChatGPT 登录）退役**，API Key 路径不受影响。见 §1。

另有两处旧版**事实性错误**已修正：Hook 事件不是 3 个而是 **11 个**（§13），
`--full-auto` 已从 `codex exec` **彻底移除**而非仅 deprecated（§6、§8）。
:::

---

## 1. 产品概述

OpenAI Codex 是 OpenAI 推出的 AI 编程代理平台，从 2025 年 5 月作为研究预览发布，到 2026 年已演进为一个多界面、多模态的完整编程代理生态系统。

**产品形态（6 个入口）：**

| 入口 | 说明 |
|------|------|
| **Codex CLI** | 开源终端代理，Rust 实现，Apache 2.0 许可，104K+ GitHub Stars |
| **ChatGPT 桌面 App**（含 Codex 视图） | macOS + Windows；**2026-07-09 起 Codex App 并入 ChatGPT 桌面 App**，Codex 作为与 Chat / Work 并列的专用编码视图保留 |
| **Codex Web** | 云端代理，在 chatgpt.com/codex 访问，异步执行任务 |
| **Codex IDE Extension** | VS Code / Cursor / Windsurf / JetBrains / Xcode 扩展 |
| **Remote（手机端）** | ChatGPT 手机 App 远程操控已连接的 Mac / Windows 主机（GA） |
| **GitHub / Slack 集成** | PR 评审（`@codex review`）、GitHub Actions；Slack 内 `@Codex` 起云端任务 |

> **⚠️ 重大产品变化（2026-07-09）：Codex App 并入 ChatGPT 桌面 App。**
> 独立 Codex 桌面应用形态已不存在——它**变成了**新的 ChatGPT 桌面 App（macOS + Windows），
> 内含 Chat / Work / Codex 三个视图；旧版 ChatGPT 桌面 App 改名 **ChatGPT Classic**。
> 老 Codex App 用户照常更新即会得到新 App，项目 / 设置 / 工作流保留，
> 且可把 Codex 设为默认打开视图、在 macOS 上保留 Codex 图标。
> Sam Altman 明确表态 Codex "not going anywhere"。同期新增：diff 内联编辑、
> 侧栏 PR Chat 审查、Computer Use 提速（GPT-5.6）、单项目多仓库。详见 §19。
> **这不是模型合并也不是下线通知，是分发与工作流的合并**——引用旧文档里的"Codex App"时注意换算。

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

**支持模型（截至 2026.8，按当前推荐排序）：**

| 模型 | 说明 |
|------|------|
| **GPT-5.6 Sol** | GPT-5.6 家族旗舰，主打细节与打磨，复杂编码/架构决策首选（`codex -m gpt-5.6-sol`），不确定时官方建议从 Sol 起步；默认 **Power** 档 = Sol + medium reasoning |
| **GPT-5.6 Terra** | 均衡款，日常主力（`codex -m gpt-5.6-terra`）；**7/30 降价 20% 后性价比进一步走强** |
| **GPT-5.6 Luna** | 最快最省，重复性/可预测工作与高并发首选（`codex -m gpt-5.6-luna`）；**7/30 降价约 80%，是本轮最大变动** |
| **GPT-5.5** | 上一代旗舰（4/23 发布），复杂编码、Computer Use、知识工作、研究流程；仍可用 |
| **GPT-5.4** | ⚠️ **2026-08-31 从 Codex（ChatGPT 登录）退役**，官方建议换 `gpt-5.6-terra` |
| **GPT-5.4 mini** | ⚠️ **2026-08-31 同批退役**，官方建议换 `gpt-5.6-luna` |
| **GPT-5.3-Codex-Spark** | 超快速变体（ChatGPT Pro 专属），研究预览，独立用量池；跑在专用低延迟硬件上 |
| ~~GPT-5.3-Codex / GPT-5.2~~ | **已弃用**为 ChatGPT 登录用户的可选模型（API Key 工作流不受影响，仍可调用） |

> **⚠️ 退役倒计时（2026-08-31）：`gpt-5.4` 与 `gpt-5.4-mini` 将从 ChatGPT 登录的 Codex 下线。**
> 替换映射：`gpt-5.4` → `gpt-5.6-terra`，`gpt-5.4-mini` → `gpt-5.6-luna`。
> **要在截止前逐一改掉的地方比想象的多**：工作区默认模型、保存的模型设置、
> 企业 managed configuration、自定义 agent 定义、定时任务（scheduled tasks），
> 以及脚本里的 `codex exec --model`。
> **OpenAI API 与用自己 API Key 认证的 Codex 会话不受影响**——这是两条独立的可用性轨道，
> 别把 API 那边还能调当成"Codex 里也还能用"。
>
> 顺带一条容易踩的弃用：**Chat Completions API 支持已标记 deprecated**，未来版本会移除，
> 自建 provider 接 Codex 的应走 Responses API。

> **模型命名与认证：** GPT-5.6 家族含三档（Sol/Terra/Luna，"数字标识代际、Sol/Terra/Luna 是可各自独立演进的持久能力档"——官方原话）。ChatGPT 登录会话（Plus/Pro/Business）建议**不显式指定模型名**，让 Codex 自动跟随推荐默认（省得手动追升级）。**认证更正：GPT-5.6 自 7/9 GA 起在 ChatGPT / Codex / OpenAI API 三处均可用**，`gpt-5.6-sol/terra/luna` 都有公开 API 定价，可用 API Key 直接调用（`printenv OPENAI_API_KEY | codex login --with-api-key`）。此前版本"GPT-5.5/5.6 仅 ChatGPT 登录、不支持 API Key"的说法已随 GA 过时。但 API Key 认证仍**无法使用依赖 ChatGPT 工作区/云端的功能**（Cloud Tasks / Code Review 等），二者按 plan 有差异。

**上下文窗口：**
- GPT-5.6 全家族：**1M+ token 上下文、128K 最大输出、知识截止 2026-02-16**（三档同规格）
- GPT-5.5：Codex 内 400K tokens，API 内最高 1M tokens
- GPT-5.4：最高 1M tokens

**发布时间线（2026）：**
- GPT-5.5：2026-04-23 发布并一度成为 Codex 默认（约 40% token 缩减、同延时下更强多步 agentic）；API 于 4/24 开放
- GPT-5.5-Cyber：2026-05-07 面向受信任网络安全团队的限量预览变体
- GPT-5.6 Sol/Terra/Luna：2026-06-25 面向受信任伙伴限量预览（API + Codex）；**2026-07-09 起在 ChatGPT / Codex / OpenAI API 全面 GA**（24 小时内全球逐步铺开），同日 Codex App 并入 ChatGPT 桌面 App、ChatGPT Work 发布
- **2026-07-30 降价**：Luna 约 −80%、Terra 约 −20%，Sol 不变（详见 §25）
- **2026-08-31**：GPT-5.4 / 5.4-mini 从 ChatGPT 登录的 Codex 退役

**关键数据（截至 2026-08-08，GitHub API 实查）：**
- GitHub Stars：**104,655**（4 月约 75.6K → 7 月约 92K → 8 月 104K，仍在陡增）
- Contributors：**470+**
- Forks：**15,830**
- Open Issues：**11,891**（活跃迭代，官方 README 仍标注为「实验性、可能含 bug」）
- 最新稳定版本线：**CLI rust-v0.147.0**（2026-08-07）；alpha 线已到 v0.148.0-alpha.2
- 代码库语言：**Rust 95.96%**（Python 3.14%、Starlark 0.20%、TypeScript 0.19%）
- 每周活跃用户：4 月约 300 万 → 6 月约 500 万 → **7 月约 700 万**（官方口径）；
  Codex + ChatGPT Work 合计据 Bloomberg 报道约 **1000 万**（7 月下旬，两产品合并计数，勿单独当作 Codex 数字）
- 计费口径：2026-04 起从"按消息数"迁移为"按 token 计的 credits"（5 小时窗口 + 每周窗口双限）

> **口径提醒：** "Codex 用户数"在 7 月后有两套说法——单算 Codex 约 700 万周活，
> 与 ChatGPT Work 合并算约 1000 万。产品合并（§19）之后合并口径会持续被引用，
> 引数字时务必带上是哪一套，否则会把 Work 的非技术用户增长记到 Codex 头上。

**认证方式：**
- ChatGPT OAuth（推荐，使用订阅计划额度；可访问 Cloud Tasks / Code Review 等工作区/云端功能）
- OpenAI API Key（按标准 API token 计费；**GPT-5.6 GA 后 Sol/Terra/Luna 均可 API 化调用**，但依赖 ChatGPT 工作区/云端的功能受限或不可用；Fast 模式的 credit 倍率不适用，改用 API Priority 计费）
- **Amazon Bedrock（2026-07 起 GPT-5.6 三档在 Bedrock GA）**：内置 `amazon-bedrock` provider，
  可用 Bedrock API Key 或 AWS SDK 凭据链；覆盖桌面 App 的 Work/Codex、Codex CLI、IDE 扩展与 Codex SDK。
  v0.145.0 起支持 Bedrock 登录与自定义端点，且 **Bedrock 上默认模型为 GPT-5.6 Sol**；
  v0.147.0 补齐 Bedrock 的 cached web search 与远程压缩
- **Sign in with ChatGPT（beta，2026-07）**：面向插件与合作站点的登录方式，
  首批含 Airtable / GitLab / HubSpot / Notion / Supabase / Vercel；
  合作方只拿到姓名、邮箱、头像，插件权限仍需逐项单独批准

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

Codex CLI 最初用 TypeScript（Node.js）实现，2025 年中开始 Rust 重写（`codex-rs`），到 2026 年 2 月 Rust 实现已成为默认维护版本。**2026-08-08 实查 GitHub 语言统计：Rust 95.96%、Python 3.14%、Starlark 0.20%、TypeScript 0.19%**（Starlark 来自 Bazel 构建，Python 来自 SDK 与工具链）。

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
| `web_search` | 网页搜索（v0.146.0 起兼容的自定义 provider 也可独立使用） |
| Browser Use（CDP） | 内置浏览器 + Chrome DevTools Protocol，前端调试/性能分析（详见 §18.4，需 Developer Mode + 逐次批准 CDP 访问） |
| Computer Use | 看/点/输操作桌面应用（macOS + Windows），锁屏后可继续 |
| Code Mode（实验） | 在嵌入式 V8（rusty_v8 150.4.0）里跑 JS 编排工具调用；有独立 code-mode host 进程，不可用时回落到内嵌运行时。v0.146.0 起 app-server 可通过 WebSocket 连远程 Code Mode host |
| 音频输入/输出（v0.145.0） | 支持常见本地音频格式作为输入与工具输出，并引入 streaming realtime V3 会话 |

> **注意：`js_repl` 已在 v0.128.0 移除**，早期文档/博客提到的它不再存在，勿再引用。
> **`/realtime` 实验性语音控制已在 v0.140.0 移除**，但语音能力换了形态回来——见下条。
>
> **工具输出封顶：** OpenAI 公开说明其 agentic 系统**默认把单次工具输出截到 10,000 tokens**，
> 并刻意保住 prompt 前缀以复用缓存计算。这条对做 harness 的人比对用户更重要：
> 它是"限制无谓上下文增长"的具体手段，而非模型能力上限。
>
> **MCP 工具默认走 tool search（v0.143.0）**：不再一次性把所有 MCP 工具 schema 灌进上下文，
> 改为按需检索。v0.147.0 进一步支持 **MCP 2026-07-28 协议**（分页发现、多轮请求、
> 非阻塞服务器启动），并把 MCP SDK 升到 3.0.0。

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

> **⚠️ 更新（v0.147.0，2026-08-07）：`codex exec --full-auto` 已被彻底移除，不再只是 deprecated。**
> 官方给出的替换是 `--sandbox workspace-write`。
> 时间线：v0.128.0（2026-04-30）标记 deprecated → **v0.147.0 从 `codex exec` 删除**。
> 脚本 / CI 里还写着 `codex exec --full-auto` 的会直接报错而不是给警告，升级前先 grep 一遍。
> OpenAI 的方向是**显式权限 Profiles**（组合 `--profile` + `--sandbox`，或选内置 profile），
> 不再提供笼统的 full-auto 开关。

**三个正交轴（理解权限的关键）：** 自动批准行为不是单一开关，实际由三个维度共同决定：
- `approval_policy`：agent 多频繁请求审批
- `sandbox_mode`：文件/命令访问能走多远（read-only / workspace-write / danger-full-access）
- `network_access`：是否允许出站网络（workspace-write 下**默认关闭**，需显式开启）

常见误区是只看 `approval_policy`，忽略 `sandbox_mode` 同样关键。

**桌面 App / IDE 审批模式（2026-08 当前形态，官方措辞已改）：**

| 模式 | 官方名称 | 说明 | 适用场景 |
|------|---------|------|----------|
| **Ask for approval** | 默认，且**始终可用** | 沙箱内工作，越过工作区边界前暂停问人 | 默认起点、敏感项目 |
| **Approve for me** | 设置里叫 **Auto-review** | 边界不变，但越界请求交给**自动审查**判断（见 §6.5） | 长跑 agentic 工作 |
| **Full Access** | Full access | 直接改本地文件、放开网络，接近 Claude Code 的 bypass 模式 | 隔离环境/一次性容器 |

> **两个容易搞错的点：**
> 1. **后两个模式默认不在菜单里**，需先去 ChatGPT 桌面 App 的 **Settings → General → Permissions** 逐个打开；
>    打开只是让它出现在菜单，不会切换当前会话。企业 requirements 禁用的模式会显示为灰。
> 2. **换审查者 ≠ 扩大沙箱。** 官方明确写了：`Approve for me` 与 `Ask for approval`
>    的工作区边界完全相同，区别只是越界请求由谁裁决。把它当成"更宽的沙箱"是理解错误。

沙箱与审批是**两个独立控制轴**：沙箱决定能碰哪些文件与网络资源，审批决定何时暂停/送审。

v0.144.0 起还有 `writes` 审批模式：声明为只读的动作放行，写入动作则提示。
Hook 侧可见的 `permission_mode` 取值为 `default` / `acceptEdits` / `plan` / `dontAsk` / `bypassPermissions`。

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
v0.147.0 起 `codex sandbox` 还能加载云端托管的 profile。

> **⚠️ Profiles 与旧沙箱设置不可混用（官方明确警告）：** 权限 profiles 目前是 **Beta**，
> 且**不与旧的 sandbox 设置组合**。只能二选一：要么用 `default_permissions` + `[permissions]`，
> 要么用 `sandbox_mode` / `sandbox_workspace_write`。
> **只要任一已加载的配置文件里出现 `sandbox_mode`、或你传了 `--sandbox`、
> 或选中的 config profile 设了 `sandbox_mode`，Codex 就会用旧沙箱设置而忽略 `default_permissions`。**
> 这是个静默的优先级覆盖——配了新 profile 却发现不生效时，先去 grep 有没有残留的 `sandbox_mode`。

### 6.1.2 Rules 系统（命令级 allow/prompt/forbidden，实验性）

Rules 控制**哪些命令可以在沙箱外运行**，是比 sandbox 模式更细的一层。写在活动 config 层旁的
`rules/` 目录下（如 `~/.codex/rules/default.rules`），用 Starlark 风格的 `prefix_rule()` 声明：

```python
prefix_rule(
    pattern = ["gh", "pr", "view"],   # 命令前缀；元素可为字面量或字面量并集
    decision = "prompt",              # allow | prompt | forbidden，默认 allow
)
```

**字段语义：**

| 字段 | 说明 |
|------|------|
| `pattern`（必填） | 非空列表，定义要匹配的命令前缀。每个元素是字面量（`"pr"`）或并集（`["view", "list"]`，匹配该位置的多个候选） |
| `decision`（默认 `allow`） | `allow` = 沙箱外直接跑不提示；`prompt` = 每次匹配都问；`forbidden` = 直接拦掉不提示 |

**冲突解决：最严格者胜（`forbidden` > `prompt` > `allow`）。** 这与 Claude Code 的 deny 优先同构。

**加载与信任：** 启动时扫描每个活动 config 层下的 `rules/`（含 Team Config 位置与 `~/.codex/rules/`）；
**项目级 `<repo>/.codex/rules/` 只在该项目 `.codex/` 层被信任时才加载**——这是防仓库投毒的关键门。
在 TUI 里把某命令加进 allow list 时，Codex 写的是用户层 `~/.codex/rules/default.rules`。
开启 Smart approvals（默认）后，Codex 会在提权请求时**主动提议一条 `prefix_rule`**——
官方叮嘱要仔细看清建议的前缀再接受（一条过宽的前缀等于永久开门）。

**企业侧强制（`requirements.toml` 的 `[rules]` 表）：** 与普通 `.rules` 合并，最严格者仍然胜出。
与 `.rules` 不同的是，requirements 规则**必须显式写 `decision`，且只能是 `prompt` 或 `forbidden`，不能是 `allow`**——
管理员只能收紧、不能放宽，这个不对称是刻意的：

```toml
[rules]
prefix_rules = [
  { pattern = [{ token = "rm" }], decision = "forbidden", justification = "Use git clean -fd instead." },
  { pattern = [{ token = "git" }, { any_of = ["push", "commit"] }], decision = "prompt", justification = "Require review before mutating history." },
]
```

`justification` 会在审批提示或拒绝消息里展示给用户——**拦一条命令的同时告诉人该用什么替代**，
比单纯 deny 体验好得多，这个细节值得抄。

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

**触发边界（2026-08 官方文档已明确列出）：** Auto-review **只评估本来会暂停等人的请求**——

- 申请提权的 shell / exec 调用
- 被当前沙箱或策略拦下的网络请求
- 写到 writable roots 之外的文件编辑
- 依 tool annotation 或配置需审批的 MCP / app 工具调用
- Computer Use 首次访问某个新网站/域名

**沙箱内已经允许的常规动作不触发审查**，主 agent 直接继续。这条边界很重要：
它意味着 auto-review 的成本不与总工具调用数成正比，而只与越界次数成正比。

**审查策略可替换（这是新增的重要能力）：** 默认 reviewer policy 就放在开源仓库的
`core/src/guardian/policy.md`（内部代号 Guardian）。定制路径有两级：

```toml
# 个人：~/.codex/config.toml
[auto_review]
policy = """
YOUR POLICY GOES HERE
"""
```

企业则用 managed requirements 里的 `guardian_policy_config` 替换其 tenant 专属段落，
**且托管要求优先于个人配置**。官方建议：定制时先整段拷贝默认策略再按自身风险画像迭代，
不要从零写——默认策略本身承载了大量已调过的边界判断。

审查会话 transcript 默认留在 `~/.codex/sessions`，可以让 Codex 先分析历史流量再改策略/权限。

**官方自陈的三条局限（原文措辞，值得照抄进任何对标文档）：** auto-review 改善的是
长时 agentic 工作的默认操作点，**不是确定性的安全保证**——① 它只评估请求越界的动作；
② 它仍会出错，尤其在对抗性或异常语境下；③ 它应当补充而非替代好的沙箱设计、监控与组织策略。

> **已知问题（社区）：** 桌面版在 context compaction / resume 后，重新生成的权限 developer message 有时会丢失 `approvals_reviewer = auto_review`，导致原本 auto-review 的线程退回手动审批（issue #23875）。根因在 context rebuild/resume 路径，非用户配置文件。这里的通用教训是：恢复会话时必须完整保留权限/审批状态，否则安全配置会在 resume 后静默降级。
>
> **v0.144.2 / v0.146.1 的两次回调也值得记一笔：** v0.144.2 因 prompting 回归而
> **回滚**了 Guardian 的 auto-review 策略、请求格式与工具行为；v0.146.1 又为
> cyber-capable 模型收紧了自动审查默认值。审查代理本身是会被反复调参的活动部件，
> 把它当成稳定契约来依赖不合适。

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
| `/new` | 开新对话 | **v0.146.0 起可直接命名新会话**（`/new` 或 `/clear` 时命名），并可 pin 重要线程 |
| `/resume` | 恢复历史对话 | v0.129.0 重设计的 workflow picker；**v0.145.0 起支持分页线程历史**（高效 resume、搜索、持久化名称、子代理与 memories） |
| `/fork` | 把当前对话分叉为新线程 | 探索多解路径；**v0.146.0 起支持带分页历史分叉，含不出现在线程列表里的临时分叉** |
| `/side` | 问一个不进主对话的旁支问题 | |
| `/rename` `/title` | 重命名会话 / 编辑标题 | `/title` 可在 turn 进行中编辑 |
| `/rollout` `/raw` | 查看 rollout / 原始 scrollback 模式 | |
| `/import` | 从 **Claude Code 与 Cursor** 导入 setup、MCP 服务器、插件、会话、命令、项目级 memories | v0.140.0 新增；**v0.145.0 扩到 Cursor**；v0.147.0 支持导入 Cursor skills，并能同步已导入的 Claude/Cursor 对话变更而不产生重复 |
| `/worktree` | 在新的 Git worktree 里跑当前 chat | |
| `/reasoning` | 为当前 chat 选择 reasoning effort | |
| `/approve` | 批准当前请求 | |
| `/task` | 起一个不属于任何项目的 chat | |
| `/pet` | 唤起/收起桌面宠物 | 是的，官方文档有 `/codex/pets` 这一页 |
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

> **成熟度标签有官方定义（2026-08 新增的 Feature Maturity 页）**，四级各带明确使用建议——
> 引用某个 Codex 特性时最好连标签一起引，否则容易把"Experimental"当成可依赖的契约：
>
> | 标签 | 含义 | 官方建议 |
> |------|------|---------|
> | Under development | 尚未可用 | **不要用** |
> | Experimental | 不稳定，OpenAI 可能移除或更改 | 自担风险 |
> | Beta | 可广泛测试，多数方面已完整，部分细节可能依反馈变动 | 可用于评估与试点，预期有小变动 |
> | Stable | 完整支持、有文档、可广泛使用，行为与配置长期一致 | **可用于生产**；移除通常走弃用流程 |
>
> 按这套标准，当前**权限 Profiles 是 Beta**（§6.1.1）、**Rules 是 Experimental**（§6.1.2）、
> **Chronicle 是研究预览**（§19.11）——这三项都不该当成稳定接口来依赖。

| 子命令 | 成熟度 | 说明 |
|--------|--------|------|
| `codex` | Stable | 启动交互式 TUI |
| `codex app` | Stable | 启动桌面应用（**2026-07-09 后即 ChatGPT 桌面 App**，macOS + Windows）|
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
| ~~`--full-auto`~~ | **已移除**：v0.128.0 deprecated → **v0.147.0 从 `codex exec` 删除**。改用 `--sandbox workspace-write`，或显式 `--profile` + `--sandbox` |
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
| `--approve-for-me` | **v0.147.0 新增**：启用自动审查的审批（对应 §6.5 的 Approve for me / Auto-review） |
| `--dangerously-bypass-hook-trust` | 跳过 hook 持久化信任要求（仅当次，见 §13.1） |
| ~~`--yolo`~~ | 原为 `--full-auto` 的别名；`--full-auto` 已在 v0.147.0 从 `codex exec` 移除，勿再依赖 |

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

Codex 的 Hooks 系统允许在特定事件发生时执行自定义命令。**Hooks 已于 2026-05-14 GA**，
不再需要 feature flag（旧版需 `[features] codex_hooks = true`，那是历史做法）。

**配置位置（两种形态，四个常用层）：** Codex 在每个活动 config 层旁发现 hooks，
既支持独立 `hooks.json`，也支持 `config.toml` 内联的 `[hooks]` 表：

- `~/.codex/hooks.json`（用户级）
- `<repo>/.codex/hooks.json`（项目级）
- 插件打包携带（plugin manifest 或插件内默认的 `hooks/hooks.json`）
- 企业托管层（system / MDM / cloud / `requirements.toml`）

**信任模型（安全相关，别忽略）：** 有 hook 需要在启动时确认时，Codex 会打印警告让你打开 `/hooks`。
**来自 system / MDM / cloud / `requirements.toml` 的托管 hook 标记为 managed、由策略信任，
用户无法在 hook 浏览器里关掉。** 一次性自动化若已在 Codex 之外验过来源，
可传 `--dangerously-bypass-hook-trust` 跳过持久化信任要求（仅当次生效）。

企业侧还有一个开关值得记：`allow_managed_hooks_only = true` 会跳过 user / project / session / plugin
四类来源的 hook，只保留 `requirements.toml` 等托管层。注意**托管 hook 的脚本本体不由 Codex 分发**，
需自行用 MDM 投递到 `managed_dir`，且命令应引用该目录下的绝对路径。

### 13.2 Hook 事件类型（11 个，2026-08 官方文档）

> **⚠️ 旧版本文（2026-07 快照）此处写"只有 3 个事件"，是错的。** 实际有 11 个，
> 按生命周期分三组。这个错误会直接误导"Codex hooks 远不如 Claude Code"的对标结论——
> 事件数量上两者已在同一量级，真正的差距在别处（见 §13.4）。

**按触发时机分组：**

| 时机 | 事件 |
|------|------|
| **turn 进行中** | `PreToolUse`、`PermissionRequest`、`PostToolUse`、`PreCompact`、`PostCompact`、`UserPromptSubmit`、`SubagentStop`、`Stop` |
| **会话/子代理启动** | `SessionStart`、`SubagentStart` |
| **主线程结束** | `SessionEnd`（**子代理不触发**） |

**每个事件的 `matcher` 过滤对象（这张表最实用——matcher 匹配的不都是工具名）：**

| 事件 | `matcher` 过滤什么 | 取值 / 备注 |
|------|------------------|------------|
| `PreToolUse` | 工具名 | 见下方"工具覆盖"警告 |
| `PermissionRequest` | 工具名 | 支持 `Bash`、`apply_patch` 及 MCP 工具名 |
| `PostToolUse` | 工具名 | 同上 |
| `PreCompact` | 压缩触发方式 | `manual` \| `auto` |
| `PostCompact` | 压缩触发方式 | `manual` \| `auto` |
| `SessionStart` | 启动来源 | `startup` \| `resume` \| `clear` \| `compact` |
| `SessionEnd` | 结束原因 | 目前只有 `other` |
| `SubagentStart` | 子代理类型 | 取决于启动的子代理 |
| `SubagentStop` | 子代理类型 | 取决于停止的子代理 |
| `UserPromptSubmit` | **不支持** | 配了 `matcher` 会被忽略 |
| `Stop` | — | turn 结束 |

**公共输入字段：** `session_id`、`transcript_path`、`cwd`、`hook_event_name`；
其中 `SessionStart`、`PreToolUse`、`PermissionRequest`、`PostToolUse`、`UserPromptSubmit`、
`SubagentStart`、`SubagentStop`、`Stop` 还带 `permission_mode`
（`default` / `acceptEdits` / `plan` / `dontAsk` / `bypassPermissions`）。
`SubagentStart` / `SubagentStop` 额外带 `turn_id`、`agent_id`、`agent_type`。

> **`transcript_path` 不是稳定接口**——官方明说它只为方便而提供，格式随时可能变；
> 需要完整 wire format 的走 Schemas。把 transcript 解析写进生产 hook 是自找的破坏性变更。

> **⚠️ 覆盖面缺口（这是真正的短板，比事件数量重要）：** `PreToolUse` 能拦
> 受支持的 Bash 调用、经 `apply_patch` 的文件编辑和 MCP 工具调用，
> 但官方文档警告它**不拦所有 shell 路径，也不拦 WebSearch 等非 shell / 非 MCP 工具调用**。
> 所以 hooks 是**审查与引导层，不是沙箱的替代品**——需要强制边界时仍要靠 §5 的内核沙箱。

**输出字段：** `SessionStart`、`PreCompact`、`PostCompact`、`UserPromptSubmit`、`SubagentStop`、`Stop`
支持共享的 JSON 输出字段；`SubagentStart` 接受相同形状的 `systemMessage` 与 hook 专属 context，
但 `continue: false` 对它无效。`SessionEnd` hook 是**建议性的**——输出不会引导 Codex，
也不能让线程继续存活；命令超时或非零退出会被报为 hook 失败。

### 13.3 配置示例

三级结构：**hook 事件 → matcher 组 → handlers 数组**。

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

> **⚠️ 本节已在 2026-08-08 重写。** 旧版结论是"Codex hooks 事件少、需 feature flag、远不如 CC"，
> 这个判断在 2026-08 已不成立：hooks 早在 2026-05-14 GA，事件数是 11 个而非 3 个。

| 维度 | Codex Hooks | Claude Code Hooks |
|------|-------------|-------------------|
| 成熟度 | **GA（2026-05-14）**，`/hooks` 可在 TUI 内浏览开关 | 成熟 |
| 事件数量 | **11 个**（见 §13.2） | 更多（含 PostToolUseFailure / PostToolBatch / TaskCreated / WorktreeCreate / MessageDisplay / Elicitation 等更细粒度事件） |
| 配置形态 | `hooks.json` **或** `config.toml` 内联 `[hooks]`，且插件可打包携带 | `settings.json` |
| 配置结构 | 三级：事件 → matcher 组 → handlers 数组 | 事件 → matcher → hooks 数组 |
| 工具覆盖 | **有缺口**：不拦所有 shell 路径与 WebSearch 等非 shell/非 MCP 调用 | 覆盖更完整 |
| 企业托管 | **强**：MDM / `requirements.toml` 下发且用户不可关，`allow_managed_hooks_only` 可屏蔽本地来源 | 有 managed settings，但 hook 层的强制粒度较弱 |
| 可编程性 | 任意命令 | 任意命令 + URL hook |

**这轮对标下来，真实差距不在事件数量，而在两处：**

1. **Codex 弱在工具覆盖面**——`PreToolUse` 拦不住全部执行路径，所以它构不成强制边界，
   必须与内核沙箱（§5）配合。Claude Code 的 hook 层拦截面更完整，可以承担更多治理职责。
2. **Codex 强在企业托管**——托管 hook 用户关不掉、`allow_managed_hooks_only` 能一刀屏蔽本地来源、
   `requirements.toml` 的规则只能收紧不能放宽（§6.1.2）。这套"管理员单向收紧"的不对称设计，
   是 Codex 在企业 policy 层明显领先的地方。

---

## 14. 子代理系统（Subagents）

### 14.1 概述

Codex 支持子代理工作流，用于并行化大型任务。每个子代理有独立的模型和工具调用，因此消耗更多 tokens。

**关键特性：**
- **默认启用**（`agents.enabled` 默认 `true`）；ChatGPT Work 也对符合条件的账号暴露子代理工作流与活动
- 适合高度可并行的任务：代码库探索、按多步计划实施功能
- 子代理继承父级的沙箱策略
- 父级 turn 的运行时覆盖（如 `/approvals` 更改、`--yolo`）会传递给子代理
- 在交互式 CLI 中，非活跃代理线程的审批请求也会弹出
- **MultiAgentV2**（v0.128.0）：多代理配置更新；`/subagents` 命令管理，App 内后台子代理有稳定 identicon
- 选择 Ultra reasoning 时，若多代理并发过高会警告可能快速增加用量（v0.144.0）

### 14.2 配置（2026-08 官方 schema）

> **⚠️ 状态更新：当前 Codex 版本默认启用子代理工作流**（`agents.enabled` 默认 `true`），
> 不再是"仅在用户明确要求时"或需 `/experimental` 开启。旧版此处只有一个空的 `[agents]` 占位，
> 现补上完整字段表。

**全局设置（`config.toml` 的 `[agents]`）：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `agents.enabled` | boolean | 启用/禁用多代理工具，**默认 `true`**；设 `false` 关闭 |
| `agents.max_concurrent_threads_per_session` | number | 封顶并发的 spawned-agent 线程数（**不含主线程**）；不设则由 Codex 选默认。旧名 `agents.max_threads` 仍作为兼容别名 |
| `agents.default_subagent_model` | string | spawned agent 的默认模型 |
| `agents.default_subagent_reasoning_effort` | string | spawned agent 的默认 reasoning effort |
| `agents.interrupt_message` | boolean | agent turn 被打断时记录一条**模型可见**的消息，默认 `true` |

**优先级链（三层回退，容易搞错）：** 显式 spawn 参数 → `[agents]` 默认 → 父级取值。
若 spawn 选了不同模型且既无显式 effort 也无配置 effort，**用该模型自己的默认 effort**。
其它会话设置（`sandbox_mode`、`mcp_servers`、`skills.config` 等）在自定义 agent 文件省略时**从父级继承**。

**自定义 agent：** 本地 Codex 客户端可为不同任务定义带不同模型配置与指令的自定义 agent。
v0.145.0 起 MultiAgentV2 稳定化：可配子代理模型、reasoning 级别、并发度、恢复角色，agent 导航也改进了。
v0.147.0 起可为 v2 子代理配置 developer instructions。

> **`agents.interrupt_message` 默认为 true 这条值得单独注意**——被打断时留一条模型可见的记录，
> 正是防止"打断后模型不知道自己被打断过、继续假设任务已完成"的那类失真。
> 这与本站长期强调的"harness 侧发生的事必须对模型可见"是同一条原则。

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
- 注意：尚不直接支持裸 HTTP 端点（与 Claude Code 的完整 MCP 支持相比有差距）

**2026-08 的三项 MCP 演进（旧版未覆盖）：**

| 变化 | 版本 | 说明 |
|------|------|------|
| **默认走 tool search** | v0.143.0 | 不再一次性把全部 MCP 工具 schema 灌进上下文，改为按需检索；ChatGPT 托管的 MCP server 可显式使用会话认证 |
| **交互式认证转正** | v0.144.0 | MCP 工具可交互式请求认证，**不再需要实验性 opt-in** |
| **MCP 2026-07-28 协议（opt-in）** | v0.147.0 | 分页发现、多轮请求、**非阻塞服务器启动**；MCP SDK 升至 3.0.0 |

配套的健壮性修复也集中在这块：启动超时封顶、避免阻塞式 OAuth discovery、
串行化刷新、安全复用工具目录（v0.145.0）；认证或配置变化时保持连接与工具最新、
**只重连已关闭的 server 而不打断健康连接**（v0.146.0）；启动前即暴露已缓存的 MCP 工具、
不让可选 MCP 启动阻塞 turn（v0.147.0）。

> **"非阻塞启动 + 先用缓存工具"这个组合值得单独记。** 它解决的是一个很常见的体验问题：
> 一个慢的 MCP server 会把整个首轮拖住。做法是把"发现"与"可用"解耦——
> 缓存的工具先给模型，慢 server 后到。这与本站在 harness 侧强调的
> "别让可选依赖进入关键路径"是同一条工程判断。

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

## 19. Codex 桌面 App（2026-07 起并入 ChatGPT 桌面 App）

### 19.1 概述与形态变更

Codex 桌面应用于 2026-02-02 首发（macOS），定位"代理命令中心"（Command Center for Agents）。
**2026-07-09 起它并入 ChatGPT 桌面 App**——原 Codex App **变成**了新的 ChatGPT 桌面 App，
Codex 作为与 Chat / Work 并列的专用编码视图保留。

**核心理念：** 从"单代理对话"演进为"多代理编排"——开发者不再只与一个 AI 对话，而是同时指挥多个代理并行工作。

::: warning 合并的准确边界（很容易描述错）
| 问题 | 事实 |
|------|------|
| Codex 和 ChatGPT 合并了吗？ | **桌面 App 层面是的**；Codex 仍是独立的编码视图 |
| Codex 要下线吗？ | **不**。Sam Altman 称其为新 work 产品的核心 |
| 老 Codex App 用户怎么办？ | 照常更新，它就变成新的 ChatGPT 桌面 App，项目/设置/工作流保留 |
| 旧 ChatGPT 桌面 App 呢？ | 改名 **ChatGPT Classic** |
| 可以让它开机就是 Codex 吗？ | 可以，设为默认视图；macOS 上还能保留 Codex 图标 |
| 平台 | macOS + Windows，全球可用，**含 Free 计划** |

**它不是**：公司合并、模型合并、Codex 下线通知。是分发与工作流的合并。
2026-07-16 的后续更新又调整了 Chat / Work 的切换与 Projects 导航，
但官方明确"Codex 保持独立视图，工作流与历史不变"。
:::

**同期随合并落地的 Codex 侧新能力：**
- **diff 内联编辑**：直接在 diff 里改 Markdown 与代码，用内联批注让 Codex 修订选中内容
- **PR Chat（侧栏）**：审查 GitHub PR 并就改动提问，发内联评审意见、检视建议补丁，可在 App 内编辑/接受/拒绝
- **Computer Use 提速**（由 GPT-5.6 驱动）
- **单项目多仓库**（见 §19.10）
- 已发布 Sites 可接自定义域名
- 插件管理移入 Settings；Full access 警告更明确，Full access + Ultra 组合会额外弹确认框

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

- macOS：已发布（Apple Silicon + Intel），**即新的 ChatGPT 桌面 App**；支持可定制 Dock 图标（明/暗两款）
- Windows：**同为一等平台**（逐应用访问控制、Computer Use、Remote 控制、Windows 沙箱均已支持）；
  企业侧有专门的 Windows App 部署文档
- Linux：暂无桌面 App（CLI 支持完整）
- **EEA / 英国 / 瑞士**：Codex app 功能已可用（26.6xx）；
  但 **Record & Replay 初期不含 EEA / 英国 / 瑞士**（见 §19.11）

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

### 19.10 多文件夹项目与跨仓库审查（2026-07，26.715 / 26.727）

**本地项目现在可以包含多个相关文件夹。** 从项目菜单 **Edit project** 添加文件夹并指定**主文件夹（primary）**。

关键语义（决定 `AGENTS.md` 从哪读，很容易踩）：

| 行为 | 作用范围 |
|------|---------|
| 新建 chat、Git 操作、自动发现 `AGENTS.md` / skills / `config.toml` | **只用主文件夹** |
| 文件搜索、读取、编辑 | 主 + 次文件夹都可用 |

26.727 进一步支持**跨仓库审查**：在多文件夹项目里看到所有仓库及各自改动行数，
选 **Review** 即可跨仓库检视 diff，不必在多个审查视图间来回切。

### 19.11 ChatGPT Voice、Record & Replay、Chronicle（2026-07 三项新能力）

**ChatGPT Voice（由 GPT-Live 驱动，2026-07 26.715）：** 在桌面 App 的 Chat / Work / Codex 里
用语音推进工作——可以让它启动、检查、引导**其它线程**的工作。macOS 上开 **Screen context**
可顺手分享最前台窗口的 appshot（说"Take a look at this"即可）。
覆盖 Plus / Pro / Business / Edu / Enterprise，桌面 App + iOS Remote；
**Web 与移动端没有独立的 Work/Codex 语音**。Business 侧计费口径：
Chat 内语音含 1 小时、超出 5 credits/分钟；**Work 与 Codex 内语音约 6 credits/分钟**。

**Record & Replay（macOS）：** 在 Mac 上演示一遍工作流，让它变成可复用的 **skill**。
适合重复、依赖个人偏好、"演示比描述容易"的流程（报销、建配置正确的 issue、发布视频、下载周期报表）。
入口：Plugins → `+` → **Record a skill**。
**可用性边界**：仅 macOS，初期**不含 EEA / 英国 / 瑞士**，且要求 Computer Use 可用并启用——
企业若在 `requirements.toml` 里设 `[features].computer_use = false`，**Record & Replay 会一并不可用**
（这是同一个开关，容易误伤）。

**Chronicle（研究预览，仅 macOS + ChatGPT Pro，opt-in）：** 用**屏幕上下文**增强 Codex memories，
减少你反复重述上下文。开启路径：Settings → Personalization → 确保 Memories 打开 → 打开 Chronicle
→ 同意 → 授予 macOS 录屏与辅助功能权限。

> **⚠️ Chronicle 的三条官方风险提示（启用前必读）：**
> ① **快速消耗 rate limit**；② **提高 prompt injection 风险**；
> ③ **memories 以未加密形式存在本机**。
> 设计上它并不总把屏幕内容当答案——当有更好的来源（具体文件、Slack 线程、Google Doc、dashboard、PR）时，
> Chronicle 的作用是**帮它定位该用哪个来源**，然后直接去用那个来源。
> 这个"用屏幕做索引而非做内容"的取舍，比"把截图塞进上下文"稳健得多，值得借鉴。

### 19.12 其它（2026-07/08）

- **Activity view**（26.727）：侧栏新增，看最近参与且需要你处理的 chats；`Cmd`/`Ctrl`+`Opt`+`U` 切换
- **内置浏览器升级**（26.727）：地址栏可回访历史/无匹配时搜 Google、Settings 里管浏览历史、
  可让 ChatGPT 搜自己的浏览历史找回之前看过的页面
- **Chrome 扩展**：@ 提及已打开的标签页、把高亮文本带进 side chat、对任意 YouTube 视频提问、
  右键"Ask ChatGPT"
- **图像细化**（26.727）：生成图可在扩展查看器里开，切 Focused / Canvas 视图，跨图批注后发定向修改
- **Codex Micro**（限量联名硬件，与 Work Louder 合作）：配合桌面 App 的实体键盘控制器——
  Agent Keys 跟随/触发 chat（带状态灯）、六个 Command Keys（默认：Fast 开关 / 批准 / 拒绝 /
  在新 chat 继续 / push-to-talk / 发送）、摇杆四向（默认：Plan 模式、前进、显隐侧栏、后退）、
  旋钮做 composer 导航。**这是配件而非核心功能**，但它侧面说明"批准/拒绝"被认为高频到值得给物理键

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

**可用性：** 研究预览，面向 ChatGPT Pro、Enterprise、Business、Edu 客户，首月免费。

**2026-08 形态已扩成四条交付路径**（旧版只提"通过 Codex Web 访问"，已不完整）：

| 路径 | 说明 | 版本线（2026-07 底） |
|------|------|---------------------|
| **Codex Security 插件** | 桌面 App / CLI 内安装，含 Security 工作台（workbench）看已存扫描、发现、仓库历史与修复 | 托管目录 `0.1.15`；公共 CLI 插件市场 `0.1.11` |
| **Codex Security CLI** | `@openai/codex-security`，从终端或 CI 跑扫描、审 PR 变更、上传 SARIF、跨 GitHub 仓库/固定 CSV 清单做可恢复的批量扫描 | `0.1.5` |
| **TypeScript SDK** | 把扫描、进度上报、成本控制、取消能力接进自有工具 | `0.1.5`（与插件版本线独立） |
| **Codex Security cloud** | 扫连接的 GitHub 仓库，含 Security Review 与威胁模型改进 | — |

插件安装：桌面 App 里搜 Codex Security，或 CLI 里 `/plugins` 搜索安装，然后 `/new` 起新 chat。

**0.1.14 / 0.1.15 新增**：扫描结果对比、误报反馈、**限定作用域的 `SECURITY.md` 策略**、
更清晰的仓库与发现历史；可勾选发现并跟踪到 Linear / GitHub Issues——
**Codex 会先审查拟执行的动作再由你批准**（又一处事前审查而非事后记账的设计）。

> **两个版本线互相独立**（插件 vs CLI/SDK），依赖新特性前先查
> [插件 changelog](https://developers.openai.com/codex/security/plugin/changelog)。
> 另外官方明确要求：**只扫你拥有或获授权评估的代码**。

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

### 24.2 Codex SDK（TypeScript + Python 双语言）

**何时用 SDK（官方给的四个场景）：** 把 Codex 接进 CI/CD、造一个能与 Codex 协作完成复杂工程任务的
自有 agent、把 Codex 嵌进内部工具/工作流、集成进自己的应用。

**选型判据（这条比 API 细节重要）：**
- 要的是**以编码为中心的 Codex 线程** → 用 Codex SDK
- Codex 只是更大编排流程里的**一个专家** → 把 Codex CLI 当 **MCP server** 跑，用 Agents SDK 编排（§24.4）
- 需要**带结构化安全发现与覆盖度的仓库/变更扫描**（且有 beta 权限）→ 用 Codex Security TypeScript SDK（§23）

**TypeScript 库（`@openai/codex-sdk`，需 Node.js 18+，服务端使用）：**

```bash
npm install @openai/codex-sdk
```

```ts
const codex = new Codex();
const thread = codex.startThread();

const result = await thread.run("Make a plan to diagnose and fix the CI failures");
console.log(result.finalResponse);

// 同一线程继续
const result2 = await thread.run("Implement the plan");

// 恢复历史线程
const thread2 = codex.resumeThread(threadId);
const result3 = await thread2.run("Pick up where you left off");
```

**Python 库（`openai-codex`，需 Python 3.10+）：**

```bash
pip install openai-codex
```

Python SDK 通过 **JSON-RPC 控制本地 Codex app-server**。
**已发布的 SDK 构建自带一个钉住版本的 Codex CLI 运行时依赖**，会自动使用该运行时——
只有要指定别的二进制时才需传 `CodexConfig(codex_bin=...)`。

> **两个 SDK 的架构差别值得注意：** Python SDK 明确是"驱动本地 app-server 的 JSON-RPC 客户端"，
> 也就是说 §3.2 的 App Server 不只是内部实现，**它是对外的集成契约**。
> 这与 Codex 把所有前端统一到 App Server 的设计是一致的：多做一层协议，
> SDK / IDE / 手机端就都是这层协议的消费者，而不是各写一遍。

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
| **ChatGPT Free** | $0 | 基础探索；**桌面 App 的 Chat / Work / Codex 三视图对所有计划开放（含 Free）**；Work/Codex 里可用 Terra |
| **ChatGPT Go** | $8/月 | 轻量任务；可用 Terra |
| **ChatGPT Plus** | $20/月 | 包含 Codex；Sol/Terra/Luna 全档可选（限额见 §25.2） |
| **ChatGPT Pro 5x** | $100/月 | 约 5x Plus 额度；Codex-Spark 研究预览 |
| **ChatGPT Pro 20x** | $200/月 | 更高额度，优先速度 |
| **ChatGPT Business** | $30/用户/月（标准）或按量 | 团队工作区、SSO、MFA；限额与 Plus 同档 |
| **ChatGPT Enterprise/Edu** | 自定义 | 按 credits 扩展；弹性定价下无固定 rate limit，**无弹性定价则多数功能与 Plus 同档** |
| **API Key** | 按量付费 | Token 计费（§25.3.1），无云端/工作区功能 |

> **注意 Free 也能进桌面 App 的 Codex 视图**（2026-07-09 起），
> 这与旧版"Codex 需付费订阅"的印象不同——门槛现在体现在用量与模型可选面上，而非入口。

> 说明：不同资料给出的档位口径略有出入（计划改版频繁）。以官方 [Pricing](https://developers.openai.com/codex/pricing) 为准。

### 25.2 用量限制详情（Local Messages / 5h，2026-08 官方口径）

**Plus / Business（同档）：**

| 模型 | 本地消息 / 5h |
|------|--------------|
| GPT-5.6 Sol | 10-100 |
| GPT-5.6 Terra | 25-200 |
| GPT-5.6 Luna | **250-2,000** |
| GPT-5.5 | 15-80 |
| GPT-5.4 | 20-100（8/31 退役） |
| GPT-5.4 mini | 60-350（8/31 退役） |

**Pro 5x：**

| 模型 | 本地消息 / 5h |
|------|--------------|
| GPT-5.6 Sol | 50-500 |
| GPT-5.6 Terra | 125-1,000 |
| GPT-5.6 Luna | **1,250-10,000** |
| GPT-5.5 | 75-400 |
| GPT-5.4 | 100-500（8/31 退役） |
| GPT-5.4 mini | 300-1,750（8/31 退役） |

> **⚠️ 与 2026-07 快照相比，档位结构变了：** Luna 的上限从"50-280"跳到"250-2,000"（Plus），
> 约 7-9 倍；Sol 下限反而从 15 降到 10。**这是 7/30 降价的连带效应**——
> credits 消耗降了，同样的额度换到更多消息。旧表已完全不可用。
>
> 本地消息与云任务共享同一个 5 小时窗口，另可能有每周上限。
> Enterprise/Edu 弹性定价无固定限制、随 credits 伸缩；**无弹性定价的 Enterprise/Edu
> 在多数功能上与 Plus 同档**（这条容易被忽略：买了 Enterprise 不等于自动获得更高 rate limit）。
> 用量池现在还与其他 agentic 功能共享（当前含 Plus/Pro 上的 ChatGPT for Excel）。
> 图像生成消耗额度约快 3-5 倍（随质量与尺寸）。

### 25.3 Credits 单价（每 1M tokens，2026-07-30 调整后）

| 模型 | 输入 | 缓存输入 | 输出 |
|------|------|----------|------|
| GPT-5.6 Sol | 125 | 12.5 | 750 |
| GPT-5.6 Terra | **50**（原 62.5） | **5**（原 6.25） | **300**（原 375） |
| GPT-5.6 Luna | **5**（原 25） | **0.5**（原 2.5） | **30**（原 150） |
| GPT-5.5 | 125 | 12.50 | 750 |
| GPT-5.4 | 62.50 | 6.250 | 375 |
| GPT-5.4 mini | 18.75 | 1.875 | 113 |
| GPT-5.3-Codex-Spark | 研究预览（独立用量限制） | | |
| GPT-Image-2（图像） | 200 | 50 | 750 |
| GPT-Image-2（文本） | 125 | 31.25 | 250 |

> **Luna 的 credits 单价降到原来的 1/5**（25 → 5 输入、150 → 30 输出），
> Terra 降 20%，Sol 未动。**Sol : Luna 的 credits 比价从 5:1 拉开到 25:1**——
> 这让"按任务分级路由模型"从一个优化技巧变成了成本结构上的主要决策。
>
> GPT-5.6 单条消息平均消耗约 5-40 credits。上表为 ChatGPT 订阅内的 **credits 单价**，
> 与下方 API Key 的**美元单价是两套独立计量**，不要混用换算。

### 25.3.1 GPT-5.6 API 美元单价（每 1M tokens，API Key 路径，2026-07-30 生效）

| 模型 | 输入 | 缓存输入 | 输出 | 本轮变化 |
|------|------|---------|------|---------|
| GPT-5.6 Sol | $5.00 | $0.50 | $30.00 | 不变 |
| GPT-5.6 Terra | **$2.00** | $0.20 | **$12.00** | ↓ 约 20%（原 $2.50 / $15.00） |
| GPT-5.6 Luna | **$0.20** | $0.02 | **$1.20** | ↓ 约 80%（原 $1.00 / $6.00） |

> - **降价日期与理由：** 2026-07-30 生效。OpenAI 口径是内部效率提升
>   （端到端服务成本降约 20%、token 生成效率提升 15%+）后回传给客户；
>   外部分析普遍认为直接压力来自 Gemini Flash / Claude Haiku 与开源权重模型（GLM、DeepSeek）。
>   同日起在 AWS 侧也开始铺开。
> - **Sol 未降**，所以最贵与最便宜档的价差从 **5x 扩大到 25x**。
>   这是本次更新里对架构选型影响最大的一条：**tier routing 现在是账单上的头号决策**。
> - GPT-5.6 全家族：知识截止 2026-02-16、1M+ token 上下文、128K 最大输出。
> - **缓存改进（GPT-5.6 起）：** 支持显式 cache breakpoints + 最低 30 分钟缓存寿命；缓存写入按未缓存输入价的 **1.25x** 计费，缓存读取仍享 **90% 折扣**。
> - **Cerebras 托管：** 2026-07 起 GPT-5.6 Sol 在 Cerebras 上可达最高 750 tokens/秒（初期限量）。
>
> **⚠️ 一条需要警惕的第三方叙事：** 有厂商案例把"换到 Luna 后 cache 复用从 24% 提到 90%、
> 成本降 87%"整体归因于换档。**cache 复用率的跃升来自架构改造（单次结构化输出 → 完整 tool-calling agent loop），
> 与选哪个档无关，任何档位都能吃到。** 把两件事混算会得出"换模型就能省 87%"的错误结论——
> 这正是本站北极星"更省"那条反复强调要用轨迹数据分离归因的原因。

### 25.3.2 Fast 模式与 Speed 配置（官方倍率）

| 项 | 倍率 / 说明 |
|----|------------|
| Fast 模式提速 | 支持模型 **1.5x** 速度 |
| GPT-5.6 / GPT-5.5 credits 消耗 | **2.5x** 标准速率 |
| GPT-5.4 credits 消耗 | **2x** 标准速率 |
| 支持模型 | GPT-5.6、GPT-5.5、GPT-5.4 |
| 开关 | CLI 里 `/fast on\|off\|status`；持久化写 `service_tier = "fast"` + `[features].fast_mode = true` |
| 可用面 | ChatGPT 桌面 App、Codex CLI、IDE 扩展（**需 ChatGPT 登录**） |
| API Key 路径 | credits 倍率**不适用**，改按 API token 计价；API Priority 另有费率（GPT-5.6 为标准 API 价的 **2x**） |

> **Fast ≠ Codex-Spark。** Fast 是把某个支持的模型加速并按更高 credit 率计费；
> **GPT-5.3-Codex-Spark 是独立的、能力更弱的模型选项，有自己的用量限制**，
> 研究预览期仅 ChatGPT Pro 可用。两者常被混为一谈。

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
| 实现语言 | Rust（95.96%，GitHub 实查） | TypeScript（推测） |
| 默认模型 | GPT-5.6 Sol（Power 档 = Sol + medium reasoning）/ Terra / Luna | Claude 系列（Opus/Sonnet） |
| 最大上下文 | GPT-5.6 全家族 1M+；GPT-5.5 在 Codex 内 400K | 1M tokens（beta） |
| 最大输出 | 128K tokens（GPT-5.6） | 128K tokens |
| 配置文件 | AGENTS.md（开放标准） | CLAUDE.md（专有） |
| 配置格式 | TOML（config.toml） | JSON（settings.json） |
| 沙箱 | OS 内核级（Seatbelt/Landlock/seccomp） | 应用层（hooks + bubblewrap） |
| 工具设计 | Shell-Centric（少量工具） | Tool-Centric（20+ 专用工具） |
| 文件编辑 | apply_patch（diff 格式） | Edit（精确字符串替换） |
| 权限模型 | 权限 Profiles（Beta，取代 full-auto）+ **Rules 命令级 allow/prompt/forbidden** + Auto-Review 事前审查 | 审批模式 + hooks + allow/deny 列表 |
| Hook 事件 | **11 个**（GA 2026-05-14），但覆盖不到全部 shell 路径与 WebSearch | 更多、更细，拦截面更完整 |
| 企业 policy 强制 | **强**：`requirements.toml` 只能收紧不能放宽、托管 hook 用户不可关 | managed settings，hook 层强制粒度较弱 |
| 长时自治 | `/goal` 持续目标（跨 turn/暂停/压缩存活） | 无同类一等对象 |
| 浏览器能力 | Browser Use + CDP Developer Mode + Chrome 扩展 | 无内置（靠 MCP） |
| 云端执行 | 是（Codex Cloud） | 否（纯本地） |
| 建站托管 | 是（Sites，可接自定义域名） | 否 |
| 远程操控 | 是（Codex Remote GA，手机控 Mac/Windows） | 否 |
| 桌面应用 | 是，**且已并入 ChatGPT 桌面 App**（Chat/Work/Codex 三视图，含 Free） | 是（Desktop App） |
| IDE 集成 | VS Code / Cursor / Windsurf / JetBrains / Xcode | VS Code / JetBrains |
| 安全扫描 | Codex Security（插件 + CLI + TS SDK + cloud 四路径） | Claude Code Security |
| 语音 | 是（**ChatGPT Voice** 可跨线程指挥 + iOS dictation） | 是 |
| 屏幕上下文 | Appshots + **Chronicle**（研究预览，屏幕记忆） | 无同类 |
| 演示录制 | **Record & Replay**（演示 → skill，macOS） | 无同类 |
| Computer Use | 是（原生，含 Windows，锁屏可续） | 是 |
| 多代理 | Subagents（**默认开启**）+ App 多线程 + Worktree | Agent Teams（实验性） |
| SDK | **TypeScript + Python 双 SDK** + App Server JSON-RPC + MCP server | Agent SDK |
| 模型提供商 | OpenAI 直连 / Amazon Bedrock（GPT-5.6 三档 GA） | Anthropic / Bedrock / Vertex |
| 定价入口 | ChatGPT Plus $20/月（Free 亦可进 Codex 视图） | Claude Pro $20/月 |
| 最便宜档 API 价 | **$0.20/$1.20（Luna，7/30 降价后）** | Haiku 系列 |
| GitHub Stars | **104K+** | 非开源 |

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
| 2026-07-09 | **GPT-5.6 GA / CLI v0.144.1 / App 26.707** | GPT-5.6 在 **ChatGPT / Codex / OpenAI API 全面 GA**（有公开 API 定价）；知识截止 2026-02-16、1M+ 上下文、128K 输出；改进的 prompt caching（显式 cache breakpoints + 30 分钟最低缓存寿命）；`writes` 审批模式；MCP 工具可交互式请求认证；恢复线程遇退役模型自动重试；Sol 于 Cerebras 达 750 tok/s（限量）。**同日：Codex App 并入 ChatGPT 桌面 App**（旧版改名 ChatGPT Classic）+ **ChatGPT Work 发布**；diff 内联编辑、侧栏 PR Chat、Computer Use 提速、单项目多仓库 |
| 2026-07-14 | **CLI v0.144.5** | 扩大 `is_dangerous_command` 判定范围（安全侧收紧） |
| 2026-07-16 | App 桌面体验更新 | 调整 Chat / Work 切换与 Projects 导航；**Codex 保持独立视图、工作流与历史不变** |
| 2026-07-23 | **ChatGPT Voice（26.715）** | GPT-Live 驱动，可在 Chat/Work/Codex 里用语音**跨线程**启动/检查/引导工作；macOS Screen context 分享 appshot；**本地多文件夹项目**（主/次文件夹语义，见 §19.10） |
| 2026-07-27 | **CLI v0.145.0** | 实验性分页线程历史（高效 resume/搜索/持久名/子代理/memories）；`/import` **扩到 Cursor**（设置/MCP/插件/会话/命令/项目级 memories）；Bedrock 登录 + 自定义端点，**Bedrock 默认模型改为 GPT-5.6 Sol**；音频输入与工具输出 + realtime V3；**MultiAgentV2 稳定化**（可配子代理模型/推理级/并发/角色恢复）；内联可视化链接；把内置 GPT-5.4 选择迁到 Terra/Luna |
| **2026-07-30** | **Terra / Luna 降价** | **API：Terra −20%（$2/$12）、Luna −80%（$0.20/$1.20）、Sol 不变**；ChatGPT Work/Codex 内 credits 消耗同步下调、用量上限大幅上调（§25）；官方归因于服务成本降 20%、token 生成效率 +15%；同日起在 AWS 侧铺开 |
| 2026-07-31 | **GPT-5.4 退役公告** | `gpt-5.4` / `gpt-5.4-mini` 将于 **2026-08-31** 从 ChatGPT 登录的 Codex 下线，替换为 Terra / Luna；API Key 路径不受影响 |
| 2026-07 | **Sign in with ChatGPT（beta）** | 首批 Airtable / GitLab / HubSpot / Notion / Supabase / Vercel |
| 2026-07 | **CLI v0.146.0** | `/new` `/clear` 可命名会话、pin 线程、side chat 不关闭切换；Agent Plugins 清单 + 工作区插件发布 + Bedrock/Claude Code 插件市场；带分页历史的 fork（含临时 fork）；app-server 经 WebSocket 连远程 Code Mode host；自定义 provider 可独立 web search；executor 提供的 skills 发现 |
| 2026-07 | **App 26.727** | 内置浏览器地址栏/历史管理 + 让 ChatGPT 搜浏览历史；Chrome 扩展（提及标签页、YouTube 提问、右键 Ask）；**跨仓库审查**；生成图 Focused/Canvas 视图 + 跨图批注；侧栏 **Activity view**（`Cmd/Ctrl+Opt+U`）|
| 2026-08-05 | **CLI v0.146.1** | 为 cyber-capable 模型应用更安全的自动审查默认值，并在终端解释权限变更 |
| **2026-08-07** | **CLI v0.147.0**（当前稳定） | 便携 **Agent Plugins** + 跨 local/personal/workspace/remote 插件目录搜索；线程**持久分节**与增量浏览长 transcript；**新增 `--approve-for-me`**；导入 Cursor skills + 同步已导入 Claude/Cursor 对话不产生重复；**MCP 2026-07-28 协议**（分页发现/多轮请求/非阻塞启动）；Bedrock cached web search + 远程压缩；**从显示命令与回放历史中脱敏 secrets 与 bearer token**；不熟悉的本地项目需显式信任；插件隔离加固、策略更新失败时拒绝网络；**移除 `codex exec --full-auto`**；MCP SDK→3.0.0、Ratatui→0.30.2、V8→150.4.0 |

> ⚠️ Codex 迭代极快（近乎每周），部分中间 patch 版本未列出。以官方 changelog 为准。
> **版本号说明：** Codex 有**三条**版本线，互不对应，引用时注意区分——
> CLI 用 `rust-vX.Y.Z`（如 v0.147.0）、桌面 App 用 `26.7xx`（如 26.727）、
> iOS 用 `1.2026.xxx`（如 1.2026.202）。
> 另外 alpha 线（如 `v0.148.0-alpha.2`）与稳定线并行发布，**别把 alpha tag 当成已发布版本引用**。

---

## 参考资料

**本次（2026-08-08）新增/重点核验的一手来源：**

- [Codex Changelog](https://developers.openai.com/codex/changelog/)（v0.145 ~ v0.147 逐版核验）
- [Codex What's new](https://developers.openai.com/codex/whats-new)（官方周报式摘要，比 changelog 更快看清"什么变了"）
- [Codex Feature Maturity](https://developers.openai.com/codex/feature-maturity)（Under development / Experimental / Beta / Stable 四级定义与使用建议）
- [Codex Hooks](https://developers.openai.com/codex/hooks)（11 类事件、matcher 语义、覆盖面警告 —— 修正了旧版"3 个事件"的错误）
- [Codex Rules](https://developers.openai.com/codex/agent-configuration/rules)（`prefix_rule` 命令级 allow/prompt/forbidden）
- [Auto-review](https://developers.openai.com/codex/sandboxing/auto-review)（触发边界、可替换 Guardian 策略、三条官方局限）
- [Permission modes](https://developers.openai.com/codex/permission-modes) / [Permission profiles](https://developers.openai.com/codex/permissions)（Beta，与旧 sandbox 设置不可混用）
- [Subagents](https://developers.openai.com/codex/agent-configuration/subagents)（`[agents]` 完整字段与三层回退）
- [Speed](https://developers.openai.com/codex/agent-configuration/speed)（Fast 1.5x / 2.5x credits 倍率、与 Codex-Spark 的区别）
- [Codex SDK](https://developers.openai.com/codex/codex-sdk)（TypeScript + Python 双 SDK 与选型判据）
- [Managed configuration](https://developers.openai.com/codex/enterprise/managed-configuration)（`requirements.toml`、托管 hook、只能收紧的 rules）
- [Chronicle](https://developers.openai.com/codex/customization/chronicle) / [Record & Replay](https://developers.openai.com/codex/extend/record-and-replay)（研究预览与可用性边界）
- [ChatGPT is now a partner for your most ambitious work](https://openai.com/index/chatgpt-for-your-most-ambitious-work)（2026-07-09，Codex App 并入 ChatGPT 桌面 App 的一手公告）
- [GPT-5.6](https://openai.com/index/gpt-5-6)（页首带 2026-07-30 降价更新说明）
- [OpenAI cuts GPT-5.6 Luna and Terra prices](https://www.cnbc.com/2026/07/30/open-ai-price-cut-gpt.html)（CNBC，降价数字与市场背景）
- [OpenAI drops GPT-5.6 Luna and Terra API prices by up to 80%](https://www.infoworld.com/article/4203865/openai-drops-gpt-5-6-luna-and-terra-api-prices-by-up-to-80.html)（InfoWorld）
- [Codex Security plugin quickstart](https://developers.openai.com/codex/security/plugin)（四条交付路径与版本线）
- GitHub REST API `repos/openai/codex`（Stars / Forks / Issues / 语言占比实查，2026-08-08）

**基础来源：**

- [OpenAI Codex 官方文档](https://developers.openai.com/codex/)
- [Codex CLI GitHub 仓库](https://github.com/openai/codex)（104K+ Stars）
- [Codex Models](https://developers.openai.com/codex/models)（GPT-5.6 Sol/Terra/Luna、弃用表）
- [Codex Pricing](https://developers.openai.com/codex/pricing)（credits 单价、用量限制）
- [Codex Slack 集成](https://developers.openai.com/codex/third-party/slack) / [Codex Micro](https://developers.openai.com/codex/features/codex-micro)
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
