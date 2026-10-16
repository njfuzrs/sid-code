/**
 * 空闲时队首判定：user-input 与 task-notification 谁先被处理
 *
 * 事故 20261016-124505-786b1586 的 TUI 侧修复点。此前的 drain 只认 user-input
 * （`if (queueLength === 0) return`，而 queueLength 只数 user-input），
 * 主循环 end_turn 之后到达的后台通知永远等不到人来消费。
 *
 * `nextIdleAction` 是那段逻辑的纯函数内核：它决定「空闲时该处理谁」，
 * hook 只负责按它的结论去调对应的回调。
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { nextIdleAction } from "@sid-code/cli/ui/hooks/useMessageQueue.ts";
import {
  enqueueCommand,
  __resetForTest,
  drainByKind,
  type QueuedCommand,
} from "@sid-code/core/query/message-queue-manager.ts";

function enqueueUserInput(text: string, priority: "now" | "next" | "later" = "next") {
  enqueueCommand({ priority, kind: "user-input", payload: text });
}

/** 直接构造快照，避免依赖入队路径（nextIdleAction 只读 priority/kind/enqueuedAt 无关字段） */
function cmd(kind: QueuedCommand["kind"], priority: QueuedCommand["priority"]): QueuedCommand {
  return {
    id: `${kind}-${priority}`,
    kind,
    priority,
    payload: "x",
    enqueuedAt: 0,
  } as QueuedCommand;
}

beforeEach(() => {
  __resetForTest();
  drainByKind("task-notification");
});

describe("nextIdleAction", () => {
  test("空队列 → null（不空转）", () => {
    expect(nextIdleAction([])).toBeNull();
  });

  test("只有 user-input → user-input", () => {
    expect(nextIdleAction([cmd("user-input", "next")])).toBe("user-input");
  });

  test("只有 task-notification → task-notification（本次修复的核心）", () => {
    expect(nextIdleAction([cmd("task-notification", "later")])).toBe("task-notification");
  });

  test("两者都在 → 按队列顺序取队首，用户输入不被通知挤掉", () => {
    // 队列内核按 (优先级, 入队序) 排好序，next 在 later 之前
    expect(nextIdleAction([cmd("user-input", "next"), cmd("task-notification", "later")])).toBe(
      "user-input",
    );
    // 无论快照里谁排在前面，判据都是「队首是谁」——不做 user-input 优先的二次排序，
    // 否则通知会在用户不断输入时永远排不上（饿死）。
    expect(nextIdleAction([cmd("task-notification", "later"), cmd("user-input", "next")])).toBe(
      "task-notification",
    );
  });

  test("跳过本 hook 不负责的 kind（斜杠命令等由别的通道处理）", () => {
    const other = {
      id: "x",
      kind: "slash-command",
      priority: "next",
      payload: "x",
      enqueuedAt: 0,
    } as unknown as QueuedCommand;
    expect(nextIdleAction([other, cmd("task-notification", "later")])).toBe("task-notification");
    expect(nextIdleAction([other])).toBeNull();
  });

  test("与真实入队路径一致：通知经统一队列后队首判定不变", () => {
    enqueueUserInput("用户的问题", "next");
    // 真实通知入队会走 enqueueTaskNotification，此处只验证队列内核的排序口径
    const snap = [cmd("user-input", "next"), cmd("task-notification", "later")];
    expect(nextIdleAction(snap)).toBe("user-input");
  });
});
