---
title: Claude Code 深入研究（2026-08 快照）
description: 20 章逐节成册，按目录跳章查阅——把 Claude Code 的功能、架构与实现细节交叉核验到版本号级别：20+ 内置工具、6 种权限模式、20+ Hook 事件、MCP 三大原语、Auto Mode 分类器、OS 沙箱、Dynamic Workflows。这是一份手册，不是读完就走的文章。
date: "2026-08-08"
series: 热点开源项目研究
audience: engineer
highlight: 20 章逐节可查 · 核验至 v2.1.224 · 截至 2026-08-08 快照
tags: [Claude Code, 深入研究, 权限, Hook, MCP, 参考]
outline: [2, 3]
---

# Claude Code 深入研究（2026-08 快照）

::: warning 先说清这份东西是什么
**这是一份逐章查阅的手册，不是一篇文章。** 它按章节组织，供你按目录跳到需要的那一节查，
而不是从头读到尾——所以它没有主线，也没有结论。

- **调研日期**：2026-08-08（本轮联网校验覆盖至 v2.1.224，2026-08-07 发布）
- **被调研版本**：Claude Code v2.1.224+（2026 年 8 月）
- **证据形态**：公开信息交叉核验（官方文档 / changelog / 发布说明 / 社区逆向分析），
  **不是我们自己的实测数据**。章节内的版本号与日期是它的证据，请连带一起读。
