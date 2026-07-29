/**
 * 子代理工具定义保真测试（审计第 2、18 条）
 *
 * 验证 spawn 路径的 getToolDefs 两条同源缺陷已修复：
 * - 第 2 条：自定义/插件子代理的工具白名单不再被 fail-open 忽略
 * - 第 18 条：工具定义保留 usageGuide 拼接与 strict 标记
 *
 * 每条测试均设计为「摘掉修复即变红」——
 * 把 resolveFilteredToolsForTask 改回硬编码 isBuiltIn:true（第 2 条）或
 * 把 getToolDefs 改回手写三字段映射（第 18 条），对应断言即失败。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { SubAgent } from "../../src/agent/sub-agent.ts";
import { Registry } from "../../src/tool/registry.ts";
import type { LegacyTool, LegacyToolResult } from "../../src/tool/types.ts";
import type { Provider } from "../../src/llm/provider.ts";
import type { SendParams, StreamEvent } from "../../src/llm/types.ts";
import {
  registerDynamicAgents,
  clearDynamicAgents,
} from "../../src/agent/agent-definition.ts";

// ============================================================
// Mock Provider（最小实现，仅满足 SubAgent 构造）
// ============================================================

class StubProvider implements Provider {
  name() { return "stub"; }
  defaultModel() { return "stub-model"; }
  async *sendMessageStream(_params: SendParams): AsyncIterable<StreamEvent> {
    yield { type: "message_stop" } as StreamEvent;
  }
}

// ============================================================
// 带 usageGuide 的 Mock 工具
// ============================================================

class GuidedTool implements LegacyTool {
  constructor(
    private toolName: string,
    private desc: string,
    private guide?: string,
  ) {}
  name() { return this.toolName; }
  description() { return this.desc; }
  usageGuide() { return this.guide ?? ""; }
  inputSchema() { return { type: "object", properties: { text: { type: "string" } } }; }
  readOnly() { return true; }
  async execute(): Promise<LegacyToolResult> { return { output: "ok" }; }
}

// ============================================================
// 第 2 条：自定义子代理工具白名单不再 fail-open
// ============================================================

describe("第 2 条：getToolDefs 透传自定义 agent 的 tools 白名单", () => {
  const CUSTOM_TYPE = "audit-readonly-agent";

  beforeEach(() => {
    clearDynamicAgents();
    registerDynamicAgents([
      {
        agentType: CUSTOM_TYPE,
        description: "只读审计 agent",
        whenToUse: "审计用",
        systemPrompt: "你是只读审计 agent",
        // 声明只允许 my_read，排斥 my_write / my_bash
        tools: ["my_read"],
      },
    ]);
  });

  afterEach(() => {
    clearDynamicAgents();
  });

  test("自定义 agent 声明 tools:['my_read'] 时，spawn 路径只拿到 my_read", () => {
    const tools = new Registry();
    tools.register(new GuidedTool("my_read", "读工具"));
    tools.register(new GuidedTool("my_write", "写工具"));
    tools.register(new GuidedTool("my_bash", "执行工具"));

    const sub = new SubAgent(new StubProvider(), "stub-model", tools);
    const defs = (sub as any).getToolDefs({
      type: CUSTOM_TYPE,
      description: "测试",
      prompt: "测试",
    }) as Array<{ name: string }>;

    const names = defs.map(d => d.name);
    // 修复前：硬编码 isBuiltIn:true + builtInType=CUSTOM_TYPE（不在内置白名单表）
    //   → Layer 2 allowed===undefined 不过滤 → Layer 3 无 tools 参数 → 三个全拿到（fail-open）
    // 修复后：isBuiltIn:false → Layer 3 按 agentDef.tools:["my_read"] 过滤 → 只拿 my_read
    expect(names).toEqual(["my_read"]);
    expect(names).not.toContain("my_write");
    expect(names).not.toContain("my_bash");
  });

  test("自定义 agent 声明 disallowedTools 时，spawn 路径同样尊重", () => {
    const tools = new Registry();
    tools.register(new GuidedTool("my_read", "读工具"));
    tools.register(new GuidedTool("my_bash", "执行工具"));

    clearDynamicAgents();
    registerDynamicAgents([
      {
        agentType: CUSTOM_TYPE,
        description: "只读审计 agent",
        whenToUse: "审计用",
        systemPrompt: "你是只读审计 agent",
        // 不限白名单，但禁 my_bash
        disallowedTools: ["my_bash"],
      },
    ]);

    const sub = new SubAgent(new StubProvider(), "stub-model", tools);
    const defs = (sub as any).getToolDefs({
      type: CUSTOM_TYPE,
      description: "测试",
      prompt: "测试",
    }) as Array<{ name: string }>;

    const names = defs.map(d => d.name);
    // 修复前：disallowedTools 从不传给 filterToolsForAgent → my_bash 不会被裁
    // 修复后：透传 disallowedTools → my_bash 被裁
    expect(names).toContain("my_read");
    expect(names).not.toContain("my_bash");
  });
});

// ============================================================
// 第 18 条：usageGuide 拼接与 strict 标记保真
// ============================================================

describe("第 18 条：getToolDefs 保留 usageGuide 与 strict", () => {
  const GUIDE_TEXT = "超时控制、后台运行、引号转义等全部约束";
  // 用自定义 agent 声明 tools:['my_read']，避免被 explore 内置白名单裁掉
  // （内置白名单不含 'my_read'），同时与第 2 条的过滤逻辑联动验证。
  const CUSTOM_TYPE = "audit-with-guide";

  beforeEach(() => {
    clearDynamicAgents();
    registerDynamicAgents([
      {
        agentType: CUSTOM_TYPE,
        description: "带 usageGuide 的审计 agent",
        whenToUse: "审计用",
        systemPrompt: "你是审计 agent",
        tools: ["my_read"],
      },
    ]);
  });

  afterEach(() => {
    clearDynamicAgents();
  });

  test("spawn 路径工具描述含 usageGuide 拼接（修复前丢 86.1%）", () => {
    const tools = new Registry();
    tools.register(new GuidedTool("my_read", "读工具", GUIDE_TEXT));

    const sub = new SubAgent(new StubProvider(), "stub-model", tools);
    const defs = (sub as any).getToolDefs({
      type: CUSTOM_TYPE,
      description: "测试",
      prompt: "测试",
    }) as Array<{ description: string }>;

    expect(defs.length).toBe(1);
    // 修复前：手写 {description: t.description()} 只有 "读工具"
    // 修复后：复用正路径 toolToDefinition → description += "\n\n使用指南:\n" + guide
    expect(defs[0].description).toContain("使用指南");
    expect(defs[0].description).toContain(GUIDE_TEXT);
    // 基础描述仍在
    expect(defs[0].description).toContain("读工具");
  });

  test("spawn 路径工具定义带 strict 标记（修复前该字段不存在）", () => {
    const tools = new Registry();
    tools.register(new GuidedTool("my_read", "读工具"));

    const sub = new SubAgent(new StubProvider(), "stub-model", tools);
    const defs = (sub as any).getToolDefs({
      type: CUSTOM_TYPE,
      description: "测试",
      prompt: "测试",
    }) as Array<{ strict?: boolean }>;

    expect(defs.length).toBe(1);
    // 修复前：手写三字段映射 {name, description, inputSchema}，无 strict
    // 修复后：复用正路径 → 非 mcp__ / 非 StructuredOutput → strict: true
    expect(defs[0].strict).toBe(true);
  });

  test("getCustomToolDefs 同样保留 usageGuide 与 strict", () => {
    const tools = new Registry();
    tools.register(new GuidedTool("my_read", "读工具", GUIDE_TEXT));

    const sub = new SubAgent(new StubProvider(), "stub-model", tools);
    const defs = (sub as any).getCustomToolDefs(["my_read"]) as Array<{
      name: string;
      description: string;
      strict?: boolean;
    }>;

    expect(defs.length).toBe(1);
    expect(defs[0].name).toBe("my_read");
    expect(defs[0].description).toContain(GUIDE_TEXT);
    expect(defs[0].strict).toBe(true);
  });
});
