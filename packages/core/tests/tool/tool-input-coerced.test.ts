/**
 * T3 第二步：参数归一两层（nullish / numeric）发 `ToolInputCoerced` 事件。
 *
 * 为什么这层要单独测：这两层此前都是**静默成功**的——模型传的 `null` / `"117"`
 * 被悄悄改成 `undefined` / `117`，轨迹上不留任何痕迹（剖析 5.3 ⑤）。没有事件，
 * 「哪一层在替模型擦屁股、哪个字段最常被归一」两个问题都答不了。
 *
 * 两道防线缺一不可：
 * - 取数口径：hits 的字段路径与次数准确、被拒绝的值不计数（不能夸大擦屁股次数）；
 * - 接线：`validateToolInput` 把 hits 真的发成事件（不接则生产上事件恒 0，
 *   这正是 EditFailureReminder 曾经的形态：4 条真实提醒、0 条事件）。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { z } from "zod/v4";
import { validateToolInput } from "@sid-code/core/tool/input-validator.ts";
import { normalizeNumericStrings } from "@sid-code/core/tool/numeric-coerce.ts";
import { normalizeStrictNulls } from "@sid-code/core/tool/nullish-normalize.ts";
import { ReadTool } from "@sid-code/core/tool/read.ts";
import { TaskCreateTool } from "@sid-code/core/tool/structured-task-create.ts";
import { initStreamObserver, resetStreamObserver } from "@sid-code/core/trace/stream-observer.ts";
import type { LegacyTool } from "@sid-code/core/tool/types.ts";

let events: Array<{ event: string; data: Record<string, unknown> }> = [];

beforeEach(() => {
  events = [];
  initStreamObserver("test-session", "/tmp", (e) => events.push(e));
});

afterEach(() => {
  resetStreamObserver();
});

/** 本次调用写出的 ToolInputCoerced 事件（按写入顺序） */
function coercedEvents(): Array<Record<string, unknown>> {
  return events.filter((e) => e.event === "ToolInputCoerced").map((e) => e.data);
}

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

describe("hits 取数口径：字段路径与次数（纯函数）", () => {
  test("numeric：顶层字段命中一次", () => {
    const s = z.object({ offset: z.number().optional() });
    expect(normalizeNumericStrings(s, { offset: "117" }).hits).toEqual([
      { field: "offset", count: 1 },
    ]);
  });

  test("numeric：数组元素按 field[] 聚合，count 累加", () => {
    const s = z.object({ xs: z.array(z.number()) });
    expect(normalizeNumericStrings(s, { xs: ["1", 2, "3"] }).hits).toEqual([
      { field: "xs[]", count: 2 },
    ]);
  });

  test("numeric：嵌套 object 用 `.` 拼路径", () => {
    const s = z.object({ cfg: z.object({ n: z.number().optional() }) });
    expect(normalizeNumericStrings(s, { cfg: { n: "42" } }).hits).toEqual([
      { field: "cfg.n", count: 1 },
    ]);
  });

  test("numeric：被拒绝的值不计数（不能夸大擦屁股次数）", () => {
    const s = z.object({ offset: z.number().optional() });
    expect(normalizeNumericStrings(s, { offset: "abc" }).hits).toEqual([]);
  });

  test("nullish：optional 字段被摘掉时记路径", () => {
    const s = z.object({ pages: z.string().optional() });
    expect(normalizeStrictNulls(s, { pages: null }).hits).toEqual([{ field: "pages", count: 1 }]);
  });

  test("nullish：嵌套数组路径 + 多元素聚合", () => {
    const s = z.object({
      items: z.array(z.object({ note: z.string(), source: z.string().optional() })),
    });
    const hits = normalizeStrictNulls(s, {
      items: [
        { note: "a", source: null },
        { note: "b", source: null },
        { note: "c", source: "s" },
      ],
    }).hits;
    expect(hits).toEqual([{ field: "items[].source", count: 2 }]);
  });

  test("nullish：显式 nullable 的业务 null 不计数", () => {
    const s = z.object({ a: z.string().nullable() });
    expect(normalizeStrictNulls(s, { a: null }).hits).toEqual([]);
  });

  test("没有命中时返回同一引用（纯函数语义不变）", () => {
    const s = z.object({ a: z.string().optional() });
    const input = { a: "x" };
    expect(normalizeStrictNulls(s, input).value).toBe(input);
    const numericInput = { a: 1 };
    expect(normalizeNumericStrings(s, numericInput).value).toBe(numericInput);
  });
});

describe("validateToolInput 接线：hits 真的发成事件", () => {
  test('真实 read schema：offset="117, 130" → numeric 事件带 tool/layer/field/count', () => {
    const tool = new ReadTool() as unknown as LegacyTool;
    const v = validateToolInput(tool, { file_path: "/a", offset: "117, 130" });
    expect(v.ok).toBe(true);
    expect(coercedEvents()).toEqual([
      expect.objectContaining({ tool: "read", layer: "numeric", field: "offset", count: 1 }),
    ]);
  });

  test("真实 task_create schema：active_form=null → nullish 事件", () => {
    const tool = new TaskCreateTool() as unknown as LegacyTool;
    const v = validateToolInput(tool, { subject: "s", description: "d", active_form: null });
    expect(v.ok).toBe(true);
    expect(coercedEvents()).toEqual([
      expect.objectContaining({
        tool: "task_create",
        layer: "nullish",
        field: "active_form",
        count: 1,
      }),
    ]);
  });

  test("同一次调用两层都命中：nullish 先、numeric 后（执行顺序如实反映）", () => {
    const tool = fakeTool(
      "combo",
      z.object({ n: z.number().optional(), s: z.string().optional() }),
    );
    const v = validateToolInput(tool, { n: "117", s: null });
    expect(v.ok).toBe(true);
    expect(coercedEvents().map((e) => [e.layer, e.field])).toEqual([
      ["nullish", "s"],
      ["numeric", "n"],
    ]);
  });

  test("没有归一就不发事件（事件只在真的动手时出现）", () => {
    const tool = new ReadTool() as unknown as LegacyTool;
    const v = validateToolInput(tool, { file_path: "/a", offset: 117 });
    expect(v.ok).toBe(true);
    expect(coercedEvents()).toHaveLength(0);
  });

  test("事件只放能聚合的量：不记参数值", () => {
    const tool = fakeTool(
      "combo",
      z.object({ n: z.number().optional(), s: z.string().optional() }),
    );
    validateToolInput(tool, { n: "117", s: null });
    const emitted = coercedEvents();
    expect(emitted).toHaveLength(2);
    for (const e of emitted) {
      expect(Object.keys(e).sort()).toEqual(["count", "field", "layer", "tool"]);
    }
  });

  test("归一后仍校验失败时事件照发（归一动过就要看得见）", () => {
    const tool = fakeTool("need", z.object({ n: z.number(), s: z.string() }));
    const v = validateToolInput(tool, { n: "117" });
    expect(v.ok).toBe(false);
    expect(coercedEvents()).toEqual([
      expect.objectContaining({ tool: "need", layer: "numeric", field: "n", count: 1 }),
    ]);
  });

  test("无人监听时不发事件也不抛错（可观测性不影响正常流程）", () => {
    resetStreamObserver();
    const tool = fakeTool("n", z.object({ n: z.number() }));
    expect(() => validateToolInput(tool, { n: "117" })).not.toThrow();
  });
});
