/**
 * Skill 生命周期钩子集成测试（Task 7）
 */

import { describe, test, expect } from "bun:test";
import { HookSystem } from "@sid-code/core/hook/system.ts";
import { HookEventName } from "@sid-code/core/hook/types.ts";
import {
  registerSkillHooks,
  unregisterSkillHooks,
  isValidHookEvent,
} from "@sid-code/core/skill/hooks.ts";
import type { SkillHooksConfig } from "@sid-code/core/skill/types.ts";

function countFor(sys: HookSystem, event: HookEventName): number {
  return sys.getAllHooks().filter((h) => h.eventName === event).length;
}

describe("isValidHookEvent", () => {
  test("接受 PascalCase 事件名", () => {
    expect(isValidHookEvent("PostToolUse")).toBe(true);
  });
  test("接受旧 snake_case 事件名", () => {
    expect(isValidHookEvent("post_tool_use")).toBe(true);
  });
  test("拒绝未知事件名", () => {
    expect(isValidHookEvent("NopeEvent")).toBe(false);
  });
});

describe("registerSkillHooks", () => {
  const config: SkillHooksConfig = {
    PostToolUse: [
      {
        matcher: "write",
        hooks: [{ command: "echo wrote ${SKILL_DIR}/x", once: false }],
      },
      {
        matcher: "edit",
        hooks: [{ command: "echo edited", once: true }],
      },
    ],
  };

  test("注册 Skill 声明的 hook", () => {
    const sys = new HookSystem();
    const n = registerSkillHooks(sys, "ts-lint", config, "/tmp/ts-lint");
    expect(n).toBe(2);
    expect(countFor(sys, HookEventName.PostToolUse)).toBe(2);
  });

  test("${SKILL_DIR} 在命令中被替换", () => {
    const sys = new HookSystem();
    registerSkillHooks(sys, "ts-lint", config, "/tmp/ts-lint");
    const hooks = sys.getAllHooks();
    const cmds = hooks
      .map((h) => (h.config.type === "command" ? h.config.command : ""))
      .join("|");
    expect(cmds).toContain("/tmp/ts-lint/x");
    expect(cmds).not.toContain("${SKILL_DIR}");
  });

  test("CC 变量写法 ${CLAUDE_SKILL_DIR} / ${CLAUDE_PLUGIN_ROOT} 也被替换", () => {
    const sys = new HookSystem();
    registerSkillHooks(
      sys,
      "cc-skill",
      {
        PostToolUse: [
          {
            matcher: "write",
            hooks: [
              { command: "sh ${CLAUDE_SKILL_DIR}/a.sh" },
              { command: "sh ${CLAUDE_PLUGIN_ROOT}/b.sh" },
            ],
          },
        ],
      },
      "/tmp/cc-skill",
    );
    const cmds = sys
      .getAllHooks()
      .map((h) => (h.config.type === "command" ? h.config.command : ""))
      .join("|");
    expect(cmds).toContain("/tmp/cc-skill/a.sh");
    expect(cmds).toContain("/tmp/cc-skill/b.sh");
    expect(cmds).not.toContain("${CLAUDE_SKILL_DIR}");
    expect(cmds).not.toContain("${CLAUDE_PLUGIN_ROOT}");
  });

  test("skillRoot 注入为 hook 子进程环境变量（对齐 CC CLAUDE_PLUGIN_ROOT）", () => {
    const sys = new HookSystem();
    registerSkillHooks(sys, "ts-lint", config, "/tmp/ts-lint");
    const entry = sys.getAllHooks().find((h) => h.skillName === "ts-lint");
    expect(entry).toBeDefined();
    const env = entry!.config.type === "command" ? entry!.config.env : undefined;
    expect(env?.CLAUDE_PLUGIN_ROOT).toBe("/tmp/ts-lint");
    expect(env?.CLAUDE_SKILL_DIR).toBe("/tmp/ts-lint");
    expect(env?.SID_CODE_SKILL_DIR).toBe("/tmp/ts-lint");
    expect(env?.SID_CODE_SKILL_NAME).toBe("ts-lint");
  });

  test("无 skillRoot 时只注入 skill 名，不产生空路径变量", () => {
    const sys = new HookSystem();
    registerSkillHooks(
      sys,
      "no-root",
      { Stop: [{ matcher: "*", hooks: [{ command: "echo hi" }] }] },
      undefined,
    );
    const entry = sys.getAllHooks().find((h) => h.skillName === "no-root");
    const env = entry?.config.type === "command" ? entry.config.env : undefined;
    expect(env?.SID_CODE_SKILL_NAME).toBe("no-root");
    expect(env?.CLAUDE_PLUGIN_ROOT).toBeUndefined();
  });

  test("hook 标注 skillName 与 once", () => {
    const sys = new HookSystem();
    registerSkillHooks(sys, "ts-lint", config, "/tmp/ts-lint");
    const hooks = sys.getAllHooks().filter((h) => h.skillName === "ts-lint");
    expect(hooks.length).toBe(2);
    const onceHook = hooks.find((h) => h.once);
    expect(onceHook).toBeDefined();
  });

  test("未知事件名被跳过", () => {
    const sys = new HookSystem();
    const n = registerSkillHooks(
      sys,
      "x",
      { BadEvent: [{ matcher: "*", hooks: [{ command: "echo" }] }] } as any,
      undefined,
    );
    expect(n).toBe(0);
  });

  test("无 hooks 配置返回 0", () => {
    const sys = new HookSystem();
    expect(registerSkillHooks(sys, "x", undefined, undefined)).toBe(0);
  });
});

