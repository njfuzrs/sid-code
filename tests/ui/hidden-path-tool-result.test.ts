/**
 * 消息保真：整条分流/隐藏路径不得丢弃同消息内的 tool_result（审计第 8 条回归测试）
 *
 * 病理链：`ctxMgr.addMessage` 的角色交替**合并**会把内部消息（斜杠命令展开 / 压缩 ack /
 * 后台任务通知）追加进上一条同为 user 的、含 `tool_result` 的消息。若分流分支无条件
 * `continue`，那条 `tool_result` 一并被丢弃 → 对应 `tool_use` 永久滞留 pendingToolCalls
 * → 被函数末尾兜底逻辑输出成 executing 态并追加到历史**末尾**。
 * 用户看到的现象：任务已完成、总结已输出，屏幕最后却挂着一行"执行中"的工具气泡。
 *
 * 三条路径共用 `pushRemainingBlocks` 出口。`task-notification` 那条此前已单独修过，
 * 这里连同另外两条（command-expansion / internal-origin）一起钉住——
 * 逐处打补丁已经失败过一次，本测试覆盖全部三条，防止再漏第四处。
 */

import { describe, test, expect } from "bun:test";
import { messagesToHistoryItems, isHiddenFromDisplay } from "@sid-code/cli/ui/history-adapter.ts";
import { ToolCallStatus } from "@sid-code/cli/ui/types.ts";
import type { Message } from "@sid-code/core/llm/types.ts";
import { REATTACH_ORIGIN } from "@sid-code/core/query/compact/reattach-markers.ts";

/** assistant 侧发起一次工具调用 */
function toolUseMsg(id: string, name: string): Message {
  return {
    role: "assistant",
    content: [{ type: "tool_use", id, name, input: {} }],
  };
}

/** 断言：没有任何工具停在 executing（即没有"末尾挂执行中气泡"） */
function expectNoExecutingTool(items: ReturnType<typeof messagesToHistoryItems>): void {
  const executing = items
    .filter(i => i.type === "tool_group")
    .flatMap(i => (i.type === "tool_group" ? i.tools : []))
    .filter(t => t.status === ToolCallStatus.Executing);
  expect(executing).toEqual([]);
}

/** 断言：该 tool_use 已配上结果、渲染为成功态 */
function expectToolSucceeded(
  items: ReturnType<typeof messagesToHistoryItems>,
  name: string,
): void {
  const tools = items
    .filter(i => i.type === "tool_group")
    .flatMap(i => (i.type === "tool_group" ? i.tools : []));
  const target = tools.find(t => t.name === name);
  expect(target).toBeDefined();
  expect(target?.status).toBe(ToolCallStatus.Success);
}

describe("分流路径保留同消息内的 tool_result", () => {
  test("command-expansion 与 tool_result 合并时，tool_result 不丢", () => {
    const msgs: Message[] = [
      toolUseMsg("call_1", "task_stop"),
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call_1", content: "已停止后台任务" },
          { type: "text", text: "这里是 /commit 展开后的一大段提示词，只该喂 LLM" },
        ],
        _meta: { origin: "command-expansion", displayCommand: "/commit" },
      },
    ];

    const items = messagesToHistoryItems(msgs);

    // 命令历史项照常渲染（只显命令名）
    const cmd = items.find(i => i.type === "command");
    expect(cmd).toBeDefined();
    expect((cmd as { input: string }).input).toBe("/commit");

    // 展开后的提示词正文不泄漏到屏幕
    const userTexts = items.filter(i => i.type === "user").map(i => (i as { text: string }).text);
    expect(userTexts.join("\n")).not.toContain("展开后的一大段提示词");

    // 关键：tool_result 未被丢弃，工具配对成功、没有 executing 残留
    expectToolSucceeded(items, "task_stop");
    expectNoExecutingTool(items);
  });

  test("内部 origin（压缩 ack）与 tool_result 合并时，tool_result 不丢", () => {
    const msgs: Message[] = [
      toolUseMsg("call_2", "read"),
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call_2", content: "文件内容" },
          { type: "text", text: "了解，继续。" },
        ],
        _meta: { origin: REATTACH_ORIGIN },
      },
    ];

    const items = messagesToHistoryItems(msgs);

    // 内部 ack 文本仍不展示（含工具块时不整条隐藏，但文本要吃掉）
    const userTexts = items.filter(i => i.type === "user").map(i => (i as { text: string }).text);
    expect(userTexts.join("\n")).not.toContain("了解，继续。");

    expectToolSucceeded(items, "read");
    expectNoExecutingTool(items);
  });

  test("task-notification 与 tool_result 合并时，tool_result 不丢（既有修复的守卫）", () => {
    const msgs: Message[] = [
      toolUseMsg("call_3", "task_stop"),
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call_3", content: "任务已停止" },
          { type: "text", text: "<task-notification><task-id>t1</task-id><status>completed</status><summary>done</summary></task-notification>" },
        ],
        _meta: { origin: "task-notification", notif: [{ taskId: "t1", status: "completed", summary: "done" }] },
      },
    ];

    const items = messagesToHistoryItems(msgs);

    expect(items.some(i => i.type === "task_notification")).toBe(true);
    expectToolSucceeded(items, "task_stop");
    expectNoExecutingTool(items);
  });

  test("纯内部消息（无工具块）仍整条隐藏 —— 不是一刀切放行", () => {
    // 对照组：这是修复必须保住的既有行为，防止改成"内部消息一律渲染"
    const ackOnly: Message = {
      role: "assistant",
      content: [{ type: "text", text: "了解，继续。" }],
      _meta: { origin: REATTACH_ORIGIN },
    };
    expect(isHiddenFromDisplay(ackOnly)).toBe(true);

    const items = messagesToHistoryItems([
      { role: "user", content: [{ type: "text", text: "帮我改个 bug" }] },
      ackOnly,
    ]);
    const texts = items.filter(i => i.type === "user" || i.type === "assistant");
    expect(texts.length).toBe(1);
  });

  test("含工具块的内部 origin 消息不再整条隐藏", () => {
    const mixed: Message = {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "call_x", content: "结果" },
        { type: "text", text: "了解，继续。" },
      ],
      _meta: { origin: REATTACH_ORIGIN },
    };
    expect(isHiddenFromDisplay(mixed)).toBe(false);
  });
});
