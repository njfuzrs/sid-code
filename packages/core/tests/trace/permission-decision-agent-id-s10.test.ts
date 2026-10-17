/**
 * S10：流外事件（PermissionDecision）的 fork / 子代理归属。
 *
 * 工具执行在流的 next() 之外，RequestContext 的 ALS 此处为空 —— 所以身份必须由
 * fork / 子代理执行入口**显式**带进工具执行，不能事后从 ALS 补。
 *
 * 覆盖三段：
 *  1. fork 路径（runForkedAgent）的 allow / deny 都带 agentId，且与流的身份同值；
 *  2. 子代理进程内路径（executeTools）带 agentId；不传则不带；
 *  3. collector 把它落成 events.jsonl 的 `agent_id`，主循环事件不出现该 key。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { runForkedAgent, type ForkedAgentContext } from "@sid-code/core/agent/forked-agent.ts";
import { executeTools } from "@sid-code/core/agent/tool-executor.ts";
import { Registry as ToolRegistry } from "@sid-code/core/tool/registry.ts";
import {
  setPermissionDecisionObserver,
  type PermissionDecisionEvent,
} from "@sid-code/core/permission/decision-telemetry.ts";
import { logPermissionAllow } from "@sid-code/core/analytics/events.ts";
import { TraceCollector } from "@sid-code/core/trace/collector.ts";
import { getRequestContext } from "@sid-code/core/llm/request-context.ts";

class ReadTool {
  name() {
    return "read";
  }
  description() {
    return "读取文件";
  }
  inputSchema() {
    return { type: "object", properties: { file_path: { type: "string" } } };
  }
  async execute() {
    return { output: "ok" };
  }
  readOnly() {
    return true;
  }
  isConcurrencySafe() {
    return true;
  }
}

function toolUseScript(id: string) {
  return [
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id, name: "read" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: '{"file_path":"/a"}' },
    },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { outputTokens: 1 } },
  ];
}

let got: PermissionDecisionEvent[];
beforeEach(() => {
  got = [];
  setPermissionDecisionObserver((e) => got.push(e));
});
afterEach(() => setPermissionDecisionObserver(null));

describe("S10 · fork 路径 PermissionDecision 带 agentId", () => {
  test("allow 与 deny 都带 fork 身份，且与流的 RequestContext.agentId 同值", async () => {
    // 记录 provider 被调用时 ALS 里的 agentId —— 证明「流的身份」与「鉴权事件的身份」是同一个值
    const streamAgentIds: Array<string | undefined> = [];
    let call = 0;
    const provider = {
      name: () => "mock",
      defaultModel: () => "mock-model",
      async *sendMessageStream() {
        streamAgentIds.push(getRequestContext()?.agentId);
        const n = call++;
        if (n < 2) {
          for (const e of toolUseScript(`t${n}`)) yield e;
          return;
        }
        // 收尾轮给真文本：空回复会被漏斗当异常重试（带退避），拖慢用例
        yield { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } };
        yield {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "完成" },
        };
        yield { type: "content_block_stop", index: 0 };
        yield {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { outputTokens: 1 },
        };
      },
    };
    const registry = new ToolRegistry();
    registry.register(new ReadTool() as any);
    const ctx: ForkedAgentContext = {
      systemPrompt: "s",
      messages: [{ role: "user", content: [{ type: "text", text: "x" }] }],
      provider: provider as any,
      toolRegistry: registry,
      model: "mock-model",
    };
    let n = 0;
    await runForkedAgent(ctx, {
      promptMessages: [{ role: "user", content: [{ type: "text", text: "提取" }] }],
      // 第一次拒、第二次放：两条分支都要覆盖
      canUseTool: () => (n++ === 0 ? { behavior: "deny", message: "no" } : { behavior: "allow" }),
      maxTurns: 5,
      querySource: "memory-extract",
    });

    expect(got.map((e) => [e.outcome, e.context, e.agentId])).toEqual([
      ["deny", "forked", "fork:memory-extract"],
      ["allow", "forked", "fork:memory-extract"],
    ]);
    expect(streamAgentIds[0]).toBe("fork:memory-extract");
  });
});

describe("S10 · 子代理进程内路径（executeTools）", () => {
  const block = {
    type: "tool_use" as const,
    id: "u1",
    name: "read",
    input: { file_path: "/a" },
  };
  const registry = () => {
    const r = new ToolRegistry();
    r.register(new ReadTool() as any);
    return r;
  };

  test("传入 agentId ⇒ PermissionDecision 带它", async () => {
    await executeTools(
      [block],
      registry(),
      undefined,
      undefined,
      undefined,
      undefined,
      "sid",
      "p-sub-t9",
    );
    expect(got).toHaveLength(1);
    expect(got[0]!.context).toBe("subagent");
    expect(got[0]!.agentId).toBe("p-sub-t9");
  });

  test("未传 agentId ⇒ 事件对象里没有 agentId 这个 key", async () => {
    await executeTools([block], registry());
    expect(got).toHaveLength(1);
    expect(Object.keys(got[0]!)).not.toContain("agentId");
  });
});

describe("S10 · collector 落盘 agent_id", () => {
  let dir: string;
  const savedIndex = process.env.SID_CODE_SESSION_INDEX;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sid-s10-perm-"));
    process.env.SID_CODE_SESSION_INDEX = join(dir, "session-index.jsonl");
  });
  afterEach(() => {
    setPermissionDecisionObserver(null);
    if (savedIndex === undefined) delete process.env.SID_CODE_SESSION_INDEX;
    else process.env.SID_CODE_SESSION_INDEX = savedIndex;
    rmSync(dir, { recursive: true, force: true });
  });

  test("fork 事件带 agent_id，主循环事件无该 key", async () => {
    const { HookSystem } = await import("@sid-code/core/hook/system.ts");
    const hooks = new HookSystem();
    hooks.setSessionId("sess-s10");
    hooks.setCwd("/tmp/test");
    const trajDir = join(dir, "trajectories");
    const collector = new TraceCollector({ outputDir: trajDir });
    collector.registerHooks(hooks);
    await hooks.fireSessionStartEvent("startup", { model: "claude-test" });
    // 空白会话会被清掉：补一轮模型调用（同 decision-metrics.test.ts）
    await hooks.fireBeforeModelEvent({
      model: "claude-test",
      messages: [{ role: "user", content: "hi" }],
      raw_messages: [{ role: "user", content: "hi" }],
    });
    await hooks.fireAfterModelEvent(
      { model: "claude-test", messages: [], raw_messages: [{ role: "user", content: "hi" }] },
      {
        content_blocks: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
      } as never,
    );

    logPermissionAllow("read", { source: "rule", needsPrompt: false, context: "main" });
    logPermissionAllow("read", {
      source: "other",
      needsPrompt: false,
      context: "forked",
      agentId: "fork:memory-extract",
    });
    await hooks.fireSessionEndEvent("exit");

    const decisions = readFileSync(join(trajDir, "sessions", "sess-s10", "events.jsonl"), "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
      .filter((e) => e.event === "PermissionDecision");
    expect(decisions).toHaveLength(2);
    expect(Object.keys(decisions[0].data)).not.toContain("agent_id");
    expect(decisions[1].data).toMatchObject({
      execution_context: "forked",
      agent_id: "fork:memory-extract",
    });
  });
});
