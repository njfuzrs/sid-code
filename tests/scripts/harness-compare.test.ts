/**
 * scripts/harness-compare.ts 口径测试
 *
 * 防三类静默错：
 * 1. sid-code raw.jsonl 的 request_sent 预写行被当成调用（调用数翻倍、命中率分母不变但行数错）；
 * 2. 标题 / recap / 子代理调用混进 main，命中率被非任务调用稀释；
 * 3. CC 计费头块进了 system_hash，制造出「system 每轮都变」的假失效。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DYNAMIC_BOUNDARY } from "../../packages/core/src/api/cache-strategy.ts";
import {
  parseSidSession,
  parseCcSession,
  summarize,
  sidWireSystemBlocks,
  ccSystemHash,
  classifyCcCaller,
  toTsv,
} from "../../scripts/harness-compare.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sid-harness-compare-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeJsonl(path: string, rows: unknown[]): void {
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

const u = (cr: number, cw: number, inp: number, out = 1) => ({
  cache_read_input_tokens: cr,
  cache_creation_input_tokens: cw,
  input_tokens: inp,
  output_tokens: out,
});

function plantSid(): string {
  const d = join(dir, "sid");
  mkdirSync(d);
  writeJsonl(join(d, "raw.jsonl"), [
    { type: "request_sent", index: 1, timestamp: "t0", msg_count: 1 },
    {
      index: 1,
      timestamp: "t0",
      ended_at: "t1",
      elapsed_ms: 10,
      request: {
        system: `静态区${DYNAMIC_BOUNDARY}动态`,
        tools: [{ name: "read" }, { name: "bash" }],
        new_messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      },
      response: { content: [{ type: "tool_use" }, { type: "tool_use" }] },
      usage: u(0, 100, 10),
      stop_reason: "tool_use",
    },
    { type: "request_sent", index: 2, timestamp: "t1" },
    {
      index: 2,
      timestamp: "t1",
      ended_at: "t2",
      request: {
        new_messages: [
          { role: "assistant", content: [{ type: "tool_use" }] },
          { role: "user", content: [{ type: "tool_result", content: "abcde" }] },
        ],
      },
      response: { content: [{ type: "text", text: "done" }] },
      usage: u(100, 0, 0),
      stop_reason: "end_turn",
    },
  ]);
  writeJsonl(join(d, "events.jsonl"), [
    {
      event: "BilledRequest",
      timestamp: "t9",
      data: { index: 900001, caller: "title_generation", input_tokens: 5 },
    },
    {
      event: "BilledRequest",
      timestamp: "t9",
      data: {
        index: 1,
        caller: "agent:builtin",
        agent_id: "sub-x",
        cache_read_tokens: 999,
        input_tokens: 1,
      },
    },
    // 主代理的计费事件已由 raw.jsonl 覆盖，不能重复计入
    { event: "BilledRequest", timestamp: "t1", data: { index: 1, input_tokens: 10 } },
  ]);
  return d;
}

function plantCc(): string {
  const d = join(dir, "cc");
  mkdirSync(d);
  const sys = (ver: string) => [
    { type: "text", text: `x-anthropic-billing-header: cc_version=${ver}` },
    { type: "text", text: "You are Claude Code" },
  ];
  writeJsonl(join(d, "raw.jsonl"), [
    {
      index: 1,
      timestamp: "a",
      request: {
        system: sys("2d1"),
        tools: [],
        output_config: { format: { type: "json_schema" } },
        messages: [],
      },
      usage: u(0, 10, 10),
      stop_reason: "end_turn",
    },
    {
      index: 2,
      timestamp: "b",
      request: {
        system: sys("88c"),
        tools: [{ name: "Bash" }],
        new_messages: [{ role: "user", content: [{ type: "text", text: "task" }] }],
      },
      response: { content: [{ type: "tool_use" }] },
      usage: { ...u(30, 70, 0), cache_creation: { ephemeral_5m_input_tokens: 70 } },
      stop_reason: "tool_use",
    },
    {
      index: 3,
      timestamp: "c",
      request: {
        system: sys("88c"),
        tools: [{ name: "Bash" }],
        new_messages: [
          { role: "user", content: "The user stepped away and is coming back. Recap" },
        ],
      },
      usage: u(5000, 0, 0),
      stop_reason: "end_turn",
    },
  ]);
  return d;
}

describe("sid-code 解析", () => {
  test("跳过 request_sent 预写行，主调用只来自 raw.jsonl 的 pair 行", () => {
    const rows = parseSidSession(plantSid(), "s");
    const main = rows.filter((r) => r.caller === "main");
    expect(main.map((r) => r.call_index)).toEqual([1, 2]);
    expect(rows.filter((r) => r.caller === "title")).toHaveLength(1);
    expect(rows.filter((r) => r.caller === "subagent")[0]?.agent_id).toBe("sub-x");
    // 无 caller 的 BilledRequest 不重复计入
    expect(rows).toHaveLength(4);
  });

  test("首行记 system/tools，后续行是 null（没记），不是 0", () => {
    const [first, second] = parseSidSession(plantSid(), "s");
    expect(first.tools_count).toBe(2);
    expect(first.system_blocks).toBe(`3/2`);
    expect(first.tool_use_count).toBe(2);
    expect(second.tools_count).toBeNull();
    expect(second.system_hash).toBeNull();
    expect(second.tool_result_chars).toBe(5);
    expect(second.new_msg_kinds).toBe("assistant:tool_use=1,user:tool_result=1");
  });

  test("wire 分块按 DYNAMIC_BOUNDARY 还原", () => {
    expect(sidWireSystemBlocks(`ab${DYNAMIC_BOUNDARY}cde`)).toEqual([2, 3]);
    expect(sidWireSystemBlocks("abc")).toEqual([3]);
    expect(sidWireSystemBlocks(undefined)).toBeNull();
  });

  test("命中率只算 main、用累计值：子代理的 999 cache_read 不进分子", () => {
    const s = summarize("sid-code", parseSidSession(plantSid(), "s"));
    // Σcr=100, Σcw=100, Σin=10
    expect(s.main_hit_rate).toBeCloseTo(100 / 210, 6);
    expect(s.first_main_total_input).toBe(110);
    expect(s.calls_by_caller).toEqual({ main: 2, title: 1, subagent: 1 });
  });
});

describe("Claude Code 解析", () => {
  test("标题与 recap 调用按请求形态识别，不进 main", () => {
    const rows = parseCcSession(plantCc(), "s");
    expect(rows.map((r) => r.caller)).toEqual(["title", "main", "recap"]);
    const s = summarize("claude-code", rows);
    // recap 的 5000 cache_read 若混进 main，命中率会被抬到 >0.9
    expect(s.main_hit_rate).toBeCloseTo(0.3, 6);
    expect(s.first_main_total_input).toBe(100);
  });

  test("计费头带 cc_is_subagent=true 的调用判成 subagent，不进 main", () => {
    // 子代理请求形态与主代理相同（有 tools），只靠形态判会落进 main（对比 README 更正 X3）
    const req = (head: string) => ({
      system: [
        { type: "text", text: head },
        { type: "text", text: "You are an agent" },
      ],
      tools: [{ name: "Read" }],
      new_messages: [{ role: "user", content: [{ type: "text", text: "读文件" }] }],
    });
    expect(
      classifyCcCaller(
        req(
          "x-anthropic-billing-header: cc_version=2.1.310.498; cc_entrypoint=sdk-cli; cc_is_subagent=true;",
        ),
      ),
    ).toBe("subagent");
    expect(
      classifyCcCaller(
        req("x-anthropic-billing-header: cc_version=2.1.310.498; cc_entrypoint=sdk-cli;"),
      ),
    ).toBe("main");
    // 只认计费头块，正文里出现同样字样不算
    expect(
      classifyCcCaller({
        system: [
          { type: "text", text: "x-anthropic-billing-header: cc_version=1;" },
          { type: "text", text: "cc_is_subagent=true" },
        ],
        tools: [{ name: "Read" }],
      }),
    ).toBe("main");
  });

  test("system_hash 剔除计费头：只有版本后缀不同的两条 system hash 相同", () => {
    const rows = parseCcSession(plantCc(), "s");
    expect(rows[0].system_hash).toBe(rows[1].system_hash);
    expect(ccSystemHash([{ text: "x-anthropic-billing-header: a" }, { text: "A" }])).not.toBe(
      ccSystemHash([{ text: "x-anthropic-billing-header: a" }, { text: "B" }]),
    );
  });

  test("returned_ts 恒为 null（claude-trace 不记返回时刻），5m 分档透传", () => {
    const main = parseCcSession(plantCc(), "s")[1];
    expect(main.returned_ts).toBeNull();
    expect(main.cache_write_5m).toBe(70);
    expect(main.cache_write_1h).toBeNull();
  });
});

test("TSV：null 输出为空格子，列数每行一致", () => {
  const rows = [...parseSidSession(plantSid(), "s"), ...parseCcSession(plantCc(), "s")];
  const lines = toTsv(rows).trim().split("\n");
  const width = lines[0].split("\t").length;
  for (const l of lines) expect(l.split("\t").length).toBe(width);
  expect(lines).toHaveLength(rows.length + 1);
});
