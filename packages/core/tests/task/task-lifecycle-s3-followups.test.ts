/**
 * S3 复审遗留（修-2）：B2 + M5 + L1–L4 + T1。
 *
 * 来源：docs-research `20261018-任务静默停住修复落地复审-遗留问题清单.md` §1 B2、§2 M5、§4 T1、§5 L1–L4。
 *
 * - B2：停滞通知（status=running）送达不得给运行中任务记送达回合；
 * - M5：回合纪元只在「模型真的返回过响应」之后推进，PTL 压缩重试 / 调用抛错不算；
 * - T1：走真实 queryLoop 锁住「先推进、再注入」的接线顺序（此前用例都手调 markMainTurnCompleted）；
 * - L1：墓碑路径判定经 realpath（macOS /tmp → /private/tmp）；
 * - L2：/clear 驱逐也留墓碑；
 * - L4：前台子代理送达回合记 N+1。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  registerTask,
  updateTask,
  getTask,
  clearAllTasks,
  clearInactiveTasks,
  evictTerminalTasks,
  initTaskOutput,
  markMainTurnCompleted,
  getCompletedMainTurns,
  hasPendingEviction,
  getTaskOutputTombstone,
  clearTaskOutputTombstones,
  taskIdFromOutputPath,
  formatTaskOutputTombstone,
  enqueueTaskNotification,
  createAgentTask,
  completeAgentTask,
  EVICT_GRACE_MS,
} from "@sid-code/core/task/index.ts";
import { injectPendingNotifications, queryLoop } from "@sid-code/core/query/loop.ts";
import type { QueryLoopConfig } from "@sid-code/core/query/loop.ts";
import type { QueryDeps } from "@sid-code/core/query/types.ts";
import { Manager as ContextManager } from "@sid-code/core/context/manager.ts";
import { Registry as ToolRegistry } from "@sid-code/core/tool/registry.ts";
import { ModelFallback } from "@sid-code/core/llm/fallback.ts";
import { SessionState } from "@sid-code/core/session/state.ts";
import { __resetForTest } from "@sid-code/core/query/message-queue-manager.ts";
import { sidPaths } from "@sid-code/core/config/paths.ts";
import type { Config } from "@sid-code/core/config/config.ts";
import type { AccumulatedResponse, ContentBlock, Message } from "@sid-code/core/llm/types.ts";
import type { LocalShellTaskState } from "@sid-code/core/task/types.ts";

function makeShellTask(id: string, outputFile: string): LocalShellTaskState {
  return {
    id,
    type: "local_shell",
    status: "running",
    description: `task ${id}`,
    startTime: Date.now(),
    outputFile,
    outputOffset: 0,
    notified: false,
    command: `sleep ${id}`,
    interrupted: false,
    isBackgrounded: true,
  };
}

/** 注册一个真有 `.output` 的运行中任务 */
function runningWithOutput(id: string): string {
  const out = initTaskOutput(id);
  writeFileSync(out.filePath, `OUTPUT-OF-${id}`);
  registerTask(makeShellTask(id, out.filePath));
  return out.filePath;
}

/** 把任务推到终态（面板驻留期已过，只剩回合门）并入队完成通知 */
function completeAndEnqueue(id: string, file: string): void {
  updateTask<LocalShellTaskState>(id, (t) => ({
    ...t,
    status: "completed",
    exitCode: 0,
    endTime: Date.now() - EVICT_GRACE_MS - 1,
    notified: true,
  }));
  enqueueTaskNotification({
    taskId: id,
    outputFile: file,
    status: "completed",
    summary: `命令 ${id} 执行成功`,
  });
}

beforeEach(() => {
  clearAllTasks();
  clearTaskOutputTombstones();
  __resetForTest();
});

afterEach(() => {
  clearAllTasks();
  clearTaskOutputTombstones();
  __resetForTest();
});

describe("B2：停滞通知不给运行中任务记送达", () => {
  test("停滞通知送达 → 任务完成 → 推进回合：完成通知注入前文件仍在", () => {
    const file = runningWithOutput("stall");
    // shell-task 停滞检测的同款通知：status=running、带 taskId
    enqueueTaskNotification(
      { taskId: "stall", outputFile: file, status: "running", summary: "命令似乎在等待用户输入" },
      "next",
    );
    const ctx = new ContextManager({ maxTokens: 200000 });
    expect(injectPendingNotifications(ctx)).toBe(1);
    expect(getTask("stall")?.notificationDeliveredTurn).toBeUndefined();

    markMainTurnCompleted();
    markMainTurnCompleted();
    completeAndEnqueue("stall", file);
    markMainTurnCompleted();
    markMainTurnCompleted();
    evictTerminalTasks();
    // 完成通知还在队列里没注入：文件与条目都必须在
    expect(getTask("stall")).toBeDefined();
    expect(existsSync(file)).toBe(true);
    expect(hasPendingEviction()).toBe(false);

    // 完成通知送达后，才从那一回合起算
    injectPendingNotifications(ctx);
    expect(getTask("stall")?.notificationDeliveredTurn).toBe(getCompletedMainTurns());
  });
});

