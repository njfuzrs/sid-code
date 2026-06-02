/**
 * Spec 18 §6：子代理系统升级单测
 * - verify 类型
 * - 颜色身份
 * - Fork 消息构建
 */

import { describe, it, expect } from "bun:test";
import { assignAgentColor, colorize } from "../../src/agent/color.ts";
import { buildForkMessages } from "../../src/agent/fork.ts";
import { BUILT_IN_AGENTS } from "../../src/agent/definition.ts";

describe("verify 内置 Agent 定义", () => {
  it("存在 verify 类型", () => {
    const verify = BUILT_IN_AGENTS.find((a) => a.agentType === "verify");
    expect(verify).toBeDefined();
    expect(verify!.tools).toContain("read");
    expect(verify!.tools).toContain("bash");
    expect(verify!.tools).not.toContain("write");
  });

  it("存在 general-purpose 类型", () => {
    const gp = BUILT_IN_AGENTS.find((a) => a.agentType === "general-purpose");
    expect(gp).toBeDefined();
  });
});

describe("agent 颜色身份", () => {
  it("同 agentId 颜色稳定", () => {
    const a = assignAgentColor("agent-123");
    const b = assignAgentColor("agent-123");
    expect(a.name).toBe(b.name);
    expect(a.code).toBe(b.code);
  });

  it("colorize 包裹 ANSI 序列", () => {
    const color = assignAgentColor("x");
    const wrapped = colorize("hello", color);
    expect(wrapped).toContain("hello");
    expect(wrapped).toContain("\x1b[38;5;");
    expect(wrapped).toContain("\x1b[0m");
  });
});

describe("Fork 消息构建", () => {
  it("继承尾部上下文并附加子任务", () => {
    const parent = [
      { role: "user", content: [{ type: "text", text: "问题 A" } as any] },
      { role: "assistant", content: [{ type: "text", text: "回答 A" } as any] },
    ];
    const forked = buildForkMessages(parent, "深入研究 B", 6);
    // 最后一条是 fork 子任务
    const last = forked[forked.length - 1]!;
    expect(last.role).toBe("user");
    expect((last.content[0] as any).text).toContain("深入研究 B");
    // 继承了父上下文
    expect(forked.length).toBeGreaterThan(1);
  });

  it("从 user 消息开始（剥离孤立 assistant 开头）", () => {
    const parent = [
      { role: "assistant", content: [{ type: "text", text: "孤立回答" } as any] },
      { role: "user", content: [{ type: "text", text: "真正问题" } as any] },
      { role: "assistant", content: [{ type: "text", text: "回答" } as any] },
    ];
    const forked = buildForkMessages(parent, "任务", 6);
    expect(forked[0]!.role).toBe("user");
  });

  it("剥离含工具块的消息中的工具部分", () => {
    const parent = [
      { role: "user", content: [{ type: "text", text: "做事" } as any] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "我调用工具" } as any,
          { type: "tool_use", id: "t1", name: "bash", input: {} } as any,
        ],
      },
    ];
    const forked = buildForkMessages(parent, "继续", 6);
    // fork 消息中不应有悬空的 tool_use
    for (const msg of forked) {
      for (const block of msg.content) {
        expect((block as any).type).not.toBe("tool_use");
      }
    }
  });
});
