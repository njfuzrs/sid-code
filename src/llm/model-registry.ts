/**
 * 统一模型注册表 — 所有模型参数与定价的**单一事实源**。
 *
 * 设计原则：
 * - 一个模型只在此处定义一次（参数 + 定价合一）
 * - model-params-catalog.ts / cost-tracker.ts / token-estimator.ts 均从此处读取
 * - 支持精确匹配 + 最长前缀 + 路由剥离 + 大小写不敏感 + 家族匹配
 *
 * 数据来源：各厂商官方文档 / API 返回值，更新时间 2026-06
 */

/** 定价（每百万 token，USD） */
export interface RegistryPricing {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/** 模型完整参数定义 */
export interface ModelRegistryEntry {
  contextWindow: number;
  maxOutputTokens: number;
  supportsThinking?: boolean;

  // ── 协议能力声明（可选，缺省时走 runtime 推断） ──
  systemRole?: "system" | "developer";
  maxTokensField?: "max_tokens" | "max_completion_tokens";
  supportsTemperature?: boolean;
  reasoningEffortValues?: ("low" | "medium" | "high" | "max")[];
  protocolKind?: "deepseek-openai" | "deepseek-anthropic" | "anthropic-native" | "o-series" | "glm-openai" | "grok-openai" | "unknown";

  /**
   * 多轮工具调用时，是否要求把该轮 assistant 的 reasoning_content 原样回传给 API。
   *
   * - DeepSeek V4（V3.2 起）thinking 模式：`true`——tool-call 轮的 reasoning_content
   *   **必须**回传，否则 API 400（deepseek-api.md:1012/1055/1057）；官方样例（1160-1174 行）
   *   一律 `messages.append(response.choices[0].message)`，含 reasoning_content。
   * - 旧 `deepseek-reasoner`（R1 系，2026/07/24 弃用前）：`false` 或 undefined——
   *   输入携带 reasoning_content 会触发旧协议 400，必须落掉。
   * - 其它模型（无 reasoning_content 概念）：字段无意义，缺省 undefined。
   *
   * 详见 docs/bugfixes/todo/deepseek-reasoning-leak-as-text-任务中断.md 方案⓪。
   */
  requiresReasoningContentForToolCalls?: boolean;

  /**
   * Extended Thinking 模式（Anthropic 协议族专用）。
   *
   * - `"adaptive"`：Opus 4.7+/Sonnet 4.6/Fable 5 — 下发 `thinking:{type:"adaptive"}` + `output_config.effort`
   * - `"always-on"`：Fable 5/Mythos 5 — 自适应始终开启，不可关闭（`thinking:{type:"disabled"}` 返回 400）
   * - undefined（= "manual" 兜底）：旧模型 — 下发 `thinking:{type:"enabled", budget_tokens:N}`
   *
   * [来源: anthropic-api.md:320-323]
   */
  thinkingMode?: "adaptive" | "always-on";

