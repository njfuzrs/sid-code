/**
 * 问题四回归测试：后台面板不立即消失（第三次复发）
 *
 * 现象：任务跑完后「后台任务 · N 已完成」还在屏幕上挂着，用户拿它没办法，只能干等。
 *
 * 三层根因（此前只有第 1 层的一半被修过，所以复发三次）：
 *   ① 缓冲期 60s 过长——注释自称"比 CC 的 30s 更保守"，代价却是用户反复报"不消失"。
 *   ② killed 与 completed 共用同一档时长——kill 是用户刚下的指令，他已知结果，
 *      留 30s 纯属占位；cc 为此专设 STOPPED_DISPLAY_MS = 3s。
 *   ③ **完全没有手动出口**——只有"等缓冲期到点"一条路，用户对面板零控制权。
 *      cc 有 context-sensitive x（`stopOrDismissAgent`）：running→abort，终态→dismiss。
 *
 * 修复：
 *   ① EVICT_GRACE_MS 60s → 30s（对齐 CC PANEL_GRACE_MS）。
 *   ② 新增 KILLED_DISPLAY_MS = 3s，终态写入点统一走 graceDeadlineFor(status) 分档。
 *   ③ 新增 dismissTask / dismissTerminalTasks + isPanelVisible 闸门 + Ctrl+X 键位。
 *
 * 关键不变量（这几条是本次修复的边界，测试重点看住它们）：
 *   - dismiss 只对**终态**生效，绝不隐藏 running（否则"条目不见了却还在烧 token"）。
 *   - dismiss 只摘「面板可见性」，任务本体留在 registry —— bg_task_list / task_output 照常查得到。
 *   - dismissed 任务仍须被 evictTerminalTasks 回收（否则 registry 条目 + 磁盘 .output 泄漏）。
 *   - task_output 的访问续期不得清 dismissed（否则划掉的条目会冒回面板）。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  registerTask,
  updateTask,
  getTask,
  getAllTasks,
  getPanelVisibleTasks,
  getRunningTasks,
  evictTerminalTasks,
  dismissTask,
  dismissTerminalTasks,
  hasDismissableTasks,
  hasPendingEviction,
  graceDeadlineFor,
  EVICT_GRACE_MS,
  KILLED_DISPLAY_MS,
  isPanelTask,
  isPanelVisible,
  clearAllTasks,
  onTaskChanged,
  offTaskChanged,
} from "../../src/task/index.ts";
import type { LocalAgentTaskState, LocalShellTaskState, TaskState } from "../../src/task/types.ts";

function makeShellTask(id: string, overrides: Partial<LocalShellTaskState> = {}): LocalShellTaskState {
  return {
    id,
    type: "local_shell",
    status: "running",
    description: `task ${id}`,
    startTime: 0,
    outputFile: `/tmp/${id}.out`,
    outputOffset: 0,
    notified: false,
    command: `echo ${id}`,
    interrupted: false,
    isBackgrounded: true,
    ...overrides,
  };
}

function makeAgentTask(id: string, overrides: Partial<LocalAgentTaskState> = {}): LocalAgentTaskState {
  return {
    id,
    type: "local_agent",
    status: "running",
    description: `agent ${id}`,
    startTime: 0,
    outputFile: `/tmp/${id}.out`,
    outputOffset: 0,
    notified: false,
    agentId: id,
    agentType: "explore",
    prompt: "p",
    isBackgrounded: true,
    ...overrides,
  };
}

/** 已完成、已通知、缓冲期未到（面板上正在"挂着"的那种条目）。 */
function makeCompletedTask(id: string): LocalShellTaskState {
  return makeShellTask(id, {
    status: "completed",
    notified: true,
    endTime: Date.now(),
    evictAfter: Date.now() + EVICT_GRACE_MS,
  });
}

// 注册表是进程级全局单例 → 每例前后清空，避免与其它测试串扰。
beforeEach(() => { clearAllTasks(); });
afterEach(() => { clearAllTasks(); });

// ─── 根因① 缓冲期时长对齐 CC ───

describe("驱逐缓冲期时长（根因①：60s 过长）", () => {
  test("EVICT_GRACE_MS 对齐 CC PANEL_GRACE_MS = 30s", () => {
    // 曾是 60_000，自称"比 CC 更保守"——但保守参数的代价是用户反复报「面板不消失」。
    // 缓冲期本就有 task_output 的访问续期兜底，加倍基础窗口没有额外收益。
    expect(EVICT_GRACE_MS).toBe(30_000);
  });

  test("KILLED_DISPLAY_MS 对齐 CC STOPPED_DISPLAY_MS = 3s", () => {
    expect(KILLED_DISPLAY_MS).toBe(3_000);
  });

  test("killed 档明显短于 completed 档（否则分档没意义）", () => {
    expect(KILLED_DISPLAY_MS).toBeLessThan(EVICT_GRACE_MS);
  });
});

