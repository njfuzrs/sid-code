/**
 * 内部字段 `_agentId` **不外泄**的回归测试（2026-11-04，B1）
 *
 * 背景：子代理 / forked 两条执行路径曾把 `_agentId` **无条件**塞进每一次工具入参，
 * 于是内部字段从三条出口漏出去（实测见 `20261104-子代理_agentId泄入工具入参与workflow-phases形态未说明-落地方案.md`）：
 *   1. `StructuredOutput.execute` 拿 workflow 的 JSON Schema 再校验一遍入参，
 *      严格 schema（`additionalProperties: false`）必定报「不允许的额外字段 _agentId」，
 *      子代理改不掉这个字段 → 重试到 maxRetries，workflow 拿到 null；
 *   2. 宽松 schema 校验通过，脏字段被当结果捕获，进 workflow 的返回值；
 *   3. MCP 工具把入参原样作为 arguments 发给外部 server。
 *
 * 修法是**按需注入**（契约见 `tool/types.ts` 的 `consumesAgentId`），本文件守住四条出口，
 * 同时守住「三个真实消费者仍拿得到字段」这一侧（否则就是 fail-open 的另一种形态）。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runToolUse } from "@sid-code/core/query/run-tool-use.ts";
import { StructuredOutputTool } from "@sid-code/core/tool/structured-output-tool.ts";
import { Registry as ToolRegistry } from "@sid-code/core/tool/registry.ts";
import { SubAgent } from "@sid-code/core/agent/sub-agent.ts";
import { runForkedAgent } from "@sid-code/core/agent/forked-agent.ts";
import { MCPManager } from "@sid-code/core/mcp/manager.ts";
import { MemoryTool } from "@sid-code/core/tool/memory.ts";
import { MemoryStore } from "@sid-code/core/memory/store.ts";
import { EnterPlanModeTool } from "@sid-code/core/tool/enter-plan-mode.ts";
import { PlanModeManager } from "@sid-code/core/plan/state.ts";
import { SubAgentTool } from "@sid-code/core/agent/tool.ts";
import { ProviderRegistry } from "@sid-code/core/llm/registry.ts";
import {
  attachAnalyticsSink,
  __resetAnalyticsForTest,
  type EventMetadata,
} from "@sid-code/core/analytics/index.ts";
import { EVENT_NAMES } from "@sid-code/core/analytics/events.ts";

const checker = {
  check: async () => ({ allowed: true }),
  recordUserDenial: () => {},
} as any;

const mode = { sessionId: "internal-fields", diagnosticOwner: "internal-fields" };

/** 直接经 spawn 子代理路径执行一次工具（走 runToolUse） */
async function runViaSubAgent(
  toolName: string,
  input: Record<string, unknown>,
  registry: ToolRegistry,
) {
  const sub = new SubAgent({} as any, "mock-model", registry);
  sub.setPermissionChecker(checker);
  return (sub as any).executeToolForChild(toolName, input, registry, undefined, "tu-probe");
}

function makeRegistry(): ToolRegistry {
  return new ToolRegistry();
}

describe("B1 · StructuredOutput 不再被内部字段污染", () => {
  test("严格 schema（additionalProperties:false）：校验通过，捕获值不含 _agentId", async () => {
    const tool = new StructuredOutputTool({
      type: "object",
      properties: { ok: { type: "boolean" } },
      required: ["ok"],
      additionalProperties: false,
    });
    const res = await runToolUse(
      { type: "tool_use", id: "t1", name: "StructuredOutput", input: { ok: true } } as any,
      tool as any,
      { permissionChecker: checker },
      mode,
    );
    // 修复前这里是 is_error:true +「/_agentId: 不允许的额外字段 _agentId」
    expect((res as any).is_error).toBeFalsy();
    expect(tool.getCapturedOutput()).toEqual({ ok: true });
    expect(JSON.stringify(tool.getCapturedOutput())).not.toContain("_agentId");
  });

  test("宽松 schema：捕获值同样不含 _agentId（修复前静默污染）", async () => {
    const tool = new StructuredOutputTool({
      type: "object",
      properties: { ok: { type: "boolean" } },
    });
    await runToolUse(
      { type: "tool_use", id: "t2", name: "StructuredOutput", input: { ok: true } } as any,
      tool as any,
      { permissionChecker: checker },
      mode,
    );
    expect(tool.getCapturedOutput()).toEqual({ ok: true });
  });
});

