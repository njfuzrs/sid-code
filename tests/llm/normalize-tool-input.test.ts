/**
 * normalizeToolInput 测试
 *
 * 回归重点（2026-07 迁移 skill 崩溃复盘）：模型写 .mcp.json 时正确地把 JSON 配置作为
 * **字符串** 放进 write.content，但旧版 normalizeToolInput 的"贪心解析"把任何以 { / [
 * 开头的字符串字段 JSON.parse 成对象，导致 write 工具的 content: z.string() 校验报
 * "期望 string，实际收到 object"。修复：RAW_STRING_FIELDS 白名单跳过这些原样字符串字段。
 */

import { describe, test, expect } from "bun:test";
import { normalizeToolInput } from "@sid-code/core/llm/normalize-tool-input.ts";

describe("normalizeToolInput", () => {
  describe("原样字符串字段白名单（不得被 JSON 解析破坏）", () => {
    test("write.content 是 JSON 字符串时保持字符串", () => {
      const input = {
        file_path: "/x/.mcp.json",
        content: '{"mcpServers":{"vibe-coding":{"transport":"http"}}}',
      };
      const out = normalizeToolInput(input) as any;
      expect(typeof out.content).toBe("string");
      expect(out.content).toBe(input.content);
    });

    test("write.content 是 JSON 数组字符串时保持字符串", () => {
      const input = { file_path: "/x/data.json", content: '[1,2,3]' };
      const out = normalizeToolInput(input) as any;
      expect(typeof out.content).toBe("string");
      expect(out.content).toBe("[1,2,3]");
    });

    test("edit.old_string / new_string 是 JSON 字符串时保持字符串", () => {
      const input = {
        file_path: "/x/a.ts",
        old_string: '{"a":1}',
        new_string: '{"a":2,"b":[3]}',
      };
      const out = normalizeToolInput(input) as any;
      expect(typeof out.old_string).toBe("string");
      expect(typeof out.new_string).toBe("string");
      expect(out.old_string).toBe('{"a":1}');
      expect(out.new_string).toBe('{"a":2,"b":[3]}');
    });

    test("notebook_edit.new_source 是 JSON 字符串时保持字符串", () => {
      const input = { notebook_path: "/x/n.ipynb", new_source: '{"cell":"code"}' };
      const out = normalizeToolInput(input) as any;
      expect(typeof out.new_source).toBe("string");
      expect(out.new_source).toBe('{"cell":"code"}');
    });
  });

  describe("非白名单字段保留原有的贪心解析行为（对齐 CC normalizeContentFromAPI）", () => {
    test("普通字段的字符串化 JSON 对象被解析为对象", () => {
      const input = { todos: '[{"content":"x","status":"pending"}]' };
      const out = normalizeToolInput(input) as any;
      expect(Array.isArray(out.todos)).toBe(true);
      expect(out.todos[0].content).toBe("x");
    });

    test("非 JSON 的普通字符串保持原值", () => {
      const input = { query: "hello world", count: 3 };
      const out = normalizeToolInput(input) as any;
      expect(out.query).toBe("hello world");
      expect(out.count).toBe(3);
    });

    test("坏 JSON 字符串（解析失败）保持原值", () => {
      const input = { data: "{not valid json" };
      const out = normalizeToolInput(input) as any;
      expect(out.data).toBe("{not valid json");
    });
  });

  describe("边界", () => {
    test("非对象输入原样返回", () => {
      expect(normalizeToolInput("str")).toBe("str");
      expect(normalizeToolInput(42)).toBe(42);
      expect(normalizeToolInput(null)).toBe(null);
    });

    test("数组递归处理", () => {
      const out = normalizeToolInput([{ content: '{"a":1}' }, { todos: '[1]' }]) as any[];
      // content 属白名单，保持字符串；todos 非白名单，解析为数组
      expect(typeof out[0].content).toBe("string");
      expect(Array.isArray(out[1].todos)).toBe(true);
    });
  });
});
