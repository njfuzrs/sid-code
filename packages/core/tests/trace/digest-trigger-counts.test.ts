/**
 * T5：digest「触发计数」一节 —— bridge 部分（`bridge_inbound`）
 *
 * 断言的重点不是「函数能跑」，而是两条口径：
 *  1. **没有 bridge 事件时整节不出现**（返回 undefined，不是 `bridge_inbound: 0`）——
 *     否则「没被遥控过」与「这套埋点还没接线」会混成同一个数；
 *  2. 计数只算 `kind=user_message`（去重后的远程用户消息），
 *     `permission_response` / `control:abort` 不能混进同一个分子。
 *
 * 之所以连 `renderHuman` 一起断言：`buildDigest` 算对了但渲染层漏读，
 * 产物里照样看不到这一节，而没有任何东西会变红。
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  resolvePaths,
  listSessions,
  buildDigest,
  renderHuman,
  aggregateTriggerCountsStats,
  type DigestPaths,
} from "@sid-code/core/trace/digest.ts";

let root: string;
let paths: DigestPaths;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sid-triggerdigest-"));
  mkdirSync(join(root, "trajectories", "sessions"), { recursive: true });
  paths = resolvePaths(root);
});

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

/** 造一条会话（含最小 session.traj，buildDigest 需要它判定会话可读） */
function writeSessionWithEvents(id: string, events: unknown[]) {
  const dir = join(root, "trajectories", "sessions", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "session.traj"),
    JSON.stringify({
      trajectory: [
        { message_type: "action", role: "assistant", tool_name: "read", tool_input: {} },
      ],
      info: { exit_status: "submitted" },
    }),
  );
  writeFileSync(join(dir, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return dir;
}

describe("aggregateTriggerCountsStats 口径", () => {
  it("没有任何 bridge 事件 → undefined（不产出 bridge_inbound=0）", () => {
    expect(aggregateTriggerCountsStats([])).toBeUndefined();
    expect(
      aggregateTriggerCountsStats([
        { event: "SessionEnd", data: {} },
        { event: "PermissionDecision", data: { source: "user" } },
      ]),
    ).toBeUndefined();
  });

  it("只有 BridgeSession（连上但没收到消息）→ 0，与「没接线」区分开", () => {
    expect(
      aggregateTriggerCountsStats([
        { event: "BridgeSession", data: { phase: "connected" } },
        { event: "BridgeSession", data: { phase: "stopped" } },
      ]),
    ).toEqual({ bridgeInbound: 0 });
  });

  it("只数 kind=user_message；permission_response / abort 不混进同一个分子", () => {
    const stats = aggregateTriggerCountsStats([
      { event: "BridgeSession", data: { phase: "connected" } },
      { event: "BridgeInbound", data: { kind: "user_message", text_len: 12 } },
      { event: "BridgeInbound", data: { kind: "user_message", text_len: 3 } },
      { event: "BridgeInbound", data: { kind: "permission_response" } },
      { event: "BridgeInbound", data: { kind: "control:abort" } },
      { event: "BridgePermission", data: { decision: "allow", wait_ms: 900 } },
    ]);
    expect(stats).toEqual({ bridgeInbound: 2 });
  });
});

describe("digest 触发计数渲染", () => {
  it("有 bridge 事件时输出一节「触发计数: bridge_inbound=N」", () => {
    writeSessionWithEvents("bridgerender1", [
      { event: "BridgeSession", data: { phase: "connected" } },
      { event: "BridgeInbound", data: { kind: "user_message", text_len: 5 } },
      { event: "BridgeInbound", data: { kind: "user_message", text_len: 8 } },
      { event: "BridgeSession", data: { phase: "stopped", inbound_messages: 2 } },
    ]);
    const d = buildDigest(listSessions(paths)[0], false, paths)!;
    expect(d.triggerCounts).toEqual({ bridgeInbound: 2 });

    const out = renderHuman(d, { noColor: true });
    expect(out).toContain("触发计数:");
    expect(out).toContain("bridge_inbound=2");
  });

  it("无 bridge 事件时不出现这一节（普通本地会话不凭空多出一行 0）", () => {
    writeSessionWithEvents("bridgerender2", [{ event: "SessionEnd", data: {} }]);
    const d = buildDigest(listSessions(paths)[0], false, paths)!;
    expect(d.triggerCounts).toBeUndefined();
    expect(renderHuman(d, { noColor: true })).not.toContain("触发计数:");
  });
});
