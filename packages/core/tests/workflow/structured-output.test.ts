/**
 * Dynamic Workflows M2 — JSON Schema 校验器 + StructuredOutput 工具单测
 */

import { test, expect, describe } from "bun:test";
import {
  validateAgainstSchema,
  formatSchemaErrors,
  checkSchemaShape,
} from "@sid-code/core/workflow/json-schema-validator.ts";
import {
  StructuredOutputTool,
  STRUCTURED_OUTPUT_TOOL_NAME,
} from "@sid-code/core/tool/structured-output-tool.ts";

describe("M2 validator — 基础类型", () => {
  test("string/number/boolean/integer 类型匹配", () => {
    expect(validateAgainstSchema({ type: "string" }, "hi").valid).toBe(true);
    expect(validateAgainstSchema({ type: "string" }, 42).valid).toBe(false);
    expect(validateAgainstSchema({ type: "number" }, 3.14).valid).toBe(true);
    expect(validateAgainstSchema({ type: "integer" }, 3).valid).toBe(true);
    expect(validateAgainstSchema({ type: "integer" }, 3.5).valid).toBe(false);
    expect(validateAgainstSchema({ type: "boolean" }, true).valid).toBe(true);
  });

  test("type 数组(nullable 习惯)", () => {
    const s = { type: ["string", "null"] };
    expect(validateAgainstSchema(s, "x").valid).toBe(true);
    expect(validateAgainstSchema(s, null).valid).toBe(true);
    expect(validateAgainstSchema(s, 1).valid).toBe(false);
  });
});

describe("M2 validator — object", () => {
  const schema = {
    type: "object",
    properties: {
      name: { type: "string" },
      age: { type: "integer" },
    },
    required: ["name"],
    additionalProperties: false,
  };

  test("合规对象", () => {
    expect(validateAgainstSchema(schema, { name: "Tom", age: 3 }).valid).toBe(true);
  });

  test("缺必填字段 → 报错且路径正确", () => {
    const r = validateAgainstSchema(schema, { age: 3 });
    expect(r.valid).toBe(false);
    if (!r.valid) {
      expect(r.errors.some((e) => e.path === "/name" && /必填/.test(e.message))).toBe(true);
    }
  });

  test("子字段类型错 → 报错路径定位到字段", () => {
    const r = validateAgainstSchema(schema, { name: "Tom", age: "old" });
    expect(r.valid).toBe(false);
    if (!r.valid) {
      expect(r.errors.some((e) => e.path === "/age")).toBe(true);
    }
  });

  test("additionalProperties:false → 额外字段报错", () => {
    const r = validateAgainstSchema(schema, { name: "Tom", extra: 1 });
    expect(r.valid).toBe(false);
    if (!r.valid) {
      expect(r.errors.some((e) => e.path === "/extra" && /额外/.test(e.message))).toBe(true);
    }
  });
});

describe("M2 validator — array + 嵌套", () => {
  const bugsSchema = {
    type: "object",
    properties: {
      bugs: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            severity: { type: "string", enum: ["low", "high"] },
          },
          required: ["title", "severity"],
        },
      },
    },
    required: ["bugs"],
  };

  test("合规嵌套数组", () => {
    const r = validateAgainstSchema(bugsSchema, {
      bugs: [{ title: "X", severity: "high" }],
    });
    expect(r.valid).toBe(true);
  });

  test("数组项 enum 不合法 → 路径定位到 /bugs/0/severity", () => {
    const r = validateAgainstSchema(bugsSchema, {
      bugs: [{ title: "X", severity: "critical" }],
    });
    expect(r.valid).toBe(false);
    if (!r.valid) {
      expect(r.errors.some((e) => e.path === "/bugs/0/severity")).toBe(true);
    }
  });

  test("minItems 不满足 → 报错", () => {
    const r = validateAgainstSchema(bugsSchema, { bugs: [] });
    expect(r.valid).toBe(false);
  });

  test("数组项缺必填 → 路径定位到 /bugs/1/title", () => {
    const r = validateAgainstSchema(bugsSchema, {
      bugs: [{ title: "A", severity: "low" }, { severity: "high" }],
    });
    expect(r.valid).toBe(false);
    if (!r.valid) {
      expect(r.errors.some((e) => e.path === "/bugs/1/title")).toBe(true);
    }
  });
});