// ─────────────────────────── queryLoop 接线（T1 / M5）───────────────────────────

function makeConfig(): Config {
  return { model: "test-model", provider: "anthropic", maxTurns: 6 } as unknown as Config;
}

function toolUseResp(id: string): AccumulatedResponse {
  return {
    role: "assistant",
    content: [{ type: "tool_use", id, name: "read", input: { path: "a.ts" } }],
    stopReason: "tool_use",
    usage: { inputTokens: 5, outputTokens: 2 },
  } as AccumulatedResponse;
}

function endTurnResp(): AccumulatedResponse {
  return {
    role: "assistant",
    content: [{ type: "text", text: "好的" }],
    stopReason: "end_turn",
    usage: { inputTokens: 5, outputTokens: 2 },
  } as AccumulatedResponse;
}

/** 足够长的历史，让 reactiveCompact 的 snip 真能压动 */
function buildHistory(rounds: number, pad = 4000): Message[] {
  const msgs: Message[] = [{ role: "user", content: [{ type: "text", text: "请帮我重构模块" }] }];
  for (let i = 0; i < rounds; i++) {
    msgs.push({
      role: "assistant",
      content: [{ type: "tool_use", id: `h${i}`, name: "read", input: { path: `f${i}.ts` } }],
    });
    msgs.push({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: `h${i}`, content: "x".repeat(pad) }],
    });
  }
  return msgs;
}

/**
 * 场景：第 1 轮模型调工具，工具执行期间后台任务完成并入队通知；第 2 轮开头通知被注入。
 * `beforeSend(n)` 可让第 n 次发送抛错（模拟 PTL）。每次 processStream 时模拟一次 TUI 1s tick
 * （`evictTerminalTasks()`），并记录此刻任务是否还在——这就是「模型在跑这次调用时文件还在不在」。
 */
