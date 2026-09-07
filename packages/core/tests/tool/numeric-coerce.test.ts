/**
 * normalizeNumericStrings 单元测试
 *
 * 覆盖三组判据（对应 numeric-coerce.ts 顶部注释的风险面）：
 * 1. **真实轨迹样本必须被修好**——三条 offset 字符串取自
 *    `~/.sid-code/trajectories/sessions` 实测，是本模块存在的唯一理由。
 * 2. **危险值必须原样放回**（`""`/`true`/`[]`/`"abc"`）——转换它们等于替模型
 *    编一个值，就变成了 `z.coerce.*` 那种静默污染。
 * 3. **string 字段必须不受影响**——read 的 `pages:"2,4,7"` 本来合法，
 *    无脑转换会把合法调用改成非法的（修 A 造出 B）。
 */

import { describe, test, expect } from "bun:test";
import { z } from "zod/v4";
import { normalizeNumericStrings } from "@sid-code/core/tool/numeric-coerce.ts";
import { validateToolInput } from "@sid-code/core/tool/input-validator.ts";
import type { LegacyTool } from "@sid-code/core/tool/types.ts";

/** read 工具的真实 schema 形状（offset/limit 是 number，pages 是 string） */
const readLike = z.object({
  file_path: z.string(),
  offset: z.number().optional(),
  limit: z.number().optional(),
  pages: z.string().optional(),
});

describe("normalizeNumericStrings", () => {
  describe("实测轨迹样本：三条真实失败必须被修好", () => {
    // 证据来源：20260907-163824-da9094a7（offset:"117, 130" / "334, 360"）
    //          20260903-152752-56491335（offset:"1,1"）
    // 两会话均为 claude-sonnet-5，全部命中 read.offset。
    test.each([
      ['"117, 130" → 117（区间取起点）', "117, 130", 117],
      ['"334, 360" → 334', "334, 360", 334],
      ['"1,1" → 1', "1,1", 1],
    ])("%s", (_name, raw, expected) => {
      const out = normalizeNumericStrings(readLike, { file_path: "/a", offset: raw }) as {
        offset: unknown;
      };
      expect(out.offset).toBe(expected);
      // 归一后必须真的能过 zod——只转不通过等于没修
      expect(readLike.safeParse(out).success).toBe(true);
    });
  });

  describe("接受：能无损还原模型意图的形态", () => {
    test.each([
      ["纯数字串", "117", 117],
      ["前后空白", "  117  ", 117],
      ["负数", "-3", -3],
      ["小数", "1.5", 1.5],
      ["科学计数", "1e3", 1000],
      ["连字符区间取起点", "117-130", 117],
      ["全角逗号区间", "117，130", 117],
    ])("%s: %p → %p", (_name, raw, expected) => {
      const out = normalizeNumericStrings(readLike, { file_path: "/a", offset: raw }) as {
        offset: unknown;
      };
      expect(out.offset).toBe(expected);
    });
  });

  describe("拒绝：不含「模型想要哪个数」信息的值，一律原样放回让 zod 报错", () => {
    // 这一组是本模块与 z.coerce.number() 的分界线：coerce 会把 ""/null/[]/true
    // 静默变成 0/0/0/1，本模块必须不这么做（见 nullish-normalize.ts 记录的污染）。
    test.each([
      ["空串", ""],
      ["纯空白", "   "],
      ["非数字", "abc"],
      ["半截垃圾（不是区间）", "117, abc"],
      ["十六进制", "0x1f"],
      ["Infinity 字面量", "Infinity"],
      ["NaN 字面量", "NaN"],
      ["布尔", true],
      ["空数组", []],
      ["空对象", {}],
    ])("%s: %p 原样放回", (_name, raw) => {
      const input = { file_path: "/a", offset: raw };
      const out = normalizeNumericStrings(readLike, input) as { offset: unknown };
      expect(out.offset).toEqual(raw as never);
      // 且必须仍然被 zod 拒绝——模型下一轮自己补对的值
      expect(readLike.safeParse(out).success).toBe(false);
    });

    test("z.coerce.number() 会把这些值污染成 0/1，本模块刻意不这么做（对照自证）", () => {
      // 这条不是测我们的代码，是把「为什么不用 coerce」钉成可执行断言：
      // 哪天有人把 read.offset 改成 z.coerce.number()，这条会提醒他代价是什么。
      const coerced = z.coerce.number();
      expect(coerced.safeParse("")).toMatchObject({ success: true, data: 0 });
      expect(coerced.safeParse(true)).toMatchObject({ success: true, data: 1 });
      expect(coerced.safeParse([])).toMatchObject({ success: true, data: 0 });
      // 而它恰恰修不了实际发生的那一例
      expect(coerced.safeParse("117, 130").success).toBe(false);
    });
  });

  describe("string 字段不受影响（修 A 不能造出 B）", () => {
    test.each([
      ["单页", "3"],
      ["多页逗号", "2,4,7"],
      ["页区间", "1-5"],
    ])("pages=%p 保持字符串且仍然合法", (_name, raw) => {
      const input = { file_path: "/a", pages: raw };
      const out = normalizeNumericStrings(readLike, input) as { pages: unknown };
      expect(out.pages).toBe(raw);
      expect(typeof out.pages).toBe("string");
      expect(readLike.safeParse(out).success).toBe(true);
    });

    test("file_path 是 string：数字形态的路径不被转成 number", () => {
      const out = normalizeNumericStrings(readLike, { file_path: "123" }) as {
        file_path: unknown;
      };
      expect(out.file_path).toBe("123");
    });
  });

  describe("包装层与嵌套结构", () => {
    test("default / nullable / int 包装下同样生效", () => {
      const s = z.object({
        a: z.number().default(1),
        b: z.number().nullable(),
        c: z.number().int().min(0).optional(),
      });
      const out = normalizeNumericStrings(s, { a: "5", b: "6", c: "7" }) as Record<string, unknown>;
      expect(out).toEqual({ a: 5, b: 6, c: 7 });
      expect(s.safeParse(out).success).toBe(true);
    });

    test("nullable 字段的 null 不被本模块碰（归 nullish-normalize 管）", () => {
      const s = z.object({ a: z.number().nullable() });
      const out = normalizeNumericStrings(s, { a: null }) as Record<string, unknown>;
      expect(out.a).toBeNull();
    });

    test("嵌套 object 递归归一", () => {
      const s = z.object({ cfg: z.object({ n: z.number().optional() }).optional() });
      const out = normalizeNumericStrings(s, { cfg: { n: "42" } }) as {
        cfg: { n: unknown };
      };
      expect(out.cfg.n).toBe(42);
    });

    test("array 元素递归归一", () => {
      const s = z.object({ xs: z.array(z.number()) });
      const out = normalizeNumericStrings(s, { xs: ["1", 2, "3"] }) as { xs: unknown[] };
      expect(out.xs).toEqual([1, 2, 3]);
    });

    test("tuple 按位置归一（number 位转，string 位不转）", () => {
      const s = z.object({ pair: z.tuple([z.number(), z.string()]) });
      const out = normalizeNumericStrings(s, { pair: ["1", "2"] }) as { pair: unknown[] };
      expect(out.pair).toEqual([1, "2"]);
    });

    test("union 不下钻：无法确定模型走哪个分支，不替它改", () => {
      const s = z.object({ a: z.union([z.number(), z.string()]) });
      const input = { a: "117" };
      // 原样返回同一引用（未发生归一）
      expect(normalizeNumericStrings(s, input)).toBe(input);
    });
  });

  describe("永不成为新的失败源", () => {
    test("未识别字段原样保留，交给 zod 报 unrecognized_keys", () => {
      const out = normalizeNumericStrings(readLike, {
        file_path: "/a",
        bogus: "1",
      }) as Record<string, unknown>;
      expect(out.bogus).toBe("1");
    });

    test("schema 非法 / input 非对象：原样返回同一引用", () => {
      expect(normalizeNumericStrings({}, { a: 1 })).toEqual({ a: 1 });
      expect(normalizeNumericStrings(null, { a: 1 })).toEqual({ a: 1 });
      const arr = [1, 2];
      expect(normalizeNumericStrings(readLike, arr)).toBe(arr);
      expect(normalizeNumericStrings(readLike, null)).toBeNull();
    });

    test("无改动时返回同一引用（纯函数，不做无意义拷贝）", () => {
      const input = { file_path: "/a", offset: 117 };
      expect(normalizeNumericStrings(readLike, input)).toBe(input);
    });

    test("不修改传入的 input（无副作用）", () => {
      const input = { file_path: "/a", offset: "117" };
      normalizeNumericStrings(readLike, input);
      expect(input.offset).toBe("117");
    });

    test("自引用 lazy schema 不无限递归", () => {
      const node: z.ZodTypeAny = z.lazy(() =>
        z.object({ n: z.number().optional(), child: node.optional() }),
      );
      const s = z.object({ root: node });
      expect(() =>
        normalizeNumericStrings(s, { root: { n: "1", child: { n: "2" } } }),
      ).not.toThrow();
    });
  });
});

