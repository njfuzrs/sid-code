/**
 * 侧信道翻卡（增量呈现的 UI 注入层）回归测试
 *
 * 治的现象（docs/bugfixes/todo/20260803-TUI子代理呈现四问题 §2）：一轮里
 * `[sub_agent explore ×4, grep ×2]` 合并成同一并行批次，grep 秒回但卡片要等
 * 子代理跑完 1m35s 才翻——用户以为 grep "卡住了"。
 *
 * 为什么单独立这个文件（与 tests/query/incremental-tool-settle.test.ts 分工）：
 *   - 那个文件测**执行层**：executeTools 是否在该工具自己 settle 的那一刻回调 onToolSettled；
 *   - 本文件测**注入层**：拿到回调后，UI 是否真的把那张卡片翻成完成态、且不误伤别人。
 *
 * 二次校验（2026-08-03）发现注入层此前零覆盖：改坏"只翻 Executing 项"或
 * buildCompletedToolCall 签名，全量单测照样绿，只能靠人肉跑 sc-dev 才发现。
 *
 * 铁律：本文件必须调用**生产函数**（injectSettledToolCalls / buildSettledToolCallIfReady），
 * 不许在测试里照抄一遍注入逻辑——那种测试在生产代码漂移时照样通过，等于没测。
 */

import { describe, test, expect } from "bun:test";
import {
  messagesToHistoryItems,
  injectSettledToolCalls,
  buildSettledToolCallIfReady,
} from "@sid-code/cli/ui/history-adapter.ts";
import {
  ToolCallStatus,
  type HistoryItem,
  type IndividualToolCallDisplay,
} from "@sid-code/cli/ui/types.ts";
import type { ContentBlock, Message } from "@sid-code/core/llm/types.ts";

/** 一轮 assistant 消息里发出 N 个 tool_use（tool_result 尚未入 ctxMgr → 全为 Executing 态） */
function executingCards(
  calls: Array<{ id: string; name: string; input?: unknown }>,
): HistoryItem[] {
  const msgs: Message[] = [
    {
      role: "assistant",
      content: calls.map((c) => ({
        type: "tool_use" as const,
        id: c.id,
        name: c.name,
        input: c.input ?? {},
      })),
    },
  ];
  // assignIds 在生产里由 app.ts 调用；本层只关心 tool_group/tools，补个 id 即可
  return messagesToHistoryItems(msgs).map((item, i) => ({ ...item, id: i + 1 }) as HistoryItem);
}

function toolResult(id: string, content: string, isError = false): ContentBlock {
  return {
    type: "tool_result",
    tool_use_id: id,
    content,
    ...(isError ? { is_error: true } : {}),
  } as ContentBlock;
}

function allTools(items: HistoryItem[]): IndividualToolCallDisplay[] {
  return items.flatMap((i) => (i.type === "tool_group" ? i.tools : []));
}

function byId(items: HistoryItem[], callId: string): IndividualToolCallDisplay {
  const found = allTools(items).find((t) => t.callId === callId);
  if (!found) throw new Error(`卡片 ${callId} 不存在`);
  return found;
}

