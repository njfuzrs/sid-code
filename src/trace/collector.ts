/**
 * 轨迹事件采集器
 * 通过 runtime hook 注册接收所有 hook 事件，在内存中累积 RequestResponsePair，
 * 驱动 TraceWriter 写入文件、TraceBuilder 构建 .traj，SessionEnd 时触发上传。
 *
 * 设计原则：
 * - 所有事件处理 try-catch，失败时仅记录警告不抛异常（采集不影响正常使用）
 * - 每次 AfterModel 后立即追加 raw.jsonl、重建 session.traj（崩溃安全）
 * - SessionEnd 时以 stats 参数覆盖自己累积的统计值（SessionState 更准确）
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import {
  HookEventName,
  type HookInput,
  type PreToolUseInput,
  type PostToolUseInput,
  type BeforeModelInput,
  type AfterModelInput,
  type SessionStartInput,
  type SessionEndInput,
  type PreCompactInput,
  type SubagentStartInput,
  type UserPromptSubmitInput,
} from "../hook/types.ts";
import type { HookSystem } from "../hook/system.ts";
import { TraceWriter, type RawJsonlEntry } from "./writer.ts";
import { buildTrajectory, type RequestResponsePair, type TraceMetadata } from "./builder.ts";
import { getLogger } from "../debug/logger.ts";
import type { Message } from "../llm/types.ts";
import { checkMessageHistoryIntegrity } from "../agent/message-invariants.ts";

// ─── 最小化上传器接口（避免循环依赖，Task 8 实现后注入） ───

export interface TraceUploaderInterface {
  uploadSession(sessionDir: string, sessionId: string): Promise<{ allConfirmed: boolean }>;
}

// ─── 采集器选项 ───

export interface CollectorOptions {
  /** 本地输出目录（默认 ~/.sid-code/trajectories） */
  outputDir?: string;
  /** 本地最大保留会话数（默认 100） */
  maxSessionsRetained?: number;
}

// ─── system prompt 文本提取 ───

function extractSystemPromptText(system: unknown): string {
  if (typeof system === "string") return system;
  if (Array.isArray(system)) {
    return (system as Array<Record<string, unknown>>)
      .filter(b => b.type === "text")
      .map(b => b.text as string)
      .join("\n");
  }
  return "";
}

// ─── 主类 ───

export class TraceCollector {
  private pairs: RequestResponsePair[] = [];
  private metadata!: TraceMetadata;
  private currentPair: Partial<RequestResponsePair> | null = null;
  private prevMessageCount: number = 0;
  private writer!: TraceWriter;
  private uploader: TraceUploaderInterface | null;
  private readonly outputDir: string;
  private initialized = false;
  /** 待写入下次 raw.jsonl 的 compact_boundary */
  private pendingCompactBoundary: RawJsonlEntry["compact_boundary"] | undefined;

  // ── Harness 编辑统计内部计数器 ──
  private harnessEditCount = 0;
  private harnessEditFirstPass = 0;
  private harnessProtocols: Record<string, number> = {};

  constructor(options: CollectorOptions = {}, uploader: TraceUploaderInterface | null = null) {
    this.outputDir = options.outputDir
      ?? join(homedir(), ".sid-code", "trajectories");
    this.uploader = uploader;
  }

  // ─── Hook 注册 ───

  /**
   * 将采集器注册为 runtime hook，监听所有相关事件。
   * 必须在 SessionStart 之前调用。
   */
  registerHooks(hookSystem: HookSystem): void {
    const eventNames = [
      HookEventName.SessionStart,
      HookEventName.BeforeModel,
      HookEventName.AfterModel,
      HookEventName.PreToolUse,
      HookEventName.PostToolUse,
      HookEventName.PostToolUseFailure,
      HookEventName.UserPromptSubmit,
      HookEventName.PreCompact,
      HookEventName.SubagentStart,
      HookEventName.SubagentStop,
      HookEventName.SessionEnd,
    ] as const;

    for (const eventName of eventNames) {
      hookSystem.registerHook(
        {
          type: "runtime",
          name: `trace-collector-${eventName}`,
          action: async (input: HookInput) => {
            await this.handleEvent(input);
          },
        },
        eventName,
        { source: "runtime" as any },
      );
    }
  }

