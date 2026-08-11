/**
 * QueryEngine — 会话层
 *
 * 职责：
 * - 用户输入预处理（hook 拦截、thinking hint 解析）
 * - 会话状态管理（消息历史、用量统计）
 * - 消费 queryLoop 的 yield，桥接到外部回调
 * - 流式文本的回调桥接（processStream 内部的 onText → 外部回调）
 *
 * 接口：submitMessage() → AsyncGenerator<QueryEngineEvent>
 */

import type { Provider } from "../llm/provider.ts";
import type {
  ContentBlock,
  StreamEvent,
  AccumulatedResponse,
  SendParams,
} from "../llm/types.ts";
import type { Config } from "../config/config.ts";
import type { HookSystem } from "../hook/system.ts";
import type { QuotaManager } from "../llm/quota.ts";
import type { TokenMeter } from "../telemetry/metrics/token-meter.ts";
import type { BudgetTracker } from "../telemetry/metrics/budget-tracker.ts";
import { Manager as ContextManager } from "../context/manager.ts";
import { Registry as ToolRegistry } from "../tool/registry.ts";
import { ModelFallback } from "../llm/fallback.ts";
import { ThinkingManager } from "../llm/thinking.ts";
import { SessionState } from "../session/state.ts";
import { getLogger, getSessionMetrics } from "../debug/index.ts";
import { queryLoop } from "./loop.ts";
import { isAbortError } from "../llm/errors.ts";
import type { QueryDeps, QueryEngineEvent } from "./types.ts";
// P0-1 漏斗 5：错误分型埋点。分类走既有 classifyAPIError（动态 import，见调用点注释）。
import { logError } from "../analytics/events.ts";

