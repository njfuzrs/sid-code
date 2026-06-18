/**
 * 配置加载模块
 * 优先级：命令行参数 > 环境变量 > 配置文件 > 默认值
 * 配置文件位置：~/.sid-code/settings.json + ~/.sid-code/app.json（唯一真相源）
 */

import { parse as parseYAML } from "yaml";
import { join } from "path";
import { existsSync, mkdirSync } from "fs";
import { getLogger } from "../debug/logger.ts";
import { getSidHome } from "./paths.ts";

/** MCP 服务器配置 */
export interface MCPServerConfig {
  transport: "stdio" | "http" | "sse" | "ws";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  enabled?: boolean;       // 默认 true，可临时禁用服务器
  timeout?: number;        // 请求超时毫秒，默认 30000
  retries?: number;        // 重试次数，默认 2
  includeTools?: string[]; // 工具白名单（优先于 excludeTools）
  excludeTools?: string[]; // 工具黑名单
  // ─── IDE 集成元数据（动态注册的 IDE MCP server 使用，对标 Claude Code sse-ide/ws-ide） ───
  authToken?: string;          // 认证令牌（注入为 Authorization: Bearer 头）
  ideName?: string;            // IDE 名称（VS Code / Cursor / JetBrains 等）
  ideRunningInWindows?: boolean; // IDE 是否运行在 Windows 上（WSL 场景）
  scope?: "user" | "project" | "local" | "dynamic"; // 配置来源标记
}

/** Hook 配置（支持 command 和 url 两种类型） */
export interface HookConfig {
  type?: "command" | "url";       // 钩子类型，默认 command
  event?: string;                  // 旧格式兼容：事件名
  command?: string;                // command 类型：shell 命令
  url?: string;                    // url 类型：HTTP 地址
  method?: string;                 // url 类型：HTTP 方法，默认 POST
  headers?: Record<string, string>; // url 类型：HTTP 头
  timeout?: number;                // 超时（秒），默认 30
  blocking?: boolean;              // 是否阻塞，默认 false
  matcher?: string;                // 工具匹配（精确或 /regex/）
}

/** Hook 配置集合（按事件分组，新格式） */
export type HooksConfig = Record<string, HookConfig[]>;

/** 子代理模型映射（从 registry 重导出，方便配置层使用） */
export type { SubAgentModelMap } from "../llm/registry.ts";

// 定价类型复用 cost-tracker.ts 的单一真相源
export type { ModelPricing } from "../api/cost-tracker.ts";

/** 可用模型配置 */
export interface ModelConfig {
  name: string;
  provider?: string;
  baseURL?: string;
  apiKey?: string;
  contextWindow?: number;       // 上下文窗口（tokens）
  maxOutputTokens?: number;     // 最大输出 tokens
  supportsThinking?: boolean;   // 是否支持 Extended Thinking
  /** 可选：用户自配价格。配了则优先使用，未配则回退内置定价表兜底 */
  pricing?: ModelPricing;
}

/** 应用配置 */
export interface Config {
  // LLM 配置
  provider: string;
  model: string;
  /** 主模型失败时的降级模型（必须在 availableModels 中存在），为空字符串则不降级 */
  fallbackModel: string;
  anthropicKey: string;
  openaiKey: string;
  baseURL: string;
  maxTokens: number;
  availableModels: ModelConfig[];
  /** 输出语言偏好: "zh" 中文优先（默认）, "en" 英文优先。不设置时系统提示词默认中文 */
  language?: "zh" | "en";

  // 权限配置
  // 支持 6 种模式：default, always-allow, deny-write, acceptEdits, plan, dontAsk
  permissionMode: string;
  skipPermissions: boolean;
  allowedTools: string[];
  disallowedTools: string[];
  yesMode: boolean;

  // 目录白名单/黑名单
  allowedDirectories: string[];
  blockedDirectories: string[];

  // 会话配置
  sessionId: string;
  continue: boolean;
  resume: string;

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
   * - false（默认）：主屏 Static 渲染，历史进终端 scrollback，支持边流式边鼠标原生选中复制（对标 claude-code，见 ADR-040）
   * - true（--alternate-buffer opt-in）：全屏虚拟滚动 + 鼠标滚轮/滚动条 + Ctrl+S Copy Mode
   */
  alternateBuffer?: boolean;

  // 子代理模型映射
  subAgentModels?: import("../llm/registry.ts").SubAgentModelMap;

  // 成本配额（美元）
  costLimit?: number;

  // 配额管控（增强版，向后兼容 costLimit）
  quota?: QuotaFullConfig;

