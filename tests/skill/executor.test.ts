/**
 * Skill 执行共享内核测试（P0-2 hooks / P0-3 权限 / P1-1 effort+agent）
 */

import { describe, test, expect } from "bun:test";
import {
  authorizeSkill,
  registerSkillLifecycleHooks,
  normalizeSkillEffort,
  resolveSkillAgentType,
  resolveSkillAsk,
} from "../../src/skill/executor.ts";
import { HookSystem } from "../../src/hook/system.ts";
import type { SkillDefinition } from "../../src/skill/types.ts";

function makeSkill(overrides: Partial<SkillDefinition>): SkillDefinition {
  return {
    name: "demo",
    description: "演示",
    prompt: "内容",
    source: "project",
    filePath: "/test/demo.md",
    ...overrides,
  };
}

describe("normalizeSkillEffort (P1-1)", () => {
  test("识别 5 档", () => {
    for (const v of ["low", "medium", "high", "xhigh", "max"]) {
      expect(normalizeSkillEffort(v)).toBe(v as any);
    }
  });
  test("大小写不敏感 + 去空白", () => {
    expect(normalizeSkillEffort("  HIGH ")).toBe("high");
  });
  test("非法值返回 undefined", () => {
    expect(normalizeSkillEffort("turbo")).toBeUndefined();
    expect(normalizeSkillEffort(undefined)).toBeUndefined();
    expect(normalizeSkillEffort("")).toBeUndefined();
  });
});

describe("resolveSkillAgentType (P1-1)", () => {
  test("存在的 agent 类型透传", async () => {
    // explore 是内置 agent 类型
    expect(await resolveSkillAgentType("explore", "demo")).toBe("explore");
  });
  test("不存在的 agent 类型回退 undefined（fail-open）", async () => {
    expect(await resolveSkillAgentType("no-such-agent-xyz", "demo")).toBeUndefined();
  });
  test("空值返回 undefined", async () => {
    expect(await resolveSkillAgentType(undefined, "demo")).toBeUndefined();
    expect(await resolveSkillAgentType("  ", "demo")).toBeUndefined();
  });
});

describe("authorizeSkill (P0-3)", () => {
  test("仅安全属性 → allow", () => {
    const r = authorizeSkill(makeSkill({}), { permissionRules: { allow: [], deny: [], ask: [] } });
    expect(r.decision).toBe("allow");
  });
  test("含敏感属性(hooks) → ask", () => {
    const r = authorizeSkill(
      makeSkill({ hooks: { PostToolUse: [] } as any }),
      { permissionRules: { allow: [], deny: [], ask: [] } },
    );
    expect(r.decision).toBe("ask");
  });
  test("Skill(name) deny 命中 → deny", () => {
    const r = authorizeSkill(makeSkill({ name: "x" }), {
      permissionRules: { deny: ["Skill(x)"], allow: [], ask: [] },
    });
    expect(r.decision).toBe("deny");
  });
  test("Skill 通配 allow → 放行敏感 skill", () => {
    const r = authorizeSkill(makeSkill({ allowedTools: ["bash"] }), {
      permissionRules: { allow: ["Skill"], deny: [], ask: [] },
    });
    expect(r.decision).toBe("allow");
  });
  test("MCP 来源含敏感属性 → ask", () => {
    const r = authorizeSkill(
      makeSkill({ loadedFrom: "mcp", allowedTools: ["bash"] }),
      { permissionRules: { allow: [], deny: [], ask: [] } },
    );
    expect(r.decision).toBe("ask");
  });
});

describe("registerSkillLifecycleHooks (P0-2)", () => {
  test("MCP 来源 skill 拒绝注册 hooks（安全铁律）", () => {
    const sys = new HookSystem();
    const count = registerSkillLifecycleHooks(
      makeSkill({
        loadedFrom: "mcp",
        hooks: { PostToolUse: [{ matcher: "write", hooks: [{ command: "echo x" }] }] },
      }),
      sys,
    );
    expect(count).toBe(0);
    expect(sys.getAllHooks().length).toBe(0);
  });

  test("本地 skill 注册 hooks 成功", () => {
    const sys = new HookSystem();
    const count = registerSkillLifecycleHooks(
      makeSkill({
        name: "local",
        hooks: { PostToolUse: [{ matcher: "write", hooks: [{ command: "echo x" }] }] },
      }),
      sys,
    );
    expect(count).toBeGreaterThan(0);
    // 可按 skill 名卸载
    const removed = sys.removeSkillHooks("local");
    expect(removed).toBe(count);
  });

  test("无 hookSystem 返回 0", () => {
    const count = registerSkillLifecycleHooks(makeSkill({ hooks: {} as any }), undefined);
    expect(count).toBe(0);
  });
});

describe("resolveSkillAsk (P0-3)", () => {
  test("有 confirm 回调且批准 → true", async () => {
    const ok = await resolveSkillAsk(makeSkill({}), "reason", {
      confirm: async () => true,
    });
    expect(ok).toBe(true);
  });
  test("confirm 拒绝 → false", async () => {
    const ok = await resolveSkillAsk(makeSkill({}), "reason", {
      confirm: async () => false,
    });
    expect(ok).toBe(false);
  });
  test("无任何确认通道 → 保守拒绝", async () => {
    const ok = await resolveSkillAsk(makeSkill({}), "reason", {});
    expect(ok).toBe(false);
  });
  test("checker allowed=true → true", async () => {
    const ok = await resolveSkillAsk(makeSkill({}), "reason", {
      checker: { check: async () => ({ allowed: true }) } as any,
    });
    expect(ok).toBe(true);
  });
  test("checker allowed=false（子代理 ask→deny 语义）→ false", async () => {
    const ok = await resolveSkillAsk(makeSkill({}), "reason", {
      checker: { check: async () => ({ allowed: false, needsConfirmation: true }) } as any,
    });
    expect(ok).toBe(false);
  });
});
