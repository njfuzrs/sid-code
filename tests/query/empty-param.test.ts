/**
 * F1：空参数 tool_use 退化检测与修复 — 单元测试
 *
 * 覆盖纯函数：isEmptyToolInput / detectEmptyParamToolUses /
 * replaceEmptyParamToolUses / buildEmptyParamRetryMessage。
 *
 * 控制流场景（end_turn+空参 → 重试、end_turn+非空 → 执行、重试耗尽 → 放行）
 * 由这些纯函数 + loop.ts 的编排共同保证；纯函数层在此锁定行为契约。
 */

import { describe, it, expect } from "bun:test";
import {
  MAX_EMPTY_PARAM_RETRIES,
  isEmptyToolInput,
  detectEmptyParamToolUses,
  replaceEmptyParamToolUses,
  buildEmptyParamRetryMessage,
} from "../../src/query/empty-param.ts";
import type { ContentBlock } from "../../src/llm/types.ts";

describe("empty-param — isEmptyToolInput", () => {
  it("空对象 {} → 空（DeepSeek 退化精确特征）", () => {
    expect(isEmptyToolInput({})).toBe(true);
  });

  it("null / undefined → 空", () => {
    expect(isEmptyToolInput(null)).toBe(true);
    expect(isEmptyToolInput(undefined)).toBe(true);
  });

  it("空数组 → 空", () => {
    expect(isEmptyToolInput([])).toBe(true);
  });

  it("含字段的对象 → 非空", () => {
    expect(isEmptyToolInput({ file_path: "a.ts", content: "x" })).toBe(false);
  });

  it("非对象（字符串/数字）→ 非空（不在兜底范围，交工具校验）", () => {
    expect(isEmptyToolInput("foo")).toBe(false);
    expect(isEmptyToolInput(123)).toBe(false);
  });
});

describe("empty-param — detectEmptyParamToolUses", () => {
  it("识别空参数 tool_use，返回 id/name/index", () => {
    const content: ContentBlock[] = [
      { type: "text", text: "开始写文档" },
      { type: "tool_use", id: "t1", name: "write", input: {} },
    ];
    const hits = detectEmptyParamToolUses(content);
    expect(hits.length).toBe(1);
    expect(hits[0]).toEqual({ id: "t1", name: "write", index: 1 });
  });

  it("非空参数 tool_use 不命中", () => {
    const content: ContentBlock[] = [
      { type: "tool_use", id: "t1", name: "read", input: { file_path: "a.ts" } },
    ];
    expect(detectEmptyParamToolUses(content)).toEqual([]);
  });

  it("混合场景：只命中空参数那一个", () => {
    const content: ContentBlock[] = [
      { type: "tool_use", id: "t1", name: "grep", input: { pattern: "x" } },
      { type: "tool_use", id: "t2", name: "write", input: {} },
    ];
    const hits = detectEmptyParamToolUses(content);
    expect(hits.length).toBe(1);
    expect(hits[0].id).toBe("t2");
  });

  it("纯文本（正常结束）→ 无命中", () => {
    const content: ContentBlock[] = [{ type: "text", text: "任务完成" }];
    expect(detectEmptyParamToolUses(content)).toEqual([]);
  });
});

describe("empty-param — replaceEmptyParamToolUses", () => {
  it("空参数 tool_use 替换为 text（消除孤儿）", () => {
    const content: ContentBlock[] = [
      { type: "tool_use", id: "t1", name: "write", input: {} },
    ];
    const out = replaceEmptyParamToolUses(content);
    expect(out[0].type).toBe("text");
    expect(out[0].type === "text" && out[0].text).toContain("write");
    expect(out[0].type === "text" && out[0].text).toContain("参数为空");
    // 替换后不含任何 tool_use → 不需要 tool_result 配对
    expect(out.some((b) => b.type === "tool_use")).toBe(false);
  });

  it("混合场景：非空 tool_use 原样保留，仅替换空参数", () => {
    const content: ContentBlock[] = [
      { type: "tool_use", id: "t1", name: "grep", input: { pattern: "x" } },
      { type: "tool_use", id: "t2", name: "write", input: {} },
    ];
    const out = replaceEmptyParamToolUses(content);
    // 非空 grep 保留
    expect(out[0].type).toBe("tool_use");
    expect(out[0].type === "tool_use" && out[0].id).toBe("t1");
    // 空参 write 被替换
    expect(out[1].type).toBe("text");
  });

  it("不修改入参（返回新数组）", () => {
    const content: ContentBlock[] = [
      { type: "tool_use", id: "t1", name: "write", input: {} },
    ];
    replaceEmptyParamToolUses(content);
    expect(content[0].type).toBe("tool_use");
  });

  it("text/thinking 块原样保留", () => {
    const content: ContentBlock[] = [
      { type: "thinking", thinking: "规划文档结构" },
      { type: "text", text: "开始写" },
      { type: "tool_use", id: "t1", name: "write", input: {} },
    ];
    const out = replaceEmptyParamToolUses(content);
    expect(out[0].type).toBe("thinking");
    expect(out[1].type).toBe("text");
    expect(out[1].type === "text" && out[1].text).toBe("开始写");
    expect(out[2].type).toBe("text");
  });
});

describe("empty-param — buildEmptyParamRetryMessage", () => {
  const hits = [{ id: "t1", name: "write", index: 1 }];

  it("含工具名 + 重试计数 + 完整参数要求 + system-reminder 包裹", () => {
    const msg = buildEmptyParamRetryMessage(hits, 1, MAX_EMPTY_PARAM_RETRIES, false);
    expect(msg).toContain("<system-reminder>");
    expect(msg).toContain("</system-reminder>");
    expect(msg).toContain("write");
    expect(msg).toContain(`1/${MAX_EMPTY_PARAM_RETRIES}`);
    expect(msg).toContain("file_path");
  });

  it("已压缩时包含精简上下文措辞", () => {
    const msg = buildEmptyParamRetryMessage(hits, 2, MAX_EMPTY_PARAM_RETRIES, true);
    expect(msg).toContain("精简");
  });

  it("未压缩时不含精简措辞", () => {
    const msg = buildEmptyParamRetryMessage(hits, 1, MAX_EMPTY_PARAM_RETRIES, false);
    expect(msg).not.toContain("精简");
  });
});

describe("empty-param — 常量", () => {
  it("MAX_EMPTY_PARAM_RETRIES = 3（防无限循环）", () => {
    expect(MAX_EMPTY_PARAM_RETRIES).toBe(3);
  });
});
