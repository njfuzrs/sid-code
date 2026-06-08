/**
 * Grep 工具单测
 * 覆盖：三种 output_mode、分页、mtime 排序、case_insensitive、fixed_strings、结构化输出
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { GrepTool } from "./grep.ts";
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";

let tempDir: string;

function createFile(name: string, content: string, mtimeOffset?: number): string {
  const path = join(tempDir, name);
  writeFileSync(path, content);
  if (mtimeOffset !== undefined) {
    const now = Date.now();
    utimesSync(path, new Date(now + mtimeOffset), new Date(now + mtimeOffset));
  }
  return path;
}

beforeEach(() => {
  tempDir = mkdtempSync("/tmp/grep-tool-test-");
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

/** 解析结构化 JSON 输出 */
function parseOutput(output: string): Record<string, unknown> {
  try {
    return JSON.parse(output);
  } catch {
    throw new Error(`无法解析 JSON 输出: ${output.slice(0, 200)}`);
  }
}

describe("GrepTool", () => {
  test("files_with_matches 模式返回文件名列表", async () => {
    createFile("a.ts", `const hello = 1;\n`);
    createFile("b.ts", `const world = 1;\n`);

    const tool = new GrepTool();
    const result = await tool.execute({
      pattern: "hello",
      path: tempDir,
      output_mode: "files_with_matches",
    });

    expect(result.isError).toBeFalsy();
    const parsed = parseOutput(result.output);
    expect(parsed.mode).toBe("files_with_matches");
    expect(parsed.numFiles).toBe(1);
    expect(parsed.filenames).toContain("a.ts");
  });

  test("files_with_matches 按 mtime 降序排列", async () => {
    // b.ts 修改时间更近 → 应排在前面
    createFile("a.ts", `const hello = 1;\n`, -60000); // 1 分钟前
    createFile("b.ts", `const hello = 2;\n`, 0);        // 现在

    const tool = new GrepTool();
    const result = await tool.execute({
      pattern: "hello",
      path: tempDir,
      output_mode: "files_with_matches",
    });

    const parsed = parseOutput(result.output);
    expect(parsed.filenames).toContain("b.ts");
    expect(parsed.filenames).toContain("a.ts");
    // b.ts 应该排在 a.ts 前面
    const idxB = (parsed.filenames as string[]).indexOf("b.ts");
    const idxA = (parsed.filenames as string[]).indexOf("a.ts");
    expect(idxB).toBeLessThan(idxA);
  });

  test("content 模式返回匹配行和上下文", async () => {
    createFile("test.ts", `line 1\nhello world\nline 3\nhello again\nline 5\n`);

    const tool = new GrepTool();
    const result = await tool.execute({
      pattern: "hello",
      path: tempDir,
      output_mode: "content",
    });

    const parsed = parseOutput(result.output);
    expect(parsed.mode).toBe("content");
    expect(parsed.numMatches).toBe(2);
    expect(parsed.content).toContain("hello world");
    expect(parsed.content).toContain("hello again");
  });

  test("content 模式支持上下文参数", async () => {
    createFile("test.ts", `line 1\nline 2\nhello world\nline 4\nline 5\n`);

    const tool = new GrepTool();
    const result = await tool.execute({
      pattern: "hello",
      path: tempDir,
      output_mode: "content",
      context: 1,
    });

    const parsed = parseOutput(result.output);
    // 上下文中应包含前后行
    expect(parsed.content).toContain("line 2");
    expect(parsed.content).toContain("line 4");
  });

  test("count 模式返回匹配计数", async () => {
    createFile("test.ts", `hello world\nhello again\nno match\n`);

    const tool = new GrepTool();
    const result = await tool.execute({
      pattern: "hello",
      path: tempDir,
      output_mode: "count",
    });

    const parsed = parseOutput(result.output);
    expect(parsed.mode).toBe("count");
    // count 输出格式: test.ts:2
    expect(parsed.content).toMatch(/test\.ts:\d+/);
  });

  test("head_limit 分页截断", async () => {
    const lines = Array.from({ length: 10 }, (_, i) => `match ${i}`);
    createFile("test.ts", lines.join("\n") + "\n");

    const tool = new GrepTool();
    const result = await tool.execute({
      pattern: "match",
      path: tempDir,
      output_mode: "content",
      head_limit: 3,
    });

    const parsed = parseOutput(result.output);
    expect(parsed.appliedLimit).toBe(3);
    expect(parsed.numMatches).toBeLessThanOrEqual(3);
  });

  test("offset 翻页", async () => {
    const lines = Array.from({ length: 10 }, (_, i) => `match ${i}`);
    createFile("test.ts", lines.join("\n") + "\n");

    const tool = new GrepTool();
    const result = await tool.execute({
      pattern: "match",
      path: tempDir,
      output_mode: "content",
      head_limit: 3,
      offset: 3,
    });

    const parsed = parseOutput(result.output);
    expect(parsed.appliedOffset).toBe(3);
  });

  test("head_limit=0 表示无限制", async () => {
    const lines = Array.from({ length: 50 }, (_, i) => `match ${i}`);
    createFile("test.ts", lines.join("\n") + "\n");

    const tool = new GrepTool();
    const result = await tool.execute({
      pattern: "match",
      path: tempDir,
      output_mode: "content",
      head_limit: 0,
    });

    const parsed = parseOutput(result.output);
    expect(parsed.appliedLimit).toBeUndefined();
    expect(parsed.numMatches).toBe(50);
  });

  test("total_max_matches 向后兼容", async () => {
    const lines = Array.from({ length: 10 }, (_, i) => `match ${i}`);
    createFile("test.ts", lines.join("\n") + "\n");

    const tool = new GrepTool();
    const result = await tool.execute({
      pattern: "match",
      path: tempDir,
      output_mode: "content",
      total_max_matches: 3,
    });

    const parsed = parseOutput(result.output);
    expect(parsed.appliedLimit).toBe(3);
  });

  test("case_insensitive 大小写不敏感搜索", async () => {
    createFile("test.ts", `const HELLO = 1;\n`);

    const tool = new GrepTool();
    const result = await tool.execute({
      pattern: "hello",
      path: tempDir,
      output_mode: "content",
      case_insensitive: true,
    });

    const parsed = parseOutput(result.output);
    expect(parsed.numMatches).toBe(1);
  });

  test("大小写敏感搜索（默认行为）", async () => {
    createFile("test.ts", `const HELLO = 1;\n`);

    const tool = new GrepTool();
    const result = await tool.execute({
      pattern: "hello",
      path: tempDir,
      output_mode: "content",
    });

    // 未设置 case_insensitive 时不应匹配，返回友好消息
    expect(result.output).toBe("未找到匹配的内容");
    expect(result.isError).toBeFalsy();
  });

  test("fixed_strings 字面量搜索", async () => {
    createFile("test.ts", `const arr = [1, 2, 3];\n`);

    const tool = new GrepTool();
    const result = await tool.execute({
      pattern: "[1, 2, 3]",
      path: tempDir,
      output_mode: "content",
      fixed_strings: true,
    });

    const parsed = parseOutput(result.output);
    expect(parsed.numMatches).toBe(1);
  });

  test("glob 文件过滤", async () => {
    createFile("a.ts", `const hello = 1;\n`);
    createFile("b.js", `const hello = 2;\n`);

    const tool = new GrepTool();
    const result = await tool.execute({
      pattern: "hello",
      path: tempDir,
      output_mode: "files_with_matches",
      glob: "*.ts",
    });

    const parsed = parseOutput(result.output);
    expect(parsed.filenames).toContain("a.ts");
    expect(parsed.filenames).not.toContain("b.js");
  });

  test("无匹配时返回友好消息", async () => {
    createFile("test.ts", `nothing here\n`);

    const tool = new GrepTool();
    const result = await tool.execute({
      pattern: "xyz_nonexistent_pattern",
      path: tempDir,
      output_mode: "content",
    });

    expect(result.output).toBe("未找到匹配的内容");
  });

  test("缺少 pattern 参数返回错误", async () => {
    const tool = new GrepTool();
    const result = await tool.execute({
      pattern: "",
      path: tempDir,
    });

    expect(result.isError).toBe(true);
    expect(result.output).toContain("缺少 pattern 参数");
  });

  test("结构化输出包含必要字段", async () => {
    createFile("test.ts", `const hello = 1;\nconst world = 2;\n`);

    const tool = new GrepTool();
    const result = await tool.execute({
      pattern: "hello",
      path: tempDir,
      output_mode: "content",
    });

    const parsed = parseOutput(result.output);
    expect(parsed).toHaveProperty("mode");
    expect(parsed).toHaveProperty("numFiles");
    expect(parsed).toHaveProperty("filenames");
    expect(parsed).toHaveProperty("content");
    expect(parsed).toHaveProperty("numLines");
    expect(parsed).toHaveProperty("numMatches");
    expect(parsed).toHaveProperty("appliedOffset");
  });

  test("name/description/usageGuide/inputSchema 方法", () => {
    const tool = new GrepTool();

    expect(tool.name()).toBe("grep");
    expect(typeof tool.description()).toBe("string");
    expect(typeof tool.usageGuide!()).toBe("string");

    const schema = tool.inputSchema();
    expect(schema.required).toContain("pattern");
    expect(schema.properties).toHaveProperty("head_limit");
    expect(schema.properties).toHaveProperty("offset");
    expect(schema.properties).not.toHaveProperty("exclude_pattern"); // 已移除
  });
});
