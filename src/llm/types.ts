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

/**
 * G6：工具结果的富媒体块（图片 / PDF 文档）。
 *
 * 设计为**附加字段**而非改 content 类型：content 仍是 string（UI 渲染、大输出压缩、
 * 磁盘存储全部沿用文本摘要不变），mediaBlocks 独立携带 base64 媒体，仅支持 vision 的
 * provider（当前 Anthropic）在序列化 tool_result 时读取并拼成多部件 content。
 * 不支持 vision 的 provider 忽略此字段、只发 content 文本（优雅降级）。
 */
export interface ToolResultMediaBlock {
  /** image = 图片（base64），document = PDF 等文档（base64） */
  kind: "image" | "document";
  /** MIME 媒体类型，如 image/png、application/pdf */
  mediaType: string;
  /** base64 编码的原始数据（不含 data: 前缀） */
  data: string;
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
  /**
   * G6：富媒体块（图片/PDF）。仅 Read 工具读图片/PDF 时填充。
   * 支持 vision 的 provider 序列化时把它拼进 tool_result 的多部件 content；
   * 其余 provider 忽略。不进磁盘压缩（压缩只替换 content 文本）。
   */
  mediaBlocks?: ToolResultMediaBlock[];
}

/** 思考块（对标 Claude Code ThinkingBlock） */
export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
  signature?: string;  // Anthropic 签名（多轮回传必需，丢失/修改 → 400）
  /**
   * SP1：思考耗时（毫秒）。流式期间由 stream-processor 测量（从该块首个
   * delta 到 content_block_stop），用于历史项稳定显示「已思考 Ns」而非
   * 重渲时回退为无耗时文案。仅 UI 呈现用，不回传给 LLM。
   */
  durationMs?: number;
}

/**
 * 被编辑的思考块（Anthropic 安全审查触发时返回）。
 * 多轮对话中**必须原样回传**，否则静默破坏推理链。
 * [来源: anthropic-api.md:166,356-357]
 */
export interface RedactedThinkingBlock {
  type: "redacted_thinking";
  data: string;
}

/** 内容块类型 */
export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock | ThinkingBlock | RedactedThinkingBlock;

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
  /**
   * 推理 / 思考 token 数（缺口分析二类：thinking 模型的隐藏成本，需单独计）。
   * - **OpenAI 族**：取自 `completion_tokens_details.reasoning_tokens`，是 outputTokens 的**子集**
   *   （completion_tokens 已含 reasoning），单独暴露供成本拆解，勿再加进 outputTokens。
   * - **Anthropic**：无独立 reasoning 计数（thinking 已计入 output_tokens），恒 undefined；
   *   是否有思考靠 thinking_blocks / has_thinking 区分。
   * 不产生时保持 undefined（不落一个误导的 0）。
   */
  reasoningTokens?: number;
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
  // 缺口分析二类：reasoning token 随 usage 事件透传。仅在显式提供时累加，避免 undefined→0 污染
  //（与 cache 字段同口径）。OpenAI 族在最终 usage chunk 给累计值，累加等价于取末值。
  if (eventUsage.reasoningTokens != null) {
    target.reasoningTokens =
      (target.reasoningTokens ?? 0) + eventUsage.reasoningTokens;
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
  | { type: "message_delta"; delta: { stop_reason: string | null }; usage: Usage; _rawOutputTokensZero?: boolean }
  | { type: "message_stop" }
  | { type: "error"; error: { message: string; type?: string; statusCode?: number; streamLevel?: boolean } }
  | { type: "system_api_error"; content: string; delayMs: number; attempt: number; maxRetries: number; category: string };

/** 工具定义 */
export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  /** 是否启用 Constrained Decoding（模型保证 100% JSON 合规）。
   *  仅 Anthropic Claude 4.x + firstParty 连接时生效。
   *  MCP 工具 / 动态 schema 工具（StructuredOutput）不标记。 */
  strict?: boolean;
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
   * 输出配置（Anthropic `output_config`）。
   * - **DeepSeek-via-Anthropic 端点**：仅 `effort` 被支持（budget_tokens 被忽略）。
   * - **原生 Claude adaptive 模型（Opus 4.7+/Sonnet 4.6/Fable 5）**：`effort` 控制思考深度，
   *   `thinkingType: "adaptive"` 指示 anthropic.ts 下发 `thinking:{type:"adaptive"}`。
   * - **原生 Claude manual 模型（旧）**：不读此字段（强度走 thinking.budgetTokens）。
   * 不传则不下发。
   */
  outputConfig?: {
    effort: "low" | "medium" | "high" | "max";
    /** 区分 adaptive（Opus 4.7+）和 enabled（旧 manual 模型）两种 thinking 下发模式 */
    thinkingType?: "adaptive" | "enabled";
  };
  /**
   * Anthropic output_config.format — API 级结构化输出（非工具调用方式）。
   * 允许整个响应强制为 JSON（类似 OpenAI 的 response_format）。
   * 仅 Anthropic firstParty + Claude 4.x 支持。不传则不下发。
   */
  outputFormat?: {
    type: "json_schema";
    json_schema: {
      name: string;
      schema: Record<string, unknown>;
      strict?: boolean;
    };
  };
  /**
   * G2：cache_edits 删除指令（Anthropic 私有字段）。
   * cachedMicrocompact 走缓存友好路径时产出的"服务器侧删除旧工具结果"指令，
   * 由 anthropic.ts 在 provider.name()==="anthropic" 时携带到请求体顶层 `cache_edits`。
   * 其它 provider 完全忽略（不下发）。不传则不下发。
   */
  cacheEdits?: { type: "delete"; tool_use_id: string }[];
  /**
   * 流内诊断遥测回调（由 fallback.ts 注入，provider 在 stream-guard 包装时转发）。
   * 让 stream_stall / stream_idle_timeout / stream_completed 等流内信号能进入
   * 统一的 RetryTelemetry 通道（events.jsonl），被 trace-digest.ts 消费。
   * provider 不直接依赖 RetryTelemetry，只产出与协议无关的 {@link StreamTelemetrySignal}。
   */
  onStreamTelemetry?: (signal: StreamTelemetrySignal) => void;
}

