/**
 * Skill 调用上报测试（审计第 19 条）
 *
 * 原缺陷：ctxMgr 侧的「压缩时重注入 skill 工作流」机制（buildInvokedSkillMessages）
 * 早已接线，但喂数据的 addInvokedSkill 在生产中零调用 → invokedSkills 恒为空，
 * 压缩后模型直接遗忘 skill 工作流指令。
 *
 * 修复在**真正执行注入的三方**上报：
 *   ① SkillMetaTool.executeActivate（模型路径，经 setInvokedSkillSink）
 *   ② SkillCommand.execute 的 inline 分支（斜杠路径之一）
 *   ③ CommandExecutor.executePrompt 的 inline 分支（TUI 斜杠命令的真实路径）
 * delegate / fork 分支不上报——那份 prompt 活在子代理上下文里，主对话压缩与它无关。
 */

import { describe, test, expect } from "bun:test";
import { SkillMetaTool } from "../../src/skill/meta-tool.ts";
import { SkillManager } from "../../src/skill/manager.ts";
import { SkillCommand } from "../../src/command/skill-command.ts";
import { CommandExecutor } from "../../src/command/executor.ts";
import { skillToCommand } from "../../src/skill/command-adapter.ts";
import type { SkillDefinition } from "../../src/skill/types.ts";
import type { AppContext, CommandContext } from "../../src/command/types.ts";

function makeSkill(overrides: Partial<SkillDefinition> = {}): SkillDefinition {
  return {
    name: "demo",
    description: "演示 skill",
    prompt: "第一步做 A，第二步做 B",
    source: "project",
    filePath: "/test/demo.md",
    ...overrides,
  };
}

function managerWith(skills: SkillDefinition[]): SkillManager {
  const m = new SkillManager();
  // @ts-expect-error 测试直接注入内部 skills，绕过磁盘 discover
  m.skills = skills;
  return m;
}

/** 记录上报的假 ctxMgr（只实现 addInvokedSkill） */
function makeFakeCtxMgr() {
  const calls: { name: string; content: string }[] = [];
  return {
    calls,
    mgr: { addInvokedSkill: (name: string, content: string) => { calls.push({ name, content }); } },
  };
}

describe("模型路径：SkillMetaTool.executeActivate 上报（审计第 19 条）", () => {
  test("activate 后 sink 收到 skill 名与实际注入内容", async () => {
    const tool = new SkillMetaTool(
      managerWith([makeSkill({ name: "MyReview", mode: "activate", prompt: "审查步骤一二三" })]),
      {} as any,
      {} as any,
    );
    const { calls, mgr } = makeFakeCtxMgr();
    tool.setInvokedSkillSink((n, c) => mgr.addInvokedSkill(n, c));

    const res = await tool.execute({ skill: "myreview", args: "关注安全" });
    expect(res.isError).toBe(false);

    expect(calls.length).toBe(1);
    expect(calls[0].name).toBe("MyReview");
    // 上报的必须是实际进入上下文的完整内容（与模型看到的一致），不是裸 prompt
    expect(calls[0].content).toBe(res.output);
    expect(calls[0].content).toContain("审查步骤一二三");
    expect(calls[0].content).toContain("关注安全");
  });

  test("未注入 sink 时不报错（向后兼容，仅退化为不上报）", async () => {
    const tool = new SkillMetaTool(
      managerWith([makeSkill({ name: "nosink", mode: "activate" })]),
      {} as any,
      {} as any,
    );
    const res = await tool.execute({ skill: "nosink" });
    expect(res.isError).toBe(false);
  });

  test("sink 抛异常不影响 skill 调用本身（上报是尽力而为）", async () => {
    const tool = new SkillMetaTool(
      managerWith([makeSkill({ name: "boom", mode: "activate", prompt: "正常内容" })]),
      {} as any,
      {} as any,
    );
    tool.setInvokedSkillSink(() => { throw new Error("sink 挂了"); });
    const res = await tool.execute({ skill: "boom" });
    expect(res.isError).toBe(false);
    expect(res.output).toContain("正常内容");
  });

  test("权限被拒的 skill 不上报（没注入就不该记）", async () => {
    const tool = new SkillMetaTool(
      managerWith([makeSkill({ name: "danger", mode: "activate" })]),
      {} as any,
      {} as any,
    );
    const { calls, mgr } = makeFakeCtxMgr();
    tool.setInvokedSkillSink((n, c) => mgr.addInvokedSkill(n, c));
    tool.setPermissionRules({ deny: ["Skill(danger)"], allow: [], ask: [] });

    const res = await tool.execute({ skill: "danger" });
    expect(res.isError).toBe(true);
    expect(calls.length).toBe(0);
  });
});