  // Hook 和 MCP
  hooks: HooksConfig;
  mcpServers: Record<string, MCPServerConfig>;

  // UI 配置
  /** 代码块是否显示行号（默认 true） */
  showLineNumbers: boolean;

  // Skill 配置
  /** 禁用的 Skill 名称列表 */
  disabledSkills?: string[];

  // 扩展安全配置
  /** 是否信任项目级扩展（跳过信任检查，默认 false） */
  trustProjectExtensions?: boolean;

  // 插件配置
  /** 会话级插件目录（--plugin-dir，不持久化，视为 inline 来源） */
  pluginDirs?: string[];

  // Checkpoint 配置
  checkpoint?: CheckpointConfig;

  // JIT 上下文发现
  /** 是否启用 JIT 上下文发现（默认 true） */
  jitContext?: boolean;

  // 工具延迟加载（ToolSearch）
  /**
   * 是否启用工具延迟加载（默认 false）。
   * 开启后：标记 shouldDefer 的工具不进首轮 LLM 上下文（用 activeDefinitions 替代
   * definitions），模型通过 tool_search 工具按需搜索并激活。工具数膨胀（50+）时
   * 显著降低首轮 token。关闭时全部工具照常进上下文，行为与历史一致。
   */
  toolSearch?: boolean;

  // 环境变量清理
  /** 是否在 bash 工具执行时清理环境变量（默认 false） */
  sanitizeEnv?: boolean;

  // LLM 命令风险分类器（P0-3 迭代 II）
  /** 是否启用 LLM 命令风险分类器（第二道防线，默认 false 保守） */
  enableLLMClassifier?: boolean;
  /** LLM 分类器使用的模型（默认复用主循环模型 config.model） */
  classifierModel?: string;

  // 会话保留配置
  sessionRetention?: SessionRetentionConfig;

  // 项目哈希（用于多项目隔离）
  projectHash?: string;

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
  /** trajectory-platform URL，含路径前缀，如 http://121.196.144.227/traj */
  url: string;
  /** X-Upload-Token 认证 token */
  token: string;
  /** 是否自动上传（默认 true，false 则仅本地保存） */
  autoUpload?: boolean;
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
  type: "console" | "jsonl";
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
  /** 后端类型，目前支持 http */
  type: "http";
  /** 远程端点 URL */
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
    debug: false,
    debugLevel: "INFO",
    debugLogFile: "~/.sid-code/debug.log",
    audit: true,
    auditLogFile: "~/.sid-code/audit.log",
    hooks: {},
    mcpServers: {},
    showLineNumbers: true,
    alternateBuffer: false,
  };
}

/** 解析字符串中的 ${ENV_VAR} 占位符（用于 authHeader 等敏感配置，避免明文落配置文件） */
function resolveEnvPlaceholder(value: string | undefined): string | undefined {
  if (!value || typeof value !== "string") return value;
  return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_m, name) => process.env[name] ?? "");
}

