/**
 * cache-strategy.ts 测试
 * breakpoint 放置 / skipCacheWrite / system 分区 / 幂等清场
 */

import { describe, test, expect } from "bun:test";
import {
  buildSystemBlocks,
  markLastContentBlock,
  clearCacheBreakpoints,
  addMessageCacheBreakpoint,
  addCacheBreakpoints,
  splitSystemByDynamicBoundary,
  DYNAMIC_BOUNDARY,
  countCacheBreakpoints,
  assertCacheBreakpointBudget,
  MAX_CACHE_BREAKPOINTS,
  type CacheableMessage,
} from "../../src/api/cache-strategy.ts";

function msg(role: string, ...texts: string[]): CacheableMessage {
  return { role, content: texts.map((t) => ({ type: "text", text: t })) };
}

describe("buildSystemBlocks", () => {
  test("undefined → undefined", () => {
    expect(buildSystemBlocks(undefined)).toBeUndefined();
  });
  test("无边界 → 单块带 cache_control", () => {
    const blocks = buildSystemBlocks("you are helpful")!;
    expect(blocks.length).toBe(1);
    expect(blocks[0].cache_control).toEqual({ type: "ephemeral" });
  });
  test("含 DYNAMIC_BOUNDARY → 静态/动态两块", () => {
    const blocks = buildSystemBlocks(`STATIC${DYNAMIC_BOUNDARY}DYNAMIC`)!;
    expect(blocks.length).toBe(2);
    expect(blocks[0].text).toBe("STATIC");
    expect(blocks[1].text).toBe("DYNAMIC");
    expect(blocks[0].cache_control).toEqual({ type: "ephemeral" });
    expect(blocks[1].cache_control).toEqual({ type: "ephemeral" });
  });
});

describe("splitSystemByDynamicBoundary", () => {
  test("无边界 → 整段为 staticContent，dynamicContent 为 undefined", () => {
    const result = splitSystemByDynamicBoundary("plain system prompt");
    expect(result.staticContent).toBe("plain system prompt");
    expect(result.dynamicContent).toBeUndefined();
  });
  test("含边界 → 按边界拆分为 staticContent / dynamicContent 两段", () => {
    const result = splitSystemByDynamicBoundary(`STATIC${DYNAMIC_BOUNDARY}DYNAMIC`);
    expect(result.staticContent).toBe("STATIC");
    expect(result.dynamicContent).toBe("DYNAMIC");
  });
  test("拆分结果不含边界标记字面量", () => {
    const result = splitSystemByDynamicBoundary(`STATIC${DYNAMIC_BOUNDARY}DYNAMIC`);
    expect(result.staticContent).not.toContain("DYNAMIC_BOUNDARY");
    expect(result.dynamicContent).not.toContain("DYNAMIC_BOUNDARY");
  });
});

describe("markLastContentBlock", () => {
  test("在最后一个 block 打标", () => {
    const m = msg("user", "a", "b");
    expect(markLastContentBlock(m)).toBe(true);
    const content = m.content as any[];
    expect(content[0].cache_control).toBeUndefined();
    expect(content[1].cache_control).toEqual({ type: "ephemeral" });
  });
  test("空内容返回 false", () => {
    expect(markLastContentBlock({ role: "user", content: [] })).toBe(false);
  });
  test("undefined 返回 false", () => {
    expect(markLastContentBlock(undefined)).toBe(false);
  });
});

describe("addMessageCacheBreakpoint", () => {
  test("正常模式标记最后一条", () => {
    const messages = [msg("user", "1"), msg("assistant", "2"), msg("user", "3")];
    const idx = addMessageCacheBreakpoint(messages);
    expect(idx).toBe(2);
    expect((messages[2].content as any[])[0].cache_control).toEqual({ type: "ephemeral" });
  });
  test("skipCacheWrite 标记倒数第二条", () => {
    const messages = [msg("user", "1"), msg("assistant", "2"), msg("user", "3")];
    const idx = addMessageCacheBreakpoint(messages, { skipCacheWrite: true });
    expect(idx).toBe(1);
    expect((messages[1].content as any[])[0].cache_control).toEqual({ type: "ephemeral" });
    expect((messages[2].content as any[])[0].cache_control).toBeUndefined();
  });
  test("skipCacheWrite 单条消息不打标", () => {
    const messages = [msg("user", "1")];
    expect(addMessageCacheBreakpoint(messages, { skipCacheWrite: true })).toBe(-1);
  });
  test("空数组返回 -1", () => {
    expect(addMessageCacheBreakpoint([])).toBe(-1);
  });
});