/** QueryEngine 依赖 */
export interface QueryEngineDeps {
  config: Config;
  provider: Provider;
  ctxMgr: ContextManager;
  toolRegistry: ToolRegistry;
  sessionState: SessionState;
  fallback: ModelFallback;
  thinkingMgr: ThinkingManager;
  hookSystem?: HookSystem;
  quotaManager?: QuotaManager;
  tokenMeter?: TokenMeter;
  budgetTracker?: BudgetTracker;
  /** B2：会话持久化写入端（增量写入 user/assistant/tool_result 消息）。可选——未注入则不持久化 */
  sessionStore?: import("../session/store.ts").SessionStore;
  /** P1-2/P2-2/P3-2：Skill 运行时激活协调器（条件激活 + 动态发现 + 增量 listing）。可选。 */
  skillActivationCoordinator?: import("../skill/activation-coordinator.ts").SkillActivationCoordinator;
  /** 执行工具调用（含权限检查）。返回 results + 可选 followup（ADR-019） */
  executeTools: (content: ContentBlock[]) => Promise<{ results: ContentBlock[]; followup?: ContentBlock[] }>;
  /** 处理流式响应。onThinking 对标 Claude Code 的独立思考流通道 */
  processStream: (
    stream: AsyncIterable<StreamEvent>,
    onText?: (text: string) => void,
    onThinking?: (text: string) => void,
    turnAbortController?: AbortController,
  ) => Promise<AccumulatedResponse>;
  /** 自动压缩（返回压缩结果，静默-9：truncated 表示有损降级） */
  autoCompact: () => Promise<"summarized" | "truncated" | "skipped" | void>;
  /**
   * §2.2 Context Collapse：autoCompact 的前置层。对最老的若干段消息做分段摘要。
   * 返回 true 表示 collapse 后已达目标（可跳过 autoCompact），false 表示仍需 autoCompact。
   * 可选——未提供时 hard 级压缩直接走 autoCompact（行为同旧版）。
   */
  contextCollapse?: (currentUsageRatio: number) => Promise<boolean>;
  /** 处理上下文溢出 */
  handleContextOverflow: (err: any, currentMaxTokens: number) => number | null;
  /** 获取 abort signal */
  getAbortSignal: () => AbortSignal | undefined;
  /** 主动中断当前 LLM 请求（abort 当前 AbortController）。L1 单轮硬超时配合使用。可选。 */
  abortCurrentRequest?: (reason?: string) => void;
  /** Plan Mode 系统提醒（对标 Claude Code 每轮 system-reminder 注入） */
  getPlanModeReminder?: () => Promise<string | null>;
  /** 缺口 C：读取当前 permission mode（运行时可变，每轮注入 mode 指南到消息流） */
  getCurrentPermissionMode?: () => string | undefined;
  /** Effort/Thinking 旋钮：读取运行时态（用户 /effort、/think 切换），每轮经 effort.ts 映射到线格式 */
  getEffortSetting?: () => import("../llm/effort.ts").EffortSetting;
  getThinkingSetting?: () => import("../llm/effort.ts").ThinkingSetting;
  /** P0-2 / P0-3：读取 todo 状态快照（回注 + 完成度校验用） */
  getTodoState?: () => { todos: import("../tool/todo-write.ts").TodoItem[]; writeVersion: number } | null;
  /** 修复 5 / 发现 4a：读取**终态**清单（含全部完成态），专供进度落盘 + 埋点。见 types.ts 同名字段。 */
  getTodoTerminalState?: () => { todos: import("../tool/todo-write.ts").TodoItem[]; writeVersion: number } | null;
  /** 环节③：读取假设登记表实例（矛盾中断 + 交付门禁用） */
  getHypothesisLedger?: () => import("./hypothesis-ledger.ts").HypothesisLedger | null;
  /** §3.1/§3.3：轨迹采集器（用于异常路径持久化 errors.jsonl + TurnError 事件） */
  traceCollector?: import("../trace/collector.ts").TraceCollector;
  /** G2：获取 cachedMicrocompact 状态机（缓存友好压缩产出 cache_edits）。可选 */
  getCachedMicrocompactState?: () => import("./compact/cached-microcompact.ts").CachedMicrocompactState | undefined;
  /** G2：当前 provider 名称（用于 cachedMicrocompact 路径判断）。可选 */
  getProviderName?: () => string;
  /** MCP server instructions 增量拉取（新连接 server 的使用说明，经 reminderParts 注入）。可选 */
  getMcpInstructionsDelta?: () => string[] | null;
  /** 审计第 22 条：IDE 选区/@提及 增量拉取（经 reminderParts 注入，不进静态 system prompt）。可选 */
  drainIDEContextDelta?: () => string | null;
  /** /goal：读取当前活跃目标状态。返回 null 表示无目标。queryLoop 在 reminder 管道和 Goal Gate 中使用。 */
  getGoalState?: () => import("../goal/state.ts").GoalState | null;
  /** /goal：更新目标状态（由 Goal Gate 在判定 complete/blocked/budget_limited 时调用）。 */
  updateGoalState?: (updater: (goal: import("../goal/state.ts").GoalState) => void) => void;
  /**
   * 上报重试状态到 TUI（app.ts 注入 → 写 TUIState.retryStatus，由 RetryStatus 组件渲染）。
   * queryLoop 的超时重试路径用它替代 yield system 文本，与 fallback 引擎的 onRetry/onFallback
   * 统一走同一个 RetryStatus 通道，避免消息流出现重复的重试提示（见 TUI 去重方案）。可选。
   */
  reportRetryStatus?: (info: {
    kind: "retry" | "rate_limit" | "overloaded" | "fallback";
    attempt: number;
    delayMs: number;
    model: string;
    error?: string;
  }) => void;
}

export class QueryEngine {
  private deps: QueryEngineDeps;
  /** 流式文本回调（由 submitMessage 的消费者设置） */
  private streamTextCallback: ((text: string) => void) | null = null;
  /** v2：流式思考回调（对标 Claude Code 的独立思考流通道） */
  private streamThinkingCallback: ((text: string) => void) | null = null;
  /**
   * Step 0：Session Memory 句柄（由 App 在 doInit 接线后注入）。
   * queryLoop 每轮收尾触发提取（updateSessionMemory）+ 工具调用计数（recordToolCall）。
   */
  private sessionMemory: import("../session-memory/session-memory.ts").SessionMemoryHandle | null = null;
  /**
   * 后台记忆提取句柄（由 App 在 doInit 接线后注入）。
   * queryLoop 每轮 end_turn 收尾触发提取（extractMemories）。
   */
  private extractMemories: import("../memory/extract/extractor.ts").ExtractMemoriesHandle | null = null;

