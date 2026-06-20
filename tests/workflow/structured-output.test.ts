/**
 * Dynamic Workflows M2 — JSON Schema 校验器 + StructuredOutput 工具单测
 */

import { test, expect, describe } from "bun:test";
import {
  validateAgainstSchema,
  formatSchemaErrors,
  checkSchemaShape,
} from "../../src/workflow/json-schema-validator.ts";
import {
  StructuredOutputTool,
  STRUCTURED_OUTPUT_TOOL_NAME,
} from "../../src/tool/structured-output-tool.ts";

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
