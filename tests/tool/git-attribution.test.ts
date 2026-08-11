/**
 * P3-1：可配置 git 归因
 */

import { describe, test, expect } from "bun:test";
import {
  resolveCommitAttribution,
  resolvePrAttribution,
  commitAttributionInstruction,
  prAttributionInstruction,
  DEFAULT_COMMIT_ATTRIBUTION,
  DEFAULT_PR_ATTRIBUTION,
} from "@sid-code/core/tool/git-attribution.ts";

describe("P3-1 resolveCommitAttribution", () => {
  test("默认启用返回默认文本", () => {
    expect(resolveCommitAttribution(undefined)).toBe(DEFAULT_COMMIT_ATTRIBUTION);
    expect(resolveCommitAttribution({})).toBe(DEFAULT_COMMIT_ATTRIBUTION);
    expect(resolveCommitAttribution({ commitAttribution: {} })).toBe(DEFAULT_COMMIT_ATTRIBUTION);
  });

  test("enabled=false 返回空串", () => {
    expect(resolveCommitAttribution({ commitAttribution: { enabled: false } })).toBe("");
  });

  test("自定义 text 生效", () => {
    expect(
      resolveCommitAttribution({ commitAttribution: { enabled: true, text: "Co-Authored-By: bot <b@x.com>" } }),
    ).toBe("Co-Authored-By: bot <b@x.com>");
  });

  test("空 text 回退默认", () => {
    expect(resolveCommitAttribution({ commitAttribution: { text: "   " } })).toBe(DEFAULT_COMMIT_ATTRIBUTION);
  });
});

describe("P3-1 resolvePrAttribution", () => {
  test("默认启用返回默认文本", () => {
    expect(resolvePrAttribution(undefined)).toBe(DEFAULT_PR_ATTRIBUTION);
  });
  test("独立可关（关 PR 不影响 commit）", () => {
    const git = { prAttribution: { enabled: false } };
    expect(resolvePrAttribution(git)).toBe("");
    expect(resolveCommitAttribution(git)).toBe(DEFAULT_COMMIT_ATTRIBUTION);
  });
});

describe("P3-1 prompt 指令段", () => {
  test("启用时含归因文本", () => {
    const s = commitAttributionInstruction(undefined);
    expect(s).toContain(DEFAULT_COMMIT_ATTRIBUTION);
  });
  test("关闭时为空串（prompt 不出现归因）", () => {
    expect(commitAttributionInstruction({ commitAttribution: { enabled: false } })).toBe("");
    expect(prAttributionInstruction({ prAttribution: { enabled: false } })).toBe("");
  });
});

/**
 * settings.git 进 Schema（此前只靠顶层 .passthrough() 兜住 → 类型错写静默通过，
 * `enabled: "false"` 字符串会被当 truthy 继续加归因）。
 */
describe("P3-1 settings.git Schema 校验", () => {
  test("合法配置通过并保留字段", async () => {
    const { SettingsSchema } = await import("@sid-code/core/config/settings/types.ts");
    const r = SettingsSchema().safeParse({
      git: { commitAttribution: { enabled: false }, prAttribution: { text: "X" } },
    });
    expect(r.success).toBe(true);
    expect((r as any).data.git.commitAttribution.enabled).toBe(false);
    expect((r as any).data.git.prAttribution.text).toBe("X");
  });

  test("类型错写被拦下（而非静默当 truthy）", async () => {
    const { SettingsSchema } = await import("@sid-code/core/config/settings/types.ts");
    const r = SettingsSchema().safeParse({ git: { commitAttribution: { enabled: "false" } } });
    expect(r.success).toBe(false);
    expect((r as any).error.issues[0].path).toEqual(["git", "commitAttribution", "enabled"]);
  });

  test("git 段缺省不报错（可选）", async () => {
    const { SettingsSchema } = await import("@sid-code/core/config/settings/types.ts");
    expect(SettingsSchema().safeParse({}).success).toBe(true);
  });
});

/**
 * PR 归因必须覆盖**所有** PR 路径（/commit-push-pr、/pr-workflow、/pr）——
 * 只接一处会导致其余路径的 PR 描述缺归因（方案 P3-1 「统一注入路径」要求）。
 */
describe("P3-1 PR 归因覆盖所有 PR skill", () => {
  const PR_SKILLS = ["commit-push-pr", "pr-workflow", "pr"];

  /**
   * 按名取一个 bundled skill 的 prompt 构造器。
   *
   * ⚠️ 不能依赖全局注册表：`registerBundledSkills` 有 `registered` 幂等标志，而同批测试里
   * 其他文件会调用 `clearBundledSkills()` —— 清空后再调 registerBundledSkills 是空操作，
   * 单跑本文件能过、全量跑就取不到 skill。这里逐个 skill 直接调它自己的注册函数（不受
   * 幂等标志约束），每个 case 独立注册，不受运行顺序影响。
   */
  async function getSkill(name: string) {
    const { getBundledSkills } = await import("@sid-code/core/skill/bundled/registry.ts");
    const registrars: Record<string, () => Promise<() => void>> = {
      "commit-push-pr": async () =>
        (await import("@sid-code/core/skill/bundled/commit-push-pr.ts")).registerCommitPushPrSkill,
      "pr-workflow": async () =>
        (await import("@sid-code/core/skill/bundled/pr-workflow.ts")).registerPrWorkflowSkill,
      pr: async () => (await import("@sid-code/core/skill/bundled/pr.ts")).registerPrSkill,
    };
    const register = await registrars[name]!();
    register(); // registerBundledSkill 内部同名覆盖，重复调用安全
    const skill = getBundledSkills().find((s) => s.name === name);
    expect(skill).toBeDefined();
    return skill! as { getPromptForCommand?: (args: string, ctx: unknown) => Promise<string> };
  }

  for (const name of PR_SKILLS) {
    test(`/${name} 默认注入 PR 归因文本`, async () => {
      const skill = await getSkill(name);
      const prompt = await skill.getPromptForCommand!("", { config: {} } as any);
      expect(prompt).toContain(DEFAULT_PR_ATTRIBUTION);
    });

    test(`/${name} prAttribution.enabled=false 时 prompt 无归因`, async () => {
      const skill = await getSkill(name);
      const ctx = { config: { git: { prAttribution: { enabled: false } } } } as any;
      const prompt = await skill.getPromptForCommand!("", ctx);
      expect(prompt).not.toContain(DEFAULT_PR_ATTRIBUTION);
    });

    test(`/${name} 支持自定义 PR 归因文本`, async () => {
      const skill = await getSkill(name);
      const ctx = { config: { git: { prAttribution: { text: "🤖 by acme-bot" } } } } as any;
      const prompt = await skill.getPromptForCommand!("", ctx);
      expect(prompt).toContain("🤖 by acme-bot");
      expect(prompt).not.toContain(DEFAULT_PR_ATTRIBUTION);
    });
  }
});
