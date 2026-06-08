/**
 * Ls 工具测试
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { LsTool } from "../../src/tool/ls.ts";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
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