  // ── 定价（可选，USD/百万 token） ──
  pricing?: RegistryPricing;
}

const REGISTRY: Record<string, ModelRegistryEntry> = {
  // ══════════════════════════════════════════════════════════════════
  // Anthropic Claude
  // ══════════════════════════════════════════════════════════════════
  "claude-fable-5": { contextWindow: 1_000_000, maxOutputTokens: 128_000, supportsThinking: true, protocolKind: "anthropic-native", thinkingMode: "always-on", pricing: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 } },
  "claude-mythos-5": { contextWindow: 1_000_000, maxOutputTokens: 128_000, supportsThinking: true, protocolKind: "anthropic-native", thinkingMode: "always-on", pricing: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 } },
  "claude-opus-4-8": { contextWindow: 1_000_000, maxOutputTokens: 128_000, supportsThinking: true, protocolKind: "anthropic-native", thinkingMode: "adaptive", pricing: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } },
  "claude-opus-4-7": { contextWindow: 1_000_000, maxOutputTokens: 128_000, supportsThinking: true, protocolKind: "anthropic-native", thinkingMode: "adaptive", pricing: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } },
  "claude-opus-4-6": { contextWindow: 1_000_000, maxOutputTokens: 128_000, supportsThinking: true, protocolKind: "anthropic-native", thinkingMode: "adaptive", pricing: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } },
  "claude-opus-4-20250514": { contextWindow: 1_000_000, maxOutputTokens: 128_000, supportsThinking: true, protocolKind: "anthropic-native", pricing: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 } },
  "claude-sonnet-4-6": { contextWindow: 1_000_000, maxOutputTokens: 128_000, supportsThinking: true, protocolKind: "anthropic-native", thinkingMode: "adaptive", pricing: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } },
  "claude-sonnet-4-5-20250514": { contextWindow: 200_000, maxOutputTokens: 64_000, supportsThinking: true, protocolKind: "anthropic-native", pricing: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } },
  "claude-sonnet-4-20250514": { contextWindow: 200_000, maxOutputTokens: 64_000, supportsThinking: true, protocolKind: "anthropic-native", pricing: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } },
  "claude-haiku-4-5": { contextWindow: 200_000, maxOutputTokens: 64_000, supportsThinking: true, protocolKind: "anthropic-native", pricing: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 } },
  "claude-haiku-4-5-20251001": { contextWindow: 200_000, maxOutputTokens: 64_000, supportsThinking: true, protocolKind: "anthropic-native", pricing: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 } },
  "claude-haiku-4-20250514": { contextWindow: 200_000, maxOutputTokens: 64_000, supportsThinking: true, protocolKind: "anthropic-native", pricing: { input: 0.25, output: 1.25, cacheRead: 0.025, cacheWrite: 0.3125 } },
  "claude-3-5-sonnet-20241022": { contextWindow: 200_000, maxOutputTokens: 8_192, supportsThinking: false, protocolKind: "anthropic-native", pricing: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } },
  "claude-3-5-haiku-20241022": { contextWindow: 200_000, maxOutputTokens: 8_192, supportsThinking: false, protocolKind: "anthropic-native", pricing: { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 } },
  "claude-3-opus-20240229": { contextWindow: 200_000, maxOutputTokens: 4_096, supportsThinking: false, protocolKind: "anthropic-native", pricing: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 } },

  // ══════════════════════════════════════════════════════════════════
  // DeepSeek
  // ══════════════════════════════════════════════════════════════════
  // DeepSeek V4（V3.2 起）：thinking 模式支持工具调用，tool-call 轮必须回传 reasoning_content。
  "deepseek-v4-pro": { contextWindow: 1_000_000, maxOutputTokens: 384_000, supportsThinking: true, requiresReasoningContentForToolCalls: true, pricing: { input: 0.435, output: 0.87, cacheRead: 0.0036, cacheWrite: 0 } },
  "deepseek-v4-flash": { contextWindow: 1_000_000, maxOutputTokens: 384_000, supportsThinking: true, requiresReasoningContentForToolCalls: true, pricing: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 } },
  "DeepSeek-V4-Flash": { contextWindow: 1_000_000, maxOutputTokens: 384_000, supportsThinking: true, requiresReasoningContentForToolCalls: true, pricing: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 } },
  "DeepSeek-V4-Pro": { contextWindow: 1_000_000, maxOutputTokens: 384_000, supportsThinking: true, requiresReasoningContentForToolCalls: true, pricing: { input: 0.435, output: 0.87, cacheRead: 0.0036, cacheWrite: 0 } },
  "deepseek-chat": { contextWindow: 1_000_000, maxOutputTokens: 384_000, supportsThinking: false, pricing: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 } },
  // 旧 deepseek-reasoner（R1 系）：输入携带 reasoning_content 会触发旧协议 400，保持不回传（缺省 false）。
  "deepseek-reasoner": { contextWindow: 1_000_000, maxOutputTokens: 384_000, supportsThinking: true, requiresReasoningContentForToolCalls: false, pricing: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 } },

  // ══════════════════════════════════════════════════════════════════
  // OpenAI / GPT
  // ══════════════════════════════════════════════════════════════════
  "gpt-5.5": { contextWindow: 1_050_000, maxOutputTokens: 128_000, supportsThinking: false, pricing: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 } },
  "gpt-5.5-pro": { contextWindow: 1_000_000, maxOutputTokens: 128_000, supportsThinking: false, pricing: { input: 30, output: 180, cacheRead: 0, cacheWrite: 0 } },
  "gpt-5.4": { contextWindow: 1_050_000, maxOutputTokens: 128_000, supportsThinking: false, pricing: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 } },
  "gpt-5.4-mini": { contextWindow: 400_000, maxOutputTokens: 128_000, supportsThinking: false, pricing: { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0 } },
  "gpt-5.4-nano": { contextWindow: 400_000, maxOutputTokens: 128_000, supportsThinking: false, pricing: { input: 0.2, output: 1.25, cacheRead: 0.02, cacheWrite: 0 } },
  "gpt-5.4-pro": { contextWindow: 1_000_000, maxOutputTokens: 128_000, supportsThinking: false, pricing: { input: 30, output: 180, cacheRead: 0, cacheWrite: 0 } },
  "gpt-5.2": { contextWindow: 1_000_000, maxOutputTokens: 128_000, supportsThinking: false, pricing: { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 } },
  "gpt-4.1": { contextWindow: 1_000_000, maxOutputTokens: 128_000, supportsThinking: false },
  "gpt-4.1-mini": { contextWindow: 1_000_000, maxOutputTokens: 128_000, supportsThinking: false, pricing: { input: 0.4, output: 1.6, cacheRead: 0.1, cacheWrite: 0 } },
  "gpt-4.1-nano": { contextWindow: 1_000_000, maxOutputTokens: 128_000, supportsThinking: false, pricing: { input: 0.1, output: 0.4, cacheRead: 0, cacheWrite: 0 } },
  "gpt-4o": { contextWindow: 128_000, maxOutputTokens: 16_384, pricing: { input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 0 } },
  "gpt-4o-mini": { contextWindow: 128_000, maxOutputTokens: 16_384, pricing: { input: 0.15, output: 0.6, cacheRead: 0.075, cacheWrite: 0 } },

  // ── O-Series ─────────────────────────────────────────────────────
  "o3": { contextWindow: 200_000, maxOutputTokens: 100_000, supportsThinking: true, systemRole: "developer", maxTokensField: "max_completion_tokens", supportsTemperature: false, reasoningEffortValues: ["low", "medium", "high"], protocolKind: "o-series", pricing: { input: 2, output: 8, cacheRead: 0, cacheWrite: 0 } },
  "o3-pro": { contextWindow: 200_000, maxOutputTokens: 100_000, supportsThinking: true, systemRole: "developer", maxTokensField: "max_completion_tokens", supportsTemperature: false, reasoningEffortValues: ["low", "medium", "high"], protocolKind: "o-series", pricing: { input: 20, output: 80, cacheRead: 0, cacheWrite: 0 } },
  "o3-mini": { contextWindow: 200_000, maxOutputTokens: 100_000, supportsThinking: true, systemRole: "developer", maxTokensField: "max_completion_tokens", supportsTemperature: false, reasoningEffortValues: ["low", "medium", "high"], protocolKind: "o-series" },
  "o4-mini": { contextWindow: 200_000, maxOutputTokens: 100_000, supportsThinking: true, systemRole: "developer", maxTokensField: "max_completion_tokens", supportsTemperature: false, reasoningEffortValues: ["low", "medium", "high"], protocolKind: "o-series", pricing: { input: 0.55, output: 2.2, cacheRead: 0, cacheWrite: 0 } },
  "o1": { contextWindow: 200_000, maxOutputTokens: 100_000, supportsThinking: true, systemRole: "developer", maxTokensField: "max_completion_tokens", supportsTemperature: false, reasoningEffortValues: ["low", "medium", "high"], protocolKind: "o-series" },

  // ══════════════════════════════════════════════════════════════════
  // Google Gemini
  // ══════════════════════════════════════════════════════════════════
  "gemini-3.5-flash": { contextWindow: 1_048_576, maxOutputTokens: 65_536, supportsThinking: true, pricing: { input: 1.5, output: 9, cacheRead: 0.15, cacheWrite: 0 } },
  "gemini-3.1-pro-preview": { contextWindow: 1_048_576, maxOutputTokens: 65_536, supportsThinking: true, pricing: { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 0 } },
  "gemini-3.1-flash-lite": { contextWindow: 1_048_576, maxOutputTokens: 65_536, supportsThinking: true, pricing: { input: 0.25, output: 1.5, cacheRead: 0.025, cacheWrite: 0 } },
  "gemini-3.1-flash-preview": { contextWindow: 1_048_576, maxOutputTokens: 65_536, supportsThinking: true, pricing: { input: 0.5, output: 3, cacheRead: 0.05, cacheWrite: 0 } },
  "gemini-3.1-flash-image": { contextWindow: 128_000, maxOutputTokens: 32_000, supportsThinking: false, pricing: { input: 0.5, output: 3, cacheRead: 0.05, cacheWrite: 0 } },
  "gemini-3-flash-preview": { contextWindow: 1_048_576, maxOutputTokens: 65_536, supportsThinking: true, pricing: { input: 0.5, output: 3, cacheRead: 0.05, cacheWrite: 0 } },
  "gemini-2.5-pro": { contextWindow: 1_048_576, maxOutputTokens: 65_536, supportsThinking: true, pricing: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 } },
  "gemini-2.5-flash": { contextWindow: 1_048_576, maxOutputTokens: 65_536, supportsThinking: true, pricing: { input: 0.3, output: 2.5, cacheRead: 0.03, cacheWrite: 0 } },
  "gemini-2.5-flash-lite": { contextWindow: 1_048_576, maxOutputTokens: 65_536, supportsThinking: true, pricing: { input: 0.1, output: 0.4, cacheRead: 0.01, cacheWrite: 0 } },

  // ══════════════════════════════════════════════════════════════════
  // Kimi (Moonshot)
  // ══════════════════════════════════════════════════════════════════
  "kimi-k2.7-code": { contextWindow: 262_144, maxOutputTokens: 32_768, supportsThinking: true, pricing: { input: 0.95, output: 4, cacheRead: 0.19, cacheWrite: 0 } },
  "kimi-k2.7-code-highspeed": { contextWindow: 262_144, maxOutputTokens: 32_768, supportsThinking: true, pricing: { input: 0.95, output: 4, cacheRead: 0.19, cacheWrite: 0 } },
  "kimi-k2.6": { contextWindow: 262_144, maxOutputTokens: 32_768, supportsThinking: true, pricing: { input: 0.95, output: 4, cacheRead: 0.16, cacheWrite: 0 } },
  "kimi-k2.5": { contextWindow: 262_144, maxOutputTokens: 32_768, supportsThinking: true, pricing: { input: 0.6, output: 3, cacheRead: 0.1, cacheWrite: 0 } },
  "moonshot-v1-8k": { contextWindow: 8_192, maxOutputTokens: 4_096, pricing: { input: 0.2, output: 2, cacheRead: 0, cacheWrite: 0 } },
  "moonshot-v1-32k": { contextWindow: 32_768, maxOutputTokens: 16_384, pricing: { input: 1, output: 3, cacheRead: 0, cacheWrite: 0 } },
  "moonshot-v1-128k": { contextWindow: 131_072, maxOutputTokens: 32_768, pricing: { input: 2, output: 5, cacheRead: 0, cacheWrite: 0 } },

  // ══════════════════════════════════════════════════════════════════
  // 通义千问 Qwen
  // ══════════════════════════════════════════════════════════════════
  "qwen3.7-max": { contextWindow: 1_000_000, maxOutputTokens: 65_536, supportsThinking: true, pricing: { input: 1.68, output: 5.04, cacheRead: 0.336, cacheWrite: 0 } },
  "qwen3.7-plus": { contextWindow: 1_000_000, maxOutputTokens: 65_536, supportsThinking: true, pricing: { input: 0.56, output: 1.68, cacheRead: 0.112, cacheWrite: 0 } },
  "qwen3.6-plus": { contextWindow: 1_000_000, maxOutputTokens: 65_536, supportsThinking: true, pricing: { input: 0.56, output: 1.68, cacheRead: 0.112, cacheWrite: 0 } },
  "qwen3.6-flash": { contextWindow: 1_000_000, maxOutputTokens: 65_536, supportsThinking: true, pricing: { input: 0.14, output: 0.28, cacheRead: 0.028, cacheWrite: 0 } },
  "qwen3.5-plus": { contextWindow: 1_000_000, maxOutputTokens: 65_536, supportsThinking: true, pricing: { input: 0.56, output: 1.68, cacheRead: 0.112, cacheWrite: 0 } },
  "qwen3.5-flash": { contextWindow: 1_000_000, maxOutputTokens: 65_536, supportsThinking: true, pricing: { input: 0.14, output: 0.28, cacheRead: 0.028, cacheWrite: 0 } },
  "qwen-plus": { contextWindow: 1_000_000, maxOutputTokens: 65_536, supportsThinking: true, pricing: { input: 0.56, output: 1.68, cacheRead: 0.112, cacheWrite: 0 } },
  "qwen-flash": { contextWindow: 1_000_000, maxOutputTokens: 65_536, supportsThinking: true, pricing: { input: 0.14, output: 0.28, cacheRead: 0.028, cacheWrite: 0 } },
  "qwen3-coder-plus": { contextWindow: 262_144, maxOutputTokens: 65_536, supportsThinking: false, pricing: { input: 0.84, output: 3.36, cacheRead: 0.168, cacheWrite: 0 } },
  "qwen3-coder-flash": { contextWindow: 262_144, maxOutputTokens: 65_536, supportsThinking: false, pricing: { input: 0.21, output: 0.84, cacheRead: 0.042, cacheWrite: 0 } },
  "qwen-vl-plus": { contextWindow: 131_072, maxOutputTokens: 32_768, supportsThinking: true },
  "qwen-long": { contextWindow: 10_000_000, maxOutputTokens: 6_000 },

  // ══════════════════════════════════════════════════════════════════
  // 智谱 GLM
  // ══════════════════════════════════════════════════════════════════
  // 智谱 GLM（OpenAI 兼容端点）。protocolKind=glm-openai：有 thinking 开关；仅 GLM-5.2 支持
  // reasoning_effort（含 max）。tool_choice 仅 auto（openai.ts applyToolChoice 对 glm 降级）。
  // [来源: glm-api.md:144-147,189-201,276]
  "glm-5.2": { contextWindow: 1_000_000, maxOutputTokens: 128_000, supportsThinking: true, protocolKind: "glm-openai", reasoningEffortValues: ["low", "medium", "high", "max"], pricing: { input: 1.4, output: 4.2, cacheRead: 0.7, cacheWrite: 0 } },
  "glm-5.1": { contextWindow: 200_000, maxOutputTokens: 128_000, supportsThinking: true, protocolKind: "glm-openai", pricing: { input: 0.7, output: 2.1, cacheRead: 0.35, cacheWrite: 0 } },
  "glm-5": { contextWindow: 200_000, maxOutputTokens: 128_000, supportsThinking: true, protocolKind: "glm-openai", pricing: { input: 0.7, output: 2.1, cacheRead: 0.35, cacheWrite: 0 } },
  "glm-5-turbo": { contextWindow: 200_000, maxOutputTokens: 128_000, supportsThinking: true, protocolKind: "glm-openai", pricing: { input: 0.42, output: 1.26, cacheRead: 0.21, cacheWrite: 0 } },
  "glm-4.7": { contextWindow: 200_000, maxOutputTokens: 128_000, supportsThinking: true, protocolKind: "glm-openai", pricing: { input: 0.28, output: 0.84, cacheRead: 0.14, cacheWrite: 0 } },
  "glm-4.7-flashx": { contextWindow: 200_000, maxOutputTokens: 128_000, supportsThinking: true, protocolKind: "glm-openai" },
  "glm-4.7-flash": { contextWindow: 200_000, maxOutputTokens: 128_000, supportsThinking: true, protocolKind: "glm-openai", pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
  "glm-4.6": { contextWindow: 200_000, maxOutputTokens: 128_000, supportsThinking: true, protocolKind: "glm-openai" },
  "glm-4.5": { contextWindow: 128_000, maxOutputTokens: 96_000, supportsThinking: true, protocolKind: "glm-openai" },
  "glm-4.5-air": { contextWindow: 128_000, maxOutputTokens: 96_000, supportsThinking: true, protocolKind: "glm-openai" },
  "glm-4.5-flash": { contextWindow: 128_000, maxOutputTokens: 96_000, supportsThinking: true, protocolKind: "glm-openai" },
  "glm-4-flash-250414": { contextWindow: 128_000, maxOutputTokens: 32_000, supportsThinking: false },

  // ══════════════════════════════════════════════════════════════════
  // xAI Grok
  // ══════════════════════════════════════════════════════════════════
  // xAI Grok（OpenAI 兼容端点）。protocolKind=grok-openai：无 thinking 开关；reasoning_effort
  // 无 max（max→high）；推理模型用 max_completion_tokens。[来源: grok-api.md:30,32,157,277,487]
  "grok-4.3": { contextWindow: 1_000_000, maxOutputTokens: 128_000, supportsThinking: true, protocolKind: "grok-openai", maxTokensField: "max_completion_tokens", reasoningEffortValues: ["low", "medium", "high"], pricing: { input: 1.25, output: 2.5, cacheRead: 0.2, cacheWrite: 0 } },
  "grok-build-0.1": { contextWindow: 262_144, maxOutputTokens: 128_000, supportsThinking: true, protocolKind: "grok-openai", maxTokensField: "max_completion_tokens", reasoningEffortValues: ["low", "medium", "high"], pricing: { input: 1, output: 2, cacheRead: 0.2, cacheWrite: 0 } },
  "grok-4.20-0309-reasoning": { contextWindow: 1_000_000, maxOutputTokens: 128_000, supportsThinking: true, protocolKind: "grok-openai", maxTokensField: "max_completion_tokens", reasoningEffortValues: ["low", "medium", "high"], pricing: { input: 1.25, output: 2.5, cacheRead: 0.2, cacheWrite: 0 } },
  "grok-4.20-0309-non-reasoning": { contextWindow: 1_000_000, maxOutputTokens: 128_000, supportsThinking: false, pricing: { input: 1.25, output: 2.5, cacheRead: 0.2, cacheWrite: 0 } },

  // ══════════════════════════════════════════════════════════════════
  // Embedding
  // ══════════════════════════════════════════════════════════════════
  "text-embedding-v4": { contextWindow: 8_192, maxOutputTokens: 0, pricing: { input: 0.02, output: 0, cacheRead: 0, cacheWrite: 0 } },
  "text-embedding-3-small": { contextWindow: 8_191, maxOutputTokens: 0, pricing: { input: 0.02, output: 0, cacheRead: 0, cacheWrite: 0 } },
  "text-embedding-3-large": { contextWindow: 8_191, maxOutputTokens: 0, pricing: { input: 0.13, output: 0, cacheRead: 0, cacheWrite: 0 } },
  "text-embedding-ada-002": { contextWindow: 8_191, maxOutputTokens: 0, pricing: { input: 0.1, output: 0, cacheRead: 0, cacheWrite: 0 } },
};

