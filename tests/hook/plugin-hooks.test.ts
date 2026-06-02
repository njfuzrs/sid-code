import { describe, expect, test } from "bun:test";
import { HookSystem } from "../../src/hook/system.ts";
import { ConfigSource } from "../../src/hook/types.ts";

describe("HookSystem.replacePluginHooks - 插件 Hook 原子替换", () => {
  test("注册插件 hooks", () => {
    const sys = new HookSystem();
    sys.replacePluginHooks({
      PreToolUse: [{ type: "command", command: "echo a" }],
    });
    const pluginHooks = sys.getAllHooks().filter((h) => h.source === ConfigSource.Plugin);
    expect(pluginHooks).toHaveLength(1);
  });

  test("二次调用清除旧插件 hooks", () => {
    const sys = new HookSystem();
    sys.replacePluginHooks({
      PreToolUse: [{ type: "command", command: "echo a" }],
      PostToolUse: [{ type: "command", command: "echo b" }],
    });
    expect(sys.getAllHooks().filter((h) => h.source === ConfigSource.Plugin)).toHaveLength(2);

    // 第二次只含一个 hook
    sys.replacePluginHooks({
      PreToolUse: [{ type: "command", command: "echo c" }],
    });
    const after = sys.getAllHooks().filter((h) => h.source === ConfigSource.Plugin);
    expect(after).toHaveLength(1);
  });

  test("不影响 user/project 来源的 hooks", () => {
    const sys = new HookSystem();
    // 通过 legacy 配置注册 user hook
    sys.initializeFromLegacy({
      PreToolUse: [{ type: "command", command: "echo user" }],
    });
    const userBefore = sys.getAllHooks().filter((h) => h.source !== ConfigSource.Plugin).length;

    sys.replacePluginHooks({ PreToolUse: [{ type: "command", command: "echo plugin" }] });
    sys.replacePluginHooks({ PreToolUse: [{ type: "command", command: "echo plugin2" }] });

    const userAfter = sys.getAllHooks().filter((h) => h.source !== ConfigSource.Plugin).length;
    expect(userAfter).toBe(userBefore); // user hooks 数量不变
  });

  test("空配置清除所有插件 hooks", () => {
    const sys = new HookSystem();
    sys.replacePluginHooks({ PreToolUse: [{ type: "command", command: "echo a" }] });
    sys.replacePluginHooks({});
    expect(sys.getAllHooks().filter((h) => h.source === ConfigSource.Plugin)).toHaveLength(0);
  });

  test("无效事件名被跳过", () => {
    const sys = new HookSystem();
    sys.replacePluginHooks({
      NotARealEvent: [{ type: "command", command: "echo x" }],
      PreToolUse: [{ type: "command", command: "echo ok" }],
    });
    expect(sys.getAllHooks().filter((h) => h.source === ConfigSource.Plugin)).toHaveLength(1);
  });

  test("url 类型 hook 正确转换", () => {
    const sys = new HookSystem();
    sys.replacePluginHooks({
      PreToolUse: [{ type: "url", url: "http://localhost/hook", method: "POST" }],
    });
    const pluginHooks = sys.getAllHooks().filter((h) => h.source === ConfigSource.Plugin);
    expect(pluginHooks).toHaveLength(1);
    expect(pluginHooks[0].config.type).toBe("url");
  });
});
