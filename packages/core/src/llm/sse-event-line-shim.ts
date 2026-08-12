/**
 * SSE `event:` 行注入 shim（§2.3）
 * ================================
 *
 * 背景：`@anthropic-ai/sdk` 的 SSE 解析器（core/streaming）**只在 `sse.event`
 * 字段匹配到已知事件类型时才派发事件**。标准 Anthropic SSE 每个事件同时带
 * `event:` 行和 `data:` 行：
 *
 *   event: message_start
 *   data: {"type":"message_start","message":{...}}
 *
 * 其中 `data` 的 JSON 里已经有 `"type"` 字段——`event:` 行在语义上冗余，但
 * **是 SDK 解析器的硬性要求**。部分第三方 Anthropic 兼容代理只发 `data:` 行、
 * 省略 `event:` 行，此时 SDK 的 `sse.event` 恒为 null，匹配不到任何已知类型，
 * **所有事件被静默丢弃**，最终抛 `request ended without sending any chunks`。
 * 报错点离根因极远（看起来像"模型不回话"），排查成本极高。
 *
 * 证据：earendil-works/pi #1983。
 *
 * 本 shim 给 Anthropic client 传一个自定义 fetch：仅当响应是 text/event-stream
 * 时介入，用 TransformStream 逐行扫描响应体，检测到某个事件的 `data:` 行 JSON 含
 * `"type"` 字段但**前面没有 `event:` 行**时，自动补注入 `event: <type>\n`。
 * 对规范代理（已带 `event:` 行）**完全透传、零影响**（逐字节一致）。
 *
 * 开关：环境变量 `SIDCODE_SSE_EVENT_SHIM`
 *   - `auto`（默认）：仅在检测到缺失时介入，并打一次 warn 遥测（便于发现哪些代理有此问题）。
 *   - `off`：完全旁路，直接用 baseFetch。
 *   - `force`：强制走 shim 变换逻辑（调试用）。
 *
 * 原则：纯响应体变换，不碰请求；规范代理路径零变化；对非 SSE 响应原样返回。
 */

import { getLogger } from "../debug/logger.ts";

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

type ShimMode = "auto" | "off" | "force";

function resolveMode(): ShimMode {
  const raw = (process.env.SIDCODE_SSE_EVENT_SHIM ?? "auto").toLowerCase().trim();
  if (raw === "off") return "off";
  if (raw === "force") return "force";
  return "auto";
}

/**
 * 从一行 `data:` 内容里安全提取 JSON 的 `.type` 字段。
 * - 只接受能 JSON.parse 成对象且 type 为非空字符串的情况。
 * - 任何异常（非 JSON、无 type、type 非字符串）都返回 null（不注入、不崩溃）。
 */
function extractTypeFromDataLine(dataLine: string): string | null {
  // dataLine 形如 "data: {...}" 或 "data:{...}"（冒号后可有可无空格）。
  const colonIdx = dataLine.indexOf(":");
  if (colonIdx === -1) return null;
  const payload = dataLine.slice(colonIdx + 1).trim();
  if (!payload || payload[0] !== "{") return null; // 只处理 JSON 对象负载
  try {
    const obj = JSON.parse(payload);
    if (obj && typeof obj === "object" && typeof obj.type === "string" && obj.type.length > 0) {
      return obj.type;
    }
  } catch {
    /* 非完整 JSON（理论上不该发生，因为按行处理时该行已完整）→ 不注入 */
  }
  return null;
}

/**
 * 创建一个逐行处理 SSE 文本的 TransformStream。
 *
 * 状态机（按 SSE 规范：事件之间以空行分隔）：
 *   - 遇到以 "event:" 开头的行 → 标记本事件已有 event 行，原样透传。
 *   - 遇到以 "data:" 开头的行且本事件尚无 event 行 → 解析 JSON 取 .type，
 *     若存在则先注入 "event: <type>\n" 再透传该 data 行；标记本事件已注入。
 *   - 空行（事件分隔）→ 重置"本事件已有 event 行"标志。
 *
 * 跨 chunk 半行：保留未以 \n 结束的尾部到 buffer，与下一个 chunk 拼接后再处理。
 *
 * @param onInject 首次注入时的回调（用于 auto 模式打一次遥测）。
 */
