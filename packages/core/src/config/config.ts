/**
 * 配置加载模块
 * 优先级：命令行参数 > 环境变量 > 配置文件 > 默认值
 * 配置文件位置：~/.sid-code/settings.json + ~/.sid-code/app.json（唯一真相源）
 */

import { join } from "path";
import { existsSync, mkdirSync } from "fs";
import { getLogger } from "../debug/logger.ts";
import { getSidHome } from "./paths.ts";
import { parseToolSearchEnv } from "../tool/tool-search-auto.ts";
import type { NetworkTimeoutSettings } from "./network-profile.ts";
import type { LanguagePref } from "./prompt-lang.ts";

/**
 * 团队默认配置模板（scripts/team-defaults.template.json）里 apiKey 的占位符值。
 * 首次安装 install.sh 整份拷贝模板到 settings.json，key 就是这个占位符——用户必须换成真 key。
 * 非空字符串,故会绕过"缺 key"的空值校验;各处需显式识别它并视同"未配置",
 * 否则新用户不换 key 直接发消息会撞 401 而无任何引导提示。
 */
export const PLACEHOLDER_API_KEY = "__YOUR_API_KEY__";

/** apiKey 是否等价于"未配置"（空 / 纯空白 / 团队模板占位符）。 */
export function isMissingApiKey(key?: string | null): boolean {
  if (!key) return true;
  const trimmed = key.trim();
  return trimmed === "" || trimmed === PLACEHOLDER_API_KEY;
}

/** MCP 服务器配置 */
export interface MCPServerConfig {
  // G4：http = Streamable HTTP（2025-03-26 规范，默认，对齐 CC）；http-json = 旧单 JSON 传输（兼容保留）
  transport: "stdio" | "http" | "http-json" | "sse" | "ws";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  enabled?: boolean; // 默认 true，可临时禁用服务器
  timeout?: number; // 请求超时毫秒，默认 30000
  retries?: number; // 重试次数，默认 2
  includeTools?: string[]; // 工具白名单（优先于 excludeTools）
  excludeTools?: string[]; // 工具黑名单
  // ─── IDE 集成元数据（动态注册的 IDE MCP server 使用，对标 Claude Code sse-ide/ws-ide） ───
  authToken?: string; // 认证令牌（注入为 Authorization: Bearer 头）
  ideName?: string; // IDE 名称（VS Code / Cursor / JetBrains 等）
  ideRunningInWindows?: boolean; // IDE 是否运行在 Windows 上（WSL 场景）
  scope?: "user" | "project" | "local" | "dynamic"; // 配置来源标记
  // ─── OAuth 2.1 接入（远程 MCP：Linear / Sentry / claude.ai 等，对标 Claude Code auth.ts） ───
  oauth?: MCPOAuthConfig; // 启用/配置 OAuth；为对象（含空对象 {}）即视为启用
}

/** MCP OAuth 配置（远程 HTTP/SSE 服务器） */
export interface MCPOAuthConfig {
  /** 预配置 client_id（跳过动态注册，对标 CC oauth.clientId） */
  clientId?: string;
  /** 机密客户端的 client_secret（公共客户端留空，走 PKCE） */
  clientSecret?: string;
  /** 直接指定授权服务器 metadata URL，跳过 RFC 9728/8414 发现（必须 https） */
  authServerMetadataUrl?: string;
  /** 请求的 scope（空格分隔；留空则用授权服务器 metadata 通告的 scope） */
  scope?: string;
  /** 固定本地回调端口（默认随机选取空闲端口） */
  callbackPort?: number;
}

/** Hook 配置（支持 command / url / prompt / agent 四种类型） */
export interface HookConfig {
  type?: "command" | "url" | "prompt" | "agent"; // 钩子类型，默认 command
  event?: string; // 旧格式兼容：事件名
  command?: string; // command 类型：shell 命令
  url?: string; // url 类型：HTTP 地址
  method?: string; // url 类型：HTTP 方法，默认 POST
  headers?: Record<string, string>; // url 类型：HTTP 头
  timeout?: number; // 超时（秒），默认 30
  blocking?: boolean; // 是否阻塞，默认 false
  async?: boolean; // G7：command 类型后台异步执行，不阻塞主循环
  asyncRewake?: boolean; // G7：后台 hook exit 2 时，其 stderr 下一轮回灌唤醒模型
  matcher?: string; // 工具匹配（精确或 /regex/）
  if?: string; // G10：tool_input 细粒度条件（权限规则语法，如 Bash(git *)）
  // ─── prompt / agent 类型（LLM 层 hook，G5） ───
  name?: string; // hook 名称（可观测性/日志）
  prompt?: string; // prompt/agent 类型：验证提示词
  model?: string; // prompt/agent 类型：使用的模型（默认走 side-call 模型）
  tools?: string[]; // agent 类型：子代理可用工具白名单
}

/** Hook 配置集合（按事件分组，新格式） */
export type HooksConfig = Record<string, HookConfig[]>;

/** 子代理模型映射（从 registry 重导出，方便配置层使用） */
export type { SubAgentModelMap } from "../llm/registry.ts";

// 定价类型复用 cost-tracker.ts 的单一真相源
// 用 import 引入本地作用域（下方 ModelConfig.pricing 要用），再 re-export 对外暴露
import type { ModelPricing } from "../api/cost-tracker.ts";
export type { ModelPricing };

// 协议能力声明（compat 布尔位）的单一真相源在 llm/model-compat.ts。
// 同样先 import 进本地作用域（下方 ModelConfig.compat 要用）再 re-export 对外暴露。
import type { ModelCompat } from "../llm/model-compat.ts";
export type { ModelCompat };

/** 可用模型配置 */
export interface ModelConfig {
  /**
   * 本地别名（唯一）——`/model` 选择、fallback、子代理、计价、审计全按它匹配。
   *
   * 想让同一个模型同时接两个渠道（如公司网关 + 官方端点），就给两条取不同的 `name`
   * （如 xxx-gateway / xxx-official），再各自用 `modelId` 指回同一个厂商真名。
   * 光改 name 不配 modelId 会把别名当模型名发给厂商 → 400/404，见 modelId 注释。
   */
  name: string;
  /**
   * 发往厂商的**真实模型 id**（wire model）。缺省 = `name`。
   *
   * 存在的唯一理由：`name` 要在本地唯一（否则第二条永远选不中），但厂商只认它自己的模型名。
   * 两者拆开后，「哪一条配置」用 `name`，「这到底是什么模型」用 `modelId`：
   *   - 用 name（别名）：模型选择 / `/model` 显示 / fallback / 子代理 / 计价（(name,endpoint) 复合键）/ 审计
   *   - 用 modelId（真名）：HTTP 请求体 model 字段 / 能力判定（thinking、effort）/ 内置注册表兜底
   *     （上下文窗口、输出上限）——注册表靠前缀与家族匹配，喂别名会静默 miss 退化到兜底值
   *
   * 解析入口统一走 `resolveWireModel()`，不要在消费点各自写 `mc.modelId || mc.name`。
   */
  modelId?: string;
  provider?: string;
  baseURL?: string;
  apiKey?: string;
  contextWindow?: number; // 上下文窗口（tokens）
  maxOutputTokens?: number; // 最大输出 tokens
  supportsThinking?: boolean; // 是否支持 Extended Thinking
  /** 可选：用户自配价格。配了则优先使用，未配则回退内置定价表兜底 */
  pricing?: ModelPricing;
  /**
   * 可选：这条渠道的**协议能力声明**（6 个布尔位，见 `llm/model-compat.ts`）。
   *
   * 存在的理由：族差异此前只能表达为**代码**（`effort.ts` 813 行族矩阵 + 199 处族关键字
   * 散在 15 个文件），于是上一家新厂商就要改一次代码——而判据往往只是「这家认不认
   * `thinking` 字段」这种一个布尔位就够的事实。配了它，加一家兼容端点从改代码变成配一行。
   *
   * 三层优先级（`compat` 最高）：**用户声明 > 内置注册表按名匹配 > 400 自愈兜底**。
   * ⚠ 它**不替代**自愈——私有网关上的私有模型名注册表必然 miss，只有用户知道它认什么；
   * 但用户也会配错，配错了仍要靠 `withCapabilityHealing`（`llm/openai.ts:650`）救回来。
   *
   * 按**渠道**（name）而非模型真名生效：同一真名接官方端点与公司网关，网关那条可能因为
   * 自己做了参数透传过滤而不认某些字段。与 `supportsThinking` 的既有口径一致。
   *
   * 缺省（不配）时行为与此前**完全一致**：全部回落内置判定。`undefined` ≠ `false`。
   */
  compat?: ModelCompat;
}

/** 应用配置 */
export interface Config {
  // LLM 配置
  /** LLM 提供商（anthropic / openai / ollama 等，决定走哪套协议） */
  provider: string;
  /** 主模型名（须在 availableModels 中；/model 可运行时切换） */
  model: string;
  /** 主模型失败时的降级模型（必须在 availableModels 中存在），为空字符串则不降级 */
  fallbackModel: string;
  /**
   * 主模型重试耗尽后的降级模式：ask 询问用户 / auto 自动切默认 / off 不降级直接报错。
   * 可选——未设时消费点（app.ts）按 "ask" 兜底（生产默认询问）。
   */
  fallbackSwitchMode?: "ask" | "auto" | "off";
  /** Anthropic API 密钥（provider=anthropic 时必填；env ANTHROPIC_API_KEY 优先） */
  anthropicKey: string;
  /** OpenAI 兼容端点的 API 密钥（provider=openai/ollama 等；env OPENAI_API_KEY 优先） */
  openaiKey: string;
  /** 自定义 API 基础 URL。注意 anthropic 族与 openai 族对 /v1 后缀的要求相反 */
  baseURL: string;
  /** 单次响应最大输出 token 数（≥1000） */
  maxTokens: number;
  /** 可选模型清单（/model 切换、--fallback-model 校验都以此为范围）。每项 name 必须唯一；同一模型接多个渠道时给每条取不同 name，再各自用 model_id 指回厂商真实模型名 */
  availableModels: ModelConfig[];
  /** 网络超时/重试配置（统一单套保活优先默认值，见 network-profile.ts） */
  network?: NetworkTimeoutSettings;
  /**
   * 输出语言偏好：`zh` 中文优先（缺省）, `en` 英文优先, `auto` 跟随用户输入语言。
   *
   * 优先级：`--language` > `SID_LANGUAGE` 环境变量 > settings.json > 缺省（zh）。
   * 不设置时系统提示词默认中文——「中文优先」是产品定位，不要改成 auto。
   * 详见 config/prompt-lang.ts。
   */
  language?: LanguagePref;
  /**
   * G12：输出风格名（settings.json outputStyle）。
   * 匹配 .sid-code/output-styles/ 或 ~/.sid-code/output-styles/ 下 .md 文件的 name 字段。
   * 不设置时不注入任何风格约束。
   */
  outputStyle?: string;
  /**
   * G10：autoDream 自主记忆巩固开关（settings.json autoDream）。
   * 默认关闭——开启后会话结束经三级 gate 判断是否跑后台记忆巩固/剪枝。
   */
  autoDream?: boolean;
  /**
   * M2：auto-memory 后台自动提取开关（settings.json autoMemory）。
   * 默认启用（保持既有行为）——每轮 end_turn 后从对话提炼记忆写入 memory 目录。
   * 设为 false 关闭后台提取（隐私敏感项目 / 不想消耗后台 token）。
   * 优先级：env SID_CODE_AUTO_MEMORY > settings autoMemory > 默认 true。
   */
  autoMemory?: boolean;
  /** UI 主题名（/theme 持久化端，settings.json theme）。不设置时用内置默认暗色主题 */
  theme?: string;
  /** Vim 输入模式开关（/vim 持久化端，settings.json vimMode）。缺省 = false */
  vimMode?: boolean;
  /**
   * P1-5 可自定义状态栏（settings.json statusLine，对标 claude-code）。
   * { type: "command", command: "<脚本>", padding?: number }。缺省 = 走内置聚合状态栏。
   * 脚本经 stdin 收 JSON 会话数据，stdout 即状态栏内容（支持 ANSI）。
   */
  statusLine?: import("./statusline-types.ts").StatusLineConfig;