/**
 * 统一查找引擎。
 * 匹配策略：精确 → 最长前缀 → 剥离路由前缀重试 → 大小写不敏感 → 家族匹配 → null
 */
export function lookupRegistry(model: string): ModelRegistryEntry | null {
  // 1. 精确匹配
  if (REGISTRY[model]) return REGISTRY[model];

  // 2. 最长前缀匹配（覆盖 deepseek-v4-flash-maxthink 等变体）
  let best: ModelRegistryEntry | null = null;
  let bestLen = 0;
  for (const [key, entry] of Object.entries(REGISTRY)) {
    if (model.startsWith(key) && key.length > bestLen) {
      best = entry;
      bestLen = key.length;
    }
  }
  if (best) return best;

  // 3. 剥离路由前缀后重试（如 "kim/kimi-k2.6" → "kimi-k2.6"）
  const slashIdx = model.indexOf("/");
  if (slashIdx !== -1) {
    const bare = model.slice(slashIdx + 1);
    if (REGISTRY[bare]) return REGISTRY[bare];
    for (const [key, entry] of Object.entries(REGISTRY)) {
      if (bare.startsWith(key) && key.length > bestLen) {
        best = entry;
        bestLen = key.length;
      }
    }
    if (best) return best;
  }

  // 4. 大小写不敏感匹配
  const lower = model.toLowerCase();
  for (const [key, entry] of Object.entries(REGISTRY)) {
    if (key.toLowerCase() === lower) return entry;
  }

  // 5. 家族匹配（剥离尾部日期/版本号后精确匹配家族基名）
  // 例如 "claude-sonnet-4-20260101" 的 familyBase = "claude-sonnet-4"
  // 匹配表中 "claude-sonnet-4-20250514" 的 familyBase = "claude-sonnet-4"（精确相等）
  // 但不会误匹配 "claude-sonnet-4-6"（其 familyBase = "claude-sonnet-4-6"，不等）
  const familyBase = (m: string) => m.replace(/-\d{4,}.*$/, "");
  const modelBase = familyBase(model);
  if (modelBase.length > 0 && modelBase !== model) {
    // 仅当 familyBase 确实剥离了尾部时才做家族匹配
    bestLen = 0;
    for (const [key, entry] of Object.entries(REGISTRY)) {
      const keyBase = familyBase(key);
      if (keyBase === modelBase && keyBase.length > bestLen) {
        best = entry;
        bestLen = keyBase.length;
      }
    }
  }
  return best;
}

/** 获取完整注册表（只读用途，如 /model discover 展示） */
export function getRegistryEntries(): ReadonlyArray<[string, ModelRegistryEntry]> {
  return Object.entries(REGISTRY);
}
