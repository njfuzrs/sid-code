/**
 * sub-agent 能力边界可见单测（缺口 F）
 *
 * 覆盖：
 * - getBuiltInAgentDefinitions 返回带 description/tools 的完整定义
 * - SubAgentTool.description() 含每种类型的能力描述 + 工具集 + 只读标记
 */

import { describe, test, expect } from "bun:test";
import {
  getBuiltInAgentDefinitions,
  getBuiltInAgentTypes,
} from "@sid-code/core/agent/agent-definition.ts";
import { SubAgentTool } from "@sid-code/core/agent/tool.ts";
import type { ProviderRegistry } from "@sid-code/core/llm/registry.ts";
import { Registry as ToolRegistry } from "@sid-code/core/tool/registry.ts";

describe("getBuiltInAgentDefinitions", () => {
  test("返回完整定义（含 agentType / description / 可选 tools）", () => {
    const defs = getBuiltInAgentDefinitions();
    expect(defs.length).toBeGreaterThan(0);
    for (const d of defs) {
      expect(typeof d.agentType).toBe("string");
      expect(d.agentType.length).toBeGreaterThan(0);
      expect(typeof d.description).toBe("string");
      expect(d.description.length).toBeGreaterThan(0);
    }
  });

  test("与 getBuiltInAgentTypes 类型集合一致（保序）", () => {
    const defs = getBuiltInAgentDefinitions();
    const types = getBuiltInAgentTypes();
    expect(defs.map((d) => d.agentType)).toEqual(types);
  });

  test("explore 标记为只读且工具集不含写入工具", () => {
    const explore = getBuiltInAgentDefinitions().find((d) => d.agentType === "explore");
    expect(explore).toBeDefined();
    expect(explore!.readOnly).toBe(true);
    expect(explore!.tools).toBeDefined();
    expect(explore!.tools).not.toContain("write");
    expect(explore!.tools).not.toContain("edit");
  });

  test("task 类型可写（工具集含 write/edit/bash）", () => {
    const task = getBuiltInAgentDefinitions().find((d) => d.agentType === "task");
    expect(task).toBeDefined();
    expect(task!.tools).toContain("write");
    expect(task!.tools).toContain("bash");
  });
});

describe("SubAgentTool.description() — 能力边界可见", () => {
  // description() 不触碰 providerRegistry，用最小 stub 即可
  const tool = new SubAgentTool({} as unknown as ProviderRegistry, new ToolRegistry());

  test("含每种内置类型的类型名；类型行用短标签，不再逐字重复 whenToUse 全句", () => {
    const desc = tool.description();
    for (const d of getBuiltInAgentDefinitions()) {
      expect(desc).toContain(d.agentType);
      // 2026-11-13 描述瘦身（T9 / D6）：whenToUse 全句（explore 一条就含搜索深度说明）
      // 从每轮常驻的类型行里拿掉，类型行改短标签。「怎么选类型」的指引在 usageGuide 里，
      // 口径相同但不重复全句。全句仍是 AgentDefinition.whenToUse，供展示面使用。
      const line = desc.split("\n").find((l) => l.startsWith(`- ${d.agentType}：`));
      expect(line).toBeDefined();
      const label = line!.slice(`- ${d.agentType}：`.length, line!.indexOf("（可用工具："));
      expect(label.length).toBeGreaterThan(0);
      expect(label.length).toBeLessThan(d.whenToUse.length);
    }
  });

  test("暴露工具集边界（explore 只读、task 可写）", () => {
    const desc = tool.description();
    // explore 行应标注只读
    expect(desc).toContain("只读");
    // task 行应列出 write 工具
    expect(desc).toContain("write");
  });

  test("保留 run_in_background / isolation 说明", () => {
    const desc = tool.description();
    expect(desc).toContain("run_in_background");
    expect(desc).toContain("worktree");
  });

  test("工具行格式（类型：短标签（可用工具：...））", () => {
    const desc = tool.description();
    // 每个内置类型都应有一行 "- <type>：...（可用工具：...）"。
    // 短标签断言在上面那条用例里，这里只守行格式。
    for (const d of getBuiltInAgentDefinitions()) {
      const line = desc.split("\n").find((l) => l.includes(`- ${d.agentType}：`));
      expect(line).toBeDefined();
      expect(line).toContain("可用工具：");
    }
  });
});
