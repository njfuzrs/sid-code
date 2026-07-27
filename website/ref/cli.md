---
title: CLI 参数与子命令
description: sid-code 的全部命令行参数与子命令。
---

# CLI 参数与子命令

sid-code 的全部命令行参数与子命令。

::: danger 本页由脚本生成，请勿手工编辑
`<!-- AUTO-GEN:START -->` 与 `<!-- AUTO-GEN:END -->` 之间的内容由
`scripts/docs-gen-reference.ts` 从源码生成（数据源：src/cli.ts parseArgs × src/help.ts 双源交叉对账），
手改会在下次生成时被覆盖，且 pre-commit 会先拦住。

需要补充说明请写在标记**之外**——那部分内容会被保留。
:::

<!-- AUTO-GEN:START 由 scripts/docs-gen-reference.ts 生成，勿手工编辑 -->

> 共 **64** 个参数条目、**6** 个子命令。
> 描述取自 `sid-code --help`，并与 `src/cli.ts` 的 `parseArgs` 声明
> （**参数能不能用的唯一权威**，共 64 个 flag）交叉对账：
> "能用但没写"和"写了但不能用"两类缺陷都会让对账测试失败。

## 子命令

| 子命令 | 说明 |
|---|---|
| `sid-code review` | 代码审查（从 stdin 或 --diff 文件读取 unified diff） 用法: sid-code review [--diff &lt;path>] [--model &lt;model>] [--timeout &lt;ms>] 示例: git diff main...HEAD \| sid-code review sid-code review --diff /tmp/pr.diff --model… |
| `sid-code daemon` | 本地调度守护进程管理 用法: sid-code daemon &lt;start\|status\|stop\|restart> [选项] 选项: --webhook 启用 webhook 源 --interval &lt;ms> 调度检查间隔（默认 60000） --max-concurrent &lt;n> 最大并发 headless job（默认 3） --allowed-tools &lt;a,b> 全局兜底工… |
| `sid-code update` | 下载并替换二进制到最新版（不动 ~/.sid-code/ 数据） |
| `sid-code agents` | 列出所有可用子代理（内置/自定义/插件） 用法: sid-code agents [--json] [--setting-sources user,project,local] |
| `sid-code mcp` | 管理 MCP 服务器配置（不启动会话） 用法: sid-code mcp &lt;list\|get\|add\|remove> [参数] [--json] 示例: sid-code mcp list sid-code mcp add fs npx -y @modelcontextprotocol/server-filesystem /tmp --scope user sid-code mcp rem… |
| `sid-code auth` | 认证配置诊断 用法: sid-code auth status [--json] |

## LLM 配置

| 参数 | 说明 |
|---|---|
| `--provider <name>` | LLM 提供商 (anthropic/openai/ollama) |
| `-m, --model <name>` | 模型名称 |
| `--fallback-model <name>` | 主模型失败时的降级模型（须在 available_models 中） |
| `--max-tokens <n>` | 响应最大 token 数 |
| `--effort <level>` | 推理强度档位 (low/medium/high/xhigh/max/auto) |

## 权限配置

| 参数 | 说明 |
|---|---|
| `--permission-mode <mode>` | 权限模式 (default/always-allow/deny-write/acceptEdits/plan/dontAsk) |
| `--dangerously-skip-permissions` | 跳过所有权限检查（仅限沙箱环境） |
| `-y, --yes` | 自动批准所有权限请求 |
| `--allowed-tools <list>` | 工具白名单（逗号分隔，如 "read,grep,bash"） |
| `--disallowed-tools <list>` | 工具黑名单（逗号分隔） |
| `--allow-tool <rule>` | 追加允许规则（规则语法，如 "Bash(git status)"；可重复或逗号分隔） |
| `--deny-tool <rule>` | 追加拒绝规则（同上语法；拒绝优先于允许） |
| `--tools <list>` | 替换整个内置工具集（逗号分隔；未列出的工具不注册） |
| `--add-dir <dir>` | 追加可访问目录（可重复：--add-dir A --add-dir B） |

## 会话配置

| 参数 | 说明 |
|---|---|
| `-c, --continue` | 继续最近一次会话 |
| `-r, --resume [值]` | 恢复会话：不带值打开交互式选择器（可搜索）， 带值按 ID/索引恢复，未命中则作为搜索词进选择器 |
| `--session-id <uuid>` | 指定会话 UUID（须合法 UUID；与 -c/-r 同用须配 --fork-session） |
| `--fork-session` | 恢复会话时分叉为新会话（新 id，不改动源会话） |
| `--no-session-persistence` | 禁用会话落盘（本次会话不写持久化存储） |
| `--from-pr <number>` | 从 PR 恢复会话上下文（gh pr view；内嵌会话 id 则恢复，否则注入 PR 上下文） |
| `-n, --name <name>` | 会话显示名（便于 --list-sessions 辨识） |
| `--list-sessions` | 列出所有会话（文本模式） |
| `--browse-sessions` | 打开 TUI 会话浏览器 |
| `--delete-session <id>` | 删除指定会话 |
| `--cleanup-sessions` | 手动触发会话清理 |