  // ─── 事件路由 ───

  private async handleEvent(input: HookInput): Promise<void> {
    try {
      switch (input.hook_event_name) {
        case HookEventName.SessionStart:
          await this.handleSessionStart(input as SessionStartInput);
          break;
        case HookEventName.BeforeModel:
          this.handleBeforeModel(input as BeforeModelInput);
          break;
        case HookEventName.AfterModel:
          await this.handleAfterModel(input as AfterModelInput);
          break;
        case HookEventName.PreToolUse:
          this.handlePreToolUse(input as PreToolUseInput);
          break;
        case HookEventName.PostToolUse:
          this.handlePostToolUse(input as PostToolUseInput);
          break;
        case HookEventName.PostToolUseFailure:
          this.handlePostToolUseFailure(input as PostToolUseInput);
          break;
        case HookEventName.UserPromptSubmit:
          this.handleUserPromptSubmit(input as UserPromptSubmitInput);
          break;
        case HookEventName.PreCompact:
          this.handlePreCompact(input as PreCompactInput);
          break;
        case HookEventName.SubagentStart:
          this.handleSubagentStart(input as SubagentStartInput);
          break;
        case HookEventName.SubagentStop:
          this.handleSubagentStop(input);
          break;
        case HookEventName.SessionEnd:
          await this.handleSessionEnd(input as SessionEndInput);
          break;
      }
    } catch (err) {
      getLogger().warn("TRACE", `采集事件处理失败 [${input.hook_event_name}]: ${err}`);
    }
  }

  // ─── SessionStart ───

  private async handleSessionStart(input: SessionStartInput): Promise<void> {
    this.pairs = [];
    this.prevMessageCount = 0;
    this.currentPair = null;

    this.metadata = {
      session_id: input.session_id,
      model: input.model ?? "",
      start_time: input.timestamp,
      working_directory: input.cwd,
      permission_mode: input.permission_mode,
      tools_used: new Set(),
      files_edited: new Set(),
      user_prompts: [],
      compactions: [],
      subagent_spans: [],
      has_thinking: false,
      has_sub_agent: false,
      start_source: input.source,
      total_tokens_sent: 0,
      total_tokens_received: 0,
      total_cache_read_tokens: 0,
      total_cache_creation_tokens: 0,
      total_cost_usd: 0,
      total_api_calls: 0,
    };

    this.writer = new TraceWriter(this.outputDir, input.session_id);
    this.initialized = true;

    this.writer.appendEvent({
      event: HookEventName.SessionStart,
      session_id: input.session_id,
      timestamp: input.timestamp,
      cwd: input.cwd,
      data: {
        source: input.source,
        model: input.model,
        permission_mode: input.permission_mode,
      },
    });
  }

  // ─── BeforeModel ───

  private handleBeforeModel(input: BeforeModelInput): void {
    if (!this.initialized) return;

    const req = input.llm_request;
    const rawMessages = (req.raw_messages ?? req.messages ?? []) as unknown[];
    const index = this.pairs.length + 1;

    // 首次请求提取 system prompt
    if (index === 1 && req.system !== undefined) {
      const systemText = extractSystemPromptText(req.system);
      if (systemText) {
        this.metadata.system_prompt = systemText;
        this.metadata.system_prompt_hash = createHash("md5").update(systemText).digest("hex");
      }
      if (this.metadata.model === "" && req.model) {
        this.metadata.model = req.model;
      }
    }

    // 计算增量 messages
    const newMessages = this.computeNewMessages(rawMessages);

    // 构建 currentPair 的 request 侧
    const requestSide: RequestResponsePair["request"] = {
      model: req.model,
      raw_messages: rawMessages,
      new_messages: newMessages,
    };

    if (index === 1) {
      // 首次请求保存完整数据
      requestSide.system = req.system;
      requestSide.tools = req.tools;
      requestSide.messages = rawMessages as unknown[];
    } else {
      // 后续请求只记录增量
      requestSide._messages_count = rawMessages.length;
    }

    this.currentPair = {
      timestamp: input.timestamp,
      index,
      model: req.model,
      request: requestSide,
      stop_reason: "",
      is_partial: false,
    };

    this.writer.appendEvent({
      event: HookEventName.BeforeModel,
      session_id: input.session_id,
      timestamp: input.timestamp,
      cwd: input.cwd,
      data: { model: req.model, index },
    });

    // 迷你 raw_preview：即使进程在 API 调用期间被 V8 OOM kill，也能知道最后一次请求的关键指标
    // 约 200 字节一行，不依赖 AfterModel 才能落盘
    try {
      const sessionDir = this.writer.getSessionDir();
      const previewLine = JSON.stringify({
        ts: input.timestamp,
        index,
        model: req.model,
        msg_count: rawMessages.length,
        total_tokens_est: 0, // 暂时放 0，estimateTokens 在 ctxMgr 内部，此处仅记录请求结构
      });
      appendFileSync(join(sessionDir, "raw_preview.jsonl"), previewLine + "\n");
    } catch {
      // 静默失败：preview 不是关键路径
    }
  }

