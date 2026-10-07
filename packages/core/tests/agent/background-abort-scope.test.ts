/**
 * 多代理 F9：用户 ESC（user-cancel）不应杀掉后台子代理；会话级中断仍要转发。
 * 判据落在 runAsync 交给 executeInBackground 的那个 abortController 上——
 * 桩掉 executeInBackground，只看父 signal abort 之后它有没有被连带 abort。
 */
import { describe, expect, test } from "bun:test";
import { SubAgentTool, shouldForwardAbortToBackground } from "@sid-code/core/agent/tool.ts";
import { completeAgentTask } from "@sid-code/core/task/index.ts";

function launch(reason: string): { child: AbortController; parent: AbortController } {
  const tool = new SubAgentTool({} as any);
  let child: AbortController | undefined;
  let release: () => void = () => {};
  (tool as any).executeInBackground = (taskId: string, _p: unknown, ac: AbortController) => {
    child = ac;
    return new Promise<void>((r) => {
      release = () => {
        void completeAgentTask(taskId, { output: "done" } as any, false);
        r();
      };
    });
  };
  const parent = new AbortController();
  (tool as any).runAsync({ type: "explore", prompt: "p", description: "d" }, parent.signal);
  parent.abort(reason);
  const result = { child: child!, parent };
  release();
  return result;
}

describe("后台子代理的中断作用域", () => {
  test("user-cancel 不转发", () => {
    expect(launch("user-cancel").child.signal.aborted).toBe(false);
  });

  test("session-timeout 转发且保留 reason", () => {
    const { child } = launch("session-timeout");
    expect(child.signal.aborted).toBe(true);
    expect(child.signal.reason).toBe("session-timeout");
  });

  test("判据：轮级 reason 不转发，其余（含未知 / 非字符串）一律转发", () => {
    for (const r of ["user-cancel", "midturn-preempt", "sibling_bash_error", "race-settled"]) {
      expect(shouldForwardAbortToBackground(r)).toBe(false);
    }
    for (const r of [
      "session-timeout",
      "team-hard-timeout",
      "whatever",
      undefined,
      new Error("x"),
    ]) {
      expect(shouldForwardAbortToBackground(r)).toBe(true);
    }
  });
});
