/**
 * 5.2 回归：SSE 逐 chunk 采样落盘（deepseek-reasoning-leak 修复）
 *
 * 验证 SseChunkDumper：
 *   - 默认关闭时零落盘（record/flush 空转）；
 *   - 开启后 flush 出 meta + 采样行；
 *   - **通道切换 chunk（reasoning_content → content）无条件保留**，meta.hasChannelTransition=true
 *     —— 这是定位"思考漂移进正文"的决定性证据；
 *   - 头尾有界 + 中间丢弃计数（控制体积）。
 *
 * fix_type: case_design
 */

import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { readFileSync, existsSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SseChunkDumper } from "@sid-code/core/llm/sse-chunk-dumper.ts";

let tmpHome: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "sse-dump-"));
  saved.SID_CONFIG_DIR = process.env.SID_CONFIG_DIR;
  saved.SID_CODE_DEBUG_SSE_DUMP = process.env.SID_CODE_DEBUG_SSE_DUMP;
  process.env.SID_CONFIG_DIR = tmpHome;
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    rmSync(tmpHome, { recursive: true, force: true });
  } catch {}
});

function dumpFile(sessionId: string, turn: number): string {
  return join(tmpHome, "trajectories", "sse-dumps", sessionId, `turn-${turn}.jsonl`);
}

/** content 通道文本 chunk */
const contentChunk = (t: string) => ({ choices: [{ index: 0, delta: { content: t } }] });
/** reasoning 通道文本 chunk */
const reasoningChunk = (t: string) => ({
  choices: [{ index: 0, delta: { reasoning_content: t } }],
});

describe("SseChunkDumper — 默认关闭", () => {
  test("未设 SID_CODE_DEBUG_SSE_DUMP → 空转，不落盘", () => {
    delete process.env.SID_CODE_DEBUG_SSE_DUMP;
    const d = new SseChunkDumper("sess-off", 1, Date.now());
    expect(d.isEnabled()).toBe(false);
    d.record(contentChunk("x"));
    d.flush();
    expect(existsSync(dumpFile("sess-off", 1))).toBe(false);
  });

  test("开启但无 sessionId → 仍空转", () => {
    process.env.SID_CODE_DEBUG_SSE_DUMP = "1";
    const d = new SseChunkDumper(undefined, 1, Date.now());
    expect(d.isEnabled()).toBe(false);
  });
});

describe("SseChunkDumper — 开启后落盘", () => {
  beforeEach(() => {
    process.env.SID_CODE_DEBUG_SSE_DUMP = "1";
  });

  test("通道切换（reasoning → content）被无条件保留，meta 标记 transition", () => {
    const d = new SseChunkDumper("sess-drift", 9, Date.now());
    expect(d.isEnabled()).toBe(true);
    // 先走 reasoning 通道，再切到 content 通道（模拟第 9 轮思考漂移）
    d.record(reasoningChunk("先想想……"));
    d.record(reasoningChunk("再想想……"));
    d.record(contentChunk("Let me analyze...")); // ← 切换点
    d.record(contentChunk("Wait, hmm..."));
    d.record({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
    d.flush();

    const file = dumpFile("sess-drift", 9);
    expect(existsSync(file)).toBe(true);
    const lines = readFileSync(file, "utf8").trim().split("\n");
    const meta = JSON.parse(lines[0]!);
    expect(meta._meta).toBe(true);
    expect(meta.totalChunks).toBe(5);
    expect(meta.hasChannelTransition).toBe(true);

    const records = lines.slice(1).map((l) => JSON.parse(l));
    // 切换点 chunk（keep=transition）必然在采样里
    const transition = records.find((r) => r.keep === "transition");
    expect(transition).toBeDefined();
    expect(transition.ch).toBe("content");
    // finish chunk 也保留
    expect(records.some((r) => r.keep === "finish")).toBe(true);
  });

  test("头尾有界 + 中间丢弃计数（控制体积）", () => {
    const d = new SseChunkDumper("sess-vol", 1, Date.now());
    // 灌 200 个纯 content chunk（无切换、无 finish）
    for (let i = 0; i < 200; i++) d.record(contentChunk(`chunk-${i}`));
    d.flush();

    const lines = readFileSync(dumpFile("sess-vol", 1), "utf8").trim().split("\n");
    const meta = JSON.parse(lines[0]!);
    expect(meta.totalChunks).toBe(200);
    expect(meta.droppedMiddle).toBeGreaterThan(0);
    // 采样行数远小于 200（头 8 + 尾 12 = 20 左右），证明体积受控
    expect(lines.length - 1).toBeLessThanOrEqual(20);
  });

  test("error chunk 无条件保留", () => {
    const d = new SseChunkDumper("sess-err", 1, Date.now());
    for (let i = 0; i < 30; i++) d.record(contentChunk(`c-${i}`));
    d.record({ error: { message: "上游 429 限流" } });
    d.flush();

    const lines = readFileSync(dumpFile("sess-err", 1), "utf8").trim().split("\n");
    const records = lines.slice(1).map((l) => JSON.parse(l));
    const err = records.find((r) => r.keep === "error");
    expect(err).toBeDefined();
    expect(err.ch).toBe("error");
  });
});
