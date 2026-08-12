/**
 * 扩展加载器测试
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { ExtensionLoader } from "@sid-code/core/extension/loader.ts";
import { parseFrontmatter } from "@sid-code/core/extension/frontmatter.ts";

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

  // 审计第 4 条：缺闭合 / YAML 解析失败不再静默降级为"无 frontmatter"，
  // 必须回报 error 供消费方 fail-closed——否则 allowed-tools/model/tools 约束
  // 随解析失败一起消失（降级方向更宽松），且 YAML 原文被当指令喂给模型。
  test("frontmatter 缺少闭合标记 → 报 error（审计第 4 条）", () => {
    const content = `---
name: test
正文内容`;
    const result = parseFrontmatter(content);
    expect(result.frontmatter).toEqual({});
    expect(result.body).toBe(content);
    expect(result.error).toBeDefined();
    expect(result.error).toContain("缺少闭合分隔符");
  });

  test("只有一行 --- → 报 error（审计第 4 条）", () => {
    const result = parseFrontmatter("---");
    expect(result.error).toContain("缺少闭合分隔符");
  });

  test("YAML 解析失败 → 报 error（审计第 4 条）", () => {
    const content = `---
: invalid: yaml: [
---
正文`;
    const result = parseFrontmatter(content);
    expect(result.frontmatter).toEqual({});
    expect(result.error).toBeDefined();
  });

  test("合法的「本来就没有 frontmatter」不报 error（防误判）", () => {
    // 这条是关键对照：fail-closed 不能把"用户没写 frontmatter"也当成错误，
    // 否则会把大量合法的纯 markdown 扩展文件全部拒绝加载。
    expect(parseFrontmatter("这是普通 markdown 内容").error).toBeUndefined();
    expect(parseFrontmatter("# 标题\n\n正文 --- 中间有横线").error).toBeUndefined();
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
  // 隔离 user 级配置根：把 ~/.sid-code 与 ~/.claude 都指向临时目录，
  // 避免真实机器上的用户级扩展（~/.claude/commands 等）污染 project 级断言。
  let prevSidHome: string | undefined;
  let prevClaudeHome: string | undefined;
  let userHomeDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `ext-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
    userHomeDir = join(testDir, "__user_home__");
    prevSidHome = process.env.SID_CONFIG_DIR;
    prevClaudeHome = process.env.CLAUDE_CONFIG_DIR;
    process.env.SID_CONFIG_DIR = join(userHomeDir, ".sid-code");
    process.env.CLAUDE_CONFIG_DIR = join(userHomeDir, ".claude");
    loader = new ExtensionLoader();
  });

  afterEach(() => {
    if (prevSidHome === undefined) delete process.env.SID_CONFIG_DIR;
    else process.env.SID_CONFIG_DIR = prevSidHome;
    if (prevClaudeHome === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prevClaudeHome;
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
    writeFileSync(
      join(cmdDir, "test.md"),
      `---
description: 测试命令
---
这是测试命令的内容`,
    );

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

  // ── P1-6：.claude/{type} 兼容读取 ──
  test("P1-6 项目级 .claude/commands 被兼容读取", async () => {
    const claudeDir = join(testDir, ".claude", "commands");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, "deploy.md"), "部署命令");

    const files = await loader.scan("commands", testDir);
    const deploy = files.find((f) => f.name === "deploy");
    expect(deploy).toBeDefined();
    expect(deploy!.rawContent).toBe("部署命令");
  });

  test("P1-6 同名时 .sid-code 优先于 .claude", async () => {
    const claudeDir = join(testDir, ".claude", "commands");
    const sidDir = join(testDir, ".sid-code", "commands");
    mkdirSync(claudeDir, { recursive: true });
    mkdirSync(sidDir, { recursive: true });
    writeFileSync(join(claudeDir, "deploy.md"), "claude 版本");
    writeFileSync(join(sidDir, "deploy.md"), "sid-code 版本");

    const files = await loader.scan("commands", testDir);
    const deploy = files.find((f) => f.name === "deploy");
    expect(deploy).toBeDefined();
    // .sid-code 优先
    expect(deploy!.rawContent).toBe("sid-code 版本");
    // 只保留一个 deploy（去重）
    expect(files.filter((f) => f.name === "deploy").length).toBe(1);
  });

  test("P1-6 .claude/skills 同理兼容", async () => {
    const claudeSkills = join(testDir, ".claude", "skills");
    mkdirSync(claudeSkills, { recursive: true });
    writeFileSync(join(claudeSkills, "mySkill.md"), "技能内容");

    const files = await loader.scan("skills", testDir);
    expect(files.find((f) => f.name === "mySkill")).toBeDefined();
  });
});