- **时效边界**：Claude Code 每周发版（7 月中到 8 月初的 24 天里发了 15 个版本）。
  **这是 2026-08-08 的快照，不是最新状态。**
  任何与当前行为不一致的地方，以[官方文档](https://docs.anthropic.com/en/docs/claude-code/overview)为准。

一份标清日期的快照不会变成假话，只会变成史料——但前提是你知道它的日期。
:::

::: tip 相比上一版（2026-07 快照）变了什么
如果你读过上一版，只看这几处就够：

- **Claude Opus 5 发布（2026-07-24）** 并成为默认 Opus 模型，Opus 4.8 降为 fallback；
  **thinking 默认开启**是它最容易踩的行为变更（§1）
- **`/review` 变成 `/code-review` 的别名**（v2.1.223），`/verify` 与 `/code-review` 不再自动触发（v2.1.215）；
  **`ultraplan` 已移除**（v2.1.222）（§4）
- 新增 **Artifact**（发布会话产物为网页）与 **EndConversation** 两个内置工具（§3）
- 新增 **`DirectoryAdded`** hook（v2.1.219）（§8）
- 嵌套子代理从"默认禁用"改回**默认深度 3**，并新增**并发上限 20**（§11）
- 沙箱新增 **`network.strictAllowlist`**（v2.1.219）与 **`filesystem.disabled`**（v2.1.216）（§17）
- **跨会话 `SendMessage` / `ListAgents`** 与 **`claude self-hosted-runner`**（v2.1.224）（§20）
:::

---

## 1. 产品概述

Claude Code 是 Anthropic 推出的 AI 编程 CLI 工具，运行在终端中，能够理解整个代码库、编辑文件、执行命令、与开发工具集成。

**可用平台：**
- Terminal CLI（核心）
- VS Code 扩展
- JetBrains 插件
- Desktop App（独立桌面应用）
- Web（claude.ai/code）
- Slack 集成
- GitHub Actions（CI/CD）
- iOS App（移动端）

**安装方式：**
```bash
# Native Install（推荐，自动更新）
curl -fsSL https://claude.ai/install.sh | bash

# Homebrew（不自动更新）
brew install --cask claude-code

# WinGet（Windows）
winget install Anthropic.ClaudeCode
```

**支持模型（2026-08 现状，Claude 5 家族）：**

| 模型 | Model ID | 定位 | 上下文 / 最大输出 | 定价（$/M 输入·输出） | 发布 |
|------|----------|------|-------------------|----------------------|------|
| **Claude Fable 5** | `claude-fable-5` | Mythos 级最高层，面向长跑代理的下一代智能 | 1M / 128K | $10 / $50 | 2026-06-09 |
| **Claude Opus 5** | `claude-opus-5` | ⭐ **当前 Opus 主力**，复杂 agentic 编码与企业工作；多数领域追平 Fable 5 而只要一半价格 | 1M / 128K | $5 / $25（fast $10/$50） | 2026-07-24 |
| **Claude Opus 4.8** | `claude-opus-4-8` | 上一代 Opus，仍全平台可用，现为 fallback 而非旗舰 | 1M / 128K | $5 / $25（fast $10/$50） | 2026-05-28 |
| **Claude Sonnet 5** | `claude-sonnet-5` | 日常编码平衡默认；Free/Pro 默认模型 | 1M / 128K | 导入价 $2/$10（至 2026-08-31）→ 标准 $3/$15 | 2026-06-30 |
| **Claude Haiku 4.5** | `claude-haiku-4-5-20251001` | 快速低延迟，适合子代理 / fan-out | 200K / 64K | $1 / $5 | 2025-10 |

**Opus 5 的四处关键变化（2026-07-24，v2.1.219 起在 CC 内为默认 Opus 模型）：**

| 变化 | 说明 |
|------|------|
| **同价升级** | $5/$25 与 Opus 4.8 **完全一致**，一分没涨。但配合 effort 分级，两个团队在同一张价目表下可以跑出差异极大的账单——省与贵现在取决于你怎么设 effort，不再取决于你选哪个模型 |
| ⚠️ **thinking 默认开启** | Opus 4.8 上不显式设 `thinking: {"type": "adaptive"}` 就不思考；**Opus 5 上同样的请求默认带思考**，由模型自行决定何时思考多深，`effort` 成为思考深度的控制旋钮。wire 值不变，显式传 adaptive 仍等价于默认 |
| **禁用 thinking 有约束** | 关掉 thinking 时 effort **被封顶在 `high`**（不能再要 `xhigh`/`max`） |
| **安全分流** | Opus 5 刻意**不追求** offensive cybersecurity 等高危 dual-use 能力的 SOTA。被安全分类器拦下的请求在 Claude / Claude Code / Claude Cowork 中**自动回落到 Opus 4.8**；Fable 5 上被拦的生物学请求现在改路由到 Opus 5 |

同批发布的两个 beta（API 侧）：**会话中途更换工具**（改 Claude 可用的工具集**不会**让 prompt cache 失效）、
**API 自动 fallback**（被安全分类器拦下的 Opus 5 / Fable 5 请求自动改路由到别的模型，而不是直接被拒）。

- **默认模型因平台/订阅而异**：Anthropic API `opus` 别名 → **Opus 5**、`sonnet` → Sonnet 5；**Free/Pro 默认 Sonnet 5**（Pro 上 Opus 5 是可用的最强模型），**Max 默认 Opus 5**。Bedrock ID `anthropic.claude-opus-5`（也可走 `global.anthropic.claude-opus-5` 的 `InvokeModel`），Google Cloud / Microsoft Foundry 同名 `claude-opus-5`。
- **Sonnet 5 计费提醒**：使用了**新 tokenizer**，同样输入约映射为 1.0–1.35× token 数；导入价刻意设为与 Sonnet 4.6 近似成本中性，9/1 转标准价后实际账单可能上升约 50%。
- **1M 上下文别名**：`/model opus[1m]` / `/model sonnet[1m]`，或全名追加 `[1m]`（如 `claude-opus-5[1m]`）。
  ⚠️ **v2.1.223 扩大了 `CLAUDE_CODE_DISABLE_1M_CONTEXT` 的作用域**：过去只约束一份固定模型清单，现在**所有原生 1M 窗口的 Claude 模型**都会被自动压缩按住在 200K；当 auto-compaction 没能把会话压在 200K 内时会有启动告警。同版本还让 auto-compact 对**未知 model ID** 也按假定窗口约束（`CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT=1` 恢复旧行为）。
- 可通过 `/model` 切换（无参调出交互选择器），或 `claude --model <name>` 启动时指定；`availableModels` / `enforceAvailableModels` 可限制可选模型。
- 支持最多 **3 个 fallback models**（`fallbackModel` 设置 + `--fallback-model`，v2.1.167 起也作用于交互式会话；v2026.6 GA）在过载时按序降级。
- **Effort 分级**：`/effort` 支持 `low`/`medium`/`high`/`xhigh`/`max`（v2.1.171+ 新增 `xhigh`= API 的 "extra"，介于 high 与 max 之间；无参调出交互滑块），另有 `ultracode` 档同时给 `xhigh` 推理与自动工作流编排（见 §20.6）。Opus 系列全平台默认 `high`。
- **Fast Mode**（Research Preview，仅 Opus 系列）：输出速度约 2.5×，API 通过 `speed:"fast"` + `fast-mode-2026-02-01` beta header 启用；CC 内以 `/fast` 切换。⚠️ **v2.1.219 起 `/fast` 覆盖 Opus 5 与 Opus 4.8，Opus 4.7 已从 fast mode 移除**。Opus 5 fast 仅在 Claude API 可用（Bedrock / Google Cloud / Foundry 暫不支持），定价 $10/$50。
- **Claude Mythos 5**（`claude-mythos-5`）：与 Fable 5 同规格同定价，属 Project Glasswing 门控的邀请制预览（另有 `claude-mythos-preview`），非 GA。

> **模型迭代提示**：本文所列模型 ID 会随版本演进（旧版曾以 Opus 4.6/4.7/4.8 / Sonnet 4.6 为主力）。实际以 `/model` 列表与官方 [models overview](https://platform.claude.com/docs/en/about-claude/models) 为准。

**2026 年关键能力升级：**

| 能力 | 说明 |
|------|------|
| 1M 上下文窗口 | Opus 5 / Opus 4.8 / Sonnet 5 / Fable 5 默认支持，标准定价无长上下文附加费 |
| 128K 最大输出 | Opus 5 支持最大 128K tokens 输出（Batch API 带 beta header 可到 300K） |
| Adaptive Thinking | 自适应思考（不再支持手动扩展思考预算）；**Opus 5 起默认开启**，effort 即思考深度旋钮 |
| Fast Mode | 输出速度约 2.5×（Research Preview，Opus 5 / Opus 4.8，`/fast`；仅 Claude API） |
| Mid-conversation 工具变更 | Opus 5 新增 beta：会话中途改工具集**不失效 prompt cache**（API 能力） |
| API 自动 fallback | Opus 5 / Fable 5 被安全分类器拦下的请求自动改路由到别的模型，而非直接拒绝（beta） |
| Manual 默认权限模式 | v2.1.200 起 `default` 显示为 "Manual"，人类批准为出厂基线；`auto` 不再默认 |
| Auto Mode | AI 权限分类器，减少权限疲劳；v2.1.207 起 Bedrock/Vertex/Foundry **默认开启**（`disableAutoMode` 关闭）；v2.1.210 起外部会话的分类器默认 Sonnet 5 |
| Scheduled Tasks / Routines | 保存 prompt 定时/GitHub/API 触发；Desktop 本地任务 + 云端 Routines（`/schedule`，2026-04 研究预览） |
| Agent Teams / Agent View | 多代理协作 + 统一会话列表（`claude agents`，Research Preview）；v2.1.224 起 `SendMessage` / `ListAgents` **可跨会话**（macOS/Linux） |
| Dynamic Workflows | 让 Claude 自建 JS 编排脚本调度数十至数百子代理（v2.1.154 Research Preview；`ultracode` 触发；v2.1.219 起默认"少于 15 个 agent"的中档规模指引） |
| Artifacts | 把会话产物发布成 claude.ai 上的私有实时网页（2026-06-18 beta，CLI ≥ v2.1.183） |
| `/loop` 定时任务 | Cron 式后台循环执行（会话内，CronCreate/List/Delete） |
| Agent Checkpointing | 保存/恢复整棵代理树中间状态（Beta） |
| Computer Use | 远程桌面控制（GA，OSWorld 84%） |
| Voice Mode | 语音输入编程 |
| Remote Control | 从 claude.ai/手机控制本地 Claude Code；v2.1.224 起可见压缩进度与边界、`/clear` 会传播 |
| Self-hosted runner | `claude self-hosted-runner` 自建执行环境（v2.1.224，Team/Enterprise） |
| Plugin Marketplace | 插件市场，捆绑 skills/agents/hooks/MCP；`.claude/skills` 下插件免市场自动加载；v2.1.224 起支持 `archive` 源（HTTPS zip + SHA-256 pin，无需 git/npm） |
| Auto Memory | 自动记录和回忆工作上下文（`/memory` 管理）；v2.1.214 起 frontmatter 带 ISO `modified` 时间戳 |
| VS Code 深度集成 | Activity bar 会话列表、原生插件管理、远程会话浏览、计划渲染为 markdown；v2.1.221 加 **Focus view**（`Ctrl+Alt+F`，把工具活动折叠进逐轮摘要） |

**产品定位演进：**

Claude Code 已从"更好的代码补全"演进为"自主编程代理平台"。Skills、Subagents、Hooks、MCP、Plugins 构成完整的 Agent 开发平台。

---

## 2. 核心架构：Agentic While-Loop

Claude Code 的核心是一个围绕 Anthropic tool_use API 的 while 循环：

```
用户输入 → 追加到消息历史
         ↓
┌─→ 发送 messages + tool definitions 给 LLM（流式）
│        ↓
│   累积流式响应，实时渲染文本到终端
│        ↓
│   检查 stop_reason:
│   ├── "end_turn" → 结束，等待下一次用户输入
│   └── "tool_use" → 检查权限 → 执行工具 → 收集结果
│                     ↓
└── 追加 assistant 消息 + tool_result 到历史，继续循环
```

**关键设计：**
- 模型产生消息；如果包含 tool_use，执行工具并将结果反馈；没有 tool_use 则循环停止
- Claude Code 是模型的 "agent harness"：模型负责推理，工具负责执行
- System prompt 在运行时动态组装：身份/规则 + CLAUDE.md 内容 + 工具定义 + 环境信息 + 对话历史
- 三阶段工作流：**收集上下文** → **执行操作** → **验证结果**，这三个阶段可以混合交替
- 用户随时可以中断，改变方向、提供额外上下文、要求尝试不同方案
- 核心设计哲学：**"do the simple thing first"**——选择正则而非嵌入向量做搜索，选择 Markdown 文件而非数据库做记忆

**分层架构：**
```
用户交互层（CLI / VS Code / JetBrains / Desktop / Web）
         ↓
Agent Loop（消息循环 + 工具调度）
  ├── 主循环引擎（nO）
  └── 异步消息队列（h2A，事件处理）
         ↓
工具执行层（内置工具 + MCP 工具 + BatchTool 批量操作）
         ↓
权限检查层（deny → allow → ask）+ Auto Mode AI 分类器
         ↓
LLM API（Anthropic Messages API，流式 + prompt 缓存）
```

### 2.1 内部实现细节（逆向工程分析）

**System Prompt 三层注入机制：**

Claude Code 的 prompt 增强（Prompt Augmentation）在三个层面运作：

| 层面 | 机制 | 持久性 | 示例 |
|------|------|--------|------|
| 系统级行为修改 | 修改 system prompt | 整个会话持久 | 输出风格、身份定义 |
| 消息级内容注入 | 注入到 user messages | 按消息 | CLAUDE.md 内容、slash 命令、skills |
| 对话级委派 | 独立对话上下文 | 子代理生命周期 | 子代理（Explore/Plan/general-purpose） |

- **System prompt** 定义 Claude 的身份和能力（约 16,000+ 词）
- **CLAUDE.md** 作为 `system-reminder` 标签注入到 user messages 中，带有 "IMPORTANT: These instructions OVERRIDE any default behavior" 前缀
- **Skills** 通过 `Skill` 元工具触发，将 SKILL.md 内容展开为详细指令注入到对话上下文
- **子代理** 生成完全独立的对话，拥有自己的 system prompt 和工具列表

**Prompt 缓存策略：**

Claude Code 使用 Anthropic 的 prompt caching 机制优化性能和成本：
- System prompt 和 CLAUDE.md 内容使用 `cache_control: { type: "ephemeral" }` 标记
- 首次请求支付完整 token 成本，后续请求从缓存读取（`cache_read_input_tokens`）
- 工具定义在每次请求中发送但被缓存
- 会话消息中的 usage 字段包含：`cache_creation_input_tokens`、`cache_read_input_tokens`、`input_tokens`、`output_tokens`

**BatchTool 批量操作：**

Claude Code 内部使用 `BatchTool` 将多个工具调用打包为一次操作，提高效率：
```json
{
  "name": "BatchTool",
  "input": {
    "description": "Gather repository information",
    "invocations": [
      { "tool_name": "GlobTool", "input": { "pattern": "package.json" } },
      { "tool_name": "GlobTool", "input": { "pattern": "*.md" } },
      { "tool_name": "GlobTool", "input": { "pattern": ".github/copilot-instructions.md" } }
    ]
  }
}
```

**Adaptive Thinking（自适应思考）：**

Claude 4.6+（含 Opus 4.8 / Claude 5 家族）支持自适应思考模式，在 agentic 工作流中自动决定是否使用扩展思考（Opus 4.8 起不再支持手动扩展思考预算）：
- 使用 `thinking: { type: "adaptive" }` 配置。
  ⚠️ **Opus 5 起这是默认值**——不显式配置也带思考，`effort` 成为思考深度的旋钮；
  要真正关掉 thinking，effort 必须在 `high` 及以下
- 收到工具结果后，模型会在 `thinking` block 中反思结果质量并规划下一步
- 可通过 prompt 引导思考行为的触发频率
- `Alt+T` 快捷键可手动切换扩展思考开关

**上下文感知（Context Awareness）：**

Claude 4.6+ / Opus 4.8 / Claude 5 家族模型具备上下文感知能力，能够追踪剩余上下文窗口（token 预算）：
- 模型在接近上下文限制时会自然尝试收尾工作
- Claude Code 通过 system prompt 告知模型可以进行上下文压缩和外部文件保存
- 这使得模型能更有效地管理长会话中的上下文使用

**Git 状态注入：**

每次会话开始时，Claude Code 将当前 git 状态注入到上下文中：
- 当前分支名
- 主分支名（用于 PR 目标）
- `git status` 输出
- 最近的 commit 历史
- 完整的目录树视图（可能较大）

---

## 3. 内置工具系统

Claude Code 约有 **20+ 内置工具**，每个工具定义包含 `name`、`description`、`input_schema`（JSON Schema）。工具定义随每次 API 调用发送给模型。

### 3.1 文件系统工具

| 工具 | 功能 | 关键参数 |
|------|------|----------|
| **Read** | 读取文件内容 | `file_path`（绝对路径）, `offset`（起始行号）, `limit`（行数）, `pages`（PDF 页码范围） |
| **Write** | 写入/覆盖整个文件 | `file_path`, `content` |
| **Edit** | 精确字符串替换 | `file_path`, `old_string`, `new_string`, `replace_all`（布尔值，默认 false） |
| **MultiEdit** | 单文件多处编辑 | `file_path`, 多组 `old_string`/`new_string` |
| **NotebookEdit** | 编辑 Jupyter notebook 单元格 | `notebook_path`, `cell_number`（0-indexed）, `new_source`, `cell_type`, `edit_mode`（replace/insert/delete） |

**Read 工具细节：**
- 默认读取前 2000 行，超过 2000 字符的行会被截断
- 返回格式为 `cat -n`（带行号），行号从 1 开始
- 支持读取图片（PNG/JPG 等，多模态处理）、PDF（大文件需指定页码范围，每次最多 20 页）、Jupyter notebook
- 只能读文件不能读目录（读目录用 Bash 的 `ls`）

**Edit 工具细节：**
- `old_string` 必须在文件中唯一，否则失败（除非 `replace_all=true`）
- 必须先用 Read 读取文件后才能编辑（防止盲改）
- 保留精确缩进（tab/空格）
- 这是主要的代码修改机制——模型回显精确的原始行作为 `old_string`，然后提供替换内容

**Write 工具细节：**
- 如果文件已存在，必须先 Read 才能 Write（防止覆盖未读内容）
- 优先使用 Edit 修改现有文件，Write 仅用于创建新文件或完全重写

### 3.2 搜索工具

| 工具 | 功能 | 关键参数 |
|------|------|----------|
| **Glob** | 文件名模式匹配 | `pattern`（如 `**/*.js`）, `path`（搜索目录） |
| **Grep** | 文件内容搜索（基于 ripgrep） | `pattern`（正则）, `path`, `glob`（文件过滤）, `type`（文件类型）, `output_mode`（content/files_with_matches/count）, `-A`/`-B`/`-C`（上下文行数）, `multiline` |
| **LS** | 列出目录内容 | 目录路径 |

**Grep 工具细节：**
- 基于 ripgrep 构建，支持完整正则语法
- 三种输出模式：`content`（显示匹配行）、`files_with_matches`（仅文件路径，默认）、`count`（匹配计数）
- 支持 `multiline: true` 跨行匹配
- 支持 `head_limit` 和 `offset` 分页

### 3.3 执行工具

| 工具 | 功能 | 关键参数 |
|------|------|----------|
| **Bash** | 执行 shell 命令 | `command`, `timeout`（最大 600000ms，默认 120000ms）, `description`, `run_in_background` |
| **BashOutput** | 读取后台 Bash 命令输出 | `task_id` |
| **KillShell** | 终止运行中的 shell 进程 | `task_id` |

**Bash 工具细节：**
- 工作目录在命令间持久化，但 shell 状态（变量等）不持久化
- Shell 环境从用户 profile（bash 或 zsh）初始化
- 支持后台运行（`run_in_background`），完成后通知
- 感知 shell 操作符（如 `&&`），前缀匹配规则 `Bash(safe-cmd *)` 不会允许 `safe-cmd && other-cmd`
- 包含路径中有空格时必须用双引号

### 3.4 Web 工具

| 工具 | 功能 | 关键参数 |
|------|------|----------|
| **WebFetch** | 获取 URL 内容并用 AI 处理 | `url`, `prompt` |
| **WebSearch** | 搜索网页 | `query`, `allowed_domains`, `blocked_domains` |

**WebFetch 细节：**
- 获取 URL 内容，将 HTML 转为 markdown
- 用小型快速模型处理内容（独立上下文窗口，避免注入）
- 15 分钟缓存
- 不支持需要认证的 URL（Google Docs、Jira 等需用专门的 MCP 工具）

### 3.5 任务管理工具

| 工具 | 功能 |
|------|------|
| **TodoRead** | 读取当前任务列表状态 |
| **TodoWrite** | 管理任务/待办列表，跟踪多步骤工作 |

### 3.6 计划与导航工具

| 工具 | 功能 |
|------|------|
| **ExitPlanMode** | 退出计划模式，返回正常执行 |
| **EnterPlanMode** | 进入计划模式（只读分析，不修改文件） |
| **AskUserQuestion** | 向用户提问，支持选项预览对话框 |

**AskUserQuestion 行为变更（v2.1.200，2026-07-03，⚠️ 破坏性）：**
- 对话框**默认不再自动 continue**：过去无人应答时会超时后自动推进，现在会**无限期等待人类响应**。
- 对无人值守场景（CI、后台 daemon 模式、作为编排器下的子代理）是破坏性变更——工具执行路径上任何 `AskUserQuestion` 触发都会阻塞下游任务。
- 缓解方式：① 通过系统提示词抑制澄清式提问；② 预授权工具让问题不触发；③ 在 `/config` 里用 `askUserQuestionTimeout` 显式开启空闲超时（`"60s"` / `"5m"` / `"never"`）。

### 3.7 代理工具

| 工具 | 功能 |
|------|------|
| **Agent** | 启动子代理，拥有独立上下文窗口 |
| **EnterWorktree** | 创建 git worktree 进行隔离工作 |
| **ExitWorktree** | 退出 worktree |

**Agent 工具细节：**
- 子代理可访问的工具子集：Bash, Glob, Grep, LS, Read, Edit, MultiEdit, Write, NotebookRead, NotebookEdit, WebFetch, TodoRead, TodoWrite, WebSearch
- 支持指定 `subagent_type`（Explore/Plan/general-purpose）
- 支持 `run_in_background` 后台运行
- 支持 `isolation: "worktree"` 在独立 git worktree 中运行
- 支持 `resume` 恢复之前的子代理

### 3.8 其他工具

| 工具 | 功能 |
|------|------|
| **CronCreate** | 创建定时任务（会话内有效） |
| **CronDelete** | 删除定时任务 |
| **CronList** | 列出所有定时任务 |
| **Skill** | 调用 skill（自定义命令） |
| **TaskCreate/TaskUpdate/TaskGet/TaskList** | 结构化任务管理 |
| **SendMessage** | 向其他 agent / 主会话发消息（Agent Teams 通信通道；v2.1.224 起可跨会话） |
| **Workflow** | 执行 Dynamic Workflow 编排脚本（见 §20.6） |
| **LSP** | 语言服务器查询（定义跳转、引用查找、hover、符号、调用层级等） |
| **Monitor** | 后台监视长跑脚本的 stdout，以聊天通知形式流式回报事件 |
| **Artifact** | 把 HTML / Markdown 页面发布到 claude.ai（默认私有，见 §3.10） |
| **EndConversation** | 面对高度辱骂性用户或越狱尝试时结束会话（v2.1.214 新增，对齐 claude.ai 2025 年起的行为） |

### 3.9 Artifact 工具（2026-06-18 beta）

把一次 Claude Code 会话的产物**发布成 claude.ai 上的一个实时网页**，会话继续时页面**原地更新**、
每次发布留一版历史。典型用途是 PR 走查、调查时间线、发布检查单、架构图、会话数据看板。

它与 claude.ai 聊天里的 Artifacts 同名但不同物——区别在**上下文来源**：Claude Code 的 artifact
由本地代码库 + MCP 连接器 + 会话历史三者共同构建，所以一个调试页面可以把失败的测试、
相关函数、监控里的错误尖峰和推理链条汇到一处。

**没有 `/artifact` 命令**，用自然语言让它做（"做个 artifact 展示…"），Claude 写好页面、
请求发布许可、然后打印 URL。

**可用条件（限制不少，逐条核对）：**

| 要求 | 条件 |
|------|------|
| 计划 | Pro / Max / Team / Enterprise。Pro/Max 上默认私有且无管理面；Team 默认开启；Enterprise 需 Owner 在 claude.ai 管理设置里开 |
| 认证 | 会话必须由 claude.ai 账号支撑（CLI 里 `/login`）。**用 API key、gateway token 或云厂商凭据的会话不能发布** |
| 模型供应商 | 仅 Anthropic API。**Bedrock / Google Cloud Agent Platform / Microsoft Foundry 不可用** |
| 组织策略 | CMEK、HIPAA、Zero Data Retention 任一开启即不可用 |
| 载体 | CLI ≥ v2.1.183 或桌面应用 ≥ 1.13576.0。Agent SDK / GitHub Action / MCP-server 上下文默认关闭，设了 `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` 亦关闭 |

默认只有创建者可见，可选择分享给组织内成员；**不能公开分享**（组织策略层面）。

### 3.10 工具优先级规则

Claude Code 的 system prompt 中明确规定了工具使用优先级：
- 读文件用 **Read** 而非 `cat/head/tail`
- 编辑文件用 **Edit** 而非 `sed/awk`
- 创建文件用 **Write** 而非 `echo/cat heredoc`
- 搜索文件用 **Glob** 而非 `find/ls`
- 搜索内容用 **Grep** 而非 `grep/rg`
- Bash 仅用于需要 shell 执行的系统命令

---

## 4. Slash 命令

在交互模式中输入 `/` 开头的命令。部分命令根据平台、订阅计划、环境不同而可见性不同。

### 4.1 会话管理

| 命令 | 功能 | 说明 |
|------|------|------|
| `/clear` | 清除对话历史和上下文 | 别名：`/reset`, `/new` |
| `/compact [focus]` | 压缩对话以释放上下文 | 可选 focus 参数指定保留重点，如 `/compact focus on auth errors` |
| `/exit` | 退出 CLI | 别名：`/quit` |
| `/fork [name]` | 分叉当前对话 | 从当前点创建对话分支 |
| `/export [filename]` | 导出对话为纯文本 | 无参数时弹出对话框选择复制或保存 |
| `/copy` | 复制最后一条助手回复 | 有代码块时显示交互式选择器，`w` 键写入文件 |
| `/rename [name]` | 重命名当前会话 | 无参数时自动从上下文生成名称 |

### 4.2 上下文与记忆

| 命令 | 功能 | 说明 |
|------|------|------|
| `/context` | 可视化当前上下文使用情况 | 显示彩色网格和 token 计数 |
| `/memory` | 编辑 CLAUDE.md 记忆文件 | 可启用/禁用 auto-memory，查看条目 |
| `/add-dir <path>` | 添加额外工作目录 | 当前会话有效 |
| `/init` | 初始化项目 CLAUDE.md | 分析代码库自动生成；已有 CLAUDE.md 时建议改进 |

### 4.3 模型与配置

| 命令 | 功能 | 说明 |
|------|------|------|
| `/model [model]` | 切换 AI 模型 | 左右箭头调整 effort level；立即生效 |
| `/config` | 打开设置界面 | 别名：`/settings`；带搜索的标签页 UI |
| `/permissions` | 查看/编辑权限规则 | 支持 `/` 搜索过滤 |
| `/theme` | 更改终端主题 | 亮色/暗色 |
| `/color [name]` | 设置 UI 强调色 | `default` 或 `reset` 恢复默认 |
| `/keybindings` | 配置自定义快捷键 | 打开配置文件 |
| `/terminal-setup` | 自动配置终端快捷键 | 为 VS Code/Alacritty/Zed/Warp/Kitty 配置 Shift+Enter |
| `/effort [level]` | 设置推理努力级别 | low/medium/high/xhigh/max；无参调出交互滑块（方向键选择） |
| `/fast` | 切换 Fast Mode | Research Preview，仅 Opus 系列；输出速度最高 2.5× |

### 4.4 开发与代码

| 命令 | 功能 | 说明 |
|------|------|------|
| `/code-review [level] [PR]` | 代码审查（**统一入口**） | 多代理按类别审查 + 置信度阈值 + 严重度标注；`--fix` 应用发现到工作树。v2.1.218 起**作为后台子代理运行**（不再占满对话）；v2.1.223 起**不带 effort 级别时复用你上次输入的级别**，显式写 `/code-review high` 才改 |
| `/review` | → `/code-review` 的**别名** | ⚠️ **v2.1.223 破坏性变更**：命令名仍可用，但执行内容改成了 `/code-review`（审查当前 diff）。原先"快速单遍只读"的语义已消失 |
| `/code-review ultra` | 云端深度审查 | `/ultrareview` 仍作为别名保留，但推荐形式是这个 |
| `/verify` | 跑起应用确认改动真的生效 | 内置 skill（v2.1.145）。⚠️ **v2.1.215 起只能手动调用**，Claude 不再自行触发 |
| `/commit` | 创建 git commit | 语义分析变更，生成 commit message |
| `/pr` | 创建 Pull Request | 分析所有 commit，生成 PR 描述 |
| `/diff` | 交互式 diff 查看器 | 左右箭头切换 git diff 和单次 turn diff，上下浏览文件。v2.1.222 起用**原始 git blob 内容**，忽略工作区配的 diff driver 与 textconv |
| `/plan [description]` | 进入计划模式 | 可选描述立即开始规划 |
| `/rewind` | 回退变更 | 使用 checkpoint 系统恢复代码和/或对话（v2.1.216 起拒绝还原符号链接 / 硬链接） |
| `/simplify` | 简化代码（内置 skill） | 现内部调用 `/code-review --fix`，检查复用/质量/效率并修复 |
| `/batch <instruction>` | 批量并行处理 | 分解为 5-30 个独立单元，每个在独立 worktree 中执行 |
| `/security-review` | 安全审查 | 专项安全漏洞扫描（v2.1.70） |
| `/debug [description]` | 调试当前会话 | 读取会话 debug 日志进行分析 |
| `/run` | 启动应用并验证改动 | 内置 skill（v2.1.145） |
| `/cd <path>` | 移动会话工作目录 | **不破坏 prompt cache**（v2.1.170） |
| ~~`/ultraplan`~~ | ~~浏览器支撑的规划会话~~ | ⚠️ **v2.1.222 已移除** |

> **一条容易踩的行为线（v2.1.215 / v2.1.218 两次收紧）**：`/verify`、`/code-review`、`/deep-research`
> 现在**都只在你显式调用时才跑**。过去 Claude 会在会话中途自行决定"你这段活该做次验证/审查"，
> 加轮次、也加账单。这类单行改动比多特性发布更值得留意——它挪的是**谁决定何时跑**。

### 4.5 诊断与账户

| 命令 | 功能 | 说明 |
|------|------|------|
| `/doctor` | 完整安装体检 | v2.1.205 起为完整 checkup，可诊断并（询问后）修复问题；别名 `/checkup` |
| `/cost` | 显示 token 用量和费用 | 当前会话统计 |
| `/usage` | 用量额度明细 | 曾名 `/extra-usage`；"usage credits" |
| `/stats` | 会话统计 | |
| `/status` | 显示会话状态 | 含当前模型 |
| `/login` | 登录 Anthropic 账户 | |
| `/logout` | 登出 | |
| `/bug` | 报告 bug | 别名：`/feedback` |
| `/help` | 显示帮助和可用命令 | |

### 4.6 高级功能

| 命令 | 功能 | 说明 |
|------|------|------|
| `/loop [interval] <prompt>` | 定时循环执行 | 如 `/loop 5m check the deploy`，默认 10 分钟间隔；无间隔时 Claude 自定节奏 |
| `/schedule <spec>` | 创建定时任务 / 云端 Routine | 如 `/schedule daily PR review at 9am`；v2026-04 起在 CLI 创建**云端 Routine**（详见 §20） |
| `/goal <description>` | 目标驱动持续执行 | 围绕目标自主推进长任务，带预算/轮次约束 |
| `/workflows` | 查看/管理动态工作流 | 观察、暂停、恢复、保存 Dynamic Workflows（v2.1.154+） |
| `/deep-research` | 多源联网研究报告 | 内置研究 workflow（v2.1.154）。⚠️ **v2.1.218 起只能手动调用** |
| `/background [prompt]` | 会话转后台代理 | 释放终端，任务在后台继续（v2.1.154） |
| `/reload-skills` | 会话中途刷新 skills | 配套 `SessionStart` hook 的 `reloadSkills: true`（v2.1.152） |
| `/teleport [id]` | 恢复远程会话到本地 | v2.1.223 起云端会话会直接提示 `claude --teleport <session id>` |
| `/release-notes` | 查看版本更新说明 | v2.1.212 修掉了"Show all 会把整份 changelog 灌进后续每次请求上下文"的问题 |
| `/powerup` | 交互式功能教程 | 带动画演示，讲解 Claude Code 特性（v2.1.90+） |
| `/team-onboarding` | 生成团队上手指南 | 从本地使用记录生成 ramp-up 指南（v2.1.101+） |
| `/tui` | 全屏 TUI 模式 | 切换全屏终端界面（v2.1.171+） |
| `/mcp [action] <name>` | 管理 MCP 服务器 | enable/disable/reconnect |
| `/vim` | 切换 vim 输入模式 | 支持标准 vim 动作和文本对象 |
| `/agents` | 管理子代理配置 | 创建/编辑/删除/查看 |
| `/hooks` | 管理 hook 配置 | |
| `/plugin` | 管理插件 | 安装/卸载/marketplace |
| `/todos` | 列出当前待办事项 | |
| `/desktop` | 在桌面应用中继续 | 别名：`/app`；仅 macOS/Windows |
| `/teleport` | 恢复远程会话 | claude.ai 订阅用户 |
| `/remote-control [name]` | 启用远程控制 | 从 claude.ai 控制本地 Claude Code |
| `/voice` | 语音输入模式 | |
| `/claude-api` | 加载 Claude API 参考 | 自动在代码导入 anthropic SDK 时触发 |
| `/insights` | 生成会话分析报告 | 分析交互模式和摩擦点 |
| `/install-github-app` | 安装 GitHub Actions 集成 | |
| `/install-slack-app` | 安装 Slack 应用 | |

### 4.7 自定义命令

用户可在 `.claude/commands/` 或 `.claude/skills/` 目录创建自定义命令：
- `.claude/commands/deploy.md` → 创建 `/deploy` 命令
- `.claude/skills/deploy/SKILL.md` → 同样创建 `/deploy`（功能更丰富）
- 命令内容是 markdown，Claude 将其作为指令执行
- 支持 `$ARGUMENTS` 占位符接收参数
- Skills 和 commands 已合并为统一系统，skill 优先级更高

---

## 5. CLI 命令与参数

### 5.1 启动命令

| 命令 | 功能 | 示例 |
|------|------|------|
| `claude` | 启动交互式会话 | `claude` |
| `claude "query"` | 带初始 prompt 启动 | `claude "explain this project"` |
| `claude -p "query"` | Headless 模式（非交互，输出后退出） | `claude -p "explain this function"` |
| `cat file \| claude -p "query"` | 管道输入处理 | `cat logs.txt \| claude -p "explain"` |
| `claude -c` | 继续当前目录最近的对话 | `claude -c` |
| `claude -c -p "query"` | 通过 SDK 继续对话 | `claude -c -p "check for type errors"` |
| `claude -r <session> "query"` | 按 ID 或名称恢复会话 | `claude -r "auth-refactor" "Finish this PR"` |
| `claude update` | 更新到最新版本 | `claude update` |
| `claude auth login` | 登录 | `claude auth login --email user@example.com --sso` |
| `claude auth logout` | 登出 | `claude auth logout` |
| `claude auth status` | 认证状态（JSON） | `claude auth status --text` |
| `claude agents` | 列出所有配置的子代理 | `claude agents` |
| `claude mcp` | 管理 MCP 服务器 | 见 MCP 章节 |
| `claude remote-control` | 启动远程控制会话 | `claude remote-control` |

### 5.2 CLI 参数（完整列表）

**会话控制：**

| 参数 | 功能 | 示例 |
|------|------|------|
| `--continue`, `-c` | 继续最近对话 | `claude -c` |
| `--resume`, `-r` | 恢复指定会话 | `claude -r auth-refactor` |
| `--print`, `-p` | Headless 模式 | `claude -p "query"` |
| `--session-id` | 指定会话 UUID | `claude --session-id "550e8400-..."` |
| `--fork-session` | 恢复时创建新会话 ID | `claude --resume abc --fork-session` |
| `--from-pr` | 恢复关联到 PR 的会话 | `claude --from-pr 123` |
| `--no-session-persistence` | 禁用会话持久化 | `claude -p --no-session-persistence "query"` |

**模型与行为：**

| 参数 | 功能 | 示例 |
|------|------|------|
| `--model` | 设置模型 | `claude --model claude-opus-5`（或 `claude-sonnet-5`、`claude-fable-5`） |
| `--effort` | 设置推理努力级别 | `claude --effort xhigh`（low/medium/high/xhigh/max） |
| `--agent` | 指定代理 | `claude --agent my-custom-agent` |
| `--agents` | 动态定义子代理（JSON） | `claude --agents '{"reviewer":{...}}'` |
| `--add-dir` | 添加额外工作目录 | `claude --add-dir ../apps ../lib` |
| `--chrome` | 启用 Chrome 浏览器集成 | `claude --chrome` |
| `--no-chrome` | 禁用 Chrome 集成 | `claude --no-chrome` |
| `--init` | 运行初始化 hooks 并启动 | `claude --init` |
| `--init-only` | 仅运行初始化 hooks 后退出 | `claude --init-only` |
| `--maintenance` | 运行维护 hooks 后退出 | `claude --maintenance` |
| `--ide` | 自动连接 IDE | `claude --ide` |
| `--remote` | 创建 claude.ai 远程会话 | `claude --remote "Fix the login bug"` |
| `--fallback-model` | 过载时自动降级模型 | `claude -p --fallback-model sonnet "query"` |

**权限控制：**

| 参数 | 功能 | 示例 |
|------|------|------|
| `--permission-mode` | 设置权限模式 | `claude --permission-mode plan` |
| `--allowedTools` | 允许的工具列表 | `"Bash(git log *)" "Read"` |
| `--disallowedTools` | 禁止的工具列表 | `"Bash(git push *)" "Edit"` |
| `--dangerously-skip-permissions` | 跳过所有权限检查 | `claude --dangerously-skip-permissions` |
| `--allow-dangerously-skip-permissions` | 启用跳过权限选项 | 与 `--permission-mode` 组合使用 |
| `--permission-prompt-tool` | 指定 MCP 工具处理权限 | `claude -p --permission-prompt-tool mcp_auth_tool` |

**System Prompt 控制：**

| 参数 | 功能 | 示例 |
|------|------|------|
| `--system-prompt` | 覆盖系统提示 | `claude -p --system-prompt "You are a reviewer"` |
| `--system-prompt-file` | 从文件加载系统提示 | `claude -p --system-prompt-file ./prompt.txt` |
| `--append-system-prompt` | 追加到系统提示末尾 | `claude --append-system-prompt "Always use TypeScript"` |
| `--append-system-prompt-file` | 从文件追加系统提示 | `claude --append-system-prompt-file ./extra-rules.txt` |

**输出控制：**

| 参数 | 功能 | 示例 |
|------|------|------|
| `--output-format` | 输出格式 | `text`（默认）/ `json` / `stream-json` |
| `--input-format` | 输入格式 | `text` / `stream-json` |
| `--include-partial-messages` | 包含部分流式事件 | 需配合 `--output-format stream-json` |
| `--json-schema` | 获取符合 JSON Schema 的输出 | `claude -p --json-schema '{...}' "query"` |
| `--verbose` | 详细输出 | `claude --verbose` |
| `--debug` | 调试模式 | `claude --debug "api,mcp"` |

**限制控制：**

| 参数 | 功能 | 示例 |
|------|------|------|
| `--max-turns` | 最大 agentic 轮次 | `claude -p --max-turns 3 "query"` |
| `--max-budget-usd` | 最大花费（美元） | `claude -p --max-budget-usd 5.00 "query"` |

**其他：**

| 参数 | 功能 | 示例 |
|------|------|------|
| `--mcp-config` | 加载 MCP 配置文件 | `claude --mcp-config ./mcp.json` |
| `--plugin-dir` | 加载插件目录 | `claude --plugin-dir ./my-plugins` |
| `--setting-sources` | 指定设置来源 | `claude --setting-sources user,project` |
| `--settings` | 指定设置 JSON 文件 | `claude --settings ./settings.json` |
| `--betas` | Beta 功能头 | `claude --betas interleaved-thinking` |
| `--disable-slash-commands` | 禁用所有 skills 和命令 | `claude --disable-slash-commands` |

---

## 6. 键盘快捷键与交互模式

### 6.1 通用控制

| 快捷键 | 功能 | 说明 |
|--------|------|------|
| `Enter` | 提交 prompt | 也接受并提交 prompt 建议 |
| `Ctrl+C` | 取消当前操作 | 双击 `Ctrl+C` 在有后台代理时退出 |
| `Ctrl+D` | 退出 Claude Code | EOF 信号 |
| `Ctrl+L` | 清屏 | 保留对话历史 |
| `Ctrl+O` | 切换详细输出 | 显示完整工具调用、thinking blocks、子代理详情 |
| `Ctrl+R` | 反向搜索命令历史 | 交互式搜索之前的命令 |
| `Ctrl+B` | 后台运行当前任务 | 统一处理 bash 命令和代理；tmux 用户需按两次 |
| `Ctrl+F` | 终止所有后台代理 | 3 秒内按两次确认 |
| `Ctrl+T` | 切换任务列表显示 | 在终端状态区域显示/隐藏 |
| `Ctrl+G` | 在外部编辑器中编辑 | 用默认编辑器编写 prompt 或自定义回复 |
| `Ctrl+S` | 暂存当前输入 | 保存草稿供稍后使用 |
| `Esc + Esc` | 回退/摘要 | 恢复代码和/或对话到之前的点 |
| `Shift+Tab` | 切换权限模式 | Default → Auto-Accept → Plan Mode 循环 |
| `Alt+P` | 切换模型 | 不清除当前 prompt |
| `Alt+T` | 切换扩展思考 | 启用/禁用 extended thinking |
| `↑/↓` | 浏览命令历史 | 回调之前的输入 |
| `←/→` | 切换对话框标签页 | 在权限对话框和菜单中导航 |

### 6.2 文本编辑

| 快捷键 | 功能 |
|--------|------|
| `Ctrl+K` | 删除到行尾（存储供粘贴） |
| `Ctrl+U` | 删除整行（存储供粘贴） |
| `Ctrl+Y` | 粘贴已删除文本 |
| `Alt+Y` | 循环粘贴历史（在 Ctrl+Y 之后） |
| `Alt+B` | 光标后退一个单词 |
| `Alt+F` | 光标前进一个单词 |

### 6.3 多行输入

| 方式 | 快捷键 | 说明 |
|------|--------|------|
| 快速转义 | `\` + `Enter` | 所有终端通用 |
| macOS 默认 | `Option+Enter` | macOS 默认 |
| Shift+Enter | `Shift+Enter` | iTerm2/WezTerm/Ghostty/Kitty 原生支持 |
| 控制序列 | `Ctrl+J` | 换行符 |
| 粘贴模式 | 直接粘贴 | 适用于代码块、日志 |

> 其他终端（VS Code/Alacritty/Zed/Warp）需运行 `/terminal-setup` 安装 Shift+Enter 绑定。

### 6.4 快速命令前缀

| 前缀 | 功能 | 说明 |
|------|------|------|
| `/` | Slash 命令或 skill | 输入 `/` 后可过滤 |
| `!` | Bash 模式 | 直接运行命令，输出加入会话 |
| `@` | 文件路径提及 | 触发文件路径自动补全 |

### 6.5 Vim 模式

通过 `/vim` 启用，支持：
- 标准动作：`h`, `j`, `k`, `l`, `w`, `b`, `e`, `0`, `$`, `^`
- `;` 和 `,` 重复 `f`/`F`/`t`/`T` 动作
- `y` 操作符（`yy`/`Y`），`p`/`P` 粘贴
- 文本对象：`iw`, `aw`, `iW`, `aW`, `i"`, `a"`, `i'`, `a'`, `i(`, `a(`, `i[`, `a[`, `i{`, `a{`
- `>>` 和 `<<` 缩进/反缩进，`J` 合并行

### 6.6 终端 UI 特性

**流式输出：**
- Token-by-token 实时流式渲染到终端
- Spinner 动画显示工具执行进度（50ms 动画循环）
- Spinner 显示 effort level 符号：`○`（低）、`◐`（中）、`●`（高）

**Markdown 渲染：**
- 终端内渲染 markdown，代码块带语法高亮
- 内联代码、粗体、彩色文本渲染
- Markdown 链接渲染为可点击的 OSC 8 超链接（支持的终端）

**状态栏（Status Line）：**
- 终端底部可自定义的状态栏，运行用户配置的 shell 脚本
- 接收 JSON 会话数据（工作区信息、上下文使用率、模型等）
- 上下文使用率颜色编码：灰色（≤60%）、琥珀色（61-80%）、红色（81%+）
- 可显示：仓库名、模型名、token 计数、权限模式、effort level、worktree 信息

**图片支持：**
- 拖放图片文件到终端窗口
- `Ctrl+V` / `Cmd+V` 从剪贴板粘贴截图
- 在消息中包含文件路径引用图片
- 支持格式：PNG, JPG, GIF, TIFF, BMP
- 图片转为 token 进行多模态处理
- PDF 也支持读取

---

## 7. 权限系统

### 7.1 权限分层模型

Claude Code 使用分层权限系统平衡功能与安全：

| 工具类型 | 示例 | 是否需要审批 | "不再询问"行为 |
|----------|------|-------------|----------------|
| 只读 | 文件读取、Grep、Glob | 否 | 不适用 |
| Bash 命令 | Shell 执行 | 是 | 按项目目录+命令永久记住 |
| 文件修改 | Edit/Write | 是 | 仅当前会话有效 |

### 7.2 权限模式

| 模式 | 说明 | 切换方式 |
|------|------|----------|
| `default`（**显示名 "Manual"**） | 标准行为：首次使用每个工具时提示确认。v2.1.200 起在 CLI/VS Code/JetBrains 显示为 "Manual"，并接受 `manual` 作为别名 | 默认；footer 显示灰色 ⏸ 徽章 |
| `acceptEdits` | 自动接受文件编辑及工作目录内常见文件系统命令（`mkdir`/`touch`/`mv`/`cp`），其他命令仍需确认 | `Shift+Tab` 循环 |
| `plan` | 计划模式：只读探索（读文件+只读命令），不修改源文件 | `Shift+Tab` 循环 |
| `auto` | 自动批准工具调用，后台安全检查校验动作与请求一致（研究预览，**非默认**） | `Shift+Tab` / `--permission-mode auto` |
| `dontAsk` | 自动拒绝工具，除非通过 `/permissions` 或 `permissions.allow` 预批准 | 设置文件 |
| `bypassPermissions` | 跳过权限提示（`ask` 规则与 `rm -rf /` 熔断除外） | CLI 参数 |

> **⚠️ v2.1.200（2026-07-03）默认权限模式重命名（务必注意）：**
> - 过去含糊的 `"default"` 标签现在在 CLI/`--help`/VS Code/JetBrains 中**明确显示为 "Manual"**，表达「人类批准是出厂基线」的契约。既有 `"defaultMode": "default"` / `--permission-mode default` 作为兼容别名仍有效，但建议迁移到 `"manual"`。
> - 触发原因：Anthropic 遥测显示旧默认下 **93% 的权限提示是被反射性批准**（approval fatigue）。此改动把出厂默认从 human-on-the-loop 拉回 human-in-the-loop。
> - **CI/无人值守影响**：Manual 模式在 headless 环境会**卡在无法满足的批准提示**。CI 需显式设置 `--permission-mode acceptEdits`/`bypassPermissions` 或用 `permissions.allow` 预授权。
>
> `bypassPermissions` 模式禁用绝大多数权限检查，仅在容器/VM 等隔离环境使用。管理员可通过 managed settings 设置 `disableBypassPermissionsMode: "disable"` 阻止此模式。

### 7.3 权限规则配置

权限在 `settings.json` 中配置，三个规则数组：

```json
{
  "permissions": {
    "allow": ["Read", "Bash(npm run *)", "Bash(git status)"],
    "ask": [],
    "deny": ["Bash(rm -rf *)", "Bash(sudo *)", "Bash(curl * | bash)"]
  }
}
```

**评估顺序：** `deny`（最高优先级）→ `ask` → `allow`。第一个匹配的规则生效。无匹配时使用默认行为（写/执行操作需确认，读操作自动允许）。

### 7.4 权限规则语法

**基本匹配：**

| 规则 | 效果 |
|------|------|
| `Bash` | 匹配所有 Bash 命令 |
| `WebFetch` | 匹配所有 web fetch 请求 |
| `Read` | 匹配所有文件读取 |
| `Bash(*)` | 等同于 `Bash`，匹配所有 |

**带参数的精确匹配：**

| 规则 | 效果 |
|------|------|
| `Bash(npm run build)` | 精确匹配 `npm run build` |
| `Read(./.env)` | 匹配读取当前目录的 `.env` |
| `WebFetch(domain:example.com)` | 匹配对 example.com 的请求 |

**通配符模式（Bash 专用）：**

| 规则 | 效果 |
|------|------|
| `Bash(npm run *)` | 匹配以 `npm run ` 开头的命令 |
| `Bash(git * main)` | 匹配如 `git checkout main`, `git merge main` |
| `Bash(* --version)` | 匹配以 `--version` 结尾的命令 |
| `Bash(* --help *)` | 匹配包含 `--help` 的命令 |

> 空格+`*` 的区别：`Bash(ls *)` 匹配 `ls -la` 但不匹配 `lsof`；`Bash(ls*)` 两者都匹配。

**Read/Edit 路径规则（遵循 gitignore 规范）：**

| 模式 | 含义 | 示例 |
|------|------|------|
| `//path` | 文件系统绝对路径 | `Read(//Users/alice/secrets/**)` |
| `~/path` | 主目录路径 | `Read(~/Documents/*.pdf)` |
| `/path` | 项目根目录相对路径 | `Edit(/src/**/*.ts)` |
| `path` 或 `./path` | 当前目录相对路径 | `Read(*.env)` |

> `*` 匹配单目录内文件，`**` 递归匹配所有子目录。

**MCP 工具规则：**

| 规则 | 效果 |
|------|------|
| `mcp__puppeteer` | 匹配 puppeteer 服务器的所有工具 |
| `mcp__puppeteer__*` | 通配符匹配所有工具（等效） |
| `mcp__puppeteer__screenshot` | 匹配特定工具 |

**Agent（子代理）规则：**
- `Agent` 匹配所有子代理调用
- `Agent(explore)` 匹配特定子代理类型

### 7.5 权限配置位置

| 位置 | 作用域 | 可共享 |
|------|--------|--------|
| `~/.claude/settings.json` | 所有项目（用户级） | 否，本机 |
| `.claude/settings.json` | 单个项目 | 是，可提交到版本控制 |
| `.claude/settings.local.json` | 单个项目（本地） | 否，不提交 |
| 企业管理设置 | 组织级 | 由 IT/DevOps 管理 |

**优先级：** 企业管理 > 用户级 > 项目级

### 7.6 用户确认交互

当工具调用需要权限时，Claude Code 在终端显示确认提示，用户可以：
- **Allow once** — 批准此次操作
- **Allow always** — 将此工具模式加入会话 allowlist（会话内持久）
- **Deny** — 拒绝操作

### 7.7 内置安全保护

- **命令黑名单：** 默认拒绝 `curl`、`wget`（防数据泄露）、`npx`（任意包执行）、`rm -rf` 关键路径
- **写入限制：** 默认只能写入启动目录及其子目录，不能修改父目录文件
- **Shell 操作符保护：** 防止通过管道、重定向等进行命令注入
- **命令注入检测：** 可疑 bash 命令即使之前被 allowlist 也需手动确认
- **Fail-closed 匹配：** 未匹配的命令默认需要手动确认

---

## 8. Hook 系统

Hooks 是用户定义的 shell 命令、HTTP 端点或 LLM prompt，在 Claude Code 生命周期的特定点自动执行。与 CLAUDE.md 指令不同（Claude 可能选择忽略），Hooks 是**确定性的**——条件满足时必定执行。

### 8.1 Hook 事件（20+ 个）

> 注：Hook 事件数量随版本持续增加，以官方 [hooks reference](https://code.claude.com/docs/en/hooks) 为准。下表为当前已知事件。

官方按**触发节律**把事件分三类，配置前先想清楚你要的是哪一档：

| 节律 | 事件 |
|------|------|
| 每会话一次 | `SessionStart`、`SessionEnd` |
| 每轮一次 | `UserPromptSubmit`、`Stop`、`StopFailure` |
| 每次工具调用 | `PreToolUse`、`PostToolUse` |

| 事件 | 触发时机 | 可否阻止操作 |
|------|----------|-------------|
| `SessionStart` | 会话开始或恢复时（v2.1.214 起 fork 起始的会话上报 source 为 `"fork"` 而非 `"resume"`） | 否 |
| `Setup` | 仓库初始化 / 维护操作（配合 `--init` / `--maintenance`） | — |
| `InstructionsLoaded` | CLAUDE.md 或 rules 文件加载到上下文时 | 否 |
| `DirectoryAdded` | **v2.1.219 新增**：`/add-dir`（或 SDK 的 `register_repo_root` 控制请求）在会话中途注册新工作目录后 | 否 |
| `UserPromptSubmit` | 用户提交 prompt 后，Claude 处理前 | 是 |
| `PreToolUse` | 工具调用执行前 | 是（可 block） |
| `PermissionRequest` | 权限对话框将要出现、或本该自动拒绝一个无法提示的调用时 | 是（可自动决策） |
| `PostToolUse` | 工具调用成功后 | 否 |
| `PostToolUseFailure` | 工具调用失败后 | 否 |
| `MessageDisplay` | 助手文本渲染前（可改写或隐藏，v2.1.152+） | — |
| `Notification` | Claude Code 发送通知时 | 否 |
| `SubagentStart` | 子代理启动时 | 否 |
| `SubagentStop` | 子代理完成时 | 否 |
| `Stop` | Claude 完成响应时 | 是 |
| `StopFailure` | 一轮以失败收尾时 | — |
| `TeammateIdle` | 团队代理空闲时 | 是 |
| `TaskCompleted` | 任务标记完成时 | 是 |
| `ConfigChange` | 配置文件变更时 | 是 |
| `WorktreeCreate` | 创建 worktree 时 | 替换默认 git 行为 |
| `WorktreeRemove` | 移除 worktree 时 | — |
| `PreCompact` | 上下文压缩前 | 是（exit code 2 或 `{"decision":"block"}` 可阻止压缩，v2.1.105+） |
| `PostCompact` | 上下文压缩后（v2.1.76+） | — |
| `SessionEnd` | 会话终止时 | — |

**三个容易踩空的边界（都是官方明写的）：**

- **`@` 引用的文件不触发任何 hook。** 你在 prompt 里写 `@src/foo.ts`，Claude Code 是在
  **构造 prompt 时直接把内容插进去**的，没有工具调用发生——所以连匹配 `Read` 的 `PreToolUse`
  也不会响。要挡住特定路径被 `@` 读到，只能用 `Read` 的 **deny 权限规则**，不能靠 hook。
- **`EndConversation` 完全绕开 hook 层**：`PreToolUse`、`PostToolUse`、`PermissionRequest` 三者对它都不触发。
- **`PreToolUse` 与 `PermissionRequest` 的触发面不同**：前者在**每次**工具调用前跑（不管要不要权限），
  后者只在真要问你、或本该自动拒绝时跑。

> **v2.1.141+ 新增 `terminalSequence` 输出字段**：Hook JSON 输出可携带 `terminalSequence`，让 hook 在无控制终端时也能发出桌面通知、窗口标题、响铃等终端转义序列。
>
> ⚠️ **v2.1.214 破坏性变更（`if:` 条件的路径匹配）**：单段的 `dir/` 形式现在**只匹配 `<cwd>/dir`**，
> 要任意深度匹配得写成 `/dir/`。注意 `deny` / `ask` **权限规则**保持原来的任意深度语义——
> 两套匹配规则从此不再一致，混着用容易以为自己挡住了其实没挡住。
>
> **v2.1.218 安全加固**：agent frontmatter 里定义的 hooks 现在要求**该 agent 文件自身所在目录**
> 已接受 workspace trust，防止从不受信目录带进来的 agent 文件顺手执行 hook。

### 8.2 Hook 配置格式

三层嵌套结构：选择事件 → 添加 matcher 过滤 → 定义 handler

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": ".claude/hooks/block-rm.sh",
            "timeout": 5
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [
          {
            "type": "command",
            "command": "npx prettier --write $FILE_PATH"
          }
        ]
      }
    ],
    "Stop": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "notify-send 'Claude done'"
          }
        ]
      }
    ]
  }
}
```

### 8.3 Hook 类型

| 类型 | 说明 |
|------|------|
| `command` | Shell 命令，通过 stdin 接收 JSON 输入，stdout 返回 JSON 输出 |
| `http` | HTTP POST 端点，请求体为 JSON，响应体为 JSON |
| `prompt` | LLM prompt，让 Claude 评估并返回决策 |
| `agent` | 启动代理执行复杂逻辑 |

### 8.4 Hook 配置位置

| 位置 | 作用域 | 可共享 |
|------|--------|--------|
| `~/.claude/settings.json` | 所有项目 | 否，本机 |
| `.claude/settings.json` | 单个项目 | 是，可提交 |
| `.claude/settings.local.json` | 单个项目（本地） | 否 |

### 8.5 Hook I/O 协议

**输入（stdin / POST body）：** JSON 载荷，包含通用字段和事件特定字段

```json
{
  "session_id": "abc-123",
  "tool_name": "Bash",
  "tool_input": {
    "command": "rm -rf /tmp/build"
  },
  "cwd": "/path/to/project"
}
```

**输出（退出码控制）：**

| 退出码 | 含义 |
|--------|------|
| 0 | 允许/通过 |
| 2 | 阻止/拒绝 |
| 其他非零 | 错误，工具调用继续但显示警告 |

**PreToolUse 决策输出示例：**

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "Destructive command blocked by hook"
  }
}
```

### 8.6 Hook 实际示例

**阻止危险 rm 命令：**

```bash
#!/bin/bash
# .claude/hooks/block-rm.sh
COMMAND=$(jq -r '.tool_input.command')
if echo "$COMMAND" | grep -q 'rm -rf'; then
  jq -n '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "Destructive command blocked by hook"
    }
  }'
else
  exit 0  # allow
fi
```

**文件编辑后自动格式化：**

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [
          {
            "type": "command",
            "command": "npx prettier --write \"$TOOL_INPUT_FILE_PATH\""
          }
        ]
      }
    ]
  }
}
```

### 8.7 PreToolUse 高级控制

PreToolUse 是最强大的 hook 事件，支持三种决策结果和工具参数修改：

**三种决策输出：**

| 决策 | 效果 |
|------|------|
| `allow` | 跳过交互式权限提示（但不覆盖 deny 规则） |
| `deny` | 阻止工具调用 |
| `ask` | 升级为用户确认 |

**修改工具参数（`updatedInput`）：**

PreToolUse hook 可以在执行前修改工具参数，模型不会感知到变更：

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow",
    "updatedInput": {
      "command": "echo '[REDACTED]' && original-safe-command"
    }
  }
}
```

