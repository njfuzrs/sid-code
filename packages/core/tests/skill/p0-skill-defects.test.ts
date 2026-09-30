/**
 * Skill 系统 P0 缺陷回归（20260927-Skill系统-顺着sc-10-skills核出的缺陷 P0-1…P0-6）
 *
 * 每条断言都是缺陷文档里那条最小复现的反面：旧实现下这些断言全红。
 * 刻意不用空数组构造规则 —— `ask: []` 永远测不出「这个字段没人读」（P0-1 漏网的原因）。
 */

import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SkillMetaTool } from "@sid-code/core/skill/meta-tool.ts";
import { SkillManager } from "@sid-code/core/skill/manager.ts";
import { SkillActivationCoordinator } from "@sid-code/core/skill/activation-coordinator.ts";
import { substituteArguments, processSkillPrompt } from "@sid-code/core/skill/prompt-processor.ts";
import { skillToCommand } from "@sid-code/core/skill/command-adapter.ts";
import {
  authorizeSkill,
  resolveSkillExecutionContext,
  resolveSkillAllowedTools,
  DEFAULT_SKILL_ALLOWED_TOOLS,
} from "@sid-code/core/skill/executor.ts";
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

/** 最小 manager 桩：只提供 SkillMetaTool.execute 用到的方法 */
function stubManager(skill: SkillDefinition) {
  return {
    getSkill: () => skill,
    getSkills: () => [skill],
    isGated: () => false,
    activateSkill: () => {},
    getListableSkills: () => [skill],
  } as unknown as SkillManager;
}

describe("P0-1 permissions.ask 的 Skill 规则生效", () => {
  const safe = makeSkill({ name: "deploy" });

  test("ask 命中 → ask（旧实现为 allow）", () => {
    const r = authorizeSkill(safe, { permissionRules: { ask: ["Skill(deploy)"] } });
    expect(r.decision).toBe("ask");
    expect(r.reason).toContain("permissions.ask");
  });

  test("ask 早于 allow：allow 通配盖不掉精确 ask", () => {
    const r = authorizeSkill(safe, {
      permissionRules: { ask: ["Skill(deploy)"], allow: ["Skill"] },
    });
    expect(r.decision).toBe("ask");
  });

  test("deny 仍最高优先级", () => {
    const r = authorizeSkill(safe, {
      permissionRules: { ask: ["Skill(deploy)"], deny: ["Skill(deploy)"] },
    });
    expect(r.decision).toBe("deny");
  });

  test("ask 规则不命中别的 skill", () => {
    const r = authorizeSkill(safe, { permissionRules: { ask: ["Skill(other)"] } });
    expect(r.decision).toBe("allow");
  });
});

describe("P0-2 参数替换不解释 $ 替换模式", () => {
  test("$& / $` / $' 原样保留", () => {
    expect(substituteArguments("run: $ARGUMENTS", "$& evil")).toBe("run: $& evil");
    expect(substituteArguments("run: $ARGUMENTS", "a$`b")).toBe("run: a$`b");
    expect(substituteArguments("run: $ARGUMENTS tail", "a$'b")).toBe("run: a$'b tail");
  });

  test("命名参数路径同样安全", () => {
    expect(substituteArguments("file=$f end", "x$`y", ["f"])).toBe("file=x$`y end");
  });

  test("注入的用户输入不被后续 $1 / $name 二次替换", () => {
    expect(substituteArguments("a=$ARGUMENTS one=$1", "$1 z")).toBe("a=$1 z one=$1");
    expect(substituteArguments("$ARGUMENTS|$f", "$f", ["f"])).toBe("$f|$f");
  });

  test("长名优先：$file 不误伤 $filename", () => {
    expect(substituteArguments("$filename $file $2", "A B", ["file", "filename"])).toBe("B A B");
  });

  test("${SKILL_DIR} / ${SESSION_ID} 值含 $ 时原样替换", async () => {
    const out = await processSkillPrompt(
      "${SKILL_DIR}|${SESSION_ID}",
      "",
      { cwd: process.cwd(), sessionId: "s$&1" },
      { skillRoot: "/tmp/a$`b", injectBaseDir: false },
    );
    expect(out).toBe("/tmp/a$`b|s$&1");
  });
});

