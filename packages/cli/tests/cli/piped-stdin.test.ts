/**
 * 无头模式管道 stdin（B1）与 --json-schema 双形态（G6）的纯函数单测。
 *
 * 两者都是「CLI 入口层的缺口」：管道内容此前被整段丢弃，schema 只收文件路径。
 * 这里不 spawn 进程——读 stdin 和解析 schema 都已抽成纯函数，注入 mock 即可。
 */

import { describe, test, expect } from "bun:test";
import { Readable } from "node:stream";
import { readPipedStdin } from "@sid-code/cli/utils/piped-stdin.ts";
import { parseJsonSchemaArg } from "@sid-code/cli/utils/json-schema-arg.ts";

/** 一个可控的非 TTY 流：read 时把全部分块一次性吐出并结束。 */
function fakeStdin(chunks: string[]): Readable {
  return new Readable({
    read() {
      for (const c of chunks) this.push(c);
      this.push(null);
    },
  });
}

describe("readPipedStdin", () => {
  test("TTY 直接返回空，不读流", async () => {
    const r = await readPipedStdin({ stdin: fakeStdin(["hello"]), isTTY: true, timeoutMs: 50 });
    expect(r).toEqual({ text: "", timedOut: false });
  });

  test("非 TTY 累积全部分块", async () => {
    const r = await readPipedStdin({
      stdin: fakeStdin(["hello ", "world"]),
      isTTY: false,
      timeoutMs: 1000,
    });
    expect(r.timedOut).toBe(false);
    expect(r.text).toBe("hello world");
  });

  test("空管道（立即 EOF）不挂起，返回空串", async () => {
    const r = await readPipedStdin({ stdin: fakeStdin([]), isTTY: false, timeoutMs: 1000 });
    expect(r).toEqual({ text: "", timedOut: false });
  });

  test("超时返回已收到的部分并告警", async () => {
    // 不 end：模拟慢生产者。第一次 read 吐出一段后就停住。
    let pushed = false;
    const stdin = new Readable({
      read() {
        if (!pushed) {
          pushed = true;
          this.push("partial");
        }
      },
    });
    const warnings: string[] = [];
    const r = await readPipedStdin({
      stdin,
      isTTY: false,
      timeoutMs: 30,
      warn: (m) => warnings.push(m),
    });
    expect(r.timedOut).toBe(true);
    expect(r.text).toContain("partial");
    expect(warnings[0]).toContain("SID_CODE_STDIN_TIMEOUT_MS");
    stdin.destroy();
  });
});

describe("parseJsonSchemaArg", () => {
  const schema = { type: "object", properties: { name: { type: "string" } } };

  test("以 { 开头 → 内联 JSON，不读文件", () => {
    const r = parseJsonSchemaArg(JSON.stringify(schema), () => {
      throw new Error("不该读文件");
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.source).toBe("inline");
      expect(r.schema).toEqual(schema);
    }
  });

  test("内联但非法 JSON → 报解析失败，不回退成文件", () => {
    const r = parseJsonSchemaArg("{ not json", () => {
      throw new Error("不该读文件");
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("内联 JSON");
  });

  test("不以 { 或 [ 开头 → 当文件路径", () => {
    const r = parseJsonSchemaArg("./schema.json", () => JSON.stringify(schema));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.source).toBe("file");
  });

  test("文件读不到 → 报错并提示内联写法", () => {
    const r = parseJsonSchemaArg("./missing.json", () => {
      throw new Error("ENOENT");
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("无法读取");
  });

  test("文件内容不是对象 → 报错", () => {
    const r = parseJsonSchemaArg("./s.json", () => "[1, 2, 3]");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("JSON 对象");
  });

  test("空值 → 报错", () => {
    const r = parseJsonSchemaArg("   ");
    expect(r.ok).toBe(false);
  });
});
