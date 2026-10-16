/**
 * 后台任务通知注入的**落盘**与**形状**：injectPendingNotifications 的生产契约
 *
 * 两个调用点共用它——queryLoop 每轮开头（轮中到达）、QueryEngine.resumeWithNotifications
 * （空闲后到达）。落盘是本次补的一半：此前通知只进内存不进 sessionStore，
 * `-c` 恢复的会话里主代理「看过」的子代理结论凭空消失，后续回答失去依据。
 *
 * 形状（合成一条 user 消息 / 每条一个 text 块 / _meta.notif 是数组）是既有不变量，
 * 一并锁住——它防的是「逐条 addMessage 触发同 role 合并，_meta 被覆盖，
 * TUI 只剩最后一条」那个已修过的回归。
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { injectPendingNotifications } from "@sid-code/core/query/loop.ts";
import { Manager as ContextManager } from "@sid-code/core/context/manager.ts";
import { enqueueTaskNotification } from "@sid-code/core/task/notification.ts";
import { __resetForTest } from "@sid-code/core/query/message-queue-manager.ts";
import type { Message } from "@sid-code/core/llm/types.ts";

function notif(taskId: string, output: string) {
  return {
    taskId,
    outputFile: `/tmp/${taskId}.txt`,
    status: "completed" as const,
    summary: `子代理 ${taskId} 完成`,
    result: {
      output,
      totalToolUseCount: 2,
      totalTokens: 100,
      usage: { inputTokens: 80, outputTokens: 20 },
    },
  };
}

/** 最小 ctxMgr：只需 addMessage / getMessages */
function makeCtx() {
  return new ContextManager({ maxTokens: 200_000 });
}

beforeEach(() => {
  __resetForTest();
});

describe("injectPendingNotifications", () => {
  test("无通知 → 返回 0，不写任何消息（调用方据此不显示空轮）", () => {
    const ctx = makeCtx();
    const appended: Message[] = [];
    expect(
      injectPendingNotifications(ctx, { appendMessage: (m: Message) => appended.push(m) } as any),
    ).toBe(0);
    expect(ctx.getMessages()).toHaveLength(0);
    expect(appended).toHaveLength(0);
  });

  test("两条通知合成**一条** user 消息，_meta.notif 是数组（不丢任何一条）", () => {
    enqueueTaskNotification(notif("a1", "结论一"));
    enqueueTaskNotification(notif("a2", "结论二"));
    const ctx = makeCtx();
    const appended: Message[] = [];

    const n = injectPendingNotifications(ctx, {
      appendMessage: (m: Message) => appended.push(m),
    } as any);

    expect(n).toBe(2);
    const msgs = ctx.getMessages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.role).toBe("user");
    // 每条一个 text 块，保留 XML 边界
    expect((msgs[0]!.content as any[]).filter((b) => b.type === "text")).toHaveLength(2);
    // 结构化快照全在——逐条 addMessage 会因同 role 合并被覆盖，这条锁住那个回归
    expect(msgs[0]!._meta?.notif as unknown[]).toHaveLength(2);
    expect(msgs[0]!._meta?.origin).toBe("task-notification");
  });

  test("注入的内容**落盘**（-c 恢复后主代理仍能看到子代理结论）", () => {
    enqueueTaskNotification(notif("b1", "落盘验证"));
    const ctx = makeCtx();
    const appended: Message[] = [];

    injectPendingNotifications(ctx, { appendMessage: (m: Message) => appended.push(m) } as any);

    expect(appended).toHaveLength(1);
    expect(appended[0]!.role).toBe("user");
    const text = (appended[0]!.content as any[]).map((b) => b.text).join("");
    expect(text).toContain("<task-notification>");
    expect(text).toContain("落盘验证");
  });

  test("落盘失败不阻断注入（持久化是尽力而为，不能拖垮主循环）", () => {
    enqueueTaskNotification(notif("c1", "结论"));
    const ctx = makeCtx();

    expect(() =>
      injectPendingNotifications(ctx, {
        appendMessage: () => {
          throw new Error("磁盘满了");
        },
      } as any),
    ).not.toThrow();
    expect(ctx.getMessages()).toHaveLength(1);
  });

  test("第二次调用不再重复注入（通知出队即消费）", () => {
    enqueueTaskNotification(notif("d1", "只注入一次"));
    const ctx = makeCtx();
    expect(injectPendingNotifications(ctx)).toBe(1);
    expect(injectPendingNotifications(ctx)).toBe(0);
    expect(ctx.getMessages()).toHaveLength(1);
  });
});
