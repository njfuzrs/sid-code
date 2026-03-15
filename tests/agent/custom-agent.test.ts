/**
 * 自定义 Agent 测试
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { CustomAgentLoader, CustomAgentTool } from "../../src/agent/custom.ts";
import { ExtensionLoader } from "../../src/extension/loader.ts";

describe("CustomAgentLoader", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `agent-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test("加载 Agent 定义", async () => {
    const agentDir = join(testDir, ".sid-code", "agents");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "checker.md"), `---
name: code-checker
description: 代码检查代理
tools: read, grep, glob
---
你是一个代码检查代理。检查代码中的问题并报告。`);

    const loader = new CustomAgentLoader(new ExtensionLoader());
    const agents = await loader.loadAll(testDir);
    expect(agents.length).toBe(1);
    expect(agents[0].name).toBe("code-checker");
    expect(agents[0].description).toBe("代码检查代理");
    expect(agents[0].tools).toEqual(["read", "grep", "glob"]);
    expect(agents[0].prompt).toContain("代码检查代理");
  });

  test("文件名作为默认 name", async () => {
    const agentDir = join(testDir, ".sid-code", "agents");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "helper.md"), `---
description: 辅助代理
---
帮助完成任务`);

    const loader = new CustomAgentLoader(new ExtensionLoader());
    const agents = await loader.loadAll(testDir);
    expect(agents[0].name).toBe("helper");
  });

  test("tools 数组格式", async () => {
    const agentDir = join(testDir, ".sid-code", "agents");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "writer.md"), `---
description: 写作代理
tools:
  - read
  - write
  - edit
---
内容`);

    const loader = new CustomAgentLoader(new ExtensionLoader());
    const agents = await loader.loadAll(testDir);
    expect(agents[0].tools).toEqual(["read", "write", "edit"]);
  });

  test("空目录返回空数组", async () => {
    const loader = new CustomAgentLoader(new ExtensionLoader());
    const agents = await loader.loadAll(testDir);
    expect(agents.length).toBe(0);
  });

  test("无 tools 字段默认空数组", async () => {
    const agentDir = join(testDir, ".sid-code", "agents");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "simple.md"), `---
description: 简单代理
---
只做文本处理`);

    const loader = new CustomAgentLoader(new ExtensionLoader());
    const agents = await loader.loadAll(testDir);
    expect(agents[0].tools).toEqual([]);
  });
});

describe("CustomAgentTool", () => {
  test("name 前缀", () => {
    const def = {
      name: "checker",
      description: "检查代理",
      tools: ["read", "grep"],
      prompt: "检查代码",
      source: "project" as const,
      filePath: "/test/checker.md",
    };
    const tool = new CustomAgentTool(def, {} as any, "test-model", {} as any);
    expect(tool.name()).toBe("agent__checker");
  });

  test("description", () => {
    const def = {
      name: "checker",
      description: "检查代理",
      tools: [],
      prompt: "内容",
      source: "project" as const,
      filePath: "/test.md",
    };
    const tool = new CustomAgentTool(def, {} as any, "m", {} as any);
    expect(tool.description()).toBe("检查代理");
  });

  test("无描述时使用默认描述", () => {
    const def = {
      name: "test",
      description: "",
      tools: [],
      prompt: "内容",
      source: "project" as const,
      filePath: "/test.md",
    };
    const tool = new CustomAgentTool(def, {} as any, "m", {} as any);
    expect(tool.description()).toBe("自定义 Agent: test");
  });

  test("inputSchema 包含 task 参数", () => {
    const def = {
      name: "test",
      description: "测试",
      tools: [],
      prompt: "内容",
      source: "project" as const,
      filePath: "/test.md",
    };
    const tool = new CustomAgentTool(def, {} as any, "m", {} as any);
    const schema = tool.inputSchema();
    expect(schema.type).toBe("object");
    expect((schema.properties as any).task).toBeDefined();
    expect(schema.required).toEqual(["task"]);
  });

  test("readOnly 根据 tools 判断", () => {
    const readDef = {
      name: "reader",
      description: "",
      tools: ["read", "grep"],
      prompt: "",
      source: "project" as const,
      filePath: "",
    };
    const writeDef = {
      name: "writer",
      description: "",
      tools: ["read", "write"],
      prompt: "",
      source: "project" as const,
      filePath: "",
    };

    const readTool = new CustomAgentTool(readDef, {} as any, "m", {} as any);
    const writeTool = new CustomAgentTool(writeDef, {} as any, "m", {} as any);

    expect(readTool.readOnly()).toBe(true);
    expect(writeTool.readOnly()).toBe(false);
  });
});
