/**
 * Hook 执行器测试
 */

import { describe, test, expect } from "bun:test";
import { HookRunner } from "../../src/hook/runner.ts";

describe("HookRunner", () => {
  test("执行匹配事件的 Hook", async () => {
    const runner = new HookRunner([
      { event: "pre_tool_use", command: "echo hook_executed" },
    ]);

    // 不应抛出异常
    await runner.run("pre_tool_use", {
      toolName: "bash",
      toolInput: { command: "ls" },
    });
  });

  test("不匹配的事件不执行", async () => {
    const runner = new HookRunner([
      { event: "post_tool_use", command: "echo post" },
    ]);

    // pre_tool_use 不应触发 post_tool_use 的 hook
    await runner.run("pre_tool_use", {
      toolName: "bash",
      toolInput: {},
    });
  });

  test("空 Hook 列表不报错", async () => {
    const runner = new HookRunner([]);
    await runner.run("pre_tool_use", {
      toolName: "bash",
      toolInput: {},
    });
  });
});