  constructor(deps: QueryEngineDeps) {
    this.deps = deps;
  }

  /** 更新 Provider（模型切换时调用） */
  updateProvider(provider: Provider): void {
    this.deps.provider = provider;
  }

  /** Step 0：注入 Session Memory 句柄（App 接线后调用，可传 null 关闭）。 */
  setSessionMemory(
    handle: import("../session-memory/session-memory.ts").SessionMemoryHandle | null,
  ): void {
    this.sessionMemory = handle;
  }

  /** 注入后台记忆提取句柄（App 接线后调用，可传 null 关闭）。 */
  setExtractMemories(
    handle: import("../memory/extract/extractor.ts").ExtractMemoriesHandle | null,
  ): void {
    this.extractMemories = handle;
  }

  /** 更新 TokenMeter（遥测启用后重建） */
  updateTokenMeter(tokenMeter: TokenMeter): void {
    this.deps.tokenMeter = tokenMeter;
  }

  /**
   * 提交用户消息，返回 async generator 供外部消费
   *
   * 使用方式：
   * ```ts
   * for await (const event of engine.submitMessage(input)) {
   *   switch (event.kind) {
   *     case "stream_text": handleText(event.text); break;
   *     case "tool_start": handleToolStart(event.toolName); break;
   *     // ...
   *   }
   * }
   * ```
   */
  async *submitMessage(
    userInput: string,
    options?: {
      thinking?: { enabled: boolean; budgetTokens: number };
      /**
       * 斜杠命令展开来源标记：inline prompt 命令（如 /commit）把展开后的完整提示词
       * 作为 user 消息喂给 LLM，但 TUI 不该把整段提示词渲染成 `> ...` 用户输入
       * （泄漏 + 干扰视线）。设此值时给 user 消息打 _meta 标记，history-adapter 只
       * 渲染触发命令本身（此字段值，如 `/commit`），提示词内容仅 LLM 可见。
       */
      displayCommand?: string;
    },
  ): AsyncGenerator<QueryEngineEvent> {
    const log = getLogger();
    const { config, ctxMgr, toolRegistry, sessionState, hookSystem, sessionStore } = this.deps;

    log.info("ENGINE", `用户输入: ${userInput.slice(0, 200)}${userInput.length > 200 ? "..." : ""}`);

    // 记录用户提示
    getSessionMetrics().recordPrompt();

    // 新一轮对话开始，重置模型可用性的 retry_once 标记
    this.deps.fallback.getAvailability().resetTurn();

    // ─── user_prompt_submit hook ───
    let finalInput = userInput;
    if (hookSystem) {
      const hookResult = await hookSystem.fireUserPromptSubmitEvent(userInput);
      if (hookResult.finalOutput?.isBlockingDecision()) {
        // G4：UserPromptSubmit 阻塞语义——直接 return 使原 prompt 不进入模型上下文
        // （等价 CC exit2 的"擦除原 prompt"），只反馈阻塞原因。此处 return 前用户消息
        // 尚未 addMessage（见下方 ctxMgr.addMessage 在 thinking 解析之后），天然不落库。
        log.info("HOOK", `用户输入被 hook 阻止（原 prompt 不入上下文）: ${hookResult.finalOutput.getEffectiveReason()}`);
        yield { kind: "hook_blocked", reason: hookResult.finalOutput.getEffectiveReason() };
        return;
      }
      if (hookResult.finalOutput?.shouldStopExecution()) {
        log.info("HOOK", `用户输入被 hook 停止: ${hookResult.finalOutput.getEffectiveReason()}`);
        yield { kind: "hook_blocked", reason: hookResult.finalOutput.getEffectiveReason() };
        return;
      }
      const additionalCtx = hookResult.finalOutput?.getAdditionalContext();
      if (additionalCtx) {
        log.info("HOOK", `用户输入被 hook 追加上下文`);
        finalInput = userInput + "\n\n" + additionalCtx;
      }
    }

    // ─── 解析 thinking hint ───
    // 修复 §2.2：旧实现解析出 _thinking 后从未传递到 sendParams——
    // think hard / ultrathink 完全失效，DeepSeek reasoning_effort 永不下发。
    // 现经 queryDeps.getThinkingConfig 注入 queryLoop。
    const { cleaned: cleanedInput, config: thinkingConfig } =
      this.deps.thinkingMgr.parseThinkingHint(finalInput);
    const thinking = options?.thinking ?? thinkingConfig ?? this.deps.thinkingMgr.getThinkingConfig(cleanedInput);

    // ─── 添加用户消息 ───
    // B2：API 调用前先持久化 user 消息（对标 claude-code：进程中途被 kill 也可 resume）。
    // 持久化失败绝不能阻断主流程，故 try/catch 吞掉异常。
    const userMessage = {
      role: "user" as const,
      content: [{ type: "text" as const, text: cleanedInput }],
      // 斜杠命令展开：打来源标记，history-adapter 据此把这条 user 消息渲染为
      // 「命令历史项」（只显示 /commit 触发命令），而非把整段展开提示词当 `> ...`
      // 用户输入泄漏到屏幕。标记只影响展示，不影响喂给 LLM 的内容。
      ...(options?.displayCommand
        ? {
            _meta: {
              origin: "command-expansion",
              displayCommand: options.displayCommand,
            },
          }
        : {}),
    };
    try {
      // P2-G7：per-message 上下文（cwd/gitBranch/permissionMode）。实时读取（分支尤其不能用启动
      // 快照），store 侧仅在相对上一条变化时落盘。探测失败不阻断持久化。
      let ctxMeta: { cwd?: string; gitBranch?: string; permissionMode?: string } | undefined;
      try {
        const { getCwd } = await import("../bootstrap/state.ts");
        const { getCurrentGitBranch } = await import("../util/git-branch.ts");
        const cwd = getCwd();
        const gitBranch = await getCurrentGitBranch(cwd, Date.now());
        ctxMeta = {
          cwd,
          gitBranch,
          permissionMode: config.permissionMode,
        };
      } catch {
        /* 上下文探测失败：退化为无 meta 落盘 */
      }
      sessionStore?.appendMessage(userMessage, ctxMeta);
    } catch (e) {
      log.warn("ENGINE", `用户消息持久化失败（不阻断）: ${(e as Error)?.message}`);
    }
    ctxMgr.addMessage(userMessage);
    yield { kind: "user_message_added" };

    // ─── 构建 queryLoop 依赖 ───
    const queryDeps: QueryDeps = {
      sendWithRetry: (params: SendParams, signal?: AbortSignal) => {
        this.deps.fallback.reset();
        return this.deps.fallback.executeWithFallback(this.deps.provider, params, signal);
      },
      processStream: (stream, onText, onThinking, turnAbortController) => {
        // 桥接：将 processStream 内部的 onText/onThinking 回调转发给外部
        // Fix 3：turnAbortController 原样透传，让底层 stream-processor 超时只 abort turn 级。
        return this.deps.processStream(
          stream,
          (text) => {
            this.streamTextCallback?.(text);
            onText?.(text);
          },
          (thinking) => {
            this.streamThinkingCallback?.(thinking);
            onThinking?.(thinking);
          },
          turnAbortController,
        );
      },
      executeTools: this.deps.executeTools,
      autoCompact: this.deps.autoCompact,
      contextCollapse: this.deps.contextCollapse,
      handleContextOverflow: this.deps.handleContextOverflow,
      getAbortSignal: this.deps.getAbortSignal,
      abortCurrentRequest: this.deps.abortCurrentRequest,
      uuid: () => crypto.randomUUID(),
      checkFallbackOccurred: () => this.deps.fallback.checkFallbackOccurred(),
      resetFallbackFlag: () => this.deps.fallback.reset(),
      getPlanModeReminder: this.deps.getPlanModeReminder,
      getCurrentPermissionMode: this.deps.getCurrentPermissionMode,
      getEffortSetting: this.deps.getEffortSetting,
      getThinkingSetting: this.deps.getThinkingSetting,
      getTodoState: this.deps.getTodoState,
      getTodoTerminalState: this.deps.getTodoTerminalState,
      getHypothesisLedger: this.deps.getHypothesisLedger,
      sessionStore: this.deps.sessionStore,
      // G2：cachedMicrocompact 状态机 + provider 名称（缓存友好压缩产出 cache_edits）
      getCachedMicrocompactState: this.deps.getCachedMicrocompactState,
      getProviderName: this.deps.getProviderName,
      getMcpInstructionsDelta: this.deps.getMcpInstructionsDelta,
      // 审计第 22 条：IDE 选区/@提及 增量注入（与上面 MCP instructions 同一模式）
      drainIDEContextDelta: this.deps.drainIDEContextDelta,
      // G7：异步 hook rewake 回灌——每轮开始排空后台 hook 的 exit-2 反馈，格式化为文本块
      drainAsyncHookRewakes: hookSystem
        ? () => {
            const notes = hookSystem.drainRewakeNotifications();
            return notes.map(n => `[Hook: ${n.hookName}]\n${n.error}`);
          }
        : undefined,
      // P1-2/P2-2/P3-2：skill 激活协调器转发（条件激活/动态发现 + 增量 listing）
      onSkillToolResults: this.deps.skillActivationCoordinator
        ? (toolInputs) => this.deps.skillActivationCoordinator!.onToolResults(toolInputs)
        : undefined,
      drainSkillListingDelta: this.deps.skillActivationCoordinator
        ? () => this.deps.skillActivationCoordinator!.drainListingDelta()
        : undefined,
      // /goal：目标驱动持续执行——转发到 queryLoop deps
      getGoalState: this.deps.getGoalState,
      updateGoalState: this.deps.updateGoalState,
      // TUI 去重：超时重试上报 RetryStatus 通道（转发到 queryLoop deps）
      reportRetryStatus: this.deps.reportRetryStatus,
      // /goal：Trace 事件写入端（Goal Gate 决策事件）
      traceAppendEvent: this.deps.traceCollector
        ? (event) => (this.deps.traceCollector as any).writer?.appendEvent?.(event)
        : undefined,
      // 优化 1：把 loop.ts 内层 catch（降级重试 continue / 观测类 warn 吞掉）捕获的异常
      // 也持久化到 errors.jsonl。此前 recordError 只在下方 engine 最外层 catch 调用，
      // 内层被吞掉的错误 engine 看不到。转发到 collector 的同一 recordError 方法。
      recordError: this.deps.traceCollector
        ? (input) => this.deps.traceCollector!.recordError(input)
        : undefined,
      // Step 0：Session Memory 每轮收尾钩子（fire-and-forget，内部按双阈值决定是否提取）。
      updateSessionMemory: this.sessionMemory
        ? () => this.sessionMemory!.updateSessionMemory()
        : undefined,
      recordSessionMemoryToolCall: this.sessionMemory
        ? () => this.sessionMemory!.recordToolCall()
        : undefined,
      extractMemories: this.extractMemories
        ? () => this.extractMemories!.executeExtract()
        : undefined,
    };

    // ─── 启动 queryLoop ───
    const loop = queryLoop({
      config,
      ctxMgr,
      toolRegistry,
      sessionState,
      fallback: this.deps.fallback,
      hookSystem,
      quotaManager: this.deps.quotaManager,
      tokenMeter: this.deps.tokenMeter,
      budgetTracker: this.deps.budgetTracker,
      // 把解析出的 thinking 配置下传给 queryLoop → SendParams（修复 _thinking 历史断链）。
      thinking,
      deps: queryDeps,
    });

    // ─── 消费 queryLoop 的 yield，桥接到外部 ───
    // §3.2（fdb47f30）：外层 try-catch 隔离 queryLoop 内部异常（如 processStream throw）。
    // 原先无外层 catch，异常会穿透 for-await，跳过下方 done 收尾逻辑——上层 app 只能靠
    // 模糊的 finally "任务异常中断" 提示，拿不到具体错误。现把底层异常统一封装为
    // fatal_error 事件走 yield 通道，让 app 层能持久化展示具体原因（联动 §3.3），
    // 且 abort（用户 ESC）仍原样向上抛出（由 app 的 onUserInput catch 按"已取消"处理）。
    try {
      for await (const event of loop) {
        // B2：持久化 assistant 消息。queryLoop 每次 ctxMgr.addMessage(assistant) 后都紧跟
        // yield assistant_message，故此处写入与内存历史一一对应（含空参数 sanitized、降级前等
        // 已入历史的中间态——持久化与内存保持一致，恢复时状态对齐）。tool_result 由 queryLoop
        // 内部经注入的 sessionStore 直接写入（方案 a），不在此处理。
        // ⚠️ 修正 bug①：endSession 绝不放在此循环/finally——它每轮用户输入调用一次，
        // 会写 session_end 并置 currentFile=null，导致第 2 轮起所有消息静默丢失。
        // endSession 只在 App 退出时调用一次（B3）。
        if (event.kind === "assistant_message") {
          try {
            // P1-G3：透传 persistMeta（usage/model/stopReason/msgId）到 store，按单条回复落盘归因。
            sessionStore?.appendMessage(event.message, event.persistMeta);
          } catch (e) {
            log.warn("ENGINE", `assistant 消息持久化失败（不阻断）: ${(e as Error)?.message}`);
          }
        }
        yield event;
        if (event.kind === "done") {
          return;
        }
      }
    } catch (err) {
      // 用户主动中断（ESC）：原样向上抛，由 app 的 onUserInput catch 按"已取消"处理，
      // 不转 fatal_error（中断不是故障）。
      if (isAbortError(err)) {
        throw err;
      }
      // 真异常：封装为 fatal_error 事件 yield（而非穿透），让上层收尾可达 + 展示具体原因。
      const e = err as Error;
      log.error("ENGINE", `queryLoop 异常，封装为 fatal_error: ${e?.message}`, { stack: e?.stack });

      // §3.1 + §3.3：异常路径持久化——直接写入轨迹目录，不依赖全局 audit.log
      // turn index 从 traceCollector 的 pairs 长度推断（pairs.length + 1 = 当前正在处理的 index）
      const currentIndex = (this.deps.traceCollector?.getPairs().length ?? 0) + 1;
      const stackLines = e?.stack?.split("\n").slice(0, 5).join("\n");

      // 漏斗 5 · 错误（P0-1）：回答「哪类错误最高频」。
      //
      // 分型走既有的 classifyAPIError，**不自己用裸子串猜**——那正是记忆里
      // 「归因与真实信号脱节」记的反模式（判据优先级：状态码 / reason 白名单 > 数字边界
      // > 裸子串）。classifyAPIError 内部按 isAbortError / HTTP 状态码 / 结构化字段判定，
      // 已经是这条链上最权威的分类器，另起一套只会分叉。
      //
      // 埋在这里而不是 collector.recordError：后者收到的 error 已被拍平成 string，
      // 分类器需要的结构化字段（status / code / headers）在那一层已经丢了。
      // 这是「归因要贴着真实信号」的一个具体落点——离信号越近，判据越强。
      //
      // 只上报分型与轮次，**不上报 message / stack**：错误文本里常带文件路径、
      // 命令行、甚至密钥片段。要看具体错误去 errors.jsonl（本地，已有上面那份记录）。
      try {
        const { classifyAPIError } = await import("../api/errors.ts");
        logError({
          category: classifyAPIError(err),
          source: "engine",
          extra: { turn: currentIndex },
        });
      } catch { /* 埋点绝不影响错误处理主路径 */ }
      if (this.deps.traceCollector) {
        this.deps.traceCollector.recordError({
          phase: "engine",
          index: currentIndex,
          error: e?.message ?? String(err),
          stack: stackLines,
        });
        this.deps.traceCollector.recordTurnError({
          error: e?.message ?? String(err),
          stack: stackLines,
          turn: currentIndex,
        });
      }

      yield {
        kind: "fatal_error",
        message: e?.message ?? String(err),
        stack: e?.stack,
        recoverable: false,
      };
      return;
    }
  }

  /**
   * 设置流式文本回调
   * 由于 processStream 是 Promise（非 generator），无法直接 yield 流式文本。
   * 通过此回调桥接：processStream 内部 onText → 此回调 → 外部消费者
   */
  setStreamTextCallback(cb: ((text: string) => void) | null): void {
    this.streamTextCallback = cb;
  }

  /**
   * 设置流式思考回调（v2：对标 Claude Code 的独立思考流通道）
   * 通过此回调桥接：processStream 内部 onThinking → 此回调 → 外部消费者（TUI）
   */
  setStreamThinkingCallback(cb: ((text: string) => void) | null): void {
    this.streamThinkingCallback = cb;
  }
}