function makeHarness(opts: { throwOnSend?: number; preload?: Message[] }): {
  loopConfig: QueryLoopConfig;
  aliveDuringCalls: boolean[];
  file: string;
} {
  const file = runningWithOutput("bg");
  const ctxMgr = new ContextManager({ maxTokens: 1_000_000 });
  ctxMgr.setSystemPrompt("test");
  ctxMgr.setMessages(
    opts.preload ?? [{ role: "user", content: [{ type: "text", text: "跑一下" }] }],
  );

  const aliveDuringCalls: boolean[] = [];
  let sends = 0;
  let calls = 0;
  const deps = {
    sendWithRetry: () => {
      sends++;
      if (sends === opts.throwOnSend) {
        throw new Error("prompt is too long: 1200000 tokens > 1000000 maximum");
      }
      return (async function* () {})();
    },
    processStream: async () => {
      calls++;
      evictTerminalTasks(); // TUI 1s tick
      aliveDuringCalls.push(getTask("bg") !== undefined);
      return calls === 1 ? toolUseResp("t1") : endTurnResp();
    },
    executeTools: async (content: ContentBlock[]) => {
      completeAndEnqueue("bg", file);
      return {
        results: content
          .filter((b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use")
          .map((b) => ({ type: "tool_result" as const, tool_use_id: b.id, content: "ok" })),
      };
    },
    autoCompact: async () => {},
    getAbortSignal: () => undefined,
    abortCurrentRequest: () => {},
    uuid: () => "u",
    traceAppendEvent: () => {},
  } as unknown as QueryDeps;

  return {
    loopConfig: {
      config: makeConfig(),
      ctxMgr,
      toolRegistry: new ToolRegistry(),
      sessionState: new SessionState("s"),
      fallback: new ModelFallback(),
      deps,
    },
    aliveDuringCalls,
    file,
  };
}

async function drain(cfg: QueryLoopConfig): Promise<void> {
  for await (const _ev of queryLoop(cfg)) {
    /* drain */
  }
}

describe("T1：queryLoop 接线顺序（先推进、再注入）", () => {
  test("通知在第 2 轮开头注入：第 2 轮模型调用期间文件仍在，queryLoop 结束后才可驱逐", async () => {
    const { loopConfig, aliveDuringCalls, file } = makeHarness({});
    await drain(loopConfig);
    await new Promise((r) => setTimeout(r, 20)); // evictTaskOutput 的 unlink 是异步的

    // 第 1 次调用：任务还在跑；第 2 次调用：通知刚送达，模型正在读——必须还在
    expect(aliveDuringCalls).toEqual([true, true]);
    // 送达回合已被 finally 推进越过：驻留期已过，收尾驱逐把它删了
    expect(getTask("bg")).toBeUndefined();
    expect(existsSync(file)).toBe(false);
    expect(getTaskOutputTombstone("bg")?.reason).toBe("delivered_turn_passed");
  });
});

describe("M5：回合只在模型真的返回响应后推进", () => {
  test("注入后首次调用 prompt-too-long → 压缩重试：重试调用期间文件仍在", async () => {
    // 第 2 次发送（通知刚注入后的那次）抛 PTL；重试的那次调用才是模型第一次看到通知
    const { loopConfig, aliveDuringCalls } = makeHarness({
      throwOnSend: 2,
      preload: buildHistory(12),
    });
    await drain(loopConfig);

    // processStream 只在成功发送后被调：第 1 次 tool_use、第 2 次是 PTL 之后的重试
    expect(aliveDuringCalls).toEqual([true, true]);
  }, 15_000);

  test("调用直接抛错退出：finally 不推进回合纪元", async () => {
    const before = getCompletedMainTurns();
    const ctxMgr = new ContextManager({ maxTokens: 200000 });
    ctxMgr.setSystemPrompt("test");
    ctxMgr.addMessage({ role: "user", content: [{ type: "text", text: "hi" }] });
    const deps = {
      sendWithRetry: () => {
        throw new Error("boom: 非可重试错误");
      },
      processStream: async () => endTurnResp(),
      executeTools: async () => ({ results: [] }),
      autoCompact: async () => {},
      getAbortSignal: () => undefined,
      abortCurrentRequest: () => {},
      uuid: () => "u",
      traceAppendEvent: () => {},
    } as unknown as QueryDeps;
    // 错误是冒泡还是被转成 done 事件不是本用例关心的；只锁「纪元没推进」
    await drain({
      config: makeConfig(),
      ctxMgr,
      toolRegistry: new ToolRegistry(),
      sessionState: new SessionState("s"),
      fallback: new ModelFallback(),
      deps,
    }).catch(() => {});
    expect(getCompletedMainTurns()).toBe(before);
  });
});

describe("L1：墓碑路径经 realpath 判定", () => {
  test("经符号链接目录传入的 .output 路径仍识别为任务输出", () => {
    mkdirSync(sidPaths.tasks(), { recursive: true });
    const linkRoot = mkdtempSync(join(tmpdir(), "sid-tasks-link-"));
    const link = join(linkRoot, "tasks-alias");
    try {
      symlinkSync(sidPaths.tasks(), link);
      expect(taskIdFromOutputPath(join(link, "abc.output"))).toBe("abc");
      // 非任务目录仍然不认
      expect(taskIdFromOutputPath(join(linkRoot, "abc.output"))).toBeNull();
    } finally {
      rmSync(linkRoot, { recursive: true, force: true });
    }
  });
});

describe("L2：/clear 驱逐也留墓碑", () => {
  test("clearInactiveTasks 删文件前登记 reason=cleared 的墓碑", async () => {
    const file = runningWithOutput("cl");
    completeAndEnqueue("cl", file);
    clearInactiveTasks();
    // evictTaskOutput 的 unlink 是异步的
    await new Promise((r) => setTimeout(r, 20));
    expect(existsSync(file)).toBe(false);
    const tb = getTaskOutputTombstone("cl");
    expect(tb?.reason).toBe("cleared");
    expect(tb?.tail).toContain("OUTPUT-OF-cl");
    expect(formatTaskOutputTombstone("cl", file)).toContain("/clear");
  });

  test("运行中任务不被 /clear 清理，也不留墓碑", () => {
    runningWithOutput("live");
    clearInactiveTasks();
    expect(getTask("live")).toBeDefined();
    expect(getTaskOutputTombstone("live")).toBeUndefined();
  });
});

describe("L4：前台子代理送达回合记下一回合", () => {
  test("notify=false 完成后，要再跑完两个回合才可驱逐", async () => {
    const { taskState } = createAgentTask({
      agentType: "explore",
      prompt: "p",
      description: "fg",
      isBackgrounded: false,
    });
    const id = taskState.id;
    const turn = getCompletedMainTurns();
    await completeAgentTask(
      id,
      {
        output: "done",
        totalToolUseCount: 0,
        totalTokens: 0,
        usage: { inputTokens: 0, outputTokens: 0 },
      } as never,
      false,
    );
    expect(getTask(id)?.notificationDeliveredTurn).toBe(turn + 1);
    // 下一轮开头推进到 N+1：tool_result 这时才进模型，不能已满足驱逐
    markMainTurnCompleted();
    expect(hasPendingEviction()).toBe(false);
    markMainTurnCompleted();
    expect(hasPendingEviction()).toBe(true);
  });
});
