/**
 * 配置加载模块
 * 优先级：命令行参数 > 环境变量 > 配置文件 > 默认值
 * 配置文件位置：~/.sid-code/config.yaml
 */

import { parse as parseYAML } from "yaml";
import { join } from "path";
import { homedir } from "os";
import { existsSync, mkdirSync } from "fs";
import { getLogger } from "../debug/logger.ts";

/** MCP 服务器配置 */
export interface MCPServerConfig {
  transport: "stdio" | "http" | "sse";
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

/** 可用模型配置 */
export interface ModelConfig {
  name: string;
  provider?: string;
  baseURL?: string;
  apiKey?: string;
  contextWindow?: number;       // 上下文窗口（tokens）
  maxOutputTokens?: number;     // 最大输出 tokens
  supportsThinking?: boolean;   // 是否支持 Extended Thinking
}

/** 应用配置 */
export interface Config {
  // LLM 配置
  provider: string;
  model: string;
  anthropicKey: string;
  openaiKey: string;
  baseURL: string;
  maxTokens: number;
  availableModels: ModelConfig[];

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

  // 系统提示词配置
  systemPrompt: string;
  appendSystemPrompt: string;
  systemPromptFile: string;

  // 调试配置
  debug: boolean;
  debugLevel: string;
  debugLogFile: string;

  // 子代理模型映射
  subAgentModels?: import("../llm/registry.ts").SubAgentModelMap;

  // 成本配额（美元）
  costLimit?: number;

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

  // Checkpoint 配置
  checkpoint?: CheckpointConfig;

  // JIT 上下文发现
  /** 是否启用 JIT 上下文发现（默认 true） */
  jitContext?: boolean;

  // 环境变量清理
  /** 是否在 bash 工具执行时清理环境变量（默认 false） */
  sanitizeEnv?: boolean;

  // 会话保留配置
  sessionRetention?: SessionRetentionConfig;

  // 项目哈希（用于多项目隔离）
  projectHash?: string;
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

/** 默认配置 */
export function defaultConfig(): Config {
  return {
    provider: "anthropic",
    model: "claude-sonnet-4-20250514",
    anthropicKey: "",
    openaiKey: "",
    baseURL: "",
    maxTokens: 16384,
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
    systemPrompt: "",
    appendSystemPrompt: "",
    systemPromptFile: "",
    debug: false,
    debugLevel: "INFO",
    debugLogFile: "~/.sid-code/debug.log",
    hooks: {},
    mcpServers: {},
    showLineNumbers: true,
  };
}

/** 将 YAML 字段名转换为 Config 字段名 */
function normalizeConfigKeys(raw: any): Partial<Config> {
  if (!raw || typeof raw !== "object") {
    return {};
  }

  const keyMap: Record<string, keyof Config> = {
    provider: "provider",
    model: "model",
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
    hooks: "hooks",
    mcp_servers: "mcpServers",
    sub_agent_models: "subAgentModels",
    cost_limit: "costLimit",
    show_line_numbers: "showLineNumbers",
    disabled_skills: "disabledSkills",
    trust_project_extensions: "trustProjectExtensions",
    checkpoint: "checkpoint",
    jit_context: "jitContext",
    sanitize_env: "sanitizeEnv",
  };

  const result: any = {};
  for (const [yamlKey, value] of Object.entries(raw)) {
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
    } else {
      result[configKey] = value;
    }
  }