  // ─── AfterModel ───

  private async handleAfterModel(input: AfterModelInput): Promise<void> {
    if (!this.initialized || !this.currentPair) return;

    const resp = input.llm_response;
    const usage = resp.usage ?? {};
    const inputTokens = usage.inputTokens ?? 0;
    const outputTokens = usage.outputTokens ?? 0;
    const cacheRead = usage.cacheReadInputTokens ?? 0;
    const cacheCreate = usage.cacheCreationInputTokens ?? 0;
    const stopReason = resp.stop_reason ?? "end_turn";
    const contentBlocks = (resp.content_blocks ?? []) as unknown[];
    const thinkingBlocks = resp.thinking_blocks as Array<{ type: "thinking"; thinking: string }> | undefined;

    // 检测 thinking
    if (thinkingBlocks && thinkingBlocks.length > 0) {
      this.metadata.has_thinking = true;
    }

    // 更新统计
    // ⚠️ inputTokens 是"本次 API 调用的 prompt 总长度"，每次调用都包含整段历史 prompt。
    // 直接累加会 N² 过计数（case_028 实测：29 次调用累加 = 3.65M，实际只有 167k）。
    // 正确口径：input 取最后一次（已含全部历史），output/cache 累加。
    // 校准记录见 evals/eval-judge.ts gradeCost 注释 + 2026-05-25 横向对比实验。
    this.metadata.total_tokens_sent = inputTokens;
    this.metadata.total_tokens_received += outputTokens;
    this.metadata.total_cache_read_tokens += cacheRead;
    this.metadata.total_cache_creation_tokens += cacheCreate;
    this.metadata.total_api_calls += 1;
    if (this.metadata.model === "" && input.llm_request.model) {
      this.metadata.model = input.llm_request.model;
    }

    // 完成 pair
    const usageNormalized = {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_read_input_tokens: cacheRead,
      cache_creation_input_tokens: cacheCreate,
    };

    const pair: RequestResponsePair = {
      ...(this.currentPair as RequestResponsePair),
      response: {
        content: contentBlocks,
        stop_reason: stopReason,
        usage: usageNormalized,
      },
      usage: usageNormalized,
      stop_reason: stopReason,
      ...(thinkingBlocks && thinkingBlocks.length > 0 ? { thinking_blocks: thinkingBlocks } : {}),
    };

    // 如果 Hook 载荷中有 harness_context，存入当前 pair
    if (input.harness_context) {
      pair.harness_turn_context = {
        tool_subset: input.harness_context.tool_subset,
        context_actions: input.harness_context.context_actions,
        runtime_mode: input.harness_context.runtime_mode,
        edit_protocol: input.harness_context.extra?.edit_protocol as string | undefined,
        extra: input.harness_context.extra,
      };
    }

    this.pairs.push(pair);
    this.currentPair = null;

    // 追加 raw.jsonl（不写入 raw_messages，仅内存持有）
    const rawEntry = this.toRawJsonlEntry(pair);
    this.writer.appendRaw(rawEntry);

    // 重建 session.traj
    await this.rebuildTraj();

    this.writer.appendEvent({
      event: HookEventName.AfterModel,
      session_id: input.session_id,
      timestamp: input.timestamp,
      cwd: input.cwd,
      data: {
        stop_reason: stopReason,
        usage: usageNormalized,
        index: pair.index,
      },
    });
  }

