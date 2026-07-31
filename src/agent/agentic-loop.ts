/**
 * AgenticLoop — 共享的 Agent 循环核心
 *
 * 对标 claude-code 的 runAgent()，使子代理和主代理共享同一套循环逻辑。
 * 从 executeInner() 提取，消除与 AgentLoopRunner.run() 之间的代码重复。
 *
 * M5 里程碑：子代理独立 Agent Loop
 */

import type { Provider } from "../llm/provider.ts";
import type { ContentBlock, Usage, SendParams } from "../llm/types.ts";
import { accumulateUsage, normalizeCacheUsage } from "../llm/types.ts";
import { Manager as ContextManager } from "../context/manager.ts";
import { Registry as ToolRegistry } from "../tool/registry.ts";
import { getLogger } from "../debug/logger.ts";
import { emitStreamPhase, clearStreamSnapshot } from "../trace/stream-observer.ts";
import type { HookSystem } from "../hook/system.ts";
import { LoopDetector, LOOP_RECOVERY_PROMPT } from "./loop-detection.ts";
import { processStream, type StreamProcessResult } from "./stream-processor.ts";
import {
  AGENT_STREAM_TIMEOUT_REASON,
  classifyError,
  classifyStreamError,
  isInternalTimeoutAbortReason,
  RetryableError,
  TerminalError,
} from "../llm/errors.ts";
import { calculateRetryDelay, MAX_DELAY_MS as RETRY_MAX_DELAY_MS } from "../llm/retry-backoff.ts";
import { resolveLoopTimeouts } from "../config/network-profile.ts";
import { executeTools } from "./tool-executor.ts";
import { isEmptyToolInput, toolHasRequiredParams } from "../query/empty-param.ts";

// ============================================================
// 配置接口
// ============================================================

/** Agent 循环配置 */
export interface AgentLoopConfig {
  /** LLM Provider */
  provider: Provider;
  /** 模型名称 */
  model: string;
  /** 上下文管理器（系统提示词和首条用户消息已预先填充） */
  ctxMgr: ContextManager;
  /** 工具注册表（已过滤） */
  tools: ToolRegistry;
  /** 最大轮次 */
  maxTurns: number;
  /** 中止信号 */
  signal: AbortSignal;
  /** 循环检测器（外部创建，便于生命周期控制） */
  loopDetector: LoopDetector;
  /** 流式文本回调（用于 TUI 实时显示） */
  onStreamText?: (text: string) => void;
  /** 每轮开始前的回调（用于 SendMessage 注入等） */
  onBeforeTurn?: (turn: number) => void;
  /** 每轮结束后的回调（含本轮文本和工具信息，用于磁盘输出 + 进度追踪） */
  onTurnEnd?: (info: {
    turn: number;
    /** 本轮文本输出（完整内容） */
    textOutput: string;
    /** 本轮工具调用信息 */
    tools: Array<{ name: string; input: Record<string, unknown> }>;
    /** 截至本轮的累计真实 token 数（input + output，来自 totalUsage），供进度面板展示 */
    tokenCount: number;
    /** 截至本轮的累计工具调用次数 */
    toolUseCount: number;
  }) => void;
  /** 循环恢复提示词（默认使用全局 LOOP_RECOVERY_PROMPT） */
  loopRecoveryPrompt?: string;
  /** LLM 请求额外参数 */
  sendParamsExtra?: Partial<SendParams>;
  /** Hook 系统（透传给工具执行，驱动子代理工具的 Pre/PostToolUse hook 与 execute_tool span）。
   *  缺省时工具执行不触发 hook（兼容无 hook 环境/测试）。 */
  hookSystem?: HookSystem;
  /** 权限检查器（子代理用 dontAsk 语义：危险命令拦截 + safetyCheck 照常生效，ask→deny）。
   *  缺省时不做权限检查（兼容旧测试 / 纯只读子代理）。 */
  permissionChecker?: import("../permission/types.ts").Checker;
  /** GAP-07（子代理侧）：长跑工具中间进度回调。缺省时工具执行无进度上报（无副作用）。 */
  onToolProgress?: import("./tool-executor.ts").SubAgentToolProgress;
  /** H9：模型可用性服务（与主 fallback 引擎共享同一实例，来自 ProviderRegistry.availability）。
   *  子代理遇 terminal 类错误（认证失败 / 模型不存在 / 内容策略）时 markTerminal，让拉黑状态跨
   *  主路径/子代理/side-call 共享——避免同一坏模型下次子代理再选它撞一次。缺省时不做拉黑（兼容
   *  无 registry 的旧测试）。 */
  availability?: import("../llm/availability.ts").ModelAvailabilityService;
  /**
   * P2-1：JIT 上下文发现（子代理侧）。
   *
   * 子代理此前完全不走 JIT —— 读写 `src/ui/` 下文件时拿不到该目录规范，
   * 而子代理恰恰是「被派去改某个具体模块」的高频场景，正是最需要目录规则的地方。
   *
   * **必须是独立实例，不能共享主代理的 JitContextManager**（对齐 CC 为 forked agent
   * 分配独立 `loadedNestedMemoryPaths` 的做法）：子代理有自己的上下文窗口，
   * 父代理注入过不代表子代理上下文里有；共享去重集会让父加载过的规则子代理**永远**
   * 拿不到 —— 比不接 JIT 更糟（看起来接了，实际静默失效）。
   *
   * 与主路径同为 fire-and-forget（返回 void）：产物给下一轮用，await 会算进 TTFT。
   * 缺省时子代理不走 JIT（兼容旧测试 / 纯计算型子代理）。
   */
  discoverJitContext?: (toolBlocks: Array<{ name: string; input: unknown }>) => void;
  /**
   * R1：单轮 LLM 调用的最大重试次数（限流 / 过载 / 网络抖动等可重试错误）。
   *
   * 缺省走 network-profile 的 maxTimeoutRetries（当前 10），与主循环同源——
   * 改 settings.network.maxTimeoutRetries 或 SID_CODE_MAX_TIMEOUT_RETRIES 一处生效，
   * 不在此另立平行常量（fallback.ts 顶部注释记录过「两阶段各自维护上限架空统一配置」的同型事故）。
   * 测试可传 0 显式关闭重试。
   */
  maxStreamRetries?: number;
  /** R1：退避基数（毫秒）。缺省走 network-profile 的 retryBackoffBaseMs（当前 5s）。 */
  retryBackoffBaseMs?: number;
  /** R1：退避上限（毫秒）。缺省走 network-profile 的 retryBackoffMaxMs（当前 120s）。 */
  retryBackoffMaxMs?: number;
}

