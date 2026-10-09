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
import { SDKControlSetModelSchema } from "./control-schemas.ts";

/** runHeadless 的收尾状态。调用方用它决定退出码，不能只看「有没有抛异常」。 */
export interface HeadlessRunOutcome {
  /**
   * 是否因预算硬停而结束。stream-json 的结果消息里已经有 error_max_budget_usd，
   * 但写出消息不等于进程以非 0 退出——CI 看的是退出码。
   */
  budgetExceeded: boolean;
  /** 是否因 stdin 空闲超时（idleTimeoutMs）而结束读取（缺陷 7）。 */
  idleTimedOut: boolean;
}

/** `get_context_usage` 的响应载荷 */
export interface HeadlessContextUsage {
  used_tokens: number;
  max_tokens: number;
  percent_of_window: number;
}

/** 宿主发来的控制请求里，CLI 侧要回调出去的那几类。 */
export interface HeadlessControlHandlers {
  /** `interrupt`：中止当前轮。没有在跑的轮时也会被调用，实现方自己决定是否 no-op。 */
  onInterrupt?: () => void;
  /**
   * `set_model`：切换主模型，下一轮起生效。非法模型名请抛错——错误文案原样回给宿主。
   * 返回切换后的模型名。不提供 = 回 error「未实现」。
   */
  onSetModel?: (model: string) => string;
  /** `get_context_usage`：当前上下文占用。不提供 = 回 error「未实现」。 */
  onGetContextUsage?: () => HeadlessContextUsage;
}

/** 本编排层能应答的入站控制子类型（随 handlers 增减；initialize 恒可答） */
function supportedSubtypes(handlers: HeadlessControlHandlers): string[] {
  const out = ["initialize", "interrupt"];
  if (handlers.onSetModel) out.push("set_model");
  if (handlers.onGetContextUsage) out.push("get_context_usage");
  return out;
}

/**
 * `initialize` 里这些字段在 CLI 进程已启动后无法生效（system prompt / schema 工具 /
 * 轮次与预算上限都在进程启动时装配进内核）。收到就**明确拒绝**，而不是回 success
 * 让宿主以为设上了——那正是缺陷 6 的静默失效形态换了个入口。
 */
const INITIALIZE_STARTUP_ONLY_FIELDS: Record<string, string> = {
  system_prompt: "--system-prompt",
  json_schema: "--json-schema",
  max_turns: "--max-turns",
  max_budget_usd: "--max-budget-usd",
};

/**
 * 宿主控制请求的分发（B25 起只有 interrupt；缺陷 3/4 补齐其余入站子类型）。
 *
 * 每个带 request_id 的入站 control_request **必回一条 control_response**——
 * 宿主那边的 sendRequest 在等它。能做的回 success，做不了的回 error 并说清原因；
 * 绝不静默丢弃。
 *
 * `can_use_tool` 方向相反（CLI → 宿主），宿主发过来同样回 error。
 */
async function handleControlRequest(
  structuredIO: StructuredIO,
  msg: { request_id?: unknown; request?: Record<string, unknown> & { subtype?: unknown } },
  handlers: HeadlessControlHandlers,
): Promise<void> {
  const requestId = typeof msg.request_id === "string" ? msg.request_id : "";
  const req = msg.request ?? {};
  const subtype = typeof req.subtype === "string" ? req.subtype : "";
  if (!requestId) return; // 没有 request_id 就无从配对，回了也没人收

  const success = (response?: unknown) =>
    structuredIO.write({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: requestId,
        ...(response !== undefined ? { response } : {}),
      },
    });
  const error = (text: string) =>
    structuredIO.write({
      type: "control_response",
      response: { subtype: "error", request_id: requestId, error: text },
    });

  try {
    switch (subtype) {
      case "interrupt":
        handlers.onInterrupt?.();
        await success();
        return;

      case "initialize": {
        const rejected = Object.keys(INITIALIZE_STARTUP_ONLY_FIELDS).filter(
          (k) => req[k] !== undefined,
        );
        if (rejected.length > 0) {
          await error(
            `initialize 字段 ${rejected.join(", ")} 只能在启动时设置，请改用 CLI 参数 ` +
              rejected.map((k) => INITIALIZE_STARTUP_ONLY_FIELDS[k]).join(" / "),
          );
          return;
        }
        await success({ supported_control_subtypes: supportedSubtypes(handlers) });
        return;
      }

      case "set_model": {
        if (!handlers.onSetModel) break;
        const parsed = SDKControlSetModelSchema().safeParse(req);
        if (!parsed.success) {
          await error(`set_model 请求格式错误：需要字符串字段 model`);
          return;
        }
        const model = handlers.onSetModel(parsed.data.model);
        await success({ model });
        return;
      }

      case "get_context_usage":
        if (!handlers.onGetContextUsage) break;
        await success(handlers.onGetContextUsage());
        return;
    }
  } catch (err) {
    await error(err instanceof Error ? err.message : String(err));
    return;
  }

  await error(
    `控制请求 "${subtype || "(缺 subtype)"}" 未实现（当前支持：${supportedSubtypes(handlers).join(" / ")}）`,
  );
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
 * 终止条件：输入流结束（stdin EOF）且队列排空；或 stdin 空闲超时（idleTimeoutMs）。
 *
 * ⚠️ 缺陷 8：某一轮抛异常**不得**终止整个会话。旧实现里异常穿出 for-await，
 * 读循环随之关闭——这一条没有 result、之后宿主已写进 stdin 的消息连读都不会被读。
 * 现在每条命令独立兜底：抛异常且还没出过 result 的，补一条 error_during_execution，
 * 然后继续处理下一条。
 */