describe("斜杠路径：SkillCommand inline 分支上报（审计第 19 条）", () => {
  test("inline 执行后 ctxMgr.addInvokedSkill 被调用", async () => {
    const cmd = new SkillCommand(makeSkill({
      name: "inline-skill",
      context: "inline",
      prompt: "工作流：先 A 后 B",
    }));
    const { calls, mgr } = makeFakeCtxMgr();

    const result = await cmd.execute("", { ctxMgr: mgr, sessionId: "s1" } as unknown as AppContext);
    expect(result.kind).toBe("submit_prompt");

    expect(calls.length).toBe(1);
    expect(calls[0].name).toBe("inline-skill");
    expect(calls[0].content).toContain("先 A 后 B");
    // 上报内容 == 实际提交的 prompt
    expect(calls[0].content).toBe((result as { kind: "submit_prompt"; prompt: string }).prompt);
  });

  test("缺少 ctxMgr 时不崩（可选依赖）", async () => {
    const cmd = new SkillCommand(makeSkill({ name: "no-ctx", context: "inline" }));
    const result = await cmd.execute("", { sessionId: "s1" } as unknown as AppContext);
    expect(result.kind).toBe("submit_prompt");
  });
});

describe("斜杠路径：CommandExecutor inline 分支上报（审计第 19 条）", () => {
  test("skill 来源的 inline 命令上报 addInvokedSkill", async () => {
    const cmd = skillToCommand(makeSkill({
      name: "exec-skill",
      context: "inline",
      prompt: "执行器路径工作流",
      source: "user",
      filePath: "/tmp/exec-skill/SKILL.md",
    }));
    const { calls, mgr } = makeFakeCtxMgr();
    const exec = new CommandExecutor({
      cwd: "/tmp",
      sessionId: "s1",
      ctxMgr: mgr,
    } as unknown as CommandContext);

    const result = await exec.executeSlashCommand("/exec-skill", [cmd]);
    expect(result.type).toBe("submit_prompt");

    expect(calls.length).toBe(1);
    expect(calls[0].name).toBe("exec-skill");
    expect(calls[0].content).toContain("执行器路径工作流");
  });

  test("权限被拒时不上报", async () => {
    const cmd = skillToCommand(makeSkill({
      name: "denied",
      context: "inline",
      source: "user",
      filePath: "/tmp/denied/SKILL.md",
    }));
    const { calls, mgr } = makeFakeCtxMgr();
    const exec = new CommandExecutor({
      cwd: "/tmp",
      sessionId: "s1",
      ctxMgr: mgr,
      permissionRules: { deny: ["Skill(denied)"], allow: [], ask: [] },
    } as unknown as CommandContext);

    const result = await exec.executeSlashCommand("/denied", [cmd]);
    expect(result.type).toBe("error");
    expect(calls.length).toBe(0);
  });
});

describe("端到端：上报后压缩能重注入 skill 工作流", () => {
  test("addInvokedSkill 记录的内容出现在压缩后的消息里", async () => {
    // 用真实 Manager 验证「喂数据 → 保留机制」这条链真的通了
    const { Manager } = await import("../../src/context/manager.ts");
    const ctxMgr = new Manager({ maxTokens: 200_000 });

    const tool = new SkillMetaTool(
      managerWith([makeSkill({ name: "wf", mode: "activate", prompt: "关键工作流指令 XYZ" })]),
      {} as any,
      {} as any,
    );
    tool.setInvokedSkillSink((n, c) => ctxMgr.addInvokedSkill(n, c));
    await tool.execute({ skill: "wf" });

    const invoked = ctxMgr.getInvokedSkills();
    expect(invoked.length).toBe(1);
    expect(invoked[0].name).toBe("wf");
    expect(invoked[0].content).toContain("关键工作流指令 XYZ");
  });

  test("同名 skill 重复调用只保留最新内容（不无限堆积）", async () => {
    const { Manager } = await import("../../src/context/manager.ts");
    const ctxMgr = new Manager({ maxTokens: 200_000 });

    const tool = new SkillMetaTool(
      managerWith([makeSkill({ name: "rep", mode: "activate", prompt: "版本内容" })]),
      {} as any,
      {} as any,
    );
    tool.setInvokedSkillSink((n, c) => ctxMgr.addInvokedSkill(n, c));

    await tool.execute({ skill: "rep", args: "第一次" });
    await tool.execute({ skill: "rep", args: "第二次" });

    const invoked = ctxMgr.getInvokedSkills();
    expect(invoked.length).toBe(1);
    expect(invoked[0].content).toContain("第二次");
    expect(invoked[0].content).not.toContain("第一次");
  });
});
