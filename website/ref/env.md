---
title: 环境变量
description: 全部可用环境变量及其作用。
---

# 环境变量

全部可用环境变量及其作用。

<!--
  本页由脚本生成，请勿手工编辑
  AUTO-GEN:START 与 AUTO-GEN:END 标记之间的内容由
  scripts/docs-gen-reference.ts 从源码生成（数据源：src/help.ts + 源码扫描），
  手改会在下次生成时被覆盖，且 pre-commit 会先拦住。
  需要补充说明请写在标记之外——那部分内容会被保留。
  （此提示写给维护者，HTML 注释不会渲染给终端用户。）
-->

<!-- AUTO-GEN:START 由 scripts/docs-gen-reference.ts 生成，勿手工编辑 -->

> 共 **82** 个环境变量，取自 `sid-code --help` 的环境变量段，
> 并与源码里实际的 `process.env` 读取点（扫到 86 个）交叉核对。

> 优先级：环境变量 > `settings.json`。`SID_*` 前缀的变量只对 sid-code 生效，
> 不与同机的其他工具共享。

## 通用

| 变量 | 说明 |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic API 密钥 |
| `OPENAI_API_KEY` | OpenAI API 密钥 |
| `SID_CODE_LLM_PROVIDER` | LLM 提供商（仅 sid-code 生效，不与其他工具共享） |
| `SID_CODE_LLM_MODEL` | 模型名称（仅 sid-code 生效） |
| `SID_CODE_LLM_BASE_URL` | 自定义 API 基础 URL（仅 sid-code 生效） |
| `SID_CODE_LLM_API_KEY` | OpenAI 兼容端点的 API 密钥（仅 sid-code 生效） |
| `SID_CODE_EFFORT_LEVEL` | 推理强度档位 (low/medium/high/max)；兼容 CLAUDE_CODE_EFFORT_LEVEL |
| `SID_CODE_THINKING` | 思考开关覆盖 (on/off/auto) |
| `SID_MAX_OUTPUT_TOKENS` | 最大输出 token 数覆盖（缺省 32768） |
| `SID_MODEL_CATALOG_TTL_MS` | 外部模型目录同步 TTL 毫秒（缺省 86400000，即 1 天）；设小值可强制重新采集模型能力 |

## 轨迹采集

| 变量 | 说明 |
|---|---|
| `SID_CODE_TRACE` | 设为 1 或 true 启用轨迹采集 |
| `SID_CODE_TRACE_OUTPUT_DIR` | 自定义轨迹输出目录 |
| `SID_CODE_TRACE_NO_RAW` | 设为 1 不把 prompt/响应原文写进 raw.jsonl |
| `SID_CODE_TRACE_UPLOAD_URL` | 轨迹上传平台地址 |
| `SID_CODE_TRACE_UPLOAD_TOKEN` | 上传认证 token |
| `SID_CODE_TRACE_USER_ID` | 用户标识 |
| `SID_CODE_TRACE_DEVICE_ID` | 设备标识 |

## 功能开关

| 变量 | 说明 |
|---|---|
| `SID_CODE_TOOL_SEARCH` | 工具延迟加载模式 (true/false/auto/auto:N) |
| `SID_CODE_COORDINATOR_MODE` | 设为 1 启用 Coordinator 编排模式 |
| `SID_CODE_TEAM_MEMORY` | 团队记忆同步配置（JSON 对象，如 {"enabled":true,"dir":"/shared"}） |
| `SID_CODE_AUTO_CONNECT_IDE` | 设为 true 自动连接 IDE |
| `SID_CODE_DISABLE_TELEMETRY` | 设为 1 禁用遥测 |
| `SID_CODE_DISABLE_NONESSENTIAL_TRAFFIC` | 设为 1 禁用非必要网络流量 |
| `SID_CODE_DISABLE_PROJECT_RULES` | 设为 1 跳过 CLAUDE.md 加载（评测隔离） |
| `SID_CODE_AUTO_MEMORY` | 后台自动提取记忆开关 (0/1，缺省启用；优先于 settings.autoMemory) |
| `SID_MAX_TURNS` | 单条用户消息的软轮次阈值（正整数，缺省不启用）：达阈值时提醒模型收尾，不强制中断 |
| `SID_ENABLE_LOOP_DETECTION` | 循环检测默认关闭（实测 shape 检测误判率≈100%、exact 召回≈0），设为 1 可显式开启 |
| `SID_ENABLE_BARE_ELLIPSIS_CHECK` | 裸符号省略号检测 [...]/(...) 默认关闭（实测真阳性 0、误报高），设为 1 可显式开启 |
| `SID_ENABLE_HYPOTHESIS` | 假设登记表（含矛盾中断/交付门禁）默认关闭：受控 A/B 实测 ON/OFF 准确率同为 5.00/5，ON 却多花 +75% input、+61% 耗时，设为 1 可显式开启 |

