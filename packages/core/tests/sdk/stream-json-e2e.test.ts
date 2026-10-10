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
import { runHeadless, runHeadlessStreaming } from "@sid-code/core/sdk/headless-runner.ts";
import { StructuredIO } from "@sid-code/core/sdk/structured-io.ts";
import { CommandQueue } from "@sid-code/core/sdk/command-queue.ts";
import { SDKQueryEngine, type SDKQueryEngineDriver } from "@sid-code/core/sdk/query-engine.ts";
import { SDKMessageSchema } from "@sid-code/core/sdk/schemas.ts";
import { ndjsonStringify } from "@sid-code/core/sdk/ndjson.ts";
import type { QueryEngineEvent } from "@sid-code/core/query/types.ts";
import type { Message, Usage } from "@sid-code/core/llm/types.ts";

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

describe("runHeadlessStreaming 控制请求分发（B25）", () => {
  function setup() {
    const input = new PassThrough();
    const output = new PassThrough();
    const io = new StructuredIO(input, output);
    const queue = new CommandQueue();
    const engine = new SDKQueryEngine(
      { cwd: "/tmp", sessionId: "s-ctl", model: "m", now: () => 0, uuid: () => "u" },
      simpleDriver("ok"),
    );
    return { input, output, io, queue, engine };
  }

  test("interrupt → 调 onInterrupt 并回 success；其余 subtype 回 error，不静默丢弃", async () => {
    const { input, output, io, queue, engine } = setup();
    const collected = collect(output);
    let interrupts = 0;
    input.write(
      ndjsonStringify({
        type: "control_request",
        request_id: "a",
        request: { subtype: "interrupt" },
      }) + "\n",
    );
    input.write(
      ndjsonStringify({
        type: "control_request",
        request_id: "b",
        request: { subtype: "get_context_usage" },
      }) + "\n",
    );
    input.end();
    await runHeadless(engine, {
      outputFormat: "stream-json",
      structuredIO: io,
      commandQueue: queue,
      controlHandlers: { onInterrupt: () => interrupts++ },
    });
    output.end();
    const lines = await collected;
    const a = lines.find((l) => l.type === "control_response" && l.response.request_id === "a");
    const b = lines.find((l) => l.type === "control_response" && l.response.request_id === "b");
    expect(interrupts).toBe(1);
    expect(a.response.subtype).toBe("success");
    expect(b.response.subtype).toBe("error");
    expect(b.response.error).toContain("get_context_usage");
  });

  test("轮次进行中也能读到 stdin（控制消息不等本轮结束）", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const io = new StructuredIO(input, output);
    const queue = new CommandQueue();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let interruptedDuringTurn = false;
    const driver = simpleDriver("ok");
    const slowDriver: SDKQueryEngineDriver = {
      ...driver,
      async *submitMessage(text: string) {
        await gate; // 本轮卡在这里，直到 interrupt 到达
        yield* driver.submitMessage(text);
      },
    };
    const engine = new SDKQueryEngine(
      { cwd: "/tmp", sessionId: "s-ctl2", model: "m", now: () => 0, uuid: () => "u" },
      slowDriver,
    );
    const collected = collect(output);
    const run = runHeadless(engine, {
      outputFormat: "stream-json",
      initialPrompt: "go",
      structuredIO: io,
      commandQueue: queue,
      controlHandlers: {
        onInterrupt: () => {
          interruptedDuringTurn = true;
          release();
        },
      },
    });
    input.write(
      ndjsonStringify({
        type: "control_request",
        request_id: "i",
        request: { subtype: "interrupt" },
      }) + "\n",
    );
    input.end();
    await run;
    output.end();
    await collected;
    expect(interruptedDuringTurn).toBe(true);
  });
});

