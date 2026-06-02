/**
 * Bundled Skills 体系测试（Task 6）
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  registerBundledSkill,
  getBundledSkills,
  clearBundledSkills,
  hasBundledSkill,
} from "../../src/skill/bundled/registry.ts";
import {
  resolveSkillFilePath,
  getBundledSkillExtractDir,
  extractBundledSkillFiles,
} from "../../src/skill/bundled/extract.ts";
import { loadBundledSkills } from "../../src/skill/bundled/index.ts";
import type { CommandContext } from "../../src/command/types.ts";
import { rm, readFile } from "node:fs/promises";

const fakeCtx = { cwd: process.cwd(), sessionId: "s" } as CommandContext;

describe("registerBundledSkill / getBundledSkills", () => {
  beforeEach(() => clearBundledSkills());
  afterEach(() => clearBundledSkills());

  test("注册并暴露为 prompt 命令", () => {
    registerBundledSkill({
      name: "demo",
      description: "演示",
      async getPromptForCommand() {
        return "hello";
      },
    });
    const skills = getBundledSkills();
    expect(skills.length).toBe(1);
    expect(skills[0].type).toBe("prompt");
    expect(skills[0].name).toBe("demo");
    expect(hasBundledSkill("demo")).toBe(true);
  });

  test("isEnabled=false 的 Skill 被过滤", () => {
    registerBundledSkill({
      name: "flagged",
      description: "实验性",
      isEnabled: () => false,
      async getPromptForCommand() {
        return "x";
      },
    });
    expect(getBundledSkills().length).toBe(0);
  });

  test("同名注册覆盖", () => {
    registerBundledSkill({
      name: "dup",
      description: "v1",
      async getPromptForCommand() {
        return "v1";
      },
    });
    registerBundledSkill({
      name: "dup",
      description: "v2",
      async getPromptForCommand() {
        return "v2";
      },
    });
    const skills = getBundledSkills();
    expect(skills.length).toBe(1);
    expect(skills[0].description).toBe("v2");
  });

  test("getPromptForCommand 透传 args", async () => {
    registerBundledSkill({
      name: "echo",
      description: "回显",
      async getPromptForCommand(args) {
        return `got: ${args}`;
      },
    });
    const cmd = getBundledSkills()[0];
    if (cmd.type !== "prompt") throw new Error("应为 prompt");
    expect(await cmd.getPromptForCommand("xyz", fakeCtx)).toBe("got: xyz");
  });

  test("携带参考文件 → prompt 注入 Base directory 头部", async () => {
    registerBundledSkill({
      name: "withfiles",
      description: "带文件",
      files: { "ref.md": "参考内容" },
      async getPromptForCommand() {
        return "正文";
      },
    });
    const cmd = getBundledSkills()[0];
    if (cmd.type !== "prompt") throw new Error("应为 prompt");
    const out = await cmd.getPromptForCommand("", fakeCtx);
    expect(out).toContain("Base directory for this skill:");
    expect(out).toContain("正文");

    // 清理提取目录
    await rm(getBundledSkillExtractDir("withfiles"), { recursive: true, force: true });
  });
});

describe("extract 安全防护", () => {
  test("resolveSkillFilePath 拒绝路径遍历", () => {
    expect(() => resolveSkillFilePath("/base", "../escape.txt")).toThrow();
    expect(() => resolveSkillFilePath("/base", "a/../../escape.txt")).toThrow();
  });

  test("resolveSkillFilePath 拒绝绝对路径", () => {
    expect(() => resolveSkillFilePath("/base", "/etc/passwd")).toThrow();
  });

  test("resolveSkillFilePath 接受正常相对路径", () => {
    const p = resolveSkillFilePath("/base", "sub/file.md");
    expect(p).toContain("file.md");
    expect(p.startsWith("/base")).toBe(true);
  });

  test("extractBundledSkillFiles 实际写入文件", async () => {
    const dir = await extractBundledSkillFiles("test-extract", {
      "a.txt": "content-a",
      "sub/b.txt": "content-b",
    });
    expect(dir).not.toBeNull();
    const a = await readFile(`${dir}/a.txt`, "utf8");
    const b = await readFile(`${dir}/sub/b.txt`, "utf8");
    expect(a).toBe("content-a");
    expect(b).toBe("content-b");
    await rm(dir!, { recursive: true, force: true });
  });
});

describe("loadBundledSkills (内置注册)", () => {
  test("注册 simplify 与 verify", () => {
    const skills = loadBundledSkills();
    const names = skills.map((s) => s.name);
    expect(names).toContain("simplify");
    expect(names).toContain("verify");
  });
});
