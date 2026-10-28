/**
 * Q1：主循环接线——命中后台任务轮询时 `tool.execute` 一次都不调。
 *
 * 纯函数矩阵（tests/task/background-poll-guard.test.ts）全绿不代表接上了（「白名单绿测零调用」）。
 * 这里走真实的 `executeTools` → `executeSingleTool`，用假工具数 execute 次数，并核对：
 * tool_result 为拦截文案且非错误、发出一条 BackgroundPollIntercepted、Pre/Post 仍配对。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import type { ToolUseBlock } from "@sid-code/core/llm/types.ts";
import { executeTools, type ToolExecutorDeps } from "@sid-code/core/query/tool-executor.ts";
import { registerTask, clearAllTasks } from "@sid-code/core/task/index.ts";
import { setBackgroundPollSink } from "@sid-code/core/task/background-poll-guard.ts";
import { sidPaths } from "@sid-code/core/config/paths.ts";
import type { LocalAgentTaskState } from "@sid-code/core/task/types.ts";

let calls: string[] = [];
let events: Array<Record<string, unknown>> = [];
let pre: string[] = [];
let post: string[] = [];

function makeTool(name: string) {
  return {
    name: () => name,
    description: () => `mock ${name}`,
    inputSchema: () => ({ type: "object", properties: {} }),
    readOnly: () => true,
    isConcurrencySafe: () => true,
    async execute() {
      calls.push(name);
      return { output: `${name} 真的执行了` };
    },
  };
}

function makeDeps(): ToolExecutorDeps {
  const byName = new Map(["read", "bash", "task_output"].map((n) => [n, makeTool(n)]));
  return {
    config: { checkpoint: { enabled: false } } as any,
    toolRegistry: {
      get: (name: string) => byName.get(name) ?? null,
      isDeferred: () => false,
      isActivated: () => true,
      isToolSearchEnabled: () => false,
    } as any,
    sessionState: {
      sessionId: "test-session",
      addToolDuration: () => {},
      recordToolResult: () => {},
    } as any,
    hookSystem: {
      firePreToolUseEvent: async (_n: string, _i: unknown, id?: string) => {
        pre.push(id!);
        return { finalOutput: undefined };
      },
      firePostToolUseEvent: async (
        _n: string,
        _i: unknown,
        _r: unknown,
        _e?: boolean,
        id?: string,
      ) => {
        post.push(id!);
        return { finalOutput: undefined };
      },
      firePostToolUseFailureEvent: async (_n: string, _i: unknown, _e: string, id?: string) => {
        post.push(id!);
        return { finalOutput: undefined };
      },
      firePermissionDeniedEvent: async () => ({ finalOutput: undefined }),
    } as any,
    permissionChecker: null,
    preToolUseCache: new Map(),
    getAbortSignal: () => undefined,
    requestUserConfirmation: async () => false,
  } as ToolExecutorDeps;
}

function agentTask(id: string, status: "running" | "completed"): LocalAgentTaskState {
  return {
    id,
    type: "local_agent",
    status,
    description: id,
    startTime: Date.now(),
    outputFile: join(sidPaths.tasks(), `${id}.output`),
    outputOffset: 0,
    notified: false,
    isBackgrounded: true,
  } as unknown as LocalAgentTaskState;
}

const use = (id: string, name: string, input: Record<string, unknown>): ToolUseBlock => ({
  type: "tool_use",
  id,
  name,
  input,
});

beforeEach(() => {
  clearAllTasks();
  calls = [];
  events = [];
  pre = [];
  post = [];
  setBackgroundPollSink((d) => events.push(d));
});

afterEach(() => {
  setBackgroundPollSink(null);
  clearAllTasks();
});

describe("executeSingleTool 接线", () => {
  test("运行中任务：read .output / ls tasks / 阻塞 task_output 三种都不执行", async () => {
    registerTask(agentTask("bgA", "running"));
    const { results } = await executeTools(
      [
        use("u1", "read", { file_path: join(sidPaths.tasks(), "bgA.output") }),
        use("u2", "bash", { command: `ls -la ${sidPaths.tasks()}/` }),
        use("u3", "task_output", { task_id: "bgA" }),
      ],
      makeDeps(),
    );
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));

    expect(calls, "命中拦截时 execute 不应被调用").toEqual([]);
    const blocks = results.filter((b) => b.type === "tool_result") as any[];
    expect(blocks).toHaveLength(3);
    for (const b of blocks) {
      expect(b.is_error).toBe(false);
      expect(String(b.content)).toContain("仍在运行");
    }
    expect(events.map((e) => e.tool_use_id)).toEqual(["u1", "u2", "u3"]);
    expect(events.map((e) => e.kind)).toEqual(["read_output", "bash_tasks_dir", "blocking_wait"]);
    // Pre/Post 配对不变量
    expect(post.sort()).toEqual(pre.sort());
  });

  test("不命中（终态任务 / 快照 / 无关命令）照常执行，不发事件", async () => {
    registerTask(agentTask("bgA", "running"));
    registerTask(agentTask("doneB", "completed"));
    await executeTools(
      [
        use("v1", "read", { file_path: join(sidPaths.tasks(), "doneB.output") }),
        use("v2", "task_output", { task_id: "bgA", block: false }),
        use("v3", "bash", { command: "git status" }),
      ],
      makeDeps(),
    );
    expect(calls.sort()).toEqual(["bash", "read", "task_output"]);
    expect(events).toEqual([]);
  });
});