适用场景：路径纠正、密钥脱敏、参数注入等。

**注意：** `allow` 决策不会覆盖权限规则。如果 deny 规则匹配了工具调用，即使 hook 返回 `allow`，调用仍会被阻止。如果 ask 规则匹配，用户仍会被提示确认。

### 8.8 其他事件的决策控制

不同事件使用不同的决策模式：

| 事件类型 | 决策字段 | 可用值 |
|----------|----------|--------|
| `PreToolUse` | `hookSpecificOutput.permissionDecision` | `allow` / `deny` / `ask` |
| `PostToolUse`, `Stop`, `SubagentStop`, `ConfigChange` | 顶层 `decision` | `"block"` |
| `PermissionRequest` | `hookSpecificOutput.decision.behavior` | 自定义行为 |
| `UserPromptSubmit` | `additionalContext` | 注入文本到 Claude 上下文 |

**Stop hook 阻止结束示例：**
```json
{
  "decision": "block",
  "reason": "Test suite must pass before proceeding"
}
```

### 8.9 异步 Hook

支持后台运行的异步 hook，不阻塞主流程：

```json
{
  "hooks": [
    {
      "type": "command",
      "command": "run-tests.sh",
      "async": true
    }
  ]
}
```

### 8.10 Prompt-based Hook

