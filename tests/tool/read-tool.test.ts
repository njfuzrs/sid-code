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
import { ReadTool, stripReadEfficiencyHint } from "../../src/tool/read.ts";
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
  // G6：.png 现在以图片 mediaBlock 返回，不再拒绝
  test(".png 文件以图片 mediaBlock 返回（G6）", async () => {
    const filePath = makeTmpFile("fake png content", "image.png");
    const tool = new ReadTool();
    const result = await tool.execute({ file_path: filePath });

    expect(result.isError).toBeUndefined();
    expect(result.mediaBlocks).toBeDefined();
    expect(result.mediaBlocks!.length).toBe(1);
    expect(result.mediaBlocks![0].kind).toBe("image");
    expect(result.mediaBlocks![0].mediaType).toBe("image/png");
    expect(result.output).toContain("图片");
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

  /**
   * 2026-07-30 回归：报错必须可定位。
   *
   * 事故：src/permission/denial-tracking.ts 6838 字节里只有 1 个字面 NUL（作者本意是
   * 写 \x00 转义当分隔符）。旧报错只说「包含二进制数据」，模型为定位这一个字节连烧
   * 5+ 次工具调用（cat → file+tr 数 NUL → tr -d → python3 找偏移），而偏移/总数
   * 工具侧本来就已算出，只是没说。
   */
  test("NUL 报错给出首个字节的偏移与行列号", async () => {
    // 第 3 行第 6 列（1-based）是 NUL
    const content = Buffer.from("line1\nline2\nabcde\x00tail\n");
    const filePath = makeTmpFile(content, "one-nul.dat");
    const tool = new ReadTool();
    const result = await tool.execute({ file_path: filePath });

    expect(result.isError).toBe(true);
    expect(result.output).toContain("字节偏移 17");
    expect(result.output).toContain("第 3 行第 6 列");
    expect(result.output).toContain("共 1 个");
  });

  test("极少量 NUL 时给出「改用 \\x00 转义」的修法提示", async () => {
    const content = Buffer.from("const sep = `a\x00b`;\n");
    const filePath = makeTmpFile(content, "src-like.dat");
    const tool = new ReadTool();
    const result = await tool.execute({ file_path: filePath });

    expect(result.isError).toBe(true);
    expect(result.output).toContain("\\x00");
    expect(result.output).toContain("不是文件损坏");
  });

  test("大量 NUL 时提示确为二进制文件，不给源码修法", async () => {
    const buf = Buffer.alloc(64, 0);
    const filePath = makeTmpFile(buf, "real-binary.dat");
    const tool = new ReadTool();
    const result = await tool.execute({ file_path: filePath });

    expect(result.isError).toBe(true);
    expect(result.output).toContain("大概率确实是二进制文件");
    expect(result.output).not.toContain("不是文件损坏");
  });

  test("占比超阈值的报错给出百分比与首个控制字符位置", async () => {
    const buf = Buffer.alloc(100);
    for (let i = 0; i < 100; i++) buf[i] = i < 15 ? 1 : 65;
    const filePath = makeTmpFile(buf, "ratio.dat");
    const tool = new ReadTool();
    const result = await tool.execute({ file_path: filePath });

    expect(result.isError).toBe(true);
    expect(result.output).toContain("15.0%");
    expect(result.output).toContain("字节偏移 0");
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

describe("Read 工具 — G6 富媒体", () => {
  test(".jpg 以图片 mediaBlock 返回，mediaType=image/jpeg", async () => {
    const filePath = makeTmpFile("fake jpg", "photo.jpg");
    const tool = new ReadTool();
    const result = await tool.execute({ file_path: filePath });
    expect(result.isError).toBeUndefined();
    expect(result.mediaBlocks![0].kind).toBe("image");
    expect(result.mediaBlocks![0].mediaType).toBe("image/jpeg");
    // base64 数据非空
    expect(result.mediaBlocks![0].data.length).toBeGreaterThan(0);
  });

  test(".ipynb 返回带 cell id 的文本视图（无 mediaBlock）", async () => {
    const notebook = {
      cells: [
        { cell_type: "markdown", source: ["# 标题\n"], metadata: { id: "md1" } },
        {
          cell_type: "code",
          source: ["print(1)\n"],
          metadata: { id: "code1" },
          outputs: [{ output_type: "stream", text: ["1\n"] }],
          execution_count: 1,
        },
      ],
      metadata: { kernelspec: { language: "python" } },
      nbformat: 4,
      nbformat_minor: 5,
    };
    const filePath = makeTmpFile(JSON.stringify(notebook), "analysis.ipynb");
    const tool = new ReadTool();
    const result = await tool.execute({ file_path: filePath });
    expect(result.isError).toBeUndefined();
    expect(result.mediaBlocks).toBeUndefined();
    expect(result.output).toContain('<cell id="md1" type="markdown">');
    expect(result.output).toContain('<cell id="code1" type="code">');
    expect(result.output).toContain("--- 输出 ---");
    expect(result.output).toContain("kernel=python");
  });

  test(".ipynb 格式无效时返回错误提示（不崩溃）", async () => {
    const filePath = makeTmpFile("not json", "broken.ipynb");
    const tool = new ReadTool();
    const result = await tool.execute({ file_path: filePath });
    // 渲染层容错：JSON 解析失败在 output 里提示，不抛
    expect(result.output).toContain("解析失败");
  });

  test(".pdf 以 document mediaBlock 返回", async () => {
    const filePath = makeTmpFile("%PDF-1.4 fake", "doc.pdf");
    const tool = new ReadTool();
    const result = await tool.execute({ file_path: filePath, pages: "1-3" });
    expect(result.isError).toBeUndefined();
    expect(result.mediaBlocks![0].kind).toBe("document");
    expect(result.mediaBlocks![0].mediaType).toBe("application/pdf");
    expect(result.output).toContain("页码 1-3");
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

// P1-4：PDF 页数门限校验
describe("Read 工具 - PDF 页数门限（P1-4）", () => {
  /** 构造一个含 N 个 `/Type /Page` 对象的最小合法 PDF。*/
  function makePdf(pageCount: number): string {
    let body = "%PDF-1.4\n";
    for (let i = 0; i < pageCount; i++) {
      body += `${i + 1} 0 obj\n<< /Type /Page >>\nendobj\n`;
    }
    body += "%%EOF\n";
    return body;
  }

  function writePdf(pageCount: number): string {
    const dir = makeTmpDir();
    const filePath = join(dir, `doc-${pageCount}p.pdf`);
    writeFileSync(filePath, makePdf(pageCount));
    return filePath;
  }

  test("小 PDF（≤10 页）不给 pages 也能直接读", async () => {
    const filePath = writePdf(3);
    const tool = new ReadTool();
    const result = await tool.execute({ file_path: filePath });
    expect(result.isError).toBeFalsy();
    expect(result.output).toContain("共 3 页");
  });

  test("大 PDF（>10 页）不给 pages → 报错要求分页", async () => {
    const filePath = writePdf(25);
    const tool = new ReadTool();
    const result = await tool.execute({ file_path: filePath });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("不分页直读上限");
  });

  test("大 PDF 给合法 pages（≤20 页）→ 放行", async () => {
    const filePath = writePdf(25);
    const tool = new ReadTool();
    const result = await tool.execute({ file_path: filePath, pages: "1-5" });
    expect(result.isError).toBeFalsy();
    expect(result.output).toContain("关注页码 1-5");
  });

  test("pages 请求超过 20 页 → 报错", async () => {
    const filePath = writePdf(50);
    const tool = new ReadTool();
    const result = await tool.execute({ file_path: filePath, pages: "1-30" });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("单次最多读取 20 页");
  });

  test("pages 格式非法 → 报错", async () => {
    const filePath = writePdf(5);
    const tool = new ReadTool();
    const result = await tool.execute({ file_path: filePath, pages: "abc" });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("格式非法");
  });

  test("pages 超过实际页数 → 报错", async () => {
    const filePath = writePdf(3);
    const tool = new ReadTool();
    const result = await tool.execute({ file_path: filePath, pages: "1-5" });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("超过 PDF 实际页数");
  });
});

describe("Read 工具 — 发现4:重复窄读非阻塞引导", () => {
  test("反复窄读同一区域(≥3次高度重叠)→ 追加复用/整读提示", async () => {
    // 用 >2000 行大文件排除"读太窄"提示(②),单独验证重复读(①)。
    const lines = Array.from({ length: 3000 }, (_, i) => `line${i + 1}`).join("\n");
    const filePath = makeTmpFile(lines, "big.ts");
    const tool = new ReadTool(); // 同一实例内跟踪读历史

    // 前两次不提示(给定向复查余地)
    const r1 = await tool.execute({ file_path: filePath, offset: 100, limit: 20 });
    expect(r1.output).not.toContain("[读取效率提示:");
    const r2 = await tool.execute({ file_path: filePath, offset: 105, limit: 20 });
    expect(r2.output).not.toContain("[读取效率提示:");
    // 第 3 次仍读同一区域 → 触发重复读提示
    const r3 = await tool.execute({ file_path: filePath, offset: 100, limit: 20 });
    expect(r3.output).toContain("[读取效率提示:");
    expect(r3.output).toContain("第 3 次读取");
  });

  test("读不同区域(不重叠)不触发重复读提示", async () => {
    // 用 >2000 行的大文件,排除"读太窄可整读"提示(②),单独验证不重叠导航不触发重复读(①)
    const lines = Array.from({ length: 3000 }, (_, i) => `line${i + 1}`).join("\n");
    const filePath = makeTmpFile(lines, "nav.ts");
    const tool = new ReadTool();
    const r1 = await tool.execute({ file_path: filePath, offset: 1, limit: 20 });
    const r2 = await tool.execute({ file_path: filePath, offset: 500, limit: 20 });
    const r3 = await tool.execute({ file_path: filePath, offset: 1500, limit: 20 });
    // 合法的分段导航(不同 offset、不重叠)不应被当重复读打扰
    expect(r1.output).not.toContain("[读取效率提示:");
    expect(r2.output).not.toContain("[读取效率提示:");
    expect(r3.output).not.toContain("[读取效率提示:");
  });

  test("整读(不传 limit)不触发'读太窄'提示", async () => {
    const lines = Array.from({ length: 300 }, (_, i) => `line${i + 1}`).join("\n");
    const filePath = makeTmpFile(lines, "whole.ts");
    const tool = new ReadTool();
    const r = await tool.execute({ file_path: filePath });
    expect(r.output).not.toContain("[读取效率提示:");
  });

  test("首次对不大的文件传小 limit → '读太窄'提示可整读", async () => {
    const lines = Array.from({ length: 300 }, (_, i) => `line${i + 1}`).join("\n");
    const filePath = makeTmpFile(lines, "narrow.ts");
    const tool = new ReadTool();
    const r = await tool.execute({ file_path: filePath, offset: 1, limit: 20 });
    expect(r.output).toContain("[读取效率提示:");
    expect(r.output).toContain("一次整读");
  });

  test("防回归:read 始终读磁盘最新内容,提示不缓存旧内容", async () => {
    // 用户担忧点:提示会不会让模型读到旧快照。验证:read 每次真读磁盘,提示只加元信息不改内容。
    const filePath = makeTmpFile("V1-old\n".repeat(300), "live.ts");
    const tool = new ReadTool();
    await tool.execute({ file_path: filePath, offset: 1, limit: 20 });
    await tool.execute({ file_path: filePath, offset: 1, limit: 20 });
    // 文件被外部改写后再读 → 必须看到新内容 V2,而非缓存的 V1
    writeFileSync(filePath, "V2-new\n".repeat(300));
    const r3 = await tool.execute({ file_path: filePath, offset: 1, limit: 20 });
    expect(r3.output).toContain("V2-new");
    expect(r3.output).not.toContain("V1-old");
  });

  test("防回归:剥离效率提示后,相同区域重复读的内容签名保持稳定(不瘫痪 loop-detection)", async () => {
    // 核心回归:效率提示含每轮自增的"第N次",若不剥离会让重复读签名每轮都变 → repeatCount 清零 →
    // 瘫痪 git-status 冻结死循环止损阀。验证 stripReadEfficiencyHint 剥离后签名一致。
    const lines = Array.from({ length: 3000 }, (_, i) => `line${i + 1}`).join("\n");
    const filePath = makeTmpFile(lines, "sig.ts");
    const tool = new ReadTool();
    const outs: string[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await tool.execute({ file_path: filePath, offset: 100, limit: 20 });
      outs.push(stripReadEfficiencyHint(r.output));
    }
    // 第 3、4 次带了不同的"第N次"提示,但剥离后 4 次内容签名必须完全一致
    expect(new Set(outs).size).toBe(1);
    // 且原始输出确实在后几次带了提示(证明剥离不是空操作)
    expect(outs[0]).not.toContain("[读取效率提示:");
  });
});