describe("侧信道翻卡 — 先完成的工具不等最慢的兄弟", () => {
  test("文档场景：4 explore + 2 grep 同批，只有 grep settle 时只翻 grep", () => {
    const items = executingCards([
      { id: "sa1", name: "sub_agent", input: { type: "explore" } },
      { id: "sa2", name: "sub_agent", input: { type: "explore" } },
      { id: "sa3", name: "sub_agent", input: { type: "explore" } },
      { id: "sa4", name: "sub_agent", input: { type: "explore" } },
      { id: "g1", name: "grep", input: { pattern: "foo" } },
      { id: "g2", name: "grep", input: { pattern: "bar" } },
    ]);
    // 前置：全部 Executing（否则后面的断言没有意义）
    expect(allTools(items).every((t) => t.status === ToolCallStatus.Executing)).toBe(true);
    expect(allTools(items)).toHaveLength(6);

    const flipped = injectSettledToolCalls(
      items,
      new Map([
        ["g1", { block: toolResult("g1", "3 matches"), elapsedMs: 12 }],
        ["g2", { block: toolResult("g2", "0 matches"), elapsedMs: 9 }],
      ]),
    );

    expect(flipped).toBe(2);
    // grep 已翻成完成态，并带上真实耗时（不是批次平摊值）
    expect(byId(items, "g1").status).toBe(ToolCallStatus.Success);
    expect(byId(items, "g2").status).toBe(ToolCallStatus.Success);
    expect(byId(items, "g1").elapsedMs).toBe(12);
    // 子代理仍在执行——这正是"栅栏已破"的定义：快的先出，慢的不被连带翻
    for (const id of ["sa1", "sa2", "sa3", "sa4"]) {
      expect(byId(items, id).status).toBe(ToolCallStatus.Executing);
    }
  });

  test("is_error 如实翻成 Error 态，不是一律 Success", () => {
    const items = executingCards([{ id: "c1", name: "bash" }]);
    injectSettledToolCalls(items, new Map([["c1", { block: toolResult("c1", "命令失败", true) }]]));
    expect(byId(items, "c1").status).toBe(ToolCallStatus.Error);
  });

  test("空侧信道 / 无关 callId 都不动任何卡片", () => {
    const items = executingCards([{ id: "c1", name: "grep" }]);
    expect(injectSettledToolCalls(items, new Map())).toBe(0);
    expect(byId(items, "c1").status).toBe(ToolCallStatus.Executing);

    // 侧信道里是别的工具的结果（如上一轮残留）→ 不许误翻
    expect(
      injectSettledToolCalls(items, new Map([["other", { block: toolResult("other", "x") }]])),
    ).toBe(0);
    expect(byId(items, "c1").status).toBe(ToolCallStatus.Executing);
  });

  test("已完成的卡片不被侧信道二次覆盖（权威路径已渲染，重复翻会视觉跳变）", () => {
    // 构造：tool_result 已入 ctxMgr → 权威路径渲染出的就是完成态卡片
    const msgs: Message[] = [
      { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "grep", input: {} }] },
      { role: "user", content: [toolResult("c1", "权威内容")] },
    ];
    const items = messagesToHistoryItems(msgs).map(
      (it, i) => ({ ...it, id: i + 1 }) as HistoryItem,
    );
    expect(byId(items, "c1").status).toBe(ToolCallStatus.Success);

    // 侧信道里还留着同 id 的陈旧条目（内容不同）——不许覆盖权威路径的结果
    const flipped = injectSettledToolCalls(
      items,
      new Map([["c1", { block: toolResult("c1", "陈旧内容"), elapsedMs: 999 }]]),
    );
    expect(flipped).toBe(0);
    expect(byId(items, "c1").resultDisplay?.content).toBe("权威内容");
    expect(byId(items, "c1").elapsedMs).not.toBe(999);
  });

  test("非 tool_result 块不当完成态渲染（防御性判定）", () => {
    const items = executingCards([{ id: "c1", name: "grep" }]);
    const bogus = { type: "text", text: "不是结果块" } as unknown as ContentBlock;
    expect(injectSettledToolCalls(items, new Map([["c1", { block: bogus }]]))).toBe(0);
    expect(byId(items, "c1").status).toBe(ToolCallStatus.Executing);
  });
});

describe("buildSettledToolCallIfReady — 两个调用点共用的单点判定", () => {
  test("轻量重渲路径与全量重建路径对同一输入给出一致结果（口径不漂移）", () => {
    // app.ts 有两个调用点：injectLiveToolSettled（全量重建，走 injectSettledToolCalls）
    // 与 refreshLiveProgressInPlace（轻量重渲，直接走 buildSettledToolCallIfReady）。
    // 两者必须对同一输入产出同一张卡，否则会出现"某条路径翻了、另一条没翻"的时序漂移。
    const settled = { block: toolResult("c1", "内容"), elapsedMs: 42 };

    const viaInject = executingCards([{ id: "c1", name: "grep", input: { pattern: "p" } }]);
    injectSettledToolCalls(viaInject, new Map([["c1", settled]]));

    const single = executingCards([{ id: "c1", name: "grep", input: { pattern: "p" } }]);
    const viaSingle = buildSettledToolCallIfReady(byId(single, "c1"), settled);

    expect(viaSingle).not.toBeNull();
    expect(viaSingle).toEqual(byId(viaInject, "c1"));
  });

  test("undefined（工具还没跑完）返回 null，调用方据此保持原引用", () => {
    const items = executingCards([{ id: "c1", name: "grep" }]);
    expect(buildSettledToolCallIfReady(byId(items, "c1"), undefined)).toBeNull();
  });
});
