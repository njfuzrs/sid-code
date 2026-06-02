/**
 * 上下文管理器 — Skill 压缩保留测试（Task 3：addInvokedSkill）
 */

import { describe, test, expect } from "bun:test";
import { Manager } from "../../src/context/manager.ts";
import type { Message } from "../../src/llm/types.ts";

function userMsg(text: string): Message {
  return { role: "user", content: [{ type: "text", text }] };
}
function asstMsg(text: string): Message {
  return { role: "assistant", content: [{ type: "text", text }] };
}

describe("Manager.addInvokedSkill / 压缩保留", () => {
  test("记录并读取已调用 Skill", () => {
    const mgr = new Manager({ maxTokens: 100_000 });
    mgr.addInvokedSkill("code-review", "审查工作流内容");
    const skills = mgr.getInvokedSkills();
    expect(skills.length).toBe(1);
    expect(skills[0].name).toBe("code-review");
    expect(skills[0].content).toBe("审查工作流内容");
  });

  test("同名 Skill 重复调用更新为最新内容", () => {
    const mgr = new Manager({ maxTokens: 100_000 });
    mgr.addInvokedSkill("s", "v1");
    mgr.addInvokedSkill("s", "v2");
    const skills = mgr.getInvokedSkills();
    expect(skills.length).toBe(1);
    expect(skills[0].content).toBe("v2");
  });

  test("压缩后保留在分割点之前调用的 Skill 内容", () => {
    const mgr = new Manager({ maxTokens: 100_000 });

    // 填充足够多的长消息，确保有安全分割点
    for (let i = 0; i < 20; i++) {
      mgr.addMessage(userMsg(`用户消息 ${i} `.repeat(200)));
      mgr.addMessage(asstMsg(`助手回复 ${i} `.repeat(200)));
    }

    // 在早期就调用了 Skill
    mgr.addInvokedSkill("workflow-skill", "必须遵循的关键工作流指令-SENTINEL");

    mgr.compactWithSummary("这是之前对话的摘要");

    const allText = mgr
      .getMessages()
      .flatMap((m) => m.content)
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("\n");

    // Skill 内容应在压缩后被重新注入
    expect(allText).toContain("SENTINEL");
    expect(allText).toContain("已调用 Skill: workflow-skill");
    // 摘要也应存在
    expect(allText).toContain("对话摘要");
  });

  test("无已调用 Skill 时压缩行为不变（不注入 Skill 消息）", () => {
    const mgr = new Manager({ maxTokens: 100_000 });
    for (let i = 0; i < 20; i++) {
      mgr.addMessage(userMsg(`U${i} `.repeat(200)));
      mgr.addMessage(asstMsg(`A${i} `.repeat(200)));
    }
    mgr.compactWithSummary("摘要");

    const allText = mgr
      .getMessages()
      .flatMap((m) => m.content)
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("\n");

    expect(allText).not.toContain("已调用 Skill");
    expect(allText).toContain("对话摘要");
  });
});
