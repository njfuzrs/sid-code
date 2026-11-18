/**
 * PR3 取数层（context-report.ts）：`/context` 面板每个数字的来源与恒等式。
 *
 * ## 防什么
 *
 * - **面板与 footer 不同源**：`report.used` 必须逐字等于 `getContextUsageForDisplay().used`
 *   （PR1 的同源不变量在 report 层再锁一道——多一层搬运就多一次漂移机会）。
 * - **A4 固定开销加总对不上母项**：`Σ sources + residual === memoryFiles` 必须严格相等，
 *   否则用户把细目加总会小于面板上的「记忆/CLAUDE.md」，只能怀疑数字算错。
 * - **B5/B7 的「还剩」自己另算**：`toTrigger` 与各档 `remaining` 必须能由 `thresholds` 反推，
 *   不允许出现「面板显示的触发点 ≠ 真实触发点」（历史 bug：1M 窗口显示 70%、实际 82%）。
 * - **完成预留拆分对不上总量**：`outputReserve + summaryReserve === completionBuffer`。
 *
 * 全部严格相等、不设容差。容差会随着改动慢慢变大，最后变成一条永远为真的断言。
 */

import { describe, test, expect } from "bun:test";
import { Manager } from "@sid-code/core/context/manager.ts";
import { buildContextReport } from "@sid-code/core/context/context-report.ts";
import { estimateTextTokens } from "@sid-code/core/context/token.ts";
import type { Message } from "@sid-code/core/llm/types.ts";

/** 记忆索引段（fixed-overhead 只认我们自己生成的段标题）。 */
const MEMORY_SECTION = `#### 项目记忆（目录：/m/proj）\n\n- [a](a.md)：${"摘".repeat(200)}`;

/** 系统提示词：记忆段 + 一段普通正文（保证母项里有「规则正文与其它」的残差）。 */
const SYSTEM_PROMPT = [
  "# 身份",
  "你是一个用于测试的助手，这段正文不属于任何记忆索引段。",
  MEMORY_SECTION,
  `<system-reminder>\n# 项目规则\n${"规".repeat(300)}\n</system-reminder>`,
].join("\n\n");

function messages(): Message[] {
  return [
    { role: "user", content: [{ type: "text", text: "帮我看看这个文件。".repeat(20) }] },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "先定位文件，再读内容。".repeat(30), signature: "sig" },
        {
          type: "tool_use",
          id: "toolu_01",
          name: "read",
          input: { file_path: "/tmp/a.ts" },
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_01",
          content: "文件内容行\n".repeat(60),
        },
      ],
    },
    { role: "assistant", content: [{ type: "text", text: "看完了，结论如下。".repeat(20) }] },
  ];
}

/** 标准夹具：1M 窗口 + 记忆分量记账（母项 > 细目，残差明确为正）。 */
function freshManager(): Manager {
  const mgr = new Manager({ maxTokens: 1_000_000 });
  mgr.setSystemPrompt(SYSTEM_PROMPT);
  mgr.setMessages(messages());
  // 母项略大于「记忆段本身的估算」，模拟「还有 CLAUDE.md 正文/召回记忆」的真实形态。
  mgr.setMemoryTokens(Math.round(estimateTextTokens(MEMORY_SECTION) * 1.5));
  return mgr;
}

describe("PR3 取数层：面板与 footer 同源", () => {
  test("report.used 逐字等于 getContextUsageForDisplay().used", () => {
    const mgr = freshManager();
    const report = buildContextReport(mgr, { model: "test-model" });
    expect(report.used).toBe(mgr.getContextUsageForDisplay(0).used);
    expect(report.used).toBe(mgr.getTokenBreakdown(0).total);
  });

  test("百分比三口径与 footer 同源（占窗口 / 触发点占窗口 / 占触发点）", () => {
    const mgr = freshManager();
    const report = buildContextReport(mgr, { model: "test-model" });
    const usage = mgr.getContextUsageForDisplay(0);
    expect(report.percentOfWindow).toBe(usage.percentOfWindow);
    expect(report.triggerPercentOfWindow).toBe(usage.triggerPercentOfWindow);
    expect(report.percentOfTrigger).toBe(usage.percentOfTrigger);
    expect(report.level).toBe(usage.level);
  });

  test("分组小计之和 === 小计 === grossTokens（最大余数法保证逐字相等）", () => {
    const mgr = freshManager();
    const report = buildContextReport(mgr, { model: "test-model" });
    const bd = mgr.getTokenBreakdown(0);
    expect(report.residentSubtotal + report.conversationSubtotal).toBe(report.subtotal);
    expect(report.subtotal).toBe(bd.grossTokens);
    // 分类明细之和也必须是 grossTokens（report 层只搬运，不改分配）
    expect(report.categories.reduce((s, c) => s + c.tokens, 0)).toBe(report.subtotal);
  });

  test("总账恒等式：used = grossTokens + anchorLift − freed（钳零）", () => {
    const mgr = freshManager();
    const report = buildContextReport(mgr, { model: "test-model" });
    expect(report.used).toBe(
      Math.max(0, report.subtotal + report.anchorLiftTokens - report.freed.tokens),
    );
  });

  test("每个分类都有分组，且分组是闭集 resident / conversation", () => {
    const mgr = freshManager();
    const report = buildContextReport(mgr, { model: "test-model" });
    for (const c of report.categories) {
      expect(["resident", "conversation"]).toContain(c.group);
    }
    // thinking 属会话组（PR1 补上的分类，不能再被漏掉）
    const thinking = report.categories.find((c) => c.key === "thinking");
    expect(thinking?.group).toBe("conversation");
  });
});

