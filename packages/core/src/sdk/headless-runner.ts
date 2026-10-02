/**
 * runHeadless 编排器
 *
 * 分层设计（spec §5.6）：
 * - runHeadlessStreaming：内层引擎。命令队列消费 + 多轮 SDKQueryEngine 调用，
 *   产出 StdoutMessage 流，不关心输出格式。
 * - runHeadless：外层编排。初始化 + 输出格式分发（text/json/stream-json）+ 优雅关闭。
 *
 * 注意：CLI 实际接线在 app.ts 中以真实 QueryEngine driver 调用 runHeadless，
 * 这里提供可独立测试的纯编排逻辑（driver 注入）。
 */

import type { Writable } from "node:stream";
import type { StructuredIO } from "./structured-io.ts";
import type { SDKQueryEngine } from "./query-engine.ts";
import type { CommandQueue, QueuedCommand } from "./command-queue.ts";
import type { SDKMessage, SDKResultMessage, SDKUserMessage, StdoutMessage } from "./types.ts";

/** runHeadless 的收尾状态。调用方用它决定退出码，不能只看「有没有抛异常」。 */
export interface HeadlessRunOutcome {
  /**
   * 是否因预算硬停而结束。stream-json 的结果消息里已经有 error_max_budget_usd，
   * 但写出消息不等于进程以非 0 退出——CI 看的是退出码。
   */
  budgetExceeded: boolean;
}

/** 宿主发来的控制请求里，CLI 侧要回调出去的那几类。 */
export interface HeadlessControlHandlers {
  /** `interrupt`：中止当前轮。没有在跑的轮时也会被调用，实现方自己决定是否 no-op。 */
  onInterrupt?: () => void;
}

/**
 * B25：宿主控制请求的分发。只实现 `interrupt`；其余 subtype 一律回 error「未实现」——
 * 以前它们落进 runHeadlessStreaming 的 `if (type === "user")` 之外被**静默丢弃**，
 * 宿主那边永远等不到 control_response。回一个明确的错误，至少宿主能知道。
 *
 * `can_use_tool` 方向相反（CLI → 宿主），宿主发过来同样回 error。
 */
async function handleControlRequest(
  structuredIO: StructuredIO,
  msg: { request_id?: unknown; request?: { subtype?: unknown } },
  handlers: HeadlessControlHandlers,
): Promise<void> {
  const requestId = typeof msg.request_id === "string" ? msg.request_id : "";
  const subtype = typeof msg.request?.subtype === "string" ? msg.request.subtype : "";
  if (!requestId) return; // 没有 request_id 就无从配对，回了也没人收
  if (subtype === "interrupt") {
    handlers.onInterrupt?.();
    await structuredIO.write({
      type: "control_response",
      response: { subtype: "success", request_id: requestId },
    });
    return;
  }
  await structuredIO.write({
    type: "control_response",
    response: {
      subtype: "error",
      request_id: requestId,
      error: `控制请求 "${subtype || "(缺 subtype)"}" 未实现（当前只支持 interrupt）`,
    },
  });
}

/**
 * runHeadlessStreaming — 内层引擎
 *
 * 从 StructuredIO 读取输入消息，入队并贪婪消费命令队列，
 * 把每轮 SDKQueryEngine 的 SDKMessage 流逐条 yield。
 *
 * ⚠️ stdin 必须**与轮次并发**读取（B25）。旧实现是「先跑完初始 prompt 再读 stdin」，
 * 于是第一轮里发出的 `can_use_tool` 的 control_response、以及第一轮里的 `interrupt`，
 * 都要等这一轮结束才被读到——也就是永远等不到。所以读取放在后台泵里，
 * 控制消息到达即处理，user 消息只入队。
 *
 * 终止条件：输入流结束（stdin EOF）且队列排空。
 */