## 系统路径

| 变量 | 说明 |
|---|---|
| `SID_CONFIG_DIR` | 配置根目录覆盖（缺省 ~/.sid-code） |
| `SID_CODE_TMPDIR` | 临时目录覆盖（沙箱/测试用） |
| `SID_RIPGREP_PATH` | 指定 rg 可执行文件路径（缺省用内嵌释放的 rg，再回退系统 PATH；sid-code doctor 会显示实际来源） |
| `SID_GREP_TIMEOUT_SECONDS` | grep/glob 搜索超时秒数（缺省 20，WSL 下 60） |

## 颜色控制

| 变量 | 说明 |
|---|---|
| `NO_COLOR` | 禁用颜色输出（标准约定） |
| `FORCE_COLOR` | 强制颜色级别 (0-3) |

## 调试/诊断

| 变量 | 说明 |
|---|---|
| `SID_CODE_DEBUG` | 设为 1 启用调试输出（到 stderr） |
| `SID_CODE_PROFILE_STARTUP` | 设为 1 启用启动性能打点 |
| `SID_CODE_DEBUG_SSE` | 设为 1 启用 SSE 诊断日志 |
| `SID_CODE_PERFETTO_TRACE` | 启用 Perfetto 追踪输出（性能分析） |
| `SID_CODE_DIAGNOSTICS_FILE` | 诊断结果输出文件路径 |
| `SID_CODE_CONTENT_TRACING` | 设为 1 启用内容级 tracing（span 携带 prompt/响应/工具输出原文；默认关闭，隐私敏感） |
| `SID_CODE_REPLAY_FILE` | 录制回放：指向一个 raw.jsonl，配合 --provider replay 重放该会话 |
| `SID_CODE_REPLAY_ON_EXHAUSTED` | 录制耗尽后的行为 (end-turn/repeat-last/throw，缺省 end-turn) |

## 子代理/工作流

| 变量 | 说明 |
|---|---|
| `SID_SUBAGENT_MAX_CONCURRENT` | 子代理并发上限（缺省 3） |
| `SID_CODE_SUBAGENT_TIMEOUT_MS` | 子代理超时毫秒统一覆盖（缺省按 agent 声明值与实测 p95 派生） |
| `SID_TOOL_MAX_CONCURRENT` | 工具并发上限（缺省 10） |
| `SID_WORKFLOW_MAX_CONCURRENT` | 工作流并发上限（缺省 min(16, cpu核数-2)） |
| `SID_WORKFLOW_SYNC_TIMEOUT_MS` | 工作流同步超时毫秒 |

## 上下文管理

| 变量 | 说明 |
|---|---|
| `SID_OUTPUT_THRESHOLD` | 工具输出阈值字符数（缺省 30000） |
| `SID_KEEP_RECENT_OUTPUTS` | 保留最近输出个数（缺省 6） |
| `SID_FALLBACK_CONTEXT_WINDOW` | 未知模型的保守上下文窗口 token 数（缺省 128000） |
| `SID_RECOVERY_FLOOR_TOKENS` | 溢出恢复最小输出 token 下限（缺省 3000） |
| `SID_CODE_MAX_MCP_OUTPUT_TOKENS` | MCP 工具输出 token 上限（缺省 25000）；兼容无前缀的 MAX_MCP_OUTPUT_TOKENS |

## 高级/实验性