// ─── 根因② 终态分档 ───

describe("graceDeadlineFor（根因②：killed 与 completed 曾共用一档）", () => {
  test("killed → now + 3s", () => {
    const before = Date.now();
    const d = graceDeadlineFor("killed");
    expect(d).toBeGreaterThanOrEqual(before + KILLED_DISPLAY_MS - 50);
    expect(d).toBeLessThanOrEqual(Date.now() + KILLED_DISPLAY_MS + 50);
  });

  test("completed / failed → now + 30s", () => {
    for (const status of ["completed", "failed"] as const) {
      const before = Date.now();
      const d = graceDeadlineFor(status);
      expect(d).toBeGreaterThanOrEqual(before + EVICT_GRACE_MS - 50);
      expect(d).toBeLessThanOrEqual(Date.now() + EVICT_GRACE_MS + 50);
    }
  });

  test("被 kill 的任务比同时完成的任务先到驱逐点（分档的实际效果）", () => {
    const killed = graceDeadlineFor("killed");
    const completed = graceDeadlineFor("completed");
    expect(killed).toBeLessThan(completed);
  });
});

describe("终态写入点统一走 graceDeadlineFor（防漂移）", () => {
  test("killAgentTask 设的是短档（3s），不是 30s", async () => {
    const { createAgentTask, killAgentTask } = await import("../../src/task/index.ts");
    const { taskState } = createAgentTask({ agentType: "explore", prompt: "p", description: "d" });

    const before = Date.now();
    killAgentTask(taskState.id);

    const killed = getTask(taskState.id)!;
    expect(killed.status).toBe("killed");
    // 短档：应落在 now+3s 附近，远早于 now+30s
    expect(killed.evictAfter!).toBeLessThan(before + EVICT_GRACE_MS);
    expect(killed.evictAfter!).toBeGreaterThanOrEqual(before + KILLED_DISPLAY_MS - 50);
  });

  test("completeAgentTask 设的是长档（30s）", async () => {
    const { createAgentTask, completeAgentTask } = await import("../../src/task/index.ts");
    const { taskState } = createAgentTask({ agentType: "explore", prompt: "p", description: "d" });

    const before = Date.now();
    await completeAgentTask(taskState.id, {
      output: "done", totalToolUseCount: 0, totalTokens: 0,
      usage: { inputTokens: 0, outputTokens: 0 },
    });

    const done = getTask(taskState.id)!;
    expect(done.status).toBe("completed");
    expect(done.evictAfter!).toBeGreaterThanOrEqual(before + EVICT_GRACE_MS - 50);
  });
});

// ─── 根因③ 手动出口：isPanelVisible 闸门 ───

describe("isPanelVisible（根因③：面板可见性 = 后台任务 && 未被划掉）", () => {
  test("后台任务未划掉 → 可见", () => {
    expect(isPanelVisible(makeCompletedTask("a"))).toBe(true);
  });

  test("dismissed=true → 不可见（这就是「立即消失」的机制）", () => {
    const t = { ...makeCompletedTask("a"), dismissed: true };
    expect(isPanelVisible(t)).toBe(false);
  });

  test("前台子代理（isBackgrounded=false）→ 不可见（继承 isPanelTask 闸门，问题一不回归）", () => {
    const fg = makeAgentTask("fg", { isBackgrounded: false });
    expect(isPanelVisible(fg)).toBe(false);
  });

  test("与 isPanelTask 分工清晰：dismissed 只影响可见性、不改归属", () => {
    // 这条不变量很关键：bg_task_list / /ps / <task-statuses> 走 isPanelTask，
    // 用户把条目从面板划掉，不代表"这个任务不曾存在"，模型该查得到。
    const t: TaskState = { ...makeCompletedTask("a"), dismissed: true };
    expect(isPanelTask(t)).toBe(true);    // 归属不变：它确实是个后台任务
    expect(isPanelVisible(t)).toBe(false); // 只是此刻面板不显示它
  });
});

