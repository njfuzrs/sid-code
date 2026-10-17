/**
 * PR-B（2026-10-17）：子代理对齐 CC 去掉墙钟 / 硬 kill / 默认 maxTurns。
 *
 * 锁三件事：
 *   S2b —— 单轮硬超时兜底：流永不 settle 时 race 让出控制权并 abort 本轮 signal，触发后由调用方重试；
 *   S5  —— 会话退出回收：abortAllAgentTasks 带专属 reason abort 全部在跑的子代理；
 *   S3  —— 已删除的模块不得长回来（timeout-budget / sleep-aware-timer）。
 */

import { describe, test, expect } from "bun:test";
import { existsSync } from "node:fs";
import {
  raceTurnHardTimeout,
  TURN_HARD_TIMEOUT_REASON,
} from "@sid-code/core/agent/turn-hard-timeout.ts";
import { createAgentTask, abortAllAgentTasks } from "@sid-code/core/task/agent-task.ts";
import { ABORT_REASONS, SUBAGENT_SESSION_EXIT_REASON } from "@sid-code/core/llm/errors.ts";

describe("S2b 单轮硬超时兜底", () => {
  test("run 永不 settle → 到点让出，并以 turn-timeout abort 本轮 signal", async () => {
    let seen: AbortSignal | undefined;
    let fired = 0;
    const outer = new AbortController();
    const r = await raceTurnHardTimeout(
      (s) => {
        seen = s;
        return new Promise<never>(() => {}); // 模拟 reader.read() 与 cancel() 同时 hang
      },
      { timeoutMs: 30, signal: outer.signal, onFire: () => fired++ },
    );
    expect(r.timedOut).toBe(true);
    expect(fired).toBe(1);
    expect(seen?.aborted).toBe(true);
    expect(seen?.reason).toBe(TURN_HARD_TIMEOUT_REASON);
    // 外层 signal 不被改写（ESC / 父代理取消是另一条出口）
    expect(outer.signal.aborted).toBe(false);
  });

  test("run 正常完成 → 返回值，不开枪", async () => {
    let fired = 0;
    const r = await raceTurnHardTimeout(async () => 42, {
      timeoutMs: 1_000,
      signal: new AbortController().signal,
      onFire: () => fired++,
    });
    expect(r).toEqual({ timedOut: false, value: 42 });
    expect(fired).toBe(0);
  });

  test("被让出的 run 稍后 reject 不产生孤儿 rejection", async () => {
    const r = await raceTurnHardTimeout(
      (s) =>
        new Promise<never>((_, reject) => {
          s.addEventListener("abort", () => setTimeout(() => reject(new Error("late")), 5));
        }),
      { timeoutMs: 20, signal: new AbortController().signal },
    );
    expect(r.timedOut).toBe(true);
    await new Promise((res) => setTimeout(res, 20)); // 让 late reject 发生；未吞会被 bun 报 unhandled
  });

  test("turn-timeout 已登记 ABORT_REASONS（复用主循环同一 reason）", () => {
    expect((ABORT_REASONS as readonly string[]).includes(TURN_HARD_TIMEOUT_REASON)).toBe(true);
  });
});

describe("S5 会话退出回收在跑的子代理", () => {
  test("abortAllAgentTasks 以专属 reason abort 全部未结束的子代理", () => {
    const a = createAgentTask({ agentType: "explore", prompt: "p", description: "a" });
    const b = createAgentTask({ agentType: "explore", prompt: "p", description: "b" });
    const n = abortAllAgentTasks();
    expect(n).toBeGreaterThanOrEqual(2);
    for (const t of [a, b]) {
      expect(t.abortController.signal.aborted).toBe(true);
      expect(t.abortController.signal.reason).toBe(SUBAGENT_SESSION_EXIT_REASON);
    }
    // 幂等：再调一次不重复 abort
    expect(abortAllAgentTasks()).toBe(0);
  });

  test("reason 已登记 ABORT_REASONS（防孤儿 rejection 崩溃）", () => {
    expect((ABORT_REASONS as readonly string[]).includes(SUBAGENT_SESSION_EXIT_REASON)).toBe(true);
  });
});

describe("S3 已删除模块不得长回来", () => {
  test.each(["timeout-budget.ts", "sleep-aware-timer.ts"])("agent/%s 不存在", (f) => {
    expect(existsSync(`packages/core/src/agent/${f}`)).toBe(false);
  });
});
