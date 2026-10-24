/**
 * 冷缓存清理：判定 + 决策冻结（§6.7 / §6.9）
 *
 * 断言对着修复前的两个可观察后果写：
 *  1. 热缓存被判冷 —— 冷热判定必须跨 queryLoop 存活，且「不知道」= 热；
 *  2. 清理只落在一轮发送副本上 —— 清完下一轮又发原文，前缀改写两次。
 */

import { describe, test, expect, beforeEach, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Manager } from "@sid-code/core/context/manager.ts";
import type { Message } from "@sid-code/core/llm/types.ts";
import {
  MAX_PROMPT_CACHE_TTL_MS,
  isPrefixCacheProvablyCold,
  msSincePrefixTouch,
  recordPrefixTouch,
  resetPrefixTouchForTests,
} from "@sid-code/core/api/cache-warmth.ts";

let tmpRoot = "";
const savedTmp = process.env.SID_CODE_TMPDIR;
beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "sid-cold-clear-"));
  process.env.SID_CODE_TMPDIR = tmpRoot;
});
afterAll(() => {
  if (savedTmp === undefined) delete process.env.SID_CODE_TMPDIR;
  else process.env.SID_CODE_TMPDIR = savedTmp;
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("cache-warmth：能证明冷才算冷", () => {
  beforeEach(() => resetPrefixTouchForTests());

  test("进程内从未发过请求 → 不知道 → 按热处理（resume 后首轮不清）", () => {
    expect(msSincePrefixTouch()).toBeUndefined();
    expect(isPrefixCacheProvablyCold()).toBe(false);
  });

  test("隔 2 分钟（旧实现的典型误判场景）→ 热", () => {
    recordPrefixTouch(1_000_000);
    expect(isPrefixCacheProvablyCold(1_000_000 + 2 * 60_000)).toBe(false);
  });

  test("隔 10 分钟仍按热：网关可能用 1h TTL，5 分钟不足以证明已过期", () => {
    recordPrefixTouch(1_000_000);
    expect(isPrefixCacheProvablyCold(1_000_000 + 10 * 60_000)).toBe(false);
  });

  test("隔满最长 TTL → 冷", () => {
    recordPrefixTouch(1_000_000);
    expect(isPrefixCacheProvablyCold(1_000_000 + MAX_PROMPT_CACHE_TTL_MS)).toBe(true);
  });

  test("时间倒退的触碰不会把时间点往回拨（并发请求乱序落点）", () => {
    recordPrefixTouch(2_000_000);
    recordPrefixTouch(1_000_000);
    expect(msSincePrefixTouch(2_000_000)).toBe(0);
  });
});

/** n 轮 read 调用，每条结果 chars 字符（> microcompact 500 字符阈值，< 大输出 30K 阈值） */
function history(rounds: number, chars = 2_000): Message[] {
  const msgs: Message[] = [{ role: "user", content: [{ type: "text", text: "开始" }] }];
  for (let i = 0; i < rounds; i++) {
    msgs.push({
      role: "assistant",
      content: [{ type: "tool_use", id: `t${i}`, name: "read", input: { file_path: `f${i}.ts` } }],
    });
    msgs.push({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: `t${i}`, content: `${i}`.repeat(chars) }],
    });
  }
  return msgs;
}

function toolResult(sent: Message[], id: string): string | undefined {
  for (const m of sent) {
    for (const b of m.content) {
      if (b.type === "tool_result" && b.tool_use_id === id) return b.content;
    }
  }
  return undefined;
}

describe("ContextManager.applyColdCacheClear：决策冻结", () => {
  test("清理落在会话状态：之后每轮发送都是同一份占位（前缀只改写一次）", () => {
    const mgr = new Manager({ maxTokens: 1_000_000 });
    mgr.setMessages(history(10));
    mgr.consumeSendMutationCauses();

    const r = mgr.applyColdCacheClear();
    expect(r.cleared).toBeGreaterThan(0);
    const first = mgr.getCleanedMessages();
    const placeholder = toolResult(first, "t0");
    expect(placeholder).not.toBe("0".repeat(2_000));

    // 旧缺陷：下一轮又发原文。现在：后续轮次不再调 applyColdCacheClear，也必须贴同一份
    mgr.addMessage({ role: "assistant", content: [{ type: "text", text: "继续" }] });
    mgr.addMessage({ role: "user", content: [{ type: "text", text: "下一步" }] });
    const second = mgr.getCleanedMessages();
    expect(toolResult(second, "t0")).toBe(placeholder);
    // 原始历史不被改写（清理只作用于发送投影）
    expect(toolResult(mgr.getMessages(), "t0")).toBe("0".repeat(2_000));
  });

  test("保护窗口内（最近 6 条）不清", () => {
    const mgr = new Manager({ maxTokens: 1_000_000 });
    mgr.setMessages(history(10));
    mgr.applyColdCacheClear();
    const sent = mgr.getCleanedMessages();
    expect(toolResult(sent, "t9")).toBe("9".repeat(2_000));
  });

  test("重复调用幂等：已清的块不再被改第二次", () => {
    const mgr = new Manager({ maxTokens: 1_000_000 });
    mgr.setMessages(history(10));
    const a = mgr.applyColdCacheClear();
    const b = mgr.applyColdCacheClear();
    expect(a.cleared).toBeGreaterThan(0);
    expect(b.cleared).toBe(0);
  });

  test("清理会被记成 cold_clear，供 prefix_break.cause 归因", () => {
    const mgr = new Manager({ maxTokens: 1_000_000 });
    mgr.setMessages(history(10));
    mgr.consumeSendMutationCauses();
    mgr.applyColdCacheClear();
    expect(mgr.consumeSendMutationCauses()).toContain("cold_clear");
  });

  test("没东西可清时不记 cause（避免把无改写的轮次误归因）", () => {
    const mgr = new Manager({ maxTokens: 1_000_000 });
    mgr.setMessages(history(2));
    mgr.consumeSendMutationCauses();
    expect(mgr.applyColdCacheClear().cleared).toBe(0);
    expect(mgr.consumeSendMutationCauses()).toEqual([]);
  });

  test("压缩 / setMessages 后决策清空（与 masking / replacementState 同生命周期）", () => {
    const mgr = new Manager({ maxTokens: 1_000_000 });
    mgr.setMessages(history(10));
    mgr.applyColdCacheClear();
    mgr.setMessages(history(10));
    const sent = mgr.getCleanedMessages();
    expect(toolResult(sent, "t0")).toBe("0".repeat(2_000));
  });
});
