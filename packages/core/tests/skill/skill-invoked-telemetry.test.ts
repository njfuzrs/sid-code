/**
 * skill 调用埋点（内置 skill 下沉方案 P1）。
 *
 * 口径：「过了权限、即将执行」才计一次。被 deny 的不计 —— 否则「有没有人在用」的分子里
 * 混进了「想用但没用上」。斜杠路径与模型路径各一条，via 区分。
 *
 * 变异自证：删掉 executor.ts 里的 emitSkillInvoked 调用，「斜杠路径」两条红；
 * 把它挪到权限判定之前，「deny 不计」那条红。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { CommandExecutor } from "@sid-code/cli/command/executor.ts";
import { skillToCommand } from "@sid-code/core/skill/command-adapter.ts";
import { SkillManager } from "@sid-code/core/skill/manager.ts";
import { SkillMetaTool } from "@sid-code/core/skill/meta-tool.ts";
import {
  emitSkillInvoked,
  setSkillInvocationSink,
  type SkillInvocationEvent,
} from "@sid-code/core/skill/telemetry.ts";
import type { SkillDefinition } from "@sid-code/core/skill/types.ts";
import type { CommandContext } from "@sid-code/cli/command/types.ts";

function makeSkill(overrides: Partial<SkillDefinition> = {}): SkillDefinition {
  return {
    name: "plain-skill",
    description: "d",
    prompt: "做点事",
    source: "user",
    filePath: "/tmp/plain-skill/SKILL.md",
    context: "inline",
    ...overrides,
  };
}

function capture(): SkillInvocationEvent[] {
  const events: SkillInvocationEvent[] = [];
  setSkillInvocationSink((d) => events.push(d as unknown as SkillInvocationEvent));
  return events;
}

afterEach(() => setSkillInvocationSink(null));

describe("skill_invoked：用户斜杠路径", () => {
  test("放行的 skill 计一次，via=slash", async () => {
    const events = capture();
    const exec = new CommandExecutor({ cwd: "/tmp", sessionId: "s" } as CommandContext);
    const r = await exec.executeSlashCommand("/plain-skill", [skillToCommand(makeSkill())]);
    expect(r.type).toBe("submit_prompt");
    expect(events).toEqual([{ skill: "plain-skill", via: "slash", loaded_from: "user" }]);
  });

  test("插件 skill 带 plugin 归因", async () => {
    const events = capture();
    const skill = makeSkill({ name: "ops:ci-heal", source: "plugin", loadedFrom: "plugin" });
    const exec = new CommandExecutor({ cwd: "/tmp", sessionId: "s" } as CommandContext);
    await exec.executeSlashCommand("/ops:ci-heal", [skillToCommand(skill)]);
    expect(events).toEqual([
      { skill: "ops:ci-heal", via: "slash", loaded_from: "plugin", plugin: "ops" },
    ]);
  });

  test("被 deny 的 skill 不计", async () => {
    const events = capture();
    const exec = new CommandExecutor({
      cwd: "/tmp",
      sessionId: "s",
      permissionRules: { deny: ["Skill(danger)"], allow: [], ask: [] },
    } as unknown as CommandContext);
    const r = await exec.executeSlashCommand("/danger", [
      skillToCommand(makeSkill({ name: "danger" })),
    ]);
    expect(r.type).toBe("error");
    expect(events).toEqual([]);
  });
});

describe("skill_invoked：模型路径", () => {
  test("Skill 元工具被 disableModelInvocation 拒绝时不计", async () => {
    const events = capture();
    const manager = new SkillManager();
    manager.addPluginSkills([
      makeSkill({
        name: "github-pr:comments",
        source: "plugin",
        loadedFrom: "plugin",
        disableModelInvocation: true,
      }),
    ]);
    const tool = new SkillMetaTool(manager, {} as any, {} as any);
    const r = await tool.execute({ skill: "github-pr:comments" });
    expect(r.isError).toBe(true);
    expect(events).toEqual([]);
  });
});

describe("emitSkillInvoked 本体", () => {
  test("未注入 sink 时静默", () => {
    setSkillInvocationSink(null);
    expect(() => emitSkillInvoked({ name: "x", via: "model" })).not.toThrow();
  });

  test("非插件来源即使名字含冒号也不填 plugin", () => {
    const events = capture();
    emitSkillInvoked({ name: "a:b", via: "model", loadedFrom: "mcp" });
    expect(events).toEqual([{ skill: "a:b", via: "model", loaded_from: "mcp" }]);
  });

  test("sink 抛错不外泄", () => {
    setSkillInvocationSink(() => {
      throw new Error("boom");
    });
    expect(() => emitSkillInvoked({ name: "x", via: "slash" })).not.toThrow();
  });
});
