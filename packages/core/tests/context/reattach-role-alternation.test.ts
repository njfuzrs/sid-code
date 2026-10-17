/**
 * S5：压缩后重注入的角色交替 + 不跨内部 origin 合并。
 *
 * 全库 3/3 压缩会话命中 ROLE_NOT_ALTERNATING：保留段以 user[tool_result] 收尾，
 * 重注入裸 push `[user(files), assistant(ack)]` ⇒ user,user 相邻；随后真实响应与 ack 同角色合并，
 * `_meta` 浅合并让它继承了 `origin:"compact-reattach"`（TUI 整条隐藏、strip 整条剥离）。
 * 这里全部用**真实** ContextManager（以往测试里 appendReattachMessages 都是 fake）。
 */

import { describe, it, expect } from "bun:test";
import { Manager as ContextManager } from "@sid-code/core/context/manager.ts";
import { MessageValidator } from "@sid-code/core/context/validator.ts";
import { checkMessageHistoryIntegrity } from "@sid-code/core/agent/message-invariants.ts";
import { hasInternalOrigin } from "@sid-code/core/context/internal-message.ts";
import { REATTACH_ORIGIN } from "@sid-code/core/query/compact/reattach-markers.ts";
import { buildEmergencyFilePathReattach } from "@sid-code/core/query/compact/reattach-files.ts";
import { isHiddenFromDisplay } from "@sid-code/cli/ui/history-adapter.ts";
import type { Message } from "@sid-code/core/llm/types.ts";

function historyEndingWithToolResult(): Message[] {
  return [
    { role: "user", content: [{ type: "text", text: "改一下 a.ts" }] },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "t1", name: "read", input: { path: "a.ts" } }],
    },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "x" }] },
  ] as Message[];
}

function reattachPair(): Message[] {
  return [
    {
      role: "user",
      content: [{ type: "text", text: "[文件恢复] a.ts" }],
      _meta: { origin: REATTACH_ORIGIN },
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "好的" }],
      _meta: { origin: REATTACH_ORIGIN },
    },
  ];
}

function newCtx(msgs: Message[]): ContextManager {
  const ctx = new ContextManager({ maxTokens: 1_000_000 });
  ctx.setMessages(msgs);
  return ctx;
}

function assertValid(msgs: Message[]): void {
  expect(MessageValidator.validate(msgs)).toHaveLength(0);
  expect(checkMessageHistoryIntegrity(msgs).intact).toBe(true);
}

describe("S5 appendReattachMessages 尾部感知插桥", () => {
  it("tail=user[tool_result]：插 assistant 桥，结果合法且仍以 ack 收尾", () => {
    const ctx = newCtx(historyEndingWithToolResult());
    ctx.appendReattachMessages(reattachPair());
    const msgs = ctx.getMessages();
    assertValid(msgs);
    expect(msgs.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    // 桥带内部 origin ⇒ TUI 隐藏
    expect(hasInternalOrigin(msgs[3]!)).toBe(true);
    expect(isHiddenFromDisplay(msgs[3]!)).toBe(true);
    expect(msgs[msgs.length - 1]!._meta?.origin).toBe(REATTACH_ORIGIN);
  });

  it("tail=assistant（闲时 /compact）：原样追加，不插桥", () => {
    const base: Message[] = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "text", text: "hello" }] },
    ];
    const ctx = newCtx(base);
    ctx.appendReattachMessages(reattachPair());
    expect(ctx.getMessages()).toHaveLength(4);
    assertValid(ctx.getMessages());
  });

  it("emergency 路径（只产一条 user）在 tail=user 时也合法", () => {
    const ctx = newCtx(historyEndingWithToolResult());
    const tracker = { getRecentFiles: (n: number) => ["/a/x.ts"].slice(0, n) } as any;
    ctx.appendReattachMessages(buildEmergencyFilePathReattach(tracker));
    assertValid(ctx.getMessages());
  });
});

describe("S5 addMessage 不跨内部 origin 合并", () => {
  it("重注入后的用户输入 / 任务通知不继承 compact-reattach，且 TUI 可见", () => {
    const ctx = newCtx(historyEndingWithToolResult());
    ctx.appendReattachMessages(reattachPair());
    // 模拟下一轮真实 assistant 响应（重试成功）
    ctx.addMessage({
      role: "assistant",
      content: [{ type: "tool_use", id: "t2", name: "edit", input: {} }],
    } as Message);
    const afterAssistant = ctx.getMessages();
    const realResp = afterAssistant.find((m) =>
      m.content.some((b) => b.type === "tool_use" && (b as any).id === "t2"),
    )!;
    expect(realResp._meta?.origin).not.toBe(REATTACH_ORIGIN);
    expect(isHiddenFromDisplay(realResp)).toBe(false);
    assertValid(
      afterAssistant.concat([
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t2", content: "ok" }],
        } as Message,
      ]),
    );
  });

  it("历史以内部 ack 收尾时加入无 _meta 的 assistant：另起一条，原 ack 不被改写", () => {
    const ctx = newCtx(historyEndingWithToolResult());
    ctx.appendReattachMessages(reattachPair());
    const before = ctx.messageCount();
    ctx.addMessage({ role: "assistant", content: [{ type: "text", text: "真实答复" }] } as Message);
    const msgs = ctx.getMessages();
    expect(msgs.length).toBe(before + 2); // 桥 + 真实答复
    const last = msgs[msgs.length - 1]!;
    expect(last._meta?.origin).toBeUndefined();
    expect(isHiddenFromDisplay(last)).toBe(false);
    assertValid(msgs);
  });

  it("两条普通同角色消息仍按旧规则合并（不扩大改动面）", () => {
    const ctx = newCtx([{ role: "user", content: [{ type: "text", text: "a" }] }]);
    ctx.addMessage({ role: "user", content: [{ type: "text", text: "b" }] } as Message);
    expect(ctx.messageCount()).toBe(1);
  });
});
