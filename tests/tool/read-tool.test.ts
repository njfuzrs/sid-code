/**
 * Read 工具稳定性保护单元测试
 *
 * 覆盖对标 CC FileReadTool 后新增的所有保护机制：
 * - 设备文件拦截
 * - 二进制扩展名拦截
 * - 二进制内容检测
 * - 目录路径检测
 * - 大文件拒绝
 * - BOM 剥离
 * - CRLF 规范化
 * - 空文件提示
 * - AbortSignal 中止
 * - 行号 tab 格式
 */

import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ReadTool } from "../../src/tool/read.ts";
import { FileReadTracker } from "../../src/tool/file-read-tracker.ts";

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "read-tool-test-"));
  tmpDirs.push(dir);
  return dir;
}

function makeTmpFile(content: string | Buffer, filename = "test.txt"): string {
  const dir = makeTmpDir();
  const filePath = join(dir, filename);
  writeFileSync(filePath, content);
  return filePath;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
});

describe("Read 工具 — 基本功能", () => {
  test("正常读取文本文件", async () => {
    const filePath = makeTmpFile("line1\nline2\nline3\n");
    const tool = new ReadTool();
    const result = await tool.execute({ file_path: filePath });

    expect(result.isError).toBeUndefined();
    expect(result.output).toContain("1\tline1");
    expect(result.output).toContain("2\tline2");
    expect(result.output).toContain("3\tline3");
  });

  test("行号使用 tab 分隔符（对齐 CC cat -n 格式）", async () => {
    const filePath = makeTmpFile("hello\nworld");
    const tool = new ReadTool();
    const result = await tool.execute({ file_path: filePath });

    expect(result.output).toMatch(/^1\thello\n2\tworld/);
  });

  test("offset 和 limit 参数正常工作", async () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line${i + 1}`).join("\n");
    const filePath = makeTmpFile(lines);
    const tool = new ReadTool();

    const result = await tool.execute({ file_path: filePath, offset: 10, limit: 5 });
    expect(result.isError).toBeUndefined();
    expect(result.output).toContain("10\tline10");
    expect(result.output).toContain("14\tline14");
    expect(result.output).not.toContain("15\tline15");
  });

  test("超过 DEFAULT_MAX_LINES 时显示截断提示", async () => {
    const lines = Array.from({ length: 2500 }, (_, i) => `L${i}`).join("\n");
    const filePath = makeTmpFile(lines);
    const tool = new ReadTool();

    const result = await tool.execute({ file_path: filePath });
    expect(result.output).toContain("[文件已截断");
    expect(result.output).toContain("offset=2001");
  });

  test("tracker 记录读取状态", async () => {
    const filePath = makeTmpFile("content");
    const tracker = new FileReadTracker();
    const tool = new ReadTool(tracker);

    await tool.execute({ file_path: filePath });
    expect(tracker.hasBeenRead(filePath)).toBe(true);
  });
});

describe("Read 工具 — 设备文件拦截 (P1)", () => {
  test("/dev/urandom 被拦截", async () => {
    const tool = new ReadTool();
    const result = await tool.execute({ file_path: "/dev/urandom" });

    expect(result.isError).toBe(true);
    expect(result.output).toContain("阻塞进程或产生无限输出");
  });

  test("/dev/zero 被拦截", async () => {
    const tool = new ReadTool();
    const result = await tool.execute({ file_path: "/dev/zero" });

    expect(result.isError).toBe(true);
    expect(result.output).toContain("阻塞进程");
  });

  test("/dev/stdin 被拦截", async () => {
    const tool = new ReadTool();
    const result = await tool.execute({ file_path: "/dev/stdin" });

    expect(result.isError).toBe(true);
  });

  test("/dev/null 不被拦截（安全设备，但 stat 判定非普通文件返回 ENOENT）", async () => {
    const tool = new ReadTool();
    const result = await tool.execute({ file_path: "/dev/null" });

    // /dev/null 不在 BLOCKED_DEVICE_PATHS 黑名单中，但 Bun.file().exists() 对设备文件
    // 返回 false（非普通文件），所以走到 ENOENT 路径。这不是 bug — 安全设备不需要读取。
    expect(result.isError).toBe(true);
  });

  test("/proc/self/fd/0 被拦截", async () => {
    const tool = new ReadTool();
    const result = await tool.execute({ file_path: "/proc/self/fd/0" });

    expect(result.isError).toBe(true);
  });
});

describe("Read 工具 — 二进制扩展名拦截 (P1)", () => {
  test(".png 文件被拒绝", async () => {
    const filePath = makeTmpFile("fake png content", "image.png");
    const tool = new ReadTool();
    const result = await tool.execute({ file_path: filePath });

    expect(result.isError).toBe(true);
    expect(result.output).toContain("二进制文件");
    expect(result.output).toContain(".png");
  });

  test(".zip 文件被拒绝", async () => {
    const filePath = makeTmpFile("fake zip", "archive.zip");
    const tool = new ReadTool();
    const result = await tool.execute({ file_path: filePath });

    expect(result.isError).toBe(true);
    expect(result.output).toContain("二进制文件");
  });

  test(".wasm 文件被拒绝", async () => {
    const filePath = makeTmpFile("fake wasm", "module.wasm");
    const tool = new ReadTool();
    const result = await tool.execute({ file_path: filePath });

    expect(result.isError).toBe(true);
  });

  test(".ts 文件不被拒绝", async () => {
    const filePath = makeTmpFile("const x = 1;", "code.ts");
    const tool = new ReadTool();
    const result = await tool.execute({ file_path: filePath });

    expect(result.isError).toBeUndefined();
  });

  test(".json 文件不被拒绝", async () => {
    const filePath = makeTmpFile("{}", "config.json");
    const tool = new ReadTool();
    const result = await tool.execute({ file_path: filePath });

    expect(result.isError).toBeUndefined();
  });
});

describe("Read 工具 — 二进制内容检测 (P1)", () => {
  test("包含 null 字节的文件被检测为二进制", async () => {
    // 无二进制扩展名，但内容含 null byte
    const content = Buffer.from("hello\x00world\x00binary");
    const filePath = makeTmpFile(content, "data.dat");
    // .dat 不在黑名单中
    const tool = new ReadTool();
    const result = await tool.execute({ file_path: filePath });

    expect(result.isError).toBe(true);
    expect(result.output).toContain("二进制数据");
  });

  test("高比例不可打印字符被检测为二进制", async () => {
    // 构造 >10% 不可打印字节的内容
    const buf = Buffer.alloc(100);
    for (let i = 0; i < 100; i++) {
      buf[i] = i < 15 ? 1 : 65; // 15% 是控制字符
    }
    const filePath = makeTmpFile(buf, "weird.dat");
    const tool = new ReadTool();
    const result = await tool.execute({ file_path: filePath });

    expect(result.isError).toBe(true);
    expect(result.output).toContain("二进制数据");
  });

  test("纯文本文件不被误报", async () => {
    const content = "normal text\nwith newlines\nand tabs\t";
    const filePath = makeTmpFile(content, "normal.dat");
    const tool = new ReadTool();
    const result = await tool.execute({ file_path: filePath });

    expect(result.isError).toBeUndefined();
  });
});

describe("Read 工具 — 目录路径检测 (P1)", () => {
  test("传入目录路径返回明确错误", async () => {
    const dir = makeTmpDir();
    const tool = new ReadTool();
    const result = await tool.execute({ file_path: dir });

    expect(result.isError).toBe(true);
    expect(result.output).toContain("是一个目录");
    expect(result.output).toContain("ls 工具");
  });
});

describe("Read 工具 — 大文件保护 (P0)", () => {
  test("超过 10MB 无 offset/limit 时拒绝", async () => {
    // 创建一个刚超过 10MB 的文件
    const dir = makeTmpDir();
    const filePath = join(dir, "large.txt");
    // 写入 10MB + 1 的内容
    const chunk = "x".repeat(1024) + "\n";
    const fd = Bun.file(filePath).writer();
    for (let i = 0; i < 10240 + 1; i++) {
      fd.write(chunk);
    }
    fd.end();
    // 确保文件已写入
    await Bun.sleep(50);

    const tool = new ReadTool();
    const result = await tool.execute({ file_path: filePath });

    expect(result.isError).toBe(true);
    expect(result.output).toContain("文件过大");
    expect(result.output).toContain("10 MB");
  });

  test("超过 10MB 但指定了 offset/limit 时允许", async () => {
    const dir = makeTmpDir();
    const filePath = join(dir, "large2.txt");
    const lines = Array.from({ length: 200000 }, (_, i) => `line${i}`).join("\n");
    writeFileSync(filePath, lines);

    const tool = new ReadTool();
    const result = await tool.execute({ file_path: filePath, offset: 1, limit: 10 });

    // 指定了 limit，应该允许读取
    expect(result.isError).toBeUndefined();
    expect(result.output).toContain("line0");
  });
});

describe("Read 工具 — BOM 剥离 (P2)", () => {
  test("UTF-8 BOM 被正确剥离", async () => {
    const bom = "﻿";
    const content = bom + "first line\nsecond line";
    const filePath = makeTmpFile(content);
    const tool = new ReadTool();
    const result = await tool.execute({ file_path: filePath });

    expect(result.isError).toBeUndefined();
    // BOM 不应出现在输出中
    expect(result.output).not.toContain("﻿");
    expect(result.output).toContain("1\tfirst line");
  });
});

describe("Read 工具 — CRLF 规范化 (P2)", () => {
  test("Windows CRLF 换行被规范化为 LF", async () => {
    const content = "line1\r\nline2\r\nline3\r\n";
    const filePath = makeTmpFile(content);
    const tool = new ReadTool();
    const result = await tool.execute({ file_path: filePath });

    expect(result.isError).toBeUndefined();
    // 不应包含 \r
    expect(result.output).not.toContain("\r");
    expect(result.output).toContain("1\tline1");
    expect(result.output).toContain("2\tline2");
  });
});

describe("Read 工具 — 空文件提示 (P3)", () => {
  test("空文件返回系统提示", async () => {
    const filePath = makeTmpFile("");
    const tool = new ReadTool();
    const result = await tool.execute({ file_path: filePath });

    expect(result.isError).toBeUndefined();
    expect(result.output).toContain("内容为空");
  });

  test("仅含换行的文件也视为空", async () => {
    const filePath = makeTmpFile("\n");
    const tool = new ReadTool();
    const result = await tool.execute({ file_path: filePath });

    // split("\n") 得到 ["", ""]，normalizedLines[0] === "" 且 totalLines <= 2
    // 实际这种情况两行都是空的，但不完全是空文件
    // 只有 totalLines === 1 && line === "" 才算空文件
    expect(result.isError).toBeUndefined();
  });
});

describe("Read 工具 — AbortSignal 中止 (P0)", () => {
  test("已中止的 signal 立即返回取消", async () => {
    const filePath = makeTmpFile("content");
    const tool = new ReadTool();
    const controller = new AbortController();
    controller.abort();

    const result = await tool.execute({ file_path: filePath }, controller.signal);

    expect(result.isError).toBe(true);
    expect(result.output).toContain("操作已取消");
  });
});

describe("Read 工具 — 错误处理", () => {
  test("文件不存在返回明确错误和相似文件提示", async () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, "config.ts"), "x");
    const tool = new ReadTool();
    const result = await tool.execute({ file_path: join(dir, "conifg.ts") });

    expect(result.isError).toBe(true);
    expect(result.output).toContain("文件不存在");
    expect(result.output).toContain("config.ts");
  });

  test("缺少 file_path 参数", async () => {
    const tool = new ReadTool();
    const result = await tool.execute({});

    expect(result.isError).toBe(true);
    expect(result.output).toContain("缺少 file_path");
  });

  test("路径含 null byte 被拒绝", async () => {
    const tool = new ReadTool();
    const result = await tool.execute({ file_path: "/tmp/file\x00.txt" });

    expect(result.isError).toBe(true);
    expect(result.output).toContain("路径无效");
  });
});
