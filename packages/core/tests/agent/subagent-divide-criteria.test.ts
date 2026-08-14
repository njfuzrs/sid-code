/**
 * P1-5 —— 分治反面判据 + 长任务观测规范的引导层门禁
 *
 * 对应 `docs/bugfixes/todo/20260811-长任务子代理全超时与主agent绕圈-修复方案.md` §5 / §12.2。
 *
 * 事故形态：139 个类型错误跨 34 文件，模型派了 3 个并行 task 子代理各改一份**互相影响**的
 * 类型定义。对照 CC 同任务轨迹：0 个子代理，改 `color-utils.ts` 一处让十几个文件的报错集体
 * 消失（`string → Color` 一处收紧引发的连锁）。
 *
 * 关键结论是**这不是模型判断力缺陷，是引导层缺陷**：修复前 `usageGuide()` 与系统提示词里
 * 全是"何时该分治"（甚至把并行写成"保成功"手段），没有任何一条讲"何时不该"。模型看到
 * "139 个错误 / 34 个文件"这种规模，按当时的引导选分治是**合理的**。
 *
 * 所以本文件断言的是"判据供给存在"，而不是模型行为——文案是唯一能立门禁的落点。
 * §5.6 把"人工评审：新引导文案里必须能找到'同源错误不要分治'"列为验收项，这里把它
 * 机械化：文案被后续改写抹掉反面判据时必须红，而不是靠下一个人恰好记得评审过这件事。
 *
 * fix_type: regression_guard
 */

import { describe, test, expect } from "bun:test";
import { SubAgentTool } from "@sid-code/core/agent/tool.ts";
import { buildSystemPrompt, clearPromptCache } from "@sid-code/core/config/system-prompt.ts";
import type { ProviderRegistry } from "@sid-code/core/llm/registry.ts";
import { Registry as ToolRegistry } from "@sid-code/core/tool/registry.ts";

// usageGuide() 不触碰 providerRegistry，用最小 stub 即可（与 subagent-capability-visibility 同法）
const tool = new SubAgentTool({} as unknown as ProviderRegistry, new ToolRegistry());

/** 造一个最小工具，只为让 buildSystemPrompt 输出 <tool-guide> 段（无工具时该段不注入）。 */
function makeTool(name: string) {
  return {
    name: () => name,
    description: () => `${name} 工具`,
    inputSchema: () => ({ type: "object", properties: {} }),
    execute: async () => ({ output: "" }),
    readOnly: () => true,
  };
}

describe("P1-5 · sub_agent usageGuide 含分治反面判据", () => {
  test("含「同源错误不要分治」这一条（§5.6 的人工评审项，机械化）", () => {
    const guide = tool.usageGuide();
    expect(guide).toContain("同源错误不要分治");
  });

  test("含一句话判据：分治的前提是子任务可切开", () => {
    const guide = tool.usageGuide();
    expect(guide).toContain("分治的前提是子任务可切开");
  });

  test("覆盖 §12.2 判据表的其余维度（文件重叠 / 上下文可切分 / 验证成本）", () => {
    const guide = tool.usageGuide();
    // 文件重叠：多个子任务写同一模块或相邻文件
    expect(guide).toContain("相邻文件");
    // 上下文可切分：派 task 前先确认子任务上下文能在预算内读完
    expect(guide).toMatch(/上下文.*读完|读完.*上下文/);
    // 验证成本：只有全量跑 tsc 才知道对不对的活不分治
    expect(guide).toMatch(/tsc|全量验证/);
  });

  test("反面判据与「何时该派」并存，不是把鼓励分治整段删掉", () => {
    // 修复方向是补反面判据、不是反转立场。两边都在才叫"判据供给完整"。
    const guide = tool.usageGuide();
    expect(guide).toContain("何时该派");
    expect(guide).toContain("何时不该派");
  });
});

describe("P1-5 · 系统提示词含分治反面判据与长任务观测规范", () => {
  test("中文版任务编排段含反面判据（不只 usageGuide 一处）", () => {
    clearPromptCache();
    const prompt = buildSystemPrompt({ tools: [makeTool("read")] });
    // system-prompt.ts 的「大任务先分治」条目原本也是纯鼓励，与 usageGuide 同病。
    // 两处都是模型实际读到的引导，只修一处等于留一半缺口。
    expect(prompt).toContain("同源错误不要分治");
    expect(prompt).toContain("分治的前提是子任务可切开");
  });

  test("中文版含长任务观测规范：落盘再切片 + 禁止只取计数 + 批量改写报未匹配", () => {
    clearPromptCache();
    const prompt = buildSystemPrompt({ tools: [makeTool("bash")] });
    // ① 落盘完整输出再切片（一轮同时拿到进度与动作）
    expect(prompt).toContain("落盘完整输出再切片");
    expect(prompt).toContain("wc -l");
    // ② 禁止只取 grep -c 计数作为唯一观测（事故里 139×22 → 136×7 的空转形态）
    expect(prompt).toContain("grep -c");
    expect(prompt).toMatch(/禁止只取|唯一观测/);
    // ③ 批量同形改写自带未匹配报告（对标 CC 的 MISS: 输出）
    expect(prompt).toContain("MISS");
  });

  test("英文版同步（两个语言版本不得分叉）", () => {
    clearPromptCache();
    // 字段名是 preferredLanguage（不是 language）——buildSystemPrompt 把它透传给
    // buildToolGuideSection 的 language 选项，"en" 时切到 prompt-sections-en.ts。
    const prompt = buildSystemPrompt({ tools: [makeTool("bash")], preferredLanguage: "en" });
    // 反面判据
    expect(prompt).toContain("do not divide work whose edits affect each other");
    expect(prompt).toContain("same-root errors");
    // 观测规范
    expect(prompt).toContain("wc -l");
    expect(prompt).toContain("grep -c");
    expect(prompt).toContain("MISS");
  });
});