/**
 * 流内诊断遥测信号 — provider 层与遥测系统之间的协议无关契约。
 *
 * 单一事实源：stream-guard.ts 产出此类型，anthropic.ts 转发，fallback.ts 转成
 * RetryTelemetryEvent。任何 provider 都可复用，不耦合具体遥测实现。
 */
export type StreamTelemetrySignal =
  | { type: "stream_stall"; provider: string; gapMs: number; totalEvents: number }
  | { type: "stream_idle_timeout"; provider: string; timeoutMs: number; totalEvents: number }
  // T2：业务内容进展超时。区别于 idle_timeout（任何数据包间隔，含 ping keep-alive）：
  // content_progress_timeout 只在"有意义的业务内容"（content_block_delta / message_delta）
  // 长时间未到达时触发——即便 ping 还在续命 idle timer，也能识破"只有 keep-alive、无真内容"。
  | { type: "stream_content_progress_timeout"; provider: string; timeoutMs: number; totalEvents: number }
  // T7：请求级整体超时。从流开始到现在超过硬上限（不因任何事件重置），对齐官方 SDK 的
  // request-level timeout。区别于 idle/content_progress（都会在事件到达时重置）：overall 是
  // 绝对上限，防"持续吐 keep-alive 或缓慢有效内容但永不结束"的流无限占用一次请求配额。
  | { type: "stream_overall_timeout"; provider: string; timeoutMs: number; totalEvents: number }
  | { type: "stream_completed"; provider: string; totalEvents: number; elapsedMs: number; ttftMs?: number };

/** 累积的流式响应 */
export interface AccumulatedResponse {
  role: "assistant";
  content: ContentBlock[];
  stopReason: string | null;
  usage: Usage;
  _meta?: Record<string, unknown>;
  /**
   * 方案①/②（deepseek-reasoning-leak 修复）：本轮以 end_turn 收尾，但没有面向用户的
   * 有效答复（思考漂移进 content 当正文 / 只思考不答复 / usage 原始为 0）。
   * 由 stream-processor 判定并置位，loop.ts 据此回注收敛提示 + 软续命（驱动重试而非假性结束）。
   * 注意：此字段**不进** _meta，不持久化到历史，仅供本轮 loop 决策。
   */
  _unansweredEndTurn?: boolean;
}