describe("P0-3 模型路径跑 prompt 处理管道", () => {
  const skill = makeSkill({
    name: "demo",
    mode: "activate",
    prompt: "Target: $ARGUMENTS\nDir: ${SKILL_DIR}\nSession: ${SESSION_ID}\nShell: !`echo RAN`",
    skillRoot: "/tmp/x",
    loadedFrom: "skills",
  });

  test("占位符被替换，参数不再追加到末尾", async () => {
    const t = new SkillMetaTool(stubManager(skill), {} as any, {} as any);
    t.setSessionIdProvider(() => "sess-1");
    const r = await t.execute({ skill: "demo", args: "my-target" });
    expect(r.isError).toBe(false);
    expect(r.output).toContain("Target: my-target");
    expect(r.output).toContain("Dir: /tmp/x");
    expect(r.output).toContain("Session: sess-1");
    expect(r.output).not.toContain("$ARGUMENTS");
    expect(r.output).not.toContain("用户输入:");
    // Base directory 头部只出现一次（不再手工复刻一份）
    expect(r.output.split("Base directory for this skill").length - 1).toBe(1);
  });

  test("内联 shell 无 checker 时 fail-closed 不执行", async () => {
    const t = new SkillMetaTool(stubManager(skill), {} as any, {} as any);
    const r = await t.execute({ skill: "demo", args: "x" });
    expect(r.output).not.toContain("Shell: RAN");
    expect(r.output).toContain("未获授权");
  });

  test("内联 shell 按 bash 调用过 checker：deny/需确认 不执行，allow 执行", async () => {
    const seen: string[] = [];
    const t = new SkillMetaTool(stubManager(skill), {} as any, {} as any);
    t.setPermissionChecker({
      check: async (req: { toolName: string; input: unknown }) => {
        seen.push(`${req.toolName}:${(req.input as { command: string }).command}`);
        return { allowed: true, needsConfirmation: true };
      },
    } as any);
    expect((await t.execute({ skill: "demo" })).output).not.toContain("Shell: RAN");
    expect(seen).toEqual(["bash:echo RAN"]);

    t.setPermissionChecker({ check: async () => ({ allowed: true }) } as any);
    expect((await t.execute({ skill: "demo" })).output).toContain("Shell: RAN");
  });

  test("正文无参数占位符时，输入仍附在末尾（不静默丢参数）", async () => {
    const plain = makeSkill({ mode: "activate", prompt: "BODY" });
    const t = new SkillMetaTool(stubManager(plain), {} as any, {} as any);
    const r = await t.execute({ skill: "demo", args: "hello" });
    expect(r.output).toContain("用户输入:\nhello");
  });
});

describe("P0-4 context 字段在模型路径生效", () => {
  test("context:inline（未写 mode）走 inline 且 resultDisplayMode=summary", async () => {
    const skill = makeSkill({ name: "guard", context: "inline", prompt: "WORKFLOW BODY" });
    const t = new SkillMetaTool(stubManager(skill), {} as any, {} as any);
    expect(t.resultDisplayMode({ skill: "guard" })).toBe("summary");
    // 旧实现走 delegate，会在 SubAgent.fromRegistry 抛 TypeError
    const r = await t.execute({ skill: "guard" });
    expect(r).toEqual({ output: "WORKFLOW BODY", isError: false });
  });

  test("context 优先于 mode；三处调用方同源", () => {
    const cases: Array<[Partial<SkillDefinition>, "inline" | "fork"]> = [
      [{}, "fork"],
      [{ mode: "activate" }, "inline"],
      [{ mode: "delegate" }, "fork"],
      [{ context: "inline", mode: "delegate" }, "inline"],
      [{ context: "fork", mode: "activate" }, "fork"],
    ];
    for (const [o, want] of cases) {
      const s = makeSkill(o);
      expect(resolveSkillExecutionContext(s)).toBe(want);
      expect((skillToCommand(s) as { context?: string }).context).toBe(want);
      const t = new SkillMetaTool(stubManager(s), {} as any, {} as any);
      expect(t.resultDisplayMode({ skill: "demo" })).toBe(
        want === "inline" ? "summary" : undefined,
      );
    }
  });
});

