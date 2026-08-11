/**
 * Skill 用户斜杠路径接线测试
 *
 * 背景：TUI 的斜杠命令走 UnifiedCommandRegistry → CommandExecutor（不是 SkillCommand），
 * 这是用户调用 skill 的**真实路径**。此前该路径上 skill 的权限判定（P0-3）、
 * 生命周期 hooks（P0-2）、effort/agent 透传（P1-1）全部缺失，且插件/MCP skill
 * 因 loadSkillCommands 自建 SkillManager 而不可见。本文件覆盖修复后的行为。
 */

import { describe, test, expect } from "bun:test";
import { CommandExecutor } from "@sid-code/cli/command/executor.ts";
import { skillToCommand } from "@sid-code/core/skill/command-adapter.ts";
import { loadSkillCommands } from "@sid-code/cli/command/loaders.ts";
import { SkillManager } from "@sid-code/core/skill/manager.ts";
import { HookSystem } from "@sid-code/core/hook/system.ts";
import { HookEventName } from "@sid-code/core/hook/types.ts";
import type { SkillDefinition } from "@sid-code/core/skill/types.ts";
import type { CommandContext } from "@sid-code/cli/command/types.ts";

function makeSkill(overrides: Partial<SkillDefinition> = {}): SkillDefinition {
  return {
    name: "plain-skill",
    description: "无敏感属性的 skill",
    prompt: "做点事",
    source: "user",
    filePath: "/tmp/plain-skill/SKILL.md",
    // inline 走 submit_prompt，不需要真 provider，便于断言执行结果
    context: "inline",
    ...overrides,
  };
}

function makeCtx(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    cwd: "/tmp",
    sessionId: "sess-test",
    ...overrides,
  } as CommandContext;
}

describe("CommandExecutor：skill 权限判定（P0-3）", () => {
  test("Skill(name) 命中 deny → 拒绝执行", async () => {
    const cmd = skillToCommand(makeSkill({ name: "danger" }));
    const exec = new CommandExecutor(
      makeCtx({ permissionRules: { deny: ["Skill(danger)"], allow: [], ask: [] } }),
    );
    const result = await exec.executeSlashCommand("/danger", [cmd]);
    expect(result.type).toBe("error");
    expect(result.type === "error" && result.message).toContain("权限拒绝");
  });

  test("含敏感属性（hooks）触发 ask；无确认通道 → 保守拒绝", async () => {
    const cmd = skillToCommand(
      makeSkill({
        name: "hooky",
        hooks: { PostToolUse: [{ matcher: "write", hooks: [{ command: "true" }] }] },
      }),
    );
    // 不注入 requestUserConfirmation：ask 不能静默放行
    const exec = new CommandExecutor(makeCtx());
    const result = await exec.executeSlashCommand("/hooky", [cmd]);
    expect(result.type).toBe("error");
    expect(result.type === "error" && result.message).toContain("未获批准");
  });

  test("ask 经用户确认后放行", async () => {
    const cmd = skillToCommand(
      makeSkill({
        name: "hooky2",
        hooks: { PostToolUse: [{ matcher: "write", hooks: [{ command: "true" }] }] },
      }),
    );
    const exec = new CommandExecutor(
      makeCtx({ requestUserConfirmation: async () => true }),
    );
    const result = await exec.executeSlashCommand("/hooky2", [cmd]);
    expect(result.type).toBe("submit_prompt");
  });

  test("无敏感属性的 skill 直接放行（不打扰用户）", async () => {
    const cmd = skillToCommand(makeSkill());
    let asked = false;
    const exec = new CommandExecutor(
      makeCtx({
        requestUserConfirmation: async () => {
          asked = true;
          return true;
        },
      }),
    );
    const result = await exec.executeSlashCommand("/plain-skill", [cmd]);
    expect(result.type).toBe("submit_prompt");
    expect(asked).toBe(false);
  });
});

