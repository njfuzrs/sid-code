/**
 * Hook 对齐 CC · 批 2：匹配与名字（HC8 / HC9 / HC10 / H20）
 *
 * - 别名表与各工具 `name()` 的真实返回对账（防手抄表漂移）
 * - matcher 精确档认 CC 名、扩到 CC 字符集（`Edit, Write`）、正则档对两种名字各测一次
 * - 生命周期事件 matcher 走同一套三档
 * - 外部载荷 tool_name 发 CC 名 + sid_tool_name，HookInput 本身不改（Q1）
 */

import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { HookRegistry } from "@sid-code/core/hook/registry.ts";
import { HookPlanner, matchesPattern } from "@sid-code/core/hook/planner.ts";
import { HookEventName } from "@sid-code/core/hook/types.ts";
import { toExternalHookPayload, LazyJsonInput } from "@sid-code/core/hook/runner.ts";
import {
  CC_TO_INTERNAL_TOOL_NAME,
  toInternalToolName,
  toCcToolName,
} from "@sid-code/core/tool/tool-name-aliases.ts";
import { matchRule } from "@sid-code/core/permission/rules.ts";

const SRC = join(import.meta.dir, "../../src");

/** 从源码里扫出所有 `name() { return "xxx" }` 的工具名（与 registry 实际注册同源） */
function scanToolNames(): Set<string> {
  const names = new Set<string>();
  const files = [
    ...readdirSync(join(SRC, "tool"))
      .filter((f) => f.endsWith(".ts"))
      .map((f) => join(SRC, "tool", f)),
    join(SRC, "agent/tool.ts"),
  ];
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    for (const m of text.matchAll(/name\(\)[^{]*\{\s*return "([a-z_]+)"/g)) names.add(m[1]!);
  }
  return names;
}

function matches(matcher: string, toolName: string): boolean {
  const registry = new HookRegistry();
  registry.registerHook({ type: "command", command: "echo hit" }, HookEventName.PreToolUse, {
    matcher,
  });
  const plan = new HookPlanner(registry).createExecutionPlan(HookEventName.PreToolUse, {
    toolName,
  });
  return plan !== null && plan.hookConfigs.length > 0;
}

describe("别名表与真实工具名对账", () => {
  test("表里每个内部名都是某个工具 name() 的真实返回", () => {
    const real = scanToolNames();
    // 扫描本身要能扫到东西，否则下面的断言是空真
    expect(real.size).toBeGreaterThan(30);
    const missing = Object.values(CC_TO_INTERNAL_TOOL_NAME).filter((n) => !real.has(n));
    expect(missing).toEqual([]);
  });

  test("双向映射与大小写不敏感", () => {
    expect(toInternalToolName("Bash")).toBe("bash");
    expect(toInternalToolName("BASH")).toBe("bash");
    expect(toInternalToolName("Agent")).toBe("sub_agent");
    expect(toInternalToolName("Task")).toBe("sub_agent"); // CC 旧名
    expect(toInternalToolName("webfetch")).toBe("web_fetch"); // 旧权限规则写法
    expect(toCcToolName("sub_agent")).toBe("Agent");
    expect(toCcToolName("ls")).toBeUndefined(); // sid 独有
    expect(toInternalToolName("mcp__Srv__Tool")).toBe("mcp__Srv__Tool"); // 表外原样
  });

  test("权限规则沿用同一张表：if 与 matcher 口径一致", () => {
    expect(matchRule("Bash(echo *)", { toolName: "bash", input: { command: "echo 1" } })).toBe(
      true,
    );
    expect(matchRule("Agent", { toolName: "sub_agent", input: {} })).toBe(true);
    expect(matchRule("TodoWrite", { toolName: "todo_write", input: {} })).toBe(true);
  });
});

describe("matcher 三档（CC 口径）", () => {
  test("精确档：CC 名命中内部名，内部名照旧命中", () => {
    expect(matches("Bash", "bash")).toBe(true);
    expect(matches("bash", "bash")).toBe(true);
    expect(matches("Read", "read")).toBe(true);
    expect(matches("Agent", "sub_agent")).toBe(true);
    expect(matches("Bash", "read")).toBe(false);
  });

  test("精确档：Edit 不误命中 notebook_edit", () => {
    expect(matches("Edit", "edit")).toBe(true);
    expect(matches("Edit", "notebook_edit")).toBe(false);
  });

  test("精确档字符集扩到 CC：逗号 / 空格 / 连字符", () => {
    expect(matches("Edit, Write", "write")).toBe(true);
    expect(matches("Edit, Write", "edit")).toBe(true);
    expect(matches("Edit, Write", "read")).toBe(false);
    expect(matches("Edit|Write", "edit")).toBe(true);
    // 连字符走精确档：不会因为被当正则而误命中
    expect(matchesPattern("code-reviewer", ["code-reviewer"])).toBe(true);
    expect(matchesPattern("code-reviewer", ["code-reviewer-2"])).toBe(false);
  });

  test("正则档：对内部名与 CC 名各测一次", () => {
    expect(matches("Edit|Write.*", "write")).toBe(true); // 只有 CC 名 Write 能命中
    expect(matches("^bash$", "bash")).toBe(true); // 内部名照样能写
    expect(matches("Notebook.*", "notebook_edit")).toBe(true); // CC 名 NotebookEdit
    expect(matches("mcp__.*", "mcp__s__t")).toBe(true);
    expect(matches("mcp__.*", "bash")).toBe(false);
  });

  test("非法正则返回 false 不抛", () => {
    expect(matches("[", "bash")).toBe(false);
  });
});

describe("生命周期 matcher 同一套三档（HC10 / H20）", () => {
  function lifecycle(matcher: string, trigger: string): boolean {
    const registry = new HookRegistry();
    registry.registerHook({ type: "command", command: "echo" }, HookEventName.SessionStart, {
      matcher,
    });
    const plan = new HookPlanner(registry).createExecutionPlan(HookEventName.SessionStart, {
      trigger,
    });
    return plan !== null && plan.hookConfigs.length > 0;
  }

  test("管道 / 逗号列表与正则", () => {
    expect(lifecycle("startup|resume", "resume")).toBe(true);
    expect(lifecycle("startup, clear", "clear")).toBe(true);
    expect(lifecycle("startup|resume", "compact")).toBe(false);
    expect(lifecycle("^(clear|compact)$", "compact")).toBe(true);
  });
});

describe("外部载荷 tool_name（Q1）", () => {
  const base = {
    session_id: "s",
    cwd: "/tmp",
    hook_event_name: "PreToolUse",
    tool_name: "bash",
    tool_input: { command: "ls" },
  } as any;

  test("有 CC 名：发 CC 名并附 sid_tool_name", () => {
    const out = toExternalHookPayload(base) as any;
    expect(out.tool_name).toBe("Bash");
    expect(out.sid_tool_name).toBe("bash");
    expect(JSON.parse(new LazyJsonInput(base).json).tool_name).toBe("Bash");
  });

  test("HookInput 对象本身不被改（runtime 消费者口径不变）", () => {
    toExternalHookPayload(base);
    expect(base.tool_name).toBe("bash");
    expect("sid_tool_name" in base).toBe(false);
  });

  test("sid 独有 / MCP 工具原样发内部名", () => {
    expect((toExternalHookPayload({ ...base, tool_name: "ls" }) as any).tool_name).toBe("ls");
    const mcp = toExternalHookPayload({ ...base, tool_name: "mcp__a__b" }) as any;
    expect(mcp.tool_name).toBe("mcp__a__b");
    expect(mcp.sid_tool_name).toBeUndefined();
  });

  test("非工具事件不受影响", () => {
    const life = { session_id: "s", cwd: "/", hook_event_name: "Stop" } as any;
    expect(toExternalHookPayload(life)).toBe(life);
  });
});
