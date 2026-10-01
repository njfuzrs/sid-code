/**
 * Skill 系统 P1 缺陷回归（20260927-Skill系统-顺着sc-10-skills核出的缺陷 P1-1…P1-7）
 *
 * 每条断言都是缺陷文档里那条最小复现的反面：旧实现下这些断言全红。
 */

import { describe, test, expect, afterEach } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  formatCommandsWithinBudget,
  computeCharBudget,
  type SkillListingEntry,
} from "@sid-code/core/skill/budget.ts";
import { SkillManager } from "@sid-code/core/skill/manager.ts";
import { MAX_SKILLS } from "@sid-code/core/skill/loader.ts";
import { SkillMetaTool } from "@sid-code/core/skill/meta-tool.ts";
import { SkillActivationCoordinator } from "@sid-code/core/skill/activation-coordinator.ts";
import {
  extractAffectedPaths,
  AFFECTED_PATH_FIELDS,
} from "@sid-code/core/skill/dynamic-discovery.ts";
import { authorizeSkill, resolveSkillAsk } from "@sid-code/core/skill/executor.ts";
import { setSkillTraceSink } from "@sid-code/core/skill/telemetry.ts";
import { HookSystem } from "@sid-code/core/hook/system.ts";
import { registerSkillHooks } from "@sid-code/core/skill/hooks.ts";
import type { SkillDefinition } from "@sid-code/core/skill/types.ts";

function makeSkill(overrides: Partial<SkillDefinition>): SkillDefinition {
  return {
    name: "demo",
    description: "d",
    prompt: "p",
    source: "user",
    filePath: "/tmp/x/SKILL.md",
    ...overrides,
  };
}

const entry = (name: string, desc: string, isBundled = false): SkillListingEntry => ({
  name,
  description: desc,
  isBundled,
});

describe("P1-1 摘要预算：特权封顶 + 按整行核算", () => {
  test("全是 bundled 时不再无上限输出（文档复现 A 的反面）", () => {
    const cmds = Array.from({ length: 10 }, (_, i) => entry(`bundled-${i}`, "D".repeat(240), true));
    const window = 20_000;
    const out = formatCommandsWithinBudget(cmds, window);
    expect(out.length).toBeLessThanOrEqual(computeCharBudget(window));
    // 仍然每条都在（名字是可调用的最低信息量）
    for (let i = 0; i < 10; i++) expect(out).toContain(`- bundled-${i}`);
  });

  test("混合时前缀计入预算（文档复现 B：旧实现正好超出 6 行前缀）", () => {
    const cmds = [
      entry("b1", "B".repeat(240), true),
      ...Array.from({ length: 5 }, (_, i) => entry(`user-skill-${i}`, "U".repeat(240))),
    ];
    const window = 20_000;
    expect(formatCommandsWithinBudget(cmds, window).length).toBeLessThanOrEqual(
      computeCharBudget(window),
    );
  });

  test("builtin（磁盘上有 SKILL.md）不再享有 bundled 特权，编译内联的仍享有", () => {
    const skills = [
      makeSkill({ name: "builtin-one", isBuiltin: true, loadedFrom: "builtin" }),
      makeSkill({ name: "inlined", loadedFrom: "bundled" }),
    ];
    const mgr = { getListableSkills: () => skills } as unknown as SkillManager;
    const entries = new SkillMetaTool(mgr, {} as never, {} as never).getListingEntries();
    expect(entries.find((e) => e.name === "builtin-one")?.isBundled).toBe(false);
    expect(entries.find((e) => e.name === "inlined")?.isBundled).toBe(true);
  });
});

