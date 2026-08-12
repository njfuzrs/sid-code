/**
 * /clear 必须归零 reminder 通道的跨轮去重键
 *
 * 背景（2026-07-30 重复注入根因修复时发现的连带缺陷）：
 * loop.ts 里三个 reminder 去重/基线键挂在 `SessionState.sessionData` 上，是**故意**的——
 * 它们必须跨用户消息存活，否则每条新消息都会重建、去重形同白做。
 *
 * 但"跨消息"不等于"跨 /clear"。`/clear` 清空对话历史后模型完全失忆，而去重键还记着
 * "已经播报过了" → 新一轮对话**永远不再播报**延迟工具列表，延迟加载机制在 /clear 后失效。
 * compact 路径早有 deferredToolsPendingAfterCompact 兜住同类问题，/clear 此前漏了。
 *
 * `resetCounters()` 只清用量统计、不碰 sessionData，所以这里锁的是
 * `resetReminderDedupKeys()` 存在且覆盖全部三个键，并且两者职责不互相越界。
 */

import { describe, test, expect } from "bun:test";
import { SessionState } from "@sid-code/core/session/state.ts";

/** loop.ts 实际写入 sessionData 的三个 reminder 跨轮键 */
const REMINDER_DEDUP_KEYS = [
  "announcedDeferredTools",
  "lastSeenPermissionMode",
  "lastSeenContextPressureLevel",
] as const;

function seeded(): SessionState {
  const s = new SessionState("test-session");
  s.set("announcedDeferredTools", new Set(["bg_task", "cron"]));
  s.set("lastSeenPermissionMode", "acceptEdits");
  s.set("lastSeenContextPressureLevel", "warn");
  return s;
}

describe("resetReminderDedupKeys — /clear 归零 reminder 去重键", () => {
  test("三个键全部被清除", () => {
    const s = seeded();
    for (const k of REMINDER_DEDUP_KEYS) expect(s.get(k)).toBeDefined();

    s.resetReminderDedupKeys();

    for (const k of REMINDER_DEDUP_KEYS) {
      expect(s.get(k)).toBeUndefined();
      expect(s.has(k)).toBe(false);
    }
  });

  test("清除后延迟工具会重新全量播报（announced 集合视角）", () => {
    const s = seeded();
    s.resetReminderDedupKeys();
    // loop.ts 的读法：取不到就是空 Set → 全部 deferred 工具都算 added → 重新播报
    const announced =
      (s.get("announcedDeferredTools") as Set<string> | undefined) ?? new Set<string>();
    expect(announced.size).toBe(0);

    const deferredNames = ["bg_task", "cron", "worktree"];
    const added = deferredNames.filter((n) => !announced.has(n));
    expect(added).toEqual(deferredNames);
  });

  test("不影响其它 sessionData 键（只清 reminder 那三个，不是清空整个 map）", () => {
    const s = seeded();
    s.set("someOtherKey", "keep-me");
    s.resetReminderDedupKeys();
    expect(s.get("someOtherKey")).toBe("keep-me");
  });

  // 职责边界：这两个 reset 各管一摊，任一方越界都会引入新缺陷
  // （resetCounters 若清 sessionData 会误伤无关键；resetReminderDedupKeys 若清统计会重复扣账）。
  test("resetCounters 不碰 reminder 去重键（故两者都必须在 /clear 里调用）", () => {
    const s = seeded();
    s.resetCounters();
    for (const k of REMINDER_DEDUP_KEYS) expect(s.get(k)).toBeDefined();
  });

  test("resetReminderDedupKeys 不碰用量统计", () => {
    const s = seeded();
    s.updateUsage("deepseek-chat", { input_tokens: 100, output_tokens: 50 } as any, 10);
    const before = s.getTotalUsage();
    s.resetReminderDedupKeys();
    expect(s.getTotalUsage()).toEqual(before);
  });
});
