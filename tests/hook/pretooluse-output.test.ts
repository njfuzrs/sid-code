/**
 * PreToolUseHookOutput 解读测试（G1/G2/G9）
 *
 * - G1：updatedInput 优先、tool_input 兜底，整体替换语义
 * - G2：permissionDecision allow/deny/ask + deny 计入阻塞
 * - G9：顶层 decision:"approve" 等价放行（不阻塞）
 */

import { describe, test, expect } from "bun:test";
import { PreToolUseHookOutput, DefaultHookOutput } from "../../src/hook/types.ts";

describe("PreToolUseHookOutput（G1/G2/G9）", () => {
  // === G1：updatedInput 字段 ===

  test("updatedInput 优先于 tool_input", () => {
    const out = new PreToolUseHookOutput({
      hookSpecificOutput: {
        updatedInput: { command: "ls -la" },
        tool_input: { command: "OLD" },
      },
    });
    expect(out.getModifiedToolInput()).toEqual({ command: "ls -la" });
  });

  test("无 updatedInput 时回退 tool_input（向后兼容）", () => {
    const out = new PreToolUseHookOutput({
      hookSpecificOutput: { tool_input: { command: "pwd" } },
    });
    expect(out.getModifiedToolInput()).toEqual({ command: "pwd" });
  });

  test("无任何改参字段返回 undefined", () => {
    const out = new PreToolUseHookOutput({ hookSpecificOutput: {} });
    expect(out.getModifiedToolInput()).toBeUndefined();
  });

  // === G2：permissionDecision ===

  test("permissionDecision allow/deny/ask 正确解析", () => {
    const allow = new PreToolUseHookOutput({ hookSpecificOutput: { permissionDecision: "allow" } });
    const deny = new PreToolUseHookOutput({ hookSpecificOutput: { permissionDecision: "deny" } });
    const ask = new PreToolUseHookOutput({ hookSpecificOutput: { permissionDecision: "ask" } });
    expect(allow.getPermissionDecision()).toBe("allow");
    expect(deny.getPermissionDecision()).toBe("deny");
    expect(ask.getPermissionDecision()).toBe("ask");
  });

  test("permissionDecision:deny 计入阻塞决策", () => {
    const deny = new PreToolUseHookOutput({ hookSpecificOutput: { permissionDecision: "deny" } });
    expect(deny.isBlockingDecision()).toBe(true);
  });

  test("permissionDecision:allow 不阻塞", () => {
    const allow = new PreToolUseHookOutput({ hookSpecificOutput: { permissionDecision: "allow" } });
    expect(allow.isBlockingDecision()).toBe(false);
  });

  test("permissionDecisionReason 优先作为 effectiveReason", () => {
    const out = new PreToolUseHookOutput({
      reason: "旧原因",
      hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "命中安全策略" },
    });
    expect(out.getEffectiveReason()).toBe("命中安全策略");
  });

  // === G9：顶层 approve ===

  test("顶层 decision:approve 视为放行、不阻塞", () => {
    const out = new DefaultHookOutput({ decision: "approve" });
    expect(out.isApproveDecision()).toBe(true);
    expect(out.isBlockingDecision()).toBe(false);
  });

  test("顶层 decision:allow 也视为放行", () => {
    const out = new DefaultHookOutput({ decision: "allow" });
    expect(out.isApproveDecision()).toBe(true);
  });

  test("顶层 decision:block/deny 仍阻塞", () => {
    expect(new DefaultHookOutput({ decision: "block" }).isBlockingDecision()).toBe(true);
    expect(new DefaultHookOutput({ decision: "deny" }).isBlockingDecision()).toBe(true);
  });
});