/** 将 YAML 字段名转换为 Config 字段名 */
function normalizeConfigKeys(raw: any): Partial<Config> {
  if (!raw || typeof raw !== "object") {
    return {};
  }
  const keyMap: Record<string, keyof Config> = {
    provider: "provider",
    model: "model",
    fallback_model: "fallbackModel",
    anthropic_key: "anthropicKey",
    openai_api_key: "openaiKey",
    base_url: "baseURL",
    max_tokens: "maxTokens",
    available_models: "availableModels",
    permission_mode: "permissionMode",
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
    sub_agent_models: "subAgentModels",
    cost_limit: "costLimit",
    show_line_numbers: "showLineNumbers",
    quota: "quota",
    disabled_skills: "disabledSkills",
    trust_project_extensions: "trustProjectExtensions",
    checkpoint: "checkpoint",
    jit_context: "jitContext",
    tool_search: "toolSearch",
    sanitize_env: "sanitizeEnv",
    enable_llm_classifier: "enableLLMClassifier",
    classifier_model: "classifierModel",
    trace: "trace",
    search: "search",
    telemetry: "telemetry",
    analytics: "analytics",
    language: "language",
  };

  const result: any = {};
  for (const [yamlKey, value] of Object.entries(raw as Record<string, any>)) {
    const configKey = keyMap[yamlKey] || yamlKey;

    // 特殊处理 available_models，转换字段名
    if (configKey === "availableModels" && Array.isArray(value)) {
      result[configKey] = value.map((m: any) => ({
        name: m.name,
        provider: m.provider,
        baseURL: m.base_url || m.baseURL,
        apiKey: m.api_key || m.apiKey,
        contextWindow: m.context_window || m.contextWindow,
        maxOutputTokens: m.max_output_tokens || m.maxOutputTokens,
        supportsThinking: m.supports_thinking ?? m.supportsThinking,
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
        upload: upload && typeof upload === "object" ? {
          url: upload.url,
          token: upload.token,
          autoUpload: upload.auto_upload ?? upload.autoUpload,
          userId: upload.user_id || upload.userId,
          deviceId: upload.device_id || upload.deviceId,
          toolSource: upload.tool_source || upload.toolSource,
          maxRetries: upload.max_retries || upload.maxRetries,
          retryBaseMs: upload.retry_base_ms || upload.retryBaseMs,
          compress: upload.compress,
          healthCheckIntervalMs: upload.health_check_interval_ms || upload.healthCheckIntervalMs,
          maxQueueRetries: upload.max_queue_retries || upload.maxQueueRetries,
          queueScanIntervalMs: upload.queue_scan_interval_ms || upload.queueScanIntervalMs,
        } : undefined,
      };
    // 特殊处理 telemetry：转换字段名
    } else if (configKey === "telemetry" && typeof value === "object" && value !== null) {
      const v = value as any;
      result[configKey] = {
        enabled: v.enabled ?? false,
        exporters: Array.isArray(v.exporters) ? v.exporters : [],
        batchSize: v.batch_size || v.batchSize,
        flushIntervalMs: v.flush_interval_ms || v.flushIntervalMs,
        maxQueueSize: v.max_queue_size || v.maxQueueSize,
      };
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
        Object.assign(merged, raw);
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
    baseURL: env.SID_CODE_LLM_BASE_URL,
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

/** 加载完整配置 */
export async function loadConfig(cliArgs: Partial<Config> = {}): Promise<Config> {
  const defaults = defaultConfig();
  const fileConfig = await loadConfigFile();
  const envConfig = loadFromEnv();

  // 合并：默认值 → 配置文件 → 环境变量 → 命令行参数
  let merged = mergeConfig(defaults, fileConfig);
  merged = mergeConfig(merged, envConfig);
  merged = mergeConfig(merged, cliArgs);

  // 合并项目级 .mcp.json（项目级覆盖全局）
  const mcpJsonServers = await loadMCPJson();
  if (Object.keys(mcpJsonServers).length > 0) {
    const existing = (merged as Config).mcpServers || {};
    (merged as any).mcpServers = { ...existing, ...mcpJsonServers };
  }

  const config = merged as Config;

  // 从 availableModels 解析当前模型的连接信息，回填顶层字段
  resolveCurrentModelConfig(config);

  // 如果 model 为空但 availableModels 有配置，自动选第一个作为默认模型
  if (!config.model && config.availableModels.length > 0) {
    const first = config.availableModels[0];
    config.model = first.name;
    // 从第一个模型回填 provider / baseURL / apiKey
    if (first.provider) config.provider = first.provider;
    if (first.baseURL) config.baseURL = first.baseURL;
    if (first.apiKey) {
      if (config.provider === "anthropic") config.anthropicKey = first.apiKey;
      else config.openaiKey = first.apiKey;
    }
  }

  // 如果 model 和 availableModels 都为空，给出明确引导
  if (!config.model && config.availableModels.length === 0) {
    throw new Error(
      "未配置任何模型。请在 ~/.sid-code/settings.json 的 availableModels 数组中添加模型配置。\n" +
      "示例: { \"availableModels\": [{ \"name\": \"<你的模型名>\", \"provider\": \"openai\", \"api_key\": \"sk-xxx\", \"base_url\": \"https://api.example.com\" }] }\n" +
      "可选字段: contextWindow (上下文窗口), maxOutputTokens (最大输出), pricing (自定义价格), supportsThinking (是否支持深度思考)",
    );
  }

  // 如果用户未显式配置 maxTokens，从当前模型的 maxOutputTokens 自动推导
  const userExplicitMaxTokens = cliArgs.maxTokens || (fileConfig as any).maxTokens || (envConfig as any).maxTokens;
  if (!userExplicitMaxTokens) {
    const modelMaxOutput = resolveModelMaxOutputTokens(config);
    if (modelMaxOutput) {
      config.maxTokens = modelMaxOutput;
    }
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
      warnings: validation.warnings.map(w => ({ path: w.path, message: w.message })),
      errors: validation.errors.map(e => ({ path: e.path, message: e.message })),
    };
  }

  // 致命错误：provider / model 无效时必须立即阻止启动（不依赖 logger）。
  // 这是"不修就跑不起来"的唯一该抛首屏的情形。
  if (validation.errors.length > 0) {
    const hasFatalError = validation.errors.some(e =>
      e.path === "provider" || e.path === "model"
    );
    if (hasFatalError) {
      const detail = validation.errors
        .filter(e => e.path === "provider" || e.path === "model")
        .map(e => `${e.path}: ${e.message}`)
        .join("; ");
      throw new Error(`配置验证失败，存在致命错误，无法启动 (${detail})`);
    }
  }

  // §3.6（fdb47f30）：确定 sessionId 单一事实源。
  // 原先 sessionId 默认 "" 一直保留到 App 构造（app.ts）才本地生成，但生成结果不回写
  // config，导致 cli.ts 的 registerSession(config.sessionId) 写入 active-sessions 的
  // sessionId 为空字符串（/ps 看不到会话 id）。此处在 loadConfig 收尾时统一回填：
  // 若未显式指定则生成 8 位短 id，使 config.sessionId 从进程启动起就非空，
  // App / registerSession / SDK / 遥测全部复用同一值。resume 用独立的 config.resume
  // 字段，不受此影响。
  if (!config.sessionId) {
    config.sessionId = crypto.randomUUID().slice(0, 8);
  }

  return config;
}

/**
 * 从 availableModels 解析当前模型的完整连接信息，回填到顶层字段。
 * 这样 registry / cli / schema 等消费方无需关心 "信息在模型还是顶层"。
 * 如果当前模型不在 availableModels 中，保持顶层字段不变（向后兼容）。
 */
export function resolveCurrentModelConfig(config: Config): void {
  if (!config.availableModels?.length) return;
  const mc = config.availableModels.find(m => m.name === config.model);
  if (!mc) return;

  if (mc.provider) config.provider = mc.provider;
  if (mc.baseURL) config.baseURL = mc.baseURL;
  if (mc.apiKey) {
    if (config.provider === "anthropic") {
      config.anthropicKey = mc.apiKey;
    } else {
      config.openaiKey = mc.apiKey;
    }
  }
  if (mc.maxOutputTokens) config.maxTokens = mc.maxOutputTokens;
}

/** 从 availableModels 中查找当前模型的 maxOutputTokens */
export function resolveModelMaxOutputTokens(config: Config): number | undefined {
  if (!config.availableModels?.length) return undefined;
  const modelConfig = config.availableModels.find(m => m.name === config.model);
  return modelConfig?.maxOutputTokens || undefined;
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
 * 五层权限规则加载
 * 优先级（数组合并，deny > allow > ask）：
 * 1. 策略配置：/etc/sid-code/policy.yaml（企业级，可选）
 * 2. 全局配置：~/.sid-code/settings.json 中的 permissions 字段
 * 3. 项目配置：<project>/.sid-code/permissions.yaml（团队共享）
 * 4. 本地配置：<project>/.sid-code/permissions.local.yaml（个人，加入 .gitignore）
 * 5. 会话配置：内存中的临时规则（由 checker 的 sessionMemory 管理）
 */
export async function loadPermissionRules(): Promise<import("../permission/types.ts").PermissionRule> {
  const log = getLogger();
  const { mergeRules } = await import("../permission/rules.ts");

  const layers: string[] = [
    "/etc/sid-code/policy.yaml",
    join(getSidHome(), "settings.json"),
    join(process.cwd(), ".sid-code/permissions.yaml"),
    join(process.cwd(), ".sid-code/permissions.local.yaml"),
  ];

  const allRules: import("../permission/types.ts").PermissionRule[] = [];

  for (const filePath of layers) {
    if (!existsSync(filePath)) continue;

    try {
      const content = await Bun.file(filePath).text();
      // settings.json 为 JSON，其余层为 YAML
      const parsed = filePath.endsWith(".json")
        ? JSON.parse(content)
        : parseYAML(content);
      const permissions = parsed?.permissions || parsed?.permission_rules;
      if (!permissions) continue;

      const rule: import("../permission/types.ts").PermissionRule = {
        allow: permissions.allow || [],
        deny: permissions.deny || [],
        ask: permissions.ask || [],
      };

      // 同时提取目录白名单/黑名单（如果有）
      allRules.push(rule);
      log.debug("CONFIG", `加载权限规则: ${filePath}`, {
        allow: rule.allow?.length || 0,
        deny: rule.deny?.length || 0,
        ask: rule.ask?.length || 0,
      });
    } catch (err) {
      log.warn("CONFIG", `读取权限规则失败: ${filePath}`, err);
    }
  }

  if (allRules.length === 0) {
    return { allow: [], deny: [], ask: [] };
  }

  return mergeRules(...allRules);
}