describe("B1 · MCP 工具不再把内部字段发给外部 server", () => {
  test("子代理路径下 client.callTool 收到的 arguments 不含 _agentId", async () => {
    let argsSeenByServer: Record<string, unknown> | undefined;
    const fakeClient = {
      callTool: async (_name: string, args: Record<string, unknown>) => {
        argsSeenByServer = args;
        return { content: [{ type: "text", text: "ok" }] };
      },
    };
    const def = {
      name: "create_issue",
      description: "建单",
      inputSchema: { type: "object", properties: { title: { type: "string" } } },
      annotations: { readOnlyHint: true },
    };
    // MCPToolAdapter 未导出（mcp/manager.ts 的私有类），只能经 MCPManager 的私有适配器
    // 工厂构造；adaptTools 不读 this，故用原型调用拿到真实适配器 + stub client。
    // 这样覆盖的是生产代码里 execute → callWithToolTimeout → client.callTool 的完整传参链路。
    const [tool] = (MCPManager.prototype as any).adaptTools.call(
      {},
      fakeClient,
      [def],
      "probe",
    ) as any[];
    expect(tool.name()).toBe("mcp__probe__create_issue");

    const reg = makeRegistry();
    reg.register(tool);
    await runViaSubAgent(tool.name(), { title: "x" }, reg);

    expect(argsSeenByServer).toEqual({ title: "x" });
    expect("_agentId" in (argsSeenByServer ?? {})).toBe(false);
  });
});

describe("B1 · 三个真实消费者仍拿得到 _agentId（按需注入不能变成 fail-open）", () => {
  let tmpHome: string;
  let prevEnv: string | undefined;
  let seen: Array<{ name: string; meta: EventMetadata }>;

  beforeEach(() => {
    prevEnv = process.env.SID_CONFIG_DIR;
    tmpHome = mkdtempSync(join(tmpdir(), "sid-agentid-"));
    process.env.SID_CONFIG_DIR = tmpHome;
    __resetAnalyticsForTest();
    seen = [];
    attachAnalyticsSink({ logEvent: (name, meta) => seen.push({ name, meta }) });
  });

  afterEach(async () => {
    // 落盘与埋点可能走微任务，先排空再恢复 env（CONTRIBUTING 测试约定第 2 条）
    await new Promise((r) => setTimeout(r, 0));
    __resetAnalyticsForTest();
    if (prevEnv === undefined) delete process.env.SID_CONFIG_DIR;
    else process.env.SID_CONFIG_DIR = prevEnv;
    try {
      rmSync(tmpHome, { recursive: true, force: true });
    } catch {}
  });

  test("enter_plan_mode：子代理路径仍被拒（漏声明 + 注入缺失会放它进规划态）", async () => {
    const reg = makeRegistry();
    reg.register(new EnterPlanModeTool(new PlanModeManager()) as any);
    const res = await runViaSubAgent("enter_plan_mode", { topic: "x" }, reg);
    expect((res as any).is_error).toBe(true);
    expect(String((res as any).content)).toContain("子代理不能进入 plan mode");
  });

  test("save_memory：子代理路径写入的 via 仍是 subagent", async () => {
    const reg = makeRegistry();
    reg.register(new MemoryTool(new MemoryStore(tmpHome)) as any);
    const res = await runViaSubAgent(
      "save_memory",
      {
        key: "agentid_probe",
        value: "子代理路径写入来源应记为 subagent",
        type: "project",
      },
      reg,
    );
    expect((res as any).is_error).toBeFalsy();
    const writes = seen.filter((e) => e.name === EVENT_NAMES.MEMORY_WRITE);
    expect(writes.length).toBe(1);
    expect(writes[0]!.meta.write_via).toBe("subagent" as any);
  });

  test("sub_agent：子代理路径调用仍被拦（_agentId 兜底那道防线还在）", async () => {
    const reg = makeRegistry();
    const providerRegistry = new ProviderRegistry({ provider: "anthropic", model: "test" } as any);
    reg.register(new SubAgentTool(providerRegistry, reg) as any);
    const res = await runViaSubAgent(
      "sub_agent",
      { type: "explore", description: "d", prompt: "p" },
      reg,
    );
    expect((res as any).is_error).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
// 第三条注入路径：forked agent（`agent/forked-agent.ts`）
// ─────────────────────────────────────────────────────────────

/** 构造一个返回脚本化事件序列的 mock provider（与 forked-agent.test.ts 同形） */
function mockProvider(scripts: any[][]) {
  let call = 0;
  return {
    name: () => "mock",
    defaultModel: () => "mock-model",
    async *sendMessageStream() {
      const events = scripts[call] ?? [
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { outputTokens: 1 } },
      ];
      call++;
      for (const e of events) yield e;
    },
  };
}

/** 一轮里并发调用两个工具：一个没声明 consumesAgentId、一个声明了 */
function twoToolTurn() {
  return [
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "t1", name: "plain_probe" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: '{"a":1}' },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id: "t2", name: "consumer_probe" },
    },
    {
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: '{"b":2}' },
    },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { outputTokens: 5 } },
  ];
}

/**
 * 收尾轮：**必须给完整的事件序列**。
 * 只给裸 `message_delta` 时，流处理路径会退化成等超时（实测 13s），
 * 让这条用例从毫秒级变成秒级——不是产品缺陷，是 mock 不像真流。
 */