describe("P1-2 MAX_SKILLS 按会话全量执行", () => {
  test("追加路径（插件/MCP/动态发现共用 addPluginSkills）也受上限约束", () => {
    const mgr = new SkillManager();
    const many = Array.from({ length: MAX_SKILLS + 50 }, (_, i) =>
      makeSkill({ name: `p${i}`, filePath: `/p/${i}/SKILL.md`, loadedFrom: "plugin" }),
    );
    const accepted = mgr.addPluginSkills(many);
    expect(accepted.length).toBe(MAX_SKILLS);
    expect(mgr.getAllSkills().length).toBe(MAX_SKILLS);
    // 第二批再追加也进不来（旧实现按单次调用计数，这里会翻倍）
    mgr.addPluginSkills([makeSkill({ name: "late", filePath: "/late/SKILL.md" })]);
    expect(mgr.getSkill("late")).toBeNull();
  });

  test("同名覆盖不占新名额，上限满时仍可覆盖", () => {
    const mgr = new SkillManager();
    mgr.addPluginSkills(
      Array.from({ length: MAX_SKILLS }, (_, i) =>
        makeSkill({ name: `p${i}`, filePath: `/p/${i}/SKILL.md` }),
      ),
    );
    mgr.addPluginSkills([makeSkill({ name: "p0", description: "new", filePath: "/new/SKILL.md" })]);
    expect(mgr.getSkill("p0")?.description).toBe("new");
  });
});

