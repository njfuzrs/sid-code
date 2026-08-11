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
  protocolKind?: "deepseek-openai" | "deepseek-anthropic" | "anthropic-native" | "o-series" | "glm-openai" | "grok-openai" | "openai-responses" | "unknown";

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

  /**
   * 推理语言漂移倾向：该模型的思考过程（reasoning/thinking）在中文语境下
   * 容易自发漂移到英文，需要更强的语言约束措辞（system-prompt.ts 的「铁律级」
   * 身份指令 + `<internal_en>` 疏导）才能稳定输出中文。
   *
   * 背景（必删-4 根治）：此前 system-prompt.ts 用 `model.includes("deepseek")`
   * 字符串匹配决定走哪套措辞——违反"不按模型名硬编码分档"原则（见 memory
   * `feedback-no-hardcoded-model-tier-rules.md`），模型改名/新版/同类新模型都会漂移。
   * 改为能力标志后，是否需要强约束由注册表数据驱动，新增同类模型只需在此声明。
   *
   * - DeepSeek V4 系（思考模型，中文语境下 reasoning 明显英文漂移）：`true`
   * - 其它模型：缺省 undefined（= false，走标准语言措辞）
   */
  reasoningLanguageDrift?: boolean;

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
  "deepseek-v4-pro": { contextWindow: 1_000_000, maxOutputTokens: 384_000, supportsThinking: true, requiresReasoningContentForToolCalls: true, reasoningLanguageDrift: true, pricing: { input: 0.435, output: 0.87, cacheRead: 0.0036, cacheWrite: 0 } },
  "deepseek-v4-flash": { contextWindow: 1_000_000, maxOutputTokens: 384_000, supportsThinking: true, requiresReasoningContentForToolCalls: true, reasoningLanguageDrift: true, pricing: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 } },
  "DeepSeek-V4-Flash": { contextWindow: 1_000_000, maxOutputTokens: 384_000, supportsThinking: true, requiresReasoningContentForToolCalls: true, reasoningLanguageDrift: true, pricing: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 } },
  "DeepSeek-V4-Pro": { contextWindow: 1_000_000, maxOutputTokens: 384_000, supportsThinking: true, requiresReasoningContentForToolCalls: true, reasoningLanguageDrift: true, pricing: { input: 0.435, output: 0.87, cacheRead: 0.0036, cacheWrite: 0 } },
  "deepseek-chat": { contextWindow: 1_000_000, maxOutputTokens: 384_000, supportsThinking: false, pricing: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 } },
  // 旧 deepseek-reasoner（R1 系）：输入携带 reasoning_content 会触发旧协议 400，保持不回传（缺省 false）。
  "deepseek-reasoner": { contextWindow: 1_000_000, maxOutputTokens: 384_000, supportsThinking: true, requiresReasoningContentForToolCalls: false, reasoningLanguageDrift: true, pricing: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 } },

  // ══════════════════════════════════════════════════════════════════
  // OpenAI / GPT
  // ══════════════════════════════════════════════════════════════════
  // GPT-5.6 族（2026-07-09 GA，三档：luna 轻量 / terra 均衡 / sol 旗舰）。
  // 三者 contextWindow、maxOutputTokens、能力位完全一致，只有价格与推理质量不同。
  // `gpt-5.6` 裸名是别名，官方路由到 sol。
  //
  // ⚠ contextWindow=1_050_000 但官方另有 **max input 922_000** 的独立限制——超过即返回
  // "input exceeds the context window"（实测 900k 过、990k 拒）。sid-code 目前无「输入上限」
  // 字段来表达这个差异，故此处如实填窗口值；真正的输入裁剪由 auto-compact 的完成缓冲区兜底。
  // [官方: developers.openai.com/api/docs/models/gpt-5.6-sol；实测: 自建网关夹逼]
  //
  // pricing 为**官方标准价**（USD/1M）。网关渠道价（luna 实采 0.17/1.02）由 gateway-pricing.ts
  // 按渠道名精确命中并优先于此——此处仅作渠道 miss 时的兜底，勿用渠道价覆盖。
  // 注：官方对 >272K 输入的请求按 2x input / 1.5x output 计价，本表不表达该分层。
  "gpt-5.6": { contextWindow: 1_050_000, maxOutputTokens: 128_000, supportsThinking: false, protocolKind: "openai-responses", pricing: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 } },
  "gpt-5.6-sol": { contextWindow: 1_050_000, maxOutputTokens: 128_000, supportsThinking: false, protocolKind: "openai-responses", pricing: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 } },
  "gpt-5.6-terra": { contextWindow: 1_050_000, maxOutputTokens: 128_000, supportsThinking: false, protocolKind: "openai-responses", pricing: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 3.125 } },
  "gpt-5.6-luna": { contextWindow: 1_050_000, maxOutputTokens: 128_000, supportsThinking: false, protocolKind: "openai-responses", pricing: { input: 1, output: 6, cacheRead: 0.1, cacheWrite: 1.25 } },
  "gpt-5.5": { contextWindow: 1_050_000, maxOutputTokens: 128_000, supportsThinking: false, protocolKind: "openai-responses", pricing: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 } },
  "gpt-5.5-pro": { contextWindow: 1_000_000, maxOutputTokens: 128_000, supportsThinking: false, protocolKind: "openai-responses", pricing: { input: 30, output: 180, cacheRead: 0, cacheWrite: 0 } },
  "gpt-5.4": { contextWindow: 1_050_000, maxOutputTokens: 128_000, supportsThinking: false, protocolKind: "openai-responses", pricing: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 } },
  "gpt-5.4-mini": { contextWindow: 400_000, maxOutputTokens: 128_000, supportsThinking: false, protocolKind: "openai-responses", pricing: { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0 } },
  "gpt-5.4-nano": { contextWindow: 400_000, maxOutputTokens: 128_000, supportsThinking: false, protocolKind: "openai-responses", pricing: { input: 0.2, output: 1.25, cacheRead: 0.02, cacheWrite: 0 } },
  "gpt-5.4-pro": { contextWindow: 1_000_000, maxOutputTokens: 128_000, supportsThinking: false, protocolKind: "openai-responses", pricing: { input: 30, output: 180, cacheRead: 0, cacheWrite: 0 } },
  "gpt-5.2": { contextWindow: 1_000_000, maxOutputTokens: 128_000, supportsThinking: false, protocolKind: "openai-responses", pricing: { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 } },
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
 * 已知供应商路由前缀白名单（连字符式，非 "/" 分隔）。
 *
 * 网关/聚合服务常给同一底层模型加供应商前缀（阿里百炼 `ali-`、火山方舟 `volc-` /
 * `volcengine-`、硅基流动 `siliconflow-`、腾讯 `hunyuan-`/`tencent-` 等）。这些前缀不在
 * 注册表 key 中，导致定价/参数匹配全部落空。此处**显式白名单**精确剥离，绝不按通用
 * "-" 拆分——否则会误伤 `claude-`、`gpt-`、`glm-`、`grok-` 等本就以连字符构成的正规名。
 *
 * 新增网关前缀时在此追加即可（保持全小写，含末尾连字符）。
 */
