/**
 * P0-2 / P1-1 / P1-2 / P2-1：自定义 agent frontmatter 扩展字段消费 单测
 *
 * 覆盖 parseAgentExtendedFrontmatter 的七个字段（model/skills/color/permissionMode/
 * hooks/background/isolation）：合法值消费、非法值 warn 跳过（不抛错）、双格式解析。
 * 以及 buildAgentHookSystem 的隔离语义（每个声明 hooks 的 agent 拿独立 HookSystem）。
 */

import { describe, it, expect } from "bun:test";
import { parseAgentExtendedFrontmatter, parseListField } from "@sid-code/core/agent/custom.ts";
import { buildAgentHookSystem, registerAgentHooks } from "@sid-code/core/agent/agent-hooks.ts";
import { HookSystem } from "@sid-code/core/hook/system.ts";

const parse = (fm: Record<string, unknown>) => parseAgentExtendedFrontmatter(fm, "test-agent");

describe("parseListField 双格式（tools/skills 共用）", () => {
  it("逗号分隔字符串", () => {
    expect(parseListField("a, b ,c")).toEqual(["a", "b", "c"]);
  });
  it("YAML 数组", () => {
    expect(parseListField(["a", " b "])).toEqual(["a", "b"]);
  });
  it("空值/非法类型 → 空数组", () => {
    expect(parseListField(undefined)).toEqual([]);
    expect(parseListField(null)).toEqual([]);
    expect(parseListField(42)).toEqual([]);
    expect(parseListField("")).toEqual([]);
  });
});

describe("model（P0-2）", () => {
  it("消费显式模型名", () => {
    expect(parse({ model: "cheap-model" }).model).toBe("cheap-model");
  });
  it('"inherit" 视为不设（大小写不敏感）', () => {
    expect(parse({ model: "inherit" }).model).toBeUndefined();
    expect(parse({ model: "Inherit" }).model).toBeUndefined();
    expect(parse({ model: "INHERIT" }).model).toBeUndefined();
  });
  it("空串/非字符串忽略", () => {
    expect(parse({ model: "  " }).model).toBeUndefined();
    expect(parse({ model: 42 }).model).toBeUndefined();
  });
});

describe("skills（P1-1）", () => {
  it("逗号分隔与数组两种写法都消费", () => {
    expect(parse({ skills: "api-conventions, error-handling" }).skills).toEqual([
      "api-conventions",
      "error-handling",
    ]);
    expect(parse({ skills: ["a", "b"] }).skills).toEqual(["a", "b"]);
  });
  it("空列表不设字段（保持 undefined 而非空数组）", () => {
    expect(parse({ skills: "" }).skills).toBeUndefined();
    expect(parse({}).skills).toBeUndefined();
  });
});

describe("color（P1-2）", () => {
  it("透传字符串（色板校验在注册层）", () => {
    expect(parse({ color: "blue" }).color).toBe("blue");
    expect(parse({ color: " purple " }).color).toBe("purple");
  });
  it("空串/非字符串忽略", () => {
    expect(parse({ color: "   " }).color).toBeUndefined();
    expect(parse({ color: 1 }).color).toBeUndefined();
  });
});

describe("permissionMode（P2-1）", () => {
  it("合法枚举值消费", () => {
    for (const mode of ["default", "acceptEdits", "plan", "dontAsk", "deny-write"]) {
      expect(parse({ permissionMode: mode }).permissionMode).toBe(mode);
    }
  });
  it("非法值跳过（warn 不抛）", () => {
    expect(parse({ permissionMode: "yolo" }).permissionMode).toBeUndefined();
    expect(parse({ permissionMode: 3 }).permissionMode).toBeUndefined();
  });
});

describe("background / isolation（P2-1）", () => {
  it("background 只接受布尔", () => {
    expect(parse({ background: true }).background).toBe(true);
    expect(parse({ background: false }).background).toBe(false);
    // 字符串 "true" 不算 —— YAML 已解析布尔，字符串说明写法有误
    expect(parse({ background: "true" }).background).toBeUndefined();
  });
  it("isolation 仅接受 worktree", () => {
    expect(parse({ isolation: "worktree" }).isolation).toBe("worktree");
    expect(parse({ isolation: "remote" }).isolation).toBeUndefined();
    expect(parse({ isolation: "container" }).isolation).toBeUndefined();
  });
});

describe("hooks（P2-1）字段消费与隔离", () => {
  const hooksFm = {
    PostToolUse: [{ matcher: "write", hooks: [{ command: "echo hi" }] }],
  };

  it("对象结构透传", () => {
    expect(parse({ hooks: hooksFm }).hooks).toEqual(hooksFm);
  });
  it("非对象忽略", () => {
    expect(parse({ hooks: "PostToolUse" }).hooks).toBeUndefined();
  });

  it("buildAgentHookSystem 为声明 hooks 的 agent 建独立实例", () => {
    const a = buildAgentHookSystem("agent-a", hooksFm);
    const b = buildAgentHookSystem("agent-b", hooksFm);
    expect(a).toBeInstanceOf(HookSystem);
    expect(b).toBeInstanceOf(HookSystem);
    // 关键：两个 agent 各自独立实例，A 的 hook 不会对 B 的工具调用误触发
    expect(a).not.toBe(b);
  });

  it("未声明/空 hooks → undefined（调用方回退共享 hookSystem）", () => {
    expect(buildAgentHookSystem("x", undefined)).toBeUndefined();
    expect(buildAgentHookSystem("x", {})).toBeUndefined();
    expect(buildAgentHookSystem("x", "not-an-object")).toBeUndefined();
  });

  it("未知事件名 / 缺 command 的项被跳过，不抛错", () => {
    const n = registerAgentHooks(new HookSystem(), "x", {
      NotAnEvent: [{ hooks: [{ command: "echo a" }] }],
      PostToolUse: [{ matcher: "write", hooks: [{ timeout: 5 }] }], // 缺 command
    });
    expect(n).toBe(0);
  });

  it("合法项统计注册数", () => {
    const n = registerAgentHooks(new HookSystem(), "x", {
      PostToolUse: [{ matcher: "write", hooks: [{ command: "echo a" }, { command: "echo b" }] }],
    });
    expect(n).toBe(2);
  });
});

describe("多字段组合", () => {
  it("一次性解析全部七字段", () => {
    const out = parse({
      model: "m1",
      skills: ["s1"],
      color: "teal",
      permissionMode: "acceptEdits",
      hooks: { PostToolUse: [] },
      background: true,
      isolation: "worktree",
    });
    expect(out).toEqual({
      model: "m1",
      skills: ["s1"],
      color: "teal",
      permissionMode: "acceptEdits",
      hooks: { PostToolUse: [] },
      background: true,
      isolation: "worktree",
    });
  });

  it("全非法值 → 空对象（不抛，spawn 不失败）", () => {
    const out = parse({
      model: 1,
      skills: 2,
      color: 3,
      permissionMode: "bogus",
      hooks: 5,
      background: "yes",
      isolation: "bogus",
    });
    expect(out).toEqual({});
  });
});
