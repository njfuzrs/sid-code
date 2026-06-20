/**
 * LLM 核心类型定义
 * 统一不同 Provider 的消息格式和流式事件
 */

import type { StructuredPatchHunk } from "diff";

/** 消息角色 */
export type Role = "user" | "assistant";

/** 文本内容块 */
export interface TextBlock {
  type: "text";
  text: string;
}

/** 工具调用块 */
export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

/** 工具结果块 */
export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
  /**
   * 结构化 diff(仅 edit/write 工具填充)。独立于 content 文本,供 UI 直接渲染,
   * 绕过对 content 的正则解析。
   * - 不回传给 LLM:provider 序列化 tool_result 时逐字段读取 content/is_error,不含此字段。
   * - 不受大输出压缩影响:context/manager.ts 的增量压缩只替换 content 为磁盘引用,
   *   保留其余字段,故大文件 diff 在 UI 仍可完整高亮。
   */
  structuredPatch?: StructuredPatchHunk[];
}

/** 思考块（对标 Claude Code ThinkingBlock） */
export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
  signature?: string;  // Anthropic 签名（保留用于回传验证）
  /**
   * SP1：思考耗时（毫秒）。流式期间由 stream-processor 测量（从该块首个
   * delta 到 content_block_stop），用于历史项稳定显示「已思考 Ns」而非
   * 重渲时回退为无耗时文案。仅 UI 呈现用，不回传给 LLM。
   */
  durationMs?: number;
}

/** 内容块类型 */
export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock | ThinkingBlock;

/** 消息 */
export interface Message {
  role: Role;
  content: ContentBlock[];
  _meta?: Record<string, unknown>;
}

/** Token 用量统计
 *
 * ⚠️ inputTokens 的口径**因 provider 而异**（全方案最关键的约定）：
 * - **Anthropic**：inputTokens = `input_tokens` = **未命中余量**，本就不含命中/写入。
 * - **OpenAI/DeepSeek**：inputTokens = `prompt_tokens` = **含命中的全量** prompt。
 * 因此任何"命中率/省钱/计费"计算都必须先经 {@link normalizeCacheUsage} 归一化为
 * 与厂商无关的互斥三段（hit / write / uncached），杜绝口径分裂。
 */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
}

/**
 * 归一化缓存用量视图（与厂商无关的互斥三段）。
 *
 * 三段互斥：promptTotal = cacheHitTokens + cacheWriteTokens + uncachedInputTokens。
 * Footer、会话摘要、长期账本、计费**全部**走 {@link normalizeCacheUsage} 派生此视图，
 * 是缓存命中率/省钱/计费的**单一事实源**。
 */
export interface NormalizedCacheUsage {
  /** 命中（读缓存）token 数 */
  cacheHitTokens: number;
  /** 写入缓存 token 数（DeepSeek 恒 0，仅 Anthropic 有） */
  cacheWriteTokens: number;
  /** 既非命中也非写入的全价输入 token 数 */
  uncachedInputTokens: number;
  /** 输出 token 数 */
  outputTokens: number;
  /** 完整输入 = hit + write + uncached（派生，可断言校验） */
  promptTotal: number;
}

/**
 * 把 provider 原始 {@link Usage} 归一化为厂商无关的互斥三段（方案 §2.2）。
 *
 * 映射规则（依据 Usage.inputTokens 的 provider 口径差异）：
 * - **Anthropic**：`inputTokens` 已是未命中余量 →
 *     uncached = inputTokens；promptTotal = inputTokens + hit + write。
 * - **OpenAI/DeepSeek**：`inputTokens = prompt_tokens` 含命中 →
 *     uncached = inputTokens − hit（DeepSeek 写入恒 0）；promptTotal = inputTokens。
 * - **其它（ollama 等无缓存）**：hit/write 恒 0，三段退化为 uncached = inputTokens。
 *
 * @param usage provider 解析后的原始用量
 * @param provider provider 名称（来自 Provider.name()："anthropic" / "openai" / "ollama" / ...）
 */
export function normalizeCacheUsage(
  usage: Usage,
  provider: string,
): NormalizedCacheUsage {
  const hit = usage.cacheReadInputTokens ?? 0;
  const write = usage.cacheCreationInputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  const input = usage.inputTokens ?? 0;

  if (provider === "anthropic") {
    // Anthropic：input_tokens 本就是未命中余量，勿再减
    const uncached = Math.max(0, input);
    return {
      cacheHitTokens: hit,
      cacheWriteTokens: write,
      uncachedInputTokens: uncached,
      outputTokens: output,
      promptTotal: uncached + hit + write,
    };
  }

  // OpenAI / DeepSeek / 其它兼容端点：inputTokens = prompt_tokens 含命中
  // uncached = prompt_tokens − hit；写入概念在 DeepSeek 不存在（write 恒 0）
  const uncached = Math.max(0, input - hit - write);
  return {
    cacheHitTokens: hit,
    cacheWriteTokens: write,
    uncachedInputTokens: uncached,
    outputTokens: output,
    // promptTotal 直接取 input（prompt_tokens 本就是完整输入），
    // 与 uncached+hit+write 在 hit/write 不超过 input 时一致。
    promptTotal: input,
  };
}

