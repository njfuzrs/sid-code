/**
 * 模型参数速查表 — API 查不到时的兜底数据源。
 *
 * 设计原则：
 * - 支持精确匹配 + 最长前缀匹配（如 "deepseek-v4-flash" 匹配 "deepseek-v4-flash-*" 变体）
 * - 数据结构扁平，维护者只需添加条目
 * - 与 token-estimator.ts 的 MODEL_CONTEXT_LIMITS 互补（此处同时含 maxOutputTokens）
 *
 * 数据来源：各厂商官方文档 / API 返回值，更新时间 2026-06
 */

export interface ModelParamsEntry {
  contextWindow: number;
  maxOutputTokens: number;
  supportsThinking?: boolean;

  // ── 协议能力声明（可选，缺省时走 effort.ts runtime 推断兜底） ──

  /** system prompt 的 role 表示。默认 "system" */
  systemRole?: "system" | "developer";
  /** 输出 token 限制字段名。默认 "max_tokens" */
  maxTokensField?: "max_tokens" | "max_completion_tokens";
  /** 是否支持 temperature/top_p 采样参数。默认 true */
  supportsTemperature?: boolean;
  /** 支持的 reasoning_effort 档位。undefined = 不支持 */
  reasoningEffortValues?: ("low" | "medium" | "high")[];
  /** 协议族标识（用于 effort.ts 分发）。undefined = 走现有 runtime 推断 */
  protocolKind?: "deepseek-openai" | "deepseek-anthropic" | "anthropic-native" | "o-series" | "unknown";
}

/**
 * 精确匹配表。key = 模型全名或可前缀匹配的基名。
 * 查询时先精确匹配，再取最长前缀匹配。
 */
const CATALOG: Record<string, ModelParamsEntry> = {
  // ── Anthropic ──────────────────────────────────────────────────
  "claude-opus-4-8": { contextWindow: 1_000_000, maxOutputTokens: 128_000, supportsThinking: true, protocolKind: "anthropic-native" },
  "claude-opus-4-7": { contextWindow: 1_000_000, maxOutputTokens: 128_000, supportsThinking: true, protocolKind: "anthropic-native" },
  "claude-opus-4-6": { contextWindow: 1_000_000, maxOutputTokens: 128_000, supportsThinking: true, protocolKind: "anthropic-native" },
  "claude-sonnet-4-6": { contextWindow: 1_000_000, maxOutputTokens: 64_000, supportsThinking: true, protocolKind: "anthropic-native" },
  "claude-sonnet-4-5-20250514": { contextWindow: 200_000, maxOutputTokens: 64_000, supportsThinking: true, protocolKind: "anthropic-native" },
  "claude-haiku-4-5": { contextWindow: 200_000, maxOutputTokens: 64_000, supportsThinking: true, protocolKind: "anthropic-native" },
  "claude-haiku-4-5-20251001": { contextWindow: 200_000, maxOutputTokens: 64_000, supportsThinking: true, protocolKind: "anthropic-native" },

  // ── DeepSeek ───────────────────────────────────────────────────
  // V4 全系：1M context, 384K output；wot/maxthink 是同一模型的推理模式变体
  // protocolKind 由 runtime baseURL 推断更准确（同一模型可走 OpenAI 或 Anthropic 端点），故不声明
  "deepseek-v4-pro": { contextWindow: 1_000_000, maxOutputTokens: 393_216, supportsThinking: true },
  "deepseek-v4-flash": { contextWindow: 1_000_000, maxOutputTokens: 393_216, supportsThinking: true },
  "DeepSeek-V4-Flash": { contextWindow: 1_000_000, maxOutputTokens: 393_216, supportsThinking: true },

  // ── OpenAI / GPT ───────────────────────────────────────────────
  "gpt-5.4": { contextWindow: 1_050_000, maxOutputTokens: 128_000, supportsThinking: true },
  "gpt-5.4-mini": { contextWindow: 400_000, maxOutputTokens: 128_000, supportsThinking: true },
  "gpt-5.4-nano": { contextWindow: 400_000, maxOutputTokens: 128_000, supportsThinking: true },
  "gpt-4o": { contextWindow: 128_000, maxOutputTokens: 16_384 },
  "gpt-4o-mini": { contextWindow: 128_000, maxOutputTokens: 16_384 },

  // o-series：全部声明协议能力，新增模型只需一行配置
  "o1": {
    contextWindow: 200_000, maxOutputTokens: 100_000, supportsThinking: true,
    systemRole: "developer",
    maxTokensField: "max_completion_tokens",
    supportsTemperature: false,
    reasoningEffortValues: ["low", "medium", "high"],
    protocolKind: "o-series",
  },
  "o3": {
    contextWindow: 200_000, maxOutputTokens: 100_000, supportsThinking: true,
    systemRole: "developer",
    maxTokensField: "max_completion_tokens",
    supportsTemperature: false,
    reasoningEffortValues: ["low", "medium", "high"],
    protocolKind: "o-series",
  },
  "o3-mini": {
    contextWindow: 200_000, maxOutputTokens: 100_000, supportsThinking: true,
    systemRole: "developer",
    maxTokensField: "max_completion_tokens",
    supportsTemperature: false,
    reasoningEffortValues: ["low", "medium", "high"],
    protocolKind: "o-series",
  },
  "o4-mini": {
    contextWindow: 200_000, maxOutputTokens: 100_000, supportsThinking: true,
    systemRole: "developer",
    maxTokensField: "max_completion_tokens",
    supportsTemperature: false,
    reasoningEffortValues: ["low", "medium", "high"],
    protocolKind: "o-series",
  },

  // ── Kimi (Moonshot) ────────────────────────────────────────────
  "kimi-k2.6": { contextWindow: 262_144, maxOutputTokens: 32_768, supportsThinking: true },

  // ── Qwen / 通义千问 ────────────────────────────────────────────
  "qwen3.6-plus": { contextWindow: 1_000_000, maxOutputTokens: 65_536, supportsThinking: true },
  "qwen3.6-flash": { contextWindow: 1_000_000, maxOutputTokens: 65_536, supportsThinking: true },
  "qwen3.5-plus": { contextWindow: 1_000_000, maxOutputTokens: 65_536, supportsThinking: true },

  // ── Google Gemini ──────────────────────────────────────────────
  "gemini-3.1-flash-preview": { contextWindow: 1_048_576, maxOutputTokens: 65_536, supportsThinking: true },
  "gemini-3.1-flash-image-preview": { contextWindow: 128_000, maxOutputTokens: 32_000 },
  "gemini-3.5-flash": { contextWindow: 1_048_576, maxOutputTokens: 65_536, supportsThinking: true },
  "gemini-3-flash-preview": { contextWindow: 1_048_576, maxOutputTokens: 65_536, supportsThinking: true },

  // ── Embedding（无生成输出）──────────────────────────────────────
  "text-embedding-v4": { contextWindow: 8_192, maxOutputTokens: 0 },
  "text-embedding-3-small": { contextWindow: 8_191, maxOutputTokens: 0 },
  "text-embedding-3-large": { contextWindow: 8_191, maxOutputTokens: 0 },
};

