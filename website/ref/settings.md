---
title: settings.json 字段
description: settings.json 的全部可配字段、类型与默认值。
---

# settings.json 字段

settings.json 的全部可配字段、类型与默认值。

<!--
  本页由脚本生成，请勿手工编辑
  AUTO-GEN:START 与 AUTO-GEN:END 标记之间的内容由
  scripts/docs-gen-reference.ts 从源码生成（数据源：SettingsSchema().shape + Config 接口），
  手改会在下次生成时被覆盖，且 pre-commit 会先拦住。
  需要补充说明请写在标记之外——那部分内容会被保留。
  （此提示写给维护者，HTML 注释不会渲染给终端用户。）
-->

<!-- AUTO-GEN:START 由 scripts/docs-gen-reference.ts 生成，勿手工编辑 -->

> 共 **57** 个顶层字段。其中 43 个由
> `SettingsSchema` 声明（类型/枚举/约束经运行时自省导出），14 个标 ⚠ 的字段
> 靠 schema 的 `.passthrough()` 生效——**写了能用，但字段名拼错不会报错，只会静默不生效**。

配置文件位置：`~/.sid-code/settings.json`（用户级）、`.sid-code/settings.json`（项目级，优先）、
`.sid-code/settings.local.json`（项目级本地，gitignore，最优先）。

