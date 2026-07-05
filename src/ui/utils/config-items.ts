/**
 * 配置项提取（/config 面板用）
 *
 * 从已合并的 Config 对象派生「分组 + 来源标记」的配置项列表。
 *
 * 关于来源判定的诚实说明：
 *   Config 加载后各来源（默认/用户/项目/CLI）已被合并成单一对象，原始来源信息不再保留。
 *   因此本模块只标注**可靠可知**的来源：
 *   - env：能在 process.env 命中对应覆盖变量的项
 *   - session：运行时旋钮（如 permissionMode 被 /mode 改过，此处标注运行时态）
 *   - default：值恰等于内置默认（DEFAULT 快照）
 *   - configured：非默认且非 env（用户或项目 settings.json，无法进一步区分，统一标「已配置」）
 *   不臆测「用户 vs 项目」，避免误导（对标文档「不臆测来源」原则）。
 */

import type { Config } from "../../config/config.ts";

export type ConfigSource = "default" | "configured" | "session" | "env";

export interface ConfigItemInfo {
  key: string;
  value: string;
  source: ConfigSource;
  group: string;
  description?: string;
  relatedCommand?: string;
}

/** 内置默认值快照（仅列本面板展示的项，用于 default 判定）。 */
const DEFAULTS: Record<string, unknown> = {
  maxTokens: 32768,
  permissionMode: "default",
  debug: true,
  debugLevel: "DEBUG",
};

/** env 覆盖变量映射：配置键 → 环境变量名。命中则标 env。 */
const ENV_KEYS: Record<string, string[]> = {
  provider: ["SID_CODE_LLM_PROVIDER"],
  model: ["SID_CODE_LLM_MODEL"],
  baseURL: ["SID_CODE_LLM_BASE_URL"],
  maxTokens: ["SID_MAX_OUTPUT_TOKENS"],
};

/** 判定单项来源。 */
function detectSource(key: string, value: unknown): ConfigSource {
  const envVars = ENV_KEYS[key];
  if (envVars && envVars.some((v) => process.env[v] != null && process.env[v] !== "")) {
    return "env";
  }
  if (key in DEFAULTS && value === DEFAULTS[key]) {
    return "default";
  }
  return "configured";
}

/** 来源标签（展示用中文）。 */
export function sourceLabel(source: ConfigSource): string {
  switch (source) {
    case "default":
      return "默认";
    case "configured":
      return "已配置";
    case "session":
      return "会话";
    case "env":
      return "环境变量";
  }
}

/**
 * 从 Config 派生分组配置项列表。
 * @param config 已合并的运行时配置
 * @param runtime 运行时旋钮态（effort/thinking/permissionMode 展示当前值，可选）
 */
export function extractConfigItems(
  config: Config,
  runtime?: {
    effortDisplay?: string;
    thinkingDisplay?: string;
    permissionMode?: string;
  },
): ConfigItemInfo[] {
  const items: ConfigItemInfo[] = [];

  // ── 模型与推理 ──
  items.push({
    key: "model",
    value: config.model || "(未配置)",
    source: detectSource("model", config.model),
    group: "模型与推理",
    description: "当前使用的 LLM 模型",
    relatedCommand: "/model <name> 切换模型",
  });
  items.push({
    key: "provider",
    value: config.provider || "(未配置)",
    source: detectSource("provider", config.provider),
    group: "模型与推理",
    description: "模型提供商",
    relatedCommand: "/model 面板切换",
  });
  if (config.baseURL) {
    items.push({
      key: "baseURL",
      value: config.baseURL,
      source: detectSource("baseURL", config.baseURL),
      group: "模型与推理",
      description: "API 基础地址",
    });
  }
  items.push({
    key: "effort",
    value: runtime?.effortDisplay ?? "auto",
    source: runtime?.effortDisplay && runtime.effortDisplay !== "auto" ? "session" : "default",
    group: "模型与推理",
    description: "推理强度档位",
    relatedCommand: "/effort 面板切换",
  });
  items.push({
    key: "think",
    value: runtime?.thinkingDisplay ?? "auto",
    source: runtime?.thinkingDisplay && runtime.thinkingDisplay !== "auto" ? "session" : "default",
    group: "模型与推理",
    description: "思考开关",
    relatedCommand: "/think 面板切换",
  });

  // ── 上下文 ──
  items.push({
    key: "maxTokens",
    value: String(config.maxTokens),
    source: detectSource("maxTokens", config.maxTokens),
    group: "上下文",
    description: "单次响应最大输出 tokens",
  });

  // ── 权限 ──
  items.push({
    key: "permissionMode",
    value: runtime?.permissionMode ?? config.permissionMode,
    source: runtime?.permissionMode && runtime.permissionMode !== config.permissionMode ? "session" : detectSource("permissionMode", config.permissionMode),
    group: "权限",
    description: "工具调用权限模式",
    relatedCommand: "/permissions 管理规则",
  });

  // ── MCP ──
  const mcpCount = Array.isArray(config.mcpServers)
    ? config.mcpServers.length
    : config.mcpServers && typeof config.mcpServers === "object"
      ? Object.keys(config.mcpServers).length
      : 0;
  items.push({
    key: "mcpServers",
    value: `${mcpCount} 个已配置`,
    source: mcpCount > 0 ? "configured" : "default",
    group: "MCP",
    description: "已配置的 MCP 服务器数量",
    relatedCommand: "/mcp 管理面板",
  });

  // ── 调试 ──
  items.push({
    key: "debug",
    value: String(config.debug),
    source: detectSource("debug", config.debug),
    group: "调试",
    description: "调试日志开关",
  });
  items.push({
    key: "debugLevel",
    value: String(config.debugLevel),
    source: detectSource("debugLevel", config.debugLevel),
    group: "调试",
    description: "调试日志级别",
  });

  return items;
}