function createEventLineTransform(onInject?: () => void): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  let buffer = "";
  // 本事件是否已出现 event: 行（跨 chunk 保持）。
  let eventLineSeenInCurrentEvent = false;
  let hasInjected = false;

  /** 处理一整行（不含结尾的 \n），返回应当输出的文本（可能前置注入 event 行）。 */
  function processLine(line: string): string {
    // SSE 行可能带 \r（CRLF）。判断前缀时忽略尾部 \r，但输出保持原样。
    const trimmedRight = line.replace(/\r$/, "");

    if (trimmedRight === "") {
      // 空行 = 事件分隔符 → 重置状态。
      eventLineSeenInCurrentEvent = false;
      return line + "\n";
    }

    if (trimmedRight.startsWith("event:")) {
      eventLineSeenInCurrentEvent = true;
      return line + "\n";
    }

    if (trimmedRight.startsWith("data:")) {
      if (!eventLineSeenInCurrentEvent) {
        const type = extractTypeFromDataLine(trimmedRight);
        if (type) {
          eventLineSeenInCurrentEvent = true; // 视同已补上 event 行
          if (!hasInjected) {
            hasInjected = true;
            onInject?.();
          }
          return `event: ${type}\n${line}\n`;
        }
      }
      return line + "\n";
    }

    // 其他行（注释 ":", id:, retry: 等）原样透传。
    return line + "\n";
  }

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });

      // 按 \n 切分。最后一段若不以 \n 结尾则是半行，留到下次。
      let nlIdx: number;
      let out = "";
      while ((nlIdx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nlIdx); // 不含 \n
        buffer = buffer.slice(nlIdx + 1);
        out += processLine(line);
      }
      if (out) controller.enqueue(encoder.encode(out));
    },
    flush(controller) {
      // 处理 decoder 内部残留的多字节尾巴。
      buffer += decoder.decode();
      if (buffer.length > 0) {
        // 末尾无 \n 的残行：按行逻辑处理但不额外补 \n（保持原始字节边界）。
        // 注意：processLine 会补 \n，这里剥掉以免改变末尾。
        const processed = processLine(buffer);
        const emit =
          processed.endsWith("\n") && !buffer.endsWith("\n") ? processed.slice(0, -1) : processed;
        buffer = "";
        if (emit) controller.enqueue(encoder.encode(emit));
      }
    },
  });
}

/**
 * 包装一个 fetch：对 text/event-stream 响应体注入缺失的 `event:` 行。
 *
 * @param baseFetch 底层 fetch（默认全局 fetch）。
 * @returns 包装后的 fetch，签名与原 fetch 一致。
 */
export function wrapFetchWithEventLineShim(baseFetch?: FetchLike): FetchLike {
  const underlying: FetchLike = baseFetch ?? ((input, init) => fetch(input as any, init));

  return async function shimmedFetch(input, init): Promise<Response> {
    const mode = resolveMode();
    const res = await underlying(input, init);

    if (mode === "off") return res;

    // 仅介入 SSE 响应；其他响应（JSON 错误页、非流式等）原样返回。
    const contentType = res.headers.get("content-type") || "";
    if (!contentType.toLowerCase().includes("text/event-stream")) {
      return res;
    }
    if (!res.body) return res;

    const log = getLogger();
    let warned = false;
    const onInject = () => {
      if (warned) return;
      warned = true;
      // auto/force 都打这条 warn：说明该代理省略了 event: 行（sid-code 已自动兜住）。
      log.warn(
        "LLM:SSE_SHIM",
        "检测到 SSE 流缺失 event: 行，已自动补注入（疑似第三方代理协议偏差；见 §2.3 / earendil-works/pi #1983）",
        { url: typeof input === "string" ? input : String((input as any)?.url ?? input) },
      );
    };

    const transformed = res.body.pipeThrough(createEventLineTransform(onInject));

    // 用变换后的 body 重建 Response，保留原 status / statusText / headers。
    return new Response(transformed, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  };
}

// 供测试直接验证行处理逻辑（不经 fetch）。
export const __test__ = { createEventLineTransform, extractTypeFromDataLine };
