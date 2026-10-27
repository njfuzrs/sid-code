/**
 * 「未答复的 end_turn」按形态分类（2026-10-27）
 *
 * 真实触发：20261026-153949-44168811 #70、20261026-155110-ef2ddda8 #44（deepseek-v4-1-flash）。
 * 两轮都是 end_turn + 唯一一个约 14k 字符的 thinking 块，思考里是要追加进文档的整段正文，
 * 末尾残留 `</｜｜DSML｜｜ parameter>`——edit 工具调用落进了 reasoning 通道、没被解析执行。
 * 旧实现把它报成「疑似思考泄漏到正文」，并回注「先 todo_write 拆步骤」，两者都不对症。
 *
 * 覆盖：
 *   ① 回放实测形态 → unparsed_tool_call；
 *   ② 各形态分别置对 shape（A / B / empty 不被新判据抢走）；
 *   ③ 误报边界：代码块里的协议示例、有实质答复时思考里出现标记、单独的「DSML」一词；
 *   ④ 社区报告的写坏变体都能识别；
 *   ⑤ 文案 / 回注提示按形态分开，unparsed 那套不再要求 todo_write。
 */

import { describe, test, expect } from "bun:test";
import {
  detectUnansweredEndTurn,
  hasUnparsedToolCallMarkup,
  describeUnansweredRetry,
  describeUnansweredExhausted,
  SHORT_ANSWER_LEN,
} from "@sid-code/core/query/unanswered-end-turn.ts";
import { buildUnansweredEndTurnMessage } from "@sid-code/core/query/todo-reminder.ts";
import type { AccumulatedResponse } from "@sid-code/core/llm/types.ts";

function mkResp(partial: Partial<AccumulatedResponse>): AccumulatedResponse {
  return {
    role: "assistant",
    content: [],
    stopReason: "end_turn",
    usage: { inputTokens: 0, outputTokens: 0 },
    ...partial,
  };
}

/** 回放两次实测的结构：规划散文 + 要追加的 Markdown 正文 + 残缺的 DSML 闭合标签 */
const REPLAY_THINKING =
  "我需要继续写文档的第二部分。我用 edit 追加，锚点用最后一行。\n\n" +
  "## 3. 修复方案（分层）\n\n### 3.1 L1 逻辑层\n\n| 输入 | 结果 |\n|---|---|\n".repeat(120) +
  "**交接说明**：建议按 §3.1 → §3.3 的顺序做。\n</｜｜DSML｜｜ parameter>";

describe("① 回放实测形态", () => {
  test("唯一长 thinking + 末尾残缺 DSML 闭合标签 → unparsed_tool_call，思考保持折叠", () => {
    expect(REPLAY_THINKING.length).toBeGreaterThan(SHORT_ANSWER_LEN);
    const resp = mkResp({
      content: [{ type: "thinking", thinking: REPLAY_THINKING }],
      usage: { inputTokens: 193035, outputTokens: 6323 },
    });
    detectUnansweredEndTurn(resp, false);
    expect(resp._unansweredEndTurn).toBe(true);
    expect(resp._unansweredShape).toBe("unparsed_tool_call");
    expect(resp.content).toEqual([{ type: "thinking", thinking: REPLAY_THINKING }]);
  });

  test("同样的长 thinking 去掉标记 → 仍判未答复，但形态是 thinking_only", () => {
    const resp = mkResp({
      content: [{ type: "thinking", thinking: REPLAY_THINKING.replace(/<\/｜｜DSML.*$/, "") }],
    });
    detectUnansweredEndTurn(resp, false);
    expect(resp._unansweredEndTurn).toBe(true);
    expect(resp._unansweredShape).toBe("thinking_only");
  });
});

describe("② 各形态 shape 不串", () => {
  test("text_drift：原始 usage=0 + 超长 text", () => {
    const resp = mkResp({ content: [{ type: "text", text: "Let me think... ".repeat(200) }] });
    detectUnansweredEndTurn(resp, true);
    expect(resp._unansweredShape).toBe("text_drift");
  });

  test("empty：空 content", () => {
    const resp = mkResp({ content: [] });
    detectUnansweredEndTurn(resp, false);
    expect(resp._unansweredShape).toBe("empty");
  });

  test("多段 thinking 无标记 → thinking_only", () => {
    const resp = mkResp({
      content: [
        { type: "thinking", thinking: "第一段推演" },
        { type: "thinking", thinking: "第二段推演" },
      ],
    });
    detectUnansweredEndTurn(resp, false);
    expect(resp._unansweredShape).toBe("thinking_only");
  });

  test("短 thinking 带标记 → unparsed_tool_call，且**不**被转成正文（不把裸协议标记渲染给用户）", () => {
    const t = '<｜DSML｜invoke name="read"><｜DSML｜parameter name="path" string="true">a.ts';
    const resp = mkResp({ content: [{ type: "thinking", thinking: t }] });
    detectUnansweredEndTurn(resp, false);
    expect(resp._unansweredShape).toBe("unparsed_tool_call");
    expect(resp.content.some((b) => b.type === "text")).toBe(false);
  });

  test("text 里带标记：残片前的前言保留为正文，残片及之后转折叠思考", () => {
    const resp = mkResp({
      content: [
        {
          type: "text",
          text:
            "我先并行搜索几个方向。" +
            '<||DSML||tool_calls><||DSML||invoke name="grep"><||DSML||parameter name="q" string="true">x</||DSML||parameter>',
        },
      ],
      usage: { inputTokens: 0, outputTokens: 50 },
    });
    detectUnansweredEndTurn(resp, false);
    expect(resp._unansweredShape).toBe("unparsed_tool_call");
    expect(resp.content[0]).toEqual({ type: "text", text: "我先并行搜索几个方向。" });
    expect(resp.content[1]!.type).toBe("thinking");
    expect(
      (resp.content[1] as { thinking: string }).thinking.startsWith("<||DSML||tool_calls>"),
    ).toBe(true);
  });

  test("有 tool_use 时不判（标记残留但调用已正常发出）", () => {
    const resp = mkResp({
      content: [
        { type: "thinking", thinking: REPLAY_THINKING },
        { type: "tool_use", id: "t1", name: "edit", input: {} },
      ],
    });
    detectUnansweredEndTurn(resp, false);
    expect(resp._unansweredEndTurn).toBeUndefined();
  });
});

