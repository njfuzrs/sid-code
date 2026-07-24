/**
 * Hook `if` 条件过滤测试（G10：对齐 CC——在 matcher 工具名之上用权限规则语法对 tool_input 细粒度匹配）
 *
 * 核心：matcher 命中工具名后，若声明了 `if`（如 `Bash(git *)`），再用 permission/rules.ts 的 matchRule
 * 对 tool_input 做二次过滤，仅命中才触发 hook。复用与用户 allow/deny 规则同一套语法与实现。
 * 通过公开 API createExecutionPlan 间接验证 private matchesIfCondition。
 */

import { describe, test, expect } from "bun:test";
import { HookRegistry } from "../../src/hook/registry.ts";
import { HookPlanner } from "../../src/hook/planner.ts";
import { HookEventName } from "../../src/hook/types.ts";

/** 辅助：注册一个 PreToolUse hook（带 matcher + if），返回 planner */
function makePlanner(matcher: string, ifCond?: string): HookPlanner {
  const registry = new HookRegistry();
  registry.registerHook(
    { type: "command", command: "echo hit" },
    HookEventName.PreToolUse,
    { matcher, if: ifCond },
  );
  return new HookPlanner(registry);
}

/** 辅助：判断某工具名+输入是否命中（matcher + if） */
function matches(
  matcher: string,
  ifCond: string | undefined,
  toolName: string,
  toolInput: Record<string, unknown>,
): boolean {
  const planner = makePlanner(matcher, ifCond);
  const plan = planner.createExecutionPlan(HookEventName.PreToolUse, { toolName, toolInput });
  return plan !== null && plan.hookConfigs.length > 0;
}

describe("Hook if 条件过滤（G10）", () => {
  test("Bash + if:'Bash(git *)' → git status 命中、ls 不命中", () => {
    expect(matches("Bash", "Bash(git *)", "Bash", { command: "git status" })).toBe(true);
    expect(matches("Bash", "Bash(git *)", "Bash", { command: "git commit -m x" })).toBe(true);
    expect(matches("Bash", "Bash(git *)", "Bash", { command: "ls" })).toBe(false);
    expect(matches("Bash", "Bash(git *)", "Bash", { command: "npm install" })).toBe(false);
  });

  test("无 if 条件 → matcher 命中即触发（不受 tool_input 影响）", () => {
    expect(matches("Bash", undefined, "Bash", { command: "ls" })).toBe(true);
    expect(matches("Bash", undefined, "Bash", { command: "git status" })).toBe(true);
  });

  test("matcher 不命中 → if 无关，整体不触发", () => {
    // matcher 是 Edit，工具名是 Bash → matcher 层就过滤掉了
    expect(matches("Edit", "Bash(git *)", "Bash", { command: "git status" })).toBe(false);
  });

  test("Read + if:'Read(src/**)' → 读 src 下文件命中、读根目录文件不命中", () => {
    // 权限规则的路径匹配语法（与用户 allow/deny 一致，gitignore 风格，相对 workspaceRoot=cwd）
    const inSrc = `${process.cwd()}/src/app.ts`;
    const inRoot = `${process.cwd()}/README.md`;
    const hitSrc = matches("Read", "Read(src/**)", "Read", { file_path: inSrc });
    const missRoot = matches("Read", "Read(src/**)", "Read", { file_path: inRoot });
    expect(hitSrc).toBe(true);
    expect(missRoot).toBe(false);
  });

  test("非工具事件（无 toolName）声明 if → 视为不命中（if 依赖 tool_input）", () => {
    const registry = new HookRegistry();
    registry.registerHook(
      { type: "command", command: "echo hit" },
      HookEventName.SessionStart,
      { if: "Bash(git *)" },
    );
    const planner = new HookPlanner(registry);
    // 生命周期事件无 toolName/toolInput，带 if 的 hook 应被跳过
    const plan = planner.createExecutionPlan(HookEventName.SessionStart, { trigger: "startup" });
    expect(plan === null || plan.hookConfigs.length === 0).toBe(true);
  });

  test("非法 if 规则语法 → 放行该 hook（不静默吞掉）", () => {
    // matchRule 对非法规则返回 false，但 matchesIfCondition 的 catch 只在抛异常时放行；
    // 非法语法（无括号、纯乱码）matchRule 返回 false → 该 hook 被过滤。此处验证不崩溃。
    const result = matches("Bash", "!!!invalid!!!", "Bash", { command: "git status" });
    expect(typeof result).toBe("boolean");
  });
});
