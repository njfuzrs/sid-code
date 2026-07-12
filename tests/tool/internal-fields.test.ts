/**
 * GAP-08：防御性输入清理单元测试
 */

import { describe, test, expect } from "bun:test";
import { stripInternalFields, INTERNAL_FIELDS } from "../../src/tool/internal-fields.ts";

describe("stripInternalFields (GAP-08)", () => {
  test("剥离所有内部字段", () => {
    const input = {
      file_path: "/a/b.ts",
      _agentId: "sub-agent",
      _simulatedSedEdit: true,
      _hookInjected: { x: 1 },
    };
    const cleaned = stripInternalFields(input) as Record<string, unknown>;
    expect(cleaned.file_path).toBe("/a/b.ts");
    for (const field of INTERNAL_FIELDS) {
      expect(field in cleaned).toBe(false);
    }
  });

  test("不修改原对象（返回浅拷贝）", () => {
    const input = { _agentId: "x", keep: 1 };
    const cleaned = stripInternalFields(input) as Record<string, unknown>;
    expect((input as any)._agentId).toBe("x"); // 原对象不变
    expect("_agentId" in cleaned).toBe(false);
  });

  test("无内部字段时原样返回内容", () => {
    const input = { command: "ls", timeout: 5000 };
    const cleaned = stripInternalFields(input) as Record<string, unknown>;
    expect(cleaned).toEqual({ command: "ls", timeout: 5000 });
  });

  test("非对象输入原样返回", () => {
    expect(stripInternalFields(null)).toBe(null);
    expect(stripInternalFields("str")).toBe("str");
    expect(stripInternalFields(42)).toBe(42);
    const arr = [1, 2, 3];
    expect(stripInternalFields(arr)).toBe(arr);
  });
});
