/**
 * F5-Q5d：bundled skill 并入 `Skill` 元工具（bench_fix 06b §3）。
 *
 * 锁 §3.3 的行为变化，每条一组断言：
 *  1. 兼容别名：旧写法 `deny: ["skill__review"]` 仍拦得住 `Skill{skill:"review"}`
 *     （官网 extend/skills.md 教过用户这么写，不认就是 deny 规则静默失效）
 *  2. 权限路径：无规则时放行（不走敏感属性模型，否则 -p 下被拒）；ask 规则在 dontAsk 下拒
 *  3. 禁用名单：分发与 listing 都过 skillManager.isNameDisabled
 *  4. listing：bundled 第一次进摘要，带 isBundled；manager 同名优先
 *  5. 分发：入参 args 映射成 BundledSkillTool 的 input
 */

import { describe, test, expect } from "bun:test";
import { SkillMetaTool } from "@sid-code/core/skill/meta-tool.ts";
import { SkillManager } from "@sid-code/core/skill/manager.ts";
import { BundledSkillTool } from "@sid-code/core/skill/bundled/tool.ts";
import type { SkillDefinition } from "@sid-code/core/skill/types.ts";
import type { Checker } from "@sid-code/core/permission/types.ts";

/** 不真起子代理：记录收到的 input，返回固定结果 */
class FakeBundled extends BundledSkillTool {
  calls: unknown[] = [];
  override async execute(input: unknown) {
    if ((this as any).isDisabled?.(this.skillName())) {
      return { output: `错误：Skill "${this.skillName()}" 已被禁用。`, isError: true };
    }
    this.calls.push(input);
    return { output: `ran:${this.skillName()}`, isError: false };
  }
}

function makeBundled(name: string, mgr: SkillManager): FakeBundled {
  const cmd = {
    type: "prompt",
    name,
    description: `${name} 的说明`,
    whenToUse: `用户说 ${name} 时`,
    context: "fork",
    getPromptForCommand: async () => "prompt",
  } as unknown as ConstructorParameters<typeof BundledSkillTool>[0];
  const t = new FakeBundled(cmd, {} as never, {} as never);
  t.setDisabledQuery((n) => mgr.isNameDisabled(n));
  return t;
}

function managerWith(skills: SkillDefinition[]): SkillManager {
  const m = new SkillManager();
  // @ts-expect-error 测试直接注入内部 skills，避免磁盘 discover
  m.skills = skills;
  return m;
}

function setup(skills: SkillDefinition[] = []) {
  const mgr = managerWith(skills);
  const meta = new SkillMetaTool(mgr, {} as never, {} as never);
  const review = makeBundled("review", mgr);
  meta.registerBundled(review);
  return { mgr, meta, review };
}

/** dontAsk 语义的 checker：ask 一律拒 */
const denyAskChecker = {
  check: async () => ({ allowed: false, needsConfirmation: true }),
} as unknown as Checker;

describe("F5-Q5d 分发", () => {
  test("Skill{skill:'review'} 委托给 bundled，args 映射成 input", async () => {
    const { meta, review } = setup();
    const res = await meta.execute({ skill: "Review", args: "看 m.js" });
    expect(res.isError).toBe(false);
    expect(res.output).toBe("ran:review");
    expect(review.calls).toEqual([{ input: "看 m.js" }]);
  });

  test("manager 里有同名 skill 时 manager 优先，不走 bundled", async () => {
    const { meta, review } = setup([
      {
        name: "review",
        description: "d",
        prompt: "p",
        source: "project",
        filePath: "/t/review.md",
        disabled: true,
      },
    ]);
    const res = await meta.execute({ skill: "review" });
    expect(res.output).toContain("已被禁用"); // manager 那条的 disabled 分支
    expect(review.calls.length).toBe(0);
  });

  test("未知 skill 的报错里列出 bundled 名", async () => {
    const { meta } = setup();
    const res = await meta.execute({ skill: "nope" });
    expect(res.isError).toBe(true);
    expect(res.output).toContain("review");
  });
});

