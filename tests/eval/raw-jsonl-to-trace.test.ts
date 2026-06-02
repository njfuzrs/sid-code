/**
 * raw-jsonl-to-trace.ts 单测（B6-6）
 *
 * 覆盖：
 *  - convertRawJsonlToTrace：response.tool_use → action span / response.text → thought span / request.messages 末尾 user.tool_result → observation span
 *  - tool_input ≤ 8KB 不截 / > 8KB 自动截断 + metadata.truncated=true
 *  - 多行 raw.jsonl：spans 累加，token 累计正确
 *  - billable_tokens 公式 = input + output + cache_creation + cache_read × 0.1
 *  - extractSessionIdFromPath：合法 v4 / 非 v4 / 路径不含 sessions 段
 *  - 转换产物过 validateTrace（spec §5 五条强约束兜底）
 */

import { describe, test, expect } from "bun:test";
import {
  convertRawJsonlToTrace,
  extractSessionIdFromPath,
} from "../../scripts/eval/raw-jsonl-to-trace.ts";
import {
  validateTrace,
  SPAN_FIELD_BYTE_LIMIT,
} from "eval-framework/trace/agent-trace.ts";

const SESSION_UUID = "12345678-1234-4234-8234-123456789012";

function makeRawLine(
  index: number,
  timestamp: string,
  responseContent: unknown[],
  options: {
    requestMessages?: Array<{ role: string; content: unknown }>;
    usage?: Record<string, number>;
    model?: string;
  } = {},
): string {
  return JSON.stringify({
    timestamp,
    index,
    model: options.model ?? "claude-opus-4-7",
    request: {
      model: options.model ?? "claude-opus-4-7",
      messages: options.requestMessages ?? [],
    },
    response: { content: responseContent },
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      ...(options.usage ?? {}),
    },
  });
}

describe("convertRawJsonlToTrace - response 解析", () => {
  test("response.tool_use → 1 个 action span（含 tool_name + tool_input）", () => {
    const raw = makeRawLine(1, "2026-05-31T00:00:00", [
      {
        type: "tool_use",
        id: "tooluse_abc123",
        name: "Read",
        input: { file_path: "/x" },
      },
    ]);
    const trace = convertRawJsonlToTrace(raw, { session_id: SESSION_UUID });
    expect(trace.spans.length).toBe(1);
    const s = trace.spans[0];
    expect(s.span_kind).toBe("action");
    expect(s.tool_name).toBe("Read");
    expect(s.tool_input).toEqual({ file_path: "/x" });
    expect(s.metadata?.tool_use_id).toBe("tooluse_abc123");
    expect(s.role).toBe("assistant");
  });

  test("response.text → 1 个 thought span（含 thought 文本）", () => {
    const raw = makeRawLine(1, "2026-05-31T00:00:00", [
      { type: "text", text: "我先看下文件" },
    ]);
    const trace = convertRawJsonlToTrace(raw, { session_id: SESSION_UUID });
    expect(trace.spans.length).toBe(1);
    expect(trace.spans[0].span_kind).toBe("thought");
    expect(trace.spans[0].thought).toBe("我先看下文件");
  });

  test("空白 text 不生成 thought span（避免噪声）", () => {
    const raw = makeRawLine(1, "2026-05-31T00:00:00", [
      { type: "text", text: "   \n\n  " },
    ]);
    const trace = convertRawJsonlToTrace(raw, { session_id: SESSION_UUID });
    expect(trace.spans.length).toBe(0);
  });

  test("混合 text + tool_use → 2 个 span 顺序：thought 在前 action 在后", () => {
    const raw = makeRawLine(1, "2026-05-31T00:00:00", [
      { type: "text", text: "我要 grep 一下" },
      { type: "tool_use", id: "x", name: "Grep", input: { pattern: "foo" } },
    ]);
    const trace = convertRawJsonlToTrace(raw, { session_id: SESSION_UUID });
    expect(trace.spans.length).toBe(2);
    expect(trace.spans[0].span_kind).toBe("thought");
    expect(trace.spans[1].span_kind).toBe("action");
  });
});

