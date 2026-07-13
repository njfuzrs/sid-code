/**
 * §2.3 SSE `event:` 行注入 shim 测试
 * ===================================
 *
 * 覆盖方案验证清单：
 *  1. 省略 event: 行的 mock SSE → shim 后能解析出完整事件序列（不再丢流）。
 *  2. 标准带 event: 行的 SSE → shim 透传，逐字节一致（零影响证明）。
 *  3. 跨 chunk 半行边界正确处理。
 *  4. data: 行 JSON 无 type 字段 → 不注入、不崩溃、原样透传。
 *  5. SIDCODE_SSE_EVENT_SHIM=off → 完全旁路。
 */

import { describe, test, expect, afterEach } from "bun:test";
import {
  wrapFetchWithEventLineShim,
  __test__,
} from "../../src/llm/sse-event-line-shim.ts";

const { createEventLineTransform, extractTypeFromDataLine } = __test__;

/** 把一串 Uint8Array chunks 喂进 transform，收集输出并解码成字符串。 */
async function runTransform(chunks: string[]): Promise<string> {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const ts = createEventLineTransform();
  const writer = ts.writable.getWriter();
  const reader = ts.readable.getReader();

  const outChunks: Uint8Array[] = [];
  const readAll = (async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) outChunks.push(value);
    }
  })();

  for (const c of chunks) await writer.write(enc.encode(c));
  await writer.close();
  await readAll;

  return outChunks.map((c) => dec.decode(c)).join("");
}

/** 构造一个返回 SSE body 的 mock fetch。 */
function mockSseFetch(body: string, contentType = "text/event-stream") {
  return async (): Promise<Response> =>
    new Response(body, {
      status: 200,
      statusText: "OK",
      headers: { "content-type": contentType },
    });
}

async function readResponseText(res: Response): Promise<string> {
  return await res.text();
}

const ORIGINAL_MODE = process.env.SIDCODE_SSE_EVENT_SHIM;
afterEach(() => {
  if (ORIGINAL_MODE === undefined) delete process.env.SIDCODE_SSE_EVENT_SHIM;
  else process.env.SIDCODE_SSE_EVENT_SHIM = ORIGINAL_MODE;
});

describe("extractTypeFromDataLine", () => {
  test("正常 JSON 带 type", () => {
    expect(extractTypeFromDataLine('data: {"type":"message_start","message":{}}')).toBe(
      "message_start",
    );
  });
  test("冒号后无空格", () => {
    expect(extractTypeFromDataLine('data:{"type":"ping"}')).toBe("ping");
  });
  test("无 type 字段 → null", () => {
    expect(extractTypeFromDataLine('data: {"foo":"bar"}')).toBeNull();
  });
  test("非 JSON 对象负载 → null", () => {
    expect(extractTypeFromDataLine("data: [DONE]")).toBeNull();
  });
  test("type 非字符串 → null", () => {
    expect(extractTypeFromDataLine('data: {"type":123}')).toBeNull();
  });
});

