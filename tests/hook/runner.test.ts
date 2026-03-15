/**
 * Hook 执行器测试
 * 覆盖：command/url 类型、blocking、matcher、返回值解析、超时、错误隔离、旧格式兼容
 */

import { describe, test, expect } from "bun:test";
import { HookRunner } from "../../src/hook/runner.ts";
import type { HooksConfig } from "../../src/config/config.ts";

describe("HookRunner", () => {
  // === 基础功能 ===

  test("空配置不报错", async () => {
    const runner = new HookRunner({});
    const results = await runner.run("pre_tool_use", { toolName: "bash" });
    expect(results).toEqual([]);
  });

  test("未配置的事件返回空数组", async () => {
    const runner = new HookRunner({
      post_tool_use: [{ command: "echo test" }],
    });
    const results = await runner.run("pre_tool_use", { toolName: "bash" });
    expect(results).toEqual([]);
  });

  // === command 类型执行 ===

  test("command 类型执行成功", async () => {
    const runner = new HookRunner({
      pre_tool_use: [{ command: "echo hello" }],
    });
    const results = await runner.run("pre_tool_use", { toolName: "bash" });
    expect(results.length).toBe(1);
    expect(results[0].success).toBe(true);
    expect(results[0].output).toBe("hello");
  });

  test("command 类型设置环境变量", async () => {
    const runner = new HookRunner({
      pre_tool_use: [{ command: 'echo "$SID_CODE_TOOL_NAME"' }],
    });
    const results = await runner.run("pre_tool_use", { toolName: "bash" });
    expect(results[0].output).toBe("bash");
  });

  test("command 类型通过 stdin 传 JSON", async () => {
    const runner = new HookRunner({
      pre_tool_use: [{ command: "cat" }],
    });
    const results = await runner.run("pre_tool_use", {
      toolName: "bash",
      toolInput: { command: "ls" },
    });
    expect(results[0].success).toBe(true);
    const parsed = JSON.parse(results[0].output!);
    expect(parsed.event).toBe("pre_tool_use");
    expect(parsed.toolName).toBe("bash");
    expect(parsed.toolInput).toEqual({ command: "ls" });
  });

  test("command 缺少 command 字段返回失败", async () => {
    const runner = new HookRunner({
      pre_tool_use: [{ type: "command" }],
    });
    const results = await runner.run("pre_tool_use", { toolName: "bash" });
    expect(results[0].success).toBe(false);
  });

  // === 返回值解析 ===

  test("解析 stdout JSON 返回值", async () => {
    const runner = new HookRunner({
      pre_tool_use: [{
        command: `echo '{"success":true,"modifiedInput":"modified"}'`,
      }],
    });
    const results = await runner.run("pre_tool_use", { toolName: "bash" });
    expect(results[0].success).toBe(true);
    expect(results[0].modifiedInput).toBe("modified");
  });

  test("非 JSON stdout 作为纯文本", async () => {
    const runner = new HookRunner({
      pre_tool_use: [{ command: "echo plain text" }],
    });
    const results = await runner.run("pre_tool_use", { toolName: "bash" });
    expect(results[0].success).toBe(true);
    expect(results[0].output).toBe("plain text");
  });

  // === blocking 机制 ===

  test("blocking hook 非零退出码阻止执行", async () => {
    const runner = new HookRunner({
      pre_tool_use: [{
        command: "exit 1",
        blocking: true,
      }],
    });
    const results = await runner.run("pre_tool_use", { toolName: "bash" });
    expect(results[0].blocked).toBe(true);
    expect(results[0].success).toBe(false);
  });

  test("blocking hook 输出 JSON blocked=true 阻止执行", async () => {
    const runner = new HookRunner({
      pre_tool_use: [{
        command: `echo '{"blocked":true,"reason":"安全检查未通过"}'`,
        blocking: true,
      }],
    });
    const results = await runner.run("pre_tool_use", { toolName: "bash" });
    expect(results[0].blocked).toBe(true);
    expect(results[0].reason).toBe("安全检查未通过");
  });

  test("blocking hook 阻止后中断链", async () => {
    const runner = new HookRunner({
      pre_tool_use: [
        { command: "exit 1", blocking: true },
        { command: "echo should_not_run" },
      ],
    });
    const results = await runner.run("pre_tool_use", { toolName: "bash" });
    // 只有第一个 hook 的结果
    expect(results.length).toBe(1);
    expect(results[0].blocked).toBe(true);
  });

  test("非 blocking hook 非零退出码不阻止", async () => {
    const runner = new HookRunner({
      pre_tool_use: [
        { command: "exit 1", blocking: false },
        { command: "echo second" },
      ],
    });
    const results = await runner.run("pre_tool_use", { toolName: "bash" });
    expect(results.length).toBe(2);
    expect(results[1].output).toBe("second");
  });

  // === matcher 匹配 ===

  test("精确匹配工具名", async () => {
    const runner = new HookRunner({
      pre_tool_use: [{ command: "echo matched", matcher: "bash" }],
    });
    const results = await runner.run("pre_tool_use", { toolName: "bash" });
    expect(results.length).toBe(1);
    expect(results[0].output).toBe("matched");
  });

  test("精确匹配不区分大小写", async () => {
    const runner = new HookRunner({
      pre_tool_use: [{ command: "echo matched", matcher: "Bash" }],
    });
    const results = await runner.run("pre_tool_use", { toolName: "bash" });
    expect(results.length).toBe(1);
  });

  test("精确匹配不匹配时跳过", async () => {
    const runner = new HookRunner({
      pre_tool_use: [{ command: "echo matched", matcher: "write" }],
    });
    const results = await runner.run("pre_tool_use", { toolName: "bash" });
    expect(results.length).toBe(0);
  });

  test("正则匹配工具名", async () => {
    const runner = new HookRunner({
      pre_tool_use: [{ command: "echo matched", matcher: "/^(bash|write)$/" }],
    });
    const results = await runner.run("pre_tool_use", { toolName: "bash" });
    expect(results.length).toBe(1);
  });

  test("正则匹配不匹配时跳过", async () => {
    const runner = new HookRunner({
      pre_tool_use: [{ command: "echo matched", matcher: "/^write$/" }],
    });
    const results = await runner.run("pre_tool_use", { toolName: "bash" });
    expect(results.length).toBe(0);
  });

  test("无 matcher 通配所有工具", async () => {
    const runner = new HookRunner({
      pre_tool_use: [{ command: "echo matched" }],
    });
    const results = await runner.run("pre_tool_use", { toolName: "anything" });
    expect(results.length).toBe(1);
  });

  test("无 toolName 时通配", async () => {
    const runner = new HookRunner({
      pre_tool_use: [{ command: "echo matched", matcher: "bash" }],
    });
    const results = await runner.run("pre_tool_use", {});
    expect(results.length).toBe(1);
  });

  // === 超时处理 ===

  test("command 超时", async () => {
    const runner = new HookRunner({
      pre_tool_use: [{
        command: "sleep 10",
        timeout: 1,
      }],
    });
    const results = await runner.run("pre_tool_use", { toolName: "bash" });
    // 超时后进程被 kill，退出码非零
    expect(results.length).toBe(1);
  });

  // === 错误隔离 ===

  test("单个 hook 失败不影响其他", async () => {
    const runner = new HookRunner({
      pre_tool_use: [
        { command: "echo first" },
        { command: "nonexistent_command_xyz_12345" },
        { command: "echo third" },
      ],
    });
    const results = await runner.run("pre_tool_use", { toolName: "bash" });
    // 至少第一个和第三个应该有结果
    expect(results.length).toBe(3);
    expect(results[0].output).toBe("first");
    expect(results[2].output).toBe("third");
  });

  // === 多事件类型 ===

  test("支持所有事件类型", async () => {
    const events = [
      "pre_tool_use", "post_tool_use", "post_tool_use_failure",
      "session_start", "session_end", "pre_compact",
      "user_prompt_submit", "subagent_stop", "notification",
    ] as const;

    for (const event of events) {
      const hooks: HooksConfig = { [event]: [{ command: `echo ${event}` }] };
      const runner = new HookRunner(hooks);
      const results = await runner.run(event, {});
      expect(results.length).toBe(1);
      expect(results[0].output).toBe(event);
    }
  });

  // === user_prompt_submit 特殊功能 ===

  test("user_prompt_submit 支持 modifiedInput", async () => {
    const runner = new HookRunner({
      user_prompt_submit: [{
        command: `echo '{"modifiedInput":"修改后的输入"}'`,
      }],
    });
    const results = await runner.run("user_prompt_submit", { userInput: "原始输入" });
    expect(results[0].modifiedInput).toBe("修改后的输入");
  });

  // === url 类型（mock fetch） ===

  test("url 类型缺少 url 字段返回失败", async () => {
    const runner = new HookRunner({
      post_tool_use: [{ type: "url" }],
    });
    const results = await runner.run("post_tool_use", { toolName: "bash" });
    expect(results[0].success).toBe(false);
  });

  // === 环境变量完整性 ===

  test("所有上下文字段通过环境变量传递", async () => {
    const runner = new HookRunner({
      pre_tool_use: [{
        command: 'echo "$SID_CODE_HOOK_EVENT|$SID_CODE_TOOL_NAME|$SID_CODE_SESSION_ID"',
      }],
    });
    const results = await runner.run("pre_tool_use", {
      toolName: "bash",
      sessionId: "test-session",
    });
    expect(results[0].output).toBe("pre_tool_use|bash|test-session");
  });

  test("error 字段通过环境变量传递", async () => {
    const runner = new HookRunner({
      post_tool_use_failure: [{
        command: 'echo "$SID_CODE_ERROR"',
      }],
    });
    const results = await runner.run("post_tool_use_failure", {
      toolName: "bash",
      error: "something failed",
    });
    expect(results[0].output).toBe("something failed");
  });
});