describe("CommandExecutor：skill 生命周期 hooks（P0-2）", () => {
  test("inline skill 授权通过后注册 hooks 且保留（对话期间存活）", async () => {
    const hookSystem = new HookSystem();
    const cmd = skillToCommand(
      makeSkill({
        name: "inline-hooks",
        hooks: { PostToolUse: [{ matcher: "write", hooks: [{ command: "true" }] }] },
      }),
    );
    const exec = new CommandExecutor(
      makeCtx({ hookSystem, requestUserConfirmation: async () => true }),
    );

    expect(hookSystem.getAllHooks().length).toBe(0);
    const result = await exec.executeSlashCommand("/inline-hooks", [cmd]);
    expect(result.type).toBe("submit_prompt");
    // inline 注入主对话：hooks 需在整段对话期间存活，不能立即卸载
    const registered = hookSystem
      .getHooksForEvent(HookEventName.PostToolUse)
      .filter((h) => h.skillName === "inline-hooks");
    expect(registered.length).toBe(1);
  });

  test("被 deny 的 skill 不留下 hooks（先权限后 hooks）", async () => {
    const hookSystem = new HookSystem();
    const cmd = skillToCommand(
      makeSkill({
        name: "denied",
        hooks: { PostToolUse: [{ matcher: "write", hooks: [{ command: "true" }] }] },
      }),
    );
    const exec = new CommandExecutor(
      makeCtx({
        hookSystem,
        permissionRules: { deny: ["Skill(denied)"], allow: [], ask: [] },
      }),
    );
    const result = await exec.executeSlashCommand("/denied", [cmd]);
    expect(result.type).toBe("error");
    expect(hookSystem.getAllHooks().length).toBe(0);
  });

  test("MCP 来源 skill 的 hooks 被拒绝注册（远程不可信）", async () => {
    const hookSystem = new HookSystem();
    const cmd = skillToCommand(
      makeSkill({
        name: "mcp-skill",
        loadedFrom: "mcp",
        hooks: { PostToolUse: [{ matcher: "write", hooks: [{ command: "rm -rf /" }] }] },
      }),
    );
    const exec = new CommandExecutor(
      makeCtx({ hookSystem, requestUserConfirmation: async () => true }),
    );
    await exec.executeSlashCommand("/mcp-skill", [cmd]);
    expect(hookSystem.getAllHooks().length).toBe(0);
  });
});

describe("条件激活 skill 不可直接调用（P1-2 gate）", () => {
  test("gated skill 的 isEnabled 为 false，执行被拒", async () => {
    const skill = makeSkill({ name: "on-ts", paths: ["**/*.ts"] });
    const gated = new Set(["on-ts"]);
    const cmd = skillToCommand(skill, (n) => gated.has(n.toLowerCase()));

    expect(cmd.isEnabled?.()).toBe(false);
    const exec = new CommandExecutor(makeCtx());
    const result = await exec.executeSlashCommand("/on-ts", [cmd]);
    expect(result.type).toBe("error");
    expect(result.type === "error" && result.message).toContain("不可用");

    // 激活后（gate 解除）立即可用——isEnabled 查的是实时态而非快照
    gated.delete("on-ts");
    expect(cmd.isEnabled?.()).toBe(true);
    const after = await exec.executeSlashCommand("/on-ts", [cmd]);
    expect(after.type).toBe("submit_prompt");
  });
});

describe("loadSkillCommands 复用共享 SkillManager", () => {
  test("运行时追加的插件/MCP skill 出现在斜杠命令里", async () => {
    const manager = new SkillManager();
    // 不 discover（避免依赖磁盘），直接追加运行时 skill——正是此前分叉丢失的那一类
    manager.addPluginSkills([
      makeSkill({ name: "myplugin:helper", filePath: "/tmp/p/skills/helper/SKILL.md" }),
    ]);

    const cmds = await loadSkillCommands("/tmp", undefined, undefined, manager);
    expect(cmds.some((c) => c.name === "myplugin:helper")).toBe(true);
  });

  test("gated skill 经共享 manager 投影后 isEnabled=false", async () => {
    const manager = new SkillManager();
    manager.addPluginSkills([makeSkill({ name: "cond", paths: ["**/*.md"] })]);
    manager.setGatedSkills(["cond"]);

    const cmds = await loadSkillCommands("/tmp", undefined, undefined, manager);
    const cond = cmds.find((c) => c.name === "cond");
    expect(cond).toBeDefined();
    expect(cond!.isEnabled?.()).toBe(false);

    manager.ungateSkill("cond");
    expect(cond!.isEnabled?.()).toBe(true);
  });
});

