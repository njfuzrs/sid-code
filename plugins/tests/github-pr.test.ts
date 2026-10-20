/**
 * github-pr 插件（原 bundled /pr-comments）契约。
 *
 * 核心是「禁止模型调用」不能在迁成 markdown 时静默丢掉（方案 §3.4）：
 * 原内置版 bundled/pr-comments.ts 设了 disableModelInvocation: true，
 * 它会改代码、可能回复评论，带强副作用。这里断言对象是插件加载后的 SkillDefinition，
 * 并且真的经 Skill 元工具调一次，看到被拒 —— 只断言字段不够，字段名拼错时字段断言也会过。
 *
 * 变异自证：删掉 comments/SKILL.md 里的 `disable-model-invocation: true`，下面三条红。
 */
import { describe, expect, test } from "bun:test";
import { SkillManager } from "@sid-code/core/skill/manager.ts";
import { SkillMetaTool } from "@sid-code/core/skill/meta-tool.ts";
import { loadPluginSkillsFromRepo } from "./helpers.ts";

async function loadComments() {
  const skills = await loadPluginSkillsFromRepo("github-pr");
  const s = skills.find((x) => x.name === "github-pr:comments");
  if (!s) throw new Error(`没加载到 github-pr:comments，实际: ${skills.map((x) => x.name)}`);
  return s;
}

describe("github-pr:comments —— 保住「禁止模型调用」", () => {
  test("插件加载后 disableModelInvocation 为 true，且用户可调用", async () => {
    const s = await loadComments();
    expect(s.disableModelInvocation).toBe(true);
    expect(s.userInvocable).toBe(true);
    expect(s.loadedFrom).toBe("plugin");
  });

  test("经 Skill 元工具调用被拒", async () => {
    const manager = new SkillManager();
    manager.addPluginSkills([await loadComments()]);
    const tool = new SkillMetaTool(manager, {} as any, {} as any);
    const res = await tool.execute({ skill: "github-pr:comments" });
    expect(res.isError).toBe(true);
    expect(res.output).toContain("禁止模型自动调用");
  });

  test("不进模型可见的 skill listing", async () => {
    const manager = new SkillManager();
    manager.addPluginSkills([await loadComments()]);
    const tool = new SkillMetaTool(manager, {} as any, {} as any);
    expect(tool.getListingEntries().map((e) => e.name)).not.toContain("github-pr:comments");
  });
});

describe("github-pr:comments —— 与原内置版行为对齐", () => {
  test("fork 子会话 + 原白名单 + 原轮数；不声明已失效的 timeout-mins", async () => {
    const s = await loadComments();
    expect(s.context).toBe("fork");
    expect(s.allowedTools).toEqual(["bash", "read", "grep", "glob", "edit", "write"]);
    expect(s.maxTurns).toBe(30);
    expect(s.timeoutMins).toBeUndefined();
  });

  test("正文保留红线：不自动发布回复、改代码前先 read", async () => {
    const s = await loadComments();
    expect(s.prompt).toContain("不自动发布评论回复");
    expect(s.prompt).toContain("改代码必须先 read 到原文");
  });

  test("不再引导去用 /commit-push-pr（方案裁决该命令删除）", async () => {
    const s = await loadComments();
    expect(s.prompt).not.toContain("/commit-push-pr");
  });
});