使用 LLM 评估的 hook，适合复杂的多条件判断。使用 `$ARGUMENTS` 占位符传递上下文：

```json
{
  "hooks": [
    {
      "type": "prompt",
      "prompt": "Evaluate if this tool call is safe. Consider: 1) Does it modify critical files? 2) Could it cause data loss? Return allow or deny with reasoning."
    }
  ]
}
```

### 8.11 Agent Hook

Agent hook 是最重量级的 handler 类型，启动子代理进行多轮代码库验证：

```json
{
  "hooks": [
    {
      "type": "agent",
      "prompt": "Verify that all modified files have corresponding test coverage",
      "description": "Check test coverage",
      "subagent_type": "Explore",
      "model": "sonnet"
    }
  ]
}
```

Agent hook 可访问 Read、Grep、Glob 等工具，适合深度验证场景（如确认所有修改的文件都有对应的测试覆盖）。这是其他 AI 编程工具没有的独特能力。

### 8.12 Hook 实战模式

**GitButler 团队的自动化工作流：**

GitButler 团队使用 `PreToolUse` + `PostToolUse` + `Stop` hook 组合实现：
- 自动暂存文件变更
- 自动创建新 commit
- 将不同 Claude 会话的工作隔离到不同分支

**推荐的三个入门 Hook：**

| Hook | 事件 | 用途 |
|------|------|------|
| 自动格式化 | `PostToolUse`（matcher: `Write\|Edit`） | 每次文件编辑后运行 prettier/eslint |
| 危险命令拦截 | `PreToolUse`（matcher: `Bash`） | 阻止 `rm -rf`、`git reset --hard` 等 |
| 桌面通知 | `Stop` | Claude 完成时发送系统通知 |

**自动测试链：**

```json
{
  "hooks": {
    "PostToolUse": [{
      "matcher": "Edit|Write",
      "hooks": [
        { "type": "command", "command": "npx prettier --write \"$TOOL_INPUT_FILE_PATH\"" },
        { "type": "command", "command": "python scripts/auto_test.py" }
      ]
    }]
  }
}
```

**多代理文件锁协调（Redis）：**

使用 PreToolUse hook + Redis 实现多代理并行时的文件锁机制，防止多个代理同时编辑同一文件。

### 8.13 Hook 调试技巧

- 运行 `/hooks` 确认 hook 出现在正确的事件下
- Matcher 是**大小写敏感**的，确保精确匹配工具名
- 区分事件类型：`PreToolUse` 在工具执行前触发，`PostToolUse` 在执行后触发
- `PermissionRequest` hook 在非交互模式（`-p`）下不触发，应改用 `PreToolUse`
- 手动测试 hook 脚本：`echo '{"tool_name":"Bash","tool_input":{"command":"test"}}' | your-hook.sh`

---

## 9. 记忆系统（CLAUDE.md + Auto Memory）

Claude Code 有两套互补的记忆机制，都在每次对话开始时加载。

### 9.1 CLAUDE.md 文件

由用户编写的 markdown 文件，给 Claude 提供持久化指令。

**文件位置与优先级（从高到低）：**

| 作用域 | 位置 | 用途 | 共享方式 |
|--------|------|------|----------|
| 企业管理策略 | macOS: `/Library/Application Support/ClaudeCode/CLAUDE.md`<br>Linux: `/etc/claude-code/CLAUDE.md`<br>Windows: `C:\Program Files\ClaudeCode\CLAUDE.md` | 组织级指令 | IT/DevOps 管理 |
| 项目指令 | `./CLAUDE.md` 或 `./.claude/CLAUDE.md` | 团队共享的项目指令 | 版本控制 |
| 用户指令 | `~/.claude/CLAUDE.md` | 个人偏好 | 仅本机 |

**加载规则：**
- 工作目录上方的 CLAUDE.md 文件在启动时完整加载
- 子目录中的 CLAUDE.md 按需加载（当 Claude 读取该目录的文件时）
- 更具体的位置优先于更广泛的位置

**导入语法：**
```markdown
See @README for project overview and @package.json for available npm commands.

# Additional Instructions
- git workflow @docs/git-instructions.md
- @~/.claude/my-project-instructions.md
```
- 支持相对路径和绝对路径，相对路径基于包含导入的文件解析
- 递归导入最大深度 5 层
- 首次遇到外部导入时显示审批对话框

**编写建议：**
- 目标 200 行以内（过长消耗上下文且降低遵循度）
- 使用 markdown 标题和列表组织结构
- 写具体可验证的指令（"使用 2 空格缩进" 而非 "格式化代码"）
- 避免矛盾规则（Claude 可能随机选择一个）
- 过大时用 `@import` 或 `.claude/rules/` 拆分

**`/init` 命令：**
- 分析代码库自动生成 CLAUDE.md
- 发现构建命令、测试指令、项目约定
- 已有 CLAUDE.md 时建议改进而非覆盖

### 9.2 项目规则（.claude/rules/）

将指令拆分为主题文件，支持路径特定规则：

```
.claude/rules/
├── testing.md          # 测试规范
├── api-standards.md    # API 标准
└── frontend/*.md       # 前端特定规则
```

- **路径特定规则：** 可以限定规则只在特定文件类型或子目录生效
- **跨项目共享：** 支持通过符号链接共享规则文件
- **用户级规则：** `~/.claude/rules/*.md` 对所有项目生效

### 9.3 Auto Memory

Claude 自动记录的学习笔记，无需用户手动编写。

- **存储位置：** `~/.claude/projects/<project-hash>/memory/MEMORY.md`
- **工作方式：** Claude 根据用户的纠正和偏好自动保存笔记
- **加载：** 每次会话开始时加载前 200 行
- **内容：** 构建命令、调试洞察、用户偏好、项目模式
- **管理：** `/memory` 命令查看和编辑，可启用/禁用
- 子代理也可以维护自己的 auto memory

### 9.4 两者对比

| | CLAUDE.md | Auto Memory |
|---|-----------|-------------|
| 谁写 | 用户 | Claude |
| 内容 | 指令和规则 | 学习和模式 |
| 作用域 | 项目/用户/组织 | 按工作树 |
| 加载 | 每次会话完整加载 | 每次会话前 200 行 |
| 用途 | 编码标准、工作流、架构 | 构建命令、调试洞察、偏好 |

---

## 10. MCP 协议集成

### 10.1 概述

Claude Code 作为 MCP 客户端，连接一个或多个 MCP 服务器来扩展能力。MCP（Model Context Protocol）是 AI 工具集成的开放标准，基于 JSON-RPC 2.0。

### 10.2 连接生命周期

```
1. Claude Code 启动 MCP 服务器（stdio 子进程 / HTTP 连接 / SSE 连接）
2. 客户端发送 initialize 请求（协议版本 + 能力）
3. 服务器响应能力声明（tools/resources/prompts）
4. 客户端发送 notifications/initialized 确认
5. 客户端调用 tools/list, resources/list, prompts/list 发现功能
6. 对话中，Claude Code 调用 tools/call 执行服务器工具
```

支持 `list_changed` 通知——MCP 服务器发送 `notifications/tools/list_changed` 时，Claude Code 自动刷新可用能力。

### 10.3 三种传输方式

**HTTP（推荐的远程传输）：**
```bash
claude mcp add --transport http <name> <url>

# 示例
claude mcp add --transport http notion https://mcp.notion.com/mcp

# 带认证头
claude mcp add --transport http secure-api https://api.example.com/mcp \
  --header "Authorization: Bearer your-token"
```

**SSE（已弃用，用 HTTP 替代）：**
```bash
claude mcp add --transport sse <name> <url>
```

**stdio（本地进程服务器）：**
```bash
claude mcp add [options] <name> -- <command> [args...]

# 示例
claude mcp add --transport stdio --env AIRTABLE_API_KEY=YOUR_KEY airtable \
  -- npx -y airtable-mcp-server
```

> 选项顺序重要：所有 flags 必须在服务器名称之前。`--` 分隔服务器名称和传递给 MCP 服务器的命令/参数。

### 10.4 MCP 三大原语

**Tools（工具）：** AI 可调用的可执行函数
```json
{
  "name": "get_weather",
  "description": "Get current weather for any location",
  "inputSchema": {
    "type": "object",
    "properties": {
      "location": { "type": "string" }
    },
    "required": ["location"]
  }
}
```

**Resources（资源）：** 通过 `@` 提及引用的数据源
- 格式：`@server:protocol://resource/path`
- 支持订阅变更监控

**Prompts（提示）：** 作为 slash 命令暴露的可复用模板
- 格式：`/mcp__servername__promptname`
- 可接受参数

### 10.5 配置作用域

| 作用域 | 存储位置 | 用途 |
|--------|----------|------|
| `local`（默认） | `~/.claude.json` 项目路径下 | 个人/实验性，敏感凭证 |
| `project` | `.mcp.json`（版本控制） | 团队共享 |
| `user` | `~/.claude.json`（全局） | 跨项目个人工具 |

### 10.6 项目级 .mcp.json 格式

```json
{
  "mcpServers": {
    "shared-server": {
      "command": "/path/to/server",
      "args": [],
      "env": {}
    },
    "api-server": {
      "type": "http",
      "url": "${API_BASE_URL:-https://api.example.com}/mcp",
      "headers": {
        "Authorization": "Bearer ${API_KEY}"
      }
    }
  }
}
```

环境变量展开：`${VAR}` 和 `${VAR:-default}` 语法，支持在 `command`, `args`, `env`, `url`, `headers` 中使用。

### 10.7 管理命令

```bash
claude mcp list              # 列出所有服务器
claude mcp get <name>        # 查看服务器详情
claude mcp remove <name>     # 移除服务器
claude mcp add-from-claude-desktop  # 从 Claude Desktop 导入
/mcp                         # 交互模式中检查状态
```

### 10.8 MCP Tool Search

当 MCP 工具描述超过上下文窗口 10% 时自动启用，工具按需加载。通过 `ENABLE_TOOL_SEARCH` 环境变量控制。

**Tool Search 的 Token 优化效果：**

分析显示 Tool Search 可节省高达 **46.9%** 的 MCP 相关 token 消耗。原理：
- 不启用时：所有 MCP 工具定义在每次 API 请求中发送
- 启用后：仅发送工具摘要索引，模型按需请求具体工具定义
- 对于拥有大量 MCP 工具的项目（如同时连接 Notion、GitHub、Sentry 等），效果尤为显著

**手动管理 MCP 服务器以节省上下文：**

```
/mcp                          # 查看所有 MCP 服务器状态和 token 消耗
@server-name disable          # 禁用不需要的服务器
/context                      # 查看 MCP 工具定义占用的上下文比例
```

### 10.9 关键环境变量

| 变量 | 功能 | 默认值 |
|------|------|--------|
| `MCP_TIMEOUT` | 服务器启动超时（ms） | — |
| `MAX_MCP_OUTPUT_TOKENS` | 每次工具调用最大输出 token | 25000（10000 时警告） |
| `ENABLE_TOOL_SEARCH` | 控制工具搜索行为 | `auto` |

### 10.10 Claude Code 作为 MCP 服务器

```json
{
  "mcpServers": {
    "claude-code": {
      "type": "stdio",
      "command": "claude",
      "args": ["mcp", "serve"]
    }
  }
}
```

### 10.11 MCP 协议核心方法

| 方法 | 方向 | 用途 |
|------|------|------|
| `initialize` | Client → Server | 建立连接，交换能力 |
| `tools/list` | Client → Server | 发现可用工具 |
| `tools/call` | Client → Server | 调用工具 |
| `resources/list` | Client → Server | 列出可用资源 |
| `resources/read` | Client → Server | 读取资源内容 |
| `resources/subscribe` | Client → Server | 监控资源变更 |
| `prompts/list` | Client → Server | 发现可用提示 |
| `prompts/get` | Client → Server | 获取提示详情 |
| `notifications/tools/list_changed` | Server → Client | 工具已变更 |
| `notifications/initialized` | Client → Server | 初始化完成 |

### 10.12 OAuth 认证

支持 OAuth 2.1 用于 HTTP 传输：

```json
{
  "mcpServers": {
    "my-server": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "oauth": {
        "clientId": "your-client-id",
        "callbackPort": 8080,
        "authServerMetadataUrl": "https://auth.example.com/.well-known/openid-configuration"
      }
    }
  }
}
```

---

## 11. 子代理系统（Subagents）

### 11.1 概述

子代理是专门化的 AI 助手，处理特定类型的任务。每个子代理运行在独立的上下文窗口中，拥有自定义 system prompt、特定工具访问权限和独立权限。

### 11.2 内置子代理

| 子代理 | 模型 | 工具 | 用途 |
|--------|------|------|------|
| **Explore** | Haiku（快速低延迟） | 只读工具（禁止 Write/Edit） | 文件发现、代码搜索、代码库探索 |
| **Plan** | 继承主对话 | 只读工具 | 计划模式下的代码库研究 |
| **general-purpose** | 继承主对话 | 所有工具 | 复杂研究、多步操作、代码修改 |
| **Bash** | 继承主对话 | — | 在独立上下文中运行终端命令 |
| **statusline-setup** | Sonnet | — | 配置状态栏 |
| **Claude Code Guide** | Haiku | — | 回答关于 Claude Code 功能的问题 |

**Explore 子代理：** 调用时指定彻底程度 `quick`/`medium`/`very thorough`，保持探索结果不污染主对话上下文。

**嵌套子代理——这条在一个月里翻了两次，按时间读才不会搞错：**

| 时间 | 版本 | 状态 |
|------|------|------|
| 早期 | — | 禁止：子代理不能再启动子代理 |
| 2026.6 release train | — | GA：支持嵌套（配套 fallback models、marketplace 同批 GA） |
| 2026-07-21 | v2.1.217 | ⚠️ **破坏性回退**：默认**又不再**嵌套，要靠 `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` 显式放开 |
| 2026-07-24 | v2.1.219 | **恢复默认深度 3**；`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=1` 可关掉嵌套 |

**并发与总量上限（v2.1.217 / v2.1.224）：**

- **并发上限 20**（v2.1.217 新增），`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` 覆盖。
  目的是防"一条消息就 fan out 出无界后台代理"。
- **每会话 200 个子代理的启动总量上限已移除**（v2.1.224），并发与深度上限仍在。
- **stream-json 转发**（v2.1.211 / v2.1.219）：`--forward-subagent-text` 或
  `CLAUDE_CODE_FORWARD_SUBAGENT_TEXT` 可把子代理的正文与 thinking 一并输出；
  v2.1.219 起 depth-2+ 的嵌套子代理也会出现，按其 spawning Agent 的 `tool_use` id 归组。

### 11.3 自定义子代理

**定义位置：**

| 位置 | 作用域 |
|------|--------|
| `~/.claude/agents/<name>.md` | 用户级（所有项目） |
| `.claude/agents/<name>.md` | 项目级 |
| 插件中的 agents 目录 | 插件级 |

**子代理文件格式（Markdown + YAML frontmatter）：**

```markdown
---
name: code-reviewer
description: Reviews code and suggests improvements
model: sonnet
tools:
  - Read
  - Glob
  - Grep
color: blue
---

You are a code review specialist. When reviewing code:
1. Check for readability issues
2. Identify performance bottlenecks
3. Suggest best practice improvements
```

**Frontmatter 字段：**

| 字段 | 说明 |
|------|------|
| `name` | 子代理名称 |
| `description` | 描述（Claude 据此决定何时委派） |
| `model` | 使用的模型 |
| `tools` | 可用工具列表 |
| `color` | UI 背景色 |
| `permissionMode` | 权限模式 |
| `skills` | 预加载的 skills |
| `hooks` | 子代理专用 hooks |
| `memory` | 是否启用持久记忆 |

### 11.4 子代理运行模式

- **前台运行：** 默认，需要结果后才能继续
- **后台运行：** `run_in_background: true`，完成后通知
- **Worktree 隔离：** `isolation: "worktree"`，在独立 git worktree 中运行
- **可恢复：** 通过 `resume` 参数恢复之前的子代理

### 11.5 子代理与 Agent Teams 对比

| | 子代理（Subagents） | Agent Teams |
|---|---------------------|-------------|
| 上下文 | 独立上下文窗口；结果返回给调用者 | 独立上下文窗口；完全独立运行 |
| 通信 | 仅向主代理报告结果 | 队友之间直接发消息 |
| 协调 | 主代理管理所有工作 | 共享任务列表 + 自协调 |
| 适用场景 | 聚焦任务，只需要结果 | 需要讨论和协作的复杂工作 |
| Token 成本 | 较低：结果摘要返回主上下文 | 较高：每个队友是独立的 Claude 实例 |
| 嵌套 | 默认深度 3（v2.1.219 起，见上表） | 队友之间可以互相通信 |

> **三者别混为一谈（Anthropic 自己也强调过这点）**：**子代理**是执行形态，
> **Agent Teams** 是协调模型，**ultracode / Dynamic Workflows** 是会话级策略 + 确定性编排壳。
> 详见 §20.6 的三方对比。

### 11.6 Agent Teams（实验性功能）

Agent Teams 是 2026 年 2 月发布的实验性多代理协作功能，允许多个 Claude Code 会话协同工作。

**启用方式：**

```json
// .claude/settings.json
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"
  }
}
```

**四大组件：**

| 组件 | 职责 |
|------|------|
| **Team Lead（团队领导）** | 主 Claude Code 会话，创建团队、分配任务、综合结果 |
| **Teammates（队友）** | 独立的 Claude Code 实例，各自拥有独立上下文窗口 |
| **Shared Task List（共享任务列表）** | 所有代理可见的中央工作队列，支持任务状态（pending/in_progress/completed）和依赖关系 |
| **Mailbox（邮箱）** | 代理间直接通信的消息系统，通过 `SendMessage` 工具发送 |

**存储位置：**
```
~/.claude/teams/{team-name}/config.json    # 团队配置
~/.claude/tasks/{team-name}/               # 任务列表
```

**跨会话消息（v2.1.224 新增，macOS / Linux）：**

`SendMessage` 与新增的 `ListAgents`（用于发现收件人）现在**可以跨会话**工作，
不再局限于同一个 team 内。两个配套设置：`crossSessionInbound`（是否接收外部会话来信）、
`dialogExpiry`。

⚠️ 安全上有一道闸：**v2.1.222 起 `SendMessage` 在派发到其他 agent 会话前会先跑一次权限分类器**。
另外 v2.1.224 修掉了"写入收件人 inbox 失败却仍报 Message sent"的假成功——投递失败现在如实报错。

**使用示例：**

```
Create an agent team to refactor the payment module. Spawn three teammates:
one for the API layer, one for the database migrations, one for test coverage.
Have them coordinate through the shared task list.
```

**显示模式：**

| 模式 | 说明 |
|------|------|
| `tmux` | 每个代理在独立的 tmux 面板中运行（推荐，可实时观察） |
| `tmux -CC`（iTerm2） | iTerm2 原生集成 |
| `in-process` | 所有代理输出在单个对话线程中 |

