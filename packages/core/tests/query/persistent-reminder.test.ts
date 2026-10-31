/**
 * 「只播一次」档持久 reminder 块：构造 / 追加 / 排序，以及下游读者逐块剔除。
 *
 * 持久块写进 ctxMgr 历史后，凡是「从历史里取用户原文」的地方都会看见它。
 * 这里锁住三个读者：响应式压缩的「原始任务」、会话标题、ctxMgr 的尾部追加入口。
 * TUI 剥离在 packages/cli/tests/ui/history-adapter.test.ts。
 */

import { describe, test, expect } from "bun:test";
import {
  appendPersistentBlocks,
  buildPersistentReminderBlocks,
  injectReminders,
  isPersistentReminderBlock,
} from "@sid-code/core/query/reminder-inject.ts";
import { reactiveCompact } from "@sid-code/core/query/reactive-compact.ts";
import { extractFirstUserMessage } from "@sid-code/core/session/utils.ts";
import { Manager as ContextManager } from "@sid-code/core/context/manager.ts";
import type { Message } from "@sid-code/core/llm/types.ts";

const USER = "帮我修复登录页的样式问题";

describe("buildPersistentReminderBlocks", () => {
  test("逐片段过围栏并打 persistentReminder 标记，不带 transient", () => {
    const blocks = buildPersistentReminderBlocks([
      "裸文本",
      "",
      "<system-reminder>\n已围栏\n</system-reminder>",
    ]);
    expect(blocks.length).toBe(2);
    expect(blocks[0].text.startsWith("<system-reminder>")).toBe(true);
    expect(blocks[1].text).toBe("<system-reminder>\n已围栏\n</system-reminder>");
    for (const b of blocks) {
      expect(b.persistentReminder).toBe(true);
      expect(b.transient).toBeUndefined();
      expect(isPersistentReminderBlock(b)).toBe(true);
    }
  });
});

describe("appendPersistentBlocks", () => {
  test("只追加到最后一条 user 消息末尾，不改入参", () => {
    const msgs: Message[] = [{ role: "user", content: [{ type: "text", text: USER }] }];
    const blocks = buildPersistentReminderBlocks(["x"]);
    const out = appendPersistentBlocks(msgs, blocks)!;
    expect(out[0].content.length).toBe(2);
    expect(msgs[0].content.length).toBe(1);
  });

  test("最后一条不是 user 时返回 null（调用方降级为 transient）", () => {
    const msgs: Message[] = [
      { role: "user", content: [{ type: "text", text: USER }] },
      { role: "assistant", content: [{ type: "text", text: "好" }] },
    ];
    expect(appendPersistentBlocks(msgs, buildPersistentReminderBlocks(["x"]))).toBeNull();
  });
});

describe("injectReminders 与持久块共存", () => {
  test("ambient 排在持久块之后、critical 排在用户原文之前", () => {
    const msgs: Message[] = [
      {
        role: "user",
        content: [{ type: "text", text: USER }, ...buildPersistentReminderBlocks(["mcp 说明"])],
      },
    ];
    const out = injectReminders(msgs, { critical: ["止损"], ambient: ["todo"] });
    const c = out[0].content as any[];
    expect(c.map((b) => (b.persistentReminder ? "P" : b.transient ? "T" : "U"))).toEqual([
      "T",
      "U",
      "P",
      "T",
    ]);
    expect(c[0].text).toContain("止损");
    expect(c[3].text).toContain("todo");
  });
});

describe("ContextManager.appendPersistentBlocksToLastMessage", () => {
  test("末条是 user 时追加并返回 true；末条是 assistant 时不写、返回 false", () => {
    const ctx = new ContextManager({ maxTokens: 200000 });
    ctx.addMessage({ role: "user", content: [{ type: "text", text: USER }] });
    expect(ctx.appendPersistentBlocksToLastMessage(buildPersistentReminderBlocks(["a"]))).toBe(
      true,
    );
    expect(ctx.getMessages()[0].content.length).toBe(2);
    ctx.addMessage({ role: "assistant", content: [{ type: "text", text: "好" }] });
    expect(ctx.appendPersistentBlocksToLastMessage(buildPersistentReminderBlocks(["b"]))).toBe(
      false,
    );
    expect(ctx.getMessages().length).toBe(2);
  });
});

describe("下游读者剔除持久块", () => {
  // 故意不带围栏前缀：验证判据是结构化标记，而不只是靠 `<system-reminder>` 文本前缀
  const persistent = {
    type: "text" as const,
    text: "MCP 说明正文 demo_init",
    persistentReminder: true as const,
  };

  test("响应式压缩的「原始任务」只含用户原文", () => {
    const ctx = new ContextManager({ maxTokens: 200000 });
    ctx.addMessage({ role: "user", content: [{ type: "text", text: USER }, persistent] });
    for (let i = 0; i < 6; i++) {
      ctx.addMessage({ role: "assistant", content: [{ type: "text", text: `进度 ${i}` }] });
      ctx.addMessage({ role: "user", content: [{ type: "text", text: `继续 ${i}` }] });
    }
    const r = reactiveCompact(ctx);
    expect(r.success).toBe(true);
    const all = JSON.stringify(ctx.getMessages());
    expect(all).toContain(`[原始任务] ${USER}`);
    expect(all).not.toContain("demo_init");
  });

  test("会话标题不拼入持久块", () => {
    const title = extractFirstUserMessage([
      { role: "user", content: [{ type: "text", text: USER }, persistent] },
    ]);
    expect(title).toBe(USER);
  });
});
