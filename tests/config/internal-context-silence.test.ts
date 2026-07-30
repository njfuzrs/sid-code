/**
 * 内部上下文静默条款 — 防漂移哨兵
 *
 * ## 背景（2026-07-31）
 *
 * 会话 20260730-172113-8453412d 实测：模型在 70 轮里有 18 轮（26%，后半程 50%）
 * 以「收到 CLAUDE.md 和 UI 规范。」这类开场白起头。用户终端里看不见这些注入内容，
 * 因此这些句子在 TUI 上表现为凭空冒出的无信息量提示，观感像 harness 在反复弹提醒。
 *
 * 排查结论（轨迹实证，非猜测）：
 * - 这句话**不在源码里**（`grep "收到 CLAUDE" src/` = 0 命中），是模型自己的输出；
 * - CLAUDE.md **没有**每轮重复注入：`new_messages` 含 `# claudeMd` 次数 = 0，
 *   `cache_read_input_tokens` 从 0 单调爬到 118016 无回退（前缀若变缓存必断）；
 * - 18 次复述里有 17 次发生在**当轮没有任何 reminder 注入**的轮次 → 纯口头习惯 + 自我强化。
 *
 * 真实缺口：CLAUDE.md 注入通道是**唯一**不带静默条款的 reminder
 * （todo-reminder / work-log / permission-reminder / hypothesis-guide 都有）。
 *
 * ## 本测试锁定三处修复
 *
 * 缺任何一处，弱模型都会重新开始复述：
 * 1. `generateClaudeMdAttachment`（主加载通道，项目根 CLAUDE.md）
 * 2. `JitContextManager.discoverContext`（JIT 通道，子目录 CLAUDE.md = 模型口中的「UI 规范」）
 * 3. system prompt「回答规范 §8」（全局兜底，覆盖其余 20+ 个 reminder 发射点）
 */

import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { generateClaudeMdAttachment } from "../../src/config/attachments.ts";
import { JitContextManager } from "../../src/config/jit-context.ts";
import { buildSystemPrompt } from "../../src/config/system-prompt.ts";

/** 静默语义的判据：出现「请勿…提及」+「复述」即算带条款 */
function hasSilenceClause(text: string): boolean {
  return /请勿[^\n]*提及/.test(text) && text.includes("复述");
}

describe("内部上下文静默条款", () => {
  test("generateClaudeMdAttachment 带静默条款", () => {
    const a = generateClaudeMdAttachment("# 项目规则\n使用 TypeScript", "/p/CLAUDE.md");
    expect(hasSilenceClause(a.content)).toBe(true);
    // 正文仍须完整保留（静默条款不得挤掉规则本体）
    expect(a.content).toContain("使用 TypeScript");
  });

  test("JIT 子目录上下文带静默条款", async () => {
    const root = mkdtempSync(join(tmpdir(), "sid-jit-silence-"));
    try {
      const sub = join(root, "src", "ui");
      mkdirSync(sub, { recursive: true });
      writeFileSync(join(sub, "CLAUDE.md"), "# TUI 规范\n禁用彩色 emoji");
      const target = join(sub, "Footer.tsx");
      writeFileSync(target, "export const Footer = () => null\n");

      const mgr = new JitContextManager();
      const ctx = await mgr.discoverContext(target, root);

      expect(ctx).not.toBeNull();
      expect(ctx!).toContain("禁用彩色 emoji");
      expect(hasSilenceClause(ctx!)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("system prompt 含「不复述内部上下文」全局规则", () => {
    const prompt = buildSystemPrompt({ tools: [] } as any);

    // 规则本体
    expect(prompt).toContain("不复述 harness 注入的内部上下文");
    // 必须明示每轮生效——只在首轮生效会让后半程复述率回升（实测后半程达 50%）
    expect(prompt).toContain("每一轮");
    // 借鉴 CC getSystemRemindersSection：先框定「系统自动添加、与出现位置无关」，
    // 模型才有依据判断这不是用户的话；缺这层框定时只有「别说」的禁令而无归因。
    expect(prompt).toContain("系统自动添加");
    expect(prompt).toContain("没有直接关系");
  });

  test("规则不含 ✗ 反例字面量（反例会反向 prime 模型说出该句）", () => {
    const prompt = buildSystemPrompt({ tools: [] } as any);
    // 实测副作用：§8 初版列了「收到 CLAUDE.md 和 UI 规范。」等 ✗ 反例，
    // 反而给了模型可照抄的成句模板——诱导实验里修复后仍原样吐出该字面量。
    // 规则用「句式描述」而非「例句」表达，避免把禁令变成模板。
    expect(prompt).not.toContain("收到 CLAUDE.md 和 UI 规范");
    expect(prompt).not.toContain("CLAUDE.md 与 UI 规范已收到");
  });

  test("规则带反向边界，不禁止用户直接询问时如实回答", () => {
    const prompt = buildSystemPrompt({ tools: [] } as any);
    // 缺边界时模型会过度执行：用户明确问「你收到哪些规则」也拒答，
    // 与「错误透明 / 如实告知」相冲突。
    expect(prompt).toContain("不要过度执行");
    expect(prompt).toContain("如实回答");
  });
});
