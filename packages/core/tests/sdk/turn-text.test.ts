/**
 * F1-D04：无头 json / stream-json 的结果取本轮全部 assistant 文本，而不是只取最后一条。
 *
 * 复现场景：模型先交付完整报告，被 todo 收尾门禁拦下，调一次 todo_write，再用一句话收尾。
 * 修前 json `content` 与 stream-json `result` 都只剩那句收尾，报告只在轨迹里。
 */

import { describe, test, expect } from "bun:test";
import { collectTurnAssistantText } from "@sid-code/core/sdk/turn-text.ts";
import { SDKQueryEngine, type SDKQueryEngineDriver } from "@sid-code/core/sdk/query-engine.ts";
import type { QueryEngineEvent } from "@sid-code/core/query/types.ts";
import type { Message } from "@sid-code/core/llm/types.ts";

const REPORT = "## 核查报告\n\n四项全部完成，详见下文。";
const CLOSING = "清单四项均已完成并已输出报告，无遗留工作。";

/** 报告 → tool_use(todo_write) → tool_result → 收尾句：门禁收尾的典型形态 */
function gatedTurn(): Message[] {
  return [
    {
      role: "assistant",
      content: [{ type: "thinking", thinking: "先写报告" } as any, { type: "text", text: REPORT }],
    },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "t1", name: "todo_write", input: { todos: [] } }],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
    },
    { role: "assistant", content: [{ type: "text", text: CLOSING }] },
  ];
}

describe("collectTurnAssistantText", () => {
  test("门禁收尾：报告 + 收尾句都在，顺序正确", () => {
    const r = collectTurnAssistantText(gatedTurn());
    expect(r.text).toBe(`${REPORT}\n\n${CLOSING}`);
    expect(r.blocks.map((b) => b.text)).toEqual([REPORT, CLOSING]);
  });

  test("只有一条 assistant：与修前「取最后一条」一致", () => {
    const r = collectTurnAssistantText([
      { role: "assistant", content: [{ type: "text", text: "2" }] },
    ]);
    expect(r.text).toBe("2");
    expect(r.blocks).toEqual([{ type: "text", text: "2" }]);
  });

  test("thinking / tool_use / user 消息不计入", () => {
    const r = collectTurnAssistantText(gatedTurn());
    expect(r.text).not.toContain("先写报告");
    expect(r.blocks.every((b) => b.type === "text")).toBe(true);
  });

  test("同一条消息内多个 text 直接相连，纯空白消息不留空行", () => {
    const r = collectTurnAssistantText([
      {
        role: "assistant",
        content: [
          { type: "text", text: "前半" },
          { type: "text", text: "后半" },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "  \n" }] },
      { role: "assistant", content: [{ type: "text", text: "结尾" }] },
    ]);
    expect(r.text).toBe("前半后半\n\n结尾");
  });

  test("空输入返回空", () => {
    expect(collectTurnAssistantText([])).toEqual({ blocks: [], text: "" });
  });
});

/** driver：按脚本吐事件；getMessages 返回「包含前一轮」的完整历史 */
function scriptedDriver(turns: QueryEngineEvent[][], history: Message[]): SDKQueryEngineDriver {
  const queue = [...turns];
  return {
    async *submitMessage() {
      for (const e of queue.shift() ?? []) yield e;
    },
    getUsage: () => ({ inputTokens: 1, outputTokens: 1 }),
    getCostUsd: () => 0,
    getMessages: () => history,
    listTools: () => [],
    getApiDurationMs: () => 1,
  };
}

const assistantEvents = (msgs: Message[]): QueryEngineEvent[] =>
  msgs
    .filter((m) => m.role === "assistant")
    .map((message) => ({ kind: "assistant_message", message }) as QueryEngineEvent);

const config = { cwd: "/tmp", sessionId: "s", model: "m", now: () => 0, uuid: () => "u" };

async function lastResult(engine: SDKQueryEngine, prompt: string): Promise<any> {
  let last: any;
  for await (const m of engine.submitMessage(prompt)) last = m;
  return last;
}

describe("SDKQueryEngine result（stream-json 口径）", () => {
  test("门禁收尾：result 含报告，不只剩收尾句", async () => {
    const turn = gatedTurn();
    const engine = new SDKQueryEngine(
      config,
      scriptedDriver([[...assistantEvents(turn), { kind: "done", turns: 2 }]], turn),
    );
    const r = await lastResult(engine, "核查");
    expect(r.type).toBe("result");
    expect(r.result).toBe(`${REPORT}\n\n${CLOSING}`);
  });

  test("前一轮 prompt 的 assistant 文本不计入本轮 result", async () => {
    const prev: Message = { role: "assistant", content: [{ type: "text", text: "上一轮的答案" }] };
    const cur: Message = { role: "assistant", content: [{ type: "text", text: "本轮答案" }] };
    const history: Message[] = [
      { role: "user", content: [{ type: "text", text: "一" }] },
      prev,
      { role: "user", content: [{ type: "text", text: "二" }] },
      cur,
    ];
    const engine = new SDKQueryEngine(
      config,
      scriptedDriver(
        [
          [
            { kind: "assistant_message", message: prev },
            { kind: "done", turns: 1 },
          ],
          [
            { kind: "assistant_message", message: cur },
            { kind: "done", turns: 1 },
          ],
        ],
        history,
      ),
    );
    await lastResult(engine, "一");
    const r = await lastResult(engine, "二");
    expect(r.result).toBe("本轮答案");
  });

  test("本轮无 assistant_message 事件：退回历史最后一条 assistant", async () => {
    const history: Message[] = [
      { role: "user", content: [{ type: "text", text: "/cmd" }] },
      { role: "assistant", content: [{ type: "text", text: "命令输出" }] },
    ];
    const engine = new SDKQueryEngine(
      config,
      scriptedDriver([[{ kind: "done", turns: 0 }]], history),
    );
    const r = await lastResult(engine, "/cmd");
    expect(r.result).toBe("命令输出");
  });
});
