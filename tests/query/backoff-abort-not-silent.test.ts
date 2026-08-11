/**
 * P0-b 回归：退避期间被 abort 时，收尾**不得静默**（事故 20260801-175042-699f69f8）
 *
 * ── 事故机制 ──────────────────────────────────────────────────────────
 * 第三次系统唤醒时，watchdog 与 60 分钟会话硬顶在同一毫秒补 fire：
 *   11:03:19.170  WatchdogKill → reject → 进 catch 走 timeout 重试
 *   11:03:19.176  abort("session-timeout")   ← sessionTimer 同时补 fire
 *   11:03:19.177  "退避期间会话被中断…放弃本次重试并收尾"
 * 然后 loop 走 `yield done; return`——**正常返回，不抛异常**：
 *   loop.ts → engine.ts:399(收到 done 即 return) → app.ts case "done"
 *   → completedNormally = true
 * app.ts 里为 session-timeout 准备的专属文案全在 **catch 块**，永远执行不到；
 * completedNormally=true 还跳过了 "⚠️ 任务异常中断" 兜底。
 * 结果：任务停了，TUI 上一个字都没有。
 *
 * ── 本测试锁定的不变量 ────────────────────────────────────────────────
 * 该分支必须在 yield done **之前**先 yield 一条用户可见的 system 事件。
 * 这是"用户能不能知道任务为什么停了"的唯一保障，绝不能被后续重构悄悄拿掉。
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

function makeConfig(): Config {
  return { model: "test-model", provider: "anthropic", maxTurns: 5 } as unknown as Config;
}

async function* emptyStream(): AsyncIterable<StreamEvent> {
  // 内容不重要：processStream 会直接抛超时
}

/**
 * 构造"流超时 → 进重试 → 退避期间会话被 abort"的场景。
 * @param abortReason 会话级 abort 的 reason，决定文案分支
 */
function makeLoop(abortReason: string): QueryLoopConfig {
  const ctxMgr = new ContextManager({ maxTokens: 200000 });
  ctxMgr.setSystemPrompt("test");
  ctxMgr.addMessage({ role: "user", content: [{ type: "text", text: "做点事" }] });

  // 退避开始前不 abort，进入退避后才 abort——精确复现事故时序。
  const sessionAbort = new AbortController();

  const deps: QueryDeps = {
    sendWithRetry: () => emptyStream(),
    processStream: async () => {
      // 首次调用即抛超时，把控制流送进 isTimeoutError 重试分支；
      // 同时立刻 abort 会话，使退避结束后的复检命中"会话已被中断"。
      sessionAbort.abort(abortReason);
      const err = new Error("请求超时");
      (err as { name: string }).name = "TimeoutError";
      throw err;
    },
    executeTools: async () => ({ results: [] }),
    autoCompact: async () => {},
    handleContextOverflow: () => null,
    getAbortSignal: () => sessionAbort.signal,
    uuid: () => "uuid-test",
  };

  return {
    config: makeConfig(),
    ctxMgr,
    toolRegistry: new ToolRegistry(),
    sessionState: new SessionState("test-session"),
    fallback: new ModelFallback(),
    deps,
  };
}

describe("P0-b — 退避期间 abort 收尾不静默", () => {
  beforeEach(() => {
    // 把退避压到近 0，避免真实等待拖爆测试
    process.env.SID_CODE_MAX_TIMEOUT_RETRIES = "3";
    process.env.SID_CODE_RETRY_BACKOFF_BASE_MS = "1";
    process.env.SID_CODE_RETRY_BACKOFF_MAX_MS = "1";
  });
  afterEach(() => {
    delete process.env.SID_CODE_MAX_TIMEOUT_RETRIES;
    delete process.env.SID_CODE_RETRY_BACKOFF_BASE_MS;
    delete process.env.SID_CODE_RETRY_BACKOFF_MAX_MS;
  });

  test("session-timeout：done 之前必须先给出可见说明", async () => {
    const events: Array<{ kind: string; text?: string }> = [];
    for await (const ev of queryLoop(makeLoop("session-timeout"))) {
      events.push(ev as { kind: string; text?: string });
    }

    // 核心断言：不能只有 done（那正是事故里"什么都没显示"的形态）
    const systemEvents = events.filter((e) => e.kind === "system");
    expect(systemEvents.length).toBeGreaterThan(0);

    // 顺序不变量：说明必须在 done 之前，否则 UI 侧 done 一到就收尾、说明会被丢掉
    const doneIdx = events.findIndex((e) => e.kind === "done");
    const firstSystemIdx = events.findIndex((e) => e.kind === "system");
    expect(doneIdx).toBeGreaterThan(-1);
    expect(firstSystemIdx).toBeLessThan(doneIdx);

    // 文案必须点明"会话上限 + 可继续"，而不是笼统的"已取消"
    const text = systemEvents.map((e) => e.text ?? "").join("\n");
    expect(text).toContain("上限");
    expect(text).toContain("接着做");
  });

  test("user-cancel：同样有说明，且措辞是取消而非故障", async () => {
    const events: Array<{ kind: string; text?: string; level?: string }> = [];
    for await (const ev of queryLoop(makeLoop("user-cancel"))) {
      events.push(ev as { kind: string; text?: string; level?: string });
    }
    const sys = events.filter((e) => e.kind === "system");
    expect(sys.length).toBeGreaterThan(0);
    expect(sys.map((e) => e.text ?? "").join("\n")).toContain("取消");
    // 用户主动取消不是故障，不该标成 error（否则会刷红色错误卡片惊吓用户）
    expect(sys.some((e) => e.level === "error")).toBe(false);
  });

  test("未知 reason：按故障措辞给出说明（不静默、不误报成用户取消）", async () => {
    const events: Array<{ kind: string; text?: string; level?: string }> = [];
    for await (const ev of queryLoop(makeLoop("some-internal-reason"))) {
      events.push(ev as { kind: string; text?: string; level?: string });
    }
    const sys = events.filter((e) => e.kind === "system");
    expect(sys.length).toBeGreaterThan(0);
    const text = sys.map((e) => e.text ?? "").join("\n");
    // 必须把 reason 透出来，便于用户/我们据此定位，而不是吞掉
    expect(text).toContain("some-internal-reason");
    expect(sys.some((e) => e.level === "error")).toBe(true);
  });
});