describe("M2 validator — $ref / $defs", () => {
  const schema = {
    type: "object",
    properties: {
      finding: { $ref: "#/$defs/Finding" },
    },
    required: ["finding"],
    $defs: {
      Finding: {
        type: "object",
        properties: { id: { type: "integer" } },
        required: ["id"],
      },
    },
  };

  test("$ref 解引用校验", () => {
    expect(validateAgainstSchema(schema, { finding: { id: 1 } }).valid).toBe(true);
    const r = validateAgainstSchema(schema, { finding: { id: "x" } });
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.errors.some((e) => e.path === "/finding/id")).toBe(true);
  });
});

describe("M2 validator — const / 数值范围 / 字符串", () => {
  test("const", () => {
    expect(validateAgainstSchema({ const: "fixed" }, "fixed").valid).toBe(true);
    expect(validateAgainstSchema({ const: "fixed" }, "other").valid).toBe(false);
  });
  test("minimum/maximum", () => {
    const s = { type: "number", minimum: 0, maximum: 10 };
    expect(validateAgainstSchema(s, 5).valid).toBe(true);
    expect(validateAgainstSchema(s, -1).valid).toBe(false);
    expect(validateAgainstSchema(s, 11).valid).toBe(false);
  });
  test("minLength/pattern", () => {
    const s = { type: "string", minLength: 2, pattern: "^[a-z]+$" };
    expect(validateAgainstSchema(s, "abc").valid).toBe(true);
    expect(validateAgainstSchema(s, "a").valid).toBe(false);
    expect(validateAgainstSchema(s, "AB").valid).toBe(false);
  });
});

describe("M2 validator — checkSchemaShape", () => {
  test("合法 schema → null", () => {
    expect(checkSchemaShape({ type: "object" })).toBe(null);
    expect(checkSchemaShape({ type: ["string", "null"] })).toBe(null);
  });
  test("非对象 → 报错", () => {
    expect(checkSchemaShape("nope")).not.toBe(null);
    expect(checkSchemaShape(null)).not.toBe(null);
    expect(checkSchemaShape([1, 2])).not.toBe(null);
  });
  test("非法 type → 报错", () => {
    expect(checkSchemaShape({ type: "banana" })).not.toBe(null);
  });
  test("B19：没有任何可识别关键字的 schema → 报错（否则对任何值都 valid:true）", () => {
    // 官网 workflows.md 曾经的写法：漏了根层 type/properties
    const bad = { dirs: { type: "array", items: { type: "string" } } };
    // 先锁住它为什么危险：校验器对它确实什么都不约束
    expect(validateAgainstSchema(bad, { dirs: 123 }).valid).toBe(true);
    expect(validateAgainstSchema(bad, "hello").valid).toBe(true);
    // 所以必须在 shape 这一步就拦下
    const err = checkSchemaShape(bad);
    expect(err).not.toBe(null);
    expect(err).toContain("dirs");
  });
  test("B19：空对象 {} 是「接受任意值」，放行；只有注解关键字也放行", () => {
    expect(checkSchemaShape({})).toBe(null);
    expect(checkSchemaShape({ description: "任意" })).toBe(null);
    expect(checkSchemaShape({ anyOf: [{ type: "string" }] })).toBe(null);
    expect(checkSchemaShape({ $ref: "#/$defs/x", $defs: { x: { type: "string" } } })).toBe(null);
  });
  test("解不出的 $ref → 报错（否则该处约束静默失效）", () => {
    expect(checkSchemaShape({ $ref: "#/$defs/x" })).toContain("$ref 无法解析");
  });
});

