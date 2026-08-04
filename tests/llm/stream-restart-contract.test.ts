/**
 * 流重开（`stream_restart`）作废语义 —— 跨消费者契约回归。
 *
 * 钉住的事故（session 20260804-100825-92fa0f54，2026-08-04）：
 * `fallback.ts` 在流中途失败时重开的是**全新请求**，但作废语义从未传给消费方。
 * 消费方累加器跨重试存活，于是第一次尝试的残骸被焊死在第二次完整响应前面，产出
 * 一条协议合法、语义错乱的 assistant 消息：
 *
 *   [thinking, text, tool_use(edit, input={}), thinking, text, tool_use(read, 完整)]
 *    └────── 第一次尝试（socket 关闭截断）──────┘ └────── 第二次尝试（完整）──────┘
 *
 * 那个 `input={}` 不是模型退化，而是 `input_json_delta` 被 socket 关闭截断、
 * `content_block_stop` 从未到达。下游 F1 把它误判成模型退化，连带把同响应里健康的
 * `read` 变成孤儿 tool_use。
 *
 * 本文件按"四个消费者行为必须一致"来断言——这类缺陷的根源正是同一语义在多处
 * 手写实现后漂移，因此契约测试比任何单点测试更值钱。
 */

import { describe, it, expect } from "bun:test";
import type { StreamEvent } from "../../src/llm/types.ts";
import { resetOnStreamRestart } from "../../src/llm/stream-restart.ts";
import { processStream as processStreamQuery } from "../../src/query/stream-processor.ts";
import { processStream as processStreamAgent } from "../../src/agent/stream-processor.ts";

/** 把事件数组包装成异步流 */
async function* toStream(events: StreamEvent[]): AsyncIterable<StreamEvent> {
  for (const e of events) yield e;
}

/**
 * 复刻事故现场的事件序列：
 * 第一次尝试流出 thinking + text + 半截 tool_use(edit) 后 socket 关闭 → 重开 →
 * 第二次尝试流出完整的 thinking + text + tool_use(read)。
 */
function accidentEvents(opts: { withRestart: boolean }): StreamEvent[] {
  const first: StreamEvent[] = [
    { type: "message_start", message: { usage: { inputTokens: 90090, outputTokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "§六 claude-code 章节已完成。" } },
    { type: "content_block_stop", index: 0 },
    // 半截的 edit：start + 部分 input_json_delta，**没有** content_block_stop
    {
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id: "call_492c03e2", name: "edit", input: {} },
    },
    {
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: '{"file_path":"/a.md","old_str' },
    },
  ];

  const restart: StreamEvent[] = opts.withRestart
    ? [{ type: "stream_restart", reason: "network_error", attempt: 1 }]
    : [];

  const second: StreamEvent[] = [
    { type: "message_start", message: { usage: { inputTokens: 93663, outputTokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "§7.5 已更新，继续。" } },
    { type: "content_block_stop", index: 0 },
    {
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id: "call_f35fffe0", name: "read", input: {} },
    },
    {
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: '{"file_path":"/b.md"}' },
    },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { inputTokens: 0, outputTokens: 248 } },
    { type: "message_stop" },
  ];

  return [...first, ...restart, ...second];
}

describe("stream_restart —— 主循环消费者（query/stream-processor）", () => {
  it("重开后不拼接：只保留第二次尝试的内容（事故直接回归）", async () => {
    const res = await processStreamQuery(toStream(accidentEvents({ withRestart: true })));

    // 核心断言：作废那次的 text 绝不能出现在最终响应里
    const texts = res.content.filter((b) => b.type === "text").map((b) => (b as any).text);
    expect(texts.join("")).not.toContain("§六");
    expect(texts.join("")).toContain("§7.5");

    // 只剩第二次尝试的那一个 tool_use，且参数完整
    const toolUses = res.content.filter((b) => b.type === "tool_use") as any[];
    expect(toolUses.length).toBe(1);
    expect(toolUses[0].name).toBe("read");
    expect(toolUses[0].input).toEqual({ file_path: "/b.md" });

    // 被截断的 edit 必须彻底消失（它是 F1 误判的源头）
    expect(res.content.some((b) => b.type === "tool_use" && (b as any).name === "edit")).toBe(false);
  });

  it("不发 stream_restart 时会拼接 —— 证明本测试确实在测这条路径", async () => {
    // 反向对照：没有作废广播 → 复现事故形态。这条用例的作用是防止上面那条
    // 因为"事件序列本身就不会拼接"而假绿（守卫失效检测）。
    const res = await processStreamQuery(toStream(accidentEvents({ withRestart: false })));
    const names = res.content.filter((b) => b.type === "tool_use").map((b) => (b as any).name);
    expect(names).toContain("edit");
    expect(names).toContain("read");
  });

  it("usage 不回退：作废尝试的 token 是真实计费的，必须计入", async () => {
    const res = await processStreamQuery(toStream(accidentEvents({ withRestart: true })));
    // 两次 message_start 的 input 都要累加（90090 + 93663），不能只留第二次。
    // 回退 usage 会让 cost 少采，与项目「更省」方向依赖的度量准确性冲突。
    expect(res.usage.inputTokens).toBe(90090 + 93663);
    expect(res.usage.outputTokens).toBe(248);
  });

  it("触发 onStreamRestart 回调，带上被丢弃的规模（供 UI 撤回）", async () => {
    const calls: any[] = [];
    await processStreamQuery(
      toStream(accidentEvents({ withRestart: true })),
      undefined,
      undefined,
      { onStreamRestart: (info) => calls.push(info) },
    );
    expect(calls.length).toBe(1);
    expect(calls[0].reason).toBe("network_error");
    expect(calls[0].attempt).toBe(1);
    // 作废时已累积 1 个 text + 1 个半截 tool_use
    expect(calls[0].discardedBlocks).toBe(2);
    expect(calls[0].discardedTextLength).toBeGreaterThan(0);
  });

  it("onStreamRestart 回调抛错不影响流处理主流程", async () => {
    const res = await processStreamQuery(
      toStream(accidentEvents({ withRestart: true })),
      undefined,
      undefined,
      { onStreamRestart: () => { throw new Error("UI 撤回失败"); } },
    );
    expect(res.stopReason).toBe("tool_use");
    expect(res.content.some((b) => b.type === "tool_use")).toBe(true);
  });
});

