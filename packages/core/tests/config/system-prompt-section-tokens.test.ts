/**
 * A5（2026-11-17 /context 取数方案 PR4）：记忆分量按「实际在场的那部分」计数。
 *
 * 旧实现在 reportSectionTokens 里用每段前 200 字符判在场，命中就加**全文**估算。
 * 截断发生时 truncateToLimit 只保留附件的前缀 + `[内容已截断]` 标记，于是记忆分类
 * 与截断前一样大；它被 min(memoryTokens, rawSystemPrompt) 钳住后，偏差被转移到
 * 「系统提示词」分类（让它偏小）。三条用例分别钉住：不截断（防回归）、部分截断
 * （本次修复的目标）、整段丢弃（既有行为）。
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { buildSystemPrompt, clearPromptCache } from "@sid-code/core/config/system-prompt.ts";
import { generateClaudeMdAttachment } from "@sid-code/core/config/attachments.ts";
import { estimateTokens } from "@sid-code/core/config/token-utils.ts";

/** 记忆系统指令 + MEMORY.md 索引（core 区注入，不会被 truncateToLimit 动） */
const MEMORY_PROMPT = "# 记忆系统\n\n## Memory Index\n- [prefer-concise] 用户偏好简洁回答\n";
const CLAUDE_PATH = "/tmp/project/CLAUDE.md";
/** 足够大，配小 maxTokens 就能让截断点落在它中间 */
const LONG_RULES = "这是一条很长的项目规则，用来把系统提示词撑到截断阈值以上。\n".repeat(400);

function baseCtx() {
  return {
    tools: [],
    memorySystemPrompt: MEMORY_PROMPT,
    projectRules: LONG_RULES,
    projectRulesPath: CLAUDE_PATH,
  };
}

describe("reportSectionTokens：记忆分量按实际在场部分计数（A5）", () => {
  beforeEach(() => {
    clearPromptCache();
  });

  test("未截断时仍等于各记忆段全文估算（防回归）", () => {
    let reported = -1;
    const prompt = buildSystemPrompt({
      ...baseCtx(),
      onSectionTokens: (s) => {
        reported = s.memory;
      },
    });
    const claudeMd = generateClaudeMdAttachment(LONG_RULES, CLAUDE_PATH).content;
    // 前提：这段规则确实全文在场（没被截断），否则本用例测的不是防回归场景
    expect(prompt).toContain(claudeMd);
    expect(reported).toBe(estimateTokens(MEMORY_PROMPT) + estimateTokens(claudeMd));
  });

  test("部分截断时只计留在提示词里的前缀，不按全文虚报", () => {
    // 先拿不截断的完整提示词，据此推一个「必然截断、且截断点落在 CLAUDE.md 中间」的上限：
    // truncateToLimit 内部按 maxTokens 的 90% 算可用量，所以取完整的 60% 再除回 90%。
    const full = buildSystemPrompt(baseCtx());
    const maxTokens = Math.ceil((estimateTokens(full) * 0.6) / 0.9);

    let reported = -1;
    const prompt = buildSystemPrompt({
      ...baseCtx(),
      maxTokens,
      onSectionTokens: (s) => {
        reported = s.memory;
      },
    });

    const claudeMd = generateClaudeMdAttachment(LONG_RULES, CLAUDE_PATH).content;
    // 前提：真的走到了「部分截断」这条路径，否则本用例没有覆盖目标
    expect(prompt).toContain("[内容已截断]");
    expect(prompt).not.toContain(claudeMd);

    // 期望值从最终 content 独立推导（不复用实现的公共前缀算法）：
    // 定位这段记忆的起点，切到截断标记，剩下的就是实际占着上下文的部分。
    const start = prompt.indexOf(claudeMd.slice(0, 200));
    expect(start).toBeGreaterThanOrEqual(0);
    const present = prompt.slice(start, prompt.indexOf("[内容已截断]")).trimEnd();
    expect(present.length).toBeGreaterThan(0);
    expect(present.length).toBeLessThan(claudeMd.length);

    expect(reported).toBe(estimateTokens(MEMORY_PROMPT) + estimateTokens(present));
    // 核心断言：不再把已经不存在的尾部算进「记忆」
    expect(reported).toBeLessThan(estimateTokens(MEMORY_PROMPT) + estimateTokens(claudeMd));
  });

  test("整段被丢弃时计 0（既有行为，防回归）", () => {
    let reported = -1;
    // maxTokens=100 → 可用量 90 token，连核心区都放不下，所有附件（含 CLAUDE.md）全丢
    const prompt = buildSystemPrompt({
      ...baseCtx(),
      maxTokens: 100,
      onSectionTokens: (s) => {
        reported = s.memory;
      },
    });
    const claudeMd = generateClaudeMdAttachment(LONG_RULES, CLAUDE_PATH).content;
    expect(prompt).not.toContain(claudeMd.slice(0, 200));
    // 只剩 core 区的记忆系统指令/MEMORY.md 索引这一段
    expect(reported).toBe(estimateTokens(MEMORY_PROMPT));
  });
});