  /**
   * 推理强度档位初值（/effort 持久化端，settings.json effortLevel）。
   * 缺省 = auto（跟随模型默认，不显式下发）。运行时态在 App.runtimeEffort，本字段仅作启动初值。
   */
  effortLevel?: "low" | "medium" | "high" | "xhigh" | "max";
  /**
   * 思考开关初值（/think 持久化端，settings.json thinkingEnabled）。
   * 缺省 = auto（跟随模型/provider 默认）。运行时态在 App.runtimeThinking，本字段仅作启动初值。
   */
  thinkingEnabled?: boolean;
  /**
   * §12 P2-1：思考 token 预算上限（settings.json maxThinkingTokens，对标 CC MAX_THINKING_TOKENS）。
   * env SID_CODE_MAX_THINKING_TOKENS / MAX_THINKING_TOKENS 优先；此为 env 未设时的兜底。
   * 透传到 SendParams.maxThinkingTokens，由 effort.ts 钳制思考预算。缺省 = 不钳制。
   */
  maxThinkingTokens?: number;

  /**
   * AskUserQuestion 交互态空闲超时（settings.json askUserQuestionTimeout）。
   * 对齐 claude-code v2.1.200：交互模式下弹出提问对话框后，若用户在此时长内不响应，
   * 按 cancelled 自动解除（模型收到"请选默认继续"），避免带 TUI handler 的编排器/后台
   * 子代理场景被单个提问无限期阻塞。
   * 取值："60s" / "5m" / "never"（或纯数字=毫秒）。缺省 = "never"（保守，对齐 CC 默认）。
   * 注意：headless/SDK/CI 无 handler 时本就返回 unavailable 不阻塞，本设置只作用于交互态。
   */
  askUserQuestionTimeout?: string;

  // 权限配置
  // 支持 6 种模式：default, always-allow, deny-write, acceptEdits, plan, dontAsk
  permissionMode: string;
  skipPermissions: boolean;
  /** 预授权工具名单（免确认直接执行）。与 toolsWhitelist 不同：这是权限层，不裁剪工具集 */
  allowedTools: string[];
  /** 禁用工具名单（拒绝优先于 allowedTools） */
  disallowedTools: string[];
  yesMode: boolean;
  /** P2-1：CLI 权限规则（cliArg 源，规则语法如 "Bash(curl *)"）。--allow-tool / --deny-tool。 */
  cliAllowRules?: string[];
  cliDenyRules?: string[];

  // 并发冲突检测配置（Phase 2.4）
  /**
   * 并发冲突检测开关（settings.json conflictDetection）。
   * 默认 true（启用）——Edit/Write 前检查是否有其他会话也声明了同一文件。
   * 设为 false 关闭冲突检测（单用户独占环境 / 不想被打扰）。
   */
  conflictDetection?: boolean;
  /**
   * 并发冲突严重程度阈值（settings.json conflictSeverity）。
   * - "warn"（默认）：检测到冲突时弹框让用户选择（stop/skip/continue/worktree）
   * - "block"：检测到冲突时直接阻止操作（不弹框，自动按 stop 处理）
   * - "off"：不检测（等价 conflictDetection=false）
   */
  conflictSeverity?: "warn" | "block" | "off";

  // 目录白名单/黑名单
  /** 可访问目录白名单（cwd 之外要读写的目录须显式加入；对应 --add-dir） */
  allowedDirectories: string[];
  /** 禁止访问的目录（黑名单优先于白名单） */
  blockedDirectories: string[];

  // 会话配置
  sessionId: string;
  continue: boolean;
  resume: string;
  /**
   * 恢复会话时分叉出新 id 而非复用原 id（P0-2 --fork-session）。
   * 默认 undefined/false：复用被恢复会话的 id，续接同一会话。
   * true：生成新 id（或用 --session-id 指定），把源会话历史拷贝到新会话，parentUuid 指向源，源不动。
   */
  forkSession?: boolean;
  /**
   * 禁用会话落盘（P1-2 --no-session-persistence）。
   * 默认 undefined/false：正常持久化。true：本次会话不写持久化存储（SDK/一次性任务用）。
   */
  noSessionPersistence?: boolean;
  /**
   * 会话显示名（P2-5 --name/-n）。写入会话元数据 title，便于 --list-sessions 辨识。
   */
  sessionName?: string;

  // 无头模式配置
  print: boolean;
  outputFormat: string;
  maxTurns: number;
  /** stream-json/json 模式下输出全量消息数组（而非仅最终消息） */
  verbose?: boolean;
  /** 结构化输出的 JSON Schema 约束（--json-schema 文件解析后注入） */
  jsonSchema?: Record<string, unknown>;

  // 系统提示词配置
  systemPrompt: string;
  appendSystemPrompt: string;
  systemPromptFile: string;

  // 调试配置
  debug: boolean;
  debugLevel: string;
  debugLogFile: string;

  // 审计日志（零配置常驻：不依赖 debug，始终把 WARN/ERROR 关键事件落本地，
  // 出问题必有现场。只写本地、不外传。默认开，audit:false 可关）
  audit?: boolean;
  auditLogFile?: string;

  // UI 渲染配置
  /**
   * 是否启用 alternate buffer（全屏 TUI）模式。
   * - true（默认，见「幽灵残留根治」方案乙）：全屏 alt-screen 有界视口（ScrollBox+VirtualizedList，
   *   overflow=hidden），内容物理上进不了擦不掉的终端 scrollback → 从物理上根治「执行中工具溢出
   *   scrollback 后擦不掉的幽灵行残留」；应用内滚动/选择/复制/Ctrl+S Copy Mode 已 vendor 对齐 cc。
   *   对齐 claude-code 内部（ant）默认 = fullscreen 的那条路。
   * - false（--inline 逃生舱 opt-out）：旧主屏 Static 渲染，历史进终端 scrollback、原生文本选择，
   *   兼容不支持 alt-screen 的终端；但执行中工具溢出视口会残留幽灵行（故降级为显式选项，非默认）。
   */
  alternateBuffer?: boolean;

  /** UI 强调色/品牌色覆盖（/color 持久化端，settings.json accentColor）。存 hex，缺省=跟随主题 ui.active */
  accentColor?: string;

  /**
   * Fast Mode 开关（/fast 持久化端，settings.json fastMode）。缺省 = false。
   * 语义：偏好更快的输出端点/服务档位。当前网关未提供对等 fast 能力，故此开关为「预留」——
   * 已透传到 fallback 层（config.fastMode），待网关支持后即可生效，运行时不写死模型名单。
   */
  fastMode?: boolean;

  // 子代理模型映射
  subAgentModels?: import("../llm/registry.ts").SubAgentModelMap;

  // /goal 目标驱动持续执行配置（缺省走 DEFAULT_GOAL_CONFIG）
  goal?: Partial<import("../goal/config.ts").GoalConfig>;

  // 成本配额（美元）
  costLimit?: number;

  // 配额管控（增强版，向后兼容 costLimit）
  quota?: QuotaFullConfig;

  // Hook 和 MCP
  hooks: HooksConfig;
  mcpServers: Record<string, MCPServerConfig>;
  /**
   * B1：MCP 安全策略（denylist/allowlist）。合并多源 MCP 配置时按此过滤，
   * 命中 deniedServers 的 server 直接剔除并留痕。默认 undefined（不过滤）。
   */
  mcpPolicy?: import("../mcp/types.ts").McpPolicy;

  // UI 配置
  /** 代码块是否显示行号（默认 true） */
  showLineNumbers: boolean;

  // Skill 配置
  /** 禁用的 Skill 名称列表 */
  disabledSkills?: string[];
  /** 禁用的 Hook 名列表（/hooks disable -p 持久化端） */
  disabledHooks?: string[];

  // 扩展安全配置
  /** 是否信任项目级扩展（跳过信任检查，默认 false） */
  trustProjectExtensions?: boolean;

  // 插件配置
  /** 会话级插件目录（--plugin-dir，不持久化，视为 inline 来源） */
  pluginDirs?: string[];

  // 功能开关
  /**
   * 禁用所有斜杠命令（P1-8 --disable-slash-commands）。
   * 默认 undefined/false：正常注册。true：跳过命令注册，headless/受限场景关闭 / 命令入口。
   */
  disableSlashCommands?: boolean;

  // 配置源控制（P1-5 / P1-6）
  /**
   * 额外的 settings 源（--settings <file-or-json>）：文件路径或内联 JSON 字符串。
   * 优先级高于常规 user/project/local 三源，作为最后一层覆盖。运行时字段，不落盘。
   */
  extraSettings?: string;
  /**
   * 限定加载哪些 settings 源（--setting-sources <sources>，逗号分隔）。
   * 取值子集：user / project / local。设置后仅加载列出的源，其余跳过。运行时字段，不落盘。
   */
  settingSources?: ("user" | "project" | "local")[];