describe("stream_restart —— 子代理消费者（agent/stream-processor）", () => {
  it("重开后不残留旧尾巴：子代理按 index 落位，必须一并清", async () => {
    // 子代理的错乱形态与主循环不同但同源：它用 content[event.index] 直接落位，
    // 重开后 index 从 0 重新开始 → 低位被覆盖，但**上一次的高位块原样残留**。
    // 构造"第一次 3 块、第二次 1 块"来暴露这个形态。
    const events: StreamEvent[] = [
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "作废的开头" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "作废的尾巴" } },
      { type: "content_block_stop", index: 1 },
      { type: "stream_restart", reason: "network_error", attempt: 1 },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "真正的回答" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { inputTokens: 0, outputTokens: 5 } },
    ];
    const res = await processStreamAgent(toStream(events));
    const all = res.content.map((b) => (b as any).text ?? "").join("|");
    expect(all).toContain("真正的回答");
    expect(all).not.toContain("作废的开头");
    expect(all).not.toContain("作废的尾巴"); // ← 残留高位块的回归点
    expect(res.content.length).toBe(1);
  });
});

describe("stream_restart —— 共享重置函数", () => {
  it("清空 content / 各累加器，并如实报告丢弃规模", () => {
    const content: unknown[] = [
      { type: "text", text: "12345" },
      { type: "thinking", thinking: "ab" },
      { type: "tool_use", id: "t", name: "edit", input: {} },
    ];
    const indexToPosition = new Map([[0, 0], [1, 1]]);
    const jsonAccumulators = new Map([[2, '{"a"']]);
    const thinkingIndexes = new Set([1]);
    const thinkingStartMs = new Map([[1, 100]]);
    const thinkingBlocks: unknown[] = [{ type: "thinking", thinking: "ab" }];

    const out = resetOnStreamRestart({
      content, indexToPosition, jsonAccumulators, thinkingIndexes, thinkingStartMs, thinkingBlocks,
    });

    expect(out.discardedBlocks).toBe(3);
    expect(out.discardedTextLength).toBe(7); // "12345"(5) + "ab"(2)
    expect(content.length).toBe(0);
    expect(indexToPosition.size).toBe(0);
    expect(jsonAccumulators.size).toBe(0);
    expect(thinkingIndexes.size).toBe(0);
    expect(thinkingStartMs.size).toBe(0);
    expect(thinkingBlocks.length).toBe(0);
  });

  it("原地清空（不重新赋值）：调用方普遍用 const 持有容器", () => {
    const content: unknown[] = [{ type: "text", text: "x" }];
    const ref = content; // 模拟外部已捕获引用
    resetOnStreamRestart({ content });
    expect(ref.length).toBe(0); // 同一引用可见
  });

  it("字段可选：只传部分容器不抛错", () => {
    expect(() => resetOnStreamRestart({})).not.toThrow();
    expect(resetOnStreamRestart({}).discardedBlocks).toBe(0);
  });
});

describe("被截断的 tool_use 必须可与「模型真退化」区分", () => {
  it("content_block_stop 未到达 → 打上 _truncated 标记", async () => {
    // 这是事故里 input={} 的真实成因。没有这个标记，下游只能一律归因为
    // "模型生成了空参数"，而事故中模型很可能生成了完整参数。
    const events: StreamEvent[] = [
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "t1", name: "edit", input: {} },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"file_path":"/a.md","old_str' },
      },
      // 无 content_block_stop —— 流被截断
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { inputTokens: 0, outputTokens: 1 } },
    ];
    const res = await processStreamQuery(toStream(events));
    const tu = res.content.find((b) => b.type === "tool_use") as any;
    expect(tu).toBeDefined();
    expect(tu._truncated).toBe(true);
    expect(tu.input).toEqual({});
  });

  it("正常收尾的空参数 tool_use 不打标记（那才可能是模型退化）", async () => {
    const events: StreamEvent[] = [
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "t1", name: "enter_plan_mode", input: {} },
      },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { inputTokens: 0, outputTokens: 1 } },
    ];
    const res = await processStreamQuery(toStream(events));
    const tu = res.content.find((b) => b.type === "tool_use") as any;
    expect(tu._truncated).toBeUndefined();
  });

  it("半截 JSON 恰好可解析时尽力恢复参数，不打截断标记", async () => {
    const events: StreamEvent[] = [
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "t1", name: "read", input: {} },
      },
      // 停在了合法边界：能解出完整对象
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"file_path":"/a.md"}' } },
      // 仍然没有 content_block_stop
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { inputTokens: 0, outputTokens: 1 } },
    ];
    const res = await processStreamQuery(toStream(events));
    const tu = res.content.find((b) => b.type === "tool_use") as any;
    expect(tu.input).toEqual({ file_path: "/a.md" });
    expect(tu._truncated).toBe(false);
  });
});
