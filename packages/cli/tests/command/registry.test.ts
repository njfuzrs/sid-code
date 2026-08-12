/**
 * 命令注册表测试
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { Registry } from "@sid-code/cli/command/registry.ts";
import type { Command, AppContext, CommandResult } from "@sid-code/cli/command/types.ts";

/** 测试用的 mock 命令 */
class MockCommand implements Command {
  constructor(
    private _name: string,
    private _aliases: string[] = [],
    private _subCommands?: Command[],
  ) {}
  name() {
    return this._name;
  }
  aliases() {
    return this._aliases;
  }
  description() {
    return `Mock command: ${this._name}`;
  }
  subCommands() {
    return this._subCommands ?? [];
  }
  async execute(_args: string, _ctx: AppContext): Promise<CommandResult> {
    return { kind: "message", message: `${this._name} executed` };
  }
}

describe("CommandRegistry - 基础功能", () => {
  test("注册和查找命令", () => {
    const reg = new Registry();
    const cmd = new MockCommand("help");
    reg.register(cmd);

    expect(reg.get("help")).toBe(cmd);
    expect(reg.get("nonexistent")).toBeUndefined();
  });

  test("通过别名查找命令", () => {
    const reg = new Registry();
    const cmd = new MockCommand("help", ["h", "?"]);
    reg.register(cmd);

    expect(reg.get("h")).toBe(cmd);
    expect(reg.get("?")).toBe(cmd);
  });

  test("列举所有命令", () => {
    const reg = new Registry();
    reg.register(new MockCommand("help"));
    reg.register(new MockCommand("model"));
    reg.register(new MockCommand("cost"));

    expect(reg.all().length).toBe(3);
  });
});

describe("CommandRegistry - 子命令支持", () => {
  let registry: Registry;

  beforeEach(() => {
    registry = new Registry();

    // 创建带子命令的父命令
    const sub1 = new MockCommand("sub1", ["s1"]);
    const subsub = new MockCommand("subsub");
    const sub2 = new MockCommand("sub2", [], [subsub]);
    const parent = new MockCommand("parent", ["p"], [sub1, sub2]);

    registry.register(parent);
  });

  test("查找顶级命令", () => {
    const cmd = registry.get("parent");
    expect(cmd).toBeDefined();
    expect(cmd?.name()).toBe("parent");
  });

  test("通过别名查找顶级命令", () => {
    const cmd = registry.get("p");
    expect(cmd).toBeDefined();
    expect(cmd?.name()).toBe("parent");
  });

  test("查找一级子命令", () => {
    const cmd = registry.get("parent sub1");
    expect(cmd).toBeDefined();
    expect(cmd?.name()).toBe("sub1");
  });

  test("通过别名查找一级子命令", () => {
    const cmd = registry.get("parent s1");
    expect(cmd).toBeDefined();
    expect(cmd?.name()).toBe("sub1");
  });

  test("查找二级子命令", () => {
    const cmd = registry.get("parent sub2 subsub");
    expect(cmd).toBeDefined();
    expect(cmd?.name()).toBe("subsub");
  });

  test("子命令不存在时返回父命令", () => {
    const cmd = registry.get("parent nonexistent");
    expect(cmd).toBeDefined();
    expect(cmd?.name()).toBe("parent");
  });

  test("多余空格不影响查找", () => {
    const cmd = registry.get("  parent   sub1  ");
    expect(cmd).toBeDefined();
    expect(cmd?.name()).toBe("sub1");
  });

  test("all() 只返回顶级命令", () => {
    const commands = registry.all();
    expect(commands.length).toBe(1);
    expect(commands[0].name()).toBe("parent");
  });
});

describe("CommandRegistry - 命令冲突处理", () => {
  test("内置命令不可被覆盖", () => {
    const reg = new Registry();
    const builtin = new MockCommand("builtin");
    const user = new MockCommand("builtin");

    reg.register(builtin, "builtin");
    reg.register(user, "user");

    // 用户命令被重命名为 user.builtin
    const userCmd = reg.get("user.builtin");
    expect(userCmd).toBeDefined();

    // 内置命令仍然可用
    const builtinCmd = reg.get("builtin");
    expect(builtinCmd).toBe(builtin);
  });

  test("项目级命令覆盖用户级命令", () => {
    const reg = new Registry();
    const user = new MockCommand("custom");
    const project = new MockCommand("custom");

    reg.register(user, "user");
    reg.register(project, "project");

    const cmd = reg.get("custom");
    expect(cmd).toBe(project);
  });

  test("P0-3 别名冲突保留先注册者，不 last-write-wins", () => {
    const reg = new Registry();
    const first = new MockCommand("first", ["x"]);
    const second = new MockCommand("second", ["x"]);

    reg.register(first);
    reg.register(second);

    // /x 落到先注册的 first（后者别名被忽略），而非静默覆盖到 second
    expect(reg.get("x")).toBe(first);
    // 两个命令名本身都在
    expect(reg.get("first")).toBe(first);
    expect(reg.get("second")).toBe(second);
  });

  test("P0-3 同一命令重复注册别名不误报（幂等）", () => {
    const reg = new Registry();
    const cmd = new MockCommand("dup", ["a"]);
    reg.register(cmd);
    reg.register(cmd); // 再注册同一实例，别名指向不变，不应被"冲突"逻辑拦掉
    expect(reg.get("a")).toBe(cmd);
  });
});