describe("PR3 取数层：A4 固定开销残差", () => {
  test("Σ sources + residual 严格等于「记忆/CLAUDE.md」母项", () => {
    const mgr = freshManager();
    const report = buildContextReport(mgr, { model: "test-model" });
    const memory = report.categories.find((c) => c.key === "memoryFiles");
    // 前提：这条夹具真的产出了母项与细目（否则断言恒真，抓不到漏算）
    expect(memory).toBeDefined();
    expect(memory!.tokens).toBeGreaterThan(0);
    expect(report.fixedOverhead.sources.length).toBeGreaterThan(0);

    const listed = report.fixedOverhead.sources.reduce((s, x) => s + x.tokens, 0);
    expect(listed + report.fixedOverhead.residual).toBe(memory!.tokens);
  });

  test("残差为正且非零——母项里有细目覆盖不到的部分（CLAUDE.md 正文/召回/会话记忆）", () => {
    const mgr = freshManager();
    const report = buildContextReport(mgr, { model: "test-model" });
    expect(report.fixedOverhead.residual).toBeGreaterThan(0);
  });

  test("母项为 0（无记忆注入）时 sources 为空且残差为 0", () => {
    const mgr = new Manager({ maxTokens: 1_000_000 });
    mgr.setSystemPrompt("# 身份\n\n没有任何记忆索引段。");
    mgr.setMessages(messages());
    const report = buildContextReport(mgr, { model: "test-model" });
    expect(report.fixedOverhead.sources).toEqual([]);
    expect(report.fixedOverhead.residual).toBe(0);
  });

  test("细目之和超过母项时保留负残差——加总等式仍严格成立", () => {
    // 母项刻意记 1 token，而记忆索引段的估算远大于它 → 模拟口径漂移
    const mgr = new Manager({ maxTokens: 1_000_000 });
    mgr.setSystemPrompt(SYSTEM_PROMPT);
    mgr.setMessages(messages());
    mgr.setMemoryTokens(1);
    const report = buildContextReport(mgr, { model: "test-model" });
    const memory = report.categories.find((c) => c.key === "memoryFiles")!;
    const listed = report.fixedOverhead.sources.reduce((s, x) => s + x.tokens, 0);
    expect(listed).toBeGreaterThan(memory.tokens);
    // 旧实现把 residual 钳到 0，这条会红（细目 42k + 残差 0 ≠ 母项 1）——
    // 用户把细目加总后得到的是一个没有任何一行解释的数。
    expect(listed + report.fixedOverhead.residual).toBe(memory.tokens);
    expect(report.fixedOverhead.residual).toBeLessThan(0);
  });
});