describe("入站控制请求全量应答（缺陷 3/4）", () => {
  function setup(driver: SDKQueryEngineDriver = simpleDriver("ok")) {
    const input = new PassThrough();
    const output = new PassThrough();
    const io = new StructuredIO(input, output);
    const queue = new CommandQueue();
    const engine = new SDKQueryEngine(
      { cwd: "/tmp", sessionId: "s-ctl3", model: "m0", now: () => 0, uuid: () => "u" },
      driver,
    );
    return { input, output, io, queue, engine };
  }
  const req = (id: string, request: Record<string, unknown>) =>
    ndjsonStringify({ type: "control_request", request_id: id, request }) + "\n";

  test("每条带 request_id 的入站请求都回一条 control_response", async () => {
    let model = "m0";
    const driver: SDKQueryEngineDriver = { ...simpleDriver("ok"), getModel: () => model };
    const { input, output, io, queue, engine } = setup(driver);
    const collected = collect(output);
    input.write(req("init", { subtype: "initialize" }));
    input.write(req("init-bad", { subtype: "initialize", max_turns: 3, system_prompt: "x" }));
    input.write(req("sm", { subtype: "set_model", model: "m1" }));
    input.write(req("sm-bad", { subtype: "set_model", model: "nope" }));
    input.write(req("sm-shape", { subtype: "set_model" }));
    input.write(req("ctx", { subtype: "get_context_usage" }));
    input.write(req("mcp", { subtype: "mcp_message", server_name: "s", message: {} }));
    input.write(ndjsonStringify({ type: "user", message: { role: "user", content: "hi" } }) + "\n");
    input.end();
    await runHeadless(engine, {
      outputFormat: "stream-json",
      structuredIO: io,
      commandQueue: queue,
      controlHandlers: {
        onSetModel: (m) => {
          if (m === "nope") throw new Error(`模型 "nope" 不在可用模型列表中`);
          model = m;
          return m;
        },
        onGetContextUsage: () => ({ used_tokens: 10, max_tokens: 100, percent_of_window: 10 }),
      },
    });
    output.end();
    const lines = await collected;
    const resp = (id: string) =>
      lines.find((l) => l.type === "control_response" && l.response.request_id === id)?.response;

    expect(resp("init").subtype).toBe("success");
    expect(resp("init").response.supported_control_subtypes).toEqual([
      "initialize",
      "interrupt",
      "set_model",
      "get_context_usage",
    ]);
    // 启动期字段不假装生效
    expect(resp("init-bad").subtype).toBe("error");
    expect(resp("init-bad").error).toContain("max_turns");
    expect(resp("init-bad").error).toContain("--max-turns");

    expect(resp("sm")).toMatchObject({ subtype: "success", response: { model: "m1" } });
    expect(resp("sm-bad").subtype).toBe("error");
    expect(resp("sm-bad").error).toContain("nope");
    expect(resp("sm-shape").subtype).toBe("error");

    expect(resp("ctx")).toMatchObject({
      subtype: "success",
      response: { used_tokens: 10, max_tokens: 100, percent_of_window: 10 },
    });
    expect(resp("mcp").subtype).toBe("error");
    expect(resp("mcp").error).toContain("mcp_message");

    // set_model 之后开的那一轮，system/init 报的是新模型
    const init = lines.find((l) => l.type === "system" && l.subtype === "init");
    expect(init.model).toBe("m1");
  });
});

