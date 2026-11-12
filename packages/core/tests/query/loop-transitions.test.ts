/**
 * loop-transitions — 验证 queryLoop 恢复路径的 transition 可观测性
 *
 * 通过 traceAppendEvent 收集 LoopTransition 事件，断言各恢复路径正确触发。
 * 覆盖 4 条关键路径：
 *   1. max_tokens_escalate（首次截断 + 低于模型硬上限 → 提升上限）
 *   2. max_tokens_continuation（已至上限 → 注入续写提示）
 *   3. reactive_compact（prompt-too-long 恢复）
 *   4. timeout_retry（超时重试）
 */

import { describe, test, expect } from "bun:test";
import { queryLoop } from "@sid-code/core/query/loop.ts";
import type { QueryLoopConfig } from "@sid-code/core/query/loop.ts";
import type { QueryDeps } from "@sid-code/core/query/types.ts";
import { Manager as ContextManager } from "@sid-code/core/context/manager.ts";
import { Registry as ToolRegistry } from "@sid-code/core/tool/registry.ts";
import { ModelFallback } from "@sid-code/core/llm/fallback.ts";
import { SessionState } from "@sid-code/core/session/state.ts";
import type { Config } from "@sid-code/core/config/config.ts";
import type { StreamEvent, AccumulatedResponse } from "@sid-code/core/llm/types.ts";

// ─── helpers ───

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    model: "claude-opus-4-8",
    provider: "anthropic",
    maxTurns: 10,
    maxTokens: 8000, // 故意设低——触发 escalation
    ...overrides,
  } as unknown as Config;
}

async function* emptyStream(): AsyncIterable<StreamEvent> {
  /* processStream 被 mock，此处不产事件 */
}

function maxTokensResp(outputTokens = 8000): AccumulatedResponse {
  return {
    role: "assistant",
    content: [{ type: "text", text: "x".repeat(100) }],
    stopReason: "max_tokens",
    usage: { inputTokens: 1000, outputTokens },
  } as AccumulatedResponse;
}

function normalResp(text = "完成"): AccumulatedResponse {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "end_turn",
    usage: { inputTokens: 100, outputTokens: 20 },
  } as AccumulatedResponse;
}

/** 一个「成功但不结束本轮」的轮次：工具轮。用来验证 Stage 1 升档在成功后复位。 */
function toolUseResp(): AccumulatedResponse {
  return {
    role: "assistant",
    content: [{ type: "tool_use", id: "tool-1", name: "read", input: { file_path: "/tmp/x" } }],
    stopReason: "tool_use",
    usage: { inputTokens: 100, outputTokens: 20 },
  } as AccumulatedResponse;
}

interface SetupOpts {
  responses: AccumulatedResponse[];
  configOverrides?: Partial<Config>;
  depsOverrides?: Partial<QueryDeps>;
}

function setup({ responses, configOverrides, depsOverrides }: SetupOpts) {
  const transitions: string[] = [];
  const ctxMgr = new ContextManager({ maxTokens: 200000 });
  ctxMgr.setSystemPrompt("test");
  ctxMgr.addMessage({ role: "user", content: [{ type: "text", text: "请完成任务" }] });

  let call = 0;
  const deps: QueryDeps = {
    sendWithRetry: () => emptyStream(),
    processStream: async () => {
      const r = responses[call] ?? normalResp();
      call++;
      return r;
    },
    executeTools: async () => ({ results: [] }),
    autoCompact: async () => ({ kind: "skipped" as const }),
    getAbortSignal: () => undefined,
    uuid: () => `uuid-${call}`,
    traceAppendEvent: (ev) => {
      if (ev.event === "LoopTransition") {
        transitions.push(ev.data?.type as string);
      }
    },
    ...depsOverrides,
  };

  const loopConfig: QueryLoopConfig = {
    config: makeConfig(configOverrides),
    ctxMgr,
    toolRegistry: new ToolRegistry(),
    sessionState: new SessionState("test-transitions"),
    fallback: new ModelFallback(),
    deps,
  };

  return { loopConfig, transitions, ctxMgr };
}

async function drainLoop(loopConfig: QueryLoopConfig): Promise<string[]> {
  const kinds: string[] = [];
  for await (const ev of queryLoop(loopConfig)) {
    kinds.push(ev.kind);
  }
  return kinds;
}

// ─── tests ───