describe("dismissTask（单条划掉）", () => {
  test("终态任务 → 划掉成功，面板立即不再显示", () => {
    registerTask(makeCompletedTask("done"));
    expect(getPanelVisibleTasks().map(t => t.id)).toEqual(["done"]);

    expect(dismissTask("done")).toBe(true);
    // 关键：不必等缓冲期（evictAfter 还在 30s 后），面板立刻空
    expect(getPanelVisibleTasks()).toEqual([]);
  });

  test("running 任务 → 拒绝划掉（绝不隐藏还在跑的任务）", () => {
    // 把还在跑的任务从面板划掉 = "条目不见了却还在烧 token"的黑盒，比不消失更糟。
    registerTask(makeShellTask("live", { status: "running" }));
    expect(dismissTask("live")).toBe(false);
    expect(getPanelVisibleTasks().map(t => t.id)).toEqual(["live"]);
    expect(getTask("live")!.dismissed).toBeUndefined();
  });

  test("不存在的任务 → false（不抛异常）", () => {
    expect(dismissTask("nope")).toBe(false);
  });

  test("幂等：已划掉的再划一次返回 false、不重复通知监听器", () => {
    registerTask(makeCompletedTask("done"));
    expect(dismissTask("done")).toBe(true);

    let notifies = 0;
    const cb = () => { notifies++; };
    onTaskChanged(cb);
    try {
      expect(dismissTask("done")).toBe(false);
      expect(notifies).toBe(0);
    } finally {
      offTaskChanged(cb);
    }
  });

  test("划掉通知监听器（面板必须重渲，否则条目还在屏幕上）", () => {
    registerTask(makeCompletedTask("done"));
    let notified = false;
    const cb = () => { notified = true; };
    onTaskChanged(cb);
    try {
      dismissTask("done");
      expect(notified).toBe(true);
    } finally {
      offTaskChanged(cb);
    }
  });

  test("核心不变量：划掉不删任务——registry / 磁盘输出路径 / task_output 都不受影响", () => {
    registerTask(makeCompletedTask("done"));
    dismissTask("done");

    const t = getTask("done");
    expect(t).toBeDefined();                       // 仍在 registry
    expect(t!.status).toBe("completed");           // 状态不变
    expect(t!.outputFile).toBe("/tmp/done.out");   // 输出路径不变
    expect(getAllTasks().map(x => x.id)).toContain("done");
    // 模型侧清单（走 isPanelTask，不走 isPanelVisible）照常报它
    expect(getAllTasks().filter(isPanelTask).map(x => x.id)).toContain("done");
  });
});

describe("dismissTerminalTasks（Ctrl+X 批量划掉）", () => {
  test("只划终态，running 全部保留", () => {
    registerTask(makeShellTask("live1", { status: "running" }));
    registerTask(makeCompletedTask("done1"));
    registerTask(makeCompletedTask("done2"));
    registerTask(makeShellTask("killed1", {
      status: "killed", notified: true, endTime: Date.now(),
      evictAfter: Date.now() + KILLED_DISPLAY_MS,
    }));

    expect(dismissTerminalTasks()).toBe(3);
    expect(getPanelVisibleTasks().map(t => t.id)).toEqual(["live1"]);
  });

  test("不碰前台子代理（它本就不在面板上，不该算进「划掉了 N 条」）", () => {
    // 否则提示会说"已划掉 2 条"而用户只看见 1 条消失。
    registerTask(makeAgentTask("fg", {
      isBackgrounded: false, status: "completed", notified: true,
    }));
    registerTask(makeCompletedTask("bg"));

    expect(dismissTerminalTasks()).toBe(1);
    expect(getTask("fg")!.dismissed).toBeUndefined();
  });

  test("空面板 / 全 running → 返回 0", () => {
    expect(dismissTerminalTasks()).toBe(0);
    registerTask(makeShellTask("live", { status: "running" }));
    expect(dismissTerminalTasks()).toBe(0);
  });

  test("幂等：连续两次，第二次 0 条", () => {
    registerTask(makeCompletedTask("a"));
    expect(dismissTerminalTasks()).toBe(1);
    expect(dismissTerminalTasks()).toBe(0);
  });
});

describe("hasDismissableTasks（Ctrl+X 是否抢占按键）", () => {
  test("与 dismissTerminalTasks 同口径（防「提示划了 N 条、实际 0 条」）", () => {
    expect(hasDismissableTasks()).toBe(false);

    registerTask(makeShellTask("live", { status: "running" }));
    expect(hasDismissableTasks()).toBe(false); // 只有 running → 不抢占，放行给输入框

    registerTask(makeCompletedTask("done"));
    expect(hasDismissableTasks()).toBe(true);

    dismissTerminalTasks();
    expect(hasDismissableTasks()).toBe(false); // 划完 → 不再抢占
  });

  test("前台子代理不算可划掉（同 dismissTerminalTasks 口径）", () => {
    registerTask(makeAgentTask("fg", {
      isBackgrounded: false, status: "completed", notified: true,
    }));
    expect(hasDismissableTasks()).toBe(false);
  });
});

// ─── 划掉与驱逐的关系：不能泄漏 ───

