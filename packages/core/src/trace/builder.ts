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
    /**
     * P1-6：本次请求解析后的思考开关（**内部表示，不是 wire body**）。
     * 缺席 = 本轮没解析出该旋钮，**不等于**"线上没发 thinking" ——
     * 把两者混为一谈正是 2026-08-17 那轮排查跑偏的原因，详见 `hook/types.ts`。
     */
    thinking?: { enabled: boolean; budgetTokens?: number };
    /** P1-6：本次请求解析后的推理强度档位（内部表示，注意事项同 `thinking`） */
    reasoning_effort?: string;
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
    /**
     * P2-6：网关下发的请求标识（`raw.jsonl` 此前**一个响应头都不留**，见 §4.1）。
     *
     * 形状是 `{ header, value }` 而非裸字符串：本仓两族网关头名不同
     * （`x-oneapi-request-id` / `x-shellapi-request-id`），只留值就分不清
     * 该拿它找哪一方对账。缺席 = 该端点未下发此类头。
     */
    gateway_request_id?: { header: string; value: string };
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
  /**
   * 当前/实际使用的模型。
   * ★§6.4（根治文档观测项）：此字段跟踪**实际发生请求的模型**——`/model` 切换后随之更新，
   * 与 raw.jsonl/events.jsonl 及 TUI 实时显示一致，避免归因分析时误判为启动值。
   * 会话启动时的原始模型另存于 `model_at_start`。
   */
  model: string;
  /**
   * ★§6.4：会话启动时（SessionStart）的原始模型，写入后冻结不变。
   * 用户中途 `/model` 切换只更新 `model`，不动此字段，供"启动 vs 切换后"的归因对照。
   */
  model_at_start?: string;
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
  subagent_spans: Array<{
    agent_id: string;
    agent_type: string;
    start: string;
    end?: string;
    description?: string;
  }>;
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

  // ── 缺口分析补全：派生/采集类指标（会话级聚合，逐轮更新） ──
  /**
   * reasoning / thinking token 累计（缺口分析二类）。此前仅有 `has_thinking` 布尔，
   * thinking 模型的隐藏成本无从体现。取自 provider usage 的 reasoning token 字段
   * （OpenAI 族 `completion_tokens_details.reasoning_tokens`；Anthropic 无独立计数，
   * 只能靠 output_tokens 含思考，故该族此值恒 0，靠 has_thinking 区分）。
   */
  total_reasoning_tokens: number;
  /**
   * 纯生成耗时累计（ms）。取自 `RetryTelemetry(stream_completed).elapsedMs`
   * （单次 fetch 从连接到流结束的纯耗时，不含握手/重试/等待）。
   * 与 total_tokens_received 配对派生"输出吞吐 tokens/sec"——**分母必须是纯生成耗时**，
   * 用整轮 api_duration_ms 会重蹈 Bug A 的重试/等待污染覆辙（见排查报告 §2）。
   */
  total_gen_elapsed_ms: number;
  /** 拿到过纯生成耗时的 fetch 次数（tokens/sec 分母的样本数，判断吞吐是否可信） */
  gen_samples: number;
  /**
   * 会话级输出吞吐（tokens/sec）= total_tokens_received / (total_gen_elapsed_ms/1000)。
   * gen_samples=0（无纯生成耗时样本）时为 undefined，不落一个误导的 0 或 ∞。
   */
  output_tokens_per_sec?: number;
  /**
   * 工具执行耗时累计（ms）。逐个 PostToolUse 的 duration_ms 累加。
   * 与主循环 SessionState.totalToolDuration 同口径，但持久化进轨迹供离线复盘。
   */
  total_tool_duration_ms: number;
  /** 记录到耗时的工具调用次数（求均值/判断样本量用） */
  tool_duration_samples: number;
  /**
   * 上下文占用峰值（0~1）。每轮 AfterModel 用 promptTotal/contextWindow 计算，取最大值。
   * 反映"最接近上下文溢出的时刻"，比末值更能预警 lost-in-the-middle 与成本膨胀。
   */
  context_usage_peak_ratio?: number;
  /** 上下文占用峰值对应的绝对 token 数（与 context_usage_peak_ratio 同轮） */
  context_usage_peak_tokens?: number;
  /** 上下文占用峰值时所用的窗口大小（token），便于核对比率来源 */
  context_window_at_peak?: number;
  /**
   * 缺口分析五类：上下文占用率逐轮序列（每轮 AfterModel 的 ratio，保留时序）。
   * 峰值只给"最满时刻"，趋势才能看出"是否随轮次线性膨胀"（第 28 轮 ≈ 第 1 轮 28×）。
   */
  context_usage_trend: number[];

  // ── 缺口分析六类·可靠性（会话级聚合计数） ──
  /**
   * 被弃流数（缺口分析六类：白烧 output token 的主因，本次排查命中 12 条）。
   * 统计 StreamPhase(aborted) + RetryTelemetry(retry/超时/529_dropped)——
   * 每次重连意味着前一次流被丢弃、已生成的 output 白烧。
   */
  discarded_streams: number;
  /** 模型调用重试次数累计（RetryTelemetry type=retry） */
  model_retry_count: number;

  // ── 缺口分析三/四类·派生比率（SessionEnd 一次性算） ──
  /**
   * 输出/输入 token 比（缺口分析三类）。输出单价是输入的 3–8×，此比率上涨说明成本结构恶化。
   * 分母用累计输入 prompt（flow 口径，与 output 累计可比）；无输入时 undefined。
   */
  output_input_ratio?: number;
  /**
   * 本会话缓存命中率（缺口分析四类）= cache_read /（cache_read + 全价输入）。
   * 此前仅有跨会话命中率，单会话 traj 不落此派生值，无法定位"哪个会话缓存差"。
   */
  session_cache_hit_rate?: number;

  // 辅助 LLM 调用统计（影子调用：标题生成/记忆召回/权限分类/摘要压缩/预热/目标评估等，
  // 不经过主循环 BeforeModel/AfterModel 的调用）
  side_api_calls: number;
  side_cost_usd: number;
  side_tokens_sent: number;
  side_tokens_received: number;
  exit_status?: string;
  start_source?: string;
  end_source?: string;
  /**
   * P0-1：sid-code 自身版本号（裸 x.y.z）。**飞轮维度的唯一来源。**
   *
   * 四方向的第 3 级都是 release-over-release 曲线，而在此之前轨迹里一个版本字段都没有
   * （实测 `session.traj` 的 metadata 47 个键含 `ver` 的 0 个）——于是任何指标都归属不到
   * 某个 release，第 3 级全部无法起步。由 collector 在会话初始化时兜底填入真值。
   */
  app_version?: string;
  /** Bug3 桥接：resume 时本进程用新 id 写 trajectory，此处记录被恢复的旧会话 id，
   *  使 trajectory 能反查到 SessionStore 的 sessions/{旧id}.jsonl 对话历史。 */
  resumed_from?: string;
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

  /** §3.6：实时阶段状态——排查时一眼看出"卡在哪个阶段" */
  last_known_state?: {
    phase: "before_model" | "streaming" | "post_stream" | "tool_exec" | "done";
    turn: number;
    model: string;
    updated_at: string;
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
  /**
   * ★§6.4：会话启动时的原始模型（写入后冻结）。与 `model`（跟踪 /model 切换后的实际模型）
   * 配对，供归因分析对照"启动 vs 切换后"。可选——旧 traj 无此字段。
   */
  model_at_start?: string;
  start_time: string;
  end_time: string;
  total_steps: number;
  total_api_calls: number;
  total_tokens_sent: number;
  total_tokens_received: number;
  total_cache_read_tokens: number;
  total_cache_creation_tokens: number;
  total_tokens: number;
  /**
   * DISP-1 / §6.3：累计输入 prompt token（flow 口径，逐次累加）。
   * total_tokens_sent 是末次值（stock，含全历史），与逐次累加的 total_cost_usd 口径不可比；
   * 此字段与 cost 同为 flow，外部系统应用它和 total_cost_usd 做"每 token 花费"的可比除法，
   * 切勿用 total_cost_usd / total_tokens_sent（stock÷flow 会得到错误单价）。
   */
  total_cumulative_prompt_tokens: number;
  total_cost_usd: number;

  // ── 缺口分析补全：派生/采集类指标（会话级，可选——旧 traj 无这些字段） ──
  /** 缺口分析二类：reasoning/thinking token 累计（仅 OpenAI 族 >0） */
  total_reasoning_tokens?: number;
  /** 缺口分析一类：会话级输出吞吐（tokens/sec）；无纯生成耗时样本时 undefined */
  output_tokens_per_sec?: number;
  /** 缺口分析一类：纯生成耗时累计（ms，tokens/sec 分母，来自 stream_completed） */
  total_gen_elapsed_ms?: number;
  /** 缺口分析一类：工具执行耗时累计（ms，逐个 PostToolUse.duration_ms 累加） */
  total_tool_duration_ms?: number;
  /** 缺口分析一类：记录到耗时的工具调用次数 */
  tool_duration_samples?: number;
  /** 缺口分析五类：上下文占用峰值（0~1）；窗口未知时 undefined */
  context_usage_peak_ratio?: number;
  /** 缺口分析五类：上下文占用峰值对应的绝对 token 数 */
  context_usage_peak_tokens?: number;
  /** 缺口分析五类：上下文占用率逐轮趋势序列 */
  context_usage_trend?: number[];
  /** 缺口分析六类：被弃流数（重连/中断丢弃的流，白烧 output token） */
  discarded_streams?: number;
  /** 缺口分析六类：模型调用重试次数 */
  model_retry_count?: number;
  /** 缺口分析三类：输出/输入 token 比 */
  output_input_ratio?: number;
  /** 缺口分析四类：本会话缓存命中率 */
  session_cache_hit_rate?: number;

  // 辅助 LLM 调用统计（影子调用）
  side_api_calls?: number;
  side_cost_usd?: number;
  side_tokens_sent?: number;
  side_tokens_received?: number;
  exit_status: string;
  tools_used: string[];
  files_edited: string[];
  working_directory: string;
  has_thinking: boolean;
  has_sub_agent: boolean;
  user_prompts: string[];
  compactions: Array<{ trigger: string; timestamp: string }>;
  subagent_spans: Array<{
    agent_id: string;
    agent_type: string;
    start: string;
    end?: string;
    description?: string;
  }>;
  tool_source: "sid-code";
  start_source?: string;
  end_source?: string;
  /**
   * P0-1：写这份 traj 的 sid-code 版本号（裸 x.y.z，如 "0.1.601"）。
   *
   * 消费侧靠它做 release-over-release 对比。**存量 traj 没有这个字段**，
   * 消费侧必须把 `undefined` 归入「无版本标记」桶并显式标注，不要当成 0 或空串
   * （见 `explicit-undefined-punches-through-defaults` 那类击穿）。
   */
  app_version?: string;
  /** Bug3 桥接：被恢复的旧会话 id（resume 场景），用于反查 SessionStore 对话历史。 */
  resumed_from?: string;
  claude_md_hash?: string;
  /** 错误退出时的简要错误信息（reason="error"） */
  error?: { message: string; name?: string };

  /** §3.6：实时阶段状态——排查时一眼看出"卡在哪个阶段" */
  last_known_state?: {
    phase: "before_model" | "streaming" | "post_stream" | "tool_exec" | "done";
    turn: number;
    model: string;
    updated_at: string;
  };

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
    // 优先搜索 raw_messages（完整 messages），其次 new_messages（增量），再次 messages。
    // 内存优化：collector 会剥离旧 pair 的 raw_messages（O(N²) 驻留），此时回退到
    // new_messages。tool_result 恒出现在 tool_use 之后一轮的 user turn → 落在下一个
    // pair 的 new_messages（增量）里，故增量足以覆盖 maxLookahead 窗口内的查找。
    const messages = (pair.request.raw_messages ??
      pair.request.new_messages ??
      pair.request.messages ??
      []) as Array<Record<string, unknown>>;

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
  const systemPrompt = metadata.system_prompt ?? extractSystemPromptText(pairs[0]?.request.system);
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
    const firstMessages = (firstPair.request.raw_messages ??
      firstPair.request.messages ??
      []) as Array<Record<string, unknown>>;
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

    // 在途请求（is_partial）：只有请求侧，无真实响应。
    // 记录一条 "interrupted" 步骤到 trajectory + history，跳过 response 解析。
    if (pair.is_partial) {
      const partialStep: TrajectoryStep = {
        message_type: "action",
        role: "assistant",
        content: "[请求已发出但未收到响应（中断/超时）]",
        thought: "",
        action: "interrupted",
        agent: "primary",
        timestamp: pair.timestamp,
      };
      trajectory.push(partialStep);
      history.push({
        role: "assistant",
        content: [],
        message_type: "action",
        agent: "primary",
        thought: "",
        thinking_blocks: null,
        tool_calls: [],
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
        stop_reason: "interrupted",
        timestamp: pair.timestamp,
      } as AssistantHistoryEntry);
      continue;
    }

    const contentBlocks = pair.response.content as Array<Record<string, unknown>>;
    const thinkingBlocks = pair.thinking_blocks;

    // 提取本次响应的 thought（thinking + text）
    const thought = extractThought(contentBlocks, thinkingBlocks);
    const fullContent = extractFullContent(contentBlocks, thinkingBlocks);

    // 提取 tool_use blocks
    const toolUseBlocks = contentBlocks.filter((b) => b.type === "tool_use");

    // ─── 构建 history：assistant 消息 ───
    const toolCalls = toolUseBlocks.map((b) => ({
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
        const toolUseId = (tb.tool_use_id as string) ?? (tb.id as string) ?? "";
        const toolName = (tb.name as string) ?? "";
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
            content: [
              {
                type: "tool_result",
                tool_use_id: toolUseId,
                content: toolResultInfo.content,
                is_error: toolResultInfo.is_error,
              },
            ],
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
              (b) => b.type !== "tool_result",
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
  const exitStatus =
    metadata.exit_status ??
    (pairs.length > 0 && pairs[pairs.length - 1].stop_reason === "end_turn"
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
    // ★§6.4：落盘启动模型，供"启动 vs /model 切换后"归因对照。仅在有值且与当前模型不同时
    // 才写（相同则无对照意义，省字段，兼容旧 traj）。
    ...(metadata.model_at_start && metadata.model_at_start !== metadata.model
      ? { model_at_start: metadata.model_at_start }
      : {}),
    start_time: metadata.start_time,
    end_time: metadata.end_time ?? new Date().toISOString(),
    total_steps: trajectory.length,
    total_api_calls: apiCalls,
    total_tokens_sent: tokensSent,
    total_tokens_received: tokensReceived,
    total_cache_read_tokens: cacheReadTokens,
    total_cache_creation_tokens: cacheCreationTokens,
    total_tokens: tokensSent + tokensReceived,
    // §6.3：累计 prompt（flow），与 total_cost_usd 同口径，供外部做可比单价除法
    total_cumulative_prompt_tokens: metadata.total_cumulative_prompt_tokens,
    total_cost_usd: metadata.total_cost_usd,
    // 缺口分析补全：派生/采集类指标（仅在有值时输出，避免污染旧 traj 的解析预期）
    ...(metadata.total_reasoning_tokens
      ? { total_reasoning_tokens: metadata.total_reasoning_tokens }
      : {}),
    ...(metadata.output_tokens_per_sec !== undefined
      ? { output_tokens_per_sec: metadata.output_tokens_per_sec }
      : {}),
    ...(metadata.total_gen_elapsed_ms
      ? { total_gen_elapsed_ms: metadata.total_gen_elapsed_ms }
      : {}),
    ...(metadata.total_tool_duration_ms
      ? { total_tool_duration_ms: metadata.total_tool_duration_ms }
      : {}),
    ...(metadata.tool_duration_samples
      ? { tool_duration_samples: metadata.tool_duration_samples }
      : {}),
    ...(metadata.context_usage_peak_ratio !== undefined
      ? {
          context_usage_peak_ratio: metadata.context_usage_peak_ratio,
          context_usage_peak_tokens: metadata.context_usage_peak_tokens,
        }
      : {}),
    ...(metadata.context_usage_trend && metadata.context_usage_trend.length > 0
      ? { context_usage_trend: metadata.context_usage_trend }
      : {}),
    ...(metadata.discarded_streams ? { discarded_streams: metadata.discarded_streams } : {}),
    ...(metadata.model_retry_count ? { model_retry_count: metadata.model_retry_count } : {}),
    ...(metadata.output_input_ratio !== undefined
      ? { output_input_ratio: metadata.output_input_ratio }
      : {}),
    ...(metadata.session_cache_hit_rate !== undefined
      ? { session_cache_hit_rate: metadata.session_cache_hit_rate }
      : {}),
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
    // P0-1：版本号。用「有值才写」而非无条件写 undefined —— 后者会让 JSON 里出现
    // `"app_version": undefined` 这类击穿默认值的形态（`explicit-undefined-punches-through-defaults`）。
    ...(metadata.app_version ? { app_version: metadata.app_version } : {}),
    ...(metadata.resumed_from ? { resumed_from: metadata.resumed_from } : {}),
    ...(claudeMdHash ? { claude_md_hash: claudeMdHash } : {}),
    ...(metadata.error ? { error: metadata.error } : {}),
    ...(metadata.harness ? { harness: metadata.harness } : {}),
    ...(metadata.last_known_state ? { last_known_state: metadata.last_known_state } : {}),
    // 辅助 LLM 调用统计（仅在有值时输出，避免污染历史 traj 解析）
    ...(metadata.side_api_calls
      ? {
          side_api_calls: metadata.side_api_calls,
          side_cost_usd: metadata.side_cost_usd,
          side_tokens_sent: metadata.side_tokens_sent,
          side_tokens_received: metadata.side_tokens_received,
        }
      : {}),
  };

  return {
    trajectory,
    history,
    info,
    metadata: metaOutput,
  };
}