配置方式：`"teammateMode": "tmux"` 或 `claude --teammate-mode in-process`

**指定队友模型：**

```
Create a team with 4 teammates to refactor these modules in parallel.
Use Sonnet for each teammate.
```

团队领导可以使用更强（更贵）的模型（如 Opus），队友使用更便宜的模型（如 Haiku/Sonnet），类似真实工程团队的分层结构。

**要求计划审批：**

```
Spawn an architect teammate to refactor the authentication module.
Require plan approval before they make any changes.
```

**Agent Teams 的最佳实践：**

- 队友能独立工作在明确范围的任务上时效果最好——"实现这 5 个 API 端点" 优于 "给我构建一个应用"
- 从研究和审查任务开始，再扩展到跨层功能和大型重构
- 每个队友加载相同的项目上下文（CLAUDE.md、MCP 服务器、skills），但不继承领导的对话历史
- 任务文件和 `SendMessage` 是唯一的协调通道——没有共享内存
- Token 消耗显著高于单会话，因为每个队友是独立的 Claude 实例，且队友间的通信会产生额外开销

**Agent Teams 适用场景：**

| 适合 | 不适合 |
|------|--------|
| 多层功能开发（前端+后端+测试） | 简单的单文件修改 |
| 大型代码重构 | 需要紧密耦合的顺序操作 |
| 并行研究 + 实现 | Token 预算有限的场景 |
| 竞争性调试假设验证 | 任务间高度依赖 |
| 多视角代码审查 | |

### 11.7 并行 Worktree 开发模式

利用 git worktree + 子代理实现真正的并行开发：

**基本工作流：**

```bash
# 终端 1
claude -w feature-payments
# 终端 2
claude -w feature-auth
# 终端 3
claude -w bugfix-payments
```

每个终端运行完全独立的 Claude Code 会话，互不干扰。

**并行竞争模式（AI Imagines）：**

利用 LLM 的非确定性特性，让多个代理同时实现同一规格：

1. 编写详细的功能规格/计划
2. 使用 `git worktree add` 创建多个隔离副本
3. 在每个 worktree 中启动 Claude Code 代理
4. 所有代理独立实现同一规格
5. 比较结果，合并最佳版本

每个代理会产生不同的有效解决方案，从 3-5 个版本中选择最佳实现。

**自定义并行命令示例（`.claude/commands/exe-parallel.md`）：**

```markdown
# Parallel Task Execution
## Variables
PLAN_TO_EXECUTE: $ARGUMENTS
NUMBER_OF_PARALLEL_WORKTREES: $ARGUMENTS

## Instructions
创建 N 个子代理，每个在独立 worktree 中并行实现同一功能。
每个代理完成后在 worktree 根目录写入 RESULTS.md。
```

**状态跟踪：**

```
.agent-status/
├── task-api.json    # {"status": "COMPLETE", "summary": "..."}
└── task-ui.json
.worktrees/
├── task-api/        # 代理 1 的工作空间
│   └── RESULTS.md
└── task-ui/         # 代理 2 的工作空间
    └── RESULTS.md
```

### 11.8 子代理最佳实践

**角色链模式（Product Spec → Architect → Implementer/Tester）：**

使用子代理和 hooks 构建可重复的软件流水线：
- **PM Spec 代理：** 细化需求，生成验收标准
- **Architect 代理：** 审查架构，标记潜在冲突
- **Implementer/Tester 代理：** 实现代码并编写测试

**Skills 与子代理的结合：**

在子代理的 frontmatter 中使用 `skills:` 字段预加载专业知识：

```markdown
---
name: api-developer
description: Implement API endpoints following team conventions
skills:
  - api-conventions
  - error-handling-patterns
---
```

**安全并行化：**

- 仅在不相交的模块/文件上并行运行子代理
- Architect 代理标记潜在冲突
- Implementer 代理列出触及的路径
- Hook 可在两个任务触及相同目录时发出警告

---

## 12. 上下文窗口管理

### 12.1 窗口大小

| 模型 | 上下文窗口 |
|------|-----------|
| 标准（Haiku 4.5 等） | 200,000 tokens（~150,000 词） |
| Opus 5 / Opus 4.8 / Sonnet 5 / Fable 5 | 1,000,000 tokens（标准定价，无长上下文附加费） |

> Opus 5 的 1M **既是默认也是上限**，官方称在整个窗口内指令遵循、工具调用与推理质量保持一致。
>
> ⚠️ **v2.1.223 起 `CLAUDE_CODE_DISABLE_1M_CONTEXT=1` 会把所有原生 1M 模型按住在 200K**
> （靠 auto-compaction 实现，压不住时有启动告警），不再只约束一份固定清单。

### 12.2 上下文消耗

所有内容都计入上下文限制：对话历史、读取的文件内容、工具调用结果、System prompt、CLAUDE.md 内容、MCP 工具定义。

> Claude Code **不会**预先索引代码库，而是按需使用工具（Grep/Glob/Read）读取文件。

### 12.3 自动压缩（Auto-Compaction）

- 当上下文使用率达到约 **75-95%** 时自动触发
- 预留安全缓冲区
- 触发时，Claude 将对话历史总结为精简摘要
- `PreCompact` hook 事件在压缩前触发，允许注入保留指令

**Auto-Compact 触发阈值演进：**

早期版本在上下文使用率达到 ~95% 时才触发，导致频繁出现"中途压缩"问题（在重构进行到一半、功能实现到关键步骤时被迫压缩）。新版本改进：

| 版本 | 触发阈值 | 效果 |
|------|----------|------|
| 早期 | ~90-95% | 经常在操作中途触发，打断工作流 |
| 当前 | ~64-75%（推测） | 更早触发，留出"完成缓冲区" |

**完成缓冲区（Completion Buffer）：**

Claude Code 现在内置了"完成缓冲区"——在触发 auto-compact 前给任务留出足够空间完成当前操作。这意味着：
- 不再在重构进行到一半时被迫压缩
- 模型有更多空闲上下文进行推理（研究表明上下文填满时性能显著下降）
- 会话可以更长时间保持高质量输出

**环境变量控制：**

```json
{
  "env": {
    "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE": "50"
  }
}
```

将 auto-compact 触发阈值设为 50%，更激进地压缩以节省 token。

**上下文预留分配（`/context` 输出示例）：**

```
MCP 工具定义:     26.5K tokens (13.3%)
自定义代理:       2.8K tokens
CLAUDE.md:        4K tokens
Auto-compact 预留: ~22%
System prompt:    ~32.9K tokens（基线开销，用户输入前已消耗）
```

### 12.4 手动压缩

```
/compact                          # 手动触发压缩
/compact focus on auth errors     # 指定保留重点
```

**战略性压缩决策树：**

```
完成了研究/探索？
  → YES: /compact（清除研究上下文）
  → NO: 继续

里程碑完成（功能完成、测试通过）？
  → YES: /compact（清除后开始下一个功能）
  → NO: 继续

调试完成？
  → YES: /compact（清除调查上下文）
  → NO: 继续

失败的方案，尝试新方向？
  → YES: /compact（清除失败尝试）
  → NO: 继续

正在实现中？
  → 不要压缩（保留工作上下文）
```

### 12.5 上下文管理策略

| 策略 | 说明 |
|------|------|
| Plan Mode | 先规划再执行，可减半 token 消耗 |
| 子代理 | 独立上下文窗口，防止主对话膨胀 |
| `/compact` | 手动压缩，可指定保留重点 |
| `/clear` | 完全清除对话历史 |
| 精确文件读取 | 使用 `offset`/`limit` 参数只读取需要的部分 |
| 禁用未用 MCP | 每个 MCP 服务器的工具定义都消耗上下文，用 `/mcp` 禁用不需要的 |
| CLAUDE.md 精简 | 保持 CLAUDE.md 简洁聚焦，避免重复的背景说明 |
| 子代理模型降级 | 使用 `CLAUDE_CODE_SUBAGENT_MODEL=haiku` 降低子代理成本 |

### 12.6 Token 优化配置

**推荐的成本优化设置：**

```json
{
  "model": "sonnet",
  "env": {
    "MAX_THINKING_TOKENS": "10000",
    "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE": "50",
    "CLAUDE_CODE_SUBAGENT_MODEL": "haiku"
  }
}
```

| 设置 | 默认 | 推荐 | 影响 |
|------|------|------|------|
| `model` | opus | sonnet | ~60% 成本降低 |
| `MAX_THINKING_TOKENS` | 无限制 | 10000 | 减少思考 token 消耗 |
| `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` | ~75% | 50% | 更早压缩，节省 token |
| `CLAUDE_CODE_SUBAGENT_MODEL` | 继承主模型 | haiku | 子代理使用更便宜的模型 |
| `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` | 20（v2.1.217 起） | 视预算下调 | 封住"一条消息 fan out 出一片后台代理"的账单 |
| `/effort` 档位 | Opus 系列 `high` | 简单任务降到 `low`/`medium` | ⭐ **Opus 5 上这是最主要的成本旋钮** |

> ⚠️ **Opus 5 上省钱的着力点换了地方。** 它与 Opus 4.8 同价（$5/$25），
> 但 **thinking 默认开启、effort 即思考深度**——同一张价目表下，两个团队的账单可以差出很远，
> 差别全在 effort 怎么设。以前"选便宜的模型"是主要杠杆，现在**"给合适的任务配合适的 effort"**才是。
> 另外 v2.1.221 起 auto-mode 权限检查会复用缓存的对话前缀，分类器本身的 prompt-cache 成本已下降。

**1M 上下文（API/Max 计划）的优势：**

- 可以加载整个代码库而无需激进分块
- 大规模操作可以在整个工作流中保持上下文
- 长开发对话无需频繁重置上下文
- 但仍建议遵循良好实践，因为上下文越大推理质量可能下降

### 12.7 上下文消耗来源

| 来源 | 加载时机 | 影响 |
|------|----------|------|
| System prompt | 每次请求 | 固定小成本，始终存在 |
| CLAUDE.md 文件 | 会话开始 | 每次请求完整内容（但 prompt 缓存后仅首次请求付全价） |
| 工具定义 | 每次请求 | 每个工具添加其 schema；可用 MCP Tool Search 按需加载 |
| 对话历史 | 逐轮累积 | 随每轮增长：prompt、响应、工具输入、工具输出 |
| Skill 描述 | 会话开始 | 短摘要；完整内容仅在调用时加载 |

---

## 13. Git 集成与安全协议

### 13.1 Commit 工作流

Claude Code 直接在用户终端执行真实 git 命令，没有隐藏的抽象层。完整流程：

1. 运行 `git status` 查看所有未跟踪和已修改文件（**永远不用 `-uall` 标志**，避免大仓库内存问题）
2. 运行 `git diff` 查看暂存和未暂存的变更
3. 运行 `git log` 读取最近的 commit 消息，**匹配仓库现有的 commit message 风格**
4. 语义分析所有变更，起草 commit message（总结变更性质：新功能/增强/修复/重构等）
5. 按文件名逐个暂存（**优先 `git add <specific files>` 而非 `git add -A` 或 `git add .`**，避免意外包含 `.env`、凭证等敏感文件）
6. 使用 HEREDOC 创建 commit 确保格式正确：

```bash
git commit -m "$(cat <<'EOF'
Commit message here.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

7. commit 后运行 `git status` 验证成功

### 13.2 PR 创建工作流

1. 并行运行：`git status`、`git diff`、检查远程跟踪、`git log` + `git diff [base-branch]...HEAD`
2. 分析**所有** commit（不仅是最新的），起草 PR 标题（<70 字符）和描述
3. 必要时创建新分支，`git push -u` 推送，使用 `gh pr create` 创建 PR：

```bash
gh pr create --title "the pr title" --body "$(cat <<'EOF'
## Summary
<1-3 bullet points>

## Test plan
[Bulleted markdown checklist of TODOs...]

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

### 13.3 Git 安全协议（硬性规则）

**绝对禁止（NEVER）：**
- 更新 git config
- `git push --force`（尤其是 main/master，会警告用户）
- `git reset --hard`（除非用户明确要求）
- `--no-verify`（跳过 hooks，除非用户明确要求）
- `--no-gpg-sign` / `-c commit.gpgsign=false`（除非用户明确要求）
- `git rebase -i` / `git add -i`（交互模式不支持）
- `git checkout .` / `git restore .` / `git clean -f` / `git branch -D`（除非用户明确要求）
- 未经用户明确要求就 commit
- 未经用户明确要求就 push

**Amend vs New Commit 协议（关键）：**
- **始终创建新 commit** 而非 amend，除非用户明确要求
- 当 pre-commit hook 失败时，commit **没有发生**——此时 `--amend` 会修改**上一个** commit，可能破坏工作
- Hook 失败后：修复问题 → 重新暂存 → 创建**新** commit

### 13.4 Code Review

Claude Code Review（2026 年 3 月发布）是专用的多代理代码审查系统：

- PR 打开时，派遣**多个并行代理**，每个专注不同类别（逻辑错误、bug、安全漏洞）
- 代理在**完整代码库上下文**中检查 diff，不仅是变更行
- 超过 **1000 行**的大变更分配多个代理
- 发现经过**验证步骤过滤误报**
- 确认的问题按**严重程度排序**
- 结果以**统一摘要评论 + 行内评论**形式出现在 PR 上

### 13.5 Merge Conflict 处理

- 运行 `git merge` 或 `git rebase`
- 读取冲突文件，理解冲突标记（`<<<<<<<`, `=======`, `>>>>>>>`）
- 在代码库上下文中分析双方变更
- 编辑文件移除冲突标记，写入正确的合并内容
- **当双方语义都正确但需要选择时，询问用户**而非自行决定
- 解决后暂存文件，可 commit 合并

### 13.6 Worktree 支持

原生 git worktree 支持（2026 年 2 月发布）：

- `claude --worktree <name>` 创建隔离分支和目录 `.claude/worktrees/<name>/`
- 每个代理获得独立的文件系统状态，互不干扰
- worktree 是完整的独立工作副本：可编辑文件、运行测试、安装包
- 所有 worktree 共享相同的仓库历史和远程连接
- 子代理也支持 worktree 进行并行代码迁移和批量变更
- **v2.1.221 起 `/fork` 出的会话会开自己的 worktree**，不再在原会话的 checkout 里干活

**关键配置（`settings.json`）：**

| 键 | 说明 | 默认 |
|----|------|------|
| `worktree.baseRef` | 新 worktree 从哪个 ref 分叉。`"fresh"` 从 `origin/<default-branch>`（干净、对齐远端）；`"head"` 从当前本地 HEAD（带上未推送的提交与特性分支状态） | `"fresh"` |
| `worktree.symlinkDirectories` | 从主仓库软链进每个 worktree 的目录，避免大目录重复占盘 | 无 |
| `worktree.bgIsolation` | 后台会话的隔离模式。`"worktree"` 会在调用 `EnterWorktree` 前**封住主 checkout 的 Edit/Write** | `"none"` |

⚠️ **worktree 隔离曾三次漏水，都是同一类问题——隔离只盖住了一部分动作：**

| 版本 | 漏点 |
|------|------|
| v2.1.210 | worktree 隔离的子代理能对**主仓库 checkout** 跑改动 git 状态的命令 |
| v2.1.216 | 同类漏点：子代理可用 `git -C` / `GIT_DIR` 把 git 重定向回共享 checkout |
| v2.1.222 | 收口：**隔离现在覆盖所有会话类型的文件编辑与 Bash**，破坏性 git 命令打不到主 checkout |

同批还修了 `PreToolUse` 的 auto-allow hook 在后台代理任务（摘要、压缩、重命名）里**绕过工具限制**的问题。
如果你依赖 worktree 隔离做并行开发，v2.1.222 是值得升上去的最低版本。

### 13.7 Checkpoint 系统

- 每次变更前自动创建代码状态快照
- `Esc + Esc`（双击 Escape）打开回退菜单
- `/rewind` 命令回退到之前的状态
- 可选择恢复代码、对话或两者

---

## 14. 会话管理与持久化

### 14.1 会话存储

- 会话以 JSON 格式保存到磁盘
- 存储位置：`~/.claude/projects/<project-hash>/sessions/`
- 每个会话有唯一 UUID
- 包含完整的消息历史、工具调用记录、元数据

### 14.2 会话操作

| 操作 | 方式 |
|------|------|
| 继续最近会话 | `claude -c` 或 `claude --continue` |
| 恢复指定会话 | `claude -r <session-id>` 或 `claude --resume <id-or-name>` |
| 分叉会话 | `/fork [name]` 或 `--fork-session` |
| 重命名会话 | `/rename [name]` |
| 导出会话 | `/export [filename]` |
| 禁用持久化 | `--no-session-persistence`（headless 模式） |
| 指定会话 ID | `--session-id <uuid>` |
| 从 PR 恢复 | `--from-pr <number>` |

### 14.3 会话跨平台

- 会话不绑定单一界面，可在终端、桌面应用、Web、移动端之间切换
- Remote Control 允许从浏览器控制本地 Claude Code
- `/teleport` 将远程会话拉到本地终端
- `/desktop` 将终端会话交给桌面应用

### 14.4 后台任务

- `Ctrl+B` 将当前任务放到后台
- 后台任务完成后自动通知
- `Ctrl+F` 终止所有后台代理（双击确认）
- 可在 Claude 工作时排队输入消息

### 14.5 会话存储格式（JSONL）

会话以 JSONL 格式存储，路径编码规则：`/` 替换为 `-`。

**存储路径：**
```
~/.claude/projects/<encoded-project-path>/<session-uuid>.jsonl
```

例如 `/Users/alice/Code/my-project` 编码为 `-Users-alice-Code-my-project`（路径分隔符换成 `-`）。

**全局索引：** `~/.claude/history.jsonl`，每行一个 JSON 对象：
```json
{
  "display": "user's input text",
  "pastedContents": {},
  "timestamp": 1762916565315,
  "project": "/Users/xxx/project-path",
  "sessionId": "8c00f575-88f3-46dc-812b-712b6bb7152a"
}
```

**会话 JSONL 消息类型：**

文件历史快照：
```json
{
  "type": "file-history-snapshot",
  "messageId": "uuid",
  "snapshot": {
    "trackedFileBackups": {},
    "timestamp": "2026-03-11T03:24:15.961Z"
  }
}
```

用户消息：
```json
{
  "parentUuid": null,
  "type": "user",
  "cwd": "/path/to/project",
  "sessionId": "uuid",
  "version": "2.1.72",
  "gitBranch": "master",
  "message": { "role": "user", "content": "user's message text" },
  "uuid": "uuid",
  "timestamp": "ISO-8601",
  "permissionMode": "default"
}
```

助手消息：
```json
{
  "parentUuid": "parent-uuid",
  "type": "assistant",
  "message": {
    "content": [{"text": "...", "type": "text"}],
    "id": "msg_xxx",
    "model": "claude-opus-5",
    "role": "assistant",
    "stop_reason": "end_turn",
    "usage": {
      "cache_creation_input_tokens": 15198,
      "cache_read_input_tokens": 53104,
      "input_tokens": 783,
      "output_tokens": 256
    }
  },
  "uuid": "uuid",
  "timestamp": "ISO-8601"
}
```

工具调用结果：
```json
{
  "parentUuid": "parent-uuid",
  "type": "user",
  "message": {
    "role": "user",
    "content": [{
      "tool_use_id": "tooluse_xxx",
      "type": "tool_result",
      "content": "tool output text",
      "is_error": false
    }]
  }
}
```

**会话附属目录：**
```
~/.claude/projects/<path>/<session-uuid>/
├── subagents/              # 子代理对话日志
│   ├── agent-<id>.jsonl
│   └── agent-<id>.meta.json
└── tool-results/           # 大型工具输出外部存储
    └── <hash>.txt
```

### 14.6 文件历史与 Checkpoint

```
~/.claude/file-history/<session-uuid>/
└── <file-hash>@v1, @v2, @v3...   # 文件版本快照
```

每次文件修改前自动保存版本快照，支持通过 `Esc+Esc` 或 `/rewind` 回退到任意版本。

---

## 15. IDE 集成

### 15.1 VS Code 扩展

