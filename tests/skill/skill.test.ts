/**
 * Skill 系统测试
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { SkillLoader } from "../../src/skill/loader.ts";
import { SkillTool } from "../../src/skill/tool.ts";
import { SkillManager } from "../../src/skill/manager.ts";
import { ExtensionLoader } from "../../src/extension/loader.ts";

describe("SkillLoader", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `skill-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test("加载 Skill 定义", async () => {
    const skillDir = join(testDir, ".sid-code", "skills");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "review.md"), `---
name: code-review
description: 代码审查
allowed-tools: read, grep, glob
when-to-use: 当用户要求审查代码时
argument-hint: 要审查的文件路径
---
请审查以下代码，关注：
1. 代码质量
2. 潜在 bug
3. 性能问题`);

    const loader = new SkillLoader(new ExtensionLoader());
    const skills = await loader.loadAll(testDir);
    expect(skills.length).toBe(1);
    expect(skills[0].name).toBe("code-review");
    expect(skills[0].description).toBe("代码审查");
    expect(skills[0].allowedTools).toEqual(["read", "grep", "glob"]);
    expect(skills[0].whenToUse).toBe("当用户要求审查代码时");
    expect(skills[0].argumentHint).toBe("要审查的文件路径");
    expect(skills[0].prompt).toContain("请审查以下代码");
  });

  test("文件名作为默认 name", async () => {
    const skillDir = join(testDir, ".sid-code", "skills");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "deploy.md"), `---
description: 部署助手
---
帮助部署`);

    const loader = new SkillLoader(new ExtensionLoader());
    const skills = await loader.loadAll(testDir);
    expect(skills[0].name).toBe("deploy");
  });

  test("disableModelInvocation 解析", async () => {
    const skillDir = join(testDir, ".sid-code", "skills");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "manual.md"), `---
description: 手动触发
disable-model-invocation: true
---
内容`);

    const loader = new SkillLoader(new ExtensionLoader());
    const skills = await loader.loadAll(testDir);
    expect(skills[0].disableModelInvocation).toBe(true);
  });

  test("allowed-tools 数组格式", async () => {
    const skillDir = join(testDir, ".sid-code", "skills");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "writer.md"), `---
description: 写作助手
allowed-tools:
  - read
  - write
  - edit
---
内容`);

    const loader = new SkillLoader(new ExtensionLoader());
    const skills = await loader.loadAll(testDir);
    expect(skills[0].allowedTools).toEqual(["read", "write", "edit"]);
  });

  test("空目录返回空数组", async () => {
    const loader = new SkillLoader(new ExtensionLoader());
    const skills = await loader.loadAll(testDir);
    expect(skills.length).toBe(0);
  });

  test("ADR-025: builtinDir 选项识别 builtin Skill 子目录模式（不当 projectDir 处理）", async () => {
    // 模拟 src/skill/builtin/ 结构: builtinDir/<name>/SKILL.md
    const builtinRoot = join(testDir, "builtin");
    const skillSubdir = join(builtinRoot, "demo-builtin");
    mkdirSync(skillSubdir, { recursive: true });
    writeFileSync(join(skillSubdir, "SKILL.md"), `---
name: demo-builtin
description: 演示内置 Skill
mode: delegate
allowed-tools: read, grep
---
内置 Skill body`);

    const loader = new SkillLoader(new ExtensionLoader());

    // 旧实现把 builtinRoot 当 projectDir 会去找 {builtinRoot}/.sid-code/skills/,扫不到
    // 新实现通过 builtinDir 选项让 ExtensionLoader 直接扫 builtinRoot/<name>/SKILL.md
    const skills = await loader.loadAll(undefined, { builtinDir: builtinRoot });
    const demo = skills.find(s => s.name === "demo-builtin");
    expect(demo).toBeDefined();
    expect(demo!.source).toBe("builtin");
    expect(demo!.mode).toBe("delegate");
  });
});

describe("SkillManager - ADR-025 内置加载机制", () => {
  test("discoverBuiltin 加载 src/skill/builtin/ 下的 skill-creator + code-review", async () => {
    const m = new SkillManager();
    await m.discover();
    const all = m.getAllSkills();

    const skillCreator = all.find(s => s.name === "skill-creator");
    const codeReview = all.find(s => s.name === "code-review");

    expect(skillCreator).toBeDefined();
    expect(skillCreator!.isBuiltin).toBe(true);
    expect(skillCreator!.source).toBe("builtin");

    expect(codeReview).toBeDefined();
    expect(codeReview!.isBuiltin).toBe(true);
    expect(codeReview!.source).toBe("builtin");
    expect(codeReview!.mode).toBe("delegate");
  });
});

describe("SkillTool", () => {
  test("name 前缀", () => {
    const skill = {
      name: "review",
      description: "代码审查",
      prompt: "审查代码",
      source: "project" as const,
      filePath: "/test/review.md",
    };
    const tool = new SkillTool(skill, {} as any, {} as any);
    expect(tool.name()).toBe("skill__review");
  });

  test("description 包含 whenToUse", () => {
    const skill = {
      name: "review",
      description: "代码审查",
      whenToUse: "当用户要求审查代码时",
      prompt: "审查代码",
      source: "project" as const,
      filePath: "/test/review.md",
    };
    const tool = new SkillTool(skill, {} as any, {} as any);
    expect(tool.description()).toContain("代码审查");
    expect(tool.description()).toContain("当用户要求审查代码时");
  });

  test("inputSchema 包含 input 参数", () => {
    const skill = {
      name: "test",
      description: "测试",
      prompt: "内容",
      source: "project" as const,
      filePath: "/test.md",
    };
    const tool = new SkillTool(skill, {} as any, {} as any);
    const schema = tool.inputSchema();
    expect(schema.type).toBe("object");
    expect((schema.properties as any).input).toBeDefined();
    expect(schema.required).toEqual(["input"]);
  });

  test("readOnly 根据 allowedTools 判断", () => {
    const readOnlySkill = {
      name: "analyze",
      description: "分析",
      allowedTools: ["read", "grep"],
      prompt: "分析",
      source: "project" as const,
      filePath: "/test.md",
    };
    const writeSkill = {
      name: "fix",
      description: "修复",
      allowedTools: ["read", "write", "edit"],
      prompt: "修复",
      source: "project" as const,
      filePath: "/test.md",
    };

    const readTool = new SkillTool(readOnlySkill, {} as any, {} as any);
    const writeTool = new SkillTool(writeSkill, {} as any, {} as any);

    expect(readTool.readOnly()).toBe(true);
    expect(writeTool.readOnly()).toBe(false);
  });
});
