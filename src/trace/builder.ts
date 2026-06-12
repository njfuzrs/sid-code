/**
 * 轨迹构建器
 * 将采集器累积的 RequestResponsePair[] 转换为与 claude-trace builder.py
 * 完全相同格式的 .traj JSON 结构。
 *
 * 输出格式：
 * {
 *   "trajectory": [...],  // TAO 步骤列表（用于 SWE-bench 评测）
 *   "history": [...],     // 完整对话历史（用于 SFT 训练）
 *   "info": {...},        // 会话统计信息
 *   "metadata": {...}     // 扩展元数据
 * }
 */

import { createHash } from "node:crypto";

// ─── 数据结构定义 ───

/** 单次 LLM 请求/响应对 */
export interface RequestResponsePair {
  timestamp: string;
  index: number;
  model: string;
  request: {
    model: string;
    system?: unknown;
    messages?: unknown[];
    tools?: unknown[];
    new_messages?: unknown[];
    _messages_count?: number;
    /** 原始完整 messages（仅内存使用，不写入 raw.jsonl，供 findToolResult 搜索） */
    raw_messages?: unknown[];
  };
  response: {
    content: unknown[];
    stop_reason: string;
    usage: {
      input_tokens: number;
      output_tokens: number;
      cache_read_input_tokens: number;
      cache_creation_input_tokens: number;
    };
  };
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
  };
  stop_reason: string;
  is_partial: boolean;
  /** thinking blocks（从 AfterModel hook 的 _thinkingBlocks 获取） */
  thinking_blocks?: Array<{ type: "thinking"; thinking: string }>;

  // ── Harness 扩展（可选，Harness Phase 0+ 时填充） ──
  harness_turn_context?: HarnessTurnContext;
}

/** Harness 每轮上下文——记录在每个 RequestResponsePair 中 */
export interface HarnessTurnContext {
  /** 本轮暴露给模型的工具列表 */
  tool_subset?: string[];
  /** 本轮上下文动作（trim/summarize/expire） */
  context_actions?: Array<{ action: string; reason: string }>;
  /** 本轮验证结果 */
  verify_results?: Array<{
    command: string;
    passed: boolean;
    duration_ms: number;
    summary?: string;
  }>;
  /** 本轮编辑协议 */
  edit_protocol?: string;
  /** 本轮运行时模式 */
  runtime_mode?: string;
  /** 通用扩展 */
  extra?: Record<string, unknown>;
}

/** Harness 会话级轨迹元数据 */
export interface HarnessTraceMetadata {
  /** Phase 0: 任务画像 */
  task_profile?: {
    task_type?: string;
    risk_level?: string;
    estimated_files?: number;
    needs_verification?: boolean;
    preferred_edit_protocol?: string;
    preferred_verify_depth?: string;
    preferred_runtime?: string;
  };
  /** Phase 1: 编辑统计 */
  edit_stats?: {
    total_edits: number;
    first_pass_success: number;
    retry_count: number;
    protocols_used: Record<string, number>;
  };
  /** Phase 1: 验证统计 */
  verify_stats?: {
    total_runs: number;
    pass_count: number;
    auto_repair_success: number;
    commands_used: string[];
  };
  /** Phase 2: 上下文统计 */
  context_stats?: {
    trimmed_tokens: number;
    expired_items: number;
    tool_subset_sizes: number[];
    compression_actions: number;
  };
  /** Phase 3: 运行时 */
  runtime_mode?: string;
  worktree_id?: string;
  /** Phase 4: 候选并行 */
  candidate_stats?: {
    spawned: number;
    selected: number;
    selector_reason?: string;
  };
}

/** 会话元数据 */
export interface TraceMetadata {
  session_id: string;
  model: string;
  start_time: string;
  end_time?: string;
  working_directory: string;
  permission_mode?: string;
  system_prompt?: string;
  system_prompt_hash?: string;
  tools_used: Set<string>;
  files_edited: Set<string>;
  user_prompts: string[];
  compactions: Array<{ trigger: string; timestamp: string }>;
  subagent_spans: Array<{ agent_id: string; agent_type: string; start: string; end?: string }>;
  has_thinking: boolean;
  has_sub_agent: boolean;
  total_tokens_sent: number;
  total_tokens_received: number;
  /**
   * DISP-1：累计输入 prompt token（flow 口径，逐次累加）。
   * total_tokens_sent 是末次值（stock，含全历史），与逐次累加的 total_cost_usd 口径不可比；
   * 此字段与 cost 同为 flow，用于"花了多少钱 ↔ 累计喂了多少 token"的可比对照。
   */
  total_cumulative_prompt_tokens: number;
  total_cache_read_tokens: number;
  total_cache_creation_tokens: number;
  total_cost_usd: number;
  total_api_calls: number;
  exit_status?: string;
  start_source?: string;
  end_source?: string;
  /** 错误退出时的简要错误信息（reason="error"） */
  error?: { message: string; name?: string };
  /** D3-3：异常退出自动归因摘要（abnormal 时填充，免去人工翻日志） */
  exit_attribution?: {
    abnormal: boolean;
    summary: string;
    reason: string;
    exit_status: string;
    api_calls: number;
    last_tool: string | null;
    has_orphan_tool_use: boolean;
    error_name?: string;
  };

