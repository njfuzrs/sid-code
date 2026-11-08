/**
 * X3-16：审计核查类任务的分类判据 + 它在 digest 里的接线。
 *
 * ## 这两层为什么要一起测
 *
 * 判据正确但没接线，和接线了但判据错，在指标上都会表现为「防线触发率不对」，
 * 而两种原因需要的修法完全不同。所以这里分两组：
 *
 * 1. **判据本身**（`isAuditTaskPrompt`）：中英文关键词、大小写、空串、
 *    「不是审计类」的常见形态（改个 bug、加个功能）。
 * 2. **接线**（`aggregateSessionMetrics` → `isAudit`）：只认首个 prompt、
 *    后续追问不改变性质、没有 prompt 时是**未检测**（键不落）而不是 false。
 *
 * 第 2 组是这条指标真正的失效点：分类逻辑再对，只要 digest 拿最后一个 prompt
 * 或者拿全部 prompt 判定，分母口径就会随会话变长而漂移。
 */
import { describe, expect, test } from "bun:test";
import { AUDIT_KEYWORDS, isAuditTaskPrompt } from "@sid-code/core/trace/audit-task.ts";
import { aggregateSessionMetrics } from "@sid-code/core/trace/digest.ts";

// ─── 判据本身 ───

describe("X3-16 · isAuditTaskPrompt：审计核查类任务的判据", () => {
  test("中文关键词命中（检查 / 审计 / 根因 / 验收 …）", () => {
    for (const p of [
      "帮我检查一下这个改动",
      "审计一遍权限管线",
      "排查这个报错的根因",
      "验收一下这批修复",
      "复核 PR #654 的结论",
      "看看有没有落地",
    ]) {
      expect(isAuditTaskPrompt(p), p).toBe(true);
    }
  });

  test("英文关键词大小写不敏感（Audit / VERIFY / Review）", () => {
    for (const p of [
      "Audit the permission pipeline",
      "VERIFY this fix",
      "please Review the diff",
    ]) {
      expect(isAuditTaskPrompt(p), p).toBe(true);
    }
  });

  test("多词短语命中（check whether / double check）", () => {
    expect(isAuditTaskPrompt("check whether the gate really runs")).toBe(true);
    expect(isAuditTaskPrompt("double-check this claim")).toBe(true);
  });

  test("普通开发任务不命中（分母不能被稀释）", () => {
    for (const p of [
      "给设置页加一个深色模式开关",
      "修复登录按钮点了没反应",
      "把这个函数重命名成 getCurrentWorkingDirectory",
      "写一个 README",
    ]) {
      expect(isAuditTaskPrompt(p), p).toBe(false);
    }
  });

  test("空串 / 纯空白 → false（没有判据不能算「是」）", () => {
    expect(isAuditTaskPrompt("")).toBe(false);
    expect(isAuditTaskPrompt("   \n\t ")).toBe(false);
  });

  test("关键词表非空且不含空串（空串会让每个 prompt 都命中）", () => {
    expect(AUDIT_KEYWORDS.length).toBeGreaterThan(0);
    expect(AUDIT_KEYWORDS.every((k) => k.trim().length > 0)).toBe(true);
  });
});

// ─── digest 里的接线 ───

/** 造一条 UserPromptSubmit 事件（digest 读 data.prompt）。 */
function prompt(p: string) {
  return { event: "UserPromptSubmit", data: { prompt: p } };
}

describe("X3-16 · aggregateSessionMetrics 的 isAudit：只认首个 prompt", () => {
  test("首个 prompt 是审计类 → isAudit=true", () => {
    const m = aggregateSessionMetrics([prompt("检查一下这个门禁有没有落地")], {
      trajCorrupt: false,
    });
    expect(m.isAudit).toBe(true);
  });

  test("首个 prompt 不是审计类 → isAudit=false，后续追问不改判", () => {
    // 这条是「只认首个」的核心：会话中途插一句「顺便检查一下 X」
    // 不应该把这个会话从"普通开发"改判成"审计类"，否则分母会随会话长度漂移。
    const m = aggregateSessionMetrics(
      [prompt("给设置页加一个开关"), prompt("顺便检查一下别的地方有没有同样问题")],
      { trajCorrupt: false },
    );
    expect(m.isAudit).toBe(false);
  });

  test("没有 UserPromptSubmit → isAudit 键不落（未检测，不是 false）", () => {
    // 空事件流 / 只有工具事件：没看到 prompt，就不能替它下「非审计」的结论。
    const m = aggregateSessionMetrics([{ event: "PreToolUse", data: { tool_name: "bash" } }], {
      trajCorrupt: false,
    });
    expect("isAudit" in m).toBe(false);
  });

  test("空 prompt 不算判定过（继续等下一个真 prompt）", () => {
    const m = aggregateSessionMetrics([prompt("   "), prompt("审计一下这个改动")], {
      trajCorrupt: false,
    });
    expect(m.isAudit).toBe(true);
  });

  test("防线触发（PreToolUse）不影响分母判定，两个字段互相独立", () => {
    // 分子（defenseTriggered）与分母（isAudit）必须能各取所需：
    // 一个非审计会话触发了防线，是「分子有值但不在分母里」，不该被硬拗进分母。
    const m = aggregateSessionMetrics(
      [
        prompt("加个深色模式开关"),
        { event: "PreToolUse", data: { tool_name: "hypothesis_register" } },
      ],
      { trajCorrupt: false },
    );
    expect(m.defenseTriggered).toBe(true);
    expect(m.isAudit).toBe(false);
  });
});
