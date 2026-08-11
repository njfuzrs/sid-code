/**
 * Hook 系统测试
 * 覆盖：HookSystem 集成、command/url 类型、blocking、matcher、返回值解析、超时、错误隔离、旧格式兼容
 */

import { describe, test, expect } from "bun:test";
import { HookSystem } from "@sid-code/core/hook/system.ts";
import { HookRunner } from "@sid-code/core/hook/runner.ts";
import { HookRegistry } from "@sid-code/core/hook/registry.ts";
import { HookPlanner } from "@sid-code/core/hook/planner.ts";
import { HookAggregator } from "@sid-code/core/hook/aggregator.ts";
import { HookEventName } from "@sid-code/core/hook/types.ts";
import type { HooksConfig } from "@sid-code/core/config/config.ts";

/** 辅助：从旧格式配置创建 HookSystem */
function createSystem(legacyHooks: HooksConfig): HookSystem {
  const sys = new HookSystem();
  sys.initializeFromLegacy(legacyHooks);
  sys.setSessionId("test-session");
  sys.setCwd(process.cwd());
  return sys;
}

describe("HookSystem", () => {
  // === 基础功能 ===

  test("空配置不报错", async () => {
    const sys = createSystem({});
    const result = await sys.firePreToolUseEvent("bash", {});
    expect(result.success).toBe(true);
    expect(result.allOutputs.length).toBe(0);
  });

  test("未配置的事件返回空结果", async () => {
    const sys = createSystem({
      post_tool_use: [{ command: "echo test" }],
    });
    const result = await sys.firePreToolUseEvent("bash", {});
    expect(result.allOutputs.length).toBe(0);
  });

  // === command 类型执行 ===

  test("command 类型执行成功", async () => {
    const sys = createSystem({
      pre_tool_use: [{ command: "echo hello" }],
    });
    const result = await sys.firePreToolUseEvent("bash", {});
    expect(result.success).toBe(true);
    expect(result.allOutputs.length).toBe(1);
  });

  test("command 类型设置环境变量", async () => {
    const sys = createSystem({
      pre_tool_use: [{ command: 'echo "$SID_CODE_TOOL_NAME"' }],
    });
    const result = await sys.firePreToolUseEvent("bash", {});
    expect(result.success).toBe(true);
  });

  test("command 类型通过 stdin 传 JSON", async () => {
    const sys = createSystem({
      pre_tool_use: [{ command: "cat" }],
    });
    const result = await sys.firePreToolUseEvent("bash", { command: "ls" });
    expect(result.success).toBe(true);
  });

  test("command 缺少 command 字段被过滤", async () => {
    const sys = createSystem({
      pre_tool_use: [{ type: "command" } as any],
    });
    // 无效配置在注册时被过滤，不会执行
    const result = await sys.firePreToolUseEvent("bash", {});
    expect(result.allOutputs.length).toBe(0);
  });

  // === 返回值解析 ===

  test("解析 stdout JSON 返回值", async () => {
    const sys = createSystem({
      pre_tool_use: [{
        command: `echo '{"decision":"allow","hookSpecificOutput":{"tool_input":{"modified":true}}}'`,
      }],
    });
    const result = await sys.firePreToolUseEvent("bash", {});
    expect(result.success).toBe(true);
  });

  test("非 JSON stdout 作为纯文本", async () => {
    const sys = createSystem({
      pre_tool_use: [{ command: "echo plain text" }],
    });
    const result = await sys.firePreToolUseEvent("bash", {});
    expect(result.success).toBe(true);
  });

  // === blocking 机制（G4 退出码语义对齐 CC：0=成功, 2=阻塞, 其余非零=非阻塞告警） ===

  test("退出码 2 产生 deny 决策（唯一阻塞码）", async () => {
    const sys = createSystem({
      pre_tool_use: [{ command: "exit 2" }],
    });
    const result = await sys.firePreToolUseEvent("bash", {});
    expect(result.finalOutput?.isBlockingDecision()).toBe(true);
  });

  test("退出码 1 为警告，不阻塞", async () => {
    const sys = createSystem({
      pre_tool_use: [{ command: "exit 1" }],
    });
    const result = await sys.firePreToolUseEvent("bash", {});
    // 退出码 1 = 警告，不是 blocking
    expect(result.finalOutput?.isBlockingDecision()).toBe(false);
  });

  test("G4：退出码 3（非 2 的非零）不阻塞（对齐 CC，仅 2 阻塞）", async () => {
    const sys = createSystem({
      pre_tool_use: [{ command: "exit 3" }],
    });
    const result = await sys.firePreToolUseEvent("bash", {});
    // 旧实现 2+ 全 deny 会误阻塞；CC 语义仅 exit 2 阻塞，3 为非阻塞告警
    expect(result.finalOutput?.isBlockingDecision()).toBe(false);
  });

  test("G4：退出码 2 的 stderr 作为阻塞原因反馈模型", async () => {
    const sys = createSystem({
      pre_tool_use: [{ command: `sh -c 'echo "拒绝原因在stderr" 1>&2; exit 2'` }],
    });
    const result = await sys.firePreToolUseEvent("bash", {});
    expect(result.finalOutput?.isBlockingDecision()).toBe(true);
    expect(result.finalOutput?.getEffectiveReason()).toContain("拒绝原因在stderr");
  });

  test("JSON 输出 decision=deny 阻止执行", async () => {
    const sys = createSystem({
      pre_tool_use: [{
        command: `echo '{"decision":"deny","reason":"安全检查未通过"}'`,
      }],
    });
    const result = await sys.firePreToolUseEvent("bash", {});
    expect(result.finalOutput?.isBlockingDecision()).toBe(true);
    expect(result.finalOutput?.reason).toBe("安全检查未通过");
  });

  // === matcher 匹配 ===

  test("精确匹配工具名", async () => {
    const sys = createSystem({
      pre_tool_use: [{ command: "echo matched", matcher: "bash" }],
    });
    const result = await sys.firePreToolUseEvent("bash", {});
    expect(result.allOutputs.length).toBe(1);
  });

  test("精确匹配不匹配时跳过", async () => {
    const sys = createSystem({
      pre_tool_use: [{ command: "echo matched", matcher: "write" }],
    });
    const result = await sys.firePreToolUseEvent("bash", {});
    expect(result.allOutputs.length).toBe(0);
  });

  test("正则匹配工具名", async () => {
    const sys = createSystem({
      pre_tool_use: [{ command: "echo matched", matcher: "/^(bash|write)$/" }],
    });
    // 注意：新的 planner 使用 RegExp 直接匹配，不需要 /.../ 包裹
    // 但旧格式的 matcher 会被原样传入，planner 会尝试作为正则
    const result = await sys.firePreToolUseEvent("bash", {});
    // /^(bash|write)$/ 作为正则会匹配 bash
    expect(result.allOutputs.length).toBe(1);
  });

  test("正则匹配不匹配时跳过", async () => {
    const sys = createSystem({
      pre_tool_use: [{ command: "echo matched", matcher: "/^write$/" }],
    });
    const result = await sys.firePreToolUseEvent("bash", {});
    expect(result.allOutputs.length).toBe(0);
  });

  test("无 matcher 通配所有工具", async () => {
    const sys = createSystem({
      pre_tool_use: [{ command: "echo matched" }],
    });
    const result = await sys.firePreToolUseEvent("anything", {});
    expect(result.allOutputs.length).toBe(1);
  });

  // === 超时处理 ===

  test("command 超时", async () => {
    const sys = createSystem({
      pre_tool_use: [{
        command: "sleep 10",
        timeout: 1,
      }],
    });
    const result = await sys.firePreToolUseEvent("bash", {});
    // 超时后进程被 kill
    expect(result.allOutputs.length).toBe(0); // 超时产生 error，不产生 output
    expect(result.errors.length).toBeGreaterThan(0);
  });

  // === 错误隔离 ===

  test("单个 hook 失败不影响其他", async () => {
    const sys = createSystem({
      pre_tool_use: [
        { command: "echo first" },
        { command: "nonexistent_command_xyz_12345" },
        { command: "echo third" },
      ],
    });
    const result = await sys.firePreToolUseEvent("bash", {});
    // 三个 hook 都会执行（并行），成功的会有 output
    expect(result.allOutputs.length).toBeGreaterThanOrEqual(2);
  });

  // === 多事件类型 ===

  test("支持所有旧格式事件类型", async () => {
    const events = [
      "pre_tool_use", "post_tool_use", "post_tool_use_failure",
      "session_start", "session_end", "pre_compact",
      "user_prompt_submit", "subagent_stop", "notification",
    ] as const;

    for (const event of events) {
      const hooks: HooksConfig = { [event]: [{ command: `echo ${event}` }] };
      const sys = createSystem(hooks);
      // 使用对应的 fire 方法
      let result;
      switch (event) {
        case "pre_tool_use":
          result = await sys.firePreToolUseEvent("bash", {});
          break;
        case "post_tool_use":
          result = await sys.firePostToolUseEvent("bash", {}, {});
          break;
        case "post_tool_use_failure":
          result = await sys.firePostToolUseFailureEvent("bash", {}, "error");
          break;
        case "session_start":
          result = await sys.fireSessionStartEvent("startup");
          break;
        case "session_end":
          result = await sys.fireSessionEndEvent("exit");
          break;
        case "pre_compact":
          result = await sys.firePreCompactEvent("auto");
          break;
        case "user_prompt_submit":
          result = await sys.fireUserPromptSubmitEvent("test");
          break;
        case "subagent_stop":
          result = await sys.fireSubagentStopEvent({});
          break;
        case "notification":
          result = await sys.fireNotificationEvent("info", "test");
          break;
      }
      expect(result!.success).toBe(true);
    }
  });

  // === user_prompt_submit 特殊功能 ===

  test("user_prompt_submit 支持 additionalContext", async () => {
    const sys = createSystem({
      user_prompt_submit: [{
        command: `echo '{"hookSpecificOutput":{"additionalContext":"额外上下文"}}'`,
      }],
    });
    const result = await sys.fireUserPromptSubmitEvent("原始输入");
    expect(result.finalOutput?.getAdditionalContext()).toBe("额外上下文");
  });

  // === url 类型 ===

  test("url 类型缺少 url 字段被过滤", async () => {
    const sys = createSystem({
      post_tool_use: [{ type: "url" } as any],
    });
    const result = await sys.firePostToolUseEvent("bash", {}, {});
    expect(result.allOutputs.length).toBe(0);
  });

  // === 环境变量传递 ===

  test("所有上下文字段通过环境变量传递", async () => {
    const sys = createSystem({
      pre_tool_use: [{
        command: 'echo "$SID_CODE_HOOK_EVENT|$SID_CODE_TOOL_NAME|$SID_CODE_SESSION_ID"',
      }],
    });
    const result = await sys.firePreToolUseEvent("bash", {});
    expect(result.success).toBe(true);
  });

  test("error 字段通过环境变量传递", async () => {
    const sys = createSystem({
      post_tool_use_failure: [{
        command: 'echo "$SID_CODE_HOOK_EVENT"',
      }],
    });
    const result = await sys.firePostToolUseFailureEvent("bash", {}, "something failed");
    expect(result.success).toBe(true);
  });

  // === G4：逐事件差异——SessionStart/SubagentStart 忽略阻塞 ===

  test("G4：SessionStart exit2 被忽略阻塞（不阻断会话启动）", async () => {
    const sys = createSystem({
      session_start: [{ command: `sh -c 'echo "试图阻塞" 1>&2; exit 2'` }],
    });
    const result = await sys.fireSessionStartEvent("startup");
    // 生命周期事件的 hook 不能阻塞：block 应被降级，isBlockingDecision 为 false
    expect(result.finalOutput?.isBlockingDecision()).toBeFalsy();
  });

  test("G4：SubagentStart exit2 被忽略阻塞", async () => {
    const sys = createSystem({
      subagent_start: [{ command: `sh -c 'echo x 1>&2; exit 2'` }],
    });
    const result = await sys.fireSubagentStartEvent("agent-1", "general", "parent-session");
    expect(result.finalOutput?.isBlockingDecision()).toBeFalsy();
  });
});

