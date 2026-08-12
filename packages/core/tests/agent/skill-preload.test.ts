/**
 * P1-1：子代理 skills 预加载（§11.8 角色链基石）单测
 *
 * 覆盖：
 * - 声明的 skill 内容被拼进预加载段（角色链能真正拿到领域知识）
 * - skill 不存在 → warn 跳过，返回仍包含存在的那些（不 spawn 失败）
 * - 全部不存在 / 未声明 → 返回空串（调用方不注入空段落）
 * - 名称大小写不敏感
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  buildSkillPreloadSection,
  __clearSkillPreloadCache,
} from "@sid-code/core/agent/skill-preload.ts";

let dir: string;
let prevCwd: string;

/** 在项目 skills 目录下写一个 skill（loader 期望 <name>/SKILL.md + frontmatter）。 */
function writeSkill(name: string, body: string) {
  const skillDir = join(dir, ".sid-code", "skills", name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} 技能\n---\n\n${body}\n`,
  );
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sid-skill-preload-"));
  prevCwd = process.cwd();
  process.chdir(dir);
  __clearSkillPreloadCache();
});

afterEach(() => {
  process.chdir(prevCwd);
  __clearSkillPreloadCache();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("buildSkillPreloadSection", () => {
  it("未声明 skills → 空串（不注入空段落）", async () => {
    expect(await buildSkillPreloadSection(undefined, "a")).toBe("");
    expect(await buildSkillPreloadSection([], "a")).toBe("");
  });

  it("声明的 skill 内容被拼进预加载段", async () => {
    writeSkill("api-conventions", "所有接口用 POST /v1/*");
    const out = await buildSkillPreloadSection(["api-conventions"], "api-dev");
    expect(out).toContain("预加载专业知识");
    expect(out).toContain("api-conventions");
    expect(out).toContain("POST /v1/*");
  });

  it("多个 skill 依序拼接", async () => {
    writeSkill("first-skill", "内容甲");
    writeSkill("second-skill", "内容乙");
    const out = await buildSkillPreloadSection(["first-skill", "second-skill"], "x");
    expect(out).toContain("内容甲");
    expect(out).toContain("内容乙");
    expect(out.indexOf("内容甲")).toBeLessThan(out.indexOf("内容乙"));
  });

  it("skill 不存在 → 跳过但不失败，其余照常注入", async () => {
    writeSkill("real-skill", "真实内容");
    const out = await buildSkillPreloadSection(["real-skill", "ghost-skill"], "x");
    expect(out).toContain("真实内容");
    expect(out).not.toContain("ghost-skill");
  });

  it("全部不存在 → 空串", async () => {
    const out = await buildSkillPreloadSection(["ghost-a", "ghost-b"], "x");
    expect(out).toBe("");
  });

  it("名称大小写不敏感 + 首尾空格容错", async () => {
    writeSkill("case-skill", "大小写无关");
    const out = await buildSkillPreloadSection(["  CASE-Skill "], "x");
    expect(out).toContain("大小写无关");
  });

  it("空白名条目被忽略", async () => {
    writeSkill("only-one", "唯一");
    const out = await buildSkillPreloadSection(["", "   ", "only-one"], "x");
    expect(out).toContain("唯一");
  });
});
