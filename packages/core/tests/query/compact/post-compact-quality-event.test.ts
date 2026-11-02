/**
 * 压缩摘要覆盖率改落 `CompactQuality` 轨迹事件
 *
 * 原先写 `<sessionDir>/compact-quality.jsonl`，而 sessionDir 在 `/tmp` 下，
 * 2026-11-02 核到写过的 23 次全部已被清掉。现在经 `traceAppendEvent` 落 events.jsonl。
 */
import { describe, it, expect } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runPostCompact } from "../../../src/query/compact/post-compact.ts";
import type { Message } from "../../../src/llm/types.ts";

type Event = { event: string; timestamp: string; data?: Record<string, unknown> };

function fakeCtxMgr() {
  return {
    estimateTokens: () => 50_000,
    getMaxTokens: () => 200_000,
    getCompactionLevel: () => "none",
    appendReattachMessages: () => {},
    messageCount: () => 6,
  } as any;
}

const original: Message[] = [
  {
    role: "assistant",
    content: [
      { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/r/src/hook/runner.ts" } },
      { type: "tool_use", id: "t2", name: "Read", input: { file_path: "/r/src/hook/planner.ts" } },
    ],
  } as unknown as Message,
];

describe("runPostCompact 落 CompactQuality 事件", () => {
  it("有原文 + 摘要配对 → 落一条，字段齐全", async () => {
    const events: Event[] = [];
    await runPostCompact({
      trigger: "auto",
      ctxMgr: fakeCtxMgr(),
      messagesBefore: 20,
      tokensBefore: 180_000,
      usedLLM: true,
      originalMessages: original,
      summary: "已读 runner.ts，planner.ts 尚未读。",
      traceAppendEvent: (e) => events.push(e),
    });
    const q = events.filter((e) => e.event === "CompactQuality");
    expect(q).toHaveLength(1);
    expect(q[0].data).toEqual({
      trigger: "auto",
      usedLLM: true,
      totalAnchors: 2,
      coveredAnchors: 2,
      coverage: 1,
      matchedBy: { exact: 0, relative: 0, basename: 2 },
      missedSamples: [],
    });
  });

  it("无摘要配对（reactive / collapse 路径）→ 不落（不造一个假的 0）", async () => {
    const events: Event[] = [];
    await runPostCompact({
      trigger: "reactive",
      ctxMgr: fakeCtxMgr(),
      messagesBefore: 20,
      tokensBefore: 180_000,
      usedLLM: false,
      traceAppendEvent: (e) => events.push(e),
    });
    expect(events.filter((e) => e.event === "CompactQuality")).toHaveLength(0);
  });

  it("传了 sessionDir 也不再往里写 compact-quality.jsonl", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sid-compact-quality-"));
    try {
      await runPostCompact({
        trigger: "manual",
        ctxMgr: fakeCtxMgr(),
        sessionDir: dir,
        messagesBefore: 20,
        tokensBefore: 180_000,
        usedLLM: true,
        originalMessages: original,
        summary: "runner.ts",
      });
      expect(existsSync(join(dir, "compact-quality.jsonl"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
