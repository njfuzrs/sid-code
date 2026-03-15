/**
 * 自定义命令测试
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { CustomCommand, CustomCommandLoader } from "../../src/command/custom.ts";
import { ExtensionLoader } from "../../src/extension/loader.ts";

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
    let captured = "";
    const ctx = {
      sendToLLM: async (text: string) => { captured = text; },
    } as any;

    await cmd.execute("张三 北京", ctx);
    expect(captured).toBe("你好 张三，欢迎来到 北京");
  });

  test("$@ 替换为所有参数", async () => {
    const cmd = new CustomCommand("ask", "提问", "请回答: $@");
    let captured = "";
    const ctx = {
      sendToLLM: async (text: string) => { captured = text; },
    } as any;

    await cmd.execute("什么是 TypeScript", ctx);
    expect(captured).toBe("请回答: 什么是 TypeScript");
  });

  test("无 sendToLLM 时降级输出", async () => {
    const cmd = new CustomCommand("test", "", "内容");
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: any[]) => logs.push(args.join(" "));

    await cmd.execute("", {} as any);
    console.log = origLog;

    expect(logs).toContain("内容");
  });

  test("缺少的参数替换为空字符串", async () => {
    const cmd = new CustomCommand("test", "", "参数1=$1 参数2=$2");
    let captured = "";
    const ctx = {
      sendToLLM: async (text: string) => { captured = text; },
    } as any;

    await cmd.execute("只有一个", ctx);
    expect(captured).toBe("参数1=只有一个 参数2=");
  });
});

describe("CustomCommandLoader", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `cmd-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test("加载自定义命令", async () => {
    const cmdDir = join(testDir, ".sid-code", "commands");
    mkdirSync(cmdDir, { recursive: true });
    writeFileSync(join(cmdDir, "review.md"), `---
description: 代码审查
---
请审查以下代码: $@`);

    const loader = new CustomCommandLoader(new ExtensionLoader());
    const cmds = await loader.loadAll(testDir);
    expect(cmds.length).toBe(1);
    expect(cmds[0].name()).toBe("review");
    expect(cmds[0].description()).toBe("代码审查");
  });

  test("过滤保护命令名", async () => {
    const cmdDir = join(testDir, ".sid-code", "commands");
    mkdirSync(cmdDir, { recursive: true });
    writeFileSync(join(cmdDir, "help.md"), "覆盖帮助");
    writeFileSync(join(cmdDir, "exit.md"), "覆盖退出");
    writeFileSync(join(cmdDir, "custom.md"), "自定义命令");

    const loader = new CustomCommandLoader(new ExtensionLoader());
    const cmds = await loader.loadAll(testDir);
    expect(cmds.length).toBe(1);
    expect(cmds[0].name()).toBe("custom");
  });

  test("HTML 注释作为描述（无 frontmatter）", async () => {
    const cmdDir = join(testDir, ".sid-code", "commands");
    mkdirSync(cmdDir, { recursive: true });
    writeFileSync(join(cmdDir, "deploy.md"), `<!-- 部署到生产环境 -->
执行部署流程 $@`);

    const loader = new CustomCommandLoader(new ExtensionLoader());
    const cmds = await loader.loadAll(testDir);
    expect(cmds.length).toBe(1);
    expect(cmds[0].description()).toBe("部署到生产环境");
  });

  test("空目录返回空数组", async () => {
    const loader = new CustomCommandLoader(new ExtensionLoader());
    const cmds = await loader.loadAll(testDir);
    expect(cmds.length).toBe(0);
  });
});
