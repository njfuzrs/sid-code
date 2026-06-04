/**
 * 帮助文本（独立模块，供 bootstrap 快速路径使用）
 */

export function printHelp(): void {
  console.log(`
sid-code - AI 编程 CLI 工具

用法:
  sid-code [选项] [提示词]

LLM 配置:
  --provider <name>           LLM 提供商 (anthropic/openai/ollama)
  -m, --model <name>          模型名称
  --max-tokens <n>            响应最大 token 数

权限配置:
  --permission-mode <mode>    权限模式 (default/always-allow/deny-write)
  --dangerously-skip-permissions  跳过所有权限检查
  -y, --yes                   自动批准所有权限请求

会话配置:
  -c, --continue              继续最近一次会话
  -r, --resume <id>           恢复指定会话（ID 或索引）
  --list-sessions             列出所有会话（文本模式）
  --browse-sessions           打开 TUI 会话浏览器
  --delete-session <id>       删除指定会话
  --cleanup-sessions          手动触发会话清理

无头模式:
  -p, --print                 无头模式（非交互式）
  --output-format <fmt>       输出格式 (text/json)
  --max-turns <n>             Agent 循环最大轮次

系统提示词:
  --system-prompt <text>      覆盖系统提示词
  --append-system-prompt <text>  追加到系统提示词
  --system-prompt-file <path>    从文件加载系统提示词

调试:
  -d, --debug                 启用调试模式（日志输出到 ~/.sid-code/debug.log）
  --debug-level <level>       日志级别 (ERROR/WARN/INFO/DEBUG，默认 DEBUG)
  --debug-log-file <path>     自定义日志文件路径

轨迹采集:
  --trace / --no-trace        启用/禁用轨迹采集（默认启用，本地保存到 ~/.sid-code/trajectories/）
  --trace-upload-url <url>    轨迹上传平台地址（如 http://xxx/traj）
  --trace-upload-token <tok>  上传认证 token（X-Upload-Token）
  --trace-user-id <id>        用户标识（多用户场景）
  --trace-device-id <id>      设备标识
  --upload-traces             手动触发重试队列补传（处理之前失败的上传）

UI:
  --alternate-buffer          启用全屏 Alternate Buffer 模式（应用内虚拟滚动 + 鼠标滚轮 + Ctrl+S Copy Mode）。
                              默认关闭：走主屏渲染，历史进终端 scrollback，可边流式边用鼠标原生选中复制（ADR-040）

Bridge 远程控制:
  --bridge <ws-url>           进入 Bridge 模式，连接中继服务器接受远程客户端操控（ws:// 或 wss://）
  --bridge-token <token>      Bridge 连接认证令牌

其他:
  -h, --help                  显示帮助信息
  -v, --version               显示版本信息

环境变量:
  ANTHROPIC_API_KEY           Anthropic API 密钥
  OPENAI_API_KEY              OpenAI API 密钥
  SID_CODE_LLM_PROVIDER       LLM 提供商（仅 sid-code 生效，不与其他工具共享）
  SID_CODE_LLM_MODEL          模型名称（仅 sid-code 生效）
  SID_CODE_LLM_BASE_URL       自定义 API 基础 URL（仅 sid-code 生效）
  SID_CODE_LLM_API_KEY        OpenAI 兼容端点的 API 密钥（仅 sid-code 生效）
  SID_CODE_TRACE              设为 1 或 true 启用轨迹采集
  SID_CODE_TRACE_OUTPUT_DIR   自定义轨迹输出目录
  SID_CODE_TRACE_UPLOAD_URL   轨迹上传平台地址
  SID_CODE_TRACE_UPLOAD_TOKEN 上传认证 token
  SID_CODE_TRACE_USER_ID      用户标识
  SID_CODE_TRACE_DEVICE_ID    设备标识

配置文件:
  ~/.sid-code/config.yaml     YAML 格式配置文件
`);
}