  // MCP 配置源（P1-7）
  /**
   * 额外 MCP 配置源（--mcp-config <configs...>）：文件路径或内联 JSON 字符串数组。
   * 与 settings.json 的 mcpServers 合并。运行时字段，不落盘。
   */
  mcpConfigSources?: string[];
  /**
   * 严格 MCP 配置模式（--strict-mcp-config）：仅使用 --mcp-config 指定的服务器，
   * 忽略 settings.json / .mcp.json 中的 mcpServers。默认 false。运行时字段，不落盘。
   */
  strictMcpConfig?: boolean;

  // Beta 头（P2-3）
  /**
   * 额外的 anthropic-beta 头值（--betas <betas...>）：透传到 Anthropic 请求头。
   * 运行时字段，不落盘。
   */
  betas?: string[];

  // 工具白名单替换（P2-6）
  /**
   * 用此名单**替换**整个内置工具集（--tools <tools...>）。
   * 与 allowedTools（权限层预授权）语义不同：这是**工具集裁剪**，未列出的工具不注册。
   * 空/undefined：注册全部内置工具（现状）。运行时字段，不落盘。
   */
  toolsWhitelist?: string[];

  // 子代理注入（P1-10）
  /**
   * CLI 注入的子代理定义（--agents <json>）：{ name: { description, prompt, tools?, model? } }。
   * 注册进聚合 registry，使 sub_agent 可发现。运行时字段，不落盘。
   */
  injectedAgents?: Record<
    string,
    { description?: string; prompt: string; tools?: string[]; model?: string }
  >;
  /**
   * 整会话使用的顶层子代理人格名（--agent <name>）。
   * 指向 injectedAgents 或已注册 agent 的名字。运行时字段，不落盘。
   */
  topLevelAgent?: string;

  // SDK 输入/输出格式（P2-1 / P2-2）
  /**
   * 输入格式（--input-format <fmt>）：text（默认）/ stream-json。
   * stream-json：从 stdin 读取流式 JSON 消息。运行时字段，不落盘。
   */
  inputFormat?: "text" | "stream-json";
  /**
   * stream-json 输出模式下是否包含部分消息增量（--include-partial-messages）。
   * 默认 false。运行时字段，不落盘。
   */
  includePartialMessages?: boolean;

  // Checkpoint 配置
  checkpoint?: CheckpointConfig;

  // Git 集成配置（P3-1：可配置归因）
  git?: GitConfig;

  // JIT 上下文发现
  /** 是否启用 JIT 上下文发现（默认 true） */
  jitContext?: boolean;

  // 工具延迟加载（ToolSearch）
  /**
   * 工具延迟加载模式（默认 false 关闭）。对标 claude-code ENABLE_TOOL_SEARCH。
   *
   * 取值：
   *   - false / 不设置：恒关，全部工具照常进首轮上下文（行为与历史一致）。
   *   - true：恒开，标记 shouldDefer 的工具不进首轮（用 activeDefinitions 替代
   *     definitions），模型经 tool_search 按需搜索并激活。
   *   - "auto"：按延迟工具 token 占上下文窗口比例自动判定（默认阈值 10%）——
   *     工具定义确实"撑爆"上下文时才开延迟，少量工具时全量更方便。
   *   - number：自定义 auto 阈值百分比（0=恒开，100=恒关，1-99=按比例判定）。
   *
   * 环境变量 SID_CODE_TOOL_SEARCH 支持 true/false/auto/auto:N/纯数字 覆盖。
   */
  toolSearch?: boolean | "auto" | number;

  /**
   * 延迟加载豁免名单：命中的工具即使本应延迟（mcp__ 前缀 / shouldDefer），也强制首轮可见。
   *
   * sid 相对 claude-code 的**增量能力**——CC 客户端无此用户开关（只能靠 MCP server 自己
   * 声明 alwaysLoad）。因 sid 默认 toolSearch:true 全 defer，用户每会话想用高频 MCP 工具
   * 都得先花一轮 tool_search 往返；此名单让用户钉死 3-5 个高频工具首轮可见，省往返延迟。
   *
   * 支持两种形态：
   *   - 精确名："mcp__tavily__tavily_search"
   *   - server 通配："mcp__github__*"（该 server 全部工具豁免）
   *
   * 配置文件用 snake_case：tool_search_keep_loaded。
   * 环境变量 SID_CODE_TOOL_SEARCH_KEEP_LOADED（逗号分隔）覆盖。
   * 建议保留 3-5 个高频工具，过多会抵消延迟收益（defer 全为省 token，豁免过多即回到全量）。
   */
  toolSearchKeepLoaded?: string[];

  // 环境变量清理
  /** 是否在 bash 工具执行时清理环境变量（默认 false） */
  sanitizeEnv?: boolean;

  // LLM 命令风险分类器（P0-3 迭代 II）
  /** 是否启用 LLM 命令风险分类器（第二道防线，默认 false 保守） */
  enableLLMClassifier?: boolean;
  /** LLM 分类器使用的模型（默认复用主循环模型 config.model） */
  classifierModel?: string;
  /**
   * WebFetch 隔离提炼使用的模型（SEC-AUDIT-2026-07-19 P0，默认复用主循环模型）。
   *
   * 抓取的网页正文不直返主模型，先由这个模型按 prompt 提炼（对齐 CC 用 Haiku 的设计）。
   * 配一个便宜的小模型能显著降本——提炼输入可达 6 万字符，用主模型跑并不划算。
   */
  webFetchExtractModel?: string;
  /**
   * 是否启用 WebFetch 隔离提炼（默认 true）。
   *
   * 关掉会让网页原文直接进主上下文，等于放弃 §17.5「隔离上下文窗口」这道防线——
   * 仅在明确接受注入风险（如全离线、无辅助模型可用）时才关。关闭后 WebFetch 仍会走
   * 降级路径（截断 + 不可信标注），不会退回"整篇原文直返"。
   */
  webFetchIsolate?: boolean;
  /**
   * GAP-04：分类器并行预启动（推测执行）。默认 false。
   * 开启后：checker 的同步分类器**放行路径**下沉到 tool-executor 三路竞争，与 UI 弹窗并行，
   * 分类器判定安全时提前跳过弹窗（省 1-2s）。
   * 安全不变式：checker 的**硬编码/规则拒绝仍同步生效**（parallel 路径只 approve 不 deny），
   * 分类器无法放行任何硬编码已知危险命令——弹窗兜底不会被绕过。
   * 要求 enableLLMClassifier=true 才有意义（无分类器时该路径恒 null）。
   */
  speculativeClassifier?: boolean;
  /** 是否启用 macOS Seatbelt 沙箱（限制 bash 命令的文件系统和网络访问，默认 false） */
  enableSandbox?: boolean;

  // 团队记忆同步（E.11 协作护城河）
  /** 团队记忆同步配置（共享目录模型） */
  teamMemory?: TeamMemoryConfig;

  // 会话保留配置
  sessionRetention?: SessionRetentionConfig;

  // 搜索配置
  search?: SearchConfig;

  // 轨迹采集配置
  trace?: TraceConfig;

  // 遥测配置（OTel 兼容的结构化 Trace）
  telemetry?: TelemetryConfig;

  // 分析/事件系统配置（spec 17 — analytics 通道）
  analytics?: AnalyticsConfig;

  // IDE 集成配置
  ide?: IDEConfig;

  // 配置校验诊断结果（loadConfig 阶段 logger 尚未就绪，暂存于此，
  // 由上层在 initLogger 之后统一输出：warnings 降 debug、非致命 errors 打 warn）。
  // 不写入磁盘配置，仅运行时携带。
  _validationDiagnostics?: {
    warnings: { path: string; message: string }[];
    errors: { path: string; message: string }[];
  };

  /**
   * 首次启动引导标记：TUI 模式下检测到"完全未配置模型/API Key"时置 true。
   * loadConfig 遇此情形不再 throw（避免首启崩溃），而是放行进 TUI，由
   * OnboardingDialog 引导用户配置。headless 模式（print）恒 false —— 无头
   * 场景仍按原样报错退出。不写入磁盘配置，仅运行时携带。
   */
  _needsOnboarding?: boolean;
  /**
   * 用户显式配置的 maxTokens 全局覆盖值（CLI --max-tokens / env SID_MAX_OUTPUT_TOKENS /
   * settings.json 顶层 maxTokens）。仅运行时携带，不写入磁盘。
   *
   * 用途：让 resolveCurrentModelConfig 在「运行时 /model 切换」时能区分
   * 「maxTokens 是用户刻意设的」还是「上个模型自动推导出的残留值」——
   * 前者应尊重（但仍钳制到新模型物理上限），后者应按新模型重算。
   * 不设置表示用户从未显式指定，maxTokens 完全由模型能力推导。
   */
  _explicitMaxTokens?: number;
}

/** IDE 集成配置 */
export interface IDEConfig {
  /** 是否自动连接 IDE（默认 false，在 IDE 内置终端中自动开启） */
  autoConnect?: boolean;
  /** 自动发现超时（毫秒，默认 30000） */
  discoveryTimeout?: number;
  /** 是否自动安装 IDE 扩展（默认 false，扩展尚未发布） */
  autoInstallExtension?: boolean;
}

/** 轨迹上传配置 */
export interface TraceUploadConfig {
  /** trajectory-platform URL，含路径前缀，如 http://<your-server>/traj */
  url: string;
  /** X-Upload-Token 认证 token */
  token: string;
  /** 是否自动上传（默认 true，false 则仅本地保存） */
  autoUpload?: boolean;
  /**
   * 上传成功后是否删除本地文件（默认 false = 保留本地全量副本）。
   * false: 云端 + 本地各保留一份完整数据（开发调试阶段推荐）。
   * true: 上传确认后清理本地数据文件（仅保留 metadata snapshot）。
   */
  deleteAfterUpload?: boolean;
  /** 用户标识（多用户场景区分来源） */
  userId?: string;
  /** 设备标识 */
  deviceId?: string;
  /** 工具来源标识（默认 "sid-code"） */
  toolSource?: string;
  /** 单文件最大重试次数（默认 5） */
  maxRetries?: number;
  /** 指数退避基数毫秒（默认 2000，即 2s→4s→8s→16s→32s） */
  retryBaseMs?: number;
  /** 是否 gzip 压缩后上传（默认 true） */
  compress?: boolean;
  /** 心跳检测间隔毫秒（默认 60000） */
  healthCheckIntervalMs?: number;
  /** 持久化重试队列最大重试次数（默认 50，覆盖约 24 小时） */
  maxQueueRetries?: number;
  /** 重试队列扫描间隔毫秒（默认 300000，即 5 分钟） */
  queueScanIntervalMs?: number;
}

