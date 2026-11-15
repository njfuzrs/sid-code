/**
 * 验收取数脚本的纯函数测试。
 *
 * 为什么这个脚本需要测试：它算出来的数字会直接写进方案文档的验收表，
 * 而第一版就踩过两个「全绿但数是错的」的坑 ——
 * ① `raw.jsonl` 的 response 行没有 `type` 字段，按 `type === "response"` 判会导致三项验收全部「样本不足」；
 * ② V4-3 的分母写成 read 结果字符，而方案附录的口径是全部工具结果字符。
 * 这两条都在下面钉成断言。
 */

import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  classifyEra,
  computeRereadShare,
  computeToolResultShare,
  quantile,
  readSession,
  buildReport,
  verdicts,
} from "../../scripts/verify-context-budget-acceptance.ts";
import type { Message } from "@sid-code/core/llm/types.ts";

describe("quantile", () => {
  test("空数组 → undefined（不能返回 0，否则「样本不足」会被判成 0）", () => {
    expect(quantile([], 0.5)).toBeUndefined();
  });

  test("单元素 / 中位数 / p90 按线性插值", () => {
    expect(quantile([7], 0.5)).toBe(7);
    expect(quantile([1, 2, 3], 0.5)).toBe(2);
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([0, 10], 0.9)).toBeCloseTo(9, 6);
  });
});

describe("classifyEra", () => {
  const req = (maxTokens?: number) => ({ index: 0, maxTokens });

  test("全部 ≤ 默认预算 → 修复后", () => {
    expect(classifyEra([req(32768), req(8192), req(32768)])).toBe("post-fix");
  });

  test("全部 ≥ 384,000 → 修复前", () => {
    expect(classifyEra([req(384000), req(384000)])).toBe("pre-fix");
  });

  test("有请求但一个 max_tokens 都没有 → 修复前（老轨迹没有该字段，不是「无法判定」）", () => {
    // 这是关键回归：F1 才把 max_tokens 写进 raw.jsonl，修复前的 324 次请求全是 undefined。
    // 第一版把它判成 unknown，导致修复前样本只剩 8 个。
    expect(classifyEra([req(undefined), req(undefined)])).toBe("pre-fix");
  });

  test("没有任何请求 → unknown", () => {
    expect(classifyEra([])).toBe("unknown");
  });

  test("两种预算混在一个会话 → mixed（横跨升级，两边都不计）", () => {
    expect(classifyEra([req(384000), req(32768)])).toBe("mixed");
  });
});

describe("computeToolResultShare（V4-1 方案附录口径）", () => {
  function history(toolChars: number, textChars: number): Message[] {
    return [
      { role: "user", content: [{ type: "text", text: "x".repeat(textChars) }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "read", input: { file_path: "a.ts" } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "y".repeat(toolChars) }],
      },
    ];
  }

  test("占比按 growth 摊回峰值，不是「字符占全部消息的比例」", () => {
    // allChars = text 100 + tool_use 的 JSON(`{"file_path":"a.ts"}`) 20 + tool_result 300 = 420
    // growth = 10,000 − 1,000 = 9,000
    // tool token ≈ 9,000 × (300/420) = 6,428.57；÷ peak 10,000 = 64.29%
    // 若实现退回「字符占全部消息」(300/420 = 71.4%)，这里会算出 0.714 而不是 0.6429。
    const s = computeToolResultShare(history(300, 100), 10_000, 1_000);
    expect(s.before).toBeCloseTo(0.642857, 4);
    expect(s.before).not.toBeCloseTo(300 / 420, 3);
  });

  test("peak 等于 first（没有增长）→ 0，不是 NaN", () => {
    const s = computeToolResultShare(history(300, 100), 1_000, 1_000);
    expect(s.before).toBe(0);
    expect(Number.isNaN(s.before)).toBe(false);
  });

  test("工具结果条数如实计数（用于核对「清理命中率」的分母）", () => {
    expect(computeToolResultShare(history(10, 10), 100, 10).toolResults).toBe(1);
  });
});

describe("computeRereadShare（V4-3 方案附录口径）", () => {
  function twoReads(sameFile: boolean): Message[] {
    const second = sameFile ? "a.ts" : "b.ts";
    return [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "read", input: { file_path: "a.ts" } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "x".repeat(100) }],
      },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t2", name: "read", input: { file_path: second } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t2", content: "y".repeat(100) }],
      },
    ];
  }

  test("第二次读同一文件 → 计入重复读", () => {
    const r = computeRereadShare(twoReads(true));
    expect(r.rereadChars).toBe(100);
    expect(r.rereadCalls).toBe(1);
  });

  test("读不同文件 → 不计重复", () => {
    expect(computeRereadShare(twoReads(false)).rereadCalls).toBe(0);
  });

  test("分母是**全部工具结果**字符，不是 read 字符（与基线 9.8% 同尺子）", () => {
    // 两条 read 各 100 字符，其中一条重复 → 分子 100 / 分母 200 = 50%
    const r = computeRereadShare(twoReads(true));
    expect(r.ratio).toBeCloseTo(0.5, 6);
    expect(r.allToolChars).toBe(200);
  });
});

describe("readSession：raw.jsonl 的实际格式", () => {
  test("response 行没有 type 字段也必须被读到（否则 V1-2/V2-2/V2-3 全空）", () => {
    const dir = mkdtempSync(join(tmpdir(), "vcb-"));
    try {
      const raw = [
        JSON.stringify({
          type: "request_sent",
          index: 1,
          max_tokens: 32768,
          estimated_input_tokens: 1200,
          model: "m",
        }),
        // ⚠️ 真实格式：没有 type，只有 index/usage/stop_reason
        JSON.stringify({
          index: 1,
          stop_reason: "stop",
          usage: { input_tokens: 1300, output_tokens: 200 },
        }),
      ].join("\n");
      writeFileSync(join(dir, "raw.jsonl"), raw);
      const s = readSession(dir, "t");
      expect(s).toBeDefined();
      expect(s!.requests).toHaveLength(1);
      expect(s!.requests[0].maxTokens).toBe(32768);
      expect(s!.requests[0].inputTokens).toBe(1300);
      expect(s!.requests[0].outputTokens).toBe(200);
      expect(s!.requests[0].stopReason).toBe("stop");
      expect(s!.era).toBe("post-fix");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("没有 raw.jsonl 的目录返回 undefined（不猜一个空会话）", () => {
    const dir = mkdtempSync(join(tmpdir(), "vcb-"));
    try {
      expect(readSession(dir, "t")).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("buildReport / verdicts：样本不足必须给 undefined，不能默认通过", () => {
  test("空输入 → 六项全部无 pass 判定", () => {
    const r = buildReport([]);
    const vs = verdicts(r);
    expect(vs).toHaveLength(6);
    for (const v of vs) expect(v.pass).toBeUndefined();
  });
});
