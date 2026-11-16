/**
 * Spec 18 §6：子代理系统升级单测
 * - verify 类型
 * - 颜色身份
 */

import { describe, it, expect } from "bun:test";
import { assignAgentColor, colorize } from "@sid-code/core/agent/color.ts";
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