export async function* runHeadlessStreaming(
  structuredIO: StructuredIO,
  engine: SDKQueryEngine,
  commandQueue: CommandQueue,
  options: {
    /**
     * 缺陷 7：stdin 空闲上限。没有在跑的轮、队列为空、且这么久没收到任何入站消息时，
     * 停止等待并正常收尾。0 / 不传 = 不设上限（宿主可以在两轮之间任意久地空闲）。
     *
     * 这里曾还有 maxTurns / maxBudgetUsd 两个字段，同缺陷 6：内核已硬停，此处零读取，删了。
     */
    idleTimeoutMs?: number;
    /** 空闲超时触发时回调（调用方记日志 / 决定退出码） */
    onIdleTimeout?: () => void;
  } = {},
  handlers: HeadlessControlHandlers = {},
): AsyncGenerator<StdoutMessage> {
  const idleTimeoutMs = options.idleTimeoutMs ?? 0;
  let inputDone = false;
  let idleExpired = false;
  /** 最近一次「有动静」的时刻：收到入站消息 / 一轮结束 */
  let lastActivity = Date.now();
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
        if (idleExpired) break;
        lastActivity = Date.now();
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
        let resultEmitted = false;
        try {
          for await (const message of engine.submitMessage(command.value, {
            uuid: command.uuid,
          })) {
            if ((message as { type?: unknown }).type === "result") resultEmitted = true;
            yield message;
          }
        } catch (err) {
          // 已经出过 result 的轮再抛，说明终止信号已送达，不补第二条
          if (!resultEmitted) yield turnErrorResult(engine, err);
        }
        lastActivity = Date.now();
      }
      if (inputDone && commandQueue.isEmpty()) break;
      if (idleExpired) break;
      await new Promise<void>((resolve) => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        wake = () => {
          if (timer) clearTimeout(timer);
          resolve();
        };
        // 等待期间泵可能已经结束或入队——复查一次，避免错过唤醒
        if (inputDone || !commandQueue.isEmpty()) {
          notify();
          return;
        }
        if (idleTimeoutMs > 0) {
          const remaining = Math.max(0, lastActivity + idleTimeoutMs - Date.now());
          timer = setTimeout(() => {
            timer = null;
            idleExpired = true;
            options.onIdleTimeout?.();
            notify();
          }, remaining);
          (timer as { unref?: () => void }).unref?.();
        }
      });
      // 超时与入队在同一时刻到达时，以入队为准：先把队列跑完再退出
      if (idleExpired && !commandQueue.isEmpty()) idleExpired = false;
    }
  } finally {
    // 正常结束时泵已退出；提前 return（消费方中止）时不等它，stdin 由进程收尾关闭
    if (inputDone) await pump;
  }
  if (pumpError) throw pumpError;
}

/**
 * 缺陷 8：某轮抛异常时补的那条 result。优先用引擎自带的（带 usage / cost / 轮数）；
 * 嵌入方注入的 engine 若没有 errorResult（鸭子类型的 mock / 自定义实现），给一条最小合法 result。
 */
function turnErrorResult(engine: SDKQueryEngine, err: unknown): SDKResultMessage {
  const e = engine as Partial<Pick<SDKQueryEngine, "errorResult">>;
  if (typeof e.errorResult === "function") return e.errorResult.call(engine, err);
  return {
    type: "result",
    subtype: "error_during_execution",
    errors: [err instanceof Error ? err.message : String(err)],
    duration_ms: 0,
    num_turns: 0,
    num_turns_without_model_interaction: 0,
    total_cost_usd: 0,
    usage: { inputTokens: 0, outputTokens: 0 },
    session_id: "",
  };
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
    /** stream-json 下宿主控制请求的回调（B25：interrupt；缺陷 4：set_model / get_context_usage） */
    controlHandlers?: HeadlessControlHandlers;
    /** stream-json 下 stdin 空闲上限（缺陷 7）。0 / 不传 = 不设上限 */
    idleTimeoutMs?: number;
  },
): Promise<HeadlessRunOutcome> {
  const { outputFormat, verbose, initialPrompt } = options;
  const out: Writable = options.output ?? process.stdout;
  let budgetExceeded = false;
  let idleTimedOut = false;
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
      {
        idleTimeoutMs: options.idleTimeoutMs,
        onIdleTimeout: () => {
          idleTimedOut = true;
        },
      },
      options.controlHandlers,
    )) {
      watch(msg);
      await structuredIO.write(msg);
    }
    return { budgetExceeded, idleTimedOut };
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
  return { budgetExceeded, idleTimedOut };
}

/** result 消息里 subtype 为预算硬停。其余消息（含成功 result）返回 false。 */
function isBudgetExceededResult(msg: StdoutMessage): boolean {
  return (
    (msg as SDKResultMessage).type === "result" &&
    (msg as SDKResultMessage).subtype === "error_max_budget_usd"
  );
}