describe("convertRawJsonlToTrace - request.messages 末尾 user.tool_result", () => {
  test("末尾 user.tool_result → observation span", () => {
    const raw = makeRawLine(
      2,
      "2026-05-31T00:00:01",
      [{ type: "text", text: "看到了" }],
      {
        requestMessages: [
          { role: "user", content: "原始用户输入" },
          { role: "assistant", content: [{ type: "text", text: "..." }] },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "tooluse_xyz",
                content: "ok",
                is_error: false,
              },
            ],
          },
        ],
      },
    );
    const trace = convertRawJsonlToTrace(raw, { session_id: SESSION_UUID });
    // observation 在前（来自历史 tool_result），thought 在后（本轮 response.text）
    expect(trace.spans.length).toBe(2);
    expect(trace.spans[0].span_kind).toBe("observation");
    expect(trace.spans[0].is_error).toBe(false);
    expect(trace.spans[0].tool_output).toBe("ok");
    expect(trace.spans[0].metadata?.tool_use_id).toBe("tooluse_xyz");
    expect(trace.spans[1].span_kind).toBe("thought");
  });

  test("is_error=true 时 span_kind 升级为 error", () => {
    const raw = makeRawLine(
      1,
      "2026-05-31T00:00:00",
      [],
      {
        requestMessages: [
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "x",
                content: "permission denied",
                is_error: true,
              },
            ],
          },
        ],
      },
    );
    const trace = convertRawJsonlToTrace(raw, { session_id: SESSION_UUID });
    expect(trace.spans[0].span_kind).toBe("error");
    expect(trace.spans[0].is_error).toBe(true);
  });

  test("tool_result.content 为 array<{type:'text',text}> → 拼接", () => {
    const raw = makeRawLine(
      1,
      "2026-05-31T00:00:00",
      [],
      {
        requestMessages: [
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "x",
                content: [
                  { type: "text", text: "line1" },
                  { type: "text", text: "line2" },
                ],
                is_error: false,
              },
            ],
          },
        ],
      },
    );
    const trace = convertRawJsonlToTrace(raw, { session_id: SESSION_UUID });
    expect(trace.spans[0].tool_output).toContain("line1");
    expect(trace.spans[0].tool_output).toContain("line2");
  });

  test("中间 user message（前面已转过的历史）不被重复转", () => {
    const raw = makeRawLine(
      1,
      "2026-05-31T00:00:00",
      [],
      {
        requestMessages: [
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "older", content: "旧的", is_error: false },
            ],
          },
          { role: "assistant", content: [{ type: "text", text: "..." }] },
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "newer", content: "新的", is_error: false },
            ],
          },
        ],
      },
    );
    const trace = convertRawJsonlToTrace(raw, { session_id: SESSION_UUID });
    // 只有末尾 user.tool_result 转，前面那条不重复
    expect(trace.spans.length).toBe(1);
    expect(trace.spans[0].metadata?.tool_use_id).toBe("newer");
  });
});

describe("convertRawJsonlToTrace - 8KB 截断 + 多行累加", () => {
  test("tool_input 超 8KB → 截断 + metadata.truncated=true（兜底过 §5-2）", () => {
    const huge = { command: "x".repeat(SPAN_FIELD_BYTE_LIMIT * 2) };
    const raw = makeRawLine(1, "2026-05-31T00:00:00", [
      { type: "tool_use", id: "x", name: "Bash", input: huge },
    ]);
    const trace = convertRawJsonlToTrace(raw, { session_id: SESSION_UUID });
    expect(trace.spans[0].metadata?.truncated).toBe(true);
    // 校验通过（说明截断字段不再触发 §5-2）
    expect(validateTrace(trace).ok).toBe(true);
  });

  test("多行 raw.jsonl → spans 顺序累加，按 index 排序", () => {
    const lines = [
      // 故意倒序写入，验证排序逻辑
      makeRawLine(2, "2026-05-31T00:00:02", [{ type: "text", text: "second" }]),
      makeRawLine(1, "2026-05-31T00:00:01", [{ type: "text", text: "first" }]),
    ].join("\n");
    const trace = convertRawJsonlToTrace(lines, { session_id: SESSION_UUID });
    expect(trace.spans[0].thought).toBe("first");
    expect(trace.spans[1].thought).toBe("second");
  });

  test("billable_tokens = input + output + cache_creation + cache_read × 0.1（与 eval-judge gradeCost 对齐）", () => {
    const raw = makeRawLine(1, "2026-05-31T00:00:00", [], {
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 200,
        cache_read_input_tokens: 1000,
      },
    });
    const trace = convertRawJsonlToTrace(raw, { session_id: SESSION_UUID });
    // 100 + 50 + 200 + 100 = 450
    expect(trace.billable_tokens).toBe(450);
    expect(trace.total_input_tokens).toBe(100);
    expect(trace.total_cache_read_tokens).toBe(1000);
  });
});