  // ── Harness 扩展（可选，当前不填） ──
  harness?: HarnessTraceMetadata;
}

// ─── 输出类型 ───

/** TAO action 步骤（tool_use 或 final_answer） */
export interface ActionStep {
  message_type: "action";
  role: "assistant";
  content: string;
  thought: string;
  action: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_use_id?: string;
  agent: "primary";
  timestamp: string;
}

/** TAO observation 步骤（tool_result） */
export interface ObservationStep {
  message_type: "observation";
  role: "user";
  content: string;
  tool_use_id?: string;
  is_error: boolean;
  agent: "primary";
  _orphan?: true;
}

export type TrajectoryStep = ActionStep | ObservationStep;

/** history 中的 assistant 消息 */
export interface AssistantHistoryEntry {
  role: "assistant";
  content: unknown[];
  message_type: "action" | "thought";
  agent: "primary";
  thought: string;
  thinking_blocks: unknown[] | null;
  tool_calls: Array<{ function: { name: string; arguments: string } }>;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
  };
  stop_reason: string;
  timestamp: string;
}

/** history 中的 user 消息 */
export interface UserHistoryEntry {
  role: "user";
  content: unknown;
  agent: "primary";
  message_type?: "observation";
  tool_call_ids?: string[];
}

/** history 中的 system 消息 */
export interface SystemHistoryEntry {
  role: "system";
  content: string;
  agent: "primary";
}

export type HistoryEntry = SystemHistoryEntry | UserHistoryEntry | AssistantHistoryEntry;

/** info 字段 */
export interface TrajectoryInfo {
  model_stats: {
    tokens_sent: number;
    tokens_received: number;
    cache_read_tokens: number;
    cache_creation_tokens: number;
    api_calls: number;
    total_cost_usd: number;
  };
  exit_status: string;
  has_thinking: boolean;
}

/** metadata 字段 */
export interface TrajectoryMetaOutput {
  session_id: string;
  model: string;
  start_time: string;
  end_time: string;
  total_steps: number;
  total_api_calls: number;
  total_tokens_sent: number;
  total_tokens_received: number;
  total_cache_read_tokens: number;
  total_cache_creation_tokens: number;
  total_tokens: number;
  total_cost_usd: number;
  exit_status: string;
  tools_used: string[];
  files_edited: string[];
  working_directory: string;
  has_thinking: boolean;
  has_sub_agent: boolean;
  user_prompts: string[];
  compactions: Array<{ trigger: string; timestamp: string }>;
  subagent_spans: Array<{ agent_id: string; agent_type: string; start: string; end?: string }>;
  tool_source: "sid-code";
  start_source?: string;
  end_source?: string;
  claude_md_hash?: string;
  /** 错误退出时的简要错误信息（reason="error"） */
  error?: { message: string; name?: string };

  // ── Harness 扩展 ──
  harness?: HarnessTraceMetadata;
}

/** .traj 文件的完整结构 */
export interface TrajectoryFile {
  trajectory: TrajectoryStep[];
  history: HistoryEntry[];
  info: TrajectoryInfo;
  metadata: TrajectoryMetaOutput;
}

// ─── 辅助函数 ───

/**
 * 从 content block 中提取 thinking + text 的合并文本
 * thinking 优先，text 补充
 */
function extractThought(
  contentBlocks: unknown[],
  thinkingBlocks?: Array<{ type: "thinking"; thinking: string }>,
): string {
  const parts: string[] = [];

  // 1. 先从 thinking_blocks 提取（原始 thinking，优先）
  if (thinkingBlocks && thinkingBlocks.length > 0) {
    for (const tb of thinkingBlocks) {
      if (tb.thinking) parts.push(tb.thinking);
    }
  }

  // 2. 再从 content blocks 提取 text 类型
  for (const block of contentBlocks) {
    const b = block as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
      parts.push(b.text);
    }
  }

  return parts.join("\n\n");
}

