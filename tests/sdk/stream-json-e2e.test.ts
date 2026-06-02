/**
 * Phase 3 集成测试：stream-json 端到端（headless-runner + StructuredIO + mock driver）
 *
 * 验证：
 * - 初始 prompt 入队 → 引擎执行 → NDJSON 逐条写出
 * - stdin 后续 user 消息 → 再次执行
 * - 每行可被 SDKMessageSchema 校验
 */

import { describe, test, expect } from "bun:test";
import { PassThrough } from "node:stream";
import { runHeadless, runHeadlessStreaming } from "../../src/sdk/headless-runner.ts";
import { StructuredIO } from "../../src/sdk/structured-io.ts";
import { CommandQueue } from "../../src/sdk/command-queue.ts";
import { SDKQueryEngine, type SDKQueryEngineDriver } from "../../src/sdk/query-engine.ts";
import { SDKMessageSchema } from "../../src/sdk/schemas.ts";
import { ndjsonStringify } from "../../src/sdk/ndjson.ts";
import type { QueryEngineEvent } from "../../src/query/types.ts";
import type { Message, Usage } from "../../src/llm/types.ts";

function simpleDriver(replyText: string): SDKQueryEngineDriver {
  const usage: Usage = { inputTokens: 5, outputTokens: 7 };
  let lastMessages: Message[] = [];
  return {
    async *submitMessage(input: string) {
      lastMessages = [
        { role: "user", content: [{ type: "text", text: input }] },
        { role: "assistant", content: [{ type: "text", text: replyText }] },
      ];
      const events: QueryEngineEvent[] = [
        { kind: "user_message_added" },
        {
          kind: "assistant_message",
          message: { role: "assistant", content: [{ type: "text", text: replyText }] },
        },
        { kind: "done", turns: 1 },
      ];
      for (const e of events) yield e;
    },
    getUsage: () => usage,
    getCostUsd: () => 0.01,
    getMessages: () => lastMessages,
    listTools: () => [],
    getApiDurationMs: () => 42,
  };
}

function collect(stream: PassThrough): Promise<any[]> {
  return new Promise((resolve) => {
    let buf = "";
    stream.on("data", (c) => (buf += c.toString("utf-8")));
    stream.on("end", () => {
      resolve(
        buf
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
          .map((l) => JSON.parse(l)),
      );
    });
  });
}

describe("runHeadless stream-json", () => {
  test("初始 prompt → NDJSON 序列，含 init/user/assistant/result", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const io = new StructuredIO(input, output);
    const queue = new CommandQueue();
    const engine = new SDKQueryEngine(
      { cwd: "/tmp", sessionId: "s1", model: "m", now: () => 0, uuid: () => "u" },
      simpleDriver("你好"),
    );

    const collected = collect(output);

    // 立即结束 stdin（无后续消息）
    input.end();

    await runHeadless(engine, {
      outputFormat: "stream-json",
      initialPrompt: "打个招呼",
      structuredIO: io,
      commandQueue: queue,
    });
    output.end();

    const lines = await collected;
    const types = lines.map((l) => `${l.type}${l.subtype ? "/" + l.subtype : ""}`);
    expect(types[0]).toBe("system/init");
    expect(types).toContain("user");
    expect(types).toContain("assistant");
    expect(types[types.length - 1]).toBe("result/success");

    // 每行校验
    for (const l of lines) {
      expect(SDKMessageSchema().safeParse(l).success).toBe(true);
    }

    // 终止 result 文本
    const result = lines.find((l) => l.type === "result");
    expect(result.result).toBe("你好");
  });

  test("stdin 后续 user 消息触发第二轮", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const io = new StructuredIO(input, output);
    const queue = new CommandQueue();
    const engine = new SDKQueryEngine(
      { cwd: "/tmp", sessionId: "s2", model: "m", now: () => 0, uuid: () => "u" },
      simpleDriver("回复"),
    );

    const collected = collect(output);

    // 预先写入一条 user 消息，然后结束
    input.write(
      ndjsonStringify({
        type: "user",
        uuid: "u-2",
        session_id: "s2",
        message: { role: "user", content: [{ type: "text", text: "第二轮" }] },
      }) + "\n",
    );
    input.end();

    await runHeadless(engine, {
      outputFormat: "stream-json",
      structuredIO: io,
      commandQueue: queue,
    });
    output.end();

    const lines = await collected;
    // 至少一轮完整序列
    expect(lines.filter((l) => l.type === "result").length).toBeGreaterThanOrEqual(1);
    expect(lines.some((l) => l.type === "system" && l.subtype === "init")).toBe(true);
  });
});

describe("runHeadless text/json", () => {
  test("text 模式输出最终文本", async () => {
    const out = new PassThrough();
    const chunks: string[] = [];
    out.on("data", (c) => chunks.push(c.toString("utf-8")));
    const engine = new SDKQueryEngine(
      { cwd: "/tmp", sessionId: "s3", model: "m", now: () => 0, uuid: () => "u" },
      simpleDriver("最终答案"),
    );
    await runHeadless(engine, {
      outputFormat: "text",
      initialPrompt: "q",
      output: out,
    });
    expect(chunks.join("").trim()).toBe("最终答案");
  });

  test("json 非 verbose 输出最后一条消息", async () => {
    const out = new PassThrough();
    const chunks: string[] = [];
    out.on("data", (c) => chunks.push(c.toString("utf-8")));
    const engine = new SDKQueryEngine(
      { cwd: "/tmp", sessionId: "s4", model: "m", now: () => 0, uuid: () => "u" },
      simpleDriver("ans"),
    );
    await runHeadless(engine, {
      outputFormat: "json",
      initialPrompt: "q",
      output: out,
    });
    const parsed = JSON.parse(chunks.join("").trim());
    expect(parsed.type).toBe("result");
    expect(parsed.subtype).toBe("success");
  });

  test("json verbose 输出全量数组", async () => {
    const out = new PassThrough();
    const chunks: string[] = [];
    out.on("data", (c) => chunks.push(c.toString("utf-8")));
    const engine = new SDKQueryEngine(
      { cwd: "/tmp", sessionId: "s5", model: "m", now: () => 0, uuid: () => "u" },
      simpleDriver("ans"),
    );
    await runHeadless(engine, {
      outputFormat: "json",
      verbose: true,
      initialPrompt: "q",
      output: out,
    });
    const parsed = JSON.parse(chunks.join("").trim());
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].type).toBe("system");
  });
});

describe("runHeadlessStreaming 直接消费队列", () => {
  test("预入队命令被消费", async () => {
    const input = new PassThrough();
    input.end();
    const io = new StructuredIO(input, new PassThrough());
    const queue = new CommandQueue();
    queue.enqueue({ mode: "prompt", value: "hi", priority: "now" });
    const engine = new SDKQueryEngine(
      { cwd: "/tmp", sessionId: "s6", model: "m", now: () => 0, uuid: () => "u" },
      simpleDriver("ok"),
    );
    const msgs: any[] = [];
    for await (const m of runHeadlessStreaming(io, engine, queue)) msgs.push(m);
    expect(msgs.some((m) => m.type === "result")).toBe(true);
  });
});