const ROUTE_PREFIXES = [
  "ali-",
  "aliyun-",
  "bailian-",
  "dashscope-",
  "volc-",
  "volcengine-",
  "siliconflow-",
  "hunyuan-",
  "tencent-",
] as const;

/**
 * 统一查找引擎。
 * 匹配策略：精确 → 最长前缀 → 剥离 "/" 路由前缀 → 剥离供应商连字符前缀 → 大小写不敏感 → 家族匹配 → null
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

  // 3.5 剥离已知供应商路由前缀后重试（如 "ali-deepseek-v4-pro" → "deepseek-v4-pro"）
  // 某些网关/聚合服务给模型名加连字符供应商前缀（阿里百炼 ali-、火山 volc- 等），
  // 这些前缀不在注册表 key 里 → 前缀匹配(startsWith)与家族匹配全部 miss → 费用误落
  // FALLBACK 高估数倍，且 calculateSavings 遇 pricing=null 直接返回 0（"省钱恒 $0"）。
  // 用白名单精确剥离，绝不盲目按 "-" 拆分（否则会误伤 claude-/gpt-/glm- 等本就以连字符
  // 构成的正规模型名）。剥离后递归复用完整匹配策略；bare 每次严格变短，必然终止。
  //
  // ⚠ 定位：前缀剥离已降为**最后兜底**。渠道精确价由 gateway-pricing.ts 提供，
  // resolvePricing 的网关查询（步骤 3）先于本函数（步骤 4）——网关采到 "ali-deepseek-v4-pro"
  // 的渠道精确价即命中返回，根本走不到这里的剥离。仅当网关缓存 + 用户配置都 miss（缓存过期/
  // 冷门渠道名）时，才靠剥离退到官方价，聊胜于 FALLBACK。剥离**会抹平渠道差价**（把 ali-/tx-
  // 都套成官方价），是「查无此模型」的下策兜底，不是精确计费路径。
  for (const prefix of ROUTE_PREFIXES) {
    if (model.startsWith(prefix) && model.length > prefix.length) {
      const hit = lookupRegistry(model.slice(prefix.length));
      if (hit) return hit;
    }
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
