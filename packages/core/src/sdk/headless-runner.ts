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
import type { SDKMessage, StdoutMessage } from "./types.ts";

/**
 * runHeadlessStreaming — 内层引擎
 *
 * 从 StructuredIO 读取输入消息，入队并贪婪消费命令队列，
 * 把每轮 SDKQueryEngine 的 SDKMessage 流逐条 yield。
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
): AsyncGenerator<StdoutMessage> {
  let running = false;

  // 贪婪消费队列（合并批量），逐条 yield 引擎消息
  async function* drainQueue(): AsyncGenerator<StdoutMessage> {
    if (running) return;
    running = true;
    try {
      let command: QueuedCommand | undefined;
      while ((command = commandQueue.dequeueBatch())) {
        for await (const message of engine.submitMessage(command.value, {
          uuid: command.uuid,
        })) {
          yield message;
        }
      }
    } finally {
      running = false;
    }
  }

  // 先消费已入队的初始命令
  yield* drainQueue();

  // 再从 stdin 读取后续消息，入队并触发消费
  for await (const input of structuredIO.read()) {
    if (input.type === "user") {
      const content = input.message.content;
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
        uuid: input.uuid,
        priority: "next",
      });
      yield* drainQueue();
    }
  }
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
  },
): Promise<void> {
  const { outputFormat, verbose, initialPrompt } = options;
  const out: Writable = options.output ?? process.stdout;

  if (outputFormat === "stream-json") {
    const structuredIO = options.structuredIO;
    const commandQueue = options.commandQueue;
    if (!structuredIO || !commandQueue) {
      throw new Error("stream-json 模式需要传入 structuredIO 与 commandQueue");
    }

    if (initialPrompt) {
      commandQueue.enqueue({ mode: "prompt", value: initialPrompt, priority: "now" });
    }

    for await (const msg of runHeadlessStreaming(structuredIO, engine, commandQueue)) {
      await structuredIO.write(msg);
    }
    return;
  }

  // text / json：收集后统一输出
  const messages: SDKMessage[] = [];
  if (initialPrompt) {
    for await (const msg of engine.submitMessage(initialPrompt)) {
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
}
