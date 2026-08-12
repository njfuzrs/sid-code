/**
 * ADR-019 集成测试 — Plan 审批反馈消息顺序
 *
 * 验证 ctxMgr 最终消息序列：
 *   assistant: [tool_use(exit_plan_mode)]
 *   user: [tool_result]                  ← 紧贴 assistant
 *   user: [text(plan_approved)]          ← followup 排在 tool_result 之后
 *
 * 不能颠倒为：
 *   assistant: [tool_use(exit_plan_mode)]
 *   user: [text(plan_approved)]          ❌ 违反 OpenAI tool_calls 协议
 *   user: [tool_result]
 *
 * 该 bug 由 handlePlanApproval 直接 ctxMgr.addMessage 引起；
 * 修复后改为返回 followup 让 loop 在 toolResults 之后 enqueue。
 */

import { describe, test, expect } from "bun:test";
import type { ContentBlock } from "@sid-code/core/llm/types.ts";
import { executeTools, type ToolExecutorDeps } from "@sid-code/core/query/tool-executor.ts";

/**
 * 模拟 ctxMgr 仅用于记录 addMessage 序列
 */
class MockCtxMgr {
  messages: Array<{ role: string; content: ContentBlock[] }> = [];
  addMessage(msg: { role: string; content: ContentBlock[] }) {
    this.messages.push(msg);
  }
}

/**
 * 模拟 loop.ts:545~573 的核心时序：
 *   ret = await executeTools(...)
 *   ctxMgr.addMessage(user, ret.results)
 *   if (ret.followup) ctxMgr.addMessage(user, ret.followup)
 *
 * 实际单测核心要点：handlePlanModeTransitions 返回的 followup 被 loop 正确延迟 enqueue。
 */
async function runLoopStepWithFollowup(
  ctxMgr: MockCtxMgr,
  assistantContent: ContentBlock[],
  deps: ToolExecutorDeps,
) {
  // 1. assistant 消息进入 ctx
  ctxMgr.addMessage({ role: "assistant", content: assistantContent });
  // 2. 执行工具
  const ret = await executeTools(assistantContent, deps);
  // 3. tool_results 先 enqueue（必须紧贴 assistant）
  if (ret.results.length > 0) {
    ctxMgr.addMessage({ role: "user", content: ret.results });
  }
  // 4. followup 后 enqueue
  if (ret.followup && ret.followup.length > 0) {
    ctxMgr.addMessage({ role: "user", content: ret.followup });
  }
}

function makeDepsWithPlanApproval(): ToolExecutorDeps {
  // 最小 mock deps，仅满足 executeTools 的接口
  // 不走真实权限 / 工具注册表 —— 通过 mock toolRegistry 直接返回结果
  const tool = {
    name: () => "exit_plan_mode",
    description: () => "exit plan mode",
    inputSchema: () => ({}),
    isReadOnly: () => true,
    call: async () => ({ output: "plan submitted for approval" }),
  };
  const toolRegistry = {
    get: (name: string) => (name === "exit_plan_mode" ? tool : null),
  } as any;
  const sessionState = {
    sessionId: "test-session",
    addToolDuration: () => {},
    recordToolResult: () => {},
  } as any;
  const config = {
    permissionMode: "plan",
    checkpoint: { enabled: false },
  } as any;
  const hookSystem = {
    firePreToolUseEvent: async () => ({ shouldBlock: false }),
    firePostToolUseEvent: async () => {},
    firePostToolUseFailureEvent: async () => {},
  } as any;

  return {
    config,
    toolRegistry,
    sessionState,
    hookSystem,
    permissionChecker: null,
    getAbortSignal: () => undefined,
    requestUserConfirmation: async () => true,
    handlePlanModeTransitions: async (toolBlocks, _resultMap) => {
      // 模拟 app.ts:handlePlanModeTransitions：检测到 exit_plan_mode → 返回 followup
      for (const { block } of toolBlocks) {
        if (block.name === "exit_plan_mode") {
          return {
            followup: [{ type: "text", text: "用户已批准计划，请按计划执行。" }],
          };
        }
      }
      return {};
    },
  };
}

