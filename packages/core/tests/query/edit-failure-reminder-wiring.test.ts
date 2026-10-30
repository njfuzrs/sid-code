/**
 * T4 补分诊：`EditFailureReminder` 事件的接线回归。
 *
 * 纯函数测试（`tests/edit-failure-tracker.test.ts`）全绿不代表接上了（「白名单绿测零调用」）。
 * 这里走真实的 `executeTools` → `executeSingleTool` → `recordEditOutcome`，用一个恒失败的
 * 假 edit 工具连败 3 次，核对：第 3 次的 tool_result 尾部带提醒，且 sink 恰好收到一条事件。
 * 再用源码字面量断言锁住 App 侧把 sink 接到 collector（不接则生产上触发率恒 0，
 * 这正是此前「4 条真实提醒、0 条事件」的形态）。
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolUseBlock } from "@sid-code/core/llm/types.ts";
import { executeTools, type ToolExecutorDeps } from "@sid-code/core/query/tool-executor.ts";
import {
  setEditFailureReminderSink,
  EDIT_FAILURE_REMINDER_EVENT_NAME,
} from "@sid-code/core/query/edit-failure-tracker.ts";

let events: Array<Record<string, unknown>> = [];

function makeDeps(): ToolExecutorDeps {
  const edit = {
    name: () => "edit",
    description: () => "mock edit",
    inputSchema: () => ({ type: "object", properties: {} }),
    readOnly: () => false,
    isConcurrencySafe: () => false,
    async execute() {
      return {
        output: "错误: 未找到要替换的字符串（精确/灵活/正则/模糊匹配均未命中）。",
        isError: true,
      };
    },
  };
  const data = new Map<string, unknown>();
  return {
    config: { checkpoint: { enabled: false } } as any,
    toolRegistry: {
      get: (name: string) => (name === "edit" ? edit : null),
      isDeferred: () => false,
      isActivated: () => true,
      isToolSearchEnabled: () => false,
    } as any,
    sessionState: {
      sessionId: "test-session",
      addToolDuration: () => {},
      recordToolResult: () => {},
      get: (k: string) => data.get(k),
      set: (k: string, v: unknown) => data.set(k, v),
    } as any,
    hookSystem: {
      firePreToolUseEvent: async () => ({ finalOutput: undefined }),
      firePostToolUseEvent: async () => ({ finalOutput: undefined }),
      firePostToolUseFailureEvent: async () => ({ finalOutput: undefined }),
      firePermissionDeniedEvent: async () => ({ finalOutput: undefined }),
    } as any,
    permissionChecker: null,
    preToolUseCache: new Map(),
    getAbortSignal: () => undefined,
    requestUserConfirmation: async () => true,
  } as ToolExecutorDeps;
}

// 文件路径刻意不存在：liveSnippet 读不到就不附片段，测试不碰真实磁盘
const use = (id: string): ToolUseBlock => ({
  type: "tool_use",
  id,
  name: "edit",
  input: { file_path: "/nonexistent-sid-test/a.ts", old_string: "x", new_string: "y" },
});

beforeEach(() => {
  events = [];
  setEditFailureReminderSink((d) => events.push(d));
});
afterEach(() => {
  setEditFailureReminderSink(null);
});

describe("executeTools → EditFailureReminder 接线", () => {
  test("同一文件连败 3 次：第 3 次 tool_result 带提醒，sink 恰好收到 1 条", async () => {
    const deps = makeDeps();
    const outputs: string[] = [];
    for (const id of ["u1", "u2", "u3"]) {
      const { results } = await executeTools([use(id)], deps);
      const b = results.find((r) => r.type === "tool_result") as any;
      outputs.push(String(b?.content ?? ""));
    }
    expect(outputs[0]).not.toContain("连续");
    expect(outputs[2]).toContain("连续 3 次编辑失败");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      tool_name: "edit",
      file: "a.ts",
      kind: "not_found",
      count: 3,
    });
  });

  test("App 在 collector 就绪后把 sink 接到 recordCustomEvent(EDIT_FAILURE_REMINDER_EVENT_NAME)", () => {
    const app = readFileSync(join(import.meta.dir, "../../../cli/src/app.ts"), "utf8");
    expect(app).toMatch(
      /setEditFailureReminderSink\(\s*traceCollectorInstance\s*\?\s*\(data\)\s*=>\s*traceCollectorInstance\.recordCustomEvent\(EDIT_FAILURE_REMINDER_EVENT_NAME,\s*data\)/,
    );
    expect(EDIT_FAILURE_REMINDER_EVENT_NAME).toBe("EditFailureReminder");
  });
});
