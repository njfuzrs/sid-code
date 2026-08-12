/**
 * Provider 协议契约测试套件 — D2-1
 *
 * 不变量：所有 OpenAI 兼容 provider（openai / deepseek / ollama）在发送含孤儿 tool_use
 * 的脏历史时，D1-1 关卡（guardOutgoingMessages，接在 sendMessageStream /
 * sendMessageNonStreaming 入口）必须拦截——strict 模式抛 MessageHistoryViolationError，
 * 且在真正 fetch 之前就抛（不打网络）。
 *
 * 覆盖 RL-011 的 ≥3 家 provider。DeepSeek 在 sid-code 里就是自定义 baseURL 的
 * OpenAIProvider（registry.ts:146），故用 OpenAIProvider + deepseek baseURL 表示。
 *
 * fix_type: infra_bug（L1）
 */

import { describe, test, expect, afterEach } from "bun:test";
import { OpenAIProvider } from "@sid-code/core/llm/openai.ts";
import { OllamaProvider } from "@sid-code/core/llm/ollama.ts";
import type { Provider } from "@sid-code/core/llm/provider.ts";
import type { SendParams, Message } from "@sid-code/core/llm/types.ts";
import { MessageHistoryViolationError } from "@sid-code/core/agent/message-invariants.ts";

/** 构造一条含孤儿 tool_use 的脏历史（c2 缺 tool_result） */
function dirtyHistory(): Message[] {
  return [
    { role: "user", content: [{ type: "text", text: "task" }] },
    {
      role: "assistant",
      content: [
        { type: "tool_use", id: "c1", name: "read", input: {} },
        { type: "tool_use", id: "c2", name: "boom", input: {} },
      ],
    },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "ok" }] },
    // c2 的 tool_result 缺失 → 孤儿
  ];
}

function sendParams(messages: Message[]): SendParams {
  return { model: "test-model", messages, maxTokens: 1024 };
}

/** 被测 provider 矩阵：覆盖 RL-011 的 ≥3 家 OpenAI 兼容 provider */
const PROVIDERS: Array<{ label: string; make: () => Provider }> = [
  {
    label: "openai",
    make: () => new OpenAIProvider("sk-test", "gpt-4o", "https://api.openai.com/v1"),
  },
  {
    label: "deepseek（自定义 baseURL 的 OpenAIProvider）",
    make: () => new OpenAIProvider("sk-test", "deepseek-v4-pro", "https://api.deepseek.com/v1"),
  },
  { label: "ollama", make: () => new OllamaProvider("llama3", "http://localhost:11434/v1") },
];

afterEach(() => {
  delete process.env.SID_CODE_PROTOCOL_STRICT;
});

describe("D2-1 — Provider 协议契约（孤儿历史发送前拦截）", () => {
  for (const { label, make } of PROVIDERS) {
    test(`[${label}] strict 模式：脏历史在 sendMessageStream 入口被拦截（不打网络）`, async () => {
      process.env.SID_CODE_PROTOCOL_STRICT = "1";
      const provider = make();

      let thrown: unknown = null;
      try {
        // 消费 async generator 才会执行 body；guard 在 convertMessages 之前，
        // 故首个 next() 就应抛 —— 早于任何 fetch。
        const it = provider.sendMessageStream(sendParams(dirtyHistory()));
        await it[Symbol.asyncIterator]().next();
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(MessageHistoryViolationError);
      const err = thrown as MessageHistoryViolationError;
      expect(err.detail.orphans.map((o) => o.id)).toContain("c2");
    });

    test(`[${label}] strict 模式：脏历史在 sendMessageNonStreaming 入口被拦截`, async () => {
      process.env.SID_CODE_PROTOCOL_STRICT = "1";
      const provider = make() as any;

      let thrown: unknown = null;
      try {
        await provider.sendMessageNonStreaming(sendParams(dirtyHistory()));
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(MessageHistoryViolationError);
    });

    test(`[${label}] 非 strict：脏历史不抛 MessageHistoryViolationError（降级告警+落盘）`, async () => {
      // 不设 SID_CODE_PROTOCOL_STRICT → 默认非 strict。
      // guard 在 convertMessages 之前运行；非 strict 下脏历史只告警+落盘、不抛。
      // 用 pre-aborted signal 让随后的 fetch 立即中止，避免真打网络挂起。
      const provider = make();
      const aborted = AbortSignal.abort();

      let guardThrew = false;
      try {
        const it = provider.sendMessageStream(sendParams(dirtyHistory()), aborted);
        // 消费整个流：guard 先跑（非 strict 不抛），之后 fetch 因 aborted 立即失败，
        // 流内部把它转成 error 事件 yield 出来，不向外抛。
        for await (const _ev of it) {
          /* drain */
        }
      } catch (e) {
        // 只要不是 guard 抛的协议错误即可（网络/abort 错误无所谓）
        if (e instanceof MessageHistoryViolationError) guardThrew = true;
      }
      expect(guardThrew).toBe(false);
    });
  }
});
