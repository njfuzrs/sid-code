/**
 * 面板可见性单一闸门（isPanelTask）回归测试 —— 问题一「三区重复渲染」
 *
 * Bug：前台子代理在屏幕上被渲染两遍——
 *   ① `⏺ sub_agent explore` 工具卡片（runSync 的 tool_result 路径）
 *   ② 后台任务面板 `◓ [AG explore] …` 一行（registry 路径）
 * 用户观察「sub_agent 好像还是和 [AG explore] 完全重合一模一样的东西」是准确的。
 *
 * 根因两层：
 *   A. 源头：createAgentTask 写死 isBackgrounded: true，前台子代理也被标成"后台任务"。
 *   B. 渲染端：消费端只按 status 分组，从不问"这个任务该不该上面板"。
 *
 * 修复（纵深防御双层，对标 cc isPanelAgentTask 的「唯一闸门 + 全体消费端强制走它」）：
 *   A. sub-agent.ts 按调用方声明的 _showInPanel 传 isBackgrounded；
 *      tool.ts runSync（唯一自带工具卡片的调用方）显式传 _showInPanel: false。
 *   B. 新增 isPanelTask() 单一谓词，全部后台任务消费端走它。
 *
 * 关键不变量：摘的只是「上面板」这一个属性——任务仍注册进 registry，
 * taskId / 磁盘输出 / task_output 查询一律不受影响。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  registerTask,
  getAllTasks,
  getRunningTasks,
  getTask,
  clearAllTasks,
  isPanelTask,
  createAgentTask,
  hasRunningTasks,
} from "@sid-code/core/task/index.ts";
import type {
  LocalAgentTaskState,
  LocalShellTaskState,
  TaskState,
} from "@sid-code/core/task/types.ts";

function makeAgentTask(
  id: string,
  overrides: Partial<LocalAgentTaskState> = {},
): LocalAgentTaskState {
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

function makeShellTask(
  id: string,
  overrides: Partial<LocalShellTaskState> = {},
): LocalShellTaskState {
  return {
    id,
    type: "local_shell",
    status: "running",
    description: `shell ${id}`,
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

// 注册表是进程级全局单例 → 每例前后清空，避免与其它测试串扰。
beforeEach(() => {
  clearAllTasks();
});
afterEach(() => {
  clearAllTasks();
});

describe("isPanelTask（面板可见性单一闸门）", () => {
  test("isBackgrounded=true → 上面板", () => {
    expect(isPanelTask(makeAgentTask("bg", { isBackgrounded: true }))).toBe(true);
  });

  test("isBackgrounded=false（前台子代理）→ 不上面板", () => {
    expect(isPanelTask(makeAgentTask("fg", { isBackgrounded: false }))).toBe(false);
  });

  test("后台 shell 任务同样上面板（闸门不区分任务类型，只看是否后台）", () => {
    expect(isPanelTask(makeShellTask("sh"))).toBe(true);
  });

  test("终态不影响判定（面板要显示已完成条目，驻留由 evictAfter 管）", () => {
    expect(isPanelTask(makeAgentTask("done", { status: "completed", notified: true }))).toBe(true);
    expect(
      isPanelTask(
        makeAgentTask("fg-done", { status: "completed", notified: true, isBackgrounded: false }),
      ),
    ).toBe(false);
  });

  test("isBackgrounded 缺失（异常/旧数据）→ 不上面板（fail-closed，宁可少显示也不重复渲染）", () => {
    const partial = { ...makeAgentTask("legacy") } as Partial<LocalAgentTaskState>;
    delete partial.isBackgrounded;
    expect(isPanelTask(partial as TaskState)).toBe(false);
  });
});

describe("createAgentTask 的 isBackgrounded 取值", () => {
  test("默认 true（后台子代理 / swarm 成员 / workflow 子代理保持既有行为）", () => {
    const { taskState } = createAgentTask({ agentType: "explore", prompt: "p", description: "d" });
    expect(taskState.isBackgrounded).toBe(true);
    expect(isPanelTask(getTask(taskState.id)!)).toBe(true);
  });

  test("显式 false（前台子代理）→ 不上面板，但仍注册进 registry", () => {
    const { taskState } = createAgentTask({
      agentType: "explore",
      prompt: "p",
      description: "d",
      isBackgrounded: false,
    });
    expect(taskState.isBackgrounded).toBe(false);
    expect(isPanelTask(taskState)).toBe(false);

    // 核心不变量：仍在 registry 里 —— taskId / task_output 查询依赖它。
    // 只摘「上面板」这一个属性，不是不注册。
    const registered = getTask(taskState.id);
    expect(registered).toBeDefined();
    expect(registered!.id).toBe(taskState.id);
    expect(getAllTasks().map((t) => t.id)).toContain(taskState.id);
    // 磁盘输出路径照常分配（appendAgentOutput / task_output 读它）
    expect(taskState.outputFile).toBeTruthy();
  });
});

describe("消费端口径一致（问题一：前台子代理不得出现在任何后台任务清单里）", () => {
  test("面板过滤：混合场景只留后台任务", () => {
    registerTask(makeAgentTask("fg", { isBackgrounded: false })); // 前台子代理，已有工具卡片
    registerTask(makeAgentTask("bg", { isBackgrounded: true })); // 后台子代理
    registerTask(makeShellTask("sh")); // 后台 shell

    // state-bridge / bg_task_list / /ps / <task-statuses> 全部走这一句
    expect(
      getAllTasks()
        .filter(isPanelTask)
        .map((t) => t.id)
        .sort(),
    ).toEqual(["bg", "sh"]);
  });

  test("getRunningTasks 过 isPanelTask 后不含前台子代理（Ctrl+F 不误杀主循环当前这一轮的子代理）", () => {
    registerTask(makeAgentTask("fg", { isBackgrounded: false }));
    expect(getRunningTasks().map((t) => t.id)).toEqual(["fg"]); // 未过闸门：仍在运行集合里
    expect(getRunningTasks().filter(isPanelTask)).toEqual([]); // 过闸门：不算后台任务
  });

  test("hasRunningTasks 与 killAllRunningTasks 同口径：只有前台子代理时报「无后台任务」", () => {
    // 否则会出现"提示有任务可终止、按下去却杀 0 个"的不一致，
    // 更糟的是 Ctrl+F 顺手杀掉用户正在等的前台子代理。
    registerTask(makeAgentTask("fg", { isBackgrounded: false }));
    expect(hasRunningTasks()).toBe(false);

    registerTask(makeAgentTask("bg", { isBackgrounded: true }));
    expect(hasRunningTasks()).toBe(true);
  });

  test("<task-statuses> 附件不报前台子代理（否则模型误以为另有后台任务、去轮询 task_output）", async () => {
    const { generateTaskStatusAttachment } = await import("@sid-code/core/task/registry.ts");

    registerTask(makeAgentTask("fg", { isBackgrounded: false, description: "前台探索任务" }));
    // 只有前台子代理时，附件应为 null（等同"没有后台任务"）
    expect(await generateTaskStatusAttachment()).toBeNull();

    registerTask(makeAgentTask("bg", { isBackgrounded: true, description: "后台探索任务" }));
    const attachment = await generateTaskStatusAttachment();
    expect(attachment).toContain("后台探索任务");
    expect(attachment).not.toContain("前台探索任务");
  });

  test("接线检查：tool.ts runSync 显式传 _showInPanel: false", async () => {
    // 上面的用例都验证「闸门本身正确」，但闸门只有在**调用方真的传了 false** 时才生效。
    // 上一轮修复的教训正是「修了通知层这条支路、没问同一个错误还有没有别的出口」——
    // 这条静态断言锁住接线本身：若将来有人删掉 tool.ts 里的 _showInPanel: false，
    // 前台子代理会重新出现在面板上（问题一复发），而纯行为测试很难覆盖到（runSync
    // 需要真跑一个 LLM 子代理）。故用源码断言兜住这一格。
    const src = await Bun.file(
      new URL("../../../../packages/core/src/agent/tool.ts", import.meta.url),
    ).text();
    expect(src).toContain("_showInPanel: false");
  });

  test("bg_task_list 工具不报前台子代理", async () => {
    const { TaskListTool } = await import("@sid-code/core/tool/task-list.ts");
    const tool = new TaskListTool();

    registerTask(makeAgentTask("fg", { isBackgrounded: false, description: "前台探索任务" }));
    const onlyForeground = await tool.execute({});
    expect(onlyForeground.output).toBe("当前没有后台任务");

    registerTask(makeAgentTask("bg", { isBackgrounded: true, description: "后台探索任务" }));
    const withBackground = await tool.execute({});
    expect(withBackground.output).toContain("后台探索任务");
    expect(withBackground.output).not.toContain("前台探索任务");
  });
});
