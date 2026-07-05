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
import { emitStreamPhase } from "../../src/trace/stream-observer.ts";

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
    // Fix 6：快照缺失分支阈值 = headerTimeoutMs + grace。测试环境下把两者都压到极小值，
    // 避免用生产默认值（60s/120s + 10s）导致测试超时。
    process.env.SID_CODE_RESPONSE_HEADER_TIMEOUT_MS = "40";
    process.env.SID_CODE_WATCHDOG_HEADER_GRACE_MS = "20";
  });
  afterEach(() => {
    delete process.env.SID_CODE_WATCHDOG_CHECK_INTERVAL_MS;
    delete process.env.SID_CODE_WATCHDOG_NO_PROGRESS_MS;
    delete process.env.SID_CODE_RESPONSE_HEADER_TIMEOUT_MS;
    delete process.env.SID_CODE_WATCHDOG_HEADER_GRACE_MS;
  });

  test("流 hang 且有快照进展记录 → 看门狗按 WATCHDOG_NO_PROGRESS_MS 判定，先于 turn_hard fire", async () => {
    let abortReasons: (string | undefined)[] = [];
    // processStream 每次被调用对应 queryLoop 的一轮（初次 + 每次超时重试各一次），
    // turnIndex 与调用次数一一对应——用计数器让每轮都能建立正确 index 的快照，
    // 否则重试后的轮次会退化到「快照缺失」分支。
    let callCount = 0;
    const { loopConfig } = makeLoopConfig({
      // Fix 6：在 processStream mock 内部调用 emitStreamPhase（而非在 queryLoop() 调用之前），
      // 因为此时 ambient context 已被 queryLoop 设为本次 loop 的正确 loopId（Fix 1 复合 key）——
      // 在外部提前调用会写入错误的 loopId，看门狗查询时读不到，误入「快照缺失」分支。
      processStream: (async () => {
        callCount++;
        emitStreamPhase(callCount, "first_content", { model: "test-model" });
        return new Promise<never>(() => { /* 永不 settle */ });
      }) as any,
      // turn_hard 设得远大于 watchdog（60ms）→ 证明是 watchdog 先生效
      maxTurnDurationMs: 60_000,
      abortCurrentRequest: (reason) => { abortReasons.push(reason); },
    });

    const systemTexts: string[] = [];
    let thrown: Error | null = null;
    let sawDone = false;
    try {
      for await (const ev of queryLoop(loopConfig)) {
        if (ev.kind === "system" && "text" in ev) systemTexts.push(ev.text);
        if (ev.kind === "done") sawDone = true;
      }
    } catch (e) {
      thrown = e as Error;
    }

    // watchdog reject 带 "超时" 字样 → 命中 isTimeoutError → 重试提示出现
    expect(systemTexts.some((t) => t.includes("超时") && t.includes("重试"))).toBe(true);
    // watchdog 触发时用 "watchdog-timeout" reason 主动 abort
    expect(abortReasons).toContain("watchdog-timeout");
    // Fix 4：重试耗尽后不再 throw，而是 yield 用户可见的错误提示 + done 优雅收尾
    expect(thrown).toBeNull();
    expect(sawDone).toBe(true);
    expect(systemTexts.some((t) => t.includes("超时") && t.includes("中断"))).toBe(true);
  }, 15_000);

  test("流 hang 且无快照（等首字节）→ 看门狗按 headerTimeoutMs+grace 判定", async () => {
    const hangForever = () => new Promise<never>(() => { /* 永不 settle */ });

    let abortReasons: (string | undefined)[] = [];
    const { loopConfig } = makeLoopConfig({
      processStream: hangForever as any,
      maxTurnDurationMs: 60_000,
      abortCurrentRequest: (reason) => { abortReasons.push(reason); },
    });
    // 不写快照 → 走 Fix 6 的「快照缺失」分支：headerTimeoutMs(40ms) + grace(20ms) = 60ms

    const systemTexts: string[] = [];
    let sawDone = false;
    for await (const ev of queryLoop(loopConfig)) {
      if (ev.kind === "system" && "text" in ev) systemTexts.push(ev.text);
      if (ev.kind === "done") sawDone = true;
    }

    expect(systemTexts.some((t) => t.includes("超时") && t.includes("重试"))).toBe(true);
    expect(abortReasons).toContain("watchdog-timeout");
    expect(sawDone).toBe(true);
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
