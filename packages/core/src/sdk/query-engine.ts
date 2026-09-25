/**
 * SDKQueryEngine — 独立无头会话引擎
 *
 * 设计原则（spec §2.1 #4 依赖反转）：
 *   不重建 queryLoop / QueryEngine（那会和 app.init() 的内核重复，违反"不内核解耦"）。
 *   而是通过注入的 driver 包装现有 QueryEngine 的事件流，
 *   把内部 QueryEngineEvent 转换为标准 SDKMessage。
 *
 * 与 App 中 QueryEngine 的关键差异：
 * - 输出标准化 SDKMessage 而非内部 QueryEngineEvent
 * - 合成 system/init 与 result 终止消息
 * - 累计 usage / cost，填充终止消息
 * - 支持结构化输出补充提示词
 *
 * 共享引擎：driver 背后就是交互式 TUI 用的同一个 queryLoop，
 * SDK 用户获得与交互式用户一致的 Agent 能力。
 */

import type { Message, Usage } from "../llm/types.ts";
import type { QueryEngineEvent } from "../query/types.ts";
import type { SDKMessage, SDKResultMessage } from "./types.ts";
import { convertToSDKMessage, type ConvertContext } from "./message-converter.ts";

export interface SDKQueryEngineConfig {
  cwd: string;
  sessionId: string;
  model: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  systemPrompt?: string;
  jsonSchema?: Record<string, unknown>;
  /** 是否转发 stream_event 增量（stream-json verbose 模式） */
  includeStreamEvents?: boolean;
  /** 可注入时钟（测试用），默认 Date.now */
  now?: () => number;
  /** 可注入 UUID（测试用），默认 crypto.randomUUID */
  uuid?: () => string;
}

/**
 * 引擎驱动：抽象出 SDKQueryEngine 对内核的全部依赖。
 * 生产环境由 app.ts 用真实 QueryEngine 实现；测试用 mock。
 */
export interface SDKQueryEngineDriver {
  /** 提交用户输入，返回内部事件流（即 QueryEngine.submitMessage） */
  submitMessage(input: string): AsyncGenerator<QueryEngineEvent>;
  /** 当前累计用量 */
  getUsage(): Usage;
  /** 当前累计花费（USD） */
  getCostUsd(): number;
  /** 当前完整消息历史（用于结构化输出提取 / result 文本） */
  getMessages(): readonly Message[];
  /** 工具清单（用于 system/init） */
  listTools?(): { name: string; description: string }[];
  /** API 耗时（ms），用于 result.duration_api_ms */
  getApiDurationMs?(): number;
  /** 设置流式文本回调（仅 includeStreamEvents 时使用） */
  setStreamTextCallback?(cb: ((text: string) => void) | null): void;
  /**
   * 本次会话里被拒绝、且到结束仍未放行的操作（D1）。
   * 可选：不实现的 driver（测试 mock、没有权限层的嵌入场景）就当没有拒绝。
   */
  getPermissionDenials?(): {
    tool_name: string;
    resource: string;
    count: number;
    reason: string;
  }[];
}

export class SDKQueryEngine {
  private config: SDKQueryEngineConfig;
  private driver: SDKQueryEngineDriver;
  private startTime = 0;
  private turnCount = 0;
  private aborted = false;

  constructor(config: SDKQueryEngineConfig, driver: SDKQueryEngineDriver) {
    this.config = config;
    this.driver = driver;
  }

  private get now(): () => number {
    return this.config.now ?? Date.now;
  }

  private get uuid(): () => string {
    return this.config.uuid ?? (() => crypto.randomUUID());
  }

