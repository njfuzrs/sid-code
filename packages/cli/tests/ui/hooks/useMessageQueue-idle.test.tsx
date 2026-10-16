/**
 * useMessageQueue：空闲时到底会不会去消费通知（不只是「分类对不对」）
 *
 * 上一份测试（message-queue-idle-action.test.ts）只证明**判定函数**分得清队首是
 * user-input 还是 task-notification。判定对了却没人按结论去调回调，断链照样存在——
 * 这正是本仓库反复踩的那类漏洞（「绿了但没测到」：判据提纯了，却没证明它接进生产路径）。
 *
 * 所以这里渲染真 hook，观察两条副作用：onSend 被调 / onNotifications 被调。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import React from "react";
import { render } from "@sid-code/cli/ui/render-port/testing.ts";
import { Text } from "@sid-code/cli/ui/render-port/components.ts";
import { StreamingState } from "@sid-code/cli/ui/types.ts";
import { useMessageQueue } from "@sid-code/cli/ui/hooks/useMessageQueue.ts";
import {
  enqueueCommand,
  __resetForTest,
  drainByKind,
} from "@sid-code/core/query/message-queue-manager.ts";
import { enqueueTaskNotification } from "@sid-code/core/task/notification.ts";

const tick = () => new Promise((r) => setTimeout(r, 0));

interface Calls {
  sent: string[];
  notified: number;
}

/**
 * harness：把 hook 挂到真组件上，让 effect 能跑。
 * 渲染一个固定字符即可——本测试断言的是回调副作用，不是画面。
 */
function Harness({
  calls,
  state,
  blocked,
  withNotifications,
}: {
  calls: Calls;
  state: StreamingState;
  blocked?: boolean;
  withNotifications?: boolean;
}): React.ReactElement {
  useMessageQueue({
    streamingState: state,
    onSend: async (text: string) => {
      calls.sent.push(text);
    },
    onNotifications: withNotifications
      ? async () => {
          calls.notified++;
          // 真实现会在这里 drain 通知；测试里也 drain，避免 effect 反复触发
          drainByKind("task-notification");
        }
      : undefined,
    notificationsBlocked: blocked,
  });
  return React.createElement(Text, null, "x");
}

function makeCalls(): Calls {
  return { sent: [], notified: 0 };
}

beforeEach(() => {
  __resetForTest();
});

afterEach(() => {
  __resetForTest();
});

describe("useMessageQueue 空闲消费", () => {
  test("空闲 + 队列只有通知 → 调 onNotifications（本次修复的核心）", async () => {
    const calls = makeCalls();
    enqueueTaskNotification({
      taskId: "t1",
      outputFile: "/tmp/x.txt",
      status: "completed",
      summary: "子代理完成",
      result: {
        output: "结论",
        totalToolUseCount: 1,
        totalTokens: 1,
        usage: { inputTokens: 1, outputTokens: 0 },
      },
    });

    const { unmount } = render(
      React.createElement(Harness, {
        calls,
        state: StreamingState.Idle,
        withNotifications: true,
      }),
    );
    await tick();
    await tick();

    expect(calls.notified).toBe(1);
    expect(calls.sent).toHaveLength(0);
    unmount();
  });

  test("空闲 + 队列有用户输入 → 调 onSend 而不是 onNotifications", async () => {
    const calls = makeCalls();
    enqueueCommand({ priority: "next", kind: "user-input", payload: "用户的问题" });

    const { unmount } = render(
      React.createElement(Harness, {
        calls,
        state: StreamingState.Idle,
        withNotifications: true,
      }),
    );
    await tick();
    await tick();

    expect(calls.sent).toEqual(["用户的问题"]);
    expect(calls.notified).toBe(0);
    unmount();
  });

  test("对话框打开（notificationsBlocked）→ 不自动续跑通知", async () => {
    const calls = makeCalls();
    enqueueTaskNotification({
      taskId: "t2",
      outputFile: "/tmp/x.txt",
      status: "completed",
      summary: "子代理完成",
    });

    const { unmount } = render(
      React.createElement(Harness, {
        calls,
        state: StreamingState.Idle,
        withNotifications: true,
        blocked: true,
      }),
    );
    await tick();
    await tick();

    // 对标 cc 的 hasActiveLocalJsxUI：用户正在做别的交互，不抢焦点
    expect(calls.notified).toBe(0);
    unmount();
  });

  test("流式中 → 什么都不做（通知留待回合边界或下一次空闲）", async () => {
    const calls = makeCalls();
    enqueueTaskNotification({
      taskId: "t3",
      outputFile: "/tmp/x.txt",
      status: "completed",
      summary: "子代理完成",
    });

    const { unmount } = render(
      React.createElement(Harness, {
        calls,
        state: StreamingState.Connecting,
        withNotifications: true,
      }),
    );
    await tick();
    await tick();

    expect(calls.notified).toBe(0);
    expect(calls.sent).toHaveLength(0);
    unmount();
  });

  test("宿主未实现 onNotifications → 通知不被消费，但用户输入照常接续（向后兼容）", async () => {
    const calls = makeCalls();
    enqueueTaskNotification({
      taskId: "t4",
      outputFile: "/tmp/x.txt",
      status: "completed",
      summary: "子代理完成",
    });
    enqueueCommand({ priority: "next", kind: "user-input", payload: "还是能发" });

    const { unmount } = render(React.createElement(Harness, { calls, state: StreamingState.Idle }));
    await tick();
    await tick();

    expect(calls.notified).toBe(0);
    expect(calls.sent).toEqual(["还是能发"]);
    unmount();
  });
});
