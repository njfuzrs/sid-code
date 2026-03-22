/**
 * 权限规则匹配测试
 */

import { describe, test, expect } from "bun:test";
import { matchRule, checkRules, mergeRules } from "../../src/permission/rules.ts";
import type { PermissionRule } from "../../src/permission/types.ts";

describe("matchRule", () => {
  test("工具级匹配", () => {
    expect(matchRule("Read", { toolName: "read", input: {} })).toBe(true);
    expect(matchRule("Write", { toolName: "write", input: {} })).toBe(true);
    expect(matchRule("Read", { toolName: "write", input: {} })).toBe(false);
  });

  test("大小写不敏感", () => {
    expect(matchRule("Read", { toolName: "read", input: {} })).toBe(true);
    expect(matchRule("BASH", { toolName: "bash", input: {} })).toBe(true);
  });

  test("路径限定匹配", () => {
    expect(matchRule("Read(src/**)", {
      toolName: "read",
      input: { file_path: "src/index.ts" },
    })).toBe(true);

    expect(matchRule("Read(src/**)", {
      toolName: "read",
      input: { file_path: "tests/index.ts" },
    })).toBe(false);
  });

  test("命令模式匹配", () => {
    expect(matchRule("Bash(npm *)", {
      toolName: "bash",
      input: { command: "npm test" },
    })).toBe(true);

    expect(matchRule("Bash(npm *)", {
      toolName: "bash",
      input: { command: "yarn test" },
    })).toBe(false);
  });

  test("无参数值时不匹配带模式的规则", () => {
    expect(matchRule("Bash(npm *)", {
      toolName: "bash",
      input: {},
    })).toBe(false);
  });

  test("无效规则格式返回 false", () => {
    expect(matchRule("", { toolName: "read", input: {} })).toBe(false);
    expect(matchRule("Read(", { toolName: "read", input: {} })).toBe(false);
  });

  test("MCP 工具通配符 - mcp__* 匹配所有 MCP 工具", () => {
    expect(matchRule("mcp__*", {
      toolName: "mcp__myserver__read",
      input: {},
    })).toBe(true);

    expect(matchRule("mcp__*", {
      toolName: "mcp__otherserver__write",
      input: {},
    })).toBe(true);

    expect(matchRule("mcp__*", {
      toolName: "read",
      input: {},
    })).toBe(false);
  });

  test("MCP 工具通配符 - mcp__server__* 匹配特定 server 的所有工具", () => {
    expect(matchRule("mcp__myserver__*", {
      toolName: "mcp__myserver__read",
      input: {},
    })).toBe(true);

    expect(matchRule("mcp__myserver__*", {
      toolName: "mcp__myserver__write",
      input: {},
    })).toBe(true);

    expect(matchRule("mcp__myserver__*", {
      toolName: "mcp__otherserver__read",
      input: {},
    })).toBe(false);
  });

  test("MCP 工具通配符 + 参数模式", () => {
    expect(matchRule("mcp__myserver__*(*.env)", {
      toolName: "mcp__myserver__read",
      input: { file_path: ".env" },
    })).toBe(true);

    expect(matchRule("mcp__myserver__*(*.env)", {
      toolName: "mcp__myserver__read",
      input: { file_path: "config.json" },
    })).toBe(false);
  });
});

describe("checkRules", () => {
  test("deny 优先于 allow", () => {
    const rules: PermissionRule = {
      allow: ["Bash(*)"],
      deny: ["Bash(rm *)"],
    };

    const denyResult = checkRules(rules, {
      toolName: "bash",
      input: { command: "rm test.txt" },
    });
    expect(denyResult?.allowed).toBe(false);

    const allowResult = checkRules(rules, {
      toolName: "bash",
      input: { command: "ls" },
    });
    expect(allowResult?.allowed).toBe(true);
  });

  test("无匹配规则返回 null", () => {
    const rules: PermissionRule = {
      allow: ["Read"],
    };

    const result = checkRules(rules, {
      toolName: "write",
      input: { file_path: "/tmp/test.txt" },
    });
    expect(result).toBeNull();
  });

  test("ask 规则返回 needsConfirmation", () => {
    const rules: PermissionRule = {
      ask: ["Write"],
    };

    const result = checkRules(rules, {
      toolName: "write",
      input: { file_path: "/tmp/test.txt" },
    });
    expect(result?.allowed).toBe(false);
    expect(result?.needsConfirmation).toBe(true);
  });

  test("空规则返回 null", () => {
    const rules: PermissionRule = {};
    const result = checkRules(rules, {
      toolName: "read",
      input: {},
    });
    expect(result).toBeNull();
  });
});

describe("mergeRules", () => {
  test("合并多层规则", () => {
    const layer1: PermissionRule = {
      allow: ["Read"],
      deny: ["Bash(rm *)"],
    };
    const layer2: PermissionRule = {
      allow: ["Grep"],
      ask: ["Write"],
    };

    const merged = mergeRules(layer1, layer2);
    expect(merged.allow).toEqual(["Read", "Grep"]);
    expect(merged.deny).toEqual(["Bash(rm *)"]);
    expect(merged.ask).toEqual(["Write"]);
  });

  test("空层不影响结果", () => {
    const layer1: PermissionRule = { allow: ["Read"] };
    const empty: PermissionRule = {};

    const merged = mergeRules(layer1, empty);
    expect(merged.allow).toEqual(["Read"]);
    expect(merged.deny).toEqual([]);
    expect(merged.ask).toEqual([]);
  });
});
