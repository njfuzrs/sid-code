/**
 * Layer 3：Cached Microcompact — 单元测试
 *
 * 覆盖：供应商感知路径选择、tool_use_id 状态追踪、白名单约束、cache_edits 生成、
 * 缓存友好路径下消息引用不变（前缀字节一致 → cache hit）。
 */

import { describe, it, expect } from "bun:test";
import type { Message } from "@sid-code/core/llm/types.ts";
import {
  isCompactableTool,
  createCachedMicrocompactState,
  resetCachedMicrocompactState,
  registerToolUses,
  createCacheEditsBlock,
  cachedMicrocompact,
} from "@sid-code/core/query/compact/cached-microcompact.ts";

/** 构造 N 轮（assistant tool_use + user tool_result）消息，工具结果内容很长 */
function buildToolMessages(count: number, toolName = "read", contentLen = 2000): Message[] {
  const messages: Message[] = [];
  for (let i = 0; i < count; i++) {
    messages.push({
      role: "assistant",
      content: [{ type: "tool_use", id: `t${i}`, name: toolName, input: { file: `f${i}.ts` } }],
    });
    messages.push({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: `t${i}`, content: "x".repeat(contentLen) }],
    });
  }
  return messages;
}

describe("isCompactableTool 工具判定（与 microcompact 单一事实源）", () => {
  it("包含可重新获取的只读类工具", () => {
    expect(isCompactableTool("read")).toBe(true);
    expect(isCompactableTool("bash")).toBe(true);
    expect(isCompactableTool("grep")).toBe(true);
  });

  it("回归：曾被旧白名单漏掉的 web/搜索类工具现在能命中", () => {
    // 旧 COMPACTABLE_TOOLS 裸字符串集合漏收这三个 → cache_edits 永远不删它们的结果
    expect(isCompactableTool("web_search")).toBe(true);
    expect(isCompactableTool("web_fetch")).toBe(true);
    expect(isCompactableTool("tool_search")).toBe(true);
  });

  it("回归：带下划线的真实注册名经归一化后命中", () => {
    // 旧白名单用裸 .has() 无归一化，read_many 等无法稳定命中
    expect(isCompactableTool("read_many")).toBe(true);
  });

  it("回归：不存在的 list / 不可丢弃工具不命中", () => {
    expect(isCompactableTool("list")).toBe(false); // sid 实际注册名是 ls，无 list
    expect(isCompactableTool("edit")).toBe(false);
    expect(isCompactableTool("write")).toBe(false);
  });
});

describe("状态机", () => {
  it("registerToolUses 建立 tool_use_id → toolName 映射", () => {
    const state = createCachedMicrocompactState();
    registerToolUses(state, buildToolMessages(3));
    expect(state.tools.size).toBe(3);
    expect(state.tools.get("t0")?.toolName).toBe("read");
  });

  it("reset 清空 tools 和 deleted", () => {
    const state = createCachedMicrocompactState();
    registerToolUses(state, buildToolMessages(2));
    state.deleted.add("t0");
    resetCachedMicrocompactState(state);
    expect(state.tools.size).toBe(0);
    expect(state.deleted.size).toBe(0);
  });
});

