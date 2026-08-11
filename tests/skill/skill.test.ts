/**
 * Skill 系统测试
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { SkillLoader } from "@sid-code/core/skill/loader.ts";
import { SkillMetaTool } from "@sid-code/core/skill/meta-tool.ts";
import { SkillManager } from "@sid-code/core/skill/manager.ts";
import { ExtensionLoader } from "@sid-code/core/extension/loader.ts";
import type { SkillDefinition } from "@sid-code/core/skill/types.ts";

/** 构造只含指定 skills 的 manager（绕过磁盘扫描），与 meta-tool.test.ts 同口径 */
function managerWith(skills: SkillDefinition[]): SkillManager {
  const m = new SkillManager();
  // @ts-expect-error 测试直接注入内部 skills，避免磁盘 discover
  m.skills = skills;
  return m;
}

/** 取元工具的 buildResourceHint（私有方法，测试直呼） */
function resourceHint(skill: SkillDefinition): Promise<string> {
  const tool = new SkillMetaTool(managerWith([skill]), {} as any, {} as any);
  return (tool as any).buildResourceHint(skill);
}

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

// 注：per-skill 的 `skill__<name>` 工具（SkillTool）已被单一 `Skill` 元工具取代（P0-1），
// 工具名/description/inputSchema/readOnly 的断言迁至 meta-tool.test.ts。
// 下面保留的是与工具形态无关、仍需防回归的 delegate 资源注入行为。

describe("Skill delegate 资源注入（Bug 2 回归）", () => {
  let skillDir: string;

  beforeEach(() => {
    // 构造一个带 references/scripts 的临时 skill 目录
    skillDir = join(tmpdir(), `skilltool-res-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(skillDir, "references"), { recursive: true });
    mkdirSync(join(skillDir, "scripts"), { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# t\n正文");
    writeFileSync(join(skillDir, "references", "output-template.md"), "模板");
    writeFileSync(join(skillDir, "scripts", "parse.ts"), "// script");
  });

  afterEach(() => {
    rmSync(skillDir, { recursive: true, force: true });
  });

  test("buildResourceHint 注入绝对目录 + 资源树 + 绝对路径读取规则", async () => {
    const skill = {
      name: "code-review",
      description: "审查",
      prompt: "正文",
      mode: "delegate" as const,
      source: "builtin" as const,
      filePath: join(skillDir, "SKILL.md"),
      skillRoot: skillDir,
    };
    const hint = await resourceHint(skill);

    // 注入了 skill 的绝对目录路径
    expect(hint).toContain(skillDir);
    // 列出了资源文件
    expect(hint).toContain("output-template.md");
    expect(hint).toContain("parse.ts");
    // 强制绝对路径读取规则，绕开 process.cwd()=项目目录
    expect(hint).toContain("绝对路径");
    expect(hint).toContain("切勿");
  });

  test("无资源目录的 skill 返回空串（不污染 prompt）", async () => {
    const bareDir = join(tmpdir(), `skilltool-bare-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(bareDir, { recursive: true });
    writeFileSync(join(bareDir, "SKILL.md"), "# bare\n正文");
    try {
      const skill = {
        name: "bare",
        description: "无资源",
        prompt: "正文",
        mode: "delegate" as const,
        source: "builtin" as const,
        filePath: join(bareDir, "SKILL.md"),
        skillRoot: bareDir,
      };
      const hint = await resourceHint(skill);
      expect(hint).toBe("");
    } finally {
      rmSync(bareDir, { recursive: true, force: true });
    }
  });

  test("filePath 缺失时降级为空串，不抛错", async () => {
    const skill = {
      name: "nofile",
      description: "无路径",
      prompt: "正文",
      mode: "delegate" as const,
      source: "mcp" as const,
      filePath: "",
    };
    const hint = await resourceHint(skill);
    expect(hint).toBe("");
  });
});