  // ─── PreToolUse ───

  private handlePreToolUse(input: PreToolUseInput): void {
    if (!this.initialized) return;
    this.writer.appendEvent({
      event: HookEventName.PreToolUse,
      session_id: input.session_id,
      timestamp: input.timestamp,
      cwd: input.cwd,
      data: {
        tool_name: input.tool_name,
        tool_use_id: input.tool_use_id,
      },
    });
  }

  // ─── PostToolUse ───

  private handlePostToolUse(input: PostToolUseInput): void {
    if (!this.initialized) return;

    this.metadata.tools_used.add(input.tool_name);

    // 推断 files_edited
    if (input.tool_name === "write" || input.tool_name === "edit") {
      const filePath = input.tool_input?.file_path;
      if (typeof filePath === "string") {
        this.metadata.files_edited.add(filePath);
      }
    }

    // 如果有 edit_meta，累积 Harness 编辑统计
    if (input.edit_meta) {
      this.harnessEditCount++;
      if (input.edit_meta.first_pass_success) this.harnessEditFirstPass++;
      if (input.edit_meta.protocol) {
        this.harnessProtocols[input.edit_meta.protocol] =
          (this.harnessProtocols[input.edit_meta.protocol] ?? 0) + 1;
      }
    }

    this.writer.appendEvent({
      event: HookEventName.PostToolUse,
      session_id: input.session_id,
      timestamp: input.timestamp,
      cwd: input.cwd,
      data: {
        tool_name: input.tool_name,
        tool_use_id: input.tool_use_id,
        is_error: input.is_error ?? false,
      },
    });
  }

  // ─── PostToolUseFailure ───

  private handlePostToolUseFailure(input: PostToolUseInput): void {
    if (!this.initialized) return;

    this.metadata.tools_used.add(input.tool_name);

    this.writer.appendEvent({
      event: HookEventName.PostToolUseFailure,
      session_id: input.session_id,
      timestamp: input.timestamp,
      cwd: input.cwd,
      data: {
        tool_name: input.tool_name,
        tool_use_id: input.tool_use_id,
        is_error: true,
      },
    });
  }

  // ─── UserPromptSubmit ───

  private handleUserPromptSubmit(input: UserPromptSubmitInput): void {
    if (!this.initialized) return;

    if (typeof input.prompt === "string" && input.prompt.trim()) {
      this.metadata.user_prompts.push(input.prompt);
    }

    this.writer.appendEvent({
      event: HookEventName.UserPromptSubmit,
      session_id: input.session_id,
      timestamp: input.timestamp,
      cwd: input.cwd,
      data: { prompt: input.prompt },
    });
  }

  // ─── PreCompact ───

  private handlePreCompact(input: PreCompactInput): void {
    if (!this.initialized) return;

    this.metadata.compactions.push({
      trigger: input.trigger,
      timestamp: input.timestamp,
    });

    // 暂存 compact_boundary 信息，在下次 AfterModel 写入 raw.jsonl
    this.pendingCompactBoundary = {
      summary: input.trigger ?? "auto",
      messageCountBefore: this.pairs.length,
      timestamp: input.timestamp,
    };

    // 重置增量计数器：压缩后 messages 数组会被截断重组
    this.prevMessageCount = 0;

    this.writer.appendEvent({
      event: HookEventName.PreCompact,
      session_id: input.session_id,
      timestamp: input.timestamp,
      cwd: input.cwd,
      data: { trigger: input.trigger },
    });
  }

  // ─── SubagentStart ───

