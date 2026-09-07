/**
 * P1-5 防复发：Session Memory 的三处「有消费者、无生产者」
 *
 * ① `sessionMemoryContent` 生产零赋值 ⇒ `<session-memory>` 附件在生产中从不出现。
 *    （生产者在 `cli/app.ts` 的 `injectSessionMemoryAfterCompact`，接线本身由
 *     tests/analytics 的埋点哨兵同型门禁 + 下面的「附件真能生成」用例共同兜住。）
 * ② `compact_source: "session_memory"` 无写入方 ⇒ 两种压缩产物事后不可区分。
 * ③ `SESSION_MEMORY_SECTIONS` 零使用 ⇒ 模板与常量表可任意漂移而无人知情
 *    （「11 section」那三处错误注释就是这么活下来的）。
 *
 * ⚠️ 变异自证：逐条确认过「把对应修复还原就变红」。
 */

import { describe, test, expect } from "bun:test";
import {
  SESSION_MEMORY_SECTIONS,
  DEFAULT_SESSION_MEMORY_TEMPLATE,
  assertTemplateSectionsMatch,
  isKnownSessionMemorySection,
} from "@sid-code/core/session-memory/prompts.ts";
import { truncateSessionMemory } from "@sid-code/core/session-memory/utils.ts";
import { isCompactSourceMessage } from "@sid-code/core/context/auto-compact.ts";
import { Manager as ContextManager } from "@sid-code/core/context/manager.ts";
import { generateSessionMemoryAttachment } from "@sid-code/core/config/attachments.ts";
import type { Message } from "@sid-code/core/llm/types.ts";

function userMsg(text: string): Message {
  return { role: "user", content: [{ type: "text", text }] };
}
function asstMsg(text: string): Message {
  return { role: "assistant", content: [{ type: "text", text }] };
}

describe("P1-5 ① sessionMemoryContent 能真的产出附件", () => {
  test("有内容时生成 <session-memory> 附件", () => {
    const att = generateSessionMemoryAttachment("# Worklog\n- 完成了 P1-5 接线");
    expect(att).not.toBeNull();
    expect(att!.content).toContain("<session-memory>");
    expect(att!.content).toContain("完成了 P1-5 接线");
  });

  test("空 / 空白内容不产出附件（不往 prompt 里塞空壳）", () => {
    expect(generateSessionMemoryAttachment(null)).toBeNull();
    expect(generateSessionMemoryAttachment("   \n  ")).toBeNull();
  });
});

describe("P1-5 ② compact_source 区分两种压缩产物", () => {
  /** 造一段足够长、能找到安全分割点的历史 */
  function seed(mgr: ContextManager): void {
    const msgs: Message[] = [];
    for (let i = 0; i < 24; i++) {
      msgs.push(userMsg(`用户第 ${i} 轮提问，内容足够长以便产生可压缩的历史`));
      msgs.push(asstMsg(`助手第 ${i} 轮回答，内容同样足够长以便产生可压缩的历史`));
    }
    mgr.setMessages(msgs);
  }

  test("默认（LLM 摘要）压缩打 compact_source=compact", () => {
    const mgr = new ContextManager({ maxTokens: 100_000 });
    seed(mgr);
    const outcome = mgr.compactWithSummary("这是 LLM 生成的摘要");
    expect(outcome.success).toBe(true);

    const summaryMsg = mgr
      .getMessages()
      .find((m: Message) => m._meta?.origin === "compact-summary");
    expect(summaryMsg).toBeDefined();
    expect(summaryMsg!._meta!.compact_source).toBe("compact");
  });

  test("Session Memory 压缩打 compact_source=session_memory（此前恒为 compact）", () => {
    const mgr = new ContextManager({ maxTokens: 100_000 });
    seed(mgr);
    const outcome = mgr.compactWithSummary("这是结构化会话笔记", undefined, "session_memory");
    expect(outcome.success).toBe(true);

    const summaryMsg = mgr
      .getMessages()
      .find((m: Message) => m._meta?.origin === "compact-summary");
    expect(summaryMsg).toBeDefined();
    // 核心断言：两种压缩在事后必须可分。旧实现这里是 "compact"。
    expect(summaryMsg!._meta!.compact_source).toBe("session_memory");
  });

  test("两种来源都被 isCompactSourceMessage 认作压缩产物（不应再次触发压缩）", () => {
    for (const src of ["compact", "session_memory"] as const) {
      const mgr = new ContextManager({ maxTokens: 100_000 });
      seed(mgr);
      mgr.compactWithSummary("摘要", undefined, src);
      const summaryMsg = mgr
        .getMessages()
        .find((m: Message) => m._meta?.origin === "compact-summary")!;
      expect(isCompactSourceMessage(summaryMsg)).toBe(true);
    }
  });
});