// === HookRunner 单元测试 ===

describe("HookRunner（单元）", () => {
  test("executeHook 执行 command 类型", async () => {
    const runner = new HookRunner();
    const result = await runner.executeHook(
      { type: "command", command: "echo hello" },
      HookEventName.PreToolUse,
      { session_id: "test", cwd: process.cwd(), hook_event_name: "PreToolUse", timestamp: new Date().toISOString() },
    );
    expect(result.success).toBe(true);
    expect(result.stdout?.trim()).toBe("hello");
  });

  test("executeHook 退出码 2 产生 deny", async () => {
    const runner = new HookRunner();
    const result = await runner.executeHook(
      { type: "command", command: "exit 2" },
      HookEventName.PreToolUse,
      { session_id: "test", cwd: process.cwd(), hook_event_name: "PreToolUse", timestamp: new Date().toISOString() },
    );
    expect(result.success).toBe(false);
    expect(result.output?.decision).toBe("deny");
  });

  test("executeHook runtime 类型", async () => {
    const runner = new HookRunner();
    const result = await runner.executeHook(
      {
        type: "runtime",
        name: "test-runtime",
        action: async () => ({ decision: "allow" as const, reason: "ok" }),
      },
      HookEventName.PreToolUse,
      { session_id: "test", cwd: process.cwd(), hook_event_name: "PreToolUse", timestamp: new Date().toISOString() },
    );
    expect(result.success).toBe(true);
    expect(result.output?.decision).toBe("allow");
  });

  test("并行执行多个 hook", async () => {
    const runner = new HookRunner();
    const configs = [
      { type: "command" as const, command: "echo a" },
      { type: "command" as const, command: "echo b" },
    ];
    const input = { session_id: "test", cwd: process.cwd(), hook_event_name: "PreToolUse", timestamp: new Date().toISOString() };
    const results = await runner.executeHooksParallel(configs, HookEventName.PreToolUse, input);
    expect(results.length).toBe(2);
    expect(results.every(r => r.success)).toBe(true);
  });
});

