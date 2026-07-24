/**
 * G13：EnterprisePolicyGate 接线到 HookRegistry
 *
 * 验证 getHooksForEvent 经企业策略门控过滤：
 * 1. disableAllHooks → 任何来源的 hook 都被屏蔽；
 * 2. allowManagedHooksOnly → 仅保留 Runtime/Project 来源，屏蔽 User/Plugin/Global；
 * 3. 未设策略 / 空策略 → 不过滤（全部返回）。
 */

import { describe, test, expect } from "bun:test";
import { HookRegistry } from "../../src/hook/registry.ts";
import { HookSystem } from "../../src/hook/system.ts";
import { EnterprisePolicyGate } from "../../src/hook/enterprise-policy.ts";
import { HookEventName, ConfigSource } from "../../src/hook/types.ts";

/** 注册一个带指定来源的 command hook */
function addHook(registry: HookRegistry, source: ConfigSource, name: string): void {
  registry.registerHook(
    { type: "command", name, command: `echo ${name}`, source },
    HookEventName.PreToolUse,
    { source },
  );
}

describe("G13 EnterprisePolicyGate 过滤", () => {
  test("disableAllHooks → 全部屏蔽", () => {
    const registry = new HookRegistry();
    addHook(registry, ConfigSource.Runtime, "runtime-hook");
    addHook(registry, ConfigSource.User, "user-hook");
    expect(registry.getHooksForEvent(HookEventName.PreToolUse).length).toBe(2);

    registry.setPolicyGate(new EnterprisePolicyGate({ disableAllHooks: true }));
    expect(registry.getHooksForEvent(HookEventName.PreToolUse).length).toBe(0);
  });

  test("allowManagedHooksOnly → 仅保留 Runtime/Project 来源", () => {
    const registry = new HookRegistry();
    addHook(registry, ConfigSource.Runtime, "runtime-hook");
    addHook(registry, ConfigSource.Project, "project-hook");
    addHook(registry, ConfigSource.User, "user-hook");
    addHook(registry, ConfigSource.Plugin, "plugin-hook");

    registry.setPolicyGate(new EnterprisePolicyGate({ allowManagedHooksOnly: true }));
    const kept = registry.getHooksForEvent(HookEventName.PreToolUse);
    const names = kept.map(e => e.config.type === "command" ? e.config.name : undefined);
    expect(kept.length).toBe(2);
    expect(names).toContain("runtime-hook");
    expect(names).toContain("project-hook");
    expect(names).not.toContain("user-hook");
    expect(names).not.toContain("plugin-hook");
  });

  test("空策略 / 解除门控 → 不过滤", () => {
    const registry = new HookRegistry();
    addHook(registry, ConfigSource.User, "user-hook");
    registry.setPolicyGate(new EnterprisePolicyGate({}));
    expect(registry.getHooksForEvent(HookEventName.PreToolUse).length).toBe(1);
    // 解除门控
    registry.setPolicyGate(undefined);
    expect(registry.getHooksForEvent(HookEventName.PreToolUse).length).toBe(1);
  });

  test("HookSystem.applyEnterprisePolicy 门面接线到 registry（经 fire 验证屏蔽效果）", async () => {
    const system = new HookSystem();
    let fired = false;
    system.registerHook(
      { type: "runtime", name: "user-runtime-hook", action: async () => { fired = true; }, source: ConfigSource.User },
      HookEventName.PreToolUse,
      { source: ConfigSource.User },
    );

    // 应用 disableAllHooks → 门面转发到 registry，fire 时被门控屏蔽，action 不执行
    system.applyEnterprisePolicy({ disableAllHooks: true });
    await system.firePreToolUseEvent("Bash", { command: "ls" }, "tool-1");
    expect(fired).toBe(false);

    // 解除门控 → hook 恢复执行
    system.applyEnterprisePolicy(undefined);
    await system.firePreToolUseEvent("Bash", { command: "ls" }, "tool-2");
    expect(fired).toBe(true);
  });
});