describe("P1-5 ③ SESSION_MEMORY_SECTIONS 真正参与校验与截断", () => {
  test("模板与常量表一致，且是 10 个 section（不是注释里写的 11）", () => {
    const n = assertTemplateSectionsMatch();
    expect(n).toBe(10);
    expect(SESSION_MEMORY_SECTIONS.length).toBe(10);
  });

  test("模板漂移时 assertTemplateSectionsMatch 抛错（常量表不再是挂件）", () => {
    const drifted = DEFAULT_SESSION_MEMORY_TEMPLATE + "\n# Model Invented Section\n_x_\n";
    expect(() => assertTemplateSectionsMatch(drifted)).toThrow(/不一致/);
  });

  test("isKnownSessionMemorySection 区分模板 section 与模型自加的", () => {
    expect(isKnownSessionMemorySection("Current State")).toBe(true);
    expect(isKnownSessionMemorySection("  Worklog  ")).toBe(true);
    expect(isKnownSessionMemorySection("Random Extra Notes")).toBe(false);
  });

  test("模型自加的 section 一律排在模板 section 之后（预算紧张时先掉它）", () => {
    // 模型违反更新提示词第 4 条「不要添加新 section」，塞了一个巨大的自创 section
    // **且放在文件最前面**。旧实现按文件顺序逐个塞 ⇒ 这个违规 section 先占预算，
    // 后面的模板 section 被往后挤（预算再紧一点就整个掉光）。
    //
    // ⚠️ 断言选的是**顺序**而不是「模板 section 还在不在」：
    // 逐 section 截断会把超长 section 压到 perSectionTokens 以内，
    // 于是两种实现下模板 section 往往都还在 —— 那样的断言在修复前后同时为真，
    // 是个测不到东西的空门禁（这一版是改过来的，初版就踩了）。
    const manyLines = Array.from({ length: 600 }, (_, i) => `- 第 ${i} 条冗长记录内容`).join("\n");
    const content = [
      `# Model Invented Section\n${manyLines}`,
      `# Current State\n正在做 P1-5 的接线`,
      `# Key results\n三处半接线已补齐`,
    ].join("\n\n");

    const out = truncateSessionMemory(content, 1_200, 1_000);

    const iInvented = out.indexOf("# Model Invented Section");
    const iCurrent = out.indexOf("# Current State");
    expect(iCurrent).toBeGreaterThanOrEqual(0);
    expect(iInvented).toBeGreaterThanOrEqual(0);
    // 旧实现：invented@0、current@2201 ⇒ 这条为 false
    expect(iCurrent).toBeLessThan(iInvented);
  });

  test("模板 section 之间保持文件原有相对顺序（不按常量表重排）", () => {
    // Worklog 是时序内容，重排会让它错位——所以分区必须是**稳定**的。
    const content = ["# Current State\n当前状态", "# Worklog\n1. 第一步\n2. 第二步"].join("\n\n");
    const out = truncateSessionMemory(content, 10_000, 5_000);
    expect(out.indexOf("# Current State")).toBeLessThan(out.indexOf("# Worklog"));
  });
});