describe("createCacheEditsBlock", () => {
  it("为白名单内的旧大工具结果生成删除指令", () => {
    const state = createCachedMicrocompactState();
    const messages = buildToolMessages(10); // 20 条消息，cutoff = 20 - 6 = 14
    const block = createCacheEditsBlock(state, messages, {
      preserveRecentCount: 6,
      minContentLength: 500,
    });
    expect(block).not.toBeNull();
    expect(block!.edits.length).toBeGreaterThan(0);
    expect(block!.edits[0].type).toBe("delete");
  });

  it("保留最近 N 条不删除", () => {
    const state = createCachedMicrocompactState();
    const messages = buildToolMessages(10);
    const block = createCacheEditsBlock(state, messages, {
      preserveRecentCount: 6,
      minContentLength: 500,
    });
    // 最近 6 条消息（3 轮）的 tool_use_id 不应出现在删除列表
    const deletedIds = new Set(block!.edits.map((e) => e.tool_use_id));
    expect(deletedIds.has("t9")).toBe(false);
    expect(deletedIds.has("t8")).toBe(false);
    expect(deletedIds.has("t7")).toBe(false);
  });

  it("不在白名单的工具结果不删除", () => {
    const state = createCachedMicrocompactState();
    const messages = buildToolMessages(10, "edit"); // edit 不在白名单
    const block = createCacheEditsBlock(state, messages, {
      preserveRecentCount: 6,
      minContentLength: 500,
    });
    expect(block).toBeNull();
  });

  it("短内容工具结果不删除", () => {
    const state = createCachedMicrocompactState();
    const messages = buildToolMessages(10, "read", 100); // 内容 < 500
    const block = createCacheEditsBlock(state, messages, {
      preserveRecentCount: 6,
      minContentLength: 500,
    });
    expect(block).toBeNull();
  });

  it("同一 tool_use_id 不重复删除（跨调用）", () => {
    const state = createCachedMicrocompactState();
    const messages = buildToolMessages(10);
    const first = createCacheEditsBlock(state, messages, { preserveRecentCount: 6 });
    const firstCount = first!.edits.length;
    // 再次调用同一状态：已删除的不再出现
    const second = createCacheEditsBlock(state, messages, { preserveRecentCount: 6 });
    expect(second).toBeNull(); // 全部已删除过
    expect(state.deleted.size).toBe(firstCount);
  });

  it("消息过少时返回 null", () => {
    const state = createCachedMicrocompactState();
    const block = createCacheEditsBlock(state, buildToolMessages(2), { preserveRecentCount: 6 });
    expect(block).toBeNull();
  });
});

describe("cachedMicrocompact 路径选择", () => {
  it("Anthropic + 缓存温热 → 缓存友好路径，消息引用不变", () => {
    const messages = buildToolMessages(10);
    const result = cachedMicrocompact(messages, { providerName: "anthropic", cacheWarm: true });
    expect(result.path).toBe("cache-preserving");
    expect(result.messages).toBe(messages); // 引用相同 → 前缀字节一致
    expect(result.compactedCount).toBe(0);
  });

  it("Anthropic + emitCacheEdits=true → 产出 cache_edits 块", () => {
    const messages = buildToolMessages(10);
    const result = cachedMicrocompact(messages, {
      providerName: "anthropic",
      cacheWarm: true,
      emitCacheEdits: true,
    });
    expect(result.path).toBe("cache-preserving");
    expect(result.pendingCacheEdits).not.toBeNull();
    expect(result.pendingCacheEdits!.edits.length).toBeGreaterThan(0);
  });

  it("Anthropic + emitCacheEdits=false(默认) → 不产出原始块但仍走缓存友好路径", () => {
    const messages = buildToolMessages(10);
    const result = cachedMicrocompact(messages, { providerName: "anthropic", cacheWarm: true });
    expect(result.path).toBe("cache-preserving");
    expect(result.pendingCacheEdits).toBeNull();
  });

  it("非 Anthropic → 直接清内容路径", () => {
    const messages = buildToolMessages(10);
    const result = cachedMicrocompact(messages, { providerName: "openai", cacheWarm: true });
    expect(result.path).toBe("direct-clear");
    expect(result.compactedCount).toBeGreaterThan(0);
    expect(result.pendingCacheEdits).toBeNull();
  });

  it("Anthropic + 缓存已冷 → 直接清内容路径", () => {
    const messages = buildToolMessages(10);
    const result = cachedMicrocompact(messages, { providerName: "anthropic", cacheWarm: false });
    expect(result.path).toBe("direct-clear");
    expect(result.compactedCount).toBeGreaterThan(0);
  });
});
