/**
 * 缺口1 Phase B：mid-turn 抢占式 drain —— queryLoop 消费端集成测试
 *
 * 覆盖验收标准：
 *   2. mid-turn `now` 抢占后消息序列无孤儿 tool_use/tool_result（配对完整）；
 *   3. 流式中入队的 now 级输入，在工具批次之间被注入为 user 消息，回合内接续；
 *   4. 灰度开关：SID_ENABLE_MIDTURN_DRAIN 未开时行为与改造前一致（不注入）。
 *
 * fix_type: case_design
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { queryLoop } from "../../src/query/loop.ts";
import type { QueryLoopConfig } from "../../src/query/loop.ts";
import type { QueryDeps } from "../../src/query/types.ts";
import { Manager as ContextManager } from "../../src/context/manager.ts";
import { Registry as ToolRegistry } from "../../src/tool/registry.ts";
import { ModelFallback } from "../../src/llm/fallback.ts";
import { SessionState } from "../../src/session/state.ts";
import type { Config } from "../../src/config/config.ts";
import type { StreamEvent, AccumulatedResponse, Message } from "../../src/llm/types.ts";
import {
  enqueueCommand,
  __resetForTest,
  queueSize,
  getQueueSnapshot,
} from "../../src/query/message-queue-manager.ts";
import { checkMessageHistoryIntegrity } from "../../src/agent/message-invariants.ts";

function makeConfig(): Config {
  return { model: "deepseek-v4-pro", provider: "openai", maxTurns: 20 } as unknown as Config;
}

async function* emptyStream(): AsyncIterable<StreamEvent> {}

/** 含 tool_use 的响应（触发工具执行 → 下一轮） */
function toolResp(id: string): AccumulatedResponse {
  return {
    role: "assistant",
    content: [
      { type: "text", text: "调用工具" },
      { type: "tool_use", id, name: "read_file", input: { path: "/tmp/x" } },
    ],
    stopReason: "tool_use",
    usage: { inputTokens: 100, outputTokens: 20 },
  } as AccumulatedResponse;
}

/** 正常 end_turn 收尾 */
function endResp(text: string): AccumulatedResponse {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "end_turn",
    usage: { inputTokens: 100, outputTokens: 20 },
  } as AccumulatedResponse;
}

function makeLoopConfig(responses: AccumulatedResponse[]): {
  loopConfig: QueryLoopConfig;
  ctxMgr: ContextManager;
} {
  const ctxMgr = new ContextManager({ maxTokens: 200000 });
  ctxMgr.setSystemPrompt("test");
  ctxMgr.addMessage({ role: "user", content: [{ type: "text", text: "请处理" }] });

  let call = 0;
  const deps: QueryDeps = {
    sendWithRetry: () => emptyStream(),
    processStream: async () => {
      const r = responses[call] ?? endResp("已完成");
      call++;
      return r;
    },
    executeTools: async (content: any[]) => {
      const toolUses = content.filter((b: any) => b.type === "tool_use");
      return {
        results: toolUses.map((tu: any) => ({
          type: "tool_result" as const,
          tool_use_id: tu.id,
          content: "ok",
        })),
      };
    },
    autoCompact: async () => {},
    handleContextOverflow: () => null,
    getAbortSignal: () => undefined,
    uuid: () => "uuid-test",
  };

  const loopConfig: QueryLoopConfig = {
    config: makeConfig(),
    ctxMgr,
    toolRegistry: new ToolRegistry(),
    sessionState: new SessionState("test-session"),
    fallback: new ModelFallback(),
    deps,
  };
  return { loopConfig, ctxMgr };
}