describe("createEventLineTransform — 行处理", () => {
  test("场景1：省略 event: 行 → 自动补注入", async () => {
    const input =
      'data: {"type":"message_start","message":{}}\n' +
      "\n" +
      'data: {"type":"content_block_start","index":0}\n' +
      "\n" +
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n' +
      "\n";
    const out = await runTransform([input]);

    // 每个 data 行前应补上对应的 event 行。
    expect(out).toContain("event: message_start\n");
    expect(out).toContain("event: content_block_start\n");
    expect(out).toContain("event: content_block_delta\n");
    // data 行本身保留。
    expect(out).toContain('data: {"type":"message_start","message":{}}');
    // event 行紧贴在 data 行之前。
    expect(out.indexOf("event: message_start")).toBeLessThan(
      out.indexOf('data: {"type":"message_start"'),
    );
  });

  test("场景2：已带 event: 行 → 逐字节透传，零影响", async () => {
    const input =
      "event: message_start\n" +
      'data: {"type":"message_start","message":{}}\n' +
      "\n" +
      "event: content_block_delta\n" +
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n' +
      "\n";
    const out = await runTransform([input]);
    expect(out).toBe(input);
    // 不应出现重复的 event 行。
    expect(out.match(/event: message_start/g)?.length).toBe(1);
  });

  test("场景3：跨 chunk 半行边界正确处理", async () => {
    // data 行 JSON 被从中间切成两个 chunk 到达。
    const chunks = [
      'data: {"ty',
      'pe":"content_block_delta","index":0}\n\n',
    ];
    const out = await runTransform(chunks);
    expect(out).toContain("event: content_block_delta\n");
    expect(out).toContain('data: {"type":"content_block_delta","index":0}');
  });

  test("场景3b：event 行也跨 chunk", async () => {
    const chunks = [
      "event: mess",
      "age_start\n",
      'data: {"type":"message_start"}\n\n',
    ];
    const out = await runTransform(chunks);
    // 已有 event 行（拼接后识别到），不应再注入第二个 event 行。
    expect(out.match(/event:/g)?.length).toBe(1);
    expect(out).toContain("event: message_start\n");
  });

  test("场景4：data 行无 type → 不注入、原样透传", async () => {
    const input = 'data: {"foo":"bar"}\n\n';
    const out = await runTransform([input]);
    expect(out).toBe(input);
    expect(out).not.toContain("event:");
  });

  test("场景4b：data: [DONE] 之类非 JSON → 原样透传", async () => {
    const input = "data: [DONE]\n\n";
    const out = await runTransform([input]);
    expect(out).toBe(input);
  });

  test("CRLF 行结尾也能识别并注入", async () => {
    const input = 'data: {"type":"ping"}\r\n\r\n';
    const out = await runTransform([input]);
    expect(out).toContain("event: ping\n");
    expect(out).toContain('data: {"type":"ping"}\r\n');
  });

  test("末尾无换行的残行也被处理", async () => {
    const input = 'data: {"type":"message_stop"}';
    const out = await runTransform([input]);
    expect(out).toContain("event: message_stop\n");
    expect(out).toContain('data: {"type":"message_stop"}');
    // 不应在原本没有换行的末尾凭空加换行。
    expect(out.endsWith("\n")).toBe(false);
  });
});

describe("wrapFetchWithEventLineShim — fetch 包装", () => {
  test("对 event-stream 响应注入 event 行", async () => {
    const body = 'data: {"type":"message_start"}\n\n';
    const shimmed = wrapFetchWithEventLineShim(mockSseFetch(body));
    const res = await shimmed("https://proxy.example/v1/messages");
    const text = await readResponseText(res);
    expect(text).toContain("event: message_start\n");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
  });

  test("对非 SSE 响应原样返回（不介入）", async () => {
    const body = '{"error":"boom"}';
    const shimmed = wrapFetchWithEventLineShim(mockSseFetch(body, "application/json"));
    const res = await shimmed("https://proxy.example/v1/messages");
    const text = await readResponseText(res);
    expect(text).toBe(body);
  });

  test("场景5：SIDCODE_SSE_EVENT_SHIM=off → 完全旁路", async () => {
    process.env.SIDCODE_SSE_EVENT_SHIM = "off";
    const body = 'data: {"type":"message_start"}\n\n';
    const shimmed = wrapFetchWithEventLineShim(mockSseFetch(body));
    const res = await shimmed("https://proxy.example/v1/messages");
    const text = await readResponseText(res);
    // off 模式不注入。
    expect(text).toBe(body);
    expect(text).not.toContain("event:");
  });

  test("规范 SSE（已带 event 行）经包装后逐字节一致", async () => {
    const body =
      "event: message_start\n" +
      'data: {"type":"message_start"}\n\n';
    const shimmed = wrapFetchWithEventLineShim(mockSseFetch(body));
    const res = await shimmed("https://proxy.example/v1/messages");
    const text = await readResponseText(res);
    expect(text).toBe(body);
  });
});
