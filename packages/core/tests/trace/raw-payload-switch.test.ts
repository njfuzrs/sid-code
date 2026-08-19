/**
 * raw.jsonl 内容开关（P2 · 「不落 prompt 原文」的企业诉求）
 *
 * 核心断言是**开关的边界正确**，而不是"能关掉"：
 * raw.jsonl 里有两种记录，关错一种会打断会话续接的 index 连续性。
 *
 * | 记录 | 内容 | 关掉后 |
 * |---|---|---|
 * | `request_sent` 计数行 | 无原文 | **必须保留** —— `countExistingPairs` 靠数非 type 行续接 index |
 * | 完整 pair | system prompt + messages + tools + 响应全文 | 必须消失 |
 *
 * 落盘隔离：全部写 tmpdir，不碰真实 `~/.sid-code/`。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { TraceWriter } from "@sid-code/core/trace/writer.ts";
import { resolveRecordRawPayloads } from "@sid-code/core/trace/collector.ts";

let baseDir: string;
let savedEnv: string | undefined;

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), "sid-raw-switch-"));
  // 存原值而不是无条件 delete：同批多文件跑在同一进程里，
  // 直接删会把 preload 的落盘兜底一起抹掉。
  savedEnv = process.env.SID_CODE_TRACE_NO_RAW;
});

afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
  if (savedEnv === undefined) delete process.env.SID_CODE_TRACE_NO_RAW;
  else process.env.SID_CODE_TRACE_NO_RAW = savedEnv;
});

const rawPath = (sid: string) => join(baseDir, "sessions", sid, "raw.jsonl");
const rawLines = (sid: string): Array<Record<string, unknown>> => {
  const p = rawPath(sid);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
};

/** 一份含"原文"的最小 pair（字段名与 RawJsonlEntry 对齐即可） */
const pair = () =>
  ({
    timestamp: "2026-08-19T00:00:00.000Z",
    index: 1,
    request: { model: "m", system: "你是一个助手（这是 system prompt 原文）" },
    response: { content: "响应全文" },
  }) as never;

describe("resolveRecordRawPayloads 优先级", () => {
  test("默认开（不配置、不设 env）", () => {
    delete process.env.SID_CODE_TRACE_NO_RAW;
    expect(resolveRecordRawPayloads(undefined)).toBe(true);
  });

  test("env=1 → 关（反向开关：设了才关）", () => {
    process.env.SID_CODE_TRACE_NO_RAW = "1";
    expect(resolveRecordRawPayloads(undefined)).toBe(false);
  });

  test("env 为 0 / 空串 / 其它值 → 仍然开（只认字面 '1'）", () => {
    for (const v of ["0", "", "true", "no"]) {
      process.env.SID_CODE_TRACE_NO_RAW = v;
      expect(resolveRecordRawPayloads(undefined)).toBe(true);
    }
  });

  test("显式配置优先于 env（两个方向都要验）", () => {
    process.env.SID_CODE_TRACE_NO_RAW = "1";
    expect(resolveRecordRawPayloads(true)).toBe(true);
    delete process.env.SID_CODE_TRACE_NO_RAW;
    expect(resolveRecordRawPayloads(false)).toBe(false);
  });
});

describe("TraceWriter 的 raw 内容开关", () => {
  test("默认（两参构造，兼容既有调用点与测试）仍然写原文", () => {
    const w = new TraceWriter(baseDir, "s-default");
    expect(w.isRecordingRawPayloads()).toBe(true);
    w.appendRaw(pair());
    expect(rawLines("s-default").length).toBe(1);
  });

  test("显式 undefined 不得击穿默认值", () => {
    const w = new TraceWriter(baseDir, "s-undef", { recordRawPayloads: undefined });
    expect(w.isRecordingRawPayloads()).toBe(true);
  });

  test("关闭后 appendRaw 不落任何原文", () => {
    const w = new TraceWriter(baseDir, "s-off", { recordRawPayloads: false });
    w.appendRaw(pair());
    const content = existsSync(rawPath("s-off")) ? readFileSync(rawPath("s-off"), "utf8") : "";
    expect(content).not.toContain("system prompt 原文");
    expect(content).not.toContain("响应全文");
    expect(rawLines("s-off").length).toBe(0);
  });

  test("★ 关闭后 request_sent 计数行仍要写（否则会话续接 index 会重号）", () => {
    // countExistingPairs 数的是「没有 type 字段的行」来续接 index；
    // 唯一的回退路是 metadata.json，而那个文件**只有 uploader 会写** ——
    // 没配上传的用户把这行也关掉，续接就从 1 重号、与远端历史冲突。
    const w = new TraceWriter(baseDir, "s-marker", { recordRawPayloads: false });
    w.appendRawJsonl(
      JSON.stringify({ timestamp: "t", index: 1, type: "request_sent", model: "m", msg_count: 3 }),
    );
    w.appendRaw(pair());

    const lines = rawLines("s-marker");
    expect(lines.length).toBe(1);
    expect(lines[0].type).toBe("request_sent");
    // 计数行本身不含任何 prompt 内容，所以留着不违反"不落原文"
    expect(JSON.stringify(lines[0])).not.toContain("原文");
  });

  test("开关不影响其它文件（只关 raw 内容，不是关整个 trace）", async () => {
    const w = new TraceWriter(baseDir, "s-others", { recordRawPayloads: false });
    w.appendEvent({ event: "SessionStart", session_id: "s-others", timestamp: "t" } as never);
    await w.writeSessionTraj(JSON.stringify({ info: {} }));

    expect(existsSync(join(baseDir, "sessions", "s-others", "events.jsonl"))).toBe(true);
    expect(existsSync(join(baseDir, "sessions", "s-others", "session.traj"))).toBe(true);
  });
});