// 缺陷文档 20260927-编排与调度 第三部分：P1-7 / P2-6 / P2-7 / P3-1
describe("schema 校验器缺口 — P1-7 循环 $ref", () => {
  const cyc = { $defs: { A: { $ref: "#/$defs/B" }, B: { $ref: "#/$defs/A" } }, $ref: "#/$defs/A" };
  test("A→B→A 纯 schema 环：校验返回错误而不是抛 RangeError", () => {
    const r = validateAgainstSchema(cyc, {});
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.errors[0].message).toContain("循环 $ref");
  });
  test("allOf 里藏的环也能拦住", () => {
    const s = { $defs: { A: { allOf: [{ $ref: "#/$defs/A" }] } }, $ref: "#/$defs/A" };
    expect(validateAgainstSchema(s, 1).valid).toBe(false);
    expect(checkSchemaShape(s)).toContain("循环 $ref");
  });
  test("checkSchemaShape 静态发现环（走不可重试分支）", () => {
    expect(checkSchemaShape(cyc)).toContain("循环 $ref");
  });
  test("对照：消耗数据层级的自引用（树）不是环，照常校验", () => {
    const tree = {
      $defs: {
        Node: {
          type: "object",
          properties: { v: { type: "number" }, child: { $ref: "#/$defs/Node" } },
        },
      },
      $ref: "#/$defs/Node",
    };
    expect(checkSchemaShape(tree)).toBe(null);
    expect(validateAgainstSchema(tree, { v: 1, child: { v: 2, child: {} } }).valid).toBe(true);
    expect(validateAgainstSchema(tree, { child: { child: { v: "x" } } }).valid).toBe(false);
  });
  test("StructuredOutputTool：环 schema 返回 isError，不抛异常", async () => {
    const tool = new StructuredOutputTool(cyc);
    const r = await tool.execute({});
    expect(r.isError).toBe(true);
    expect(r.output).toContain("schema 非法");
  });
});

describe("schema 校验器缺口 — P2-6 组合关键字与 additionalProperties", () => {
  test("oneOf：零个分支通过 / 多个分支通过都拒绝", () => {
    const s = { oneOf: [{ type: "string" }, { type: "number" }] };
    expect(validateAgainstSchema(s, "a").valid).toBe(true);
    expect(validateAgainstSchema(s, { x: true }).valid).toBe(false);
    const overlap = { oneOf: [{ type: "number" }, { type: "integer" }] };
    expect(validateAgainstSchema(overlap, 1.5).valid).toBe(true);
    expect(validateAgainstSchema(overlap, 1).valid).toBe(false);
  });
  test("anyOf / allOf / not 生效", () => {
    expect(validateAgainstSchema({ anyOf: [{ type: "string" }] }, 12345).valid).toBe(false);
    expect(
      validateAgainstSchema({ allOf: [{ type: "object", required: ["必填"] }] }, {}).valid,
    ).toBe(false);
    expect(validateAgainstSchema({ not: { type: "string" } }, "s").valid).toBe(false);
    expect(validateAgainstSchema({ not: { type: "string" } }, 1).valid).toBe(true);
  });
  test("if/then：critical 时 evidence 必填（§5.3 强制举证写法）", () => {
    const s = {
      type: "object",
      properties: { severity: { enum: ["critical", "minor"] }, evidence: { type: "string" } },
      required: ["severity"],
      if: { properties: { severity: { const: "critical" } } },
      then: { required: ["evidence"] },
    };
    expect(checkSchemaShape(s)).toBe(null);
    expect(validateAgainstSchema(s, { severity: "minor" }).valid).toBe(true);
    expect(validateAgainstSchema(s, { severity: "critical" }).valid).toBe(false);
    expect(validateAgainstSchema(s, { severity: "critical", evidence: "a.ts:1" }).valid).toBe(true);
  });
  test("additionalProperties:false 无 properties ⇒ 只接受空对象", () => {
    const s = { type: "object", additionalProperties: false };
    expect(validateAgainstSchema(s, {}).valid).toBe(true);
    expect(validateAgainstSchema(s, { 乱塞: 1 }).valid).toBe(false);
  });
  test("不实现的约束关键字在 shape 阶段明确拒绝（不再安静忽略）", () => {
    expect(checkSchemaShape({ type: "array", uniqueItems: true })).toContain("uniqueItems");
    expect(
      checkSchemaShape({
        type: "object",
        properties: { m: { type: "object", patternProperties: { "^x": {} } } },
      }),
    ).toContain("patternProperties");
  });
  test("注解关键字照常放行", () => {
    expect(checkSchemaShape({ type: "string", format: "uri", title: "t", examples: ["a"] })).toBe(
      null,
    );
  });
});

