import { describe, expect, test } from "bun:test";
import { Registry } from "@sid-code/cli/command/registry.ts";
import type { Command, AppContext, CommandResult } from "@sid-code/cli/command/types.ts";

/** 构造一个最小命令 */
function mkCmd(name: string, aliases: string[] = []): Command {
  return {
    name: () => name,
    aliases: () => aliases,
    description: () => `cmd ${name}`,
    async execute(_a: string, _c: AppContext): Promise<CommandResult> {
      return { kind: "message", message: name };
    },
  };
}

describe("CommandRegistry.replacePluginCommands - 插件命令原子替换", () => {
  test("注册插件命令", () => {
    const reg = new Registry();
    reg.replacePluginCommands([mkCmd("my-plugin:deploy")]);
    expect(reg.get("my-plugin:deploy")).toBeDefined();
  });

  test("再次调用清除旧插件命令", () => {
    const reg = new Registry();
    reg.replacePluginCommands([mkCmd("p:a"), mkCmd("p:b")]);
    expect(reg.get("p:a")).toBeDefined();
    expect(reg.get("p:b")).toBeDefined();

    // 第二次只含 p:c，应清除 p:a / p:b
    reg.replacePluginCommands([mkCmd("p:c")]);
    expect(reg.get("p:a")).toBeUndefined();
    expect(reg.get("p:b")).toBeUndefined();
    expect(reg.get("p:c")).toBeDefined();
  });

  test("不影响内置命令", () => {
    const reg = new Registry();
    reg.register(mkCmd("help"), "builtin");
    reg.replacePluginCommands([mkCmd("p:x")]);
    reg.replacePluginCommands([mkCmd("p:y")]); // 二次替换
    expect(reg.get("help")).toBeDefined(); // 内置命令仍在
  });

  test("插件命令别名被正确清理", () => {
    const reg = new Registry();
    reg.replacePluginCommands([mkCmd("p:a", ["pa"])]);
    expect(reg.get("pa")).toBeDefined();
    reg.replacePluginCommands([mkCmd("p:b")]);
    expect(reg.get("pa")).toBeUndefined(); // 旧别名已清理
  });

  test("空列表清空所有插件命令", () => {
    const reg = new Registry();
    reg.replacePluginCommands([mkCmd("p:a")]);
    reg.replacePluginCommands([]);
    expect(reg.get("p:a")).toBeUndefined();
  });
});
