/**
 * /btw（Side Question）命令测试
 *
 * 验证：旁路提问 fork 一个共享上下文的 agent 单次回答，全 deny 工具权限，
 * 返回文本不注入主对话；空问题 / 空上下文给出友好提示。
 */

import { describe, test, expect } from "bun:test";
import btwDef from "@sid-code/cli/command/commands/btw/index.ts";
import type { LocalCommand, LocalCommandModule } from "@sid-code/cli/command/types.ts";
import type { Message } from "@sid-code/core/llm/types.ts";

/** 构造一个返回脚本化事件序列的 mock provider */
function mockProvider(scripts: any[][]) {
  let call = 0;
  return {
    name: () => "mock",
    defaultModel: () => "mock-model",
    async *sendMessageStream() {
      const events = scripts[call] ?? [
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { outputTokens: 1 } },
      ];
      call++;
      for (const e of events) yield e;
    },
  };
}

/** 构造最小 CommandContext（只填 /btw 实际用到的字段） */
function makeCtx(provider: any, messages: Message[]): any {
  return {
    ctxMgr: {
      getMessages: () => messages,
      getSystemPrompt: () => "system",
    },
    toolRegistry: { get: () => undefined, definitions: () => [] },
    config: { model: "mock-model" },
    provider,
    sessionId: "test",
    sessionState: {},
    cwd: process.cwd(),
  };
}

async function loadBtw(): Promise<LocalCommandModule> {
  return (btwDef as LocalCommand).load();
}

describe("/btw 命令定义", () => {
  test("name 为 btw，仅用户可调用，禁止模型调用", () => {
    expect(btwDef.name).toBe("btw");
    expect(btwDef.type).toBe("local");
    expect(btwDef.userInvocable).toBe(true);
    expect(btwDef.disableModelInvocation).toBe(true);
  });
});

describe("/btw 命令执行", () => {
  test("空问题返回用法提示", async () => {
    const mod = await loadBtw();
    const ctx = makeCtx(mockProvider([]), [
      { role: "user", content: [{ type: "text", text: "之前的对话" }] },
    ]);
    const result = await mod.call("   ", ctx);
    expect(result.type).toBe("text");
    expect((result as { value: string }).value).toContain("用法");
  });

  test("空上下文返回友好提示", async () => {
    const mod = await loadBtw();
    const ctx = makeCtx(mockProvider([]), []);
    const result = await mod.call("这是什么类型?", ctx);
    expect(result.type).toBe("text");
    expect((result as { value: string }).value).toContain("上下文");
  });

  test("基于上下文回答，返回 forked agent 的文本答案", async () => {
    const provider = mockProvider([
      [
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "返回值是 string 类型" },
        },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { outputTokens: 5 } },
      ],
    ]);
    const mod = await loadBtw();
    const ctx = makeCtx(provider, [
      { role: "user", content: [{ type: "text", text: "写一个函数返回名字" }] },
      {
        role: "assistant",
        content: [{ type: "text", text: "function getName(): string { ... }" }],
      },
    ]);
    const result = await mod.call("刚才那个函数返回什么类型?", ctx);
    expect(result.type).toBe("text");
    expect((result as { value: string }).value).toBe("返回值是 string 类型");
  });

  test("旁路提问不向主对话注入消息（messages 引用不被追加）", async () => {
    const provider = mockProvider([
      [
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "答案" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { outputTokens: 1 } },
      ],
    ]);
    const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "上下文" }] }];
    const before = messages.length;
    const mod = await loadBtw();
    const ctx = makeCtx(provider, messages);
    await mod.call("问题", ctx);
    // forked agent 内部对消息做 structuredClone，主对话数组不被追加。
    expect(messages.length).toBe(before);
  });
});