- 原生图形界面集成到侧边栏
- 打开方式：侧边栏图标 或 `Ctrl+Shift+P` → "Claude Code: Open Panel"
- 交互式 diff 查看（Source Control 面板）
- 选区上下文共享——Claude 看到打开的文件和光标位置
- 计划模式的完整 markdown 文档视图（支持评论）
- 原生 MCP 服务器管理对话框
- 压缩显示为可折叠的 "Compacted chat" 卡片
- Tab 图标徽章：蓝色（待权限确认）、橙色（未读完成）
- 会话重命名和删除操作
- Effort level 指示器
- `vscode://anthropic.claude-code/open` URI handler（支持 `prompt` 和 `session` 查询参数）
- 原生插件管理 + OAuth 用户的远程会话浏览（v2.1.16+）
- 任务管理系统（带依赖追踪，v2.1.16 替换旧 todo 流程）
- 兼容 VS Code、Cursor、Trae 等 VS Code 系 IDE

### 15.2 JetBrains 插件

- 支持 IntelliJ IDEA、PyCharm、WebStorm 等 JetBrains IDE
- 使用 IDE 原生 diff 查看器的交互式 diff
- 选区上下文共享
- 代码变更的审查/接受流程
- 从 IDE 内部编排 CLI

### 15.3 Desktop App

- 独立桌面应用（macOS/Windows）
- 可视化 diff、并行会话、内嵌预览
- PR 监控、内置连接器
- 从终端通过 `/desktop` 切换

### 15.4 Chrome 扩展（Beta）

- `claude --chrome` 启用 Chrome 浏览器集成
- 支持 Web 自动化和测试

---

## 16. SDK 与 Headless 模式

### 16.1 Headless 模式（`-p` / `--print`）

非交互模式，处理单个 prompt 后输出结果并退出。Agent SDK 提供与 Claude Code 相同的工具、agent loop 和上下文管理能力，可作为 CLI 脚本或 Python/TypeScript 包使用。

```bash
# 基本用法
claude -p "explain this function"

# 管道输入
cat logs.txt | claude -p "explain these errors"

# JSON 输出
claude -p "query" --output-format json

# 流式 JSON（实时 token 流）
claude -p "query" --output-format stream-json --verbose --include-partial-messages

# 限制轮次和预算
claude -p --max-turns 3 --max-budget-usd 5.00 "query"

# 跳过权限（CI/CD 隔离环境）
claude -p --dangerously-skip-permissions "query"

# 自定义系统提示
claude -p --system-prompt "You are a reviewer" "review this code"

# 限制工具访问
claude -p --allowedTools "Read,Grep,Glob" "analyze this codebase"

# 多轮会话自动化（通过 session 恢复）
session=$(claude -p "Start analysis" --output-format json | jq -r '.session_id')
claude --resume "$session" "Continue with step 2"
claude --resume "$session" "Finalize and report"
```

> Headless 模式默认最多执行 10 轮 agentic 迭代，可通过 `--max-turns` 调整。超过 60% 的高级 Claude Code 用户使用 headless 模式自动化代码审查、测试生成和文档任务。

### 16.2 输出格式

| 格式 | 说明 | 适用场景 |
|------|------|----------|
| `text` | 纯文本输出（默认） | 人类阅读、简单脚本 |
| `json` | 结束时输出单个 JSON 结果对象（含 `result`、`session_id`、元数据） | 自动化解析、CI/CD |
| `stream-json` | 实时流式 NDJSON 事件（每行一个 JSON 对象） | 实时反馈、进度监控 |

**stream-json 过滤示例：**

```bash
# 使用 jq 过滤文本 delta，实时显示流式文本
claude -p "Explain recursion" --output-format stream-json --verbose --include-partial-messages \
  | jq -rj 'select(.type == "content_block_delta") | .delta.text // empty'
```

**双向流式通信（`--input-format stream-json`）：**

通过 stdin 发送 NDJSON 消息实现程序化双向通信，是 CLI 中唯一的程序化双向通信机制。

### 16.3 结构化输出

```bash
# 使用 JSON Schema 获取结构化输出
claude -p --json-schema '{"type":"object","properties":{...}}' "query"
```

### 16.4 Agent SDK

