/**
 * 帮助文本（独立模块，供 bootstrap 快速路径使用）
 */

export function printHelp(): void {
  console.log(`
sid-code - AI 编程 CLI 工具

用法:
  sid-code [选项] [提示词]
  sid-code <子命令> [子命令选项]

LLM 配置:
  --provider <name>           LLM 提供商 (anthropic/openai/ollama)
  -m, --model <name>          模型名称
  --fallback-model <name>     主模型失败时的降级模型（须在 available_models 中）
  --max-tokens <n>            响应最大 token 数
  --effort <level>            推理强度档位 (low/medium/high/xhigh/max/auto)

权限配置:
  --permission-mode <mode>    权限模式 (default/always-allow/deny-write/acceptEdits/plan/dontAsk)
  --dangerously-skip-permissions  跳过所有权限检查（仅限沙箱环境）
  -y, --yes                   自动批准所有权限请求
  --allowed-tools <list>      工具白名单（逗号分隔，如 "read,grep,bash"）
  --disallowed-tools <list>   工具黑名单（逗号分隔）
  --tools <list>              替换整个内置工具集（逗号分隔；未列出的工具不注册）
  --add-dir <dir>             追加可访问目录（可重复：--add-dir A --add-dir B）

会话配置:
  -c, --continue              继续最近一次会话
  -r, --resume [值]           恢复会话：不带值打开交互式选择器（可搜索），
                              带值按 ID/索引恢复，未命中则作为搜索词进选择器
  --session-id <uuid>         指定会话 UUID（须合法 UUID；与 -c/-r 同用须配 --fork-session）
  --fork-session              恢复会话时分叉为新会话（新 id，不改动源会话）
  --no-session-persistence    禁用会话落盘（本次会话不写持久化存储）
  -n, --name <name>           会话显示名（便于 --list-sessions 辨识）
  --list-sessions             列出所有会话（文本模式）
  --browse-sessions           打开 TUI 会话浏览器
  --delete-session <id>       删除指定会话
  --cleanup-sessions          手动触发会话清理

无头模式:
  -p, --print                 无头模式（非交互式，需提供提示词）
  --input-format <fmt>        输入格式 (text/stream-json；stream-json 从 stdin 读流式消息)
  --output-format <fmt>       输出格式 (text/json)
  --include-partial-messages  stream-json 输出模式下包含部分消息增量
  --max-turns <n>             Agent 循环最大轮次
  --verbose                   详细输出（无头模式下输出全量消息数组而非仅最终消息）
  --json-schema <path>        结构化输出 JSON Schema 文件路径（约束 LLM 输出格式）

系统提示词:
  --system-prompt <text>      覆盖系统提示词
  --append-system-prompt <text>  追加到系统提示词
  --system-prompt-file <path>    从文件加载系统提示词
  --append-system-prompt-file <path>  从文件读取内容追加到系统提示词

插件:
  --plugin-dir <path>         会话级插件目录（可重复：--plugin-dir A --plugin-dir B）

配置源:
  --settings <file-or-json>   额外 settings 源（文件路径或内联 JSON，最后一层覆盖）
  --setting-sources <sources> 限定加载的 settings 源（逗号分隔，子集：user/project/local）

MCP:
  --mcp-config <config>       额外 MCP 配置源（文件路径或内联 JSON，可重复）
  --strict-mcp-config         仅用 --mcp-config 指定的服务器，忽略其它来源

子代理:
  --agents <json>             注入子代理定义（内联 JSON: {name:{description,prompt,...}}）
  --agent <name>              整会话使用指定的顶层子代理人格

模型行为:
  --betas <beta>              额外 anthropic-beta 头值（可重复或逗号分隔）

限制控制:
  --max-budget-usd <amount>   花费上限（美元，超限终止）

IDE:
  --ide                       启动即自动连接 IDE（等价 SID_CODE_AUTO_CONNECT_IDE=true）

功能开关:
  --disable-slash-commands    禁用所有斜杠命令（headless/受限场景）

调试:
  -d, --debug                 启用调试模式（日志输出到 ~/.sid-code/debug.log）
  --debug-level <level>       日志级别 (ERROR/WARN/INFO/DEBUG，默认 DEBUG)
  --debug-log-file <path>     自定义日志文件路径

轨迹采集:
  --trace / --no-trace        启用/禁用轨迹采集（默认启用，本地保存到 ~/.sid-code/trajectories/）
  --trace-upload-disabled     强制禁用自动上传（覆盖配置文件，最高优先级）
  --trace-upload-url <url>    轨迹上传平台地址（CLI 覆盖配置文件）
  --trace-upload-token <tok>  上传认证 token（CLI 覆盖配置文件）
  --trace-user-id <id>        用户标识（多用户场景）
  --trace-device-id <id>      设备标识
  --upload-traces             手动触发重试队列补传（处理之前失败的上传）

  上传配置推荐写在 ~/.sid-code/settings.json 的 trace.upload 段，不要硬编码在命令行。
  关键开关：
    trace.upload.auto_upload        是否自动上传（默认 true）
    trace.upload.delete_after_upload 上传后是否删本地（默认 false = 本地保留全量副本）

UI:
  --alternate-buffer          启用全屏 Alternate Buffer 模式（应用内虚拟滚动 + 鼠标滚轮 + Ctrl+S Copy Mode）。
                              默认关闭：走主屏渲染，历史进终端 scrollback，可边流式边用鼠标原生选中复制（ADR-040）

Bridge 远程控制:
  --bridge <ws-url>           进入 Bridge 模式，连接中继服务器接受远程客户端操控（ws:// 或 wss://）
  --bridge-token <token>      Bridge 连接认证令牌

Worktree 隔离:
  --worktree[=<name>]         启动即创建并进入隔离 Git Worktree（省略 name 自动命名为 brave-eagle-42 形态）

其他:
  -h, --help                  显示帮助信息
  -v, --version               显示版本信息

子命令:
  review                      代码审查（从 stdin 或 --diff 文件读取 unified diff）
                                用法: sid-code review [--diff <path>] [--model <model>] [--timeout <ms>]
                                示例: git diff main...HEAD | sid-code review
                                      sid-code review --diff /tmp/pr.diff --model deepseek-v4-pro
  daemon                      本地调度守护进程管理
                                用法: sid-code daemon <start|status|stop|restart> [选项]
                                选项: --webhook            启用 webhook 源
                                      --interval <ms>     调度检查间隔（默认 60000）
                                      --max-concurrent <n> 最大并发 headless job（默认 3）
                                      --allowed-tools <a,b> 全局兜底工具白名单
  update                      下载并替换二进制到最新版（不动 ~/.sid-code/ 数据）
  agents                      列出所有可用子代理（内置/自定义/插件）
                                用法: sid-code agents [--json] [--setting-sources user,project,local]
  mcp                         管理 MCP 服务器配置（不启动会话）
                                用法: sid-code mcp <list|get|add|remove> [参数] [--json]
                                示例: sid-code mcp list
                                      sid-code mcp add fs npx -y @modelcontextprotocol/server-filesystem /tmp --scope user
                                      sid-code mcp remove fs
  auth                        认证配置诊断
                                用法: sid-code auth status [--json]

环境变量:
  ANTHROPIC_API_KEY             Anthropic API 密钥
  OPENAI_API_KEY                OpenAI API 密钥

  LLM 配置:
  SID_CODE_LLM_PROVIDER         LLM 提供商（仅 sid-code 生效，不与其他工具共享）
  SID_CODE_LLM_MODEL            模型名称（仅 sid-code 生效）
  SID_CODE_LLM_BASE_URL         自定义 API 基础 URL（仅 sid-code 生效）
  SID_CODE_LLM_API_KEY          OpenAI 兼容端点的 API 密钥（仅 sid-code 生效）
  SID_CODE_EFFORT_LEVEL         推理强度档位 (low/medium/high/max)；兼容 CLAUDE_CODE_EFFORT_LEVEL
  SID_CODE_THINKING             思考开关覆盖 (on/off/auto)
  SID_MAX_OUTPUT_TOKENS         最大输出 token 数覆盖（缺省 32768）

  轨迹采集:
  SID_CODE_TRACE                设为 1 或 true 启用轨迹采集
  SID_CODE_TRACE_OUTPUT_DIR     自定义轨迹输出目录
  SID_CODE_TRACE_UPLOAD_URL     轨迹上传平台地址
  SID_CODE_TRACE_UPLOAD_TOKEN   上传认证 token
  SID_CODE_TRACE_USER_ID        用户标识
  SID_CODE_TRACE_DEVICE_ID      设备标识

  功能开关:
  SID_CODE_TOOL_SEARCH          工具延迟加载模式 (true/false/auto/auto:N)
  SID_CODE_COORDINATOR_MODE     设为 1 启用 Coordinator 编排模式
  SID_CODE_TEAM_MEMORY          团队记忆同步配置（JSON 对象，如 {"enabled":true,"dir":"/shared"}）
  SID_CODE_AUTO_CONNECT_IDE     设为 true 自动连接 IDE
  SID_CODE_DISABLE_TELEMETRY    设为 1 禁用遥测
  SID_CODE_DISABLE_NONESSENTIAL_TRAFFIC  设为 1 禁用非必要网络流量
  SID_CODE_DISABLE_PROJECT_RULES  设为 1 跳过 CLAUDE.md 加载（评测隔离）
  SID_ENABLE_LOOP_DETECTION     循环检测默认关闭（实测 shape 检测误判率≈100%、exact 召回≈0），设为 1 可显式开启
  SID_ENABLE_BARE_ELLIPSIS_CHECK  裸符号省略号检测 [...]/(...)  默认关闭（实测真阳性 0、误报高），设为 1 可显式开启

  系统路径:
  SID_CONFIG_DIR                配置根目录覆盖（缺省 ~/.sid-code）
  SID_CODE_TMPDIR               临时目录覆盖（沙箱/测试用）

  颜色控制:
  NO_COLOR                      禁用颜色输出（标准约定）
  FORCE_COLOR                   强制颜色级别 (0-3)

  调试/诊断:
  SID_CODE_DEBUG                设为 1 启用调试输出（到 stderr）
  SID_CODE_PROFILE_STARTUP      设为 1 启用启动性能打点
  SID_CODE_DEBUG_SSE            设为 1 启用 SSE 诊断日志
  SID_CODE_PERFETTO_TRACE       启用 Perfetto 追踪输出（性能分析）
  SID_CODE_DIAGNOSTICS_FILE     诊断结果输出文件路径

  子代理/工作流:
  SID_SUBAGENT_MAX_CONCURRENT   子代理并发上限（缺省 3）
  SID_WORKFLOW_MAX_CONCURRENT   工作流并发上限（缺省 min(16, cpu核数-2)）
  SID_WORKFLOW_SYNC_TIMEOUT_MS  工作流同步超时毫秒

  上下文管理:
  SID_OUTPUT_THRESHOLD          工具输出阈值字符数（缺省 30000）
  SID_KEEP_RECENT_OUTPUTS       保留最近输出个数（缺省 6）
  SID_FALLBACK_CONTEXT_WINDOW   未知模型的保守上下文窗口 token 数（缺省 128000）
  SID_RECOVERY_FLOOR_TOKENS     溢出恢复最小输出 token 下限（缺省 3000）

  高级/实验性:
  SID_CODE_PROTOCOL_STRICT      设为 1 启用协议严格模式（默认宽容模式只告警）
  SID_CODE_RESPONSE_HEADER_TIMEOUT_MS  HTTP 响应头超时毫秒
  SID_CODE_WEBHOOK_SECRET       Webhook 认证 token（daemon 使用）
  SID_CODE_SSE_PORT             IDE SSE 端口（IDE 自动发现）
  SID_DISABLE_STRICT_TOOLS      设为 1 禁用 strict 工具模式
  SID_DISABLE_FGTS              设为 1 禁用 First-Guess Tool Streaming
  SID_ENABLE_TOKEN_EFFICIENT_TOOLS  设为 1 启用 token 高效工具
  SID_DISABLE_GLOBAL_CACHE      设为 1 禁用全局缓存
  SID_DISABLE_CACHE_EDITS       设为 1 禁用缓存编辑
  SID_DISABLE_CACHE_WARMUP      设为 1 禁用缓存预热
  SID_WARMUP_CACHE              设为 1 强制启用缓存预热
  SID_LOOP_EXHAUSTED_ACTION     循环耗尽动作（terminate 时回退旧行为）
  SID_STRUCTURED_OUTPUT_MAX_RETRIES  结构化输出最大重试次数（缺省 5）
  SID_DISABLE_TAB_STATUS        设为 1 禁用终端 Tab 状态指示
  SID_CODE_DISABLE_MOUSE_CLICKS 设为 1 禁用鼠标点击
  SID_CODE_VERSION              版本号覆盖（缺省读 package.json）
  SID_CODE_FLAG_<NAME>          Feature Flag 动态覆盖（如 SID_CODE_FLAG_LOOP_DETECTION）

  Hook 脚本可访问的环境变量（运行时注入）:
  SID_CODE_HOOK_EVENT           Hook 事件名
  SID_CODE_PROJECT_DIR          项目目录
  SID_CODE_SESSION_ID           当前会话 ID
  SID_CODE_MODEL                当前模型
  SID_CODE_TOOL_NAME            工具名称
  SID_CODE_TOOL_INPUT           工具输入（JSON）
  SID_CODE_TOOL_OUTPUT          工具输出（JSON）
  SID_CODE_TOOL_IS_ERROR        是否为错误
  SID_CODE_TOOL_USE_ID          工具调用 ID
  SID_CODE_USER_INPUT           用户提示词
  SID_CODE_STOP_REASON          LLM 停止原因
  SID_CODE_AGENT_ID             代理 ID
  SID_CODE_AGENT_TYPE           代理类型

配置文件:
  ~/.sid-code/settings.json   用户级配置（模型/权限/MCP/子代理模型/配额/Hook/搜索/IDE 等）
  ~/.sid-code/app.json        应用配置（调试/遥测/检查点/启动计数等）
  .sid-code/settings.json     项目级配置（优先于用户级）
  .sid-code/settings.local.json  项目级本地配置（gitignore，优先于项目级）
  CLAUDE.md                   项目规则文件（LLM 上下文注入）

  settings.json 支持的主要配置段:
    provider / model / baseURL / maxTokens / fallbackModel / availableModels
    permissionMode / allowedTools / disallowedTools
    effortLevel / thinkingEnabled / language / theme
    subAgentModels              子代理模型映射（按类型分级）
    mcpServers                  MCP 服务器配置
    hooks                       Hook 事件配置
    search                      搜索后端配置（searxng/brave/tavily/duckduckgo）
    trace                       轨迹采集配置
    telemetry                   遥测配置
    analytics                   分析/事件系统配置
    ide                         IDE 集成配置
    teamMemory                  团队记忆同步配置
    sessionRetention            会话保留/自动清理配置
    checkpoint                  文件检查点配置
    quota                       配额管控（costLimit/requestsPerMinute/tokensPerMinute/budgetRules）
    toolSearch                  工具延迟加载模式
    disabledSkills              禁用的 Skill 列表
    disabledHooks               禁用的 Hook 列表
    pluginDirs                  插件目录
    sanitizeEnv                 bash 执行时清理环境变量
    enableLLMClassifier         LLM 命令风险分类器（第二道防线）
    jitContext                  JIT 上下文发现开关
    showLineNumbers             代码块行号显示
    goal                        /goal 目标驱动执行配置
`);
}
