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

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { queryLoop } from "../../src/query/loop.ts";
import type { QueryLoopConfig } from "../../src/query/loop.ts";
import type { QueryDeps } from "../../src/query/types.ts";
import { Manager as ContextManager } from "../../src/context/manager.ts";
import { Registry as ToolRegistry } from "../../src/tool/registry.ts";
import { ModelFallback } from "../../src/llm/fallback.ts";
import { SessionState } from "../../src/session/state.ts";
import type { Config } from "../../src/config/config.ts";
import type { StreamEvent } from "../../src/llm/types.ts";
import { RequestAbortedError } from "../../src/llm/errors.ts";

// 统一超时默认值放宽后：重试次数默认 4、退避 2s→30s。单测里必须经环境变量把
// 重试次数收敛、退避压到近乎 0，否则真实退避等待会拖爆测试超时（见 network-profile.ts）。
beforeAll(() => {
  process.env.SID_CODE_MAX_TIMEOUT_RETRIES = "2";
  process.env.SID_CODE_RETRY_BACKOFF_BASE_MS = "1";
  process.env.SID_CODE_RETRY_BACKOFF_MAX_MS = "1";
});
afterAll(() => {
  delete process.env.SID_CODE_MAX_TIMEOUT_RETRIES;
  delete process.env.SID_CODE_RETRY_BACKOFF_BASE_MS;
  delete process.env.SID_CODE_RETRY_BACKOFF_MAX_MS;
});

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

    // Fix 3 根治后，turn 级 abort 走每轮独立子 controller（abortThisTurn），不再经
    // deps.abortCurrentRequest。捕获传给 sendWithRetry 的 composedSignal，验证其被 abort。
    const capturedSignals: AbortSignal[] = [];
    const { loopConfig } = makeLoopConfig({
      sendWithRetry: (_params: any, signal?: AbortSignal) => {
        if (signal) capturedSignals.push(signal);
        return emptyStream();
      },
      processStream: hangForever as any,
      maxTurnDurationMs: 50, // 50ms 快速触发
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
    // 超时时尝试主动 abort（尽力而为）：turn 级子 controller 的 composedSignal 被 abort，
    // reason 为 turn-timeout（硬超时）或 race-settled（finally 清理）。至少有一个被 abort。
    expect(capturedSignals.some((s) => s.aborted)).toBe(true);
    expect(
      capturedSignals.some((s) => s.aborted && ["turn-timeout", "race-settled"].includes(String(s.reason))),
    ).toBe(true);
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

/**
 * 根治回归（2026-07，session 20260707-143411 事故复盘）：
 *   stream-processor 心跳/整体超时 abort turn 级 controller 后，其内部 abort-race
 *   Promise 以**措辞通用的** RequestAbortedError("Stream aborted (abort race)") reject
 *   （消息不含 timeout 字样）——它在 Promise.race 中必然抢先于更具体的 timeoutError。
 *   旧 isTimeoutError 只做消息文本匹配 → 判为 false → 不走超时重试分支 → 一路静默
 *   传播成"用户 ESC 取消"，TUI 只剩 1.5s 瞬时提示，无重试、无错误卡片、无 SessionEnd。
 *
 * 修复：isTimeoutError 改看 turn 级 AbortController 首次 abort() 锁定的 reason
 *   （及错误自身的 abortReason），结构性识别内部超时，不再依赖易被覆盖的消息文本。
 *
 * 本测试直接复现该事故指纹：processStream 抛"通用 abort 错误"（无 timeout 字样），
 *   但在抛出前先 abort turn signal 并锁定内部超时 reason —— 断言 queryLoop 正确走
 *   超时重试分支（有重试提示），而非静默素通被误判为用户取消。
 */
describe("根治回归 — abort-race 通用错误 + turn reason → 仍识别为超时", () => {
  test("processStream 抛无 timeout 字样的 RequestAbortedError（但 turn reason=stream-heartbeat-timeout）→ 走超时重试", async () => {
    // 捕获 turnAbortController 的 composedSignal，模拟 stream-processor 在抛错前
    // 先 abort turn signal（reason 锁定为内部心跳超时）。
    const capturedSignals: AbortSignal[] = [];
    const { loopConfig } = makeLoopConfig({
      sendWithRetry: (_params: any, signal?: AbortSignal) => {
        if (signal) capturedSignals.push(signal);
        return emptyStream();
      },
      // 模拟 stream-processor 真实行为：心跳超时 → abort(reason) → abort-race Promise
      // 以通用消息 reject（消息里绝无 timeout/超时 字样，正是旧文本匹配漏判的根因）。
      processStream: (async (_stream: any, _onText: any, _onThinking: any, turnAc?: AbortController) => {
        // stream-processor 内部：心跳定时器 fire → abort turn 级 controller 带 reason
        try { turnAc?.abort("stream-heartbeat-timeout"); } catch { /* ignore */ }
        throw new RequestAbortedError("Stream aborted (abort race)", "stream-heartbeat-timeout");
      }) as any,
      // 硬超时给足够长，确保退出只可能来自 processStream 抛的 abort-race 错误，
      // 而不是 turnTimeoutPromise 凑巧先 fire（那会绕过被测路径）。
      maxTurnDurationMs: 60_000,
    });

    const kinds: string[] = [];
    const systemTexts: string[] = [];
    let thrown: Error | null = null;
    try {
      for await (const ev of queryLoop(loopConfig)) {
        kinds.push(ev.kind);
        if (ev.kind === "system" && "text" in ev) systemTexts.push(ev.text);
      }
    } catch (e) {
      thrown = e as Error;
    }

    // 核心断言：即便错误消息无 timeout 字样，仍被 isTimeoutError（reason 判据）命中，
    // 走超时重试分支 → 有重试提示（旧代码此处为 false → 直接 throw 静默传播）。
    expect(systemTexts.some((t) => t.includes("超时") && t.includes("重试"))).toBe(true);
    // 重试耗尽后优雅收尾：yield done + 错误提示，绝不 throw 到上层被误当"用户取消"。
    expect(thrown).toBeNull();
    expect(kinds).toContain("done");
    expect(systemTexts.some((t) => t.includes("超时") && t.includes("中断"))).toBe(true);
    // turn signal 的 reason 确实被锁定为内部心跳超时（首次 abort 锁定，不被 race-settled 覆盖）
    expect(
      capturedSignals.some((s) => s.aborted && String(s.reason) === "stream-heartbeat-timeout"),
    ).toBe(true);
  });
});
