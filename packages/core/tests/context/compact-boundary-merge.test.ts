/**
 * 发现 11：compact_boundary 并入尾部 user + 发送前校验增量化 —— 单元测试
 *
 * 旧实现：边界裸 push 一条 user 消息，尾部为 user[tool_result] 时恒产生 user,user 相邻；
 * getCleanedMessages 两个出口每轮对全量历史跑 validate，同一处问题每轮重复告警（实测 897 次）。
 */

import { describe, test, expect, spyOn, afterEach } from "bun:test";
import { Manager } from "@sid-code/core/context/manager.ts";
import { MessageValidator } from "@sid-code/core/context/validator.ts";
import { isCompactSourceMessage } from "@sid-code/core/context/auto-compact.ts";
import { snipCompact } from "@sid-code/core/query/compact/snip-compact.ts";
import { getLogger } from "@sid-code/core/debug/logger.ts";
import type { Message } from "@sid-code/core/llm/types.ts";

function pushToolPair(mgr: Manager, id: string, output: string): void {
  mgr.addMessage({
    role: "assistant",
    content: [{ type: "tool_use", id, name: "read", input: { file_path: `/tmp/${id}` } }],
  });
  mgr.addMessage({
    role: "user",
    content: [{ type: "tool_result", tool_use_id: id, content: output }],
  });
}

function seedEndingWithToolResult(mgr: Manager, pairs = 3): void {
  mgr.addMessage({ role: "user", content: [{ type: "text", text: "开始任务" }] });
  for (let i = 0; i < pairs; i++) pushToolPair(mgr, `t${i}`, `out-${i}`);
}

function validationWarnCount(spy: ReturnType<typeof spyOn>): number {
  return spy.mock.calls.filter((c: unknown[]) => String(c[1]).startsWith("消息验证发现")).length;
}

let warnSpy: ReturnType<typeof spyOn> | undefined;
afterEach(() => {
  warnSpy?.mockRestore();
  warnSpy = undefined;
});

describe("发现 11：compact_boundary 并入尾部 user", () => {
  test("尾部为 user 时插入边界：不新增消息、validate 0 错误、_meta 落在尾部 user 上", () => {
    const mgr = new Manager({ maxTokens: 1_000_000 });
    seedEndingWithToolResult(mgr);
    const before = mgr.messageCount();

    mgr.addCompactBoundary("渐进式压缩: snip", before);

    const msgs = mgr.getMessages();
    expect(msgs.length).toBe(before);
    expect(MessageValidator.validate(msgs)).toEqual([]);
    const last = msgs[msgs.length - 1]!;
    expect(last.role).toBe("user");
    // 原 tool_result 原样保留，边界是追加的 text 块
    expect(last.content[0]).toMatchObject({ type: "tool_result", tool_use_id: "t2" });
    expect(last.content[last.content.length - 1]).toEqual({
      type: "text",
      text: "[压缩边界] 渐进式压缩: snip",
    });
    expect(last._meta?.compact_boundary).toMatchObject({
      summary: "渐进式压缩: snip",
      messageCountBefore: before,
      source: "compact",
    });
  });

  test("合并消息不被认作压缩产物（否则 P0-5 守卫 fresh 计数少 1）", () => {
    const mgr = new Manager({ maxTokens: 1_000_000 });
    seedEndingWithToolResult(mgr);
    mgr.addCompactBoundary("摘要", mgr.messageCount());
    const last = mgr.getMessages().at(-1)!;
    expect(isCompactSourceMessage(last)).toBe(false);
  });

  test("合并后的边界消息落到下标 0 时，snipCompact 能识别并跳过它", () => {
    const mgr = new Manager({ maxTokens: 1_000_000 });
    mgr.addMessage({ role: "user", content: [{ type: "text", text: "保留段首条" }] });
    mgr.addCompactBoundary("先前压缩", 40);
    const boundary = mgr.getMessages()[0]!;
    expect(boundary._meta?.compact_boundary).toBeDefined();

    // 构造「边界消息在首位」的历史，裁剪时首条必须保留
    const history: Message[] = [boundary];
    for (let i = 0; i < 20; i++) {
      history.push({ role: "assistant", content: [{ type: "text", text: `a${i}` }] });
      history.push({ role: "user", content: [{ type: "text", text: `u${i}` }] });
    }
    const out = snipCompact(history, { minPreserveCount: 4 });
    expect(out.success).toBe(true);
    expect(out.messages[0]).toBe(boundary);
  });

  test("尾部为 assistant 时维持原行为：追加一条带 compact_source 的 user 边界消息", () => {
    const mgr = new Manager({ maxTokens: 1_000_000 });
    seedEndingWithToolResult(mgr);
    mgr.addMessage({ role: "assistant", content: [{ type: "text", text: "完成" }] });
    const before = mgr.messageCount();

    mgr.addCompactBoundary("摘要", before, "session_memory");

    const msgs = mgr.getMessages();
    expect(msgs.length).toBe(before + 1);
    const last = msgs.at(-1)!;
    expect(last.content).toEqual([{ type: "text", text: "[压缩边界] 摘要" }]);
    expect(last._meta?.compact_source).toBe("session_memory");
    expect(MessageValidator.validate(msgs)).toEqual([]);
  });

  test("边界并入是替换尾部对象而非原地改（restoreToPrefix 靠引用判前缀）", () => {
    const mgr = new Manager({ maxTokens: 1_000_000 });
    seedEndingWithToolResult(mgr);
    const snapshot = [...mgr.getMessages()];
    const tailBefore = snapshot.at(-1)!;
    mgr.addCompactBoundary("摘要", snapshot.length);
    expect(mgr.getMessages().at(-1)).not.toBe(tailBefore);
    expect(tailBefore.content.length).toBe(1);
  });
});

