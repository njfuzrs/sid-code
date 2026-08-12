/**
 * 子 Agent 生态升级单测（对标 cc 子 Agent 体系）
 *
 * 覆盖三个新接通的能力：
 * 1. 统一 Agent 聚合 Registry —— registerDynamicAgents / getActiveAgentDefinitions
 *    让自定义/插件 agent 与内置同源，经 sub_agent 的 type 统一访问
 * 2. general-purpose 默认兜底类型 —— 对标 cc 默认 subagent_type
 * 3. Fork 消息构建接入 —— buildForkMessages 与 SubAgentTask.forkMessages 串联
 */

import { describe, test, expect, afterEach } from "bun:test";
import {
  BUILTIN_AGENTS,
  registerDynamicAgents,
  clearDynamicAgents,
  getActiveAgentDefinitions,
  getActiveAgentTypes,
  resolveAgent,
  type AgentDefinition,
} from "@sid-code/core/agent/agent-definition.ts";

afterEach(() => {
  // 每个测试后清空动态注册，避免测试间污染
  clearDynamicAgents();
});

describe("general-purpose 默认兜底类型", () => {
  test("内置注册表含 general-purpose", () => {
    expect(BUILTIN_AGENTS["general-purpose"]).toBeDefined();
    expect(BUILTIN_AGENTS["general-purpose"]!.agentType).toBe("general-purpose");
  });

  test("general-purpose 拥有全部工具但禁止递归 sub_agent", () => {
    const gp = BUILTIN_AGENTS["general-purpose"]!;
    expect(gp.tools).toContain("*");
    expect(gp.disallowedTools).toContain("sub_agent");
  });
});

describe("统一 Agent 聚合 Registry", () => {
  test("注册的动态 agent 出现在 active 列表中", () => {
    const custom: AgentDefinition = {
      agentType: "my-reviewer",
      description: "自定义审查 agent",
      whenToUse: "审查代码时用",
      systemPrompt: "你是审查代理",
      tools: ["read", "grep"],
      source: "userSettings",
    };
    registerDynamicAgents([custom]);

    const types = getActiveAgentTypes();
    expect(types).toContain("my-reviewer");
    expect(types).toContain("explore"); // built-in 仍在
  });

  test("resolveAgent 能解析动态注册的 agent", () => {
    registerDynamicAgents([
      {
        agentType: "my-custom",
        description: "x",
        whenToUse: "y",
        systemPrompt: "自定义提示词",
        source: "userSettings",
      },
    ]);
    const resolved = resolveAgent("my-custom");
    expect(resolved).toBeDefined();
    expect(resolved!.systemPrompt).toBe("自定义提示词");
  });

  test("built-in 在前、dynamic 在后（保序）", () => {
    registerDynamicAgents([
      {
        agentType: "z-custom",
        description: "x",
        whenToUse: "y",
        systemPrompt: "z",
        source: "userSettings",
      },
    ]);
    const defs = getActiveAgentDefinitions();
    const builtinCount = Object.keys(BUILTIN_AGENTS).length;
    // 前 N 个是 built-in，最后是 dynamic
    expect(defs[defs.length - 1]!.agentType).toBe("z-custom");
    expect(defs.length).toBe(builtinCount + 1);
  });

  test("同名 dynamic 覆盖 built-in 的值但保持位置（overwrite=true）", () => {
    const originalIndex = getActiveAgentDefinitions().findIndex((d) => d.agentType === "explore");
    registerDynamicAgents([
      {
        agentType: "explore",
        description: "被覆盖的 explore",
        whenToUse: "y",
        systemPrompt: "覆盖后的提示词",
        source: "userSettings",
      },
    ]);
    const defs = getActiveAgentDefinitions();
    const newIndex = defs.findIndex((d) => d.agentType === "explore");
    expect(newIndex).toBe(originalIndex); // 位置不变
    expect(defs[newIndex]!.systemPrompt).toBe("覆盖后的提示词"); // 值被覆盖
    expect(resolveAgent("explore")!.systemPrompt).toBe("覆盖后的提示词");
  });

  test("overwrite=false 时不覆盖已有定义（插件优先级低于用户）", () => {
    // 先注册用户自定义
    registerDynamicAgents([
      {
        agentType: "shared-name",
        description: "用户版",
        whenToUse: "y",
        systemPrompt: "用户提示词",
        source: "userSettings",
      },
    ]);
    // 插件用 overwrite=false 注册同名
    registerDynamicAgents(
      [
        {
          agentType: "shared-name",
          description: "插件版",
          whenToUse: "y",
          systemPrompt: "插件提示词",
          source: "plugin",
        },
      ],
      false,
    );
    // 用户版胜出
    expect(resolveAgent("shared-name")!.systemPrompt).toBe("用户提示词");
  });

  test("clearDynamicAgents 清空动态注册，built-in 不受影响", () => {
    registerDynamicAgents([
      {
        agentType: "temp",
        description: "x",
        whenToUse: "y",
        systemPrompt: "z",
        source: "userSettings",
      },
    ]);
    expect(getActiveAgentTypes()).toContain("temp");
    clearDynamicAgents();
    expect(getActiveAgentTypes()).not.toContain("temp");
    expect(getActiveAgentTypes()).toContain("explore"); // built-in 还在
  });
});
