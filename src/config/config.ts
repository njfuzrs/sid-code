/**
 * 配置加载模块
 * 优先级：命令行参数 > 环境变量 > 配置文件 > 默认值
 * 配置文件位置：~/.sid-code/config.yaml
 */

import { parse as parseYAML } from "yaml";
import { join } from "path";
import { homedir } from "os";
import { existsSync, mkdirSync } from "fs";

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

/** 应用配置 */
export interface Config {
  // LLM 配置
  provider: string;
  model: string;
  anthropicKey: string;
  openaiKey: string;
  baseURL: string;
  maxTokens: number;

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
    hooks: [],
    mcpServers: {},
  };
}

/** 加载配置文件 */
async function loadConfigFile(): Promise<Partial<Config>> {
  const configDir = join(homedir(), ".sid-code");
  const configPath = join(configDir, "config.yaml");

  if (!existsSync(configPath)) {
    return {};
  }

  try {
    const file = Bun.file(configPath);
    const content = await file.text();
    const parsed = parseYAML(content);
    return parsed || {};
  } catch (err) {
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