/**
 * 将完整 content blocks 生成 content 字符串表示
 * 用于 action 步骤的 content 字段（思考 + 动作的混合文本）
 */
function extractFullContent(
  contentBlocks: unknown[],
  thinkingBlocks?: Array<{ type: "thinking"; thinking: string }>,
): string {
  const parts: string[] = [];

  if (thinkingBlocks && thinkingBlocks.length > 0) {
    for (const tb of thinkingBlocks) {
      if (tb.thinking) parts.push(tb.thinking);
    }
  }

  for (const block of contentBlocks) {
    const b = block as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string") {
      parts.push(b.text);
    } else if (b.type === "tool_use") {
      const inputStr = JSON.stringify(b.input ?? {});
      parts.push(`${b.name}(${inputStr})`);
    }
  }

  return parts.join("\n");
}

/**
 * 在后续 pairs 的 raw_messages（完整 messages）中查找对应的 tool_result
 *
 * 与 claude-trace builder.py 的 find_tool_result() 对齐：
 * - 搜索 raw_messages（完整 messages），不受增量计算影响
 * - maxLookahead = 3（与 claude-trace 一致）
 */
function findToolResult(
  pairs: RequestResponsePair[],
  startIndex: number,
  toolUseId: string,
  maxLookahead: number = 3,
): { content: string; is_error: boolean } | null {
  const lookaheadPairs = pairs.slice(startIndex, startIndex + maxLookahead);

  for (const pair of lookaheadPairs) {
    // 优先搜索 raw_messages（完整 messages），其次 messages
    const messages = (pair.request.raw_messages ?? pair.request.messages ?? []) as Array<Record<string, unknown>>;

    for (const msg of messages) {
      if (msg.role !== "user") continue;
      const content = Array.isArray(msg.content) ? msg.content : [];

      for (const block of content as Array<Record<string, unknown>>) {
        if (block.type === "tool_result" && block.tool_use_id === toolUseId) {
          let contentStr: string;
          if (typeof block.content === "string") {
            contentStr = block.content;
          } else if (Array.isArray(block.content)) {
            // content blocks 数组，提取 text 类型
            const texts: string[] = [];
            for (const cb of block.content as Array<Record<string, unknown>>) {
              if (cb.type === "text" && typeof cb.text === "string") {
                texts.push(cb.text);
              }
            }
            contentStr = texts.join("\n");
          } else {
            contentStr = JSON.stringify(block.content ?? "");
          }
          return {
            content: contentStr,
            is_error: (block.is_error as boolean) ?? false,
          };
        }
      }
    }
  }

  return null;
}

/**
 * 提取 system prompt 文本（可能是 string 或 content block 数组）
 */
function extractSystemPromptText(system: unknown): string {
  if (typeof system === "string") return system;
  if (Array.isArray(system)) {
    const parts: string[] = [];
    for (const block of system as Array<Record<string, unknown>>) {
      if (block.type === "text" && typeof block.text === "string") {
        parts.push(block.text);
      }
    }
    return parts.join("\n");
  }
  return "";
}

/**
 * 计算 MD5 hash（对齐 claude-trace builder.py 的 md5 使用方式）
 */
function md5(text: string): string {
  return createHash("md5").update(text).digest("hex");
}

// ─── 主构建函数 ───

/**
 * 构建完整的 .traj 文件内容
 *
 * @param pairs - 采集器累积的请求/响应对列表
 * @param metadata - 会话元数据
 */