  /**
   * 提交消息，返回 SDKMessage 异步生成器
   *
   * 生命周期：
   * 1. yield system/init
   * 2. yield user
   * 3. 消费 driver 事件流 → 转换 yield assistant/tool_progress/...
   * 4. yield result(success/error)（唯一终止信号）
   */
  async *submitMessage(prompt: string, options?: { uuid?: string }): AsyncGenerator<SDKMessage> {
    this.startTime = this.now();
    this.turnCount = 0;

    // ① system/init
    yield {
      type: "system",
      subtype: "init",
      session_id: this.config.sessionId,
      tools: this.driver.listTools?.() ?? [],
      model: this.config.model,
      cwd: this.config.cwd,
    };

    // ② user
    const userMessage: Message = {
      role: "user",
      content: [{ type: "text", text: prompt }],
    };
    yield {
      type: "user",
      uuid: options?.uuid ?? this.uuid(),
      session_id: this.config.sessionId,
      message: userMessage,
    };

    // ③ 消费内核事件流
    let terminalEmitted = false;
    let runError: Error | null = null;

    // G4：token 增量在生产路径上不走事件流。queryLoop 的 processStream 是 Promise，
    // 文本通过 onText 回调桥接（engine.ts 的 setStreamTextCallback），事件流里
    // 从未产出过 kind:"stream_text"。所以只在 converter 里等 stream_text 事件，
    // --include-partial-messages 打开了也什么都收不到。
    // 这里把回调收进队列，每个内核事件吐出前先把队列排空。回调只在
    // includeStreamEvents 时挂上：不需要增量的调用方保持原行为。
    //
    // 不与事件流做竞速。增量只在模型生成期间到来，而那段时间 driver 的
    // next() 还没 resolve（processStream 是个要等整轮结束的 Promise），
    // 所以「等下一个事件，等待期间排空队列」就能把增量实时送出去，
    // 又不会留下一个谁都不 resolve 的 Promise。
    const pendingDeltas: string[] = [];
    let deltaNotify: (() => void) | null = null;
    if (this.config.includeStreamEvents && this.driver.setStreamTextCallback) {
      this.driver.setStreamTextCallback((text) => {
        if (!text) return;
        pendingDeltas.push(text);
        const notify = deltaNotify;
        deltaNotify = null;
        notify?.();
      });
    }

    /** 把回调里已到的增量全部转成 stream_event 吐出。 */
    const flushDeltas = async function* (self: SDKQueryEngine) {
      while (pendingDeltas.length > 0) {
        const text = pendingDeltas.shift();
        if (!text) break;
        const sdkMsg = convertToSDKMessage({ kind: "stream_text", text }, self.buildCtx());
        if (sdkMsg) yield sdkMsg;
      }
    };

    try {
      const driverStream = this.driver.submitMessage(prompt);
      // 增量与内核事件一起等，而不是「先排空再等事件」。
      //
      // 为什么不能先排空：token 回调和 done 事件经常在同一刻到达（processStream
      // 的最后一批 onText 与它 resolve 是同一个同步段）。如果先把队列吐空、再去
      // 等下一个事件，这个「下一个」就是已经就绪的 done——Promise.race 选中它
      // 之后，回调里刚写进队列的增量就没人再排了，而终止消息一发循环就 return。
      // 结果是 --include-partial-messages 丢掉每轮的最后几个字。
      //
      // 所以每一轮都是：等「增量到来」或「下一个内核事件」，谁先到处理谁。
      // 事件赢了也先把此刻已在队列里的增量吐出去，再处理事件本身——
      // 终止消息之前的字不能被终止消息吞掉。
      let nextStep = driverStream.next();
      let wakeOnDelta: (() => void) | null = null;
      deltaNotify = () => wakeOnDelta?.();

      for (;;) {
        const deltaArrived = new Promise<void>((resolve) => {
          wakeOnDelta = resolve;
          // 挂上等待的间隙里回调可能已经写进队列。不在这里补一次检查，
          // 这次增量要等到下一个内核事件才出得去。
          if (pendingDeltas.length > 0) resolve();
        });
        const winner = await Promise.race([
          nextStep.then((step) => ({ kind: "event" as const, step })),
          deltaArrived.then(() => ({ kind: "delta" as const })),
        ]);
        wakeOnDelta = null;

        // 无论谁赢，先把已经到达的增量吐出去。事件赢了也不例外：
        // 回调可能就在 next() resolve 的同一个同步段里写进了队列。
        yield* flushDeltas(this);

        if (winner.kind === "delta") continue;
        if (winner.step.done) break;

        nextStep = driverStream.next();
        const event = winner.step.value;
        if (event.kind === "assistant_message") {
          this.turnCount++;
        }

        const ctx = this.buildCtx();
        const sdkMsg = convertToSDKMessage(event, ctx);

        if (!sdkMsg) continue;

        // stream_event 仅在 includeStreamEvents 时转发
        if (sdkMsg.type === "stream_event" && !this.config.includeStreamEvents) {
          continue;
        }

        // 终止消息（result）单独处理：补齐文本/API 耗时后 yield，然后结束
        if (sdkMsg.type === "result") {
          yield this.finalizeResult(sdkMsg as SDKResultMessage);
          terminalEmitted = true;
          return;
        }

        yield sdkMsg;
      }
    } catch (err) {
      runError = err instanceof Error ? err : new Error(String(err));
      this.aborted = runError.name === "AbortError" || /abort/i.test(runError.message);
    } finally {
      // 解除回调：否则下一次 submitMessage 会把增量写进这次已经结束的队列。
      // 同时放掉还挂着的等待——driver 抛错时 deltaNotify 可能正握着一个永远
      // 不会被调用的 resolve，不置空的话它会跟着这次调用的闭包活到进程结束。
      this.driver.setStreamTextCallback?.(null);
      deltaNotify = null;
    }

    // 驱动结束后回调里可能还残留增量（最后一批 text 与 done 事件同刻到达）。
    // 终止消息已经发过就不再补——增量属于它之前的内容。
    if (!terminalEmitted) {
      for (const text of pendingDeltas.splice(0)) {
        const sdkMsg = convertToSDKMessage({ kind: "stream_text", text }, this.buildCtx());
        if (sdkMsg) yield sdkMsg;
      }
    }

    // ④ 若内核未产出 done/max_turns（异常/提前返回），合成终止消息
    if (!terminalEmitted) {
      if (runError) {
        // 走 finalizeResult：错误结果同样要带上权限拒绝清单（D1）。
        // 不走的话，异常收尾的会话在 stream-json 里看不到哪些工具被拒了。
        yield this.finalizeResult({
          type: "result",
          subtype: "error_during_execution",
          errors: [runError.message],
          duration_ms: this.now() - this.startTime,
          num_turns: this.turnCount,
          // 同 message-converter：非 max_turns 路径恒 0，但字段必须在（见那里的注释）。
          num_turns_without_model_interaction: 0,
          total_cost_usd: this.driver.getCostUsd(),
          usage: this.driver.getUsage(),
          session_id: this.config.sessionId,
        });
      } else {
        // 正常结束但无 done 事件（如 hook_blocked 提前 return）
        yield this.finalizeResult({
          type: "result",
          subtype: "success",
          duration_ms: this.now() - this.startTime,
          duration_api_ms: this.driver.getApiDurationMs?.() ?? 0,
          is_error: false,
          num_turns: this.turnCount,
          result: "",
          stop_reason: "end_turn",
          // §20.5：这条是"没有 done 事件"的合成路径，拿不到 LoopState，故恒 0。
          // 填 0 而不是省略 —— 字段必须在所有 result 上结构性存在（同下方那条注释）。
          num_turns_without_model_interaction: 0,
          total_cost_usd: this.driver.getCostUsd(),
          usage: this.driver.getUsage(),
          session_id: this.config.sessionId,
        });
      }
    }
  }