/**
 * 把一次流式事件携带的 usage 累加进目标 usage（方案主题 A：单一权威累加实现）。
 *
 * 四套 processStream（query / headless / agent / agentic-loop）此前各自拷贝同一段
 * "累加 usage" 逻辑，导致缓存字段、inputTokens 在不同路径丢弃口径不一致
 * （子代理路径甚至只加 output、丢 input 与全部缓存字段）。统一改调此函数消灭拷贝。
 *
 * 累加口径（与 message_start / message_delta 两类事件对齐）：
 * - inputTokens：累加。Provider 已保证 message_start 给全量、message_delta 给 0 或增量，
 *   两类相加得到本次调用的输入口径（Anthropic=未命中余量 / OpenAI=prompt_tokens）。
 * - outputTokens：累加（输出 token 随 delta 增长）。
 * - cacheReadInputTokens / cacheCreationInputTokens：累加，且仅在事件显式提供（!= null）时累加，
 *   避免把 undefined 当 0 污染——这正是子代理路径"命中省钱失真"的根因。
 *
 * @param target 累加目标（原地修改并返回）
 * @param eventUsage 单次流式事件的 usage（message_start.message.usage 或 message_delta.usage）
 */
export function accumulateUsage(target: Usage, eventUsage: Usage | undefined): Usage {
  if (!eventUsage) return target;
  target.inputTokens += eventUsage.inputTokens ?? 0;
  target.outputTokens += eventUsage.outputTokens ?? 0;
  if (eventUsage.cacheReadInputTokens != null) {
    target.cacheReadInputTokens =
      (target.cacheReadInputTokens ?? 0) + eventUsage.cacheReadInputTokens;
  }
  if (eventUsage.cacheCreationInputTokens != null) {
    target.cacheCreationInputTokens =
      (target.cacheCreationInputTokens ?? 0) + eventUsage.cacheCreationInputTokens;
  }
  return target;
}

/** 文本增量 */
export interface TextDelta {
  type: "text_delta";
  text: string;
}

/** 工具输入 JSON 增量 */
export interface InputJsonDelta {
  type: "input_json_delta";
  partial_json: string;
}

/** 流式事件类型 */
export type StreamEvent =
  | { type: "message_start"; message: { usage: Usage } }
  | { type: "content_block_start"; index: number; content_block: ContentBlock; _raw_block?: unknown }
  | { type: "content_block_delta"; index: number; delta: TextDelta | InputJsonDelta }
  | { type: "content_block_stop"; index: number }
  | { type: "message_delta"; delta: { stop_reason: string | null }; usage: Usage }
  | { type: "message_stop" }
  | { type: "error"; error: { message: string } }
  | { type: "system_api_error"; content: string; delayMs: number; attempt: number; maxRetries: number; category: string };

/** 工具定义 */
export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/** 发送消息参数 */
export interface SendParams {
  model: string;
  messages: Message[];
  system?: string;
  maxTokens: number;
  tools?: ToolDefinition[];
  /**
   * 工具调用策略（§4.2）。透传给支持的 provider（OpenAI 兼容）：
   *   - "auto"：模型自行决定是否调用工具（服务端默认）
   *   - "none"：禁止调用工具
   *   - "required"：强制至少调用一个工具
   *   - { name }：强制调用指定工具
   * 不传则不下发该字段，沿用服务端默认。
   */
  toolChoice?: "auto" | "none" | "required" | { name: string };
  /**
   * 是否允许并行工具调用（§4.2）。仅在 provider capabilities.parallelToolCalls 为 true 时有意义。
   * 不传则不下发该字段，沿用服务端默认（通常为 true）。
   */
  parallelToolCalls?: boolean;
  /**
   * Extended Thinking 配置。
   * - **Anthropic**：`budgetTokens` 作为 `thinking.budget_tokens` 下发，控制思考预算。
   * - **DeepSeek（OpenAI 兼容端点）**：仅用 `enabled` 映射为请求体顶层
   *   `thinking: { type: "enabled" | "disabled" }`；`budgetTokens` 在 DeepSeek 无对应字段，
   *   思考强度改由 {@link reasoningEffort} 控制。DeepSeek 默认 thinking 为 enabled，
   *   传 `enabled: false` 可显式关闭。
   */
  thinking?: {
    enabled: boolean;
    budgetTokens: number;  // 思考预算 token 数（仅 Anthropic 生效）
  };
  /**
   * 推理强度（思考模式专用，OpenAI 兼容端点请求体顶层 `reasoning_effort`）。
   * - **DeepSeek**：仅接受 "high" | "max"（low/medium 会被服务端映射为 high，xhigh 映射为 max）。
   * - **OpenAI o-series**：接受 "low" | "medium" | "high"（无 max，max 由映射层降为 high）。
   * 不传则不下发该字段，沿用服务端默认（DeepSeek 普通请求 high，Claude Code 类 Agent 请求 max）。
   * Anthropic provider 忽略此字段（其思考强度走 thinking.budgetTokens）。
   */
  reasoningEffort?: "low" | "medium" | "high" | "max";
  /**
   * 用户标识（DeepSeek `user_id`，OpenAI 兼容端点请求体顶层字段）。
   * 用于 KVCache 隔离 / 调度隔离 / 内容安全隔离。须满足正则 `[a-zA-Z0-9\-*]+`、长度 ≤512。
   * 不传则不下发。其它 provider 忽略。
   */
  userId?: string;
  /**
   * 输出配置（Anthropic 兼容端点 `output_config`）。
   * - **DeepSeek-via-Anthropic 端点**：仅 `effort` 被支持（budget_tokens 被忽略），
   *   强度走 `output_config.effort`（high/max）。由 anthropic.ts 下发。
   * 原生 Claude 不读此字段（其强度走 thinking.budget_tokens）；OpenAI 端点忽略。
   * 不传则不下发。
   */
  outputConfig?: {
    effort: "high" | "max";
  };
}

/** 累积的流式响应 */
export interface AccumulatedResponse {
  role: "assistant";
  content: ContentBlock[];
  stopReason: string | null;
  usage: Usage;
  _meta?: Record<string, unknown>;
}
