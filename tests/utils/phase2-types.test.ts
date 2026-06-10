/**
 * Phase 2 类型安全层单测
 * 覆盖：semantic-boolean / ids（Branded Types）
 */

import { describe, test, expect } from "bun:test";
import { z } from "zod";
import { semanticBoolean, coerceSemanticBoolean } from "../../src/utils/semantic-boolean.ts";
import { asSessionId, asAgentId, asToolCallId } from "../../src/types/ids.ts";

describe("semanticBoolean (Zod)", () => {
  const schema = semanticBoolean(z.boolean());

  test("字符串 'false' → false（规避 JS truthiness bug）", () => {
    expect(schema.parse("false")).toBe(false);
  });

  test("字符串 'true' → true", () => {
    expect(schema.parse("true")).toBe(true);
  });

  test("真布尔原样通过", () => {
    expect(schema.parse(true)).toBe(true);
    expect(schema.parse(false)).toBe(false);
  });

  test("非法值被 Zod 拒绝", () => {
    const r = schema.safeParse("maybe");
    expect(r.success).toBe(false);
  });

  test("可包裹 default", () => {
    const withDefault = semanticBoolean(z.boolean().default(false));
    expect(withDefault.parse(undefined)).toBe(false);
    expect(withDefault.parse("true")).toBe(true);
  });
});

describe("coerceSemanticBoolean (无 Zod 轻量版)", () => {
  test("字符串 'false' → false", () => {
    expect(coerceSemanticBoolean("false")).toBe(false);
  });
  test("字符串 'true' → true", () => {
    expect(coerceSemanticBoolean("true")).toBe(true);
  });
  test("真布尔原样", () => {
    expect(coerceSemanticBoolean(true)).toBe(true);
    expect(coerceSemanticBoolean(false)).toBe(false);
  });
  test("undefined/null 走默认值", () => {
    expect(coerceSemanticBoolean(undefined)).toBe(false);
    expect(coerceSemanticBoolean(null)).toBe(false);
    expect(coerceSemanticBoolean(undefined, true)).toBe(true);
  });
});

describe("Branded Types (ids)", () => {
  test("运行时是普通字符串", () => {
    const sid = asSessionId("sess-1");
    expect(typeof sid).toBe("string");
    expect(sid).toBe("sess-1" as unknown as typeof sid);
  });

  test("三种 brand 转换函数返回原值", () => {
    expect(asAgentId("a")).toBe("a" as unknown as ReturnType<typeof asAgentId>);
    expect(asToolCallId("t")).toBe("t" as unknown as ReturnType<typeof asToolCallId>);
  });

  // 编译期混淆防护无法在运行时测试，靠 tsc 验证。
  // 这里仅确保转换函数存在且行为正确。
});
