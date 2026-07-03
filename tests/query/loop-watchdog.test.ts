/**
 * T1：setInterval 看门狗（watchdog）— 单元测试
 *
 * 复现并验证：底层 processStream 因 reader 在半开 TCP 上永不 settle 而 hang 时，
 * turn_hard 的 setTimeout 可能因 Bun 事件循环被 IO 占满而延迟数分钟才 fire；
 * setInterval 看门狗作为补位防线，每 WATCHDOG_CHECK_INTERVAL_MS 检查流快照的
 * lastContentProgressAt，WATCHDOG_NO_PROGRESS_MS 无业务进展即 abort + reject，
 * 落到既有 isTimeoutError 分支 → 重试 → 最终优雅让出控制权。
 *
 * 关键点：
 *   - 测试中把 maxTurnDurationMs 设得远大于 watchdog 阈值，证明是 watchdog 先 fire
 *     （而非 turn_hard 兜底），即 watchdog 确实是独立生效的更快防线。
 *   - watchdog 用 setInterval，快照缺失时退化为 watchdog 启动时间兜底，保证任何
 *     provider（含不写快照的路径）都有下限保护。
 *
 * fix_type: case_design
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
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
  // watchdog 触发后 stream 内容不重要
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

describe("T1 — setInterval 看门狗", () => {
  beforeEach(() => {
    // 快速触发：每 20ms 检查一次，60ms 无进展即 fire
    process.env.SID_CODE_WATCHDOG_CHECK_INTERVAL_MS = "20";
    process.env.SID_CODE_WATCHDOG_NO_PROGRESS_MS = "60";
  });
  afterEach(() => {
    delete process.env.SID_CODE_WATCHDOG_CHECK_INTERVAL_MS;
    delete process.env.SID_CODE_WATCHDOG_NO_PROGRESS_MS;
  });

  test("流 hang 且无快照进展 → 看门狗先于 turn_hard fire，让出控制权并重试", async () => {
    const hangForever = () => new Promise<never>(() => { /* 永不 settle */ });

    let abortReasons: (string | undefined)[] = [];
    const { loopConfig } = makeLoopConfig({
      processStream: hangForever as any,
      // turn_hard 设得远大于 watchdog（60ms）→ 证明是 watchdog 先生效
      maxTurnDurationMs: 60_000,
      abortCurrentRequest: (reason) => { abortReasons.push(reason); },
    });

    const systemTexts: string[] = [];
    let thrown: Error | null = null;
    try {
      for await (const ev of queryLoop(loopConfig)) {
        if (ev.kind === "system" && "text" in ev) systemTexts.push(ev.text);
      }
    } catch (e) {
      thrown = e as Error;
    }

    // watchdog reject 带 "超时" 字样 → 命中 isTimeoutError → 重试提示出现
    expect(systemTexts.some((t) => t.includes("超时") && t.includes("重试"))).toBe(true);
    // watchdog 触发时用 "watchdog-timeout" reason 主动 abort
    expect(abortReasons).toContain("watchdog-timeout");
    // 重试耗尽后向上抛超时错误（控制权已交还，不挂死）
    expect(thrown).not.toBeNull();
    expect(/超时|timeout/i.test(thrown!.message)).toBe(true);
  }, 15_000);

  test("processStream 正常返回时看门狗不误伤（清掉 interval，正常走完）", async () => {
    const { loopConfig } = makeLoopConfig({
      processStream: async () => ({
        role: "assistant" as const,
        content: [{ type: "text" as const, text: "你好" }],
        stopReason: "end_turn" as const,
        usage: { inputTokens: 5, outputTokens: 2 },
      }),
    });

    const kinds: string[] = [];
    for await (const ev of queryLoop(loopConfig)) {
      kinds.push(ev.kind);
    }
    expect(kinds).toContain("assistant_message");
    expect(kinds).toContain("done");
  }, 15_000);
});
