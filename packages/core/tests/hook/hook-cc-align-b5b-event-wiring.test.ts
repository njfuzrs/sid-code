/**
 * Hook 对齐 CC · 批 5b：接线原「预留」事件 + 新增事件（HC24 / HC25 / Q6）
 *
 * 断言的是「真实调用点会触发」，不是「fire 方法存在」——后者在接线前就成立（防线全在、调用全 0）。
 * 覆盖：CwdChanged / TaskCreated / TaskCompleted / PostToolBatch（工具执行器）、
 * StopFailure 归类、Elicitation / ElicitationResult 的 matcher（server 名）、
 * ConfigChange / ModelSwitch / UserPromptExpansion / DirectoryAdded 的载荷与 matcher。
 */

import { describe, test, expect } from "bun:test";
import { HookSystem } from "@sid-code/core/hook/system.ts";
import { HookEventName } from "@sid-code/core/hook/types.ts";
import { executeTools, type ToolExecutorDeps } from "@sid-code/core/query/tool-executor.ts";
import { getCwd, setCwd } from "@sid-code/core/bootstrap/state.ts";
import { classifyStopFailure } from "@sid-code/core/query/stop-failure.ts";

function probe(sys: HookSystem, ev: HookEventName, matcher?: string) {
  const seen: any[] = [];
  sys.registerHook(
    {
      type: "runtime",
      name: `probe-${ev}-${matcher ?? "*"}`,
      action: async (i) => void seen.push(i),
    },
    ev,
    { source: "runtime" as any, ...(matcher ? { matcher } : {}) },
  );
  return seen;
}

function makeTool(name: string, run: (input: any) => { output: string; isError?: boolean }) {
  return {
    name: () => name,
    description: () => name,
    inputSchema: () => ({ type: "object", properties: {} }),
    readOnly: () => true,
    isConcurrencySafe: () => true,
    async execute(input: any) {
      return run(input);
    },
  };
}

function deps(sys: HookSystem, tools: ReturnType<typeof makeTool>[]): ToolExecutorDeps {
  const byName = new Map(tools.map((t) => [t.name(), t]));
  return {
    config: { checkpoint: { enabled: false } } as any,
    toolRegistry: {
      get: (n: string) => byName.get(n) ?? null,
      isDeferred: () => false,
      isActivated: () => true,
      isToolSearchEnabled: () => false,
    } as any,
    sessionState: {
      sessionId: "b5b",
      addToolDuration: () => {},
      recordToolResult: () => {},
    } as any,
    hookSystem: sys,
    permissionChecker: null,
    preToolUseCache: new Map(),
    getAbortSignal: () => undefined,
    requestUserConfirmation: async () => false,
  } as ToolExecutorDeps;
}

const use = (id: string, name: string, input: Record<string, unknown> = {}) =>
  ({ type: "tool_use", id, name, input }) as any;
const settle = () => new Promise((r) => setTimeout(r, 50));

describe("工具执行器派生事件", () => {
  test("工具改了 cwd → CwdChanged(old,new)；没改不触发", async () => {
    const sys = new HookSystem();
    const seen = probe(sys, HookEventName.CwdChanged);
    const before = getCwd();
    const target = "/tmp";
    try {
      await executeTools(
        [use("a", "bash"), use("b", "read")],
        deps(sys, [
          makeTool("bash", () => {
            setCwd(target);
            return { output: "" };
          }),
          makeTool("read", () => ({ output: "x" })),
        ]),
      );
      await settle();
      expect(seen.length).toBe(1);
      expect(seen[0].old_cwd ?? seen[0].oldCwd ?? seen[0].from).toBe(before);
    } finally {
      setCwd(before);
    }
  });

  test("task_create 成功 → TaskCreated；task_update→completed → TaskCompleted；失败不触发", async () => {
    const sys = new HookSystem();
    const created = probe(sys, HookEventName.TaskCreated);
    const completed = probe(sys, HookEventName.TaskCompleted);
    const tools = [
      makeTool("task_create", (i) =>
        i.fail
          ? { output: "bad", isError: true }
          : { output: JSON.stringify({ id: "7", subject: "写测试", status: "pending" }) },
      ),
      makeTool("task_update", (i) => ({
        output: JSON.stringify({ id: "7", subject: "写测试", status: i.status }),
      })),
    ];
    await executeTools([use("c1", "task_create", { description: "d" })], deps(sys, tools));
    await executeTools([use("c2", "task_create", { fail: true })], deps(sys, tools));
    await executeTools([use("u1", "task_update", { status: "in_progress" })], deps(sys, tools));
    await executeTools([use("u2", "task_update", { status: "completed" })], deps(sys, tools));
    await settle();
    expect(created.length).toBe(1);
    expect(completed.length).toBe(1);
  });

  test("PostToolBatch：一批只触发一次，带每个调用的 is_error", async () => {
    const sys = new HookSystem();
    const seen = probe(sys, HookEventName.PostToolBatch);
    await executeTools(
      [use("x", "ok"), use("y", "bad")],
      deps(sys, [
        makeTool("ok", () => ({ output: "1" })),
        makeTool("bad", () => ({ output: "2", isError: true })),
      ]),
    );
    await settle();
    expect(seen.length).toBe(1);
    expect(seen[0].tool_calls).toEqual([
      { tool_name: "ok", tool_use_id: "x", is_error: false },
      { tool_name: "bad", tool_use_id: "y", is_error: true },
    ]);
  });
});