describe("clearCacheBreakpoints", () => {
  test("清除所有已有标记", () => {
    const messages = [msg("user", "1"), msg("user", "2")];
    addMessageCacheBreakpoint(messages);
    clearCacheBreakpoints(messages);
    for (const m of messages) {
      for (const b of m.content as any[]) {
        expect(b.cache_control).toBeUndefined();
      }
    }
  });
});

describe("addCacheBreakpoints 一站式", () => {
  test("先清场再打标（幂等）", () => {
    const messages = [msg("user", "1"), msg("user", "2")];
    // 旧标记在第一条
    markLastContentBlock(messages[0]);
    const r1 = addCacheBreakpoints({ messages, system: "sys" });
    expect(r1.markedMessageIndex).toBe(1);
    // 第一条的旧标记应被清除
    expect((messages[0].content as any[])[0].cache_control).toBeUndefined();
    expect((messages[1].content as any[])[0].cache_control).toEqual({ type: "ephemeral" });
    expect(r1.system?.length).toBe(1);
    // 再跑一次仍只有一个断点
    const r2 = addCacheBreakpoints({ messages, system: "sys" });
    expect(r2.markedMessageIndex).toBe(1);
    const totalMarks = messages.reduce(
      (n, m) => n + (m.content as any[]).filter((b) => b.cache_control).length,
      0,
    );
    expect(totalMarks).toBe(1);
  });
});

// ─── cache_control 断点预算护栏（比 CC 更进一步）────────────────────────

describe("cache breakpoint budget guard", () => {
  test("countCacheBreakpoints 统计 system + messages 上的 cache_control 总数", () => {
    const system = buildSystemBlocks("static" + DYNAMIC_BOUNDARY + "dynamic"); // 2 个
    const messages: CacheableMessage[] = [msg("user", "hi")];
    markLastContentBlock(messages[0]); // +1
    expect(countCacheBreakpoints(system, messages)).toBe(3);
  });

  test("当前真实布局(system 2 + 消息 1 = 3)在上限内，不抛", () => {
    const system = buildSystemBlocks("static" + DYNAMIC_BOUNDARY + "dynamic");
    const messages: CacheableMessage[] = [msg("user", "hi")];
    markLastContentBlock(messages[0]);
    expect(() => assertCacheBreakpointBudget(system, messages)).not.toThrow();
  });

  test("恰好 4 个断点仍放行（边界）", () => {
    const system: any[] = [
      { type: "text", text: "a", cache_control: { type: "ephemeral" } },
      { type: "text", text: "b", cache_control: { type: "ephemeral" } },
      { type: "text", text: "c", cache_control: { type: "ephemeral" } },
    ];
    const messages: CacheableMessage[] = [msg("user", "hi")];
    markLastContentBlock(messages[0]);
    expect(countCacheBreakpoints(system, messages)).toBe(MAX_CACHE_BREAKPOINTS);
    expect(() => assertCacheBreakpointBudget(system, messages)).not.toThrow();
  });

  test("超过 4 个断点：非生产环境抛错（暴露 bug）", () => {
    const system: any[] = [
      { type: "text", text: "a", cache_control: { type: "ephemeral" } },
      { type: "text", text: "b", cache_control: { type: "ephemeral" } },
      { type: "text", text: "c", cache_control: { type: "ephemeral" } },
      { type: "text", text: "d", cache_control: { type: "ephemeral" } },
    ];
    const messages: CacheableMessage[] = [msg("user", "hi")];
    markLastContentBlock(messages[0]); // 总计 5
    const prev = process.env.NODE_ENV;
    delete process.env.NODE_ENV;
    try {
      expect(() => assertCacheBreakpointBudget(system, messages)).toThrow(/超过 Anthropic 上限/);
    } finally {
      if (prev !== undefined) process.env.NODE_ENV = prev;
    }
  });

  test("超过 4 个断点：生产环境打日志不抛（容错优先）", () => {
    const system: any[] = [
      { type: "text", text: "a", cache_control: { type: "ephemeral" } },
      { type: "text", text: "b", cache_control: { type: "ephemeral" } },
      { type: "text", text: "c", cache_control: { type: "ephemeral" } },
      { type: "text", text: "d", cache_control: { type: "ephemeral" } },
      { type: "text", text: "e", cache_control: { type: "ephemeral" } },
    ];
    const messages: CacheableMessage[] = [];
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    let logged = "";
    const logger = { error: (_tag: string, m: string) => { logged = m; } };
    try {
      expect(() => assertCacheBreakpointBudget(system, messages, logger)).not.toThrow();
      expect(logged).toMatch(/超过 Anthropic 上限/);
    } finally {
      if (prev !== undefined) process.env.NODE_ENV = prev;
      else delete process.env.NODE_ENV;
    }
  });
});