describe("某轮抛异常不终止会话（缺陷 8）", () => {
  test("3 条 user、第 2 轮抛错：回 3 条 result，第 2 条是 error_during_execution", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const io = new StructuredIO(input, output);
    const queue = new CommandQueue();
    let round = 0;
    const base = simpleDriver("ok");
    const driver: SDKQueryEngineDriver = {
      ...base,
      async *submitMessage(text: string) {
        round++;
        if (round === 2) throw new Error("模型调用失败");
        yield* base.submitMessage(text);
      },
    };
    const engine = new SDKQueryEngine(
      { cwd: "/tmp", sessionId: "s-err", model: "m", now: () => 0, uuid: () => "u" },
      driver,
    );
    const collected = collect(output);
    // 每条 user 等上一条的 result 出来再发：连续到达的 prompt 会被 dequeueBatch 合并成一轮
    // （缺陷 9，另案），这里要测的是「一轮抛错之后会话还活着」，不是合并语义。
    const send = (v: string) =>
      input.write(
        ndjsonStringify({ type: "user", uuid: v, message: { role: "user", content: v } }) + "\n",
      );
    const pending = ["B", "C"];
    let buf = "";
    output.on("data", (c) => {
      buf += c.toString("utf-8");
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const l of lines) {
        if (!l.trim() || JSON.parse(l).type !== "result") continue;
        const next = pending.shift();
        if (next) send(next);
        else input.end();
      }
    });
    send("A");
    await runHeadless(engine, {
      outputFormat: "stream-json",
      structuredIO: io,
      commandQueue: queue,
    });
    output.end();
    const results = (await collected).filter((l) => l.type === "result");
    expect(results.map((r) => r.subtype)).toEqual(["success", "error_during_execution", "success"]);
    expect(results[1].errors).toEqual(["模型调用失败"]);
  });

  test("引擎生成器本身抛穿（submitMessage 外层异常）也补 result 并继续", async () => {
    const io = new StructuredIO(new PassThrough(), new PassThrough());
    let calls = 0;
    const engine = {
      async *submitMessage(input: string) {
        calls++;
        if (input === "boom") throw new Error("engine crashed");
        yield { type: "result", subtype: "success", result: `done:${input}` } as any;
      },
      errorResult: (err: unknown) =>
        ({ type: "result", subtype: "error_during_execution", errors: [String(err)] }) as any,
    } as unknown as SDKQueryEngine;
    const queue = new CommandQueue();
    queue.enqueue({ mode: "prompt", value: "boom", priority: "now" });
    // workload 不同 → 不与 "boom" 合并成一轮（合并语义见缺陷 9）
    queue.enqueue({ mode: "prompt", value: "after", priority: "later", workload: "other" });
    // 直接驱动内层；stdin 立刻结束
    (io as any).input.end();
    const out: any[] = [];
    for await (const m of runHeadlessStreaming(io, engine, queue)) out.push(m);
    const subtypes = out.filter((m) => m.type === "result").map((m) => m.subtype);
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(subtypes[0]).toBe("error_during_execution");
    expect(subtypes).toContain("success");
  });
});

describe("stdin 空闲超时（缺陷 7）", () => {
  test("idleTimeoutMs 到点且无轮在跑：正常收尾并报 idleTimedOut", async () => {
    const input = new PassThrough(); // 刻意不 end：模拟宿主挂着不关 stdin
    const output = new PassThrough();
    const io = new StructuredIO(input, output);
    const engine = new SDKQueryEngine(
      { cwd: "/tmp", sessionId: "s-idle", model: "m", now: () => 0, uuid: () => "u" },
      simpleDriver("ok"),
    );
    const collected = collect(output);
    const t0 = Date.now();
    const outcome = await runHeadless(engine, {
      outputFormat: "stream-json",
      initialPrompt: "hi",
      structuredIO: io,
      commandQueue: new CommandQueue(),
      idleTimeoutMs: 80,
    });
    expect(outcome.idleTimedOut).toBe(true);
    expect(Date.now() - t0).toBeLessThan(2000);
    output.end();
    input.end();
    const results = (await collected).filter((l) => l.type === "result");
    expect(results).toHaveLength(1); // 初始 prompt 那一轮照常跑完
  });

  test("空闲期间来了新消息：计时重置，消息照常执行", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const io = new StructuredIO(input, output);
    const engine = new SDKQueryEngine(
      { cwd: "/tmp", sessionId: "s-idle2", model: "m", now: () => 0, uuid: () => "u" },
      simpleDriver("ok"),
    );
    const collected = collect(output);
    setTimeout(() => {
      input.write(
        ndjsonStringify({ type: "user", message: { role: "user", content: "second" } }) + "\n",
      );
    }, 50);
    const outcome = await runHeadless(engine, {
      outputFormat: "stream-json",
      initialPrompt: "first",
      structuredIO: io,
      commandQueue: new CommandQueue(),
      idleTimeoutMs: 150,
    });
    expect(outcome.idleTimedOut).toBe(true);
    output.end();
    input.end();
    expect((await collected).filter((l) => l.type === "result")).toHaveLength(2);
  });

  test("不传 idleTimeoutMs：stdin EOF 才结束，idleTimedOut=false", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const io = new StructuredIO(input, output);
    const engine = new SDKQueryEngine(
      { cwd: "/tmp", sessionId: "s-idle3", model: "m", now: () => 0, uuid: () => "u" },
      simpleDriver("ok"),
    );
    const collected = collect(output);
    setTimeout(() => input.end(), 100);
    const outcome = await runHeadless(engine, {
      outputFormat: "stream-json",
      initialPrompt: "x",
      structuredIO: io,
      commandQueue: new CommandQueue(),
    });
    expect(outcome.idleTimedOut).toBe(false);
    output.end();
    await collected;
  });
});
