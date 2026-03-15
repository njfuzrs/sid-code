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
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
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

  // UI 配置
  noTUI: boolean;

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
}

/** 默认配置 */
export function defaultConfig(): Config {
  return {
    provider: "anthropic",
    model: "claude-sonnet-4-20250514",
    anthropicKey: "",
    openaiKey: "",
    baseURL: "",
    maxTokens: 8192,
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
    noTUI: false,
    debug: false,
    debugLevel: "INFO",
    debugLogFile: "~/.sid-code/debug.log",
    hooks: {},
    mcpServers: {},
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
    no_tui: "noTUI",
    debug: "debug",
    debug_level: "debugLevel",
    debug_log_file: "debugLogFile",
    hooks: "hooks",
    mcp_servers: "mcpServers",
    sub_agent_models: "subAgentModels",
    cost_limit: "costLimit",
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
    const normalized = normalizeConfigKeys(parsed);
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

/** 加载完整配置 */
export async function loadConfig(cliArgs: Partial<Config> = {}): Promise<Config> {
  const defaults = defaultConfig();
  const fileConfig = await loadConfigFile();
  const envConfig = loadFromEnv();

  // 合并：默认值 → 配置文件 → 环境变量 → 命令行参数
  let merged = mergeConfig(defaults, fileConfig);
  merged = mergeConfig(merged, envConfig);
  merged = mergeConfig(merged, cliArgs);

  return merged as Config;
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