describe("P0-5 未声明 allowed-tools 的 fork skill 不再零工具", () => {
  test("未声明 → 只读默认集；显式声明（含空数组）原样尊重", () => {
    expect(resolveSkillAllowedTools({ name: "x" })).toEqual([...DEFAULT_SKILL_ALLOWED_TOOLS]);
    expect(resolveSkillAllowedTools({ name: "x", allowedTools: [] })).toEqual([]);
    expect(resolveSkillAllowedTools({ name: "x", allowedTools: ["bash"] })).toEqual(["bash"]);
  });

  test("默认集是只读的（不含写/执行工具）", () => {
    for (const t of ["write", "edit", "bash"]) {
      expect(DEFAULT_SKILL_ALLOWED_TOOLS).not.toContain(t);
    }
  });

  test("模型路径 delegate 实际传给子代理的 allowedTools 非空", async () => {
    let captured: string[] | undefined;
    const { SubAgent } = await import("@sid-code/core/agent/sub-agent.ts");
    const orig = SubAgent.fromRegistry;
    (SubAgent as any).fromRegistry = () => ({
      setPermissionChecker() {},
      executeCustom: async (task: { allowedTools: string[] }) => {
        captured = task.allowedTools;
        return { success: true, output: "ok", turns: 1 };
      },
    });
    try {
      const skill = makeSkill({ name: "release-version" }); // 无 mode、无 allowed-tools
      const t = new SkillMetaTool(stubManager(skill), {} as any, {} as any);
      const r = await t.execute({ skill: "release-version" });
      expect(r.isError).toBe(false);
      expect(captured).toEqual([...DEFAULT_SKILL_ALLOWED_TOOLS]);
    } finally {
      (SubAgent as any).fromRegistry = orig;
    }
  });
});

describe("P0-6 动态发现的条件 skill 过 paths 门", () => {
  let cwd = "";
  afterEach(() => {
    if (cwd) rmSync(cwd, { recursive: true, force: true });
  });

  function setup() {
    cwd = mkdtempSync(join(tmpdir(), "p06-"));
    const a = join(cwd, "pkg", "a");
    const z = join(cwd, "pkg", "zzz");
    mkdirSync(a, { recursive: true });
    mkdirSync(z, { recursive: true });
    writeFileSync(join(a, "x.ts"), "//x");
    writeFileSync(join(z, "y.ts"), "//y");
    const mk = (name: string, extra: string) => {
      const d = join(cwd, "pkg", ".sid-code", "skills", name);
      mkdirSync(d, { recursive: true });
      writeFileSync(
        join(d, "SKILL.md"),
        `---\nname: ${name}\ndescription: d\n${extra}---\n# body\n`,
      );
    };
    mk("deep-guard", 'paths:\n  - "pkg/zzz/**"\n');
    mk("plain", "");
    const mgr = new SkillManager();
    const c = new SkillActivationCoordinator({ manager: mgr, cwd });
    c.init(mgr.getAllSkills());
    return { mgr, c, a, z };
  }

  test("触发路径不匹配 paths：加载但 gate，不进 listing；无条件 skill 照常进", async () => {
    const { mgr, c, a } = setup();
    await c.onToolResults([{ file_path: join(a, "x.ts") }]);
    expect(mgr.getSkill("deep-guard")).toBeDefined();
    expect(mgr.isGated("deep-guard")).toBe(true);
    const delta = c.drainListingDelta() ?? "";
    expect(delta).not.toContain("deep-guard");
    expect(delta).toContain("plain");
  });

  test("之后碰到匹配文件才激活", async () => {
    const { mgr, c, a, z } = setup();
    await c.onToolResults([{ file_path: join(a, "x.ts") }]);
    c.drainListingDelta();
    await c.onToolResults([{ file_path: join(z, "y.ts") }]);
    expect(mgr.isGated("deep-guard")).toBe(false);
    expect(c.drainListingDelta() ?? "").toContain("deep-guard");
  });

  test("触发发现的那次路径本身就匹配 → 同一轮激活", async () => {
    const { mgr, c, z } = setup();
    await c.onToolResults([{ file_path: join(z, "y.ts") }]);
    expect(mgr.isGated("deep-guard")).toBe(false);
    expect(c.drainListingDelta() ?? "").toContain("deep-guard");
  });

  test("gateSkills 是追加语义，不放出 init 时已 gate 的 skill", () => {
    const mgr = new SkillManager();
    mgr.setGatedSkills(["old"]);
    mgr.gateSkills(["new"]);
    expect(mgr.isGated("old")).toBe(true);
    expect(mgr.isGated("new")).toBe(true);
  });
});
