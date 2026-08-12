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
 *   - Fix 3 根治后，超时/看门狗 abort 走的是每轮独立子 AbortController（abortThisTurn），
 *     不再经 deps.abortCurrentRequest 回写会话级共享 signal。测试验证传给 sendWithRetry
 *     的 composedSignal 被正确 abort（真实可观测行为），而非检测外部 mock 回调。
 *
 * fix_type: case_design
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
import type { StreamEvent } from "@sid-code/core/llm/types.ts";
import { emitStreamPhase } from "@sid-code/core/trace/stream-observer.ts";

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
    // 统一放宽后重试默认 4 次、退避 2s→30s。测试收敛重试次数并把退避压到近 0，
    // 否则真实退避等待会拖爆测试超时（见 network-profile.ts DEFAULTS）。
    process.env.SID_CODE_MAX_TIMEOUT_RETRIES = "2";
    process.env.SID_CODE_RETRY_BACKOFF_BASE_MS = "1";
    process.env.SID_CODE_RETRY_BACKOFF_MAX_MS = "1";
  });
  afterEach(() => {
    delete process.env.SID_CODE_WATCHDOG_CHECK_INTERVAL_MS;
    delete process.env.SID_CODE_WATCHDOG_NO_PROGRESS_MS;
    delete process.env.SID_CODE_RESPONSE_HEADER_TIMEOUT_MS;
    delete process.env.SID_CODE_WATCHDOG_HEADER_GRACE_MS;
    delete process.env.SID_CODE_MAX_TIMEOUT_RETRIES;
    delete process.env.SID_CODE_RETRY_BACKOFF_BASE_MS;
    delete process.env.SID_CODE_RETRY_BACKOFF_MAX_MS;
  });

  test("流 hang 且有快照进展记录 → 看门狗按 WATCHDOG_NO_PROGRESS_MS 判定，先于 turn_hard fire", async () => {
    // 捕获传给 sendWithRetry 的 composedSignal，用于验证 abort 确实触发
    const capturedSignals: AbortSignal[] = [];
    // processStream 每次被调用对应 queryLoop 的一轮（初次 + 每次超时重试各一次），
    // turnIndex 与调用次数一一对应——用计数器让每轮都能建立正确 index 的快照，
    // 否则重试后的轮次会退化到「快照缺失」分支。
    let callCount = 0;
    const { loopConfig } = makeLoopConfig({
      sendWithRetry: (_params: any, signal?: AbortSignal) => {
        if (signal) capturedSignals.push(signal);
        return emptyStream();
      },
      // Fix 6：在 processStream mock 内部调用 emitStreamPhase（而非在 queryLoop() 调用之前），
      // 因为此时 ambient context 已被 queryLoop 设为本次 loop 的正确 loopId（Fix 1 复合 key）——
      // 在外部提前调用会写入错误的 loopId，看门狗查询时读不到，误入「快照缺失」分支。
      processStream: (async () => {
        callCount++;
        emitStreamPhase(callCount, "first_content", { model: "test-model" });
        return new Promise<never>(() => {
          /* 永不 settle */
        });
      }) as any,
      // turn_hard 设得远大于 watchdog（60ms）→ 证明是 watchdog 先生效
      maxTurnDurationMs: 60_000,
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
    // Fix 3 根治：看门狗触发时 abort 的是每轮独立子 controller 的 composedSignal（传给 sendWithRetry 的那个）。
    // 验证：至少有一个被传入的 signal 已被 abort，且 reason 是 watchdog-timeout。
    expect(capturedSignals.some((s) => s.aborted && String(s.reason) === "watchdog-timeout")).toBe(
      true,
    );
    // Fix 4：重试耗尽后不再 throw，而是 yield 用户可见的错误提示 + done 优雅收尾
    expect(thrown).toBeNull();
    expect(sawDone).toBe(true);
    expect(systemTexts.some((t) => t.includes("超时") && t.includes("中断"))).toBe(true);
  }, 15_000);

  test("流 hang 且无快照（等首字节）→ 看门狗按 headerTimeoutMs+grace 判定", async () => {
    const hangForever = () =>
      new Promise<never>(() => {
        /* 永不 settle */
      });
    const capturedSignals: AbortSignal[] = [];

    const { loopConfig } = makeLoopConfig({
      sendWithRetry: (_params: any, signal?: AbortSignal) => {
        if (signal) capturedSignals.push(signal);
        return emptyStream();
      },
      processStream: hangForever as any,
      maxTurnDurationMs: 60_000,
    });
    // 不写快照 → 走 Fix 6 的「快照缺失」分支：headerTimeoutMs(40ms) + grace(20ms) = 60ms

    const systemTexts: string[] = [];
    let sawDone = false;
    for await (const ev of queryLoop(loopConfig)) {
      if (ev.kind === "system" && "text" in ev) systemTexts.push(ev.text);
      if (ev.kind === "done") sawDone = true;
    }

    expect(systemTexts.some((t) => t.includes("超时") && t.includes("重试"))).toBe(true);
    // 验证 composedSignal 被 abort（reason 可能是 watchdog-timeout 或 race-settled）
    expect(capturedSignals.some((s) => s.aborted)).toBe(true);
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
