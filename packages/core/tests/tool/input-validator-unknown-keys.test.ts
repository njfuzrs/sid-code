/**
 * T2（D1）：未声明的顶层键不再静默剥离。
 *
 * 背景：zod v4 的 `z.object()` 默认对未知键**静默剥离**——`safeParse` 成功、`data` 里
 * 没有它、也不报 `unrecognized_keys`。于是「传了但被丢了」与「根本没传」在结果上完全
 * 一样。30 天轨迹里带未知键的调用 170 次，其中 47 次（`-C` / `-i` / `-A`）真的丢了意图：
 * 模型按 CC 的写法带了上下文行参数，拿到的是没有上下文行的结果，而且没有任何信号。
 *
 * 修法刻意**不报错**（见 input-validator.ts 的 buildUnknownKeysNotice 注释）：报错会让
 * `-n` 这类「丢了也不影响结果」的调用白花一轮往返，还会把 is_error 率抬成假信号。
 * 这里钉住四件事：
 * 1. 取数口径：哪些键算「未声明」（含 passthrough / record / union / 内部字段的边界）；
 * 2. 区分来源：模型传的进提示，hook 注入的只发事件；
 * 3. 已知无影响键（grep 的 `-n`）只发事件、不提示；
 * 4. 事件真的发了，且只带键名不带值。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { z } from "zod/v4";
import {
  buildUnknownKeysNotice,
  declaredTopLevelKeys,
  findUnknownTopLevelKeys,
  validateToolInput,
} from "@sid-code/core/tool/input-validator.ts";
import { IGNORABLE_UNKNOWN_KEYS } from "@sid-code/core/tool/input-alias.ts";
import { ReadTool } from "@sid-code/core/tool/read.ts";
import { GrepTool } from "@sid-code/core/tool/grep.ts";
import { SubAgentTool } from "@sid-code/core/agent/tool.ts";
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

/** 本次调用写出的 ToolInputUnknownKeys 事件 */
function unknownKeyEvents(): Array<Record<string, unknown>> {
  return events.filter((e) => e.event === "ToolInputUnknownKeys").map((e) => e.data);
}

/** 构造一个只带 zodSchema 的最小工具，用于走真实 validateToolInput 入口 */
function fakeTool(name: string, schema: z.ZodTypeAny): LegacyTool {
  return {
    name: () => name,
    description: () => "",
    inputSchema: () => ({}),
    zodSchema: schema,
    execute: async () => ({ output: "" }),
  } as unknown as LegacyTool;
}

// ─── 取数口径：findUnknownTopLevelKeys（纯函数） ─────────────

describe("findUnknownTopLevelKeys — 哪些键算「未声明」", () => {
  test("顶层未声明的键被找出，已声明的键不动", () => {
    const s = z.object({ file_path: z.string(), offset: z.number().optional() });
    expect(findUnknownTopLevelKeys(s, { file_path: "/a", bogus: 1, lines: "1-20" })).toEqual([
      "bogus",
      "lines",
    ]);
  });

  test("`_` 开头的内部字段不算未知键（stripInternalFields 的职责，不混进提示）", () => {
    const s = z.object({ file_path: z.string() });
    expect(findUnknownTopLevelKeys(s, { file_path: "/a", _agentId: "x", bogus: 1 })).toEqual([
      "bogus",
    ]);
  });

  test("passthrough 不报：未知键会被 zod 保留，说「已被忽略」是假信息", () => {
    const s = z.object({ query: z.string() }).passthrough();
    expect(findUnknownTopLevelKeys(s, { query: "x", extra: 1 })).toEqual([]);
  });

  test("record / union 不报（没有顶层 shape，语义由子 schema 决定）", () => {
    expect(findUnknownTopLevelKeys(z.record(z.string(), z.number()), { anything: 1 })).toEqual([]);
    expect(
      findUnknownTopLevelKeys(z.union([z.object({ a: z.string() }), z.object({ b: z.string() })]), {
        a: "x",
        bogus: 1,
      }),
    ).toEqual([]);
  });

  test("z.lazy 包装能展开（工具 schema 的循环引用场景）", () => {
    const s = z.lazy(() => z.object({ query: z.string() }));
    expect(findUnknownTopLevelKeys(s, { query: "x", bogus: 1 })).toEqual(["bogus"]);
  });

  test("非对象输入返回空（不抛错——这一层永不成为新的失败源）", () => {
    const s = z.object({ a: z.string() });
    for (const input of [null, undefined, 42, "str", [1, 2]]) {
      expect(findUnknownTopLevelKeys(s, input)).toEqual([]);
    }
  });

  test("schema 本身不是 object 时返回空", () => {
    expect(findUnknownTopLevelKeys(z.string(), { a: 1 })).toEqual([]);
  });

  test("原型链上的同名键不算已声明（用 hasOwn，不用 in）", () => {
    const s = z.object({ a: z.string() });
    expect(findUnknownTopLevelKeys(s, { a: "x", toString: 1 })).toEqual(["toString"]);
  });
});