  private handleSubagentStart(input: SubagentStartInput): void {
    if (!this.initialized) return;

    this.metadata.has_sub_agent = true;
    this.metadata.subagent_spans.push({
      agent_id: input.agent_id,
      agent_type: input.agent_type,
      start: input.timestamp,
    });

    this.writer.appendEvent({
      event: HookEventName.SubagentStart,
      session_id: input.session_id,
      timestamp: input.timestamp,
      cwd: input.cwd,
      data: {
        agent_id: input.agent_id,
        agent_type: input.agent_type,
        parent_session_id: input.parent_session_id,
      },
    });
  }

  // ─── SubagentStop ───

  private handleSubagentStop(input: HookInput): void {
    if (!this.initialized) return;

    // 找到最后一个未结束的 span，填入 end 时间
    for (let i = this.metadata.subagent_spans.length - 1; i >= 0; i--) {
      if (!this.metadata.subagent_spans[i].end) {
        this.metadata.subagent_spans[i].end = input.timestamp;
        break;
      }
    }

    this.writer.appendEvent({
      event: HookEventName.SubagentStop,
      session_id: input.session_id,
      timestamp: input.timestamp,
      cwd: input.cwd,
    });
  }

  // ─── SessionEnd ───

  private async handleSessionEnd(input: SessionEndInput): Promise<void> {
    if (!this.initialized) return;

    this.metadata.end_time = input.timestamp;
    this.metadata.end_source = input.reason;

    // 用 SessionState 统计值覆盖采集器自己累积的（SessionState 更准确）
    if (input.stats) {
      const s = input.stats;
      if (s.model) this.metadata.model = s.model;
      if (s.total_tokens_sent !== undefined) this.metadata.total_tokens_sent = s.total_tokens_sent;
      if (s.total_tokens_received !== undefined) this.metadata.total_tokens_received = s.total_tokens_received;
      if (s.total_cache_read_tokens !== undefined) this.metadata.total_cache_read_tokens = s.total_cache_read_tokens;
      if (s.total_cache_creation_tokens !== undefined) this.metadata.total_cache_creation_tokens = s.total_cache_creation_tokens;
      if (s.total_cost_usd !== undefined) this.metadata.total_cost_usd = s.total_cost_usd;
      if (s.total_api_calls !== undefined) this.metadata.total_api_calls = s.total_api_calls;
      if (s.tools_used) for (const t of s.tools_used) this.metadata.tools_used.add(t);
      if (s.files_edited) for (const f of s.files_edited) this.metadata.files_edited.add(f);
      if (s.has_thinking !== undefined) this.metadata.has_thinking = s.has_thinking;
    }

    // 推断 exit_status
    // reason 语义：
    //   exit/other → 看最后一次 stop_reason，end_turn 即正常结束，否则视为 user_interrupt
    //   clear → /clear 上下文清除
    //   abort → 用户主动 Ctrl-C 或外部 SIGTERM
    //   error → runtime 抛出异常（流式中断 / API 错误 / 上下文溢出兜底失败）
    const lastPair = this.pairs[this.pairs.length - 1];
    if (input.reason === "exit" || input.reason === "other") {
      this.metadata.exit_status = lastPair?.stop_reason === "end_turn"
        ? "end_turn"
        : "user_interrupt";
    } else {
      this.metadata.exit_status = input.reason;
    }

    // 错误退出时把错误信息也写入 metadata，便于 trajectory 诊断
    if (input.reason === "error" && input.error) {
      this.metadata.error = {
        message: input.error.message,
        name: input.error.name,
      };
    }

    // 把 Harness 汇总写入 metadata
    if (input.harness_summary) {
      this.metadata.harness = input.harness_summary;
    } else if (this.harnessEditCount > 0) {
      // 即使没有外部汇总，也把 collector 自己累积的编辑统计写入
      this.metadata.harness = {
        edit_stats: {
          total_edits: this.harnessEditCount,
          first_pass_success: this.harnessEditFirstPass,
          retry_count: 0,
          protocols_used: this.harnessProtocols,
        },
      };
    }

    // 最终写入 events.jsonl
    this.writer.appendEvent({
      event: HookEventName.SessionEnd,
      session_id: input.session_id,
      timestamp: input.timestamp,
      cwd: input.cwd,
      data: {
        reason: input.reason,
        exit_status: this.metadata.exit_status,
      },
    });

    // 最终重建 session.traj（确保包含所有数据）
    await this.rebuildTraj();

    // D3-1 + D3-3：退出时落 messages.json（完整消息历史 + 退出归因）。
    // 落实 CLAUDE.md 评测纪律不变量第 1 条「transcript 必落盘」到真实交互退出路径。
    // 尤其 abnormal / user_interrupt 退出时，此前只有 metadata.json 无法验尸。
    this.persistMessagesSnapshot(input);

    // 触发上传（有限等待）
    if (this.uploader) {
      try {
        const uploadPromise = this.uploader.uploadSession(
          this.writer.getSessionDir(),
          input.session_id,
        );
        // 最多等 10 秒，超时后上传继续在后台运行
        const result = await Promise.race([
          uploadPromise,
          new Promise<null>(resolve => setTimeout(() => resolve(null), 10_000)),
        ]);

        if (result === null) {
          getLogger().info("TRACE", "上传超时，任务将在后台继续或由重试队列处理");
        } else if (!result.allConfirmed) {
          getLogger().warn("TRACE", "部分文件上传失败，已加入重试队列");
        } else {
          getLogger().info("TRACE", "上传完成，本地文件已清理");
        }
      } catch (err: any) {
        getLogger().warn("TRACE", `上传异常: ${err.message}`);
      }
    }
  }

