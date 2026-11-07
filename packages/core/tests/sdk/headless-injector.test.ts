/**
 * T6：无头长驻形态的定时注入通道（`runHeadlessStreaming` 的 `onInjectorReady`）。
 *
 * 这条链路是 `/loop` 放行的**前提**：放行一个「创建定时任务」的命令，必须保证任务
 * 到点后真的被执行，否则就是方案 D6 那类假成功——命令报「空闲时会自动触发」，
 * 实际 prompt 只进了 `App.scheduledPromptQueue` 再也没人认领（2026-11-07 核实：
 * `setPromptInjector` 原先只有 TUI 的 onUserInput 一处调用）。
 *
 * 两条断言：
 * 1. stream-json（多轮）：注入器把 prompt 投进主循环，产出完整的 user/assistant/result；
 * 2. text（单轮）：根本不注册注入器——跑完一轮即退，注册了也不会有下一次触发。
 */

import { describe, test, expect } from "bun:test";
import { PassThrough } from "node:stream";
import { runHeadless } from "@sid-code/core/sdk/headless-runner.ts";
import { StructuredIO } from "@sid-code/core/sdk/structured-io.ts";
import { CommandQueue } from "@sid-code/core/sdk/command-queue.ts";
import { SDKQueryEngine, type SDKQueryEngineDriver } from "@sid-code/core/sdk/query-engine.ts";
import type { QueryEngineEvent } from "@sid-code/core/query/types.ts";
import type { Message, Usage } from "@sid-code/core/llm/types.ts";

/** 回显 driver：submitMessage 的回执文本里带上输入，便于断言「哪条 prompt 被执行了」。 */
function echoDriver(): SDKQueryEngineDriver {
  const usage: Usage = { inputTokens: 5, outputTokens: 7 };
  let lastMessages: Message[] = [];
  return {
    async *submitMessage(input: string) {
      lastMessages = [
        { role: "user", content: [{ type: "text", text: input }] },
        { role: "assistant", content: [{ type: "text", text: `收到: ${input}` }] },
      ];
      const events: QueryEngineEvent[] = [
        { kind: "user_message_added" },
        {
          kind: "assistant_message",
          message: { role: "assistant", content: [{ type: "text", text: `收到: ${input}` }] },
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

describe("T6：onInjectorReady 是定时任务真正被执行的前提", () => {
  test("stream-json 多轮：注入的 prompt 作为一轮执行，并写出 result", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const io = new StructuredIO(input, output);
    const queue = new CommandQueue();
    const engine = new SDKQueryEngine(
      { cwd: "/tmp", sessionId: "inj-1", model: "m", now: () => 0, uuid: () => "u" },
      echoDriver(),
    );
    const collected = collect(output);

    let inject: ((text: string) => void) | null = null;
    const run = runHeadless(engine, {
      outputFormat: "stream-json",
      structuredIO: io,
      commandQueue: queue,
      onInjectorReady: (fn) => {
        inject = fn;
      },
    });

    // runHeadlessStreaming 是 async generator：首个 next 才执行到注册点。
    for (let i = 0; i < 1000 && !inject; i++) await new Promise((r) => setTimeout(r, 1));
    expect(inject).not.toBeNull();

    // 模拟 cron / `/loop` 到点触发
    inject!("定时任务：检查部署");
    // 结束后关 stdin：主循环会先把队列排空才退（inputDone && isEmpty 才 break）
    input.end();
    await run;
    output.end();

    const lines = await collected;
    const users = lines.filter((l) => l.type === "user");
    expect(users.length).toBe(1);
    expect(JSON.stringify(users[0])).toContain("定时任务：检查部署");
    const result = lines.find((l) => l.type === "result");
    expect(result?.subtype).toBe("success");
    // 断言「这一轮真的跑了模型」，不是只把 prompt 记进上下文
    expect(result?.result).toBe("收到: 定时任务：检查部署");
  }, 10_000);

  test("text 单轮形态不注册注入器（跑完一轮即退，注册了也没有下一次触发）", async () => {
    const engine = new SDKQueryEngine(
      { cwd: "/tmp", sessionId: "inj-2", model: "m", now: () => 0, uuid: () => "u" },
      echoDriver(),
    );
    const out = new PassThrough();
    let injected = 0;
    await runHeadless(engine, {
      outputFormat: "text",
      initialPrompt: "你好",
      output: out,
      onInjectorReady: () => {
        injected++;
      },
    });
    expect(injected).toBe(0);
  });
});