  return result;
}

/** 加载配置文件 */
async function loadConfigFile(): Promise<Partial<Config>> {
  const log = getLogger();
  const configDir = join(homedir(), ".sid-code");
  const configPath = join(configDir, "config.yaml");

  if (!existsSync(configPath)) {
    log.debug("CONFIG", `配置文件不存在: ${configPath}`);
    return {};
  }

  try {
    const file = Bun.file(configPath);
    const content = await file.text();
    const parsed = parseYAML(content);

    // 环境变量插值
    const { resolveEnvVars } = await import("./env-interpolation.ts");
    const interpolated = resolveEnvVars(parsed);

    const normalized = normalizeConfigKeys(interpolated);
    log.configLoaded("配置文件", { path: configPath, keys: Object.keys(normalized) });
    return normalized;
  } catch (err) {
    log.error("CONFIG", `读取配置文件失败: ${configPath}`, err);
    throw new Error(`读取配置文件失败: ${err}`);
  }
}

/** 从环境变量加载配置 */
function loadFromEnv(): Partial<Config> {
  const env = process.env;
  return {
    provider: env.LLM_PROVIDER,
    model: env.LLM_MODEL,
    baseURL: env.LLM_BASE_URL,
    anthropicKey: env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN,
    openaiKey: env.OPENAI_API_KEY || env.LLM_API_KEY,
  };
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
  const log = getLogger();
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

  // 如果用户未显式配置 maxTokens，从当前模型的 maxOutputTokens 自动推导
  const userExplicitMaxTokens = cliArgs.maxTokens || (fileConfig as any).maxTokens || (envConfig as any).maxTokens;
  if (!userExplicitMaxTokens) {
    const modelMaxOutput = resolveModelMaxOutputTokens(config);
    if (modelMaxOutput) {
      config.maxTokens = modelMaxOutput;
    }
  }

  // 验证配置
  const { validateConfig } = await import("./schema.ts");
  const validation = validateConfig(config);

  // 输出警告
  if (validation.warnings.length > 0) {
    log.warn("CONFIG", `配置验证发现 ${validation.warnings.length} 个警告:`);
    for (const warning of validation.warnings) {
      log.warn("CONFIG", `  ⚠ ${warning.path}: ${warning.message}`);
    }
  }

  // 输出错误
  if (validation.errors.length > 0) {
    log.warn("CONFIG", `配置验证发现 ${validation.errors.length} 个错误:`);
    for (const error of validation.errors) {
      log.warn("CONFIG", `  ✗ ${error.path}: ${error.message}`);
    }

    // 致命错误：provider 无效时阻止启动
    const hasFatalError = validation.errors.some(e =>
      e.path === "provider" || e.path === "model"
    );
    if (hasFatalError) {
      throw new Error("配置验证失败，存在致命错误，无法启动");
    }
  }

  return config;
}

/** 从 availableModels 中查找当前模型的 maxOutputTokens */
export function resolveModelMaxOutputTokens(config: Config): number | undefined {
  if (!config.availableModels?.length) return undefined;
  const modelConfig = config.availableModels.find(m => m.name === config.model);
  return modelConfig?.maxOutputTokens || undefined;
}

/** 确保配置目录存在 */
export async function ensureConfigDir(): Promise<string> {
  const configDir = join(homedir(), ".sid-code");
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }
  return configDir;
}

/**
 * 五层权限规则加载
 * 优先级（数组合并，deny > allow > ask）：
 * 1. 策略配置：/etc/sid-code/policy.yaml（企业级，可选）
 * 2. 全局配置：~/.sid-code/config.yaml 中的 permissions 字段
 * 3. 项目配置：<project>/.sid-code/permissions.yaml（团队共享）
 * 4. 本地配置：<project>/.sid-code/permissions.local.yaml（个人，加入 .gitignore）
 * 5. 会话配置：内存中的临时规则（由 checker 的 sessionMemory 管理）
 */
export async function loadPermissionRules(): Promise<import("../permission/types.ts").PermissionRule> {
  const log = getLogger();
  const { mergeRules } = await import("../permission/rules.ts");

  const layers: string[] = [
    "/etc/sid-code/policy.yaml",
    join(homedir(), ".sid-code/config.yaml"),
    join(process.cwd(), ".sid-code/permissions.yaml"),
    join(process.cwd(), ".sid-code/permissions.local.yaml"),
  ];

  const allRules: import("../permission/types.ts").PermissionRule[] = [];

  for (const filePath of layers) {
    if (!existsSync(filePath)) continue;

    try {
      const content = await Bun.file(filePath).text();
      const parsed = parseYAML(content);
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