/** 构造一个只带 zodSchema 的最小工具，用于走真实 validateToolInput 入口 */
function fakeTool(name: string, schema: z.ZodTypeAny): LegacyTool {
  return {
    name: () => name,
    description: () => "",
    inputSchema: () => ({}),
    zodSchema: schema,
    execute: async () => ({ success: true, output: "" }),
  } as unknown as LegacyTool;
}

describe("validateToolInput 端到端：轨迹里的失败入参现在能通过", () => {
  // 这一组的意义：上面测的是纯函数，这里证明它**真的接进了生产校验路径**。
  // 只测纯函数会漏掉「模块写好了但没接线」这种零报错的失效形态。
  const tool = fakeTool("read", readLike);

  test.each([
    ["117, 130", 117],
    ["334, 360", 334],
    ["1,1", 1],
  ])('read offset="%s" 不再报参数校验失败，归一为 %p', (raw, expected) => {
    const r = validateToolInput(tool, { file_path: "/a", offset: raw });
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.data as { offset: number }).offset).toBe(expected);
  });

  test("修复前的形态确实会失败（变异自证：去掉归一这条就该红）", () => {
    // 直接对 schema safeParse（绕过 validateToolInput 的归一），证明
    // 「不归一就是失败」——所以上面三条通过不是因为 schema 本来就接受字符串。
    expect(readLike.safeParse({ file_path: "/a", offset: "117, 130" }).success).toBe(false);
  });

  test("不可归一的值仍然被拦，且错误消息报出真实类型而非 unknown", () => {
    const r = validateToolInput(tool, { file_path: "/a", offset: "abc" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain("offset");
      // 关键：不能是「实际收到 unknown」——那句话对模型零信息量
      expect(r.message).toContain("实际收到 string");
      expect(r.message).not.toContain("实际收到 unknown");
    }
  });
});
