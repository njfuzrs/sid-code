/**
 * Layer 1：autoCompact 结构化摘要 Prompt 工程 — 单元测试
 *
 * 覆盖纯函数：getCompactPrompt / renderMessageForSummary / buildCompactUserPrompt /
 * formatCompactSummary / getCompactUserSummaryMessage。
 *
 * 这些函数决定了"压缩后会不会断片"的摘要质量契约，在此锁定其行为。
 */

import { describe, it, expect } from "bun:test";
import type { Message } from "@sid-code/core/llm/types.ts";
import {
  COMPACT_SYSTEM_PROMPT,
  getCompactPrompt,
  renderMessageForSummary,
  buildCompactUserPrompt,
  formatCompactSummary,
  getCompactUserSummaryMessage,
} from "@sid-code/core/query/compact/auto-compact-prompt.ts";

describe("getCompactPrompt", () => {
  it("包含 9 个结构化段落要求", () => {
    const prompt = getCompactPrompt();
    expect(prompt).toContain("主要请求与意图");
    expect(prompt).toContain("关键技术概念");
    expect(prompt).toContain("文件与代码段");
    expect(prompt).toContain("错误与修复");
    expect(prompt).toContain("问题解决进展");
    expect(prompt).toContain("所有用户消息");
    expect(prompt).toContain("待办事项");
    expect(prompt).toContain("当前工作");
    expect(prompt).toContain("可选的下一步");
  });

  it("要求 analysis + summary 双层输出", () => {
    const prompt = getCompactPrompt();
    expect(prompt).toContain("<analysis>");
    expect(prompt).toContain("<summary>");
  });

  it("末尾重申纯文本、不调用工具", () => {
    const prompt = getCompactPrompt();
    expect(prompt).toContain("不要调用任何工具");
  });

  it("注入自定义指令时追加到末尾", () => {
    const prompt = getCompactPrompt("重点关注 TypeScript 改动");
    expect(prompt).toContain("额外指令");
    expect(prompt).toContain("重点关注 TypeScript 改动");
  });

  it("空白自定义指令不追加额外段落", () => {
    const prompt = getCompactPrompt("   ");
    expect(prompt).not.toContain("额外指令");
  });
});

describe("renderMessageForSummary（差异化截断）", () => {
  it("user 文本消息全文保留（不截断）", () => {
    const longUserText = "请帮我".repeat(2000); // 远超 2000 字符
    const msg: Message = { role: "user", content: [{ type: "text", text: longUserText }] };
    const rendered = renderMessageForSummary(msg);
    expect(rendered).toContain(longUserText);
    expect(rendered.startsWith("[user]")).toBe(true);
  });

  it("assistant 文本消息截断到 2000 字符", () => {
    const longText = "a".repeat(5000);
    const msg: Message = { role: "assistant", content: [{ type: "text", text: longText }] };
    const rendered = renderMessageForSummary(msg);
    // 主体（去掉 "[assistant] " 前缀和省略号）不应超过 2000 字符 + 省略号
    expect(rendered).toContain("a".repeat(2000));
    expect(rendered).not.toContain("a".repeat(2001));
    expect(rendered).toContain("…");
  });

  it("assistant 工具调用保留工具名 + 截断参数", () => {
    const msg: Message = {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "t1",
          name: "edit",
          input: { file: "a.ts", content: "x".repeat(2000) },
        },
      ],
    };
    const rendered = renderMessageForSummary(msg);
    expect(rendered).toContain("[工具调用: edit]");
    expect(rendered).toContain("…");
  });

  it("user 工具结果缩略到 200 字符并标注总长度", () => {
    const bigResult = "z".repeat(12345);
    const msg: Message = {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", content: bigResult }],
    };
    const rendered = renderMessageForSummary(msg);
    expect(rendered).toContain("[工具结果]");
    expect(rendered).toContain("z".repeat(200));
    expect(rendered).not.toContain("z".repeat(201));
    expect(rendered).toContain("[共 12345 字符]");
  });

  it("短工具结果不追加长度标注", () => {
    const msg: Message = {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
    };
    const rendered = renderMessageForSummary(msg);
    expect(rendered).toContain("ok");
    expect(rendered).not.toContain("[共");
  });
});