// === HookRegistry 单元测试 ===

describe("HookRegistry", () => {
  test("从旧格式加载", () => {
    const registry = new HookRegistry();
    registry.initializeFromLegacy({
      pre_tool_use: [{ command: "echo test" }],
      session_start: [{ command: "echo start" }],
    });
    const hooks = registry.getAllHooks();
    expect(hooks.length).toBe(2);
  });

  test("旧 snake_case 事件名映射到新 PascalCase", () => {
    const registry = new HookRegistry();
    registry.initializeFromLegacy({
      pre_tool_use: [{ command: "echo test" }],
    });
    const hooks = registry.getHooksForEvent(HookEventName.PreToolUse);
    expect(hooks.length).toBe(1);
  });

  test("无效事件名被跳过", () => {
    const registry = new HookRegistry();
    registry.initializeFromLegacy({
      invalid_event: [{ command: "echo test" }],
    } as any);
    expect(registry.getAllHooks().length).toBe(0);
  });

  // === G5：prompt / agent 类型从配置加载 ===

  test("G5：prompt 类型从旧格式配置加载", () => {
    const registry = new HookRegistry();
    registry.initializeFromLegacy({
      pre_tool_use: [{ type: "prompt", prompt: "这个命令安全吗？", model: "gpt-4o-mini" }],
    } as any);
    const hooks = registry.getHooksForEvent(HookEventName.PreToolUse);
    expect(hooks.length).toBe(1);
    expect(hooks[0].config.type).toBe("prompt");
    expect((hooks[0].config as any).prompt).toBe("这个命令安全吗？");
  });

  test("G5：agent 类型从旧格式配置加载（含 tools）", () => {
    const registry = new HookRegistry();
    registry.initializeFromLegacy({
      pre_tool_use: [{ type: "agent", prompt: "审查改动", tools: ["read", "grep"] }],
    } as any);
    const hooks = registry.getHooksForEvent(HookEventName.PreToolUse);
    expect(hooks.length).toBe(1);
    expect(hooks[0].config.type).toBe("agent");
    expect((hooks[0].config as any).tools).toEqual(["read", "grep"]);
  });

  test("G5：prompt 类型缺 prompt 字段被跳过", () => {
    const registry = new HookRegistry();
    registry.initializeFromLegacy({
      pre_tool_use: [{ type: "prompt" }],
    } as any);
    expect(registry.getAllHooks().length).toBe(0);
  });

  test("启用/禁用 hook", () => {
    const registry = new HookRegistry();
    registry.initializeFromLegacy({
      pre_tool_use: [{ command: "echo test" }],
    });
    expect(registry.getHooksForEvent(HookEventName.PreToolUse).length).toBe(1);

    registry.setHookEnabled("echo test", false);
    expect(registry.getHooksForEvent(HookEventName.PreToolUse).length).toBe(0);

    registry.setHookEnabled("echo test", true);
    expect(registry.getHooksForEvent(HookEventName.PreToolUse).length).toBe(1);
  });

  test("编程式注册 runtime hook", () => {
    const registry = new HookRegistry();
    registry.registerHook(
      { type: "runtime", name: "test-hook", action: async () => {} },
      HookEventName.PreToolUse,
    );
    expect(registry.getHooksForEvent(HookEventName.PreToolUse).length).toBe(1);
  });
});