describe("StopFailure 归类（状态码优先，不读文案）", () => {
  test.each([
    [{ statusCode: 429 }, "rate_limit"],
    [{ statusCode: 401 }, "authentication_failed"],
    [{ statusCode: 402 }, "billing_error"],
    [{ statusCode: 400 }, "invalid_request"],
    [{ statusCode: 503 }, "server_error"],
    [{ errorType: "overloaded_error" }, "server_error"],
    [new Error("rate limit exceeded"), "unknown"],
  ])("%p → %s", (err, want) => {
    expect(classifyStopFailure(err)).toBe(want as any);
  });

  test("matcher 按 error_type 匹配", async () => {
    const sys = new HookSystem();
    const rl = probe(sys, HookEventName.StopFailure, "rate_limit");
    await sys.fireStopFailureEvent("x", "server_error");
    await sys.fireStopFailureEvent("y", "rate_limit");
    expect(rl.map((i) => i.error)).toEqual(["y"]);
  });
});

describe("matcher 与载荷", () => {
  test("Elicitation / ElicitationResult 按 server 名匹配", async () => {
    const sys = new HookSystem();
    const e = probe(sys, HookEventName.Elicitation, "github");
    const r = probe(sys, HookEventName.ElicitationResult, "github");
    await sys.fireElicitationEvent("m", undefined, "slack");
    await sys.fireElicitationEvent("m", undefined, "github");
    await sys.fireElicitationResultEvent("accept", undefined, "github");
    expect(e.length).toBe(1);
    expect(e[0].mcp_server_name).toBe("github");
    expect(r[0].action).toBe("accept");
  });

  test("ConfigChange 按 CC source 匹配，带 file_path", async () => {
    const sys = new HookSystem();
    const seen = probe(sys, HookEventName.ConfigChange, "project_settings");
    await sys.fireConfigChangeEvent([], "user_settings", "/u");
    await sys.fireConfigChangeEvent([], "project_settings", "/p");
    expect(seen.map((i) => i.file_path)).toEqual(["/p"]);
  });

  test("PostModelSwitch 按 trigger 匹配（fallback 只收降级）", async () => {
    const sys = new HookSystem();
    const fb = probe(sys, HookEventName.PostModelSwitch, "fallback");
    await sys.firePostModelSwitchEvent("a", "b", "manual");
    await sys.firePostModelSwitchEvent("a", "c", "fallback", "a 降级");
    expect(fb.map((i) => [i.from_model, i.to_model, i.reason])).toEqual([["a", "c", "a 降级"]]);
  });

  test("UserPromptExpansion 按命令名匹配；DirectoryAdded 带目录", async () => {
    const sys = new HookSystem();
    const ex = probe(sys, HookEventName.UserPromptExpansion, "commit");
    const dirs = probe(sys, HookEventName.DirectoryAdded);
    await sys.fireUserPromptExpansionEvent("review", "/review", "R");
    await sys.fireUserPromptExpansionEvent("commit", "/commit -m x", "C");
    await sys.fireDirectoryAddedEvent("/tmp/x");
    expect(ex.map((i) => i.expanded_prompt)).toEqual(["C"]);
    expect(dirs[0].directory).toBe("/tmp/x");
  });

  test("Notification 按 notification_type 匹配", async () => {
    const sys = new HookSystem();
    const seen = probe(sys, HookEventName.Notification, "permission_prompt");
    await sys.fireNotificationEvent("idle_prompt", "x");
    await sys.fireNotificationEvent("permission_prompt", "y");
    expect(seen.map((i) => i.message)).toEqual(["y"]);
  });
});
