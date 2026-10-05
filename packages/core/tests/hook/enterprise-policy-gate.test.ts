/**
 * G13：EnterprisePolicyGate 接线到 HookRegistry
 *
 * 验证 getHooksForEvent 经企业策略门控过滤：
 * 1. disableAllHooks → 用户可配置的 hook 全部屏蔽（H28：内部 runtime hook 除外）；
 * 2. allowManagedHooksOnly → 仅保留 Runtime/Project 来源，屏蔽 User/Plugin/Global；
 * 3. 未设策略 / 空策略 → 不过滤（全部返回）。
 */

import { describe, test, expect } from "bun:test";
import { HookRegistry } from "@sid-code/core/hook/registry.ts";
import { HookSystem } from "@sid-code/core/hook/system.ts";
import { EnterprisePolicyGate } from "@sid-code/core/hook/enterprise-policy.ts";
import { HookEventName, ConfigSource } from "@sid-code/core/hook/types.ts";

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
    const names = kept.map((e) => (e.config.type === "command" ? e.config.name : undefined));
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
      {
        type: "runtime",
        name: "internal-runtime-hook",
        action: async () => {
          fired = true;
        },
      },
      HookEventName.PreToolUse,
    );
    system.registerHook(
      { type: "command", name: "user-cmd", command: "true", source: ConfigSource.User },
      HookEventName.PreToolUse,
      { source: ConfigSource.User },
    );
    const types = () => system.getHooksForEvent(HookEventName.PreToolUse).map((e) => e.config.type);

    // 应用 disableAllHooks → 门面转发到 registry：用户 command hook 被屏蔽；
    // H28：内部 runtime hook（轨迹 / 遥测 / 会话指标的载体）不受此开关影响，照常执行
    system.applyEnterprisePolicy({ disableAllHooks: true });
    expect(types()).toEqual(["runtime"]);
    await system.firePreToolUseEvent("Bash", { command: "ls" }, "tool-1");
    expect(fired).toBe(true);

    // 解除门控 → 用户 hook 恢复
    system.applyEnterprisePolicy(undefined);
    expect(types().sort()).toEqual(["command", "runtime"]);
  });
});
