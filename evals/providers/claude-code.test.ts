/**
 * StreamJsonParser 单测
 *
 * 覆盖 claude-code wrapper 解析 stream-json 的几个边界：
 *   - 标准事件序列（assistant + tool_use + result）
 *   - 多个 result 事件（claude CLI 偶尔会发，应取最后一个）
 *   - assistant content 是 string 不是 array（旧版本兼容性）
 *   - tool_use 嵌在 thinking block 后面
 *   - partial JSON line（chunk 切分边界）
 *   - 空行 / 非 JSON 行（应被静默跳过）
 *   - error 事件 / is_error 标记
 *   - 重复同名同 input 工具调用 → retryCount 递增
 *   - 同文件多次 Edit → backtrackCount 递增
 *   - cache_creation / cache_read 计入 totalTokens（公式 v2）
 */

import { describe, test, expect } from "bun:test";
import { StreamJsonParser } from "./claude-code.ts";

function feedAll(parser: StreamJsonParser, lines: string[]) {
  for (const l of lines) parser.feed(l);
  return parser.finalize();
}

describe("StreamJsonParser - 标准路径", () => {
  test("基本 assistant + tool_use + result 流", () => {
    const lines = [
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hello" }] } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "/a.ts" } }] } }),
      JSON.stringify({ type: "result", subtype: "success", result: "final answer", num_turns: 3, total_cost_usd: 0.01, usage: { input_tokens: 100, output_tokens: 50 } }),
    ];
    const meta = feedAll(new StreamJsonParser(), lines);
    expect(meta.text).toBe("final answer");
    expect(meta.toolsUsed).toEqual(["Read"]);
    expect(meta.numTurns).toBe(3);
    expect(meta.totalTokens).toBe(150);
    expect(meta.exitStatus).toBe("success");
    expect(meta.sawResult).toBe(true);
    expect(meta.eventCount).toBe(3);
  });

  test("没有 result 事件 → sawResult=false（健康检查触发）", () => {
    const lines = [
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "incomplete" }] } }),
    ];
    const meta = feedAll(new StreamJsonParser(), lines);
    expect(meta.sawResult).toBe(false);
    expect(meta.text).toBe("incomplete"); // fallback 到 finalTextParts
  });

  test("无 result 时取 finalTextParts 拼接的文本", () => {
    const lines = [
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "part1" }] } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "part2" }] } }),
    ];
    const meta = feedAll(new StreamJsonParser(), lines);
    expect(meta.text).toBe("part1\npart2");
  });
});

describe("StreamJsonParser - 边界情况", () => {
  test("空行 / 非 JSON 行被静默跳过", () => {
    const p = new StreamJsonParser();
    p.feed("");
    p.feed("   ");
    p.feed("not json at all");
    p.feed("[");
    p.feed("]");
    const meta = p.finalize();
    expect(meta.eventCount).toBe(0);
    expect(meta.toolsUsed).toEqual([]);
  });

  test("malformed JSON 不会抛错", () => {
    const p = new StreamJsonParser();
    p.feed('{"type": "assistant", "message": {');  // 截断
    const meta = p.finalize();
    expect(meta.eventCount).toBe(0);
  });

  test("assistant content 是 string 而非 array → 不抛错，跳过", () => {
    const lines = [
      JSON.stringify({ type: "assistant", message: { content: "string-shaped content" } }),
      JSON.stringify({ type: "result", subtype: "success", result: "ok", num_turns: 1, usage: {} }),
    ];
    const meta = feedAll(new StreamJsonParser(), lines);
    expect(meta.text).toBe("ok");
    expect(meta.toolsUsed).toEqual([]);
  });

  test("多个 result 事件 → 后到的覆盖前面的（行业 fact: claude CLI 偶发）", () => {
    const lines = [
      JSON.stringify({ type: "result", subtype: "error", result: "first", num_turns: 1, usage: { input_tokens: 10, output_tokens: 10 } }),
      JSON.stringify({ type: "result", subtype: "success", result: "second", num_turns: 5, usage: { input_tokens: 100, output_tokens: 100 } }),
    ];
    const meta = feedAll(new StreamJsonParser(), lines);
    expect(meta.text).toBe("second");
    expect(meta.numTurns).toBe(5);
    expect(meta.totalTokens).toBe(200);
    expect(meta.exitStatus).toBe("success");
    expect(meta.sawResult).toBe(true);
  });

  test("thinking block 后面跟 tool_use → 都被识别", () => {
    const lines = [
      JSON.stringify({ type: "assistant", message: { content: [
        { type: "thinking", thinking: "let me think" },
        { type: "tool_use", name: "Grep", input: { pattern: "foo" } },
      ] } }),
      JSON.stringify({ type: "result", subtype: "success", result: "ok", num_turns: 1, usage: {} }),
    ];
    const meta = feedAll(new StreamJsonParser(), lines);
    expect(meta.toolsUsed).toEqual(["Grep"]);
  });

  test("partial JSON 不应该被 feed（feed 只接整行）", () => {
    // wrapper 自己负责行切分；feed 只能拿到完整行。
    // 确认：完整一行才算事件
    const p = new StreamJsonParser();
    const fullLine = JSON.stringify({ type: "result", subtype: "success", result: "ok", num_turns: 1, usage: {} });
    p.feed(fullLine);
    const meta = p.finalize();
    expect(meta.sawResult).toBe(true);
  });
});

