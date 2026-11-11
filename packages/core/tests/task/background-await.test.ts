/**
 * 「在跑」≠「值得等」+ 空闲主循环唤醒保证（事故 20261103-130950-00ef059c）
 *
 * 事故形状：后台常驻假服务器一直在跑、从不退出 → todo 闸门 T2 以「有后台任务、等它回报」放行
 * 收尾 → 那条回报永远不会来，会话静默停住。
 *
 * 前半段测纯口径（注入 now）；后半段用真实 spawnShellTask + 真实看门狗 tick，不 mock 队列与
 * 注册表——断链发生在子系统之间，mock 接起来测的是 mock。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  SHELL_QUIESCENT_MS,
  trackShellActivity,
  recordShellOutputSize,
  isAwaitedBackgroundTask,
  outputBufferedUntilExit,
  hasAwaitedBackgroundTasks,
  beginMainLoopTurn,
  endMainLoopTurn,
  takeQuiescentWake,
  __resetBackgroundAwaitForTest,
} from "@sid-code/core/task/background-await.ts";
import { waitForBackgroundNotification } from "@sid-code/core/task/background-wake.ts";
import { spawnShellTask, killShellTask } from "@sid-code/core/task/shell-task.ts";
import { createAgentTask } from "@sid-code/core/task/agent-task.ts";
import { getTask, registerTask } from "@sid-code/core/task/registry.ts";
import { registerWait, __resetWaitRegistryForTest } from "@sid-code/core/task/wait-registry.ts";
import type { LocalShellTaskState } from "@sid-code/core/task/types.ts";
import { drainByKind, __resetForTest } from "@sid-code/core/query/message-queue-manager.ts";

const T0 = 1_000_000;

function shellTask(id: string, command = "bun run server.ts"): LocalShellTaskState {
  return {
    id,
    type: "local_shell",
    status: "running",
    description: "server",
    startTime: T0,
    outputFile: "/dev/null",
    outputOffset: 0,
    notified: false,
    command,
    interrupted: false,
    isBackgrounded: true,
  };
}

beforeEach(() => {
  __resetBackgroundAwaitForTest();
  __resetForTest();
});

describe("isAwaitedBackgroundTask：后台 shell 静默后不再算「值得等」", () => {
  test("刚起跑 / 一直有输出 → 值得等；连续静默 ≥ 阈值 → 不值得等", () => {
    const t = shellTask("b-silent");
    trackShellActivity(t.id, 0, T0);
    expect(isAwaitedBackgroundTask(t, T0 + 1_000)).toBe(true);

    // 持续有输出：每次增长都刷新锚点
    recordShellOutputSize(t.id, 100, T0 + 50_000);
    expect(isAwaitedBackgroundTask(t, T0 + 50_000 + SHELL_QUIESCENT_MS - 1)).toBe(true);

    // 字节数不变：静默满阈值即不再值得等
    recordShellOutputSize(t.id, 100, T0 + 100_000);
    expect(isAwaitedBackgroundTask(t, T0 + 50_000 + SHELL_QUIESCENT_MS)).toBe(false);
  });

  test("前台 shell、终态任务都不算", () => {
    const fg = { ...shellTask("b-fg"), isBackgrounded: false };
    const done = { ...shellTask("b-done"), status: "completed" as const };
    expect(isAwaitedBackgroundTask(fg, T0)).toBe(false);
    expect(isAwaitedBackgroundTask(done, T0)).toBe(false);
  });

  test("后台子代理不受静默口径影响：终态必有通知，始终值得等", () => {
    const { taskState } = createAgentTask({
      agentType: "explore",
      prompt: "x",
      description: "x",
      isBackgrounded: true,
    });
    try {
      expect(isAwaitedBackgroundTask(taskState, Date.now() + 10 * SHELL_QUIESCENT_MS)).toBe(true);
    } finally {
      const t = getTask(taskState.id);
      if (t) t.status = "completed";
    }
  });
});

describe("takeQuiescentWake：只唤醒「收尾时在等、之后静默」的任务，且只一次", () => {
  // 这组只验状态机，任务登记用 trackShellActivity，不需要注册表
  test("主循环忙时不唤醒；收尾未登记的不唤醒（登记后唤醒一次见下方端到端）", () => {
    const id = "b-wake";
    trackShellActivity(id, 0, T0);
    // 未经 endMainLoopTurn 登记
    expect(takeQuiescentWake(id, T0 + SHELL_QUIESCENT_MS)).toBe(false);

    beginMainLoopTurn();
    // 主循环忙：即便静默也不唤醒（它会在回合边界自己看到状态）
    expect(takeQuiescentWake(id, T0 + SHELL_QUIESCENT_MS)).toBe(false);
  });
});

describe("真实 shell 任务端到端：常驻服务不会让空闲主循环永远等下去", () => {
  let spawned: string[] = [];
  afterEach(() => {
    for (const id of spawned) killShellTask(id);
    spawned = [];
    __resetForTest();
  });

  test("收尾时在等的后台 shell 转入静默 → 看门狗投 running 通知，等待方被叫醒", async () => {
    // 常驻、无输出：等价于事故里的假服务器
    const task = spawnShellTask({ command: "sleep 30", cwd: process.cwd() });
    spawned.push(task.id);

    // 主循环跑完一轮收尾：此刻任务刚起跑，值得等 → 被登记
    beginMainLoopTurn();
    endMainLoopTurn();
    expect(hasAwaitedBackgroundTasks()).toBe(true);

    // 等待方（headless / TUI 空闲续跑）开始等
    const waiting = waitForBackgroundNotification();

    // 把「最后一次有输出」拨回阈值之前：等价于服务器已静默 60s
    trackShellActivity(task.id, 0, Date.now() - SHELL_QUIESCENT_MS - 1_000);

    // 看门狗 5s 一个 tick
    expect(await waiting).toBe("notification");
    const notifs = drainByKind("task-notification");
    expect(notifs).toHaveLength(1);
    const content = String((notifs[0]!.payload as { content: string }).content);
    expect(content).toContain(task.id);
    expect(content).toContain("<status>running</status>");
    expect(content).toContain("不会再自动回报");

    // 唤醒只投一次：静默之后不再值得等，等待方立刻得到 idle 而不是挂住
    expect(hasAwaitedBackgroundTasks()).toBe(false);
    expect(await waitForBackgroundNotification()).toBe("idle");
    expect(getTask(task.id)?.status).toBe("running");
  }, 15_000);
});

describe("outputBufferedUntilExit：管道末段读到 EOF 才输出的命令（事故 20261106-101611-d0a96bc1）", () => {
  test("`… | tail -60` 等 → true", () => {
    expect(
      outputBufferedUntilExit("bun test --test-name-pattern '^(?!.*\\[slow\\])' 2>&1 | tail -60"),
    ).toBe(true);
    expect(outputBufferedUntilExit("make build 2>&1 | /usr/bin/tail -n 20")).toBe(true);
    expect(outputBufferedUntilExit("grep -r x . | sort")).toBe(true);
    expect(outputBufferedUntilExit("cat a | wc -l; echo done")).toBe(true);
  });
  test("流式 / 非管道 / || → false", () => {
    expect(outputBufferedUntilExit("bun test")).toBe(false);
    expect(outputBufferedUntilExit("tail -f log.txt")).toBe(false);
    expect(outputBufferedUntilExit("bun run server 2>&1 | tail -f")).toBe(false);
    expect(outputBufferedUntilExit("bun run server | tail -F -n 5")).toBe(false);
    expect(outputBufferedUntilExit("cmd | tail --follow")).toBe(false);
    expect(outputBufferedUntilExit("bun run server | tee log")).toBe(false);
    expect(outputBufferedUntilExit("make || tail x")).toBe(false);
  });
});

test("isAwaitedBackgroundTask：`… | tail -60` 静默再久也算值得等（它退出时必有完成通知）", () => {
  const t = { ...shellTask("buf"), command: "bun test 2>&1 | tail -60" };
  trackShellActivity("buf", 0, T0);
  expect(isAwaitedBackgroundTask(t, T0 + SHELL_QUIESCENT_MS * 10)).toBe(true);
  // 对照：同样静默的常驻服务不算
  trackShellActivity("srv", 0, T0);
  expect(isAwaitedBackgroundTask(shellTask("srv"), T0 + SHELL_QUIESCENT_MS)).toBe(false);
});

/**
 * N4（事故 20261109-191904-962011a6）：闸门与唤醒器两套口径打架。
 *
 * `isAwaitedBackgroundTask` 把「输出憋到退出」和「声明了 wait_until」判成**值得等**
 * （它们退出 / 到期必有通知），于是 `endMainLoopTurn` 把它们登记进 `pendingWakeIds`；
 * 60s 后 `takeQuiescentWake` 只看静默时长，放一条「已静默、不会再自动回报」。
 * 模型收到这句只能自己前台去查——那次会话连查 32 次、8.45M 输入 token。
 *
 * 最后一条反例守 20261103-130950-00ef059c：常驻服务必须仍被静默唤醒。
 */
