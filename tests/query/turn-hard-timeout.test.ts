/**
 * L1：queryLoop 单轮硬超时（Promise.race 兜底）— 单元测试
 *
 * 复现并验证「会话 217c93ae 流式响应永久挂起」的修复：
 *   底层 processStream 因 reader 在半开 TCP 上永不 settle 而永久 hang 时，
 *   queryLoop 不再无限挂死，而是在 MAX_TURN_DURATION_MS 后由 Promise.race
 *   reject 让出控制权，落到既有 isTimeoutError 分支 → 重试 → 最终优雅 done。
 *
 * 关键点（二次评审纠正）：
 *   - 用 Promise.race 而非 setTimeout+finally：底层永不 settle 时 finally 永不到达。
 *   - 超时时应顺手调 abortCurrentRequest（尽力而为），但兜底不依赖它生效。
 *
 * fix_type: case_design
 */

import { describe, test, expect } from "bun:test";
import { queryLoop } from "../../src/query/loop.ts";
import type { QueryLoopConfig } from "../../src/query/loop.ts";
import type { QueryDeps } from "../../src/query/types.ts";
import { Manager as ContextManager } from "../../src/context/manager.ts";
import { Registry as ToolRegistry } from "../../src/tool/registry.ts";
import { ModelFallback } from "../../src/llm/fallback.ts";
import { SessionState } from "../../src/session/state.ts";
import type { Config } from "../../src/config/config.ts";
import type { StreamEvent } from "../../src/llm/types.ts";

function makeConfig(): Config {
  return { model: "test-model", provider: "anthropic", maxTurns: 5 } as unknown as Config;
}

async function* emptyStream(): AsyncIterable<StreamEvent> {
  // abort 时 SDK 已被中断，stream 内容不重要
}

function makeLoopConfig(overrides: Partial<QueryDeps>): {
  loopConfig: QueryLoopConfig;
  ctxMgr: ContextManager;
} {
  const ctxMgr = new ContextManager({ maxTokens: 200000 });
  ctxMgr.setSystemPrompt("test");
  ctxMgr.addMessage({ role: "user", content: [{ type: "text", text: "做点事" }] });

  const deps: QueryDeps = {
    sendWithRetry: () => emptyStream(),
    processStream: async () => {
      throw new Error("processStream not mocked");
    },
    executeTools: async () => ({ results: [] }),
    autoCompact: async () => {},
    handleContextOverflow: () => null,
    getAbortSignal: () => undefined,
    uuid: () => "uuid-test",
    ...overrides,
  };

  const loopConfig: QueryLoopConfig = {
    config: makeConfig(),
    ctxMgr,
    toolRegistry: new ToolRegistry(),
    sessionState: new SessionState("test-session"),
    fallback: new ModelFallback(),
    deps,
  };
  return { loopConfig, ctxMgr };
}

describe("L1 — queryLoop 单轮硬超时", () => {
  test("processStream 永久 hang → race 超时后让出控制权并重试（不挂死）", async () => {
    // 永不 resolve 的 processStream，模拟底层 generator 链 hang
    const hangForever = () => new Promise<never>(() => { /* 永不 settle */ });

    let abortCalled = 0;
    const { loopConfig } = makeLoopConfig({
      processStream: hangForever as any,
      maxTurnDurationMs: 50, // 50ms 快速触发
      abortCurrentRequest: () => { abortCalled++; },
    });

    const kinds: string[] = [];
    const systemTexts: string[] = [];
    let thrown: Error | null = null;
    // 关键断言：循环必须能让出控制权（不再永久挂死）。
    // hang 不会自愈，重试 2 次耗尽后 Fix 4：yield 用户可见的错误提示 + done 优雅收尾（不再 throw）。
    try {
      for await (const ev of queryLoop(loopConfig)) {
        kinds.push(ev.kind);
        if (ev.kind === "system" && "text" in ev) systemTexts.push(ev.text);
      }
    } catch (e) {
      thrown = e as Error;
    }

    // 走了 timeout 重试分支（isTimeoutError 命中），有重试提示
    expect(systemTexts.some((t) => t.includes("超时") && t.includes("重试"))).toBe(true);
    // 超时时尝试主动 abort（尽力而为）。重试 2 次 + 最终一次 = 至少触发 1 次。
    expect(abortCalled).toBeGreaterThanOrEqual(1);
    // Fix 4：重试耗尽后不再 throw，而是 yield 用户可见的错误提示 + done 优雅收尾
    expect(thrown).toBeNull();
    expect(kinds).toContain("done");
    expect(systemTexts.some((t) => t.includes("超时") && t.includes("中断"))).toBe(true);
  });

  test("超时重试耗尽（2 次）后 yield 错误提示并优雅收尾（不再 throw）", async () => {
    const hangForever = () => new Promise<never>(() => {});
    const { loopConfig } = makeLoopConfig({
      processStream: hangForever as any,
      maxTurnDurationMs: 30,
    });

    let thrown: Error | null = null;
    const kinds: string[] = [];
    const systemTexts: string[] = [];
    try {
      for await (const ev of queryLoop(loopConfig)) {
        kinds.push(ev.kind);
        if (ev.kind === "system" && "text" in ev) systemTexts.push(ev.text);
      }
    } catch (e) {
      thrown = e as Error;
    }
    // Fix 4：重试 2 次后仍 hang → 不再向上抛异常，而是 yield 错误提示 + done
    expect(thrown).toBeNull();
    expect(kinds).toContain("done");
    expect(systemTexts.some((t) => /超时|timeout/i.test(t))).toBe(true);
  });

  test("processStream 正常返回时 race 不误伤（清掉定时器，正常走完）", async () => {
    const { loopConfig } = makeLoopConfig({
      processStream: async () => ({
        role: "assistant" as const,
        content: [{ type: "text" as const, text: "你好" }],
        stopReason: "end_turn" as const,
        usage: { inputTokens: 5, outputTokens: 2 },
      }),
      maxTurnDurationMs: 50,
    });

    const kinds: string[] = [];
    for await (const ev of queryLoop(loopConfig)) {
      kinds.push(ev.kind);
    }
    // 正常 end_turn 收尾
    expect(kinds).toContain("assistant_message");
    expect(kinds).toContain("done");
  });
});
