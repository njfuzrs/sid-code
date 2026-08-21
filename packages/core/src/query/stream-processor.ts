/**
 * 流式响应处理器
 * 从 app.ts 提取，处理 LLM 流式事件，累积内容块
 *
 * v2 改变（对标 Claude Code）：思考块保留在 content 中（原地转型为 ThinkingBlock），
 * 不再从 content 移除。新增 onThinking 回调，与 onText 完全分离。
 */

import type {
  StreamEvent,
  AccumulatedResponse,
  ContentBlock,
  ToolUseBlock,
  Usage,
} from "../llm/types.ts";
import { accumulateUsage } from "../llm/types.ts";
import { getLogger } from "../debug/index.ts";
import { normalizeToolInput } from "../llm/normalize-tool-input.ts";
import { resetOnStreamRestart, recordStreamRestart } from "../llm/stream-restart.ts";
import { detectUnansweredEndTurn } from "./unanswered-end-turn.ts";
import { RequestAbortedError } from "../llm/errors.ts";
import { resolveLoopTimeouts, resolveProviderStreamTimeouts } from "../config/network-profile.ts";
import { isAwaitingHumanInput } from "./human-input-gate.ts";
import { extractInternalEnTags } from "../config/prompt-lang.ts";

/** 流式处理器配置 */
export interface StreamProcessorOptions {
  /**
   * 心跳超时（毫秒）——**已建流后**中途无数据的上限。
   * 默认取 network-profile 的 `watchdogNoProgressMs`（300s），与 loop.ts 外层看门狗同阈值。
   */
  heartbeatTimeoutMs?: number;
  /** 心跳检查间隔（毫秒，默认 5000） */
  heartbeatCheckIntervalMs?: number;
  /**
   * 首字节超时（毫秒）——**尚未收到任何事件**时的上限，与心跳分开计。
   * 默认取 network-profile 的 `headerTimeoutMs`（300s）。
   *
   * 为什么必须与心跳分开（2026-08-05 事故根因）：请求发出到首个 SSE 事件到达之间，
   * 经网关转发时要经历鉴权 + 排队 + 模型冷启动，实测 p95 已达 56s、最大 59.8s。
   * 用同一个心跳阈值去卡这段等待，等于把"网关还在正常排队"判成"流已卡死"。
   */
  firstByteTimeoutMs?: number;
  /**
   * 整体超时（毫秒）——单次流的绝对上限。
   * 默认取 provider 层 `overallTimeoutMs`（600s），比单轮 30min 硬顶更严一档。
   */
  overallTimeoutMs?: number;
  /**
   * settings.json 的 `network.*` 覆盖块，用于派生上面三个超时的默认值。
   * 由 app.ts 透传 `config.network`——让用户在 settings 里放宽阈值能真正作用到这一层
   * （2026-08-05 事故前，本层读不到任何配置，用户改什么都不生效）。
   */
  network?: import("../config/network-profile.ts").NetworkTimeoutSettings;
  /** 获取 AbortController（用于超时时中断上游） */
  getAbortController?: () => AbortController | null;
  /**
   * GAP-01：一个 tool_use 块**完整解析**（input JSON 拼接并 parse 完成）后立即回调。
   * 供上层 StreamingToolExecutor 在模型仍在流式输出后续内容时就开始执行已到达的工具，
   * 使工具执行与模型输出时间重叠。additive：不设置时行为与此前完全一致（纯批量）。
   * 回调抛错被吞（绝不影响流处理主流程）。
   */
  onToolUseComplete?: (block: ToolUseBlock) => void;
  /**
   * 流被重开、已流出的内容全部作废时回调，供 UI **撤回**已渲染的那半段文本。
   *
   * 少了它的后果（2026-08-04 事故的用户可见面）：作废尝试的文本已经通过 onText
   * 流到屏幕上了，重置只清了内部累加器，屏幕上那段孤立叙述留在原地——用户看到
   * 「§六已完成…」紧跟「§7.5 已更新…」两段互不衔接的话，正是这个观感的来源。
   * 不设置时行为退化为「只清内部状态、不撤回 UI」，与修复前一致。
   */
  onStreamRestart?: (info: {
    reason: string;
    attempt?: number;
    discardedBlocks: number;
    discardedTextLength: number;
  }) => void;
}