describe("buildCompactUserPrompt", () => {
  it("拼装指令 + 对话内容", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "目标：实现登录" }] },
      { role: "assistant", content: [{ type: "text", text: "好的" }] },
    ];
    const prompt = buildCompactUserPrompt(messages);
    expect(prompt).toContain("主要请求与意图"); // 指令部分
    expect(prompt).toContain("目标：实现登录"); // 对话内容
    expect(prompt).toContain("需要总结的对话内容");
  });
});

describe("formatCompactSummary", () => {
  it("剥离 analysis 草稿块，保留 summary 内容", () => {
    const raw = "<analysis>这是草稿思考</analysis><summary>这是最终摘要</summary>";
    const formatted = formatCompactSummary(raw);
    expect(formatted).toBe("这是最终摘要");
    expect(formatted).not.toContain("草稿");
  });

  it("多个 analysis 块全部剥离", () => {
    const raw = "<analysis>a</analysis>noise<analysis>b</analysis><summary>final</summary>";
    const formatted = formatCompactSummary(raw);
    expect(formatted).toBe("final");
  });

  it("无标签时鲁棒回退为原文 trim", () => {
    const raw = "  纯文本摘要，没有标签  ";
    const formatted = formatCompactSummary(raw);
    expect(formatted).toBe("纯文本摘要，没有标签");
  });

  it("只有 summary 开标签无闭合时剥离残留标签", () => {
    const raw = "<summary>未闭合的摘要";
    const formatted = formatCompactSummary(raw);
    expect(formatted).toBe("未闭合的摘要");
  });
});

describe("getCompactUserSummaryMessage（post-compact 重组）", () => {
  const summary = "<summary>任务进展摘要</summary>";

  it("基础：剥离标签 + 续接说明", () => {
    const msg = getCompactUserSummaryMessage(summary);
    expect(msg).toContain("任务进展摘要");
    expect(msg).toContain("结构化摘要");
  });

  it("提供 transcriptPath 时追加转录路径提示", () => {
    const msg = getCompactUserSummaryMessage(summary, { transcriptPath: "/tmp/session.jsonl" });
    expect(msg).toContain("/tmp/session.jsonl");
    expect(msg).toContain("完整转录文件");
  });

  it("不提供 transcriptPath 时不出现转录提示", () => {
    const msg = getCompactUserSummaryMessage(summary, {});
    expect(msg).not.toContain("完整转录文件");
  });

  it("recentMessagesPreserved 时追加保留消息提示（含条数）", () => {
    const msg = getCompactUserSummaryMessage(summary, {
      recentMessagesPreserved: true,
      preservedCount: 4,
    });
    expect(msg).toContain("最近的 4 条消息");
    expect(msg).toContain("完整保留");
  });

  it("suppressFollowUpQuestions 时追加静默续接指令", () => {
    const msg = getCompactUserSummaryMessage(summary, { suppressFollowUpQuestions: true });
    expect(msg).toContain("不要向用户提任何问题");
    expect(msg).toContain("继续");
  });

  it("autoCompact 全量场景：三项提示同时存在", () => {
    const msg = getCompactUserSummaryMessage(summary, {
      suppressFollowUpQuestions: true,
      transcriptPath: "/tmp/s.jsonl",
      recentMessagesPreserved: true,
      preservedCount: 4,
    });
    expect(msg).toContain("/tmp/s.jsonl");
    expect(msg).toContain("最近的 4 条消息");
    expect(msg).toContain("不要向用户提任何问题");
  });
});

describe("COMPACT_SYSTEM_PROMPT", () => {
  it("强调保留关键信息且不调用工具", () => {
    expect(COMPACT_SYSTEM_PROMPT).toContain("用户意图");
    expect(COMPACT_SYSTEM_PROMPT).toContain("待办");
    expect(COMPACT_SYSTEM_PROMPT).toContain("不要调用任何工具");
  });
});