/** 搜索配置 */
export interface SearchConfig {
  /** 搜索后端: searxng | brave | tavily | duckduckgo */
  backend?: string;
  /** SearXNG 实例地址 */
  searxngUrl?: string;
  /** Brave Search API Key */
  braveApiKey?: string;
  /** Tavily API Key */
  tavilyApiKey?: string;
}

/** 团队记忆同步配置（E.11，共享目录模型） */
export interface TeamMemoryConfig {
  /** 是否启用团队记忆同步（默认 false） */
  enabled?: boolean;
  /**
   * 共享「远端」目录绝对路径（网络盘 / 同步盘 / git 共享路径）。
   * 所有协作者指向同一物理目录；未配置时团队记忆仅本地可用，不跨成员同步。
   */
  dir?: string;
  /** debounce 推送等待毫秒（默认 2000，最后一次写入后等待再 push） */
  debounceMs?: number;
}

/** 轨迹采集配置 */
export interface TraceConfig {
  /** 是否启用采集（默认 false） */
  enabled?: boolean;
  /** 本地输出目录（默认 ~/.sid-code/trajectories） */
  outputDir?: string;
  /** 本地最大保留会话数（默认 100，超过自动清理最旧的） */
  maxSessionsRetained?: number;
  /** 上传配置 */
  upload?: TraceUploadConfig;
}

/** 遥测导出器配置 */
export interface TelemetryExporterConfig {
  /** 导出器类型（otlp 走 OTLP/HTTP + JSON，端点读标准 OTEL_EXPORTER_OTLP_* 环境变量） */
  type: "console" | "jsonl" | "otlp";
  options?: Record<string, unknown>;
}

/** 遥测配置 */
export interface TelemetryConfig {
  /** 是否启用（默认 false） */
  enabled: boolean;
  /** 导出器列表 */
  exporters: TelemetryExporterConfig[];
  /** 批量导出大小（默认 512） */
  batchSize?: number;
  /** 刷新间隔毫秒（默认 5000） */
  flushIntervalMs?: number;
  /** 最大队列大小（默认 2048） */
  maxQueueSize?: number;
}

/** 隐私级别（spec 17 §3.3） */
export type PrivacyLevel = "default" | "no-telemetry" | "essential-traffic";

/** 远程事件导出后端配置（spec 17 §4.2） */
export interface AnalyticsBackendConfig {
  /** 后端名称（用于日志与 killswitch） */
  name: string;
  /**
   * 后端类型：
   * - `http`：自定义 JSON 批量端点（HttpExporter）
   * - `otlp`：标准 OTLP/HTTP logs 协议（OtlpExporter），endpoint 可省略，
   *   缺省时回退到 OTEL_EXPORTER_OTLP_ENDPOINT + /v1/logs
   *
   * 新增类型必须同步 `query/init-helpers.ts` 的后端注册分派与
   * `config/schema.ts` 的校验，否则配了会被静默跳过。
   */
  type: "http" | "otlp";
  /** 远程端点 URL（type=otlp 时可省略，由 OTEL_EXPORTER_OTLP_ENDPOINT 兜底） */
  endpoint: string;
  /** 认证头（可选） */
  authHeader?: string;
  /** 批量大小 */
  batchSize?: number;
  /** 刷新间隔（ms） */
  flushIntervalMs?: number;
  /** 网络超时（ms） */
  networkTimeoutMs?: number;
  /** 是否脱敏 _PROTECTED_* 字段（默认 true） */
  stripProtected?: boolean;
  /** 事件白名单（为空则接受所有事件） */
  allowedEvents?: string[];
}

/** 分析/事件系统配置（spec 17 — analytics 通道，与 telemetry Span 通道并行） */
export interface AnalyticsConfig {
  /** 隐私级别覆盖（环境变量优先级更高） */
  privacyLevel?: PrivacyLevel;
  /** Feature Flag 远程端点（可选） */
  featureFlagEndpoint?: string;
  /** 本地 Feature Flag 定义 */
  flags?: Record<string, string | number | boolean | Record<string, unknown>>;
  /** 远程事件导出后端列表 */
  backends?: AnalyticsBackendConfig[];
}

/** Checkpoint 配置 */
export interface CheckpointConfig {
  /** 是否启用（默认 true） */
  enabled?: boolean;
  /** 每文件最大快照数（默认 50） */
  maxCheckpointsPerFile?: number;
  /** 总存储上限（MB，默认 200） */
  maxTotalSizeMb?: number;
  /** 过期天数（默认 30） */
  maxAgeDays?: number;
  /** 压缩阈值（KB，默认 1） */
  compressThresholdKb?: number;
  /** 大文件阈值（行数，默认 1000，超过此值使用 Myers diff） */
  largeFileThresholdLines?: number;
  /** 超大文件阈值（行数，默认 10000，超过此值直接存 full） */
  hugeFileThresholdLines?: number;
}

/** 归因配置（commit / PR 尾注，可配可关） */
export interface AttributionConfig {
  /** 是否启用（默认 true） */
  enabled?: boolean;
  /** 归因文本（默认 "Co-Authored-By: sid-code <noreply@sid-code.cc>"） */
  text?: string;
}

/** Git 集成配置（P3-1，对标 CC commitAttribution/prAttribution） */
export interface GitConfig {
  /** commit 尾注归因（写入 commit message） */
  commitAttribution?: AttributionConfig;
  /** PR 尾注归因（写入 PR 描述） */
  prAttribution?: AttributionConfig;
}

/** 会话保留配置 */
export interface SessionRetentionConfig {
  /** 是否启用自动清理（默认 true） */
  enabled?: boolean;
  /** 最大保留时间（如 "30d"） */
  maxAge?: string;
  /** 最大保留数量 */
  maxCount?: number;
  /** 最小保留时间（防止误删，如 "1d"） */
  minRetention?: string;
}

/** 预算规则配置（YAML 格式） */
export interface BudgetRuleConfig {
  id: string;
  name: string;
  period: "session" | "hourly" | "daily" | "weekly" | "monthly";
  limit_usd: number;
  scope?: { model?: string };
  thresholds?: { warning?: number; critical?: number; exceeded?: number };
  action?: "alert" | "downgrade" | "block";
}

/** 完整配额配置 */
export interface QuotaFullConfig {
  /** 会话成本上限（USD），向后兼容 costLimit */
  costLimit?: number;
  /** 每分钟请求数上限 */
  requestsPerMinute?: number;
  /** 每分钟 token 数上限 */
  tokensPerMinute?: number;
  /** 多维度预算规则 */
  budgetRules?: BudgetRuleConfig[];
}

/** 默认配置。
 *  注意：provider 和 model 均不预设值 —— 所有模型选择必须来自用户配置的
 *  availableModels 或 CLI 显式传参。不绑定任何特定 Provider/模型。
 *  若加载完成后 model 仍为空但 availableModels 非空，loadConfig 会自动选第一个。 */
export function defaultConfig(): Config {
  return {
    provider: "",
    model: "",
    fallbackModel: "",
    anthropicKey: "",
    openaiKey: "",
    baseURL: "",
    // maxTokens 是「最后兜底」：正常路径下会被四重覆盖——
    //   availableModels.maxOutputTokens（:810）> CLI/env/file 显式值（:744）> 模型推导（:746-748）。
    // 仅当用户既没配 availableModels、也没在任何地方显式给 maxTokens、且模型推导也失败时，才用到这里。
    // 旧值 16384 是 Claude 3 时代输出上限，会把今天 32K~128K 输出能力的模型阉割掉；
    // 不存在对所有模型都"安全且不阉割"的硬编码值（各家 max_output 差异大），故取一个
    // 主流模型普遍可接受、又不会过度保守的兜底；输出上限低于此值的模型，API 会自行截到合法值。
    // 想放宽/收紧无需改源码：设 SID_MAX_OUTPUT_TOKENS（见 loadFromEnv）。
    maxTokens: 32768,
    availableModels: [],
    permissionMode: "default",
    skipPermissions: false,
    allowedTools: [],
    disallowedTools: [],
    yesMode: false,
    allowedDirectories: [],
    blockedDirectories: [],
    sessionId: "",
    continue: false,
    resume: "",
    print: false,
    outputFormat: "text",
    maxTurns: 0,
    verbose: false,
    jsonSchema: undefined,
    systemPrompt: "",
    appendSystemPrompt: "",
    systemPromptFile: "",
    debug: true,
    debugLevel: "DEBUG",
    debugLogFile: "~/.sid-code/debug.log",
    trace: { enabled: true },
    audit: true,
    auditLogFile: "~/.sid-code/audit.log",
    hooks: {},
    mcpServers: {},
    showLineNumbers: true,
    // 默认 true：全屏 alt-screen 有界视口，物理根治幽灵行残留（方案乙）。--inline 可回退旧主屏路。
    alternateBuffer: true,
    // 工具延迟加载默认恒开(tst)——对标 claude-code 默认 'tst' 行为。
    // 15 个长尾工具(cron/worktree/task-*/team/workflow/notebook/ask-user 等)
    // + 所有 MCP 工具首轮不注入,由模型经 tool_search 按需调出,首轮省 token。
    // sid-code 的 tool search 是纯客户端模拟(activeDefinitions 过滤 + <available-deferred-tools>
    // 名单注入 + 运行时 activateTool),不发 beta wire shape,故无 CC 依赖 beta API 时
    // 代理网关 400 的风险(CC 需 CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS 补救,我们天生免疫)。
    // 高频工具(读/写/编辑/todo/plan/hypothesis)不 defer,首轮照常可见,不影响体验。
    // 用户可 SID_CODE_TOOL_SEARCH=false 或 settings.json 显式关闭回退。
    toolSearch: true,
  };
}

/** 解析字符串中的 ${ENV_VAR} 占位符（用于 authHeader 等敏感配置，避免明文落配置文件） */
function resolveEnvPlaceholder(value: string | undefined): string | undefined {
  if (!value || typeof value !== "string") return value;
  return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_m, name) => process.env[name] ?? "");
}

