/**
 * read_many 纳入重复读登记（R1 / PR8）回归测试
 *
 * 方案：20261116-只读子代理空转与过期清理重读循环-修复与验收方案.md §4.5 R1 / §6 PR8。
 *
 * 之前 read_many 完全不经过任何读历史：
 * - 重复 read_many 同一批文件，第 3 次起没有「重复读」提示；
 * - 先 read_many 再 read 同一文件，read 的计数器从 1 开始，提示也不出现；
 * - ReadHint 事件（kind=repeat_narrow）只从 read 发出，批量读在轨迹里完全不可观测。
 *
 * 本文件守住三件事：
 * 1. read_many 按展开后的每个文件登记，第 3 次重叠读时逐文件提示；
 * 2. read 与 read_many 共享同一份历史（createStatefulTools 注入的生产路径）；
 * 3. 未注入时两套工具各自隔离，不跨作用域污染。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ReadManyTool } from "@sid-code/core/tool/read-many.ts";
import { ReadHistory, ReadTool, setReadHintTraceSink } from "@sid-code/core/tool/read.ts";
import { createStatefulTools } from "@sid-code/core/tool/stateful-tools.ts";
import { FileReadTracker } from "@sid-code/core/tool/file-read-tracker.ts";

const tmpDirs: string[] = [];
let hintEvents: Record<string, unknown>[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "read-many-repeat-"));
  tmpDirs.push(dir);
  return dir;
}

function writeFile(dir: string, filename: string, content: string): string {
  const filePath = join(dir, filename);
  writeFileSync(filePath, content);
  return filePath;
}

beforeEach(() => {
  hintEvents = [];
  setReadHintTraceSink((data) => hintEvents.push(data));
});

afterEach(() => {
  setReadHintTraceSink(null);
  for (const dir of tmpDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 忽略 */
    }
  }
});

describe("read_many 重复读登记（R1）", () => {
  test("第 3 次读同一批文件：每个文件段落各一条提示", async () => {
    const dir = makeTmpDir();
    writeFile(dir, "a.ts", "export const a = 1;\n");
    writeFile(dir, "b.ts", "export const b = 2;\n");
    const tool = new ReadManyTool();
    const input = { pattern: [join(dir, "*.ts")] };

    const first = await tool.execute(input);
    const second = await tool.execute(input);
    const third = await tool.execute(input);

    expect(first.output).not.toContain("读取效率提示");
    expect(second.output).not.toContain("读取效率提示");
    // 两个文件各一条：第 3 次读取 + 高度重叠
    expect(third.output.split("读取效率提示").length - 1).toBe(2);
    expect(third.output).toContain("第 3 次读取");
  });

  test("ReadHint 事件从 read_many 发出，窗口与 read 同一口径", async () => {
    const dir = makeTmpDir();
    const file = writeFile(dir, "one.ts", "line1\nline2\nline3\n");
    const tool = new ReadManyTool();
    const input = { pattern: [file] };
    for (let i = 0; i < 3; i++) await tool.execute(input);

    const repeatEvents = hintEvents.filter((e) => e.kind === "repeat_narrow");
    expect(repeatEvents.length).toBe(1);
    expect(repeatEvents[0]).toMatchObject({
      read_count: 3,
      start_line: 1,
      // "line1\nline2\nline3\n".split("\n") = 4 行，与 read 的 totalLines 口径一致
      end_line: 4,
      total_lines: 4,
      overlap_ratio: 1,
      suggest_full_read: true,
    });
    expect(String(repeatEvents[0].hint_file_path).endsWith("one.ts")).toBe(true);
  });

  test("read_many 与 read 共享历史：先批量读两次，read 第 1 次就提示", async () => {
    const dir = makeTmpDir();
    const file = writeFile(dir, "shared.ts", "line1\nline2\n");
    const history = new ReadHistory();
    const many = new ReadManyTool(undefined, undefined, history);
    const read = new ReadTool(undefined, history);

    await many.execute({ pattern: [file] });
    await many.execute({ pattern: [file] });
    const result = await read.execute({ file_path: file });

    expect(result.output).toContain("读取效率提示");
    expect(result.output).toContain("第 3 次读取");
  });

  test("反向共享：read 读两次后，read_many 第 1 次就提示", async () => {
    const dir = makeTmpDir();
    const file = writeFile(dir, "reverse.ts", "line1\nline2\n");
    const history = new ReadHistory();
    const many = new ReadManyTool(undefined, undefined, history);
    const read = new ReadTool(undefined, history);

    await read.execute({ file_path: file });
    await read.execute({ file_path: file });
    const result = await many.execute({ pattern: [file] });

    expect(result.output).toContain("读取效率提示");
    expect(result.output).toContain("第 3 次读取");
  });

  test("createStatefulTools（生产路径）注入共享历史", async () => {
    const dir = makeTmpDir();
    const file = writeFile(dir, "factory.ts", "line1\nline2\n");
    const tools = createStatefulTools(new FileReadTracker());
    const many = tools.find((t) => t.name() === "read_many")!;
    const read = tools.find((t) => t.name() === "read")!;

    await many.execute({ pattern: [file] });
    await many.execute({ pattern: [file] });
    const result = await read.execute({ file_path: file });

    expect(result.output).toContain("第 3 次读取");
  });

  test("未注入共享实例时两套工具互不影响（不跨作用域污染）", async () => {
    const dir = makeTmpDir();
    const file = writeFile(dir, "isolated.ts", "line1\nline2\n");
    const many = new ReadManyTool();
    const read = new ReadTool();

    await many.execute({ pattern: [file] });
    await many.execute({ pattern: [file] });
    const result = await read.execute({ file_path: file });

    expect(result.output).not.toContain("读取效率提示");
    expect(result.output).not.toContain("第 3 次读取");
  });

  test("不同文件不触发", async () => {
    const dir = makeTmpDir();
    const a = writeFile(dir, "a.ts", "line1\n");
    const b = writeFile(dir, "b.ts", "line1\n");
    const tool = new ReadManyTool();

    await tool.execute({ pattern: [a] });
    await tool.execute({ pattern: [b] });
    const third = await tool.execute({ pattern: [a] }); // a 只读了第 2 次

    expect(third.output).not.toContain("读取效率提示");
  });

  test("空文件不登记（与 read 的空文件早退同口径）", async () => {
    const dir = makeTmpDir();
    const empty = writeFile(dir, "empty.ts", "");
    const history = new ReadHistory();
    const many = new ReadManyTool(undefined, undefined, history);
    const read = new ReadTool(undefined, history);

    await many.execute({ pattern: [empty] });
    await many.execute({ pattern: [empty] });
    const result = await read.execute({ file_path: empty });

    expect(result.output).not.toContain("读取效率提示");
  });
});
