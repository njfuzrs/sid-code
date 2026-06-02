/**
 * Skill 生命周期钩子集成测试（Task 7）
 */

import { describe, test, expect } from "bun:test";
import { HookSystem } from "../../src/hook/system.ts";
import { HookEventName } from "../../src/hook/types.ts";
import {
  registerSkillHooks,
  unregisterSkillHooks,
  isValidHookEvent,
} from "../../src/skill/hooks.ts";
import type { SkillHooksConfig } from "../../src/skill/types.ts";

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
