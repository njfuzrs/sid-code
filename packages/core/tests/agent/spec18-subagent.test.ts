/**
 * Spec 18 §6：子代理系统升级单测
 * - verify 类型
 * - 颜色身份
 * - Fork 消息构建
 */

import { describe, it, expect } from "bun:test";
import { assignAgentColor, colorize } from "@sid-code/core/agent/color.ts";
import { buildForkMessages } from "@sid-code/core/agent/fork.ts";
import { getBuiltInAgentDefinitions } from "@sid-code/core/agent/agent-definition.ts";

describe("verify 内置 Agent 定义", () => {
  it("存在 verify 类型", () => {
    const verify = getBuiltInAgentDefinitions().find((a) => a.agentType === "verify");
    expect(verify).toBeDefined();
    expect(verify!.tools).toContain("read");
    expect(verify!.tools).toContain("bash");
    expect(verify!.tools).not.toContain("write");
  });

  it("存在 general-purpose 类型", () => {
    const gp = getBuiltInAgentDefinitions().find((a) => a.agentType === "general-purpose");
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

  it("F1：已配对的 tool_use / tool_result 原样保留（文件正文不丢）", () => {
    const parent = [
      { role: "user", content: [{ type: "text", text: "修登录" } as any] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "我先看 validate" } as any,
          { type: "tool_use", id: "r1", name: "read", input: { file_path: "a.ts" } } as any,
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "r1", content: "第42行空指针" } as any],
      },
      { role: "assistant", content: [{ type: "text", text: "问题在 42 行" } as any] },
    ];
    const forked = buildForkMessages(parent, "修掉空指针", 6);
    const blocks = forked.flatMap((m) => m.content as any[]);
    expect(blocks.some((b) => b.type === "tool_use" && b.id === "r1")).toBe(true);
    expect(blocks.some((b) => b.type === "tool_result" && b.content === "第42行空指针")).toBe(true);
  });

  it("F1：截尾留下的悬空块被删，配对关系在结果里依然成立", () => {
    const parent = [
      // 首条 user 里的 tool_result 对应的 tool_use 已被截掉 → 悬空
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "gone", content: "x" } as any,
          { type: "text", text: "继续" } as any,
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "t", signature: "s" } as any,
          { type: "tool_use", id: "last", name: "grep", input: {} } as any, // 末条无结果 → 悬空
        ],
      },
    ];
    const forked = buildForkMessages(parent, "任务", 6);
    const blocks = forked.flatMap((m) => m.content as any[]);
    expect(blocks.some((b) => b.type === "tool_result")).toBe(false);
    expect(blocks.some((b) => b.type === "tool_use")).toBe(false);
    expect(blocks.some((b) => b.type === "thinking")).toBe(false);
    // 每个保留的 tool_use 都必须在紧随的 user 消息里有结果（协议不变量）
    for (let i = 0; i < forked.length; i++) {
      for (const b of forked[i]!.content as any[]) {
        if (b.type !== "tool_use") continue;
        const next = (forked[i + 1]?.content ?? []) as any[];
        expect(next.some((r) => r.type === "tool_result" && r.tool_use_id === b.id)).toBe(true);
      }
    }
  });
});