/**
 * 将 YAML 字段名转换为 Config 字段名。
 *
 * 注意 keyMap 的兜底语义 `keyMap[k] || k`：未登记的键**原样保留**——这是 settings.json
 * （camelCase，字段名已对齐 Config）能直通的原因。登记 snake_case 别名只是为了让 YAML
 * 风格的写法也命中同一字段。
 *
 * 导出别名 normalizeConfigKeysForTest 供单测直接断言归一化结果（避免为验证一个字段
 * 去构造真实配置文件）。
 */
function normalizeConfigKeys(raw: any): Partial<Config> {
  if (!raw || typeof raw !== "object") {
    return {};
  }
  const keyMap: Record<string, keyof Config> = {
    provider: "provider",
    model: "model",
    fallback_model: "fallbackModel",
    fallback_switch_mode: "fallbackSwitchMode",
    anthropic_key: "anthropicKey",
    openai_api_key: "openaiKey",
    base_url: "baseURL",
    max_tokens: "maxTokens",
    available_models: "availableModels",
    permission_mode: "permissionMode",
    ask_user_question_timeout: "askUserQuestionTimeout",
    skip_permissions: "skipPermissions",
    allowed_tools: "allowedTools",
    disallowed_tools: "disallowedTools",
    yes_mode: "yesMode",
    allowed_directories: "allowedDirectories",
    blocked_directories: "blockedDirectories",
    session_id: "sessionId",
    continue: "continue",
    resume: "resume",
    print: "print",
    output_format: "outputFormat",
    max_turns: "maxTurns",
    system_prompt: "systemPrompt",
    append_system_prompt: "appendSystemPrompt",
    system_prompt_file: "systemPromptFile",
    debug: "debug",
    debug_level: "debugLevel",
    debug_log_file: "debugLogFile",
    audit: "audit",
    audit_log_file: "auditLogFile",
    hooks: "hooks",
    mcp_servers: "mcpServers",
    mcp_policy: "mcpPolicy",
    mcpPolicy: "mcpPolicy",
    sub_agent_models: "subAgentModels",
    goal: "goal",
    cost_limit: "costLimit",
    show_line_numbers: "showLineNumbers",
    quota: "quota",
    disabled_skills: "disabledSkills",
    disabled_hooks: "disabledHooks",
    trust_project_extensions: "trustProjectExtensions",
    checkpoint: "checkpoint",
    git: "git",
    jit_context: "jitContext",
    tool_search: "toolSearch",
    tool_search_keep_loaded: "toolSearchKeepLoaded",
    sanitize_env: "sanitizeEnv",
    enable_llm_classifier: "enableLLMClassifier",
    classifier_model: "classifierModel",
    // SEC-AUDIT-2026-07-19 P0：WebFetch 隔离提炼
    web_fetch_extract_model: "webFetchExtractModel",
    web_fetch_isolate: "webFetchIsolate",
    // §12 P2-1：思考预算上限。settings.json 用 camelCase 直通（keyMap 兜底），
    // 这里显式登记 snake_case 别名，让 YAML 风格配置也能命中同一 Config 字段。
    max_thinking_tokens: "maxThinkingTokens",
    speculative_classifier: "speculativeClassifier",
    team_memory: "teamMemory",
    trace: "trace",
    search: "search",
    telemetry: "telemetry",
    analytics: "analytics",
    language: "language",
    output_style: "outputStyle",
    outputStyle: "outputStyle",
    auto_dream: "autoDream",
    autoDream: "autoDream",
    auto_memory: "autoMemory",
    autoMemory: "autoMemory",
    theme: "theme",
    vimMode: "vimMode",
    alternateBuffer: "alternateBuffer",
    accentColor: "accentColor",
    fastMode: "fastMode",
  };

  const result: any = {};
  for (const [yamlKey, value] of Object.entries(raw as Record<string, any>)) {
    const configKey = keyMap[yamlKey] || yamlKey;

    // 特殊处理 available_models，转换字段名
    if (configKey === "availableModels" && Array.isArray(value)) {
      result[configKey] = value.map((m: any) => ({
        name: m.name,
        // 别名→真名映射（缺省时 resolveWireModel 回落 name）。这里漏一个字段就等于
        // 用户配了 model_id 却被静默丢弃 → 别名当模型名发给厂商 400（pricing 有前科）。
        modelId: m.model_id || m.modelId,
        provider: m.provider,
        baseURL: m.base_url || m.baseURL,
        apiKey: m.api_key || m.apiKey,
        contextWindow: m.context_window || m.contextWindow,
        maxOutputTokens: m.max_output_tokens || m.maxOutputTokens,
        supportsThinking: m.supports_thinking ?? m.supportsThinking,
        // pricing 内部字段本就 camelCase（input/output/cacheRead/cacheWrite），直接透传。
        // 此前遗漏导致走 snake_case 归一化路径时用户自配价被静默丢弃（架空「用户手写价最高优先」）。
        pricing: m.pricing,
        // compat 的内部键两种风格都要认，归一化在 model-compat.ts（合法键集合的单一真相源）。
        // 这里透传原始对象而不是自己转键：转键逻辑写两份必然漂移，而漏一个键就是用户配了
        // 却被静默丢弃 —— 与上面 model_id / pricing 同类前科。
        compat: m.compat,
      }));
      // 特殊处理 hooks：旧格式（数组）→ 新格式（按事件分组）
    } else if (configKey === "hooks" && Array.isArray(value)) {
      const grouped: HooksConfig = {};
      for (const hook of value) {
        const event = hook.event || "pre_tool_use";
        if (!grouped[event]) grouped[event] = [];
        grouped[event].push(hook);
      }
      result[configKey] = grouped;
      // 特殊处理 checkpoint：转换字段名
    } else if (configKey === "checkpoint" && typeof value === "object") {
      result[configKey] = {
        enabled: value.enabled,
        maxCheckpointsPerFile: value.max_checkpoints_per_file || value.maxCheckpointsPerFile,
        maxTotalSizeMb: value.max_total_size_mb || value.maxTotalSizeMb,
        maxAgeDays: value.max_age_days || value.maxAgeDays,
        compressThresholdKb: value.compress_threshold_kb || value.compressThresholdKb,
        largeFileThresholdLines: value.large_file_threshold_lines || value.largeFileThresholdLines,
        hugeFileThresholdLines: value.huge_file_threshold_lines || value.hugeFileThresholdLines,
      };
      // 特殊处理 search：转换字段名（snake_case → camelCase）
    } else if (configKey === "search" && typeof value === "object" && value !== null) {
      result[configKey] = {
        backend: value.backend,
        searxngUrl: value.searxng_url || value.searxngUrl,
        braveApiKey: value.brave_api_key || value.braveApiKey,
        tavilyApiKey: value.tavily_api_key || value.tavilyApiKey,
      };
      // 特殊处理 trace：转换字段名（snake_case → camelCase）
    } else if (configKey === "trace" && typeof value === "object" && value !== null) {
      const upload = value.upload;
      result[configKey] = {
        enabled: value.enabled,
        outputDir: value.output_dir || value.outputDir,
        maxSessionsRetained: value.max_sessions_retained || value.maxSessionsRetained,
        upload:
          upload && typeof upload === "object"
            ? {
                url: upload.url,
                token: upload.token,
                autoUpload: upload.auto_upload ?? upload.autoUpload,
                userId: upload.user_id || upload.userId,
                deviceId: upload.device_id || upload.deviceId,
                toolSource: upload.tool_source || upload.toolSource,
                maxRetries: upload.max_retries || upload.maxRetries,
                retryBaseMs: upload.retry_base_ms || upload.retryBaseMs,
                compress: upload.compress,
                deleteAfterUpload: upload.delete_after_upload ?? upload.deleteAfterUpload,
                healthCheckIntervalMs:
                  upload.health_check_interval_ms || upload.healthCheckIntervalMs,
                maxQueueRetries: upload.max_queue_retries || upload.maxQueueRetries,
                queueScanIntervalMs: upload.queue_scan_interval_ms || upload.queueScanIntervalMs,
              }
            : undefined,
      };
      // 特殊处理 telemetry：转换字段名
    } else if (configKey === "telemetry" && typeof value === "object" && value !== null) {
      const v = value as any;
      // ⚠️ 三个数值字段必须「只在有值时才写入」。
      // 无条件写出会产出**显式存在的 undefined 键**，在 TelemetryBus 的
      // `{ ...DEFAULT_CONFIG, ...config }` 里会覆盖掉 512/5000/2048 默认值，
      // 进而让 splice(0, undefined) 恒返回空数组、setInterval(fn, undefined)
      // 退化成 0ms —— 曾导致遥测落盘 190MB 纯换行字节、span/metric 一条未出。
      // 见 docs/bugfixes/done/20260807-遥测落盘恒空-配置undefined覆盖默认值.md
      const telemetry: Record<string, unknown> = {
        enabled: v.enabled ?? false,
        exporters: Array.isArray(v.exporters) ? v.exporters : [],
      };
      const batchSize = v.batch_size ?? v.batchSize;
      const flushIntervalMs = v.flush_interval_ms ?? v.flushIntervalMs;
      const maxQueueSize = v.max_queue_size ?? v.maxQueueSize;
      if (batchSize !== undefined) telemetry.batchSize = batchSize;
      if (flushIntervalMs !== undefined) telemetry.flushIntervalMs = flushIntervalMs;
      if (maxQueueSize !== undefined) telemetry.maxQueueSize = maxQueueSize;
      result[configKey] = telemetry;
      // 特殊处理 analytics：转换字段名（snake_case → camelCase），解析后端列表（spec 17）
    } else if (configKey === "analytics" && typeof value === "object" && value !== null) {
      const v = value as any;
      const backends = Array.isArray(v.backends)
        ? v.backends.map((b: any) => ({
            name: b.name,
            type: b.type ?? "http",
            endpoint: b.endpoint,
            authHeader: resolveEnvPlaceholder(b.auth_header || b.authHeader),
            batchSize: b.batch_size ?? b.batchSize,
            flushIntervalMs: b.flush_interval_ms ?? b.flushIntervalMs,
            networkTimeoutMs: b.network_timeout_ms ?? b.networkTimeoutMs,
            stripProtected: b.strip_protected ?? b.stripProtected,
            allowedEvents: b.allowed_events ?? b.allowedEvents,
          }))
        : undefined;
      result[configKey] = {
        privacyLevel: v.privacy_level ?? v.privacyLevel,
        featureFlagEndpoint: v.feature_flag_endpoint ?? v.featureFlagEndpoint,
        flags: v.flags,
        backends,
      };
      // 特殊处理 quota：转换字段名
    } else if (configKey === "quota" && typeof value === "object" && value !== null) {
      const v = value as any;
      result[configKey] = {
        costLimit: v.cost_limit || v.costLimit,
        requestsPerMinute: v.requests_per_minute || v.requestsPerMinute,
        tokensPerMinute: v.tokens_per_minute || v.tokensPerMinute,
        budgetRules: Array.isArray(v.budget_rules || v.budgetRules)
          ? (v.budget_rules || v.budgetRules).map((r: any) => ({
              id: r.id,
              name: r.name,
              period: r.period,
              limit_usd: r.limit_usd || r.limitUSD,
              scope: r.scope,
              thresholds: r.thresholds,
              action: r.action ?? "alert",
            }))
          : undefined,
      };
    } else {
      result[configKey] = value;
    }
  }

  return result;
}

