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

    try {
      for await (const event of this.driver.submitMessage(prompt)) {
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
    }

    // ④ 若内核未产出 done/max_turns（异常/提前返回），合成终止消息
    if (!terminalEmitted) {
      if (runError) {
        yield {
          type: "result",
          subtype: "error_during_execution",
          errors: [runError.message],
          duration_ms: this.now() - this.startTime,
          num_turns: this.turnCount,
          total_cost_usd: this.driver.getCostUsd(),
          usage: this.driver.getUsage(),
          session_id: this.config.sessionId,
        };
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
          total_cost_usd: this.driver.getCostUsd(),
          usage: this.driver.getUsage(),
          session_id: this.config.sessionId,
        });
      }
    }
  }

  /** 用最终的助手文本与 API 耗时补齐 success result */
  private finalizeResult(result: SDKResultMessage): SDKResultMessage {
    if (result.subtype !== "success") return result;
    return {
      ...result,
      result: result.result || this.extractFinalText(),
      duration_api_ms: result.duration_api_ms || (this.driver.getApiDurationMs?.() ?? 0),
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