| 变量 | 说明 |
|---|---|
| `SID_CODE_PROTOCOL_STRICT` | 设为 1 启用协议严格模式（默认宽容模式只告警） |
| `SID_CODE_RESPONSE_HEADER_TIMEOUT_MS` | HTTP 响应头超时毫秒 |
| `SID_CODE_WEBHOOK_SECRET` | Webhook 认证 token（daemon 使用） |
| `SID_CODE_SSE_PORT` | IDE SSE 端口（IDE 自动发现） |
| `SID_DISABLE_STRICT_TOOLS` | 设为 1 禁用 strict 工具模式 |
| `SID_DISABLE_FGTS` | 设为 1 禁用 First-Guess Tool Streaming |
| `SID_ENABLE_TOKEN_EFFICIENT_TOOLS` | 设为 1 启用 token 高效工具 |
| `SID_DISABLE_GLOBAL_CACHE` | 设为 1 禁用全局缓存 |
| `SID_DISABLE_CACHE_EDITS` | 设为 1 禁用缓存编辑 |
| `SID_DISABLE_CACHE_WARMUP` | 设为 1 禁用缓存预热 |
| `SID_WARMUP_CACHE` | 设为 1 强制启用缓存预热 |
| `SID_LOOP_EXHAUSTED_ACTION` | 循环耗尽动作（terminate 时回退旧行为） |
| `SID_STRUCTURED_OUTPUT_MAX_RETRIES` | 结构化输出最大重试次数（缺省 5） |
| `SID_DISABLE_TAB_STATUS` | 设为 1 禁用终端 Tab 状态指示 |
| `SID_CODE_DISABLE_MOUSE_CLICKS` | 设为 1 禁用鼠标点击 |
| `SID_CODE_VERSION` | 版本号覆盖（缺省读 package.json） |

## Hook 脚本可访问的环境变量（运行时注入）

| 变量 | 说明 |
|---|---|
| `SID_CODE_HOOK_EVENT` | Hook 事件名 |
| `SID_CODE_PROJECT_DIR` | 项目目录 |
| `SID_CODE_SESSION_ID` | 当前会话 ID |
| `SID_CODE_MODEL` | 当前模型 |
| `SID_CODE_TOOL_NAME` | 工具名称 |
| `SID_CODE_TOOL_INPUT` | 工具输入（JSON） |
| `SID_CODE_TOOL_OUTPUT` | 工具输出（JSON） |
| `SID_CODE_TOOL_IS_ERROR` | 是否为错误 |
| `SID_CODE_TOOL_USE_ID` | 工具调用 ID |
| `SID_CODE_USER_INPUT` | 用户提示词 |
| `SID_CODE_STOP_REASON` | LLM 停止原因 |
| `SID_CODE_AGENT_ID` | 代理 ID |
| `SID_CODE_AGENT_TYPE` | 代理类型 |

## 未列入上表的读取点（36）

源码里有读取、但未写进 `--help` 环境变量段的变量。多为内部/测试用途，**不保证向后兼容，不建议依赖**：

`CLAUDE_CODE_COMMIT_LOG`、`CLAUDE_CODE_DEBUG_REPAINTS`、`CLAUDE_CODE_SUBAGENT_MODEL`、`CLAUDE_CODE_TMUX_TRUECOLOR`、`SIDCODE_AGENT_PROGRESS_SUMMARY`、`SIDCODE_MAX_OLD_SPACE_SIZE`、`SIDCODE_NO_SPAWN`、`SIDCODE_SSE_EVENT_SHIM`、`SID_CODE_ALERT_WEBHOOK_URL`、`SID_CODE_CACHE_BREAKS`、`SID_CODE_CHANNEL_TRUST`、`SID_CODE_DEBUG_SSE_DUMP`、`SID_CODE_DISABLE_POLICY_SKILLS`、`SID_CODE_DISABLE_SKILL_HOT_RELOAD`、`SID_CODE_HOME`、`SID_CODE_INSTALL_URL`、`SID_CODE_MEMORY_RECALL`、`SID_CODE_OPENAI_PROTOCOL`、`SID_CODE_PAIRING_TIMEOUT_MS`、`SID_CODE_RELEASE_HOST`、`SID_CODE_SESSION_INDEX`、`SID_CODE_STRUCTURED_OUTPUT_MAX_RETRIES`、`SID_CODE_USAGE_FILE`、`SID_CODE_USAGE_LEDGER`、`SID_DISABLE_EDIT_FAILURE_REMINDER`、`SID_DISABLE_TOOL_CACHE`、`SID_EDIT_FAILURE_REMINDER_THRESHOLD`、`SID_ENABLE_AGENT_TEAMS`、`SID_ENABLE_GOAL_HARD_STOP`、`SID_ENABLE_MIDTURN_DRAIN`、`SID_ENABLE_NESTED_SUBAGENT`、`SID_ENABLE_OUTPUT_STALL`、`SID_ENABLE_STREAMING_TOOL_EXEC`、`SID_ENABLE_THINKING_DIVERGENCE`、`SID_SUBAGENT_MAX_DEPTH`、`SID_TEAMMATE_MODE`

<!-- AUTO-GEN:END -->