describe("once hook 生命周期（执行一次后失效）", () => {
  test("once:true 的 hook 执行成功后不再触发；once:false 持续触发", async () => {
    const sys = new HookSystem();
    // 用 true 作为命令（退出码 0 = 成功），确保 once 回标条件成立
    registerSkillHooks(
      sys,
      "once-skill",
      { PostToolUse: [{ matcher: "write", hooks: [{ command: "true", once: true }] }] },
      undefined,
    );
    registerSkillHooks(
      sys,
      "always-skill",
      { PostToolUse: [{ matcher: "write", hooks: [{ command: "true", once: false }] }] },
      undefined,
    );

    const activeForWrite = () =>
      sys
        .getHooksForEvent(HookEventName.PostToolUse)
        .filter((h) => h.matcher === "write").length;

    expect(activeForWrite()).toBe(2);

    // 第一次触发：两个都跑，once 的执行成功后被标记
    await sys.firePostToolUseEvent("write", { file_path: "/tmp/a" }, { output: "ok" }, false);
    expect(activeForWrite()).toBe(1);
    expect(
      sys
        .getHooksForEvent(HookEventName.PostToolUse)
        .some((h) => h.skillName === "always-skill"),
    ).toBe(true);

    // 第二次触发：once 已失效，不应回到可执行集合
    await sys.firePostToolUseEvent("write", { file_path: "/tmp/b" }, { output: "ok" }, false);
    expect(activeForWrite()).toBe(1);
  });

  test("once hook 执行失败时保留（下次仍可重试）", async () => {
    const sys = new HookSystem();
    // 退出码 1 = 失败（非 2，不构成阻断语义，仅算执行失败）
    registerSkillHooks(
      sys,
      "flaky",
      { PostToolUse: [{ matcher: "write", hooks: [{ command: "exit 1", once: true }] }] },
      undefined,
    );

    await sys.firePostToolUseEvent("write", { file_path: "/tmp/a" }, { output: "ok" }, false);
    // 失败不回标 → hook 仍在可执行集合里
    expect(
      sys.getHooksForEvent(HookEventName.PostToolUse).filter((h) => h.skillName === "flaky").length,
    ).toBe(1);
  });
});

describe("unregisterSkillHooks", () => {
  test("移除指定 Skill 的所有 hook", () => {
    const sys = new HookSystem();
    registerSkillHooks(
      sys,
      "a",
      { Stop: [{ matcher: "*", hooks: [{ command: "echo a" }] }] },
      undefined,
    );
    registerSkillHooks(
      sys,
      "b",
      { Stop: [{ matcher: "*", hooks: [{ command: "echo b" }] }] },
      undefined,
    );
    expect(countFor(sys, HookEventName.Stop)).toBe(2);

    const removed = unregisterSkillHooks(sys, "a");
    expect(removed).toBe(1);
    const remaining = sys.getAllHooks().filter((h) => h.eventName === HookEventName.Stop);
    expect(remaining.length).toBe(1);
    expect(remaining[0].skillName).toBe("b");
  });
});
