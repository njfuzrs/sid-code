/**
 * 自定义命令测试
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { CustomCommand, CustomCommandLoader, parseCustomCommandOptions } from "@sid-code/cli/command/custom.ts";
import { ExtensionLoader } from "@sid-code/core/extension/loader.ts";

describe("CustomCommand", () => {
  test("命令名和描述", () => {
    const cmd = new CustomCommand("review", "代码审查", "请审查以下代码");
    expect(cmd.name()).toBe("review");
    expect(cmd.description()).toBe("代码审查");
    expect(cmd.aliases()).toEqual([]);
  });

  test("无描述时使用默认描述", () => {
    const cmd = new CustomCommand("test", "", "内容");
    expect(cmd.description()).toBe("自定义命令: test");
  });

  test("$1 $2 参数替换", async () => {
    const cmd = new CustomCommand("greet", "问候", "你好 $1，欢迎来到 $2");
    const result = await cmd.execute("张三 北京", {} as any);
    expect(result.kind).toBe("submit_prompt");
    expect(result.prompt).toBe("你好 张三，欢迎来到 北京");
  });

  test("$@ 替换为所有参数", async () => {
    const cmd = new CustomCommand("ask", "提问", "请回答: $@");
    const result = await cmd.execute("什么是 TypeScript", {} as any);
    expect(result.kind).toBe("submit_prompt");
    expect(result.prompt).toBe("请回答: 什么是 TypeScript");
  });

  test("{{args}} 新语法替换", async () => {
    const cmd = new CustomCommand("ask", "提问", "请回答: {{args}}");
    const result = await cmd.execute("什么是 TypeScript", {} as any);
    expect(result.kind).toBe("submit_prompt");
    expect(result.prompt).toBe("请回答: 什么是 TypeScript");
  });

  test("$ARGUMENTS 字面量替换（CC 迁移兼容）", async () => {
    const cmd = new CustomCommand("ask", "提问", "请回答: $ARGUMENTS");
    const result = await cmd.execute("什么是 TypeScript", {} as any);
    expect(result.kind).toBe("submit_prompt");
    expect(result.prompt).toBe("请回答: 什么是 TypeScript");
  });

  test("$ARGUMENTS 与 $1 混用（\\b 边界不误伤）", async () => {
    const cmd = new CustomCommand("t", "", "全部=$ARGUMENTS 第一个=$1");
    const result = await cmd.execute("alpha beta", {} as any);
    expect(result.prompt).toBe("全部=alpha beta 第一个=alpha");
  });

  test("$ARGUMENTS 空参数替换为空", async () => {
    const cmd = new CustomCommand("t", "", "内容:[$ARGUMENTS]");
    const result = await cmd.execute("", {} as any);
    expect(result.prompt).toBe("内容:[]");
  });

  test("缺少的参数替换为空字符串", async () => {
    const cmd = new CustomCommand("test", "", "参数1=$1 参数2=$2");
    const result = await cmd.execute("只有一个", {} as any);
    expect(result.kind).toBe("submit_prompt");
    expect(result.prompt).toBe("参数1=只有一个 参数2=");
  });
});

describe("CustomCommandLoader", () => {
  let testDir: string;
  let homeDir: string;
  let prevClaude: string | undefined;
  let prevSid: string | undefined;

  beforeEach(() => {
    testDir = join(tmpdir(), `cmd-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    // 隔离用户级目录（否则 loadAll 会扫到真实 ~/.claude/commands 与 ~/.sid-code/commands，
    // 污染 length 断言）。指向空临时目录。
    homeDir = join(testDir, "__home__");
    mkdirSync(homeDir, { recursive: true });
    prevClaude = process.env.CLAUDE_CONFIG_DIR;
    prevSid = process.env.SID_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = join(homeDir, ".claude");
    process.env.SID_CONFIG_DIR = join(homeDir, ".sid-code");
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    if (prevClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prevClaude;
    if (prevSid === undefined) delete process.env.SID_CONFIG_DIR;
    else process.env.SID_CONFIG_DIR = prevSid;
  });

  test("加载自定义命令", async () => {
    const cmdDir = join(testDir, ".sid-code", "commands");
    mkdirSync(cmdDir, { recursive: true });
    writeFileSync(join(cmdDir, "review.md"), `---
description: 代码审查
---
请审查以下代码: $@`);

    const loader = new CustomCommandLoader(new ExtensionLoader());
    const results = await loader.loadAll(testDir);
    expect(results.length).toBe(1);
    expect(results[0].cmd.name()).toBe("review");
    expect(results[0].cmd.description()).toBe("代码审查");
    expect(results[0].source).toBe("project");
  });

  test("过滤保护命令名", async () => {
    const cmdDir = join(testDir, ".sid-code", "commands");
    mkdirSync(cmdDir, { recursive: true });
    writeFileSync(join(cmdDir, "help.md"), "覆盖帮助");
    writeFileSync(join(cmdDir, "exit.md"), "覆盖退出");
    writeFileSync(join(cmdDir, "custom.md"), "自定义命令");

    const loader = new CustomCommandLoader(new ExtensionLoader());
    const results = await loader.loadAll(testDir);
    expect(results.length).toBe(1);
    expect(results[0].cmd.name()).toBe("custom");
  });

  test("HTML 注释作为描述（无 frontmatter）", async () => {
    const cmdDir = join(testDir, ".sid-code", "commands");
    mkdirSync(cmdDir, { recursive: true });
    writeFileSync(join(cmdDir, "deploy.md"), `<!-- 部署到生产环境 -->
执行部署流程 $@`);

    const loader = new CustomCommandLoader(new ExtensionLoader());
    const results = await loader.loadAll(testDir);
    expect(results.length).toBe(1);
    expect(results[0].cmd.description()).toBe("部署到生产环境");
  });

  test("空目录返回空数组", async () => {
    const loader = new CustomCommandLoader(new ExtensionLoader());
    const results = await loader.loadAll(testDir);
    expect(results.length).toBe(0);
  });
});

// ── P2-2：frontmatter 高级字段 ──
describe("P2-2 parseCustomCommandOptions", () => {
  test("解析 argument-hint（连字符 key）", () => {
    const o = parseCustomCommandOptions({ "argument-hint": "<pr-number>" });
    expect(o.argumentHint).toBe("<pr-number>");
  });

  test("驼峰 argumentHint 亦兼容", () => {
    const o = parseCustomCommandOptions({ argumentHint: "hint2" });
    expect(o.argumentHint).toBe("hint2");
  });

  test("allowed-tools 逗号分隔字符串", () => {
    const o = parseCustomCommandOptions({ "allowed-tools": "read, grep , bash" });
    expect(o.allowedTools).toEqual(["read", "grep", "bash"]);
  });

  test("allowed-tools 数组", () => {
    const o = parseCustomCommandOptions({ "allowed-tools": ["read", "edit"] });
    expect(o.allowedTools).toEqual(["read", "edit"]);
  });

  test("model 字段", () => {
    const o = parseCustomCommandOptions({ model: "claude-opus-4" });
    expect(o.model).toBe("claude-opus-4");
  });

  test("空 frontmatter → 空 options", () => {
    const o = parseCustomCommandOptions({});
    expect(o.argumentHint).toBeUndefined();
    expect(o.allowedTools).toBeUndefined();
    expect(o.model).toBeUndefined();
  });
});

describe("P2-2 CustomCommand 高级字段生效", () => {
  let testDir: string;
  let prevClaude: string | undefined;
  let prevSid: string | undefined;
  beforeEach(() => {
    testDir = join(tmpdir(), `cmd-p22-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    // 隔离用户级目录，同 CustomCommandLoader describe。
    prevClaude = process.env.CLAUDE_CONFIG_DIR;
    prevSid = process.env.SID_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = join(testDir, "__home__", ".claude");
    process.env.SID_CONFIG_DIR = join(testDir, "__home__", ".sid-code");
  });
  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    if (prevClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prevClaude;
    if (prevSid === undefined) delete process.env.SID_CONFIG_DIR;
    else process.env.SID_CONFIG_DIR = prevSid;
  });

  test("argumentHint() 透出 frontmatter 值", () => {
    const cmd = new CustomCommand("pr", "创建 PR", "body", { argumentHint: "<title>" });
    expect(cmd.argumentHint()).toBe("<title>");
  });

  test("未声明 hint 时 argumentHint() 为空串", () => {
    const cmd = new CustomCommand("x", "d", "b");
    expect(cmd.argumentHint()).toBe("");
  });

  test("无 allowed-tools/model 走 inline submit_prompt", async () => {
    const cmd = new CustomCommand("ask", "d", "回答 $@", {});
    const r = await cmd.execute("hi", {} as any);
    expect(r.kind).toBe("submit_prompt");
  });

  test("声明 allowed-tools 但无 providerRegistry 时回退 inline", async () => {
    const cmd = new CustomCommand("scan", "d", "扫描 $@", { allowedTools: ["read"] });
    // ctx 无 providerRegistry → 回退 inline，保证命令可用
    const r = await cmd.execute("src", {} as any);
    expect(r.kind).toBe("submit_prompt");
    expect(r.prompt).toBe("扫描 src");
  });

  test("loadAll 应用 frontmatter 高级字段", async () => {
    const cmdDir = join(testDir, ".sid-code", "commands");
    mkdirSync(cmdDir, { recursive: true });
    writeFileSync(
      join(cmdDir, "review.md"),
      `---
description: 代码审查
argument-hint: "<file>"
allowed-tools: read, grep
model: claude-opus-4
---
审查文件 $1`,
    );
    const loader = new CustomCommandLoader(new ExtensionLoader());
    const results = await loader.loadAll(testDir);
    // 按名精确定位（loadAll 亦会扫描用户 home 下命令，不能断言总数）。
    const review = results.find((r) => r.cmd.name() === "review");
    expect(review).toBeDefined();
    expect(review!.cmd.description()).toBe("代码审查");
    expect(review!.cmd.argumentHint()).toBe("<file>");
  });
});