describe("dismissed 任务仍须被正常驱逐（防 registry / 磁盘泄漏）", () => {
  test("缓冲期到点后，dismissed 任务照样被 evictTerminalTasks 清掉", () => {
    // 划掉只是"面板不显示"，回收仍走原路径。否则划掉的任务会永久占着
    // registry 条目 + 磁盘 .output 文件，直到会话结束。
    registerTask(makeShellTask("done", {
      status: "completed", notified: true, endTime: Date.now(),
      evictAfter: Date.now() - 1, // 缓冲期已过
    }));
    dismissTask("done");
    expect(getTask("done")).toBeDefined(); // 划掉后仍在

    evictTerminalTasks();
    expect(getTask("done")).toBeUndefined(); // 到点被回收
  });

  test("hasPendingEviction 看 registry 而非面板——划光了定时器也不能停", () => {
    // 这是本次修复中一个真实的泄漏点：TUI 的 1s 驱逐 tick 若按"面板上有没有终态条目"
    // 开关，划完最后一条 → 面板空 → 定时器停 → 那些任务再没人回收。
    registerTask(makeCompletedTask("done"));
    expect(hasPendingEviction()).toBe(true);

    dismissTask("done");
    expect(getPanelVisibleTasks()).toEqual([]); // 面板已空
    expect(hasPendingEviction()).toBe(true);    // 但驱逐仍有待办 → 定时器必须继续转

    updateTask("done", (t) => ({ ...t, evictAfter: Date.now() - 1 }));
    evictTerminalTasks();
    expect(hasPendingEviction()).toBe(false);   // 回收完毕 → 定时器可停
  });

  test("running 任务不算待驱逐（无终态任务时不空转定时器）", () => {
    registerTask(makeShellTask("live", { status: "running" }));
    expect(hasPendingEviction()).toBe(false);
  });

  test("未 notified 的终态任务不算待驱逐（与 evictTerminalTasks 的门控一致）", () => {
    registerTask(makeShellTask("unnotified", {
      status: "completed", notified: false, endTime: Date.now(),
    }));
    expect(hasPendingEviction()).toBe(false);
  });
});

describe("task_output 访问续期不得复活已划掉的条目", () => {
  test("读取 dismissed 任务 → 顺延 evictAfter，但 dismissed 保持 true", async () => {
    // 否则模型顺手读一次输出就把用户划掉的条目冒回面板上——那是"划不掉"的另一种形态。
    const { TaskOutputTool } = await import("../../src/tool/task-output.ts");
    registerTask(makeShellTask("done", {
      status: "completed", notified: true, endTime: Date.now(),
      evictAfter: Date.now() + 1_000,
    }));
    dismissTask("done");

    const before = Date.now();
    await new TaskOutputTool().execute({ task_id: "done", block: false });

    const t = getTask("done")!;
    expect(t.dismissed).toBe(true);                          // 仍是划掉状态
    expect(getPanelVisibleTasks()).toEqual([]);              // 面板仍然不显示
    expect(t.evictAfter!).toBeGreaterThanOrEqual(before + EVICT_GRACE_MS - 50); // 但存活窗口顺延了
  });

  test("续期按终态分档：killed 任务续的是 3s 档，不是 30s", async () => {
    const { TaskOutputTool } = await import("../../src/tool/task-output.ts");
    registerTask(makeShellTask("k", {
      status: "killed", notified: true, endTime: Date.now(),
      evictAfter: Date.now() + 500,
    }));

    const before = Date.now();
    await new TaskOutputTool().execute({ task_id: "k", block: false });

    const t = getTask("k")!;
    expect(t.evictAfter!).toBeLessThan(before + EVICT_GRACE_MS);
    expect(t.evictAfter!).toBeGreaterThanOrEqual(before + KILLED_DISPLAY_MS - 50);
  });
});

// ─── 面板消费端接线 ───

describe("state-bridge 走 isPanelVisible（面板唯一入口）", () => {
  test("划掉的条目不进 TUI 快照 tasks[]", async () => {
    const { StateBridge } = await import("../../src/ui/state-bridge.ts");
    registerTask(makeCompletedTask("done"));
    registerTask(makeShellTask("live", { status: "running" }));

    // 构造时会订阅 onTaskChanged；updateTasks 拉的是 getPanelVisibleTasks
    const bridge = new StateBridge({ tasks: [] } as never);
    try {
      bridge.updateTasks();
      expect((bridge.current.tasks ?? []).map(t => t.id).sort()).toEqual(["done", "live"]);

      dismissTask("done");
      bridge.updateTasks();
      expect((bridge.current.tasks ?? []).map(t => t.id)).toEqual(["live"]);
    } finally {
      bridge.detach();
    }
  });
});

describe("getRunningTasks 不受 dismiss 影响（running 压根不能被划掉）", () => {
  test("划掉批量操作后，运行集合不变", () => {
    registerTask(makeShellTask("live", { status: "running" }));
    registerTask(makeCompletedTask("done"));
    dismissTerminalTasks();
    expect(getRunningTasks().map(t => t.id)).toEqual(["live"]);
  });
});
