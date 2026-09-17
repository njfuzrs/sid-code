/**
 * 回归 · 空壳清理后不得留下「幽灵目录」
 *
 * 缺陷形态（2026-09-16 实测，SIGHUP 修复后暴露）：
 * `cleanupIfBlankSession()` 删掉空壳会话目录后 return，但 side-call 观察者
 * （标题生成/记忆召回等辅助调用落定时触发）仍会调 `forceRebuildTraj()` →
 * 落盘走 `Bun.write()`，而**它会自动创建缺失的父目录** → 盘上重新冒出一个
 * 只含 `session.traj`、没有 `events.jsonl` 的目录。
 *
 * 实测证据：同一路径的 inode 从 102766900 变成 102766946 —— 目录是删掉又重建的，
 * 不是「没删成功」。
 *
 * 后果有两层，都很脏：
 *   1. 启动清理 `pruneStaleBlankSessions()` 放它过（IGNORABLE_FILES 只含
 *      events/warn/heartbeat，见到 `session.traj` 就判「有数据，保留」）→ 永久堆积；
 *   2. 启动补传会把它当正经会话传上云 —— 正是空壳判定想剔除的噪音。
 *
 * 这个坑在 SIGHUP 修复之前基本碰不到：那时 handleSessionEnd 根本跑不到空壳判定
 * （实测 52 个会话里 39 个连 SessionEnd 都没触发）。修好一处让下一处显形，
 * 所以这条回归必须钉住。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TraceCollector } from "@sid-code/core/trace/collector.ts";
import { HookEventName } from "@sid-code/core/hook/types.ts";
import { recordSideCall, resetSideCallStats } from "@sid-code/core/trace/side-call-sink.ts";

let outDir: string;

beforeEach(() => {
  outDir = mkdtempSync(join(tmpdir(), "ghost-dir-"));
  resetSideCallStats();
});

afterEach(() => {
  resetSideCallStats();
  if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
});

const SESSION_ID = "20260916-000000-ghosttest";

async function startSession(collector: TraceCollector): Promise<void> {
  await (collector as any).handleSessionStart({
    hook_event_name: HookEventName.SessionStart,
    session_id: SESSION_ID,
    transcript_path: "",
    cwd: process.cwd(),
    timestamp: new Date().toISOString(),
    source: "startup",
    model: "test-model",
    permission_mode: "default",
  });
}

async function endSession(collector: TraceCollector): Promise<void> {
  await (collector as any).handleSessionEnd({
    hook_event_name: HookEventName.SessionEnd,
    session_id: SESSION_ID,
    transcript_path: "",
    cwd: process.cwd(),
    timestamp: new Date().toISOString(),
    reason: "abort",
    stats: { total_api_calls: 0 },
  });
}

function sessionDirs(): string[] {
  const base = join(outDir, "sessions");
  if (!existsSync(base)) return [];
  return readdirSync(base, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
}

describe("空壳清理后的幽灵目录", () => {
  test("空壳会话在 SessionEnd 后目录被删除", async () => {
    const collector = new TraceCollector({ outputDir: outDir }, null);
    await startSession(collector);
    await endSession(collector);
    expect(sessionDirs()).not.toContain(SESSION_ID);
  });

  test("清理后 side-call 落定不得重建目录（核心回归）", async () => {
    const collector = new TraceCollector({ outputDir: outDir }, null);
    await startSession(collector);
    await endSession(collector);
    expect(sessionDirs()).not.toContain(SESSION_ID);

    // 模拟标题生成这类 fire-and-forget 辅助调用在 SessionEnd 之后才落定 ——
    // 修复前这一步会让 Bun.write 把目录重建成只含 session.traj 的幽灵目录。
    recordSideCall({
      kind: "title",
      model: "test-model",
      usage: { input_tokens: 10, output_tokens: 5 },
    } as any);
    // 给 void forceRebuildTraj() 的微任务/IO 留出时间
    await new Promise((r) => setTimeout(r, 150));

    expect(sessionDirs()).not.toContain(SESSION_ID);
    expect(existsSync(join(outDir, "sessions", SESSION_ID, "session.traj"))).toBe(false);
  });

  test("非空壳会话不受影响：目录与 traj 正常保留", async () => {
    const collector = new TraceCollector({ outputDir: outDir }, null);
    await startSession(collector);
    // 造一轮真实往返，使 isBlankSession() 为 false
    (collector as any).pairs.push({
      index: 1,
      request: { model: "test-model", messages: [] },
      response: { content: [{ type: "text", text: "hi" }], stop_reason: "end_turn" },
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      stop_reason: "end_turn",
    });
    (collector as any).metadata.total_api_calls = 1;

    await (collector as any).handleSessionEnd({
      hook_event_name: HookEventName.SessionEnd,
      session_id: SESSION_ID,
      transcript_path: "",
      cwd: process.cwd(),
      timestamp: new Date().toISOString(),
      reason: "abort",
      stats: { total_api_calls: 1 },
    });

    expect(sessionDirs()).toContain(SESSION_ID);
    expect(existsSync(join(outDir, "sessions", SESSION_ID, "session.traj"))).toBe(true);
  });
});