describe("PR3 取数层：B5/B7 阈值与剩余量", () => {
  test("toTrigger === max(0, compressionAt − used)", () => {
    const mgr = freshManager();
    const report = buildContextReport(mgr, { model: "test-model" });
    const bd = mgr.getTokenBreakdown(0);
    expect(report.toTrigger).toBe(Math.max(0, bd.thresholds.compressionAt - report.used));
  });

  test("各档 remaining === max(0, at − used)，且 at 与 breakdown.thresholds 同源", () => {
    const mgr = freshManager();
    const report = buildContextReport(mgr, { model: "test-model" });
    const bd = mgr.getTokenBreakdown(0);
    const byKey = Object.fromEntries(report.thresholds.map((t) => [t.key, t]));

    for (const key of ["masking", "compression", "emergency", "blocking"] as const) {
      const at = bd.thresholds[`${key}At` as const];
      const row = byKey[key];
      if (!row) continue; // 小窗口下 soft/hard 未启用，允许缺行
      expect(row.at).toBe(at);
      expect(row.remaining).toBe(Math.max(0, at - report.used));
    }
  });

  test("标准窗口四档齐全，顺序由早到晚（触发点单调不减）", () => {
    const mgr = freshManager();
    const report = buildContextReport(mgr, { model: "test-model" });
    expect(report.thresholds.map((t) => t.key)).toEqual([
      "masking",
      "compression",
      "emergency",
      "blocking",
    ]);
    for (let i = 1; i < report.thresholds.length; i++) {
      expect(report.thresholds[i]!.at).toBeGreaterThanOrEqual(report.thresholds[i - 1]!.at);
    }
  });

  test("小窗口（≤60K）只列 emergency + blocking：未启用的档位不许冒充生效", () => {
    const mgr = new Manager({ maxTokens: 32_000 });
    mgr.setSystemPrompt(SYSTEM_PROMPT);
    mgr.setMessages(messages());
    const report = buildContextReport(mgr, { model: "test-model" });
    expect(report.thresholds.map((t) => t.key)).toEqual(["emergency", "blocking"]);
  });

  test("完成预留拆分自洽：outputReserve + summaryReserve === completionBuffer", () => {
    const mgr = freshManager();
    const report = buildContextReport(mgr, { model: "test-model" });
    expect(report.outputReserve + report.summaryReserve).toBe(report.completionBuffer);
    expect(report.completionBuffer).toBe(mgr.getCompactionThresholds().completionBuffer);
  });

  test("小窗口下完成预留的两个分量都是 0（不启用缓冲区）", () => {
    const mgr = new Manager({ maxTokens: 32_000 });
    mgr.setMessages(messages());
    const report = buildContextReport(mgr, { model: "test-model" });
    expect(report.completionBuffer).toBe(0);
    expect(report.outputReserve).toBe(0);
    expect(report.summaryReserve).toBe(0);
  });
});

describe("PR3 取数层：B8 实测对账", () => {
  test("lastActualPromptTokens 原样搬运 stockPromptTokens，delta = used − 实测", () => {
    const mgr = freshManager();
    const report = buildContextReport(mgr, {
      model: "test-model",
      stockPromptTokens: 90_000,
    });
    expect(report.lastActualPromptTokens).toBe(90_000);
    expect(report.delta).toBe(report.used - 90_000);
  });

  test("未提供实测（会话还没发过请求）时为 0，不做「实测值是 0」的伪装", () => {
    const mgr = freshManager();
    const report = buildContextReport(mgr, { model: "test-model" });
    expect(report.lastActualPromptTokens).toBe(0);
    expect(report.delta).toBe(report.used);
  });
});

describe("PR3 取数层：B6 释放明细与结论行", () => {
  test("freed 按策略拆分与合计自洽，每项都有 count 与人话标签", () => {
    const mgr = freshManager();
    const report = buildContextReport(mgr, { model: "test-model" });
    const bd = mgr.getTokenBreakdown(0);
    expect(report.freed.tokens).toBe(bd.freed.tokens);
    expect(report.freed.byStrategy.reduce((s, x) => s + x.tokens, 0)).toBe(report.freed.tokens);
    for (const s of report.freed.byStrategy) {
      expect(s.label.length).toBeGreaterThan(0);
      expect(s.count).toBeGreaterThanOrEqual(1);
    }
  });

  test("largestVariable 只取会话组、按 token 降序、最多 3 项", () => {
    const mgr = freshManager();
    const report = buildContextReport(mgr, { model: "test-model" });
    expect(report.largestVariable.length).toBeGreaterThan(0);
    expect(report.largestVariable.length).toBeLessThanOrEqual(3);
    const conversationLabels = new Set(
      report.categories.filter((c) => c.group === "conversation").map((c) => c.label),
    );
    for (const v of report.largestVariable) {
      expect(conversationLabels.has(v.label)).toBe(true);
    }
    for (let i = 1; i < report.largestVariable.length; i++) {
      expect(report.largestVariable[i]!.tokens).toBeLessThanOrEqual(
        report.largestVariable[i - 1]!.tokens,
      );
    }
  });

  test("提示不超过 3 条", () => {
    const mgr = freshManager();
    const report = buildContextReport(mgr, { model: "test-model" });
    expect(report.hints.length).toBeLessThanOrEqual(3);
  });
});

describe("PR3 取数层：只读性", () => {
  test("调用 buildContextReport 前后，manager 的 breakdown 逐字不变", () => {
    const mgr = freshManager();
    const before = JSON.stringify(mgr.getTokenBreakdown(0));
    buildContextReport(mgr, { model: "test-model" });
    expect(JSON.stringify(mgr.getTokenBreakdown(0))).toBe(before);
  });
});