/**
 * §12 P2-1 复审：导出 normalizeConfigKeys 供单测断言字段归一化。
 * 生产代码请勿使用——配置加载统一走 loadConfig / loadConfigFile。
 */
export const normalizeConfigKeysForTest = normalizeConfigKeys;

/**
 * 加载配置文件。
 *
 * 唯一真相源：settings.json + app.json（~/.sid-code/ 下）。
 * 两文件均为 JSON，合并后经 env 占位符展开 + normalizeConfigKeys 归一化。
 * 旧格式 config.yaml 已废弃，不再读取（历史用户请手动迁移到 settings.json）。
 */
async function loadConfigFile(): Promise<Partial<Config>> {
  const configDir = getSidHome();
  const settingsPath = join(configDir, "settings.json");
  const appConfigPath = join(configDir, "app.json");

  if (existsSync(settingsPath) || existsSync(appConfigPath)) {
    return loadNewFormatAsConfig(settingsPath, appConfigPath);
  }

  return {};
}

/**
 * 从新格式（settings.json + app.json）构造 Config。
 * 两文件均为 camelCase JSON，合并后经 env 占位符展开（${VAR}）。
 * app.json 字段（debug/checkpoint/trace/...）与 settings.json 字段（provider/model/...）
 * 合并到同一 Config，字段名已对齐 Config 接口，无需 snake_case 归一化。
 */
async function loadNewFormatAsConfig(
  settingsPath: string,
  appConfigPath: string,
): Promise<Partial<Config>> {
  const log = getLogger();
  const { resolveEnvVars } = await import("./env-interpolation.ts");
  const merged: Record<string, unknown> = {};

  for (const p of [settingsPath, appConfigPath]) {
    if (!existsSync(p)) continue;
    try {
      const raw = JSON.parse(await Bun.file(p).text());
      if (raw && typeof raw === "object") {
        // 一层深合并嵌套对象（如 trace/telemetry/checkpoint），避免 app.json 的
        // { trace: { enabled: true } } 覆盖 settings.json 的完整 trace 配置。
        // 注意：仅一层深合并（非递归）。嵌套 >2 层的对象仍是后者整体覆盖前者。
        // 当前所有配置结构（trace.upload、telemetry.exporters 等）实际只需一层即可。
        for (const [key, value] of Object.entries(raw)) {
          if (
            value !== null &&
            typeof value === "object" &&
            !Array.isArray(value) &&
            merged[key] !== null &&
            typeof merged[key] === "object" &&
            !Array.isArray(merged[key])
          ) {
            merged[key] = { ...(merged[key] as Record<string, unknown>), ...value };
          } else {
            merged[key] = value;
          }
        }
      }
    } catch (err) {
      log.warn("CONFIG", `读取 ${p} 失败，跳过: ${err}`);
    }
  }

  const interpolated = resolveEnvVars(merged);

  // 关键：新格式同样经过 normalizeConfigKeys 归一化。
  // settings.json 里 availableModels 数组项允许 snake_case（api_key/base_url）
  // 或 camelCase 混写，normalizeConfigKeys 会统一转成 Config 期望的 camelCase，
  // 否则 resolveCurrentModelConfig 读不到 apiKey，导致 openaiKey 不回填而启动报错。
  const normalized = normalizeConfigKeys(interpolated);
  log.configLoaded("配置文件", {
    path: settingsPath,
    keys: Object.keys(normalized),
  });
  return normalized;
}

/** 从环境变量加载配置 */
function loadFromEnv(): Partial<Config> {
  const env = process.env;
  const base: Partial<Config> = {
    provider: env.SID_CODE_LLM_PROVIDER,
    model: env.SID_CODE_LLM_MODEL,
    // baseURL：SID_CODE_LLM_BASE_URL 优先，OPENAI_BASE_URL 作兼容别名（不确定-4：
    // 此前只实现了 SID_CODE_LLM_BASE_URL，运维习惯用的 OPENAI_BASE_URL 压根没被读取）。
    baseURL: env.SID_CODE_LLM_BASE_URL || env.OPENAI_BASE_URL,
    anthropicKey: env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN,
    openaiKey: env.OPENAI_API_KEY || env.SID_CODE_LLM_API_KEY,
  };

  // maxTokens（输出上限）可经 env 显式配置，无需改源码即可放宽/收紧。
  // 设置后会被视为"用户显式配置"（:744），从而跳过模型自动推导、以此值为准。
  // 非法值（NaN / ≤0）静默忽略，回退到默认/推导链路。
  const envMaxTokens = env.SID_MAX_OUTPUT_TOKENS;
  if (envMaxTokens !== undefined && envMaxTokens !== "") {
    const n = Number.parseInt(envMaxTokens, 10);
    if (Number.isFinite(n) && n > 0) base.maxTokens = n;
  }

  // 工具延迟加载（ToolSearch）env 覆盖：SID_CODE_TOOL_SEARCH 支持
  // true/false/auto/auto:N/纯数字（对标 claude-code ENABLE_TOOL_SEARCH）。
  // 非法值返回 undefined，不覆盖配置文件/默认值。
  const toolSearchEnv = parseToolSearchEnv(env.SID_CODE_TOOL_SEARCH);
  if (toolSearchEnv !== undefined) {
    base.toolSearch = toolSearchEnv;
  }

  // 延迟加载豁免名单 env 覆盖：SID_CODE_TOOL_SEARCH_KEEP_LOADED（逗号分隔）。
  // 与 toolSearch 同风格：非空才覆盖，逐项 trim 去空。
  const keepLoadedEnv = env.SID_CODE_TOOL_SEARCH_KEEP_LOADED;
  if (keepLoadedEnv && keepLoadedEnv.trim() !== "") {
    const patterns = keepLoadedEnv
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (patterns.length > 0) base.toolSearchKeepLoaded = patterns;
  }

  // trace 环境变量
  if (env.SID_CODE_TRACE === "1" || env.SID_CODE_TRACE === "true") {
    const traceConfig: TraceConfig = {
      enabled: true,
      outputDir: env.SID_CODE_TRACE_OUTPUT_DIR,
    };
    if (env.SID_CODE_TRACE_UPLOAD_URL && env.SID_CODE_TRACE_UPLOAD_TOKEN) {
      traceConfig.upload = {
        url: env.SID_CODE_TRACE_UPLOAD_URL,
        token: env.SID_CODE_TRACE_UPLOAD_TOKEN,
        userId: env.SID_CODE_TRACE_USER_ID,
        deviceId: env.SID_CODE_TRACE_DEVICE_ID,
      };
    }
    base.trace = traceConfig;
  }

  // 团队记忆同步（E.11）env 覆盖：SID_CODE_TEAM_MEMORY 接受一个 JSON 对象,
  // 如 '{"enabled":true,"dir":"/nas/shared/sid-team-memory","debounceMs":2000}'。
  // 解析失败/非对象静默忽略(回退到 settings.json/默认),与 toolSearch/trace 容错风格一致。
  // 字段最终仍会过 schema 校验(dir 必须绝对路径、debounceMs 非负),此处仅做形状收敛。
  const teamMemEnv = env.SID_CODE_TEAM_MEMORY;
  if (teamMemEnv !== undefined && teamMemEnv.trim() !== "") {
    try {
      const parsed = JSON.parse(teamMemEnv);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const tm: TeamMemoryConfig = {};
        if (typeof parsed.enabled === "boolean") tm.enabled = parsed.enabled;
        if (typeof parsed.dir === "string") tm.dir = parsed.dir;
        if (typeof parsed.debounceMs === "number") tm.debounceMs = parsed.debounceMs;
        if (Object.keys(tm).length > 0) base.teamMemory = tm;
      }
    } catch {
      /* 非法 JSON 静默忽略,不覆盖配置文件/默认值 */
    }
  }

  return base;
}

/** 合并配置（后者覆盖前者） */
function mergeConfig(base: Partial<Config>, override: Partial<Config>): Partial<Config> {
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value !== undefined && value !== "") {
      result[key as keyof Config] = value as any;
    }
  }
  return result;
}

/** 加载项目级 .mcp.json 配置 */
async function loadMCPJson(): Promise<Record<string, MCPServerConfig>> {
  const log = getLogger();
  const mcpJsonPath = join(process.cwd(), ".mcp.json");

  if (!existsSync(mcpJsonPath)) {
    return {};
  }

  try {
    const content = await Bun.file(mcpJsonPath).text();
    const parsed = JSON.parse(content);
    // 支持 { "mcpServers": { ... } } 或直接 { "serverName": { ... } }
    const servers = parsed.mcpServers || parsed.mcp_servers || parsed;
    if (typeof servers !== "object" || Array.isArray(servers)) {
      log.warn("CONFIG", `.mcp.json 格式不正确，期望对象`);
      return {};
    }
    log.info("CONFIG", `.mcp.json 加载 ${Object.keys(servers).length} 个 MCP 服务器`);
    return servers;
  } catch (err) {
    log.warn("CONFIG", `读取 .mcp.json 失败: ${err}`);
    return {};
  }
}

/**
 * B1：加载 local 作用域 MCP 配置。
 *
 * local 承载个人/实验性/含敏感凭证的 server，不入版本库（对齐 CC 的 ~/.claude.json
 * 项目段 local 语义）。物理落点：~/.sid-code/projects/<项目路径 hash>/mcp.local.json，
 * 与该项目其它 per-project 状态同目录。用 git canonical root 派生 key（同仓多 worktree
 * 共享 local 配置），失败回退 cwd。
 */