| 字段 | 类型 | 取值 / 约束 | 说明 |
|---|---|---|---|
| `accentColor` | string | — | UI 强调色/品牌色覆盖（/color 持久化端，settings.json accentColor）。存 hex，缺省=跟随主题 ui.active |
| `allowedDirectories` | array | — | 目录白名单/黑名单 可访问目录白名单（cwd 之外要读写的目录须显式加入；对应 --add-dir） |
| `allowedTools` | array | — | 预授权工具名单（免确认直接执行）。与 toolsWhitelist 不同：这是权限层，不裁剪工具集 |
| `alternateBuffer` | boolean | — | UI 渲染配置 是否启用 alternate buffer（全屏 TUI）模式。 - true（默认，见「幽灵残留根治」方案乙）：全屏 alt-screen 有界视口（ScrollBox+VirtualizedList， overflow… |
| `analytics` ⚠ | object | — | 分析/事件系统配置（spec 17 — analytics 通道） |
| `anthropicKey` | string | — | Anthropic API 密钥（provider=anthropic 时必填；env ANTHROPIC_API_KEY 优先） |
| `askUserQuestionTimeout` | string | — | AskUserQuestion 交互态空闲超时（settings.json askUserQuestionTimeout）。 对齐 claude-code v2.1.200：交互模式下弹出提问对话框后，若用户在此时长内不响应， 按 can… |
| `availableModels` | array | — | 可选模型清单（/model 切换、--fallback-model 校验都以此为范围） |
| `baseURL` | string | — | 自定义 API 基础 URL。注意 anthropic 族与 openai 族对 /v1 后缀的要求相反 |
| `blockedDirectories` | array | — | 禁止访问的目录（黑名单优先于白名单） |
| `checkpoint` ⚠ | object | — | Checkpoint 配置 |
| `classifierModel` | string | — | LLM 分类器使用的模型（默认复用主循环模型 config.model） |
| `costLimit` | number | ≥0 | 成本配额（美元） |
| `disabledHooks` | array | — | 禁用的 Hook 名列表（/hooks disable -p 持久化端） |
| `disabledSkills` | array | — | Skill 配置 禁用的 Skill 名称列表 |
| `disallowedTools` | array | — | 禁用工具名单（拒绝优先于 allowedTools） |
| `effortLevel` | enum | `low` / `medium` / `high` / `xhigh` / `max` | 推理强度档位初值（/effort 持久化端，settings.json effortLevel）。 缺省 = auto（跟随模型默认，不显式下发）。运行时态在 App.runtimeEffort，本字段仅作启动初值。 |
| `enableLLMClassifier` | boolean | — | LLM 命令风险分类器（P0-3 迭代 II） 是否启用 LLM 命令风险分类器（第二道防线，默认 false 保守） |
| `enableSandbox` ⚠ | boolean | — | 是否启用 macOS Seatbelt 沙箱（限制 bash 命令的文件系统和网络访问，默认 false） |
| `env` | object | — | 环境变量 |
| `fallbackModel` | string | — | 主模型失败时的降级模型（必须在 availableModels 中存在），为空字符串则不降级 |
| `fallbackSwitchMode` | enum | `ask` / `auto` / `off` | 主模型重试耗尽后的降级模式：ask 询问用户 / auto 自动切默认 / off 不降级直接报错。 可选——未设时消费点（app.ts）按 "ask" 兜底（生产默认询问）。 |
| `fastMode` | boolean | — | Fast Mode 开关（/fast 持久化端，settings.json fastMode）。缺省 = false。 语义：偏好更快的输出端点/服务档位。当前网关未提供对等 fast 能力，故此开关为「预留」—— 已透传到 fallba… |
| `git` | object | — | Git 集成配置（P3-1：可配置归因） |
| `goal` ⚠ | object | — | /goal 目标驱动持续执行配置（缺省走 DEFAULT_GOAL_CONFIG） |
| `hooks` | object | — | Hook 和 MCP |
| `ide` ⚠ | object | — | IDE 集成配置 |
| `jitContext` | boolean | — | JIT 上下文发现 是否启用 JIT 上下文发现（默认 true） |
| `language` | enum | `zh` / `en` | 输出语言偏好: "zh" 中文优先（默认）, "en" 英文优先。不设置时系统提示词默认中文 |
| `maxThinkingTokens` | number | 整数 ≥0 | §12 P2-1：思考 token 预算上限（settings.json maxThinkingTokens，对标 CC MAX_THINKING_TOKENS）。 env SID_CODE_MAX_THINKING_TOKENS / M… |
| `maxTokens` | number | ≥1000 | 单次响应最大输出 token 数（≥1000） |
| `mcpServers` | object | — | MCP 服务器 |
| `model` | string | — | 主模型名（须在 availableModels 中；/model 可运行时切换） |
| `network` | object | — | 网络超时/重试配置（统一单套保活优先默认值，见 network-profile.ts） |
| `openaiKey` | string | — | OpenAI 兼容端点的 API 密钥（provider=openai/ollama 等；env OPENAI_API_KEY 优先） |
| `outputStyle` ⚠ | string | — | G12：输出风格名（settings.json outputStyle）。 匹配 .sid-code/output-styles/ 或 ~/.sid-code/output-styles/ 下 .md 文件的 name 字段。 不设置时不… |
| `permissionMode` | string | — | 权限配置 支持 6 种模式：default, always-allow, deny-write, acceptEdits, plan, dontAsk |
| `permissions` | object | — | 权限配置 |
| `pluginDirs` ⚠ | array | — | 插件配置 会话级插件目录（--plugin-dir，不持久化，视为 inline 来源） |
| `provider` | string | — | LLM 配置 LLM 提供商（anthropic / openai / ollama 等，决定走哪套协议） |
| `quota` | object | — | 配额管控（增强版，向后兼容 costLimit） |
| `sanitizeEnv` | boolean | — | 环境变量清理 是否在 bash 工具执行时清理环境变量（默认 false） |
| `search` | object | — | 搜索配置 |
| `sessionRetention` ⚠ | object | — | 会话保留配置 |
| `showLineNumbers` ⚠ | boolean | — | UI 配置 代码块是否显示行号（默认 true） |
| `speculativeClassifier` ⚠ | boolean | — | GAP-04：分类器并行预启动（推测执行）。默认 false。 开启后：checker 的同步分类器**放行路径**下沉到 tool-executor 三路竞争，与 UI 弹窗并行， 分类器判定安全时提前跳过弹窗（省 1-2s）。 安全不… |
| `statusLine` | object | — | P1-5 可自定义状态栏（settings.json statusLine，对标 claude-code）。 { type: "command", command: "&lt;脚本>", padding?: number }。缺省 = 走内置聚… |
| `subAgentModels` | object | — | 子代理模型映射 |
| `teamMemory` ⚠ | object | — | 团队记忆同步（E.11 协作护城河） 团队记忆同步配置（共享目录模型） |
| `telemetry` ⚠ | object | — | 遥测配置（OTel 兼容的结构化 Trace） |
| `theme` | string | — | UI 主题名（/theme 持久化端，settings.json theme）。不设置时用内置默认暗色主题 |
| `thinkingEnabled` | boolean | — | 思考开关初值（/think 持久化端，settings.json thinkingEnabled）。 缺省 = auto（跟随模型/provider 默认）。运行时态在 App.runtimeThinking，本字段仅作启动初值。 |
| `toolSearch` ⚠ | union | — | 工具延迟加载（ToolSearch） 工具延迟加载模式（默认 false 关闭）。对标 claude-code ENABLE_TOOL_SEARCH。 取值： - false / 不设置：恒关，全部工具照常进首轮上下文（行为与历史一致）。… |
| `trace` ⚠ | object | — | 轨迹采集配置 |
| `trustProjectExtensions` | boolean | — | 扩展安全配置 是否信任项目级扩展（跳过信任检查，默认 false） |
| `vimMode` | boolean | — | Vim 输入模式开关（/vim 持久化端，settings.json vimMode）。缺省 = false |
| `worktree` | object | — | Worktree 隔离配置 |

<!-- AUTO-GEN:END -->