describe("P1-3 降级与 fail-open 有埋点", () => {
  const events: Array<Record<string, unknown>> = [];
  afterEach(() => {
    setSkillTraceSink(null);
    events.length = 0;
  });
  const capture = () => setSkillTraceSink((d) => events.push(d));

  test("摘要只剩名字 / 被截断都打点", () => {
    capture();
    const many = Array.from({ length: 50 }, (_, i) => entry(`user-${i}`, "U".repeat(240)));
    formatCommandsWithinBudget(many, 20_000);
    formatCommandsWithinBudget(many.slice(0, 5), 20_000);
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("listing_names_only");
    expect(kinds).toContain("listing_truncated");
  });

  test("权限判定异常 fail-open 放行时打点", () => {
    capture();
    // deny 不是数组 → 判定内部抛错 → fail-open
    const res = authorizeSkill(makeSkill({ name: "x" }), {
      permissionRules: { deny: 5 } as never,
    });
    expect(res.decision).toBe("allow");
    expect(events.find((e) => e.kind === "auth_fail_open")?.skill).toBe("x");
  });

  test("ask 无确认通道拒绝时打点", async () => {
    capture();
    expect(await resolveSkillAsk(makeSkill({ name: "y" }), "r", {})).toBe(false);
    expect(events.find((e) => e.kind === "ask_no_channel")?.skill).toBe("y");
  });

  test("app 层把 sink 接到了 trace collector（否则埋点在生产里恒 0）", () => {
    const app = readFileSync(join(import.meta.dir, "../../../cli/src/app.ts"), "utf8");
    expect(app).toMatch(/setSkillTraceSink\(\s*traceCollectorInstance/);
  });
});

describe("P1-4 增量 listing 首轮判据", () => {
  function allConditionalManager() {
    const mgr = new SkillManager();
    mgr.addPluginSkills([
      makeSkill({ name: "c1", paths: ["a/**"], filePath: "/c1" }),
      makeSkill({ name: "c2", paths: ["b/**"], filePath: "/c2" }),
    ]);
    return mgr;
  }

  test("全条件激活项目：首次激活贴的是「因文件操作激活」文案", async () => {
    const mgr = allConditionalManager();
    const c = new SkillActivationCoordinator({
      manager: mgr,
      cwd: "/tmp/p",
      enableDynamicDiscovery: false,
    });
    c.init(mgr.getAllSkills());
    expect(c.drainListingDelta()).toBeNull();
    await c.onToolResults([{ file_path: "/tmp/p/a/x.ts" }]);
    const delta = c.drainListingDelta() ?? "";
    expect(delta).toContain("因你的文件操作已被激活");
    expect(delta).toContain("c1");
    expect(delta).not.toContain("c2");
  });
});

describe("P1-5 条件激活路径字段", () => {
  test("ls 的 dir_path 被收进受影响路径", () => {
    expect(extractAffectedPaths({ dir_path: "/a" })).toEqual(["/a"]);
  });

  test("bash 的 command 刻意不收", () => {
    expect(extractAffectedPaths({ command: "cat /a/b.ts" })).toEqual([]);
  });

  test("候选字段集合 ⊇ 全部工具 zod schema 的路径类字段名（反漂移）", () => {
    const toolDir = join(import.meta.dir, "../../src/tool");
    const found = new Set<string>();
    for (const f of readdirSync(toolDir)) {
      if (!f.endsWith(".ts")) continue;
      const src = readFileSync(join(toolDir, f), "utf8");
      for (const m of src.matchAll(/\b([A-Za-z_]*(?:_path|Path)|path)\s*:\s*z\s*\./g)) {
        found.add(m[1]);
      }
    }
    // 反向自证：扫描确实抓到了真东西
    expect(found.has("file_path")).toBe(true);
    expect(found.has("dir_path")).toBe(true);
    const missing = [...found].filter(
      (n) => !(AFFECTED_PATH_FIELDS as readonly string[]).includes(n),
    );
    expect(missing).toEqual([]);
  });
});

describe("P1-6 模型路径卸 hooks 不波及 inline 注册的同名 hooks", () => {
  test("用户 inline 注册的 hooks 在模型再调同名 activate skill 后仍存活", async () => {
    const hs = new HookSystem();
    const skill = makeSkill({
      name: "guard",
      mode: "activate",
      prompt: "WORKFLOW",
      loadedFrom: "skills",
      hooks: { PostToolUse: [{ matcher: "write", hooks: [{ command: "echo lint" }] }] },
    });
    const cnt = () => hs.getAllHooks().filter((h) => h.skillName === "guard").length;
    registerSkillHooks(hs, skill.name, skill.hooks, "/tmp/x");
    expect(cnt()).toBe(1);

    const mgr = {
      getSkill: () => skill,
      getSkills: () => [skill],
      isGated: () => false,
      activateSkill: () => {},
      getListableSkills: () => [skill],
    } as unknown as SkillManager;
    const t = new SkillMetaTool(mgr, {} as never, {} as never);
    t.setHookSystem(hs);
    t.setPermissionChecker({ check: async () => ({ allowed: true }) } as never);
    await t.execute({ skill: "guard" });
    // 模型路径自己注册的那一批已卸掉，用户那一份还在
    expect(cnt()).toBe(1);
  });

  test("不传 scope 的 removeSkillHooks 仍删全部（skill 卸载语义不变）", () => {
    const hs = new HookSystem();
    const hooks = { PostToolUse: [{ matcher: "write", hooks: [{ command: "echo a" }] }] };
    registerSkillHooks(hs, "g", hooks, undefined);
    registerSkillHooks(hs, "g", hooks, undefined, "call-1");
    expect(hs.removeSkillHooks("g", "call-1")).toBe(1);
    expect(hs.removeSkillHooks("g")).toBe(1);
  });
});

describe("P1-7 激活协调器 fire-and-forget", () => {
  test("晚到的激活（未进 pending）在下一次 drain 仍被发现，不会永久丢失", () => {
    const mgr = new SkillManager();
    mgr.addPluginSkills([makeSkill({ name: "late", paths: ["z/**"], filePath: "/late" })]);
    const c = new SkillActivationCoordinator({
      manager: mgr,
      cwd: "/tmp/p",
      enableDynamicDiscovery: false,
    });
    c.init(mgr.getAllSkills());
    expect(c.drainListingDelta()).toBeNull();
    // 模拟异步路径在 drain 之后才把 skill 放出来（没经过 pendingActivated）
    mgr.ungateSkill("late");
    expect(c.drainListingDelta() ?? "").toContain("late");
    expect(c.drainListingDelta()).toBeNull();
  });

  test("loop.ts 不再用空 catch 吞掉协调器异常", () => {
    const loop = readFileSync(join(import.meta.dir, "../../src/query/loop.ts"), "utf8");
    const idx = loop.indexOf("deps.onSkillToolResults(toolInputs).catch(");
    expect(idx).toBeGreaterThan(-1);
    const snippet = loop.slice(idx, idx + 300);
    expect(snippet).not.toMatch(/\.catch\(\(\)\s*=>/);
    expect(snippet).toContain("getLogger().warn(");
  });
});