describe("N4：自己会回报的后台 shell 不叠静默唤醒", () => {
  const registered: string[] = [];

  beforeEach(() => {
    registered.length = 0;
  });

  afterEach(() => {
    // 只把自己注册的任务置终态：同批测试文件也在这一个进程里共用 registry
    for (const id of registered) {
      const t = getTask(id);
      if (t) t.status = "completed";
    }
    __resetWaitRegistryForTest();
  });

  function registerRunning(t: LocalShellTaskState): LocalShellTaskState {
    registerTask(t);
    registered.push(t.id);
    return t;
  }

  test("输出憋到退出（… | tail -30）的 shell 静默后不放静默唤醒", () => {
    const t = registerRunning({
      ...shellTask("n4-tail"),
      command: "gh pr checks 701 --watch 2>&1 | tail -30",
    });
    trackShellActivity(t.id, 0, T0);
    beginMainLoopTurn();
    endMainLoopTurn(T0 + 1_000);

    const later = T0 + SHELL_QUIESCENT_MS + 5_000;
    // 闸门口径不变：它退出时必有完成通知，仍算「值得等」
    expect(isAwaitedBackgroundTask(t, later)).toBe(true);
    // 唤醒器不该再补一条「已静默、不会再自动回报」
    expect(takeQuiescentWake(t.id, later)).toBe(false);
  });

  test("声明了 wait_until 的 shell 静默后不放静默唤醒", () => {
    const t = registerRunning({
      ...shellTask("n4-until"),
      command: "until gh pr checks 1; do sleep 30; done",
    });
    registerWait({
      id: t.id,
      kind: "shell",
      promise: { kind: "deadline", deadlineAt: Date.now() + 1_800_000 },
      description: "等 PR #701 的 CI",
      registeredAt: Date.now(),
    });
    trackShellActivity(t.id, 0, T0);
    beginMainLoopTurn();
    endMainLoopTurn(T0 + 1_000);

    expect(takeQuiescentWake(t.id, T0 + SHELL_QUIESCENT_MS + 5_000)).toBe(false);
  });

  test("wait_until 在收尾之后才登记：唤醒器仍拦得住（顺序变化不许静默失效）", () => {
    const t = registerRunning({
      ...shellTask("n4-late"),
      command: "until gh pr checks 1; do sleep 30; done",
    });
    trackShellActivity(t.id, 0, T0);
    beginMainLoopTurn();
    // 收尾那一刻还没有 deadline 登记 → 会进 pendingWakeIds，只能靠唤醒器这一道拦
    endMainLoopTurn(T0 + 1_000);

    registerWait({
      id: t.id,
      kind: "shell",
      promise: { kind: "deadline", deadlineAt: Date.now() + 1_800_000 },
      description: "等 PR #701 的 CI",
      registeredAt: Date.now(),
    });

    expect(takeQuiescentWake(t.id, T0 + SHELL_QUIESCENT_MS + 5_000)).toBe(false);
  });

  test("反例：常驻服务（无期限、无憋输出）静默后仍要放静默唤醒", () => {
    const t = registerRunning(shellTask("n4-srv"));
    trackShellActivity(t.id, 0, T0);
    beginMainLoopTurn();
    endMainLoopTurn(T0 + 1_000);

    expect(takeQuiescentWake(t.id, T0 + SHELL_QUIESCENT_MS + 5_000)).toBe(true);
  });
});