describe("queryLoop recovery transitions", () => {
  test("max_tokens_escalate：首次截断且低于模型硬上限 → 提升上限，不注入续写提示", async () => {
    // config.maxTokens=8000 < claude-opus-4-8 的 maxOutputTokens=128000
    // 第 1 轮 max_tokens → 应走 escalate（不注入 clipNotice）
    // 第 2 轮 end_turn → 正常结束
    const { loopConfig, transitions, ctxMgr } = setup({
      responses: [maxTokensResp(), normalResp()],
      configOverrides: { maxTokens: 8000 },
    });

    await drainLoop(loopConfig);

    expect(transitions[0]).toBe("max_tokens_escalate");
    // 验证没有注入续写提示（clipNotice 包含"被截断"字样的 user 消息）
    const clipMessages = ctxMgr
      .getMessages()
      .filter(
        (m) =>
          m.role === "user" &&
          Array.isArray(m.content) &&
          m.content.some(
            (b: any) =>
              b.type === "text" && typeof b.text === "string" && b.text.includes("不要道歉"),
          ),
      );
    expect(clipMessages.length).toBe(0);
  });

  test("max_tokens_continuation：config.maxTokens 已等于模型上限 → 注入续写提示", async () => {
    // config.maxTokens=128000 === claude-opus-4-8 的 maxOutputTokens → escalation 不触发
    // 第 1 轮 max_tokens → 走 continuation（注入 clipNotice）
    // 第 2 轮 end_turn → 正常结束
    const { loopConfig, transitions, ctxMgr } = setup({
      responses: [maxTokensResp(), normalResp()],
      configOverrides: { maxTokens: 128000 },
    });

    await drainLoop(loopConfig);

    expect(transitions[0]).toBe("max_tokens_continuation");
    // 验证注入了续写提示
    const clipMessages = ctxMgr
      .getMessages()
      .filter(
        (m) =>
          m.role === "user" &&
          Array.isArray(m.content) &&
          m.content.some(
            (b: any) =>
              b.type === "text" && typeof b.text === "string" && b.text.includes("不要道歉"),
          ),
      );
    expect(clipMessages.length).toBe(1);
  });

  test("context_overflow_retry：prompt-too-long 错误触发上下文溢出恢复", async () => {
    // sendWithRetry 第 1 次抛 prompt-too-long，第 2 次正常返回
    let sendCall = 0;
    const { loopConfig, transitions } = setup({
      responses: [normalResp()],
      depsOverrides: {
        sendWithRetry: () => {
          sendCall++;
          if (sendCall === 1) {
            throw Object.assign(new Error("prompt is too long: 210000 tokens > 200000 maximum"), {
              status: 400,
              type: "invalid_request_error",
            });
          }
          return emptyStream();
        },
      },
    });

    await drainLoop(loopConfig);

    expect(transitions).toContain("context_overflow_retry");
  });

  test("timeout_retry：流式超时后自动重试", async () => {
    // processStream 第 1 次抛超时错误，第 2 次正常
    let processCall = 0;
    const { loopConfig, transitions } = setup({
      responses: [normalResp()],
      // 显式覆盖退避基数/上限为极小值：本用例会真实触发一次超时重试 sleep，
      // 若吃生产 DEFAULTS（retryBackoffBaseMs 已提到 5000ms）会与 bun 默认 5s
      // 测试超时打平，导致随机超时。
      configOverrides: {
        network: { retryBackoffBaseMs: 1, retryBackoffMaxMs: 5 },
      },
      depsOverrides: {
        processStream: async () => {
          processCall++;
          if (processCall === 1) {
            throw new Error("Request timed out after 90000ms");
          }
          return normalResp();
        },
      },
    });

    await drainLoop(loopConfig);

    expect(transitions).toContain("timeout_retry");
  });

  // ─── Stage 1 升档复位（F1）───
  // 默认请求预算是 32k 之后，「升档后不复位」会显形：一次截断把上限抬到物理上限，
  // 这条用户消息剩下的所有轮次都会以物理上限发出，F1 原样复发。
  test("Stage 1 升档成功后复位：下一次截断仍先走 Stage 1，默认预算不被永久抬高", async () => {
    const sent: number[] = [];
    const { loopConfig, transitions } = setup({
      // 截断 → 升档；工具轮成功（触发复位）；再截断 → 应能再次升档；最后正常结束
      responses: [maxTokensResp(), toolUseResp(), maxTokensResp(), normalResp()],
      configOverrides: { maxTokens: 8000 },
      depsOverrides: {
        sendWithRetry: (params) => {
          sent.push(params.maxTokens);
          return emptyStream();
        },
        executeTools: async () => ({
          results: [{ type: "tool_result", tool_use_id: "tool-1", content: "ok" }],
        }),
      },
    });

    await drainLoop(loopConfig);

    // 第 1 轮发预算 8000 → 截断升档到模型上限 128000；
    // 第 2 轮工具轮成功 → override 复位；
    // 第 3 轮回到 8000 → 再次升档；第 4 轮 128000。
    expect(sent).toEqual([8000, 128000, 8000, 128000]);
    expect(transitions.filter((t) => t === "max_tokens_escalate").length).toBe(2);
  });

  test("Stage 1 升档后仍截断 → Stage 2 续写，续写次数不被升档门禁污染", async () => {
    const { loopConfig, transitions, ctxMgr } = setup({
      responses: [maxTokensResp(), maxTokensResp(), normalResp()],
      configOverrides: { maxTokens: 8000 },
    });

    await drainLoop(loopConfig);

    // 第 1 轮升档（escalateCount=1），第 2 轮仍截断 → 直接进 Stage 2（不再升档）
    expect(transitions).toEqual(["max_tokens_escalate", "max_tokens_continuation"]);
    // 续写提示里的次数是 #1：它来自独立的 continuation 计数，没有被 Stage 1 的门禁计数污染
    const clip = ctxMgr
      .getMessages()
      .find(
        (m) =>
          m.role === "user" &&
          Array.isArray(m.content) &&
          m.content.some(
            (b: any) =>
              b.type === "text" && typeof b.text === "string" && b.text.includes("自动续写 1 次"),
          ),
      );
    expect(clip).toBeDefined();
  });
});
