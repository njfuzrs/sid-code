/**
 * Phase 2 单测：NDJSON 序列化/反序列化
 */

import { describe, test, expect } from "bun:test";
import { Readable } from "node:stream";
import { ndjsonStringify, ndjsonParse, ndjsonLines } from "@sid-code/core/sdk/ndjson.ts";

const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);

describe("ndjsonStringify", () => {
  test("普通对象", () => {
    expect(ndjsonStringify({ a: 1 })).toBe('{"a":1}');
  });

  test("转义 U+2028 / U+2029", () => {
    const out = ndjsonStringify({ text: `a${LS}b${PS}c` });
    expect(out.includes(LS)).toBe(false);
    expect(out.includes(PS)).toBe(false);
    expect(out.includes("\\u2028")).toBe(true);
    expect(out.includes("\\u2029")).toBe(true);
  });

  test("转义后仍可被 JSON.parse 还原", () => {
    const obj = { text: `x${LS}y` };
    const back = JSON.parse(ndjsonStringify(obj));
    expect(back.text).toBe(`x${LS}y`);
  });
});

describe("ndjsonParse", () => {
  test("解析行", () => {
    expect(ndjsonParse('{"a":1}')).toEqual({ a: 1 });
  });
  test("空行返回 null", () => {
    expect(ndjsonParse("   ")).toBeNull();
  });
});

describe("ndjsonLines", () => {
  test("逐行 yield，跳过空行", async () => {
    const stream = Readable.from(['{"a":1}\n', "\n", '{"b":2}\n']);
    const lines: string[] = [];
    for await (const line of ndjsonLines(stream)) lines.push(line);
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  test("跨 chunk 的不完整行", async () => {
    const stream = Readable.from(['{"a":', '1}\n{"b":2', "}\n"]);
    const lines: string[] = [];
    for await (const line of ndjsonLines(stream)) lines.push(line);
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  test("无换行结尾的最后一行", async () => {
    const stream = Readable.from(['{"a":1}']);
    const lines: string[] = [];
    for await (const line of ndjsonLines(stream)) lines.push(line);
    expect(lines).toEqual(['{"a":1}']);
  });
});
