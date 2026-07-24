/**
 * G6：agent hook 使用注入的真子代理执行器
 *
 * 验证 runner 优先走 setAgentHookExecutor 注入的执行器（可多轮/带工具），
 * 而非回退单轮 LLM 调用；ok:false → block，ok:true → allow。
 */

import { describe, test, expect } from "bun:test";
import { HookRunner } from "../../src/hook/runner.ts";
import { HookEventName, type AgentHookConfig, type HookInput } from "../../src/hook/types.ts";

function baseInput(): HookInput {
  return {
    session_id: "t",
    cwd: process.cwd(),
    hook_event_name: HookEventName.PostToolUse,
    timestamp: new Date().toISOString(),
    permission_mode: "",
  };
}

describe("G6 agent hook 真子代理执行器", () => {
  test("注入的执行器被调用，ok:false → block", async () => {
    const runner = new HookRunner();
    let calledWith: any = null;
    runner.setAgentHookExecutor(async (params) => {
      calledWith = params;
      return { ok: false, reason: "改动引入了回归", transcript: "子代理调查记录" };
    });

    const config: AgentHookConfig = { type: "agent", prompt: "验证 $ARGUMENTS", tools: ["read", "grep"] };
    const result = await runner.executeHook(config, HookEventName.PostToolUse, baseInput());

    expect(calledWith).not.toBeNull();
    expect(calledWith.tools).toEqual(["read", "grep"]);
    expect(calledWith.prompt).toContain("验证"); // $ARGUMENTS 已展开
    expect(result.output?.decision).toBe("block");
    expect(result.output?.reason).toContain("回归");
    expect(result.output?.hookSpecificOutput?.additionalContext).toBe("子代理调查记录");
  });

  test("注入的执行器 ok:true → allow", async () => {
    const runner = new HookRunner();
    runner.setAgentHookExecutor(async () => ({ ok: true }));
    const config: AgentHookConfig = { type: "agent", prompt: "验证" };
    const result = await runner.executeHook(config, HookEventName.PostToolUse, baseInput());
    expect(result.output?.decision).toBe("allow");
  });

  test("执行器抛错不阻断（放行）", async () => {
    const runner = new HookRunner();
    runner.setAgentHookExecutor(async () => { throw new Error("子代理崩溃"); });
    const config: AgentHookConfig = { type: "agent", prompt: "验证" };
    const result = await runner.executeHook(config, HookEventName.PostToolUse, baseInput());
    expect(result.success).toBe(true);
    expect(result.output?.decision).toBe("allow");
  });

  test("$ARGUMENTS 展开为完整 JSON 输入", async () => {
    const runner = new HookRunner();
    let seenPrompt = "";
    runner.setAgentHookExecutor(async (p) => { seenPrompt = p.prompt; return { ok: true }; });
    const config: AgentHookConfig = { type: "agent", prompt: "输入是：$ARGUMENTS" };
    await runner.executeHook(config, HookEventName.PostToolUse, baseInput());
    expect(seenPrompt).toContain("session_id");
    expect(seenPrompt).toContain("PostToolUse");
  });
});
