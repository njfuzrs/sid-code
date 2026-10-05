/**
 * Skill 元工具在无头模式（-p）下的权限判定。
 *
 * 缺陷：SkillMetaTool 没实现 checkPermissions、也不在 READ_ONLY_TOOLS，于是落到
 * checker Step 14 默认 ask → 非交互模式就地判 deny。-p 下**任何** skill 都要
 * `--allowed-tools Skill` 预授权，否则模型调 Skill 被拒、绕开 skill 自己干。
 *
 * 修法：Skill 工具级 checkPermissions 返回 allow（加载指令无副作用，后续动作各自过权限）。
 * 本文件同时锁住三条不能跟着放宽的边界：
 *   - 敏感属性（allowed-tools 等）在 -p 下仍 fail-closed，加了 --allowed-tools Skill 也一样；
 *   - deny / ask 规则、disallowedTools 仍能管住 Skill；
 *   - plan / deny-write 模式不被工具级 allow 越过。
 */

import { describe, test, expect } from "bun:test";
import { PermissionChecker } from "@sid-code/core/permission/checker.ts";
import { createSubAgentChecker } from "@sid-code/core/permission/sub-agent-checker.ts";
import { defaultConfig } from "@sid-code/core/config/config.ts";
import { SkillMetaTool } from "@sid-code/core/skill/meta-tool.ts";
import { SkillManager } from "@sid-code/core/skill/manager.ts";
import type { SkillDefinition } from "@sid-code/core/skill/types.ts";

function makeSkill(overrides: Partial<SkillDefinition>): SkillDefinition {
  return {
    name: "demo",
    description: "演示 skill",
    prompt: "执行任务",
    source: "project",
    filePath: "/test/demo.md",
    mode: "activate",
    ...overrides,
  };
}

function toolWith(skills: SkillDefinition[]): SkillMetaTool {
  const m = new SkillManager();
  // @ts-expect-error 测试直接注入内部 skills，避免磁盘 discover
  m.skills = skills;
  return new SkillMetaTool(m, {} as any, {} as any);
}

const req = { toolName: "Skill", input: { skill: "demo" } };

describe("Skill 工具在 -p 下免预授权", () => {
  test("无头模式（print）调 Skill 直接放行，不需要 --allowed-tools Skill", async () => {
    const checker = new PermissionChecker({ ...defaultConfig(), print: true });
    const r = await checker.check(req, toolWith([makeSkill({})]));
    expect(r.allowed).toBe(true);
    expect(r.needsConfirmation).toBeFalsy();
  });

  test("批处理模式（maxTurns>0）同样放行", async () => {
    const checker = new PermissionChecker({ ...defaultConfig(), maxTurns: 40 });
    const r = await checker.check(req, toolWith([makeSkill({})]));
    expect(r.allowed).toBe(true);
  });

  test("端到端：-p 下 checker 放行 + 执行一个不写 allowed-tools 的 skill 成功", async () => {
    const main = new PermissionChecker({ ...defaultConfig(), print: true });
    const tool = toolWith([makeSkill({ prompt: "按规范写一条变更记录" })]);
    tool.setPermissionChecker(createSubAgentChecker(main));
    tool.setPermissionRules({ allow: [], deny: [], ask: [] });

    expect((await main.check(req, tool)).allowed).toBe(true);
    const res = await tool.execute({ skill: "demo" });
    expect(res.isError).toBe(false);
    expect(res.output).toContain("按规范写一条变更记录");
  });
});

describe("不跟着放宽的边界", () => {
  test("敏感属性 allowed-tools 在 -p 下仍 fail-closed（即使 --allowed-tools Skill）", async () => {
    const main = new PermissionChecker({
      ...defaultConfig(),
      print: true,
      allowedTools: ["Skill"],
    });
    const tool = toolWith([makeSkill({ allowedTools: ["bash", "read"] })]);
    tool.setPermissionChecker(createSubAgentChecker(main));
    tool.setPermissionRules({ allow: [], deny: [], ask: [] });

    // 外层 Skill 工具放行……
    expect((await main.check(req, tool)).allowed).toBe(true);
    // ……但敏感属性那一层仍要确认，-p 无通道 → 拒
    const res = await tool.execute({ skill: "demo" });
    expect(res.isError).toBe(true);
    expect(res.output).toContain("需确认");
  });

  test("deny 规则仍能拦住 Skill", async () => {
    const checker = new PermissionChecker({ ...defaultConfig(), print: true }, { deny: ["Skill"] });
    const r = await checker.check(req, toolWith([makeSkill({})]));
    expect(r.allowed).toBe(false);
  });

  test("disallowedTools 仍能关掉 Skill", async () => {
    const checker = new PermissionChecker({
      ...defaultConfig(),
      print: true,
      disallowedTools: ["Skill"],
    });
    const r = await checker.check(req, toolWith([makeSkill({})]));
    expect(r.allowed).toBe(false);
  });

  test("ask 规则在交互模式下仍升级为确认", async () => {
    const checker = new PermissionChecker(defaultConfig(), { ask: ["Skill"] });
    const r = await checker.check(req, toolWith([makeSkill({})]));
    expect(r.allowed).toBe(false);
    expect(r.needsConfirmation).toBe(true);
  });

  test("plan 模式不被工具级 allow 越过", async () => {
    const checker = new PermissionChecker({ ...defaultConfig(), permissionMode: "plan" });
    const r = await checker.check(req, toolWith([makeSkill({})]));
    expect(r.allowed).toBe(false);
  });

  test("deny-write 模式不被工具级 allow 越过", async () => {
    const checker = new PermissionChecker({ ...defaultConfig(), permissionMode: "deny-write" });
    const r = await checker.check(req, toolWith([makeSkill({})]));
    expect(r.allowed).toBe(false);
  });
});