describe("schema 校验器缺口 — P2-7 checkSchemaShape 递归", () => {
  test("嵌套 properties / items / $defs 里的非法 type 都被拦", () => {
    expect(checkSchemaShape({ type: "object", properties: { x: { type: "整数" } } })).toContain(
      "/properties/x",
    );
    expect(
      checkSchemaShape({
        type: "array",
        items: { type: "object", properties: { y: { type: "int" } } },
      }),
    ).toContain("/items/properties/y");
    expect(checkSchemaShape({ $defs: { D: { type: "str" } }, type: "object" })).toContain(
      "$defs/D",
    );
    expect(checkSchemaShape({ anyOf: [{ type: "bogus" }] })).toContain("anyOf/0");
  });
  test("StructuredOutputTool：嵌套非法 type 走「schema 非法」不可重试分支", async () => {
    const tool = new StructuredOutputTool({ type: "object", properties: { x: { type: "整数" } } });
    const r = await tool.execute({ x: 1 });
    expect(r.isError).toBe(true);
    expect(r.output).toContain("schema 非法");
  });
});

describe("schema 校验器缺口 — P3-1 pattern ReDoS", () => {
  test("灾难性回溯被限时截断并报错，不卡死进程", () => {
    const s = { type: "string", pattern: "^(a+)+$" };
    const t0 = performance.now();
    const r = validateAgainstSchema(s, "a".repeat(40) + "b");
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.errors[0].message).toContain("灾难性回溯");
  });
  test("非法正则在 shape 阶段拒绝", () => {
    expect(checkSchemaShape({ type: "string", pattern: "(" })).toContain("pattern");
  });
  test("正常 pattern 行为不变", () => {
    const s = { type: "string", pattern: "^(\\d+\\.)+\\d+$" };
    expect(checkSchemaShape(s)).toBe(null);
    expect(validateAgainstSchema(s, "1.2.3").valid).toBe(true);
    expect(validateAgainstSchema(s, "1.x").valid).toBe(false);
  });
});

describe("M2 validator — formatSchemaErrors", () => {
  test("格式化为 path: message 串", () => {
    const r = validateAgainstSchema(
      { type: "object", required: ["a"], properties: { b: { type: "number" } } },
      { b: "x" },
    );
    expect(r.valid).toBe(false);
    if (!r.valid) {
      const s = formatSchemaErrors(r.errors);
      expect(s).toContain("/a");
      expect(s).toContain("/b");
      expect(s).toContain(":");
    }
  });
});

describe("M2 StructuredOutputTool — 校验/捕获/重试", () => {
  const schema = {
    type: "object",
    properties: { answer: { type: "string" } },
    required: ["answer"],
    additionalProperties: false,
  };

  test("工具名与 inputSchema", () => {
    const tool = new StructuredOutputTool(schema);
    expect(tool.name()).toBe(STRUCTURED_OUTPUT_TOOL_NAME);
    expect(tool.inputSchema()).toBe(schema); // 动态返回 workflow 的 schema
    expect(tool.readOnly()).toBe(true);
  });

  test("合规输入 → 捕获 + 非错误", async () => {
    const tool = new StructuredOutputTool(schema);
    expect(tool.hasCapturedOutput).toBe(false);
    const r = await tool.execute({ answer: "42" });
    expect(r.isError).toBeFalsy();
    expect(tool.hasCapturedOutput).toBe(true);
    expect(tool.getCapturedOutput()).toEqual({ answer: "42" });
  });

  test("不合规输入 → isError + 错误信息回喂(可重试),不捕获", async () => {
    const tool = new StructuredOutputTool(schema);
    const r = await tool.execute({ wrong: "field" });
    expect(r.isError).toBe(true);
    expect(r.output).toContain("schema"); // 提示重新调用
    expect(tool.hasCapturedOutput).toBe(false);
  });

  test("先失败后成功:最终捕获成功的那次(模拟重试)", async () => {
    const tool = new StructuredOutputTool(schema);
    await tool.execute({ bad: 1 }); // 第一次失败
    expect(tool.hasCapturedOutput).toBe(false);
    await tool.execute({ answer: "ok" }); // 重试成功
    expect(tool.hasCapturedOutput).toBe(true);
    expect(tool.getCapturedOutput()).toEqual({ answer: "ok" });
  });

  test("非法 schema → 报错(不可重试修复)", async () => {
    const tool = new StructuredOutputTool({ type: "banana" } as Record<string, unknown>);
    const r = await tool.execute({ x: 1 });
    expect(r.isError).toBe(true);
    expect(r.output).toContain("schema 非法");
  });

  test("checkPermissions 始终放行", async () => {
    const tool = new StructuredOutputTool(schema);
    const p = await tool.checkPermissions({ answer: "x" }, {} as never);
    expect(p.behavior).toBe("allow");
  });
});