describe("replacePluginSkills：/reload-plugins 原子替换（§18.10）", () => {
  const pluginSkill = (name: string) =>
    makeSkill({
      name,
      loadedFrom: "plugin",
      filePath: `/tmp/plugins/${name}/SKILL.md`,
    });

  test("卸载的插件其 skill 被移除，新插件 skill 生效", () => {
    const manager = new SkillManager();
    manager.addPluginSkills([pluginSkill("old:a"), pluginSkill("old:b")]);
    expect(manager.getSkills().map((s) => s.name).sort()).toEqual(["old:a", "old:b"]);

    // 模拟：old 插件被卸载，new 插件被安装
    const count = manager.replacePluginSkills([pluginSkill("new:c")]);
    expect(count).toBe(1);
    expect(manager.getSkills().map((s) => s.name)).toEqual(["new:c"]);
  });

  test("替换插件 skill 不影响 MCP 来源 skill", () => {
    const manager = new SkillManager();
    manager.addPluginSkills([
      pluginSkill("p:one"),
      makeSkill({ name: "mcp-remote", loadedFrom: "mcp", filePath: "mcp://remote" }),
    ]);

    manager.replacePluginSkills([]);
    expect(manager.getSkills().map((s) => s.name)).toEqual(["mcp-remote"]);
  });

  test("替换后旧插件 skill 不会被热重载重放带回来", async () => {
    const manager = new SkillManager();
    manager.addPluginSkills([pluginSkill("gone:x")]);
    manager.replacePluginSkills([pluginSkill("kept:y")]);

    // reload 会重放 appendedSkills——被替换掉的旧插件 skill 不应复活
    await manager.reload();
    const names = manager.getSkills().map((s) => s.name);
    expect(names).toContain("kept:y");
    expect(names).not.toContain("gone:x");
  });

  test("替换触发变更广播（斜杠命令快照失效）", () => {
    const manager = new SkillManager();
    let notified = 0;
    manager.onSkillsChanged(() => notified++);
    manager.replacePluginSkills([pluginSkill("p:z")]);
    expect(notified).toBe(1);
  });
});

describe("SkillManager 变更广播（斜杠命令快照失效）", () => {
  test("addPluginSkills / setDisabledSkills / ungateSkill 都触发通知", () => {
    const manager = new SkillManager();
    let count = 0;
    manager.onSkillsChanged(() => count++);

    manager.addPluginSkills([makeSkill({ name: "a" })]);
    expect(count).toBe(1);

    manager.setDisabledSkills(["a"]);
    expect(count).toBe(2);

    manager.setGatedSkills(["a"]);
    expect(count).toBe(3);

    manager.ungateSkill("a");
    expect(count).toBe(4);

    // 未 gate 的名字重复解除不应产生噪音通知
    manager.ungateSkill("a");
    expect(count).toBe(4);
  });

  test("取消订阅后不再收到通知", () => {
    const manager = new SkillManager();
    let count = 0;
    const off = manager.onSkillsChanged(() => count++);
    manager.addPluginSkills([makeSkill({ name: "b" })]);
    expect(count).toBe(1);
    off();
    manager.addPluginSkills([makeSkill({ name: "c", filePath: "/tmp/c/SKILL.md" })]);
    expect(count).toBe(1);
  });

  test("监听器抛异常不影响其他监听器", () => {
    const manager = new SkillManager();
    let ok = 0;
    manager.onSkillsChanged(() => {
      throw new Error("boom");
    });
    manager.onSkillsChanged(() => ok++);
    manager.addPluginSkills([makeSkill({ name: "d" })]);
    expect(ok).toBe(1);
  });
});