describe("缺口1 Phase B — mid-turn 抢占式 drain", () => {
  const savedFlag = process.env.SID_ENABLE_MIDTURN_DRAIN;
  beforeEach(() => __resetForTest());
  afterEach(() => {
    if (savedFlag === undefined) delete process.env.SID_ENABLE_MIDTURN_DRAIN;
    else process.env.SID_ENABLE_MIDTURN_DRAIN = savedFlag;
    __resetForTest();
  });

  test("开关开启：now 级输入在工具批次后被注入，且历史无孤儿", async () => {
    process.env.SID_ENABLE_MIDTURN_DRAIN = "1";
    // 第 1 轮 tool_use（触发工具执行 → mid-turn 检查点）；第 2 轮 end_turn 收尾
    const { loopConfig, ctxMgr } = makeLoopConfig([toolResp("tu-1"), endResp("完成")]);

    // 模拟流式中用户按 ESC 改向，入队一条 now 级输入
    enqueueCommand({ priority: "now", kind: "user-input", payload: "改成先跑测试" });

    const systemTexts: string[] = [];
    for await (const ev of queryLoop(loopConfig)) {
      if (ev.kind === "system" && "text" in ev) systemTexts.push(ev.text);
    }

    // 验收 3：now 级输入被 mid-turn 注入（system 提示出现）
    expect(systemTexts.some((t) => t.includes("已插入") && t.includes("新输入"))).toBe(true);

    // 验收 2：最终历史无孤儿 tool_use/tool_result
    const messages = ctxMgr.getMessages() as Message[];
    const integrity = checkMessageHistoryIntegrity(messages);
    expect(integrity.orphans.length).toBe(0);

    // 注入的用户输入确实进了历史
    const allText = JSON.stringify(messages);
    expect(allText).toContain("改成先跑测试");

    // 队列已被 drain 空
    expect(queueSize()).toBe(0);
  });

  test("开关关闭：now 级输入不被 mid-turn 注入（向后兼容）", async () => {
    delete process.env.SID_ENABLE_MIDTURN_DRAIN;
    const { loopConfig } = makeLoopConfig([toolResp("tu-1"), endResp("完成")]);
    enqueueCommand({ priority: "now", kind: "user-input", payload: "改向输入" });

    const systemTexts: string[] = [];
    for await (const ev of queryLoop(loopConfig)) {
      if (ev.kind === "system" && "text" in ev) systemTexts.push(ev.text);
    }

    // 未注入：无"已插入新输入"提示
    expect(systemTexts.some((t) => t.includes("已插入"))).toBe(false);
    // 输入仍留在队列（未被 mid-turn 消费）
    expect(queueSize()).toBe(1);
  });

  test("开关开启但队列无 now 级：不注入、无副作用", async () => {
    process.env.SID_ENABLE_MIDTURN_DRAIN = "1";
    const { loopConfig } = makeLoopConfig([toolResp("tu-1"), endResp("完成")]);
    // 只有 later 级通知，不该被 now 抢占通道触发
    enqueueCommand({ priority: "later", kind: "task-notification", payload: { content: "notif" } });

    const systemTexts: string[] = [];
    for await (const ev of queryLoop(loopConfig)) {
      if (ev.kind === "system" && "text" in ev) systemTexts.push(ev.text);
    }
    expect(systemTexts.some((t) => t.includes("已插入"))).toBe(false);
  });

  test("mid-turn 只取 now 级 user-input，不丢弃同为 now 级的其它 kind", async () => {
    // 回归防护：drainByPriority("now") 会连 now 级的非 user-input 一并取出，而注入侧只处理
    // user-input → 其余 kind 被静默丢弃。改用 drainByPriorityAndKind("now","user-input") 后，
    // now 级的 permission-response 必须保留在队列，不被 mid-turn 通道误吞 / 丢失。
    process.env.SID_ENABLE_MIDTURN_DRAIN = "1";
    const { loopConfig, ctxMgr } = makeLoopConfig([toolResp("tu-1"), endResp("完成")]);

    // 同为 now 级：一条用户输入（应被注入）+ 一条权限响应（应保留在队列）
    enqueueCommand({ priority: "now", kind: "user-input", payload: "改向输入" });
    enqueueCommand({ priority: "now", kind: "permission-response", payload: { granted: true } });

    const systemTexts: string[] = [];
    for await (const ev of queryLoop(loopConfig)) {
      if (ev.kind === "system" && "text" in ev) systemTexts.push(ev.text);
    }

    // user-input 被注入
    expect(systemTexts.some((t) => t.includes("已插入"))).toBe(true);
    const allText = JSON.stringify(ctxMgr.getMessages());
    expect(allText).toContain("改向输入");

    // permission-response 未被丢弃，仍留在队列
    const remaining = getQueueSnapshot();
    expect(remaining.length).toBe(1);
    expect(remaining[0]!.kind).toBe("permission-response");
  });
});
