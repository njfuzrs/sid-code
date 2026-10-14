/**
 * `sid-code plugin` CLI 子命令（command/plugin-cli.ts）：与 /plugin 同一实现，退出码确定。
 */

import { describe, test, expect } from "bun:test";
import { handlePluginCommand } from "@sid-code/cli/command/plugin-cli.ts";

function capture() {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    out: { log: (s: string) => logs.push(s), error: (s: string) => errors.push(s) },
    logs,
    errors,
  };
}

describe("handlePluginCommand", () => {
  test("无参数：打印用法，退出码 1", async () => {
    const c = capture();
    expect(await handlePluginCommand([], c.out)).toBe(1);
    expect(c.logs.join("\n")).toContain("用法: sid-code plugin");
  });

  test("--help：打印用法，退出码 0", async () => {
    const c = capture();
    expect(await handlePluginCommand(["--help"], c.out)).toBe(0);
  });

  test("未知子命令：走 /plugin 同一实现的报错，退出码 1、写 stderr", async () => {
    const c = capture();
    expect(await handlePluginCommand(["frobnicate"], c.out)).toBe(1);
    expect(c.errors.join("\n")).toContain("未知子命令: frobnicate");
    expect(c.logs).toEqual([]);
  });

  test("缺参数的子命令：install 无目标 → 退出码 1", async () => {
    const c = capture();
    expect(await handlePluginCommand(["install"], c.out)).toBe(1);
    expect(c.errors.join("\n")).toContain("用法: /plugin install");
  });
});