// === HookAggregator 单元测试 ===

describe("HookAggregator", () => {
  test("OR 决策：任一 deny 整体 deny", () => {
    const agg = new HookAggregator();
    const result = agg.aggregateResults([
      { hookConfig: { type: "command", command: "a" }, eventName: HookEventName.PreToolUse, success: true, output: { decision: "allow" }, duration: 10 },
      { hookConfig: { type: "command", command: "b" }, eventName: HookEventName.PreToolUse, success: true, output: { decision: "deny", reason: "blocked" }, duration: 10 },
    ], HookEventName.PreToolUse);
    expect(result.finalOutput?.isBlockingDecision()).toBe(true);
  });

  test("OR 决策：全部 allow 则 allow", () => {
    const agg = new HookAggregator();
    const result = agg.aggregateResults([
      { hookConfig: { type: "command", command: "a" }, eventName: HookEventName.PreToolUse, success: true, output: { decision: "allow" }, duration: 10 },
      { hookConfig: { type: "command", command: "b" }, eventName: HookEventName.PreToolUse, success: true, output: { decision: "allow" }, duration: 10 },
    ], HookEventName.PreToolUse);
    expect(result.finalOutput?.isBlockingDecision()).toBe(false);
    expect(result.finalOutput?.decision).toBe("allow");
  });

  test("字段替换：后者覆盖前者", () => {
    const agg = new HookAggregator();
    const result = agg.aggregateResults([
      { hookConfig: { type: "command", command: "a" }, eventName: HookEventName.BeforeModel, success: true, output: { systemMessage: "first" }, duration: 10 },
      { hookConfig: { type: "command", command: "b" }, eventName: HookEventName.BeforeModel, success: true, output: { systemMessage: "second" }, duration: 10 },
    ], HookEventName.BeforeModel);
    expect(result.finalOutput?.systemMessage).toBe("second");
  });

  test("additionalContext 收集", () => {
    const agg = new HookAggregator();
    const result = agg.aggregateResults([
      { hookConfig: { type: "command", command: "a" }, eventName: HookEventName.UserPromptSubmit, success: true, output: { hookSpecificOutput: { additionalContext: "ctx1" } }, duration: 10 },
      { hookConfig: { type: "command", command: "b" }, eventName: HookEventName.UserPromptSubmit, success: true, output: { hookSpecificOutput: { additionalContext: "ctx2" } }, duration: 10 },
    ], HookEventName.UserPromptSubmit);
    expect(result.finalOutput?.getAdditionalContext()).toBe("ctx1\nctx2");
  });
});

// === HookPlanner 单元测试 ===

describe("HookPlanner", () => {
  test("无匹配返回 null", () => {
    const registry = new HookRegistry();
    const planner = new HookPlanner(registry);
    const plan = planner.createExecutionPlan(HookEventName.PreToolUse);
    expect(plan).toBeNull();
  });

  test("matcher 过滤", () => {
    const registry = new HookRegistry();
    registry.initializeFromLegacy({
      pre_tool_use: [
        { command: "echo a", matcher: "bash" },
        { command: "echo b", matcher: "write" },
      ],
    });
    const planner = new HookPlanner(registry);
    const plan = planner.createExecutionPlan(HookEventName.PreToolUse, { toolName: "bash" });
    expect(plan?.hookConfigs.length).toBe(1);
  });

  test("去重", () => {
    const registry = new HookRegistry();
    registry.initializeFromLegacy({
      pre_tool_use: [
        { command: "echo same" },
        { command: "echo same" },
      ],
    });
    const planner = new HookPlanner(registry);
    const plan = planner.createExecutionPlan(HookEventName.PreToolUse);
    expect(plan?.hookConfigs.length).toBe(1);
  });
});
