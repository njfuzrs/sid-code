/**
 * E9（20261018 effort 排查 PR-A）：queryLoop 把用户所选档位 effort_intent 交给 BeforeModel。
 *
 * 只测采集器会漏掉「loop 没接上」这一类死接线，所以这里走真实 queryLoop，
 * 断言 hookSystem.fireBeforeModelEvent 收到的入参。口径：env > runtime > "auto"，
 * 且**不**做 auto→默认档（那是 applied，不是意图）。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { queryLoop } from "@sid-code/core/query/loop.ts";
import type { QueryLoopConfig } from "@sid-code/core/query/loop.ts";
import type { QueryDeps } from "@sid-code/core/query/types.ts";
import { Manager as ContextManager } from "@sid-code/core/context/manager.ts";
import { Registry as ToolRegistry } from "@sid-code/core/tool/registry.ts";
import { ModelFallback } from "@sid-code/core/llm/fallback.ts";
import { SessionState } from "@sid-code/core/session/state.ts";
import type { Config } from "@sid-code/core/config/config.ts";
import type { StreamEvent, AccumulatedResponse } from "@sid-code/core/llm/types.ts";
import type { EffortSetting } from "@sid-code/core/llm/effort.ts";

const saved = {
  SID_CODE_EFFORT_LEVEL: process.env.SID_CODE_EFFORT_LEVEL,
  CLAUDE_CODE_EFFORT_LEVEL: process.env.CLAUDE_CODE_EFFORT_LEVEL,
};
beforeEach(() => {
  delete process.env.SID_CODE_EFFORT_LEVEL;
  delete process.env.CLAUDE_CODE_EFFORT_LEVEL;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

async function* emptyStream(): AsyncIterable<StreamEvent> {
  /* processStream 被 mock */
}

async function captureBeforeModel(model: string, runtime: EffortSetting): Promise<any> {
  const ctxMgr = new ContextManager({ maxTokens: 200000 });
  ctxMgr.setSystemPrompt("test");
  ctxMgr.addMessage({ role: "user", content: [{ type: "text", text: "hi" }] });
  const deps: QueryDeps = {
    sendWithRetry: () => emptyStream(),
    processStream: async () =>
      ({
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        stopReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 1 },
      }) as AccumulatedResponse,
    executeTools: async () => ({ results: [] }),
    autoCompact: async () => {},
    getAbortSignal: () => undefined,
    uuid: () => "uuid-test",
    getEffortSetting: () => runtime,
    getThinkingSetting: () => undefined,
  };
  const seen: any[] = [];
  const noBlock = { finalOutput: undefined };
  const hookSystem = {
    fireBeforeModelEvent: async (data: any) => {
      seen.push(data);
      return noBlock;
    },
    fireAfterModelEvent: async () => noBlock,
    fireAfterAgentEvent: async () => ({ finalOutput: { shouldClearContext: () => false } }),
  } as any;
  const loopConfig: QueryLoopConfig = {
    config: { model, provider: "openai", maxTurns: 5 } as unknown as Config,
    ctxMgr,
    toolRegistry: new ToolRegistry(),
    sessionState: new SessionState("test-session"),
    fallback: new ModelFallback(),
    deps,
  };
  (loopConfig as any).hookSystem = hookSystem;
  for await (const _ev of queryLoop(loopConfig)) {
    /* drain */
  }
  expect(seen.length).toBeGreaterThan(0);
  return seen[0];
}

describe("E9：BeforeModel 带 effort_intent", () => {
  test("runtime 未设 → auto（不解析成模型默认档）", async () => {
    const d = await captureBeforeModel("deepseek-v4-pro", undefined);
    expect(d.effort_intent).toBe("auto");
  });

  test("runtime 选 low：意图记 low，与解析后的 reasoning_effort 分开（E5/E7 那种 low→high）", async () => {
    const d = await captureBeforeModel("deepseek-v4-pro", "low");
    expect(d.effort_intent).toBe("low");
  });

  test("env 覆盖优先于 runtime", async () => {
    process.env.SID_CODE_EFFORT_LEVEL = "xhigh";
    const d = await captureBeforeModel("deepseek-v4-pro", "low");
    expect(d.effort_intent).toBe("xhigh");
  });
});