async function loadLocalMcpJson(): Promise<Record<string, MCPServerConfig>> {
  const log = getLogger();
  try {
    const { resolveProjectRoot, sanitizeProjectKey } = await import("../memory/paths.ts");
    const { sidPaths } = await import("./paths.ts");
    const projectKey = sanitizeProjectKey(resolveProjectRoot(process.cwd()));
    const localPath = join(sidPaths.projects(), projectKey, "mcp.local.json");

    if (!existsSync(localPath)) {
      return {};
    }

    const content = await Bun.file(localPath).text();
    const parsed = JSON.parse(content);
    const servers = parsed.mcpServers || parsed.mcp_servers || parsed;
    if (typeof servers !== "object" || Array.isArray(servers)) {
      log.warn("CONFIG", `mcp.local.json 格式不正确，期望对象`);
      return {};
    }
    log.info("CONFIG", `mcp.local.json 加载 ${Object.keys(servers).length} 个 local MCP 服务器`);
    return servers;
  } catch (err) {
    log.warn("CONFIG", `读取 mcp.local.json 失败: ${err}`);
    return {};
  }
}

/** 加载完整配置 */
export async function loadConfig(cliArgs: Partial<Config> = {}): Promise<Config> {
  const defaults = defaultConfig();
  const fileConfig = await loadConfigFile();
  const envConfig = loadFromEnv();

  // 合并：默认值 → 配置文件 → 环境变量 → 命令行参数
  let merged = mergeConfig(defaults, fileConfig);
  merged = mergeConfig(merged, envConfig);
  merged = mergeConfig(merged, cliArgs);

  // B1：多源 MCP 配置合并（user > local > project，签名去重 + policy 过滤）。
  // 三源物理落点：
  //   user    —— ~/.sid-code/settings.json 的 mcpServers（合并期已进 merged.mcpServers）
  //   local   —— ~/.sid-code/projects/<项目 hash>/mcp.local.json（个人/实验，不入库）
  //   project —— CWD .mcp.json（团队共享，需审批）
  // 此前是「裸浅合并 {...user, ...project}」——项目级无条件覆盖用户级、方向与文档相反、
  // 无 local、无签名去重、无 policy。改为接线 mergeMcpConfigs 统一处理。
  {
    const userServers = ((merged as Config).mcpServers || {}) as Record<string, MCPServerConfig>;
    const localServers = await loadLocalMcpJson();

    // 项目级 .mcp.json 走审批：rejected 剔除、pending 标记（合并时经 ...config 透传保留）
    const mcpJsonServers = await loadMCPJson();
    const projectServers: Record<string, MCPServerConfig> = {};
    /** 待审批的项目级 server（不进生效列表，仅供 /mcp 面板展示与审批） */
    const pendingApprovalServers: Record<string, MCPServerConfig> = {};
    if (Object.keys(mcpJsonServers).length > 0) {
      const { getProjectServerApproval } = await import("../mcp/approval.ts");
      const projectPath = process.cwd();
      for (const [name, serverConfig] of Object.entries(mcpJsonServers)) {
        const status = getProjectServerApproval(name, projectPath);
        if (status === "rejected") {
          getLogger().info("CONFIG", `项目 MCP 服务器 "${name}" 已被拒绝，跳过`);
          continue;
        }
        if (status === "pending") {
          // SEC-AUDIT-2026-07-19 P1：pending **不加入生效列表**（fail-closed）。
          //
          // 此前这里只打一个 `_pendingApproval = true` 标记就照常 `projectServers[name] = …`,
          // 而那个标记全仓**没有任何读取者**——注释说"由 App 启动后交互确认"，但那段交互
          // 确认代码从来不存在。净效果：项目级 .mcp.json 声明的外部进程无门控直接连接，
          // 审批状态机（approved/rejected/pending）里只有 rejected 真正生效，
          // 而又没有任何入口能把 server 置为 rejected。
          //
          // 现在改为：pending → 不加入，登记到待审批快照，由 /mcp 面板审批后下次启动生效。
          pendingApprovalServers[name] = serverConfig;
          getLogger().info(
            "CONFIG",
            `项目 MCP 服务器 "${name}" 待审批，本次不加载（用 /mcp 审批）`,
          );
          continue;
        }
        projectServers[name] = serverConfig;
      }
      // 登记待审批快照，供 /mcp 面板展示与审批
      if (Object.keys(pendingApprovalServers).length > 0) {
        const { setPendingApprovalServers } = await import("../mcp/approval.ts");
        setPendingApprovalServers(pendingApprovalServers, projectPath);
      }
    }

    // 有 local/project 源，或配了 policy 时才走合并（否则保持纯 user 直通，零行为变化）。
    const policy = (merged as Config).mcpPolicy;
    if (Object.keys(localServers).length > 0 || Object.keys(projectServers).length > 0 || policy) {
      const { mergeMcpConfigs } = await import("../mcp/config.ts");
      const mergedMcp = mergeMcpConfigs(
        [
          { scope: "user", servers: userServers },
          { scope: "local", servers: localServers },
          { scope: "project", servers: projectServers },
        ],
        policy,
      );
      (merged as any).mcpServers = mergedMcp as Record<string, MCPServerConfig>;
    }
  }

  const config = merged as Config;

  // 记录用户显式配置的 maxTokens 全局覆盖值——必须在首次 resolveCurrentModelConfig 之前，
  // 否则 resolveCurrentModelConfig 读不到 _explicitMaxTokens 会走「按模型推导」分支，把用户
  // 显式值覆盖掉（回归）。供后续运行时 /model 切换区分「刻意设的」与「模型推导残留」。
  const userExplicitMaxTokens =
    cliArgs.maxTokens || (fileConfig as any).maxTokens || (envConfig as any).maxTokens;
  if (userExplicitMaxTokens) {
    const n = Number(userExplicitMaxTokens);
    if (Number.isFinite(n) && n > 0) config._explicitMaxTokens = n;
  }

  // env 原始 baseURL（合并前）——用于 resolveCurrentModelConfig 检测 per-model 覆盖 env 并告警。
  const envBaseURL = envConfig.baseURL;

  // 从 availableModels 解析当前模型的连接信息，回填顶层字段（含 maxTokens 按模型能力
  // 重算/钳制，已尊重上面登记的 _explicitMaxTokens）。
  resolveCurrentModelConfig(config, envBaseURL);

  // 如果 model 为空但 availableModels 有配置，自动选第一个作为默认模型
  if (!config.model && config.availableModels.length > 0) {
    const first = config.availableModels[0];
    config.model = first.name;
    // 从第一个模型回填 provider / baseURL / apiKey
    if (first.provider) config.provider = first.provider;
    if (first.baseURL) {
      if (envBaseURL && envBaseURL !== first.baseURL) {
        getLogger().warn(
          "CONFIG",
          `环境变量 baseURL（${envBaseURL}）被默认模型「${first.name}」的 base_url（${first.baseURL}）覆盖。` +
            `优先级：per-model base_url > env(SID_CODE_LLM_BASE_URL/OPENAI_BASE_URL)。`,
        );
      }
      config.baseURL = first.baseURL;
    }
    if (first.apiKey) {
      if (config.provider === "anthropic") config.anthropicKey = first.apiKey;
      else config.openaiKey = first.apiKey;
    }
  }

  // 如果 model 和 availableModels 都为空：
  //   - headless（print）模式：仍按原样 throw，无头场景无法交互引导，必须显式报错
  //   - TUI 模式：不 throw，标记 _needsOnboarding，放行进界面由 OnboardingDialog 引导。
  //     跳过后续 validateConfig 的 provider/model 致命校验（占位空值本就通不过，
  //     但这是预期的"待引导"状态而非配置错误）。
  if (!config.model && config.availableModels.length === 0) {
    if (config.print) {
      throw new Error(
        "未配置任何模型。请在 ~/.sid-code/settings.json 的 availableModels 数组中添加模型配置。\n" +
          '示例: { "availableModels": [{ "name": "<你的模型名>", "provider": "openai", "api_key": "sk-xxx", "base_url": "https://api.example.com" }] }\n' +
          "可选字段: contextWindow (上下文窗口), maxOutputTokens (最大输出), pricing (自定义价格), supportsThinking (是否支持深度思考)",
      );
    }
    config._needsOnboarding = true;
    // 收尾 sessionId 后提前返回，跳过 provider/model 致命校验（详见下方 return 前逻辑）
    if (!config.sessionId) {
      const { generateSessionId } = await import("../session/id.ts");
      config.sessionId = generateSessionId();
    }
    return config;
  }

  // maxTokens 兜底推导：_explicitMaxTokens 已在前面(首次 resolveCurrentModelConfig 之前)登记。
  // 当有 availableModels 时，resolveCurrentModelConfig 已完成 maxTokens 重算/钳制；
  // 但它对「无 availableModels」的场景早返回、不动 maxTokens，故此处兜底：用户未显式配置
  // 时按当前模型注册表推导。最后统一钳制到模型物理上限（含无 availableModels 的注册表兜底）。
  if (!config._explicitMaxTokens) {
    const modelMaxOutput = resolveModelMaxOutputTokens(config);
    if (modelMaxOutput) {
      config.maxTokens = modelMaxOutput;
    }
  }
  // 统一钳制：即便用户显式配置，也不能超过当前模型的物理输出上限（否则网关直接 400）。
  clampMaxTokensToModelCeiling(config);

  // P2-4：CC 的 "manual" 是 sid "default" 的别名，归一到内部规范名
  // （对齐 CC v2.1.200 default→Manual 改名；sid 内部仍用 default 作规范键）。
  if (config.permissionMode === "manual") {
    config.permissionMode = "default";
  }

  // skipPermissions / yesMode 同步到 permissionMode（状态栏显示用）
  if (config.skipPermissions) {
    config.permissionMode = "dangerously-skip-permissions";
  } else if (config.yesMode && config.permissionMode === "default") {
    config.permissionMode = "always-allow";
  }

  // 验证配置
  const { validateConfig } = await import("./schema.ts");
  const validation = validateConfig(config);

  // 暂存校验诊断：此刻 logger 尚未 initLogger（仍是 enabled=false 的兜底实例，
  // 会把 WARN 强制刷到 stderr 污染首屏、又吞掉 INFO/DEBUG 不落盘）。
  // 故不在此直接打印，挂到 config 上由上层在 logger 就绪后统一输出。
  if (validation.warnings.length > 0 || validation.errors.length > 0) {
    config._validationDiagnostics = {
      warnings: validation.warnings.map((w) => ({ path: w.path, message: w.message })),
      errors: validation.errors.map((e) => ({ path: e.path, message: e.message })),
    };
  }

  // 致命错误：provider / model 无效时必须立即阻止启动（不依赖 logger）。
  // 这是"不修就跑不起来"的唯一该抛首屏的情形。
  if (validation.errors.length > 0) {
    const hasFatalError = validation.errors.some(
      (e) => e.path === "provider" || e.path === "model",
    );
    if (hasFatalError) {
      const detail = validation.errors
        .filter((e) => e.path === "provider" || e.path === "model")
        .map((e) => `${e.path}: ${e.message}`)
        .join("; ");
      throw new Error(`配置验证失败，存在致命错误，无法启动 (${detail})`);
    }
  }

  // §3.6（fdb47f30）：确定 sessionId 单一事实源。
  // 原先 sessionId 默认 "" 一直保留到 App 构造（app.ts）才本地生成，但生成结果不回写
  // config，导致 cli.ts 的 registerSession(config.sessionId) 写入 active-sessions 的
  // sessionId 为空字符串（/ps 看不到会话 id）。此处在 loadConfig 收尾时统一回填：
  // 若未显式指定则生成 id，使 config.sessionId 从进程启动起就非空，
  // App / registerSession / SDK / 遥测全部复用同一值。resume 用独立的 config.resume
  // 字段，不受此影响。
  // id 格式见 session/id.ts（YYYYMMDD-HHMMSS-<hex>，可排序 + 抗碰撞）。
  if (!config.sessionId) {
    const { generateSessionId } = await import("../session/id.ts");
    config.sessionId = generateSessionId();
  }

  return config;
}