export async function* runHeadlessStreaming(
  structuredIO: StructuredIO,
  engine: SDKQueryEngine,
  commandQueue: CommandQueue,
  _options: {
    maxTurns?: number;
    maxBudgetUsd?: number;
    idleTimeoutMs?: number;
  } = {},
  handlers: HeadlessControlHandlers = {},
): AsyncGenerator<StdoutMessage> {
  let inputDone = false;
  let wake: (() => void) | null = null;
  const notify = () => {
    const w = wake;
    wake = null;
    w?.();
  };

  let pumpError: unknown = null;
  const pump = (async () => {
    try {
      for await (const input of structuredIO.read()) {
        const type = (input as { type?: unknown }).type;
        if (type === "user") {
          const content = (input as SDKUserMessage).message.content;
          const value =
            typeof content === "string"
              ? content
              : content
                  .filter((b): b is { type: "text"; text: string } => b.type === "text")
                  .map((b) => b.text)
                  .join("\n");
          commandQueue.enqueue({
            mode: "prompt",
            value,
            uuid: (input as SDKUserMessage).uuid,
            priority: "next",
          });
          notify();
        } else if (type === "control_request") {
          await handleControlRequest(structuredIO, input as never, handlers);
        }
      }
    } catch (err) {
      // 读侧异常（流出错）不能变成孤儿 rejection；留到主循环收尾时抛出
      pumpError = err;
    } finally {
      inputDone = true;
      notify();
    }
  })();

  try {
    while (true) {
      let command: QueuedCommand | undefined;
      while ((command = commandQueue.dequeueBatch())) {
        for await (const message of engine.submitMessage(command.value, {
          uuid: command.uuid,
        })) {
          yield message;
        }
      }
      if (inputDone && commandQueue.isEmpty()) break;
      await new Promise<void>((resolve) => {
        wake = resolve;
        // 等待期间泵可能已经结束或入队——复查一次，避免错过唤醒
        if (inputDone || !commandQueue.isEmpty()) notify();
      });
    }
  } finally {
    // 正常结束时泵已退出；提前 return（消费方中止）时不等它，stdin 由进程收尾关闭
    if (inputDone) await pump;
  }
  if (pumpError) throw pumpError;
}

/** 提取 result(success) 的最终文本 */
function extractResultText(messages: SDKMessage[]): string {
  const last = messages[messages.length - 1];
  if (last && last.type === "result" && last.subtype === "success") {
    return last.result;
  }
  return "";
}

/**
 * runHeadless — 外层编排
 *
 * 三种输出格式：
 * - stream-json：通过 StructuredIO 实时写出每条 SDKMessage（NDJSON）
 * - json：收集所有消息，verbose 输出全量数组，否则仅最终 result
 * - text：仅输出最终文本
 */
export async function runHeadless(
  engine: SDKQueryEngine,
  options: {
    outputFormat: "text" | "json" | "stream-json";
    verbose?: boolean;
    initialPrompt?: string;
    structuredIO?: StructuredIO;
    commandQueue?: CommandQueue;
    output?: Writable;
    /** stream-json 下宿主控制请求的回调（B25：interrupt） */
    controlHandlers?: HeadlessControlHandlers;
  },
): Promise<HeadlessRunOutcome> {
  const { outputFormat, verbose, initialPrompt } = options;
  const out: Writable = options.output ?? process.stdout;
  let budgetExceeded = false;
  const watch = (msg: StdoutMessage) => {
    if (isBudgetExceededResult(msg)) budgetExceeded = true;
  };

  if (outputFormat === "stream-json") {
    const structuredIO = options.structuredIO;
    const commandQueue = options.commandQueue;
    if (!structuredIO || !commandQueue) {
      throw new Error("stream-json 模式需要传入 structuredIO 与 commandQueue");
    }

    if (initialPrompt) {
      commandQueue.enqueue({ mode: "prompt", value: initialPrompt, priority: "now" });
    }

    for await (const msg of runHeadlessStreaming(
      structuredIO,
      engine,
      commandQueue,
      {},
      options.controlHandlers,
    )) {
      watch(msg);
      await structuredIO.write(msg);
    }
    return { budgetExceeded };
  }

  // text / json：收集后统一输出
  const messages: SDKMessage[] = [];
  if (initialPrompt) {
    for await (const msg of engine.submitMessage(initialPrompt)) {
      watch(msg);
      messages.push(msg);
    }
  }

  if (outputFormat === "json") {
    if (verbose) {
      out.write(JSON.stringify(messages) + "\n");
    } else {
      out.write(JSON.stringify(messages[messages.length - 1] ?? null) + "\n");
    }
  } else {
    // text
    out.write(extractResultText(messages) + "\n");
  }
  return { budgetExceeded };
}

/** result 消息里 subtype 为预算硬停。其余消息（含成功 result）返回 false。 */
function isBudgetExceededResult(msg: StdoutMessage): boolean {
  return (
    (msg as SDKResultMessage).type === "result" &&
    (msg as SDKResultMessage).subtype === "error_max_budget_usd"
  );
}