describe("ADR-019 — Plan 审批反馈消息顺序", () => {
  test("exit_plan_mode 后，tool_result 紧贴 assistant，followup 在 tool_result 之后", async () => {
    const ctxMgr = new MockCtxMgr();
    const deps = makeDepsWithPlanApproval();

    const assistantContent: ContentBlock[] = [
      { type: "text", text: "I've prepared the plan." },
      {
        type: "tool_use",
        id: "call_abc",
        name: "exit_plan_mode",
        input: {},
      },
    ];

    await runLoopStepWithFollowup(ctxMgr, assistantContent, deps);

    // 期望 3 条消息：assistant / user(tool_result) / user(followup)
    expect(ctxMgr.messages).toHaveLength(3);

    expect(ctxMgr.messages[0].role).toBe("assistant");
    const assistantBlocks = ctxMgr.messages[0].content;
    expect(assistantBlocks.some((b) => b.type === "tool_use")).toBe(true);

    // 第 2 条必须是 user(tool_result)，紧贴 assistant
    expect(ctxMgr.messages[1].role).toBe("user");
    const secondBlocks = ctxMgr.messages[1].content;
    expect(secondBlocks).toHaveLength(1);
    expect(secondBlocks[0].type).toBe("tool_result");
    expect((secondBlocks[0] as { tool_use_id: string }).tool_use_id).toBe("call_abc");

    // 第 3 条必须是 user(followup text)，排在 tool_result 之后
    expect(ctxMgr.messages[2].role).toBe("user");
    const thirdBlocks = ctxMgr.messages[2].content;
    expect(thirdBlocks).toHaveLength(1);
    expect(thirdBlocks[0].type).toBe("text");
    expect((thirdBlocks[0] as { text: string }).text).toContain("批准");
  });

  test("反例：handlePlanModeTransitions 在内部直接 addMessage 会让 followup 排在 tool_result 之前（演示 ADR-019 修复的 bug）", async () => {
    // 重现 bug 路径：让 transitions 直接操作 ctxMgr（旧实现），返回 void
    const ctxMgr = new MockCtxMgr();

    // 旧实现的 mock：handlePlanModeTransitions 内部直接 addMessage
    const buggyDeps: ToolExecutorDeps = {
      ...makeDepsWithPlanApproval(),
      handlePlanModeTransitions: async (toolBlocks, _resultMap) => {
        for (const { block } of toolBlocks) {
          if (block.name === "exit_plan_mode") {
            // ❌ 旧 bug：在此处直接 addMessage（会先于 tool_results 落地）
            ctxMgr.addMessage({
              role: "user",
              content: [{ type: "text", text: "用户已批准计划，请按计划执行。" }],
            });
          }
        }
        // 不返回 followup（模拟旧签名行为）
        return;
      },
    };

    const assistantContent: ContentBlock[] = [
      { type: "text", text: "plan ready" },
      {
        type: "tool_use",
        id: "call_xyz",
        name: "exit_plan_mode",
        input: {},
      },
    ];

    await runLoopStepWithFollowup(ctxMgr, assistantContent, buggyDeps);

    // 旧 bug 下序列：assistant / user(text) / user(tool_result) ← 错位
    expect(ctxMgr.messages).toHaveLength(3);
    expect(ctxMgr.messages[0].role).toBe("assistant");
    expect(ctxMgr.messages[1].role).toBe("user");
    // 第 2 条是 text（bug：本该是 tool_result）
    expect(ctxMgr.messages[1].content[0].type).toBe("text");
    // 第 3 条才是 tool_result（bug：被挤到 followup 后面）
    expect(ctxMgr.messages[2].content[0].type).toBe("tool_result");
    // 本反例测试本身是"演示 bug"，断言它确实错位——确保修复后的 followup 通道不会回到此形态。
  });
});