  /**
   * 补齐 result：success 填最终文本与 API 耗时，两种 subtype 都附上权限拒绝清单。
   *
   * 拒绝清单放在这里而不是 converter：converter 只看单个事件，看不到会话级的
   * denial tracking；而每一条 result（含合成的那条）都经过 finalizeResult。
   * 空清单不写字段——没有拒绝的会话，结果消息与改动前逐字节相同。
   */
  private finalizeResult(result: SDKResultMessage): SDKResultMessage {
    const denials = this.driver.getPermissionDenials?.() ?? [];
    const withDenials = denials.length > 0 ? { ...result, permission_denials: denials } : result;
    if (withDenials.subtype !== "success") return withDenials;
    return {
      ...withDenials,
      result: withDenials.result || this.extractFinalText(),
      duration_api_ms: withDenials.duration_api_ms || (this.driver.getApiDurationMs?.() ?? 0),
      usage: this.driver.getUsage(),
      total_cost_usd: this.driver.getCostUsd(),
    };
  }

  /** 从消息历史提取最后一条助手消息的文本 */
  private extractFinalText(): string {
    const messages = this.driver.getMessages();
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === "assistant") {
        return m.content
          .filter((b): b is { type: "text"; text: string } => b.type === "text")
          .map((b) => b.text)
          .join("");
      }
    }
    return "";
  }

  private buildCtx(): ConvertContext {
    return {
      sessionId: this.config.sessionId,
      totalUsage: this.driver.getUsage(),
      startTime: this.startTime,
      turnCount: this.turnCount,
      totalCostUsd: this.driver.getCostUsd(),
      now: this.now,
      uuid: this.uuid,
    };
  }

  /** 当前消息历史 */
  getMessages(): readonly Message[] {
    return this.driver.getMessages();
  }

  /** 当前累计用量 */
  getUsage(): Usage {
    return this.driver.getUsage();
  }

  /** 是否被中断 */
  wasAborted(): boolean {
    return this.aborted;
  }
}
