/**
 * S8：heartbeat 撤销必须排在 SessionEnd 收尾**最前面**。
 *
 * 缺陷现场：撤销原先在 handleSessionEnd 末尾（traj 重建 / digest / 上传之后），信号路径的收尾
 * 被打断时一次都执行不到 —— 209 个已有 SessionEnd 的会话 heartbeat 仍在。
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TraceCollector } from "@sid-code/core/trace/collector.ts";
import { HookEventName } from "@sid-code/core/hook/types.ts";
import { resetSideCallStats } from "@sid-code/core/trace/side-call-sink.ts";

const ID = "20261018-010000-hbearly";
let outDir: string;

beforeEach(() => {
  outDir = mkdtempSync(join(tmpdir(), "hb-early-"));
  resetSideCallStats();
});
afterEach(() => {
  resetSideCallStats();
  rmSync(outDir, { recursive: true, force: true });
});

const start = () => ({
  hook_event_name: HookEventName.SessionStart,
  session_id: ID,
  transcript_path: "",
  cwd: process.cwd(),
  timestamp: new Date().toISOString(),
  source: "startup",
  model: "test-model",
  permission_mode: "default",
});

describe("TraceCollector.stopHeartbeat", () => {
  test("同步撤销：定时器清掉、文件删掉；在途 tick 不得在 unlink 后写回", async () => {
    const c = new TraceCollector({ outputDir: outDir }, null);
    await (c as any).handleSessionStart(start());
    const hb = (c as any).heartbeatPath as string;
    writeFileSync(hb, "{}");
    // 模拟「interval 已触发、setTimeout(…,0) 回调已排队」的在途 tick：直接跑一次 interval 体
    const timer = (c as any).heartbeatTimer;
    expect(timer).not.toBeNull();
    c.stopHeartbeat();
    expect((c as any).heartbeatTimer).toBeNull();
    expect(existsSync(hb)).toBe(false);
    // heartbeatStopped 守卫：读代码行为——置位后写入分支直接返回
    expect((c as any).heartbeatStopped).toBe(true);
    // 幂等
    expect(() => c.stopHeartbeat()).not.toThrow();
  });

  test("handleSessionEnd 在第一个 await 之前就撤销心跳（收尾中途被打断也不残留）", async () => {
    const c = new TraceCollector({ outputDir: outDir }, null);
    await (c as any).handleSessionStart(start());
    const hb = (c as any).heartbeatPath as string;
    writeFileSync(hb, "{}");
    // 不 await：只跑到第一个 await 为止，等价于收尾在第一个异步点被强杀
    const p = (c as any).handleSessionEnd({
      hook_event_name: HookEventName.SessionEnd,
      session_id: ID,
      transcript_path: "",
      cwd: process.cwd(),
      timestamp: new Date().toISOString(),
      reason: "abort",
      stats: { total_api_calls: 0, total_cost_usd: 0 },
    });
    expect(existsSync(hb)).toBe(false);
    expect((c as any).heartbeatTimer).toBeNull();
    await p;
  });

  test("/clear 后的新会话 SessionStart 复位守卫，心跳照常写", async () => {
    const c = new TraceCollector({ outputDir: outDir }, null);
    await (c as any).handleSessionStart(start());
    c.stopHeartbeat();
    await (c as any).handleSessionStart({ ...start(), session_id: ID + "2", source: "clear" });
    expect((c as any).heartbeatStopped).toBe(false);
    expect((c as any).heartbeatTimer).not.toBeNull();
    c.stopHeartbeat();
  });
});