  // ─── 辅助：增量 messages 计算 ───

  /**
   * D3-1：把完整消息历史 + 退出归因落到 sessions/<id>/messages.json。
   *
   * 消息历史来源：最后一个 pair 的 raw_messages（发送给 LLM 前的完整历史，含全部
   * 历史轮次），再追加最后一次 response 的 content（assistant 回复），近似还原退出
   * 时刻 ctxMgr 的完整 messages。best-effort：失败只告警，不阻塞退出。
   */
  private persistMessagesSnapshot(input: SessionEndInput): void {
    try {
      const messages = this.reconstructMessages();

      // D3-3：崩溃自动归因摘要——abnormal 时一行根因，免去人工翻日志
      const attribution = this.buildExitAttribution(input, messages);

      // 把归因摘要也写进 metadata（D3-3），便于 trajectory 诊断不必另开 messages.json
      if (attribution.abnormal) {
        this.metadata.exit_attribution = attribution;
      }

      const snapshot = {
        kind: "messages-snapshot",
        session_id: input.session_id,
        reason: input.reason,
        exit_status: this.metadata.exit_status,
        timestamp: input.timestamp,
        attribution,
        message_count: messages.length,
        messages,
      };
      this.writer.writeMessagesSnapshot(snapshot);

      if (attribution.abnormal) {
        getLogger().warn(
          "TRACE",
          `异常退出已落 messages.json 验尸: ${attribution.summary}`,
        );
      }
    } catch (err: any) {
      getLogger().warn("TRACE", `落 messages.json 失败（不影响退出）: ${err?.message ?? err}`);
    }
  }

  /**
   * 从 pairs 还原退出时刻的完整消息历史。
   * 最后一个 pair 的 raw_messages 已含本轮发送前的全部历史；再补最后一次 assistant 回复。
   */
  private reconstructMessages(): Message[] {
    const lastPair = this.pairs[this.pairs.length - 1];
    if (!lastPair) return [];

    const base = (lastPair.request.raw_messages ?? lastPair.request.messages ?? []) as Message[];
    const messages: Message[] = Array.isArray(base) ? [...base] : [];

    // 补最后一次 response 的 assistant content（raw_messages 是"发送前"快照，不含本轮回复）
    const respContent = lastPair.response?.content as unknown[] | undefined;
    if (Array.isArray(respContent) && respContent.length > 0) {
      messages.push({ role: "assistant", content: respContent as Message["content"] });
    }
    return messages;
  }