export function buildTrajectory(
  pairs: RequestResponsePair[],
  metadata: TraceMetadata,
): TrajectoryFile {
  const trajectory: TrajectoryStep[] = [];
  const history: HistoryEntry[] = [];

  // ─── 提取 system prompt ───
  const systemPrompt = metadata.system_prompt
    ?? extractSystemPromptText(pairs[0]?.request.system);
  const claudeMdHash = systemPrompt ? md5(systemPrompt) : undefined;

  // ─── 写入 history 的 system 消息 ───
  if (systemPrompt) {
    history.push({
      role: "system",
      content: systemPrompt,
      agent: "primary",
    });
  }

  // ─── 写入首次请求的 user messages ───
  if (pairs.length > 0) {
    const firstPair = pairs[0];
    const firstMessages = (firstPair.request.raw_messages ?? firstPair.request.messages ?? []) as Array<Record<string, unknown>>;
    for (const msg of firstMessages) {
      if (msg.role === "user") {
        history.push({
          role: "user",
          content: msg.content,
          agent: "primary",
        });
        break; // 只取第一条 user message（初始提示词）
      }
    }
  }

  // ─── 遍历每个 pair，构建 trajectory 和 history ───
  for (let i = 0; i < pairs.length; i++) {
    const pair = pairs[i];
    const contentBlocks = pair.response.content as Array<Record<string, unknown>>;
    const thinkingBlocks = pair.thinking_blocks;

    // 提取本次响应的 thought（thinking + text）
    const thought = extractThought(contentBlocks, thinkingBlocks);
    const fullContent = extractFullContent(contentBlocks, thinkingBlocks);

    // 提取 tool_use blocks
    const toolUseBlocks = contentBlocks.filter(b => b.type === "tool_use");

    // ─── 构建 history：assistant 消息 ───
    const toolCalls = toolUseBlocks.map(b => ({
      function: {
        name: b.name as string,
        arguments: JSON.stringify(b.input ?? {}),
      },
    }));

    // 优先使用 response.usage（权威数据），fallback 到顶层冗余字段
    const usageSrc = pair.response.usage ?? pair.usage;
    const assistantEntry: AssistantHistoryEntry = {
      role: "assistant",
      content: contentBlocks,
      message_type: toolUseBlocks.length > 0 ? "action" : "thought",
      agent: "primary",
      thought,
      thinking_blocks: thinkingBlocks ?? null,
      tool_calls: toolCalls,
      usage: {
        input_tokens: usageSrc.input_tokens,
        output_tokens: usageSrc.output_tokens,
        cache_read_input_tokens: usageSrc.cache_read_input_tokens,
        cache_creation_input_tokens: usageSrc.cache_creation_input_tokens,
      },
      stop_reason: pair.stop_reason,
      timestamp: pair.timestamp,
    };
    history.push(assistantEntry);

    // ─── 构建 trajectory：action + observation 步骤 ───

    if (toolUseBlocks.length > 0) {
      // 每个 tool_use block 生成一个 action + observation 步骤对
      // 只在第一个 tool_use 中关联 thought，避免多工具调用时重复
      for (let ti = 0; ti < toolUseBlocks.length; ti++) {
        const tb = toolUseBlocks[ti];
        const toolUseId = tb.tool_use_id as string ?? tb.id as string ?? "";
        const toolName = tb.name as string ?? "";
        const toolInput = (tb.input ?? {}) as Record<string, unknown>;
        const inputStr = JSON.stringify(toolInput);

        // action 步骤
        const actionStep: ActionStep = {
          message_type: "action",
          role: "assistant",
          content: ti === 0 ? fullContent : `${toolName}(${inputStr})`,
          thought: ti === 0 ? thought : "",
          action: `${toolName}(${inputStr})`,
          tool_name: toolName,
          tool_input: toolInput,
          tool_use_id: toolUseId,
          agent: "primary",
          timestamp: pair.timestamp,
        };
        trajectory.push(actionStep);

        // observation 步骤：在后续 pairs 中查找 tool_result
        const toolResultInfo = findToolResult(pairs, i + 1, toolUseId);

        if (toolResultInfo !== null) {
          const obsStep: ObservationStep = {
            message_type: "observation",
            role: "user",
            content: toolResultInfo.content,
            tool_use_id: toolUseId,
            is_error: toolResultInfo.is_error,
            agent: "primary",
          };
          trajectory.push(obsStep);

          // 同步追加到 history（对齐 claude-trace builder.py:289-296）
          // 找到对应的 tool_result block 插入 history
          history.push({
            role: "user",
            content: [{
              type: "tool_result",
              tool_use_id: toolUseId,
              content: toolResultInfo.content,
              is_error: toolResultInfo.is_error,
            }],
            message_type: "observation",
            agent: "primary",
            tool_call_ids: [toolUseId],
          });
        } else {
          // orphan observation（对齐 claude-trace builder.py:297-307）
          const orphanStep: ObservationStep = {
            message_type: "observation",
            role: "user",
            content: "[tool_result not found - session may have ended mid-execution]",
            agent: "primary",
            is_error: false,
            tool_use_id: toolUseId,
            _orphan: true,
          };
          trajectory.push(orphanStep);
        }
      }
    } else if (pair.stop_reason === "end_turn" && thought.trim()) {
      // final_answer：三个条件缺一不可
      // 1. stop_reason === "end_turn"
      // 2. thought 非空
      // 3. 无 tool_use blocks
      const finalStep: ActionStep = {
        message_type: "action",
        role: "assistant",
        content: fullContent,
        thought,
        action: "final_answer",
        agent: "primary",
        timestamp: pair.timestamp,
      };
      trajectory.push(finalStep);
    }

    // ─── 构建 history：后续请求的 user messages（增量）───
    // 只添加非首次请求的 new_messages 中的 user 消息
    // （tool_result 已经在 findToolResult 路径中追加，这里添加真实的 user 输入）
    if (i + 1 < pairs.length) {
      const nextPair = pairs[i + 1];
      const newMessages = nextPair.request.new_messages ?? [];
      for (const msg of newMessages as Array<Record<string, unknown>>) {
        if (msg.role === "user") {
          const content = Array.isArray(msg.content) ? msg.content : msg.content;
          // 过滤掉 tool_result 类型（已经由 findToolResult 路径处理）
          if (Array.isArray(content)) {
            const nonToolResultBlocks = (content as Array<Record<string, unknown>>).filter(
              b => b.type !== "tool_result"
            );
            if (nonToolResultBlocks.length > 0) {
              history.push({
                role: "user",
                content: nonToolResultBlocks,
                agent: "primary",
              });
            }
          } else if (typeof content === "string" && content.trim()) {
            history.push({
              role: "user",
              content,
              agent: "primary",
            });
          }
        }
      }
    }
  }

  // ─── 计算统计数据 ───
  let tokensSent = metadata.total_tokens_sent;
  let tokensReceived = metadata.total_tokens_received;
  let cacheReadTokens = metadata.total_cache_read_tokens;
  let cacheCreationTokens = metadata.total_cache_creation_tokens;
  const apiCalls = metadata.total_api_calls || pairs.length;

  // 如果 metadata 中的统计为 0，从 pairs 中累加
  if (tokensSent === 0 && pairs.length > 0) {
    // input_tokens 取最后一次（已含全部历史），output/cache 累加。
    // 见 collector.ts handleAfterModel 注释。
    for (const pair of pairs) {
      tokensReceived += pair.usage.output_tokens;
      cacheReadTokens += pair.usage.cache_read_input_tokens;
      cacheCreationTokens += pair.usage.cache_creation_input_tokens;
    }
    tokensSent = pairs[pairs.length - 1].usage.input_tokens;
  }

  // 推断 exit_status
  const exitStatus = metadata.exit_status
    ?? (pairs.length > 0 && pairs[pairs.length - 1].stop_reason === "end_turn"
      ? "end_turn"
      : "unknown");

  // ─── 构建 info ───
  const info: TrajectoryInfo = {
    model_stats: {
      tokens_sent: tokensSent,
      tokens_received: tokensReceived,
      cache_read_tokens: cacheReadTokens,
      cache_creation_tokens: cacheCreationTokens,
      api_calls: apiCalls,
      total_cost_usd: metadata.total_cost_usd,
    },
    exit_status: exitStatus,
    has_thinking: metadata.has_thinking,
  };

  // ─── 构建 metadata 输出 ───
  const metaOutput: TrajectoryMetaOutput = {
    session_id: metadata.session_id,
    model: metadata.model,
    start_time: metadata.start_time,
    end_time: metadata.end_time ?? new Date().toISOString(),
    total_steps: trajectory.length,
    total_api_calls: apiCalls,
    total_tokens_sent: tokensSent,
    total_tokens_received: tokensReceived,
    total_cache_read_tokens: cacheReadTokens,
    total_cache_creation_tokens: cacheCreationTokens,
    total_tokens: tokensSent + tokensReceived,
    total_cost_usd: metadata.total_cost_usd,
    exit_status: exitStatus,
    tools_used: Array.from(metadata.tools_used),
    files_edited: Array.from(metadata.files_edited),
    working_directory: metadata.working_directory,
    has_thinking: metadata.has_thinking,
    has_sub_agent: metadata.has_sub_agent,
    user_prompts: metadata.user_prompts,
    compactions: metadata.compactions,
    subagent_spans: metadata.subagent_spans,
    tool_source: "sid-code",
    ...(metadata.start_source ? { start_source: metadata.start_source } : {}),
    ...(metadata.end_source ? { end_source: metadata.end_source } : {}),
    ...(claudeMdHash ? { claude_md_hash: claudeMdHash } : {}),
    ...(metadata.error ? { error: metadata.error } : {}),
    ...(metadata.harness ? { harness: metadata.harness } : {}),
  };

  return {
    trajectory,
    history,
    info,
    metadata: metaOutput,
  };
}
