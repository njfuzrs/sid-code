/**
 * formatAnsweredOutput 纯函数单测
 *
 * 覆盖 AskUserQuestion 作答结果回灌模型的文本格式：
 * - 每题一行 `· {question} → {answer}`
 * - 有非空备注时追加 `（备注：{note}）`
 * - 未作答的题标 `(未作答)`
 * - 空白/缺失备注不产生备注后缀
 */

import { test, expect, describe } from "bun:test";
import { formatAnsweredOutput } from "@sid-code/core/tool/ask-user-question.ts";
import type { AskQuestion } from "@sid-code/core/tool/ask-user-question-bridge.ts";

const q = (question: string): AskQuestion => ({
  question,
  header: "H",
  options: [{ label: "占位" }],
});

describe("formatAnsweredOutput — 作答回灌格式", () => {
  test("单题无备注 → 只有「问题 → 答案」", () => {
    const out = formatAnsweredOutput([q("用哪种缓存?")], { "用哪种缓存?": "Redis" });
    expect(out).toBe("用户已作答：\n· 用哪种缓存? → Redis");
  });

  test("带非空备注 → 追加（备注：…）", () => {
    const out = formatAnsweredOutput(
      [q("用哪种缓存?")],
      { "用哪种缓存?": "Redis" },
      { "用哪种缓存?": "内存不够再上" },
    );
    expect(out).toBe("用户已作答：\n· 用哪种缓存? → Redis（备注：内存不够再上）");
  });

  test("多题，仅部分有备注 → 各自独立", () => {
    const out = formatAnsweredOutput(
      [q("A?"), q("B?")],
      { "A?": "a", "B?": "b" },
      { "A?": "备注a" },
    );
    expect(out).toBe("用户已作答：\n· A? → a（备注：备注a）\n· B? → b");
  });

  test("空白备注不产生后缀（trim 后为空）", () => {
    const out = formatAnsweredOutput([q("A?")], { "A?": "a" }, { "A?": "   " });
    expect(out).toBe("用户已作答：\n· A? → a");
  });

  test("未作答的题 → (未作答)", () => {
    const out = formatAnsweredOutput([q("A?")], {});
    expect(out).toBe("用户已作答：\n· A? → (未作答)");
  });

  test("notes 参数缺省 → 不报错，无备注后缀", () => {
    const out = formatAnsweredOutput([q("A?")], { "A?": "a" });
    expect(out).toBe("用户已作答：\n· A? → a");
  });
});