/**
 * 处理流式响应，累积内容块（含心跳检测 + 整体超时）
 */
export async function processStream(
  stream: AsyncIterable<StreamEvent>,
  onText?: (text: string) => void,
  onThinking?: (text: string) => void,
  options?: StreamProcessorOptions,
): Promise<AccumulatedResponse> {
  const log = getLogger();
  const response: AccumulatedResponse = {
    role: "assistant",
    content: [],
    stopReason: null,
    usage: { inputTokens: 0, outputTokens: 0 },
  };

  // 用于累积工具调用的 JSON 分片
  const jsonAccumulators = new Map<number, string>();
  // 用于收集 thinking blocks（轨迹采集用）
  const thinkingBlocks: unknown[] = [];
  // 记录哪些 index 是 thinking 块
  const thinkingIndexes = new Set<number>();
  // SP1：每个 thinking 块的开始时间戳（首个 delta 到达时记录），用于在
  // content_block_stop 时算出 durationMs，持久化到 ThinkingBlock 供历史项显示耗时。
  const thinkingStartMs = new Map<number, number>();
  // 累积 reasoning 文本（DeepSeek reasoning_content 回传用）
  let accumulatedReasoning = "";
  // 5.1 / 方案①：provider 原始 output usage 是否为 0（在任何估算兜底之前的事实）。
  // 由 openai.ts 经 message_delta._rawOutputTokensZero 透传——这是判"未答复 end_turn"
  // 最硬的结构信号，且必须与"估算兜底后的 usage"解耦（估算会把值补成非零）。
  let rawOutputTokensZero = false;

  // P1（9bc92c2c 根因修复）：SSE event.index → content 数组实际位置的映射。
  // 某些第三方代理返回的 content_block index 不从 0 开始或不连续（如直接调用工具时
  // index=1 跳过 0），用 index 做数组下标会产生 undefined 空洞导致下游 TypeError。
  // 改为 push 到末尾 + 映射表查找，保证 content 数组始终密集。
  const indexToPosition = new Map<number, number>();

  // ── 超时配置（首字节 / 心跳 / 整体，共用一个定时器）──
  //
  // 2026-08-05 事故根因：这三个值此前是**就地硬编码字面量** 60_000 / 300_000，
  // 与 network-profile.ts 那套"保活优先"统一默认值（headerTimeoutMs 300s /
  // watchdogNoProgressMs 300s）完全脱节，且没有任何调用方传入覆盖——声明了
  // heartbeatTimeoutMs 选项，生产链路（app.ts → engine.ts → loop.ts）却一路不传，
  // 于是 60s 成了实际生效的**最紧**一层，把外层所有放宽配置全部架空：
  //   loop.ts 看门狗 300s、provider idle 300s、headerTimeout 300s 都还没到，
  //   这里 60s 先开枪 → abort("stream-heartbeat-timeout") → 上层认成可重试超时 → 重发。
  // 实测轨迹 20260805-193713-ecb68bbd：31 次中断的「发请求→被杀」间隔全部是 60.0s，
  // 而成功样本的首字节耗时 p95 已达 56s、最大 59.8s——阈值正好压在真实分布的右尾上，
  // 于是慢一点的请求 100% 必死，且每次重试都重新排队、再次撞线，形成用户看到的
  // 「不停重试、永不结束」。改配置也没用（这里读不到），只能改代码。
  //
  // 修法有三点，缺一不可：
  //   ① 默认值改为从 network-profile 派生（单一真相源，用户改 settings 即刻生效）；
  //   ② 首字节与心跳**分开计时**——等首字节（网关鉴权+排队+冷启动）和已建流后中途静默
  //      是两种性质完全不同的等待，用同一个阈值卡必然误杀慢的那种；
  //   ③ 由 app.ts 显式把 resolveLoopTimeouts 的结果传进来（见 app.ts processStream），
  //      避免"选项声明了但没人传"这类死配置再次发生。
  const netTimeouts = resolveLoopTimeouts({ network: options?.network });
  // PR12 已知缺口（**刻意留下，不是漏了**）：这里不传 `modelName`，所以本层的
  // OVERALL_TIMEOUT 吃不到 per-model 覆盖。原因是 `processStream` 的签名里根本没有
  // 模型身份（它拿到的是一个已经建好的流），硬要接就得从 loop 一路透传下来。
  //
  // 影响面可接受：per-model 的三项覆盖在 **provider 内部**（openai/anthropic 的四条路径）
  // 都已生效，那才是真正开枪杀流的地方；本层是外层软兜底，且默认值 1500s 远宽于
  // 任何 per-model 会调的量级。真需要时再透传，别为了"看起来接全了"提前加参数。
  const providerTimeouts = resolveProviderStreamTimeouts({ providerKind: "anthropic" });
  const HEARTBEAT_TIMEOUT = options?.heartbeatTimeoutMs ?? netTimeouts.watchdogNoProgressMs;
  const FIRST_BYTE_TIMEOUT = options?.firstByteTimeoutMs ?? netTimeouts.headerTimeoutMs;
  const OVERALL_TIMEOUT = options?.overallTimeoutMs ?? providerTimeouts.overallTimeoutMs;
  // 检查间隔：此前硬编码 5s，heartbeatCheckIntervalMs 声明了却未接线（死选项）。
  // 接上它——生产默认仍 5s，测试可注入短值快速触发心跳/整体超时路径。
  const CHECK_INTERVAL = options?.heartbeatCheckIntervalMs ?? 5_000;
  const startTime = Date.now();
  let lastActivityTime = Date.now();
  let timeoutError: Error | null = null;
  // 首字节是否已到达：决定用 FIRST_BYTE_TIMEOUT 还是 HEARTBEAT_TIMEOUT 判定静默。
  // 在流的第一个事件到达时置真（见下方主循环）。
  let firstEventReceived = false;

  // 记录"等待用户输入"累计时长：弹窗阻塞期间不应计入心跳/整体超时，否则等人答题
  // 会被误判成流 hang（事故复盘 20260721-142757）。用累加"扣除量"的方式把等待时段
  // 从两个超时的分母里剔除，答完自然恢复计时。
  let humanWaitStartedAt: number | null = null;
  let humanWaitAccumMs = 0;

  const checkInterval = setInterval(() => {
    const now = Date.now();

    // 闸门：正在阻塞等用户输入（如 fallback 询问弹窗）→ 本次不判超时，只记录等待起点。
    // 等待期间持续推进 lastActivityTime/扣除量，使答完后不会因"这段静默"立即被误杀。
    if (isAwaitingHumanInput()) {
      if (humanWaitStartedAt === null) humanWaitStartedAt = now;
      lastActivityTime = now; // 等待中视为"有活动"，避免心跳在等待中途误触
      return;
    }
    // 刚结束一段等待：累加等待时长到扣除量，并把活动时间对齐到现在。
    if (humanWaitStartedAt !== null) {
      humanWaitAccumMs += now - humanWaitStartedAt;
      humanWaitStartedAt = null;
      lastActivityTime = now;
    }

    // 整体超时检测（扣除累计的用户等待时段）
    if (now - startTime - humanWaitAccumMs > OVERALL_TIMEOUT) {
      timeoutError = new Error(`Stream overall timeout: ${OVERALL_TIMEOUT / 1000}s 总时长超限`);
      log.warn("STREAM", `整体超时: ${OVERALL_TIMEOUT / 1000}s`);
      // 根治（2026-07）：abort 时携带 reason。AbortSignal.reason 在首次 abort() 时被
      // 永久锁定，不受"abortPromise 与 timeoutError 谁赢得 Promise.race"影响——上层
      // query/loop.ts 据此结构性判定"该按超时重试"，而非依赖易被 abort-race 通用错误
      // 消息覆盖的文本匹配。reason 已登记于 llm/errors.ts ABORT_REASONS，避免孤儿
      // rejection 被 isAbortError 漏识别导致 process.exit(1)。
      options?.getAbortController?.()?.abort("stream-overall-timeout");
      clearInterval(checkInterval);
      return;
    }

    // ── 静默超时检测：首字节前后用不同阈值（2026-08-05 事故根因修复）──
    //
    // 首字节前（firstEventReceived=false）：这段等待是"网关鉴权 + 排队 + 模型冷启动"，
    // 慢是常态而非故障，用 FIRST_BYTE_TIMEOUT（= headerTimeoutMs，默认 300s）。
    // 首字节后：流已建立还中途静默才是真可疑，用 HEARTBEAT_TIMEOUT（默认 300s，
    // 与 loop.ts 外层看门狗 watchdogNoProgressMs 同源）。
    //
    // 两者共用 lastActivityTime 作基准是刻意的：首字节前它就是请求发出时刻，
    // 首字节后它是最近一个事件时刻——语义都是"距上次有动静多久"，只是容忍度不同。
    const silenceLimit = firstEventReceived ? HEARTBEAT_TIMEOUT : FIRST_BYTE_TIMEOUT;
    if (now - lastActivityTime > silenceLimit) {
      const label = firstEventReceived ? "心跳" : "首字节";
      timeoutError = new Error(
        `Stream ${firstEventReceived ? "heartbeat" : "first-byte"} timeout: ` +
          `${silenceLimit / 1000}s 无数据`,
      );
      log.warn("STREAM", `${label}超时: ${silenceLimit / 1000}s 无数据`);
      // 根治（2026-07）：同上，abort 时携带 reason（心跳超时）。
      // 首字节超时刻意复用同一个 reason：它同样是"内部超时、应重试"，下游 loop.ts /
      // errors.ts 的 ABORT_REASONS 判定逻辑无需改动即可正确识别（新增 reason 必须
      // 同步登记白名单，见 memory esc-abort-reason-crash-coupling）。
      options?.getAbortController?.()?.abort("stream-heartbeat-timeout");
      clearInterval(checkInterval);
    }
  }, CHECK_INTERVAL);

  try {
    // P0-2 修复：将 `for await` 改为手动迭代 + Promise.race(abortPromise)。
    // 当 SSE 半开时 reader.read() 永不 settle，timeoutError 检查永远执行不到。
    // 通过 race abort（来自 getAbortController），abort 触发时立即 reject。
    const abortCtl = options?.getAbortController?.();
    const abortSignal = abortCtl?.signal;
    const abortPromise: Promise<never> | null = (() => {
      if (!abortSignal || abortSignal.aborted) return null;
      return new Promise<never>((_, reject) => {
        // 根治（2026-07）：把 signal.reason 一并挂到 RequestAbortedError 上。
        // 这样即使这个"措辞通用的 abort-race 错误"抢先赢下 Promise.race（真正 hang 死的
        // iterator.next() 永远不会 resolve），下游 query/loop.ts 仍能从 err.abortReason
        // 结构性识别出这是"内部超时自愈中断"而非"用户 ESC 取消"，不再依赖错误消息文本。
        const onAbort = () =>
          reject(new RequestAbortedError("Stream aborted (abort race)", abortSignal.reason));
        abortSignal.addEventListener("abort", onAbort, { once: true });
      });
    })();

    const iterator = stream[Symbol.asyncIterator]();
    let iterDone = false;
    while (!iterDone) {
      const racers: Promise<IteratorResult<StreamEvent>>[] = [iterator.next()];
      if (abortPromise) racers.push(abortPromise as any);
      const iterResult = await Promise.race(racers);
      if (iterResult.done) {
        iterDone = true;
        break;
      }
      const event = iterResult.value;

      lastActivityTime = Date.now();
      // 首个事件到达 → 后续静默改用（更严的）心跳阈值判定。
      firstEventReceived = true;

      // 关键修复：每次事件前检查超时标志，一旦超时就抛错主动退出循环
      if (timeoutError) {
        throw timeoutError;
      }

      switch (event.type) {
        case "message_start":
          accumulateUsage(response.usage, event.message.usage);
          break;

        // 流重开 → 上一次尝试的内容块全部作废（2026-08-04 事故根因修复）。
        // usage 刻意不回退：作废尝试的 token 是真实计费的，回退会让 cost 少采。
        case "stream_restart": {
          const outcome = resetOnStreamRestart({
            content: response.content,
            indexToPosition,
            jsonAccumulators,
            thinkingIndexes,
            thinkingStartMs,
            thinkingBlocks,
          });
          // reasoning 也要清：它累加的是**已作废**那次尝试的思考文本，留着会经
          // _meta.reasoning_content 回传给模型，让模型看到自己"说过"但实际作废的话。
          accumulatedReasoning = "";
          // rawOutputTokensZero 复位：它是"本次响应 output 为 0"的结构信号，
          // 由作废尝试置位后若不清，会让下一次完整响应被误判成"未答复 end_turn"。
          rawOutputTokensZero = false;
          recordStreamRestart(event, outcome, "main");
          try {
            options?.onStreamRestart?.({
              reason: event.reason,
              attempt: event.attempt,
              ...outcome,
            });
          } catch (e) {
            // UI 撤回失败绝不影响流处理主流程（与 onToolUseComplete 同取向）。
            log.warn(
              "STREAM",
              `onStreamRestart 回调异常（忽略）: ${e instanceof Error ? e.message : String(e)}`,
            );
          }
          break;
        }

        case "content_block_start": {
          // 纵深防御：正常情况下同一 index 不该重复 start。命中说明有一条重开路径
          // 绕过了 stream_restart 广播（新增 provider / 新增重试分支时的典型漏点）——
          // 打 warn 让它显形，而不是静默拼接出语义错乱的响应。
          // 这里只告警不阻断：真实信号仍以 stream_restart 为准，本检查是哨兵而非判据。
          if (indexToPosition.has(event.index)) {
            log.warn(
              "STREAM",
              `content_block_start 收到重复 index=${event.index}（已存在映射）：` +
                `疑有重开路径未广播 stream_restart，可能拼接出错乱响应`,
            );
          }
          const pos = response.content.length; // push 到末尾，保证数组密集
          indexToPosition.set(event.index, pos);
          if (event.content_block.type === "text") {
            response.content.push({ type: "text", text: "" });
            if (event._raw_block && (event._raw_block as any).type === "thinking") {
              thinkingIndexes.add(event.index);
              // SP1：起点在 block_start 而非首 delta，把开头等待时间计入耗时，
              // 与 content_block_stop 的时间差才是真实思考时长。
              thinkingStartMs.set(event.index, Date.now());
            }
          } else if (event.content_block.type === "tool_use") {
            response.content.push({
              type: "tool_use",
              id: event.content_block.id,
              name: event.content_block.name,
              input: {},
            });
            jsonAccumulators.set(event.index, "");
          } else if ((event.content_block as any).type === "thinking") {
            // Anthropic SDK 直接发来 thinking 类型块（非通过 text + _raw_block 通道）
            response.content.push({ type: "text", text: "" });
            thinkingIndexes.add(event.index);
            thinkingStartMs.set(event.index, Date.now());
          } else if ((event.content_block as any).type === "redacted_thinking") {
            // redacted_thinking 块：必须原样保留用于多轮回传
            // [来源: anthropic-api.md:356-357]
            response.content.push({
              type: "redacted_thinking" as any,
              data: (event.content_block as any).data || "",
            });
          }
          break;
        }

        case "content_block_delta": {
          const pos = indexToPosition.get(event.index);
          if (pos === undefined) break; // 未知 index 的 delta，忽略
          const delta = event.delta;
          if (delta.type === "text_delta") {
            const block = response.content[pos];
            if (block?.type === "text") {
              block.text += delta.text;
              // 对标 Claude Code：思考块不调 onText，调 onThinking
              if (thinkingIndexes.has(event.index)) {
                onThinking?.(delta.text);
              } else {
                onText?.(delta.text);
              }
            }
          } else if (delta.type === "input_json_delta") {
            const acc = jsonAccumulators.get(event.index) ?? "";
            jsonAccumulators.set(event.index, acc + delta.partial_json);
          }
          break;
        }

        case "content_block_stop": {
          const pos = indexToPosition.get(event.index);
          if (pos === undefined) break; // 未知 index，忽略
          const jsonStr = jsonAccumulators.get(event.index);
          if (jsonStr !== undefined) {
            const block = response.content[pos];
            if (block?.type === "tool_use") {
              // O(n) 设计：拼接字符串 + 最终一次性解析，不做增量 parse（对齐 CC raw stream 策略）
              try {
                block.input = normalizeToolInput(jsonStr ? JSON.parse(jsonStr) : {});
              } catch (e) {
                // telemetry: 工具输入 JSON 解析失败（对齐 CC tengu_tool_input_json_parse_fail）
                log.warn("STREAM", `工具输入 JSON 解析失败`, {
                  toolName: block.name,
                  inputLength: jsonStr.length,
                  error: e instanceof Error ? e.message : String(e),
                  inputHead: jsonStr.slice(0, 200),
                });
                block.input = {};
              }
              // GAP-01：tool_use 块完整解析完成 → 立即回调，供流式工具执行器抢跑。
              // 回调异常绝不影响流处理（吞掉）。
              if (options?.onToolUseComplete) {
                try {
                  options.onToolUseComplete(block as ToolUseBlock);
                } catch (e) {
                  log.warn(
                    "STREAM",
                    `onToolUseComplete 回调异常（忽略）: ${e instanceof Error ? e.message : String(e)}`,
                  );
                }
              }
            }
            jsonAccumulators.delete(event.index);
          }
          if (thinkingIndexes.has(event.index)) {
            const block = response.content[pos];
            if (block?.type === "text" && block.text) {
              // SP1：算出该思考块耗时（block_start → stop）；无起点则不附。
              const startedAt = thinkingStartMs.get(event.index);
              const durationMs =
                startedAt !== undefined ? Math.max(0, Date.now() - startedAt) : undefined;
              // 原地转型为 ThinkingBlock（保留在 content 中，对标 Claude Code）
              // § 把 anthropic.ts 累积的 signature 从 _raw_block 中提取
              const rawBlock = (event as any)._raw_block;
              const signature = rawBlock?.signature;
              const thinkingBlock = {
                type: "thinking" as const,
                thinking: block.text,
                ...(signature ? { signature } : {}),
                ...(durationMs !== undefined ? { durationMs } : {}),
              };
              response.content[pos] = thinkingBlock;
              thinkingBlocks.push(thinkingBlock);
              accumulatedReasoning += block.text;
            }
            thinkingIndexes.delete(event.index);
            thinkingStartMs.delete(event.index);
          }
          break;
        }

        case "message_delta":
          response.stopReason = event.delta.stop_reason;
          // 统一走 accumulateUsage：累加 input/output 并补齐 cacheRead/cacheCreation
          // （DeepSeek 命中在最终 usage chunk 经 message_delta 到达，缺了会按全价算）
          accumulateUsage(response.usage, event.usage);
          // 5.1 / 方案①：捕获 provider 原始 output 是否为 0（估算兜底前的事实）。
          // 任一 message_delta 报"原始为 0"即置位——聚合 usage 可能被 estimator 补成非零，
          // 故不能用 response.usage 反推，必须用此独立标记。
          if ((event as any)._rawOutputTokensZero === true) {
            rawOutputTokensZero = true;
          }
          break;

        case "error":
          throw new Error(`LLM 错误: ${event.error.message}`);

        case "system_api_error":
          // 重试进度提示统一由 RetryStatus 组件承载（app.ts onRetry/onFallback 回调 →
          // TUIState.retryStatus，带实时倒计时 + 限流升级建议 + 按 kind 分色）。此处不再
          // 经 onText 打进消息流，避免与 RetryStatus 组件双行重复（见去重方案）。
          // 与子代理侧 agent/stream-processor.ts 的静默处理对齐。
          break;
      }
    }
  } catch (err) {
    // 用量口径修复（P0-2 C 组）：把**已累加的 usage** 挂到即将抛出的错误上再重抛。
    //
    // 为什么需要这条旁路：本函数一旦抛错（超时 / 流内 error），`response` 连同它累加好的
    // usage 一起被丢弃 —— 调用方 loop.ts 的 catch 只拿到一个 Error，随后 `continue`
    // 重试，`updateUsage` 根本没被调到。而这次尝试的 prompt **已经完整发到服务端**
    //（厂商按收到的 prompt 计费，不管客户端后来是否丢弃响应），钱是真花了。
    //
    // 实测证据（2026-08-11 事故）：`HttpConnected(status=200)` 254 次、记账 153 次 ——
    // 差的 101 次全走这条路径，约 12M token 的隐性开销在轨迹里完全不可见
    //（轨迹自报 22.4M，用户真实账单对应 30.6M）。
    //
    // 注意与 `stream_restart` 的分工，两者**不重复计**：
    // - 流**内部**重开（fallback.ts 重连）：usage 跨 attempt 累加进同一个 response，
    //   由 stream-restart.ts 保证"不回退"，最终随正常返回一起记账，与本处无关；
    // - 流**整体**抛错（本处）：response 被丢弃，只能靠这个旁路把已花的量交出去。
    // 判据取"是否真的累加到了量"，0 不挂（挂上去只会让下游多一次空记账）。
    if (err instanceof Error && response.usage.inputTokens + response.usage.outputTokens > 0) {
      (err as Error & { discardedUsage?: Usage }).discardedUsage = { ...response.usage };
    }
    throw err;
  } finally {
    clearInterval(checkInterval);
  }

  if (timeoutError) {
    throw timeoutError;
  }

  // 流结束日志（区分文本块和思考块）
  const totalTextLen = response.content
    .filter((b) => b.type === "text")
    .reduce((sum, b) => sum + (b.type === "text" ? b.text.length : 0), 0);
  const thinkingCount = response.content.filter((b) => b.type === "thinking").length;
  const toolCallCount = response.content.filter((b) => b.type === "tool_use").length;
  log.info(
    "STREAM",
    `流结束: 文本${totalTextLen}字符, 思考${thinkingCount}块, 工具调用${toolCallCount}个, stop=${response.stopReason}, in=${response.usage.inputTokens} out=${response.usage.outputTokens}`,
  );

  if (thinkingBlocks.length > 0) {
    (response as any)._thinkingBlocks = thinkingBlocks;
  }

  // DeepSeek reasoning_content: 存到 _meta 供 convertMessages 回传
  if (accumulatedReasoning) {
    response._meta = { ...response._meta, reasoning_content: accumulatedReasoning };
  }

  // 内联 <think> 标签后处理：部分 OpenAI 兼容模型（GPT-5.4、QwQ 等）不通过
  // reasoning_content 字段、也不通过 _raw_block 标记思考块，而是直接在文本中
  // 内联 <think>...</think> 标签。流式累积完成后统一检测并拆分。
  // 仅在没有已识别的 thinking 块时处理（避免与 DeepSeek reasoning_content 重复）。
  if (thinkingBlocks.length === 0) {
    for (let i = 0; i < response.content.length; i++) {
      const block = response.content[i];
      if (block.type !== "text" || !block.text.trimStart().startsWith("<think>")) continue;
      const thinkMatch = block.text.match(/^[\s]*<think>([\s\S]*?)<\/think>/);
      if (!thinkMatch) continue;
      const thinkText = thinkMatch[1]?.trim() ?? "";
      const remaining = block.text.slice(thinkMatch[0].length).trim();
      // 拆分：thinking 块插入当前位置，text 块跟在后面
      const newBlocks: ContentBlock[] = [];
      if (thinkText) {
        newBlocks.push({ type: "thinking", thinking: thinkText });
      }
      if (remaining) {
        newBlocks.push({ type: "text", text: remaining });
      }
      if (newBlocks.length > 0) {
        response.content.splice(i, 1, ...newBlocks);
      }
      break; // 通常只有一个 think 块在文本开头
    }
  }

  // 思考块已原地转型为 ThinkingBlock 保留在 content 中，不再需要过滤移除

  // <internal_en> 归位（与上面的内联 <think> 同一取向：**归位，不是删除**）。
  //
  // 中文铁律模式的提示词允许推理易漂移的模型（deepseek 全系）把英文技术思考包进
  // <internal_en>（见 system-prompt.ts「思考语言疏导」段）。旧实现只定义了这个协议，
  // 却没有任何剥离路径——模型一照做，裸标签就连同英文推理直接渲染进 TUI 正文，
  // 恰好破坏了这个模式想达成的"用户只看到纯中文"。
  //
  // 这里把标签内容转成 thinking 块：思考区照常可见、可回放给下一轮，正文保持纯中文。
  // 与 <think> 的差异是 internal_en 可能出现多次且在中间位置，故全局匹配（见 prompt-lang.ts）。
  for (let i = response.content.length - 1; i >= 0; i--) {
    const block = response.content[i];
    if (block?.type !== "text" || !block.text.toLowerCase().includes("internal_en")) continue;
    const { thinking, text } = extractInternalEnTags(block.text);
    if (!thinking) continue;
    const newBlocks: ContentBlock[] = [{ type: "thinking", thinking }];
    if (text) newBlocks.push({ type: "text", text });
    response.content.splice(i, 1, ...newBlocks);
  }

  // 「未答复的 end_turn」统一识别（方案①/②，deepseek-reasoning-leak 修复）。
  // 抽到 unanswered-end-turn.ts 纯函数，与非流式降级路径共用，避免行为漂移。
  // 放在 <think> / <internal_en> 拆分之后——先让内联思考归位，再判是否真答复，避免误判
  //（整段回复都包在 <internal_en> 里时，剥离后 text 为空，此时才该判为"未答复"）。
  detectUnansweredEndTurn(response, rawOutputTokensZero);

  // ── 未收尾的 tool_use 块 → 标记「被截断」，让下游能与"模型真退化"区分开 ──
  //
  // 2026-08-04 事故的第三个面：`input={}` 有两种完全不同的成因，而下游 F1 此前
  // 无法区分，一律按"模型生成了空参数"归因：
  //   ① 模型真退化：正常收到 content_block_stop，但 input 确实是 {}
  //   ② 流被截断：input_json_delta 传了一半，socket 关闭，**stop 事件从未到达**
  // 事故里是 ②（`warn.log` 无"JSON 解析失败"，说明压根没收到收尾），却被报成 ①。
  //
  // 判据是**结构事实**而非猜测：`jsonAccumulators` 里还留着 key，就证明该 index 的
  // content_block_stop 没来过（stop 分支会 delete）。这是本地可判、无需依赖上游信号的
  // 硬信号——即便某条重开路径漏了 stream_restart 广播，这里仍能如实标注。
  if (jsonAccumulators.size > 0) {
    for (const [index, partial] of jsonAccumulators) {
      const pos = indexToPosition.get(index);
      if (pos === undefined) continue;
      const block = response.content[pos];
      if (block?.type !== "tool_use") continue;
      // 半截 JSON 尽力一解：能解出对象就用（可能刚好停在合法边界），
      // 解不出就维持 {} 并打上截断标记，交由 F1 走"未落地、请重发"路径。
      let recovered = false;
      if (partial) {
        try {
          const parsed = JSON.parse(partial);
          if (parsed && typeof parsed === "object" && Object.keys(parsed).length > 0) {
            block.input = normalizeToolInput(parsed);
            recovered = true;
          }
        } catch {
          // 半截 JSON 解不开是预期情形，不是异常
        }
      }
      (block as ToolUseBlock & { _truncated?: boolean })._truncated = !recovered;
      log.warn(
        "STREAM",
        `工具 ${block.name} 的 content_block_stop 未到达（流被截断）：` +
          `已累积 ${partial.length} 字符参数 JSON，${recovered ? "半截 JSON 解析成功" : "无法解析，input 保持 {}"}`,
      );
    }
    jsonAccumulators.clear();
  }

  // P0-1（9bc92c2c 根因修复最终防线）：过滤掉可能残余的 undefined 空洞。
  // 正常情况下 P1 的 push + indexToPosition 已保证数组密集，此处为纵深防御。
  response.content = response.content.filter(Boolean);

  return response;
}
