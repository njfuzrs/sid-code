/**
 * digest：未收尾的 PreToolUse 机械计数（2026-10-24）。
 *
 * 全库扫描 23,654 个 PreToolUse 里 7 个永远等不到 Post*，可核的 5 个全是串行 Bash 级联跳过。
 * 收尾路径会随特性继续增加，单测写一条漏一条，所以 digest 每次都数一遍，回归就亮。
 *
 * 落盘隔离：全程 resolvePaths(tmpdir)，不碰 ~/.sid-code。
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { resolvePaths, buildDigest, type DigestPaths } from "@sid-code/core/trace/digest.ts";

let root: string;
let paths: DigestPaths;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sid-digest-unclosed-"));
  mkdirSync(join(root, "trajectories", "sessions"), { recursive: true });
  paths = resolvePaths(root);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const ev = (event: string, data: Record<string, unknown> = {}) => ({
  event,
  session_id: "s",
  timestamp: "2026-10-24T00:00:00.000Z",
  data,
});

function digestOf(id: string, events: unknown[]) {
  const dir = join(root, "trajectories", "sessions", id);
  mkdirSync(dir, { recursive: true });
  const traj = { trajectory: [], metadata: { session_id: id, exit_status: "end_turn" } };
  writeFileSync(join(dir, "session.traj"), JSON.stringify(traj));
  writeFileSync(join(dir, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  const ref = { id, dir, trajPath: join(dir, "session.traj"), mtimeMs: Date.now() };
  return buildDigest(ref, false, paths)!;
}

const unclosed = (d: ReturnType<typeof digestOf>) =>
  d.anomalies.filter((a) => a.kind === "unclosed_pre_tool_use");

describe("unclosed_pre_tool_use", () => {
  it("串行级联跳过的形态：Pre 有、Post* 全无 → 报一条并点名 tool_use_id", () => {
    const d = digestOf("s1", [
      ev("PreToolUse", { tool_name: "bash", tool_use_id: "b1" }),
      ev("PostToolUseFailure", { tool_name: "bash", tool_use_id: "b1" }),
      ev("PreToolUse", { tool_name: "bash", tool_use_id: "b2" }),
    ]);
    const a = unclosed(d);
    expect(a).toHaveLength(1);
    expect(a[0].detail).toContain("1 个 PreToolUse");
    expect(a[0].provenance?.[0]?.lineRef).toContain("bash:b2");
  });

  it("反向：PostToolUse / PostToolUseFailure / PermissionDenied 都算收尾", () => {
    const d = digestOf("s2", [
      ev("PreToolUse", { tool_name: "read", tool_use_id: "r1" }),
      ev("PostToolUse", { tool_name: "read", tool_use_id: "r1" }),
      ev("PreToolUse", { tool_name: "bash", tool_use_id: "b1" }),
      ev("PostToolUseFailure", { tool_name: "bash", tool_use_id: "b1" }),
      ev("PreToolUse", { tool_name: "write", tool_use_id: "w1" }),
      ev("PermissionDenied", { tool_name: "write", tool_use_id: "w1" }),
    ]);
    expect(unclosed(d)).toHaveLength(0);
  });

  it("反向：没有 tool_use_id 的旧事件不参与计数（无从配对，不能误报）", () => {
    const d = digestOf("s3", [ev("PreToolUse", { tool_name: "bash" })]);
    expect(unclosed(d)).toHaveLength(0);
  });
});
