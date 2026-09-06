/**
 * 后台通知「非用户输入」声明——**贯穿生产路径**的端到端判据
 *
 * ## 为什么单测 formatNotification 不够
 *
 * `core/tests/task/notification-not-user-input.test.ts` 只证明「格式化函数会拼上声明」。
 * 但这条防线真正要成立，还得两件事同时为真：
 *
 * 1. **声明能活着走完生产投递路径**（enqueueTaskNotification → 统一队列 → dequeue），
 *    到达注入 LLM 的那段文本里。任何一环把 content 重写/截断，防线就静默消失。
 * 2. **声明不会漏进 TUI 给用户看**。它是给模型的，用户看见就是噪音——而这正是本次
 *    改动**真实踩到的回归**：`history-adapter` 原用 `startsWith("<task-notification>")`
 *    识别通知，前置声明后漏判 → 整条通知退化成 `>` 前缀普通消息灌屏、声明文本一并显示。
 *
 * 两条判据方向相反（要在 wire 上、不要在屏幕上），必须一起测——只测一边时，
 * 「把声明删掉」和「把 TUI 判据改回 startsWith」各有一个能蒙过去。
 *
 * ⚠️ 仍未覆盖的部分（如实记下，不要让这份测试制造「已完全验证」的错觉）：
 * 真实 LLM 会话里 `raw.jsonl` 的 wire 文本尚未人工核对过。本测试证明的是
 * 「harness 侧到注入点为止的链路完整」，不是「模型真的收到了」。
 */

import { describe, test, expect, beforeEach } from "bun:test";
import {
  enqueueTaskNotification,
  dequeuePendingNotifications,
  NOT_USER_INPUT_PREAMBLE,
} from "@sid-code/core/task/notification.ts";
import { drainByKind } from "@sid-code/core/query/message-queue-manager.ts";
import { messagesToHistoryItems } from "@sid-code/cli/ui/history-adapter.ts";
import type { Message } from "@sid-code/core/llm/types.ts";

const notif = {
  taskId: "bg-e2e-1",
  outputFile: "/tmp/e2e.txt",
  status: "completed" as const,
  summary: "后台核查完成",
  result: {
    output: "子代理结论：三处不一致已定位",
    totalToolUseCount: 3,
    totalTokens: 200,
    usage: { inputTokens: 150, outputTokens: 50 },
  },
};

beforeEach(() => {
  // 队列是模块级单例，先排空避免跨测试串味
  drainByKind("task-notification");
});

describe("声明贯穿生产投递路径", () => {
  test("enqueue → dequeue 后，注入 LLM 的文本仍带声明且在 XML 之前", () => {
    enqueueTaskNotification(notif);
    const out = dequeuePendingNotifications();
    expect(out).toHaveLength(1);

    const content = out[0].content;
    expect(content).toContain(NOT_USER_INPUT_PREAMBLE);
    expect(content.indexOf(NOT_USER_INPUT_PREAMBLE)).toBeLessThan(
      content.indexOf("<task-notification>"),
    );
    // 结构化快照走平行通道，不受前缀影响（TUI 靠它渲染）
    expect(out[0].structured?.taskId).toBe("bg-e2e-1");
  });
});

describe("声明不得漏进 TUI（这是本次真实踩到的回归）", () => {
  /** 按 query/loop.ts:769 的形状构造注入消息：content 是通知文本，_meta 带结构化快照。 */
  function injectedMessage(content: string, withMeta: boolean): Message {
    return {
      role: "user",
      content: [{ type: "text", text: content }],
      ...(withMeta
        ? {
            _meta: {
              origin: "task-notification",
              isMeta: true,
              notif: [
                {
                  taskId: notif.taskId,
                  status: notif.status,
                  summary: notif.summary,
                  outputFile: notif.outputFile,
                  result: notif.result.output,
                },
              ],
            },
          }
        : {}),
    } as Message;
  }

  test("走结构化快照路径：渲染成 task_notification 折叠项，声明文本不出现", () => {
    enqueueTaskNotification(notif);
    const content = dequeuePendingNotifications()[0].content;

    const items = messagesToHistoryItems([injectedMessage(content, true)]);
    expect(items.some((i) => i.type === "task_notification")).toBe(true);
    // 关键：整个渲染结果里不得含声明文本（用户不该看见给模型的话）
    expect(JSON.stringify(items)).not.toContain("非用户输入");
  });

  test("回退正则路径（旧会话 resume，无 _meta.notif）：仍识别为通知，不退化成普通消息", () => {
    // 这条是回归本体：前缀存在时 startsWith 判据会漏判，通知被当成 user 文本全量渲染。
    enqueueTaskNotification(notif);
    const content = dequeuePendingNotifications()[0].content;

    const items = messagesToHistoryItems([injectedMessage(content, false)]);
    expect(
      items.some((i) => i.type === "task_notification"),
      "带前缀的通知必须仍被识别为 task_notification（否则声明会连同整条 XML 灌屏）",
    ).toBe(true);
    expect(JSON.stringify(items)).not.toContain("非用户输入");
  });
});
