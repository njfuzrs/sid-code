/**
 * Ls 工具测试
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { LsTool } from "@sid-code/core/tool/ls.ts";
import { mkdirSync, writeFileSync, rmSync, existsSync, symlinkSync } from "fs";
import { join } from "path";
import os from "os";

const TMP = join(os.tmpdir(), "sid-code-ls-test");

beforeAll(() => {
  // 创建测试目录结构
  mkdirSync(join(TMP, "subdir-a"), { recursive: true });
  mkdirSync(join(TMP, "subdir-b"), { recursive: true });
  writeFileSync(join(TMP, "file-a.ts"), "content a");
  writeFileSync(join(TMP, "file-b.json"), '{"key":"value"}');
  writeFileSync(join(TMP, "README.md"), "# readme");
  writeFileSync(join(TMP, ".hidden"), "hidden");
});

afterAll(() => {
  if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
});

describe("LsTool - 基本功能", () => {
  const tool = new LsTool();

  test("列举目录，目录排在文件前面", async () => {
    const result = await tool.execute({ dir_path: TMP });
    expect(result.isError).toBeFalsy();
    const lines = result.output.split("\n");
    // 找到第一个 [目录] 和第一个文件行的位置
    const firstDirIdx = lines.findIndex((l) => l.startsWith("[目录]"));
    const firstFileIdx = lines.findIndex((l) => !l.startsWith("[目录]") && !l.startsWith("目录列表") && l.trim() !== "" && !l.startsWith("共"));
    expect(firstDirIdx).toBeGreaterThanOrEqual(0);
    expect(firstDirIdx).toBeLessThan(firstFileIdx);
  });

  test("同类按字母升序排列", async () => {
    const result = await tool.execute({ dir_path: TMP });
    expect(result.isError).toBeFalsy();
    const lines = result.output.split("\n");
    const dirLines = lines.filter((l) => l.startsWith("[目录]")).map((l) => l.replace("[目录] ", "").replace("/", ""));
    // subdir-a 应在 subdir-b 前面
    expect(dirLines.indexOf("subdir-a")).toBeLessThan(dirLines.indexOf("subdir-b"));
  });

  test("显示文件大小", async () => {
    const result = await tool.execute({ dir_path: TMP });
    expect(result.isError).toBeFalsy();
    // 文件行应包含括号内的大小
    expect(result.output).toMatch(/\(\d+(\.\d+)? (B|KB|MB)\)/);
  });

  test("输出包含汇总行", async () => {
    const result = await tool.execute({ dir_path: TMP });
    expect(result.isError).toBeFalsy();
    expect(result.output).toContain("共");
    expect(result.output).toContain("个目录");
    expect(result.output).toContain("个文件");
  });
});

describe("LsTool - 错误处理", () => {
  const tool = new LsTool();

  test("路径不存在时返回错误", async () => {
    const result = await tool.execute({ dir_path: "/nonexistent/path/xyz" });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("不存在");
  });

  test("路径是文件时返回错误", async () => {
    const file = join(TMP, "file-a.ts");
    const result = await tool.execute({ dir_path: file });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("不是目录");
  });

  // 注：非绝对路径检查已移除，normalizeToolPath() 自动将相对路径转为绝对路径
  // 这是"路径处理缺失"修复的一部分（详见 docs/bugfixes/todo/ReadTool-路径处理缺失-弱模型路径纠错能力不足.md §方案 E）
});

describe("LsTool - 空目录", () => {
  const tool = new LsTool();

  test("空目录返回提示", async () => {
    const emptyDir = join(TMP, "empty-dir");
    mkdirSync(emptyDir, { recursive: true });
    const result = await tool.execute({ dir_path: emptyDir });
    expect(result.isError).toBeFalsy();
    expect(result.output).toContain("目录为空");
  });
});

describe("LsTool - ignore 参数", () => {
  const tool = new LsTool();

  test("指定 ignore 后对应文件不出现", async () => {
    const result = await tool.execute({ dir_path: TMP, ignore: ["*.md"] });
    expect(result.isError).toBeFalsy();
    expect(result.output).not.toContain("README.md");
  });

  test("默认忽略 .git 和 node_modules", async () => {
    // 创建 node_modules 目录
    const nmDir = join(TMP, "node_modules");
    mkdirSync(nmDir, { recursive: true });
    const result = await tool.execute({ dir_path: TMP });
    expect(result.isError).toBeFalsy();
    expect(result.output).not.toContain("node_modules");
    rmSync(nmDir, { recursive: true, force: true });
  });
});

describe("LsTool - 符号链接（P0：断链不静默丢弃）", () => {
  const tool = new LsTool();
  const LINK_DIR = join(os.tmpdir(), "sid-code-ls-link-test");

  beforeAll(() => {
    mkdirSync(join(LINK_DIR, "real-dir"), { recursive: true });
    writeFileSync(join(LINK_DIR, "real-file"), "hi");
    writeFileSync(join(LINK_DIR, "z-normal.txt"), "normal");
    symlinkSync(join(LINK_DIR, "real-dir"), join(LINK_DIR, "link-to-dir"));
    symlinkSync(join(LINK_DIR, "real-file"), join(LINK_DIR, "link-to-file"));
    symlinkSync("/nonexistent/target", join(LINK_DIR, "broken-link"));
    // 循环符号链接
    symlinkSync(join(LINK_DIR, "loop-b"), join(LINK_DIR, "loop-a"));
    symlinkSync(join(LINK_DIR, "loop-a"), join(LINK_DIR, "loop-b"));
  });

  afterAll(() => {
    if (existsSync(LINK_DIR)) rmSync(LINK_DIR, { recursive: true, force: true });
  });

  test("断链与循环链接被列出而非静默丢弃", async () => {
    const result = await tool.execute({ dir_path: LINK_DIR });
    expect(result.isError).toBeFalsy();
    // 8 个条目全部出现，断链/循环链接不丢失
    expect(result.output).toContain("broken-link");
    expect(result.output).toContain("loop-a");
    expect(result.output).toContain("loop-b");
    expect(result.output).toContain("[断链]");
    // 计数：3 个断链（broken + loop-a + loop-b）
    expect(result.output).toContain("3 个断链");
  });

  test("符号链接被标注目标而非伪装成普通文件/目录", async () => {
    const result = await tool.execute({ dir_path: LINK_DIR });
    expect(result.output).toContain("[链接→目录] link-to-dir/");
    expect(result.output).toContain("[链接→文件] link-to-file");
    expect(result.output).toContain("2 个符号链接");
  });

  test("循环链接与真断链措辞区分(ELOOP vs ENOENT)", async () => {
    const result = await tool.execute({ dir_path: LINK_DIR });
    // broken-link 指向不存在目标 → "目标不存在"
    expect(result.output).toMatch(/broken-link.*目标不存在/);
    // loop-a/loop-b 互指 → "循环符号链接"
    expect(result.output).toMatch(/loop-[ab].*循环符号链接/);
  });

  test("指向目录的符号链接可作为 dir_path 传入并列举", async () => {
    const result = await tool.execute({ dir_path: join(LINK_DIR, "link-to-dir") });
    expect(result.isError).toBeFalsy();
    expect(result.output).toContain("目录为空");
  });
});

describe("LsTool - 截断保护（P0：超大目录不灌爆上下文）", () => {
  const tool = new LsTool();
  const BIG_DIR = join(os.tmpdir(), "sid-code-ls-big-test");

  beforeAll(() => {
    mkdirSync(BIG_DIR, { recursive: true });
    for (let i = 0; i < 1200; i++) {
      writeFileSync(join(BIG_DIR, `f${i}.txt`), "");
    }
  });

  afterAll(() => {
    if (existsSync(BIG_DIR)) rmSync(BIG_DIR, { recursive: true, force: true });
  });

  test("超过 1000 项时截断并给出提示", async () => {
    const result = await tool.execute({ dir_path: BIG_DIR });
    expect(result.isError).toBeFalsy();
    expect(result.output).toContain("目录条目过多");
    expect(result.output).toContain("仅显示前 1000 项");
    // 实际展示行数受限：不应出现全部 1200 个文件
    const fileLines = result.output.split("\n").filter((l) => /^f\d+\.txt/.test(l));
    expect(fileLines.length).toBe(1000);
  });
});

describe("LsTool - 目录不存在纠错（P1：掉 repo 段建议）", () => {
  const tool = new LsTool();

  test("路径缺少当前仓库目录段时给出纠错建议", async () => {
    // 构造一个存在的子目录，再造一个"掉了最后一级 cwd 段"的错误路径
    const cwd = process.cwd();
    const realSub = join(cwd, "src");
    if (!existsSync(realSub)) return; // 防御：src 不存在则跳过断言
    // cwd = /.../sid-code，请求 /.../src（掉了 sid-code 段）
    const parent = join(cwd, "..");
    const wrong = join(parent, "src");
    const result = await tool.execute({ dir_path: wrong });
    if (result.isError) {
      expect(result.output).toContain("是否想找");
    }
  });
});

describe("LsTool - 字符级截断（P1：长文件名不撑爆）", () => {
  const tool = new LsTool();
  const LONG_DIR = join(os.tmpdir(), "sid-code-ls-long-test");

  beforeAll(() => {
    mkdirSync(LONG_DIR, { recursive: true });
    // 1000 个短于 1000 项上限、但文件名极长的文件 → 条目数不超限而字符数溢出
    const longName = "x".repeat(200);
    for (let i = 0; i < 1000; i++) {
      writeFileSync(join(LONG_DIR, `${longName}${i}.txt`), "");
    }
  });

  afterAll(() => {
    if (existsSync(LONG_DIR)) rmSync(LONG_DIR, { recursive: true, force: true });
  });

  test("条目数未超限但字符溢出时按字符截断", async () => {
    const result = await tool.execute({ dir_path: LONG_DIR });
    expect(result.isError).toBeFalsy();
    // 输出字符数受硬上限约束（留一定裕度）
    expect(result.output.length).toBeLessThan(110_000);
    expect(result.output).toContain("目录输出过大");
  });
});

describe("LsTool - abort signal（P1：可中断，对齐 grep/glob）", () => {
  const tool = new LsTool();
  const DIR = join(os.tmpdir(), "sid-code-ls-abort-test");

  beforeAll(() => {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(join(DIR, "a.txt"), "a");
  });

  afterAll(() => {
    if (existsSync(DIR)) rmSync(DIR, { recursive: true, force: true });
  });

  test("已 abort 的 signal 立即返回取消", async () => {
    const ac = new AbortController();
    ac.abort();
    const result = await tool.execute({ dir_path: DIR }, ac.signal);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("取消");
  });

  test("未 abort 时正常列举", async () => {
    const ac = new AbortController();
    const result = await tool.execute({ dir_path: DIR }, ac.signal);
    expect(result.isError).toBeFalsy();
    expect(result.output).toContain("a.txt");
  });
});
