/**
 * Skill → PromptCommand 适配器测试（Task 2）
 */

import { describe, test, expect } from "bun:test";
import { skillToCommand } from "@sid-code/core/skill/command-adapter.ts";
import type { SkillDefinition } from "@sid-code/core/skill/types.ts";
import type { CommandContext } from "@sid-code/cli/command/types.ts";

function makeSkill(overrides: Partial<SkillDefinition> = {}): SkillDefinition {
  return {
    name: "my-skill",
    description: "测试 Skill",
    prompt: "请处理: {{args}}",
    source: "user",
    filePath: "/tmp/my-skill/SKILL.md",
    ...overrides,
  };
}

const fakeCtx = {} as CommandContext;

describe("skillToCommand", () => {
  test("适配为 prompt 类型命令", () => {
    const cmd = skillToCommand(makeSkill());
    expect(cmd.type).toBe("prompt");
    expect(cmd.name).toBe("my-skill");
    expect(cmd.source).toBe("skill");
    expect(cmd.userInvocable).toBe(true);
  });

  test("delegate 模式 → fork 上下文", () => {
    const cmd = skillToCommand(makeSkill({ mode: "delegate" }));
    if (cmd.type !== "prompt") throw new Error("应为 prompt");
    expect(cmd.context).toBe("fork");
  });

  test("activate 模式 → inline 上下文", () => {
    const cmd = skillToCommand(makeSkill({ mode: "activate" }));
    if (cmd.type !== "prompt") throw new Error("应为 prompt");
    expect(cmd.context).toBe("inline");
  });

  test("默认（未指定 mode）→ fork", () => {
    const cmd = skillToCommand(makeSkill());
    if (cmd.type !== "prompt") throw new Error("应为 prompt");
    expect(cmd.context).toBe("fork");
  });

  test("getPromptForCommand 替换 {{args}}", async () => {
    const cmd = skillToCommand(makeSkill({ prompt: "do {{args}} now" }));
    if (cmd.type !== "prompt") throw new Error("应为 prompt");
    const p = await cmd.getPromptForCommand("the thing", fakeCtx);
    expect(p).toBe("do the thing now");
  });

  test("getPromptForCommand 替换位置参数 $1 $2", async () => {
    const cmd = skillToCommand(makeSkill({ prompt: "first=$1 second=$2" }));
    if (cmd.type !== "prompt") throw new Error("应为 prompt");
    const p = await cmd.getPromptForCommand("alpha beta", fakeCtx);
    expect(p).toBe("first=alpha second=beta");
  });

  test("disableModelInvocation 透传，但用户仍可调用", () => {
    const cmd = skillToCommand(makeSkill({ disableModelInvocation: true }));
    expect(cmd.disableModelInvocation).toBe(true);
    expect(cmd.userInvocable).toBe(true);
  });

  test("isEnabled 反映 disabled 状态", () => {
    const enabled = skillToCommand(makeSkill({ disabled: false }));
    const disabled = skillToCommand(makeSkill({ disabled: true }));
    expect(enabled.isEnabled?.()).toBe(true);
    expect(disabled.isEnabled?.()).toBe(false);
  });
});