/**
 * 真实入口（记忆 `tests-green-but-bypassing-real-entrypoint`）：上面几条用假时间喂纯状态机，
 * 这条走真实 `spawnShellTask` + 真实看门狗 tick + 真实消息队列，断链发生在子系统之间时只靠
 * 纯函数是测不出来的。
 *
 * 60s 真实时钟路径由 G2 用例（`tests/smoke/cases/N4-quiescent-declared-wait`）守：那里是
 * 真实二进制、真实时间。这里把「最后一次有输出」拨回阈值之前来加速，其余全是真的。
 */
describe("N4 真实入口：声明的等待跨过静默阈值后没有静默通知", () => {
  let spawned: string[] = [];
  afterEach(() => {
    for (const id of spawned) killShellTask(id);
    spawned = [];
    __resetForTest();
  });

  test("`sleep 70 | tail -1` 静默 60s 不投「不会再自动回报」", async () => {
    const task = spawnShellTask({ command: "sleep 70 | tail -1", cwd: process.cwd() });
    spawned.push(task.id);

    beginMainLoopTurn();
    endMainLoopTurn();
    // 看门狗只在字节数增长时刷新锚点；命令憋输出，所以这次拨回不会被下一次 tick 顶回来
    trackShellActivity(task.id, 0, Date.now() - SHELL_QUIESCENT_MS - 1_000);

    await new Promise((r) => setTimeout(r, 7_000)); // 一个 5s tick + 余量

    const quiescent = drainByKind("task-notification").filter((n) =>
      String((n.payload as { content?: string }).content ?? "").includes("不会再自动回报"),
    );
    expect(quiescent).toHaveLength(0);
    // 对照：任务确实还在跑，不是因为提前退出才没有通知
    expect(getTask(task.id)?.status).toBe("running");
  }, 20_000);
});