describe("declaredTopLevelKeys — 提示里列出的参数名", () => {
  test("顶层 object 返回声明的键", () => {
    const s = z.object({ query: z.string(), limit: z.number().optional() });
    expect(declaredTopLevelKeys(s)).toEqual(["query", "limit"]);
  });

  test("record / union 返回空（提示里不硬编参数名）", () => {
    expect(declaredTopLevelKeys(z.record(z.string(), z.number()))).toEqual([]);
    expect(declaredTopLevelKeys(z.union([z.object({ a: z.string() })]))).toEqual([]);
  });
});

// ─── 校验入口：ignoredKeys 与 modelKeys 的语义 ──────────────

describe("validateToolInput — ignoredKeys", () => {
  test("read 传错参数名：ok:true、ignoredKeys 点名该键（不报错）", () => {
    const tool = new ReadTool() as unknown as LegacyTool;
    const v = validateToolInput(tool, { file_path: "/a", bogus: 1 });
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.ignoredKeys).toEqual(["bogus"]);
  });

  test("没有未知键时 ignoredKeys 字段不出现（成功路径形状不变）", () => {
    const tool = new ReadTool() as unknown as LegacyTool;
    const v = validateToolInput(tool, { file_path: "/a" });
    expect(v.ok).toBe(true);
    if (v.ok) expect("ignoredKeys" in v).toBe(false);
  });

  test("grep 的 -n 进「已知无影响键」名单：ignoredKeys 为空，事件 silenced 里留痕", () => {
    const tool = new GrepTool() as unknown as LegacyTool;
    const v = validateToolInput(tool, { pattern: "x", "-n": true });
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.ignoredKeys).toBeUndefined();
    // 静默行为必须在轨迹上有存在形式：键进了 keys 与 silenced
    expect(unknownKeyEvents()).toEqual([
      expect.objectContaining({ tool: "grep", keys: ["-n"], source: "model", silenced: ["-n"] }),
    ]);
  });

  test("真的未知键同时进 keys 与提示（silenced 为空）", () => {
    const tool = new GrepTool() as unknown as LegacyTool;
    const v = validateToolInput(tool, { pattern: "x", glob_ignore: "a" });
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.ignoredKeys).toEqual(["glob_ignore"]);
    expect(unknownKeyEvents()).toEqual([
      expect.objectContaining({
        tool: "grep",
        keys: ["glob_ignore"],
        source: "model",
        silenced: [],
      }),
    ]);
  });

  test("modelKeys 不含该键 → 视为 hook 注入：不提示模型，事件 source=hook", () => {
    const tool = new ReadTool() as unknown as LegacyTool;
    const v = validateToolInput(
      tool,
      { file_path: "/a", bogus: 1 },
      { modelKeys: new Set(["file_path"]) },
    );
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.ignoredKeys).toBeUndefined();
    expect(unknownKeyEvents()).toEqual([
      expect.objectContaining({ tool: "read", keys: ["bogus"], source: "hook" }),
    ]);
  });

  test("模型键与 hook 键混在一起：只提示前者，两条事件分开", () => {
    const tool = new ReadTool() as unknown as LegacyTool;
    const v = validateToolInput(
      tool,
      { file_path: "/a", bogus: 1, hook_field: 2 },
      { modelKeys: new Set(["file_path", "bogus"]) },
    );
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.ignoredKeys).toEqual(["bogus"]);
    expect(unknownKeyEvents().map((e) => [e.source, e.keys])).toEqual([
      ["model", ["bogus"]],
      ["hook", ["hook_field"]],
    ]);
  });

  test("内部字段不进提示，也不发事件（stripInternalFields 管它）", () => {
    const tool = new ReadTool() as unknown as LegacyTool;
    const v = validateToolInput(tool, { file_path: "/a", _agentId: "x" });
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.ignoredKeys).toBeUndefined();
    expect(unknownKeyEvents()).toEqual([]);
  });

  test("别名层的改名不算未知键（subagent_type → type）", () => {
    const tool = new SubAgentTool({} as any, {} as any) as unknown as LegacyTool;
    const v = validateToolInput(tool, { description: "d", prompt: "p", subagent_type: "explore" });
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.ignoredKeys).toBeUndefined();
  });

  test("T1 的 CC 短参数别名接住后不产生未知键（-C → context，字符串数字照常归一）", () => {
    // 未知键检测放在三层归一**之后**，正是为了这个场景：`-C` 先被别名层改成 `context`，
    // 再被 numeric-coerce 转成数字，全程不该出现在 ToolInputUnknownKeys 里。
    const tool = new GrepTool() as unknown as LegacyTool;
    const v = validateToolInput(tool, { pattern: "x", "-C": "3" });
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.ignoredKeys).toBeUndefined();
      expect((v.data as { context?: number }).context).toBe(3);
    }
    expect(unknownKeyEvents()).toEqual([]);
  });

  test("校验失败时事件照发（度量口径覆盖全部调用）", () => {
    const tool = fakeTool("need", z.object({ n: z.number() }));
    const v = validateToolInput(tool, { n: "abc", bogus: 1 });
    expect(v.ok).toBe(false);
    expect(unknownKeyEvents()).toEqual([
      expect.objectContaining({ tool: "need", keys: ["bogus"], source: "model" }),
    ]);
  });

  test("工具没有 zodSchema 时早退，不算未知键也不发事件", () => {
    const tool = {
      name: () => "no-schema",
      description: () => "",
      inputSchema: () => ({}),
      execute: async () => ({ output: "" }),
    } as unknown as LegacyTool;
    const v = validateToolInput(tool, { anything: 1 });
    expect(v.ok).toBe(true);
    expect(unknownKeyEvents()).toEqual([]);
  });

  test("无人监听时不抛错（可观测性不影响正常流程）", () => {
    resetStreamObserver();
    const tool = new ReadTool() as unknown as LegacyTool;
    expect(() => validateToolInput(tool, { file_path: "/a", bogus: 1 })).not.toThrow();
  });
});

