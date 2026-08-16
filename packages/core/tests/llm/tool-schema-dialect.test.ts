/**
 * 工具 schema 方言层的行为断言。
 *
 * ## 这份测试要挡的是什么
 *
 * 本层的三类失败模式，单测各自对应一组用例：
 *
 * 1. **该剥的没剥** —— `$schema` 漏在某条协议线上（三条线各有独立构造器，
 *    最容易出现「改了一条、忘了另两条」）。故有一组**跨三线**的对称性断言。
 * 2. **不该剥的剥了** —— 最危险的一类：Anthropic strict **支持** `default`
 *    而 OpenAI 未列入，一个「共用 sanitizer 顺手剥 default」的实现会白丢语义，
 *    且**不报错、无从发现**。故对每个族逐条断言「不该动的没动」。
 * 3. **族判定串味** —— 拿 A 族的裁剪规则套到 B 族上。故期望值按族**硬编码**在本文件里，
 *    不从 `getToolSchemaDialect()` 反推（那是同义反复，改错了两边一起变）。
 *
 * 期望值的依据全部来自 `dialect/tool-schema.md` 里记的厂商文档，不是从实现反推的。
 */

import { describe, test, expect } from "bun:test";
import {
  getToolSchemaDialect,
  sanitizeToolSchema,
  hasStrictIncompatibleNode,
} from "../../src/llm/dialect/tool-schema.ts";
import { buildResponsesRequest } from "../../src/llm/openai-responses-request.ts";
import type { SendParams, ToolDefinition } from "../../src/llm/types.ts";

const SCHEMA_URL = "https://json-schema.org/draft/2020-12/schema";

/** zod v4 的典型产物形态：顶层带 $schema、object 带 additionalProperties */
function zodLike(properties: Record<string, unknown>, required: string[] = []) {
  return {
    $schema: SCHEMA_URL,
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  } as Record<string, unknown>;
}