/** Agent 循环结果 */
export interface AgentLoopResult {
  success: boolean;
  turns: number;
  totalUsage: Usage;
  toolUseCount: number;
  /** 最后一轮的文本输出 */
  lastTextOutput: string;
  /** 累积的上下文消息 */
  messages: Array<{ role: string; content: ContentBlock[] }>;
  /** 失败时携带的错误消息 */
  errorMessage?: string;
}

// ============================================================
// 内部工具
// ============================================================

/**
 * 可中断的 sleep（用于重试退避）。
 *
 * signal abort 时立即 reject，不等满延迟——否则用户 ESC 后还要干等最长 120s 才响应，
 * 而退避恰恰是延迟最长的环节。已 abort 的 signal 直接 reject（不进定时器）。
 */
function sleepWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error("aborted"));
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

// ============================================================
// 核心循环函数
// ============================================================

/**
 * 运行 Agent 循环核心
 *
 * 处理 LLM 流式响应、工具调用、循环检测的标准模式。
 * 调用方负责：创建 ctxMgr（含 system prompt 和首条 user 消息）、
 * 创建 tools（已过滤）、创建 loopDetector（生命周期控制）。
 *
 * 对标 claude-code runAgent()，一个函数同时服务于主 Agent 和子 Agent。
 */