> **⚠️ 已改名（重要）**：原「Claude Code SDK」已更名为 **「Claude Agent SDK」**，包名随之变更。旧包名 `claude_code_sdk` / `@anthropic-ai/claude-code-sdk` 已弃用，迁移见官方 [migration guide](https://platform.claude.com/docs/en/agent-sdk/migration-guide)。

Claude Agent SDK 用于构建自定义代理：
- **Python SDK**：`claude-agent-sdk`（导入 `claude_agent_sdk`）
- **TypeScript SDK**：`@anthropic-ai/claude-agent-sdk`
- 完全控制编排、工具访问和权限
- 支持 MCP 集成
- 提供与 Claude Code 相同的 agent loop、工具和上下文管理

**SDK 消息类型：**

Agent loop 运行时产生五种核心消息类型：

| 类型 | 说明 |
|------|------|
| `SystemMessage`（subtype: `init` / `compact_boundary`） | 会话初始化或压缩边界 |
| `AssistantMessage` | Claude 的响应（文本 + 工具调用） |
| `UserMessage` | 用户输入或工具结果 |
| `StreamEvent` | 流式事件（token delta 等） |
| `ResultMessage`（subtype 标识完成原因） | 最终结果 |

**Turn 和预算控制：**

一个 turn 是 loop 内的一次往返：Claude 产生包含工具调用的输出 → SDK 执行工具 → 结果反馈给 Claude。Turn 持续直到 Claude 产生不含工具调用的输出。

```python
# Python SDK 示例（claude-agent-sdk）
from claude_agent_sdk import query, ClaudeAgentOptions

options = ClaudeAgentOptions(
    max_turns=10,
    allowed_tools=["Read", "Grep", "Glob"],
)
async for message in query(prompt="Find all API endpoints in this project", options=options):
    print(message)
```

### 16.5 CI/CD 集成

**GitHub Actions（`anthropics/claude-code-action@v1`）：**

Claude Code GitHub Action 在 GitHub Actions runner 中运行完整的 Claude Code 运行时（不是简单的 API 调用），拥有完整的工具使用、文件读取和多步推理能力。

**自动化代码审查工作流：**

```yaml
# .github/workflows/claude-review.yml
name: Claude Code Review
on:
  pull_request:
    types: [opened, synchronize]
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - name: Claude Review
        uses: anthropics/claude-code-action@v1
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          prompt: |
            Review this PR for potential issues:
            - Security vulnerabilities
            - Performance problems
            - Code style violations
          claude_args: "--max-turns 5"
```

**支持的触发器：**
- `pull_request`（opened/synchronize/ready_for_review/reopened）
- Issue comments（`@claude` 触发）
- `workflow_dispatch`（手动触发，支持自定义输入）

**自动实现 Issue 功能：**

Claude Code Action 可以自动读取 issue 描述，实现功能，创建分支并提交 PR。

**CI/CD 中的 CLAUDE.md：**

```markdown
## CI/CD Context
When running in GitHub Actions:
- Do not modify configuration files unless explicitly asked
- Always create a new branch for changes, never commit directly to main
- Format PR comments using GitHub-flavoured Markdown
- Include file paths as clickable links in review comments
```

**GitLab CI / Jenkins 集成：**

```yaml
# GitLab CI 示例
image: node:20
stages: [setup, run]
variables:
  ANTHROPIC_API_KEY: $ANTHROPIC_API_KEY
setup:
  stage: setup
  script:
    - npm install -g @anthropic-ai/claude-code
run:
  stage: run
  script:
    - claude -p "Review latest changes and flag risky patterns" --output-format json
```

**CI/CD 最佳实践：**
- ⚠️ **v2.1.200 起默认 Manual 权限模式会卡 headless 流水线**：过去依赖「摄入 prompt 即自主执行」的管道现在会停在无法应答的批准提示。CI 必须显式 `--permission-mode acceptEdits`（或隔离环境 `bypassPermissions`），或用 `permissions.allow` 预授权所需工具。
- ⚠️ **AskUserQuestion 不再自动 continue**：无人值守下任何澄清提问会无限期阻塞。用系统提示词抑制提问、预授权让其不触发，或在 `/config` 设 `askUserQuestionTimeout`。
- 使用 `--max-turns` 限制迭代次数，防止无限循环
- 使用 `--max-budget-usd` 设置成本上限
- 使用 `--allowedTools` 限制工具访问（CI 中通常只需 Read/Grep/Glob）
- 使用 `--output-format json` 获取结构化输出便于解析
- 某些环境可能需要交互式登录（`/login`），此时应改用 API/Agent SDK 方式；或用 `CLAUDE_CODE_OAUTH_TOKEN`

---

## 17. 安全与沙箱

### 17.1 安全基础

- 默认严格只读权限
- 需要额外操作时请求明确许可
- 所有 bash 命令执行前需要审批
- 透明且安全的设计

### 17.2 内置保护

| 保护措施 | 说明 |
|----------|------|
| 沙箱化 Bash | 文件系统和网络隔离，减少权限提示 |
| 写入限制 | 只能写入启动目录及其子目录 |
| 权限疲劳缓解 | 支持按用户/代码库/组织 allowlist 常用安全命令 |
| Accept Edits 模式 | 批量接受编辑，同时保持命令的权限提示 |
| 命令黑名单 | 默认阻止 `curl`、`wget` 等可获取任意内容的命令 |
| 命令注入检测 | 过滤反引号和 `$()` 构造，可疑命令即使在 allowlist 中也需手动确认 |
| Fail-closed 匹配 | 未匹配命令默认需要手动确认 |
| Shell 操作符感知 | `Bash(safe-cmd *)` 不会允许 `safe-cmd && malicious-cmd` |

### 17.3 Auto Mode（AI 权限分类器）

**发布与演进：** 2026 年 3 月 24 日首发（Research Preview）；至年中已无需 `--enable-auto-mode` flag，可直接在权限模式中选择。

**⚠️ 关键节点：**
- **v2.1.200（2026-07-03）**：`auto` **不再是出厂默认**——默认权限模式改为 "Manual"（人类批准为基线，见 §7.2）。
- **v2.1.207（2026-07-11）**：在 **Bedrock / Vertex AI / Microsoft Foundry** 上 auto mode **默认开启**，无需 opt-in 环境变量；关闭需设 `disableAutoMode`。该键**不再从项目级 `.claude/settings.local.json` 读取**（防止仓库内配置篡改治理决策），只认用户级 `~/.claude/settings.json` 或 managed settings。同版本这些平台的默认模型也改为 Opus 4.8。
- 企业加固：`autoMode` 分类器规则同样不从共享项目设置读取；`autoMode.classifyAllShell`（v2.1.193）可把所有 shell 命令都过分类器。

**问题背景：** Anthropic 内部数据显示用户批准了 93% 的权限提示。大多数人在长会话中不再认真阅读提示，而是机械地点击"批准"——这比让 AI 分类器做决策更危险。

**工作原理：**

Auto Mode 在代理和执行之间插入一个后台 AI 分类器：

```
工具调用请求 → AI 分类器评估风险 → 安全：自动执行
                                   → 危险：阻止，重定向 Claude 采取其他方案
                                   → 持续被阻止：触发用户权限提示
```

**分类器可见信息：**

| 可见 | 不可见 |
|------|--------|
| 用户消息 | 文件内容 |
| 工具调用名称和参数 | 之前的工具结果 |
| 项目指令（CLAUDE.md） | |

**分类器规则类别：**

| 类别 | 说明 | 示例 |
|------|------|------|
| 自动允许 | 只读操作、不修改状态的 GET 请求 | `git status`、`cat file` |
| 自动阻止 | 大规模文件删除、敏感数据泄露、恶意代码执行 | `rm -rf /`、`curl secrets \| nc` |
| 预防性阻止 | 检测到代理在为被阻止的操作做侦察 | 用只读操作探测后尝试删除 |

**配置 Auto Mode 分类器：**

```json
{
  "autoMode": {
    "environment": [
      "Source control: github.example.com/acme-corp",
      "Trusted cloud buckets: s3://acme-build-artifacts"
    ],
    "allow": [
      "Deploying to staging is allowed: staging is isolated and resets nightly"
    ],
    "soft_deny": [
      "Never run database migrations outside the migrations CLI",
      "Never modify files under infra/terraform/prod/"
    ]
  }
}
```

**与其他权限模式的关系：**

| 模式 | 安全性 | 便利性 | 适用场景 |
|------|--------|--------|----------|
| `default` | 最高 | 最低 | 高安全环境、初次使用 |
| `acceptEdits` | 高 | 中 | 信任的原型开发 |
| `auto` | 中高 | 高 | 日常开发、长任务 |
| `bypassPermissions` | 最低 | 最高 | 仅限隔离容器/VM |

**局限性：**
- 分类器无法看到文件内容或之前的工具结果，可能被多步攻击绕过
- 恶意的项目指令（poisoned CLAUDE.md）可能影响分类器判断
- 风险降低但不消除，仍建议在隔离环境中工作

### 17.4 沙箱（Sandbox）

通过 `/sandbox` 命令启用 OS 级隔离：

**权限 vs 沙箱的区别（纵深防御）：**

| 层面 | 权限系统 | 沙箱 |
|------|----------|------|
| 作用范围 | 所有工具（Bash、Read、Edit、WebFetch、MCP） | 仅 Bash 命令及其子进程 |
| 检查时机 | 工具运行前 | 命令实际执行时 |
| 问题 | "这个工具应该运行吗？" | "如果运行了，它能访问什么？" |

**沙箱模式：**

| 模式 | 说明 | 适用场景 |
|------|------|----------|
| `auto-allow` | 沙箱内的 Bash 命令自动允许，无法沙箱化的命令回退到权限流程 | 日常开发（推荐） |
| `regular` | 所有 Bash 命令仍需权限审批，但执行时受沙箱限制 | 高安全环境 |

> Anthropic 内部数据：沙箱减少了 84% 的权限提示，同时维持安全性。

**文件系统隔离配置：**

```json
{
  "sandbox": {
    "filesystem": {
      "allowWrite": ["/tmp/build-output"],
      "denyWrite": ["/etc", "/usr"],
      "allowRead": ["/usr/local/lib"],
      "denyRead": ["~/.ssh", "~/.aws"]
    }
  }
}
```

**网络隔离配置：**

```json
{
  "sandbox": {
    "network": {
      "allowedDomains": ["registry.npmjs.org", "api.github.com"],
      "strictAllowlist": true
    }
  }
}
```

**`network.strictAllowlist`（v2.1.219 新增）**：不在 allowlist 里的主机**直接拒绝，不弹提示**。
默认行为是拦下后问你，这个开关把"问"变成"拒"——无人值守场景下这才是你要的那个语义。

**`filesystem.disabled`（v2.1.216 新增）——只关文件系统隔离，保留网络出口管控：**

```json
{
  "sandbox": {
    "filesystem": { "disabled": true },
    "network": { "allowedDomains": ["registry.npmjs.org"] }
  }
}
```

沙箱命令拿到对宿主文件系统的完整读写权，但网络出口仍被 `network.allowedDomains` 圈住。
⚠️ **只从 user / managed / CLI `--settings` 三个来源读取**——刻意不认项目级设置，
避免仓库里塞一行配置就把文件系统隔离关掉。适用于"构建脚本要到处写盘，但绝不能外传"的场景。

**凭据遮蔽（v2.1.224）**：新增 `extract` / `onExtractNoMatch` / `decode: "jwt"` 与
`maskClaims`、`awsPairs`、`sigv4` 等选项，用于在沙箱文件里遮蔽凭据。

**平台支持：**
- macOS：使用 `sandbox-exec` 原生沙箱，开箱即用
- Linux/WSL2：需要安装 `bubblewrap` 和 `socat`
- Docker：`enableWeakerNestedSandbox` 模式允许在 Docker 内运行（安全性较弱）
- Windows 原生：不支持 `/sandbox`，需使用 WSL2

**安全注意事项：**
- 过于宽泛的文件系统写权限可能导致权限提升攻击
- 允许写入 `$PATH` 中的可执行文件目录、系统配置目录或 shell 配置文件（`.bashrc`、`.zshrc`）可能导致代码在不同安全上下文中执行
- Linux 的 `enableWeakerNestedSandbox` 模式显著削弱安全性，仅在有额外隔离保障时使用

**推荐安全配置：**

```json
{
  "permissions": {
    "allow": [
      "Bash(npm run lint)", "Bash(npm run test)", "Bash(npm run build)",
      "Bash(git status)", "Bash(git diff *)", "Bash(git log *)"
    ],
    "deny": [
      "Read(/.env)", "Read(/.env.*)", "Read(/credentials.json)",
      "Read(/*.pem)", "Read(/*.key)",
      "Bash(sudo *)", "Bash(curl *)", "Bash(wget *)", "Bash(rm -rf *)"
    ]
  },
  "env": {
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": 1
  }
}
```

### 17.5 Prompt 注入防护

| 防护 | 说明 |
|------|------|
| 权限系统 | 敏感操作需明确审批 |
| 上下文感知分析 | 通过分析完整请求检测潜在有害指令 |
| 输入清理 | 过滤反引号和 `$()` 构造，防止命令注入 |
| 网络请求审批 | 发起网络请求的工具默认需要用户审批 |
| 隔离上下文窗口 | WebFetch 使用独立小模型处理，避免注入到主上下文 |
| 信任验证 | 首次运行代码库和新 MCP 服务器需要信任验证 |
| URL 限制 | WebFetch 仅限用户提及或项目内的 URL |

### 17.6 凭证管理

- API 密钥和 token 加密存储
- 有限的敏感信息保留期
- 用户控制数据训练偏好

---

## 18. Skills 系统

### 18.1 概述

Skills 扩展 Claude 的能力。创建一个 `SKILL.md` 文件写入指令，Claude 将其加入工具箱。Claude 在相关时自动使用 skill，或用户通过 `/skill-name` 直接调用。

Skills 遵循 Agent Skills 开放标准，Claude Code 在此基础上扩展了调用控制、子代理执行和动态上下文注入。

**Skills 的本质机制：**

当 Claude 调用一个 skill 时，系统执行以下流程：
1. 加载 `SKILL.md` markdown 文件
2. 将其展开为详细指令
3. 作为新的 user messages 注入到对话上下文中
4. 修改执行上下文（允许的工具、模型选择）
5. 在这个增强环境中继续对话

这与传统工具（执行并返回结果）根本不同——Skills **准备 Claude** 去解决问题，而不是直接解决问题。

**Skills vs Tools 对比：**

| | Skills | Tools |
|---|--------|-------|
| 本质 | Prompt 模板注入 | 函数调用 + 返回结果 |
| 执行方式 | 加载指令到上下文 | 执行操作并返回数据 |
| 上下文影响 | 修改 Claude 的行为方式 | 提供外部数据/操作 |
| 触发方式 | 自动匹配或手动 `/` 调用 | 模型决定调用 |

**Skill 工具的元机制：**

在 API 层面，Skills 通过一个名为 `Skill` 的元工具实现。所有可用 skill 的描述被打包到 `Skill` 工具的 description 中发送给模型：

```json
{
  "name": "Skill",
  "description": "Execute a skill...\n\n<available_skills>\n- explain-code: Explains code with visual diagrams...\n- review: Review code changes...\n</available_skills>",
  "input_schema": {
    "properties": {
      "command": { "type": "string", "description": "The skill name" }
    }
  }
}
```

Skill 描述在会话开始时加载（短摘要），完整内容仅在调用时加载，节省上下文。

### 18.2 Skill 文件结构

每个 skill 是一个目录，`SKILL.md` 为入口：

```
my-skill/
├── SKILL.md           # 主指令文件（必需）
├── template.md        # 模板供 Claude 填充
├── examples/
│   └── sample.md      # 示例输出
└── scripts/
    └── validate.sh    # 辅助脚本
```

### 18.3 SKILL.md 格式

```markdown
---
name: explain-code
description: Explains code with visual diagrams and analogies. Use when explaining how code works.
---

When explaining code, always include:
1. **Start with an analogy**: Compare the code to something from everyday life
2. **Draw a diagram**: Use ASCII art to show the flow
3. **Walk through the code**: Explain step-by-step
4. **Highlight a gotcha**: Common mistake or misconception
```

### 18.4 Frontmatter 字段

| 字段 | 说明 |
|------|------|
| `name` | Skill 名称，成为 `/slash-command` |
| `description` | 描述，帮助 Claude 决定何时自动加载（**自动调用的关键字段**） |
| `invocation` | 调用控制：`auto`（Claude 自动）/ `user`（仅用户 `/` 调用） |
| `disable-model-invocation` | 设为 `true` 时禁止 Claude 自动调用，仅允许手动 `/skill-name` |
| `user-invocable` | 是否允许用户通过 `/` 调用 |
| `agent` | 是否在子代理中运行 |
| `context` | 设为 `fork` 时在独立子代理上下文中执行 |
| `tools` / `allowed-tools` | 限制可用工具列表 |
| `model` | 指定使用的模型（如 `sonnet`） |
| `argument-hint` | 参数提示（如 `<issue-number>`） |
| `skills` | 预加载其他 skills（用于子代理） |

### 18.5 自动调用 vs 手动调用

**自动调用（Auto-Invocation）：**

默认模式。Claude 扫描所有可用 Skill 的 `description` 字段，与用户请求进行语义匹配。如果匹配度足够高，自动加载该 Skill。

例如：Skill 描述为 "Use when the user asks to review, check, or audit their code"，用户输入 "can you check this function for me?"，Claude 自动匹配并加载。

> `description` 字段是自动调用的生死关键。模糊的描述会导致 Claude 错过触发或触发错误的 Skill。

**手动调用：**

通过 `/skill-name` 直接调用。适用于部署、提交等不应随意触发的操作。

```markdown
---
name: deploy
description: Deploy the current branch to staging
disable-model-invocation: true
---
```

**建议：** 每个 Skill 只做一件事。不要把代码审查、报告生成、邮件撰写打包到一个 SKILL.md 中。构建独立的 Skills，让 Claude 的发现规则处理路由。

### 18.6 Skill 存储位置

| 位置 | 作用域 | 优先级 |
|------|--------|--------|
| 企业管理设置 | 组织所有用户 | 最高 |
| `~/.claude/skills/<name>/SKILL.md` | 个人（所有项目） | 高 |
| `.claude/skills/<name>/SKILL.md` | 项目级 | 中 |
| 插件中的 skills 目录 | 插件级 | 命名空间隔离 |

同名 skill 优先级：enterprise > personal > project。插件 skill 使用 `plugin-name:skill-name` 命名空间，不冲突。

### 18.7 内置 Skills

| Skill | 功能 |
|-------|------|
| `/simplify` | 审查最近变更的代码，检查复用/质量/效率问题并修复。启动 3 个并行审查代理 |
| `/batch <instruction>` | 大规模并行变更。分解为 5-30 个独立单元，每个在独立 worktree 中执行，各自开 PR |
| `/debug [description]` | 读取会话 debug 日志进行故障排查 |
| `/loop [interval] <prompt>` | 定时循环执行 prompt。如 `/loop 5m check the deploy` |
| `/claude-api` | 加载 Claude API 参考材料。代码导入 anthropic SDK 时自动触发 |
| `/run` / `/verify` | 启动应用并确认改动真的生效（v2.1.145）。⚠️ `/verify` 自 v2.1.215 起仅手动调用 |
| `/deep-research` | 多源联网研究报告（v2.1.154）。⚠️ 自 v2.1.218 起仅手动调用 |
| `/code-review` | 多代理代码审查。v2.1.218 起作为后台子代理运行；自 v2.1.215 起仅手动调用 |

> `disableBundledSkills` 设置 / `CLAUDE_CODE_DISABLE_BUNDLED_SKILLS` 环境变量可整体关掉内置 skills（v2.1.170）。
>
> ⚠️ **v2.1.222 起 Claude 遇到带 `disable-model-invocation` 的 skill 时会被明确告知
> "请用户自己去跑这个 skill"**，而不是自作主张把 skill 的流程复现一遍——这堵住了
> "禁止自动调用"被绕过的一条缝。

### 18.8 动态上下文注入

Skill 可以通过 `@path/to/file` 语法引用支持文件，在 skill 激活时自动加载到上下文。

### 18.9 与 Commands 的关系

- `.claude/commands/deploy.md` 和 `.claude/skills/deploy/SKILL.md` 都创建 `/deploy`
- 现有 `.claude/commands/` 文件继续工作
- Skills 增加了可选功能：支持文件目录、frontmatter 控制、Claude 自动加载
- 同名时 skill 优先
- **历史演进：** Commands 和 Skills 曾是独立系统，现已合并。Skills 是推荐的方式，因为它支持 commands 不具备的功能：
  - 支持文件目录（模板、示例、脚本）
  - Frontmatter 控制（`disable-model-invocation`、`user-invocable`、`allowed-tools`、`context`、`agent`）
  - 动态上下文注入（通过 shell 命令输出）
  - 子代理执行（`context: fork`）

### 18.10 插件系统（Plugins）

插件是 Skills 和 Agents 的打包分发机制：

**插件结构：**
```
my-plugin/
├── marketplace.json    # 插件元数据
├── skills/
│   └── my-skill/
│       └── SKILL.md
└── agents/
    └── my-agent.md
```

**安装方式：**

```bash
# 从市场安装
/plugin marketplace add anthropics/skills
/plugin install skill-creator@anthropics-skills

# 本地加载（开发测试）
claude --plugin-dir ./team-conventions

# 脚手架新插件（v2.1.157+）
claude plugin init
```

> **`.claude/skills` 免市场自动加载（v2.1.157+）**：放在 `.claude/skills` 目录下的插件现在会被自动加载，无需先添加 marketplace 源。
>
> **Skill 描述上限提升（v2.1.171+）**：skill listing 描述上限从 250 字符提升到 **1,536 字符**，超出时启动会告警截断。

插件中的 skills 使用命名空间隔离：`plugin-name:skill-name`（如 `@"team-conventions:migration-agent"`），多个插件可以共存而不冲突。

**插件市场（Marketplace）：**

2026 年 2 月推出的插件市场允许浏览、安装和管理插件：

```
/plugins                              # 查看已安装插件
/plugin marketplace add <source>      # 添加市场源
```

**官方市场：** `anthropics/skills`（内置 skills 如 `frontend-design`、`document-skills`、`context7` 等）

**社区市场：** 如 `alirezarezvani/claude-skills`、`agensi.io` 等第三方市场

**Skill 通过 Hook 自动激活：**

Claude Code 2.1+ 支持在 skill frontmatter 中直接定义 hooks（`PreToolUse`、`PostToolUse`、`Stop`），作用域限定在 skill 的生命周期内。也可以通过外部 hook 脚本基于文件模式自动激活 skill：

```json
// skill-rules.json
{
  "backend-dev-guidelines": {
    "fileTriggers": {
      "pathPatterns": ["src/**/*.ts", "backend/**/*.ts"]
    }
  }
}
```

---

## 19. 配置系统

### 19.1 配置文件层级

| 文件 | 位置 | 作用域 | 共享 |
|------|------|--------|------|
| 企业管理设置 | `/Library/Application Support/ClaudeCode/` (macOS) | 组织级 | IT 管理 |
| 用户设置 | `~/.claude/settings.json` | 所有项目 | 否 |
| 项目设置 | `.claude/settings.json` | 单个项目 | 是（版本控制） |
| 项目本地设置 | `.claude/settings.local.json` | 单个项目 | 否 |

**优先级：** 企业管理 > 项目本地 > 项目 > 用户

### 19.2 settings.json 结构

```json
{
  "permissions": {
    "allow": ["Read", "Bash(npm run *)"],
    "deny": ["Bash(rm -rf *)"],
    "ask": []
  },
  "hooks": {
    "PreToolUse": [...],
    "PostToolUse": [...],
    "Stop": [...]
  },
  "env": {
    "ANTHROPIC_API_KEY": "sk-...",
    "MCP_TIMEOUT": "10000"
  },
  "defaultMode": "default",
  "autoCompact": true,
  "model": "claude-opus-5"
}
```

### 19.3 全局配置文件（~/.claude.json）

存储用户级状态和 MCP 配置，主要字段：

| 字段 | 说明 |
|------|------|
| `numStartups` | 启动次数 |
| `installMethod` | 安装方式 |
| `autoUpdates` | 自动更新 |
| `autoCompactEnabled` | 自动压缩 |
| `mcpServers` | MCP 服务器配置 |
| `projects` | 项目列表 |
| `hasCompletedOnboarding` | 是否完成引导 |
| `userID` | 用户 ID |
| `skillUsage` | Skill 使用统计 |
| `toolUsage` | 工具使用统计 |

### 19.4 目录结构

```
~/.claude/
├── settings.json          # 用户级设置
├── CLAUDE.md              # 用户级指令
├── agents/                # 用户级子代理
│   └── <name>.md
├── skills/                # 用户级 skills
│   └── <name>/SKILL.md
├── rules/                 # 用户级规则
│   └── *.md
├── projects/              # 项目数据
│   └── <project-hash>/
│       ├── sessions/      # 会话数据
│       ├── memory/        # Auto memory
│       │   └── MEMORY.md
│       └── settings.json  # 项目特定设置
├── backups/               # 配置备份
├── file-history/          # 文件历史
├── ide/                   # IDE 集成数据
└── .claude.json           # 全局状态
```

```
<project>/
├── .claude/
│   ├── settings.json      # 项目设置（版本控制）
│   ├── settings.local.json # 项目本地设置（不提交）
│   ├── CLAUDE.md          # 项目指令
│   ├── agents/            # 项目子代理
│   ├── skills/            # 项目 skills
│   ├── commands/          # 自定义命令（兼容）
│   ├── rules/             # 项目规则
│   ├── hooks/             # Hook 脚本
│   └── worktrees/         # Worktree 目录
├── .mcp.json              # MCP 服务器配置（版本控制）
└── CLAUDE.md              # 项目指令（顶层，版本控制）
```

### 19.5 环境变量

| 变量 | 说明 |
|------|------|
| `ANTHROPIC_API_KEY` | Anthropic API 密钥 |
| `CLAUDE_CODE_USE_BEDROCK` | 使用 AWS Bedrock |
| `CLAUDE_CODE_USE_VERTEX` | 使用 Google Vertex AI |
| `ANTHROPIC_BEDROCK_REGION_PREFIX` | Bedrock 区域前缀（v2.1.224 新增） |
| `ANTHROPIC_MODEL` | 默认模型 |
| `MCP_TIMEOUT` | MCP 服务器启动超时 |
| `MAX_MCP_OUTPUT_TOKENS` | MCP 输出 token 限制 |
| `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS` | 长跑 MCP 工具调用自动转后台的阈值（v2.1.212 起默认 2 分钟，可调或禁用） |
| `ENABLE_TOOL_SEARCH` | 工具搜索控制 |
| `CLAUDE_CODE_MAX_OUTPUT_TOKENS` | 最大输出 token |
| `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` | 子代理嵌套深度（v2.1.219 起默认 3，设 1 关闭嵌套） |
| `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` | 并发子代理上限（v2.1.217 起默认 20） |
| `CLAUDE_CODE_FORWARD_SUBAGENT_TEXT` | stream-json 中包含子代理正文与 thinking（v2.1.211） |
| `CLAUDE_CODE_DISABLE_1M_CONTEXT` | 把 1M 模型按住在 200K（⚠️ v2.1.223 起作用于**所有**原生 1M 模型） |
| `CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT` | 关掉对未知 model ID 的窗口约束（v2.1.223） |
| `CLAUDE_CODE_SAFE_MODE` | 禁用所有自定义配置以排障（配套 `--safe-mode`，v2.1.170） |
| `CLAUDE_CODE_DISABLE_BUNDLED_SKILLS` | 禁用内置 skills（配套 `disableBundledSkills` 设置） |
| `CLAUDE_AX_SCREEN_READER` | 屏幕阅读器纯文本模式（配套 `--ax-screen-reader` / `axScreenReader`，v2.1.208） |
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` | 关闭非必要出网流量（同时会禁用 Artifacts 发布） |

---

## 20. 2026 年新功能与生态演进

### 20.1 版本迭代速度

Claude Code 保持极高的迭代频率，几乎每天/每周发布更新。2026 年 1-3 月从 v2.1.63 迭代到 v2.1.76+；到 2026 年 8 月已至 **v2.1.224+**。

节奏有个直观的数字：**7 月 14 日的 v2.1.210 到 8 月 7 日的 v2.1.224，24 天里 15 个版本**，
其中 v2.1.214 一个版本就含 47 条变更、v2.1.216 含 40 条、v2.1.221 含 39 条。
**引用本文任何一节前，先确认它标注的版本号是否还在你的射程内。**

| 时间 | 版本 | 关键更新 |
|------|------|----------|
| 2026-01 | v2.1.16~18 | 依赖追踪任务系统、可定制键位（`/keybindings`） |
| 2026-02 | v2.1.51~59 | `remote-control` 子命令、Auto Memory（`/memory`）、`/copy` |
| 2026-03 | v2.1.76+ | Voice Mode、Remote Control、Agent Teams、Auto Mode、Plugin Marketplace、Scheduled Tasks（Desktop/云端起步） |
| 2026-04 | v2.1.90~105 | `/powerup`、Opus 4.7 + `xhigh` effort、Auto Mode 免 flag、`EnterWorktree` path、PreCompact 可阻止、**Routines 云端定时任务**（`/schedule`，研究预览，2026-04-14） |
| 2026-05 | v2.1.138~157 | **Opus 4.8（05-28）**、**Dynamic Workflows**（`/workflows`，v2.1.154）、Agent View（`claude agents`）、`.claude/skills` 插件自动加载、`claude plugin init`、`/code-review --fix`、`MessageDisplay` hook、`/reload-skills` |
| 2026-06 | v2.1.160~193, v2026.6 | 嵌套子代理 / fallback models / marketplace **GA**、Agent Checkpointing（Beta）、**Fable 5（06-09）**、**Sonnet 5（06-30）**、**Artifacts beta（06-18）**、`[1m]` 别名、workflow 触发词改名 `ultracode`（v2.1.160）、`/cd`、`--safe-mode`、`autoMode.classifyAllShell` |
| 2026-07 上半 | v2.1.196~212 | ⭐ **Manual 默认权限模式（07-03, v2.1.200）**、**AskUserQuestion 不再自动 continue**、`/doctor` 完整体检 + `/checkup`（v2.1.205）、**Bedrock/Vertex/Foundry auto mode 默认开（v2.1.207）**、screen reader 模式（v2.1.208）、Agent 工具间接注入加固 + worktree 隔离修补（v2.1.210）、`--forward-subagent-text`（v2.1.211）、MCP 工具调用 2 分钟自动转后台（v2.1.212） |
| 2026-07 下半 | v2.1.214~220 | **EndConversation 工具（v2.1.214）**、⚠️ `if:` 路径匹配语义变更（v2.1.214）、**`/verify` + `/code-review` 不再自动触发（v2.1.215）**、`sandbox.filesystem.disabled`（v2.1.216）、子代理并发上限 20 + 嵌套先禁后复（v2.1.217/219）、`/code-review` 转后台子代理 + `/deep-research` 仅手动（v2.1.218）、⭐ **Opus 5 成为默认 Opus 模型（07-24, v2.1.219）**、`sandbox.network.strictAllowlist`、**`DirectoryAdded` hook**、`workflowSizeGuideline` |
| 2026-08 | v2.1.221~224 | VS Code **Focus view**（v2.1.221）、⚠️ **移除 `ultraplan`** + worktree 隔离覆盖全会话类型 + `SendMessage` 过权限分类器（v2.1.222）、⚠️ **`/review` 变 `/code-review` 别名** + `CLAUDE_CODE_DISABLE_1M_CONTEXT` 作用域扩大 + workflow 沙箱 `import()` 逃逸修复（v2.1.223）、**跨会话 `SendMessage`/`ListAgents`** + `claude self-hosted-runner` + 插件 `archive` 源（v2.1.224） |

> **五处破坏性变更清单（迁移前逐条核对）：**
>
> | 变更 | 版本 | 谁会被打到 |
> |------|------|-----------|
> | 默认权限模式改 "Manual" | v2.1.200 | headless / CI 会卡在无人应答的批准提示（§7.2） |
> | AskUserQuestion 不再自动推进 | v2.1.200 | 无人值守下任何澄清提问都会无限期阻塞（§3.6） |
> | `if:` 单段 `dir/` 只匹配 `<cwd>/dir` | v2.1.214 | 依赖任意深度匹配的 hook 条件会静默失配（§8.1） |
> | 移除 `ultraplan` | v2.1.222 | 脚本 / 文档里还在调它的地方 |
> | `/review` 变成 `/code-review` 的别名 | v2.1.223 | 期待"快速单遍只读"的自动化流程，现在跑的是完整审查（§4.4） |
>
> 另有一条不算破坏但很容易反向踩坑的：**`CLAUDE_CODE_DISABLE_1M_CONTEXT` 作用域扩大**（v2.1.223）——
> 过去只按固定清单约束，现在**所有**原生 1M 模型都会被压到 200K。原本靠"不在清单里"意外拿到
> 1M 窗口的配置，升级后会突然开始被自动压缩。

### 20.2 定时任务体系（三条并存的路径）

2026 年 Claude Code 把「定时/无人值守」拆成三个共存的系统，边界易混淆：

| 系统 | 运行位置 | 生命周期 | 触发方式 | 适用 |
|------|----------|----------|----------|------|
| **`/loop`（会话内 Cron）** | 本地会话进程 | 关终端即消失；递归任务 3 天后自动删 | `/loop`、`CronCreate`/`CronList`/`CronDelete` | 会话内轮询（等 CI、等部署） |
| **Desktop 定时任务** | 本地机器，每次起新会话 | 持久，App 开着就按时触发，重启后恢复 | Desktop 侧栏 "Schedule" → New task | 本机可视化定时（晨报、周报） |
| **云端 Routines** | Anthropic 托管云 | 持久，电脑关机也跑 | `/schedule`、claude.ai/code/routines、Schedule/API/GitHub 触发 | 无人值守运维（隔夜查 CI、每日 PR 审查） |

#### `/loop`（会话内）

```
/loop 5m check the deploy status    # 每 5 分钟检查部署状态
/loop review new PRs every 2 hours  # 尾随 every 子句
/loop check the build                # 无间隔 → Claude 自定节奏
```

- 底层工具：`CronCreate`（5 字段 cron + prompt）/ `CronList` / `CronDelete`（8 字符 ID）。
- 单会话最多 50 个任务；本地时区解释；`CLAUDE_CODE_DISABLE_CRON=1` 可整体禁用。
- 无补偿执行（Claude 忙时到点只在空闲时补触发一次，不按错过次数累积）；无持久化（重启清空会话级任务）。

#### 云端 Routines（`/schedule`，2026-04-14 研究预览）

- 一条保存的 prompt，在 Anthropic 云上按时/按 API/按 GitHub 事件自主运行，**无人在环**；每次运行从**全新 clone** 起独立隔离会话，完成后回报，可 review 变更并开 PR。
- 三种触发可自由组合：Scheduled（最小 1 小时间隔）/ API / GitHub。
- CLI `/schedule daily PR review at 9am`；自定 cron 用 `/schedule update`。CLI 的 `/schedule` **现创建云端 Routine**（原本地任务不受影响，两套系统并存）。
- 限制（2026-04）：单次最长 2 小时、每工作区并发 100 / 总数 500、产物 500MB；定价镜像 Managed Agents（标准 API 费率 + $0.08/运行小时）。
- 与 Managed Agent（Agent SDK，最长 24h、自建部署）的分工：Routine 面向「定期、规则化、可无人值守提改动」的场景；一次性、需中途操控、无明确输出契约的用 Managed Agent 或本地会话。

### 20.3 Computer Use（远程桌面控制）

2026 年 3 月 23 日发布的 Research Preview，允许 Claude Code 控制远程 Mac 桌面：
- 截屏、点击、输入文本
- 操作 GUI 应用程序
- 适用于需要浏览器交互的测试场景

### 20.4 Voice Mode（语音输入）

通过 `/voice` 命令启用语音输入模式，用语音描述编程需求。

### 20.5 Remote Control（远程控制）

从 claude.ai 或手机控制本地运行的 Claude Code 实例：

```bash
claude remote-control              # 启动远程控制会话
/remote-control [name]             # 交互模式中启用
```

- 允许从任何设备（包括手机）远程指挥本地 Claude Code
- 适合移动办公场景

### 20.6 Dynamic Workflows（动态工作流，v2.1.154+）

2026 年 5 月随 Opus 4.8 一同推出的 Research Preview。它的核心不是"再多一层子代理"，
而是**把编排从模型上下文里搬出来，变成一段真实的 JavaScript**：

> Claude 现场写一个编排脚本 → JS 运行时执行它 → 脚本把工作 fan out 到数十至数百个并行子代理。
> **中间结果活在脚本变量里，不在 Claude 的上下文窗口里**——这才是它能跑过单次对话协调上限的原因。
> 模型做判断，代码做协调；协调那部分**花零个 model token**。

**两个入口（同名不同物，容易混）：**

| 入口 | 效果 | 作用域 |
|------|------|--------|
| prompt 里写 `ultracode` 关键词 | 这**一个任务**跑成 dynamic workflow，不改会话设置 | 单次 |
| `/effort ultracode` | 推理 effort 设为 `xhigh`，**且**此后每个实质任务都自动编排 workflow | 整个会话，新会话重置 |

> 关键词从 v2.1.160 起由 `workflow` 改名为 `ultracode`——所以更早的教程里
> "输入 workflow 就触发"现在不成立了。

**生命周期六段**：规划（Claude 生成 JS 脚本）→ 审批（你看到 phase 列表，可批准/拒绝/查看脚本）
→ fan-out（并发上限 16，单次运行总量上限 1000）→ 验证 → 收敛 → 迭代。
中断可续跑：同脚本 + 同 args 从缓存恢复已完成的 agent 调用，只重跑改过的部分。

**规模指引（v2.1.219 起有默认值了）**：默认 medium 档——**建议单个 workflow 少于 15 个 agent**。
v2.1.202 加了 `/config` 里的档位设置；v2.1.219 新增 `workflowSizeGuideline` 设置键，
让这个建议值可从任意设置文件配置（配了之后 `/config` 那一行会隐藏）。

**可用性**：Max / Team / 符合条件的 Enterprise 计划，以及 Claude API、Bedrock、Vertex AI、Foundry。
⚠️ **Enterprise 默认关闭**，需管理员开启。workflow 内的子代理跑在 `acceptEdits` 模式（内部不再逐次审批）。

⚠️ **v2.1.223 安全修复**：workflow 脚本曾能用动态 `import()` 跑出 workflow 沙箱之外的代码。

**它跟子代理、Agent Teams 的分工（这三个真不是一回事）：**

| | 子代理 | Agent Teams | Dynamic Workflows |
|---|--------|-------------|-------------------|
| 本质 | 执行形态 | 协调模型 | 确定性编排壳 |
| 结构何时定 | 主代理临场决定 | 队友之间实时协商 | **运行前就固定在代码里** |
| 代理间通信 | 不通信，只回报主代理 | 直接互发消息 | **不通信**（结构由脚本决定） |
| 中断后 | — | 会话死了团队就没了 | **可续跑**（进度存盘） |
| 规模 | 一轮 fan-out | 实际 3-5 个队友 | 数十至数百 |
| 何时该用它 | 单次 fan-out 就够 | 需要来回讨论 | **一个阶段的产出决定下一阶段**做什么 |

> 判据一句话：**只要单次 fan-out 就够，就不需要 workflow。**
> 需要它的信号是 fan-out **之后**——上一阶段的结果要决定下一阶段干什么。

**成本提醒**：workflow 的 token 消耗显著高于普通会话（有实测报告 113 个 agent 烧掉 1.95M token）。
先用一个小范围任务标定用量再放大，是官方和社区一致的建议。

### 20.7 Fast Mode（快速模式，Research Preview）

仅 Opus 系列支持的低延迟模式：

- 输出速度约 **2.5×**，牺牲部分质量换取延迟
- CC 内以 `/fast` 切换；API 通过 `speed:"fast"` + `fast-mode-2026-02-01` beta header 启用
- ⚠️ **v2.1.219 起覆盖 Opus 5 与 Opus 4.8，Opus 4.7 已被移除**
- Opus 5 / Opus 4.8 fast 定价 $10/$50 每百万 token（标准价 2 倍）
- Opus 5 的 fast mode **仅在 Claude API 可用**——Bedrock / Google Cloud / Microsoft Foundry 暂不支持
- v2.1.212 起 usage credits 中途用尽会**在流上如实报告**，不再静默失败
- 适合实时聊天、快速摘要等延迟优先场景

### 20.8 Agent Checkpointing（代理检查点，Beta）

区别于会话持久化（只存对话历史），Agent Checkpointing 额外保存**整棵代理树的状态**——每个子代理的进度、中间产物、待处理任务队列，使多小时的迁移任务可暂停后从断点恢复，无需从头重启。Beta 阶段 schema 可能变动，生产使用需 pin CLI 版本。

### 20.9 会话中途的 system 消息与工具变更

**Opus 4.8**：可在会话进行中插入 system 消息，动态调整模型行为。配合 effort 分级（含 `xhigh`），实现更细粒度的运行时控制。

**Opus 5 新增（beta）**：**会话中途更换工具集不会让 prompt cache 失效**。这对 harness 是实打实的省——
过去 MCP 服务器连上/断开、skill 改变可用工具，都要付一次完整的 cache 重建；现在不用了。
另一个同批 beta 是 **API 层自动 fallback**：Opus 5 / Fable 5 上被安全分类器拦下的请求
自动改路由到别的模型（通常是 Opus 4.8），而不是直接返回拒绝。

> **v2.1.201（2026-07-03）调整**：Claude Sonnet 5 会话**不再**用 mid-conversation system role 承载 harness 提醒（CC 内部对 Sonnet 5 改回常规注入方式）——说明该能力在 harness 层按模型差异化启用，并非所有模型都走同一路径。也就是说，实现这类机制时不能假设所有模型都支持会话中途 system 消息，需要按 provider / 模型能力分支。

### 20.10 VS Code 深度集成演进

v2.1.70+ 的 VS Code 集成获得重大升级：
- Activity bar 中的 spark 图标列出所有活跃 Claude Code 会话
- 每个会话作为完整编辑器面板打开
- 计划（Plans）渲染为完整 markdown 文档，支持评论
- MCP 服务器可直接从 `/mcp` 面板管理（启用/禁用/重连/OAuth 认证）
- 终端正在变为可选——VS Code 成为主要交互界面

### 20.11 Dispatch（多代理调度）

Pro 和 Max 用户可用的多代理调度系统，允许同时运行多个 Claude Code 任务并自动协调。结合 Agent View（`claude agents`，Research Preview）可在单一列表查看所有会话——运行中、等待你、已完成。

### 20.12 Analytics API（企业版）

Enterprise 计划提供的分析 API，程序化访问组织内 Claude 和 Claude Code Remote 的使用和参与数据：
- 按组织、按天聚合
- 每个端点返回指定日期的快照

### 20.13 生态定位

Claude Code 的生态定位已从"AI 编程助手"演进为完整的 Agent 平台：

```
编程工具层
├── 内置工具（Read/Write/Edit/Bash/Grep/Glob）
├── MCP 工具（外部服务集成）
└── 自定义工具（Skills/Plugins）

协作层
├── 子代理（独立上下文，火后即忘）
├── Agent Teams（多代理协作，共享任务列表）
└── Worktree 并行（git 隔离的并行开发）

自动化层
├── Hooks（事件驱动的自动化）
├── /loop（定时任务）
├── CI/CD（GitHub Actions 集成）
└── Headless/SDK（程序化控制）

安全层
├── 权限系统（deny/allow/ask）
├── Auto Mode（AI 分类器）
├── 沙箱（OS 级隔离 + 网络 allowlist）
├── Worktree 隔离（文件编辑与 Bash，v2.1.222 起覆盖全会话类型）
└── 信任验证（代码库/MCP/agent 文件首次运行）
```

**2026 年 7-8 月这批版本透出的三条走向**（不是官方表述，是从 changelog 里读出来的）：

1. **控制权在往用户手里挪。** `/verify`、`/code-review`、`/deep-research` 三个都从"Claude 自己判断该跑"
   改成"只在你调用时跑"；默认权限模式从 `auto` 改回 Manual。这类单行变更改的不是能力，
   而是**谁决定何时花钱**。
2. **隔离层在补漏，而且补的都是同一类漏。** worktree 隔离连续三个版本被修（v2.1.210 / 216 / 222），
   每次都是"隔离盖住了一部分动作，另一部分绕过去了"——文件编辑挡住了但 Bash 没挡、
   Bash 挡住了但 `git -C` / `GIT_DIR` 能重定向。到 v2.1.222 才收口为"覆盖所有会话类型的编辑与 Bash"。
   同期还修了 `PreToolUse` auto-allow hook 在后台任务里绕过工具限制、workflow 脚本用
   `import()` 逃出沙箱、权限提示被不可见 Unicode 遮蔽命令。
   **纵深防御的每一层都要单独验证，"某一层有了"不等于"这条路封了"。**
3. **企业治理的键在收紧读取来源。** `disableAutoMode`、`autoMode` 分类器规则、
   `sandbox.filesystem.disabled`、Remote Control 自动启动——这些键**都刻意不从项目级设置读取**，
   只认用户级或 managed settings。逻辑是一致的：**仓库内的一行配置不该能改写治理决策**
   （项目设置仍可用来*关闭*某些能力，只是不能*打开*）。


---

## 参考资料

### 官方文档
- [Claude Code Overview](https://docs.anthropic.com/en/docs/claude-code/overview)
- [Claude Code CLI Reference](https://docs.anthropic.com/en/docs/claude-code/cli-reference)
- [Claude Code Interactive Mode](https://docs.anthropic.com/en/docs/claude-code/interactive-mode)
- [Claude Code Hooks Reference](https://docs.anthropic.com/en/docs/claude-code/hooks)
- [Claude Code Hooks Guide](https://code.claude.com/docs/en/hooks-guide)
- [Claude Code Memory](https://docs.anthropic.com/en/docs/claude-code/memory)
- [Claude Code MCP](https://docs.anthropic.com/en/docs/claude-code/mcp)
- [Claude Code Security](https://docs.anthropic.com/en/docs/claude-code/security)
- [Claude Code Sandboxing](https://code.claude.com/docs/en/sandboxing)
- [Claude Code Permissions](https://docs.anthropic.com/en/docs/claude-code/permissions)
- [Claude Code Skills](https://docs.anthropic.com/en/docs/claude-code/skills)
- [Claude Code Subagents](https://docs.anthropic.com/en/docs/claude-code/subagents)
- [Claude Code Headless Mode](https://code.claude.com/docs/en/headless)
- [Claude Code How It Works](https://code.claude.com/docs/en/how-claude-code-works)
- [Claude Agent Loop (SDK)](https://platform.claude.com/docs/en/agent-sdk/agent-loop)
- [Automatic Context Compaction (Cookbook)](https://platform.claude.com/cookbook/tool-use-automatic-context-compaction)
- [Prompting Best Practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices)

### 逆向工程与深度分析
- [Claude Code System Prompts Collection (GitHub)](https://github.com/Piebald-AI/claude-code-system-prompts)
- [Tracing Claude Code's LLM Traffic (Medium)](https://medium.com/@georgesung/tracing-claude-codes-llm-traffic-agentic-loop-sub-agents-tool-use-prompts-7796941806f5)
- [Claude Code Internals: Reverse Engineering Prompt Augmentation](https://agiflow.io/blog/claude-code-internals-reverse-engineering-prompt-augmentation/)
- [Claude Code Behind-the-scenes of the Master Agent Loop](https://blog.promptlayer.com/claude-code-behind-the-scenes-of-the-master-agent-loop/)

### 功能专题
- [Claude Code Hooks: All 12 Events (2026)](https://www.pixelmojo.io/blogs/claude-code-hooks-production-quality-ci-cd-patterns)
- [Claude Code Hooks Practical Guide (DataCamp)](https://www.datacamp.com/tutorial/claude-code-hooks)
- [Claude Code Auto Mode (9to5mac)](https://9to5mac.com/2026/03/24/claude-code-gives-developers-auto-mode-a-safer-alternative-to-skipping-permissions/)
- [Auto Mode for Claude Code (Simon Willison)](https://simonwillison.net/2026/mar/24/auto-mode-for-claude-code/)
- [Claude Code Sandbox Guide](https://claudefa.st/blog/guide/sandboxing-guide)
- [Claude Code Agent Teams Guide](https://claudefa.st/blog/guide/agents/agent-teams)
- [From Tasks to Swarms: Agent Teams](https://alexop.dev/posts/from-tasks-to-swarms-agent-teams-in-claude-code/)
- [A Mental Model for Skills, Subagents, and Plugins](https://levelup.gitconnected.com/a-mental-model-for-claude-code-skills-subagents-and-plugins-3dea9924bf05)
- [Claude Agent Skills: A First Principles Deep Dive](https://leehanchung.github.io/blogs/2025/10/26/claude-skills-deep-dive/)
- [Parallel AI Coding with Git Worktrees](https://docs.agentinterviews.com/blog/parallel-ai-coding-with-gitworktrees/)
- [Git Worktrees for Parallel AI Coding Agents](https://devcenter.upsun.com/posts/git-worktrees-for-parallel-ai-coding-agents/)

### CI/CD 与 Headless
- [CI/CD and Headless Mode with Claude Code](https://angelo-lima.fr/en/claude-code-cicd-headless-en/)
- [Headless Mode Tutorial (SFEIR)](https://institute.sfeir.com/en/claude-code/claude-code-headless-mode-and-ci-cd/tutorial/)
- [Claude Code GitHub Actions Recipes](https://systemprompt.io/guides/claude-code-github-actions)
- [Integrating Claude Code with GitHub Actions (Steve Kinney)](https://stevekinney.com/courses/ai-development/integrating-with-github-actions)

### 上下文与 Token 优化
- [How Claude Code Got Better by Protecting More Context](https://hyperdev.matsuoka.com/p/how-claude-code-got-better-by-protecting)
- [Understanding Claude Code's Context Window](https://damiangalarza.com/posts/2025-12-08-understanding-claude-code-context-window/)
- [How to Manage Claude Code Context and Reduce Token Usage](https://madplay.github.io/en/post/claude-code-context-and-token-optimization)
- [How to Optimize Claude Code Token Usage (ClaudeLog)](https://www.claudelog.com/faqs/how-to-optimize-claude-code-token-usage/)

### 2026 新功能
- [What's new in Claude Opus 5（官方）](https://platform.claude.com/docs/en/about-claude/models/whats-new-opus-5)
- [What's new in Claude Opus 4.8（官方）](https://platform.claude.com/docs/en/about-claude/models/whats-new-claude-4-8)
- [Claude Agent SDK Migration Guide（官方）](https://platform.claude.com/docs/en/agent-sdk/migration-guide)
- [Introducing Claude Sonnet 5（官方）](https://www.anthropic.com/news/claude-sonnet-5)
- [Context windows（官方，1M 上下文模型清单）](https://platform.claude.com/docs/en/build-with-claude/context-windows)

### 本轮联网校验来源（2026-08，覆盖 v2.1.208~224 与 Opus 5）
- [Models overview（官方，模型 ID / 平台 ID 对照表）](https://platform.claude.com/docs/en/about-claude/models/overview)
- [Share session output as artifacts（官方 Artifacts 文档）](https://code.claude.com/docs/en/artifacts)
- [Hooks reference（官方，事件节律与 `EndConversation` / `@` 引用边界）](https://code.claude.com/docs/en/hooks)
- [Claude Code settings（官方，`worktree.*` / `sandbox.filesystem.disabled`）](https://code.claude.com/docs/en/settings)
- [Claude Code changelog（官方）](https://code.claude.com/docs/en/changelog)
- [Releases · anthropics/claude-code（GitHub 逐版本条目）](https://github.com/anthropics/claude-code/releases)
- [changelogs.directory / claude-code（逐版本分类计数，v2.1.214~224）](https://changelogs.directory/tools/claude-code)
- [Introducing Claude Opus 5 on AWS（AWS，Bedrock model ID）](https://aws.amazon.com/blogs/machine-learning/introducing-claude-opus-5-on-aws-anthropics-most-capable-opus-model)
- [Anthropic's Claude Opus 5 rivals Fable 5 and is cheaper（CNBC，07-24 发布）](https://www.cnbc.com/2026/07/24/anthropic-claude-opus-5-ai-fable-5-cost.html)
- [Claude Opus 5 pricing: same sticker, different bill（CloudZero，effort 与账单）](https://www.cloudzero.com/blog/claude-opus-5-pricing)
- [Claude Code v2.1.223 Major Updates（DevelopersIO，`/review` 别名化）](https://dev.classmethod.jp/en/articles/20260806-cc-updates-v2-1-223)
- [Claude Code v2.1.224 Major Updates（DevelopersIO，跨会话消息 / self-hosted runner）](https://dev.classmethod.jp/en/articles/20260807-cc-updates-v2-1-224)
- [Claude Code v2.1.215: who controls the agent's checklist（Augment Code）](https://www.augmentcode.com/learn/claude-code-v2-1-215)
- [Ultracode: Multi-Agent Orchestration Mode Explained（Developers Digest）](https://www.developersdigest.tech/blog/ultracode-effort-level-explained)
- [Dynamic Workflows vs Agent Teams（claudefa.st，三方对比）](https://claudefa.st/blog/guide/development/ultracode-dynamic-workflows-agent-teams)
- [Claude Code Adds Dynamic Workflows（InfoQ）](https://www.infoq.com/news/2026/06/dynamic-workflows-claude-code)
- [Claude Code Artifacts: Ship a Coding Session as a Page（Digital Applied）](https://www.digitalapplied.com/blog/claude-code-shareable-artifacts-live-web-pages-2026)

### 上一轮联网校验来源（2026-07）
- [Claude Code v2.1.200：Manual 默认权限模式（The Agent Report）](https://the-agent-report.com/2026/07/claude-code-2-1-200-manual-permission)
- [Claude Code Defaults to Human Approval（TechTimes，Manual 默认与 CI 影响）](https://www.techtimes.com/articles/319874/20260707/claude-code-defaults-human-approval-auto-mode-requires-explicit-opt.htm)
- [Claude Code v2.1.207：Auto Mode 云平台默认开启（TechTimes）](https://www.techtimes.com/articles/320233/20260712/claude-code-removes-enterprise-opt-auto-mode-now-default-major-cloud-platforms.htm)
- [Claude Code Version History / Releases（cc.bruniaux.com）](https://cc.bruniaux.com/releases)
- [Claude Code Updates by Anthropic（Releasebot）](https://releasebot.io/updates/anthropic/claude-code)
- [Claude Code Routines Guide（claudefa.st，云端定时）](https://claudefa.st/blog/guide/development/routines-guide)
- [Claude Code Scheduled Tasks Setup Guide（claudefa.st，`/loop` + Cron 工具）](https://claudefa.st/blog/guide/development/scheduled-tasks)
- [Claude Sonnet 5 Guide（claudedirectory.org，价格/tokenizer）](https://www.claudedirectory.org/blog/claude-sonnet-5-guide)
- [2026 模型选择指南（claude-world.com，Fable5/Opus4.8/Sonnet5/Haiku4.5）](https://claude-world.com/articles/claude-model-selection-guide-2026)
- [Claude Code Changelog（allthings.how 聚合）](https://allthings.how/claude-code-changelog)
- [Claude Code Changelog: All Release Notes 2026（claudefa.st）](https://claudefa.st/blog/guide/changelog)
- [Claude Code June 2026: 10 New Features（SitePoint）](https://www.sitepoint.com/claude-code-june-2026-10-new-features-devs-need-to-know)
- [Claude Opus 4.8 Release Date, Pricing, API & Claude Code](https://coursiv.io/blog/claude-opus-4-8)
- [Claude Code March 2026 Full Capability Interpretation](https://help.apiyi.com/en/claude-code-2026-new-features-loop-computer-use-remote-control-guide-en.html)
- [Claude Code's Biggest Week Yet (March 2026)](https://medium.com/@AdithyaGiridharan/claude-codes-biggest-week-yet-what-changed-in-the-march-2026-releases-20432abae2b1)
- [Claude Code New Features: Auto Mode, Dispatch, Remote Control](https://sidsaladi.substack.com/p/now-claude-code-gets-new-features)
- [2026 Agentic Coding Trends Report (Anthropic PDF)](https://resources.anthropic.com/hubfs/2026%20Agentic%20Coding%20Trends%20Report.pdf)

### 社区资源
- [Claude Code Built-in Tools Reference](https://www.vtrivedy.com/posts/claudecode-tools-reference)
- [Claude Code Tools Gist](https://gist.github.com/alchemician/47b6cfc6cfbc9c306fa1d15801faf3e7)
- [Claude Code System Prompt](https://gist.github.com/wong2/e0f34aac66caf890a332f7b6f9e2ba8f)
- [How to Build Claude Code from Scratch](https://arslnb.com/posts/how-to-build-claude-code-from-scratch/)
- [Claude Code Demystified](https://www.mihaileric.com/Demystifying-Claude-Code/)
- [Claude Code Data Structures Analysis](https://www.southbridge.ai/blog/claude-code-an-analysis-data-structures)
- [Claude Code CLI Comprehensive Guide](https://introl.com/blog/claude-code-cli-comprehensive-guide-2025)
- [Claude Code Cheatsheet](https://devtoolcafe.com/tools/claude-code-cheatsheet)