function endTurn() {
  return [
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "完成" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { outputTokens: 2 } },
  ];
}

describe("B1 · forked-agent 路径同样按需注入", () => {
  test("未声明者拿不到 _agentId；声明者拿到 forked-agent", async () => {
    const seen: Record<string, any> = {};
    const mkProbe = (name: string, consumesAgentId: boolean) =>
      ({
        name: () => name,
        description: () => "probe",
        inputSchema: () => ({ type: "object", properties: {} }),
        readOnly: () => true,
        ...(consumesAgentId ? { consumesAgentId: true } : {}),
        execute: async (input: any) => {
          seen[name] = input;
          return { output: "ok" };
        },
      }) as any;

    const provider = mockProvider([twoToolTurn(), endTurn()]);
    const registry = new ToolRegistry();
    registry.register(mkProbe("plain_probe", false));
    registry.register(mkProbe("consumer_probe", true));
    await runForkedAgent(
      {
        systemPrompt: "system",
        messages: [{ role: "user", content: [{ type: "text", text: "原始对话" }] }],
        provider: provider as any,
        toolRegistry: registry,
        model: "mock-model",
      } as any,
      {
        promptMessages: [{ role: "user", content: [{ type: "text", text: "跑一次" }] }],
        canUseTool: () => ({ behavior: "allow" }),
        maxTurns: 2,
        querySource: "test",
      },
    );

    expect(seen.plain_probe).toEqual({ a: 1 });
    expect("_agentId" in seen.plain_probe).toBe(false);
    // 声明者照旧拿到 forked 标记：memory 的 write_via 就靠它区分来源
    expect(seen.consumer_probe).toEqual({ b: 2, _agentId: "forked-agent" });
  });
});

/**
 * P0-2（MD2）：`_querySource` 的注入链路。
 *
 * 为什么单独守这一环：save_memory 的 feedback 原话闸门看的是 `_querySource`，
 * 而单测里那一路是**直接传参**调 execute —— forked-agent 漏注入时那些用例仍然全绿，
 * 真实链路里闸门却永远不触发（恒绿门禁，比没有门禁更危险）。
 *
 * 顺带守住剥离侧：模型在入参里自塞 `_querySource` 必须被覆盖掉。闸门只对
 * memory-extract 生效，模型若能把自己的写入伪装成主会话路径，闸门等于没有。
 */
describe("P0-2 · forked-agent 注入 _querySource（仅声明者，且模型伪造无效）", () => {
  /** 一轮里并发调三个工具：未声明 / 声明 / 声明且伪造了字段 */
  function threeProbeTurn() {
    const mk = (index: number, id: string, name: string, json: string) => [
      {
        type: "content_block_start",
        index,
        content_block: { type: "tool_use", id, name },
      },
      {
        type: "content_block_delta",
        index,
        delta: { type: "input_json_delta", partial_json: json },
      },
      { type: "content_block_stop", index },
    ];
    return [
      ...mk(0, "q1", "plain_probe", '{"a":1}'),
      ...mk(1, "q2", "qs_probe", '{"b":2}'),
      ...mk(2, "q3", "forged_probe", '{"c":3,"_querySource":"main"}'),
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { outputTokens: 5 } },
    ];
  }

  test("声明者拿到本次 fork 的 querySource；未声明者没有；伪造值被剥离后覆盖", async () => {
    const seen: Record<string, any> = {};
    const mkProbe = (name: string, consumesQuerySource: boolean) =>
      ({
        name: () => name,
        description: () => "probe",
        inputSchema: () => ({ type: "object", properties: {} }),
        readOnly: () => true,
        ...(consumesQuerySource ? { consumesQuerySource: true } : {}),
        execute: async (input: any) => {
          seen[name] = input;
          return { output: "ok" };
        },
      }) as any;

    const provider = mockProvider([threeProbeTurn(), endTurn()]);
    const registry = new ToolRegistry();
    registry.register(mkProbe("plain_probe", false));
    registry.register(mkProbe("qs_probe", true));
    registry.register(mkProbe("forged_probe", true));
    await runForkedAgent(
      {
        systemPrompt: "system",
        messages: [{ role: "user", content: [{ type: "text", text: "原始对话" }] }],
        provider: provider as any,
        toolRegistry: registry,
        model: "mock-model",
      } as any,
      {
        promptMessages: [{ role: "user", content: [{ type: "text", text: "跑一次" }] }],
        canUseTool: () => ({ behavior: "allow" }),
        maxTurns: 2,
        querySource: "memory-extract",
      },
    );

    expect("_querySource" in seen.plain_probe).toBe(false);
    expect(seen.qs_probe).toEqual({ b: 2, _querySource: "memory-extract" });
    // 模型塞的 "main" 必须被 harness 的值覆盖 —— 否则它一句话就能绕过闸门。
    expect(seen.forged_probe).toEqual({ c: 3, _querySource: "memory-extract" });
  });
});