describe("StreamJsonParser - retry / backtrack 检测", () => {
  test("连续两次同名同 input 工具 → retryCount=1", () => {
    const same = { type: "tool_use", name: "Read", input: { file_path: "/a.ts" } };
    const lines = [
      JSON.stringify({ type: "assistant", message: { content: [same] } }),
      JSON.stringify({ type: "assistant", message: { content: [same] } }),
      JSON.stringify({ type: "result", subtype: "success", result: "ok", num_turns: 2, usage: {} }),
    ];
    const meta = feedAll(new StreamJsonParser(), lines);
    expect(meta.retryCount).toBe(1);
  });

  test("同文件 Edit 两次 → backtrackCount=1", () => {
    const lines = [
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: "/x.ts", old_string: "a", new_string: "b" } }] } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: "/x.ts", old_string: "c", new_string: "d" } }] } }),
      JSON.stringify({ type: "result", subtype: "success", result: "ok", num_turns: 2, usage: {} }),
    ];
    const meta = feedAll(new StreamJsonParser(), lines);
    expect(meta.filesEdited).toEqual(["/x.ts"]);
    expect(meta.backtrackCount).toBe(1);
  });

  test("user tool_result is_error → errorCount 递增", () => {
    const lines = [
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", is_error: true, content: "fail" }] } }),
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", is_error: true, content: "fail2" }] } }),
      JSON.stringify({ type: "result", subtype: "success", result: "ok", num_turns: 1, usage: {} }),
    ];
    const meta = feedAll(new StreamJsonParser(), lines);
    expect(meta.errorCount).toBe(2);
  });
});

describe("StreamJsonParser - token 公式 v2（含 cache）", () => {
  test("4 项 token 全部累加", () => {
    const lines = [
      JSON.stringify({
        type: "result", subtype: "success", result: "ok", num_turns: 1,
        usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 30000, cache_read_input_tokens: 200000 },
      }),
    ];
    const meta = feedAll(new StreamJsonParser(), lines);
    // 100 + 50 + 30000 + 200000 = 230150
    expect(meta.totalTokens).toBe(230150);
  });

  test("缺失字段当 0 处理", () => {
    const lines = [
      JSON.stringify({ type: "result", subtype: "success", result: "ok", num_turns: 1, usage: { input_tokens: 100 } }),
    ];
    const meta = feedAll(new StreamJsonParser(), lines);
    expect(meta.totalTokens).toBe(100);
  });
});

describe("StreamJsonParser - error 路径", () => {
  test("is_error=true → exitStatus=error", () => {
    const lines = [
      JSON.stringify({ type: "result", is_error: true, num_turns: 1, usage: {} }),
    ];
    const meta = feedAll(new StreamJsonParser(), lines);
    expect(meta.exitStatus).toBe("error");
  });

  test("subtype=error → exitStatus=error", () => {
    const lines = [
      JSON.stringify({ type: "result", subtype: "error", num_turns: 1, usage: {} }),
    ];
    const meta = feedAll(new StreamJsonParser(), lines);
    expect(meta.exitStatus).toBe("error");
  });

  test("用户报告的边界: chunk 切在 JSON 中间", () => {
    // 模拟 wrapper 在 stdin 收到 partial chunk → 累加到 stdoutPartial 直到见到 \n
    // feed 只接整行，所以这个测试主要确保：当 wrapper 累加完整后 feed 一行不会出错
    const evt = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "complete" }] } });
    // 模拟 wrapper 累加重组：split 后再 join 还原
    const half1 = evt.slice(0, 30);
    const half2 = evt.slice(30);
    const reassembled = half1 + half2;
    expect(reassembled).toBe(evt);

    const p = new StreamJsonParser();
    p.feed(reassembled);
    const meta = p.finalize();
    expect(meta.text).toBe("complete");
  });
});
