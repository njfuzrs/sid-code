/**
 * 命令解析器测试（Task 7）
 */

import { describe, test, expect } from "bun:test";
import {
  parseSlashCommand,
  looksLikeCommand,
} from "../../src/command/parser.ts";

describe("parseSlashCommand", () => {
  test("解析普通命令", () => {
    const r = parseSlashCommand("/compact");
    expect(r).toEqual({ commandName: "compact", args: "", isMcp: false });
  });

  test("解析带参数的命令", () => {
    const r = parseSlashCommand("/model claude-opus-4");
    expect(r).toEqual({
      commandName: "model",
      args: "claude-opus-4",
      isMcp: false,
    });
  });

  test("多个参数合并为 args 字符串", () => {
    const r = parseSlashCommand("/memory set key value here");
    expect(r?.commandName).toBe("memory");
    expect(r?.args).toBe("set key value here");
  });

  test("识别 MCP 命令格式", () => {
    const r = parseSlashCommand("/server (MCP) do something");
    expect(r).toEqual({
      commandName: "server (MCP)",
      args: "do something",
      isMcp: true,
    });
  });

  test("非斜杠输入返回 null", () => {
    expect(parseSlashCommand("hello world")).toBeNull();
  });

  test("仅斜杠返回 null", () => {
    expect(parseSlashCommand("/")).toBeNull();
    expect(parseSlashCommand("/   ")).toBeNull();
  });

  test("前后空白被裁剪", () => {
    const r = parseSlashCommand("  /help foo  ");
    expect(r?.commandName).toBe("help");
    expect(r?.args).toBe("foo");
  });
});

describe("looksLikeCommand", () => {
  test("纯命令名字符返回 true", () => {
    expect(looksLikeCommand("compact")).toBe(true);
    expect(looksLikeCommand("mcp-list")).toBe(true);
    expect(looksLikeCommand("foo_bar")).toBe(true);
    expect(looksLikeCommand("ns:cmd")).toBe(true);
  });

  test("含斜杠的路径返回 false", () => {
    expect(looksLikeCommand("var/log")).toBe(false);
    expect(looksLikeCommand("usr/local/bin")).toBe(false);
  });

  test("含空格或点返回 false", () => {
    expect(looksLikeCommand("foo bar")).toBe(false);
    expect(looksLikeCommand("a.b")).toBe(false);
  });
});
