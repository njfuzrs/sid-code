/**
 * ArgParser 单元测试
 */

import { describe, test, expect } from "bun:test";
import { ArgParser } from "@sid-code/cli/command/args.ts";

describe("ArgParser", () => {
  test("解析位置参数", () => {
    const parser = new ArgParser("add server myserver");
    expect(parser.get(0)).toBe("add");
    expect(parser.get(1)).toBe("server");
    expect(parser.get(2)).toBe("myserver");
    expect(parser.get(3)).toBeUndefined();
    expect(parser.length).toBe(3);
  });

  test("解析 --key=value 选项", () => {
    const parser = new ArgParser("add server --scope=user --timeout=5000");
    expect(parser.get(0)).toBe("add");
    expect(parser.get(1)).toBe("server");
    expect(parser.string("scope")).toBe("user");
    expect(parser.number("timeout")).toBe(5000);
  });

  test("解析 --key value 选项", () => {
    const parser = new ArgParser("add server --scope user --timeout 5000");
    expect(parser.string("scope")).toBe("user");
    expect(parser.number("timeout")).toBe(5000);
  });

  test("解析布尔标志", () => {
    const parser = new ArgParser("list --all --verbose");
    expect(parser.flag("all")).toBe(true);
    expect(parser.flag("verbose")).toBe(true);
    expect(parser.flag("quiet")).toBe(false);
  });

  test("混合位置参数和选项", () => {
    const parser = new ArgParser("add myserver http://localhost --scope user --trust");
    expect(parser.get(0)).toBe("add");
    expect(parser.get(1)).toBe("myserver");
    expect(parser.get(2)).toBe("http://localhost");
    expect(parser.string("scope")).toBe("user");
    expect(parser.flag("trust")).toBe(true);
  });

  test("getRest 获取剩余参数", () => {
    const parser = new ArgParser("add server arg1 arg2 arg3 --flag");
    expect(parser.getRest(2)).toBe("arg1 arg2 arg3");
  });

  test("getAll 获取所有位置参数", () => {
    const parser = new ArgParser("a b c --flag d e");
    // --flag 是布尔标志，d 被当作 flag 的值（但 flag 是布尔所以被忽略），e 是位置参数
    expect(parser.getAll()).toEqual(["a", "b", "c", "e"]);
  });

  test("选项默认值", () => {
    const parser = new ArgParser("list");
    expect(parser.string("scope", "user")).toBe("user");
    expect(parser.number("timeout", 3000)).toBe(3000);
    expect(parser.flag("all")).toBe(false);
  });

  test("has 检查选项是否存在", () => {
    const parser = new ArgParser("list --scope user");
    expect(parser.has("scope")).toBe(true);
    expect(parser.has("timeout")).toBe(false);
  });

  test("空字符串", () => {
    const parser = new ArgParser("");
    expect(parser.length).toBe(0);
    expect(parser.get(0)).toBeUndefined();
  });

  test("只有选项没有位置参数", () => {
    const parser = new ArgParser("--flag --key value");
    expect(parser.length).toBe(0); // 没有位置参数
    expect(parser.flag("flag")).toBe(true);
    expect(parser.string("key")).toBe("value");
  });

  test("number 解析非数字返回默认值", () => {
    const parser = new ArgParser("--timeout abc");
    expect(parser.number("timeout", 3000)).toBe(3000);
  });

  test("string 忽略布尔标志", () => {
    const parser = new ArgParser("--flag");
    expect(parser.string("flag", "default")).toBe("default");
  });
});