export async function runAgentLoop(config: AgentLoopConfig): Promise<AgentLoopResult> {
  const log = getLogger();
  const {
    provider, model, ctxMgr, tools, maxTurns, signal, loopDetector,
    loopRecoveryPrompt = LOOP_RECOVERY_PROMPT,
    availability,
  } = config;

  let turns = 0;
  let toolUseCount = 0;
  let lastTextOutput = "";
  let unknownStopWarning: string | undefined;

  // LSP 诊断注入所需状态（子代理侧补齐，对标主循环 G1）。
  // hasEditCapability：能力对齐门控——只有具备 edit/write 工具的子代理才注入诊断。
  //   纯只读子代理（如 explore/summarize）不会被诊断噪音打扰。这比 CC 的"有 Bash 才注入"
  //   更贴合本意：诊断是给"能改代码的 agent"看的，而本项目靠 edit/write 修复诊断、不依赖 bash。
  // editedFiles：本子代理累计编辑过的文件绝对路径，作为诊断收集的作用域——并发子代理共用
  //   全局 registry，各自只消费自己编辑文件的诊断，互不偷取（作用域消费 + 作用域清空）。
  const hasEditCapability = !!(tools.get("edit") || tools.get("write"));
  const editedFiles = new Set<string>();

  const totalUsage: Usage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  };

  // R1：重试/退避参数走 resolveLoopTimeouts（env > settings > 统一默认值），与主循环同源。
  // SubAgent 不持有 Config 对象，直接读 DEFAULTS 会让 env 覆盖对子代理静默失效——
  // 那就成了「看起来接了统一配置，实际只有主路径生效」的半接线状态。
  // 在轮次循环外解析一次即可（同一子代理生命周期内配置不变）。
  const netTimeouts = resolveLoopTimeouts({});

  while (turns < maxTurns) {
    turns++;
    log.debug("AGENT_LOOP", `轮次 ${turns}/${maxTurns}`);

    // 每轮开始前的回调（SendMessage 注入等）
    config.onBeforeTurn?.(turns);

    // LSP 诊断注入（子代理侧补齐，对标主循环 query/loop.ts 的 G1）。
    // 上一轮若编辑过文件，此处收集这些文件的实时诊断注入为 user 消息，让子代理感知
    // 自己编辑引入的类型/语法错误。作用域限定为本子代理编辑过的文件（editedFiles），
    // 避免与主循环 / 并发子代理互相偷取全局 registry 里的 pending 诊断。
    // ctxMgr.addMessage 会自动合并连续同角色消息，注入 user 消息不破坏角色交替。
    // 收集即消费（作用域清空），故无需额外去重——同一诊断不会重复注入。
    if (hasEditCapability && editedFiles.size > 0) {
      try {
        const { collectDiagnosticText } = await import("../lsp/manager.ts");
        const diagnosticText = collectDiagnosticText(editedFiles);
        if (diagnosticText) {
          ctxMgr.addMessage({
            role: "user",
            content: [{
              type: "text",
              text:
                `# LSP 诊断（来自语言服务器的实时反馈）\n\n${diagnosticText}\n\n` +
                `以上是语言服务器对你刚编辑文件的实时分析结果。请关注其中的 Error / Warning，` +
                `在后续工作中修复这些问题；若与当前任务无关可暂不处理，但不要无视真实的类型/语法错误。`,
            }],
          });
          log.info("AGENT_LOOP", "注入 LSP 诊断反馈（子代理）");
        }
      } catch { /* LSP 未启用 / 收集失败：降级不注入，绝不影响子代理循环 */ }
    }

    const toolDefs = tools.size() > 0 ? tools.definitions() : undefined;

    // 发给 LLM 的消息走 getCleanedMessages()（对标 cc：所有循环共用压缩管道）。
    // 子代理是 token 消耗大户（大量 read/grep/bash），此前裸发 getMessages() 完全没有
    // 工具输出剪枝/遮罩，input token 线性膨胀。getCleanedMessages 提供：大输出剪枝
    // （零依赖纯内存）+ observation masking（构造时传了 sessionId 才启用）。
    // 注意：仅"发给 LLM"这一处换；返回给调用方的 AgentLoopResult.messages 仍用
    // getMessages()（内部逻辑/最终产物需要完整历史，不能是清理后的视图）。
    const sendParams: SendParams = {
      model,
      messages: ctxMgr.getCleanedMessages(),
      system: ctxMgr.getSystemPrompt(),
      maxTokens: 4096,
      tools: toolDefs,
      ...config.sendParamsExtra,
    };

    // T13.1：子代理 LLM 调用 StreamPhase 事件（fetch_sent）
    const agentStreamIndex = 10000 + turns;
    const turnStartTime = Date.now();

    // ══════════════════════════════════════════════════════════════════
    // R1：子代理 LLM 调用重试 + 指数退避
    //
    // 事故 20260730-183103-5e334145：子代理走 provider.sendMessageStream() 直连，
    // **完全绕过** ModelFallback —— 而重试/退避逻辑当时只存在于 fallback 内部。
    // 结果一次 429 就让子代理立即失败：轨迹里 429（10:35:24.586）到 SubagentStop
    // status=error（.588）间隔 1ms，零重试。6 个并行子代理 2 个因此失败，
    // 而主循环遇同样的 429 会重试到成功——同一模型、同一网关，两条路径行为割裂。
    //
    // 这里补齐重试，两个关键点：
    //  ① 429 不是抛异常，而是以流内 error 事件回来（stream-processor 转成
    //     stopReason="error"）。所以**两条失败路径都要接**：throw 的走 catch，
    //     stopReason="error" 的走下方显式检查——只补 catch 会完全漏掉真实的限流场景。
    //  ② 退避延迟复用 retry-backoff.ts（与主路径同一实现），尊重服务端
    //     Retry-After / rate-limit-reset header，限流用单向正抖动避免早于服务端最小间隔。
    //
    // 重试是安全的：本轮 assistant 消息在流成功**之后**才 addMessage，
    // 失败重试不会把半截响应留在 ctxMgr 里（sendParams.messages 每次取同一份快照）。
    // ══════════════════════════════════════════════════════════════════
    const streamMaxRetries = config.maxStreamRetries ?? netTimeouts.maxTimeoutRetries;
    let response: StreamProcessResult | undefined;
    let failureResult: AgentLoopResult | undefined;

    for (let attempt = 0; ; attempt++) {
      // T4：per-turn AbortController，与父 signal 合并后传给上游流。
      // 让 processStream 的心跳/整体超时在触发时能主动 abort 上游（而非仅靠外层
      // 5min Promise.race——它在 Bun 事件循环阻塞时可能延迟数分钟才 fire）。
      // 注意：必须每次重试**新建**，abort 过的 controller 不可复用（否则重试的流
      // 一建立就被已 abort 的 signal 立即掐断）。
      const turnAbort = new AbortController();
      const combinedSignal = AbortSignal.any([signal, turnAbort.signal]);

      emitStreamPhase(agentStreamIndex, "fetch_sent", { caller: "sub-agent", model, attempt });

      // B2: 子代理硬超时保护（对齐主循环 L1），作为 T4 setInterval 心跳之上的最后兜底
      const AGENT_STREAM_TIMEOUT_MS = 5 * 60 * 1000; // 5min
      let agentTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
      const timeoutPromise = new Promise<StreamProcessResult>((_, reject) => {
        agentTimeoutTimer = setTimeout(() => {
          // H10：超时改用带 reason 的 abort，而非裸 Error。turnAbort 被 abort 后：
          //  ① 上游 fetch/SSE reader 以裸字符串 AGENT_STREAM_TIMEOUT_REASON reject——已登记
          //     ABORT_REASONS，被 isAbortError 识别为「中断」而非真故障，杜绝孤儿 rejection 崩溃；
          //  ② 该 reason 属 INTERNAL_TIMEOUT_ABORT_REASONS，据此可与「用户取消」区分：
          //     内部超时可重试，用户取消必须立即停（见下方 catch 的归因分支）；
          //  ③ processStream 感知 turnAbort → 抛 abort 错误，与本 reject 竞争，无论谁赢，
          //     catch 分支都据 signal.reason 归因，不再依赖易被覆盖的错误消息文本。
          try { turnAbort.abort(AGENT_STREAM_TIMEOUT_REASON); } catch { /* 幂等 */ }
          reject(new Error(`子代理流式超时：${AGENT_STREAM_TIMEOUT_MS / 1000}s 无响应`));
        }, AGENT_STREAM_TIMEOUT_MS);
      });

      // 处理流式响应（T4：传入心跳 + 整体超时 + turnAbort 引用）
      let attemptError: unknown;
      let attemptResponse: StreamProcessResult | undefined;
      try {
        const stream = provider.sendMessageStream(sendParams, combinedSignal);
        attemptResponse = await Promise.race([
          processStream(stream, {
            signal: combinedSignal,
            getAbortController: () => turnAbort,
          }),
          timeoutPromise,
        ]);
        // 正常 settle：清超时定时器，避免 5min 后无谓 fire + 阻止进程退出。
        if (agentTimeoutTimer !== null) clearTimeout(agentTimeoutTimer);
      } catch (err: any) {
        if (agentTimeoutTimer !== null) clearTimeout(agentTimeoutTimer);
        attemptError = err;
      }

      // ── 归一化：把「抛异常」与「stopReason=error」两条失败路径合并成同一个 err ──
      // 真实的 429 走后者（provider 以流内 error 事件上报），只判前者会完全漏掉限流。
      let failure: unknown = attemptError;
      // 流内 error 的结构化字段（type/statusCode/streamLevel），用于下方精确分类。
      let failureMeta: { type?: string; statusCode?: number; streamLevel?: boolean } | undefined;
      if (!failure && attemptResponse?.stopReason === "error") {
        failure = new Error(attemptResponse.errorMessage || "LLM 错误");
        failureMeta = attemptResponse.errorMeta;
      }

      if (!failure) {
        // T13.1：子代理 LLM 调用完成
        emitStreamPhase(agentStreamIndex, "completed", {
          caller: "sub-agent", model, elapsed_ms: Date.now() - turnStartTime,
        });
        response = attemptResponse;
        break;
      }

      // R1：失败 attempt 的 token 也要计入。
      // 服务端对**已产出**的 token 是照常计费的：message_start 已带 inputTokens，
      // 中断前的 message_delta 已带 outputTokens。只累加成功那次会让「重试 N 次后成功」
      // 的真实消耗被静默吞掉 N-1 份，直接体现为「网关账单 > 本地 traj 统计」。
      // 放在这里（失败分支）而非成功分支：成功那次由下方 line 503 统一累加，不能重复计。
      if (attemptResponse?.usage) accumulateUsage(totalUsage, attemptResponse.usage);

      const errMessage = (failure as any)?.message ?? String(failure);
      // T13.1：子代理 LLM 调用失败
      emitStreamPhase(agentStreamIndex, "error", {
        caller: "sub-agent", model, error: errMessage, attempt,
        elapsed_ms: Date.now() - turnStartTime,
      });

      // H9：terminal 类错误（认证失败 / 模型不存在 / 内容策略 / invalid_request）跨路径共享拉黑——
      // 与主 fallback 引擎共用同一 availability 实例，markTerminal 后主路径/其它子代理/side-call
      // 下次都不再选这个坏模型，不必各自再撞一次。仅对 classifyError 判定为 TerminalError 的才拉黑；
      // 超时/abort/限流等非 terminal 错误不动 availability（它们可重试，拉黑会误伤）。
      let classified: TerminalError | RetryableError | Error;
      try {
        // 流内 error（streamLevel）走 classifyStreamError——与主路径 fallback.ts:583-589 同一判据。
        // 关键：OpenAI 族流内 error 的 message 常无关键词，判定全靠 error.type/code
        // （openai.ts:1644-1646）。这里若退回 classifyError(new Error(msg)) 按文本猜，
        // 形如 type=rate_limit_error 但 message 无 "429" 的限流会被判成不可重试的普通
        // Error → 该重试的不重试，等于 R1 白做。errorMeta 缺失时（抛异常路径）才用 classifyError。
        classified = failureMeta?.streamLevel
          ? classifyStreamError(
              model.split(":")[0] || model,
              errMessage,
              failureMeta.type,
              failureMeta.statusCode,
            )
          : classifyError(failure);
      } catch {
        classified = failure instanceof Error ? failure : new Error(errMessage);
      }
      try {
        if (availability && classified instanceof TerminalError) {
          availability.markTerminal(model, classified.message);
          log.warn("AGENT_LOOP", `子代理模型 ${model} 判定 terminal（${classified.message}），已跨路径拉黑`);
        }
      } catch { /* 分类失败不影响错误返回 */ }

      // ── 是否重试 ──
      // 用户主动取消（父 signal abort 且非内部超时自愈）：立即停，不重试也不退避。
      const userCancelled =
        signal.aborted && !isInternalTimeoutAbortReason((signal as any).reason);
      const retryable = classified instanceof RetryableError ? classified : undefined;
      const canRetry = !!retryable && !userCancelled && attempt < streamMaxRetries;

      if (!canRetry) {
        if (retryable && !userCancelled) {
          log.error("AGENT_LOOP", `流式重试 ${attempt} 次仍失败（${retryable.reason}），放弃: ${errMessage}`);
        } else {
          log.error("AGENT_LOOP", `流式处理异常: ${errMessage}`);
        }
        failureResult = {
          success: false,
          turns,
          totalUsage,
          toolUseCount,
          lastTextOutput,
          messages: ctxMgr.getMessages(),
          errorMessage: errMessage || "流式处理超时",
        };
        break;
      }

      // 退避后重试。延迟走与主路径同一份 retry-backoff（尊重服务端 Retry-After /
      // rate-limit-reset，限流用单向正抖动，避免早于服务端最小间隔再撞一次）。
      const delayMs = calculateRetryDelay(failure, attempt, classified, {
        maxDelayMs: RETRY_MAX_DELAY_MS,
        retryBackoffBaseMs: config.retryBackoffBaseMs ?? netTimeouts.retryBackoffBaseMs,
        retryBackoffMaxMs: config.retryBackoffMaxMs ?? netTimeouts.retryBackoffMaxMs,
      });
      log.warn(
        "AGENT_LOOP",
        `子代理 LLM 失败（${retryable.reason}），${delayMs}ms 后重试 ` +
        `${attempt + 1}/${streamMaxRetries}: ${errMessage.slice(0, 200)}`,
      );
      try {
        await sleepWithAbort(delayMs, signal);
        // 重试前清除本轮旧快照（对齐主循环 query/loop.ts:2046 的 Fix 2）。
        // 快照按 loopId:index 为 key，本轮重试共用同一 agentStreamIndex，不清就会把
        // 上一次失败的 lastContentProgressAt / chunksReceived 留给下一次：
        //  ① openai.ts 的 idle/header 看门狗读到过期的「最近进展时刻」→ 可能立即误杀新流；
        //  ② collector.ts 的 ModelCallUnpaired 配对检查读到脏 chunk 计数 → 把「慢但活着」
        //     与「已死」判反（see collector.ts:687-695 的 still_progressing 判据）。
        clearStreamSnapshot(agentStreamIndex);
      } catch {
        // 退避期间被中断（用户 ESC / 父 signal abort）：不再重试，按中断返回。
        failureResult = {
          success: false,
          turns,
          totalUsage,
          toolUseCount,
          lastTextOutput,
          messages: ctxMgr.getMessages(),
          errorMessage: errMessage || "重试退避期间被中断",
        };
        break;
      }
    }

    if (failureResult) return failureResult;
    if (!response) {
      // 理论不可达（上面两条出口必有其一），留兜底避免后续裸用 response。
      return {
        success: false,
        turns,
        totalUsage,
        toolUseCount,
        lastTextOutput,
        messages: ctxMgr.getMessages(),
        errorMessage: "流式处理未返回结果",
      };
    }

    if (config.onStreamText) {
      const responseText = response.content
        .filter(b => b.type === "text")
        .map(b => b.type === "text" ? b.text : "")
        .join("");
      if (responseText) config.onStreamText(responseText);
    }

    // LLM API 错误：返回失败（不 throw，由调用方转换为状态变更）。
    // R1 之后此分支正常不可达——stopReason="error" 已在上方重试循环里被归一化成 failure
    // 并重试/放弃。保留为安全网：若将来有人在循环里新增 break 路径而漏判 error，
    // 这里仍会兜住，不至于把错误响应当成功继续跑工具。
    if (response.stopReason === "error") {
      log.error("AGENT_LOOP", `LLM 错误: ${response.errorMessage}`);
      return {
        success: false,
        turns,
        totalUsage,
        toolUseCount,
        lastTextOutput,
        messages: ctxMgr.getMessages(),
        errorMessage: response.errorMessage || "LLM 错误",
      };
    }

    // H9：空响应校验（对齐主/降级路径 fallback.ts 的 hasYieldedContent 兜底）。
    // 背景：子代理默认复用主 provider（常为同一网关），网关返回 text/html 错误页或空流时，
    // processStream 会给出「stopReason 非 error、但 content 为空」的伪成功——子代理若直接透传，
    // 会误判「完成但无输出」返回空结果给主代理（事故 session 20260708-102143 同型）。
    // 判据：本轮既无任何 content block、又非因 max_tokens 截断（截断是合法的「有产出但被切」）。
    const hasAnyContent = response.content.length > 0;
    if (!hasAnyContent && response.stopReason !== "max_tokens") {
      log.error("AGENT_LOOP", `子代理收到空响应（0 内容块，stopReason=${response.stopReason}），判定失败`);
      return {
        success: false,
        turns,
        totalUsage,
        toolUseCount,
        lastTextOutput,
        messages: ctxMgr.getMessages(),
        errorMessage: `子代理收到空响应（0 内容块，疑似网关返回非流式错误页或模型不可用）`,
      };
    }

    // 累加本轮 usage（统一走 accumulateUsage，补齐 cacheRead/cacheCreation 字段；
    // response.usage 已是本轮 processStream 累加好的完整 usage）
    accumulateUsage(totalUsage, response.usage);

    // P1-6/P1-7：用真实 usage 校准子代理上下文估算器（防 compact 触发过晚 → 溢出）
    try {
      const norm = normalizeCacheUsage(response.usage, provider.name());
      ctxMgr.recordActualTokens(norm.promptTotal, tools.size());
    } catch { /* 校准失败不影响子代理循环 */ }

    // 提取文本输出
    const textBlocks = response.content.filter(b => b.type === "text");
    if (textBlocks.length > 0) {
      lastTextOutput = textBlocks
        .map(b => b.type === "text" ? b.text : "")
        .join("\n");
    }

    // 添加助手消息到历史
    ctxMgr.addMessage({ role: "assistant", content: response.content });

    // 内容循环检测
    if (lastTextOutput && loopDetector.recordContent(lastTextOutput)) {
      if (!loopDetector.tryRecover()) {
        log.warn("AGENT_LOOP", "内容循环恢复次数耗尽，终止");
        return {
          success: false,
          turns,
          totalUsage,
          toolUseCount,
          lastTextOutput,
          messages: ctxMgr.getMessages(),
          errorMessage: "内容循环恢复次数耗尽",
        };
      }
      log.info("AGENT_LOOP", "检测到内容循环，注入恢复提示");
      ctxMgr.addMessage({
        role: "user",
        content: [{ type: "text", text: loopRecoveryPrompt }],
      });
      continue;
    }

    // 停止原因处理
    if (response.stopReason === "end_turn" || response.stopReason === "stop") {
      log.info("AGENT_LOOP", `完成，共 ${turns} 轮`);
      config.onTurnEnd?.({ turn: turns, textOutput: lastTextOutput, tools: [], tokenCount: totalUsage.inputTokens + totalUsage.outputTokens, toolUseCount });
      return {
        success: true,
        turns,
        totalUsage,
        toolUseCount,
        lastTextOutput,
        messages: ctxMgr.getMessages(),
      };
    }

    // 工具调用
    if (response.stopReason === "tool_use") {
      // 工具调用循环检测
      let loopDetected = false;
      for (const block of response.content) {
        if (block.type === "tool_use") {
          if (loopDetector.recordToolCall(block.name, block.input)) {
            loopDetected = true;
            break;
          }
        }
      }
      if (loopDetected) {
        if (!loopDetector.tryRecover()) {
          log.warn("AGENT_LOOP", "工具循环恢复次数耗尽，终止");
          return {
            success: false,
            turns,
            totalUsage,
            toolUseCount,
            lastTextOutput,
            messages: ctxMgr.getMessages(),
            errorMessage: "工具循环恢复次数耗尽",
          };
        }
        log.info("AGENT_LOOP", "检测到工具循环，注入恢复提示");
        ctxMgr.addMessage({
          role: "user",
          content: [{ type: "text", text: loopRecoveryPrompt }],
        });
        continue;
      }

      // 统计工具调用次数
      const toolUseBlocks = response.content.filter(b => b.type === "tool_use");
      toolUseCount += toolUseBlocks.length;

      // 空参数检测（对标主循环 F1）：弱模型退化时输出 input={} 的 tool_use，
      // 直接执行会报参数缺失错误，浪费工具执行 token。检测到后替换为错误提示让模型重试。
      const emptyParamBlocks = toolUseBlocks.filter(b => {
        if (b.type !== "tool_use") return false;
        if (!isEmptyToolInput(b.input)) return false;
        const schema = tools.get(b.name)?.inputSchema?.();
        return toolHasRequiredParams(schema);
      });
      if (emptyParamBlocks.length > 0) {
        log.warn("AGENT_LOOP", `检测到 ${emptyParamBlocks.length} 个空参数 tool_use，注入重试提示`);
        // 构造 tool_result 错误响应 + 重试提示
        const errorResults: ContentBlock[] = emptyParamBlocks.map(b => ({
          type: "tool_result" as const,
          tool_use_id: (b as { type: "tool_use"; id: string }).id,
          content: "错误：工具参数为空。请检查工具定义，提供完整的必需参数后重新调用。",
          is_error: true,
        }));
        ctxMgr.addMessage({ role: "user", content: errorResults });
        continue;
      }

      // 执行工具
      const toolResults = await executeTools(response.content, tools, signal, config.hookSystem, config.permissionChecker, config.onToolProgress);
      ctxMgr.addMessage({ role: "user", content: toolResults });

      // P2-1：JIT 上下文发现（子代理侧，独立实例）。放在 addMessage 之后、
      // 与主路径同一位置语义：本轮工具已产出结果，发现的规则供**下一轮**请求携带。
      // 不 await（fire-and-forget），读盘不进本轮关键路径。
      if (config.discoverJitContext) {
        config.discoverJitContext(
          toolUseBlocks
            .filter((b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use")
            .map((b) => ({ name: b.name, input: b.input })),
        );
      }

      // 记录本轮编辑过的文件（供下一轮 LSP 诊断注入的作用域）。仅当具备编辑能力时才收集，
      // 与注入门控保持一致。tool_result 的 is_error 判定成功——失败的编辑不纳入诊断作用域。
      if (hasEditCapability) {
        for (const b of toolUseBlocks) {
          if (b.type !== "tool_use") continue;
          if (b.name !== "edit" && b.name !== "write") continue;
          const resultBlock = toolResults.find(
            (r) => r.type === "tool_result" && r.tool_use_id === b.id,
          );
          if (resultBlock && resultBlock.type === "tool_result" && resultBlock.is_error) continue;
          const input = b.input as Record<string, unknown>;
          const p = (input?.file_path ?? input?.path) as string | undefined;
          if (p) editedFiles.add(p);
        }
      }

      // 每轮结束回调（进度追踪 + 磁盘输出）
      const turnToolInfo = toolUseBlocks.map(b => ({
        name: b.type === "tool_use" ? b.name : "",
        input: b.type === "tool_use" ? (b.input as Record<string, unknown>) : {},
      }));
      config.onTurnEnd?.({ turn: turns, textOutput: lastTextOutput, tools: turnToolInfo, tokenCount: totalUsage.inputTokens + totalUsage.outputTokens, toolUseCount });

      continue;
    }

    // max_tokens 续写
    if (response.stopReason === "max_tokens" || response.stopReason === "length") {
      log.info("AGENT_LOOP", `输出达到 token 上限，自动续写 (轮次 ${turns})`);
      config.onTurnEnd?.({ turn: turns, textOutput: lastTextOutput, tools: [], tokenCount: totalUsage.inputTokens + totalUsage.outputTokens, toolUseCount });
      continue;
    }

    // 其他未知停止原因（含 null）
    // 背景（事故复盘 session 20260708-102143）：伪装成功的空流（网关对不可用模型
    // 回 200 + text/html 错误页，被解析成 0 事件）会让 stopReason=null 且 content 为空。
    // 此前本分支直接 break 落到"强制总结"路径，把空响应当成正常收尾返回给父级——
    // 掩盖真实故障。现在区分：空响应 → success:false 显式报错（对齐上方 stopReason==="error"
    // 的返回模式，让父级 loop 能如实呈现）；非空但停止原因未识别 → 保留原 break（内容已在
    // lastTextOutput 中，交给下方强制总结收尾）。
    if (response.content.length === 0) {
      log.error(
        "AGENT_LOOP",
        `空响应且停止原因异常（stopReason=${response.stopReason}），判定为伪装成功的空流，子代理中断`,
      );
      return {
        success: false,
        turns,
        totalUsage,
        toolUseCount,
        lastTextOutput,
        messages: ctxMgr.getMessages(),
        errorMessage: `模型返回空响应（停止原因: ${response.stopReason ?? "null"}），疑似模型不可用或网关返回非流式错误页`,
      };
    }
    // 非空响应但停止原因未识别（罕见，可能是新协议字段）：内容已在 lastTextOutput 中，
    // 交给下方强制总结收尾。但必须设 errorMessage 让父级感知"异常收尾"——此前只 log.warn
    // 就 break，父级（sub-agent.ts）无法区分"正常完成"和"异常停止"。
    log.warn("AGENT_LOOP", `未知停止原因: ${response.stopReason}`);
    unknownStopWarning = `模型以未识别的停止原因结束（stopReason: ${response.stopReason ?? "null"}）`;
    break;
  }

  // 达到最大轮次——强制请求总结（额外一轮，不计入 maxTurns）。
  // 问题：子代理达到 max_turns 被强制终止时，最后一条 assistant 消息可能是
  // "Let me check..." 这类 thinking/planning 文本，extractFinalText 取到它就
  // 导致 result 无法被主循环利用。对标 CC 的策略（Anthropic 模型 thinking 有独立 type
  // 自然被过滤），但 sid-code 支持第三方模型（DeepSeek 等），其 reasoning 混在 text block 中，
  // 无法靠 type 过滤。解法：在退出前追加一轮"请总结"，让模型输出结构化结论再退出。
  if (!signal.aborted) {
    log.info("AGENT_LOOP", `达到最大轮次 ${maxTurns}，请求强制总结`);
    ctxMgr.addMessage({
      role: "user",
      content: [{ type: "text", text: "你已达到最大轮次限制，无法继续调用工具。请立即输出你到目前为止的所有发现和结论，以结构化格式（表格/列表）呈现。不要再调用任何工具，直接输出结论。" }],
    });

    // T13.1：强制总结轮同样发射 StreamPhase 事件（与主循环轮对齐，避免总结轮 LLM 调用不可见）。
    // 用独立命名空间 20000+turns，与主循环轮 10000+turns 区分，避免 index 撞车。
    const summaryStreamIndex = 20000 + turns;
    const summaryStartTime = Date.now();
    emitStreamPhase(summaryStreamIndex, "fetch_sent", { caller: "sub-agent-summary", model });

    try {
      const summaryStream = provider.sendMessageStream({
        model,
        messages: ctxMgr.getCleanedMessages(),
        system: ctxMgr.getSystemPrompt(),
        maxTokens: 4096,
        // 不传 tools，禁止模型继续调工具
        ...config.sendParamsExtra,
      }, signal);

      const summaryResponse = await processStream(summaryStream);
      accumulateUsage(totalUsage, summaryResponse.usage);
      emitStreamPhase(summaryStreamIndex, "completed", { caller: "sub-agent-summary", model, elapsed_ms: Date.now() - summaryStartTime });

      // 提取总结文本
      const summaryTexts = summaryResponse.content.filter(b => b.type === "text");
      if (summaryTexts.length > 0) {
        lastTextOutput = summaryTexts
          .map(b => b.type === "text" ? b.text : "")
          .join("\n");
      }

      // 添加总结到历史
      ctxMgr.addMessage({ role: "assistant", content: summaryResponse.content });
      config.onTurnEnd?.({ turn: turns + 1, textOutput: lastTextOutput, tools: [], tokenCount: totalUsage.inputTokens + totalUsage.outputTokens, toolUseCount });
    } catch (err: any) {
      // 强制总结失败不影响整体返回（降级到 extractFinalText 的启发式过滤）
      emitStreamPhase(summaryStreamIndex, "error", { caller: "sub-agent-summary", model, error: err.message, elapsed_ms: Date.now() - summaryStartTime });
      log.warn("AGENT_LOOP", `强制总结轮失败: ${err.message}`);
    }
  }

  return {
    success: true,
    turns,
    totalUsage,
    toolUseCount,
    lastTextOutput,
    messages: ctxMgr.getMessages(),
    // 非空但未知停止原因：内容已返回（success:true），但附带警告让父级可感知异常收尾
    errorMessage: unknownStopWarning,
  };
}
