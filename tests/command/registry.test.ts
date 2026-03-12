/**
 * 命令注册表测试
 */

import { describe, test, expect } from "bun:test";
import { Registry } from "../../src/command/registry.ts";
import type { Command, AppContext } from "../../src/command/types.ts";

/** 测试用的 mock 命令 */
class MockCommand implements Command {
  constructor(
    private _name: string,
    private _aliases: string[] = [],
  ) {}
  name() { return this._name; }
  aliases() { return this._aliases; }
  description() { return `Mock command: ${this._name}`; }
  async execute() {}
}

describe("CommandRegistry", () => {
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
