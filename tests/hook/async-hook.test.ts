/**
 * G7：async / asyncRewake hook 后台执行 + rewake 回灌
 *
 * 验证：
 * 1. async=true 的 command hook 立即返回（不阻塞），结果标记 async:true；
 * 2. 后台进程跑完后由 AsyncHookRegistry 收集；
 * 3. asyncRewake=true 且 exit 2 → 进入 rewake 队列，drainRewakeNotifications 能取出 stderr；
 * 4. asyncRewake=false（或 exit≠2）→ 不进 rewake 队列。
 */

import { describe, test, expect } from "bun:test";
import { HookRunner } from "@sid-code/core/hook/runner.ts";
import { AsyncHookRegistry } from "@sid-code/core/hook/async-registry.ts";
import { HookEventName, type CommandHookConfig, type HookInput } from "@sid-code/core/hook/types.ts";

function baseInput(): HookInput {
  // 去掉了 transcript_path（该字段在 src/hook/ 下已全无踪迹，是早期形态的遗留），
  // 补上必填的 timestamp。字段齐全后不再需要 `as HookInput` 断言。
  return {
    session_id: "test",
    cwd: process.cwd(),
    hook_event_name: HookEventName.PostToolUse,
    timestamp: new Date().toISOString(),
  };
}

/** 轮询等待条件成立（后台进程异步完成） */
async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor 超时");
    await new Promise(r => setTimeout(r, 20));
  }
}

describe("G7 async hook 后台执行", () => {
  test("async=true 立即返回且标记 async:true（不阻塞主循环）", async () => {
    const runner = new HookRunner();
    const registry = new AsyncHookRegistry();
    runner.setAsyncRegistry(registry);

    const config: CommandHookConfig = {
      type: "command",
      name: "slow-hook",
      command: "sleep 0.3; echo done",
      async: true,
    };

    const t0 = Date.now();
    const result = await runner.executeHook(config, HookEventName.PostToolUse, baseInput());
    const elapsed = Date.now() - t0;

    // 立即返回（远小于 300ms 的 sleep）
    expect(elapsed).toBeLessThan(200);
    expect(result.success).toBe(true);
    expect(result.async).toBe(true);
    // 已登记到 async 注册表
    expect(registry.size).toBe(1);
  });

  test("asyncRewake=true 且后台 exit 2 → rewake 队列可取出 stderr", async () => {
    const runner = new HookRunner();
    const registry = new AsyncHookRegistry();
    runner.setAsyncRegistry(registry);

    const config: CommandHookConfig = {
      type: "command",
      name: "rewake-hook",
      command: "echo 'need attention' 1>&2; exit 2",
      async: true,
      asyncRewake: true,
    };

    await runner.executeHook(config, HookEventName.PostToolUse, baseInput());

    // 等后台进程完成并入队
    await waitFor(() => registry.hasRewakeNotifications());

    const notes = registry.drainRewakeNotifications();
    expect(notes.length).toBe(1);
    expect(notes[0].hookName).toBe("rewake-hook");
    expect(notes[0].error).toContain("need attention");
    // 排空后队列清空
    expect(registry.hasRewakeNotifications()).toBe(false);
  });

  test("asyncRewake=false 时 exit 2 不进 rewake 队列", async () => {
    const runner = new HookRunner();
    const registry = new AsyncHookRegistry();
    runner.setAsyncRegistry(registry);

    const config: CommandHookConfig = {
      type: "command",
      name: "no-rewake",
      command: "echo x 1>&2; exit 2",
      async: true,
      asyncRewake: false,
    };

    await runner.executeHook(config, HookEventName.PostToolUse, baseInput());

    // 给后台进程足够时间跑完
    await new Promise(r => setTimeout(r, 300));
    expect(registry.hasRewakeNotifications()).toBe(false);
  });

  test("未注入 asyncRegistry 时 async hook 退化为同步执行（不丢结果）", async () => {
    const runner = new HookRunner();
    // 不调用 setAsyncRegistry

    const config: CommandHookConfig = {
      type: "command",
      name: "fallback-sync",
      command: "echo hello",
      async: true,
    };

    const result = await runner.executeHook(config, HookEventName.PostToolUse, baseInput());
    // 无注册表 → 走同步路径，正常拿到 stdout
    expect(result.success).toBe(true);
    expect(result.async).toBeUndefined();
    expect(result.stdout).toContain("hello");
  });
});