describe("发现 11：发送前校验增量 + 去重", () => {
  function seedBroken(mgr: Manager): void {
    // setMessages 不做交替修复：直接灌入一处 user,user 相邻
    mgr.setMessages([
      { role: "user", content: [{ type: "text", text: "q1" }] },
      { role: "user", content: [{ type: "text", text: "q2" }] },
      { role: "assistant", content: [{ type: "text", text: "a" }] },
    ]);
  }

  test("同一处问题重复调用 getCleanedMessages 只告警一次", () => {
    const mgr = new Manager({ maxTokens: 1_000_000 });
    seedBroken(mgr);
    warnSpy = spyOn(getLogger(), "warn");
    mgr.getCleanedMessages();
    mgr.getCleanedMessages();
    mgr.getCleanedMessages();
    expect(validationWarnCount(warnSpy)).toBe(1);
  });

  test("问题在尾部且尾部被合并替换（游标退回重校验）时，同一签名不重复告警", () => {
    const mgr = new Manager({ maxTokens: 1_000_000 });
    // 问题落在尾部：下标 3 与下标 2 同为 user
    mgr.setMessages([
      { role: "user", content: [{ type: "text", text: "q1" }] },
      { role: "assistant", content: [{ type: "text", text: "a" }] },
      { role: "user", content: [{ type: "text", text: "q2" }] },
      { role: "user", content: [{ type: "text", text: "q3" }] },
    ]);
    warnSpy = spyOn(getLogger(), "warn");
    mgr.getCleanedMessages();
    // addMessage 把同角色输入并入尾部（替换为新对象）⇒ 游标退回 3，ROLE_NOT_ALTERNATING@3 会被再算一次
    mgr.addMessage({ role: "user", content: [{ type: "text", text: "q4" }] });
    mgr.getCleanedMessages();
    mgr.addMessage({ role: "user", content: [{ type: "text", text: "q5" }] });
    mgr.getCleanedMessages();
    expect(validationWarnCount(warnSpy)).toBe(1);
  });

  test("新增消息引入的新问题照样告警，已告警的旧问题不再重复", () => {
    const mgr = new Manager({ maxTokens: 1_000_000 });
    seedBroken(mgr);
    warnSpy = spyOn(getLogger(), "warn");
    mgr.getCleanedMessages();
    // 引入一个新问题：tool_result 找不到 tool_use（addMessage 会并入上一条 user，所以先补 assistant）
    mgr.addMessage({ role: "user", content: [{ type: "text", text: "q3" }] });
    mgr.addMessage({ role: "assistant", content: [{ type: "text", text: "a2" }] });
    mgr.addMessage({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "ghost", content: "x" }],
    });
    mgr.getCleanedMessages();
    const calls = warnSpy.mock.calls.filter((c: unknown[]) =>
      String(c[1]).startsWith("消息验证发现"),
    );
    expect(calls.length).toBe(2);
    const second = JSON.stringify(calls[1]![2]);
    expect(second).toContain("TOOL_USE_ID_MISMATCH");
    expect(second).not.toContain("ROLE_NOT_ALTERNATING");
  });

  test("第二次调用只校验新增尾部（from = 已校验前缀长度），不是全量重跑", () => {
    const mgr = new Manager({ maxTokens: 1_000_000 });
    seedBroken(mgr);
    const vSpy = spyOn(MessageValidator, "validate");
    try {
      mgr.getCleanedMessages();
      mgr.addMessage({ role: "user", content: [{ type: "text", text: "q3" }] });
      mgr.getCleanedMessages();
      const froms = vSpy.mock.calls.map((c) => (c[1] as { from?: number } | undefined)?.from);
      expect(froms).toEqual([0, 3]);
    } finally {
      vSpy.mockRestore();
    }
  });

  test("历史被整体替换（setMessages/压缩）后游标与去重集重置，同一问题可再报", () => {
    const mgr = new Manager({ maxTokens: 1_000_000 });
    seedBroken(mgr);
    warnSpy = spyOn(getLogger(), "warn");
    mgr.getCleanedMessages();
    seedBroken(mgr);
    mgr.getCleanedMessages();
    expect(validationWarnCount(warnSpy)).toBe(2);
  });
});

describe("MessageValidator.validate 的 from 参数", () => {
  test("from 之后的 tool_result 能匹配到前缀里的 tool_use，不误报 MISMATCH", () => {
    const msgs: Message[] = [
      { role: "user", content: [{ type: "text", text: "q" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "x", name: "read", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "ok" }] },
    ];
    expect(MessageValidator.validate(msgs, { from: 2 })).toEqual([]);
  });

  test("from 之前的问题不再报，from 处与前一条的交替关系仍检查", () => {
    const msgs: Message[] = [
      { role: "user", content: [{ type: "text", text: "q1" }] },
      { role: "user", content: [{ type: "text", text: "q2" }] },
      { role: "assistant", content: [{ type: "text", text: "a" }] },
      { role: "assistant", content: [{ type: "text", text: "b" }] },
    ];
    // 前缀里的孤儿 tool_result 也不再报
    msgs[1] = {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "orphan", content: "x" }],
    };
    const codes = MessageValidator.validate(msgs, { from: 3 }).map(
      (e) => `${e.code}@${e.messageIndex}`,
    );
    expect(codes).toEqual(["ROLE_NOT_ALTERNATING@3"]);
  });
});