describe("③ 误报边界", () => {
  test("正文里用代码块讲解 DSML 格式 → 正常答复，不判", () => {
    const answer =
      'DeepSeek V4 的工具调用长这样：\n\n```\n<｜DSML｜tool_calls>\n<｜DSML｜invoke name="f">\n```\n\n' +
      "行内写法 `</｜DSML｜parameter>` 也一样。服务端会把它解析成 tool_calls。";
    const resp = mkResp({
      content: [{ type: "text", text: answer }],
      usage: { inputTokens: 0, outputTokens: 80 },
    });
    detectUnansweredEndTurn(resp, false);
    expect(resp._unansweredEndTurn).toBeUndefined();
    expect(resp.content[0]).toEqual({ type: "text", text: answer });
  });

  test("已有实质正文（> SHORT_ANSWER_LEN）时思考里出现标记 → 不判（在推演协议本身）", () => {
    const resp = mkResp({
      content: [
        { type: "thinking", thinking: "用户问 <｜DSML｜invoke 的格式，我来解释" },
        { type: "text", text: "完整的解释。".repeat(120) },
      ],
      usage: { inputTokens: 0, outputTokens: 400 },
    });
    detectUnansweredEndTurn(resp, false);
    expect(resp._unansweredEndTurn).toBeUndefined();
  });

  test("单独出现「DSML」一词不算标记", () => {
    expect(hasUnparsedToolCallMarkup("我们讨论一下 DSML 协议的设计")).toBe(false);
    expect(hasUnparsedToolCallMarkup("|DSML| 是一个特殊 token")).toBe(false);
  });
});

describe("④ 写坏的变体都能识别", () => {
  const variants = [
    "</｜｜DSML｜｜ parameter>", // 实测：竖线重复 + 空格
    "<｜DSML｜tool_calls>",
    "<||DSML||tool_calls>", // ASCII 竖线
    "<｜DSML｜toolcalls>", // 少下划线
    "<｜DSML｜tool>", // 截短
    '<｜DSML｜invoke name="x">',
  ];
  for (const v of variants) {
    test(v, () => expect(hasUnparsedToolCallMarkup(`前文 ${v} 后文`)).toBe(true));
  }
});

describe("⑤ 文案与回注提示按形态分开", () => {
  test("unparsed_tool_call 的警告不再说「思考泄漏到正文」", () => {
    const t = describeUnansweredRetry("unparsed_tool_call");
    expect(t).toContain("工具调用");
    expect(t).not.toContain("泄漏到正文");
  });

  test("其余形态文案互不相同，缺省 shape 用中性措辞", () => {
    const texts = (["text_drift", "thinking_only", "empty", undefined] as const).map(
      describeUnansweredRetry,
    );
    expect(new Set(texts).size).toBe(texts.length);
    for (const t of texts) expect(t).toContain("自动引导重新推进");
    expect(describeUnansweredRetry(undefined)).not.toContain("泄漏");
  });

  test("unparsed 回注提示：说明未执行、要求核实与拆小，不要求 todo_write", () => {
    const m = buildUnansweredEndTurnMessage("unparsed_tool_call");
    expect(m).toContain("没有被执行");
    expect(m).toContain("拆成");
    expect(m).not.toContain("todo_write");
  });

  test("其余形态沿用原收敛提示", () => {
    expect(buildUnansweredEndTurnMessage("thinking_only")).toContain("todo_write");
    expect(buildUnansweredEndTurnMessage()).toContain("没有产出面向用户的有效答复");
  });

  test("耗尽文案：unparsed 给拆小写入的建议，其余保持原建议", () => {
    expect(describeUnansweredExhausted("unparsed_tool_call", 2)).toContain("拆成多次小改动");
    expect(describeUnansweredExhausted("thinking_only", 2)).toContain("换个更具体的提问方式");
  });
});
