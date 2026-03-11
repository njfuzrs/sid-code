# Claude Code 深度研究文档

> 目标：全面分析 Claude Code 的功能、架构和实现细节，为 sid-code 项目提供完整的对标参考。
> 更新日期：2026-03-11

---

## 目录

1. [产品概述](#1-产品概述)
2. [核心架构：Agentic While-Loop](#2-核心架构agentic-while-loop)
3. [内置工具系统](#3-内置工具系统)
4. [Slash 命令](#4-slash-命令)
5. [CLI 命令与参数](#5-cli-命令与参数)
6. [键盘快捷键与交互模式](#6-键盘快捷键与交互模式)
7. [权限系统](#7-权限系统)
8. [Hook 系统](#8-hook-系统)
9. [记忆系统（CLAUDE.md + Auto Memory）](#9-记忆系统claudemd--auto-memory)
10. [MCP 协议集成](#10-mcp-协议集成)
11. [子代理系统（Subagents）](#11-子代理系统subagents)
12. [上下文窗口管理](#12-上下文窗口管理)
13. [Git 集成与安全协议](#13-git-集成与安全协议)
14. [会话管理与持久化](#14-会话管理与持久化)
15. [IDE 集成](#15-ide-集成)
16. [SDK 与 Headless 模式](#16-sdk-与-headless-模式)
17. [安全与沙箱](#17-安全与沙箱)
18. [Skills 系统](#18-skills-系统)
19. [配置系统](#19-配置系统)
20. [实现优先级建议](#20-实现优先级建议)

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

**支持模型：**
- Claude Opus 4.6（最强推理，支持 1M 上下文）
- Claude Sonnet 4.6（平衡性能与速度）
- Claude Haiku 4.5（快速低延迟）
- 可通过 `/model` 切换，或 `claude --model <name>` 启动时指定

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

**分层架构：**
```
用户交互层（CLI / VS Code / JetBrains / Desktop / Web）
         ↓
Agent Loop（消息循环 + 工具调度）
         ↓
工具执行层（内置工具 + MCP 工具）
         ↓
权限检查层（deny → allow → ask）
         ↓
LLM API（Anthropic Messages API，流式）
```

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

### 3.9 工具优先级规则

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
| `/effort [level]` | 设置推理努力级别 | low/medium/high/auto |

### 4.4 开发与代码

| 命令 | 功能 | 说明 |
|------|------|------|
| `/review` | 审查代码变更 | 分析 git diff |
| `/commit` | 创建 git commit | 语义分析变更，生成 commit message |
| `/pr` | 创建 Pull Request | 分析所有 commit，生成 PR 描述 |
| `/diff` | 交互式 diff 查看器 | 左右箭头切换 git diff 和单次 turn diff，上下浏览文件 |
| `/plan [description]` | 进入计划模式 | 可选描述立即开始规划 |
| `/rewind` | 回退变更 | 使用 checkpoint 系统恢复代码和/或对话 |
| `/simplify` | 简化代码（内置 skill） | 启动 3 个并行审查代理（复用/质量/效率），聚合发现并修复 |
| `/batch <instruction>` | 批量并行处理 | 分解为 5-30 个独立单元，每个在独立 worktree 中执行 |
| `/debug [description]` | 调试当前会话 | 读取会话 debug 日志进行分析 |

### 4.5 诊断与账户

| 命令 | 功能 | 说明 |
|------|------|------|
| `/doctor` | 运行诊断检查 | 检查安装、配置、更新通道 |
| `/cost` | 显示 token 用量和费用 | 当前会话统计 |
| `/status` | 显示会话状态 | |
| `/login` | 登录 Anthropic 账户 | |
| `/logout` | 登出 | |
| `/bug` | 报告 bug | 别名：`/feedback` |
| `/help` | 显示帮助和可用命令 | |

### 4.6 高级功能

| 命令 | 功能 | 说明 |
|------|------|------|
| `/loop [interval] <prompt>` | 定时循环执行 | 如 `/loop 5m check the deploy`，默认 10 分钟间隔 |
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
| `--model` | 设置模型 | `claude --model claude-sonnet-4-6` |
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
| `default` | 标准行为：首次使用每个工具时提示确认 | 默认 |
| `acceptEdits` | 自动接受文件编辑权限，命令仍需确认 | `Shift+Tab` 循环 |
| `plan` | 计划模式：只能分析不能修改文件或执行命令 | `Shift+Tab` 循环 |
| `dontAsk` | 自动拒绝工具，除非通过 `/permissions` 或 `permissions.allow` 预批准 | 设置文件 |
| `bypassPermissions` | 跳过所有权限检查（仅限隔离环境） | CLI 参数 |

> `bypassPermissions` 模式禁用所有权限检查，仅在容器/VM 等隔离环境使用。管理员可通过 managed settings 设置 `disableBypassPermissionsMode: "disable"` 阻止此模式。

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

### 8.1 Hook 事件（17 个）

| 事件 | 触发时机 | 可否阻止操作 |
|------|----------|-------------|
| `SessionStart` | 会话开始或恢复时 | 否 |
| `InstructionsLoaded` | CLAUDE.md 或 rules 文件加载到上下文时 | 否 |
| `UserPromptSubmit` | 用户提交 prompt 后，Claude 处理前 | 是 |
| `PreToolUse` | 工具调用执行前 | 是（可 block） |
| `PermissionRequest` | 权限对话框出现时 | 是（可自动决策） |
| `PostToolUse` | 工具调用成功后 | 否 |
| `PostToolUseFailure` | 工具调用失败后 | 否 |
| `Notification` | Claude Code 发送通知时 | 否 |
| `SubagentStart` | 子代理启动时 | 否 |
| `SubagentStop` | 子代理完成时 | 否 |
| `Stop` | Claude 完成响应时 | 是 |
| `TeammateIdle` | 团队代理空闲时 | 是 |
| `TaskCompleted` | 任务标记完成时 | 是 |
| `ConfigChange` | 配置文件变更时 | 是 |
| `WorktreeCreate` | 创建 worktree 时 | 替换默认 git 行为 |
| `WorktreeRemove` | 移除 worktree 时 | — |
| `PreCompact` | 上下文压缩前 | — |
| `SessionEnd` | 会话终止时 | — |

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

### 8.7 异步 Hook

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

### 8.8 Prompt-based Hook

使用 LLM 评估的 hook，适合复杂的多条件判断：

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

**子代理不能嵌套：** 子代理不能再启动子代理（防止无限嵌套）。

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

---

## 12. 上下文窗口管理

### 12.1 窗口大小

| 模型 | 上下文窗口 |
|------|-----------|
| 标准 | 200,000 tokens（~150,000 词） |
| Opus 4.6 (1M) | 1,000,000 tokens |

### 12.2 上下文消耗

所有内容都计入上下文限制：对话历史、读取的文件内容、工具调用结果、System prompt、CLAUDE.md 内容、MCP 工具定义。

> Claude Code **不会**预先索引代码库，而是按需使用工具（Grep/Glob/Read）读取文件。

### 12.3 自动压缩（Auto-Compaction）

- 当上下文使用率达到约 **75-95%** 时自动触发
- 预留安全缓冲区
- 触发时，Claude 将对话历史总结为精简摘要
- `PreCompact` hook 事件在压缩前触发，允许注入保留指令

### 12.4 手动压缩

```
/compact                          # 手动触发压缩
/compact focus on auth errors     # 指定保留重点
```

### 12.5 上下文管理策略

| 策略 | 说明 |
|------|------|
| Plan Mode | 先规划再执行，可减半 token 消耗 |
| 子代理 | 独立上下文窗口，防止主对话膨胀 |
| `/compact` | 手动压缩，可指定保留重点 |
| `/clear` | 完全清除对话历史 |
| 精确文件读取 | 使用 `offset`/`limit` 参数只读取需要的部分 |

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

例如 `/Users/dev/Code/person/sid-code` 编码为 `-Users-zhourusheng-Code-person-sid-code`。

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
    "model": "claude-opus-4-6",
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

非交互模式，处理单个 prompt 后输出结果并退出：

```bash
# 基本用法
claude -p "explain this function"

# 管道输入
cat logs.txt | claude -p "explain these errors"

# JSON 输出
claude -p "query" --output-format json

# 流式 JSON
claude -p "query" --output-format stream-json

# 限制轮次和预算
claude -p --max-turns 3 --max-budget-usd 5.00 "query"

# 跳过权限（CI/CD）
claude -p --dangerously-skip-permissions "query"

# 自定义系统提示
claude -p --system-prompt "You are a reviewer" "review this code"
```

### 16.2 输出格式

| 格式 | 说明 |
|------|------|
| `text` | 纯文本输出（默认） |
| `json` | 结束时输出单个 JSON 结果对象 |
| `stream-json` | 实时流式 JSON 事件（每行一个 JSON 对象） |

### 16.3 结构化输出

```bash
# 使用 JSON Schema 获取结构化输出
claude -p --json-schema '{"type":"object","properties":{...}}' "query"
```

### 16.4 Agent SDK

Claude Code 提供 SDK 用于构建自定义代理：
- Python SDK：`claude_code_sdk`
- TypeScript SDK：`@anthropic-ai/claude-code-sdk`
- 完全控制编排、工具访问和权限
- 支持 MCP 集成

### 16.5 CI/CD 集成

**GitHub Actions（`anthropics/claude-code-action`）：**
- 支持触发器：`pull_request`（opened/synchronize/ready_for_review/reopened）、issue comments、`workflow_dispatch`
- 支持 `@claude` 在 PR 评论中触发分析
- 自动审查工作流可在 PR 打开/同步时运行
- 可自动实现 issue 中的功能、修复 bug、创建 PR

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
| 命令注入检测 | 可疑命令即使在 allowlist 中也需手动确认 |
| Fail-closed 匹配 | 未匹配命令默认需要手动确认 |

### 17.3 沙箱（Sandbox）

通过 `/sandbox` 命令启用 OS 级隔离：

**文件系统隔离：**
- 只能访问/修改特定目录（项目目录）
- 敏感文件（SSH 密钥、凭证）被阻止

**网络隔离：**
- 连接限制为白名单域名
- 防止数据泄露

**平台支持：**
- macOS：使用 `sandbox-exec` 原生沙箱，开箱即用
- Linux/WSL2：需要安装 `bubblewrap` 和 `socat`
- Windows：计划中

**Docker 容器沙箱：**
- Claude Code 可在 Docker 容器内运行实现完全隔离
- 默认拒绝的 iptables 防火墙规则
- Claude 运行在容器内部，不在宿主机上

> 有效沙箱需要**同时**具备文件系统隔离和网络隔离。

### 17.4 Prompt 注入防护

| 防护 | 说明 |
|------|------|
| 权限系统 | 敏感操作需明确审批 |
| 上下文感知分析 | 通过分析完整请求检测潜在有害指令 |
| 输入清理 | 防止命令注入 |
| 网络请求审批 | 发起网络请求的工具默认需要用户审批 |
| 隔离上下文窗口 | WebFetch 使用独立上下文窗口避免注入 |
| 信任验证 | 首次运行代码库和新 MCP 服务器需要信任验证 |

### 17.5 凭证管理

- API 密钥和 token 加密存储
- 有限的敏感信息保留期
- 用户控制数据训练偏好

---

## 18. Skills 系统

### 18.1 概述

Skills 扩展 Claude 的能力。创建一个 `SKILL.md` 文件写入指令，Claude 将其加入工具箱。Claude 在相关时自动使用 skill，或用户通过 `/skill-name` 直接调用。

Skills 遵循 Agent Skills 开放标准，Claude Code 在此基础上扩展了调用控制、子代理执行和动态上下文注入。

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
| `description` | 描述，帮助 Claude 决定何时自动加载 |
| `invocation` | 调用控制：`auto`（Claude 自动）/ `user`（仅用户 `/` 调用） |
| `agent` | 是否在子代理中运行 |
| `tools` | 限制可用工具 |

### 18.5 Skill 存储位置

| 位置 | 作用域 | 优先级 |
|------|--------|--------|
| 企业管理设置 | 组织所有用户 | 最高 |
| `~/.claude/skills/<name>/SKILL.md` | 个人（所有项目） | 高 |
| `.claude/skills/<name>/SKILL.md` | 项目级 | 中 |
| 插件中的 skills 目录 | 插件级 | 命名空间隔离 |

同名 skill 优先级：enterprise > personal > project。插件 skill 使用 `plugin-name:skill-name` 命名空间，不冲突。

### 18.6 内置 Skills

| Skill | 功能 |
|-------|------|
| `/simplify` | 审查最近变更的代码，检查复用/质量/效率问题并修复。启动 3 个并行审查代理 |
| `/batch <instruction>` | 大规模并行变更。分解为 5-30 个独立单元，每个在独立 worktree 中执行，各自开 PR |
| `/debug [description]` | 读取会话 debug 日志进行故障排查 |
| `/loop [interval] <prompt>` | 定时循环执行 prompt。如 `/loop 5m check the deploy` |
| `/claude-api` | 加载 Claude API 参考材料。代码导入 anthropic SDK 时自动触发 |

### 18.7 动态上下文注入

Skill 可以通过 `@path/to/file` 语法引用支持文件，在 skill 激活时自动加载到上下文。

### 18.8 与 Commands 的关系

- `.claude/commands/deploy.md` 和 `.claude/skills/deploy/SKILL.md` 都创建 `/deploy`
- 现有 `.claude/commands/` 文件继续工作
- Skills 增加了可选功能：支持文件目录、frontmatter 控制、Claude 自动加载
- 同名时 skill 优先

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
  "model": "claude-sonnet-4-6"
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
| `ANTHROPIC_MODEL` | 默认模型 |
| `MCP_TIMEOUT` | MCP 服务器超时 |
| `MAX_MCP_OUTPUT_TOKENS` | MCP 输出 token 限制 |
| `ENABLE_TOOL_SEARCH` | 工具搜索控制 |
| `CLAUDE_CODE_MAX_OUTPUT_TOKENS` | 最大输出 token |

---

## 20. 实现优先级建议

基于 Claude Code 的功能分析，为 sid-code 项目建议以下实现优先级：

### P0 — 核心（必须有）

| 功能 | 说明 | sid-code 现状 |
|------|------|--------------|
| Agentic While-Loop | 消息循环 + 工具调度 + 流式渲染 | ✅ 已实现 |
| 多模型支持 | Claude/OpenAI/Ollama Provider | ✅ 已实现 |
| 6 个内置工具 | Read/Write/Edit/Bash/Grep/Glob | ✅ 已实现 |
| 权限系统 | deny/allow/ask 规则 + 用户确认 | ✅ 已实现 |
| CLAUDE.md 加载 | 项目/用户级指令文件 | ✅ 已实现 |
| 上下文管理 | 自动压缩 + `/compact` | ✅ 已实现 |
| 会话持久化 | JSON 保存/恢复 | ✅ 已实现 |
| Hook 系统 | Pre/Post 工具调用事件 | ✅ 已实现 |

### P1 — 重要（应该有）

| 功能 | 说明 | 复杂度 |
|------|------|--------|
| MCP 协议 | stdio/HTTP 传输 + tools/resources/prompts | 高 |
| 子代理系统 | 独立上下文 + 工具限制 + 后台运行 | 高 |
| Slash 命令系统 | `/compact`, `/model`, `/help`, `/clear` 等 | 中 |
| 自定义命令/Skills | `.claude/commands/` + `.claude/skills/` | 中 |
| Git 安全协议 | 安全规则 + commit/PR 工作流 | 中 |
| 多级配置 | settings.json 层级 + 权限规则语法 | 中 |
| Auto Memory | 自动学习笔记 + MEMORY.md | 低 |

### P2 — 增强（锦上添花）

| 功能 | 说明 | 复杂度 |
|------|------|--------|
| Worktree 支持 | 隔离 git worktree 并行工作 | 中 |
| Checkpoint 系统 | 变更快照 + 回退 | 中 |
| IDE 集成 | VS Code 扩展 / JetBrains 插件 | 高 |
| 沙箱 | OS 级文件系统/网络隔离 | 高 |
| Headless/SDK 模式 | `-p` 模式 + JSON 输出 + 结构化输出 | 中 |
| 图片支持 | 多模态输入（截图/图片文件） | 低 |
| Vim 模式 | 输入框 vim 键绑定 | 低 |
| 定时任务 | `/loop` + Cron 系统 | 低 |
| 远程控制 | Web UI 控制本地 CLI | 高 |
| 批量处理 | `/batch` 并行代理 | 高 |

### 下一步建议

1. **MCP 协议** — 这是 Claude Code 最大的差异化功能，连接外部工具生态。建议优先实现 stdio 传输 + tools 原语
2. **子代理系统** — 独立上下文窗口的子代理是处理复杂任务的关键
3. **完善 Slash 命令** — 用户交互的核心体验
4. **Git 安全协议** — 编码到 system prompt 中的硬性规则

---

## 参考资料

### 官方文档
- [Claude Code Overview](https://docs.anthropic.com/en/docs/claude-code/overview)
- [Claude Code CLI Reference](https://docs.anthropic.com/en/docs/claude-code/cli-reference)
- [Claude Code Interactive Mode](https://docs.anthropic.com/en/docs/claude-code/interactive-mode)
- [Claude Code Hooks Reference](https://docs.anthropic.com/en/docs/claude-code/hooks)
- [Claude Code Memory](https://docs.anthropic.com/en/docs/claude-code/memory)
- [Claude Code MCP](https://docs.anthropic.com/en/docs/claude-code/mcp)
- [Claude Code Security](https://docs.anthropic.com/en/docs/claude-code/security)
- [Claude Code Permissions](https://docs.anthropic.com/en/docs/claude-code/permissions)
- [Claude Code Skills](https://docs.anthropic.com/en/docs/claude-code/skills)
- [Claude Code Subagents](https://docs.anthropic.com/en/docs/claude-code/subagents)

### 社区资源
- [Claude Code Built-in Tools Reference](https://www.vtrivedy.com/posts/claudecode-tools-reference)
- [Claude Code Tools Gist](https://gist.github.com/alchemician/47b6cfc6cfbc9c306fa1d15801faf3e7)
- [Claude Code System Prompt](https://gist.github.com/wong2/e0f34aac66caf890a332f7b6f9e2ba8f)
- [How to Build Claude Code from Scratch](https://arslnb.com/posts/how-to-build-claude-code-from-scratch/)
- [Claude Code Demystified](https://www.mihaileric.com/Demystifying-Claude-Code/)
- [Claude Code Data Structures Analysis](https://www.southbridge.ai/blog/claude-code-an-analysis-data-structures)
- [Claude Code CLI Comprehensive Guide](https://introl.com/blog/claude-code-cli-comprehensive-guide-2025)
- [Claude Code Cheatsheet](https://devtoolcafe.com/tools/claude-code-cheatsheet)