describe("事件只放能聚合的量", () => {
  test("字段恰好四个：tool / keys / source / silenced（不记值）", () => {
    const tool = new ReadTool() as unknown as LegacyTool;
    validateToolInput(tool, { file_path: "/secret/path", bogus: { nested: "value" } });
    const [e] = unknownKeyEvents();
    expect(Object.keys(e).sort()).toEqual(["keys", "silenced", "source", "tool"]);
    // 值不能出现在事件里：事件只记键名
    expect(JSON.stringify(e)).not.toContain("/secret/path");
    expect(JSON.stringify(e)).not.toContain("nested");
  });
});

// ─── 提示文案 ────────────────────────────────────────────

describe("buildUnknownKeysNotice — 模型可见的提示", () => {
  test("单键：点名键、工具与「已按其余参数执行」", () => {
    const notice = buildUnknownKeysNotice("read", ["bogus"], ["file_path", "offset", "limit"]);
    expect(notice).toContain("`bogus`");
    expect(notice).toContain("不是 read 的参数");
    expect(notice).toContain("已被忽略");
    expect(notice).toContain("read 的参数：file_path、offset、limit");
  });

  test("多键：顿号连接", () => {
    const notice = buildUnknownKeysNotice("grep", ["a", "b"], ["pattern"]);
    expect(notice).toContain("`a`、`b`");
  });

  test("参数列表超过 10 个时省略（长 schema 不把结果开头撑成噪音）", () => {
    const many = Array.from({ length: 14 }, (_, i) => `k${i}`);
    const notice = buildUnknownKeysNotice("tool", ["bogus"], many);
    expect(notice).toContain("k9、…");
    expect(notice).not.toContain("k10");
  });

  test("空未知键返回空串（调用方不用判空）", () => {
    expect(buildUnknownKeysNotice("read", [], ["file_path"])).toBe("");
  });

  test("没有声明参数时只提示键名（不输出空列表）", () => {
    const notice = buildUnknownKeysNotice("tool", ["bogus"], []);
    expect(notice).not.toContain("tool 的参数：");
  });
});

describe("「已知无影响键」名单的登记口径", () => {
  test("每条都带 tool / key / reason，且 reason 解释「丢了为什么不影响结果」", () => {
    expect(IGNORABLE_UNKNOWN_KEYS.length).toBeGreaterThan(0);
    for (const entry of IGNORABLE_UNKNOWN_KEYS) {
      expect(entry.tool).not.toBe("");
      expect(entry.key).not.toBe("");
      expect(entry.reason.length).toBeGreaterThan(10);
    }
  });

  test("不按模型名登记：条目只有 tool/key/reason 三个字段", () => {
    for (const entry of IGNORABLE_UNKNOWN_KEYS) {
      expect(Object.keys(entry).sort()).toEqual(["key", "reason", "tool"]);
    }
  });
});