/**
 * 从内置速查表查找模型参数。
 * 匹配策略：精确 → 最长前缀 → 剥离路由前缀后重试 → null
 */
export function lookupCatalog(modelName: string): ModelParamsEntry | null {
  // 1. 精确匹配
  if (CATALOG[modelName]) return CATALOG[modelName];

  // 2. 最长前缀匹配（覆盖 deepseek-v4-flash-maxthink 等变体）
  let best: ModelParamsEntry | null = null;
  let bestLen = 0;
  for (const [key, entry] of Object.entries(CATALOG)) {
    if (modelName.startsWith(key) && key.length > bestLen) {
      best = entry;
      bestLen = key.length;
    }
  }
  if (best) return best;

  // 3. 剥离路由前缀后重试（如 "kim/kimi-k2.6" → "kimi-k2.6"）
  const slashIdx = modelName.indexOf("/");
  if (slashIdx !== -1) {
    const bare = modelName.slice(slashIdx + 1);
    if (CATALOG[bare]) return CATALOG[bare];
    // 对剥离后的名字也做前缀匹配
    for (const [key, entry] of Object.entries(CATALOG)) {
      if (bare.startsWith(key) && key.length > bestLen) {
        best = entry;
        bestLen = key.length;
      }
    }
    if (best) return best;
  }

  // 4. 大小写不敏感匹配（如 "DeepSeek-V4-Flash" vs "deepseek-v4-flash"）
  const lower = modelName.toLowerCase();
  for (const [key, entry] of Object.entries(CATALOG)) {
    if (key.toLowerCase() === lower) return entry;
  }

  return null;
}

/** 获取完整的速查表（只读用途，如 /model discover 展示） */
export function getCatalogEntries(): ReadonlyArray<[string, ModelParamsEntry]> {
  return Object.entries(CATALOG);
}