  /**
   * D3-3：构建退出归因。abnormal 时给出错误类型 / 最后工具 / 步数 / 是否孤儿。
   */
  private buildExitAttribution(input: SessionEndInput, messages: Message[]): {
    abnormal: boolean;
    summary: string;
    reason: string;
    exit_status: string;
    api_calls: number;
    last_tool: string | null;
    has_orphan_tool_use: boolean;
    error_name?: string;
  } {
    const exitStatus = String(this.metadata.exit_status ?? "");
    const abnormal =
      input.reason === "error" ||
      input.reason === "abort" ||
      exitStatus === "user_interrupt" ||
      exitStatus === "error" ||
      exitStatus === "abort";

    // 最后一个被调用的工具名（从消息历史里找最后一个 tool_use）
    let lastTool: string | null = null;
    for (let i = messages.length - 1; i >= 0 && !lastTool; i--) {
      const c = messages[i]?.content;
      if (!Array.isArray(c)) continue;
      for (let j = c.length - 1; j >= 0; j--) {
        const b = c[j];
        if (b.type === "tool_use") { lastTool = b.name; break; }
      }
    }

    const orphan = checkMessageHistoryIntegrity(messages).orphans.length > 0;
    const errName = this.metadata.error?.name;

    const summaryParts = [
      `reason=${input.reason}`,
      `exit=${exitStatus}`,
      `api_calls=${this.metadata.total_api_calls}`,
      `last_tool=${lastTool ?? "none"}`,
      `orphan_tool_use=${orphan}`,
    ];
    if (errName) summaryParts.push(`error=${errName}`);

    return {
      abnormal,
      summary: summaryParts.join(" "),
      reason: String(input.reason),
      exit_status: exitStatus,
      api_calls: this.metadata.total_api_calls,
      last_tool: lastTool,
      has_orphan_tool_use: orphan,
      ...(errName ? { error_name: errName } : {}),
    };
  }

  // ─── 辅助：增量 messages 计算 ───
  /**
   * 计算本次请求相对于上次请求新增的 messages
   * 处理压缩边界（压缩后 messages 数组截断重组）
   */
  computeNewMessages(messages: unknown[]): unknown[] {
    if (this.pairs.length === 0 && this.prevMessageCount === 0) {
      // 首次请求，全部都是新的
      this.prevMessageCount = messages.length;
      return messages;
    }

    if (messages.length < this.prevMessageCount) {
      // 压缩发生了：messages 被截断重组，旧计数失效，视为全量
      this.prevMessageCount = messages.length;
      return messages;
    }

    const newMsgs = messages.slice(this.prevMessageCount);
    this.prevMessageCount = messages.length;
    return newMsgs;
  }

  // ─── 辅助：重建 session.traj ───

  private async rebuildTraj(): Promise<void> {
    try {
      const traj = buildTrajectory(this.pairs, this.metadata);
      await this.writer.writeTraj(traj);
    } catch (err) {
      getLogger().warn("TRACE", `重建 session.traj 失败: ${err}`);
    }
  }

  // ─── 辅助：pair → RawJsonlEntry（不含 raw_messages） ───

  private toRawJsonlEntry(pair: RequestResponsePair): RawJsonlEntry {
    const { raw_messages: _rm, ...requestWithoutRaw } = pair.request;
    // 纳入待写入的 compact_boundary（如果有）
    const compactBoundary = this.pendingCompactBoundary;
    this.pendingCompactBoundary = undefined;
    return {
      timestamp: pair.timestamp,
      index: pair.index,
      model: pair.model,
      request: requestWithoutRaw,
      response: pair.response,
      usage: pair.usage,
      stop_reason: pair.stop_reason,
      is_partial: pair.is_partial,
      ...(compactBoundary ? { compact_boundary: compactBoundary } : {}),
    };
  }

  // ─── 供测试访问的只读属性 ───

  /** 当前累积的 pairs（供测试检查） */
  getPairs(): RequestResponsePair[] {
    return this.pairs;
  }

  /** 当前会话元数据（供测试检查） */
  getMetadata(): TraceMetadata | undefined {
    return this.initialized ? this.metadata : undefined;
  }

  /** 当前 prevMessageCount（供测试检查增量逻辑） */
  getPrevMessageCount(): number {
    return this.prevMessageCount;
  }
}