describe("元信息键剥离：所有族、strict 与非 strict 一律执行", () => {
  // 依据：五家厂商**没有任何一家**的文档承认接受 `$schema`（tool-schema.md §未验证项）。
  // 剥它的理由不是「某家会拒」，而是「它不是协议的一部分 + 实测 40 份 schema 白烧 ~570 token/轮」。
  const ALL_FAMILIES = [
    "openai-responses",
    "o-series",
    "anthropic-native",
    "deepseek-openai",
    "deepseek-anthropic",
    "glm-openai",
    "grok-openai",
    "unknown",
  ] as const;

  for (const family of ALL_FAMILIES) {
    test(`${family}：$schema 被剥掉（strict 与非 strict 均然）`, () => {
      const dialect = getToolSchemaDialect(family);
      const input = zodLike({ a: { type: "string" } }, ["a"]);

      for (const strict of [true, false]) {
        const r = sanitizeToolSchema(input, dialect, { strict });
        expect(r.schema.$schema, `${family} strict=${strict}`).toBeUndefined();
        expect(r.strippedKeywords).toContain("$schema");
        // 其余内容不得因剥离而丢失
        expect(r.schema.type).toBe("object");
        expect(r.schema.properties).toEqual({ a: { type: "string" } });
      }
    });
  }

  test("嵌套层里的 $schema 也剥（zod 的 $defs / 子 schema 可能各带一份）", () => {
    const dialect = getToolSchemaDialect("openai-responses");
    const input = {
      $schema: SCHEMA_URL,
      type: "object",
      properties: {
        nested: { $schema: SCHEMA_URL, type: "object", properties: { b: { type: "string" } } },
        arr: { type: "array", items: { $schema: SCHEMA_URL, type: "string" } },
      },
    } as Record<string, unknown>;

    const out = JSON.stringify(sanitizeToolSchema(input, dialect, { strict: false }).schema);
    expect(out).not.toContain("$schema");
    expect(out).not.toContain(SCHEMA_URL);
  });

  test("入参不被原地修改（registry 的 WeakMap 缓存值会被复用，改了就污染全局）", () => {
    const dialect = getToolSchemaDialect("anthropic-native");
    const input = zodLike({ n: { type: "integer", minimum: 0, maximum: 10 } }, ["n"]);
    const snapshot = JSON.stringify(input);

    sanitizeToolSchema(input, dialect, { strict: true });
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

describe("Anthropic 原生：按文档子集裁剪数值与长度约束", () => {
  // 依据 tool-schema.md §Anthropic：strict 子集**不含**全部数值约束
  // （minimum/maximum/multipleOf）与全部字符串长度约束（minLength/maxLength）。
  const dialect = getToolSchemaDialect("anthropic-native");

  test("数值约束被剥，且转写进 description（官方 SDK 的同一策略）", () => {
    const input = zodLike(
      { offset: { type: "integer", minimum: 0, maximum: 100, description: "起始行" } },
      ["offset"],
    );
    const r = sanitizeToolSchema(input, dialect, { strict: true });
    const offset = (r.schema.properties as Record<string, any>).offset;

    expect(offset.minimum).toBeUndefined();
    expect(offset.maximum).toBeUndefined();
    // 语义不丢：约束转写进描述，且**原描述仍是前缀**（不许覆盖工具作者写的东西）
    expect(offset.description).toStartWith("起始行");
    expect(offset.description).toContain("最小值: 0");
    expect(offset.description).toContain("最大值: 100");
    expect(r.strippedKeywords).toContain("minimum");
  });

  test("字符串长度约束同样被剥并转写", () => {
    const input = zodLike({ s: { type: "string", minLength: 1, maxLength: 5 } }, ["s"]);
    const s = (
      sanitizeToolSchema(input, dialect, { strict: true }).schema.properties as Record<string, any>
    ).s;

    expect(s.minLength).toBeUndefined();
    expect(s.maxLength).toBeUndefined();
    expect(s.description).toContain("最短长度: 1");
    expect(s.description).toContain("最长长度: 5");
  });

  test("zod `.int()` 的安全整数边界不转写描述（纯噪音，实测 grep 一个工具就有 7 对）", () => {
    const input = zodLike(
      {
        n: { type: "integer", minimum: -Number.MAX_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER },
      },
      ["n"],
    );
    const n = (
      sanitizeToolSchema(input, dialect, { strict: true }).schema.properties as Record<string, any>
    ).n;

    expect(n.minimum).toBeUndefined();
    expect(n.maximum).toBeUndefined();
    // 剥了但**不**写进 description —— 「最大值: 9007199254740991」对模型零信息量
    expect(n.description).toBeUndefined();
  });

  test("minItems 是值级限制：0/1 保留，其余剥掉（Anthropic 只认这两个值）", () => {
    const keep = zodLike({ a: { type: "array", items: { type: "string" }, minItems: 1 } }, ["a"]);
    const kept = (
      sanitizeToolSchema(keep, dialect, { strict: true }).schema.properties as Record<string, any>
    ).a;
    expect(kept.minItems).toBe(1);

    const drop = zodLike({ a: { type: "array", items: { type: "string" }, minItems: 3 } }, ["a"]);
    const dropped = (
      sanitizeToolSchema(drop, dialect, { strict: true }).schema.properties as Record<string, any>
    ).a;
    expect(dropped.minItems).toBeUndefined();
    expect(dropped.description).toContain("最少元素数: 3");
  });

  test("maxItems 一律剥（子集里只有 minItems，且只认 0/1）", () => {
    const input = zodLike({ a: { type: "array", items: { type: "string" }, maxItems: 4 } }, ["a"]);
    const a = (
      sanitizeToolSchema(input, dialect, { strict: true }).schema.properties as Record<string, any>
    ).a;
    expect(a.maxItems).toBeUndefined();
    expect(a.description).toContain("最多元素数: 4");
  });

  test("🔴 `default` **不得**被剥 —— Anthropic strict 明确支持它", () => {
    // 这条是本层最容易犯的错：OpenAI 的支持属性表里没有 default，
    // 一个「共用 sanitizer 顺手剥掉」的实现会在 Anthropic 上白丢语义，且不报错。
    const input = zodLike({ mode: { type: "string", default: "replace" } }, ["mode"]);
    const mode = (
      sanitizeToolSchema(input, dialect, { strict: true }).schema.properties as Record<string, any>
    ).mode;
    expect(mode.default).toBe("replace");
  });

  test("`pattern` / `format` / `enum` 不得被剥（都在子集内）", () => {
    const input = zodLike(
      {
        e: { type: "string", format: "email" },
        p: { type: "string", pattern: "^a" },
        k: { type: "string", enum: ["x", "y"] },
      },
      ["e", "p", "k"],
    );
    const props = sanitizeToolSchema(input, dialect, { strict: true }).schema.properties as Record<
      string,
      any
    >;
    expect(props.e.format).toBe("email");
    expect(props.p.pattern).toBe("^a");
    expect(props.k.enum).toEqual(["x", "y"]);
  });

  test("🔴 **不做** required 全补全 —— Anthropic strict 保留可选参数概念", () => {
    // 搞反的后果：所有可选参数变必填，模型被迫给每个字段编一个值。
    const input = zodLike({ a: { type: "string" }, b: { type: "string" } }, ["a"]);
    const r = sanitizeToolSchema(input, dialect, { strict: true });
    expect(r.schema.required).toEqual(["a"]);
    // 也不该把 b 改成 nullable
    expect((r.schema.properties as Record<string, any>).b.type).toBe("string");
  });

  test("非 strict 语境不裁剪任何约束（Anthropic 对工具 schema 的未知关键字是忽略的）", () => {
    const input = zodLike({ n: { type: "integer", minimum: 0, maximum: 10 } }, ["n"]);
    const n = (
      sanitizeToolSchema(input, dialect, { strict: false }).schema.properties as Record<string, any>
    ).n;
    expect(n.minimum).toBe(0);
    expect(n.maximum).toBe(10);
  });
});

describe("OpenAI / DeepSeek：不裁剪约束，但要求 required 全覆盖", () => {
  // 依据 tool-schema.md §OpenAI：strict 子集**支持** pattern/format/数值约束/minItems/maxItems，
  // 剥掉反而丢掉服务端真会执行的约束解码能力。
  for (const family of ["openai-responses", "o-series", "deepseek-openai"] as const) {
    test(`${family}：数值与长度约束一律保留`, () => {
      const dialect = getToolSchemaDialect(family);
      const input = zodLike(
        { n: { type: "integer", minimum: 1, maximum: 9 }, s: { type: "string", maxLength: 5 } },
        ["n", "s"],
      );
      const props = sanitizeToolSchema(input, dialect, { strict: true }).schema
        .properties as Record<string, any>;
      expect(props.n.minimum).toBe(1);
      expect(props.n.maximum).toBe(9);
      expect(props.s.maxLength).toBe(5);
    });

    test(`${family}：required 补全为 properties 全集，原 optional 转 nullable`, () => {
      const dialect = getToolSchemaDialect(family);
      const input = zodLike({ a: { type: "string" }, b: { type: "string" } }, ["a"]);
      const r = sanitizeToolSchema(input, dialect, { strict: true });
      expect((r.schema.required as string[]).sort()).toEqual(["a", "b"]);
      // a 原本必填 → 类型不变；b 原本可选 → 允许 null
      expect((r.schema.properties as Record<string, any>).a.type).toBe("string");
      expect((r.schema.properties as Record<string, any>).b.type).toEqual(["string", "null"]);
    });
  }

  test("嵌套两层也补全（2026-07-13 事故报错定位的正是 questions[].options[]）", () => {
    const dialect = getToolSchemaDialect("openai-responses");
    const input = zodLike(
      {
        questions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              q: { type: "string" },
              options: {
                type: "array",
                items: {
                  type: "object",
                  properties: { label: { type: "string" }, hint: { type: "string" } },
                  required: ["label"],
                },
              },
            },
            required: ["q"],
          },
        },
      },
      ["questions"],
    );
    const r = sanitizeToolSchema(input, dialect, { strict: true });
    const item = (r.schema.properties as any).questions.items;
    expect((item.required as string[]).sort()).toEqual(["options", "q"]);
    const opt = item.properties.options;
    // options 原本可选 → 整体变 nullable，故要下钻 anyOf 分支拿到 array 那一支
    const optArray = opt.type ? opt : opt.anyOf.find((b: any) => b.type?.includes?.("array"));
    const leaf = (optArray.items ?? opt.items) as any;
    expect((leaf.required as string[]).sort()).toEqual(["hint", "label"]);
  });
});

describe("GLM / Grok / 未知族：只剥元信息键，不裁剪", () => {
  // GLM 依据：官方两份文档均未发布任何 JSON Schema 子集（tool-schema.md §GLM）。
  // Grok 依据：文档明确接受 default/oneOf/各类约束。
  // 未知族依据：与 unknownDialect 对 reasoning_effort 的「乐观下发」同向 ——
  //   发多了会 400（响亮、可自愈），发少了是静默丢能力（无从发现）。
  for (const family of ["glm-openai", "grok-openai", "unknown"] as const) {
    test(`${family}：约束与 default 全部保留`, () => {
      const dialect = getToolSchemaDialect(family);
      expect(dialect.strictRejectedKeywords).toEqual([]);

      const input = zodLike(
        { n: { type: "integer", minimum: 0, maximum: 9 }, d: { type: "string", default: "x" } },
        ["n", "d"],
      );
      const props = sanitizeToolSchema(input, dialect, { strict: true }).schema
        .properties as Record<string, any>;
      expect(props.n.minimum).toBe(0);
      expect(props.d.default).toBe("x");
    });
  }
});

describe("strict 结构性互斥：两类都降级，不硬塞必被拒的 schema", () => {
  const dialect = getToolSchemaDialect("openai-responses");

  test("无约束任意值（z.unknown() → 空 schema）→ strictUsable=false（2026-07-14 workflow.args）", () => {
    const input = zodLike({ args: {} }, ["args"]);
    const r = sanitizeToolSchema(input, dialect, { strict: true });
    expect(r.strictUsable).toBe(false);
    // 降级后不得含 strict 改造痕迹
    expect(JSON.stringify(r.schema)).not.toContain('"null"');
    // 但元信息键仍已剥掉（它与 strict 无关）
    expect(r.schema.$schema).toBeUndefined();
  });

  test("动态 key 字典（z.record() → propertyNames）→ strictUsable=false（2026-08-01 task_create）", () => {
    const input = zodLike(
      { metadata: { type: "object", propertyNames: { type: "string" }, additionalProperties: {} } },
      [],
    );
    expect(sanitizeToolSchema(input, dialect, { strict: true }).strictUsable).toBe(false);
  });

  test("patternProperties 同样判互斥", () => {
    const input = zodLike({
      m: { type: "object", patternProperties: { "^a": { type: "string" } } },
    });
    expect(sanitizeToolSchema(input, dialect, { strict: true }).strictUsable).toBe(false);
  });

  test("正常 schema 的 strictUsable=true（降级判定不得过度激进，否则白丢约束解码）", () => {
    const input = zodLike({ a: { type: "string" }, b: { type: "integer" } }, ["a"]);
    expect(sanitizeToolSchema(input, dialect, { strict: true }).strictUsable).toBe(true);
  });

  test("hasStrictIncompatibleNode 递归下钻 anyOf / items / properties", () => {
    expect(hasStrictIncompatibleNode({ anyOf: [{ type: "string" }, {}] })).toBe(true);
    expect(hasStrictIncompatibleNode({ type: "array", items: {} })).toBe(true);
    expect(
      hasStrictIncompatibleNode({
        type: "object",
        properties: { deep: { type: "array", items: {} } },
      }),
    ).toBe(true);
    expect(
      hasStrictIncompatibleNode({ type: "object", properties: { ok: { type: "string" } } }),
    ).toBe(false);
  });

  test("非 strict 语境的 strictUsable 恒为 false（语义是「本次没按 strict 处理」）", () => {
    const input = zodLike({ a: { type: "string" } }, ["a"]);
    expect(sanitizeToolSchema(input, dialect, { strict: false }).strictUsable).toBe(false);
  });
});

describe("端到端：$schema 不出现在任何一条协议线的请求体里", () => {
  // 三条线各有独立请求构造器，最容易「改了一条忘了另两条」。
  // 这组断言是**跨线对称性**检查，不是重复覆盖。
  function toolDef(strict?: boolean): ToolDefinition {
    return {
      name: "t",
      description: "d",
      input_schema: zodLike({ a: { type: "string" } }, ["a"]),
      ...(strict !== undefined ? { strict } : {}),
    };
  }

  test("Responses API 线：strict / 非 strict / 未声明三种都不含 $schema", () => {
    for (const strict of [true, false, undefined]) {
      const params = {
        model: "gpt-5.6-luna",
        messages: [],
        maxTokens: 64,
        tools: [toolDef(strict)],
      } as SendParams;
      const body = buildResponsesRequest(params, "gpt-5.6-luna");
      expect(JSON.stringify(body.tools), `strict=${strict}`).not.toContain("$schema");
    }
  });

  // Chat Completions 线与 Anthropic 线的转换发生在 provider 实例方法里，构造真实 provider
  // 需要 client + 网络配置，故它们的覆盖放在下面那组**源码级**哨兵里（不写一个
  // `expect(true).toBe(true)` 的占位用例 —— 那种测试的唯一作用是让计数变好看）。
});

describe("防漂移：三条协议线都不得裸透传 input_schema（源码级）", () => {
  // 立这道哨兵的理由：本层的价值全部来自「三条线共用同一处清理」。
  // 任何一条线绕过它，就退回本 PR 之前的状态 —— 而那个状态是测试全绿的
  // （三次生产事故都发生在测试全绿的前提下）。
  const FILES = [
    "../../src/llm/openai.ts",
    "../../src/llm/anthropic.ts",
    "../../src/llm/openai-responses-request.ts",
  ];

  for (const rel of FILES) {
    test(`${rel.split("/").pop()}：调用 sanitizeToolSchema 且无裸透传`, async () => {
      const src = await Bun.file(new URL(rel, import.meta.url).pathname).text();
      expect(src).toContain("sanitizeToolSchema");

      // 去掉注释行再扫，避免注释里的示例代码把哨兵误伤
      const code = src
        .split("\n")
        .filter((l) => {
          const t = l.trim();
          return !t.startsWith("*") && !t.startsWith("//") && !t.startsWith("/*");
        })
        .join("\n");

      expect(code).not.toMatch(/input_schema:\s*t\.input_schema/);
      expect(code).not.toMatch(/parameters:\s*t\.input_schema/);
      expect(code).not.toMatch(/parameters:\s*tool\.input_schema/);
    });
  }
});
