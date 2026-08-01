/**
 * normalizeStrictNulls 单元测试
 *
 * 配套 tests/llm/strict-wire-contract-reconciliation.test.ts：那个测全量工具的
 * 端到端契约对账（防漂移），这个测归一逻辑本身的边界（防语义误伤）。
 *
 * 最关键的两条边界，反了就会引入新缺陷：
 *   1. `.nullable()` / `.nullish()` 的 null 是**业务值**，绝不能吞
 *   2. `z.coerce.*` 会把 null 静默转成 0/""/false，所以判定"能否接受 null"
 *      必须走 schema 结构内省，不能用 safeParse(null) 试探
 */
import { describe, test, expect } from "bun:test";
import { z } from "zod/v4";
import { normalizeStrictNulls } from "../../src/tool/nullish-normalize.ts";

describe("normalizeStrictNulls", () => {
  describe("optional 字段的 null → 摘掉（等价于未提供）", () => {
    test("顶层 optional string", () => {
      const s = z.object({ a: z.string(), b: z.string().optional() });
      const out = normalizeStrictNulls(s, { a: "x", b: null }) as Record<string, unknown>;
      expect("b" in out).toBe(false);
      expect(s.safeParse(out).success).toBe(true);
    });

    test("optional array（hypothesis_register.supporting_evidence 形态）", () => {
      const s = z.object({
        statement: z.string(),
        supporting_evidence: z.array(z.object({ note: z.string() })).optional(),
      });
      const out = normalizeStrictNulls(s, { statement: "s", supporting_evidence: null });
      expect(s.safeParse(out).success).toBe(true);
    });

    test("optional enum / boolean / number 一并覆盖", () => {
      const s = z.object({
        mode: z.enum(["a", "b"]).optional(),
        flag: z.boolean().optional(),
        n: z.number().optional(),
      });
      const out = normalizeStrictNulls(s, { mode: null, flag: null, n: null });
      expect(out).toEqual({});
      expect(s.safeParse(out).success).toBe(true);
    });
  });

  describe("显式可空字段的 null → 保留（业务值，不得吞）", () => {
    test(".nullable() 保留 null", () => {
      const s = z.object({ a: z.string().nullable() });
      const out = normalizeStrictNulls(s, { a: null }) as Record<string, unknown>;
      expect("a" in out).toBe(true);
      expect(out.a).toBeNull();
    });

    test(".nullish() 保留 null（既 optional 又 nullable，nullable 优先）", () => {
      const s = z.object({ a: z.string().nullish() });
      const out = normalizeStrictNulls(s, { a: null }) as Record<string, unknown>;
      expect(out.a).toBeNull();
    });

    test(".nullable().optional() 顺序颠倒也保留", () => {
      const s = z.object({ a: z.string().nullable().optional() });
      const out = normalizeStrictNulls(s, { a: null }) as Record<string, unknown>;
      expect(out.a).toBeNull();
    });
  });

  describe("coerce 字段：必须在 coerce 之前摘掉 null（防语义反转）", () => {
    test("z.coerce.number().optional() 的 null 不得变成 0", () => {
      // 直接 safeParse(null) 会静默返回 0——这正是 grep.head_limit（"0 表示无限制"）
      // 被污染成"不限制输出"的根因。
      const raw = z.object({ head_limit: z.coerce.number().int().min(0).optional() });
      expect(raw.safeParse({ head_limit: null }).data).toEqual({ head_limit: 0 });

      const out = normalizeStrictNulls(raw, { head_limit: null });
      expect(out).toEqual({});
      expect(raw.safeParse(out).data).toEqual({});
    });

    test("grep 的多个 coerce 字段全部不被污染", () => {
      const s = z.object({
        pattern: z.string(),
        context: z.coerce.number().int().min(0).optional(),
        head_limit: z.coerce.number().int().min(0).optional(),
        offset: z.coerce.number().int().min(0).optional(),
      });
      const parsed = s.safeParse(normalizeStrictNulls(s, {
        pattern: "x", context: null, head_limit: null, offset: null,
      }));
      expect(parsed.success).toBe(true);
      expect(parsed.data).toEqual({ pattern: "x" });
    });
  });

  describe("递归深度与 toStrictJsonSchema 对齐", () => {
    test("嵌套 object 里的 optional 字段", () => {
      const s = z.object({
        outer: z.object({ keep: z.string(), drop: z.string().optional() }),
      });
      const out = normalizeStrictNulls(s, { outer: { keep: "k", drop: null } }) as any;
      expect("drop" in out.outer).toBe(false);
      expect(s.safeParse(out).success).toBe(true);
    });

    test("数组元素内的 optional 字段", () => {
      const s = z.object({
        items: z.array(z.object({ note: z.string(), source: z.string().optional() })),
      });
      const out = normalizeStrictNulls(s, {
        items: [{ note: "n1", source: null }, { note: "n2", source: "s" }],
      }) as any;
      expect("source" in out.items[0]).toBe(false);
      expect(out.items[1].source).toBe("s");
      expect(s.safeParse(out).success).toBe(true);
    });

    test("tuple 按位置递归", () => {
      const s = z.object({
        pair: z.tuple([z.object({ a: z.string().optional() }), z.string()]),
      });
      const out = normalizeStrictNulls(s, { pair: [{ a: null }, "x"] }) as any;
      expect("a" in out.pair[0]).toBe(false);
      expect(s.safeParse(out).success).toBe(true);
    });

    test("optional 包裹的嵌套 object 内部也递归", () => {
      const s = z.object({
        cfg: z.object({ x: z.string().optional() }).optional(),
      });
      const out = normalizeStrictNulls(s, { cfg: { x: null } }) as any;
      expect("x" in out.cfg).toBe(false);
      expect(s.safeParse(out).success).toBe(true);
    });
  });

  describe("不越权：只做归一，不做裁剪或改写", () => {
    test("非 null 值一律原样保留（含 falsy）", () => {
      const s = z.object({
        a: z.string().optional(),
        b: z.number().optional(),
        c: z.boolean().optional(),
      });
      const input = { a: "", b: 0, c: false };
      expect(normalizeStrictNulls(s, input)).toEqual(input);
    });

    test("schema 未声明的未识别字段保持原样（交给 zod 自己报错）", () => {
      const s = z.object({ a: z.string() });
      const out = normalizeStrictNulls(s, { a: "x", bogus: null }) as Record<string, unknown>;
      expect("bogus" in out).toBe(true);
      expect(out.bogus).toBeNull();
    });

    test("required 字段的 null 保留（必须让 zod 如实报错，不能掩盖）", () => {
      const s = z.object({ a: z.string() });
      const out = normalizeStrictNulls(s, { a: null }) as Record<string, unknown>;
      expect(out.a).toBeNull();
      expect(s.safeParse(out).success).toBe(false);
    });

    test("无改动时返回同一引用（便于调用方判断）", () => {
      const s = z.object({ a: z.string().optional() });
      const input = { a: "x" };
      expect(normalizeStrictNulls(s, input)).toBe(input);
    });

    test("不修改传入对象（纯函数）", () => {
      const s = z.object({ a: z.string().optional() });
      const input = { a: null };
      normalizeStrictNulls(s, input);
      expect(input.a).toBeNull();
    });
  });

  describe("健壮性：异常输入永不抛错", () => {
    test.each([
      ["null", null],
      ["undefined", undefined],
      ["字符串", "hi"],
      ["数字", 42],
      ["数组", [1, 2]],
    ])("input 为 %s 时原样返回", (_label, input) => {
      const s = z.object({ a: z.string().optional() });
      expect(() => normalizeStrictNulls(s, input)).not.toThrow();
      expect(normalizeStrictNulls(s, input)).toEqual(input as never);
    });

    test("schema 非 zod 对象时原样返回", () => {
      const input = { a: null };
      expect(normalizeStrictNulls({}, input)).toBe(input);
      expect(normalizeStrictNulls(null, input)).toBe(input);
    });

    test("z.lazy 自引用不死循环", () => {
      type Node = { name: string; child?: Node | null };
      const nodeSchema: z.ZodType<Node> = z.lazy(() =>
        z.object({ name: z.string(), child: nodeSchema.optional() }),
      );
      const s = z.object({ root: nodeSchema });
      expect(() =>
        normalizeStrictNulls(s, { root: { name: "a", child: null } }),
      ).not.toThrow();
    });
  });
});
