/**
 * 单一 Skill 元工具测试（P0-1 架构重构 + P0-3 权限 + P3-1 argument-hint 语义）
 *
 * 覆盖：分发正确性、disableModelInvocation 拦截、未知 skill 报错、
 * disabled 拦截、listing 收集、args schema（不塞 argumentHint）、权限 deny/ask。
 */

import { describe, test, expect } from "bun:test";
import { SkillMetaTool, SKILL_TOOL_NAME } from "@sid-code/core/skill/meta-tool.ts";
import { SkillManager } from "@sid-code/core/skill/manager.ts";
import type { SkillDefinition } from "@sid-code/core/skill/types.ts";

function makeSkill(overrides: Partial<SkillDefinition>): SkillDefinition {
  return {
    name: "demo",
    description: "演示 skill",
    prompt: "执行任务",
    source: "project",
    filePath: "/test/demo.md",
    ...overrides,
  };
}

/** 构造一个只含指定 skills 的 manager（绕过磁盘扫描） */
function managerWith(skills: SkillDefinition[]): SkillManager {
  const m = new SkillManager();
  // @ts-expect-error 测试直接注入内部 skills，避免磁盘 discover
  m.skills = skills;
  return m;
}

describe("SkillMetaTool - 基本形态（P0-1）", () => {
  test("工具名是单一 Skill（不带 skill__ 前缀）", () => {
    const tool = new SkillMetaTool(managerWith([]), {} as any, {} as any);
    expect(tool.name()).toBe(SKILL_TOOL_NAME);
    expect(tool.name()).toBe("Skill");
  });

  test("inputSchema 是 {skill, args}，不含单个 skill 的 argumentHint（P3-1）", () => {
    const tool = new SkillMetaTool(
      managerWith([makeSkill({ argumentHint: "<file> <focus>" })]),
      {} as any,
      {} as any,
    );
    const schema = tool.inputSchema();
    expect(schema.type).toBe("object");
    const props = schema.properties as any;
    expect(props.skill).toBeDefined();
    expect(props.args).toBeDefined();
    // argument-hint 是用户 slash 补全提示，不应出现在模型工具 schema 里
    const json = JSON.stringify(schema);
    expect(json).not.toContain("<file> <focus>");
  });

  test("getListingEntries 只含可被模型调用的 skill", () => {
    const tool = new SkillMetaTool(
      managerWith([
        makeSkill({ name: "a" }),
        makeSkill({ name: "b", disableModelInvocation: true }),
        makeSkill({ name: "c", disabled: true }),
      ]),
      {} as any,
      {} as any,
    );
    const names = tool.getListingEntries().map((e) => e.name);
    expect(names).toContain("a");
    expect(names).not.toContain("b"); // disableModelInvocation
    expect(names).not.toContain("c"); // disabled
  });
});

describe("SkillMetaTool - 分发与拦截（P0-1 验收）", () => {
  test("未知 skill 名报错，列出可用", async () => {
    const tool = new SkillMetaTool(
      managerWith([makeSkill({ name: "real" })]),
      {} as any,
      {} as any,
    );
    const res = await tool.execute({ skill: "nope" });
    expect(res.isError).toBe(true);
    expect(res.output).toContain("未知 Skill");
    expect(res.output).toContain("real");
  });

  test("空 skill 名报错", async () => {
    const tool = new SkillMetaTool(managerWith([]), {} as any, {} as any);
    const res = await tool.execute({ skill: "" });
    expect(res.isError).toBe(true);
  });

  test("disableModelInvocation 的 skill 经元工具被拒", async () => {
    const tool = new SkillMetaTool(
      managerWith([makeSkill({ name: "manual", disableModelInvocation: true })]),
      {} as any,
      {} as any,
    );
    const res = await tool.execute({ skill: "manual" });
    expect(res.isError).toBe(true);
    expect(res.output).toContain("禁止模型自动调用");
  });

  test("disabled 的 skill 被拒", async () => {
    const tool = new SkillMetaTool(
      managerWith([makeSkill({ name: "off", disabled: true })]),
      {} as any,
      {} as any,
    );
    const res = await tool.execute({ skill: "off" });
    expect(res.isError).toBe(true);
    expect(res.output).toContain("已被禁用");
  });

  test("按名分发不区分大小写", async () => {
    // activate 模式不需要子代理，可安全执行到底
    const tool = new SkillMetaTool(
      managerWith([makeSkill({ name: "MyReview", mode: "activate", prompt: "审查内容" })]),
      {} as any,
      {} as any,
    );
    const res = await tool.execute({ skill: "myreview", args: "关注安全" });
    expect(res.isError).toBe(false);
    expect(res.output).toContain("审查内容");
    expect(res.output).toContain("关注安全");
  });
});

describe("SkillMetaTool - 权限判定（P0-3）", () => {
  test("Skill(name) deny 规则拦截", async () => {
    const tool = new SkillMetaTool(
      managerWith([makeSkill({ name: "danger", mode: "activate" })]),
      {} as any,
      {} as any,
    );
    tool.setPermissionRules({ deny: ["Skill(danger)"], allow: [], ask: [] });
    const res = await tool.execute({ skill: "danger" });
    expect(res.isError).toBe(true);
    expect(res.output).toContain("权限拒绝");
  });

  test("仅安全属性的 skill 默认放行（activate）", async () => {
    const tool = new SkillMetaTool(
      managerWith([makeSkill({ name: "safe", mode: "activate", prompt: "安全内容" })]),
      {} as any,
      {} as any,
    );
    tool.setPermissionRules({ allow: [], deny: [], ask: [] });
    const res = await tool.execute({ skill: "safe" });
    expect(res.isError).toBe(false);
  });

  test("含敏感属性(allowedTools)的 skill 触发 ask，无确认通道则拒", async () => {
    const tool = new SkillMetaTool(
      managerWith([
        makeSkill({ name: "sensitive", mode: "activate", allowedTools: ["bash"] }),
      ]),
      {} as any,
      {} as any,
    );
    tool.setPermissionRules({ allow: [], deny: [], ask: [] });
    // 未注入 permissionChecker → ask 无通道 → 拒绝
    const res = await tool.execute({ skill: "sensitive" });
    expect(res.isError).toBe(true);
    expect(res.output).toContain("需确认");
  });

  test("Skill(name) allow 规则放行敏感 skill", async () => {
    const tool = new SkillMetaTool(
      managerWith([
        makeSkill({ name: "sensitive", mode: "activate", allowedTools: ["bash"], prompt: "内容" }),
      ]),
      {} as any,
      {} as any,
    );
    tool.setPermissionRules({ allow: ["Skill(sensitive)"], deny: [], ask: [] });
    const res = await tool.execute({ skill: "sensitive" });
    expect(res.isError).toBe(false);
  });
});