/**
 * 从 availableModels 解析当前模型的完整连接信息，回填到顶层字段。
 * 这样 registry / cli / schema 等消费方无需关心 "信息在模型还是顶层"。
 * 如果当前模型不在 availableModels 中，保持顶层字段不变（向后兼容）。
 *
 * baseURL 优先级链（不确定-4，从高到低）：
 *   per-model availableModels[].baseURL  >  env(SID_CODE_LLM_BASE_URL/OPENAI_BASE_URL)  >  默认
 * per-model 存在时无条件覆盖 env——这是有意设计（多模型各自端点必须独立），但此前静默覆盖，
 * 运维用 env 做临时故障演练/切端点时会"env 明明设了却不生效且无提示"。现改为：覆盖发生且
 * 两者取值不同时给一条 warn，让优先级链可发现。envBaseURL 由调用方传入（合并前 env 的原值）。
 */
export function resolveCurrentModelConfig(config: Config, envBaseURL?: string): void {
  // 别名表刷新（alias → modelId）。放在这里而不是只在启动时注册，是因为本函数是
  // 「启动解析」与「/model 运行时切换」的**共同咽喉**（app.ts 切模型后必调本函数），
  // 挂在这里就不存在「切了模型但别名表还是旧的」窗口。
  //
  // ⚠ 必须在**所有** early-return 之前，含下面「availableModels 为空」这条：
  //   - availableModels 为空 → 必须把表**清空**，否则上一份配置的映射残留，
  //     会把别名错翻成旧真名（切到无 modelId 配置后仍发旧真名，且不报错）；
  //   - mc 未命中（config.model 写了个不存在的名字）→ 表也要与当前列表一致。
  // setWireModelAliases(空/undefined) 即清空，所以这里无条件调用是安全的。
  const { setWireModelAliases } = require("../llm/wire-model.ts");
  setWireModelAliases(config.availableModels);

  // compat 表刷新（alias → 协议能力声明）。挂在这里的理由与上面别名表**逐条相同**：
  // 本函数是启动解析与 `/model` 运行时切换的共同咽喉，且「availableModels 为空」
  // 与「mc 未命中」两条 early-return 都必须先把表清空，否则上一份配置的声明残留 ——
  // 会让新配置按旧声明发字段，且不报错。setModelCompat(空) 即清空，无条件调用是安全的。
  const { setModelCompat } = require("../llm/model-compat.ts");
  setModelCompat(config.availableModels);

  if (!config.availableModels?.length) return;

  const mc = config.availableModels.find((m) => m.name === config.model);
  if (!mc) return;

  if (mc.provider) config.provider = mc.provider;
  if (mc.baseURL) {
    if (envBaseURL && envBaseURL !== mc.baseURL) {
      getLogger().warn(
        "CONFIG",
        `环境变量 baseURL（${envBaseURL}）被模型「${mc.name}」的 base_url（${mc.baseURL}）覆盖。` +
          `优先级：per-model base_url > env(SID_CODE_LLM_BASE_URL/OPENAI_BASE_URL)。` +
          `如需 env 生效，请删除该模型的 base_url 配置或直接改模型配置。`,
      );
    }
    config.baseURL = mc.baseURL;
  }
  if (mc.apiKey) {
    if (config.provider === "anthropic") {
      config.anthropicKey = mc.apiKey;
    } else {
      config.openaiKey = mc.apiKey;
    }
  }

  // maxTokens 重算（根治「运行时切模型不重算，把上个模型的高上限带到新模型触发 HTTP 400」）：
  //   1. 用户显式全局覆盖（_explicitMaxTokens）优先，但仍要钳制到新模型物理上限（见步骤 3）。
  //   2. 否则按新模型能力推导：availableModels[].maxOutputTokens > 内置注册表兜底。
  //      不能像旧实现那样「没配 maxOutputTokens 就不动 config.maxTokens」——那正是残留值 bug 根因。
  //   3. 无论哪条路径，最终都钳制到当前模型的物理输出上限。
  if (config._explicitMaxTokens && config._explicitMaxTokens > 0) {
    config.maxTokens = config._explicitMaxTokens;
  } else {
    const derived = resolveModelMaxOutputTokens(config);
    if (derived) config.maxTokens = derived;
  }
  clampMaxTokensToModelCeiling(config);
}

/**
 * 把 config.maxTokens 钳制到当前模型的物理输出上限（maxOutputTokens）。
 * 上限来源：availableModels[].maxOutputTokens > 内置注册表。二者都拿不到时不钳制
 * （未知模型不臆测上限，保持调用方给的值，避免误伤自定义端点）。
 * 幂等：多次调用结果一致。
 */
export function clampMaxTokensToModelCeiling(config: Config): void {
  const ceiling = resolveModelMaxOutputTokens(config);
  if (ceiling && config.maxTokens > ceiling) {
    getLogger().info(
      "CONFIG",
      `maxTokens ${config.maxTokens} 超过模型「${config.model}」输出上限 ${ceiling}，已钳制到 ${ceiling}`,
    );
    config.maxTokens = ceiling;
  }
}

/** 按「模型名 + availableModels 列表」解析该模型的 maxOutputTokens（单一事实源）。
 *  优先级：availableModels[].maxOutputTokens > 内置注册表兜底。二者都拿不到 → undefined
 *  （未知模型不臆测上限）。与 resolveModelMaxOutputTokens 共享同一逻辑，供 fallback 引擎
 *  等「需要解析非当前 config.model 的任意模型上限」的场景复用（见 H4：fallback 目标可能是
 *  注册表外的自定义模型，只查注册表会漏，必须先查 availableModels）。 */
export function resolveMaxOutputTokensForModel(
  model: string,
  availableModels?: Config["availableModels"],
): number | undefined {
  if (availableModels?.length) {
    // 第一优先仍按**别名**查：maxOutputTokens 是用户对「这条渠道」的显式声明，
    // 同一真名的两个端点上限确实可能不同（网关常比官方更紧），必须各自取各自的。
    const modelConfig = availableModels.find((m) => m.name === model);
    if (modelConfig?.maxOutputTokens) return modelConfig.maxOutputTokens;
  }
  // 兜底：从内置模型注册表获取（避免用户未配置时退化到硬编码 32768）。
  // 这一步必须换成**真名**——lookupRegistry 是精确/前缀/家族匹配，喂本地别名
  // （claude-sonnet-5-gateway）会 miss 到 undefined → 不钳制 → 把主模型的高 maxTokens
  // 原样发出去吃 400。别名与真名相同时 resolveWireModel 原样返回，行为不变。
  const { lookupRegistry } = require("../llm/model-registry.ts");
  const { resolveWireModel } = require("../llm/wire-model.ts");
  const entry = lookupRegistry(resolveWireModel(model, availableModels));
  return entry?.maxOutputTokens || undefined;
}

/** 从 availableModels 中查找当前模型的 maxOutputTokens，
 *  若用户未配置则从内置注册表兜底 */
export function resolveModelMaxOutputTokens(config: Config): number | undefined {
  return resolveMaxOutputTokensForModel(config.model, config.availableModels);
}

/** 确保配置目录存在 */
export async function ensureConfigDir(): Promise<string> {
  const configDir = getSidHome();
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }
  return configDir;
}

/**
 * 权限规则加载（历史 B 加载器，P2-1 后已收敛为 RuleLoader 薄封装）。
 *
 * 本函数不再自行解析任何文件，全部委托给 RuleLoader（单一事实源）。各源与优先级
 * 由 RuleLoader 统一负责（低→高）：
 *   session → command → cliArg → userSettings → projectSettings → localSettings → flagSettings → policySettings
 * 其中企业策略从 managedPolicyCandidates()（/etc/sid-code/managed-settings.json
 * + ~/.sid-code/managed-settings.json）加载——历史上冲突的 /etc/sid-code/policy.json
 * 与 policy.yaml 两个路径已废弃，不再读取。
 *
 * 调用方（cli.ts）仅用其返回值作 checker 构造期的**启动占位**规则；
 * checker.initRules() 会再跑一次 RuleLoader.loadAll 并以其为准（清除占位避免重复）。
 */
export async function loadPermissionRules(): Promise<
  import("../permission/types.ts").PermissionRule
> {
  const log = getLogger();

  // P2-1：两套加载器合一——以 RuleLoader 为唯一事实源。
  // 本函数（历史 B 加载器）保留为薄封装，仅供 cli.ts 构造 checker 时提供**启动占位**规则；
  // checker.initRules() 会再跑一次 RuleLoader.loadAll 并以其为准（并清除占位避免重复）。
  // 这样企业策略/user/project/local 各源只有 RuleLoader 一处解析逻辑，消除双读隐患。
  const { RuleLoader } = await import("../permission/rule-loader.ts");
  const loader = new RuleLoader(process.cwd());

  try {
    await loader.loadAll();
  } catch (err) {
    log.warn("CONFIG", `加载权限规则失败(RuleLoader.loadAll)`, err);
    return { allow: [], deny: [], ask: [] };
  }

  return loader.toPermissionRule();
}
