/**
 * CG-2（台账 H4 / 后续规划 §2.5）：/clear 必须清「本任务进展」类状态
 *
 * 缺陷形态：`MEASURED_PROGRESS_KEY`（实测进展）与 `TODO_REWORK_KEY`（标完成后又返工）
 * 挂在 SessionState 上是**故意的**——它们必须跨用户消息存活，否则每条新消息都会重建。
 * 但 `/clear` 之后模型对旧对话完全失忆，这两个状态还记着**上一个任务**的落盘文件与观测值：
 * 新会话第一条 work-log 就会说「已落盘改动 N 个文件」，模型把旧成果当成本次进展、不再动手
 * （台账实测 4 会话 / 6 条）。
 *
 * 这份测试锁三件事：
 *   1. 两个键确实被清；
 *   2. 不清其它 sessionData 键（不是把整个 map 清空）；
 *   3. 与 `resetReminderDedupKeys` 职责不交叉（两类状态都得在 /clear 里各调一次，
 *      任一方越界都会引入新缺陷）。
 */

import { describe, test, expect } from "bun:test";
import { SessionState } from "@sid-code/core/session/state.ts";
import {
  MEASURED_PROGRESS_KEY,
  createMeasuredProgressState,
} from "@sid-code/core/query/measured-progress.ts";
import { TODO_REWORK_KEY, createTodoReworkState } from "@sid-code/core/query/todo-rework.ts";

function seeded(): SessionState {
  const s = new SessionState("test-session");
  const progress = createMeasuredProgressState();
  progress.filesChanged.add("/repo/a.ts");
  progress.metrics.set("tsc --noEmit | grep -c error", {
    label: "tsc --noEmit | grep -c error",
    first: 139,
    last: 113,
    count: 2,
  });
  s.set(MEASURED_PROGRESS_KEY, progress);

  const rework = createTodoReworkState();
  rework.filesSinceLastWrite.add("/repo/a.ts");
  s.set(TODO_REWORK_KEY, rework);

  // 与本次修复无关的会话级状态：必须原样保留
  s.set("someOtherKey", "keep-me");
  s.set("announcedDeferredTools", new Set(["bg_task"]));
  return s;
}

describe("resetTaskProgressKeys — /clear 归零本任务进展", () => {
  test("两个键全部被清除", () => {
    const s = seeded();
    expect(s.get(MEASURED_PROGRESS_KEY)).toBeDefined();
    expect(s.get(TODO_REWORK_KEY)).toBeDefined();

    s.resetTaskProgressKeys();

    expect(s.has(MEASURED_PROGRESS_KEY)).toBe(false);
    expect(s.has(TODO_REWORK_KEY)).toBe(false);
  });

  test("只清这两个键，不清空整个 sessionData", () => {
    const s = seeded();
    s.resetTaskProgressKeys();

    expect(s.get("someOtherKey")).toBe("keep-me");
    // reminder 去重键属于 resetReminderDedupKeys 的职责，这里不越界
    expect(s.get("announcedDeferredTools")).toBeDefined();
  });

  test("清掉后 loop 侧会重新创建一个空状态（不会拿到上一个任务的进展）", () => {
    const s = seeded();
    s.resetTaskProgressKeys();
    // loop.ts 的读法：取不到就 create + set
    const rebuilt =
      (s.get(MEASURED_PROGRESS_KEY) as ReturnType<typeof createMeasuredProgressState>) ??
      createMeasuredProgressState();
    expect(rebuilt.filesChanged.size).toBe(0);
    expect(rebuilt.metrics.size).toBe(0);
  });

  test("resetReminderDedupKeys 不清这两个键（两者都必须在 /clear 里调）", () => {
    const s = seeded();
    s.resetReminderDedupKeys();
    expect(s.get(MEASURED_PROGRESS_KEY)).toBeDefined();
    expect(s.get(TODO_REWORK_KEY)).toBeDefined();
  });

  test("resetTaskProgressKeys 不碰用量统计", () => {
    const s = seeded();
    s.updateUsage("deepseek-chat", { input_tokens: 100, output_tokens: 50 } as any, 10);
    const before = s.getTotalUsage();

    s.resetTaskProgressKeys();

    expect(s.getTotalUsage()).toEqual(before);
  });
});
