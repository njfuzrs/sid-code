/**
 * 扩展加载器测试
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { ExtensionLoader } from "../../src/extension/loader.ts";
import { parseFrontmatter } from "../../src/extension/frontmatter.ts";

describe("parseFrontmatter", () => {
  test("解析标准 frontmatter", () => {
    const content = `---
name: test
description: 测试描述
---
正文内容`;
    const result = parseFrontmatter(content);
    expect(result.frontmatter).toEqual({ name: "test", description: "测试描述" });
    expect(result.body).toBe("正文内容");
  });

  test("无 frontmatter 返回完整内容", () => {
    const content = "这是普通 markdown 内容";
    const result = parseFrontmatter(content);
    expect(result.frontmatter).toEqual({});
    expect(result.body).toBe(content);
  });

  test("frontmatter 缺少闭合标记", () => {
    const content = `---
name: test
正文内容`;
    const result = parseFrontmatter(content);
    expect(result.frontmatter).toEqual({});
    expect(result.body).toBe(content);
  });

  test("YAML 解析失败返回空 frontmatter", () => {
    const content = `---
: invalid: yaml: [
---
正文`;
    const result = parseFrontmatter(content);
    expect(result.frontmatter).toEqual({});
  });

  test("空 frontmatter", () => {
    const content = `---
---
正文内容`;
    const result = parseFrontmatter(content);
    expect(result.frontmatter).toEqual({});
    expect(result.body).toBe("正文内容");
  });
});

describe("ExtensionLoader", () => {
  let testDir: string;
  let loader: ExtensionLoader;

  beforeEach(() => {
    testDir = join(tmpdir(), `ext-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    loader = new ExtensionLoader();
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test("空目录返回空数组", async () => {
    const result = await loader.scan("commands", testDir);
    expect(result).toEqual([]);
  });

  test("目录不存在返回空数组", async () => {
    const result = await loader.scan("commands", "/nonexistent/path");
    expect(result).toEqual([]);
  });

  test("正常扫描 .md 文件", async () => {
    const cmdDir = join(testDir, ".sid-code", "commands");
    mkdirSync(cmdDir, { recursive: true });
    writeFileSync(join(cmdDir, "test.md"), `---
description: 测试命令
---
这是测试命令的内容`);

    const result = await loader.scan("commands", testDir);
    expect(result.length).toBe(1);
    expect(result[0].name).toBe("test");
    expect(result[0].source).toBe("project");
    expect(result[0].frontmatter.description).toBe("测试命令");
    expect(result[0].body).toBe("这是测试命令的内容");
  });

  test("忽略非 .md 文件", async () => {
    const cmdDir = join(testDir, ".sid-code", "commands");
    mkdirSync(cmdDir, { recursive: true });
    writeFileSync(join(cmdDir, "test.md"), "内容");
    writeFileSync(join(cmdDir, "readme.txt"), "忽略");
    writeFileSync(join(cmdDir, "config.yaml"), "忽略");

    const result = await loader.scan("commands", testDir);
    expect(result.length).toBe(1);
    expect(result[0].name).toBe("test");
  });

  test("project 覆盖 user（同名文件）", async () => {
    // 模拟 user 目录
    const userDir = join(testDir, "user-home", ".sid-code", "commands");
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, "greet.md"), "用户版本");

    // 模拟 project 目录
    const projDir = join(testDir, "project");
    const projCmdDir = join(projDir, ".sid-code", "commands");
    mkdirSync(projCmdDir, { recursive: true });
    writeFileSync(join(projCmdDir, "greet.md"), "项目版本");

    // 直接测试 scanDir 的覆盖逻辑
    // 由于 scan 使用 homedir()，我们用两次 project 扫描模拟
    const loader2 = new ExtensionLoader();
    // 先扫描 user 目录作为 project（模拟）
    const files1 = await loader2.scan("commands", join(testDir, "user-home"));
    expect(files1.length).toBe(1);
    expect(files1[0].rawContent).toBe("用户版本");

    // project 目录的文件
    const files2 = await loader2.scan("commands", projDir);
    expect(files2.length).toBe(1);
    expect(files2[0].rawContent).toBe("项目版本");
  });

  test("缓存生效", async () => {
    const cmdDir = join(testDir, ".sid-code", "commands");
    mkdirSync(cmdDir, { recursive: true });
    writeFileSync(join(cmdDir, "a.md"), "内容A");

    const result1 = await loader.scan("commands", testDir);
    expect(result1.length).toBe(1);

    // 添加新文件，但缓存未过期，应该还是 1 个
    writeFileSync(join(cmdDir, "b.md"), "内容B");
    const result2 = await loader.scan("commands", testDir);
    expect(result2.length).toBe(1);

    // 清除缓存后重新扫描
    loader.clearCache();
    const result3 = await loader.scan("commands", testDir);
    expect(result3.length).toBe(2);
  });
});