describe("F5-Q5d 权限（§3.3 第 1、2 条）", () => {
  test("无规则时放行——不套敏感属性模型（否则 -p 下 review 被拒）", async () => {
    const { meta, review } = setup();
    meta.setPermissionChecker(denyAskChecker);
    const res = await meta.execute({ skill: "review" });
    expect(res.isError).toBe(false);
    expect(review.calls.length).toBe(1);
  });

  for (const rule of ["skill__review", "SKILL__Review", "Skill(review)", "Skill", "skill:review"]) {
    test(`deny: ["${rule}"] 拦得住 Skill{skill:"review"}`, async () => {
      const { meta, review } = setup();
      meta.setPermissionRules({ deny: [rule] });
      const res = await meta.execute({ skill: "review" });
      expect(res.isError).toBe(true);
      expect(res.output).toContain("权限拒绝");
      expect(review.calls.length).toBe(0);
    });
  }

  test("别名只认本名：deny skill__simplify 不误伤 review", async () => {
    const { meta, review } = setup();
    meta.setPermissionRules({ deny: ["skill__simplify"] });
    expect((await meta.execute({ skill: "review" })).isError).toBe(false);
    expect(review.calls.length).toBe(1);
  });

  test("ask 规则在 dontAsk checker 下被拒", async () => {
    const { meta, review } = setup();
    meta.setPermissionChecker(denyAskChecker);
    meta.setPermissionRules({ ask: ["skill__review"] });
    const res = await meta.execute({ skill: "review" });
    expect(res.isError).toBe(true);
    expect(res.output).toContain("权限未授予");
    expect(review.calls.length).toBe(0);
  });

  test("checker 转发给 bundled（先登记后注入、先注入后登记两种顺序）", () => {
    const mgr = managerWith([]);
    const meta = new SkillMetaTool(mgr, {} as never, {} as never);
    const a = makeBundled("review", mgr);
    meta.registerBundled(a);
    meta.setPermissionChecker(denyAskChecker);
    const b = makeBundled("verify", mgr);
    meta.registerBundled(b);
    expect((a as any).permissionChecker).toBe(denyAskChecker);
    expect((b as any).permissionChecker).toBe(denyAskChecker);
  });
});

describe("F5-Q5d 禁用名单（§3.3 第 4 条）", () => {
  test("禁用后分发被拒、listing 不列；启用后恢复", async () => {
    const { mgr, meta, review } = setup();
    mgr.setDisabledSkills(["Review"]);
    const res = await meta.execute({ skill: "review" });
    expect(res.isError).toBe(true);
    expect(res.output).toContain("已被禁用");
    expect(review.calls.length).toBe(0);
    expect(meta.getListingEntries().map((e) => e.name)).not.toContain("review");

    mgr.setDisabledSkills([]);
    expect(meta.getListingEntries().map((e) => e.name)).toContain("review");
  });
});

describe("F5-Q5d listing（§3.1 第 3 条现状缺陷）", () => {
  test("bundled 进 listing，带 isBundled 与 whenToUse", () => {
    const { meta } = setup();
    const e = meta.getListingEntries().find((x) => x.name === "review");
    expect(e).toEqual({
      name: "review",
      description: "review 的说明",
      whenToUse: "用户说 review 时",
      isBundled: true,
    });
  });

  test("manager 同名时 bundled 条目让位，不重复", () => {
    const { meta } = setup([
      {
        name: "review",
        description: "磁盘版",
        prompt: "p",
        source: "project",
        filePath: "/t/review.md",
      },
    ]);
    const hits = meta.getListingEntries().filter((x) => x.name.toLowerCase() === "review");
    expect(hits.length).toBe(1);
    expect(hits[0].description).toBe("磁盘版");
  });
});