describe("convertRawJsonlToTrace - 顶层字段 + final_output", () => {
  test("顶层 trace_id 默认 = session_id；可通过 opts 覆盖", () => {
    const raw = makeRawLine(1, "2026-05-31T00:00:00", [{ type: "text", text: "x" }]);
    const t1 = convertRawJsonlToTrace(raw, { session_id: SESSION_UUID });
    expect(t1.trace_id).toBe(SESSION_UUID);
    const t2 = convertRawJsonlToTrace(raw, {
      session_id: SESSION_UUID,
      trace_id: "11111111-1111-4111-8111-111111111111",
    });
    expect(t2.trace_id).toBe("11111111-1111-4111-8111-111111111111");
  });

  test("final_output 取最后一行 response 的 text 块拼接", () => {
    const lines = [
      makeRawLine(1, "2026-05-31T00:00:01", [{ type: "text", text: "中间答案" }]),
      makeRawLine(2, "2026-05-31T00:00:02", [
        { type: "text", text: "最终" },
        { type: "tool_use", id: "x", name: "Bash", input: {} },
      ]),
      makeRawLine(3, "2026-05-31T00:00:03", [{ type: "text", text: "结尾" }]),
    ].join("\n");
    const trace = convertRawJsonlToTrace(lines, { session_id: SESSION_UUID });
    expect(trace.final_output).toBe("结尾");
  });

  test("空 raw.jsonl 抛错", () => {
    expect(() => convertRawJsonlToTrace("", { session_id: SESSION_UUID })).toThrow(/empty/);
    expect(() => convertRawJsonlToTrace("   \n\n", { session_id: SESSION_UUID })).toThrow();
  });

  test("非法 JSON 行抛错并指明行号", () => {
    expect(() => convertRawJsonlToTrace("not json\n", { session_id: SESSION_UUID })).toThrow(/line 1/);
  });
});

describe("convertRawJsonlToTrace - 转换产物过 validateTrace（spec §5 兜底）", () => {
  test("典型场景产物 ok=true", () => {
    const raw = [
      makeRawLine(1, "2026-05-31T00:00:00", [
        { type: "text", text: "我看下" },
        { type: "tool_use", id: "x", name: "Read", input: { p: "/x" } },
      ]),
      makeRawLine(
        2,
        "2026-05-31T00:00:01",
        [{ type: "text", text: "已看完，输出结论" }],
        {
          requestMessages: [
            {
              role: "user",
              content: [
                { type: "tool_result", tool_use_id: "x", content: "file content", is_error: false },
              ],
            },
          ],
          usage: { input_tokens: 50, output_tokens: 20 },
        },
      ),
    ].join("\n");
    const trace = convertRawJsonlToTrace(raw, { session_id: SESSION_UUID });
    const r = validateTrace(trace);
    expect(r.ok).toBe(true);
  });
});

describe("extractSessionIdFromPath", () => {
  test("合法 v4 → 提取", () => {
    const sid = extractSessionIdFromPath(
      "/abs/trajectories/sessions/12345678-1234-4234-8234-123456789012/raw.jsonl",
    );
    expect(sid).toBe("12345678-1234-4234-8234-123456789012");
  });

  test("非 v4（v3 等）→ null", () => {
    const sid = extractSessionIdFromPath(
      "/abs/trajectories/sessions/12345678-1234-3234-8234-123456789012/raw.jsonl",
    );
    expect(sid).toBeNull();
  });

  test("路径不含 sessions 段 → null", () => {
    const sid = extractSessionIdFromPath("/abs/raw.jsonl");
    expect(sid).toBeNull();
  });
});
