/**
 * Phase 2 单测：StructuredIO（NDJSON 双向通信）
 */

import { describe, test, expect } from "bun:test";
import { PassThrough } from "node:stream";
import { z } from "zod";
import { StructuredIO } from "@sid-code/core/sdk/structured-io.ts";
import { ndjsonStringify } from "@sid-code/core/sdk/ndjson.ts";
import type { SDKMessage } from "@sid-code/core/sdk/types.ts";

/** 读取 PassThrough 输出的所有 NDJSON 行（已解析） */
function collectOutput(stream: PassThrough): Promise<unknown[]> {
  return new Promise((resolve) => {
    let buf = "";
    stream.on("data", (c) => (buf += c.toString("utf-8")));
    stream.on("end", () => {
      const lines = buf
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => JSON.parse(l));
      resolve(lines);
    });
  });
}

describe("StructuredIO.write", () => {
  test("写出 NDJSON 行", async () => {
    const out = new PassThrough();
    const io = new StructuredIO(new PassThrough(), out);
    const collected = collectOutput(out);

    const msg: SDKMessage = {
      type: "system",
      subtype: "status",
      message: "hello",
    };
    await io.write(msg);
    out.end();

    const lines = await collected;
    expect(lines).toEqual([msg]);
  });

  test("多条消息不交错（写队列序列化）", async () => {
    const out = new PassThrough();
    const io = new StructuredIO(new PassThrough(), out);
    const collected = collectOutput(out);

    const msgs: SDKMessage[] = Array.from({ length: 5 }, (_, i) => ({
      type: "system",
      subtype: "status",
      message: `m${i}`,
    }));
    // 并发触发 write，不 await 中间结果
    await Promise.all(msgs.map((m) => io.write(m)));
    out.end();

    const lines = (await collected) as { message: string }[];
    expect(lines.map((l) => l.message)).toEqual(["m0", "m1", "m2", "m3", "m4"]);
  });
});

describe("StructuredIO.read", () => {
  test("yield user 消息，忽略 keep_alive", async () => {
    const input = new PassThrough();
    const io = new StructuredIO(input, new PassThrough());

    const userMsg = {
      type: "user",
      uuid: "u1",
      session_id: "s1",
      message: { role: "user", content: [{ type: "text", text: "hi" }] },
    };

    input.write(ndjsonStringify({ type: "keep_alive" }) + "\n");
    input.write(ndjsonStringify(userMsg) + "\n");
    input.end();

    const received: unknown[] = [];
    for await (const m of io.read()) received.push(m);
    expect(received).toEqual([userMsg]);
  });

  test("跳过非法 JSON 行", async () => {
    const input = new PassThrough();
    const io = new StructuredIO(input, new PassThrough());

    input.write("not json\n");
    input.write(
      ndjsonStringify({
        type: "user",
        uuid: "u",
        session_id: "s",
        message: { role: "user", content: [] },
      }) + "\n",
    );
    input.end();

    const received: unknown[] = [];
    for await (const m of io.read()) received.push(m);
    expect(received.length).toBe(1);
  });
});

describe("StructuredIO.sendRequest", () => {
  test("请求-响应匹配并 Zod 校验", async () => {
    const input = new PassThrough();
    const out = new PassThrough();
    const io = new StructuredIO(input, out);

    // 后台启动 read 循环（消费 control_response）
    (async () => {
      for await (const _ of io.read()) {
        /* drain */
      }
    })();

    // 捕获发出的 control_request 的 request_id
    let requestId = "";
    out.on("data", (c) => {
      const line = c.toString("utf-8").trim();
      if (!line) return;
      const msg = JSON.parse(line);
      if (msg.type === "control_request") {
        requestId = msg.request_id;
        // 模拟宿主回复
        input.write(
          ndjsonStringify({
            type: "control_response",
            response: {
              subtype: "success",
              request_id: requestId,
              response: { behavior: "allow", tool_use_id: "t1" },
            },
          }) + "\n",
        );
      }
    });

    const schema = z.object({
      behavior: z.enum(["allow", "deny", "always_allow"]),
      tool_use_id: z.string(),
    });
    const result = await io.sendRequest(
      { subtype: "can_use_tool", tool_name: "Bash", input: {}, tool_use_id: "t1" },
      schema,
    );
    expect(result.behavior).toBe("allow");
    expect(requestId).not.toBe("");
  });

  test("error 响应 reject", async () => {
    const input = new PassThrough();
    const out = new PassThrough();
    const io = new StructuredIO(input, out);

    (async () => {
      for await (const _ of io.read()) {
        /* drain */
      }
    })();

    out.on("data", (c) => {
      const line = c.toString("utf-8").trim();
      if (!line) return;
      const msg = JSON.parse(line);
      if (msg.type === "control_request") {
        input.write(
          ndjsonStringify({
            type: "control_response",
            response: { subtype: "error", request_id: msg.request_id, error: "boom" },
          }) + "\n",
        );
      }
    });

    const promise = io.sendRequest({ subtype: "interrupt" }, z.unknown());
    await expect(promise).rejects.toThrow("boom");
  });

  test("AbortSignal 中断请求", async () => {
    const io = new StructuredIO(new PassThrough(), new PassThrough());
    const ac = new AbortController();
    const promise = io.sendRequest({ subtype: "interrupt" }, z.unknown(), ac.signal);
    ac.abort();
    await expect(promise).rejects.toThrow("aborted");
  });
});

describe("StructuredIO.trackResolvedToolUseId", () => {
  test("追踪与查询", () => {
    const io = new StructuredIO(new PassThrough(), new PassThrough());
    expect(io.isResolvedToolUseId("t1")).toBe(false);
    io.trackResolvedToolUseId("t1");
    expect(io.isResolvedToolUseId("t1")).toBe(true);
  });
});
