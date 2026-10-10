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

> 共 **80** 个顶层字段，全部由 `SettingsSchema` 声明（类型/枚举/约束经运行时自省导出）。
> 写了表里没有的顶层键（多半是拼错）不会报错退出，但启动时会提示「未知配置项」并给出最接近的字段名。

配置文件位置：`~/.sid-code/settings.json`（用户级）、`<启动目录>/.sid-code/settings.json`（项目级，优先）、
`<git 仓库根>/.sid-code/settings.local.json`（项目级本地，gitignore，最优先；启动目录下的旧文件也合并读取）。

| 字段 | 类型 | 取值 / 约束 | 说明 |
|---|---|---|---|
| `accentColor` | string | — | UI 强调色/品牌色覆盖（/color 持久化端，settings.json accentColor）。存 hex，缺省=跟随主题 ui.active |
| `allowedDirectories` | array | — | 可访问目录白名单（cwd 之外要读写的目录须显式加入；对应 --add-dir） |
| `allowedTools` | array | — | 预授权工具名单（免确认直接执行）。与 toolsWhitelist 不同：这是权限层，不裁剪工具集 |
| `alternateBuffer` | boolean | — | 是否启用 alternate buffer（全屏 TUI）模式。 - false（默认）：主屏 Static 渲染，历史进终端 scrollback，鼠标原生选中复制。 2026-07-23 曾把默认改成 true，理由是「执行中工具溢出 scrollback 会留擦不掉的幽灵行」。… |
| `analytics` | object | — | 事件分析通道配置（隐私级别、Feature Flag、远程事件后端），与 telemetry 的 span 通道并行（子键见[下文](#key-analytics)） |
| `anthropicKey` | string | — | Anthropic API 密钥（provider=anthropic 时必填；env ANTHROPIC_API_KEY 优先） |
| `askUserQuestionTimeout` | string | — | AskUserQuestion 交互态空闲超时（settings.json askUserQuestionTimeout）。… |
| `audit` | boolean | — | 审计日志开关（零配置常驻：不依赖 debug，始终把 WARN/ERROR 关键事件落本地， 出问题必有现场。只写本地、不外传。默认开，audit:false 可关）。 |
| `auditLogFile` | string | — | 审计日志落点（缺省 sidPaths.auditLog，即 ~/.sid-code/audit.log；自带 10MB 轮转 + 留 1 备份） |
| `autoDream` | boolean | — | autoDream 自主记忆巩固开关（settings.json autoDream）。 默认关闭——开启后会话结束经三级 gate 判断是否跑后台记忆巩固/剪枝。 |
| `autoMemory` | boolean | — | auto-memory 后台自动提取开关（settings.json autoMemory）。 默认启用（保持既有行为）——每轮 end_turn 后从对话提炼记忆写入 memory 目录。 设为 false 关闭后台提取（隐私敏感项目 / 不想消耗后台 token）。… |
| `autoUpdate` | enum | `off` / `notify` / `auto` | 自动更新模式（缺省 = "auto"）。auto = 后台静默下载安装；notify = 只提示不下载；off = 关闭 |
| `availableModels` | array | — | 可选模型清单（/model 切换、--fallback-model 校验都以此为范围）。每项 name 必须唯一；同一模型接多个渠道时给每条取不同 name，再各自用 model_id 指回厂商真实模型名 |
| `backend` | object | — | 企业后端地址（登录 / 插件市场 / 远程 MCP 共用），如 https://www.sid-code.cc/traj。项目级不可覆盖。（子键见[下文](#key-backend)） |
| `baseURL` | string | — | 自定义 API 基础 URL。注意 anthropic 族与 openai 族对 /v1 后缀的要求相反 |
| `blockedDirectories` | array | — | 禁止访问的目录（黑名单优先于白名单） |
| `bridge` | object | — | Bridge 远程控制配置（D14 准入） |
| `checkpoint` | object | — | 文件快照（checkpoint）配置：每文件快照数、总容量、过期天数等（子键见[下文](#key-checkpoint)） |
| `classifierModel` | string | — | LLM 分类器使用的模型（默认复用主循环模型 config.model） |
| `cleanupPeriodDays` | number | >0 | 旧字段：等价于 sessionRetention.maxAge（天）。两者都写时以 maxAge 为准 |
| `conflictDetection` | boolean | — | 并发冲突检测开关（settings.json conflictDetection）。 默认 true（启用）——Edit/Write 前检查是否有其他会话也声明了同一文件。 设为 false 关闭冲突检测（单用户独占环境 / 不想被打扰）。 |
| `conflictSeverity` | enum | `warn` / `block` / `off` | 并发冲突严重程度阈值（settings.json conflictSeverity）。 - "warn"（默认）：检测到冲突时弹框让用户选择（stop/skip/continue/worktree） - "block"：检测到冲突时直接阻止操作（不弹框，自动按 stop 处理）… |
| `costLimit` | number | >0 | 单会话花费上限（美元） |
| `debug` | boolean | — | 调试日志总开关（等同 -d / --debug），写 debug.log。 |
| `debugLevel` | string | — | 调试日志级别 DEBUG/INFO/WARN/ERROR（缺省 DEBUG；大小写不敏感） |
| `debugLogFile` | string | — | 调试日志落点（缺省 sidPaths.debugLog，即 ~/.sid-code/debug.log；尊重 SID_CONFIG_DIR） |
| `disableAllHooks` | boolean | — | 一键禁用全部 hook（应急/调试）。与企业策略的同名字段是两个来源， 任一为 true 即禁用。。 |
| `disabledHooks` | array | — | 禁用的 Hook 名列表（/hooks disable -p 持久化端） |
| `disabledSkills` | array | — | 禁用的 Skill 名称列表 |
| `disallowedTools` | array | — | 禁用工具名单（拒绝优先于 allowedTools） |
| `effortLevel` | enum | `low` / `medium` / `high` / `xhigh` / `max` | 推理强度档位初值（/effort 持久化端，settings.json effortLevel）。 缺省 = auto（跟随模型默认，不显式下发）。运行时态在 App.runtimeEffort，本字段仅作启动初值。 |
| `enableLLMClassifier` | boolean | — | 是否启用 LLM 命令风险分类器（第二道防线，默认 false 保守） |
| `enableSandbox` | boolean | — | 是否启用 macOS Seatbelt 沙箱（限制 bash 命令的文件系统和网络访问，默认 false） |
| `env` | object | — | 环境变量 |
| `fallbackModel` | string | — | 主模型失败时的降级模型（必须在 availableModels 中存在），为空字符串则不降级 |
| `fallbackSwitchMode` | enum | `ask` / `auto` / `off` | 主模型重试耗尽后的降级模式：ask 询问用户 / auto 自动切默认 / off 不降级直接报错。 可选——未设时消费点按 "ask" 兜底（生产默认询问）。 |
| `fastMode` | boolean | — | Fast Mode 开关（/fast 持久化端，settings.json fastMode）。缺省 = false。 语义：偏好更快的输出端点/服务档位。… |
| `git` | object | — | Git 集成配置（commit / PR 归因）（子键见[下文](#key-git)） |
| `goal` | object | — | /goal 目标驱动持续执行配置（评估模型、轮次上限、卡住检测等；未配置的项走内置默认值）（子键见[下文](#key-goal)） |
| `hooks` | object | — | Hooks（按事件分组）。每条 hook 的 timeout 单位是秒（command / url / agent 默认 60，prompt 默认 30），写 5000 是 83 分钟不是 5 秒 |
| `ide` | object | — | IDE 集成配置（自动连接、发现超时、写盘前 diff 预览）（子键见[下文](#key-ide)） |
| `identity` | object | — | 身份注入段。userId / orgId / teamId 由装机脚本或 managed settings 写入； deviceId 不在这里配（本机持久 UUID）。 未配置时所有功能照常——身份通道 fail-open。（子键见[下文](#key-identity)） |
| `includeCoAuthoredBy` | boolean | — | commit 是否加 Co-Authored-By。缺省 true（保持既有行为）。 比 git.commitAttribution.enabled 更粗：false 直接关掉默认归因，不需要写整段 git 配置。 |
| `jitContext` | boolean | — | 是否启用 JIT 上下文发现（默认 true） |
| `language` | enum | `zh` / `en` / `auto` | 输出语言偏好：`zh` 中文优先（缺省）, `en` 英文优先, `auto` 跟随用户输入语言。 |
| `maxThinkingTokens` | number | 整数 >0 | 思考 token 预算上限（settings.json maxThinkingTokens）。 env SID_CODE_MAX_THINKING_TOKENS / MAX_THINKING_TOKENS 优先；此为 env 未设时的兜底。… |
| `maxTokens` | number | ≥1000 | 单次响应最大输出 token 数（≥1000） |
| `mcpPolicy` | object | — | MCP 安全策略（denylist/allowlist）。合并多源 MCP 配置时按此过滤， 命中 deniedServers 的 server 直接剔除并留痕。默认 undefined（不过滤）。（子键见[下文](#key-mcppolicy)） |
| `mcpServers` | object | — | MCP 服务器 |
| `model` | string | — | 主模型名（须在 availableModels 中；/model 可运行时切换） |
| `network` | object | — | 网络超时/重试配置（统一单套保活优先默认值）（子键见[下文](#key-network)） |
| `openaiKey` | string | — | OpenAI 兼容端点的 API 密钥（provider=openai/ollama 等；env OPENAI_API_KEY 优先） |
| `outputStyle` | string | — | 输出风格名（settings.json outputStyle）。 匹配 .sid-code/output-styles/ 或 ~/.sid-code/output-styles/ 下 .md 文件的 name 字段。 不设置时不注入任何风格约束。 |
| `permissionMode` | enum | `default` / `manual` / `always-allow` / `deny-write` / `acceptEdits` / `plan` / `dontAsk` / `auto` / `dangerously-skip-permissions` | 默认权限模式（manual 是 default 的别名） |
| `permissions` | object | — | 权限配置（子键见[下文](#key-permissions)） |
| `pluginDirs` | array | — | 会话级插件目录（--plugin-dir，不持久化，视为 inline 来源） |
| `provider` | string | — | LLM 提供商（anthropic / openai / ollama 等，决定走哪套协议） |
| `quota` | object | — | 配额（子键见[下文](#key-quota)） |
| `respectGitignore` | boolean | — | grep/glob 是否尊重 .gitignore。缺省 true（与 rg 默认行为一致）。 |
| `sandboxAutoAllowBash` | boolean | — | 沙箱启用时是否自动放行 bash（少弹窗），默认 **false**。 |
| `sanitizeEnv` | boolean | — | 是否在 bash 工具执行时清理环境变量（默认 false） |
| `search` | object | — | 搜索（子键见[下文](#key-search)） |
| `searchTimeoutSeconds` | number | >0 | grep/glob 底层 ripgrep 的超时秒数。缺省 20（WSL 60）；优先于环境变量 SID_GREP_TIMEOUT_SECONDS。 |
| `sessionRetention` | object | — | 会话自动清理配置（按保留时长 / 数量）（子键见[下文](#key-sessionretention)） |
| `showLineNumbers` | boolean | — | 代码块是否显示行号（默认 true） |
| `speculativeClassifier` | boolean | — | 分类器并行预启动（推测执行）。默认 false。 开启后：checker 的同步分类器**放行路径**下沉到 tool-executor 三路竞争，与 UI 弹窗并行， 分类器判定安全时提前跳过弹窗（省 1-2s）。… |
| `statusLine` | object | — | 可自定义状态栏（settings.json statusLine）。 { type: "command", command: "&lt;脚本>", padding?: number }。缺省 = 走内置聚合状态栏。 脚本经 stdin 收 JSON 会话数据，stdout 即状态栏内容（支持 ANSI）。（子键见[下文](#key-statusline)） |
| `subAgentModels` | object | — | 子代理模型映射 |
| `teamMemory` | object | — | 团队记忆同步配置（共享目录模型）（子键见[下文](#key-teammemory)） |
| `telemetry` | object | — | 遥测配置（OTel 兼容的结构化 span，可导出到 console / jsonl / otlp）（子键见[下文](#key-telemetry)） |
| `theme` | string | — | UI 主题名（/theme 持久化端，settings.json theme）。不设置时用内置默认暗色主题 |
| `thinkingEnabled` | boolean | — | 思考开关初值（/think 持久化端，settings.json thinkingEnabled）。 缺省 = auto（跟随模型/provider 默认）。运行时态在 App.runtimeThinking，本字段仅作启动初值。 |
| `toolSearch` | union | — | 工具延迟加载模式（默认 false 关闭）：true 恒开，"auto" 按工具定义占上下文的比例自动判定，数字为自定义阈值百分比。 |
| `toolSearchKeepLoaded` | array | — | 延迟加载豁免名单：命中的工具即使本应延迟（mcp__ 前缀 / shouldDefer），也强制首轮可见。 |
| `trace` | object | — | 轨迹采集与上传配置（本地轨迹目录、保留数量、是否记录原文、上传端点）（子键见[下文](#key-trace)） |
| `trustProjectExtensions` | boolean | — | 是否信任项目级扩展（跳过信任检查，默认 false） |
| `vimMode` | boolean | — | Vim 输入模式开关（/vim 持久化端，settings.json vimMode）。缺省 = false |
| `webFetchExtractModel` | string | — | WebFetch 隔离提炼使用的模型（默认复用主循环模型）。 |
| `webFetchIsolate` | boolean | — | 是否启用 WebFetch 隔离提炼（默认 true）。 |
| `worktree` | object | — | Worktree 隔离配置（子键见[下文](#key-worktree)） |

## 对象字段的子键

> 下表只展开一层；类型取自 zod schema（⚠ 字段取自 TypeScript 接口声明）。

### `analytics` {#key-analytics}

子键也接受 snake_case 写法（如 `privacy_level`），加载时归一。

| 子键 | 类型 | 说明 |
|---|---|---|
| `privacyLevel` | PrivacyLevel | 隐私级别覆盖（环境变量优先级更高） |
| `featureFlagEndpoint` | string | 已弃用：Feature Flag 远程端点。配了 backend.url 时被忽略（地址由它推出），只作兼容 |
| `flags` | Record<string, string \| number \| boolean \| Record<string, unknown>> | 本地 Feature Flag 定义 |
| `backends` | AnalyticsBackendConfig[] | 第三方事件 collector 列表（OTLP / 自建）。企业后端不用配这里：配了 backend.url 即内置上报 |

### `backend` {#key-backend}

| 子键 | 类型 | 说明 |
|---|---|---|
| `url` | string | 企业后端地址（即服务端 PUBLIC_BASE_URL），全部企业通道（登录 / 策略 / 预算 / 账本 / 事件 / flag / 轨迹上传）由它推出路径；只允许 https 或 loopback http。环境变量 SID_CODE_BACKEND_URL 优先 |

### `checkpoint` {#key-checkpoint}

子键也接受 snake_case 写法（如 `max_checkpoints_per_file`），加载时归一。

| 子键 | 类型 | 说明 |
|---|---|---|
| `enabled` | boolean | 是否启用（默认 true） |
| `maxCheckpointsPerFile` | number | 每文件最大快照数（默认 50） |
| `maxTotalSizeMb` | number | 总存储上限（MB，默认 200） |
| `maxAgeDays` | number | 过期天数（默认 30） |
| `compressThresholdKb` | number | 压缩阈值（KB，默认 1） |
| `largeFileThresholdLines` | number | 大文件阈值（行数，默认 1000，超过此值使用 Myers diff） |
| `hugeFileThresholdLines` | number | 超大文件阈值（行数，默认 10000，超过此值直接存 full） |

### `git` {#key-git}

| 子键 | 类型 | 说明 |
|---|---|---|
| `commitAttribution` | object | commit 尾注归因（写入 commit message） |
| `prAttribution` | object | PR 尾注归因（写入 PR 描述） |

### `goal` {#key-goal}

| 子键 | 类型 | 说明 |
|---|---|---|
| `evaluatorModel` | string | 评估者模型。取值顺序见 resolveGoalEvaluatorModel： goal.evaluatorModel → subAgentModels.default → 主模型。 刻意不读 subAgentModels.verify，也**没有**任何内置 haiku 回退——两项都没配时就是主模型自评。 |
| `defaultTokenBudget` | number | 默认 Token 预算（0 = 无限制） |
| `defaultMaxTurns` | number | 默认最大轮次（同时也是 Goal Gate 续命上限） |
| `reminderInterval` | number | reminder 回注间隔（轮次） |
| `enableBlockedDetection` | boolean | 是否启用 blocked 检测（连续 N 轮评估 blockerKey 相同则判定 blocked） |
| `blockedThreshold` | number | blocked 检测阈值（连续相同 blockerKey 的轮次数） |
| `minTurnsBeforeEval` | number | 前 N 轮跳过评估（模型刚开始工作，不可能已完成） |
| `evaluatorTimeout` | number | 评估者调用超时（毫秒） |
| `evalContextMaxChars` | number | 评估者上下文最大字符数（用于 extractEvalContext 截断上限） |

### `ide` {#key-ide}

| 子键 | 类型 | 说明 |
|---|---|---|
| `autoConnect` | boolean | 是否自动连接 IDE（默认 false，在 IDE 内置终端中自动开启） |
| `discoveryTimeout` | number | 自动发现超时（毫秒，默认 30000） |
| `autoInstallExtension` | boolean | 是否自动安装 IDE 扩展（默认 false，扩展尚未发布） |
| `diffPreview` | boolean | 写盘前在 IDE 中展示 diff 并等待用户确认/手改（默认 **false**）。 |

### `identity` {#key-identity}

子键也接受 snake_case 写法（如 `user_id`），加载时归一。

| 子键 | 类型 | 说明 |
|---|---|---|
| `userId` | string | 如 zhangsan@corp.com |
| `orgId` | string | 如 corp-shanghai |
| `teamId` | string | 如 infra-platform |

### `mcpPolicy` {#key-mcppolicy}

| 子键 | 类型 | 说明 |
|---|---|---|
| `deniedServers` | McpPolicyEntry[] | — |
| `allowedServers` | McpPolicyEntry[] | — |

### `network` {#key-network}

| 子键 | 类型 | 说明 |
|---|---|---|
| `headerTimeoutMs` | number >0 | — |
| `watchdogNoProgressMs` | number >0 | — |
| `watchdogCheckIntervalMs` | number >0 | — |
| `watchdogHeaderGraceMs` | number ≥0 | — |
| `maxTurnDurationMs` | number >0 | — |
| `maxSessionDurationMs` | number ≥0 | — |
| `fallbackStreamTimeoutMs` | number >0 | — |
| `streamHeartbeatTimeoutMs` | number >0 | — |
| `maxTimeoutRetries` | number ≥0 | — |
| `maxRetriesPerCall` | number ≥0 | — |
| `retryBackoffBaseMs` | number ≥0 | — |
| `retryBackoffMaxMs` | number >0 | — |
| `idleTimeoutMs` | number >0 | 档①字节级 idle：reader 收不到任何字节的上限 |
| `contentProgressTimeoutMs` | number >0 | 档②事件级无进展：有字节但无有效内容的上限（keep-alive 不续命） |
| `fetchAbsoluteTimeoutMs` | number ≥0 | — |
| `overallTimeoutMs` | number >0 | ②的请求级软兜底（lifecycle Layer 3，不因事件重置） |

### `permissions` {#key-permissions}

| 子键 | 类型 | 说明 |
|---|---|---|
| `defaultMode` | string | — |
| `allow` | array | — |
| `deny` | array | — |
| `ask` | array | — |

### `quota` {#key-quota}

| 子键 | 类型 | 说明 |
|---|---|---|
| `costLimit` | number >0 | 会话成本上限（USD），向后兼容 costLimit |
| `requestsPerMinute` | number >0 | 每分钟请求数上限 |
| `tokensPerMinute` | number >0 | 每分钟 token 数上限 |
| `budgetRules` | array | 多维度预算规则 |

### `search` {#key-search}

| 子键 | 类型 | 说明 |
|---|---|---|
| `backend` | "searxng" \| "brave" \| "tavily" \| "duckduckgo" | 搜索后端: searxng \| brave \| tavily \| duckduckgo |
| `searxngUrl` | string | SearXNG 实例地址 |
| `braveApiKey` | string | Brave Search API Key |
| `tavilyApiKey` | string | Tavily API Key |

### `sessionRetention` {#key-sessionretention}

| 子键 | 类型 | 说明 |
|---|---|---|
| `enabled` | boolean | 是否启用自动清理（默认 true） |
| `maxAge` | string | 最大保留时间（默认 "365d"；格式 数字+h/d/w/m） |
| `maxCount` | number | 最大保留数量（默认不限；防盘满靠 maxTotalSize） |
| `maxTotalSize` | string | 会话 + 轨迹总体积上限（默认 "10GB"），超出才从最旧的开始删 |
| `minRetention` | string | 最小保留时间（防止误删，默认 "1d"） |

### `statusLine` {#key-statusline}

| 子键 | 类型 | 说明 |
|---|---|---|
| `type` | "command" | 目前仅支持 command 类型（跑外部脚本） |
| `command` | string | 要执行的 shell 命令/脚本路径。空则回退内置状态栏。 |
| `padding` | number ≥0 | 左侧留白列数（默认 0） |

### `teamMemory` {#key-teammemory}

| 子键 | 类型 | 说明 |
|---|---|---|
| `enabled` | boolean | 是否启用团队记忆同步（默认 false） |
| `dir` | string | 共享「远端」目录绝对路径（网络盘 / 同步盘 / git 共享路径）。 所有协作者指向同一物理目录；未配置时团队记忆仅本地可用，不跨成员同步。 |
| `debounceMs` | number | debounce 推送等待毫秒（默认 2000，最后一次写入后等待再 push） |

### `telemetry` {#key-telemetry}

子键也接受 snake_case 写法（如 `batch_size`），加载时归一。

| 子键 | 类型 | 说明 |
|---|---|---|
| `enabled` | boolean | 是否启用（默认 false） |
| `exporters` | TelemetryExporterConfig[] | 导出器列表 |
| `batchSize` | number | 批量导出大小（默认 512） |
| `flushIntervalMs` | number | 刷新间隔毫秒（默认 5000） |
| `maxQueueSize` | number | 最大队列大小（默认 2048） |

### `trace` {#key-trace}

子键也接受 snake_case 写法（如 `output_dir`），加载时归一。

| 子键 | 类型 | 说明 |
|---|---|---|
| `enabled` | boolean | 是否启用采集（默认 false） |
| `outputDir` | string | 本地输出目录（默认 ~/.sid-code/trajectories） |
| `maxSessionsRetained` | number | 本地最大保留会话数（默认 100，超过自动清理最旧的） |
| `recordRawPayloads` | boolean | 是否把**请求/响应原文**写进 `raw.jsonl`（默认 `true`，保持既有行为）。 |
| `upload` | TraceUploadConfig | 上传配置 |

#### `trace.upload` {#key-trace-upload}

| 子键 | 类型 | 说明 |
|---|---|---|
| `url` | string | trajectory-platform URL，含路径前缀，如 https://&lt;your-server>/traj。缺省取 backend.url |
| `token` | string | X-Upload-Token 认证 token |
| `autoUpload` | boolean | 是否自动上传（默认 true，false 则仅本地保存） |
| `deleteAfterUpload` | boolean | 上传成功后是否删除本地文件（默认 false = 保留本地全量副本）。 false: 云端 + 本地各保留一份完整数据（开发调试阶段推荐）。 true: 上传确认后清理本地数据文件（仅保留 metadata snapshot）。 |
| `userId` | string | 用户标识（多用户场景区分来源） |
| `deviceId` | string | 设备标识 |
| `toolSource` | string | 工具来源标识（默认 "sid-code"） |
| `maxRetries` | number | 单文件最大重试次数（默认 5） |
| `retryBaseMs` | number | 指数退避基数毫秒（默认 2000；maxRetries=5 时间隔为 2s→4s→8s→16s） |
| `compress` | boolean | 是否 gzip 压缩后上传（默认 true） |
| `healthCheckIntervalMs` | number | 心跳检测间隔毫秒（默认 60000） |
| `maxQueueRetries` | number | 持久化重试队列最大重试次数（默认 50，覆盖约 24 小时） |
| `queueScanIntervalMs` | number | 重试队列扫描间隔毫秒（默认 300000，即 5 分钟） |

### `worktree` {#key-worktree}

| 子键 | 类型 | 说明 |
|---|---|---|
| `symlinkDirectories` | array | 创建 worktree 时额外 symlink 的目录（默认 ["node_modules"]） |
| `sparsePaths` | array | sparse-checkout 路径（monorepo 大仓只检出指定子树） |
| `baseRef` | "fresh" \| "head" | 基准 ref：fresh=origin/&lt;default-branch>，head=当前 HEAD（默认 fresh） |
| `commitAttribution` | boolean | 是否在 worktree 内安装 commit 归因 hook |
| `copyLocalSettings` | boolean | 自动复制到 worktree 的本地配置文件相对路径（默认 settings.local.json） |

<!-- AUTO-GEN:END -->
