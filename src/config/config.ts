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

/** Hook 配置 */
export interface HookConfig {
  event: string;
  command: string;
  timeout?: number;
}

/** 可用模型配置 */
export interface ModelConfig {
  name: string;
  provider?: string;
  baseURL?: string;
  apiKey?: string;
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
  permissionMode: string;
  skipPermissions: boolean;
  allowedTools: string[];
  disallowedTools: string[];
  yesMode: boolean;

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

  // Hook 和 MCP
  hooks: HookConfig[];
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
    hooks: [],
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
      }));
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