## 无头模式

| 参数 | 说明 |
|---|---|
| `-p, --print` | 无头模式（非交互式，需提供提示词） |
| `--input-format <fmt>` | 输入格式 (text/stream-json；stream-json 从 stdin 读流式消息) |
| `--output-format <fmt>` | 输出格式 (text/json) |
| `--include-partial-messages` | stream-json 输出模式下包含部分消息增量 |
| `--max-turns <n>` | Agent 循环最大轮次 |
| `--verbose` | 详细输出（无头模式下输出全量消息数组而非仅最终消息） |
| `--json-schema <path>` | 结构化输出 JSON Schema 文件路径（约束 LLM 输出格式） |

## 系统提示词

| 参数 | 说明 |
|---|---|
| `--system-prompt <text>` | 覆盖系统提示词 |
| `--append-system-prompt <text>` | 追加到系统提示词 |
| `--system-prompt-file <path>` | 从文件加载系统提示词 |
| `--append-system-prompt-file <path>` | 从文件读取内容追加到系统提示词 |

## 插件

| 参数 | 说明 |
|---|---|
| `--plugin-dir <path>` | 会话级插件目录（可重复：--plugin-dir A --plugin-dir B） |

## 配置源

| 参数 | 说明 |
|---|---|
| `--settings <file-or-json>` | 额外 settings 源（文件路径或内联 JSON，最后一层覆盖） |
| `--setting-sources <sources>` | 限定加载的 settings 源（逗号分隔，子集：user/project/local） |

## MCP

| 参数 | 说明 |
|---|---|
| `--mcp-config <config>` | 额外 MCP 配置源（文件路径或内联 JSON，可重复） |
| `--strict-mcp-config` | 仅用 --mcp-config 指定的服务器，忽略其它来源 |

## 子代理

| 参数 | 说明 |
|---|---|
| `--agents <json>` | 注入子代理定义（内联 JSON: {name:{description,prompt,...}}） |
| `--agent <name>` | 整会话使用指定的顶层子代理人格 |

## 模型行为

| 参数 | 说明 |
|---|---|
| `--betas <beta>` | 额外 anthropic-beta 头值（可重复或逗号分隔） |

## 限制控制

| 参数 | 说明 |
|---|---|
| `--max-budget-usd <amount>` | 花费上限（美元，超限终止） |

## IDE

| 参数 | 说明 |
|---|---|
| `--ide` | 启动即自动连接 IDE（等价 SID_CODE_AUTO_CONNECT_IDE=true） |

## 功能开关

| 参数 | 说明 |
|---|---|
| `--disable-slash-commands` | 禁用所有斜杠命令（headless/受限场景） |

## 调试

| 参数 | 说明 |
|---|---|
| `-d, --debug` | 启用调试模式（日志输出到 ~/.sid-code/debug.log） |
| `--debug-level <level>` | 日志级别 (ERROR/WARN/INFO/DEBUG，默认 DEBUG) |
| `--debug-log-file <path>` | 自定义日志文件路径 |

## 轨迹采集

| 参数 | 说明 |
|---|---|
| `--trace / --no-trace` | 启用/禁用轨迹采集（默认启用，本地保存到 ~/.sid-code/trajectories/） |
| `--trace-upload-disabled` | 强制禁用自动上传（覆盖配置文件，最高优先级） |
| `--trace-upload-url <url>` | 轨迹上传平台地址（CLI 覆盖配置文件） |
| `--trace-upload-token <tok>` | 上传认证 token（CLI 覆盖配置文件） |
| `--trace-user-id <id>` | 用户标识（多用户场景） |
| `--trace-device-id <id>` | 设备标识 |
| `--upload-traces` | 手动触发重试队列补传（处理之前失败的上传） |

## UI

| 参数 | 说明 |
|---|---|
| `--inline` | 回退旧主屏内联模式：历史进终端原生 scrollback、鼠标原生选中复制， 兼容不支持 alt-screen 的终端。默认已改为全屏有界视口（见下）， 仅在需要终端原生 scrollback/选择时用此逃生舱。 |
| `--alternate-buffer` | 兼容保留（现已是默认）：全屏 Alternate Buffer 有界视口 （应用内虚拟滚动 + 鼠标滚轮 + Ctrl+S Copy Mode）。默认启用， 物理根治执行中工具溢出 scrollback 的幽灵行残留。 |

## Bridge 远程控制

| 参数 | 说明 |
|---|---|
| `--bridge <ws-url>` | 进入 Bridge 模式，连接中继服务器接受远程客户端操控（ws:// 或 wss://） |
| `--bridge-token <token>` | Bridge 连接认证令牌 |

## Worktree 隔离

| 参数 | 说明 |
|---|---|
| `--worktree[=<name>]` | 启动即创建并进入隔离 Git Worktree（省略 name 自动命名为 brave-eagle-42 形态） |

## 其他

| 参数 | 说明 |
|---|---|
| `-h, --help` | 显示帮助信息 |
| `-v, --version` | 显示版本信息 |

<!-- AUTO-GEN:END -->
