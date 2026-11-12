/**
 * R3：后台任务通知的「可核对锚点」单测（2026-11-12）
 *
 * 事故 b0aa0f1e：模型挂完一次等待后，把**上一轮**那条 `<task-notification>` 当成刚挂这次
 * 等待的结果，后续每个请求的 thinking 都在复述「sjgm4oq76 又被杀了」。
 *
 * 根因不是模型「记性差」，是通知里**没有可核对的事实**：只有 task-id / status / summary，
 * 模型无法回答「这条通知对应我哪一次调用、是什么时候的事」。
 *
 * 修法 1 给通知补三栏锚点：
 *   - `<tool-use-id>`：对应哪一次工具调用（由 `bash` / `monitor` 声明 `consumesToolUseId`
 *     后由执行器注入，存进 task）；
 *   - `<started-at>` / `<ended-at>`：UTC 秒级绝对时刻。`started-at` 早于本轮用户消息
 *     = 这条通知说的是旧任务。
 *
 * 这份测试断言的正是模型能看到的那一段文本（`formatNotification` 的产物），
 * 而不是源码字面量——锚点漏渲染时通知照样投递、TUI 照样渲染，**不会有任何东西红**。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { formatNotification, enqueueTaskNotification } from "@sid-code/core/task/notification.ts";
import { registerTask, clearAllTasks } from "@sid-code/core/task/registry.ts";
import { dequeuePendingNotifications } from "@sid-code/core/task/notification.ts";
import type { LocalShellTaskState } from "@sid-code/core/task/types.ts";

/** 固定的锚点时刻，断言 UTC 格式化不随本机时区变化 */
const STARTED_AT = Date.UTC(2026, 10, 12, 6, 31, 5); // 2026-11-12T06:31:05Z
const ENDED_AT = Date.UTC(2026, 10, 12, 7, 1, 5); // 2026-11-12T07:01:05Z

function makeShellTask(over: Partial<LocalShellTaskState> = {}): LocalShellTaskState {
  return {
    id: "local_shell_r3test",
    type: "local_shell",
    status: "completed",
    description: "等待 CI",
    startTime: STARTED_AT,
    endTime: ENDED_AT,
    outputFile: "/tmp/r3.txt",
    outputOffset: 0,
    notified: true,
    command: "until ci_ok; do sleep 5; done",
    interrupted: false,
    isBackgrounded: true,
    ...over,
  };
}

beforeEach(() => {
  clearAllTasks();
  // 通知队列是模块级单例：不清空会让上一个用例的通知混进来
  dequeuePendingNotifications();
});

afterEach(() => {
  clearAllTasks();
  dequeuePendingNotifications();
});

describe("R3 通知锚点：formatNotification 渲染", () => {
  test("shell / monitor 类通知带 tool-use-id 与起止时刻（UTC 秒级）", () => {
    const xml = formatNotification({
      taskId: "local_shell_r3test",
      toolUseId: "toolu_01abc",
      startedAt: STARTED_AT,
      endedAt: ENDED_AT,
      outputFile: "/tmp/r3.txt",
      status: "killed",
      summary: "等待期限到（1800 秒），条件未满足，已停止命令",
    });
    expect(xml).toContain("<tool-use-id>toolu_01abc</tool-use-id>");
    expect(xml).toContain("<started-at>2026-11-12T06:31:05Z</started-at>");
    expect(xml).toContain("<ended-at>2026-11-12T07:01:05Z</ended-at>");
  });

  test("三个锚点缺哪个就不写哪个（不编造、不写空标签）", () => {
    const noAnchor = formatNotification({
      taskId: "t",
      outputFile: "/tmp/x.txt",
      status: "completed",
      summary: "done",
    });
    expect(noAnchor).not.toContain("<tool-use-id>");
    expect(noAnchor).not.toContain("<started-at>");
    expect(noAnchor).not.toContain("<ended-at>");

    // 运行中的 monitor 事件通知：只有 started-at（任务还没结束）
    const running = formatNotification({
      taskId: "local_monitor_x",
      toolUseId: "toolu_02",
      startedAt: STARTED_AT,
      outputFile: "/tmp/m.txt",
      status: "running",
      summary: "监控事件：PR #662 CI",
      event: "✓ build",
    });
    expect(running).toContain("<started-at>2026-11-12T06:31:05Z</started-at>");
    expect(running).not.toContain("<ended-at>");
  });

  test("锚点顺序稳定：tool-use-id 在时间锚点之前（模型扫读顺序固定）", () => {
    const xml = formatNotification({
      taskId: "t",
      toolUseId: "toolu_03",
      startedAt: STARTED_AT,
      endedAt: ENDED_AT,
      outputFile: "/tmp/x.txt",
      status: "completed",
      summary: "done",
    });
    expect(xml.indexOf("<tool-use-id>")).toBeLessThan(xml.indexOf("<started-at>"));
    expect(xml.indexOf("<started-at>")).toBeLessThan(xml.indexOf("<ended-at>"));
    // 都必须落在 task-id 之后、output-file 之前
    expect(xml.indexOf("<task-id>")).toBeLessThan(xml.indexOf("<tool-use-id>"));
    expect(xml.indexOf("<ended-at>")).toBeLessThan(xml.indexOf("<output-file>"));
  });
});

describe("R3 通知锚点：enqueueTaskNotification 从 registry 自动补齐", () => {
  test("调用方不传时间也能拿到 registry 里的 startTime / endTime", () => {
    registerTask(
      makeShellTask({
        status: "running",
        endTime: undefined,
        notified: false,
        toolUseId: "toolu_04",
      }),
    );
    // 终态跃迁由 update 侧写 endTime；这里模拟任务结束时 registry 里的事实
    registerTask(makeShellTask({ toolUseId: "toolu_04" }));

    enqueueTaskNotification({
      taskId: "local_shell_r3test",
      outputFile: "/tmp/r3.txt",
      status: "completed",
      summary: "done",
    });

    const [notif] = dequeuePendingNotifications();
    expect(notif).toBeDefined();
    expect(notif!.content).toContain("<started-at>2026-11-12T06:31:05Z</started-at>");
    expect(notif!.content).toContain("<ended-at>2026-11-12T07:01:05Z</ended-at>");
    // toolUseId 来自 task：这正是「bash / monitor 把 _toolUseId 存进任务」的落点
    expect(notif!.content).toContain("<tool-use-id>toolu_04</tool-use-id>");
  });

  test("任务已被驱逐（registry 里没有）时不写时间锚点，也不报错", () => {
    enqueueTaskNotification({
      taskId: "never_registered",
      outputFile: "/tmp/gone.txt",
      status: "completed",
      summary: "done",
    });
    const [notif] = dequeuePendingNotifications();
    expect(notif).toBeDefined();
    expect(notif!.content).toContain("<task-notification>");
    expect(notif!.content).not.toContain("<started-at>");
    expect(notif!.content).not.toContain("<ended-at>");
  });

  test("调用方显式传的时间优先于 registry（不被覆盖）", () => {
    registerTask(makeShellTask({ startTime: 1, endTime: 2 }));
    enqueueTaskNotification({
      taskId: "local_shell_r3test",
      outputFile: "/tmp/r3.txt",
      status: "completed",
      summary: "done",
      startedAt: STARTED_AT,
      endedAt: ENDED_AT,
    });
    const [notif] = dequeuePendingNotifications();
    expect(notif!.content).toContain("<started-at>2026-11-12T06:31:05Z</started-at>");
    expect(notif!.content).toContain("<ended-at>2026-11-12T07:01:05Z</ended-at>");
  });
});
