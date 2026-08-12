/**
 * Phase 3 单测：结构化输出
 */

import { describe, test, expect } from "bun:test";
import {
  extractStructuredOutput,
  buildStructuredOutputPrompt,
} from "@sid-code/core/sdk/structured-output.ts";
import type { Message } from "@sid-code/core/llm/types.ts";

const objSchema = {
  type: "object",
  required: ["name", "age"],
  properties: { name: { type: "string" }, age: { type: "number" } },
};

function assistant(text: string): Message {
  return { role: "assistant", content: [{ type: "text", text }] };
}

describe("extractStructuredOutput", () => {
  test("纯 JSON 文本", () => {
    const r = extractStructuredOutput(assistant('{"name":"a","age":1}'), objSchema);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toEqual({ name: "a", age: 1 });
  });

  test("```json 代码块包裹", () => {
    const msg = assistant('结果：\n```json\n{"name":"b","age":2}\n```');
    const r = extractStructuredOutput(msg, objSchema);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toEqual({ name: "b", age: 2 });
  });

  test("``` 无语言标记的代码块", () => {
    const msg = assistant('```\n{"name":"c","age":3}\n```');
    const r = extractStructuredOutput(msg, objSchema);
    expect(r.success).toBe(true);
  });

  test("非助手消息失败", () => {
    const r = extractStructuredOutput(
      { role: "user", content: [{ type: "text", text: "{}" }] },
      objSchema,
    );
    expect(r.success).toBe(false);
  });

  test("无文本内容失败", () => {
    const r = extractStructuredOutput(
      { role: "assistant", content: [{ type: "tool_use", id: "t", name: "x", input: {} }] },
      objSchema,
    );
    expect(r.success).toBe(false);
  });

  test("非法 JSON 失败", () => {
    const r = extractStructuredOutput(assistant("not json"), objSchema);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error).toContain("JSON");
  });

  test("缺失必填字段失败", () => {
    const r = extractStructuredOutput(assistant('{"name":"a"}'), objSchema);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error).toContain("age");
  });

  test("期望 object 但给 array 失败", () => {
    const r = extractStructuredOutput(assistant("[1,2,3]"), objSchema);
    expect(r.success).toBe(false);
  });

  test("array schema 校验", () => {
    const r = extractStructuredOutput(assistant("[1,2,3]"), { type: "array" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toEqual([1, 2, 3]);
  });

  test("取最后一个 text block", () => {
    const msg: Message = {
      role: "assistant",
      content: [
        { type: "text", text: "思考过程" },
        { type: "text", text: '{"name":"z","age":9}' },
      ],
    };
    const r = extractStructuredOutput(msg, objSchema);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toMatchObject({ name: "z" });
  });
});

describe("buildStructuredOutputPrompt", () => {
  test("包含 schema 与代码块标记", () => {
    const prompt = buildStructuredOutputPrompt(objSchema);
    expect(prompt).toContain("structured-output-requirement");
    expect(prompt).toContain("```json");
    expect(prompt).toContain('"required"');
  });
});
